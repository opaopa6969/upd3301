// machinemd — the Mega Drive / Genesis as a machine, on the same contract as
// Pc8801Machine and NesMachine: `stepFrame()`, `frame`, `snapshot()`,
// `restore()`, `schemaVersion`. demo/machine.html builds fast-forward, rewind
// and jog-shuttle on that contract and nothing else, so satisfying it is what
// buys this console time travel.
//
// The coordinator closes the loops the parts cannot close themselves: m68000.js
// knows nothing about a VDP, z80.js has never heard of a 68000, mdvdp.js has no
// CPU and ym2612.js has no bus. This file is where they meet.
//
// ## Two CPUs, one clock
//
// Everything on the board is divided down from one master clock: 53.693175 MHz
// on NTSC. The 68000 gets mclk/7, the Z80 and the PSG mclk/15, the YM2612
// mclk/7 with its own /144. A scanline is exactly 3420 master clocks whichever
// screen mode is running, and 2560 of those are the active display in both H32
// and H40 (the pixel clock changes, the count does not). Those numbers divide
// evenly enough that the whole machine can be scheduled in integers:
//
//   1 line          = 3420 mclk = 488 4/7 68000 cycles = 228 Z80 cycles
//   1 YM2612 tick   = 1008 mclk exactly (7 x 144)
//
// So the run loop counts master clocks and hands each chip its share. Nothing
// accumulates a float, and the same input produces the same frame forever —
// which is the whole requirement for rewind, because rewind is "restore a
// snapshot and replay the same inputs".
//
// ## Where a line is drawn
//
// The picture is built one scanline at a time, at the moment that line's
// horizontal blank starts. That is when the register state for the line is
// final and it is before the game's H-interrupt handler has changed anything
// for the NEXT line, which is exactly the arrangement every Mega Drive raster
// effect assumes. See the header of mdvdp.js.
//
// ## What is deliberately not modelled
//
// The VDP write FIFO (the status bits report an empty FIFO), the 68000's
// stall when it writes to a full one, sub-scanline H-counter positions, and
// interlace. The Mega CD and 32X are not here. Six-button pads are not here.
// docs/md-design.md lists the consequences.

import { M68000 } from './m68000.js';
import { Z80 } from './z80.js';
import { MdVdp } from './mdvdp.js';
import { Ym2612, MD_YM_CLOCK } from './ym2612.js';
import { Sn76489, MD_PSG_CLOCK } from './sn76489.js';
import { parseMdRom, preferredRegion } from './mdrom.js';

export const SCHEMA_VERSION = 1;

export const MCLK_NTSC = 53693175;
export const MCLK_PAL = 53203424;
const MCLK_PER_LINE = 3420;
const MCLK_ACTIVE = 2560;      // the visible part of a line, both H32 and H40
const M68K_DIV = 7;
const Z80_DIV = 15;
const YM_MCLK_PER_TICK = M68K_DIV * 144;
// The interleave granularity. One YM2612 tick is the natural grain: fine
// enough that a Z80 sound driver polling the timer flags sees them move where
// it expects, coarse enough that swapping CPUs is not the dominant cost.
const SLICE_MCLK = YM_MCLK_PER_TICK;

// Controller bits, in the order a 3-button pad presents them.
export const BUTTON = Object.freeze({
  UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 4, B: 5, C: 6, START: 7,
});

