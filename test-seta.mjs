// test-seta — the Seta arcade boards, without any ROM.
//
// Every test here builds its own board: a few hand-assembled 68000 words for
// the program, a synthesised sprite ROM with tiles whose pixels are known by
// construction, and a ROM set object handed straight to the machine. That is
// deliberate — no commercial ROM is committed to this repository, so a test
// that needed one would be a test nobody could run. The same choice test-x68.mjs
// made for the X68000.
//
// The correctness that DOES need a real ROM (does thunderl reach its title
// screen, does every pixel match MAME) is checked by setatools/mameref.mjs
// against a locally-supplied set; docs/seta-design.md has that procedure and
// its results.

import test from 'node:test';
import assert from 'node:assert/strict';

import { crc32, buildSetaSet, identifySetaSet, SETA_SETS, listSetaSets } from './setarom.js';
import { X1001, decodeSpriteTiles } from './x1001.js';
import { X1010, NUM_CHANNELS } from './x1010.js';
import { SetaMachine, SETA_BOARDS, BUTTON, COIN } from './machineseta.js';

// ---- helpers ---------------------------------------------------------------

// Assemble words at `org` into a 68000 program region, with the reset vector
// pointing at it. The 68000 reads its stack pointer from 0 and its PC from 4
// before it fetches anything, so a region without those two is a machine that
// dies before its first instruction.
function program(words, { org = 0x400, size = 0x10000, sp = 0xfffff0, vectors = {} } = {}) {
  const rom = new Uint8Array(size);
  const w = (addr, v) => { rom[addr] = (v >> 8) & 0xff; rom[addr + 1] = v & 0xff; };
  const l = (addr, v) => { w(addr, (v >>> 16) & 0xffff); w(addr + 2, v & 0xffff); };
  l(0, sp);
  l(4, org);
  for (const k of Object.keys(vectors)) l(Number(k) * 4, vectors[k]);
  words.forEach((v, i) => w(org + i * 2, v & 0xffff));
  return rom;
}

// A few 68000 encodings, written out so the tests read as assembly.
const I = {
  MOVE_W_IMM_ABSL: 0x33fc,   // move.w #imm,(xxx).l
  MOVE_B_IMM_ABSL: 0x13fc,   // move.b #imm,(xxx).l
  MOVE_W_ABSL_D0: 0x3039,    // move.w (xxx).l,d0
  MOVE_W_D0_ABSL: 0x33c0,    // move.w d0,(xxx).l
  ADDQ_W_1_ABSL: 0x5279,     // addq.w #1,(xxx).l
  MOVE_IMM_SR: 0x46fc,       // move #imm,sr
  RTE: 0x4e73,
  NOP: 0x4e71,
};
const hi = (a) => (a >>> 16) & 0xffff, lo = (a) => a & 0xffff;

// The inverse of decodeSpriteTiles: lay 16x16x4bpp pixels back out in the
// chip's split-plane format. Having both directions lets one test prove the
// decoder rather than merely exercise it.
function encodeTile(gfx, index, pixels) {
  const half = gfx.length >> 1;
  const b0 = index * 64, b1 = half + index * 64;
  for (let y = 0; y < 16; y++) {
    const row = ((y & 7) * 2) + (y < 8 ? 0 : 32);
    for (let xh = 0; xh < 2; xh++) {
      const o = row + (xh ? 16 : 0);
      for (let x = 0; x < 8; x++) {
        const p = pixels[y * 16 + xh * 8 + x] & 0xf;
        const m = 0x80 >> x;
        if (p & 1) gfx[b0 + o] |= m;
        if (p & 2) gfx[b0 + o + 1] |= m;
        if (p & 4) gfx[b1 + o] |= m;
        if (p & 8) gfx[b1 + o + 1] |= m;
      }
    }
  }
  return gfx;
}

// A ROM set object of the shape setarom.js produces, without going through the
// CRC table — the tests are about the machine, not about matching real dumps.
function fakeSet(board, { maincpu, gfx1 = null, x1snd = null } = {}) {
  return {
    set: 'test', title: 'test board', year: 0, maker: 'test', board,
    regions: {
      maincpu,
      gfx1: gfx1 || new Uint8Array(0x2000),
      x1snd: x1snd || new Uint8Array(0x1000),
    },
    matched: [], missing: [], warnings: [],
  };
}

const machineWith = (words, opts = {}) =>
  new SetaMachine({ romset: fakeSet(opts.board || 'thunderl', { maincpu: program(words, opts), gfx1: opts.gfx1 }) });

// ---- setarom ---------------------------------------------------------------

test('crc32 matches the published vectors', () => {
  assert.equal(crc32(new Uint8Array(0)), 0x00000000);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new TextEncoder().encode('a')), 0xe8b7be43);
});

