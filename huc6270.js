// huc6270 — the VDC, the PC Engine's video display controller.
//
// 64KB of its own VRAM (32K sixteen-bit words), one scrolling background, 64
// sprites, and a DMA engine. It has no palette and no idea what a colour is:
// it emits palette INDICES and the VCE (huc6260.js) turns them into light.
// That split is in the hardware and it is kept here, because it is what makes
// mid-frame palette changes work — the machine converts each line through the
// VCE as it is produced, so a raster interrupt that rewrites a palette entry
// affects the lines after it and not the whole frame.
//
// ## Why this chip is driven by scanlines and not by dots
//
// nesppu.js ticks one dot at a time because Famicom games change scroll
// registers *inside* a scanline and the PPU re-fetches a tile every eight dots.
// The HuC6270 does not work that way: it latches its scroll registers once per
// line and fetches the whole line's worth of tiles in a burst. What PC Engine
// games actually do is take a RASTER INTERRUPT and change the registers between
// lines. So the model here is a line: advance the vertical phase machine,
// compare the raster counter, then draw 256-512 pixels in one pass.
//
// The one timing subtlety that survives is *where in the line the interrupt
// fires relative to where the line is drawn*. On hardware the raster interrupt
// arrives at the start of the horizontal blank and the picture starts ~60 dots
// later, so a handler has a few dozen instructions to change the scroll before
// the line it belongs to is drawn. machinepce.js reproduces that gap by
// scheduling lineStart() and renderLine() at different master-clock offsets
// inside the same line; get it wrong in either direction and split screens
// land one line early or one line late.
//
// ## Sprites
//
// The 64 sprite descriptors the chip uses are NOT the ones in VRAM: they live
// in a private 256-word table that is refilled by DMA, normally once per
// vblank. That indirection is the thing to get right — a game that rewrites its
// sprite list in VRAM sees no change until the DMA runs, and a game that
// forgets to re-arm the DMA sees its sprites freeze while the rest of the
// picture keeps moving.

export const SCHEMA_VERSION = 1;

export const VRAM_WORDS = 0x8000;
export const SAT_WORDS = 256;

// The widest and tallest picture the VCE can ask for (512 dots at the 10.74MHz
// clock, and every line of a 263-line frame). Buffers are allocated to this and
// the live picture is a window inside it.
export const MAX_WIDTH = 512;
export const MAX_HEIGHT = 242;

// Status register bits, as read from $0000.
export const ST_COLLISION = 0x01;  // sprite 0 touched another sprite
export const ST_OVERFLOW = 0x02;   // more than 16 sprites on one line
export const ST_RASTER = 0x04;     // the RCR line was reached
export const ST_SATB_DMA = 0x08;   // the sprite list finished loading
export const ST_VRAM_DMA = 0x10;   // the VRAM-to-VRAM copy finished
export const ST_VBLANK = 0x20;
export const ST_BUSY = 0x40;

// Register numbers, as selected by a write to $0000.
export const R_MAWR = 0x00, R_MARR = 0x01, R_VXR = 0x02, R_CR = 0x05, R_RCR = 0x06;
export const R_BXR = 0x07, R_BYR = 0x08, R_MWR = 0x09, R_HSR = 0x0a, R_HDR = 0x0b;
export const R_VPR = 0x0c, R_VDW = 0x0d, R_VCR = 0x0e, R_DCR = 0x0f;
export const R_SOUR = 0x10, R_DESR = 0x11, R_LENR = 0x12, R_SATB = 0x13;

// The vertical phase machine. The chip walks these four in order forever; the
// register values decide how many lines each one lasts, and nothing forces the
// total to be a frame — a game that programs them inconsistently gets a rolling
// picture on hardware and gets one here too.
const PH_VSW = 0, PH_VDS = 1, PH_VDW = 2, PH_VCR = 3;

// Background map sizes, from MWR bits 4-6. Two of the eight codes are
// duplicates; that is the hardware, not a typo.
const BAT_W = [32, 64, 128, 128, 32, 64, 128, 128];

// VRAM address increment per data-port access, from CR bits 11-12. 32/64/128
// are for writing a tile column at a time.
const INCREMENT = [1, 32, 64, 128];

export class HuC6270 {
  constructor() {
    this.vram = new Uint16Array(VRAM_WORDS);
    this.sat = new Uint16Array(SAT_WORDS);
    this.reg = new Uint16Array(0x20);
    // Scratch, not state: rebuilt for every line.
    this.lineBuf = new Uint16Array(MAX_WIDTH);
    this._sprIdx = new Int32Array(MAX_WIDTH);
    this._sprPri = new Uint8Array(MAX_WIDTH);
    this._spr0 = new Uint8Array(MAX_WIDTH);
    this.powerOn();
  }

