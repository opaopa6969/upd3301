// m68000 — Motorola MC68000 (68EC000) CPU core. Pure JS, zero deps, deterministic.
//
// The 16/32-bit half of this collection: the Mega Drive and the X68000 both
// hang off a 68000, so the chip is written once, machine-agnostically, and
// both machines inject their own bus. Nothing in here knows about VDP
// registers, sprite tables or floppy controllers.
//
// Coverage: the complete 68000 instruction set (no 68010+ additions — RTD,
// MOVEC, MOVES, BKPT and friends decode to the illegal-instruction vector,
// which is what a real 68000 does), all 12 addressing modes, and the full
// exception model: reset, bus error, address error (odd word/long access),
// illegal instruction, line-A/line-F emulator traps, divide by zero, CHK,
// TRAPV, privilege violation, TRAP #n, trace, and the seven interrupt levels
// with autovectoring.
//
// The bus is injected: { read8(a), write8(a,v), read16(a), write16(a,v) }.
// The real chip has a 16-bit data bus with UDS/LDS byte strobes and a 24-bit
// address bus, so 32-bit accesses are split into two 16-bit ones (high word
// first) and byte accesses are a single strobed cycle — hardware with
// side-effecting registers sees exactly the transaction count it would see on
// silicon. Addresses handed to the bus are masked to 24 bits; registers keep
// all 32. read32/write32 may be supplied to skip the split when the target is
// plain RAM. A bus that only implements the 16-bit pair gets byte accessors
// synthesized (read-modify-write on the containing word).
//
// step() executes one instruction and returns its clock periods, using the
// timing tables from the M68000 User's Manual (Appendix E) — instructions are
// not cycle-stepped internally. Multiply and divide are data-dependent and
// modelled per the published bit-counting algorithms.
//
// Suite contract: no Math.random, same program + same bus → identical state.
// snapshot() returns plain data with schemaVersion and holds no ROM — the
// host's rewind ring buffer stores one of these per frame, so every byte of
// immutable data in here is rewind seconds thrown away.

export const SCHEMA_VERSION = 1;

// ---- sizes ----------------------------------------------------------------
// Size codes are 0=byte, 1=word, 2=long throughout; the opcode field ordering
// differs per instruction group and is normalized at decode time.
const MASK = [0xff, 0xffff, 0xffffffff];
const MSB = [0x80, 0x8000, 0x80000000];
const BYTES = [1, 2, 4];

const sign8 = (v) => (v << 24) >> 24;
const sign16 = (v) => (v << 16) >> 16;
const signSize = (v, size) => (size === 0 ? sign8(v) : size === 1 ? sign16(v) : v | 0);

// ---- vectors ---------------------------------------------------------------
export const VEC = {
  RESET_SSP: 0, RESET_PC: 1, BUS_ERROR: 2, ADDRESS_ERROR: 3, ILLEGAL: 4,
  ZERO_DIVIDE: 5, CHK: 6, TRAPV: 7, PRIVILEGE: 8, TRACE: 9,
  LINE_A: 10, LINE_F: 11, UNINITIALIZED: 15, SPURIOUS: 24,
  AUTOVECTOR: 25, // +level-1
  TRAP: 32, // +n
};

// Thrown by a bus callback to signal /BERR. The core turns it into a bus-error
// exception with the 68000's seven-word group-0 stack frame.
export class BusError extends Error {
  constructor(addr, write = false) {
    super(`bus error at ${(addr >>> 0).toString(16)}`);
    this.addr = addr >>> 0;
    this.write = !!write;
  }
}

// Internal unwind marker for address errors. Instructions abort mid-flight, so
// side effects already committed (predecrements, partial MOVEM) stay committed
// — that is the real chip's behaviour and why the group-0 frame is "unsafe to
// resume" on a 68000.
const FAULT = Symbol('m68kFault');

// ---- effective-address timing (User's Manual table E-1) --------------------
// Cost of *computing* the address, added on top of an instruction's base time.
function eaCycles(mode, reg, size) {
  const l = size === 2;
  switch (mode) {
    case 0: case 1: return 0;
    case 2: return l ? 8 : 4;
    case 3: return l ? 8 : 4;
    case 4: return l ? 10 : 6;
    case 5: return l ? 12 : 8;
    case 6: return l ? 14 : 10;
    case 7:
      switch (reg) {
        case 0: return l ? 12 : 8;
        case 1: return l ? 16 : 12;
        case 2: return l ? 12 : 8;
        case 3: return l ? 14 : 10;
        case 4: return l ? 8 : 4;
        default: return 0;
      }
    default: return 0;
  }
}

// MOVE's destination is cheaper than the same mode used as a source: there is
// no read cycle and -(An)'s predecrement overlaps the write. Hence the split
// table (E-2 in the manual reads as a matrix; it factors into src + dst).
function eaWriteCycles(mode, reg, size) {
  const l = size === 2;
  switch (mode) {
    case 0: case 1: return 0;
    case 2: case 3: case 4: return l ? 8 : 4;
    case 5: return l ? 12 : 8;
    case 6: return l ? 14 : 10;
    case 7: return reg === 0 ? (l ? 12 : 8) : (l ? 16 : 12);
    default: return 0;
  }
}

// ---- addressing-mode legality ---------------------------------------------
// The 68000 rejects illegal mode/register combinations at decode time with the
// illegal-instruction vector rather than doing something undefined, so the
// decoder has to know each instruction's permitted mode class.
const isData = (m, r) => m !== 1 && (m !== 7 || r <= 4);
const isMemory = (m) => m >= 2;
const isAlterable = (m, r) => m !== 7 || r <= 1;
const isDataAlterable = (m, r) => m !== 1 && (m !== 7 || r <= 1);
const isMemAlterable = (m, r) => m >= 2 && (m !== 7 || r <= 1);
const isControl = (m, r) => (m === 2 || m === 5 || m === 6) || (m === 7 && r <= 3);
const isControlAlterable = (m, r) => (m === 2 || m === 5 || m === 6) || (m === 7 && r <= 1);
// MOVEM to memory also allows -(An); MOVEM from memory also allows (An)+.
const isMovemDst = (m, r) => m === 4 || isControlAlterable(m, r);
const isMovemSrc = (m, r) => m === 3 || isControl(m, r);

// ---- multiply/divide timing ------------------------------------------------
// MULU costs 38 + 2 per set bit of the source word; MULS counts 0->1 and 1->0
// transitions in (src<<1) instead, because the microcode Booth-encodes.
function mulu_cycles(src) {
  let n = 0;
  for (let v = src & 0xffff; v; v >>= 1) n += v & 1;
  return 38 + 2 * n;
}

function muls_cycles(src) {
  const t = (src & 0xffff) << 1;
  let n = 0;
  for (let i = 0; i < 16; i++) { const b = (t >> i) & 3; if (b === 1 || b === 2) n++; }
  return 38 + 2 * n;
}

// DIVU/DIVS are the only instructions whose time depends on the *values*: the
// microcode runs a restoring-division loop and skips work when it can. These
// follow the published half-cycle models (Musashi's getDiv*68kCycles).
function divu_cycles(dividend, divisor) {
  if (divisor === 0) return 0;
  if ((dividend >>> 16) >= divisor) return 10; // overflow bails out early
  let mc = 108;
  const hdiv = (divisor << 16) >>> 0;
  let dd = dividend >>> 0;
  for (let i = 0; i < 15; i++) {
    const temp = dd;
    dd = (dd << 1) >>> 0;
    if ((temp | 0) < 0) {
      dd = (dd - hdiv) >>> 0;
    } else {
      mc += 2;
      if (dd >= hdiv) { dd = (dd - hdiv) >>> 0; mc--; }
    }
  }
  return mc * 2 - 140; // half-cycle accumulator, biased to the 76..140 range
}

function divs_cycles(dividend, divisor) {
  if (divisor === 0) return 0;
  let mc = 6;
  const sdd = dividend | 0, sdv = sign16(divisor);
  if (sdd < 0) mc++;
  const adv = Math.abs(sdv), add = Math.abs(sdd) >>> 0;
  if ((add >>> 16) >= adv) return (mc + 2) * 2;
  let quotient = Math.floor(add / adv) >>> 0;
  mc += 55;
  if (sdv >= 0) {
    if (sdd >= 0) mc++; else mc += 2;
  }
  // one extra half-cycle per leading/embedded zero bit of the quotient
  for (let i = 0; i < 15; i++) {
    if (sign16(quotient) >= 0) mc++;
    quotient = (quotient << 1) >>> 0;
  }
  return mc * 2;
}

export class M68000 {
  constructor(bus, opts = {}) {
    this.bus = normalizeBus(bus);
    // Mega Drive's 68000 has TAS's read-modify-write write phase disconnected
    // from the bus; the machine sets this false rather than the core guessing.
    this.tasWriteBack = opts.tasWriteBack !== false;
    this.d = new Uint32Array(8);
    this.a = new Uint32Array(8);
    this._usp = 0; this._ssp = 0;
    this.pc = 0; this.ppc = 0;
    this.sr_t = 0; this.sr_s = 1; this.sr_ipm = 7;
    this.fx = 0; this.fn = 0; this.fz = 0; this.fv = 0; this.fc = 0;
    this.stopped = false;
    this.halted = false;
    this.irq = 0;
    this._irqPrev = 0;
    this.cycles = 0;
    this._traceLatch = 0;
    this._tracePending = 0;
    this._faultIR = 0;
    this._inGroupZero = false;
    this._pendReg = -1; this._pendVal = 0;
    this._eaProg = false; this._eaPredec = false;
    this.lastFault = null;
    this.reset();
  }

  // Hardware reset: SSP from vector 0, PC from vector 1. That means the bus has
  // to be able to answer before this runs — a machine that maps ROM later can
  // simply call reset() again once it has.
  reset() {
    this.d.fill(0);
    this.a.fill(0);
    this.sr_t = 0; this.sr_s = 1; this.sr_ipm = 7;
    this.fx = this.fn = this.fz = this.fv = this.fc = 0;
    this.stopped = false; this.halted = false;
    this.irq = 0; this._irqPrev = 0;
    this._traceLatch = 0; this._tracePending = 0;
    this._pendReg = -1;
    this._usp = 0; this._ssp = 0;
    try {
      this.a[7] = this._ssp = this._r32(0);
      this.pc = this._r32(4);
    } catch {
      // A bus that faults during reset means "no vectors yet"; leave zeros.
      this.a[7] = 0; this.pc = 0;
    }
    this.ppc = this.pc;
    return this;
  }

