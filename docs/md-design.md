**English** · [日本語](./md-design.ja.md)

# Mega Drive / Genesis — design

Adding the Sega Mega Drive as a *machine* in this emulator, next to PC-8001, PC-8801 and the Famicom. As with the Famicom, the point is not "another emulator": the host in `demo/machine.html` already implements deterministic fast-forward, rewind and jog-shuttle on a `snapshot()` / `restore()` contract with nothing machine-specific in it. **Satisfy the contract and time travel comes for free** — and it did, with no host changes beyond adding a file picker and a mode button.

The 68000 core (`m68000.js`) was written first, deliberately machine-agnostic, so the X68000 can share it. Nothing in this document changes it.

## 1. Contract (suite-contract)

- Pure, dependency-free JavaScript. No DOM, **no `Math.random`**.
- Deterministic: same cartridge + same input sequence + same number of steps → **bit-identical state**. Rewind is "restore a snapshot and replay the same inputs", so nondeterminism does not degrade the picture, it destroys every time-manipulation feature at once.
- Output is plain data + `schemaVersion`.
- Dependencies point one way. `m68000.js` and `z80.js` know nothing about a Mega Drive; `mdvdp.js` has no CPU; `ym2612.js` and `sn76489.js` have no bus. `machinemd.js` is the coordinator that closes the loop.
- Tests are `node --test`, headless, and include determinism tests.

## 2. Files

| File | What it is |
|---|---|
| `mdrom.js` | Cartridge images. Un-mangles the SMD copier interleave and the Multi Game Doctor byte swap, parses the 256-byte header at `$100` (title, serial, checksum, region in all three conventions, backup-RAM geometry), and accepts a headerless ROM whose reset vectors are sane. |
| `mdvdp.js` | The VDP (YM7101 / 315-5313). VRAM/CRAM/VSRAM, the two-word command port, per-scanline renderer for planes A and B, the window, sprites with their per-line limits, all three scroll modes on each axis, shadow/highlight, H/V interrupts, and the DMA engine. |
| `ym2612.js` | The FM chip (OPN2), built on the OPN core in `ym2203.js`: six channels across two register banks, stereo panning, LFO, channel 3's four independent frequencies, and the DAC on channel 6. |
| `sn76489.js` | The PSG: three squares and a noise generator with the Sega 16-bit LFSR. |
| `machinemd.js` | The machine class: `stepFrame()` / `frame` / `snapshot()` / `restore()` / `schemaVersion`, the master-clock scheduler, the 68000 and Z80 buses, bus arbitration, controllers, and backup RAM. |
| `mdtools/mkrom.mjs` | Hand-assembled test cartridges, so the tests carry their own fixtures. |
| `mdtools/screenshot.mjs` | Headless run + frame statistics + ASCII thumbnail + snapshot size. |
| `mdtools/sweep.mjs` | Run a directory of ROMs and bucket the results. |

## 3. The clock

Everything divides down from one master clock. On NTSC it is 53.693175 MHz; on PAL, 53.203424 MHz.

| Part | Divider | NTSC rate |
|---|---|---|
| 68000 | mclk / 7 | 7.670453 MHz |
| Z80, PSG | mclk / 15 | 3.579545 MHz |
| YM2612 | mclk / 7, then /144 internally | 53.267 kHz FM rate |

A scanline is **exactly 3420 master clocks** in both screen modes — H40 uses a mclk/8 pixel clock for 320 pixels and H32 a mclk/10 clock for 256, and both come to 2560 master clocks of active display plus 860 of blanking. NTSC has 262 lines, PAL 313, so the frame rates are 59.9227 Hz and 49.7015 Hz.

One YM2612 tick is 7 × 144 = **1008 master clocks exactly**, so the scheduler counts in integers with nothing accumulating.

