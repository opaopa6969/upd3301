**English** · [日本語](./2026-08-10-fdc-adversarial-review.ja.md)

# Adversarial review (2026-08-10) — the µPD765 and VRTC work against primary sources

A different model (codex) was asked to **refute** the FDC, sub-CPU and VRTC changes made during the
autonomous run of 2026-08-08..10 ([#32](https://github.com/opaopa6969/upd3301/issues/32)).

The brief forbade citing M88 as evidence — **M88 is what is under test** (its
`SubSystem::PatchROM()` was already found rewriting the sub ROM to skip the motor spin-up delay).
The review worked from the Intel 8272 specification, the µPD765A/B datasheets and MAME's
`upd765.cpp` / `upd3301.cpp` / `pc8801.cpp`, and exercised `upd765.js` directly to capture real
result bytes.

**A higher match rate against 353 titles is not evidence of hardware fidelity.** Read accordingly.

---

## Refuted

### 1. A missing next sector before EOT ends normally instead of raising ND [high]

`upd765.js:319`. When `_idIncrement()` says continue but `findSector()` fails, control falls into
`_endRw(0,0,0)`. The specification calls for an abnormal termination: **ST0.IC=01, ST1.ND=1**.

Measured: an MT read where side 1 / R=1 does not exist returned `00 00 00 00 01 01 00` — the normal
result.

### 2. Reaching EOT without TC is treated as a normal termination [high]

`upd765.js:289`, `upd765.js:329`. A µPD765 transfer is expected to end on TC; running past the last
sector without one is **End of Cylinder (abnormal ST0 plus ST1.EN=0x80)**. Both the MT=0 case and
the completion of side 1 under MT currently end normally.

**Worse, `test-fdd.mjs:77` (expectation at line 91) pins this out-of-spec behaviour as a test.**

### 3. TC jumps straight to the result phase, skipping CRC and the result-ID update [high]

`upd765.js:117`. After TC a READ still reads to the end of the sector and checks CRC; a WRITE fills
the remainder with 00. The result CHRN should follow Intel's Table 4; instead the sector ID at the
moment of TC is returned as-is. `test-fdd.mjs:105` only checks that the result phase was entered.

### 4. `m.stHd` is not "the head at interrupt time" [high]

`upd765.js:318`, `upd765.js:344`. ST0.HD is specified as **the head state at the interrupt**, not
the head of the last completed sector.

Measured: issue TC after the first byte of side 1 and the result reports **H=1 while ST0.HD=0**. The
ND path likewise keeps a stale side 0.

→ **The conclusion — that ST0 and the result H must be separated — stands. The defect is the
implementation: a persistent `m.stHd`.**

### 5. Multi-sector and MT are entirely missing for WRITE DATA / WRITE DELETED DATA [high]

`upd765.js:259`, `upd765.js:303`. `_startWrite()` never stores MT in `_multi`, and `_execDone()`
excludes writes via `!this.execWrite`. One sector is written and the command ends normally. Intel
specifies MT/EN/ND and the result ID for WRITE identically to READ.

### 6. READ DIAGNOSTIC / READ A TRACK inherit `_idIncrement()`'s side effects [high]

`upd765.js:241`, `upd765.js:309`. The specification reads EOT sectors from the index hole, comparing
each ID against the IDR, with **MT and SK not permitted**. The implementation concatenates every
sector on the physical track unconditionally and puts the starting R into `_multi.eot`, so EOT hits
immediately.

**"Align the result ID with IDIncrement" reached all the way into MT=0 READ A TRACK.**

### 7. "`phase !== 'execute'` means waiting on mechanics" does not hold in the code [high]

`machine88.js:653`, `pc80s31.js:49`. The motor output is only stored (`this.motor = v`) — it drives
neither READY nor the index — SEEK completes instantly, and READ DATA enters `execute` without head
load, settling or an ID search. The classification does not describe any real FDC state.

> **The "price of not modelling the drive motor" has the causality backwards.** Not modelling the
> motor makes the drive ready *earlier* than real hardware, which is no physical reason to also run
> the CPU 16× faster.

Suspected to be a compatibility hack of the same family as M88's ROM patch [medium].

**A concrete bug found alongside**: `_pioPoll` (`machine88.js:449`) does not distinguish port
numbers and is never reset on a write, so an unchanged value read from a *different* port in
FCh-FFh still counts as polling.

### 8. The absolute VRTC period is not derived from the CRTC [high]

`machine88.js:379`, `machine88.js:714`. Only rows/vblankRows feed the ratio; the frame time is a
fixed `frameHz=60`. In reality:

- VRTC = `vblankRows × linesPerChar / fH`
- frame = `(rows+vblankRows) × linesPerChar / fH`
- `fH` depends on the pixel clock and `(cols+hblankChars)`

Measured: after ROM init the CRTC is programmed 80 cols / 20 rows / 10 rasters / 6 blank rows / 32
blank chars → **about 61.46 Hz with a 3.76 ms VRTC** on a 15 kHz monitor, against 3.85 ms at a fixed
60 Hz. MAME likewise gives 61.462 Hz (15k, 20 rows) and 56.424 Hz (24k), varying to about 68 Hz per
title.

### 9. The polled VRTC and the VSYNC interrupt are about one blank period apart [high]

`machine88.js:393`, `machine88.js:682`, `index.js:289`. Port 40h's VRTC goes high at the end of the
display period, while the VSYNC interrupt fires in `endFrame()` — at the end of blanking. The
µPD3301's end-of-screen interrupt coincides with the VRTC rising edge. At 20+6 rows that is a
**~3.8 ms** discrepancy.

---

## Not refuted

- **The side 0 → side 1 continuation under MT itself** — as specified, not an M88 quirk.
- **Not advancing to the next cylinder when MT=1 starts on HD=1** — correct; MT covers both sides of
  one cylinder. The separate question is the ending: on TC, Table 4 gives C+1 / H flipped / R=1;
  without TC it should be an EOC abnormal termination (MAME leaves C alone and flips H, R=1). **That
  it must be abnormal is [high]; the exact CHRN is [medium].**
- **The intent of separating ST0 from the result H** — sound; the implementation is the defect.
- **Making 8255 access a synchronisation point** — not refuted, but its description should be
  corrected: it is **a CPU scheduler granularity correction, not motor modelling**. Measured, the
  main and sub ROMs use control word 0x91 plus BSR — a **Mode 0 software handshake through port C**,
  not the Mode 1/2 IBF/OBF/INTR handshake.
- **The `rows/(rows+vblankRows)` ratio itself** — not refuted; the µPD3301 counts in character rows,
  so `linesPerChar` cancels.

---

## Additional oversights surfaced

- **When SK skips the first sector, only `sec` advances to R+1 while `m.r` keeps the old value**
  (`upd765.js:225`), so completion searches R+1 again and **transfers the same sector twice**. Later
  sectors never test the deleted/normal mark at all.
- **A middle sector's CRC/status is lost** the moment the next sector is assigned to `m.sec`; only
  the final sector's status reaches `_endRw()`.
- **`d88.js:100` matches only the physical track plus R/N**, ignoring the ID field's C/H, rotational
  order and duplicate IDs. On protected disks that matters more than MT does.
- MT=0 READ DATA also runs through the new `_idIncrement()`, so it is inside the blast radius of the
  EOT problem. READ ID and FORMAT take other paths and were confirmed unaffected.
- **Because the next interrupt is raised inside the same JS call as the data-register read, an
  overrun cannot structurally occur.**

---

## Proposed regression matrix

Check **ST0/ST1/ST2/C/H/R/N and the physical side actually selected** — not a screen fingerprint —
across the product of:

```
MT{0,1} × starting HD{0,1} × ending {TC before EOT / TC at EOT / EOC without TC / missing next ID / CRC & CM}
```

plus WRITE under MT, READ A TRACK, SK/deleted, and the simultaneity of the VRTC edge with VSYNC.

## A more defensible sub-system model (suggested)

Reflect the 8255 latches at I/O-instruction time; model READY and index-hole phase after motor-on;
SPECIFY's HLT/HUT/SRT; SEEK step pulses; the two-index-hole timeout on IDAM search; the FM/MFM byte
period; non-DMA byte-request INT / RQM / EXM with **ST1.OR when the service deadline is missed**
(27 µs FM, 13 µs MFM on READ); and the post-TC sector-tail and CRC handling.
