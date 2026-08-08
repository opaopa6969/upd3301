// test-fds — the Famicom Disk System: the image format, the drive, the
// wavetable channel, and the thing that matters most here — that a machine
// whose media can be WRITTEN still rewinds correctly.
//
// Every other machine in this repository has read-only media, so a snapshot
// could ignore it. A disk cannot be ignored: a game that saves changes the
// bytes under the head, and a rewind that does not put them back would let a
// player rewind past a save and keep it. So the disk tests below are as much
// about time travel as about the drive.
//
// No copyrighted disk and no BIOS is needed: buildFds() makes an image in
// memory and a hand-written 6502 program stands in for the BIOS. The real
// BIOS and the 192-disk sweep are in nestools/ (see docs/nes-design.md §12).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFds, tryParseFds, buildFds, isFds, exportFds, makeFdsCart,
  FdsDrive, FdsAudio, SIDE_SIZE, HEADER_SIZE, BYTE_CYCLES,
} from './fds.js';
import { NesMachine } from './machinenes.js';
import { createMapper, MIRROR } from './nesmapper.js';

// ---------------------------------------------------------------------------
// A stand-in BIOS. It only has to exist and carry vectors: the drive tests
// drive the registers themselves rather than asking a program to do it.
function stubBios(code = [], { at = 0xe100 } = {}) {
  const rom = new Uint8Array(8192);
  rom.set(code, at - 0xe000);
  rom[0x1ffa] = 0x00; rom[0x1ffb] = 0xe1;             // NMI
  rom[0x1ffc] = at & 0xff; rom[0x1ffd] = at >> 8;     // RESET
  rom[0x1ffe] = 0x00; rom[0x1fff] = 0xe1;             // IRQ
  return rom;
}

const twoFiles = () => buildFds({
  gameName: 'TST',
  sides: [
    [{ name: 'BOOTFILE', addr: 0x6000, data: Uint8Array.from({ length: 64 }, (_, i) => i) },
      { name: 'SECOND  ', addr: 0x7000, data: new Uint8Array(300) }],
    [{ name: 'SIDEB   ', addr: 0x6000, data: new Uint8Array(16) }],
  ],
});

// ---------------------------------------------------------------------------
// The image format

test('fds: a built image round-trips through the parser', () => {
  const img = parseFds(twoFiles());
  assert.equal(img.sideCount, 2);
  assert.equal(img.hasHeader, true);
  assert.equal(img.gameName, 'TST');
  assert.equal(img.info[0].files.length, 2);
  assert.equal(img.info[0].files[0].name.trim(), 'BOOTFILE');
  assert.equal(img.info[0].files[0].size, 64);
  assert.equal(img.info[1].files.length, 1);
  assert.deepEqual(img.warnings, []);
});

test('fds: a headerless image is recognised by its content, not its length alone', () => {
  const withHeader = twoFiles();
  const bare = withHeader.subarray(HEADER_SIZE);
  assert.equal(isFds(bare), true);
  const img = parseFds(bare);
  assert.equal(img.hasHeader, false);
  assert.equal(img.sideCount, 2);
  // Random bytes of the right length are not a disk.
  const junk = new Uint8Array(SIDE_SIZE);
  assert.equal(isFds(junk), false);
});

test('fds: a header that lies about the side count loses to the file length', () => {
  const bytes = twoFiles();
  bytes[4] = 4; // claims four sides, holds two
  const img = parseFds(bytes);
  assert.equal(img.sideCount, 2);
  assert.match(img.warnings.join(' '), /header says 4 sides/);
});

test('fds: junk is an answer, not an exception', () => {
  const r = tryParseFds(new Uint8Array(100));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too-short');
  const r2 = tryParseFds(new Uint8Array(SIDE_SIZE * 2));
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'no-disk-header');
});

