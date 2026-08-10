**English** · [日本語](./gb-design.ja.md)

# Game Boy / Game Boy Color — design

Adding the Game Boy and the Game Boy Color as *machines* in this emulator, next to PC-8001, PC-8801 and the Famicom. As with the Famicom ([docs/nes-design.md](./nes-design.md)), the point is not "another emulator": the host in `demo/machine.html` already implements deterministic fast-forward, rewind and jog-shuttle on top of a `snapshot()` / `restore()` contract with nothing machine-specific in it. **Satisfy the contract and time travel comes for free.**

What makes this console different from every other machine here is not the hardware. It is that **the verification corpus is redistributable**. A PC-8801 needs a BIOS nobody may hand out, so its tests skip in CI and "verified" means "verified once, on the author's disk". The Game Boy's 256-byte boot ROM only scrolls the logo and then unmaps itself — the cartridge is self-contained — and its test-ROM culture produced suites under the MIT licence. So `gbroms/` holds 103 mooneye ROMs and dmg-acid2 (1.2MB, gzipped), and **CI runs them for real on a clean checkout**. That was the goal of issue #42, and §10 has the numbers.

## 1. Contract (suite-contract)

- Pure, dependency-free JavaScript. No DOM, no `three`, **no `Math.random`**. The noise channel's randomness is an LFSR, which is hardware, and it is in the snapshot.
- Deterministic: same cartridge + same input sequence + same number of steps → **bit-identical state**. Rewind works by restoring a snapshot and replaying inputs, so nondeterminism does not degrade the picture, it destroys every time-manipulation feature at once.
- Output is plain data + `schemaVersion`.
- Dependencies point one way. `sm83.js` knows nothing about a Game Boy: it takes a bus and executes. `gbppu.js` knows nothing about a CPU. `gbmbc.js` knows nothing about either. `machinegb.js` is the coordinator that closes the loop.
- Tests are `node --test`, headless, and include determinism tests. **They pass on a clone with no ROMs**: the bundled corpus is committed, and the one suite that is not (blargg's — see §10) skips.

## 2. Files

| File | What it is |
|---|---|
| `sm83.js` | The Sharp SM83 CPU. No cycle table: every bus access is one M-cycle and internal delays are explicit, so the PPU and the timer see accesses in the real order. HALT bug, the EI latch, the `ie_push` vector quirk. See §4. |
| `gbppu.js` | The picture. Dot-accurate mode timing (456 dots × 154 lines, mode 3 stretched by SCX, the window and each object), line-based *rendering*, the STAT interrupt as the rising edge of one OR. See §5. |
| `gbapu.js` | Four channels — two squares, wave, noise — hanging off one 512 Hz sequencer that the machine drives from a bit of DIV. Plain `Float32Array` out; no WebAudio. See §6. |
| `gbmbc.js` | Cartridge header + the boards: MBC1/2/3(+RTC)/5, HuC1, and none. A registry keyed by `$0147`, the same shape as `nesmapper.js`. Also `buildGbRom()` so tests can author cartridges. See §3. |
| `machinegb.js` | The machine: `stepFrame()` / `frame` / `snapshot()` / `restore()` / `schemaVersion` / `render()` / `renderAudio()`, plus the four things that belong to no chip — the timer, the joypad, the serial port and the two DMA engines. See §7. |
| `test-gb.mjs` | 52 tests: units, determinism, the host transport, and the real ROMs. |
| `gbtools/gbrun.mjs` | The shared half of the tools: gzip-aware ROM loading, the run loop, and the two verdict readers (mooneye's `LD B,B` breakpoint, blargg's serial/`$A000` report). |
| `gbtools/suite.mjs` | Run a directory of ROMs, print a table. |
| `gbtools/acid2.mjs` | Run dmg-acid2 and compare against the reference PNG, exactly. Includes a small PNG decoder (node has the inflate; the rest is 60 lines). |
| `gbtools/verify.mjs` | What CI runs: the whole bundled corpus as a printed score, exit 1 on a regression. |
| `gbtools/fetch-blargg.mjs` | Downloads blargg's suites, which are **not** bundled (no licence — §10). |
| `gbroms/` | The corpus, with a licence file per source. `gbroms/README.md` says which and why. |

## 3. `gbmbc.js` — the cartridge

A `.gb` file is not a memory image, it is a *board*. The console has 8KB of work RAM, 8KB of video RAM and no storage; the cartridge supplies the program, the save RAM, the bank-switching logic and — on one family — a clock. So `$0147` names the board and the registry turns it into an object, exactly as `nesmapper.js` does for iNES mapper numbers. An unimplemented board is an ordinary answer (`tryCreateMbc()` → `{ ok: false }`), not a crash, because any ROM library contains boards nobody wrote.

Implemented: **MBC5** (nine bits of bank in two honest registers, no hole — most of the Color library), **MBC3** (+RTC), **MBC1** (the awkward one), **MBC2** (512 nibbles of RAM on the chip), **HuC1** (MBC1 work-alike), and **none**. Not implemented: MBC6, MBC7, MMM01, HuC3, the Pocket Camera, TAMA5.

Two decisions worth naming:

**MBC1's mode flag and its hole.** The 2-bit register at `$4000` is the upper ROM bank bits in mode 0 and the RAM bank in mode 1, and in mode 1 it also applies to the `$0000-$3FFF` window — which is how a 1MB cartridge reaches its second half. Then bank `$00` selected at `$4000` reads as `$01`, and with the upper bits in play so do `$20`, `$40`, `$60`. Four banks of every large MBC1 cartridge are unreachable and the games were built around it. Note that the upper bits only *mean* anything when the ROM is large enough to have the address lines: on a 512KB cartridge bank `$25` selects bank `$05`, which is not a bug but the absence of a wire. (A test that forgot this was the first of the five failures inherited with this branch — §12.)

**The RTC never calls `Date.now()`.** MBC3's clock is the one place a Game Boy emulator is tempted to read the host, and doing so would break the property everything here is built on. So it is clocked from *emulated* cycles, it lands in the snapshot like any other register, and rewinding time rewinds the cartridge's clock with it. A player who wants the real date sets it once with `setRtcFromDate()` — an explicit input, not an ambient one.

## 4. `sm83.js` — the CPU, and why it is not derived from `z80.js`

**This is the design decision issue #42 asked to be justified, so it is stated in full.** The SM83 is usually described as "a Z80 with bits missing", the register names match, and `z80.js` is right there. It was rejected on two grounds.

**Structural.** `z80.js` is *instruction-atomic*: `step()` executes a whole instruction against the bus and then returns a T-state count from a table. That is the right shape for a PC-8801, where nothing observes the machine between two halves of an instruction. It is the wrong shape here, because the Game Boy's test suites measure *which M-cycle of an instruction* an access happens on. mooneye's `push_timing`, `call_timing`, `oam_dma_timing` and the entire `timer/` group work by arranging for the PPU or the timer to change state between two bus cycles of one instruction and then reading the result. So `sm83.js` is written the way `m6502.js` is (nes-design §4): **there is no cycle table**. Every bus access costs exactly one M-cycle, internal delays are explicit `_idle()` calls, and the machine's clock advances *from inside the CPU's bus*:

```js
this.cpu = new SM83({
  read:  (a)    => { this._tickM(); return this._read(a); },
  write: (a, v) => { this._tickM(); this._write(a, v); },
  tick:  ()     => this._tickM(),
  ...
});
```

Cycle counts then come out right for free, and — much more usefully — the PPU, the timer and the DMA engine see the accesses in the real order. A write to `$FF46` starts the OAM DMA on its real M-cycle; a read of `$FF41` sees the STAT the PPU is showing on that dot. No catch-up logic anywhere.

**Blast radius.** `z80.js` is the CPU of the PC-8801, the machine this repository was originally about, and `test-z80.mjs` is its regression net. A shared base class would put every Game Boy timing fix one edit away from that net, for a payoff smaller than it looks: no shadow registers, no IX/IY, no ED/DD/FD prefixes, no IN/OUT, four flags instead of six (no S, no P/V, and the low nibble of F is *physically absent* — `POP AF` of `$FFFF` reads back `$F0`), a different DAA, different flags on 16-bit ADD, eleven opcodes that do not exist and twelve the Z80 never had. What would actually be shared is about a dozen lines of ALU.

**Verdict: independent core, same shape as `m6502.js`.** 569 lines. The cost is a second CPU to maintain; the benefit is that `blargg/cpu_instrs` and `blargg/instr_timing` both pass (§10) and `z80.js` was never touched.

Three behaviours worth naming, because each one is a test:

- **The EI latch.** What is subtle is not how long it lasts but *where* it resolves: after the interrupt check of the following instruction and before that instruction executes. So the instruction after `EI` always runs, `EI; DI` never lets anything through, and eighteen `EI`s in a row still take the interrupt after the second (mooneye `ei_sequence` pins the pushed return address to the byte).
- **The HALT bug.** `HALT` with IME clear and an interrupt already pending does not halt; instead the byte after it is executed twice, because PC fails to increment once.
- **`ie_push`.** The interrupt vector is chosen *after* the high byte of PC has been pushed. With `SP = $0000` that push lands on `$FFFF`, which *is* the IE register, and the vector is decided from the value the push just wrote — so the dispatch can end up with nowhere to go and land at `$0000`.

The eleven unwired opcodes **jam** the CPU (a `jammed` flag) rather than throwing or acting as NOPs. A ROM that reaches one has gone off the rails, and the host wants to be told.

## 5. `gbppu.js` — the picture

**Mode timing is dot-accurate; rendering is line-based.** These are separate claims and the split is deliberate.

Real hardware builds a scanline with a pixel FIFO: two shift registers fed by a fetcher that walks the tile map, stalling while objects are patched in. Emulating the FIFO buys the last few percent — mid-scanline register writes, the "mealybug" tests — at the cost of a much larger and much slower core. dmg-acid2's own README says a line-based renderer is sufficient for it, and that is the test that decides whether the *picture* is right. So objects are latched at the mode 2 → mode 3 boundary and the line is painted at the mode 3 → mode 0 boundary.

The *clock*, though, runs in dots, 456 per line, 154 lines, and the mode boundaries move: mode 3 is longer when the background is scrolled to a fractional tile (`+ SCX & 7`), longer again when the window opens (`+6`), and longer again per object on the line. Games use those boundaries as a raster clock and mooneye's `ppu/` group measures them to the dot, so they are modelled properly even though the pixels are not.

**The STAT register lags the mode by one M-cycle.** That single fact reconciles three mooneye tests that otherwise contradict each other: `hblank_ly_scx_timing` says mode 0 really starts at dot 252, `intr_2_0_timing` says the mode 2 interrupt is at dot 0, and `intr_2_mode0_timing` says a STAT *read* does not show mode 0 until dot 256. Any attempt to satisfy the third by moving a boundary breaks one of the first two. The boundaries are right; the register is late. The VRAM and OAM locks follow the lagged mode too, because `intr_2_oam_ok_timing` gets the same answer as `intr_2_mode0_timing`.

**The STAT interrupt is the rising edge of one OR, not four sources.** Hardware ORs four conditions onto one wire and the interrupt fires on that wire's rising edge only. The consequence is counter-intuitive and observable: enabling the HBlank *and* OAM sources gives **fewer** interrupts than enabling either alone would suggest, because the HBlank of one line runs straight into the OAM slot of the next with no gap for the wire to fall through. Measured over one frame from a cold start: HBlank alone 143, OAM alone 145, **both together 144** — not 288. That is mooneye's `stat_irq_blocking`, and `test-gb.mjs` asserts all three numbers.

Two more that are easy to get wrong and are each one test: **line 153** reads LY = 153 for four dots and then 0 for the rest of the line (games use LYC=0 for an interrupt at the very top of the frame); and the **LY=LYC bit is latched, not computed on read**, so switching the LCD off freezes it and changing LYC while off does nothing.

Output is a `Uint16Array`: a shade index 0-3 on a DMG, a 15-bit BGR555 colour on a Color. The DMG's four greys are written as `$FF/$AA/$55/$00` exactly because dmg-acid2's README asks for those values, which is what lets the comparison be byte-for-byte with no tolerance.

## 6. `gbapu.js` — the sound

Four channels that are not four oscillators but four *counters* sharing one 512 Hz heartbeat — and that heartbeat is derived from the same DIV register the timer uses. Writing `$FF04` to reset DIV therefore changes the phase of the music. So the frame sequencer is *driven by the machine* from a falling edge of a DIV bit (bit 12 of the internal counter, bit 13 in double speed: 512 Hz either way) rather than owning a divider of its own. Taking "DIV bit 4" literally against the internal counter runs the sequencer 256× too fast, which sounds like nothing in particular and quietly fails every length-counter test there is.

Channel timers are exact, in T-cycles. The mixer is not: the per-channel DAC is a resistor ladder into an analogue mixer with per-side volume, and the high-pass that makes the "charge" audible when a channel is switched off mid-note **is** modelled (it is the difference between a click and no click); the rest is linear.

The sample ring is **output** and is not in the snapshot — but the resampler's phase and the high-pass memory are, which is what makes the *sequence of samples* after a restore continue the same waveform instead of ticking.

## 7. `machinegb.js` — the machine

The coordinator owns what belongs to no chip: the timer, the joypad, the serial port, the OAM DMA and the Color's two HDMA engines.

**The timer is a bit of the divider, not a divider of its own.** TAC's clock select names a bit of the 16-bit counter behind DIV, and TIMA counts that bit's *falling* edges. Modelling it that way is what makes the whole `timer/` group work: writing `$FF04` resets the counter, and if the selected bit was high at that moment the reset **is** a falling edge and TIMA increments. The four-cycle reload window after an overflow is modelled too — during it TIMA reads zero, a write to TIMA cancels the reload entirely, a write to TMA supplies the new value, and a write on the reload cycle itself is ignored.

**OAM DMA takes one bus, not the memory map.** The console has two: the external one (cartridge, work RAM and its echo) and the video one (VRAM). The DMA takes whichever its source is on, plus OAM, and leaves the other alone. Blocking everything below `$FF00` — the usual shortcut — makes mooneye's timing tests execute `$FF` (= `RST 38`) and hang, because they deliberately run a `JP nn` out of echo RAM at `$FDFE` while a DMA from `$8000` is in flight.

**There is no boot ROM, and that is the whole point of this console being here.** The 256 bytes only scroll the logo, check the header and unmap themselves; nothing after `$0100` needs them. So the machine starts at `$0100` with the registers the boot ROM would have left (`sm83.js`'s `reset()` and `_bootIo()`), including the DIV counter — which looks arbitrary and is not: the boot ROM takes a fixed number of cycles, so the divider has a known value the instant the cartridge gets control, and mooneye's `boot_div` reads it. A real boot ROM can still be supplied (`{ bootRom }`) and `$FF50` unmaps it exactly as on hardware.

`stepFrame()` runs until the raster reaches the top of vblank. The picture is complete at that point and the game's vblank handler runs at the start of the *next* `stepFrame()`, so a snapshot taken here holds a finished image and a program about to be told about it — the same boundary as the Famicom's. **The first `stepFrame()` after a reset is short** (16,418 M-cycles instead of 17,556) because the machine starts at LY=0 and the first frame is therefore 144 lines rather than 154; every frame after it is a whole revolution. Over 60 frames the total is 60 × 17,556 to within one instruction.

## 8. Host integration (`demo/machine.html`)

A `ゲームボーイ` boot mode next to `ファミコン`, a `.gb`/`.gbc` picker, and a **GB / GBC selector** (`auto` believes the cartridge's CGB flag; forcing the other way is worth being able to see, since a Color-aware ROM also runs on a DMG). No BIOS picker: there is nothing to pick.

Everything else was already there, because the host asks what a machine *can do* rather than what class it is: `render({ indexed: true, analog: true })` feeds the shared phosphor pipeline (the index is a coarse GRB reduction, `drive` carries the real colour, which matters on a Color's 32,768), `renderAudio()` feeds the audio pump, and `stepFrame()`/`snapshot()`/`restore()` give fast-forward, rewind and the jog-shuttle unchanged. Input is the Famicom's keyboard layout with the Game Boy's bit numbering — the two consoles have the same eight controls, so a player does not have to learn a second keyboard — except that the machine is *told* (`setPad()`) rather than read, because a line going low requests the joypad interrupt and wakes a `STOP`ped CPU.

The DMG's screen is rendered **green** in the demo (the shades mapped onto the classic pea-soup LCD) while `toRgb()` keeps the neutral greys dmg-acid2 compares against. The demo looks like the object; the test compares the numbers.

**Not verified:** the actual on-screen result in a browser, and the actual sound. Everything above is verified headless — frame buffers, snapshot/restore, the transport loop reproduced in `test-gb.mjs` — but the pixels reaching a real canvas through the phosphor/tube simulation and the samples reaching a real speaker are **visually and audibly unverified**.

## 9. Snapshot policy — and why the picture is *state* here

`demo/machine.html` keeps up to 1000 snapshots in a ring and auto-tunes the interval to stay near 150MB, so **a big snapshot means a short rewind window**. The usual rules apply: immutable data (the cartridge ROM) is held by reference and never copied; save RAM that has never been written is omitted entirely (`null`, and restore zero-fills, which is what "never written" means); everything is plain data so `restore()` writes into existing objects.

**But the frame buffer is in the snapshot, and on every other machine here it is not.** This is the one place this design departs from `machinenes.js`, and it is worth the paragraph.

The Seta machine passed every contract test in its file and still landed on the wrong frame 61 times out of 250 when the host rewound, because its picture was a function of history rather than of state. The same trap is here, in a different shape. A finished Game Boy frame holds 144 lines each painted with the registers as they stood when the raster crossed them: it is a *record of the frame that just happened*, and no amount of register state can recompute it. The host restores a snapshot and then draws — that is literally what happens every animation frame while the jog-shuttle is held — so a snapshot without the picture makes the screen show whatever frame the emulator last ran.

This was not theoretical. The test that catches it (`dmg-acid2 also exercises the rewind ring on a real ROM`) was inherited **failing**: slots 0 and 7 of a 120-frame ring came back holding frame 120's picture. Nothing else in the file noticed, because the other rewind test drove a ROM that uploads no tile data and therefore draws a uniform screen — every comparison was between two identical blank pictures. Both were fixed: the picture travels, and that test now drives a ROM whose screen actually moves (§12).

A DMG pixel is two bits, so the picture packs four to a byte: **5,760 bytes**. A Color pixel is a real 15-bit colour that no palette lookup can reconstruct after the fact (the game may have rewritten the palette on a later line), so there it travels raw at 46,080.

### Measured sizes

`snapSize()` (typed arrays cost their bytes, numbers eight, objects a token amount), on a snapshot taken at a frame boundary:

| Machine | Total | Where it goes |
|---|---|---|
| **DMG** (dmg-acid2, 120 frames in) | **23,660 B** | VRAM 8,192 · WRAM 8,192 · **picture 5,760** · APU 671 · OAM 160 · HRAM 127 · CPU 110 |
| **DMG** (MBC5 + 8KB battery RAM, untouched) | **23,669 B** | the same; the save RAM is `null` until something writes it |
| **CGB** | **96,876 B** | **picture 46,080** · WRAM 32,768 · VRAM 16,384 · palettes 128 · APU 671 |
| **CGB** (MBC3 + RTC + 32KB RAM) | **96,992 B** | + 141 B of board state (the live clock, the latched copy, the sub-second divider) |

Against the machines that came before: NES 3KB, FDS 47KB, Seta 51KB, MD 142KB, X68000 1564KB. **A DMG is still the smallest machine here** and a Color sits between the Famicom Disk System and the Mega Drive. No snapshot contains the string `"rom"` — asserted, not assumed.

## 10. Testing — the numbers

`node --test test-gb.mjs` → **52 tests, ~5 s** on a clone with no external ROMs (51 pass + 1 skip: the blargg group). With blargg fetched, 52 pass in ~14 s. `node gbtools/verify.mjs` prints the same corpus as a score and exits 1 if any number drops.

### Bundled and executed in CI (MIT; see `gbroms/README.md`)

| Suite | Result |
|---|---|
| **mooneye-gb acceptance** | **59 / 75** — of the 16 failures, **9 are tests written for hardware this is not** (DMG 0, Game Boy Pocket, Super Game Boy) and are supposed to fail; **7 are real holes**, listed below. |
| **mooneye-gb emulator-only (MBC)** | **27 / 28** — the one failure is `mbc1/multicart_rom_8Mb`. |
| **dmg-acid2** | **exact match**, 23,040 / 23,040 pixels, no tolerance. |

The seven real acceptance holes: `oam_dma/reg_read`, `oam_dma_start`, `ppu/intr_2_mode0_timing_sprites`, `ppu/lcdon_timing-GS`, `ppu/lcdon_write_timing-GS`, `ppu/stat_lyc_onoff`, `serial/boot_sclk_align-dmgABCmgb`. Each is explained in §11.

### Not bundled — blargg (no licence at all)

blargg's suites are the best-known Game Boy test ROMs there are and are mirrored everywhere, but **neither the ROMs nor their sources carry a licence or a public-domain dedication**. "Everybody mirrors it" is not a licence, so they are not in this repository. `node gbtools/fetch-blargg.mjs` puts them in `gbroms/blargg/` (git-ignored) and the test skips without them.

| ROM | Result |
|---|---|
| `cpu_instrs` | **pass** (all 11) |
| `instr_timing` | **pass** |
| `mem_timing` | **pass** |
| `mem_timing-2` | **pass** |
| `halt_bug` | **pass** |
| `interrupt_time` | **pass** |
| `dmg_sound` | **9 / 12** — fails 09, 10, 12 (wave RAM access window) |
| `cgb_sound` | **8 / 12** — fails 08, 09, 11, 12 (the same, plus the Color's wave differences) |
| `oam_bug` | **2 / 8** — the DMG's OAM corruption bug is not modelled at all |

**6 of the 9 multi-ROMs pass outright.** The three that do not are named holes, not mysteries.

### Determinism and the host transport

The four properties every machine here is tested for, plus the two that Seta's failure added:

1. Same cartridge run twice → identical snapshot **and identical picture**.
2. Snapshot → run ahead → restore → replay → identical snapshot and picture.
3. The same with **input arriving mid-replay** (a joypad interrupt after the snapshot was taken).
4. ×4 fast-forward lands on exactly the state ×1 would have reached.
5. **The host's rewind ring, replayed.** 100 slots over 600 frames of a ROM whose screen *moves*, restored in reverse order (the direction the shuttle actually moves), frame number and every pixel compared. 0/100 mismatches.
6. **The same on a real ROM.** 120 slots of dmg-acid2, every one restored in reverse, plus a forward replay from a restored slot to check that "resume from the previewed point" reproduces the slot after it.

## 11. What is not here yet

Ordered by what a player would notice first.

- **The pixel FIFO.** Rendering is line-based, so a write to SCX, LCDC or a palette *in the middle of a line* takes effect from the next line instead of the next pixel. Costs `ppu/intr_2_mode0_timing_sprites` (the per-object stretch of mode 3 is an approximation of a FIFO that is not there) and every "mealybug" test. Games that use mid-line writes for effects (a few water/wobble effects) will look wrong.
- **LCD-on timing.** Switching the LCD on mid-frame is modelled coarsely: the first frame is discarded and the first line runs mode 0 where mode 2 would be, which is right, but not to the dot. Costs `ppu/lcdon_timing-GS` and `ppu/lcdon_write_timing-GS`.
- **`ppu/stat_lyc_onoff`.** The LY=LYC bit is latched across an LCD off/on, which is most of the test; the remaining sub-case is the exact dot at which the comparison resumes.
- **OAM DMA start-up.** `oam_dma_start` and `oam_dma/reg_read` measure the first M-cycle of a DMA and what `$FF46` reads back during one. The delay is modelled as one flat M-cycle.
- **The OAM corruption bug.** A DMG increments or decrements a 16-bit register pointing into OAM during mode 2 and corrupts a row of it. Not modelled at all (blargg `oam_bug` 2/8). It is a hardware defect games avoid, so nothing depends on it, but the tests are honest about it.
- **The wave channel's access window.** While channel 3 is playing, wave RAM belongs to it and the CPU sees `$FF` except in a two-cycle window after a fetch. That window is modelled; the exact cycle it opens is not (blargg `dmg_sound` 09/10/12, `cgb_sound` 08/09/11/12). Nothing audible depends on it.
- **The APU power-off difference.** Powering the APU down does not clear the length counters here (DMG behaviour). A Color does clear them.
- **MBC1 multicarts.** Told apart from ordinary 8Mb MBC1 cartridges by a heuristic on the ROM contents, which is not implemented (`mbc1/multicart_rom_8Mb`).
- **Boards.** MBC6, MBC7 (accelerometer), MMM01, HuC3, the Pocket Camera, TAMA5. Each answers `{ ok: false }` with its name rather than crashing.
- **Serial.** Nothing is plugged in: an outgoing byte goes nowhere, `$FF` comes back, and the interrupt fires on schedule. That is enough for blargg's suites (which print through it) and for a game that polls; a link cable is not emulated. `serial/boot_sclk_align-dmgABCmgb` measures the phase of the serial clock against the boot ROM's exit and needs a real boot ROM.
- **Super Game Boy.** The border, the palette commands and the SNES side: none of it. Cartridges that support SGB run as plain DMG cartridges, which is what they do in a real Game Boy.
- **Real games.** dmg-acid2 and 103 mooneye ROMs are not a library. **A matrix passing is not evidence that a commercial title runs** — issue #40 made that mistake twice on the Famicom side. No commercial cartridge has been run here, because none may be committed and none was to hand.

## 12. The five failures this branch inherited

The first stage of this work ended with an agent dying mid-run; 3,730 lines were committed with 46 of 51 tests passing. For the record, because "the test was wrong" is a claim that needs evidence:

| Failure | Cause | Fix |
|---|---|---|
| `gbmbc: MBC1 has the bank-0 hole and the mode flag` | **The test.** It built a 512KB cartridge and expected bank `$25` to exist. On a 32-bank ROM the upper bank bits have no address lines to drive, so `$25` selects `$05` — which is what the board did. | Test now builds 1MB (64 banks), the smallest size on which the mode flag is observable. mooneye's whole `mbc1/` group already passed. |
| `gbppu: the STAT interrupt is the rising edge of an OR` | **The test.** It asserted two interrupts in one line with the HBlank and OAM sources both on — which is the four-sources answer the file exists to deny. One wire gives one. | Rewritten to count a whole frame with each source alone and then together: 143, 145, **144**. Strictly stronger, and it now demonstrates the thing its title claims. |
| `machinegb: a frame is the right number of cycles` | **The test.** It measured the *first* `stepFrame()`, which is 144 lines rather than 154 because the machine starts at LY=0. | Warm up one frame, then assert every frame is within one instruction of 17,556 and that 60 of them total 60 × 17,556. |
| `gbapu: state round-trips and the samples continue` | **The test.** It compared the first 64 samples of the whole run against the first 64 after the snapshot. `setState()` drops the undrained ring on purpose (it belongs to the future the restore abandoned), so the machine that never left had to be drained to the same place. | Drain before comparing. |
| `dmg-acid2 also exercises the rewind ring on a real ROM` | **The emulator.** The frame buffer was not in the snapshot, so `restore()` + `render()` returned the last frame the emulator ran. Slots 0 and 7 came back as frame 120. | The picture is state now (§9). The other rewind test was also driving a ROM that draws a uniform screen, so it could not have caught this; it now drives one that scrolls. |
