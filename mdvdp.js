// mdvdp — the Mega Drive VDP (Yamaha YM7101 / Sega 315-5313), pure and
// machine-agnostic. It owns VRAM, CRAM and VSRAM and draws one scanline at a
// time; it knows nothing about a 68000, a Z80 or a cartridge. machinemd.js
// drives it: beginLine() before a line runs, renderLine() when that line's
// horizontal blank starts, and irqLevel() to ask what the interrupt pins say.
//
// ## Why a per-line renderer and not a per-frame one
//
// Every interesting Mega Drive effect is a mid-frame register write. Sonic's
// water line is a CRAM rewrite during an H interrupt; a status bar is the
// window plane plus a scroll change; parallax is one horizontal-scroll entry
// per scanline. A renderer that reads the registers once per frame draws none
// of them. So the picture is built line by line at the moment the line ends,
// which is when the register state for that line is final — a game that writes
// during H-blank of line N-1 is writing for line N, and that lands correctly.
//
// The line is converted to RGB immediately rather than to palette indices,
// because CRAM itself is one of the things that changes mid-frame. Storing
// indices and colouring at the end of the frame would flatten exactly the
// effects this renderer exists to draw.
//
// ## Priority
//
// Six layers plus the backdrop, resolved per pixel in one fixed order:
//
//   sprite(pri=1) > A(pri=1) > B(pri=1) > sprite(pri=0) > A(pri=0) > B(pri=0)
//   > backdrop (register 7)
//
// The window plane is not a seventh layer: where it is active it *replaces*
// plane A for that pixel, with no scroll of its own.
//
// ## Shadow / highlight
//
// With register 12 bit 3 set the VDP has three intensity levels per colour.
// A pixel is normal if a high-priority plane pixel covers it and shadowed
// otherwise; sprite palette 3 colour 15 forces shadow, colour 14 lifts a
// shadowed pixel back to normal or a normal one to highlight, and both of
// those sprite pixels are themselves transparent. High-priority sprites are
// always normal. The three DAC ramps below are the measured ones.
//
// Contract: no Math.random, plain-data getState()/setState(), no ROM held.

export const SCHEMA_VERSION = 1;

// The VDP's 3-bit-per-gun DAC is not linear, and the two shading modes are not
// a multiply either — they are separate ramps in the chip. Measured levels.
const LUT_NORMAL = Uint8Array.from([0, 52, 87, 116, 144, 172, 206, 255]);
const LUT_SHADOW = Uint8Array.from([0, 29, 52, 70, 87, 101, 116, 130]);
const LUT_HILITE = Uint8Array.from([130, 144, 158, 172, 187, 206, 228, 255]);

// Plane sizes from register 16. Code 2 is documented as invalid; the hardware
// behaves as 32 cells, which is what a game that sets it accidentally sees.
const PLANE_CELLS = [32, 64, 32, 128];

// Access codes carried in CD5..CD0 of a control-port command. The low bits
// select the memory, bit 5 asks for DMA.
const CD_VRAM_W = 0x01, CD_CRAM_W = 0x03, CD_VSRAM_W = 0x05;
const CD_VRAM_R = 0x00, CD_CRAM_R = 0x08, CD_VSRAM_R = 0x04;

// Status register bits, as the 68000 sees them reading the control port.
const ST_PAL = 0x001, ST_DMA = 0x002, ST_HBLANK = 0x004, ST_VBLANK = 0x008;
const ST_ODD = 0x010, ST_COLLISION = 0x020, ST_OVERFLOW = 0x040, ST_VINT = 0x080;
const ST_FIFO_FULL = 0x100, ST_FIFO_EMPTY = 0x200;

export class MdVdp {
  // `read68k(addr)` is how DMA reaches the 68000 bus; the VDP is the bus master
  // for those cycles, so the callback is a plain word read with no side effects
  // the VDP needs to know about. Whether the 68000 is currently held off that
  // bus is readable as `dmaHoldsBus` — the machine asks, the VDP does not push.
  constructor({ pal = false, read68k = null } = {}) {
    this.schemaVersion = SCHEMA_VERSION;
    this.pal = !!pal;
    this._read68k = read68k || (() => 0xffff);

    this.vram = new Uint8Array(0x10000);
    this.cram = new Uint16Array(64);   // raw 9-bit ---- BBB- GGG- RRR-
    this.vsram = new Uint16Array(40);  // 10-bit signed-ish vertical scroll
    this.reg = new Uint8Array(32);

    // Control port state. A command is two 16-bit writes; the first one is
    // held here until the second arrives, and ANY data-port access in between
    // completes the pending half as an address-only command (real hardware
    // behaviour that a few games rely on).
    this._ctrlPending = false;
    this._ctrlFirst = 0;
    this.code = 0;
    this.addr = 0;
    this._readBuffer = 0;

    // DMA fill waits for one data-port write to supply the fill byte.
    this._fillPending = false;
    // The running transfer. See the DMA engine section below.
    this.dma = { active: false, mode: 0, kind: 0, src: 0, len: 0, fill: 0 };
    this._dmaAcc = 0;

    this.line = 0;
    this.lineMclk = 0;  // how far into the current scanline the machine has run
    this.hblank = false;
    this.vblank = true;
    this.hintCounter = 0;
    this.hintPending = false;
    this.vintPending = false;
    this.statusVint = false;
    this.spriteOverflow = false;
    this.spriteCollision = false;
    this.dmaBusy = false;
    this.oddFrame = false;
    this._hvLatched = -1; // register 0 bit 1 freezes the HV counter here

    // The picture. Always the maximum 320x240 so a mode change mid-run never
    // reallocates; render() reports the active size and the host crops.
    this.frameRgb = new Uint8Array(320 * 240 * 3);

    // Per-line scratch. `col` holds (palette<<4)|pixel, transparent when the
    // low nibble is 0 — that is the hardware's rule and it is per-pixel, not
    // per-palette, so colour 0 of palette 2 is transparent too.
    this._colA = new Uint8Array(320); this._priA = new Uint8Array(320);
    this._colB = new Uint8Array(320); this._priB = new Uint8Array(320);
    this._colS = new Uint8Array(320); this._priS = new Uint8Array(320);
    this._opS = new Uint8Array(320);  // 1 = shadow operator, 2 = highlight operator

    this.reset();
  }