  // ---- stack pointers -------------------------------------------------------
  // A7 always holds the *active* stack pointer; the inactive one lives in the
  // shadow. Consumers read .usp/.ssp and get the logical value either way.
  get usp() { return this.sr_s ? this._usp : this.a[7]; }
  set usp(v) { if (this.sr_s) this._usp = v >>> 0; else this.a[7] = v; }
  get ssp() { return this.sr_s ? this.a[7] : this._ssp; }
  set ssp(v) { if (this.sr_s) this.a[7] = v; else this._ssp = v >>> 0; }

  _setS(v) {
    v = v ? 1 : 0;
    if (v === this.sr_s) return;
    if (this.sr_s) { this._ssp = this.a[7]; this.a[7] = this._usp; }
    else { this._usp = this.a[7]; this.a[7] = this._ssp; }
    this.sr_s = v;
  }

  // ---- status register -------------------------------------------------------
  getCCR() {
    return (this.fx << 4) | (this.fn << 3) | (this.fz << 2) | (this.fv << 1) | this.fc;
  }

  setCCR(v) {
    this.fx = (v >> 4) & 1; this.fn = (v >> 3) & 1; this.fz = (v >> 2) & 1;
    this.fv = (v >> 1) & 1; this.fc = v & 1;
  }

  getSR() {
    return ((this.sr_t << 15) | (this.sr_s << 13) | (this.sr_ipm << 8) | this.getCCR()) & 0xffff;
  }

  // Writing SR can swap stack pointers, so it goes through _setS.
  setSR(v) {
    this.sr_t = (v >> 15) & 1;
    this.sr_ipm = (v >> 8) & 7;
    this._setS((v >> 13) & 1);
    this.setCCR(v & 0x1f);
  }

