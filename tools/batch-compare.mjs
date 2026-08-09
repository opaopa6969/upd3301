// batch-compare — sweep a directory of .d88 titles through BOTH our pure-JS
// emulator and the headless M88 reference (m88ref/refdrv), diff a per-title
// fingerprint, and categorise the mismatches into "phase noise" (both boot,
// caught at a different animation frame) vs "real divergence lead" (screen
// content genuinely differs). See docs/m88-comparison.md for the method.
//
// Usage:
//   node tools/batch-compare.mjs [romDir] [diskDir] [frames]
// Defaults target a local m88204 ROM set + PC8801 disk collection; override
// as needed. Requires m88ref/_m88m_build/M88M/refdrv (run m88ref/build.sh).
//
// IMPORTANT: our side is built EXACTLY like the disk-capable front-end —
// {main, ext, sub, mode:'n88'} where `ext` is the four N88 extension ROMs
// (n88_0..3.rom) mapped at 6000-7FFF. That extension ROM *is* N88-DISK-BASIC;
// without it the machine drops to the N88-BASIC prompt and NO game boots (a
// mistake that once made every title falsely "match" at E6CD=00). The fix is
// load-bearing — keep `ext`.

// TWO metric caveats learned the hard way, both fixable here:
//   (1) BOOT SPEED. A fixed-frame E6CD/tvNZ snapshot is confounded because our
//       emulator often boots FASTER than M88 — at 250f we're already on the
//       title screen while M88 is mid-load, so the "divergence" is just a phase
//       offset. Compare at a LATE frame (default 1500) where both have
//       converged. At 250f the raw match rate reads ~86%; at 1500f converged
//       it is ~99% (only ~2/353 genuinely diverge: Makaimura, GAZZEL).
//   (2) DISPLAY MASK. tvramNZ counts raw text RAM even when the text plane is
//       DISABLED (port 53h b0=1) — a graphics-only game (ﾄﾘﾄｰﾝ, tennis) leaves
//       stale bytes there that are never shown, inflating tvNZ. We zero tvNZ
//       when the text plane is off so it reflects what's on screen. (refdrv's
//       side still counts raw, so such titles can still show a tvNZ delta —
//       treat a text-off title's tvNZ as noise.)

import { readFileSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { Pc8801Machine } from '../machine88.js';
import { parseD88All } from '../d88.js';
import { loadRomSet } from './romset.mjs';
import { classifyScreen } from './verdict.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROMDIR = process.argv[2] || '/mnt/c/var/emulator/エミュレーター本体/PC88/m88204';
const DISKDIR = process.argv[3] || '/mnt/c/var/emulator/PC8801';
const FRAMES = Number(process.argv[4] || 1500); // late enough that both emulators have converged
const REFDRV = resolve(HERE, '../m88ref/_m88m_build/M88M/refdrv');

const rd = (p) => new Uint8Array(readFileSync(p));
// Load the ROM set exactly the way M88 does. M88 prefers a combined pc88.rom and
// only falls back to n88.rom/disk.rom; reading the separate files here while M88
// read the combined image had the two sides running *different ROM revisions*
// (2021 of 8192 bytes differ in the sub ROM alone). See docs/m88-comparison.md.
const { main, ext, sub } = loadRomSet(ROMDIR);

function ours(path) {
  try {
    const m = new Pc8801Machine({ main, ext, sub, mode: 'n88' });
    const imgs = parseD88All(rd(path));
    imgs.forEach((img, u) => { if (u < 2) m.insertDisk(u, img); }); // image0→drive0, image1→drive1
    for (let i = 0; i < FRAMES; i++) m.stepFrame();
    // count text RAM only when the text plane is actually displayed (port 53h
    // b0=1 → text off), else a graphics-only game's stale bytes inflate tvNZ
    const textOff = (m._port53 & 1) !== 0;
    let tvnz = 0; if (m.tvram && !textOff) for (const b of m.tvram) if (b) tvnz++;
    // Graphics-plane fingerprint: a title that turns the text plane off and draws
    // in GVRAM has tvnz === 0 and used to read as "blank screen", which flagged
    // healthy graphics-only titles (Ys and friends) as divergences the moment one
    // side reached gameplay first. Counting GVRAM keeps them comparable.
    let gvnz = 0; for (const plane of m.gvram) for (const b of plane) if (b) gvnz++;
    return { e6cd: m.ram[0xe6cd], tvnz, gvnz, textOff, nimg: imgs.length };
  } catch (e) { return { err: e.message }; }
}
function ref(path) {
  try {
    const out = execFileSync(REFDRV, [ROMDIR, path, String(FRAMES)], { timeout: 40000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/# final E6CD=([0-9a-f]{2}) EC88=[0-9a-f]+ tvramNZ=(\d+)/i);
    const g = out.match(/# final gvramNZ=(\d+)/i);
    return m ? { e6cd: parseInt(m[1], 16), tvnz: parseInt(m[2], 10), gvnz: g ? parseInt(g[1], 10) : null }
             : { err: 'no final line' };
  } catch (e) { return { err: (e.message || '').slice(0, 40) }; }
}

const files = readdirSync(DISKDIR).filter((f) => /\.d88$/i.test(f)).sort();
process.stderr.write(`# ${files.length} d88 titles, ${FRAMES} frames each\n`);
const rows = [];
let done = 0;
for (const f of files) {
  const o = ours(`${DISKDIR}/${f}`), r = ref(`${DISKDIR}/${f}`);
  rows.push({ f, o, r, match: !o.err && !r.err && o.e6cd === r.e6cd });
  if (++done % 20 === 0) process.stderr.write(`  ..${done}/${files.length}\n`);
}

const ok = rows.filter((x) => x.match).length;
const errs = rows.filter((x) => x.o.err || x.r.err);
const mism = rows.filter((x) => !x.match && !x.o.err && !x.r.err);
const phase = [], real = [], blank = [];
for (const x of mism) {
  // The judgement rules live in tools/verdict.js so they can be unit-tested
  // against the cases that have fooled them (test-verdict.mjs) — three separate
  // measurement bugs cost more than the emulator bugs they hid.
  const v = classifyScreen(x.r, x.o);
  const rec = { ...x, ratio: v.ratio, useG: v.plane === 'gv' };
  if (v.kind === 'blank') blank.push(rec);
  else if (v.kind === 'phase' || v.kind === 'exact') phase.push(rec);
  else real.push(rec);
}
const line = (x) => {
  const p = x.useG ? 'gv' : 'tv';
  const rv = x.useG ? x.r.gvnz : x.r.tvnz, ov = x.useG ? x.o.gvnz : x.o.tvnz;
  return `  ${x.f.slice(0, 28).padEnd(28)} M88=${x.r.e6cd.toString(16).padStart(2, '0')}/${p}${rv}  ours=${x.o.e6cd.toString(16).padStart(2, '0')}/${p}${ov}  (fill ${(x.ratio * 100) | 0}%)`;
};

console.log(`\n=== SUMMARY (${rows.length} titles, ${FRAMES}f) ===`);
console.log(`exact E6CD match:     ${ok}/${rows.length} (${(100 * ok / rows.length).toFixed(0)}%)`);
console.log(`phase noise (boots):  ${phase.length}`);
console.log(`real divergence lead: ${real.length}`);
console.log(`blank/early:          ${blank.length}`);
console.log(`errors:               ${errs.length}`);
console.log(`→ tracking M88 (match+phase): ${ok + phase.length}/${rows.length} (${(100 * (ok + phase.length) / rows.length).toFixed(0)}%)`);
console.log(`\n=== REAL DIVERGENCE LEADS ===`);
real.sort((a, b) => a.ratio - b.ratio).forEach((x) => console.log(line(x)));
console.log(`\n=== PHASE NOISE (both boot; not bugs) ===`);
phase.forEach((x) => console.log(line(x)));
if (blank.length) { console.log(`\n=== BLANK/EARLY ===`); blank.forEach((x) => console.log(line(x))); }
if (errs.length) { console.log(`\n=== ERRORS ===`); errs.forEach((x) => console.log(`  ${x.f.slice(0, 28).padEnd(28)} our:${x.o.err || 'ok'} | ref:${x.r.err || 'ok'}`)); }
