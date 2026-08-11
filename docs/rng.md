**English** · [日本語](./rng.ja.md)

# RNG finder — identifying and manipulating a game's random numbers

*Issue [#38](https://github.com/opaopa6969/upd3301/issues/38). Built on the
headless ICE ([#37](https://github.com/opaopa6969/upd3301/issues/37),
[ice-design](./ice-design.md)) and exporting into the shared analysis format
([#39](https://github.com/opaopa6969/upd3301/issues/39),
[analysis-format](./analysis-format.md)).*

Most 8-bit games do not have a random number generator. They have a **table** —
a run of bytes walked by a pointer in RAM — or four instructions of LCG, or an
LFSR built out of `SRL A` / `JR NC` / `XOR n`. Players who "manipulate RNG" are
exploiting that structure by hand, from the outside, by counting frames.

On a deterministic emulator the structure is *visible*. Every read the CPU makes
goes across the bus already resolved through whichever bank was selected, and
the whole run can be replayed byte-identically. So this tool does not infer a
generator from statistics. It **watches**, proposes a model, and then **proves
or disproves it by patching the state and replaying**. If the second run does
not diverge, the guess was wrong, and it says so.

| file | what it is |
|---|---|
| `rngfind.js` | the estimator. Pure, **zero imports**, deterministic, machine-independent |
| `tools/rng.mjs` | headless CLI: `scan` / `verify` / `callers` / `predict` / `adjust` |
| `test-rngfind.mjs` | 22 tests, **no ROM**: generators assembled with `z80asm.js`, answers known |

## Quickstart

```sh
# 1. find candidates
node tools/rng.mjs scan --disk game.d88 --settle 900 --frames 400

# 2. prove one. This is the step that matters.
node tools/rng.mjs verify --disk game.d88 --addr E123 --value 99 --probe E123

# 3. who draws from it, and what did they get
node tools/rng.mjs callers --disk game.d88 --addr E123 --notes game-rng.json

# 4. what do I write NOW to get the draw I want
node tools/rng.mjs adjust --model lcg:5,1 --want 07 --in 3
```

## What it can identify

| shape | how it is found | what you get |
|---|---|---|
| **table** | one PC reads many addresses with a constant stride, and wraps | span, stride, length, the bytes as the CPU saw them, and the RAM byte that indexes it |
| **LCG** `x' = ax+c mod 2^n` | few addresses read *and* written by very few PCs | `a` and `c`, brute-forced and verified against the whole sample |
| **LFSR** | same signature as an LCG | tap mask and shift form (Galois/Fibonacci × left/right) |
| **counter** | a state whose steps are constant | the step **and the modulus**. `mod 2^n` *and* `mod m` for an arbitrary m — a table index wraps at the table length, not at 256, and that is the single most common thing a table-driven game actually does |
| **anything else** | — | `unclassified`, with the sample count and the reason |

`unclassified` is a first-class result. This repo's house rule is that a model
nobody can verify is worse than an admitted blank
([ice-design](./ice-design.md), `analysisdb.js`), and a scan that names
everything is a scan that is lying about something.

## What it cannot identify

Stated plainly, because a tool that hides its blind spots gets trusted in
exactly the places it should not be:

- **State that never touches the bus.** A generator that keeps its seed in `HL`
  across draws, or that uses the Z80 `R` register, is invisible to a memory
  tap. `R` in particular is a real 8-bit idiom and the ICE models it correctly —
  but `LD A,R` is not a memory read, so nothing here sees it.
- **Non-linear generators.** xorshift, add-with-rotate, "multiply and take the
  high byte of a 16×16" — none of these fit a counter, an LCG or an LFSR, and
  the tool returns `unclassified` rather than picking the nearest.
- **Anything upstream of the first draw.** `verify` cannot confirm a byte the
  program has not reached yet; a REFUTED verdict at `--at 300` may be a
  confirmed one at `--at 1500`.
- **Titles that never draw.** A title screen waiting on a keypress draws no
  random numbers. Use `--keys` (below), or the scan measures the wait loop.
- **The bank you did not watch.** The read log is bank-resolved, so what the CPU
  saw is unambiguous — but a value written into a bank that is switched out and
  back is only visible while the CPU is looking at it.

## How it works

### Two passes, because the first one must be cheap

**Pass 1 (census)** taps every memory access for the whole window and keeps
counters only: reads and writes per address, and per read-site (PC) the address
range, the stride behaviour and the set of *callers*. A four-million-access run
costs about half a second and a couple of megabytes.

**Pass 2 (sampling)** re-runs the machine **from reset** and keeps the ordered
`(frame, pc, addr, value, caller)` stream for the handful of candidates that
survived. Re-running rather than rewinding is legal here for exactly one
reason — same input, same run, always — and it is also why `open()` must return
a *fresh* machine every time.

### Three filters that are not obvious

Each of these was a wrong answer first.

1. **Instruction fetches and data reads share one bus.** On a Z80 every opcode
   byte arrives through the same `bus.read` as `LD A,(HL)`, so a raw read log is
   ~97% "the program read itself" and every routine looks like it is walking a
   table. The filter that works is exact rather than statistical: at the moment
   of a fetch the core has not yet advanced PC past the byte it is fetching, so
   **`addr === pc` means fetch**. On a real disk that removes 3.78 M of 3.89 M
   accesses.

2. **The PC logged with a data read points *after* the operands.** `LD
   A,(1234h)` at `8000h` logs `pc=8003h`, because the operand bytes were fetched
   first. It is still a stable per-instruction key, so grouping works — but
   printing it as "the instruction at 8003h" is a lie. `resolveSite()` walks it
   back with the disassembler, and reports `ambiguous` when more than one parse
   ends at that address (`8002h` decodes as the one-byte `LD (DE),A`, which also
   ends at `8003h`).

3. **The stack looks exactly like RNG state.** A byte read a lot and written a
   lot, in RAM, adjacent to another one just like it, *is* a 16-bit seed — and
   it is also every stack slot in the machine. Worse, a return address
   alternating between two call sites **fits an LCG**: `x' = 255x + (x₀+x₁) mod
   256` is precisely a two-cycle, and the solver will name it with a straight
   face. Three defences: accesses within a couple of bytes of SP are dropped,
   addresses with many writer PCs are rejected, and a sequence with almost no
   distinct values is refused — *it cycles* is not *it generates*.

4. **A busy poller drowns out the routine that updates the state.** Ys II reads
   `25D5h` **19,782 times** from one instruction while it waits — always `07h` —
   and 102 times from the instruction that decrements it. Merged, that address's
   read stream is a constant with noise and classifies as nothing. Split by read
   site, the updater is a clean countdown mod 15. So sequences are gathered
   per `(direction, PC)` as well as merged, and the longest clean fit wins.

### Ranking: caller diversity first

The single most useful signal turned out not to be the stride or the volume:

> A routine whose result is consumed from eleven different places is a random
> number generator. A routine with one caller is a `memcpy`, no matter how
> table-shaped its reads look.

So candidates are ranked by the number of distinct **call sites** (the return
address on the ICE's shadow call stack) and only then by volume. That is also
exactly the information the caller map needs, so it is collected once and used
twice.

### `--settle` matters more than `--frames`

The first few hundred frames of a real title are the disk loader, and a loader
walks a thousand contiguous bytes from one PC with a constant stride — the exact
signature of a random number table. Every early scan had the FDC transfer loop
as its top candidate until `--settle` existed. Default is 600 frames; raise it
until the game is actually playing.

### `--keys`: getting past the title screen

A title screen draws no random numbers. `--keys space,enter,z --every 60 --hold 6`
presses those keys in rotation, and it does so as a **pure function of the frame
number** — because rngfind re-runs the machine from reset to sample and again to
verify, and an input that differed between runs would turn "replay" into a
different experiment while still looking like one.

The matrix is the PC-8801 layout established in `demo/machine.html` (row 9 is
`SPACE ESC TAB ↓ BS INS CR ←`, which is *not* the PC-8001's row 9).

## Verification — the only step that turns a guess into a claim

```
node tools/rng.mjs verify --disk game.d88 --addr E123 --value 99 --probe E123
```

Runs the machine twice from reset. In run B, at `--at`, one byte is written.
Then both runs continue for `--frames` and two digests are compared:

- **the de-duplicated PC trace** — did the program take different branches?
  Machine-independent, and far stronger than comparing memory.
- **the probe** — an address or range whose read stream is hashed. A range probe
  hashes `(address, value)` pairs, not values: a table's *contents* never
  change, so probing a table with values alone reports "nothing happened" even
  when the pointer was moved and the program is now drawing completely
  different entries. That was a real false negative in the synthetic test.

Three verdicts, not two:

- **CONFIRMED** — the instructions executed changed. There is causality.
- **PARTIAL** — the value stream changed, the control flow did not. The byte is
  upstream of *data*, not (yet) of a *decision*. This is real and was the first
  thing hit on a real title: 1942's per-frame counter at `B10Ah` provably changed
  value while 515,261 instructions came out byte-identical. Worth knowing before
  spending an afternoon manipulating it.
- **REFUTED** — nothing changed. **This is the tool working, not failing** — it
  means the scan was wrong, and the next candidate is the one to try.

A generator whose consumer never *branches* on the value will not change the PC
trace at all; straight-line code produces identical traces from different
numbers. That is what the probe is for, and it is why PARTIAL exists as its own
answer rather than being rounded to either side.

## Input search — the manipulation loop

```sh
node tools/rng.mjs search --disk game.d88 --goal E123=07 --at 1500 --frames 30 --tries 120 --press space
```

Snapshot at `--at`, enumerate "wait W frames" × "press a key", check the goal,
restore, next. **Brute force is correct here in a way it never is on real
hardware** — same input, same state, always — and the winning plan is printed as
a frame count you can replay. Machines without `snapshot()`/`restore()` get told
so rather than silently re-running from reset for every trial.

## The caller map — the part a human writes

The same table read from `8C10h` decides an encounter and from `8C44h` decides a
critical hit. Nothing here can tell those apart. What it *can* do is separate
them, count them, and hold the note you write:

```sh
node tools/rng.mjs callers --disk game.d88 --addr E123 \
     --notes game-rng.json --note 8C10=encounter roll --export game-rng-doc.json
```

- call sites come from the ICE's shadow call stack (the return address), so the
  key is "who asked for the number", not "which instruction read the byte";
- the measured value distribution is kept beside every note. `analysisdb.js`
  will *warn* when a stated `expected` ("1/16") disagrees with what was
  measured, which catches a note that was true of a different ROM revision;
- `--notes` round-trips through a JSON file, so annotations survive between
  sessions and can be reviewed as a diff;
- `--export` writes an [analysis document](./analysis-format.md). Annotated
  callers become labels; **unannotated ones become `unclassified` entries that
  still carry their numbers**, because being counted and being understood are
  different things.

## Prediction and adjustment

```sh
node tools/rng.mjs predict --model lcg:5,1 --state 07 --n 16
node tools/rng.mjs adjust  --model lcg:5,1 --want 07 --in 3
```

`adjust` is the manipulation half: it brute-forces the state space (256 or 65536
entries) for every state that yields `--want` after `--in` draws, and prints all
of them, because some games sanity-check their own seed and you may need a
plausible one. For an LCG with an even multiplier the map is not onto and the
answer can legitimately be "no state produces that".

Then verify it, on the machine, before believing it.

## Limits of the whole approach

- It finds what the *program* does, not what the *hardware* does. A generator
  seeded from an unimplemented device will be identified correctly and predict
  wrongly.
- Self-modifying or decrypted RNG code is invisible statically; the read log
  still sees the accesses, so the candidate turns up, but `resolveSite` will
  disassemble whatever is at that address *now*.
- `distinct` sets are capped per site (512 by default); a walker that overflows
  the cap is marked `distinctCapped` rather than silently understated.
- The 68000 and 6502 architecture descriptors have no disassembler yet
  ([ice-design](./ice-design.md)), so on those machines a read site is printed
  as a bare address. Everything else works: the estimator never decodes an
  instruction to do its job.

## Test coverage

`test-rngfind.mjs` runs with no ROM and no DOM. Four generators are assembled
with `z80asm.js` — an LCG (`x' = 5x+1`), a 256-byte table with a RAM index, a
Galois LFSR with taps `B4h`, and the index counter that falls out of the table —
and the assertions are that the estimator recovers the constants **written in
the source**. Two of the assertions are about being wrong rather than right: the
stack must not be reported as a generator, and an xorshift must come back
`unclassified` rather than named.
