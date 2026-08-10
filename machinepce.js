// machinepce — the PC Engine / TurboGrafx-16 as a machine, on the same
// contract as Pc8801Machine, NesMachine and MachineMd: `stepFrame()`, `frame`,
// `snapshot()`, `restore()`, `schemaVersion`. The host in demo/machine.html
// builds fast-forward, rewind and jog-shuttle on that contract and nothing
// else, so satisfying it is the whole price of admission for time travel.
//
// The coordinator closes the loops the chips cannot close for themselves:
// huc6280.js knows nothing about a video chip, huc6270.js knows nothing about a
// CPU, and neither knows what a cartridge is.
//
// ## One clock, three dividers
//
// This is the thing that makes the PC Engine different from the two consoles
// already in this repository. The Famicom has a fixed 3:1 ratio between the PPU
// and the CPU, so nesppu.js can be ticked three dots per bus access and that is
// the end of it. Here NOTHING has a fixed ratio to anything:
//
//   - the CPU divides the 21.477MHz master clock by 3 or by 12, and swaps
//     between them at runtime with CSL/CSH;
//   - the video dot clock divides it by 4, 3 or 2, and the game picks;
//   - the sound chip divides it by 6;
//   - the CPU's own timer divides it by 3072.
//
// So the machine counts MASTER CLOCKS and everything else is a divider of that.
// A CPU cycle costs cpu.clockDiv master clocks; a scanline is always 1365 of
// them whatever the dot clock is doing (a faster dot clock buys more pixels,
// not more time). That single change is what makes CSL/CSH free: the video chip
// never finds out that the CPU changed speed.
//
// ## Why the CPU's bus grew an idle() method
//
// m6502.js models a chip where every cycle is a bus access, and for a 6502 that
// is true enough that nestest matches to the cycle. The HuC6280 breaks it: TAM
// is five cycles with two accesses and a block copy is six cycles a byte with
// two. So huc6280.js calls bus.idle(n) for the cycles it spends inside itself,
// and this file advances the video clock through idle() exactly as it does
// through read/write. Without it a game that copies a screen with TII would
// have the picture stop while the copy ran.
//
// ## Where a scanline's events sit
//
// Two events per line, at different offsets:
//
//   offset 0     the vertical phase machine steps and the raster compare fires
//   offset ~250  the line is drawn
//
// The gap is not decoration. A raster interrupt arrives at the top of the line
// and the game's handler changes the scroll registers before the picture for
// that line is fetched; on hardware it has the front porch to do it in, which
// at 7.16MHz is about eighty instructions. Collapse the two events into one and
// every split-screen in the library lands a line early or a line late depending
// on which order you picked.

import { HuC6280, IRQ1, IRQ2, MASTER_HZ } from './huc6280.js';
import { HuC6270, MAX_WIDTH, MAX_HEIGHT } from './huc6270.js';
import { HuC6260, buildVcePaletteRgb, buildVceGrayRgb } from './huc6260.js';
import { PcePsg } from './pcepsg.js';
import { parsePce, buildBankMap, MAPPER, BANK_SIZE } from './pcerom.js';

export const SCHEMA_VERSION = 1;

// A scanline is 1365 master clocks on every PC Engine, in every video mode.
export const LINE_MASTER = 1365;
// Where in the line the picture is fetched. The VDC's own horizontal registers
// say where the display window starts, but they are expressed in dot-clock
// units that change with the video mode, and no game programs them so tightly
// that the difference is visible. What IS visible is the gap existing at all.
export const RENDER_OFFSET = 250;

export const WRAM_SIZE = 0x2000;   // 8KB. The SuperGrafx has 32KB; this is not one
export const BRAM_SIZE = 0x800;    // battery-backed save RAM, mirrored through 8KB

// Button bits, in the order the hardware's two nibbles present them: the low
// nibble is I/II/SELECT/RUN and the high nibble is the d-pad, which is why the
// numbering looks arbitrary until you read $1000.
export const BUTTON = Object.freeze({
  I: 0, II: 1, SELECT: 2, RUN: 3, UP: 4, RIGHT: 5, DOWN: 6, LEFT: 7,
});

const PALETTE_RGB = buildVcePaletteRgb();
const PALETTE_GRAY = buildVceGrayRgb();

