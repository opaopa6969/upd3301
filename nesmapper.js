// nesmapper — the cartridge boards ("mappers").
//
// The Famicom itself is almost nothing: 2KB of work RAM, 2KB of video RAM,
// a CPU and a PPU. Everything else is on the cartridge, and the cartridge is
// not a memory image — it is a BOARD. It decides which 16KB of program ROM
// sits at $8000, which 1KB of character ROM the PPU sees at $0800, how the
// two nametables are wired to the four the PPU addresses, and (on the later
// boards) when to interrupt the CPU. That is why a .nes file needs a "mapper
// number": it names the board so the emulator can rebuild its logic.
//
// So this file is a small registry of boards, not a switch statement buried
// in the machine. `createMapper(cart)` looks the number up; an unknown number
// is an ordinary answer (`{ ok:false }` from `tryCreateMapper`), not a crash,
// because a ROM library is full of boards nobody implemented yet.
//
// Boards implemented here (the five the issue asks for, plus AxROM which is
// three lines and covers Rare's catalogue):
//
//   0  NROM   — no banking at all. The board IS the wires.
//   1  MMC1   — Nintendo's first ASIC. A 5-bit SERIAL shift register, because
//               the board had no spare pins for a parallel bus.
//   2  UxROM  — one switchable 16KB PRG bank, last bank fixed. CHR-RAM.
//   3  CNROM  — PRG fixed, one switchable 8KB CHR bank.
//   4  MMC3   — banked PRG+CHR *and* a scanline counter that interrupts the
//               CPU. That counter is why this file watches the PPU address
//               bus (see A12 below); it is what makes split-screen status
//               bars possible, and half the classics use it.
//   7  AxROM  — 32KB PRG bank + single-screen mirroring select.
//
// Contract: pure, dependency-free, deterministic, plain-data state. No
// Math.random. `getState()`/`setState()` are exact inverses, and immutable
// data (PRG-ROM, CHR-ROM) is never copied into a snapshot — the machine
// holds the parsed cartridge and hands it back on restore. See
// docs/nes-design.md §5.

import { MIRRORING } from './ines.js';

export const SCHEMA_VERSION = 1;

// Nametable wiring, as the PPU wants to consume it: a number, because it is
// looked up once per background fetch.
export const MIRROR = Object.freeze({
  HORIZONTAL: 0,
  VERTICAL: 1,
  SINGLE_A: 2, // both screens map to the first 1KB of CIRAM
  SINGLE_B: 3,
  FOUR: 4,     // the cartridge brought its own 2KB, so all four are distinct
});

function initialMirror(cart) {
  if (cart.mirroring === MIRRORING.FOUR_SCREEN) return MIRROR.FOUR;
  return cart.mirroring === MIRRORING.VERTICAL ? MIRROR.VERTICAL : MIRROR.HORIZONTAL;
}

// ---------------------------------------------------------------------------

export class Mapper {
  constructor(cart) {
    this.cart = cart;
    this.prg = cart.prg;
    // A board carries CHR-ROM *or* CHR-RAM. Which one it is changes what a
    // PPU write at $0000-$1FFF means (a no-op vs. the game uploading tiles),
    // and it changes the snapshot: ROM is immutable and skipped, RAM is not.
    this.chrRom = cart.chr && cart.chr.length ? cart.chr : null;
    this.chr = this.chrRom || new Uint8Array(cart.chrRam || 8192);
    this.chrIsRam = !this.chrRom;
    // Work RAM at $6000. iNES 1.0 says "8KB" for practically every cartridge
    // whether the board has it or not, so we allocate it and track whether
    // anything ever wrote — an untouched 8KB is 8KB we can leave out of every
    // snapshot, and most games never touch it.
    this.prgRam = new Uint8Array(cart.prgRam || 8192);
    this.prgRamDirty = false;
    this.mirroring = initialMirror(cart);
    this.irq = false; // level, wire-ORed into the CPU's IRQ line by the machine
    this.prg16 = Math.max(1, (this.prg.length / 0x4000) | 0); // banks, for wrapping
    // Opt-in: only MMC3-class boards want to be told the PPU address every
    // dot. 89,000 calls a frame is worth paying for a scanline counter and
    // not worth paying for NROM, so the PPU tests this flag instead.
    this.wantsPpuBus = false;
    this.chrMask = this._mask(this.chr.length);
    this.prgMask = this._mask(this.prg.length);
    this.reset();
  }

  reset() {}

