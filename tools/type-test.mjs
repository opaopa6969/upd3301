// type-test — boot N-BASIC, type a command through the keyboard matrix,
// verify the answer. The final loop closure.
import { readFileSync } from 'node:fs';
import { Pc8001Machine } from '../machine.js';

// PC-8001 keyboard matrix (port = row, bit = column, active low)
const KEY = {
  '@': [2, 0], A: [2, 1], B: [2, 2], C: [2, 3], D: [2, 4], E: [2, 5], F: [2, 6], G: [2, 7],
  H: [3, 0], I: [3, 1], J: [3, 2], K: [3, 3], L: [3, 4], M: [3, 5], N: [3, 6], O: [3, 7],
  P: [4, 0], Q: [4, 1], R: [4, 2], S: [4, 3], T: [4, 4], U: [4, 5], V: [4, 6], W: [4, 7],
  X: [5, 0], Y: [5, 1], Z: [5, 2], '[': [5, 3], '\\': [5, 4], ']': [5, 5], '^': [5, 6], '-': [5, 7],
  0: [6, 0], 1: [6, 1], 2: [6, 2], 3: [6, 3], 4: [6, 4], 5: [6, 5], 6: [6, 6], 7: [6, 7],
  8: [7, 0], 9: [7, 1], ':': [7, 2], ';': [7, 3], ',': [7, 4], '.': [7, 5], '/': [7, 6],
  ENTER: [1, 7], SPACE: [9, 6],
};

const rom = readFileSync(process.argv[2] ?? 'roms/N80_2.ROM');
const m = new Pc8001Machine({ rom });
for (let i = 0; i < 180; i++) m.stepFrame(); // boot to Ok

function type(text) {
  for (const ch of text) {
    const k = ch === '\n' ? KEY.ENTER : ch === ' ' ? KEY.SPACE : KEY[ch.toUpperCase()];
    if (!k) throw new Error('no key for ' + ch);
    m.keyDown(k[0], k[1]);
    for (let i = 0; i < 4; i++) m.stepFrame();
    m.keyUp(k[0], k[1]);
    for (let i = 0; i < 4; i++) m.stepFrame();
  }
}

type('PRINT 3301\n');
for (let i = 0; i < 30; i++) m.stepFrame();
console.log('--- screen ---');
m.screenText().forEach((l, i) => { if (l) console.log(String(i).padStart(2), '|', l); });
