// machinex68 — the Sharp X68000 as a machine, on the same contract as
// Pc8801Machine, NesMachine and MegaDriveMachine: `stepFrame()`, `frame`,
// `snapshot()`, `restore()`, `schemaVersion`. demo/machine.html builds
// fast-forward, rewind and jog-shuttle on that contract and nothing else.
//
// The coordinator closes the loops the parts cannot close themselves. m68000.js
// has never heard of a CRTC; mc68901.js does not know what a scanline is;
// hd63450.js moves bytes between two addresses it is handed. This file is
// where they meet, and it is also where the X68000's one genuinely awkward
// fact lives: the machine boots out of a ROM that is not at address zero.
//
// ## Reset
//
// The 68000 fetches SSP from $000000 and PC from $000004, but the X68000 has
// RAM there and the IPL ROM at $FE0000-$FFFFFF. The address decoder therefore
// puts the ROM's last 64 KB over the bottom of the map until the machine
// clears the overlay, and the third instruction the IPL executes is RESET:
//
//     FF0010  MOVE #$2700,SR
//     FF0014  LEA  $2000.L,A7
//     FF0016  RESET            <- the overlay goes away here
//
// So `resetLine()` drops it. Nothing has touched low memory by then, and a
// later RESET (Human68k issues one) simply finds the overlay already gone.
//
// ## Memory
//
// RAM is 1 to 12 MB and reads above the installed amount are bus errors,
// which is how software sizes the machine. The default here is 2 MB, and the
// reason is the rewind ring rather than any hardware fact: a snapshot carries
// the RAM, and 12 MB per frame would give a rewind buffer measured in seconds
// per gigabyte. docs/x68000-design.md has the measurements and the argument.
//
// Deterministic: no Math.random, no Date.now. The real-time clock counts from
// a fixed epoch supplied at construction, because a machine whose clock reads
// the host's would replay differently every time and rewind is replay.

import { M68000, BusError } from './m68000.js';
import { Mc68901, SRC, REG as MFP_REG } from './mc68901.js';
import { Hd63450 } from './hd63450.js';
import { X68Crtc } from './x68crtc.js';
import { X68Video } from './x68video.js';
import { X68Fdd } from './x68fdd.js';
import { Ym2151 } from './ym2151.js';
import { Msm6258 } from './msm6258.js';

export const SCHEMA_VERSION = 1;

export const CPU_HZ = 10000000;      // 68000 at 10 MHz on the original model
export const OPM_HZ = 4000000;       // YM2151, half the 8 MHz crystal
// 1 MB — the stock ACE/EXPERT's memory, and the size that keeps a snapshot
// small enough for a useful rewind ring. docs/x68000-design.md argues it.
const RAM_DEFAULT = 0x100000;
const IPL_SIZE = 0x20000;            // 128 KB
const ROM_WINDOW = 0x40000;          // $FC0000-$FFFFFF, the IPL mirrored low
const CGROM_SIZE = 0xc0000;          // 768 KB

// Interrupt levels, highest first. The MFP is the machine's clock and its
// keyboard; the DMAC finishes transfers; the I/O controller speaks for the
// floppy drives.
const IRQ_MFP = 6;
const IRQ_DMA = 3;
const IRQ_IOC = 1;

// The X68000 keyboard is a serial device: one byte per key, bit 7 set on
// release. These are the make codes the IOCS expects.
export const KEY = Object.freeze({
  ESC: 0x01, ONE: 0x02, TWO: 0x03, THREE: 0x04, FOUR: 0x05, FIVE: 0x06,
  SIX: 0x07, SEVEN: 0x08, EIGHT: 0x09, NINE: 0x0a, ZERO: 0x0b,
  Q: 0x11, W: 0x12, E: 0x13, R: 0x14, T: 0x15, Y: 0x16, U: 0x17, I: 0x18,
  O: 0x19, P: 0x1a, RETURN: 0x1d,
  A: 0x1e, S: 0x1f, D: 0x20, F: 0x21, G: 0x22, H: 0x23, J: 0x24, K: 0x25, L: 0x26,
  Z: 0x2a, X: 0x2b, C: 0x2c, V: 0x2d, B: 0x2e, N: 0x2f, M: 0x30,
  SPACE: 0x35, BS: 0x0f, TAB: 0x10,
  UP: 0x3c, LEFT: 0x3b, RIGHT: 0x3d, DOWN: 0x3e,
  SHIFT: 0x70, CTRL: 0x71, OPT1: 0x72, OPT2: 0x73,
});

