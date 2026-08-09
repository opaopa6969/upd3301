// machinepc98 — the NEC PC-9801 as a machine, on the same contract as
// Pc8801Machine, NesMachine, MegaDriveMachine and X68000Machine:
// `stepFrame()`, `frame`, `snapshot()`, `restore()`, `schemaVersion`.
// demo/machine.html builds fast-forward, rewind and jog-shuttle on that
// contract and nothing else.
//
// This is the coordinator: i8086.js has never heard of a GDC, upd7220.js does
// not know what an interrupt controller is, and i8237.js moves bytes between
// two addresses it is handed. Here they meet, and here the PC-9801's own
// awkward facts live.
//
// ## Two ROMs at the same address
//
// A 9801 powers up executing the ITF — "initial test firmware" — a 32 KB ROM
// mapped over $F8000-$FFFFF. It sizes memory, sets the machine's speed, checks
// the battery-backed settings, and then switches itself out of the map and
// jumps into the real BIOS underneath. The switch is a write to $043D.
//
// Both ROMs are optional here and the machine degrades honestly: with a BIOS
// alone it starts at the BIOS's own reset vector, which is what every
// emulator that ships without an ITF dump does.
//
// ## Memory
//
// An 8086 sees one megabyte and a 9801 uses most of it:
//
//   $00000-$9FFFF  main RAM (640 KB), the whole of user memory
//   $A0000-$A1FFF  text VRAM: character codes, one word per cell
//   $A2000-$A3FFF  text VRAM: attributes, low byte of each word
//   $A4000-$A4FFF  the character generator window
//   $A8000-$AFFFF  graphics plane 0 (blue)
//   $B0000-$B7FFF  graphics plane 1 (red)
//   $B8000-$BFFFF  graphics plane 2 (green)
//   $C0000-$DFFFF  option ROM space (the sound board's BIOS lives at $CC000)
//   $E0000-$E7FFF  graphics plane 3 (intensity) — 16-colour machines only
//   $E8000-$FFFFF  BIOS ROM, with the ITF over its last 32 KB until it leaves
//
// The whole megabyte is RAM as far as a snapshot is concerned except for the
// ROMs, which never travel — 640 KB is already an order of magnitude more than
// a Mega Drive's snapshot, and the rewind ring is a byte budget.
//
// Deterministic: no Math.random, no Date.now. The clock counts from a fixed
// epoch supplied at construction, because a machine whose clock reads the
// host's would replay differently every time and rewind is replay.

import { I8086 } from './i8086.js';
import { Upd7220 } from './upd7220.js';
import { Pc98Video } from './pc98video.js';
import { I8259 } from './i8259.js';
import { I8253 } from './i8253.js';
import { I8237 } from './i8237.js';
import { I8255 } from './i8255.js';
import { Pc98Fdd } from './pc98fdd.js';
import { Ym2203 } from './ym2203.js';

export const SCHEMA_VERSION = 1;

export const CPU_HZ = 7987200;         // a V30 at 8 MHz — the VM/VX generation
export const PIT_HZ = 1996800;         // the 8253's own crystal, CPU_HZ / 4
export const OPN_HZ = 3993600;         // the PC-9801-26K's YM2203

const RAM_SIZE = 0xa0000;              // 640 KB, all an 8086 can use for programs
const BIOS_BASE = 0xe8000;
const BIOS_SIZE = 0x18000;             // 96 KB, $E8000-$FFFFF
const ITF_BASE = 0xf8000;
const ITF_SIZE = 0x8000;               // 32 KB over the BIOS's top

// Interrupt lines. The slave hangs off the master's IRQ7 — not IRQ2, which is
// the PC/AT. Wire it wrong and the floppy never finishes a sector.
const IRQ_TIMER = 0;
const IRQ_KEYBOARD = 1;
const IRQ_VSYNC = 2;
const IRQ_CASCADE = 7;
const IRQ_FDD = 11;                    // the 1 MB interface, on the slave
const IRQ_SOUND = 12;                  // PC-9801-26K's default (INT5)

// The floppy controller's data request goes to DMA channel 2.
const DMA_FDD = 2;

// 400-line mode: 24.83 kHz horizontal, 56.42 Hz vertical. 440 raster lines of
// which 400 are picture.
const LINES = 440;
const ACTIVE_LINES = 400;

