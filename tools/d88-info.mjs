// d88-info — what's on this disk? (headless; the FDC's-eye view)
import { readFileSync } from 'node:fs';
import { parseD88All, summarize } from '../d88.js';
const disks = parseD88All(new Uint8Array(readFileSync(process.argv[2])));
disks.forEach((d, i) => {
  const s = summarize(d);
  console.log(`disk ${i}: "${s.name}" ${s.media}${s.writeProtect ? ' [write-protected]' : ''}`);
  console.log(`  ${s.tracks} tracks, ${s.sectors} sectors, ${(s.bytes / 1024) | 0} KB, sizes ${s.sectorSizes.join('/')}B`);
  if (s.oddities.length) console.log(`  ⚠ ${s.oddities.join(', ')}  ← copy protection lives here`);
  const t0 = d.tracks[0];
  if (t0) console.log(`  track 0: ${t0.sectors.map((x) => `R${x.r}/${128 << x.n}B`).join(' ')}`);
});