  powerOn() {
    this.vram.fill(0);
    this.sat.fill(0);
    this.reg.fill(0);
    return this.reset();
  }

  reset() {
    this.regSel = 0;
    this.status = 0;
    this.irq = false;
    this.readBuf = 0;
    this.writeLatch = 0;
    this.phase = PH_VSW;
    this.phaseLeft = 1;
    this.rcrCount = 0;
    this.bgY = 0;
    this.bgX = 0;
    this.displayY = 0;
    this.satbPending = false;
    this.burst = false;
    this.lastWidth = 256;
    this.lastHeight = 224;
    // How many lines the television expects, handed down from the VCE. See the
    // VSW case in _nextPhase().
    this.framePeriod = 263;
    return this;
  }

  // ---- CPU-facing ports ($0000-$0003 of the hardware bank) ------------------
  read(addr) {
    switch (addr & 3) {
      case 0: {
        const v = this.status;
        // Reading the status is the acknowledge. All six condition bits and the
        // interrupt line go at once — there is no per-bit clear — which is why
        // a handler that reads the status must deal with everything it finds in
        // that one byte or lose it.
        this.status = 0;
        this.irq = false;
        return v;
      }
      case 2: return this.readBuf & 0xff;
      case 3: {
        const v = (this.readBuf >> 8) & 0xff;
        // The high half is the one that advances: the chip prefetched this word
        // when MARR was set and prefetches the next one now.
        this.reg[R_MARR] = (this.reg[R_MARR] + this.increment) & 0xffff;
        this.readBuf = this.vram[this.reg[R_MARR] & 0x7fff];
        return v;
      }
      default: return 0;
    }
  }

  write(addr, v) {
    v &= 0xff;
    switch (addr & 3) {
      case 0: this.regSel = v & 0x1f; return;
      case 2: this._writeReg(this.regSel, v, false); return;
      case 3: this._writeReg(this.regSel, v, true); return;
      default: return;
    }
  }

  get increment() { return INCREMENT[(this.reg[R_CR] >> 11) & 3]; }

  _writeReg(sel, v, high) {
    const r = sel & 0x1f;
    if (r === R_VXR) {
      // The data port. The low byte is only latched; the write to VRAM happens
      // when the high byte arrives, which is why every VRAM fill in every PC
      // Engine game is a pair of stores and why a game that writes only $0002
      // in a loop writes nothing at all.
      if (!high) { this.writeLatch = v; return; }
      const a = this.reg[R_MAWR] & 0x7fff;
      this.vram[a] = this.writeLatch | (v << 8);
      this.reg[R_MAWR] = (this.reg[R_MAWR] + this.increment) & 0xffff;
      return;
    }
    if (r > R_SATB) return;
    this.reg[r] = high ? ((this.reg[r] & 0x00ff) | (v << 8)) : ((this.reg[r] & 0xff00) | v);
    if (r === R_MARR && high) {
      // Setting the read pointer prefetches, so the first read of $0002 already
      // has data. Without the prefetch every VRAM read in every game is one
      // word late.
      this.readBuf = this.vram[this.reg[R_MARR] & 0x7fff];
      return;
    }
    if (r === R_BYR) {
      // Writing BYR reloads the internal line counter immediately rather than
      // at the next line boundary. That is what makes a scroll change inside a
      // raster interrupt take effect on the very next line instead of the one
      // after, and it is the difference between a clean split and a one-line
      // tear at the seam of every status bar in the library.
      this.bgY = this.reg[R_BYR] & 0x1ff;
      return;
    }
    if (r === R_LENR && high) { this._vramDma(); return; }
    if (r === R_SATB && high) { this.satbPending = true; return; }
    if (r === R_CR) {
      // Turning both planes off puts the chip in "burst mode": it stops
      // fetching entirely and the screen becomes the backdrop colour. Games use
      // it to free the VRAM bus for a big DMA.
      this.burst = (this.reg[R_CR] & 0xc0) === 0;
    }
  }