// PC-9801 keyboard make codes. Break is the same code with bit 7 set.
export const KEY = Object.freeze({
  ESC: 0x00, ONE: 0x01, TWO: 0x02, THREE: 0x03, FOUR: 0x04, FIVE: 0x05,
  SIX: 0x06, SEVEN: 0x07, EIGHT: 0x08, NINE: 0x09, ZERO: 0x0a,
  MINUS: 0x0b, CARET: 0x0c, YEN: 0x0d, BS: 0x0e,
  TAB: 0x0f, Q: 0x10, W: 0x11, E: 0x12, R: 0x13, T: 0x14, Y: 0x15,
  U: 0x16, I: 0x17, O: 0x18, P: 0x19, AT: 0x1a, LBRACKET: 0x1b, RETURN: 0x1c,
  A: 0x1d, S: 0x1e, D: 0x1f, F: 0x20, G: 0x21, H: 0x22, J: 0x23, K: 0x24,
  L: 0x25, SEMICOLON: 0x26, COLON: 0x27, RBRACKET: 0x28,
  Z: 0x29, X: 0x2a, C: 0x2b, V: 0x2c, B: 0x2d, N: 0x2e, M: 0x2f,
  COMMA: 0x30, PERIOD: 0x31, SLASH: 0x32, SPACE: 0x34,
  HOME: 0x3e, DEL: 0x39,
  UP: 0x3a, LEFT: 0x3b, RIGHT: 0x3c, DOWN: 0x3d,
  F1: 0x62, F2: 0x63, F3: 0x64, F4: 0x65, F5: 0x66,
  F6: 0x67, F7: 0x68, F8: 0x69, F9: 0x6a, F10: 0x6b,
  SHIFT: 0x70, CAPS: 0x71, KANA: 0x72, GRPH: 0x73, CTRL: 0x74,
});

export class Pc98Machine {
  constructor({
    bios = null, itf = null, font = null, sound = null,
    v30 = true, sampleRate = 48000,
    dipsw = null,
    epoch = Date.UTC(1992, 0, 1, 0, 0, 0),
  } = {}) {
    this.schemaVersion = SCHEMA_VERSION;
    this.epoch = epoch;

    // $E8000-$FFFFF. A BIOS shorter than 96 KB is placed at the TOP of the
    // window so its reset vector lands where the CPU looks for it.
    this.bios = new Uint8Array(BIOS_SIZE).fill(0xff);
    if (bios) {
      const src = bios.length > BIOS_SIZE ? bios.subarray(bios.length - BIOS_SIZE) : bios;
      this.bios.set(src, BIOS_SIZE - src.length);
    } else {
      // No ROM at all: leave a HLT at the reset vector rather than executing
      // $FF bytes off the end of the map. Tests build their own ROM.
      this.bios[BIOS_SIZE - 16] = 0xf4;
    }

    this.itf = itf ? new Uint8Array(ITF_SIZE).fill(0xff) : null;
    if (itf && this.itf) {
      const src = itf.length > ITF_SIZE ? itf.subarray(itf.length - ITF_SIZE) : itf;
      this.itf.set(src, ITF_SIZE - src.length);
    }

    this.ram = new Uint8Array(RAM_SIZE);
    // The option ROM window is RAM here: a machine with no sound board and no
    // SCSI card has nothing there, and something that reads it should see the
    // $FF an empty bus gives rather than fall through to the BIOS.
    this.optionRom = new Uint8Array(0x20000).fill(0xff);
    if (sound) this.optionRom.set(sound.subarray(0, Math.min(sound.length, 0x4000)), 0xc000);
    this.hasSoundBios = !!sound;

    this.gdcText = new Upd7220({ master: true, name: 'gdc1' });
    this.gdcGfx = new Upd7220({ master: false, name: 'gdc2' });
    this.video = new Pc98Video({ font, gdcText: this.gdcText, gdcGfx: this.gdcGfx });
    this._wireGdcMemory();

    this.pic = [
      new I8259({ name: 'master' }),
      new I8259({ name: 'slave' }),
    ];
    this.pit = new I8253({ onOut: (ch, level) => this._pitOut(ch, level) });
    // The system and printer PPIs occupy opposite bytes of the same two
    // sixteen-bit I/O blocks. Keeping both chips real is important because a
    // word access must still reach each half independently.
    this.ppi = new I8255({
      inA: () => this.dipsw[0],
      inB: () => this.dipsw[1],
      inC: () => 0xa0,
    });
    this.printerPpi = new I8255({
      inA: () => 0x00,
      inB: () => this.printerStatus,
      inC: () => 0x00,
    });
    this.mousePpi = new I8255({
      inA: () => 0xff,
      inB: () => 0x20,       // 640 KB conventional RAM, no high-resolution mode
      inC: () => 0xff,
    });
    this.fdd = new Pc98Fdd();
    // The PC-9801-26K's OPN. ym2203.js has no interrupt callback — it exposes
    // an `irq` line the board polls, which is what the real /IRQ pin is — so
    // the sound interrupt is sampled in _tickPeripherals along with the FDC's.
    this.opn = new Ym2203({ clockHz: OPN_HZ, sampleRate });
    this._opnIrqPrev = false;

    this.dma = new I8237({
      bus: { read8: (a) => this._read8(a), write8: (a, v) => this._write8(a, v) },
      deviceRead: (ch) => (ch === DMA_FDD ? this.fdd.dmaRead() : -1),
      deviceWrite: (ch, b) => (ch === DMA_FDD ? this.fdd.dmaWrite(b) : false),
      onTc: (ch) => { if (ch === DMA_FDD) this.fdd.tc(); },
    });

    // DIP switches. The defaults say: boot from the floppy, 640x400 colour
    // display, normal (not high-resolution) mode. A machine that reads
    // something else here goes looking for a hard disk that is not there.
    this.dipsw = dipsw ? Uint8Array.from(dipsw) : Uint8Array.from([0xf6, 0x7f, 0xff, 0xff]);

    this.cpu = new I8086({
      read8: (a) => this._read8(a),
      write8: (a, v) => this._write8(a, v),
      inb: (p) => this._in8(p),
      outb: (p, v) => this._out8(p, v),
      inw: (p) => this._in16(p),
      outw: (p, v) => this._out16(p, v),
      intAck: () => this._intAck(),
    }, { v30 });

    this.frame = 0;
    this._acc = 0;
    this.ioLog = null;                 // set to an array to record every port
    this.unknownIoLog = null;          // set to an array to record only open-bus accesses
    this.powerOn();
  }

