// test-x68 — the X68000 parts, headless and without any ROM.
//
// Everything here builds its own IPL: a 128 KB array with a reset vector and a
// handful of hand-assembled 68000 instructions. That keeps `node --test`
// runnable on a clean checkout, which matters because the real IPL ROM and the
// disk images are not in this repository and never will be.

import test from 'node:test';
import assert from 'node:assert/strict';

import { X68000Machine, CPU_HZ } from './machinex68.js';
import { X68Crtc } from './x68crtc.js';
import { X68Video } from './x68video.js';
import { Mc68901, SRC, REG } from './mc68901.js';
import { Hd63450 } from './hd63450.js';
import { Ym2151 } from './ym2151.js';
import { Msm6258 } from './msm6258.js';
import {
  parseDim, parseRaw, parseX68Disk, tryParseX68Disk, summarizeX68Disk,
  bootRecord, X68Fdd, isDim,
} from './x68fdd.js';
import { findSector } from './d88.js';

// ---- helpers ---------------------------------------------------------------

// A 128 KB IPL image. The reset vectors live at $FF0000, which is the last
// 64 KB of the ROM, and `code` is placed at $FF0010 where the real ROM puts
// its first instruction.
function makeIpl(code = []) {
  const rom = new Uint8Array(0x20000);
  const put16 = (o, v) => { rom[o] = (v >> 8) & 0xff; rom[o + 1] = v & 0xff; };
  const put32 = (o, v) => { put16(o, (v >>> 16) & 0xffff); put16(o + 2, v & 0xffff); };
  const base = 0x10000;             // $FF0000
  put32(base + 0, 0x00002000);      // SSP
  put32(base + 4, 0x00ff0010);      // PC
  let o = base + 0x10;
  for (const w of code) { put16(o, w); o += 2; }
  return rom;
}

// MOVE #$2700,SR / LEA $2000,A7 / RESET, then whatever follows. This is what
// the real ROM does and it is what drops the boot overlay.
const PROLOGUE = [0x46fc, 0x2700, 0x4ff9, 0x0000, 0x2000, 0x4e70];

function machine(code, opts = {}) {
  return new X68000Machine({ ipl: makeIpl([...PROLOGUE, ...code]), ...opts });
}

// A flat 2HD image with a recognisable pattern and a plausible boot sector.
function makeXdf() {
  const bytes = new Uint8Array(8 * 1024 * 154).fill(0xe5);
  bytes[0] = 0x60; bytes[1] = 0x3c;
  const oem = 'X68TEST!';
  for (let i = 0; i < oem.length; i++) bytes[2 + i] = oem.charCodeAt(i);
  for (let t = 0; t < 154; t++) for (let s = 0; s < 8; s++) bytes[t * 8192 + s * 1024 + 16] = (t * 8 + s) & 0xff;
  return bytes;
}

function makeDim(media = 0, presentEvery = 1) {
  const geom = [[8, 1024, 154], [9, 1024, 160], [15, 512, 160]][media];
  const [sect, size, tracks] = geom;
  const trackBytes = sect * size;
  const flags = [];
  let n = 0;
  for (let t = 0; t < 170; t++) { const p = t < tracks && (t % presentEvery === 0) ? 1 : 0; flags.push(p); if (p) n++; }
  const bytes = new Uint8Array(256 + n * trackBytes);
  bytes[0] = media;
  bytes.set(flags, 1);
  const sig = 'DIFC HEADER  ';
  for (let i = 0; i < sig.length; i++) bytes[0xab + i] = sig.charCodeAt(i);
  const name = 'unit test disk';
  for (let i = 0; i < name.length; i++) bytes[0xc2 + i] = name.charCodeAt(i);
  bytes[255] = 1; // overtrack: the flags are meaningful
  let o = 256;
  for (let t = 0; t < 170; t++) {
    if (!flags[t]) continue;
    for (let s = 0; s < sect; s++) bytes[o + s * size] = (t + s) & 0xff;
    o += trackBytes;
  }
  return bytes;
}

// ---- disk images ------------------------------------------------------------

test('XDF: a flat 1232 KB dump is 154 tracks of eight 1 KB sectors', () => {
  const d = parseRaw(makeXdf());
  const s = summarizeX68Disk(d);
  assert.equal(s.media, '2HD');
  assert.equal(s.tracks, 154);
  assert.equal(s.sectors, 154 * 8);
  assert.equal(s.bytes, 1261568);
  const sec = findSector(d, 3, 1, 5, 3);
  assert.ok(sec);
  assert.equal(sec.size, 1024);
  assert.equal(sec.data[16], ((3 * 2 + 1) * 8 + 4) & 0xff);
});

