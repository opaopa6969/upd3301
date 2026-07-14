**English** · [日本語](./opna-design.ja.md)

# Sound Board II / YM2608 (OPNA) — design

How we extend the emulator's current **YM2203 (OPN)** sound to the **Sound Board II** expansion, whose chip is the **YM2608 (OPNA)**. This is a design contract, grounded in the existing [`ym2203.js`](../ym2203.js): it says what to build, in what order, and how to verify it — without hand-waving.

## 1. Why — what Sound Board II adds

The PC-8801mkII SR and later have a built-in **YM2203 (OPN)**: FM ×3 + SSG ×3, mono. **Sound Board II** is an option board carrying a **YM2608 (OPNA)** — a superset:

| | built-in OPN (YM2203) | Sound Board II / OPNA (YM2608) |
|---|---|---|
| FM | 3 voices | **6 voices** |
| SSG | 3 voices | 3 voices (identical) |
| Rhythm | — | **ADPCM-A ×6** (bass drum, snare, top cymbal, hi-hat, tom, rim) — real drums, from internal ROM |
| PCM | — | **ADPCM-B ×1** (variable-rate delta PCM from 256 KB board RAM) |
| Output | mono | **stereo** (per-FM-voice L/R) |
| Timers | A/B | A/B (identical) |

Falcom games (Ys, Xanadu, Sorcerian…) detect the board at boot and, if present, play a **richer arrangement** — 6 FM voices plus drums — falling back to the OPN score otherwise. Getting OPNA right is what makes "TO MAKE THE END OF BATTLE" hit with percussion instead of three bare FM lines.

## 2. What we already have (reuse, don't rewrite)

[`ym2203.js`](../ym2203.js) is close to OPNA-ready in the parts that matter:

- `class Operator` — DT/MUL/TL/KS/AR/DR/SR/RR/SL, phase, env, key logic. **Unchanged for OPNA.**
- `class FmChannel` — 4 operators, `alg`, `fb`, `fnum`, `block`. **Unchanged; we just need six of them.**
- `_fmChannel(ch)` / `_opTick(op)` — the FM synthesis core (authentic LOG-SIN → EXP path). **Channel-agnostic already** (`render()` loops `this.ch`).
- `_writeSsg`, `_ssgTick`, `_ssgOut` — SSG. **Unchanged.**
- `tickTimers`, IRQ, `getState`/snapshot — **unchanged**, timers are identical.
- The output stage (board model, live knobs) stays; it now feeds a stereo bus.

So OPNA is mostly **more of the same FM**, plus **two genuinely new units** (ADPCM-A rhythm, ADPCM-B PCM) and a **stereo** output. We build `Ym2608` as a subclass-or-superset of the existing chip, sharing the FM/SSG code verbatim.

## 3. Register map (what changes)

OPNA is addressed as **two register banks**. On the PC-88 the built-in OPN sits at ports **44h (addr) / 45h (data)** = bank 0; the OPNA's second bank is at ports **46h (addr) / 47h (data)** = bank 1.

**Bank 0** (ports 44h/45h) — a superset of today's OPN map, already implemented for `$00–$B6`:
- `$00–$0F` SSG · `$10–$1F` *(unused on 88 side)* · `$22` LFO · `$24–$27` Timer A/B + mode · `$28` FM key on/off · `$2D–$2F` prescaler
- `$30–$9F` FM operator params, channels **1–3** · `$A0–$A6` fnum · `$B0–$B2` FB/ALG · `$B4–$B6` **L/R + AMS/PMS** (new: stereo pan + LFO sensitivity)

**Bank 1** (ports 46h/47h) — entirely new:
- `$00–$0D` **ADPCM-A (rhythm)**: `$00` key-on/dump (bits 0–5 = the six drums, bit 7 = dump), `$01` total level, `$08–$0D` per-drum L/R + level
- `$10–$1B` **ADPCM-B**: control/key, L/R, start/end/limit address, ΔN (rate), level, DRAM access
- `$30–$B6` FM operator params, channels **4–6** (same layout as 1–3)