  reset() {
    this.reg.fill(0);
    // Power-on defaults that matter before a game writes its own: mode 5 on
    // (register 1 bit 2), everything else off. A VDP left in Master System
    // mode 4 would draw nothing recognisable.
    this.reg[1] = 0x04;
    this.reg[10] = 0xff;
    this.reg[15] = 2;
    this._ctrlPending = false;
    this.code = 0; this.addr = 0;
    this._fillPending = false;
    this.dma = { active: false, mode: 0, kind: 0, src: 0, len: 0, fill: 0 };
    this._dmaAcc = 0;
    this._readBuffer = 0;
    this.line = 0;
    this.lineMclk = 0;
    this.hblank = false; this.vblank = true;
    this.hintCounter = 0;
    this.hintPending = false; this.vintPending = false; this.statusVint = false;
    this.spriteOverflow = false; this.spriteCollision = false;
    this.dmaBusy = false; this.oddFrame = false;
    this._hvLatched = -1;
    return this;
  }

  powerOn() {
    this.vram.fill(0); this.cram.fill(0); this.vsram.fill(0);
    this.frameRgb.fill(0);
    return this.reset();
  }

  // ---- geometry -------------------------------------------------------------
  // H40 needs BOTH bits of register 12 (RS0 at bit 7, RS1 at bit 0); a game
  // that sets only one gets H32, which is what the hardware does.
  get h40() { return (this.reg[12] & 0x81) === 0x81; }
  get screenWidth() { return this.h40 ? 320 : 256; }
  // V30 exists only on a PAL machine — a 60 Hz VDP with register 1 bit 3 set
  // keeps scanning 224 lines and the extra rows simply never appear.
  get v30() { return this.pal && (this.reg[1] & 0x08) !== 0; }
  get screenHeight() { return this.v30 ? 240 : 224; }
  get displayEnabled() { return (this.reg[1] & 0x40) !== 0; }
  get linesPerFrame() { return this.pal ? 313 : 262; }

  // ---- interrupts -----------------------------------------------------------
  // Called once per scanline, before any CPU runs on it. The H counter counts
  // down through the active display and is held reloaded through the blanking
  // interval, so a game that asks for "every 8th line" gets its interrupt on
  // the same lines every frame.
  beginLine(line) {
    this.line = line;
    this.lineMclk = 0;
    if (line === 0) {
      this.vblank = false;
      this.statusVint = false;
      this.spriteOverflow = false;
      this.spriteCollision = false;
      this.hintCounter = this.reg[10];
    }
    const active = this.screenHeight;
    if (line <= active) {
      if (this.hintCounter === 0) { this.hintCounter = this.reg[10]; this.hintPending = true; }
      else this.hintCounter--;
    } else {
      this.hintCounter = this.reg[10];
    }
    if (line === active) {
      this.vblank = true;
      this.statusVint = true;
      this.vintPending = true;
    }
    return this;
  }

  // The two interrupt levels the VDP drives, resolved to the one the 68000
  // sees. Level 2 (the external/TH interrupt) is a controller feature no
  // retail game uses and is not driven here.
  irqLevel() {
    if (this.vintPending && (this.reg[1] & 0x20)) return 6;
    if (this.hintPending && (this.reg[0] & 0x10)) return 4;
    return 0;
  }

  // The 68000 acknowledging an autovectored interrupt is what clears it: the
  // VDP holds the line until the CPU takes the vector, exactly as a level-
  // triggered source must.
  irqAck(level) {
    if (level === 6) this.vintPending = false;
    else if (level === 4) this.hintPending = false;
    return -1; // autovector
  }

