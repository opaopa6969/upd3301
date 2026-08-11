// rngfind — acceptance. No ROM, no DOM, no disk.
//
// The whole point of this file is that the answers are KNOWN. Each program
// below is a random number generator written in Z80 assembly, right here, with
// its constants visible in the source — and the test is that the estimator
// comes back with those constants without being told. An estimator tested only
// against real titles cannot be wrong in a way anybody notices; this one can.
//
// The four shapes are the four that actually turn up in 8-bit games:
//
//   LCG      x' = 5x+1 mod 256          four instructions, everywhere
//   table    a 256-byte table + a RAM index pointer   the "random number table"
//   LFSR     Galois, right shift, taps B4h            SRL A / JR NC / XOR n
//   counter  the index pointer above, incidentally    frame counters look like this
//
// Two of the assertions are about being WRONG rather than right: the stack must
// not be reported as a generator (it fits an LCG — see the header of
// rngfind.js), and a byte that nothing reads must come back `unclassified`
// rather than named.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Z80 } from './z80.js';
import { assemble } from './z80asm.js';
import { IceCore } from './icecore.js';
import {
  observe, screen, sample, identifyState, identifyTable, findPointer,
  classifySequence, solveLcg, solveLfsr, solveCounter, solveModCounter, analyzeWalk,
  advance, predict, statesFor, verifyByPatch, describe, resolveSite,
  CallerMap, findRng, hashSeq, maskOf,
} from './rngfind.js';
import { disasm } from './z80dis.js';

// ---- harness -----------------------------------------------------------------
// A machine-shaped shell around the real Z80 core, the same trick
// test-icecore.mjs uses. `poke` lets a test drop a data table into memory
// without writing 256 DB bytes into the assembler source.

function makeMachine(src, { org = 0x100, poke = [], stepsPerFrame = 4000 } = {}) {
  const r = assemble(src, { org });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  const memory = new Uint8Array(0x10000);
  memory.set(r.bytes, r.org);
  for (const [addr, bytes] of poke) memory.set(bytes, addr);
  const cpu = new Z80({
    read: (a) => memory[a & 0xffff],
    write: (a, v) => { memory[a & 0xffff] = v & 0xff; },
    in: () => 0xff,
    out: () => {},
  });
  cpu.pc = r.org;
  cpu.sp = 0xff00;
  return {
    sys: { memory }, cpu, frame: 0, symbols: r.symbols,
    stepFrame() {
      for (let i = 0; i < stepsPerFrame && !cpu.halted; i++) cpu.step();
      this.frame++;
      return this;
    },
  };
}

// `open()` for findRng/verifyByPatch: a *fresh* machine at reset, every time.
// Determinism is what makes re-running instead of rewinding legitimate.
const opener = (src, opts) => () => {
  const m = makeMachine(src, opts);
  const ice = new IceCore();
  ice.attach(m);
  return { machine: m, ice, cpu: 'main' };
};

// ---- the programs ------------------------------------------------------------

// x' = 5x + 1 mod 256, drawn from two different call sites so that the caller
// map has something to separate.
const SRC_LCG = `
        ORG 100h
        LD SP,0FF00h
        LD A,7
        LD (seed),A
        LD B,0FAh
main:   CALL rng
        LD (sink1),A
        CALL rng
        LD (sink2),A
        DJNZ main
        HALT

rng:    LD A,(seed)
        LD C,A
        ADD A,A
        ADD A,A
        ADD A,C
        INC A
        LD (seed),A
        RET

seed:   DB 0
sink1:  DB 0
sink2:  DB 0
`;

// A 256-byte table at 0300h walked by an index in RAM. This is the shape the
// issue is named after.
const SRC_TABLE = `
        ORG 100h
        LD SP,0FF00h
        XOR A
        LD (idx),A
        LD B,0FAh
main:   CALL draw
        LD (sink1),A
        CALL draw
        LD (sink2),A
        DJNZ main
        HALT

draw:   LD A,(idx)
        INC A
        LD (idx),A
        LD L,A
        LD H,03h
        LD A,(HL)
        RET

idx:    DB 0
sink1:  DB 0
sink2:  DB 0
`;

