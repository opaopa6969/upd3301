**English** · [日本語](./m68000-design.ja.md)

# Design — m68000 (Motorola MC68000 / 68EC000)

`m68000.js` is the 16/32-bit CPU core of this collection. It exists once and is
shared: the Mega Drive and the X68000 both hang off a 68000, so the chip is
written machine-agnostically and each machine injects its own bus. Nothing in
the core knows about VDP registers, sprite controllers or floppy chips.

## Contract (suite-contract compliant)

- Pure, zero-dependency JavaScript. No DOM, no `Math.random`, no sibling
  imports. ES modules.
- Deterministic: the same program plus the same bus produces bit-identical
  state, every time.
- `step()` executes exactly one instruction (or takes one pending exception or
  interrupt) and returns the clock periods it consumed.
- `snapshot()` returns plain data with a `schemaVersion`; `restore()` is its
  exact inverse.
- The core decides nothing about how it is used. It has no frame loop, no
  timing master, no notion of a screen.

## API

```js
import { M68000, BusError, VEC } from 'upd3301/m68000';

const cpu = new M68000(bus, { tasWriteBack: true });
```

### The bus

The 68000's data bus is 16 bits wide with UDS/LDS byte strobes, and its address
bus is 24 bits. The injected object mirrors that:

| member | required | meaning |
|---|---|---|
| `read16(addr)` | yes | one word cycle, both strobes asserted |
| `write16(addr, val)` | yes | one word cycle |
| `read8(addr)` | no | one byte cycle (UDS for even, LDS for odd) |
| `write8(addr, val)` | no | one byte cycle |
| `read32(addr)` / `write32(addr, val)` | no | shortcut for plain RAM |
| `irqAck(level)` | no | interrupt acknowledge; return a vector number, or a negative/undefined for autovector |
| `resetLine()` | no | called by the `RESET` instruction |

Only the 16-bit pair is mandatory, because that is what the pins do. Missing
byte accessors are synthesized with a read-modify-write on the containing word;
missing 32-bit accessors are synthesized as two word cycles, high word first —
so hardware with side-effecting registers sees exactly the transaction count it
would see on silicon. **The object you pass is never mutated**: the resolved
callbacks live on the CPU, so a class-based bus keeps its own `this`.

Addresses handed to the bus are masked to 24 bits. Registers keep all 32.

A bus callback may `throw new BusError(addr, isWrite)` to assert `/BERR`; the
core turns it into a bus-error exception with the proper group-0 stack frame.

```js
const mem = new Uint8Array(0x100000);
const bus = {
  read16: (a) => (mem[a] << 8) | mem[a + 1],
  write16: (a, v) => { mem[a] = v >> 8; mem[a + 1] = v & 0xff; },
};
const cpu = new M68000(bus);   // reset reads SSP from 0 and PC from 4
```

`new M68000(bus)` performs a hardware reset, which means the bus has to be able
to answer before the constructor runs. A machine that maps its ROM later can
simply call `cpu.reset()` again once it has.

### Registers

`cpu.d` and `cpu.a` are `Uint32Array(8)`. `a[7]` is always the *active* stack
pointer; the accessors `cpu.usp` and `cpu.ssp` return the logical values
whichever mode you are in, and writing them does the right thing. The status
register is exposed both as fields (`sr_t`, `sr_s`, `sr_ipm`, `fx`, `fn`, `fz`,
`fv`, `fc`) and through `getSR()`/`setSR()`/`getCCR()`/`setCCR()`. Writing SR
through `setSR()` swaps stack pointers when the S bit changes.

### Interrupts

```js
cpu.setIRQ(4);       // assert IPL2..0 = 4
cpu.setIRQ(0);       // release
```

The line is level-sensitive for levels 1..6: the interrupt is taken at the next
instruction boundary if its level exceeds the mask in SR. Level 7 is the NMI and
is edge-triggered, so a device that parks the line high does not loop forever.
When an interrupt is taken, `bus.irqAck(level)` is called if present; returning a
vector number selects it, and returning nothing (or a negative number) means the
device asserted VPA and the core autovectors to `24 + level`. The mask is raised
to the interrupt's level, exactly as the chip does.

### Exceptions

All of the 68000's exceptions are implemented: reset, bus error, address error,
illegal instruction, line-A and line-F emulator traps, divide by zero, CHK,
TRAPV, privilege violation, TRAP #0..15, trace, and the seven autovectored
interrupt levels. `VEC` exports the vector numbers.

Group 1/2 exceptions push the six-byte frame (SR at SP, PC at SP+2). Group 0
(bus error, address error) pushes the fourteen-byte frame: special status word,
access address, instruction register, SR, PC. A fault *while writing that frame*
is a double bus fault and sets `cpu.halted`, which is what the real chip does.

The trace exception is taken at the top of the *next* `step()`, ahead of any
pending interrupt: the traced instruction runs to completion first, and changing
T inside the instruction does not retroactively cancel or cause the trace.

### 68010 and later

Instructions that only exist on the 68010 and above — `RTD`, `MOVEC`, `MOVES`,
`BKPT`, `MOVE from CCR`, `EXTB.L`, the 68020 long multiply/divide, bitfields —
decode to the illegal-instruction vector, which is what a real 68000 does with
them. `MOVE from SR` is **not** privileged here, because on a 68000 it is not
(the 68010 made it so).

### Snapshot

```js
const s = cpu.snapshot();   // plain data, ~350 bytes of JSON
cpu.restore(s);
```

