import test from 'node:test';
import assert from 'node:assert/strict';
import { Upd3301, STATUS, expandAttrRow, SCHEMA_VERSION } from './index.js';
import { Upd8257 } from './upd8257.js';
import {
  Pc8001TextSystem, PC8001, decodeAttrPair, expandRowStates, renderScreen,
} from './pc8001.js';
import { CrtPhosphor, PHOSPHORS, indexToRgb } from './crt.js';

function resetTo(crtc, { cols = 80, rows = 25, lines = 8, attrs = 20 } = {}) {
  crtc.writeCommand(0x00);
  crtc.writeParam(0x80 | (cols - 2));
  crtc.writeParam(0x40 | (rows - 1));
  crtc.writeParam(0x00 | (lines - 1));
  crtc.writeParam(((7 - 1) << 5) | (14 - 2));
  crtc.writeParam(attrs - 1);
}

test('RESET parameters decode into screen geometry', () => {
  const crtc = new Upd3301();
  resetTo(crtc, { cols: 80, rows: 25, lines: 8, attrs: 20 });
  assert.equal(crtc.cols, 80);
  assert.equal(crtc.rows, 25);
  assert.equal(crtc.linesPerChar, 8);
  assert.equal(crtc.attrsPerRow, 20);
  assert.equal(crtc.vblankRows, 7);
  assert.equal(crtc.hblankChars, 14);
  assert.equal(crtc.blinkPeriod, 32);
  assert.equal(crtc.dmaBurstMode, 1);
  assert.equal(crtc.getScreen().schemaVersion, SCHEMA_VERSION);
});

test('attribute mode 1 disables attribute fetch', () => {
  const crtc = new Upd3301();
  crtc.writeCommand(0x00);
  for (const p of [78, 24, 7, 0xcc, (1 << 5) | 19]) crtc.writeParam(p);
  assert.equal(crtc.attrsPerRow, 0);
});

test('per-row DMA fetches cols + 2*attrs bytes and fills cells', () => {
  const calls = [];
  const crtc = new Upd3301({
    drq: (buf) => {
      calls.push(buf.length);
      buf.fill(0x41); // 'A'
      buf[80] = 0; buf[81] = 0xe8;
      return buf.length;
    },
  });
  resetTo(crtc);
  crtc.writeCommand(0x20); // START DISPLAY
  crtc.stepFrame();
  assert.equal(calls.length, 25);
  assert.ok(calls.every((n) => n === 120));
  assert.equal(crtc.cells[0], 0x41);
  assert.equal(crtc.cells[24 * 80 + 79], 0x41);
  assert.equal((crtc.readStatus() & STATUS.U), 0);
});

test('DMA underrun sets the U status bit and drops bit 7', () => {
  const crtc = new Upd3301({ drq: (buf) => 10 });
  resetTo(crtc);
  crtc.writeCommand(0x20);
  crtc.stepFrame();
  const s = crtc.readStatus();
  assert.ok(s & STATUS.U);
  assert.equal(s & 0x80, 0);
  // cleared after read
  assert.equal(crtc.readStatus() & STATUS.U, 0);
});

test('chip-level attribute expansion follows fill-forward rules', () => {
  const out = new Uint8Array(10);
  // pairs: (3, 0xAA), (6, 0xBB) — first back-fills to 0, last extends to end
  expandAttrRow(Uint8Array.from([3, 0xaa, 6, 0xbb, 0, 0]), 3, 10, out);
  assert.deepEqual([...out], [0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xbb, 0xbb, 0xbb, 0xbb]);
});

test('VRTC interrupt: masked by default state, fires when unmasked', () => {
  let irqs = 0;
  const crtc = new Upd3301({ drq: (b) => (b.fill(0), b.length), onIrq: () => irqs++ });
  resetTo(crtc);
  crtc.writeCommand(0x20);
  crtc.stepFrame();
  assert.equal(irqs, 0); // interruptMask starts fully masked
  crtc.writeCommand(0x40); // SET INTERRUPT MASK, ME=0 → unmasked
  crtc.stepFrame();
  assert.equal(irqs, 1);
  assert.ok(crtc.readStatus() & STATUS.E);
  assert.equal(crtc.readStatus() & STATUS.E, 0); // cleared by read
  crtc.writeCommand(0xa0); // RESET INTERRUPT drops the line
  assert.equal(crtc.irqLine, false);
});

test('cursor position, style and deterministic blink', () => {
  const crtc = new Upd3301({ drq: (b) => (b.fill(0), b.length) });
  resetTo(crtc);
  crtc.writeCommand(0x81); // LOAD CURSOR POSITION, enabled
  crtc.writeParam(12);
  crtc.writeParam(5);
  crtc.writeCommand(0x20);
  const phases = [];
  for (let i = 0; i < 64; i++) { crtc.stepFrame(); phases.push(crtc.cursorBlinkOn()); }
  const crtc2 = new Upd3301({ drq: (b) => (b.fill(0), b.length) });
  resetTo(crtc2);
  crtc2.writeCommand(0x81);
  crtc2.writeParam(12);
  crtc2.writeParam(5);
  crtc2.writeCommand(0x20);
  const phases2 = [];
  for (let i = 0; i < 64; i++) { crtc2.stepFrame(); phases2.push(crtc2.cursorBlinkOn()); }
  assert.deepEqual(phases, phases2);
  assert.ok(phases.includes(true) && phases.includes(false));
  const sc = crtc.getScreen();
  assert.equal(sc.cursor.x, 12);
  assert.equal(sc.cursor.y, 5);
  assert.equal(sc.cursor.block, false);
});

test('update(dt) is fixed-step and frame-exact', () => {
  const crtc = new Upd3301({ drq: (b) => (b.fill(0), b.length) });
  resetTo(crtc);
  crtc.writeCommand(0x20);
  for (let i = 0; i < 10; i++) crtc.update(1 / 60);
  assert.equal(crtc.frame, 10);
  crtc.update(0.5); // 30 more frames
  assert.equal(crtc.frame, 40);
});

test('μPD8257: 16-bit flip-flop writes and read-mode counting', () => {
  const mem = new Uint8Array(0x10000);
  mem[0x1234] = 0x99;
  const dmac = new Upd8257({ readMemory: (a) => mem[a] });
  dmac.writePort(8, 0x04); // enable ch2
  dmac.writePort(4, 0x34); dmac.writePort(4, 0x12); // ch2 addr = 0x1234
  dmac.writePort(5, 0x0f); dmac.writePort(5, 0x80); // read mode, count 16
  const buf = new Uint8Array(4);
  assert.equal(dmac.drqPull(2, buf), 4);
  assert.equal(buf[0], 0x99);
  assert.equal(dmac.channels[2].addr, 0x1238);
});

