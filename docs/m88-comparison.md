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
2. **Ys1 / Abyss2 — `E6CD` differs at f250 — ~~not a bug (post-boot phase)~~ → for Ys1
   this was a MISDIAGNOSIS.** The MT fix (2026-08-08) moved Ys1 from `fc/1425` to
   `00/2678`, an **exact match with M88** (YS/YS2/Xak2 likewise). It was a real bug,
   not a phase difference. Original note follows:**
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

## Correction (2026-08-08): "low-address execution" is not a crash signal

The two remaining divergences were characterised with `tools/crash-trace.mjs`,
whose verdict is "hot PCs below 0x1000 == executing garbage == CRASH". That
premise is wrong, and it mis-described both titles:

- **Xanadu — a title that matches M88 exactly — runs 100% of its frames below
  0x1000** once it is playing (`tools/life-scan.mjs Xanadu.d88 400`). Low RAM is
  where several titles legitimately put their main loop. The region says nothing.
- **Makaimura does not settle in low memory at all.** It executes low addresses
  only transiently around f100-f200 (while loading), then from ~f300 onward runs
  entirely in 8000-bfff. `crash-trace` happened to sample the transient window.

What actually distinguishes a dead title is **how many distinct PCs it touches**
and **whether it still talks to devices**:

| title | distinct PCs / 2 frames | I/O while spinning | verdict |
|-------|------------------------|--------------------|---------|
| Xanadu (healthy) | ~544 | yes | tight loop |
| Makaimura | 5972 | **none at all** | runaway |

Makaimura marches *linearly* through a repeating 12-byte pattern (graphics data
disassembling as `DAA / NOP / LD (8001h),A / SUB E / ADD A,B …`), with `iff1=false`,
so it can never be rescued by an interrupt. It is a runaway, not a wait — which
means the bug is **upstream**: something corrupted memory or the return stack
earlier. Chasing the loop itself is chasing the corpse.

One upstream link is already established (`tools/watch-write.mjs`): at f80 the
bytes `cd ff 00` (= `CALL 00ff`) are written into `c444` by code at **`fccf`,
which is inside the F000-FFFF text-VRAM window** — i.e. the CPU was already
executing from the wrong side of that mapping. M88 gates the same window on
`!(port32 & 0x10) && (sw31 & 0x40)` (`memory.cpp:836`, `UpdateF0`), where `sw31`
is latched from input port 31h at reset; ours uses `dipsw[1] & 0x40`
(`machine88.js` `_tvramOn`). Whether those two agree at that instant is the
open question. Forcing the routing either way does not change the outcome, so
the mapping alone is not the whole story.