test('XDF: the boot record is readable', () => {
  const d = parseRaw(makeXdf());
  const b = bootRecord(d);
  assert.equal(b.bootable, true);
  assert.equal(b.oem, 'X68TEST!');
});

test('DIM: the signature is what identifies it', () => {
  assert.equal(isDim(makeDim(0)), true);
  assert.equal(isDim(makeXdf()), false);
});

test('DIM: absent tracks are holes, not shifted data', () => {
  // Every other track present. Track 2's data has to come from the SECOND
  // block in the file, not the third — that is the whole point of the flags.
  const d = parseDim(makeDim(0, 2));
  assert.equal(d.media, '2HD');
  assert.equal(d.tracks[0].sectors[0].data[0], 0);
  assert.equal(d.tracks[1], null);
  assert.equal(d.tracks[2].sectors[0].data[0], 2);
  assert.equal(d.tracks[4].sectors[0].data[0], 4);
  assert.equal(d.name, 'unit test disk');
});

test('DIM: the media byte picks the geometry', () => {
  assert.equal(parseDim(makeDim(1)).tracks[0].sectors.length, 9);
  assert.equal(parseDim(makeDim(1)).tracks[0].sectors[0].size, 1024);
  assert.equal(parseDim(makeDim(2)).tracks[0].sectors.length, 15);
  assert.equal(parseDim(makeDim(2)).tracks[0].sectors[0].size, 512);
});

test('tryParseX68Disk answers with data rather than throwing', () => {
  assert.equal(tryParseX68Disk(new Uint8Array(10)).ok, false);
  assert.equal(tryParseX68Disk(makeDim(0), { name: 'a.dim' }).ok, true);
  assert.equal(tryParseX68Disk(makeXdf(), { name: 'a.xdf' }).ok, true);
});

// ---- the drive and the controller --------------------------------------------

test('FDD: drive control acts on the falling edge, not the level', () => {
  const f = new X68Fdd();
  f.insert(0, parseRaw(makeXdf()));
  for (let i = 0; i < 4; i++) f.tickFrame();
  assert.equal(f.isReady(0), true);
  // Arm "eject drive 0" and select it, but do not strobe: nothing happens.
  f.write(5, 0x21);
  assert.equal(f.isReady(0), true);
  // Now drop the drive bit: that is the strobe.
  f.write(5, 0x20);
  assert.equal(f.isReady(0), false);
});

test('FDD: a data request is not an interrupt', () => {
  const f = new X68Fdd();
  f.insert(0, parseRaw(makeXdf()));
  for (let i = 0; i < 4; i++) f.tickFrame();
  f.write(7, 0x80);
  // READ DATA, cylinder 0, head 0, sector 1, N=3, EOT=1
  for (const b of [0x46, 0x00, 0x00, 0x00, 0x01, 0x03, 0x01, 0x35, 0xff]) f.write(3, b);
  assert.equal(f.dataReady, true, 'execution phase is a DREQ');
  assert.equal(f.intPending, false, 'and must NOT be an interrupt');
  for (let i = 0; i < 1024; i++) f.read(3);
  assert.equal(f.dataReady, false);
  assert.equal(f.intPending, true, 'the command-complete interrupt comes at the end');
});

test('FDD: the commands that do not interrupt, do not interrupt', () => {
  const f = new X68Fdd();
  f.insert(0, parseRaw(makeXdf()));
  for (let i = 0; i < 4; i++) f.tickFrame();
  f.write(7, 0x80);
  f.write(3, 0x04); f.write(3, 0x00);      // SENSE DEVICE STATUS
  assert.equal(f.intPending, false);
  assert.equal(f.read(3) & 0x20, 0x20);    // ready
  f.write(3, 0x08);                         // SENSE INTERRUPT STATUS, nothing pending
  assert.equal(f.intPending, false);
  assert.equal(f.fdc.result.length, 1, 'invalid status is ONE byte');
  assert.equal(f.read(3), 0x80);
  assert.equal(f.fdc.phase, 'idle', 'and the controller goes idle after it');
});

