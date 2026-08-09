// test-pc98 — PC-9801 core tests, headless and without copyrighted ROMs.
//
// The machine tests build a tiny BIOS at E8000. This is deliberately the same
// arrangement as a physical 96 KB IPL window, so reset-vector and I/O bugs are
// exercised without requiring BIOS.ROM, ITF.ROM, or a disk image.

import test from 'node:test';
import assert from 'node:assert/strict';

import { I8086 } from './i8086.js';
import { Pc98Machine } from './machinepc98.js';
import { Pc98Fdd, parseRaw, summarizePc98Disk, bootRecord } from './pc98fdd.js';

function cpuWith(code) {
  const mem = new Uint8Array(0x10000);
  mem.set(code);
  const cpu = new I8086({
    read8: (a) => mem[a & 0xffff],
    write8: (a, v) => { mem[a & 0xffff] = v & 0xff; },
  }, { v30: true });
  cpu.s[1] = 0;
  cpu.s[2] = 0;
  cpu.r[4] = 0x100;
  cpu.ip = 0;
  return { cpu, mem };
}

function tinyBios(code = [0xf4]) {
  const rom = new Uint8Array(0x18000).fill(0xff);
  rom.set(code, 0);                         // E800:0000
  rom.set([0xea, 0x00, 0x00, 0x00, 0xe8], 0x17ff0); // reset -> E800:0000
  return rom;
}

function displayBios() {
  return tinyBios([
    0xfa,                                     // CLI
    0xb8, 0x00, 0xa0,                        // MOV AX,A000
    0x8e, 0xc0,                              // MOV ES,AX
    0x26, 0xc7, 0x06, 0x00, 0x00, 0x41, 0x00, // MOV ES:[0000],0041 ('A')
    0x26, 0xc6, 0x06, 0x00, 0x20, 0xe1,     // visible, white attribute
    0xb0, 0x6b, 0xe6, 0x62,                  // GDC1 START
    0xf4,                                    // HLT
  ]);
}

function testFont() {
  const font = new Uint8Array(288768);
  font.fill(0xff, 0x800 + 0x41 * 16, 0x800 + 0x42 * 16);
  return font;
}

test('V30 FPO2 memory form consumes its addressing bytes and is a no-op', () => {
  const { cpu } = cpuWith([0x66, 0x06, 0x34, 0x12, 0xf4]);
  cpu.r[0] = 0x55aa;
  cpu.step();
  assert.equal(cpu.ip, 4);
  assert.equal(cpu.r[0], 0x55aa);
});

test('V30 FPO2 register form takes vector 7 from the instruction start', () => {
  const { cpu, mem } = cpuWith([0x66, 0xc0]);
  mem[0x1c] = 0x00; mem[0x1d] = 0x02;       // vector 7 = 0000:0200
  cpu.step();
  assert.equal(cpu.s[1], 0);
  assert.equal(cpu.ip, 0x200);
  assert.equal(cpu.r[4], 0xfa);
  assert.equal(mem[0xfa] | (mem[0xfb] << 8), 0, 'return IP is the FPO2 byte');
});

test('machine boots a self-contained BIOS and produces text pixels', () => {
  const m = new Pc98Machine({ bios: displayBios(), font: testFont() });
  m.stepFrame();
  const frame = m.render();
  let lit = 0;
  for (const b of frame.rgb) if (b) lit++;
  assert.equal(m.cpu.halted, true);
  assert.equal(m.gdcText.displayEnabled, true);
  assert.ok(lit > 0);
});

test('word I/O reaches both byte lanes in a shared device block', () => {
  const m = new Pc98Machine();
  const pitWrites = [];
  m.pit.write = (reg, value) => pitWrites.push([reg, value]);
  m._out16(0x70, 0x1234);
  assert.equal(m.video.textScroll[0], 0x34, 'low byte reaches the text register');
  assert.deepEqual(pitWrites, [[0, 0x12]], 'high byte reaches PIT channel zero');
});

test('$0439 is a reset-low readable latch', () => {
  const m = new Pc98Machine();
  assert.equal(m._in8(0x439), 0);
  m._out8(0x439, 0xa5);
  assert.equal(m._in8(0x439), 0xa5);
  m.reset();
  assert.equal(m._in8(0x439), 0);
});