export class PceMachine {
  // One of:
  //   { cart }   an image already parsed by pcerom.js
  //   { rom }    raw .pce bytes
  constructor({ cart = null, rom = null, sampleRate = 48000,
                japanese = true, padSelDirections = true } = {}) {
    if (!cart && rom) cart = parsePce(rom);
    if (!cart) throw new Error('PceMachine needs a cartridge (cart or rom)');
    this.cart = cart;
    this.schemaVersion = SCHEMA_VERSION;
    this.frame = 0;
    this._acc = 0;
    this.japanese = japanese;
    // Which way round the pad's multiplexer runs. The nibble grouping is not in
    // doubt (I/II/SELECT/RUN together, U/R/D/L together); which one SEL=1
    // selects is, and the two possibilities are indistinguishable in every
    // document this was written from. It is an option so the sweep can measure
    // it instead of the code guessing — see docs/pce-design.md §9.
    this.padSelDirections = padSelDirections;

    this.wram = new Uint8Array(WRAM_SIZE);
    this.bram = new Uint8Array(BRAM_SIZE);
    this.vdc = new HuC6270();
    this.vce = new HuC6260();
    this.psg = new PcePsg({ sampleRate });

    // The cartridge bank table, resolved to byte offsets. Street Fighter II
    // rewrites the upper half of it at runtime; everything else is fixed for
    // the life of the machine.
    this.rom = cart.rom;
    this.bankOff = Int32Array.from(cart.banks);
    this.sf2Bank = 0;

    this.pads = new Uint8Array(5);   // live button state per pad (BUTTON bits)
    this._padSel = 0;
    this._padClr = 0;
    this._padIndex = 0;

    // Master-clock bookkeeping. `mclk` is the machine's only clock; everything
    // else is derived from it.
    this.mclk = 0;
    this._lineBase = 0;
    this._eventKind = 0;
    this._nextEvent = 0;
    this._pendingRender = false;
    this._psgMclk = 0;
    this.line = 0;
    this.frameComplete = false;

    // Output, not state: a 512x242 window big enough for every video mode,
    // holding 9-bit VCE colours (converted line by line, so a palette change in
    // a raster interrupt splits the screen as it should).
    this.frameBuf = new Uint16Array(MAX_WIDTH * MAX_HEIGHT);
    this.frameWidth = 256;
    this.frameHeight = 224;

    this.cpu = new HuC6280({
      read: (a) => { this._advance(); return this._read(a); },
      write: (a, v) => { this._advance(); this._write(a, v); },
      idle: (n) => { this._advance(n); },
      // ST0/ST1/ST2 reach the video chip without an address. Routing them here
      // rather than through _write() is not an optimisation: the instructions
      // genuinely bypass the address bus, so a game can drive the VDC with all
      // eight MPRs pointed somewhere else.
      st: (port, v) => { this._vdcWrite(port === 0 ? 0 : port + 1, v); },
    });
    this.mpr = this.cpu.mpr;   // the MMU's registers live in the CPU; alias them

    this.reset();
  }

  reset() {
    this.vdc.reset();
    this.vce.reset();
    this.psg.reset();
    this.mclk = 0;
    this._lineBase = 0;
    this._eventKind = 0;
    this._nextEvent = 0;
    this._psgMclk = 0;
    this.line = 0;
    this.frameComplete = false;
    this.cpu.reset();
    this.mpr = this.cpu.mpr;
    return this;
  }

  powerOn() {
    this.wram.fill(0);
    this.vdc.powerOn();
    this.vce.powerOn();
    this.psg.powerOn();
    this.frameBuf.fill(0);
    this.frame = 0;
    this._acc = 0;
    this.sf2Bank = 0;
    this._applySf2();
    return this.reset();
  }

  // ---- the clock ------------------------------------------------------------
  // Called once per CPU cycle (or n at a time for the cycles the CPU spends
  // inside itself). Everything downstream is a divider of the master clock, so
  // this is the only place that knows what time it is.
  _advance(n = 1) {
    const m = n * this.cpu.clockDiv;
    this.mclk += m;
    this.cpu.clockTimer(m);
    while (this.mclk >= this._nextEvent) this._fireEvent();
  }

