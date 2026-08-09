**English** · [日本語](./seta-design.ja.md)

# Seta arcade boards

Seta's early arcade hardware as a machine in this repository: a 68000, one
custom chip that draws both the sprites and the playfield, one custom chip that
plays sixteen voices out of RAM, sixteen kilobytes of work RAM, and nothing
else. No BIOS, no disk, no keyboard, no bank switching, no operating system.

It satisfies the same contract as `machine88.js`, `machinenes.js`,
`machinemd.js` and `machinex68.js` — `stepFrame()`, `frame`, `snapshot()`,
`restore()`, `schemaVersion` — so `demo/machine.html` gives it fast-forward,
rewind and jog-shuttle without knowing anything about it.

**Three games are verified pixel-identical to MAME 0.242.** Thunder &
Lightning over a full minute of attract mode and demo play — 21 sampled frames,
0 of 92160 pixels different on every one — plus Ultraman Club and Krazy Bowl at
6 sampled frames each. Section 9 has the procedure.

## 1. What is here

| File | What it is |
|---|---|
| `setarom.js` | MAME ROM sets: the per-chip layout of each board, byte interleaving, CRC-based identification, and assembly into regions |
| `x1001.js` | The X1-001 / X1-002 sprite pair: tile decoding, 512 sprites, the floating tilemap, wrapping, flip |
| `x1010.js` | The X1-010 sound chip: sixteen voices, PCM out of ROM and wavetable-plus-envelope out of chip RAM |
| `machineseta.js` | The machine: a page-table address decoder, four board wirings, interrupts, the protection PAL, controls, the frame loop |
| `setatools/boot.mjs` | Headless run, frame statistics, ASCII thumbnail, snapshot measurement |
| `setatools/mameref.lua` | The oracle side: dumps MAME's state, or its screen's pixels, at chosen frames |
| `setatools/mameref.mjs` | The comparison: runs this machine to the same frames and diffs, region by region or pixel by pixel |
| `test-seta.mjs` | 44 tests under `node --test`, **none of which need a ROM** |

`package.json` gained `./setarom`, `./x1001`, `./x1010` and `./machineseta`.
`m68000.js` is used **unmodified** — the same file the Mega Drive and the
X68000 depend on. `tools/` is untouched.

## 2. Which boards

| Set | Game | Board | State |
|---|---|---|---|
| `thunderl` | Thunder & Lightning (Seta, 1990) | `thunderl` | **Pixel-identical to MAME, 21/21 frames.** Boots, attract mode, coin, play |
| `thunderla` | Thunder & Lightning, set 2 | `thunderl` | Same board; the alternate program ROMs are in the table, not tested against a dump |
| `umanclub` | Ultraman Club (Banpresto, 1992) | `umanclub` | **Pixel-identical to MAME, 6/6 frames.** 16 MHz, level-3 interrupt, horizontal cabinet |
| `krzybowl` | Krazy Bowl (American Sammy, 1994) | `krzybowl` | **Pixel-identical to MAME, 6/6 frames.** Trackballs read a standing zero |
| `wits` | Wit's (Athena / Visco, 1989) | `wits` | Same PCB as thunderl without the protection PAL. **No dump on hand — untested** |

Section 11 lists what every other Seta set would need and why it is not here.

## 3. The board

Thunder & Lightning, which is the simplest thing Seta shipped:

```
                +-------------+
   16 MHz  ---> |   /2        | ---> MC68000  @ 8 MHz
                +-------------+
                      |
   $000000-$00FFFF    | 64 KB program ROM   (two 32 KB chips, interleaved)
   $FFC000-$FFFFFF    | 16 KB work RAM
   $100000-$103FFF    | X1-010  16 voices, 8 KB of chip RAM, 1 MB sample ROM
   $200000            | interrupt acknowledge
   $400000-$41FFFF    | PAL16V8, write-only  (protection)
   $500001            | coin counters / lockout / sound enable
   $600000-$600003    | DIP switches
   $700000-$7003FF    | 512 palette entries, RRRRRGGGGGBBBBB
   $B00000-$B0000D    | controls, and the protection read-back
   $D00000-$D00607    | X1-001  sprite Y, tilemap scroll, four control bytes
   $E00000-$E03FFF    | X1-001  sprite codes, X, colour  (8 K words)
```

