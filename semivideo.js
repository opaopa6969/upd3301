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

// Empty cells (no lit dots) carry the previous cell's color: their color is
// invisible anyway, and merging runs keeps the (position, value) pair count
// per row tiny. Without this, line art alternating lit/empty cells emits a
// pair per cell — ORIGINAL mode's 20 pairs/row run out halfway and the rest
// of the row inherits a black attribute: dots render black-on-black and the
// right half of rows "disappears".
function carryEmptyCellColors(codes, colors, cols, rows) {
  for (let cy = 0; cy < rows; cy++) {
    let carry = 0;
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      if (codes[i] === 0) colors[i] = carry;
      else carry = colors[i];
    }
  }
}

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

// temporalPhase: null = plain 2-level dither. With temporalLevels = L and
// phase cycling 0..L-2, each channel quantizes to L duty levels over an
// (L-1)-frame cycle — L=3 is the 27-color flicker (Bemaga-style), L=8 gives
// 8³ = 512 colors, which is no longer what the word "attribute" was ever
// meant to carry ｗ. Lit frames are stride-distributed inside the cycle so
// mid levels shimmer instead of strobing; watch through a long-persistence
// phosphor.
export function rgbaToSemigraphic(rgba, dotW, dotH, { gain = 1.0, autoLevels = false, temporalPhase = null, temporalLevels = 3 } = {}) {
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
          const N = temporalLevels - 1; // frames per cycle
          // FRC-style spatial phase stagger: neighbours flash at different
          // times, so any frame's spatial average equals the target level —
          // shimmer instead of whole-screen strobing. (N=2 degenerates to
          // the classic checkerboard alternation.)
          const off = (x * 3 + y * 5) % N;
          const ord = (((temporalPhase + off) % N) * (N === 2 ? 1 : 3)) % N;
          for (let c = 0; c < 3; c++) {
            const v = Math.min(1, Math.max(0, (rgba[o + c] - lo) * scale / 255 * gain));
            const lv = v * N, q = Math.min(N, Math.floor(lv) + ((lv - Math.floor(lv)) > th ? 1 : 0));
            if (ord < q) d |= [2, 4, 1][c]; // duty q/N over the cycle
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
  carryEmptyCellColors(codes, colors, cols, rows);
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
  carryEmptyCellColors(codes, colors, cols, rows);
  return { schemaVersion: SCHEMA_VERSION, cols, rows, codes, colors };
}

// "α" mode — flat cel-shaded fills in the PC-8001 8-colour CELL format, after
// the SQUARE ALPHA demo look: each region is painted SOLID with its dominant
// 8-colour and the region boundaries are left dark (the black anime outline).
// Unlike line-art (outlines only) this fills the interiors; unlike dither it
// does not screen — flat colour, the hand-drawn semigraphic-anime aesthetic.
// Cell-based (codes+colors), so it renders through the same μPD3301 path as the
// dither/line modes. `edgeGain` thickens/thins the outline, `fillDark` is the
// floor below which a gun stays off (raise it for a blacker, bolder look).
export function rgbaToAlpha(rgba, dotW, dotH, { gain = 1.0, autoLevels = true, edgeGain = 1.0, fillDark = 0.28 } = {}) {
  const cols = dotW >> 1, rows = dotH >> 2, n = dotW * dotH;
  let lo = 0, scale = 1;
  if (autoLevels) ({ lo, scale } = computeLevels(rgba, n));
  const norm = (v) => Math.min(1, Math.max(0, (v - lo) * scale / 255 * gain));
  // region-boundary map → the black outline (those dots are kept unlit)
  const eth = 0.16 / Math.max(0.1, edgeGain);
  const edge = new Uint8Array(n);
  for (let y = 0; y < dotH - 1; y++) {
    for (let x = 0; x < dotW - 1; x++) {
      const o = (y * dotW + x) * 4, ox = o + 4, oy = o + dotW * 4;
      let mag = 0;
      for (let c = 0; c < 3; c++) mag = Math.max(mag, Math.abs(norm(rgba[o + c]) - norm(rgba[ox + c])), Math.abs(norm(rgba[o + c]) - norm(rgba[oy + c])));
      if (mag > eth) edge[y * dotW + x] = 1;
    }
  }
  // per-dot flat colour: a gun turns on when it's within `hueK` of the dot's
  // BRIGHTEST gun, so the hue survives regardless of lightness (a pale colour
  // keeps its colour instead of washing to white); below `fillDark` → black.
  const hueK = 0.72;
  const dotCol = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4, r = norm(rgba[o]), g = norm(rgba[o + 1]), b = norm(rgba[o + 2]), mx = Math.max(r, g, b);
    dotCol[i] = mx < fillDark ? 0 : ((r >= mx * hueK ? 2 : 0) | (g >= mx * hueK ? 4 : 0) | (b >= mx * hueK ? 1 : 0));
  }
  const codes = new Uint8Array(cols * rows), colors = new Uint8Array(cols * rows);
  const counts = new Uint8Array(8);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      counts.fill(0); let code = 0;
      for (let sub = 0; sub < 8; sub++) {
        const dx = sub >> 2, dy = sub & 3, x = cx * 2 + dx, y = cy * 4 + dy, i = y * dotW + x;
        if (edge[i]) continue;                    // outline → dark dot
        code |= 1 << ((sub & 3) + (dx ? 4 : 0));   // filled dot
        counts[dotCol[i]]++;
      }
      // dominant fill colour among the lit dots — weight black down a touch so a
      // thin coloured area beats a near-tie with black rather than washing out.
      let best = 0, bestW = -1;
      for (let c = 0; c < 8; c++) { const w = counts[c] * (c === 0 ? 0.7 : 1); if (w > bestW) { bestW = w; best = c; } }
      codes[cy * cols + cx] = code;
      colors[cy * cols + cx] = code ? best : 0;
    }
  }
  carryEmptyCellColors(codes, colors, cols, rows);
  return { schemaVersion: SCHEMA_VERSION, cols, rows, codes, colors };
}

