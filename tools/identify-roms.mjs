// identify-roms — sizes/heads/hashes for whatever ROM dumps land in roms/
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'roms';
const GUESS = new Map([
  [24576, 'N-BASIC ROM (N80.ROM)?'],
  [32768, 'N88-BASIC ROM (N88.ROM) or padded N80'],
  [2048, 'FONT.ROM (256x8) or PC-80S31 sub ROM'],
  [8192, 'DISK.ROM (8801系) / 4th ROM'],
  [4096, 'kanji? / ext ROM'],
]);
for (const f of readdirSync(dir)) {
  const p = join(dir, f);
  if (!statSync(p).isFile() || f.endsWith('.md')) continue;
  const b = readFileSync(p);
  const md5 = createHash('md5').update(b).digest('hex');
  const head = [...b.subarray(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
  console.log(`${f}\n  size=${b.length} (${GUESS.get(b.length) ?? '??'})\n  md5=${md5}\n  head=${head}`);
}