  // ---- snapshot --------------------------------------------------------------
  // Plain data only, and deliberately nothing derived from ROM: the demo host
  // keeps a ring of these for rewind, so size here is measured in seconds of
  // history. Exact inverse pair with restore().
  snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      d: Array.from(this.d),
      a: Array.from(this.a),
      usp: this.usp, ssp: this.ssp,
      pc: this.pc >>> 0, ppc: this.ppc >>> 0,
      sr: this.getSR(),
      stopped: this.stopped, halted: this.halted,
      irq: this.irq, irqPrev: this._irqPrev,
      traceLatch: this._traceLatch, tracePending: this._tracePending,
      cycles: this.cycles,
    };
  }

  restore(s) {
    for (let i = 0; i < 8; i++) { this.d[i] = s.d[i]; this.a[i] = s.a[i]; }
    // Raw field writes, not setSR(): the stacks are already where they belong.
    this.sr_t = (s.sr >> 15) & 1;
    this.sr_s = (s.sr >> 13) & 1;
    this.sr_ipm = (s.sr >> 8) & 7;
    this.setCCR(s.sr & 0x1f);
    this._usp = s.usp >>> 0; this._ssp = s.ssp >>> 0;
    this.pc = s.pc >>> 0; this.ppc = (s.ppc ?? s.pc) >>> 0;
    this.stopped = !!s.stopped; this.halted = !!s.halted;
    this.irq = s.irq | 0; this._irqPrev = s.irqPrev | 0;
    this._traceLatch = s.traceLatch | 0;
    this._tracePending = s.tracePending | 0;
    this.cycles = s.cycles ?? 0;
    return this;
  }

  // z80.js spells the pair getState/setState; keep both names so machine code
  // written against either chip reads the same.
  getState() { return this.snapshot(); }
  setState(s) { return this.restore(s); }

  // ---- memory ----------------------------------------------------------------
  // A 68000 has no A0 pin: word and long accesses to an odd address never even
  // start, they fault. Byte accesses pick UDS or LDS and are always legal.
  _r8(a) { const v = this.bus.read8(a & 0xffffff) & 0xff; this._commit(); return v; }
  _w8(a, v) { this.bus.write8(a & 0xffffff, v & 0xff); this._commit(); }

  _r16(a) {
    if (a & 1) this._addrError(a, true, this._eaProg);
    const v = this.bus.read16(a & 0xffffff) & 0xffff;
    this._commit();
    return v;
  }

  _w16(a, v) {
    if (a & 1) this._addrError(a, false, this._eaProg);
    this.bus.write16(a & 0xffffff, v & 0xffff);
    this._commit();
  }

  // A long operand reached through -(An) is transferred low word first: the
  // address register walks down in two steps, so the second half of the operand
  // is touched before the first. Programs never notice, but memory-mapped
  // hardware and the address-error frame both do.
  _r32(a) {
    if (this._eaPredec) {
      if (a & 1) this._addrError((a + 2) >>> 0, true, this._eaProg);
      const lo = this.bus.read16((a + 2) & 0xffffff) & 0xffff;
      const hi = this.bus.read16(a & 0xffffff) & 0xffff;
      this._commit();
      return ((hi << 16) | lo) >>> 0;
    }
    if (a & 1) this._addrError(a, true, this._eaProg);
    const v = this.bus.read32(a >>> 0);
    this._commit();
    return v;
  }

  _w32(a, v) {
    if (this._eaPredec) {
      if (a & 1) this._addrError((a + 2) >>> 0, false, this._eaProg);
      this.bus.write16((a + 2) & 0xffffff, v & 0xffff);
      this.bus.write16(a & 0xffffff, (v >>> 16) & 0xffff);
      this._commit();
      return;
    }
    if (a & 1) this._addrError(a, false, this._eaProg);
    this.bus.write32(a >>> 0, v >>> 0);
    this._commit();
  }

  _read(a, size) {
    return size === 0 ? this._r8(a) : size === 1 ? this._r16(a) : this._r32(a);
  }

  _write(a, v, size) {
    if (size === 0) this._w8(a, v); else if (size === 1) this._w16(a, v); else this._w32(a, v);
  }

  _addrError(addr, read, instruction, stackPC) {
    // Drop any pending address-register write-back: the access never completed,
    // and the exception frame's own stack writes must not commit it by accident.
    this._pendReg = -1;
    throw { [FAULT]: 'address', addr: addr >>> 0, read, instruction, stackPC };
  }

  // Every control transfer is followed immediately by a prefetch, so an odd
  // target faults inside the branch itself rather than at the next step(). The
  // frame then reports the target as both the access address and the PC.
  // stackPC differs per instruction because the microcode commits the new PC
  // at different points: a taken branch has already replaced it, while JMP and
  // the return instructions still hold the old one when the prefetch faults.
  _jump(addr, stackPC = addr) {
    addr >>>= 0;
    this.pc = addr;
    if (addr & 1) this._addrError(addr, true, true, stackPC >>> 0);
  }

  // ---- fetch -----------------------------------------------------------------
  _fetchWord() {
    const pc = this.pc;
    if (pc & 1) this._addrError(pc, true, true, pc);
    this.pc = (pc + 2) >>> 0;
    return this.bus.read16(pc & 0xffffff) & 0xffff;
  }

  _fetchLong() {
    const hi = this._fetchWord();
    return ((hi << 16) | this._fetchWord()) >>> 0;
  }

  _imm(size) {
    if (size === 2) return this._fetchLong();
    const w = this._fetchWord();
    return size === 0 ? (w & 0xff) : w;
  }

  // ---- stack -----------------------------------------------------------------
  _pushW(v) { this._eaProg = false; this._eaPredec = false; this.a[7] = (this.a[7] - 2) >>> 0; this._w16(this.a[7], v); }
  _pushL(v) { this._eaProg = false; this._eaPredec = false; this.a[7] = (this.a[7] - 4) >>> 0; this._w32(this.a[7], v); }
  _popW() { this._eaProg = false; this._eaPredec = false; const v = this._r16(this.a[7]); this.a[7] = (this.a[7] + 2) >>> 0; return v; }
  _popL() { this._eaProg = false; this._eaPredec = false; const v = this._r32(this.a[7]); this.a[7] = (this.a[7] + 4) >>> 0; return v; }

  // ---- effective address ------------------------------------------------------
  _indexEA(base) {
    const ext = this._fetchWord();
    const ri = (ext >> 12) & 7;
    const rv = (ext & 0x8000) ? this.a[ri] : this.d[ri];
    // Bit 11 picks the index register's width; the 68000 has no scale field, so
    // bits 10-9 are simply ignored (68020 reads them).
    const idx = (ext & 0x800) ? (rv | 0) : sign16(rv & 0xffff);
    return (base + idx + sign8(ext & 0xff)) >>> 0;
  }

  // A long access is two bus cycles with the address-register write-back after
  // both, so an address error leaves the pointer untouched. Byte and word
  // accesses update the register in the same cycle and stay committed even when
  // the access aborts — the distinction is visible in the exception frame.
  _defer(reg, val) { this._pendReg = reg; this._pendVal = val >>> 0; }

  _commit() {
    if (this._pendReg >= 0) { this.a[this._pendReg] = this._pendVal; this._pendReg = -1; }
  }

  // Read-modify-write destinations (CLR, NEG, NOT, TAS, the Dn-to-memory ALU
  // forms...) commit the address register before touching memory and walk a
  // long operand high word first — the opposite of a plain operand fetch.
  _eaRMW(mode, reg, size) {
    const ea = this._ea(mode, reg, size);
    this._commit();
    this._eaPredec = false;
    return ea;
  }

  _ea(mode, reg, size) {
    // A7 keeps the stack word-aligned, so byte pushes/pops still move it by 2.
    const step = (reg === 7 && size === 0) ? 2 : BYTES[size];
    // PC-relative operands are fetched from program space; the function code in
    // an address-error frame has to say so.
    this._eaProg = mode === 7 && (reg === 2 || reg === 3);
    this._eaPredec = mode === 4;
    switch (mode) {
      case 2: return this.a[reg];
      case 3: {
        const a = this.a[reg];
        if (size === 2) this._defer(reg, a + step); else this.a[reg] = a + step;
        return a;
      }
      case 4: {
        const a = (this.a[reg] - step) >>> 0;
        if (size === 2) this._defer(reg, a); else this.a[reg] = a;
        return a;
      }
      case 5: return (this.a[reg] + sign16(this._fetchWord())) >>> 0;
      case 6: return this._indexEA(this.a[reg]);
      case 7:
        switch (reg) {
          case 0: return sign16(this._fetchWord()) >>> 0; // (xxx).W sign-extends
          case 1: return this._fetchLong();
          case 2: { const base = this.pc; return (base + sign16(this._fetchWord())) >>> 0; }
          case 3: { const base = this.pc; return this._indexEA(base); }
          default: return 0;
        }
      default: return 0;
    }
  }

  // Read an operand through any mode, including the register-direct and
  // immediate forms that have no address at all.
  _readEA(mode, reg, size) {
    if (mode === 0) return size === 2 ? this.d[reg] : (this.d[reg] & MASK[size]);
    if (mode === 1) return size === 2 ? this.a[reg] : (this.a[reg] & MASK[size]);
    if (mode === 7 && reg === 4) return this._imm(size);
    return this._read(this._ea(mode, reg, size), size);
  }

  _setD(reg, v, size) {
    if (size === 2) this.d[reg] = v;
    else this.d[reg] = (this.d[reg] & ~MASK[size]) | (v & MASK[size]);
  }

  _writeEA(mode, reg, size, v) {
    if (mode === 0) this._setD(reg, v, size);
    else if (mode === 1) this.a[reg] = signSize(v, size);
    else this._write(this._ea(mode, reg, size), v, size);
  }

  // ---- flag helpers -------------------------------------------------------------
  _logic(res, size) {
    res = size === 2 ? res >>> 0 : (res & MASK[size]);
    this.fn = (res & MSB[size]) ? 1 : 0;
    this.fz = res === 0 ? 1 : 0;
    this.fv = 0; this.fc = 0;
    return res;
  }

  _add(d, s, size, x = 0) {
    const m = MASK[size], msb = MSB[size];
    const sum = d + s + x;
    const res = size === 2 ? (sum >>> 0) : (sum & m);
    this.fc = this.fx = sum > m ? 1 : 0;
    this.fv = ((~(d ^ s) & (d ^ res)) & msb) ? 1 : 0;
    this.fn = (res & msb) ? 1 : 0;
    this.fz = res === 0 ? 1 : 0;
    return res;
  }

  _sub(d, s, size, x = 0) {
    const m = MASK[size], msb = MSB[size];
    const diff = d - s - x;
    const res = size === 2 ? (diff >>> 0) : (diff & m);
    this.fc = this.fx = diff < 0 ? 1 : 0;
    this.fv = (((d ^ s) & (d ^ res)) & msb) ? 1 : 0;
    this.fn = (res & msb) ? 1 : 0;
    this.fz = res === 0 ? 1 : 0;
    return res;
  }

  // CMP is SUB without the store and, crucially, without touching X.
  _cmp(d, s, size) {
    const x = this.fx;
    const res = this._sub(d, s, size);
    this.fx = x;
    return res;
  }

  // ADDX/SUBX/NEGX leave Z alone when the result is zero: that is what makes
  // multi-precision chains report "all words were zero" correctly.
  _addx(d, s, size) {
    const z = this.fz;
    const res = this._add(d, s, size, this.fx);
    if (res !== 0) this.fz = 0; else this.fz = z;
    return res;
  }

  _subx(d, s, size) {
    const z = this.fz;
    const res = this._sub(d, s, size, this.fx);
    if (res !== 0) this.fz = 0; else this.fz = z;
    return res;
  }

  // ---- BCD ------------------------------------------------------------------
  // Binary add then decimal correct, exactly like the microcode: feeding it
  // non-BCD nibbles reproduces the chip's "undefined" results rather than
  // asserting. N and V are formally undefined here; the values computed match
  // what the silicon leaves behind.
  // Binary add, then correct the digits that overflowed. The decisive detail:
  // the tens correction is decided from the *uncorrected* sum, so 4A + 4A + X
  // gives 9B with no carry rather than rolling over — the naive "corrected > 99"
  // test gets that wrong.
  _abcd(d, s) {
    const sum = d + s + this.fx;
    const binary = sum & 0xff;
    let res = binary;
    if (((d & 0x0f) + (s & 0x0f) + this.fx) > 9) res = (res + 6) & 0xff;
    const c = sum > 0x99 ? 1 : 0;
    if (c) res = (res + 0x60) & 0xff;
    this.fc = this.fx = c;
    // V is "undefined" in the manual; the silicon reports the sign flip the
    // decimal correction introduced, which is what a reference core dumps.
    this.fv = ((~binary & res) & 0x80) ? 1 : 0;
    this.fn = (res & 0x80) ? 1 : 0;
    if (res !== 0) this.fz = 0;
    return res;
  }

  _sbcd(d, s) {
    // Straight binary subtract, then subtract 6 from the digit that borrowed
    // and 0x60 from the byte that borrowed. The subtlety the naive version gets
    // wrong: the -6 correction can itself borrow out of bit 7, and that also
    // sets carry (e.g. B2 - AD = 05, corrected to FF with C set).
    const binary = (d - s - this.fx) & 0xff;
    const borrowLow = ((d & 0x0f) - (s & 0x0f) - this.fx) < 0;
    const borrow = (d - s - this.fx) < 0;
    let res = binary;
    let c = borrow ? 1 : 0;
    if (borrowLow) { if (res < 6) c = 1; res = (res - 6) & 0xff; }
    if (borrow) res = (res - 0x60) & 0xff;
    this.fc = this.fx = c;
    this.fv = ((binary & ~res) & 0x80) ? 1 : 0;
    this.fn = (res & 0x80) ? 1 : 0;
    if (res !== 0) this.fz = 0;
    return res;
  }

  // ---- conditions ------------------------------------------------------------
  _cond(c) {
    switch (c) {
      case 0: return true;                            // T
      case 1: return false;                           // F
      case 2: return !this.fc && !this.fz;            // HI
      case 3: return !!(this.fc || this.fz);          // LS
      case 4: return !this.fc;                        // CC
      case 5: return !!this.fc;                       // CS
      case 6: return !this.fz;                        // NE
      case 7: return !!this.fz;                       // EQ
      case 8: return !this.fv;                        // VC
      case 9: return !!this.fv;                       // VS
      case 10: return !this.fn;                       // PL
      case 11: return !!this.fn;                      // MI
      case 12: return this.fn === this.fv;            // GE
      case 13: return this.fn !== this.fv;            // LT
      case 14: return !this.fz && this.fn === this.fv; // GT
      default: return !!this.fz || this.fn !== this.fv; // LE
    }
  }

  // ---- exceptions ------------------------------------------------------------
  // Normal (group 1/2) frame: SR then PC, i.e. SP-6 with SR at SP+0.
  _exception(vector, pc = this.pc) {
    const oldSR = this.getSR();
    this._setS(1);
    this.sr_t = 0;
    this._traceLatch = 0; this._tracePending = 0;
    this.stopped = false;
    this._pushL(pc);
    this._pushW(oldSR);
    this.pc = this._r32(vector * 4);
    return this;
  }

  // Group 0 (bus error / address error) frame: seven words, with a special
  // status word describing the faulting access. The 68000 cannot resume from
  // it; a fault while writing this frame halts the CPU (double bus fault).
  _groupZero(vector, fault) {
    if (this._inGroupZero) { this.halted = true; this._inGroupZero = false; return 50; }
    this._inGroupZero = true;
    const oldSR = this.getSR();
    const wasSuper = this.sr_s;
    this._setS(1);
    this.sr_t = 0;
    this._traceLatch = 0; this._tracePending = 0;
    this.stopped = false;
    // Function code as the pins would have driven it: FC2 = supervisor,
    // FC1:0 = 10 program / 01 data. The upper eleven SSW bits are formally
    // undefined; real silicon leaves the instruction register there, so that is
    // what a reference 68000 dumps and what we reproduce.
    const fc = (wasSuper ? 4 : 0) | (fault.instruction ? 2 : 1);
    const ssw = (this._faultIR & 0xffe0) | (fault.read ? 0x10 : 0) | fc;
    // Handy for machine-level debugging (and for the reference comparison):
    // what aborted, where, and which way. Cleared at the top of every step().
    this.lastFault = { vector, addr: fault.addr, read: !!fault.read, ssw };
    // The stacked PC is documented as unpredictable — two to six bytes past the
    // start of the instruction, depending on how far the prefetch had run. A
    // faulting instruction fetch stacks the target itself; for data faults we
    // stack the common case: one word past the opcode for a read, two for a
    // write (the write happens later, so one more prefetch has landed).
    const stackPC = fault.stackPC !== undefined
      ? fault.stackPC >>> 0
      : (this.ppc + (fault.read ? 2 : 4)) >>> 0;
    try {
      this._pushL(stackPC);
      this._pushW(oldSR);
      this._pushW(this._faultIR);
      this._pushL(fault.addr);
      this._pushW(ssw);
      this.pc = this._r32(vector * 4);
    } catch {
      this.halted = true;
      this._inGroupZero = false;
      return 50;
    }
    this._inGroupZero = false;
    return 50;
  }

  // Raise an interrupt line. 0 means "no request". Level 7 is edge-triggered on
  // real hardware (it is the NMI), so it only fires on a transition — otherwise
  // a device that parks the line high would loop forever.
  setIRQ(level) { this.irq = level & 7; return this; }

  _checkIRQ() {
    const level = this.irq;
    if (level === 0) return 0;
    const take = level === 7 ? this._irqPrev !== 7 : level > this.sr_ipm;
    this._irqPrev = level;
    if (!take) return 0;
    // A peripheral may answer the acknowledge cycle with its own vector;
    // returning nothing (or a negative) means it asserted VPA -> autovector.
    let vector = this.bus.irqAck ? this.bus.irqAck(level) : -1;
    if (vector === undefined || vector === null || vector < 0) vector = VEC.AUTOVECTOR + level - 1;
    this.stopped = false;
    this._exception(vector, this.pc);
    this.sr_ipm = level;
    return 44;
  }

  // ---- execution ---------------------------------------------------------------
  step() {
    if (this.halted) return 4;
    // A traced instruction runs to completion first; the exception is taken at
    // the top of the next execution slot, ahead of any pending interrupt.
    if (this._tracePending) {
      this._tracePending = 0;
      this.ppc = this.pc;
      try { this._exception(VEC.TRACE); } catch (e) {
        if (e && e[FAULT] === 'address') return this._groupZero(VEC.ADDRESS_ERROR, e);
        throw e;
      }
      this.cycles += 34;
      return 34;
    }
    const intCycles = this._checkIRQ();
    if (intCycles) { this.cycles += intCycles; return intCycles; }
    if (this.stopped) { this.cycles += 4; return 4; }

    // The trace bit is latched before the instruction: changing T inside the
    // instruction (a MOVE to SR, say) must not retroactively trace it.
    this._traceLatch = this.sr_t;
    this._pendReg = -1;
    this._eaProg = false; this._eaPredec = false;
    this.lastFault = null;
    this.ppc = this.pc;
    let cyc;
    try {
      const op = this._fetchWord();
      this._faultIR = op;
      cyc = OPTABLE[op](this, op);
    } catch (e) {
      if (e && e[FAULT] === 'address') { cyc = this._groupZero(VEC.ADDRESS_ERROR, e); }
      else if (e instanceof BusError) {
        cyc = this._groupZero(VEC.BUS_ERROR, { addr: e.addr, read: !e.write, instruction: false });
      } else throw e;
      this.cycles += cyc;
      return cyc;
    }
    if (this._traceLatch) { this._traceLatch = 0; this._tracePending = 1; }
    this.cycles += cyc;
    return cyc;
  }

  // Run for at least `cycles` clock periods; returns the number actually run.
  run(cycles) {
    let t = 0;
    while (t < cycles) t += this.step();
    return t;
  }

  // Raise one of the internally-generated exceptions from a handler. Kept as a
  // method so instruction handlers stay short.
  _trap(vector, pc = this.pc) { this._exception(vector, pc); }
}

