// x68video — the X68000's picture: four graphics pages, a text plane, a
// sprite controller with two tile maps, and the priority resolver that
// decides which of them a given dot belongs to.
//
// The X68000's video memory is unusual in that the *same* 512 KB of graphics
// RAM appears in the 68000's map in four different shapes depending on two
// bits of CRTC R20. That is not a mode switch in the usual sense: the RAM is
// always 512x512 sixteen-bit words, and the colour mode decides how many of
// those bits belong to one dot.
//
//   16 colours   4 pages, one nibble each, 512x512 per page
//   16 colours   1 page of 1024x1024, the four nibbles being its quadrants
//   256 colours  2 pages, one byte each, 512x512 per page
//   65536colours 1 page, the whole word IS the colour, no palette lookup
//
// So a write to $C00001 in 16-colour mode changes four bits of one word, and
// the same write in 65536-colour mode changes eight. Both are here.
//
// ## Colour
//
// A palette entry is GGGGGRRRRRBBBBBI: five bits per gun plus one shared
// least-significant bit. That gives 65536 colours from 32x32x32 pairs, and it
// is also why the 65536-colour graphics mode needs no palette — the pixel is
// already in that format.
//
// ## Priority
//
// Three layers (graphics, text, sprite/BG) each carry a two-bit priority in
// the video controller's register 1, and within the graphics layer the four
// pages carry two bits each. Equal priorities resolve GRP < SPRITE < TEXT.
// The transparency rule is per layer: palette index 0 is transparent for text
// and sprites, and for graphics only above the bottom-most enabled page.
//
// Pure, deterministic, zero deps. No DOM, no canvas: render() returns plain
// data the way machine88.js and mdvdp.js do.

export const SCHEMA_VERSION = 1;

const GVRAM_WORDS = 512 * 512;     // 512 KB, the whole graphics memory
const TVRAM_BYTES = 0x80000;       // four 1024x1024 bit planes
const TPLANE = 0x20000;
const BG_BYTES = 0x8000;           // PCG patterns and the two tile maps
const MAX_W = 1024, MAX_H = 1024;

// GGGGGRRRRRBBBBBI -> 8 bits per gun. The I bit is the common low bit of all
// three, so a gun is six bits and the top two are replicated into the bottom.
function toRgb(v) {
  const i = v & 1;
  const r = (((v >> 6) & 0x1f) << 1) | i;
  const g = (((v >> 11) & 0x1f) << 1) | i;
  const b = (((v >> 1) & 0x1f) << 1) | i;
  return [(r << 2) | (r >> 4), (g << 2) | (g >> 4), (b << 2) | (b >> 4)];
}

export class X68Video {
  constructor({ crtc = null } = {}) {
    this.crtc = crtc;
    this.gvram = new Uint16Array(GVRAM_WORDS);
    this.tvram = new Uint8Array(TVRAM_BYTES);
    this.bg = new Uint8Array(BG_BYTES);
    this.sprReg = new Uint8Array(0x400);   // 128 sprites x 8 bytes
    this.bgReg = new Uint8Array(0x12);
    this.palReg = new Uint8Array(0x400);   // $E82000: 256 graphics + 256 text
    this.vc = new Uint8Array(6);           // VCReg0/1/2, high byte then low
    this.contrast = 15;

    this.frameRgb = new Uint8Array(MAX_W * MAX_H * 3);
    this.width = 0; this.height = 0;
    this._gLine = new Int32Array(MAX_W);
    this._tLine = new Int32Array(MAX_W);
    this._sLine = new Int32Array(MAX_W);
    this._sPri = new Uint8Array(MAX_W);
    this.powerOn();
  }

  powerOn() {
    this.gvram.fill(0);
    this.tvram.fill(0);
    this.bg.fill(0);
    // Half a megabyte of graphics memory and 32 KB of sprite patterns travel in
    // every snapshot the host takes, and a machine sitting at a Human68k
    // prompt has never written a byte of either. Copying them only once
    // something has is worth 544 KB a frame of rewind ring.
    this.gvramDirty = false;
    this.bgDirty = false;
    this.frameRgb.fill(0);
    return this.reset();
  }