test('FDD: a seek raises an interrupt even though the phase is idle', () => {
  const f = new X68Fdd();
  f.insert(0, parseRaw(makeXdf()));
  for (let i = 0; i < 4; i++) f.tickFrame();
  f.write(7, 0x80);
  f.write(3, 0x0f); f.write(3, 0x00); f.write(3, 0x20);  // SEEK to cylinder 32
  assert.equal(f.fdc.phase, 'idle');
  assert.equal(f.intPending, true);
  f.write(3, 0x08);
  assert.equal(f.read(3) & 0x20, 0x20);  // ST0 SE
  assert.equal(f.read(3), 0x20);         // the cylinder it landed on
});

test('FDD: state survives a round trip mid-transfer', () => {
  const f = new X68Fdd();
  const disk = parseRaw(makeXdf());
  f.insert(0, disk);
  for (let i = 0; i < 4; i++) f.tickFrame();
  f.write(7, 0x80);
  for (const b of [0x46, 0x00, 0x00, 0x00, 0x01, 0x03, 0x01, 0x35, 0xff]) f.write(3, b);
  for (let i = 0; i < 100; i++) f.read(3);
  const s = JSON.parse(JSON.stringify(f.getState()));
  const rest = [];
  for (let i = 0; i < 20; i++) rest.push(f.read(3));

  const g = new X68Fdd();
  g.insert(0, disk);
  g.setState(s);
  const again = [];
  for (let i = 0; i < 20; i++) again.push(g.read(3));
  assert.deepEqual(again, rest);
});

// ---- the MFP ------------------------------------------------------------------

test('MFP: a disabled source never latches', () => {
  const m = new Mc68901();
  m.request(SRC.TIMER_C);
  assert.equal(m.intPending, false);
  m.write(0xe88009, 0x20);   // IERB bit5 = Timer C
  m.write(0xe88015, 0x20);   // IMRB
  m.request(SRC.TIMER_C);
  assert.equal(m.intPending, true);
});

test('MFP: the vector runs the opposite way to the priority', () => {
  const m = new Mc68901();
  m.write(0xe88007, 0xff);   // IERA
  m.write(0xe88013, 0xff);   // IMRA
  m.write(0xe88017, 0x40);   // VR: the top nibble of the vector
  m.request(SRC.GPIP7);      // source 0, the highest priority
  assert.equal(m.ack(), 0x4f);
  m.request(SRC.TIMER_B);    // source 7
  assert.equal(m.ack(), 0x48);
});

test('MFP: the highest priority pending source wins', () => {
  const m = new Mc68901();
  m.write(0xe88007, 0xff); m.write(0xe88009, 0xff);
  m.write(0xe88013, 0xff); m.write(0xe88015, 0xff);
  m.request(SRC.TIMER_C);    // source 10
  m.request(SRC.TIMER_A);    // source 2, higher
  assert.equal(m.ack(), 13);  // 15 - 2
  assert.equal(m.ack(), 5);   // 15 - 10
  assert.equal(m.ack(), -1);
});

test('MFP: writing IPR clears the bits written as ZERO', () => {
  const m = new Mc68901();
  m.write(0xe88007, 0xff); m.write(0xe88013, 0xff);
  m.request(SRC.TIMER_A);
  assert.equal(m.intPending, true);
  m.write(0xe8800b, 0xdf);   // IPRA, clearing bit 5 (Timer A)
  assert.equal(m.intPending, false);
});

test('MFP: Timer C counts at the prescaled 4 MHz rate', () => {
  const m = new Mc68901();
  m.write(0xe88009, 0x20);   // IERB Timer C
  m.write(0xe88015, 0x20);   // IMRB
  m.write(0xe8801d, 0x50);   // TCDCR: Timer C prescaler 5 (/64)
  m.write(0xe88023, 200);    // TCDR
  // 200 counts of 64 MFP clocks each = 12800 MFP clocks = 32000 CPU clocks.
  m.advance(31998 * 2);
  assert.equal(m.intPending, false);
  m.advance(4);
  assert.equal(m.intPending, true);
});

test('MFP: a GPIP edge only fires on the polarity AER selects', () => {
  const m = new Mc68901();
  m.write(0xe88009, 0x40);   // IERB bit6 = GPIP4
  m.write(0xe88015, 0x40);   // IMRB
  m.write(0xe88003, 0x00);   // AER: interrupt on the falling edge
  m.setGpip(0x10, true);
  assert.equal(m.intPending, false, 'rising edge, not selected');
  m.setGpip(0x10, false);
  assert.equal(m.intPending, true);
});