// A joystick port reads active LOW; bit 5/6 are the two buttons.
export const JOY = Object.freeze({ UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 5, B: 6 });

export class X68000Machine {
  constructor({
    ipl = null, cgrom = null, sram = null,
    ram = RAM_DEFAULT, sampleRate = 48000,
    epoch = Date.UTC(1990, 0, 1, 0, 0, 0),
  } = {}) {
    if (!ipl) throw new Error('X68000Machine needs an IPL ROM (128 KB)');
    this.schemaVersion = SCHEMA_VERSION;

    // $FC0000-$FFFFFF. On a SASI machine the SCSI window mirrors the IPL, so
    // one 256 KB array covers the whole ROM area and a stray fetch from
    // $FC0000 lands somewhere sane instead of on a bus error.
    this.rom = new Uint8Array(ROM_WINDOW);
    const src = ipl.length >= IPL_SIZE ? ipl.subarray(ipl.length - IPL_SIZE) : ipl;
    this.rom.set(src, ROM_WINDOW - IPL_SIZE);
    this.rom.set(src, 0);

    this.cgrom = new Uint8Array(CGROM_SIZE);
    if (cgrom) this.cgrom.set(cgrom.subarray(0, CGROM_SIZE));

    this.ramSize = Math.max(0x100000, Math.min(0xc00000, ram | 0));
    this.ram = new Uint8Array(this.ramSize);

    // 16 KB of battery-backed setup. If the caller has none, build one the
    // IPL will accept rather than making it initialise a blank chip on every
    // boot (which it does by asking a keyboard nobody is holding).
    this.sram = new Uint8Array(0x4000);
    if (sram) this.sram.set(sram.subarray(0, 0x4000));
    else this._defaultSram();
    this.sramWriteEnable = false;

    this.epoch = epoch;
    this.frame = 0;
    this._acc = 0;

    this.crtc = new X68Crtc({
      onRasterCopy: (s, d, planes) => this.video.rasterCopy(s, d, planes),
      onFastClear: (mask) => this.video.fastClear(mask),
    });
    this.video = new X68Video({ crtc: this.crtc });
    this.mfp = new Mc68901();
    this.fdd = new X68Fdd();
    this.opm = new Ym2151({ clockHz: OPM_HZ, sampleRate });
    // The OPM's interrupt is not wired to the 68000 directly: it is GPIP3 on
    // the MFP, an ordinary edge like the sync signals. And its two spare
    // output pins are wired to other chips entirely — CT1 forces the floppy
    // controller ready, CT2 halves the ADPCM's crystal.
    this.opm.onIrq = () => this.mfp.request(SRC.GPIP3);
    this.opm.onCtrl = (ct1, ct2) => { this.fdcForceReady = ct1 !== 0; this.adpcm.setBaseClock(ct2); };
    this.adpcm = new Msm6258({ sampleRate, cpuHz: CPU_HZ });

    // The bus the DMAC drives. It is the same map the CPU sees minus the
    // exception behaviour: a DMA that faults reports through CER, it does not
    // throw at the 68000.
    const dmaBus = {
      read8: (a) => this._read8(a), write8: (a, v) => this._write8(a, v),
      read16: (a) => this._read16(a), write16: (a, v) => this._write16(a, v),
      read32: (a) => ((this._read16(a) << 16) | this._read16(a + 2)) >>> 0,
      write32: (a, v) => { this._write16(a, (v >>> 16) & 0xffff); this._write16(a + 2, v & 0xffff); },
    };
    this.dmac = new Hd63450({
      bus: dmaBus,
      deviceReady: (ch) => (ch === 0 ? this.fdd.dataReady : ch === 3 ? this.adpcm.wantsData : false),
    });

    this.cpu = new M68000({
      read16: (a) => this._read16(a),
      write16: (a, v) => this._write16(a, v),
      // Byte accessors are given explicitly rather than synthesised: half this
      // map is registers where a read has a side effect (the MFP's UDR, the
      // FDC's data port), and the synthesised path in m68000.js does a
      // read-modify-write.
      read8: (a) => this._read8(a),
      write8: (a, v) => this._write8(a, v),
      irqAck: (level) => this._irqAck(level),
      resetLine: () => { this.bootOverlay = false; },
    });

    // System port $E8E000. Index 1 is the contrast, 5 is the SRAM write
    // enable ($31 unlocks it), 6 is the model byte.
    this.sysport = new Uint8Array(8);
    this.ioc = { stat: 0, vect: 0 };
    this.ppi = { portA: 0xff, portB: 0xff, portC: 0x0b, ctrl: 0 };
    this.joy = [0, 0];         // pressed-bit masks, translated on read
    this.keyQueue = [];
    this.rtcReg = [new Uint8Array(16), new Uint8Array(16)];

    this.powerOn();
  }