  // ---- register / control port ----------------------------------------------
  writeReg(n, v) {
    n &= 0x1f; v &= 0xff;
    // Register 0 bit 1 freezes the HV counter. On real hardware the freeze is
    // armed here and triggered by a controller port's TH line (that is how a
    // light gun reports where it was pointed); with no light gun the useful
    // half is the freeze itself, which software also uses to read a stable
    // counter value.
    if (n === 0) {
      const was = (this.reg[0] & 0x02) !== 0, now = (v & 0x02) !== 0;
      if (now && !was) this._hvLatched = this.readHV();
      else if (!now) this._hvLatched = -1;
    }
    this.reg[n] = v;
    // Writing register 1 with the display already blanked is how a game turns
    // the picture off for a big VRAM upload; nothing to do here, the renderer
    // checks displayEnabled per line.
    return this;
  }

  // The control port takes 16-bit writes. $8xxx-$9xxx is a register write;
  // anything else is half of a 32-bit address/code command.
  writeControl(word) {
    word &= 0xffff;
    if (!this._ctrlPending && (word & 0xc000) === 0x8000) {
      const n = (word >> 8) & 0x1f;
      this.writeReg(n, word & 0xff);
      // A register write also clears the low two bits of the pending code, the
      // way the real command latch does — games that set up a read and then
      // touch a register get a VRAM read, not their intended CRAM read.
      this.code &= 0x3c;
      return this;
    }
    if (!this._ctrlPending) {
      this._ctrlFirst = word;
      this._ctrlPending = true;
      // The address and the low code bits are usable straight away: a game may
      // write the second half much later, and reads in between use these.
      this.addr = (this.addr & 0xc000) | (word & 0x3fff);
      this.code = (this.code & 0x3c) | ((word >> 14) & 3);
      return this;
    }
    this._ctrlPending = false;
    this.addr = ((this._ctrlFirst & 0x3fff) | ((word & 3) << 14)) & 0xffff;
    this.code = (((this._ctrlFirst >> 14) & 3) | ((word >> 2) & 0x3c)) & 0x3f;
    if (this.code & 0x20) this._startDma();
    return this;
  }

  // Reading the control port returns the status word. Two of its bits are
  // consumed by the read: the V-interrupt flag and the pending command half.
  readControl() {
    this._ctrlPending = false;
    let v = ST_FIFO_EMPTY; // no write FIFO is modelled; see the design doc
    if (this.pal) v |= ST_PAL;
    if (this.dmaBusy) { v |= ST_DMA; v &= ~ST_FIFO_EMPTY; v |= ST_FIFO_FULL; }
    if (this.hblank) v |= ST_HBLANK;
    // The blanking bit is also forced while the display is off, which is how a
    // game's "wait for vblank" loop still terminates with the picture disabled.
    if (this.vblank || !this.displayEnabled) v |= ST_VBLANK;
    if (this.oddFrame) v |= ST_ODD;
    if (this.spriteCollision) v |= ST_COLLISION;
    if (this.spriteOverflow) v |= ST_OVERFLOW;
    if (this.statusVint) v |= ST_VINT;
    this.statusVint = false;
    // The top six bits are the 68000's own prefetch showing through on an
    // unterminated bus. $3400 is what a real machine leaves there and a few
    // games compare the whole word.
    return v | 0x3400;
  }

  // $C00008: V counter in the high byte, H counter in the low.
  //
  // Neither counter is contiguous. Both skip a block of values at the point
  // where the beam retraces, and the size and position of the gap is what
  // software uses to find out where in the frame it is — a program that polls
  // this to time a mid-line effect (direct colour DMA is the famous one) will
  // spin forever against a counter that only reports two positions. So the
  // machine tells this object how far into the line it has run (`lineMclk`)
  // and the count is derived from it.
  //
  //   H40   $00-$B6 then $E4-$FF   211 counts over 3420 master clocks
  //   H32   $00-$93 then $E9-$FF   171 counts
  //   V NTSC $00-$EA then $E5-$FF  262 lines
  //   V PAL  $00-$FF, $00-$02, then $CA-$FF   313 lines
  readHV() {
    if (this._hvLatched >= 0) return this._hvLatched;
    return ((this._vcounter() << 8) | this._hcounter()) & 0xffff;
  }

  _hcounter() {
    const h40 = this.h40;
    const total = h40 ? 211 : 171;
    const visible = h40 ? 0xb7 : 0x94;      // count of values before the gap
    const gapStart = h40 ? 0xe4 : 0xe9;
    let n = Math.floor((this.lineMclk * total) / 3420);
    if (n >= total) n = total - 1;
    return n < visible ? n : (gapStart + (n - visible)) & 0xff;
  }

  _vcounter() {
    const line = this.line;
    if (!this.pal) return (line <= 0xea ? line : (line - 0xeb + 0xe5)) & 0xff;
    if (line <= 0x102) return line & 0xff;
    return (line - 0x103 + 0x1ca) & 0xff;
  }