// "適応" — the honest PC-8001 optimiser. The μPD3301 allows only ~20 attribute
// (colour) changes per LINE, so colouring every cell freely isn't real hardware.
// This mode looks at the WHOLE frame (one frame of latency is fine), auto-tunes
// the fill floor + edge threshold from the frame's colour/contrast stats, and
// then spends each row's ~20-colour budget optimally: it greedily merges colour
// runs cheapest-error-first down to the budget, but RESISTS merging across
// strong vertical edges (columns where many rows disagree) so breaks line up
// between rows instead of shattering — you can't get this right looking at one
// line alone. Dots are the flat-fill/outline pattern (like α); only the colour
// is budgeted. `maxPairs` = per-line colour changes, `coherence` = how hard to
// hold vertical edges (0 = per-line independent, 1 = strongly aligned).
export function rgbaToAdaptive(rgba, dotW, dotH, { maxPairs = 20, coherence = 0.5, satBias = 0, edgeGain = 1 } = {}) {
  const cols = dotW >> 1, rows = dotH >> 2, n = dotW * dotH, cN = cols * rows;
  // adaptive mode OWNS its levels/gain/saturation — the auto-levels toggle and
  // the GAIN knob don't apply here (adapting these IS the mode).
  const { lo, scale } = computeLevels(rgba, n);
  const norm = (v) => Math.min(1, Math.max(0, (v - lo) * scale / 255));

  // whole-frame stats → adaptive fill floor + edge threshold (the "アダプティブ"):
  // washed-out/low-saturation footage keeps more colour (lower floor); a busy,
  // saturated frame raises the edge threshold so fine chroma noise stops
  // spending outline budget.
  let sumS = 0, sumMax = 0;
  for (let i = 0; i < n; i++) { const o = i * 4, r = norm(rgba[o]), g = norm(rgba[o + 1]), b = norm(rgba[o + 2]); const mx = Math.max(r, g, b); sumS += mx - Math.min(r, g, b); sumMax += mx; }
  const meanS = sumS / n, meanMax = sumMax / n;
  // 色ノリ lever: a gun turns on when it's within `hueK` of the cell's BRIGHTEST
  // gun, so the HUE survives regardless of lightness — a pale colour keeps its
  // colour instead of washing to white. Higher hueK = fewer guns = more
  // saturated; washed-out frames (low meanS) get a higher hueK to pull colour
  // out. This adaptive floor/hue is exactly the "GAINを自動で" the user wanted.
  const hueK = Math.max(0.45, Math.min(0.95, 0.72 + (0.18 - meanS) * 0.6 + satBias)); // satBias = 色ノリ knob
  const floor = 0.12;                 // below this a cell is genuinely dark → black
  const eth = (0.13 + meanS * 0.12) / Math.max(0.3, edgeGain); // edgeGain = 輪郭 knob (higher → thicker/more outline)

  // region-boundary map → dark outline dots
  const edge = new Uint8Array(n);
  for (let y = 0; y < dotH - 1; y++) {
    for (let x = 0; x < dotW - 1; x++) {
      const o = (y * dotW + x) * 4, ox = o + 4, oy = o + dotW * 4;
      let mag = 0; for (let c = 0; c < 3; c++) mag = Math.max(mag, Math.abs(norm(rgba[o + c]) - norm(rgba[ox + c])), Math.abs(norm(rgba[o + c]) - norm(rgba[oy + c])));
      if (mag > eth) edge[y * dotW + x] = 1;
    }
  }
  // per-cell mean colour (for the budgeting)
  const cr = new Float32Array(cN), cg = new Float32Array(cN), cb = new Float32Array(cN);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let sr = 0, sg = 0, sb = 0;
      for (let sub = 0; sub < 8; sub++) { const dx = sub >> 2, dy = sub & 3, o = ((cy * 4 + dy) * dotW + (cx * 2 + dx)) * 4; sr += norm(rgba[o]); sg += norm(rgba[o + 1]); sb += norm(rgba[o + 2]); }
      const i = cy * cols + cx; cr[i] = sr / 8; cg[i] = sg / 8; cb[i] = sb / 8;
    }
  }
  // vertical-edge weight per boundary column: how strongly rows disagree across
  // it, summed over the whole frame → the columns worth keeping a break at.
  const bw = new Float32Array(cols);
  for (let cy = 0; cy < rows; cy++) for (let cx = 1; cx < cols; cx++) {
    const a = cy * cols + cx - 1, b = cy * cols + cx;
    bw[cx] += Math.abs(cr[a] - cr[b]) + Math.abs(cg[a] - cg[b]) + Math.abs(cb[a] - cb[b]);
  }
  let bwMax = 1e-6; for (let cx = 1; cx < cols; cx++) if (bw[cx] > bwMax) bwMax = bw[cx];

  const codes = new Uint8Array(cN), colors = new Uint8Array(cN);
  const quant = (r, g, b) => { const mx = Math.max(r, g, b); if (mx < floor) return 0; const t = mx * hueK; return (r >= t ? 2 : 0) | (g >= t ? 4 : 0) | (b >= t ? 1 : 0); };

  for (let cy = 0; cy < rows; cy++) {
    const rn = [];
    for (let cx = 0; cx < cols; cx++) { const i = cy * cols + cx; rn.push({ s: cx, e: cx, n: 1, r: cr[i], g: cg[i], b: cb[i] }); }
    const cost = (a) => { const A = rn[a], B = rn[a + 1], w = A.n * B.n / (A.n + B.n); return ((A.r - B.r) ** 2 + (A.g - B.g) ** 2 + (A.b - B.b) ** 2) * w + coherence * (bw[B.s] / bwMax); };
    while (rn.length > maxPairs) {
      let bi = 0, bc = Infinity;
      for (let a = 0; a + 1 < rn.length; a++) { const c = cost(a); if (c < bc) { bc = c; bi = a; } }
      const A = rn[bi], B = rn[bi + 1], N = A.n + B.n;
      A.r = (A.r * A.n + B.r * B.n) / N; A.g = (A.g * A.n + B.g * B.n) / N; A.b = (A.b * A.n + B.b * B.n) / N;
      A.e = B.e; A.n = N; rn.splice(bi + 1, 1);
    }
    for (const run of rn) {
      const col = quant(run.r, run.g, run.b);
      for (let cx = run.s; cx <= run.e; cx++) {
        let code = 0;
        for (let sub = 0; sub < 8; sub++) { const dx = sub >> 2, dy = sub & 3, di = (cy * 4 + dy) * dotW + (cx * 2 + dx); if (edge[di]) continue; code |= 1 << ((sub & 3) + (dx ? 4 : 0)); }
        const i = cy * cols + cx; codes[i] = code; colors[i] = code ? col : 0;
      }
    }
  }
  carryEmptyCellColors(codes, colors, cols, rows);
  return { schemaVersion: SCHEMA_VERSION, cols, rows, codes, colors, meta: { hueK, floor, eth } };
}