// ---------------------------------------------------------------------------
// Bus normalization: the 16-bit pair is the mandatory contract because that is
// what the pins do; everything else is synthesized so a plain RAM array is a
// two-line bus.
// ---------------------------------------------------------------------------
// The caller's object is never mutated — the resolved callbacks live on the CPU
// so a class-based bus keeps its own `this`.
function normalizeBus(bus) {
  if (!bus || typeof bus.read16 !== 'function' || typeof bus.write16 !== 'function') {
    throw new Error('m68000: bus must provide read16(a) and write16(a, v)');
  }
  const r16 = (a) => bus.read16(a), w16 = (a, v) => bus.write16(a, v);
  return {
    src: bus,
    read16: r16,
    write16: w16,
    read8: typeof bus.read8 === 'function'
      ? (a) => bus.read8(a)
      : (a) => (a & 1) ? (r16(a & ~1) & 0xff) : ((r16(a) >> 8) & 0xff),
    write8: typeof bus.write8 === 'function'
      ? (a, v) => bus.write8(a, v)
      : (a, v) => {
        const wa = a & ~1, w = r16(wa);
        w16(wa, (a & 1) ? ((w & 0xff00) | (v & 0xff)) : ((w & 0x00ff) | ((v & 0xff) << 8)));
      },
    read32: typeof bus.read32 === 'function'
      ? (a) => bus.read32(a) >>> 0
      : (a) => ((r16(a & 0xffffff) << 16) | r16((a + 2) & 0xffffff)) >>> 0,
    write32: typeof bus.write32 === 'function'
      ? (a, v) => bus.write32(a, v)
      : (a, v) => { w16(a & 0xffffff, (v >>> 16) & 0xffff); w16((a + 2) & 0xffffff, v & 0xffff); },
    irqAck: typeof bus.irqAck === 'function' ? (l) => bus.irqAck(l) : null,
    resetLine: typeof bus.resetLine === 'function' ? () => bus.resetLine() : null,
  };
}

// ===========================================================================
// Instruction handlers. Each takes (cpu, op) and returns clock periods.
// They are shared across all opcodes that decode to the same form; the decoder
// below maps every one of the 65536 opcode words onto one of them exactly once.
// ===========================================================================

function ILLEGAL(cpu) { cpu._trap(VEC.ILLEGAL, cpu.ppc); return 34; }
function LINE_A(cpu) { cpu._trap(VEC.LINE_A, cpu.ppc); return 34; }
function LINE_F(cpu) { cpu._trap(VEC.LINE_F, cpu.ppc); return 34; }
function PRIV(cpu) { cpu._trap(VEC.PRIVILEGE, cpu.ppc); return 34; }

// ---- MOVE / MOVEA ----------------------------------------------------------
function op_move(cpu, op) {
  const size = [0, 0, 2, 1][(op >> 12) & 3];
  const sm = (op >> 3) & 7, sr = op & 7;
  const dm = (op >> 6) & 7, dr = (op >> 9) & 7;
  const v = cpu._readEA(sm, sr, size);
  // A long store is two word cycles and the condition codes are updated as the
  // words go out: if the destination faults, the flags reflect only the low
  // word. Register destinations settle in one go.
  if (size === 2 && dm >= 2) cpu._logic(v & 0xffff, 1); else cpu._logic(v, size);
  cpu._writeEA(dm, dr, size, v);
  if (size === 2 && dm >= 2) cpu._logic(v, size);
  return 4 + eaCycles(sm, sr, size) + eaWriteCycles(dm, dr, size);
}

function op_movea(cpu, op) {
  const size = ((op >> 12) & 3) === 2 ? 2 : 1;
  const sm = (op >> 3) & 7, sr = op & 7, dr = (op >> 9) & 7;
  const v = cpu._readEA(sm, sr, size);
  cpu.a[dr] = signSize(v, size);
  return 4 + eaCycles(sm, sr, size);
}

// ---- immediate group (ORI/ANDI/SUBI/ADDI/EORI/CMPI) ------------------------
function immOp(kind) {
  return function (cpu, op) {
    const size = (op >> 6) & 3;
    const mode = (op >> 3) & 7, reg = op & 7;
    const src = cpu._imm(size);
    let cyc;
    if (mode === 0) {
      const dst = size === 2 ? cpu.d[reg] : (cpu.d[reg] & MASK[size]);
      const res = applyALU(cpu, kind, dst, src, size);
      if (kind !== 'cmp') cpu._setD(reg, res, size);
      // CMPI.L against a register costs two more than the others.
      cyc = kind === 'cmp' ? (size === 2 ? 14 : 8) : (size === 2 ? 16 : 8);
    } else {
      const ea = cpu._eaRMW(mode, reg, size);
      const dst = cpu._read(ea, size);
      const res = applyALU(cpu, kind, dst, src, size);
      if (kind !== 'cmp') cpu._write(ea, res, size);
      cyc = (kind === 'cmp' ? (size === 2 ? 12 : 8) : (size === 2 ? 20 : 12)) + eaCycles(mode, reg, size);
    }
    return cyc;
  };
}

function applyALU(cpu, kind, dst, src, size) {
  switch (kind) {
    case 'or': return cpu._logic(dst | src, size);
    case 'and': return cpu._logic(dst & src, size);
    case 'eor': return cpu._logic(dst ^ src, size);
    case 'add': return cpu._add(dst, src, size);
    case 'sub': return cpu._sub(dst, src, size);
    default: return cpu._cmp(dst, src, size); // 'cmp'
  }
}

// ORI/ANDI/EORI to CCR and to SR. The SR forms are privileged; the CCR forms
// are not, which is how user code flips X without a supervisor call.
function op_toCCR(kind) {
  return function (cpu) {
    const v = cpu._imm(1) & 0xff;
    const ccr = cpu.getCCR();
    cpu.setCCR(kind === 'or' ? (ccr | v) : kind === 'and' ? (ccr & v) : (ccr ^ v));
    return 20;
  };
}

function op_toSR(kind) {
  return function (cpu) {
    if (!cpu.sr_s) { cpu.pc = cpu.ppc; return PRIV(cpu); }
    const v = cpu._imm(1);
    const sr = cpu.getSR();
    cpu.setSR(kind === 'or' ? (sr | v) : kind === 'and' ? (sr & v) : (sr ^ v));
    return 20;
  };
}

// ---- bit manipulation --------------------------------------------------------
// Bit number is taken mod 32 on a data register and mod 8 in memory: the
// operand size follows the destination, not the instruction.
function bitOp(kind, staticBit) {
  return function (cpu, op) {
    const mode = (op >> 3) & 7, reg = op & 7;
    let bit;
    if (staticBit) bit = cpu._fetchWord() & 0xff;
    else bit = cpu.d[(op >> 9) & 7];
    let cyc;
    if (mode === 0) {
      bit &= 31;
      const v = cpu.d[reg];
      cpu.fz = (v & (1 << bit)) ? 0 : 1;
      if (kind !== 'btst') {
        const nv = kind === 'bchg' ? (v ^ (1 << bit)) : kind === 'bclr' ? (v & ~(1 << bit)) : (v | (1 << bit));
        cpu.d[reg] = nv;
      }
      // A long (register) bit operation costs two more when the bit lives in
      // the upper half — the shifter has to walk there. BTST is the exception:
      // it only reads, so its time does not depend on the bit number.
      const hi = bit > 15 && kind !== 'btst' ? 2 : 0;
      cyc = hi + (staticBit
        ? (kind === 'btst' ? 10 : kind === 'bclr' ? 12 : 10)
        : (kind === 'btst' ? 6 : kind === 'bclr' ? 8 : 6));
    } else {
      bit &= 7;
      const ea = (mode === 7 && reg === 4) ? -1 : cpu._ea(mode, reg, 0);
      const v = ea < 0 ? cpu._imm(0) : cpu._r8(ea);
      cpu.fz = (v & (1 << bit)) ? 0 : 1;
      if (kind !== 'btst') {
        const nv = kind === 'bchg' ? (v ^ (1 << bit)) : kind === 'bclr' ? (v & ~(1 << bit)) : (v | (1 << bit));
        cpu._w8(ea, nv);
      }
      // BTST Dn,#<data> is the one bit form that reads an immediate operand;
      // the extra word costs two beyond the plain effective-address time.
      const immSrc = kind === 'btst' && !staticBit && mode === 7 && reg === 4 ? 2 : 0;
      cyc = immSrc + (staticBit ? (kind === 'btst' ? 8 : 12) : (kind === 'btst' ? 4 : 8))
        + eaCycles(mode, reg, 0);
    }
    return cyc;
  };
}

// ---- MOVEP -------------------------------------------------------------------
// Built for 8-bit peripherals wired to one half of the data bus: every other
// byte of memory is skipped.
function op_movep(cpu, op) {
  const dreg = (op >> 9) & 7, areg = op & 7;
  const dir = (op >> 7) & 1; // 0: memory->register
  const size = (op >> 6) & 1; // 0: word, 1: long
  let ea = (cpu.a[areg] + sign16(cpu._fetchWord())) >>> 0;
  if (dir === 0) {
    let v = 0;
    const n = size ? 4 : 2;
    for (let i = 0; i < n; i++) { v = ((v << 8) | cpu._r8(ea)) >>> 0; ea = (ea + 2) >>> 0; }
    if (size) cpu.d[dreg] = v; else cpu._setD(dreg, v, 1);
    return size ? 24 : 16;
  }
  const v = cpu.d[dreg];
  const n = size ? 4 : 2;
  for (let i = 0; i < n; i++) {
    cpu._w8(ea, (v >>> ((n - 1 - i) * 8)) & 0xff);
    ea = (ea + 2) >>> 0;
  }
  return size ? 24 : 16;
}

