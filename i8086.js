// i8086 — Intel 8086/8088 and NEC V30 (µPD70116) CPU core.
// Pure JS, zero deps, deterministic.
//
// The fourth architecture in this collection (after the Z80, the 6502 and the
// 68000) and the one the PC-9801 needs. Written machine-agnostically: nothing
// in here knows about GDCs, interrupt controllers or floppy drives. The bus is
// injected, the machine drives the pins.
//
// Coverage: the complete 8086 instruction set, all addressing modes, every
// prefix (segment override, REP/REPE/REPNE, LOCK), the string instructions,
// software and hardware interrupts, the trap flag, HLT and the ESC escape.
// Constructed with `{ v30: true }` it becomes a µPD70116: the 80186-common
// additions (PUSHA/POPA, BOUND, PUSH/IMUL immediate, INS/OUTS, ENTER/LEAVE,
// shift-by-immediate, shift counts masked to five bits) plus NEC's own 0x0F
// group (TEST1/NOT1/CLR1/SET1, the packed-decimal string operations, ROL4/ROR4
// and the bit-field INS/EXT).
//
// ## What "8086" costs you that "80286" would not
//
// Three things in here look like bugs and are not:
//
//   * `PUSH SP` pushes the ALREADY-DECREMENTED value. Fixed on the 286, and
//     the standard way a program tells the two apart.
//   * Shift and rotate counts are NOT masked. `SHL AX, CL` with CL=255 really
//     does 255 shifts on an 8086; the 186 and later mask to five bits, and so
//     does this core in V30 mode.
//   * Divide error (and every other exception) pushes the address of the
//     instruction AFTER the faulting one. The 286 pushes the faulting address
//     so the fault can be restarted; the 8086 cannot restart it.
//
// Offsets wrap inside their segment: a word read at offset $FFFF takes its
// high byte from offset $0000 of the SAME segment, not from the next paragraph.
// Physical addresses wrap at 1 MB.
//
// ## The prefetch queue is not modelled
//
// The real part fetches ahead into a 6-byte queue (4 on the 8088), which is
// observable in exactly two ways: self-modifying code that patches an
// instruction already in the queue, and cycle-exact bus traces. Neither is
// something a PC-9801 program relies on to boot, and modelling it would make
// every memory access go through a queue state machine. `step()` therefore
// returns the published cycle count for the instruction as executed, with the
// effective-address overhead added, and docs/pc98-design.md says so out loud.
//
// The bus is injected:
//   { read8(phys), write8(phys, v),          // required; phys is 20-bit
//     read16(phys), write16(phys, v),        // optional; synthesised if absent
//     inb(port), outb(port, v),              // optional; default open bus
//     inw(port), outw(port, v),              // optional; synthesised if absent
//     intAck() -> vector | -1 }              // optional; default vector 0xFF
//
// Suite contract: no Math.random, same program + same bus -> identical state.
// snapshot() returns plain data with schemaVersion and holds no memory — the
// host's rewind ring stores one per frame.

export const SCHEMA_VERSION = 1;

// ---- register file layout --------------------------------------------------
// The ModRM reg field indexes these directly, which is the whole reason the
// order is AX CX DX BX SP BP SI DI rather than anything alphabetical.
export const REG = { AX: 0, CX: 1, DX: 2, BX: 3, SP: 4, BP: 5, SI: 6, DI: 7 };
export const SREG = { ES: 0, CS: 1, SS: 2, DS: 3 };

// Flag word bits. 1, 3, 5 and 12-15 are not flags: on an 8086 bit 1 reads back
// as 1 and 12-15 read back as 1, which is how PUSHF/POPF round-trip.
const F_CF = 0x0001, F_PF = 0x0004, F_AF = 0x0010, F_ZF = 0x0040;
const F_SF = 0x0080, F_TF = 0x0100, F_IF = 0x0200, F_DF = 0x0400, F_OF = 0x0800;
const F_ALWAYS = 0xf002;

export const VEC = {
  DIVIDE: 0, TRAP: 1, NMI: 2, BREAKPOINT: 3, OVERFLOW: 4, BOUND: 5,
};

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let p = 1, v = i;
  while (v) { p ^= v & 1; v >>= 1; }
  PARITY[i] = p;             // 1 when the byte has an EVEN number of set bits
}

const sign8 = (v) => (v << 24) >> 24;
const sign16 = (v) => (v << 16) >> 16;

// Signed overflow of an 8-bit add / subtract, used by the decimal adjusts,
// which are microcoded as ordinary ALU operations and inherit their flags.
const ovfAdd8 = (a, b, r) => ((~(a ^ b) & (a ^ r)) & 0x80) ? 1 : 0;
const ovfSub8 = (a, b, r) => (((a ^ b) & (a ^ r)) & 0x80) ? 1 : 0;

// Effective-address computation cost, table 2-20 of the 8086 manual. A segment
// override adds two more; the caller does that.
const EA_CYCLES = [7, 8, 8, 7, 5, 5, 5, 5]; // base+index forms, then the singles
// index: [mod===0 && rm===6] is the direct-address case and costs 6.

export class I8086 {
  constructor(bus = {}, opts = {}) {
    this.bus = bus;
    this.v30 = !!opts.v30;

    // A bus that only supplies bytes gets word accessors built from them. The
    // two byte cycles are what the real 16-bit bus does for an odd address
    // anyway, and a device with a read-once register sees the same count.
    this._rdMem8 = (a) => bus.read8(a & 0xfffff) & 0xff;
    this._wrMem8 = (a, v) => { bus.write8(a & 0xfffff, v & 0xff); };
    this._in8 = bus.inb ? (p) => bus.inb(p & 0xffff) & 0xff : () => 0xff;
    this._out8 = bus.outb ? (p, v) => bus.outb(p & 0xffff, v & 0xff) : () => {};
    this._in16 = bus.inw
      ? (p) => bus.inw(p & 0xffff) & 0xffff
      : (p) => (this._in8(p) | (this._in8(p + 1) << 8)) & 0xffff;
    this._out16 = bus.outw
      ? (p, v) => bus.outw(p & 0xffff, v & 0xffff)
      : (p, v) => { this._out8(p, v & 0xff); this._out8(p + 1, (v >> 8) & 0xff); };

    this.r = new Uint16Array(8);       // AX CX DX BX SP BP SI DI
    this.s = new Uint16Array(4);       // ES CS SS DS

    this.reset();
  }

  reset() {
    this.r.fill(0);
    this.s[SREG.CS] = 0xffff;
    this.s[SREG.DS] = 0; this.s[SREG.ES] = 0; this.s[SREG.SS] = 0;
    this.ip = 0;
    this.cf = 0; this.pf = 0; this.af = 0; this.zf = 0; this.sf = 0;
    this.tf = 0; this.if_ = 0; this.df = 0; this.of = 0;
    this.halted = false;
    this.irq = false;                 // INTR pin, level-sensitive
    this.nmi = false;                 // NMI pin, edge; the machine sets it, we clear it
    this.segOvr = -1;                 // active segment override, or -1
    this.repPrefix = 0;               // 0 none, 0xf2 REPNE, 0xf3 REP/REPE
    this.lock = false;
    this.intInhibit = false;          // one instruction of interrupt shadow after MOV SS / POP SS
    this.trapArmed = false;
    this._instStart = 0;              // IP of the first prefix byte of this instruction
    this.cycles = 0;                  // total clocks since reset
    return this;
  }

  // ---- flag word -------------------------------------------------------------
  getFlags() {
    return (F_ALWAYS
      | (this.cf ? F_CF : 0) | (this.pf ? F_PF : 0) | (this.af ? F_AF : 0)
      | (this.zf ? F_ZF : 0) | (this.sf ? F_SF : 0) | (this.tf ? F_TF : 0)
      | (this.if_ ? F_IF : 0) | (this.df ? F_DF : 0) | (this.of ? F_OF : 0)) & 0xffff;
  }

  setFlags(v) {
    this.cf = (v & F_CF) ? 1 : 0; this.pf = (v & F_PF) ? 1 : 0;
    this.af = (v & F_AF) ? 1 : 0; this.zf = (v & F_ZF) ? 1 : 0;
    this.sf = (v & F_SF) ? 1 : 0; this.tf = (v & F_TF) ? 1 : 0;
    this.if_ = (v & F_IF) ? 1 : 0; this.df = (v & F_DF) ? 1 : 0;
    this.of = (v & F_OF) ? 1 : 0;
  }

  // ---- memory ----------------------------------------------------------------
  // Physical = segment*16 + offset, wrapped to 20 bits. The offset wraps inside
  // its segment first, which is why the two byte halves of a word are computed
  // separately rather than from one physical address.
  phys(seg, off) { return (((this.s[seg] << 4) + (off & 0xffff)) & 0xfffff); }

  rd8(seg, off) { return this._rdMem8(((this.s[seg] << 4) + (off & 0xffff)) & 0xfffff); }
  wr8(seg, off, v) { this._wrMem8(((this.s[seg] << 4) + (off & 0xffff)) & 0xfffff, v); }
  rd16(seg, off) {
    const b = this.s[seg] << 4;
    return (this._rdMem8((b + (off & 0xffff)) & 0xfffff)
      | (this._rdMem8((b + ((off + 1) & 0xffff)) & 0xfffff) << 8)) & 0xffff;
  }
  wr16(seg, off, v) {
    const b = this.s[seg] << 4;
    this._wrMem8((b + (off & 0xffff)) & 0xfffff, v & 0xff);
    this._wrMem8((b + ((off + 1) & 0xffff)) & 0xfffff, (v >> 8) & 0xff);
  }

