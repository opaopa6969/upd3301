// machinegb — the Game Boy and the Game Boy Color as a machine, on the same
// contract as Pc8801Machine and NesMachine: `stepFrame()`, `frame`,
// `snapshot()`, `restore()`, `schemaVersion`. The host in demo/machine.html
// builds fast-forward, rewind and jog-shuttle on top of that contract and
// nothing else, so a machine that satisfies it gets time travel for free.
//
// The coordinator closes the loop the chips cannot close themselves: sm83.js
// knows nothing about a PPU, gbppu.js knows nothing about a CPU, gbmbc.js
// knows nothing about either. This file wires them, and owns the four things
// that belong to none of them — the timer, the joypad, the serial port and
// the DMA engines.
//
// ## The clock
//
// sm83.js has no cycle table: every bus access is one M-cycle and internal
// delays are explicit (see its header). So the CPU's own bus IS the clock, and
// the synchronisation is one line — `read: (a) => { this._tickM(); return
// this._read(a); }`. A write to $FF46 then starts the OAM DMA on its real
// M-cycle, a read of $FF41 sees the STAT the PPU is showing at that M-cycle,
// and none of it needs catch-up logic.
//
// One M-cycle is four dots of the 4.194 MHz master clock — except in Color
// double-speed mode, where the CPU runs twice as fast and an M-cycle is two
// dots. The divider that feeds the timer and the sound sequencer is on the
// CPU's side of that split, which is why `_tickM()` advances two counters:
//
//     DIV counter   += 4 always      (so the timer really does run twice as
//                                     fast in double speed)
//     PPU / APU     += 4, or 2 in double speed
//
// and why the sound frame sequencer moves from DIV bit 4 to bit 5 when the
// speed changes: 512 Hz either way.
//
// ## Why there is no boot ROM here
//
// The Game Boy's boot ROM is 256 bytes that scroll the logo, check the
// cartridge header, and then switch themselves out of the memory map forever.
// Nothing after $0100 needs it. That is the whole reason this console is the
// one machine in this repository that can be *tested in CI without any ROM the
// project does not own*: a cartridge is self-contained, and an emulator with
// no boot ROM only has to arrive at $0100 with the right registers. Those
// values are in sm83.js's reset() and in `_bootIo()` below, and mooneye's
// boot_regs / boot_hwio / boot_div tests check them one register at a time.
//
// A real boot ROM can still be supplied (`{ bootRom }`) and then it runs, logo
// and all; $FF50 unmaps it exactly as it does on hardware.

import { SM83, IRQ } from './sm83.js';
import { GbPpu, SCREEN_W, SCREEN_H, DMG_SHADES, MODE } from './gbppu.js';
import { GbApu } from './gbapu.js';
import { parseGbRom, createMbc } from './gbmbc.js';

export const SCHEMA_VERSION = 1;

// 4194304 / 70224 dots per frame = 59.727500569606 Hz. Using the real rate
// rather than a flat 60 keeps the emulation clock — and the music tempo — at
// true speed, the same reasoning as the Famicom's 60.0988.
export const DOTS_PER_FRAME = 70224;
export const CLOCK_HZ = 4194304;
export const FRAME_HZ = CLOCK_HZ / DOTS_PER_FRAME;

// The joypad matrix, as two nibbles. A pressed button reads as 0.
export const BUTTON = Object.freeze({
  RIGHT: 0, LEFT: 1, UP: 2, DOWN: 3, A: 4, B: 5, SELECT: 6, START: 7,
});

// TAC's clock select names a bit of the 16-bit divider; TIMA counts that bit's
// FALLING edges. Modelling it as "a bit of a counter" rather than as a divider
// of its own is what makes the whole `timer/` group of mooneye tests work:
// writing $FF04 resets the counter, and if the selected bit was high at that
// moment the reset IS a falling edge and TIMA increments.
const TAC_BIT = [9, 3, 5, 7];

