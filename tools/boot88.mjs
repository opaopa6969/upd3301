import { readFileSync } from 'node:fs';
import { Pc8801Machine } from '../machine88.js';
const main = readFileSync(process.argv[2] ?? 'roms/N88.ROM');
const ext = (() => { try { return readFileSync('roms/N88EXT.ROM'); } catch { return null; } })();
const n80 = (() => { try { return readFileSync('roms/N80SR.ROM'); } catch { return null; } })();
const frames = parseInt(process.argv[3] ?? '240', 10);
const m = new Pc8801Machine({ main, ext, n80 });
for (let i = 0; i < frames; i++) m.stepFrame();
console.log('--- screen ---');
m.screenText().forEach((l, i) => { if (l) console.log(String(i).padStart(2), '|', l); });
console.log('pc=' + m.cpu.pc.toString(16), 'crtc=' + m.crtc.cols + 'x' + m.crtc.rows, 've=' + m.crtc.ve,
  'rom=' + m.romEnabled, 'ext=' + m.extBank, 'im=' + m.cpu.im, 'iff=' + m.cpu.iff1,
  'levels=' + m.intLevels, 'mask=' + m.intMaskBits.toString(2), 'pending=' + m.intPending);
