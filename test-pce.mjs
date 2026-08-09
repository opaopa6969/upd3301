// PC Engine tests: the cartridge reader, the VCE, the VDC, the PSG and the
// machine contract that demo/machine.html's time travel rides on.
//
// No copyrighted ROM is in this repository, so everything here runs on images
// built by pcerom.buildPce() and on a hand-assembled program that programmes
// the video chip the way a real title does.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePce, tryParsePce, buildPce, buildBankMap, summarizePce, reverseBits,
  MAPPER, BANK_SIZE,
} from './pcerom.js';
import { HuC6260 } from './huc6260.js';
import { HuC6270, MAX_WIDTH, ST_VBLANK, ST_RASTER, ST_VRAM_DMA, R_CR, R_MAWR, R_MARR, R_VXR, R_SOUR, R_DESR, R_LENR, R_SATB, R_DCR } from './huc6270.js';
import { PcePsg } from './pcepsg.js';
import { PceMachine, BUTTON, LINE_MASTER } from './machinepce.js';

// ---- a tiny HuC6280 assembler, just enough for the fixtures ---------------
const flat = (...xs) => xs.flat(Infinity);
const lda = (v) => [0xa9, v & 0xff];
const ldx = (v) => [0xa2, v & 0xff];
const tam = (m) => [0x53, m & 0xff];
const sta = (a) => [0x8d, a & 0xff, (a >> 8) & 0xff];
const st0 = (v) => [0x03, v & 0xff];
const st1 = (v) => [0x13, v & 0xff];
const st2 = (v) => [0x23, v & 0xff];
const vdc = (reg, val) => [st0(reg), st1(val & 0xff), st2((val >> 8) & 0xff)];
const bra = (off) => [0x80, off & 0xff];

// Bring a machine up the way a HuCard does: hardware at $0000, work RAM at
// $2000 (so page zero and the stack exist), a stack pointer, a palette, one
// tile, one screenful of that tile, and the background switched on.
function bootProgram() {
  return flat(
    [0xd4],                       // CSH
    lda(0xff), tam(0x01),         // MPR0 = hardware page
    lda(0xf8), tam(0x02),         // MPR1 = work RAM (page zero + stack)
    ldx(0xff), [0x9a],            // TXS
    // VCE: entry 0 = black backdrop, entry 1 = white
    lda(0x00), sta(0x0402), sta(0x0403),
    lda(0x00), sta(0x0404), sta(0x0405),
    lda(0xff), sta(0x0404), lda(0x01), sta(0x0405),
    // One tile, at char $40 => VRAM word $0400. It has to live above the
    // background map, which is fixed at VRAM word 0 and is 32x32 entries here:
    // put the tile inside that and the map overwrites it.
    vdc(R_MAWR, 0x0400),
    st0(R_VXR),
    Array.from({ length: 8 }, () => [st1(0xff), st2(0x00)]),
    Array.from({ length: 8 }, () => [st1(0x00), st2(0x00)]),
    // the background map at VRAM 0: 32x32 entries of "char 1, palette 0"
    vdc(R_MAWR, 0x0000),
    st0(R_VXR),
    Array.from({ length: 64 }, () => [st1(0x40), st2(0x00)]),
    // geometry: 256 wide, 224 tall, and a frame that adds up
    vdc(0x0b, 0x041f),            // HDR
    vdc(0x0c, 0x0f02),            // VPR
    vdc(0x0d, 0x00df),            // VDW = 224 lines
    vdc(0x0e, 0x0004),            // VCR
    vdc(0x09, 0x0000),            // MWR: 32x32 map
    vdc(0x06, 0x0080),            // RCR = line 64
    vdc(R_CR, 0x008c),            // background on, vblank + raster interrupts
    [0x58],                       // CLI
    bra(-2),                      // spin
  );
}