  // ---- DMA ------------------------------------------------------------------
  // Both engines run to completion here rather than a word at a time. The chip
  // really does take a few cycles per word and holds BUSY up while it works,
  // but everything that observes the difference (the status bit, the completion
  // interrupt) is observed AFTER the fact by software that is waiting for it —
  // so finishing early is invisible, and modelling the trickle would cost a
  // per-word callback on the hottest path in the machine.
  _vramDma() {
    const dcr = this.reg[R_DCR];
    const sInc = (dcr & 0x04) ? -1 : 1;
    const dInc = (dcr & 0x08) ? -1 : 1;
    let src = this.reg[R_SOUR], dst = this.reg[R_DESR];
    let len = this.reg[R_LENR];
    // LENR is a count-down that transfers len+1 words; 0 means one word, not
    // none.
    for (let i = 0; i <= len; i++) {
      this.vram[dst & 0x7fff] = this.vram[src & 0x7fff];
      src = (src + sInc) & 0xffff;
      dst = (dst + dInc) & 0xffff;
    }
    this.reg[R_SOUR] = src;
    this.reg[R_DESR] = dst;
    this.reg[R_LENR] = 0xffff;
    this._raise(ST_VRAM_DMA, (dcr & 0x02) !== 0);
  }

  _satbDma() {
    const base = this.reg[R_SATB] & 0x7fff;
    for (let i = 0; i < SAT_WORDS; i++) this.sat[i] = this.vram[(base + i) & 0x7fff];
    this.satbPending = false;
    this._raise(ST_SATB_DMA, (this.reg[R_DCR] & 0x01) !== 0);
  }

  // Raise a condition. `enabled` is the matching bit of CR (or DCR for the two
  // DMA flags).
  //
  // The four INTERRUPT conditions — collision, overflow, raster, vblank — do
  // not set their status bit at all unless CR has armed them. That is not what
  // "a status register" sounds like it should do, and it was measured, not
  // assumed: a handler on this machine has one status byte to work out which of
  // four things woke it, and it tests them in priority order. Soldier Blade's
  // handler tests the raster bit first and falls through to the vblank path
  // only if it is clear — so a raster bit that latches while raster interrupts
  // are switched OFF sends every vblank into the raster branch, whose vector is
  // an RTS. The game then waits forever for a frame counter nothing decrements.
  // Twenty-odd titles in the library do the same thing.
  //
  // The two DMA flags are NOT gated: polling them with the interrupt disabled
  // is the documented way to wait for a transfer, and games do exactly that.
  _raise(bit, enabled) {
    if (!enabled && (bit & (ST_COLLISION | ST_OVERFLOW | ST_RASTER | ST_VBLANK))) return;
    this.status |= bit;
    if (enabled) this.irq = true;
  }

  // ---- geometry -------------------------------------------------------------
  // Width comes from the VDC (how many 8-dot groups it displays) and the dot
  // clock comes from the VCE, so neither chip knows the picture size on its
  // own. The machine asks for both.
  get displayWidth() {
    const w = ((this.reg[R_HDR] & 0x7f) + 1) * 8;
    return Math.max(8, Math.min(MAX_WIDTH, w));
  }

  get displayHeight() {
    const h = (this.reg[R_VDW] & 0x1ff) + 1;
    return Math.max(1, Math.min(MAX_HEIGHT, h));
  }

  // ---- the vertical phase machine ------------------------------------------
  // Called once per scanline, at the top of the line. Returns true if this line
  // is a visible one (i.e. renderLine() should be called for it later in the
  // same line).
  lineStart() {
    if (--this.phaseLeft <= 0) this._nextPhase();

    // The raster compare runs in every phase, not only the visible ones: games
    // put RCR past the bottom of the screen to get a "start of vertical blank
    // plus N lines" interrupt for music timing.
    const target = (this.reg[R_RCR] & 0x3ff) - 64;
    if (this.rcrCount === target) this._raise(ST_RASTER, (this.reg[R_CR] & 0x04) !== 0);
    this.rcrCount++;

    if (this.phase !== PH_VDW) return false;
    this.bgY = (this.bgY + 1) & 0x1ff;
    return this.displayY < MAX_HEIGHT;
  }

