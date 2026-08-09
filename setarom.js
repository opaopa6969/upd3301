// setarom — reading a MAME ROM set for the Seta arcade boards.
//
// A console cartridge is one file: mdrom.js parses a header and it is done. An
// arcade board is a dozen mask ROMs soldered to a PCB, and what a "ROM set"
// distributes is exactly that — one file per chip, in a zip named after the
// game. Turning those back into something a CPU can address means knowing how
// the chips were wired, and that is what this file holds.
//
// ## Two wiring patterns, and why the difference matters
//
// A 68000 fetches 16 bits at a time from two 8-bit ROMs in parallel: one chip
// answers on D15-D8 (even addresses), the other on D7-D0 (odd). So a program
// ROM pair is INTERLEAVED — byte 0 from the first chip, byte 1 from the second,
// byte 2 from the first. Get this backwards and the very first thing that
// happens is that the reset vector reads as garbage and the CPU dies before
// executing an instruction. MAME writes this as ROM_LOAD16_BYTE with a start
// offset of 0 or 1; here it is `at` plus `step: 2`.
//
// Graphics ROMs on the same board can be wired EITHER way, and Seta used both:
// thunderl's sprite ROMs are an interleaved pair per bitplane group, while
// krzybowl's are plain contiguous halves. There is no way to tell from the
// files themselves — a wrong guess produces a picture that is recognisably
// "sprites, but shredded". The table below records what the board does.
//
// ## Why CRC32 and not filenames
//
// The same ROM content circulates under many names: `t17` in one dump, `25.a10`
// in another, `un001008.7l` in a third. Sets get renamed, reorganised into
// subdirectories, or merged parent/clone. Matching on the 32-bit CRC that MAME
// publishes makes all of that irrelevant and, as a bonus, says out loud when a
// chip is a bad dump rather than silently building a board that will not boot.
// Names are kept as a fallback for sets whose bytes we have not seen.
//
// Nothing here is loaded from disk or from the network: the caller hands over
// bytes (a zip, or a bag of files) and gets regions back. The ROMs are never
// part of a snapshot — see docs/seta-design.md.

import { unzip } from './zip.js';

export const SCHEMA_VERSION = 1;

// ---- CRC32 -----------------------------------------------------------------
// The reflected IEEE polynomial, the one zip and MAME both use. Table built
// once; a 1 MB region costs about a millisecond.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- the sets --------------------------------------------------------------
// `regions` are the address spaces a board decodes:
//   maincpu  the 68000's program, mapped at 0
//   gfx1     sprite tiles for the X1-001 (see x1001.js for the bitplane layout)
//   x1snd    sample ROM the X1-010 reads directly, not visible to the CPU
//
// Each chip is { names, size, crc, at, step }: `at` is the byte offset in the
// region where the chip's first byte lands and `step` is how far to advance
// per source byte — 2 for one half of a 16-bit pair, 1 for a contiguous chip.
//
// `board` names the wiring in machineseta.js. Everything about the machine
// other than the ROM layout lives there; this table is only about bytes.

