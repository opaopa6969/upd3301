// x1001 — the Seta X1-001 / X1-002 sprite pair (SDIP64), the whole picture on
// the early Seta boards.
//
// Pure, deterministic, zero deps. No DOM, no canvas: the chip draws into an
// indexed bitmap of palette pen numbers and the machine turns that into RGB.
//
// ## It is not only a sprite chip
//
// The name is misleading. The X1-001 draws TWO things out of the same block of
// RAM, and thunderl needs both:
//
//   * 512 free sprites — 16x16 tiles at arbitrary (x, y), the obvious part.
//   * a "floating tilemap" — up to 16 columns of 2x16 tiles each, with a
//     per-column scroll pair. It is a tilemap in everything but name, and it is
//     why a board with no tilemap chip on it can still show a playfield.
//
// A machine that implements only the sprites gets a game that runs, responds to
// coins, and shows its characters floating over a blank background. That failure
// looks like a palette bug, which is why this file draws the background first
// and why the two paths are kept visibly separate below.
//
// ## Where the numbers come from
//
// Everything here was checked frame-by-frame against MAME's x1_001.cpp, which
// is the only public description of the part; docs/seta-design.md has the
// procedure. Two rules that are not guessable and cost real debugging time:
//
//   * The foreground's Y axis is UPSIDE DOWN and measured from the bottom of
//     the 256-line field: `y = height - ((spriteY + yoff) & 0xff)`. The
//     background's is not. Using one convention for both puts the playfield and
//     the pieces on top of it in different worlds.
//   * Both paths wrap: every tile is drawn again at x-512 and at y-256. This is
//     not an optimisation to skip — it is how a sprite entering from the left
//     edge is expressed, since the position fields are 9 and 8 bits wide.
//
// ## RAM layout, as the machine maps it
//
//   spriteylow[0x000..0x1ff]   sprite Y, one byte each (8 bits, never buffered)
//   spriteylow[0x200..0x2ff]   the floating tilemap's per-column scroll
//   spritectrl[0..3]           enable / flip / start column / column count / bank
//   spritecode[0x0000..0x01ff] sprite tile number + flip     (foreground)
//   spritecode[0x0200..0x03ff] sprite X + colour + bank      (foreground)
//   spritecode[0x0400..0x05ff] tilemap tile numbers          (background)
//   spritecode[0x0600..0x07ff] tilemap colours               (background)
//   ...and the same again at +0x1000, the other half of the double buffer.

export const SCHEMA_VERSION = 1;

// The chip's own RAM. These sizes are the chip's, not a board's: a board may
// decode only part of them.
const YLOW_SIZE = 0x300;
const CODE_SIZE = 0x2000;

// A power-on value of 0xff rather than 0 is deliberate and comes from the real
// part: several games never write the whole of spriteylow, and what the
// leftovers decode to is visible in the corner of the screen. 0xff is what MAME
// settled on after comparing against PCBs.
const YLOW_INIT = 0xff;
const CODE_INIT = 0xffff;

// ---- tile decoding ---------------------------------------------------------
// The sprite ROMs hold 16x16 tiles, four bitplanes, and the planes are SPLIT
// ACROSS THE REGION: the low half of the region carries planes 0 and 1, the
// high half planes 2 and 3. Inside a half, one tile is 64 bytes arranged as
// four 16-byte quadrants (top-left, top-right, bottom-left, bottom-right), and
// within a quadrant the two bytes of a row are the two bitplanes.
//
// Decoding once at load time costs one byte of RAM per pixel (1 MB for
// thunderl's 4096 tiles) and turns the inner drawing loop into an array read.
// It is derived from ROM, so it is rebuilt on load and never enters a snapshot.
export function decodeSpriteTiles(gfx) {
  const half = gfx.length >> 1;
  const tiles = (half / 64) | 0;
  const out = new Uint8Array(tiles * 256);
  for (let t = 0; t < tiles; t++) {
    const b0 = t * 64, b1 = half + t * 64, d = t * 256;
    for (let y = 0; y < 16; y++) {
      const row = ((y & 7) * 2) + (y < 8 ? 0 : 32);
      for (let xh = 0; xh < 2; xh++) {
        const o = row + (xh ? 16 : 0);
        const p0 = gfx[b0 + o], p1 = gfx[b0 + o + 1];
        const p2 = gfx[b1 + o], p3 = gfx[b1 + o + 1];
        const dst = d + y * 16 + xh * 8;
        for (let x = 0; x < 8; x++) {
          const m = 0x80 >> x;
          out[dst + x] = ((p0 & m) ? 1 : 0) | ((p1 & m) ? 2 : 0)
                       | ((p2 & m) ? 4 : 0) | ((p3 & m) ? 8 : 0);
        }
      }
    }
  }
  return { tiles: out, count: tiles };
}

