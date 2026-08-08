// iNES header tests. The interesting cases are all damage: dirty headers
// from 90s rippers, truncated downloads, files that are not ROMs at all.
// A file picker meets those more often than it meets a clean NES 2.0 dump.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseINes, tryParseINes, buildINes, summarizeINes, isINes, boardName,
  INesError, MIRRORING,
} from './ines.js';

// Deterministic filler so a parsed PRG can be checked byte for byte.
const fill = (n, seed = 1) => {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = (s >>> 16) & 0xff; }
  return out;
};

test('ines: round-trips a plain NROM cartridge', () => {
  const prg = fill(32 * 1024, 7), chr = fill(8 * 1024, 9);
  const cart = parseINes(buildINes({ prg, chr, mapper: 0, mirroring: MIRRORING.VERTICAL }));
  assert.equal(cart.format, 'iNES');
  assert.equal(cart.mapper, 0);
  assert.equal(cart.mirroring, MIRRORING.VERTICAL);
  assert.equal(cart.prgSize, 32 * 1024);
  assert.equal(cart.chrSize, 8 * 1024);
  assert.deepEqual(cart.prg, prg);
  assert.deepEqual(cart.chr, chr);
  assert.equal(cart.chrRam, 0, 'a board with CHR-ROM needs no CHR-RAM');
  assert.deepEqual(cart.warnings, []);
});

test('ines: mapper number is split across two nibbles', () => {
  const prg = fill(16 * 1024);
  for (const mapper of [0, 1, 2, 4, 7, 66, 118, 255]) {
    const cart = parseINes(buildINes({ prg, mapper }));
    assert.equal(cart.mapper, mapper, `mapper ${mapper}`);
  }
});

test('ines: CHR size 0 means the board carries 8KB of CHR-RAM', () => {
  const cart = parseINes(buildINes({ prg: fill(16 * 1024), chr: null }));
  assert.equal(cart.chr, null);
  assert.equal(cart.chrSize, 0);
  assert.equal(cart.chrRam, 8 * 1024);
});

test('ines: battery and four-screen wiring survive the header', () => {
  const cart = parseINes(buildINes({
    prg: fill(16 * 1024), mapper: 4, battery: true, mirroring: MIRRORING.FOUR_SCREEN,
  }));
  assert.equal(cart.battery, true);
  assert.equal(cart.fourScreen, true);
  assert.equal(cart.mirroring, MIRRORING.FOUR_SCREEN);
  assert.ok(cart.prgNvram > 0, 'a battery implies save RAM to preserve');
});

test('ines: a trainer is lifted out before the PRG', () => {
  const prg = fill(16 * 1024, 3);
  const trainer = fill(512, 11);
  const cart = parseINes(buildINes({ prg, trainer }));
  assert.equal(cart.trainer.length, 512);
  assert.deepEqual(cart.trainer, trainer);
  assert.deepEqual(cart.prg, prg, 'the PRG must not be shifted by the trainer');
});

test('ines: NES 2.0 header carries submapper, big sizes and RAM shifts', () => {
  const prg = fill(64 * 1024, 5);
  const img = buildINes({
    prg, mapper: 0x123, submapper: 5, nes2: true, prgRam: 8192, chrRam: 8192,
  });
  const cart = parseINes(img);
  assert.equal(cart.format, 'NES 2.0');
  assert.equal(cart.mapper, 0x123);
  assert.equal(cart.submapper, 5);
  assert.equal(cart.prgSize, 64 * 1024);
  assert.equal(cart.prgRam, 8192);
  assert.equal(cart.chrRam, 8192);
});

test('ines: NES 2.0 exponent sizes (the oversize homebrew escape hatch)', () => {
  // High nibble $F switches the low byte to 2^E * (2*MM+1) BYTES.
  const img = buildINes({ prg: fill(16 * 1024) });
  img[7] = 0x08;          // mark it NES 2.0
  img[9] = 0x0f;          // PRG size high nibble = $F -> exponent form
  img[4] = (13 << 2) | 1; // 2^13 * 3 = 24576 bytes
  const cart = parseINes(img);
  assert.equal(cart.prgSize, 24576);
});

