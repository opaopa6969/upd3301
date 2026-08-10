// gbmbc — Game Boy cartridge boards (Memory Bank Controllers) and the 80-byte
// header that names them. Pure JS, zero deps, deterministic.
//
// Same shape as nesmapper.js, for the same reason: a cartridge is not a memory
// image, it is a BOARD. It decides which 16KB of ROM sits at $4000, whether
// there is save RAM behind $A000, and — on one family — what time it is. So
// this file is a small registry keyed by the byte at $0147, and an unknown
// board is an ordinary answer (`{ ok:false }` from `tryCreateMbc`), not a
// crash, because any ROM library has boards nobody implemented.
//
// Boards implemented here, in order of how many cartridges use them:
//
//   MBC5  — the last and the simplest: 9 bits of ROM bank in two plain
//           registers, no shift games, no mode flag. Every late DMG and most
//           of the Color library. Rumble is the top bit of the RAM register.
//   MBC3  — MBC5's predecessor plus a real-time clock on the cartridge, with
//           its own battery. Pokémon Gold/Silver, Harvest Moon.
//   MBC1  — the first, and the one with the strange bit: a 2-bit register that
//           means "upper ROM bank" or "RAM bank" depending on a mode flag, and
//           a bank-0 hole (banks $00/$20/$40/$60 read as the next one up)
//           that Nintendo never fixed.
//   MBC2  — 512 nibbles of RAM *on the chip*. The upper nibble of every byte
//           of save RAM does not exist, and the address line that selects
//           between "RAM enable" and "ROM bank" is A8, not the address range.
//   None  — ROM only, optionally with 8KB of RAM wired straight through.
//   HuC1  — Hudson's MBC1 work-alike (an infrared port this does not emulate).
//
// ## The clock, and why it does not call Date.now()
//
// MBC3's RTC is the one place a Game Boy emulator is tempted to read the host
// clock, and doing so would break the only property this whole repository is
// built on: run the same input twice, get the same state. So the RTC is
// clocked from *emulated* cycles (`tick()`), it lands in the snapshot like any
// other register, and rewinding time rewinds the cartridge's clock with it.
// A player who wants the real date can set it once with `setRtcFromDate()` —
// an explicit input, not an ambient one.
//
// Contract: pure, dependency-free, deterministic, plain-data state. No
// Math.random. getState()/setState() are exact inverses, and ROM is never
// copied into a snapshot — the machine holds the parsed cartridge and hands it
// back on restore. See docs/gb-design.md §6.

export const SCHEMA_VERSION = 1;

// The DMG runs at 2^22 Hz. The RTC counts seconds of emulated time, so it
// needs to know how many cycles that is.
const CYCLES_PER_SECOND = 4194304;

// $0147. The value names the board AND what is soldered next to it.
export const CART_TYPE = Object.freeze({
  0x00: { mbc: 'none', ram: false, battery: false },
  0x01: { mbc: 'mbc1', ram: false, battery: false },
  0x02: { mbc: 'mbc1', ram: true, battery: false },
  0x03: { mbc: 'mbc1', ram: true, battery: true },
  0x05: { mbc: 'mbc2', ram: true, battery: false },
  0x06: { mbc: 'mbc2', ram: true, battery: true },
  0x08: { mbc: 'none', ram: true, battery: false },
  0x09: { mbc: 'none', ram: true, battery: true },
  0x0b: { mbc: 'mmm01', ram: false, battery: false },
  0x0c: { mbc: 'mmm01', ram: true, battery: false },
  0x0d: { mbc: 'mmm01', ram: true, battery: true },
  0x0f: { mbc: 'mbc3', ram: false, battery: true, rtc: true },
  0x10: { mbc: 'mbc3', ram: true, battery: true, rtc: true },
  0x11: { mbc: 'mbc3', ram: false, battery: false },
  0x12: { mbc: 'mbc3', ram: true, battery: false },
  0x13: { mbc: 'mbc3', ram: true, battery: true },
  0x19: { mbc: 'mbc5', ram: false, battery: false },
  0x1a: { mbc: 'mbc5', ram: true, battery: false },
  0x1b: { mbc: 'mbc5', ram: true, battery: true },
  0x1c: { mbc: 'mbc5', ram: false, battery: false, rumble: true },
  0x1d: { mbc: 'mbc5', ram: true, battery: false, rumble: true },
  0x1e: { mbc: 'mbc5', ram: true, battery: true, rumble: true },
  0x20: { mbc: 'mbc6', ram: true, battery: true },
  0x22: { mbc: 'mbc7', ram: true, battery: true },
  0xfc: { mbc: 'camera', ram: true, battery: true },
  0xfd: { mbc: 'tama5', ram: true, battery: true },
  0xfe: { mbc: 'huc3', ram: true, battery: true },
  0xff: { mbc: 'huc1', ram: true, battery: true },
});

