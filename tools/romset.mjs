// romset — load a ROM directory the way M88 does, so both emulators run the
// *same bytes*.
//
// This exists because of a silent harness bug that invalidated months of
// comparison: M88 prefers a single combined image and only falls back to the
// separate files.
//
//   Memory::LoadROM()     tries "pc88.rom" first, then n88.rom / n88_0..3.rom
//   SubSystem::LoadROM()  tries "PC88.ROM" first, then DISK.ROM
//
// The m88204 set here ships BOTH `Pc88.rom` and the separate files, and on a
// case-insensitive mount (/mnt/c) "PC88.ROM" matches "Pc88.rom" — so M88 was
// running the combined image while our harness read n88.rom + disk.rom. They
// are not the same revision: 107 bytes differ in the main ROM, 141 in the
// extension ROMs, and 2021 in the disk sub-ROM. Every "divergence" traced
// through the sub-system was partly this.
//
// Combined-image layout, straight from M88's read sequence:
//   0x00000 +0x8000  N88 main
//   0x08000 +0x2000  N80 (upper 8k)      → n80[0x6000..0x7fff]
//   0x0A000 +0x2000  (skipped)
//   0x0C000 +0x8000  N88 extension (= n88_0..3 concatenated)
//   0x14000 +0x2000  disk sub-system ROM
//   0x16000 +0x6000  N80 (lower 24k)     → n80[0x0000..0x5fff]
//
// Usage:
//   import { loadRomSet } from './romset.mjs';
//   const { main, ext, sub, n80, source } = loadRomSet(romDir);
//
// `n80` is NOT only for N-BASIC mode. Port 31h bit 2 swaps the N80 ROM in at
// 0000-5FFF while the machine stays in N88 mode (M88 `Memory::Update00R`:
// `read = rom + (port31 & 4 ? n80 : n88)`), and games use it as a probe — the
// two ROMs differ in their very first instruction, `LD SP,0FFFFh` against
// `LD SP,0E1A0h`, so reading the word at 0x0002 says which one is mapped.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// The ROM sets in the wild mix cases (N88.ROM / n88.rom). Resolve
// case-insensitively so this works on a case-sensitive filesystem too.
function findFile(dir, name) {
  const want = name.toLowerCase();
  for (const f of readdirSync(dir)) if (f.toLowerCase() === want) return join(dir, f);
  return null;
}

export function loadRomSet(romDir) {
  const rd = (p) => new Uint8Array(readFileSync(p));
  const combined = findFile(romDir, 'pc88.rom');

  if (combined) {
    const c = rd(combined);
    const need = 0x16000;
    if (c.length >= need) {
      // The N80 image is split in the file: lower 24k lives after the sub
      // ROM, upper 8k sits in the gap at 0x8000. Reassemble it into one
      // 32k image so the machine can index it by address.
      let n80 = null;
      if (c.length >= 0x1c000) {
        n80 = new Uint8Array(0x8000);
        n80.set(c.slice(0x16000, 0x1c000), 0x0000); // 0000-5fff
        n80.set(c.slice(0x08000, 0x0a000), 0x6000); // 6000-7fff
      }
      return {
        main: c.slice(0x00000, 0x08000),
        ext: c.slice(0x0c000, 0x14000),
        sub: c.slice(0x14000, 0x16000),
        n80,
        source: `combined ${combined}`,
      };
    }
    // Too short to hold the sub ROM — fall through rather than serve garbage.
  }

  const mainPath = findFile(romDir, 'n88.rom');
  if (!mainPath) throw new Error(`no pc88.rom and no n88.rom in ${romDir}`);
  const ext = new Uint8Array(0x8000);
  for (let i = 0; i < 4; i++) {
    const p = findFile(romDir, `n88_${i}.rom`);
    if (p) ext.set(rd(p), i * 0x2000);
  }
  const subPath = findFile(romDir, 'disk.rom');
  const n80Path = findFile(romDir, 'n80.rom');
  return {
    main: rd(mainPath),
    ext,
    sub: subPath ? rd(subPath) : null,
    n80: n80Path ? rd(n80Path) : null,
    source: 'separate files',
  };
}