  // The GDCs draw straight into video memory. GDC1 walks the text plane in
  // words; GDC2 walks the graphics planes, and a write there has to reach all
  // four of them the way the CPU's would.
  _wireGdcMemory() {
    this.gdcText.setMemory({
      read: (ead) => {
        const o = (ead * 2) & 0x3fff;
        return this.video.tvram[o] | (this.video.tvram[o + 1] << 8);
      },
      write: (ead, data, mask) => {
        const o = (ead * 2) & 0x3fff;
        const cur = this.video.tvram[o] | (this.video.tvram[o + 1] << 8);
        const v = (cur & ~mask) | (data & mask);
        this.video.tvram[o] = v & 0xff;
        this.video.tvram[o + 1] = (v >> 8) & 0xff;
      },
    });
    this.gdcGfx.setMemory({
      read: (ead) => {
        const o = (ead * 2) & 0x7fff;
        const p = this.video.gvram[0];
        return p[o] | (p[o + 1] << 8);
      },
      write: (ead, data, mask) => {
        const o = (ead * 2) & 0x7fff;
        this.video.gvramDirty = true;
        for (let pl = 0; pl < 4; pl++) {
          // The GRCG is in the GDC's path too: with it on, the tile registers
          // decide the colour and the GDC's data only says which dots.
          const tile = (this.video.grcgMode & 0x80) ? this.video.grcgTile[pl] : 0xff;
          const src = (this.video.grcgMode & 0x80) ? ((tile << 8) | tile) : data;
          const plane = this.video.gvram[pl];
          const cur = plane[o] | (plane[o + 1] << 8);
          const v = (cur & ~mask) | (src & mask);
          plane[o] = v & 0xff;
          plane[o + 1] = (v >> 8) & 0xff;
        }
      },
    });
  }

  powerOn() {
    this.ram.fill(0);
    this.video.powerOn();
    this.frame = 0;
    this._acc = 0;
    return this.reset();
  }

  reset() {
    // The ITF sits over the top of the BIOS until it writes $043D. With no ITF
    // dump the machine simply starts in the BIOS, which is what an emulator
    // that ships with BIOS.ROM alone does.
    this.itfEnabled = !!this.itf;
    this.line = 0;
    this._cycleDebt = 0;
    this._pitFrac = 0;
    this._opnCycles = 0;
    this._opnIrqPrev = false;
    this._fdcByteCredit = 0;
    this._irqLine = false;
    this._nmiEnabled = false;
    this.keyQueue = [];
    this.keyData = 0;
    this.keyFull = false;
    this._keyDivider = 0;
    this.beep = false;
    this.shutdownFlag = 0;
    // This is the printer PPI port-B wiring. A later model also reports its
    // CPU type and clock here; the V30 baseline leaves those model bits low.
    this.printerStatus = 0x00;
    this.memWindow = 0x40;
    // $0439 is a readable latch. A floating-high value sends later ITFs down
    // their SYSTEM SHUTDOWN path before ordinary device initialization.
    this.dmaAccessControl = 0x00;
    this.dmaAutoIncrement = new Uint8Array(4);

    for (const p of this.pic) p.reset();
    this.pit.reset();
    this.dma.reset();
    this.ppi.reset();
    this.printerPpi.reset();
    this.mousePpi.reset();
    this.fdd.reset();
    // ym2203.js has no reset(); a fresh chip is what the constructor built, and
    // the registers the ROM cares about are all written before a note sounds.
    this.opn.status = 0; this.opn.addr = 0;
    this.opn.timerARun = false; this.opn.timerBRun = false;
    this.opn.irqEnableA = false; this.opn.irqEnableB = false;
    this.gdcText.reset();
    this.gdcGfx.reset();
    this.video.reset();
    this.cpu.reset();
    return this;
  }