  reset() {
    this.sprReg.fill(0);
    this.bgReg.fill(0);
    this.palReg.fill(0);
    this.vc.fill(0);
    this.contrast = 15;
    return this;
  }

  setContrast(v) { this.contrast = v & 0x0f; return this; }

  // ---- graphics VRAM -----------------------------------------------------------
  // `mode` and `wide` come from CRTC R20's HIGH byte, which is the ACCESS
  // shape. The video controller has its own copy that decides the DISPLAY
  // shape, and programs are allowed to disagree with themselves — 16-bit
  // access with a 256-colour display is how a couple of games do their
  // loading screens.
  _gmode() {
    const r = this.crtc ? this.crtc.reg[0x28] : 0;
    return { m: r & 3, wide: (r & 4) !== 0, flat: (r & 8) !== 0 };
  }

  readGvram8(a) {
    const off = (a - 0xc00000) & 0x1fffff;
    const { m, wide, flat } = this._gmode();
    if (flat || m === 3) {
      if (off >= 0x100000) return 0;
      const w = this.gvram[off >> 1];
      return (off & 1) ? (w & 0xff) : (w >> 8);
    }
    if (!(off & 1)) return 0;             // the data is on the odd half only
    const e = off - 1;
    if (m === 0) {
      if (wide) {
        const word = ((e & 0xff800) >> 2) + ((e & 0x3fe) >> 1);
        const shift = ((e >> 17) & 8) + ((e >> 8) & 4);
        return (this.gvram[word] >> shift) & 15;
      }
      return (this.gvram[(e & 0x7fffe) >> 1] >> ((e >> 17) & 0x0c)) & 15;
    }
    if (e >= 0x100000) return 0;
    return (this.gvram[(e & 0x7fffe) >> 1] >> ((e >> 16) & 8)) & 0xff;
  }

  writeGvram8(a, v) {
    this.gvramDirty = true;
    const off = (a - 0xc00000) & 0x1fffff;
    const { m, wide, flat } = this._gmode();
    v &= 0xff;
    if (flat || m === 3) {
      if (off >= 0x100000) return;
      const i = off >> 1;
      const w = this.gvram[i];
      this.gvram[i] = (off & 1) ? ((w & 0xff00) | v) : ((w & 0x00ff) | (v << 8));
      return;
    }
    if (!(off & 1)) return;
    const e = off - 1;
    if (m === 0) {
      let word, shift;
      if (wide) {
        word = ((e & 0xff800) >> 2) + ((e & 0x3fe) >> 1);
        shift = ((e >> 17) & 8) + ((e >> 8) & 4);
      } else {
        word = (e & 0x7fffe) >> 1;
        shift = (e >> 17) & 0x0c;
      }
      this.gvram[word] = (this.gvram[word] & ~(0xf << shift)) | ((v & 15) << shift);
      return;
    }
    if (e >= 0x100000) return;
    const word = (e & 0x7fffe) >> 1;
    const shift = (e >> 16) & 8;
    this.gvram[word] = (this.gvram[word] & ~(0xff << shift)) | (v << shift);
  }

  readGvram16(a) { return (this.readGvram8(a) << 8) | this.readGvram8(a + 1); }
  writeGvram16(a, v) { this.writeGvram8(a, (v >> 8) & 0xff); this.writeGvram8(a + 1, v & 0xff); }

  // A 16-bit write in 65536-colour mode is one whole pixel and does not go
  // through the byte path — it is the common case and worth the shortcut.
  _gvramWord(a, v) {
    this.gvramDirty = true;
    const off = (a - 0xc00000) & 0x1fffff;
    if (off < 0x100000) this.gvram[off >> 1] = v & 0xffff;
  }

  // ---- text VRAM ------------------------------------------------------------------
  // Four planes, one bit per dot each, 1024x1024. The interest is in R21: with
  // "simultaneous access" set, one write goes to every plane R21 selects, and
  // with the mask enabled R23 says which BITS of the byte survive. Together
  // they draw a four-colour character with a single MOVE.
  readText8(a) { return this.tvram[a & 0x7ffff]; }