  // ---- instruction fetch -----------------------------------------------------
  fetch8() { const v = this.rd8(SREG.CS, this.ip); this.ip = (this.ip + 1) & 0xffff; return v; }
  fetch16() { const v = this.rd16(SREG.CS, this.ip); this.ip = (this.ip + 2) & 0xffff; return v; }

  // ---- stack -----------------------------------------------------------------
  push(v) { this.r[REG.SP] = (this.r[REG.SP] - 2) & 0xffff; this.wr16(SREG.SS, this.r[REG.SP], v); }
  pop() { const v = this.rd16(SREG.SS, this.r[REG.SP]); this.r[REG.SP] = (this.r[REG.SP] + 2) & 0xffff; return v; }

  // PUSH reg reads the register AFTER the stack pointer has moved, which is
  // only observable for `PUSH SP` — and that is exactly the 8086 quirk. Every
  // x86 from the 286 on pushes the entry value instead.
  pushFrom(i) {
    this.r[REG.SP] = (this.r[REG.SP] - 2) & 0xffff;
    this.wr16(SREG.SS, this.r[REG.SP], this.r[i]);
  }

  // ---- byte registers --------------------------------------------------------
  // 0-3 are the low halves of AX CX DX BX, 4-7 the high halves. Same file.
  getR8(i) { return (i < 4 ? this.r[i] & 0xff : (this.r[i - 4] >> 8) & 0xff); }
  setR8(i, v) {
    v &= 0xff;
    if (i < 4) this.r[i] = (this.r[i] & 0xff00) | v;
    else this.r[i - 4] = (this.r[i - 4] & 0x00ff) | (v << 8);
  }

  // ---- ModRM -----------------------------------------------------------------
  // Leaves `mod`, `regf`, `rm`, and for a memory form `ea` (the offset) and
  // `eaSeg` (the segment, after any override). BP-based forms default to SS,
  // which is the whole point of having a stack segment.
  modrm() {
    const m = this.fetch8();
    this.mod = m >> 6; this.regf = (m >> 3) & 7; this.rm = m & 7;
    this.eaCycles = 0;
    if (this.mod === 3) { this.eaIsReg = true; return; }
    this.eaIsReg = false;
    let base = 0, seg = SREG.DS, cost = 0;
    switch (this.rm) {
      case 0: base = this.r[REG.BX] + this.r[REG.SI]; cost = 7; break;
      case 1: base = this.r[REG.BX] + this.r[REG.DI]; cost = 8; break;
      case 2: base = this.r[REG.BP] + this.r[REG.SI]; seg = SREG.SS; cost = 8; break;
      case 3: base = this.r[REG.BP] + this.r[REG.DI]; seg = SREG.SS; cost = 7; break;
      case 4: base = this.r[REG.SI]; cost = 5; break;
      case 5: base = this.r[REG.DI]; cost = 5; break;
      case 6:
        if (this.mod === 0) { base = this.fetch16(); cost = 6; }
        else { base = this.r[REG.BP]; seg = SREG.SS; cost = 5; }
        break;
      default: base = this.r[REG.BX]; cost = 5; break;
    }
    if (this.mod === 1) { base += sign8(this.fetch8()); cost += 4; }
    else if (this.mod === 2) { base += this.fetch16(); cost += 4; }
    this.ea = base & 0xffff;
    this.eaSeg = this.segOvr >= 0 ? this.segOvr : seg;
    if (this.segOvr >= 0) cost += 2;
    this.eaCycles = cost;
  }

  getRM8() { return this.eaIsReg ? this.getR8(this.rm) : this.rd8(this.eaSeg, this.ea); }
  setRM8(v) { if (this.eaIsReg) this.setR8(this.rm, v); else this.wr8(this.eaSeg, this.ea, v); }
  getRM16() { return this.eaIsReg ? this.r[this.rm] : this.rd16(this.eaSeg, this.ea); }
  setRM16(v) { if (this.eaIsReg) this.r[this.rm] = v & 0xffff; else this.wr16(this.eaSeg, this.ea, v); }

  // The segment a data reference uses when the instruction did not compute an
  // effective address: string sources, XLAT, the direct-offset MOVs.
  dataSeg(dflt = SREG.DS) { return this.segOvr >= 0 ? this.segOvr : dflt; }

  // ---- flag helpers ----------------------------------------------------------
  setLogic8(r) { this.cf = 0; this.of = 0; this.af = 0; this.setSZP8(r); }
  setLogic16(r) { this.cf = 0; this.of = 0; this.af = 0; this.setSZP16(r); }
  setSZP8(r) { this.sf = (r & 0x80) ? 1 : 0; this.zf = (r & 0xff) === 0 ? 1 : 0; this.pf = PARITY[r & 0xff]; }
  setSZP16(r) { this.sf = (r & 0x8000) ? 1 : 0; this.zf = (r & 0xffff) === 0 ? 1 : 0; this.pf = PARITY[r & 0xff]; }

  add8(a, b, c = 0) {
    const r = a + b + c;
    this.cf = r > 0xff ? 1 : 0;
    this.af = ((a ^ b ^ r) & 0x10) ? 1 : 0;
    this.of = ((~(a ^ b) & (a ^ r)) & 0x80) ? 1 : 0;
    this.setSZP8(r);
    return r & 0xff;
  }
  add16(a, b, c = 0) {
    const r = a + b + c;
    this.cf = r > 0xffff ? 1 : 0;
    this.af = ((a ^ b ^ r) & 0x10) ? 1 : 0;
    this.of = ((~(a ^ b) & (a ^ r)) & 0x8000) ? 1 : 0;
    this.setSZP16(r);
    return r & 0xffff;
  }
  sub8(a, b, c = 0) {
    const r = a - b - c;
    this.cf = r < 0 ? 1 : 0;
    this.af = ((a ^ b ^ r) & 0x10) ? 1 : 0;
    this.of = (((a ^ b) & (a ^ r)) & 0x80) ? 1 : 0;
    this.setSZP8(r & 0xff);
    return r & 0xff;
  }
  sub16(a, b, c = 0) {
    const r = a - b - c;
    this.cf = r < 0 ? 1 : 0;
    this.af = ((a ^ b ^ r) & 0x10) ? 1 : 0;
    this.of = (((a ^ b) & (a ^ r)) & 0x8000) ? 1 : 0;
    this.setSZP16(r & 0xffff);
    return r & 0xffff;
  }

  // The eight ALU operations the 00-3F block and groups 80/81/83 share, in the
  // order the reg field numbers them.
  alu8(op, a, b) {
    switch (op) {
      case 0: return this.add8(a, b);
      case 1: { const r = (a | b) & 0xff; this.setLogic8(r); return r; }
      case 2: return this.add8(a, b, this.cf);
      case 3: return this.sub8(a, b, this.cf);
      case 4: { const r = (a & b) & 0xff; this.setLogic8(r); return r; }
      case 5: return this.sub8(a, b);
      case 6: { const r = (a ^ b) & 0xff; this.setLogic8(r); return r; }
      default: this.sub8(a, b); return a;      // CMP writes nothing back
    }
  }
  alu16(op, a, b) {
    switch (op) {
      case 0: return this.add16(a, b);
      case 1: { const r = (a | b) & 0xffff; this.setLogic16(r); return r; }
      case 2: return this.add16(a, b, this.cf);
      case 3: return this.sub16(a, b, this.cf);
      case 4: { const r = (a & b) & 0xffff; this.setLogic16(r); return r; }
      case 5: return this.sub16(a, b);
      case 6: { const r = (a ^ b) & 0xffff; this.setLogic16(r); return r; }
      default: this.sub16(a, b); return a;
    }
  }

  // ---- interrupts ------------------------------------------------------------
  // Push flags, clear IF and TF, push the return address, vector through the
  // table at 0000:0000. This is also what INT n does, which is why software and
  // hardware interrupts are the same code.
  interrupt(vec) {
    this.push(this.getFlags());
    this.if_ = 0; this.tf = 0;
    this.push(this.s[SREG.CS]);
    this.push(this.ip);
    const base = (vec & 0xff) * 4;
    this.ip = this._rdMem8(base) | (this._rdMem8(base + 1) << 8);
    this.s[SREG.CS] = this._rdMem8(base + 2) | (this._rdMem8(base + 3) << 8);
    this.halted = false;
    // A vector taken clears any pending trap: the handler runs untraced.
    this.trapArmed = false;
  }

  setIRQ(on) { this.irq = !!on; return this; }
  pulseNMI() { this.nmi = true; return this; }

  // ---- one instruction -------------------------------------------------------
  step() {
    const start = this.cycles;

    // NMI first, then INTR, then the instruction. A halted CPU only leaves HLT
    // through one of these (or a reset), so the check has to come first.
    if (this.nmi) {
      this.nmi = false;
      this.interrupt(VEC.NMI);
      this.cycles += 50;
      return this.cycles - start;
    }
    if (this.if_ && this.irq && !this.intInhibit) {
      const vec = this.bus.intAck ? this.bus.intAck() : 0xff;
      if (vec >= 0) {
        this.interrupt(vec & 0xff);
        this.cycles += 61;
        return this.cycles - start;
      }
    }
    if (this.halted) { this.cycles += 2; return 2; }

    this.intInhibit = false;
    this.trapArmed = this.tf !== 0;
    this.segOvr = -1; this.repPrefix = 0; this.lock = false;
    this._instStart = this.ip;

    this.execute();

    // The trap fires AFTER the instruction that had TF set on entry. An
    // instruction that sets TF (POPF, IRET) therefore does not trap itself.
    if (this.trapArmed && this.tf && !this.intInhibit) {
      this.trapArmed = false;
      this.interrupt(VEC.TRAP);
      this.cycles += 50;
    }
    return this.cycles - start;
  }