`snapshot()`/`restore()` are an exact inverse pair, which is what makes the
host's deterministic rewind work: snapshot, run ahead, restore, replay the same
input, land in the same place. `getState()`/`setState()` are aliases so machine
code written against `z80.js` reads the same.

**The snapshot deliberately holds no ROM and no memory.** `demo/machine.html`
keeps a ring buffer of one snapshot per frame, so every immutable byte stored in
here is rewind seconds thrown away. The machine snapshots its own RAM.

## Cycle counting

`step()` returns clock periods from the timing tables in the M68000 User's
Manual (Appendix E): a base time per instruction plus an effective-address
calculation time, with MOVE using the separate source/destination split.
Instructions are **not** cycle-stepped internally — one `step()` is one whole
instruction. The data-dependent instructions are modelled properly:

- `MULU` costs 38 + 2 per set bit of the source word.
- `MULS` costs 38 + 2 per 0→1 or 1→0 transition in `src << 1` (the microcode
  Booth-encodes).
- `DIVU` and `DIVS` run the microcode's restoring-division loop and count the
  work it actually does.

## Verification

This is the part that matters, and it follows the method this repository
already used to bring PC-8801 emulation to byte-for-byte parity with M88
(`docs/m88-comparison.md`, `m88ref/`): take a reference implementation, run it
against ours state-by-state, and chase the first disagreement rather than
guessing from "the game hangs".

The oracle here is **[SingleStepTests/m68000](https://github.com/SingleStepTests/m68000)**
— 317,500 recorded single-instruction transitions (2,500 per instruction form,
127 forms), generated from MAME's microcoded 68000. Each case is an initial
register/memory state, one instruction, the expected final state, and the full
bus transaction log with a cycle count.

### Reproducing

```sh
m68ktools/fetch-tests.sh                       # ~138 MB into ./m68k-tests
node m68ktools/run-sst.mjs --dir ./m68k-tests
```

The vectors are **not** committed — they are large and regenerated upstream.
Useful flags:

| flag | effect |
|---|---|
| `--only <regex>` | restrict to matching instruction files |
| `--limit <n>` | first n cases per file |
| `--cycles` | also compare clock periods |
| `--no-aerr` | skip cases whose instruction aborted with an address error |
| `--strict-aerr` | also require the group-0 frame's unpredictable PC field |
| `--verbose` | print failing cases and cycle-delta histograms |
| `--json` | machine-readable summary |

The decoder for the upstream `.json.bin` container is `m68ktools/sst.mjs`, so no
Python is needed.

### Results

| run | result |
|---|---|
| state only, address-error cases excluded (`--no-aerr`) | **261,894 / 261,894 — 100 %** |
| state only, whole suite | 314,174 / 317,500 — 98.95 % |
| state **and** cycles, address-error cases excluded | 259,031 / 261,894 — 98.91 % |

### Known gaps, honestly

**1. The group-0 stack frame's PC field (3,326 cases, ~1 %).**
When an instruction aborts with an address error, the 68000 stacks a PC that the
User's Manual itself calls unpredictable — "two to six bytes beyond" the
instruction, depending on how far the prefetch queue had run. Reproducing the
reference's exact value means reproducing its prefetch microcode. We stack the
common case (one word past the opcode for a read fault, two for a write; the
target itself for a faulting branch prefetch). The runner counts these
separately and reports them as `aerr-frame-PC` rather than hiding them; pass
`--strict-aerr` to fail on them. Everything else in the frame — special status
word including its opcode-derived upper bits, faulting address, function code,
instruction register, SR, handler PC, stack pointer — is compared strictly and
matches.

**2. Micro-ordering after an address error (the rest of the 1 %).**
A handful of details are visible only in the exception frame of an instruction
that already failed: which half of a long operand the chip touched first, whether
an address-register write-back had committed, and which word the reference had
already prefetched into its instruction register. We model the documented rules
(a long operand through `-(An)` transfers low word first; byte/word pointer
updates stay committed while long ones do not; read-modify-write destinations
commit the pointer first and go high word first) and match the reference for the
great majority, but not every microcode path. **A 68000 cannot resume from a
group-0 frame at all**, so no real software can observe any of this.

**3. Cycle counts (2,863 of 261,894 non-fault cases, 1.1 %).**

| instruction | status |
|---|---|
| `TAS` (memory) | 2,108 cases. We use the manual's 14+ea; the reference reports 10+ea. Upstream's own README says its TAS timing is wrong ("doesn't properly handle the special 5-cycle TAS read-modify-write timing"), so the manual wins here. |
| `DIVS` | 353 cases, off by 2 or 4. The sign-correction term in the division timing model is not exact for positive divisors. `DIVU` matches exactly. |
| `CHK` (trap taken) | 402 cases. We charge 38+ea; the reference charges 40 for about half of the "Dn &lt; 0" cases, on a distinction we could not identify. |

Everything else — all 124 other instruction files — matches cycle for cycle.

**4. `TRAPV` and `TAS` in general.** Upstream flags both as not fully verified.
Our `TRAPV` passes all 2,500 cases; `TAS` passes on state and differs only in
timing as above.

## Determinism

`test-m68000.mjs` runs the same program twice and asserts bit-identical state
and memory, then snapshots mid-run, runs ahead, restores, replays, and asserts
the results converge. It also asserts a snapshot survives a JSON round trip,
carries a `schemaVersion`, holds no typed arrays, and stays under 512 bytes.

## Layering

```
m68000.js        pure CPU — knows a bus, nothing else
   ↑
machine port     Mega Drive / X68000: builds the address map, drives step(),
                 raises setIRQ(), owns its own RAM in its own snapshot
```

The dependency arrow only ever points one way. The core imports nothing.
