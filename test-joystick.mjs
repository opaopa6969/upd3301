// Joystick on the PC-8801 is wired to the OPN (YM2203) I/O port A/B, read by
// selecting OPN register 0x0E (pad 1) / 0x0F (pad 2) and reading the data port
// 0x45. Bits are active-low: 0=up 1=down 2=left 3=right 4=trig1 5=trig2. Games
// like Ys II poll the pad instead of the keyboard, so this path must reflect
// live pad pins, not the last register write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pc8801Machine } from './machine88.js';

const readReg = (m, reg) => { m.out(0x44, reg); return m.in(0x45); };

test('idle pad reads 0xff (nothing pressed) on OPN reg 0x0E/0x0F', () => {
  const m = new Pc8801Machine({ main: new Uint8Array(0x8000).fill(0xff) });
  assert.equal(readReg(m, 0x0e), 0xff);
  assert.equal(readReg(m, 0x0f), 0xff);
});

test('joyDown clears the matching active-low bit; joyUp restores it', () => {
  const m = new Pc8801Machine({ main: new Uint8Array(0x8000).fill(0xff) });
  m.joyDown(0);            // up on pad 1
  assert.equal(readReg(m, 0x0e) & 0x01, 0, 'up bit low while pressed');
  assert.equal(readReg(m, 0x0e), 0xfe);
  m.joyDown(3);            // + right
  assert.equal(readReg(m, 0x0e), 0xf6);
  m.joyUp(0);
  assert.equal(readReg(m, 0x0e), 0xf7, 'releasing up leaves right pressed');
});

test('pad 2 is independent of pad 1', () => {
  const m = new Pc8801Machine({ main: new Uint8Array(0x8000).fill(0xff) });
  m.joyDown(4, 1);         // trig1 on pad 2
  assert.equal(readReg(m, 0x0e), 0xff, 'pad 1 untouched');
  assert.equal(readReg(m, 0x0f), 0xef, 'pad 2 trig1 low');
});

test('non-pad OPN registers still read their stored value', () => {
  const m = new Pc8801Machine({ main: new Uint8Array(0x8000).fill(0xff) });
  m.out(0x44, 0x07); m.out(0x45, 0x38); // mixer register
  assert.equal(readReg(m, 0x07), 0x38, 'reg 0x07 is not shadowed by the pad');
});

test('joystick state survives snapshot/restore', () => {
  const m = new Pc8801Machine({ main: new Uint8Array(0x8000).fill(0xff) });
  m.joyDown(1); m.joyDown(2, 1);
  const snap = m.snapshot();
  m.joyUp(1); m.joyUp(2, 1);
  m.restore(snap);
  assert.equal(readReg(m, 0x0e), 0xfd);
  assert.equal(readReg(m, 0x0f), 0xfb);
});
