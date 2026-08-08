// Mega Drive tests: the cartridge parser, the VDP, the two sound chips and the
// machine that binds them. Every timing-sensitive assertion is written against
// a ROM built by mdtools/mkrom.mjs so the test carries its own fixture — there
// is no commercial cartridge on disk and none is needed.
//
// The determinism tests are the load-bearing ones. The host's rewind is
// "restore a snapshot and replay the same inputs", so anything that makes two
// identical runs differ breaks time travel rather than merely being wrong.

import test from 'node:test';
import assert from 'node:assert/strict';

import { tryParseMdRom, parseMdRom, deinterleaveSmd, byteSwap, detectContainer, parseRegion, romChecksum } from './mdrom.js';
import { MdVdp } from './mdvdp.js';
import { Ym2612 } from './ym2612.js';
import { Sn76489 } from './sn76489.js';
import { MegaDriveMachine, BUTTON } from './machinemd.js';
import { buildTestRom, buildIdleRom, TEST_COUNTER } from './mdtools/mkrom.mjs';

const counterOf = (m) => ((m.ram[0xff00] << 24) | (m.ram[0xff01] << 16) | (m.ram[0xff02] << 8) | m.ram[0xff03]) >>> 0;

// ===========================================================================
// mdrom
// ===========================================================================

test('mdrom: parses the header of a generated cartridge', () => {
  const rom = buildTestRom({});
  const r = tryParseMdRom(rom, { name: 'mdtest.bin' });
  assert.equal(r.ok, true);
  assert.equal(r.cart.consoleName.trim(), 'SEGA MEGA DRIVE');
  assert.equal(r.cart.serial, 'GM 00000000-00');
  assert.equal(r.cart.checksumOk, true);
  assert.equal(r.cart.container, 'plain');
  assert.deepEqual(r.cart.region, { japan: true, usa: true, europe: true });
});

test('mdrom: refuses a file with no SEGA tag, with data not an exception', () => {
  const junk = new Uint8Array(0x400);
  const r = tryParseMdRom(junk);
  assert.equal(r.ok, false);
  assert.match(r.error, /SEGA/);
  assert.throws(() => parseMdRom(junk));
});

test('mdrom: undoes the Multi Game Doctor byte swap', () => {
  const rom = buildTestRom({});
  const swapped = byteSwap(rom);
  assert.equal(detectContainer(swapped), 'swapped');
  const r = tryParseMdRom(swapped);
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(r.cart.rom.subarray(0, 64)), Array.from(rom.subarray(0, 64)));
  assert.ok(r.cart.warnings.some((w) => w.includes('バイトスワップ')));
});

test('mdrom: undoes the Super Magic Drive interleave', () => {
  const rom = buildTestRom({});
  // Re-interleave the ROM the way a copier would, then check the parser gets
  // the original back byte for byte.
  const blocks = rom.length / 16384;
  const smd = new Uint8Array(512 + rom.length);
  smd[8] = 0xaa; smd[9] = 0xbb;
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < 8192; i++) {
      smd[512 + b * 16384 + i] = rom[b * 16384 + i * 2 + 1];
      smd[512 + b * 16384 + 8192 + i] = rom[b * 16384 + i * 2];
    }
  }
  assert.equal(detectContainer(smd), 'smd');
  assert.deepEqual(Array.from(deinterleaveSmd(smd)), Array.from(rom));
  const r = tryParseMdRom(smd);
  assert.equal(r.ok, true);
  assert.equal(r.cart.container, 'smd');
});

test('mdrom: reads all three region conventions', () => {
  assert.deepEqual(parseRegion('JUE'), { japan: true, usa: true, europe: true });
  assert.deepEqual(parseRegion('U  '), { japan: false, usa: true, europe: false });
  assert.deepEqual(parseRegion('F'), { japan: true, usa: true, europe: true }); // hex $F
  assert.deepEqual(parseRegion('4'), { japan: false, usa: true, europe: false });
  assert.deepEqual(parseRegion(''), { japan: false, usa: true, europe: false }); // silent header
});

test('mdrom: a wrong checksum is a warning, not a refusal', () => {
  const rom = buildTestRom({});
  rom[0x18e] ^= 0xff;
  const r = tryParseMdRom(rom);
  assert.equal(r.ok, true);
  assert.equal(r.cart.checksumOk, false);
  assert.ok(r.cart.warnings.some((w) => w.includes('チェックサム')));
  assert.equal(romChecksum(rom), r.cart.checksum ^ 0xff00);
});

// ===========================================================================
// VDP
// ===========================================================================

