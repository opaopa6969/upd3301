// PC-8012 expansion bank RAM — the 8001's official escape from 16KB.
// 32KB boards overlay 0000-7FFF; port E2h read-enable / E3h write-enable,
// one bit per bank, read and write INDEPENDENT. Needs a real N-BASIC ROM
// (BYO-ROM) because the machine won't construct without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const loadRom = async () => {
  for (const p of ['roms/8001mkII/N80_2.ROM', 'roms/basic-set/N80.rom']) {
    try { return new Uint8Array(await readFile(p)); } catch {}
  }
  return null;
};

const mk = async () => {
  const rom = await loadRom();
  if (!rom) return null;
  const { Pc8001Machine } = await import('./machine.js');
  return new Pc8001Machine({ rom });
};

test('pc8012: banks hide behind ROM until read-enabled', async (t) => {
  const m = await mk();
  if (!m) return t.skip('no ROM (bring your own)');
  const before = m.sys.memory[0x1234]; // ROM content via the flat array

  m._out(0xe3, 0x01); // write-enable bank 0 (reads still hit ROM)
  // run a tiny program from main RAM: LD A,5Ah ; LD (1234h),A ; HALT
  const prog = [0x3e, 0x5a, 0x32, 0x34, 0x12, 0x76];
  m.sys.memory.set(prog, 0x9000);
  m.cpu.pc = 0x9000;
  while (!m.cpu.halted) m.cpu.step();

  // ROM unchanged (write went to the bank), read still shows ROM
  assert.equal(m.sys.memory[0x1234], before);
  assert.equal(m.extRam[0]?.[0x1234], 0x5a);

  // now flip read-enable: the bank appears where ROM used to be
  m._out(0xe2, 0x01);
  const prog2 = [0x3a, 0x34, 0x12, 0x76]; // LD A,(1234); HALT
  m.sys.memory.set(prog2, 0x9100);
  m.cpu.halted = false; m.cpu.pc = 0x9100;
  while (!m.cpu.halted) m.cpu.step();
  assert.equal(m.cpu.a, 0x5a);

  // and back off: ROM returns
  m._out(0xe2, 0x00);
  m.cpu.halted = false; m.cpu.pc = 0x9100;
  while (!m.cpu.halted) m.cpu.step();
  assert.equal(m.cpu.a, before);
});

test('pc8012: broadcast write hits every write-enabled bank at once', async (t) => {
  const m = await mk();
  if (!m) return t.skip('no ROM (bring your own)');
  m._out(0xe3, 0x0f); // all four banks write-enabled
  const prog = [0x3e, 0x77, 0x32, 0x00, 0x40, 0x76]; // LD A,77; LD (4000),A; HALT
  m.sys.memory.set(prog, 0x9000);
  m.cpu.pc = 0x9000;
  while (!m.cpu.halted) m.cpu.step();
  for (let b = 0; b < 4; b++) assert.equal(m.extRam[b][0x4000], 0x77);
});

test('pc8012: E2/E3 read back, unused bits masked', async (t) => {
  const m = await mk();
  if (!m) return t.skip('no ROM (bring your own)');
  m._out(0xe2, 0xff);
  m._out(0xe3, 0xa5);
  assert.equal(m._in(0xe2), 0x0f); // only 4 banks fitted
  assert.equal(m._in(0xe3), 0x05);
});

test('pc8012 EX: 65536 banks, storage stays lazy', async (t) => {
  const rom = await loadRom();
  if (!rom) return t.skip('no ROM (bring your own)');
  const { Pc8001Machine } = await import('./machine.js');
  const m = new Pc8001Machine({ rom, extRamBanks: 65536 });
  assert.equal(m.exMode, true);

  // write one byte into bank 0xBEEF: select via E0/E1, enable, poke, read back
  m._out(0xe0, 0xef); m._out(0xe1, 0xbe);
  m._out(0xe3, 1);
  const prog = [0x3e, 0x33, 0x32, 0x00, 0x10, 0x76]; // LD A,33; LD (1000),A; HALT
  m.sys.memory.set(prog, 0x9000);
  m.cpu.pc = 0x9000;
  while (!m.cpu.halted) m.cpu.step();

  m._out(0xe2, 1);
  const prog2 = [0x3a, 0x00, 0x10, 0x76]; // LD A,(1000); HALT
  m.sys.memory.set(prog2, 0x9100);
  m.cpu.halted = false; m.cpu.pc = 0x9100;
  while (!m.cpu.halted) m.cpu.step();
  assert.equal(m.cpu.a, 0x33);

  // a different bank shows different (empty) memory
  m._out(0xe1, 0x00);
  m.cpu.halted = false; m.cpu.pc = 0x9100;
  while (!m.cpu.halted) m.cpu.step();
  assert.equal(m.cpu.a, 0x00);

  // 2 GiB address space, but only the banks we touched exist
  assert.equal(m.extRam.size, 2);
});