// PC-98 style: outlines + interiors flat-filled with an adaptive 16-color
// palette picked from the 512 cube (the "16 colors out of the analog
// palette" culture, one palette per picture). This mode ignores the μPD3301
// entirely — no cells, no attribute pairs: per-dot color, straight to the
// framebuffer, the way the 16-bit machines across the street did it.
//
// analyzePc98: per frame — edge map (region boundaries, same detector as
// line art), 512-cube quantization histogram → top-16 palette, and a
// Bayer-dithered palette index per dot (LUT over all 512 keys, so the
// per-dot work is a lookup).
export function analyzePc98(rgba, dotW, dotH, { gain = 1.0, autoLevels = true } = {}) {
  const n = dotW * dotH;
  let lo = 0, scale = 1;
  if (autoLevels) ({ lo, scale } = computeLevels(rgba, n));
  // levels as a 256-entry LUT: the closure version was ~600k calls/frame
  const NLUT = new Float32Array(256);
  for (let v = 0; v < 256; v++) NLUT[v] = Math.min(1, Math.max(0, (v - lo) * scale / 255 * gain));
  const norm = (v) => NLUT[v];

  // edge map: per-channel region boundaries (anime = flat fills)
  const edge = new Uint8Array(n);
  const eth = 0.16;
  for (let y = 0; y < dotH - 1; y++) {
    for (let x = 0; x < dotW - 1; x++) {
      const o = (y * dotW + x) * 4, ox = o + 4, oy = o + dotW * 4;
      let mag = 0;
      for (let c = 0; c < 3; c++) {
        mag = Math.max(mag,
          Math.abs(norm(rgba[o + c]) - norm(rgba[ox + c])),
          Math.abs(norm(rgba[o + c]) - norm(rgba[oy + c])));
      }
      if (mag > eth) edge[y * dotW + x] = 1;
    }
  }

  // histogram over the 512 cube (8 levels per gun), interiors only
  const hist = new Uint32Array(512);
  const keyOf = (o) => {
    const r = Math.round(norm(rgba[o]) * 7);
    const g = Math.round(norm(rgba[o + 1]) * 7);
    const b = Math.round(norm(rgba[o + 2]) * 7);
    return (r << 6) | (g << 3) | b;
  };
  for (let i = 0; i < n; i++) if (!edge[i]) hist[keyOf(i * 4)]++;
  // top 16 by popularity, deterministic tie-break on key
  const order = Array.from({ length: 512 }, (_, k) => k)
    .filter((k) => hist[k] > 0)
    .sort((a, b) => hist[b] - hist[a] || a - b)
    .slice(0, 16);
  if (order.length === 0) order.push(0);
  const palette = new Uint8Array(order.length * 3);
  order.forEach((k, i) => {
    palette[i * 3] = (k >> 6) & 7;
    palette[i * 3 + 1] = (k >> 3) & 7;
    palette[i * 3 + 2] = k & 7;
  });
  // nearest-palette LUT over all 512 keys
  const lut = new Uint8Array(512);
  for (let k = 0; k < 512; k++) {
    const kr = (k >> 6) & 7, kg = (k >> 3) & 7, kb = k & 7;
    let best = 0, bd = 1e9;
    for (let p = 0; p < order.length; p++) {
      const dr = kr - palette[p * 3], dg = kg - palette[p * 3 + 1], db = kb - palette[p * 3 + 2];
      const d = dr * dr + dg * dg * 1.5 + db * db; // green weighs a little more
      if (d < bd) { bd = d; best = p; }
    }
    lut[k] = best;
  }
  // per-dot palette index, ordered dither (±half a level) before the lookup
  const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  const palDot = new Uint8Array(n);
  for (let y = 0; y < dotH; y++) {
    for (let x = 0; x < dotW; x++) {
      const i = y * dotW + x, o = i * 4;
      const jit = ((BAYER[y & 3][x & 3] + 0.5) / 16 - 0.5) / 7;
      let key = 0;
      for (let c = 0; c < 3; c++) {
        const q = Math.round(Math.min(1, Math.max(0, norm(rgba[o + c]) + jit)) * 7);
        key = (key << 3) | q;
      }
      palDot[i] = lut[key];
    }
  }
  // FRC tables: GRB bits per (palette entry, temporal order) and the
  // spatial phase offset per dot — the per-phase render becomes 3 lookups
  const bitsTable = new Uint8Array(order.length * 7);
  for (let p = 0; p < order.length; p++) {
    for (let ord = 0; ord < 7; ord++) {
      bitsTable[p * 7 + ord] = (ord < palette[p * 3] ? 2 : 0)
        | (ord < palette[p * 3 + 1] ? 4 : 0)
        | (ord < palette[p * 3 + 2] ? 1 : 0);
    }
  }
  const ordBase = new Uint8Array(n);
  for (let y = 0; y < dotH; y++) {
    for (let x = 0; x < dotW; x++) ordBase[y * dotW + x] = (x * 3 + y * 5) % 7;
  }
  return { schemaVersion: SCHEMA_VERSION, dotW, dotH, palette, palDot, edge, bitsTable, ordBase };
}

