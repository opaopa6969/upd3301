// test-nes — PPU, mappers and the Famicom machine class.
//
// The determinism tests at the bottom are the load-bearing ones: the host's
// rewind is "restore a snapshot and replay the same inputs", so a machine that
// is not bit-reproducible does not degrade, it breaks every time-manipulation
// feature at once.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildINes, parseINes, MIRRORING } from './ines.js';
import { createMapper, tryCreateMapper, supportedMappers, MIRROR } from './nesmapper.js';
import { NesPpu, SCREEN_W, SCREEN_H, buildNesPaletteRgb, PRERENDER_LINE, VBLANK_LINE } from './nesppu.js';
import { NesMachine, BUTTON } from './machinenes.js';

// ---------------------------------------------------------------------------
// helpers

// A cartridge whose PRG is filled with a recognisable per-bank pattern, so a
// bank-switching test can say WHICH bank it is looking at.
function cart({ prgBanks = 2, chrBanks = 1, mapper = 0, mirroring = MIRRORING.HORIZONTAL, chrRam = false, code = null } = {}) {
  const prg = new Uint8Array(prgBanks * 0x4000);
  for (let b = 0; b < prgBanks; b++) prg.fill(b, b * 0x4000, (b + 1) * 0x4000);
  // reset/NMI/IRQ vectors live in the last bank, which is where every board
  // keeps something fixed
  const last = prg.length;
  prg[last - 4] = 0x00; prg[last - 3] = 0xc0; // RESET -> $C000
  prg[last - 6] = 0x00; prg[last - 5] = 0xc0; // NMI
  prg[last - 2] = 0x00; prg[last - 1] = 0xc0; // IRQ
  if (code) prg.set(code, prg.length - 0x4000); // code at the start of the last bank
  let chr = null;
  if (!chrRam) {
    chr = new Uint8Array(Math.max(1, chrBanks) * 0x2000);
    for (let b = 0; b < chr.length / 0x400; b++) chr.fill(b, b * 0x400, (b + 1) * 0x400);
  }
  return parseINes(buildINes({ prg, chr, mapper, mirroring }));
}

// A machine running one instruction forever, so tests can drive the raster
// without a game getting in the way.
function idleMachine(opts = {}) {
  const code = new Uint8Array([0x4c, 0x00, 0xc0]); // JMP $C000
  return new NesMachine({ cart: cart({ ...opts, code }) });
}

const fingerprint = (m) => JSON.stringify(m.snapshot(), (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));

// ---------------------------------------------------------------------------
test('mapper registry: the five required boards plus AxROM', () => {
  for (const n of [0, 1, 2, 3, 4]) assert.ok(supportedMappers().includes(n), `mapper ${n} missing`);
  assert.ok(supportedMappers().includes(7));
});

test('unsupported mapper is an answer, not a crash', () => {
  const c = cart({ mapper: 5 });
  const r = tryCreateMapper(c);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unsupported-mapper');
  assert.match(r.error, /mapper 5/);
  assert.throws(() => createMapper(c));
});

test('NROM: a 16KB board appears twice, so the vectors are reachable', () => {
  const m = createMapper(cart({ prgBanks: 1 }));
  assert.equal(m.cpuRead(0x8000), m.cpuRead(0xc000));
  assert.equal(m.mirroring, MIRROR.HORIZONTAL);
});

test('UxROM: $8000 switches, $C000 is nailed to the last bank', () => {
  const m = createMapper(cart({ prgBanks: 4, mapper: 2, chrRam: true }));
  assert.equal(m.cpuRead(0xc000), 3, 'last bank fixed');
  m.cpuWrite(0x8000, 2);
  assert.equal(m.cpuRead(0x8000), 2);
  assert.equal(m.cpuRead(0xc000), 3, 'switching must not move the fixed half');
});

test('CNROM: the whole character ROM swaps at once', () => {
  const m = createMapper(cart({ mapper: 3, chrBanks: 4 }));
  assert.equal(m.ppuRead(0x0000), 0);
  m.cpuWrite(0x8000, 2);
  assert.equal(m.ppuRead(0x0000), 16, '8KB bank 2 starts at 1KB-bank 16');
});