export class GbMachine {
  // One of:
  //   { rom }      raw cartridge bytes
  //   { cart }     a cartridge already parsed by gbmbc.js
  // `model` is 'dmg', 'cgb', or 'auto' (a Color cartridge gets a Color).
  constructor({ rom = null, cart = null, model = 'auto', bootRom = null,
                frameHz = FRAME_HZ, sampleRate = 48000 } = {}) {
    if (!cart && rom) cart = parseGbRom(rom);
    if (!cart) throw new Error('GbMachine needs a cartridge (rom or cart)');
    this.cart = cart;
    this.schemaVersion = SCHEMA_VERSION;
    this.frameHz = frameHz;
    this.frame = 0;
    this._acc = 0;

    this.model = model === 'auto' ? (cart.cgb ? 'cgb' : 'dmg') : model;
    this.cgb = this.model === 'cgb';

    this.mbc = createMbc(cart);
    this.ppu = new GbPpu({ cgb: this.cgb });
    this.apu = new GbApu({ sampleRate, clockHz: CLOCK_HZ });

    // Work RAM: one fixed 4KB bank plus one switchable. On a DMG the switch
    // has nowhere to go and there are eight kilobytes; on a Color there are
    // seven banks behind $D000 and thirty-two kilobytes in total.
    this.wram = new Uint8Array(this.cgb ? 0x8000 : 0x2000);
    this.svbk = 1;
    this.hram = new Uint8Array(0x7f);

    this.bootRom = bootRom ? Uint8Array.from(bootRom) : null;
    this.bootRomMapped = !!this.bootRom;

    this.cpu = new SM83({
      read: (a) => { this._tickM(); return this._read(a); },
      write: (a, v) => { this._tickM(); this._write(a, v); },
      tick: () => this._tickM(),
      irqPending: () => this.ie & this.iflags & 0x1f,
      irqAck: (bit) => { this.iflags &= ~(1 << bit); },
      speedSwitchArmed: () => this.cgb && (this.key1 & 1) !== 0,
      doSpeedSwitch: () => this._doSpeedSwitch(),
    });

    // Everything an emulator captures headlessly comes out of here: blargg's
    // Game Boy suites report by writing characters to the serial port, and
    // mooneye's report by executing `LD B,B` with magic numbers in the
    // registers. Both are cheap to watch and neither needs a screen.
    this.serialOut = [];
    this.onSerialByte = null;
    this.breakpointHits = 0;
    this.cpu.onBreakpoint = (cpu) => {
      this.breakpointHits++;
      if (this.onBreakpoint) this.onBreakpoint(cpu);
    };
    this.onBreakpoint = null;

    this.powerOn();
  }

  powerOn() {
    this.wram.fill(0);
    this.hram.fill(0);
    this.ppu.powerOn();
    this.apu.powerOn();
    this.mbc.reset();
    this.frame = 0;
    this._acc = 0;
    this.serialOut.length = 0;
    this.breakpointHits = 0;
    return this.reset();
  }

  reset() {
    this.ie = 0;
    this.iflags = 0xe1;
    this.pad = 0x00;          // 1 = pressed, in BUTTON bit order
    this.p1 = 0xcf;
    this.sb = 0x00; this.sc = 0x00;
    this._serialBits = 0; this._serialTimer = 0;
    this.tima = 0; this.tma = 0; this.tac = 0;
    this._timaOverflow = 0;   // T-cycles left in the four-cycle reload window
    this._timaReloaded = false;
    this._timerBitPrev = false;
    this._divApuPrev = false;
    this.key1 = 0;
    this.doubleSpeed = false;
    this.svbk = 1;
    this.dmaActive = false; this.dmaSrc = 0; this.dmaIndex = 0; this.dmaDelay = 0;
    this.hdmaSrc = 0; this.hdmaDst = 0; this.hdmaLen = 0; this.hdmaActive = false; this.hdmaHblank = false;
    this._hdmaPending = false;
    this._lastPpuMode = MODE.HBLANK;
    this.rp = 0;
    this.ppu.reset();
    this.bootRomMapped = !!this.bootRom;
    if (this.bootRomMapped) {
      this.cpu.resetToBootRom();
      this.divCounter = 0;
    } else {
      this.cpu.reset({ model: this.model });
      this._bootIo();
    }
    return this;
  }

  // The state the 256 bytes would have left behind. DIV is the one that looks
  // arbitrary and is not: the boot ROM takes a fixed number of cycles, so the
  // divider has a known value the instant the cartridge gets control, and
  // mooneye's boot_div reads it.
  _bootIo() {
    // Not a guess: mooneye's boot_div-dmgABCmgb reads DIV at four known
    // offsets and only one value of the internal counter satisfies all four.
    this.divCounter = this.cgb ? 0x1ea0 : 0xabc8;
    this.iflags = 0xe1;
    this.tima = 0; this.tma = 0; this.tac = 0;
    this.p1 = 0xcf;
    this.sb = 0x00; this.sc = 0x00;
    // The boot ROM plays the "ding" through channel 1, and leaves the sound
    // hardware powered on with that channel's envelope still loaded.
    this.apu.write(0xff26, 0x80);
    this.apu.write(0xff11, 0x80);
    this.apu.write(0xff12, 0xf3);
    this.apu.write(0xff14, 0xbf);
    this.apu.write(0xff24, 0x77);
    this.apu.write(0xff25, 0xf3);
  }

