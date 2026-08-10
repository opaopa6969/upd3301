// gbtools/fetch-blargg — download Shay Green's ("blargg") Game Boy test ROMs
// into gbroms/blargg/, which is git-ignored.
//
//   node gbtools/fetch-blargg.mjs [--dir gbroms/blargg]
//
// ## Why these are downloaded and mooneye's are checked in
//
// Everything in gbroms/ was checked one file at a time, and only the ones with
// a licence that permits redistribution are in the repository:
//
//   dmg-acid2        MIT, Matt Currie          → gbroms/LICENSE-dmg-acid2
//   mooneye-gb       MIT, Joonas Javanainen    → gbroms/mooneye/LICENSE
//   blargg           NO LICENCE FILE ANYWHERE  → not bundled; fetched here
//
// blargg's suites are the best-known Game Boy test ROMs there are and they are
// mirrored everywhere, but neither the ROMs nor their sources carry a licence
// or a public-domain dedication — the readme ends with an e-mail address and
// nothing else. "Everyone redistributes it" is not a licence, so this project
// does not, and the tests that use them skip when they are absent. That is the
// only honest version of "the corpus is redistributable" that #42 can claim.
//
// The default source is the retrio mirror, which is the one most emulator
// projects point at. Pass --base to use another.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BASE = 'https://raw.githubusercontent.com/retrio/gb-test-roms/master';

// The multi-ROM of each suite: one file that runs the whole group and prints a
// single verdict. The individual/ ROMs are not needed to get a number.
// The second entry of each pair is the name to save it under, because
// mem_timing-2's multi-ROM is also called mem_timing.gb.
export const BLARGG_ROMS = [
  'cpu_instrs/cpu_instrs.gb',
  'instr_timing/instr_timing.gb',
  'mem_timing/mem_timing.gb',
  ['mem_timing-2/mem_timing.gb', 'mem_timing-2.gb'],
  'halt_bug.gb',
  'interrupt_time/interrupt_time.gb',
  'oam_bug/oam_bug.gb',
  'dmg_sound/dmg_sound.gb',
  'cgb_sound/cgb_sound.gb',
];

export async function fetchBlargg({ dir = 'gbroms/blargg', base = DEFAULT_BASE, force = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const got = [];
  for (const entry of BLARGG_ROMS) {
    const [path, as] = Array.isArray(entry) ? entry : [entry, null];
    const name = as || path.split('/').pop();
    const out = join(dir, name);
    if (!force && existsSync(out)) { got.push([name, 'already there']); continue; }
    const res = await fetch(`${base}/${path}`);
    if (!res.ok) { got.push([name, `HTTP ${res.status}`]); continue; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    writeFileSync(out, bytes);
    got.push([name, `${bytes.length} bytes`]);
  }
  return got;
}

if (process.argv[1] && process.argv[1].endsWith('fetch-blargg.mjs')) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  const dir = flag('dir', 'gbroms/blargg');
  const got = await fetchBlargg({ dir, base: flag('base', DEFAULT_BASE), force: args.includes('--force') });
  for (const [name, how] of got) console.log(`${name.padEnd(22)} ${how}`);
  console.log(`\n→ ${dir}  (git-ignored; blargg's ROMs carry no licence, so they are not committed)`);
  console.log('now: node gbtools/suite.mjs ' + dir + ' --blargg --frames 4000');
}