export class X1001 {
  // `tiles` / `tileCount` come from decodeSpriteTiles. The offsets are the
  // board's, not the chip's: every Seta PCB needed a different fudge to line
  // the picture up with the monitor, and MAME records one set per game. They
  // are not derivable from anything, so they are configuration.
  constructor({
    tiles = null, tileCount = 0,
    width = 512, height = 256,
    colorbase = 0, transpen = 0, spriteLimit = 0x1ff,
    fgXoffs = 0, fgFlipXoffs = 0, fgYoffs = 0, fgFlipYoffs = 0,
    bgXoffs = 0, bgFlipXoffs = 0, bgYoffs = 0, bgFlipYoffs = 0,
    // height - (last visible line + 1): the blank rows below the picture, which
    // a cocktail cabinet's flipped image has to be pushed down by.
    flipYAdjust = 0,
    penMask = 0x1ff,
    bankSize = 0x1000,
    gfxbank = 'setac',      // 'setac' | 'none'
  } = {}) {
    this.schemaVersion = SCHEMA_VERSION;
    this.width = width; this.height = height;
    this.tiles = tiles; this.tileCount = tileCount;
    this.colorbase = colorbase; this.transpen = transpen;
    this.spriteLimit = spriteLimit;
    this.fgXoffs = fgXoffs; this.fgFlipXoffs = fgFlipXoffs;
    this.fgYoffs = fgYoffs; this.fgFlipYoffs = fgFlipYoffs;
    this.bgXoffs = bgXoffs; this.bgFlipXoffs = bgFlipXoffs;
    this.bgYoffs = bgYoffs; this.bgFlipYoffs = bgFlipYoffs;
    this.flipYAdjust = flipYAdjust;
    this.penMask = penMask;
    this.bankSize = bankSize;
    this.gfxbank = gfxbank;

    this.spritectrl = new Uint8Array(4);
    this.spriteylow = new Uint8Array(YLOW_SIZE);
    this.spritecode = new Uint16Array(CODE_SIZE);
    this.bitmap = new Uint16Array(width * height);
    this.powerOn();
  }

  powerOn() {
    this.spritectrl.fill(0xff);
    this.spriteylow.fill(YLOW_INIT);
    this.spritecode.fill(CODE_INIT);
    this.bgflag = 0;
    return this;
  }

  reset() { return this; } // the real part has no reset behaviour of its own

  // ---- register / RAM access ------------------------------------------------
  // The data bus is 8 bits wide inside the chip even on 68000 boards, so a word
  // write only ever delivers its LOW byte to spritectrl and spriteylow. The
  // high byte is dropped on the floor by the hardware, and a machine that
  // helpfully keeps it drifts away from the real board the first time a game
  // writes a 16-bit constant.
  ctrlRead(i) { return this.spritectrl[i & 3]; }
  ctrlWrite(i, v) { this.spritectrl[i & 3] = v & 0xff; }
  ylowRead(i) { return this.spriteylow[i % YLOW_SIZE]; }
  ylowWrite(i, v) { this.spriteylow[i % YLOW_SIZE] = v & 0xff; }
  // The code table really is 16 bits wide — it is external RAM the CPU shares.
  codeRead(i) { return this.spritecode[i % CODE_SIZE]; }
  codeWrite(i, v) { this.spritecode[i % CODE_SIZE] = v & 0xffff; }
  bgflagWrite(v) { this.bgflag = v & 0xff; }

