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
  const i = cy * buf.cols + cx, b = dotBit(dx, dy);
  // Editing a dot means this cell is semigraphic: drop any glyph flag first and
  // start from a clear pattern (the glyph's code isn't a dot pattern).
  if (buf.text && buf.text[i]) { buf.text[i] = 0; buf.codes[i] = 0; }
  const had = buf.codes[i] & b;
  buf.codes[i] = on ? (buf.codes[i] | b) : (buf.codes[i] & ~b);
  return (!!had) !== (!!on);
}
export function getDot(buf, cx, cy, dx, dy) {
  return (buf.codes[cy * buf.cols + cx] & dotBit(dx, dy)) !== 0;
}

// ---- text/glyph layer -----------------------------------------------------
// A cell can carry a font GLYPH instead of a semigraphic dot pattern: text[i]=1
// marks codes[i] as a CGROM character code (not a dot pattern). The μPD3301
// lets glyph and semigraphic cells coexist within an attribute run, so the
// editor can drop the font's box/shade/quadrant characters onto a converted
// frame. The layer is lazily allocated — a buffer that never gets a glyph stays
// text-free (and serializes without a `text` field).
function ensureText(buf) {
  if (!buf.text) buf.text = new Uint8Array(buf.cols * buf.rows);
  return buf.text;
}
export function isGlyph(buf, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= buf.cols || cy >= buf.rows) return false;
  return !!(buf.text && buf.text[cy * buf.cols + cx]);
}
// Place a font glyph on a cell (codes[i] becomes a char code). Returns success.
export function setGlyph(buf, cx, cy, code) {
  if (cx < 0 || cy < 0 || cx >= buf.cols || cy >= buf.rows) return false;
  const i = cy * buf.cols + cx;
  ensureText(buf)[i] = 1;
  buf.codes[i] = code & 0xff;
  return true;
}
// Revert a cell to (empty) semigraphic — clears the glyph flag and its pattern.
export function clearGlyph(buf, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= buf.cols || cy >= buf.rows) return false;
  const i = cy * buf.cols + cx;
  if (buf.text) buf.text[i] = 0;
  buf.codes[i] = 0;
  return true;
}

