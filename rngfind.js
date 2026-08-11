// rngfind — find the random-number generator a game is actually using, and
// then *break* it. Pure, zero-import, deterministic, machine-independent.
//
// Why this exists: a lot of 8-bit games do not have a random number generator,
// they have a **table** — a run of bytes in ROM walked by a pointer in RAM —
// and the rest use a four-instruction LCG or an LFSR. Players who "manipulate
// RNG" are exploiting that structure by hand. On a deterministic emulator the
// structure is *observable*: every read the CPU makes is on the bus, already
// resolved through whichever bank was selected, and the whole run can be
// replayed byte-identically. So this module does not guess from statistics. It
// watches, proposes a model, and then **proves or disproves the model by
// patching the state and replaying** — if the downstream execution does not
// change, the estimate was wrong, and it says so.
//
// This file imports nothing. It talks to an ICE-shaped object by capability:
//
//   ice.cpu(name)            → { arch, read, write, profData? }
//   ice.recordMem(name, o)   → memory access log with an onHit stream
//   ice.runFrames(n)         → drive the machine
//   ice.detach()
//   machine.snapshot()/restore()   (optional — only the input search needs it)
//
// so it works on any machine icecore.js can attach to, and the tests below it
// drive a toy assembled with z80asm.js, no ROM in sight.
//
// Three things bit us while building it. They are the reason for three of the
// defaults, and none of them are obvious:
//
//  1. **Instruction fetches and data reads share one bus.** On a Z80 every
//     opcode byte arrives through the same `bus.read` as `LD A,(HL)`, so a raw
//     read log is 90% "the program read itself" and every routine looks like it
//     is walking a table. The filter that works is exact rather than
//     heuristic: at the moment of a fetch the core has not yet advanced PC past
//     the byte it is fetching, so **addr === pc means fetch**. Data reads never
//     satisfy that except for self-referential code.
//
//  2. **The PC recorded with a data read points AFTER the operands.** `LD
//     A,(1234h)` at 8000h logs pc=8003h, because the two operand bytes were
//     fetched before the data read. It is still a stable per-instruction key,
//     so grouping works — but printing it as "the instruction at 8003h" is a
//     lie, and `resolveSite()` exists to walk it back.
//
//  3. **The stack looks exactly like RNG state.** A byte that is read a lot and
//     written a lot, in RAM, adjacent to another one just like it — that is a
//     16-bit seed, and it is also every stack slot in the machine. Worse, a
//     return address that alternates between two call sites *fits an LCG*
//     (x' = 255x + (x0+x1) mod 256 is exactly a two-cycle), so the classifier
//     will confidently name it. Three defences, all of them earned:
//     `dropStack` skips accesses within a couple of bytes of SP, `maxWriters`
//     rejects addresses with many writer PCs, and `classifySequence` refuses a
//     sequence with almost no distinct values — "it cycles" is not "it
//     generates". Without the first one, the top candidate on the synthetic
//     test was the stack, not the LCG the test had just assembled.

export const SCHEMA_VERSION = 1;

export const hex = (v, w = 4) => (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

// FNV-1a over a sequence of integers, byte by byte. Used to compare two replays
// without keeping both traces in memory.
export function hashSeq(seq, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < seq.length; i++) {
    let v = seq[i] >>> 0;
    for (let k = 0; k < 4; k++) { h = ((h ^ (v & 0xff)) >>> 0); h = Math.imul(h, 0x01000193) >>> 0; v >>>= 8; }
  }
  return h >>> 0;
}

// =============================================================================
// Pure: sequence models
// =============================================================================
// Everything in this section is a function from a list of observed states to a
// model, or from a model to the next state. No machine, no ICE, no I/O — which
// is what makes the synthetic tests possible: assemble a known LCG, run it,
// and assert that the solver comes back with the constants that were written
// in the source.

export const maskOf = (bits) => (bits >= 32 ? 0xffffffff : ((1 << bits) - 1)) >>> 0;

const popcount = (x) => {
  let n = 0;
  for (let v = x >>> 0; v; v &= v - 1) n++;
  return n;
};

/** v' = v + step. Reported separately from an LCG with a=1 because "it counts"
 *  is a far more useful thing to know than "a=1, c=1": a counter is usually a
 *  frame counter, and a frame counter is the seed a player can actually move. */
export function solveCounter(seq, bits = 8) {
  const mask = maskOf(bits);
  if (seq.length < 4) return null;
  const step = (seq[1] - seq[0]) & mask;
  if (step === 0) return null; // a constant is not a counter
  for (let i = 1; i < seq.length; i++) {
    if ((((seq[i - 1] + step) & mask) >>> 0) !== ((seq[i] & mask) >>> 0)) return null;
  }
  return { kind: 'counter', bits, step, period: mask + 1 };
}

/**
 * v' = (v + step) mod m, for an m that is NOT a power of two.
 *
 * This is the single most common thing a table-driven game actually does: the
 * index into a 15-entry, 40-entry or 256-entry table wraps at the table length,
 * not at 256. The first real disk this was pointed at (Ys II, 25D5h) counts
 * `0f 0e … 01 00 0e …` — a countdown mod 15 — and the power-of-two solver
 * cannot see it at all, so the candidate came back `unclassified` while sitting
 * right there in the write stream.
 *
 * The modulus is READ OFF the wrap, not searched: at a wrap, v' = v + step ∓ m.
 * Every wrap must agree, and the whole sequence is then re-verified.
 */
export function solveModCounter(seq, { minWraps = 1 } = {}) {
  if (seq.length < 6) return null;
  const deltas = new Map();
  for (let i = 1; i < seq.length; i++) {
    const d = seq[i] - seq[i - 1];
    deltas.set(d, (deltas.get(d) ?? 0) + 1);
  }
  const [step, hits] = [...deltas].filter(([d]) => d !== 0).sort((a, b) => b[1] - a[1])[0] ?? [];
  if (step === undefined) return null;
  if (hits < (seq.length - 1) * 0.5) return null; // not dominated by one step
  let m = null, wraps = 0;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] - seq[i - 1] === step) continue;
    const cand = step > 0 ? seq[i - 1] + step - seq[i] : seq[i] - seq[i - 1] + (-step);
    if (cand <= Math.abs(step)) return null;
    if (m === null) m = cand; else if (m !== cand) return null;
    wraps++;
  }
  if (m === null || wraps < minWraps) return null;
  for (let i = 1; i < seq.length; i++) {
    if (((((seq[i - 1] + step) % m) + m) % m) !== seq[i]) return null;
  }
  return { kind: 'counter', bits: 8, step: ((step % m) + m) % m, mod: m, period: m, rawStep: step };
}