test('fds: the physical stream is the stripped stream plus two CRC bytes per block', () => {
  const img = parseFds(twoFiles());
  const blocks = img.info[0].blocks.length;
  // 1 disk header + 1 file count + 2 blocks per file
  assert.equal(blocks, 2 + 2 * 2);
  assert.equal(img.physical[0].length, SIDE_SIZE + blocks * 2);
  // The first block still starts at 0; the second is pushed along by one CRC.
  assert.equal(img.physical[0][0], 0x01);
  assert.equal(img.physical[0][56], 0x00);      // CRC
  assert.equal(img.physical[0][57], 0x00);      // CRC
  assert.equal(img.physical[0][58], 0x02);      // file-count block
});

test('fds: exportFds is the inverse of the CRC insertion', () => {
  const src = twoFiles();
  const img = parseFds(src);
  const out = exportFds(img);
  assert.deepEqual(Array.from(out), Array.from(src));
});

// ---------------------------------------------------------------------------
// The drive

function poweredDrive() {
  const d = new FdsDrive(parseFds(twoFiles()));
  d.control(0x2f);          // motor on, transfer reset
  d.control(0x6d);          // motor on, reset released, read mode, rw start
  for (let i = 0; i < BYTE_CYCLES * 4; i++) d.tick();
  return d;
}

// Wait for the drive to say a byte slot is open, the way the BIOS's transfer
// loop does. Nothing moves through the head without one.
const waitSlot = (d, limit = BYTE_CYCLES * 4) => {
  for (let i = 0; i < limit && !d.byteReady; i++) d.tick();
  return d.byteReady;
};
const pushByte = (d, v) => { waitSlot(d); d.writeData(v); };

test('fds drive: reading walks the block stream one byte per access', () => {
  const d = poweredDrive();
  const got = [];
  for (let i = 0; i < 4; i++) { waitSlot(d); got.push(d.readData()); }
  assert.deepEqual(got, [0x01, 0x2a, 0x4e, 0x49]); // 01 "*NI..."
});

test('fds drive: reading $4031 with no byte pending returns the latch and does not move the head', () => {
  // The FDS BIOS does exactly this from its vblank-wait NMI handler, once a
  // frame, for as long as a game is waiting for the picture.
  const d = poweredDrive();
  waitSlot(d);
  const first = d.readData();
  const pos = d.pos;
  for (let i = 0; i < 5; i++) assert.equal(d.readData(), first, 'the latch holds');
  assert.equal(d.pos, pos, 'the head must not have moved');
  waitSlot(d);
  assert.notEqual(d.readData(), first);
});

test('fds drive: the transfer flag arrives on the byte clock, not immediately', () => {
  const d = poweredDrive();
  d.readData();
  assert.equal(d.transferFlag, false, 'the flag clears when the byte is taken');
  for (let c = 0; c < BYTE_CYCLES - 1; c++) d.tick();
  assert.equal(d.transferFlag, false, `flag must not be up before ${BYTE_CYCLES} cycles`);
  d.tick();
  assert.equal(d.transferFlag, true);
});

test('fds drive: the byte-transfer IRQ only fires when $4025 bit 7 asked for it', () => {
  const d = poweredDrive();
  d.readData();
  for (let c = 0; c < BYTE_CYCLES; c++) d.tick();
  assert.equal(d.diskIrq, false);
  d.control(0xed); // same as $6d plus IRQ-on-transfer
  d.readData();
  for (let c = 0; c < BYTE_CYCLES; c++) d.tick();
  assert.equal(d.diskIrq, true);
});

test('fds drive: transfer reset sends the head back to the start of the side', () => {
  const d = poweredDrive();
  for (let i = 0; i < 20; i++) { d.readData(); for (let c = 0; c < BYTE_CYCLES; c++) d.tick(); }
  assert.ok(d.pos >= 20);
  d.control(0x2f); // reset
  assert.equal(d.pos, 0);
  assert.equal(d.endOfDisk, false);
});

test('fds drive: with rw-start low the head does not move', () => {
  const d = poweredDrive();
  d.control(0x2d); // motor on, read, but bit 6 clear
  const before = d.pos;
  d.readData();
  assert.equal(d.pos, before);
});

