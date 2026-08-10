// The comparison tools' judgement rules, tested against the cases that actually
// fooled them. Every fixture here is a real measurement taken during the M88
// parity work (docs/m88-comparison.md); the point of the file is that a future
// change to the rules has to keep getting these right.
//
// Runs without ROMs or disks — the rules are pure.

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyScreen, classifyLoop, isConverged, isBasicScreen } from './tools/verdict.js';

test('a title that turned the text plane off is judged on GVRAM, not tvram', () => {
  // Ys1 at 1500f, after the MT fix regressed it: our screen was genuinely
  // empty, but tvram alone could only say "text off" and the old rule read that
  // as a blank screen rather than a divergence.
  const v = classifyScreen(
    { e6cd: 0xfc, tvnz: 1380, gvnz: 19881 },
    { e6cd: 0x00, tvnz: 0, gvnz: 0, textOff: true },
  );
  assert.equal(v.plane, 'gv');
  assert.equal(v.kind, 'divergent');
});

test('the same title, once fixed, reads as exact on GVRAM', () => {
  const v = classifyScreen(
    { e6cd: 0xfc, tvnz: 1380, gvnz: 19881 },
    { e6cd: 0xfc, tvnz: 1380, gvnz: 19881, textOff: true },
  );
  assert.equal(v.kind, 'exact');
});

test('without a GVRAM count the rule falls back to text and does not pretend', () => {
  // Older refdrv builds reported no gvramNZ. Falling back is fine; silently
  // scoring a graphics-only title on an empty text plane is not.
  const v = classifyScreen(
    { e6cd: 0x00, tvnz: 2678, gvnz: null },
    { e6cd: 0x00, tvnz: 2678, gvnz: null, textOff: true },
  );
  assert.equal(v.plane, 'tv');
  assert.equal(v.kind, 'exact');
});

test('a different flag byte over the same amount of picture is phase, not divergence', () => {
  // Several titles hold a game-specific byte that each emulator samples at a
  // different animation frame. Treating that as a bug produced a whole table of
  // false leads in the first sweep.
  const v = classifyScreen(
    { e6cd: 0x92, tvnz: 2801, gvnz: 5000 },
    { e6cd: 0x00, tvnz: 2805, gvnz: 5010 },
  );
  assert.equal(v.kind, 'phase');
});

test('genuinely different screen content is divergent', () => {
  const v = classifyScreen(
    { e6cd: 0x00, tvnz: 2678, gvnz: 100 },
    { e6cd: 0x24, tvnz: 1660, gvnz: 8005 },
  );
  assert.equal(v.kind, 'divergent');
});

test('two blank screens are blank, not a divergence', () => {
  const v = classifyScreen(
    { e6cd: 0x00, tvnz: 0, gvnz: 12 },
    { e6cd: 0xff, tvnz: 0, gvnz: 5, textOff: true },
  );
  assert.equal(v.kind, 'blank');
});

test('Xanadu is alive: a small PC set that still touches I/O is a tight loop', () => {
  // Xanadu matches M88 exactly and spends 100% of its frames below 0x1000.
  // The old "hot PC < 0x1000 means executing garbage" rule called it a crash.
  assert.equal(classifyLoop({ distinctPCs: 544, ioCount: 30 }), 'tight-loop');
});

test('Makaimura is a runaway: thousands of PCs and no I/O at all', () => {
  assert.equal(classifyLoop({ distinctPCs: 5972, ioCount: 0 }), 'runaway');
});

test('a halted CPU is idle, not dead', () => {
  // OHOTUKU sampled at 4000f showed one distinct PC and got reported as
  // "completely stopped". It was in HALT waiting for an interrupt, and was
  // animating normally on either side of the sample.
  assert.equal(classifyLoop({ distinctPCs: 1, ioCount: 0 }), 'halted-waiting');
  assert.equal(classifyLoop({ distinctPCs: 900, ioCount: 5, halted: true }), 'halted-waiting');
});

test('a small loop with no I/O is called out separately from a runaway', () => {
  // harakiri: 53 distinct PCs, zero IN and zero OUT, interrupts disabled. It is
  // waiting on memory only an interrupt could change — a different failure from
  // marching through data, and it wants a different investigation.
  assert.equal(classifyLoop({ distinctPCs: 53, ioCount: 0 }), 'no-io-loop');
});

test('one sample is never converged; repeated identical samples are', () => {
  const s = { e6cd: 0x09, tvnz: 3126, gvnz: 12828 };
  assert.equal(isConverged([s]), false, 'a single frame cannot prove convergence');
  assert.equal(isConverged([s, { ...s }]), true);
  assert.equal(isConverged([s, { ...s, tvnz: 2678 }]), false);
});

test('the BASIC opening screen is recognised for what it is', () => {
  // Measured: boot with no disk at all for 1500 frames and the text plane holds
  // exactly 2678 non-zero bytes with nothing in GVRAM. Any side showing this
  // never loaded the disk.
  assert.equal(isBasicScreen({ e6cd: 0x00, tvnz: 2678, gvnz: 0 }), true);
  assert.equal(isBasicScreen({ e6cd: 0x00, tvnz: 2678, gvnz: null }), true);
  // …but the same text count with graphics drawn is a game that happens to use
  // that much text, not a BASIC prompt.
  assert.equal(isBasicScreen({ e6cd: 0x00, tvnz: 2678, gvnz: 4060 }), false);
  assert.equal(isBasicScreen({ e6cd: 0x00, tvnz: 1660, gvnz: 0 }), false);
});

test('a reference that never booted is named as such, not called our divergence', () => {
  // Hydlide3, measured 2026-08-10: M88 sits on the BASIC screen with an empty
  // graphics plane while we draw 8005 bytes of game. For days this read as
  // "we diverge from M88" and sent the investigation at our emulator. The gold
  // standard is only gold when it actually ran the disk.
  const v = classifyScreen(
    { e6cd: 0x00, tvnz: 2678, gvnz: 0 },
    { e6cd: 0x24, tvnz: 1660, gvnz: 8005 },
  );
  assert.equal(v.kind, 'ref-not-booted');
});

test('and the same rule catches us failing to boot', () => {
  // うる星やつら, measured the same day: the sides are the other way round.
  const v = classifyScreen(
    { e6cd: 0x00, tvnz: 3194, gvnz: 5000 },
    { e6cd: 0x01, tvnz: 2678, gvnz: 0 },
  );
  assert.equal(v.kind, 'ours-not-booted');
});

test('both sides on the BASIC screen is not a boot failure verdict', () => {
  // Neither side loaded, so neither is at fault relative to the other — this is
  // the existing "blank"/"exact" territory, not a one-sided finding.
  const v = classifyScreen(
    { e6cd: 0x00, tvnz: 2678, gvnz: 0 },
    { e6cd: 0x00, tvnz: 2678, gvnz: 0 },
  );
  assert.equal(v.kind, 'exact');
});