test('the set table is well formed', () => {
  for (const name of Object.keys(SETA_SETS)) {
    const info = SETA_SETS[name];
    assert.ok(SETA_BOARDS[info.board], `${name} names a board that exists`);
    for (const rn of Object.keys(info.regions)) {
      const r = info.regions[rn];
      for (const chip of r.chips) {
        assert.ok(chip.names.length, `${name}/${rn} chip has a name`);
        assert.ok(chip.size > 0);
        assert.equal(typeof chip.crc, 'number');
        // Every byte a chip claims has to land inside the region.
        const last = chip.at + (chip.size - 1) * chip.step;
        assert.ok(last < r.size, `${name}/${rn}/${chip.names[0]} fits the region`);
      }
    }
  }
  assert.ok(listSetaSets().length >= 4);
});

test('an interleaved pair is reassembled byte by byte', () => {
  // Two chips of alternating bytes: the even one all 0xa*, the odd one 0x5*.
  const even = new Uint8Array(0x8000), odd = new Uint8Array(0x8000);
  for (let i = 0; i < 0x8000; i++) { even[i] = 0xa0 | (i & 0xf); odd[i] = 0x50 | (i & 0xf); }
  const files = [
    { name: 'm4', bytes: even }, { name: 'm5', bytes: odd },
    { name: 't17', bytes: new Uint8Array(0x20000) }, { name: 't16', bytes: new Uint8Array(0x20000) },
    { name: 't15', bytes: new Uint8Array(0x20000) }, { name: 't14', bytes: new Uint8Array(0x20000) },
  ];
  const built = buildSetaSet(files, 'thunderl');
  const p = built.regions.maincpu;
  assert.equal(p.length, 0x10000);
  assert.equal(p[0], even[0]);
  assert.equal(p[1], odd[0]);
  assert.equal(p[2], even[1]);
  assert.equal(p[3], odd[1]);
  assert.equal(p[0xfffe], even[0x7fff]);
  assert.equal(p[0xffff], odd[0x7fff]);
  // Matched by name rather than CRC, so it must say so rather than pretend.
  assert.ok(built.warnings.some((w) => /matched by name/.test(w)));
});

test('a contiguous pair is laid down in halves', () => {
  const a = new Uint8Array(0x80000).fill(0x11), b = new Uint8Array(0x80000).fill(0x22);
  const files = [
    { name: 'fv001.002', bytes: new Uint8Array(0x40000) },
    { name: 'fv001.001', bytes: new Uint8Array(0x40000) },
    { name: 'fv001.003', bytes: a }, { name: 'fv001.004', bytes: b },
  ];
  const g = buildSetaSet(files, 'krzybowl').regions.gfx1;
  assert.equal(g.length, 0x100000);
  assert.equal(g[0], 0x11);
  assert.equal(g[0x7ffff], 0x11);
  assert.equal(g[0x80000], 0x22);
  assert.equal(g[0xfffff], 0x22);
});

test('a directory prefix in the archive does not hide a ROM', () => {
  const files = [
    { name: 'thunderl/m4', bytes: new Uint8Array(0x8000).fill(1) },
    { name: 'roms\\thunderl\\m5', bytes: new Uint8Array(0x8000).fill(2) },
    { name: 't17', bytes: new Uint8Array(0x20000) }, { name: 't16', bytes: new Uint8Array(0x20000) },
    { name: 't15', bytes: new Uint8Array(0x20000) }, { name: 't14', bytes: new Uint8Array(0x20000) },
  ];
  const p = buildSetaSet(files, 'thunderl').regions.maincpu;
  assert.equal(p[0], 1);
  assert.equal(p[1], 2);
});

test('unpopulated bytes read as 0xff, and a missing required region throws', () => {
  const files = [
    { name: 'm4', bytes: new Uint8Array(0x8000) }, { name: 'm5', bytes: new Uint8Array(0x8000) },
    { name: 't17', bytes: new Uint8Array(0x20000) }, { name: 't16', bytes: new Uint8Array(0x20000) },
    { name: 't15', bytes: new Uint8Array(0x20000) }, { name: 't14', bytes: new Uint8Array(0x20000) },
  ];
  const built = buildSetaSet(files, 'thunderl');
  // No sample ROMs were supplied: the board still builds, loudly.
  assert.ok(built.warnings.some((w) => /x1snd/.test(w)));
  assert.equal(built.regions.x1snd[0], 0xff);
  assert.throws(() => buildSetaSet([{ name: 'nothing', bytes: new Uint8Array(4) }], 'thunderl'),
                /region maincpu/);
});

