// ym2608 (OPNA / Sound Board II) — phase-0/1 scaffold. Pins the new surface:
// the second bank (FM4-6) reached via writeAddr1/writeData1, the $28 group bit,
// bank separation, ADPCM register capture, and the determinism the repo needs.
// The OPN core is exercised by test-ym2203; here we only test the additions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ym2608 } from './ym2608.js';

const hz = (buf, sr = 48000) => {
  let zc = 0, prev = 0;
  for (const v of buf) { if (prev <= 0 && v > 0) zc++; prev = v; }
  return zc * sr / buf.length;
};

// a 4-carrier (alg 7) A440 patch, driven onto whichever bank `w` writes.
function patch(w) {
  w(0xb0, 7);
  for (const s of [0x30, 0x34, 0x38, 0x3c]) w(s, 0x01);
  for (const s of [0x40, 0x44, 0x48, 0x4c]) w(s, 0x00);
  for (const s of [0x50, 0x54, 0x58, 0x5c]) w(s, 0x1f);
  for (const s of [0x60, 0x64, 0x68, 0x6c]) w(s, 0x00);
  for (const s of [0x70, 0x74, 0x78, 0x7c]) w(s, 0x00);
  for (const s of [0x80, 0x84, 0x88, 0x8c]) w(s, 0x0f);
  const fnum = Math.round(440 * 72 * (1 << 20) / (3993600 * (1 << 3)));
  w(0xa4, (4 << 3) | ((fnum >> 8) & 7));
  w(0xa0, fnum & 0xff);
}

test('OPNA FM4-6: bank-1 FM plays at the programmed pitch', () => {
  const y = new Ym2608({ sampleRate: 48000 });
  const w1 = (a, v) => { y.writeAddr1(a); y.writeData1(v); };
  patch(w1);              // program FM channel 4 (bank 1, ch-in-group 0)
  y.writeAddr(0x28); y.writeData(0xf4); // key on: 0xf0 ops | 0x04 group | 0x00 ch
  const buf = new Float32Array(24000);
  y.render(buf);
  const f = hz(buf);
  assert.ok(Math.abs(f - 440) < 8, `FM4 A440, got ${f.toFixed(0)}`);
});

test('OPNA $28 group bit: bit2 selects FM4-6, not FM1-3', () => {
  const peak = (b) => { let p = 0; for (const v of b) p = Math.max(p, Math.abs(v)); return p; };
  // program ONLY channel 4 (bank 1). Channel 1 (bank 0) is left at reset.
  const mk = (keyVal) => {
    const y = new Ym2608({ sampleRate: 48000 });
    patch((a, v) => { y.writeAddr1(a); y.writeData1(v); });
    y.writeAddr(0x28); y.writeData(keyVal);
    const b = new Float32Array(4800); y.render(b); return peak(b);
  };
  // 0xf4 = group bit set → keys FM4 (programmed) → sound
  assert.ok(mk(0xf4) > 0.05, 'group bit set should key the programmed FM4');
  // 0xf0 = group bit clear → keys FM1 (un-programmed, TL=max) → silence
  assert.ok(mk(0xf0) < 0.001, 'group bit clear keys FM1 (unprogrammed) → silent');
});

test('OPNA banks separate: a bank-1 write does not touch bank-0 state', () => {
  const y = new Ym2608({ sampleRate: 48000 });
  y.writeAddr(0x40); y.writeData(0x11);   // bank0 ch0 op TL
  y.writeAddr1(0x40); y.writeData1(0x22);  // bank1 ch4 op TL
  assert.equal(y.reg[0x40], 0x11);
  assert.equal(y.reg1[0x40], 0x22);
  assert.equal(y.ch[0].ops[0].tl, 0x11);
  assert.equal(y.ch[3].ops[0].tl, 0x22);
});

test('OPNA ADPCM registers are captured for later decode', () => {
  const y = new Ym2608({ sampleRate: 48000 });
  const w1 = (a, v) => { y.writeAddr1(a); y.writeData1(v); };
  w1(0x00, 0x3f);          // rhythm key: all six drums
  w1(0x01, 0x2a);          // rhythm total level
  w1(0x08, 0xc5);          // rhythm ch0: L/R=11, level=5
  w1(0x13, 0x12); w1(0x12, 0x34); // ADPCM-B start = 0x1234
  assert.equal(y.rhythm.key, 0x3f);
  assert.equal(y.rhythm.total, 0x2a);
  assert.equal(y.rhythm.lr[0], 0b11);
  assert.equal(y.rhythm.level[0], 5);
  assert.equal(y.adpcmB.start, 0x1234);
});

test('OPNA determinism: same writes → identical samples', () => {
  const run = () => {
    const y = new Ym2608({ sampleRate: 48000 });
    const w1 = (a, v) => { y.writeAddr1(a); y.writeData1(v); };
    patch(w1); y.writeAddr(0x28); y.writeData(0xf4);
    const b = new Float32Array(8000); y.render(b); return b;
  };
  const a = run(), b = run();
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
});

test('OPNA still is an OPN: bank-0 SSG + FM1-3 unaffected', () => {
  const y = new Ym2608({ sampleRate: 48000 });
  const w = (a, v) => { y.writeAddr(a); y.writeData(v); };
  const period = Math.round(3993600 / (32 * 440));
  w(0, period & 0xff); w(1, period >> 8); w(7, 0b111110); w(8, 15);
  const buf = new Float32Array(48000); y.render(buf);
  assert.ok(Math.abs(hz(buf) - 440) < 6, 'SSG still 440Hz on OPNA');
});