**Next step (issue #13):** `m88ref/refdrv.cpp` already contains a MAIN-CPU PC
trace (`g_pcHook`/`pcLog`), but it is armed at "the 6th FDC result" and writes to
a hardcoded path from a dead session. Generalise it (env-configurable path, and
arm by frame), dump the same trace from our side, and diff — the first divergent
instruction is the answer, and no heuristic is needed.

### Tools added for this (all under `tools/`)

| tool | question it answers |
|------|--------------------|
| `watch-write.mjs <disk> <addr[-end]> [frames]` | who wrote these bytes, from which PC, with what banking |
| `life-scan.mjs <disk> [last] [tvram] [step]` | when did execution move, and did it ever recover |
| `loop-profile.mjs <disk> [settle]` | is it waiting on a device, or running away |

Note: these need **node ≥ 20** (the system `node` here is v12 and fails on `??`).

## Resolved (2026-08-08): both remaining divergences were one missing µPD765 feature

**Makaimura and GAZZEL were the same bug, and both now match M88 exactly.**

| title | before | after | M88@1500 |
|---|---|---|---|
| Makaimura | 07/1987 | **09/3126** | 09/3126 ✔ |
| GAZZEL | 00/2048 | **b7/3077** | b7/3077 ✔ |

Bit 7 of a READ command is **MT (multi-track)**. When it is set, finishing the
EOT sector on head 0 does *not* end the command: the FDC crosses to **head 1 of
the same cylinder and continues at R=1**. A 2D loader uses this to pull both
sides — 32 sectors, 8192 bytes — in a single command.

We stopped at EOT, so we delivered **half** the requested data (16 sectors,
4096 bytes) and the caller's buffer kept whatever the *previous* transfer left
there. Makaimura decrypted that stale sector (C39 H1 R2) as its key table,
then executed the resulting garbage.

The result phase needed the same correction: under MT the two sides count as one
cylinder, so C←C+1, H←0, R←1 happens only after head 1's EOT.

### What found it, and what hid it

- **Found it:** putting the byte streams side by side — what the sub read, and
  what main received (`tools/watch-read.mjs`, `M88_RWATCH`). The first 2688 bytes
  matched exactly and only the last 2048 (one read's worth) differed, which
  pointed straight at the FDC. Then identifying the delivered sector by searching
  the disk image for its content settled it: we were serving C39 H1 R2 — the
  previous read — while M88 served C11 H1 R1.
- **Hid it:** the FDC's command *and result phase* agreed byte for byte
  (`C12 H0 R1 N1` on both sides) while the payload was half wrong. This is exactly
  the "matching result header ≠ matching payload" caveat already recorded above
  (credit: codex). A matching header is not evidence.

## Harness defect (2026-08-08): the two emulators were running different ROM revisions

M88 prefers a **combined image** and only falls back to the separate files:

- `Memory::LoadROM()` — tries `pc88.rom`, else `n88.rom` / `n88_0..3.rom`
- `SubSystem::LoadROM()` — tries `PC88.ROM` at **0x14000**, else `DISK.ROM`

The m88204 set ships *both*, and `/mnt/c` is case-insensitive, so `PC88.ROM`
resolves to `Pc88.rom`. M88 ran the combined image while our harness read the
separate files — and they are not the same revision:

| ROM | bytes differing |
|---|---|
| main N88 | 107 / 32768 |
| N88 extension | 141 / 32768 |
| sub (DISK) | **2021 / 8192** |

Every comparison before this is contaminated by that. `tools/romset.mjs` loads a
ROM directory in M88's own order — **use it in any harness from now on**.

### M88 is not faithful everywhere — do not take the gold at face value

`SubSystem::PatchROM()` rewrites the sub ROM: it NOPs the `CALL 02B4h` at `00fb`
and `0105` — the 65536-iteration motor-spin-up delay. The original comment says
it just makes booting slower if you leave it in. **We are the faithful one
there**, and M88 is deliberately not. That is why our sub-CPU trace showed us
spinning `02bb` 262144 times while M88 never touched it: not a bug. (Applying
M88's patch on our side changes neither Makaimura nor GAZZEL — measured.)

## Triage of the remaining 13 divergences (2026-08-09, after the MT/ST0 fixes and ROM unification)

The 1500f sweep with the GVRAM fingerprint: **exact 326/353 (92%), tracking 337/353 (95%)**.
The 13 remaining leads, split with `tools/loop-profile.mjs`:

### A. Polling OPN status + the joystick (possibly just waiting for input)

| title | M88 | ours |
|---|---|---|
| JIKO_PZL | 00/gv35388 | ff/gv2040 |
| FIREHAWK | 00/gv847 | ff/gv305 |

Both poll `OUT 44,0e` → `IN 45` (the YM2203 general-purpose port A, which carries the
joystick on a PC-8801) and `IN 44` (OPN status) at high frequency — FIREHAWK 238 times in
two frames. **Both sit at E6CD=0xff**, and as recorded above `ff` is not necessarily
"stuck". CHOPLIFT was already unclassifiable for wanting a keypress, so **rule out
input-wait first**: inject input, or trace whether M88 performs the same poll.

### B. Waiting on an interrupt that cannot arrive (a real hang)

| title | M88 | ours |
|---|---|---|
| harakiri | 00/tv3195 | aa/tv800 |

**No I/O at all** (zero IN, zero OUT), 53 distinct PCs, `iff1=false` with `pending=06`
(sources 1 and 2 pending, E6mask=03). The CPU sits with interrupts disabled waiting on a
condition only an interrupt could change. **Suspect interrupt delivery or the E4h/E6h mask
handling.**

### C. Unclassified (screen content differs; symptom not yet investigated)

OHOTUKU / 北海道連鎖殺人事件 (same game, two files), Hydlide3, volguard, Yaksa, starclsr,
Stercru, PRO_FAN, Seena, うる星やつらラブリーチェイサー.

**Hydlide3 shows only one FDC result in 400 frames on the M88 side** (ours shows nine or
more), so M88 itself may not be booting it — treat as a case where the gold is unusable.

### Working discipline established so far

1. **Judge at a converged frame.** A match at a fixed 400f can be two machines sitting in
   the same *intermediate* state (this is how iteration 6's scorecard mis-scored a Ys1
   regression as a win).
2. **Suspect the metric before the emulator.** Three measuring-instrument defects so far:
   the fixed 250f snapshot, the display mask, and text-off graphics.
3. **The address region says nothing about health.** What works is the count of distinct
   PCs and whether the machine still touches I/O.
4. **A matching result header is not a matching payload.** The MT bug hid behind exactly that.