  // ---- disks --------------------------------------------------------------------
  insertDisk(unit, disk) { this.fdd.insert(unit, disk); return this; }
  ejectDisk(unit) { this.fdd.eject(unit); return this; }

  // ---- memory --------------------------------------------------------------------
  _read8(a) {
    a &= 0xfffff;
    if (a < RAM_SIZE) return this.ram[a];
    if (a < 0xa4000) return this.video.readText8(a - 0xa0000);
    if (a < 0xa5000) return this.video.readCg8(a - 0xa4000);
    if (a < 0xa8000) return 0xff;
    if (a < 0xb0000) return this.video.readGfx8(0, a - 0xa8000);
    if (a < 0xb8000) return this.video.readGfx8(1, a - 0xb0000);
    if (a < 0xc0000) return this.video.readGfx8(2, a - 0xb8000);
    if (a < 0xe0000) return this.optionRom[a - 0xc0000];
    if (a < 0xe8000) return this.video.readGfx8(3, a - 0xe0000);
    if (this.itfEnabled && a >= ITF_BASE) return this.itf[a - ITF_BASE];
    return this.bios[a - BIOS_BASE];
  }

  _write8(a, v) {
    a &= 0xfffff; v &= 0xff;
    if (a < RAM_SIZE) { this.ram[a] = v; return; }
    if (a < 0xa4000) { this.video.writeText8(a - 0xa0000, v); return; }
    if (a < 0xa8000) return;                 // the CG window is read-only
    if (a < 0xb0000) { this.video.writeGfx8(0, a - 0xa8000, v); return; }
    if (a < 0xb8000) { this.video.writeGfx8(1, a - 0xb0000, v); return; }
    if (a < 0xc0000) { this.video.writeGfx8(2, a - 0xb8000, v); return; }
    if (a < 0xe0000) return;                 // option ROM
    if (a < 0xe8000) { this.video.writeGfx8(3, a - 0xe0000, v); return; }
    // Writes into the BIOS window are dropped, not an error: a memory test
    // that walks the whole megabyte does exactly this.
  }

  // ---- I/O --------------------------------------------------------------------------
  _in8(port) {
    const p = port & 0xffff;
    if (this.ioLog) this.ioLog.push({ r: 1, p, pc: this.cpu.ip, cs: this.cpu.s[1] });
    switch (p) {
      case 0x00: return this.pic[0].read(true);
      case 0x02: return this.pic[0].read(false);
      case 0x08: return this.pic[1].read(true);
      case 0x0a: return this.pic[1].read(false);

      case 0x31: return this.ppi.read(0);
      case 0x33: return this.ppi.read(1);
      case 0x35: return this.ppi.read(2);
      case 0x37: return this.ppi.read(3);

      case 0x41: return this._keyRead();
      case 0x43: return (this.keyFull ? 0x02 : 0x00) | 0x05;   // RxRDY | TxRDY | TxE

      case 0x40: return this.printerPpi.read(0);
      case 0x42: return this.printerPpi.read(1);
      case 0x44: return this.printerPpi.read(2);
      case 0x46: return this.printerPpi.read(3);

      case 0x60: return this.gdcText.readStatus();
      case 0x62: return this.gdcText.readFifo();
      case 0x68: case 0x6a: case 0x6c: case 0x6e: return 0xff;

      case 0x71: return this.pit.read(0);
      case 0x73: return this.pit.read(1);
      case 0x75: return this.pit.read(2);
      case 0x77: return this.pit.read(3);
      case 0x70: case 0x72: case 0x74: case 0x76: case 0x78: case 0x7a:
        return this.video.readTextScroll((p - 0x70) >> 1);

      case 0x90: case 0x92: case 0x94: case 0xbe: return this.fdd.read(p);
      case 0xc8: return this.fdd.read(0x90);
      case 0xca: return this.fdd.read(0x92);
      case 0xcc: return this.fdd.read(0x94);

      case 0xa0: return this.gdcGfx.readStatus();
      case 0xa2: return this.gdcGfx.readFifo();
      case 0xa4: return this.video.displayPage;
      case 0xa6: return this.video.drawPage;
      case 0xa8: case 0xaa: case 0xac: case 0xae: return this.video.readPalette(p);

      case 0x188: return this.opn.readStatus();
      case 0x18a: return this.opn.reg[this.opn.addr];

      case 0x7fd9: return this.mousePpi.read(0);
      case 0x7fdb: return this.mousePpi.read(1);
      case 0x7fdd: return this.mousePpi.read(2);
      case 0x7fdf: return this.mousePpi.read(3);

      case 0x0439: return this.dmaAccessControl;
      case 0x043b: return this.itfEnabled ? 0x00 : 0x01;
      case 0x043d: return 0xff;
      case 0x5f: return 0xff;                       // the standard wait port
      default: break;
    }
    // DMA: odd addresses $01-$1F, page registers $21-$27.
    if (p >= 0x01 && p <= 0x1f && (p & 1)) return this.dma.read((p - 1) >> 1);
    if (p >= 0x21 && p <= 0x27 && (p & 1)) return this.dma.readPage((p - 0x21) >> 1);
    if (this.unknownIoLog) this.unknownIoLog.push({ r: 1, p, v: 0xff, pc: this.cpu.ip, cs: this.cpu.s[1] });
    return 0xff;
  }