// ---- ALU: <ea> op Dn and Dn op <ea> ------------------------------------------
function aluEaDn(kind) {
  return function (cpu, op) {
    const size = (op >> 6) & 3;
    const dn = (op >> 9) & 7;
    const mode = (op >> 3) & 7, reg = op & 7;
    const src = cpu._readEA(mode, reg, size);
    const dst = size === 2 ? cpu.d[dn] : (cpu.d[dn] & MASK[size]);
    const res = applyALU(cpu, kind, dst, src, size);
    if (kind !== 'cmp') cpu._setD(dn, res, size);
    // The long form is two cycles slower when the source needs no memory read —
    // except CMP, which is a flat six.
    const regOrImm = mode === 0 || mode === 1 || (mode === 7 && reg === 4);
    const base = size === 2 ? ((kind !== 'cmp' && regOrImm) ? 8 : 6) : 4;
    return base + eaCycles(mode, reg, size);
  };
}

function aluDnEa(kind) {
  return function (cpu, op) {
    const size = (op >> 6) & 3;
    const dn = (op >> 9) & 7;
    const mode = (op >> 3) & 7, reg = op & 7;
    const src = size === 2 ? cpu.d[dn] : (cpu.d[dn] & MASK[size]);
    if (mode === 0) { // only EOR reaches here with a register destination
      const dst = size === 2 ? cpu.d[reg] : (cpu.d[reg] & MASK[size]);
      cpu._setD(reg, applyALU(cpu, kind, dst, src, size), size);
      return size === 2 ? 8 : 4;
    }
    const ea = cpu._eaRMW(mode, reg, size);
    const dst = cpu._read(ea, size);
    cpu._write(ea, applyALU(cpu, kind, dst, src, size), size);
    return (size === 2 ? 12 : 8) + eaCycles(mode, reg, size);
  };
}

// ADDA/SUBA/CMPA always operate on the full 32 bits and never touch the flags
// (CMPA does set them, but the address register itself is never truncated).
function op_adda(cpu, op) {
  const size = ((op >> 6) & 7) === 3 ? 1 : 2;
  const an = (op >> 9) & 7, mode = (op >> 3) & 7, reg = op & 7;
  const src = signSize(cpu._readEA(mode, reg, size), size);
  cpu.a[an] = cpu.a[an] + src;
  const base = size === 1 ? 8 : ((mode === 0 || mode === 1 || (mode === 7 && reg === 4)) ? 8 : 6);
  return base + eaCycles(mode, reg, size);
}

function op_suba(cpu, op) {
  const size = ((op >> 6) & 7) === 3 ? 1 : 2;
  const an = (op >> 9) & 7, mode = (op >> 3) & 7, reg = op & 7;
  const src = signSize(cpu._readEA(mode, reg, size), size);
  cpu.a[an] = cpu.a[an] - src;
  const base = size === 1 ? 8 : ((mode === 0 || mode === 1 || (mode === 7 && reg === 4)) ? 8 : 6);
  return base + eaCycles(mode, reg, size);
}

function op_cmpa(cpu, op) {
  const size = ((op >> 6) & 7) === 3 ? 1 : 2;
  const an = (op >> 9) & 7, mode = (op >> 3) & 7, reg = op & 7;
  const src = signSize(cpu._readEA(mode, reg, size), size) >>> 0;
  cpu._cmp(cpu.a[an], src, 2);
  return 6 + eaCycles(mode, reg, size);
}

// ---- ADDX/SUBX ---------------------------------------------------------------
function xOp(sub) {
  return function (cpu, op) {
    const size = (op >> 6) & 3;
    const rx = (op >> 9) & 7, ry = op & 7;
    if ((op & 8) === 0) { // register to register
      const s = size === 2 ? cpu.d[ry] : (cpu.d[ry] & MASK[size]);
      const d = size === 2 ? cpu.d[rx] : (cpu.d[rx] & MASK[size]);
      cpu._setD(rx, sub ? cpu._subx(d, s, size) : cpu._addx(d, s, size), size);
      return size === 2 ? 8 : 4;
    }
    // -(Ay),-(Ax): both operands predecrement, source first.
    const sa = cpu._ea(4, ry, size);
    const s = cpu._read(sa, size);
    const da = cpu._ea(4, rx, size);
    const d = cpu._read(da, size);
    cpu._write(da, sub ? cpu._subx(d, s, size) : cpu._addx(d, s, size), size);
    return size === 2 ? 30 : 18;
  };
}

// ---- CMPM ---------------------------------------------------------------------
function op_cmpm(cpu, op) {
  const size = (op >> 6) & 3;
  const ax = (op >> 9) & 7, ay = op & 7;
  const s = cpu._read(cpu._ea(3, ay, size), size);
  // The second pointer is written back after the compare, so a faulting read
  // leaves it alone even at byte/word size.
  const da = cpu.a[ax];
  cpu._defer(ax, da + ((ax === 7 && size === 0) ? 2 : BYTES[size]));
  const d = cpu._read(da, size);
  cpu._cmp(d, s, size);
  return size === 2 ? 20 : 12;
}

// ---- ABCD/SBCD -----------------------------------------------------------------
function bcdOp(sub) {
  return function (cpu, op) {
    const rx = (op >> 9) & 7, ry = op & 7;
    if ((op & 8) === 0) {
      const s = cpu.d[ry] & 0xff, d = cpu.d[rx] & 0xff;
      cpu._setD(rx, sub ? cpu._sbcd(d, s) : cpu._abcd(d, s), 0);
      return 6;
    }
    const s = cpu._r8(cpu._ea(4, ry, 0));
    const da = cpu._ea(4, rx, 0);
    const d = cpu._r8(da);
    cpu._w8(da, sub ? cpu._sbcd(d, s) : cpu._abcd(d, s));
    return 18;
  };
}

function op_nbcd(cpu, op) {
  const mode = (op >> 3) & 7, reg = op & 7;
  if (mode === 0) {
    cpu._setD(reg, cpu._sbcd(0, cpu.d[reg] & 0xff), 0);
    return 6;
  }
  const ea = cpu._eaRMW(mode, reg, 0);
  cpu._w8(ea, cpu._sbcd(0, cpu._r8(ea)));
  return 8 + eaCycles(mode, reg, 0);
}

// ---- MUL/DIV --------------------------------------------------------------------
function op_mulu(cpu, op) {
  const dn = (op >> 9) & 7, mode = (op >> 3) & 7, reg = op & 7;
  const src = cpu._readEA(mode, reg, 1) & 0xffff;
  const res = ((cpu.d[dn] & 0xffff) * src) >>> 0;
  cpu.d[dn] = res;
  cpu._logic(res, 2);
  return mulu_cycles(src) + eaCycles(mode, reg, 1);
}

function op_muls(cpu, op) {
  const dn = (op >> 9) & 7, mode = (op >> 3) & 7, reg = op & 7;
  const src = cpu._readEA(mode, reg, 1) & 0xffff;
  const res = (sign16(cpu.d[dn] & 0xffff) * sign16(src)) >>> 0;
  cpu.d[dn] = res;
  cpu._logic(res, 2);
  return muls_cycles(src) + eaCycles(mode, reg, 1);
}

function op_divu(cpu, op) {
  const dn = (op >> 9) & 7, mode = (op >> 3) & 7, reg = op & 7;
  const src = cpu._readEA(mode, reg, 1) & 0xffff;
  const ea = eaCycles(mode, reg, 1);
  if (src === 0) {
    // The 68000 stacks the address of the *next* instruction for zero divide.
    cpu.fc = 0;
    cpu._trap(VEC.ZERO_DIVIDE);
    return 38 + ea;
  }
  const dst = cpu.d[dn] >>> 0;
  const cyc = divu_cycles(dst, src) + ea;
  const quot = Math.floor(dst / src);
  // Overflow: the quotient is left alone and the flags say "too big".
  if (quot > 0xffff) { cpu.fn = 1; cpu.fz = 0; cpu.fv = 1; cpu.fc = 0; return cyc; }
  const rem = dst % src;
  cpu.d[dn] = ((rem << 16) | quot) >>> 0;
  cpu.fn = (quot & 0x8000) ? 1 : 0;
  cpu.fz = quot === 0 ? 1 : 0;
  cpu.fv = 0; cpu.fc = 0;
  return cyc;
}

function op_divs(cpu, op) {
  const dn = (op >> 9) & 7, mode = (op >> 3) & 7, reg = op & 7;
  const src = cpu._readEA(mode, reg, 1) & 0xffff;
  const ea = eaCycles(mode, reg, 1);
  if (src === 0) {
    cpu.fc = 0;
    cpu._trap(VEC.ZERO_DIVIDE);
    return 38 + ea;
  }
  const dst = cpu.d[dn] | 0, sv = sign16(src);
  const cyc = divs_cycles(dst, src) + ea;
  // Truncation toward zero; the remainder takes the dividend's sign.
  const quot = Math.trunc(dst / sv);
  if (quot > 32767 || quot < -32768) { cpu.fn = 1; cpu.fz = 0; cpu.fv = 1; cpu.fc = 0; return cyc; }
  const rem = dst % sv;
  cpu.d[dn] = (((rem & 0xffff) << 16) | (quot & 0xffff)) >>> 0;
  cpu.fn = (quot & 0x8000) ? 1 : 0;
  cpu.fz = (quot & 0xffff) === 0 ? 1 : 0;
  cpu.fv = 0; cpu.fc = 0;
  return cyc;
}

// ---- single-operand ---------------------------------------------------------------
function unary(kind) {
  return function (cpu, op) {
    const size = (op >> 6) & 3;
    const mode = (op >> 3) & 7, reg = op & 7;
    if (mode === 0) {
      const v = size === 2 ? cpu.d[reg] : (cpu.d[reg] & MASK[size]);
      cpu._setD(reg, unaryValue(cpu, kind, v, size), size);
      return size === 2 ? 6 : 4;
    }
    const ea = cpu._eaRMW(mode, reg, size);
    cpu._write(ea, unaryValue(cpu, kind, cpu._read(ea, size), size), size);
    return (size === 2 ? 12 : 8) + eaCycles(mode, reg, size);
  };
}

function unaryValue(cpu, kind, v, size) {
  switch (kind) {
    case 'clr': return cpu._logic(0, size);
    case 'not': return cpu._logic(~v, size);
    case 'neg': return cpu._sub(0, v, size);
    default: { // negx
      const z = cpu.fz;
      const res = cpu._sub(0, v, size, cpu.fx);
      if (res !== 0) cpu.fz = 0; else cpu.fz = z;
      return res;
    }
  }
}

