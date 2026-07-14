// ym2203 — the OPN sound chip. Register writes in, samples out, same every
// time. These pin the pitch (the bug that bit me: 45 semitones sharp) and
// the determinism the whole repo relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ym2203 } from './ym2203.js';

const hz = (buf, sr = 48000) => {
  let zc = 0, prev = 0;
  for (const v of buf) { if (prev <= 0 && v > 0) zc++; prev = v; }
  return zc * sr / buf.length;
};

test('ym2203 SSG: a square wave at the programmed pitch', () => {
  const y = new Ym2203({ sampleRate: 48000 });
  const w = (a, v) => { y.writeAddr(a); y.writeData(v); };
  const period = Math.round(3993600 / (128 * 440)); // → ~440 Hz
  w(0, period & 0xff); w(1, period >> 8);
  w(7, 0b111110); // ch0 tone on, noise off
  w(8, 15);
  const buf = new Float32Array(48000);
  y.render(buf);
  const f = hz(buf);
  assert.ok(Math.abs(f - 440) < 5, `SSG ~440Hz, got ${f.toFixed(0)}`);
});

test('ym2203 FM: pitch tracks fnum/block, an octave is a doubling', () => {
  const mk = (fnum, block) => {
    const y = new Ym2203({ sampleRate: 48000 });
    const w = (a, v) => { y.writeAddr(a); y.writeData(v); };
    w(0xb0, 7); // algorithm 7 = four additive carriers
    for (const s of [0x30, 0x34, 0x38, 0x3c]) w(s, 0x01);
    for (const s of [0x40, 0x44, 0x48, 0x4c]) w(s, 0x00);
    for (const s of [0x50, 0x54, 0x58, 0x5c]) w(s, 0x1f);
    for (const s of [0x60, 0x64, 0x68, 0x6c]) w(s, 0x00);
    for (const s of [0x70, 0x74, 0x78, 0x7c]) w(s, 0x00);
    for (const s of [0x80, 0x84, 0x88, 0x8c]) w(s, 0x0f);
    w(0xa4, ((block & 7) << 3) | ((fnum >> 8) & 7));
    w(0xa0, fnum & 0xff);
    w(0x28, 0xf0);
    const buf = new Float32Array(24000);
    y.render(buf);
    return hz(buf);
  };
  const fnum = Math.round(440 * 72 * (1 << 20) / (3993600 * (1 << 3)));
  const lo = mk(fnum, 4), hi = mk(fnum, 5);
  assert.ok(Math.abs(lo - 440) < 8, `A440, got ${lo.toFixed(0)}`);
  assert.ok(Math.abs(hi / lo - 2) < 0.05, `octave up doubles pitch, got ${(hi / lo).toFixed(2)}`);
});

test('ym2203 FM: key-off releases to silence', () => {
  const y = new Ym2203({ sampleRate: 48000 });
  const w = (a, v) => { y.writeAddr(a); y.writeData(v); };
  w(0xb0, 7);
  for (const s of [0x40, 0x44, 0x48, 0x4c]) w(s, 0x00);
  for (const s of [0x50, 0x54, 0x58, 0x5c]) w(s, 0x1f);
  for (const s of [0x80, 0x84, 0x88, 0x8c]) w(s, 0x0f);
  w(0xa4, (4 << 3)); w(0xa0, 0x40);
  w(0x28, 0xf0);
  y.render(new Float32Array(4800));
  w(0x28, 0x00); // key off
  const tail = new Float32Array(48000);
  y.render(tail);
  const late = Math.max(...[...tail.slice(40000)].map(Math.abs));
  assert.ok(late < 0.001, `released to silence, tail ${late.toFixed(4)}`);
});

test('ym2203: identical register writes → identical samples', () => {
  const run = () => {
    const y = new Ym2203({ sampleRate: 48000 });
    const w = (a, v) => { y.writeAddr(a); y.writeData(v); };
    w(6, 8); w(7, 0b110111); w(8, 15); // noise on ch0
    w(0xb0, 4); w(0xa4, 4 << 3); w(0xa0, 0x40); w(0x28, 0xf0);
    const b = new Float32Array(9600);
    y.render(b);
    return b;
  };
  const a = run(), b = run();
  assert.ok(a.every((v, i) => v === b[i]), 'deterministic');
});

test('ym2203: timer A raises the status flag and the IRQ line', () => {
  const y = new Ym2203({ sampleRate: 48000 });
  const w = (a, v) => { y.writeAddr(a); y.writeData(v); };
  w(0x24, 0); w(0x25, 0); // timer A = 0 → fastest
  w(0x27, 0x01 | 0x04); // load + enable + IRQ enable A
  y.render(new Float32Array(4800));
  assert.ok(y.irq, 'timer A pulled IRQ');
  assert.ok(y.status & 1, 'status flag A set');
});
