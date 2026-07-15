// Kanji ROM I/O ports (PC-8801). Games read a 16×16 glyph through these ports
// and blit it into GVRAM themselves, so wiring the ports is all it takes for
// kanji to appear — and NOT wiring them is why unread reads (0xFF) became the
// "white box" per kanji. Synthetic ROMs here so this runs without NEC's dump.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pc8801Machine } from './machine88.js';

const main = () => new Uint8Array(0x8000).fill(0xff);
// a 128 KB ROM whose byte i is a known function of i, so reads are checkable
const synthRom = () => { const r = new Uint8Array(0x20000); for (let i = 0; i < r.length; i++) r[i] = (i * 7 + 3) & 0xff; return r; };
// the split-glyph addressing the driver uses (see machine88.in): a glyph is
// [16 left bytes, 16 right bytes]; addr = wordBase + line; 0xE8=left, 0xE9=right.
const kanjiByte = (addr, port, len) => (((addr & 0xfff0) << 1) | ((port & 1) << 4) | (addr & 0x0f)) & (len - 1);

test('kanji1: address latch + split-glyph read (left=0xE8, right=0xE9)', () => {
  const rom = synthRom();
  const m = new Pc8801Machine({ main: main(), kanji: rom });
  for (const addr of [0x0000, 0x1234, 0x7fff, 0xffff, 0x0905]) {
    m.out(0xe8, addr & 0xff);
    m.out(0xe9, (addr >> 8) & 0xff);
    assert.equal(m.in(0xe8), rom[kanjiByte(addr, 0xe8, rom.length)], `e8 @ ${addr}`);
    assert.equal(m.in(0xe9), rom[kanjiByte(addr, 0xe9, rom.length)], `e9 @ ${addr}`);
  }
});

test('kanji1: left/right halves are 16 bytes apart (split, not interleaved)', () => {
  const rom = synthRom();
  const m = new Pc8801Machine({ main: main(), kanji: rom });
  // for a glyph-aligned base, row L left = rom[base*2 + L], right = rom[base*2 + 16 + L]
  const wordBase = 0x0900; // glyph byte base 0x1200
  for (let L = 0; L < 16; L++) {
    m.out(0xe8, (wordBase + L) & 0xff); m.out(0xe9, ((wordBase + L) >> 8) & 0xff);
    assert.equal(m.in(0xe8), rom[wordBase * 2 + L], `left row ${L}`);
    assert.equal(m.in(0xe9), rom[wordBase * 2 + 16 + L], `right row ${L}`);
  }
});

test('kanji2: level-2 ROM on its own ports (0xEC/0xED), independent address', () => {
  const rom1 = synthRom();
  const rom2 = new Uint8Array(0x20000).fill(0x5a);
  const m = new Pc8801Machine({ main: main(), kanji: rom1, kanji2: rom2 });
  m.out(0xe8, 0x11); m.out(0xe9, 0x22);   // kanji1 addr = 0x2211
  m.out(0xec, 0x33); m.out(0xed, 0x44);   // kanji2 addr = 0x4433
  assert.equal(m.in(0xec), 0x5a, 'kanji2 data');
  assert.equal(m.in(0xe8), rom1[kanjiByte(0x2211, 0xe8, rom1.length)], 'kanji1 unaffected by kanji2 writes');
});

test('no kanji ROM → 0xFF (the pre-fix "white box" behaviour, unchanged)', () => {
  const m = new Pc8801Machine({ main: main() }); // no kanji
  m.out(0xe8, 0x00); m.out(0xe9, 0x00);
  assert.equal(m.in(0xe8), 0xff);
  assert.equal(m.in(0xe9), 0xff);
  assert.equal(m.in(0xec), 0xff);
});

test('kanji glyph read is not all-0xFF (would be a white box)', () => {
  const rom = synthRom();
  const m = new Pc8801Machine({ main: main(), kanji: rom });
  let ff = 0, total = 0;
  for (let line = 0; line < 16; line++) {
    const addr = (0x0530 << 4) | line; // some char base × 16 + row
    m.out(0xe8, addr & 0xff); m.out(0xe9, (addr >> 8) & 0xff);
    for (const p of [0xe8, 0xe9]) { if (m.in(p) === 0xff) ff++; total++; }
  }
  assert.ok(ff < total, 'a real ROM yields glyph bits, not a solid 0xFF box');
});
