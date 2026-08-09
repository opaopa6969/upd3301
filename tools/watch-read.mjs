// watch-read — record the bytes the CPU actually *saw* in an address range.
//
// The mirror of m88ref's `M88_RWATCH`. When two emulators run the same code
// over different data (see the Makaimura decrypt loop in docs/m88-comparison.md),
// comparing memory dumps is awkward — C000-FFFF may be main RAM, a GVRAM plane,
// the ALU or text VRAM depending on ports 31h/32h/5xh, so "what is at E6C0" has
// no single answer. A read log has no such ambiguity: it records what the CPU
// got, already resolved through whatever bank was selected.
//
// Usage:
//   node tools/watch-read.mjs <disk.d88> <lo>-<hi> [frames=200] [options]
//     --pc <hex[-hex]>  only log reads issued from this PC (or PC range). Note the
//                    PC has already advanced past the opcode when the read happens,
//                    so give the address of the *next* instruction, or a range.
//     --max <n>      cap the printed lines (default 4000)
//     --bytes        print just the value stream (one hex byte per line), for diffing
//     --romdir <dir>
//
// Diff two byte streams directly:
//   node tools/watch-read.mjs game.d88 e6c0-eca8 200 --pc fcd9 --bytes > ours.txt
//   M88_RWATCH=e6c0-eca8 M88_RWATCH_MAX=200000 refdrv <romDir> game.d88 300 \
//     | grep -a '^RD' | grep 'pc=fcd9' | sed 's/.*=\([0-9a-f]*\)$/\1/' > m88.txt
//   diff ours.txt m88.txt | head

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Pc8801Machine } from '../machine88.js';
import { parseD88All } from '../d88.js';
import { loadRomSet } from './romset.mjs';

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('usage: node tools/watch-read.mjs <disk.d88> <lo>-<hi> [frames] [--pc hex] [--max n] [--bytes] [--romdir dir]');
  process.exit(2);
}
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const disk = argv[0];
const [loS, hiS] = argv[1].split('-');
const LO = parseInt(loS, 16), HI = hiS ? parseInt(hiS, 16) : parseInt(loS, 16);
const FRAMES = Number(argv[2] && !argv[2].startsWith('--') ? argv[2] : 200);
const pcArg = opt('pc', null);
const [PCLO, PCHI] = pcArg === null ? [-1, -1]
  : (() => { const [a, b] = pcArg.split('-'); const lo = parseInt(a, 16); return [lo, b ? parseInt(b, 16) : lo]; })();
const MAX = Number(opt('max', 4000));
const BYTES = argv.includes('--bytes');
const ROMDIR = opt('romdir', '/mnt/c/var/emulator/エミュレーター本体/PC88/m88204');

const rd = (p) => new Uint8Array(readFileSync(p));
// Load the ROM set the way M88 does (combined pc88.rom first) so both sides run
// the same bytes — see docs/m88-comparison.md.
const { main, ext, sub } = loadRomSet(ROMDIR);

const m = new Pc8801Machine({ main, ext, sub, mode: 'n88' });
parseD88All(rd(resolve(disk))).forEach((img, u) => { if (u < 2) m.insertDisk(u, img); });

const hex = (v, w = 2) => (v >>> 0).toString(16).padStart(w, '0');
const c = m.cpu;
let n = 0;
const orig = m.readMem.bind(m);
m.readMem = (a) => {
  const v = orig(a);
  a &= 0xffff;
  if (a >= LO && a <= HI && (PCLO < 0 || (c.pc >= PCLO && c.pc <= PCHI)) && n < MAX) {
    n++;
    if (BYTES) console.log(hex(v));
    else console.log(`RD f${String(m.frame).padStart(4, '0')} pc=${hex(c.pc, 4)} [${hex(a, 4)}]=${hex(v)}`);
  }
  return v;
};
if (!BYTES) console.log(`# ${disk.split('/').pop()} reads of ${hex(LO, 4)}-${hex(HI, 4)}${PCLO >= 0 ? ` from pc=${hex(PCLO, 4)}-${hex(PCHI, 4)}` : ''}, ${FRAMES}f`);
for (let i = 0; i < FRAMES; i++) m.stepFrame();
if (!BYTES) console.log(`# ${n} reads logged${n >= MAX ? ' (capped — raise --max)' : ''}`);