  // ---- the clock -----------------------------------------------------------
  _tickM() {
    // The divider is on the CPU's side of the speed switch, the picture and
    // the sound generator are not. See the header.
    const dots = this.doubleSpeed ? 2 : 4;
    // The flag lives for the whole M-cycle, because what it gates is a CPU
    // write that lands at the END of the M-cycle.
    this._timaReloaded = false;
    this._advanceDiv(4);
    this.ppu.tick(dots);
    this.apu.tick(dots);
    if (this.mbc.wantsTick) this.mbc.tick(dots);
    this._collectPpuIrq();
    if (this.dmaActive) this._dmaStep();
    if (this.hdmaHblank) this._hdmaMaybeHblank();
  }

  // DIV is not a register that counts up: it is the top eight bits of a
  // 16-bit counter that never stops. Everything else in this paragraph
  // follows from that.
  _advanceDiv(n) {
    for (let i = 0; i < n; i++) {
      // The reload window is checked BEFORE the divider moves, so that the
      // overflow set during T-cycle k expires exactly four T-cycles later and
      // not three. Four cycles after TIMA wrapped it is reloaded from TMA and
      // the interrupt is requested; during those four cycles TIMA reads zero
      // and a write to it cancels the whole thing. mooneye's tima_reload,
      // tima_write_reloading and tma_write_reloading are about nothing else.
      if (this._timaOverflow > 0 && --this._timaOverflow === 0) {
        this.tima = this.tma;
        this.iflags |= 1 << IRQ.TIMER;
        this._timaReloaded = true;
      }
      this.divCounter = (this.divCounter + 1) & 0xffff;
      this._afterDivChange();
    }
  }

  // Called after every change of the divider, INCLUDING a write to $FF04 that
  // resets it — because the falling edge that a reset produces is a real
  // falling edge and really does increment TIMA.
  _afterDivChange(fromWrite = false) {
    const enabled = (this.tac & 4) !== 0;
    const bit = enabled && ((this.divCounter >> TAC_BIT[this.tac & 3]) & 1) !== 0;
    if (this._timerBitPrev && !bit) {
      this._incTima();
      // A CPU write is applied at the end of its M-cycle here, but the timer
      // sees the new TAC/DIV at the START of that M-cycle on hardware — four
      // dots earlier. That is a whole M-cycle of the reload delay, and it is
      // the difference between the interrupt arriving before or after the
      // next instruction. mooneye's rapid_toggle counts the instruction.
      if (fromWrite && this._timaOverflow > 0) {
        this._timaOverflow = 0;
        this.tima = this.tma;
        this.iflags |= 1 << IRQ.TIMER;
      }
    }
    this._timerBitPrev = bit;

    // The sound frame sequencer hangs off the same counter — bit 4 of the DIV
    // REGISTER, which is bit 12 of the counter behind it (bit 13 at double
    // speed): 512 Hz either way. Taking "bit 4" literally against the internal
    // counter runs the sequencer 256 times too fast, which sounds like nothing
    // in particular and quietly fails every length-counter test there is.
    const apuBit = ((this.divCounter >> (this.doubleSpeed ? 13 : 12)) & 1) !== 0;
    if (this._divApuPrev && !apuBit) this.apu.frameSequencerStep();
    this._divApuPrev = apuBit;
  }

  _incTima() {
    this.tima = (this.tima + 1) & 0xff;
    if (this.tima === 0) this._timaOverflow = 4;
  }

  _collectPpuIrq() {
    if (this.ppu.vblankReq) { this.iflags |= 1 << IRQ.VBLANK; this.ppu.vblankReq = false; }
    if (this.ppu.statReq) { this.iflags |= 1 << IRQ.STAT; this.ppu.statReq = false; }
    // The Color's HBlank DMA moves sixteen bytes at the start of every mode 0.
    const mode = this.ppu.lcdOn ? this.ppu.mode : MODE.HBLANK;
    if (this.hdmaHblank && mode === MODE.HBLANK && this._lastPpuMode !== MODE.HBLANK) this._hdmaPending = true;
    this._lastPpuMode = mode;
  }

