// pc98video — the PC-9801's two screens and the memory behind them.
//
// A 9801 draws two pictures at once and adds them at the video output:
//
//   * the TEXT plane, scanned by GDC1 out of 16 KB at $A0000. Every cell is
//     TWO words — a code at $A0000+2n and an attribute at $A2000+2n — and the
//     code may be half of a 16x16 kanji. Colour comes from the attribute, not
//     from a palette entry per pixel.
//   * the GRAPHICS planes, scanned by GDC2 out of four 32 KB bit planes at
//     $A8000 (blue), $B0000 (red), $B8000 (green) and $E0000 (intensity).
//     Four planes, one bit each, indexes a sixteen-entry analog palette.
//
// Text wins wherever it has a dot. That is the whole priority rule, and it is
// why a PC-9801 game can put a status line over a scrolling picture without
// either knowing about the other.
//
// ## The GRCG is why filling the screen is fast
//
// Four planes means four writes per eight pixels, which on a 5 MHz 8086 is
// slow enough to see. The Graphic Charger sits between the CPU and the planes
// with four "tile" registers, and when it is on ONE write reaches all four:
//
//   TDW mode  the CPU's data is ignored; each plane gets its tile byte
//   RMW mode  the CPU's data is a mask of which dots to touch; the ones it
//             selects take their colour from the tile registers
//
// So a solid fill is one string store instead of four, and a colour-keyed
// sprite blit is one pass instead of four. Software depends on this heavily.
//
// ## Fonts
//
// The font ROM is 288,768 bytes in the layout every PC-98 emulator uses:
//
//   $00000  8x8 ANK, 256 characters
//   $00800  8x16 ANK, 256 characters
//   $01800  16x16 kanji, 32 bytes each (16 left-column rows, then 16 right),
//           indexed (JIS_high - $21) * 96 + (JIS_low - $20)
//
// That last formula is not documented anywhere; it was derived by rendering
// candidates until index 290 came out as あ and 291 as い.
//
// Pure, deterministic, zero deps. No DOM.

export const SCHEMA_VERSION = 1;

export const SCREEN_W = 640;
export const SCREEN_H = 400;

const TVRAM_SIZE = 0x4000;      // codes at 0-$1FFF, attributes at $2000-$3FFF
const PLANE_SIZE = 0x8000;      // 32 KB per graphics plane
const PLANES = 4;

// Attribute bits. Bit 0 is "display this cell at all", which is how a password
// prompt hides what you type without erasing it.
const A_DISPLAY = 0x01, A_BLINK = 0x02, A_REVERSE = 0x04;
const A_UNDERLINE = 0x08, A_VLINE = 0x10;

// The sixteen-colour analog palette a 9801 powers up with: the eight digital
// colours at full intensity, then the same eight again. Software that never
// programs the palette (the ITF, for one) still needs white to be white.
const DEFAULT_PALETTE = [
  [0, 0, 0], [0, 0, 15], [15, 0, 0], [15, 0, 15],
  [0, 15, 0], [0, 15, 15], [15, 15, 0], [15, 15, 15],
  [0, 0, 0], [0, 0, 7], [7, 0, 0], [7, 0, 7],
  [0, 7, 0], [0, 7, 7], [7, 7, 0], [7, 7, 7],
];

export class Pc98Video {
  constructor({ font = null, gdcText = null, gdcGfx = null } = {}) {
    this.tvram = new Uint8Array(TVRAM_SIZE);
    this.gvram = [];
    for (let i = 0; i < PLANES; i++) this.gvram.push(new Uint8Array(PLANE_SIZE));
    // Video memory is half a megabyte of the snapshot if it travels
    // unconditionally, and a machine sitting at a text prompt has never
    // written a single graphics byte. The flag is monotonic, so there is no
    // ambiguity about when a snapshot has to carry the planes.
    this.gvramDirty = false;

    this.font = font ? new Uint8Array(font) : null;
    this.gdcText = gdcText;
    this.gdcGfx = gdcGfx;

    this.palette = new Uint8Array(16 * 3);
    this.frame = new Uint8Array(SCREEN_W * SCREEN_H * 3);
    this.reset();
  }