// Galois LFSR, right shift, taps B4h. SRL A puts the bit that fell off into CF,
// which is exactly why hand-written 8-bit LFSRs pick this form.
const SRC_LFSR = `
        ORG 100h
        LD SP,0FF00h
        LD A,0ACh
        LD (seed),A
        LD B,0FAh
main:   CALL rng
        LD (sink1),A
        CALL rng
        LD (sink2),A
        DJNZ main
        HALT

rng:    LD A,(seed)
        SRL A
        JR NC,nofb
        XOR 0B4h
nofb:   LD (seed),A
        RET

seed:   DB 0
sink1:  DB 0
sink2:  DB 0
`;

// The table's bytes: deterministic, no Math.random anywhere in this repo.
const TABLE_BYTES = new Uint8Array(256);
for (let i = 0; i < 256; i++) TABLE_BYTES[i] = (i * 37 + 11) & 0xff;

// =============================================================================
// pure solvers
// =============================================================================

test('rngfind: solveLcg recovers the constants it was never told', () => {
  const seq = [];
  let x = 7;
  for (let i = 0; i < 40; i++) { x = (5 * x + 1) & 0xff; seq.push(x); }
  const m = solveLcg(seq, 8);
  assert.equal(m.kind, 'lcg');
  assert.equal(m.a, 5);
  assert.equal(m.c, 1);
  assert.equal(m.ambiguous, 0, 'a 40-sample full-period LCG must not be ambiguous');
});

test('rngfind: solveLcg on 16 bits', () => {
  const seq = [];
  let x = 0x1234;
  for (let i = 0; i < 40; i++) { x = (Math.imul(0x4e6d, x) + 0x3039) & 0xffff; seq.push(x); }
  const m = solveLcg(seq, 16);
  assert.equal(m.a, 0x4e6d);
  assert.equal(m.c, 0x3039);
});

test('rngfind: solveLcg refuses a sequence that is not one', () => {
  assert.equal(solveLcg([1, 2, 4, 8, 16, 32, 65, 131], 8), null);
});

test('rngfind: solveLfsr finds the taps and the shift direction', () => {
  const seq = [];
  let x = 0xac;
  for (let i = 0; i < 40; i++) { const b = x & 1; x >>= 1; if (b) x ^= 0xb4; seq.push(x); }
  const m = solveLfsr(seq, 8);
  assert.equal(m.kind, 'lfsr');
  assert.equal(m.form, 'galois-right');
  assert.equal(m.taps, 0xb4);
});

test('rngfind: solveCounter beats "LCG with a=1"', () => {
  const seq = [];
  for (let i = 0; i < 20; i++) seq.push((i * 3) & 0xff);
  const m = classifySequence(seq);
  assert.equal(m.kind, 'counter');
  assert.equal(m.step, 3);
});

test('rngfind: a counter that wraps at 15, not at 256', () => {
  // Taken verbatim off Ys II at 25D5h: a countdown reloaded at 0Eh. A modulus
  // that is not a power of two is what a table index looks like, and the
  // power-of-two solver cannot see it at all.
  const seq = [0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0x00, 0x0e, 0x0d, 0x0c, 0x0b,
    0x0a, 0x09, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0x00, 0x0e];
  assert.equal(solveCounter(seq, 8), null, 'mod 256 cannot explain it');
  const m = classifySequence(seq);
  assert.equal(m.kind, 'counter');
  assert.equal(m.mod, 15);
  assert.equal(m.step, 14, '-1 mod 15');
  assert.equal(advance(m, 0), 14);
  assert.match(describe(m), /mod 15/);
});

test('rngfind: solveModCounter refuses a sequence with disagreeing wraps', () => {
  assert.equal(solveModCounter([0, 1, 2, 0, 1, 2, 3, 4, 0, 1]), null);
});

test('rngfind: classifySequence refuses a two-state cycle (this is the stack)', () => {
  // A return address alternating between two call sites. It FITS an LCG
  // (a = 255), which is why the distinct-value guard exists.
  const seq = [];
  for (let i = 0; i < 30; i++) seq.push(i % 2 ? 0x1a : 0x2c);
  const lcg = solveLcg(seq, 8);
  assert.ok(lcg, 'the two-cycle really does fit an LCG — that is the trap');
  const m = classifySequence(seq);
  assert.equal(m.kind, 'unclassified');
  assert.match(m.reason, /distinct/);
});

test('rngfind: classifySequence says unclassified rather than guessing', () => {
  // xorshift8 — a real generator this module has no solver for. It must not be
  // named as an LCG or an LFSR.
  const seq = [];
  let x = 0x9d;
  for (let i = 0; i < 40; i++) {
    x ^= (x << 3) & 0xff; x ^= x >> 5; x ^= (x << 1) & 0xff; x &= 0xff;
    seq.push(x);
  }
  const m = classifySequence(seq);
  assert.equal(m.kind, 'unclassified');
});