const cmd = (code, addr) => [(((code & 3) << 14) | (addr & 0x3fff)) & 0xffff,
  ((((code >> 2) & 0x0f) << 4) | ((addr >> 14) & 3)) & 0xffff];

function setup(vdp, code, addr) {
  const [a, b] = cmd(code, addr);
  vdp.writeControl(a);
  vdp.writeControl(b);
}

test('vdp: a $8xxx control write is a register write', () => {
  const v = new MdVdp();
  v.writeControl(0x8104);
  assert.equal(v.reg[1], 0x04);
  v.writeControl(0x8c81);
  assert.equal(v.h40, true);
  assert.equal(v.screenWidth, 320);
  v.writeControl(0x8c00);
  assert.equal(v.screenWidth, 256);
});

test('vdp: the two-word command sets address and code', () => {
  const v = new MdVdp();
  setup(v, 0x01, 0xc123);
  assert.equal(v.addr, 0xc123);
  assert.equal(v.code, 0x01);
  setup(v, 0x08, 0x0010);
  assert.equal(v.code, 0x08);
});

test('vdp: a VRAM word write byte-swaps at an odd address', () => {
  const v = new MdVdp();
  v.writeControl(0x8f02);
  setup(v, 0x01, 0x0100);
  v.writeData(0x1234);
  assert.equal(v.vram[0x100], 0x12);
  assert.equal(v.vram[0x101], 0x34);
  setup(v, 0x01, 0x0201);
  v.writeData(0x1234);
  assert.equal(v.vram[0x200], 0x34);
  assert.equal(v.vram[0x201], 0x12);
});

test('vdp: the auto-increment applies to every memory', () => {
  const v = new MdVdp();
  v.writeControl(0x8f04);
  setup(v, 0x01, 0x0000);
  v.writeData(0xaaaa); v.writeData(0xbbbb);
  assert.equal(v.vram[0], 0xaa);
  assert.equal(v.vram[4], 0xbb);
  v.writeControl(0x8f02);
  setup(v, 0x03, 0x0000);
  v.writeData(0x0eee); v.writeData(0x0246);
  assert.equal(v.cram[0], 0x0eee);
  assert.equal(v.cram[1], 0x0246);
  setup(v, 0x05, 0x0000);
  v.writeData(0x0123);
  assert.equal(v.vsram[0], 0x123);
});

test('vdp: CRAM keeps only the nine colour bits', () => {
  const v = new MdVdp();
  v.writeControl(0x8f02);
  setup(v, 0x03, 0x0000);
  v.writeData(0xffff);
  assert.equal(v.cram[0], 0x0eee);
});

test('vdp: reads come back from where writes went', () => {
  const v = new MdVdp();
  v.writeControl(0x8f02);
  setup(v, 0x01, 0x1000);
  v.writeData(0xdead);
  setup(v, 0x00, 0x1000);
  assert.equal(v.readData(), 0xdead);
  setup(v, 0x03, 0x0004);
  v.writeData(0x0abc);
  setup(v, 0x08, 0x0004);
  // CRAM is nine bits wide, so the bits that are not colour never came back.
  assert.equal(v.readData(), 0x0abc & 0x0eee);
});

test('vdp: the status word reports blanking and clears VINT on read', () => {
  const v = new MdVdp();
  v.reg[1] = 0x44; // display on
  v.beginLine(0);
  assert.equal((v.readControl() & 0x08) !== 0, false, 'line 0 is not vblank');
  for (let l = 1; l <= 224; l++) v.beginLine(l);
  const s = v.readControl();
  assert.equal((s & 0x08) !== 0, true, 'line 224 is vblank');
  assert.equal((s & 0x80) !== 0, true, 'VINT flag set');
  assert.equal((v.readControl() & 0x80) !== 0, false, 'reading the status clears it');
});

test('vdp: the H interrupt counter reloads and fires every reg10+1 lines', () => {
  const v = new MdVdp();
  v.reg[0] = 0x10; // IE1
  v.reg[1] = 0x44;
  v.reg[10] = 3;
  const fired = [];
  for (let l = 0; l < 20; l++) {
    v.beginLine(l);
    if (v.hintPending) { fired.push(l); v.irqAck(4); }
  }
  // The counter is loaded at the top of the frame and fires when it runs past
  // zero, so with reg10 = 3 the first interrupt lands on line 3 and then every
  // fourth line after it — which is what a game asking for "every 4th line"
  // programs and gets.
  assert.deepEqual(fired, [3, 7, 11, 15, 19]);
});

