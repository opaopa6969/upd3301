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
// Boards implemented here. The first group is Nintendo's own and covers most
// of the licensed library on its own; the rest is the long tail, ordered by how
// many cartridges use it rather than by how interesting it is.
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
//   9  MMC2   — Punch-Out!!: CHR banks switched by watching PPU fetches.
//  10  MMC4   — MMC2 with a 16KB PRG window (Fire Emblem, Famicom Wars).
//  20  FDS    — not a board: the Disk System's RAM adapter (32KB RAM, BIOS,
//               timer, drive, wavetable sound). See fds.js.
//  21/22/23/25 VRC2 + VRC4 — Konami. One chip, four numbers, because the
//               register address lines are wired differently per revision.
//  24/26 VRC6  — Akumajou Densetsu. Banking only; the expansion audio is not
//               implemented (see docs/nes-design.md §11).
//  69  FME-7   — Sunsoft. CPU-clocked down-counter IRQ (Gimmick!, Batman RotJ).
//  73  VRC3    — Salamander. A 16-bit IRQ counter.
//  75  VRC1    — Ganbare Goemon.
//  206 Namcot 108 / DxROM — MMC3's ancestor, no IRQ.
//  11/34/66/71/79/87/180/232 — discrete-logic and unlicensed boards, one
//               register each. Cheap in code, and a long tail of cartridges.
//
// Together these cover roughly 90% of the licensed NTSC/JP library by title
// count. The biggest remaining gap is MMC5 (5) and Namco 163 (19); see
// docs/nes-design.md §11 for the list and why they are harder.
//
// Contract: pure, dependency-free, deterministic, plain-data state. No
// Math.random. `getState()`/`setState()` are exact inverses, and immutable
// data (PRG-ROM, CHR-ROM) is never copied into a snapshot — the machine
// holds the parsed cartridge and hands it back on restore. See
// docs/nes-design.md §5.

import { MIRRORING } from './ines.js';
import { FdsDrive, FdsAudio } from './fds.js';

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
    // The other opt-in: boards whose IRQ counter is clocked by the CPU rather
    // than by PPU fetches (FME-7, the VRCs). Same reasoning — a flag test per
    // cycle instead of a call every board would ignore.
    this.wantsCpuCycle = false;
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
// The second wave of boards. Everything above is Nintendo's own; most of what
// follows is either a licensee's cheap discrete-logic board (one register, one
// bank) or a Konami ASIC (banking plus a real interrupt timer). Coverage per
// line of code is very different between the two, and both are worth having:
// the discrete boards are a long tail of budget carts, the VRCs are most of
// Konami's Famicom catalogue.

// 9 — MMC2 (PxROM). Punch-Out!! and nothing else, but it is the only board
// that switches CHR banks *by watching what the PPU fetches*. Two 4KB windows,
// each with two banks, and a latch per window that flips when the PPU reads a
// tile numbered $FD or $FE. Punch-Out!! puts the opponent's face in those
// tiles, so the sprite is drawn from one bank at the top and another at the
// bottom with no CPU involvement at all — a 128-tile character on a board that
// can only address 8KB at a time.
class Mmc2 extends Mapper {
  reset() {
    this.prgBank = 0;
    this.latch0 = 1; this.latch1 = 1;
    this.chrBanks = [0, 0, 0, 0]; // [lo-FD, lo-FE, hi-FD, hi-FE]
    this.prg8 = Math.max(1, (this.prg.length / 0x2000) | 0);
  }

  regWrite(addr, v) {
    switch (addr & 0xf000) {
      case 0xa000: this.prgBank = v & 0x0f; break;
      case 0xb000: this.chrBanks[0] = v & 0x1f; break;
      case 0xc000: this.chrBanks[1] = v & 0x1f; break;
      case 0xd000: this.chrBanks[2] = v & 0x1f; break;
      case 0xe000: this.chrBanks[3] = v & 0x1f; break;
      case 0xf000: this.mirroring = (v & 1) ? MIRROR.HORIZONTAL : MIRROR.VERTICAL; break;
      default: break;
    }
  }

  // $8000 is the only switchable window; the last three 8KB banks are fixed.
  prgOffset(addr) {
    const n = this.prg8;
    const bank = addr < 0xa000 ? (this.prgBank % n) : (n - 3 + ((addr - 0xa000) >> 13));
    return ((bank + n) % n) * 0x2000 + (addr & 0x1fff);
  }

  chrOffset(addr) {
    const a = addr & 0x1fff;
    const banks = Math.max(1, (this.chr.length / 0x1000) | 0);
    const bank = a < 0x1000
      ? this.chrBanks[this.latch0 ? 1 : 0]
      : this.chrBanks[this.latch1 ? 3 : 2];
    return (bank % banks) * 0x1000 + (a & 0xfff);
  }

  // The latch flips AFTER the fetch it was triggered by, which is why the tile
  // that does the switching is itself drawn from the old bank. MMC2 triggers on
  // the single addresses $?FD8/$?FE8; MMC4 (below) on the whole $?FD8-$?FDF
  // range, because it latches one PPU cycle later.
  _latch(addr, wide) {
    if (!wide && (addr & 7) !== 0) return; // MMC2 wants the exact address
    const a = addr & 0x1ff8;
    if (a === 0x0fd8) this.latch0 = 0;
    else if (a === 0x0fe8) this.latch0 = 1;
    else if (a === 0x1fd8) this.latch1 = 0;
    else if (a === 0x1fe8) this.latch1 = 1;
  }

  ppuRead(addr) {
    const v = this.chr[this.chrOffset(addr)];
    this._latch(addr, false);
    return v;
  }