/**
 * v' = (a*v + c) mod 2^bits, brute-forced over a.
 *
 * Brute force rather than solving the two-equation system on purpose: the
 * algebraic solution needs (v1-v0) to be invertible mod 2^bits, i.e. odd, and
 * an 8-bit LCG hands you even differences constantly. 256 (or 65536)
 * candidates verified against the whole sequence is both simpler and stricter.
 *
 * Every fit is kept. Short sequences admit several (a,c) pairs, and reporting
 * one of them as "the" answer is exactly the kind of confident-and-wrong the
 * rest of this repo has been bitten by. `ambiguous` says how many survived.
 */
export function solveLcg(seq, bits = 8, { minSamples = 5 } = {}) {
  const mask = maskOf(bits);
  if (seq.length < minSamples) return null;
  const fits = [];
  for (let a = 0; a <= mask; a++) {
    const c = (seq[1] - Math.imul(a, seq[0])) & mask;
    let ok = true;
    for (let i = 1; i < seq.length; i++) {
      if ((((Math.imul(a, seq[i - 1]) + c) & mask) >>> 0) !== ((seq[i] & mask) >>> 0)) { ok = false; break; }
    }
    if (ok) { fits.push({ a, c: c >>> 0 }); if (fits.length > 8) break; }
  }
  if (!fits.length) return null;
  const [best] = fits;
  return {
    kind: 'lcg', bits, a: best.a, c: best.c,
    ambiguous: fits.length > 1 ? fits.length : 0,
    alternatives: fits.slice(1),
  };
}

// The four shift/feedback shapes an 8-bit game plausibly hand-writes. A Galois
// LFSR xors the tap mask into the shifted state when the bit that fell off was
// set; a Fibonacci one computes the parity of the tapped bits and shifts it in.
// Both directions of both shapes, because assembly authors pick whichever way
// RRA/RLA falls out of the register they already have.
const LFSR_FORMS = {
  'galois-right': (x, taps, mask, bits) => { const b = x & 1; const y = x >>> 1; return ((b ? y ^ taps : y) & mask) >>> 0; },
  'galois-left': (x, taps, mask, bits) => { const b = (x >>> (bits - 1)) & 1; const y = (x << 1) & mask; return ((b ? y ^ taps : y) & mask) >>> 0; },
  'fibonacci-right': (x, taps, mask, bits) => { const b = popcount(x & taps) & 1; return (((x >>> 1) | (b << (bits - 1))) & mask) >>> 0; },
  'fibonacci-left': (x, taps, mask, bits) => { const b = popcount(x & taps) & 1; return (((x << 1) | b) & mask) >>> 0; },
};

export function solveLfsr(seq, bits = 8, { minSamples = 6 } = {}) {
  const mask = maskOf(bits);
  if (seq.length < minSamples) return null;
  const fits = [];
  for (const [form, f] of Object.entries(LFSR_FORMS)) {
    for (let taps = 1; taps <= mask; taps++) {
      let ok = true;
      for (let i = 1; i < seq.length; i++) {
        if (f(seq[i - 1] & mask, taps, mask, bits) !== ((seq[i] & mask) >>> 0)) { ok = false; break; }
      }
      if (ok) { fits.push({ form, taps }); break; } // one tap mask per form is enough
    }
  }
  if (!fits.length) return null;
  const [best] = fits;
  return { kind: 'lfsr', bits, form: best.form, taps: best.taps, ambiguous: fits.length > 1 ? fits.length : 0, alternatives: fits.slice(1) };
}

/**
 * The whole classifier for a *state* sequence, in the order that makes the
 * answer most informative: counter (a player-movable frame counter) beats LCG
 * with a=1, and an LCG that happens to also be an LFSR is reported as the LCG
 * because its constants are the thing you edit.
 *
 * Returns `{kind:'unclassified', reason}` rather than a guess. That is the
 * house rule (docs/ice-design.md, analysisdb.js): a model nobody can verify is
 * worse than an admitted blank.
 */
export function classifySequence(seq, { bits = 8, minDistinct = 4 } = {}) {
  const s = [...seq];
  if (s.length < 4) return { kind: 'unclassified', reason: `only ${s.length} samples — need 4+ to say anything` };
  const distinct = new Set(s).size;
  if (distinct === 1) return { kind: 'unclassified', reason: `constant ${hex(s[0], 2)} throughout — read a lot, never changed; not a generator` };
  const counter = solveCounter(s, bits) ?? solveModCounter(s);
  if (counter) return counter;
  // Accident (3). A stack slot alternating between two return addresses fits an
  // LCG with a = 2^bits - 1, and the solver will say so with a straight face.
  // Requiring the sequence to actually take several values is the cheap, general
  // defence: a generator generates.
  if (distinct < minDistinct && s.length >= 8) {
    return { kind: 'unclassified', reason: `only ${distinct} distinct values over ${s.length} samples — this cycles, it does not generate (a stack slot or a two-state flag looks like this)` };
  }
  return solveLcg(s, bits)
    ?? solveLfsr(s, bits)
    ?? { kind: 'unclassified', reason: `${s.length} samples fit no counter / LCG / LFSR over ${bits} bits (xorshift, multi-word state, or an external input such as VRTC or the Z80 R register)` };
}

/** One step of a model. Table models step an index; the rest step a value. */
export function advance(model, state, n = 1) {
  let s = state >>> 0;
  if (model.kind === 'table') {
    const len = model.length;
    for (let i = 0; i < n; i++) s = (((s + model.stride) % len) + len) % len;
    return s;
  }
  const mask = maskOf(model.bits ?? 8);
  for (let i = 0; i < n; i++) {
    if (model.kind === 'counter') s = model.mod ? (((s + model.step) % model.mod) + model.mod) % model.mod : ((s + model.step) & mask) >>> 0;
    else if (model.kind === 'lcg') s = ((Math.imul(model.a, s) + model.c) & mask) >>> 0;
    else if (model.kind === 'lfsr') s = LFSR_FORMS[model.form](s, model.taps, mask, model.bits ?? 8);
    else return NaN;
  }
  return s;
}

/** The next `n` draws from `state`, as the program would see them. */
export function predict(model, state, n) {
  const out = [];
  let s = state >>> 0;
  for (let i = 0; i < n; i++) {
    s = advance(model, s, 1);
    out.push(model.kind === 'table' ? (model.bytes ? model.bytes[s] : s) : s);
  }
  return out;
}

/**
 * The other direction — the one that makes this a *manipulation* tool rather
 * than an analysis one: what do I write into the state RIGHT NOW so that in
 * `steps` draws the program gets `want`?
 *
 * Brute force over the state space (256 or 65536 entries), because a table
 * pointer and an LFSR invert differently and an LCG with an even multiplier is
 * not invertible at all. Returns every state that works, so the caller can pick
 * one that is also plausible (some games sanity-check their own seed).
 */