test('AxROM: 32KB PRG bank and a single-screen mirroring select', () => {
  const m = createMapper(cart({ prgBanks: 4, mapper: 7, chrRam: true }));
  assert.equal(m.mirroring, MIRROR.SINGLE_A);
  m.cpuWrite(0x8000, 0x11);
  assert.equal(m.mirroring, MIRROR.SINGLE_B);
  assert.equal(m.cpuRead(0x8000), 2, 'bank 1 of 32KB = PRG 16K-bank 2');
});

test('MMC1 takes five writes, low bit first', () => {
  const m = createMapper(cart({ prgBanks: 8, mapper: 1, chrRam: true }));
  // control := $0C (fix last bank at $C000) is the power-on state
  assert.equal(m.cpuRead(0xc000), 7);
  // write PRG bank 3 into $E000: bits 1,1,0,0,0 low-first
  let cyc = 0;
  for (const bit of [1, 1, 0, 0, 0]) m.cpuWrite(0xe000, bit, (cyc += 10));
  assert.equal(m.cpuRead(0x8000), 3);
  assert.equal(m.cpuRead(0xc000), 7, 'mode 3 keeps the last bank fixed');
});

test('MMC1 ignores the second of two writes on consecutive cycles', () => {
  // This is what a read-modify-write instruction does, and games use it on
  // purpose to clock ONE bit with one instruction.
  const m = createMapper(cart({ prgBanks: 8, mapper: 1, chrRam: true }));
  const before = m.shift;
  m.cpuWrite(0xe000, 1, 100);
  const after = m.shift;
  assert.notEqual(after, before);
  m.cpuWrite(0xe000, 1, 101); // consecutive: must be dropped
  assert.equal(m.shift, after);
});

test('MMC1: a write with bit 7 set resets the shift register and forces mode 3', () => {
  const m = createMapper(cart({ prgBanks: 8, mapper: 1, chrRam: true }));
  let cyc = 0;
  for (const bit of [0, 0]) m.cpuWrite(0x8000, bit, (cyc += 10));
  m.cpuWrite(0x8000, 0x80, (cyc += 10));
  assert.equal(m.shift, 0x10, 'shift register back to its marker state');
  assert.equal(m.control & 0x0c, 0x0c);
});

test('MMC3: PRG mode bit swaps which end is fixed', () => {
  const m = createMapper(cart({ prgBanks: 8, mapper: 4 }));
  const banks = 16; // 8 x 16KB = 16 x 8KB
  m.cpuWrite(0x8000, 6); m.cpuWrite(0x8001, 1); // R6 = 8KB bank 1
  assert.equal(m.prgOffset(0x8000), 1 * 0x2000);
  assert.equal(m.prgOffset(0xc000), (banks - 2) * 0x2000);
  m.cpuWrite(0x8000, 0x40 | 6); // mode 1
  assert.equal(m.prgOffset(0x8000), (banks - 2) * 0x2000);
  assert.equal(m.prgOffset(0xc000), 1 * 0x2000);
  assert.equal(m.prgOffset(0xe000), (banks - 1) * 0x2000, '$E000 is always the last bank');
});

test('MMC3: the scanline counter reloads, decrements, and needs A12 to be low first', () => {
  const m = createMapper(cart({ prgBanks: 8, mapper: 4 }));
  m.cpuWrite(0xc000, 2);      // latch = 2
  m.cpuWrite(0xc001, 0);      // reload
  m.cpuWrite(0xe001, 0);      // enable IRQ
  const rise = () => { m.ppuAddrBus(0x0000, 16); m.ppuAddrBus(0x1000, 1); };
  rise(); assert.equal(m.irqCounter, 2); assert.equal(m.irq, false);
  rise(); assert.equal(m.irqCounter, 1);
  rise(); assert.equal(m.irqCounter, 0); assert.equal(m.irq, true, 'IRQ when the counter hits zero');
  m.cpuWrite(0xe000, 0);
  assert.equal(m.irq, false, 'writing $E000 acknowledges');
  // A rise with no low time before it is filtered out — that filter is the
  // whole reason the counter tracks scanlines instead of tile fetches.
  m.cpuWrite(0xc000, 5); m.cpuWrite(0xc001, 0); m.cpuWrite(0xe001, 0);
  m.ppuAddrBus(0x1000, 1);
  const before = m.irqCounter;
  m.ppuAddrBus(0x1000, 1);
  assert.equal(m.irqCounter, before, 'no rise, no clock');
});