  // ---- data port -------------------------------------------------------------
  writeData(word) {
    word &= 0xffff;
    this._ctrlPending = false;
    if (this._fillPending) { this._fillPending = false; this._beginFill(word); return this; }
    switch (this.code & 0x0f) {
      case CD_VRAM_W: this._writeVram(word); break;
      case CD_CRAM_W: this.cram[(this.addr >> 1) & 0x3f] = word & 0x0eee; break;
      case CD_VSRAM_W: { const i = (this.addr >> 1) & 0x3f; if (i < 40) this.vsram[i] = word & 0x7ff; break; }
      default: break; // a write with a read code goes nowhere
    }
    this.addr = (this.addr + this.reg[15]) & 0xffff;
    return this;
  }

  // A word written to VRAM lands high byte first — unless the address is odd,
  // in which case the two bytes swap. That is a real quirk (the VDP has no A0
  // on its VRAM bus) and tile data uploaded to an odd address comes out
  // scrambled on hardware exactly the same way.
  _writeVram(word) {
    const a = this.addr & 0xfffe;
    if (this.addr & 1) { this.vram[a] = word & 0xff; this.vram[a + 1] = (word >> 8) & 0xff; }
    else { this.vram[a] = (word >> 8) & 0xff; this.vram[a + 1] = word & 0xff; }
  }

  // The data-port write that completes a fill DMA does two things: it lands as
  // an ordinary word write at the start address, and its high byte becomes the
  // fill byte for the run that follows.
  _beginFill(word) {
    this._writeVram(word);
    this.dma = { active: true, mode: 2, kind: this.code & 0x0f, src: 0, len: this._dmaLength(), fill: (word >> 8) & 0xff };
    this.dmaBusy = true;
    this._dmaAcc = 0;
  }

  readData() {
    this._ctrlPending = false;
    let v = this._readBuffer;
    switch (this.code & 0x0f) {
      case CD_VRAM_R: v = (this.vram[this.addr & 0xfffe] << 8) | this.vram[(this.addr & 0xfffe) + 1]; break;
      case CD_CRAM_R: v = this.cram[(this.addr >> 1) & 0x3f]; break;
      case CD_VSRAM_R: { const i = (this.addr >> 1) & 0x3f; v = i < 40 ? this.vsram[i] : 0; break; }
      default: break;
    }
    this._readBuffer = v;
    this.addr = (this.addr + this.reg[15]) & 0xffff;
    return v & 0xffff;
  }

  // ---- the DMA engine ---------------------------------------------------------
  // A Mega Drive DMA is not instantaneous and cannot be modelled as if it were.
  // The VDP steals bus slots at a rate the display mode decides — roughly one
  // word every 20 master clocks while the screen is blanked, and about a tenth
  // of that during active display, where the renderer is using the slots. A
  // full-screen tile upload therefore takes most of a vertical blank, and a
  // long DMA started with the display on runs for many scanlines.
  //
  // That timing is not a detail. Direct colour DMA — the trick that gets far
  // more than 61 colours on screen — is one enormous DMA into CRAM that runs
  // for a whole frame while the beam scans, so each scanline sees a different
  // palette. Perform the transfer in one go at the trigger and the effect
  // disappears: every colour arrives before the first line is drawn. So the
  // transfer is a state machine the machine steps in master clocks, and the
  // picture is drawn between the steps.
  _dmaRate() { return (this.vblank || !this.displayEnabled) ? 20 : 205; }

  // True while the 68000 is off the bus. A VRAM copy runs entirely inside the
  // VDP, so the CPU keeps executing through it (it just must not touch the
  // VDP); the other two are fed by the 68000 bus and hold it.
  get dmaHoldsBus() { return this.dma.active && this.dma.mode !== 3; }

  _startDma() {
    if (!(this.reg[1] & 0x10)) return; // register 1 bit 4 is the DMA enable
    const mode = (this.reg[23] >> 6) & 3;
    if (mode === 2) { this._fillPending = true; return; } // waits for the fill word
    this.dma = {
      active: true,
      mode: mode === 3 ? 3 : 0,
      kind: this.code & 0x0f,
      src: mode === 3 ? (((this.reg[22] << 8) | this.reg[21]) & 0xffff) : this._dmaSource(),
      len: this._dmaLength(),
      fill: 0,
    };
    this.dmaBusy = true;
    this._dmaAcc = 0;
  }

  _dmaLength() {
    const len = ((this.reg[20] << 8) | this.reg[19]) & 0xffff;
    return len === 0 ? 0x10000 : len; // a length of 0 means the full 64 K
  }

  _dmaSource() {
    return (((this.reg[23] & 0x7f) << 17) | (this.reg[22] << 9) | (this.reg[21] << 1)) >>> 0;
  }

  // Advance a running DMA by `mclk` master clocks' worth of bus slots.
  runDma(mclk) {
    const d = this.dma;
    if (!d.active) return 0;
    const rate = this._dmaRate();
    this._dmaAcc += mclk;
    let units = (this._dmaAcc / rate) | 0;
    if (units <= 0) return 0;
    this._dmaAcc -= units * rate;
    let moved = 0;
    while (units-- > 0 && d.len > 0) { this._dmaStep(d); d.len--; moved++; }
    if (d.len <= 0) this._finishDma(d);
    return moved;
  }