export class MegaDriveMachine {
  // Either `cart` (already parsed by mdrom.js) or `rom` (raw file bytes).
  // `region` forces one of 'japan' | 'usa' | 'europe'; by default the
  // cartridge header picks.
  constructor({ cart = null, rom = null, region = null, sampleRate = 48000 } = {}) {
    if (!cart && rom) cart = parseMdRom(rom);
    if (!cart) throw new Error('MegaDriveMachine needs a cartridge (cart or rom)');
    this.cart = cart;
    this.rom = cart.rom;
    this.schemaVersion = SCHEMA_VERSION;

    this.region = preferredRegion(cart.region, region);
    this.pal = this.region === 'europe';
    this.mclkHz = this.pal ? MCLK_PAL : MCLK_NTSC;
    this.linesPerFrame = this.pal ? 313 : 262;
    this.frameHz = this.mclkHz / (MCLK_PER_LINE * this.linesPerFrame);

    this.ram = new Uint8Array(0x10000);    // 64 KB of 68000 work RAM
    this.z80ram = new Uint8Array(0x2000);  // 8 KB, the Z80's whole world

    // Cartridge backup RAM. Almost every save chip is an 8-bit part wired to
    // one byte strobe, so the header's width field decides whether an address
    // holds data or is a hole — getting it wrong loses saves silently.
    this.sram = null;
    if (cart.sram) {
      this.sram = new Uint8Array(cart.sram.size);
      this.sramStart = cart.sram.start;
      this.sramEnd = cart.sram.end;
      this.sramWidth = cart.sram.width;
      this._sramDirty = false;
    }
    // $A130F1 bit 0 swaps SRAM in over the ROM at that address. A cartridge
    // whose ROM is smaller than the SRAM window has nothing to swap, so it
    // starts enabled and games that never touch the register still save.
    this.sramEnabled = !!this.sram && this.rom.length <= (this.sramStart || 0);

    this.vdp = new MdVdp({ pal: this.pal, read68k: (a) => this._dmaRead(a) });
    this.psg = new Sn76489({ clockHz: this.mclkHz / Z80_DIV, sampleRate });
    this.ym = new Ym2612({ clockHz: this.mclkHz / M68K_DIV, sampleRate });

    this.cpu = new M68000({
      read16: (a) => this._read16(a),
      write16: (a, v) => this._write16(a, v),
      read8: (a) => this._read8(a),
      write8: (a, v) => this._write8(a, v),
      irqAck: (level) => this.vdp.irqAck(level),
    }, { tasWriteBack: false }); // the Mega Drive's TAS write phase never reaches the bus

    this.z80 = new Z80({
      read: (a) => this._z80Read(a),
      write: (a, v) => this._z80Write(a, v),
      in: () => 0xff,   // the Z80's I/O space is not wired to anything
      out: () => {},
    });

    // Controllers: three ports (two pads and the EXT connector), each with a
    // data latch and a direction mask the game programs itself.
    this.pads = new Uint8Array(3);
    this.ioData = new Uint8Array(3);
    this.ioCtrl = new Uint8Array(3);

    this.frame = 0;
    this._acc = 0;
    this.powerOn();
  }

  powerOn() {
    this.ram.fill(0);
    this.z80ram.fill(0);
    if (this.sram && !this._sramDirty) this.sram.fill(0);
    this.vdp.powerOn();
    this.psg.reset();
    this.frame = 0;
    this._acc = 0;
    return this.reset();
  }

  reset() {
    // The Z80 comes up held in reset with the 68000 owning its bus; the boot
    // code releases both. A machine that started with the Z80 running would
    // execute whatever was left in its RAM.
    this.z80BusReq = true;
    this.z80Reset = true;
    this.z80Bank = 0;
    this._z80IntPending = false;

    this._m68kDebt = 0;
    this._z80Debt = 0;
    this._ymAcc = 0;
    this._irqLevel = -1;
    this.line = 0;

    this.vdp.reset();
    this.z80.reset();
    this.cpu.reset();  // re-reads SSP/PC now that the cartridge is mapped
    this.psg.reset();
    return this;
  }