test('μPD8257 autoload: ch2 wraps to ch3 base at terminal count', () => {
  const mem = new Uint8Array(0x10000);
  for (let i = 0; i < 32; i++) mem[0x100 + i] = i;
  const dmac = new Upd8257({ readMemory: (a) => mem[a] });
  dmac.writePort(8, 0x84); // autoload + ch2
  dmac.writePort(4, 0x00); dmac.writePort(4, 0x01); // addr 0x100
  dmac.writePort(5, 0x07); dmac.writePort(5, 0x80); // read, 8 bytes
  const buf = new Uint8Array(8);
  dmac.drqPull(2, buf);
  assert.deepEqual([...buf], [0, 1, 2, 3, 4, 5, 6, 7]);
  dmac.drqPull(2, buf); // reloaded from ch3 → same 8 bytes again
  assert.deepEqual([...buf], [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('PC-8001 attribute pair decoding (color vs function spec)', () => {
  const c = decodeAttrPair(0xe8);
  assert.equal(c.kind, 'color');
  assert.equal(c.color, 7);
  assert.equal(c.semigraphic, false);
  const g = decodeAttrPair(0x58); // 010_1_1000: blue + semigraphic
  assert.equal(g.color, 2 /* red? no: bits7-5=010 → G=0 R=1 B=0 → 2 */);
  assert.equal(g.semigraphic, true);
  const f = decodeAttrPair(0x07);
  assert.equal(f.kind, 'function');
  assert.ok(f.reverse && f.blink && f.secret);
});

test('dual-state expansion: color change keeps function state', () => {
  const colorOut = new Uint8Array(10);
  const funcOut = new Uint8Array(10);
  // (0, reverse-on) then (5, red)
  expandRowStates(Uint8Array.from([0, 0x04, 5, 0x48, 0, 0]), 3, 10, colorOut, funcOut);
  assert.equal(funcOut[0], 0x04);
  assert.equal(funcOut[9], 0x04); // reverse survives the color change
  assert.equal(colorOut[0], 0xe8); // default white before the color pair
  assert.equal(colorOut[5], 0x48); // red from column 5
});

test('full system boots like N-BASIC and renders deterministically', () => {
  const run = () => {
    const sys = new Pc8001TextSystem();
    sys.initTextMode();
    sys.line(0).text(0, 'HELLO 3301').attrs(0, 0xe8);
    sys.line(1).text(0, 'BEER').attrs(0, 0xc8, 2, 0x28); // yellow → blue
    sys.line(2).code(0, 0b00001111).attrs(0, 0x98); // semigraphic, green
    const cgrom = new Uint8Array(256 * 16).fill(0xff);
    sys.update(1 / 60);
    return sys.render({ cgrom });
  };
  const a = run();
  const b = run();
  assert.equal(a.width, 640);
  assert.equal(a.height, 200);
  assert.deepEqual(a.pixels, b.pixels);
  // 'H' cell painted white (7), 'BEER' starts yellow (6) then blue (1) at col 2
  assert.equal(a.pixels[0], 7);
  assert.equal(a.pixels[8 * 640 + 0], 6);
  assert.equal(a.pixels[8 * 640 + 2 * 8], 1);
  // semigraphic 0x0f: left column lit for all 8 lines, right column dark
  assert.equal(a.pixels[16 * 640 + 0], 4);
  assert.equal(a.pixels[16 * 640 + 7], 0);
});

test('27-color trick: doubled DMA count alternates two screens', () => {
  const sys = new Pc8001TextSystem();
  sys.initTextMode();
  // reprogram ch2 count to two frames' worth (the BASIC magazine trick:
  // port 65h gets 8000h + 5999 instead of 8000h + 2999)
  const tc = 0x8000 | (6000 - 1);
  sys.out(0x64, PC8001.TEXT_VRAM & 0xff);
  sys.out(0x64, PC8001.TEXT_VRAM >> 8);
  sys.out(0x65, tc & 0xff);
  sys.out(0x65, tc >> 8);
  // screen A says 'A', screen B (3000 bytes later) says 'B'
  sys.memory[PC8001.TEXT_VRAM] = 0x41;
  sys.memory[PC8001.TEXT_VRAM + 3000] = 0x42;
  sys.update(1 / 60);
  const f1 = sys.crtc.cells[0];
  sys.update(1 / 60);
  const f2 = sys.crtc.cells[0];
  sys.update(1 / 60);
  const f3 = sys.crtc.cells[0];
  assert.equal(f1, 0x41);
  assert.equal(f2, 0x42);
  assert.equal(f3, 0x41); // autoload wrapped back to screen A
});

test('40-column mode: even cells shown 2x wide, same pixel width', () => {
  // Real 40-col (as N-BASIC boots it): an 80-char CRTC row with port 30h d0=0.
  // The μPD3301 halves the character clock → shows cols/2 = 40 characters at
  // double width, taken from the EVEN cells (N-BASIC writes chars to even bytes,
  // odd bytes skipped). 640px wide — same screen as 80-col, not a 1280px stretch.
  const sys = new Pc8001TextSystem();
  sys.initTextMode({ cols: 80 });
  sys.out(0x30, 0); // 40-column character clock (d0=0), colour mode
  sys.line(0).text(0, 'W').attrs(0, 0xe8); // 'W' at even cell 0 → display col 0
  const cgrom = new Uint8Array(256 * 16);
  cgrom['W'.charCodeAt(0) * 16] = 0x80; // single leftmost dot on line 0
  sys.update(1 / 60);
  const img = sys.render({ cgrom });
  assert.equal(img.width, 640); // 40 display cols × 8 × 2
  assert.equal(img.pixels[0], 7);
  assert.equal(img.pixels[1], 7); // doubled
  assert.equal(img.pixels[2], 0);
});

test('reverse display (START DISPLAY bit 0) inverts every cell', () => {
  const sys = new Pc8001TextSystem();
  sys.initTextMode();
  sys.line(0).attrs(0, 0xe8);
  sys.out(0x51, 0x21); // restart display with RVV=1
  const cgrom = new Uint8Array(256 * 16); // all-zero glyphs
  sys.update(1 / 60);
  const img = sys.render({ cgrom });
  assert.equal(img.pixels[0], 7); // empty glyph renders lit under reverse
});

// ---- physical layer: CRT phosphor -------------------------------------

test('phosphor decays exponentially and is deterministic', () => {
  const run = () => {
    const crt = new CrtPhosphor({ width: 2, height: 1, tau: [0.05, 0.05, 0.05] });
    const lit = Uint8Array.from([7, 0]); // white pixel, dark pixel
    const dark = Uint8Array.from([0, 0]);
    crt.step(lit, 1 / 60);
    const s0 = crt.sample(0, 0);
    crt.step(dark, 1 / 60);
    crt.step(dark, 1 / 60);
    return { s0, s2: crt.sample(0, 0), dark: crt.sample(1, 0) };
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
  assert.equal(a.s0.r, 1);
  const expected = Math.exp(-(2 / 60) / 0.05);
  assert.ok(Math.abs(a.s2.r - expected) < 1e-6);
  assert.equal(a.dark.r, 0);
});

test('1/3 duty cycle: long persistence bridges dark frames, short flickers', () => {
  const measure = (tau) => {
    const crt = new CrtPhosphor({ width: 1, height: 1, tau: [tau, tau, tau] });
    const on = Uint8Array.from([2]); // red
    const off = Uint8Array.from([0]);
    let min = Infinity, max = 0;
    for (let i = 0; i < 30; i++) { // 30 plane cycles of on,off,off
      for (const px of [on, off, off]) {
        crt.step(px, 1 / 60);
        if (i >= 5) { // after warm-up, sample every beam pass
          min = Math.min(min, crt.sample(0, 0).r);
          max = Math.max(max, crt.sample(0, 0).r);
        }
      }
    }
    return (max - min) / max; // modulation depth: 1 = hard flicker, 0 = steady
  };
  const short = measure(PHOSPHORS.P22.tau[0]);
  const long = measure(PHOSPHORS.LONG.tau[0]);
  assert.ok(short > 0.99, `short persistence should flicker hard (${short})`);
  assert.ok(long < 0.4, `long persistence should look steady (${long})`);
});

test('indexToRgb maps the GRB palette indexes', () => {
  assert.deepEqual(indexToRgb(0), [0, 0, 0]);
  assert.deepEqual(indexToRgb(1), [0, 0, 1]); // blue
  assert.deepEqual(indexToRgb(2), [1, 0, 0]); // red
  assert.deepEqual(indexToRgb(4), [0, 1, 0]); // green
  assert.deepEqual(indexToRgb(7), [1, 1, 1]);
});

test('3-plane mode: DMA count of three screens cycles R,G,B planes', () => {
  const sys = new Pc8001TextSystem();
  sys.initTextMode();
  const BASE = 0xb000, PLANE = 3000;
  sys.out(0x64, BASE & 0xff); sys.out(0x64, BASE >> 8);
  const tc = 0x8000 | (3 * PLANE - 1);
  sys.out(0x65, tc & 0xff); sys.out(0x65, tc >> 8);
  for (let p = 0; p < 3; p++) sys.memory[BASE + p * PLANE] = 0x30 + p; // '0','1','2'
  const seen = [];
  for (let i = 0; i < 4; i++) { sys.update(1 / 60); seen.push(sys.crtc.cells[0]); }
  assert.deepEqual(seen, [0x30, 0x31, 0x32, 0x30]);
});

test('RGB planes flicker-mix into per-dot color through long phosphor', () => {
  const sys = new Pc8001TextSystem();
  sys.initTextMode();
  const BASE = 0xb000, PLANE = 3000;
  sys.out(0x64, BASE & 0xff); sys.out(0x64, BASE >> 8);
  const tc = 0x8000 | (3 * PLANE - 1);
  sys.out(0x65, tc & 0xff); sys.out(0x65, tc >> 8);
  // one semigraphic cell at (0,0): full block in the red and green planes,
  // empty in the blue plane → the dot should read as (dim) yellow
  const colors = [2, 4, 1]; // red, green, blue plane colors
  for (let p = 0; p < 3; p++) {
    const base = BASE + p * PLANE;
    sys.memory[base] = p < 2 ? 0xff : 0x00;
    sys.memory[base + 80] = 0; // attr pair position 0
    sys.memory[base + 81] = (colors[p] << 5) | 0x10 | 0x08; // semigraphic color
  }
  const long = new CrtPhosphor({ width: 640, height: 200, tau: PHOSPHORS.LONG.tau });
  const short = new CrtPhosphor({ width: 640, height: 200, tau: PHOSPHORS.P22.tau });
  const cgrom = new Uint8Array(256 * 16);
  let px;
  for (let i = 0; i < 6; i++) {
    sys.update(1 / 60);
    px = sys.render({ cgrom }).pixels;
    long.step(px, 1 / 60);
    short.step(px, 1 / 60);
  }
  // frame order: R,G,B,R,G,B → last shown plane is blue (empty for this dot)
  const l = long.sample(0, 0);
  assert.ok(l.r > 0.3 && l.g > 0.3, `long: dot holds red+green glow (${l.r},${l.g})`);
  assert.ok(l.b < 0.01, 'long: blue plane is empty at this dot');
  const s = short.sample(0, 0);
  assert.ok(s.r < 0.01 && s.g < 0.01, 'short: glow gone two frames later — flicker');
});

// ---- physical layer: the tube ------------------------------------------

test('hsyncHz derives the 15.36 kHz whine from CRTC geometry', () => {
  const sys = new Pc8001TextSystem();
  sys.initTextMode();
  assert.equal(sys.crtc.hsyncHz(), 15360);
});

test('interlace: only the driven field is excited, the other decays', () => {
  const crt = new CrtPhosphor({ width: 2, height: 2, tau: [0.001, 0.001, 0.001] });
  const all = Uint8Array.from([7, 7, 7, 7]);
  crt.step(all, 1 / 60, { fieldParity: 0 });
  assert.equal(crt.sample(0, 0).r, 1); // even line excited
  assert.ok(crt.sample(0, 1).r < 1e-4); // odd line only decayed (was 0)
  crt.step(all, 1 / 60, { fieldParity: 1 });
  assert.equal(crt.sample(0, 1).r, 1); // odd field's turn
  assert.ok(crt.sample(0, 0).r < 0.01, 'short phosphor: even line faded between fields');
});

test('tube is deterministic and centers map ~identity', async () => {
  const { CrtTube } = await import('./tube.js');
  const mk = () => {
    const tube = new CrtTube({ srcWidth: 64, srcHeight: 32, outWidth: 64, outHeight: 64, mask: 'none', ghost: 0, barrel: 0.05, beamWidth: 0, edgeDefocus: 0, convergence: 0, scanlineDepth: 0 });
    const lum = [new Float32Array(64 * 32), new Float32Array(64 * 32), new Float32Array(64 * 32)];
    lum[0][16 * 64 + 32] = 1; // single red dot at center
    return tube.apply(lum);
  };
  const a = mk(), b = mk();
  assert.deepEqual(a, b);
  // center output pixel (32, 32) shows the dot
  const c = (32 * 64 + 32) * 4;
  assert.ok(a[c] > 200, `center red ${a[c]}`);
  assert.equal(a[c + 1], 0);
});

test('aperture grille passes each gun mainly through its own stripe', async () => {
  const { CrtTube } = await import('./tube.js');
  const W = 60, H = 12;
  const tube = new CrtTube({
    srcWidth: W, srcHeight: H, outWidth: W, outHeight: H,
    mask: 'aperture', maskPitch: 3, maskLeak: 0.1,
    barrel: 0, ghost: 0, vignette: 0, beamWidth: 0, edgeDefocus: 0, convergence: 0, scanlineDepth: 0,
  });
  const flat = new Float32Array(W * H).fill(0.5); // uniform white field
  const rgba = tube.apply([flat, flat, flat], null, { gamma: 1 });
  // along one row, each channel must peak on its own phase and dip elsewhere
  const row = 6;
  const r = [], g = [];
  for (let x = 0; x < 6; x++) {
    r.push(rgba[(row * W + x) * 4]);
    g.push(rgba[(row * W + x) * 4 + 1]);
  }
  const rPeak = Math.max(...r), rDip = Math.min(...r);
  assert.ok(rPeak > rDip * 3, `stripe contrast r: ${r.join(',')}`);
  // red and green peaks must not be on the same column
  assert.notEqual(r.indexOf(rPeak) % 3, g.indexOf(Math.max(...g)) % 3);
});

test('beam spot blur bleeds a hard edge (the nijimi)', async () => {
  const { CrtTube } = await import('./tube.js');
  const W = 32, H = 8;
  const mk = (beamWidth) => new CrtTube({
    srcWidth: W, srcHeight: H, outWidth: W, outHeight: H,
    mask: 'none', barrel: 0, ghost: 0, vignette: 0, beamWidth, edgeDefocus: 0, convergence: 0, scanlineDepth: 0,
  });
  const lum = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 16; x < W; x++) lum[y * W + x] = 1;
  const sharp = mk(0).apply([lum, lum, lum], null, { gamma: 1 });
  const soft = mk(1).apply([lum, lum, lum], null, { gamma: 1 });
  const at = (img, x) => img[(4 * W + x) * 4];
  assert.equal(at(sharp, 14), 0); // no bleed without beam width
  assert.ok(at(soft, 14) > 10, `bleed to the left of the edge: ${at(soft, 14)}`);
  assert.ok(at(soft, 17) < 255, 'edge softened on the bright side too');
});

// ---- phosphor character ------------------------------------------------

test('P22: blue dies first — a white flash decays through orange', () => {
  const crt = new CrtPhosphor({ width: 1, height: 1, phosphor: PHOSPHORS.P22 });
  crt.step(Uint8Array.from([7]), 1 / 60); // white flash
  const dark = Uint8Array.from([0]);
  for (let i = 0; i < 4; i++) crt.step(dark, 1 / 60);
  const s = crt.sample(0, 0);
  // P22's tail is deliberately short (see PHOSPHORS.P22 note): 4 frames after a
  // white flash the fast component is gone and only the warm tail remains. The
  // physics that matters here is the ORDER — blue dies first, red lingers — not
  // an absolute glow floor tuned to the old (too-long) tail.
  assert.ok(s.r > s.g && s.g > s.b, `afterglow orders r>g>b (${s.r}, ${s.g}, ${s.b})`);
  assert.ok(s.r > s.b * 10, `red lingers long after blue has died (${s.r} vs ${s.b})`);
  assert.ok(s.r > 5e-4, `a faint red tail still glows (${s.r})`);
});

test('P39 mono: whatever the guns drive, the light is green', () => {
  const crt = new CrtPhosphor({ width: 2, height: 1, phosphor: PHOSPHORS.P39 });
  crt.step(Uint8Array.from([2, 1]), 1 / 60); // "red" dot and "blue" dot
  const [R, G, B] = crt.composite();
  for (const i of [0, 1]) {
    assert.ok(G[i] > R[i] * 2 && G[i] > B[i] * 3, `pixel ${i} is green (${R[i]}, ${G[i]}, ${B[i]})`);
  }
});

test('P7 radar: blue-white flash, yellow afterglow', () => {
  const crt = new CrtPhosphor({ width: 1, height: 1, phosphor: PHOSPHORS.P7 });
  crt.step(Uint8Array.from([7]), 1 / 60);
  let [R, G, B] = crt.composite();
  assert.ok(B[0] > R[0], `flash leans blue (${R[0]}, ${B[0]})`);
  const dark = Uint8Array.from([0]);
  for (let i = 0; i < 30; i++) crt.step(dark, 1 / 60); // half a second later
  [R, G, B] = crt.composite();
  assert.ok(R[0] > B[0] * 2 && G[0] > B[0] * 2, `afterglow leans yellow (${R[0]}, ${G[0]}, ${B[0]})`);
  assert.ok(G[0] > 0.01, 'the radar glow persists');
});

test('burn-in: accumulated dose reduces efficiency', () => {
  const crt = new CrtPhosphor({ width: 2, height: 1, tau: [0.001, 0.001, 0.001], burnRate: 4 });
  const left = Uint8Array.from([2, 0]);
  const both = Uint8Array.from([2, 2]);
  for (let i = 0; i < 600; i++) crt.step(left, 1 / 60); // 10 s of burning pixel 0
  crt.step(both, 1 / 60);
  const worn = crt.sample(0, 0).r, fresh = crt.sample(1, 0).r;
  assert.ok(worn < fresh * 0.05, `burned pixel is dim (${worn} vs ${fresh})`);
});

// ---- the knobs on the back ----------------------------------------------

test('H-SIZE knob: shrinking the scan leaves dark borders', async () => {
  const { CrtTube } = await import('./tube.js');
  const W = 40, H = 10;
  const tube = new CrtTube({
    srcWidth: W, srcHeight: H, outWidth: W, outHeight: H,
    mask: 'none', barrel: 0, ghost: 0, vignette: 0, beamWidth: 0, edgeDefocus: 0, convergence: 0, scanlineDepth: 0,
  });
  const flat = new Float32Array(W * H).fill(1);
  const lum = [flat, flat, flat];
  const full = tube.apply(lum, null, { gamma: 1 });
  assert.ok(full[(5 * W + 1) * 4] > 200, 'hSize=1: lit to the edge');
  tube.setGeometry({ hSize: 0.7, vSize: 0.7 });
  const shrunk = tube.apply(lum, null, { gamma: 1 });
  assert.equal(shrunk[(5 * W + 1) * 4], 0, 'left border dark');
  assert.equal(shrunk[(0 * W + 20) * 4], 0, 'top border dark');
  assert.ok(shrunk[(5 * W + 20) * 4] > 200, 'center still lit');
  tube.setGeometry({ hSize: 1, vSize: 1 });
  assert.deepEqual(tube.apply(lum, null, { gamma: 1 }), full, 'knob back → identical LUT');
});

test('FOCUS knob: bleed grows monotonically with beam width', async () => {
  const { CrtTube } = await import('./tube.js');
  const W = 32, H = 8;
  const lum = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 16; x < W; x++) lum[y * W + x] = 1;
  const bleedAt = (bw) => {
    const tube = new CrtTube({
      srcWidth: W, srcHeight: H, outWidth: W, outHeight: H,
      mask: 'none', barrel: 0, ghost: 0, vignette: 0, beamWidth: bw, edgeDefocus: 0, convergence: 0, scanlineDepth: 0,
    });
    return tube.apply([lum, lum, lum], null, { gamma: 1 })[(4 * W + 14) * 4];
  };
  const b = [0, 0.5, 1, 1.5, 2].map(bleedAt);
  assert.equal(b[0], 0);
  for (let i = 1; i < b.length; i++) assert.ok(b[i] >= b[i - 1], `monotone: ${b.join(',')}`);
  assert.ok(b[4] > b[1], 'defocused end clearly softer');
});

test('oblique landing: edges defocus and R/B converge apart', async () => {
  const { CrtTube } = await import('./tube.js');
  const W = 128, H = 32;
  const tube = new CrtTube({
    srcWidth: W, srcHeight: H, outWidth: W, outHeight: H,
    mask: 'none', barrel: 0, ghost: 0, vignette: 0,
    beamWidth: 0, edgeDefocus: 0.8, convergence: 0.02, scanlineDepth: 0,
  });
  // vertical white 1px lines at center and near the left edge
  const lum = new Float32Array(W * H);
  for (let y = 0; y < H; y++) { lum[y * W + 64] = 1; lum[y * W + 8] = 1; }
  const rgba = tube.apply([lum, lum, lum], null, { gamma: 1 });
  const px = (x, ch) => rgba[(16 * W + x) * 4 + ch];
  // center: r²≈0 → sharp, no fringing: neighbors dark, line white
  assert.ok(px(64, 1) > 240, 'center line bright');
  assert.equal(px(62, 1), 0, 'center stays sharp');
  assert.ok(Math.abs(px(64, 0) - px(64, 2)) < 12, 'no fringe at center');
  // edge: defocused → energy spreads to neighbors
  const spread = px(7, 1) + px(9, 1);
  assert.ok(spread > 20, `edge line bleeds into neighbors (${spread})`);
  // convergence: red and blue peak on different columns near the edge
  const peak = (ch) => {
    let best = 0, bx = 0;
    for (let x = 2; x < 16; x++) if (px(x, ch) > best) { best = px(x, ch); bx = x; }
    return bx;
  };
  assert.notEqual(peak(0), peak(2), `R peak ${peak(0)} vs B peak ${peak(2)}`);
});

// ---- terminal layer ------------------------------------------------------

test('terminal: ESC[31m paints red, ESC[0m returns to white', async () => {
  const { Terminal } = await import('./term.js');
  const t = new Terminal({ cols: 80, rows: 25, ex: true });
  t.write('\x1b[31mRED\x1b[0mW');
  t.flush().update(1 / 60);
  const cgrom = new Uint8Array(256 * 16).fill(0xff);
  const img = t.render({ cgrom });
  assert.equal(img.pixels[0], 2, 'cell 0 red (GRB index 2)');
  assert.equal(img.pixels[3 * 8], 7, 'cell 3 back to white');
});

test('terminal: color and reverse both apply at column 0', async () => {
  const { Terminal } = await import('./term.js');
  const t = new Terminal({ cols: 80, rows: 25, ex: true });
  t.write('\x1b[7;33mAB');
  t.flush().update(1 / 60);
  const cgrom = new Uint8Array(256 * 16); // empty glyphs: reverse → solid
  const img = t.render({ cgrom });
  assert.equal(img.pixels[0], 6, 'reversed yellow at col 0 (ANSI 33 → GRB 6)');
});

test('terminal: newline at the bottom scrolls', async () => {
  const { Terminal } = await import('./term.js');
  const t = new Terminal({ cols: 80, rows: 5, ex: true });
  for (let i = 0; i < 7; i++) t.writeLine(`LINE${i}`);
  assert.ok(t.stats.scrolls >= 2);
  // LINE0..1 scrolled off; top row now LINE2? rows=5, 7 lines + trailing LF
  const top = String.fromCharCode(...t.chars.subarray(0, 5));
  assert.equal(top, 'LINE3');
});

test('terminal: original mode overflows past 20 pairs, ex mode does not', async () => {
  const { Terminal } = await import('./term.js');
  const rainbow = () => {
    let s = '';
    for (let i = 0; i < 40; i++) s += `\x1b[3${(i % 7) + 1}mX`;
    return s;
  };
  const orig = new Terminal({ cols: 80, rows: 25, ex: false });
  orig.write(rainbow());
  orig.flush();
  assert.ok(orig.stats.overflowRows > 0, 'real hardware runs out of pairs');
  const ex = new Terminal({ cols: 80, rows: 25, ex: true });
  ex.write(rainbow());
  ex.flush().update(1 / 60);
  assert.equal(ex.stats.overflowRows, 0, 'ex mode has per-cell slots');
  const cgrom = new Uint8Array(256 * 16).fill(0xff);
  const img = ex.render({ cgrom });
  // 25th X: color index for ANSI 3<(24%7)+1=4> → blue=1? ANSI 34 → GRB 1
  assert.equal(img.pixels[24 * 8], ANSI_TO_GRB_CHECK[(24 % 7) + 1]);
});
const ANSI_TO_GRB_CHECK = [0, 2, 4, 6, 1, 3, 5, 7];

test('terminal: semigraphic dots set/reset/query with per-cell color', async () => {
  const { Terminal } = await import('./term.js');
  const t = new Terminal({ cols: 80, rows: 25, ex: true });
  t.setDot(5, 7, 4); // green dot
  assert.equal(t.dot(5, 7), true);
  assert.equal(t.dot(4, 7), false);
  t.flush().update(1 / 60);
  const img = t.render({ cgrom: new Uint8Array(256 * 16) });
  // dot (5,7): cell (2,1), right column, band 3 → px x=5*4? dot x=5 → cell x*8..: cell 2 → px 16..23, right half 20..23; y: cell row 1 line 6..7 → py 8+6=14
  const px = img.pixels[14 * 640 + 20];
  assert.equal(px, 4, `green semigraphic dot (${px})`);
  t.resetDot(5, 7);
  assert.equal(t.dot(5, 7), false);
});

test('terminal: EX mode runs arbitrary geometry (100x30)', async () => {
  const { Terminal } = await import('./term.js');
  const t = new Terminal({ cols: 100, rows: 30, ex: true });
  t.write('\x1b[30;100H\x1b[35m@'); // bottom-right corner, magenta
  t.flush().update(1 / 60);
  const cgrom = new Uint8Array(256 * 16).fill(0xff);
  const img = t.render({ cgrom });
  assert.equal(img.width, 800);
  assert.equal(img.height, 240);
  assert.equal(img.pixels[(29 * 8) * 800 + 99 * 8], 3, 'magenta @ in the corner');
});

// ---- power-off collapse ---------------------------------------------------

test('power-off: collapsing scan piles the raster onto the center', async () => {
  const { collapseScan } = await import('./crt.js');
  const W = 8, H = 8;
  const src = new Uint8Array(W * H);
  src.fill(2); // red everywhere
  src[0] = 4; // one green pixel in the corner
  const dst = new Uint8Array(W * H);
  collapseScan(src, dst, W, H, 1, 0.01); // vertical collapse
  // outer rows dark, center band holds the OR of everything above/below
  assert.equal(dst[0], 0);
  assert.equal(dst[7 * W + 4], 0);
  const centerRow = 3 * W; // round(3.5 + (y-3.5)*0.01) → 3 or 4
  assert.equal(dst[centerRow + 0] & 4, 4, 'green OR-ed into the center line');
  assert.ok(dst[centerRow + 4] & 2, 'red present on the center line');
  const dst2 = new Uint8Array(W * H);
  collapseScan(src, dst2, W, H, 1, 0.01);
  assert.deepEqual(dst, dst2, 'deterministic');
});

test('power-off: density-boosted drive leaves a longer afterglow', () => {
  const glowAfter = (drive, frames) => {
    const crt = new CrtPhosphor({ width: 1, height: 1, tau: [0.06, 0.06, 0.06], drive });
    crt.step(Uint8Array.from([7]), 1 / 60);
    for (let i = 0; i < frames; i++) crt.step(Uint8Array.from([0]), 1 / 60);
    return crt.sample(0, 0).g;
  };
  const dim = glowAfter(1, 8);
  const hot = glowAfter(6, 8); // collapsed raster: same spot hit 6× harder
  assert.ok(hot > dim * 5.5, `hot spot lingers (${hot} vs ${dim})`);
});

// ---- video → semigraphic --------------------------------------------------

test('semivideo: solid red frame → red cells, all dots lit', async () => {
  const { rgbaToSemigraphic } = await import('./semivideo.js');
  const W = 16, H = 8;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = 255; rgba[i * 4 + 3] = 255; }
  const r = rgbaToSemigraphic(rgba, W, H);
  assert.equal(r.cols, 8);
  assert.equal(r.rows, 2);
  assert.ok([...r.codes].every((c) => c === 0xff), 'all dots on');
  assert.ok([...r.colors].every((c) => c === 2), 'GRB red everywhere');
});

test('semivideo: black frame → dark cells; gray → dithered density', async () => {
  const { rgbaToSemigraphic } = await import('./semivideo.js');
  const W = 16, H = 16;
  const black = rgbaToSemigraphic(new Uint8Array(W * H * 4), W, H);
  assert.ok([...black.codes].every((c) => c === 0));
  const gray = new Uint8Array(W * H * 4).fill(128);
  const g = rgbaToSemigraphic(gray, W, H);
  let lit = 0, total = 0;
  for (const code of g.codes) for (let b = 0; b < 8; b++) { total++; lit += (code >> b) & 1; }
  const density = lit / total;
  assert.ok(density > 0.3 && density < 0.7, `~50% dither density (${density})`);
  assert.ok([...g.colors].every((c) => c === 7), 'gray dithers as white dots');
  const g2 = rgbaToSemigraphic(gray, W, H);
  assert.deepEqual(g.codes, g2.codes, 'ordered dither is deterministic');
});

test('mask: any pitch keeps color balance (no yellow cast at pitch 2)', async () => {
  const { CrtTube } = await import('./tube.js');
  const W = 60, H = 6;
  for (const pitch of [2, 3, 4, 5, 7]) {
    const tube = new CrtTube({
      srcWidth: W, srcHeight: H, outWidth: W, outHeight: H,
      mask: 'aperture', maskPitch: pitch, maskLeak: 0.1,
      barrel: 0, ghost: 0, vignette: 0, beamWidth: 0, edgeDefocus: 0, convergence: 0, scanlineDepth: 0,
    });
    const flat = new Float32Array(W * H).fill(0.4);
    const rgba = tube.apply([flat, flat, flat], null, { gamma: 1 });
    let r = 0, g = 0, b = 0;
    for (let x = 0; x < W; x++) {
      const o = (3 * W + x) * 4;
      r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2];
    }
    const mean = (r + g + b) / 3;
    for (const [name, v] of [['R', r], ['G', g], ['B', b]]) {
      assert.ok(Math.abs(v - mean) / mean < 0.06,
        `pitch ${pitch}: ${name} balanced (${r}, ${g}, ${b})`);
    }
  }
});

test('analog drive: RGB levels excite the guns through degamma', () => {
  const crt = new CrtPhosphor({ width: 2, height: 1, tau: [0.05, 0.05, 0.05] });
  const frame = Uint8ClampedArray.from([255, 128, 0, 255, 0, 0, 0, 255]);
  crt.stepAnalog(frame, 1 / 60);
  const s = crt.sample(0, 0);
  assert.equal(s.r, 1);
  assert.ok(Math.abs(s.g - (128 / 255) ** 2.2) < 1e-4, `mid gray linearized (${s.g})`);
  assert.equal(s.b, 0);
  assert.deepEqual(crt.sample(1, 0), { r: 0, g: 0, b: 0 });
  crt.stepAnalog(Uint8ClampedArray.from([0, 0, 0, 255, 0, 0, 0, 255]), 1 / 60);
  const expected = Math.exp(-(1 / 60) / 0.05);
  assert.ok(Math.abs(crt.sample(0, 0).r - expected) < 1e-6, 'decays like the bit-driven path');
});

test('TINT: phase 0 is exact identity, rotation shifts hue deterministically', async () => {
  const { tintMatrix } = await import('./crt.js');
  const id = tintMatrix(0);
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => assert.ok(Math.abs(id[i] - v) < 1e-9, `id[${i}]`));
  const M = tintMatrix(0.5);
  // rotate pure red: luma is preserved, chroma moves off the red axis
  const r = [M[0], M[3], M[6]];
  const y = 0.299 * r[0] + 0.587 * r[1] + 0.114 * r[2];
  assert.ok(Math.abs(y - 0.299) < 1e-6, 'luma unchanged by tint');
  assert.ok(Math.abs(r[1]) > 0.01 || Math.abs(r[2]) > 0.01, 'hue actually rotated');
  assert.deepEqual(tintMatrix(0.5), M, 'deterministic');
});

