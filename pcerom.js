// pcerom — PC Engine / TurboGrafx-16 HuCard image (.pce) reader.
//
// The counterpart to ines.js, and a much smaller job: a HuCard has no header,
// no board number and no wiring flags. It is a naked ROM. Everything the
// machine needs — how many banks, where they land in the HuC6280's 21-bit
// physical space, whether the cart carries a bank-switching mapper — has to be
// deduced from the file itself. So this module is mostly *inference*, and each
// inference here is one that a real .pce collection will otherwise turn into a
// black screen:
//
//   1. The 512-byte copier header. Some dumps carry one, most do not. The test
//      is arithmetic, not magic bytes: a HuCard is a whole number of 8KB banks,
//      so `size % 8192 == 512` means a header is glued to the front.
//   2. Bit-reversed dumps. A family of 1990s dumpers wired the ROM's data pins
//      backwards, so every byte in the file is bit-mirrored. Those files are
//      still traded today. Detection is by the reset vector (see isSaneReset).
//   3. Non-power-of-two sizes. 384KB and 768KB carts do NOT mirror the way the
//      modulo rule would suggest — the upper part repeats over a smaller
//      window. Getting this wrong boots the console into the middle of a bank.
//   4. Street Fighter II', the one HuCard with a mapper: 2.5MB behind four
//      switchable 512KB windows.
//
// Everything is plain data out. The machine holds the parsed cart by reference
// and no snapshot ever copies it (see docs/pce-design.md §6).

export const SCHEMA_VERSION = 1;

export const BANK_SIZE = 0x2000;   // the HuC6280 maps memory in 8KB pages
export const ROM_BANKS = 0x80;     // banks $00-$7F are cartridge space

// Physical bank numbers the console itself owns. Everything below $80 is the
// cartridge; these live at the top of the 21-bit space.
export const BANK_BRAM = 0xf7;     // battery-backed save RAM (2KB, mirrored)
export const BANK_WRAM = 0xf8;     // work RAM, 8KB (the SuperGrafx has 32KB)
export const BANK_IO = 0xff;       // VDC / VCE / PSG / timer / pad / IRQ

export const MAPPER = Object.freeze({
  NONE: 'none',
  SF2: 'sf2',        // Street Fighter II' Champion Edition, 2.5MB
});

export class PceRomError extends Error {
  constructor(code, message) { super(message); this.name = 'PceRomError'; this.code = code; }
}

// Bit-mirror lookup for reversed dumps (see reverseBits below).
const REVERSE8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i, r = 0;
    for (let b = 0; b < 8; b++) { r = (r << 1) | (v & 1); v >>= 1; }
    t[i] = r;
  }
  return t;
})();

export function reverseBits(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = REVERSE8[bytes[i]];
  return out;
}

// The HuC6280 comes out of reset with MPR7 = $00, so $E000-$FFFF is bank 0 and
// the reset vector at $FFFE is ROM offset $1FFE. The vector must therefore
// point somewhere the CPU can actually reach with only MPR7 set up, i.e. into
// $E000-$FFFF. That single constraint is a strong enough fingerprint to tell a
// good dump from a bit-reversed one — a reversed image puts a scrambled byte
// pair there, and the odds of it landing in the top 8KB by luck are 1 in 8.
function isSaneReset(rom) {
  if (rom.length < 0x2000) return false;
  const v = rom[0x1ffe] | (rom[0x1fff] << 8);
  return v >= 0xe000;
}