export function statesFor(model, want, steps = 1, { limit = 16 } = {}) {
  const out = [];
  const n = model.kind === 'table' ? model.length : (model.mod ?? maskOf(model.bits ?? 8) + 1);
  for (let s = 0; s < n; s++) {
    const got = predict(model, s, steps);
    if (got[steps - 1] === (want >>> 0)) { out.push(s); if (out.length >= limit) break; }
  }
  return out;
}

// =============================================================================
// Walk analysis (the table case)
// =============================================================================

/**
 * Does this address sequence walk a table? Returns the dominant stride, the
 * span, and how well the walk explains the reads.
 *
 * A table RNG's read site steps by a constant (usually +1) and wraps; a memcpy
 * also steps by a constant, which is why `wraps` and the caller count matter
 * more than the stride itself when ranking candidates.
 */
export function analyzeWalk(addrs) {
  if (addrs.length < 3) return null;
  const deltas = new Map();
  for (let i = 1; i < addrs.length; i++) {
    const d = addrs[i] - addrs[i - 1];
    deltas.set(d, (deltas.get(d) ?? 0) + 1);
  }
  const sorted = [...deltas].sort((a, b) => b[1] - a[1]);
  // The most common non-zero delta is the stride; a zero delta means the site
  // re-read the same byte (a spin loop, or a 16-bit read counted twice).
  const nz = sorted.filter(([d]) => d !== 0);
  if (!nz.length) return null;
  const [stride, strideHits] = nz[0];
  const lo = Math.min(...addrs), hi = Math.max(...addrs);
  const distinct = new Set(addrs).size;
  // A wrap is a step that jumps back across the span — table pointers wrap,
  // buffer copies do not.
  const wraps = nz.filter(([d]) => Math.sign(d) !== Math.sign(stride) && Math.abs(d) > Math.abs(stride) * 4)
    .reduce((a, [, n]) => a + n, 0);
  const span = hi - lo + 1;
  return {
    stride, strideHits, strideRatio: strideHits / (addrs.length - 1),
    lo, hi, span, distinct, wraps,
    // How much of the span the walk actually touched. A table is walked
    // exhaustively; a buffer that is only ever indexed at four places is not.
    density: distinct / Math.max(1, Math.ceil(span / Math.abs(stride))),
  };
}

// =============================================================================
// Observation (pass 1: census)
// =============================================================================

// A per-address counter that does not allocate 64 MB when the address space is
// 24 bits. Under a megabyte of range it is a typed array; above it, a Map.
class AddrCount {
  constructor(lo, hi) {
    this.lo = lo; this.hi = hi;
    const n = hi - lo + 1;
    this.dense = n <= (1 << 20) ? new Uint32Array(n) : null;
    this.sparse = this.dense ? null : new Map();
  }
  add(a) {
    if (this.dense) { this.dense[a - this.lo]++; return; }
    this.sparse.set(a, (this.sparse.get(a) ?? 0) + 1);
  }
  or(a, bits) {
    if (this.dense) { this.dense[a - this.lo] |= bits; return; }
    this.sparse.set(a, (this.sparse.get(a) ?? 0) | bits);
  }
  get(a) {
    if (a < this.lo || a > this.hi) return 0;
    return this.dense ? this.dense[a - this.lo] : (this.sparse.get(a) ?? 0);
  }
  *entries() {
    if (this.dense) {
      for (let i = 0; i < this.dense.length; i++) if (this.dense[i]) yield [this.lo + i, this.dense[i]];
    } else {
      for (const e of this.sparse) yield e;
    }
  }
}

const DEFAULTS = {
  frames: 300,
  // Frames to run BEFORE the tap goes on. On a real title the first few hundred
  // frames are the disk loader, and a loader reads a thousand contiguous bytes
  // with a constant stride from one PC — which is the exact signature of a
  // table walk. Every early scan of a real disk had the FDC transfer loop as its
  // top candidate until this existed.
  settle: 0,
  lo: 0,
  hi: null,          // defaults to the CPU's address mask
  dropFetches: true, // see accident (1) in the header
  dropStack: true,   // see accident (3)
  stackWindow: 3,    // bytes above SP still counted as "the stack"
  sitesMax: 8192,    // distinct memory-touching PCs we are willing to track
  distinctCap: 512,  // per-site distinct-address set cap (then `distinctCapped`)
  walkCap: 4096,     // per-site address samples retained for analyzeWalk
  callersCap: 64,
};

// Is this access the stack rather than data? On every CPU here the push has
// already decremented SP and the pop has not yet incremented it when the bus
// callback runs, so the pushed/popped bytes sit at [sp, sp+1]. The window is
// widened a little because a 68000 pushes four bytes and because EX (SP),HL
// touches the same slot from the other side.
const stackProbe = (c, window) => {
  const spOf = c?.arch?.spOf;
  if (!spOf) return () => false;
  return (addr) => {
    const sp = spOf(c.cpu) >>> 0;
    const d = addr - sp;
    return d >= -2 && d <= window;
  };
};

/**
 * Pass 1. Tap every memory access for `frames` frames and build a census:
 * per-address read/write counts, and per-read-site (PC) address behaviour and
 * caller set. Nothing is retained per hit, so a 4-million-access run costs
 * about half a second and a couple of megabytes.
 */