  _dmaStep(d) {
    const inc = this.reg[15];
    if (d.mode === 3) {
      // VRAM copy is byte-wide and stays inside VRAM.
      this.vram[this.addr & 0xffff] = this.vram[d.src & 0xffff];
      d.src = (d.src + 1) & 0xffff;
      this.addr = (this.addr + inc) & 0xffff;
      return;
    }
    if (d.mode === 2) {
      // The fill byte goes to the OTHER byte of each word; the even halves keep
      // whatever they held. (The whole word at the start address was written by
      // the data-port write that triggered the fill.)
      this.vram[this.addr ^ 1] = d.fill;
      this.addr = (this.addr + inc) & 0xffff;
      return;
    }
    const w = this._read68k(d.src) & 0xffff;
    switch (d.kind) {
      case CD_VRAM_W: this._writeVram(w); break;
      case CD_CRAM_W: this.cram[(this.addr >> 1) & 0x3f] = w & 0x0eee; break;
      case CD_VSRAM_W: { const j = (this.addr >> 1) & 0x3f; if (j < 40) this.vsram[j] = w & 0x7ff; break; }
      default: break;
    }
    this.addr = (this.addr + inc) & 0xffff;
    // The source counter is 17 bits wide inside a fixed 128 KB bank: a DMA that
    // runs off the end of its bank wraps to the bank's start rather than
    // continuing into the next one. Games have shipped depending on it.
    d.src = (d.src & 0xfe0000) | ((d.src + 2) & 0x01ffff);
  }

  _finishDma(d) {
    if (d.mode === 3) { this.reg[21] = d.src & 0xff; this.reg[22] = (d.src >> 8) & 0xff; }
    else if (d.mode === 0) {
      const s = d.src >> 1;
      this.reg[21] = s & 0xff;
      this.reg[22] = (s >> 8) & 0xff;
      this.reg[23] = (this.reg[23] & 0x80) | ((s >> 16) & 0x7f);
    }
    this.reg[19] = 0; this.reg[20] = 0;
    d.active = false;
    this.dmaBusy = false;
  }

  // Run a pending DMA to completion without waiting for the clock. Only the
  // tests use this; the machine steps the engine.
  flushDma() { while (this.dma.active) this.runDma(1 << 20); return this; }

  // ---- scanline renderer -----------------------------------------------------
  renderLine(line) {
    const W = this.screenWidth;
    const H = this.screenHeight;
    if (line >= H) return this;
    const out = this.frameRgb;
    const base = line * 320 * 3;

    // Display off: the whole line is the backdrop colour, which is what a game
    // gets when it blanks the screen to upload tiles.
    if (!this.displayEnabled) {
      const [r, g, b] = this._rgbOf(this.reg[7] & 0x3f, 0);
      for (let x = 0; x < W; x++) { const o = base + x * 3; out[o] = r; out[o + 1] = g; out[o + 2] = b; }
      return this;
    }

    this._colA.fill(0, 0, W); this._priA.fill(0, 0, W);
    this._colB.fill(0, 0, W); this._priB.fill(0, 0, W);
    this._colS.fill(0, 0, W); this._priS.fill(0, 0, W); this._opS.fill(0, 0, W);

    const hsBase = (this.reg[13] & 0x3f) << 10;
    const hsMode = this.reg[11] & 3;
    let hsOff;
    switch (hsMode) {
      case 0: hsOff = 0; break;
      case 1: hsOff = (line & 7) << 2; break;   // undocumented; the low 3 lines repeat
      case 2: hsOff = (line & ~7) << 2; break;  // per cell row
      default: hsOff = line << 2; break;        // per line
    }
    const hsA = this._vramWord(hsBase + hsOff) & 0x3ff;
    const hsB = this._vramWord(hsBase + hsOff + 2) & 0x3ff;

    const ntA = (this.reg[2] & 0x38) << 10;
    const ntB = (this.reg[4] & 0x07) << 13;
    const pw = PLANE_CELLS[this.reg[16] & 3];
    const ph = PLANE_CELLS[(this.reg[16] >> 4) & 3];

    // Where the window covers plane A on this line. A window row swallows the
    // whole line; otherwise the split is a column boundary in units of 2 cells.
    const wv = (this.reg[18] & 0x1f) * 8;
    const windowRow = (this.reg[18] & 0x80) ? (line >= wv) : (wv > 0 && line < wv);
    let winFrom = 0, winTo = 0;
    if (windowRow) { winFrom = 0; winTo = W; }
    else {
      const wh = (this.reg[17] & 0x1f) * 16;
      if (this.reg[17] & 0x80) { winFrom = Math.min(wh, W); winTo = W; }
      else { winFrom = 0; winTo = Math.min(wh, W); }
    }

    this._renderPlane(line, ntB, pw, ph, hsB, 1, this._colB, this._priB, 0, W);
    if (winFrom > 0) this._renderPlane(line, ntA, pw, ph, hsA, 0, this._colA, this._priA, 0, winFrom);
    if (winTo < W) this._renderPlane(line, ntA, pw, ph, hsA, 0, this._colA, this._priA, winTo, W);
    if (winTo > winFrom) this._renderWindow(line, winFrom, winTo, W);
    this._renderSprites(line, W);

    // ---- priority + shading, one pass ----------------------------------------
    const sh = (this.reg[12] & 0x08) !== 0;
    const backdrop = this.reg[7] & 0x3f;
    for (let x = 0; x < W; x++) {
      const ca = this._colA[x], cb = this._colB[x], cs = this._colS[x];
      const oa = (ca & 0x0f) !== 0, ob = (cb & 0x0f) !== 0;
      const op = this._opS[x];
      const os = (cs & 0x0f) !== 0 && op === 0;
      const pa = this._priA[x], pb = this._priB[x], ps = this._priS[x];

      let col = backdrop;
      let rank = 0; // backdrop
      if (ob) { col = cb; rank = 1; }
      if (oa) { col = ca; rank = 2; }
      if (os && !ps) { col = cs; rank = 3; }
      if (ob && pb) { col = cb; rank = 4; }
      if (oa && pa) { col = ca; rank = 5; }
      if (os && ps) { col = cs; rank = 6; }

      let shade = 0;
      if (sh) {
        const planeNormal = (oa && pa) || (ob && pb);
        shade = planeNormal ? 0 : 1;
        if (op === 1) shade = 1;                       // pal 3 col 15: force shadow
        else if (op === 2) shade = shade === 1 ? 0 : 2; // pal 3 col 14: lift
        else if (os && ps) shade = 0;                   // high-priority sprite: normal
      }
      const o = base + x * 3;
      const c = this.cram[col & 0x3f];
      const lut = shade === 1 ? LUT_SHADOW : shade === 2 ? LUT_HILITE : LUT_NORMAL;
      out[o] = lut[(c >> 1) & 7];
      out[o + 1] = lut[(c >> 5) & 7];
      out[o + 2] = lut[(c >> 9) & 7];
      void rank;
    }

    // Register 0 bit 5 blanks the leftmost cell, which games use to hide the
    // partial column that horizontal scrolling drags in from off-screen.
    if (this.reg[0] & 0x20) {
      const [r, g, b] = this._rgbOf(backdrop, 0);
      for (let x = 0; x < 8; x++) { const o = base + x * 3; out[o] = r; out[o + 1] = g; out[o + 2] = b; }
    }
    return this;
  }

