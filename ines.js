// ines — the Famicom/NES cartridge dump format (iNES and NES 2.0).
//
// A .nes file is not a memory image: it is a *cartridge* description. The
// console itself has almost nothing (2KB work RAM, 2KB video RAM); the
// game supplies its own program ROM, its own character ROM, its own
// mirroring wiring and often its own bank-switching logic. So the header
// mostly answers "what board is this?" — how many 16KB PRG banks, how many
// 8KB CHR banks, which mapper (board type) number, how the nametables are
// wired, whether there is a battery-backed save.
//
// Layout (16-byte header, then optional 512-byte trainer, then PRG, CHR):
//   0..3  "NES\x1a"
//   4     PRG-ROM size in 16KB units
//   5     CHR-ROM size in 8KB units (0 = the board has CHR-RAM instead)
//   6     flags: mirroring, battery, trainer, four-screen, mapper lo nibble
//   7     flags: console type, NES 2.0 marker (bits 2-3 == 2), mapper hi nibble
//   8..15 iNES 1.0: PRG-RAM size + junk; NES 2.0: mapper hi bits, submapper,
//         ROM size upper bits, RAM/NVRAM shift counts, timing, misc
//
// Two decades of bad tooling left mines in here, and the parser has to
// know them:
//   - "Dirty headers": old dumps wrote a ripper's name into bytes 7..15.
//     Trusting byte 7's mapper nibble on those gives mapper 0x4x nonsense,
//     so we ignore it when bytes 12..15 look like text.
//   - NES 2.0 exponent sizes: a size nibble of $F means the low byte is
//     "2^E * (2*MM+1) bytes", which is how oversize homebrew fits.
//   - Truncated files are common (bad downloads). We clamp and say so
//     rather than handing back a short PRG that reads as garbage.
//
// Pure, deterministic, zero deps. The parsed cartridge is plain data and
// is treated as IMMUTABLE: the machine keeps a reference to it and never
// puts it in a snapshot (see docs/nes-design.md — a rewind ring buffer
// cannot afford to copy a 512KB PRG a thousand times).

export const SCHEMA_VERSION = 1;

const MAGIC = [0x4e, 0x45, 0x53, 0x1a]; // "NES\x1a"
const HEADER_SIZE = 16;
const TRAINER_SIZE = 512;

// Nametable wiring. "four-screen" means the cartridge brought its own
// extra 2KB of VRAM, so all four nametables are distinct.
export const MIRRORING = Object.freeze({
  HORIZONTAL: 'horizontal',
  VERTICAL: 'vertical',
  FOUR_SCREEN: 'four-screen',
});

export const CONSOLE = Object.freeze({
  0: 'NES', 1: 'VS System', 2: 'PlayChoice-10', 3: 'Extended',
});

export const TIMING = Object.freeze({ 0: 'NTSC', 1: 'PAL', 2: 'multi', 3: 'Dendy' });

// Bad dumps are the normal case for a file picker, so the error is data,
// not control flow: it carries a code the host can branch on and a message
// a human can read.
export class INesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'INesError';
    this.code = code;
  }
}

export function isINes(bytes) {
  return !!bytes && bytes.length >= HEADER_SIZE && MAGIC.every((b, i) => bytes[i] === b);
}

// NES 2.0 size fields: a high nibble of $F switches the low byte from a
// plain count to "2^E * (2*MM+1)" units, where the byte is EEEEEEMM.
function sizeUnits(lo, hi, unitBytes) {
  if (hi === 0x0f) {
    const exp = lo >> 2, mult = (lo & 3) * 2 + 1;
    return { bytes: Math.pow(2, exp) * mult, exponent: true };
  }
  return { bytes: ((hi << 8) | lo) * unitBytes, exponent: false };
}

// NES 2.0 RAM fields are shift counts: 0 means none, n means 64 << n.
const shiftBytes = (n) => (n === 0 ? 0 : 64 << n);