function bootMachine(extra = {}) {
  // The interrupt vectors point at a lone RTI so that enabling interrupts does
  // not send the handler back through the initialisation code.
  const rom = buildPce({
    size: 0x8000, code: bootProgram(),
    vectors: { irq1: 0xfff0, irq2: 0xfff0, timer: 0xfff0, nmi: 0xfff0 },
  });
  rom[0x1ff0] = 0x40;                       // RTI
  return new PceMachine({ rom, ...extra });
}

// Approximate the memory a snapshot occupies: typed arrays by their real byte
// length, plain numbers by eight, strings by two per character. Good enough to
// answer "how many of these fit in the host's 150MB rewind budget".
function snapshotBytes(v, seen = new Set()) {
  if (v === null || v === undefined) return 0;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (typeof v === 'number') return 8;
  if (typeof v === 'boolean') return 4;
  if (typeof v === 'string') return v.length * 2;
  if (Array.isArray(v)) return v.reduce((s, x) => s + snapshotBytes(x, seen), 16);
  if (typeof v === 'object') {
    if (seen.has(v)) return 0;
    seen.add(v);
    let n = 16;
    for (const k of Object.keys(v)) n += k.length * 2 + snapshotBytes(v[k], seen);
    return n;
  }
  return 0;
}

// ---- pcerom ---------------------------------------------------------------

test('a headerless image parses and finds its reset vector', () => {
  const rom = buildPce({ size: 0x8000, code: [0xea], entry: 0x100, vectors: { reset: 0xe100 } });
  const cart = parsePce(rom);
  assert.equal(cart.size, 0x8000);
  assert.equal(cart.header, null);
  assert.equal(cart.resetVector, 0xe100);
  assert.deepEqual(cart.warnings, []);
});

test('a 512-byte copier header is stripped', () => {
  const rom = buildPce({ size: 0x8000, code: [0xea], header: true });
  const cart = parsePce(rom);
  assert.equal(cart.size, 0x8000);
  assert.equal(cart.header.length, 512);
  assert.equal(cart.resetVector, 0xe000);
});

test('a bit-reversed dump is detected and un-mirrored', () => {
  const good = buildPce({ size: 0x8000, code: [0xa9, 0x42] });
  const cart = parsePce(reverseBits(good));
  assert.equal(cart.bitReversed, true);
  assert.equal(cart.resetVector, 0xe000);
  assert.deepEqual(Array.from(cart.rom.subarray(0, 2)), [0xa9, 0x42]);
  // and a good dump is never "fixed"
  assert.equal(parsePce(good).bitReversed, false);
});

test('trailing junk is dropped and a short download is padded', () => {
  const good = buildPce({ size: 0x8000, code: [0xea] });
  const junked = new Uint8Array(good.length + 40);
  junked.set(good);
  junked.fill(0x5a, good.length);
  const a = parsePce(junked);
  assert.equal(a.size, 0x8000);
  assert.match(a.warnings.join(' '), /trailing bytes/);

  const short = good.subarray(0, good.length - 100);
  const b = parsePce(short);
  assert.equal(b.size, 0x8000);
  assert.match(b.warnings.join(' '), /short of a whole bank/);
});

test('a header hidden behind trailing junk is still found', () => {
  // The combination the real library is full of: a copier header AND junk on
  // the end, so the "size % 8192 == 512" test cannot see the header.
  const good = buildPce({ size: 0x8000, code: [0xea], header: true });
  const junked = new Uint8Array(good.length + 37);
  junked.set(good);
  const cart = parsePce(junked);
  assert.equal(cart.header.length, 512);
  assert.equal(cart.resetVector, 0xe000);
});

test('parsePce rejects what it cannot run, tryParsePce reports it', () => {
  assert.throws(() => parsePce(new Uint8Array(100)), /8192/);
  const r = tryParsePce(new Uint8Array(100));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too-small');
});