// ---- the DMAC -------------------------------------------------------------------

function ramBus(size = 0x10000) {
  const mem = new Uint8Array(size);
  return {
    mem,
    read8: (a) => mem[a & (size - 1)],
    write8: (a, v) => { mem[a & (size - 1)] = v & 0xff; },
    read16: (a) => (mem[a & (size - 1)] << 8) | mem[(a + 1) & (size - 1)],
    write16: (a, v) => { mem[a & (size - 1)] = (v >> 8) & 0xff; mem[(a + 1) & (size - 1)] = v & 0xff; },
    read32: (a) => ((mem[a & (size - 1)] << 24) | (mem[(a + 1) & (size - 1)] << 16) | (mem[(a + 2) & (size - 1)] << 8) | mem[(a + 3) & (size - 1)]) >>> 0,
    write32: (a, v) => { mem[a & (size - 1)] = (v >>> 24) & 0xff; mem[(a + 1) & (size - 1)] = (v >>> 16) & 0xff; mem[(a + 2) & (size - 1)] = (v >>> 8) & 0xff; mem[(a + 3) & (size - 1)] = v & 0xff; },
  };
}

function setupDma(d, { ch = 0, dcr, ocr, scr, mtc, mar, dar }) {
  const base = ch * 0x40;
  d.write(base + 0x04, dcr);
  d.write(base + 0x05, ocr);
  d.write(base + 0x06, scr);
  d.write(base + 0x0a, (mtc >> 8) & 0xff); d.write(base + 0x0b, mtc & 0xff);
  for (let i = 0; i < 4; i++) d.write(base + 0x0c + i, (mar >>> (24 - i * 8)) & 0xff);
  for (let i = 0; i < 4; i++) d.write(base + 0x14 + i, (dar >>> (24 - i * 8)) & 0xff);
}

test('DMAC: a burst memory-to-memory copy runs to completion', () => {
  const bus = ramBus();
  const d = new Hd63450({ bus });
  for (let i = 0; i < 64; i++) bus.mem[0x1000 + i] = i;
  setupDma(d, { dcr: 0x08, ocr: 0x81, scr: 0x05, mtc: 64, mar: 0x2000, dar: 0x1000 });
  d.write(0x07, 0x88);      // START | interrupt enable
  assert.equal(d.ch[0].mtc, 0);
  assert.equal(d.ch[0].csr & 0x80, 0x80, 'operation complete');
  for (let i = 0; i < 64; i++) assert.equal(bus.mem[0x2000 + i], i);
});

test('DMAC: an 8-bit device moves a long operand as four byte cycles', () => {
  const bus = ramBus();
  let cursor = 0x3000;
  // The device is one register that hands out consecutive bytes.
  const dev = { ...bus, read8: (a) => (a === 0xe94003 ? bus.mem[cursor++] : bus.read8(a)) };
  const d = new Hd63450({ bus: dev });
  for (let i = 0; i < 16; i++) bus.mem[0x3000 + i] = 0xa0 + i;
  // DCR bit3 clear = 8-bit device, OCR size = long, device address does not move
  setupDma(d, { dcr: 0x00, ocr: 0xa1, scr: 0x04, mtc: 4, mar: 0x4000, dar: 0xe94003 });
  d.write(0x07, 0x80);
  for (let i = 0; i < 16; i++) assert.equal(bus.mem[0x4000 + i], 0xa0 + i, `byte ${i}`);
});

test('DMAC: an external-request channel waits for the device', () => {
  const bus = ramBus();
  let ready = false;
  const d = new Hd63450({ bus, deviceReady: () => ready });
  setupDma(d, { dcr: 0x00, ocr: 0x82, scr: 0x04, mtc: 8, mar: 0x5000, dar: 0x1000 });
  d.write(0x07, 0x80);
  assert.equal(d.ch[0].mtc, 8, 'nothing moves while DREQ is low');
  ready = true;
  d.run(0, 3);
  assert.equal(d.ch[0].mtc, 5, 'and the budget caps how much moves at once');
});

test('DMAC: the interrupt vector depends on whether it errored', () => {
  const bus = ramBus();
  const d = new Hd63450({ bus });
  d.write(0x25, 0x70);   // NIV
  d.write(0x27, 0x71);   // EIV
  setupDma(d, { dcr: 0x08, ocr: 0x81, scr: 0x05, mtc: 4, mar: 0x2000, dar: 0x1000 });
  d.write(0x07, 0x88);
  assert.equal(d.intPending, true);
  assert.equal(d.ack(), 0x70);
});

