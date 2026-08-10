// gbtools/verify — run every bundled Game Boy test ROM and print the score.
//
//   node gbtools/verify.mjs            the bundled corpus (needs nothing else)
//   node gbtools/verify.mjs --blargg   also blargg's, if they have been fetched
//
// This is what CI runs after `node --test`, and it exists so that the numbers
// are VISIBLE rather than merely asserted. test-gb.mjs checks the same corpus
// and fails on a regression; this prints 59/75 and the name of every hole, so
// that a build log answers "how good is it" without anyone reading a test file.
//
// Exit code is 1 if a bundled expectation regresses, 0 otherwise. blargg's
// suites never fail the run: they are not in the repository, so their absence
// (or a change in the mirror) must not turn CI red.

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { runTest, judgeMooneye, judgeBlargg } from './gbrun.mjs';
import { compareAcid2 } from './acid2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GBROMS = join(HERE, '..', 'gbroms');

// The same two lists test-gb.mjs keeps, for the same reason: a test written
// for a DMG 0 / a Pocket / a Super Game Boy is SUPPOSED to fail on a machine
// that is none of those, and calling that a hole would be dishonest in the
// other direction. Everything in KNOWN_FAIL is a real hole — see
// docs/gb-design.md §11.
const OTHER_MODEL = [
  'boot_div-S', 'boot_div-dmg0', 'boot_div2-S', 'boot_hwio-S', 'boot_hwio-dmg0',
  'boot_regs-dmg0', 'boot_regs-mgb', 'boot_regs-sgb', 'boot_regs-sgb2',
];
const KNOWN_FAIL = [
  'oam_dma/reg_read', 'oam_dma_start',
  'ppu/intr_2_mode0_timing_sprites', 'ppu/lcdon_timing-GS', 'ppu/lcdon_write_timing-GS',
  'ppu/stat_lyc_onoff', 'serial/boot_sclk_align-dmgABCmgb',
];
const EXPECT = { acceptance: 59, mbc: 27 };

function collect(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(p));
    else if (/\.gbc?(\.gz)?$/i.test(e.name)) out.push(p);
  }
  return out.sort();
}

function runGroup(dir, { frames = 900, model = 'dmg' } = {}) {
  const roms = collect(dir);
  const failed = [];
  for (const rom of roms) {
    const name = relative(dir, rom).replace(/\.gb(\.gz)?$/, '');
    if (!judgeMooneye(runTest(rom, { frames, model })).pass) failed.push(name);
  }
  return { total: roms.length, failed };
}

let bad = 0;
const t0 = Date.now();

// ---- mooneye, acceptance --------------------------------------------------
const acc = runGroup(join(GBROMS, 'mooneye', 'acceptance'));
const accPass = acc.total - acc.failed.length;
const otherModel = acc.failed.filter((n) => OTHER_MODEL.includes(n));
const holes = acc.failed.filter((n) => !OTHER_MODEL.includes(n));
console.log(`mooneye acceptance  ${accPass}/${acc.total}   (${otherModel.length} are for other hardware: DMG0 / MGB / SGB)`);
for (const n of holes) console.log(`  hole   ${n}${KNOWN_FAIL.includes(n) ? '' : '   ← NEW'}`);
if (accPass !== EXPECT.acceptance) { console.log(`  REGRESSION: expected ${EXPECT.acceptance}`); bad = 1; }

// ---- mooneye, the MBC suite ----------------------------------------------
const mbc = runGroup(join(GBROMS, 'mooneye', 'emulator-only'));
const mbcPass = mbc.total - mbc.failed.length;
console.log(`mooneye MBC         ${mbcPass}/${mbc.total}`);
for (const n of mbc.failed) console.log(`  hole   ${n}`);
if (mbcPass !== EXPECT.mbc) { console.log(`  REGRESSION: expected ${EXPECT.mbc}`); bad = 1; }

// ---- dmg-acid2 ------------------------------------------------------------
const acid = compareAcid2(join(GBROMS, 'dmg-acid2.gb.gz'), join(GBROMS, 'dmg-acid2-reference.png'));
console.log(`dmg-acid2           ${acid.diff === 0 ? 'exact match' : `${acid.diff}/${acid.total} pixels differ`}`);
if (acid.diff !== 0) bad = 1;

// ---- blargg, only if someone fetched them --------------------------------
if (process.argv.includes('--blargg')) {
  const dir = join(GBROMS, 'blargg');
  if (!existsSync(dir)) {
    console.log('blargg              not fetched (node gbtools/fetch-blargg.mjs)');
  } else {
    const roms = collect(dir);
    let pass = 0;
    const lines = [];
    for (const rom of roms) {
      const j = judgeBlargg(runTest(rom, { frames: 5000 }));
      if (j.pass) pass++;
      lines.push(`  ${j.pass ? 'ok  ' : 'FAIL'}   ${relative(dir, rom)}${j.pass ? '' : `   ${j.text.split('\n').filter(Boolean).slice(-1)[0]}`}`);
    }
    console.log(`blargg              ${pass}/${roms.length}   (not bundled — no licence; see gbtools/fetch-blargg.mjs)`);
    for (const l of lines) console.log(l);
  }
}

console.log(`\n${bad ? 'REGRESSED' : 'all bundled expectations met'}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(bad);