  writeText8(a, v) {
    const off = a & 0x7ffff;
    const r = this.crtc ? this.crtc.reg : null;
    const ctl = r ? r[0x2a] : 0;
    const planes = r ? r[0x2b] : 0;
    const mask = r ? ((a & 1) ? r[0x2f] : r[0x2e]) : 0;
    const masked = (ctl & 2) !== 0;
    if (ctl & 1) {
      const base = off & 0x1ffff;
      for (let p = 0; p < 4; p++) {
        if (!(planes & (0x10 << p))) continue;
        this._tput(base + p * TPLANE, v, masked, mask);
      }
      return;
    }
    this._tput(off, v, masked, mask);
  }

  _tput(i, v, masked, mask) {
    // A mask bit of 1 KEEPS the old bit. Programs set the mask to the inverse
    // of the character's own bitmap so a glyph can be painted without first
    // clearing the cell.
    this.tvram[i] = masked ? ((this.tvram[i] & mask) | (v & ~mask)) : (v & 0xff);
  }

  readText16(a) { const o = a & 0x7fffe; return (this.tvram[o] << 8) | this.tvram[o + 1]; }
  writeText16(a, v) { this.writeText8(a, (v >> 8) & 0xff); this.writeText8(a + 1, v & 0xff); }

  // The CRTC's hardware line copy, in units of four raster lines (512 bytes),
  // per plane. This is what makes a full-screen text scroll free.
  rasterCopy(src, dst, planeMask) {
    const s = (src << 9) & 0x1ffff;
    const d = (dst << 9) & 0x1ffff;
    for (let p = 0; p < 4; p++) {
      if (!(planeMask & (1 << p))) continue;
      const base = p * TPLANE;
      this.tvram.copyWithin(base + d, base + s, base + s + 512);
    }
    return this;
  }

  // The CRTC's fast clear wipes graphics memory during the vertical blank.
  // The mask names the NIBBLES to keep, so clearing page 1 alone means an AND
  // with $F0F0-style patterns rather than a memset.
  fastClear(keepMask) {
    const r = this.crtc ? this.crtc.reg : null;
    const lo = r ? r[0x29] : 0;
    const rows = (lo & 4) ? 512 : 256;
    const cols = (lo & 3) ? 512 : 256;
    let word = 0;
    for (let i = 0; i < 4; i++) if (keepMask & (1 << i)) word |= 0xf << (i * 4);
    const sy = this.crtc ? (this.crtc.graphScrollY[0] & 511) : 0;
    const sx = this.crtc ? (this.crtc.graphScrollX[0] & 511) : 0;
    for (let y = 0; y < rows; y++) {
      const row = ((sy + y) & 511) * 512;
      for (let x = 0; x < cols; x++) this.gvram[row + ((sx + x) & 511)] &= word;
    }
    return this;
  }

  // ---- palette and the video controller ----------------------------------------------
  readCtrl8(a) {
    const o = a & 0x1fff;   // offset inside the 8 KB block at $E82000
    if (o < 0x400) return this.palReg[o];
    if (o < 0x700) {
      const g = (o >> 8) & 7;   // 4 -> VCReg0, 5 -> VCReg1, 6 -> VCReg2
      if (g >= 4 && g <= 6) return this.vc[(g - 4) * 2 + (o & 1)];
      return 0xff;
    }
    return 0xff;
  }

  writeCtrl8(a, v) {
    const o = a & 0x1fff;   // offset inside the 8 KB block at $E82000
    if (o < 0x400) { this.palReg[o] = v & 0xff; return; }
    if (o < 0x700) {
      const g = (o >> 8) & 7;
      if (g >= 4 && g <= 6) this.vc[(g - 4) * 2 + (o & 1)] = v & 0xff;
    }
  }

  _grphPal(i) { const o = (i & 0xff) * 2; return (this.palReg[o] << 8) | this.palReg[o + 1]; }
  _textPal(i) { const o = 0x200 + (i & 0xff) * 2; return (this.palReg[o] << 8) | this.palReg[o + 1]; }

  // ---- sprites, PCG and the two BG planes --------------------------------------------
  readSprite8(a) {
    const o = a & 0xffff;
    if (o < 0x400) return this.sprReg[o];
    if (o >= 0x800 && o < 0x812) return this.bgReg[o - 0x800];
    if (o >= 0x8000) return this.bg[o - 0x8000];
    return 0x00;
  }

