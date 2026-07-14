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

OPNA is addressed as **two register banks**. On the PC-88 the built-in OPN sits at ports **44h (addr) / 45h (data)**; Sound Board II is a *separate* OPNA at **A8h (addr0) / A9h (data0+status) / AAh (addr1) / ABh (data1)** — confirmed empirically, see §9. (An earlier draft guessed 46h/47h; that was wrong.) The register **contents** below are the same YM2608 map either way.

**Bank 0** (ports A8h/A9h) — a superset of the OPN map, already implemented for `$00–$B6`:
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

**RESOLVED by measurement + disassembly (Telenet MUSICBOX music disk):**
- **Port mapping — CONFIRMED: SB2 OPNA is at `0xA8` (addr0) / `0xA9` (data + status0), `0xAA` / `0xAB` (bank1).** NOT 0x46/0x47 — the earlier §3 hypothesis was wrong. The built-in OPN stays at 0x44/0x45; the OPNA is a *separate* device at 0xA8–0xAB. Evidence — the disk's own status-read helper, disassembled at the `IN 0xA9`:
  ```
  OUT (C),E        ; C = 0xA8  — latch OPNA register
  OR (HL) ×6       ; settle delay
  INC C            ; C: 0xA8 → 0xA9
  IN A,(C)         ; read OPNA status at 0xA9
  ...
  LD A,(0x8FCE)    ; consult stored sound-board flag
  AND 03 / CP 03 / RET NZ
  LD C,0xA8        ; low2==3 ⇒ route sound output to OPNA (0xA8)
  ```
- **Detection routing — the driver picks OPN(0x44) vs OPNA(0xA8) from a stored flag** (here RAM `0x8FCE`, low 2 bits == 3 ⇒ OPNA). The flag is set by the detection read of `0xA9` at boot. So "play the enhanced score" == "make the boot-time status read at 0xA9 return the value a present OPNA returns."

**Detection — CRACKED (real SB2 disk: `S.O.S. for SB2`):**
- Booted the SB2 title with the minimal OPNA (`sb2:true`) present at 0xA8–0xAB. It reads status at 0xA9 exactly once, then `CP 01h` / `JP NZ` (traced instruction-by-instruction). Sweeping the status return: **`0xA9 → 0x01` makes it detect the OPNA and start writing registers**; any other value (0x00, 0x02, 0x03, 0x80…) → skips to the OPN path. So the SB2 presence check is **"status at 0xA9 == 0x01"** (bit0 = Timer-A overflow). A real OPNA reaches that via a tiny-Timer-A + poll; the minimal chip must reproduce it (implement the Timer-A flag in the OPNA status so a cold-ish read returns 0x01 at detection time).
- With detection satisfied, `S.O.S.` initialises the OPNA SSG ($00-$0D), mode ($27), key ($28) — then idles at its menu. Both SB2 titles (`S.O.S. for SB2`, `神の聖都 DEMO SB2対応版`) are **menu/sound-test driven**: the FM6/rhythm music only starts after a keypress, so full capture needs keyboard input (read text VRAM to see the menu, inject keys, watch for $30-$B6 / rhythm writes).
- **Rhythm ROM found** ✅ — `OPNAリズムセット.zip` = the six ADPCM-A drum samples as 44.1 kHz/mono/16-bit WAV (bd/sd/hh/rim/tom/top), saved to `assets/opna-rhythm/`. Phase-2 rhythm can play these directly — no ADPCM-A decoder needed for a first cut.

**Still open (method in brackets):**
1. **Natural detection status** 🟠 — make the OPNA status return 0x01 at detection *from the real Timer-A flag* rather than a stub, so `sb2:true` passes without a hack. *[implement Timer-A overflow in the OPNA status; verify S.O.S. detects with the real chip]*
2. **Full music capture** 🟠 — drive the SB2 title's menu (keyboard + text-VRAM read) to start playback and capture the FM4-6 + rhythm register stream = the arrangement reference. *[read screen from RAM VRAM; map the key matrix; navigate; log 0xA8-0xAB writes]*
3. **Port mapping** ✅ RESOLVED — 0xA8–0xAB. **Detection** ✅ CRACKED — status 0xA9 == 0x01. **Rhythm ROM** ✅ IN HAND.
3. **`$28` key-on group bit** 🟠 — current code masks `v & 3` (3 channels). OPNA needs the group bit so `bit2` selects FM4–6; `& 3` silently drops it. *[fix mask to honor bit2 when in OPNA mode]*
4. **Clock / prescaler** 🟠 — `fmStep = clk/72`, `ssgStep = clk/16` are the OPN dividers. OPNA's prescaler (`$2D–$2F`) and base clock may differ; a few-ms drift is audible across six voices. *[verify OPNA divider against datasheet before reusing the steps]*
5. **ADPCM-A rhythm ROM** 🟠 — need the actual dump *and* its format (4-bit ADPCM, the exact step table, per-drum address table). Can't write the decoder without it. *[source a YM2608 rhythm ROM; confirm format]*
6. **ADPCM-B DRAM regs + busy/IRQ** 🟠 — `$10–$1B` split (which reg is address vs data, auto-increment?) is unspecified, and a game that polls the busy flag after DMA will **hang** if the status bit isn't wired. *[capture $10–$1B write order from an ADPCM-B-using title; wire the status bit, not just the decoder]*

**Consequence for build order (§6):** phase 0 is now *"reach detection"* — present an OPNA-shaped status at the mapped ports and confirm a SB2-aware boot flips to the enhanced score (instrument-load signature jumps). Only then do FM6 / rhythm / ADPCM-B pay off.

Related: [design.md](./design.md) (chip/emulator contracts), [datasheet.md](./datasheet.md), [peripherals.md](./peripherals.md).