  // ---- the 68000 bus ---------------------------------------------------------
  // The map, in the order the address decoder resolves it:
  //   $000000-$3FFFFF  cartridge (SRAM may overlay part of it)
  //   $A00000-$A0FFFF  Z80 area, 8 bits wide
  //   $A10000-$A1001F  controller I/O and the version register
  //   $A11100/$A11200  Z80 bus request / reset
  //   $A130F1          cartridge SRAM control (Sega mapper)
  //   $A14000/$A14100  TMSS
  //   $C00000-$C0001F  VDP (mirrored up to $DFFFFF)
  //   $E00000-$FFFFFF  64 KB work RAM, mirrored 32 times
  _read16(a) {
    a &= 0xffffff;
    if (a < 0x400000) {
      if (this.sram && this.sramEnabled && a >= this.sramStart && a <= this.sramEnd) {
        const v = this._sramRead(a | 1);
        // A word read of a byte-wide save chip sees the same byte twice, which
        // is what the save routines that do MOVE.W expect.
        return (v << 8) | v;
      }
      const rom = this.rom;
      return a + 1 < rom.length ? ((rom[a] << 8) | rom[a + 1]) : 0xffff;
    }
    if (a >= 0xe00000) { const o = a & 0xfffe; return (this.ram[o] << 8) | this.ram[o + 1]; }
    if (a >= 0xc00000) return this._vdpRead(a);
    if (a < 0xa00000) return 0xffff; // unmapped: an open bus reads as all ones
    if (a < 0xa10000) { const v = this._z80AreaRead(a); return (v << 8) | v; }
    if (a < 0xa10020) { const v = this._ioRead(a | 1); return (v << 8) | v; }
    if (a === 0xa11100) return this.z80BusReq && !this.z80Reset ? 0x0000 : 0x0100;
    if (a === 0xa11200) return this.z80Reset ? 0x0000 : 0x0100;
    if (a === 0xa130f0) return this.sramEnabled ? 0x0001 : 0x0000;
    return 0xffff;
  }

  _write16(a, v) {
    a &= 0xffffff; v &= 0xffff;
    if (a >= 0xe00000) { const o = a & 0xfffe; this.ram[o] = v >> 8; this.ram[o + 1] = v & 0xff; return; }
    if (a >= 0xc00000) { this._vdpWrite(a, v); return; }
    if (a < 0x400000) {
      if (this.sram && this.sramEnabled && a >= this.sramStart && a <= this.sramEnd) this._sramWrite(a | 1, v & 0xff);
      return; // ROM otherwise: writes go nowhere, as on the cartridge
    }
    if (a < 0xa00000) return;
    // The Z80's data bus is 8 bits; a 68000 word write puts its HIGH byte on
    // it and the low byte is simply not there. Sound drivers uploaded with
    // MOVE.W would be every other byte otherwise.
    if (a < 0xa10000) { this._z80AreaWrite(a, (v >> 8) & 0xff); return; }
    if (a < 0xa10020) { this._ioWrite(a | 1, v & 0xff); return; }
    if (a === 0xa11100) { this._setZ80BusReq((v & 0x0100) !== 0); return; }
    if (a === 0xa11200) { this._setZ80Reset((v & 0x0100) === 0); return; }
    if (a === 0xa130f0) { if (this.sram) this.sramEnabled = (v & 1) !== 0; return; }
  }

  // Byte accesses are given explicitly rather than synthesized from words: the
  // synthesis in m68000.js does a read-modify-write, and half this map is
  // registers where a spurious read has a side effect (the VDP's status, the
  // controller latches). This is also what the hardware does — the 68000 has
  // UDS/LDS byte strobes.
  _read8(a) {
    a &= 0xffffff;
    if (a < 0x400000) {
      if (this.sram && this.sramEnabled && a >= this.sramStart && a <= this.sramEnd) return this._sramRead(a);
      return a < this.rom.length ? this.rom[a] : 0xff;
    }
    if (a >= 0xe00000) return this.ram[a & 0xffff];
    if (a >= 0xc00000) { const w = this._vdpRead(a & ~1); return (a & 1) ? (w & 0xff) : (w >> 8); }
    if (a < 0xa00000) return 0xff;
    if (a < 0xa10000) return this._z80AreaRead(a);
    if (a < 0xa10020) return this._ioRead(a);
    if (a === 0xa11100) return (this.z80BusReq && !this.z80Reset) ? 0x00 : 0x01;
    if (a === 0xa11101) return 0x00;
    if (a === 0xa130f1) return this.sramEnabled ? 1 : 0;
    return 0xff;
  }

