// z80 — Zilog Z80 CPU core. Pure JS, zero deps, deterministic.
//
// The missing chip: with this, the layer stack (μPD3301 ← μPD8257 ←
// PC-8001 wiring ← physics ← terminal) becomes a whole machine — feed it a
// ROM and it computes.
//
// Coverage: full documented instruction set — main table, CB (rotates,
// BIT/RES/SET), ED (16-bit ADC/SBC, block transfer/search/IO, RRD/RLD,
// NEG, IM, I/R), DD/FD (IX/IY with displacement, IXH/IXL undocumented
// halves, DDCB/FDCB including the undocumented register-copy forms).
// Flags include the undocumented F3/F5 bits in the common cases; block-IO
// flags are approximate. Interrupts: IM 0 (RST forms), IM 1, IM 2, NMI,
// EI delay, HALT. R refresh counter advances per M1.
//
// The bus is injected: { read(a), write(a, v), in(port), out(port, v) } —
// ports are 16-bit (B on the upper lines for the C forms, A for the n
// forms), addresses 16-bit. step() executes one instruction and returns
// its T-states (standard values; not cycle-stepped within instructions).
//
// Suite contract: no Math.random, same program + same bus → identical
// state. getState() returns plain data with schemaVersion.

export const SCHEMA_VERSION = 1;

const FC = 0x01, FN = 0x02, FP = 0x04, F3 = 0x08, FH = 0x10, F5 = 0x20, FZ = 0x40, FS = 0x80;

// S, Z, F5, F3, parity — precomputed per byte
const SZP = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let p = i, bits = 0;
  while (p) { bits ^= p & 1; p >>= 1; }
  SZP[i] = (i & (FS | F5 | F3)) | (i === 0 ? FZ : 0) | (bits ? 0 : FP);
}

const sign8 = (v) => (v << 24) >> 24;

export class Z80 {
  constructor(bus) {
    this.bus = bus;
    this.reset();
  }

  reset() {
    this.a = 0xff; this.f = 0xff;
    this.b = 0; this.c = 0; this.d = 0; this.e = 0; this.h = 0; this.l = 0;
    this.a_ = 0; this.f_ = 0; this.b_ = 0; this.c_ = 0; this.d_ = 0; this.e_ = 0; this.h_ = 0; this.l_ = 0;
    this.ix = 0; this.iy = 0;
    this.sp = 0xffff; this.pc = 0;
    this.i = 0; this.r = 0;
    this.iff1 = false; this.iff2 = false;
    this.im = 0;
    this.halted = false;
    this._eiDelay = 0;
    return this;
  }

  getState() {
    const { a, f, b, c, d, e, h, l, ix, iy, sp, pc, i, r, iff1, iff2, im, halted } = this;
    return {
      schemaVersion: SCHEMA_VERSION,
      a, f, b, c, d, e, h, l, ix, iy, sp, pc, i, r, iff1, iff2, im, halted,
      shadow: { a: this.a_, f: this.f_, b: this.b_, c: this.c_, d: this.d_, e: this.e_, h: this.h_, l: this.l_ },
    };
  }