test('fds drive: a write lands on the disk and is remembered as a difference', () => {
  const d = poweredDrive();
  d.control(0x2d);       // park the head at a block boundary first
  d.pos = 58;            // the file-count block (see the physical-stream test)
  d.control(0x69);       // motor on, WRITE mode, rw start
  assert.equal(d.writeSkip, 1, 'the start mark is not in a .fds image');
  pushByte(d, 0x80);     // the start mark: swallowed, and the head must NOT move
  assert.equal(d.writes.size, 0);
  assert.equal(d.pos, 58, 'the mark occupies no byte of the stream');
  pushByte(d, 0x5a);
  pushByte(d, 0x5b);
  assert.equal(d.writes.size, 2);
  assert.equal(d.data[58], 0x5a, 'the first real byte lands on the block ID');
  assert.equal(d.data[59], 0x5b);
  // The parsed image is untouched — it is the pristine reference a restore
  // rolls back to.
  assert.equal(d.image.physical[0][58], 0x02);
});

test('fds drive: ending a written block crosses the CRC the hardware emits', () => {
  // The BIOS pushes the first CRC byte through $4024 and raises bit 4; the
  // drive supplies the second. If the head does not cross it, the next block
  // starts one byte early and the BIOS's verify-after-write never passes.
  const d = poweredDrive();
  d.control(0x2d);
  d.pos = 58;
  d.control(0x69);
  pushByte(d, 0x80);
  pushByte(d, 0x02); pushByte(d, 0x09);  // the two bytes of the block
  pushByte(d, 0x00);                     // first CRC byte, pushed like data
  assert.equal(d.pos, 61);
  d.control(0x79);                       // + CRC control: the drive finishes it
  assert.equal(d.pos, 62, 'the head has to reach the start of the next block');
});

test('fds drive: a write-protected disk accepts the transfer and keeps its bytes', () => {
  const d = poweredDrive();
  d.writeProtected = true;
  d.control(0x69);
  pushByte(d, 0x00); pushByte(d, 0x99);
  assert.equal(d.writes.size, 0);
  assert.equal(d.data[1], 0x2a);
  assert.ok((d.driveStatus() & 0x04) !== 0, 'the protect bit has to be readable');
});

test('fds drive: $4032 reports "not ready" until the motor runs and the reset clears', () => {
  const d = new FdsDrive(parseFds(twoFiles()));
  assert.ok((d.driveStatus() & 0x02) !== 0);
  d.control(0x2f);
  assert.ok((d.driveStatus() & 0x02) !== 0, 'transfer reset still means not ready');
  d.control(0x6d);
  assert.equal(d.driveStatus() & 0x02, 0);
  assert.equal(d.driveStatus() & 0x01, 0, 'a disk is in the drive');
  d.eject();
  assert.ok((d.driveStatus() & 0x01) !== 0);
});

test('fds drive: the head reports the end of the side and stops', () => {
  const d = poweredDrive();
  d.pos = d.data.length - 1;
  d.readData();
  assert.equal(d.endOfDisk, true);
});

test('fds drive: state round-trips, including the bytes a save wrote', () => {
  const d = poweredDrive();
  d.control(0x69);
  pushByte(d, 0); pushByte(d, 0x11); pushByte(d, 0x22);
  const s = JSON.parse(JSON.stringify(d.getState(), (k, v) =>
    (ArrayBuffer.isView(v) ? Array.from(v) : v)));
  const after = d.data.slice();
  // Carry on writing, then roll back.
  pushByte(d, 0x33); pushByte(d, 0x44);
  assert.notDeepEqual(Array.from(d.data.subarray(0, 8)), Array.from(after.subarray(0, 8)));
  d.setState(s);
  assert.deepEqual(Array.from(d.data.subarray(0, 8)), Array.from(after.subarray(0, 8)));
  assert.equal(d.writes.size, 2);
});

// ---------------------------------------------------------------------------
// The adapter as a mapper

function fdsMachine(code = []) {
  const cart = makeFdsCart(parseFds(twoFiles()), stubBios(code));
  return new NesMachine({ cart });
}

