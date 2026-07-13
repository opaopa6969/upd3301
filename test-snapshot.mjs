// time-travel tests: snapshot → run ahead → restore → run again must land
// on the IDENTICAL timeline. This is the property the ICE debugger's
// undo/redo tree is built on, so it gets tested at machine level.
// Needs real ROMs (BYO-ROM); skips without.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = async (p) => {
  try { return new Uint8Array(await readFile(p)); } catch { return null; }
};

const fingerprint = (m) => JSON.stringify({
  cpu: m.cpu.getState(),
  screen: m.screenText ? m.screenText() : null,
});

test('pc8001: snapshot/restore replays the identical timeline', async (t) => {
  const rom = await load('roms/8001mkII/N80_2.ROM') ?? await load('roms/basic-set/N80.rom');
  if (!rom) return t.skip('no ROM (bring your own)');
  const { Pc8001Machine } = await import('./machine.js');
  const m = new Pc8001Machine({ rom });
  for (let f = 0; f < 60; f++) m.stepFrame();

  const snap = m.snapshot();
  // run ahead WITH input (worst case: input arrives after the snapshot)
  m.keyDown(2, 1); // 'A'
  for (let f = 0; f < 20; f++) m.stepFrame();
  m.keyUp(2, 1);
  for (let f = 0; f < 20; f++) m.stepFrame();
  const first = fingerprint(m);

  // rewind and replay the same inputs at the same frames
  m.restore(snap);
  assert.equal(m.frame, 60);
  m.keyDown(2, 1);
  for (let f = 0; f < 20; f++) m.stepFrame();
  m.keyUp(2, 1);
  for (let f = 0; f < 20; f++) m.stepFrame();
  assert.equal(fingerprint(m), first);
});

test('pc8001: restore rolls back divergent state (bank RAM included)', async (t) => {
  const rom = await load('roms/8001mkII/N80_2.ROM') ?? await load('roms/basic-set/N80.rom');
  if (!rom) return t.skip('no ROM (bring your own)');
  const { Pc8001Machine } = await import('./machine.js');
  const m = new Pc8001Machine({ rom });
  for (let f = 0; f < 30; f++) m.stepFrame();
  const snap = m.snapshot();
  const before = fingerprint(m);

  // diverge hard: poke bank RAM, mash keys, run
  m._out(0xe3, 0x03);
  m.keyDown(6, 3);
  for (let f = 0; f < 45; f++) m.stepFrame();
  assert.notEqual(fingerprint(m), before);

  m.restore(snap);
  assert.equal(fingerprint(m), before);
  assert.equal(m.writeEn, 0); // bank state rewound too
});

test('pc8801: snapshot/restore with sub board and mounted disk', async (t) => {
  const main = await load('roms/8801mkIIFR/n88.rom');
  const sub = await load('roms/8801mkIIFR/disk.rom');
  if (!main || !sub) return t.skip('no ROMs (bring your own)');
  const ext = new Uint8Array(0x8000);
  for (let i = 0; i < 4; i++) {
    const b = await load(`roms/8801mkIIFR/n88_${i}.rom`);
    if (b) ext.set(b, i * 0x2000);
  }
  const { Pc8801Machine } = await import('./machine88.js');
  const { buildD88, parseD88 } = await import('./d88.js');
  const disk = parseD88(buildD88({
    name: 'TT', tracks: [[{ c: 0, h: 0, r: 1, n: 1, data: new Uint8Array(256).fill(7) }]],
  }));

  const m = new Pc8801Machine({ main, ext, sub, mode: 'n88' });
  m.insertDisk(0, disk);
  for (let f = 0; f < 40; f++) m.stepFrame(); // through sub handshake territory

  const snap = m.snapshot();
  for (let f = 0; f < 30; f++) m.stepFrame();
  const first = JSON.stringify({
    main: m.cpu.getState(), sub: m.sub.cpu.getState(),
    fdc: m.sub.fdc.getState(), screen: m.screenText(),
  });

  m.restore(snap);
  for (let f = 0; f < 30; f++) m.stepFrame();
  const second = JSON.stringify({
    main: m.cpu.getState(), sub: m.sub.cpu.getState(),
    fdc: m.sub.fdc.getState(), screen: m.screenText(),
  });
  assert.equal(second, first);
});