  _nextPhase() {
    const vpr = this.reg[R_VPR];
    switch (this.phase) {
      case PH_VSW:
        this.phase = PH_VDS;
        this.phaseLeft = ((vpr >> 8) & 0xff) + 2;
        break;
      case PH_VDS:
        this.phase = PH_VDW;
        this.phaseLeft = (this.reg[R_VDW] & 0x1ff) + 1;
        // The display is about to start: reload the scroll counter and reset
        // the raster counter so that RCR = 64 means the first visible line.
        // bgY is pre-decremented because lineStart() increments before drawing.
        this.bgY = (this.reg[R_BYR] - 1) & 0x1ff;
        this.rcrCount = 0;
        this.displayY = 0;
        this.lastWidth = this.displayWidth;
        this.lastHeight = this.displayHeight;
        break;
      case PH_VDW:
        this.phase = PH_VCR;
        this.phaseLeft = (this.reg[R_VCR] & 0xff) + 1;
        // Vertical blank: the interrupt games hang their whole frame off, and
        // the moment the sprite list is reloaded. The repeat bit (DCR bit 4) is
        // what makes it automatic; without it the game has to re-arm by writing
        // SATB every frame, and plenty do exactly that.
        this._raise(ST_VBLANK, (this.reg[R_CR] & 0x08) !== 0);
        if (this.satbPending || (this.reg[R_DCR] & 0x10)) this._satbDma();
        break;
      default:
        // The sync phase absorbs the slack so that the VDC's vertical cycle is
        // exactly as long as the television's frame. Hardware does not do this
        // — programme the four registers inconsistently on a real console and
        // the picture rolls — but every real setting in the library is one line
        // away from adding up (Alien Crush's is VSW 2, VDS 15, VDW 239, VCR 4,
        // which is 264 or 263 depending on which register's "+1" you believe),
        // and the documents do not agree about which one it is. Forcing the
        // total means the ambiguity costs at most a one-line offset in where
        // the picture sits rather than a slow roll on every title.
        this.phase = PH_VSW;
        this.phaseLeft = this.framePeriod
          - (((vpr >> 8) & 0xff) + 2)
          - ((this.reg[R_VDW] & 0x1ff) + 1)
          - (this.reg[R_VCR] & 0xff);
        if (this.phaseLeft < 1) this.phaseLeft = (vpr & 0x1f) + 1;
        break;
    }
    if (this.phaseLeft <= 0) this.phaseLeft = 1;
  }

  get inDisplay() { return this.phase === PH_VDW; }

  // ---- drawing --------------------------------------------------------------
  // Produce one line of palette indices (0-511). Index 0 is the backdrop, which
  // is also what a transparent pixel resolves to, so the caller never has to
  // know about transparency.
  renderLine(width) {
    const out = this.lineBuf;
    const w = Math.min(width, MAX_WIDTH);
    out.fill(0, 0, w);
    if (this.burst) return out;
    if (this.reg[R_CR] & 0x80) this._renderBg(out, w);
    if (this.reg[R_CR] & 0x40) this._renderSprites(out, w);
    return out;
  }

  _renderBg(out, w) {
    const vram = this.vram;
    const sc = (this.reg[R_MWR] >> 4) & 7;
    const batW = BAT_W[sc], batH = sc < 4 ? 32 : 64;
    const maskX = batW * 8 - 1, maskY = batH * 8 - 1;
    const yOff = this.bgY & maskY;
    const rowBase = (yOff >> 3) * batW;
    const fy = yOff & 7;
    let x = 0;
    let xOff = this.reg[R_BXR] & maskX;
    while (x < w) {
      const col = xOff >> 3;
      const bat = vram[(rowBase + col) & 0x7fff];
      const addr = ((bat & 0x0fff) << 4 | fy) & 0x7fff;
      const p01 = vram[addr], p23 = vram[(addr + 8) & 0x7fff];
      const pal = (bat >> 12) << 4;
      // Draw the part of this tile that is on screen. Starting mid-tile only
      // happens for the first one (fine scroll), so the inner loop is written
      // to cope rather than the outer loop to special-case it.
      const start = xOff & 7;
      const n = Math.min(8 - start, w - x);
      for (let i = 0; i < n; i++) {
        const bit = 7 - (start + i);
        const c = ((p01 >> bit) & 1) | (((p01 >> (bit + 8)) & 1) << 1)
          | (((p23 >> bit) & 1) << 2) | (((p23 >> (bit + 8)) & 1) << 3);
        // Colour 0 of every palette is transparent and shows the backdrop, so
        // it is written as index 0 rather than as pal|0.
        out[x + i] = c ? (pal | c) : 0;
      }
      x += n;
      xOff = (xOff + n) & maskX;
    }
  }

