// loop-profile — a stuck title: is it *waiting* for something, or *runaway*?
//
// Those two failures look identical from the outside (the screen stops changing)
// but need opposite fixes. Run to steady state, then profile a couple of frames:
//   - a wait loop revisits a handful of PCs and polls an I/O port. The port it
//     polls names the bug (FDC status, VRTC, sub-CPU, keyboard…).
//   - a runaway sweeps thousands of distinct PCs, marching linearly through data
//     as if it were code, and touches no I/O at all. Then the real bug is
//     upstream — something corrupted memory or the return stack earlier.
// Print both signals so the answer is unambiguous.
//
// Usage:
//   node tools/loop-profile.mjs <disk.d88> [settleFrames=600] [romDir]
//
// Pair with tools/life-scan.mjs (when it went wrong) and tools/watch-write.mjs
// (who wrote the bytes it is now executing). See docs/m88-comparison.md.

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Pc8801Machine } from '../machine88.js';
import { mountD88 } from './mount.mjs';
import { loadRomSet } from './romset.mjs';
import { disasm } from '../z80dis.js';

const args = process.argv.slice(2);
if (!args[0]) {
  console.error('usage: node tools/loop-profile.mjs <disk.d88> [settleFrames] [romDir]');
  process.exit(2);
}
const disk = args[0];
const SETTLE = Number(args[1] || 600);
const ROMDIR = args[2] || '/mnt/c/var/emulator/エミュレーター本体/PC88/m88204';

const rd = (p) => new Uint8Array(readFileSync(p));
// Load the ROM set the way M88 does (combined pc88.rom first) so both sides run
// the same bytes — see docs/m88-comparison.md.
const { main, ext, sub, n80 } = loadRomSet(ROMDIR);

const m = new Pc8801Machine({ main, ext, sub, n80, opna44: true, mode: 'n88' });
mountD88(m, rd(resolve(disk))); // same machine as the sweep — tools/mount.mjs
const hex = (v, w = 2) => (v >>> 0).toString(16).padStart(w, '0');

for (let i = 0; i < SETTLE; i++) m.stepFrame();

const c = m.cpu;
const pcH = {};
const os = c.step.bind(c); c.step = () => { pcH[c.pc] = (pcH[c.pc] || 0) + 1; return os(); };
const inH = {}, outH = {};
const oi = m.in.bind(m);
m.in = (p) => {
  const v = oi(p), k = hex(p);
  (inH[k] ||= { n: 0, vals: new Set(), pc: new Set() });
  inH[k].n++; inH[k].vals.add(hex(v)); inH[k].pc.add(hex(c.pc, 4));
  return v;
};
const oo = m.out.bind(m);
m.out = (p, v) => {
  const k = hex(p);
  (outH[k] ||= { n: 0, vals: new Set() });
  outH[k].n++; outH[k].vals.add(hex(v));
  return oo(p, v);
};

for (let i = 0; i < 2; i++) m.stepFrame();

const pcs = Object.entries(pcH).sort((a, b) => b[1] - a[1]);
console.log(`=== ${disk.split('/').pop()} settled at f${SETTLE}, 2-frame profile ===`);
console.log(`distinct PCs: ${pcs.length}   ${pcs.length > 500 ? '← RUNAWAY (executing data as code)' : '← tight loop'}`);
const top = pcs.slice(0, 40).map(([k]) => +k);
const lo = Math.min(...top), hi = Math.max(...top);
console.log(`hot span: ${hex(lo, 4)}-${hex(hi, 4)}`);
console.log('--- disassembly from the hot span ---');
let a = lo;
while (a <= hi + 4 && a < lo + 64) {
  let d; try { d = disasm((x) => m.readMem(x), a); } catch { break; }
  console.log(`  ${hex(a, 4)}  ${String(pcH[a] || 0).padStart(6)}  ${d.text}`);
  a += d.len || 1;
}
const ports = (h, tag) => {
  const e = Object.entries(h).sort((x, y) => y[1].n - x[1].n);
  if (!e.length) { console.log(`  (none — no ${tag} at all: it is not waiting on a device)`); return; }
  for (const [p, o] of e) {
    const from = o.pc ? ` from pc={${[...o.pc].slice(0, 4).join(',')}}` : '';
    console.log(`  ${tag} ${p}: ${String(o.n).padStart(7)}x vals={${[...o.vals].slice(0, 8).join(',')}}${from}`);
  }
};
console.log('--- IN ports while spinning ---'); ports(inH, 'IN ');
console.log('--- OUT ports while spinning ---'); ports(outH, 'OUT');
console.log(`ints: E6mask=${hex(m.intMaskBits)} levels=${m.intLevels} pending=${hex(m.intPending)} iff1=${c.iff1} im=${c.im}`);
console.log(`state: E6CD=${hex(m.ram[0xe6cd])} p31=${hex(m._port31)} p32=${hex(m._port32)} gw=${m.gvramWindow}`);