test('CONTRAST: mid gray is the pivot, extremes stretch', () => {
  const crt = new CrtPhosphor({ width: 2, height: 1, tau: [0.05, 0.05, 0.05] });
  // pixel 0 bright, pixel 1 dark-ish via decay
  crt.step(Uint8Array.from([7, 7]), 1 / 60);
  for (let i = 0; i < 3; i++) crt.step(Uint8Array.from([7, 0]), 1 / 60); // pixel 1 decays below mid
  const flat = crt.toRGBA(null, { gamma: 1, contrast: 1 });
  const punchy = crt.toRGBA(null, { gamma: 1, contrast: 1.5 });
  assert.equal(punchy[0], 255, 'bright stays clipped high');
  assert.ok(punchy[4] < flat[4], 'darker pixel pushed further down');
});

test('V-HOLD: rolling remaps rows and sweeps a dark blanking band', async () => {
  const { rollScan } = await import('./crt.js');
  const W = 4, H = 6, BLANK = 2;
  const src = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) src.fill(y + 1, y * W, (y + 1) * W);
  const dst = new Uint8Array(W * H);
  rollScan(src, dst, W, H, 0, BLANK);
  assert.deepEqual(dst, src, 'offset 0 = locked = identity');
  rollScan(src, dst, W, H, 2, BLANK);
  assert.equal(dst[0], 3, 'row 0 shows source row 2');
  assert.equal(dst[3 * W], 6, 'row 3 shows source row 5');
  assert.equal(dst[4 * W], 0, 'row 4 is in the blanking band');
  assert.equal(dst[5 * W], 0, 'row 5 too');
  rollScan(src, dst, W, H, 7, BLANK); // wraps: 7 % 8 → src row 7 = blank, row1→0...
  assert.equal(dst[0], 0, 'blank line wrapped to the top');
  assert.equal(dst[1 * W], 1, 'then the frame starts over');
  const dst2 = new Uint8Array(W * H);
  rollScan(src, dst2, W, H, 7, BLANK);
  assert.deepEqual(dst, dst2, 'deterministic');
});

