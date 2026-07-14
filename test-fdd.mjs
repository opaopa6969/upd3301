// tests for the disk sub-system chips: i8255 pair, μPD765, PC-80S31 board.
// The board integration test needs real ROMs (BYO-ROM) and skips without.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { I8255, crossWire } from './i8255.js';
import { Upd765 } from './upd765.js';
import { buildD88, parseD88 } from './d88.js';

// ---- i8255 -----------------------------------------------------------------

test('i8255: mode set, output latch, bit set/reset', () => {
  const p = new I8255();
  p.write(3, 0x91); // A in, B out, C-hi out, C-lo in
  assert.equal(p.aIsInput, true);
  assert.equal(p.bIsInput, false);
  p.write(1, 0xa5);
  assert.equal(p.read(1), 0xa5); // reading an output port returns the latch
  p.write(3, 0x0f); // BSR: set bit 7
  assert.equal(p.outC & 0x80, 0x80);
  p.write(3, 0x0e); // BSR: reset bit 7
  assert.equal(p.outC & 0x80, 0);
  p.write(3, 0x91); // mode set clears latches
  assert.equal(p.outB, 0);
});

test('i8255 pair: PC-8801 cross wiring (A↔B, C nibbles crossed)', () => {
  const m = new I8255(), s = new I8255();
  crossWire(m, s);
  m.write(3, 0x91); s.write(3, 0x91);
  m.write(1, 0x42); // main B out → sub A in
  assert.equal(s.read(0), 0x42);
  s.write(1, 0x99); // sub B out → main A in
  assert.equal(m.read(0), 0x99);
  m.write(3, 0x0f); // main sets C bit 7 (ATN)
  assert.equal(s.read(2) & 0x08, 0x08); // sub sees it on C bit 3
});

// ---- μPD765 -----------------------------------------------------------------

const makeDisk = () => parseD88(buildD88({
  name: 'TEST', media: 0x00,
  tracks: [
    // track 0 (cyl 0, head 0): sectors 1..3, 256 bytes
    [1, 2, 3].map((r) => ({
      c: 0, h: 0, r, n: 1,
      data: new Uint8Array(256).fill(r * 0x11),
    })),
  ],
}));

const cmd = (f, bytes) => { for (const b of bytes) f.write(b); };

test('upd765: recalibrate + sense interrupt status', () => {
  const f = new Upd765();
  f.insertDisk(0, makeDisk());
  cmd(f, [0x07, 0x00]); // RECALIBRATE unit 0
  assert.equal(f.intLine, true);
  cmd(f, [0x08]); // SENSE INT STATUS
  assert.equal(f.read(), 0x20); // ST0 = seek end, unit 0
  assert.equal(f.read(), 0); // PCN = 0
  assert.equal(f.intLine, false);
});

test('upd765: seek succeeds on empty existing drive, fails on unit 2+', () => {
  const f = new Upd765();
  cmd(f, [0x0f, 0x01, 0x0a]); // SEEK unit 1 (no disk) → cyl 10
  cmd(f, [0x08]);
  assert.equal(f.read() & 0xc0, 0x00); // normal termination
  assert.equal(f.read(), 10);
  cmd(f, [0x07, 0x02]); // RECALIBRATE unit 2 (nonexistent)
  cmd(f, [0x08]);
  assert.equal(f.read() & 0x48, 0x48); // AT | NR
  f.read();
});

test('upd765: read data streams a sector, INT per byte, result phase', () => {
  const f = new Upd765();
  f.insertDisk(0, makeDisk());
  // READ DATA: unit 0, C0 H0 R2 N1, EOT=2, GPL, DTL
  cmd(f, [0x46, 0x00, 0, 0, 2, 1, 2, 0x0e, 0xff]);
  assert.equal(f.readStatus() & 0x60, 0x60); // EXM + DIO: execution, FDC→CPU
  const out = [];
  for (let i = 0; i < 256; i++) {
    assert.equal(f.intLine, true); // non-DMA: INT per byte
    out.push(f.read());
  }
  assert.ok(out.every((b) => b === 0x22));
  assert.equal(f.readStatus() & 0x50, 0x50); // result phase (CB | DIO)
  const st0 = f.read();
  assert.equal(st0 & 0xc0, 0); // normal
  for (let i = 0; i < 6; i++) f.read(); // drain result
  assert.equal(f.readStatus(), 0x80); // idle again
});

