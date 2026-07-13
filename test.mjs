import test from 'node:test';
import assert from 'node:assert/strict';
import { Upd3301, STATUS, expandAttrRow, SCHEMA_VERSION } from './index.js';
import { Upd8257 } from './upd8257.js';
import {
  Pc8001TextSystem, PC8001, decodeAttrPair, expandRowStates, renderScreen,
} from './pc8001.js';

function resetTo(crtc, { cols = 80, rows = 25, lines = 8, attrs = 20 } = {}) {
  crtc.writeCommand(0x00);
  crtc.writeParam(0x80 | (cols - 2));
  crtc.writeParam(0x40 | (rows - 1));
  crtc.writeParam(0x00 | (lines - 1));
  crtc.writeParam(((7 - 1) << 5) | (14 - 2));
  crtc.writeParam(attrs - 1);
}

test('RESET parameters decode into screen geometry', () => {
  const crtc = new Upd3301();
  resetTo(crtc, { cols: 80, rows: 25, lines: 8, attrs: 20 });
  assert.equal(crtc.cols, 80);
  assert.equal(crtc.rows, 25);
  assert.equal(crtc.linesPerChar, 8);
  assert.equal(crtc.attrsPerRow, 20);
  assert.equal(crtc.vblankRows, 7);
  assert.equal(crtc.hblankChars, 14);
  assert.equal(crtc.blinkPeriod, 32);
  assert.equal(crtc.dmaBurstMode, 1);
  assert.equal(crtc.getScreen().schemaVersion, SCHEMA_VERSION);
});

test('attribute mode 1 disables attribute fetch', () => {
  const crtc = new Upd3301();
  crtc.writeCommand(0x00);
  for (const p of [78, 24, 7, 0xcc, (1 << 5) | 19]) crtc.writeParam(p);
  assert.equal(crtc.attrsPerRow, 0);
});

test('per-row DMA fetches cols + 2*attrs bytes and fills cells', () => {
  const calls = [];
  const crtc = new Upd3301({
    drq: (buf) => {
      calls.push(buf.length);
      buf.fill(0x41); // 'A'
      buf[80] = 0; buf[81] = 0xe8;
      return buf.length;
    },
  });
  resetTo(crtc);
  crtc.writeCommand(0x20); // START DISPLAY
  crtc.stepFrame();
  assert.equal(calls.length, 25);
  assert.ok(calls.every((n) => n === 120));
  assert.equal(crtc.cells[0], 0x41);
  assert.equal(crtc.cells[24 * 80 + 79], 0x41);
  assert.equal((crtc.readStatus() & STATUS.U), 0);
});

test('DMA underrun sets the U status bit and drops bit 7', () => {
  const crtc = new Upd3301({ drq: (buf) => 10 });
  resetTo(crtc);
  crtc.writeCommand(0x20);
  crtc.stepFrame();
  const s = crtc.readStatus();
  assert.ok(s & STATUS.U);
  assert.equal(s & 0x80, 0);
  // cleared after read
  assert.equal(crtc.readStatus() & STATUS.U, 0);
});

test('chip-level attribute expansion follows fill-forward rules', () => {
  const out = new Uint8Array(10);
  // pairs: (3, 0xAA), (6, 0xBB) — first back-fills to 0, last extends to end
  expandAttrRow(Uint8Array.from([3, 0xaa, 6, 0xbb, 0, 0]), 3, 10, out);
  assert.deepEqual([...out], [0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xbb, 0xbb, 0xbb, 0xbb]);
});

test('VRTC interrupt: masked by default state, fires when unmasked', () => {
  let irqs = 0;
  const crtc = new Upd3301({ drq: (b) => (b.fill(0), b.length), onIrq: () => irqs++ });
  resetTo(crtc);
  crtc.writeCommand(0x20);
  crtc.stepFrame();
  assert.equal(irqs, 0); // interruptMask starts fully masked
  crtc.writeCommand(0x40); // SET INTERRUPT MASK, ME=0 → unmasked
  crtc.stepFrame();
  assert.equal(irqs, 1);
  assert.ok(crtc.readStatus() & STATUS.E);
  assert.equal(crtc.readStatus() & STATUS.E, 0); // cleared by read
  crtc.writeCommand(0xa0); // RESET INTERRUPT drops the line
  assert.equal(crtc.irqLine, false);
});

