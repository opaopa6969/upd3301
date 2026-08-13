// test-fdc-msr — the µPD765's main status register, on its own.
//
// Why this file exists as a separate, ROM-free suite: three attempts at the
// FDC execution timers were reverted (issue #13) and all three failed for the
// same reason — the MSR was DERIVED from `phase`, so it could only ever say
// "ready". Every timer needs the opposite: a status word that says "busy" and
// keeps saying it across polls, with the data port inert while it does.
//
// M88 gets that by keeping `status` as a plain variable:
//
//     uint FDC::Status(uint) { return seekstate | status; }
//
//     void FDC::SetData(uint, uint d) {
//         if ((status & (S_RQM | S_DIO)) == S_RQM) {   // else: NOTHING happens
//             data = d; status &= ~S_RQM; ...
//
// So these tests check two things the 353-title sweep cannot: that the MSR is
// a variable (poke `phase` and the MSR does not move) and that an access made
// while RQM is low has no effect whatsoever. Both are contracts the timers
// stand on; a regression here is invisible in a boot fingerprint until some
// title spins forever.
//
// No ROMs, no disk images from the library — a three-sector D88 built in RAM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Upd765 } from './upd765.js';
import { buildD88, parseD88 } from './d88.js';

const RQM = 0x80, DIO = 0x40, EXM = 0x20, CB = 0x10;

const makeDisk = () => parseD88(buildD88({
  name: 'MSR', media: 0x00,
  tracks: [
    [1, 2, 3].map((r) => ({ c: 0, h: 0, r, n: 1, data: new Uint8Array(256).fill(r * 0x11) })),
  ],
}));

const READ_R1 = [0x46, 0x00, 0, 0, 1, 1, 3, 0x0e, 0xff]; // READ DATA C0 H0 R1 N1 EOT3
const cmd = (f, bytes) => { for (const b of bytes) f.write(b); };

// ---- the MSR is a variable, not a function of `phase` -------------------------

test('MSR: readStatus() returns the status variable, never a phase lookup', () => {
  const f = new Upd765();
  assert.equal(f.readStatus(), RQM); // idle: ready for a command, not busy

  // Poke `phase` behind the register's back. The old derived MSR would have
  // reported a full execution phase here; the variable must not care.
  f.phase = 'execute';
  f.execWrite = false;
  assert.equal(f.readStatus(), RQM, 'phase is bookkeeping — the MSR is state');

  // And the other way round: move the variable, leave the phase alone.
  f.status = CB;
  assert.equal(f.readStatus(), CB, 'busy with nothing to transfer');
});

test('MSR: seekstate ORs the per-drive busy bits in (M88 `seekstate | status`)', () => {
  const f = new Upd765();
  f.seekBusy = 0x03; // drives 0 and 1 stepping
  assert.equal(f.readStatus(), RQM | 0x03);
  f.seekBusy = 0;
  assert.equal(f.readStatus(), RQM);
});

// ---- an access made while RQM is low does nothing ------------------------------

test('MSR: a write with RQM low is swallowed whole — no byte, no state change', () => {
  const f = new Upd765();
  f.insertDisk(0, makeDisk());
  f.write(0x46); // READ DATA opcode → command phase, 8 parameters to go
  assert.equal(f.readStatus(), RQM | CB);
  assert.equal(f.cmd.length, 1);

  // This is the state a pending execution timer leaves behind: busy, not ready.
  f.status &= ~RQM;
  f.write(0x99);
  assert.equal(f.cmd.length, 1, 'the parameter was NOT appended');
  assert.equal(f.readStatus(), CB, 'and the status word did not move either');

  // Attempt #3 at the read timer died exactly here: without the guard the
  // driver's *data* bytes landed in the command stream and 02A8h span 406,610
  // times. Raising RQM again resumes the command as if nothing happened.
  f.status |= RQM;
  f.write(0x00);
  assert.equal(f.cmd.length, 2);
});

test('MSR: a write with DIO high (chip wants to be read) is swallowed too', () => {
  const f = new Upd765();
  f.insertDisk(0, makeDisk());
  cmd(f, [0x08]); // SENSE INTERRUPT STATUS with nothing pending → result phase
  assert.equal(f.readStatus(), RQM | DIO | CB);
  f.write(0x46);
  assert.equal(f.phase, 'result', 'the command byte never reached the chip');
  assert.equal(f.readStatus(), RQM | DIO | CB);
});