export const SETA_SETS = Object.freeze({
  thunderl: {
    title: 'Thunder & Lightning', year: 1990, maker: 'Seta', board: 'thunderl',
    regions: {
      maincpu: { size: 0x010000, chips: [
        { names: ['m4', '20.g11', 'g11'], size: 0x8000, crc: 0x1e6b9462, at: 0, step: 2 },
        { names: ['m5', '19.f11', 'f11'], size: 0x8000, crc: 0x7e82793e, at: 1, step: 2 },
      ] },
      gfx1: { size: 0x080000, chips: [
        { names: ['t17', '25.a10', 'a10'], size: 0x20000, crc: 0x599a632a, at: 0x00000, step: 2 },
        { names: ['t16', '24.a8', 'a8'], size: 0x20000, crc: 0x3aeef91c, at: 0x00001, step: 2 },
        { names: ['t15', '23.a5', 'a5'], size: 0x20000, crc: 0xb97a7b56, at: 0x40000, step: 2 },
        { names: ['t14', '22.a3', 'a3'], size: 0x20000, crc: 0x79c707be, at: 0x40001, step: 2 },
      ] },
      x1snd: { size: 0x100000, optional: true, chips: [
        { names: ['r28'], size: 0x80000, crc: 0xa043615d, at: 0x00000, step: 1 },
        { names: ['r27'], size: 0x80000, crc: 0xcb8425a3, at: 0x80000, step: 1 },
      ] },
    },
  },

  thunderla: {
    title: 'Thunder & Lightning (set 2)', year: 1990, maker: 'Seta', board: 'thunderl',
    parent: 'thunderl',
    regions: {
      maincpu: { size: 0x010000, chips: [
        { names: ['tl-1-1.u1'], size: 0x8000, crc: 0x3d4b1888, at: 0, step: 2 },
        { names: ['tl-1-2.u4'], size: 0x8000, crc: 0x974dddda, at: 1, step: 2 },
      ] },
      gfx1: { size: 0x080000, chips: [
        { names: ['t17'], size: 0x20000, crc: 0x599a632a, at: 0x00000, step: 2 },
        { names: ['t16'], size: 0x20000, crc: 0x3aeef91c, at: 0x00001, step: 2 },
        { names: ['t15'], size: 0x20000, crc: 0xb97a7b56, at: 0x40000, step: 2 },
        { names: ['t14'], size: 0x20000, crc: 0x79c707be, at: 0x40001, step: 2 },
      ] },
      x1snd: { size: 0x100000, optional: true, chips: [
        { names: ['r28'], size: 0x80000, crc: 0xa043615d, at: 0x00000, step: 1 },
        { names: ['r27'], size: 0x80000, crc: 0xcb8425a3, at: 0x80000, step: 1 },
      ] },
    },
  },

  // Same PCB as thunderl minus the protection PAL, plus two more player ports.
  wits: {
    title: "Wit's", year: 1989, maker: 'Athena (Visco license)', board: 'wits',
    regions: {
      maincpu: { size: 0x010000, chips: [
        { names: ['un001001.u1'], size: 0x8000, crc: 0x416c567e, at: 0, step: 2 },
        { names: ['un001002.u4'], size: 0x8000, crc: 0x497a3fa6, at: 1, step: 2 },
      ] },
      gfx1: { size: 0x080000, chips: [
        { names: ['un001008.7l'], size: 0x20000, crc: 0x1d5d0b2b, at: 0x00000, step: 2 },
        { names: ['un001007.5l'], size: 0x20000, crc: 0x9e1e6d51, at: 0x00001, step: 2 },
        { names: ['un001006.4l'], size: 0x20000, crc: 0x98a980d4, at: 0x40000, step: 2 },
        { names: ['un001005.2l'], size: 0x20000, crc: 0x6f2ce3c0, at: 0x40001, step: 2 },
      ] },
      x1snd: { size: 0x040000, optional: true, chips: [
        { names: ['un001004.12a'], size: 0x20000, crc: 0xa15ff938, at: 0x00000, step: 1 },
        { names: ['un001003.10a'], size: 0x20000, crc: 0x3f4b9e55, at: 0x20000, step: 1 },
      ] },
    },
  },

  // A later board: bigger program, trackballs, a scanline timer instead of a
  // plain vblank interrupt, and — note — sprite ROMs that are NOT interleaved.
  krzybowl: {
    title: 'Krazy Bowl', year: 1994, maker: 'American Sammy', board: 'krzybowl',
    regions: {
      maincpu: { size: 0x080000, chips: [
        { names: ['fv001.002'], size: 0x40000, crc: 0x8c03c75f, at: 0, step: 2 },
        { names: ['fv001.001'], size: 0x40000, crc: 0xf0630beb, at: 1, step: 2 },
      ] },
      gfx1: { size: 0x100000, chips: [
        { names: ['fv001.003'], size: 0x80000, crc: 0x7de22749, at: 0x00000, step: 1 },
        { names: ['fv001.004'], size: 0x80000, crc: 0xc7d2fe32, at: 0x80000, step: 1 },
      ] },
      x1snd: { size: 0x100000, optional: true, chips: [
        { names: ['fv001.005'], size: 0x80000, crc: 0x5e206062, at: 0x00000, step: 1 },
        { names: ['fv001.006'], size: 0x80000, crc: 0x572a15e7, at: 0x80000, step: 1 },
      ] },
    },
  },
});

export function listSetaSets() {
  return Object.keys(SETA_SETS).map((k) => ({
    set: k, ...SETA_SETS[k], regions: undefined,
  }));
}

// ---- input normalisation ---------------------------------------------------
// Accept whatever the caller has: a Map, a plain object, an array of
// { name, bytes }, or the array zip.js already returns. Directory prefixes are
// stripped — a set unpacked into `thunderl/m4` is the same board as `m4`.
function normalizeFiles(files) {
  const out = [];
  const push = (name, bytes) => {
    if (!bytes) return;
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const base = String(name).replace(/\\/g, '/').split('/').pop().toLowerCase();
    out.push({ name: base, full: String(name), bytes: b });
  };
  if (!files) return out;
  if (Array.isArray(files)) for (const f of files) push(f.name, f.bytes ?? f.data);
  else if (files instanceof Map) for (const [k, v] of files) push(k, v);
  else for (const k of Object.keys(files)) push(k, files[k]);
  return out;
}

// ---- matching --------------------------------------------------------------
// Files are matched to chips CRC-first. The CRC is computed lazily and cached
// on the entry, because a set can hold megabytes we never need.
function crcOf(entry) {
  if (entry._crc === undefined) entry._crc = crc32(entry.bytes);
  return entry._crc;
}