  // The IPL does not decide what the machine looks like — the SRAM does. The
  // screen mode, the text colours, the boot device, the key repeat rate and
  // the amount of memory all come from here, and a blank chip makes the ROM
  // stop and ask a human to fill it in. Worse for a headless run: without the
  // screen-mode fields it never programs the CRTC at all, so a machine that
  // is otherwise booting fine shows nothing.
  //
  // These are the factory defaults, byte for byte, with the memory size
  // patched to whatever this machine actually has. They are the last thing
  // the emulator invented for itself and the first thing a user can override
  // by supplying a real sram.dat.
  _defaultSram() {
    const s = this.sram;
    s.fill(0);
    const factory = [
      0x82, 0x77, 0x36, 0x38, 0x30, 0x30, 0x30, 0x57, // 'Ｘ68000W', the magic
      0x00, 0x10, 0x00, 0x00,   // $08 memory size (patched below)
      0x00, 0xbf, 0xff, 0xfc,   // $0C initial stack pointer
      0x00, 0xed, 0x01, 0x00,   // $10 where an SRAM-resident program starts
      0xff, 0xff, 0xff, 0xff,   // $14
      0x00, 0x00, 0x4e, 0x07,   // $18 boot device (0 = the standard search)
      0x00, 0x10, 0x00, 0x00,   // $1C memory size again (patched below)
      0x00, 0x00, 0xff, 0xff,   // $20
      0x00, 0x00, 0x07, 0x00,   // $24
      0x0e, 0x00, 0x0d, 0x00,   // $28 screen mode and text colours
      0x00, 0x00, 0x00, 0x00,   // $2C
      0xf8, 0x3e, 0xff, 0xc0,   // $30
      0xff, 0xfe, 0xde, 0x6c,   // $34
      0x40, 0x22, 0x03, 0x02,   // $38 key repeat
      0x00, 0x08, 0x00, 0x00,   // $3C
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0xff, 0xdc, 0x00, 0x04, 0x00, 0x01, 0x01,
      0x00, 0x00, 0x00, 0x20, 0x00, 0x09, 0xf9, 0x01,
      0x00, 0x00, 0x01, 0x00,
    ];
    s.set(factory, 0);
    const put32 = (o, v) => { s[o] = (v >>> 24) & 0xff; s[o + 1] = (v >>> 16) & 0xff; s[o + 2] = (v >>> 8) & 0xff; s[o + 3] = v & 0xff; };
    put32(0x08, this.ramSize);
    put32(0x1c, this.ramSize);
  }

  powerOn() {
    this.ram.fill(0);
    this.video.powerOn();
    this.frame = 0;
    this._acc = 0;
    return this.reset();
  }

  reset() {
    // The ROM answers at address zero until the IPL's RESET instruction, which
    // is what makes the reset vector fetch find anything at all.
    this.bootOverlay = true;
    this.line = 0;
    this._cycleDebt = 0;
    this._halfCycles = 0;
    this._irqLevel = -1;
    this._keyDivider = 0;
    this._fdcByteCredit = 0;
    this._opmCycles = 0;

    this.crtc.reset();
    this.mfp.reset();
    this.dmac.reset();
    this.fdd.reset();
    this.opm.reset();
    this.adpcm.reset();
    this.video.reset();
    this.sysport.fill(0);
    this.sysport[1] = 0x0f;   // full contrast; a dark screen is a support call
    this.ioc.stat = 0; this.ioc.vect = 0;
    this.keyQueue.length = 0;
    this.cpu.reset();
    return this;
  }

  // ---- disks -----------------------------------------------------------------
  insertDisk(unit, disk) { this.fdd.insert(unit, disk); return this; }
  ejectDisk(unit) { this.fdd.eject(unit); return this; }