// ---------------------------------------------------------------------------
test('PPU: $2006/$2005 write into the same address register (loopy v/t/x/w)', () => {
  const p = new NesPpu(createMapper(cart({})));
  p.writeReg(6, 0x21); p.writeReg(6, 0x08);
  assert.equal(p.v, 0x2108);
  assert.equal(p.w, 0, 'the toggle returns to its first state');
  p.writeReg(5, 0x7d); // X scroll: coarse 15, fine 5
  assert.equal(p.x, 5);
  assert.equal(p.t & 0x1f, 0x0f);
  p.writeReg(5, 0x5e); // Y scroll: coarse 11, fine 6
  assert.equal((p.t >> 12) & 7, 6);
  assert.equal((p.t >> 5) & 0x1f, 11);
});

test('PPU: reading $2002 clears the write toggle mid-sequence', () => {
  const p = new NesPpu(createMapper(cart({})));
  p.writeReg(6, 0x21);
  p.readReg(2);
  p.writeReg(6, 0x08);
  assert.equal(p.v, 0, 'the second write started a new sequence, so v never loaded');
});

test('PPU: $2007 increments by 1 or 32 and reads through a one-byte buffer', () => {
  const p = new NesPpu(createMapper(cart({})));
  p.writeReg(6, 0x20); p.writeReg(6, 0x00);
  p.writeReg(7, 0xaa); p.writeReg(7, 0xbb);
  assert.equal(p.v, 0x2002);
  p.writeReg(6, 0x20); p.writeReg(6, 0x00);
  assert.equal(p.readReg(7), 0, 'first read returns the stale buffer');
  assert.equal(p.readReg(7), 0xaa);
  assert.equal(p.readReg(7), 0xbb);
  p.writeReg(0, 0x04); // +32
  const v = p.v;
  p.readReg(7);
  assert.equal(p.v, v + 32);
});

test('PPU: palette reads are immediate and $3F10 mirrors $3F00', () => {
  const p = new NesPpu(createMapper(cart({})));
  p.writeReg(6, 0x3f); p.writeReg(6, 0x10);
  p.writeReg(7, 0x21);
  assert.equal(p.paletteRam[0x00], 0x21, '$3F10 is the same entry as $3F00');
  p.writeReg(6, 0x3f); p.writeReg(6, 0x00);
  assert.equal(p.readReg(7) & 0x3f, 0x21, 'no buffering in palette space');
});

test('PPU: nametable mirroring follows the board, and the board can change it', () => {
  const mapper = createMapper(cart({ prgBanks: 8, mapper: 1, chrRam: true }));
  const p = new NesPpu(mapper);
  mapper.mirroring = MIRROR.VERTICAL;
  p._write(0x2000, 0x11);
  assert.equal(p._read(0x2800), 0x11, 'vertical: $2000 and $2800 are the same');
  assert.notEqual(p._read(0x2400), 0x11);
  mapper.mirroring = MIRROR.HORIZONTAL;
  p._write(0x2000, 0x22);
  assert.equal(p._read(0x2400), 0x22, 'horizontal: $2000 and $2400 are the same');
  mapper.mirroring = MIRROR.SINGLE_B;
  p._write(0x2000, 0x33);
  assert.equal(p._read(0x2c00), 0x33, 'single screen: all four are one');
});

test('PPU: vblank flag set at 241/1, cleared at the pre-render line', () => {
  const m = idleMachine();
  m.ppu.writeReg(0, 0x80); // NMI on vblank
  let sawVbl = false, sawNmi = false;
  for (let i = 0; i < 341 * 262 * 2; i++) {
    m.ppu.tick();
    if (m.ppu.scanline === VBLANK_LINE && m.ppu.dot === 1) { sawVbl = (m.ppu.status & 0x80) !== 0; sawNmi = m.ppu.nmiLine(); }
    if (m.ppu.scanline === PRERENDER_LINE && m.ppu.dot === 2) {
      assert.equal(m.ppu.status & 0x80, 0, 'cleared at the pre-render line');
    }
  }
  assert.ok(sawVbl && sawNmi);
});

