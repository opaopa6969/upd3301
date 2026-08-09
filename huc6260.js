// huc6260 — the VCE, the PC Engine's colour encoder.
//
// The smallest chip in the machine and the one that decides what the other two
// are allowed to do. It owns three things:
//
//   The palette. 512 entries of nine bits — GGGRRRBBB, three bits a gun. The
//   first 256 belong to the background (16 palettes of 16), the second 256 to
//   the sprites. Entry 0 is the backdrop: it is what shows wherever both the
//   background and the sprites are transparent, and it is also what colour 0 of
//   every palette displays as, which is why a PC Engine game can flash the
//   whole screen by writing one word.
//
//   The dot clock. 5.37, 7.16 or 10.74 MHz, i.e. 256, 336 or 512 pixels across
//   the same scanline. This is why the machine cannot assume a screen size the
//   way the Famicom can: the game picks one, and a few change it mid-run.
//
//   The line count, 262 or 263.
//
// Everything here is plain data. The 9-bit colours are what the VDC's output
// gets turned into DURING emulation (see machinepce.js), not at render time, so
// a game that rewrites the palette in a raster interrupt gets the split it
// asked for instead of the last palette of the frame applied to all 240 lines.

export const SCHEMA_VERSION = 1;

export const PALETTE_ENTRIES = 512;

// Master clock divided by 4 / 3 / 2. The width follows from it: a scanline is
// always 1365 master clocks, so a faster dot clock buys more dots, not more
// time.
export const DOT_DIVIDERS = Object.freeze([4, 3, 2, 2]);

// 9-bit GGGRRRBBB to 8-bit-per-gun RGB. The three-bit fields are expanded by
// replication (v*255/7), which is what makes 7 come out as 255 rather than 224
// and keeps whites white.
export function buildVcePaletteRgb() {
  const t = new Uint8Array(PALETTE_ENTRIES * 3);
  for (let c = 0; c < PALETTE_ENTRIES; c++) {
    const g = (c >> 6) & 7, r = (c >> 3) & 7, b = c & 7;
    t[c * 3] = Math.round((r * 255) / 7);
    t[c * 3 + 1] = Math.round((g * 255) / 7);
    t[c * 3 + 2] = Math.round((b * 255) / 7);
  }
  return t;
}

// The same table in luminance-only form, for the VCE's black-and-white mode
// (control bit 7). Rec.601 weights; the hardware does something analogue and
// approximate, and so does this.
export function buildVceGrayRgb() {
  const rgb = buildVcePaletteRgb();
  const t = new Uint8Array(PALETTE_ENTRIES * 3);
  for (let c = 0; c < PALETTE_ENTRIES; c++) {
    const y = Math.round(0.299 * rgb[c * 3] + 0.587 * rgb[c * 3 + 1] + 0.114 * rgb[c * 3 + 2]);
    t[c * 3] = t[c * 3 + 1] = t[c * 3 + 2] = y;
  }
  return t;
}

export class HuC6260 {
  constructor() {
    this.palette = new Uint16Array(PALETTE_ENTRIES); // 9-bit colours
    this.ctrl = 0;          // $0400
    this.addr = 0;          // colour table address, 9 bits
    this.reset();
  }

  reset() {
    this.ctrl = 0;
    this.addr = 0;
    // Not cleared: the palette is RAM and survives a soft reset on hardware.
    return this;
  }

  powerOn() {
    this.palette.fill(0);
    return this.reset();
  }

  get dotDivider() { return DOT_DIVIDERS[this.ctrl & 3]; }
  get linesPerFrame() { return (this.ctrl & 4) ? 263 : 262; }
  get monochrome() { return (this.ctrl & 0x80) !== 0; }

  // $0400-$0407 within the hardware bank. Only five of the eight do anything.
  read(addr) {
    switch (addr & 7) {
      case 4: return this.palette[this.addr] & 0xff;
      case 5: {
        // Reading the high half is what advances the pointer, so a game can
        // stream the palette out with a two-instruction loop. The top seven
        // bits read back as 1 — they are not driven.
        const v = ((this.palette[this.addr] >> 8) & 1) | 0xfe;
        this.addr = (this.addr + 1) & 0x1ff;
        return v;
      }
      default: return 0xff;
    }
  }

  write(addr, v) {
    v &= 0xff;
    switch (addr & 7) {
      case 0: this.ctrl = v; return;
      case 2: this.addr = (this.addr & 0x100) | v; return;
      case 3: this.addr = (this.addr & 0x0ff) | ((v & 1) << 8); return;
      case 4: this.palette[this.addr] = (this.palette[this.addr] & 0x100) | v; return;
      case 5:
        this.palette[this.addr] = (this.palette[this.addr] & 0x0ff) | ((v & 1) << 8);
        this.addr = (this.addr + 1) & 0x1ff;
        return;
      default: return;
    }
  }

  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      palette: this.palette.slice(),
      ctrl: this.ctrl,
      addr: this.addr,
    };
  }

  setState(s) {
    this.palette.set(s.palette);
    this.ctrl = s.ctrl;
    this.addr = s.addr;
    return this;
  }
}

export function createHuC6260() { return new HuC6260(); }
