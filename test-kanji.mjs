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
// confirmed on real kana: 0xE8 = ODD byte, 0xE9 = EVEN (halves swapped).
const kanjiByte = (addr, port, len) => ((addr << 1) | ((port & 1) ^ 1)) & (len - 1);

test('kanji1: address latch (0xE8/0xE9) + data read = rom[(addr<<1)|((port&1)^1)]', () => {
  const rom = synthRom();
  const m = new Pc8801Machine({ main: main(), kanji: rom });
  for (const addr of [0x0000, 0x1234, 0x7fff, 0xffff, 0x0905]) {
    m.out(0xe8, addr & 0xff);
    m.out(0xe9, (addr >> 8) & 0xff);
    assert.equal(m.in(0xe8), rom[kanjiByte(addr, 0xe8, rom.length)], `e8 @ ${addr}`);
    assert.equal(m.in(0xe9), rom[kanjiByte(addr, 0xe9, rom.length)], `e9 @ ${addr}`);
    assert.equal(m.in(0xe8), rom[(addr << 1) | 1], '0xE8 = odd byte');
    assert.equal(m.in(0xe9), rom[(addr << 1)], '0xE9 = even byte');
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