function op_tst(cpu, op) {
  const size = (op >> 6) & 3;
  const mode = (op >> 3) & 7, reg = op & 7;
  cpu._logic(cpu._readEA(mode, reg, size), size);
  return 4 + eaCycles(mode, reg, size);
}

// TAS is the 68000's atomic primitive: an indivisible read-modify-write.
function op_tas(cpu, op) {
  const mode = (op >> 3) & 7, reg = op & 7;
  if (mode === 0) {
    const v = cpu.d[reg] & 0xff;
    cpu._logic(v, 0);
    cpu._setD(reg, v | 0x80, 0);
    return 4;
  }
  const ea = cpu._eaRMW(mode, reg, 0);
  const v = cpu._r8(ea);
  cpu._logic(v, 0);
  if (cpu.tasWriteBack) cpu._w8(ea, v | 0x80);
  return 14 + eaCycles(mode, reg, 0);
}

// ---- shifts and rotates -------------------------------------------------------
// Register forms take a count of 0-63; memory forms shift one bit of one word.
function shiftValue(cpu, type, left, v, count, size) {
  const m = MASK[size], msb = MSB[size];
  v = size === 2 ? v >>> 0 : (v & m);
  let res = v, carry = 0, overflow = 0;
  if (type === 0) { // arithmetic
    if (left) {
      // V is set if the sign bit ever changes during the shift, not just at
      // the end — that is the whole point of ASL's overflow detection.
      for (let i = 0; i < count; i++) {
        carry = (res & msb) ? 1 : 0;
        const next = size === 2 ? ((res << 1) >>> 0) : ((res << 1) & m);
        if (((next ^ res) & msb) !== 0) overflow = 1;
        res = next;
      }
      if (count === 0) carry = 0;
    } else {
      for (let i = 0; i < count; i++) {
        carry = res & 1;
        res = size === 2 ? ((res >> 1) | (res & msb)) >>> 0 : ((res >> 1) | (res & msb)) & m;
      }
      if (count === 0) carry = 0;
    }
  } else if (type === 1) { // logical
    if (left) {
      for (let i = 0; i < count; i++) {
        carry = (res & msb) ? 1 : 0;
        res = size === 2 ? ((res << 1) >>> 0) : ((res << 1) & m);
      }
    } else {
      for (let i = 0; i < count; i++) { carry = res & 1; res = res >>> 1; }
    }
    if (count === 0) carry = 0;
  } else if (type === 2) { // rotate through X (17/33-bit rotate)
    let x = cpu.fx;
    for (let i = 0; i < count; i++) {
      if (left) {
        const nx = (res & msb) ? 1 : 0;
        res = size === 2 ? (((res << 1) >>> 0) | x) >>> 0 : (((res << 1) | x) & m);
        x = nx;
      } else {
        const nx = res & 1;
        res = size === 2 ? ((res >>> 1) | (x ? msb : 0)) >>> 0 : ((res >>> 1) | (x ? msb : 0)) & m;
        x = nx;
      }
    }
    cpu.fx = x;
    carry = x;
  } else { // plain rotate: X is untouched
    for (let i = 0; i < count; i++) {
      if (left) {
        carry = (res & msb) ? 1 : 0;
        res = size === 2 ? (((res << 1) >>> 0) | carry) >>> 0 : (((res << 1) | carry) & m);
      } else {
        carry = res & 1;
        res = size === 2 ? ((res >>> 1) | (carry ? msb : 0)) >>> 0 : ((res >>> 1) | (carry ? msb : 0)) & m;
      }
    }
    if (count === 0) carry = 0;
  }
  res = size === 2 ? res >>> 0 : (res & m);
  cpu.fn = (res & msb) ? 1 : 0;
  cpu.fz = res === 0 ? 1 : 0;
  cpu.fv = overflow;
  cpu.fc = carry;
  // A zero-count shift leaves X alone; a non-zero one copies C into it. ROXL/
  // ROXR (type 2) already wrote X above, and ROL/ROR (type 3) never touch it.
  if (count !== 0 && type < 2) cpu.fx = carry;
  return res;
}

function op_shift_reg(cpu, op) {
  const size = (op >> 6) & 3;
  const left = (op >> 8) & 1;
  const ir = (op >> 5) & 1;
  const type = (op >> 3) & 3;
  const reg = op & 7;
  // Immediate counts encode 8 as 0; register counts are taken modulo 64.
  let count = (op >> 9) & 7;
  count = ir ? (cpu.d[count] & 63) : (count === 0 ? 8 : count);
  const v = size === 2 ? cpu.d[reg] : (cpu.d[reg] & MASK[size]);
  cpu._setD(reg, shiftValue(cpu, type, left, v, count, size), size);
  return (size === 2 ? 8 : 6) + 2 * count;
}

function op_shift_mem(cpu, op) {
  const left = (op >> 8) & 1;
  const type = (op >> 9) & 3;
  const mode = (op >> 3) & 7, reg = op & 7;
  const ea = cpu._eaRMW(mode, reg, 1);
  cpu._w16(ea, shiftValue(cpu, type, left, cpu._r16(ea), 1, 1));
  return 8 + eaCycles(mode, reg, 1);
}

// ---- ADDQ/SUBQ ------------------------------------------------------------------
function quickOp(sub) {
  return function (cpu, op) {
    const size = (op >> 6) & 3;
    let data = (op >> 9) & 7;
    if (data === 0) data = 8;
    const mode = (op >> 3) & 7, reg = op & 7;
    if (mode === 1) {
      // Address-register destination: always a full 32-bit operation, no flags.
      cpu.a[reg] = sub ? (cpu.a[reg] - data) : (cpu.a[reg] + data);
      return 8;
    }
    if (mode === 0) {
      const dst = size === 2 ? cpu.d[reg] : (cpu.d[reg] & MASK[size]);
      cpu._setD(reg, sub ? cpu._sub(dst, data, size) : cpu._add(dst, data, size), size);
      return size === 2 ? 8 : 4;
    }
    const ea = cpu._eaRMW(mode, reg, size);
    const dst = cpu._read(ea, size);
    cpu._write(ea, sub ? cpu._sub(dst, data, size) : cpu._add(dst, data, size), size);
    return (size === 2 ? 12 : 8) + eaCycles(mode, reg, size);
  };
}

// ---- Scc / DBcc / Bcc -------------------------------------------------------------
function op_scc(cpu, op) {
  const cond = (op >> 8) & 0xf;
  const mode = (op >> 3) & 7, reg = op & 7;
  const t = cpu._cond(cond);
  if (mode === 0) {
    cpu._setD(reg, t ? 0xff : 0x00, 0);
    return t ? 6 : 4;
  }
  cpu._w8(cpu._eaRMW(mode, reg, 0), t ? 0xff : 0x00);
  return 8 + eaCycles(mode, reg, 0);
}

// DBcc is a loop primitive: it exits when the condition is met OR the counter
// runs past zero, which is why the counter test is against -1 and not 0.
function op_dbcc(cpu, op) {
  const cond = (op >> 8) & 0xf, reg = op & 7;
  const base = cpu.pc;
  const disp = sign16(cpu._fetchWord());
  if (cpu._cond(cond)) return 12;
  const next = (cpu.d[reg] - 1) & 0xffff;
  if (next === 0xffff) { cpu._setD(reg, next, 1); return 14; }
  // The counter write-back happens after the branch prefetch, so an odd target
  // leaves the loop counter untouched.
  const target = (base + disp) >>> 0;
  if (target & 1) cpu._addrError(target, true, true, cpu.pc);
  cpu._setD(reg, next, 1);
  cpu.pc = target;
  return 10;
}

function op_bcc(cpu, op) {
  const cond = (op >> 8) & 0xf;
  let disp = op & 0xff;
  const base = cpu.pc;
  let word = false;
  if (disp === 0) { disp = sign16(cpu._fetchWord()); word = true; }
  else disp = sign8(disp);
  if (cond === 1) { // BSR
    cpu._pushL(cpu.pc);
    cpu._jump(base + disp);
    return 18;
  }
  if (cond === 0 || cpu._cond(cond)) {
    cpu._jump(base + disp, cpu.ppc + 2);
    return 10;
  }
  return word ? 12 : 8;
}

function op_moveq(cpu, op) {
  const v = sign8(op & 0xff) >>> 0;
  cpu.d[(op >> 9) & 7] = v;
  cpu._logic(v, 2);
  return 4;
}

// ---- MOVEM ---------------------------------------------------------------------
// The register mask runs D0..A7 by bit, except for -(An), where the hardware
// walks the mask backwards so registers land in memory in descending order.
function op_movem(cpu, op) {
  const toMem = ((op >> 10) & 1) === 0;
  const size = ((op >> 6) & 1) ? 2 : 1;
  const bytes = BYTES[size];
  const mask = cpu._fetchWord();
  const mode = (op >> 3) & 7, reg = op & 7;
  let n = 0;

  if (toMem) {
    if (mode === 4) {
      let ea = cpu.a[reg];
      for (let i = 0; i < 16; i++) {
        if (!(mask & (1 << i))) continue;
        const ri = 15 - i;
        // The base register, if listed, is stored with its pre-decrement value.
        const v = ri < 8 ? cpu.d[ri] : cpu.a[ri - 8];
        ea = (ea - bytes) >>> 0;
        if (size === 2) cpu._w32(ea, v); else cpu._w16(ea, v & 0xffff);
        n++;
      }
      cpu.a[reg] = ea;
      return (size === 2 ? 8 + 8 * n : 8 + 4 * n) + movemEaCycles(mode, reg);
    }
    let ea = cpu._ea(mode, reg, size);
    for (let i = 0; i < 16; i++) {
      if (!(mask & (1 << i))) continue;
      const v = i < 8 ? cpu.d[i] : cpu.a[i - 8];
      if (size === 2) cpu._w32(ea, v); else cpu._w16(ea, v & 0xffff);
      ea = (ea + bytes) >>> 0;
      n++;
    }
    return (size === 2 ? 8 + 8 * n : 8 + 4 * n) + movemEaCycles(mode, reg);
  }

  // memory -> registers; word transfers are sign-extended to the full 32 bits
  let ea = mode === 3 ? cpu.a[reg] : cpu._ea(mode, reg, size);
  for (let i = 0; i < 16; i++) {
    if (!(mask & (1 << i))) continue;
    const v = size === 2 ? cpu._r32(ea) : (sign16(cpu._r16(ea)) >>> 0);
    if (i < 8) cpu.d[i] = v; else cpu.a[i - 8] = v;
    ea = (ea + bytes) >>> 0;
    n++;
  }
  if (mode === 3) cpu.a[reg] = ea;
  return (size === 2 ? 12 + 8 * n : 12 + 4 * n) + movemEaCycles(mode, reg);
}