  // ---- OAM DMA -------------------------------------------------------------
  // 160 bytes copied into OAM, one per M-cycle, while the CPU keeps running —
  // but only out of HRAM, because the DMA has the bus. A game that calls a
  // routine outside HRAM during a DMA reads $FF and crashes, which is why
  // every Game Boy game has a copy of the same little routine in high memory.
  // The bus is held for 161 M-cycles: one of start-up delay and 160 of
  // transfer, and it is still held DURING the last transfer cycle. Releasing
  // it at the end of that cycle instead of at the start of the next is a
  // one-cycle error that every single one of mooneye's `*_timing` tests
  // detects, because they all align their measurement to the DMA's end.
  _dmaStep() {
    if (this.dmaDelay > 0) { this.dmaDelay--; return; }
    if (this.dmaIndex >= 160) { this.dmaActive = false; return; }
    this.ppu.writeOamDma(this.dmaIndex, this._dmaRead(this.dmaSrc + this.dmaIndex));
    this.dmaIndex++;
  }

  // The DMA has its own path to memory, so it is not blocked by the PPU the
  // way a CPU access is, and a source above $DFFF is fetched from the echo of
  // work RAM rather than from OAM.
  _dmaRead(addr) {
    addr &= 0xffff;
    if (addr < 0x8000) return this.mbc.read(addr);
    if (addr < 0xa000) return this.ppu.vram[(addr & 0x1fff) | (this.cgb && this.ppu.vbk ? 0x2000 : 0)];
    if (addr < 0xc000) return this.mbc.read(addr);
    return this._wramRead(addr & 0x1fff);
  }

  // ---- Color DMA ($FF51-$FF55) --------------------------------------------
  // Two engines behind one register. Mode 0 copies the lot at once and stops
  // the CPU while it does; mode 1 copies sixteen bytes at the start of each
  // HBlank, which is how a Color game rewrites the tile map a line at a time
  // without a vblank's worth of budget.
  _startHdma(v) {
    const len = ((v & 0x7f) + 1) * 16;
    if (this.hdmaHblank && !(v & 0x80)) {
      // Writing bit 7 = 0 while an HBlank transfer is running cancels it.
      this.hdmaHblank = false;
      this.hdmaLen = len;
      return;
    }
    this.hdmaLen = len;
    if (v & 0x80) { this.hdmaHblank = true; this._hdmaPending = false; return; }
    // General purpose: 8 M-cycles per 16 bytes, spent here and now.
    while (this.hdmaLen > 0) {
      this._hdmaBlock();
      // The CPU is stopped for these, so it cannot charge them itself.
      for (let i = 0; i < 8; i++) { this.cpu.cycles++; this._tickM(); }
    }
  }

  _hdmaMaybeHblank() {
    if (!this._hdmaPending || this.hdmaLen <= 0) return;
    this._hdmaPending = false;
    this._hdmaBlock();
    if (this.hdmaLen <= 0) this.hdmaHblank = false;
  }

  _hdmaBlock() {
    for (let i = 0; i < 16; i++) {
      const b = this._dmaRead(this.hdmaSrc);
      this.ppu.vram[((this.hdmaDst & 0x1fff) | (this.ppu.vbk ? 0x2000 : 0))] = b;
      this.hdmaSrc = (this.hdmaSrc + 1) & 0xffff;
      this.hdmaDst = (this.hdmaDst + 1) & 0xffff;
    }
    this.hdmaLen -= 16;
  }

  _doSpeedSwitch() {
    this.doubleSpeed = !this.doubleSpeed;
    this.key1 = this.doubleSpeed ? 0x80 : 0x00;
    // The switch costs about 2050 M-cycles of stopped CPU on hardware. The
    // divider is reset by it, which games notice.
    this.divCounter = 0;
  }

  // ---- the CPU bus ---------------------------------------------------------
  // While an OAM DMA is running the CPU does not lose the whole memory map —
  // it loses ONE BUS. The console has two: the external one (cartridge, work
  // RAM and its echo) and the video one (VRAM). The DMA takes whichever bus
  // its source is on, plus OAM, and leaves the other alone. That is why
  // mooneye's timing tests can run a `JP nn` out of echo RAM at $FDFE while a
  // DMA from $8000 is in flight, and read $FF for the high byte because the
  // operand happens to land in OAM. Blocking everything below $FF00 — the
  // usual shortcut — makes those tests execute $FF ($FF = RST 38) and hang.
  _dmaBlocks(addr) {
    if (!this.dmaActive || this.dmaDelay > 0) return false;
    if (addr >= 0xff00) return false;                 // I/O and HRAM are on neither bus
    if (addr >= 0xfe00) return true;                  // OAM is always the DMA's
    const srcVideo = this.dmaSrc >= 0x8000 && this.dmaSrc < 0xa000;
    const addrVideo = addr >= 0x8000 && addr < 0xa000;
    return srcVideo === addrVideo;
  }