test('PPU: reading $2002 on the dot the flag is set suppresses the NMI', () => {
  const p = new NesPpu(createMapper(cart({})));
  p.writeReg(0, 0x80);
  while (!(p.scanline === VBLANK_LINE && p.dot === 1)) p.tick();
  assert.ok(p.nmiLine(), 'the line went active');
  p.readReg(2);
  assert.equal(p.nmiLine(), false, 'and the read took it away before the CPU could see it');
});

test('PPU: a frame is 262 scanlines, and odd frames are one dot short', () => {
  const p = new NesPpu(createMapper(cart({})));
  const count = () => { let n = 0; do { p.tick(); n++; } while (!(p.scanline === 0 && p.dot === 0)); return n; };
  p.mask = 0; p.rendering = false;
  while (!(p.scanline === 0 && p.dot === 0)) p.tick();
  assert.equal(count(), 341 * 262, 'rendering off: every frame is full length');
  p.mask = 0x18; p.rendering = true;
  const a = count(), b = count();
  assert.equal(Math.min(a, b), 341 * 262 - 1, 'one of the two frames drops a dot');
  assert.equal(Math.max(a, b), 341 * 262);
});

test('PPU: the palette LUT covers all 64 colours x 8 emphasis states', () => {
  const lut = buildNesPaletteRgb();
  assert.equal(lut.length, 64 * 8 * 3);
  // emphasis dims; all three bits set must not brighten anything
  for (let c = 0; c < 64; c++) {
    for (let ch = 0; ch < 3; ch++) {
      assert.ok(lut[(7 * 64 + c) * 3 + ch] <= lut[c * 3 + ch]);
    }
  }
});

// ---------------------------------------------------------------------------
test('machine: sprite 0 hit fires where the sprite meets the background', () => {
  const m = idleMachine();
  const p = m.ppu;
  // solid tile 1 (all bits set in both planes is not needed — plane 0 is enough)
  m.mapper.chr.fill(0xff, 0x0010, 0x0020);
  p.ciram.fill(1, 0, 0x3c0);      // background of tile 1 everywhere
  p.oam[0] = 40; p.oam[1] = 1; p.oam[2] = 0; p.oam[3] = 40; // sprite 0 at (40,41)
  p.paletteRam[0] = 0x0f; p.paletteRam[1] = 0x30; p.paletteRam[0x11] = 0x16;
  p.writeReg(0, 0x00);
  p.writeReg(1, 0x1e);            // bg + sprites, no left clipping
  // Stop at the post-render line: the flags are wiped again at 261/1, so a
  // whole-frame loop would read them back as clear.
  while (p.scanline !== 240) p.tick();
  assert.ok(p.status & 0x40, 'sprite 0 hit');
});

test('machine: sprite overflow reports nine sprites on a line', () => {
  const m = idleMachine();
  const p = m.ppu;
  for (let i = 0; i < 9; i++) { p.oam[i * 4] = 50; p.oam[i * 4 + 1] = 1; p.oam[i * 4 + 3] = i * 8; }
  p.writeReg(1, 0x1e);
  while (p.scanline !== 240) p.tick();
  assert.ok(p.status & 0x20, 'sprite overflow');
});

test('machine: controller is a shift register, strobe reloads it', () => {
  const m = idleMachine();
  m.padDown(BUTTON.A); m.padDown(BUTTON.START);
  m._padStrobe(1); m._padStrobe(0);
  const bits = [];
  for (let i = 0; i < 8; i++) bits.push(m._padRead(0) & 1);
  assert.deepEqual(bits, [1, 0, 0, 1, 0, 0, 0, 0], 'A, then B/Select, then Start');
  assert.equal(m._padRead(0) & 1, 1, 'past the eighth read the line reads 1');
});