  _fireEvent() {
    if (this._eventKind === 0) {
      // Top of the line. The phase machine may raise a raster or vblank
      // interrupt here, and the game's handler then has RENDER_OFFSET master
      // clocks — about eighty instructions at full speed — to change the
      // scroll registers before this line is fetched.
      this._psgCatchUp();
      // The VDC's vertical registers do not have to add up to a frame, and on
      // hardware the picture rolls when they do not. The VCE is the chip that
      // knows what a frame is, so it tells the VDC — see the VSW case in
      // huc6270._nextPhase().
      this.vdc.framePeriod = this.vce.linesPerFrame;
      this._pendingRender = this.vdc.lineStart();
      this._syncVdcIrq();
      this._eventKind = 1;
      this._nextEvent = this._lineBase + RENDER_OFFSET;
      return;
    }
    if (this._pendingRender) this._drawLine();
    this._lineBase += LINE_MASTER;
    this._eventKind = 0;
    this._nextEvent = this._lineBase;
    if (++this.line >= this.vce.linesPerFrame) {
      this.line = 0;
      this.frameComplete = true;
      this.frameWidth = this.vdc.lastWidth;
      this.frameHeight = this.vdc.lastHeight;
    }
  }

  _drawLine() {
    const vdc = this.vdc;
    const y = vdc.displayY;
    if (y < MAX_HEIGHT) {
      const w = Math.min(vdc.lastWidth, MAX_WIDTH);
      const line = vdc.renderLine(w);
      const pal = this.vce.palette;
      const o = y * MAX_WIDTH;
      const buf = this.frameBuf;
      for (let x = 0; x < w; x++) buf[o + x] = pal[line[x]];
      // Anything to the right of the active window is blanking, not stale
      // pixels from the last time the game used a wider mode.
      for (let x = w; x < MAX_WIDTH; x++) buf[o + x] = 0;
      this._syncVdcIrq();
    }
    vdc.lineDone();
  }

  _syncVdcIrq() { this.cpu.setIrq(IRQ1, this.vdc.irq); }

  // The PSG is caught up lazily: on every line boundary, and immediately before
  // any write to its registers. That keeps a note onset on the sample it was
  // written on without paying a per-cycle call.
  _psgCatchUp() {
    const d = this.mclk - this._psgMclk;
    if (d > 0) { this.psg.run(d); this._psgMclk = this.mclk; }
  }

  // ---- memory map -----------------------------------------------------------
  // The MMU turns a 16-bit address into a 21-bit one, 8KB at a time. Banks
  // $00-$7F are the cartridge, $F7 the save RAM, $F8 the work RAM and $FF the
  // hardware page; everything else reads as open bus.
  _read(addr) {
    addr &= 0xffff;
    const bank = this.mpr[addr >> 13];
    const off = addr & 0x1fff;
    if (bank < 0x80) {
      const b = this.bankOff[bank];
      return b >= 0 ? this.rom[b + off] : 0xff;
    }
    if (bank === 0xf8) return this.wram[off];
    if (bank === 0xf7) return this.bram[off & (BRAM_SIZE - 1)];
    if (bank === 0xff) return this._hwRead(off);
    return 0xff;
  }

  _write(addr, value) {
    addr &= 0xffff;
    value &= 0xff;
    const bank = this.mpr[addr >> 13];
    const off = addr & 0x1fff;
    if (bank < 0x80) {
      // Street Fighter II' is the only HuCard with a mapper, and its bank
      // register is four addresses in ROM space. Any other write to ROM is a
      // game scribbling on a cartridge, which hardware ignores.
      if (this.cart.mapper === MAPPER.SF2 && (off & 0x1ffc) === 0x1ff0) {
        this.sf2Bank = off & 3;
        this._applySf2();
      }
      return;
    }
    if (bank === 0xf8) { this.wram[off] = value; return; }
    if (bank === 0xf7) { this.bram[off & (BRAM_SIZE - 1)] = value; return; }
    if (bank === 0xff) this._hwWrite(off, value);
  }

  _applySf2() {
    if (this.cart.mapper !== MAPPER.SF2) return;
    const base = 0x80000 + this.sf2Bank * 0x80000;
    for (let b = 0x40; b < 0x80; b++) this.bankOff[b] = base + (b - 0x40) * BANK_SIZE;
  }

  // ---- the hardware page (bank $FF) -----------------------------------------
  // Eight 1KB windows, each holding a device with far fewer registers than it
  // has address space, so everything mirrors.
  _hwRead(off) {
    switch (off >> 10) {
      case 0: {                                  // $0000-$03FF  VDC
        const v = this.vdc.read(off & 3);
        this._syncVdcIrq();                      // reading the status is the acknowledge
        return v;
      }
      case 1: return this.vce.read(off & 7);     // $0400-$07FF  VCE
      case 2: return this.psg.read(off & 0x0f);  // $0800-$0BFF  PSG (write-only)
      case 3: return this.cpu.ioRead(0x0c00 | (off & 1)) ?? 0xff;   // timer
      case 4: return this._padRead();            // $1000-$13FF  joypad port
      case 5: return this.cpu.ioRead(0x1400 | (off & 3)) ?? 0xff;   // interrupt controller
      // $1800-$1BFF is the CD-ROM interface. There is no CD unit here, and a
      // HuCard-only library never touches it; returning open bus is what an
      // unexpanded console does.
      default: return 0xff;
    }
  }

