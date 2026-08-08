**English** · [日本語](./x68000-design.ja.md)

# X68000

The Sharp X68000 as a machine in this repository: a 10 MHz 68000, a CRT
controller software programs dot by dot, four graphics pages that share one
512 KB memory in four different shapes, a text plane that is really four bit
planes, 128 sprites, an FM chip with eight channels and an ADPCM chip, all
driven by an MFP that owns every interrupt on the board.

It satisfies the same contract as `machine88.js`, `machinenes.js` and
`machinemd.js` — `stepFrame()`, `frame`, `snapshot()`, `restore()`,
`schemaVersion` — so `demo/machine.html` gives it fast-forward, rewind and
jog-shuttle without knowing anything about it.

## 1. What is here

| File | What it is |
|---|---|
| `machinex68.js` | The machine: memory map, reset, interrupt levels, the frame loop, the system port, the RTC, the 8255, the I/O interrupt controller |
| `x68crtc.js` | The CRT controller: R00-R23, the derived geometry, the raster copy and the fast clear |
| `x68video.js` | Graphics VRAM in all four shapes, the text plane, the palette, the video controller, sprites, the two tile planes, and the priority resolver |
| `mc68901.js` | The MFP: sixteen interrupt sources, four timers, the GPIP pins, the keyboard's serial receiver |
| `hd63450.js` | The DMA controller: four channels, chaining, 8- and 16-bit devices |
| `x68fdd.js` | `.XDF`/`.IMG`, `.DIM` and `.D88` images, and the drive side of the floppy controller |
| `ym2151.js` | The OPM: eight four-operator FM channels, LFO, noise, stereo, two timers |
| `msm6258.js` | The OKI ADPCM chip |
| `test-x68.mjs` | 46 `node --test` cases. No ROM required — every one builds its own IPL |
| `x68tools/boot.mjs` | Run a disk headlessly and report the picture |
| `x68tools/sweep.mjs` | Run a directory of disks and classify each one |

The 68000 itself is `m68000.js`, shared with the Mega Drive and used here
without a single change. The floppy controller is `upd765.js`, shared with the
PC-8801 and likewise unmodified — the X68000's µPD72065 is a µPD765.

## 2. Memory map

```
$000000-$BFFFFF  RAM. Reads and writes above the installed size are bus errors
$C00000-$DFFFFF  graphics VRAM, in whichever shape CRTC R20's high byte says
$E00000-$E7FFFF  text VRAM: four 1024x1024 bit planes, 128 KB each
$E80000-$E81FFF  CRTC
$E82000-$E823FF  palette: 256 graphics entries then 256 text/sprite entries
$E82400/500/600  the video controller's three registers
$E84000-$E85FFF  DMAC
$E86000-$E87FFF  area set (accepted and ignored)
$E88000-$E89FFF  MFP
$E8A000-$E8BFFF  RTC
$E8C000-$E8DFFF  printer (accepted and ignored)
$E8E000-$E8FFFF  system port
$E90000-$E91FFF  YM2151
$E92000-$E93FFF  MSM6258
$E94000-$E95FFF  floppy controller and drive control
$E96000-$E97FFF  SASI (reads as zero)
$E98000-$E99FFF  SCC (reads as $FF)
$E9A000-$E9BFFF  8255: two joystick ports and the ADPCM's clock select
$E9C000-$E9DFFF  I/O interrupt controller
$EB0000-$EBFFFF  sprite registers, BG control, PCG patterns, the two tile maps
$ED0000-$EDFFFF  SRAM, 16 KB mirrored
$F00000-$FBFFFF  CGROM
$FC0000-$FFFFFF  IPL ROM (the low half mirrors it, as on a SASI machine)
```