// $0149. The header lies often enough that the parser keeps both the declared
// size and what it actually allocated.
const RAM_SIZES = [0, 2048, 8192, 32768, 131072, 65536];

// The 48 bytes of the Nintendo logo, checked by the boot ROM before it will
// run a cartridge at all. Kept because it is the cheapest way to tell "this is
// a Game Boy ROM" from "this is some other file the user dragged in" — and,
// with a real boot ROM mapped, a cartridge that fails it will not start.
const LOGO = Uint8Array.from([
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d,
  0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e, 0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99,
  0xbb, 0xbb, 0x67, 0x63, 0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
]);

export class GbRomError extends Error {
  constructor(code, message) { super(message); this.name = 'GbRomError'; this.code = code; }
}

// The header. Damage that a real cartridge could survive becomes a warning;
// only "this cannot be a Game Boy ROM at all" throws. Same policy as
// ines.js — a file picker gets fed junk as a matter of course.
export function parseGbRom(bytes) {
  const rom = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (rom.length < 0x150) throw new GbRomError('TOO_SHORT', `ROM is ${rom.length} bytes; the header alone is $150`);
  const warnings = [];

  let title = '';
  for (let i = 0x134; i <= 0x143; i++) {
    const ch = rom[i];
    if (ch === 0 || ch < 0x20 || ch > 0x7e) break;
    title += String.fromCharCode(ch);
  }

  // $0143 is the last byte of the title on a DMG cartridge and the CGB flag on
  // a Color one: $80 "works on both", $C0 "Color only".
  const cgbByte = rom[0x143];
  const cgb = cgbByte === 0x80 || cgbByte === 0xc0;
  const cgbOnly = cgbByte === 0xc0;
  if (cgb) title = title.replace(/[\x80\xc0]$/, '');

  const typeByte = rom[0x147];
  const info = CART_TYPE[typeByte];
  if (!info) warnings.push(`unknown cartridge type $${typeByte.toString(16).padStart(2, '0')}`);

  // $0148 is an exponent: 32KB << n. Real cartridges never exceed 8MB.
  const romSizeByte = rom[0x148];
  const declaredRom = romSizeByte <= 8 ? 32768 << romSizeByte : 0;
  if (declaredRom && rom.length !== declaredRom) {
    warnings.push(`header declares ${declaredRom} bytes of ROM, file has ${rom.length}`);
  }

  const ramSizeByte = rom[0x149];
  let ramSize = RAM_SIZES[ramSizeByte] ?? 0;
  if (RAM_SIZES[ramSizeByte] === undefined) warnings.push(`unknown RAM size code $${ramSizeByte.toString(16)}`);
  // MBC2's RAM is inside the chip and the header always says "none".
  if (info && info.mbc === 'mbc2') ramSize = 512;
  // A board with RAM soldered on but a header that says zero is common enough
  // (and harmless to over-allocate) that it is worth fixing quietly.
  if (info && info.ram && ramSize === 0 && info.mbc !== 'mbc2') { ramSize = 8192; warnings.push('header says no RAM but the board has some; assuming 8KB'); }

  let logoOk = true;
  for (let i = 0; i < LOGO.length; i++) if (rom[0x104 + i] !== LOGO[i]) { logoOk = false; break; }
  if (!logoOk) warnings.push('Nintendo logo does not match; a real boot ROM would refuse this');

  // $014D: a one-byte checksum over the header. The boot ROM locks up if it is
  // wrong, so a mismatch means the file has been edited or is not a ROM.
  let sum = 0;
  for (let i = 0x134; i <= 0x14c; i++) sum = (sum - rom[i] - 1) & 0xff;
  const headerChecksumOk = sum === rom[0x14d];
  if (!headerChecksumOk) warnings.push(`header checksum $${rom[0x14d].toString(16)} != computed $${sum.toString(16)}`);

  return {
    rom,
    title,
    typeByte,
    mbc: info ? info.mbc : 'none',
    hasRam: !!(info && info.ram),
    hasBattery: !!(info && info.battery),
    hasRtc: !!(info && info.rtc),
    hasRumble: !!(info && info.rumble),
    ramSize,
    romSize: rom.length,
    cgb, cgbOnly,
    sgb: rom[0x146] === 0x03,
    logoOk,
    headerChecksumOk,
    warnings,
  };
}