test('the bank map folds by 256KB, not to the start of the cartridge', () => {
  const m512 = buildBankMap(0x80000);
  assert.equal(m512[0x00], 0x00000);
  assert.equal(m512[0x3f], 0x7e000);
  assert.equal(m512[0x45], 0x4a000, 'bank $45 is 256KB below the flat address');
  const m384 = buildBankMap(0x60000);
  assert.equal(m384[0x2f], 0x5e000);
  assert.equal(m384[0x45], 0x4a000, 'the mapping Devil\'s Crush needs');
  for (let b = 0; b < 0x80; b++) assert.ok(m384[b] < 0x60000 && m384[b] >= 0, `bank ${b} in range`);
  const m1m = buildBankMap(0x100000);
  assert.equal(m1m[0x45], 0x8a000, 'a 1MB card is flat: nothing to fold');
});

test('Street Fighter II is recognised by size and gets a switched window', () => {
  const rom = new Uint8Array(0x280000);
  rom[0x1ffe] = 0x00; rom[0x1fff] = 0xe0;
  const cart = parsePce(rom);
  assert.equal(cart.mapper, MAPPER.SF2);
  assert.equal(cart.banks[0x00], 0x00000);
  assert.equal(cart.banks[0x40], 0x80000);
  assert.match(summarizePce(cart).board, /SF2/);
});

// ---- HuC6260 (VCE) --------------------------------------------------------

test('the palette auto-increments on the high byte only', () => {
  const vce = new HuC6260();
  vce.write(2, 0x00); vce.write(3, 0x00);
  vce.write(4, 0x34); vce.write(5, 0x01);
  vce.write(4, 0x78); vce.write(5, 0x00);
  assert.equal(vce.palette[0], 0x134);
  assert.equal(vce.palette[1], 0x078);
  assert.equal(vce.addr, 2);
});

test('the VCE control register picks the dot clock and the line count', () => {
  const vce = new HuC6260();
  vce.write(0, 0x00);
  assert.equal(vce.dotDivider, 4);
  assert.equal(vce.linesPerFrame, 262);
  vce.write(0, 0x05);
  assert.equal(vce.dotDivider, 3);
  assert.equal(vce.linesPerFrame, 263);
  vce.write(0, 0x02);
  assert.equal(vce.dotDivider, 2);
});

// ---- HuC6270 (VDC) --------------------------------------------------------

test('a VRAM write only happens when the high byte arrives', () => {
  const v = new HuC6270();
  v.write(0, R_MAWR); v.write(2, 0x10); v.write(3, 0x00);
  v.write(0, R_VXR);
  v.write(2, 0x34);
  assert.equal(v.vram[0x10], 0, 'the low byte is only latched');
  v.write(3, 0x12);
  assert.equal(v.vram[0x10], 0x1234);
  assert.equal(v.reg[R_MAWR], 0x11, 'and the pointer advanced');
});

test('the increment width comes from CR bits 11-12', () => {
  const v = new HuC6270();
  v.write(0, R_CR); v.write(2, 0x00); v.write(3, 0x08);   // IW = 1 -> +32
  assert.equal(v.increment, 32);
  v.write(0, R_MAWR); v.write(2, 0x00); v.write(3, 0x00);
  v.write(0, R_VXR); v.write(2, 0x01); v.write(3, 0x00);
  assert.equal(v.reg[R_MAWR], 32);
});

test('setting MARR prefetches, and reading the high byte advances', () => {
  const v = new HuC6270();
  v.vram[0x40] = 0xbeef; v.vram[0x41] = 0xcafe;
  v.write(0, R_MARR); v.write(2, 0x40); v.write(3, 0x00);
  assert.equal(v.read(2), 0xef);
  assert.equal(v.read(3), 0xbe);
  assert.equal(v.read(2), 0xfe, 'the next word was prefetched');
});