  // Prefix loop plus the opcode switch. Prefixes are consumed here so that
  // `_instStart` stays at the first prefix byte, which is where a REP that is
  // interrupted mid-string has to resume.
  execute() {
    let op = this.fetch8();
    for (;;) {
      if (op === 0x26) { this.segOvr = SREG.ES; this.cycles += 2; op = this.fetch8(); continue; }
      if (op === 0x2e) { this.segOvr = SREG.CS; this.cycles += 2; op = this.fetch8(); continue; }
      if (op === 0x36) { this.segOvr = SREG.SS; this.cycles += 2; op = this.fetch8(); continue; }
      if (op === 0x3e) { this.segOvr = SREG.DS; this.cycles += 2; op = this.fetch8(); continue; }
      if (op === 0xf0 || op === 0xf1) { this.lock = true; this.cycles += 2; op = this.fetch8(); continue; }
      if (op === 0xf2 || op === 0xf3) { this.repPrefix = op; this.cycles += 2; op = this.fetch8(); continue; }
      break;
    }
    this.op(op);
  }

  op(op) {
    const r = this.r;
    switch (op) {
      // ---- 00-3F: the ALU block ----------------------------------------------
      // Each of the eight operations gets six encodings: r/m,reg and reg,r/m in
      // both widths, plus AL,imm8 and AX,imm16.
      case 0x00: case 0x08: case 0x10: case 0x18:
      case 0x20: case 0x28: case 0x30: case 0x38: {
        this.modrm(); const a = this.getRM8(), b = this.getR8(this.regf);
        const v = this.alu8(op >> 3, a, b);
        if ((op >> 3) !== 7) this.setRM8(v);
        this.cycles += this.eaIsReg ? 3 : 16 + this.eaCycles;
        return;
      }
      case 0x01: case 0x09: case 0x11: case 0x19:
      case 0x21: case 0x29: case 0x31: case 0x39: {
        this.modrm(); const a = this.getRM16(), b = r[this.regf];
        const v = this.alu16(op >> 3, a, b);
        if ((op >> 3) !== 7) this.setRM16(v);
        this.cycles += this.eaIsReg ? 3 : 16 + this.eaCycles;
        return;
      }
      case 0x02: case 0x0a: case 0x12: case 0x1a:
      case 0x22: case 0x2a: case 0x32: case 0x3a: {
        this.modrm(); const a = this.getR8(this.regf), b = this.getRM8();
        const v = this.alu8(op >> 3, a, b);
        if ((op >> 3) !== 7) this.setR8(this.regf, v);
        this.cycles += this.eaIsReg ? 3 : 9 + this.eaCycles;
        return;
      }
      case 0x03: case 0x0b: case 0x13: case 0x1b:
      case 0x23: case 0x2b: case 0x33: case 0x3b: {
        this.modrm(); const a = r[this.regf], b = this.getRM16();
        const v = this.alu16(op >> 3, a, b);
        if ((op >> 3) !== 7) r[this.regf] = v;
        this.cycles += this.eaIsReg ? 3 : 9 + this.eaCycles;
        return;
      }
      case 0x04: case 0x0c: case 0x14: case 0x1c:
      case 0x24: case 0x2c: case 0x34: case 0x3c: {
        const v = this.alu8(op >> 3, this.getR8(0), this.fetch8());
        if ((op >> 3) !== 7) this.setR8(0, v);
        this.cycles += 4;
        return;
      }
      case 0x05: case 0x0d: case 0x15: case 0x1d:
      case 0x25: case 0x2d: case 0x35: case 0x3d: {
        const v = this.alu16(op >> 3, r[0], this.fetch16());
        if ((op >> 3) !== 7) r[0] = v;
        this.cycles += 4;
        return;
      }

      // PUSH/POP segment register. POP CS exists on the 8086 and nowhere else;
      // on the V30 the same byte introduces NEC's extension group.
      case 0x06: this.push(this.s[SREG.ES]); this.cycles += 10; return;
      case 0x07: this.s[SREG.ES] = this.pop(); this.cycles += 8; return;
      case 0x0e: this.push(this.s[SREG.CS]); this.cycles += 10; return;
      case 0x0f:
        if (this.v30) { this.v30Group(); return; }
        this.s[SREG.CS] = this.pop(); this.cycles += 8; return;
      case 0x16: this.push(this.s[SREG.SS]); this.cycles += 10; return;
      case 0x17: this.s[SREG.SS] = this.pop(); this.intInhibit = true; this.cycles += 8; return;
      case 0x1e: this.push(this.s[SREG.DS]); this.cycles += 10; return;
      case 0x1f: this.s[SREG.DS] = this.pop(); this.cycles += 8; return;

      // ---- decimal adjusts ----------------------------------------------------
      case 0x27: this.daa(); return;
      case 0x2f: this.das(); return;
      case 0x37: this.aaa(); return;
      case 0x3f: this.aas(); return;

      // ---- 40-5F: INC/DEC/PUSH/POP register ------------------------------------
      case 0x40: case 0x41: case 0x42: case 0x43:
      case 0x44: case 0x45: case 0x46: case 0x47: {
        const i = op & 7, a = r[i], v = (a + 1) & 0xffff;
        this.of = a === 0x7fff ? 1 : 0; this.af = (v & 0x0f) === 0 ? 1 : 0;
        this.setSZP16(v); r[i] = v; this.cycles += 3; return;
      }
      case 0x48: case 0x49: case 0x4a: case 0x4b:
      case 0x4c: case 0x4d: case 0x4e: case 0x4f: {
        const i = op & 7, a = r[i], v = (a - 1) & 0xffff;
        this.of = a === 0x8000 ? 1 : 0; this.af = (a & 0x0f) === 0 ? 1 : 0;
        this.setSZP16(v); r[i] = v; this.cycles += 3; return;
      }
      // PUSH SP on an 8086 pushes SP AFTER the decrement. Every later x86
      // pushes the value it had on entry; this is the classic probe.
      case 0x50: case 0x51: case 0x52: case 0x53:
      case 0x54: case 0x55: case 0x56: case 0x57:
        this.pushFrom(op & 7); this.cycles += 11; return;
      case 0x58: case 0x59: case 0x5a: case 0x5b:
      case 0x5c: case 0x5d: case 0x5e: case 0x5f:
        r[op & 7] = this.pop(); this.cycles += 8; return;

      // ---- 60-6F -------------------------------------------------------------
      // On the 8086 this range is not decoded at all: the top bit of the opcode
      // is ignored and 60-6F execute as the conditional jumps 70-7F. On the V30
      // it is the 80186 block.
      case 0x60: case 0x61: case 0x62: case 0x63:
      case 0x64: case 0x65: case 0x66: case 0x67:
      case 0x68: case 0x69: case 0x6a: case 0x6b:
      case 0x6c: case 0x6d: case 0x6e: case 0x6f:
        if (!this.v30) { this.jcc(op & 0x0f); return; }
        this.v30Block60(op);
        return;

      case 0x70: case 0x71: case 0x72: case 0x73:
      case 0x74: case 0x75: case 0x76: case 0x77:
      case 0x78: case 0x79: case 0x7a: case 0x7b:
      case 0x7c: case 0x7d: case 0x7e: case 0x7f:
        this.jcc(op & 0x0f); return;

      // ---- 80-83: ALU with immediate -------------------------------------------
      // 0x82 is a second encoding of 0x80 on the 8086; the 186 turned it into an
      // illegal opcode and the V30 keeps the alias.
      case 0x80: case 0x82: {
        this.modrm(); const a = this.getRM8(), b = this.fetch8();
        const v = this.alu8(this.regf, a, b);
        if (this.regf !== 7) this.setRM8(v);
        this.cycles += this.eaIsReg ? 4 : 17 + this.eaCycles;
        return;
      }
      case 0x81: {
        this.modrm(); const a = this.getRM16(), b = this.fetch16();
        const v = this.alu16(this.regf, a, b);
        if (this.regf !== 7) this.setRM16(v);
        this.cycles += this.eaIsReg ? 4 : 17 + this.eaCycles;
        return;
      }
      case 0x83: {
        this.modrm(); const a = this.getRM16(), b = sign8(this.fetch8()) & 0xffff;
        const v = this.alu16(this.regf, a, b);
        if (this.regf !== 7) this.setRM16(v);
        this.cycles += this.eaIsReg ? 4 : 17 + this.eaCycles;
        return;
      }

      // ---- 84-8F: TEST, XCHG, MOV, LEA, POP -------------------------------------
      case 0x84: { this.modrm(); const v = this.getRM8() & this.getR8(this.regf); this.setLogic8(v); this.cycles += this.eaIsReg ? 3 : 9 + this.eaCycles; return; }
      case 0x85: { this.modrm(); const v = this.getRM16() & r[this.regf]; this.setLogic16(v); this.cycles += this.eaIsReg ? 3 : 9 + this.eaCycles; return; }
      case 0x86: { this.modrm(); const a = this.getRM8(), b = this.getR8(this.regf); this.setRM8(b); this.setR8(this.regf, a); this.cycles += this.eaIsReg ? 4 : 17 + this.eaCycles; return; }
      case 0x87: { this.modrm(); const a = this.getRM16(), b = r[this.regf]; this.setRM16(b); r[this.regf] = a; this.cycles += this.eaIsReg ? 4 : 17 + this.eaCycles; return; }
      case 0x88: this.modrm(); this.setRM8(this.getR8(this.regf)); this.cycles += this.eaIsReg ? 2 : 9 + this.eaCycles; return;
      case 0x89: this.modrm(); this.setRM16(r[this.regf]); this.cycles += this.eaIsReg ? 2 : 9 + this.eaCycles; return;
      case 0x8a: this.modrm(); this.setR8(this.regf, this.getRM8()); this.cycles += this.eaIsReg ? 2 : 8 + this.eaCycles; return;
      case 0x8b: this.modrm(); r[this.regf] = this.getRM16(); this.cycles += this.eaIsReg ? 2 : 8 + this.eaCycles; return;
      // Only two bits of the reg field select the segment register; the third is
      // ignored rather than illegal.
      case 0x8c: this.modrm(); this.setRM16(this.s[this.regf & 3]); this.cycles += this.eaIsReg ? 2 : 9 + this.eaCycles; return;
      case 0x8d: {
        // LEA wants the address, not what is at it. A register form has no
        // address at all; the 8086 loads whatever the EA adder last held, and
        // we give it the register's own value, which is what MartyPC observes.
        this.modrm();
        r[this.regf] = this.eaIsReg ? r[this.rm] : this.ea;
        this.cycles += 2 + this.eaCycles;
        return;
      }
      case 0x8e: {
        this.modrm(); const sr = this.regf & 3;
        this.s[sr] = this.getRM16();
        if (sr === SREG.SS) this.intInhibit = true;
        this.cycles += this.eaIsReg ? 2 : 8 + this.eaCycles;
        return;
      }
      case 0x8f: {
        // POP r/m16. The 8086 pops first and computes the effective address
        // afterwards, so `POP [BP+SI]` with SS:BP addressing sees the new SP.
        this.modrm();
        const v = this.pop();
        this.setRM16(v);
        this.cycles += this.eaIsReg ? 8 : 17 + this.eaCycles;
        return;
      }

      // ---- 90-9F ---------------------------------------------------------------
      case 0x90: this.cycles += 3; return;                       // NOP === XCHG AX,AX
      case 0x91: case 0x92: case 0x93: case 0x94:
      case 0x95: case 0x96: case 0x97: {
        const i = op & 7, t = r[0]; r[0] = r[i]; r[i] = t; this.cycles += 3; return;
      }
      case 0x98: this.setR8(4, (this.getR8(0) & 0x80) ? 0xff : 0x00); this.cycles += 2; return; // CBW
      case 0x99: r[REG.DX] = (r[0] & 0x8000) ? 0xffff : 0x0000; this.cycles += 5; return;       // CWD
      case 0x9a: {                                              // CALL far
        const off = this.fetch16(), seg = this.fetch16();
        this.push(this.s[SREG.CS]); this.push(this.ip);
        this.s[SREG.CS] = seg; this.ip = off; this.cycles += 28; return;
      }
      case 0x9b: this.cycles += 4; return;                       // WAIT: no coprocessor here
      case 0x9c: this.push(this.getFlags()); this.cycles += 10; return;
      case 0x9d: this.setFlags(this.pop()); this.cycles += 8; return;
      case 0x9e: {                                              // SAHF
        const f = this.getR8(4);
        this.sf = (f & 0x80) ? 1 : 0; this.zf = (f & 0x40) ? 1 : 0;
        this.af = (f & 0x10) ? 1 : 0; this.pf = (f & 0x04) ? 1 : 0;
        this.cf = (f & 0x01) ? 1 : 0; this.cycles += 4; return;
      }
      case 0x9f:                                                // LAHF
        this.setR8(4, (this.sf ? 0x80 : 0) | (this.zf ? 0x40 : 0) | (this.af ? 0x10 : 0)
          | (this.pf ? 0x04 : 0) | (this.cf ? 0x01 : 0) | 0x02);
        this.cycles += 4; return;

      // ---- A0-A3: MOV accumulator to/from a direct offset -------------------------
      case 0xa0: { const o = this.fetch16(); this.setR8(0, this.rd8(this.dataSeg(), o)); this.cycles += 10; return; }
      case 0xa1: { const o = this.fetch16(); r[0] = this.rd16(this.dataSeg(), o); this.cycles += 10; return; }
      case 0xa2: { const o = this.fetch16(); this.wr8(this.dataSeg(), o, this.getR8(0)); this.cycles += 10; return; }
      case 0xa3: { const o = this.fetch16(); this.wr16(this.dataSeg(), o, r[0]); this.cycles += 10; return; }

      // ---- A4-AF: the string block ------------------------------------------------
      case 0xa4: case 0xa5: case 0xa6: case 0xa7:
      case 0xaa: case 0xab: case 0xac: case 0xad:
      case 0xae: case 0xaf:
        this.string(op); return;

      case 0xa8: { const v = this.getR8(0) & this.fetch8(); this.setLogic8(v); this.cycles += 4; return; }
      case 0xa9: { const v = r[0] & this.fetch16(); this.setLogic16(v); this.cycles += 4; return; }

      // ---- B0-BF: MOV immediate to register ----------------------------------------
      case 0xb0: case 0xb1: case 0xb2: case 0xb3:
      case 0xb4: case 0xb5: case 0xb6: case 0xb7:
        this.setR8(op & 7, this.fetch8()); this.cycles += 4; return;
      case 0xb8: case 0xb9: case 0xba: case 0xbb:
      case 0xbc: case 0xbd: case 0xbe: case 0xbf:
        r[op & 7] = this.fetch16(); this.cycles += 4; return;

      // ---- C0-CF: returns, LES/LDS, interrupts ---------------------------------------
      // C0/C1 are unlisted aliases of C2/C3 on the 8086 (and C8/C9 of CA/CB);
      // the V30 uses them for shift-by-immediate and ENTER/LEAVE.
      case 0xc0:
        if (this.v30) { this.shiftGroup(false, 0, true); return; }
        // fallthrough
      case 0xc2: { const n = this.fetch16(); this.ip = this.pop(); r[REG.SP] = (r[REG.SP] + n) & 0xffff; this.cycles += 20; return; }
      case 0xc1:
        if (this.v30) { this.shiftGroup(true, 0, true); return; }
        // fallthrough
      case 0xc3: this.ip = this.pop(); this.cycles += 16; return;
      case 0xc4: { this.modrm(); const o = this.ea, sg = this.eaSeg; r[this.regf] = this.rd16(sg, o); this.s[SREG.ES] = this.rd16(sg, (o + 2) & 0xffff); this.cycles += 16 + this.eaCycles; return; }
      case 0xc5: { this.modrm(); const o = this.ea, sg = this.eaSeg; r[this.regf] = this.rd16(sg, o); this.s[SREG.DS] = this.rd16(sg, (o + 2) & 0xffff); this.cycles += 16 + this.eaCycles; return; }
      case 0xc6: this.modrm(); this.setRM8(this.fetch8()); this.cycles += this.eaIsReg ? 4 : 10 + this.eaCycles; return;
      case 0xc7: this.modrm(); this.setRM16(this.fetch16()); this.cycles += this.eaIsReg ? 4 : 10 + this.eaCycles; return;
      case 0xc8:
        if (this.v30) { this.enter(); return; }
        // fallthrough
      case 0xca: { const n = this.fetch16(); this.ip = this.pop(); this.s[SREG.CS] = this.pop(); r[REG.SP] = (r[REG.SP] + n) & 0xffff; this.cycles += 25; return; }
      case 0xc9:
        if (this.v30) { r[REG.SP] = r[REG.BP]; r[REG.BP] = this.pop(); this.cycles += 8; return; }
        // fallthrough
      case 0xcb: this.ip = this.pop(); this.s[SREG.CS] = this.pop(); this.cycles += 26; return;
      case 0xcc: this.interrupt(VEC.BREAKPOINT); this.cycles += 72; return;
      case 0xcd: { const v = this.fetch8(); this.interrupt(v); this.cycles += 71; return; }
      case 0xce: if (this.of) { this.interrupt(VEC.OVERFLOW); this.cycles += 73; } else this.cycles += 4; return;
      case 0xcf: {
        this.ip = this.pop(); this.s[SREG.CS] = this.pop(); this.setFlags(this.pop());
        this.cycles += 44;
        // An IRET that restores TF=1 does not trap at the end of the IRET: the
        // trap belongs to the instruction that runs next.
        this.trapArmed = false;
        return;
      }

      // ---- D0-D3: shifts and rotates ---------------------------------------------
      case 0xd0: this.shiftGroup(false, 1, false); return;
      case 0xd1: this.shiftGroup(true, 1, false); return;
      case 0xd2: this.shiftGroup(false, this.getR8(1), false); return;
      case 0xd3: this.shiftGroup(true, this.getR8(1), false); return;

      case 0xd4: this.aam(this.fetch8()); return;
      case 0xd5: this.aad(this.fetch8()); return;
      // SALC: undocumented on the 8086, and the shortest way to smear CF across
      // a byte. The V30 does not have it (0xD6 is a no-operation there).
      case 0xd6: if (!this.v30) this.setR8(0, this.cf ? 0xff : 0x00); this.cycles += 4; return;
      case 0xd7: {                                              // XLAT
        const off = (r[REG.BX] + this.getR8(0)) & 0xffff;
        this.setR8(0, this.rd8(this.dataSeg(), off));
        this.cycles += 11; return;
      }

      // ESC: hands the operand to a coprocessor that is not here. The address is
      // still computed (the 8087 latches it off the bus), so the ModRM has to be
      // consumed and its EA bytes fetched.
      case 0xd8: case 0xd9: case 0xda: case 0xdb:
      case 0xdc: case 0xdd: case 0xde: case 0xdf:
        this.modrm(); if (!this.eaIsReg) this.getRM16();
        this.cycles += 2 + this.eaCycles; return;

      // ---- E0-E3: loops ------------------------------------------------------------
      case 0xe0: { const d = sign8(this.fetch8()); r[REG.CX] = (r[REG.CX] - 1) & 0xffff; if (r[REG.CX] !== 0 && !this.zf) { this.ip = (this.ip + d) & 0xffff; this.cycles += 19; } else this.cycles += 5; return; }
      case 0xe1: { const d = sign8(this.fetch8()); r[REG.CX] = (r[REG.CX] - 1) & 0xffff; if (r[REG.CX] !== 0 && this.zf) { this.ip = (this.ip + d) & 0xffff; this.cycles += 18; } else this.cycles += 6; return; }
      case 0xe2: { const d = sign8(this.fetch8()); r[REG.CX] = (r[REG.CX] - 1) & 0xffff; if (r[REG.CX] !== 0) { this.ip = (this.ip + d) & 0xffff; this.cycles += 17; } else this.cycles += 5; return; }
      case 0xe3: { const d = sign8(this.fetch8()); if (r[REG.CX] === 0) { this.ip = (this.ip + d) & 0xffff; this.cycles += 18; } else this.cycles += 6; return; }

      // ---- E4-E7, EC-EF: I/O ---------------------------------------------------------
      case 0xe4: this.setR8(0, this._in8(this.fetch8())); this.cycles += 10; return;
      case 0xe5: r[0] = this._in16(this.fetch8()); this.cycles += 10; return;
      case 0xe6: this._out8(this.fetch8(), this.getR8(0)); this.cycles += 10; return;
      case 0xe7: this._out16(this.fetch8(), r[0]); this.cycles += 10; return;
      case 0xec: this.setR8(0, this._in8(r[REG.DX])); this.cycles += 8; return;
      case 0xed: r[0] = this._in16(r[REG.DX]); this.cycles += 8; return;
      case 0xee: this._out8(r[REG.DX], this.getR8(0)); this.cycles += 8; return;
      case 0xef: this._out16(r[REG.DX], r[0]); this.cycles += 8; return;

      // ---- E8-EB: calls and jumps -------------------------------------------------------
      case 0xe8: { const d = sign16(this.fetch16()); this.push(this.ip); this.ip = (this.ip + d) & 0xffff; this.cycles += 19; return; }
      case 0xe9: { const d = sign16(this.fetch16()); this.ip = (this.ip + d) & 0xffff; this.cycles += 15; return; }
      case 0xea: { const off = this.fetch16(), seg = this.fetch16(); this.ip = off; this.s[SREG.CS] = seg; this.cycles += 15; return; }
      case 0xeb: { const d = sign8(this.fetch8()); this.ip = (this.ip + d) & 0xffff; this.cycles += 15; return; }

      // ---- F4-FF ---------------------------------------------------------------------
      case 0xf4: this.halted = true; this.cycles += 2; return;
      case 0xf5: this.cf ^= 1; this.cycles += 2; return;
      case 0xf6: this.group3(false); return;
      case 0xf7: this.group3(true); return;
      case 0xf8: this.cf = 0; this.cycles += 2; return;
      case 0xf9: this.cf = 1; this.cycles += 2; return;
      case 0xfa: this.if_ = 0; this.cycles += 2; return;
      // STI opens the interrupt window only AFTER the next instruction, which is
      // what makes `STI / HLT` race-free.
      case 0xfb: this.if_ = 1; this.intInhibit = true; this.cycles += 2; return;
      case 0xfc: this.df = 0; this.cycles += 2; return;
      case 0xfd: this.df = 1; this.cycles += 2; return;
      case 0xfe: this.group4(); return;
      case 0xff: this.group5(); return;

      default:
        // Nothing here is undecoded on an 8086 — every byte does something —
        // so reaching this is a bug in the switch, not in the program.
        this.cycles += 2;
        return;
    }
  }