  // ---- the 68000 bus ----------------------------------------------------------
  // $000000-$BFFFFF  RAM (bus error above the installed size)
  // $C00000-$DFFFFF  graphics VRAM
  // $E00000-$E7FFFF  text VRAM
  // $E80000-$E9FFFF  the I/O block, 8 KB per device
  // $EB0000-$EBFFFF  sprite controller, PCG and the two BG planes
  // $ED0000-$EDFFFF  SRAM (16 KB, mirrored)
  // $F00000-$FBFFFF  CGROM
  // $FC0000-$FFFFFF  IPL ROM
  _read8(a) {
    a &= 0xffffff;
    if (a < 0xc00000) {
      if (this.bootOverlay && a < 0x10000) return this.rom[ROM_WINDOW - 0x10000 + a];
      if (a < this.ramSize) return this.ram[a];
      throw new BusError(a, false);
    }
    if (a < 0xe00000) return this.video.readGvram8(a);
    if (a < 0xe80000) return this.video.readText8(a);
    if (a < 0xea0000) return this._readIo8(a);
    if (a < 0xeb0000) throw new BusError(a, false);
    if (a < 0xec0000) return this.video.readSprite8(a);
    if (a < 0xed0000) throw new BusError(a, false);
    if (a < 0xee0000) return this.sram[a & 0x3fff];
    if (a < 0xf00000) throw new BusError(a, false);
    if (a < 0xfc0000) return this.cgrom[(a - 0xf00000) % CGROM_SIZE];
    return this.rom[a - 0xfc0000];
  }

  _write8(a, v) {
    a &= 0xffffff; v &= 0xff;
    if (a < 0xc00000) {
      if (a < this.ramSize) { this.ram[a] = v; return; }
      throw new BusError(a, true);
    }
    if (a < 0xe00000) { this.video.writeGvram8(a, v); return; }
    if (a < 0xe80000) { this.video.writeText8(a, v); return; }
    if (a < 0xea0000) { this._writeIo8(a, v); return; }
    if (a < 0xeb0000) throw new BusError(a, true);
    if (a < 0xec0000) { this.video.writeSprite8(a, v); return; }
    if (a < 0xed0000) throw new BusError(a, true);
    if (a < 0xee0000) {
      // The SRAM is protected by a latch in the system port. Writing to it
      // without unlocking is silently dropped, which is what stops a crashed
      // program from taking the machine's setup with it.
      if (this.sramWriteEnable) this.sram[a & 0x3fff] = v;
      return;
    }
    throw new BusError(a, true);
  }

  _read16(a) {
    a &= 0xfffffe;
    if (a < 0xc00000) {
      if (this.bootOverlay && a < 0x10000) {
        const o = ROM_WINDOW - 0x10000 + a;
        return (this.rom[o] << 8) | this.rom[o + 1];
      }
      if (a + 1 < this.ramSize) return (this.ram[a] << 8) | this.ram[a + 1];
      throw new BusError(a, false);
    }
    if (a < 0xe00000) return this.video.readGvram16(a);
    if (a < 0xe80000) return this.video.readText16(a);
    // A word access to the I/O block is two byte accesses, high half first.
    // Some of what lives here really is sixteen bits wide (the CRTC's
    // registers, the palette, the DMAC's counters) and some is an 8-bit part
    // strapped to the odd half of the bus (the MFP, the FDC), which simply
    // ignores the even byte. Splitting serves both; treating the block as
    // uniformly 8-bit loses the high half of every CRTC register.
    if (a < 0xea0000) return (this._readIo8(a) << 8) | this._readIo8(a + 1);
    if (a < 0xeb0000) throw new BusError(a, false);
    if (a < 0xec0000) return this.video.readSprite16(a);
    if (a < 0xed0000) throw new BusError(a, false);
    if (a < 0xee0000) { const o = a & 0x3ffe; return (this.sram[o] << 8) | this.sram[o + 1]; }
    if (a < 0xf00000) throw new BusError(a, false);
    if (a < 0xfc0000) { const o = (a - 0xf00000) % CGROM_SIZE; return (this.cgrom[o] << 8) | this.cgrom[o + 1]; }
    const o = a - 0xfc0000;
    return (this.rom[o] << 8) | this.rom[o + 1];
  }

  _write16(a, v) {
    a &= 0xfffffe; v &= 0xffff;
    if (a < 0xc00000) {
      if (a + 1 < this.ramSize) { this.ram[a] = v >> 8; this.ram[a + 1] = v & 0xff; return; }
      throw new BusError(a, true);
    }
    if (a < 0xe00000) { this.video.writeGvram16(a, v); return; }
    if (a < 0xe80000) { this.video.writeText16(a, v); return; }
    if (a < 0xea0000) { this._writeIo8(a, (v >> 8) & 0xff); this._writeIo8(a + 1, v & 0xff); return; }
    if (a < 0xeb0000) throw new BusError(a, true);
    if (a < 0xec0000) { this.video.writeSprite16(a, v); return; }
    if (a < 0xed0000) throw new BusError(a, true);
    if (a < 0xee0000) {
      if (this.sramWriteEnable) { const o = a & 0x3ffe; this.sram[o] = v >> 8; this.sram[o + 1] = v & 0xff; }
      return;
    }
    throw new BusError(a, true);
  }