test('semivideo autoLevels: dark footage stretches to usable density', async () => {
  const { rgbaToSemigraphic } = await import('./semivideo.js');
  const W = 32, H = 16;
  const rgba = new Uint8Array(W * H * 4);
  // dark gradient: values only span 10..70
  for (let i = 0; i < W * H; i++) {
    const v = 10 + ((i % W) / W) * 60;
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  const density = (r) => {
    let lit = 0, total = 0;
    for (const c of r.codes) for (let b = 0; b < 8; b++) { total++; lit += (c >> b) & 1; }
    return lit / total;
  };
  const flat = density(rgbaToSemigraphic(rgba, W, H));
  const auto = density(rgbaToSemigraphic(rgba, W, H, { autoLevels: true }));
  assert.ok(flat < 0.25, `without levels the dark frame is dim (${flat})`);
  assert.ok(auto > flat * 1.8, `auto levels lift density substantially (${flat} → ${auto})`);
  assert.ok(auto < 0.75, `but not blown out (${auto})`);
  const auto2 = density(rgbaToSemigraphic(rgba, W, H, { autoLevels: true }));
  assert.equal(auto, auto2, 'deterministic');
});

test('line-art mode: flat regions go dark, boundaries light up in region color', async () => {
  const { rgbaToLineArt } = await import('./semivideo.js');
  const W = 32, H = 16;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (x < 16) rgba[o] = 220; // flat red region
    else rgba[o + 1] = 200; // flat green region
    rgba[o + 3] = 255;
  }
  const r = rgbaToLineArt(rgba, W, H, { autoLevels: false });
  let litCells = 0;
  for (let cy = 0; cy < r.rows; cy++) {
    for (let cx = 0; cx < r.cols; cx++) {
      const code = r.codes[cy * r.cols + cx];
      if (cx <= 5 || cx >= 10) assert.equal(code, 0, `flat region dark at cell ${cx}`);
      if (code) litCells++;
    }
  }
  assert.ok(litCells >= r.rows, 'the boundary column is lit');
  const r2 = rgbaToLineArt(rgba, W, H, { autoLevels: false });
  assert.deepEqual(r.codes, r2.codes, 'deterministic');
});