export function observe(ice, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const name = o.cpu ?? 'main';
  const c = ice.cpu(name);
  if (!c) return null;
  const mask = c.arch?.addrMask ?? 0xffff;
  const lo = o.lo & mask;
  const hi = (o.hi == null ? mask : o.hi) & mask;

  const reads = new AddrCount(lo, hi);
  const writes = new AddrCount(lo, hi);
  // Value-diversity sketch: one bit per value class (v & 31) per address, so
  // `popcount` says roughly how many different bytes ever lived there. One OR
  // per access, 256 KB for a 64 K space.
  //
  // Screening without it put a byte that is read 37,258 times and is ALWAYS 5Bh
  // at the top of the list on a real title, ahead of the actual generator —
  // volume alone measures how busy an address is, not whether it varies. It
  // also ate the whole pass-2 sample budget, which is how the real candidates
  // ended up reported as "0 samples".
  const values = new AddrCount(lo, hi);
  const sites = new Map();   // pc → read site
  const stores = new Map();  // pc → write site
  let sitesDropped = 0, fetches = 0, total = 0, stackHits = 0;
  const isStack = o.dropStack ? stackProbe(c, o.stackWindow) : () => false;

  // Reaching into profData.stack rather than calling ice.backtrace() is
  // deliberate: backtrace() reverses and re-maps the whole stack into fresh
  // objects, and this callback runs several million times per scan. The guard
  // keeps it working on an ICE that does not expose a shadow stack at all.
  const stack = c.profData?.stack ?? null;
  const callerOf = () => {
    if (!stack || !stack.length) return -1;
    const f = stack[stack.length - 1];
    return f.retTo ?? -1;
  };

  const siteFor = (map, pc) => {
    let s = map.get(pc);
    if (s) return s;
    if (map.size + sites.size + stores.size >= o.sitesMax) { sitesDropped++; return null; }
    s = {
      pc, n: 0, first: -1, last: -1, min: Infinity, max: -Infinity,
      distinct: new Set(), distinctCapped: false,
      walk: [], lastAddr: -1,
      callers: new Map(), callersCapped: false,
      values: [], valueSet: new Set(),
    };
    map.set(pc, s);
    return s;
  };

  const note = (s, h) => {
    s.n++;
    if (s.first < 0) s.first = h.frame;
    s.last = h.frame;
    if (h.addr < s.min) s.min = h.addr;
    if (h.addr > s.max) s.max = h.addr;
    if (s.distinct.size < o.distinctCap) s.distinct.add(h.addr); else s.distinctCapped = true;
    if (s.walk.length < o.walkCap) s.walk.push(h.addr);
    if (s.valueSet.size < 64) s.valueSet.add(h.value);
    const caller = callerOf();
    if (caller >= 0) {
      if (s.callers.size < o.callersCap || s.callers.has(caller)) s.callers.set(caller, (s.callers.get(caller) ?? 0) + 1);
      else s.callersCapped = true;
    }
  };

  if (o.settle > 0) ice.runFrames(o.settle);

  ice.recordMem(name, {
    lo, hi, r: true, w: true, keep: 0,
    onHit(h) {
      total++;
      // accident (1): the opcode and its operands come through the same bus.
      // At fetch time the core has not advanced PC past the byte yet.
      if (h.rw === 'r' && h.addr === h.pc) { fetches++; if (o.dropFetches) return; }
      if (isStack(h.addr)) { stackHits++; return; }
      values.or(h.addr, (1 << (h.value & 31)) >>> 0);
      if (h.rw === 'r') { reads.add(h.addr); const s = siteFor(sites, h.pc); if (s) note(s, h); }
      else { writes.add(h.addr); const s = siteFor(stores, h.pc); if (s) note(s, h); }
    },
  });

  const t0 = Date.now();
  const run = ice.runFrames(o.frames);
  return {
    schemaVersion: SCHEMA_VERSION,
    cpu: name, lo, hi, settle: o.settle, frames: run.frames, stopped: run.stopped,
    ms: Date.now() - t0,
    total, fetches, stackHits, sitesDropped, dropFetches: o.dropFetches, dropStack: o.dropStack,
    reads, writes, values, sites, stores,
  };
}

// =============================================================================
// Screening (pass 1 → candidates)
// =============================================================================

const SCREEN_DEFAULTS = {
  minReads: 8,        // a seed read fewer times than this is not worth a replay
  minWrites: 4,
  maxWriters: 6,      // accident (3): the stack has hundreds of writer PCs
  maxRun: 4,          // adjacent read+write bytes that form one state word
  minValueClasses: 3, // a generator generates — a byte that is always 5Bh does not
  minDistinct: 12,    // a walker must actually walk
  minStrideRatio: 0.5,
  maxTableSpan: 8192,
  minDensity: 0.5,
  top: 12,
};

/**
 * Turn a census into ranked candidates. Two families, because they are found by
 * opposite signals:
 *
 *   state  — few addresses, read AND written, by very few PCs   (LCG/LFSR/counter)
 *   walker — one PC, many addresses, constant stride            (table)
 *
 * Ranking is by caller diversity first and volume second. That ordering is the
 * single most useful thing learned here: a routine whose result is consumed
 * from eleven different places is a random number generator; a routine with one
 * caller is a memcpy, no matter how table-shaped its reads look.
 */
export function screen(obs, opts = {}) {
  const o = { ...SCREEN_DEFAULTS, ...opts };
  const out = { state: [], walker: [], notes: [] };
  if (!obs) return out;

  // --- writers per address, so `maxWriters` can be applied ---
  const writersOf = new Map(); // addr → Set(pc)
  for (const s of obs.stores.values()) {
    for (const a of s.distinct) {
      let set = writersOf.get(a);
      if (!set) { set = new Set(); writersOf.set(a, set); }
      set.add(s.pc);
    }
  }

  // --- state candidates -------------------------------------------------------
  const hot = [];
  for (const [a, r] of obs.reads.entries()) {
    const w = obs.writes.get(a);
    if (r < o.minReads || w < o.minWrites) continue;
    // The value-diversity sketch, applied before anything expensive. This is a
    // *class* count (value & 31), so it undercounts — which is the safe
    // direction: it never rejects an address that really did vary.
    if (obs.values && popcount(obs.values.get(a)) < o.minValueClasses) continue;
    const writers = writersOf.get(a);
    // A write site whose distinct set overflowed cannot be trusted to list all
    // the addresses it touched, so `writers` may be short. That undercounts
    // rather than overcounts, which is the safe direction here.
    if (writers && writers.size > o.maxWriters) continue;
    hot.push(a);
  }
  hot.sort((x, y) => x - y);
  // Merge adjacent bytes into words. Longer than `maxRun` is a buffer, not a
  // seed — and a long run is exactly what the stack looks like.
  const runs = [];
  for (const a of hot) {
    const last = runs[runs.length - 1];
    if (last && a === last.hi + 1) last.hi = a; else runs.push({ lo: a, hi: a });
  }
  for (const run of runs) {
    const len = run.hi - run.lo + 1;
    if (len > o.maxRun) { out.notes.push(`${hex(run.lo)}-${hex(run.hi)}: ${len} adjacent hot bytes — a buffer or the stack, not a seed`); continue; }
    let reads = 0, writes = 0;
    const readers = new Set(), writers = new Set(), callers = new Map();
    for (let a = run.lo; a <= run.hi; a++) { reads += obs.reads.get(a); writes += obs.writes.get(a); }
    for (const s of obs.sites.values()) {
      if (s.max < run.lo || s.min > run.hi) continue;
      let touched = false;
      for (let a = run.lo; a <= run.hi; a++) if (s.distinct.has(a)) touched = true;
      if (!touched) continue;
      readers.add(s.pc);
      for (const [pc, n] of s.callers) callers.set(pc, (callers.get(pc) ?? 0) + n);
    }
    for (const s of obs.stores.values()) {
      if (s.max < run.lo || s.min > run.hi) continue;
      for (let a = run.lo; a <= run.hi; a++) if (s.distinct.has(a)) { writers.add(s.pc); break; }
    }
    if (!readers.size) continue;
    out.state.push({
      kind: 'state', lo: run.lo, hi: run.hi, bytes: len,
      reads, writes, readers: [...readers], writers: [...writers],
      callers: [...callers].sort((a, b) => b[1] - a[1]),
      score: callers.size * 1000 + Math.min(reads, writes),
    });
  }

  // --- walker candidates ------------------------------------------------------
  for (const s of obs.sites.values()) {
    if (s.distinct.size < o.minDistinct) continue;
    const walk = analyzeWalk(s.walk);
    if (!walk) continue;
    if (walk.strideRatio < o.minStrideRatio) continue;
    if (walk.span > o.maxTableSpan) continue;
    if (walk.density < o.minDensity) continue;
    // A region that is written during the run is not a ROM table. It might
    // still be a shuffled RAM table, so this is a note, not a rejection.
    let written = 0;
    for (let a = walk.lo; a <= walk.hi; a++) written += obs.writes.get(a);
    out.walker.push({
      kind: 'walker', pc: s.pc, reads: s.n,
      lo: walk.lo, hi: walk.hi, span: walk.span, stride: walk.stride,
      distinct: s.distinct.size, distinctCapped: s.distinctCapped,
      strideRatio: walk.strideRatio, wraps: walk.wraps, density: walk.density,
      writtenBytes: written,
      callers: [...s.callers].sort((a, b) => b[1] - a[1]),
      score: s.callers.size * 1000 + s.n,
    });
  }

  out.state.sort((a, b) => b.score - a.score);
  out.walker.sort((a, b) => b.score - a.score);
  out.state = out.state.slice(0, o.top);
  out.walker = out.walker.slice(0, o.top);
  return out;
}

