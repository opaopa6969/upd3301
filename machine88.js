// machine88 — PC-8801 (mkII SR and friends).
//
// The text pipeline is the SAME silicon as the PC-8001: μPD3301 + μPD8257,
// DMA channel 2, VRAM in main RAM. What the 8801 adds — and what this file
// is — is the layer the 8001 never had:
//
// - Bank switching. 0000-7FFF is ROM (N88 main, or N80 in N-mode) or RAM
//   (port 31h bit1); 6000-7FFF can instead be one of 4 extension ROM banks
//   (port 71h). C000-FFFF is main RAM or one GVRAM plane (ports 5Ch-5Fh).
// - Interrupts through a μPD8214 priority controller (ports E4h/E6h) —
//   8801 BASIC is interrupt-driven, not a polling loop. VRTC is level 1,
//   IM2 vectors from the level.
// - GVRAM: three 16KB planes (B, R, G) = 640x200 per-dot color, composited
//   *under* the text layer.
// - SR's V2 palette: 8 entries from a 512-color cube (3 bits per gun),
//   ports 54h-5Bh. Yes — the same 512 cube we dithered video into.
//
// Bring your own ROM: pass {main, ext, n80} images (see tools/split-pc88rom).
// Pure, deterministic, headless-testable. No ROM ships with this repo.

import { Z80 } from './z80.js';
import { Upd3301 } from './index.js';
import { Upd8257 } from './upd8257.js';
import { renderScreen } from './pc8001.js';

export const SCHEMA_VERSION = 1;

const GVRAM_SIZE = 0x4000; // 16KB per plane, window at C000-FFFF

export class Pc8801Machine {
  constructor({
    main, ext = null, n80 = null, mode = 'n88',
    frameHz = 60, clockHz = 3_993_600, dmaSteal = 0.3,
  } = {}) {
    if (!main || main.length < 0x8000) throw new Error('need a 32KB N88 main ROM');
    this.romMain = main;
    this.romExt = ext; // 4 x 8KB banks (6000-7FFF)
    this.romN80 = n80;

    this.ram = new Uint8Array(0x10000);
    this.gvram = [new Uint8Array(GVRAM_SIZE), new Uint8Array(GVRAM_SIZE), new Uint8Array(GVRAM_SIZE)];

    // bank state
    this.romEnabled = true; // port 31h bit1 = 0 → ROM at 0000-7FFF
    // 'n80' = the machine's N-BASIC mode (the DIP switch / mode selector).
    // It needs no disk sub-system, so it boots on a bare emulated machine.
    this.n80mode = mode === 'n80';
    this.extBank = -1; // -1 = main ROM at 6000-7FFF; 0..3 = extension bank
    this.gvramWindow = -1; // -1 = RAM at C000-FFFF; 0..2 = plane B/R/G
    this.gvramOn = false; // port 31h bit3
    this.mono = false;
    this.line400 = false;

    // palette: 8 entries, 3 bits per gun (SR V2 → 512-color cube)
    this.palette = new Uint8Array(8 * 3);
    for (let i = 0; i < 8; i++) { // power-up: the 8 primaries at full level
      this.palette[i * 3] = (i & 2) ? 7 : 0; // R
      this.palette[i * 3 + 1] = (i & 4) ? 7 : 0; // G
      this.palette[i * 3 + 2] = (i & 1) ? 7 : 0; // B
    }
    this._palLatch = 0;

    // interrupts (μPD8214 priority controller)
    // E4h: how many priority levels are enabled (level < intLevels passes)
    // E6h: per-source mask, 1 = enabled — bit0 timer, bit1 VRTC, bit2 8251
    this.intLevels = 0;
    this.intMaskBits = 0;
    this.intPending = 0;

    this.keys = new Uint8Array(16).fill(0xff);
    this.dipsw = [0xff, 0xff]; // 30h/31h reads (all switches "off" = boot N88)

    this.crtc = new Upd3301({ frameHz, drq: (buf) => this.dmac.drqPull(2, buf) });
    this.dmac = new Upd8257({ readMemory: (a) => this.ram[a & 0xffff] });
    this.width80 = true;

    this.frameT = Math.round(clockHz / frameHz * (1 - dmaSteal));
    this.tInFrame = 0;
    this.frame = 0;

    this.cpu = new Z80({
      read: (a) => this.readMem(a),
      write: (a, v) => this.writeMem(a, v),
      in: (p) => this.in(p & 0xff),
      out: (p, v) => this.out(p & 0xff, v),
    });
    this.cpu.pc = 0;
  }

