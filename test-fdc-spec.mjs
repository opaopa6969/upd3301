// µPD765 termination conformance — the matrix an adversarial review asked for.
//
// The parity work against M88 chased screen fingerprints, which cannot see the
// difference between "ended correctly" and "ended wrongly but the game did not
// look". These tests read the seven result bytes instead, across the product of
//
//     MT{0,1} × starting HD{0,1} × how the transfer ends
//
// Expectations come from the Intel 8272 / µPD765A specification, **not** from
// M88 — M88 is the thing under test (it patches the sub ROM's motor delay out,
// so "M88 agrees" is not evidence of hardware fidelity). Where our behaviour
// and the specification disagree the test fails, and that is the point:
// see docs/review/2026-08-10-fdc-adversarial-review.md and issue #40.
//
// ATTEMPT 2 (2026-08-10): a "TC window" was tried and reverted. Measuring the
// real board showed the ordering `… R R DONE R TC(result)` — the chip finishes
// by itself on the last byte and TC arrives too late to matter. So a phase was
// added that drops EXM at EOT (the signal the sub ROM waits for) and holds the
// ending open until TC. It satisfied the EOC test, and the four titles spot-
// checked kept matching M88 — but the full 353-title sweep fell from 327 exact
// to 321, with five new failures (Aggres, Rayieza ×2, Zarth, ウイングマン) losing
// their graphics entirely. Narrowing the window to "TC only, never EOC" did not
// help either: the mere existence of the extra phase, and the MSR it exposes,
// is enough to break them. Reverted.
//
// The lesson worth keeping: **a matrix passing and four titles matching is not
// evidence.** Both attempts at this looked correct until the sweep ran.
//
// WHY, measured rather than guessed: the sub ROM ships **two** transfer drivers,
// and EXM means opposite things to them.
//
//   0300 (Aggres, Zarth, Rayieza, Wingman):
//       IN A,(0FAh) / AND 20h / JR Z,0318h   <- EXM low means "transfer over"
//       ...then IN A,(0FBh) for the byte, and TC at 0332
//   0790 (Ys1, GAZZEL, ...):
//       IN A,(0FEh) / BIT 2,A / RET Z        <- watches the 8255, not EXM
//
// To the 0300 driver **EXM is the promise that another byte exists**. Dropping
// it while holding the ending open is indistinguishable from a transfer that
// stopped early, so those titles abandon the load with bytes still outstanding —
// which is why narrowing the window changed nothing. The problem was never
// whether to report EOC; it was dropping EXM at all.
//
// ATTEMPT 4 (2026-08-13) — THE EOC ONE LANDED, AND THE NOTE BELOW IT WAS WRONG.
//
// This header used to claim EOT was unreachable on this board and that EOC was
// "not expressible in the current model" without giving the FDC a byte period.
// Both claims were measured and are false:
//
//   * Reachable, and often: across 353 titles at 1500 frames, **316 titles reach
//     EOT with no TC, 3,934 times in total** (counted in _execDone).
//   * M88 does raise EOC there. `refdrv` already prints every result phase, and
//     Aggres alone shows `ST[40 80]` ×5 and `ST[44 80]` ×4 — abnormal termination
//     with ST1.EN, exactly what the specification asks for.
//
// What was actually missing was the **window**, not the status. M88 does not end
// the command at EOT; it parks on `SetTimer(timerphase, 20)` — 200 µs — and only
// calls it End of Cylinder if that timer fires. A TC arriving first goes through
// `tcphase` and ends normally. RQM and EXM are already down while it waits (M88's
// `GetData` drops them on the last byte), so the window is indistinguishable from
// the gap between two sectors — which is precisely what the 0300 driver watches
// before pulsing TC. Real loads therefore land inside the window.
//
// Attempt 2 failed because it invented a different mechanism (a phase that held
// the ending open) instead of M88's timer; attempt 3 raised EOC with no window at
// all. With the window in place the 353-title sweep is **identical line for line**
// to the baseline (328 exact / 333 tracking / 0 blank) and our result-byte
// distribution lands next to M88's:
//
//     ST0 ST1     M88   ours
//     00 00        15     18
//     04 00        10     10
//     40 80         5      5     <- EOC
//     44 80         4      6     <- EOC, HD=1
//     40 02         4      0     <- still missing on our side
//     40 04         2      2
//
// So EOC is done; the remaining todos below are the MT/ND/WRITE items, and the
// `40 02` column is the next thread to pull. See issue #40.
//
// So: these tests are the target, `test.todo` marks the ones we knowingly do not
// meet, and the failures are documented rather than pinned as expected.
//
// Reading the result bytes:
//   ST0 bits 7-6 = IC (00 normal, 01 abnormal), bit 2 = HD at interrupt time
//   ST1 bit 7 = EN (end of cylinder), bit 2 = ND (no data)
//   then C, H, R, N — where the chip stopped, per Intel's Table 4.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Upd765 } from './upd765.js';
import { buildD88, parseD88 } from './d88.js';

