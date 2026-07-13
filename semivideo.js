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

// temporalPhase: null = plain 2-level dither. 0/1 = 27-color flicker mode —
// each channel quantizes to 3 levels (off / flicker / on); the middle level
// lights only on phase 0, so alternating frames average to half brightness:
// 3 levels ^ 3 guns = 27 colors, readable through a long-persistence
// phosphor exactly like the Bemaga DMA trick.
export function rgbaToSemigraphic(rgba, dotW, dotH, { gain = 1.0, autoLevels = false, temporalPhase = null } = {}) {
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
        if (temporalPhase === null) {
          if ((rgba[o] - lo) * scale / 255 * gain > th) d |= 2; // R
          if ((rgba[o + 1] - lo) * scale / 255 * gain > th) d |= 4; // G
          if ((rgba[o + 2] - lo) * scale / 255 * gain > th) d |= 1; // B
        } else {
          for (let c = 0; c < 3; c++) {
            const v = Math.min(1, Math.max(0, (rgba[o + c] - lo) * scale / 255 * gain));
            const lv = v * 2, q = Math.min(2, Math.floor(lv) + ((lv - Math.floor(lv)) > th ? 1 : 0));
            if (q === 2 || (q === 1 && temporalPhase === 0)) d |= [2, 4, 1][c];
          }
        }
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

// Line-art mode for anime: flat-fill regions meet at boundaries — detect
// them per channel (region segmentation by color difference, not just luma,
// so equal-brightness color borders still count) and light dots on the
// edges. Each cell's color is inherited from the surrounding region
// (3x3 channel-max dilation), so lines glow in their area's color.
export function rgbaToLineArt(rgba, dotW, dotH, { edgeGain = 1.0, autoLevels = true } = {}) {
  const cols = dotW >> 1, rows = dotH >> 2;
  const n = dotW * dotH;
  let lo = 0, scale = 1;
  if (autoLevels) ({ lo, scale } = computeLevels(rgba, n));
  const norm = (v) => Math.min(1, Math.max(0, (v - lo) * scale / 255));
  const th = 0.16 / Math.max(0.1, edgeGain);

  const lit = new Uint8Array(n);
  for (let y = 0; y < dotH - 1; y++) {
    for (let x = 0; x < dotW - 1; x++) {
      const o = (y * dotW + x) * 4;
      const ox = o + 4, oy = o + dotW * 4;
      let mag = 0;
      for (let c = 0; c < 3; c++) {
        mag = Math.max(mag,
          Math.abs(norm(rgba[o + c]) - norm(rgba[ox + c])),
          Math.abs(norm(rgba[o + c]) - norm(rgba[oy + c])));
      }
      if (mag > th) lit[y * dotW + x] = 1;
    }
  }

  const codes = new Uint8Array(cols * rows);
  const colors = new Uint8Array(cols * rows);
  const counts = new Uint8Array(8);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      counts.fill(0);
      let code = 0;
      for (let sub = 0; sub < 8; sub++) {
        const dx = sub >> 2, dy = sub & 3;
        const x = cx * 2 + dx, y = cy * 4 + dy;
        if (!lit[y * dotW + x]) continue;
        code |= 1 << ((sub & 3) + (dx ? 4 : 0));
        // region color: channel-wise max over the 3x3 neighborhood — the
        // outline pixel itself is often black, its area is not
        let r = 0, g = 0, b = 0;
        for (let ny = Math.max(0, y - 1); ny <= Math.min(dotH - 1, y + 1); ny++) {
          for (let nx = Math.max(0, x - 1); nx <= Math.min(dotW - 1, x + 1); nx++) {
            const q = (ny * dotW + nx) * 4;
            if (norm(rgba[q]) > r) r = norm(rgba[q]);
            if (norm(rgba[q + 1]) > g) g = norm(rgba[q + 1]);
            if (norm(rgba[q + 2]) > b) b = norm(rgba[q + 2]);
          }
        }
        const m = Math.max(r, g, b, 0.2);
        const d = (r > m * 0.55 ? 2 : 0) | (g > m * 0.55 ? 4 : 0) | (b > m * 0.55 ? 1 : 0);
        counts[d || 7]++;
      }
      let best = 7, bestN = 0;
      for (let c = 1; c < 8; c++) if (counts[c] > bestN) { bestN = counts[c]; best = c; }
      codes[cy * cols + cx] = code;
      colors[cy * cols + cx] = code ? best : 0;
    }
  }
  return { schemaVersion: SCHEMA_VERSION, cols, rows, codes, colors };
}
