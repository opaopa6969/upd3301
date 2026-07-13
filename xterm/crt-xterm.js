// crt-xterm — an xterm.js renderer addon that pushes the terminal through
// the 1979 glass: cells → 8×8 bitmap glyphs → GRB-indexed low-res frame →
// CrtPhosphor (decay physics) → CrtTube (mask/barrel/scanlines) → canvas.
//
// Design constraints, same as the rest of this repo:
// - xterm.js is a *peer*: we never import it. activate(terminal) hands us
//   the one object we read (buffer, cols/rows, events), so the addon works
//   against any xterm.js the page loaded (CDN, bundler, whatever).
// - The raster core (color quantization, glyph blitting, cursor/selection
//   inversion) is pure and headless — it takes a plain "view" object and a
//   Uint8Array, so tests feed it fakes without a DOM.
// - Deterministic: no Math.random. Flicker/blink phases are frame-counted,
//   exactly like demo/crt-panel.js.
// - 1979 rules: everything is quantized to the 8 GRB colors the PC-8001
//   could actually show. `strict1979` additionally drops per-cell
//   backgrounds (the real machine had none — reverse video was all you got).
//
// Out of scope (documented, not hidden): CJK/Unicode glyphs (you get the
// tofu), IME preview overlay, and xterm's own decorations layer. Input,
// selection *behavior* and clipboard stay 100% xterm.js — we only replace
// the photons.

import { CrtPhosphor, PHOSPHORS } from '../crt.js';
import { CrtTube, MASKS } from '../tube.js';
import { G } from '../demo/font.js';

export const SCHEMA_VERSION = 1;
export { PHOSPHORS, MASKS }; // re-export so a page needs one import only

// ---------------------------------------------------------------------------
// Color: everything lands on the 8 GRB colors (G=bit2, R=bit1, B=bit0 — the
// μPD3301 attribute layout, see crt.js indexToRgb).
// ---------------------------------------------------------------------------

// ANSI 0-7 → GRB index (same table as term.js — black red green yellow blue
// magenta cyan white in GRB bit order).
export const ANSI_TO_GRB = [0, 2, 4, 6, 1, 3, 5, 7];

// Nearest-GRB quantization with luminance rescue: a plain per-channel
// threshold at 128 sends every dark color (navy, maroon…) to black, which
// erases text. A 1979 monitor showed navy as BLUE — one phosphor, driven.
// So: threshold each channel against half of the *brightest* channel, and
// only give up (black) when the whole pixel is near-dark.
export function rgbToGrb(r, g, b) {
  const m = Math.max(r, g, b);
  if (m < 48) return 0;
  const t = m / 2;
  return ((g >= t ? 1 : 0) << 2) | ((r >= t ? 1 : 0) << 1) | (b >= t ? 1 : 0);
}

// xterm's 256-color palette, reduced to GRB. 0-15 map through the ANSI
// table directly (bright variants land on the same GRB color — there is no
// intensity bit on this glass). 16-231 is the 6×6×6 cube, 232-255 the
// grayscale ramp; both go through rgbToGrb. Precomputed once: 256 bytes.
export const PALETTE_TO_GRB = (() => {
  const out = new Uint8Array(256);
  const CUBE = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 256; i++) {
    if (i < 16) { out[i] = ANSI_TO_GRB[i & 7]; continue; }
    if (i < 232) {
      const c = i - 16;
      out[i] = rgbToGrb(CUBE[(c / 36) | 0], CUBE[((c / 6) | 0) % 6], CUBE[c % 6]);
    } else {
      const v = 8 + 10 * (i - 232);
      out[i] = rgbToGrb(v, v, v);
    }
  }
  return out;
})();

// Read one xterm IBufferCell into {fg, bg} GRB indexes. Uses only the
// public IBufferCell API (isFgRGB/isFgPalette/getFgColor/...), so a test
// fake with those five methods per side is a valid cell.
export function cellToGrb(cell, defaultFg = 7, defaultBg = 0) {
  let fg = defaultFg, bg = defaultBg;
  if (cell.isFgRGB()) {
    const v = cell.getFgColor();
    fg = rgbToGrb((v >> 16) & 255, (v >> 8) & 255, v & 255);
  } else if (cell.isFgPalette()) fg = PALETTE_TO_GRB[cell.getFgColor() & 255];
  if (cell.isBgRGB()) {
    const v = cell.getBgColor();
    bg = rgbToGrb((v >> 16) & 255, (v >> 8) & 255, v & 255);
  } else if (cell.isBgPalette()) bg = PALETTE_TO_GRB[cell.getBgColor() & 255];
  return { fg, bg };
}

