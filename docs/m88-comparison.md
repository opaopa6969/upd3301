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

### Caveat: read counts aren't apples-to-apples yet
Our probe counts `READ DATA` **commands** (FDC op 0x06); refdrv's `g_rdN` counts
`FDC::ReadData` invocations, which may be per-sector. Treat raw read counts as a
rough progress signal, not an equality test, until both count the same event.

## Known divergences (leads to chase)

1. **Dragon Buster — diverges to cyl14/unit1 after read #8, then loops.**
   The first **8 FDC results match M88 exactly** (C0R2, C0R4, C1R1, C0H1R16,
   C2R1, C1H1R7, C2H1R1, C2H0R3) — so the disk transfer through read #8 is
   faithful. From an apparently-equal state, M88 stays in cyl0–2 while ours
   seeks **cyl14 h1 r4 on unit 1**, where the read returns `ST0=0x45` (abnormal
   termination, US=1) and the title retries the SEEK→SENSE→READ forever
   (~17,000× / 250 frames). Root cause is a byte or computation that differs
   *after* read #8 despite matching results — a Karuizawa-class trace-diff
   (arm both traces at read #8, find the first divergent instruction). The
   `unit 1` target is suspicious (no disk there); worth checking whether the
   drive-select / result-ID feeds a stale unit number. **Open.**
2. **Ys1 / Abyss2 — `E6CD` differs at f250** (fc/01 vs 00). Text-VRAM matches, so
   the picture is likely right; the flag may be a timing phase or a real
   keyboard-gate difference. Verify with a longer run and a screen dump.
3. **177 — tvNZ higher than M88** (3523 vs 2679) with matching `E6CD`. Could be a
   text-attribute or fill difference; visual check needed.
4. **Undocumented Z80 flags (X/Y, bits 3/5).** At an identical CPU state during
   軽井沢's load, ours and M88 agreed on every documented flag but differed on the
   undocumented X/Y bits. Harmless for that title (it booted), but a real Z80
   fidelity gap worth auditing — some protections test them via side channels.

## How to reproduce / extend

```sh
# M88 side (build once):
m88ref/build.sh
m88ref/_m88m_build/M88M/refdrv <romDir> <disk.d88> 250   # prints final E6CD, tvramNZ, g_rdN

# ours side: a Node harness — new Pc8801Machine → insertDisk → stepFrame ×250,
# then read m.ram[0xe6cd], count non-zero m.tvram[], hook globalThis.__fdcCmd.
```
See [`../m88ref/README.md`](../m88ref/README.md) for the full method and a
paste-ready sub-agent prompt. Add rows/divergences here as they're found.