  _write8(a, v) {
    a &= 0xffffff; v &= 0xff;
    if (a >= 0xe00000) { this.ram[a & 0xffff] = v; return; }
    if (a >= 0xc00000) {
      // $C00011 is the PSG, the one byte-only register in the VDP's block.
      if ((a & 0x1f) >= 0x10 && (a & 0x1f) <= 0x17) { this.psg.write(v); return; }
      this._vdpWrite(a & ~1, (v << 8) | v);
      return;
    }
    if (a < 0x400000) {
      if (this.sram && this.sramEnabled && a >= this.sramStart && a <= this.sramEnd) this._sramWrite(a, v);
      return;
    }
    if (a < 0xa00000) return;
    if (a < 0xa10000) { this._z80AreaWrite(a, v); return; }
    if (a < 0xa10020) { this._ioWrite(a, v); return; }
    if (a === 0xa11100) { this._setZ80BusReq((v & 1) !== 0); return; }
    if (a === 0xa11200) { this._setZ80Reset((v & 1) === 0); return; }
    if (a === 0xa130f1) { if (this.sram) this.sramEnabled = (v & 1) !== 0; return; }
  }

  // DMA reads the 68000 bus as the bus master. It never reaches the VDP itself
  // (a DMA from $C00000 is a documented lock-up on real hardware) so this is
  // the plain memory path with no side effects.
  _dmaRead(a) {
    a &= 0xffffff;
    if (a < 0x400000) { const rom = this.rom; return a + 1 < rom.length ? ((rom[a] << 8) | rom[a + 1]) : 0xffff; }
    if (a >= 0xe00000) { const o = a & 0xfffe; return (this.ram[o] << 8) | this.ram[o + 1]; }
    return this._read16(a);
  }

  // ---- SRAM ------------------------------------------------------------------
  _sramIndex(a) {
    const off = a - this.sramStart;
    return this.sramWidth === 'both' ? off : (off >> 1);
  }

  _sramRead(a) {
    if (this.sramWidth === 'odd' && !(a & 1)) return 0xff;
    if (this.sramWidth === 'even' && (a & 1)) return 0xff;
    const i = this._sramIndex(a);
    return i >= 0 && i < this.sram.length ? this.sram[i] : 0xff;
  }

  _sramWrite(a, v) {
    if (this.sramWidth === 'odd' && !(a & 1)) return;
    if (this.sramWidth === 'even' && (a & 1)) return;
    const i = this._sramIndex(a);
    if (i >= 0 && i < this.sram.length) { this.sram[i] = v; this._sramDirty = true; }
  }

  // Load a save file. Marks the chip dirty so every snapshot from here on
  // carries a copy — the contents are no longer reconstructible from "blank".
  loadSram(bytes) {
    if (!this.sram || !bytes) return this;
    this.sram.set(bytes.subarray(0, this.sram.length));
    this._sramDirty = true;
    return this;
  }

  // ---- VDP ports -------------------------------------------------------------
  _vdpRead(a) {
    switch (a & 0x1f) {
      case 0x00: case 0x02: return this.vdp.readData();
      case 0x04: case 0x06: return this.vdp.readControl();
      case 0x08: case 0x0a: case 0x0c: case 0x0e: return this.vdp.readHV();
      default: return 0xffff;
    }
  }

  _vdpWrite(a, v) {
    switch (a & 0x1f) {
      case 0x00: case 0x02: this.vdp.writeData(v); return;
      case 0x04: case 0x06: this.vdp.writeControl(v); return;
      case 0x10: case 0x12: case 0x14: case 0x16: this.psg.write(v & 0xff); return;
      default: return;
    }
  }

  // ---- Z80 area seen from the 68000 -----------------------------------------
  _z80AreaRead(a) {
    const o = a & 0xffff;
    if (o < 0x4000) return this.z80ram[o & 0x1fff];
    if (o < 0x6000) return this.ym.read(o & 3);
    return 0xff;
  }

  _z80AreaWrite(a, v) {
    const o = a & 0xffff;
    if (o < 0x4000) { this.z80ram[o & 0x1fff] = v; return; }
    if (o < 0x6000) { this.ym.write(o & 3, v); return; }
    if (o === 0x6000 || o === 0x6001) { this._bankShift(v); return; }
    if (o >= 0x7f00 && o <= 0x7f1f) { if ((o & 0x1f) >= 0x11) this.psg.write(v); return; }
  }