test('rngfind: advance/predict/statesFor invert each other', () => {
  const model = { kind: 'lcg', bits: 8, a: 5, c: 1 };
  assert.equal(advance(model, 7), (5 * 7 + 1) & 0xff);
  const p = predict(model, 7, 3);
  assert.deepEqual(p, [36, 181, 138]);
  // The manipulation question: what do I write now to get 138 in three draws?
  const s = statesFor(model, 138, 3);
  assert.ok(s.includes(7), `expected 7 among ${JSON.stringify(s)}`);
});

test('rngfind: analyzeWalk sees a wrapping stride-1 walk', () => {
  const addrs = [];
  for (let i = 0; i < 600; i++) addrs.push(0x300 + (i & 0xff));
  const w = analyzeWalk(addrs);
  assert.equal(w.stride, 1);
  assert.equal(w.lo, 0x300);
  assert.equal(w.hi, 0x3ff);
  assert.equal(w.distinct, 256);
  assert.ok(w.wraps >= 2, 'a cyclic table walk wraps');
  assert.ok(w.strideRatio > 0.99);
});

test('rngfind: hashSeq is deterministic and order-sensitive', () => {
  assert.equal(hashSeq([1, 2, 3]), hashSeq([1, 2, 3]));
  assert.notEqual(hashSeq([1, 2, 3]), hashSeq([3, 2, 1]));
  assert.equal(maskOf(8), 0xff);
  assert.equal(maskOf(16), 0xffff);
});

// =============================================================================
// end to end, on assembled programs
// =============================================================================

test('rngfind: finds the assembled LCG and names its constants', () => {
  const r = findRng(opener(SRC_LCG), { frames: 8, minReads: 20 });
  assert.ok(r.ok);
  const lcg = r.states.find((s) => s.model.kind === 'lcg');
  assert.ok(lcg, `no LCG among ${r.states.map((s) => describe(s.model)).join(' | ')}`);
  assert.equal(lcg.model.a, 5);
  assert.equal(lcg.model.c, 1);
  // The seed is the byte labelled `seed` in the source. Its address is wherever
  // the assembler put it; what matters is that exactly one address was named.
  assert.equal(lcg.bytes, 1);
  assert.equal(lcg.readers.length, 1, 'one routine reads the seed');
  // Two writers, and both are real: the `LD (seed),A` inside rng, and the
  // `LD (seed),A` that seeds it at startup. A seed's initialiser showing up
  // beside its updater is a feature — it is where the run's whole future is
  // decided, and it is the first place to patch.
  assert.equal(lcg.writers.length, 2, 'the updater and the initialiser');
  // Two call sites in main → the caller map separates them.
  assert.equal(lcg.callers.length, 2, `callers: ${JSON.stringify(lcg.callers)}`);
});

test('rngfind: the stack is not reported as the generator', () => {
  const r = findRng(opener(SRC_LCG), { frames: 8, minReads: 20 });
  // 0FF00h-ish is where SP was set. Nothing near it may be classified.
  for (const s of r.states) {
    if (s.model.kind === 'unclassified') continue;
    assert.ok(s.addr < 0xfe00, `${describe(s.model)} at ${s.addr.toString(16)} is the stack`);
  }
});

test('rngfind: finds the table, its span, its stride and its index pointer', () => {
  const open = opener(SRC_TABLE, { poke: [[0x300, TABLE_BYTES]] });
  const r = findRng(open, { frames: 8, minReads: 20 });
  assert.ok(r.ok);
  const t = r.tables.find((x) => x.model.lo === 0x300);
  assert.ok(t, `no 0300h table among ${r.tables.map((x) => describe(x.model)).join(' | ')}`);
  assert.equal(t.model.hi, 0x3ff);
  assert.equal(t.model.stride, 1);
  assert.equal(t.model.length, 256);
  assert.equal(t.model.coverage, 1, 'a full-period walk sees every byte');
  assert.equal(t.model.mutable, false);
  // The bytes the CPU actually saw must be the bytes we poked in.
  for (let i = 0; i < 256; i++) assert.equal(t.model.bytes[i], TABLE_BYTES[i], `table[${i}]`);
  // …and the RAM byte that drives it. This is the knob for RNG manipulation:
  // write here and the next draw moves.
  assert.ok(r.pointers.length >= 1, 'the index pointer must be found');
  assert.equal(r.pointers[0].match, 1, 'the pointer tracks the index exactly');
});