// ---- the CRTC --------------------------------------------------------------------

test('CRTC: the visible size comes out of R02/R03 and R06/R07', () => {
  const c = new X68Crtc();
  c.write(0xe80004, 0); c.write(0xe80005, 0x0a);   // R02 = 10
  c.write(0xe80006, 0); c.write(0xe80007, 0x6a);   // R03 = 106
  c.write(0xe8000c, 0); c.write(0xe8000d, 0x28);   // R06 = 40
  c.write(0xe8000e, 2); c.write(0xe8000f, 0x28);   // R07 = 552
  c.write(0xe80029, 0x15);                          // 31 kHz, 512 lines
  assert.equal(c.width, (106 - 10) * 8);
  assert.equal(c.height, 512);
  assert.equal(c.verticalStep, 2);
});

test('CRTC: the vertical step halves or doubles the picture', () => {
  const c = new X68Crtc();
  c.write(0xe8000c, 0); c.write(0xe8000d, 0x28);
  c.write(0xe8000e, 2); c.write(0xe8000f, 0x28);
  c.write(0xe80029, 0x10);            // high resolution, 256 lines
  assert.equal(c.verticalStep, 1);
  assert.equal(c.height, 256);
  c.write(0xe80029, 0x04);            // low resolution, 512 lines
  assert.equal(c.verticalStep, 4);
  assert.equal(c.height, 1024);
});

test('CRTC: the raster copy fires on the destination write', () => {
  const seen = [];
  const c = new X68Crtc({ onRasterCopy: (s, d, p) => seen.push([s, d, p]) });
  c.write(0xe80481, 0x08);   // arm the copy
  seen.length = 0;
  c.write(0xe8002b, 0x0f);   // all four planes
  c.write(0xe8002c, 4);      // source
  assert.equal(seen.length, 0, 'the source alone does not trigger it');
  c.write(0xe8002d, 8);      // destination
  assert.deepEqual(seen, [[4, 8, 0x0f]]);
});

test('CRTC: the fast clear runs for a whole vertical period', () => {
  const seen = [];
  const c = new X68Crtc({ onFastClear: (m) => seen.push(m) });
  c.write(0xe80029, 0x10);   // high resolution: one frame
  c.write(0xe8002b, 0x05);
  c.write(0xe80481, 0x02);
  assert.equal(seen.length, 0, 'not until the blank');
  c.endFrame();
  assert.deepEqual(seen, [0x05]);
  assert.equal(c.read(0xe80481) & 2, 2, 'and it reads back as busy');
  c.endFrame();
  assert.equal(c.read(0xe80481) & 2, 0);
});

// ---- video memory -----------------------------------------------------------------

test('GVRAM: 16 colours puts four pages in the four nibbles of one word', () => {
  const c = new X68Crtc();
  const v = new X68Video({ crtc: c });
  c.writeReg(0x28, 0x00);      // 16-colour access
  // The data is on the ODD byte of each word; the even byte is not there.
  v.writeGvram8(0xc00001, 0x0a);           // page 0, dot (0,0)
  v.writeGvram8(0xc80001, 0x0b);           // page 1
  v.writeGvram8(0xd00001, 0x0c);           // page 2
  v.writeGvram8(0xd80001, 0x0d);           // page 3
  assert.equal(v.gvram[0], 0xdcba);
  assert.equal(v.readGvram8(0xc00001), 0x0a);
  assert.equal(v.readGvram8(0xd80001), 0x0d);
  v.writeGvram8(0xc00000, 0xff);
  assert.equal(v.gvram[0], 0xdcba, 'the even byte is ignored');
});

test('GVRAM: 256 colours splits the word into two pages', () => {
  const c = new X68Crtc();
  const v = new X68Video({ crtc: c });
  c.writeReg(0x28, 0x01);
  v.writeGvram8(0xc00001, 0x12);
  v.writeGvram8(0xc80001, 0x34);
  assert.equal(v.gvram[0], 0x3412);
  assert.equal(v.readGvram8(0xc00001), 0x12);
  assert.equal(v.readGvram8(0xc80001), 0x34);
});

