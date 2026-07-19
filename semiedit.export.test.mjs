// node --test semiedit.export.test.mjs — verifies the PC-8001 real-hardware
// export END-TO-END through the actual μPD3301 attribute decoder:
//   cell buffer → bufToVram → sys.memory → DMA → renderScreen  ==  intended art
// and that the emitted BASIC program's DATA, run through its own reader loop,
// reproduces the same VRAM bytes. Deterministic, headless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyBuf, setColor, setDot, setGlyph, lineAttrChanges,
  VRAM, colorSpec, bufToVram, vramToBasic, vramFitError,
} from './semiedit.js';
import { Pc8001TextSystem, PC8001, ATTR } from './pc8001.js';
import { buildFont, addPlaceholderUpperHalf } from './demo/font.js';

const { cgrom } = buildFont(); addPlaceholderUpperHalf(cgrom);

// The export's constants must not drift from the emulator's.
test('export constants mirror pc8001.js', () => {
  assert.equal(VRAM.BASE, PC8001.TEXT_VRAM);
  assert.equal(VRAM.BYTES_PER_LINE, PC8001.BYTES_PER_LINE);
  assert.equal(VRAM.COLOR_FLAG, ATTR.COLOR_FLAG);
  assert.equal(VRAM.SEMIGRAPHIC, ATTR.SEMIGRAPHIC);
  // colorSpec round-trips through the emulator's fg extraction (colorSpec>>5)&7.
  for (let c = 0; c < 8; c++) assert.equal((colorSpec(c, 1) >> 5) & 7, c);
});

// Reference raster: what each cell is INTENDED to look like, decoded exactly the
// way renderScreen does (semigraphic 2×4 tile / font glyph / fg index, width80).
function refPixels(buf) {
  const cols = VRAM.COLS, rows = VRAM.ROWS, lpc = 8, W = cols * 8, H = rows * lpc;
  const px = new Uint8Array(W * H);
  for (let y = 0; y < rows; y++) for (let cx = 0; cx < cols; cx++) {
    const i = y * buf.cols + cx;
    const isText = !!(buf.text && buf.text[i]);
    const code = buf.codes[i], fg = buf.colors[i] & 7;
    for (let line = 0; line < lpc; line++) {
      let tile;
      if (isText) tile = code === 0xfc ? 0 : cgrom[code * 16 + line];
      else if (code === 0) tile = 0;
      else {
        const band = Math.min(3, (line * 4 / lpc) | 0);
        tile = (((code >> band) & 1) ? 0xf0 : 0) | (((code >> (4 + band)) & 1) ? 0x0f : 0);
      }
      const rowBase = (y * lpc + line) * W + cx * 8;
      for (let bit = 7; bit >= 0; bit--) px[rowBase + (7 - bit)] = ((tile >> bit) & 1) ? fg : 0;
    }
  }
  return { px, W, H };
}

// Run the emitted VRAM image through the real chip and return its indexed frame.
function emulate(vram) {
  const sys = new Pc8001TextSystem();
  sys.initTextMode({ cols: 80, rows: 25 });
  sys.crtc.cursorEnabled = false; // static image: no blinking cursor at (0,0)
  sys.memory.set(vram.mem, vram.base); // POKE the whole text-VRAM region
  sys.update(1 / 60); // one frame → DMA copies VRAM into the CRTC
  return sys.render({ cgrom }); // { pixels, width, height }
}

// A busy 80×25 fixture: colour bands, empty gaps, and a couple of font glyphs.
function fixture() {
  const b = emptyBuf(80, 25);
  for (let y = 0; y < 25; y++) {
    for (let x = 0; x < 80; x++) {
      if (((x + y) & 3) === 0) continue; // leave some empty (inherit) cells
      const col = 1 + ((x >> 3) + y) % 7; // 1..7 bands, changes every 8 cells
      setColor(b, x, y, col);
      // light a deterministic dot pattern (never all-zero → a real lit cell)
      setDot(b, x, y, (x + y) & 1, (x * 3 + y) & 3, true);
      setDot(b, x, y, x & 1, y & 3, true);
    }
  }
  // a few font glyphs (semigraphic flag must flip for these)
  setGlyph(b, 10, 2, 0x41); setColor(b, 10, 2, 6);
  setGlyph(b, 11, 2, 0xa1); setColor(b, 11, 2, 3);
  setGlyph(b, 40, 12, 0xc8); setColor(b, 40, 12, 5);
  return b;
}

