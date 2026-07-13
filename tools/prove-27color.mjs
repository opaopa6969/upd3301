// prove-27color — evidence, not claims. Program the DMA exactly as the
// Bemaga 1990-07 trick does (port 65h ← 8000h + 5999) and show that TWO
// different screens alternate frame by frame, purely because the chips do
// what they're told. Nothing in this repo special-cases the trick.
import { Pc8001TextSystem, PC8001 } from '../pc8001.js';
import { CrtPhosphor, PHOSPHORS } from '../crt.js';

const sys = new Pc8001TextSystem();
sys.initTextMode(); // N-BASIC-style init: ch2 = F3C8h, count = 8000h + 2999

const A = PC8001.TEXT_VRAM;        // screen 1
const B = PC8001.TEXT_VRAM + 3000; // screen 2 (the next 3000 bytes)

// Same character in the same cell, different colors on the two screens
sys.line(0).code(0, 0xff).attrs(0, (2 << 5) | 0x10 | 0x08); // red block
sys.line(0, { vramBase: B }).code(0, 0xff).attrs(0, (4 << 5) | 0x10 | 0x08); // green block

// THE TRICK: tell the DMA controller the frame is twice as long.
const tc = 0x8000 | (6000 - 1); // read mode + 6000 bytes = two screens
sys.out(0x64, A & 0xff); sys.out(0x64, A >> 8);
sys.out(0x65, tc & 0xff); sys.out(0x65, tc >> 8);

const cgrom = new Uint8Array(256 * 16);
const seen = [];
const phos = new CrtPhosphor({ width: 640, height: 200, phosphor: PHOSPHORS.LONG });
for (let f = 0; f < 6; f++) {
  sys.update(1 / 60);
  const img = sys.render({ cgrom });
  seen.push(img.pixels[0]); // GRB index of the top-left dot
  phos.step(img.pixels, 1 / 60);
}
const [R, G, B2] = phos.composite();
const names = { 0: 'black', 2: 'RED', 4: 'GREEN' };
console.log('frame-by-frame color index of the same dot:',
  seen.map((v) => names[v] ?? v).join(' → '));
console.log('what the long-persistence phosphor integrates:',
  `R=${R[0].toFixed(2)} G=${G[0].toFixed(2)} B=${B2[0].toFixed(2)}`,
  '→ the eye sees YELLOW-ish: a color the 8-color hardware cannot produce.');
console.log('\nDMA state: ch2 addr=' + sys.dmac.channels[2].addr.toString(16).toUpperCase() +
  'h count=' + sys.dmac.channels[2].count + ' (autoload from ch3 wraps it back)');
