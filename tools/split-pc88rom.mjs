// split-pc88rom — carve a combined 112KB pc88.rom into its parts.
// Layout (M88/QUASI88 family): N88 main 32K | ext 4x8K | ... | N80 24K tail
import { readFileSync, writeFileSync } from 'node:fs';
const src = process.argv[2] ?? 'roms/pc88.rom';
const out = process.argv[3] ?? 'roms';
const b = readFileSync(src);
const parts = {
  'N88.ROM': [0x00000, 0x08000],
  'N88EXT.ROM': [0x08000, 0x10000],
  'N88MID.ROM': [0x10000, 0x16000],
  'N80SR.ROM': [0x16000, 0x1c000],
};
for (const [name, [a, z]] of Object.entries(parts)) {
  if (b.length >= z) { writeFileSync(`${out}/${name}`, b.subarray(a, z)); console.log(name, z - a, 'bytes'); }
}