test('UEX 320x100: per-cell attributes keep columns ≥256 coherent', async () => {
  const { Terminal } = await import('./term.js');
  const t = new Terminal({ cols: 320, rows: 100, ex: true, showCursor: false });
  assert.ok(t.sys.memory.length > 0x10000, 'expanded RAM');
  assert.ok(t.attrPerCell, 'widths past 255 switch to per-cell attributes');
  const row = 99 * 320;
  t.chars[row + 100] = 0xff;
  t.colorA[row + 100] = (2 << 5) | 0x10 | 0x08; // red semigraphic at x=100
  t.chars[row + 319] = 0xff;
  t.colorA[row + 319] = (5 << 5) | 0x10 | 0x08; // cyan semigraphic at x=319
  t.flush().update(1 / 60);
  const img = t.render({ cgrom: new Uint8Array(256 * 16) });
  assert.equal(img.width, 2560);
  assert.equal(img.height, 800);
  const px = (cell) => img.pixels[(99 * 8) * 2560 + cell * 8];
  assert.equal(px(100), 2, 'red block at x=100');
  assert.equal(px(319), 5, 'cyan block at x=319 — no mod-256 position wrap');
  assert.equal(px(200), 0, 'default cells between them stay dark (was smeared by the pair-wrap bug)');
});