test('vdp: the vertical interrupt is level 6 and clears on acknowledge', () => {
  const v = new MdVdp();
  v.reg[1] = 0x64; // display on + IE0
  for (let l = 0; l <= 224; l++) v.beginLine(l);
  assert.equal(v.irqLevel(), 6);
  v.irqAck(6);
  assert.equal(v.irqLevel(), 0);
});

test('vdp: a 68000 -> VRAM DMA moves words and writes the source back', () => {
  const src = new Uint16Array(16);
  for (let i = 0; i < 16; i++) src[i] = 0x1000 + i;
  const v = new MdVdp({ read68k: (a) => src[((a - 0x100000) >> 1) & 15] });
  v.reg[1] = 0x14;      // DMA enable
  v.reg[15] = 2;
  v.reg[19] = 16; v.reg[20] = 0;
  const s = 0x100000 >> 1;
  v.reg[21] = s & 0xff; v.reg[22] = (s >> 8) & 0xff; v.reg[23] = (s >> 16) & 0x3f;
  setup(v, 0x01 | 0x20, 0x2000);
  // The transfer is a state machine now, not an instant copy: it moves a word
  // per bus slot and the machine steps it. flushDma() runs it to the end.
  assert.equal(v.dma.active, true);
  assert.equal(v.dmaHoldsBus, true, 'the 68000 is off the bus while it runs');
  v.flushDma();
  for (let i = 0; i < 16; i++) {
    assert.equal((v.vram[0x2000 + i * 2] << 8) | v.vram[0x2001 + i * 2], 0x1000 + i);
  }
  assert.equal(v.reg[19], 0);
  assert.equal(v.reg[20], 0);
});

test('vdp: a VRAM fill writes one byte per word and needs the trigger write', () => {
  const v = new MdVdp();
  v.reg[1] = 0x14;
  v.reg[15] = 2;
  v.reg[19] = 8; v.reg[20] = 0;
  v.reg[23] = 0x80;
  setup(v, 0x01 | 0x20, 0x0100);
  assert.equal(v.vram[0x100], 0, 'nothing happens until the data port is written');
  v.writeData(0x5599);
  assert.equal(v.vram[0x100], 0x55, 'the trigger write lands as a whole word');
  assert.equal(v.vram[0x101], 0x99, 'both bytes of it, before the fill runs');
  v.flushDma();
  assert.equal(v.vram[0x101], 0x55, 'then the fill byte overwrites the odd half');
  assert.equal(v.vram[0x103], 0x55);
  assert.equal(v.vram[0x102], 0x00, 'the even halves keep their old contents');
});

test('vdp: a VRAM copy moves bytes inside VRAM', () => {
  const v = new MdVdp();
  v.reg[1] = 0x14;
  v.reg[15] = 1;
  for (let i = 0; i < 8; i++) v.vram[0x400 + i] = 0xa0 + i;
  v.reg[19] = 8; v.reg[20] = 0;
  v.reg[21] = 0x00; v.reg[22] = 0x04; v.reg[23] = 0xc0;
  setup(v, 0x01 | 0x20, 0x0800);
  assert.equal(v.dmaHoldsBus, false, 'a VRAM copy never touches the 68000 bus');
  v.flushDma();
  for (let i = 0; i < 8; i++) assert.equal(v.vram[0x800 + i], 0xa0 + i);
});

test('vdp: a DMA takes real time and holds the bus while it does', () => {
  const v = new MdVdp({ read68k: () => 0x4321 });
  v.reg[1] = 0x14;  // DMA enable, display off -> the fast blanking rate
  v.reg[15] = 2;
  v.reg[19] = 100; v.reg[20] = 0;
  setup(v, 0x01 | 0x20, 0x0000);
  assert.equal(v.dmaHoldsBus, true);
  v.runDma(20 * 40);            // 40 words' worth of bus slots
  assert.equal(v.dma.len, 60, 'only part of it moved');
  assert.equal(v.vram[0x50], 0x00, 'and the rest has not landed yet');
  v.runDma(20 * 60);
  assert.equal(v.dma.active, false);
  assert.equal(v.dmaHoldsBus, false);
  assert.equal(v.reg[19], 0);
  // The same length costs about ten times as much with the display on, which
  // is what makes a mid-frame DMA span scanlines.
  const w = new MdVdp({ read68k: () => 0x4321 });
  w.reg[1] = 0x54; w.reg[15] = 2; w.reg[19] = 100;
  w.vblank = false;
  setup(w, 0x01 | 0x20, 0x0000);
  w.runDma(20 * 100);
  assert.ok(w.dma.len > 80, `display-on DMA should be far slower, ${100 - w.dma.len} words moved`);
});