test('writing LENR runs the VRAM-to-VRAM copy and reports it', () => {
  const v = new HuC6270();
  for (let i = 0; i < 4; i++) v.vram[0x100 + i] = 0x1000 + i;
  v.write(0, R_SOUR); v.write(2, 0x00); v.write(3, 0x01);
  v.write(0, R_DESR); v.write(2, 0x00); v.write(3, 0x02);
  v.write(0, R_DCR); v.write(2, 0x02); v.write(3, 0x00);   // finish -> IRQ
  v.write(0, R_LENR); v.write(2, 0x03); v.write(3, 0x00);
  assert.deepEqual(Array.from(v.vram.subarray(0x200, 0x204)), [0x1000, 0x1001, 0x1002, 0x1003]);
  assert.equal(v.status & ST_VRAM_DMA, ST_VRAM_DMA);
  assert.equal(v.irq, true);
  assert.equal(v.read(0) & ST_VRAM_DMA, ST_VRAM_DMA);
  assert.equal(v.irq, false, 'reading the status is the acknowledge');
  assert.equal(v.status, 0);
});

test('an interrupt condition does not latch while its enable is clear', () => {
  const v = new HuC6270();
  // vblank enabled, raster not
  v.write(0, R_CR); v.write(2, 0x08); v.write(3, 0x00);
  v._raise(ST_RASTER, (v.reg[R_CR] & 0x04) !== 0);
  assert.equal(v.status & ST_RASTER, 0, 'this is what unhangs Soldier Blade');
  v._raise(ST_VBLANK, (v.reg[R_CR] & 0x08) !== 0);
  assert.equal(v.status & ST_VBLANK, ST_VBLANK);
});

test('the SATB DMA fills the private sprite table, not VRAM', () => {
  const v = new HuC6270();
  for (let i = 0; i < 256; i++) v.vram[0x800 + i] = i;
  v.write(0, R_SATB); v.write(2, 0x00); v.write(3, 0x08);
  assert.equal(v.sat[0], 0, 'nothing happens until the DMA runs');
  v._satbDma();
  assert.deepEqual(Array.from(v.sat.subarray(0, 4)), [0, 1, 2, 3]);
});

test('the background renders palette indices, and colour 0 is transparent', () => {
  const v = new HuC6270();
  // char 1: plane 0 solid on every row
  for (let r = 0; r < 8; r++) v.vram[0x10 + r] = 0x00ff;
  v.vram[0] = 0x1001;                                     // palette 1, char 1
  v.vram[1] = 0x0000;                                     // char 0 = all zeroes
  v.write(0, R_CR); v.write(2, 0x80); v.write(3, 0x00);   // background on
  v.displayY = 0; v.bgY = 0;
  const line = v.renderLine(16);
  assert.equal(line[0], 0x11, 'palette 1, colour 1');
  assert.equal(line[7], 0x11);
  assert.equal(line[8], 0, 'the next tile is transparent -> backdrop');
});

test('a sprite draws in front of a transparent background', () => {
  const v = new HuC6270();
  // sprite pattern 1 => VRAM word 64; plane 0 solid on row 0
  v.vram[64] = 0xffff;
  v.sat[0] = 64 + 0;        // y = 0
  v.sat[1] = 32 + 8;        // x = 8
  v.sat[2] = 1 << 1;        // pattern 1
  v.sat[3] = 0x0002;        // palette 2, 16x16, behind background
  v.write(0, R_CR); v.write(2, 0x40); v.write(3, 0x00);   // sprites on
  v.displayY = 0;
  const line = v.renderLine(32);
  assert.equal(line[7], 0);
  assert.equal(line[8], 256 + 0x21, 'sprite palette 2, colour 1');
  assert.equal(line[23], 256 + 0x21);
  assert.equal(line[24], 0);
});

// ---- PSG ------------------------------------------------------------------