  _read(addr) {
    addr &= 0xffff;
    if (this._dmaBlocks(addr)) return 0xff;

    if (addr < 0x8000) {
      if (this.bootRomMapped) {
        if (addr < 0x100) return this.bootRom[addr];
        if (this.cgb && addr >= 0x200 && addr < this.bootRom.length) return this.bootRom[addr];
      }
      return this.mbc.read(addr);
    }
    if (addr < 0xa000) return this.ppu.readVram(addr);
    if (addr < 0xc000) return this.mbc.read(addr);
    if (addr < 0xe000) return this._wramRead(addr - 0xc000);
    if (addr < 0xfe00) return this._wramRead(addr - 0xe000);  // echo
    if (addr < 0xfea0) return this.ppu.readOam(addr - 0xfe00);
    // $FEA0-$FEFF is not wired to anything. A DMG returns 0, a Color returns
    // a pattern; games read it by accident and neither answer breaks them.
    if (addr < 0xff00) return this.cgb ? 0x00 : 0x00;
    if (addr < 0xff80) return this._readIo(addr);
    if (addr < 0xffff) return this.hram[addr - 0xff80];
    return this.ie;
  }

  _write(addr, v) {
    addr &= 0xffff;
    v &= 0xff;
    if (this._dmaBlocks(addr)) return;

    if (addr < 0x8000) { this.mbc.write(addr, v); return; }
    if (addr < 0xa000) { this.ppu.writeVram(addr, v); return; }
    if (addr < 0xc000) { this.mbc.write(addr, v); return; }
    if (addr < 0xe000) { this._wramWrite(addr - 0xc000, v); return; }
    if (addr < 0xfe00) { this._wramWrite(addr - 0xe000, v); return; }
    if (addr < 0xfea0) { this.ppu.writeOam(addr - 0xfe00, v); return; }
    if (addr < 0xff00) return;
    if (addr < 0xff80) { this._writeIo(addr, v); return; }
    if (addr < 0xffff) { this.hram[addr - 0xff80] = v; return; }
    this.ie = v;
  }

  _wramRead(off) {
    if (off < 0x1000 || !this.cgb) return this.wram[off % this.wram.length];
    return this.wram[(this.svbk || 1) * 0x1000 + (off - 0x1000)];
  }

  _wramWrite(off, v) {
    if (off < 0x1000 || !this.cgb) { this.wram[off % this.wram.length] = v; return; }
    this.wram[(this.svbk || 1) * 0x1000 + (off - 0x1000)] = v;
  }

  // ---- I/O -----------------------------------------------------------------
  _readIo(addr) {
    if (addr >= 0xff10 && addr < 0xff40) return this.apu.read(addr);
    if ((addr >= 0xff40 && addr <= 0xff4b) || addr === 0xff4f
        || (addr >= 0xff68 && addr <= 0xff6c)) return this.ppu.readReg(addr);
    switch (addr) {
      case 0xff00: return this._readJoypad();
      case 0xff01: return this.sb;
      case 0xff02: return this.sc | (this.cgb ? 0x7c : 0x7e);
      case 0xff04: return (this.divCounter >> 8) & 0xff;
      case 0xff05: return this.tima;
      case 0xff06: return this.tma;
      case 0xff07: return this.tac | 0xf8;
      case 0xff0f: return this.iflags | 0xe0;
      case 0xff46: return this.dmaSrc >> 8;
      case 0xff4d: return this.cgb ? (this.key1 | 0x7e) : 0xff;
      case 0xff50: return 0xff;
      case 0xff51: return this.cgb ? (this.hdmaSrc >> 8) : 0xff;
      case 0xff52: return this.cgb ? (this.hdmaSrc & 0xff) : 0xff;
      case 0xff53: return this.cgb ? ((this.hdmaDst >> 8) & 0x1f) : 0xff;
      case 0xff54: return this.cgb ? (this.hdmaDst & 0xff) : 0xff;
      case 0xff55: return this.cgb ? ((this.hdmaLen <= 0 ? 0xff : ((this.hdmaLen / 16 - 1) & 0x7f)) | (this.hdmaHblank ? 0 : 0x80)) : 0xff;
      case 0xff56: return this.cgb ? (this.rp | 0x3e) : 0xff;
      case 0xff70: return this.cgb ? (this.svbk | 0xf8) : 0xff;
      default: return 0xff;
    }
  }