test('vdp: DMA does nothing while register 1 bit 4 is clear', () => {
  const v = new MdVdp({ read68k: () => 0x1234 });
  v.reg[1] = 0x04;
  v.reg[19] = 4;
  setup(v, 0x01 | 0x20, 0x0000);
  assert.equal(v.vram[0], 0);
});

// ---- the renderer ----------------------------------------------------------

// Paint one solid tile and point a plane's whole nametable at it.
function fillPlane(v, ntBase, entry) {
  for (let i = 0; i < 64 * 32; i++) {
    v.vram[ntBase + i * 2] = (entry >> 8) & 0xff;
    v.vram[ntBase + i * 2 + 1] = entry & 0xff;
  }
}
function solidTile(v, index, nibble) {
  for (let i = 0; i < 32; i++) v.vram[index * 32 + i] = (nibble << 4) | nibble;
}
function basicVdp() {
  const v = new MdVdp();
  v.reg[0] = 0x04; v.reg[1] = 0x44;
  v.reg[2] = 0x30; v.reg[3] = 0x2c; v.reg[4] = 0x07; v.reg[5] = 0x78;
  v.reg[12] = 0x81; v.reg[13] = 0x3f; v.reg[15] = 2; v.reg[16] = 0x01;
  v.cram[0] = 0x0000;
  v.cram[1] = 0x000e; // red
  v.cram[2] = 0x00e0; // green
  v.cram[3] = 0x0e00; // blue
  return v;
}
const pixel = (v, x, y) => {
  const o = (y * 320 + x) * 3;
  return [v.frameRgb[o], v.frameRgb[o + 1], v.frameRgb[o + 2]];
};

test('vdp render: plane A covers plane B', () => {
  const v = basicVdp();
  solidTile(v, 1, 1);
  solidTile(v, 2, 2);
  fillPlane(v, 0xc000, 0x0001); // A -> tile 1 (red)
  fillPlane(v, 0xe000, 0x0002); // B -> tile 2 (green)
  v.renderLine(10);
  assert.deepEqual(pixel(v, 100, 10), [255, 0, 0]);
});

test('vdp render: a high-priority plane B beats a low-priority plane A', () => {
  const v = basicVdp();
  solidTile(v, 1, 1);
  solidTile(v, 2, 2);
  fillPlane(v, 0xc000, 0x0001);
  fillPlane(v, 0xe000, 0x8002); // priority bit set
  v.renderLine(10);
  assert.deepEqual(pixel(v, 100, 10), [0, 255, 0]);
});

test('vdp render: horizontal scroll shifts the plane', () => {
  const v = basicVdp();
  solidTile(v, 1, 1);
  // One red cell at the very left of plane A, transparent everywhere else.
  fillPlane(v, 0xc000, 0x0000);
  v.vram[0xc000] = 0x00; v.vram[0xc001] = 0x01;
  v.renderLine(0);
  assert.deepEqual(pixel(v, 2, 0), [255, 0, 0]);
  assert.deepEqual(pixel(v, 20, 0), [0, 0, 0]);
  // Scroll right by 16: the cell moves to x=16..23.
  v.vram[0xfc00] = 0x00; v.vram[0xfc01] = 0x10;
  v.renderLine(0);
  assert.deepEqual(pixel(v, 2, 0), [0, 0, 0]);
  assert.deepEqual(pixel(v, 18, 0), [255, 0, 0]);
});

test('vdp render: per-line horizontal scroll gives each line its own offset', () => {
  const v = basicVdp();
  v.reg[11] = 0x03; // per-line
  solidTile(v, 1, 1);
  fillPlane(v, 0xc000, 0x0000);
  v.vram[0xc000] = 0x00; v.vram[0xc001] = 0x01;
  for (let line = 0; line < 4; line++) {
    v.vram[0xfc00 + line * 4] = 0;
    v.vram[0xfc01 + line * 4] = line * 8;
  }
  for (let line = 0; line < 4; line++) v.renderLine(line);
  for (let line = 0; line < 4; line++) {
    assert.deepEqual(pixel(v, line * 8 + 2, line), [255, 0, 0], `line ${line}`);
  }
});