test('the PSG plays its wave RAM at the programmed rate', () => {
  const psg = new PcePsg({ sampleRate: 48000 });
  psg.write(0, 0);                       // channel 0
  psg.write(4, 0x00);                    // off: resets the write pointer
  for (let i = 0; i < 32; i++) psg.write(6, i < 16 ? 31 : 0);
  psg.write(2, 0x40); psg.write(3, 0x00); // period 64
  psg.write(5, 0xff);                    // full balance
  psg.write(1, 0xff);                    // full main volume
  psg.write(4, 0x9f);                    // on, full level
  const out = new Float32Array(256);
  psg.run(6 * 64 * 40);
  psg.render(out, 64);
  let energy = 0;
  for (let i = 0; i < 64; i++) energy += Math.abs(out[i]);
  assert.ok(energy > 0, 'the channel produced something');
});

test('a silent PSG produces silence, and DDA writes the DAC directly', () => {
  const psg = new PcePsg({ sampleRate: 48000 });
  psg.run(6 * 4000);
  const out = new Float32Array(64);
  psg.render(out, 64);
  assert.ok(out.every((v) => v === 0));
  psg.write(0, 0);
  psg.write(4, 0xdf);                    // on + DDA + full level
  psg.write(6, 31);
  assert.equal(psg.ch[0].out, 31);
});

test('the PSG state round-trips and the sample stream repeats', () => {
  const mk = () => {
    const p = new PcePsg({ sampleRate: 48000 });
    p.write(0, 0); p.write(4, 0x00);
    for (let i = 0; i < 32; i++) p.write(6, (i * 3) & 31);
    p.write(2, 0x20); p.write(3, 0x01); p.write(5, 0xff); p.write(1, 0xff); p.write(4, 0x9f);
    return p;
  };
  const a = mk(); a.run(6 * 5000);
  // The sample ring is output, not state (see pcepsg.getState), so drain what
  // the first run produced before snapshotting: the restored copy starts with
  // an empty ring and the two streams have to line up from the same point.
  a.render(new Float32Array(4096), 4096);
  const s = JSON.parse(JSON.stringify(a.getState()));
  const outA = new Float32Array(200); a.run(6 * 20000); a.render(outA, 200);
  const b = mk(); b.setState(s);
  const outB = new Float32Array(200); b.run(6 * 20000); b.render(outB, 200);
  assert.deepEqual(Array.from(outB), Array.from(outA));
});

// ---- the machine contract -------------------------------------------------

test('the machine satisfies the host contract', () => {
  const m = bootMachine();
  assert.equal(typeof m.stepFrame, 'function');
  assert.equal(typeof m.snapshot, 'function');
  assert.equal(typeof m.restore, 'function');
  assert.equal(typeof m.render, 'function');
  assert.equal(typeof m.renderAudio, 'function');
  assert.equal(typeof m.update, 'function');
  assert.equal(m.frame, 0);
  assert.equal(m.schemaVersion, 1);
  m.stepFrame();
  assert.equal(m.frame, 1);
  assert.ok(m.frameHz > 59 && m.frameHz < 61, `frameHz ${m.frameHz}`);
});

test('a frame is 263 scanlines of 1365 master clocks', () => {
  const m = bootMachine();
  const before = m.mclk;
  m.stepFrame();
  const spent = m.mclk - before;
  // stepFrame stops on the first line boundary past the end, so the frame is
  // one line's worth of slop at most.
  assert.ok(Math.abs(spent - LINE_MASTER * 263) < LINE_MASTER * 2, `spent ${spent}`);
});

test('the boot program draws a picture', () => {
  const m = bootMachine();
  for (let i = 0; i < 8; i++) m.stepFrame();
  const f = m.render();
  assert.equal(f.width, 256);
  assert.equal(f.height, 224);
  // white tile everywhere: the top-left pixel is the palette entry we wrote
  assert.equal(f.rgb[0], 255);
  assert.equal(f.rgb[1], 255);
  assert.equal(f.rgb[2], 255);
  const idx = m.render({ indexed: true, analog: true });
  assert.equal(idx.pixels.length, 256 * 224);
  assert.equal(idx.drive.length, 256 * 224 * 3);
  assert.equal(idx.pixels[0], 7, 'all three guns lit');
});

