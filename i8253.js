// i8253 — Intel 8253 / 8254 programmable interval timer.
//
// Three independent 16-bit down-counters. On a PC-9801 channel 0 is the system
// tick (it drives IRQ0), channel 1 the memory-refresh / beeper reference and
// channel 2 the speaker. The machine decides what the outputs are wired to;
// this file only counts.
//
// The awkward parts, both of which software depends on:
//
//   * the latch. Reading a counter while it is running gives a value that
//     changes between the two byte reads, so the CPU issues a latch command
//     first and then reads a frozen copy. Software that forgets is reading
//     garbage on real hardware too.
//   * the read/write order flip-flop. In "low then high" access mode the chip
//     remembers which half comes next, per channel, and a stray single-byte
//     access desynchronises everything after it.
//
// Modes 0 (interrupt on terminal count), 2 (rate generator) and 3 (square
// wave) are modelled properly; 1, 4 and 5 count down and pulse but do not
// model the gate. Nothing on a 9801 uses them.
//
// Pure, deterministic, zero deps.

export const SCHEMA_VERSION = 1;

class Channel {
  constructor() { this.reset(); }
  reset() {
    this.count = 0;             // the live counter
    this.reload = 0;            // what mode 2/3 reloads with
    this.latched = -1;          // frozen copy, or -1
    this.mode = 0;
    this.rw = 3;                // 1 = low only, 2 = high only, 3 = low then high
    this.bcd = false;
    this.writeHigh = false;     // next write is the high byte
    this.readHigh = false;
    this.out = false;
    this.armed = false;         // a reload value has been written
  }
}

export class I8253 {
  constructor({ onOut = null } = {}) {
    this.onOut = onOut;         // (channel, level) whenever an output changes
    this.ch = [new Channel(), new Channel(), new Channel()];
    this._frac = 0;
  }

  reset() { for (const c of this.ch) c.reset(); this._frac = 0; return this; }

  // ---- ports ------------------------------------------------------------------
  // offset 0-2 are the counters, 3 is the control word.
  write(offset, v) {
    v &= 0xff;
    if ((offset & 3) === 3) { this._control(v); return; }
    const c = this.ch[offset & 3];
    if (c.rw === 1) { c.reload = (c.reload & 0xff00) | v; this._loaded(c); return; }
    if (c.rw === 2) { c.reload = (c.reload & 0x00ff) | (v << 8); this._loaded(c); return; }
    if (!c.writeHigh) { c.reload = (c.reload & 0xff00) | v; c.writeHigh = true; return; }
    c.reload = (c.reload & 0x00ff) | (v << 8);
    c.writeHigh = false;
    this._loaded(c);
  }

  read(offset) {
    if ((offset & 3) === 3) return 0xff;
    const c = this.ch[offset & 3];
    const v = c.latched >= 0 ? c.latched : c.count;
    if (c.rw === 1) { if (c.latched >= 0) c.latched = -1; return v & 0xff; }
    if (c.rw === 2) { if (c.latched >= 0) c.latched = -1; return (v >> 8) & 0xff; }
    if (!c.readHigh) { c.readHigh = true; return v & 0xff; }
    c.readHigh = false;
    if (c.latched >= 0) c.latched = -1;
    return (v >> 8) & 0xff;
  }

  _control(v) {
    const sel = (v >> 6) & 3;
    if (sel === 3) return;                 // 8254 read-back; not used here
    const c = this.ch[sel];
    const rw = (v >> 4) & 3;
    if (rw === 0) {                        // counter latch command
      if (c.latched < 0) c.latched = c.count & 0xffff;
      return;
    }
    c.rw = rw;
    c.mode = (v >> 1) & 7;
    c.bcd = (v & 1) !== 0;
    c.writeHigh = false;
    c.readHigh = false;
    c.armed = false;
    // Loading a control word takes OUT low in every mode except 0's opposite;
    // mode 0 starts low and rises at terminal count, the rest start high.
    this._setOut(sel, c.mode !== 0);
  }

  _loaded(c) {
    // A reload of zero means 65536: the counter is 16 bits and wraps.
    c.count = c.reload === 0 ? 0x10000 : c.reload;
    c.armed = true;
    if (c.mode === 0) this._setOut(this.ch.indexOf(c), false);
  }

  _setOut(i, level) {
    const c = this.ch[i];
    if (c.out === level) return;
    c.out = level;
    if (this.onOut) this.onOut(i, level);
  }

  // ---- counting ------------------------------------------------------------------
  // `ticks` is in the timer's own input clocks. The machine converts from CPU
  // cycles; a 9801's PIT runs at 1.9968 MHz (or 2.4576 MHz on a 5 MHz machine),
  // which is not a nice ratio to anything, hence the fractional accumulator on
  // the machine side rather than here.
  advance(ticks) {
    if (ticks <= 0) return;
    for (let i = 0; i < 3; i++) {
      const c = this.ch[i];
      if (!c.armed) continue;
      switch (c.mode) {
        case 0: {
          c.count -= ticks;
          if (c.count <= 0) {
            c.count &= 0xffff;
            this._setOut(i, true);
            c.armed = false;          // one shot; stays until reloaded
          }
          break;
        }
        case 2: case 6: {
          const period = c.reload === 0 ? 0x10000 : c.reload;
          c.count -= ticks;
          while (c.count <= 0) {
            c.count += period;
            // The rate generator's OUT is low for exactly one clock, which no
            // caller can observe at this granularity — pulse it instead.
            this._setOut(i, false);
            this._setOut(i, true);
          }
          break;
        }
        case 3: case 7: {
          const period = c.reload === 0 ? 0x10000 : c.reload;
          c.count -= ticks * 2;       // mode 3 counts by two
          while (c.count <= 0) {
            c.count += period;
            this._setOut(i, !c.out);
          }
          break;
        }
        default: {
          c.count -= ticks;
          if (c.count <= 0) { c.count &= 0xffff; this._setOut(i, true); c.armed = false; }
          break;
        }
      }
    }
  }

  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      ch: this.ch.map((c) => ({
        count: c.count, reload: c.reload, latched: c.latched, mode: c.mode,
        rw: c.rw, bcd: c.bcd, writeHigh: c.writeHigh, readHigh: c.readHigh,
        out: c.out, armed: c.armed,
      })),
    };
  }

  setState(s) {
    for (let i = 0; i < 3; i++) Object.assign(this.ch[i], s.ch[i]);
    return this;
  }
}

export default I8253;