The screen is 512x256 with a 384x240 window wired to the monitor, and the
monitor is **on its side** (ROT270), so the picture a player sees is 240x384
portrait. `render()` turns it by default; `render({ rotate: false })` gives the
board's own orientation, which is what the MAME comparison uses.

### The address decoder

Every Seta board is the same three chips with the decoder rewired, so a board is
a **256-entry table saying what each 64 KB page is**, and the read and write
paths switch on that. The fine decode inside a page is board-independent,
because Seta kept the chips at the same offsets within their page every time:
sprite Y is always at `$x00000-$x005FF` and the four control bytes always at
`$x00600`, whichever page `x` happens to be. Adding a board is adding a row to
`SETA_BOARDS`, not writing a file.

### Byte accesses are handled, not synthesized

`m68000.js` can synthesize `read8`/`write8` from `read16`/`write16`, but the
synthesis is a read-modify-write and half this map is registers where a
spurious read has a side effect — `$200000` acknowledges an interrupt when it
is *read*. A byte write anywhere in that page would fire it. The machine
provides all four, which is also what the hardware does: the 68000 has UDS and
LDS byte strobes for exactly this.

### The customs are 8 bits wide

The X1-001's control and Y tables are byte-wide inside the chip even on a 68000
board, so **a word write only ever delivers its low byte**. A machine that
helpfully keeps the high byte drifts away from the board the first time a game
writes a 16-bit constant. The sprite code table at `$E00000` really is 16 bits —
it is external RAM the CPU shares with the chip — and keeps both halves.

## 4. ROM sets

A console cartridge is one file. An arcade ROM set is one file per chip, and
putting them back together means knowing how the chips were wired.

**Two wiring patterns, and the difference matters.** A 68000 fetches 16 bits at
a time from two 8-bit ROMs in parallel: one answers on D15-D8 (even addresses),
the other on D7-D0. So a program ROM pair is **interleaved** — byte 0 from the
first chip, byte 1 from the second. Get it backwards and the reset vector reads
as garbage and the CPU dies before executing an instruction. Graphics ROMs can
be wired either way and Seta used both: `thunderl`'s sprite ROMs are interleaved
pairs, `krzybowl`'s are plain contiguous halves. Nothing in the files says
which; the table in `setarom.js` records it.

**Matching is by CRC32, not by filename.** The same ROM content circulates as
`t17`, as `25.a10`, as `un001008.7l`; sets get renamed, merged parent-and-clone,
or unpacked into subdirectories. Matching on the CRC MAME publishes makes all of
that irrelevant, and says out loud when a chip is a different revision instead of
silently building a board that will never run. Filenames are a fallback, and
using one produces a warning.

```js
import { loadSetaRomSet } from './setarom.js';
import { SetaMachine } from './machineseta.js';

const romset = await loadSetaRomSet(zipBytes, { name: 'thunderl.zip' });
const m = new SetaMachine({ romset });
for (let i = 0; i < 1200; i++) m.stepFrame();
const { width, height, rgb } = m.render();
```

`loadSetaRomSet` takes the bytes of a MAME set zip (it unzips with `zip.js`), or
a bag of already-extracted files. A zip that matches nothing is refused rather
than loaded into a board that would boot into noise.

**No ROM is committed to this repository.** Section 9 says where to get one and
how to point the tools at it.

## 5. The X1-001: it is not only a sprite chip

The name is misleading, and believing it costs a day. The chip draws **two**
things out of the same block of RAM:

* **512 free sprites** — 16x16 tiles at arbitrary positions, drawn back to front
  so sprite 0 ends up on top.