test('GVRAM: 65536 colours is the whole word, big-endian', () => {
  const c = new X68Crtc();
  const v = new X68Video({ crtc: c });
  c.writeReg(0x28, 0x03);
  v.writeGvram16(0xc00000, 0xbeef);
  assert.equal(v.gvram[0], 0xbeef);
  assert.equal(v.readGvram8(0xc00000), 0xbe);
  assert.equal(v.readGvram8(0xc00001), 0xef);
});

test('GVRAM: the 1024-dot mode folds four quadrants into one word', () => {
  const c = new X68Crtc();
  const v = new X68Video({ crtc: c });
  c.writeReg(0x28, 0x04);
  // (0,0) is the low nibble; (512,0) is nibble 1; (0,512) is nibble 2.
  v.writeGvram8(0xc00001, 0x01);
  v.writeGvram8(0xc00000 + 512 * 2 + 1, 0x02);
  v.writeGvram8(0xc00000 + 512 * 2048 + 1, 0x04);
  assert.equal(v.gvram[0] & 0x0f, 1);
  assert.equal((v.gvram[0] >> 4) & 0x0f, 2);
  assert.equal((v.gvram[0] >> 8) & 0x0f, 4);
});

test('TVRAM: simultaneous access writes one byte to several planes', () => {
  const c = new X68Crtc();
  const v = new X68Video({ crtc: c });
  c.writeReg(0x2a, 0x01);       // simultaneous
  c.writeReg(0x2b, 0x30);       // planes 0 and 1
  v.writeText8(0xe00000, 0xa5);
  assert.equal(v.tvram[0], 0xa5);
  assert.equal(v.tvram[0x20000], 0xa5);
  assert.equal(v.tvram[0x40000], 0x00);
});

test('TVRAM: the mask keeps the bits that are SET in it', () => {
  const c = new X68Crtc();
  const v = new X68Video({ crtc: c });
  v.tvram[1] = 0xff;
  c.writeReg(0x2a, 0x02);       // mask enabled
  c.writeReg(0x2f, 0xf0);       // odd bytes: keep the top nibble
  v.writeText8(0xe00001, 0x00);
  assert.equal(v.tvram[1], 0xf0);
});

test('TVRAM: the raster copy moves four scanlines per plane', () => {
  const c = new X68Crtc();
  const v = new X68Video({ crtc: c });
  for (let i = 0; i < 512; i++) v.tvram[0x200 + i] = i & 0xff;
  v.rasterCopy(1, 4, 0x01);
  for (let i = 0; i < 512; i++) assert.equal(v.tvram[0x800 + i], i & 0xff);
  assert.equal(v.tvram[0x20800], 0, 'a plane not in the mask is untouched');
});

test('palette: GGGGGRRRRRBBBBBI becomes eight bits a gun', () => {
  const c = new X68Crtc();
  const v = new X68Video({ crtc: c });
  c.writeReg(0x28, 0x00);
  c.writeReg(0x29, 0x15);
  c.writeReg(0x04, 0); c.writeReg(0x05, 0);
  c.writeReg(0x06, 0); c.writeReg(0x07, 1);      // eight dots wide
  c.writeReg(0x0c, 0); c.writeReg(0x0d, 0);
  c.writeReg(0x0e, 0); c.writeReg(0x0f, 1);      // one line
  // Pure red at full brightness: R = 31, I = 1.
  v.writeCtrl8(0xe82002, 0x07); v.writeCtrl8(0xe82003, 0xc1);
  v.vc[5] = 0x01;  // one graphics page on
  v.vc[3] = 0x00;
  v.writeGvram8(0xc00001, 1);
  v.beginFrame();
  v.renderLine(0, 0);
  const f = v.render();
  // The I bit is the shared low bit of all three guns, so a "pure" red is
  // still one step off black on the other two.
  assert.equal(f.rgb[0], 255);
  assert.equal(f.rgb[1], 4);
  assert.equal(f.rgb[2], 4);
});

// ---- sound -----------------------------------------------------------------------