// ---- bank map ---------------------------------------------------------------
// Returns, for each of the 128 cartridge banks, the byte offset in `rom` it
// reads from (-1 = nothing there, reads come back as open bus).
//
// This is the part of a HuCard that nothing documents and that a wrong answer
// turns into a black screen, so it was MEASURED against the whole library
// rather than chosen. Two facts came out of that (docs/pce-design.md §3):
//
//   1. Sizes that are not a power of two — 384KB and 768KB — are two chips on
//      one board, and the smaller one does not decode the address lines the
//      bigger one needs. So the tail repeats inside its own window rather than
//      wrapping to the start of the cartridge. "offset % size" boots into the
//      middle of a bank.
//   2. Banks $40-$7F are NOT a mirror of $00-$3F. A cartridge over 256KB puts
//      its upper half there, and games really do map bank $45 expecting the
//      byte at $4A000. Devil's Crush is the one that proved it: it loads MPR2
//      with $45, jumps through a pointer in that bank, and lands in RAM if the
//      bank is a mirror of $05.
//
// `rule` exists so pcetools/sweep.mjs could run the library under each
// candidate and count. Callers should leave it alone.
export function buildBankMap(romLength, mapper = MAPPER.NONE, rule = 'hudson') {
  const map = new Int32Array(ROM_BANKS).fill(-1);
  if (mapper === MAPPER.SF2) {
    // Banks $00-$3F are the fixed first 512KB; $40-$7F is a window the cart
    // switches between four further 512KB chunks (see sf2Bank in machinepce).
    for (let b = 0; b < 0x40; b++) map[b] = b * BANK_SIZE;
    for (let b = 0x40; b < 0x80; b++) map[b] = 0x80000 + (b - 0x40) * BANK_SIZE;
    return map;
  }
  if (romLength <= 0) return map;
  const banks = Math.max(1, Math.ceil(romLength / BANK_SIZE));

  // The largest power of two that fits, and whatever is bolted on after it.
  let hi = 1;
  while (hi * 2 <= romLength) hi *= 2;
  const rest = romLength - hi;

  for (let b = 0; b < ROM_BANKS; b++) {
    let p = b * BANK_SIZE;                 // the flat 21-bit address the CPU asks for
    if (p >= romLength) {
      if (rule === 'modulo') p %= romLength;
      else if (rule === 'mirror') {
        // Fold to the next power of two, then let the small chip repeat inside
        // its own window: the textbook two-chip board.
        p %= hi * 2;
        if (p >= romLength) p = rest > 0 ? hi + ((p - hi) % rest) : (p % hi);
      } else if (romLength >= 0x40000) {
        // MEASURED (docs/pce-design.md §3). The address the board fails to
        // decode is A18, not the top one — so an out-of-range read comes back
        // 256KB lower, not from the start of the cartridge. That single
        // constant is what makes bank $45 of a 384KB card read $4A000, which
        // is where Devil's Crush keeps the pointer table it jumps through, and
        // it is worth 36 titles across the library on 512KB cards alone.
        while (p >= romLength) p -= 0x40000;
      } else {
        p %= romLength;
      }
    }
    map[b] = p;
  }
  return map;
}

// ---- parse ------------------------------------------------------------------
// Throws PceRomError for images that cannot be run at all; anything survivable
// lands in cart.warnings instead. The host entry point is tryParsePce().
export function parsePce(bytes, opts = {}) {
  if (!bytes || typeof bytes.length !== 'number') throw new PceRomError('empty', 'no data');
  let rom = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const warnings = [];
  if (rom.length < 0x2000) throw new PceRomError('too-small', `HuCard image is ${rom.length} bytes; the smallest bank is 8192`);

  // 1. Where does the cartridge actually start, and is it mirrored?
  //
  // Two independent kinds of damage, and they arrive together often enough that
  // testing for them separately does not work. A dump may carry a 512-byte
  // copier header, and it may have junk on the end (an old copier's comment
  // block) or be a few bytes short — and once there is trailing junk, "a
  // cartridge is a whole number of 8KB banks" stops being able to find the
  // header. So the reset vector decides, because it is the one byte pair whose
  // correct value is knowable a priori: it must point into $E000-$FFFF (see
  // isSaneReset). Arithmetic still picks the order of the candidates, so a
  // clean file is never second-guessed.
  const cands = rom.length % BANK_SIZE === 512 ? [512, 0] : [0, 512];
  let start = cands[0], bitReversed = false, found = false;
  if (opts.reverse === true) { start = cands[0]; bitReversed = true; found = true; }
  else {
    for (const off of cands) {
      if (rom.length < off + 0x2000) continue;
      const lo = rom[off + 0x1ffe], hi = rom[off + 0x1fff];
      if ((lo | (hi << 8)) >= 0xe000) { start = off; found = true; break; }
      if (opts.reverse !== false && (REVERSE8[lo] | (REVERSE8[hi] << 8)) >= 0xe000) {
        start = off; bitReversed = true; found = true; break;
      }
    }
  }
  let header = null;
  if (start) { header = rom.subarray(0, start); rom = rom.subarray(start); }
  if (bitReversed) warnings.push('bit-reversed dump; un-mirrored every byte');

  // Now square the length up to whole banks. A handful of stray bytes on the
  // end is junk and gets dropped; anything more is a download that stopped
  // early, and gets zero-padded — never handed to the CPU short, because a read
  // past the end of the array would come back undefined and be executed.
  const whole = Math.floor(rom.length / BANK_SIZE) * BANK_SIZE;
  const spare = rom.length - whole;
  if (spare > 0 && spare <= 2048 && whole > 0) {
    warnings.push(`${spare} trailing bytes are not part of any bank; dropped`);
    rom = rom.subarray(0, whole);
  } else if (spare > 0) {
    const padded = new Uint8Array(whole + BANK_SIZE);
    padded.set(rom);
    warnings.push(`image is ${padded.length - rom.length} bytes short of a whole bank; zero-padded`);
    rom = padded;
  }
  if (bitReversed) rom = reverseBits(rom);
  if (!found) {
    warnings.push(`reset vector $${((rom[0x1fff] << 8) | rom[0x1ffe]).toString(16).padStart(4, '0')} does not point into $E000-$FFFF`);
  }

  // 3. The one mapper. Recognised by size: no other HuCard is 2.5MB, and the
  // bank registers themselves are write-only so there is nothing else to see.
  const mapper = rom.length === 0x280000 ? MAPPER.SF2 : MAPPER.NONE;

  // 4. SuperGrafx. Its extra hardware (a second VDC and the VPC that mixes the
  // two) is not implemented, and a SuperGrafx-only title run on a plain PC
  // Engine draws half a picture rather than failing loudly — so say so here,
  // where it can be reported, instead of leaving it to be discovered on screen.
  const superGrafx = looksSuperGrafx(rom);
  if (superGrafx) warnings.push('SuperGrafx title: the second VDC and the VPC are not implemented');

  return {
    schemaVersion: SCHEMA_VERSION,
    rom,
    header,
    size: rom.length,
    banks: buildBankMap(rom.length, mapper),
    mapper,
    superGrafx,
    bitReversed,
    resetVector: rom[0x1ffe] | (rom[0x1fff] << 8),
    warnings,
  };
}

