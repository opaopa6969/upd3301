**English** · [日本語](./pc98-design.ja.md)

# PC-9801

This is the V30-generation PC-9801 implementation in this repository. It is a
pure JavaScript machine with no DOM dependency and the same host contract as
the other machines: `stepFrame()`, `frame`, `snapshot()`, `restore()`, and
`schemaVersion`.

The current core boots a ROM-free test BIOS all the way through GDC setup and
produces a 640x400 text picture. A real V30 BIOS boot is not verified yet. The
firmware available during development is from a PC-9801RS-class 80386 machine;
it reaches 386 instructions which a V30 cannot execute, so it is not a valid
boot image for this CPU model.

## 1. Files and components

| File | Responsibility |
|---|---|
| `machinepc98.js` | Memory and I/O maps, interrupts, reset, timing, keyboard, sound, snapshots |
| `i8086.js` | 8086/V30 CPU |
| `upd7220.js` | The two GDCs, command FIFO and drawing engine |
| `pc98video.js` | Text VRAM, four graphics planes, font window, GRCG, palette and composition |
| `i8237.js`, `i8253.js`, `i8259.js`, `i8255.js` | DMA, timer, cascaded interrupt controllers and PPIs |
| `pc98fdd.js` | D88/FDI/raw media and the PC-98 wrapper around the shared µPD765 |
| `test-pc98.mjs` | ROM-free CPU, machine, video, snapshot and floppy tests |
| `pc98tools/boot.mjs` | Headless boot and unmapped-I/O tracing |

`upd765.js` is shared unchanged with the existing machines.

## 2. Memory and reset

```
$00000-$9FFFF  640 KB main RAM
$A0000-$A3FFF  text codes and attributes
$A4000-$A4FFF  character-generator window
$A8000-$BFFFF  graphics planes B, R and G
$C0000-$DFFFF  option ROM window
$E0000-$E7FFF  graphics intensity plane
$E8000-$FFFFF  96 KB BIOS
$F8000-$FFFFF  32 KB ITF overlay after reset
```

With an ITF present, the reset vector comes from its overlay. A write to port
`$043D` removes the overlay and reveals the BIOS. Firmware is immutable input:
BIOS, ITF, font, sound ROM and mounted disk images never enter a snapshot.

Port `$0439` is a readable DMA access-control latch whose reset value is zero.
Returning the usual open-bus `$FF` here is not harmless: later firmware treats
it as an invalid machine state and enters its system-shutdown route. The latch
and the ITF bank state therefore belong to reset and snapshot state.

## 3. The I/O byte-lane rule

PC-98 frequently places an 8-bit device on one byte lane while another device
uses the other lane in the same 16-bit I/O block. A word I/O operation must be
performed as two ordered byte operations. For example, `OUTW $70` reaches a
text fine-scroll register at `$70` and PIT channel 0 at `$71`; dropping either
byte silently loses one device write.

This is the same failure mode found in the X68000 work: a machine can keep
executing while never completing display setup. `machinepc98.js` consequently
implements `_in16`/`_out16` only by calling the two byte paths.

Important blocks include the system PPI at `$31/$33/$35/$37`, the printer PPI
at `$40/$42/$44/$46`, the six text-scroll registers at even ports
`$70-$7A`, the PIT at odd ports `$71-$77`, and the mouse PPI at
`$7FD9/$7FDB/$7FDD/$7FDF`.

## 4. What caused the apparent shutdown

Two independent faults had been superimposed:

1. `$0439` was unmapped and read as `$FF`, selecting firmware's shutdown path.
2. V30 opcodes `$66` and `$67` were treated as 386 operand/address-size
   prefixes. On a V30 they are the FPO2 escape followed by a ModR/M byte:
   memory forms are no-ops and register forms take interrupt vector 7 from the
   start of the instruction.

After both corrections the development ITF no longer produces the spurious
text-VRAM error. It later executes genuine 80386 sequences such as operand-size
prefixed `XOR EAX,EAX` and `REP STOSD`; that establishes a firmware/model
mismatch rather than another missing V30 opcode. The remaining unmapped writes
seen with that RS firmware are `$0461` and `$0467`, model-specific memory
controls which are deliberately not guessed into the V30 baseline.

The diagnostic switch records open-bus accesses separately from the optional
all-I/O trace:

```sh
node pc98tools/boot.mjs --bios BIOS.ROM --itf ITF.ROM --io-unknown --frames 180
```

Each summary entry includes direction, port, value, count and the first CS:IP.

## 5. Video and host output

GDC1 scans a 16 KB text plane and GDC2 scans four 32 KB graphics planes. Text
is composed over graphics. The GRCG implements tile-direct-write and
read-modify-write operations across the planes. `render()` returns RGB by
default and can also return a GRB index plus per-gun analogue drive, matching
the common CRT pipeline in `demo/machine.html`.

The host has PC-98 ROM and floppy selectors and accepts D88, FDI and common raw
PC-98 geometries. Physical keyboard events are translated to PC-98 serial make
and break codes. Fast-forward, rewind, jog, clean display, raw PNG and recording
use capability probes and the ordinary machine contract.

## 6. Floppy-controller boundary

The PC-98 wrapper compensates for three behaviours that the shared
`upd765.js` intentionally does not model for an interrupt-driven host:

- execution-phase data request is DMA DREQ, not the command-complete interrupt;
- SPECIFY and SENSE commands do not generate interrupts;
- SENSE INTERRUPT STATUS with no pending event returns one byte, `ST0=$80`.

Disk objects are the same sector-addressed shape used by D88. FDI and raw
2HD/2HC/2DD images are converted into that shape before reaching the controller.

## 7. Snapshots and deterministic replay

A clean snapshot contains about 672,000 typed-array bytes: 640 KB RAM, 16 KB
text VRAM and small device state. After the first graphics write it grows to
about 803,072 bytes because the four 32 KB graphics planes are copied. The
graphics dirty flag is monotonic; a snapshot without planes means they were
still zero, so restore can clear them without depending on an earlier state.

The host sizes its rewind ring from a byte budget rather than a fixed frame
count. Main RAM remains a complete copy so every snapshot is independently
restorable. The clock starts from a fixed supplied epoch and no core path uses
`Math.random`, the DOM or host time.

The YM2203 register/timer state is restored exactly as observed by software.
Internal FM envelope phase is not exposed by the shared chip, so audio may
settle briefly after a rewind; this does not change CPU-visible state.

## 8. Verification status

`test-pc98.mjs` builds its own 96 KB BIOS, font and raw 2HD disk. It requires no
copyrighted ROM and covers reset-vector boot, rendered text pixels, the shared
I/O lanes, `$0439`, unknown-I/O logging, PPI placement, snapshots, ITF bank
switching, floppy geometry and the µPD765 boundary conditions.

Known limitations:

- no real V30-generation BIOS/disk boot has been verified;
- 80386 PC-9801RS firmware is outside the V30 CPU scope;
- `$0461/$0467` are not implemented for RS-class models;
- browser visual output remains unverified in the headless development environment.

Hardware-map references: [MAME PC-9801 machine](https://github.com/mamedev/mame/blob/master/src/mame/nec/pc9801.cpp), [MAME PC-9801 video](https://github.com/mamedev/mame/blob/master/src/mame/nec/pc9801_v.cpp), and the [Renesas V25/V35 instruction manual](https://www.renesas.com/us/en/document/mah/v25tmv35tm-family-instructions).