  // The Z80's window register is a shift register, not a latch: nine writes of
  // one bit each, LSB first, build the bank number. A driver that writes the
  // bank as a byte gets nonsense, which is why every one of them loops.
  _bankShift(v) {
    this.z80Bank = ((this.z80Bank >> 1) | ((v & 1) << 8)) & 0x1ff;
  }

  // ---- the Z80's own bus -----------------------------------------------------
  _z80Read(a) {
    a &= 0xffff;
    if (a < 0x4000) return this.z80ram[a & 0x1fff];
    if (a < 0x6000) return this.ym.read(a & 3);
    if (a < 0x8000) return 0xff;
    // $8000-$FFFF is a 32 KB window onto the 68000's address space, positioned
    // by the bank register. This is how the sound driver reads its music data
    // out of the cartridge — and how a Z80 can reach the VDP, which a few
    // games do for PSG writes.
    return this._read8(((this.z80Bank << 15) | (a & 0x7fff)) & 0xffffff);
  }

  _z80Write(a, v) {
    a &= 0xffff; v &= 0xff;
    if (a < 0x4000) { this.z80ram[a & 0x1fff] = v; return; }
    if (a < 0x6000) { this.ym.write(a & 3, v); return; }
    if (a < 0x6100) { this._bankShift(v); return; }
    if (a >= 0x7f00 && a <= 0x7f1f) { if ((a & 0x1f) >= 0x11) this.psg.write(v); return; }
    if (a < 0x8000) return;
    this._write8(((this.z80Bank << 15) | (a & 0x7fff)) & 0xffffff, v);
  }

  _setZ80BusReq(on) {
    this.z80BusReq = on;
  }

  _setZ80Reset(assert) {
    if (assert && !this.z80Reset) {
      // Resetting the Z80 also silences the FM chip on real hardware, because
      // the reset line is shared. Drivers rely on it to stop a stuck note.
      this.z80.reset();
      this.z80Bank = 0;
    }
    this.z80Reset = assert;
  }

  get z80Running() { return !this.z80BusReq && !this.z80Reset; }

  // ---- controller I/O --------------------------------------------------------
  // $A10001 is the version register. Bit 7 says overseas, bit 6 says PAL, bit
  // 5 says no expansion is connected, and the low nibble is the hardware
  // revision — 0, i.e. a Model 1 with no TMSS, which is the machine with the
  // fewest ways to refuse a cartridge.
  _versionByte() {
    let v = 0x20;
    if (this.region !== 'japan') v |= 0x80;
    if (this.pal) v |= 0x40;
    return v;
  }

  _ioRead(a) {
    const o = a & 0x1f;
    if (o === 0x01) return this._versionByte();
    if (o === 0x03 || o === 0x05 || o === 0x07) return this._padRead((o - 3) >> 1);
    if (o === 0x09 || o === 0x0b || o === 0x0d) return this.ioCtrl[(o - 9) >> 1];
    return 0x00;
  }

  _ioWrite(a, v) {
    const o = a & 0x1f;
    if (o === 0x03 || o === 0x05 || o === 0x07) { this.ioData[(o - 3) >> 1] = v; return; }
    if (o === 0x09 || o === 0x0b || o === 0x0d) { this.ioCtrl[(o - 9) >> 1] = v; return; }
  }

  // A 3-button pad is a 74HC157 multiplexer: TH picks which six of the eight
  // buttons appear on the six data lines. Buttons are active LOW, and the
  // game drives TH low, reads, drives it high, reads again.
  _padRead(port) {
    const ctrl = this.ioCtrl[port];
    const out = this.ioData[port];
    // A line the game has not configured as an output floats high, and TH
    // floating high is the "C/B/right/left/down/up" half.
    const th = (ctrl & 0x40) ? (out & 0x40) : 0x40;
    const p = this.pads[port];
    const bit = (b) => ((p >> b) & 1) ? 0 : 1; // pressed = 0
    let v;
    if (th) {
      v = 0x40 | (bit(BUTTON.C) << 5) | (bit(BUTTON.B) << 4)
        | (bit(BUTTON.RIGHT) << 3) | (bit(BUTTON.LEFT) << 2)
        | (bit(BUTTON.DOWN) << 1) | bit(BUTTON.UP);
    } else {
      v = (bit(BUTTON.START) << 5) | (bit(BUTTON.A) << 4)
        | (bit(BUTTON.DOWN) << 1) | bit(BUTTON.UP);
    }
    // Bits the game has configured as outputs read back what it wrote.
    return ((out & ctrl) | (v & ~ctrl)) & 0xff;
  }