  saveRegs(s) {
    s.prgBank = this.prgBank; s.latch0 = this.latch0; s.latch1 = this.latch1;
    s.chrBanks = this.chrBanks.slice();
  }
  loadRegs(s) {
    this.prgBank = s.prgBank; this.latch0 = s.latch0; this.latch1 = s.latch1;
    this.chrBanks = s.chrBanks.slice();
  }
}

// 10 — MMC4 (FxROM). Fire Emblem, Famicom Wars. MMC2 with a 16KB PRG window
// instead of 8KB, work RAM, and a latch that matches a range rather than a
// single address.
class Mmc4 extends Mmc2 {
  prgOffset(addr) {
    const n = this.prg16;
    const bank = addr < 0xc000 ? (this.prgBank % n) : (n - 1);
    return bank * 0x4000 + (addr & 0x3fff);
  }
  ppuRead(addr) {
    const v = this.chr[this.chrOffset(addr)];
    this._latch(addr, true);
    return v;
  }
}

// 11 — Color Dreams. The unlicensed workhorse: one write sets a 32KB PRG bank
// in the low bits and an 8KB CHR bank in the high ones. No fixed window at
// all, which is fine because the whole program is in the bank.
class ColorDreams extends Mapper {
  reset() { this.prgBank = 0; this.chrBank = 0; }
  regWrite(_a, v) { this.prgBank = v & 3; this.chrBank = (v >> 4) & 0x0f; }
  prgOffset(addr) {
    const n = Math.max(1, (this.prg.length / 0x8000) | 0);
    return (this.prgBank % n) * 0x8000 + (addr & 0x7fff);
  }
  chrOffset(addr) {
    const n = Math.max(1, (this.chr.length / 0x2000) | 0);
    return (this.chrBank % n) * 0x2000 + (addr & 0x1fff);
  }
  saveRegs(s) { s.prgBank = this.prgBank; s.chrBank = this.chrBank; }
  loadRegs(s) { this.prgBank = s.prgBank; this.chrBank = s.chrBank; }
}

// 34 — two unrelated boards sharing a number, told apart by whether the
// cartridge has CHR-ROM. BNROM (Deadly Towers) has none and takes a 32KB PRG
// bank from any write above $8000; NINA-001 (Impossible Mission II) has CHR
// and puts its three registers at $7FFD-$7FFF, inside the work RAM window.
class Mapper34 extends Mapper {
  reset() { this.prgBank = 0; this.chrLo = 0; this.chrHi = 1; this.nina = !!this.chrRom; }
  cpuWrite(addr, value) {
    if (this.nina && addr >= 0x7ffd && addr <= 0x7fff) {
      if (addr === 0x7ffd) this.prgBank = value;
      else if (addr === 0x7ffe) this.chrLo = value;
      else this.chrHi = value;
      return;
    }
    super.cpuWrite(addr, value);
  }
  regWrite(_a, v) { if (!this.nina) this.prgBank = v; }
  prgOffset(addr) {
    const n = Math.max(1, (this.prg.length / 0x8000) | 0);
    return (this.prgBank % n) * 0x8000 + (addr & 0x7fff);
  }
  chrOffset(addr) {
    if (!this.nina) return super.chrOffset(addr);
    const n = Math.max(1, (this.chr.length / 0x1000) | 0);
    const a = addr & 0x1fff;
    const bank = a < 0x1000 ? this.chrLo : this.chrHi;
    return (bank % n) * 0x1000 + (a & 0xfff);
  }
  saveRegs(s) { s.prgBank = this.prgBank; s.chrLo = this.chrLo; s.chrHi = this.chrHi; }
  loadRegs(s) { this.prgBank = s.prgBank; this.chrLo = s.chrLo; this.chrHi = s.chrHi; }
}

// 66 — GxROM / MHROM. Doraemon, Dragon Ball, Super Mario Bros. + Duck Hunt.
// 32KB PRG and 8KB CHR from one byte, the simplest board that switches both.
class Gxrom extends Mapper {
  reset() { this.prgBank = 0; this.chrBank = 0; }
  regWrite(_a, v) { this.prgBank = (v >> 4) & 3; this.chrBank = v & 3; }
  prgOffset(addr) {
    const n = Math.max(1, (this.prg.length / 0x8000) | 0);
    return (this.prgBank % n) * 0x8000 + (addr & 0x7fff);
  }
  chrOffset(addr) {
    const n = Math.max(1, (this.chr.length / 0x2000) | 0);
    return (this.chrBank % n) * 0x2000 + (addr & 0x1fff);
  }
  saveRegs(s) { s.prgBank = this.prgBank; s.chrBank = this.chrBank; }
  loadRegs(s) { this.prgBank = s.prgBank; this.chrBank = s.chrBank; }
}

// 71 — Camerica BF9093/BF9097 (Codemasters). UxROM's layout with the bank
// register moved to $C000, plus — on the BF9097 half — a single-screen
// mirroring bit at $9000 that Fire Hawk uses and no other Camerica game does.
class Camerica71 extends Mapper {
  reset() { this.bank = 0; this.single = false; }
  regWrite(addr, v) {
    if (addr >= 0x9000 && addr < 0xa000) {
      this.single = true;
      this.mirroring = (v & 0x10) ? MIRROR.SINGLE_B : MIRROR.SINGLE_A;
    } else if (addr >= 0xc000) this.bank = v & 0x0f;
  }
  prgOffset(addr) {
    const n = this.prg16;
    const bank = addr < 0xc000 ? (this.bank % n) : (n - 1);
    return bank * 0x4000 + (addr & 0x3fff);
  }
  saveRegs(s) { s.bank = this.bank; s.single = this.single; }
  loadRegs(s) { this.bank = s.bank; this.single = !!s.single; }
}