test('vdp render: the window replaces plane A on its own rows', () => {
  const v = basicVdp();
  solidTile(v, 1, 1); // red, plane A
  solidTile(v, 3, 3); // blue, window
  fillPlane(v, 0xc000, 0x0001);
  fillPlane(v, 0xb000, 0x0003);
  v.reg[18] = 0x02;   // window covers lines 0..15 (upward from the top)
  v.renderLine(4);
  assert.deepEqual(pixel(v, 100, 4), [0, 0, 255]);
  v.renderLine(40);
  assert.deepEqual(pixel(v, 100, 40), [255, 0, 0]);
});

test('vdp render: a sprite draws over the planes', () => {
  const v = basicVdp();
  solidTile(v, 1, 1);
  solidTile(v, 2, 2);
  fillPlane(v, 0xc000, 0x0001);
  // One 1x1 sprite of tile 2 at screen (32, 8).
  const sat = 0xf000;
  const put = (o, w) => { v.vram[sat + o] = (w >> 8) & 0xff; v.vram[sat + o + 1] = w & 0xff; };
  put(0, 8 + 128);      // Y
  v.vram[sat + 2] = 0;  // 1x1
  v.vram[sat + 3] = 0;  // end of list
  put(4, 0x0002);       // tile 2, palette 0
  put(6, 32 + 128);     // X
  v.renderLine(10);
  assert.deepEqual(pixel(v, 34, 10), [0, 255, 0], 'sprite pixel');
  assert.deepEqual(pixel(v, 60, 10), [255, 0, 0], 'plane pixel beside it');
});

test('vdp render: shadow mode darkens a low-priority pixel', () => {
  const v = basicVdp();
  v.reg[12] |= 0x08; // shadow/highlight
  solidTile(v, 1, 1);
  fillPlane(v, 0xc000, 0x0001); // low priority
  v.renderLine(10);
  const [r] = pixel(v, 100, 10);
  assert.ok(r > 0 && r < 255, `shadowed red is ${r}, expected between 0 and 255`);
  fillPlane(v, 0xc000, 0x8001); // high priority
  v.renderLine(10);
  assert.deepEqual(pixel(v, 100, 10), [255, 0, 0]);
});

test('vdp render: display off paints the backdrop colour', () => {
  const v = basicVdp();
  solidTile(v, 1, 1);
  fillPlane(v, 0xc000, 0x0001);
  v.reg[1] &= ~0x40;
  v.reg[7] = 0x02; // backdrop = palette 0 colour 2 = green
  v.renderLine(10);
  assert.deepEqual(pixel(v, 100, 10), [0, 255, 0]);
});

test('vdp: state round-trips exactly', () => {
  const v = basicVdp();
  solidTile(v, 1, 1);
  fillPlane(v, 0xc000, 0x0001);
  v.beginLine(30);
  v.renderLine(30);
  const s = v.getState();
  const w = new MdVdp();
  w.setState(s);
  assert.deepEqual(w.getState(), s);
  w.renderLine(30);
  // The frame buffer is not part of the state, so redrawing has to reproduce
  // the same picture from the state alone.
  assert.deepEqual(pixel(w, 100, 30), pixel(v, 100, 30));
});

// ===========================================================================
// sound
// ===========================================================================

test('ym2612: the DAC replaces channel 6', () => {
  const y = new Ym2612();
  y.write(0, 0x2b); y.write(1, 0x80); // DAC on
  y.write(0, 0x2a); y.write(1, 0xff); // full scale
  assert.equal(y.dacEnable, true);
  assert.equal(y.dacData, 0xff);
  y.ch[5].left = true; y.ch[5].right = true;
  const l = new Float32Array(8), r = new Float32Array(8);
  y.render(l, r, 8);
  assert.ok(l[0] > 0.1, `DAC should drive the output, got ${l[0]}`);
  y.write(0, 0x2b); y.write(1, 0x00);
  assert.equal(y.dacEnable, false);
});

test('ym2612: $28 addresses six channels across two banks', () => {
  const y = new Ym2612();
  y.write(0, 0x28); y.write(1, 0xf0 | 0x00); // key on channel 1
  assert.equal(y.ch[0].keyOn, 0x0f);
  y.write(0, 0x28); y.write(1, 0xf0 | 0x06); // key on channel 6
  assert.equal(y.ch[5].keyOn, 0x0f);
  y.write(0, 0x28); y.write(1, 0xf0 | 0x03); // not a channel
  assert.equal(y.ch[3].keyOn, 0);
});

test('ym2612: bank 1 registers reach channels 4-6', () => {
  const y = new Ym2612();
  y.write(2, 0xb0); y.write(3, 0x05); // channel 4 algorithm/feedback
  assert.equal(y.ch[3].alg, 5);
  y.write(2, 0xb6); y.write(3, 0x80); // channel 6 pan: left only
  assert.equal(y.ch[5].left, true);
  assert.equal(y.ch[5].right, false);
});

