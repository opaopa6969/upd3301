**English** · [日本語](./lessons-from-the-parity-run.ja.md)

# What five days of autonomous work taught us

Between 2026-08-08 and 08-13 this repository ran a long unattended session: raise the
PC-8801's fidelity against M88, and along the way go from one machine to nine, make the
ICE headless, and build an analysis format.

**This is not a list of achievements. It is a record kept so the same mistakes are not
repeated.**

The numbers first, to get them out of the way: exact matches 304→328/353, tracking
335→333/353, tests 63→1030. **Note that tracking went down by two.** Every title that
dropped out was chased individually and found to be **M88 sitting frozen**, not us
(e.g. M88 does not move a single bit in Silpheed from f500 to f3000).
But **most of the time went into doubting the tools and the measurements**, not into
writing emulator code.

---

## 1. Believing a number without checking what the instrument measures

**Seven times.** All the same shape.

| What was done | What actually happened |
|---|---|
| `grep "^T "` returned 0 → "M88 never reaches that address" | **No such output format existed.** Any address returns 0 |
| Disassembled the ROM to read a branch | At run time that address was **RAM**, holding different bytes |
| Compared two sweeps: "six titles regressed" | A commit **changing the verdict rules** sat between them. Different rulers |
| `reach` said "first reached at f0" → investigated that address | It had picked up a **shared** address inside the region. The real earliest was f336 |
| Chased the top of the exclusive list as "the earliest divergence" | **M88's trace does not record the instruction after an EI** (measured: 22 of 22 missing) |
| The 353-title sweep did not move a line → "this change has no effect" (#22, the VE bit) | **The fingerprint only looks at memory.** `ram[0xE6CD]` plus tvram/gvram non-zero counts cannot see whether the CRTC DMA-fetches them. Measured on screen cells instead: one title's text plane was dead |
| Concluded "EOT is unreachable on this board" (#40, End of Cylinder) | **316 titles reach it, 3,934 times.** M88 raises EOC there too — and `refdrv` had been printing every result phase all along. Nobody looked |

**The common error**: reading "the detector is silent" as "there is nothing wrong."
**When grep returned 0, nobody checked whether that grep could return anything at all.**

The last two were cheap lessons. Both were settled by a **20-line probe that counts how
often the changed line runs** (the `SET INTERRUPT MASK` unmask is reached by 4 titles out
of 353 — and fired in all four; EOT is reached 3,934 times across 316). **Separate "the
change had no effect" from "the changed line never ran" first.**

### What was built in response

- `tools/verdict.js` — judgement rules as pure functions, pinned by tests
- `tools/reach.mjs` + `reachdiff.js` — reachability comparison. **Two bugs in that tool
  itself were found and fixed**
- `test-determinism.mjs` — the contract, tested **without any ROM**

---

## 2. "A test exists" and "a test runs" are different things

The determinism contract broke on main and **stayed broken for two days**.

**A detector existed and was firing.** It had simply never run:

```js
if (!rom) return t.skip('no ROM (bring your own)')   // every case starts like this
```

This repository ships no ROMs. **It was ringing in an empty room.**

The fix was to assemble a few instructions with `z80asm.js` so the contract tests need no
ROM and no disk (`test-determinism.mjs`, `test-contract.mjs`).

> **A contract test must not be skippable. One that can skip, will.**

The same shape appeared elsewhere: the first browser smoke test loaded no ROM, so every
key press hit `if (!machine) return` — it **reported "keys OK" for nine machines while
testing nothing**.

---

## 3. A test can return a comforting lie

- `self-regress.mjs` swapped only `machine88.js`, so a change to `upd765.js` was reported
  as **"no movement"**. Rewritten to compare whole trees
- `test-determinism.mjs` (written during this run) had a **vacuous case**: the
  `JSON.parse(JSON.stringify(...))` meant to "force plain data" actually empties every
  buffer, because **`TypedArray.set()` copies zero elements from the decayed object and
  throws nothing** — and since the comparison came 15 frames later, the emptied snapshot
  re-converged and the case passed. Two mistakes cancelling
- The contract suite itself misfired on a healthy machine because its guard used 16 frames
  and the Game Boy scroll ROM's period is exactly 16

---

## 4. We stopped judging by match rate — but evidence alone is not enough either

**M88 is not a complete gold standard.** Demonstrated:

- **Four titles (Hydlide3, Stercru, starclsr, PRO_FAN) are ones M88 itself fails to boot.**
  `tv2678` is the N88-BASIC opening screen, and M88 is sitting on it. They spent days on
  the divergence list described as *our* fault
- **M88 does not run the real sub ROM.** It NOPs out the motor-settle delay loop
  (`m88ref .../pc88/subsys.cpp`)
- M88's trace omits the instruction after every EI

So the criterion moved from "agreement with M88" to "grounding in primary sources". The
VSYNC phase fix was **kept even though exact matches dropped by one**.

**But evidence alone is not enough.** The seek delay had its formula *and* its unit
confirmed from M88's source, and still cost 8 titles and left 5 unable to boot.

> **"The reasoning is right" and "the implementation is right" are different claims.**
> Changes should land only when **evidence and measurement agree**.

---

## 5. You cannot fix an upper layer while a lower one is wrong

The FDC seek delay was implemented three times and reverted three times. The cause was
**different every time, and every time one layer further down**.

| Attempt | Immediate failure | Real cause |
|---|---|---|
| 1 | No effect at all | The unit was 10× out (`1 tick = 10us`) |
| 2 | Five titles stopped booting | **CPU time was allocated 1.39× wrong** (a boost) |
| 3 | Re-read the same sector forever | The `0300` driver **only looks at EXM**, so it never waits |
| 4 | Infinite loop | **Our MSR is derived; M88's is a state variable** |

The structural difference, found last:

```c
// M88: `status` is an explicit variable, and a write is ignored while RQM is low
void FDC::SetData(uint, uint d) {
    if ((status & (S_RQM | S_DIO)) == S_RQM) { data = d; status &= ~S_RQM; ... }
}
```

Ours derives the MSR from `phase`, so "ignore accesses while RQM is low" cannot be
expressed. **That single point is why the timers do not work.**

The same dependency appeared upstream: a **15× boost added while the frame period was
wrong (60 Hz)** was still there after the period was corrected to 55.71 Hz — and that
boost turned out to be **imitating M88's ROM patch, not any hardware behaviour**.

---

## 6. We read what M88 *computes*, and guessed at what it *shows*

The last three failures reduce to this. The formula (`250 << n`) and the unit were taken
correctly from the source, but **the part the driver actually touches — the MSR and the
data register — was never read.**

On the fourth attempt, reading `FDC::Status()` and `FDC::SetData()` gave the answer in
ten minutes.

> **When mirroring another implementation, read what is externally visible, not what is
> internally computed.** The visible part is what the other side interacts with.

---

## 7. Cross-machine consequences arrive after the machines do

- `upd765.js` is shared by the PC-8801 **and the X68000**. Adding seek timing made the
  X68000's seeks never complete, because its board drives no clock. Made opt-in, on the
  principle that **behaviour is not changed for a machine nobody has measured**
- The missing-framebuffer-in-snapshot bug was found on the Game Boy but was **real in four
  of nine machines**. "NES/MD/Seta are unaffected" was not true
- **Deferring integration lets integration-only holes accumulate.** Collapsing nine
  machines into main surfaced, at once, that **four machines had no ROM picker in the menu
  bar** (so files could not be chosen from the UI at all) and that **PC Engine was missing
  from `package.json` exports entirely**

---

## 8. Honest reporting paid off concretely

Eleven agents ran, each told to **hide nothing that failed**. It mattered:

- The Game Boy agent separated "**four of the five failures were the tests, one was the
  emulator**" — and that one bug **turned out to affect three other machines**
- The browser agent reported that **its own first version was hitting nothing** and
  rewrote it
- The ICE agent could not reach codex, so it **reviewed its own work adversarially and
  found three defects**, two of the "harmless now, certain to bite later" kind

**"What actually happened" is worth more than "it works."** Learning that only three of
nine machines run is a better state than not knowing.

---

## Where things stand (2026-08-13)

```
main: 1030 tests / 1006 pass / 0 fail / 19 skip / 5 todo
M88 parity: 328/353 exact, 333/353 tracking, 0 blank
Machines: 9 (PC-8801/8001, Famicom/FDS, PC Engine, Mega Drive,
          Game Boy, X68000, Seta arcade, PC-9801)
```

**M88's timing model was settled in the last two days of the run:**

| Layer | State |
|---|---|
| Frame period 71,680 cycles (24kHz / 55.71 Hz) | **landed** |
| Port 40h fv15k and b7/b6 | **landed** |
| Sub-ROM motor-delay patch | **landed** (#55) |
| FDC seek timer `400 × tracks + 500` | **landed** (#55, opt-in, PC-8801 only) |
| FDC read timer `250 << n` | **landed** (#55, same) |
| ×15 sub-CPU boost | **deleted** (#57) |

Three layers were blocked by one thing: `upd765.js` derived its MSR, so "ignore accesses
while RQM is low" could not be expressed. **Rewriting the MSR into a state variable landed
all three at once** (#55). M88's `FDC::Status()` is literally `return seekstate | status;` —
a shape that cannot be anything but a state variable.

The fourth layer, the ×15 boost, had to be **deleted rather than kept**. It was patching
over the era when the frame period was 60 Hz (wrong), and what it actually imitated was
**M88's ROM patch, not any hardware**. Worse, once #55 made the FDC park the sub-CPU in
"command phase, RQM low", its trigger condition was finally met and it had grown to
**4–12.7×**  — applied twice over. Deleting it took exact matches from 326 to 328.
**Not one coefficient of the timing model is left.**

The full trail is in [#13](https://github.com/opaopa6969/upd3301/issues/13).