// 79 — NINA-003/006 (AVE, Sachen). The register sits at $4100-$5FFF, i.e.
// BELOW the cartridge's usual window, which is why it needs its own cpuWrite:
// the address decoder on these boards only looks at A13 and A8.
class Nina003 extends Mapper {
  reset() { this.prgBank = 0; this.chrBank = 0; }
  cpuWrite(addr, value) {
    if ((addr & 0xe100) === 0x4100) {
      this.prgBank = (value >> 3) & 1;
      this.chrBank = value & 7;
      return;
    }
    super.cpuWrite(addr, value);
  }
  prgOffset(addr) {
    const n = Math.max(1, (this.prg.length / 0x8000) | 0);
    return (this.prgBank % n) * 0x8000 + (addr & 0x7fff);
  }
  chrOffset(addr) {
    const n = Math.max(1, (this.chr.length / 0x2000) | 0);
    return (this.chrBank % n) * 0x2000 + (addr & 0x1fff);
  }
  saveRegs(s) { s.prgBank = this.prgBank; s.chrBank = this.chrBank; }
  loadRegs(s) { this.prgBank = s.prgBank; this.chrBank = s.chrBank; }
}

// 87 — Jaleco/Konami's CHR-only board (Argus, City Connection). One register
// in the work-RAM window, and its two bits arrive in the wrong order — a
// wiring accident preserved in every emulator because the games depend on it.
class Mapper87 extends Mapper {
  reset() { this.chrBank = 0; }
  cpuWrite(addr, value) {
    if (addr >= 0x6000 && addr < 0x8000) {
      this.chrBank = ((value & 1) << 1) | ((value >> 1) & 1);
      return;
    }
    super.cpuWrite(addr, value);
  }
  chrOffset(addr) {
    const n = Math.max(1, (this.chr.length / 0x2000) | 0);
    return (this.chrBank % n) * 0x2000 + (addr & 0x1fff);
  }
  saveRegs(s) { s.chrBank = this.chrBank; }
  loadRegs(s) { this.chrBank = s.chrBank; }
}

// 180 — UNROM with the windows the other way round (Crazy Climber). The FIXED
// bank is the first one and the SWITCHABLE window is at $C000, because the
// board's designer wired the bank register to the high half.
class Unrom180 extends Mapper {
  reset() { this.bank = 0; }
  regWrite(_a, v) { this.bank = v & 0x0f; }
  prgOffset(addr) {
    const n = this.prg16;
    const bank = addr < 0xc000 ? 0 : (this.bank % n);
    return bank * 0x4000 + (addr & 0x3fff);
  }
  saveRegs(s) { s.bank = this.bank; }
  loadRegs(s) { this.bank = s.bank; }
}

// 206 — Namcot 108 / Nintendo's DxROM. MMC3's ancestor: the same select/data
// register pair, but no IRQ, no mirroring control (it is soldered) and narrower
// bank fields. Implementing it separately rather than as a crippled MMC3 keeps
// the field widths honest — Gauntlet writes bits the 108 ignores and MMC3 does
// not, and a shared implementation would switch to a bank that does not exist.
class Namcot108 extends Mapper {
  reset() {
    this.select = 0;
    this.banks = new Uint8Array(8);
    this.prg8 = Math.max(1, (this.prg.length / 0x2000) | 0);
  }
  regWrite(addr, v) {
    if ((addr & 1) === 0) this.select = v & 7;
    else this.banks[this.select] = v;
  }
  prgOffset(addr) {
    const n = this.prg8;
    let bank;
    if (addr < 0xa000) bank = this.banks[6] & 0x0f;
    else if (addr < 0xc000) bank = this.banks[7] & 0x0f;
    else if (addr < 0xe000) bank = n - 2;
    else bank = n - 1;
    return (bank % n) * 0x2000 + (addr & 0x1fff);
  }
  chrOffset(addr) {
    const a = addr & 0x1fff;
    const n = Math.max(1, (this.chr.length / 0x400) | 0);
    let bank;
    if (a < 0x0800) bank = (this.banks[0] & 0x3e) + ((a >> 10) & 1);
    else if (a < 0x1000) bank = (this.banks[1] & 0x3e) + ((a >> 10) & 1);
    else bank = this.banks[2 + ((a - 0x1000) >> 10)] & 0x3f;
    return (bank % n) * 0x400 + (a & 0x3ff);
  }
  saveRegs(s) { s.select = this.select; s.banks = this.banks.slice(); }
  loadRegs(s) { this.select = s.select; this.banks.set(s.banks); }
}

// 232 — Camerica Quattro. Four games on one cartridge: the high register picks
// a 64KB block, the low one a 16KB bank inside it, and the last bank of the
// block is always at $C000 so the menu can jump back out.
class Quattro extends Mapper {
  reset() { this.block = 0; this.bank = 0; }
  regWrite(addr, v) {
    if (addr < 0xc000) this.block = (v >> 3) & 3;
    else this.bank = v & 3;
  }
  prgOffset(addr) {
    const n = this.prg16;
    const bank = this.block * 4 + (addr < 0xc000 ? this.bank : 3);
    return (bank % n) * 0x4000 + (addr & 0x3fff);
  }
  saveRegs(s) { s.block = this.block; s.bank = this.bank; }
  loadRegs(s) { this.block = s.block; this.bank = s.bank; }
}

