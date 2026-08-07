// watch-write — who writes to this address, and with what banking state?
//
// The M88-divergence hunt (issue #12/#13) keeps landing on the same question:
// our RAM holds different bytes than M88's at some address, so *which store*
// put them there? crash-trace tells you where the CPU derailed; by then the
// damage is done. This watches an address range from the first frame and
// reports every write with the PC that did it and the bank state at the time —
// the bank state matters because on this machine C000-FFFF is main RAM, one
// GVRAM plane, or the ALU, depending on ports 31h/32h/5Ch-5Fh.
//
// Usage:
//   node tools/watch-write.mjs <disk.d88> <hexAddr>[-<hexEnd>] [frames=400] [romDir]
//
// Options via env:
//   MAXHITS=200   stop printing after N writes (default 200; counting continues)
//   PCFILTER=1    collapse consecutive writes from the same PC into one line
//
// Pair with tools/crash-trace.mjs (derail edge) and m88ref's refdrv MEMDUMP
// (M88's bytes at the same address) — see docs/m88-comparison.md.

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Pc8801Machine } from '../machine88.js';
import { parseD88All } from '../d88.js';
import { disasm } from '../z80dis.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: node tools/watch-write.mjs <disk.d88> <hexAddr>[-<hexEnd>] [frames] [romDir]');
  process.exit(2);
}
const disk = args[0];
const [loS, hiS] = args[1].split('-');
const LO = parseInt(loS, 16);
const HI = hiS ? parseInt(hiS, 16) : LO + 0x0f;
const FRAMES = Number(args[2] || 400);
const ROMDIR = args[3] || '/mnt/c/var/emulator/エミュレーター本体/PC88/m88204';
const MAXHITS = Number(process.env.MAXHITS || 200);
const COLLAPSE = process.env.PCFILTER === '1';

const rd = (p) => new Uint8Array(readFileSync(p));
const main = rd(`${ROMDIR}/n88.rom`), sub = rd(`${ROMDIR}/disk.rom`);
const ext = new Uint8Array(0x8000);
for (let i = 0; i < 4; i++) ext.set(rd(`${ROMDIR}/n88_${i}.rom`), i * 0x2000);

const m = new Pc8801Machine({ main, ext, sub, mode: 'n88' });
parseD88All(rd(resolve(disk))).forEach((img, u) => { if (u < 2) m.insertDisk(u, img); });

const hex = (v, w = 2) => (v >>> 0).toString(16).padStart(w, '0');
const c = m.cpu;

// The CPU calls writeMem for every store; wrap it rather than the bus so we see
// the address the *program* used, before banking redirects it.
let hits = 0, printed = 0, lastKey = '', lastRun = 0;
const ow = m.writeMem.bind(m);
m.writeMem = (a, v) => {
  a &= 0xffff;
  if (a >= LO && a <= HI) {
    hits++;
    // Where did it actually land? Mirror writeMem's own routing decision.
    let dest = 'ram';
    if (a >= 0x8000 && a < 0x8400 && !m.n80mode && (m._port31 & 6) === 0) dest = `txtwnd+${hex(m._txtwnd, 4)}`;
    else if (a >= 0xc000 && m._aluOn()) dest = 'ALU';
    else if (a >= 0xc000 && m.gvramWindow >= 0) dest = `gvram${m.gvramWindow}`;
    else if (a >= 0xf000 && m._tvramOn && (m._port32 & 0x10) === 0) dest = 'tvram';
    const key = `${c.pc}|${dest}`;
    if (COLLAPSE && key === lastKey) { lastRun++; }
    else {
      if (COLLAPSE && lastRun > 0) console.log(`      … ×${lastRun + 1} more from the same PC`);
      lastRun = 0; lastKey = key;
      if (printed < MAXHITS) {
        printed++;
        let d = ''; try { d = disasm((x) => m.readMem(x), c.pc).text; } catch { d = '?'; }
        console.log(`f${String(m.frame).padStart(4)} pc=${hex(c.pc, 4)} → [${hex(a, 4)}]=${hex(v)} dest=${dest.padEnd(12)} p31=${hex(m._port31)} p32=${hex(m._port32)} gw=${m.gvramWindow} | ${d}`);
      }
    }
  }
  return ow(a, v);
};

console.log(`=== ${disk.split('/').pop()} — writes to ${hex(LO, 4)}-${hex(HI, 4)} over ${FRAMES}f ===`);
for (let i = 0; i < FRAMES; i++) m.stepFrame();
if (COLLAPSE && lastRun > 0) console.log(`      … ×${lastRun + 1} more from the same PC`);

let s = ''; for (let a = LO; a <= Math.min(HI, LO + 15); a++) s += hex(m.ram[a]) + ' ';
console.log(`\ntotal writes: ${hits}${printed < hits ? ` (printed ${printed})` : ''}`);
console.log(`final ram[${hex(LO, 4)}]: ${s}`);
console.log(`E6CD=0x${hex(m.ram[0xe6cd])} p31=${hex(m._port31)} p32=${hex(m._port32)} gw=${m.gvramWindow}`);