test('27-color flicker: middle levels alternate between phases', async () => {
  const { rgbaToSemigraphic } = await import('./semivideo.js');
  const W = 8, H = 8;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = 128; rgba[i * 4 + 3] = 255; } // half red
  const density = (r) => {
    let lit = 0, total = 0;
    for (const c of r.codes) for (let b = 0; b < 8; b++) { total++; lit += (c >> b) & 1; }
    return lit / total;
  };
  const r0 = rgbaToSemigraphic(rgba, W, H, { temporalPhase: 0 });
  const r1 = rgbaToSemigraphic(rgba, W, H, { temporalPhase: 1 });
  const p0 = density(r0), p1 = density(r1);
  // FRC stagger: each phase lights ~half the dots (checkerboard), and the
  // two phases are complementary — no whole-screen flash
  assert.ok(Math.abs(p0 - 0.5) < 0.1, `phase 0 ≈ half the dots (${p0})`);
  assert.ok(Math.abs(p1 - 0.5) < 0.1, `phase 1 ≈ half the dots (${p1})`);
  for (let i = 0; i < r0.codes.length; i++) {
    assert.equal(r0.codes[i] & r1.codes[i], 0, 'phases do not overlap at half level');
    assert.equal(r0.codes[i] | r1.codes[i], 0xff, 'phases cover every dot together');
  }
  rgba.fill(255); // full white
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const f0 = density(rgbaToSemigraphic(rgba, W, H, { temporalPhase: 0 }));
  const f1 = density(rgbaToSemigraphic(rgba, W, H, { temporalPhase: 1 }));
  assert.ok(f0 > 0.9 && f1 > 0.9, 'full level lit on both phases');
});

