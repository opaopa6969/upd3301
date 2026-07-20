// node --test romid.test.mjs — deterministic, headless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identify, classifyAll, machinesFromRoles, basename, DISK_RE, TAPE_RE } from './romid.js';

test('recognises the PC-8801 N88 BIOS set by filename', () => {
  assert.equal(identify({ name: 'n88.rom' }).role, 'n88main');
  assert.equal(identify({ name: 'N88.ROM' }).role, 'n88main'); // case-insensitive
  for (let i = 0; i < 4; i++) assert.equal(identify({ name: `n88_${i}.rom` }).role, 'n88ext' + i);
  assert.equal(identify({ name: 'disk.rom' }).role, 'n88sub');
  assert.equal(identify({ name: 'N88EXT.ROM' }).role, 'n88ext'); // 32KB one-piece variant
});

test('recognises PC-8001 boot ROMs, fonts and kanji', () => {
  assert.equal(identify({ name: 'n80.rom' }).role, 'rom');
  assert.equal(identify({ name: 'N80_2.ROM' }).role, 'rom');   // PC-8001mkII
  assert.equal(identify({ name: 'font.rom' }).role, 'font');
  assert.equal(identify({ name: 'FONT88.ROM' }).role, 'font');
  assert.equal(identify({ name: 'kanji1.rom' }).role, 'n88kanji');
});

test('strips directories before matching', () => {
  assert.equal(basename('roms/8801MC/n88.rom'), 'n88.rom');
  assert.equal(identify({ name: 'roms/8801MC/n88.rom' }).role, 'n88main');
  assert.equal(identify({ name: 'C:\\dump\\N80.ROM' }).role, 'rom');
});

test('disk and tape containers are recognised by extension', () => {
  for (const n of ['game.d88', 'GAME.D88', 'a.88d', 'b.d8u', 'c.hdm', 'd.tfd', 'e.xdf']) {
    assert.equal(identify({ name: n }).kind, 'disk', n);
  }
  for (const n of ['t.t88', 't.cas', 't.cmt']) assert.equal(identify({ name: n }).kind, 'tape', n);
  assert.ok(DISK_RE.test('x.d88') && TAPE_RE.test('x.cas'));
});

test('rejects everything that is not a PC-8001/8801 file (the import filter)', () => {
  for (const n of ['readme.txt', 'N80_2.TXT', '2608_bd.wav', 'manifest.json',
                   'cbios_main_msx1.rom', 'PC98_BIOS.ROM', 'bios.bin', 'cover.png', '']) {
    assert.equal(identify({ name: n }), null, n);
  }
});

test('size mismatch warns but never rejects', () => {
  const ok = identify({ name: 'n88.rom', size: 0x8000 });
  assert.equal(ok.sizeWarn, false);
  const odd = identify({ name: 'n88.rom', size: 12345 });
  assert.equal(odd.role, 'n88main'); // still imported
  assert.equal(odd.sizeWarn, true);
  // disk.rom legitimately differs by model (2KB early, 8KB on the MC)
  assert.equal(identify({ name: 'disk.rom', size: 0x800 }).sizeWarn, false);
  assert.equal(identify({ name: 'disk.rom', size: 0x2000 }).sizeWarn, false);
});

test('88-family dumps we cannot boot are kept but flagged unsupported', () => {
  assert.equal(identify({ name: 'PC88VA.ROM' }).supported, false);
  assert.equal(identify({ name: 'jisyo.rom' }).supported, false);
  assert.equal(identify({ name: 'n88.rom' }).supported, true);
});

test('classifyAll splits keep/drop and explains the drops', () => {
  const { accepted, rejected } = classifyAll([
    { name: 'n88.rom', size: 0x8000 }, { name: 'game.d88' },
    { name: 'readme.txt' }, { name: 'song.wav' },
  ]);
  assert.deepEqual(accepted.map((a) => a.name), ['n88.rom', 'game.d88']);
  assert.deepEqual(rejected.map((r) => r.name), ['readme.txt', 'song.wav']);
  assert.match(rejected[0].reason, /認識できない/);
});

test('machinesFromRoles: PC-8001 needs only the boot ROM', () => {
  const m = machinesFromRoles(['rom']);
  const n80 = m.find((x) => x.id === 'pc8001');
  assert.equal(n80.ready, true);
  assert.deepEqual(n80.missing, []);
  assert.match(n80.optional[0], /font/); // font is wanted, not required
  assert.equal(machinesFromRoles([]).find((x) => x.id === 'pc8001').ready, false);
});

test('machinesFromRoles: PC-8801 N88 needs main + 4 banks + sub, banks either shape', () => {
  const split = ['n88main', 'n88ext0', 'n88ext1', 'n88ext2', 'n88ext3', 'n88sub'];
  assert.equal(machinesFromRoles(split).find((x) => x.id === 'pc8801n88').ready, true);
  // the one-piece 32KB ext image satisfies the four banks too
  assert.equal(machinesFromRoles(['n88main', 'n88ext', 'n88sub']).find((x) => x.id === 'pc8801n88').ready, true);
  // a Set works as well as an array
  assert.equal(machinesFromRoles(new Set(split)).find((x) => x.id === 'pc8801n88').ready, true);
  const partial = machinesFromRoles(['n88main']).find((x) => x.id === 'pc8801n88');
  assert.equal(partial.ready, false);
  assert.equal(partial.missing.length, 2); // banks + disk.rom
});