test('ym2612: the timers overflow into the status byte', () => {
  const y = new Ym2612();
  y.write(0, 0x24); y.write(1, 0xff);
  y.write(0, 0x25); y.write(1, 0x03); // timer A = 1023 -> period 1
  y.write(0, 0x27); y.write(1, 0x01); // start A
  y.tickTimers(4);
  assert.equal(y.read(0) & 1, 1);
  y.write(0, 0x27); y.write(1, 0x11); // reset the A flag
  assert.equal(y.read(0) & 1, 0);
});

test('ym2612: state round-trips exactly, phases included', () => {
  const y = new Ym2612();
  y.write(0, 0xa4); y.write(1, 0x22);
  y.write(0, 0xa0); y.write(1, 0x69);
  y.write(0, 0x28); y.write(1, 0xf0);
  const l = new Float32Array(64), r = new Float32Array(64);
  y.render(l, r, 64);
  const s = y.getState();
  const z = new Ym2612();
  z.setState(s);
  const l2 = new Float32Array(64), r2 = new Float32Array(64);
  y.render(l, r, 64);
  z.render(l2, r2, 64);
  assert.deepEqual(Array.from(l2), Array.from(l));
});

test('sn76489: the latch/data protocol builds a 10-bit period', () => {
  const p = new Sn76489();
  p.write(0x80 | 0x0e); // channel 0 tone, low nibble = $E
  p.write(0x0f);        // high 6 bits = $0F
  assert.equal(p.period[0], 0x0fe);
  p.write(0x90 | 0x03); // channel 0 volume = 3
  assert.equal(p.volume[0], 3);
});

test('sn76489: a silenced chip renders silence, an unsilenced one does not', () => {
  const p = new Sn76489();
  const out = new Float32Array(256);
  p.render(out, 256);
  assert.ok(out.every((v) => v === 0));
  p.write(0x80 | 0x02); p.write(0x00); // a short period
  p.write(0x90 | 0x00);                // full volume
  p.render(out, 256);
  assert.ok(out.some((v) => v !== 0));
});

test('sn76489: white and periodic noise differ', () => {
  const white = new Sn76489(), periodic = new Sn76489();
  for (const p of [white, periodic]) { p.write(0xf0); } // noise channel, full volume
  white.write(0xe4);    // white, /512
  periodic.write(0xe0); // periodic, /512
  const a = new Float32Array(4096), b = new Float32Array(4096);
  white.render(a, 4096);
  periodic.render(b, 4096);
  assert.notDeepEqual(Array.from(a), Array.from(b));
});

test('sn76489: state round-trips', () => {
  const p = new Sn76489();
  p.write(0x80 | 0x05); p.write(0x10); p.write(0x90);
  const out = new Float32Array(128);
  p.render(out, 128);
  const q = new Sn76489();
  q.setState(p.getState());
  const a = new Float32Array(128), b = new Float32Array(128);
  p.render(a, 128); q.render(b, 128);
  assert.deepEqual(Array.from(b), Array.from(a));
});

// ===========================================================================
// the machine
// ===========================================================================

test('machine: boots, draws a full screen and takes one VINT per frame', () => {
  const m = new MegaDriveMachine({ rom: buildTestRom({}) });
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.region, 'usa');
  assert.equal(Math.round(m.frameHz * 100) / 100, 59.92);
  for (let i = 0; i < 6; i++) m.stepFrame();
  assert.equal(m.frame, 6);
  assert.equal(counterOf(m), 6, 'one vertical interrupt per frame');
  const f = m.render({});
  assert.equal(f.width, 320);
  assert.equal(f.height, 224);
  let nonZero = 0;
  for (let i = 0; i < f.width * f.height; i++) {
    if (f.rgb[i * 3] || f.rgb[i * 3 + 1] || f.rgb[i * 3 + 2]) nonZero++;
  }
  assert.equal(nonZero, f.width * f.height, 'the whole screen is the solid tile');
});

test('machine: the DMA-fill cartridge fills the nametable the way hardware does', () => {
  const m = new MegaDriveMachine({ rom: buildTestRom({ useDmaFill: true }) });
  for (let i = 0; i < 8; i++) m.stepFrame();
  assert.equal((m.vdp.vram[0xc000] << 8) | m.vdp.vram[0xc001], 0x0101, 'cell 0 got a whole word');
  assert.equal((m.vdp.vram[0xc002] << 8) | m.vdp.vram[0xc003], 0x0001, 'the rest got one byte');
  const f = m.render({});
  let nonZero = 0;
  for (let i = 0; i < f.width * f.height; i++) {
    if (f.rgb[i * 3] || f.rgb[i * 3 + 1] || f.rgb[i * 3 + 2]) nonZero++;
  }
  // Everything but cell 0, which points at an empty tile.
  assert.equal(nonZero, f.width * f.height - 64);
});

