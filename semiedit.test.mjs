// node --test semiedit.test.mjs — deterministic, headless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyBuf, cloneBuf, dotBit, setColor, setDot, getDot,
  lineAttrChanges, renderCells, serialize, deserialize, GRB,
  setGlyph, clearGlyph, isGlyph,
} from './semiedit.js';

test('dotBit matches semivideo packing: dy+dx*4', () => {
  assert.equal(dotBit(0, 0), 1);   // left col, top
  assert.equal(dotBit(0, 3), 8);   // left col, bottom
  assert.equal(dotBit(1, 0), 16);  // right col, top
  assert.equal(dotBit(1, 3), 128); // right col, bottom
});

test('setDot / getDot round-trip every dot', () => {
  const b = emptyBuf(2, 2);
  for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 4; dy++) {
    setDot(b, 1, 1, dx, dy, true);
    assert.equal(getDot(b, 1, 1, dx, dy), true);
  }
  assert.equal(b.codes[3], 0xff); // all 8 dots of cell (1,1) lit
  assert.equal(setDot(b, 1, 1, 0, 0, true), false); // no change → false
  assert.equal(setDot(b, 1, 1, 0, 0, false), true); // cleared → changed
  assert.equal(getDot(b, 1, 1, 0, 0), false);
});

test('setColor clamps to 3-bit and ignores out-of-range', () => {
  const b = emptyBuf(3, 1);
  assert.equal(setColor(b, 0, 0, 6), true);
  assert.equal(b.colors[0], 6);
  assert.equal(setColor(b, 0, 0, 15), true);
  assert.equal(b.colors[0], 7); // 15 & 7
  assert.equal(setColor(b, 9, 0, 1), false);
});

test('lineAttrChanges: empty cells are free, runs counted', () => {
  const b = emptyBuf(6, 1);
  // lit cells: red, red, (empty), blue, blue, red  → 3 runs (empty carries)
  const put = (x, code, col) => { b.codes[x] = code; b.colors[x] = col; };
  put(0, 0xff, 2); put(1, 0xff, 2); /* x2 empty */ put(3, 0xff, 1); put(4, 0xff, 1); put(5, 0xff, 2);
  assert.deepEqual([...lineAttrChanges(b)], [3]);
  // all one colour → 1 run
  const b2 = emptyBuf(4, 1);
  for (let x = 0; x < 4; x++) { b2.codes[x] = 0xff; b2.colors[x] = 4; }
  assert.deepEqual([...lineAttrChanges(b2)], [1]);
  // all empty → 0
  assert.deepEqual([...lineAttrChanges(emptyBuf(4, 1))], [0]);
});

test('renderCells: dimensions, determinism, dot colour', () => {
  const b = emptyBuf(2, 1);
  b.codes[0] = dotBit(0, 0); b.colors[0] = 2; // top-left dot, red
  const a = renderCells(b, 8, { grid: false });
  assert.equal(a.width, 16); assert.equal(a.height, 8);
  // pixel (0,0) is the lit top-left dot of cell 0 → red
  assert.deepEqual([a.rgba[0], a.rgba[1], a.rgba[2]], GRB[2]);
  // pixel (12,0) is in cell 1 (empty) → black
  const o = (0 * 16 + 12) * 4;
  assert.deepEqual([a.rgba[o], a.rgba[o + 1], a.rgba[o + 2]], [0, 0, 0]);
  // deterministic
  const a2 = renderCells(b, 8, { grid: false });
  assert.deepEqual([...a.rgba], [...a2.rgba]);
});

test('serialize / deserialize round-trip (incl. text layer)', () => {
  const b = emptyBuf(4, 3);
  for (let i = 0; i < 12; i++) { b.codes[i] = (i * 17) & 0xff; b.colors[i] = i & 7; }
  b.text = new Uint8Array(12); b.text[5] = 1;
  const j = JSON.parse(JSON.stringify(serialize(b, { video: 'x.mp4' })));
  assert.equal(j.video, 'x.mp4');
  const r = deserialize(j);
  assert.deepEqual([...r.codes], [...b.codes]);
  assert.deepEqual([...r.colors], [...b.colors]);
  assert.deepEqual([...r.text], [...b.text]);
  assert.throws(() => deserialize({ cols: 'x' }));
});

test('setGlyph / clearGlyph / isGlyph: lazy text layer, revert, bounds', () => {
  const b = emptyBuf(3, 2);
  assert.equal(b.text, undefined);            // layer not allocated until used
  assert.equal(isGlyph(b, 1, 0), false);
  assert.equal(setGlyph(b, 1, 0, 0xa5), true);
  assert.ok(b.text && b.text.length === 6);   // lazily allocated on first glyph
  assert.equal(isGlyph(b, 1, 0), true);
  assert.equal(b.codes[1], 0xa5);
  assert.equal(setGlyph(b, 9, 9, 1), false);  // out of range → no-op
  clearGlyph(b, 1, 0);
  assert.equal(isGlyph(b, 1, 0), false);
  assert.equal(b.codes[1], 0);                // reverted to empty semigraphic
});

test('setDot on a glyph cell reverts it to semigraphic', () => {
  const b = emptyBuf(2, 1);
  setGlyph(b, 0, 0, 0xff);                     // glyph with a busy code
  assert.equal(isGlyph(b, 0, 0), true);
  setDot(b, 0, 0, 0, 0, true);                 // start drawing dots → drop glyph
  assert.equal(isGlyph(b, 0, 0), false);
  assert.equal(b.codes[0], dotBit(0, 0));      // pattern starts clean, one dot lit
});

test('renderCells draws a glyph from cgrom when text[i] is set', () => {
  const b = emptyBuf(1, 1);
  setGlyph(b, 0, 0, 0x41); setColor(b, 0, 0, 6); // char 0x41, yellow
  const cgrom = new Uint8Array(256 * 16);
  cgrom[0x41 * 16 + 0] = 0b10000001;             // top row: leftmost + rightmost pixel
  const a = renderCells(b, 8, { grid: false, cgrom });
  assert.deepEqual([a.rgba[0], a.rgba[1], a.rgba[2]], GRB[6]); // (0,0) leftmost lit
  const rEnd = (7 * 4);                           // (7,0) rightmost lit
  assert.deepEqual([a.rgba[rEnd], a.rgba[rEnd + 1], a.rgba[rEnd + 2]], GRB[6]);
  const mid = (3 * 4);                            // (3,0) unlit → black
  assert.deepEqual([a.rgba[mid], a.rgba[mid + 1], a.rgba[mid + 2]], [0, 0, 0]);
  // without a cgrom the glyph cell falls back to its code as a dot pattern (no throw)
  assert.doesNotThrow(() => renderCells(b, 8, { grid: false }));
});

test('cloneBuf is a deep copy', () => {
  const b = emptyBuf(2, 2); b.codes[0] = 9; b.colors[0] = 3;
  const c = cloneBuf(b); c.codes[0] = 99; c.colors[0] = 1;
  assert.equal(b.codes[0], 9); assert.equal(b.colors[0], 3);
});