  // ---- memory ------------------------------------------------------------
  readMem(a) {
    a &= 0xffff;
    if (a < 0x8000 && this.romEnabled) {
      if (a >= 0x6000 && this.extBank >= 0 && this.romExt) {
        return this.romExt[this.extBank * 0x2000 + (a - 0x6000)] ?? 0xff;
      }
      const rom = this.n80mode && this.romN80 ? this.romN80 : this.romMain;
      return rom[a] ?? 0xff;
    }
    if (a >= 0xc000 && this.gvramWindow >= 0) {
      return this.gvram[this.gvramWindow][a - 0xc000];
    }
    return this.ram[a];
  }

  writeMem(a, v) {
    a &= 0xffff;
    v &= 0xff;
    if (a >= 0xc000 && this.gvramWindow >= 0) {
      this.gvram[this.gvramWindow][a - 0xc000] = v;
      return;
    }
    this.ram[a] = v; // RAM is always writable underneath the ROM
  }

  // ---- I/O ----------------------------------------------------------------
  in(port) {
    if (port <= 0x0f) return this.keys[port]; // keyboard matrix
    if (port === 0x30) return this.dipsw[0];
    if (port === 0x31) return this.dipsw[1];
    if (port === 0x32) return 0xff;
    if (port === 0x40) {
      // d5 = VRTC (high during retrace), d1 = CMT carrier etc.
      const vrtc = this.tInFrame > this.frameT * 0.86;
      return (vrtc ? 0x20 : 0x00) | 0x02;
    }
    if (port === 0x50) return this.crtc.readParam();
    if (port === 0x51) return this.crtc.readStatus();
    if (port >= 0x60 && port <= 0x68) return this.dmac.readPort(port - 0x60);
    if (port === 0x44 || port === 0x45) return 0x00; // YM2203 stub
    if (port === 0xe2 || port === 0xe3) return 0xff; // EMM
    // FCh-FFh: 8255 to the FDD sub-CPU. Boot polls port FEh for the
    // handshake: it wants (v & 6) == 2 — sub-system alive, nothing to
    // boot from — otherwise it spins forever waiting for a disk.
    // FCh-FFh: 8255 to the FDD sub-CPU. With no drive unit the port C inputs
    // float high (FFh) — and that is exactly what the boot ROM expects to
    // see: each handshake poll is wrapped in a BC×D timeout (LD BC,0; LD D,4
    // → ~262k spins). When it expires the ROM concludes "no disk system" and
    // falls into BASIC. So: no fake handshake, just let it time out.
    if (port >= 0xfc && port <= 0xff) return 0xff;
    return 0xff;
  }

  out(port, v) {
    v &= 0xff;
    switch (port) {
      case 0x30: // system: 40/80 col, 20/25 lines, mono
        this.width80 = (v & 1) !== 0;
        return;
      case 0x31: // ROM/RAM, GVRAM enable, color, 200/400 line
        this.line400 = (v & 1) !== 0;
        this.romEnabled = (v & 2) === 0;
        this.gvramOn = (v & 8) !== 0;
        this.mono = (v & 4) !== 0;
        return;
      case 0x32: // mkII SR+: palette mode, sound int mask, ALU
        this._port32 = v;
        return;
      case 0x5c: this.gvramWindow = 0; return; // plane B into C000
      case 0x5d: this.gvramWindow = 1; return; // plane R
      case 0x5e: this.gvramWindow = 2; return; // plane G
      case 0x5f: this.gvramWindow = -1; return; // main RAM back
      case 0x50: this.crtc.writeParam(v); return;
      case 0x51: this.crtc.writeCommand(v); return;
      case 0x71: // extension ROM bank (FF = main ROM)
        this.extBank = v === 0xff ? -1 : (v & 3);
        return;
      case 0xe4: this.intLevels = v & 7; return; // 8214: number of levels enabled
      case 0xe6: this.intMaskBits = v; return; // per-source mask (1 = enabled)
      default:
        break;
    }
    if (port >= 0x54 && port <= 0x5b) { // SR V2 palette: 8 entries, 512 cube
      const i = port - 0x54;
      // V2 mode: two writes per entry (G/R then B) via port 32h bit5 latch;
      // simplified single-write form: bits 0-2 = B, 3-5 = R, 6-7+carry = G
      this.palette[i * 3] = (v >> 3) & 7; // R
      this.palette[i * 3 + 1] = ((v >> 6) & 3) | ((v & 0x80) ? 4 : 0); // G (approx)
      this.palette[i * 3 + 2] = v & 7; // B
      return;
    }
    if (port >= 0x60 && port <= 0x68) { this.dmac.writePort(port - 0x60, v); return; }
  }

