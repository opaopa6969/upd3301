// crash-trace — diagnose a title that diverges from M88 (see issue #12 / #13).
// Boots a .d88 the disk-capable way (main+ext+sub, N88), runs it, and reports
// the signals used to characterise the two known crashes (Makaimura, GAZZEL):
//   - interrupt state (E6 mask / E4 levels / pending / iff1 / im / I)
//   - hottest PCs (a tight low-address loop == executing garbage == a crash)
//   - the DERAIL edge: the first jump from high code (>=0x8000) into low RAM
//     (<0x1000) after boot, with the preceding instruction trail disassembled
//   - optional: dump one address across several frames (memory bisection),
//     to compare against M88's refdrv `MEMDUMP` (argv[6]=hex addr).
//
// Usage:
//   node tools/crash-trace.mjs <disk.d88> [frames=400] [romDir]
//   node tools/crash-trace.mjs <disk.d88> --dump <hexAddr> <f1,f2,..> [romDir]
//
// Pair with the M88 oracle:  m88ref/_m88m_build/M88M/refdrv <romDir> <disk> <N> -1 -1 <hexAddr>
// The whole point is a side-by-side: our RAM vs M88's at the same address/frame.
// Note our boot runs ~20 frames AHEAD of M88 (faster) — align by content, not
// frame number, when bisecting (Makaimura: ours@55 ≈ M88@75 at 0xC440).

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { Pc8801Machine } from '../machine88.js';
import { parseD88All } from '../d88.js';
import { disasm } from '../z80dis.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const disk = args[0];
if (!disk) { console.error('usage: node tools/crash-trace.mjs <disk.d88> [frames] [romDir]'); process.exit(2); }
const dumpMode = args[1] === '--dump';
const ROMDIR = (dumpMode ? args[4] : args[2]) || '/mnt/c/var/emulator/エミュレーター本体/PC88/m88204';
const rd = (p) => new Uint8Array(readFileSync(p));
const main = rd(`${ROMDIR}/n88.rom`), sub = rd(`${ROMDIR}/disk.rom`);
const ext = new Uint8Array(0x8000);
for (let i = 0; i < 4; i++) ext.set(rd(`${ROMDIR}/n88_${i}.rom`), i * 0x2000);

function boot() {
  const m = new Pc8801Machine({ main, ext, sub, mode: 'n88' });
  parseD88All(rd(disk)).forEach((img, u) => { if (u < 2) m.insertDisk(u, img); });
  return m;
}
const hex = (v, w = 2) => v.toString(16).padStart(w, '0');

if (dumpMode) {
  const addr = parseInt(args[2], 16);
  const frames = args[3].split(',').map(Number);
  const m = boot();
  let f = 0;
  for (const t of frames) {
    while (f < t) { m.stepFrame(); f++; }
    let s = ''; for (let a = addr; a < addr + 16; a++) s += hex(m.ram[a & 0xffff]) + ' ';
    console.log(`ours f${String(t).padEnd(4)} ${hex(addr, 4)}: ${s}`);
  }
  process.exit(0);
}

const FRAMES = Number(args[1] || 400);
const m = boot();
const c = m.cpu;

// --- derail detection: first high(>=0x8000) -> low(<0x1000) edge after boot ---
const ring = [];
let derail = null, prev = c.pc, bootDone = false;
const os = c.step.bind(c);
c.step = () => {
  const pc = c.pc;
  ring.push({ pc, sp: c.sp, f: m.frame }); if (ring.length > 30) ring.shift();
  if (m.frame > 30) bootDone = true; // skip the ROM boot (legitimately runs low)
  if (bootDone && !derail && pc < 0x1000 && prev >= 0x8000) derail = { from: prev, to: pc, frame: m.frame, trail: ring.slice() };
  prev = pc;
  return os();
};
for (let i = 0; i < FRAMES; i++) m.stepFrame();

// --- report ---
console.log(`\n=== ${disk.split('/').pop()} @ ${FRAMES}f ===`);
console.log(`E6CD=0x${hex(m.ram[0xe6cd])}  port31=0x${hex(m._port31)}  port32=0x${hex(m._port32)}  romEnabled=${m.romEnabled}  gvramWindow=${m.gvramWindow}`);
console.log(`ints: E6mask=0x${hex(m.intMaskBits)} E4levels=${m.intLevels} pending=0x${hex(m.intPending)} | cpu iff1=${c.iff1} im=${c.im} I=0x${hex(c.i)}`);

// hot PCs over 3 more frames
const pcH = {}; const os2 = c.step.bind(c);
c.step = () => { pcH[c.pc] = (pcH[c.pc] || 0) + 1; return os2(); };
for (let i = 0; i < 3; i++) m.stepFrame();
const hot = Object.entries(pcH).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('hot PCs:', hot.map(([k, v]) => hex(+k, 4) + ':' + v).join(' '));
const looping = hot[0] && hot[0][0] < 0x1000;
console.log(looping ? '→ tight low-address loop = executing garbage (CRASH)' : '→ no low-address hot loop');

if (derail) {
  console.log(`\n*** DERAIL edge frame ${derail.frame}: ${hex(derail.from, 4)} → ${hex(derail.to, 4)} ***`);
  for (const r of derail.trail) {
    let d = ''; try { d = disasm((x) => m.readMem(x), r.pc).text; } catch { d = '?'; }
    console.log(`  f${r.f} ${hex(r.pc, 4)} sp=${hex(r.sp, 4)}  ${d}`);
  }
} else {
  console.log('\n(no high→low derail edge captured — try more frames or the --dump bisection)');
}
