// term — a terminal on top of the PC-8001 text pipeline.
//
// Three things, per request:
// 1. A sane write interface to the framebuffer: `write(text)` with cursor,
//    newline/scroll, tabs — you never touch VRAM bytes yourself.
// 2. ANSI escape sequences translated into attribute control: SGR colors
//    (30-37), reverse (7), blink (5), underline (4), overline (53),
//    conceal (8), reset (0), cursor addressing (CUP/CUU/.../ED/EL). The
//    terminal keeps per-cell color+function state and, on flush(), compiles
//    each row into the chip's (position, value) attribute pair format.
// 3. A semigraphic interface: setDot/resetDot/dot on the 2×(cols) ×
//    4×(rows) block grid — N-BASIC SET/RESET feel. A cell that holds dots
//    becomes a semigraphic cell (that's just an attribute, as you said).
//
// Two machine modes:
// - original: real PC-8001 limits — 80×25, 20 attribute pairs per row. If a
//   row needs more pairs than the hardware fetches, the tail is dropped and
//   counted in stats.overflowRows. That's the authentic constraint.
// - ex: fantasy silicon rev (resetEx/setChannelEx) — arbitrary cols×rows and
//   enough pairs for per-cell attributes. A usable terminal.
//
// Pure, deterministic, headless. The screen is only bytes in VRAM until the
// μPD8257 hauls them to the μPD3301 on the next frame.

import { Pc8001TextSystem, PC8001, DEFAULT_COLOR_SPEC, ATTR } from './pc8001.js';

export const SCHEMA_VERSION = 1;

// ANSI 30-37 → PC-8001 GRB color index
export const ANSI_TO_GRB = [0, 2, 4, 6, 1, 3, 5, 7];

const DEFAULT_FUNC = 0x00;

export class Terminal {
  constructor({
    cols = 80, rows = 25, ex = false, frameHz = 60,
    sys = null, vramBase = null, showCursor = true, attrsPerRow = null,
  } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.ex = ex;
    this.showCursor = showCursor;
    const base = vramBase ?? 0x4000;
    // pair positions are single bytes: widths past 255 columns MUST use the
    // per-cell attribute layout or positions wrap mod 256 and the screen
    // shreds (the UEX 320 bug)
    this.attrPerCell = ex && cols > 255;
    const attrs = this.attrPerCell ? 0 : (attrsPerRow ?? cols * 2);
    const attrBytes = this.attrPerCell ? cols : attrs * 2;
    let memoryBytes = 0x10000;
    if (ex) {
      const need = base + rows * (cols + attrBytes);
      while (memoryBytes < need) memoryBytes *= 2; // UEX: fantasy RAM expansion
    }
    this.sys = sys ?? new Pc8001TextSystem({ frameHz, memoryBytes });
    if (ex) {
      const geo = this.sys.initTextModeEx({
        cols, rows, attrsPerRow: attrs, attrPerCell: this.attrPerCell, vramBase: base,
      });
      this.attrSlots = this.attrPerCell ? cols : geo.attrsPerRow;
      this.attrBytesPerRow = geo.attrBytesPerRow;
      this.vramBase = geo.vramBase;
    } else {
      if (cols !== 80 && cols !== 40) throw new Error('original mode: cols must be 80 or 40');
      this.sys.initTextMode({ cols, rows, vramBase: vramBase ?? PC8001.TEXT_VRAM });
      this.attrSlots = 20;
      this.attrBytesPerRow = 40;
      this.vramBase = vramBase ?? PC8001.TEXT_VRAM;
    }
    const n = cols * rows;
    this.chars = new Uint8Array(n).fill(0x20);
    this.colorA = new Uint8Array(n).fill(DEFAULT_COLOR_SPEC);
    this.funcA = new Uint8Array(n).fill(DEFAULT_FUNC);
    this.x = 0;
    this.y = 0;
    this._saved = null;
    // current pen state
    this.pen = { color: 7, semigraphic: false, reverse: false, blink: false, underline: false, overline: false, secret: false };
    this.stats = { overflowRows: 0, scrolls: 0 };
    this._esc = null; // escape parser state
    this.flush();
  }

  // ---- pen → attribute bytes ----------------------------------------
  _penColorByte() {
    return (this.pen.color << 5) | (this.pen.semigraphic ? ATTR.SEMIGRAPHIC : 0) | ATTR.COLOR_FLAG;
  }

  _penFuncByte() {
    return (this.pen.reverse ? ATTR.REVERSE : 0)
      | (this.pen.blink ? ATTR.BLINK : 0)
      | (this.pen.underline ? ATTR.LOWLINE : 0)
      | (this.pen.overline ? ATTR.UPLINE : 0)
      | (this.pen.secret ? ATTR.SECRET : 0);
  }