  // ---- CPU bus ($4020-$FFFF; the machine handles everything below) --------
  // ROM and RAM sizes on this console are powers of two, so wrapping is a
  // mask, not a modulo — and this runs a few hundred thousand times a frame.
  // The modulo is kept as the fallback for the odd homebrew image whose
  // declared size is not a power of two.
  _mask(len) { return (len & (len - 1)) === 0 ? len - 1 : -1; }

  cpuRead(addr) {
    if (addr >= 0x6000 && addr < 0x8000) return this.prgRam[(addr - 0x6000) % this.prgRam.length];
    if (addr >= 0x8000) return this.prg[this.prgOffset(addr)];
    return 0; // open bus is the machine's business, not the board's
  }

  cpuWrite(addr, value) {
    if (addr >= 0x6000 && addr < 0x8000) {
      this.prgRam[(addr - 0x6000) % this.prgRam.length] = value;
      this.prgRamDirty = true;
      return;
    }
    if (addr >= 0x8000) this.regWrite(addr, value);
  }

  // Boards override these two. `prgOffset` maps $8000-$FFFF into PRG-ROM;
  // `regWrite` is what a write into ROM space actually does (the ROM cannot
  // be written, so the address decoder uses the write as a control signal).
  prgOffset(addr) {
    const a = addr - 0x8000;
    return this.prgMask >= 0 ? (a & this.prgMask) : a % this.prg.length;
  }
  regWrite(_addr, _value) {}

  // ---- PPU bus ($0000-$1FFF) ----------------------------------------------
  ppuRead(addr) { return this.chr[this.chrOffset(addr)]; }

  ppuWrite(addr, value) {
    // A write to CHR-ROM is a write to a ROM: it does nothing. Emulators that
    // let it through turn a game's stray write into corrupted graphics.
    if (this.chrIsRam) this.chr[this.chrOffset(addr)] = value;
  }

  chrOffset(addr) {
    const a = addr & 0x1fff;
    return this.chrMask >= 0 ? (a & this.chrMask) : a % this.chr.length;
  }

  // The PPU address bus, every fetch. Only MMC3-class boards care, but the
  // hook is on the base class so the PPU can call it unconditionally: a
  // branch per fetch is cheaper than a virtual dispatch that might not exist.
  ppuAddrBus(_addr) {}

  // A CPU cycle passed with no bus activity we care about. MMC1 uses the CPU
  // cycle count to reject consecutive writes; the machine passes it in.
  cpuCycle(_cycle) {}

  // ---- state --------------------------------------------------------------
  getState() {
    const s = {
      schemaVersion: SCHEMA_VERSION,
      mapper: this.cart.mapper,
      mirroring: this.mirroring,
      irq: this.irq,
      // Only mutable memory travels. PRG-ROM/CHR-ROM come back by reference
      // from the cartridge the machine still holds.
      prgRam: this.prgRamDirty ? this.prgRam.slice() : null,
      chrRam: this.chrIsRam ? this.chr.slice() : null,
    };
    this.saveRegs(s);
    return s;
  }

  setState(s) {
    this.mirroring = s.mirroring;
    this.irq = !!s.irq;
    if (s.prgRam) { this.prgRam.set(s.prgRam); this.prgRamDirty = true; }
    else { this.prgRam.fill(0); this.prgRamDirty = false; }
    if (s.chrRam && this.chrIsRam) this.chr.set(s.chrRam);
    this.loadRegs(s);
    return this;
  }

  saveRegs(_s) {}
  loadRegs(_s) {}

  snapshot() { return this.getState(); }
  restore(s) { return this.setState(s); }
}

// ---------------------------------------------------------------------------
// 0 — NROM. Donkey Kong, Super Mario Bros., Balloon Fight. 16 or 32KB of PRG
// wired straight to the bus; a 16KB board simply appears twice, which is why
// the reset vector at $FFFC works on both sizes without the game knowing.
class Nrom extends Mapper {}

// ---------------------------------------------------------------------------
// 2 — UxROM. Mega Man, Castlevania, Contra, Duck Tales.
//
// One 16KB window at $8000 switches; $C000 is nailed to the LAST bank. That
// asymmetry is the whole design: the fixed half holds the reset/NMI vectors
// and the bank-switching trampoline, so the code that switches banks never
// switches itself out from under its own feet.
class Uxrom extends Mapper {
  reset() { this.bank = 0; }
  regWrite(_addr, v) { this.bank = v & 0x0f; }
  prgOffset(addr) {
    const bank = addr < 0xc000 ? (this.bank % this.prg16) : (this.prg16 - 1);
    return bank * 0x4000 + (addr & 0x3fff);
  }
  saveRegs(s) { s.bank = this.bank; }
  loadRegs(s) { this.bank = s.bank | 0; }
}

