// semiedit — pure helpers for the manual semigraphic attribute/dot editor.
//
// Operates on a "cell buffer": the same { cols, rows, codes, colors } shape
// semivideo.js emits, so a paused/converted frame drops straight in. This is
// the μPD3301's own model:
//   codes[i]  — 8-bit semigraphic dot pattern. dot(dx∈0..1, dy∈0..3) is
//               bit (dy + dx*4): left column bits 0-3 (top→bottom), right 4-7.
//               (Exactly semivideo.js's `1 << ((sub&3) + (dx?4:0))`.)
//   colors[i] — per-cell GRB attribute 0..7 (bit R=2, G=4, B=1).
//   text[i]   — OPTIONAL parallel layer (Uint8Array): if text && text[i], the
//               cell is a TEXT/graphic character (codes[i] is a char code, not
//               a dot pattern). Lets the editor mix semigraphics with the
//               font's box/shade/quadrant glyphs — the hardware allows it
//               per attribute run. Phase-1 editor writes semigraphics only;
//               the field rides along so nothing has to change to add glyphs.
//
// Pure, dependency-free, deterministic — headless-testable (semiedit.test.mjs).

export const SCHEMA_VERSION = 1;

// GRB index → display RGB. Index bits: bit0=B, bit1=R, bit2=G (so 0 black …
// 7 white). Matches the demo's semigraphic palette so the editor view and the
// CRT view agree.
export const GRB = [
  [0, 0, 0], [40, 60, 255], [255, 50, 50], [255, 60, 240],
  [50, 230, 60], [60, 235, 235], [255, 235, 60], [240, 240, 240],
];
export const GRB_NAMES = ['黒', '青', '赤', '紫', '緑', '水', '黄', '白'];

export function dotBit(dx, dy) { return 1 << ((dy & 3) + (dx ? 4 : 0)); }

export function emptyBuf(cols, rows) {
  return {
    schemaVersion: SCHEMA_VERSION, cols, rows,
    codes: new Uint8Array(cols * rows),
    colors: new Uint8Array(cols * rows),
  };
}

export function cloneBuf(buf) {
  return {
    schemaVersion: SCHEMA_VERSION, cols: buf.cols, rows: buf.rows,
    codes: Uint8Array.from(buf.codes),
    colors: Uint8Array.from(buf.colors),
    ...(buf.text ? { text: Uint8Array.from(buf.text) } : {}),
  };
}

// ---- edits (mutating; callers snapshot for undo) --------------------------
export function setColor(buf, cx, cy, col) {
  if (cx < 0 || cy < 0 || cx >= buf.cols || cy >= buf.rows) return false;
  buf.colors[cy * buf.cols + cx] = col & 7;
  return true;
}
// Set one dot within a cell (on=true lights it, false clears). Returns whether
// the cell's code changed.
export function setDot(buf, cx, cy, dx, dy, on) {
  if (cx < 0 || cy < 0 || cx >= buf.cols || cy >= buf.rows) return false;
  const i = cy * buf.cols + cx, b = dotBit(dx, dy), had = buf.codes[i] & b;
  buf.codes[i] = on ? (buf.codes[i] | b) : (buf.codes[i] & ~b);
  return (!!had) !== (!!on);
}
export function getDot(buf, cx, cy, dx, dy) {
  return (buf.codes[cy * buf.cols + cx] & dotBit(dx, dy)) !== 0;
}

// ---- μPD3301 line budget --------------------------------------------------
// Attribute (colour) changes per row: each run of same-colour cells needs one
// attribute code, except a leading BLACK run (the default). This is the count
// the ~20-per-line hardware limit bounds on the 80-col screen — the editor
// paints it red when a row goes over.
export function lineAttrChanges(buf) {
  const { cols, rows, colors, codes } = buf;
  const out = new Int32Array(rows);
  for (let y = 0; y < rows; y++) {
    let runs = 0, prev = -1;
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      // empty (unlit) cells cost nothing — their colour is invisible and the
      // hardware carries the running attribute across them.
      if (codes[i] === 0) continue;
      const c = colors[i] & 7;
      if (c !== prev) { runs++; prev = c; }
    }
    // a single leading run of the default colour (black, 0) is free
    out[y] = runs;
  }
  return out;
}

// ---- crisp editor render (pure) -------------------------------------------
// Returns { width, height, rgba } — the buffer drawn at cellPx per cell, dots
// square-ish (cell split 2 wide × 4 tall). Optional 1px cell grid. This is the
// EDITOR view (clean, zoomable); the CRT view stays with the phosphor/tube
// pipeline. Deterministic.
export function renderCells(buf, cellPx, opts = {}) {
  const grid = opts.grid !== false;
  const { cols, rows, codes, colors } = buf;
  const cw = cellPx, ch = cellPx;
  const W = cols * cw, H = rows * ch;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      const code = codes[i], col = colors[i] & 7;
      const p = GRB[col];
      for (let py = 0; py < ch; py++) {
        const dy = Math.min(3, (py * 4 / ch) | 0);
        const rowBase = ((cy * ch + py) * W + cx * cw) * 4;
        for (let px = 0; px < cw; px++) {
          const dx = px < cw / 2 ? 0 : 1;
          const on = code & dotBit(dx, dy);
          let r = on ? p[0] : 0, g = on ? p[1] : 0, b = on ? p[2] : 0;
          if (grid && (px === 0 || py === 0)) { r = (r + 46) >> 1; g = (g + 52) >> 1; b = (b + 60) >> 1; }
          const o = rowBase + px * 4;
          rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
        }
      }
    }
  }
  return { width: W, height: H, rgba };
}

// ---- serialize (JSON-safe) ------------------------------------------------
export function serialize(buf, meta = {}) {
  return {
    v: SCHEMA_VERSION, kind: 'semigraphic-cells', ...meta,
    cols: buf.cols, rows: buf.rows,
    codes: Array.from(buf.codes), colors: Array.from(buf.colors),
    ...(buf.text ? { text: Array.from(buf.text) } : {}),
  };
}
export function deserialize(obj) {
  if (!obj || !Number.isInteger(obj.cols) || !Number.isInteger(obj.rows)) throw new Error('bad cell buffer');
  const n = obj.cols * obj.rows;
  const codes = new Uint8Array(n), colors = new Uint8Array(n);
  const oc = obj.codes || [], ok = obj.colors || [];
  for (let i = 0; i < n; i++) { codes[i] = oc[i] | 0; colors[i] = (ok[i] | 0) & 7; }
  const buf = { schemaVersion: SCHEMA_VERSION, cols: obj.cols, rows: obj.rows, codes, colors };
  if (Array.isArray(obj.text)) { const t = new Uint8Array(n); for (let i = 0; i < n; i++) t[i] = obj.text[i] ? 1 : 0; buf.text = t; }
  return buf;
}