test('machine: two identical runs produce identical state', () => {
  const a = new MegaDriveMachine({ rom: buildTestRom({}) });
  const b = new MegaDriveMachine({ rom: buildTestRom({}) });
  for (let i = 0; i < 25; i++) { a.stepFrame(); b.stepFrame(); }
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('machine: snapshot -> restore -> continue matches an uninterrupted run', () => {
  const m = new MegaDriveMachine({ rom: buildTestRom({}) });
  for (let i = 0; i < 10; i++) m.stepFrame();
  const s = m.snapshot();
  for (let i = 0; i < 12; i++) m.stepFrame();
  const expected = m.snapshot();
  m.restore(s);
  for (let i = 0; i < 12; i++) m.stepFrame();
  assert.deepEqual(m.snapshot(), expected);
});

test('machine: a replay across interrupt boundaries reproduces the interrupt count', () => {
  const m = new MegaDriveMachine({ rom: buildTestRom({}) });
  for (let i = 0; i < 5; i++) m.stepFrame();
  const s = m.snapshot();
  const first = [];
  for (let i = 0; i < 20; i++) { m.stepFrame(); first.push(counterOf(m)); }
  m.restore(s);
  const second = [];
  for (let i = 0; i < 20; i++) { m.stepFrame(); second.push(counterOf(m)); }
  assert.deepEqual(second, first);
  assert.equal(first[19] - first[0], 19, 'the interrupts really did keep coming');
});

test('machine: restore re-asserts the interrupt level on the CPU', () => {
  const m = new MegaDriveMachine({ rom: buildTestRom({}) });
  for (let i = 0; i < 3; i++) m.stepFrame();
  // Force a pending vertical interrupt and check a restored machine drives the
  // same pins rather than waiting for the next line to re-raise them.
  m.vdp.vintPending = true;
  m.vdp.reg[1] |= 0x20;
  const s = m.snapshot();
  const n = new MegaDriveMachine({ rom: buildTestRom({}) });
  n.restore(s);
  assert.equal(n.cpu.irq, 6);
});

test('machine: a snapshot holds no cartridge', () => {
  const m = new MegaDriveMachine({ rom: buildTestRom({}) });
  m.stepFrame();
  const s = m.snapshot();
  const seen = JSON.stringify(Object.keys(s));
  assert.equal(seen.includes('rom'), false);
  assert.equal(seen.includes('cart'), false);
  // ...and restoring into a machine with the same cartridge is enough.
  const n = new MegaDriveMachine({ rom: buildTestRom({}) });
  n.restore(s);
  assert.deepEqual(n.snapshot(), s);
});

test('machine: a 3-button pad reads through the TH multiplexer', () => {
  const m = new MegaDriveMachine({ rom: buildIdleRom() });
  m.ioCtrl[0] = 0x40; // TH is an output, everything else an input
  m.setPad((1 << BUTTON.START) | (1 << BUTTON.UP) | (1 << BUTTON.C));
  m.ioData[0] = 0x40;                       // TH high
  let v = m._padRead(0);
  assert.equal(v & 0x01, 0, 'UP is pressed');
  assert.equal((v >> 5) & 1, 0, 'C is pressed');
  m.ioData[0] = 0x00;                       // TH low
  v = m._padRead(0);
  assert.equal(v & 0x01, 0, 'UP is still pressed');
  assert.equal((v >> 5) & 1, 0, 'START is pressed');
  assert.equal((v >> 4) & 1, 1, 'A is not');
  m.setPad(0);
  m.ioData[0] = 0x40;
  assert.equal(m._padRead(0) & 0x3f, 0x3f, 'nothing pressed reads all ones');
});

test('machine: the Z80 starts held in reset and the 68000 can release it', () => {
  const m = new MegaDriveMachine({ rom: buildIdleRom() });
  assert.equal(m.z80Running, false);
  m._write16(0xa11200, 0x0100); // release reset
  m._write16(0xa11100, 0x0000); // release the bus
  assert.equal(m.z80Running, true);
  m._write16(0xa11100, 0x0100); // take the bus back
  assert.equal(m.z80Running, false);
  assert.equal(m._read16(0xa11100), 0x0000, 'bus granted reads as 0');
});

test('machine: the Z80 bank register is a shift register', () => {
  const m = new MegaDriveMachine({ rom: buildIdleRom() });
  // Writing $02 nine times, LSB first, builds bank $1FF... write 1s instead.
  for (let i = 0; i < 9; i++) m._z80Write(0x6000, 1);
  assert.equal(m.z80Bank, 0x1ff);
  for (let i = 0; i < 9; i++) m._z80Write(0x6000, 0);
  assert.equal(m.z80Bank, 0);
});

test('machine: the Z80 sees the cartridge through its bank window', () => {
  const rom = buildIdleRom();
  const m = new MegaDriveMachine({ rom });
  m.z80Bank = 0; // window at $000000
  assert.equal(m._z80Read(0x8000), rom[0]);
  assert.equal(m._z80Read(0x8100), rom[0x100]);
  m.z80Bank = 1; // window at $008000
  assert.equal(m._z80Read(0x8000), rom[0x8000] ?? 0xff);
});

test('machine: a 68000 word write to Z80 RAM writes only the high byte', () => {
  const m = new MegaDriveMachine({ rom: buildIdleRom() });
  m._write16(0xa00010, 0xabcd);
  assert.equal(m.z80ram[0x10], 0xab);
  assert.equal(m.z80ram[0x11], 0x00);
  assert.equal(m._read16(0xa00010), 0xabab, 'and a word read sees the byte twice');
});

test('machine: work RAM is mirrored across the top of the map', () => {
  const m = new MegaDriveMachine({ rom: buildIdleRom() });
  m._write16(0xff0000, 0x1234);
  assert.equal(m._read16(0xff0000), 0x1234);
  assert.equal(m._read16(0xe00000), 0x1234, 'the same RAM at $E00000');
  assert.equal(m._read8(0xffff0001), 0x34);
});

test('machine: the version register follows the region', () => {
  const m = new MegaDriveMachine({ rom: buildTestRom({}), region: 'japan' });
  assert.equal(m._versionByte() & 0x80, 0, 'domestic');
  const u = new MegaDriveMachine({ rom: buildTestRom({}), region: 'usa' });
  assert.equal(u._versionByte() & 0x80, 0x80, 'overseas');
  assert.equal(u._versionByte() & 0x40, 0, 'NTSC');
  const e = new MegaDriveMachine({ rom: buildTestRom({}), region: 'europe' });
  assert.equal(e._versionByte() & 0x40, 0x40, 'PAL');
  assert.equal(e.linesPerFrame, 313);
  assert.ok(e.frameHz > 49 && e.frameHz < 51, `PAL frame rate is ${e.frameHz}`);
});

test('machine: update() emits whole frames at the machine rate', () => {
  const m = new MegaDriveMachine({ rom: buildTestRom({}) });
  let frames = 0;
  m.update(1.0, () => frames++);
  assert.equal(frames, Math.floor(m.frameHz));
  assert.equal(m.frame, frames);
});

test('machine: renderAudio fills a buffer and stays inside the rails', () => {
  const m = new MegaDriveMachine({ rom: buildTestRom({}) });
  for (let i = 0; i < 3; i++) m.stepFrame();
  // Make some noise: key on channel 1 and open the PSG.
  m.ym.write(0, 0xb0); m.ym.write(1, 0x07);
  m.ym.write(0, 0x40); m.ym.write(1, 0x00);
  m.ym.write(0, 0xa4); m.ym.write(1, 0x22);
  m.ym.write(0, 0xa0); m.ym.write(1, 0x69);
  m.ym.write(0, 0x28); m.ym.write(1, 0xf0);
  m.psg.write(0x80 | 0x02); m.psg.write(0x02); m.psg.write(0x90);
  const buf = new Float32Array(512);
  m.renderAudio(buf, 512);
  assert.ok(buf.some((v) => v !== 0), 'something came out');
  assert.ok(buf.every((v) => v >= -1 && v <= 1), 'and it stayed in range');
});

test('machine: the indexed render path gives the host what it expects', () => {
  const m = new MegaDriveMachine({ rom: buildTestRom({}) });
  for (let i = 0; i < 4; i++) m.stepFrame();
  const f = m.render({ indexed: true, analog: true });
  assert.equal(f.width, 320);
  assert.equal(f.height, 224);
  assert.equal(f.pixels.length, 320 * 224);
  assert.equal(f.drive.length, 320 * 224 * 3);
  assert.ok(f.pixels.some((v) => v !== 0));
});