  padDown(bit, port = 0) { this.pads[port] |= (1 << bit); return this; }
  padUp(bit, port = 0) { this.pads[port] &= ~(1 << bit); return this; }
  setPad(mask, port = 0) { this.pads[port] = mask & 0xff; return this; }

  // ---- run -------------------------------------------------------------------
  stepFrame() {
    const lines = this.linesPerFrame;
    const activeLines = this.vdp.screenHeight;
    for (let line = 0; line < lines; line++) {
      this.line = line;
      this.vdp.beginLine(line);
      if (line === activeLines) {
        // The vertical interrupt reaches the Z80 too, as a single INT pulse
        // one scanline long. A driver with interrupts disabled misses it, so
        // the request is retried across the line rather than fired once.
        this._z80IntPending = true;
      }
      this.vdp.hblank = false;
      this._runMclk(MCLK_ACTIVE);
      this.vdp.renderLine(line);
      this.vdp.hblank = true;
      this._runMclk(MCLK_PER_LINE - MCLK_ACTIVE);
      this._z80IntPending = false;
    }
    this.vdp.endFrame();
    this.frame++;
    return this;
  }

  // Advance every clocked part by `mclk` master clocks, in slices small enough
  // that a Z80 write to the FM chip lands between two 68000 instructions rather
  // than a whole scanline later.
  _runMclk(mclk) {
    let left = mclk;
    while (left > 0) {
      const slice = left < SLICE_MCLK ? left : SLICE_MCLK;
      left -= slice;
      // The VDP's H counter is read by software to find its position inside a
      // scanline, so it has to know how far along the line the machine is.
      this.vdp.lineMclk += slice;
      // A DMA steals bus slots for as long as it takes; while a 68000-side one
      // is running the CPU has no bus at all, and its time is simply not
      // credited. Long transfers therefore span scanlines and the picture gets
      // drawn in between, which is what direct colour DMA is built on.
      if (this.vdp.dma.active) this.vdp.runDma(slice);
      if (!this.vdp.dmaHoldsBus) this._run68k(slice);
      this._runZ80(slice);
      this._ymAcc += slice;
      if (this._ymAcc >= YM_MCLK_PER_TICK) {
        const ticks = (this._ymAcc / YM_MCLK_PER_TICK) | 0;
        this._ymAcc -= ticks * YM_MCLK_PER_TICK;
        this.ym.tickTimers(ticks);
      }
    }
  }

  _run68k(mclk) {
    this._m68kDebt += mclk;
    const cpu = this.cpu;
    while (this._m68kDebt > 0) {
      // A double bus fault halts the chip until reset; without this the loop
      // would spin forever on a broken ROM.
      if (cpu.halted) { this._m68kDebt = 0; return; }
      const lvl = this.vdp.irqLevel();
      if (lvl !== this._irqLevel) { cpu.setIRQ(lvl); this._irqLevel = lvl; }
      this._m68kDebt -= cpu.step() * M68K_DIV;
      // A write inside that instruction may have started a DMA. Stop here and
      // let the caller step the transfer rather than running the CPU on
      // through a bus it no longer owns.
      if (this.vdp.dmaHoldsBus) return;
    }
  }

  _runZ80(mclk) {
    if (!this.z80Running) { this._z80Debt = 0; return; }
    this._z80Debt += mclk;
    const z = this.z80;
    while (this._z80Debt > 0) {
      if (this._z80IntPending) {
        const t = z.intRequest(0xff);
        if (t > 0) { this._z80IntPending = false; this._z80Debt -= t * Z80_DIV; continue; }
        this._z80IntPending = false; // interrupts are off; the pulse is lost
      }
      this._z80Debt -= z.step() * Z80_DIV;
    }
  }