test('MSR: a read with RQM low yields nothing and does not advance the buffer', () => {
  const f = new Upd765();
  f.insertDisk(0, makeDisk());
  cmd(f, READ_R1);
  assert.equal(f.readStatus(), RQM | DIO | EXM | CB);
  assert.equal(f.read(), 0x11);

  f.status &= ~RQM; // as if an inter-sector timer were pending
  assert.equal(f.read(), 0xff, 'inert port');
  assert.equal(f.read(), 0xff);
  assert.equal(f.execPos, 1, 'and the transfer pointer stayed where it was');

  f.status |= RQM;
  assert.equal(f.read(), 0x11, 'the next real byte, not a skipped one');
  assert.equal(f.execPos, 2);
});

test('MSR: a read with DIO low (chip wants to be written) is inert', () => {
  const f = new Upd765();
  f.insertDisk(0, makeDisk());
  f.write(0x46);
  assert.equal(f.readStatus() & DIO, 0);
  assert.equal(f.read(), 0xff);
  assert.equal(f.cmd.length, 1, 'and reading did not disturb the command phase');
});

// ---- RQM is dropped and re-raised once per byte --------------------------------

test('MSR: every transferred byte clears RQM; whoever wants another raises it', () => {
  const f = new Upd765();
  f.insertDisk(0, makeDisk());
  for (let i = 0; i < READ_R1.length - 1; i++) { // opcode + seven of eight parameters
    f.write(READ_R1[i]);
    assert.equal(f.readStatus(), RQM | CB, `byte ${i}: still asking for more`);
  }
  // Nothing re-raises RQM after the *last* parameter byte — the command itself
  // decides what the MSR says next. With no timer that is immediate; with the
  // `250 << n` timer it is 5 ms of CB-only, which is the whole point.
  f.write(READ_R1[READ_R1.length - 1]);
  assert.equal(f.readStatus(), RQM | DIO | EXM | CB, 'execution phase, FDC→CPU');
});

test('MSR: the result phase walks RQM down and up per byte, then idles', () => {
  const f = new Upd765();
  f.insertDisk(0, makeDisk());
  cmd(f, [0x46, 0x00, 0, 0, 9, 1, 9, 0x0e, 0xff]); // R=9 missing → straight to result
  for (let i = 0; i < 6; i++) {
    f.read();
    assert.equal(f.readStatus(), RQM | DIO | CB, `result byte ${i}: more to come`);
  }
  f.read(); // the seventh and last
  assert.equal(f.readStatus(), RQM, 'idle: CB and DIO both gone');
  assert.equal(f.phase, 'idle');
});

test('MSR: EXM drops when the last byte of a transfer leaves the chip', () => {
  const f = new Upd765();
  f.insertDisk(0, makeDisk());
  cmd(f, READ_R1);
  for (let i = 0; i < 255; i++) f.read();
  assert.equal(f.readStatus() & EXM, EXM, 'one byte still to go');
  f.read();
  // R1 was not EOT, so the command carries on into sector 2 and the execution
  // phase re-arms in the same breath. EXM never observably falls without a
  // timer — that is precisely why the sweep numbers must not move yet.
  assert.equal(f.readStatus(), RQM | DIO | EXM | CB);
  assert.equal(f.read(), 0x22, 'sector 2');
});

// ---- TC is gated on `accepttc`, not on the phase name --------------------------

test('MSR: TC only bites during a transfer (M88 `accepttc`)', () => {
  const f = new Upd765();
  f.insertDisk(0, makeDisk());
  f.tc(); // idle: no command in flight
  assert.equal(f.phase, 'idle', 'a stray TC pulse is not a command');

  cmd(f, READ_R1);
  f.read(); f.read();
  assert.equal(f.acceptTc, true);
  f.tc();
  assert.equal(f.phase, 'result');
  assert.equal(f.acceptTc, false, 'and it is a one-shot');
});

// ---- the status word survives a snapshot ---------------------------------------

// ---- what the MSR is FOR: the mechanical timers ---------------------------------
// These are off by default (the X68000 board shares this chip and has no clock),
// so each test opts in the way machine88.js does.

test('timers: a seek keeps the drive busy in the MSR and its interrupt pending', () => {
  const f = new Upd765();
  f.seekTiming = true;
  f.insertDisk(0, makeDisk());
  cmd(f, [0x0f, 0x00, 10]); // SEEK unit 0 → cylinder 10
  assert.equal(f.readStatus(), RQM | 0x01, 'MSR D0B: drive 0 is stepping');
  assert.equal(f.intLine, false, 'the head has not arrived, so no seek-end INT');

  // 400 x steps + 500, and `steps` is 96-TPI half-tracks: 10 cylinders is 20.
  f.tick(8499);
  assert.equal(f.intLine, false, 'one tick short');
  f.tick(1);
  assert.equal(f.intLine, true);
  assert.equal(f.readStatus(), RQM, 'and D0B clears when the head lands');

  cmd(f, [0x08]); // SENSE INTERRUPT STATUS
  assert.equal(f.read() & 0xc0, 0x00, 'normal termination');
  assert.equal(f.read(), 10);
});