* **a "floating tilemap"** — up to 16 columns of 2x16 tiles, each column with
  its own scroll pair. It is a tilemap in everything but name, and it is why a
  board with no tilemap chip on it can still show a playfield.

Implement only the sprites and Thunder & Lightning runs, takes coins, and shows
its characters floating over a blank background. That failure looks like a
palette bug.

Three rules that are not guessable:

1. **The sprites' Y axis runs upwards** and is measured from the bottom of the
   256-line field: `y = height - ((spriteY + yoffset) & 0xff)`. The tilemap's
   does not. Using one convention for both puts the playfield and the pieces on
   it in different worlds.
2. **Everything wraps.** Every tile is drawn again at `x - 512` and at
   `y - 256`. This is not an optimisation to skip: the position fields are 9 and
   8 bits wide, and "a sprite entering from the left edge" is expressed by the
   counter having rolled over.
3. **The bank bit is a comparison, not a bit.** `ctrl[1]` bits 5 and 6 are
   compared against each other to pick which half of the code table is live, and
   **all-zeroes selects the second half**. A test that filled the table from
   offset 0 and left the register at zero draws nothing.

### Tile format

Sprite ROMs hold 16x16 tiles, four bitplanes, and the planes are **split across
the region**: the low half carries planes 0 and 1, the high half planes 2 and 3.
Within a half a tile is 64 bytes in four 16-byte quadrants (top-left,
top-right, bottom-left, bottom-right), and within a quadrant the two bytes of a
row are the two bitplanes, MSB leftmost.

`decodeSpriteTiles()` unpacks the whole region once at load into one byte per
pixel — 1 MB for `thunderl`'s 4096 tiles. It is derived from ROM, so it is
rebuilt on load and **never enters a snapshot**. `test-seta.mjs` carries the
inverse function and asserts a round trip, so the decoder is proved rather than
merely exercised.

### Colour

Sprites and tilemap tiles are 4 bits deep with a 5-bit colour code, so a pen is
`colour * 16 + pixel` into a 512-entry palette of `RRRRRGGGGGBBBBB`. Five bits a
channel expand to eight the way the DAC does: the top three bits are repeated
into the bottom, so full scale is 255. The background is **palette entry 496**,
not entry 0 — a machine that clears to black shows a black border the board
does not have.

The tile code field is 14 bits but the ROM holds more than 16384 tiles, so two
bits of the colour word select a 16K-tile bank. Without it a game cannot reach
its later graphics at all.

## 6. The X1-010: sixteen voices, two meanings per register

Each voice has eight registers, and **one bit changes what the other seven
mean**:

* **PCM** (bit 1 clear) — 8-bit signed samples straight out of the sample ROM.
  Start and end are in 4 KB units, and the end field is stored as
  `0x100 - block`, so a longer sample is a *smaller* number. The step is 4.4
  fixed point.
* **Waveform** (bit 1 set) — a 128-byte wave out of the chip's own RAM at 6.10
  fixed-point pitch, with the volume taken sample by sample from a 128-byte
  envelope also in chip RAM.

Getting the split wrong gives silence rather than noise, because the PCM path's
end test fires immediately on a waveform's register values.

**Key-on is an edge.** Bit 0 going 0→1 rewinds the voice and its envelope; a
game that rewrites the same byte must not restart the note.

**Rate.** The chip runs at clock/512 — 31250 Hz from the usual 16 MHz crystal.
This generates at the native rate and holds each sample until the next is due,
with an integer phase accumulator. That is a zero-order hold: the arithmetic
stays integer so a restored snapshot produces bit-identical output, and the
aliasing it adds is above what an 8-bit source carries anyway. A polyphase
resampler would be more correct and is not here.

**Sound enable does not gate the mixer.** The coin-lockout register carries a
bit for it and the machine records it, but MAME found that gating on it silences
games that never set it, so the real chip evidently does something subtler. Same
choice here, same reason.