export function tryParseGbRom(bytes) {
  try { return { ok: true, cart: parseGbRom(bytes) }; }
  catch (e) { return { ok: false, code: e.code || 'ERROR', error: e.message }; }
}

// Build a minimal but *valid* ROM in memory. Tests need cartridges, and this
// repository does not commit commercial ones — same trick as ines.js's
// buildINes().
export function buildGbRom({ code = [], size = 0x8000, type = 0x00, ramSize = 0, cgb = false, title = 'TEST', at = 0x0150 } = {}) {
  const rom = new Uint8Array(Math.max(size, 0x8000));
  rom.set(LOGO, 0x104);
  for (let i = 0; i < 16 && i < title.length; i++) rom[0x134 + i] = title.charCodeAt(i);
  if (cgb) rom[0x143] = 0x80;
  rom[0x147] = type;
  let n = 0, len = rom.length;
  while ((32768 << n) < len && n < 8) n++;
  rom[0x148] = n;
  rom[0x149] = ramSize >= 131072 ? 4 : ramSize >= 65536 ? 5 : ramSize >= 32768 ? 3 : ramSize >= 8192 ? 2 : ramSize >= 2048 ? 1 : 0;
  rom.set(code, at);
  // The entry point at $0100 is four bytes: NOP; JP <at>.
  rom[0x100] = 0x00; rom[0x101] = 0xc3; rom[0x102] = at & 0xff; rom[0x103] = (at >> 8) & 0xff;
  let sum = 0;
  for (let i = 0x134; i <= 0x14c; i++) sum = (sum - rom[i] - 1) & 0xff;
  rom[0x14d] = sum;
  return rom;
}

// ---------------------------------------------------------------------------

export class Mbc {
  constructor(cart) {
    this.cart = cart;
    this.rom = cart.rom;
    this.romBanks = Math.max(1, Math.ceil(this.rom.length / 0x4000));
    // Save RAM. `dirty` exists so an untouched 8KB — which is most cartridges,
    // most of the time — can be left out of every snapshot; the Famicom side
    // learned that trick first and it is worth more here, where the ring holds
    // a thousand of them.
    this.ram = new Uint8Array(cart.ramSize || 0);
    this.ramBanks = this.ram.length ? Math.max(1, this.ram.length >> 13) : 0;
    this.ramDirty = false;
    this.ramEnabled = false;
    this.romBank = 1;
    this.ramBank = 0;
    this.hasBattery = cart.hasBattery;
    // Opt-in, exactly like nesmapper's wantsCpuCycle: only MBC3 wants to be
    // told that time passed, and the machine tests a flag rather than calling
    // into a board that would ignore it.
    this.wantsTick = false;
    this.reset();
  }

  reset() {}

  // ROM is read through a bank index rather than a precomputed offset because
  // the index is what the board's registers actually hold, and a bank number
  // past the end of a short ROM wraps (the address lines that are not there
  // simply do not select anything).
  _romByte(bank, offset) {
    const a = ((bank % this.romBanks) * 0x4000) + offset;
    return this.rom[a] ?? 0xff;
  }

  read(addr) {
    if (addr < 0x4000) return this._romByte(this.bank0(), addr);
    if (addr < 0x8000) return this._romByte(this.romBank, addr - 0x4000);
    if (addr >= 0xa000 && addr < 0xc000) return this.readRam(addr - 0xa000);
    return 0xff;
  }

  write(addr, value) {
    if (addr < 0x8000) { this.regWrite(addr, value); return; }
    if (addr >= 0xa000 && addr < 0xc000) this.writeRam(addr - 0xa000, value);
  }

  bank0() { return 0; }
  regWrite(_addr, _value) {}

  // With RAM disabled — the state every cartridge powers up in, and the state
  // a careful game leaves it in so a dying battery cannot corrupt a save —
  // the data lines float and the CPU reads $FF.
  readRam(off) {
    if (!this.ramEnabled || !this.ram.length) return 0xff;
    return this.ram[(this.ramBank * 0x2000 + off) % this.ram.length];
  }