  get flipped() { return (this.spritectrl[0] & 0x40) !== 0; }

  // The bank bit, shared by both drawing paths. Written out rather than
  // simplified: `ctrl2 ^ (~ctrl2 << 1)` compares bit 6 against bit 5, and the
  // games toggle the pair to page-flip. Simplifying it to "bit 6" works until a
  // game that uses bit 5 arrives.
  _bank() {
    const c2 = this.spritectrl[1];
    return (((c2 ^ (~c2 << 1)) & 0x40) !== 0) ? this.bankSize : 0;
  }

  // ---- the blitter ----------------------------------------------------------
  // One 16x16 tile, clipped, with an optional transparent pen. `transpen < 0`
  // means opaque, which the background uses when the game asks for it.
  _blit(code, color, flipx, flipy, sx, sy, transpen) {
    const tiles = this.tiles;
    if (!tiles || !this.tileCount) return;
    // Wrap copies are the common case and are almost always entirely off
    // screen; rejecting them before touching a pixel is what keeps a frame with
    // 512 sprites x 4 positions affordable.
    if (sx <= -16 || sy <= -16 || sx >= this.width || sy >= this.height) return;
    const base = (code % this.tileCount) * 256;
    const pen = (color * 16) & this.penMask;
    const W = this.width;
    const x0 = sx < 0 ? -sx : 0, x1 = sx + 16 > W ? W - sx : 16;
    const y0 = sy < 0 ? -sy : 0, y1 = sy + 16 > this.height ? this.height - sy : 16;
    const bmp = this.bitmap;
    for (let y = y0; y < y1; y++) {
      const ty = flipy ? 15 - y : y;
      const src = base + ty * 16;
      let dst = (sy + y) * W + sx;
      for (let x = x0; x < x1; x++) {
        const p = tiles[src + (flipx ? 15 - x : x)];
        if (p !== transpen) bmp[dst + x] = pen | p;
      }
    }
  }

  // Draw a tile at its four wrapped positions. The X field is 9 bits and the Y
  // field 8, so "x - 512" and "y - 256" are the same tile seen from the other
  // side of the counter rolling over.
  _blitWrapped(code, color, flipx, flipy, sx, sy, transpen) {
    this._blit(code, color, flipx, flipy, sx, sy, transpen);
    this._blit(code, color, flipx, flipy, sx - 512, sy, transpen);
    this._blit(code, color, flipx, flipy, sx, sy - 256, transpen);
    this._blit(code, color, flipx, flipy, sx - 512, sy - 256, transpen);
  }

  // ---- the floating tilemap -------------------------------------------------
  // Columns of 2x16 tiles. `numcol` columns starting at `startcol`, each with
  // its own scroll pair; ctrl[2..3] is a per-column bit that shifts a column
  // left by a whole screen, which is how the map is scrolled past the seam.
  drawBackground() {
    const ctrl = this.spritectrl[0], ctrl2 = this.spritectrl[1];
    const flip = (ctrl & 0x40) !== 0;
    let numcol = ctrl2 & 0x0f;
    if (numcol === 1) numcol = 16;     // 0x1 means "all of them", 0x0 means none
    if (!numcol) return;
    const bank = this._bank();
    const code0 = this.spritecode;
    const scroll = this.spriteylow;    // read from +0x200 below
    const xoffs = flip ? this.bgFlipXoffs : this.bgXoffs;
    const yoffs = flip ? this.bgFlipYoffs : this.bgYoffs;
    const transpen = (this.bgflag & 0x80) ? -1 : this.transpen;
    const maxY = 0xf0;                 // the flip pivot, a chip constant
    let startcol = 0;
    if (ctrl & 0x01) startcol += 0x4;
    if (ctrl & 0x02) startcol += 0x8;
    const upper = this.spritectrl[2] + this.spritectrl[3] * 256;

    for (let col = 0; col < numcol; col++) {
      const scrollx = scroll[0x200 + col * 0x10 + 4];
      const scrolly = scroll[0x200 + col * 0x10];
      for (let offs = 0; offs < 0x20; offs++) {
        const i = (((col + startcol) & 0xf) * 32 + offs) + 0x400 + bank;
        const raw = code0[i];
        let color = code0[i + 0x200];
        let flipx = (raw & 0x8000) !== 0, flipy = (raw & 0x4000) !== 0;
        let sx = scrollx + xoffs + (offs & 1) * 16;
        let sy = -(scrolly + yoffs) + ((offs / 2) | 0) * 16;
        if (upper & (1 << col)) sx -= 256;
        if (flip) { sy = maxY - sy; flipx = !flipx; flipy = !flipy; }
        color = (color >> 11) & 0x1f;
        this._blitWrapped(raw & 0x3fff, color, flipx, flipy,
                          sx & 0x1ff, sy & 0xff, transpen);
      }
    }
  }