// ---------------------------------------------------------------------------
// Font: 5×7 glyphs in an 8×8 cell. demo/font.js has uppercase, digits and a
// few symbols; a login shell is mostly lowercase, so the missing printable
// ASCII lives here in the same hand-drawn format. Anything else (CJK,
// box-drawing, emoji) renders as the checkerboard tofu — Japanese glyphs
// are explicitly out of scope for this addon.
// ---------------------------------------------------------------------------

export const EXTRA_GLYPHS = {
  a: '00000 00000 01110 00001 01111 10001 01111',
  b: '10000 10000 11110 10001 10001 10001 11110',
  c: '00000 00000 01110 10000 10000 10001 01110',
  d: '00001 00001 01111 10001 10001 10001 01111',
  e: '00000 00000 01110 10001 11111 10000 01110',
  f: '00110 01001 01000 11100 01000 01000 01000',
  g: '00000 01111 10001 10001 01111 00001 01110',
  h: '10000 10000 11110 10001 10001 10001 10001',
  i: '00100 00000 01100 00100 00100 00100 01110',
  j: '00010 00000 00110 00010 00010 10010 01100',
  k: '10000 10000 10010 10100 11000 10100 10010',
  l: '01100 00100 00100 00100 00100 00100 01110',
  m: '00000 00000 11010 10101 10101 10101 10101',
  n: '00000 00000 11110 10001 10001 10001 10001',
  o: '00000 00000 01110 10001 10001 10001 01110',
  p: '00000 00000 11110 10001 11110 10000 10000',
  q: '00000 00000 01111 10001 01111 00001 00001',
  r: '00000 00000 10110 11001 10000 10000 10000',
  s: '00000 00000 01111 10000 01110 00001 11110',
  t: '01000 01000 11100 01000 01000 01001 00110',
  u: '00000 00000 10001 10001 10001 10011 01101',
  v: '00000 00000 10001 10001 10001 01010 00100',
  w: '00000 00000 10001 10001 10101 10101 01010',
  x: '00000 00000 10001 01010 00100 01010 10001',
  y: '00000 00000 10001 10001 01111 00001 01110',
  z: '00000 00000 11111 00010 00100 01000 11111',
  ',': '00000 00000 00000 00000 01100 00100 01000',
  ';': '00000 01100 01100 00000 01100 00100 01000',
  "'": '00100 00100 01000 00000 00000 00000 00000',
  '"': '01010 01010 10100 00000 00000 00000 00000',
  '`': '01000 00100 00010 00000 00000 00000 00000',
  '<': '00010 00100 01000 10000 01000 00100 00010',
  '>': '01000 00100 00010 00001 00010 00100 01000',
  '[': '01110 01000 01000 01000 01000 01000 01110',
  ']': '01110 00010 00010 00010 00010 00010 01110',
  '{': '00110 00100 00100 01000 00100 00100 00110',
  '}': '01100 00100 00100 00010 00100 00100 01100',
  '|': '00100 00100 00100 00100 00100 00100 00100',
  '\\': '10000 01000 01000 00100 00010 00010 00001',
  _: '00000 00000 00000 00000 00000 00000 11111',
  '^': '00100 01010 10001 00000 00000 00000 00000',
  '~': '00000 00000 01000 10101 00010 00000 00000',
  '@': '01110 10001 00001 01101 10101 10101 01110',
  '#': '01010 01010 11111 01010 11111 01010 01010',
  $: '00100 01111 10100 01110 00101 11110 00100',
  '%': '11000 11001 00010 00100 01000 10011 00011',
  '&': '01100 10010 10100 01000 10101 10010 01101',
};

export const TOFU_INDEX = 95; // one slot past '~' in the 0x20-based table

// 8 bytes per glyph, rows top→bottom, bit7 = leftmost pixel. Slots 0..94
// cover printable ASCII 0x20..0x7E, slot 95 is the tofu. Row 7 stays blank
// (inter-line gap / underline row), 5-bit glyphs sit in bits 7..3 so the
// right 3 columns are the inter-character gap — same packing as
// demo/font.js buildFont().
export function buildGlyphs() {
  const glyphs = new Uint8Array((TOFU_INDEX + 1) * 8);
  const put = (code, rows) => {
    const r = rows.trim().split(/\s+/);
    for (let line = 0; line < 7 && line < r.length; line++) {
      glyphs[(code - 0x20) * 8 + line] = parseInt(r[line], 2) << 3;
    }
  };
  for (const [ch, rows] of Object.entries(G)) put(ch.charCodeAt(0), rows);
  for (const [ch, rows] of Object.entries(EXTRA_GLYPHS)) put(ch.charCodeAt(0), rows);
  // tofu: a checkerboard, unmistakably "no glyph here"
  for (let line = 0; line < 7; line++) glyphs[TOFU_INDEX * 8 + line] = line & 1 ? 0b01010000 : 0b10101000;
  return glyphs;
}