test('timers: SENSE INTERRUPT STATUS does not see a seek still in flight', () => {
  const f = new Upd765();
  f.seekTiming = true;
  cmd(f, [0x0f, 0x00, 5]);
  cmd(f, [0x08]);
  assert.equal(f.read(), 0x80, 'ST0 = invalid command: nothing is pending yet');
  f.read();
  f.tick(4500); // 400 x 10 + 500
  cmd(f, [0x08]);
  assert.equal(f.read() & 0xc0, 0x00, 'now it is');
});

test('timers: a zero-distance seek still costs the chip 10 ticks', () => {
  const f = new Upd765();
  f.seekTiming = true;
  cmd(f, [0x0f, 0x00, 0]); // already at cylinder 0
  assert.equal(f.intLine, false);
  f.tick(10);
  assert.equal(f.intLine, true);
});

test('timers: READ DATA goes quiet for `250 << n` before the first byte', () => {
  const f = new Upd765();
  f.readTiming = true;
  f.insertDisk(0, makeDisk());
  cmd(f, READ_R1);
  // This is the state that could not be expressed before the MSR became a
  // variable: a command accepted, the chip busy, and NOTHING readable.
  assert.equal(f.readStatus(), CB, 'CB alone — no RQM, no DIO, no EXM');
  assert.equal(f.int, false, 'and no interrupt, so the sub ROM stays in HALT');
  assert.equal(f.read(), 0xff);

  // A write here is the exact shape of failure #3: the driver's data bytes
  // reaching a chip parked in the command phase. The guard eats them.
  f.write(0x12);
  assert.equal(f.cmd.length, 9, 'the command did not grow');

  f.tick(499);
  assert.equal(f.readStatus(), CB, 'n=1 → 250 << 1 = 500 ticks = 5 ms');
  f.tick(1);
  assert.equal(f.readStatus(), RQM | DIO | EXM | CB);
  assert.equal(f.int, true, 'and NOW the interrupt that wakes the driver');
  assert.equal(f.read(), 0x11);
});

test('timers: the same wait happens again between sectors', () => {
  const f = new Upd765();
  f.readTiming = true;
  f.insertDisk(0, makeDisk());
  cmd(f, READ_R1);
  f.tick(500);
  for (let i = 0; i < 256; i++) f.read(); // all of sector 1

  assert.equal(f.readStatus(), DIO | CB, 'transfer visibly stopped: EXM and RQM down');
  assert.equal(f.int, false);
  assert.equal(f.read(), 0xff, 'nothing to read across the gap');
  f.tick(500);
  assert.equal(f.readStatus(), RQM | DIO | EXM | CB);
  assert.equal(f.read(), 0x22, 'sector 2, not a repeat and not garbage');
});

test('timers: TC during the inter-sector gap still ends the command', () => {
  const f = new Upd765();
  f.readTiming = true;
  f.insertDisk(0, makeDisk());
  cmd(f, READ_R1);
  f.tick(500);
  for (let i = 0; i < 256; i++) f.read();
  // M88 leaves `accepttc` up across the gap — it is only the phase shifts to
  // idle/command/result that clear it. This is why tc() cannot test `phase`.
  assert.equal(f.acceptTc, true);
  f.tc();
  assert.equal(f.readStatus(), RQM | DIO | CB, 'result phase');
  assert.equal(f.read() & 0xc0, 0, 'normal termination');
  f.tick(10_000);
  assert.equal(f.phase, 'result', 'and the cancelled timer does not fire late');
});

test('timers: with the flags off nothing waits — the X68000 board still works', () => {
  const f = new Upd765(); // no seekTiming, no readTiming, no tick() anywhere
  f.insertDisk(0, makeDisk());
  cmd(f, [0x0f, 0x00, 40]);
  assert.equal(f.intLine, true, 'seek completes at once');
  assert.equal(f.readStatus(), RQM, 'and never reports a busy drive');
  cmd(f, [0x08]); f.read(); f.read();
  f.drives[0].cyl = 0;
  cmd(f, READ_R1);
  assert.equal(f.readStatus(), RQM | DIO | EXM | CB, 'and a read starts immediately');
  assert.equal(f.read(), 0x11);
});

test('MSR: _statusFromPhase rebuilds pre-variable snapshots', () => {
  const f = new Upd765();
  f.insertDisk(0, makeDisk());
  cmd(f, READ_R1);
  const live = f.readStatus();
  // An old snapshot carried `phase` and nothing else; restoring it left the
  // status word at the constructor's idle value and every read returned 0xff.
  f.status = RQM;
  f._statusFromPhase();
  assert.equal(f.readStatus(), live);
  assert.equal(f.read(), 0x11);
});
