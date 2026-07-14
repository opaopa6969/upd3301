// import-bios — unpack the BIOS zip collection into roms/<machine>/ and
// write roms/manifest.json so the demo can auto-load. ROMs stay gitignored.
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

const SRC = process.argv[2] ?? '/mnt/c/Users/opaop/Downloads/BIOS';
const DST = process.argv[3] ?? 'roms';

// combined pc88.rom (112KB) → parts
const PC88_PARTS = {
  'N88.ROM': [0x00000, 0x08000],
  'N88EXT.ROM': [0x08000, 0x10000],
  'N88MID.ROM': [0x10000, 0x16000],
  'N80.ROM': [0x16000, 0x1c000], // N-BASIC mode image (24KB)
};

const machineOf = (zip) => basename(zip, '.zip')
  .replace(/_BIOS$/, '').replace(/^PC-/, '').replace(/BIOS基本セット/, 'basic-set')
  .replace(/漢字ROM(.*)/, 'kanji$1').replace(/OPNAリズムセット/, 'opna-rhythm');

mkdirSync(DST, { recursive: true });
const machines = [];
for (const f of readdirSync(SRC)) {
  if (!f.toLowerCase().endsWith('.zip')) continue;
  const name = machineOf(f);
  const dir = join(DST, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execSync(`unzip -o -q "${join(SRC, f)}" -d "${dir}"`);
  // split any combined pc88.rom
  for (const g of readdirSync(dir)) {
    if (g.toLowerCase() === 'pc88.rom') {
      const b = readFileSync(join(dir, g));
      if (b.length >= 0x1c000) {
        for (const [part, [a, z]] of Object.entries(PC88_PARTS)) {
          writeFileSync(join(dir, part), b.subarray(a, z));
        }
      }
    }
  }
  const files = readdirSync(dir).filter((g) => statSync(join(dir, g)).isFile());
  machines.push({ name, files });
  console.log(name.padEnd(14), files.join(' '));
}

// Known-good N-BASIC images (verified to reach the Ok prompt on machine.js).
// The combined pc88.rom slices are NOT among them — those offsets are a guess
// and the split N80 does not boot; the machines that ship individual ROM files
// (MC, FR, 8001mkII) are the ones that work today.
const BOOTS = new Set(['8001mkII/N80_2.ROM', '8801MC/n80.rom', '8801mkIIFR/n80.rom']);

// manifest: pick a bootable default (PC-8001mkII N-BASIC works today)
const pick = (m, f) => (machines.find((x) => x.name === m)?.files.includes(f) ? `${m}/${f}` : null);
// A dir with the WHOLE split N88 set (main + 4 ext banks + disk sub-CPU ROM)
// can boot game disks. The demo auto-boots N88 from the first such dir it finds
// (manifest top-level "n88": "<dir>"), no file-picker needed on localhost.
const hasSplitN88 = (m) => ['n88.rom', 'n88_0.rom', 'n88_1.rom', 'n88_2.rom', 'n88_3.rom', 'disk.rom']
  .every((f) => m.files.includes(f));
const n88dir = machines.find(hasSplitN88)?.name ?? null;
const manifest = {
  default: pick('8001mkII', 'N80_2.ROM') ?? pick('basic-set', 'N80.ROM'),
  n88: n88dir, // dir with the split N88 BIOS set → demo auto-boots N88 (disk-capable)
  font: pick('basic-set', 'font.rom'),
  machines: machines.map((m) => ({
    name: m.name,
    boots: m.files.some((f) => BOOTS.has(`${m.name}/${f}`)),
    rom: m.files.find((f) => /^N80(_2)?\.ROM$/i.test(f)) ? `${m.name}/${m.files.find((f) => /^N80(_2)?\.ROM$/i.test(f))}` : null,
    n88: m.files.includes('N88.ROM') ? `${m.name}/N88.ROM` : null,
    ext: m.files.includes('N88EXT.ROM') ? `${m.name}/N88EXT.ROM` : null,
    font: m.files.find((f) => /font/i.test(f)) ? `${m.name}/${m.files.find((f) => /font/i.test(f))}` : null,
  })).filter((m) => m.rom || m.n88),
};
writeFileSync(join(DST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('\nmanifest.json written. default =', manifest.default);
