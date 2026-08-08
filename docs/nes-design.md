**English** · [日本語](./nes-design.ja.md)

# Famicom / NES — design (stage 1: cartridge + CPU)

Adding the Famicom (NES) as a *machine* in this emulator, next to PC-8001 and PC-8801. The point is not "another emulator": it is that the host in `demo/machine.html` already implements deterministic fast-forward, rewind and jog-shuttle on top of a `snapshot()` / `restore()` contract that has nothing machine-specific in it. **Satisfy the contract and time travel comes for free.**

This document covers **stage 1 only**: the cartridge format (`ines.js`) and the CPU (`m6502.js`), with their tests. The PPU, APU, mappers and the machine class are **stage 2** (see [What is not here yet](#7-what-is-not-here-yet)).

## 1. Contract (suite-contract)

- Pure, dependency-free JavaScript. No DOM, no `three`, **no `Math.random`**.
- Deterministic: same cartridge + same input sequence + same number of steps → **bit-identical state**. This is not a nicety. Rewind works by restoring a snapshot and *replaying the same inputs*, so any nondeterminism does not degrade the picture — it destroys every time-manipulation feature at once.
- Output is plain data + `schemaVersion`.
- Dependencies point one way. `m6502.js` knows nothing about the NES: it takes a bus and executes. `ines.js` knows nothing about the CPU. The machine class (stage 2) is the coordinator that closes the loop.
- Tests are `node --test`, headless, and include determinism tests.

## 2. Files

| File | What it is |
|---|---|
| `ines.js` | iNES / NES 2.0 header parsing. PRG-ROM / CHR-ROM extraction, mapper number, mirroring, battery, trainer. Also `buildINes()` so tests can author cartridges without shipping copyrighted ROMs. |
| `m6502.js` | MOS 6502 CPU core (the 2A03 without the sound hardware). All documented opcodes plus the illegal ones games use, cycle-accurate, NMI/IRQ/RESET, `getState()`/`setState()`. |
| `test-ines.mjs`, `test-6502.mjs` | Unit tests + determinism tests. |
| `nestools/nestest.mjs` | Verification against the nestest reference log (bring your own ROM). |

## 3. `ines.js` — the cartridge

A `.nes` file is not a memory image; it is a description of a *board*. The console itself has almost nothing (2KB work RAM, 2KB video RAM). The cartridge supplies program ROM, character ROM, the nametable wiring and usually bank-switching logic. So the header answers "what board is this?", and the parse result is the input to the mapper (stage 2).

Twenty years of bad tooling left mines in the format, and the parser handles them explicitly rather than pretending they do not exist:

- **Dirty headers.** 90s rippers wrote their handle into bytes 12..15. Trusting byte 7's mapper nibble on those produces nonsense like "mapper $40". Printable ASCII in the tail is the tell; when we see it we discard the high mapper bits and record a warning.
- **NES 2.0 exponent sizes.** A size nibble of `$F` switches the low byte to "2^E × (2·MM+1) bytes", which is how oversized homebrew fits in an 8-bit field.
- **Truncated files.** Common with bad downloads. We keep the *declared* size (that is what the mapper wires up), zero-fill the missing tail, and warn — a short PRG handed back silently would read as garbage code.

### Error policy

`parseINes(bytes)` throws an `INesError` carrying a **code** (`too-short`, `bad-magic`, `no-prg`, `truncated-trainer`) and a message written for a human. But a file picker meets junk as a matter of course, so the host-facing entry point is `tryParseINes(bytes)`, which returns `{ ok: false, code, error }` instead of throwing. Survivable damage never throws: it lands in `cart.warnings` so the host can show *why* a game misbehaves.

`summarizeINes(cart)` returns plain data (no typed arrays) for display, including `boardName(mapper)` — and an unknown mapper reports itself as `mapper 999` rather than being guessed at.

**The parsed cartridge is immutable.** The machine holds a reference and never copies it into a snapshot; see §5.

## 4. `m6502.js` — the CPU

The companion to `z80.js`: same shape (inject a bus, call `step()`, get cycles back, snapshot the register file). The interesting difference is that on the NES **timing is semantic**. The video chip runs at exactly 3× the CPU clock and games change scroll registers mid-scanline, so a one-cycle error is a visible glitch, not a rounding error.

### No cycle table — cycles fall out of the bus accesses

This core has **no per-opcode cycle table**. Every bus access costs one cycle, exactly as on the real chip, and the internal cycles are spent where the chip spends them:

- **Indexed reads** (`abs,X` / `abs,Y` / `(zp),Y`) read the *wrong* address first when the index carries into a new page, then re-read the right one. That is the famous "+1 on page cross", and the bogus read is real hardware behaviour: it is why reading `$2007` through `abs,X` can advance the PPU address twice, and why MMC3's scanline counter can be clocked by a read the programmer never intended.
- **Read-modify-write** instructions write the **old** value back before the new one. Games use that doubled write on purpose — an RMW on a mapper or APU register hits it twice in two cycles.
- **Indexed writes** always pay the dummy read, page cross or not.
- **Branches** cost 2 / 3 / 4 (not taken / taken / taken across a page boundary).

Get the access pattern right and the cycle counts are automatically right. That is what makes nestest line up to the cycle, and it means stage 2 can sync the PPU by *catching up on register access* rather than guessing.

### Interrupts

- **NMI is edge-triggered.** The PPU pulls the line low at the start of vblank and holds it, so a level check would fire an NMI every instruction until the handler read `$2002`. Use `setNmi(level)` to model the line; `nmi()` to fire one edge.
- **IRQ is level-triggered** and wire-ORed between sources (APU frame counter, DMC, mapper). `setIrqSource(bit, level)` keeps sources independent so one releasing does not clear another's request.
- **The I flag written by `SEI` / `CLI` / `PLP` takes effect one instruction late**, because the interrupt logic samples it a cycle before the flag update lands. `CLI; <one instruction>; <IRQ>` is a real pattern in game code. `RTI` is the exception: it pulls P early enough to matter immediately.
- The `B` flag is not a real flip-flop. It exists only in the byte pushed on the stack, which is how a handler distinguishes `BRK` from an IRQ. We keep it clear in `p` and OR it in when pushing.
- Interrupts are polled at **instruction boundaries**. The mid-instruction "interrupt hijacking" cases are not modelled (see §7).

### Illegal opcodes

All 256 opcode patterns are decoded; none falls through to a default. Publishers used the undocumented ones for speed (`LAX` is "LDA+LDX in one"), so a core that traps illegals fails on real cartridges.

- **Stable and exact**: `LAX`, `SAX`, `DCP`, `ISC`, `SLO`, `RLA`, `SRE`, `RRA`, `ANC`, `ALR/ASR`, `ARR`, `SBX/AXS`, the illegal `SBC` (`$EB`), and the multi-byte `NOP`s (which must burn the right number of cycles because assemblers emitted them as padding).
- **Approximated**: the unstable opcodes. `ANE/XAA` (`$8B`) and `LXA` (`$AB`) AND in a "magic" constant whose value depends on the chip, its temperature and what was last on the bus; we use `$EE`, the value most emulators settle on. The `&(H+1)` stores — `SHA`/`SHX`/`SHY`/`TAS` — write `value & (high byte of the base address + 1)`, and on a page cross the high address byte is replaced by that value. No known commercial game depends on either behaviour.
- **`JAM`/`KIL`** stops the chip until RESET. Modelled as `cpu.jammed = true` rather than an exception: a crashed game is a legitimate thing to observe in a debugger.

Decimal mode is implemented but **off by default**, because the 2A03 has the BCD adder disabled in silicon. `new M6502(bus, { decimal: true })` gives a plain NMOS 6502 (flags follow NMOS, not 65C02).

### Bus

Injected, like `z80.js`: `{ read(addr), write(addr, val) }` — no `in`/`out`, the 6502 has no separate I/O space. Every access is one cycle, so the bus sees the dummy reads and the RMW double write, which is exactly what stage 2's mappers and PPU need.

## 5. Snapshot policy (this is what rewind is made of)

`demo/machine.html` keeps up to 1000 snapshots in a ring buffer and auto-tunes the interval to stay around 150MB. **A big snapshot means a short rewind window**, so:

- **Immutable data never goes in a snapshot.** PRG-ROM and CHR-ROM are held by reference from the loaded cartridge and restored by reference. (Same rule `machine88.js` applies to mounted D88 images, documented there rather than hidden.)
- The CPU state is registers only — `a, x, y, s, p, pc, cycles` plus the interrupt lines. Tens of bytes.
- `getState()` / `setState()` are exact inverses; `snapshot()` / `restore()` are aliases so the CPU reads the way the machines do.
- Everything is plain data: numbers, booleans, typed arrays. No class reconstruction, so `snap.js`'s `snapObj` / `restoreObj` work on it directly, and `restore()` writes into existing objects.

What stage 2 must snapshot per frame: 2KB work RAM, 2KB video RAM, 256B OAM, 32B palette, PPU/APU registers and internal latches, mapper state, and CHR-RAM if the board has it — roughly 5KB before compression, which is the budget that keeps 1000 frames affordable.

## 6. Testing

### Unit tests

`node --test`. `test-6502.mjs` pins flags, addressing modes and **cycle counts** individually, so that when nestest fails there is somewhere for the failure to land. `test-ines.mjs` concentrates on damage: dirty headers, truncation, junk input.

### Determinism tests (mandatory)

Three properties, each tested directly:

1. Same program run twice → identical fingerprint (registers + a hash of RAM).
2. Snapshot → run ahead → restore → replay the same steps → identical fingerprint.
3. The same, with an **interrupt arriving mid-replay** — the worst case, because it is exactly what "input arrives after the snapshot" looks like during a rewind.

The test program is generated by a small LCG seeded by hand, never `Math.random`.

### nestest — instruction-by-instruction verification

This is the acceptance test. nestest.nes, entered at `$C000`, runs without a PPU, exercises every documented opcode and every documented illegal one, and a cycle-exact reference log of a real console running it has been published. Matching `PC/A/X/Y/P/SP/CYC` line by line pins down not just the arithmetic but the timing.

It is the same method this repo already uses against M88 (see `docs/m88-comparison.md`): run a reference implementation and ours over the same program, diff the traces, and get the divergence reported at the exact instruction that caused it.

**The ROM and log are not in this repository** (do not commit test ROMs). Get them from the `nes-test-roms` collection:

```sh
curl -L -o /tmp/nestest.nes https://raw.githubusercontent.com/christopherpow/nes-test-roms/master/other/nestest.nes
curl -L -o /tmp/nestest.log https://raw.githubusercontent.com/christopherpow/nes-test-roms/master/other/nestest.log
```

Then run it, by argument or environment variable:

```sh
node nestools/nestest.mjs /tmp/nestest.nes /tmp/nestest.log
NESTEST_ROM=/tmp/nestest.nes NESTEST_LOG=/tmp/nestest.log node --test test-6502.mjs
```

`node --test` skips the nestest case when the variables are unset, so the suite still passes without the ROM.

**Current result: all 8991 log lines match, PC/A/X/Y/P/SP and CYC, and nestest's own verdict bytes `$02`/`$03` are `00 00` — every subtest passed, official and illegal opcodes alike.**

## 7. What is not here yet

Stage 2 and beyond, in the order the issue lays out:

- `nesppu.js` — background, sprites, scrolling, sprite 0 hit. The CPU is ready for it: cycle counts are exact and the bus sees every access, so the PPU can be caught up at register-access granularity.
- `nesmapper.js` — NROM(0) / MMC1(1) / UxROM(2) / CNROM(3) / MMC3(4) at minimum. MMC3's scanline IRQ depends on PPU address bus behaviour *and* on the dummy reads this core already performs.
- `nesapu.js` — two pulses, triangle, noise, DMC. The DMC steals CPU cycles, which the current `step()` does not model.
- `machinenes.js` — the machine class satisfying `stepFrame()` / `frame` / `snapshot()` / `restore()` / `schemaVersion`.
- Host integration in `demo/machine.html`, including generalising the machine-specific checks that are still there.

Known gaps inside stage 1, listed rather than hidden:

- Interrupts are polled at instruction boundaries, not mid-instruction. The delayed-NMI and "interrupt hijacking" edge cases (an NMI arriving during a `BRK` sequence) are not reproduced. blargg's `cpu_interrupts_v2` is the test that would catch this; it is a stage-2 task, once there is a PPU to run it under.
- The unstable illegal opcodes are approximated (see §4).
- Open-bus reads return whatever the bus returns; the CPU does not model the decaying open-bus latch. That belongs to the machine's bus, not to the CPU.
