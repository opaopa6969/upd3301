// mdrom — Mega Drive / Genesis cartridge images: the three shapes a dump comes
// in, and the 256-byte header the console never reads but everything else does.
//
// A .md/.bin/.gen file is usually a plain memory image, but two other layouts
// are still common in the wild and both look like garbage if you feed them to
// a 68000 as-is:
//
//   .smd  — the Super Magic Drive interleave: a 512-byte copier header, then
//           16 KB blocks in which the first 8 KB are all the ODD bytes of the
//           block and the second 8 KB all the EVEN bytes. Recognisable by the
//           file size: (len - 512) % 16384 == 0.
//   .md   — the Multi Game Doctor byte swap: every pair of bytes exchanged, so
//           "SEGA MEGA DRIVE" reads "ESAG EMAGD IRVE". No header at all, so it
//           has to be recognised from the content.
//
// Both are un-mangled here rather than in the machine, so machinemd.js only
// ever sees a big-endian byte image starting at address 0.
//
// Nothing in this file throws for a merely *odd* ROM: a dump with a bad
// checksum, a truncated tail or a nonsense region byte still boots on real
// hardware, so those become warnings on the parsed object and the caller
// decides. Only "this is not a cartridge at all" is an error, and
// tryParseMdRom() answers that with data too (the file picker in
// demo/machine.html meets junk as a matter of course).

export const SCHEMA_VERSION = 1;

const dec = new TextDecoder('latin1');

// Header fields, at their fixed offsets in the 256-byte block at $100. The
// console itself only cares about the vectors below $100; everything here is
// for the cartridge shell, the TMSS lockout and the region jumper.
const HDR = 0x100;
const OFF = {
  console: 0x100, copyright: 0x110, domestic: 0x120, overseas: 0x150,
  serial: 0x180, checksum: 0x18e, io: 0x190,
  romStart: 0x1a0, romEnd: 0x1a4, ramStart: 0x1a8, ramEnd: 0x1ac,
  sramSig: 0x1b0, sramType: 0x1b2, sramStart: 0x1b4, sramEnd: 0x1b8,
  modem: 0x1bc, notes: 0x1c8, region: 0x1f0,
};

const str = (b, off, len) => dec.decode(b.subarray(off, off + len)).replace(/\0/g, ' ').trimEnd();
const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

// ---- container un-mangling -------------------------------------------------

// The SMD interleave, undone one 16 KB block at a time. Blocks are independent,
// so a truncated file still yields every complete block it has.
export function deinterleaveSmd(bytes) {
  const body = bytes.subarray(512);
  const blocks = Math.floor(body.length / 16384);
  const out = new Uint8Array(blocks * 16384);
  for (let b = 0; b < blocks; b++) {
    const src = b * 16384, dst = b * 16384;
    for (let i = 0; i < 8192; i++) {
      out[dst + i * 2 + 1] = body[src + i];          // first half: odd bytes
      out[dst + i * 2] = body[src + 8192 + i];       // second half: even bytes
    }
  }
  return out;
}

export function byteSwap(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) { out[i] = bytes[i + 1]; out[i + 1] = bytes[i]; }
  if (bytes.length & 1) out[bytes.length - 1] = bytes[bytes.length - 1];
  return out;
}

const hasSegaTag = (b) => b.length > HDR + 4 && str(b, HDR, 4) === 'SEGA';
// "ESAG" is "SEGA" seen through the Multi Game Doctor's byte swap.
const hasSwappedTag = (b) => b.length > HDR + 4 && str(b, HDR, 4) === 'ESAG';

// The 68000's own criteria for "this is code": the reset PC is an even address
// inside the image and past the vector table, and the initial stack pointer is
// even and points at work RAM (or at least not into the middle of nowhere).
function looksBootable(b) {
  if (b.length < 0x400) return false;
  const pc = be32(b, 4), sp = be32(b, 0);
  if (pc & 1 || pc < 0x100 || pc >= b.length) return false;
  if (sp & 1) return false;
  const inRam = (sp & 0xff0000) === 0xff0000 || (sp >= 0xe00000 && sp <= 0xffffff);
  return inRam || sp === 0;
}

export function detectContainer(bytes) {
  if (bytes.length > 512 && (bytes.length - 512) % 16384 === 0) {
    // The SMD copier header's bytes 8 and 9 are $AA $BB on a genuine one, but
    // plenty of dumps have a zeroed header, so the size test carries the
    // decision and the un-interleaved result is checked for the SEGA tag.
    const flat = deinterleaveSmd(bytes);
    if (hasSegaTag(flat)) return 'smd';
  }
  if (hasSwappedTag(bytes)) return 'swapped';
  return 'plain';
}

// ---- header ----------------------------------------------------------------

// The region field went through three conventions and cartridges of all three
// are still sold, so all three are accepted and normalised to a set of flags.
// Old style: a free-form string containing J / U / E (often "JUE", or
// "U          " padded). New style (post-1994): one hex digit whose bits are
// 1=Japan NTSC, 2=Japan PAL, 4=Overseas NTSC, 8=Overseas PAL.
export function parseRegion(field) {
  const s = (field || '').trim();
  const flags = { japan: false, usa: false, europe: false };
  if (/^[0-9A-F]$/i.test(s)) {
    const n = parseInt(s, 16);
    if (n & 1) flags.japan = true;
    if (n & 4) flags.usa = true;
    if (n & 8) flags.europe = true;
    if (n & 2) flags.japan = true; // Japan PAL: no retail hardware, but claim it
  } else {
    if (s.includes('J')) flags.japan = true;
    if (s.includes('U')) flags.usa = true;
    if (s.includes('E')) flags.europe = true;
  }
  if (!flags.japan && !flags.usa && !flags.europe) flags.usa = true; // silent header
  return flags;
}