  // ---- the I/O block -----------------------------------------------------------
  _readIo8(a) {
    switch ((a >> 13) & 0x0f) {
      case 0x00: return this.crtc.read(a);                       // $E80000
      case 0x01: return this.video.readCtrl8(a);                 // $E82000
      case 0x02: return this.dmac.read(a - 0xe84000);            // $E84000
      case 0x03: return 0x00;                                    // $E86000 area set
      case 0x04: return this.mfp.read(a);                        // $E88000
      case 0x05: return this._rtcRead(a);                        // $E8A000
      case 0x06: return 0x00;                                    // $E8C000 printer
      case 0x07: return this._sysportRead(a);                    // $E8E000
      case 0x08: return (a & 3) === 3 ? this.opm.readStatus() : 0x00; // $E90000
      case 0x09: return this.adpcm.read(a);                      // $E92000
      case 0x0a: return this.fdd.read(a);                        // $E94000
      case 0x0b: return 0x00;                                    // $E96000 SASI
      case 0x0c: return 0xff;                                    // $E98000 SCC
      case 0x0d: return this._ppiRead(a);                        // $E9A000
      case 0x0e: return (a & 0x1f) === 1 ? this.ioc.stat : 0xff;  // $E9C000
      default: return 0xff;
    }
  }

  _writeIo8(a, v) {
    switch ((a >> 13) & 0x0f) {
      case 0x00: this.crtc.write(a, v); return;
      case 0x01: this.video.writeCtrl8(a, v); return;
      case 0x02: this.dmac.write(a - 0xe84000, v); return;
      case 0x03: return;
      case 0x04: this.mfp.write(a, v); return;
      case 0x05: this._rtcWrite(a, v); return;
      case 0x06: return;
      case 0x07: this._sysportWrite(a, v); return;
      case 0x08: {
        // Two ports: the address latch and the data. Writing the data is what
        // commits, and the chip is busy for a while afterwards — see ym2151.js.
        const t = a & 3;
        if (t === 1) this.opm.writeAddress(v);
        else if (t === 3) this.opm.writeData(v);
        return;
      }
      case 0x09: this.adpcm.write(a, v); return;
      case 0x0a: this.fdd.write(a, v); return;
      case 0x0b: return;
      case 0x0c: return;
      case 0x0d: this._ppiWrite(a, v); return;
      case 0x0e:
        if ((a & 0x1f) === 1) { this.ioc.stat = (this.ioc.stat & 0xf0) | (v & 0x0f); return; }
        if ((a & 0x1f) === 3) { this.ioc.vect = v & 0xfc; return; }
        return;
      default: return;
    }
  }

  _sysportRead(a) {
    switch (a & 0x0f) {
      case 0x01: return this.sysport[1] & 0x0f;   // contrast
      case 0x03: return this.sysport[2] & 0x0f;   // display control / 3D scope
      case 0x05: return this.sysport[3] & 0x1f;   // keyboard and NMI enables
      case 0x07: return this.sysport[4] & 0x0f;
      case 0x0b: return 0xff;                     // 10 MHz. An XVI reads $FE.
      case 0x0d: return this.sysport[5];          // the SRAM write latch
      case 0x0f: return this.sysport[6] & 0x0f;
      default: return 0xff;
    }
  }

  _sysportWrite(a, v) {
    switch (a & 0x0f) {
      case 0x01: this.sysport[1] = v & 0x0f; this.video.setContrast(v & 0x0f); return;
      case 0x03: this.sysport[2] = v & 0x0b; return;
      case 0x05: this.sysport[3] = v & 0x1f; return;
      case 0x07: this.sysport[4] = v & 0x0e; return;
      case 0x0d:
        this.sysport[5] = v;
        // $31 and nothing else. Any other value re-locks the chip.
        this.sramWriteEnable = (v === 0x31);
        return;
      case 0x0f: this.sysport[6] = v & 0x0f; return;
      default: return;
    }
  }

  // The RP5C15 keeps the time in BCD nibbles, one per register. Reading the
  // host's clock here would make every replay different, so time runs from a
  // fixed epoch plus the number of frames that have actually been stepped.
  _rtcNow() {
    const ms = this.epoch + Math.floor((this.frame * 1000) / 60);
    const d = new Date(ms);
    return {
      sec: d.getUTCSeconds(), min: d.getUTCMinutes(), hour: d.getUTCHours(),
      wday: d.getUTCDay(), mday: d.getUTCDate(), mon: d.getUTCMonth() + 1,
      year: (d.getUTCFullYear() - 1980) % 100,
    };
  }