Key-on register `$28` value encodes the channel as `bits0-1 = channel-in-group`, `bit2 = group (0 ⇒ FM1–3, 1 ⇒ FM4–6)`, `bits4-7 = operator slot mask`.

## 4. Design of the new units

### 4.1 FM 6-voice + stereo
- Grow `this.ch` from 3 to 6 `FmChannel`s. `render()` already iterates the array — no core change.
- `writeAddr`/`writeData` gain a **bank** notion: bank-1 address writes (port 46h) latch into `this.addr1`; bank-1 data (47h) dispatches `$30–$B6` to channels 4–6 and `$00–$1B` to ADPCM.
- **Stereo**: each FM voice and each rhythm/PCM voice has L/R enable bits (`$B4–$B6`, `$08–$0D`, `$11`). `render()` produces `outL`/`outR`; the board output stage runs per side. OPN mode keeps summing to mono (both bits on) so nothing regresses.

### 4.2 ADPCM-A — rhythm (the drums)
- Six fixed voices whose PCM waveforms live in a small **internal rhythm ROM** (bass drum, snare, top cymbal, hi-hat, tom, rim shot). This ROM is an **external asset** we must supply (a standard YM2608 rhythm-ROM dump, ~a few KB per sample); flag it clearly as a required input, like the PC-88 BIOS ROMs.
- Decode: YM2608 **ADPCM-A** is a 4-bit ADPCM with a fixed step table and no filtering. Each active drum advances its own sample pointer at the chip rate, decodes to a linear sample, scales by per-drum level × total level, pans L/R, and sums into the rhythm bus.
- `$00` bit *n* rising = trigger drum *n* (restart its pointer); bit 7 set = dump (stop). Deterministic: same key writes → same samples.

### 4.3 ADPCM-B — PCM channel
- One channel of **variable-rate delta PCM** read from the board's 256 KB DRAM. Games DMA a sample into DRAM (via `$08`/DRAM-access regs), set start/end/limit, a ΔN pitch, level and L/R, then key it.
- Decode: YM2608 **ADPCM-B** (a different, adaptive step-size ADPCM) with a phase accumulator for ΔN resampling to the output rate.
- DRAM is plain `Uint8Array` state, included in `getState()` for deterministic snapshot/restore.

### 4.4 Board detection
- Games probe for Sound Board II (a status-register read / ADPCM presence). We must answer the probe truthfully so the game **selects the enhanced score**. Without this, an OPNA that plays perfectly still never gets the 6-voice+drums data. This is a first-class requirement, not a nicety.

## 5. Contract compliance (suite-contract)
- **Pure / deterministic**: no `Math.random`; the rhythm ROM and DRAM are static data; same register writes + same ROM → identical samples. Snapshot covers ADPCM pointers + DRAM.
- **Fixed-step** `render(outL, outR, n)`; timers unchanged.
- **Plain-data output** + `schemaVersion` bump.
- **Dependency direction** one-way: `ym2608.js` is core (imports nothing DOM/board); `machine88.js` wires ports 44–47h and routes the stereo buffer; the demo/output-stage sits downstream. Shared FM/SSG code is factored into a common base so OPN and OPNA don't diverge.

## 6. Build order (each phase independently audible/testable)

1. **FM6 + stereo + bank-1 ports.** Six FM voices, L/R pan, ports 46/47h decoded in `machine88`. Many SB2 songs are mostly FM6 — this alone makes them fuller. *Verify:* FM4–6 pitch/algorithm tests (extend the OPN tests); stereo pan test; determinism.
2. **ADPCM-A rhythm.** Load the rhythm ROM, decode, wire `$00–$0D`. *Verify:* trigger each drum → non-silent, correct relative levels, deterministic; A/B a real SB2 capture.
3. **ADPCM-B PCM.** DRAM + decoder + ΔN resampler. *Verify:* golden-vector decode of a known ADPCM-B block; snapshot round-trip.
4. **Board detection.** Answer the probe so games pick the SB2 arrangement. *Verify:* boot a SB2-aware Falcom title and confirm it loads the 6-voice+drum score (register-write count / instrument-load signature jumps vs OPN mode).