// ---------------------------------------------------------------------------
// 3 — CNROM. Gradius, Arkanoid. PRG fixed, the whole 8KB of character ROM
// swaps at once — a cheap way to hold several full tile sets.
class Cnrom extends Mapper {
  reset() { this.chrBank = 0; }
  regWrite(_addr, v) { this.chrBank = v & 3; }
  chrOffset(addr) {
    const banks = Math.max(1, (this.chr.length / 0x2000) | 0);
    return (this.chrBank % banks) * 0x2000 + (addr & 0x1fff);
  }
  saveRegs(s) { s.chrBank = this.chrBank; }
  loadRegs(s) { this.chrBank = s.chrBank | 0; }
}

// ---------------------------------------------------------------------------
// 7 — AxROM. Battletoads, Marble Madness. A 32KB PRG bank and a single-screen
// mirroring bit: the game picks WHICH nametable both halves show, which is
// how it scrolls a full screen sideways with only 2KB of VRAM.
class Axrom extends Mapper {
  reset() { this.bank = 0; this.mirroring = MIRROR.SINGLE_A; }
  regWrite(_addr, v) {
    this.bank = v & 0x07;
    this.mirroring = (v & 0x10) ? MIRROR.SINGLE_B : MIRROR.SINGLE_A;
  }
  prgOffset(addr) {
    const banks = Math.max(1, (this.prg.length / 0x8000) | 0);
    return (this.bank % banks) * 0x8000 + (addr & 0x7fff);
  }
  saveRegs(s) { s.bank = this.bank; }
  loadRegs(s) { this.bank = s.bank | 0; }
}

// ---------------------------------------------------------------------------
// 1 — MMC1. The Legend of Zelda, Metroid, Mega Man 2, Final Fantasy.
//
// The board had no pins to spare, so the CPU talks to it one bit at a time:
// five writes to anywhere in $8000-$FFFF shift bit 0 into a register, and the
// fifth write commits all five bits to whichever of the four registers the
// LAST address selected. Two consequences that real games depend on:
//
//   - A write with bit 7 set resets the shift register AND ORs $0C into the
//     control register, which forces "$C000 fixed to the last bank". That is
//     the reset trampoline: a game can always get back to a known bank by
//     storing any negative number anywhere in ROM space.
//   - Two writes on CONSECUTIVE CPU cycles: the second is ignored. The chip
//     needs a cycle to settle. This is not trivia — a read-modify-write
//     instruction (`INC $8000`) writes the old value and then the new one on
//     back-to-back cycles, and games use that on purpose to shift ONE bit
//     with a single instruction. Emulating both writes desynchronises the
//     shift register and the game boots to garbage.
class Mmc1 extends Mapper {
  reset() {
    this.shift = 0x10;   // bit 4 set = "one marker bit, four to go"
    this.control = 0x0c; // PRG mode 3 (fix last bank at $C000) — power-on state
    this.chrBank0 = 0;
    this.chrBank1 = 0;
    this.prgBank = 0;
    this.lastWriteCycle = -10;
    this._applyMirror();
  }

  cpuWrite(addr, value, cycle = this.lastWriteCycle + 10) {
    if (addr >= 0x8000) {
      // the consecutive-cycle rule (see above)
      if (cycle - this.lastWriteCycle <= 1) { this.lastWriteCycle = cycle; return; }
      this.lastWriteCycle = cycle;
      this.regWrite(addr, value);
      return;
    }
    super.cpuWrite(addr, value);
  }

  regWrite(addr, v) {
    if (v & 0x80) { this.shift = 0x10; this.control |= 0x0c; return; }
    const full = (this.shift & 1) !== 0; // the marker bit reached bit 0 → this is write #5
    this.shift = ((this.shift >> 1) | ((v & 1) << 4)) & 0x1f;
    if (!full) return;
    const data = this.shift;
    this.shift = 0x10;
    switch ((addr >> 13) & 3) {
      case 0: this.control = data; this._applyMirror(); break;
      case 1: this.chrBank0 = data; break;
      case 2: this.chrBank1 = data; break;
      default: this.prgBank = data; break;
    }
  }

  _applyMirror() {
    this.mirroring = [MIRROR.SINGLE_A, MIRROR.SINGLE_B, MIRROR.VERTICAL, MIRROR.HORIZONTAL][this.control & 3];
  }