export function glyphIndexFor(codePoint) {
  if (codePoint === 0 || codePoint === 0x20) return 0; // empty cell = space
  if (codePoint > 0x20 && codePoint < 0x7f) return codePoint - 0x20;
  return TOFU_INDEX;
}

// ---------------------------------------------------------------------------
// Raster core: view → GRB-indexed Uint8Array (cols*8 × rows*8).
//
// `view` is a plain-object contract, satisfied by both the live addon and
// test fakes:
//   { cols, rows, getLine(y) -> line|null, cursorX, cursorY }
// where line.getCell(x[, recycle]) returns an IBufferCell-shaped object.
// ---------------------------------------------------------------------------

export function drawTerminalToIndexed(view, glyphs, out, {
  strict1979 = false,
  blinkOn = true,     // frame-phased by the caller; SGR blink hides fg when false
  cursorOn = true,
  defaultFg = 7,
  defaultBg = 0,
  workCell = null,    // xterm getNullCell() recycle object, optional
} = {}) {
  const { cols, rows } = view;
  const w = cols * 8;
  for (let cy = 0; cy < rows; cy++) {
    const line = view.getLine(cy);
    for (let cx = 0; cx < cols; cx++) {
      let fg = defaultFg, bg = defaultBg;
      let gi = 0, bold = false, underline = false;
      const cell = line ? (workCell ? line.getCell(cx, workCell) : line.getCell(cx)) : null;
      if (cell) {
        const chars = cell.getChars();
        gi = glyphIndexFor(chars ? chars.codePointAt(0) : 0);
        ({ fg, bg } = cellToGrb(cell, defaultFg, defaultBg));
        // 1979: the attribute stream carries a color and a function per
        // run, never a background — so strict mode drops bg BEFORE the
        // inverse swap. Reverse video then renders as dark-glyph-on-fg,
        // which is exactly how the real machine faked backgrounds.
        if (strict1979) bg = 0;
        if (cell.isInverse()) { const t = fg; fg = bg; bg = t; }
        if (cell.isBlink() && !blinkOn) fg = bg;
        bold = !!cell.isBold();
        underline = !!cell.isUnderline();
      }
      const base = cy * 8 * w + cx * 8;
      for (let r = 0; r < 8; r++) {
        let bits = glyphs[gi * 8 + r];
        if (bold) bits |= bits >> 1; // classic CRT bold: re-strike shifted
        if (underline && r === 7) bits = 0xff;
        const o = base + r * w;
        out[o] = bits & 0x80 ? fg : bg;
        out[o + 1] = bits & 0x40 ? fg : bg;
        out[o + 2] = bits & 0x20 ? fg : bg;
        out[o + 3] = bits & 0x10 ? fg : bg;
        out[o + 4] = bits & 0x08 ? fg : bg;
        out[o + 5] = bits & 0x04 ? fg : bg;
        out[o + 6] = bits & 0x02 ? fg : bg;
        out[o + 7] = bits & 0x01 ? fg : bg;
      }
    }
  }
  if (cursorOn && view.cursorY >= 0 && view.cursorY < rows
    && view.cursorX >= 0 && view.cursorX < cols) {
    invertCellBlock(out, w, view.cursorX, view.cursorY, 1);
  }
  return out;
}

// XOR 7 flips all three guns — reverse video the way the hardware does it.
export function invertCellBlock(out, w, cellX, cellY, cellCount) {
  const base = cellY * 8 * w + cellX * 8;
  const px = cellCount * 8;
  for (let r = 0; r < 8; r++) {
    const o = base + r * w;
    for (let c = 0; c < px; c++) out[o + c] ^= 7;
  }
}