function findChip(entries, chip) {
  for (const e of entries) {
    if (e.used) continue;
    if (e.bytes.length === chip.size && crcOf(e) === chip.crc) return { entry: e, how: 'crc' };
  }
  for (const e of entries) {
    if (e.used) continue;
    if (!chip.names.includes(e.name)) continue;
    // A name match with the wrong length is a truncated or padded dump; a name
    // match with the wrong CRC is a different revision. Both are worth saying.
    return { entry: e, how: e.bytes.length === chip.size ? 'name (CRC mismatch)' : 'name (size mismatch)' };
  }
  return null;
}

// Score how well a bag of files fits each known set. Used to pick a set when
// the caller just says "here is a zip".
export function identifySetaSet(files) {
  const entries = normalizeFiles(files);
  const crcs = new Set();
  for (const e of entries) crcs.add(crcOf(e));
  const scored = [];
  for (const set of Object.keys(SETA_SETS)) {
    const info = SETA_SETS[set];
    let need = 0, have = 0;
    for (const rn of Object.keys(info.regions)) {
      for (const chip of info.regions[rn].chips) {
        need++;
        if (crcs.has(chip.crc)) have++;
      }
    }
    if (have) scored.push({ set, have, need, score: have / need });
  }
  scored.sort((a, b) => b.score - a.score || b.have - a.have);
  return scored;
}

// Assemble one region from the chips that were found. Bytes not covered by any
// chip stay 0xff, which is what an unpopulated socket reads as.
function buildRegion(entries, region, report) {
  const out = new Uint8Array(region.size).fill(0xff);
  let found = 0;
  for (const chip of region.chips) {
    const m = findChip(entries, chip);
    if (!m) { report.missing.push({ chip: chip.names[0], size: chip.size, crc: chip.crc }); continue; }
    m.entry.used = true;
    found++;
    report.matched.push({ chip: chip.names[0], file: m.entry.full, how: m.how });
    const src = m.entry.bytes;
    const n = Math.min(src.length, chip.size);
    if (chip.step === 1) {
      out.set(src.subarray(0, Math.min(n, region.size - chip.at)), chip.at);
    } else {
      // The interleave. Writing it as a loop rather than a clever stride keeps
      // the "which chip owns which byte" question answerable by reading it.
      let d = chip.at;
      for (let i = 0; i < n && d < region.size; i++, d += chip.step) out[d] = src[i];
    }
  }
  return { bytes: out, found };
}

// Build every region of `set` from `files`. Throws only when a region the
// machine cannot start without is empty; a missing sample ROM is a warning,
// because a board with no X1-010 still boots and draws.
export function buildSetaSet(files, set) {
  const info = SETA_SETS[set];
  if (!info) throw new Error(`unknown Seta set: ${set}`);
  const entries = normalizeFiles(files);
  const report = { set, matched: [], missing: [], warnings: [] };
  const regions = {};
  for (const rn of Object.keys(info.regions)) {
    const region = info.regions[rn];
    const built = buildRegion(entries, region, report);
    regions[rn] = built.bytes;
    if (built.found === 0) {
      if (region.optional) report.warnings.push(`region ${rn} is empty (${set} will run without it)`);
      else throw new Error(`${set}: region ${rn} has none of its ${region.chips.length} ROMs`);
    } else if (built.found < region.chips.length) {
      report.warnings.push(`region ${rn}: ${built.found}/${region.chips.length} ROMs found`);
    }
  }
  const byName = report.matched.filter((m) => m.how !== 'crc');
  if (byName.length) report.warnings.push(`${byName.length} ROM(s) matched by name, not CRC — content may differ`);
  return {
    schemaVersion: SCHEMA_VERSION,
    set, title: info.title, year: info.year, maker: info.maker, board: info.board,
    regions, ...report,
  };
}

// The convenience door: hand over the bytes of a MAME set zip (or a bag of
// already-extracted files) and get a board back. `set` may be forced; without
// it the best CRC match wins, and a zip that is not a Seta set says so.
export async function loadSetaRomSet(input, { set = null, name = '' } = {}) {
  let files = input;
  const bytes = input instanceof Uint8Array ? input
    : (input && input.buffer && !Array.isArray(input)) ? new Uint8Array(input.buffer) : null;
  if (bytes && bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) files = await unzip(bytes);
  const entries = normalizeFiles(files);
  if (!entries.length) throw new Error('no files to load');
  let chosen = set;
  if (!chosen) {
    // A zip named after the set is a strong hint, but the bytes decide.
    const hint = String(name).split('/').pop().replace(/\.zip$/i, '').toLowerCase();
    const scored = identifySetaSet(entries);
    if (!scored.length) throw new Error('not a known Seta ROM set (no ROM CRC matched)');
    const hinted = scored.find((s) => s.set === hint);
    chosen = (hinted && hinted.score > 0) ? hinted.set : scored[0].set;
  }
  return buildSetaSet(entries, chosen);
}

export default { SETA_SETS, buildSetaSet, loadSetaRomSet, identifySetaSet, listSetaSets, crc32 };