test('identify scores by CRC only, so a name alone never wins', () => {
  // Files that match nothing by content score nothing, even when they carry
  // exactly the right names. That is the point of scoring on CRC: a zip full of
  // plausibly-named rubbish is reported as "not a Seta set" rather than loaded
  // into a board that will never run.
  const named = SETA_SETS.thunderl.regions.maincpu.chips.map(
    (c) => ({ name: c.names[0], bytes: new Uint8Array(c.size) }));
  assert.deepEqual(identifySetaSet(named), []);
  assert.deepEqual(identifySetaSet([{ name: 'readme.txt', bytes: new Uint8Array(9) }]), []);
});

// ---- x1001: tiles ----------------------------------------------------------

test('sprite tiles decode out of the split-plane layout exactly as they went in', () => {
  const gfx = new Uint8Array(0x2000);            // 64 tiles' worth
  const pixels = new Uint8Array(256);
  // A pattern that uses every pen and is asymmetric in both axes, so a
  // transposed or mirrored decoder cannot pass by accident.
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels[y * 16 + x] = (x + y * 3) & 0xf;
  encodeTile(gfx, 5, pixels);
  const { tiles, count } = decodeSpriteTiles(gfx);
  assert.equal(count, (gfx.length >> 1) / 64);
  for (let i = 0; i < 256; i++) assert.equal(tiles[5 * 256 + i], pixels[i], `pixel ${i}`);
  // Tile 4 was never written, so it is entirely pen 0.
  for (let i = 0; i < 256; i++) assert.equal(tiles[4 * 256 + i], 0);
});

test('the four bitplanes come from the two halves in the right order', () => {
  const gfx = new Uint8Array(0x200);
  // Set only the byte that is plane 3 (the high half, odd byte) for row 0.
  gfx[(gfx.length >> 1) + 1] = 0x80;
  const { tiles } = decodeSpriteTiles(gfx);
  assert.equal(tiles[0], 8, 'top-left pixel is pen 8, i.e. bit 3 only');
});

// ---- x1001: drawing --------------------------------------------------------

function spriteChip() {
  const gfx = new Uint8Array(0x2000);
  const solid = new Uint8Array(256).fill(0x3);       // pen 3 everywhere
  encodeTile(gfx, 1, solid);
  const d = decodeSpriteTiles(gfx);
  const c = new X1001({ tiles: d.tiles, tileCount: d.count, width: 512, height: 256 });
  c.spritecode.fill(0);      // nothing drawn unless a test asks for it
  c.spriteylow.fill(0);
  c.spritectrl.fill(0);
  // ctrl[1] bits 5 and 6 pick which half of the code table is live, and the
  // comparison between them is such that all-zeroes selects the SECOND half.
  // A test that filled the table from offset 0 and left the register at zero
  // would draw nothing and look like a broken blitter, so say which bank is
  // wanted out loud. 0x20 is "bank 0, no tilemap columns".
  c.spritectrl[1] = 0x20;
  return c;
}

test('a sprite lands where the chip says, on an axis that runs upwards', () => {
  const c = spriteChip();
  c.spriteLimit = 0;                       // just sprite 0
  c.spritecode[0x0000] = 1;                // tile 1
  c.spritecode[0x0200] = (2 << 11) | 0x30; // colour 2, x = 0x30
  c.spriteylow[0] = 0x40;
  c.drawFrame(0);
  // y is measured from the bottom: height - ((y + yoffs) & 0xff) = 256 - 64.
  assert.equal(c.bitmap[(256 - 0x40) * 512 + 0x30], (2 * 16) | 3);
  assert.equal(c.bitmap[(256 - 0x40 - 1) * 512 + 0x30], 0, 'and not one row above');
});

test('pen 0 is transparent and the background pen shows through', () => {
  const gfx = new Uint8Array(0x2000);
  const half = new Uint8Array(256);
  for (let i = 0; i < 256; i++) half[i] = (i & 16) ? 0 : 5;   // alternate rows
  encodeTile(gfx, 1, half);
  const d = decodeSpriteTiles(gfx);
  const c = new X1001({ tiles: d.tiles, tileCount: d.count });
  c.spritecode.fill(0); c.spriteylow.fill(0); c.spritectrl.fill(0);
  c.spritectrl[1] = 0x20;   // bank 0 — see spriteChip()
  c.spriteLimit = 0;
  c.spritecode[0x0000] = 1;
  c.spritecode[0x0200] = 0x30;
  c.spriteylow[0] = 0x40;
  c.drawFrame(0x1f0);
  const top = (256 - 0x40) * 512 + 0x30;
  assert.equal(c.bitmap[top], 5, 'row 0 of the tile is opaque');
  assert.equal(c.bitmap[top + 512], 0x1f0, 'row 1 is pen 0 and leaves the background');
});