`stepFrame()` walks the lines. For each line it calls `vdp.beginLine()` (H-counter reload, V interrupt at the first blanked line), runs 2560 master clocks of CPU time, draws the line, then runs the remaining 860. Inside those runs the machine advances in 1008-clock slices, giving the 68000 and the Z80 their share and stepping the DMA engine and the FM timers between them.

## 4. Where a line is drawn

At the moment the line's horizontal blank starts.

Every interesting Mega Drive effect is a mid-frame register write: Sonic's water line is a CRAM rewrite in an H-interrupt handler, a status bar is the window plane plus a scroll change, parallax is one horizontal-scroll table entry per scanline. A renderer that reads the registers once per frame draws none of them. Drawing at the start of H-blank means the register state for that line is final, and a game that writes during H-blank of line N-1 (which is what the H interrupt is for) is writing for line N — which lands correctly.

The line is converted to **RGB immediately**, not to palette indices. CRAM itself is one of the things that changes mid-frame, so deferring the colour lookup to the end of the frame would flatten exactly the effects this renderer exists to draw. The three DAC ramps (normal / shadow / highlight) are the measured ones, not a multiply.

Priority is resolved per pixel in one fixed order:

```
sprite(pri=1) > A(pri=1) > B(pri=1) > sprite(pri=0) > A(pri=0) > B(pri=0) > backdrop
```

The window is not a seventh layer: where it is active it *replaces* plane A for that pixel, with no scroll of its own.

## 5. DMA is a state machine, not a memcpy

This is the one design decision worth arguing about, so here is the argument.

The VDP steals bus slots at a rate the display mode decides: roughly one word every 20 master clocks while the screen is blanked, and about a tenth of that during active display where the renderer is using the slots. A full-screen tile upload therefore takes most of a vertical blank, and a long DMA started with the display on runs for many scanlines.

That timing is not a detail. **Direct colour DMA** — the trick that puts far more than 61 colours on screen — is one enormous DMA into CRAM that runs for a whole frame while the beam scans, so each scanline sees a different palette. An emulator that performs the transfer in one go at the trigger draws a black screen: every colour arrives before the first line. That is exactly what this implementation did in its first version, and Nemesis's `Direct-Color-DMA.bin` was a black screen. Turning the transfer into a state machine that the machine steps in master clocks — and drawing the picture between the steps — fixed it (37 colours, 52.7 % fill).

So: `_startDma()` sets up `vdp.dma`, `runDma(mclk)` moves as many units as the elapsed bus slots allow, and `dmaHoldsBus` tells the machine whether to run the 68000 at all this slice. A VRAM copy does not hold the 68000 bus (it is internal to the VDP); a 68000→VDP transfer and a VRAM fill do.

## 6. Two CPUs

The 68000 owns the machine. The Z80 has its own 8 KB of RAM, the FM chip and the PSG, and a 32 KB window onto the 68000's address space positioned by a **shift register** at `$6000` — nine writes of one bit each, LSB first. (A driver that writes the bank as a byte gets nonsense, which is why every one of them loops.)

The 68000 requests the Z80's bus at `$A11100` and holds it in reset at `$A11200`. At power-on the Z80 is held in reset with the 68000 owning the bus, because a Z80 that started running would execute whatever was in its RAM.

A 68000 **word** write into the Z80's address space puts only its high byte on the 8-bit bus; a word read sees the same byte twice. Getting this wrong uploads every other byte of a sound driver.

The two CPUs are interleaved at 1008-master-clock slices rather than instruction by instruction. A Z80 write to the FM chip therefore lands within about a third of a scanline of where it would on hardware, which is far finer than any music driver's resolution and much cheaper than a true lock-step.

## 7. Interrupts

The VDP drives two levels into the 68000: **6** for the vertical interrupt (register 1 bit 5 enables it) and **4** for the horizontal one (register 0 bit 4). The H counter is loaded from register 10 at the top of the frame, counts down through the active display and is held reloaded through blanking, so with register 10 = *n* the interrupt lands on line *n* and then every *n*+1 lines.