  writeSprite8(a, v) {
    const o = a & 0xffff;
    v &= 0xff;
    if (o < 0x400) { this.sprReg[o] = v; return; }
    if (o >= 0x800 && o < 0x812) { this.bgReg[o - 0x800] = v; return; }
    if (o >= 0x8000) { this.bgDirty = true; this.bg[o - 0x8000] = v; return; }
  }

  readSprite16(a) { return (this.readSprite8(a) << 8) | this.readSprite8(a + 1); }
  writeSprite16(a, v) { this.writeSprite8(a, (v >> 8) & 0xff); this.writeSprite8(a + 1, v & 0xff); }

  // ---- rendering ------------------------------------------------------------------------
  beginFrame() {
    const c = this.crtc;
    const w = Math.max(0, Math.min(MAX_W, c ? c.width : 0));
    const h = Math.max(0, Math.min(MAX_H, c ? c.height : 0));
    this.width = w; this.height = h;
    return this;
  }

  endFrame() { return this; }

  renderLine(y, vline) {
    const W = this.width;
    if (!W || y < 0 || y >= this.height) return this;
    this._graphicsLine(y, W);
    this._textLine(y, W);
    this._spriteLine(y, W);
    this._compose(y, W);
    return this;
  }

  // The graphics layer, already resolved down to one 16-bit colour per dot
  // (or -1 where nothing is enabled at all).
  _graphicsLine(y, W) {
    const out = this._gLine;
    const vc0 = this.vc[1];               // VCReg0 low byte: the display mode
    const enable = this.vc[5] & 0x0f;     // VCReg2 low byte: which pages show
    const order = this.vc[3];             // VCReg1 low byte: page per priority slot
    const mode = vc0 & 3;
    const wide = (vc0 & 4) !== 0;
    const c = this.crtc;
    // A doubled vertical scan advances two rasters per displayed line.
    const yy = (c && c.doubleScan) ? y * 2 : y;

    if (mode === 3) {
      if (!(enable & 0x0f)) { out.fill(-1, 0, W); return; }
      // 65536 colours. The word is already in the palette's own GRB format,
      // but the hardware still runs it through the palette RAM one byte at a
      // time — which is why the IOCS programs an identity palette here, and
      // why a program that does not gets a colour scramble rather than nothing.
      const sx = c ? c.graphScrollX[0] : 0, sy = c ? c.graphScrollY[0] : 0;
      const row = ((yy + sy) & 511) * 512;
      for (let x = 0; x < W; x++) {
        const px = this.gvram[row + ((x + sx) & 511)];
        if (!px) { out[x] = 0; continue; }
        const lo = px & 0xff, hi = (px >> 8) & 0xff;
        const l = this.palReg[((lo & 0xfe) * 2 + (lo & 1)) & 0x3ff];
        const h = this.palReg[((hi & 0xfe) * 2 + (hi & 1) + 2) & 0x3ff];
        out[x] = (h << 8) | l;
      }
      return;
    }

    if (mode === 1 || mode === 2) {
      // 256 colours, two pages of one byte each. The catch is that the two
      // NIBBLES of that byte scroll independently — R12/R13 move the low half
      // and R14/R15 the high half — so a page is really two 4-bit planes that
      // happen to share a byte. Games slide the colour ramp under a static
      // image with it.
      if (!(enable & 5)) { out.fill(-1, 0, W); return; }
      const p0First = (order & 3) <= ((order >> 4) & 3);
      const val = (page) => {
        const sxl = c ? c.graphScrollX[page * 2] : 0, syl = c ? c.graphScrollY[page * 2] : 0;
        const sxh = c ? c.graphScrollX[page * 2 + 1] : 0, syh = c ? c.graphScrollY[page * 2 + 1] : 0;
        const rl = ((yy + syl) & 511) * 512, rh = ((yy + syh) & 511) * 512;
        const shift = page * 8;
        return (x) => (((this.gvram[rl + ((x + sxl) & 511)] >> shift) & 0x0f)
                     | ((this.gvram[rh + ((x + sxh) & 511)] >> shift) & 0xf0));
      };
      const f0 = (enable & 1) ? val(0) : null;
      const f1 = (enable & 4) ? val(1) : null;
      for (let x = 0; x < W; x++) {
        const v0 = f0 ? f0(x) : 0;
        const v1 = f1 ? f1(x) : 0;
        const top = p0First ? (v0 || v1) : (v1 || v0);
        out[x] = this._grphPal(top);
      }
      return;
    }

    if (wide) {
      // One 1024x1024 page whose four quadrants are the four nibbles. Its
      // enable is a bit of its own rather than one of the four page bits.
      if (!(enable & 0x10)) { out.fill(-1, 0, W); return; }
      const sx = c ? c.graphScrollX[0] : 0, sy = c ? c.graphScrollY[0] : 0;
      for (let x = 0; x < W; x++) {
        const px = (x + sx) & 1023, py = (yy + sy) & 1023;
        const w = this.gvram[(py & 511) * 512 + (px & 511)];
        const shift = ((py >> 9) & 1) * 8 + ((px >> 9) & 1) * 4;
        out[x] = this._grphPal((w >> shift) & 15);
      }
      return;
    }

    // Four 512x512 pages. Slot 0 is the top and slot 3 the bottom; the page
    // number sitting in each slot comes from two bits of VCReg1.
    if (!(enable & 0x0f)) { out.fill(-1, 0, W); return; }
    const sx = [0, 0, 0, 0], sy = [0, 0, 0, 0], rows = [0, 0, 0, 0];
    for (let p = 0; p < 4; p++) {
      sx[p] = c ? c.graphScrollX[p] : 0;
      sy[p] = c ? c.graphScrollY[p] : 0;
      rows[p] = ((yy + sy[p]) & 511) * 512;
    }
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let slot = 0; slot < 4; slot++) {
        if (!(enable & (1 << slot))) continue;
        const page = (order >> (slot * 2)) & 3;
        const n = (this.gvram[rows[page] + ((x + sx[page]) & 511)] >> (page * 4)) & 15;
        if (n) { v = n; break; }
      }
      out[x] = this._grphPal(v);
    }
  }

  _textLine(y, W) {
    const out = this._tLine;
    if (!(this.vc[5] & 0x20)) { out.fill(-1, 0, W); return; }
    const c = this.crtc;
    const sx = c ? c.textScrollX : 0, sy = c ? c.textScrollY : 0;
    const yy = (c && c.doubleScan) ? y * 2 : y;
    const rowBase = ((yy + sy) & 1023) * 128;
    for (let x = 0; x < W; x++) {
      const px = (x + sx) & 1023;
      const byte = rowBase + (px >> 3);
      const bit = 7 - (px & 7);
      const n = (((this.tvram[byte] >> bit) & 1))
        | (((this.tvram[TPLANE + byte] >> bit) & 1) << 1)
        | (((this.tvram[2 * TPLANE + byte] >> bit) & 1) << 2)
        | (((this.tvram[3 * TPLANE + byte] >> bit) & 1) << 3);
      out[x] = n ? this._textPal(n) : -1;
    }
  }

  // Sprites and the two tile planes share the PCG memory and the sprite
  // palette. Everything here is 16 colours out of a 16-entry block, index 0
  // transparent, which is why one 256-entry palette serves all of it.
  _spriteLine(y, W) {
    const out = this._sLine;
    const pri = this._sPri;
    out.fill(-1, 0, W);
    pri.fill(0, 0, W);
    if (!(this.vc[5] & 0x40)) return;
    if (!(this.bgReg[8] & 2)) return;      // the controller's master enable
    if (this.bgReg[0x11] & 2) return;      // and its "nothing at all" bit

    const cell = (this.bgReg[0x11] & 3) ? 16 : 8;
    const cfg = this.bgReg[9];
    // Order, bottom to top: sprites at priority 1, tile plane 1, sprites at
    // priority 2, tile plane 0, sprites at priority 3. Plane 1 only exists in
    // the 8x8 cell mode — in 16x16 there is not enough pattern memory left.
    this._sprites(y, W, 1);
    if ((cfg & 8) && cell === 8) this._bgPlane(y, W, (cfg & 0x30) ? 0x6000 : 0x4000, 1, cell);
    this._sprites(y, W, 2);
    if (cfg & 1) this._bgPlane(y, W, (cfg & 6) ? 0x6000 : 0x4000, 0, cell);
    this._sprites(y, W, 3);
  }

  // 128 sprites; within a priority band the LOWEST numbered sprite wins, and
  // because the winner is remembered across the three bands a low-numbered
  // sprite at priority 1 beats a high-numbered one at priority 3. That is the
  // hardware's arbitration and games rely on it for layering.
  _sprites(y, W, band) {
    const out = this._sLine, pri = this._sPri;
    for (let i = 127; i >= 0; i--) {
      const o = i * 8;
      if ((this.sprReg[o + 7] & 3) !== band) continue;
      const sxp = (((this.sprReg[o] << 8) | this.sprReg[o + 1]) & 0x3ff) - 16;
      const syp = (((this.sprReg[o + 2] << 8) | this.sprReg[o + 3]) & 0x3ff) - 16;
      if (y < syp || y >= syp + 16) continue;
      const attr = (this.sprReg[o + 4] << 8) | this.sprReg[o + 5];
      const pat = attr & 0xff;
      const block = (attr >> 8) & 0x0f;
      const hf = (attr & 0x4000) !== 0, vf = (attr & 0x8000) !== 0;
      let ry = y - syp;
      if (vf) ry = 15 - ry;
      const rank = i + 1; // 0 means "nothing here yet", so ranks start at 1
      for (let dx = 0; dx < 16; dx++) {
        const x = sxp + dx;
        if (x < 0 || x >= W) continue;
        const rx = hf ? 15 - dx : dx;
        const n = this._pcg16(pat, rx, ry);
        if (!n) continue;
        if (pri[x] !== 0 && pri[x] <= rank) continue;
        out[x] = this._textPal(block * 16 + n);
        pri[x] = rank;
      }
    }
  }

  _bgPlane(y, W, base, which, cell) {
    const r = this.bgReg;
    const sx = ((r[which ? 4 : 0] << 8) | r[which ? 5 : 1]) & (cell === 16 ? 1023 : 511);
    const sy = ((r[which ? 6 : 2] << 8) | r[which ? 7 : 3]) & (cell === 16 ? 1023 : 511);
    const mask = cell === 16 ? 1023 : 511;
    const py = (y + sy) & mask;
    const cy = (py / cell) | 0, iy = py % cell;
    for (let x = 0; x < W; x++) {
      // A tile plane paints over the sprite band below it, and clearing the
      // rank lets the next band of sprites paint over the tiles in turn.
      const px = (x + sx) & mask;
      const cx = (px / cell) | 0, ix = px % cell;
      const e = base + ((cy & 63) * 64 + (cx & 63)) * 2;
      const attr = (this.bg[e] << 8) | this.bg[e + 1];
      const pat = attr & 0xff;
      const block = (attr >> 8) & 0x0f;
      const hf = (attr & 0x4000) !== 0, vf = (attr & 0x8000) !== 0;
      const rx = hf ? cell - 1 - ix : ix;
      const ry = vf ? cell - 1 - iy : iy;
      const n = cell === 16 ? this._pcg16(pat, rx, ry) : this._pcg8(pat, rx, ry);
      if (!n) continue;
      this._sLine[x] = this._textPal(block * 16 + n);
      this._sPri[x] = 0;
    }
  }

  // A 16x16 pattern is 128 bytes stored as two 8-wide halves: bytes 0-63 are
  // the left eight columns, 64-127 the right. Four bytes per row, high nibble
  // to the left.
  _pcg16(pat, x, y) {
    const o = (pat << 7) + ((x & 8) ? 0x40 : 0) + ((y & 15) << 2) + ((x & 7) >> 1);
    const b = this.bg[o & 0x7fff];
    return (x & 1) ? (b & 15) : (b >> 4);
  }

  // An 8x8 pattern is 32 bytes, four per row.
  _pcg8(pat, x, y) {
    const o = (pat << 5) + ((y & 7) << 2) + ((x & 7) >> 1);
    const b = this.bg[o & 0x7fff];
    return (x & 1) ? (b & 15) : (b >> 4);
  }

  // The final resolver. Priority 0 is the top; ties go GRP < SPRITE < TEXT,
  // which is what the hardware does when a program leaves two layers on the
  // same level (and several do).
  _compose(y, W) {
    const vc1 = this.vc[2];               // VCReg1 HIGH byte holds the layer priorities
    const gp = vc1 & 3, tp = (vc1 >> 2) & 3, sp = (vc1 >> 4) & 3;
    const g = this._gLine, t = this._tLine, s = this._sLine;
    const rgb = this.frameRgb;
    let o = y * this.width * 3;
    const back = this._grphPal(0);
    for (let x = 0; x < W; x++) {
      let best = -1, bestPri = 4, bestTie = -1;
      if (t[x] >= 0 && (tp < bestPri || (tp === bestPri && 2 > bestTie))) { best = t[x]; bestPri = tp; bestTie = 2; }
      if (s[x] >= 0 && (sp < bestPri || (sp === bestPri && 1 > bestTie))) { best = s[x]; bestPri = sp; bestTie = 1; }
      if (g[x] >= 0 && (gp < bestPri || (gp === bestPri && 0 > bestTie))) { best = g[x]; bestPri = gp; bestTie = 0; }
      const c = toRgb(best >= 0 ? best : back);
      // Contrast is the machine's brightness knob, and the IPL turns it up
      // during boot: a picture rendered at the reset value is black.
      const k = this.contrast;
      rgb[o++] = (c[0] * k / 15) | 0;
      rgb[o++] = (c[1] * k / 15) | 0;
      rgb[o++] = (c[2] * k / 15) | 0;
    }
  }

  // ---- output ---------------------------------------------------------------------------
  // Same shape as machine88.js / mdvdp.js: RGB by default, and a GRB index
  // plus per-gun drive for the demo's shared phosphor pipeline.
  render({ out = null, indexed = false, analog = true } = {}) {
    const W = this.width || 1, H = this.height || 1, N = W * H;
    const src = this.frameRgb;
    if (indexed) {
      const pixels = out && out.length === N ? out : new Uint8Array(N);
      let drive = null;
      if (analog) {
        if (!this._driveBuf || this._driveBuf.length !== N * 3) this._driveBuf = new Float32Array(N * 3);
        drive = this._driveBuf;
      }
      for (let i = 0; i < N; i++) {
        const r = src[i * 3], g = src[i * 3 + 1], b = src[i * 3 + 2];
        pixels[i] = (g >= 128 ? 4 : 0) | (r >= 128 ? 2 : 0) | (b >= 128 ? 1 : 0);
        if (drive) { drive[i] = r / 255; drive[N + i] = g / 255; drive[2 * N + i] = b / 255; }
      }
      return { width: W, height: H, pixels, drive, schemaVersion: SCHEMA_VERSION };
    }
    const rgb = out && out.length === N * 3 ? out : new Uint8Array(N * 3);
    rgb.set(src.subarray(0, N * 3));
    return { width: W, height: H, rgb, schemaVersion: SCHEMA_VERSION };
  }

  // ---- state -----------------------------------------------------------------------------
  // The frame buffer is deliberately absent: it is output, not state. Video
  // memory is not, and it is the second biggest thing in an X68000 snapshot
  // after main RAM — 512 KB of graphics plus 512 KB of text.
  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      // `null` here is not "unknown", it is "still all zeroes" — the flags are
      // monotonic, so restoring a snapshot without a copy clears the memory.
      gvram: this.gvramDirty ? this.gvram.slice() : null,
      gvramDirty: this.gvramDirty,
      tvram: this.tvram.slice(),
      bg: this.bgDirty ? this.bg.slice() : null,
      bgDirty: this.bgDirty,
      sprReg: this.sprReg.slice(),
      bgReg: this.bgReg.slice(),
      palReg: this.palReg.slice(),
      vc: this.vc.slice(),
      contrast: this.contrast,
    };
  }

  setState(s) {
    if (s.gvram) this.gvram.set(s.gvram); else this.gvram.fill(0);
    this.gvramDirty = !!s.gvramDirty;
    this.tvram.set(s.tvram);
    if (s.bg) this.bg.set(s.bg); else this.bg.fill(0);
    this.bgDirty = !!s.bgDirty;
    this.sprReg.set(s.sprReg);
    this.bgReg.set(s.bgReg);
    this.palReg.set(s.palReg);
    this.vc.set(s.vc);
    this.contrast = s.contrast;
    return this;
  }
}

export function createX68Video(opts) { return new X68Video(opts); }
export default X68Video;