## 7. Verification harness (reuse what we built)
The `opn-scope` live engine already replays a captured register-write log through the chip in the browser. Extend the capture to bank-1 writes and the trace to 6 FM + rhythm lanes, and the same tool becomes an **OPNA scope**: watch the drums fire, solo the ADPCM-B, A/B OPN-vs-OPNA arrangements of the same game. The teacher-mp3 comparison workflow carries over unchanged.

## 8. Open questions / risks
- **Rhythm ROM sourcing** — required external asset; confirm we can ship or side-load it like the BIOS ROMs.
- **ADPCM-B DMA timing** — games may rely on ADPCM busy flags / IRQ; needs the status bits wired, not just the decoder.
- **Detection specifics per game** — the probe differs by title/driver; may need a couple of captured boots to pin down.
- **Stereo in the output stage** — the current board model (HP, soft-limit, live knobs) must be duplicated per side without doubling the knob UI semantics.

## 9. Verification-first — adversarial review + measured I/O

An independent review (Codex) plus a live I/O probe in our own emulator turned several section-3/4 assertions from "assumed" into "must confirm before coding". **Detection is the gate**: everything downstream is dead code until the game is convinced Sound Board II is present.

**Measured (boot Ys III / Ys II in our machine, 20 s, log every `in`/`out`):**
- Both games, in OPN mode, touch **only 0x44/0x45** for sound — they **never read or write 0x46/0x47 or 0xA8–0xAF**. Heavy traffic is 0xFC–0xFF (FDD sub-CPU PPI handshake) and 0xE4–0xE6 (interrupt controller).
- Interpretation: the game **detects no SB2, so it plays the OPN score and never exercises the OPNA path at all.** A perfect OPNA that no game addresses is silent. So the first deliverable is not FM6 — it is **making detection succeed**, then confirming the game starts writing the second bank.

**Open items to nail before/while implementing (method in brackets):**
1. **Detection protocol** 🔴 — how a SB2-aware Falcom driver decides SB2 is present. Not a passive probe of a dedicated port in our captures ⇒ likely an OPN-status bit that differs on OPNA, a DIP/config byte (0x30/0x31 *are* read), or a disk that ships the SB2 driver only when detected. *[capture the boot I/O of a known-SB2 disk build; diff against the OPN-only boot]*
2. **Port mapping** 🔴 — working hypothesis: SB2 = OPNA at the OPN base, bank 0 = 0x44/0x45, **bank 1 = 0x46/0x47**; 0xA8–0xAF is the *second* board slot (unused here). Consistent with the chip family but unconfirmed on real PC-88 wiring. *[confirm against MAME's pc8801 OPNA hookup / hardware service manual]*
3. **`$28` key-on group bit** 🟠 — current code masks `v & 3` (3 channels). OPNA needs the group bit so `bit2` selects FM4–6; `& 3` silently drops it. *[fix mask to honor bit2 when in OPNA mode]*
4. **Clock / prescaler** 🟠 — `fmStep = clk/72`, `ssgStep = clk/16` are the OPN dividers. OPNA's prescaler (`$2D–$2F`) and base clock may differ; a few-ms drift is audible across six voices. *[verify OPNA divider against datasheet before reusing the steps]*
5. **ADPCM-A rhythm ROM** 🟠 — need the actual dump *and* its format (4-bit ADPCM, the exact step table, per-drum address table). Can't write the decoder without it. *[source a YM2608 rhythm ROM; confirm format]*
6. **ADPCM-B DRAM regs + busy/IRQ** 🟠 — `$10–$1B` split (which reg is address vs data, auto-increment?) is unspecified, and a game that polls the busy flag after DMA will **hang** if the status bit isn't wired. *[capture $10–$1B write order from an ADPCM-B-using title; wire the status bit, not just the decoder]*

**Consequence for build order (§6):** phase 0 is now *"reach detection"* — present an OPNA-shaped status at the mapped ports and confirm a SB2-aware boot flips to the enhanced score (instrument-load signature jumps). Only then do FM6 / rhythm / ADPCM-B pay off.

Related: [design.md](./design.md) (chip/emulator contracts), [datasheet.md](./datasheet.md), [peripherals.md](./peripherals.md).