## 7. Interrupts

Two arrangements, both in `SETA_BOARDS`:

* `vblank2` (thunderl, wits) — level 2 is asserted when vertical blanking
  begins and **stays asserted until the game acknowledges** it by touching
  `$200000`. Reading that address acknowledges, not only writing: several Seta
  games ack with a `MOVE` whose result is discarded, and a write-only handler
  leaves the level up and the game re-enters its handler forever.
* `scanline12` (krzybowl) — level 2 at line 112 and level 1 at line 240, both
  dropped by the 68000's own acknowledge cycle. `m68000.js` calls `bus.irqAck`
  during that cycle, which is where they are cleared; returning a negative value
  keeps it an autovector, which is what these boards do.

The interrupt **line** is the machine's to drive, not the CPU's to remember, so
`restore()` re-asserts it: the first instruction after a restore sees the same
pins as the first instruction before it.

## 8. The frame, and where the picture is taken

The clock does not divide evenly into 60 frames a second — 8 MHz gives
133333 ⅓ cycles a frame — so the remainder is carried in an integer, one extra
cycle every third frame. Floats here would make two runs of the same input
diverge after a few minutes, which is exactly what rewind cannot survive.

**A step starts at the first line of vertical blanking**, not at line 0. That is
not the obvious phase and it is the most interesting decision in this machine.
Two requirements pull in opposite directions:

* The picture has to be taken **when blanking begins**. That is what the monitor
  has just finished scanning out, and it is before the game's vblank handler
  rewrites sprite RAM for the next field. Taking it later includes writes the
  player could not have seen.
* The picture also has to be a function of the **snapshot** and not of history,
  or `restore()` cannot reproduce the frame it restores to.

Drawing at blanking with a conventional frame phase satisfies the first and
fails the second: the snapshot holds sprite RAM as it stands *after* the handler
ran, and redrawing from that gives a different picture. Measured, not guessed —
rewinding through 250 slots of Thunder & Lightning landed on the wrong frame on
61 of them. That is the kind of fault that only appears when the time travel is
actually used, and a machine that satisfies the contract on paper can still have
it.

Starting the step at blanking satisfies both, because then the draw at the end
of the step *is* the start of blanking. Nothing else changes; the interrupt
still fires at the same line and the cycle budget is distributed the same way.

The palette is copied at the same moment. The game is free to rewrite it during
blanking, and without the copy a snapshot restored later would resolve the old
picture through the new colours.

## 9. MAME as the oracle

MAME has a `seta.cpp` driver, so the answer sheet exists before the work starts.
Unlike M88 for the PC-8801 (see `docs/m88-comparison.md`), **no patching or
rebuilding is needed** — `-video none` plus a Lua script is enough.

### Getting MAME

`apt install mame` gives 0.242. Without root, the deb and its dependencies can
be unpacked with `dpkg-deb -x` and run with `LD_LIBRARY_PATH` pointed at the
unpacked `usr/lib`. Two things to know about 0.242:

* `emu.add_machine_frame_notifier` **does not exist yet**. The frame hook is
  `emu.register_frame_done(fn)`.
* MAME segfaults on exit, after printing its speed line. The exit code is
  therefore useless as a success test; check that the output file is complete.

### Comparing state, region by region

```sh
SETAREF_OUT=/tmp/ref.txt SETAREF_FRAMES=10,60,300 \
  mame thunderl -rompath <dir> -video none -sound none -nothrottle \
    -skip_gameinfo -seconds_to_run 8 -autoboot_delay 0 \
    -autoboot_script setatools/mameref.lua

node setatools/mameref.mjs --zip <dir>/thunderl.zip --ref /tmp/ref.txt
```

`mameref.lua` reads work RAM, the palette, both sprite tables and the control
bytes **through the CPU's own address space**, so what is compared is what the
CPU would see rather than MAME's internal allocation — a mistake in the address
decoder shows up as a difference instead of hiding.