  writeRam(off, value) {
    if (!this.ramEnabled || !this.ram.length) return;
    this.ram[(this.ramBank * 0x2000 + off) % this.ram.length] = value;
    this.ramDirty = true;
  }

  tick(_cycles) {}

  getState() {
    return {
      romBank: this.romBank, ramBank: this.ramBank, ramEnabled: this.ramEnabled,
      // Never the ROM. Never an untouched RAM.
      ram: this.ramDirty ? this.ram.slice() : null,
      regs: this.saveRegs(),
    };
  }

  setState(s) {
    this.romBank = s.romBank; this.ramBank = s.ramBank; this.ramEnabled = s.ramEnabled;
    if (s.ram) { this.ram.set(s.ram); this.ramDirty = true; }
    else if (this.ramDirty) { this.ram.fill(0); this.ramDirty = false; }
    this.loadRegs(s.regs);
  }

  // Boards with state beyond the three common registers override these two.
  // Forgetting to is the classic bug: everything works until someone rewinds.
  saveRegs() { return null; }
  loadRegs(_r) {}

  // Battery-backed saves are the machine's business to persist, but the shape
  // of the data is the board's.
  exportSave() { return this.hasBattery && this.ram.length ? this.ram.slice() : null; }
  importSave(bytes) {
    if (!bytes || !this.ram.length) return false;
    this.ram.set(bytes.subarray(0, this.ram.length));
    this.ramDirty = true;
    return true;
  }
}

// ---- no MBC ---------------------------------------------------------------
// 32KB flat. The board is the wires.
class NoMbc extends Mbc {
  constructor(cart) { super(cart); this.ramEnabled = true; }
  reset() { this.romBank = 1; this.ramEnabled = true; }
  regWrite() {}
}

// ---- MBC1 -----------------------------------------------------------------
// Two register banks and a mode flag, and the mode flag is what makes it
// awkward: the 2-bit register at $4000 is the *upper* ROM bank bits in mode 0
// and the RAM bank in mode 1, and in mode 1 it also applies to the $0000-$3FFF
// window, which is how the 1MB cartridges reach their second half. Then there
// is the hole: bank $00 selected at $4000 reads as $01, and with the upper
// bits in play so do $20, $40 and $60 — four banks of every large MBC1
// cartridge are unreachable, and the games were built around it.
class Mbc1 extends Mbc {
  reset() { this.romBank = 1; this.ramBank = 0; this.ramEnabled = false; this.lo = 1; this.hi = 0; this.mode = 0; this._sync(); }

  _sync() {
    const lo = this.lo === 0 ? 1 : this.lo;       // the hole
    this.romBank = (this.hi << 5) | lo;
    this.ramBank = this.mode ? this.hi : 0;
  }

  bank0() { return this.mode ? ((this.hi << 5) % this.romBanks) : 0; }

  regWrite(addr, value) {
    if (addr < 0x2000) this.ramEnabled = (value & 0x0f) === 0x0a;
    else if (addr < 0x4000) { this.lo = value & 0x1f; this._sync(); }
    else if (addr < 0x6000) { this.hi = value & 3; this._sync(); }
    else { this.mode = value & 1; this._sync(); }
  }

  saveRegs() { return { lo: this.lo, hi: this.hi, mode: this.mode }; }
  loadRegs(r) { if (r) { this.lo = r.lo; this.hi = r.hi; this.mode = r.mode; this._sync(); } }
}

// HuC1 is Hudson's MBC1 work-alike. The difference is an infrared port behind
// the RAM enable register, which nothing here emulates — treating it as MBC1
// makes the games run and the IR link do nothing, which is what it does with
// no second Game Boy pointed at it anyway.
class HuC1 extends Mbc1 {}

// ---- MBC2 -----------------------------------------------------------------
// The odd one. Its 512 bytes of RAM are on the chip and only four bits wide —
// the upper nibble is not "unused", it is not connected, and a game that
// stores $F0 there reads back $0F | $F0 depending on what the bus was doing.
// $FX is the honest answer. The register decode is also unusual: bit 8 of the
// ADDRESS, not the address range, picks between "enable RAM" and "ROM bank".
class Mbc2 extends Mbc {
  reset() { this.romBank = 1; this.ramBank = 0; this.ramEnabled = false; }