  _rtcRead(a) {
    if (!(a & 1)) return 0;
    const o = a & 0x1f;
    const t = this._rtcNow();
    switch (o) {
      case 0x01: return t.sec % 10;
      case 0x03: return (t.sec / 10) | 0;
      case 0x05: return t.min % 10;
      case 0x07: return (t.min / 10) | 0;
      case 0x09: return t.hour % 10;
      case 0x0b: return (t.hour / 10) | 0;
      case 0x0d: return t.wday;
      case 0x0f: return t.mday % 10;
      case 0x11: return (t.mday / 10) | 0;
      case 0x13: return t.mon % 10;
      case 0x15: return (t.mon / 10) | 0;
      case 0x17: return t.year % 10;
      case 0x19: return ((t.year / 10) | 0) & 0x0f;
      case 0x1b: return this.rtcReg[0][13];
      case 0x1d: return this.rtcReg[0][14];
      case 0x1f: return this.rtcReg[0][15];
      default: return 0;
    }
  }

  _rtcWrite(a, v) {
    const o = a & 0x1f;
    if (o === 0x1b) { this.rtcReg[0][13] = this.rtcReg[1][13] = v & 0x0c; return; }
    if (o === 0x1f) { this.rtcReg[0][15] = this.rtcReg[1][15] = v & 0x0c; return; }
  }

  // The 8255 carries the two joystick ports and, on port C, the ADPCM's clock
  // divider and pan. A joystick line reads LOW when pressed and the port C
  // bits gate which half of a six-button pad is visible.
  _ppiRead(a) {
    switch (a & 7) {
      case 1: return this._joyRead(0);
      case 3: return this._joyRead(1);
      case 5: return this.ppi.portC;
      default: return 0xff;
    }
  }

  _joyRead(port) {
    const p = this.joy[port] & 0xff;
    return (~p) & 0xff;
  }

  _ppiWrite(a, v) {
    switch (a & 7) {
      case 5: {
        const old = this.ppi.portC;
        this.ppi.portC = v;
        if ((old & 0x0f) !== (v & 0x0f)) this.adpcm.setPortC(v & 0x0f);
        return;
      }
      case 7: {
        // The control port's bit-set/reset command: bit 7 clear means "set or
        // clear one bit of port C", which is how the ADPCM driver changes the
        // sample rate without disturbing the joystick lines.
        if (!(v & 0x80)) {
          const bit = (v >> 1) & 7;
          const old = this.ppi.portC;
          if (v & 1) this.ppi.portC |= (1 << bit); else this.ppi.portC &= ~(1 << bit);
          if ((old & 0x0f) !== (this.ppi.portC & 0x0f)) this.adpcm.setPortC(this.ppi.portC & 0x0f);
        } else {
          this.ppi.ctrl = v;
        }
        return;
      }
      default: return;
    }
  }

  // ---- interrupts ---------------------------------------------------------------
  _pendingLevel() {
    if (this.mfp.intPending) return IRQ_MFP;
    if (this.dmac.intPending) return IRQ_DMA;
    if ((this.ioc.stat & 0x80) && (this.ioc.stat & 0x04)) return IRQ_IOC;
    return 0;
  }

  _irqAck(level) {
    if (level === IRQ_MFP) return this.mfp.ack();
    if (level === IRQ_DMA) return this.dmac.ack();
    if (level === IRQ_IOC) {
      // The I/O controller supplies a base vector and each source adds its own
      // index: the FDC is +0 and a disk swap is +1.
      this.ioc.stat &= ~0x80;
      return this.ioc.vect;
    }
    return -1;
  }

  // ---- input ---------------------------------------------------------------------
  // The keyboard is a 2400 baud serial link, so bytes arrive at the receiver a
  // few per frame rather than all at once. Queueing them keeps that true even
  // when the host delivers a burst.
  keyDown(code) { this.keyQueue.push(code & 0x7f); return this; }
  keyUp(code) { this.keyQueue.push((code & 0x7f) | 0x80); return this; }
  joyDown(bit, port = 0) { this.joy[port] |= (1 << bit); return this; }
  joyUp(bit, port = 0) { this.joy[port] &= ~(1 << bit); return this; }
  setJoy(mask, port = 0) { this.joy[port] = mask & 0xff; return this; }

