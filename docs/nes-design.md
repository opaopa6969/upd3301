**English** · [日本語](./nes-design.ja.md)

# Famicom / NES — design

Adding the Famicom (NES) as a *machine* in this emulator, next to PC-8001 and PC-8801. The point is not "another emulator": it is that the host in `demo/machine.html` already implements deterministic fast-forward, rewind and jog-shuttle on top of a `snapshot()` / `restore()` contract that has nothing machine-specific in it. **Satisfy the contract and time travel comes for free.**

Built in stages. **Stage 1** was the cartridge (`ines.js`) and the CPU (`m6502.js`). **Stage 2** — this document's main body — is the PPU (`nesppu.js`), the mapper boards (`nesmapper.js`), the machine class (`machinenes.js`) and the host integration. **Stage 3** is the APU, more boards, and the remaining gaps listed in [§11](#11-what-is-not-here-yet).

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
| `nesmapper.js` | The cartridge boards: NROM(0), MMC1(1), UxROM(2), CNROM(3), MMC3(4) with its scanline IRQ, AxROM(7). A registry, so adding a board is adding a class and a line. |
| `machinenes.js` | The machine class: `stepFrame()` / `frame` / `snapshot()` / `restore()` / `schemaVersion`, CPU↔PPU synchronisation, OAM DMA, controllers, a timing-only APU stand-in. |
| `test-ines.mjs`, `test-6502.mjs`, `test-nes.mjs` | Unit tests + determinism tests. |
| `nestools/nestest.mjs` | Verification against the nestest reference log (bring your own ROM). |
| `nestools/blargg.mjs` | Runs blargg's test ROMs headless and reports pass/fail (bring your own ROMs). |
| `nestools/screenshot.mjs` | Runs any `.nes` headless and reports what came out — colour counts plus an ASCII thumbnail. |

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
- Interrupts are polled at **instruction boundaries**. The mid-instruction "interrupt hijacking" cases are not modelled (see §11).

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

### The APU that is not here yet

There is no sound. There **is** a small frame-counter + length-counter model, because those two are not sound: the frame counter is an IRQ source games use as a timer, and `$4015`'s length-counter bits are polled by music drivers that hang without them. `nesapu.js` replaces it in stage 3 (see §11).

## 8. Host integration (`demo/machine.html`)

The host now picks machines by **capability**, not by class. It used to ask `machine instanceof Pc8801Machine` in a dozen places, which meant every new machine had to be taught to the host one `instanceof` at a time. The generalisation:

- `hasOwnRender(m)` / `renderMachine(extra)` — a machine that renders itself gets the options (and ignores the ones that mean nothing to it); the PC-8001 renders through its text system. One call site instead of three ternaries.
- `crtcOf(m)` — the CRTC if the machine has one, `null` otherwise. The status line degrades instead of throwing.
- `typeof m.insertDisk === 'function'` for the floppy pool, `typeof m.renderAudio === 'function'` for the per-frame audio hook, `m.effectiveCpuPct !== undefined` for the CPU-speed readout.

Everything else — the snapshot ring, the rewind button, the jog-shuttle, the speed multiplier — was already machine-agnostic and needed **no change at all**. That was the bet the issue made, and it held.

What is new for the Famicom specifically: a `ファミコン` boot-mode button, a `.nes` file input (which reports a bad header or an unimplemented board on screen instead of failing silently), and a keyboard→pad map (arrows, Z/X = B/A, Enter = START, Shift/Space = SELECT) that also translates the existing gamepad configuration's joystick bits, so the pad-config panel keeps working for both families.

The CRT pipeline consumes a GRB index (0-7) per dot plus an optional per-gun `drive` level. The Famicom's `render({ indexed: true, analog: true })` supplies both: the index is a coarse reduction of the 64-colour palette, and `drive` carries the real RGB, so the phosphor sim renders the true palette rather than eight primaries — the same arrangement `machine88.js` uses for its analogue palette.

**Not verified:** the actual on-screen result in a browser. Everything above is verified headless (frame buffers, snapshot/restore, the transport loop reproduced in `test-nes.mjs`); the pixels reaching a real canvas through the phosphor/tube simulation are **visually unverified**.

## 9. Snapshot policy (this is what rewind is made of)

`demo/machine.html` keeps up to 1000 snapshots in a ring buffer and auto-tunes the interval to stay around 150MB. **A big snapshot means a short rewind window**, so:

