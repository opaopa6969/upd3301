// boot-nbasic — load a BYO N-BASIC ROM, run N frames, print the screen.
import { readFileSync } from 'node:fs';
import { Pc8001Machine } from '../machine.js';

const romPath = process.argv[2] ?? 'roms/N80_2.ROM';
const frames = parseInt(process.argv[3] ?? '180', 10);
const rom = readFileSync(romPath);
const m = new Pc8001Machine({ rom });
for (let i = 0; i < frames; i++) m.stepFrame();
const text = m.screenText();
console.log('--- screen after', frames, 'frames ---');
text.forEach((l, i) => { if (l) console.log(String(i).padStart(2), '|', l); });
console.log('--- crtc:', m.sys.crtc.cols + 'x' + m.sys.crtc.rows,
  'displayEnabled=' + m.sys.crtc.ve, 'pc=' + m.cpu.pc.toString(16));