// ---------------------------------------------------------------------------
// The Konami VRC family shares one interrupt timer, so it lives here once.
//
// Two modes. In cycle mode the counter is clocked every CPU cycle; in scanline
// mode a prescaler divides by 341 PPU dots — i.e. by 113 and two thirds CPU
// cycles, which the hardware achieves by subtracting 3 from a 341-step counter
// each cycle. That fraction is the point: a raster split timed by a whole
// number of CPU cycles drifts across the screen over a frame, and Konami's
// games do not drift.
class VrcIrq {
  constructor() { this.reset(); }
  reset() {
    this.latch = 0; this.counter = 0; this.prescaler = 341;
    this.enabled = false; this.enableAfterAck = false; this.cycleMode = false;
    this.out = false;
  }
  setLatch(v) { this.latch = v & 0xff; }
  setControl(v) {
    this.enableAfterAck = (v & 1) !== 0;
    this.enabled = (v & 2) !== 0;
    this.cycleMode = (v & 4) !== 0;
    if (this.enabled) { this.counter = this.latch; this.prescaler = 341; }
    this.out = false;
  }
  ack() { this.out = false; this.enabled = this.enableAfterAck; }
  tick() {
    if (!this.enabled) return;
    if (this.cycleMode) { this._clock(); return; }
    this.prescaler -= 3;
    if (this.prescaler <= 0) { this.prescaler += 341; this._clock(); }
  }
  // The counter counts UP to $FF and reloads from the latch, so a latch of
  // $FF fires every clock and a latch of 0 fires every 256.
  _clock() {
    if (this.counter === 0xff) { this.counter = this.latch; this.out = true; }
    else this.counter++;
  }
  save() {
    return [this.latch, this.counter, this.prescaler, this.enabled ? 1 : 0,
      this.enableAfterAck ? 1 : 0, this.cycleMode ? 1 : 0, this.out ? 1 : 0];
  }
  load(a) {
    this.latch = a[0]; this.counter = a[1]; this.prescaler = a[2];
    this.enabled = !!a[3]; this.enableAfterAck = !!a[4];
    this.cycleMode = !!a[5]; this.out = !!a[6];
  }
}

// 21/22/23/25 — VRC2 and VRC4. Gradius II, Contra (JP), Ganbare Goemon 2,
// Crisis Force, Teenage Mutant Ninja Turtles (JP).
//
// One chip, four iNES numbers, because Konami wired the two low register
// address lines differently on each board revision and the .nes format has no
// room to say which. The registers are at $x000 plus a two-bit index, and that
// index arrives on A0/A1, or A1/A0 swapped, or A2/A3, or A6/A7 depending on the
// revision. Emulators resolve it by OR-ing the candidate lines together: a game
// only ever drives the pair its own board uses, so the others read as zero and
// the union is unambiguous in practice.
class Vrc24 extends Mapper {
  reset() {
    this.prgBanks = [0, 1];
    this.chrBanks = new Uint16Array(8);
    this.swapMode = false;
    this.irqUnit = new VrcIrq();
    this.wantsCpuCycle = true;
    this.prg8 = Math.max(1, (this.prg.length / 0x2000) | 0);
    // VRC2a addresses CHR in 2KB units (it has one fewer address pin), so its
    // bank numbers must be doubled. Mapper 22 is the only VRC2a.
    this.chrShift = this.cart.mapper === 22 ? 1 : 0;
    // VRC2 has no IRQ and no PRG swap mode; treating a VRC2 game's writes to
    // $F000 as IRQ registers is harmless because it never makes them.
    this.mapperNo = this.cart.mapper;
  }

  _index(addr) {
    switch (this.mapperNo) {
      case 21: return (((addr >> 1) & 3) | ((addr >> 6) & 3)) & 3;  // VRC4a (A1,A2) | VRC4c (A6,A7)
      case 22: return (((addr >> 1) & 1) | ((addr & 1) << 1)) & 3;  // VRC2a: A0 and A1 are crossed
      case 25: return ((((addr & 1) << 1) | ((addr >> 1) & 1))      // VRC4b/VRC2c: A0/A1 swapped
        | (((addr >> 2) & 1) << 1) | ((addr >> 3) & 1)) & 3;        // VRC4d (A3,A2)
      default: return ((addr & 3) | ((addr >> 2) & 3)) & 3;         // 22/23: A0,A1 (| A2,A3 for VRC4e)
    }
  }

  regWrite(addr, v) {
    const base = addr & 0xf000;
    const i = this._index(addr);
    switch (base) {
      case 0x8000: this.prgBanks[0] = v & 0x1f; break;
      case 0x9000:
        if (i < 2) {
          // Mirroring: VRC2 has one bit, VRC4 two. Reading only bit 0 on a
          // VRC4 game that selects single-screen puts both nametables on the
          // same page and the status bar ends up drawn over the playfield.
          this.mirroring = [MIRROR.VERTICAL, MIRROR.HORIZONTAL, MIRROR.SINGLE_A, MIRROR.SINGLE_B][v & 3];
        } else this.swapMode = (v & 2) !== 0;
        break;
      case 0xa000: this.prgBanks[1] = v & 0x1f; break;
      case 0xb000: case 0xc000: case 0xd000: case 0xe000: {
        const slot = ((base - 0xb000) >> 12) * 2 + (i >> 1);
        const hi = (i & 1) !== 0;
        const cur = this.chrBanks[slot];
        this.chrBanks[slot] = hi ? ((cur & 0x0f) | ((v & 0x1f) << 4)) : ((cur & ~0x0f) | (v & 0x0f));
        break;
      }
      default: // $F000
        if (i === 0) this.irqUnit.setLatch((this.irqUnit.latch & 0xf0) | (v & 0x0f));
        else if (i === 1) this.irqUnit.setLatch((this.irqUnit.latch & 0x0f) | ((v & 0x0f) << 4));
        else if (i === 2) this.irqUnit.setControl(v);
        else this.irqUnit.ack();
        this.irq = this.irqUnit.out;
        break;
    }
  }