test('fds adapter: the BIOS is at $E000 and 32KB of RAM is at $6000', () => {
  const m = fdsMachine();
  assert.equal(m.mapper.prgRam.length, 32768);
  m._write(0x6000, 0x12); m._write(0xdfff, 0x34);
  assert.equal(m._read(0x6000), 0x12);
  assert.equal(m._read(0xdfff), 0x34);
  assert.equal(m._read(0xfffc), 0x00); // reset vector low, from stubBios
  assert.equal(m._read(0xfffd), 0xe1);
});

test('fds adapter: the disk registers are dead until $4023 bit 0 is set', () => {
  const m = fdsMachine();
  m._write(0x4025, 0x6d);
  assert.equal(m.mapper.drive.motorOn, false);
  m._write(0x4023, 0x83);
  m._write(0x4025, 0x6d);
  assert.equal(m.mapper.drive.motorOn, true);
});

test('fds adapter: $4025 bit 3 is the only banking-like signal on the board', () => {
  const m = fdsMachine();
  m._write(0x4023, 0x83);
  m._write(0x4025, 0x2e);
  assert.equal(m.mapper.mirroring, MIRROR.HORIZONTAL);
  m._write(0x4025, 0x26);
  assert.equal(m.mapper.mirroring, MIRROR.VERTICAL);
});

test('fds adapter: the timer counts CPU cycles and raises IRQ, and $4030 acknowledges it', () => {
  const m = fdsMachine();
  const mp = m.mapper;
  m._write(0x4023, 0x83);
  m._write(0x4020, 100); m._write(0x4021, 0);
  m._write(0x4022, 0x02);                       // enable, one-shot
  for (let i = 0; i < 99; i++) mp.cpuCycle();
  assert.equal(mp.irq, false, 'must not fire early');
  mp.cpuCycle();
  assert.equal(mp.irq, true);
  assert.ok((mp._regRead(0x4030) & 0x01) !== 0, '$4030 bit 0 is the timer');
  assert.equal(mp.irq, false, 'reading $4030 acknowledges it');
  for (let i = 0; i < 200; i++) mp.cpuCycle();
  assert.equal(mp.irq, false, 'one-shot does not re-arm');
});

test('fds adapter: a repeating timer re-arms from the latch', () => {
  const m = fdsMachine();
  const mp = m.mapper;
  m._write(0x4023, 0x83);
  m._write(0x4020, 50); m._write(0x4021, 0);
  m._write(0x4022, 0x03);                       // enable + repeat
  let fires = 0;
  for (let i = 0; i < 500; i++) { mp.cpuCycle(); if (mp.timerIrq) { fires++; mp._regRead(0x4030); } }
  assert.equal(fires, 10);
});

test('fds adapter: clearing $4023 shuts every interrupt source up', () => {
  const m = fdsMachine();
  const mp = m.mapper;
  m._write(0x4023, 0x83);
  m._write(0x4020, 10); m._write(0x4021, 0); m._write(0x4022, 0x03);
  for (let i = 0; i < 20; i++) mp.cpuCycle();
  assert.equal(mp.irq, true);
  m._write(0x4023, 0x00);
  assert.equal(mp.irq, false);
  for (let i = 0; i < 100; i++) mp.cpuCycle();
  assert.equal(mp.irq, false);
});

