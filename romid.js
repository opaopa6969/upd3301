// romid — pure identification of PC-8001 / PC-8801 ROM and disk images.
//
// Two jobs, both of which the UI and the server-side library need to agree on:
//
//   1. AUTO-RECOGNITION. A user drops a folder (or a whole BIOS zip) on the
//      importer. Each file has to become a ROLE — the key romstore.js/the system
//      library store it under — without asking. Filenames are the signal the
//      real dumps actually carry (n88.rom, n88_0..3.rom, disk.rom, n80.rom,
//      font.rom, kanji1.rom …), so this is an ALLOWLIST keyed on the basename.
//
//   2. REJECTION. "88/80 用以外の ROM は import しない". An allowlist gives that
//      for free: anything not recognised returns null and never enters the
//      library. That keeps a 1000-image library free of PC-98/MSX/readme junk.
//
// Sizes are recorded for a sanity WARNING, never as a hard gate — dumps vary
// (disk.rom is 2KB on early machines, 8KB on the MC; N80.ROM is 24KB or 32KB
// depending on model) and refusing a good dump over a size table is worse than
// importing it with a note.
//
// Pure, dependency-free, deterministic — headless-testable (romid.test.mjs).

export const SCHEMA_VERSION = 1;

// Disk and tape containers the emulator can mount (zip.js unpacks archives
// before we ever see them, so no .zip here).
export const DISK_RE = /\.(d88|88d|d77|d8u|hdm|tfd|xdf)$/i;
export const TAPE_RE = /\.(t88|cas|cmt)$/i;

// basename (lowercased) → role + label. `supported:false` marks a genuine
// PC-8801-family dump the emulator cannot boot from yet: worth keeping in the
// library (it IS an 88 ROM) but the machine builder must not offer it.
const ROM_TABLE = {
  // ---- PC-8801 N88 mode (the set that can boot game disks) ----------------
  'n88.rom': { role: 'n88main', label: 'N88 メインROM', sizes: [0x8000] },
  'n88_0.rom': { role: 'n88ext0', label: 'N88 拡張バンク0', sizes: [0x2000] },
  'n88_1.rom': { role: 'n88ext1', label: 'N88 拡張バンク1', sizes: [0x2000] },
  'n88_2.rom': { role: 'n88ext2', label: 'N88 拡張バンク2', sizes: [0x2000] },
  'n88_3.rom': { role: 'n88ext3', label: 'N88 拡張バンク3', sizes: [0x2000] },
  // the four banks as one 32KB image (roms/<machine>/N88EXT.ROM ships this way)
  'n88ext.rom': { role: 'n88ext', label: 'N88 拡張ROM(32KB一体)', sizes: [0x8000] },
  'n88mid.rom': { role: 'n88mid', label: 'N88 中間ROM', sizes: [0x6000], supported: false },
  'disk.rom': { role: 'n88sub', label: 'FDD サブCPU ROM', sizes: [0x800, 0x2000] },
  // ---- PC-8001 / N-BASIC --------------------------------------------------
  'n80.rom': { role: 'rom', label: 'N-BASIC ROM (N80)', sizes: [0x6000, 0x8000] },
  'n80_2.rom': { role: 'rom', label: 'PC-8001mkII N80 ROM', sizes: [0x8000] },
  'n80sr.rom': { role: 'rom', label: 'PC-8801 N80SR ROM', sizes: [0x8000] },
  '8801-n80.rom': { role: 'rom', label: 'PC-8801 N80 ROM', sizes: [0x6000, 0x8000] },
  '8801-n88.rom': { role: 'n88main', label: 'PC-8801 N88 ROM', sizes: [0x8000] },
  '8801-4th.rom': { role: 'n88fourth', label: 'PC-8801 第4水準ROM', sizes: [0x2000], supported: false },
  // ---- fonts / kanji ------------------------------------------------------
  'font.rom': { role: 'font', label: 'CGROM(フォント)', sizes: [0x800, 0x1000, 0x1800] },
  'font88.rom': { role: 'font', label: 'CGROM(PC-8801)', sizes: [0x800, 0x1000, 0x1800] },
  'kanji1.rom': { role: 'n88kanji', label: '漢字ROM 第1水準', sizes: [0x20000] },
  'kanji2.rom': { role: 'n88kanji2', label: '漢字ROM 第2水準', sizes: [0x20000], supported: false },
  // ---- model-specific extras (kept, not bootable on their own) ------------
  'cdbios.rom': { role: 'n88cdbios', label: 'CD-ROM BIOS (8801MC)', sizes: [0x10000], supported: false },
  'jisyo.rom': { role: 'n88jisyo', label: '辞書ROM', sizes: [0x80000], supported: false },
  'pc88.rom': { role: 'pc88all', label: 'PC-8801 統合ROMイメージ', sizes: [0x1c000], supported: false },
  'pc88va.rom': { role: 'pc88va', label: 'PC-88VA ROM', sizes: [0x1c000], supported: false },
};

