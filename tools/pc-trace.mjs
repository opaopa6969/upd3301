// pc-trace — dump our MAIN-CPU instruction trace in the same format as
// m88ref's refdrv (`M88_TRACE=...`), so the two can be diffed directly.
//
// Format: one 4-hex PC per line, consecutive duplicates collapsed (a `HALT` or
// a `JR $` would otherwise bury the trace). That is exactly what refdrv writes.
//
// Arming matters more than it looks: our emulator boots ~20 frames ahead of
// M88, so "frame 60" is not the same program point on both sides. Prefer
// `--armpc <hex>` — the first time the program reaches an address — which is
// the same point in both emulators no matter how the timing drifted.
//
// Usage:
//   node tools/pc-trace.mjs <disk.d88> <out.txt> [frames=150] [options]
//     --armpc <hex>    start tracing at the first execution of this PC
//     --from <frame>   start tracing at this frame (default 0 if no --armpc)
//     --max <n>        instruction budget (default 3000000)
//     --romdir <dir>
//
// Then: node tools/trace-diff.mjs ours.txt m88.txt

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { Pc8801Machine } from '../machine88.js';
import { parseD88All } from '../d88.js';

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('usage: node tools/pc-trace.mjs <disk.d88> <out.txt> [frames] [--armpc hex] [--from frame] [--max n] [--romdir dir]');
  process.exit(2);
}
const opt = (name, dflt) => { const i = argv.indexOf('--' + name); return i < 0 ? dflt : argv[i + 1]; };
const disk = argv[0], out = argv[1];
const FRAMES = Number(argv[2] && !argv[2].startsWith('--') ? argv[2] : 150);
const ARMPC = opt('armpc', null) === null ? -1 : parseInt(opt('armpc'), 16);
const FROM = Number(opt('from', ARMPC >= 0 ? -1 : 0));
const MAX = Number(opt('max', 3000000));
const ROMDIR = opt('romdir', '/mnt/c/var/emulator/エミュレーター本体/PC88/m88204');

const rd = (p) => new Uint8Array(readFileSync(p));
const main = rd(`${ROMDIR}/n88.rom`), sub = rd(`${ROMDIR}/disk.rom`);
const ext = new Uint8Array(0x8000);
for (let i = 0; i < 4; i++) ext.set(rd(`${ROMDIR}/n88_${i}.rom`), i * 0x2000);

const m = new Pc8801Machine({ main, ext, sub, mode: 'n88' });
// --tvram on|off forces the F000-FFFF routing, to test whether that mapping is
// what changes the trace (see docs/m88-comparison.md).
const TV = opt('tvram', 'normal');
if (TV !== 'normal') Object.defineProperty(m, '_tvramOn', { get: () => TV === 'on' });
parseD88All(rd(resolve(disk))).forEach((img, u) => { if (u < 2) m.insertDisk(u, img); });

const buf = new Uint16Array(MAX);
let n = 0, on = false, prev = -1, armFrame = -1;
const c = m.cpu;
const os = c.step.bind(c);
c.step = () => {
  const pc = c.pc;
  if (!on) {
    if (ARMPC >= 0 ? pc === ARMPC : (FROM >= 0 && m.frame >= FROM)) { on = true; armFrame = m.frame; }
  }
  if (on && n < MAX && pc !== prev) { buf[n++] = pc; prev = pc; }
  return os();
};
for (let i = 0; i < FRAMES; i++) m.stepFrame();

const hex = (v) => v.toString(16).padStart(4, '0');
let s = '';
for (let i = 0; i < n; i++) s += hex(buf[i]) + '\n';
writeFileSync(out, s);
console.log(`# traced ${n} instrs (deduped) -> ${out}  armed at frame ${armFrame}${ARMPC >= 0 ? ` (pc=${hex(ARMPC)})` : ''}`);
if (n >= MAX) console.log('# WARNING trace budget full — raise --max');
console.log(`# final E6CD=${m.ram[0xe6cd].toString(16)} tvramNZ=${m.tvram.reduce((a, b) => a + (b ? 1 : 0), 0)}`);