  // ---- conditional jumps -------------------------------------------------------
  jcc(cond) {
    const d = sign8(this.fetch8());
    if (this.testCond(cond)) { this.ip = (this.ip + d) & 0xffff; this.cycles += 16; }
    else this.cycles += 4;
  }

  testCond(c) {
    switch (c) {
      case 0x0: return this.of;
      case 0x1: return !this.of;
      case 0x2: return this.cf;
      case 0x3: return !this.cf;
      case 0x4: return this.zf;
      case 0x5: return !this.zf;
      case 0x6: return this.cf || this.zf;
      case 0x7: return !this.cf && !this.zf;
      case 0x8: return this.sf;
      case 0x9: return !this.sf;
      case 0xa: return this.pf;
      case 0xb: return !this.pf;
      case 0xc: return this.sf !== this.of;
      case 0xd: return this.sf === this.of;
      case 0xe: return this.zf || (this.sf !== this.of);
      default: return !this.zf && (this.sf === this.of);
    }
  }

  // ---- decimal adjust ----------------------------------------------------------
  // DAA/DAS look at AF and CF together, and the CF they leave is sticky: once
  // the top correction has happened, CF stays set even if the addition itself
  // did not carry. Getting that wrong breaks multi-byte BCD arithmetic.
  // These four are microcoded as ordinary ALU operations, and the flags the
  // manual calls undefined are simply the flags of the LAST one performed. That
  // is where OF comes from below, and why "no correction was needed" leaves
  // OF at zero rather than at whatever it was.
  // Two things here disagree with Intel's own pseudo-code and agree with the
  // silicon:
  //
  //   * the second correction's threshold is $9F, not $99. `DAA` on AL=$9A with
  //     AF set leaves $A0 on an 8086 and $00 on a 486, because the hardware
  //     tests the high NIBBLE against 9 rather than the byte against $99.
  //   * OF is the overflow of ONE add of the total correction ($06, $60 or
  //     $66), not of whichever half ran last.
  daa() {
    const old = this.getR8(0), oldCf = this.cf, oldAf = this.af;
    let corr = 0;
    if ((old & 0x0f) > 9 || this.af) { corr = 6; this.af = 1; } else this.af = 0;
    let cf = oldCf;
    if (old > 0x99 + (oldAf ? 6 : 0) || oldCf) { corr += 0x60; cf = 1; }
    const al = (old + corr) & 0xff;
    this.cf = cf;
    this.of = corr ? ovfAdd8(old, corr, al) : 0;
    this.setSZP8(al);
    this.setR8(0, al);
    this.cycles += 4;
  }

