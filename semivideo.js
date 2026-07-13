// semivideo — RGBA frames → semigraphic cells + per-cell 8-color attributes.
//
// The lost aesthetic, computed honestly: luminance detail lives at the
// semigraphic dot grid (2×4 dots per cell), chroma lives at the CELL grid
// (one attribute color per cell) — the same "attribute clash" family as the
// PC-8001, ZX Spectrum and MSX1 screens. Per-channel ordered dithering
// (Bayer 4×4) quantizes each dot to the 3-bit GRB cube; each cell then
// takes the most frequent lit color among its 8 dots.
//
// Deterministic (ordered dither, stable tie-breaks), pure, dependency-free —
// the browser demo feeds it video frames, the tests feed it synthetic RGBA.

export const SCHEMA_VERSION = 1;

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// rgba: Uint8ClampedArray/Uint8Array of dotW*dotH*4 (straight RGBA).
// dotW must be even, dotH a multiple of 4.
// Returns { cols, rows, codes, colors }: semigraphic cell codes and
// per-cell GRB color indexes (0-7).
// Dynamic binarization: stretch levels so the frame uses the full dither
// range — dark or washed-out footage stays legible. Percentile-based
// (2%..98% of luma), deterministic for a given frame.
export function computeLevels(rgba, n) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const y = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
    hist[y]++;
  }
  const loN = n * 0.02, hiN = n * 0.98;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc <= loN) lo = v;
    if (acc <= hiN) hi = v;
  }
  if (hi - lo < 24) return { lo: 0, scale: 1 }; // flat frame: leave it alone
  return { lo, scale: 255 / (hi - lo) };
}

export function rgbaToSemigraphic(rgba, dotW, dotH, { gain = 1.0, autoLevels = false } = {}) {
  const cols = dotW >> 1, rows = dotH >> 2;
  let lo = 0, scale = 1;
  if (autoLevels) ({ lo, scale } = computeLevels(rgba, dotW * dotH));
  const codes = new Uint8Array(cols * rows);
  const colors = new Uint8Array(cols * rows);
  const counts = new Uint8Array(8);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      counts.fill(0);
      let code = 0;
      const dots = []; // per-dot quantized color, index = bit position
      for (let sub = 0; sub < 8; sub++) {
        const dx = sub >> 2, dy = sub & 3; // left column bits 0-3, right 4-7
        const x = cx * 2 + dx, y = cy * 4 + dy;
        const o = (y * dotW + x) * 4;
        const th = (BAYER4[y & 3][x & 3] + 0.5) / 16;
        let d = 0;
        if ((rgba[o] - lo) * scale / 255 * gain > th) d |= 2; // R
        if ((rgba[o + 1] - lo) * scale / 255 * gain > th) d |= 4; // G
        if ((rgba[o + 2] - lo) * scale / 255 * gain > th) d |= 1; // B
        dots.push(d);
        if (d) counts[d]++;
      }
      // cell color: most frequent lit color; ties break to the lower index
      let best = 0, bestN = 0;
      for (let c = 1; c < 8; c++) if (counts[c] > bestN) { bestN = counts[c]; best = c; }
      for (let sub = 0; sub < 8; sub++) {
        if (dots[sub]) code |= 1 << ((sub & 3) + (sub >> 2 ? 4 : 0));
      }
      codes[cy * cols + cx] = code;
      colors[cy * cols + cx] = best;
    }
  }
  return { schemaVersion: SCHEMA_VERSION, cols, rows, codes, colors };
}