  prgOffset(addr) {
    const banks = this.prg16;
    const sel = this.prgBank & 0x0f;
    const mode = (this.control >> 2) & 3;
    let bank;
    if (mode < 2) bank = (sel & ~1) + (addr < 0xc000 ? 0 : 1); // 32KB, ignores bit 0
    else if (mode === 2) bank = addr < 0xc000 ? 0 : sel;       // fix FIRST at $8000
    else bank = addr < 0xc000 ? sel : banks - 1;               // fix LAST at $C000
    return (bank % banks) * 0x4000 + (addr & 0x3fff);
  }

  chrOffset(addr) {
    const banks = Math.max(1, (this.chr.length / 0x1000) | 0);
    if (this.control & 0x10) { // two 4KB banks
      const bank = (addr < 0x1000 ? this.chrBank0 : this.chrBank1) % banks;
      return bank * 0x1000 + (addr & 0x0fff);
    }
    const bank = (this.chrBank0 & ~1) % banks; // one 8KB bank, low bit ignored
    return bank * 0x1000 + (addr & 0x1fff);
  }

  // PRG-RAM enable lives in bit 4 of the PRG bank register on most boards.
  // We ignore it deliberately: a few games leave it disabled and still expect
  // their saves back, and honouring it breaks more carts than it fixes.

  saveRegs(s) {
    s.shift = this.shift; s.control = this.control;
    s.chrBank0 = this.chrBank0; s.chrBank1 = this.chrBank1; s.prgBank = this.prgBank;
    s.lastWriteCycle = this.lastWriteCycle;
  }
  loadRegs(s) {
    this.shift = s.shift; this.control = s.control;
    this.chrBank0 = s.chrBank0; this.chrBank1 = s.chrBank1; this.prgBank = s.prgBank;
    this.lastWriteCycle = s.lastWriteCycle ?? -10;
  }
}

// ---------------------------------------------------------------------------
// 4 — MMC3. Super Mario Bros. 3, Mega Man 3-6, Kirby's Adventure.
//
// Two things: fine-grained banking (two 8KB PRG windows + six CHR windows),
// and a SCANLINE COUNTER that fires an IRQ. The counter is the interesting
// part, and it is not a timer — it watches the PPU's address line A12.
//
// Why A12 works as a scanline clock: with the background tiles at $0000 and
// the sprite tiles at $1000, A12 is low for the whole background fetch phase
// of a scanline and rises when the sprite fetches start (dot 260-ish). One
// rise per scanline, for free, no wire to the CPU. The catch is that A12
// wobbles during ordinary fetches too, so the board filters it: a rise only
// counts if A12 has been LOW for a while first (~3 CPU cycles). Without that
// filter the counter runs several times too fast and status bars land in the
// wrong place; with it, `mmc3_test` passes.
class Mmc3 extends Mapper {
  reset() {
    this.bankSelect = 0;
    this.banks = new Uint8Array(8);
    this.prgRamProtect = 0;
    this.irqLatch = 0;
    this.irqCounter = 0;
    this.irqEnabled = false;
    this.irqReload = false;
    this.a12 = 0;
    this.a12LowCycles = 0; // in PPU dots, counted by ppuAddrBus
    this.irq = false;
    this.prg8 = Math.max(1, (this.prg.length / 0x2000) | 0);
    this.wantsPpuBus = true; // the scanline counter IS a PPU address-bus watcher
  }

  regWrite(addr, v) {
    const even = (addr & 1) === 0;
    switch (addr & 0xe000) {
      case 0x8000:
        if (even) this.bankSelect = v;
        else this.banks[this.bankSelect & 7] = v;
        break;
      case 0xa000:
        if (even) {
          // Four-screen boards ignore the mirroring register entirely: the
          // extra VRAM is soldered on, there is nothing to switch.
          if (this.mirroring !== MIRROR.FOUR) this.mirroring = (v & 1) ? MIRROR.HORIZONTAL : MIRROR.VERTICAL;
        } else this.prgRamProtect = v;
        break;
      case 0xc000:
        if (even) this.irqLatch = v;
        else { this.irqCounter = 0; this.irqReload = true; }
        break;
      default:
        if (even) { this.irqEnabled = false; this.irq = false; }
        else this.irqEnabled = true;
        break;
    }
  }

