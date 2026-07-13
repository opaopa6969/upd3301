// upd3301 — NEC μPD3301 CRT controller emulator core.
//
// Chip-level model: command/parameter ports, 5-byte RESET parameters, per-row
// DMA fetch (characters + attribute pairs), attribute expansion, cursor,
// blink timing, status register and VRTC interrupt.
//
// Suite contract: pure, zero deps, deterministic, headless. Timing is
// frame-granular (not dot-clock exact): update(dt) accumulates seconds and
// executes whole frames at frameHz. All DMA for a frame happens inside
// stepFrame(), row by row, in order — the same order the real chip requests
// bursts during horizontal blanking.
//
// The chip never touches memory itself. It asserts DRQ and an external DMA
// controller (μPD8257 on the PC-8001) feeds it bytes; here that is the
// `drq(buf)` callback, which must fill `buf` and return the byte count.
//
// References: NEC μPD3301 datasheet behavior as implemented by MAME
// (src/devices/video/upd3301.cpp, BSD-3; reimplemented, no code copied),
// nkomatsu's IC collection page, kwhr0's FPGA notes, EnrPc port map.

export const SCHEMA_VERSION = 1;

export const STATUS = Object.freeze({
  LP: 0x01, // light pen (not supported; always 0)
  E: 0x02, // end of frame / VRTC interrupt
  N: 0x04, // special control character (not supported; always 0)
  U: 0x08, // DMA underrun
  VE: 0x10, // video enable (display started)
});

export const COMMAND = Object.freeze({
  RESET: 0x00,
  START_DISPLAY: 0x20,
  SET_INTERRUPT_MASK: 0x40,
  READ_LIGHT_PEN: 0x60,
  LOAD_CURSOR_POSITION: 0x80,
  RESET_INTERRUPT: 0xa0,
  RESET_COUNTERS: 0xc0,
});

export const MAX_COLS = 80;
export const MAX_ROWS = 64;
export const MAX_ATTRS_PER_ROW = 20;

// Expand one row of (position, value) attribute pairs into a per-column
// attribute byte array, following the chip's observed behavior (MAME
// default_attr_fetch): value k fills from its own position up to the next
// pair's position; the first pair's value also back-fills columns before its
// position; the last value extends to the end of the row; a position of 0 on
// a non-first pair means "end of row" (N-BASIC pads unused slots that way).
export function expandAttrRow(pairs, attrsPerRow, cols, out) {
  out.fill(0);
  if (attrsPerRow === 0) return out;
  for (let k = 0; k < attrsPerRow; k++) {
    let start = k === 0 ? 0 : pairs[k * 2];
    if (k > 0 && start === 0) start = cols;
    let end = cols;
    if (k + 1 < attrsPerRow) {
      const next = pairs[(k + 1) * 2];
      end = next === 0 ? cols : next;
    }
    const value = pairs[k * 2 + 1];
    for (let x = Math.min(start, cols); x < Math.min(end, cols); x++) out[x] = value;
  }
  return out;
}

export class Upd3301 {
  constructor({ frameHz = 60, drq = null, onIrq = null } = {}) {
    this.frameHz = frameHz;
    this.drq = drq;
    this.onIrq = onIrq;

    // geometry / RESET parameters (undefined until RESET; sane zeros)
    this.cols = 0; // characters per row (2..80)
    this.rows = 0; // displayed rows (1..64)
    this.linesPerChar = 0; // scanlines per character row (1..16)
    this.vblankRows = 0; // vertical blanking, in character rows (1..8)
    this.hblankChars = 0; // horizontal blanking, in character times (2..33)
    this.skipLine = 0; // display every other line
    this.cursorMode = 0; // 0:blink underline 1:blink block 2:steady underline 3:steady block (see cursorStyle())
    this.blinkPeriod = 0; // cursor blink period in frames
    this.dmaBurstMode = 0; // param byte 0 bit 7
    this.attrMode = 0; // param byte 4 bits 7-5 (AT1 AT0 SC), interpretation is downstream
    this.attrsPerRow = 0; // attribute pairs fetched per row (0..20)
    this.attrPerCell = false; // EX: one attribute byte per cell instead of pairs
    this.attrBytesPerRow = 0;

    this.ve = false; // display started
    this.reverseDisplay = false;
    this.interruptMask = 3; // bit0 masks VRTC int, bit1 masks special-char int; 1 = masked
    this.status = 0;
    this.irqLine = false;

    this.cursorX = 0;
    this.cursorY = 0;
    this.cursorEnabled = false;

    this.frame = 0;
    this._timeAcc = 0;

    // pending multi-byte parameter writes: {kind, index}
    this._pending = null;
    this._paramBytes = new Uint8Array(5);
    this._readBytes = [0, 0];
    this._readIndex = 0;

    this.cells = new Uint8Array(0); // character codes, rows*cols
    this.attrs = new Uint8Array(0); // expanded per-cell attribute bytes
    this.attrPairs = new Uint8Array(0); // raw pairs, rows * attrsPerRow*2
    this._rowBuf = new Uint8Array(MAX_COLS + MAX_ATTRS_PER_ROW * 2);
  }

