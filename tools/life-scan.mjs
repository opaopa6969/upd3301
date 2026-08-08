// life-scan — where does the CPU actually live, frame by frame?
//
// The M88-divergence work (issue #12/#13) kept characterising a title from a
// single frame's hot-PC list, which is a trap: a title can execute low memory
// legitimately for a few frames while loading and still be perfectly healthy,
// and a title that has already died can look "busy" in a plausible region.
// This walks the whole run and buckets execution by address region at
// checkpoints, so a hang/derail shows up as a *change* that never recovers.
//
// It also prints both candidate "screens" side by side — the dedicated tvram
// and main RAM F000-FFFF — because which one the CPU/DMAC sees depends on
// port 32h bit4 and the V2-mode switch, and picking the wrong one makes a
// working title look broken (that is what `tvramNZ` measures in batch-compare).
//
// Usage:
//   node tools/life-scan.mjs <disk.d88> [lastFrame=1500] [tvram=normal|on|off] [step=100] [romDir]
//
// `tvram` forces the F000-FFFF routing, to test whether that mapping is what
// changes a title's fate. See docs/m88-comparison.md.

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Pc8801Machine } from '../machine88.js';
import { parseD88All } from '../d88.js';
import { loadRomSet } from './romset.mjs';

const args = process.argv.slice(2);
if (!args[0]) {
  console.error('usage: node tools/life-scan.mjs <disk.d88> [lastFrame] [tvram=normal|on|off] [step] [romDir]');
  process.exit(2);
}
const disk = args[0];
const LAST = Number(args[1] || 1500);
const FORCE = args[2] || 'normal';
const STEP = Number(args[3] || 100);
const ROMDIR = args[4] || '/mnt/c/var/emulator/エミュレーター本体/PC88/m88204';

const rd = (p) => new Uint8Array(readFileSync(p));
// Load the ROM set the way M88 does (combined pc88.rom first) so both sides run
// the same bytes — see docs/m88-comparison.md.
const { main, ext, sub } = loadRomSet(ROMDIR);

const m = new Pc8801Machine({ main, ext, sub, mode: 'n88' });
if (FORCE !== 'normal') Object.defineProperty(m, '_tvramOn', { get: () => FORCE === 'on' });
parseD88All(rd(resolve(disk))).forEach((img, u) => { if (u < 2) m.insertDisk(u, img); });

const hex = (v, w = 2) => (v >>> 0).toString(16).padStart(w, '0');
const c = m.cpu;
let pcH = {};
const os = c.step.bind(c);
c.step = () => { pcH[c.pc] = (pcH[c.pc] || 0) + 1; return os(); };

const bucketOf = (pc) => pc < 0x1000 ? 'LOW<1000' : pc < 0x8000 ? '1000-7fff'
  : pc < 0xc000 ? '8000-bfff' : pc < 0xf000 ? 'c000-efff' : 'f000-ffff';

console.log(`# ${disk.split('/').pop()} tvram=${FORCE}`);
console.log('frame  E6CD p31 p32 gw  tvNZ ramF0NZ  distinctPC  region-of-life');
for (let f = 0; f <= LAST; f++) {
  if (f % STEP === 0 && f > 0) {
    const ent = Object.entries(pcH);
    const tot = ent.reduce((a, b) => a + b[1], 0) || 1;
    const buckets = {};
    for (const [pc, n] of ent) { const b = bucketOf(+pc); buckets[b] = (buckets[b] || 0) + n; }
    const top = Object.entries(buckets).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${Math.round(v * 100 / tot)}%`).join(' ');
    let nz = 0; for (const b of m.tvram) if (b) nz++;
    let rnz = 0; for (let a = 0xf000; a <= 0xffff; a++) if (m.ram[a]) rnz++;
    console.log(`${String(f).padStart(5)}  ${hex(m.ram[0xe6cd])}   ${hex(m._port31)}  ${hex(m._port32)}  ${String(m.gvramWindow).padStart(2)}  ${String(nz).padStart(4)} ${String(rnz).padStart(6)}  ${String(ent.length).padStart(9)}  ${top}`);
    pcH = {};
  }
  m.stepFrame();
}
// A healthy title revisits a small set of PCs; a runaway sweeps thousands of
// distinct addresses per frame and stops touching I/O. distinctPC is the tell.