  _out8(port, v) {
    const p = port & 0xffff;
    v &= 0xff;
    if (this.ioLog) this.ioLog.push({ r: 0, p, v, pc: this.cpu.ip, cs: this.cpu.s[1] });
    switch (p) {
      case 0x00: this.pic[0].write(true, v); return;
      case 0x02: this.pic[0].write(false, v); return;
      case 0x08: this.pic[1].write(true, v); return;
      case 0x0a: this.pic[1].write(false, v); return;

      case 0x31: this.ppi.write(0, v); return;
      case 0x33: this.ppi.write(1, v); return;
      case 0x35: this.ppi.write(2, v); return;
      case 0x37:
        // The system 8255's control port is used almost entirely for its
        // bit-set/reset command; bit 3 of port C is the buzzer.
        this.ppi.write(3, v);
        if (!(v & 0x80) && ((v >> 1) & 7) === 3) this.beep = !(v & 1);
        return;

      case 0x40: this.printerPpi.write(0, v); return;
      case 0x42: this.printerPpi.write(1, v); return;
      case 0x44: this.printerPpi.write(2, v); return;
      case 0x46: this.printerPpi.write(3, v); return;

      case 0x41: return;                            // keyboard data out: no LEDs here
      case 0x43: return;                            // 8251 command

      case 0x50: this.shutdownFlag = 0; return;
      case 0x52: this.shutdownFlag = 1; return;

      case 0x60: this.gdcText.writeParam(v); return;
      case 0x62: this.gdcText.writeCommand(v); return;
      case 0x64: return;                            // vsync trigger (E-VSYNC)
      case 0x68: this.video.writeModeFF(0x68, v); this._applyModeFF(); return;
      case 0x6a: this.video.writeModeFF(0x6a, v); return;
      case 0x6c: this.video.borderColour = v & 0x0f; return;
      case 0x6e: return;

      case 0x71: this.pit.write(0, v); return;
      case 0x73: this.pit.write(1, v); return;
      case 0x75: this.pit.write(2, v); return;
      case 0x77: this.pit.write(3, v); return;
      case 0x70: case 0x72: case 0x74: case 0x76: case 0x78: case 0x7a:
        this.video.writeTextScroll((p - 0x70) >> 1, v); return;

      case 0x7c: this.video.writeGrcgMode(v); return;
      case 0x7e: this.video.writeGrcgTile(v); return;

      case 0x90: case 0x92: case 0x94: case 0xbe: this.fdd.write(p, v); return;
      case 0xc8: this.fdd.write(0x90, v); return;
      case 0xca: this.fdd.write(0x92, v); return;
      case 0xcc: this.fdd.write(0x94, v); return;

      case 0xa0: this.gdcGfx.writeParam(v); return;
      case 0xa2: this.gdcGfx.writeCommand(v); return;
      case 0xa1: this.video.cgCode = (this.video.cgCode & 0xff00) | v; return;
      case 0xa3: this.video.cgCode = (this.video.cgCode & 0x00ff) | (v << 8); return;
      case 0xa4: this.video.displayPage = v & 1; return;
      case 0xa6: this.video.drawPage = v & 1; return;
      case 0xa8: case 0xaa: case 0xac: case 0xae: this.video.writePalette(p, v); return;

      case 0x188: this.opn.writeAddr(v); return;
      case 0x18a: this.opn.writeData(v); return;
      case 0x18c: case 0x18e: return;               // the -86's second bank

      case 0x7fd9: this.mousePpi.write(0, v); return;
      case 0x7fdb: this.mousePpi.write(1, v); return;
      case 0x7fdd: this.mousePpi.write(2, v); return;
      case 0x7fdf: this.mousePpi.write(3, v); return;

      case 0x043d:
        // The ITF's exit door. $10 puts the ITF back over the BIOS, anything
        // else takes it away; the ROM writes $12 as the last thing it does.
        if (v === 0x10) this.itfEnabled = !!this.itf;
        else if (v === 0x12 || v === 0x00 || v === 0x02) this.itfEnabled = false;
        return;
      case 0x0439: this.dmaAccessControl = v; return;
      case 0x043b: return;
      case 0x043f: this.memWindow = v; return;   // memory window bank select
      case 0xf0: case 0xf2: case 0xf4: case 0xf6: return;   // CPU mode / A20
      default: break;
    }
    if (p >= 0x01 && p <= 0x1f && (p & 1)) { this.dma.write((p - 1) >> 1, v); return; }
    if (p >= 0x21 && p <= 0x27 && (p & 1)) { this.dma.writePage((p - 0x21) >> 1, v); return; }
    if (p === 0x29) {
      this.dmaAutoIncrement[v & 3] = (v >> 2) & 3;
      return;
    }
    if (this.unknownIoLog) this.unknownIoLog.push({ r: 0, p, v, pc: this.cpu.ip, cs: this.cpu.s[1] });
  }

