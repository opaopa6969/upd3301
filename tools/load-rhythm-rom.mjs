// load-rhythm-rom.mjs — Node-side loader that reads the six OPNA rhythm-ROM
// WAVs from assets/opna-rhythm/ and returns them in the order the YM2608 $00
// key bits expect: [BD, SD, TOP, HH, TOM, RIM]. This is the side-load path
// (like the BIOS ROMs) — the pure chip core never touches the filesystem; a
// harness or the machine calls Ym2608.setRhythmRom(loadRhythmRom()).
//
// The real YM2608 stores these as ADPCM-A in an internal mask ROM. We ship
// already-decoded PCM WAVs (decode-free, directly playable) so phase-2 rhythm
// is audible without an ADPCM-A decoder; a true decoder can replace this later
// behind the same setRhythmRom() interface.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeWav } from '../wav.js';

// $00 bit order: bit0=BD bit1=SD bit2=TOP(cymbal) bit3=HH bit4=TOM bit5=RIM.
export const RHYTHM_FILES = ['bd', 'sd', 'top', 'hh', 'tom', 'rim'];

export function loadRhythmRom(dir) {
  const here = dirname(fileURLToPath(import.meta.url));
  const base = dir ?? join(here, '..', 'assets', 'opna-rhythm');
  let rate = 44100;
  const samples = RHYTHM_FILES.map((name) => {
    const bytes = readFileSync(join(base, `2608_${name}.wav`));
    const { data, rate: r } = decodeWav(bytes);
    rate = r;
    return data;
  });
  return { samples, rate };
}
