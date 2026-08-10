**English** · [日本語](./2026-08-10-independent-review.ja.md)

# Independent review (2026-08-10) — the state of things after two days of autonomous work

After the autonomous run of 2026-08-08..10 ([#32](https://github.com/opaopa6969/upd3301/issues/32) /
[#33](https://github.com/opaopa6969/upd3301/issues/33) /
[#34](https://github.com/opaopa6969/upd3301/issues/34)), a **different model from the one that did
the work** was asked to review it, explicitly to *challenge* the worker's own assessment rather
than confirm it.

---

## P0: the determinism contract was broken on main (fixed in `82da81c`)

**The heaviest finding, and one that appears nowhere in the worker's self-assessment.**

`bd06d2f` ("make 8255 access a synchronisation point with the sub CPU", #32 iteration 3) introduced
the sub-CPU clock `_subMark` / `_subDebt` in `_syncSub()` — and put neither into `snapshot()` or
`restore()`. After a restore, the sub carries debt from the *pre-branch* timeline, so it runs a
different number of cycles and **the machine lands somewhere else on identical input**.

```
node --test   313 tests, 1 failing (test-snapshot.mjs:63
              "pc8801: snapshot/restore with sub board and mounted disk")
```

Failing on every commit from `bd06d2f` to HEAD, and PR #35 merged that state to main. Rewind, the
jog shuttle and the ICE's branching tree all stand on this contract. `docs/ice-design.md` was
meanwhile still claiming "verified by test-snapshot.mjs" — **false at the time it was read**.

### Why two days passed without noticing

Every iteration's regression check was `node test.mjs` (63 CRTC tests) rather than `node --test`
(313). test-snapshot.mjs needs ROMs, but this machine *has* ROMs — **the detector existed and was
firing correctly; it simply was not in the net.**

### This is the strongest rebuttal to the self-assessment

The worker summarised the project as "*the tools that build are good; the tools that measure are
weak*". The review's counter:

> What is weak is not the tools but the **discipline**. The three metric mistakes (fixed 250f,
> display mask, GVRAM) are evidence that the loop of *doubting a metric, fixing it, and writing
> the lesson down* works. Shipping a broken main because an existing determinism test was left out
> of the regression net is a different kind of failure — one no additional metric can prevent —
> and the summary misses it entirely. The remedy is not "a better metric" but CI and a fixed test
> set.

---

## By topic

### Was going from one machine to six the right call?

**Technically yes. But the expansion is not finished, and what is piling up is not machines — it is
integration debt.**

Evidence it was right:

- The reuse claim held. `m68000.js` was verified against SingleStepTests at 261,894/261,894 (state,
  excluding address-error cases) and went into **both Mega Drive and X68000 without a single
  change**. `upd765.js` likewise went into X68000 untouched. The premise that "adding a machine
  costs only its chips" was demonstrated, not assumed.
- **Some machines are now better verified than the PC-8801.** The NES matches all 8991 nestest log
  lines and passes `cpu_interrupts_v2` 5/5 — a far stronger oracle than M88, which is itself
  sometimes wrong.
- The ceiling on depth-first PC-8801 work was already visible: the remaining 13 titles cost four
  iterations on JIKO_PZL and Yaksa without reaching a root cause. **The competing hypothesis —
  "finishing the PC-8801 would have been worth more" — is not supported by that curve.**

Where it is fragile:

1. **Expansion that is not integrated is not expansion.** Five branches, ~73,000 lines, none merged,
   and **every one of them independently modified `demo/machine.html`** (+135 to +451 lines each).
   Conflict cost compounds with delay. **To anyone reading main, this is still a single-machine
   emulator.**
2. **Verification quality is badly asymmetric.** NES (strong) / X68000 (medium — but most of its
   "ok" results are a Human68k prompt, not gameplay) / Mega Drive (medium, zero commercial ROMs) /
   **PC Engine (thin — 1169 ROMs available and no sweep numbers reported) / PC-9801 (thinnest — the
   ITF ROM on hand is for a 386 and will not boot on a V30 core)**. The "spread too thin" criticism
   does not land on the cores; **it does land on PCE and PC-98**.
3. **Seta (#36) is an issue with no content behind it.** Five machines should reach main before a
   seventh is started.

### The accumulation of unverified work

- **No browser rendering has been looked at by a human, on any of the six machines.** Even the
  PC-8801 result is "the headless fingerprint matches M88", not "the picture is right". `crt.js` /
  `tube.js` — the product's showpiece — has never been exercised against the six new video outputs.
- **No audio has been heard on any machine.**
- **"ok" means something different per machine** (X68 = boot prompt, MD = homebrew draws, NES = a
  test ROM's verdict byte). The numbers line up in a table while measuring different depths.
- The thickest unverified layer is actually the **host** (`demo/machine.html`).

### A lost record (separate issue)

The Mega Drive completion report on #34 was posted with a body consisting of a **file path string**
(`/tmp/.../issue34.md`) instead of its contents. The real 93-line report — including the DMA
state-machine insight and the "zero commercial ROMs" full-disk scan — is still in `/tmp`, which
**does not survive a reboot**. A quiet single point of failure in the practice of using issues as
the investigation record.

### What to cut

1. **Retire `tools/crash-trace.mjs`** (absorb into the #37 rework and delete). Both of its premises
   were recorded as wrong by the worker. **A diagnostic with two false-positive incidents is itself
   the seed of the next misdiagnosis.**
2. **Freeze Seta (#36)** until integration and the determinism fix are done.
3. **Sequence #38 (RNG) explicitly behind #37 (headless ICE)** — otherwise the "reinvented ICE
   features as one-off scripts" failure repeats.
4. **Mark the stale conclusions in `docs/m88-comparison.md`.** "No behavioural divergence remains"
   and "~99% at convergence" are still live near the top while line 281 onward corrects them to
   92-93%. **A document whose headline contradicts its body lies to anyone reading top-down.**
5. **Floating files in the shared tree** (`.idea/` untracked, five `xterm/` files uncommitted).

### Documentation

- **The bilingual rule is genuinely kept** — all 11 doc pairs exist in both languages, committed the
  same day.
- Rot in the details: `README.md` claims "299 cases" against a measured 313; **the root uses
  `README.md` = Japanese and `README.en.md` = English, the reverse of `docs/`**; `ice-design.md`'s
  "verified by" claim was false.

### Could someone else pick this up? (the first hour)

- **First trap**: the system `node` is v12 and every entry point dies. **The v24 requirement is
  written nowhere in the repository** — there is not even an `engines` field.
- **Second trap**: ROM and disk paths are hardcoded to *this machine* as defaults in
  `tools/self-regress.mjs` and others.
- **Worst trap**: a newcomer who supplies ROMs and runs `node --test` sees **one red test**, with no
  CI to tell them whether it is known or their own doing.
- **What is invisible**: all six-machine work lives in branches and issue comments. Main's README is
  still the μPD3301 / PC-8001 story.

---

## Where the review disagrees with the self-assessment

1. "The measuring tools are weak" → **shallow diagnosis; the weakness is discipline** (see P0).
2. "The building tools are good" → **half of that is unproven self-praise.** z80anal's fixed-point
   propagation and the stone tools' re-assembly acceptance test are well designed, but **no record
   shows either being decisive during the 353-title sweep**. What actually did the work was
   pc-trace / trace-diff / watch-read — the headless reinvention of ICE features.
3. **"The ICE was locked in the browser" is weighted far too lightly.** The whole two-day battlefield
   (sub CPU ↔ 8255 ↔ FDC) is precisely what the ICE was designed for. #37 belongs above #38/#39, not
   beside them.
4. **The self-doubt about expanding is excessive.** What deserves doubt is the *aftermath*, not the
   decision.

---

## The review's own honest scope

The reviewer actually ran `node --test` (current HEAD, nine prior commits, and the pcengine/pc9801
branches) and read the git topology and every issue. It **did not evaluate the browser demo, the
`crt.js`/`tube.js` picture quality, or z80anal and the stone tools in action**. Its objection to
"the building tools are good" is therefore **"unproven", not "untrue"**.

---

## Status

| Proposal | State |
|---|---|
| P0: put `_subMark`/`_subDebt` in the snapshot | **Fixed in `82da81c`** (313 pass) |
| P0: a ROM-free determinism contract test | not started |
| P0: CI (`node --test`, pinned node 24) | not started (#29) |
| P0.5: recover the Mega Drive report from `/tmp` into #34 | not started |
| P1: merge the five machine branches into main | not started |
| P1: correct the stale headline in `m88-comparison.md` | not started |
| P1: document the node >= 24 requirement | not started |
| P2: #37 headless ICE; retire crash-trace | not started |
| P2: a cross-machine verification-depth table | not started |