// =============================================================================
// Sampling (pass 2: the actual value streams)
// =============================================================================

/**
 * Pass 2. Re-run the same machine from reset — determinism is what makes this
 * free — and this time keep the ordered (frame, pc, addr, value, caller) stream
 * for a handful of addresses and read sites.
 *
 * `addrs` is a list of [lo,hi] ranges; `pcs` a list of read-site PCs.
 */
export function sample(ice, {
  cpu = 'main', frames = 300, settle = 0, addrs = [], pcs = [],
  keep = 60000, keepPer = 4000, dropStack = true, stackWindow = 3,
} = {}) {
  const c = ice.cpu(cpu);
  if (!c) return null;
  const mask = c.arch?.addrMask ?? 0xffff;
  const wantPc = new Set(pcs);
  const stack = c.profData?.stack ?? null;
  const callerOf = () => (stack && stack.length ? (stack[stack.length - 1].retTo ?? -1) : -1);
  const isStack = dropStack ? stackProbe(c, stackWindow) : () => false;
  const hits = [];
  // Per-candidate budgets, not one shared pool. With a single budget the busiest
  // candidate takes all of it and every other candidate is reported as "0
  // samples — need 4+ to say anything", which reads as "we looked and found
  // nothing" when the truth is "we never looked". That happened on the first
  // real title scanned: two addresses with 37k and 24k reads starved eight
  // others, including the one that mattered.
  const used = new Map();
  let dropped = 0;
  if (settle > 0) ice.runFrames(settle);
  ice.recordMem(cpu, {
    lo: 0, hi: mask, r: true, w: true, keep: 0,
    onHit(h) {
      if (h.rw === 'r' && h.addr === h.pc) return; // fetch
      if (isStack(h.addr)) return;
      let key = -1;
      for (let i = 0; i < addrs.length; i++) if (h.addr >= addrs[i][0] && h.addr <= addrs[i][1]) { key = i; break; }
      if (key < 0 && wantPc.has(h.pc)) key = addrs.length + h.pc;
      if (key < 0) return;
      const n = used.get(key) ?? 0;
      if (n >= keepPer || hits.length >= keep) { dropped++; return; }
      used.set(key, n + 1);
      hits.push({ frame: h.frame, pc: h.pc, addr: h.addr, value: h.value, rw: h.rw, caller: callerOf() });
    },
  });
  const run = ice.runFrames(frames);
  return { hits, dropped, frames: run.frames, stopped: run.stopped };
}

// =============================================================================
// Identification
// =============================================================================

/**
 * Given a state candidate and the sampled stream, decide what generator it is.
 *
 * Both the read stream and the write stream are tried. They answer slightly
 * different questions — the reads are the states the program *consumed*, the
 * writes are the states it *stored* — and a routine that reads its seed twice
 * per draw (low byte, high byte) produces a clean write stream and a doubled
 * read stream. Whichever fits wins; if neither does, the answer is
 * "unclassified" with the sample count attached, not a shrug.
 */
