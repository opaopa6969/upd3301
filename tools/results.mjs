// results — run both emulators and compare how they END their FDC commands.
//
// Companion to batch-compare.mjs. That one asks "does the screen match?"; this
// one asks "did the commands end the same way?", which the screen fingerprint
// cannot see (it reads memory, and a wrong termination leaves the same bytes
// behind whenever the driver was not looking). See resultdiff.js for why, and
// issue #40 for the three-day belief that measurement overturned.
//
// Usage:
//   node tools/results.mjs <romDir> <title.d88> [frames]     one title, full table
//   node tools/results.mjs <romDir> <diskDir>  [frames]      sweep, worst first
//
// Requires m88ref/_m88m_build/M88M/refdrv (m88ref/build.sh). Running this from a
// git worktree needs that path symlinked to the main tree — it is gitignored, so
// a worktree has no copy and every title would come back "0 results" (which is
// exactly the silent-detector failure this tool exists to prevent; it is
// reported as an error instead).

import { readFileSync, readdirSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { Pc8801Machine } from '../machine88.js';
import { parseD88All } from '../d88.js';
import { loadRomSet } from './romset.mjs';
import { parseRefdrvResults, tally, diffTallies, disagreement, formatDiff, statusKey } from '../resultdiff.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROMDIR = process.argv[2] || '/mnt/c/var/emulator/エミュレーター本体/PC88/m88204';
const TARGET = process.argv[3] || '/mnt/c/var/emulator/PC8801';
const FRAMES = Number(process.argv[4] || 1500);
const REFDRV = resolve(HERE, '../m88ref/_m88m_build/M88M/refdrv');

const { main, ext, sub } = loadRomSet(ROMDIR);

// Ours: tally the seven-byte result phases the FDC hands back. `_results` is the
// one funnel every command ends through, so wrapping it here beats threading a
// hook through the core — upd765.js stays free of instrumentation.
function ours(path) {
  const m = new Pc8801Machine({ main, ext, sub, mode: 'n88' });
  parseD88All(new Uint8Array(readFileSync(path)))
    .forEach((img, u) => { if (u < 2) m.insertDisk(u, img); });
  const f = m.sub.fdc;
  const seen = [];
  const orig = f._results.bind(f);
  f._results = (bytes) => {
    if (bytes.length === 7) seen.push({ st0: bytes[0], st1: bytes[1], st2: bytes[2] });
    return orig(bytes);
  };
  for (let i = 0; i < FRAMES; i++) m.stepFrame();
  return seen;
}

// Same caveat as batch-compare.mjs: refdrv aborts on a couple of titles while
// printing its screen dump, long after the result phases we read. Take whatever
// it wrote before dying rather than losing the title.
function ref(path) {
  let out;
  try {
    out = execFileSync(REFDRV, [ROMDIR, path, String(FRAMES)],
      { timeout: 60000, encoding: 'latin1', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    out = e.stdout ?? '';
    if (!out) throw e;
  }
  return parseRefdrvResults(out);
}

function compare(path) {
  const o = ours(path);
  let r;
  try { r = ref(path); } catch (e) { return { err: (e.message || '').split('\n')[0].slice(0, 60), ours: o.length }; }
  // Both sides silent means the title never touched the disk in `frames` — that
  // is a real answer ("nothing to compare"), not agreement. Say which it is.
  const rows = diffTallies(tally(r), tally(o));
  return { rows, refN: r.length, oursN: o.length, score: disagreement(rows) };
}

const isDir = statSync(TARGET).isDirectory();

if (!isDir) {
  const c = compare(TARGET);
  if (c.err) { console.error(`refdrv failed: ${c.err}`); process.exit(1); }
  console.log(`${TARGET.split('/').pop()} @ ${FRAMES}f — M88 ${c.refN} results, ours ${c.oursN}`);
  console.log(formatDiff(c.rows));
  console.log(`\ndisagreement: ${c.score}`);
  process.exit(0);
}

const titles = readdirSync(TARGET).filter((f) => /\.d88$/i.test(f)).sort();
const results = [];
for (const t of titles) {
  const c = compare(join(TARGET, t));
  results.push({ title: t, ...c });
  process.stdout.write(`\r  ..${results.length}/${titles.length}   `);
}
console.log('\n');

const ok = results.filter((r) => !r.err);
const errs = results.filter((r) => r.err);
const agree = ok.filter((r) => r.score === 0);
const idle = ok.filter((r) => r.refN === 0 && r.oursN === 0);

console.log(`=== SUMMARY (${titles.length} titles, ${FRAMES}f) ===`);
console.log(`identical terminations: ${agree.length}/${ok.length}`);
console.log(`  of which never touched the disk: ${idle.length}`);
console.log(`differing:              ${ok.length - agree.length}`);
console.log(`refdrv errors:          ${errs.length}`);
console.log(`total disagreement:     ${ok.reduce((a, r) => a + r.score, 0)}`);

const worst = ok.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
if (worst.length) {
  console.log('\n=== WORST (by summed |delta|) ===');
  for (const w of worst.slice(0, 25)) {
    const top = w.rows.filter((r) => r.delta !== 0).slice(0, 3)
      .map((r) => `${r.key}:${r.delta > 0 ? '+' : ''}${r.delta}`).join(' ');
    console.log(`  ${w.title.padEnd(32)} score ${String(w.score).padStart(4)}   ${top}`);
  }
  if (worst.length > 25) console.log(`  ... and ${worst.length - 25} more`);
}

// Which status pairs drive the total, across every title — this is the view that
// named `40 02` as the next thread to pull.
const byKey = new Map();
for (const r of ok) for (const row of r.rows) {
  const e = byKey.get(row.key) ?? { key: row.key, ref: 0, ours: 0, meaning: row.meaning };
  e.ref += row.ref; e.ours += row.ours;
  byKey.set(row.key, e);
}
console.log('\n=== BY STATUS PAIR (all titles) ===');
const totals = [...byKey.values()].map((e) => ({ ...e, delta: e.ours - e.ref }))
  .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.key < b.key ? -1 : 1));
console.log(formatDiff(totals));

if (errs.length) {
  console.log('\n=== ERRORS ===');
  for (const e of errs) console.log(`  ${e.title.padEnd(32)} ${e.err}`);
}