test('fds adapter: a .nes claiming mapper 20 is refused with a reason, not a crash', async () => {
  const { tryCreateMapper } = await import('./nesmapper.js');
  const r = tryCreateMapper({ mapper: 20, prg: new Uint8Array(0x4000), chr: null, mirroring: 'horizontal' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'fds-needs-disk');
});

test('fds adapter: a BIOS of the wrong size is refused', () => {
  assert.throws(() => makeFdsCart(parseFds(twoFiles()), new Uint8Array(4096)), /8192 bytes/);
});

// ---------------------------------------------------------------------------
// The sound channel

test('fds audio: wave RAM only accepts writes while $4089 bit 7 is set', () => {
  const a = new FdsAudio();
  a.write(0x4040, 0x3f);
  assert.equal(a.wave[0], 0);
  a.write(0x4089, 0x80);
  a.write(0x4040, 0x3f);
  assert.equal(a.wave[0], 0x3f);
});

test('fds audio: the wave pointer advances at the programmed rate', () => {
  const a = new FdsAudio();
  a.write(0x4089, 0x80);
  for (let i = 0; i < 64; i++) a.write(0x4040 + i, i);
  a.write(0x4089, 0x00);          // disconnect wave RAM, connect the DAC
  a.write(0x4080, 0xa0);          // envelope off, gain 32
  a.write(0x4082, 0x00);
  a.write(0x4083, 0x04);          // freq = $400, not halted
  // 0x10000 / 0x400 = 64 cycles per step.
  for (let i = 0; i < 64; i++) a.tick();
  assert.equal(a.wavePos, 1);
  for (let i = 0; i < 64 * 63; i++) a.tick();
  assert.equal(a.wavePos, 0, 'the table wraps at 64 steps');
});

test('fds audio: the modulator bends the pitch and the bend is not symmetric', () => {
  const a = new FdsAudio();
  a.write(0x4083, 0x00);
  a.write(0x4082, 0x00);
  a.freq = 0x400;
  // A gain and a counter whose product leaves a remainder — that is the only
  // case in which the rounding step does anything at all.
  a.modGain = 17;
  a.modCounter = 7;
  const up = a._pitchOffset();
  a.modCounter = -7;
  const down = a._pitchOffset();
  assert.ok(up > 0 && down < 0);
  assert.notEqual(up, -down, 'the +2/-1 rounding step makes the bend lean sharp');
  // With no remainder the two directions do match, which is what makes the
  // asymmetry a rounding artefact rather than a scaling one.
  a.modGain = 16; a.modCounter = 8;
  const evenUp = a._pitchOffset();
  a.modCounter = -8;
  assert.equal(a._pitchOffset(), -evenUp);
});

test('fds audio: halting the channel parks the phase', () => {
  const a = new FdsAudio();
  a.write(0x4083, 0x04);
  a.write(0x4082, 0xff);
  for (let i = 0; i < 500; i++) a.tick();
  assert.ok(a.wavePos > 0);
  a.write(0x4083, 0x84); // bit 7 = halt
  assert.equal(a.wavePos, 0);
  for (let i = 0; i < 500; i++) a.tick();
  assert.equal(a.wavePos, 0);
});

test('fds audio: state round-trips and the sample stream continues identically', () => {
  const a = new FdsAudio();
  a.write(0x4089, 0x80);
  for (let i = 0; i < 64; i++) a.write(0x4040 + i, (i * 7) & 0x3f);
  a.write(0x4089, 0x02);
  a.write(0x4080, 0xbf);
  a.write(0x4082, 0x33); a.write(0x4083, 0x02);
  a.write(0x4086, 0x11); a.write(0x4087, 0x00);
  a.write(0x4084, 0x9f);
  for (let i = 0; i < 3000; i++) a.tick();
  const s = a.getState();
  const first = [];
  for (let i = 0; i < 2000; i++) { a.tick(); first.push(a.output); }
  const b = new FdsAudio();
  b.setState(JSON.parse(JSON.stringify(s, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v))));
  const second = [];
  for (let i = 0; i < 2000; i++) { b.tick(); second.push(b.output); }
  assert.deepEqual(second, first);
});

test('fds audio: the channel reaches the APU mixer', () => {
  const m = fdsMachine();
  assert.equal(m.apu.expansion, m.mapper.audio);
  const silent = m.apu.mix();
  m.mapper.audio.write(0x4089, 0x80);
  for (let i = 0; i < 64; i++) m.mapper.audio.write(0x4040 + i, 0x3f);
  m.mapper.audio.write(0x4089, 0x00);
  m.mapper.audio.write(0x4080, 0xa0);
  m.mapper.audio.tick();
  assert.ok(m.apu.mix() > silent, 'the expansion channel has to be audible in the mix');
});