export function identifyState(cand, hits, { bits = null } = {}) {
  const inRange = (h) => h.addr >= cand.lo && h.addr <= cand.hi;
  const width = cand.hi - cand.lo + 1;

  // Multi-byte state: assemble words, one per pass over the run of addresses.
  // "Start a new word when we see the base address" is the framing rule; when
  // it does not hold the sequence comes out short and the solver declines.
  //
  // Both byte orders are tried, and so is **each byte on its own**. That last
  // one is not a fallback, it is the common case: the low byte of an LCG mod
  // 2^16 is itself an LCG mod 2^8 with the same a and c, so a 16-bit generator
  // is usually recognised from one byte of it. On the real disks in this repo
  // that single strategy is the difference between "12 candidates, 1
  // classified" and finding the generator.
  const words = (rows, order) => {
    if (width === 1) return rows.map((h) => h.value);
    const seq = [];
    let cur = null;
    for (const h of rows) {
      if (h.addr === cand.lo || cur === null) { if (cur && cur.have === width) seq.push(cur.v >>> 0); cur = { v: 0, have: 0 }; }
      const shift = order === 'le' ? (h.addr - cand.lo) * 8 : (cand.hi - h.addr) * 8;
      cur.v |= (h.value & 0xff) << shift;
      cur.have++;
    }
    if (cur && cur.have === width) seq.push(cur.v >>> 0);
    return seq;
  };

  const rowsR = hits.filter((h) => h.rw === 'r' && inRange(h));
  const rowsW = hits.filter((h) => h.rw === 'w' && inRange(h));

  // Streams are also gathered PER SITE, and that matters more than it looks.
  // Merging every read of an address mixes the routine that UPDATES the state
  // with every routine that merely polls it, and the poller usually wins on
  // volume: Ys II reads 25D5h 19,782 times from one instruction (always 07h,
  // it is waiting) and 102 times from the instruction that actually decrements
  // it. Merged, the sequence is a constant with noise and classifies as
  // nothing. Split by site, the updater is a clean countdown.
  const bySite = (rows) => {
    const m = new Map();
    for (const h of rows) {
      let a = m.get(h.pc);
      if (!a) { a = []; m.set(h.pc, a); }
      a.push(h);
    }
    return [...m].sort((x, y) => y[1].length - x[1].length).slice(0, 6);
  };

  const strategies = [];
  for (const [tag, rows] of [['reads', rowsR], ['writes', rowsW]]) {
    if (width > 1) {
      strategies.push({ from: `${tag} (word LE)`, bits: bits ?? Math.min(32, width * 8), seq: words(rows, 'le') });
      strategies.push({ from: `${tag} (word BE)`, bits: bits ?? Math.min(32, width * 8), seq: words(rows, 'be') });
      for (let a = cand.lo; a <= cand.hi; a++) {
        strategies.push({ from: `${tag} (byte ${hex(a)})`, bits: 8, addr: a, seq: rows.filter((h) => h.addr === a).map((h) => h.value) });
      }
    } else {
      strategies.push({ from: tag, bits: bits ?? 8, seq: rows.map((h) => h.value) });
    }
    for (const [pc, rs] of bySite(rows)) {
      if (width === 1) {
        strategies.push({ from: `${tag} @${hex(pc)}`, bits: bits ?? 8, site: pc, seq: rs.map((h) => h.value) });
      } else {
        strategies.push({ from: `${tag} @${hex(pc)} (word LE)`, bits: bits ?? Math.min(32, width * 8), site: pc, seq: words(rs, 'le') });
        for (let a = cand.lo; a <= cand.hi; a++) {
          strategies.push({ from: `${tag} @${hex(pc)} (byte ${hex(a)})`, bits: 8, site: pc, addr: a, seq: rs.filter((h) => h.addr === a).map((h) => h.value) });
        }
      }
    }
  }

  // Two phases. A four-sample arithmetic run is a coincidence often enough that
  // taking the first fit found would let a short per-site stream outvote a long
  // one; so anything with a decent sample count is considered first, and the
  // short fits are only a fallback.
  let pick = null, fallback = null;
  for (const s of strategies) {
    if (s.seq.length < 8) continue;
    const m = classifySequence(s.seq, { bits: s.bits });
    if (m.kind !== 'unclassified') { pick = { ...s, model: m }; break; }
    if (!fallback || s.seq.length > fallback.seq.length) fallback = { ...s, model: m };
  }
  if (!pick) {
    for (const s of strategies) {
      const m = classifySequence(s.seq, { bits: s.bits });
      if (m.kind !== 'unclassified') { pick = { ...s, model: m }; break; }
      if (!fallback || s.seq.length > fallback.seq.length) fallback = { ...s, model: m };
    }
  }
  const chosen = pick ?? fallback ?? { from: 'none', bits: 8, seq: [], model: { kind: 'unclassified', reason: 'no samples' } };

  return {
    addr: chosen.addr ?? cand.lo, lo: cand.lo, hi: cand.hi, bytes: width, bits: chosen.bits,
    model: chosen.model, fittedOn: chosen.from,
    samples: { reads: rowsR.length, writes: rowsW.length },
    first: chosen.seq[0] ?? null,
    sequence: chosen.seq.slice(0, 32),
    readers: cand.readers, writers: cand.writers,
    callers: cand.callers,
  };
}

/**
 * A walker becomes a table model: the bytes it read, in address order, plus the
 * stride. `bytes` is filled from what the CPU actually saw rather than by
 * peeking memory afterwards — on a banked machine the bank that was selected
 * during the read is the only one that means anything, and that information is
 * gone by the time the run ends.
 */
export function identifyTable(cand, hits) {
  const rows = hits.filter((h) => h.rw === 'r' && h.pc === cand.pc);
  const bytes = new Map();
  for (const h of rows) if (!bytes.has(h.addr)) bytes.set(h.addr, h.value);
  let conflicts = 0;
  for (const h of rows) if (bytes.get(h.addr) !== h.value) conflicts++;
  const lo = cand.lo, hi = cand.hi;
  const stride = cand.stride;
  const length = Math.floor((hi - lo) / Math.abs(stride)) + 1;
  const arr = new Array(length).fill(null);
  for (const [a, v] of bytes) {
    const i = Math.floor((a - lo) / Math.abs(stride));
    if (i >= 0 && i < length) arr[i] = v;
  }
  const known = arr.filter((v) => v !== null).length;
  return {
    model: {
      kind: 'table', lo, hi, stride, length,
      bytes: arr, coverage: known / length,
      // A table whose bytes changed under us is a shuffled RAM table — still a
      // generator, but the index alone no longer predicts the value.
      mutable: conflicts > 0,
    },
    pc: cand.pc,
    reads: cand.reads,
    conflicts,
    indexSequence: rows.map((h) => Math.floor((h.addr - lo) / Math.abs(stride))),
    callers: cand.callers,
  };
}

/**
 * The knob. A table RNG is only manipulable if you can find the RAM byte that
 * holds the index, so this looks for a state candidate whose observed value
 * sequence tracks the index sequence the walker produced.
 *
 * `offset` is allowed because plenty of routines store the *pointer low byte*
 * rather than the index; a constant offset between them still means "write
 * here and the next draw moves".
 */
export function findPointer(indexSeq, hits, stateCands, { minMatch = 0.8, minSamples = 8 } = {}) {
  const out = [];
  for (const cand of stateCands) {
    if (cand.bytes > 2) continue;
    const rows = hits.filter((h) => h.rw === 'w' && h.addr === cand.lo);
    if (rows.length < minSamples) continue;
    const vals = rows.map((h) => h.value);
    const n = Math.min(vals.length, indexSeq.length);
    if (n < minSamples) continue;
    // Try every constant offset; the winner is the one that explains the most
    // pairs. This is a correlation, not a proof — verifyByPatch is the proof.
    let best = { off: 0, match: 0 };
    for (let off = 0; off < 256; off++) {
      let m = 0;
      for (let i = 0; i < n; i++) if (((indexSeq[i] + off) & 0xff) === (vals[i] & 0xff)) m++;
      if (m > best.match) best = { off, match: m };
    }
    const ratio = best.match / n;
    if (ratio >= minMatch) out.push({ addr: cand.lo, offset: best.off, match: ratio, samples: n });
  }
  return out.sort((a, b) => b.match - a.match);
}

// =============================================================================
// Verification — patch the state, replay, see whether the world changed
// =============================================================================

/**
 * The reason this tool is allowed to make claims at all.
 *
 * Run the machine twice from reset. In run B, at `atFrame`, write `value` into
 * `addr`. If the two runs then execute the *same instructions in the same
 * order*, the byte we patched is not upstream of anything — the model is
 * wrong, or the value is recomputed before use, and either way the candidate
 * should not be presented as the RNG.
 *
 * The digest is a hash of the de-duplicated PC trace rather than of memory,
 * because "the program took a different branch" is machine-independent and
 * memory dumps are not. `firstDiff` is the trace index where they part, which
 * is where a human should point the ICE next.
 */
