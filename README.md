**English** · [日本語](./README.ja.md)

# upd3301 — NEC μPD3301 CRT controller emulator

A chip-level emulator of the NEC μPD3301 CRTC and its partner in crime, the
μPD8257 DMA controller — the pair that put text on the screen of the NEC
PC-8001 (1979). Pure JavaScript, zero dependencies, deterministic, fully
testable headless.

## Why this exists (the 3301 memorial)

This repo was built to commemorate a chain of coincidences: the Cicada 3301
internet puzzle → the anime *Yanineko*'s opening chanting "3301! 3301!" →
which turns out to be the Saizeriya menu code for a draft beer → which led us
back to the most nostalgic 3301 of all, the μPD3301. It all comes back
to 3301.

## What's emulated

- **μPD3301 core** (`index.js`): command/status ports (PC-8001 I/O 51h),
  parameter port (50h), the 5-byte RESET parameter set (characters per row,
  rows, lines per character, blink rate, cursor mode, h/v blanking, attribute
  count and mode), START DISPLAY with reverse-video bit, interrupt mask,
  cursor load, per-row DMA fetch of `chars + 2×attrs` bytes, fill-forward
  attribute expansion, DMA-underrun status, VRTC end-of-frame interrupt,
  deterministic cursor/attribute blink.
- **μPD8257 model** (`upd8257.js`): 4 channels, low/high byte flip-flop,
  read-mode terminal counts, TC status, autoload (channel 2 reloads from
  channel 3 — how the PC-8001 repeats the screen every frame).
- **PC-8001 wiring** (`pc8001.js`): 64KB memory + DMAC ch2 + CRTC glued via
  the real port map (30h/50h/51h/60h–68h), text VRAM at F3C8h with 120-byte
  rows (80 chars + 20 attribute pairs), dual-state attribute decoding
  (color spec bit3=1: GRB + semigraphic; function spec bit3=0: reverse,
  blink, secret, over/underline, mono semigraphic), 2×4-block semigraphics,
  40/80-column dot doubling, and an indexed-color renderer taking an
  injectable CGROM (no copyrighted font included).

The chip core never touches memory: it raises DRQ and the DMA model feeds it
bytes, exactly like the real bus. That's also why the *Bemaga* July 1990
"MAGICAL COLOR" trick works in this emulator unmodified: program the DMA
count to two frames' worth (port 65h ← 8000h + 5999) and two screens
alternate every frame, flicker-mixing 8 colors into 27. There's a test
for it. Push it to *three* frames' worth and you get RGB plane mode:
logically full per-dot color, at 1/3 duty per gun — dim, and only watchable
on a long-persistence tube. Which is why there's a physical layer:

- **Phosphor physics** (`crt.js`): two-component decay per gun (fast flash +
  slow afterglow, approximating hyperbolic decay), differential persistence
  (P22's blue dies first, so white ghosts decay through orange), emission
  primaries (P39 renders everything green; P7 radar phosphor flashes
  blue-white and afterglows yellow), burn-in (accumulated dose lowers
  efficiency), and interlaced excitation (per-field line parity).
- **Tube physics** (`tube.js`): shadow-mask/aperture-grille/slot-mask
  transmission patterns with Gaussian beam-spot pre-blur (the mask is where
  color bleed — *nijimi* — comes from), barrel distortion from the curved
  faceplate, a faint ghost image from the inner-glass reflection, and
  corner vignette. All precomputed into LUTs; deterministic.
- **The whine**: `crtc.hsyncHz()` derives the horizontal deflection
  frequency from the programmed geometry — (25+7 rows) × 8 lines × 60 Hz =
  15360 Hz — and the demo can play it. You know the sound.

## Use

```js
import { Pc8001TextSystem } from './pc8001.js';

const sys = new Pc8001TextSystem();
sys.initTextMode();                     // program CRTC+DMAC like N-BASIC boot
sys.line(0).text(0, 'HELLO 3301').attrs(0, 0xe8);
sys.update(1 / 60);                     // fixed-step, frame-exact
const { width, height, pixels } = sys.render({ cgrom }); // 0..7 color indexes
```

Or drive the bare chip through ports: `crtc.writePort(1, 0x00)` … see
`test.mjs` for full sequences.

```sh
node --test              # 30 deterministic tests
python3 -m http.server   # from the repo root, then open http://localhost:8000/demo/
```

The demo has buttons for every layer: text/27-color/RGB-plane modes, 40/80
columns, reverse video, the four phosphors, burn-in, mask type, interlace,
and the 15 kHz whine (browser autoplay rules require the click).

## Accuracy notes

Faithful: command set, RESET parameter decoding, per-row DMA sizes, attribute
expansion semantics (fill-forward, position 0 = end of row on non-first
pairs), status bits incl. the undocumented bit 7 dropping on underrun, 8257
autoload. Approximate: timing is frame-granular (no dot-clock, no mid-frame
VRTC observation), light pen and special control characters are not
supported, blink rates follow the documented formula but weren't verified
against silicon. Browser demo is visually unverified in CI (headless smoke
test only).

## References

- MAME `src/devices/video/upd3301.cpp` (behavior reference; reimplemented,
  no code copied)
- [nkomatsu's IC collection: uPD3301](http://www.st.rim.or.jp/~nkomatsu/crtif/uPD3301.html)
- [kwhr0's PC-8001 FPGA notes](http://kwhr0.g2.xrea.com/hard/pc8001.html) (120-byte row buffer, hblank DMA)
- [EnrPc PC-8001 port map](http://cmpslv3.stars.ne.jp/Pc80/EnrPc.htm)
- [PC-8001 27-color trick](http://wwwb.pikara.ne.jp/minosoft/pc-8001/color.htm) (Bemaga 1990-07 "MAGICAL COLOR")

MIT license. Not affiliated with NEC.
