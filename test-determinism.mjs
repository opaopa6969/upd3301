// The determinism contract, tested WITHOUT any ROM.
//
// This file exists because the contract broke on main and stayed broken for two
// days. The sub-CPU clock (`_subMark` / `_subDebt`) was left out of
// snapshot/restore, so a restored machine ran its two CPUs at a different
// relative phase than the original — the exact failure the ICE's undo tree
// cannot tolerate. A test *was* watching for it (test-snapshot.mjs) and *was*
// failing. It just never ran: every case in that file starts with
//
//     if (!rom) return t.skip('no ROM (bring your own)')
//
// and this repository ships no ROMs. The detector existed and was firing into
// an empty room.
//
// So: assemble a few instructions with z80asm.js, drop them at 0x0000, and run
// the machine on that. No ROM, no disk image, nothing to bring — these run on
// every machine, in CI, on a fresh clone. They are deliberately small; their
// job is not to prove the emulator is accurate but to prove that
// **replaying from a snapshot lands on the identical timeline**, which is the
// property every other tool in this repo is built on.
//
// Keep them ROM-free. A contract test that can skip is a contract test that
// will skip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemble } from './z80asm.js';
import { Pc8801Machine } from './machine88.js';
import { buildD88, parseD88 } from './d88.js';

/** Assemble `src` and pad it into a ROM-sized image the machine can boot from. */
function rom(src, size = 0x8000) {
  const r = assemble(src, { org: 0 });
  assert.deepEqual(r.errors, [], 'the test program itself must assemble');
  const out = new Uint8Array(size);
  out.set(r.bytes);
  return out;
}

// A program that keeps *both* CPUs and the timing state busy: it banks, writes
// to RAM, talks to the FDC's ports through the 8255, and spins. Anything that
// forgets to save part of the machine shows up as a diverging replay.
const BUSY = `
        ORG 0
start:  LD SP,0F380h
        LD A,1
        OUT (31h),A          ; banking: the port the restore path must carry
        LD HL,0E000h
        LD BC,0
loop:   INC BC
        LD A,C
        XOR B
        LD (HL),A
        INC HL
        BIT 4,H              ; wrap inside E000-EFFF so we stay in RAM
        JR NZ,wrap
        IN A,(40h)           ; VRTC — reading time itself
        XOR (HL)
        LD (0E800h),A
        JR loop
wrap:   LD HL,0E000h
        JR loop
`;

/** Everything a replay must reproduce, flattened for comparison. */
const fingerprint = (m) => JSON.stringify({
  main: m.cpu.getState(),
  sub: m.sub ? m.sub.cpu.getState() : null,
  fdc: m.sub?.fdc ? m.sub.fdc.getState?.() ?? null : null,
  frame: m.frame,
  ram: Array.from(m.ram.slice(0xe000, 0xe040)),
  ports: [m._port31, m._port32],
});

const boot = () => {
  const m = new Pc8801Machine({
    main: rom(BUSY), ext: new Uint8Array(0x8000), sub: new Uint8Array(0x2000), mode: 'n88',
  });
  return m;
};

test('the same program run twice produces the same machine', () => {
  // If this fails, something is reading a clock, Math.random, or uninitialised
  // memory — determinism is gone before snapshots even enter the picture.
  const a = boot(), b = boot();
  for (let f = 0; f < 60; f++) { a.stepFrame(); b.stepFrame(); }
  assert.equal(fingerprint(a), fingerprint(b));
});

test('restoring a snapshot replays the identical timeline', () => {
  // The contract the ICE's undo/redo tree depends on: go forward, come back,
  // go forward again, and land on exactly the same state.
  const m = boot();
  for (let f = 0; f < 40; f++) m.stepFrame();

  const snap = m.snapshot();
  for (let f = 0; f < 25; f++) m.stepFrame();
  const first = fingerprint(m);

  m.restore(snap);
  for (let f = 0; f < 25; f++) m.stepFrame();
  assert.equal(fingerprint(m), first);
});

test('a snapshot restores onto a *different* machine instance', () => {
  // Restoring in place can pass by accident when a field is never written back,
  // because the live object still holds the right value. Moving the snapshot to
  // a fresh machine removes that safety net — this is the case that catches a
  // field missing from restore() entirely.
  const src = boot();
  for (let f = 0; f < 40; f++) src.stepFrame();
  // structuredClone, not JSON.parse(JSON.stringify(...)). That line was here to
  // "force plain data" and did the opposite: a Uint8Array comes back from JSON
  // as {"0":…,"1":…}, and `TypedArray.set()` copies ZERO elements from that
  // without throwing — so the snapshot arrived with every buffer empty and the
  // case still passed, because the test program overwrites the compared RAM
  // within a frame. The check was watching a machine restored from nothing.
  // See test-contract.mjs (`the snapshot is plain data`, and the raw-JSON todo).
  const snap = structuredClone(src.snapshot());
  for (let f = 0; f < 25; f++) src.stepFrame();

  const dst = boot();
  dst.restore(snap);
  for (let f = 0; f < 25; f++) dst.stepFrame();
  assert.equal(fingerprint(dst), fingerprint(src));
});

