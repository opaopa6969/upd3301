# PC Engine implementation

## 1. Scope and contract

This implementation adds the original PC Engine / TurboGrafx-16 HuCard system
to the same deterministic host as the PC-8001, PC-8801 and Famicom. The core is
pure JavaScript, has no DOM dependency and uses no random source.

`PceMachine` implements the host contract:

- `stepFrame()` and monotonically increasing `frame`
- `update(dt, onFrame)` and `frameHz`
- `snapshot()` / `restore()` and `schemaVersion`
- `render()` and `renderAudio()` as optional host capabilities

The cartridge is immutable and is held by reference. It is never included in a
snapshot. A snapshot contains mutable CPU, RAM, VDC, VCE, PSG, pad, mapper and
master-clock state, ~~and the framebuffer and audio output ring are outputs and
are also omitted~~ — **the framebuffer was wrongly on that list until
2026-08-11**. The host restores and draws without stepping a frame
(`demo/machine.html`'s `restoreIdx()`), so a snapshot with no picture in it
returns the frame that was on screen before the rewind. It now carries the
`frameWidth x frameHeight` window packed to its nine significant bits: 64,512
bytes at 256x224, on top of the ~80 KB the VRAM already dominates, for a
measured 143 KB. The audio ring is still an output and still omitted. See
[docs/machine-contract.md](./machine-contract.md) §2.6.

## 2. HuC6280 CPU

`huc6280.js` subclasses `m6502.js`. The shared core supplies the bus-cycle model
and interrupt machinery already checked against all 8,991 lines of nestest;
the subclass replaces the parts in which a HuC6280 differs from an NMOS 6502:

- eight MPR registers map the 16-bit logical address space into 2 MB of physical
  space in 8 KB pages;
- zero page and stack move to `$2000` and `$2100`;
- `CSL` / `CSH` select master-clock divisors 12 and 3;
- the T flag redirects the next ORA/AND/EOR/ADC through `$2000+X`;
- TAM/TMA, ST0/ST1/ST2, block transfers, bit branches and 65C02 instructions;
- three maskable interrupt sources, their mask/status registers, and distinct
  IRQ2, IRQ1 and timer vectors;
- the on-chip timer, clocked every 3,072 master clocks.

Internal CPU cycles matter because a block transfer spends six cycles per byte
but performs only two bus accesses. The CPU bus therefore has an optional
`idle(n)` callback. `PceMachine` advances the rest of the console for those
cycles just as it does for reads and writes.

The HuC6280 test suite checks every opcode for a terminating decode, the major
extended operations, CMOS decimal flags, MMU state, interrupt routing, timer
timing, state round trips and deterministic replay. `m6502.js` was not changed;
nestest remains 8,991/8,991 with status bytes `00 00`.

## 3. HuCard images and banking

`pcerom.js` treats `.pce` as a headerless ROM and handles common dump damage:

- a 512-byte copier header;
- bit-reversed data-line dumps, detected from the reset vector;
- small trailing garbage and truncated final banks;
- the non-power-of-two 384 KB and 768 KB layouts;
- the 2.5 MB Street Fighter II' bank-switching board.

The standard bank map has 128 cartridge pages. Flat addresses outside the ROM
fold 256 KB downward for cards of at least 256 KB. This was compared against
the complete 1,169-image collection using the `hudson`, `mirror` and `modulo`
rules rather than selected from one screenshot. Street Fighter II' keeps the
first 512 KB fixed and maps one of four 512 KB regions into banks `$40-$7F`.

A HuCard has no console-type field. SuperGrafx is therefore reported only from
an explicit option or an `SGX` / `SuperGrafx` filename hint. Guessing from byte
patterns produced many false positives because operands and graphics are data,
not metadata. The second VDC, VPC, 32 KB SuperGrafx work RAM, CD-ROM and Arcade
Card are not implemented.

## 4. Master-clock coordination

The only machine timebase is the 21.47727 MHz master clock:

| Consumer | Divider / period |
|---|---:|
| HuC6280 fast / slow | 3 / 12 |
| VCE dot clock | 4 / 3 / 2 |
| PSG | 6 |
| CPU timer | 3,072 master clocks |
| scanline | 1,365 master clocks |

The VCE chooses 262 or 263 lines, so `frameHz` is derived rather than rounded
to 60. A line has a top-of-line event and a later render event. The gap lets a
raster IRQ handler change scroll or palette registers before that same line is
drawn. The model is scanline based: mid-line VDC effects and exact bus-contention
timing are outside the current scope.

## 5. Video

`huc6270.js` models one HuC6270 VDC: 32K 16-bit VRAM words, the background tile
map, 64-entry sprite list, raster/vblank/collision/overflow status, VRAM DMA and
SATB DMA. The VDC emits palette indices. `huc6260.js` supplies the 512-entry
9-bit GRB palette, dot-clock selection and monochrome conversion.

The machine converts each completed line through the current VCE palette. This
preserves palette changes made by raster handlers. The core framebuffer is a
fixed maximum allocation with a live width and height; `render()` exports either
RGB or the indexed-plus-analog-drive shape consumed by the shared CRT host.

Known approximations include scanline rather than dot-level rendering, immediate
VRAM/SATB DMA completion, approximate vertical-phase reconciliation and the
absence of the SuperGrafx second video path.

## 6. Audio and input

`pcepsg.js` implements six 32-sample wavetable channels, direct D/A mode,
channels 4-5 noise, channel 1 to channel 0 LFO modulation, channel/global stereo
attenuation and deterministic resampling to the host rate. It is pushed by the
master clock, so register writes occur at simulation time rather than when the
browser asks for sound. The host receives a mono mix through the same
`renderAudio(out, n)` capability used by other machines.

The pad exposes I, II, SELECT and RUN in one active-low nibble and directions in
the other. The host maps its existing keyboard and gamepad actions through a
per-console bit table; no transport or input loop is duplicated.

## 7. Host integration

`demo/machine.html` has a `.pce` picker and PC Engine boot-mode button. It parses
the HuCard once, holds the immutable cartridge across resets, constructs a new
`PceMachine` on boot and uses the host's capability probes for rendering,
audio, snapshots and input. Rewind, jog-shuttle, pause and speed control require
no PCE-specific implementation.

The module script is syntax-checked headlessly. The actual browser canvas and
audio output are **visually and audibly unverified** in this environment.

## 8. Tests

Run with Node 24:

```sh
export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"
node test-huc6280.mjs
node test-pce.mjs
node nestools/nestest.mjs \
  /tmp/nes-test-roms-master/other/nestest.nes \
  /tmp/nes-test-roms-master/other/nestest.log
```

The PCE tests cover parser repair, banking, VCE/VDC register semantics, DMA,
background and sprite output, PSG generation/state, machine timing, IRQs, pads,
the host contract, snapshot replay, determinism, Street Fighter II' switching
and jammed-ROM progress.

## 9. No-oracle library sweep

`pcetools/pcerun.mjs` and `pcetools/sweep.mjs` follow the no-oracle method used
for the Famicom. A verdict never depends on the final frame alone:

1. sample throughout a long run and retain the best colour count;
2. count sampled-frame changes and VRAM changes;
3. after the run, execute 200,000 instructions and count distinct logical PCs;
4. classify a tiny CPU loop as dead only when the picture is also effectively
   frozen.

The buckets are `reject`, `jammed`, `dead`, `black`, `flat`, `static` and `ok`.
`ok` means only that the title ran substantial code and produced a changing,
multi-colour frame. It does **not** prove correct pixels, timing, sound or
gameplay. The sweep accepts an extracted directory in parallel or a ZIP archive
directly through `zip.js` (archive mode stays single-process to avoid copying
all member bytes through IPC).

The 300-frame calibration pass over all 1,169 images produced no parser/build
exception: `ok=947`, `flat=95`, `black=38`, `dead=89`. Under the alternative
bank rules, `ok` fell to 865 (`mirror`) and 868 (`modulo`), supporting the
256-KB fold used by the default map.

The final no-input pass ran every image for 1,800 frames and classified
`ok=997`, `flat=37`, `black=32`, `dead=103`. A second 1,800-frame pass tapped
RUN briefly every 40 frames so a static input wait was not mistaken for a
crash. Taking each image's better result across the two passes gives:

| Verdict | Images |
|---|---:|
| `ok` | **1,015** |
| `flat` | 23 |
| `black` | 33 |
| `dead` | 98 |
| parser/build exception, jam or unclassified static | **0** |

Thus all 1,169 images parse, construct and run to the time limit, while 1,015
meet the strong headless boot signal. Another 23 run and draw two or three
colours. The remaining 131 are not claimed working: 98 settle into a tiny CPU
loop with an effectively frozen picture and 33 remain single-colour. Many are
explicit bad/overdump variants while another dump of the same title boots;
SuperGrafx titles are also expected failures because their second video path is
absent. These are classification results, not visual compatibility results.