test('a sprite past the right edge wraps in from the left', () => {
  const c = spriteChip();
  c.spriteLimit = 0;
  c.spritecode[0x0000] = 1;
  c.spritecode[0x0200] = 0x1f8;            // x = 0xf8 - 0x100 = -8 after the sign fold
  c.spriteylow[0] = 0x40;
  c.drawFrame(0);
  const y = (256 - 0x40) * 512;
  // -8 lands half off the left edge; the visible half starts at column 0.
  assert.equal(c.bitmap[y + 0], 3);
  assert.equal(c.bitmap[y + 7], 3);
  assert.equal(c.bitmap[y + 8], 0);
});

test('the floating tilemap draws its columns and obeys the column count', () => {
  const c = spriteChip();
  c.spriteLimit = -1;                      // sprites off, tilemap only
  c.spritectrl[1] = 0x22;                  // bank 0, two columns
  for (let i = 0; i < 0x200; i++) c.spritecode[0x400 + i] = 1;   // every tile is the solid one
  c.spritecode.fill(0, 0x600, 0x800);      // colour 0
  // Each column carries its own scroll pair; without moving the second one the
  // two would land on top of each other and the test could not tell one column
  // from two.
  c.spriteylow[0x200 + 1 * 0x10 + 4] = 64; // column 1, scroll X
  c.drawFrame(0);
  let drawn = 0;
  for (let i = 0; i < c.bitmap.length; i++) if (c.bitmap[i] === 3) drawn++;
  // A column is 0x20 entries of 16x16, laid out two wide and sixteen tall:
  // 32x256 pixels each, and the two do not overlap.
  assert.equal(drawn, 2 * 32 * 256);
  c.spritectrl[1] = 0x20;                  // zero columns means nothing at all
  c.drawFrame(0);
  drawn = 0;
  for (let i = 0; i < c.bitmap.length; i++) if (c.bitmap[i] === 3) drawn++;
  assert.equal(drawn, 0);
});

test('the sprite chip only ever takes the low byte of a word write', () => {
  const c = spriteChip();
  c.ctrlWrite(0, 0x1234);
  assert.equal(c.ctrlRead(0), 0x34);
  c.ylowWrite(7, 0xabcd);
  assert.equal(c.ylowRead(7), 0xcd);
  // The code table is real 16-bit RAM and does keep both halves.
  c.codeWrite(9, 0x1234);
  assert.equal(c.codeRead(9), 0x1234);
});

test('the sprite chip state round-trips', () => {
  const c = spriteChip();
  for (let i = 0; i < 0x300; i++) c.spriteylow[i] = (i * 7) & 0xff;
  for (let i = 0; i < 0x2000; i++) c.spritecode[i] = (i * 13) & 0xffff;
  c.spritectrl.set([1, 2, 3, 4]);
  c.bgflag = 0x80;
  const s = c.getState();
  const d = spriteChip();
  d.setState(s);
  assert.deepEqual(Array.from(d.spriteylow), Array.from(c.spriteylow));
  assert.deepEqual(Array.from(d.spritecode), Array.from(c.spritecode));
  assert.deepEqual(Array.from(d.spritectrl), Array.from(c.spritectrl));
  assert.equal(d.bgflag, 0x80);
});

// ---- x1010 -----------------------------------------------------------------

test('key-on is an edge: it rewinds the voice, a repeated write does not', () => {
  const s = new X1010({ rom: new Uint8Array(0x1000).fill(0x40) });
  s.write(0, 0x00);
  s.smpOffset[0] = 1234; s.envOffset[0] = 5678;
  s.write(0, 0x01);                       // 0 -> 1: rewind
  assert.equal(s.smpOffset[0], 0);
  assert.equal(s.envOffset[0], 0);
  s.smpOffset[0] = 99;
  s.write(0, 0x01);                       // 1 -> 1: no rewind
  assert.equal(s.smpOffset[0], 99);
});

test('a word write leaves its high byte where a word read can find it', () => {
  const s = new X1010({});
  s.wordWrite(0x40, 0xbe12);
  assert.equal(s.read(0x40), 0x12, 'the chip itself only saw the low byte');
  assert.equal(s.wordRead(0x40), 0xbe12, 'but the bus gives back what was written');
});

test('a PCM voice stops itself at the end of its sample', () => {
  const rom = new Uint8Array(0x100000);
  for (let i = 0; i < rom.length; i++) rom[i] = 0x20;
  const s = new X1010({ rom, sampleRate: 31250, clockHz: 16000000 });
  s.write(4, 0x00);          // start block 0
  s.write(5, 0xff);          // end = (0x100 - 0xff) << 12 = one block
  s.write(2, 0xff);          // fastest step
  s.write(1, 0xff);          // full volume both sides
  s.write(0, 0x01);          // key on, PCM
  const out = new Float32Array(4096);
  s.render(out, null, out.length);
  assert.equal(s.reg[0] & 1, 0, 'the voice keyed itself off');
  assert.ok(out[0] !== 0, 'and it made sound before it did');
});