  _writeIo(addr, v) {
    if (addr >= 0xff10 && addr < 0xff40) { this.apu.write(addr, v); return; }
    if ((addr >= 0xff40 && addr <= 0xff4b && addr !== 0xff46) || addr === 0xff4f
        || (addr >= 0xff68 && addr <= 0xff6c)) { this.ppu.writeReg(addr, v); return; }
    switch (addr) {
      // Only the two select lines are writable; the low nibble is the matrix.
      case 0xff00: this.p1 = (this.p1 & 0xcf) | (v & 0x30); break;
      case 0xff01: this.sb = v; break;
      case 0xff02: this._writeSc(v); break;
      // ANY write resets the whole 16-bit counter, whatever the value.
      case 0xff04: this.divCounter = 0; this._afterDivChange(true); break;
      case 0xff05:
        // Three different answers depending on which M-cycle this lands on:
        // during the four-cycle window the write cancels the reload entirely;
        // ON the reload cycle it is ignored (TMA wins); after it, it is an
        // ordinary write. mooneye's tima_write_reloading measures all three.
        if (this._timaReloaded) break;
        if (this._timaOverflow > 0) this._timaOverflow = 0;
        this.tima = v;
        break;
      case 0xff06:
        this.tma = v;
        // The mirror image: a write to TMA inside the window, or on the
        // reload cycle itself, is what TIMA gets reloaded with.
        if (this._timaOverflow > 0 || this._timaReloaded) this.tima = v;
        break;
      case 0xff07: this.tac = v & 7; this._afterDivChange(true); break;
      case 0xff0f: this.iflags = v & 0x1f; break;
      case 0xff46:
        this.dmaSrc = (v & 0xff) << 8;
        this.dmaIndex = 0;
        this.dmaDelay = 1;   // the transfer starts one M-cycle later
        this.dmaActive = true;
        break;
      case 0xff4d: if (this.cgb) this.key1 = (this.key1 & 0x80) | (v & 1); break;
      case 0xff50: if (v & 1) this.bootRomMapped = false; break;
      case 0xff51: if (this.cgb) this.hdmaSrc = (this.hdmaSrc & 0x00ff) | (v << 8); break;
      case 0xff52: if (this.cgb) this.hdmaSrc = (this.hdmaSrc & 0xff00) | (v & 0xf0); break;
      case 0xff53: if (this.cgb) this.hdmaDst = (this.hdmaDst & 0x00ff) | (((v & 0x1f) | 0x80) << 8); break;
      case 0xff54: if (this.cgb) this.hdmaDst = (this.hdmaDst & 0xff00) | (v & 0xf0); break;
      case 0xff55: if (this.cgb) this._startHdma(v); break;
      case 0xff56: if (this.cgb) this.rp = v & 0xc1; break;
      case 0xff70: if (this.cgb) this.svbk = (v & 7) || 1; break;
      default: break;
    }
  }

  // ---- joypad --------------------------------------------------------------
  // Two four-bit rows behind two select lines, and a pressed button pulls its
  // line LOW. A game that selects neither row reads $0F; a game that selects
  // both gets the OR of the two, which is why some games read $00 and think
  // every button is down.
  _readJoypad() {
    let low = 0x0f;
    if (!(this.p1 & 0x10)) { // direction row
      if (this.pad & (1 << BUTTON.RIGHT)) low &= ~1;
      if (this.pad & (1 << BUTTON.LEFT)) low &= ~2;
      if (this.pad & (1 << BUTTON.UP)) low &= ~4;
      if (this.pad & (1 << BUTTON.DOWN)) low &= ~8;
    }
    if (!(this.p1 & 0x20)) { // button row
      if (this.pad & (1 << BUTTON.A)) low &= ~1;
      if (this.pad & (1 << BUTTON.B)) low &= ~2;
      if (this.pad & (1 << BUTTON.SELECT)) low &= ~4;
      if (this.pad & (1 << BUTTON.START)) low &= ~8;
    }
    return 0xc0 | (this.p1 & 0x30) | low;
  }

  setPad(mask) {
    const before = this.pad;
    this.pad = mask & 0xff;
    // A line going low requests the joypad interrupt and wakes a stopped CPU.
    if (~before & this.pad) {
      this.iflags |= 1 << IRQ.JOYPAD;
      this.cpu.stopped = false;
    }
    return this;
  }

  padDown(bit) { return this.setPad(this.pad | (1 << bit)); }
  padUp(bit) { return this.setPad(this.pad & ~(1 << bit)); }