  _renderSprites(out, w) {
    const line = this.displayY;
    const sat = this.sat, vram = this.vram;
    const idx = this._sprIdx, pri = this._sprPri, zero = this._spr0;
    idx.fill(-1, 0, w);
    zero.fill(0, 0, w);
    let onLine = 0;
    for (let s = 0; s < 64; s++) {
      const o = s * 4;
      const attr = sat[o + 3];
      const cgy = (attr >> 12) & 3;
      const h = cgy === 0 ? 16 : cgy === 1 ? 32 : 64;
      const y = (sat[o] & 0x3ff) - 64;
      if (line < y || line >= y + h) continue;
      if (++onLine > 16) {
        // Sixteen is the hardware's per-line budget. Games rely on the flag as
        // a diagnostic and a few use it as a timer; the sprites past the limit
        // simply do not appear, which is the visible symptom players know as
        // flicker.
        this._raise(ST_OVERFLOW, (this.reg[R_CR] & 0x02) !== 0);
        break;
      }
      const wide = (attr & 0x100) !== 0;
      const sw = wide ? 32 : 16;
      const x0 = (sat[o + 1] & 0x3ff) - 32;
      if (x0 >= w || x0 + sw <= 0) continue;
      let sy = line - y;
      if (attr & 0x8000) sy = h - 1 - sy;              // vertical flip
      const hflip = (attr & 0x0800) !== 0;
      const palBase = 256 | ((attr & 0x0f) << 4);
      const front = (attr & 0x0080) !== 0;
      // The pattern number's low bits are ignored in proportion to the sprite's
      // size — a 32x64 sprite is eight 16x16 cells and occupies eight
      // consecutive pattern slots, so the game may only place it on a multiple
      // of eight.
      let pattern = (sat[o + 2] >> 1) & 0x3ff;
      if (wide) pattern &= ~1;
      if (cgy === 1) pattern &= ~2; else if (cgy >= 2) pattern &= ~6;
      const cell = pattern + ((sy >> 4) << 1);
      const row = sy & 15;
      for (let sx = 0; sx < sw; sx++) {
        const px = x0 + sx;
        if (px < 0 || px >= w) continue;
        const src = hflip ? (sw - 1 - sx) : sx;
        const base = ((cell + (src >> 4)) * 64) & 0x7fff;
        const bit = 15 - (src & 15);
        const c = ((vram[(base + row) & 0x7fff] >> bit) & 1)
          | (((vram[(base + row + 16) & 0x7fff] >> bit) & 1) << 1)
          | (((vram[(base + row + 32) & 0x7fff] >> bit) & 1) << 2)
          | (((vram[(base + row + 48) & 0x7fff] >> bit) & 1) << 3);
        if (!c) continue;
        if (idx[px] < 0) { idx[px] = palBase | c; pri[px] = front ? 1 : 0; }
        // Sprite 0 collision. The chip reports it whenever sprite 0's opaque
        // pixels touch any other sprite's, whatever the priorities are, and
        // games use it as a free "did the player hit that" test — so it must be
        // detected even where the pixel is not the one that ends up drawn.
        if (s === 0) zero[px] = 1;
        else if (zero[px]) this._raise(ST_COLLISION, (this.reg[R_CR] & 0x01) !== 0);
      }
    }
    for (let x = 0; x < w; x++) {
      const v = idx[x];
      if (v < 0) continue;
      if (pri[x] || out[x] === 0) out[x] = v;
    }
  }

  // Called by the machine after the line has been handed to the framebuffer.
  lineDone() { this.displayY++; }

  // ---- state ---------------------------------------------------------------
  // VRAM is 64KB and dominates a PC Engine snapshot. It is genuinely mutable —
  // games stream tiles into it all through a level — so unlike a cartridge it
  // cannot be held by reference. The framebuffer and the per-line scratch
  // buffers are output and are not here.
  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      vram: this.vram.slice(),
      sat: this.sat.slice(),
      reg: this.reg.slice(),
      regSel: this.regSel,
      status: this.status,
      irq: this.irq,
      readBuf: this.readBuf,
      writeLatch: this.writeLatch,
      phase: this.phase,
      phaseLeft: this.phaseLeft,
      rcrCount: this.rcrCount,
      bgY: this.bgY,
      displayY: this.displayY,
      satbPending: this.satbPending,
      burst: this.burst,
      lastWidth: this.lastWidth,
      lastHeight: this.lastHeight,
    };
  }

  setState(s) {
    this.vram.set(s.vram);
    this.sat.set(s.sat);
    this.reg.set(s.reg);
    this.regSel = s.regSel;
    this.status = s.status;
    this.irq = !!s.irq;
    this.readBuf = s.readBuf;
    this.writeLatch = s.writeLatch;
    this.phase = s.phase;
    this.phaseLeft = s.phaseLeft;
    this.rcrCount = s.rcrCount;
    this.bgY = s.bgY;
    this.displayY = s.displayY;
    this.satbPending = !!s.satbPending;
    this.burst = !!s.burst;
    this.lastWidth = s.lastWidth;
    this.lastHeight = s.lastHeight;
    return this;
  }
}

export function createHuC6270() { return new HuC6270(); }