// The console's own view: NTSC or PAL, domestic or overseas. A cartridge that
// claims several regions is run in the first one this list matches, which is
// how a real multi-region cart behaves in whichever console it is plugged into.
export function preferredRegion(flags, want = null) {
  if (want && flags[want]) return want;
  if (flags.usa) return 'usa';
  if (flags.japan) return 'japan';
  return 'europe';
}

// The header checksum covers everything from $200 to the end of the ROM, added
// as big-endian words with 16-bit wraparound. Almost every retail cartridge has
// a correct one and a few deliberately do not, so a mismatch is a warning.
export function romChecksum(bytes) {
  let sum = 0;
  for (let i = 0x200; i + 1 < bytes.length; i += 2) sum = (sum + ((bytes[i] << 8) | bytes[i + 1])) & 0xffff;
  return sum;
}

// ---- parse -----------------------------------------------------------------

export function tryParseMdRom(bytes, { name = '' } = {}) {
  if (!bytes || bytes.length < 0x200) {
    return { ok: false, error: `ROMが小さすぎる (${bytes ? bytes.length : 0} bytes; 最低 512 bytes)` };
  }
  const container = detectContainer(bytes);
  let rom = bytes;
  if (container === 'smd') rom = deinterleaveSmd(bytes);
  else if (container === 'swapped') rom = byteSwap(bytes);

  const warnings = [];
  if (!hasSegaTag(rom)) {
    // No header — but the console does not read the header either, and a
    // hand-written test ROM may put its exception vectors right through $100
    // (all 256 of them fill $000-$3FF). The 68000 only needs vector 0 and 1 to
    // be sane, so that is what is checked before refusing.
    if (!looksBootable(rom)) {
      const seen = str(rom, HDR, 16).replace(/[^\x20-\x7e]/g, '.');
      return { ok: false, error: `$100 に "SEGA" が無く、リセットベクタも妥当でない (見えたのは "${seen}")。メガドライブのROMではないかも` };
    }
    warnings.push('SEGAヘッダが無い。リセットベクタが妥当なのでヘッダ無しROMとして読み込んだ');
  }
  const cart = {
    schemaVersion: SCHEMA_VERSION,
    name,
    container,
    rom,
    size: rom.length,
    consoleName: str(rom, OFF.console, 16),
    copyright: str(rom, OFF.copyright, 16),
    domesticName: str(rom, OFF.domestic, 48),
    overseasName: str(rom, OFF.overseas, 48),
    serial: str(rom, OFF.serial, 14),
    checksum: be16(rom, OFF.checksum),
    io: str(rom, OFF.io, 16),
    romStart: be32(rom, OFF.romStart),
    romEnd: be32(rom, OFF.romEnd),
    ramStart: be32(rom, OFF.ramStart),
    ramEnd: be32(rom, OFF.ramEnd),
    regionField: str(rom, OFF.region, 3),
    warnings,
  };
  cart.region = parseRegion(cart.regionField);
  cart.title = cart.overseasName || cart.domesticName || cart.serial || name;

  // Backup RAM. The signature is "RA"; $1B2 then says how it sits on the bus:
  // bit 6 set = backup RAM present, bits 4-3 = 11 odd bytes only, 10 even bytes
  // only, 00 both. Odd-only is by far the most common (an 8-bit SRAM chip wired
  // to /LDS), and getting it wrong silently corrupts every save.
  if (str(rom, OFF.sramSig, 2) === 'RA') {
    const type = rom[OFF.sramType];
    const start = be32(rom, OFF.sramStart), end = be32(rom, OFF.sramEnd);
    const width = ((type >> 3) & 3) === 3 ? 'odd' : ((type >> 3) & 3) === 2 ? 'even' : 'both';
    if (end >= start && end - start < 0x100000) {
      cart.sram = { start, end, width, size: width === 'both' ? (end - start + 1) : ((end - start) >> 1) + 1 };
    } else {
      warnings.push(`SRAMヘッダの範囲が変 ($${start.toString(16)}-$${end.toString(16)})。SRAM無しとして扱う`);
    }
  }

  // The declared ROM end is the last valid address, so a correct dump is
  // romEnd+1 bytes. Over- and under-sized dumps both run, so both are warnings.
  const declared = cart.romEnd + 1;
  if (cart.romEnd && declared !== rom.length) {
    warnings.push(`ヘッダのROM末尾 $${cart.romEnd.toString(16)} と実サイズ ${rom.length} が食い違う`);
  }
  const sum = romChecksum(rom);
  cart.checksumOk = sum === cart.checksum;
  if (!cart.checksumOk) {
    warnings.push(`チェックサム不一致 (ヘッダ $${cart.checksum.toString(16).padStart(4, '0')} / 実測 $${sum.toString(16).padStart(4, '0')})`);
  }
  if (container === 'smd') warnings.push('SMDインターリーブを解除して読み込んだ');
  if (container === 'swapped') warnings.push('バイトスワップ (.md) を解除して読み込んだ');

  return { ok: true, cart };
}

export function parseMdRom(bytes, opts) {
  const r = tryParseMdRom(bytes, opts);
  if (!r.ok) throw new Error(r.error);
  return r.cart;
}

export function summarizeMdRom(cart) {
  const regions = Object.entries(cart.region).filter(([, v]) => v).map(([k]) => k).join('/');
  return {
    title: cart.title,
    serial: cart.serial,
    sizeKb: Math.round(cart.size / 1024),
    regions,
    sram: cart.sram ? `${cart.sram.size}B @$${cart.sram.start.toString(16)} (${cart.sram.width})` : 'なし',
    checksum: cart.checksumOk ? 'ok' : 'NG',
  };
}