// ---------------------------------------------------------------------------
// Determinism and time travel — the reason this machine exists
//
// A tiny "BIOS" that spins the drive and copies what it reads into RAM. It
// exercises the whole chain (registers, byte clock, IRQ, head position) with
// no dependence on the real BIOS, and it makes the disk state part of the
// machine state in a way a snapshot has to survive.
const READER = [
  0xa9, 0x83, 0x8d, 0x23, 0x40,       // LDA #$83 : STA $4023
  0xa9, 0x2f, 0x8d, 0x25, 0x40,       // LDA #$2f : STA $4025   (motor, reset)
  0xa9, 0x6d, 0x8d, 0x25, 0x40,       // LDA #$6d : STA $4025   (go, read)
  0xa2, 0x00,                         // LDX #0
  // loop: wait for the transfer flag, then take the byte
  0xad, 0x30, 0x40,                   // LDA $4030
  0x29, 0x02,                         // AND #2
  0xf0, 0xf9,                         // BEQ loop
  0xad, 0x31, 0x40,                   // LDA $4031
  0x9d, 0x00, 0x60,                   // STA $6000,X
  0xe8,                               // INX
  0xe0, 0x40,                         // CPX #$40   (stop after 64 bytes so the
  0xd0, 0xee,                         // BNE loop    index cannot wrap and
  0x4c, 0x23, 0xe1,                   // JMP *       overwrite what it read)
];

// The same thing without the stop: it keeps the drive turning for as long as
// the machine runs, which is what the time-travel tests need — a machine that
// has stopped moving proves nothing about restoring one that has not.
const READER_FOREVER = READER.slice(0, -7).concat([0x4c, 0x11, 0xe1]);

test('fds machine: the same disk and the same program give the same state twice', () => {
  const a = fdsMachine(READER_FOREVER), b = fdsMachine(READER_FOREVER);
  for (let i = 0; i < 30; i++) { a.stepFrame(); b.stepFrame(); }
  assert.equal(a.cpu.pc, b.cpu.pc);
  assert.equal(a.disk.pos, b.disk.pos);
  assert.deepEqual(Array.from(a.mapper.prgRam.subarray(0, 256)), Array.from(b.mapper.prgRam.subarray(0, 256)));
});

test('fds machine: the drive reads the disk header into RAM through the CPU', () => {
  const m = fdsMachine(READER);
  for (let i = 0; i < 30; i++) m.stepFrame();
  const ram = m.mapper.prgRam;
  assert.equal(ram[0], 0x01);
  assert.equal(String.fromCharCode(...ram.subarray(1, 15)), '*NINTENDO-HVC*');
});

test('fds machine: snapshot -> run on -> restore -> replay lands in the same place', () => {
  const m = fdsMachine(READER_FOREVER);
  for (let i = 0; i < 10; i++) m.stepFrame();
  const snap = m.snapshot();
  for (let i = 0; i < 20; i++) m.stepFrame();
  const want = { pc: m.cpu.pc, pos: m.disk.pos, ram: Array.from(m.mapper.prgRam.subarray(0, 128)) };
  m.restore(snap);
  assert.equal(m.frame, 10);
  for (let i = 0; i < 20; i++) m.stepFrame();
  assert.equal(m.cpu.pc, want.pc);
  assert.equal(m.disk.pos, want.pos);
  assert.deepEqual(Array.from(m.mapper.prgRam.subarray(0, 128)), want.ram);
});

test('fds machine: rewinding past a disk WRITE puts the disk back', () => {
  // The case no cartridge machine has. Write two bytes to the disk, snapshot,
  // write two more, then rewind: the last two must be gone and the first two
  // must still be there.
  const m = fdsMachine();
  const d = m.disk;
  m._write(0x4023, 0x83);
  m._write(0x4025, 0x2f);
  m._write(0x4025, 0x69); // write mode, rw start
  const push = (v) => { for (let i = 0; i < BYTE_CYCLES * 4 && !d.byteReady; i++) d.tick(); d.writeData(v); };
  push(0x80);             // start mark, swallowed
  push(0xa1); push(0xa2);
  const snap = m.snapshot();
  const posAt = d.pos;
  push(0xb1); push(0xb2);
  assert.equal(d.data[2], 0xb1);
  m.restore(snap);
  assert.equal(d.pos, posAt);
  assert.equal(d.data[0], 0xa1, 'the write BEFORE the snapshot survives');
  assert.equal(d.data[1], 0xa2);
  assert.equal(d.data[2], m.cart.disk.physical[0][2], 'the write AFTER it is undone');
  assert.equal(d.writes.size, 2);
});