test('a waveform voice with the one-shot flag runs its envelope once', () => {
  const s = new X1010({ sampleRate: 31250, clockHz: 16000000 });
  for (let i = 0; i < 0x80; i++) s.reg[0x1000 + i] = 0x40;   // the wave
  for (let i = 0; i < 0x80; i++) s.reg[0x0080 + i] = 0xff;   // the envelope
  s.write(1, 0x00);          // wave 0 -> $1000
  s.write(2, 0x00); s.write(3, 0x04);   // pitch
  s.write(4, 0xff);          // envelope step, fast
  s.write(5, 0x01);          // envelope at $80
  s.write(0, 0x07);          // key on, waveform, one shot
  const out = new Float32Array(8192);
  s.render(out, null, out.length);
  assert.equal(s.reg[0] & 1, 0, 'one shot means it ends');
});

test('the sound chip is deterministic and its state round-trips', () => {
  const rom = new Uint8Array(0x10000);
  for (let i = 0; i < rom.length; i++) rom[i] = (i * 31) & 0xff;
  const mk = () => {
    const s = new X1010({ rom, sampleRate: 48000, clockHz: 16000000 });
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      s.write(ch * 8 + 1, 0x88);
      s.write(ch * 8 + 2, 0x10 + ch);
      s.write(ch * 8 + 4, ch);
      s.write(ch * 8 + 5, 0xf0);
      s.write(ch * 8 + 0, 0x01);
    }
    return s;
  };
  const a = mk(), b = mk();
  const oa = new Float32Array(2000), ob = new Float32Array(2000);
  a.render(oa, null, oa.length);
  b.render(ob, null, ob.length);
  assert.deepEqual(Array.from(oa), Array.from(ob));

  const c = mk();
  c.setState(a.getState());
  const oc = new Float32Array(2000), od = new Float32Array(2000);
  a.render(oc, null, oc.length);
  c.render(od, null, od.length);
  assert.deepEqual(Array.from(od), Array.from(oc), 'a restored chip carries on identically');
});

// ---- the machine: it starts ------------------------------------------------

test('a board comes up on its reset vector and runs', () => {
  const m = machineWith([I.NOP, 0x60fc]);   // nop; bra.s *-2
  assert.equal(m.cpu.pc, 0x400);
  assert.equal(m.frame, 0);
  m.stepFrame();
  assert.equal(m.frame, 1);
  assert.equal(m.cpu.halted, false);
  assert.ok(m.cpu.pc >= 0x400 && m.cpu.pc <= 0x406);
});

test('an unknown board is refused rather than half-built', () => {
  assert.throws(() => new SetaMachine({ romset: fakeSet('no-such-board', { maincpu: program([]) }) }),
                /no board description/);
  assert.throws(() => new SetaMachine({}), /needs a ROM set/);
});

// ---- the machine: the map --------------------------------------------------

test('work RAM, palette, sprite RAM and the sound chip are where the board puts them', () => {
  const m = machineWith([0x60fe]);
  m._write16(0xffc000, 0x1234);
  assert.equal(m._read16(0xffc000), 0x1234);
  assert.equal(m.ram[0], 0x12);
  assert.equal(m._read8(0xffc001), 0x34);
  m._write8(0xffc000, 0xaa);
  assert.equal(m._read16(0xffc000), 0xaa34, 'a byte write replaces one half only');

  m._write16(0x700010, 0x7fff);
  assert.equal(m._read16(0x700010), 0x7fff);
  assert.equal(m.paletteram[8], 0x7fff);

  m._write16(0xe00004, 0xbeef);
  assert.equal(m._read16(0xe00004), 0xbeef);
  assert.equal(m.video.spritecode[2], 0xbeef);

  m._write16(0xd00002, 0x12ab);
  assert.equal(m._read16(0xd00002), 0xab, 'the Y table is eight bits wide');

  m._write16(0xd00600, 0x00c3);
  assert.equal(m.video.spritectrl[0], 0xc3);

  m._write16(0x100002, 0x1234);
  assert.equal(m._read16(0x100002), 0x1234);
  assert.equal(m.sound.reg[1], 0x34);
});

test('RAM does not answer below its base, and unmapped space reads zero', () => {
  const m = machineWith([0x60fe]);
  m._write16(0xff0000, 0x1234);
  assert.equal(m._read16(0xff0000), 0);
  assert.equal(m._read16(0x900000), 0, 'a page with nothing on it');
});