test('OPM: Timer B overflows sixteen times slower than Timer A', () => {
  const a = new Ym2151({ sampleRate: 44100 });
  a.writeAddress(0x10); a.writeData(0x00);   // CLKA = 0
  a.writeAddress(0x11); a.writeData(0x00);
  a.writeAddress(0x14); a.writeData(0x05);   // LOAD A + IRQEN A
  // (1024 - 0) * 16 us = 16.384 ms = 163840 CPU clocks at 10 MHz.
  a.advance(163000);
  assert.equal(a.readStatus() & 1, 0);
  a.advance(2000);
  assert.equal(a.readStatus() & 1, 1);

  const b = new Ym2151({ sampleRate: 44100 });
  b.writeAddress(0x12); b.writeData(0x00);   // CLKB = 0
  b.writeAddress(0x14); b.writeData(0x0a);   // LOAD B + IRQEN B
  b.advance(650000);
  assert.equal(b.readStatus() & 2, 0);
  b.advance(10000);
  assert.equal(b.readStatus() & 2, 2);
});

test('OPM: the timer flags are cleared by writing the reset bits', () => {
  const a = new Ym2151({ sampleRate: 44100 });
  a.writeAddress(0x14); a.writeData(0x05);
  a.advance(200000);
  assert.equal(a.readStatus() & 1, 1);
  a.writeAddress(0x14); a.writeData(0x15);   // FRESET A
  assert.equal(a.readStatus() & 1, 0);
});

test('OPM: a key-on makes sound and the same input makes the same sound', () => {
  const play = () => {
    const o = new Ym2151({ sampleRate: 44100 });
    const w = (r, v) => { o.writeAddress(r); o.writeData(v); };
    w(0x20, 0xc7);          // both speakers, algorithm 7 (all four carriers)
    for (const r of [0x40, 0x48, 0x50, 0x58]) w(r, 0x01);      // MUL = 1
    for (const r of [0x60, 0x68, 0x70, 0x78]) w(r, 0x00);      // TL = 0
    for (const r of [0x80, 0x88, 0x90, 0x98]) w(r, 0x1f);      // AR max
    for (const r of [0xe0, 0xe8, 0xf0, 0xf8]) w(r, 0x0f);      // RR max
    w(0x28, 0x4a);          // KC
    w(0x08, 0x78);          // key on, all operators
    const buf = new Float32Array(512);
    o.renderMono(buf);
    return buf;
  };
  const a = play(), b = play();
  assert.deepEqual(Array.from(a), Array.from(b), 'deterministic');
  assert.ok(a.some((v) => Math.abs(v) > 0.001), 'and audible');
});

test('OPM: state survives a round trip', () => {
  const o = new Ym2151({ sampleRate: 44100 });
  const w = (r, v) => { o.writeAddress(r); o.writeData(v); };
  w(0x20, 0xc4);
  for (const r of [0x80, 0x88, 0x90, 0x98]) w(r, 0x1f);
  for (const r of [0x60, 0x68, 0x70, 0x78]) w(r, 0x10);
  w(0x28, 0x4a); w(0x08, 0x78);
  const warm = new Float32Array(64); o.renderMono(warm);
  const s = JSON.parse(JSON.stringify(o.getState()));
  const before = new Float32Array(256); o.renderMono(before);

  const p = new Ym2151({ sampleRate: 44100 });
  p.setState(s);
  const after = new Float32Array(256); p.renderMono(after);
  assert.deepEqual(Array.from(after), Array.from(before));
});

test('ADPCM: the codec follows the step table', () => {
  const a = new Msm6258({ sampleRate: 44100 });
  a.write(0xe92001, 0x02);           // start
  assert.equal(a.read(0xe92001), 0xc0);
  // Nibble 7 at step 0: step(0) = 16, diff = 16 + 8 + 4 + 2 = 30.
  a.write(0xe92003, 0x07);           // low nibble 7, then high nibble 0
  assert.equal(a.step, 7);           // +8 for the seven, then -1 for the zero
  // nibble 7 at step 0: step(0) = 16, so +16 +8 +4 +2 = 30. Then nibble 0 at
  // step 8: step(8) = 34, so +34/8 = 4. 34 in total.
  assert.equal(a.out, 34);
  a.write(0xe92001, 0x01);
  assert.equal(a.read(0xe92001), 0x40);
});

test('ADPCM: the sample rate follows the 8255 and the OPM together', () => {
  const a = new Msm6258({ sampleRate: 44100 });
  a.setPortC(0x08);      // port C bit 3 -> divider index 2
  assert.equal(Math.round(a.rate), 15625);
  a.setBaseClock(1);     // CT2 halves the crystal
  assert.equal(Math.round(a.rate), 7813);
});

// ---- the machine ----------------------------------------------------------------------