test('ines: a dirty header (ripper text) does not become a bogus mapper', () => {
  const img = buildINes({ prg: fill(16 * 1024), mapper: 0 });
  img[7] = 0x40;                       // would read as mapper $40
  img.set([0x44, 0x69, 0x5a, 0x21], 12); // "DiZ!" in the tail: the tell
  const cart = parseINes(img);
  assert.equal(cart.mapper, 0, 'the high nibble is discarded, not trusted');
  assert.equal(cart.format, 'iNES');
  assert.ok(cart.warnings.some((w) => w.includes('dirty header')));
});

test('ines: a truncated download is reported, not silently short', () => {
  const full = buildINes({ prg: fill(32 * 1024), chr: fill(8 * 1024) });
  const cut = full.subarray(0, full.length - 4096);
  const cart = parseINes(cut);
  assert.equal(cart.prgSize, 32 * 1024, 'the declared size is what the mapper wires up');
  assert.equal(cart.chr.length, 8 * 1024);
  assert.ok(cart.warnings.some((w) => w.includes('truncated')), cart.warnings.join('/'));
  assert.equal(cart.chr[cart.chr.length - 1], 0, 'the missing tail reads as zero, not as garbage');
});

test('ines: junk in, a readable error out', () => {
  const cases = [
    [new Uint8Array(0), 'too-short'],
    [new Uint8Array(4), 'too-short'],
    [new Uint8Array(32), 'bad-magic'],
  ];
  for (const [bytes, code] of cases) {
    const r = tryParseINes(bytes);
    assert.equal(r.ok, false);
    assert.equal(r.code, code);
    assert.ok(r.error.length > 10, 'the message is for a human');
    assert.throws(() => parseINes(bytes), INesError);
  }
});

test('ines: a header declaring no PRG is rejected', () => {
  const img = buildINes({ prg: fill(16 * 1024) });
  img[4] = 0;
  const r = tryParseINes(img);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-prg');
});

test('ines: a header promising a trainer that is not there is rejected', () => {
  const img = buildINes({ prg: fill(16 * 1024) });
  img[6] |= 0x04; // claim a trainer without one
  const r = tryParseINes(new Uint8Array(img.subarray(0, 200)));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'truncated-trainer');
});

test('ines: isINes only accepts the magic', () => {
  assert.equal(isINes(buildINes({ prg: fill(16 * 1024) })), true);
  assert.equal(isINes(new Uint8Array(16)), false);
  assert.equal(isINes(null), false);
});

test('ines: summarize is plain data a host can show', () => {
  const cart = parseINes(buildINes({ prg: fill(128 * 1024), chr: fill(32 * 1024), mapper: 4, battery: true }));
  const s = summarizeINes(cart);
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.board, 'MMC3 (TxROM)');
  assert.equal(s.prgKB, 128);
  assert.equal(s.chrKB, 32);
  assert.equal(s.battery, true);
  assert.equal(JSON.parse(JSON.stringify(s)).board, 'MMC3 (TxROM)', 'no typed arrays leak into the summary');
  assert.equal(boardName(999), 'mapper 999', 'an unknown board says so instead of guessing');
});

test('ines: parsing is deterministic and does not alias the input buffer', () => {
  const img = buildINes({ prg: fill(16 * 1024, 21), chr: fill(8 * 1024, 22) });
  const a = parseINes(img);
  const b = parseINes(img);
  assert.deepEqual(a.prg, b.prg);
  assert.deepEqual(a.chr, b.chr);
  img.fill(0xff, 16); // scribble over the source
  assert.deepEqual(a.prg, b.prg, 'the cartridge owns its own copy');
  assert.notEqual(a.prg[0], 0xff);
});