export function verifyByPatch(open, {
  cpu = 'main', atFrame = 120, frames = 60, addr, value,
  traceMax = 3_000_000, probeAddr = null,
} = {}) {
  const runOne = (patch) => {
    const { ice } = open();
    const c = ice.cpu(cpu);
    c.traceOn = false;
    ice.runFrames(atFrame);
    if (patch) c.write(addr, value & 0xff);
    const probe = [];
    if (probeAddr != null) {
      // A probe over a RANGE has to hash the address as well as the byte, not
      // just the byte: a table's contents never change, so probing a table with
      // values alone reports "nothing happened" even when the pointer was moved
      // and the program is now drawing completely different entries. That was a
      // real false negative in the synthetic table test.
      const [pl, ph] = Array.isArray(probeAddr) ? probeAddr : [probeAddr, probeAddr];
      const wide = ph > pl;
      ice.recordMem(cpu, {
        lo: pl, hi: ph, r: true, w: false, keep: 0,
        onHit(h) { if (h.addr !== h.pc && probe.length < 8192) probe.push(wide ? ((h.addr << 8) | h.value) : h.value); },
      });
    }
    ice.recordPcTrace(cpu, { max: traceMax, fromFrame: 0, dedupe: true });
    ice.runFrames(frames);
    const tr = ice.pcTrace(cpu);
    const pcs = Array.from(tr.pcs.subarray(0, tr.n));
    ice.detach();
    return { pcs, hash: hashSeq(pcs), n: tr.n, probe, probeHash: hashSeq(probe) };
  };

  const A = runOne(false);
  const B = runOne(true);
  let firstDiff = -1;
  const n = Math.min(A.pcs.length, B.pcs.length);
  for (let i = 0; i < n; i++) if (A.pcs[i] !== B.pcs[i]) { firstDiff = i; break; }
  if (firstDiff < 0 && A.pcs.length !== B.pcs.length) firstDiff = n;

  return {
    addr, value, atFrame, frames,
    changed: A.hash !== B.hash,
    firstDiff,
    lenA: A.n, lenB: B.n,
    hashA: A.hash, hashB: B.hash,
    // Where the two runs part company, in instructions. A patch that only ever
    // changes things thousands of instructions later is still causal, but the
    // interesting case is the one that diverges within a few hundred.
    contextA: firstDiff >= 0 ? A.pcs.slice(Math.max(0, firstDiff - 6), firstDiff + 6) : [],
    contextB: firstDiff >= 0 ? B.pcs.slice(Math.max(0, firstDiff - 6), firstDiff + 6) : [],
    probeChanged: probeAddr != null ? A.probeHash !== B.probeHash : null,
    probeA: A.probe.slice(0, 24), probeB: B.probe.slice(0, 24),
    // Three outcomes, not two. The middle one is real and was met on the first
    // patch of a real title: a per-frame counter whose value provably changed
    // while 515,261 instructions came out byte-identical. That byte feeds data,
    // not a decision — which is exactly what a player needs to know before
    // spending an afternoon manipulating it.
    verdict: A.hash !== B.hash
      ? 'CONFIRMED: patching this byte changed which instructions the program executed'
      : (probeAddr != null && A.probeHash !== B.probeHash)
        ? 'PARTIAL: the value stream changed but the control flow did not — this byte is upstream of data, not (yet) of a decision. Try a longer --frames or a probe closer to the consumer.'
        : 'REFUTED: the program executed identically — this byte is not (yet) upstream of anything, or it is recomputed before use',
  };
}

// =============================================================================
// Caller map — the part a human fills in
// =============================================================================

/**
 * "Where was it called from" is the question that makes an RNG useful, because
 * the same table read from 8C10h decides an encounter and from 8C44h decides a
 * critical hit. Nothing here can tell those apart automatically, so this is a
 * *container for human annotations* keyed by call site, with the measurements
 * attached so a note can be checked against them later.
 *
 * The distribution is kept per caller for exactly that reason: analysisdb's
 * validator will warn when a stated `expected` ("1/16") disagrees with the
 * measured hits, which catches a note that was true in 1988 and is not true of
 * this ROM revision.
 */
export class CallerMap {
  constructor({ machine = '', title = '', cpu = 'main', romHash = '' } = {}) {
    this.meta = { machine, title, cpu, romHash };
    this.entries = new Map(); // callerPc → {pc, site, samples, values:Map, meaning, note}
  }

  /** Fold a sampled hit stream in. `sitePc` filters to one read site. */
  ingest(hits, { sitePc = null, rw = 'r' } = {}) {
    for (const h of hits) {
      if (h.rw !== rw) continue;
      if (sitePc != null && h.pc !== sitePc) continue;
      const key = h.caller >= 0 ? h.caller : h.pc;
      let e = this.entries.get(key);
      if (!e) { e = { pc: key, via: new Set(), samples: 0, values: new Map(), meaning: null, note: null }; this.entries.set(key, e); }
      e.samples++;
      e.via.add(h.pc);
      e.values.set(h.value, (e.values.get(h.value) ?? 0) + 1);
    }
    return this;
  }

  /** The human part. `meaning` is free text: "encounter roll", "crit chance". */
  annotate(pc, meaning, note = null) {
    let e = this.entries.get(pc);
    if (!e) { e = { pc, via: new Set(), samples: 0, values: new Map(), meaning: null, note: null }; this.entries.set(pc, e); }
    e.meaning = meaning ?? null;
    if (note != null) e.note = note;
    return this;
  }

  /** Merge notes loaded from a JSON file written by a previous session. */
  loadNotes(obj) {
    for (const [k, v] of Object.entries(obj ?? {})) {
      const pc = typeof k === 'number' ? k : parseInt(k, 16);
      if (!Number.isFinite(pc)) continue;
      this.annotate(pc, typeof v === 'string' ? v : v?.meaning, typeof v === 'object' ? v?.note ?? null : null);
    }
    return this;
  }

  notesJson() {
    const out = {};
    for (const e of [...this.entries.values()].sort((a, b) => a.pc - b.pc)) {
      if (!e.meaning && !e.note) continue;
      out[hex(e.pc)] = e.note ? { meaning: e.meaning, note: e.note } : e.meaning;
    }
    return out;
  }

