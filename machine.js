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
  constructor({ rom, frameHz = 60, clockHz = 4_000_000, dmaSteal = 0.3, extRamBanks = 4 } = {}) {
    if (!rom || rom.length < 0x1000) throw new Error('need an N-BASIC ROM image');
    this.sys = new Pc8001TextSystem({ frameHz });
    this.romTop = Math.min(0x8000, rom.length);
    this.sys.memory.set(rom.subarray(0, this.romTop), 0);
    this.keys = new Uint8Array(12).fill(0xff); // matrix rows, active low
    this.frameT = Math.round(clockHz / frameHz * (1 - dmaSteal));
    this.tInFrame = 0;
    this.frame = 0;

    // PC-8012 expansion-unit bank RAM: 32KB boards overlaying 0000-7FFF.
    // Port E2h = per-bank READ enable bitmap, E3h = per-bank WRITE enable
    // bitmap — separate registers, so "read the ROM while writing the RAM
    // behind it" is a legitimate move, and enabling several write bits
    // broadcasts one LD into every selected board at once. The PC-8801
    // inherited this exact protocol for its expansion RAM.
    //
    // Real boards top out at 8 (the bitmap is 8 bits). Ask for more and the
    // machine grows an EX bank-number register instead: OUT E0h/E1h = bank
    // index low/high, E2h/E3h bit0 still gate read/write. 65536 banks × 32KB
    // = 2 GiB on a Z80 — storage is lazy (a bank costs nothing until
    // touched), which is more than can be said for the 4MHz CPU: filling it
    // by LDIR at 21 T-states/byte would take about three hours.
    this.exMode = extRamBanks > 8;
    this.extRam = this.exMode ? new Map() : Array.from({ length: extRamBanks }, () => null);
    this.extBankCount = Math.min(this.exMode ? 0x10000 : 8, extRamBanks);
    this.bankIndex = 0;
    this.readEn = 0;
    this.writeEn = 0;

    const mem = this.sys.memory;
    const romTop = this.romTop;
    this.cpu = new Z80({
      read: (a) => {
        if (a < 0x8000 && this.readEn) {
          if (this.exMode) return this._bank(this.bankIndex)[a];
          const bank = this._lowestBank(this.readEn);
          if (bank >= 0) return this._bank(bank)[a];
        }
        return mem[a];
      },
      write: (a, v) => {
        if (a < 0x8000 && this.writeEn) {
          if (this.exMode) { this._bank(this.bankIndex)[a] = v; return; }
          for (let b = 0; b < this.extRam.length; b++) {
            if (this.writeEn & (1 << b)) this._bank(b)[a] = v;
          }
          return;
        }
        if (a >= romTop) mem[a] = v;
      },
      in: (p) => this._in(p & 0xff),
      out: (p, v) => this._out(p & 0xff, v),
    });
    this.cpu.pc = 0;
  }

  _bank(b) {
    if (this.exMode) {
      let ram = this.extRam.get(b);
      if (!ram) this.extRam.set(b, ram = new Uint8Array(0x8000));
      return ram;
    }
    return this.extRam[b] ?? (this.extRam[b] = new Uint8Array(0x8000));
  }

  _lowestBank(mask) {
    for (let b = 0; b < this.extRam.length; b++) if (mask & (1 << b)) return b;
    return -1;
  }

  _out(port, v) {
    if (this.exMode && port === 0xe0) {
      this.bankIndex = ((this.bankIndex & 0xff00) | v) % this.extBankCount;
      return;
    }
    if (this.exMode && port === 0xe1) {
      this.bankIndex = ((this.bankIndex & 0x00ff) | (v << 8)) % this.extBankCount;
      return;
    }
    const mask = this.exMode ? 1 : (1 << this.extRam.length) - 1;
    if (port === 0xe2) { this.readEn = v & mask; return; }
    if (port === 0xe3) { this.writeEn = v & mask; return; }
    this.sys.out(port, v);
  }

  _in(port) {
    if (port <= 0x0b) return this.keys[port]; // keyboard matrix
    if (port === 0x40) {
      // d5: VRTC (1 = vertical retrace) — high for the frame's tail
      const vrtc = this.tInFrame > this.frameT * 0.78;
      return vrtc ? 0xff : 0xdf;
    }
    if (port === 0x20 || port === 0x21) return 0x00; // 8251 stub
    if (port === 0xe2) return this.readEn; // PC-8012 bank state readback
    if (port === 0xe3) return this.writeEn;
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