  // ---- bus interface -------------------------------------------------
  // a0 = 0: parameter port (PC-8001 I/O 50h), a0 = 1: command/status (51h)
  writePort(a0, value) {
    if (a0 & 1) this.writeCommand(value);
    else this.writeParam(value);
  }

  readPort(a0) {
    return a0 & 1 ? this.readStatus() : this.readParam();
  }

  writeCommand(value) {
    value &= 0xff;
    const op = value & 0xe0;
    switch (op) {
      case COMMAND.RESET:
        this.ve = false;
        this.status &= ~STATUS.VE;
        this._pending = { kind: 'reset', index: 0 };
        break;
      case COMMAND.START_DISPLAY:
        this.reverseDisplay = (value & 1) !== 0;
        this.ve = true;
        this.status |= STATUS.VE;
        this._pending = null;
        break;
      case COMMAND.SET_INTERRUPT_MASK:
        this.interruptMask = value & 3;
        // unmasking the VRTC interrupt clears pending status flags
        if ((this.interruptMask & 1) === 0) this.status &= STATUS.VE;
        this._pending = null;
        break;
      case COMMAND.READ_LIGHT_PEN:
        this._readBytes = [0, 0]; // light pen not supported
        this._readIndex = 0;
        this._pending = null;
        break;
      case COMMAND.LOAD_CURSOR_POSITION:
        this.cursorEnabled = (value & 1) !== 0;
        this._pending = { kind: 'cursor', index: 0 };
        break;
      case COMMAND.RESET_INTERRUPT:
        this.irqLine = false;
        this.status &= ~STATUS.E;
        this._pending = null;
        break;
      case COMMAND.RESET_COUNTERS:
        this.frame = 0;
        this._timeAcc = 0;
        this._pending = null;
        break;
      default:
        this._pending = null;
        break;
    }
  }

  writeParam(value) {
    value &= 0xff;
    const p = this._pending;
    if (!p) return;
    if (p.kind === 'reset') {
      this._paramBytes[p.index++] = value;
      if (p.index === 5) {
        this._applyResetParams(this._paramBytes);
        this._pending = null;
      }
    } else if (p.kind === 'cursor') {
      if (p.index === 0) this.cursorX = value;
      else this.cursorY = value;
      if (++p.index === 2) this._pending = null;
    }
  }

  readStatus() {
    // bit 7 is an undocumented "alive" bit that drops on underrun
    let value = this.status;
    if ((this.status & STATUS.U) === 0) value |= 0x80;
    this.status &= ~(STATUS.LP | STATUS.E | STATUS.N | STATUS.U);
    return value;
  }

  readParam() {
    const v = this._readBytes[this._readIndex] ?? 0;
    this._readIndex = Math.min(this._readIndex + 1, this._readBytes.length - 1);
    return v;
  }

  // ---- RESET parameter decoding (5 bytes) ----------------------------
  _applyResetParams(p) {
    this.dmaBurstMode = (p[0] >> 7) & 1;
    this.cols = Math.min((p[0] & 0x7f) + 2, MAX_COLS);
    this.blinkPeriod = ((p[1] >> 6) + 1) * 16;
    this.rows = Math.min((p[1] & 0x3f) + 1, MAX_ROWS);
    this.skipLine = (p[2] >> 7) & 1;
    this.cursorMode = (p[2] >> 5) & 3;
    this.linesPerChar = (p[2] & 0x1f) + 1;
    this.vblankRows = (p[3] >> 5) + 1;
    this.hblankChars = (p[3] & 0x1f) + 2;
    this.attrMode = (p[4] >> 5) & 7;
    this.attrsPerRow = this.attrMode === 1 ? 0 : Math.min((p[4] & 0x1f) + 1, MAX_ATTRS_PER_ROW);
    this.attrPerCell = false;
    this._applyGeometry();
  }

