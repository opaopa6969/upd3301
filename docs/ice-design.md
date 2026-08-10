**English** · [日本語](./ice-design.ja.md)

# ICE design — debugger, assembler, and the stone tools

In the hardware era an ICE (In-Circuit Emulator) cost more than the machine
it debugged; this settles that account for free in 2026. The measurement
floor is **`icecore.js`** — pure, DOM-free and machine-independent — with two
faces on top of it: the browser UI `demo/ice.html` / `demo/ice.js` (a separate
window grabbing `window.opener.__machine`) and the headless CLI
`tools/ice.mjs`. Architecture-specific knowledge lives in **`icearch.js`** as
plain descriptors, so adding a CPU is filling in a table.

## Principles

- **The core is never edited.** All instrumentation happens from outside —
  wrapping `cpu.step` / `stepFrame` / bus callbacks. The core only provides
  general APIs (`getState`/`setState`, `snapshot`/`restore`).
- **Determinism is the weapon.** Time travel and equivalence checking are
  both dividends of the repo's same-inputs-same-outputs law. The
  `Math.random` ban extends to the UI (flicker is frame-counted).
- **Honest tails.** What wasn't observed is shown as *unclassified*, never
  guessed. The same rule applies to the debugger's own limits: with no
  disassembler for an architecture the ICE shows bytes and *says* it has no
  decoder, rather than an empty pane.
- **Never abort mid-instruction.** A bus tap that wants to break sets a
  pending flag; the step wrap turns it into a break after the opcode
  completes. Aborting mid-opcode leaves the CPU half-executed and
  determinism in pieces.