  prgOffset(addr) {
    const n = this.prg8;
    let bank;
    // The swap bit exchanges the $8000 window with the fixed second-to-last
    // bank, so a game can run its bank-switching code from either end.
    if (addr < 0xa000) bank = this.swapMode ? n - 2 : this.prgBanks[0];
    else if (addr < 0xc000) bank = this.prgBanks[1];
    else if (addr < 0xe000) bank = this.swapMode ? this.prgBanks[0] : n - 2;
    else bank = n - 1;
    return (bank % n) * 0x2000 + (addr & 0x1fff);
  }

  chrOffset(addr) {
    const a = addr & 0x1fff;
    const n = Math.max(1, (this.chr.length / 0x400) | 0);
    const bank = this.chrBanks[a >> 10] >> this.chrShift;
    return (bank % n) * 0x400 + (a & 0x3ff);
  }

  cpuCycle() { this.irqUnit.tick(); this.irq = this.irqUnit.out; }

  saveRegs(s) {
    s.prgBanks = this.prgBanks.slice();
    s.chrBanks = Array.from(this.chrBanks);
    s.swapMode = this.swapMode;
    s.irqUnit = this.irqUnit.save();
  }
  loadRegs(s) {
    this.prgBanks = s.prgBanks.slice();
    this.chrBanks.set(s.chrBanks);
    this.swapMode = !!s.swapMode;
    this.irqUnit.load(s.irqUnit);
  }
}

// 24/26 — VRC6. Akumajou Densetsu (the Japanese Castlevania III) and Madara.
// The banking is straightforward; what makes this chip famous is the two extra
// pulse channels and a sawtooth mixed into the console's audio pin. Those are
// NOT implemented: the board's sound registers are accepted and ignored, so
// the games run and the music plays with the 2A03 channels only. See
// docs/nes-design.md §11 — expansion audio is a separate piece of work, and a
// silent expansion is a better answer than a wrong one.
//
// The two numbers differ only in that 26 swaps A0 and A1.
class Vrc6 extends Mapper {
  reset() {
    this.prgBank16 = 0;
    this.prgBank8 = 0;
    this.chrBanks = new Uint8Array(8);
    this.irqUnit = new VrcIrq();
    this.wantsCpuCycle = true;
    this.prg8 = Math.max(1, (this.prg.length / 0x2000) | 0);
    this.swapLines = this.cart.mapper === 26;
  }

  regWrite(addr, v) {
    const a0 = this.swapLines ? ((addr >> 1) & 1) : (addr & 1);
    const a1 = this.swapLines ? (addr & 1) : ((addr >> 1) & 1);
    const i = (a1 << 1) | a0;
    switch (addr & 0xf000) {
      case 0x8000: this.prgBank16 = v & 0x0f; break;
      case 0xc000: this.prgBank8 = v & 0x1f; break;
      case 0xb000:
        if (i === 3) this.mirroring = [MIRROR.VERTICAL, MIRROR.HORIZONTAL, MIRROR.SINGLE_A, MIRROR.SINGLE_B][(v >> 2) & 3];
        break;                                  // i 0-2 are the sawtooth channel
      case 0x9000: case 0xa000: break;          // pulse 1 / pulse 2 — see the note above
      case 0xd000: this.chrBanks[i] = v; break;
      case 0xe000: this.chrBanks[4 + i] = v; break;
      default: // $F000
        if (i === 0) this.irqUnit.setLatch(v);
        else if (i === 1) this.irqUnit.setControl(v);
        else this.irqUnit.ack();
        this.irq = this.irqUnit.out;
        break;
    }
  }

  prgOffset(addr) {
    const n = this.prg8;
    let bank;
    if (addr < 0xc000) bank = (this.prgBank16 & 0x0f) * 2 + ((addr - 0x8000) >> 13);
    else if (addr < 0xe000) bank = this.prgBank8;
    else bank = n - 1;
    return (bank % n) * 0x2000 + (addr & 0x1fff);
  }

  chrOffset(addr) {
    const a = addr & 0x1fff;
    const n = Math.max(1, (this.chr.length / 0x400) | 0);
    return (this.chrBanks[a >> 10] % n) * 0x400 + (a & 0x3ff);
  }

  cpuCycle() { this.irqUnit.tick(); this.irq = this.irqUnit.out; }

  saveRegs(s) {
    s.prgBank16 = this.prgBank16; s.prgBank8 = this.prgBank8;
    s.chrBanks = this.chrBanks.slice(); s.irqUnit = this.irqUnit.save();
  }
  loadRegs(s) {
    this.prgBank16 = s.prgBank16; this.prgBank8 = s.prgBank8;
    this.chrBanks.set(s.chrBanks); this.irqUnit.load(s.irqUnit);
  }
}

// 75 — VRC1. Ganbare Goemon, Tetsuwan Atom. Konami's first custom board:
// three 8KB PRG banks and two 4KB CHR banks, with the CHR banks' top bits
// stranded in the mirroring register because the chip ran out of pins.
class Vrc1 extends Mapper {
  reset() {
    this.prgBanks = [0, 1, 2];
    this.chrLo = 0; this.chrHi = 0; this.chrHiBits = 0;
    this.prg8 = Math.max(1, (this.prg.length / 0x2000) | 0);
  }
  regWrite(addr, v) {
    switch (addr & 0xf000) {
      case 0x8000: this.prgBanks[0] = v & 0x0f; break;
      case 0x9000:
        this.mirroring = (v & 1) ? MIRROR.HORIZONTAL : MIRROR.VERTICAL;
        this.chrHiBits = (v >> 1) & 3;
        break;
      case 0xa000: this.prgBanks[1] = v & 0x0f; break;
      case 0xc000: this.prgBanks[2] = v & 0x0f; break;
      case 0xe000: this.chrLo = v & 0x0f; break;
      case 0xf000: this.chrHi = v & 0x0f; break;
      default: break;
    }
  }
  prgOffset(addr) {
    const n = this.prg8;
    const bank = addr < 0xe000 ? this.prgBanks[(addr - 0x8000) >> 13] : n - 1;
    return (bank % n) * 0x2000 + (addr & 0x1fff);
  }
  chrOffset(addr) {
    const a = addr & 0x1fff;
    const n = Math.max(1, (this.chr.length / 0x1000) | 0);
    const bank = a < 0x1000
      ? (this.chrLo | ((this.chrHiBits & 1) << 4))
      : (this.chrHi | ((this.chrHiBits & 2) << 3));
    return (bank % n) * 0x1000 + (a & 0xfff);
  }
  saveRegs(s) {
    s.prgBanks = this.prgBanks.slice();
    s.chrLo = this.chrLo; s.chrHi = this.chrHi; s.chrHiBits = this.chrHiBits;
  }
  loadRegs(s) {
    this.prgBanks = s.prgBanks.slice();
    this.chrLo = s.chrLo; this.chrHi = s.chrHi; this.chrHiBits = s.chrHiBits;
  }
}