Both are **level-triggered**: `vdp.irqLevel()` reports what the pins say, and the pending flag is cleared by `irqAck()`, which `m68000.js` calls when it takes the autovector. That is the only correct arrangement — clearing on assert would let a masked interrupt be lost, and never clearing would re-enter forever.

The vertical interrupt also reaches the Z80 as a single INT pulse one scanline long. A driver with interrupts disabled misses it, so the request is retried across the line rather than fired once.

## 8. Snapshots — measured

`snapshot()` holds mutable state only. The cartridge stays where it is (512 KB to 4 MB of it) and the VDP's frame buffer is output, not state.

| Contents | Bytes |
|---|---|
| 68000 work RAM | 65,536 |
| VDP VRAM | 65,536 |
| Z80 RAM | 8,192 |
| CRAM + VSRAM + VDP registers + control state | ~1,000 |
| YM2612 (both register banks + 6 × 4 operator states as one `Float64Array`) | ~4,000 |
| 68000 + Z80 registers, PSG, controllers, scheduler | ~1,000 |
| **Total, measured** | **141.9 KB** |
| …with backup RAM that has been written | **173.9 KB** |

(Measured with `node mdtools/screenshot.mjs <rom> --snapsize`, counting typed arrays at their byte length. `JSON.stringify` is the wrong measure — a `Uint8Array` serialises as an object with 65,536 keys.)

Backup RAM is copied **only once something has written to it**. Plenty of cartridges declare a 32 KB save chip and never touch it during play, and 32 KB of zeroes per rewind slot is a fifth of the ring spent on nothing. The `sramDirty` flag is monotonic, so a snapshot without a copy unambiguously means "the save chip was still blank here".

What that buys, against the host's ring in `demo/machine.html`:

| Rewind buffer setting | Interval | Snapshots | Memory |
|---|---|---|---|
| 45 s (default) | 6 frames | 450 | 62 MB |
| 2 min | 8 frames | 900 | 125 MB |
| 10 min (max) | 36 frames | 1000 | 139 MB |

The host auto-coarsens the interval to keep the count at or under 1000, so the Mega Drive fits its 10-minute maximum at about 139 MB — the same order as the PC-8801 (~130 KB per snapshot) and about forty times the Famicom's NROM snapshot. The YM2612's channel and operator state is packed into one flat `Float64Array` rather than 6 objects holding 4 objects holding 15 fields, because a thousand slots of the object version is 30,000 short-lived objects per second of history and that shows up as a stutter while scrubbing.

## 9. Verification

### 9.1 No commercial ROMs were available

`/mnt/c/var/emulator/` was searched exhaustively (18 GB, 330 directories). **There are no Mega Drive game ROMs on this machine at all** — zero `.smd` / `.gen` / `.32x`, and no MD ROM archives. What is there: three Mega Drive emulators, and a BIOS collection containing the TMSS boot ROM, the 32X BIOSes and three Mega CD BIOSes. (The many `*MD*.zip` files under the PC-88 collection are MIDI *music data* disks, not Mega Drive.) So everything below was verified against free test ROMs and homebrew, exactly as the Famicom work was.

### 9.2 Getting the test ROMs

None of these are committed. Fetch them into a scratch directory and pass the path on the command line.