- **Machine independence is a capability probe, never `instanceof`.** A
  machine is anything with `stepFrame()` and at least one CPU-shaped object.
  How to reach its memory is discovered (`readMem` → `peek` → `sys.memory` →
  the CPU's own bus) and then *reported*, because reading through a live bus
  can perturb what it measures.

## The architecture contract (`icearch.js`)

One descriptor per CPU, all fields optional except `name` / `addrMask` /
`pcOf`:

| field | meaning |
|---|---|
| `addrMask` / `ioMask` | address wrap; `ioMask: null` = no separate I/O space |
| `pcOf` / `setPc` / `spOf` / `spMask` / `pushBytes` | what the shadow stack needs |
| `disasm(read, addr, opts) → {text, len, bytes}` | **the disassembler contract**; `z80dis.js` already has this shape |
| `callAt(read, pc) → {target, retTo} \| null` | call detection for the shadow stack |
| `condVars` / `condValues(cpu, read)` | the names a breakpoint condition sees |
| `regFields` / `regsModel` / `writeReg` | the register pane |
| `tapBus(cpu, hooks) → untap` | how to see every access |

Shipped: `Z80_ARCH` (complete), `M6502_ARCH` (no disassembler yet, so no
mnemonics — everything else works), `M68K_ARCH` (the acceptance socket for
the 68000 ICE: bus tap and 24-bit watchpoints work today; `disasm` and
`callAt` are `null` and get filled in together when the decoder lands),
`GENERIC_ARCH` (anything with `pc` and `step()`).

Selection is `detectArch(cpu)`, a probe over register shape — the Z80's
shadow set, the 68000's eight `d`/`a` typed arrays, the 6502's `A/X/Y/P/S`.
`registerArch(arch, probe)` adds one from outside.

Verified on four machines: PC-8001, PC-8801 (main Z80 + FDD sub Z80),
Famicom (6502) and Mega Drive — where the probe finds **two CPUs of
different architectures on one board**, a 68000 and a Z80, and gives each its
own descriptor.

## Headless (`tools/ice.mjs`)

The M88 parity run (#32) re-invented six of these measurements as one-shot
scripts because the ICE was locked in a browser. Each is now a subcommand of
the same instrumentation:

| subcommand | one-shot original | what it does |
|---|---|---|
| `trace` | `tools/pc-trace.mjs` | PC trace, deduped, **armed on a PC** (frame numbers are not shared between emulators; the first execution of an address is) |
| `diff` | `tools/trace-diff.mjs` | census of one-sided PCs + first divergence that never re-syncs |
| `read` | `tools/watch-read.mjs` | what the CPU actually saw (no banking ambiguity) |
| `write` | `tools/watch-write.mjs` | who wrote here, with the destination the write was routed to |
| `life` | `tools/life-scan.mjs` | region-of-life over a whole run |
| `loop` | `tools/loop-profile.mjs` | waiting or runaway? distinct PCs + the port it polls |
| `caps` | — | which CPUs, which architectures, how memory is being read |
| `break` | — | run to a breakpoint/watchpoint and dump the scene (the one thing the scripts could never do) |

`trace` is byte-identical to `pc-trace.mjs` for both the main and the sub CPU,
armed or from frame 0; `read`/`write`/`life`/`loop` report the same lines and
the same totals. The six originals stay in place — #32's written procedures
point at them, and a running investigation is not a place to move furniture.

Judgement rules are **not** duplicated here: `tools/verdict.js` holds them as
pure, unit-tested functions (they have been wrong three times, and
`test-verdict.mjs` encodes each mistake). `tools/ice.mjs` imports it when
present and prints raw signals when it is not.

## Components

### Observation & control
- Full registers, from the architecture descriptor (Z80: shadow set, **R**,
  IM/IFF; R is real — 7-bit bump per M1, bit 7 preserved). Click-to-edit
  while paused (writing PC = jump).
- Disassembly (`z80dis.js`; Zilog syntax default, **Intel 8080** toggle to
  match the 88 monitor culture; Z80 extensions stay Zilog).
- Editable memory hex dump; the sub tab adds FDC state and motor bits.
- Breakpoints: address plus **conditional expressions** (JS over registers
  and `mem(addr)`, per-CPU).
- Always-on clocks: total T-states, real-time equivalent (T/clockHz), frame.

### Time travel (infinite undo/redo + branching tree)
- Core: `machine.snapshot()`/`restore()` (the 8801's covers the sub board,
  the 8255 pair and the FDC; verified by test-snapshot.mjs).
- ICE: auto-snapshot every N frames plus an **input event log** (keyDown/
  keyUp stamped with frame numbers). Undo = restore nearest node, then
  deterministically re-run to the exact target.
- **Branching**: resuming from a paused past with different inputs grows a
  child branch. Nodes are snapshots; click to jump.
- Honest note: mounted D88s are held by reference — sector writes are not
  rewound.

### Profiler
- Shadow call stack (CALL/RST/RET tracking) attributing self/total T-states
  and call counts per routine, with real-time equivalents and symbol names.

### Assembler (`z80asm.js`) and static analysis (`z80anal.js`)
- Two-pass, MACRO-80-compatible macro layer (IF/IRP/LOCAL/EXITM/&/%,
  mnemonic shadowing + PURGE), `PROC USES` (auto push/pop), `STRUC` (named
  IX offsets), `RELOC` (fixup table emission). Full syntax reference and
  the M80 difference table: [z80asm.md](./z80asm.md).
- Analysis per routine: clobbered/input/saved registers (propagated
  transitively through calls), I/O ports with machine-specific names,
  memory access map with known-region names, stack-balance lint, T-state
  min/max, self-modifying-code detection (shown as ⚡, not an error).

## The stone tools (reverse-engineering kit)

Name things, lift them to source, put them somewhere else — the firmware
era's stone tools, upgraded from *prayer* to *verification* by living
inside an emulator.

> Etymology: the author typo'd 機器 (equipment) as 石器 (stone tools). It
> was too accurate to fix — primitive like flint axes, and no civilization
> starts without them — so it became the official term.

1. **Label DB** — name addresses in the disassembly; localStorage plus JSON
   export/import; merges with z80asm symbols; resolved everywhere
   (disassembly, profiler, breakpoints).
2. **Source export** — range → labeled disassembly + DB/DW for data
   regions + `ORG`. **Re-assembling must reproduce the original bytes**
   (round-trip is the acceptance test).
3. **Relocate** — re-assemble the exported source at a different ORG and
   write it back; in-range references follow their labels automatically.
4. **Trace-based separation** (issue #5) — coverage map (M1/read/write per
   byte) plus light taint (immediate values matched against later memory
   accesses) settles code/data/pointer by observation. Untouched bytes stay
   unclassified.
5. **Address-dependence defenses, three layers** (issue #5 follow-up):
   - **Pinned regions**: ranges excluded from movement (hardware-fixed
     areas auto-pinned) — the "when in doubt, don't move it" valve.
   - **Alignment constraints**: half-byte taint catches `LD H,imm`-style
     high-byte pointers → 256-alignment constraint (only 0x100-multiple
     shifts allowed, or demote to pinned).
   - **Twin-run diff**: run original and relocated builds in two
     deterministic emulators on identical inputs and compare traces;
     divergence = a missed address dependence, and snapshot bisection
     names the exact instruction. Relocation correctness as a *check*,
     not a hope.

## Dependency direction

```
demo/ice.js (panes) ─┐                    tools/ice.mjs (CLI) ─┐
                     ├─▶ icecore.js ──wraps──▶ any machine ──▶ chips
                     │        │
                     │        └─▶ icearch.js ──▶ z80dis.js (pure)
                     ├─▶ z80asm.js (pure) ──▶ z80anal.js
                     └─▶ snapshot/restore via snap.js (core-provided)
```

`icecore.js` imports no machine and touches no DOM; `icearch.js` imports no
`icecore.js`. Both faces are clients. The UI reads the core; the core never
knows the UI. Every stone tool is a pure, headless-testable module — the ICE
is merely how they are shown.

Tests: `test-icecore.mjs` (headless, no ROM, no DOM — includes a 6502-shaped
and a 68000-shaped toy CPU so the machine independence is asserted rather
than claimed) and `test-ice.mjs` (the controller-level acceptance, still
green against the extracted core).

## Known gaps

- The UI's `demo/ice.html` panes are **visually unverified** after the
  extraction — the controller-level tests pass, but nobody has looked at the
  page in a browser.
- No 68000 or 6502 disassembler yet, so those tabs show bytes. `callAt` for
  the 68000 waits on the decoder (guessing instruction lengths would corrupt
  the shadow stack).
- Watchpoints are a CPU instrument: DMA pulls go through `dmac.readMemory`,
  outside the CPU bus, and are not seen. Unchanged from the original design.
- NES and Mega Drive expose no bank-aware read accessor, so the ICE reads
  through their CPU bus and says so (`caps` prints the warning). A `peek()`
  on those machines would remove the caveat.