  // ---- run -------------------------------------------------------------------------
  stepFrame() {
    const crtc = this.crtc;
    const lines = crtc.vTotal;
    const perLine = crtc.clocksPerLine;
    // The horizontal sync pulse, as a fraction of the line. Programs poll the
    // MFP's GPIP7 to find it, so it has to have a width.
    const syncClocks = crtc.hTotal > 0
      ? Math.max(1, Math.min(perLine - 1, ((perLine * crtc.hSyncEnd) / crtc.hTotal) | 0))
      : Math.max(1, perLine >> 3);

    this.video.beginFrame();
    for (let vline = 0; vline < lines; vline++) {
      this.line = vline;
      this._lineEdges(vline);
      this._run(syncClocks);
      // Sync over: the pin goes back high, which is the other edge.
      this.mfp.setGpip(0x80, true);
      this._run(perLine - syncClocks);

      // Timer A in event-count mode counts the display period, and the raster
      // interrupt with AER set fires at the END of its line — both belong here,
      // after the line's worth of CPU time, not before it.
      if (this.mfp.timerAEventMode) {
        const aer = this.mfp.reg[MFP_REG.AER];
        const countLine = (aer & 0x10) ? crtc.vStart
          : (crtc.vEnd >= lines ? crtc.vEnd - lines : lines - 1);
        if (vline === countLine) this.mfp.countEventA();
      }
      // How a raster maps to a picture line is the CRTC's vertical step. At
      // 31 kHz with 256 lines two rasters make one line, so only every other
      // raster draws; at 15 kHz with 512 lines one raster makes two.
      const pic = crtc.pictureLine(vline);
      if (pic >= 0) {
        if (crtc.verticalStep === 1) { if (vline & 1) this.video.renderLine(pic, vline); }
        else if (crtc.verticalStep === 4) { this.video.renderLine(pic, vline); this.video.renderLine(pic + 1, vline); }
        else this.video.renderLine(pic, vline);
      }

      // Four keyboard bytes per frame is the real link's throughput.
      if (++this._keyDivider >= (lines >> 2)) {
        this._keyDivider = 0;
        if (!this.mfp.rxFull && this.keyQueue.length) this.mfp.pushRx(this.keyQueue.shift());
      }
    }

    this.video.endFrame();
    crtc.endFrame();
    // A disk that has just been swapped raises the media-change interrupt now,
    // one frame late, the way the drive's ready line actually settles.
    if (this.fdd.tickFrame() && (this.ioc.stat & 0x02)) this.ioc.stat |= 0x80;
    this.frame++;
    return this;
  }

  _lineEdges(vline) {
    const crtc = this.crtc;
    const mfp = this.mfp;
    // GPIP7 low is the sync pulse. GPIP6 low is "this is the interrupt line" —
    // inverted, which is why AER bit 6 clear means the interrupt lands at the
    // START of the line.
    mfp.setGpip(0x80, false);
    mfp.setGpip(0x40, vline !== crtc.intLine);
    // GPIP4 high is the display period. With AER bit 4 set the interrupt is
    // the rising edge (the top of the picture); clear, the falling edge.
    mfp.setGpip(0x10, vline >= crtc.vStart && vline < crtc.vEnd);
  }

  // Advance every clocked part by `clocks` 68000 cycles.
  _run(clocks) {
    this._cycleDebt += clocks;
    const cpu = this.cpu;
    let spent = 0;
    while (this._cycleDebt > 0) {
      if (cpu.halted) { spent += this._cycleDebt; this._cycleDebt = 0; break; }
      const lvl = this._pendingLevel();
      if (lvl !== this._irqLevel) { cpu.setIRQ(lvl); this._irqLevel = lvl; }
      let used;
      try {
        used = cpu.step();
      } catch (e) {
        // A bus error thrown out of the bus callbacks is the CPU's business,
        // not ours; m68000.js converts it into the exception. Anything else is
        // a bug and should not be swallowed.
        if (!(e instanceof BusError)) throw e;
        used = 4;
      }
      this._cycleDebt -= used;
      spent += used;
    }
    this._tickPeripherals(spent);
  }

