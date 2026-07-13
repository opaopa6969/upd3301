// quick & dirty: can the original PC-8801's N88-BASIC boot on our stack
// with minimal port stubs? (DIP-SW reads, bank writes ignored, VRTC)
import { readFileSync } from 'node:fs';
import { Pc8001Machine } from '../machine.js';

const rom = readFileSync('roms/8801-N88.ROM');
const m = new Pc8001Machine({ rom });

// PC-8801 flavored port stubs on top of the PC-8001 machine
const origIn = m._in.bind(m);
m._in = (p) => {
  if (p <= 0x0b) return m.keys[p];
  if (p === 0x30) return 0xc1; // DIP-SW1: 80col, N88 mode-ish guess
  if (p === 0x31) return 0xff; // DIP-SW2
  if (p === 0x32) return 0xff; // mkII+ misc
  if (p === 0x40) return origIn(0x40); // VRTC
  if (p === 0x71) return 0xff; // ROM bank read
  if (p >= 0xfc) return 0xff; // FDD 8255 (no disk unit)
  return origIn(p);
};

// wire the VRTC interrupt: 8801 BASIC is interrupt-driven (E4h = level
// mask; VRTC is level 1 → IM2 vector table / IM1 both plausible; try both)
let intMask = 0;
const origOut = m.sys.out.bind(m.sys);
m.sys.out = (p, v) => {
  if (p === 0xe4) { intMask = v; return; }
  if (p === 0xe6) { intMask = v; return; }
  origOut(p, v);
};
for (let i = 0; i < 240; i++) {
  m.stepFrame();
  // VRTC interrupt at frame end (level 1 on the 8214 → IM2 low byte 02h?)
  m.cpu.intRequest(0x02);
}
console.log('halted=', m.cpu.halted, 'iff1=', m.cpu.iff1, 'im=', m.cpu.im);
console.log('--- screen ---');
m.screenText().forEach((l, i) => { if (l) console.log(String(i).padStart(2), '|', l); });
console.log('pc=' + m.cpu.pc.toString(16), 'crtc=', m.sys.crtc.cols + 'x' + m.sys.crtc.rows, 've=' + m.sys.crtc.ve);