  // The 9801's data bus is sixteen bits wide and most of its registers are
  // eight, on alternating addresses. A word OUT to $60 therefore hits $60 and
  // $61, which are different devices — so words are split, never merged.
  _in16(p) { return (this._in8(p) | (this._in8(p + 1) << 8)) & 0xffff; }
  _out16(p, v) { this._out8(p, v & 0xff); this._out8(p + 1, (v >> 8) & 0xff); }

  // Mode flip-flop 2 is the text/graphics display switch the BIOS uses to
  // blank a screen while it redraws.
  _applyModeFF() {
    // $68 bit 5 clear means "attribute bit 4 is a vertical line"; nothing here
    // depends on it. The display switches live on the GDCs themselves.
  }

  // ---- interrupts --------------------------------------------------------------------
  // The slave's output is the master's IRQ7. Acknowledging the cascade means
  // asking the slave for the real vector, which is the whole reason ack()
  // returns the line number as well as the vector.
  raiseIrq(irq) {
    if (irq < 8) this.pic[0].raise(irq);
    else { this.pic[1].raise(irq - 8); this.pic[0].raise(IRQ_CASCADE); }
  }

  lowerIrq(irq) {
    if (irq < 8) this.pic[0].lower(irq);
    else {
      this.pic[1].lower(irq - 8);
      if (!this.pic[1].intPending) this.pic[0].lower(IRQ_CASCADE);
    }
  }

  _intAck() {
    const a = this.pic[0].ack();
    if (!a) return -1;
    if (a.irq === IRQ_CASCADE) {
      const b = this.pic[1].ack();
      if (!b) return -1;
      return b.vector;
    }
    return a.vector;
  }

  _pitOut(ch, level) {
    // Channel 0 is the system tick. The other two drive the beeper and the
    // memory refresh, neither of which interrupts anything.
    if (ch !== 0) return;
    if (level) this.pic[0].raise(IRQ_TIMER);
    else this.pic[0].lower(IRQ_TIMER);
  }

  // ---- keyboard ------------------------------------------------------------------------
  // The keyboard is a serial link at 19200 baud: bytes arrive a few per frame,
  // not all at once, and the 8251 holds exactly one.
  keyDown(code) { this.keyQueue.push(code & 0x7f); return this; }
  keyUp(code) { this.keyQueue.push((code & 0x7f) | 0x80); return this; }

  _keyRead() {
    const v = this.keyData;
    this.keyFull = false;
    this.pic[0].lower(IRQ_KEYBOARD);
    return v;
  }

  _feedKeyboard() {
    if (this.keyFull || !this.keyQueue.length) return;
    this.keyData = this.keyQueue.shift();
    this.keyFull = true;
    this.pic[0].raise(IRQ_KEYBOARD);
  }

  // ---- run ---------------------------------------------------------------------------
  stepFrame() {
    const perLine = Math.floor(CPU_HZ / (LINES * this.frameHz));
    for (let line = 0; line < LINES; line++) {
      this.line = line;
      if (line === ACTIVE_LINES) {
        // Vertical retrace: both GDCs report it and the CRT interrupt fires.
        this.gdcText.setVsync(true);
        this.gdcGfx.setVsync(true);
        this.pic[0].raise(IRQ_VSYNC);
      } else if (line === 0) {
        this.gdcText.setVsync(false);
        this.gdcGfx.setVsync(false);
        this.pic[0].lower(IRQ_VSYNC);
      }
      this._run(perLine);

      // Four keyboard bytes per frame is about the real link's throughput.
      if (++this._keyDivider >= (LINES >> 2)) { this._keyDivider = 0; this._feedKeyboard(); }
    }

    this.gdcText.tickFrame();
    this.gdcGfx.tickFrame();
    this.video.tickFrame();
    this.video.textDisplay = this.gdcText.displayEnabled;
    this.video.gfxDisplay = this.gdcGfx.displayEnabled;
    this.frame++;
    return this;
  }