test('rngfind: the table index is classified as a counter', () => {
  const open = opener(SRC_TABLE, { poke: [[0x300, TABLE_BYTES]] });
  const r = findRng(open, { frames: 8, minReads: 20 });
  const idx = r.states.find((s) => s.model.kind === 'counter');
  assert.ok(idx, `no counter among ${r.states.map((s) => describe(s.model)).join(' | ')}`);
  assert.equal(idx.model.step, 1);
  assert.equal(idx.addr, r.pointers[0].addr);
});

test('rngfind: finds the assembled LFSR, its form and its taps', () => {
  const r = findRng(opener(SRC_LFSR), { frames: 8, minReads: 20 });
  const l = r.states.find((s) => s.model.kind === 'lfsr');
  assert.ok(l, `no LFSR among ${r.states.map((s) => describe(s.model)).join(' | ')}`);
  assert.equal(l.model.form, 'galois-right');
  assert.equal(l.model.taps, 0xb4);
});

test('rngfind: a busy poller must not drown out the routine that updates the state', () => {
  // The shape found on Ys II at 25D5h: one instruction reads the byte 19,782
  // times while waiting (always the same value), another reads it 102 times and
  // decrements it. Merged, the stream is a constant with noise and classifies
  // as nothing. identifyState has to split by read site.
  const hits = [];
  let v = 0x0f;
  for (let i = 0; i < 40; i++) {
    for (let k = 0; k < 50; k++) hits.push({ frame: i, pc: 0x2315, addr: 0x25d5, value: 0x07, rw: 'r', caller: 0x230c });
    hits.push({ frame: i, pc: 0x25dd, addr: 0x25d5, value: v, rw: 'r', caller: 0x230c });
    v = v === 0 ? 0x0e : v - 1;
    hits.push({ frame: i, pc: 0x25e4, addr: 0x25d5, value: v, rw: 'w', caller: 0x230c });
  }
  const id = identifyState({ lo: 0x25d5, hi: 0x25d5, readers: [0x2315, 0x25dd], writers: [0x25e4], callers: [[0x230c, 40]] }, hits);
  assert.equal(id.model.kind, 'counter', describe(id.model));
  assert.equal(id.model.mod, 15);
  assert.match(id.fittedOn, /@25DD|@25E4/, `fitted on ${id.fittedOn}`);
});

// =============================================================================
// verification — the part that makes an estimate a claim
// =============================================================================

test('rngfind: patching the seed changes what the program executes', () => {
  const open = opener(SRC_LCG, { stepsPerFrame: 200 });
  const r = findRng(open, { frames: 40, minReads: 20 });
  const lcg = r.states.find((s) => s.model.kind === 'lcg');
  assert.ok(lcg);
  const v = verifyByPatch(open, {
    atFrame: 4, frames: 30, addr: lcg.addr, value: 0x99, probeAddr: lcg.addr,
  });
  assert.equal(v.changed, false, 'the LCG is straight-line code: the PC trace cannot change');
  // …but the VALUES do, and that is what the probe is for. A generator whose
  // consumer never branches still proves causality through its output stream.
  assert.equal(v.probeChanged, true, 'the seed we patched must change the value stream');
  assert.notDeepEqual(v.probeA, v.probeB);
});

test('rngfind: patching an unrelated byte proves nothing, and says so', () => {
  const open = opener(SRC_LCG, { stepsPerFrame: 200 });
  const r = findRng(open, { frames: 40, minReads: 20 });
  const lcg = r.states.find((s) => s.model.kind === 'lcg');
  const v = verifyByPatch(open, {
    atFrame: 4, frames: 30, addr: 0xa000, value: 0x99, probeAddr: lcg.addr,
  });
  assert.equal(v.changed, false);
  assert.equal(v.probeChanged, false);
  assert.match(v.verdict, /REFUTED/);
});

test('rngfind: patching the table index redirects the draws (RNG manipulation)', () => {
  const open = opener(SRC_TABLE, { poke: [[0x300, TABLE_BYTES]], stepsPerFrame: 200 });
  const r = findRng(open, { frames: 40, minReads: 20 });
  const ptr = r.pointers[0];
  assert.ok(ptr);
  const v = verifyByPatch(open, {
    atFrame: 4, frames: 30, addr: ptr.addr, value: 0x77, probeAddr: [0x300, 0x3ff],
  });
  // Moving the index makes the program draw different ENTRIES from the same
  // unchanged table — which is invisible if the probe only hashes values, and
  // obvious once it hashes (address, value). That distinction is the whole
  // reason a range probe exists.
  assert.equal(v.probeChanged, true);
  assert.notDeepEqual(v.probeA, v.probeB);
});