test('machine: the boot overlay puts the ROM at zero and RESET takes it away', () => {
  // MOVE.L $0.L, D0 before RESET should see the ROM's SSP; after, RAM.
  const m = machine([
    0x2039, 0x0000, 0x0000,        // MOVE.L $00000000, D0
    0x60fe,                        // BRA *
  ]);
  assert.equal(m.bootOverlay, true, 'the ROM answers at zero out of reset');
  assert.equal(m.cpu.a[7] >>> 0, 0x2000, 'and the reset vector came from it');
  assert.equal(m.cpu.pc >>> 0, 0x00ff0010);
  for (let i = 0; i < 3; i++) m.cpu.step();   // MOVE to SR, LEA, RESET
  assert.equal(m.bootOverlay, false);
  m.cpu.step();                                // MOVE.L $0, D0
  assert.equal(m.cpu.d[0] >>> 0, 0, 'and $0 is RAM now');
});

test('machine: reads above the installed RAM are bus errors', () => {
  const m = machine([0x60fe], { ram: 0x100000 });
  m.stepFrame();
  assert.throws(() => m._read8(0x400000));
  assert.doesNotThrow(() => m._read8(0x0fffff));
});

test('machine: the same input produces the same frames', () => {
  const code = [
    0x203c, 0x00e0, 0x0000,        // MOVE.L #$E00000, D0
    0x2040,                        // MOVEA.L D0, A0
    0x303c, 0x0fff,                // MOVE.W #$FFF, D0
    0x30fc, 0x5a5a,                // MOVE.W #$5A5A, (A0)+
    0x51c8, 0xfffa,                // DBF D0, -6
    0x60fe,                        // BRA *
  ];
  const a = machine(code), b = machine(code);
  for (let i = 0; i < 20; i++) { a.stepFrame(); b.stepFrame(); }
  assert.equal(a.frame, b.frame);
  assert.deepEqual(a.cpu.snapshot(), b.cpu.snapshot());
  assert.deepEqual(Array.from(a.video.tvram.subarray(0, 4096)), Array.from(b.video.tvram.subarray(0, 4096)));
});

test('machine: snapshot then restore then continue is identical', () => {
  const code = [
    0x203c, 0x00e0, 0x0000,
    0x2040,
    0x7000,                        // MOVEQ #0, D0
    0x30c0,                        // MOVE.W D0, (A0)+
    0x5240,                        // ADDQ.W #1, D0
    0x60fa,                        // BRA -4
  ];
  const m = machine(code);
  for (let i = 0; i < 6; i++) m.stepFrame();
  const s = JSON.parse(JSON.stringify(m.snapshot()));
  const direct = [];
  for (let i = 0; i < 6; i++) { m.stepFrame(); direct.push(m.cpu.snapshot().pc); }

  const n = machine(code);
  n.restore(s);
  const replayed = [];
  for (let i = 0; i < 6; i++) { n.stepFrame(); replayed.push(n.cpu.snapshot().pc); }
  assert.deepEqual(replayed, direct);
  assert.equal(n.frame, m.frame);
  assert.deepEqual(Array.from(n.ram.subarray(0, 1024)), Array.from(m.ram.subarray(0, 1024)));
});

test('machine: a snapshot holds no ROM and no disk', () => {
  const m = machine([0x60fe]);
  m.insertDisk(0, parseX68Disk(makeXdf(), { name: 'x.xdf' }));
  m.stepFrame();
  const s = m.snapshot();
  const json = JSON.stringify(s);
  assert.equal(json.includes('rom'), false);
  // The IPL is 128 KB of a recognisable pattern; if it were in there the
  // snapshot would be far bigger than the RAM it declares.
  assert.ok(s.ram.length === m.ramSize);
  assert.equal(s.fdd.execBufOwn, null);
});

test('machine: the frame rate follows the CRTC', () => {
  const m = machine([0x60fe]);
  m.stepFrame();
  assert.ok(Math.abs(m.frameHz - CPU_HZ / m.crtc.clocksPerFrame) < 1e-9);
  assert.ok(m.frameHz > 50 && m.frameHz < 62);
});

test('machine: keyboard bytes arrive a few per frame, not all at once', () => {
  const m = machine([0x60fe]);
  for (let i = 0; i < 10; i++) m.keyDown(0x20 + i);
  assert.equal(m.keyQueue.length, 10);
  m.stepFrame();
  assert.ok(m.keyQueue.length >= 6, 'the serial link is not a firehose');
});
