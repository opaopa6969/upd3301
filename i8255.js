// i8255 — Intel 8255 / NEC μPD8255 programmable peripheral interface.
//
// Three 8-bit ports (A, B, C) whose direction is set by a control word;
// port C can also be poked one bit at a time (bit set/reset). The PC-8801
// carries a *pair* of these — one on the main board at FCh-FFh, one on the
// disk sub-board at the same addresses — cross-wired to each other:
//
//   main A(out) → sub B(in)     sub A(out) → main B(in)
//   main C upper(out) → sub C lower(in), and the mirror of that
//
// The famous boot handshake is nothing but two Z80s wiggling these latches
// at each other. We emulate the chip (latches + control word); the *wiring*
// is the board's job — a port programmed as input reads whatever the
// `inA/inB/inC` hooks say the other end is driving (floating high without).
//
// Mode 0 only: that is all the PC-8801 uses. Pure, deterministic, no deps.

export const SCHEMA_VERSION = 1;

export class I8255 {
  constructor({ inA = null, inB = null, inC = null } = {}) {
    this.inA = inA; this.inB = inB; this.inC = inC;
    this.reset();
  }

  reset() {
    // power-on: all ports input (control 9Bh), output latches cleared
    this.control = 0x9b;
    this.outA = 0; this.outB = 0; this.outC = 0;
    return this;
  }

  // control word (mode 0): bit4 = A input, bit1 = B input,
  // bit3 = C upper input, bit0 = C lower input
  get aIsInput() { return (this.control & 0x10) !== 0; }
  get bIsInput() { return (this.control & 0x02) !== 0; }
  get cUpperIsInput() { return (this.control & 0x08) !== 0; }
  get cLowerIsInput() { return (this.control & 0x01) !== 0; }

  // ---- bus interface (offset 0-3 = A, B, C, control) ----------------------
  read(offset) {
    switch (offset & 3) {
      case 0: return this.aIsInput ? (this.inA ? this.inA() & 0xff : 0xff) : this.outA;
      case 1: return this.bIsInput ? (this.inB ? this.inB() & 0xff : 0xff) : this.outB;
      case 2: {
        const wired = this.inC ? this.inC() & 0xff : 0xff;
        const hi = this.cUpperIsInput ? wired & 0xf0 : this.outC & 0xf0;
        const lo = this.cLowerIsInput ? wired & 0x0f : this.outC & 0x0f;
        return hi | lo;
      }
      default: return 0xff; // control readback is undefined on the real chip
    }
  }

  write(offset, v) {
    v &= 0xff;
    switch (offset & 3) {
      case 0: this.outA = v; return;
      case 1: this.outB = v; return;
      case 2: this.outC = v; return;
      case 3:
        if (v & 0x80) { // mode set — resets all output latches (real 8255 does)
          this.control = v;
          this.outA = this.outB = this.outC = 0;
        } else { // port C bit set/reset
          const bit = (v >> 1) & 7;
          if (v & 1) this.outC |= 1 << bit;
          else this.outC &= ~(1 << bit);
        }
        return;
    }
  }

  getState() {
    const { control, outA, outB, outC } = this;
    return { schemaVersion: SCHEMA_VERSION, control, outA, outB, outC };
  }
}

// Cross-wire two 8255s the way the PC-8801 main/sub boards are:
// A↔B crossed, C nibbles crossed (my upper input ← your lower output).
export function crossWire(m, s) {
  m.inA = () => s.outB;
  m.inB = () => s.outA;
  m.inC = () => ((s.outC & 0x0f) << 4) | ((s.outC & 0xf0) >> 4);
  s.inA = () => m.outB;
  s.inB = () => m.outA;
  s.inC = () => ((m.outC & 0x0f) << 4) | ((m.outC & 0xf0) >> 4);
}