  // ---- terminal write interface ---------------------------------------
  write(text) {
    for (const ch of String(text)) this._putChar(ch);
    return this;
  }

  writeLine(text = '') { return this.write(text + '\r\n'); }

  _putChar(ch) {
    const code = ch.codePointAt(0);
    if (this._esc) { this._escChar(ch, code); return; }
    switch (code) {
      case 0x1b: this._esc = { buf: '', csi: false }; return;
      case 0x0a: this._lineFeed(); return;
      case 0x0d: this.x = 0; return;
      case 0x08: this.x = Math.max(0, this.x - 1); return;
      case 0x09: this.x = Math.min(this.cols - 1, (this.x & ~7) + 8); return;
      case 0x0c: this.clear(); return;
      default: break;
    }
    if (code < 0x20) return;
    if (this.x >= this.cols) { this.x = 0; this._lineFeed(); }
    const i = this.y * this.cols + this.x;
    this.chars[i] = code & 0xff;
    this.colorA[i] = this._penColorByte() & ~ATTR.SEMIGRAPHIC; // text cell
    this.funcA[i] = this._penFuncByte();
    this.x++;
  }

  _lineFeed() {
    this.y++;
    if (this.y >= this.rows) {
      this.y = this.rows - 1;
      this._scroll();
    }
  }

  _scroll() {
    const w = this.cols;
    this.chars.copyWithin(0, w);
    this.colorA.copyWithin(0, w);
    this.funcA.copyWithin(0, w);
    this.chars.fill(0x20, (this.rows - 1) * w);
    this.colorA.fill(DEFAULT_COLOR_SPEC, (this.rows - 1) * w);
    this.funcA.fill(DEFAULT_FUNC, (this.rows - 1) * w);
    this.stats.scrolls++;
  }

  // ---- escape sequence parser ------------------------------------------
  _escChar(ch, code) {
    const st = this._esc;
    if (!st.csi) {
      if (ch === '[') { st.csi = true; return; }
      this._esc = null; // unsupported non-CSI escape: swallow one char
      return;
    }
    if ((code >= 0x30 && code <= 0x3f) || ch === ';') { st.buf += ch; return; }
    // final byte
    const params = st.buf.length ? st.buf.split(';').map((s) => parseInt(s, 10) || 0) : [];
    this._esc = null;
    this._csi(ch, params);
  }

  _csi(final, p) {
    const n = (i, d = 1) => (p[i] === undefined || p[i] === 0 ? d : p[i]);
    switch (final) {
      case 'm': this._sgr(p.length ? p : [0]); break;
      case 'H': case 'f':
        this.y = Math.min(this.rows - 1, n(0) - 1);
        this.x = Math.min(this.cols - 1, n(1) - 1);
        break;
      case 'A': this.y = Math.max(0, this.y - n(0)); break;
      case 'B': this.y = Math.min(this.rows - 1, this.y + n(0)); break;
      case 'C': this.x = Math.min(this.cols - 1, this.x + n(0)); break;
      case 'D': this.x = Math.max(0, this.x - n(0)); break;
      case 'J': if ((p[0] ?? 0) === 2) this.clear(); break;
      case 'K': { // erase to end of line
        const i = this.y * this.cols;
        this.chars.fill(0x20, i + this.x, i + this.cols);
        this.colorA.fill(DEFAULT_COLOR_SPEC, i + this.x, i + this.cols);
        this.funcA.fill(DEFAULT_FUNC, i + this.x, i + this.cols);
        break;
      }
      case 's': this._saved = { x: this.x, y: this.y }; break;
      case 'u': if (this._saved) ({ x: this.x, y: this.y } = this._saved); break;
      default: break; // unsupported CSI: ignore
    }
  }

  _sgr(params) {
    for (const v of params) {
      if (v === 0) {
        Object.assign(this.pen, { color: 7, reverse: false, blink: false, underline: false, overline: false, secret: false });
      } else if (v === 4) this.pen.underline = true;
      else if (v === 5 || v === 6) this.pen.blink = true;
      else if (v === 7) this.pen.reverse = true;
      else if (v === 8) this.pen.secret = true;
      else if (v === 24) this.pen.underline = false;
      else if (v === 25) this.pen.blink = false;
      else if (v === 27) this.pen.reverse = false;
      else if (v === 28) this.pen.secret = false;
      else if (v === 53) this.pen.overline = true;
      else if (v === 55) this.pen.overline = false;
      else if (v >= 30 && v <= 37) this.pen.color = ANSI_TO_GRB[v - 30];
      else if (v === 39) this.pen.color = 7;
      // 40-47 (background): the PC-8001 has no per-cell background — ignored
    }
  }