  regWrite(addr, value) {
    if (addr < 0x4000) {
      if (addr & 0x0100) { this.romBank = (value & 0x0f) || 1; }
      else this.ramEnabled = (value & 0x0f) === 0x0a;
    }
  }

  readRam(off) {
    if (!this.ramEnabled) return 0xff;
    return this.ram[off & 0x1ff] | 0xf0;
  }

  writeRam(off, value) {
    if (!this.ramEnabled) return;
    this.ram[off & 0x1ff] = value & 0x0f;
    this.ramDirty = true;
  }
}

// ---- MBC3 -----------------------------------------------------------------
// MBC5's predecessor, plus a clock. Selecting $08-$0C at $4000 replaces the
// save RAM window with one of five RTC registers, and the clock is only copied
// into them when the game writes the latch sequence ($00 then $01) — so a game
// reading the seconds twice gets the same answer unless it latches again.
class Mbc3 extends Mbc {
  constructor(cart) { super(cart); this.wantsTick = cart.hasRtc; }

  reset() {
    this.romBank = 1; this.ramBank = 0; this.ramEnabled = false;
    this.rtcSelect = -1;      // -1 = the RAM window is RAM
    this.rtcLatchPrev = 0xff;
    // The live clock and the latched copy. Both are snapshot state.
    this.rtc = { s: 0, m: 0, h: 0, d: 0, halt: false, carry: false };
    this.rtcLatched = { s: 0, m: 0, h: 0, d: 0, halt: false, carry: false };
    this.rtcSubCycles = 0;
  }

  regWrite(addr, value) {
    if (addr < 0x2000) this.ramEnabled = (value & 0x0f) === 0x0a;
    else if (addr < 0x4000) this.romBank = (value & 0x7f) || 1; // the $00→$01 hole again, but only for bank 0
    else if (addr < 0x6000) {
      if (value >= 0x08 && value <= 0x0c) { this.rtcSelect = value - 0x08; }
      else { this.rtcSelect = -1; this.ramBank = value & 0x03; }
    } else {
      if (this.rtcLatchPrev === 0x00 && value === 0x01) this.rtcLatched = { ...this.rtc };
      this.rtcLatchPrev = value;
    }
  }

  readRam(off) {
    if (!this.ramEnabled) return 0xff;
    if (this.rtcSelect >= 0) return this._rtcReg(this.rtcSelect);
    return super.readRam(off);
  }

  writeRam(off, value) {
    if (!this.ramEnabled) return;
    if (this.rtcSelect >= 0) { this._rtcWrite(this.rtcSelect, value); return; }
    super.writeRam(off, value);
  }

  _rtcReg(i) {
    const r = this.rtcLatched;
    switch (i) {
      case 0: return r.s; case 1: return r.m; case 2: return r.h;
      case 3: return r.d & 0xff;
      default: return ((r.d >> 8) & 1) | (r.halt ? 0x40 : 0) | (r.carry ? 0x80 : 0);
    }
  }

  _rtcWrite(i, v) {
    const r = this.rtc;
    switch (i) {
      // Writing the seconds also resets the sub-second divider on hardware,
      // which is how a game sets the clock without it immediately ticking.
      case 0: r.s = v & 0x3f; this.rtcSubCycles = 0; break;
      case 1: r.m = v & 0x3f; break;
      case 2: r.h = v & 0x1f; break;
      case 3: r.d = (r.d & 0x100) | (v & 0xff); break;
      default: r.d = (r.d & 0xff) | ((v & 1) << 8); r.halt = !!(v & 0x40); r.carry = !!(v & 0x80); break;
    }
    this.rtcLatched = { ...r };
  }

  // Emulated time, not wall time — see the file header.
  tick(cycles) {
    if (!this.wantsTick || this.rtc.halt) return;
    this.rtcSubCycles += cycles;
    while (this.rtcSubCycles >= CYCLES_PER_SECOND) {
      this.rtcSubCycles -= CYCLES_PER_SECOND;
      const r = this.rtc;
      if (++r.s < 60) continue;
      r.s = 0;
      if (++r.m < 60) continue;
      r.m = 0;
      if (++r.h < 24) continue;
      r.h = 0;
      r.d = (r.d + 1) & 0x1ff;
      if (r.d === 0) r.carry = true; // 512 days, then a flag that never clears itself
    }
  }

