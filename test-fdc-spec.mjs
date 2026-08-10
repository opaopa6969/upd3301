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
// STATUS (2026-08-10): five of these fail against the current implementation,
// and that is deliberate — they are the specification, not a description of
// what we do. An attempt to satisfy them wholesale broke real titles: raising
// End of Cylinder at EOT made Ys1 and GAZZEL retry their first load forever
// (M88 returns ST0=00 for the same command), because the PC-8801 sub ROM only
// pulses TC *after* the MSR's EXM drops — a chip that self-terminates abnormally
// has already latched the status by then. Fixing this properly means modelling
// when TC is asserted, not flipping a status bit. See issue #40.
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

/** Run a READ DATA and drain `bytes` of execution data, then the result phase. */
function readData(f, { mt = 0, hd = 0, c = 0, h = 0, r = 1, n = 1, eot = 3, bytes = Infinity, tc = false }) {
  const op = (mt ? 0x80 : 0) | 0x40 | 0x06; // MT | MFM | READ DATA
  cmd(f, [op, (hd << 2), c, h, r, n, eot, 0x0e, 0xff]);
  let got = 0;
  while (got < bytes && (f.readStatus() & 0x20)) { f.read(); got++; } // EXM set = still executing
  if (tc && (f.readStatus() & 0x20)) f.tc();
  return { data: got, res: result(f) };
}

const IC = (st0) => (st0 >> 6) & 3;

test.todo('MT=0: reaching EOT without TC is End of Cylinder, not a normal end', () => {
  // The transfer runs off the end of the cylinder because the host never
  // asserted TC. The specification calls that abnormal: IC=01 with ST1.EN.
  const f = new Upd765();
  f.insertDisk(0, twoSided());
  const { res } = readData(f, { mt: 0, hd: 0, r: 1, eot: 3 });
  assert.equal(IC(res[0]), 1, 'ST0.IC should be 01 (abnormal termination)');
  assert.equal(res[1] & 0x80, 0x80, 'ST1.EN should be set');
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