  get frameHz() { return this.gdcGfx.al > 256 || this.gdcText.al > 256 ? 56.42 : 61.24; }

  _run(cycles) {
    this._cycleDebt += cycles;
    const cpu = this.cpu;
    let spent = 0;
    while (this._cycleDebt > 0) {
      const want = this.pic[0].intPending;
      if (want !== this._irqLine) { cpu.setIRQ(want); this._irqLine = want; }
      let used = cpu.step();
      // A HLT with no interrupt coming would spin the loop forever otherwise.
      if (!(used > 0)) used = 4;
      this._cycleDebt -= used;
      spent += used;
      if (cpu.halted && !this.pic[0].intPending) {
        // Nothing will wake it inside this slice except the timer, and that is
        // advanced below — so give the slice to the peripherals and come back.
        spent += this._cycleDebt;
        this._cycleDebt = 0;
        break;
      }
    }
    this._tickPeripherals(spent);
  }

  _tickPeripherals(cycles) {
    if (cycles <= 0) return;
    // The PIT runs at a quarter of the CPU clock. Keeping the remainder makes
    // the ratio exact over a frame instead of losing a tick per slice.
    this._pitFrac += cycles;
    const ticks = (this._pitFrac / 4) | 0;
    if (ticks) { this._pitFrac -= ticks * 4; this.pit.advance(ticks); }

    // The OPN's timers count in FM ticks, which are the chip clock over 72.
    // Its clock is half the CPU's here, so the accumulator carries the
    // remainder rather than losing a tick in every slice.
    this._opnCycles += cycles * (OPN_HZ / CPU_HZ);
    if (this._opnCycles >= 72) {
      const t = (this._opnCycles / 72) | 0;
      this._opnCycles -= t * 72;
      this.opn.tickTimers(t);
      const irqNow = this.opn.irq;
      if (irqNow !== this._opnIrqPrev) {
        if (irqNow) this.raiseIrq(IRQ_SOUND); else this.lowerIrq(IRQ_SOUND);
        this._opnIrqPrev = irqNow;
      }
    }

    // The floppy moves at the medium's rate, not the bus's: a 2HD track is
    // 10 KB per 166 ms revolution, one byte every 27 microseconds. Letting the
    // DMA run flat out delivers a sector before the driver has armed itself.
    this._fdcByteCredit += cycles;
    const bytes = (this._fdcByteCredit / 216) | 0;
    if (bytes > 0) {
      this._fdcByteCredit -= bytes * 216;
      if (this.fdd.dmaEnable) this.dma.run(DMA_FDD, bytes);
    }

    if (this.fdd.intPending) this.raiseIrq(IRQ_FDD);
    else this.lowerIrq(IRQ_FDD);
  }

  update(dt, onFrame = null) {
    this._acc += dt;
    const period = 1 / this.frameHz;
    while (this._acc >= period) { this._acc -= period; this.stepFrame(); if (onFrame) onFrame(); }
    return this;
  }

  // ---- video / audio ----------------------------------------------------------------------
  render(opts = {}) { return this.video.render(opts); }

  renderAudio(out, n = out.length) {
    this.opn.render(out, n);
    for (let i = 0; i < n; i++) { const v = out[i]; out[i] = v > 1 ? 1 : v < -1 ? -1 : v; }
    return out;
  }

  // ym2203.js has a getState() for reporting but no setState(): the PC-8801
  // never needed one. Rewind does. What has to be exact is the part the CPU can
  // observe — the register file, the status flags and the two timer counters,
  // because those are what the interrupt line is made of. The FM envelope
  // phases are not restored, which is audible for a fraction of a second after
  // a scrub and invisible to the program. docs/pc98-design.md says so.
  _opnState() {
    const o = this.opn;
    return {
      reg: o.reg.slice(), addr: o.addr, status: o.status,
      timerA: o.timerA, timerB: o.timerB,
      timerACount: o.timerACount, timerBCount: o.timerBCount,
      timerARun: o.timerARun, timerBRun: o.timerBRun,
      irqEnableA: o.irqEnableA, irqEnableB: o.irqEnableB,
      opnCycles: this._opnCycles, opnIrqPrev: this._opnIrqPrev,
    };
  }