  _rgbOf(index, shade) {
    const c = this.cram[index & 0x3f];
    const lut = shade === 1 ? LUT_SHADOW : shade === 2 ? LUT_HILITE : LUT_NORMAL;
    return [lut[(c >> 1) & 7], lut[(c >> 5) & 7], lut[(c >> 9) & 7]];
  }

  _vramWord(a) { a &= 0xfffe; return (this.vram[a] << 8) | this.vram[a + 1]; }

  // One scrolling plane, cell by cell. `which` is 0 for A and 1 for B and only
  // selects which of each VSRAM pair to read.
  _renderPlane(line, nt, pw, ph, hscroll, which, col, pri, xFrom, xTo) {
    const vsFull = (this.reg[11] & 0x04) === 0;
    const planeH = ph * 8, planeW = pw * 8;
    let x = xFrom;
    while (x < xTo) {
      // Two-cell vertical scroll indexes off the SCREEN column, so the columns
      // stay put while the plane slides under them — that is the whole point of
      // the mode (Sonic 2's bobbing bonus stage, the boss shake in Gunstar).
      const vsIdx = vsFull ? which : (((x >> 4) << 1) + which);
      const vscroll = this.vsram[vsFull ? which : Math.min(vsIdx, 39)] & 0x3ff;
      const py = (line + vscroll) % planeH;
      const row = (py >> 3) & (ph - 1);
      const px = (((x - hscroll) % planeW) + planeW) % planeW;
      const cellX = px >> 3;
      const fine = px & 7;
      const entry = this._vramWord(nt + ((row * pw + cellX) << 1));
      // How many pixels of this tile are left before either the tile ends or
      // the 2-cell vertical-scroll column changes under us.
      let run = 8 - fine;
      if (!vsFull) run = Math.min(run, 16 - (x & 15));
      if (x + run > xTo) run = xTo - x;
      this._blitTileRun(entry, py & 7, fine, run, x, col, pri);
      x += run;
    }
  }

  // The window plane has no scroll at all: it is addressed by screen position.
  // Its nametable is 64 cells wide in H40 and 32 in H32 regardless of the plane
  // size register, which is why it gets its own loop.
  _renderWindow(line, xFrom, xTo, W) {
    const h40 = this.h40;
    const nt = (this.reg[3] & (h40 ? 0x3c : 0x3e)) << 10;
    const pw = h40 ? 64 : 32;
    const row = line >> 3;
    let x = xFrom;
    while (x < xTo) {
      const cellX = x >> 3;
      const fine = x & 7;
      const entry = this._vramWord(nt + ((row * pw + cellX) << 1));
      let run = 8 - fine;
      if (x + run > xTo) run = xTo - x;
      this._blitTileRun(entry, line & 7, fine, run, x, this._colA, this._priA);
      x += run;
    }
    void W;
  }

