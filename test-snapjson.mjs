// snapjson round-trips, including the failure it exists to prevent.
//
// The headline case is the one that fooled a test: a raw JSON round trip empties
// every typed array in a snapshot without throwing, so a machine restores from
// blank buffers and reports success. These tests assert both halves — that raw
// JSON really does destroy a snapshot, and that snapjson really does carry it.
//
// ROM-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, stringify, parse } from './snapjson.js';

test('the trap is real: raw JSON silently empties a typed array', () => {
  // Not a hypothetical. `set()` accepts the decayed object, copies nothing, and
  // throws nothing — which is why the damage is invisible at the call site.
  const src = new Uint8Array([1, 2, 3, 4]);
  const decayed = JSON.parse(JSON.stringify(src));
  assert.ok(!ArrayBuffer.isView(decayed), 'JSON turns it into a plain object');
  const dst = new Uint8Array(4);
  dst.set(decayed);           // no throw
  assert.deepEqual(Array.from(dst), [0, 0, 0, 0], 'and copies nothing at all');
});

test('snapjson carries a typed array through JSON intact', () => {
  const src = new Uint8Array([1, 2, 3, 4, 250]);
  const back = parse(stringify({ ram: src })).ram;
  assert.ok(back instanceof Uint8Array);
  assert.deepEqual(Array.from(back), Array.from(src));
});

test('every width the machines actually use survives', () => {
  const cases = [
    new Uint8Array([0, 127, 255]),
    new Uint8ClampedArray([0, 128, 255]),
    new Int8Array([-128, 0, 127]),
    new Uint16Array([0, 40000, 65535]),
    new Int16Array([-32768, 0, 32767]),
    new Uint32Array([0, 4294967295]),
    new Int32Array([-2147483648, 2147483647]),
    new Float32Array([0.5, -1.25]),
    new Float64Array([Math.PI, -0]),
  ];
  for (const src of cases) {
    const back = parse(stringify({ v: src })).v;
    assert.equal(back.constructor, src.constructor, src.constructor.name);
    assert.deepEqual(Array.from(back), Array.from(src), src.constructor.name);
  }
});

test('lengths that are not a multiple of three round-trip', () => {
  // base64 pads in threes; the off-by-one cases are where an encoder goes wrong.
  for (let n = 0; n < 9; n++) {
    const src = new Uint8Array(n).map((_, i) => (i * 37) & 0xff);
    const back = parse(stringify({ v: src })).v;
    assert.deepEqual(Array.from(back), Array.from(src), `length ${n}`);
  }
});

test('nested structure is preserved, and plain values stay readable', () => {
  const snap = {
    schemaVersion: 1,
    cpu: { pc: 0x1234, flags: [true, false], name: 'z80' },
    ram: new Uint8Array([9, 8, 7]),
    sub: { fdc: { drives: [{ cyl: 0, disk: null }], buf: new Uint8Array([1]) } },
    list: [new Uint16Array([1, 2]), 3, 'four'],
  };
  const text = stringify(snap);
  // Plain fields are still legible in the JSON — the point of tagging only the
  // buffers rather than encoding the whole thing.
  assert.ok(text.includes('"pc":4660'), 'plain numbers stay plain');
  assert.ok(text.includes('"name":"z80"'), 'plain strings stay plain');

  const back = parse(text);
  assert.equal(back.cpu.pc, 0x1234);
  assert.deepEqual(back.cpu.flags, [true, false]);
  assert.deepEqual(Array.from(back.ram), [9, 8, 7]);
  assert.deepEqual(Array.from(back.sub.fdc.buf), [1]);
  assert.equal(back.sub.fdc.drives[0].disk, null);
  assert.deepEqual(Array.from(back.list[0]), [1, 2]);
  assert.equal(back.list[2], 'four');
});

test('a large buffer costs four thirds, whatever it contains', () => {
  // The rewind ring is budgeted in bytes, so the encoding has to be predictable.
  // base64 is exactly 4/3 of the payload no matter what the bytes are; an array
  // of numbers is 2x for a buffer of zeroes and roughly 4x for real data, so its
  // cost depends on the picture on screen. Measured here: 1.334x either way.
  for (const fill of [0, 0xff, 0x7f]) {
    const src = new Uint8Array(65536).fill(fill);
    const tagged = stringify({ ram: src }).length;
    const naive = JSON.stringify({ ram: Array.from(src) }).length;
    assert.ok(tagged < src.length * 1.4, `fill ${fill}: tagged ${tagged} vs ${src.length}`);
    assert.ok(tagged < naive, `fill ${fill}: tagged ${tagged} should beat naive ${naive}`);
  }
});

test('encode and decode are inverses in both directions', () => {
  const snap = { a: new Uint8Array([1, 2]), b: { c: new Int16Array([-1]) }, d: 5 };
  const once = encode(snap);
  assert.deepEqual(encode(once), once, 'encoding an encoded snapshot is a no-op');
  const back = decode(once);
  assert.deepEqual(Array.from(back.a), [1, 2]);
  assert.deepEqual(Array.from(back.b.c), [-1]);
  assert.equal(back.d, 5);
});

test('an unknown tag is refused rather than silently dropped', () => {
  // Failing loudly on a snapshot from a future version beats restoring most of
  // it — the whole point of this file is that silence is the dangerous outcome.
  assert.throws(() => decode({ $t: 'u128', d: 'AAAA' }), /unknown buffer tag/);
});

test('undefined fields do not survive, and both sides agree on that', () => {
  // JSON drops them anyway; dropping them in encode() keeps the encoded and
  // decoded shapes identical instead of differing by a key.
  const back = parse(stringify({ a: 1, b: undefined }));
  assert.deepEqual(Object.keys(back), ['a']);
});