A **word access to the I/O block is two byte accesses**, high half first. Some
of what lives there really is sixteen bits wide (every CRTC register, every
palette entry, the DMAC's counters) and some is an 8-bit part strapped to the
odd half of the bus (the MFP, the floppy controller), which ignores the even
byte. Splitting serves both. Treating the whole block as 8-bit — answering only
the odd byte — loses the high half of every CRTC register, and the symptom is a
machine that boots and runs but never programs its display.

## 3. Reset, and why the ROM is at address zero for three instructions

The 68000 fetches its stack pointer from $000000 and its program counter from
$000004. The X68000 has RAM there and its ROM at $FE0000, so the address
decoder puts the ROM's last 64 KB over the bottom of the map until the machine
takes it away. The third instruction the IPL executes is what takes it away:

```
FF0010  MOVE  #$2700,SR
FF0014  LEA   $2000.L,A7
FF0016  RESET            <- the overlay goes here
```

`resetLine()` from `m68000.js` drops `bootOverlay`. Nothing has touched low
memory by then, and a later `RESET` (Human68k issues one) finds it already
gone. `test-x68.mjs` checks both halves of this.

## 4. RAM, and the size of a snapshot

This is the design decision that matters most on this machine, so here are the
measurements rather than an argument.

A snapshot after Human68k 3.1 has booted, in kilobytes:

| Installed RAM | Snapshot | RAM | Video | SRAM | OPM | The rest |
|---|---|---|---|---|---|---|
| **1 MB (default)** | **1564** | 1024 | 514 | 16 | 8 | 2 |
| 2 MB | 2588 | 2048 | 514 | 16 | 8 | 2 |
| 12 MB | 12828 | 12288 | 514 | 16 | 8 | 2 |

For comparison: a Famicom snapshot is about 3 KB and a Mega Drive one 142 KB.
The X68000 is two orders of magnitude past the Famicom because two things are
irreducibly large — main memory, and video memory.

Three decisions follow.

**The default machine has 1 MB.** That is the stock ACE and EXPERT, it is what
`sram.dat` files in the wild declare, and it halves the snapshot against the
next size up. A user who needs more passes `ram:`.

**Video memory is copied only once something has written to it.** Graphics VRAM
is 512 KB and the sprite/PCG area 32 KB, and a machine sitting at a Human68k
prompt has never touched either. The dirty flags are monotonic — they never go
back to false — so a snapshot without a copy is unambiguously "this memory was
still all zeroes here", and restoring it clears the memory. That is worth
544 KB per frame of ring, and it is the difference between the 2108 KB the
snapshot was before and the 1564 KB it is now. The same trick is what
`machinemd.js` does with cartridge backup RAM.

**The host's rewind ring is sized in bytes, not in frames.** It used to keep a
thousand snapshots on the assumption that every machine's state was about the
same size; a thousand X68000 snapshots is a gigabyte and a half. `sizeRewindFor()`
in `demo/machine.html` now measures the first snapshot of a session and derives
the count from a 192 MB budget: about 1000 for a Famicom, about 1000 for a Mega
Drive, about 125 for an X68000. At the default snapshot interval that is a
rewind buffer of roughly 12 seconds on this machine against 100 on the others —
short, but honest, and it is the same code path for every machine.

**What is deliberately not done:** dirty-page tracking on main memory. It would
help — most frames touch a small fraction of a megabyte — but it makes
`restore()` depend on the whole chain of snapshots back to the last full one,
and the host's ring drops its oldest entry whenever it wants. A snapshot in this
repository is a complete state or it is nothing.

## 5. Video

### Graphics memory in four shapes

512 KB of graphics RAM is always 512x512 sixteen-bit words. The high byte of
CRTC R20 decides how many of those bits belong to one dot, and therefore what
an address into $C00000 means:

| R20 high | Shape | Address arithmetic |
|---|---|---|
| 0 | four 512x512 pages of 16 colours | odd bytes only; word = `y*512+x`, nibble = `page*4` |
| 0, bit 2 set | one 1024x1024 page of 16 colours | word = `(y&511)*512+(x&511)`, nibble = `8*(y>>9)+4*(x>>9)` |
| 1 or 2 | two 512x512 pages of 256 colours | odd bytes only; word = `y*512+x`, byte = `page*8` |
| 3, or bit 3 set | one 512x512 page of 65536 colours | the word IS the colour |

In 16- and 256-colour mode the **even byte of every word is not there**: a
`MOVE.W` puts its high byte on a bus line that goes nowhere, and only the low
byte's nibble lands. A model that accepts both bytes writes every dot twice and
the picture comes out half-width.

The 256-colour mode has a trap of its own: the two NIBBLES of a page's byte
scroll independently, from R12/R13 and R14/R15. It is really two 4-bit planes
that share a byte, and games slide a colour ramp under a static image with it.

### The text plane

Four 1024x1024 bit planes, 128 KB each, assembling a 4-bit colour index per
dot. Two bits of R21 make it fast: "simultaneous access" sends one byte write
to every plane R21 selects, and the mask in R23 says which BITS of the byte
survive (a mask bit of 1 keeps the old bit). Together they paint a four-colour
character cell with a single `MOVE`.

The CRTC's raster copy moves 512 bytes — four scanlines — from one place in a
plane to another, per plane, in hardware. It fires when the DESTINATION half of
R22 is written, not when the mode bit is set, because programs leave the mode
bit on and just keep changing the addresses.

### Colour

A palette entry is `GGGGGRRRRRBBBBBI`: five bits per gun plus one bit shared by
all three. So a gun is six bits, and a "pure" red is one step off black on the
other two guns — `test-x68.mjs` asserts exactly that, because it looks like a
bug the first time you see it.

### Priority

Three layers — graphics, text, sprite/BG — each carry a two-bit priority in the
high byte of the video controller's register 1. Zero is the top. Ties resolve
GRP < SPRITE < TEXT, and several games leave two layers on the same level and
rely on it. Inside the graphics layer the four pages carry two bits each in the
low byte of the same register, read as "the page number sitting in priority
slot k".

Sprites and the two tile planes are drawn bottom to top as: sprites at priority
1, tile plane 1, sprites at priority 2, tile plane 0, sprites at priority 3.
Within all of that the lowest-numbered sprite wins, and because the winner is
remembered across the three bands a low-numbered sprite at priority 1 beats a
high-numbered one at priority 3.

## 6. The floppy

`upd765.js` is used unchanged. Three things had to be supplied around it and
each one cost a debugging session against the real IPL ROM:

1. **A data request is not an interrupt.** `upd765.js` models the chip in
   non-DMA mode, where the INT pin goes high once per byte to ask the CPU for
   the next one. The X68000 wires that pin to the DMAC's DREQ and takes the
   command-complete interrupt through the I/O controller at IRQ level 1. Same
   pin, different phase. Routing the execution phase to the CPU is an interrupt
   storm.
2. **Some commands do not interrupt at all.** SPECIFY, SENSE DEVICE STATUS and
   SENSE INTERRUPT STATUS finish without raising INT. `upd765.js` raises it for
   every command because the PC-8801's sub-CPU polls rather than interrupts.
   Without the distinction the boot ROM's own interrupt handler races its polled
   code, reads the result bytes first, and the polled code waits forever for a
   result phase that already happened. This was the single hardest bug in the
   machine.
3. **SENSE INTERRUPT STATUS with nothing pending answers with one byte, not
   two.** ST0 = $80 and the command ends. `upd765.js` queues the
   present-cylinder byte unconditionally, and the extra byte leaves the
   controller in its result phase with CB asserted, which hangs the ROM's
   "wait for the controller to go idle" loop.

All three are handled in `x68fdd.js`, outside `upd765.js`, so the PC-8801's
behaviour is untouched.

### Image formats

| Extension | What it is |
|---|---|
| `.XDF` `.IMG` `.2HD` | A flat dump. 1,261,568 bytes is 77 cylinders x 2 heads x 8 sectors x 1024 |
| `.DIM` | One media byte, 170 track-presence flags, a `DIFC HEADER` signature, a comment, then only the tracks whose flag is set, back to back |
| `.D88` | Already sector-addressed; `d88.js` parses it |

All three are turned into the structure `d88.js` produces, because that is what
`upd765.js`'s `findSector()` reads. The media byte of a DIM picks the whole
geometry: 0 is 2HD (8 x 1024), 1 and 3 are 2HS (9 x 1024), 2 is 2HC (15 x 512),
9 is 2HQ (18 x 512).

A DIM holds present tracks only, so the file offset of track *t* is the count of
present tracks before it, not *t* itself. Getting that wrong shifts every track
after the first hole and the disk reads as garbage.

## 7. Timing

Everything divides down from the 10 MHz 68000 clock:

- one frame is 162,707 clocks at 15.98 kHz horizontal (61.46 Hz) or 180,310 at
  31.5 kHz (55.46 Hz) — CRTC R20 bit 4 picks
- one raster line is that divided by R04, the vertical total
- the MFP runs at 4 MHz. That ratio is 5/2, which is not an integer, so the
  timers count in HALF 68000 cycles: one MFP clock is five of them and a
  prescaler of 200 is 1000. Nothing accumulates a float
- the OPM's timers count microseconds; ten CPU clocks make one
- the floppy moves one byte every 244 CPU clocks, because a 2HD track is 8 KB
  per 200 ms revolution. Letting the DMAC run flat out would deliver a sector
  before the driver has finished setting up the transfer

Each scanline is run in two pieces so the MFP's HSYNC pin has a width a program
can poll: sync low for `R01/R00` of the line, then high for the rest.

## 8. Sound

`ym2151.js` is a full OPM: the log/linear pair, the 64-rate envelope tables,
the key-code-plus-fraction pitch, DT1, DT2, the eight algorithms with the
one-sample-late feedback path, the four LFO waveforms, the noise generator on
the last operator of channel 7, and stereo. It is closer to `ym2203.js` in
shape than in detail — the OPN has no DT2, no LFO waveform select, and its
pitch is an F-number rather than a key code.

Two things on this machine are wired outside the chip. The OPM's interrupt is
GPIP3 on the MFP, an ordinary pin edge like the sync signals. And writing
register $1B drives two output pins that go to other chips entirely: CT1 forces
the floppy controller ready, CT2 halves the ADPCM's crystal. Changing the ADPCM
sample rate on an X68000 therefore means writing to the joystick port and the
FM chip.

`msm6258.js` is the OKI codec exactly: `step(n) = floor(16 * 1.1^n)`, the
three-bit magnitude, the `-1/-1/-1/-1/+2/+4/+6/+8` step movement, clipping at
±2048, and the low nibble of each byte first.

## 9. Verification

### It boots

Human68k 3.1 boots to a command prompt. Reproduce with:

```sh
node x68tools/boot.mjs --ipl IPLROM.DAT --cgrom CGROM.DAT \
                       --fd0 HUMAN310.DIM --frames 1200 --thumb
```

which prints `768x512 nonzero=393216 (100.0%) colours=2` and an ASCII
thumbnail of the startup messages and the prompt. 1200 frames is about twenty
seconds of emulated time and takes about eight seconds to run.

The ROMs are not in this repository and never will be. `IPLROM.DAT` is 128 KB
and `CGROM.DAT` is 768 KB; both are identified by size rather than by name in
`demo/machine.html`, because the files in the wild are called half a dozen
different things.

### The sweep

`x68tools/sweep.mjs` runs a directory of images and classifies each by its
frame buffer alone: `ok` (content, more than one colour), `flat` (exactly one
colour — often correct), `black` (nothing), `halted` (double bus fault),
`reject` (would not parse).

```sh
node x68tools/sweep.mjs --ipl IPLROM.DAT --cgrom CGROM.DAT \
                        --dir <directory of disks> --frames 900 --json out.json
```

This is the PC-8801 method from `docs/m88-comparison.md` — run everything, then
chase only what came out wrong. Against 416 images at 600 frames each:

```
ok=376  flat=15  black=24  reject=1  total=416
```

Most of the `ok` results are Human68k reaching its prompt at 768x512, which is
a two-colour screen. `flat` is mostly a loader that has set its screen mode and
stopped. Of the 24 `black`, the one that was chased — `ｲｰｽ3#SYS.IMG` — turned
out to be asking for its data disk in drive 1 (`READ DATA` with US=1), not an
emulation fault; the sweep mounts one image, so multi-disk games stop there.
The single `reject` declares DIM media type 17, which the format does not
define.

The sweep found two bugs of its own, both of the "one disk stalls four hundred"
kind: a DMAC chain descriptor that points at itself never returns (there is a
ceiling on it now), and garbage in CRTC R04 makes a single frame take minutes
(it is clamped to 2048 lines).

### Determinism

`test-x68.mjs` runs two machines from the same IPL for twenty frames and
compares the CPU state and the text plane byte for byte; and takes a snapshot,
runs six frames, restores, runs six frames again, and compares the program
counter after each one.

## 10. Known holes

- **Declaring more than 1 MB of memory in SRAM stops the IPL programming the
  display.** With `$ED0008` set to 1 MB, Human68k boots to a prompt at 768x512.
  With 2 MB or more, the machine boots and runs — the program counter walks
  through Human68k, the disk is read, the text plane fills — but the CRTC's
  R00-R09 are never written and the screen stays black. It is not a bus error
  (there are none in that range), not the clear loop taking longer (6000 frames
  changes nothing), and not the RAM itself (a machine with 2 MB installed and
  1 MB declared works). Unresolved. The default of 1 MB avoids it.
- **No translucency, no half-tone, no special priority.** The video controller's
  register 2 has a whole second layer of composition — two graphics pages
  averaged, a graphics page averaged with text, a "special priority" plane that
  sits above everything — selected by five bits of its high byte. None of it is
  here; those bits are stored and ignored. Perhaps a dozen games use it.
- **Transparency is palette index 0, not "the colour resolves to black".** The
  hardware compares the resolved colour; a program that puts a non-black colour
  in entry 0 gets an opaque layer on real hardware and a transparent one here.
- **The text plane does not clip at 1024 dots**, it wraps. Only visible with a
  horizontal scroll far enough right on a wide screen.
- **No SASI or SCSI**, so hard disk images will not boot. `$E96000` reads as
  zero and the ROM's probe of `$EA0000` takes the bus error it expects.
- **No mouse and no serial.** The SCC reads as $FF.
- **One joystick button pair.** The six-button pad's extra half is not there.
- **The MFP's Timer A event-count mode counts the display period only.** It
  cannot be driven from any other pin.
- **The ADPCM output is sample-and-hold at the host rate**, with no
  reconstruction filter, and mono.
- **Disk writes are not part of a snapshot.** Rewinding does not undo a write to
  a floppy, the same as `machine88.js`. Mount images read-only if that matters.
- **The real screen is unverified.** Every judgement in this document comes from
  the frame buffer's statistics and ASCII thumbnails. Nobody has looked at this
  machine in a browser.
