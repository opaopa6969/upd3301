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
plain data (indexed pixels → luminance planes → RGBA). Within the physical
stack, tube.js imports only pure helpers from crt.js (tintMatrix).

`index.js` and `upd8257.js` never import siblings. The coordinator that
closes the loop (DRQ → DMA pull → row bytes) is `Pc8001TextSystem`.

## Key schemas

`getScreen()` (schemaVersion 1):
`{cols, rows, linesPerChar, skipLine, reverseDisplay, displayEnabled, frame,
cells: u8[rows*cols], attrs: u8[rows*cols], attrPairs: u8[rows*attrsPerRow*2],
attrsPerRow, attrMode, cursor {x, y, enabled, blink, block, on}, attrBlinkOn}`

`renderScreen()` → `{width, height, pixels: u8[w*h] (0..7 GRB index),
ink: u8[w*h] (1 = a character dot is drawn there, 0 = blank), schemaVersion}`.

The `ink` mask is independent of colour: a black-on-graphics character (fg = 0)
writes pixel 0, indistinguishable from "no character" by colour alone. `ink`
lets the PC-8801 compositor make displayed text opaque over the graphics
plane, so a game can mask its off-screen scratch by writing black/reverse
text. Callers that don't composite ignore it.

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
- **`resetEx` validates, the port path truncates.** A RESET through the ports
  physically cannot ask for more than 80×64 with 20 attribute pairs, so
  `_applyResetParams` clamps with `Math.min` — that *is* the silicon. `resetEx`
  has no silicon to clamp against, so it throws (`MAX_EX_ROWS`,
  `MAX_EX_ROW_BYTES`) rather than quietly handing back a different screen than
  the caller asked for. It validates every argument before assigning any of
  them, so a rejected call leaves the chip on its previous geometry.
- **One blink period, two rates.** `blinkPeriodFrames()` is the single source
  for both blink rates, clamped to an even value ≥ 2, so "attributes blink at
  half the cursor rate" holds for every value including the 0 a chip carries
  before its first RESET. The port encoding only produces multiples of 16
  ((B+1)×16), so the normalisation never touches a real programmed period.

## Unverified behaviour (known unknowns)

One behaviour in this model is **not** confirmed against real hardware. It is
recorded here rather than "fixed". Do not treat the current code as authority on
it.

(A second entry — the μPD8257 clearing the byte-pair F/L on a Mode Set write —
was settled in issue #61 by following the references. Measuring 353 titles
showed that **not one of 4,135 Mode Set writes ever landed mid byte-pair**, so no
title can tell the two behaviours apart: the sweep says nothing and the citation
decides. Note that the RESET pin the references *do* attribute the clear to has
**no counterpart in this model** — no board wires a reset line to the DMAC, so
the flip-flop only ever toggles.)

### SET INTERRUPT MASK's effect on the status register (issue #22)

**What we do.** Unmasking the VRTC interrupt (`010x_xx?0`) clears E/LP/N/U and
**keeps VE**:

```js
this.interruptMask = value & 3;
if ((this.interruptMask & 1) === 0) this.status &= STATUS.VE;
```

**What MAME does** (`src/devices/video/upd3301.cpp`, verbatim):

```cpp
// Unmasking ME has the side effect of clearing all status bits except bit 7
// pc8801:laptick implictly expect text layer to be concealed by running this command alone
if (!m_me)
    m_status = 0x80;
```

MAME's `get_display_status()` is `m_status & STATUS_VE`, and `screen_update()`
draws nothing when it is false. So in MAME, unmasking VRTC **clears VE and
blanks the text layer** until the next START DISPLAY — and MAME's comment says
a real title (`pc8801:laptick`) depends on that.

**What is actually known:**

- The clearing side effect itself is agreed on by both implementations — this
  is not in dispute, and the datasheet's "cleared on read" for E is simply
  silent about it rather than contradicting it.
- The divergence is **the VE bit only**: MAME drops it, we keep it. In our
  model VE additionally has no effect on fetching — display gating lives in
  `this.ve`, a separate field that `SET INTERRUPT MASK` never touches — so
  adopting MAME's behaviour means deciding whether `this.ve` drops too.

**What is not known:**

- Whether real μPD3301 silicon clears VE here. No datasheet text was found
  covering the side effect at all; MAME's comment cites a game's observed
  requirement, not a datasheet.