// MOVEM's own address-mode surcharge; the base times above already include the
// (An) case, so this is the delta from there.
function movemEaCycles(mode, reg) {
  switch (mode) {
    case 2: case 3: case 4: return 0;
    case 5: return 4;
    case 6: return 6;
    case 7: return reg === 0 ? 4 : reg === 1 ? 8 : reg === 2 ? 4 : 6;
    default: return 0;
  }
}

// ---- LEA/PEA/JMP/JSR ------------------------------------------------------------
function op_lea(cpu, op) {
  const an = (op >> 9) & 7, mode = (op >> 3) & 7, reg = op & 7;
  cpu.a[an] = cpu._ea(mode, reg, 2);
  return leaCycles(mode, reg);
}

function leaCycles(mode, reg) {
  switch (mode) {
    case 2: return 4;
    case 5: return 8;
    case 6: return 12;
    case 7: return reg === 0 ? 8 : reg === 1 ? 12 : reg === 2 ? 8 : 12;
    default: return 4;
  }
}

function op_pea(cpu, op) {
  const mode = (op >> 3) & 7, reg = op & 7;
  const ea = cpu._ea(mode, reg, 2);
  cpu._pushL(ea);
  return 8 + leaCycles(mode, reg);
}

function op_jmp(cpu, op) {
  const mode = (op >> 3) & 7, reg = op & 7;
  cpu._jump(cpu._ea(mode, reg, 2), cpu.ppc + 2);
  return jmpCycles(mode, reg);
}

function jmpCycles(mode, reg) {
  switch (mode) {
    case 2: return 8;
    case 5: return 10;
    case 6: return 14;
    case 7: return reg === 0 ? 10 : reg === 1 ? 12 : reg === 2 ? 10 : 14;
    default: return 8;
  }
}

function op_jsr(cpu, op) {
  const mode = (op >> 3) & 7, reg = op & 7;
  const ea = cpu._ea(mode, reg, 2);
  const ret = cpu.pc;
  // JSR prefetches the target before it pushes: an odd target leaves the stack
  // untouched, unlike BSR which has already committed the return address.
  cpu._jump(ea, ret);
  cpu._pushL(ret);
  return jmpCycles(mode, reg) + 8;
}

// ---- CHK ---------------------------------------------------------------------
function op_chk(cpu, op) {
  const dn = (op >> 9) & 7, mode = (op >> 3) & 7, reg = op & 7;
  const bound = sign16(cpu._readEA(mode, reg, 1));
  const v = sign16(cpu.d[dn] & 0xffff);
  const ea = eaCycles(mode, reg, 1);
  // The manual calls N "set if Dn < 0, undefined otherwise"; the silicon simply
  // reports the sign of Dn on every path, trap or not.
  cpu.fz = (v & 0xffff) === 0 ? 1 : 0;
  cpu.fv = 0; cpu.fc = 0;
  cpu.fn = v < 0 ? 1 : 0;
  if (v < 0 || v > bound) { cpu._trap(VEC.CHK); return 38 + ea; }
  return 10 + ea;
}

// ---- misc control -------------------------------------------------------------
function op_ext(cpu, op) {
  const reg = op & 7;
  if (((op >> 6) & 7) === 2) { // EXT.W: byte -> word
    const v = sign8(cpu.d[reg] & 0xff) & 0xffff;
    cpu._setD(reg, v, 1);
    cpu._logic(v, 1);
  } else { // EXT.L: word -> long
    const v = sign16(cpu.d[reg] & 0xffff) >>> 0;
    cpu.d[reg] = v;
    cpu._logic(v, 2);
  }
  return 4;
}

function op_swap(cpu, op) {
  const reg = op & 7;
  const v = ((cpu.d[reg] >>> 16) | (cpu.d[reg] << 16)) >>> 0;
  cpu.d[reg] = v;
  cpu._logic(v, 2);
  return 4;
}

function op_exg(cpu, op) {
  const rx = (op >> 9) & 7, ry = op & 7;
  switch ((op >> 3) & 0x1f) {
    case 0x08: { const t = cpu.d[rx]; cpu.d[rx] = cpu.d[ry]; cpu.d[ry] = t; break; }
    case 0x09: { const t = cpu.a[rx]; cpu.a[rx] = cpu.a[ry]; cpu.a[ry] = t; break; }
    default: { const t = cpu.d[rx]; cpu.d[rx] = cpu.a[ry]; cpu.a[ry] = t; break; }
  }
  return 6;
}

function op_moveFromSR(cpu, op) {
  // Not privileged on a 68000 (the 68010 made it so); user code really can
  // read the whole SR here.
  const mode = (op >> 3) & 7, reg = op & 7;
  const sr = cpu.getSR();
  if (mode === 0) { cpu._setD(reg, sr, 1); return 6; }
  // The 68000 reads the destination before overwriting it — a real bus cycle
  // that matters both for I/O side effects and for which access faults first.
  const ea = cpu._eaRMW(mode, reg, 1);
  cpu._r16(ea);
  cpu._w16(ea, sr);
  return 8 + eaCycles(mode, reg, 1);
}

function op_moveToCCR(cpu, op) {
  const mode = (op >> 3) & 7, reg = op & 7;
  cpu.setCCR(cpu._readEA(mode, reg, 1) & 0x1f);
  return 12 + eaCycles(mode, reg, 1);
}

function op_moveToSR(cpu, op) {
  if (!cpu.sr_s) { cpu.pc = cpu.ppc; return PRIV(cpu); }
  const mode = (op >> 3) & 7, reg = op & 7;
  cpu.setSR(cpu._readEA(mode, reg, 1));
  return 12 + eaCycles(mode, reg, 1);
}

function op_moveUSP(cpu, op) {
  if (!cpu.sr_s) { cpu.pc = cpu.ppc; return PRIV(cpu); }
  const reg = op & 7;
  if ((op >> 3) & 1) cpu.a[reg] = cpu.usp; else cpu.usp = cpu.a[reg];
  return 4;
}

function op_trap(cpu, op) {
  cpu._trap(VEC.TRAP + (op & 0xf));
  return 34;
}

function op_trapv(cpu) {
  if (cpu.fv) { cpu._trap(VEC.TRAPV); return 34; }
  return 4;
}

function op_link(cpu, op) {
  const reg = op & 7;
  const disp = sign16(cpu._fetchWord());
  cpu._pushL(cpu.a[reg]);
  cpu.a[reg] = cpu.a[7];
  cpu.a[7] = cpu.a[7] + disp;
  return 16;
}

function op_unlk(cpu, op) {
  const reg = op & 7;
  const frame = cpu.a[reg];
  // Read first: on an address error the stack pointer must still point at the
  // supervisor stack, or the exception frame lands in the frame we were freeing.
  const v = cpu._r32(frame);
  cpu.a[7] = (frame + 4) >>> 0;
  cpu.a[reg] = v;
  return 12;
}

function op_rts(cpu) { cpu._jump(cpu._popL(), cpu.ppc + 2); return 16; }

function op_rtr(cpu) {
  cpu.setCCR(cpu._popW() & 0x1f);
  cpu._jump(cpu._popL(), cpu.ppc + 2);
  return 20;
}

function op_rte(cpu) {
  if (!cpu.sr_s) { cpu.pc = cpu.ppc; return PRIV(cpu); }
  const sr = cpu._popW();
  const target = cpu._popL();
  cpu.setSR(sr);
  cpu._jump(target, cpu.ppc + 2);
  return 20;
}

function op_nop() { return 4; }

function op_reset(cpu) {
  if (!cpu.sr_s) { cpu.pc = cpu.ppc; return PRIV(cpu); }
  // Asserts /RESET for 124 clocks: peripherals reset, the CPU does not.
  if (cpu.bus.resetLine) cpu.bus.resetLine();
  return 132;
}

function op_stop(cpu) {
  if (!cpu.sr_s) { cpu.pc = cpu.ppc; return PRIV(cpu); }
  const sr = cpu._fetchWord();
  cpu.setSR(sr);
  cpu.stopped = true;
  return 4;
}

// ===========================================================================
// Decoder. Runs once per opcode word at module load: 65536 entries, each
// pointing at one of the shared handlers above. Rejecting illegal addressing
// modes here (rather than inside handlers) is what makes the illegal-
// instruction vector fire exactly where the silicon fires it.
// ===========================================================================

const OP_ORI = immOp('or'), OP_ANDI = immOp('and'), OP_SUBI = immOp('sub');
const OP_ADDI = immOp('add'), OP_EORI = immOp('eor'), OP_CMPI = immOp('cmp');
const OP_OR_EA_DN = aluEaDn('or'), OP_OR_DN_EA = aluDnEa('or');
const OP_AND_EA_DN = aluEaDn('and'), OP_AND_DN_EA = aluDnEa('and');
const OP_SUB_EA_DN = aluEaDn('sub'), OP_SUB_DN_EA = aluDnEa('sub');
const OP_ADD_EA_DN = aluEaDn('add'), OP_ADD_DN_EA = aluDnEa('add');
const OP_CMP = aluEaDn('cmp'), OP_EOR = aluDnEa('eor');
const OP_ADDX = xOp(false), OP_SUBX = xOp(true);
const OP_ABCD = bcdOp(false), OP_SBCD = bcdOp(true);
const OP_ADDQ = quickOp(false), OP_SUBQ = quickOp(true);
const OP_CLR = unary('clr'), OP_NOT = unary('not'), OP_NEG = unary('neg'), OP_NEGX = unary('negx');
const OP_ORI_CCR = op_toCCR('or'), OP_ANDI_CCR = op_toCCR('and'), OP_EORI_CCR = op_toCCR('eor');
const OP_ORI_SR = op_toSR('or'), OP_ANDI_SR = op_toSR('and'), OP_EORI_SR = op_toSR('eor');