// =============================================================================
// caller map
// =============================================================================

test('rngfind: the caller map separates two call sites of the same routine', () => {
  const open = opener(SRC_LCG);
  const { ice } = open();
  ice.cpu('main').traceOn = false;
  const census = observe(ice, { frames: 8 });
  ice.detach();
  const cands = screen(census, { minReads: 20 });
  const st = cands.state[0];
  assert.ok(st);

  const { ice: ice2 } = open();
  ice2.cpu('main').traceOn = false;
  const s = sample(ice2, { frames: 8, addrs: [[st.lo, st.hi]] });
  ice2.detach();

  const cm = new CallerMap({ machine: 'test', title: 'SRC_LCG', romHash: 'fnv1a64:0000000000000000' });
  cm.ingest(s.hits);
  assert.equal(cm.entries.size, 2, 'two CALL sites → two callers');

  // Nothing here can know what a draw MEANS. A human writes that in.
  const [a, b] = [...cm.entries.keys()].sort((x, y) => x - y);
  cm.annotate(a, 'sink1 roll');
  const rows = cm.toRngCallers();
  assert.equal(rows.length, 2);
  const named = rows.find((x) => x.meaning === 'sink1 roll');
  assert.ok(named, JSON.stringify(rows));
  assert.ok(named.samples > 100);
  assert.ok(named.distribution.includes(':'));
  // The unannotated one stays unannotated — being counted is not being understood.
  assert.ok(rows.some((x) => !x.meaning));

  // Notes survive a round trip through a file.
  const json = cm.notesJson();
  const cm2 = new CallerMap().loadNotes(json);
  assert.equal(cm2.entries.get(a).meaning, 'sink1 roll');
});

test('rngfind: the caller map exports into analysisdb without inventing confidence', async () => {
  const { fromRngCallers, validate } = await import('./analysisdb.js');
  const cm = new CallerMap();
  cm.entries.set(0x8c10, { pc: 0x8c10, via: new Set([0x9002]), samples: 128, values: new Map([[3, 60], [4, 68]]), meaning: 'encounter roll', note: null });
  cm.entries.set(0x8c44, { pc: 0x8c44, via: new Set([0x9002]), samples: 40, values: new Map([[1, 40]]), meaning: null, note: null });
  const doc = fromRngCallers(cm.toRngCallers(), { machine: 'pc8801', romHash: 'fnv1a64:0102030405060708' });
  const v = validate(doc);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.ok(doc.labels['8C10'], 'the annotated caller becomes a label');
  assert.equal(doc.unclassified.length, 1, 'the unannotated caller stays a tail');
  assert.equal(doc.unclassified[0].addr, '8C44');
});

// =============================================================================
// reporting
// =============================================================================

test('rngfind: resolveSite walks a logged PC back to the instruction', () => {
  // LD A,(1234h) at 8000h is 3A 34 12; the data read logs pc=8003h.
  const mem = new Uint8Array(0x10000);
  mem.set([0x3a, 0x34, 0x12], 0x8000);
  const read = (a) => mem[a & 0xffff];
  const r = resolveSite(read, disasm, 0x8003);
  assert.equal(r.resolved, true);
  assert.equal(r.addr, 0x8000);
  assert.match(r.text, /LD\s+A,\(1234h?\)/i);
  // 8002h (`LD (DE),A`) also ends at 8003h. The tool must say the parse was
  // ambiguous rather than pretend the walk-back is exact.
  assert.ok(r.ambiguous >= 2, 'reading a byte stream backwards is ambiguous');
  // Without a disassembler it degrades honestly rather than lying.
  assert.deepEqual(resolveSite(read, null, 0x8003), { addr: 0x8003, text: null, resolved: false });
});

test('rngfind: describe() is one line per model', () => {
  assert.match(describe({ kind: 'lcg', bits: 8, a: 5, c: 1 }), /5\*x \+ 1/);
  assert.match(describe({ kind: 'table', lo: 0x300, hi: 0x3ff, stride: 1, length: 256 }), /table 0300-03FF/);
  assert.match(describe({ kind: 'unclassified', reason: 'nope' }), /unclassified: nope/);
  assert.match(describe(null), /none/);
});