  _hwWrite(off, v) {
    switch (off >> 10) {
      case 0: this._vdcWrite(off & 3, v); return;
      case 1: this.vce.write(off & 7, v); return;
      case 2: this._psgCatchUp(); this.psg.write(off & 0x0f, v); return;
      case 3: this.cpu.ioWrite(0x0c00 | (off & 1), v); return;
      case 4: this._padWrite(v); return;
      case 5: this.cpu.ioWrite(0x1400 | (off & 3), v); return;
      default: return;
    }
  }

  _vdcWrite(port, v) {
    this.vdc.write(port, v);
    // A register write can start a DMA, and a DMA can finish and raise an
    // interrupt inside this very access. Syncing here rather than at the next
    // line boundary is what lets a game poll for "copy finished" in a tight
    // loop and get out of it.
    this._syncVdcIrq();
  }

  // ---- the joypad -----------------------------------------------------------
  // One port, one byte, two nibbles behind a multiplexer. SEL picks a nibble
  // and CLR resets the multitap's daisy chain; with a single pad plugged in
  // there is no chain, so CLR just blanks the read.
  _padWrite(v) {
    this._padSel = v & 1;
    const clr = (v >> 1) & 1;
    if (clr && !this._padClr) this._padIndex = 0;
    this._padClr = clr;
  }

  _padRead() {
    let data = 0x0f;
    if (!this._padClr) {
      const p = this.pads[0];
      const directions = this._padSel ? this.padSelDirections : !this.padSelDirections;
      const nib = directions ? (p >> 4) & 0x0f : p & 0x0f;
      data = (~nib) & 0x0f;   // buttons are active low
    }
    // Bit 6 low says "Japanese console" and bit 7 high says "no CD-ROM
    // attached". A few titles branch on the first and a few CD-aware HuCards on
    // the second.
    return data | (this.japanese ? 0 : 0x40) | 0x80;
  }

  padDown(bit, pad = 0) { this.pads[pad] |= (1 << bit); return this; }
  padUp(bit, pad = 0) { this.pads[pad] &= ~(1 << bit); return this; }
  setPad(mask, pad = 0) { this.pads[pad] = mask & 0xff; return this; }

  // ---- audio ----------------------------------------------------------------
  // Same signature as machine88.renderAudio() and NesMachine.renderAudio(): the
  // host's pump does not know which machine it is talking to.
  renderAudio(out, n = out.length) {
    this._psgCatchUp();
    return this.psg.render(out, n);
  }

  // ---- run ------------------------------------------------------------------
  // One video frame = "run until the line counter wraps". Unlike the Famicom
  // there is no natural vblank boundary to stop on — the VDC's vertical phases
  // are programmable and a game can put its display anywhere in the 263 lines —
  // so the frame boundary is the VCE's, which is the one the television sees.
  stepFrame() {
    this.frameComplete = false;
    // A frame is ~119,000 CPU cycles at full speed. The guard is a safety net
    // for a ROM that jams or programs the video chip into a state with no line
    // boundary, not a timing device.
    let guard = 500000;
    while (!this.frameComplete && guard-- > 0) {
      // A jammed CPU stops driving the bus, and with it the machine's only
      // clock — so the raster would stop and the host would hang inside one
      // stepFrame(). Keep the clock running by hand instead, exactly as
      // machinenes.js does.
      if (this.cpu.jammed) { this.cpu.cycles++; this._advance(); }
      else this.cpu.step();
    }
    this.frame++;
    return this;
  }

  get frameHz() { return MASTER_HZ / (LINE_MASTER * this.vce.linesPerFrame); }

  update(dt, onFrame = null) {
    this._acc += dt;
    const period = 1 / this.frameHz;
    while (this._acc >= period) { this._acc -= period; this.stepFrame(); if (onFrame) onFrame(); }
    return this;
  }