// One temporal phase (0..6) of the analyzed frame → GRB-indexed dots.
// Palette levels 0..7 become per-gun duty over the 7-frame FRC cycle;
// outlines stay black on every phase.
export function renderPc98Phase(analysis, phase, out = null) {
  const { dotW, dotH, palDot, edge, bitsTable, ordBase } = analysis;
  const n = dotW * dotH;
  const idx = out && out.length === n ? out : new Uint8Array(n);
  const SPREAD = [0, 3, 6, 2, 5, 1, 4]; // ord*3 mod 7, precomputed
  const ph = phase % 7;
  for (let i = 0; i < n; i++) {
    if (edge[i]) { idx[i] = 0; continue; }
    let o = ordBase[i] + ph;
    if (o >= 7) o -= 7;
    idx[i] = bitsTable[palDot[i] * 7 + SPREAD[o]];
  }
  return idx;
}

// Full-color mode: no palette, no cells — every dot quantizes each gun to
// 8 duty levels through a selectable screening pattern, then FRC displays
// the 512-cube color. This is the same math you look at every day: LCD
// frame-rate control, print halftones, newspaper photos.
//
// Patterns:
//  'bayer'    — dispersed-dot ordered dither (the computer classic)
//  'halftone' — clustered-dot screens, rotated per gun (15°/75°/0°) the way
//               print separations avoid moiré — gradients grow round dots
//               and the overlaps make the offset-print rosette
//  'line'     — line screen, per-gun angles
const _thCache = { key: '', data: null };
function screenThresholds(dotW, dotH, pattern) {
  const key = `${dotW}x${dotH}:${pattern}`;
  if (_thCache.key === key) return _thCache.data;
  const n = dotW * dotH;
  const th = new Float32Array(n * 3);
  const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  const angles = [15, 75, 0].map((a) => a * Math.PI / 180);
  const P = 4; // screen pitch in dots
  for (let y = 0; y < dotH; y++) {
    for (let x = 0; x < dotW; x++) {
      for (let c = 0; c < 3; c++) {
        let t;
        if (pattern === 'halftone') {
          const u = (x * Math.cos(angles[c]) + y * Math.sin(angles[c])) / P;
          const v = (-x * Math.sin(angles[c]) + y * Math.cos(angles[c])) / P;
          t = 0.5 + 0.25 * (Math.cos(2 * Math.PI * u) + Math.cos(2 * Math.PI * v));
        } else if (pattern === 'line') {
          const u = (x * Math.sin(angles[c]) + y * Math.cos(angles[c])) / P;
          t = 0.5 + 0.5 * Math.sin(2 * Math.PI * u);
        } else {
          t = (BAYER[y & 3][x & 3] + 0.5) / 16;
        }
        th[(y * dotW + x) * 3 + c] = Math.min(0.98, Math.max(0.02, t));
      }
    }
  }
  _thCache.key = key;
  _thCache.data = th;
  return th;
}