  prgOffset(addr) {
    const n = this.prg8;
    const mode = (this.bankSelect & 0x40) !== 0;
    let bank;
    switch (addr & 0xe000) {
      // Mode bit swaps which end is fixed: $8000 and $C000 trade places, and
      // the two fixed windows are always the last two banks.
      case 0x8000: bank = mode ? n - 2 : this.banks[6]; break;
      case 0xa000: bank = this.banks[7]; break;
      case 0xc000: bank = mode ? this.banks[6] : n - 2; break;
      default: bank = n - 1; break;
    }
    return (bank % n) * 0x2000 + (addr & 0x1fff);
  }

  chrOffset(addr) {
    const a = addr & 0x1fff;
    // The CHR A12 inversion bit swaps the two 2KB windows with the four 1KB
    // ones, so a game can put its 8x16 sprite tiles wherever it likes.
    const half = ((this.bankSelect & 0x80) ? (a ^ 0x1000) : a);
    const banks1k = Math.max(1, (this.chr.length / 0x400) | 0);
    let bank;
    if (half < 0x0800) bank = (this.banks[0] & ~1) + ((half >> 10) & 1);
    else if (half < 0x1000) bank = (this.banks[1] & ~1) + ((half >> 10) & 1);
    else bank = this.banks[2 + ((half - 0x1000) >> 10)];
    return (bank % banks1k) * 0x400 + (a & 0x3ff);
  }

  // Called for every PPU bus address, with how many PPU dots have passed
  // since the last call. The filter is expressed in dots because that is the
  // clock the PPU actually hands us; 3 CPU cycles = 9 dots, and every
  // implementation that works uses a threshold in the 8-16 dot range.
  ppuAddrBus(addr, dots = 1) {
    const a12 = (addr >> 12) & 1;
    if (a12 === 0) {
      this.a12LowCycles += dots;
    } else {
      if (this.a12 === 0 && this.a12LowCycles >= 8) this._clock();
      this.a12LowCycles = 0;
    }
    this.a12 = a12;
  }

  _clock() {
    // Reload wins over decrement, and a counter that reaches zero reloads on
    // the NEXT clock rather than immediately — that off-by-one is why a latch
    // of N fires every N+1 scanlines.
    if (this.irqCounter === 0 || this.irqReload) {
      this.irqCounter = this.irqLatch;
      this.irqReload = false;
    } else {
      this.irqCounter--;
    }
    if (this.irqCounter === 0 && this.irqEnabled) this.irq = true;
  }

  saveRegs(s) {
    s.bankSelect = this.bankSelect;
    s.banks = this.banks.slice();
    s.prgRamProtect = this.prgRamProtect;
    s.irqLatch = this.irqLatch; s.irqCounter = this.irqCounter;
    s.irqEnabled = this.irqEnabled; s.irqReload = this.irqReload;
    s.a12 = this.a12; s.a12LowCycles = this.a12LowCycles;
  }
  loadRegs(s) {
    this.bankSelect = s.bankSelect;
    this.banks.set(s.banks);
    this.prgRamProtect = s.prgRamProtect;
    this.irqLatch = s.irqLatch; this.irqCounter = s.irqCounter;
    this.irqEnabled = !!s.irqEnabled; this.irqReload = !!s.irqReload;
    this.a12 = s.a12; this.a12LowCycles = s.a12LowCycles;
  }
}

// ---------------------------------------------------------------------------

// The registry. Adding a board is adding a line here plus a class — the
// machine never learns a mapper number.
export const MAPPERS = Object.freeze({
  0: Nrom,
  1: Mmc1,
  2: Uxrom,
  3: Cnrom,
  4: Mmc3,
  7: Axrom,
});

export function supportedMappers() {
  return Object.keys(MAPPERS).map(Number).sort((a, b) => a - b);
}

export function createMapper(cart) {
  const Cls = MAPPERS[cart.mapper];
  if (!Cls) throw new Error(`mapper ${cart.mapper} is not implemented (have: ${supportedMappers().join(', ')})`);
  return new Cls(cart);
}

// Host-facing: an unsupported board is an ordinary answer, the same way an
// unparseable file is in ines.js. A ROM library is full of boards nobody has
// written yet, and the host wants to say which one rather than throw.
export function tryCreateMapper(cart) {
  if (!MAPPERS[cart.mapper]) {
    return { ok: false, code: 'unsupported-mapper', mapper: cart.mapper,
      error: `mapper ${cart.mapper} is not implemented (have: ${supportedMappers().join(', ')})` };
  }
  return { ok: true, mapper: createMapper(cart) };
}