test('machine: OAM DMA copies 256 bytes and costs 513-514 cycles', () => {
  const m = idleMachine();
  for (let i = 0; i < 256; i++) m.ram[0x200 + i] = i ^ 0x5a;
  m.ppu.writeReg(3, 0);
  const before = m.cpu.cycles;
  m._oamDma(0x02);
  const spent = m.cpu.cycles - before;
  assert.ok(spent === 513 || spent === 514, `DMA took ${spent} cycles`);
  for (let i = 0; i < 256; i++) assert.equal(m.ppu.oam[i], i ^ 0x5a);
});

test('machine: render() emits plain data in both shapes', () => {
  const m = idleMachine();
  m.stepFrame();
  const rgb = m.render();
  assert.equal(rgb.width, SCREEN_W);
  assert.equal(rgb.height, SCREEN_H);
  assert.equal(rgb.rgb.length, SCREEN_W * SCREEN_H * 3);
  const idx = m.render({ indexed: true, analog: true });
  assert.equal(idx.pixels.length, SCREEN_W * SCREEN_H);
  assert.equal(idx.drive.length, SCREEN_W * SCREEN_H * 3);
  for (const v of idx.pixels) assert.ok(v >= 0 && v <= 7, 'GRB index stays in the phosphor pipeline range');
});

test('machine: a jammed CPU still lets the frame finish', () => {
  // KIL/JAM stops the CPU dead, and with it every bus access — so without the
  // machine driving the clock by hand, stepFrame would never return.
  const m = new NesMachine({ cart: cart({ code: new Uint8Array([0x02]) }) });
  m.stepFrame();
  assert.equal(m.cpu.jammed, true);
  assert.equal(m.frame, 1);
});

// ---------------------------------------------------------------------------
// determinism — the property rewind is built on

test('determinism: the same cartridge run twice lands on the same state', () => {
  const c = buildINes({
    prg: (() => { const p = new Uint8Array(0x8000); p.set([0x4c, 0x00, 0xc0], 0x4000); p[0x7ffc] = 0x00; p[0x7ffd] = 0xc0; return p; })(),
    chr: new Uint8Array(0x2000).fill(0x5a),
  });
  const a = new NesMachine({ rom: c });
  const b = new NesMachine({ rom: c });
  for (let i = 0; i < 8; i++) { a.stepFrame(); b.stepFrame(); }
  assert.equal(fingerprint(a), fingerprint(b));
});

test('determinism: snapshot, run ahead, restore, replay -> identical', () => {
  const m = idleMachine();
  m.ppu.writeReg(0, 0x80);
  m.ppu.writeReg(1, 0x1e);
  for (let i = 0; i < 4; i++) m.stepFrame();
  const snap = m.snapshot();
  for (let i = 0; i < 6; i++) m.stepFrame();
  const ahead = fingerprint(m);
  m.restore(snap);
  for (let i = 0; i < 6; i++) m.stepFrame();
  assert.equal(fingerprint(m), ahead);
});

test('determinism: replay stays identical when input arrives mid-replay', () => {
  // The worst case for rewind: the snapshot is old, and the buttons the host
  // replays land in the middle of the run.
  const m = idleMachine();
  m.ppu.writeReg(1, 0x1e);
  for (let i = 0; i < 3; i++) m.stepFrame();
  const snap = m.snapshot();
  const run = () => {
    for (let i = 0; i < 8; i++) {
      if (i === 3) m.padDown(BUTTON.START);
      if (i === 5) { m.padUp(BUTTON.START); m.padDown(BUTTON.LEFT); }
      m.stepFrame();
    }
  };
  run();
  const first = fingerprint(m);
  m.restore(snap);
  run();
  assert.equal(fingerprint(m), first);
});

