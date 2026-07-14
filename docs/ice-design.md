**English** · [日本語](./ice-design.ja.md)

# ICE design — debugger, assembler, and the stone tools

In the hardware era an ICE (In-Circuit Emulator) cost more than the machine
it debugged; this settles that account for free in 2026. Targets: PC-8001 /
PC-8801 — both the main Z80 and the FDD sub-board's Z80. The UI is
`demo/ice.html` (a separate window grabbing `window.opener.__machine`);
every tool underneath is a pure module in the repo root.

## Principles

- **The core is never edited.** All instrumentation happens from outside —
  wrapping `cpu.step` / `stepFrame` / bus callbacks. The core only provides
  general APIs (`getState`/`setState`, `snapshot`/`restore`).
- **Determinism is the weapon.** Time travel and equivalence checking are
  both dividends of the repo's same-inputs-same-outputs law. The
  `Math.random` ban extends to the UI (flicker is frame-counted).
- **Honest tails.** What wasn't observed is shown as *unclassified*, never
  guessed.

## Components

### Observation & control
- Full registers (shadow set, **R**, IM/IFF. R is real: 7-bit bump per M1,
  bit 7 preserved). Click-to-edit while paused (writing PC = jump).
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
ice.html ──wraps──▶ machine(.88).js ──▶ chips
   │
   ├─▶ z80dis.js (pure)
   ├─▶ z80asm.js (pure) ──▶ z80anal.js
   └─▶ snapshot/restore via snap.js (core-provided)
```

The UI reads the core; the core never knows the UI. Every stone tool is a
pure, headless-testable module — the ICE is merely how they are shown.
