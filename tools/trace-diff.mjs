// trace-diff — find the first place two instruction traces stop agreeing.
//
// A raw line-by-line diff of two emulators is useless: interrupts land a few
// instructions apart, so the traces desynchronise constantly while both sides
// are still perfectly healthy. What matters is whether they keep *re-syncing*.
// So: walk both, and on a mismatch look ahead a window on each side for a
// realignment. Report only a divergence that never re-syncs — that is the point
// where one emulator actually took a different path.
//
// The more useful lens turned out to be the *census*: which PCs does one side
// execute that the other never does, and how often. A wait loop spun 1620 times
// on one side and 71 on the other is just a speed difference; a routine one side
// enters 598 times and the other never enters is a real structural divergence.
// So this prints the census first and the first-divergence second.
//
// Usage:
//   node tools/trace-diff.mjs <a.txt> <b.txt> [--window 200000] [--context 12] [--top 15]
//
// Produce the inputs with tools/pc-trace.mjs (ours) and refdrv's M88_TRACE (M88),
// armed at the same --armpc so both start at the same program point. Truncate the
// longer one to the shorter's length first — otherwise "A-only" is just A having
// run longer. (refdrv needs ~20 more frames than we do to reach the same point.)

import { readFileSync } from 'fs';

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('usage: node tools/trace-diff.mjs <a.txt> <b.txt> [--window n] [--context n]');
  process.exit(2);
}
const opt = (name, d) => { const i = argv.indexOf('--' + name); return i < 0 ? d : Number(argv[i + 1]); };
const WIN = opt('window', 200000);
const CTX = opt('context', 12);
const TOP = opt('top', 15);

const load = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean);
const A = load(argv[0]), B = load(argv[1]);
console.log(`A=${argv[0]} (${A.length})  B=${argv[1]} (${B.length})`);
if (Math.abs(A.length - B.length) > 0.05 * Math.max(A.length, B.length))
  console.log(`! lengths differ by >5% — truncate the longer trace first, or "X-only" just means "X ran longer"`);

// ---- census: PCs unique to one side ----
const census = (X) => { const c = new Map(); for (const pc of X) c.set(pc, (c.get(pc) || 0) + 1); return c; };
const ca = census(A), cb = census(B);
const only = (x, y) => [...x].filter(([pc]) => !y.has(pc)).sort((p, q) => q[1] - p[1]);
const oa = only(ca, cb), ob = only(cb, ca);
console.log(`\n=== census ===`);
console.log(`A-only PCs: ${oa.length}   B-only PCs: ${ob.length}`);
const show = (list, tag) => {
  if (!list.length) { console.log(`  (none ${tag})`); return; }
  const span = [Math.min(...list.map(([p]) => parseInt(p, 16))), Math.max(...list.map(([p]) => parseInt(p, 16)))];
  console.log(`  ${tag} span ${span[0].toString(16).padStart(4, '0')}-${span[1].toString(16).padStart(4, '0')}:`);
  for (const [pc, n] of list.slice(0, TOP)) console.log(`    ${pc}  ${String(n).padStart(7)}x`);
  if (list.length > TOP) console.log(`    … ${list.length - TOP} more`);
};
show(oa, 'A-only'); show(ob, 'B-only');
console.log(`\n=== first structural divergence ===`);

// Index each side's positions per PC so realignment is a lookup, not a scan —
// a spin loop can be hundreds of thousands of entries wide, and scanning that
// window for every mismatch is what made an earlier version report a bogus
// "permanent divergence" the moment the two sides span a wait loop differently.
const indexOf = (X) => {
  const m = new Map();
  for (let i = 0; i < X.length; i++) { const k = X[i]; if (!m.has(k)) m.set(k, []); m.get(k).push(i); }
  return m;
};
const aPos = indexOf(A), bPos = indexOf(B);
const seek = (idx, pc, from) => {
  const arr = idx.get(pc);
  if (!arr) return -1;
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] >= from) { ans = arr[mid]; hi = mid - 1; } else lo = mid + 1; }
  return ans;
};
const nextB = (pc, from) => seek(bPos, pc, from);
const nextA = (pc, from) => seek(aPos, pc, from);

let i = 0, j = 0, resyncs = 0, lastResync = 0;
while (i < A.length && j < B.length) {
  if (A[i] === B[j]) { i++; j++; continue; }
  // try to realign: find A[i] soon in B, or B[j] soon in A
  const jj = nextB(A[i], j);
  if (jj >= 0 && jj - j <= WIN) { j = jj; resyncs++; lastResync = i; continue; }
  const ii = nextA(B[j], i);
  if (ii >= 0 && ii - i <= WIN) { i = ii; resyncs++; lastResync = i; continue; }
  break;
}

console.log(`re-syncs while both healthy: ${resyncs}`);
if (i >= A.length || j >= B.length) {
  console.log(`no permanent divergence within the traces (A consumed ${i}/${A.length}, B ${j}/${B.length})`);
  process.exit(0);
}
console.log(`\n*** permanent divergence at A[${i}] / B[${j}] (last re-sync at A[${lastResync}]) ***`);
console.log('--- A (ours) ---');
for (let k = Math.max(0, i - CTX); k < Math.min(A.length, i + CTX); k++)
  console.log(`  ${k === i ? '>>' : '  '} ${String(k).padStart(8)}  ${A[k]}`);
console.log('--- B (M88) ---');
for (let k = Math.max(0, j - CTX); k < Math.min(B.length, j + CTX); k++)
  console.log(`  ${k === j ? '>>' : '  '} ${String(k).padStart(8)}  ${B[k]}`);