test('the vblank and raster interrupts both reach the CPU', () => {
  const m = bootMachine();
  let vbl = 0, ras = 0;
  const orig = m.vdc._raise.bind(m.vdc);
  m.vdc._raise = (bit, en) => { if (en && bit === ST_VBLANK) vbl++; if (en && bit === ST_RASTER) ras++; orig(bit, en); };
  m.stepFrame(); m.stepFrame();
  assert.ok(vbl >= 2, `vblank fired ${vbl} times`);
  assert.ok(ras >= 2, `raster fired ${ras} times`);
});

test('the joypad presents two nibbles behind SEL, active low', () => {
  const m = bootMachine();
  m.setPad((1 << BUTTON.RUN) | (1 << BUTTON.LEFT));
  m._padWrite(0x01);                     // SEL = 1 -> directions
  assert.equal(m._padRead() & 0x0f, 0x07, 'LEFT is bit 3, pressed = 0');
  m._padWrite(0x00);                     // SEL = 0 -> buttons
  assert.equal(m._padRead() & 0x0f, 0x07, 'RUN is bit 3, pressed = 0');
  m._padWrite(0x02);                     // CLR
  assert.equal(m._padRead() & 0x0f, 0x0f, 'the multiplexer is blanked');
});

test('snapshot/restore is an exact inverse, even across interrupts', () => {
  const m = bootMachine();
  for (let i = 0; i < 5; i++) m.stepFrame();
  const snap = m.snapshot();
  const marks = [];
  for (let i = 0; i < 12; i++) { m.stepFrame(); marks.push(fingerprint(m)); }
  m.restore(snap);
  for (let i = 0; i < 12; i++) {
    m.stepFrame();
    assert.equal(fingerprint(m), marks[i], `frame ${i} after a restore diverged`);
  }
});

test('a rewind that lands mid-instruction still replays identically', () => {
  // Take a snapshot at an arbitrary CPU cycle rather than a frame boundary:
  // the host's ring only ever snapshots between frames, but a machine whose
  // state is incomplete usually shows it here first.
  const m = bootMachine();
  for (let i = 0; i < 4; i++) m.stepFrame();
  for (let i = 0; i < 977; i++) m.cpu.step();
  const snap = m.snapshot();
  const a = [];
  for (let i = 0; i < 5000; i++) { m.cpu.step(); a.push(m.cpu.pc); }
  m.restore(snap);
  for (let i = 0; i < 5000; i++) { m.cpu.step(); assert.equal(m.cpu.pc, a[i], `step ${i}`); }
});

test('the same ROM run twice is identical (determinism)', () => {
  const run = () => {
    const m = bootMachine();
    for (let i = 0; i < 20; i++) {
      m.setPad(i & 1 ? (1 << BUTTON.I) : 0);
      m.stepFrame();
    }
    return fingerprint(m);
  };
  assert.equal(run(), run());
});

test('the host transport loop works: update(dt), a ring, fast-forward, rewind', () => {
  // A headless copy of what demo/machine.html does, so a machine that breaks
  // the host's time travel fails here instead of in a browser.
  const m = bootMachine();
  const ring = [];
  const dt = 1 / 60;
  for (let i = 0; i < 40; i++) {
    m.update(dt);
    ring.push({ frame: m.frame, snap: m.snapshot() });
  }
  const target = ring[10];
  const expect = [];
  m.restore(target.snap);
  for (let i = 0; i < 6; i++) { m.stepFrame(); expect.push(fingerprint(m)); }
  // fast-forward x4 from the same point, then rewind and replay
  m.restore(target.snap);
  m.update(dt * 4);
  m.restore(target.snap);
  for (let i = 0; i < 6; i++) { m.stepFrame(); assert.equal(fingerprint(m), expect[i]); }
});