// 73 — VRC3. Salamander, and only Salamander. A 16-bit interrupt counter (the
// rest of the family uses 8) and CHR-RAM, which is why the board has no CHR
// banking at all.
class Vrc3 extends Mapper {
  reset() {
    this.bank = 0;
    this.latch = 0; this.counter = 0;
    this.enabled = false; this.enableAfterAck = false; this.eightBit = false;
    this.wantsCpuCycle = true;
  }
  regWrite(addr, v) {
    switch (addr & 0xf000) {
      case 0x8000: this.latch = (this.latch & 0xfff0) | (v & 0x0f); break;
      case 0x9000: this.latch = (this.latch & 0xff0f) | ((v & 0x0f) << 4); break;
      case 0xa000: this.latch = (this.latch & 0xf0ff) | ((v & 0x0f) << 8); break;
      case 0xb000: this.latch = (this.latch & 0x0fff) | ((v & 0x0f) << 12); break;
      case 0xc000:
        this.enableAfterAck = (v & 1) !== 0;
        this.enabled = (v & 2) !== 0;
        this.eightBit = (v & 4) !== 0;
        if (this.enabled) this.counter = this.latch;
        this.irq = false;
        break;
      case 0xd000: this.irq = false; this.enabled = this.enableAfterAck; break;
      case 0xf000: this.bank = v & 0x0f; break;
      default: break;
    }
  }
  cpuCycle() {
    if (!this.enabled) return;
    if (this.eightBit) {
      if ((this.counter & 0xff) === 0xff) { this.counter = (this.counter & 0xff00) | (this.latch & 0xff); this.irq = true; }
      else this.counter = (this.counter & 0xff00) | ((this.counter + 1) & 0xff);
    } else if (this.counter === 0xffff) { this.counter = this.latch; this.irq = true; }
    else this.counter = (this.counter + 1) & 0xffff;
  }
  prgOffset(addr) {
    const n = this.prg16;
    const bank = addr < 0xc000 ? (this.bank % n) : (n - 1);
    return bank * 0x4000 + (addr & 0x3fff);
  }
  saveRegs(s) {
    s.bank = this.bank; s.latch = this.latch; s.counter = this.counter;
    s.enabled = this.enabled; s.enableAfterAck = this.enableAfterAck; s.eightBit = this.eightBit;
  }
  loadRegs(s) {
    this.bank = s.bank; this.latch = s.latch; this.counter = s.counter;
    this.enabled = !!s.enabled; this.enableAfterAck = !!s.enableAfterAck; this.eightBit = !!s.eightBit;
  }
}

// 69 — Sunsoft FME-7 / 5B. Batman: Return of the Joker, Gimmick!, Hebereke.
// Command/parameter pair (write the register number to $8000, the value to
// $A000) covering eight 1KB CHR banks, three 8KB PRG banks, a work-RAM window
// that can also be ROM, mirroring, and a 16-bit DOWN counter clocked by the
// CPU — which is what lets Gimmick! keep its parallax bands stable.
//
// The 5B variant adds a YM2149 for expansion audio (Gimmick!'s soundtrack).
// Not implemented; the registers are accepted and ignored, same as VRC6.
class Fme7 extends Mapper {
  reset() {
    this.command = 0;
    this.chrBanks = new Uint8Array(8);
    this.prgBanks = new Uint8Array(4); // [$6000, $8000, $A000, $C000]
    this.prgRamAt6000 = false;
    this.prgRamEnabled = false;
    this.irqEnabled = false; this.irqCounterEnabled = false;
    this.irqCounter = 0;
    this.wantsCpuCycle = true;
    this.prg8 = Math.max(1, (this.prg.length / 0x2000) | 0);
  }

  regWrite(addr, v) {
    if (addr < 0xa000) { this.command = v & 0x0f; return; }
    if (addr < 0xc000) {
      const c = this.command;
      if (c < 8) this.chrBanks[c] = v;
      else if (c === 8) {
        this.prgRamAt6000 = (v & 0x40) !== 0;
        this.prgRamEnabled = (v & 0x80) !== 0;
        this.prgBanks[0] = v & 0x3f;
      } else if (c < 12) this.prgBanks[c - 8] = v & 0x3f;
      else if (c === 12) this.mirroring = [MIRROR.VERTICAL, MIRROR.HORIZONTAL, MIRROR.SINGLE_A, MIRROR.SINGLE_B][v & 3];
      else if (c === 13) {
        this.irqEnabled = (v & 1) !== 0;
        this.irqCounterEnabled = (v & 0x80) !== 0;
        this.irq = false;
      } else if (c === 14) this.irqCounter = (this.irqCounter & 0xff00) | v;
      else this.irqCounter = (this.irqCounter & 0x00ff) | (v << 8);
      return;
    }
    // $C000-$FFFF is the audio chip on a 5B; ignored (see the note above).
  }

