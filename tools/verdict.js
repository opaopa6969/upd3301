// verdict — the judgement rules the comparison tools run on, as pure functions.
//
// These rules have been wrong three times, and each time the mistake cost more
// than the bug it was hiding, because a wrong verdict sends you chasing an
// emulator fault that is really a measurement fault. They now live here so they
// can be unit-tested against the exact cases that fooled us (test-verdict.mjs
// encodes them); the tools import from here instead of open-coding the checks.
//
// The three corrections, each a real incident (see docs/m88-comparison.md):
//
//   1. A fixed frame is not a verdict. Two machines can hold the same
//      *intermediate* state at frame N and diverge later — that is how a Ys1
//      regression got scored as a win.
//   2. tvram alone cannot judge a title that turned the text plane off and
//      draws in GVRAM. It reads as a blank screen on whichever side got to
//      gameplay first.
//   3. "Executing low addresses" says nothing about health — Xanadu, which
//      matches M88 exactly, spends 100% of its frames below 0x1000. What
//      separates alive from dead is how many distinct PCs are touched and
//      whether the machine still talks to devices.
//   4. A final fill count cannot tell "never drew" from "drew, then wiped".
//      Six of the ten remaining divergence leads turn out to have drawn a
//      picture and then lost it — volguard reaches 40,273 bytes of GVRAM at
//      frame 1140 and ends on 1,467. Read as a single number at frame 1500 they
//      look like a machine that cannot draw, which points the investigation at
//      the drawing path; what actually needs explaining is the moment the
//      picture went away. Those are different bugs.
//   5. Comparing two fill counts cannot say *which* side is broken. Four titles
//      sat on the divergence list for days reading as "we diverge from M88",
//      when in fact M88 was parked on the N88-BASIC opening screen and had
//      never loaded the disk at all — we were the side running the game.
//
// Pure, zero deps, no ROM needed.

export const SCHEMA_VERSION = 1;

// How close two screen-fill counts must be to read as the same screen. Below
// this the two sides are showing genuinely different content.
const FILL_MATCH = 0.85;
// Under this many bytes neither side has drawn anything worth comparing.
const BLANK_FLOOR = 200;
// A loop revisiting more distinct addresses than this per sample window is
// marching through memory rather than looping — it is executing data as code.
const RUNAWAY_PCS = 500;
// The text plane of an N88-BASIC opening screen with no disk loaded. Measured
// by booting with no disk at all for 1500 frames: a machine showing exactly this
// much text and no graphics never got as far as the game.
const BASIC_SCREEN_TVNZ = 2678;
// A peak has to be worth losing before "it went away" means anything; below
// this a screen was never really drawn. Measured against the leads: the six
// real cases peak between 2,549 and 40,273.
const PEAK_FLOOR = 800;
// And most of it has to be gone. A screen that dims or scrolls partly off is
// not the same event as one that is erased.
const PEAK_LOSS_RATIO = 4;

/**
 * Which plane actually carries this title's picture, and how well the two sides
 * agree on it. Pass `null` for a gvram count when the emulator did not report
 * one (older refdrv builds); the text plane is then the only evidence available.
 */
/**
 * Did this side ever leave the BASIC prompt? A machine sitting on the opening
 * screen with an empty graphics plane never loaded the disk — which is a
 * different fact from "the two sides drew different pictures", and the one that
 * says whose fault a divergence is.
 */
export function isBasicScreen(s) {
  return s.tvnz === BASIC_SCREEN_TVNZ && (s.gvnz == null || s.gvnz === 0);
}

export function classifyScreen(ref, ours) {
  // Judge on whichever plane is being drawn. If either side has the text plane
  // off, its tvram count is meaningless and GVRAM is the only comparable thing.
  const textDark = ours.textOff || ours.tvnz === 0 || ref.tvnz === 0;
  const haveG = ref.gvnz != null && ours.gvnz != null;
  const useG = textDark && haveG;
  const plane = useG ? 'gv' : 'tv';
  const r = useG ? ref.gvnz : ref.tvnz;
  const o = useG ? ours.gvnz : ours.tvnz;
  const ratio = Math.min(r, o) / Math.max(r, o, 1);

  if (ref.e6cd === ours.e6cd && r === o) return { kind: 'exact', plane, ratio: 1 };
  // Before calling anything a divergence, check whether one side simply never
  // booted. Saying "we differ from M88" about a title M88 could not load sends
  // the investigation at our emulator for no reason — it cost four titles days
  // on the lead list (Hydlide3, Stercru, starclsr, PRO_FAN).
  const refDead = isBasicScreen(ref), oursDead = isBasicScreen(ours);
  if (refDead && !oursDead) return { kind: 'ref-not-booted', plane, ratio };
  if (oursDead && !refDead) return { kind: 'ours-not-booted', plane, ratio };
  if (r < BLANK_FLOOR && o < BLANK_FLOOR) return { kind: 'blank', plane, ratio };
  // Same amount of picture, different flag byte: the two sides are at different
  // points of the same running program, not in different states.
  if (ratio >= FILL_MATCH) return { kind: 'phase', plane, ratio };
  return { kind: 'divergent', plane, ratio };
}

/**
 * What a stalled machine is actually doing. `distinctPCs` and `ioCount` come
 * from a short profile window (a couple of frames) after it settled.
 */
export function classifyLoop({ distinctPCs, ioCount, halted = false }) {
  // A halted CPU parks on one address waiting for an interrupt. That is a
  // healthy idle, not a hang — reading it as "one hot PC = dead" mislabelled
  // OHOTUKU, which was animating fine either side of the sample.
  if (halted || distinctPCs <= 1) return 'halted-waiting';
  // Marching through thousands of addresses while touching no device at all is
  // a CPU executing data. A wait loop is small and keeps polling.
  if (distinctPCs > RUNAWAY_PCS && ioCount === 0) return 'runaway';
  if (ioCount === 0) return 'no-io-loop'; // small loop, no devices: waiting on memory an interrupt should change
  return 'tight-loop';
}

/**
 * Is a fingerprint safe to judge on? A single frame is not — say so rather than
 * letting a caller compare two mid-load machines and call it a match.
 */
/**
 * Did this side draw something and then lose it? `samples` is a series taken
 * over the run (not just the end), each `{ tvnz, gvnz }`.
 *
 * "Never drew" and "drew then wiped" want opposite investigations: the first
 * asks why the drawing path produced nothing, the second asks what erased a
 * picture that had already been produced. Reported as one final number they are
 * indistinguishable, which is how six leads sat on the list mis-described.
 *
 * The floor keeps ordinary screen transitions out: a title screen clearing
 * before gameplay is not a fault, so a peak has to be substantial and the loss
 * has to be most of it.
 */
export function findPeakLoss(samples) {
  if (!Array.isArray(samples) || samples.length < 3) return null;
  const last = samples[samples.length - 1];
  for (const plane of ['gvnz', 'tvnz']) {
    let peak = -1, peakAt = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i][plane] ?? 0;
      if (v > peak) { peak = v; peakAt = i; }
    }
    const fin = last[plane] ?? 0;
    // A peak at the very end is a machine still filling in, not one that lost
    // anything — there is no "after" to have lost it in.
    if (peakAt >= samples.length - 1) continue;
    if (peak > PEAK_FLOOR && fin < peak / PEAK_LOSS_RATIO) {
      return { plane, peak, peakAt, final: fin };
    }
  }
  return null;
}

export function isConverged(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return false;
  const key = (s) => `${s.e6cd}/${s.tvnz}/${s.gvnz ?? ''}`;
  return samples.every((s) => key(s) === key(samples[0]));
}