  // ---- serial --------------------------------------------------------------
  // Nothing is plugged in, so an outgoing byte goes nowhere and $FF comes
  // back. Capturing it anyway is what makes blargg's suites readable without a
  // screen — they print their results through this port.
  _writeSc(v) {
    this.sc = v & 0x83;
    if ((v & 0x81) === 0x81) {
      this.serialOut.push(this.sb);
      if (this.onSerialByte) this.onSerialByte(this.sb);
      // One byte at 8192 bits/s. The interrupt at the end is what the test
      // ROM's send loop waits for.
      this._serialTimer = this.cgb && (v & 2) ? 8 * 16 : 8 * 512;
      this._serialBits = 8;
    }
  }

  _serialTick(dots) {
    if (this._serialBits <= 0) return;
    this._serialTimer -= dots;
    if (this._serialTimer > 0) return;
    this._serialBits = 0;
    this.sb = 0xff;              // no cable: the line floats high
    this.sc &= ~0x80;
    this.iflags |= 1 << IRQ.SERIAL;
  }

  // ---- run -----------------------------------------------------------------
  // One video frame = "run until the PPU reaches the top of vblank". The
  // picture is complete at that point and the game's vblank handler runs at
  // the start of the NEXT stepFrame, so a snapshot taken here holds a finished
  // image and a program about to be told about it. Same boundary as the
  // Famicom's, for the same reason.
  stepFrame() {
    const ppu = this.ppu;
    ppu.frameComplete = false;
    // A frame is 17,556 M-cycles. The guard is a safety net for a ROM that
    // switched the LCD off (in which case there is no vblank at all), not a
    // timing device — and it has to be one frame's worth of cycles so that a
    // screen-off frame still advances the clock by the right amount.
    let budget = Math.ceil(DOTS_PER_FRAME / 4);
    const start = this.cpu.cycles;
    while (!ppu.frameComplete && (this.cpu.cycles - start) < budget) {
      const before = this.cpu.cycles;
      this.cpu.step();
      this._serialTick((this.cpu.cycles - before) * (this.doubleSpeed ? 2 : 4));
    }
    this.frame++;
    return this;
  }

  update(dt, onFrame = null) {
    this._acc += dt;
    const period = 1 / this.frameHz;
    while (this._acc >= period) { this._acc -= period; this.stepFrame(); if (onFrame) onFrame(); }
    return this;
  }

  // ---- video ---------------------------------------------------------------
  // Plain data out, exactly like machine88.js and machinenes.js:
  //   default        → { width, height, rgb }
  //   indexed: true  → { width, height, pixels, drive } for the demo's shared
  //                    CRT pipeline. `pixels` is a GRB index (0..7); a Game
  //                    Boy Color has 32768 colours and the phosphor sim has
  //                    three guns, so the index alone would flatten the
  //                    picture — `drive` (analog) carries the real colour.
  render({ out = null, indexed = false, analog = true } = {}) {
    const W = SCREEN_W, H = SCREEN_H, N = W * H;
    const buf = this.ppu.frameBuf;
    if (!indexed) return { width: W, height: H, rgb: this.ppu.toRgb(out), schemaVersion: SCHEMA_VERSION };

    const pixels = out && out.length === N ? out : new Uint8Array(N);
    let drive = null;
    if (analog) {
      if (!this._driveBuf || this._driveBuf.length !== N * 3) this._driveBuf = new Float32Array(N * 3);
      drive = this._driveBuf;
    }
    if (this.cgb) {
      for (let i = 0; i < N; i++) {
        const c = buf[i];
        const r5 = c & 31, g5 = (c >> 5) & 31, b5 = (c >> 10) & 31;
        const r = (r5 << 3) | (r5 >> 2), g = (g5 << 3) | (g5 >> 2), b = (b5 << 3) | (b5 >> 2);
        pixels[i] = (g >= 128 ? 4 : 0) | (r >= 128 ? 2 : 0) | (b >= 128 ? 1 : 0);
        if (drive) { drive[i] = r / 255; drive[N + i] = g / 255; drive[2 * N + i] = b / 255; }
      }
    } else {
      // The DMG's screen is green, not grey. The shades are mapped onto the
      // classic pea-soup LCD so the demo looks like the object rather than
      // like a monochrome monitor; toRgb() keeps the neutral greys that
      // dmg-acid2 wants to compare against.
      for (let i = 0; i < N; i++) {
        const s = buf[i] & 3;
        const v = DMG_SHADES[s] / 255;
        const r = 0.61 * v + 0.06, g = 0.73 * v + 0.16, b = 0.35 * v + 0.06;
        pixels[i] = (g >= 0.5 ? 4 : 0) | (r >= 0.5 ? 2 : 0) | (b >= 0.5 ? 1 : 0);
        if (drive) { drive[i] = r; drive[N + i] = g; drive[2 * N + i] = b; }
      }
    }
    return { width: W, height: H, pixels, drive, schemaVersion: SCHEMA_VERSION };
  }