  cpuRead(addr) {
    if (addr >= 0x6000 && addr < 0x8000) {
      // The $6000 window is RAM or ROM depending on a bit, which is how
      // Gimmick! gets 8KB more program space than the address map allows.
      if (this.prgRamAt6000) return this.prgRamEnabled ? this.prgRam[(addr - 0x6000) % this.prgRam.length] : 0;
      const n = this.prg8;
      return this.prg[(this.prgBanks[0] % n) * 0x2000 + (addr & 0x1fff)];
    }
    return super.cpuRead(addr);
  }

  cpuWrite(addr, value) {
    if (addr >= 0x6000 && addr < 0x8000) {
      if (this.prgRamAt6000 && this.prgRamEnabled) {
        this.prgRam[(addr - 0x6000) % this.prgRam.length] = value;
        this.prgRamDirty = true;
      }
      return;
    }
    super.cpuWrite(addr, value);
  }

  prgOffset(addr) {
    const n = this.prg8;
    const bank = addr < 0xe000 ? this.prgBanks[1 + ((addr - 0x8000) >> 13)] : n - 1;
    return (bank % n) * 0x2000 + (addr & 0x1fff);
  }

  chrOffset(addr) {
    const a = addr & 0x1fff;
    const n = Math.max(1, (this.chr.length / 0x400) | 0);
    return (this.chrBanks[a >> 10] % n) * 0x400 + (a & 0x3ff);
  }

  // Counts DOWN, and fires when it passes through zero — the opposite of the
  // VRCs. It keeps counting when the IRQ is disabled; only the output is gated.
  cpuCycle() {
    if (!this.irqCounterEnabled) return;
    this.irqCounter = (this.irqCounter - 1) & 0xffff;
    if (this.irqCounter === 0xffff && this.irqEnabled) this.irq = true;
  }

  saveRegs(s) {
    s.command = this.command;
    s.chrBanks = this.chrBanks.slice();
    s.prgBanks = this.prgBanks.slice();
    s.prgRamAt6000 = this.prgRamAt6000; s.prgRamEnabled = this.prgRamEnabled;
    s.irqEnabled = this.irqEnabled; s.irqCounterEnabled = this.irqCounterEnabled;
    s.irqCounter = this.irqCounter;
  }
  loadRegs(s) {
    this.command = s.command;
    this.chrBanks.set(s.chrBanks);
    this.prgBanks.set(s.prgBanks);
    this.prgRamAt6000 = !!s.prgRamAt6000; this.prgRamEnabled = !!s.prgRamEnabled;
    this.irqEnabled = !!s.irqEnabled; this.irqCounterEnabled = !!s.irqCounterEnabled;
    this.irqCounter = s.irqCounter;
  }
}

// ---------------------------------------------------------------------------
// 20 — the Famicom Disk System. Not a board at all: the RAM adapter that
// replaces the cartridge, holding 32KB of program RAM at $6000-$DFFF, 8KB of
// character RAM, an 8KB BIOS at $E000, a general-purpose timer, a drive and a
// wavetable sound channel. iNES gives it a mapper number because the file
// format has nowhere else to put it.
//
// The drive and the sound channel live in fds.js (pure, no imports); this
// class is only the address decoder and the two IRQ sources. The dependency
// runs one way — nesmapper.js -> fds.js — so fds.js stays testable on its own.
//
// The IRQ wire carries two independent sources, exactly like the machine's
// does: the timer at $4020-$4022 (games use it as a raster/music clock — it is
// the Disk System's answer to not having an MMC3) and the drive's byte-transfer
// flag. Merging them into one boolean is fine here because the machine already
// wire-ORs mapper IRQs onto one line, but they have to be ACKNOWLEDGED
// separately: $4030 clears the timer, moving a byte clears the drive.
class FdsAdapter extends Mapper {
  constructor(cart) {
    super(cart);
    if (!cart.disk) throw new Error('mapper 20 needs a disk image (see fds.js makeFdsCart)');
    this.drive = new FdsDrive(cart.disk);
    this.audio = new FdsAudio();
    // The timer runs off the CPU clock and the drive's byte clock does too, so
    // this board wants every cycle. It is the only reason mapper.cpuCycle()
    // exists on a board with no bank switching at all.
    this.wantsCpuCycle = true;
    this.reset();
  }

  reset() {
    // Called from the base constructor before our fields exist, so guard.
    if (!this.drive) return;
    this.drive.reset();
    this.irqReload = 0;
    this.irqCounter = 0;
    this.irqRepeat = false;
    this.irqEnabled = false;
    this.timerIrq = false;
    this.diskRegEnable = false;
    this.soundRegEnable = false;
    this.extWrite = 0;
    this.irq = false;
  }

  cpuCycle() {
    if (this.irqEnabled) {
      if (--this.irqCounter <= 0) {
        this.timerIrq = true;
        // A reload of zero would re-arm on every cycle and bury the CPU in
        // interrupts. Hardware does exactly that; nothing sane asks for it, so
        // treat it as one-shot rather than let a bad write hang the host.
        if (this.irqRepeat && this.irqReload > 0) this.irqCounter = this.irqReload;
        else { this.irqEnabled = false; this.irqCounter = 0; }
      }
    }
    this.drive.tick();
    this.audio.tick();
    this.irq = this.timerIrq || this.drive.diskIrq;
  }

  cpuRead(addr) {
    if (addr >= 0x4020 && addr < 0x4100) return this._regRead(addr);
    if (addr >= 0x6000 && addr < 0xe000) return this.prgRam[addr - 0x6000];
    if (addr >= 0xe000) return this.prg[(addr - 0xe000) & 0x1fff];
    return 0;
  }