- Whether real silicon clears VE. **`pc8801:laptick`, the title MAME says depends
  on it, is not among our 353**, so its claim cannot be tested here.

**Measured (2026-08-13) — and the recipe this section used to give was wrong.**

This section used to prescribe: apply `status = 0` plus `this.ve = false`, run
`tools/batch-compare.mjs` over 353 titles, compare exact-match counts. Doing that
produced a sweep **identical to the baseline down to the line** — and the reason
was not "no effect":

- `batch-compare`'s fingerprint is `ram[0xE6CD]` plus tvram/gvram non-zero counts,
  i.e. **memory contents only**. Whether the CRTC DMA-fetches them (the VE gate)
  cannot appear there. **The instrument does not measure the quantity.**
- Nor was the patch dead code. Across 353 titles only **4** ever reach a
  `SET INTERRUPT MASK` unmask (K_flappy, Makadam, burningpoint, らぷてっく), and in
  all four the VE-dropping branch **did fire**.

Measuring the screen instead (`getScreen().cells`) answers it:

| Title | Current | With MAME's behaviour |
|---|---|---|
| らぷてっく | 1600 non-blank cells | **21 (initial state), displayEnabled=false** |
| Makadam | 0, displayEnabled=true | 21, **false** |
| burningpoint | 132 | 132 (START DISPLAY restores it after the unmask) |
| K_flappy | 21, already false | unchanged |

So adopting MAME's behaviour **permanently kills らぷてっく's text plane**. MAME's
basis is not a datasheet but one comment about a game's expectation, and that game
is not available to us. **Not adopted** — neither evidence nor measurement is there.

> The lesson, replayed: **when a detector stays silent, first check that it could
> have fired.** Here the fingerprint only ever looked at memory. Judge this one on
> screen cells.

`test.mjs` pins the current behaviour ("SET INTERRUPT MASK unmask keeps VE"),
so changing it is a deliberate act with a failing test attached, not a drift.

## μPD8257: a mode-register write leaves the byte-pair flip-flop alone (settled, issue #61)

`writePort(8, …)` sets `modeReg` and nothing else; the shared low/high flip-flop
(F/L) is untouched.

**The references.** MAME's `i8257_device::write` sets `m_transfer_mode` and
nothing else; `m_msb` is cleared only in `device_reset()`. The Intel 8257
datasheet describes the F/L flip-flop as toggling on channel register accesses
and being cleared by the RESET input, and does not list a Mode Set write as
clearing it. (The datasheet PDF available to us is a scan, so this is from
secondary transcriptions of it, not extracted text — treat it as strong but not
first-hand.)

We used to clear it here (the deviation found in issue #24). The difference is
observable only when a mode write lands *between* the two halves of a byte pair,
so that was measured across 353 titles: **not one of 4,135 Mode Set writes landed
mid-pair** — `initTextMode` programs 0x68 first, which is also N-BASIC's order,
and no real title broke that pattern either. With no title able to tell the two
apart, the sweep says nothing and the citation decides.

**The RESET pin has no counterpart here.** No board wires a reset line to the
DMAC, so this model's F/L only ever toggles — the one path the references give for
clearing it does not exist.

## Non-goals

Light pen, special control characters (STATUS N), DMA character mode vs
burst mode distinction, composite-video artifact colors.

## Verification

`node --test` (49 files, 1027 test cases): geometry decode, row DMA sizes, underrun, attribute
expansion, VRTC interrupt masking, cursor blink determinism, fixed-step
frame exactness, 8257 flip-flop/autoload, dual-state attribute decode,
full-system render determinism (bit-identical double run), the Bemaga
27-color trick (frame alternation via doubled DMA count wrapping back on
autoload), 40-column dot doubling, reverse display.

Boundary cases are exercised with the values that actually break, not with
values near them: `blinkPeriod` 0/1/odd (the 2:1 blink ratio), `resetEx` with
a negative / fractional / NaN / string / oversized geometry (each one of which
produced a different failure before the guard — a bare typed-array RangeError,
a silently truncated screen, a concatenated row length, a 0×0 chip that
reported nothing, and a wedged process), the DMAC port window scanned across
0x5e–0x6b, and the two behaviours above pinned as unverified.
