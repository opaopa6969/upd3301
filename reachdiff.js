// reachdiff — which code did each emulator actually run?
//
// Chasing the remaining M88 divergences kept coming down to the same question,
// asked one address at a time: "does M88 ever execute 52d5? does it reach 52b1?
// 52f5? 52c7?" Four `refdrv` runs to learn one fact — that M88 never enters a
// whole region of the program that we do.
//
// That fact is far more useful than any single frame comparison, because it
// separates two very different situations:
//
//   * both sides run the same code, one gets there sooner  →  a timing problem
//   * one side runs code the other never touches           →  a branch went the
//                                                             other way, and
//                                                             everything after
//                                                             is consequence
//
// The screen fingerprint cannot tell those apart; a reachability set can, and
// it costs one run per side instead of one run per guess.
//
// This module is the pure part: given two sets of executed addresses, say what
// is exclusive to each and group the exclusives into contiguous regions (a
// program's code is contiguous, so 40 loose addresses are usually 2 routines).
// The tool that produces the sets lives in tools/reach.mjs.
//
// Pure, dependency-free, deterministic.

export const SCHEMA_VERSION = 1;

// Addresses closer together than this are treated as one region. A trace holds
// instruction *starts*, so a routine appears as a sparse set: JIKO_PZL's
// 103d-1073 is 18 starts across 54 bytes, and at a 32-byte gap it split into
// two regions that are plainly one routine. 64 keeps a routine whole while
// still separating 1009 from 30a9.
const REGION_GAP = 64;

/** Group a sorted address list into contiguous regions. */
export function regions(addrs, gap = REGION_GAP) {
  const sorted = [...new Set(addrs)].sort((a, b) => a - b);
  const out = [];
  for (const a of sorted) {
    const last = out[out.length - 1];
    if (last && a - last.hi <= gap) { last.hi = a; last.count++; }
    else out.push({ lo: a, hi: a, count: 1 });
  }
  return out;
}

/**
 * Compare two reachability sets.
 *
 * `ours` and `ref` are iterables of executed addresses. `firstFrame` optionally
 * maps an address to the frame we first executed it, so the report can say
 * *when* we went the other way rather than only *where*.
 */
export function reachDiff(ours, ref, firstFrame = null) {
  const A = ours instanceof Set ? ours : new Set(ours);
  const B = ref instanceof Set ? ref : new Set(ref);
  const onlyOurs = [], onlyRef = [];
  for (const a of A) if (!B.has(a)) onlyOurs.push(a);
  for (const b of B) if (!A.has(b)) onlyRef.push(b);

  const withFrame = (rs) => rs.map((r) => {
    if (!firstFrame) return r;
    let f = Infinity;
    for (let a = r.lo; a <= r.hi; a++) {
      const v = firstFrame.get?.(a) ?? firstFrame[a];
      if (v != null && v < f) f = v;
    }
    return f === Infinity ? r : { ...r, firstFrame: f };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    shared: A.size - onlyOurs.length,
    onlyOurs: withFrame(regions(onlyOurs)),
    onlyRef: regions(onlyRef),
    // The earliest place we ran code the reference never does. When one side
    // takes a branch the other does not, this is where the histories part —
    // everything after it is downstream, so it is the only entry worth opening
    // first.
    get firstExclusive() {
      const r = this.onlyOurs.filter((x) => x.firstFrame != null);
      return r.length ? r.reduce((a, b) => (a.firstFrame <= b.firstFrame ? a : b)) : null;
    },
  };
}

/** A one-screen summary; the tool prints this. */
export function format(d, { limit = 12 } = {}) {
  const hx = (v) => v.toString(16).padStart(4, '0');
  const line = (r) => `  ${hx(r.lo)}-${hx(r.hi)}  ${String(r.count).padStart(5)} addrs`
    + (r.firstFrame != null ? `  first at f${r.firstFrame}` : '');
  const out = [`shared addresses: ${d.shared}`];
  out.push(`\n--- only WE run this (${d.onlyOurs.length} regions) ---`);
  for (const r of d.onlyOurs.slice(0, limit)) out.push(line(r));
  if (d.onlyOurs.length > limit) out.push(`  … ${d.onlyOurs.length - limit} more`);
  out.push(`\n--- only the REFERENCE runs this (${d.onlyRef.length} regions) ---`);
  for (const r of d.onlyRef.slice(0, limit)) out.push(line(r));
  if (d.onlyRef.length > limit) out.push(`  … ${d.onlyRef.length - limit} more`);
  const fe = d.firstExclusive;
  if (fe) out.push(`\nearliest divergence: we enter ${hx(fe.lo)}-${hx(fe.hi)} at f${fe.firstFrame}, `
    + `which the reference never executes`);
  return out.join('\n');
}
