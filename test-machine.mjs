// Machine integration tests — need a BYO ROM (roms/N80_2.ROM); every test
// skips politely when the ROM is absent so CI stays green without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Pc8001Machine } from './machine.js';

const ROM_PATH = 'roms/N80_2.ROM';
const hasRom = existsSync(ROM_PATH);
const rom = hasRom ? readFileSync(ROM_PATH) : null;

const KEY = {
  '@': [2, 0], A: [2, 1], B: [2, 2], C: [2, 3], D: [2, 4], E: [2, 5], F: [2, 6], G: [2, 7],
  H: [3, 0], I: [3, 1], J: [3, 2], K: [3, 3], L: [3, 4], M: [3, 5], N: [3, 6], O: [3, 7],
  P: [4, 0], Q: [4, 1], R: [4, 2], S: [4, 3], T: [4, 4], U: [4, 5], V: [4, 6], W: [4, 7],
  X: [5, 0], Y: [5, 1], Z: [5, 2],
  0: [6, 0], 1: [6, 1], 2: [6, 2], 3: [6, 3], 4: [6, 4], 5: [6, 5], 6: [6, 6], 7: [6, 7],
  8: [7, 0], 9: [7, 1], ':': [7, 2], ';': [7, 3], ',': [7, 4], '.': [7, 5], '/': [7, 6],
  '-': [5, 7], '*': [1, 2], '+': [1, 3], '=': [1, 4],
  ENTER: [1, 7], SPACE: [9, 6],
};

function type(m, text) {
  for (const ch of text) {
    const k = ch === '\n' ? KEY.ENTER : ch === ' ' ? KEY.SPACE : KEY[ch.toUpperCase()];
    m.keyDown(k[0], k[1]);
    for (let i = 0; i < 4; i++) m.stepFrame();
    m.keyUp(k[0], k[1]);
    for (let i = 0; i < 4; i++) m.stepFrame();
  }
}

test('N-BASIC boots to Ok on the emulated chip stack', { skip: !hasRom && 'roms/N80_2.ROM not present (BYO-ROM)' }, () => {
  const m = new Pc8001Machine({ rom });
  for (let i = 0; i < 180; i++) m.stepFrame();
  const text = m.screenText().join('\n');
  assert.match(text, /B A S I C|BASIC/i, 'banner shows BASIC');
  assert.match(text, /O k|Ok/, 'reaches the Ok prompt');
  assert.equal(m.sys.crtc.ve, true, 'display started');
});

test('PRINT 3301 through the keyboard matrix', { skip: !hasRom && 'roms/N80_2.ROM not present (BYO-ROM)' }, () => {
  const m = new Pc8001Machine({ rom });
  for (let i = 0; i < 180; i++) m.stepFrame();
  type(m, 'PRINT 3301\n');
  for (let i = 0; i < 30; i++) m.stepFrame();
  const text = m.screenText().join('\n');
  assert.match(text, /3 3 0 1|3301/, 'the answer is 3301');
});

test('machine boot is deterministic', { skip: !hasRom && 'roms/N80_2.ROM not present (BYO-ROM)' }, () => {
  const run = () => {
    const m = new Pc8001Machine({ rom });
    for (let i = 0; i < 120; i++) m.stepFrame();
    return m.screenText().join('\n') + '|' + m.cpu.pc;
  };
  assert.equal(run(), run());
});