// A two-sided disk: cylinder 0 has sectors 1..3 on both heads, with distinct
// fill bytes so a transfer that crosses to the wrong side is visible in data as
// well as in the result ID.
const twoSided = () => parseD88(buildD88({
  name: 'MT', media: 0x00,
  tracks: [
    [1, 2, 3].map((r) => ({ c: 0, h: 0, r, n: 1, data: new Uint8Array(256).fill(0x10 | r) })),
    [1, 2, 3].map((r) => ({ c: 0, h: 1, r, n: 1, data: new Uint8Array(256).fill(0x20 | r) })),
  ],
}));

const cmd = (f, bytes) => { for (const b of bytes) f.write(b); };
const result = (f) => Array.from({ length: 7 }, () => f.read());

/**
 * Run a READ DATA and drain `bytes` of execution data, then the result phase.
 *
 * `settle` advances the mechanical clock after the transfer stops, which is what
 * closes the 200 µs TC window that EOT opens (see upd765.js `_execDone`). Pass it
 * when the test wants the window to expire; leave it off to inspect the chip while
 * the window is still open.
 */
function readData(f, { mt = 0, hd = 0, c = 0, h = 0, r = 1, n = 1, eot = 3, bytes = Infinity, tc = false, settle = 0 }) {
  const op = (mt ? 0x80 : 0) | 0x40 | 0x06; // MT | MFM | READ DATA
  cmd(f, [op, (hd << 2), c, h, r, n, eot, 0x0e, 0xff]);
  let got = 0;
  while (got < bytes && (f.readStatus() & 0x20)) { f.read(); got++; } // EXM set = still executing
  if (tc) f.tc(); // TC is gated on acceptTc, which outlives EXM by design
  if (settle) f.tick(settle);
  return { data: got, res: result(f) };
}

const IC = (st0) => (st0 >> 6) & 3;

test('MT=0: reaching EOT without TC is End of Cylinder, not a normal end', () => {
  // The transfer runs off the end of the cylinder because the host never
  // asserted TC. The specification calls that abnormal: IC=01 with ST1.EN.
  const f = new Upd765();
  f.eocTiming = true; // enabled by the board that owns the clock (machine88.js)
  f.insertDisk(0, twoSided());
  const { res } = readData(f, { mt: 0, hd: 0, r: 1, eot: 3, settle: 20 });
  assert.equal(IC(res[0]), 1, 'ST0.IC should be 01 (abnormal termination)');
  assert.equal(res[1] & 0x80, 0x80, 'ST1.EN should be set');
});

test('EOT opens a 200 µs window: a TC inside it still ends the command normally', () => {
  // This is the half that took three failed attempts to find. M88 parks on
  // `SetTimer(timerphase, 20)` at EOT and only calls it End of Cylinder if that
  // timer fires; a TC arriving first goes through tcphase and ends normally. The
  // PC-8801 sub ROM's 0300-series driver pulses TC exactly here, after seeing
  // EXM go low, so real loads must land on this path and not on EOC.
  const f = new Upd765();
  f.eocTiming = true;
  f.insertDisk(0, twoSided());
  const { res } = readData(f, { mt: 0, hd: 0, r: 1, eot: 3, tc: true, settle: 20 });
  assert.equal(IC(res[0]), 0, 'a TC inside the window ends normally');
  assert.equal(res[1] & 0x80, 0, 'ST1.EN must not be set');
  // ...and the post-command ID still reports where the chip stopped, which is
  // what the sub ROM's FAT walk reads to chain to the next cluster.
  assert.equal(res[5], 1, 'R wrapped to 1');
  assert.equal(res[3], 1, 'C advanced past the cylinder');
});

test('the EOT window is opt-in: a board with no clock keeps the old ending', () => {
  // upd765.js is shared with the X68000 board (x68fdd.js), which never calls
  // tick(). A window it cannot close would hang the command forever, so with
  // eocTiming off the chip ends the same way it always did.
  const f = new Upd765(); // eocTiming stays false
  f.insertDisk(0, twoSided());
  const { res } = readData(f, { mt: 0, hd: 0, r: 1, eot: 3 });
  assert.equal(IC(res[0]), 0, 'no window, no abnormal termination');
  assert.equal(res[1] & 0x80, 0, 'ST1.EN not set');
});