- **Immutable data never goes in a snapshot.** PRG-ROM and CHR-ROM are held by reference from the loaded cartridge and restored by reference. (Same rule `machine88.js` applies to mounted D88 images, documented there rather than hidden.)
- **The frame buffers are output, not state.** 120KB per snapshot for something the next frame regenerates would cut the rewind window by an order of magnitude.
- **Work RAM that has never been written is not copied.** iNES 1.0 declares 8KB of PRG-RAM for practically every cartridge whether the board has it or not; the mapper tracks whether anything ever wrote and stores `null` if not (restore fills with zero, which is what "never written" means).
- Everything is plain data: numbers, booleans, typed arrays. No class reconstruction, so `restore()` writes into *existing* objects and views/aliases stay alive.

What actually travels: 2KB work RAM, 2KB CIRAM (4KB on a four-screen board), 256B OAM, 32B secondary OAM, 32B palette, the PPU register/latch/pipeline state, the CPU register file, the mapper registers, CHR-RAM if the board has it, and the controller/APU state. **About 3KB for a plain NROM game and ~11KB for a board with CHR-RAM and dirty work RAM** — an order of magnitude smaller than a PC-8801 snapshot (RAM + three GVRAM planes + the sub-CPU), so the ring is bounded by its count, not by memory.

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
node nestools/blargg.mjs <path-to-rom.nes> --frames 1200 --verbose
```

`node --test` skips the nestest case when `NESTEST_ROM`/`NESTEST_LOG` are unset, so the suite still passes without the ROMs.

**Results as of stage 2 — the failures are listed, not hidden:**

| Suite | Result | Notes |
|---|---|---|
| `nestest` | **8991/8991 lines**, verdict `00 00` | CPU, cycle-exact |
| `instr_test-v5` | **15/16** | the failure is `$AB` (LXA/ATX), an unstable illegal opcode — see §4 |
| `ppu_vbl_nmi` | **9/10** | `10-even_odd_timing` fails at subtest 3 |
| `vbl_nmi_timing` | **7/7** | |
| `sprite_hit_tests` | **11/11** | |
| `sprite_overflow_tests` | **5/5** | including the overflow bug |
| `oam_read` | **1/1** | |
| `mmc3_test` | **4/6** | see below |
| `cpu_interrupts_v2` | **1/5** | needs mid-instruction interrupt polling — see §11 |

Failure details:

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

Verified this way against homebrew and demo ROMs from the same collection (which may be redistributed, unlike commercial ROMs): `240pee` (UxROM, 64KB PRG, CHR-RAM) draws its menu, logo and text panel; `ny2011` (NROM) draws its scene; `scroll` (MMC1, CHR-RAM), `spritecans`, `tv` and `litewall5` all run and render. **No commercial cartridge was available on this machine** — the local library is Famicom *Disk System* images (`.fds`), which need mapper 20 and the FDS BIOS and are out of scope for stage 2.

## 11. What is not here yet

Stage 3 and beyond:

- **`nesapu.js`** — two pulses, triangle, noise, DMC. `machinenes.js` currently models only the frame counter and the length counters (timing and `$4015`, no audio). The DMC also steals CPU cycles, which nothing models yet — that is what `cpu_interrupts_v2`'s `4-irq_and_dma` measures.
- **Mid-instruction interrupt polling in `m6502.js`.** Interrupts are polled at instruction boundaries, so delayed-NMI, "interrupt hijacking" (an NMI arriving during a `BRK` sequence) and the branch-instruction IRQ delay are not reproduced. This is what `cpu_interrupts_v2` 2/3/5 measure, and fixing it means threading a poll point through the addressing modes rather than patching individual opcodes.
- **More boards.** The registry takes a class and a line: mappers 9/10 (MMC2/MMC4), 11, 66, 69, 71, 5 (MMC5), 20 (FDS) are the usual next asks. `tryCreateMapper` already reports an unimplemented board by number, so the host can say which one is missing.
- **PAL / Dendy timing.** NTSC only. `ines.js` parses the timing field; nothing acts on it.
- **The unstable illegal opcodes** are approximated (§4) — `instr_test-v5`'s `03-immediate` is the visible cost.
- **Open bus decay.** Reads of unmapped addresses return the last value on the bus, but the latch does not decay. The PPU has its own open-bus latch for `$2000`/`$2001`/`$2003`/`$2005`/`$2006`; it does not decay either.
- **`$2007` during rendering**, and the "render the palette entry `v` points at" quirk that `full_palette.nes` uses, are not modelled.
- **Visual verification in a browser.** Everything is verified headless. The pixels reaching a canvas through the CRT simulation have not been looked at.