  renderAudio(out, n = out.length) { return this.apu.render(out, n); }

  // ---- saves ---------------------------------------------------------------
  get hasBattery() { return this.mbc.hasBattery; }
  exportSave() { return this.mbc.exportSave(); }
  importSave(bytes) { return this.mbc.importSave(bytes); }

  // ---- time travel ---------------------------------------------------------
  // Everything mutable, nothing immutable. The cartridge ROM stays in the
  // parsed cartridge this machine already holds; save RAM that has never been
  // written is omitted entirely; the picture, which IS mutable state and not
  // output (see gbppu.js), rides along packed two bits to the pixel on a DMG.
  // That lands a snapshot at roughly 24KB for a DMG game — still the smallest
  // of any machine in this repository, which is what makes the host's
  // thousand-slot rewind ring cheap here. Measured numbers are in
  // docs/gb-design.md §9.
  snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      cpu: this.cpu.getState(),
      wram: this.wram.slice(),
      hram: this.hram.slice(),
      svbk: this.svbk,
      ppu: this.ppu.getState(),
      apu: this.apu.getState(),
      mbc: this.mbc.getState(),
      ie: this.ie, iflags: this.iflags,
      pad: this.pad, p1: this.p1,
      sb: this.sb, sc: this.sc, serialBits: this._serialBits, serialTimer: this._serialTimer,
      divCounter: this.divCounter, tima: this.tima, tma: this.tma, tac: this.tac,
      timaOverflow: this._timaOverflow, timerBitPrev: this._timerBitPrev, divApuPrev: this._divApuPrev,
      key1: this.key1, doubleSpeed: this.doubleSpeed,
      dmaActive: this.dmaActive, dmaSrc: this.dmaSrc, dmaIndex: this.dmaIndex, dmaDelay: this.dmaDelay,
      hdmaSrc: this.hdmaSrc, hdmaDst: this.hdmaDst, hdmaLen: this.hdmaLen,
      hdmaActive: this.hdmaActive, hdmaHblank: this.hdmaHblank, hdmaPending: !!this._hdmaPending,
      lastPpuMode: this._lastPpuMode,
      bootRomMapped: this.bootRomMapped,
      frame: this.frame, acc: this._acc,
    };
  }

  restore(s) {
    this.cpu.setState(s.cpu);
    this.wram.set(s.wram);
    this.hram.set(s.hram);
    this.svbk = s.svbk;
    this.ppu.setState(s.ppu);
    this.apu.setState(s.apu);
    this.mbc.setState(s.mbc);
    this.ie = s.ie; this.iflags = s.iflags;
    this.pad = s.pad; this.p1 = s.p1;
    this.sb = s.sb; this.sc = s.sc; this._serialBits = s.serialBits; this._serialTimer = s.serialTimer;
    this.divCounter = s.divCounter; this.tima = s.tima; this.tma = s.tma; this.tac = s.tac;
    this._timaOverflow = s.timaOverflow; this._timerBitPrev = s.timerBitPrev; this._divApuPrev = s.divApuPrev;
    this.key1 = s.key1; this.doubleSpeed = s.doubleSpeed;
    this.dmaActive = s.dmaActive; this.dmaSrc = s.dmaSrc; this.dmaIndex = s.dmaIndex; this.dmaDelay = s.dmaDelay;
    this.hdmaSrc = s.hdmaSrc; this.hdmaDst = s.hdmaDst; this.hdmaLen = s.hdmaLen;
    this.hdmaActive = s.hdmaActive; this.hdmaHblank = s.hdmaHblank; this._hdmaPending = s.hdmaPending;
    this._lastPpuMode = s.lastPpuMode;
    this.bootRomMapped = s.bootRomMapped;
    this.frame = s.frame;
    this._acc = s.acc ?? 0;
    return this;
  }

  // ---- debugging -----------------------------------------------------------
  // blargg's Game Boy suites print their result through the serial port and
  // also to the screen; the serial text is the machine-readable half.
  serialText() { return this.serialOut.map((b) => String.fromCharCode(b)).join(''); }
}

export function createGbMachine(opts) { return new GbMachine(opts); }