  // ---- register pair helpers ------------------------------------------
  get bc() { return (this.b << 8) | this.c; }
  set bc(v) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
  get de() { return (this.d << 8) | this.e; }
  set de(v) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }
  get hl() { return (this.h << 8) | this.l; }
  set hl(v) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }
  get af() { return (this.a << 8) | this.f; }
  set af(v) { this.a = (v >> 8) & 0xff; this.f = v & 0xff; }

  _getRP(i, ixy) { // BC DE HL/IXY SP
    return i === 0 ? this.bc : i === 1 ? this.de : i === 2 ? (ixy ? this[ixy] : this.hl) : this.sp;
  }

  _setRP(i, v, ixy) {
    v &= 0xffff;
    if (i === 0) this.bc = v;
    else if (i === 1) this.de = v;
    else if (i === 2) { if (ixy) this[ixy] = v; else this.hl = v; }
    else this.sp = v;
  }

  // ---- memory / fetch ---------------------------------------------------
  _rd(a) { return this.bus.read(a & 0xffff) & 0xff; }
  _wr(a, v) { this.bus.write(a & 0xffff, v & 0xff); }
  _fetch() { const v = this._rd(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  _fetch16() { const lo = this._fetch(); return lo | (this._fetch() << 8); }
  _rd16(a) { return this._rd(a) | (this._rd(a + 1) << 8); }
  _wr16(a, v) { this._wr(a, v); this._wr(a + 1, v >> 8); }
  _push(v) { this.sp = (this.sp - 2) & 0xffff; this._wr16(this.sp, v); }
  _pop() { const v = this._rd16(this.sp); this.sp = (this.sp + 2) & 0xffff; return v; }
  _bumpR() { this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f); }

  // ---- 8-bit ALU ---------------------------------------------------------
  _add8(v, carry) {
    const a = this.a, r = a + v + carry, res = r & 0xff;
    this.f = (res & (FS | F5 | F3)) | (res === 0 ? FZ : 0)
      | ((a ^ v ^ res) & FH)
      | ((~(a ^ v) & (a ^ res) & 0x80) ? FP : 0)
      | (r > 0xff ? FC : 0);
    this.a = res;
  }

  _sub8(v, carry, store = true) {
    const a = this.a, r = a - v - carry, res = r & 0xff;
    this.f = (res & (FS | F5 | F3)) | (res === 0 ? FZ : 0)
      | ((a ^ v ^ res) & FH)
      | (((a ^ v) & (a ^ res) & 0x80) ? FP : 0)
      | (r < 0 ? FC : 0) | FN;
    if (store) this.a = res;
    return res;
  }

  _cp(v) {
    this._sub8(v, 0, false);
    // F5/F3 come from the operand on CP
    this.f = (this.f & ~(F5 | F3)) | (v & (F5 | F3));
  }

  _and(v) { this.a &= v; this.f = SZP[this.a] | FH; }
  _or(v) { this.a |= v; this.f = SZP[this.a]; }
  _xor(v) { this.a ^= v; this.f = SZP[this.a]; }

  _alu(op, v) {
    switch (op) {
      case 0: this._add8(v, 0); break;
      case 1: this._add8(v, this.f & FC); break;
      case 2: this._sub8(v, 0); break;
      case 3: this._sub8(v, this.f & FC); break;
      case 4: this._and(v); break;
      case 5: this._xor(v); break;
      case 6: this._or(v); break;
      case 7: this._cp(v); break;
    }
  }

  _inc8(v) {
    const res = (v + 1) & 0xff;
    this.f = (this.f & FC) | (res & (FS | F5 | F3)) | (res === 0 ? FZ : 0)
      | ((res & 0x0f) === 0 ? FH : 0) | (v === 0x7f ? FP : 0);
    return res;
  }

  _dec8(v) {
    const res = (v - 1) & 0xff;
    this.f = (this.f & FC) | (res & (FS | F5 | F3)) | (res === 0 ? FZ : 0)
      | ((v & 0x0f) === 0 ? FH : 0) | (v === 0x80 ? FP : 0) | FN;
    return res;
  }

  // ---- 16-bit ALU ----------------------------------------------------------
  _add16(x, y) {
    const r = x + y, res = r & 0xffff;
    this.f = (this.f & (FS | FZ | FP))
      | ((res >> 8) & (F5 | F3))
      | (((x ^ y ^ res) >> 8) & FH)
      | (r > 0xffff ? FC : 0);
    return res;
  }

  _adc16(x, y) {
    const c = this.f & FC, r = x + y + c, res = r & 0xffff;
    this.f = ((res >> 8) & (FS | F5 | F3)) | (res === 0 ? FZ : 0)
      | (((x ^ y ^ res) >> 8) & FH)
      | ((~(x ^ y) & (x ^ res) & 0x8000) ? FP : 0)
      | (r > 0xffff ? FC : 0);
    return res;
  }

  _sbc16(x, y) {
    const c = this.f & FC, r = x - y - c, res = r & 0xffff;
    this.f = ((res >> 8) & (FS | F5 | F3)) | (res === 0 ? FZ : 0)
      | (((x ^ y ^ res) >> 8) & FH)
      | (((x ^ y) & (x ^ res) & 0x8000) ? FP : 0)
      | (r < 0 ? FC : 0) | FN;
    return res;
  }

  // ---- CB rotates/shifts -----------------------------------------------
  _rot(op, v) {
    let res, c;
    switch (op) {
      case 0: c = v >> 7; res = ((v << 1) | c) & 0xff; break; // RLC
      case 1: c = v & 1; res = ((v >> 1) | (c << 7)) & 0xff; break; // RRC
      case 2: c = v >> 7; res = ((v << 1) | (this.f & FC)) & 0xff; break; // RL
      case 3: c = v & 1; res = ((v >> 1) | ((this.f & FC) << 7)) & 0xff; break; // RR
      case 4: c = v >> 7; res = (v << 1) & 0xff; break; // SLA
      case 5: c = v & 1; res = ((v >> 1) | (v & 0x80)) & 0xff; break; // SRA
      case 6: c = v >> 7; res = ((v << 1) | 1) & 0xff; break; // SLL (undoc)
      default: c = v & 1; res = v >> 1; break; // SRL
    }
    this.f = SZP[res] | (c ? FC : 0);
    return res;
  }

  // ---- conditions ---------------------------------------------------------
  _cond(y) {
    switch (y) {
      case 0: return !(this.f & FZ);
      case 1: return !!(this.f & FZ);
      case 2: return !(this.f & FC);
      case 3: return !!(this.f & FC);
      case 4: return !(this.f & FP);
      case 5: return !!(this.f & FP);
      case 6: return !(this.f & FS);
      default: return !!(this.f & FS);
    }
  }

  // ---- interrupts -----------------------------------------------------------
  intRequest(data = 0xff) {
    if (!this.iff1 || this._eiDelay > 0) return 0;
    this.halted = false;
    this.iff1 = this.iff2 = false;
    this._bumpR();
    if (this.im === 2) {
      this._push(this.pc);
      this.pc = this._rd16(((this.i << 8) | data) & 0xffff);
      return 19;
    }
    if (this.im === 1) {
      this._push(this.pc);
      this.pc = 0x38;
      return 13;
    }
    // IM 0: support the RST forms of the bus opcode
    if ((data & 0xc7) === 0xc7) {
      this._push(this.pc);
      this.pc = data & 0x38;
    }
    return 13;
  }

  nmi() {
    this.halted = false;
    this.iff2 = this.iff1;
    this.iff1 = false;
    this._bumpR();
    this._push(this.pc);
    this.pc = 0x66;
    return 11;
  }

  // ---- execution ------------------------------------------------------------
  step() {
    if (this.halted) { this._bumpR(); this._tickEI(); return 4; }
    const t = this._exec(null);
    this._tickEI();
    return t;
  }

  _tickEI() {
    if (this._eiDelay > 0 && --this._eiDelay === 0) this.iff1 = this.iff2 = true;
  }

  // run for approximately `tstates`, returns actual T-states executed
  run(tstates) {
    let t = 0;
    while (t < tstates) t += this.step();
    return t;
  }

  _exec(ixy) {
    const op = this._fetch();
    this._bumpR();
    if (op === 0xdd) return 4 + this._exec('ix');
    if (op === 0xfd) return 4 + this._exec('iy');
    if (op === 0xcb) return this._execCB(ixy);
    if (op === 0xed) return this._execED();

    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    let ea = null;
    const EA = () => {
      if (ea === null) ea = ixy ? (this[ixy] + sign8(this._fetch())) & 0xffff : this.hl;
      return ea;
    };
    // 8-bit register read/write; halves of IX/IY substitute H/L unless the
    // instruction also touches (HL) — then H/L stay plain (real chip rule).
    const useHalves = ixy && !(x === 1 ? (y === 6 || z === 6) : x === 0 ? y === 6 : z === 6);
    const getR = (i) => {
      switch (i) {
        case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
        case 4: return useHalves ? (this[ixy] >> 8) & 0xff : this.h;
        case 5: return useHalves ? this[ixy] & 0xff : this.l;
        case 6: return this._rd(EA());
        default: return this.a;
      }
    };
    const setR = (i, v) => {
      v &= 0xff;
      switch (i) {
        case 0: this.b = v; break; case 1: this.c = v; break;
        case 2: this.d = v; break; case 3: this.e = v; break;
        case 4: if (useHalves) this[ixy] = (this[ixy] & 0xff) | (v << 8); else this.h = v; break;
        case 5: if (useHalves) this[ixy] = (this[ixy] & 0xff00) | v; else this.l = v; break;
        case 6: this._wr(EA(), v); break;
        default: this.a = v; break;
      }
    };

    // x = 1: LD r,r' (0x76 = HALT)
    if (x === 1) {
      if (op === 0x76) { this.halted = true; return 4; }
      // for LD r,(IX+d) / LD (IX+d),r the EA must resolve before both sides
      setR(y, getR(z));
      return y === 6 || z === 6 ? (ixy ? 19 : 7) : 4;
    }
    // x = 2: ALU A, r
    if (x === 2) {
      this._alu(y, getR(z));
      return z === 6 ? (ixy ? 19 : 7) : 4;
    }
    if (x === 0) {
      switch (z) {
        case 0:
          if (y === 0) return 4; // NOP
          if (y === 1) { // EX AF,AF'
            [this.a, this.a_] = [this.a_, this.a];
            [this.f, this.f_] = [this.f_, this.f];
            return 4;
          }
          if (y === 2) { // DJNZ d
            const d = sign8(this._fetch());
            this.b = (this.b - 1) & 0xff;
            if (this.b !== 0) { this.pc = (this.pc + d) & 0xffff; return 13; }
            return 8;
          }
          if (y === 3) { const d = sign8(this._fetch()); this.pc = (this.pc + d) & 0xffff; return 12; } // JR d
          { // JR cc,d
            const d = sign8(this._fetch());
            if (this._cond(y - 4)) { this.pc = (this.pc + d) & 0xffff; return 12; }
            return 7;
          }
        case 1:
          if (y & 1) { // ADD HL,rp
            const rp = y >> 1;
            this._setRP(2, this._add16(this._getRP(2, ixy), this._getRP(rp, ixy)), ixy);
            return ixy ? 15 : 11;
          }
          this._setRP(y >> 1, this._fetch16(), ixy); // LD rp,nn
          return ixy ? 14 : 10;
        case 2: {
          const nn = () => this._fetch16();
          switch (y) {
            case 0: this._wr(this.bc, this.a); return 7; // LD (BC),A
            case 1: this.a = this._rd(this.bc); return 7; // LD A,(BC)
            case 2: this._wr(this.de, this.a); return 7;
            case 3: this.a = this._rd(this.de); return 7;
            case 4: this._wr16(nn(), this._getRP(2, ixy)); return ixy ? 20 : 16; // LD (nn),HL
            case 5: this._setRP(2, this._rd16(nn()), ixy); return ixy ? 20 : 16; // LD HL,(nn)
            case 6: this._wr(nn(), this.a); return 13; // LD (nn),A
            default: this.a = this._rd(nn()); return 13; // LD A,(nn)
          }
        }
        case 3: { // INC/DEC rp
          const rp = y >> 1, delta = y & 1 ? -1 : 1;
          this._setRP(rp, this._getRP(rp, ixy) + delta, ixy);
          return ixy ? 10 : 6;
        }
        case 4: setR(y, this._inc8(getR(y))); return y === 6 ? (ixy ? 23 : 11) : 4; // INC r
        case 5: setR(y, this._dec8(getR(y))); return y === 6 ? (ixy ? 23 : 11) : 4; // DEC r
        case 6: // LD r,n — with prefix and (HL): d comes before n
          if (y === 6 && ixy) { const a2 = EA(); this._wr(a2, this._fetch()); return 19; }
          setR(y, this._fetch());
          return y === 6 ? 10 : 7;
        default: // z == 7: accumulator/flag ops
          switch (y) {
            case 0: { const c = this.a >> 7; this.a = ((this.a << 1) | c) & 0xff; // RLCA
              this.f = (this.f & (FS | FZ | FP)) | (this.a & (F5 | F3)) | (c ? FC : 0); return 4; }
            case 1: { const c = this.a & 1; this.a = ((this.a >> 1) | (c << 7)) & 0xff; // RRCA
              this.f = (this.f & (FS | FZ | FP)) | (this.a & (F5 | F3)) | (c ? FC : 0); return 4; }
            case 2: { const c = this.a >> 7; this.a = ((this.a << 1) | (this.f & FC)) & 0xff; // RLA
              this.f = (this.f & (FS | FZ | FP)) | (this.a & (F5 | F3)) | (c ? FC : 0); return 4; }
            case 3: { const c = this.a & 1; this.a = ((this.a >> 1) | ((this.f & FC) << 7)) & 0xff; // RRA
              this.f = (this.f & (FS | FZ | FP)) | (this.a & (F5 | F3)) | (c ? FC : 0); return 4; }
            case 4: { // DAA
              let adj = 0, c = this.f & FC;
              if ((this.f & FH) || (this.a & 0x0f) > 9) adj = 6;
              if (c || this.a > 0x99) { adj |= 0x60; c = FC; }
              const before = this.a;
              const res = (this.f & FN) ? (this.a - adj) & 0xff : (this.a + adj) & 0xff;
              this.f = (this.f & FN) | SZP[res] | c | ((before ^ res) & FH);
              this.a = res;
              return 4;
            }
            case 5: this.a ^= 0xff; // CPL
              this.f = (this.f & (FS | FZ | FP | FC)) | (this.a & (F5 | F3)) | FH | FN; return 4;
            case 6: this.f = (this.f & (FS | FZ | FP)) | (this.a & (F5 | F3)) | FC; return 4; // SCF
            default: { // CCF
              const c = this.f & FC;
              this.f = (this.f & (FS | FZ | FP)) | (this.a & (F5 | F3)) | (c ? FH : FC);
              return 4;
            }
          }
      }
    }
    // x = 3
    switch (z) {
      case 0: // RET cc
        if (this._cond(y)) { this.pc = this._pop(); return 11; }
        return 5;
      case 1:
        if (!(y & 1)) { // POP rp2
          const rp = y >> 1;
          if (rp === 3) this.af = this._pop();
          else this._setRP(rp, this._pop(), ixy);
          return ixy && rp === 2 ? 14 : 10;
        }
        switch (y >> 1) {
          case 0: this.pc = this._pop(); return 10; // RET
          case 1: // EXX
            [this.b, this.b_] = [this.b_, this.b]; [this.c, this.c_] = [this.c_, this.c];
            [this.d, this.d_] = [this.d_, this.d]; [this.e, this.e_] = [this.e_, this.e];
            [this.h, this.h_] = [this.h_, this.h]; [this.l, this.l_] = [this.l_, this.l];
            return 4;
          case 2: this.pc = this._getRP(2, ixy); return ixy ? 8 : 4; // JP (HL)
          default: this.sp = this._getRP(2, ixy); return ixy ? 10 : 6; // LD SP,HL
        }
      case 2: { // JP cc,nn
        const nn = this._fetch16();
        if (this._cond(y)) this.pc = nn;
        return 10;
      }
      case 3:
        switch (y) {
          case 0: this.pc = this._fetch16(); return 10; // JP nn
          case 2: this.bus.out(((this.a << 8) | this._fetch()) & 0xffff, this.a); return 11; // OUT (n),A
          case 3: this.a = this.bus.in(((this.a << 8) | this._fetch()) & 0xffff) & 0xff; return 11; // IN A,(n)
          case 4: { // EX (SP),HL
            const v = this._rd16(this.sp);
            this._wr16(this.sp, this._getRP(2, ixy));
            this._setRP(2, v, ixy);
            return ixy ? 23 : 19;
          }
          case 5: { const t = this.de; this.de = this.hl; this.hl = t; return 4; } // EX DE,HL (never prefixed)
          case 6: this.iff1 = this.iff2 = false; this._eiDelay = 0; return 4; // DI
          default: this._eiDelay = 2; return 4; // EI (takes effect after next op)
        }
      case 4: { // CALL cc,nn
        const nn = this._fetch16();
        if (this._cond(y)) { this._push(this.pc); this.pc = nn; return 17; }
        return 10;
      }
      case 5:
        if (!(y & 1)) { // PUSH rp2
          const rp = y >> 1;
          this._push(rp === 3 ? this.af : this._getRP(rp, ixy));
          return ixy && rp === 2 ? 15 : 11;
        }
        // y odd: only y=1 CALL nn reaches here (3,5,7 are DD/ED/FD prefixes)
        { const nn = this._fetch16(); this._push(this.pc); this.pc = nn; return 17; }
      case 6: this._alu(y, this._fetch()); return 7; // ALU A,n
      default: this._push(this.pc); this.pc = y << 3; return 11; // RST
    }
  }

  _execCB(ixy) {
    let ea = null, op;
    if (ixy) { // DDCB d op: displacement precedes the opcode
      ea = (this[ixy] + sign8(this._fetch())) & 0xffff;
      op = this._fetch();
    } else {
      op = this._fetch();
      this._bumpR();
    }
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    const getR = (i) => {
      if (ixy) return this._rd(ea); // prefixed CB always operates on memory
      switch (i) {
        case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
        case 4: return this.h; case 5: return this.l; case 6: return this._rd(this.hl);
        default: return this.a;
      }
    };
    const setR = (i, v) => {
      v &= 0xff;
      if (ixy) {
        this._wr(ea, v);
        if (i !== 6) this._setPlain(i, v); // undocumented: result copied to register
        return;
      }
      if (i === 6) this._wr(this.hl, v);
      else this._setPlain(i, v);
    };
    if (x === 0) { setR(z, this._rot(y, getR(z))); return ixy ? 23 : z === 6 ? 15 : 8; }
    const v = getR(z), bit = 1 << y;
    if (x === 1) { // BIT y,r
      const res = v & bit;
      this.f = (this.f & FC) | FH | (res === 0 ? (FZ | FP) : 0)
        | (res & FS) | (v & (F5 | F3));
      return ixy ? 20 : z === 6 ? 12 : 8;
    }
    setR(z, x === 2 ? v & ~bit : v | bit); // RES / SET
    return ixy ? 23 : z === 6 ? 15 : 8;
  }

  _setPlain(i, v) {
    switch (i) {
      case 0: this.b = v; break; case 1: this.c = v; break;
      case 2: this.d = v; break; case 3: this.e = v; break;
      case 4: this.h = v; break; case 5: this.l = v; break;
      default: this.a = v; break;
    }
  }

  _execED() {
    const op = this._fetch();
    this._bumpR();
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    if (x === 1) {
      switch (z) {
        case 0: { // IN r,(C)
          const v = this.bus.in(this.bc) & 0xff;
          if (y !== 6) this._setPlain(y, v);
          this.f = (this.f & FC) | SZP[v];
          return 12;
        }
        case 1: this.bus.out(this.bc, y === 6 ? 0 : this._getPlain(y)); return 12; // OUT (C),r
        case 2: { // SBC/ADC HL,rp
          const rp = this._getRP(y >> 1, null);
          this.hl = y & 1 ? this._adc16(this.hl, rp) : this._sbc16(this.hl, rp);
          return 15;
        }
        case 3: { // LD (nn),rp / LD rp,(nn)
          const nn = this._fetch16();
          if (y & 1) this._setRP(y >> 1, this._rd16(nn), null);
          else this._wr16(nn, this._getRP(y >> 1, null));
          return 20;
        }
        case 4: { // NEG
          const a = this.a; this.a = 0; this._sub8(a, 0); return 8;
        }
        case 5: this.pc = this._pop(); if (y !== 1) this.iff1 = this.iff2; return 14; // RETN/RETI
        case 6: this.im = y & 3 ? (y & 3) - 1 : 0; return 8; // IM 0/1/2 (y: 0,2,3 → 0,1,2)
        default:
          switch (y) {
            case 0: this.i = this.a; return 9; // LD I,A
            case 1: this.r = this.a; return 9; // LD R,A
            case 2: this.a = this.i; // LD A,I
              this.f = (this.f & FC) | SZP[this.a] & ~FP | (this.iff2 ? FP : 0);
              return 9;
            case 3: this.a = this.r; // LD A,R
              this.f = (this.f & FC) | SZP[this.a] & ~FP | (this.iff2 ? FP : 0);
              return 9;
            case 4: { // RRD
              const m = this._rd(this.hl);
              this._wr(this.hl, ((this.a << 4) | (m >> 4)) & 0xff);
              this.a = (this.a & 0xf0) | (m & 0x0f);
              this.f = (this.f & FC) | SZP[this.a];
              return 18;
            }
            case 5: { // RLD
              const m = this._rd(this.hl);
              this._wr(this.hl, ((m << 4) | (this.a & 0x0f)) & 0xff);
              this.a = (this.a & 0xf0) | (m >> 4);
              this.f = (this.f & FC) | SZP[this.a];
              return 18;
            }
            default: return 8; // ED NOP
          }
      }
    }
    if (x === 2 && z <= 3 && y >= 4) { // block instructions
      const delta = (y & 1) ? -1 : 1; // LDI/LDD by bit 3
      const repeat = y >= 6;
      switch (z) {
        case 0: { // LDI/LDD/LDIR/LDDR
          const v = this._rd(this.hl);
          this._wr(this.de, v);
          this.hl = (this.hl + delta) & 0xffff;
          this.de = (this.de + delta) & 0xffff;
          this.bc = (this.bc - 1) & 0xffff;
          const n = (this.a + v) & 0xff;
          this.f = (this.f & (FS | FZ | FC)) | (this.bc !== 0 ? FP : 0)
            | (n & F3) | ((n & 0x02) ? F5 : 0);
          if (repeat && this.bc !== 0) { this.pc = (this.pc - 2) & 0xffff; return 21; }
          return 16;
        }
        case 1: { // CPI/CPD/CPIR/CPDR
          const v = this._rd(this.hl);
          const res = (this.a - v) & 0xff;
          const hc = (this.a ^ v ^ res) & FH;
          this.hl = (this.hl + delta) & 0xffff;
          this.bc = (this.bc - 1) & 0xffff;
          const n = (res - (hc ? 1 : 0)) & 0xff;
          this.f = (this.f & FC) | FN | (res & FS) | (res === 0 ? FZ : 0) | hc
            | (this.bc !== 0 ? FP : 0) | (n & F3) | ((n & 0x02) ? F5 : 0);
          if (repeat && this.bc !== 0 && res !== 0) { this.pc = (this.pc - 2) & 0xffff; return 21; }
          return 16;
        }
        case 2: { // INI/IND/INIR/INDR
          const v = this.bus.in(this.bc) & 0xff;
          this._wr(this.hl, v);
          this.hl = (this.hl + delta) & 0xffff;
          this.b = (this.b - 1) & 0xff;
          this.f = (this.b === 0 ? FZ : 0) | FN | (this.b & (FS | F5 | F3));
          if (repeat && this.b !== 0) { this.pc = (this.pc - 2) & 0xffff; return 21; }
          return 16;
        }
        default: { // OUTI/OUTD/OTIR/OTDR
          const v = this._rd(this.hl);
          this.b = (this.b - 1) & 0xff;
          this.bus.out(this.bc, v);
          this.hl = (this.hl + delta) & 0xffff;
          this.f = (this.b === 0 ? FZ : 0) | FN | (this.b & (FS | F5 | F3));
          if (repeat && this.b !== 0) { this.pc = (this.pc - 2) & 0xffff; return 21; }
          return 16;
        }
      }
    }
    return 8; // remaining ED holes: NOP
  }

  _getPlain(i) {
    switch (i) {
      case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
      case 4: return this.h; case 5: return this.l; default: return this.a;
    }
  }
}

export function createZ80(bus) {
  return new Z80(bus);
}
