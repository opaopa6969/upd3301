// reach — run a disk on both emulators and report which code each one ran.
//
// Answers "where did the two histories part?" in one pass, instead of the
// address-at-a-time guessing the divergence hunt had been doing (see
// reachdiff.js for why that matters).
//
// Usage:
//   node tools/reach.mjs <disk.d88> [frames=400] [--romdir dir] [--refdrv path]
//   node tools/reach.mjs <disk.d88> --ours-only     (skip M88; just list our regions)
//
// The reference side needs m88ref's refdrv built. Without it the tool says so
// and reports our side alone rather than pretending to compare.

import { readFileSync, existsSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { Pc8801Machine } from '../machine88.js';
import { mountD88 } from './mount.mjs';
import { loadRomSet } from './romset.mjs';
import { reachDiff, format } from '../reachdiff.js';

const argv = process.argv.slice(2);
if (!argv[0]) {
  console.error('usage: node tools/reach.mjs <disk.d88> [frames] [--romdir dir] [--refdrv path] [--ours-only]');
  process.exit(2);
}
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const disk = argv[0];
const FRAMES = Number(argv[1] && !argv[1].startsWith('--') ? argv[1] : 400);
const ROMDIR = opt('romdir', '/mnt/c/var/emulator/エミュレーター本体/PC88/m88204');
const REFDRV = opt('refdrv', 'm88ref/_m88m_build/M88M/refdrv');
const OURS_ONLY = argv.includes('--ours-only');

const { main, ext, sub, n80 } = loadRomSet(ROMDIR);
const m = new Pc8801Machine({ main, ext, sub, n80, opna44: true, mode: 'n88' });
mountD88(m, readFileSync(resolve(disk))); // same machine as the sweep — tools/mount.mjs

// Record the set of addresses we execute, and when each was first reached.
const ours = new Set();
const firstFrame = new Map();
// Also record which addresses ran immediately after an EI. M88's trace hook
// does not record those, so without this every one of them reads as a
// divergence — see reachdiff.js.
const afterEI = new Set();
let prevWasEI = false;
const c = m.cpu, step = c.step.bind(c);
c.step = () => {
  if (!ours.has(c.pc)) { ours.add(c.pc); firstFrame.set(c.pc, m.frame); }
  if (prevWasEI) afterEI.add(c.pc);
  prevWasEI = m.readMem(c.pc) === 0xfb; // EI
  return step();
};
for (let f = 0; f < FRAMES; f++) m.stepFrame();
console.log(`# ${disk.split('/').pop()} — ${FRAMES} frames, we executed ${ours.size} distinct addresses`);

if (OURS_ONLY || !existsSync(REFDRV)) {
  if (!OURS_ONLY) console.log(`# no refdrv at ${REFDRV} — reporting our side only`);
  const { regions } = await import('../reachdiff.js');
  for (const r of regions([...ours]).slice(0, 20)) {
    console.log(`  ${r.lo.toString(16).padStart(4, '0')}-${r.hi.toString(16).padStart(4, '0')}  ${r.count} addrs`);
  }
  process.exit(0);
}

// The reference side. M88_TRACE dumps `T <pc>` lines; we only need the set, so
// the ordering and the size of the dump do not matter.
// M88_TRACE is a FILE PATH, not a flag — `M88_TRACE=1` writes the trace to a
// file called "1" in the working directory and prints nothing to stdout. That
// cost a wrong conclusion once: grepping stdout for trace lines returned zero
// for every address, which reads exactly like "the reference never goes there".
const tracePath = `${tmpdir()}/reach-${process.pid}.txt`;
try {
  execFileSync(REFDRV, [ROMDIR, resolve(disk), String(FRAMES)], {
    env: { ...process.env, M88_TRACE: tracePath, M88_TRACE_FROM: '0', M88_TRACE_MAX: '80000000' },
    maxBuffer: 1 << 28, encoding: 'latin1', timeout: 1_800_000,
  });
} catch (e) {
  if (!existsSync(tracePath)) { console.error(`refdrv failed: ${e.message}`); process.exit(1); }
}
if (!existsSync(tracePath)) { console.error('refdrv wrote no trace file'); process.exit(1); }
const ref = new Set();
for (const line of readFileSync(tracePath, 'latin1').split('\n')) {
  const v = parseInt(line, 16);
  if (!Number.isNaN(v)) ref.add(v);
}
rmSync(tracePath, { force: true });
if (!ref.size) {
  console.log('# refdrv produced no trace lines — is M88_TRACE supported in this build?');
  process.exit(1);
}
console.log(`# the reference executed ${ref.size} distinct addresses\n`);
console.log(format(reachDiff(ours, ref, firstFrame, afterEI)));
