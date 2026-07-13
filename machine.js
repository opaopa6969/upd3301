// machine — the whole PC-8001: Z80 + ROM + RAM + μPD8257 + μPD3301,
// wired through the real memory map and port map.
//
// Memory: 0000-7FFF ROM (N-BASIC; writes ignored), 8000-FFFF RAM.
// I/O in: 00-0Bh keyboard matrix (active low, FFh = no keys),
//         20h/21h 8251 (stubbed), 40h status (VRTC on d5), CRTC/DMAC via
//         the text system. Everything else reads FFh (pulled-up bus).
// Timing: frame-based — run the Z80 for one frame's worth of T-states
// (optionally minus the famous ~30% DMA bus steal), then let the DMA haul
// the frame to the CRTC. VRTC is modeled as the tail fraction of the
// frame's T budget so BASIC's edge-polling loops converge.
//
// The ROM is NOT part of this repo (copyright NEC) — bring your own dump.

import { Z80 } from './z80.js';
import { Pc8001TextSystem } from './pc8001.js';

export const SCHEMA_VERSION = 1;

export class Pc8001Machine {
  constructor({ rom, frameHz = 60, clockHz = 4_000_000, dmaSteal = 0.3 } = {}) {
    if (!rom || rom.length < 0x1000) throw new Error('need an N-BASIC ROM image');
    this.sys = new Pc8001TextSystem({ frameHz });
    this.romTop = Math.min(0x8000, rom.length);
    this.sys.memory.set(rom.subarray(0, this.romTop), 0);
    this.keys = new Uint8Array(12).fill(0xff); // matrix rows, active low
    this.frameT = Math.round(clockHz / frameHz * (1 - dmaSteal));
    this.tInFrame = 0;
    this.frame = 0;

    const mem = this.sys.memory;
    const romTop = this.romTop;
    this.cpu = new Z80({
      read: (a) => mem[a],
      write: (a, v) => { if (a >= romTop) mem[a] = v; },
      in: (p) => this._in(p & 0xff),
      out: (p, v) => this.sys.out(p & 0xff, v),
    });
    this.cpu.pc = 0;
  }

  _in(port) {
    if (port <= 0x0b) return this.keys[port]; // keyboard matrix
    if (port === 0x40) {
      // d5: VRTC (1 = vertical retrace) — high for the frame's tail
      const vrtc = this.tInFrame > this.frameT * 0.78;
      return vrtc ? 0xff : 0xdf;
    }
    if (port === 0x20 || port === 0x21) return 0x00; // 8251 stub
    const v = this.sys.in(port);
    return v === 0xff && port >= 0x50 && port <= 0x68 ? this.sys.in(port) : v;
  }

  // The 8001's port 30h d0 selects the character clock (40/80), but N-BASIC
  // programs the CRTC's column count too — trust the chip: 80 columns means
  // 80-column dots. (Assuming port 30h alone stretched every dot 2x and made
  // the screen 1280 px wide.)
  _syncWidth() {
    if (this.sys.crtc.cols >= 60) this.sys.width80 = true;
  }

  // run exactly one video frame's worth of CPU time, then refresh the CRT
  stepFrame() {
    this._syncWidth();
    while (this.tInFrame < this.frameT) {
      this.tInFrame += this.cpu.step();
    }
    this.tInFrame -= this.frameT;
    this.sys.crtc.stepFrame();
    this.frame++;
    return this;
  }

  update(dt) {
    this._acc = (this._acc ?? 0) + dt;
    const period = 1 / 60;
    while (this._acc >= period) {
      this._acc -= period;
      this.stepFrame();
    }
    return this;
  }

  // ---- keyboard matrix ---------------------------------------------------
  // PC-8001 matrix: port = row (00h-09h), bit = column, active low.
  keyDown(row, bit) { this.keys[row] &= ~(1 << bit); return this; }
  keyUp(row, bit) { this.keys[row] |= 1 << bit; return this; }

  // ---- observation ---------------------------------------------------------
  screenText() {
    const { cells, cols, rows } = this.sys.crtc;
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

  render(opts) { return this.sys.render(opts); }
}

export function createPc8001Machine(opts) {
  return new Pc8001Machine(opts);
}