  das() {
    const old = this.getR8(0), oldCf = this.cf, oldAf = this.af;
    let corr = 0;
    if ((old & 0x0f) > 9 || this.af) { corr = 6; this.af = 1; } else this.af = 0;
    let cf = oldCf;
    if (old > 0x99 + (oldAf ? 6 : 0) || oldCf) { corr += 0x60; cf = 1; }
    const al = (old - corr) & 0xff;
    this.cf = cf;
    this.of = corr ? ovfSub8(old, corr, al) : 0;
    this.setSZP8(al);
    this.setR8(0, al);
    this.cycles += 4;
  }

  // AAA/AAS take SZP and OF from the UNMASKED intermediate — AL+6 (or AL-6),
  // before the top nibble is thrown away. `AAA` on AL=$7F therefore reports
  // sign and overflow from $85, not from the $05 it leaves behind.
  aaa() {
    const al = this.getR8(0);
    let inter;
    if ((al & 0x0f) > 9 || this.af) {
      inter = (al + 6) & 0xff;
      this.of = ovfAdd8(al, 6, inter);
      this.af = 1; this.cf = 1;
      this.setR8(4, (this.getR8(4) + 1) & 0xff);
    } else {
      inter = al;
      this.of = 0; this.af = 0; this.cf = 0;
    }
    this.setSZP8(inter);
    this.setR8(0, inter & 0x0f);
    this.cycles += 4;
  }

  aas() {
    const al = this.getR8(0);
    let inter;
    if ((al & 0x0f) > 9 || this.af) {
      inter = (al - 6) & 0xff;
      this.of = ovfSub8(al, 6, inter);
      this.af = 1; this.cf = 1;
      this.setR8(4, (this.getR8(4) - 1) & 0xff);
    } else {
      inter = al;
      this.of = 0; this.af = 0; this.cf = 0;
    }
    this.setSZP8(inter);
    this.setR8(0, inter & 0x0f);
    this.cycles += 4;
  }

  // AAM divides, so AAM 0 is a divide by zero and takes vector 0.
  aam(base) {
    if (base === 0) {
      // The division is attempted before the fault is noticed, and it leaves
      // the flags of a zero result behind for the handler to find on the stack.
      this.setLogic8(0);
      this.divideError();
      return;
    }
    const al = this.getR8(0);
    const ah = (al / base) | 0, rem = al % base;
    this.setR8(4, ah); this.setR8(0, rem);
    this.setSZP16((ah << 8) | rem);
    this.zf = rem === 0 ? 1 : 0;
    this.sf = (rem & 0x80) ? 1 : 0;
    this.pf = PARITY[rem];
    this.of = 0; this.cf = 0; this.af = 0;
    this.cycles += 83;
  }

  // AAD is a multiply followed by an ADD, and the flags are the ADD's — all of
  // them, including the carry and overflow the manual calls undefined.
  aad(base) {
    const al = this.getR8(0), ah = this.getR8(4);
    const v = this.add8(al, (ah * base) & 0xff);
    this.setR8(0, v); this.setR8(4, 0);
    this.cycles += 60;
  }

  divideError() {
    // The 8086 pushes the address of the instruction AFTER the divide. It
    // cannot restart the faulting instruction, and DOS's INT 0 handler knows it.
    this.interrupt(VEC.DIVIDE);
    this.cycles += 50;
  }