Comparing regions rather than pictures is the point. A wrong picture has a dozen
possible causes; a wrong region has one. Work RAM and sprite RAM agreeing while
the screen does not localises the fault to `x1001.js` immediately, which is
exactly what happened here.

Result on `thunderl`: **every byte of work RAM, palette, sprite Y, sprite
control and sprite code identical at frames 10, 60 and 300**; at frame 900,
19 of 20 regions identical and the twentieth differing in 5 bytes of work RAM
at `$FFFF9F`, which is inside the stack. That residue is expected and is the
phase difference described below, not a disagreement about the machine: the two
dumps are taken eight scanlines apart, and an exception frame is pushed in
between.

### Comparing pixels

MAME's Lua `screen:pixels()` returns the visible area as raw ARGB32, so the
comparison can go all the way to pixels without a PNG decoder anywhere:

```lua
local scr = manager.machine.screens[":screen"]
emu.register_frame_done(function() ... io.open(path,"wb"):write(scr:pixels()) ... end)
```

Result on `thunderl`, 21 frames sampled from 1 to 3600 (boot, the ROM-check
tile dump, the title screen, the attract demo, the high-score table):

```
frame     1 …  3600     0 / 92160 pixels differ on every one
21/21 frames pixel-identical
```

The other two boards with a dump on hand, 6 frames each:

```
umanclub   6/6 frames pixel-identical   (384x240, 0/92160 every time)
krzybowl   6/6 frames pixel-identical   (304x240, 0/72960 every time)
```

Three boards, three different interrupt arrangements, two different sprite-ROM
wirings, and one of them with a protection PAL — all exact.

Two caveats stated plainly.

**MAME's frame index is one ahead of this machine's** for pictures:
`register_frame_done` counts its first completed frame as 1, and the picture it
holds corresponds to this machine's `frame` counter minus one. `--pix` defaults
to that alignment; `--offset 0` shows the raw counter-to-counter comparison.

**State and pixels align differently** — `--ref` wants offset 0 and `--pix`
wants -1 — because MAME dumps state at the end of the hardware frame while its
picture was rendered eight scanlines earlier, when blanking began. This machine
takes both at the same instant (see section 8), so one of the two alignments has
to absorb the eight lines. Everything except the stack agrees under either.

### The one bug this caught that nothing else would have

The sprite offsets in MAME are set by `set_fg_yoffsets(flip, noflip)` — **flip
first**. Reading them as `(noflip, flip)` puts the whole picture 2 pixels out
vertically and the sprites 32 pixels out, which looks like a plausible picture
with everything in slightly the wrong place. No test would have caught it. The
pixel diff caught it in one run, and pointed at "a constant vertical shift"
rather than at a chip.

## 10. Snapshots — measured

`snapshot()` holds mutable state only. The program ROM, the sprite ROM, the
decoded tiles and the sample ROM all stay where they are.

Measured after 1200 frames of `thunderl`, counting typed arrays at their byte
length and everything else at eight bytes a value — the same arithmetic
`mdtools/screenshot.mjs` and the host's rewind budget use:

| Part | thunderl | krzybowl | umanclub |
|---|---|---|---|
| X1-001 chip RAM | 16.8 KB | 16.8 KB | 16.8 KB |
| X1-010 chip RAM + bus shadow | 16.2 KB | 16.2 KB | 16.2 KB |
| work RAM | 16.0 KB | 64.0 KB | 64.0 KB |
| palette (live + as displayed) | 2.0 KB | 2.0 KB | 2.0 KB |
| 68000 | 0.2 KB | 0.2 KB | 0.2 KB |
| battery-backed settings | — | 0.3 KB | — |
| scratch RAM sharing the palette page | — | — | 16.0 KB |
| **total** | **51.3 KB** | **99.5 KB** | **115.3 KB** |

For scale: Famicom 3 KB, FDS 47 KB, Mega Drive 142 KB, X68000 1564 KB.