  reset() {
    for (let i = 0; i < 16; i++) {
      this.palette[i * 3] = DEFAULT_PALETTE[i][0];
      this.palette[i * 3 + 1] = DEFAULT_PALETTE[i][1];
      this.palette[i * 3 + 2] = DEFAULT_PALETTE[i][2];
    }
    this.palIndex = 0;
    this.analog = true;          // 16-colour analog palette (a VX or later)

    this.grcgMode = 0;           // $7C: bit7 enable, bit6 read-modify-write
    this.grcgTile = new Uint8Array(PLANES);
    this.grcgPtr = 0;

    this.displayPage = 0;        // $A4: which 200-line page is shown
    this.drawPage = 0;           // $A6: which one the CPU sees
    this.borderColour = 0;       // $6C

    this.modeFF = new Uint8Array(8);
    this.modeFF[2] = 1;          // colour, not monochrome
    this.textDisplay = true;
    this.gfxDisplay = false;

    this.cgCode = 0;             // $A1/$A3: which glyph the CG window shows
    this.blink = 0;
    return this;
  }

  powerOn() {
    this.tvram.fill(0);
    for (const p of this.gvram) p.fill(0);
    this.gvramDirty = false;
    return this.reset();
  }

  setFont(font) { this.font = font ? new Uint8Array(font) : null; return this; }

  // ---- text memory --------------------------------------------------------------
  readText8(off) { return this.tvram[off & 0x3fff]; }
  writeText8(off, v) { this.tvram[off & 0x3fff] = v & 0xff; }

  // ---- the character generator window at $A4000 -----------------------------------
  // Write the JIS code to $A1 (high) and $A3 (low), then read the pattern here:
  // sixteen bytes of the left half at +$00 and sixteen of the right at +$20.
  // ANK codes (high byte zero) give an 8x16 glyph in the first sixteen bytes.
  readCg8(off) {
    if (!this.font) return 0;
    const line = off & 0x1f;
    const hi = (this.cgCode >> 8) & 0xff, lo = this.cgCode & 0xff;
    if (hi === 0) return this.font[0x800 + (lo & 0xff) * 16 + (line & 0x0f)];
    const g = this._kanjiOffset(hi, lo);
    if (g < 0) return 0;
    return this.font[g + (line & 0x0f) + ((line & 0x10) ? 16 : 0)];
  }

  _kanjiOffset(hi, lo) {
    const h = hi & 0x7f, l = lo & 0x7f;
    if (h < 0x21 || h > 0x7e || l < 0x20 || l > 0x7f) return -1;
    const idx = (h - 0x21) * 96 + (l - 0x20);
    const off = 0x1800 + idx * 32;
    return (this.font && off + 32 <= this.font.length) ? off : -1;
  }

  // ---- graphics memory ------------------------------------------------------------
  // `plane` is 0-3 for blue/red/green/intensity. The GRCG turns one write into
  // four, so the write path takes the plane only to decide the offset.
  readGfx8(plane, off) {
    const o = this._gfxOffset(off);
    // With the GRCG in read-modify-write mode a read reports which dots match
    // the tile colour across all four planes, not the plane's own bits.
    if ((this.grcgMode & 0xc0) === 0xc0) {
      let m = 0xff;
      for (let p = 0; p < PLANES; p++) {
        const b = this.gvram[p][o];
        m &= (this.grcgTile[p] & 0x80) ? b : ~b;
      }
      return m & 0xff;
    }
    return this.gvram[plane & 3][o];
  }