  // A nametable entry is priority(15) palette(14-13) vflip(12) hflip(11)
  // tile(10-0); a tile is 32 bytes, 4 bits per pixel, high nibble first.
  _blitTileRun(entry, ty, fine, run, xDst, col, pri) {
    const tile = (entry & 0x7ff) << 5;
    const pal = (entry >> 13) & 3;
    const hflip = (entry & 0x0800) !== 0;
    const vflip = (entry & 0x1000) !== 0;
    const p = (entry & 0x8000) ? 1 : 0;
    const rowBase = tile + ((vflip ? 7 - ty : ty) << 2);
    const base = pal << 4;
    for (let i = 0; i < run; i++) {
      const sx = hflip ? 7 - (fine + i) : (fine + i);
      const b = this.vram[(rowBase + (sx >> 2)) & 0xffff];
      const v = (sx & 1) ? (b & 0x0f) : (b >> 4);
      const dx = xDst + i;
      if (v) { col[dx] = base | v; pri[dx] = p; }
      else if (col[dx] === 0) { pri[dx] = p; } // transparent pixel still owns the priority slot
    }
  }

  // Sprites are a linked list in the sprite attribute table, walked in link
  // order until it returns to 0 or the table is exhausted. Two hardware limits
  // matter and both are visible in real games: at most 20 sprites (H40) or 16
  // (H32) per line, and at most a screen's width of sprite pixels per line.
  _renderSprites(line, W) {
    const h40 = this.h40;
    const sat = (this.reg[5] & (h40 ? 0x7e : 0x7f)) << 9;
    const maxSprites = h40 ? 20 : 16;
    const maxTotal = h40 ? 80 : 64;
    let pixelBudget = W;
    let onLine = 0;
    let idx = 0;
    for (let n = 0; n < maxTotal; n++) {
      const e = sat + (idx << 3);
      const ypos = (this._vramWord(e) & 0x3ff) - 128;
      const size = this.vram[(e + 2) & 0xffff];
      const link = this.vram[(e + 3) & 0xffff] & 0x7f;
      const hs = ((size >> 2) & 3) + 1;
      const vs = (size & 3) + 1;
      const attr = this._vramWord(e + 4);
      const rawX = this._vramWord(e + 6) & 0x1ff;
      const xpos = rawX - 128;

      if (line >= ypos && line < ypos + vs * 8) {
        // A sprite at X=0 that is not the first one on the line is a mask: the
        // hardware stops emitting sprite pixels for the rest of the line. Games
        // park a dummy sprite there to cut a sprite layer off at a boundary.
        if (rawX === 0 && onLine > 0) break;
        onLine++;
        if (onLine > maxSprites) { this.spriteOverflow = true; break; }
        pixelBudget = this._blitSprite(line, ypos, xpos, hs, vs, attr, pixelBudget, W);
        if (pixelBudget <= 0) { this.spriteOverflow = true; break; }
      }
      if (link === 0) break;
      idx = link;
    }
  }

  _blitSprite(line, ypos, xpos, hs, vs, attr, budget, W) {
    const tileBase = (attr & 0x7ff) << 5;
    const pal = (attr >> 13) & 3;
    const hflip = (attr & 0x0800) !== 0;
    const vflip = (attr & 0x1000) !== 0;
    const p = (attr & 0x8000) ? 1 : 0;
    const palBase = pal << 4;
    let sy = line - ypos;
    if (vflip) sy = vs * 8 - 1 - sy;
    const cellRow = sy >> 3, ty = sy & 7;
    const wpx = hs * 8;
    for (let i = 0; i < wpx && budget > 0; i++) {
      const dx = xpos + i;
      let sx = i;
      if (hflip) sx = wpx - 1 - i;
      // Off-screen sprite pixels still cost the line's pixel budget — that is
      // why a game can lose sprites to something parked past the right edge.
      budget--;
      if (dx < 0 || dx >= W) continue;
      // Tiles inside a multi-cell sprite run down the columns first.
      const tile = tileBase + (((sx >> 3) * vs + cellRow) << 5);
      const b = this.vram[(tile + (ty << 2) + ((sx & 7) >> 1)) & 0xffff];
      const v = (sx & 1) ? (b & 0x0f) : (b >> 4);
      if (!v) continue;
      if (this._colS[dx] & 0x0f) { this.spriteCollision = true; continue; } // first sprite wins
      // Palette 3 colours 14 and 15 are the shadow/highlight operators when
      // register 12 bit 3 is on: transparent pixels that change what is under
      // them. With shading off they are ordinary colours.
      if (pal === 3 && (v === 14 || v === 15) && (this.reg[12] & 0x08)) {
        this._opS[dx] = v === 15 ? 1 : 2;
        this._colS[dx] = palBase | v;
        this._priS[dx] = p;
        continue;
      }
      this._colS[dx] = palBase | v;
      this._priS[dx] = p;
    }
    return budget;
  }