  // ---- the sprites ----------------------------------------------------------
  // Drawn back to front (highest index first) so sprite 0 ends up on top, which
  // is the priority order the games assume.
  drawForeground() {
    const flip = (this.spritectrl[0] & 0x40) !== 0;
    const bank = this._bank();
    const code0 = this.spritecode;
    const chr = 0x0000 + bank, xp = 0x0200 + bank;
    const xoffs = flip ? this.fgFlipXoffs : this.fgXoffs;
    const yoffs = flip ? this.fgFlipYoffs : this.fgYoffs;
    const maxY = this.height;
    const transpen = this.transpen;
    for (let i = this.spriteLimit; i >= 0; i--) {
      const c = code0[chr + i], x = code0[xp + i];
      let code = c & 0x3fff;
      let color = (x & 0xf800) >> 11;
      // The X field is 9 bits in sign-magnitude-ish form: bit 8 is subtracted
      // rather than being the top of an unsigned number, so a sprite half off
      // the left edge has a small positive low byte and bit 8 set.
      const sx = (x & 0x00ff) - (x & 0x0100);
      let sy = this.spriteylow[i] & 0xff;
      let flipx = (c & 0x8000) !== 0, flipy = (c & 0x4000) !== 0;
      // The tile ROM is bigger than the 14-bit code field, so two bits of the
      // colour word select a 16K-tile bank. This is the only reason a game can
      // reach its later graphics at all.
      if (this.gfxbank === 'setac') code = (code & 0x3fff) + (((x >> 9) & 3) * 0x4000);
      color = (color & 0x1f) + this.colorbase;
      if (flip) {
        sy = maxY - sy + this.flipYAdjust;
        flipx = !flipx; flipy = !flipy;
      }
      this._blitWrapped(code, color, flipx, flipy,
                        (sx + xoffs) & 0x1ff, maxY - ((sy + yoffs) & 0xff), transpen);
    }
  }

  // Draw a whole field. `bgPen` is what the board fills with before anything is
  // drawn — on the Seta boards it is a fixed high pen, not palette entry 0.
  drawFrame(bgPen = 0x1f0) {
    this.bitmap.fill(bgPen);
    this.drawBackground();
    this.drawForeground();
    return this.bitmap;
  }

  // End-of-frame double buffering. Only some boards wire it; the ones that do
  // page-flip the whole code table so a half-written frame is never shown.
  eof() {
    const ctrl2 = this.spritectrl[1];
    if (~ctrl2 & 0x20) {
      const c = this.spritecode;
      if (ctrl2 & 0x40) c.copyWithin(0x0000, 0x1000, 0x1800);
      else c.copyWithin(0x1000, 0x0000, 0x0800);
    }
    return this;
  }

  // ---- state ----------------------------------------------------------------
  // Chip RAM only: 0x300 + 0x2000 words + four registers, about 17 KB. The
  // decoded tiles and the bitmap are derived and stay out.
  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      ctrl: this.spritectrl.slice(),
      ylow: this.spriteylow.slice(),
      code: this.spritecode.slice(),
      bgflag: this.bgflag,
    };
  }

  setState(s) {
    this.spritectrl.set(s.ctrl);
    this.spriteylow.set(s.ylow);
    this.spritecode.set(s.code);
    this.bgflag = s.bgflag | 0;
    return this;
  }
}

export default X1001;