  writeGfx8(plane, off, v) {
    const o = this._gfxOffset(off);
    v &= 0xff;
    this.gvramDirty = true;
    if (!(this.grcgMode & 0x80)) { this.gvram[plane & 3][o] = v; return; }
    if (this.grcgMode & 0x40) {
      // RMW: the CPU byte says WHICH dots, the tiles say what colour.
      const keep = ~v & 0xff;
      for (let p = 0; p < PLANES; p++) {
        const t = this.grcgTile[p];
        this.gvram[p][o] = ((this.gvram[p][o] & keep) | (v & t)) & 0xff;
      }
    } else {
      // TDW: the CPU byte is discarded entirely.
      for (let p = 0; p < PLANES; p++) this.gvram[p][o] = this.grcgTile[p];
    }
  }

  // In 200-line mode the 32 KB plane holds two 16 KB pages and $A6 picks the
  // one the CPU sees. In 400-line mode there is only one page and the select
  // does nothing.
  _gfxOffset(off) {
    const o = off & 0x7fff;
    if (this.lines200 && this.drawPage) return (o & 0x3fff) | 0x4000;
    return o;
  }

  get lines200() {
    const g = this.gdcGfx;
    return !!g && g.al > 0 && g.al <= 256;
  }

  // ---- I/O ------------------------------------------------------------------------
  // $A8-$AE: the palette. In analog mode $A8 latches the entry and the other
  // three carry one four-bit channel each; in digital mode the same ports are
  // four separate colour registers and only eight colours exist.
  writePalette(port, v) {
    v &= 0xff;
    if (!this.analog) {
      // Digital palette: each port holds one bit-plane's worth of the eight
      // entries. Expanded here so the renderer only ever reads `palette`.
      const chan = { 0xa8: 3, 0xaa: 1, 0xac: 0, 0xae: 2 }[port];
      this._digital = this._digital || new Uint8Array(4);
      if (chan !== undefined) this._digital[chan] = v;
      for (let i = 0; i < 8; i++) {
        const bit = 1 << (7 - i);
        const g = (this._digital[1] & bit) ? 15 : 0;
        const r = (this._digital[0] & bit) ? 15 : 0;
        const b = (this._digital[2] & bit) ? 15 : 0;
        this.palette[i * 3] = r; this.palette[i * 3 + 1] = g; this.palette[i * 3 + 2] = b;
      }
      return;
    }
    switch (port) {
      case 0xa8: this.palIndex = v & 0x0f; return;
      case 0xaa: this.palette[this.palIndex * 3 + 1] = v & 0x0f; return;  // green
      case 0xac: this.palette[this.palIndex * 3] = v & 0x0f; return;      // red
      case 0xae: this.palette[this.palIndex * 3 + 2] = v & 0x0f; return;  // blue
      default: return;
    }
  }

  readPalette(port) {
    if (!this.analog) return 0xff;
    switch (port) {
      case 0xa8: return this.palIndex;
      case 0xaa: return this.palette[this.palIndex * 3 + 1];
      case 0xac: return this.palette[this.palIndex * 3];
      case 0xae: return this.palette[this.palIndex * 3 + 2];
      default: return 0xff;
    }
  }

  // The mode flip-flops at $68 and $6A. One write carries the bit number in
  // bits 1-3 and its new value in bit 0, which is how a single OUT sets one
  // switch without disturbing the others.
  writeModeFF(port, v) {
    const bit = (v >> 1) & 7, on = v & 1;
    if (port === 0x68) {
      this.modeFF[bit] = on;
      return;
    }
    // $6A is the extended set. Bit 0 of the selector turns the sixteen-colour
    // analog palette on, which is the difference between a 9801E and a VX.
    if (v === 0x00) this.analog = false;
    else if (v === 0x01) this.analog = true;
    else if (v === 0x02) this.egc = false;
    else if (v === 0x03) this.egc = true;
  }

  writeGrcgMode(v) { this.grcgMode = v & 0xff; this.grcgPtr = 0; }
  writeGrcgTile(v) { this.grcgTile[this.grcgPtr & 3] = v & 0xff; this.grcgPtr = (this.grcgPtr + 1) & 3; }