  // EX mode: fantasy silicon rev. The real RESET parameter encoding tops out
  // at 80 columns, 64 rows and 20 attribute pairs; this entry point bypasses
  // the port encoding for terminal-style use (arbitrary XY, per-cell
  // attributes). Everything downstream — DMA row size, expansion, render —
  // works unchanged.
  // attrPerCell: EX-only — instead of (position, value) pairs, the row's
  // attribute block is one byte per cell, in order. Pairs carry an 8-bit
  // position, so pair mode cannot address columns ≥ 256; per-cell mode is
  // how UEX widths (e.g. 320) stay coherent.
  resetEx({ cols, rows, linesPerChar = 8, attrsPerRow = 0, attrPerCell = false, blinkPeriod = 32, cursorMode = 0 } = {}) {
    this.ve = false;
    this.status &= ~STATUS.VE;
    this.cols = cols;
    this.rows = rows;
    this.linesPerChar = linesPerChar;
    this.attrPerCell = attrPerCell;
    this.attrsPerRow = attrPerCell ? 0 : attrsPerRow;
    this.blinkPeriod = blinkPeriod;
    this.cursorMode = cursorMode;
    this.vblankRows = 7;
    this.hblankChars = 14;
    this.attrMode = 0;
    this._applyGeometry();
    return this;
  }

  _applyGeometry() {
    this.attrBytesPerRow = this.attrPerCell ? this.cols : this.attrsPerRow * 2;
    this.cells = new Uint8Array(this.cols * this.rows);
    this.attrs = new Uint8Array(this.cols * this.rows);
    this.attrPairs = new Uint8Array(this.rows * this.attrBytesPerRow);
    this._rowBuf = new Uint8Array(this.cols + this.attrBytesPerRow);
  }

  // ---- timing --------------------------------------------------------
  update(dt) {
    this._timeAcc += dt;
    const period = 1 / this.frameHz;
    while (this._timeAcc >= period - 1e-9) {
      this._timeAcc -= period;
      this.stepFrame();
    }
  }

  stepFrame() {
    this.frame++;
    if (this.ve && this.rows > 0) {
      const abpr = this.attrBytesPerRow;
      const rowLen = this.cols + abpr;
      for (let y = 0; y < this.rows; y++) {
        const buf = this._rowBuf.subarray(0, rowLen);
        let got = 0;
        if (this.drq) got = this.drq(buf) | 0;
        if (got < rowLen) {
          this.status |= STATUS.U;
          buf.fill(0, got);
        }
        this.cells.set(buf.subarray(0, this.cols), y * this.cols);
        const attrBytes = buf.subarray(this.cols, rowLen);
        this.attrPairs.set(attrBytes, y * abpr);
        if (this.attrPerCell) {
          this.attrs.set(attrBytes, y * this.cols);
        } else {
          expandAttrRow(attrBytes, this.attrsPerRow, this.cols,
            this.attrs.subarray(y * this.cols, (y + 1) * this.cols));
        }
      }
    }
    // VRTC: end-of-frame interrupt
    if (this.ve && (this.interruptMask & 1) === 0) {
      this.status |= STATUS.E;
      if (!this.irqLine) {
        this.irqLine = true;
        if (this.onIrq) this.onIrq();
      }
    }
  }

  // ---- observation ---------------------------------------------------
  cursorStyle() {
    // param byte 2 bits 6-5: 00 blink underline, 01 blink block,
    // 10 steady underline, 11 steady block (blink at blinkPeriod frames)
    const blink = (this.cursorMode & 2) === 0;
    const block = (this.cursorMode & 1) === 1;
    return { blink, block };
  }

  cursorBlinkOn() {
    const { blink } = this.cursorStyle();
    if (!blink) return true;
    const half = Math.max(1, this.blinkPeriod >> 1);
    return Math.floor(this.frame / half) % 2 === 0;
  }

  // attribute blink runs at half the cursor blink rate
  attrBlinkOn() {
    const period = Math.max(1, this.blinkPeriod);
    return Math.floor(this.frame / period) % 2 === 0;
  }

  // Horizontal deflection frequency implied by the programmed geometry —
  // (displayed rows + vblank rows) × lines per row × frame rate. For the
  // N-BASIC 80x25 setup: (25+7)×8×60 = 15360 Hz, the CRT whine you heard.
  hsyncHz() {
    return this.frameHz * (this.rows + this.vblankRows) * this.linesPerChar;
  }

  getScreen() {
    return {
      schemaVersion: SCHEMA_VERSION,
      cols: this.cols,
      rows: this.rows,
      linesPerChar: this.linesPerChar,
      skipLine: this.skipLine,
      reverseDisplay: this.reverseDisplay,
      displayEnabled: this.ve,
      frame: this.frame,
      cells: this.cells,
      attrs: this.attrs,
      attrPairs: this.attrPairs,
      attrsPerRow: this.attrsPerRow,
      attrBytesPerRow: this.attrBytesPerRow,
      attrPerCell: this.attrPerCell,
      attrMode: this.attrMode,
      cursor: {
        x: this.cursorX,
        y: this.cursorY,
        enabled: this.cursorEnabled,
        ...this.cursorStyle(),
        on: this.cursorEnabled && this.cursorBlinkOn(),
      },
      attrBlinkOn: this.attrBlinkOn(),
    };
  }
}

export function createUpd3301(opts) {
  return new Upd3301(opts);
}