// → per-dot per-gun duty levels 0..7 (Uint8Array n*3)
export function analyzeFullColor(rgba, dotW, dotH, { gain = 1.0, autoLevels = true, pattern = 'bayer' } = {}) {
  const n = dotW * dotH;
  let lo = 0, scale = 1;
  if (autoLevels) ({ lo, scale } = computeLevels(rgba, n));
  const NLUT = new Float32Array(256);
  for (let v = 0; v < 256; v++) NLUT[v] = Math.min(1, Math.max(0, (v - lo) * scale / 255 * gain));
  const th = screenThresholds(dotW, dotH, pattern);
  const levels = new Uint8Array(n * 3);
  const ordBase = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const lv = NLUT[rgba[o + c]] * 7;
      const base = Math.floor(lv);
      levels[i * 3 + c] = Math.min(7, base + ((lv - base) > th[i * 3 + c] ? 1 : 0));
    }
    ordBase[i] = ((i % dotW) * 3 + Math.floor(i / dotW) * 5) % 7;
  }
  return { schemaVersion: SCHEMA_VERSION, dotW, dotH, levels, ordBase };
}

export function renderFullColorPhase(analysis, phase, out = null) {
  const { dotW, dotH, levels, ordBase } = analysis;
  const n = dotW * dotH;
  const idx = out && out.length === n ? out : new Uint8Array(n);
  const SPREAD = [0, 3, 6, 2, 5, 1, 4];
  const ph = phase % 7;
  for (let i = 0; i < n; i++) {
    let o = ordBase[i] + ph;
    if (o >= 7) o -= 7;
    const ord = SPREAD[o];
    idx[i] = (ord < levels[i * 3] ? 2 : 0)
      | (ord < levels[i * 3 + 1] ? 4 : 0)
      | (ord < levels[i * 3 + 2] ? 1 : 0);
  }
  return idx;
}