  // An explicit input, so that "what time is it" enters the emulation once, at
  // a moment the player chose, instead of leaking in continuously.
  setRtcFromDate(date, epoch = null) {
    const base = epoch ? epoch.getTime() : new Date(date.getFullYear(), 0, 1).getTime();
    let secs = Math.max(0, Math.floor((date.getTime() - base) / 1000));
    this.rtc.s = secs % 60; secs = (secs / 60) | 0;
    this.rtc.m = secs % 60; secs = (secs / 60) | 0;
    this.rtc.h = secs % 24; secs = (secs / 24) | 0;
    this.rtc.d = secs & 0x1ff;
    this.rtcLatched = { ...this.rtc };
    return this;
  }

  saveRegs() {
    return {
      rtcSelect: this.rtcSelect, rtcLatchPrev: this.rtcLatchPrev,
      rtc: { ...this.rtc }, rtcLatched: { ...this.rtcLatched }, rtcSubCycles: this.rtcSubCycles,
    };
  }

  loadRegs(r) {
    if (!r) return;
    this.rtcSelect = r.rtcSelect; this.rtcLatchPrev = r.rtcLatchPrev;
    this.rtc = { ...r.rtc }; this.rtcLatched = { ...r.rtcLatched };
    this.rtcSubCycles = r.rtcSubCycles;
  }
}

// ---- MBC5 -----------------------------------------------------------------
// What MBC1 should have been. Nine bits of ROM bank in two registers that mean
// exactly what they say, four bits of RAM bank, no mode flag, and no hole:
// bank $000 really is bank $000, which is the one behavioural difference a
// game can see (an MBC1 game that writes 0 expects 1). Rumble carts steer the
// top bit of the RAM register to the motor instead of to an address line.
class Mbc5 extends Mbc {
  constructor(cart) { super(cart); this.hasRumble = cart.hasRumble; this.rumble = false; }
  reset() { this.romBank = 1; this.ramBank = 0; this.ramEnabled = false; this.rumble = false; }

  regWrite(addr, value) {
    if (addr < 0x2000) this.ramEnabled = (value & 0x0f) === 0x0a;
    else if (addr < 0x3000) this.romBank = (this.romBank & 0x100) | (value & 0xff);
    else if (addr < 0x4000) this.romBank = (this.romBank & 0xff) | ((value & 1) << 8);
    else if (addr < 0x6000) {
      if (this.hasRumble) { this.rumble = !!(value & 0x08); this.ramBank = value & 0x07; }
      else this.ramBank = value & 0x0f;
    }
  }

  saveRegs() { return { rumble: this.rumble }; }
  loadRegs(r) { if (r) this.rumble = !!r.rumble; }
}

// ---------------------------------------------------------------------------
// The registry. Adding a board is one class and one line.
export const MBCS = Object.freeze({
  none: NoMbc,
  mbc1: Mbc1,
  mbc2: Mbc2,
  mbc3: Mbc3,
  mbc5: Mbc5,
  huc1: HuC1,
});

export function createMbc(cart) {
  const Klass = MBCS[cart.mbc];
  if (!Klass) throw new GbRomError('UNSUPPORTED_MBC', `board "${cart.mbc}" (type $${cart.typeByte.toString(16)}) is not implemented`);
  return new Klass(cart);
}

export function tryCreateMbc(cart) {
  try { return { ok: true, mbc: createMbc(cart) }; }
  catch (e) { return { ok: false, code: e.code || 'ERROR', mbc: cart.mbc, error: e.message }; }
}

// A one-line human summary, for the host's status bar.
export function summarizeGbRom(cart) {
  const bits = [cart.title || '(no title)'];
  bits.push(`${(cart.romSize / 1024) | 0}KB`);
  bits.push(cart.mbc.toUpperCase());
  if (cart.ramSize) bits.push(`RAM ${cart.ramSize < 1024 ? `${cart.ramSize}B` : `${cart.ramSize / 1024}KB`}`);
  if (cart.hasBattery) bits.push('battery');
  if (cart.hasRtc) bits.push('RTC');
  if (cart.hasRumble) bits.push('rumble');
  if (cart.cgbOnly) bits.push('CGB専用');
  else if (cart.cgb) bits.push('CGB対応');
  if (cart.sgb) bits.push('SGB');
  return bits.join(' · ');
}