// ---------------------------------------------------------------------------
// The addon.
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS = Object.freeze({
  phosphor: 'P22',     // key into PHOSPHORS
  mask: 'aperture',    // key into MASKS
  maskPitch: 3,
  barrel: 0.06,
  focus: 0.8,          // CrtTube beamWidth
  bright: 1.2,         // toRGBA/apply scale
  contrast: 1.0,
  flicker: false,      // 10 Hz beat + mains drift, frame-counted
  strict1979: false,   // drop per-cell backgrounds (PC-8001 truth)
  cursorBlink: true,
  outputScale: 2,      // tube output pixels per source pixel (h; v gets ×2 more)
  scanlineDepth: 1.0,  // 200-line look: real black between traces
  beamHeight: 0.35,
});

export class CrtRendererAddon {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this._glyphs = buildGlyphs();
    this._terminal = null;
    this._canvas = null;
    this._ctx = null;
    this._img = null;
    this._screen = null;
    this._phosphor = null;
    this._tube = null;
    this._indexed = null;
    this._rgba = null;
    this._cols = 0;
    this._rows = 0;
    this._raf = 0;
    this._last = 0;
    this._frame = 0; // deterministic phase source for blink + flicker
    this._enabled = true;
    this._disposables = [];
    this._workCell = null;
  }

  // ITerminalAddon
  activate(terminal) {
    if (typeof requestAnimationFrame === 'undefined') {
      throw new Error('CrtRendererAddon needs a browser (requestAnimationFrame); use drawTerminalToIndexed() headless');
    }
    this._terminal = terminal;
    // geometry becomes stale on resize; the next tick rebuilds everything
    if (terminal.onResize) {
      this._disposables.push(terminal.onResize(() => { this._cols = 0; }));
    }
    const tick = (now) => {
      this._raf = requestAnimationFrame(tick);
      this._tick(now);
    };
    this._raf = requestAnimationFrame(tick);
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    for (const d of this._disposables) d.dispose?.();
    this._disposables = [];
    if (this._screen) this._screen.style.visibility = '';
    this._canvas?.remove();
    this._canvas = null;
    this._terminal = null;
  }

  // Live knob turning from a settings panel; only rebuilds what changed.
  setOptions(partial) {
    const o = this.options;
    Object.assign(o, partial);
    if ('phosphor' in partial && this._phosphor) {
      this._phosphor.setPhosphor(PHOSPHORS[o.phosphor] ?? PHOSPHORS.P22);
    }
    if ('outputScale' in partial) this._cols = 0; // full rebuild
    else if (this._tube) {
      if ('focus' in partial) this._tube.beamWidth = o.focus;
      if ('mask' in partial || 'maskPitch' in partial || 'barrel' in partial) {
        this._tube.setGeometry({ mask: o.mask, maskPitch: o.maskPitch, barrel: o.barrel });
      }
    }
    return this;
  }

  // CRT off = give the page back to xterm's own renderer, live.
  setEnabled(on) {
    this._enabled = !!on;
    if (this._canvas) this._canvas.style.display = on ? '' : 'none';
    if (this._screen) this._screen.style.visibility = on ? 'hidden' : '';
    return this;
  }

  get enabled() { return this._enabled; }

  // ---- internals ----------------------------------------------------------

  // terminal.element only exists after terminal.open(); loadAddon() may run
  // first. So DOM binding is lazy: each tick tries until the element shows up.
  _ensureDom() {
    const term = this._terminal;
    if (!term || !term.element) return false;
    if (!this._canvas) {
      this._screen = term.element.querySelector('.xterm-screen');
      const c = document.createElement('canvas');
      c.className = 'crt-xterm-canvas';
      // pointer-events:none so selection/click/paste land on xterm as before
      c.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;'
        + 'image-rendering:auto;z-index:10;';
      term.element.style.position = 'relative';
      term.element.appendChild(c);
      this._canvas = c;
      this._ctx = c.getContext('2d');
      if (this._enabled && this._screen) this._screen.style.visibility = 'hidden';
      if (!this._enabled) c.style.display = 'none';
      this._workCell = term.buffer?.active?.getNullCell?.() ?? null;
    }
    return true;
  }

  _ensureBuffers() {
    const term = this._terminal;
    if (this._cols === term.cols && this._rows === term.rows) return;
    this._cols = term.cols;
    this._rows = term.rows;
    const w = this._cols * 8, h = this._rows * 8;
    const s = Math.max(1, this.options.outputScale);
    const outW = Math.round(w * s);
    const outH = Math.round(h * 2 * s); // ×2: scanline doubling, like the demos
    this._indexed = new Uint8Array(w * h);
    this._phosphor = new CrtPhosphor({
      width: w, height: h,
      phosphor: PHOSPHORS[this.options.phosphor] ?? PHOSPHORS.P22,
    });
    this._tube = new CrtTube({
      srcWidth: w, srcHeight: h, outWidth: outW, outHeight: outH,
      mask: this.options.mask, maskPitch: this.options.maskPitch,
      barrel: this.options.barrel, beamWidth: this.options.focus,
      scanlineDepth: this.options.scanlineDepth, beamHeight: this.options.beamHeight,
    });
    this._rgba = new Uint8ClampedArray(outW * outH * 4);
    this._canvas.width = outW;
    this._canvas.height = outH;
    this._img = this._ctx.createImageData(outW, outH);
  }

  // Keep the overlay glued to xterm's screen box (it moves when the
  // scrollbar appears or fonts load).
  _placeCanvas() {
    const el = this._screen ?? this._terminal.element;
    const wpx = el.clientWidth || el.offsetWidth;
    const hpx = el.clientHeight || el.offsetHeight;
    const c = this._canvas;
    if (this._cssW !== wpx || this._cssH !== hpx) {
      this._cssW = wpx; this._cssH = hpx;
      c.style.width = wpx + 'px';
      c.style.height = hpx + 'px';
      c.style.left = (this._screen ? this._screen.offsetLeft : 0) + 'px';
      c.style.top = (this._screen ? this._screen.offsetTop : 0) + 'px';
    }
  }

  _tick(now) {
    if (!this._ensureDom()) return;
    if (!this._enabled) return; // xterm's renderer is showing; nothing to do
    this._ensureBuffers();
    this._placeCanvas();
    const dt = this._last ? Math.min(0.1, Math.max(0.0001, (now - this._last) / 1000)) : 1 / 60;
    this._last = now;
    this._frame++;

    const term = this._terminal;
    const buf = term.buffer.active;
    // ~1.1 Hz cursor blink, ~2 Hz SGR blink — frame-counted, deterministic
    const cursorOn = !this.options.cursorBlink || ((this._frame >> 5) & 1) === 0;
    const view = {
      cols: term.cols, rows: term.rows,
      getLine: (y) => buf.getLine(buf.viewportY + y),
      cursorX: buf.cursorX,
      // cursorY is relative to baseY; when scrolled back it can leave the view
      cursorY: buf.baseY + buf.cursorY - buf.viewportY,
    };
    drawTerminalToIndexed(view, this._glyphs, this._indexed, {
      strict1979: this.options.strict1979,
      blinkOn: ((this._frame >> 4) & 1) === 0,
      cursorOn,
      workCell: this._workCell,
    });
    this._overlaySelection(term, buf);

    this._phosphor.step(this._indexed, dt);
    // flicker: the ~10 Hz beat you get *filming* a 60 Hz raster, plus a slow
    // mains drift — the demo panel's recipe, frame-counted (crt-panel.js)
    let flick = 1;
    if (this.options.flicker) {
      const beat = Math.sin(this._frame * 2 * Math.PI * 10 / 60);
      const hum = Math.sin(this._frame * 2 * Math.PI * 1.7 / 60);
      flick = 1 - 0.10 * (0.5 + 0.5 * beat) - 0.04 * (0.5 + 0.5 * hum);
    }
    this._tube.apply(this._phosphor.composite(), this._rgba, {
      scale: this.options.bright * flick,
      contrast: this.options.contrast,
    });
    this._img.data.set(this._rgba);
    this._ctx.putImageData(this._img, 0, 0);
  }

  // xterm's selection layer is hidden with the rest of the screen, so echo
  // the selection as hardware reverse video. Both API shapes are handled
  // (IBufferRange {start,end} in 5.x, ISelectionPosition columns/rows before).
  _overlaySelection(term, buf) {
    const pos = term.getSelectionPosition?.();
    if (!pos) return;
    const w = term.cols * 8;
    const startY = pos.start ? pos.start.y : pos.startRow;
    const endY = pos.end ? pos.end.y : pos.endRow;
    const startX = pos.start ? pos.start.x : pos.startColumn;
    const endX = pos.end ? pos.end.x : pos.endColumn;
    for (let ay = startY; ay <= endY; ay++) {
      const vy = ay - buf.viewportY;
      if (vy < 0 || vy >= term.rows) continue;
      const x0 = ay === startY ? startX : 0;
      const x1 = ay === endY ? endX : term.cols;
      if (x1 > x0) invertCellBlock(this._indexed, w, x0, vy, x1 - x0);
    }
  }
}

export function createCrtRendererAddon(options) {
  return new CrtRendererAddon(options);
}