  // ---- semigraphic interface (N-BASIC SET/RESET feel) -------------------
  // dot grid: (cols*2) × (rows*4); color applies per CELL (hardware truth)
  get dotWidth() { return this.cols * 2; }
  get dotHeight() { return this.rows * 4; }

  _dotCell(x, y) {
    const cx = x >> 1, cy = y >> 2;
    if (x < 0 || y < 0 || cx >= this.cols || cy >= this.rows) return null;
    const bit = 1 << ((y & 3) + (x & 1 ? 4 : 0));
    return { i: cy * this.cols + cx, bit };
  }

  setDot(x, y, color = null) {
    const c = this._dotCell(x, y);
    if (!c) return this;
    if (!(this.colorA[c.i] & ATTR.SEMIGRAPHIC)) {
      this.chars[c.i] = 0; // entering graphic mode: clear leftover glyph bits
    }
    this.chars[c.i] |= c.bit;
    const col = color ?? this.pen.color;
    this.colorA[c.i] = (col << 5) | ATTR.SEMIGRAPHIC | ATTR.COLOR_FLAG;
    return this;
  }

  resetDot(x, y) {
    const c = this._dotCell(x, y);
    if (c && (this.colorA[c.i] & ATTR.SEMIGRAPHIC)) this.chars[c.i] &= ~c.bit;
    return this;
  }

  dot(x, y) {
    const c = this._dotCell(x, y);
    return !!c && (this.colorA[c.i] & ATTR.SEMIGRAPHIC) !== 0 && (this.chars[c.i] & c.bit) !== 0;
  }

  // ---- housekeeping ------------------------------------------------------
  clear() {
    this.chars.fill(0x20);
    this.colorA.fill(DEFAULT_COLOR_SPEC);
    this.funcA.fill(DEFAULT_FUNC);
    this.x = 0;
    this.y = 0;
    return this;
  }

  moveTo(x, y) {
    this.x = Math.max(0, Math.min(this.cols - 1, x));
    this.y = Math.max(0, Math.min(this.rows - 1, y));
    return this;
  }

  // Compile the cell model into VRAM rows: characters + attribute pairs.
  // Rows are encoded as runs; each run boundary emits a color pair and/or a
  // function pair (same position twice is fine — the expansion applies both).
  flush() {
    const { cols, attrSlots } = this;
    const stride = cols + this.attrBytesPerRow;
    const mem = this.sys.memory;
    for (let y = 0; y < this.rows; y++) {
      const rowBase = this.vramBase + y * stride;
      const ci = y * cols;
      mem.set(this.chars.subarray(ci, ci + cols), rowBase);
      if (this.attrPerCell) {
        // one byte per cell: a cell can carry its color OR its function
        // spec; when both are non-default the color wins (counted below)
        let clash = 0;
        for (let x = 0; x < cols; x++) {
          const c = this.colorA[ci + x], f = this.funcA[ci + x];
          if (f !== DEFAULT_FUNC && c !== DEFAULT_COLOR_SPEC) clash++;
          mem[rowBase + cols + x] = (f !== DEFAULT_FUNC && c === DEFAULT_COLOR_SPEC) ? f : c;
        }
        if (clash) this.stats.overflowRows++;
        continue;
      }
      // encode attribute runs
      let slot = 0;
      let overflowed = false;
      const emit = (pos, value) => {
        if (slot >= attrSlots) { overflowed = true; return; }
        mem[rowBase + cols + slot * 2] = pos;
        mem[rowBase + cols + slot * 2 + 1] = value;
        slot++;
      };
      let color = this.colorA[ci];
      let func = this.funcA[ci];
      emit(0, color);
      if (func !== DEFAULT_FUNC) emit(0, func);
      for (let x = 1; x < cols; x++) {
        const c = this.colorA[ci + x], f = this.funcA[ci + x];
        if (c !== color) { emit(x, c); color = c; }
        if (f !== func) { emit(x, f); func = f; }
      }
      for (let s = slot; s < attrSlots; s++) {
        mem[rowBase + cols + s * 2] = 0;
        mem[rowBase + cols + s * 2 + 1] = 0;
      }
      if (overflowed) this.stats.overflowRows++;
    }
    // hardware cursor follows the terminal cursor
    this.sys.out(0x51, this.showCursor ? 0x81 : 0x80);
    this.sys.out(0x50, Math.min(this.x, cols - 1));
    this.sys.out(0x50, this.y);
    return this;
  }

  update(dt) { this.sys.update(dt); return this; }
  render(opts) { return this.sys.render(opts); }
}

export function createTerminal(opts) {
  return new Terminal(opts);
}