  endFrame() {
    // Interlace toggles the odd/even flag every frame even in mode 0, and the
    // flag is readable, so a game can use it as a 30 Hz clock.
    this.oddFrame = !this.oddFrame;
    return this;
  }

  // ---- output ---------------------------------------------------------------
  // Same shape as machine88.js / machinenes.js: plain data, RGB by default and
  // a GRB index plus per-gun drive for the demo's shared phosphor pipeline.
  render({ out = null, indexed = false, analog = true } = {}) {
    const W = this.screenWidth, H = this.screenHeight, N = W * H;
    const src = this.frameRgb;
    if (indexed) {
      const pixels = out && out.length === N ? out : new Uint8Array(N);
      let drive = null;
      if (analog) {
        if (!this._driveBuf || this._driveBuf.length !== N * 3) this._driveBuf = new Float32Array(N * 3);
        drive = this._driveBuf;
      }
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const s = (y * 320 + x) * 3, i = y * W + x;
          const r = src[s], g = src[s + 1], b = src[s + 2];
          pixels[i] = (g >= 128 ? 4 : 0) | (r >= 128 ? 2 : 0) | (b >= 128 ? 1 : 0);
          if (drive) { drive[i] = r / 255; drive[N + i] = g / 255; drive[2 * N + i] = b / 255; }
        }
      }
      return { width: W, height: H, pixels, drive, schemaVersion: SCHEMA_VERSION };
    }
    const rgb = out && out.length === N * 3 ? out : new Uint8Array(N * 3);
    for (let y = 0; y < H; y++) rgb.set(src.subarray(y * 960, y * 960 + W * 3), y * W * 3);
    return { width: W, height: H, rgb, schemaVersion: SCHEMA_VERSION };
  }

  // ---- state -----------------------------------------------------------------
  // The frame buffer is deliberately absent: it is output, not state, and at
  // 230 KB it would be two thirds of a Mega Drive snapshot on its own. A
  // restored frame redraws from the next line onwards; a rewind that lands
  // mid-frame shows the rest of that frame's picture from before the rewind
  // for a few milliseconds, which no one has ever noticed.
  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      // The finished picture. It reads like output rather than state — and it
      // was left out on exactly that reasoning — but a frame is 240 lines each
      // painted with CRAM and the registers as they stood when the raster
      // crossed them, so no amount of end-of-frame state reproduces it. The
      // host's jog/shuttle restores a snapshot and draws *without* stepping, so
      // leaving it out makes every rewound frame show the last one the emulator
      // actually ran (found on the Game Boy, 2026-08-10, then measured here).
      frameRgb: this.frameRgb.slice(),
      vram: this.vram.slice(),
      cram: Array.from(this.cram),
      vsram: Array.from(this.vsram),
      reg: Array.from(this.reg),
      ctrlPending: this._ctrlPending, ctrlFirst: this._ctrlFirst,
      code: this.code, addr: this.addr, readBuffer: this._readBuffer,
      fillPending: this._fillPending,
      dma: { ...this.dma }, dmaAcc: this._dmaAcc,
      line: this.line, lineMclk: this.lineMclk,
      hblank: this.hblank, vblank: this.vblank,
      hintCounter: this.hintCounter,
      hintPending: this.hintPending, vintPending: this.vintPending,
      statusVint: this.statusVint,
      spriteOverflow: this.spriteOverflow, spriteCollision: this.spriteCollision,
      dmaBusy: this.dmaBusy, oddFrame: this.oddFrame, hvLatched: this._hvLatched,
    };
  }

  setState(s) {
    // Older snapshots predate the picture; leave the buffer as-is for those
    // rather than blanking a screen the caller may still be looking at.
    if (s.frameRgb) this.frameRgb.set(s.frameRgb);
    this.vram.set(s.vram);
    for (let i = 0; i < 64; i++) this.cram[i] = s.cram[i];
    for (let i = 0; i < 40; i++) this.vsram[i] = s.vsram[i];
    for (let i = 0; i < 32; i++) this.reg[i] = s.reg[i];
    this._ctrlPending = s.ctrlPending; this._ctrlFirst = s.ctrlFirst;
    this.code = s.code; this.addr = s.addr; this._readBuffer = s.readBuffer;
    this._fillPending = s.fillPending;
    this.dma = { ...s.dma };
    this._dmaAcc = s.dmaAcc;
    this.line = s.line; this.lineMclk = s.lineMclk;
    this.hblank = s.hblank; this.vblank = s.vblank;
    this.hintCounter = s.hintCounter;
    this.hintPending = s.hintPending; this.vintPending = s.vintPending;
    this.statusVint = s.statusVint;
    this.spriteOverflow = s.spriteOverflow; this.spriteCollision = s.spriteCollision;
    this.dmaBusy = s.dmaBusy; this.oddFrame = s.oddFrame; this._hvLatched = s.hvLatched;
    return this;
  }
}

export function createMdVdp(opts) { return new MdVdp(opts); }
export default MdVdp;
