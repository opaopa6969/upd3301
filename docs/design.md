**English** · [日本語](./design.ja.md)

# Design — upd3301

## Contract (suite-contract compliant)

- Pure, zero-dependency JavaScript. No DOM, no `three`, no `Math.random`.
- Deterministic: same port writes + same memory + same `update(dt)` sequence
  → bit-identical screens. Blink phases derive from the frame counter only.
- Fixed step: `update(dt)` accumulates seconds and executes whole frames at
  `frameHz` (default 60). `stepFrame()` is exposed for tests.
- Output is plain data + `schemaVersion`: `getScreen()` returns scalars and
  typed arrays (cells, raw attribute pairs, expanded attributes); the core
  does not decide what attribute bytes *mean* — downstream reads and decides.

## Layering / dependency direction

```
index.js  (μPD3301 chip — knows nothing about memory, colors, PC-8001)
upd8257.js (μPD8257 DMA — knows nothing about the CRTC)
   ↑ both imported by
pc8001.js (wiring + attribute semantics + renderer — the "downstream")

crt.js   (physical layer 1: phosphor — consumes GRB-indexed frames)
tube.js  (physical layer 2: mask/glass — consumes linear light planes)
   ↑ all composed only by
demo/    (browser demo, injects a hand-made CGROM)
```

The logical stack (index/upd8257/pc8001) and the physical stack (crt/tube)
never import each other; they meet only at the demo/test level, connected by
plain data (indexed pixels → luminance planes → RGBA).

`index.js` and `upd8257.js` never import siblings. The coordinator that
closes the loop (DRQ → DMA pull → row bytes) is `Pc8001TextSystem`.

## Key schemas

`getScreen()` (schemaVersion 1):
`{cols, rows, linesPerChar, skipLine, reverseDisplay, displayEnabled, frame,
cells: u8[rows*cols], attrs: u8[rows*cols], attrPairs: u8[rows*attrsPerRow*2],
attrsPerRow, attrMode, cursor {x, y, enabled, blink, block, on}, attrBlinkOn}`

`renderScreen()` → `{width, height, pixels: u8[w*h] (0..7 GRB index),
schemaVersion}`.

## Decisions

- **DRQ as a pull callback.** The chip calls `drq(buf)` once per row and
  expects `cols + 2×attrsPerRow` bytes; a short return sets the U status bit
  (underrun) and drops the undocumented status bit 7, like hardware.
- **Attribute expansion** follows MAME's `default_attr_fetch` (fill-forward;
  first pair back-fills to column 0; position 0 on non-first pairs = end of
  row, which is how N-BASIC pads unused slots).
- **PC-8001 dual-state decode** lives outside the chip: color specs (bit3=1)
  and function specs (bit3=0) each update their own running state, so a color
  change never resets reverse/blink.
- **CGROM is injected.** The real character generator ROM is copyrighted;
  tests use synthetic glyphs, the demo ships a hand-drawn 5×7 font.
- **Timing is frame-granular.** No dot clock; a whole frame's DMA happens
  inside `stepFrame()` row by row (same order as real hblank bursts). VRTC is
  observable as the end-of-frame interrupt/status, not as a mid-frame line.

## Non-goals

Light pen, special control characters (STATUS N), DMA character mode vs
burst mode distinction, composite-video artifact colors.

## Verification

`node --test` (16 tests): geometry decode, row DMA sizes, underrun, attribute
expansion, VRTC interrupt masking, cursor blink determinism, fixed-step
frame exactness, 8257 flip-flop/autoload, dual-state attribute decode,
full-system render determinism (bit-identical double run), the Bemaga
27-color trick (frame alternation via doubled DMA count wrapping back on
autoload), 40-column dot doubling, reverse display.