test('the ROM is read-only', () => {
  const m = machineWith([0x60fe]);
  const was = m._read16(0x400);
  m._write16(0x400, 0xdead);
  assert.equal(m._read16(0x400), was);
});

test('the DIP switches split across two addresses, high byte first', () => {
  const m = machineWith([0x60fe]);
  m.setDip(0xabcd);
  assert.equal(m._read16(0x600000), 0xab);
  assert.equal(m._read16(0x600002), 0xcd);
});

test('controls are active low and the coin switch releases itself', () => {
  const m = machineWith([0x60fe]);
  assert.equal(m._read16(0xb00000), 0xff, 'nothing pressed');
  m.padDown(BUTTON.LEFT, 0);
  assert.equal(m._read16(0xb00000), 0xfe);
  m.padDown(BUTTON.START, 0);
  assert.equal(m._read16(0xb00000), 0x7e);
  m.padUp(BUTTON.LEFT, 0);
  m.padUp(BUTTON.START, 0);
  assert.equal(m._read16(0xb00000), 0xff);

  m.padDown(BUTTON.B1, 1);
  assert.equal(m._read16(0xb00002), 0xef);

  const coinsIdle = m._read16(0xb00004);
  assert.equal(coinsIdle & 0x0f, 0x0f);
  m.insertCoin(0);
  m.stepFrame();
  assert.equal(m._read16(0xb00004) & 1, 0, 'the coin switch is closed');
  for (let i = 0; i < 6; i++) m.stepFrame();
  assert.equal(m._read16(0xb00004) & 1, 1, 'and opens again on its own');
});

// ---- the machine: interrupts ------------------------------------------------

// A program that enables interrupts and spins, with a level-2 handler that
// counts itself and acknowledges by reading the ack port.
const IRQ_PROG = {
  words: [
    I.MOVE_IMM_SR, 0x2000,                     // move #$2000,sr  (supervisor, IPL 0)
    0x60fe,                                    // bra.s *
  ],
  handler: [
    I.ADDQ_W_1_ABSL, hi(0xffc010), lo(0xffc010),
    I.MOVE_W_ABSL_D0, hi(0x200000), lo(0x200000),   // reading the port acks
    I.RTE,
  ],
};

function irqMachine() {
  const org = 0x400, hOrg = 0x500;
  const rom = program(IRQ_PROG.words, { org, vectors: { 26: hOrg } });   // autovector level 2
  IRQ_PROG.handler.forEach((v, i) => { rom[hOrg + i * 2] = v >> 8; rom[hOrg + i * 2 + 1] = v & 0xff; });
  return new SetaMachine({ romset: fakeSet('thunderl', { maincpu: rom }) });
}

test('vertical blanking raises level 2 exactly once a frame', () => {
  const m = irqMachine();
  m.stepFrame();
  assert.equal(m._read16(0xffc010), 1, 'one interrupt in one frame');
  m.stepFrame();
  m.stepFrame();
  assert.equal(m._read16(0xffc010), 3);
});

test('an interrupt that is never acknowledged stays asserted', () => {
  // Same board, but the handler does not touch the ack port, so the level stays
  // up and the machine re-enters the handler as soon as it returns.
  const org = 0x400, hOrg = 0x500;
  const rom = program(IRQ_PROG.words, { org, vectors: { 26: hOrg } });
  const h = [I.ADDQ_W_1_ABSL, hi(0xffc010), lo(0xffc010), I.RTE];
  h.forEach((v, i) => { rom[hOrg + i * 2] = v >> 8; rom[hOrg + i * 2 + 1] = v & 0xff; });
  const m = new SetaMachine({ romset: fakeSet('thunderl', { maincpu: rom }) });
  m.stepFrame();
  assert.ok(m._read16(0xffc010) > 1, 'it fires over and over');
  assert.ok(m.irqLines & (1 << 2), 'and the line is still up');
  m._read16(0x200000);
  assert.equal(m.irqLines & (1 << 2), 0, 'until something acknowledges it');
});

test('the scanline board raises two different levels a frame', () => {
  const m = new SetaMachine({ romset: fakeSet('krzybowl', { maincpu: program([0x60fe], { sp: 0xf0fff0, org: 0x400 }) }) });
  const seen = new Set();
  const board = m.board;
  assert.equal(board.irq, 'scanline12');
  // Drive the hook directly: what matters is which lines the board asserts, not
  // whether this particular stub program has interrupts enabled.
  for (let line = 0; line < board.height; line++) {
    m._lineHook(line, board.visY[1]);
    for (let l = 1; l <= 7; l++) if (m.irqLines & (1 << l)) seen.add(l);
  }
  assert.deepEqual([...seen].sort(), [1, 2]);
  // And the acknowledge cycle drops them, which is what HOLD_LINE means.
  m._irqAck(2);
  assert.equal(m.irqLines & (1 << 2), 0);
});