  // ---- shifts and rotates --------------------------------------------------------
  // On an 8086 the count is used whole: SHL AX, CL with CL=200 really performs
  // 200 shifts and costs 4 + 4*200 clocks. The 186 (and the V30) mask to five
  // bits, which is why this takes the width from `this.v30`.
  shiftGroup(word, count, immediate) {
    this.modrm();
    if (immediate) count = this.fetch8();
    let n = count & 0xff;
    if (this.v30) n &= 0x1f;
    const v = word ? this.getRM16() : this.getRM8();
    const bits = word ? 16 : 8, msb = word ? 0x8000 : 0x80, mask = word ? 0xffff : 0xff;
    let res = v;
    if (n === 0) {
      // A zero count changes nothing, not even the flags.
      this.cycles += this.eaIsReg ? 8 : 20 + this.eaCycles;
      return;
    }
    switch (this.regf) {
      // The rotates leave SF/ZF/PF/AF alone and compute OF on EVERY count, not
      // just on one: the manual only defines OF for a count of one, but the
      // hardware writes it regardless and the test suite sees it.
      case 0: {                                       // ROL
        const k = n % bits;
        res = k === 0 ? v : ((v << k) | (v >>> (bits - k))) & mask;
        this.cf = res & 1;
        this.of = (((res & msb) ? 1 : 0) ^ this.cf) ? 1 : 0;
        break;
      }
      case 1: {                                       // ROR
        const k = n % bits;
        res = k === 0 ? v : ((v >>> k) | (v << (bits - k))) & mask;
        this.cf = (res & msb) ? 1 : 0;
        this.of = ((((res & msb) ? 1 : 0) ^ ((res & (msb >> 1)) ? 1 : 0)) ? 1 : 0);
        break;
      }
      case 2: {                                       // RCL — the carry is bit N
        const k = n % (bits + 1);
        let acc = v, c = this.cf;
        for (let i = 0; i < k; i++) {
          const nc = (acc & msb) ? 1 : 0;
          acc = ((acc << 1) & mask) | c;
          c = nc;
        }
        res = acc; this.cf = c;
        this.of = (((res & msb) ? 1 : 0) ^ c) ? 1 : 0;
        break;
      }
      case 3: {                                       // RCR
        const k = n % (bits + 1);
        let acc = v, c = this.cf;
        for (let i = 0; i < k; i++) {
          const nc = acc & 1;
          acc = (acc >>> 1) | (c ? msb : 0);
          c = nc;
        }
        res = acc; this.cf = c;
        // The top two bits of the result are the last carry-in and the bit that
        // was above it, so the same expression as ROR gives the rotate-by-one
        // rule and generalises to longer counts.
        this.of = ((((res & msb) ? 1 : 0) ^ ((res & (msb >> 1)) ? 1 : 0)) ? 1 : 0);
        break;
      }
      case 4: {                                       // SHL / SAL
        if (n > bits) { res = 0; this.cf = 0; }
        else { const t = v << n; res = t & mask; this.cf = (t & (mask + 1)) ? 1 : 0; }
        this.of = (((res & msb) ? 1 : 0) ^ this.cf) ? 1 : 0;
        this.setSZPn(res, word);
        // AF is "undefined" and is in fact bit 4 of the result — the auxiliary
        // carry line simply holds whatever the shifter put on it.
        this.af = (res & 0x10) ? 1 : 0;
        break;
      }
      case 5: {                                       // SHR
        // AF is bit 4 of the value the LAST single-bit step consumed, which for
        // a right shift is one place further left than the result.
        this.af = 0;
        if (n > bits) { res = 0; this.cf = 0; }
        else { res = (v >>> n) & mask; this.cf = (v >>> (n - 1)) & 1; }
        this.of = n === 1 ? ((v & msb) ? 1 : 0) : 0;
        this.setSZPn(res, word);
        break;
      }
      case 6: {
        // SETMO / SETMOC. Not in any Intel manual: reg field 6 of the shift
        // group is not decoded, and the microcode entry it lands on drives the
        // operand to all ones. D2/D3 (the CL forms) do nothing when CL is zero,
        // which is why this sits inside the count check.
        res = mask;
        this.cf = 0; this.of = 0; this.af = 0;
        this.setSZPn(res, word);
        break;
      }
      default: {                                      // SAR
        const sv = word ? sign16(v) : sign8(v);
        const k = Math.min(n, bits);
        this.af = 0;
        res = (sv >> k) & mask;
        this.cf = ((sv >> (k - 1)) & 1);
        this.of = 0;
        this.setSZPn(res, word);
        break;
      }
    }
    if (word) this.setRM16(res); else this.setRM8(res);
    const base = this.eaIsReg ? 8 : 20 + this.eaCycles;
    this.cycles += base + (count > 1 ? 4 * n : 0);
  }

  setSZPn(v, word) { if (word) this.setSZP16(v); else this.setSZP8(v); }

  // ---- group 3 (F6/F7): TEST, NOT, NEG, MUL, IMUL, DIV, IDIV -----------------------
  group3(word) {
    this.modrm();
    const ea = this.eaIsReg ? 0 : this.eaCycles;
    switch (this.regf) {
      case 0: case 1: {                               // TEST imm — /1 is an alias
        const a = word ? this.getRM16() : this.getRM8();
        const b = word ? this.fetch16() : this.fetch8();
        const v = a & b;
        if (word) this.setLogic16(v); else this.setLogic8(v);
        this.cycles += this.eaIsReg ? 5 : 11 + ea;
        return;
      }
      case 2: {                                       // NOT — touches no flags
        const a = word ? this.getRM16() : this.getRM8();
        if (word) this.setRM16(~a); else this.setRM8(~a);
        this.cycles += this.eaIsReg ? 3 : 16 + ea;
        return;
      }
      case 3: {                                       // NEG
        const a = word ? this.getRM16() : this.getRM8();
        const v = word ? this.sub16(0, a) : this.sub8(0, a);
        // NEG's carry is "the operand was not zero", which the subtract already
        // produced, and AF likewise. Overflow is the one asymmetric value.
        this.of = a === (word ? 0x8000 : 0x80) ? 1 : 0;
        if (word) this.setRM16(v); else this.setRM8(v);
        this.cycles += this.eaIsReg ? 3 : 16 + ea;
        return;
      }
      case 4: this.mul(word, false); return;
      case 5: this.mul(word, true); return;
      case 6: this.div(word, false); return;
      default: this.div(word, true); return;
    }
  }

  // MUL/IMUL. The manual calls SF/ZF/AF/PF undefined; real silicon is not
  // random about it, and the test suite pins it down: SZP come from the HIGH
  // half of the product for MUL, and AF is left as the microcode found it.
  mul(word, signed) {
    // Same F1-flag story as IDIV: a REP prefix in front of IMUL negates the
    // product. Unsigned MUL skips the sign-correction microcode entirely and
    // is unaffected.
    const flip = signed && this.repPrefix !== 0;
    if (word) {
      const a = this.r[0], b = this.getRM16();
      let p;
      if (signed) p = (sign16(a) * sign16(b)) | 0;
      else p = a * b;
      if (flip) p = -p;
      const lo = p & 0xffff, hi = (signed ? (p >> 16) : Math.floor(p / 65536)) & 0xffff;
      this.r[0] = lo; this.r[REG.DX] = hi;
      const upperUsed = signed
        ? !((hi === 0 && !(lo & 0x8000)) || (hi === 0xffff && (lo & 0x8000)))
        : hi !== 0;
      this.cf = this.of = upperUsed ? 1 : 0;
      // SF/ZF/PF come from the HIGH half — the last thing the multiply
      // microcode's accumulator held. AF is left clear.
      this.setSZP16(hi);
      this.af = 0;
      this.cycles += this.eaIsReg ? (signed ? 128 : 118) : (signed ? 134 : 124) + this.eaCycles;
    } else {
      const a = this.getR8(0), b = this.getRM8();
      let p = signed ? (sign8(a) * sign8(b)) : (a * b);
      if (flip) p = -p;
      const v = p & 0xffff;
      this.r[0] = v;
      const hi = (v >> 8) & 0xff, lo = v & 0xff;
      const upperUsed = signed
        ? !((hi === 0 && !(lo & 0x80)) || (hi === 0xff && (lo & 0x80)))
        : hi !== 0;
      this.cf = this.of = upperUsed ? 1 : 0;
      this.setSZP8(hi);
      this.af = 0;
      this.cycles += this.eaIsReg ? (signed ? 89 : 76) : (signed ? 95 : 82) + this.eaCycles;
    }
  }