test('shadow mask: round delta-dot triads (∵), not stripes', async () => {
  const { CrtTube } = await import('./tube.js');
  const W = 48, H = 48;
  const tube = new CrtTube({
    srcWidth: W, srcHeight: H, outWidth: W, outHeight: H,
    mask: 'shadow', maskPitch: 4, maskLeak: 0.1,
    barrel: 0, ghost: 0, vignette: 0, beamWidth: 0, edgeDefocus: 0, convergence: 0, scanlineDepth: 0,
  });
  const flat = new Float32Array(W * H).fill(0.5);
  const rgba = tube.apply([flat, flat, flat], null, { gamma: 1 });
  // a stripe mask is constant down a column; round dots must vary in y too
  let varies = 0;
  for (let x = 10; x < 30; x++) {
    const a = rgba[(10 * W + x) * 4], b = rgba[(14 * W + x) * 4];
    if (Math.abs(a - b) > 25) varies++;
  }
  assert.ok(varies > 3, `R transmission varies vertically (${varies} columns)`);
  let r = 0, g = 0, bl = 0;
  for (let y = 4; y < 44; y++) for (let x = 4; x < 44; x++) {
    const o = (y * W + x) * 4;
    r += rgba[o]; g += rgba[o + 1]; bl += rgba[o + 2];
  }
  const mean = (r + g + bl) / 3;
  for (const v of [r, g, bl]) assert.ok(Math.abs(v - mean) / mean < 0.08, `balanced (${r},${g},${bl})`);
});

test('amber and plasma: mono displays lean orange, plasma barely persists', () => {
  const amber = new CrtPhosphor({ width: 1, height: 1, phosphor: PHOSPHORS.AMBER });
  amber.step(Uint8Array.from([7]), 1 / 60);
  let [R, G, B] = amber.composite();
  assert.ok(R[0] > G[0] && G[0] > B[0] * 5, `amber spectrum (${R[0]}, ${G[0]}, ${B[0]})`);
  const plasma = new CrtPhosphor({ width: 1, height: 1, phosphor: PHOSPHORS.PLASMA });
  plasma.step(Uint8Array.from([7]), 1 / 60);
  plasma.step(Uint8Array.from([0]), 1 / 60); // one dark frame: discharge is gone
  const s = plasma.sample(0, 0);
  assert.ok(s.r < 0.001, `gas discharge leaves no afterglow (${s.r})`);
});

test('plasma grid mask: mono square ribs, identical across channels', async () => {
  const { CrtTube } = await import('./tube.js');
  const W = 24, H = 24;
  const tube = new CrtTube({
    srcWidth: W, srcHeight: H, outWidth: W, outHeight: H,
    mask: 'plasma', maskPitch: 4,
    barrel: 0, ghost: 0, vignette: 0, beamWidth: 0, edgeDefocus: 0, convergence: 0, scanlineDepth: 0,
  });
  const flat = new Float32Array(W * H).fill(0.5);
  const rgba = tube.apply([flat, flat, flat], null, { gamma: 1 });
  let ribSeen = false;
  for (let y = 2; y < 20; y++) for (let x = 2; x < 20; x++) {
    const o = (y * W + x) * 4;
    assert.equal(rgba[o], rgba[o + 1], 'no RGB substructure');
    assert.equal(rgba[o + 1], rgba[o + 2]);
    if (rgba[o] < 100) ribSeen = true;
  }
  assert.ok(ribSeen, 'dark ribs between cells');
});

test('512-color mode: 8 duty levels per gun over a 7-frame cycle', async () => {
  const { rgbaToSemigraphic } = await import('./semivideo.js');
  const W = 8, H = 8;
  const mk = (v) => {
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { rgba[i * 4] = v; rgba[i * 4 + 3] = 255; }
    return rgba;
  };
  const duty = (v) => {
    let lit = 0, total = 0;
    for (let ph = 0; ph < 7; ph++) {
      const r = rgbaToSemigraphic(mk(v), W, H, { temporalPhase: ph, temporalLevels: 8 });
      for (const c of r.codes) for (let b = 0; b < 8; b++) { total++; lit += (c >> b) & 1; }
    }
    return lit / total;
  };
  assert.equal(duty(255), 1, 'full red lit on all 7 phases');
  assert.equal(duty(0), 0);
  const mid = duty(128);
  assert.ok(Math.abs(mid - 0.5) < 0.13, `mid gray ≈ half duty (${mid})`);
  const low = duty(64), high = duty(192);
  assert.ok(low < mid && mid < high, `duty is monotone (${low} < ${mid} < ${high})`);
});

