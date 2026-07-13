// pc80s31 — the PC-8801's disk sub-system (PC-80S31 compatible): a whole
// second computer on a card. Its own Z80, a 2KB ROM, 16KB RAM, a μPD765
// FDC, and an 8255 whose other half lives on the main board.
//
// Nothing about the main↔sub protocol is emulated here — the 2KB ROM *is*
// the protocol. The main CPU's boot ROM and the sub ROM shake hands through
// the crossed 8255 latches exactly as they did in 1985; if you ever wrote
// your own handshake routine against this thing, this is the same bus.
//
// Memory map:  0000-1FFF ROM (2KB image mirrored), 4000-7FFF RAM.
// I/O:  F8h in = pulse the FDC's TC pin (yes, a *read* strobes it)
//       F8h out = drive motors, F4h/F7h = mode/printer (ignored)
//       FAh/FBh = μPD765 status/data
//       FCh-FFh = 8255 (crossed to the main board's at the same ports)
// INT:  the FDC's INT pin, straight into the Z80 (IM 0, bus floats to a
//       NOP) — the ROM sits in EI/HALT and gets woken once per byte.
//
// Pure, deterministic, headless. Bring your own sub ROM (disk.rom).

import { Z80 } from './z80.js';
import { I8255 } from './i8255.js';
import { Upd765 } from './upd765.js';

export const SCHEMA_VERSION = 1;

export class Pc80s31 {
  constructor({ rom, clockHz = 3_993_600 } = {}) {
    if (!rom || rom.length < 0x800) throw new Error('need a sub-system ROM (disk.rom)');
    this.clockHz = clockHz;
    this.mem = new Uint8Array(0x8000);
    // 2KB (or 8KB on 2HD models) ROM at 0, mirrored across 0000-1FFF
    const romLen = Math.min(rom.length, 0x2000);
    for (let a = 0; a < 0x2000; a += romLen) this.mem.set(rom.subarray(0, romLen), a);
    this.romTop = 0x2000;

    this.pio = new I8255();
    this.fdc = new Upd765();
    this.motor = 0;

    this.cpu = new Z80({
      read: (a) => this.mem[a & 0x7fff],
      write: (a, v) => { if ((a & 0xc000) === 0x4000) this.mem[a & 0x7fff] = v; },
      in: (p) => this._in(p & 0xff),
      out: (p, v) => this._out(p & 0xff, v),
    });
    this.cpu.pc = 0;
  }

  _in(port) {
    switch (port) {
      case 0xf8: this.fdc.tc(); return 0xff; // reading F8h pulses TC
      case 0xfa: return this.fdc.readStatus();
      case 0xfb: return this.fdc.read();
      case 0xfc: case 0xfd: case 0xfe: case 0xff:
        return this.pio.read(port - 0xfc);
      default: return 0xff;
    }
  }

  _out(port, v) {
    switch (port) {
      case 0xf4: case 0xf7: return; // drive mode / printer
      case 0xf8: this.motor = v; return;
      case 0xfb: this.fdc.write(v); return;
      case 0xfc: case 0xfd: case 0xfe: case 0xff:
        this.pio.write(port - 0xfc, v); return;
      default: return;
    }
  }

  // run for a slice of T-states; FDC INT is level-wired to the Z80
  run(tStates) {
    let t = 0;
    while (t < tStates) {
      if (this.fdc.intLine) this.cpu.intRequest(0x00); // IM 0, floating bus → NOP
      t += this.cpu.step();
    }
    return t;
  }

  insertDisk(unit, disk) { this.fdc.insertDisk(unit, disk); return this; }
  ejectDisk(unit) { this.fdc.ejectDisk(unit); return this; }

  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      pc: this.cpu.pc, halted: this.cpu.halted,
      fdc: this.fdc.getState(), motor: this.motor,
    };
  }
}