test('unmapped-I/O tracing records the first-class bus event', () => {
  const m = new Pc98Machine();
  m.unknownIoLog = [];
  m._in8(0x439);
  m._out8(0x461, 0x08);
  assert.deepEqual(m.unknownIoLog.map(({ r, p, v }) => ({ r, p, v })),
    [{ r: 0, p: 0x461, v: 0x08 }]);
});

test('system, printer, and mouse PPIs occupy their correct byte lanes', () => {
  const m = new Pc98Machine({ dipsw: [0x12, 0x34] });
  assert.equal(m._in8(0x31), 0x12);
  assert.equal(m._in8(0x33), 0x34);
  assert.equal(m._in8(0x35), 0xa0);
  m._out8(0x46, 0x82);
  assert.equal(m.printerPpi.control, 0x82);
  m._out8(0x7fdf, 0x93);
  assert.equal(m.mousePpi.control, 0x93);
});

test('snapshot excludes firmware and disks and restores machine latches', () => {
  const m = new Pc98Machine({ bios: tinyBios() });
  m._out8(0x439, 0x5a);
  m._out8(0x70, 0x34);
  const s = m.snapshot();
  for (const forbidden of ['bios', 'itf', 'font', 'sound', 'disk', 'disks']) {
    assert.equal(Object.hasOwn(s, forbidden), false, forbidden);
  }
  assert.equal(s.video.gvram, null, 'clean graphics RAM uses copy-on-dirty');
  m._out8(0x439, 0);
  m._out8(0x70, 0);
  m.restore(s);
  assert.equal(m._in8(0x439), 0x5a);
  assert.equal(m._in8(0x70), 0x34);
});

test('graphics planes enter snapshots only after the first write', () => {
  const m = new Pc98Machine();
  assert.equal(m.snapshot().video.gvram, null);
  m._write8(0xa8000, 0x80);
  const s = m.snapshot();
  assert.equal(s.video.gvram.length, 4);
  assert.equal(s.video.gvram[0][0], 0x80);
});

test('ITF bank switching changes the reset-window source but not snapshots', () => {
  const bios = tinyBios();
  const itf = new Uint8Array(0x8000).fill(0x5a);
  const m = new Pc98Machine({ bios, itf });
  assert.equal(m._read8(0xf8000), 0x5a);
  m._out8(0x43d, 0x12);
  assert.equal(m.itfEnabled, false);
  assert.equal(m._read8(0xf8000), bios[0x10000]);
  assert.equal(Object.hasOwn(m.snapshot(), 'itf'), false);
});

test('raw 2HD images expose PC-98 geometry and a boot record', () => {
  const bytes = new Uint8Array(1024 * 8 * 154).fill(0xe5);
  bytes.set([0xeb, 0x3c, 0x90, 0x50, 0x43, 0x39, 0x38]);
  const disk = parseRaw(bytes);
  assert.deepEqual(summarizePc98Disk(disk), {
    name: '', media: '2HD', tracks: 154, sectors: 1232, bytes: 1261568,
  });
  assert.deepEqual(bootRecord(disk).first.slice(0, 3), [0xeb, 0x3c, 0x90]);
});

test('FDC data request and command-complete interrupt are distinct', () => {
  const bytes = new Uint8Array(1024 * 8 * 154).fill(0xe5);
  const f = new Pc98Fdd();
  f.insert(0, parseRaw(bytes));
  f.write(0x94, 0x88);
  for (const b of [0x46, 0, 0, 0, 1, 3, 1, 0x35, 0xff]) f.write(0x92, b);
  assert.equal(f.dataReady, true);
  assert.equal(f.intPending, false);
  for (let i = 0; i < 1024; i++) f.read(0x92);
  assert.equal(f.dataReady, false);
  assert.equal(f.intPending, true);
});

test('FDC SENSE INTERRUPT without a pending event is one byte', () => {
  const f = new Pc98Fdd();
  f.write(0x92, 0x08);
  assert.equal(f.intPending, false);
  assert.equal(f.read(0x92), 0x80);
  assert.equal(f.fdc.phase, 'idle');
});