**This is the machine where rewind works best.** The host's ring is a 192 MB
byte budget, so 51 KB per slot gives it the full 1000 slots it is allowed —
at the default 6-frame spacing that is **100 seconds of play, scrubbable
backwards**, against the X68000's twelve.

Two things were taken out after measuring. The 16 KB of scratch RAM that only
Wit's decodes, and the 256 bytes of battery-backed settings that only Krazy Bowl
has, are allocated **only when the board has them** — otherwise a quarter of
`thunderl`'s snapshot would be a region no thunderl board ever contained.

The 8 KB high-byte shadow of the sound chip is a bus artefact rather than chip
state, and it is kept anyway: a game that stashes data in the high byte of a
sound register would come back wrong without it, and this repository's snapshots
are meant to be complete state or nothing.

Verified rather than assumed: 250 rewind slots captured over 1500 frames of
`thunderl` including a coin, a start and stick input, then restored one by one
walking backwards. **250 of 250 restored to the exact frame captured**, and
replaying forward from the middle with the same inputs lands on the same
picture.

## 11. What is not here

**No X1-012.** That is the separate tilemap chip on the later boards, and it is
what `msgundam`, `wrofaero`, `eightfrc`, `zingzip`, `blandia`, `gundhara`,
`jjsquawk` and most of the rest of `seta.cpp` need. They also want the 6-bit
tilemap colour modes and a second palette bank. The dumps are on hand and none
of them is loaded, because loading them would produce a board with a missing
layer rather than an honest refusal.

**No second CPU.** Some boards (`tndrcade`, `downtown`, `calibr50`, the Thunder
& Lightning bootlegs) carry a Z80 or a second 65C02 for sound or for I/O.
`z80.js` and `m6502.js` are both in this repository, so this is wiring rather
than new chips, but it is not wired.

**No OKI6295**, so the boards that use one instead of an X1-010 are out.

**Trackballs read a standing zero.** Krazy Bowl boots and shows its title, but
the ball does not move; the uPD4701 counters are present in the state and
nothing drives them.

**`wits` is untested.** The board description and the ROM table are written from
`seta.cpp`, and no dump was on hand to run.

**Ultraman Club's palette-page scratch RAM is over-allocated.** The board's
`$300400-$300FFF` is 3 KB and gets a 16 KB buffer, because that buffer is shared
with Wit's `$E04000-$E07FFF`. It costs 13 KB of every rewind slot on that board
and nothing else.

**Sound is unverified.** The X1-010 was written against MAME's `x1_010.cpp` and
its tests check the register semantics and determinism, but nothing here has
been compared against MAME's audio output or listened to. Treat section 6 as
"believed correct", not "measured".

**The browser is unverified.** Everything in this document comes from headless
runs: frame statistics, pixel diffs against MAME, and PNGs decoded and looked
at. The machine is wired into `demo/machine.html` and the host's capability
probes accept it, but **no part of this has been seen in a browser** — not the
CRT simulation, not the audio path, not the file picker.

**Cocktail (flipped) mode is untested.** The flip offsets are in the board
table and the code path exists; no game was run with the DIP switch set.

## 12. Adding a board

1. Find the game in MAME's `seta.cpp`: its `ROM_START`, its `_map`, and its
   `machine_config`.
2. Add a row to `SETA_SETS` in `setarom.js` — the chips, their CRCs, and
   whether each region is interleaved (`step: 2`) or contiguous (`step: 1`).
3. Add a row to `SETA_BOARDS` in `machineseta.js` if the decoder differs: the
   page table, the clock, the visible window, the rotation, the interrupt
   arrangement, and the sprite offsets (**`set_*_offsets(flip, noflip)` — flip
   first**).
4. Run `setatools/boot.mjs` and look at the statistics; then run the MAME
   comparison of section 9 before believing anything.

If the game has a tilemap layer, stop: `x1_012.cpp` has to exist first.