  // IDIV divides MAGNITUDES and applies the sign afterwards, which has two
  // consequences no manual mentions:
  //
  //   * the quotient range is -127..127, not -128..127. `IDIV` that would
  //     produce exactly -128 traps, because the magnitude 128 fails the check
  //     before the sign is put back.
  //   * a REP prefix flips the sign correction. The microcode's F1 flag is the
  //     same bit for "repeating" and "negate the result", so `REP IDIV` returns
  //     the negated quotient — a documented-by-experiment 8086 oddity, and the
  //     reason a stray prefix in front of a divide is not harmless.
  div(word, signed) {
    const flip = this.repPrefix !== 0;
    if (word) {
      const b = this.getRM16();
      if (b === 0) { this.divideError(); return; }
      if (signed) {
        const n = ((this.r[REG.DX] << 16) | this.r[0]) | 0;
        const d = sign16(b);
        const nm = Math.abs(n), dm = Math.abs(d);
        const qm = Math.floor(nm / dm), rm = nm % dm;
        if (qm > 0x7fff) { this.divideError(); return; }
        const neg = ((n < 0) !== (d < 0)) !== flip;
        this.r[0] = (neg ? -qm : qm) & 0xffff;
        this.r[REG.DX] = (n < 0 ? -rm : rm) & 0xffff;
      } else {
        const num = ((this.r[REG.DX] << 16) >>> 0) + this.r[0];
        const q = Math.floor(num / b), rem = num % b;
        if (q > 0xffff) { this.divideError(); return; }
        this.r[0] = q & 0xffff; this.r[REG.DX] = rem & 0xffff;
      }
      this.cycles += this.eaIsReg ? (signed ? 184 : 162) : (signed ? 190 : 168) + this.eaCycles;
    } else {
      const b = this.getRM8();
      if (b === 0) { this.divideError(); return; }
      if (signed) {
        const n = sign16(this.r[0]), d = sign8(b);
        const nm = Math.abs(n), dm = Math.abs(d);
        const qm = Math.floor(nm / dm), rm = nm % dm;
        if (qm > 0x7f) { this.divideError(); return; }
        const neg = ((n < 0) !== (d < 0)) !== flip;
        this.setR8(0, (neg ? -qm : qm) & 0xff);
        this.setR8(4, (n < 0 ? -rm : rm) & 0xff);
      } else {
        const n = this.r[0];
        const q = Math.floor(n / b), rem = n % b;
        if (q > 0xff) { this.divideError(); return; }
        this.setR8(0, q); this.setR8(4, rem);
      }
      this.cycles += this.eaIsReg ? (signed ? 112 : 86) : (signed ? 118 : 92) + this.eaCycles;
    }
  }

  // ---- group 4 (FE) and group 5 (FF) -------------------------------------------------
  // FE only defines /0 and /1. The 8086's decoder does not check the rest: the
  // group 5 microcode runs with the operand width still byte-sized for the
  // increment path and word-sized for everything else, so FE /2 really is a
  // near indirect CALL. That is what this reproduces.
  group4() {
    this.modrm();
    const ea = this.eaIsReg ? 0 : this.eaCycles;
    if (this.regf === 0) {
      const a = this.getRM8(), v = (a + 1) & 0xff;
      this.of = a === 0x7f ? 1 : 0; this.af = (v & 0x0f) === 0 ? 1 : 0;
      this.setSZP8(v); this.setRM8(v);
      this.cycles += this.eaIsReg ? 3 : 15 + ea;
      return;
    }
    if (this.regf === 1) {
      const a = this.getRM8(), v = (a - 1) & 0xff;
      this.of = a === 0x80 ? 1 : 0; this.af = (a & 0x0f) === 0 ? 1 : 0;
      this.setSZP8(v); this.setRM8(v);
      this.cycles += this.eaIsReg ? 3 : 15 + ea;
      return;
    }
    this.group5Body(ea);
  }

  group5() { this.modrm(); this.group5Body(this.eaIsReg ? 0 : this.eaCycles); }

  group5Body(ea) {
    const r = this.r;
    switch (this.regf) {
      case 0: {                                       // INC r/m16
        const a = this.getRM16(), v = (a + 1) & 0xffff;
        this.of = a === 0x7fff ? 1 : 0; this.af = (v & 0x0f) === 0 ? 1 : 0;
        this.setSZP16(v); this.setRM16(v);
        this.cycles += this.eaIsReg ? 3 : 15 + ea;
        return;
      }
      case 1: {                                       // DEC r/m16
        const a = this.getRM16(), v = (a - 1) & 0xffff;
        this.of = a === 0x8000 ? 1 : 0; this.af = (a & 0x0f) === 0 ? 1 : 0;
        this.setSZP16(v); this.setRM16(v);
        this.cycles += this.eaIsReg ? 3 : 15 + ea;
        return;
      }
      case 2: {                                       // CALL near indirect
        const t = this.getRM16();
        this.push(this.ip); this.ip = t;
        this.cycles += this.eaIsReg ? 16 : 21 + ea;
        return;
      }
      case 3: {                                       // CALL far indirect
        // A register form has no far pointer to read; the 8086 uses the EA
        // adder's stale contents. Taking the register as the offset and the
        // word above it as the segment is what the reference emulators do.
        const o = this.eaIsReg ? r[this.rm] : this.rd16(this.eaSeg, this.ea);
        const sg = this.eaIsReg ? this.s[SREG.CS] : this.rd16(this.eaSeg, (this.ea + 2) & 0xffff);
        this.push(this.s[SREG.CS]); this.push(this.ip);
        this.ip = o; this.s[SREG.CS] = sg;
        this.cycles += 37 + ea;
        return;
      }
      case 4: this.ip = this.getRM16(); this.cycles += this.eaIsReg ? 11 : 18 + ea; return;
      case 5: {                                       // JMP far indirect
        const o = this.eaIsReg ? r[this.rm] : this.rd16(this.eaSeg, this.ea);
        const sg = this.eaIsReg ? this.s[SREG.CS] : this.rd16(this.eaSeg, (this.ea + 2) & 0xffff);
        this.ip = o; this.s[SREG.CS] = sg;
        this.cycles += 24 + ea;
        return;
      }
      // /6 is PUSH, and /7 is not decoded — it does the same thing. The
      // register form goes through pushFrom for the `PUSH SP` quirk.
      default:
        if (this.eaIsReg) this.pushFrom(this.rm);
        else this.push(this.rd16(this.eaSeg, this.ea));
        this.cycles += this.eaIsReg ? 11 : 16 + ea;
        return;
    }
  }

  // ---- string instructions -------------------------------------------------------
  // One iteration per pass, looped here rather than in step(), with a check for
  // a pending interrupt at each boundary: a REP MOVSW of 65535 words must not
  // hold off the timer for a whole frame. When we do break out, IP goes back to
  // the first prefix byte, which is exactly how the real part resumes.
  string(op) {
    const r = this.r;
    const rep = this.repPrefix;
    const word = (op & 1) !== 0;
    const delta = (this.df ? -1 : 1) * (word ? 2 : 1);
    const src = this.dataSeg();          // MOVS/CMPS/LODS source, overridable
    let iterations = 0;

    for (;;) {
      if (rep) {
        if (r[REG.CX] === 0) break;
      }
      switch (op) {
        case 0xa4: this.wr8(SREG.ES, r[REG.DI], this.rd8(src, r[REG.SI])); this.cycles += 18; break;
        case 0xa5: this.wr16(SREG.ES, r[REG.DI], this.rd16(src, r[REG.SI])); this.cycles += 18; break;
        case 0xa6: this.sub8(this.rd8(src, r[REG.SI]), this.rd8(SREG.ES, r[REG.DI])); this.cycles += 22; break;
        case 0xa7: this.sub16(this.rd16(src, r[REG.SI]), this.rd16(SREG.ES, r[REG.DI])); this.cycles += 22; break;
        case 0xaa: this.wr8(SREG.ES, r[REG.DI], this.getR8(0)); this.cycles += 11; break;
        case 0xab: this.wr16(SREG.ES, r[REG.DI], r[0]); this.cycles += 11; break;
        case 0xac: this.setR8(0, this.rd8(src, r[REG.SI])); this.cycles += 12; break;
        case 0xad: r[0] = this.rd16(src, r[REG.SI]); this.cycles += 12; break;
        case 0xae: this.sub8(this.getR8(0), this.rd8(SREG.ES, r[REG.DI])); this.cycles += 15; break;
        case 0xaf: this.sub16(r[0], this.rd16(SREG.ES, r[REG.DI])); this.cycles += 15; break;
        case 0x6c: this.wr8(SREG.ES, r[REG.DI], this._in8(r[REG.DX])); this.cycles += 14; break;
        case 0x6d: this.wr16(SREG.ES, r[REG.DI], this._in16(r[REG.DX])); this.cycles += 14; break;
        case 0x6e: this._out8(r[REG.DX], this.rd8(src, r[REG.SI])); this.cycles += 14; break;
        default: this._out16(r[REG.DX], this.rd16(src, r[REG.SI])); this.cycles += 14; break;
      }
      // Which pointers move depends on which side of the transfer they are on.
      switch (op) {
        case 0xa4: case 0xa5: case 0xa6: case 0xa7:
          r[REG.SI] = (r[REG.SI] + delta) & 0xffff;
          r[REG.DI] = (r[REG.DI] + delta) & 0xffff;
          break;
        case 0xaa: case 0xab: case 0xae: case 0xaf:
        case 0x6c: case 0x6d:
          r[REG.DI] = (r[REG.DI] + delta) & 0xffff;
          break;
        default:
          r[REG.SI] = (r[REG.SI] + delta) & 0xffff;
          break;
      }

      if (!rep) return;
      r[REG.CX] = (r[REG.CX] - 1) & 0xffff;
      // CMPS and SCAS test the flag; the rest just count. REPNE on a
      // non-comparing string instruction behaves exactly like REP.
      const compares = (op >= 0xa6 && op <= 0xa7) || (op >= 0xae && op <= 0xaf);
      if (compares) {
        const want = rep === 0xf3 ? 1 : 0;
        if ((this.zf ? 1 : 0) !== want) return;
      }
      if (r[REG.CX] === 0) return;

      // Interruptible between iterations. Rewinding to the prefix is what makes
      // the resume correct — the segment override and the REP both have to be
      // seen again.
      if ((this.if_ && this.irq) || this.nmi) { this.ip = this._instStart; return; }
      if (++iterations > 0x10000) return;   // a CX that cannot happen; do not hang
    }
  }