// ---- μPD3301 line budget --------------------------------------------------
// Attribute (colour) changes per row: each run of same-colour cells needs one
// attribute code, except a leading BLACK run (the default). This is the count
// the ~20-per-line hardware limit bounds on the 80-col screen — the editor
// paints it red when a row goes over.
export function lineAttrChanges(buf) {
  const { cols, rows, colors, codes, text } = buf;
  const out = new Int32Array(rows);
  for (let y = 0; y < rows; y++) {
    let runs = 0, prev = -1;
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const isText = !!(text && text[i]);
      // empty (unlit) semigraphic cells cost nothing — their colour is invisible
      // and the hardware carries the running attribute across them.
      if (!isText && codes[i] === 0) continue;
      // a new attribute pair is needed whenever the colour OR the semigraphic
      // flag toggles (text glyph ↔ semigraphic tile flip bit4 of the colour
      // spec), so both belong to the run key — matches bufToVram's pair count.
      const key = (colors[i] & 7) | (isText ? 8 : 0);
      if (key !== prev) { runs++; prev = key; }
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
// opts.cgrom — optional Uint8Array (256×16 stride, 8×8 glyph in low 8 lines,
// bit7 = leftmost pixel; same shape demo/font.js builds). When a cell is a
// glyph (buf.text[i]) and a cgrom is given, its 8×8 character is drawn instead
// of the 2×4 semigraphic tile. Without a cgrom, glyph cells fall back to their
// codes read as a dot pattern (harmless, deterministic).
export function renderCells(buf, cellPx, opts = {}) {
  const grid = opts.grid !== false;
  const { cols, rows, codes, colors, text } = buf;
  const cgrom = opts.cgrom;
  const cw = cellPx, ch = cellPx;
  const W = cols * cw, H = rows * ch;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      const code = codes[i], col = colors[i] & 7;
      const p = GRB[col];
      const isText = !!(text && text[i] && cgrom);
      for (let py = 0; py < ch; py++) {
        const dy = Math.min(3, (py * 4 / ch) | 0);
        const grow = isText ? cgrom[code * 16 + Math.min(7, (py * 8 / ch) | 0)] : 0;
        const rowBase = ((cy * ch + py) * W + cx * cw) * 4;
        for (let px = 0; px < cw; px++) {
          let on;
          if (isText) { on = (grow >> (7 - Math.min(7, (px * 8 / cw) | 0))) & 1; }
          else { const dx = px < cw / 2 ? 0 : 1; on = code & dotBit(dx, dy); }
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

// ---- PC-8001 real-hardware export -----------------------------------------
// Encode an ORIGINAL-geometry cell buffer (cols≤80, rows≤25) into N-BASIC text
// VRAM bytes and a POKE program, so a picture drawn here reproduces on a real
// PC-8001 (or another emulator). The μPD3301 text line is 120 bytes: 80 char
// codes + 20 attribute PAIRS (pos,value). A colour-spec value =
// (colour<<5)|0x08|(semigraphic?0x10:0). These mirror pc8001.js
// (ATTR.COLOR_FLAG 0x08 / ATTR.SEMIGRAPHIC 0x10 / TEXT_VRAM 0xF3C8); the export
// test asserts they still agree with the emulator, so the two can't drift.
export const VRAM = Object.freeze({
  BASE: 0xf3c8, COLS: 80, ROWS: 25, ATTR_PAIRS: 20, BYTES_PER_LINE: 120,
  COLOR_FLAG: 0x08, SEMIGRAPHIC: 0x10,
});
export function colorSpec(color, semi) {
  return ((color & 7) << 5) | VRAM.COLOR_FLAG | (semi ? VRAM.SEMIGRAPHIC : 0);
}

// A buffer maps to real hardware only at ORIGINAL geometry (EX/UEX exceed the
// PC-8001's 80×25 text screen). Returns null when it fits, else a reason.
export function vramFitError(buf) {
  if (buf.cols > VRAM.COLS || buf.rows > VRAM.ROWS) {
    return `実機は 80×25 まで（このバッファは ${buf.cols}×${buf.rows}）。ORIGINALモードで作って`;
  }
  return null;
}

// Attribute pairs for one row (a maximal run of same colour+semigraphic-flag
// costs one pair; empty cells inherit). Returns { pairs:[pos,val,...], over }.
function rowPairs(buf, y) {
  const { cols, colors, codes, text } = buf;
  const pairs = [];
  let curSpec = -1;
  for (let x = 0; x < cols && x < VRAM.COLS; x++) {
    const i = y * cols + x;
    const isText = !!(text && text[i]);
    if (!isText && codes[i] === 0) continue; // empty carries the running attr
    const spec = colorSpec(colors[i] & 7, isText ? 0 : 1);
    if (spec !== curSpec) { pairs.push(x, spec); curSpec = spec; }
  }
  return { pairs, over: pairs.length / 2 > VRAM.ATTR_PAIRS };
}

// Build the full text-VRAM image (rows × 120 bytes) ready to POKE at BASE.
// overRows lists rows exceeding the 20-pair budget (export should refuse/warn).
export function bufToVram(buf) {
  const cols = Math.min(buf.cols, VRAM.COLS);
  const rows = Math.min(buf.rows, VRAM.ROWS);
  const bpl = VRAM.BYTES_PER_LINE;
  const mem = new Uint8Array(rows * bpl);
  const overRows = [];
  for (let y = 0; y < rows; y++) {
    const lb = y * bpl;
    for (let x = 0; x < cols; x++) mem[lb + x] = buf.codes[y * buf.cols + x];
    const { pairs, over } = rowPairs(buf, y);
    if (over) overRows.push(y);
    const n = Math.min(pairs.length, VRAM.ATTR_PAIRS * 2);
    for (let k = 0; k < n; k++) mem[lb + VRAM.COLS + k] = pairs[k];
  }
  return { base: VRAM.BASE, bytesPerLine: bpl, cols, rows, mem, overRows };
}

// Is a VRAM line all-default (no codes, no attrs)? Such lines are left to CLS.
function lineBlank(mem, lb, cols) {
  for (let i = 0; i < VRAM.BYTES_PER_LINE; i++) if (mem[lb + i]) return false;
  return true;
}

// Emit an N-BASIC program that POKEs the VRAM image and holds the picture.
// Per non-blank line the DATA carries: base-address, 80 code bytes, a pair-byte
// count P, then P attribute bytes (the reader zeroes slots P..39 so leftover CLS
// attributes can't bleed). A -1 address ends the list. Deterministic.
// NOTE: the emitted BYTES are verified against machine.js in the test; BASIC
// *execution* (WIDTH/CONSOLE/mode on real silicon) is not headless-checkable.
export function vramToBasic(vram, { name = 'ART', dataLine = 1000, dataStep = 10 } = {}) {
  const { base, bytesPerLine, rows, cols, mem } = vram;
  const src = [
    '10 REM ' + String(name).slice(0, 40).replace(/[\r\n]/g, ' '),
    '20 WIDTH 80,25:CONSOLE 0,25,0,1:COLOR 7,0,0:CLS',
    '30 READ A:IF A<0 THEN 70',
    '40 FOR I=0 TO 79:READ D:POKE A+I,D:NEXT',
    '50 READ P:FOR I=0 TO P-1:READ D:POKE A+80+I,D:NEXT:FOR I=P TO 39:POKE A+80+I,0:NEXT',
    '60 GOTO 30',
    '70 K$=INKEY$:IF K$="" THEN 70',
    '80 END',
  ];
  const nums = [];
  for (let y = 0; y < rows; y++) {
    const lb = y * bytesPerLine;
    if (lineBlank(mem, lb, cols)) continue;
    nums.push(base + y * bytesPerLine);
    for (let x = 0; x < VRAM.COLS; x++) nums.push(mem[lb + x]);
    let p = VRAM.ATTR_PAIRS * 2;
    while (p > 0 && mem[lb + VRAM.COLS + p - 1] === 0) p--; // trim trailing 0 pairs
    nums.push(p);
    for (let k = 0; k < p; k++) nums.push(mem[lb + VRAM.COLS + k]);
  }
  nums.push(-1);
  // pack DATA into ~200-char lines (N-BASIC's line length is finite)
  let dl = dataLine, cur = '';
  const flush = () => { if (cur) { src.push(dl + ' DATA ' + cur); dl += dataStep; cur = ''; } };
  for (const v of nums) {
    const t = (cur ? cur + ',' : '') + v;
    if (t.length > 200) { flush(); cur = '' + v; } else cur = t;
  }
  flush();
  return src.join('\n') + '\n';
}
