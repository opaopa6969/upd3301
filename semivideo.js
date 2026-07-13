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
export function rgbaToSemigraphic(rgba, dotW, dotH, { gain = 1.0 } = {}) {
  const cols = dotW >> 1, rows = dotH >> 2;
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
        if (rgba[o] / 255 * gain > th) d |= 2; // R
        if (rgba[o + 1] / 255 * gain > th) d |= 4; // G
        if (rgba[o + 2] / 255 * gain > th) d |= 1; // B
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
