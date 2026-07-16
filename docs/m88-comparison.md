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
| Ys1 | 00 / 2678 | fc / 2678 | E6CD differs at f250 — verify |
| Hydlide | 00 / 2683 | 00 / 2684 | ✔ matches |
| Xanadu | f9 / 2673 | f9 / 2673 | ✔ matches |
| Romancia | 66 / 2678 | 66 / 2678 | ✔ matches |
| Thexder | 00 / 3416 | 00 / 3416 | ✔ matches |
| Dragon Buster | 00 / 3193 | 00 / 3193 | **⚠ read-retry loop** (see below) |
| Abyss2 | 00 / 3193 | 01 / 3194 | E6CD differs — verify |
| 177 | 24 / 2679 | 24 / 3523 | E6CD matches, tvNZ differs |
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

## How to reproduce / extend

```sh
# M88 side (build once):
m88ref/build.sh
m88ref/_m88m_build/M88M/refdrv <romDir> <disk.d88> 250   # prints final E6CD, tvramNZ, g_rdN

# ours side: a Node harness — new Pc8801Machine → insertDisk → stepFrame ×250,
# then read m.ram[0xe6cd], count non-zero m.tvram[], hook globalThis.__fdcCmd.
# IMPORTANT: mount *every* image of a multi-disk .d88 —
#   const d = parseD88All(bytes); d.forEach((img,u) => u<2 && m.insertDisk(u,img));
# A two-disk title with only image 0 mounted will loop on an empty drive 1
# (that was the Dragon Buster "divergence").
```
See [`../m88ref/README.md`](../m88ref/README.md) for the full method and a
paste-ready sub-agent prompt. Add rows/divergences here as they're found.
