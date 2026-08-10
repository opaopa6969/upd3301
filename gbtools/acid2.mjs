// gbtools/acid2 — run dmg-acid2 and compare the picture with its reference
// image, pixel for pixel.
//
//   node gbtools/acid2.mjs [rom] [reference.png]
//
// dmg-acid2 is the one test in the Game Boy collection that judges the PPU by
// what it DRAWS rather than by a number it computes, and its README pins the
// four grey levels ($00/$55/$AA/$FF) precisely so that the comparison can be
// exact instead of approximate. So this compares exactly: any differing pixel
// is a failure, and the tool prints where the differences are so that a broken
// feature can be recognised by its shape (the README has a guide — the hair is
// LCDC bit 0, the eyes are object-over-background priority, the mouth is the
// window, and so on).
//
// The reference is a 160x144 8-bit greyscale PNG, which is the simplest kind
// there is: one filter byte per row and no palette. Decoding it needs an
// inflate, and node has one, so there is no dependency here either.

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runTest, asciiFrame } from './gbrun.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROM = join(HERE, '..', 'gbroms', 'dmg-acid2.gb.gz');
const DEFAULT_REF = join(HERE, '..', 'gbroms', 'dmg-acid2-reference.png');

// A PNG decoder for exactly the kinds of file this needs: greyscale at 1, 2,
// 4 or 8 bits per sample, or 8-bit truecolour, no interlacing. The reference
// image is 2-bit greyscale — four levels, which is exactly what a DMG has, and
// the PNG spec's own scaling of a 2-bit sample to 8 bits (x255/3) produces
// $00/$55/$AA/$FF, the four values dmg-acid2 asks emulators to output. The
// comparison is therefore exact by construction, with no tolerance anywhere.
// Returns one byte per pixel for greyscale and three for RGB.
export function decodePng(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) throw new Error('not a PNG');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 8, width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  const idat = [];
  while (off < b.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(off + 8); height = dv.getUint32(off + 12);
      depth = b[off + 16]; colour = b[off + 17]; interlace = b[off + 20];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const okDepth = colour === 0 ? [1, 2, 4, 8].includes(depth) : depth === 8;
  if (!okDepth || interlace !== 0 || (colour !== 0 && colour !== 2)) {
    throw new Error(`unsupported PNG (depth ${depth}, colour type ${colour}, interlace ${interlace})`);
  }
  const bpp = colour === 0 ? 1 : 3;
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  // Sub-byte depths pack several pixels per byte, and the filters work on
  // BYTES, so unfiltering happens first and unpacking after.
  const stride = colour === 0 ? Math.ceil((width * depth) / 8) : width * bpp;
  const out = new Uint8Array(width * height * bpp);
  let prev = new Uint8Array(stride);
  const filterBpp = colour === 0 ? Math.max(1, (depth / 8) | 0) : bpp;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= filterBpp ? cur[x - filterBpp] : 0, up = prev[x], c = x >= filterBpp ? prev[x - filterBpp] : 0;
      let v = line[x];
      switch (filter) {
        case 1: v += a; break;
        case 2: v += up; break;
        case 3: v += (a + up) >> 1; break;
        case 4: {
          const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : c);
          break;
        }
        default: break;
      }
      cur[x] = v & 0xff;
    }
    if (depth === 8) out.set(cur, y * width * bpp);
    else {
      const max = (1 << depth) - 1;
      for (let x = 0; x < width; x++) {
        const bit = x * depth;
        const v = (cur[bit >> 3] >> (8 - depth - (bit & 7))) & max;
        out[y * width + x] = Math.round((v * 255) / max);
      }
    }
    prev = cur;
  }
  return { width, height, bpp, data: out };
}

export function compareAcid2(romPath = DEFAULT_ROM, refPath = DEFAULT_REF, { frames = 60, model = 'dmg' } = {}) {
  const r = runTest(romPath, { frames, model });
  const { width, height, rgb } = r.gb.render();
  const ref = decodePng(new Uint8Array(readFileSync(refPath)));
  if (ref.width !== width || ref.height !== height) {
    throw new Error(`reference is ${ref.width}x${ref.height}, frame is ${width}x${height}`);
  }
  let diff = 0;
  const rows = new Map();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const want = ref.bpp === 1 ? ref.data[y * width + x] : ref.data[(y * width + x) * 3];
      const got = rgb[(y * width + x) * 3];
      if (want !== got) { diff++; rows.set(y, (rows.get(y) || 0) + 1); }
    }
  }
  return { gb: r.gb, diff, total: width * height, rows, width, height };
}

if (process.argv[1] && process.argv[1].endsWith('acid2.mjs')) {
  const rom = process.argv[2] || DEFAULT_ROM;
  const ref = process.argv[3] || DEFAULT_REF;
  const res = compareAcid2(rom, ref);
  if (res.diff === 0) {
    console.log(`dmg-acid2: EXACT MATCH (${res.total} pixels)`);
  } else {
    console.log(`dmg-acid2: ${res.diff}/${res.total} pixels differ`);
    const bad = [...res.rows.entries()].sort((a, b) => a[0] - b[0]);
    console.log('rows with differences:', bad.map(([y, n]) => `${y}(${n})`).join(' '));
  }
  console.log(asciiFrame(res.gb, 80));
}
