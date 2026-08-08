// self-regress — did a change to the machine move any title?
//
// The M88 sweep (tools/batch-compare.mjs) is the authority on *correctness*, but
// it needs refdrv and takes a long time. This answers the cheaper, more urgent
// question after touching timing or I/O: did this edit change the behaviour of
// titles that were already fine? It boots every disk twice — once on the current
// machine88.js, once on a copy of a previous revision — and diffs the fingerprint.
//
// The baseline must be a whole *checkout*, not a single file: a change to
// upd765.js or i8255.js moves behaviour just as much as one to machine88.js,
// and swapping only machine88.js would silently compare a revision against
// itself and report a reassuring zero. (It did exactly that once.)
//
// Setup:
//   git worktree add /tmp/upd3301-base HEAD~1
//   node tools/self-regress.mjs <diskDir> [frames=400] --base /tmp/upd3301-base
//   git worktree remove /tmp/upd3301-base
//
// A title that differs is not automatically a regression — many are mid-animation
// at the sample frame, so a one-frame phase shift changes E6CD. Treat the *list*
// as the signal: a handful of movers after a timing change is expected, a large
// fraction means the edit shifted the machine globally.

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { parseD88All } from '../d88.js';

const argv = process.argv.slice(2);
if (!argv[0]) {
  console.error('usage: node tools/self-regress.mjs <diskDir> [frames] [--limit n] [--romdir dir]');
  process.exit(2);
}
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const DIR = argv[0];
const FRAMES = Number(argv[1] && !argv[1].startsWith('--') ? argv[1] : 400);
const LIMIT = Number(opt('limit', 0));
const ROMDIR = opt('romdir', '/mnt/c/var/emulator/エミュレーター本体/PC88/m88204');

const baseDir = opt('base', null);
if (!baseDir) {
  console.error('missing --base <dir>\n  create one with:  git worktree add /tmp/upd3301-base HEAD~1');
  process.exit(2);
}
const BASE = resolve(baseDir, 'machine88.js');
if (!existsSync(BASE)) { console.error(`no machine88.js in ${baseDir}`); process.exit(2); }
const { Pc8801Machine: New } = await import('../machine88.js');
const { Pc8801Machine: Old } = await import(BASE);

const rd = (p) => new Uint8Array(readFileSync(p));
const main = rd(`${ROMDIR}/n88.rom`), sub = rd(`${ROMDIR}/disk.rom`);
const ext = new Uint8Array(0x8000);
for (let i = 0; i < 4; i++) ext.set(rd(`${ROMDIR}/n88_${i}.rom`), i * 0x2000);
const hex = (v, w = 2) => (v >>> 0).toString(16).padStart(w, '0');

function fingerprint(Klass, bytes) {
  const m = new Klass({ main, ext, sub, mode: 'n88' });
  parseD88All(bytes).forEach((img, u) => { if (u < 2) m.insertDisk(u, img); });
  for (let i = 0; i < FRAMES; i++) m.stepFrame();
  let tv = 0; for (const b of m.tvram) if (b) tv++;
  // distinct PCs over two frames separates "alive" from "runaway" far better
  // than a hot-PC address does (see docs/m88-comparison.md).
  const c = m.cpu, seen = new Set();
  const os = c.step.bind(c); c.step = () => { seen.add(c.pc); return os(); };
  for (let i = 0; i < 2; i++) m.stepFrame();
  // Split the fingerprint: `state` is what a real behaviour change moves;
  // `pcs` shifts on any one-frame phase difference, so it is reported but does
  // not by itself count a title as moved.
  return { state: `E6CD=${hex(m.ram[0xe6cd])} p31=${hex(m._port31)} p32=${hex(m._port32)} tvNZ=${tv}`, pcs: seen.size };
}

let files = readdirSync(DIR).filter((f) => /\.d88$/i.test(f)).sort();
if (LIMIT) files = files.slice(0, LIMIT);
console.log(`# ${files.length} disks, ${FRAMES}f, new=. vs base=${baseDir}`);

let same = 0, phase = 0; const moved = [];
for (const f of files) {
  let bytes;
  try { bytes = rd(join(DIR, f)); } catch { console.log(`${f}\tREADERR`); continue; }
  let a, b;
  try { a = fingerprint(Old, bytes); } catch (e) { a = { state: `THREW ${e.message}`, pcs: -1 }; }
  try { b = fingerprint(New, bytes); } catch (e) { b = { state: `THREW ${e.message}`, pcs: -1 }; }
  if (a.state !== b.state) {
    moved.push(f);
    console.log(`MOVED ${f}\n  base: ${a.state} pcs=${a.pcs}\n  new : ${b.state} pcs=${b.pcs}`);
  } else if (a.pcs !== b.pcs) { phase++; }
  else same++;
}
console.log(`\n# identical ${same}/${files.length}, phase-only (pcs moved) ${phase}, STATE MOVED ${moved.length}`);
if (moved.length) console.log('# movers: ' + moved.join(' '));