  _tickPeripherals(cycles) {
    if (cycles <= 0) return;
    // The MFP runs at 4 MHz against the CPU's 10; counting in half CPU cycles
    // makes the 5:2 ratio exact.
    this.mfp.advance(cycles * 2);
    this.opm.advance(cycles);
    this.adpcm.advance(cycles);

    // Channel 0 is the floppy, and it moves at the medium's rate, not the
    // bus's: a 2HD track is 8 KB per 200 ms revolution, which is one byte
    // every 244 CPU cycles. Letting it run flat out would make a sector
    // arrive before the driver has finished setting up the transfer.
    this._fdcByteCredit += cycles;
    let bytes = (this._fdcByteCredit / 244) | 0;
    if (bytes > 0) {
      this._fdcByteCredit -= bytes * 244;
      const before = this.dmac.ch[0].mtc;
      this.dmac.run(0, bytes);
      // The DMAC's DONE line is wired to the controller's TC pin: when the
      // count runs out mid-sector the transfer terminates there rather than
      // running on to the end of the sector.
      if (before && !this.dmac.ch[0].mtc) this.fdd.fdc.tc();
    }
    // The ADPCM chip has no FIFO, so it asks for a byte exactly twice per
    // sample period and the DMAC gets to move exactly that many.
    const pcm = this.adpcm.takeDmaRequests();
    if (pcm) this.dmac.run(3, pcm);
    this.dmac.run(1, 8);
    this.dmac.run(2, 8);

    if (this.fdd.intPending && (this.ioc.stat & 0x04)) this.ioc.stat |= 0x80;
  }

  update(dt, onFrame = null) {
    this._acc += dt;
    const period = this.crtc.clocksPerFrame / CPU_HZ;
    while (this._acc >= period) { this._acc -= period; this.stepFrame(); if (onFrame) onFrame(); }
    return this;
  }

  get frameHz() { return CPU_HZ / this.crtc.clocksPerFrame; }

  // ---- video / audio -----------------------------------------------------------------
  render(opts = {}) { return this.video.render(opts); }

  renderAudio(out, n = out.length) {
    this.opm.renderMono(out, n);
    this.adpcm.renderAdd(out, n, 0.6);
    for (let i = 0; i < n; i++) { const v = out[i]; out[i] = v > 1 ? 1 : v < -1 ? -1 : v; }
    return out;
  }

  // ---- time travel ---------------------------------------------------------------------
  // Mutable state only. The IPL ROM, the CGROM and the mounted disk images stay
  // where they are. What is left is dominated by RAM, and that is why the
  // default machine has 2 MB rather than the 12 MB the hardware allows —
  // docs/x68000-design.md measures both.
  snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      cpu: this.cpu.snapshot(),
      ram: this.ram.slice(),
      sram: this.sram.slice(),
      crtc: this.crtc.getState(),
      video: this.video.getState(),
      mfp: this.mfp.getState(),
      dmac: this.dmac.getState(),
      fdd: this.fdd.getState(),
      opm: this.opm.getState(),
      adpcm: this.adpcm.getState(),
      sysport: Array.from(this.sysport),
      sramWriteEnable: this.sramWriteEnable,
      ioc: { ...this.ioc },
      ppi: { ...this.ppi },
      joy: [...this.joy],
      keyQueue: [...this.keyQueue],
      rtc: [Array.from(this.rtcReg[0]), Array.from(this.rtcReg[1])],
      bootOverlay: this.bootOverlay,
      line: this.line, frame: this.frame, acc: this._acc,
      cycleDebt: this._cycleDebt, irqLevel: this._irqLevel,
      keyDivider: this._keyDivider, fdcByteCredit: this._fdcByteCredit,
    };
  }

  restore(s) {
    this.cpu.restore(s.cpu);
    this.ram.set(s.ram);
    this.sram.set(s.sram);
    this.crtc.setState(s.crtc);
    this.video.setState(s.video);
    this.mfp.setState(s.mfp);
    this.dmac.setState(s.dmac);
    this.fdd.setState(s.fdd);
    this.opm.setState(s.opm);
    this.adpcm.setState(s.adpcm);
    this.sysport.set(s.sysport);
    this.sramWriteEnable = s.sramWriteEnable;
    this.ioc = { ...s.ioc };
    this.ppi = { ...s.ppi };
    this.joy = [...s.joy];
    this.keyQueue = [...s.keyQueue];
    this.rtcReg[0].set(s.rtc[0]); this.rtcReg[1].set(s.rtc[1]);
    this.bootOverlay = s.bootOverlay;
    this.line = s.line; this.frame = s.frame; this._acc = s.acc ?? 0;
    this._cycleDebt = s.cycleDebt; this._irqLevel = s.irqLevel;
    this._keyDivider = s.keyDivider; this._fdcByteCredit = s.fdcByteCredit;
    // The interrupt LEVEL is the machine's to drive, not the CPU's to
    // remember: re-assert it so the first instruction after a restore sees the
    // same pins as the first instruction before it.
    const lvl = this._pendingLevel();
    this.cpu.setIRQ(lvl);
    this._irqLevel = lvl;
    return this;
  }
}

export function createX68000Machine(opts) { return new X68000Machine(opts); }
export { SRC as MFP_SRC };
export default X68000Machine;