  // ---- rendering --------------------------------------------------------------------
  // One full 640x400 picture. Graphics first, then text over the top wherever
  // the glyph has a dot. Both layers can be off independently, and a machine
  // that has programmed neither GDC produces a black screen rather than noise.
  render() {
    const out = this.frame;
    out.fill(0);
    if (this.gfxDisplay) this._renderGraphics(out);
    if (this.textDisplay) this._renderText(out);
    return { width: SCREEN_W, height: SCREEN_H, rgb: out };
  }

  _rgbOf(index) {
    const i = (index & 0x0f) * 3;
    return [this.palette[i] * 17, this.palette[i + 1] * 17, this.palette[i + 2] * 17];
  }

  _renderGraphics(out) {
    const g = this.gdcGfx;
    const twoHundred = this.lines200;
    const pitch = 80;                       // bytes per line, both modes
    const base = twoHundred && this.displayPage ? 0x4000 : 0;
    const srcLines = twoHundred ? 200 : 400;
    const [p0, p1, p2, p3] = this.gvram;
    // The display start is the GDC's, in words; the planes are byte arrays.
    const start = g ? (g.displayStart * 2) & 0x7fff : 0;
    for (let y = 0; y < srcLines; y++) {
      const row = (base + start + y * pitch) & 0x7fff;
      for (let bx = 0; bx < pitch; bx++) {
        const o = (row + bx) & 0x7fff;
        const b0 = p0[o], b1 = p1[o], b2 = p2[o], b3 = p3[o];
        if (!(b0 | b1 | b2 | b3)) continue;
        for (let k = 0; k < 8; k++) {
          const m = 0x80 >> k;
          const idx = ((b0 & m) ? 1 : 0) | ((b1 & m) ? 2 : 0)
            | ((b2 & m) ? 4 : 0) | ((b3 & m) ? 8 : 0);
          if (!idx) continue;
          const [r, gg, bb] = this._rgbOf(idx);
          const x = bx * 8 + k;
          if (twoHundred) {
            // A 200-line picture is shown on a 400-line tube: every source
            // line is two picture lines.
            let o1 = ((y * 2) * SCREEN_W + x) * 3;
            out[o1] = r; out[o1 + 1] = gg; out[o1 + 2] = bb;
            o1 += SCREEN_W * 3;
            out[o1] = r; out[o1 + 1] = gg; out[o1 + 2] = bb;
          } else {
            const o1 = (y * SCREEN_W + x) * 3;
            out[o1] = r; out[o1 + 1] = gg; out[o1 + 2] = bb;
          }
        }
      }
    }
  }