  /**
   * The shape analysisdb.fromRngCallers() eats. Callers with no meaning become
   * `unclassified` entries that still carry their numbers — being counted and
   * being understood are different things, and that module keeps them apart.
   */
  toRngCallers({ topValues = 8 } = {}) {
    const out = [];
    for (const e of [...this.entries.values()].sort((a, b) => b.samples - a.samples)) {
      const dist = [...e.values].sort((a, b) => b[1] - a[1]).slice(0, topValues)
        .map(([v, n]) => `${hex(v, 2)}:${n}`).join(' ');
      const row = {
        pc: hex(e.pc),
        samples: e.samples,
        pattern: `read via ${[...e.via].map((p) => hex(p)).join(',')}`,
        distribution: dist,
        basis: 'rngfind caller map: bus-level read log with the shadow call stack',
      };
      if (e.meaning) { row.meaning = e.meaning; row.confidence = 'inferred'; }
      if (e.note) row.reason = e.note;
      out.push(row);
    }
    return out;
  }
}

// =============================================================================
// Input search — the actual "RNG manipulation"
// =============================================================================

/**
 * Issue #38's third act: from a known point, find an input sequence that makes
 * the goal true. Brute force is *correct* here in a way it never is on real
 * hardware — same input, same state, always — so the search is just an
 * enumeration with restore() between trials.
 *
 * `plans` is an iterable of {wait, keys:[[type,row,bit,atFrame]…], label}.
 * `goal(machine, ice)` decides. Returns the first plan that satisfies it, plus
 * everything that was tried, because "0 of 240 plans worked" is a result.
 */
export function searchInputs(machine, ice, {
  cpu = 'main', plans = [], goal = () => false, frames = 60, atFrame = null,
} = {}) {
  if (typeof machine.snapshot !== 'function' || typeof machine.restore !== 'function') {
    return { ok: false, error: 'this machine has no snapshot()/restore() — the search needs to rewind' };
  }
  if (atFrame != null && machine.frame < atFrame) ice.runFrames(atFrame - machine.frame);
  const base = machine.snapshot();
  const baseFrame = machine.frame;
  const tried = [];
  for (const plan of plans) {
    machine.restore(base);
    const stop = baseFrame + (plan.wait ?? 0) + frames;
    const keys = [...(plan.keys ?? [])];
    while (machine.frame < stop) {
      for (const k of keys) {
        if ((baseFrame + (k[3] ?? plan.wait ?? 0)) !== machine.frame) continue;
        ice.rawKey?.(k[0], k[1], k[2]);
      }
      ice.runFrames(1);
    }
    const hit = !!goal(machine, ice);
    tried.push({ label: plan.label ?? '', wait: plan.wait ?? 0, hit });
    if (hit) { return { ok: true, plan, tried, base }; }
  }
  machine.restore(base);
  return { ok: false, tried, base, error: `none of ${tried.length} plans reached the goal` };
}

// =============================================================================
// Reporting helpers
// =============================================================================

/**
 * Walk back from the PC a data read logged (accident (2): it points after the
 * operands) to the address the instruction actually starts at. Needs a
 * disassembler; without one it returns the raw value and says so.
 */
export function resolveSite(read, disasm, pcAfter, { mask = 0xffff, back = 4 } = {}) {
  if (!disasm) return { addr: pcAfter, text: null, resolved: false };
  // Every offset whose instruction ends exactly at pcAfter is a legal parse of
  // the bytes; a byte stream really is ambiguous read backwards. `LD A,(1234h)`
  // at 8000h logs pc=8003h, and 8002h decodes as the one-byte `LD (DE),A`,
  // which also ends there. Two tie-breaks, in this order: the instruction that
  // performs a memory access is the one that produced the hit, and among those
  // the longest wins (the short parse is a fragment of the long one). It can
  // still be wrong, so `ambiguous` says how many parses fitted.
  const cands = [];
  for (let off = 1; off <= back; off++) {
    const a = (pcAfter - off) & mask;
    let d;
    try { d = disasm(read, a); } catch { continue; }
    if (d && d.len === off) cands.push({ addr: a, text: d.text, len: off, mem: /\(/.test(d.text) });
  }
  if (!cands.length) return { addr: pcAfter, text: null, resolved: false };
  cands.sort((x, y) => (y.mem - x.mem) || (y.len - x.len));
  const [best] = cands;
  return { addr: best.addr, text: best.text, resolved: true, ambiguous: cands.length > 1 ? cands.length : 0 };
}

/** One-line description of a model, for a report or a commit message. */
export function describe(model) {
  if (!model) return '(none)';
  switch (model.kind) {
    case 'counter': return `counter +${model.step} mod ${model.mod ?? `2^${model.bits}`}`;
    case 'lcg': return `LCG x' = ${model.a}*x + ${model.c} mod 2^${model.bits}${model.ambiguous ? ` (${model.ambiguous} fits — ambiguous)` : ''}`;
    case 'lfsr': return `LFSR ${model.form} taps=${hex(model.taps, 2)} (${model.bits} bit)`;
    case 'table': return `table ${hex(model.lo)}-${hex(model.hi)} stride ${model.stride} len ${model.length}${model.mutable ? ' (mutable — rewritten during the run)' : ''}`;
    default: return `unclassified: ${model.reason ?? 'no model'}`;
  }
}

/**
 * The whole pipeline, for callers that just want an answer.
 * `open()` must return a *fresh* machine at reset each time; determinism does
 * the rest.
 */
export function findRng(open, opts = {}) {
  const cpu = opts.cpu ?? 'main';
  const frames = opts.frames ?? DEFAULTS.frames;

  const p1 = open();
  const c1 = p1.ice.cpu(cpu);
  if (c1) c1.traceOn = false; // the register ring is dead weight for a census
  const census = observe(p1.ice, { ...opts, cpu, frames });
  p1.ice.detach();
  if (!census) return { ok: false, error: `no CPU named "${cpu}"` };
  const cands = screen(census, opts);

  const addrs = cands.state.map((s) => [s.lo, s.hi]);
  const pcs = cands.walker.map((w) => w.pc);
  if (!addrs.length && !pcs.length) {
    return { ok: true, census, candidates: cands, states: [], tables: [], pointers: [], unclassified: ['no state or walker candidate passed screening'] };
  }

  const p2 = open();
  const c2 = p2.ice.cpu(cpu);
  if (c2) c2.traceOn = false;
  const s = sample(p2.ice, { cpu, frames, settle: opts.settle ?? 0, addrs, pcs, keep: opts.keep ?? 40000 });
  p2.ice.detach();

  const states = cands.state.map((cand) => identifyState(cand, s.hits));
  const tables = cands.walker.map((cand) => identifyTable(cand, s.hits));
  const pointers = tables.length
    ? findPointer(tables[0].indexSequence, s.hits, cands.state)
    : [];

  const unclassified = [];
  for (const st of states) {
    if (st.model.kind === 'unclassified') unclassified.push(`${hex(st.addr)}: ${st.model.reason}`);
  }
  return { ok: true, census, candidates: cands, hits: s.hits, states, tables, pointers, unclassified };
}
