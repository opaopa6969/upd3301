// prove-chip-level — is this a chip emulator or a screen scraper?
// Evidence: move the text VRAM to a random address by reprogramming ONLY the
// DMA controller. A chip-accurate stack follows it (the CRTC has no idea
// where memory is; it just eats whatever the DMAC hands it). A "read VRAM at
// F3C8h and draw 80x25" emulator would show nothing.
import { Pc8001TextSystem } from '../pc8001.js';

const sys = new Pc8001TextSystem();
sys.initTextMode();

const ODD = 0x8123; // nobody's text VRAM. Not aligned. Not F3C8h.
const text = 'THE CRTC DOES NOT KNOW WHERE MEMORY IS';
for (let i = 0; i < text.length; i++) sys.memory[ODD + i] = text.charCodeAt(i);
sys.memory[ODD + 80] = 0; sys.memory[ODD + 81] = 0xe8; // attribute pair

// reprogram ONLY the DMAC's channel-2 address. Touch nothing else.
sys.out(0x64, ODD & 0xff); sys.out(0x64, ODD >> 8);

sys.update(1 / 60);
const got = String.fromCharCode(...sys.crtc.cells.subarray(0, text.length));
console.log('VRAM moved to 0x' + ODD.toString(16) + ' via the DMA controller alone.');
console.log('CRTC now displays:', JSON.stringify(got));
console.log(got === text ? '✓ chip-level: the display follows the DMA, not a hardcoded address'
                         : '✗ something is hardcoded');

// And the CRTC's geometry is whatever the ROM/BASIC programmed, not a constant
sys.out(0x51, 0x00); // RESET
for (const p of [0x80 | (40 - 2), 0x40 | (12 - 1), 0x0f, (6 << 5) | 12, 19]) sys.out(0x50, p);
sys.out(0x51, 0x20);
sys.update(1 / 60);
console.log(`\nRe-RESET the CRTC with different parameters → ${sys.crtc.cols}x${sys.crtc.rows},`,
  `${sys.crtc.linesPerChar} lines/char, hsync=${sys.crtc.hsyncHz()}Hz`);
console.log('(a 40x12 screen with 16-line characters — a geometry no PC-8001 ever booted with,');
console.log(' and the emulator just does it, because the chip would.)');