| Source | What |
|---|---|
| [Exodus emulator techdocs](https://techdocs.exodusemulator.com/Console/SegaMegaDrive/Software.html) | Nemesis's hardware test ROM collection: VDP port access (a.k.a. VDP FIFO testing), sprite masking, shadow/highlight, window, V counter, CRAM flicker, direct colour DMA, 1536 colours, 68000 opcode sizes, BCD verifier, memory test. Each is a Google Drive zip: `curl -sSL -o X.zip "https://drive.google.com/uc?id=<ID>&export=download"` |
| [240p Test Suite on itch.io](https://artemiourbina.itch.io/240p-test-suite) | The Mega Drive build, 1.32. There are no GitHub releases; the itch.io download needs a CSRF token and a minted session (three `curl` calls). |
| [HD Retrovision](https://www.hdretrovision.com/free-stuff) | `HDRV_Genesis_Test_v1_4.zip` |
| `raw.githubusercontent.com/Stephane-D/SGDK/master/sample/<path>/out/release/rom.bin` | 30 prebuilt SGDK sample ROMs. They are committed in the repo tree, not in releases. |
| GitHub releases | `sikthehedgehog/stereo-test`, `sikthehedgehog/indigo`, `andwn/cave-story-md`, `ResistanceVault/demo-Masiaka`, `huguesjohnson/RetailClerk89`, `alicesim1/Penguin-World` |
| `raw.githubusercontent.com/sikthehedgehog/...` | `5stars`, `miniplanets`, `projectmd`, `ram-viewer`, `version-check` — binaries committed in-repo |

Two sources named in the original plan are **gone**: `jdesiloniz/vdpfifotesting` is a 404 with no fork and no Wayback snapshot (the same ROM is on the Exodus mirror), and `flamewing/megadrive-test-roms` is a 404 (the BCD verifier is on the Exodus mirror too).

### 9.3 The sweep

66 ROMs, 240 frames each, classified mechanically by `mdtools/sweep.mjs`:

```
ok=47  flat=14  black=4  reject=1  total=66
```

- **ok (47)** — a multi-colour picture that kept moving. Includes the 240p Test Suite, VDP FIFO/port testing, sprite masking, shadow/highlight (114 colours), the window tests, the V counter test, direct colour DMA, the 1536-colour test (**1407 distinct colours on screen** — per-line CRAM works), Cave Story MD, Titan's *Overdrive*, and 26 SGDK samples.
- **flat (14)** — drew, but in one colour. Most are correct: SGDK's `hello-world` really is white text on black, and the ASCII thumbnail shows the words. `bad-apple`, `cube-3D`, `partic`, `bsp_interior*` and `benchmark` are genuinely 1-bit content. `titan-overdrive2` is *not* correct — see below.
- **black (4)** and **reject (1)** — listed honestly below.

### 9.4 What does not work, and why

| ROM | Result | Reason |
|---|---|---|
| `cram flicker.bin` | black | The ROM writes CRAM 6,401 times per frame to two entries and **never writes VRAM or a nametable at all** — the entire picture is the backdrop, and what it is testing is the sub-pixel DAC artefact a CRAM write causes on the dot being drawn. This renderer samples CRAM once per scanline, so there is nothing to see. Not fixable without a per-dot renderer. |
| `FM Test by DevSter (PD).bin` | black | 1,276 bytes, no graphics code at all: it is an audio-only test. VRAM and CRAM are empty *by design*. A black screen is the correct result. |
| `sgdk-megawifi-basic.bin` | black | Needs MegaWiFi cartridge hardware that is not emulated. |
| `bcd-verifier-u1.bin` | black at 240 frames | The display is deliberately off while it computes. It reaches its result screen at **frame 541** and holds it (5 colours, 3.1 % fill). Whether the result says PASS is **not verified** — the font is proportional and unreadable in an ASCII thumbnail. |
| `itest.bin` (68000 illegal opcodes) | loads, display never enabled | It is headerless (256 exception vectors fill `$000-$3FF`), which `mdrom.js` now accepts on the strength of its reset vectors. It gets to `$4EC` and stops enabling the display. Unresolved. |
| `titan-overdrive2.bin` | flat | Uses the SSF mapper (`SEGA SSF` in the header) for its 8 MB of banking, which is not implemented. *Overdrive 1* runs. |

### 9.5 Determinism

`test-md.mjs` has 55 tests. The load-bearing ones:

- two machines built from the same ROM, stepped 25 frames, produce **deep-equal snapshots**;
- `snapshot()` → 12 frames → `restore()` → 12 frames reproduces the same state exactly;
- a replay across 20 frames of vertical interrupts reproduces the same interrupt count per frame;
- `restore()` re-asserts the interrupt **level** on the CPU, because the level is the machine's to drive and not the CPU's to remember;
- a snapshot contains no cartridge, and restoring into a second machine holding the same cartridge is enough.

## 10. Known gaps

Everything here is a deliberate omission, not an unknown.

1. **No VDP write FIFO.** The status bits report an empty FIFO and the 68000 is never stalled by a full one. `VDPFIFOTesting.bin` runs and draws, but its *verdict* is unverified.
2. **CRAM is sampled once per scanline.** Mid-line CRAM writes take effect from the next line. See `cram flicker.bin` above.
3. **No interlace.** Register 12's LSM bits are stored and ignored.
4. **Three-button pads only.** No six-button pad, no multitap, no light gun (the HV counter latch is implemented, but nothing triggers it).
5. **No cartridge mappers.** Plain ROM up to 4 MB plus the Sega backup-RAM control at `$A130F1`. SSF, SSF2 and the various pirate mappers are absent.
6. **No Mega CD, no 32X.**
7. **The Z80 and the 68000 interleave at 1008 master clocks**, not instruction by instruction. A game that busy-waits on a Z80-written flag with single-instruction precision would notice; none is known to.
8. **The YM2612's LFO is approximate.** The rates are the documented ones and the depths are close, but the real chip's phase modulation is a piecewise table indexed by the top bits of F-number, not a proportional wobble. The DAC's ladder distortion — part of what "Mega Drive sound" means — is not modelled.
9. **The H counter is derived from the machine's position in the line**, at 1008-master-clock granularity (about a fifth of a line). Software that polls it to find the blanking edge works; software that needs a specific dot does not.
10. **Visual verification is untested.** Everything above is a frame-buffer statistic from a headless run. Whether the pictures *look right* in a browser has not been checked and is honestly outside what a headless test can say.

## 11. Host integration

`demo/machine.html` needed a file picker, a mode button, a keyboard map and a boot branch. Nothing else — fast-forward, rewind and jog-shuttle worked unchanged, which is the contract doing its job.

Two `instanceof`-shaped probes were generalised on the way, in the same spirit as the Famicom work:

- `renderAudioInto()` tested `machine.opn` (a PC-8801 field). It now tests `typeof machine.renderAudio === 'function'`, so any machine that can make sound does.
- `canvas` click tested `bootMode === 'n88'` before unblocking autoplay. Same capability probe.

Keyboard: arrows for the D-pad, `Z`/`X`/`C` (or `A`/`S`/`D`) for A/B/C, Enter or Space for START. A gamepad's 8801 joystick bits are *translated* rather than mapped a second time, so the existing pad-config panel keeps working.

## 12. Notes for whoever does the X68000

The 68000 core was a pleasure to use and needed no changes. Specifically:

- `read16`/`write16` really are the only required bus methods, but **supply `read8`/`write8` anyway** if any part of your map is registers. The synthesised byte accessors do a read-modify-write on the containing word, and a spurious read of a status register that clears on read will bite you. (The Mega Drive's VDP status and its controller latches both would have.)
- `irqAck(level)` returning `-1` for autovector is exactly the right shape for a level-triggered source. Clear your pending flag there and nowhere else.
- `new M68000(bus)` resets in the constructor, so the bus has to be able to answer vectors 0 and 1 already. If you map ROM later, call `cpu.reset()` again — `machinemd.js` does, from its own `reset()`.
- `{ tasWriteBack: false }` is Mega Drive-specific. The X68000 wants the default.
- `cpu.step()` returns clock periods, so converting to master clocks is a multiply. Budgeting in master clocks rather than CPU cycles is what let two CPUs at 7:15 share one integer schedule.
- The one thing that cost time: nothing in the core, but **a machine that runs the CPU to a time budget must stop when the CPU loses the bus.** `_run68k()` returns early the moment `vdp.dmaHoldsBus` becomes true, or a DMA started mid-instruction gets ignored for the rest of the slice.