test('empty cells carry color: line art survives ORIGINAL 20-pair rows', async () => {
  const { rgbaToLineArt } = await import('./semivideo.js');
  const { Terminal } = await import('./term.js');
  const { ATTR } = await import('./pc8001.js');
  // vertical white 1px lines every 4 dots: lit/empty cells alternate hard —
  // the pathological case for run-length attribute encoding
  const W = 160, H = 100;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x += 4) {
    const o = (y * W + x) * 4;
    rgba[o] = rgba[o + 1] = rgba[o + 2] = 255; rgba[o + 3] = 255;
  }
  const r = rgbaToLineArt(rgba, W, H, { autoLevels: false });
  // carried colors → runs merge; count distinct color runs on a middle row
  let runs = 1;
  for (let cx = 1; cx < r.cols; cx++) {
    if (r.colors[10 * r.cols + cx] !== r.colors[10 * r.cols + cx - 1]) runs++;
  }
  assert.ok(runs <= 20, `attribute runs per row collapse (${runs})`);
  // pour into an ORIGINAL-mode terminal like the video page does
  const t = new Terminal({ cols: 80, rows: 25, ex: false, showCursor: false });
  for (let i = 0; i < r.codes.length; i++) {
    t.chars[i] = r.codes[i];
    t.colorA[i] = (r.colors[i] << 5) | ATTR.SEMIGRAPHIC | ATTR.COLOR_FLAG;
    t.funcA[i] = 0;
  }
  t.stats.overflowRows = 0;
  t.flush().update(1 / 60);
  assert.equal(t.stats.overflowRows, 0, 'no pair overflow');
  const img = t.render({ cgrom: new Uint8Array(256 * 16) });
  // rightmost lit cell column must actually show its dots (was black-on-black)
  const rightCell = 76; // dot x=304 → cell 76
  const px = img.pixels[4 * 640 + rightCell * 8];
  assert.ok(px > 0, `right-half dots visible (${px})`);
});

test('PC-98 mode: 16-color palette fill inside detected regions, black outlines', async () => {
  const { analyzePc98, renderPc98Phase } = await import('./semivideo.js');
  const W = 32, H = 16;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (x < 16) rgba[o] = 255; // flat red region
    else { rgba[o + 1] = 128; } // flat mid-green region
    rgba[o + 3] = 255;
  }
  const a = analyzePc98(rgba, W, H, { autoLevels: false });
  assert.ok(a.palette.length / 3 <= 16, 'at most 16 palette entries');
  // full red: duty 7 → lit red on every phase; boundary column is black
  for (let ph = 0; ph < 7; ph++) {
    const idx = renderPc98Phase(a, ph);
    assert.equal(idx[5 * W + 4], 2, `red interior on phase ${ph}`);
    assert.equal(idx[5 * W + 15], 0, 'outline stays black');
  }
  // mid green: duty ≈ half over the 7-phase cycle
  let lit = 0;
  for (let ph = 0; ph < 7; ph++) {
    const idx = renderPc98Phase(a, ph);
    for (let y = 1; y < H - 1; y++) for (let x = 20; x < 30; x++) {
      if (idx[y * W + x] & 4) lit++;
    }
  }
  const duty = lit / (7 * (H - 2) * 10);
  assert.ok(duty > 0.3 && duty < 0.75, `mid green ≈ half duty (${duty})`);
  const a2 = analyzePc98(rgba, W, H, { autoLevels: false });
  assert.deepEqual(a.palDot, a2.palDot, 'deterministic');
});

test('full-color dither: 512-cube per dot, selectable screening patterns', async () => {
  const { analyzeFullColor, renderFullColorPhase } = await import('./semivideo.js');
  const W = 32, H = 16;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    rgba[o] = 160; rgba[o + 1] = 96; rgba[o + 2] = 32; rgba[o + 3] = 255; // one full color
  }
  for (const pattern of ['bayer', 'halftone', 'line']) {
    const a = analyzeFullColor(rgba, W, H, { autoLevels: false, pattern });
    // duty over 7 phases ≈ channel value
    const lit = [0, 0, 0];
    for (let ph = 0; ph < 7; ph++) {
      const idx = renderFullColorPhase(a, ph);
      for (let i = 0; i < W * H; i++) {
        if (idx[i] & 2) lit[0]++;
        if (idx[i] & 4) lit[1]++;
        if (idx[i] & 1) lit[2]++;
      }
    }
    const total = 7 * W * H;
    assert.ok(Math.abs(lit[0] / total - 160 / 255) < 0.1, `${pattern}: R duty (${lit[0] / total})`);
    assert.ok(Math.abs(lit[1] / total - 96 / 255) < 0.1, `${pattern}: G duty (${lit[1] / total})`);
    assert.ok(Math.abs(lit[2] / total - 32 / 255) < 0.12, `${pattern}: B duty (${lit[2] / total})`);
    const a2 = analyzeFullColor(rgba, W, H, { autoLevels: false, pattern });
    assert.deepEqual(a.levels, a2.levels, `${pattern} deterministic`);
  }
  // halftone must differ spatially from bayer (clustered vs dispersed)
  const b = analyzeFullColor(rgba, W, H, { autoLevels: false, pattern: 'bayer' });
  const h = analyzeFullColor(rgba, W, H, { autoLevels: false, pattern: 'halftone' });
  let diff = 0;
  for (let i = 0; i < b.levels.length; i++) if (b.levels[i] !== h.levels[i]) diff++;
  assert.ok(diff > 20, `patterns produce different screens (${diff} dots differ)`);
});

test('200-line scanlines: real black between the traces', async () => {
  const { CrtTube } = await import('./tube.js');
  const W = 8, H = 32;
  const mk = (scanlineDepth, beamHeight) => new CrtTube({
    srcWidth: W, srcHeight: H / 2, outWidth: W, outHeight: H,
    mask: 'none', barrel: 0, ghost: 0, vignette: 0, beamWidth: 0,
    edgeDefocus: 0, convergence: 0, scanlineDepth, beamHeight,
  });
  const flat = new Float32Array(W * (H / 2)).fill(1);
  const lum = [flat, flat, flat];
  const rgba200 = mk(1.0, 0.35).apply(lum, null, { gamma: 1 });
  const col = (img) => Array.from({ length: H }, (_, y) => img[(y * W + 4) * 4]);
  const c200 = col(rgba200);
  const lit = c200.filter((v) => v > 200).length;
  const dark = c200.filter((v) => v < 40).length;
  assert.ok(lit >= 8, `traces are lit (${lit} rows)`);
  assert.ok(dark >= 8, `gaps go properly black, not merely dim (${dark} rows)`);
  // gaps must survive gamma encoding as dark, not grey
  const rgba200g = mk(1.0, 0.35).apply(lum, null, { gamma: 2.2 });
  const gapsGamma = col(rgba200g).filter((v, i) => i % 2 === 1);
  assert.ok(Math.max(...gapsGamma) < 70,
    `gaps stay dark after gamma encoding (max ${Math.max(...gapsGamma)})`);
  // 400-line: traces packed, no black gaps
  const c400 = col(mk(0.3, 1.0).apply(lum, null, { gamma: 1 }));
  assert.equal(c400.filter((v) => v < 40).length, 0, '400-line closes the gaps');
  assert.ok(Math.min(...c400) > 120, `400-line stays bright between traces (${Math.min(...c400)})`);
});
