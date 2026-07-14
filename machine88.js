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
import { I8255, crossWire } from './i8255.js';
import { Pc80s31 } from './pc80s31.js';
import { snapObj, restoreObj } from './snap.js';

export const SCHEMA_VERSION = 1;

const GVRAM_SIZE = 0x4000; // 16KB per plane, window at C000-FFFF

export class Pc8801Machine {
  constructor({
    main, ext = null, n80 = null, sub = null, mode = 'n88',
    frameHz = 60, clockHz = 3_993_600, dmaSteal = 0.3,
  } = {}) {
    if (!main || main.length < 0x8000) throw new Error('need a 32KB N88 main ROM');
    this.romMain = main;
    this.romExt = ext; // 4 x 8KB banks (6000-7FFF)
    this.romN80 = n80;

    // disk sub-system: a second Z80 running disk.rom, reached only through
    // the crossed 8255 pair at FCh-FFh. Without a sub ROM the ports float
    // high and the boot ROM times out into BASIC, same as a drive-less 88.
    this.sub = sub ? new Pc80s31({ rom: sub, clockHz }) : null;
    this.pio = this.sub ? new I8255() : null;
    if (this.sub) crossWire(this.pio, this.sub.pio);

    // power-on DRAM reads mostly-high on the real board, and the boot ROM
    // *depends* on it: the drive-presence tables at EF2D/EF35 are only
    // written by an option ROM's hook — absent one, bit4 of the power-on
    // garbage must read 1 ("no drive") or the ROM invents phantom drives
    // and boots from them instead of the sub-system.
    this.ram = new Uint8Array(0x10000).fill(0xff);
    this.gvram = [new Uint8Array(GVRAM_SIZE), new Uint8Array(GVRAM_SIZE), new Uint8Array(GVRAM_SIZE)];

    // bank state
    this.romEnabled = true; // port 31h bit1 = 0 → ROM at 0000-7FFF
    // 'n80' = the machine's N-BASIC mode (the DIP switch / mode selector).
    // It needs no disk sub-system, so it boots on a bare emulated machine.
    this.n80mode = mode === 'n80';
    this.extMapped = false; // port 71h bit0=0 → ext ROM at 6000-7FFF
    this._port71 = 0xff; // the raw latch (read back by the call dispatcher)
    this._port32 = 0; // bits 0-1 = EROMSL (which ext bank)
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
    // E4h: acceptance threshold — source n is delivered while its level ≤
    //      threshold (SIO=1, VSYNC=2, RTC=3, SOUND=5); bit3 = open all.
    //      Accepting an interrupt RESETS the threshold to 0: every handler
    //      re-arms via OUT E4h. (This is why 8801 BASIC writes E4h a lot.)
    // E6h: per-source enable — bit0 RTC (1/600s), bit1 VSYNC, bit2 SIO.
    // IM2 vector low byte = source number × 2 (SIO=0, VSYNC=1, RTC=2, SND=4).
    this.intLevels = 0;
    this.intMaskBits = 0;
    this.intPending = 0; // bit per source number

    this._pioLast = -1;
    this._pioPoll = 0;
    this.keys = new Uint8Array(16).fill(0xff);
    // 30h/31h DIP reads. N88 V2 mode: 30h bit0=1 (N88), upper bits pulled
    // high; 31h bit7=0 (V2), bit6=1 (H). All-FF here *looks* harmless but
    // means "V1 + every terminal option on" — the boot ROM then wanders off
    // into terminal-mode setup instead of booting the disk.
    this.dipsw = [0xdb, 0x79];

    this.crtc = new Upd3301({ frameHz, drq: (buf) => this.dmac.drqPull(2, buf) });
    this.dmac = new Upd8257({ readMemory: (a) => this.ram[a & 0xffff] });
    this.width80 = true;

    this.frameT = Math.round(clockHz / frameHz * (1 - dmaSteal));
    // the sub board has its own bus — no DMA steal there. Per T-state of
    // main CPU progress, the sub runs this many:
    this.subRatio = (clockHz / frameHz) / this.frameT;
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
      if (a >= 0x6000 && this.extMapped && this.romExt && !this.n80mode) {
        const bank = this._port32 & 3; // EROMSL
        return this.romExt[bank * 0x2000 + (a - 0x6000)] ?? 0xff;
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
    if (port === 0x32) return this._port32; // readable on mkII SR and later
    // 71h is READ by the cross-bank call dispatcher (3ABE): it stows the
    // current bank state in its stack frame so the return trampoline can
    // put it back. Returning a constant here means every OS call restores
    // the WRONG bank on the way home.
    if (port === 0x71) return this._port71;
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
    // FCh-FFh: the main half of the 8255 pair to the disk sub-system. With
    // no sub board the inputs float high and the boot ROM's BC×D timeout
    // loop expires into BASIC; with one, the two ROMs do the real handshake.
    if (port >= 0xfc && port <= 0xff) {
      if (!this.pio) return 0xff;
      const v = this.pio.read(port - 0xfc);
      // main spinning on an unchanged answer = it is waiting for the sub.
      // Count it so stepFrame can lend the sub extra time (same trick
      // QUASI88 uses: on continuous PIO reads, switch to the sub CPU) —
      // otherwise the boot ROM's timeout beats the sub ROM's motor delay.
      if (v === this._pioLast) this._pioPoll++;
      else { this._pioLast = v; this._pioPoll = 0; }
      return v;
    }
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
      case 0x71: // extension ROM select — bit0 = 0 maps the ext ROM at
        // 6000-7FFF; WHICH of the 4 banks comes from port 32h bits 0-1
        // (EROMSL). Getting this split wrong sends every cross-bank call
        // in the N88 ROM into the wrong bank and the machine into the weeds.
        this._port71 = v;
        this.extMapped = (v & 1) === 0;
        return;
      case 0xe4: this.intLevels = (v & 8) ? 7 : (v & 7); return; // 8214 threshold
      case 0xe6: // per-source enable; disabling a source drops its pending flag
        this.intMaskBits = v;
        if (!(v & 1)) this.intPending &= ~(1 << 2); // RTC
        if (!(v & 2)) this.intPending &= ~(1 << 1); // VSYNC
        if (!(v & 4)) this.intPending &= ~(1 << 0); // SIO
        return;
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
    if (port >= 0xfc && port <= 0xff && this.pio) { this.pio.write(port - 0xfc, v); return; }
  }

  // ---- interrupts ---------------------------------------------------------
  // sources by number n (vector = n*2) and 8214 level: SIO n=0 lv1,
  // VSYNC n=1 lv2, RTC n=2 lv3, SOUND n=4 lv5.
  _serviceInterrupts() {
    if (!this.intPending || !this.intLevels) return;
    let no = -1;
    if (this.intLevels >= 1 && (this.intPending & 1)) no = 0;
    else if (this.intLevels >= 2 && (this.intPending & 2)) no = 1;
    else if (this.intLevels >= 3 && (this.intPending & 4)) no = 2;
    else if (this.intLevels >= 5 && (this.intPending & 16)) no = 4;
    if (no < 0) return;
    const t = this.cpu.intRequest(no * 2);
    if (t > 0) {
      this.intPending &= ~(1 << no);
      this.intLevels = 0; // 8214: acceptance closes the gate until re-armed
    }
  }

  // ---- run ----------------------------------------------------------------
  // Main and sub CPUs interleave in ~100 T-state slices. The 8255 handshake
  // is level-polled on both sides, so slice granularity only paces the
  // transfer, it cannot break the protocol.
  stepFrame() {
    const SLICE = 100;
    // the 1/600s interval timer (level 0) — disk BASIC sleeps on it (EI/HALT),
    // so without these 10 ticks per frame the machine halts forever
    const timerPeriod = this.frameT / 10;
    let subDebt = 0;
    let nextTimer = this.tInFrame + timerPeriod;
    while (this.tInFrame < this.frameT) {
      const target = Math.min(this.frameT, this.tInFrame + SLICE);
      const before = this.tInFrame;
      while (this.tInFrame < target) {
        this.tInFrame += this.cpu.step();
        if (this.tInFrame >= nextTimer) {
          if (this.intMaskBits & 1) this.intPending |= 1 << 2; // RTC, source 2
          nextTimer += timerPeriod;
        }
        this._serviceInterrupts();
      }
      if (this.sub) {
        // polling main donates its wasted bus time to the sub (×16)
        const boost = this._pioPoll > 32 ? 16 : 1;
        subDebt += (this.tInFrame - before) * this.subRatio * boost;
        if (subDebt >= SLICE) subDebt -= this.sub.run(Math.floor(subDebt));
      }
    }
    this.tInFrame -= this.frameT;
    this.crtc.stepFrame();
    if (this.intMaskBits & 2) this.intPending |= 1 << 1; // VSYNC, source 1
    this.frame++;
    return this;
  }

  insertDisk(unit, disk) { this.sub?.insertDisk(unit, disk); return this; }
  ejectDisk(unit) { this.sub?.ejectDisk(unit); return this; }

  update(dt) {
    this._acc = (this._acc ?? 0) + dt;
    const period = 1 / 60;
    while (this._acc >= period) { this._acc -= period; this.stepFrame(); }
    return this;
  }

  keyDown(row, bit) { this.keys[row] &= ~(1 << bit); return this; }
  keyUp(row, bit) { this.keys[row] |= 1 << bit; return this; }

  // ---- time travel ---------------------------------------------------------
  // Deterministic machine + full state copy = rewindable execution, sub
  // board and FDC included. One caveat, documented rather than hidden:
  // mounted disk IMAGES are captured by reference, so sector writes are
  // not rewound (copying whole D88s per snapshot would cost megabytes).
  snapshot() {
    const s = {
      cpu: this.cpu.getState(),
      ram: this.ram.slice(),
      gvram: this.gvram.map((p) => p.slice()),
      palette: this.palette.slice(),
      keys: this.keys.slice(),
      dipsw: [...this.dipsw],
      crtc: snapObj(this.crtc),
      dmac: snapObj(this.dmac),
      bank: {
        romEnabled: this.romEnabled, extMapped: this.extMapped, port32: this._port32, port71: this._port71,
        gvramWindow: this.gvramWindow, gvramOn: this.gvramOn,
        mono: this.mono, line400: this.line400, width80: this.width80,
      },
      ints: { levels: this.intLevels, mask: this.intMaskBits, pending: this.intPending },
      pioPoll: { last: this._pioLast, count: this._pioPoll },
      tInFrame: this.tInFrame, frame: this.frame, acc: this._acc ?? 0,
    };
    if (this.sub) {
      s.pio = snapObj(this.pio);
      s.sub = {
        cpu: this.sub.cpu.getState(),
        mem: this.sub.mem.slice(),
        motor: this.sub.motor,
        pio: snapObj(this.sub.pio),
        fdc: this._snapFdc(),
      };
    }
    return s;
  }

  _snapFdc() {
    // explicit field list — snapObj would deep-copy whole mounted D88s.
    // drives/_multi/execBuf hold views INTO the disk images: reference them.
    const f = this.sub.fdc;
    return {
      phase: f.phase, cmdLen: f.cmdLen, cmd: [...f.cmd],
      result: [...f.result], resultPos: f.resultPos,
      execPos: f.execPos, execWrite: f.execWrite, int: f.int,
      seekEnd: f.seekEnd.map((p) => ({ ...p })), us: f.us, hd: f.hd,
      drives: f.drives.map((d) => ({ cyl: d.cyl, _idx: d._idx, disk: d.disk })),
      execBuf: f.execBuf,
      _multi: f._multi,
    };
  }

  restore(s) {
    this.cpu.setState(s.cpu);
    this.ram.set(s.ram);
    s.gvram.forEach((p, i) => this.gvram[i].set(p));
    this.palette.set(s.palette);
    this.keys.set(s.keys);
    this.dipsw = [...s.dipsw];
    restoreObj(this.crtc, s.crtc);
    restoreObj(this.dmac, s.dmac);
    const b = s.bank;
    this.romEnabled = b.romEnabled; this.extMapped = b.extMapped; this._port32 = b.port32;
    this._port71 = b.port71 ?? 0xff;
    this.gvramWindow = b.gvramWindow; this.gvramOn = b.gvramOn;
    this.mono = b.mono; this.line400 = b.line400; this.width80 = b.width80;
    this.intLevels = s.ints.levels; this.intMaskBits = s.ints.mask; this.intPending = s.ints.pending;
    this._pioLast = s.pioPoll.last; this._pioPoll = s.pioPoll.count;
    this.tInFrame = s.tInFrame; this.frame = s.frame; this._acc = s.acc;
    if (this.sub && s.sub) {
      restoreObj(this.pio, s.pio);
      this.sub.cpu.setState(s.sub.cpu);
      this.sub.mem.set(s.sub.mem);
      this.sub.motor = s.sub.motor;
      restoreObj(this.sub.pio, s.sub.pio);
      const f = this.sub.fdc;
      const fs = s.sub.fdc;
      for (const k of Object.keys(fs)) {
        if (k === 'drives' || k === 'execBuf' || k === '_multi') continue;
        f[k] = Array.isArray(fs[k]) ? fs[k].map((x) => (x && typeof x === 'object' ? { ...x } : x)) : fs[k];
      }
      f.drives.forEach((d, i) => { d.cyl = fs.drives[i].cyl; d._idx = fs.drives[i]._idx; d.disk = fs.drives[i].disk; });
      f.execBuf = fs.execBuf;
      f._multi = fs._multi;
    }
    return this;
  }

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