// ---- the machine: protection -------------------------------------------------

test("thunderl's protection PAL answers from the address, not the data", () => {
  const m = machineWith([0x60fe]);
  // Bit 0 of the register is address bit 2 and nothing else, so two writes that
  // differ only in that bit must give different answers — and the data written
  // must make no difference at all.
  m._write16(0x400000, 0x0000);
  const a = m._read16(0xb0000c);
  m._write16(0x400004, 0xffff);
  const b = m._read16(0xb0000c);
  assert.notEqual(a, b);
  assert.equal(a & 1, 0);
  assert.equal(b & 1, 1);
  m._write16(0x400004, 0x0000);
  assert.equal(m._read16(0xb0000c), b, 'the data byte is ignored');
  // The published equations, evaluated by hand for one address.
  m._write16(0x400000, 0);
  // addr = 0: every "not" term is 1, so bits 2, 3, 6 and 7 are set.
  assert.equal(m._read16(0xb0000c), 0xcc);
});

test('a board without the PAL does not invent one', () => {
  const m = new SetaMachine({ romset: fakeSet('wits', { maincpu: program([0x60fe]) }) });
  assert.equal(m.board.protection, null);
  assert.equal(m._read16(0xb0000c), 0, 'that address is simply not decoded');
});

// ---- the machine: video ------------------------------------------------------

test('render reports the visible window, and the cabinet rotation turns it', () => {
  const m = machineWith([0x60fe]);
  const raw = m.render({ rotate: false });
  assert.equal(raw.width, 384);
  assert.equal(raw.height, 240);
  assert.equal(raw.rgb.length, 384 * 240 * 3);
  const turned = m.render();
  assert.equal(turned.width, 240, 'thunderl is a vertical cabinet');
  assert.equal(turned.height, 384);
  // The host's phosphor pipeline wants a 3-bit GRB index plus a per-gun drive,
  // the same shape mdvdp.js and x68video.js hand it.
  const idx = m.render({ indexed: true, rotate: false });
  assert.equal(idx.pixels.length, 384 * 240);
  assert.equal(idx.drive.length, 384 * 240 * 3);
  assert.ok(idx.pixels.every((v) => v <= 7));
  // And the board's own pen numbers are still reachable, for comparing against
  // MAME without going through a DAC.
  const boardPens = m.render({ pens: true, rotate: false });
  assert.equal(boardPens.pixels.length, 384 * 240);
  assert.equal(boardPens.palette.length, 512);
});

test('the picture uses the palette as it stood when the field was drawn', () => {
  const m = machineWith([0x60fe]);
  m.paletteram[0x1f0] = 0x7fff;             // white background
  m.stepFrame();                            // draws, and copies the palette
  m.paletteram[0x1f0] = 0x0000;             // the game repaints during blanking
  const f = m.render({ rotate: false });
  assert.equal(f.rgb[0], 255, 'still the colour the field was drawn with');
  m.stepFrame();
  assert.equal(m.render({ rotate: false }).rgb[0], 0, 'and the next field catches up');
});

test('a five-bit channel expands to full scale', () => {
  const m = machineWith([0x60fe]);
  m.paletteram[0x1f0] = (0x1f << 10) | (0x10 << 5) | 0x00;
  m.stepFrame();
  const f = m.render({ rotate: false });
  assert.equal(f.rgb[0], 255);
  assert.equal(f.rgb[1], 132);   // 0x10 -> (0x10<<3)|(0x10>>2) = 128|4
  assert.equal(f.rgb[2], 0);
});

// ---- the machine: determinism and time travel ---------------------------------

// A program that keeps writing derived values into sprite RAM and the palette,
// so the state it produces is a function of how long it has run.
const BUSY = [
  I.MOVE_IMM_SR, 0x2000,
  I.ADDQ_W_1_ABSL, hi(0xffc000), lo(0xffc000),          // counter
  I.MOVE_W_ABSL_D0, hi(0xffc000), lo(0xffc000),
  I.MOVE_W_D0_ABSL, hi(0xe00000), lo(0xe00000),         // into the sprite table
  I.MOVE_W_D0_ABSL, hi(0x700000), lo(0x700000),         // and the palette
  I.MOVE_W_D0_ABSL, hi(0x100000), lo(0x100000),         // and the sound chip
  0x60e8,                                               // bra.s back to the top
];

const snapHash = (s) => {
  let h = 0x811c9dc5;
  const walk = (v) => {
    if (v == null) return;
    if (ArrayBuffer.isView(v)) { const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength); for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; } return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (typeof v === 'object') { for (const k of Object.keys(v).sort()) { walk(k); walk(v[k]); } return; }
    const s2 = String(v);
    for (let i = 0; i < s2.length; i++) { h ^= s2.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  };
  walk(s);
  return h >>> 0;
};