test('the sub-CPU clock survives a snapshot', () => {
  // The specific regression that motivated this file. The main CPU drives the
  // sub through a debt/mark pair; leaving those out of the snapshot let the two
  // CPUs resume at a different relative phase, which is invisible for a frame
  // or two and then diverges. Assert on the fields directly so the failure
  // names the cause instead of just saying "the timelines differ".
  const m = boot();
  for (let f = 0; f < 40; f++) m.stepFrame();
  const snap = m.snapshot();
  assert.ok(snap.subClock, 'the snapshot must carry the sub clock');
  assert.equal(typeof snap.subClock.mark, 'number');
  assert.equal(typeof snap.subClock.debt, 'number');

  // and it must actually come back
  const mark = m._subMark, debt = m._subDebt;
  for (let f = 0; f < 25; f++) m.stepFrame();
  m.restore(snap);
  assert.equal(m._subMark, mark);
  assert.equal(m._subDebt, debt);
});

test('a snapshot never carries ROM bytes', () => {
  // ROM is immutable, so shipping it in every snapshot would multiply the
  // rewind ring's memory by the ROM size for no information. Check it directly
  // rather than by size: the snapshot is legitimately large (64K of RAM, 48K of
  // GVRAM, plus the sub board), so a size threshold would either be too loose to
  // catch anything or would fail for honest reasons.
  const marker = 0xa5;
  const m = new Pc8801Machine({
    main: rom(BUSY).fill(marker, 0x4000), // fill the unused tail of the ROM
    ext: new Uint8Array(0x8000).fill(marker),
    sub: new Uint8Array(0x2000).fill(marker),
    mode: 'n88',
  });
  for (let f = 0; f < 10; f++) m.stepFrame();
  const s = m.snapshot();
  for (const [key, v] of Object.entries(s)) {
    const arr = ArrayBuffer.isView(v) ? v : Array.isArray(v) ? v : null;
    if (!arr || arr.length < 0x2000) continue;
    const allMarker = Array.from(arr).every((b) => b === marker);
    assert.ok(!allMarker, `snapshot field "${key}" looks like a copy of ROM`);
  }
});

test('the snapshot is plain data, so the host can store and diff it', () => {
  // The rewind ring, the ICE's undo tree and the analysis format all assume a
  // snapshot is copyable state and nothing else. Anything holding a class
  // instance, a Map or a function silently loses state on the way back.
  //
  // This case used to round-trip through JSON and then run fifteen frames
  // before comparing. Both halves were wrong. JSON turns the typed arrays into
  // {"0":…} objects that TypedArray.set() silently ignores, so the copy was
  // empty; and running frames first let the test program rewrite the compared
  // RAM, so an empty copy converged to the right answer anyway. The check
  // passed for two reasons that cancelled out. Compare IMMEDIATELY, and copy
  // the way the host actually copies.
  const m = boot();
  for (let f = 0; f < 20; f++) m.stepFrame();
  const s = m.snapshot();
  const copy = structuredClone(s);

  const fresh = boot();
  fresh.restore(copy);
  assert.equal(fingerprint(fresh), fingerprint(m), 'a copied snapshot must restore identically');

  for (let f = 0; f < 15; f++) fresh.stepFrame();
  const viaCopy = fingerprint(fresh);

  const direct = boot();
  direct.restore(s);
  for (let f = 0; f < 15; f++) direct.stepFrame();
  assert.equal(viaCopy, fingerprint(direct), 'a copy must change nothing');
});

test('a mounted disk does not make the machine non-deterministic', () => {
  // The FDC and the 8255 pair carry a lot of latched state; a disk in the drive
  // is what wakes it all up. Same program, same disk, twice.
  const disk = () => parseD88(buildD88({
    name: 'DET', media: 0x00,
    tracks: [[1, 2].map((r) => ({ c: 0, h: 0, r, n: 1, data: new Uint8Array(256).fill(r) }))],
  }));
  const a = boot(), b = boot();
  a.insertDisk(0, disk());
  b.insertDisk(0, disk());
  for (let f = 0; f < 50; f++) { a.stepFrame(); b.stepFrame(); }
  assert.equal(fingerprint(a), fingerprint(b));

  // and the same disk-bearing machine round-trips
  const snap = a.snapshot();
  for (let f = 0; f < 20; f++) a.stepFrame();
  const first = fingerprint(a);
  a.restore(snap);
  for (let f = 0; f < 20; f++) a.stepFrame();
  assert.equal(fingerprint(a), first);
});