  // ---- V30 (µPD70116) extensions -----------------------------------------------
  // The 80186-common half of the V30's additions. NEC's own mnemonic names are
  // different (PUSH R, PREPARE, DISPOSE) but the encodings are the 186's.
  v30Block60(op) {
    const r = this.r;
    switch (op) {
      case 0x60: {                                    // PUSHA
        const sp = r[REG.SP];
        for (let i = 0; i < 8; i++) this.push(i === REG.SP ? sp : r[i]);
        this.cycles += 36; return;
      }
      case 0x61: {                                    // POPA — SP's slot is discarded
        for (let i = 7; i >= 0; i--) { const v = this.pop(); if (i !== REG.SP) r[i] = v; }
        this.cycles += 51; return;
      }
      case 0x62: {                                    // BOUND
        this.modrm();
        const idx = sign16(r[this.regf]);
        const lo = sign16(this.rd16(this.eaSeg, this.ea));
        const hi = sign16(this.rd16(this.eaSeg, (this.ea + 2) & 0xffff));
        this.cycles += 33 + this.eaCycles;
        if (idx < lo || idx > hi) this.interrupt(VEC.BOUND);
        return;
      }
      case 0x66: case 0x67: {                         // FPO2
        // These bytes became the operand/address-size prefixes on the 386,
        // but on a V30 they are escapes for the never-shipped µPD72291. PC-98
        // firmware deliberately uses the collision to distinguish the CPUs.
        // A memory form has no CPU-visible effect; a register form takes vector
        // 7 and reports the instruction's first byte as the return address.
        this.modrm();
        if (this.eaIsReg) {
          this.ip = this._instStart;
          this.interrupt(7);
          this.cycles += 50;
        } else {
          this.cycles += 11 + this.eaCycles;
        }
        return;
      }
      case 0x68: this.push(this.fetch16()); this.cycles += 10; return;
      case 0x69: {                                    // IMUL r16, r/m16, imm16
        this.modrm();
        const a = sign16(this.getRM16()), b = sign16(this.fetch16());
        const p = a * b;
        r[this.regf] = p & 0xffff;
        const fits = p >= -32768 && p <= 32767;
        this.cf = this.of = fits ? 0 : 1;
        this.setSZP16(p & 0xffff);
        this.cycles += 30 + this.eaCycles; return;
      }
      case 0x6a: this.push(sign8(this.fetch8()) & 0xffff); this.cycles += 10; return;
      case 0x6b: {                                    // IMUL r16, r/m16, imm8
        this.modrm();
        const a = sign16(this.getRM16()), b = sign8(this.fetch8());
        const p = a * b;
        r[this.regf] = p & 0xffff;
        const fits = p >= -32768 && p <= 32767;
        this.cf = this.of = fits ? 0 : 1;
        this.setSZP16(p & 0xffff);
        this.cycles += 25 + this.eaCycles; return;
      }
      default: this.string(op); return;               // 6C-6F: INS/OUTS
    }
  }

  // ENTER: build a stack frame with `level` copies of the enclosing frames'
  // pointers. Level 0 is the common case and is just PUSH BP / MOV BP,SP / SUB.
  enter() {
    const r = this.r;
    const size = this.fetch16();
    const level = this.fetch8() & 0x1f;
    this.push(r[REG.BP]);
    const frame = r[REG.SP];
    for (let i = 1; i < level; i++) {
      r[REG.BP] = (r[REG.BP] - 2) & 0xffff;
      this.push(this.rd16(SREG.SS, r[REG.BP]));
    }
    if (level > 0) this.push(frame);
    r[REG.BP] = frame;
    r[REG.SP] = (frame - size) & 0xffff;
    this.cycles += 15 + level * 4;
  }

  // NEC's 0x0F group: bit manipulation, packed-decimal strings and nibble
  // rotates. The bit instructions take their position from CL or an immediate,
  // and the register-form encodings reuse the ModRM byte for the width.
  v30Group() {
    const sub = this.fetch8();
    const r = this.r;
    switch (sub) {
      case 0x10: this.bitOp('test', false, false); return;   // TEST1 r/m8, CL
      case 0x11: this.bitOp('test', true, false); return;
      case 0x12: this.bitOp('clr', false, false); return;    // CLR1
      case 0x13: this.bitOp('clr', true, false); return;
      case 0x14: this.bitOp('set', false, false); return;    // SET1
      case 0x15: this.bitOp('set', true, false); return;
      case 0x16: this.bitOp('not', false, false); return;    // NOT1
      case 0x17: this.bitOp('not', true, false); return;
      case 0x18: this.bitOp('test', false, true); return;    // ...with imm8
      case 0x19: this.bitOp('test', true, true); return;
      case 0x1a: this.bitOp('clr', false, true); return;
      case 0x1b: this.bitOp('clr', true, true); return;
      case 0x1c: this.bitOp('set', false, true); return;
      case 0x1d: this.bitOp('set', true, true); return;
      case 0x1e: this.bitOp('not', false, true); return;
      case 0x1f: this.bitOp('not', true, true); return;
      case 0x20: {                                    // ADD4S: BCD string add
        this.decimalString('add'); return;
      }
      case 0x22: this.decimalString('sub'); return;
      case 0x26: this.decimalString('cmp'); return;
      case 0x28: {                                    // ROL4 r/m8 — nibble rotate
        this.modrm();
        const v = this.getRM8(), al = this.getR8(0);
        this.setRM8(((v << 4) | (al & 0x0f)) & 0xff);
        this.setR8(0, (al & 0xf0) | ((v >> 4) & 0x0f));
        this.cycles += 25; return;
      }
      case 0x2a: {                                    // ROR4 r/m8
        this.modrm();
        const v = this.getRM8(), al = this.getR8(0);
        this.setRM8(((al << 4) | (v >> 4)) & 0xff);
        this.setR8(0, (al & 0xf0) | (v & 0x0f));
        this.cycles += 29; return;
      }
      case 0x31: case 0x39: {                         // INS: insert a bit field
        this.modrm();
        this.cycles += 40; return;                    // accepted, not modelled
      }
      case 0x33: case 0x3b: {                         // EXT: extract a bit field
        this.modrm();
        this.cycles += 40; return;
      }
      case 0xff: {                                    // BRKEM: 8080 emulation mode
        this.fetch8();
        this.cycles += 38; return;                    // there is no 8080 in here
      }
      default:
        this.cycles += 2; return;
    }
  }

  bitOp(kind, word, immediate) {
    this.modrm();
    const bits = word ? 16 : 8;
    const pos = (immediate ? this.fetch8() : this.getR8(1)) % bits;
    const v = word ? this.getRM16() : this.getRM8();
    const bit = (v >> pos) & 1;
    switch (kind) {
      case 'test': this.zf = bit ? 0 : 1; this.cf = 0; this.of = 0; break;
      case 'clr': { const nv = v & ~(1 << pos); if (word) this.setRM16(nv); else this.setRM8(nv); break; }
      case 'set': { const nv = v | (1 << pos); if (word) this.setRM16(nv); else this.setRM8(nv); break; }
      default: { const nv = v ^ (1 << pos); if (word) this.setRM16(nv); else this.setRM8(nv); break; }
    }
    this.cycles += 4 + this.eaCycles;
  }

  // ADD4S / SUB4S / CMP4S: CL nibbles of packed BCD at DS:SI and ES:DI.
  decimalString(kind) {
    const r = this.r;
    const nibbles = this.getR8(1) & 0xff;
    const bytes = (nibbles + 1) >> 1;
    let carry = 0, zero = 1;
    for (let i = 0; i < bytes; i++) {
      const a = this.rd8(this.dataSeg(), (r[REG.SI] + i) & 0xffff);
      const b = this.rd8(SREG.ES, (r[REG.DI] + i) & 0xffff);
      let lo, hi;
      if (kind === 'add') {
        lo = (a & 0x0f) + (b & 0x0f) + carry;
        carry = lo > 9 ? 1 : 0; if (carry) lo -= 10;
        hi = ((a >> 4) & 0x0f) + ((b >> 4) & 0x0f) + carry;
        carry = hi > 9 ? 1 : 0; if (carry) hi -= 10;
      } else {
        lo = (a & 0x0f) - (b & 0x0f) - carry;
        carry = lo < 0 ? 1 : 0; if (carry) lo += 10;
        hi = ((a >> 4) & 0x0f) - ((b >> 4) & 0x0f) - carry;
        carry = hi < 0 ? 1 : 0; if (carry) hi += 10;
      }
      const res = ((hi & 0x0f) << 4) | (lo & 0x0f);
      if (res !== 0) zero = 0;
      if (kind !== 'cmp') this.wr8(this.dataSeg(), (r[REG.SI] + i) & 0xffff, res);
    }
    this.cf = carry; this.zf = zero;
    this.cycles += 7 + bytes * 19;
  }

  // ---- snapshot ---------------------------------------------------------------
  // Plain data, no memory. The host's rewind ring holds one of these per frame,
  // so this is about 40 numbers and stays there.
  snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      r: Array.from(this.r), s: Array.from(this.s), ip: this.ip,
      flags: this.getFlags(),
      halted: this.halted, irq: this.irq, nmi: this.nmi,
      intInhibit: this.intInhibit, trapArmed: this.trapArmed,
      cycles: this.cycles, v30: this.v30,
    };
  }

  restore(st) {
    this.r.set(st.r); this.s.set(st.s); this.ip = st.ip | 0;
    this.setFlags(st.flags);
    this.halted = !!st.halted; this.irq = !!st.irq; this.nmi = !!st.nmi;
    this.intInhibit = !!st.intInhibit; this.trapArmed = !!st.trapArmed;
    this.cycles = st.cycles | 0;
    return this;
  }
}

export default I8086;