function decode(op) {
  const mode = (op >> 3) & 7, reg = op & 7;
  switch (op >> 12) {
    case 0x0: return decode0(op, mode, reg);
    case 0x1: case 0x2: case 0x3: return decodeMove(op, mode, reg);
    case 0x4: return decode4(op, mode, reg);
    case 0x5: return decode5(op, mode, reg);
    case 0x6: return op_bcc;
    case 0x7: return (op & 0x0100) ? ILLEGAL : op_moveq;
    case 0x8: return decode8(op, mode, reg);
    case 0x9: return decode9(op, mode, reg, false);
    case 0xa: return LINE_A;
    case 0xb: return decodeB(op, mode, reg);
    case 0xc: return decodeC(op, mode, reg);
    case 0xd: return decode9(op, mode, reg, true);
    case 0xe: return decodeE(op, mode, reg);
    default: return LINE_F;
  }
}

function decode0(op, mode, reg) {
  // MOVEP hides inside the dynamic-bit-op block: bit 8 set with mode 001 is
  // the only way to name an address register there, so Motorola reused it.
  if ((op & 0x0138) === 0x0108) return op_movep;

  if (op & 0x0100) { // dynamic bit ops, bit number in Dn
    const kind = ['btst', 'bchg', 'bclr', 'bset'][(op >> 6) & 3];
    if (kind === 'btst') return isData(mode, reg) ? bitOp('btst', false) : ILLEGAL;
    return isDataAlterable(mode, reg) ? bitOp(kind, false) : ILLEGAL;
  }
  if ((op & 0x0f00) === 0x0800) { // static bit ops, bit number immediate
    const kind = ['btst', 'bchg', 'bclr', 'bset'][(op >> 6) & 3];
    if (kind === 'btst') {
      // BTST #n,<ea> may read PC-relative but not immediate.
      if (mode === 1 || (mode === 7 && reg > 3)) return ILLEGAL;
      return bitOp('btst', true);
    }
    return isDataAlterable(mode, reg) ? bitOp(kind, true) : ILLEGAL;
  }

  const size = (op >> 6) & 3;
  if (size === 3) return ILLEGAL;
  const kindIdx = (op >> 9) & 7;
  const table = [
    [OP_ORI, OP_ORI_CCR, OP_ORI_SR],
    [OP_ANDI, OP_ANDI_CCR, OP_ANDI_SR],
    [OP_SUBI, null, null],
    [OP_ADDI, null, null],
    null, // 4 = static bit ops, handled above
    [OP_EORI, OP_EORI_CCR, OP_EORI_SR],
    [OP_CMPI, null, null],
    null, // 7 = MOVES (68010)
  ][kindIdx];
  if (!table) return ILLEGAL;
  if (mode === 7 && reg === 4) { // #imm,CCR / #imm,SR
    if (size === 0 && table[1]) return table[1];
    if (size === 1 && table[2]) return table[2];
    return ILLEGAL;
  }
  // CMPI's destination is read-only, so it accepts data-but-not-alterable too;
  // on a 68000 it still refuses PC-relative and immediate.
  if (kindIdx === 6) return isDataAlterable(mode, reg) ? OP_CMPI : ILLEGAL;
  return isDataAlterable(mode, reg) ? table[0] : ILLEGAL;
}

function decodeMove(op, sm, sr) {
  const sizeField = (op >> 12) & 3;
  const size = [0, 0, 2, 1][sizeField];
  const dm = (op >> 6) & 7, dr = (op >> 9) & 7;
  // MOVE.B can neither read nor write an address register.
  if (size === 0 && (sm === 1 || dm === 1)) return ILLEGAL;
  if (!isData(sm, sr) && sm !== 1) return ILLEGAL;
  if (dm === 1) return op_movea;
  if (!isDataAlterable(dm, dr)) return ILLEGAL;
  return op_move;
}

function decode4(op, mode, reg) {
  const size = (op >> 6) & 3;
  switch (op & 0x0f00) {
    case 0x0000:
      if (size === 3) return isDataAlterable(mode, reg) ? op_moveFromSR : ILLEGAL;
      return isDataAlterable(mode, reg) ? OP_NEGX : ILLEGAL;
    case 0x0200:
      if (size === 3) return ILLEGAL; // MOVE from CCR is 68010+
      return isDataAlterable(mode, reg) ? OP_CLR : ILLEGAL;
    case 0x0400:
      if (size === 3) return isData(mode, reg) ? op_moveToCCR : ILLEGAL;
      return isDataAlterable(mode, reg) ? OP_NEG : ILLEGAL;
    case 0x0600:
      if (size === 3) return isData(mode, reg) ? op_moveToSR : ILLEGAL;
      return isDataAlterable(mode, reg) ? OP_NOT : ILLEGAL;
    case 0x0800:
      switch ((op >> 6) & 3) {
        case 0: return isDataAlterable(mode, reg) ? op_nbcd : ILLEGAL;
        case 1:
          if (mode === 0) return op_swap;
          return isControl(mode, reg) ? op_pea : ILLEGAL;
        case 2:
          if (mode === 0) return op_ext;
          return isMovemDst(mode, reg) ? op_movem : ILLEGAL;
        default:
          if (mode === 0) return op_ext;
          return isMovemDst(mode, reg) ? op_movem : ILLEGAL;
      }
    case 0x0a00:
      if (op === 0x4afc) return ILLEGAL; // the architected ILLEGAL opcode
      if (size === 3) return isDataAlterable(mode, reg) ? op_tas : ILLEGAL;
      // TST on a 68000 refuses An, PC-relative and immediate destinations.
      return isDataAlterable(mode, reg) ? op_tst : ILLEGAL;
    case 0x0c00:
      if (size < 2) return ILLEGAL; // 68020 MULU.L/DIVU.L
      return isMovemSrc(mode, reg) ? op_movem : ILLEGAL;
    case 0x0e00:
      if ((op & 0x00c0) === 0x00c0) return isControl(mode, reg) ? op_jmp : ILLEGAL;
      if ((op & 0x00c0) === 0x0080) return isControl(mode, reg) ? op_jsr : ILLEGAL;
      // 0x4E00-0x4E3F is a hole; the single-word control ops start at 0x4E40.
      switch (op & 0x00f8) {
        case 0x0040: case 0x0048: return op_trap;   // TRAP #0..#15
        case 0x0050: return op_link;
        case 0x0058: return op_unlk;
        case 0x0060: case 0x0068: return op_moveUSP;
        case 0x0070:
          switch (op & 0x0007) {
            case 0: return op_reset;
            case 1: return op_nop;
            case 2: return op_stop;
            case 3: return op_rte;
            case 5: return op_rts;
            case 6: return op_trapv;
            case 7: return op_rtr;
            default: return ILLEGAL; // RTD (4) is 68010+
          }
        default: return ILLEGAL;
      }
    default: {
      // LEA and CHK share the 0x41xx..0x4fxx pattern with the register field.
      if ((op & 0x01c0) === 0x01c0) return isControl(mode, reg) ? op_lea : ILLEGAL;
      if ((op & 0x01c0) === 0x0180) return isData(mode, reg) ? op_chk : ILLEGAL;
      return ILLEGAL;
    }
  }
}

function decode5(op, mode, reg) {
  if ((op & 0x00c0) === 0x00c0) {
    if (mode === 1) return op_dbcc;
    return isDataAlterable(mode, reg) ? op_scc : ILLEGAL;
  }
  const size = (op >> 6) & 3;
  if (mode === 1 && size === 0) return ILLEGAL; // no byte ops on An
  if (!isAlterable(mode, reg) || (mode === 7 && reg > 1)) return ILLEGAL;
  return (op & 0x0100) ? OP_SUBQ : OP_ADDQ;
}

function decode8(op, mode, reg) {
  const opmode = (op >> 6) & 7;
  if (opmode === 3) return isData(mode, reg) ? op_divu : ILLEGAL;
  if (opmode === 7) return isData(mode, reg) ? op_divs : ILLEGAL;
  if (opmode < 3) return isData(mode, reg) ? OP_OR_EA_DN : ILLEGAL;
  if (opmode === 4 && (mode === 0 || mode === 1)) return OP_SBCD;
  return isMemAlterable(mode, reg) ? OP_OR_DN_EA : ILLEGAL;
}

// SUB (0x9xxx) and ADD (0xDxxx) share a layout, down to where SUBX/ADDX hide.
function decode9(op, mode, reg, isAdd) {
  const opmode = (op >> 6) & 7;
  if (opmode === 3 || opmode === 7) return isAdd ? op_adda : op_suba;
  if (opmode < 3) {
    // Byte-sized An source is illegal; word and long are fine.
    if (mode === 1 && opmode === 0) return ILLEGAL;
    return (isData(mode, reg) || mode === 1) ? (isAdd ? OP_ADD_EA_DN : OP_SUB_EA_DN) : ILLEGAL;
  }
  if (mode === 0 || mode === 1) return isAdd ? OP_ADDX : OP_SUBX;
  return isMemAlterable(mode, reg) ? (isAdd ? OP_ADD_DN_EA : OP_SUB_DN_EA) : ILLEGAL;
}

function decodeB(op, mode, reg) {
  const opmode = (op >> 6) & 7;
  if (opmode === 3 || opmode === 7) return op_cmpa;
  if (opmode < 3) {
    if (mode === 1 && opmode === 0) return ILLEGAL;
    return (isData(mode, reg) || mode === 1) ? OP_CMP : ILLEGAL;
  }
  if (mode === 1) return op_cmpm;
  return isDataAlterable(mode, reg) ? OP_EOR : ILLEGAL;
}

function decodeC(op, mode, reg) {
  const opmode = (op >> 6) & 7;
  if (opmode === 3) return isData(mode, reg) ? op_mulu : ILLEGAL;
  if (opmode === 7) return isData(mode, reg) ? op_muls : ILLEGAL;
  if (opmode < 3) return isData(mode, reg) ? OP_AND_EA_DN : ILLEGAL;
  if (opmode === 4 && (mode === 0 || mode === 1)) return OP_ABCD;
  // EXG's three forms are encoded in the opmode/mode pair, not a size field.
  if (opmode === 5 && (mode === 0 || mode === 1)) return op_exg;
  if (opmode === 6 && mode === 1) return op_exg;
  return isMemAlterable(mode, reg) ? OP_AND_DN_EA : ILLEGAL;
}

function decodeE(op, mode, reg) {
  if ((op & 0x00c0) === 0x00c0) {
    if (((op >> 9) & 7) > 3) return ILLEGAL; // 68020 bitfield ops
    return isMemAlterable(mode, reg) ? op_shift_mem : ILLEGAL;
  }
  return op_shift_reg;
}

const OPTABLE = new Array(65536);
for (let op = 0; op < 65536; op++) OPTABLE[op] = decode(op) || ILLEGAL;

export function createM68000(bus, opts) {
  return new M68000(bus, opts);
}

export default M68000;