  // ---- video ----------------------------------------------------------------
  // Plain data out, exactly like machine88.js and machinenes.js:
  //   default        -> { width, height, rgb }
  //   indexed: true  -> { width, height, pixels, drive } for the demo's shared
  //                     CRT pipeline. `pixels` is a GRB index (0..7) that the
  //                     phosphor sim uses for its mask, and `drive` carries the
  //                     real per-gun level so the 512-colour palette survives
  //                     instead of collapsing to eight primaries.
  render({ out = null, indexed = false, analog = true } = {}) {
    const W = Math.max(1, Math.min(this.frameWidth, MAX_WIDTH));
    const H = Math.max(1, Math.min(this.frameHeight, MAX_HEIGHT));
    const N = W * H;
    const buf = this.frameBuf;
    const table = this.vce.monochrome ? PALETTE_GRAY : PALETTE_RGB;
    if (indexed) {
      const pixels = out && out.length === N ? out : new Uint8Array(N);
      let drive = null;
      if (analog) {
        if (!this._driveBuf || this._driveBuf.length !== N * 3) this._driveBuf = new Float32Array(N * 3);
        drive = this._driveBuf;
      }
      for (let y = 0; y < H; y++) {
        const src = y * MAX_WIDTH, dst = y * W;
        for (let x = 0; x < W; x++) {
          const o = buf[src + x] * 3;
          const r = table[o], g = table[o + 1], b = table[o + 2];
          const i = dst + x;
          pixels[i] = (g >= 128 ? 4 : 0) | (r >= 128 ? 2 : 0) | (b >= 128 ? 1 : 0);
          if (drive) { drive[i] = r / 255; drive[N + i] = g / 255; drive[2 * N + i] = b / 255; }
        }
      }
      return { width: W, height: H, pixels, drive, schemaVersion: SCHEMA_VERSION };
    }
    const rgb = out && out.length === N * 3 ? out : new Uint8Array(N * 3);
    for (let y = 0; y < H; y++) {
      const src = y * MAX_WIDTH, dst = y * W * 3;
      for (let x = 0; x < W; x++) {
        const o = buf[src + x] * 3, d = dst + x * 3;
        rgb[d] = table[o]; rgb[d + 1] = table[o + 1]; rgb[d + 2] = table[o + 2];
      }
    }
    return { width: W, height: H, rgb, schemaVersion: SCHEMA_VERSION };
  }

  // ---- time travel ----------------------------------------------------------
  // Everything mutable, nothing immutable. The cartridge stays in the object
  // this machine already holds and no snapshot ever copies it; the framebuffer
  // is output, not state. What is left is dominated by the VDC's 64KB of VRAM,
  // which unlike a cartridge really does change all through a level.
  snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      cpu: this.cpu.getState(),
      wram: this.wram.slice(),
      bram: this.bram.slice(),
      vdc: this.vdc.getState(),
      vce: this.vce.getState(),
      psg: this.psg.getState(),
      pads: this.pads.slice(),
      padSel: this._padSel,
      padClr: this._padClr,
      padIndex: this._padIndex,
      sf2Bank: this.sf2Bank,
      mclk: this.mclk,
      lineBase: this._lineBase,
      eventKind: this._eventKind,
      nextEvent: this._nextEvent,
      pendingRender: this._pendingRender,
      psgMclk: this._psgMclk,
      line: this.line,
      frame: this.frame,
      acc: this._acc,
      frameWidth: this.frameWidth,
      frameHeight: this.frameHeight,
    };
  }

  restore(s) {
    this.cpu.setState(s.cpu);
    this.mpr = this.cpu.mpr;
    this.wram.set(s.wram);
    this.bram.set(s.bram);
    this.vdc.setState(s.vdc);
    this.vce.setState(s.vce);
    this.psg.setState(s.psg);
    this.pads.set(s.pads);
    this._padSel = s.padSel;
    this._padClr = s.padClr;
    this._padIndex = s.padIndex;
    this.sf2Bank = s.sf2Bank;
    this._applySf2();
    this.mclk = s.mclk;
    this._lineBase = s.lineBase;
    this._eventKind = s.eventKind;
    this._nextEvent = s.nextEvent;
    this._pendingRender = s.pendingRender;
    this._psgMclk = s.psgMclk;
    this.line = s.line;
    this.frame = s.frame;
    this._acc = s.acc ?? 0;
    this.frameWidth = s.frameWidth;
    this.frameHeight = s.frameHeight;
    // The interrupt lines the machine drives are ours, not the CPU's, so
    // re-assert them: the first cycle after a restore has to see the same wires
    // as the first cycle before it.
    this._syncVdcIrq();
    return this;
  }
}

export function createPceMachine(opts) { return new PceMachine(opts); }