  cpuWrite(addr, value) {
    if (addr >= 0x4020 && addr < 0x4100) { this._regWrite(addr, value); return; }
    if (addr >= 0x6000 && addr < 0xe000) { this.prgRam[addr - 0x6000] = value; this.prgRamDirty = true; }
    // $E000-$FFFF is the BIOS. A write there is a bug in the game, not a bank
    // switch: there is nothing on this adapter to switch.
  }

  _regRead(addr) {
    switch (addr) {
      case 0x4030: {
        // Disk status 0. Bit 7 reads as "read/write enable" and the BIOS
        // checks it; bit 4 is the CRC error, which a .fds image can never
        // produce because it has no CRCs (see fds.js).
        let v = 0x80;
        if (this.timerIrq) v |= 0x01;
        if (this.drive.transferFlag) v |= 0x02;
        if (this.drive.endOfDisk) v |= 0x40;
        this.timerIrq = false;
        this.irq = this.drive.diskIrq;
        return v;
      }
      case 0x4031: return this.drive.readData();
      case 0x4032: return this.drive.driveStatus();
      case 0x4033: return 0x80; // external connector; bit 7 = "battery is good"
      default: break;
    }
    const a = this.audio.read(addr);
    return a >= 0 ? a : 0;
  }

  _regWrite(addr, value) {
    switch (addr) {
      case 0x4020: this.irqReload = (this.irqReload & 0xff00) | value; return;
      case 0x4021: this.irqReload = (this.irqReload & 0x00ff) | (value << 8); return;
      case 0x4022:
        if (!this.diskRegEnable) return;
        this.irqRepeat = (value & 1) !== 0;
        this.irqEnabled = (value & 2) !== 0;
        if (this.irqEnabled) this.irqCounter = this.irqReload;
        else { this.timerIrq = false; this.irqCounter = 0; }
        this.irq = this.timerIrq || this.drive.diskIrq;
        return;
      case 0x4023:
        this.diskRegEnable = (value & 1) !== 0;
        this.soundRegEnable = (value & 2) !== 0;
        if (!this.diskRegEnable) {
          // Clearing the master enable is how the BIOS shuts the adapter up
          // before handing control to a game that does not want its interrupts.
          this.irqEnabled = false; this.timerIrq = false;
          this.drive.diskIrq = false; this.drive.irqOnTransfer = false;
          this.irq = false;
        }
        return;
      case 0x4024: if (this.diskRegEnable) this.drive.writeData(value); return;
      case 0x4025:
        if (!this.diskRegEnable) return;
        this.drive.control(value);
        // Bit 3 is the only banking-like thing on the whole adapter: it wires
        // the two nametables horizontally or vertically.
        this.mirroring = (value & 0x08) ? MIRROR.HORIZONTAL : MIRROR.VERTICAL;
        this.irq = this.timerIrq || this.drive.diskIrq;
        return;
      case 0x4026: this.extWrite = value; return;
      default: break;
    }
    if (addr >= 0x4040 && addr <= 0x408f) this.audio.write(addr, value);
  }

  // ---- disk handling, for the host ----------------------------------------
  get sideCount() { return this.drive.sideCount; }
  get side() { return this.drive.side; }
  setSide(n) { this.drive.insert(n); return this; }
  eject() { this.drive.eject(); return this; }
  get diskWriteBytes() { return this.drive.writes.size; }

  saveRegs(s) {
    s.irqReload = this.irqReload; s.irqCounter = this.irqCounter;
    s.irqRepeat = this.irqRepeat; s.irqEnabled = this.irqEnabled; s.timerIrq = this.timerIrq;
    s.diskRegEnable = this.diskRegEnable; s.soundRegEnable = this.soundRegEnable;
    s.extWrite = this.extWrite;
    s.drive = this.drive.getState();
    s.audio = this.audio.getState();
  }

  loadRegs(s) {
    this.irqReload = s.irqReload; this.irqCounter = s.irqCounter;
    this.irqRepeat = !!s.irqRepeat; this.irqEnabled = !!s.irqEnabled; this.timerIrq = !!s.timerIrq;
    this.diskRegEnable = !!s.diskRegEnable; this.soundRegEnable = !!s.soundRegEnable;
    this.extWrite = s.extWrite;
    this.drive.setState(s.drive);
    this.audio.setState(s.audio);
  }
}

// ---------------------------------------------------------------------------

// The registry. Adding a board is adding a line here plus a class — the
// machine never learns a mapper number.
export const MAPPERS = Object.freeze({
  0: Nrom,
  20: FdsAdapter,
  1: Mmc1,
  2: Uxrom,
  3: Cnrom,
  4: Mmc3,
  7: Axrom,
  9: Mmc2,
  10: Mmc4,
  11: ColorDreams,
  21: Vrc24, 22: Vrc24, 23: Vrc24, 25: Vrc24,
  24: Vrc6, 26: Vrc6,
  34: Mapper34,
  66: Gxrom,
  69: Fme7,
  71: Camerica71,
  73: Vrc3,
  75: Vrc1,
  79: Nina003,
  87: Mapper87,
  180: Unrom180,
  206: Namcot108,
  232: Quattro,
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
  // Mapper 20 is the one board that needs something the .nes file cannot carry:
  // a disk and the Disk System BIOS. A plain .nes claiming mapper 20 is a
  // mislabelled dump, and saying so beats throwing out of a file picker.
  if (cart.mapper === 20 && !cart.disk) {
    return { ok: false, code: 'fds-needs-disk', mapper: 20,
      error: 'mapper 20 is the Famicom Disk System: load a .fds image and the FDS BIOS, not a .nes' };
  }
  return { ok: true, mapper: createMapper(cart) };
}
