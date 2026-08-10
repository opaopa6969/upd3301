**English** · [日本語](./nes-design.ja.md)

# Famicom / NES — design

Adding the Famicom (NES) as a *machine* in this emulator, next to PC-8001 and PC-8801. The point is not "another emulator": it is that the host in `demo/machine.html` already implements deterministic fast-forward, rewind and jog-shuttle on top of a `snapshot()` / `restore()` contract that has nothing machine-specific in it. **Satisfy the contract and time travel comes for free.**

Built in stages. **Stage 1** was the cartridge (`ines.js`) and the CPU (`m6502.js`). **Stage 2** was the PPU (`nesppu.js`), the mapper boards (`nesmapper.js`), the machine class (`machinenes.js`) and the host integration. **Stage 3** was the APU (`nesapu.js`), the CPU's mid-instruction interrupt behaviour, and twenty more boards. **Stage 4** — the current state of this document — is the **Famicom Disk System** (`fds.js`) and the 192-disk sweep that it made possible: see [§12](#12-fdsjs--the-famicom-disk-system). What is still missing is listed in [§11](#11-what-is-not-here-yet).

## 1. Contract (suite-contract)

- Pure, dependency-free JavaScript. No DOM, no `three`, **no `Math.random`**.
- Deterministic: same cartridge + same input sequence + same number of steps → **bit-identical state**. This is not a nicety. Rewind works by restoring a snapshot and *replaying the same inputs*, so any nondeterminism does not degrade the picture — it destroys every time-manipulation feature at once.
- Output is plain data + `schemaVersion`.
- Dependencies point one way. `m6502.js` knows nothing about the NES: it takes a bus and executes. `nesppu.js` knows nothing about a CPU. `nesmapper.js` knows nothing about either. `machinenes.js` is the coordinator that closes the loop.
- Tests are `node --test`, headless, and include determinism tests.

## 2. Files