  _opnRestore(s) {
    const o = this.opn;
    // Replay the register file so every derived value (operator rates, SSG
    // periods, algorithm wiring) is recomputed the way the chip would have.
    // $28 is skipped: it is the key-on port and re-writing it would retrigger
    // every note that happened to be playing.
    for (let a = 0; a < 256; a++) {
      if (a === 0x28 || a === 0x27) continue;
      if (o.reg[a] === s.reg[a]) continue;
      o.addr = a; o.writeData(s.reg[a]);
    }
    o.reg.set(s.reg);
    o.addr = s.addr; o.status = s.status;
    o.timerA = s.timerA; o.timerB = s.timerB;
    o.timerACount = s.timerACount; o.timerBCount = s.timerBCount;
    o.timerARun = s.timerARun; o.timerBRun = s.timerBRun;
    o.irqEnableA = s.irqEnableA; o.irqEnableB = s.irqEnableB;
    this._opnCycles = s.opnCycles; this._opnIrqPrev = s.opnIrqPrev;
  }

  // ---- time travel ------------------------------------------------------------------------
  // Mutable state only. The BIOS, the ITF, the font ROM and the mounted disk
  // images stay where they are. What is left is dominated by the 640 KB of
  // RAM; the graphics planes are another 128 KB and only travel once something
  // has written to them. docs/pc98-design.md has the measurements.
  snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      cpu: this.cpu.snapshot(),
      ram: this.ram.slice(),
      video: this.video.getState(),
      gdcText: this.gdcText.getState(),
      gdcGfx: this.gdcGfx.getState(),
      pic: this.pic.map((p) => p.getState()),
      pit: this.pit.getState(),
      dma: this.dma.getState(),
      fdd: this.fdd.getState(),
      opn: this._opnState(),
      ppi: { control: this.ppi.control, outA: this.ppi.outA, outB: this.ppi.outB, outC: this.ppi.outC },
      printerPpi: { control: this.printerPpi.control, outA: this.printerPpi.outA,
        outB: this.printerPpi.outB, outC: this.printerPpi.outC },
      mousePpi: { control: this.mousePpi.control, outA: this.mousePpi.outA,
        outB: this.mousePpi.outB, outC: this.mousePpi.outC },
      itfEnabled: this.itfEnabled,
      keyQueue: [...this.keyQueue], keyData: this.keyData, keyFull: this.keyFull,
      keyDivider: this._keyDivider,
      beep: this.beep, shutdownFlag: this.shutdownFlag,
      dmaAccessControl: this.dmaAccessControl, memWindow: this.memWindow,
      dmaAutoIncrement: Array.from(this.dmaAutoIncrement),
      line: this.line, frame: this.frame, acc: this._acc,
      cycleDebt: this._cycleDebt, pitFrac: this._pitFrac,
      fdcByteCredit: this._fdcByteCredit, irqLine: this._irqLine,
    };
  }

  restore(s) {
    this.cpu.restore(s.cpu);
    this.ram.set(s.ram);
    this.video.setState(s.video);
    this.gdcText.setState(s.gdcText);
    this.gdcGfx.setState(s.gdcGfx);
    this.pic[0].setState(s.pic[0]); this.pic[1].setState(s.pic[1]);
    this.pit.setState(s.pit);
    this.dma.setState(s.dma);
    this.fdd.setState(s.fdd);
    this._opnRestore(s.opn);
    Object.assign(this.ppi, s.ppi);
    if (s.printerPpi) Object.assign(this.printerPpi, s.printerPpi);
    if (s.mousePpi) Object.assign(this.mousePpi, s.mousePpi);
    this.itfEnabled = s.itfEnabled;
    this.keyQueue = [...s.keyQueue]; this.keyData = s.keyData; this.keyFull = s.keyFull;
    this._keyDivider = s.keyDivider;
    this.beep = s.beep; this.shutdownFlag = s.shutdownFlag;
    this.dmaAccessControl = s.dmaAccessControl ?? 0;
    this.memWindow = s.memWindow ?? 0x40;
    this.dmaAutoIncrement.set(s.dmaAutoIncrement ?? [0, 0, 0, 0]);
    this.line = s.line; this.frame = s.frame; this._acc = s.acc ?? 0;
    this._cycleDebt = s.cycleDebt; this._pitFrac = s.pitFrac;
    this._fdcByteCredit = s.fdcByteCredit;
    // The interrupt LEVEL is the machine's to drive, not the CPU's to
    // remember: re-assert it so the first instruction after a restore sees the
    // same pins as the first instruction before it.
    this._irqLine = this.pic[0].intPending;
    this.cpu.setIRQ(this._irqLine);
    return this;
  }
}

export function createPc98Machine(opts) { return new Pc98Machine(opts); }
export default Pc98Machine;