test('fds machine: a snapshot does not carry the disk image', () => {
  const m = fdsMachine(READER_FOREVER);
  for (let i = 0; i < 20; i++) m.stepFrame();
  const s = m.snapshot();
  const size = JSON.stringify(s, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)).length;
  // The adapter's own 32KB of RAM and 8KB of CHR-RAM dominate; the 131000-byte
  // two-sided disk must not be in there at all.
  assert.ok(size < 400000, `snapshot serialises to ${size} bytes`);
  assert.equal(s.mapper.drive.writeOffs.length, 0);
});

test('fds machine: turning the disk over looks like an eject to the program', () => {
  const m = fdsMachine();
  assert.equal(m.hasDisk, true);
  assert.equal(m.diskSides, 2);
  m.setDiskSide(1, { ejectFrames: 0 });
  assert.equal(m.diskSide, 1);
  assert.equal(m.disk.pos, 0);
  m.ejectDisk();
  assert.ok((m.mapper._regRead(0x4032) & 0x01) !== 0, 'no disk means bit 0 set');
});

test('host contract: fast-forward and rewind work on a machine with a drive', () => {
  // The headless stand-in for demo/machine.html's transport, run against the
  // one machine whose media can change under it. test-nes.mjs proves the
  // transport works for a cartridge; this proves the drive does not break it.
  const REWIND_EVERY = 6;
  const m = fdsMachine(READER_FOREVER);
  assert.ok(m.frameHz > 59 && m.frameHz < 61);

  const history = [];
  let lastSnapFrame = -1;
  const tick = (dt, speed = 1) => {
    m.update(Math.min(dt * speed, 0.5));
    if (m.frame - lastSnapFrame >= REWIND_EVERY) {
      lastSnapFrame = m.frame;
      history.push({ snap: m.snapshot(), frame: m.frame, pos: m.disk.pos });
    }
  };
  for (let i = 0; i < 60; i++) tick(1 / 60);
  assert.ok(m.frame >= 59 && m.frame <= 61, `one second of dt gave ${m.frame} frames`);
  assert.ok(m.disk.pos > 100, 'the drive should have moved during that second');

  const before = m.frame;
  for (let i = 0; i < 10; i++) tick(1 / 60, 4);
  assert.ok(m.frame - before >= 38, `x4 covered only ${m.frame - before} frames`);

  // Rewind: the head has to go back with everything else, or the next read
  // returns a byte from the future.
  const target = history[history.length - 3];
  m.restore(target.snap);
  assert.equal(m.frame, target.frame);
  assert.equal(m.disk.pos, target.pos, 'the head is part of the state');
  const fp = () => JSON.stringify(m.snapshot(), (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
  for (let i = 0; i < 5; i++) m.stepFrame();
  const forward = fp();
  m.restore(target.snap);
  for (let i = 0; i < 5; i++) m.stepFrame();
  assert.equal(fp(), forward, 'replay from a restored point has to be identical');
});

test('fds machine: mapper 20 state survives a round trip through plain JSON', () => {
  const m = fdsMachine(READER_FOREVER);
  for (let i = 0; i < 25; i++) m.stepFrame();
  const s = JSON.parse(JSON.stringify(m.snapshot(), (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)));
  const m2 = fdsMachine(READER_FOREVER);
  m2.restore(s);
  for (let i = 0; i < 15; i++) { m.stepFrame(); m2.stepFrame(); }
  assert.equal(m2.cpu.pc, m.cpu.pc);
  assert.equal(m2.disk.pos, m.disk.pos);
  assert.equal(m2.mapper.audio.wavePos, m.mapper.audio.wavePos);
});
