// ym2608 (OPNA / Sound Board II) — phase-0/1 scaffold. Pins the new surface:
// the second bank (FM4-6) reached via writeAddr1/writeData1, the $28 group bit,
// bank separation, ADPCM register capture, and the determinism the repo needs.
// The OPN core is exercised by test-ym2203; here we only test the additions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ym2608 } from './ym2608.js';
import { loadRhythmRom } from './tools/load-rhythm-rom.mjs';

const peak = (b) => { let p = 0; for (const v of b) p = Math.max(p, Math.abs(v)); return p; };
const { samples: RHYTHM, rate: RHYTHM_RATE } = loadRhythmRom();

// build an OPNA with the drum ROM loaded and a small bank-1 writer
function opnaWithDrums() {
  const y = new Ym2608({ sampleRate: 48000 });
  y.setRhythmRom(RHYTHM, RHYTHM_RATE);
  const w1 = (a, v) => { y.writeAddr1(a); y.writeData1(v); };
  return { y, w1 };
}

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

// ---- ADPCM-A rhythm (the drums) -------------------------------------------

test('rhythm ROM loads: six drums, non-empty PCM', () => {
  assert.equal(RHYTHM.length, 6);
  for (const d of RHYTHM) assert.ok(d.length > 100, 'each drum has samples');
});

test('rhythm: keying a drum ($00 bit) makes non-silent audio; dump silences', () => {
  const { y, w1 } = opnaWithDrums();
  w1(0x01, 0x3f);          // total level max
  w1(0x08, 0xc0 | 0x1f);   // BD (drum 0): pan L+R, individual level max
  w1(0x00, 0x01);          // key-on BD (bit0, bit7=0)
  const L = new Float32Array(20000), R = new Float32Array(20000);
  y.renderRhythm(L, R);
  assert.ok(peak(L) > 0.05 && peak(R) > 0.05, 'BD keyed → both sides sound');

  // a fresh voice, then dump before it plays → silence
  const { y: y2, w1: w2 } = opnaWithDrums();
  w2(0x01, 0x3f); w2(0x08, 0xc0 | 0x1f);
  w2(0x00, 0x80 | 0x01);   // bit7=1 → dump BD (never keyed)
  const L2 = new Float32Array(8000), R2 = new Float32Array(8000);
  y2.renderRhythm(L2, R2);
  assert.ok(peak(L2) < 1e-6, 'dump of an un-keyed drum stays silent');
});

test('rhythm: the six drums trigger independently on their own $00 bits', () => {
  for (let i = 0; i < 6; i++) {
    const { y, w1 } = opnaWithDrums();
    w1(0x01, 0x3f);
    w1(0x08 + i, 0xc0 | 0x1f);   // pan+level for drum i
    w1(0x00, 1 << i);            // key only drum i
    const L = new Float32Array(RHYTHM[i].length + 4000), R = new Float32Array(L.length);
    y.renderRhythm(L, R);
    assert.ok(peak(L) > 0.02, `drum ${i} sounds on bit ${i}`);
    // and a DIFFERENT bit must not key it: key drum (i+1)%6 only, expect drum i silent-ish
    const { y: y2, w1: w2 } = opnaWithDrums();
    w2(0x01, 0x3f); w2(0x08 + i, 0xc0 | 0x1f);
    w2(0x00, 1 << ((i + 1) % 6));  // key a different drum; drum i not keyed
    const A = new Float32Array(6000), B = new Float32Array(6000);
    y2.renderRhythm(A, B);
    // drum i has no pan set for the OTHER drum, so any sound is the other drum's
    // (its $08+.. level is 0 → silent). This pins "bit n keys drum n only".
    assert.ok(peak(A) < 1e-6, `only the addressed drum keys (bit ${(i + 1) % 6} did not key drum ${i})`);
  }
});

test('rhythm: L/R pan bits route the drum', () => {
  const { y, w1 } = opnaWithDrums();
  w1(0x01, 0x3f);
  w1(0x08, 0x80 | 0x1f);   // BD: L only (bit7), R off
  w1(0x00, 0x01);
  const L = new Float32Array(20000), R = new Float32Array(20000);
  y.renderRhythm(L, R);
  assert.ok(peak(L) > 0.05, 'left has signal');
  assert.ok(peak(R) < 1e-6, 'right is silent (pan = L only)');
});

test('rhythm: individual level sets relative loudness (monotonic)', () => {
  const bdPeak = (level) => {
    const { y, w1 } = opnaWithDrums();
    w1(0x01, 0x3f);                 // total max
    w1(0x08, 0xc0 | (level & 0x1f)); // BD pan both, given level
    w1(0x00, 0x01);
    const L = new Float32Array(20000), R = new Float32Array(20000);
    y.renderRhythm(L, R);
    return peak(L);
  };
  const hi = bdPeak(31), mid = bdPeak(23), lo = bdPeak(15);
  assert.ok(hi > mid && mid > lo, `louder register → louder drum (${hi.toFixed(3)} > ${mid.toFixed(3)} > ${lo.toFixed(3)})`);
});