// SuperGrafx software talks to the second VDC through bank $FF pages $0010-$001F
// (the VPC) — addresses a plain PC Engine game never touches. Scanning for the
// store instructions that reach them is a heuristic, but it is the same one the
// name suffix "(SGX)" encodes, and it works on files whose names were lost.
function looksSuperGrafx(rom) {
  // ST0/ST1/ST2 cannot reach the VPC, so SGX code has to use ordinary stores to
  // $0008-$001F within the hardware bank. Look for the distinctive
  // "STA $1E00-ish" pattern by counting absolute stores into the VPC window.
  let hits = 0;
  for (let i = 0; i + 2 < rom.length; i++) {
    if (rom[i] !== 0x8d && rom[i] !== 0x9d) continue;   // STA abs / STA abs,X
    const a = rom[i + 1] | (rom[i + 2] << 8);
    if (a >= 0x0008 && a <= 0x001f) { if (++hits >= 8) return true; }
  }
  return false;
}

// Host entry point: never throws. A file picker gets junk as a matter of
// routine, and the page has to say what was wrong rather than break.
export function tryParsePce(bytes, opts) {
  try { return { ok: true, cart: parsePce(bytes, opts) }; }
  catch (e) {
    return { ok: false, code: e instanceof PceRomError ? e.code : 'error', error: e.message };
  }
}

export function summarizePce(cart) {
  const kb = Math.round(cart.size / 1024);
  return {
    size: cart.size,
    board: `HuCard ${kb}KB${cart.mapper !== MAPPER.NONE ? ` + ${cart.mapper.toUpperCase()}` : ''}`,
    mapper: cart.mapper,
    superGrafx: cart.superGrafx,
    bitReversed: cart.bitReversed,
    hadHeader: !!cart.header,
    resetVector: cart.resetVector,
    warnings: cart.warnings.slice(),
  };
}

// Build a minimal runnable image for tests, so no copyrighted ROM has to live
// in the repository (buildINes() in ines.js exists for the same reason).
// `code` is placed at the start of bank 0 and the reset vector points at
// $E000 + entry.
export function buildPce({ size = 0x8000, code = [], entry = 0x0000, header = false, vectors = {} } = {}) {
  const rom = new Uint8Array(size);
  rom.set(code, entry);
  const put = (off, v) => { rom[off] = v & 0xff; rom[off + 1] = (v >> 8) & 0xff; };
  // Bank 0 is what MPR7 sees at reset, so $1FF6-$1FFF is the vector table.
  put(0x1ff6, vectors.irq2 ?? 0xe000);
  put(0x1ff8, vectors.irq1 ?? 0xe000);
  put(0x1ffa, vectors.timer ?? 0xe000);
  put(0x1ffc, vectors.nmi ?? 0xe000);
  put(0x1ffe, vectors.reset ?? (0xe000 + entry));
  if (!header) return rom;
  const withHeader = new Uint8Array(512 + rom.length);
  withHeader.set(rom, 512);
  return withHeader;
}