  _renderText(out) {
    const gdc = this.gdcText;
    if (!this.font) return;
    const cellH = gdc ? (gdc.lr + 1) : 16;
    const rows = Math.min(32, Math.floor(SCREEN_H / Math.max(1, cellH)));
    const cols = 80;
    const start = gdc ? gdc.displayStart & 0xfff : 0;
    const cursorOn = gdc ? (gdc.cursorOn && gdc.cursorBlinkOn) : false;
    const cursorAddr = gdc ? gdc.ead & 0xfff : -1;
    const blinkOn = (this.blink & 0x20) === 0;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cell = (start + row * cols + col) & 0xfff;
        const code = this.tvram[cell * 2] | (this.tvram[cell * 2 + 1] << 8);
        const attr = this.tvram[0x2000 + cell * 2];
        if (!(attr & A_DISPLAY)) continue;
        if ((attr & A_BLINK) && !blinkOn) continue;
        const colour = ((attr & 0x80) ? 4 : 0) | ((attr & 0x40) ? 2 : 0) | ((attr & 0x20) ? 1 : 0);
        const reverse = (attr & A_REVERSE) !== 0;
        const [fr, fg, fb] = this._rgbOf(colour);
        const isCursor = cursorOn && cell === cursorAddr;

        for (let line = 0; line < cellH; line++) {
          const y = row * cellH + line;
          if (y >= SCREEN_H) break;
          let bits = this._glyphRow(code, line, cellH);
          if ((attr & A_UNDERLINE) && line === cellH - 1) bits = 0xff;
          if (attr & A_VLINE) bits |= 0x01;
          if (reverse) bits = ~bits & 0xff;
          if (isCursor && line >= (gdc.cursorTop | 0) && line <= (gdc.cursorBottom | 0)) bits = ~bits & 0xff;
          if (!bits) continue;
          const rowBase = (y * SCREEN_W + col * 8) * 3;
          for (let k = 0; k < 8; k++) {
            if (!((bits >> (7 - k)) & 1)) continue;
            const o = rowBase + k * 3;
            out[o] = fr; out[o + 1] = fg; out[o + 2] = fb;
          }
        }
      }
    }
  }

  // One 8-dot row of a glyph. A code with a nonzero high byte is a kanji; bit
  // 15 marks the right-hand cell of the pair, which is how the text plane
  // stores a 16-dot character in two 8-dot cells.
  _glyphRow(code, line, cellH) {
    const f = this.font;
    if (!f) return 0;
    const hi = (code >> 8) & 0x7f;
    if (hi === 0) {
      const c = code & 0xff;
      if (cellH <= 8) return f[c * 8 + (line & 7)];
      return f[0x800 + c * 16 + (line & 0x0f)];
    }
    const right = (code & 0x8000) !== 0;
    const off = this._kanjiOffset(hi, code & 0xff);
    if (off < 0) return 0;
    return f[off + (right ? 16 : 0) + (line & 0x0f)];
  }

  tickFrame() { this.blink = (this.blink + 1) & 0xff; return this; }

  // ---- snapshot ------------------------------------------------------------------
  // The text plane always travels: it is 16 KB and it is the whole picture on a
  // machine sitting at a prompt. The graphics planes are 128 KB and only travel
  // once something has written to them.
  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      tvram: this.tvram.slice(),
      gvram: this.gvramDirty ? this.gvram.map((p) => p.slice()) : null,
      gvramDirty: this.gvramDirty,
      palette: Array.from(this.palette), palIndex: this.palIndex, analog: this.analog,
      digital: this._digital ? Array.from(this._digital) : null,
      grcgMode: this.grcgMode, grcgTile: Array.from(this.grcgTile), grcgPtr: this.grcgPtr,
      displayPage: this.displayPage, drawPage: this.drawPage, borderColour: this.borderColour,
      modeFF: Array.from(this.modeFF),
      textDisplay: this.textDisplay, gfxDisplay: this.gfxDisplay,
      cgCode: this.cgCode, blink: this.blink, egc: !!this.egc,
    };
  }

  setState(s) {
    this.tvram.set(s.tvram);
    if (s.gvram) for (let i = 0; i < PLANES; i++) this.gvram[i].set(s.gvram[i]);
    else if (this.gvramDirty) for (const p of this.gvram) p.fill(0);
    this.gvramDirty = !!s.gvramDirty;
    this.palette.set(s.palette); this.palIndex = s.palIndex; this.analog = s.analog;
    if (s.digital) { this._digital = this._digital || new Uint8Array(4); this._digital.set(s.digital); }
    this.grcgMode = s.grcgMode; this.grcgTile.set(s.grcgTile); this.grcgPtr = s.grcgPtr;
    this.displayPage = s.displayPage; this.drawPage = s.drawPage; this.borderColour = s.borderColour;
    this.modeFF.set(s.modeFF);
    this.textDisplay = s.textDisplay; this.gfxDisplay = s.gfxDisplay;
    this.cgCode = s.cgCode; this.blink = s.blink; this.egc = s.egc;
    return this;
  }
}

export default Pc98Video;