test('cursor position, style and deterministic blink', () => {
  const crtc = new Upd3301({ drq: (b) => (b.fill(0), b.length) });
  resetTo(crtc);
  crtc.writeCommand(0x81); // LOAD CURSOR POSITION, enabled
  crtc.writeParam(12);
  crtc.writeParam(5);
  crtc.writeCommand(0x20);
  const phases = [];
  for (let i = 0; i < 64; i++) { crtc.stepFrame(); phases.push(crtc.cursorBlinkOn()); }
  const crtc2 = new Upd3301({ drq: (b) => (b.fill(0), b.length) });
  resetTo(crtc2);
  crtc2.writeCommand(0x81);
  crtc2.writeParam(12);
  crtc2.writeParam(5);
  crtc2.writeCommand(0x20);
  const phases2 = [];
  for (let i = 0; i < 64; i++) { crtc2.stepFrame(); phases2.push(crtc2.cursorBlinkOn()); }
  assert.deepEqual(phases, phases2);
  assert.ok(phases.includes(true) && phases.includes(false));
  const sc = crtc.getScreen();
  assert.equal(sc.cursor.x, 12);
  assert.equal(sc.cursor.y, 5);
  assert.equal(sc.cursor.block, false);
});

test('update(dt) is fixed-step and frame-exact', () => {
  const crtc = new Upd3301({ drq: (b) => (b.fill(0), b.length) });
  resetTo(crtc);
  crtc.writeCommand(0x20);
  for (let i = 0; i < 10; i++) crtc.update(1 / 60);
  assert.equal(crtc.frame, 10);
  crtc.update(0.5); // 30 more frames
  assert.equal(crtc.frame, 40);
});

test('μPD8257: 16-bit flip-flop writes and read-mode counting', () => {
  const mem = new Uint8Array(0x10000);
  mem[0x1234] = 0x99;
  const dmac = new Upd8257({ readMemory: (a) => mem[a] });
  dmac.writePort(8, 0x04); // enable ch2
  dmac.writePort(4, 0x34); dmac.writePort(4, 0x12); // ch2 addr = 0x1234
  dmac.writePort(5, 0x0f); dmac.writePort(5, 0x80); // read mode, count 16
  const buf = new Uint8Array(4);
  assert.equal(dmac.drqPull(2, buf), 4);
  assert.equal(buf[0], 0x99);
  assert.equal(dmac.channels[2].addr, 0x1238);
});

