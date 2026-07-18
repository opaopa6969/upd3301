// node --test semivideo.hybrid.test.mjs — deterministic, headless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbaToHybrid } from './semivideo.js';

// build an (cols*8 × rows*8) RGBA frame from a per-cell painter fn(cx,cy)->[r,g,b]
function frame(cols, rows, paint) {
  const W = cols * 8, H = rows * 8, a = new Uint8ClampedArray(W * H * 4);
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    for (let py = 0; py < 8; py++) for (let px = 0; px < 8; px++) {
      const [r, g, b] = paint(cx, cy, px, py);
      const o = ((cy * 8 + py) * W + (cx * 8 + px)) * 4;
      a[o] = r; a[o + 1] = g; a[o + 2] = b; a[o + 3] = 255;
    }
  }
  return a;
}

test('blank (black) frame → all cells empty', () => {
  const a = frame(3, 2, () => [0, 0, 0]);
  const r = rgbaToHybrid(a, 3, 2, { glyphs: [], autoLevels: false });
  assert.deepEqual([...r.codes], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...r.text], [0, 0, 0, 0, 0, 0]);
});

test('solid white cell → full semigraphic block, colour white, no glyph', () => {
  const a = frame(1, 1, () => [255, 255, 255]);
  const r = rgbaToHybrid(a, 1, 1, { glyphs: [{ code: 0x80, bits: new Uint8Array(8).fill(0xff) }], autoLevels: false });
  assert.equal(r.text[0], 0);        // ties go to semigraphic
  assert.equal(r.codes[0], 0xff);    // all 8 dots lit
  assert.equal(r.colors[0], 7);      // white
});

test('solid red cell → colour = red (GRB index 2)', () => {
  const a = frame(1, 1, () => [255, 30, 30]);
  const r = rgbaToHybrid(a, 1, 1, { glyphs: [], autoLevels: false });
  assert.equal(r.colors[0], 2);
});

test('diagonal the 2×4 grid cannot represent → a matching glyph wins', () => {
  // one lit pixel per row on the main diagonal
  const diag = (cx, cy, px, py) => (px === py ? [255, 255, 255] : [0, 0, 0]);
  const a = frame(1, 1, diag);
  const bits = Uint8Array.from([0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01]); // same diagonal
  const r = rgbaToHybrid(a, 1, 1, { glyphs: [{ code: 0x5c, bits }], autoLevels: false, glyphBias: 6 });
  assert.equal(r.text[0], 1);     // glyph chosen
  assert.equal(r.codes[0], 0x5c);
});

test('deterministic: same input → same output', () => {
  const a = frame(4, 4, (cx, cy, px, py) => [(cx * 60 + px * 8) & 255, (cy * 50 + py * 6) & 255, 40]);
  const g = [{ code: 0x2d, bits: Uint8Array.from([0, 0, 0, 0xff, 0xff, 0, 0, 0]) }];
  const r1 = rgbaToHybrid(a, 4, 4, { glyphs: g });
  const r2 = rgbaToHybrid(a, 4, 4, { glyphs: g });
  assert.deepEqual([...r1.codes], [...r2.codes]);
  assert.deepEqual([...r1.colors], [...r2.colors]);
  assert.deepEqual([...r1.text], [...r2.text]);
});