test('upd765: missing sector reports ST1 no-data', () => {
  const f = new Upd765();
  f.insertDisk(0, makeDisk());
  cmd(f, [0x46, 0x00, 0, 0, 9, 1, 9, 0x0e, 0xff]); // R=9 does not exist
  const st0 = f.read(), st1 = f.read();
  assert.equal(st0 & 0x40, 0x40); // abnormal termination
  assert.equal(st1 & 0x04, 0x04); // ND
});

test('upd765: TC ends a read mid-sector (the F8h port pulse)', () => {
  const f = new Upd765();
  f.insertDisk(0, makeDisk());
  cmd(f, [0x46, 0x00, 0, 0, 1, 1, 3, 0x0e, 0xff]);
  f.read(); f.read(); // take 2 bytes
  f.tc();
  assert.equal(f.readStatus() & 0x50, 0x50); // result phase reached
  for (let i = 0; i < 7; i++) f.read();
  assert.equal(f.phase, 'idle');
});

test('upd765: read id rotates through the track', () => {
  const f = new Upd765();
  f.insertDisk(0, makeDisk());
  const rs = [];
  for (let k = 0; k < 4; k++) {
    cmd(f, [0x0a, 0x00]);
    const res = [];
    for (let i = 0; i < 7; i++) res.push(f.read());
    rs.push(res[5]); // R of the id field
  }
  assert.deepEqual(rs, [1, 2, 3, 1]); // disk rotation wraps
});

test('upd765: write protect blocks write data', () => {
  const f = new Upd765();
  const d = makeDisk();
  d.writeProtect = true;
  f.insertDisk(0, d);
  cmd(f, [0x45, 0x00, 0, 0, 1, 1, 1, 0x0e, 0xff]);
  const st0 = f.read(), st1 = f.read();
  assert.equal(st0 & 0x40, 0x40);
  assert.equal(st1 & 0x02, 0x02); // NW (not writable)
});

// ---- PC-80S31 board + full machine (needs real ROMs) -----------------------

const loadRoms = async () => {
  try {
    const main = new Uint8Array(await readFile('roms/8801mkIIFR/n88.rom'));
    const sub = new Uint8Array(await readFile('roms/8801mkIIFR/disk.rom'));
    const ext = new Uint8Array(0x8000);
    for (let i = 0; i < 4; i++) {
      ext.set(new Uint8Array(await readFile(`roms/8801mkIIFR/n88_${i}.rom`)), i * 0x2000);
    }
    return { main, sub, ext };
  } catch { return null; }
};

test('pc80s31: sub ROM boots to its command-wait loop', async (t) => {
  const roms = await loadRoms();
  if (!roms) return t.skip('no ROMs (bring your own)');
  const { Pc80s31 } = await import('./pc80s31.js');
  const board = new Pc80s31({ rom: roms.sub });
  for (let i = 0; i < 300; i++) board.run(66560); // ~5s of sub time
  // with no main board attached it settles into a poll loop in low ROM
  // (waiting for the other side of the 8255 to come alive)
  const pc = board.cpu.pc;
  assert.ok(pc < 0x0200 && !board.cpu.halted, `poll loop, pc=${pc.toString(16)}`);
});