test('μPD8257 autoload: ch2 wraps to ch3 base at terminal count', () => {
  const mem = new Uint8Array(0x10000);
  for (let i = 0; i < 32; i++) mem[0x100 + i] = i;
  const dmac = new Upd8257({ readMemory: (a) => mem[a] });
  dmac.writePort(8, 0x84); // autoload + ch2
  dmac.writePort(4, 0x00); dmac.writePort(4, 0x01); // addr 0x100
  dmac.writePort(5, 0x07); dmac.writePort(5, 0x80); // read, 8 bytes
  const buf = new Uint8Array(8);
  dmac.drqPull(2, buf);
  assert.deepEqual([...buf], [0, 1, 2, 3, 4, 5, 6, 7]);
  dmac.drqPull(2, buf); // reloaded from ch3 → same 8 bytes again
  assert.deepEqual([...buf], [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('PC-8001 attribute pair decoding (color vs function spec)', () => {
  const c = decodeAttrPair(0xe8);
  assert.equal(c.kind, 'color');
  assert.equal(c.color, 7);
  assert.equal(c.semigraphic, false);
  const g = decodeAttrPair(0x58); // 010_1_1000: blue + semigraphic
  assert.equal(g.color, 2 /* red? no: bits7-5=010 → G=0 R=1 B=0 → 2 */);
  assert.equal(g.semigraphic, true);
  const f = decodeAttrPair(0x07);
  assert.equal(f.kind, 'function');
  assert.ok(f.reverse && f.blink && f.secret);
});

test('dual-state expansion: color change keeps function state', () => {
  const colorOut = new Uint8Array(10);
  const funcOut = new Uint8Array(10);
  // (0, reverse-on) then (5, red)
  expandRowStates(Uint8Array.from([0, 0x04, 5, 0x48, 0, 0]), 3, 10, colorOut, funcOut);
  assert.equal(funcOut[0], 0x04);
  assert.equal(funcOut[9], 0x04); // reverse survives the color change
  assert.equal(colorOut[0], 0xe8); // default white before the color pair
  assert.equal(colorOut[5], 0x48); // red from column 5
});

test('full system boots like N-BASIC and renders deterministically', () => {
  const run = () => {
    const sys = new Pc8001TextSystem();
    sys.initTextMode();
    sys.line(0).text(0, 'HELLO 3301').attrs(0, 0xe8);
    sys.line(1).text(0, 'BEER').attrs(0, 0xc8, 2, 0x28); // yellow → blue
    sys.line(2).code(0, 0b00001111).attrs(0, 0x98); // semigraphic, green
    const cgrom = new Uint8Array(256 * 16).fill(0xff);
    sys.update(1 / 60);
    return sys.render({ cgrom });
  };
  const a = run();
  const b = run();
  assert.equal(a.width, 640);
  assert.equal(a.height, 200);
  assert.deepEqual(a.pixels, b.pixels);
  // 'H' cell painted white (7), 'BEER' starts yellow (6) then blue (1) at col 2
  assert.equal(a.pixels[0], 7);
  assert.equal(a.pixels[8 * 640 + 0], 6);
  assert.equal(a.pixels[8 * 640 + 2 * 8], 1);
  // semigraphic 0x0f: left column lit for all 8 lines, right column dark
  assert.equal(a.pixels[16 * 640 + 0], 4);
  assert.equal(a.pixels[16 * 640 + 7], 0);
});

test('27-color trick: doubled DMA count alternates two screens', () => {
  const sys = new Pc8001TextSystem();
  sys.initTextMode();
  // reprogram ch2 count to two frames' worth (the BASIC magazine trick:
  // port 65h gets 8000h + 5999 instead of 8000h + 2999)
  const tc = 0x8000 | (6000 - 1);
  sys.out(0x64, PC8001.TEXT_VRAM & 0xff);
  sys.out(0x64, PC8001.TEXT_VRAM >> 8);
  sys.out(0x65, tc & 0xff);
  sys.out(0x65, tc >> 8);
  // screen A says 'A', screen B (3000 bytes later) says 'B'
  sys.memory[PC8001.TEXT_VRAM] = 0x41;
  sys.memory[PC8001.TEXT_VRAM + 3000] = 0x42;
  sys.update(1 / 60);
  const f1 = sys.crtc.cells[0];
  sys.update(1 / 60);
  const f2 = sys.crtc.cells[0];
  sys.update(1 / 60);
  const f3 = sys.crtc.cells[0];
  assert.equal(f1, 0x41);
  assert.equal(f2, 0x42);
  assert.equal(f3, 0x41); // autoload wrapped back to screen A
});

test('40-column mode doubles dots, same pixel width', () => {
  const sys = new Pc8001TextSystem();
  sys.initTextMode({ cols: 40 });
  sys.line(0, { cols: 40 }).text(0, 'W').attrs(0, 0xe8);
  const cgrom = new Uint8Array(256 * 16);
  cgrom['W'.charCodeAt(0) * 16] = 0x80; // single leftmost dot on line 0
  sys.update(1 / 60);
  const img = sys.render({ cgrom });
  assert.equal(img.width, 640);
  assert.equal(img.pixels[0], 7);
  assert.equal(img.pixels[1], 7); // doubled
  assert.equal(img.pixels[2], 0);
});

test('reverse display (START DISPLAY bit 0) inverts every cell', () => {
  const sys = new Pc8001TextSystem();
  sys.initTextMode();
  sys.line(0).attrs(0, 0xe8);
  sys.out(0x51, 0x21); // restart display with RVV=1
  const cgrom = new Uint8Array(256 * 16); // all-zero glyphs
  sys.update(1 / 60);
  const img = sys.render({ cgrom });
  assert.equal(img.pixels[0], 7); // empty glyph renders lit under reverse
});