  // ---- interrupts ---------------------------------------------------------
  _serviceInterrupts() {
    if (!this.intPending) return;
    for (let level = 0; level < 8; level++) {
      const bit = 1 << level;
      if (!(this.intPending & bit)) continue;
      if (level >= this.intLevels) continue; // 8214 priority gate
      if (!(this.intMaskBits & bit)) continue; // source masked off
      // IM2: the 8214 supplies the vector's low byte = level * 2
      const t = this.cpu.intRequest(level * 2);
      if (t > 0) this.intPending &= ~bit;
      return;
    }
  }

  // ---- run ----------------------------------------------------------------
  stepFrame() {
    while (this.tInFrame < this.frameT) {
      this.tInFrame += this.cpu.step();
      this._serviceInterrupts();
    }
    this.tInFrame -= this.frameT;
    this.crtc.stepFrame();
    this.intPending |= 0x02; // VRTC = level 1
    this.frame++;
    return this;
  }

  update(dt) {
    this._acc = (this._acc ?? 0) + dt;
    const period = 1 / 60;
    while (this._acc >= period) { this._acc -= period; this.stepFrame(); }
    return this;
  }

  keyDown(row, bit) { this.keys[row] &= ~(1 << bit); return this; }
  keyUp(row, bit) { this.keys[row] |= 1 << bit; return this; }

  // ---- video --------------------------------------------------------------
  // Composite: graphics planes (palette-indexed) under the text layer.
  // Returns { width, height, rgb: Uint8Array(w*h*3) } with 0-255 per channel
  // (the 512 cube's 3-bit levels scaled to 8 bits).
  render({ cgrom, out = null } = {}) {
    const text = renderScreen(this.crtc.getScreen(), {
      cgrom, colorMode: !this.mono, width80: this.width80,
    });
    const W = 640, H = 200;
    const rgb = out && out.length === W * H * 3 ? out : new Uint8Array(W * H * 3);
    const [B, R, G] = this.gvram;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let idx = 0;
        if (this.gvramOn) {
          const byte = (y * 80) + (x >> 3);
          const mask = 0x80 >> (x & 7);
          idx = ((G[byte] & mask) ? 4 : 0) | ((R[byte] & mask) ? 2 : 0) | ((B[byte] & mask) ? 1 : 0);
        }
        // text overlays graphics (non-zero text pixel wins)
        const t = i < text.pixels.length ? text.pixels[i] : 0;
        if (t) idx = t;
        const p = idx * 3;
        rgb[i * 3] = this.palette[p] * 36; // 0..7 → 0..252
        rgb[i * 3 + 1] = this.palette[p + 1] * 36;
        rgb[i * 3 + 2] = this.palette[p + 2] * 36;
      }
    }
    return { width: W, height: H, rgb, schemaVersion: SCHEMA_VERSION };
  }

  screenText() {
    const { cells, cols, rows } = this.crtc;
    const lines = [];
    for (let y = 0; y < rows; y++) {
      let line = '';
      for (let x = 0; x < cols; x++) {
        const c = cells[y * cols + x];
        line += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ' ';
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }
}

export function createPc8801Machine(opts) {
  return new Pc8801Machine(opts);
}