// Parse a .nes file. Throws INesError (with a code) on anything the caller
// cannot sensibly run; warnings for survivable damage land in `warnings`.
export function parseINes(bytes) {
  if (!bytes || bytes.length < HEADER_SIZE) {
    throw new INesError('too-short', `not a .nes file: ${bytes ? bytes.length : 0} bytes, need at least 16`);
  }
  if (!isINes(bytes)) {
    const head = Array.from(bytes.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join(' ');
    throw new INesError('bad-magic', `not a .nes file: header starts with ${head}, expected "NES<1a>"`);
  }

  const warnings = [];
  const f6 = bytes[6];
  let f7 = bytes[7];

  // Dirty header detection: rippers of the 90s typed their handle into the
  // tail of the header. Bytes 12..15 holding printable ASCII is the tell.
  const tail = bytes.subarray(12, 16);
  const dirty = [...tail].some((b) => b >= 0x20 && b < 0x7f);
  const nes2 = !dirty && (f7 & 0x0c) === 0x08;
  if (dirty) {
    warnings.push('dirty header (ripper text in bytes 12..15) — high mapper bits ignored');
    f7 = 0;
  }

  const trainer = (f6 & 0x04) !== 0;
  const battery = (f6 & 0x02) !== 0;
  const mirroring = (f6 & 0x08) ? MIRRORING.FOUR_SCREEN
    : (f6 & 0x01) ? MIRRORING.VERTICAL : MIRRORING.HORIZONTAL;

  let mapper = (f6 >> 4) | (f7 & 0xf0);
  let submapper = 0;
  let prgBytes, chrBytes;
  let prgRam = 0, prgNvram = 0, chrRam = 0, chrNvram = 0;
  let timing = TIMING[0];

  if (nes2) {
    mapper |= (bytes[8] & 0x0f) << 8;
    submapper = bytes[8] >> 4;
    prgBytes = sizeUnits(bytes[4], bytes[9] & 0x0f, 16 * 1024).bytes;
    chrBytes = sizeUnits(bytes[5], bytes[9] >> 4, 8 * 1024).bytes;
    prgRam = shiftBytes(bytes[10] & 0x0f);
    prgNvram = shiftBytes(bytes[10] >> 4);
    chrRam = shiftBytes(bytes[11] & 0x0f);
    chrNvram = shiftBytes(bytes[11] >> 4);
    timing = TIMING[bytes[12] & 3];
  } else {
    prgBytes = bytes[4] * 16 * 1024;
    chrBytes = bytes[5] * 8 * 1024;
    // iNES 1.0 byte 8 is "PRG-RAM in 8KB units", and 0 conventionally means
    // one bank (the field was added late; every emulator reads it this way).
    prgRam = (bytes[8] || 1) * 8 * 1024;
    if (battery) prgNvram = prgRam;
    // CHR size 0 means the board carries 8KB of CHR-RAM. Only NES 2.0 can
    // say "more than 8KB", so 1.0 dumps get the universal default.
    if (chrBytes === 0) chrRam = 8 * 1024;
    if (!dirty && (bytes[9] & 1)) timing = TIMING[1];
  }
  if (nes2 && chrBytes === 0 && chrRam === 0) {
    // A NES 2.0 header that declares neither CHR-ROM nor CHR-RAM is broken;
    // 8KB is the only choice that lets the game render anything.
    chrRam = 8 * 1024;
    warnings.push('NES 2.0 header declares no CHR-ROM and no CHR-RAM — assuming 8KB CHR-RAM');
  }

  if (prgBytes === 0) throw new INesError('no-prg', 'header declares 0 bytes of PRG-ROM — nothing to execute');

  let off = HEADER_SIZE;
  let trainerData = null;
  if (trainer) {
    if (bytes.length < off + TRAINER_SIZE) {
      throw new INesError('truncated-trainer', `header says trainer present but the file ends after ${bytes.length - off} of 512 bytes`);
    }
    trainerData = bytes.slice(off, off + TRAINER_SIZE);
    off += TRAINER_SIZE;
  }

  const avail = bytes.length - off;
  if (avail < prgBytes) {
    // Truncated download. Zero-fill so the CPU sees BRK ($00) instead of
    // reading off the end into undefined; the warning lets the host say why
    // the game died.
    warnings.push(`truncated: PRG-ROM is ${avail} of ${prgBytes} bytes — missing tail zero-filled`);
  }
  const prg = new Uint8Array(prgBytes);
  prg.set(bytes.subarray(off, Math.min(bytes.length, off + prgBytes)));
  off += prgBytes;

  let chr = null;
  if (chrBytes > 0) {
    const availChr = Math.max(0, bytes.length - off);
    if (availChr < chrBytes) {
      warnings.push(`truncated: CHR-ROM is ${availChr} of ${chrBytes} bytes — missing tail zero-filled`);
    }
    chr = new Uint8Array(chrBytes);
    chr.set(bytes.subarray(off, Math.min(bytes.length, off + chrBytes)));
    off += chrBytes;
  }

  const trailing = bytes.length - off;
  if (trailing > 0) warnings.push(`${trailing} trailing bytes after CHR-ROM (title block or padding) — ignored`);

  return {
    schemaVersion: SCHEMA_VERSION,
    format: nes2 ? 'NES 2.0' : 'iNES',
    mapper, submapper,
    mirroring, battery, fourScreen: mirroring === MIRRORING.FOUR_SCREEN,
    console: CONSOLE[nes2 ? (bytes[7] & 3) : (f7 & 3)] ?? 'NES',
    timing,
    prg, chr,
    prgSize: prgBytes, chrSize: chrBytes,
    prgRam, prgNvram, chrRam, chrNvram,
    trainer: trainerData,
    warnings,
  };
}

// Host-facing wrapper: a file picker hands us whatever the user dropped, so
// "this is not a NES ROM" is an ordinary answer, not an exception.
export function tryParseINes(bytes) {
  try {
    return { ok: true, cart: parseINes(bytes) };
  } catch (e) {
    if (e instanceof INesError) return { ok: false, code: e.code, error: e.message };
    return { ok: false, code: 'internal', error: String(e && e.message ? e.message : e) };
  }
}

// Known board names for the mappers this project cares about. Unknown
// numbers are reported as-is — the point is to tell the user "your ROM
// needs a board we have not built yet", not to pretend.
const BOARDS = Object.freeze({
  0: 'NROM', 1: 'MMC1 (SxROM)', 2: 'UxROM', 3: 'CNROM', 4: 'MMC3 (TxROM)',
  5: 'MMC5 (ExROM)', 7: 'AxROM', 9: 'MMC2 (PxROM)', 10: 'MMC4 (FxROM)',
  11: 'Color Dreams', 66: 'GxROM', 71: 'Camerica', 118: 'TxSROM', 119: 'TQROM',
});

export function boardName(mapper) {
  return BOARDS[mapper] ?? `mapper ${mapper}`;
}

// Human summary — what the demo shows about an inserted cartridge.
export function summarizeINes(cart) {
  return {
    schemaVersion: SCHEMA_VERSION,
    format: cart.format,
    mapper: cart.mapper,
    board: boardName(cart.mapper),
    submapper: cart.submapper,
    mirroring: cart.mirroring,
    battery: cart.battery,
    console: cart.console,
    timing: cart.timing,
    prgKB: cart.prgSize / 1024,
    chrKB: cart.chrSize / 1024,
    chrRamKB: cart.chrRam / 1024,
    prgRamKB: cart.prgRam / 1024,
    trainer: !!cart.trainer,
    warnings: cart.warnings,
  };
}

// Build a .nes image. Tests use it to make cartridges without shipping
// copyrighted ROMs; tools use it to author homebrew images.
export function buildINes({
  prg, chr = null, mapper = 0, submapper = 0,
  mirroring = MIRRORING.HORIZONTAL, battery = false, trainer = null,
  nes2 = false, prgRam = 0, chrRam = 0, timing = 0,
} = {}) {
  if (!prg || !prg.length) throw new INesError('no-prg', 'buildINes needs PRG-ROM bytes');
  const prgUnits = Math.ceil(prg.length / (16 * 1024));
  const chrUnits = chr ? Math.ceil(chr.length / (8 * 1024)) : 0;
  const header = new Uint8Array(16);
  header.set(MAGIC);
  header[4] = prgUnits & 0xff;
  header[5] = chrUnits & 0xff;
  header[6] = ((mapper & 0x0f) << 4)
    | (mirroring === MIRRORING.FOUR_SCREEN ? 0x08 : 0)
    | (trainer ? 0x04 : 0) | (battery ? 0x02 : 0)
    | (mirroring === MIRRORING.VERTICAL ? 0x01 : 0);
  header[7] = (mapper & 0xf0) | (nes2 ? 0x08 : 0);
  if (nes2) {
    header[8] = ((mapper >> 8) & 0x0f) | ((submapper & 0x0f) << 4);
    header[9] = ((prgUnits >> 8) & 0x0f) | (((chrUnits >> 8) & 0x0f) << 4);
    header[10] = ramShift(prgRam);
    header[11] = ramShift(chrRam);
    header[12] = timing & 3;
  }
  const body = [header];
  if (trainer) body.push(padTo(trainer, TRAINER_SIZE));
  body.push(padTo(prg, prgUnits * 16 * 1024));
  if (chr) body.push(padTo(chr, chrUnits * 8 * 1024));
  const total = body.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of body) { out.set(part, o); o += part.length; }
  return out;
}

function ramShift(bytes) {
  if (!bytes) return 0;
  let n = 0;
  while ((64 << n) < bytes && n < 15) n++;
  return n;
}

function padTo(src, len) {
  if (src.length === len) return src;
  const out = new Uint8Array(len);
  out.set(src.subarray(0, Math.min(src.length, len)));
  return out;
}