test('the snapshot holds no cartridge and is small enough for the ring', () => {
  const m = bootMachine();
  for (let i = 0; i < 30; i++) m.stepFrame();
  const s = m.snapshot();
  const bytes = snapshotBytes(s);
  // VRAM (64KB) + work RAM (8KB) + save RAM (2KB) + the palette dominate.
  assert.ok(bytes > 60000, `expected the VDC's VRAM to be in there, got ${bytes}`);
  assert.ok(bytes < 200000, `snapshot is ${bytes} bytes; docs/pce-design.md quotes ~80KB`);
  const json = JSON.stringify(s);
  assert.ok(!json.includes('"rom"'), 'the cartridge must not be in the snapshot');
  // And restoring into a fresh machine built from the same cartridge works.
  // Both are stepped one frame afterwards because the framebuffer is OUTPUT and
  // deliberately not in the snapshot: the restored machine has to redraw it,
  // and that it redraws the same picture is the actual claim.
  const other = bootMachine();
  other.restore(s);
  m.restore(s);
  other.stepFrame(); m.stepFrame();
  assert.equal(fingerprint(other), fingerprint(m));
});

test('Street Fighter II\'s bank register switches the upper window', () => {
  const rom = new Uint8Array(0x280000);
  rom[0x1ffe] = 0x00; rom[0x1fff] = 0xe0;
  // a recognisable byte at the start of each of the four switchable chunks
  for (let i = 0; i < 4; i++) rom[0x80000 + i * 0x80000] = 0xa0 + i;
  const m = new PceMachine({ rom });
  m.cpu.mpr[2] = 0x40;                    // $4000-$5FFF -> bank $40
  assert.equal(m._read(0x4000), 0xa0);
  m._write(0x1ff2, 0);                    // MPR0 is bank 0 -> ROM space
  assert.equal(m.sf2Bank, 2);
  assert.equal(m._read(0x4000), 0xa2);
  const s = m.snapshot();
  m._write(0x1ff0, 0);
  m.restore(s);
  assert.equal(m.sf2Bank, 2, 'the mapper state survives a rewind');
  assert.equal(m._read(0x4000), 0xa2);
});

test('a jammed or silent ROM does not hang stepFrame', () => {
  // No initialisation at all: the VDC is never programmed, so nothing forces a
  // line boundary except the machine's own clock.
  const rom = buildPce({ size: 0x8000, code: [0x80, 0xfe] });   // BRA *
  const m = new PceMachine({ rom });
  for (let i = 0; i < 3; i++) m.stepFrame();
  assert.equal(m.frame, 3);
});

// A cheap whole-machine fingerprint: registers, a sample of every memory the
// machine owns, and the picture.
function fingerprint(m) {
  let h = 2166136261;
  const mix = (v) => { h = ((h ^ (v & 0xff)) * 16777619) >>> 0; };
  const c = m.cpu;
  for (const v of [c.a, c.x, c.y, c.s, c.p, c.pc & 0xff, c.pc >> 8, c.cycles & 0xff, c.irqStatus, c.irqMask]) mix(v);
  for (let i = 0; i < 8; i++) mix(c.mpr[i]);
  for (let i = 0; i < m.wram.length; i += 13) mix(m.wram[i]);
  for (let i = 0; i < m.vdc.vram.length; i += 37) { mix(m.vdc.vram[i]); mix(m.vdc.vram[i] >> 8); }
  for (let i = 0; i < 512; i += 3) { mix(m.vce.palette[i]); mix(m.vce.palette[i] >> 8); }
  for (let i = 0; i < 0x14; i++) { mix(m.vdc.reg[i]); mix(m.vdc.reg[i] >> 8); }
  mix(m.vdc.status); mix(m.line); mix(m.frame);
  for (let i = 0; i < MAX_WIDTH * 100; i += 53) { mix(m.frameBuf[i]); mix(m.frameBuf[i] >> 8); }
  return h;
}