| File | What it is |
|---|---|
| `ines.js` | iNES / NES 2.0 header parsing. PRG-ROM / CHR-ROM extraction, mapper number, mirroring, battery, trainer. Also `buildINes()` so tests can author cartridges without shipping copyrighted ROMs. |
| `m6502.js` | MOS 6502 CPU core (the 2A03 without the sound hardware). All documented opcodes plus the illegal ones games use, cycle-accurate, NMI/IRQ/RESET, `getState()`/`setState()`. |
| `nesppu.js` | RP2C02 picture processing unit. Per-dot raster, loopy v/t/x/w scrolling, cycle-accurate sprite evaluation, sprite 0 hit, sprite overflow (bug included), vblank/NMI timing, palette + emphasis. |
| `nesmapper.js` | The cartridge boards — 26 of them, from NROM to the Konami VRCs. A registry, so adding a board is adding a class and a line. See [§6](#6-nesmapperjs--the-boards). |
| `nesapu.js` | The RP2A03's sound half: two pulses, triangle, noise, DMC, and the frame counter that clocks them all (and interrupts the CPU). Produces a plain `Float32Array`; no DOM, no WebAudio. |
| `fds.js` | The Famicom Disk System: `.fds` image parsing, the drive (`FdsDrive`) and the RAM adapter's wavetable sound channel (`FdsAudio`). Pure and import-free; `nesmapper.js` builds mapper 20 out of it. Also `buildFds()` for tests. See [§12](#12-fdsjs--the-famicom-disk-system). |
| `machinenes.js` | The machine class: `stepFrame()` / `frame` / `snapshot()` / `restore()` / `schemaVersion` / `renderAudio()`, CPU↔PPU↔APU synchronisation, OAM DMA, DMC DMA, controllers, and the disk-side API (`hasDisk` / `diskSides` / `setDiskSide()`). |
| `test-ines.mjs`, `test-6502.mjs`, `test-nes.mjs`, `test-nesapu.mjs`, `test-fds.mjs` | Unit tests + determinism tests. |
| `nestools/nestest.mjs` | Verification against the nestest reference log (bring your own ROM). |
| `nestools/blargg.mjs` | Runs blargg's test ROMs headless and reports pass/fail (bring your own ROMs). |
| `nestools/screenshot.mjs` | Runs any `.nes` headless and reports what came out — colour counts plus an ASCII thumbnail. |
| `nestools/fdsrun.mjs` | The same for a `.fds` disk, plus what the drive did (how far the head got, how many seeks, how many side changes). |
| `nestools/sweep.mjs` | Runs a whole directory of disks and sorts the results into buckets. [§12.6](#126-the-192-disk-sweep). |

## 3. `ines.js` — the cartridge

A `.nes` file is not a memory image; it is a description of a *board*. The console itself has almost nothing (2KB work RAM, 2KB video RAM). The cartridge supplies program ROM, character ROM, the nametable wiring and usually bank-switching logic. So the header answers "what board is this?", and the parse result is the input to the mapper.

Twenty years of bad tooling left mines in the format, and the parser handles them explicitly rather than pretending they do not exist:

- **Dirty headers.** 90s rippers wrote their handle into bytes 12..15. Trusting byte 7's mapper nibble on those produces nonsense like "mapper $40". Printable ASCII in the tail is the tell; when we see it we discard the high mapper bits and record a warning.
- **NES 2.0 exponent sizes.** A size nibble of `$F` switches the low byte to "2^E × (2·MM+1) bytes", which is how oversized homebrew fits in an 8-bit field.
- **Truncated files.** Common with bad downloads. We keep the *declared* size (that is what the mapper wires up), zero-fill the missing tail, and warn — a short PRG handed back silently would read as garbage code.

### Error policy

`parseINes(bytes)` throws an `INesError` carrying a **code** (`too-short`, `bad-magic`, `no-prg`, `truncated-trainer`) and a message written for a human. But a file picker meets junk as a matter of course, so the host-facing entry point is `tryParseINes(bytes)`, which returns `{ ok: false, code, error }` instead of throwing. Survivable damage never throws: it lands in `cart.warnings` so the host can show *why* a game misbehaves.

`nesmapper.js` follows the same rule one level up: `tryCreateMapper(cart)` answers `{ ok: false, code: 'unsupported-mapper', mapper, error }` for a board nobody has written yet, because a ROM library is full of them and the host wants to name the board rather than throw.

**The parsed cartridge is immutable.** The machine holds a reference and never copies it into a snapshot; see §9.

## 4. `m6502.js` — the CPU

The companion to `z80.js`: same shape (inject a bus, call `step()`, get cycles back, snapshot the register file). The interesting difference is that on the NES **timing is semantic**. The video chip runs at exactly 3× the CPU clock and games change scroll registers mid-scanline, so a one-cycle error is a visible glitch, not a rounding error.

### No cycle table — cycles fall out of the bus accesses

This core has **no per-opcode cycle table**. Every bus access costs one cycle, exactly as on the real chip, and the internal cycles are spent where the chip spends them:

- **Indexed reads** (`abs,X` / `abs,Y` / `(zp),Y`) read the *wrong* address first when the index carries into a new page, then re-read the right one. That is the famous "+1 on page cross", and the bogus read is real hardware behaviour: it is why reading `$2007` through `abs,X` can advance the PPU address twice, and why MMC3's scanline counter can be clocked by a read the programmer never intended.
- **Read-modify-write** instructions write the **old** value back before the new one. Games use that doubled write on purpose — an RMW on a mapper or APU register hits it twice in two cycles.
- **Indexed writes** always pay the dummy read, page cross or not.
- **Branches** cost 2 / 3 / 4 (not taken / taken / taken across a page boundary).

Get the access pattern right and the cycle counts are automatically right. That is what makes nestest line up to the cycle — **and it is what makes stage 2's CPU↔PPU synchronisation a single line of code** (§7).

### Interrupts

- **NMI is edge-triggered.** The PPU pulls the line low at the start of vblank and holds it, so a level check would fire an NMI every instruction until the handler read `$2002`. Use `setNmi(level)` to model the line; `nmi()` to fire one edge.
- **IRQ is level-triggered** and wire-ORed between sources (APU frame counter, DMC, mapper). `setIrqSource(bit, level)` keeps sources independent so one releasing does not clear another's request.
- **The I flag written by `SEI` / `CLI` / `PLP` takes effect one instruction late**, because the interrupt logic samples it a cycle before the flag update lands. `CLI; <one instruction>; <IRQ>` is a real pattern in game code. `RTI` is the exception: it pulls P early enough to matter immediately.
- The `B` flag is not a real flip-flop. It exists only in the byte pushed on the stack, which is how a handler distinguishes `BRK` from an IRQ. We keep it clear in `p` and OR it in when pushing.
- **Interrupts are decided at instruction boundaries, but the lines are watched every cycle.** The chip samples IRQ/NMI once per cycle, and three consequences of that are directly measurable — so the core keeps a one-cycle history (`_endCycle()`, called from every bus access) instead of threading a poll point through every addressing mode:

  - **Vector hijacking.** `BRK`, `IRQ` and `NMI` run the *same* seven-cycle sequence; only the two vector fetches at the end differ, and the chip does not choose the vector until it is about to fetch it. So an NMI that arrives while a `BRK` or an IRQ is already pushing state ends up with a `BRK`-shaped stack frame and the NMI handler's address. Decided after the status push, which is a five-cycle window — one cycle either way and blargg's `2-nmi_and_brk` counts four or six hijacks instead of five.
  - **A taken non-page-crossing branch ignores an IRQ during its last clock.** The poll is at the second-to-last cycle, so an IRQ that asserts inside the final cycle slips a whole instruction. A page cross adds a cycle and therefore another poll, which is why the quirk is specific to branches that stay inside a page (`5-branch_delays_irq`).
  - **A DMA halt is invisible to the interrupt logic.** While a DMA controller holds RDY low — OAM DMA's 513 cycles, a DMC sample fetch's 4 — the processor neither executes nor polls, so a line that asserts inside the halt is not seen at the boundary that ends it. The machine announces the halt with `cpu.stallForDma()`; without it an IRQ raised during sprite DMA is taken one instruction too early (`4-irq_and_dma`).
  - **An interrupt sequence does not poll for interrupts itself**, so at least one instruction of the handler always runs before the next interrupt is taken.

  With these, blargg's `cpu_interrupts_v2` passes 5/5.

### Illegal opcodes

All 256 opcode patterns are decoded; none falls through to a default. Publishers used the undocumented ones for speed (`LAX` is "LDA+LDX in one"), so a core that traps illegals fails on real cartridges.

- **Stable and exact**: `LAX`, `SAX`, `DCP`, `ISC`, `SLO`, `RLA`, `SRE`, `RRA`, `ANC`, `ALR/ASR`, `ARR`, `SBX/AXS`, the illegal `SBC` (`$EB`), and the multi-byte `NOP`s (which must burn the right number of cycles because assemblers emitted them as padding).
- **Approximated**: the unstable opcodes. `ANE/XAA` (`$8B`) and `LXA` (`$AB`) AND in a "magic" constant whose value depends on the chip, its temperature and what was last on the bus; we use `$EE`, the value most emulators settle on. The `&(H+1)` stores — `SHA`/`SHX`/`SHY`/`TAS` — write `value & (high byte of the base address + 1)`. No known commercial game depends on either behaviour. (blargg's `instr_test-v5` agrees: 15 of its 16 ROMs pass, and the one failure is exactly `$AB`.)
- **`JAM`/`KIL`** stops the chip until RESET. Modelled as `cpu.jammed = true` rather than an exception: a crashed game is a legitimate thing to observe in a debugger. The machine keeps ticking the PPU by hand while jammed, so a crashed ROM does not hang the host inside `stepFrame()`.

Decimal mode is implemented but **off by default**, because the 2A03 has the BCD adder disabled in silicon. `new M6502(bus, { decimal: true })` gives a plain NMOS 6502.

## 5. `nesppu.js` — the picture processing unit

The PPU is **not a frame buffer**. It is a machine that walks a fixed raster — 341 dots × 262 scanlines, three dots per CPU cycle — fetching tiles just ahead of the beam. Everything that looks like a "trick" on this console is a game exploiting *where the beam is*: split-screen status bars, parallax scrolls, mid-frame palette changes. So this core is ticked **per dot**, and the machine ticks it from inside the CPU's bus accesses (§7). Register writes then land on their real dot with no catch-up logic anywhere.

### Scrolling is two address registers, not an X and a Y

The single most important modelling decision, and the one the issue calls out: the PPU has no "scroll X" and "scroll Y". It has

- **`v`** — the 15-bit current VRAM address (and the address `$2007` reads and writes),
- **`t`** — the 15-bit "temporary" address that `v` is reloaded from at the start of each line/frame,
- **`x`** — 3 bits of fine horizontal scroll,
- **`w`** — the write toggle shared by `$2005` and `$2006`.

`$2005` and `$2006` write into overlapping bit fields of the *same* `t`. Model those four (loopy's names, deliberately, so the code and the register-level documentation stay readable together) and scrolling comes out correct — including everything that looks like a bug: the mid-frame `$2006` write that moves the screen, the `$2005`/`$2006` sequence every scrolling game performs in its NMI handler, the coarse-Y wrap at 29 that makes the attribute table render as tiles when a game sets it to 30. Model "scrollX / scrollY" instead and you spend forever special-casing games.

`v` is incremented by the same three primitives the hardware uses: coarse-X increment every 8 dots (wrapping into the horizontal nametable bit), fine/coarse-Y increment at dot 256, and the horizontal (dot 257) and vertical (dots 280-304 of the pre-render line) copies from `t`.

### Background

The standard fetch pipeline: nametable byte, attribute byte, pattern low, pattern high, two dots each, feeding 16-bit shift registers that the fine-X selects a bit out of. Attribute bits are 2 per *tile* but must line up with 8 pixels, so they are smeared into their own shift registers as `$00` or `$FF`.

### Sprites — evaluation is a cycle-accurate state machine

Naïve "collect the sprites for this line" code passes the basic tests and fails the interesting ones, because **sprite overflow is a hardware bug and games rely on the bug**. The real chip evaluates OAM across dots 65-256 with a small state machine, and once it has found eight sprites it keeps scanning with `n` *and* `m` both incrementing — so it starts reading Y coordinates out of the wrong byte of the next sprite. The flag therefore fires on lines with fewer than nine sprites and misses lines with more. Games that use `$2002` bit 5 as a raster timer were written against that behaviour, so reproducing it is not pedantry: a "corrected" version breaks them. This core implements the state machine, including:

- secondary OAM cleared on the even dots of 1-64 (and `$2004` reading back `$FF` during that window),
- evaluation starting at **`OAMADDR`**, not at 0, so a game that leaves it non-zero gets its sprite list rotated,
- `OAMADDR` forced to 0 during dots 257-320,
- the `n`/`m` double-increment bug,
- the three extra reads after an overflow is detected.

Sprite fetches occupy dots 257-320, eight groups of eight dots. Unused slots still fetch tile `$FF` — a dummy fetch nobody sees, except MMC3, which is watching the address bus (§6).

Sprite 0 hit is set when an opaque sprite-0 pixel meets an opaque background pixel, honouring both left-edge clip bits and the hardware's refusal to set it at x=255.

### VBlank, NMI, and the `$2002` race

The vblank flag is set at (241, 1) and cleared, together with sprite 0 hit and sprite overflow, at (261, 1). `nmiLine()` reports the NMI wire as a *level* (`vblank flag AND $2000 bit 7`), which the machine feeds to the CPU's own edge detector — that is what makes "enable NMI while the flag is already set" fire immediately, with no special case.

Reading `$2002` clears the flag **and** the NMI condition. A read landing on the exact dot the flag is set therefore makes the NMI never happen that frame, and a read one dot earlier suppresses the flag itself. Games poll `$2002` in tight loops, so this is not a corner case: it is the difference between a game running and a game freezing every few minutes. Both halves fall out of the model (the suppression flag for the early read; the ordinary clear for the late one) rather than being special-cased.

The odd-frame short line — dot 340 of the pre-render line skipped every other frame when rendering is on — is latched at dot **339**, not 340, because a game that switches the background on during the pre-render line finds the decision already made.

### Output

`frameBuf` is `Uint8Array(256×240)` of NES palette indices (0-63, greyscale already applied) and `frameEmph` the emphasis bits in force when each pixel was drawn. No DOM, no RGB decisions — exactly the split `machine88.js` uses, where the machine turns palette indices into pixels. `buildNesPaletteRgb()` produces the 64 × 8 × RGB lookup table, with emphasis modelled the standard way (a set bit attenuates the *other* two channels by 0.746, so all three set dims the whole picture — which is what games use it for).

## 6. `nesmapper.js` — the boards

A registry, not a switch statement buried in the machine: `createMapper(cart)` looks the number up and the machine never learns a mapper number.

| # | Board | What it does |
|---|---|---|
| 0 | NROM | No banking. 16KB PRG appears twice, which is why the reset vector works on both sizes. |
| 1 | MMC1 | A 5-bit **serial** shift register (the board had no spare pins), four internal registers, PRG/CHR modes, mirroring select. |
| 2 | UxROM | One switchable 16KB window at `$8000`, last bank nailed at `$C000`. |
| 3 | CNROM | PRG fixed, the whole 8KB of CHR swaps. |
| 4 | MMC3 | Two 8KB PRG windows + six CHR windows, **and a scanline counter that interrupts the CPU**. |
| 7 | AxROM | 32KB PRG bank + single-screen mirroring select. |
| 9 | MMC2 | Punch-Out!!. CHR banks switched **by watching what the PPU fetches** (see below). |
| 10 | MMC4 | MMC2 with a 16KB PRG window and a range-matching latch (Fire Emblem, Famicom Wars). |
| 11 | Color Dreams | One byte: 32KB PRG in the low bits, 8KB CHR in the high ones. |
| 21/22/23/25 | VRC2 / VRC4 | Konami. Banking, mirroring, and an IRQ timer with a *fractional* scanline prescaler. |
| 24/26 | VRC6 | Akumajou Densetsu. Banking + the same IRQ timer. **Expansion audio not implemented** — the sound registers are accepted and ignored. |
| 34 | BNROM / NINA-001 | Two unrelated boards on one number, told apart by whether the cartridge has CHR-ROM. |
| 66 | GxROM / MHROM | 32KB PRG + 8KB CHR from one byte. |
| 69 | Sunsoft FME-7 | Command/parameter register pair, a `$6000` window that can be ROM or RAM, and a CPU-clocked 16-bit **down** counter (Gimmick!, Batman RotJ). The 5B's YM2149 audio is **not implemented**. |
| 71 | Camerica BF909x | UxROM's layout with the register at `$C000`, plus Fire Hawk's single-screen bit. |
| 73 | VRC3 | Salamander. A 16-bit IRQ counter instead of the family's 8-bit one. |
| 75 | VRC1 | Ganbare Goemon. The CHR banks' top bits live in the mirroring register. |
| 79 | NINA-003/006 | The register is at `$4100`-`$5FFF`, below the usual cartridge window. |
| 87 | Jaleco CHR | One register in the work-RAM window, with its two bits swapped by a wiring accident. |
| 180 | UNROM 180 | Crazy Climber: the *fixed* bank is the first one and `$C000` switches. |
| 206 | Namcot 108 / DxROM | MMC3's ancestor: same register pair, no IRQ, no mirroring control, narrower bank fields. |
| 232 | Camerica Quattro | Four games in one: a block register and a bank-within-block register. |

Together these cover roughly 90% of the licensed NTSC/JP library by title count. The biggest remaining gaps are **MMC5 (5)** and **Namco 163 (19)**; see §11.

**VRC2/VRC4 is one chip with four iNES numbers.** Konami wired the two low register-select lines differently on each board revision, and the `.nes` format has no room to say which — so the register index arrives on `A0`/`A1`, or those two crossed, or `A2`/`A3`, or `A6`/`A7`. The resolution used here is the standard one: OR the candidate line pairs together. A game only ever drives the pair its own board uses, so the others read as zero and the union is unambiguous in practice.

**The VRC IRQ timer has a fractional prescaler.** In scanline mode the counter is clocked once per 341 PPU dots — 113 and two thirds CPU cycles — which the hardware achieves by subtracting 3 from a 341-step counter every cycle. The fraction is the point: a whole number of cycles per scanline drifts visibly across a frame, and Konami's raster splits do not drift.

**MMC2/MMC4 switch CHR banks with no CPU involvement at all.** Each 4KB window has two banks and a latch that flips when the PPU reads a tile numbered `$FD` or `$FE`. Punch-Out!! puts the opponent's face in those tiles, so the sprite is drawn from one bank at the top and another at the bottom. MMC2 latches on the exact address (`$0FD8`), MMC4 on the whole `$0FD8`-`$0FDF` range, because it latches a PPU cycle later.

Two details that decide whether real games boot:

**MMC1 ignores the second of two writes on consecutive CPU cycles.** The chip needs a cycle to settle. That is not trivia: a read-modify-write instruction (`INC $8000`) writes the old value and then the new one on back-to-back cycles, and games do it *on purpose* to shift one bit with a single instruction. Emulating both writes desynchronises the shift register and the game boots to garbage. The machine therefore passes the CPU cycle count into `cpuWrite`.

**MMC3's IRQ counter is not a timer — it watches PPU address line A12.** With the background tiles at `$0000` and the sprite tiles at `$1000`, A12 is low through the background fetches of a scanline and rises when the sprite fetches begin. One rise per scanline, for free, with no wire to the CPU. The catch is that A12 wobbles during ordinary fetches too, so the board filters it: a rise only counts if A12 has been low for a while first (~3 CPU cycles ≈ 8-9 dots). Without the filter the counter runs several times too fast and status bars land in the wrong place.

Two consequences for the rest of the code: the PPU must issue **every** fetch through its address bus, including the garbage nametable fetches during the sprite phase and the two dummy fetches at the end of each line (they are what hold A12 low long enough to arm the filter); and the address the board sees is delivered with **one dot of lag** — the PPU drives an address during a dot and the board only sees it settle on the next. That lag is measurable: `mmc3_test`'s `4-scanline_timing` checks the resulting IRQ position to a single PPU clock, and without it every scanline IRQ lands one dot early. Boards that do not care declare `wantsPpuBus = false` and pay nothing (89,000 calls a frame is worth a scanline counter and not worth NROM).

## 7. `machinenes.js` — the machine, and how the two clocks stay in step

`NesMachine` satisfies the same contract as `Pc8801Machine`: `stepFrame()`, `frame`, `snapshot()`, `restore()`, `schemaVersion`, plus `update(dt, onFrame)` and `render()`.

### One line of synchronisation

m6502.js has no cycle table — **every bus access is exactly one CPU cycle**. So the CPU's own bus *is* a cycle clock, and the whole synchronisation is: tick the PPU three dots at the start of every bus access, then perform the access.

```js
this.cpu = new M6502({
  read:  (a)    => { this._tick3(); return this._read(a); },
  write: (a, v) => { this._tick3(); this._write(a, v); },
});
```

Register writes then land on their real dot, and the dummy reads the 6502 performs (page-cross, read-modify-write) advance the PPU exactly as they do on hardware. No catch-up logic, no "run N cycles then N×3 dots" approximation.

### Where the interrupt lines are sampled

A CPU cycle is three dots, but the interrupt lines are not sampled at either end of it — they are sampled *inside*. m6502.js polls at instruction boundaries, so the level handed to it during cycle N is what the poll after cycle N sees, and the dot at which that level was sampled is directly measurable:

- **NMI** is sampled after the **first** of the cycle's three dots. blargg's `05-nmi_timing` prints which instruction the NMI landed after, running one PPU clock later each line; sampling at the start of the cycle is one dot late, sampling at the end is two dots early, and only the middle position passes. `06-suppression`, `07-nmi_on_timing` and `08-nmi_off_timing` agree.
- **IRQ** (mapper + APU frame counter, wire-ORed through `setIrqSource`) is sampled after the **second**. `mmc3_test`'s `4-scanline_timing` is what pins that down.

### OAM DMA

`$4014` copies 256 bytes into OAM with the CPU halted: 513 cycles, 514 when it starts on an odd cycle. Those cycles are real — the PPU keeps drawing through them, which is why a game that starts its DMA too late gets a torn sprite list — so the machine adds them to `cpu.cycles` by hand and ticks the PPU for each.

### Controllers

`$4016`/`$4017` are a parallel-in serial-out shift register: strobe high reloads continuously, strobe low then clocks eight bits out. `machine.pads` is one byte of live button state per port (`BUTTON.A`=0 … `BUTTON.RIGHT`=7) — the host writes it, the machine shifts it.

### DMC DMA

The DMC is the only sound channel that touches the CPU bus, and when it wants a sample byte it **stops the processor** for four cycles. Those cycles are stolen, not shared: an instruction in progress is suspended between its own cycles. The APU cannot fetch the byte itself — the bus belongs to the machine — so `nesapu.js` only raises `dmc.needByte` and `machinenes._dmcDma()` spends the cycles and calls `dmc.fill()`, exactly the way OAM DMA already worked. Both announce themselves to the CPU with `cpu.stallForDma()` so the interrupt logic knows it was asleep (§4).

A frame is a fixed number of PPU dots, so a DMA does not make the frame *longer* — it makes the CPU get less done inside it. That is the visible effect in a game: a raster split timed by counting instructions wobbles while a sample is playing.

## 7a. `nesapu.js` — the sound

Two pulses, a triangle, a noise channel, a DPCM player, and the frame counter that clocks them all.

**It is clocked from the CPU, not pulled like the OPN.** `ym2203.js` advances its oscillators when `render()` asks for samples, because an FM chip is an independent clock domain. The 2A03 is not that chip — it *is* the CPU, same die, same clock — and three of the things games depend on are CPU-cycle events rather than audio events: the frame counter's IRQ (used as a general-purpose timer), `$4015`'s length-counter bits (polled by music drivers), and the DMC's DMA. So `tick()` runs once per CPU cycle from `_tick3()`, and the audio falls out of it: a box filter accumulates ~37 CPU cycles into one 48 kHz sample and pushes it into a ring that `render()` drains. **Sound is an output of the simulation, not a driver of it** — which is also what keeps rewind exact.

The frame counter, in CPU cycles after the divider reload:

| Cycle | 4-step | 5-step |
|---|---|---|
| 7457 | quarter | quarter |
| 14913 | quarter + half | quarter + half |
| 22371 | quarter | quarter |
| 29828 / 29829 / 29830 | **IRQ flag set on all three**, quarter+half on 29829, wrap on 29830 | quarter on 29829 |
| 37281 / 37282 | — | quarter + half, wrap |

Three details that are not decoration:

- **The IRQ flag is raised on three consecutive cycles**, not one. A driver polling with back-to-back `bit $4015` can catch it on any of them, and a one-cycle model puts blargg's `6-irq_flag_timing` and `5-branch_delays_irq` two cycles out.
- **A `$4017` write takes effect 3 or 4 CPU cycles later** — 3 if it landed on an APU cycle, 4 if between — which is what keeps the restarted sequence aligned to the APU's own clock grid regardless of when the CPU wrote. Applying it immediately shifts every subsequent frame IRQ.
- **The cycle the divider is reloaded on is cycle 0 of the new sequence.** Off by one here and every quarter/half frame and the IRQ land a cycle early; `apu_test`'s `5-len_timing` and `6-irq_flag_timing` both say "too soon".

**Reset is not power-on.** RESET clears `$4015` and re-triggers the frame counter, but the registers keep their values — and specifically, the *last value written to `$4017`* is written again, so a driver that had chosen 5-step mode still has it. An emulator that treats reset as power-on restarts the music in the wrong mode (`apu_reset/4017_written`).

**Mixing** uses the documented non-linear DAC curves, precomputed into two tables. Summing the channels linearly makes chords too loud — audibly wrong, not subtly. The output then goes through the console's own analog stage: two high-pass poles (90 Hz, 440 Hz) and a 14 kHz low-pass. Modelling the *board* rather than the chip is the same choice `machine88.js` makes for the OPN's resistor mixer.

**`renderAudio(out, n)`** has the same signature as `machine88.renderAudio()`, so the host's audio pump does not care which machine it is talking to. Unlike the OPN it only *drains* — the samples were produced while the CPU ran. On underrun the last sample is held: the emulation cannot be asked for more audio without also advancing time, and a click is the only alternative.

## 8. Host integration (`demo/machine.html`)

The host now picks machines by **capability**, not by class. It used to ask `machine instanceof Pc8801Machine` in a dozen places, which meant every new machine had to be taught to the host one `instanceof` at a time. The generalisation:

- `hasOwnRender(m)` / `renderMachine(extra)` — a machine that renders itself gets the options (and ignores the ones that mean nothing to it); the PC-8001 renders through its text system. One call site instead of three ternaries.
- `crtcOf(m)` — the CRTC if the machine has one, `null` otherwise. The status line degrades instead of throwing.
- `typeof m.insertDisk === 'function'` for the floppy pool, `typeof m.renderAudio === 'function'` for the per-frame audio hook, `m.effectiveCpuPct !== undefined` for the CPU-speed readout.

Everything else — the snapshot ring, the rewind button, the jog-shuttle, the speed multiplier — was already machine-agnostic and needed **no change at all**. That was the bet the issue made, and it held.

What is new for the Famicom specifically: a `ファミコン` boot-mode button, a `.nes` file input (which reports a bad header or an unimplemented board on screen instead of failing silently), a **Disk System group** (`.fds` + `disksys.rom` + a side selector, §12.7), and a keyboard→pad map (arrows, Z/X = B/A, Enter = START, Shift/Space = SELECT) that also translates the existing gamepad configuration's joystick bits, so the pad-config panel keeps working for both families.

One thing stage 4 had to fix rather than add: **the Famicom file pickers were invisible.** They live in `row-sys1`, which the folded menu bar hides, and nothing listed them in the 📁 ファイル menu — the same way 📼テープ was orphaned when the bar took over the rows. `fnes` and the new `grp-fds` are listed now.

The CRT pipeline consumes a GRB index (0-7) per dot plus an optional per-gun `drive` level. The Famicom's `render({ indexed: true, analog: true })` supplies both: the index is a coarse reduction of the 64-colour palette, and `drive` carries the real RGB, so the phosphor sim renders the true palette rather than eight primaries — the same arrangement `machine88.js` uses for its analogue palette.

**Not verified:** the actual on-screen result in a browser. Everything above is verified headless (frame buffers, snapshot/restore, the transport loop reproduced in `test-nes.mjs`); the pixels reaching a real canvas through the phosphor/tube simulation are **visually unverified**.

## 9. Snapshot policy (this is what rewind is made of)

`demo/machine.html` keeps up to 1000 snapshots in a ring buffer and auto-tunes the interval to stay around 150MB. **A big snapshot means a short rewind window**, so:

- **Immutable data never goes in a snapshot.** PRG-ROM and CHR-ROM are held by reference from the loaded cartridge and restored by reference. (Same rule `machine88.js` applies to mounted D88 images, documented there rather than hidden.)
- ~~**The frame buffers are output, not state.** 120KB per snapshot for something the next frame regenerates would cut the rewind window by an order of magnitude.~~ **Wrong, corrected 2026-08-11.** Nothing steps a frame before showing the picture: `demo/machine.html`'s `restoreIdx()` restores and draws, so a snapshot with no picture in it hands back the frame that was on screen when the user started scrubbing — every slot of a 120-frame rewind ring showing frame 120. Found on the Game Boy, present here for the same reason and in the same words. The size objection is answered by **packing**: the palette index is six bits, so 61,440 pixels are **46,080 bytes**, and the emphasis plane is constant for a whole frame in anything that is not doing a mid-screen `$2001` write, so it goes in as runs (4 bytes, typically). See [docs/machine-contract.md](./machine-contract.md) §2.6.
- **Work RAM that has never been written is not copied.** iNES 1.0 declares 8KB of PRG-RAM for practically every cartridge whether the board has it or not; the mapper tracks whether anything ever wrote and stores `null` if not (restore fills with zero, which is what "never written" means).
- Everything is plain data: numbers, booleans, typed arrays. No class reconstruction, so `restore()` writes into *existing* objects and views/aliases stay alive.

- **The APU's sample ring is output too, and is not in the snapshot.** The chip's *state* — dividers, sequencers, envelopes, the DMC's shift register — is, and so are the resampler's phase and filter memory, which is what makes the *sequence of samples* after a restore identical to the original run. Only the handful of samples that had not been drained yet are lost: one audio buffer at the moment you rewind, and nothing after it.

- **Writable media travels as a difference, not as a copy.** The Disk System is the only machine here whose media can be written; a snapshot carries the bytes a save changed and nothing else (§12.4).

What actually travels: 2KB work RAM, 2KB CIRAM (4KB on a four-screen board), 256B OAM, 32B secondary OAM, 32B palette, the PPU register/latch/pipeline state, the CPU register file, the mapper registers, CHR-RAM if the board has it, and the controller/APU state. **About 3KB for a plain NROM game, ~11KB for a board with CHR-RAM and dirty work RAM, and 46KB for a Disk System game** (whose 32KB of adapter RAM is always live) — an order of magnitude smaller than a PC-8801 snapshot (RAM + three GVRAM planes + the sub-CPU), so the ring is bounded by its count, not by memory.

Adding the whole APU cost **about 90 numbers, under 800 bytes of JSON** — measurably nothing against the 2KB of work RAM, and the tests assert it stays that way.

## 10. Testing

### Unit tests

`node --test`. `test-6502.mjs` pins flags, addressing modes and **cycle counts** individually. `test-ines.mjs` concentrates on damage: dirty headers, truncation, junk input. `test-nes.mjs` covers the boards (banking modes, MMC1's serial protocol and its consecutive-write rule, MMC3's counter and its A12 filter), the PPU register model (v/t/x/w, palette mirroring, nametable mirroring under a board that changes it, the `$2007` read buffer, frame length and the odd-frame skip), sprite 0 hit and overflow, OAM DMA cycle cost, the controller shift register, and the render output shapes.

### Determinism tests (mandatory)

Four properties, each tested directly:

1. Same cartridge run twice → identical fingerprint.
2. Snapshot → run ahead → restore → replay → identical fingerprint.
3. The same, with **input arriving mid-replay** — exactly what a rewind looks like when the buttons were pressed after the snapshot was taken.
4. The same, with an **MMC3 IRQ firing during the replay** — mapper state lives outside the CPU and the PPU, so it is precisely the kind of thing a snapshot could forget.

Plus a *host contract* test that reproduces `demo/machine.html`'s transport loop headless: `update(dt)` paced by the machine's own refresh, a snapshot ring, a ×4 fast-forward, and a rewind by restore.

### nestest — instruction-by-instruction CPU verification

nestest.nes, entered at `$C000`, runs without a PPU, exercises every documented opcode and every documented illegal one, and a cycle-exact reference log of a real console running it has been published. Matching `PC/A/X/Y/P/SP/CYC` line by line pins down not just the arithmetic but the timing. It is the same method this repo already uses against M88 (`docs/m88-comparison.md`).

**Result: all 8991 log lines match, and nestest's own verdict bytes `$02`/`$03` are `00 00`.**

### blargg's test ROMs

The ROMs are **not in this repository** (do not commit test ROMs). Fetch the collection:

```sh
curl -L -o /tmp/nes-test-roms.zip \
  https://github.com/christopherpow/nes-test-roms/archive/refs/heads/master.zip
unzip -q /tmp/nes-test-roms.zip -d /tmp
```

Then:

```sh
# nestest (CPU), by argument or environment variable
node nestools/nestest.mjs /tmp/nes-test-roms-master/other/nestest.nes /tmp/nes-test-roms-master/other/nestest.log

# blargg suites — they write their verdict to $6000, so pass/fail is headless
NES_TEST_ROMS=/tmp/nes-test-roms-master node nestools/blargg.mjs --suite ppu_vbl_nmi
node nestools/blargg.mjs --suite sprite_hit
node nestools/blargg.mjs --suite sprite_overflow
node nestools/blargg.mjs --suite mmc3
node nestools/blargg.mjs --suite cpu_interrupts
node nestools/blargg.mjs --suite instr_test
node nestools/blargg.mjs /tmp/nes-test-roms-master/apu_test/rom_singles/*.nes
node nestools/blargg.mjs /tmp/nes-test-roms-master/apu_reset/*.nes
node nestools/blargg.mjs /tmp/nes-test-roms-master/apu_mixer/*.nes
node nestools/blargg.mjs /tmp/nes-test-roms-master/blargg_apu_2005.07.30/*.nes
node nestools/blargg.mjs <path-to-rom.nes> --frames 1200 --verbose
```

blargg's 2005 frame-counter suite predates both the `$6000` protocol and the word "passed": it prints a single hex result code where `$01` means everything passed. `nestools/blargg.mjs` recognises that too, so the suite reports results instead of timeouts.

`node --test` skips the nestest case when `NESTEST_ROM`/`NESTEST_LOG` are unset, so the suite still passes without the ROMs.

**Results as of stage 3 — the failures are listed, not hidden:**

| Suite | Result | Notes |
|---|---|---|
| `nestest` | **8991/8991 lines**, verdict `00 00` | CPU, cycle-exact. This is the regression net for every CPU change |
| `cpu_interrupts_v2` | **5/5** | was 1/5 in stage 2 — see §4 |
| `instr_timing` | **2/2** | |
| `instr_misc` | **4/4** | |
| `cpu_timing_test6` | **1/1** | |
| `cpu_dummy_reads` / `cpu_dummy_writes` | **3/3** | |
| `cpu_exec_space` | **1/2** | `test_cpu_exec_space_apu` needs a decaying open-bus latch — see §11 |
| `instr_test-v5` | **15/16** | the failure is `$AB` (LXA/ATX), an unstable illegal opcode — see §4 |
| `apu_test` | **8/8** | length counters, the frame IRQ and its timing, DMC basics, all 16 DMC rates |
| `apu_mixer` | **4/4** | the non-linear DAC curves |
| `apu_reset` | **5/6** | `4017_written` subtest 3 — see below |
| `blargg_apu_2005.07.30` | **9/11** | `10.len_halt_timing` and `11.len_reload_timing` — see below |
| `ppu_vbl_nmi` | **9/10** | `10-even_odd_timing` fails at subtest 3 |
| `vbl_nmi_timing` | **7/7** | |
| `sprite_hit_tests` | **11/11** | |
| `sprite_overflow_tests` | **5/5** | including the overflow bug |
| `oam_read` | **1/1** | |
| `mmc3_test` | **4/6** | see below |
| `dmc_tests` | **0/4** | not judgeable headless — see below |

Failure details:

- **`apu_reset` 4017_written subtest 3.** The `$4017` mode *is* preserved across reset (that is what the subtest is named for) and `4017_timing` reports the documented 9-cycle gap between the effective write and the first instruction, but the length-counter position this subtest measures two frame-periods later is still off by a cycle or two.
- **`blargg_apu_2005` 10.len_halt_timing / 11.len_reload_timing.** Both measure what happens when a register write lands on *exactly* the cycle the length counters are clocked ("changes to halt occur after clocking"; "a reload during the clock is ignored unless the counter is zero"). This model ticks the APU immediately before the CPU's access completes, so "the same cycle" is off by one against hardware, and implementing the reload rule against our pairing made `11` fail an *earlier* subtest. The hook (`lenClockedThisCycle`) is left in `nesapu.js`, visible and unused, rather than half applied. The nine tests before these two — including both length-timing modes, clock jitter, IRQ timing and reset timing — pass.
- **`dmc_tests`** (4 ROMs) draw nothing and never write `$6000`; they report by ear. No verdict is available headless, so they are counted as failures rather than quietly skipped.
- **`cpu_exec_space` test_cpu_exec_space_apu.** Executing code out of `$4000`-`$401F` reads back open bus, and the latch here does not decay (§11).

- **`ppu_vbl_nmi` 10-even_odd_timing.** Subtests 2, 4 and 5 pass; subtest 3 ("clock is skipped too late, relative to enabling BG") is off by one PPU clock. The odd-frame skip decision is latched at dot 339, which is correct for three of the four probes; the fourth needs the enabling write to be visible half a dot earlier than a tick-then-access bus model can express.
- **`mmc3_test` 4-scanline_timing.** Subtests 2-11 pass (both `$2000=$08` and `$2000=$10`, scanlines 0 and 1); subtest 12 (scanline 239, `$2000=$10`) is one PPU clock early.
- **`mmc3_test` 6-MMC6.** This one is **unfixable alongside 5-MMC3**: the two ROMs test *mutually exclusive* chip revisions ("IRQ should be set when the counter is 0 after reloading" vs "IRQ shouldn't occur when reloading after the counter normally reaches 0"). blargg's own readme says both markings exist as MMC3B. We implement the revision `5-MMC3` tests, which is the more common one.
- **`cpu_interrupts_v2`.** `1-cli_latency` passes. `2-nmi_and_brk`, `3-nmi_and_irq` and `5-branch_delays_irq` need the CPU to poll interrupts *mid-instruction* (the "interrupt hijacking" cases); `4-irq_and_dma` needs the DMC's cycle stealing. Both are stage-3 items, listed in §11.

### Real cartridges

`nestools/screenshot.mjs` runs any `.nes` headless and reports colour counts plus an ASCII thumbnail, which is enough to recognise a title screen in a terminal:

```sh
node nestools/screenshot.mjs /path/to/game.nes --frames 240 --art
node nestools/screenshot.mjs /path/to/game.nes --ppm /tmp/frame.ppm
```

Verified this way against homebrew and demo ROMs from the same collection (which may be redistributed, unlike commercial ROMs): `240pee` (UxROM, 64KB PRG, CHR-RAM) draws its menu, logo and text panel; `ny2011` (NROM) draws its scene; `scroll` (MMC1, CHR-RAM), `spritecans`, `tv` and `litewall5` all run and render.

A broader sweep — every `.nes` in the test-ROM collection, 263 of them — parses, builds its board, runs 90 frames and survives a snapshot/restore round trip with no exception and no state divergence. Two mapper numbers in that set are still unimplemented: 5 (MMC5, 4 ROMs) and 28 (Action 53, 2 ROMs).

**No commercial cartridge was available on this machine.** The local library is 192 Famicom *Disk System* images (`.fds`) plus the FDS BIOS — which is why stage 4 built the Disk System. See [§12](#12-fdsjs--the-famicom-disk-system).

## 11. What is not here yet

Stage 4 and beyond, in the order they are worth doing:

- ~~The Famicom Disk System (mapper 20)~~ — **done in stage 4**, see [§12](#12-fdsjs--the-famicom-disk-system). It was the leading item for a practical reason (this machine has no `.nes` cartridges at all and 192 `.fds` disks), and it paid: 189 of the 192 now load off the disk and run.
- **MMC5 (5)** and **Namco 163 (19)** — the two biggest remaining gaps in cartridge coverage. MMC5 is a small computer in its own right (ExRAM, a vertical split-screen unit, an 8x8 multiplier, its own IRQ, two extra pulse channels); N163 needs its wavetable audio to be worth much.
- **Expansion audio.** VRC6, VRC7, Sunsoft 5B and Namco 163 each add channels on the cartridge. Those boards are implemented without them: the sound registers are accepted and ignored, so the games run and play their 2A03 channels. A silent expansion is a better answer than a wrong one, but it is not the right answer. The **FDS channel is implemented** (§12.5) and is the first user of the `nesapu.expansion` hook, which the other four can now plug into.
- **Length-counter write/clock coincidence** — `blargg_apu_2005` 10 and 11, §10.
- **PAL / Dendy timing.** NTSC only. `ines.js` parses the timing field; nothing acts on it.
- **The unstable illegal opcodes** are approximated (§4) — `instr_test-v5`'s `03-immediate` is the visible cost.
- **Open bus decay.** Reads of unmapped addresses return the last value on the bus, but the latch does not decay. The PPU has its own open-bus latch for `$2000`/`$2001`/`$2003`/`$2005`/`$2006`; it does not decay either. `cpu_exec_space`'s APU half is the visible cost.
- **`$2007` during rendering**, and the "render the palette entry `v` points at" quirk that `full_palette.nes` uses, are not modelled.
- **Visual and audible verification in a browser.** Everything is verified headless. The pixels reaching a canvas through the CRT simulation have not been looked at, and **nobody has listened to the APU** — its output is verified as numbers (blargg's suites, the determinism tests, the sample-rate check), not as sound.

## 12. `fds.js` — the Famicom Disk System

Stage 4. This is the part that turns the emulator from something with no games into something with a library, and the reason is arithmetic: this machine has **zero `.nes` cartridges** and **192 `.fds` disk images**.

### 12.1 What the Disk System actually is

Not a cartridge. A **RAM adapter** that plugs into the cartridge slot — 32KB of program RAM at `$6000`-`$DFFF`, 8KB of character RAM, an 8KB BIOS at `$E000`, a general-purpose down-counter that interrupts the CPU, and a wavetable sound channel — plus a drive that reads a Mitsumi **Quick Disk**. iNES calls it "mapper 20" because the file format has nowhere else to put it, but there is no such board: the number names the adapter.

Three consequences run through everything below:

- **The program that boots a game is in the BIOS, not on the disk.** So an `.fds` file alone is not runnable; `disksys.rom` has to be supplied separately (§12.7).
- **`$E000`-`$FFFF` is ROM and `$6000`-`$DFFF` is RAM**, which is the opposite of a cartridge, so `FdsAdapter` overrides the base `Mapper`'s CPU bus entirely.
- **The media can be written.** No other machine in this repository has that, and it is the one thing a snapshot could not previously ignore (§12.4).

### 12.2 The image format, and the layer that is missing from it

A Quick Disk track is one long spiral of bits with no sectors. The data on it is a chain of **blocks**:

```
[ lead-in gap ][1][ block 1: disk header, 56B ][CRC][ gap ][1][ block 2: file count, 2B ][CRC]
[ gap ][1][ block 3: file header, 16B ][CRC][ gap ][1][ block 4: file data, 1+N B ][CRC] ...
```

The `.fds` format keeps **only the block bytes** — 65500 of them per side, with an optional 16-byte header on the front. Gaps, start bits and CRCs are gone. So an emulator has to decide what to do about the missing layer, and this is where the stage-3 plan turned out to be half right:

- **The gaps do not need to come back.** This drive never runs through one (§12.3).
- **The CRC bytes do.** The FDS BIOS reads them through `$4031` exactly like data: after the 56 bytes of the disk header it takes two more transfers. Leave them out and every block after the first starts two bytes early, the BIOS reads `$09` where it expects `$02`, and the load fails at the second block. **This was the first real bug of stage 4, and its symptom — a disk that reads its own header perfectly and then gives up — is worth recognising.**

So `parseFds()` walks the block chain (it does not trust block 2's file count, which disagrees with reality on plenty of real images) and builds a second array per side, the **physical stream**: every block followed by two zero bytes. `exportFds()` is its exact inverse, so a disk a game wrote to can be written back out as an ordinary `.fds`. The CRC *values* are never checked — `$4030` bit 4 never reports an error, because a `.fds` image has no CRCs that could be wrong.

### 12.3 The drive: the head moves when the program moves it

The obvious model is a free-running head: a byte every 149 CPU cycles (the drive reads ~96.4 kbit/s), forever, whether or not anyone is listening. That is what the hardware does. It does not work here, and the reason is the deleted gaps: between two blocks a free-running head has nothing to wait *in*, so while the BIOS is digesting one block the head chews through the next one and the disk desynchronises.

The answer taken here is the one FCEUX has shipped for two decades: **the byte clock is real, the head is not free-running.** A transfer flag (`$4030` bit 1, and its IRQ if `$4025` bit 7 asked for one) arrives 149 cycles after the previous byte and paces the BIOS's transfer loop exactly as hardware does — but the head only steps when the CPU actually moves a byte through it: a read of `$4031` in read mode, a write to `$4024` in write mode. A block boundary can then never be lost.

The cost, stated plainly: a program that timed the drive by counting cycles instead of by watching `$4030` would see a drive that waits for it. No known title does that — the BIOS owns the drive.

Two details that are easy to get wrong and were both wrong here first:

- **`$4031` is a latch.** Reading it with no byte pending returns the previous byte and must **not** step the head. The BIOS reads `$4031` from its vblank-wait NMI handler (`$E1E6`) on *every frame a game spends waiting for the picture*, so a drive that steps on every read walks the disk forward one byte per frame behind the program's back — a desynchronisation with no symptom until, tens of thousands of bytes later, a block starts in the wrong place.
- **`$4025` bit 6 gates the transfer, bit 1 rewinds.** Clearing bit 6 parks the head between blocks (that is how the BIOS reads block-by-block); setting bit 1 sends it back to the start of the side, because the Quick Disk's head physically returns rather than the disk coming round again.

The two IRQ sources on this adapter share one wire but are **acknowledged separately**: reading `$4030` clears the timer, moving a byte clears the drive.

### 12.4 Writing, and how rewind survives it

Games save to disk. That makes the media part of the machine state, and a rewind that did not put the bytes back would let a player rewind past a save and keep it.

The rule from §9 still holds — **immutable data never travels** — so the snapshot carries neither the disk nor a copy of it. It carries the **difference**: a `Map` from `(side, position)` to the byte written. `restore()` undoes the writes that are not in the snapshot (reading the original byte back out of the parsed image, which stays pristine) and applies the ones that are. The cost is proportional to the number of writes, not to the size of the disk, so a rewind ring never memcpys 65500 bytes per side per frame.

Measured, `とびだせ大作戦` after 1500 frames: **47,220 bytes per snapshot** — 32KB adapter RAM + 8KB CHR-RAM + ~6KB of PPU/CPU/APU/mapper state, and **zero** disk bytes. That is 15× a plain NROM cartridge's 3KB, and it still leaves the host's ring bounded by its 1000-snapshot cap rather than by its 150MB budget (1000 × 46KB = 46MB).

**Getting the write path aligned took measuring the real BIOS, and it is the fiddliest thing in this file.** A written block is not the same length as its stream:

- The first byte the BIOS pushes through `$4024` is `$80` — the block's **start mark**, which is a single bit on the physical disk and has no byte in a `.fds` image. It is swallowed, and it must **not** move the head.
- At the other end the BIOS pushes the *first* CRC byte like ordinary data and then raises `$4025` bit 4; the drive emits the **second** on its own. So the head has one slot to cross that no `$4024` write accounts for.

Get either one wrong and the write itself still looks fine — the bytes go somewhere — but everything is displaced by one, the BIOS reads the block back to verify it, the compare fails, and it rewrites forever. **光神話パルテナの鏡 (Kid Icarus) does this on boot**, and it is the reason the write path is now measured rather than guessed: with the head shifted it sat in that retry loop for the whole run, and with both rules in place it reaches its title screen. FCEUX swallows *two* bytes here; on this drive that would shift every rewritten block.

### 12.5 The sound channel

One extra voice, and the strangest one on the console: a 64-step wavetable at 6 bits per step, played at a frequency that a *second* table bends up and down while it plays. That is where the Disk System's characteristic wobble comes from — Zelda's title, Metroid's caves, Kid Icarus.

The modulator is not an LFO. It is a 32-entry table of five-way steps (+1, +2, +4, reset, −4, −2, −1) driving a signed 7-bit counter, and the counter becomes a pitch offset through an integer algorithm with two deliberate asymmetries: the rounding step adds +2 going up but −1 going down, and the fold points are 192 and −64 rather than ±128. Both are reproduced exactly; replacing either with the symmetric "obvious" version makes the vibrato lean sharp.

It reaches the speaker through a new hook in `nesapu.js`: **`apu.expansion`**, an object with an `output` getter, summed in `mix()`. Expansion sound is not part of the 2A03 — it is summed into the console's audio pin — so the owner of the chip clocks it and the APU only reads it. `FdsAdapter` owns the channel and clocks it from its own `cpuCycle()`; `nesapu.js` never learns what a disk is. VRC6, VRC7, Sunsoft 5B and Namco 163 can now plug into the same hook.

**Nobody has heard it.** The algorithm is verified as numbers (`test-fds.mjs` pins the wave pointer rate, the halt behaviour, the asymmetric bend, and that the sample stream survives a snapshot bit-identically) and the mixing constant is an ear-free estimate.

### 12.6 The 192-disk sweep

`nestools/sweep.mjs` — the same move `docs/m88-comparison.md` used on 353 PC-8801 disks and `mdtools/sweep.mjs` used on 66 Mega Drive ROMs: run everything, classify mechanically, then only open what failed.

**There is no oracle.** The PC-8801 sweep could diff against M88; this cannot diff against anything — no reference emulator is installed, and none of these disks has a known-good screenshot here.

What rescues it from being pure pixel-guessing is a second, independent thing to look at: **where the CPU is.** The FDS BIOS owns the vblank wait, so a running game and a dead one both park at `$E1C5` between frames — but a running game leaves it and executes its own code in adapter RAM, and a dead one never does. So after the run the sweep steps the machine 200,000 instructions and counts how many land below `$E000`. "Frozen picture **and** no game code" is a fact about the machine, not an opinion about the image.

The probe is not a substitute for running long enough, though: a title that is *still loading* executes no code of its own either, and looks exactly like one that died. 磁界少年メット・マグ reads as stuck at 2400 frames and is playing at 3600.

```sh
FDS_BIOS=/path/disksys.rom node nestools/sweep.mjs <dir> --frames 3600 --jobs 12
```

| bucket | meaning |
|---|---|
| `reject` | the `.fds` did not parse, or the machine would not build |
| `noload` | the head never got past the first blocks — the BIOS never read the game off the disk |
| `stuck` | no code ran below `$E000` at all — the machine gave up. Reported with the BIOS's error byte `$90`. |
| `black` / `flat` | it loaded and drew one or two colours |
| `static` | a picture that appeared and never changed again |
| `ok` | several colours, still moving |

Three things the *sweep* had to learn, each of which moved the numbers more than any emulation fix did:

1. **Judge the best frame, not the last one.** A disk game spends much of its first minute black — the BIOS load, a publisher logo, a second load. Sampling the final frame answers "what was on screen at second 20", which is not the question. Taking the maximum colour count over the run moved 22 `flat` + 4 `black` into `ok` with no emulator change at all.
2. **Give it enough seconds.** The drive really does move one byte per 149 cycles, so a load takes as long as it took in 1986. At 1200 frames (20s) Castlevania II is still loading; at 2400 it is showing its opening text; 磁界少年メット・マグ needs 3600.
3. **Turn the disk over.** A two-sided game stops dead and asks. The sweep flips the side when the head has been idle *and* the picture frozen for four seconds — both conditions, because a game being played leaves the drive alone for minutes and ejecting the disk under it would break the thing being measured.

**Result over all 192 disks, 3600 frames (one minute) each:**

| verdict | count |
|---|---|
| `ok` — loaded and running | **189** |
| `stuck` | **3** |
| `reject` / `noload` / `black` / `flat` / `static` | 0 |

**189 of 192 (98.4%) load off the disk and run.** Nothing in the library fails to parse, no board is missing, no CPU jams, and no disk fails to load: every failure is the same shape — the game loads completely, then stops.

The three that stop:

| disk | what happens |
|---|---|
| `きね子 - Kinetic Connection - The Monitor Puzzle` | Reads every block on side A correctly (verified against the block table: 12,482 → 12,497 file header, 12,500 → 12,502 data, 12,505 → 12,520 file header, 12,523 → 45,419 data, all byte-exact), then its own driver writes `$2F` and gives up. Ends parked in the BIOS's vblank wait with a short message on screen and 483 of 200,000 instructions outside BIOS ROM. |
| `きね子 … Vol. II` | The same game, the same place. |
| `カリーンの剣` | Same shape: loads, draws a screen, then executes no code of its own (882 / 200,000). |

**What is NOT the cause, in all three:** the disk layer. Every block boundary lines up with `parseFds()`'s block table, no CRC-phase misalignment, no end-of-disk, nothing written. What is left is something the drive presents differently from hardware in a state the other 189 never enter — the most likely candidate being a mid-block pause (clearing `$4025` bit 6 and setting it again inside a block, which this drive resumes exactly and a real drive does not, §12.3).

### 12.7 Getting the BIOS (it is not in this repository, and never will be)

`disksys.rom` is 8192 bytes and copyrighted. On the machine this was developed on it lives inside a BIOS archive, and the trap is worth writing down because stage 3 fell into it: **the `disksys.dat` sitting next to the disk images is not the BIOS.** It is a database — it starts `NEU ;1;0;1;2;…`. The real file is:

```
(EMU)BIOS(…,FDS,…).zip → BIOS/FamicomDiskSystem.zip → disksys.rom
```

Check it before using it: **8192 bytes, MD5 `ca30b50f880eb660a320674ed365ef7a`**. `zip.js` in this repository opens both layers, so the browser needs no external tool.

Then:

```sh
export FDS_BIOS=/path/to/disksys.rom
node nestools/fdsrun.mjs game.fds --frames 3600 --art     # one disk, with a thumbnail
node nestools/sweep.mjs /path/to/disks --frames 3600 --jobs 12
```

In `demo/machine.html` the BIOS is picked once through the `💽 ディスクシステム` group and kept in IndexedDB under the role `fdsbios`; disks are not kept, because disks are what a user swaps. A two-sided disk grows a side selector, and changing it ejects and re-inserts — a silent swap would look to the BIOS like nothing happened.