test('the EOT window is plain data: a mid-window save carries it as a string kind', () => {
  // The window is a timer, and machine88's `_snapFdc` carries timers as
  // `_timerAt` + `_timerKind` — a number and a string, no closures. Check the
  // pending window survives JSON, which is what a real snapshot goes through.
  const f = new Upd765();
  f.eocTiming = true;
  f.insertDisk(0, twoSided());
  const op = 0x40 | 0x06; // MFM | READ DATA
  cmd(f, [op, 0, 0, 0, 1, 1, 3, 0x0e, 0xff]);
  while (f.readStatus() & 0x20) f.read();
  assert.equal(f._timerKind, 'eoc', 'EOT should have opened the window');
  const carried = JSON.parse(JSON.stringify({ at: f._timerAt, kind: f._timerKind, now: f.now }));
  assert.equal(carried.kind, 'eoc');
  assert.equal(carried.at, f.now + 20, 'the window closes 20 ticks (200 µs) out');
  // ...and it really is the thing that produces EOC, not a bookkeeping field.
  f.tick(20);
  const res = result(f);
  assert.equal(IC(res[0]), 1);
  assert.equal(res[1] & 0x80, 0x80);
});

test('MT=0: TC before EOT ends normally and reports where it stopped', () => {
  const f = new Upd765();
  f.insertDisk(0, twoSided());
  // Stop part way through the second sector.
  const { res } = readData(f, { mt: 0, hd: 0, r: 1, eot: 3, bytes: 300, tc: true });
  assert.equal(IC(res[0]), 0, 'a TC-terminated read ends normally');
  assert.equal(res[1] & 0x80, 0, 'ST1.EN must not be set when TC ended it');
});

test('MT=1 from head 0: the transfer crosses to head 1', () => {
  const f = new Upd765();
  f.insertDisk(0, twoSided());
  // Six sectors exist across both sides; ask for more than one side holds.
  const { data } = readData(f, { mt: 1, hd: 0, r: 1, eot: 3, bytes: 256 * 6 });
  assert.equal(data, 256 * 6, 'MT should keep going onto head 1 (6 sectors total)');
});

test.todo('MT=1 from head 1 does NOT continue onto the next cylinder', () => {
  // MT covers the two sides of one cylinder. Starting on side 1 means the
  // command ends when side 1 is exhausted.
  const f = new Upd765();
  f.insertDisk(0, twoSided());
  const { data } = readData(f, { mt: 1, hd: 1, r: 1, eot: 3, bytes: 256 * 6 });
  assert.equal(data, 256 * 3, 'only the three sectors of side 1 should transfer');
});

test.todo('ST0.HD reports the head at interrupt time, not the last completed sector', () => {
  // Under MT the ID flips back to side 0 when the command ends, so ST0 and the
  // result H legitimately disagree — but ST0 must describe where the chip
  // actually was when it raised the interrupt.
  const f = new Upd765();
  f.insertDisk(0, twoSided());
  // TC one byte into side 1: interrupt happens on head 1.
  const { res } = readData(f, { mt: 1, hd: 0, r: 1, eot: 3, bytes: 256 * 3 + 1, tc: true });
  assert.equal((res[0] >> 2) & 1, 1, 'ST0.HD should be 1 — the transfer was on head 1');
});

test('a missing sector raises ND rather than ending normally', () => {
  // Ask for a record that is not on the track at all.
  const f = new Upd765();
  f.insertDisk(0, twoSided());
  const { res } = readData(f, { mt: 0, hd: 0, r: 9, eot: 9 });
  assert.equal(IC(res[0]), 1, 'ST0.IC should be 01');
  assert.equal(res[1] & 0x04, 0x04, 'ST1.ND should be set');
});

test.todo('MT=1: a missing record on side 1 still raises ND', () => {
  // Side 1 exists, but the sector the chip would cross to does not. Ending
  // "normally" here is what let a bad transfer look successful.
  const f = new Upd765();
  f.insertDisk(0, parseD88(buildD88({
    name: 'HALF', media: 0x00,
    tracks: [
      [1, 2, 3].map((r) => ({ c: 0, h: 0, r, n: 1, data: new Uint8Array(256).fill(r) })),
      [{ c: 0, h: 1, r: 7, n: 1, data: new Uint8Array(256).fill(0x77) }], // no R=1
    ],
  })));
  const { res } = readData(f, { mt: 1, hd: 0, r: 1, eot: 3, bytes: 256 * 6 });
  assert.equal(IC(res[0]), 1, 'crossing to a side without the record is abnormal');
  assert.equal(res[1] & 0x04, 0x04, 'ST1.ND should be set');
});

test.todo('WRITE DATA honours MT the same way READ does', () => {
  // Intel specifies MT/EN/ND and the result ID identically for WRITE.
  const f = new Upd765();
  f.insertDisk(0, twoSided());
  cmd(f, [0x80 | 0x40 | 0x05, 0x00, 0, 0, 1, 1, 3, 0x0e, 0xff]); // MT|MFM|WRITE DATA
  let wrote = 0;
  while (wrote < 256 * 6 && (f.readStatus() & 0x20)) { f.write(0xa5); wrote++; }
  assert.equal(wrote, 256 * 6, 'a write under MT should cross to head 1 as well');
});