test('rhythm: total level attenuates the whole bus', () => {
  const p = (total) => {
    const { y, w1 } = opnaWithDrums();
    w1(0x01, total & 0x3f);
    w1(0x08, 0xc0 | 0x1f);
    w1(0x00, 0x01);
    const L = new Float32Array(20000), R = new Float32Array(20000);
    y.renderRhythm(L, R);
    return peak(L);
  };
  assert.ok(p(0x3f) > p(0x20), 'higher total level is louder');
});

test('rhythm: deterministic — same key writes → identical samples', () => {
  const run = () => {
    const { y, w1 } = opnaWithDrums();
    w1(0x01, 0x3f); w1(0x08, 0xdf); w1(0x0a, 0xdf);
    w1(0x00, 0x05); // BD + TOP together
    const L = new Float32Array(9000), R = new Float32Array(9000);
    y.renderRhythm(L, R); return { L, R };
  };
  const a = run(), b = run();
  for (let i = 0; i < a.L.length; i++) { assert.equal(a.L[i], b.L[i]); assert.equal(a.R[i], b.R[i]); }
});

test('rhythm folds into render(): FM6 + drums are non-silent through the board', () => {
  const { y, w1 } = opnaWithDrums();
  w1(0x01, 0x3f); w1(0x08, 0xdf); w1(0x00, 0x01); // a drum
  const mono = new Float32Array(20000);
  y.render(mono);
  assert.ok(peak(mono) > 0.05, 'render() carries the rhythm bus (board-processed)');
  // determinism of the full mono path
  const y2 = new Ym2608({ sampleRate: 48000 }); y2.setRhythmRom(RHYTHM, RHYTHM_RATE);
  y2.writeAddr1(0x01); y2.writeData1(0x3f); y2.writeAddr1(0x08); y2.writeData1(0xdf);
  y2.writeAddr1(0x00); y2.writeData1(0x01);
  const mono2 = new Float32Array(20000); y2.render(mono2);
  for (let i = 0; i < mono.length; i++) assert.equal(mono[i], mono2[i]);
});

test('rhythm: no ROM loaded → render() still works, drums silent (FM only)', () => {
  const y = new Ym2608({ sampleRate: 48000 }); // no setRhythmRom
  const w1 = (a, v) => { y.writeAddr1(a); y.writeData1(v); };
  w1(0x01, 0x3f); w1(0x08, 0xdf); w1(0x00, 0x3f); // key all drums, but no ROM
  const mono = new Float32Array(4000); y.render(mono);
  assert.ok(peak(mono) < 1e-6, 'without a rhythm ROM the drums add nothing');
});

// ---- Timer-A status = the SB2 detection flag (0x01), from a real timer ----

test('Timer-A overflow sets status bit0 (== 0x01) when enabled — real detection flag', () => {
  const y = new Ym2608({ sampleRate: 48000 });
  const w = (a, v) => { y.writeAddr(a); y.writeData(v); };
  w(0x24, 0xff); w(0x25, 0x03);   // Timer A period
  w(0x27, 0x05);                   // load A (b0) + enable A (b2)
  assert.equal(y.readStatus() & 1, 0, 'no overflow yet');
  y.tickTimers(4096);              // run past one period
  assert.equal(y.readStatus(), 0x01, 'status reads 0x01 — the value the SB2 probe wants');
});

test('Timer-A flag is enable-gated (hardware model): no enable → no flag', () => {
  const y = new Ym2608({ sampleRate: 48000 });
  const w = (a, v) => { y.writeAddr(a); y.writeData(v); };
  w(0x24, 0xff); w(0x25, 0x03);
  w(0x27, 0x01);                   // load A only, enable bit CLEAR
  y.tickTimers(4096);
  assert.equal(y.readStatus() & 1, 0, 'flag not set without the enable bit');
});

test('Timer-A reset ($27 b4) clears the flag', () => {
  const y = new Ym2608({ sampleRate: 48000 });
  const w = (a, v) => { y.writeAddr(a); y.writeData(v); };
  w(0x24, 0xff); w(0x25, 0x03); w(0x27, 0x05);
  y.tickTimers(4096);
  assert.equal(y.readStatus() & 1, 1);
  w(0x27, 0x15);                   // b4 = reset A flag (keep load+enable)
  assert.equal(y.readStatus() & 1, 0, 'flag cleared by reset bit');
});