test('bufToVram → μPD3301 render reproduces the intended picture pixel-for-pixel', () => {
  const b = fixture();
  const vram = bufToVram(b);
  const got = emulate(vram);
  const ref = refPixels(b);
  assert.equal(got.width, ref.W);
  assert.equal(got.height, ref.H);
  let diff = 0, firstAt = -1;
  for (let i = 0; i < ref.px.length; i++) if (got.pixels[i] !== ref.px[i]) { diff++; if (firstAt < 0) firstAt = i; }
  assert.equal(diff, 0, `${diff} px differ (first at index ${firstAt})`);
});

test('overRows flags rows past the 20-pair budget; count matches lineAttrChanges', () => {
  const b = emptyBuf(80, 2);
  // row 0: 42 colour changes (alternate two colours every lit cell) → over budget
  for (let x = 0; x < 42; x++) { setColor(b, x, 0, 1 + (x & 1) * 3); setDot(b, x, 0, 0, 0, true); }
  // row 1: two runs only → fine
  for (let x = 0; x < 40; x++) { setColor(b, x, 1, x < 20 ? 2 : 4); setDot(b, x, 1, 0, 0, true); }
  const vram = bufToVram(b);
  assert.deepEqual(vram.overRows, [0]);
  const counts = lineAttrChanges(b);
  assert.ok(counts[0] > 20);
  assert.equal(counts[1], 2);
});

test('a semigraphic↔glyph flip counts as an attribute change (budget honesty)', () => {
  const b = emptyBuf(4, 1);
  setColor(b, 0, 0, 2); setDot(b, 0, 0, 0, 0, true);     // red semigraphic
  setColor(b, 1, 0, 2); setDot(b, 1, 0, 0, 0, true);     // red semigraphic (same run)
  setGlyph(b, 2, 0, 0x41); setColor(b, 2, 0, 2);          // red GLYPH → flip semi flag
  setColor(b, 3, 0, 2); setDot(b, 3, 0, 0, 0, true);     // red semigraphic again → flip back
  assert.equal(lineAttrChanges(b)[0], 3); // 3 runs despite one colour
});

test('vramFitError: ORIGINAL fits, EX/UEX refused', () => {
  assert.equal(vramFitError(emptyBuf(80, 25)), null);
  assert.match(vramFitError(emptyBuf(160, 50)), /80×25/);
  assert.match(vramFitError(emptyBuf(320, 100)), /80×25/);
});

// Simulate the emitted BASIC program's reader loop over its own DATA and assert
// the resulting memory equals the VRAM image on every touched line.
test('emitted BASIC DATA, run through its reader, reproduces the VRAM bytes', () => {
  const b = fixture();
  const vram = bufToVram(b);
  const bas = vramToBasic(vram, { name: 'TEST' });
  // pull every DATA number in order
  const nums = [];
  for (const m of bas.matchAll(/^\d+\s+DATA\s+(.*)$/gm)) for (const t of m[1].split(',')) nums.push(parseInt(t, 10));
  // reader state machine: READ A; if A<0 stop; 80 codes; P; P attr bytes; zero rest
  const mem = new Uint8Array(0x10000);
  let p = 0;
  for (;;) {
    const A = nums[p++];
    if (A < 0) break;
    for (let i = 0; i < 80; i++) mem[A + i] = nums[p++];
    const P = nums[p++];
    for (let i = 0; i < P; i++) mem[A + 80 + i] = nums[p++];
    for (let i = P; i < 40; i++) mem[A + 80 + i] = 0;
  }
  assert.equal(p, nums.length); // consumed exactly, terminator included
  // every non-blank VRAM line must match what the reader poked
  const bpl = VRAM.BYTES_PER_LINE;
  for (let y = 0; y < vram.rows; y++) {
    const lb = y * bpl, addr = vram.base + lb;
    let blank = true; for (let i = 0; i < bpl; i++) if (vram.mem[lb + i]) { blank = false; break; }
    if (blank) continue;
    for (let i = 0; i < bpl; i++) assert.equal(mem[addr + i], vram.mem[lb + i], `line ${y} byte ${i}`);
  }
  // and the emulator agrees when fed the reader's memory directly
  const sys = new Pc8001TextSystem();
  sys.initTextMode({ cols: 80, rows: 25 });
  sys.crtc.cursorEnabled = false;
  sys.memory.set(mem.subarray(vram.base, vram.base + vram.rows * bpl), vram.base);
  sys.update(1 / 60);
  const got = sys.render({ cgrom }), ref = refPixels(b);
  let diff = 0; for (let i = 0; i < ref.px.length; i++) if (got.pixels[i] !== ref.px[i]) diff++;
  assert.equal(diff, 0);
});