export function basename(name) {
  return String(name || '').replace(/^.*[/\\]/, '').toLowerCase();
}

// Identify one file. Returns null for anything that is not a PC-8001/8801 ROM,
// disk or tape image — the caller must skip those (that IS the import filter).
// `size` is optional; when given, a mismatch against the table sets `sizeWarn`.
export function identify({ name, size = null } = {}) {
  const b = basename(name);
  if (!b) return null;
  if (DISK_RE.test(b)) {
    return { schemaVersion: SCHEMA_VERSION, kind: 'disk', role: null, label: 'ディスクイメージ', supported: true, sizeWarn: false };
  }
  if (TAPE_RE.test(b)) {
    return { schemaVersion: SCHEMA_VERSION, kind: 'tape', role: null, label: 'テープイメージ', supported: true, sizeWarn: false };
  }
  const e = ROM_TABLE[b];
  if (!e) return null; // not an 88/80 file → never imported
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'rom',
    role: e.role,
    label: e.label,
    supported: e.supported !== false,
    sizes: e.sizes,
    sizeWarn: size != null && !e.sizes.includes(size),
  };
}

// Convenience for the importer: split a file list into what to keep and what to
// drop, with a reason for each drop (so the UI can say WHY it skipped 900 files).
export function classifyAll(files = []) {
  const accepted = [], rejected = [];
  for (const f of files) {
    const id = identify(f);
    if (!id) { rejected.push({ ...f, reason: 'PC-8001/8801 用として認識できない' }); continue; }
    accepted.push({ ...f, id });
  }
  return { accepted, rejected };
}

// ---- content identity (duplicate detection) -------------------------------
// A dump folder holds the same disk or ROM under many paths (per-machine copies,
// "(1)" duplicates, the same game in two collections). Deduping on PATH misses
// all of those, so the importer dedups on CONTENT: this is the key.
//
// FNV-1a in two independent 32-bit lanes (different offset basis) over the whole
// buffer, prefixed with the exact length — 64 bits of hash plus an exact size
// match. For libraries of thousands of images that is comfortably collision-free,
// and unlike crypto.subtle it is synchronous and pure, so it is testable here.
export function contentKey(bytes) {
  const b = bytes;
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < b.length; i++) {
    const v = b[i];
    h1 = ((h1 ^ v) >>> 0) * 0x01000193 >>> 0;
    h2 = ((h2 + v) >>> 0) * 0x85ebca6b >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return b.length + ':' + h1.toString(36) + h2.toString(36);
}

// ---- which machines can be built from what is already stored --------------
// The machine picker must offer models the STORED ROMs can actually constitute
// (not just whatever the server manifest lists). Given the set of roles present,
// report each buildable machine with what it still needs.
//
// PC-8001  : 'rom' alone boots N-BASIC ('font' optional but strongly wanted).
// PC-8801  : N88 mode needs main + the four extension banks (either as
//            n88ext0..3 or one n88ext image) + the FDD sub-CPU ROM.
export function machinesFromRoles(roles = []) {
  const has = (r) => (roles instanceof Set ? roles.has(r) : roles.includes(r));
  const banks = ['n88ext0', 'n88ext1', 'n88ext2', 'n88ext3'];
  const haveBanks = has('n88ext') || banks.every(has);

  // The N-mode ROM is the same image whether it arrived as the PC-8001 boot ROM
  // ('rom') or as the 8801's optional N80 ROM ('n88n80') — either constitutes a
  // PC-8001, so accept both (an imported BIOS folder only fills the latter).
  const n80Missing = [];
  if (!has('rom') && !has('n88n80')) n80Missing.push('n80.rom');

  const n88Missing = [];
  if (!has('n88main')) n88Missing.push('n88.rom');
  if (!haveBanks) n88Missing.push('n88_0..3.rom (または n88ext.rom)');
  if (!has('n88sub')) n88Missing.push('disk.rom');

  return [
    {
      id: 'pc8001', label: 'PC-8001 (N-BASIC)', ready: n80Missing.length === 0,
      missing: n80Missing, optional: has('font') ? [] : ['font.rom (無いと罫線が化ける)'],
    },
    {
      id: 'pc8801n88', label: 'PC-8801 (N88・ディスク起動可)', ready: n88Missing.length === 0,
      missing: n88Missing, optional: has('n88kanji') ? [] : ['kanji1.rom'],
    },
  ];
}