  // Same shape as machine88.js and machinenes.js: accumulate real time and
  // emit whole frames.
  update(dt, onFrame = null) {
    this._acc += dt;
    const period = 1 / this.frameHz;
    while (this._acc >= period) { this._acc -= period; this.stepFrame(); if (onFrame) onFrame(); }
    return this;
  }

  // ---- video / audio ---------------------------------------------------------
  render(opts = {}) { return this.vdp.render(opts); }

  // Mono, because that is what the demo's audio path takes. The stereo pair is
  // available directly from ym2612.render() for anyone who wants it.
  renderAudio(out, n = out.length) {
    this.ym.renderMono(out, n);
    this.psg.renderAdd(out, n, 0.35);
    for (let i = 0; i < n; i++) {
      const v = out[i];
      out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
    return out;
  }

  // ---- time travel -----------------------------------------------------------
  // Mutable state only. The cartridge stays where it is — 512 KB to 4 MB of it
  // — and the VDP's frame buffer is output rather than state. What is left is
  // 64 KB of work RAM, 64 KB of VRAM, 8 KB of Z80 RAM and the chips'
  // registers: about 140 KB per snapshot, which is what sets how far back the
  // host's ring can reach. Measured numbers are in docs/md-design.md.
  snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      cpu: this.cpu.snapshot(),
      z80: this.z80.getState(),
      ram: this.ram.slice(),
      z80ram: this.z80ram.slice(),
      vdp: this.vdp.getState(),
      ym: this.ym.getState(),
      psg: this.psg.getState(),
      // Backup RAM is copied only once something has written to it. Plenty of
      // cartridges declare a 32 KB save chip and never touch it during play,
      // and 32 KB of zeroes per rewind slot is a fifth of the ring spent on
      // nothing. `sramDirty` is monotonic (it never goes back to false), so a
      // snapshot without a copy is unambiguously "the save chip was still
      // blank here" and restoring it clears the chip.
      sram: this._sramDirty ? this.sram.slice() : null,
      sramDirty: this._sramDirty,
      sramEnabled: this.sramEnabled,
      pads: this.pads.slice(),
      ioData: this.ioData.slice(),
      ioCtrl: this.ioCtrl.slice(),
      z80BusReq: this.z80BusReq, z80Reset: this.z80Reset, z80Bank: this.z80Bank,
      z80IntPending: this._z80IntPending,
      m68kDebt: this._m68kDebt, z80Debt: this._z80Debt,
      ymAcc: this._ymAcc, irqLevel: this._irqLevel,
      line: this.line, frame: this.frame, acc: this._acc,
    };
  }

  restore(s) {
    this.cpu.restore(s.cpu);
    this.z80.setState(s.z80);
    this.ram.set(s.ram);
    this.z80ram.set(s.z80ram);
    this.vdp.setState(s.vdp);
    this.ym.setState(s.ym);
    this.psg.setState(s.psg);
    if (this.sram) {
      if (s.sram) this.sram.set(s.sram);
      else this.sram.fill(0);
      this._sramDirty = !!s.sramDirty;
    }
    this.sramEnabled = s.sramEnabled;
    this.pads.set(s.pads);
    this.ioData.set(s.ioData);
    this.ioCtrl.set(s.ioCtrl);
    this.z80BusReq = s.z80BusReq; this.z80Reset = s.z80Reset; this.z80Bank = s.z80Bank;
    this._z80IntPending = s.z80IntPending;
    this._m68kDebt = s.m68kDebt; this._z80Debt = s.z80Debt;
    this._ymAcc = s.ymAcc;
    this._irqLevel = s.irqLevel;
    this.line = s.line; this.frame = s.frame; this._acc = s.acc ?? 0;
    // The interrupt LEVEL is the machine's to drive, not the CPU's to
    // remember: re-assert it so the first instruction after a restore sees the
    // same pins as the first instruction before it.
    this.cpu.setIRQ(this.vdp.irqLevel());
    this._irqLevel = this.vdp.irqLevel();
    return this;
  }
}

export function createMegaDriveMachine(opts) { return new MegaDriveMachine(opts); }
export { MD_YM_CLOCK, MD_PSG_CLOCK };
export default MegaDriveMachine;