test('determinism: a mapper IRQ arriving during the replay does not diverge', () => {
  // MMC3's counter lives in the mapper and is clocked by the PPU address bus,
  // so it is exactly the kind of state a snapshot could forget.
  const code = new Uint8Array([
    0xa9, 0x02, 0x8d, 0x00, 0xc0, // LDA #2 ; STA $C000  (IRQ latch)
    0x8d, 0x01, 0xc0,             // STA $C001           (reload)
    0x8d, 0x01, 0xe0,             // STA $E001           (enable)
    0xa9, 0x1e, 0x8d, 0x01, 0x20, // LDA #$1E ; STA $2001 (rendering on)
    0x58,                         // CLI
    0x4c, 0x11, 0xc0,             // JMP self
  ]);
  const m = new NesMachine({ cart: cart({ prgBanks: 8, mapper: 4, code }) });
  for (let i = 0; i < 3; i++) m.stepFrame();
  assert.ok(m.mapper.irqEnabled, 'the test program armed the counter');
  const snap = m.snapshot();
  for (let i = 0; i < 5; i++) m.stepFrame();
  const ahead = fingerprint(m);
  m.restore(snap);
  for (let i = 0; i < 5; i++) m.stepFrame();
  assert.equal(fingerprint(m), ahead);
});

test('host contract: the demo page can fast-forward and rewind this machine', () => {
  // A headless stand-in for demo/machine.html's transport: update(dt) paced by
  // the machine's own refresh, a snapshot ring every REWIND_EVERY frames, and
  // rewind = pop the ring and restore. The host does not know what machine it
  // is driving, so this is the whole integration, minus the canvas.
  const REWIND_EVERY = 6;
  const m = idleMachine();
  m.ppu.writeReg(1, 0x1e);
  assert.equal(typeof m.stepFrame, 'function');
  assert.equal(typeof m.update, 'function');
  assert.equal(typeof m.snapshot, 'function');
  assert.equal(typeof m.restore, 'function');
  assert.ok(m.schemaVersion >= 1);
  assert.ok(m.frameHz > 59 && m.frameHz < 61, 'NTSC refresh');

  const history = [];
  let lastSnapFrame = -1;
  const tick = (dt, speed = 1) => {
    m.update(Math.min(dt * speed, 0.5));
    if (m.frame - lastSnapFrame >= REWIND_EVERY) {
      lastSnapFrame = m.frame;
      history.push({ snap: m.snapshot(), frame: m.frame });
    }
  };
  for (let i = 0; i < 60; i++) tick(1 / 60);
  assert.ok(m.frame >= 59 && m.frame <= 61, `one second of dt gave ${m.frame} frames`);
  assert.ok(history.length >= 9, 'the ring filled');

  // fast-forward: the same wall-clock time at x4 must cover ~4x the frames
  const before = m.frame;
  for (let i = 0; i < 10; i++) tick(1 / 60, 4);
  assert.ok(m.frame - before >= 38, `x4 covered only ${m.frame - before} frames`);

  // rewind: pop the ring and restore, exactly as pressing the button does
  const target = history[history.length - 3];
  m.restore(target.snap);
  assert.equal(m.frame, target.frame);
  const replay = fingerprint(m);
  m.restore(target.snap);
  assert.equal(fingerprint(m), replay, 'restoring twice is idempotent');
  // and forward play from a restored point stays deterministic
  for (let i = 0; i < 5; i++) m.stepFrame();
  const forward = fingerprint(m);
  m.restore(target.snap);
  for (let i = 0; i < 5; i++) m.stepFrame();
  assert.equal(fingerprint(m), forward);
});

test('snapshot: immutable cartridge data never travels', () => {
  const m = idleMachine({ prgBanks: 8, mapper: 4 });
  const s = m.snapshot();
  const json = JSON.stringify(s, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
  // 8 x 16KB of PRG plus 8KB of CHR would be ~140,000 numbers; the budget is
  // the host's 1000-snapshot ring, so this must stay in the low kilobytes.
  assert.ok(json.length < 60000, `snapshot is ${json.length} bytes of JSON — cartridge data leaked in?`);
  assert.equal(s.mapper.prgRam, null, 'untouched work RAM is not copied');
});

test('restore() writes into the existing objects (no reallocation)', () => {
  const m = idleMachine();
  const ram = m.ram, oam = m.ppu.oam;
  m.stepFrame();
  m.restore(m.snapshot());
  assert.equal(m.ram, ram);
  assert.equal(m.ppu.oam, oam);
});