test('two identical boards stay identical for a hundred frames', () => {
  const a = machineWith(BUSY), b = machineWith(BUSY);
  for (let f = 0; f < 100; f++) { a.stepFrame(); b.stepFrame(); }
  assert.equal(snapHash(a.snapshot()), snapHash(b.snapshot()));
  const fa = a.render(), fb = b.render();
  assert.deepEqual(Array.from(fa.rgb), Array.from(fb.rgb));
});

test('input changes the future, so the determinism test is not vacuous', () => {
  const a = machineWith(BUSY), b = machineWith(BUSY);
  a.setDip(0x0000); b.setDip(0xffff);
  for (let f = 0; f < 10; f++) { a.stepFrame(); b.stepFrame(); }
  assert.notEqual(snapHash(a.snapshot()), snapHash(b.snapshot()));
});

test('a snapshot restores to a board that carries on identically', () => {
  const m = machineWith(BUSY);
  for (let f = 0; f < 40; f++) m.stepFrame();
  const s = JSON.parse(JSON.stringify(m.snapshot(), (k, v) =>
    ArrayBuffer.isView(v) ? { __t: v.constructor.name, d: Array.from(v) } : v));
  const revive = (o) => {
    if (o && typeof o === 'object' && o.__t) return new globalThis[o.__t](o.d);
    if (Array.isArray(o)) return o.map(revive);
    if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o)) r[k] = revive(o[k]); return r; }
    return o;
  };
  const snap = revive(s);

  // Run on, then come back and run the same distance again.
  for (let f = 0; f < 25; f++) m.stepFrame();
  const after = snapHash(m.snapshot());
  m.restore(snap);
  assert.equal(m.frame, 40);
  for (let f = 0; f < 25; f++) m.stepFrame();
  assert.equal(snapHash(m.snapshot()), after);
});

test('restoring into a second board gives the same picture as the first', () => {
  const a = machineWith(BUSY), b = machineWith(BUSY);
  for (let f = 0; f < 33; f++) a.stepFrame();
  b.restore(a.snapshot());
  assert.deepEqual(Array.from(b.render().rgb), Array.from(a.render().rgb));
  for (let f = 0; f < 17; f++) { a.stepFrame(); b.stepFrame(); }
  assert.equal(snapHash(a.snapshot()), snapHash(b.snapshot()));
});

test('a snapshot carries no ROM and stays small enough for a long rewind', () => {
  const m = machineWith(BUSY);
  for (let f = 0; f < 5; f++) m.stepFrame();
  const s = m.snapshot();
  let bytes = 0;
  const walk = (v) => {
    if (v == null) return;
    if (ArrayBuffer.isView(v)) { bytes += v.byteLength; return; }
    if (Array.isArray(v)) { bytes += v.length * 8; return; }
    if (typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k]); return; }
    bytes += 8;
  };
  walk(s);
  assert.ok(bytes < 64 * 1024, `snapshot is ${bytes} bytes`);
  // The program ROM is 64 KB and the sprite ROM bigger still; neither may be in
  // there. Checking the total is the honest way to say so.
  assert.ok(bytes < m.rom.length + 1024);
});

test('the schema version travels with the output', () => {
  const m = machineWith([0x60fe]);
  assert.equal(typeof m.schemaVersion, 'number');
  assert.equal(m.snapshot().schemaVersion, m.schemaVersion);
  assert.equal(m.render().schemaVersion, m.schemaVersion);
  assert.equal(m.video.getState().schemaVersion, 1);
  assert.equal(m.sound.getState().schemaVersion, 1);
});

test('update() emits whole frames from elapsed time', () => {
  const m = machineWith([0x60fe]);
  let n = 0;
  m.update(0.5, () => n++);
  assert.equal(n, 30);
  assert.equal(m.frame, 30);
});

test('audio comes out bounded and deterministic', () => {
  const a = machineWith(BUSY), b = machineWith(BUSY);
  for (let f = 0; f < 20; f++) { a.stepFrame(); b.stepFrame(); }
  const oa = new Float32Array(800), ob = new Float32Array(800);
  a.renderAudio(oa); b.renderAudio(ob);
  assert.deepEqual(Array.from(oa), Array.from(ob));
  for (const v of oa) assert.ok(v >= -1 && v <= 1);
});

test('the cycle budget carries its remainder rather than rounding it away', () => {
  const m = machineWith([0x60fe]);
  // 8 MHz / 60 is 133333 1/3, so three frames must be exactly 400000 cycles.
  const a = m._frameCycles(), b = m._frameCycles(), c = m._frameCycles();
  assert.equal(a + b + c, 400000);
});