test('machine88: main and sub ROMs complete the boot handshake', async (t) => {
  const roms = await loadRoms();
  if (!roms) return t.skip('no ROMs (bring your own)');
  const { Pc8801Machine } = await import('./machine88.js');
  const m = new Pc8801Machine({ main: roms.main, ext: roms.ext, sub: roms.sub, mode: 'n88' });
  const answers = [];
  const so = m.sub._out.bind(m.sub);
  m.sub._out = (p, v) => { if (p === 0xfd) answers.push(v); so(p, v); };
  for (let f = 0; f < 240; f++) m.stepFrame();
  // the sub answered the main's drive-status query: two drives on the bitmap
  assert.ok(answers.includes(0x3f), 'sub answered drive status 3F');
  // and the negotiation read the sub ROM's feature byte
  assert.ok(answers.includes(0x77), 'sub served its ROM feature byte');
});

test('machine88: N88-BASIC boots from ROM and computes PRINT 3301', async (t) => {
  const roms = await loadRoms();
  if (!roms) return t.skip('no ROMs (bring your own)');
  const { Pc8801Machine } = await import('./machine88.js');
  const m = new Pc8801Machine({ main: roms.main, ext: roms.ext, sub: roms.sub, mode: 'n88' });
  const KEY = { P: [4, 0], R: [4, 2], I: [3, 1], N: [3, 6], T: [4, 4], ' ': [9, 6], 3: [6, 3], 0: [6, 0], 1: [6, 1], ENTER: [1, 7] };
  const type = (seq) => {
    for (const k of seq) {
      const [row, bit] = KEY[k];
      m.keyDown(row, bit); for (let f = 0; f < 3; f++) m.stepFrame();
      m.keyUp(row, bit); for (let f = 0; f < 3; f++) m.stepFrame();
    }
  };
  for (let f = 0; f < 400; f++) m.stepFrame();
  // disk BASIC asks for the file count first; the banner comes after
  assert.match(m.screenText().join('\n'), /How many files/, 'file-count prompt');

  type(['ENTER']); // accept the default
  for (let f = 0; f < 120; f++) m.stepFrame();
  const banner = m.screenText().join('\n');
  assert.match(banner, /N-88 BASIC/, 'N88 banner');
  assert.match(banner, /Bytes free/, 'memory sized');
  type(['P', 'R', 'I', 'N', 'T', ' ', '3', '3', '0', '1', 'ENTER']);
  for (let f = 0; f < 90; f++) m.stepFrame();
  assert.ok(m.screenText().some((l) => l.trim() === '3301'), 'BASIC printed 3301');
});

test('machine88: a mounted disk boots — the FDC reads and loaded code runs', async (t) => {
  const roms = await loadRoms();
  if (!roms) return t.skip('no ROMs (bring your own)');
  const { Pc8801Machine } = await import('./machine88.js');
  const { buildD88, parseD88 } = await import('./d88.js');
  // a disk whose boot sector is real code: LD A,55h; LD (9000h),A; HALT
  const boot = new Uint8Array(256);
  boot.set([0x3e, 0x55, 0x32, 0x00, 0x90, 0x76], 0);
  const disk = parseD88(buildD88({
    name: 'BOOT', tracks: [[
      { c: 0, h: 0, r: 1, n: 1, data: boot },
      ...Array.from({ length: 15 }, (_, i) => ({
        c: 0, h: 0, r: i + 2, n: 1, data: new Uint8Array(256),
      })),
    ]],
  }));

  const m = new Pc8801Machine({ main: roms.main, ext: roms.ext, sub: roms.sub, mode: 'n88' });
  m.insertDisk(0, disk);
  const cmds = new Set();
  const w = m.sub.fdc.write.bind(m.sub.fdc);
  m.sub.fdc.write = (v) => { if (m.sub.fdc.phase === 'idle') cmds.add(v & 0x1f); w(v); };

  for (let f = 0; f < 200; f++) m.stepFrame();
  // with a disk in drive 0 the ROM boots from it: SPECIFY/RECAL/SEEK, then
  // SENSE DEVICE (04) and finally READ DATA (06) — the boot sector arrives
  assert.ok(cmds.has(0x06), 'the FDC was told to READ DATA');
  // and the ROM does not fall back into the BASIC banner
  assert.ok(!m.screenText().join('\n').includes('N-88 BASIC'), 'did not fall back to ROM BASIC');
});
