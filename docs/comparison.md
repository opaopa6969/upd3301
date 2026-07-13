**English** · [日本語](./comparison.ja.md)

# How this compares to other emulators — we read the sources

Two questions deserved evidence, not claims: *is the hardware actually
emulated at chip level?* and *does programming the DMA for two screens
produce the 27-color trick?* We read the actual source of QUASI88 (libretro
mirror), MAME (master) and M88 (rururutan mirror).

## Summary

| | QUASI88 | MAME | M88 | **this repo** |
|---|---|---|---|---|
| Where the picture comes from | **direct VRAM read** (uses the DMAC's ch2 *address* as a base, re-reads the same memory every frame) | 8257 → dack_w → 3301 row FIFO | PD8257::RequestRead → CRTC row buffer | DRQ → DMA pull → row buffer |
| DMA terminal count | **not implemented** (register written, never read) | yes | yes | yes |
| Autoload (ch3 → ch2) | **not implemented** | yes | yes | yes |
| **27-color trick: the mechanism** | **impossible by construction** | **reproduced** | **reproduced** | **reproduced** |
| **27-color trick: the color mixing** | — | **no** (bitmap cleared every frame, no persistence) | unverified | **yes** (phosphor integrates over time) |
| Attribute (pos, value) pair expansion | yes | yes | yes | yes |
| 20-pairs-per-row limit | yes | yes | **no** | yes |
| DMA underrun | **not implemented** | **not implemented** (TODO) | yes | yes |
| Intra-frame DMA timing | none | **none** (TODO: whole screen at frame end) | **per-row** (scheduler) | none (frame-granular) |
| FDD / games | works | works | works | **does not work** |
| Phosphor & tube physics | none | none | unverified | **yes** |

**The headline: MAME and M88 are chip-level too.** Any claim that "only this
repo emulates the real hardware" would be false. What is genuinely unique
here is the *physical layer* below the chips — and the fact that the
27-color trick therefore produces an actual color rather than a 30 Hz
flicker.

## QUASI88 — commands parsed, data path faked

`src/screen.c`, `crtc_make_text_attr()`:

```c
char_start_addr = text_dma_addr.W;              /* = dmac_address[2] */
for( i=0; i<crtc_sz_lines; i++ ){
    *text_attr++ = ((Ushort)main_ram[ c_addr++ ] << 8 ) | global_attr;
```

It reads `main_ram` directly, every frame, from the DMAC's channel-2
*address*. There is no row DMA and no FIFO. The counter registers exist but
nothing reads them (`src/crtcdmac.c`):

```c
byte dmac_in_status( void ){ return 0x1f; }   /* always "all channels hit TC" */
```

No autoload, no terminal count. Writing `8000h+5999` to port 65h changes
nothing. **The 27-color trick cannot work in QUASI88** — the state variable
it needs (an address counter that survives across frames) does not exist.
`CRTC_STATUS_U` (DMA underrun) is only ever *cleared*, never set.

Its attribute handling, on the other hand, is faithful (20-pair limit,
first-come-wins on collisions, the two-state color/decoration latch).

## MAME — chip-level; the mechanism works, the mixing doesn't

`src/mame/nec/pc8001.cpp` wires DRQ → i8257 → `dack_w`, and the μPD3301 has
**no VRAM address at all** — only row FIFOs (`upd3301.h`):

```cpp
u8 m_data_fifo[2][80];                            // row data FIFO
std::array<std::array<u8, 40+1>, 2> m_attr_fifo;  // attribute FIFO
```

`dack_w()` sorts incoming bytes purely by count. The i8257 keeps address and
count **across frames** and autoloads from ch3 at terminal count
(`i8257.cpp`), so a count of 5999 really does alternate two screens.

But MAME never mixes frames: `screen_update` is a `copybitmap` and
`reset_fifo_vrtc()` clears the bitmap every frame. **MAME outputs a 30 Hz
flicker**; on a real CRT your eye and the phosphor would fuse it into a
color. Screenshots and dropped frames show one screen only.

## M88 — per-row DMA, finer timing than MAME

`src/pc88/crtc.cpp` pulls one row through the DMAC and *does* model the
underrun MAME leaves as a TODO:

```cpp
if (linesize > dmac->RequestRead(dmabank, dest, linesize))
{
    mode = (mode & ~(enable)) | clear;
    status = (status & ~0x10) | 0x08;   // DMA underrun
}
```

Rows advance on the scheduler every `linetime`, so its DMA timing is finer
than MAME's (per-row vs per-frame) and finer than ours. `pd8257.cpp`
implements ch2 autoinit, so the two-screen trick reproduces here as well.
It does *not* model the 20-pairs-per-row limit.

## This repo — same chip level, plus the physics

```
$ node tools/prove-27color.mjs
frame-by-frame color index of the same dot: RED → GREEN → RED → GREEN → RED → GREEN
what the long-persistence phosphor integrates: R=1.13 G=1.25 B=0.28
  → the eye sees YELLOW-ish: a color the 8-color hardware cannot produce.

$ node tools/prove-chip-level.mjs
VRAM moved to 0x8123 via the DMA controller alone.
CRTC now displays: "THE CRTC DOES NOT KNOW WHERE MEMORY IS"
Re-RESET the CRTC → 40x12, 16 lines/char, hsync=18240Hz
```

Nothing special-cases the trick: the DMAC carries the bytes it was told to
carry, the CRTC displays what arrives, and **the phosphor integrates it into
a color** — the step MAME and M88 leave to your eyes.

## Honest conclusions

- "Other emulators don't really emulate the hardware" would be **wrong**.
  MAME and M88 are chip-level, and M88's DMA timing is *finer* than ours.
- **QUASI88 is the exception** (direct VRAM read, no TC, no autoload) — the
  trick cannot work there. That is a legitimate design choice: its goal is
  running software correctly and fast.
- **Play games on the others.** Our FDD does not work at all.
- What is ours alone is not "chip level" but what lies *below* it:
  1. **The physical layer** — phosphor (P22's blue dies first, P7's
     two-layer afterglow, burn-in), the ∵ shadow mask, beam-spot bleed,
     scanline gaps, deflection collapse, V-HOLD, the 15 kHz whine. *MAME
     emits a 30 Hz flicker; here the phosphor turns it into a color.*
  2. **Determinism and testability** — 85 headless tests, the 27-color trick
     among them.
  3. **Readability** — the chips' causality fits in a head.

This is less "a more accurate emulator" than **an executable textbook that
goes all the way down to the glass**.
