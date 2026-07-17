**English** · [日本語](./m88-comparison.ja.md)

# upd3301 vs M88 — behavioural comparison

A living record of how `upd3301` compares to **M88** (`bubio/M88M`), produced with
the headless reference oracle in [`../m88ref/`](../m88ref/). The method: boot the
same `.d88` in both, headless, for the same number of frames, and compare a
fingerprint — final `E6CD` (a game-specific flag; for many titles the keyboard-scan
gate), non-zero text-VRAM byte count, and disk-read activity. Divergences are
leads, not verdicts; each is chased down instruction-by-instruction (that is how
the text-window bug was found — see [io-ports](./io-ports.md) and the case notes).

## Snapshot (250 frames, m88204 ROM set)

| Title | M88 E6CD / tvNZ | ours E6CD / tvNZ | note |
|-------|-----------------|------------------|------|
| 軽井沢誘拐案内 | 00 / 3540 | 00 / 3571 | ✔ boots to menu (was broken pre-text-window) |
| Ys1 | 00 / 2678 | fc / 2678 | post-boot phase → #2 (resolved) |
| Hydlide | 00 / 2683 | 00 / 2684 | ✔ matches |
| Xanadu | f9 / 2673 | f9 / 2673 | ✔ matches |
| Romancia | 66 / 2678 | 66 / 2678 | ✔ matches |
| Thexder | 00 / 3416 | 00 / 3416 | ✔ matches |
| Dragon Buster | 00 / 3193 | 00 / 3193 | 2-disk game → #1 (resolved, not a bug) |
| Abyss2 | 00 / 3193 | 01 / 3194 | post-boot phase → #2 (resolved) |
| 177 | 24 / 2679 | 24 / 3523 | post-boot phase → #3 (resolved) |
| Again | ff / 2903 | ff / 3423 | E6CD matches (ff is this title's normal state) |
| Eldrad | ff / 3221 | ff / 3221 | matches |
| D-SIDE | ff / 3220 | ff / 3216 | matches |
| Aggres | ff / 3352 | ff / 3352 | matches |
| Asteka | 00 / 2700 | 00 / 2680 | close |
| Argo | 09 / 2678 | 09 / 2678 | ✔ matches |

Most titles now land on M88's `E6CD`/tvram state — the text-window fix (port 70h)
was the big lever. `E6CD == 0xff` is **not** universally "stuck": several titles
(Again/Eldrad/D-SIDE/Aggres) hold it at 0xff in M88 too.

### Caveats when reading this table
- **Read counts aren't apples-to-apples yet.** Our probe counts `READ DATA`
  **commands** (FDC op 0x06); refdrv's `g_rdN` counts `FDC::ReadData`
  invocations, which may be per-sector. Treat raw counts as a rough progress
  signal, not an equality test, until both count the same event.
- **Matching result headers ≠ matching payload.** A run of identical `C/H/R/N`
  result bytes says the *addressing* agreed, not that the transferred sector
  **data** did. When chasing a divergence, dump and diff the payload bytes per
  read on both sides (hook the byte the FDC returns), not just the 7-byte result
  header — otherwise the measuring instrument hides a data difference. *(Not the
  cause for Dragon Buster — that was the two-disk harness artifact — but the
  right discipline for the next one. Credit: codex.)*

## Known divergences (leads to chase)

1. **Dragon Buster — RESOLVED: 2-disk game, sweep only mounted one.**
   `Dragonb.d88` contains **two images — "DISK A" and "DISK B"**. The title reads
   DISK B from **drive 1 (unit 1)**; with only DISK A mounted, that read hits an
   empty drive → `ST0=0x45` (`_rwError`, no disk on unit 1) and the title spins
   SEEK→SENSE→READ forever. Mount both (DISK A→drive 0, DISK B→drive 1) and it's
   fine: **reads drop 22265 → 21**, no loop. The real front-end
   (`demo/machine.html` `ingestDisks`) already auto-assigns image0→drive0,
   image1→drive1, so two-disk games "just work" in the UI — it was the
   comparison *harness* that mounted a single image. No emulator bug. *(Credit:
   codex flagged the two-drive hypothesis.)* **Fix applied to the sweep method
   below.**
2. **Ys1 / Abyss2 — `E6CD` differs at f250 — NOT A BUG (post-boot phase).**
   E6CD is `0` for ~200 frames in both (the title boots and reaches gameplay),
   then transitions to a title-specific value (Ys1→fc, Abyss2→1) at a slightly
   different frame than M88. The f250 snapshot just caught the two at different
   points of *post-boot* execution — a timing/progress phase, not a fault.
   *(Resolved.)*
3. **177 — tvNZ higher than M88 — NOT A BUG (post-boot phase).** Same story:
   E6CD `0` early, then `0x24`; the title runs. tvNZ differs because the two are
   a few frames apart in gameplay. *(Resolved.)*
4. **Undocumented Z80 flags (X/Y, bits 3/5) — implemented, not a systematic root.**
   `z80.js` sets F3/F5 from the result on the common ALU ops (`_add/_sub/_inc/
   _dec` and via the `SZP` table for AND/OR/XOR). The one observed X/Y mismatch
   during 軽井沢's load was an operand difference on a harmless path, not a flag
   bug. Known remaining gap: **block-IO (LDIR/CPIR…) undocumented flags are
   approximate** — audit if a title ever depends on them. *(Low priority.)*

Net: after the sweep and follow-ups, **no open behavioural divergence remains** in
this set. Titles match M88, differ only in post-boot timing phase, or (Dragon
Buster) were a harness artifact. The text-window fix was the one real bug.

## Batch sweep (353 titles, 250 frames)

`tools/batch-compare.mjs` runs the whole `.d88` collection through both
emulators and diffs the E6CD/tvramNZ fingerprint, then splits mismatches by
whether the screen-fill (`tvramNZ`) agrees — a single-frame E6CD snapshot is
noisy because a game-specific flag byte is caught at a different animation
frame in each emulator, so "boots fine but E6CD differs" is the common,
*non-bug* case.

| Category | Count | % | Meaning |
|----------|-------|---|---------|
| exact E6CD match | 304 | 86% | same fingerprint at 250f |
| phase noise (both boot, tvNZ within 15%) | 31 | 9% | game runs in both; snapshot caught different frames — **not a bug** |
| real divergence lead (tvNZ differs >15%) | 16 | 4.5% | screen content genuinely differs — worth chasing |
| blank/early (both tvNZ<200) | 1 | — | CHOPLIFT (needs keypress / more frames) |
| refdrv error | 1 | — | M88 itself failed to run リトルコンピューターピープル |

**→ 335/353 (95%) track M88** at this raw 250f snapshot (exact + phase noise) —
**but that undercounts.** The 48 "mismatches" are dominated by two *metric*
artifacts (boot-speed and the display mask, see below); comparing at a
**converged** frame collapses them to **2 genuine divergences → ~99%
(≈351/353)**. The 250f snapshot is a fast first pass; the converged number is
the real one.

**Reading for the cycle-accuracy question:** ~99% of titles reach M88's exact
state once boot-speed skew is removed — the frame-stepped core tracks M88
almost everywhere. The two genuine misses are title-specific (a stall and a
crash), **not** a systematic timing wall, so chase them individually rather
than commit to a cycle-exact rewrite (which risks the working ~99%).

### The 16 "leads" were mostly a metric artifact — real divergences: **2**

Chasing the leads uncovered **two flaws in the fixed-250f metric itself**, and
correcting them collapses 16 leads to **2 genuine divergences**:

1. **Boot speed.** Our emulator often boots *faster* than M88, so at 250f we're
   already on the title screen while M88 is mid-load. Comparing both at a
   **converged** frame (1500f) instead shows the "frozen" titles reach the
   **same** state — they were never diverging. Six leads dissolve this way:
   Skyfox (both →ff/643), Snatcher (→98/1173), Rayieza (→00/3202), Deringer
   (→e0/3653), Hajya (→00/3195), ROLLER (→32/2133). *(An earlier bit-3-of-40h
   hypothesis for the "shared port-40h root" was tested and disproved — our
   port 40h already matches M88's `In40 = port40 & 0x2a`; forcing b3 broke
   auto-boot. Reverted.)*
2. **Display mask.** `tvramNZ` counts raw text RAM even when the text plane is
   **disabled** (port 53h b0=1). ﾄﾘﾄｰﾝ and tennis are graphics-only games that
   turn the text plane off; the stale bytes left in text RAM inflate tvNZ to
   4096 but are **never shown**. With text off these are *not* visual
   divergences. (batch-compare now zeroes tvNZ when the text plane is off.)

Plus four that were simply still animating at 250f (Stercru, starclsr,
キャッスルエクセレント, ロリータシンドローム).

**What actually remains (ours converges to a genuinely different state than
M88 at 1500f):**

| Title | ours@1500 | M88@1500 | note |
|-------|-----------|----------|------|
| Makaimura | 07/1987 | 09/3126 | ours stalls at a less-complete screen (text on) |
| GAZZEL | 00/2048 | b7/3077 | ours runs off into low memory (PC 0018-0036) — likely a crash |

So at a **converged** comparison the real match rate is **~99% (≈351/353)**,
not the 86% the raw 250f snapshot suggested. This is a strong answer to the
cycle-accuracy question: the frame-stepped core tracks M88 almost everywhere;
the two genuine misses are title-specific (a stall and a crash), not a timing
wall — chase them individually, don't rewrite the core.

**Harness gotcha (load-bearing):** our side must be built with the four N88
extension ROMs (`n88_0..3.rom`) as `ext`, mapped at 6000-7FFF — that
extension ROM *is* N88-DISK-BASIC. Omit it and the machine drops to the
N88-BASIC prompt and **no game boots**, yet every title falsely "matches" at
E6CD=00 (both idle). The first run of this sweep hit exactly that and
reported a meaningless 83%; with `ext` wired the real picture above emerged.

## How to reproduce / extend

```sh
# M88 side (build once):
m88ref/build.sh
m88ref/_m88m_build/M88M/refdrv <romDir> <disk.d88> 250   # prints final E6CD, tvramNZ, g_rdN

# whole collection, both emulators, categorised:
node tools/batch-compare.mjs <romDir> <diskDir> 250

# ours side (what batch-compare does per title): a Node harness —
#   new Pc8801Machine({main, ext, sub, mode:'n88'}) → insertDisk → stepFrame ×250,
#   then read m.ram[0xe6cd], count non-zero m.tvram[], hook globalThis.__fdcCmd.
# IMPORTANT #1: `ext` = the four N88 extension ROMs concatenated
#   (n88_0..3.rom at i*0x2000, mapped 6000-7FFF). That ROM *is* N88-DISK-BASIC;
#   WITHOUT it no disk boots and every title falsely "matches" at E6CD=00.
# IMPORTANT #2: mount *every* image of a multi-disk .d88 —
#   const d = parseD88All(bytes); d.forEach((img,u) => u<2 && m.insertDisk(u,img));
# A two-disk title with only image 0 mounted will loop on an empty drive 1
# (that was the Dragon Buster "divergence").
```
See [`../m88ref/README.md`](../m88ref/README.md) for the full method and a
paste-ready sub-agent prompt. Add rows/divergences here as they're found.
