// m6502 — MOS 6502 CPU core (the Famicom's 2A03 minus the sound hardware).
// Pure JS, zero deps, deterministic.
//
// The companion to z80.js: same shape (inject a bus, call step(), get
// T-states back, snapshot the register file), different chip. Where the
// Z80 is a big orthogonal instruction set with few timing surprises, the
// 6502 is a tiny instruction set whose *timing* is the interesting part —
// and NES games depend on that timing to the cycle, because the video chip
// runs at exactly 3x the CPU clock and games change scroll registers in
// the middle of a scanline.
//
// So this core does not carry a per-opcode cycle table. Instead every bus
// access costs one cycle, exactly as on the real chip, and the internal
// cycles are spent where the chip spends them:
//
//   - Indexed reads (abs,X / abs,Y / (zp),Y) read the WRONG address first
//     when the index carries into a new page, then re-read the right one.
//     That is the famous "+1 on page cross", and the bogus read is real:
//     it is why reading $2007 through abs,X can advance the PPU address
//     twice, and why MMC3's scanline counter can be clocked by a read that
//     the programmer never intended.
//   - Read-modify-write instructions (INC/DEC/ASL/ROL/LSR/ROR and the
//     illegal RMWs) write the OLD value back before the new one. Games use
//     that double write on purpose: `INC $4017` or an RMW on a mapper
//     register hits the register twice in two cycles.
//   - Indexed writes always pay the dummy read, page cross or not.
//
// Get those right and the cycle counts are automatically right, which is
// what lets nestest.log line up to the cycle (see nestools/nestest.mjs).
//
// Coverage: all 151 documented opcodes plus the illegal opcodes real games
// use — LAX/SAX/DCP/ISC/SLO/RLA/SRE/RRA, the multi-byte NOPs, ANC/ALR/ARR/
// SBX, and the unstable "&(H+1)" stores (SHA/SHX/SHY/TAS/LAS/ANE/LXA),
// which are approximated and documented in docs/nes-design.md. Decimal
// mode is implemented but OFF by default: the 2A03 has the BCD adder
// disabled in silicon, so `new M6502(bus)` behaves like a Famicom CPU and
// `new M6502(bus, { decimal: true })` like a plain NMOS 6502.
//
// Suite contract: no Math.random, same program + same bus -> identical
// state. getState()/setState() are exact inverses (see snapshot()).

export const SCHEMA_VERSION = 1;

// Status register bits. FB ("break") is not a real flip-flop: it only
// exists in the byte pushed on the stack, which is how a handler tells a
// BRK from an IRQ. We keep it clear in `p` and OR it in when pushing.
export const FC = 0x01, FZ = 0x02, FI = 0x04, FD = 0x08;
export const FB = 0x10, FU = 0x20, FV = 0x40, FN = 0x80;

export const NMI_VECTOR = 0xfffa, RESET_VECTOR = 0xfffc, IRQ_VECTOR = 0xfffe;

const sign8 = (v) => (v << 24) >> 24;

export class M6502 {
  constructor(bus, opts = {}) {
    this.bus = bus;
    // The 2A03 ties the decimal adder off. Keep the option so the core is
    // still a general 6502 for anything else in the suite.
    this.decimal = !!opts.decimal;
    this.powerOn();
  }

  // Power-on state WITHOUT touching the bus: a machine's bus closure often
  // is not wired up yet when the CPU object is constructed, and reading the
  // reset vector too early would latch garbage. reset() does the real thing.
  powerOn() {
    this.a = 0; this.x = 0; this.y = 0;
    this.s = 0xfd;
    this.p = FI | FU;
    this.pc = 0;
    this.cycles = 0;
    this.nmiPending = false; // edge-triggered: set once per falling edge
    this.nmiLine = false;    // last level seen by setNmi(), for edge detection
    this.irqLine = 0;        // level-triggered: how many sources hold it low
    this.jammed = false;     // a KIL/JAM opcode froze the chip
    this._iHold = -1;        // SEI/CLI/PLP defer their effect by one instruction
    // Per-cycle shadow of "an IRQ would be taken right now". The chip samples
    // the interrupt lines every cycle, not only between instructions; the two
    // places where that is observable are the taken-branch delay below and the
    // vector hijacking in _interrupt(). Keeping a one-cycle history is enough
    // for both, and far cheaper than threading a poll point through every
    // addressing mode.
    this._runIrq = false;
    this._runIrqPrev = false;
    this._irqSeen = 0;       // the lines as the CPU last saw them (not during DMA)
    this._nmiSeen = false;
    this._stallSeen = false; this._stallIrq = 0; this._stallNmi = false;
    this._irqDelay = false;  // one instruction of IRQ suppression (taken branch)
    this._nmiDelay = false;  // one instruction of NMI suppression (after BRK)
    return this;
  }

  // RESET: the chip spends 7 cycles doing dummy reads, decrements S three
  // times (as if pushing PC and P, but with writes suppressed), sets I, and
  // jumps through $FFFC. Emulators that just assign S=0xFD get the common
  // case right; doing the decrements keeps a warm reset honest.
  reset() {
    this._rd(this.pc); this._rd(this.pc);
    this._rd(0x0100 | this.s); this.s = (this.s - 1) & 0xff;
    this._rd(0x0100 | this.s); this.s = (this.s - 1) & 0xff;
    this._rd(0x0100 | this.s); this.s = (this.s - 1) & 0xff;
    this.p |= FI;
    this.pc = this._rd(RESET_VECTOR) | (this._rd(RESET_VECTOR + 1) << 8);
    this.jammed = false;
    this.nmiPending = false;
    this._iHold = -1;
    this._irqDelay = false;
    this._nmiDelay = false;
    this._nmiSeen = false;
    return this;
  }

  // ---- interrupt lines -----------------------------------------------------
  // NMI is edge-triggered: the PPU pulls the line low at the start of vblank
  // and holds it, so a level-based check would fire every instruction until
  // the handler read $2002. Callers that model the line use setNmi(level);
  // callers that just want "fire one NMI" use nmi().
  // Driving a line also updates what the CPU "has seen" (see _endCycle): a
  // caller with no bus — a unit test, or a machine asserting a line from
  // outside a cycle — must not have to know about the DMA bookkeeping. The
  // stall latch in _endCycle() still wins where it matters.
  nmi() { this.nmiPending = true; this._nmiSeen = true; }

  setNmi(level) {
    if (level && !this.nmiLine) { this.nmiPending = true; this._nmiSeen = true; }
    this.nmiLine = !!level;
  }

  // IRQ is level-triggered and wire-ORed between sources (APU frame counter,
  // DMC, mapper). Track it as a count so one source releasing does not clear
  // another's request.
  irq(level = true) { this.irqLine = level ? 1 : 0; this._irqSeen = this.irqLine; }
  setIrqSource(bit, level) {
    this.irqLine = level ? (this.irqLine | (1 << bit)) : (this.irqLine & ~(1 << bit));
    this._irqSeen = this.irqLine;
  }

  // ---- bus -----------------------------------------------------------------
  // One access = one cycle. Nothing else in this core increments `cycles`,
  // which is what makes the totals match hardware for free.
  _rd(a) { this.cycles++; const v = this.bus.read(a & 0xffff) & 0xff; this._endCycle(); return v; }
  _wr(a, v) { this.cycles++; this.bus.write(a & 0xffff, v & 0xff); this._endCycle(); }

  // Called after every bus access, i.e. once per cycle. The machine drives the
  // interrupt lines from inside bus.read/bus.write (that is where the PPU and
  // APU advance), so by the time we get here the lines carry this cycle's
  // level. Remembering the previous cycle's answer is what lets _branch() tell
  // "the IRQ was already there" from "it arrived during this instruction".
  // It also latches what the interrupt logic actually saw. That matters
  // because the CPU does NOT run these on every machine cycle: while a DMA
  // controller holds RDY low (OAM DMA, DMC sample fetch) the processor is
  // halted and polls nothing, so a line that asserts inside the halt is
  // invisible until the *next* instruction polls for itself — one whole
  // instruction later than a naive "look at the wire at the boundary" model.
  // blargg's 4-irq_and_dma measures exactly that instruction.
  _endCycle() {
    this._runIrqPrev = this._runIrq;
    this._runIrq = this.irqLine !== 0 && !(this.p & FI);
    if (this._stallSeen) {
      this._irqSeen = this._stallIrq;
      this._nmiSeen = this._stallNmi;
      this._stallSeen = false;
    } else {
      this._irqSeen = this.irqLine;
      this._nmiSeen = this.nmiPending;
    }
  }

  // The machine calls this when a DMA controller is about to take the bus:
  // OAM DMA ($4014, 513 cycles) or a DMC sample fetch (4). RDY goes low and
  // the processor stops — it does not execute and it does not poll. So the
  // boundary that ends the halted cycle must report the lines as they were
  // BEFORE the stall, not after; the interrupt is picked up one instruction
  // later, by the next instruction's own poll. Latched here because the
  // machine performs the stall from inside the very bus access that triggered
  // it, so by the time _endCycle() runs the wire has already changed.
  stallForDma() {
    if (this._stallSeen) return; // a DMC fetch nested inside an OAM DMA
    this._stallSeen = true;
    this._stallIrq = this.irqLine;
    this._stallNmi = this.nmiPending;
  }
  _fetch() { const v = this._rd(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  _push(v) { this._wr(0x0100 | this.s, v); this.s = (this.s - 1) & 0xff; }
  _pull() { this.s = (this.s + 1) & 0xff; return this._rd(0x0100 | this.s); }
  _peekStack() { this._rd(0x0100 | this.s); } // the chip's "dummy stack read" cycle

  // ---- addressing modes ----------------------------------------------------
  // Each returns the effective address and has consumed every cycle up to
  // (but not including) the data access itself.
  _aZp() { return this._fetch(); }

  _aZpX() { const z = this._fetch(); this._rd(z); return (z + this.x) & 0xff; }
  _aZpY() { const z = this._fetch(); this._rd(z); return (z + this.y) & 0xff; }

  _aAbs() { const lo = this._fetch(); return lo | (this._fetch() << 8); }

  // `always` = write/RMW form: the dummy read happens whether or not the
  // index carried, because the chip has already committed the cycle.
  _aAbsIdx(idx, always) {
    const lo = this._fetch(), hi = this._fetch();
    const base = lo | (hi << 8);
    const addr = (base + idx) & 0xffff;
    if (always || ((base ^ addr) & 0xff00)) this._rd((base & 0xff00) | (addr & 0xff));
    return addr;
  }

  // (zp,X): the pointer add wraps inside page zero — a classic source of
  // bugs in game code, and one emulators must reproduce, not fix.
  _aIndX() {
    const z = this._fetch();
    this._rd(z);
    const p = (z + this.x) & 0xff;
    return this._rd(p) | (this._rd((p + 1) & 0xff) << 8);
  }

  _aIndY(always) {
    const z = this._fetch();
    const base = this._rd(z) | (this._rd((z + 1) & 0xff) << 8);
    const addr = (base + this.y) & 0xffff;
    if (always || ((base ^ addr) & 0xff00)) this._rd((base & 0xff00) | (addr & 0xff));
    return addr;
  }

  // ---- ALU / flags ---------------------------------------------------------
  _nz(v) {
    this.p = (this.p & ~(FN | FZ)) | (v & 0x80) | (v === 0 ? FZ : 0);
    return v;
  }

  _adc(v) {
    const a = this.a, c = this.p & FC;
    if (this.decimal && (this.p & FD)) {
      // NMOS BCD: Z comes from the binary result, N and V from the value
      // after the low-nibble fixup but before the high one. Quirky, and
      // exactly what a real 6502 (not a 65C02) does.
      const bin = (a + v + c) & 0xff;
      let lo = (a & 0x0f) + (v & 0x0f) + c;
      let hi = (a >> 4) + (v >> 4);
      if (lo > 9) { lo += 6; hi++; }
      const mid = ((hi << 4) | (lo & 0x0f)) & 0xff;
      this.p &= ~(FN | FV | FZ | FC);
      this.p |= (mid & 0x80) | (bin === 0 ? FZ : 0)
        | ((~(a ^ v) & (a ^ mid) & 0x80) ? FV : 0);
      if (hi > 9) hi += 6;
      if (hi > 15) this.p |= FC;
      this.a = ((hi << 4) | (lo & 0x0f)) & 0xff;
      return;
    }
    const r = a + v + c;
    this.a = r & 0xff;
    this.p = (this.p & ~(FN | FV | FZ | FC)) | (this.a & 0x80) | (this.a === 0 ? FZ : 0)
      | ((~(a ^ v) & (a ^ this.a) & 0x80) ? FV : 0) | (r > 0xff ? FC : 0);
  }

  _sbc(v) {
    if (this.decimal && (this.p & FD)) {
      const a = this.a, c = this.p & FC ? 1 : 0;
      const r = a - v - (1 - c);
      let lo = (a & 0x0f) - (v & 0x0f) - (1 - c);
      let hi = (a >> 4) - (v >> 4);
      if (lo & 0x10) { lo -= 6; hi--; }
      if (hi & 0x10) hi -= 6;
      // flags on NMOS SBC are the binary ones even in decimal mode
      this.p = (this.p & ~(FN | FV | FZ | FC)) | (r & 0x80) | ((r & 0xff) === 0 ? FZ : 0)
        | (((a ^ v) & (a ^ r) & 0x80) ? FV : 0) | (r >= 0 ? FC : 0);
      this.a = ((hi << 4) | (lo & 0x0f)) & 0xff;
      return;
    }
    this._adc(v ^ 0xff); // SBC is ADC of the complement; carry is /borrow
  }

  _cmp(r, v) {
    const d = (r - v) & 0xff;
    this.p = (this.p & ~(FN | FZ | FC)) | (d & 0x80) | (d === 0 ? FZ : 0) | (r >= v ? FC : 0);
  }

  _bit(v) {
    // BIT is the odd one: N and V are copied straight out of the operand's
    // top two bits (that is how games poll $2002 with a single BIT).
    this.p = (this.p & ~(FN | FV | FZ)) | (v & 0xc0) | ((this.a & v) === 0 ? FZ : 0);
  }

  _asl(v) { this.p = (this.p & ~FC) | ((v >> 7) & 1); return this._nz((v << 1) & 0xff); }
  _lsr(v) { this.p = (this.p & ~FC) | (v & 1); return this._nz(v >> 1); }
  _rol(v) { const c = this.p & FC; this.p = (this.p & ~FC) | ((v >> 7) & 1); return this._nz(((v << 1) | c) & 0xff); }
  _ror(v) { const c = (this.p & FC) << 7; this.p = (this.p & ~FC) | (v & 1); return this._nz((v >> 1) | c); }

  // Read, write the old value back, then write the new one — the real
  // three-cycle RMW tail. Games rely on the doubled write hitting mapper
  // and APU registers twice.
  _rmw(addr, fn) {
    const v = this._rd(addr);
    this._wr(addr, v);
    this._wr(addr, fn.call(this, v));
  }

  _branch(taken) {
    const off = this._fetch();
    if (!taken) return;
    // "A taken non-page-crossing branch ignores IRQ during its last clock, so
    // the next instruction executes before the IRQ." The chip polls at the
    // second-to-last cycle; on a 3-cycle branch that is the operand fetch, so
    // an IRQ that only asserted during that fetch is not seen and slips a whole
    // instruction. blargg's 5-branch_delays_irq measures exactly this, and a
    // core that takes the IRQ one instruction early breaks raster splits that
    // are timed off an IRQ landing inside a delay loop.
    const before = this._runIrq;
    this._rd(this.pc); // the chip already started fetching the next opcode
    // "During its last clock": the comparison is against the level as it was
    // before that clock, so only an IRQ that arrived *inside* it is ignored.
    const late = this._runIrq && !before;
    const target = (this.pc + sign8(off)) & 0xffff;
    if ((target & 0xff00) !== (this.pc & 0xff00)) {
      // The page-cross fixup cycle gives the chip another poll, so the delay
      // does not apply — which is why the quirk is specific to branches that
      // stay inside a page.
      this._rd((this.pc & 0xff00) | (target & 0xff));
    } else if (late) {
      this._irqDelay = true;
    }
    this.pc = target;
  }

  // SEI/CLI/PLP change I in their last cycle, one cycle after the interrupt
  // logic has already sampled it — so the new masking takes effect one
  // instruction late. `CLI; <one more instruction>; <IRQ>` is a real pattern.
  // RTI does NOT defer: it pulls P early enough to matter immediately.
  _deferI(oldI) { this._iHold = oldI; }

  // ---- interrupt entry -----------------------------------------------------
  // The sequence is the same seven cycles for BRK, IRQ and NMI; only the two
  // vector fetches at the end differ. That is not a simplification, it is the
  // hardware: the chip does not decide which vector to use until it is about to
  // fetch it. So an NMI that arrives while a BRK or an IRQ is already pushing
  // state "hijacks" the sequence — the stack ends up looking like a BRK/IRQ
  // entry but control goes to the NMI handler. blargg's 2-nmi_and_brk and
  // 3-nmi_and_irq exist for this and nothing else.
  _interrupt(vector, fromBrk) {
    if (!fromBrk) { this._rd(this.pc); this._rd(this.pc); } // two dummy fetches
    this._push((this.pc >> 8) & 0xff);
    this._push(this.pc & 0xff);
    this._push((this.p | FU | (fromBrk ? FB : 0)) & (fromBrk ? 0xff : ~FB));
    // The vector is chosen here, after the status push and just before the
    // fetch — five cycles into the sequence. That window width is what
    // 2-nmi_and_brk prints: five of its ten delays must hijack, and moving this
    // check one cycle either way turns it into four or six.
    if (this.nmiPending && vector === IRQ_VECTOR) { this.nmiPending = false; vector = NMI_VECTOR; }
    this.p |= FI;
    this.pc = this._rd(vector) | (this._rd(vector + 1) << 8);
    this._iHold = -1;
    // An interrupt sequence does not poll for interrupts itself, so at least
    // one instruction of the handler always runs before the next one is taken.
    // Without this, an NMI arriving during a BRK or IRQ entry re-enters
    // immediately and the handler never sees its own first instruction — which
    // is the difference 3-nmi_and_irq prints as "the NMI saw the flags before
    // the handler's SEC" instead of after it.
    this._nmiDelay = true;
  }

  // ---- execution -----------------------------------------------------------
  // One instruction (or one interrupt entry). Returns cycles consumed, so a
  // caller can drive the PPU/APU at 3x / 1x without knowing the opcode.
  step() {
    if (this.jammed) { this.cycles++; return 1; }
    const start = this.cycles;

    // The mask the interrupt logic sees: normally the live I flag, but the
    // instruction just retired may have deferred its change (see _deferI).
    const iMask = this._iHold >= 0 ? this._iHold : (this.p & FI);
    this._iHold = -1;
    // Both suppressions last exactly one instruction boundary; consume them
    // here so a second boundary sees the interrupt normally.
    const nmiDelay = this._nmiDelay, irqDelay = this._irqDelay;
    this._nmiDelay = false; this._irqDelay = false;

    if (this._nmiSeen && this.nmiPending && !nmiDelay) {
      this.nmiPending = false;
      this._interrupt(NMI_VECTOR, false);
      return this.cycles - start;
    }
    if (this._irqSeen && !iMask && !irqDelay) {
      this._interrupt(IRQ_VECTOR, false);
      return this.cycles - start;
    }

    this._exec(this._fetch());
    return this.cycles - start;
  }

  // Run for at least `cycles` CPU cycles; returns the cycles actually spent
  // (instructions are atomic, so it usually overshoots by a few).
  run(cycles) {
    const start = this.cycles;
    while (this.cycles - start < cycles) this.step();
    return this.cycles - start;
  }

  _exec(op) {
    let a; // effective address scratch
    switch (op) {
      // ---- loads / stores --------------------------------------------------
      case 0xa9: this.a = this._nz(this._fetch()); break;                          // LDA #
      case 0xa5: this.a = this._nz(this._rd(this._aZp())); break;
      case 0xb5: this.a = this._nz(this._rd(this._aZpX())); break;
      case 0xad: this.a = this._nz(this._rd(this._aAbs())); break;
      case 0xbd: this.a = this._nz(this._rd(this._aAbsIdx(this.x, false))); break;
      case 0xb9: this.a = this._nz(this._rd(this._aAbsIdx(this.y, false))); break;
      case 0xa1: this.a = this._nz(this._rd(this._aIndX())); break;
      case 0xb1: this.a = this._nz(this._rd(this._aIndY(false))); break;

      case 0xa2: this.x = this._nz(this._fetch()); break;                          // LDX #
      case 0xa6: this.x = this._nz(this._rd(this._aZp())); break;
      case 0xb6: this.x = this._nz(this._rd(this._aZpY())); break;
      case 0xae: this.x = this._nz(this._rd(this._aAbs())); break;
      case 0xbe: this.x = this._nz(this._rd(this._aAbsIdx(this.y, false))); break;

      case 0xa0: this.y = this._nz(this._fetch()); break;                          // LDY #
      case 0xa4: this.y = this._nz(this._rd(this._aZp())); break;
      case 0xb4: this.y = this._nz(this._rd(this._aZpX())); break;
      case 0xac: this.y = this._nz(this._rd(this._aAbs())); break;
      case 0xbc: this.y = this._nz(this._rd(this._aAbsIdx(this.x, false))); break;

      case 0x85: this._wr(this._aZp(), this.a); break;                             // STA
      case 0x95: this._wr(this._aZpX(), this.a); break;
      case 0x8d: this._wr(this._aAbs(), this.a); break;
      case 0x9d: this._wr(this._aAbsIdx(this.x, true), this.a); break;
      case 0x99: this._wr(this._aAbsIdx(this.y, true), this.a); break;
      case 0x81: this._wr(this._aIndX(), this.a); break;
      case 0x91: this._wr(this._aIndY(true), this.a); break;

      case 0x86: this._wr(this._aZp(), this.x); break;                             // STX
      case 0x96: this._wr(this._aZpY(), this.x); break;
      case 0x8e: this._wr(this._aAbs(), this.x); break;

      case 0x84: this._wr(this._aZp(), this.y); break;                             // STY
      case 0x94: this._wr(this._aZpX(), this.y); break;
      case 0x8c: this._wr(this._aAbs(), this.y); break;

      // ---- transfers / stack ------------------------------------------------
      case 0xaa: this._rd(this.pc); this.x = this._nz(this.a); break;              // TAX
      case 0xa8: this._rd(this.pc); this.y = this._nz(this.a); break;              // TAY
      case 0x8a: this._rd(this.pc); this.a = this._nz(this.x); break;              // TXA
      case 0x98: this._rd(this.pc); this.a = this._nz(this.y); break;              // TYA
      case 0xba: this._rd(this.pc); this.x = this._nz(this.s); break;              // TSX
      case 0x9a: this._rd(this.pc); this.s = this.x; break;                        // TXS (no flags)

      case 0x48: this._rd(this.pc); this._push(this.a); break;                     // PHA
      case 0x08: this._rd(this.pc); this._push(this.p | FB | FU); break;           // PHP pushes B set
      case 0x68: this._rd(this.pc); this._peekStack(); this.a = this._nz(this._pull()); break; // PLA
      case 0x28: { // PLP — B and unused are not real bits; I is deferred
        this._rd(this.pc); this._peekStack();
        const oldI = this.p & FI;
        this.p = (this._pull() & ~FB) | FU;
        this._deferI(oldI);
        break;
      }

      // ---- arithmetic / logic ----------------------------------------------
      case 0x69: this._adc(this._fetch()); break;                                  // ADC
      case 0x65: this._adc(this._rd(this._aZp())); break;
      case 0x75: this._adc(this._rd(this._aZpX())); break;
      case 0x6d: this._adc(this._rd(this._aAbs())); break;
      case 0x7d: this._adc(this._rd(this._aAbsIdx(this.x, false))); break;
      case 0x79: this._adc(this._rd(this._aAbsIdx(this.y, false))); break;
      case 0x61: this._adc(this._rd(this._aIndX())); break;
      case 0x71: this._adc(this._rd(this._aIndY(false))); break;

      case 0xe9: case 0xeb: this._sbc(this._fetch()); break;                       // SBC (#$EB is the illegal alias)
      case 0xe5: this._sbc(this._rd(this._aZp())); break;
      case 0xf5: this._sbc(this._rd(this._aZpX())); break;
      case 0xed: this._sbc(this._rd(this._aAbs())); break;
      case 0xfd: this._sbc(this._rd(this._aAbsIdx(this.x, false))); break;
      case 0xf9: this._sbc(this._rd(this._aAbsIdx(this.y, false))); break;
      case 0xe1: this._sbc(this._rd(this._aIndX())); break;
      case 0xf1: this._sbc(this._rd(this._aIndY(false))); break;

      case 0x29: this.a = this._nz(this.a & this._fetch()); break;                 // AND
      case 0x25: this.a = this._nz(this.a & this._rd(this._aZp())); break;
      case 0x35: this.a = this._nz(this.a & this._rd(this._aZpX())); break;
      case 0x2d: this.a = this._nz(this.a & this._rd(this._aAbs())); break;
      case 0x3d: this.a = this._nz(this.a & this._rd(this._aAbsIdx(this.x, false))); break;
      case 0x39: this.a = this._nz(this.a & this._rd(this._aAbsIdx(this.y, false))); break;
      case 0x21: this.a = this._nz(this.a & this._rd(this._aIndX())); break;
      case 0x31: this.a = this._nz(this.a & this._rd(this._aIndY(false))); break;

      case 0x09: this.a = this._nz(this.a | this._fetch()); break;                 // ORA
      case 0x05: this.a = this._nz(this.a | this._rd(this._aZp())); break;
      case 0x15: this.a = this._nz(this.a | this._rd(this._aZpX())); break;
      case 0x0d: this.a = this._nz(this.a | this._rd(this._aAbs())); break;
      case 0x1d: this.a = this._nz(this.a | this._rd(this._aAbsIdx(this.x, false))); break;
      case 0x19: this.a = this._nz(this.a | this._rd(this._aAbsIdx(this.y, false))); break;
      case 0x01: this.a = this._nz(this.a | this._rd(this._aIndX())); break;
      case 0x11: this.a = this._nz(this.a | this._rd(this._aIndY(false))); break;

      case 0x49: this.a = this._nz(this.a ^ this._fetch()); break;                 // EOR
      case 0x45: this.a = this._nz(this.a ^ this._rd(this._aZp())); break;
      case 0x55: this.a = this._nz(this.a ^ this._rd(this._aZpX())); break;
      case 0x4d: this.a = this._nz(this.a ^ this._rd(this._aAbs())); break;
      case 0x5d: this.a = this._nz(this.a ^ this._rd(this._aAbsIdx(this.x, false))); break;
      case 0x59: this.a = this._nz(this.a ^ this._rd(this._aAbsIdx(this.y, false))); break;
      case 0x41: this.a = this._nz(this.a ^ this._rd(this._aIndX())); break;
      case 0x51: this.a = this._nz(this.a ^ this._rd(this._aIndY(false))); break;

      case 0xc9: this._cmp(this.a, this._fetch()); break;                          // CMP
      case 0xc5: this._cmp(this.a, this._rd(this._aZp())); break;
      case 0xd5: this._cmp(this.a, this._rd(this._aZpX())); break;
      case 0xcd: this._cmp(this.a, this._rd(this._aAbs())); break;
      case 0xdd: this._cmp(this.a, this._rd(this._aAbsIdx(this.x, false))); break;
      case 0xd9: this._cmp(this.a, this._rd(this._aAbsIdx(this.y, false))); break;
      case 0xc1: this._cmp(this.a, this._rd(this._aIndX())); break;
      case 0xd1: this._cmp(this.a, this._rd(this._aIndY(false))); break;

      case 0xe0: this._cmp(this.x, this._fetch()); break;                          // CPX
      case 0xe4: this._cmp(this.x, this._rd(this._aZp())); break;
      case 0xec: this._cmp(this.x, this._rd(this._aAbs())); break;

      case 0xc0: this._cmp(this.y, this._fetch()); break;                          // CPY
      case 0xc4: this._cmp(this.y, this._rd(this._aZp())); break;
      case 0xcc: this._cmp(this.y, this._rd(this._aAbs())); break;

      case 0x24: this._bit(this._rd(this._aZp())); break;                          // BIT
      case 0x2c: this._bit(this._rd(this._aAbs())); break;

      // ---- shifts / rotates -------------------------------------------------
      case 0x0a: this._rd(this.pc); this.a = this._asl(this.a); break;             // ASL A
      case 0x06: this._rmw(this._aZp(), this._asl); break;
      case 0x16: this._rmw(this._aZpX(), this._asl); break;
      case 0x0e: this._rmw(this._aAbs(), this._asl); break;
      case 0x1e: this._rmw(this._aAbsIdx(this.x, true), this._asl); break;

      case 0x4a: this._rd(this.pc); this.a = this._lsr(this.a); break;             // LSR A
      case 0x46: this._rmw(this._aZp(), this._lsr); break;
      case 0x56: this._rmw(this._aZpX(), this._lsr); break;
      case 0x4e: this._rmw(this._aAbs(), this._lsr); break;
      case 0x5e: this._rmw(this._aAbsIdx(this.x, true), this._lsr); break;

      case 0x2a: this._rd(this.pc); this.a = this._rol(this.a); break;             // ROL A
      case 0x26: this._rmw(this._aZp(), this._rol); break;
      case 0x36: this._rmw(this._aZpX(), this._rol); break;
      case 0x2e: this._rmw(this._aAbs(), this._rol); break;
      case 0x3e: this._rmw(this._aAbsIdx(this.x, true), this._rol); break;

      case 0x6a: this._rd(this.pc); this.a = this._ror(this.a); break;             // ROR A
      case 0x66: this._rmw(this._aZp(), this._ror); break;
      case 0x76: this._rmw(this._aZpX(), this._ror); break;
      case 0x6e: this._rmw(this._aAbs(), this._ror); break;
      case 0x7e: this._rmw(this._aAbsIdx(this.x, true), this._ror); break;

      // ---- increments / decrements -----------------------------------------
      case 0xe6: this._rmw(this._aZp(), incB); break;                              // INC
      case 0xf6: this._rmw(this._aZpX(), incB); break;
      case 0xee: this._rmw(this._aAbs(), incB); break;
      case 0xfe: this._rmw(this._aAbsIdx(this.x, true), incB); break;

      case 0xc6: this._rmw(this._aZp(), decB); break;                              // DEC
      case 0xd6: this._rmw(this._aZpX(), decB); break;
      case 0xce: this._rmw(this._aAbs(), decB); break;
      case 0xde: this._rmw(this._aAbsIdx(this.x, true), decB); break;

      case 0xe8: this._rd(this.pc); this.x = this._nz((this.x + 1) & 0xff); break; // INX
      case 0xc8: this._rd(this.pc); this.y = this._nz((this.y + 1) & 0xff); break; // INY
      case 0xca: this._rd(this.pc); this.x = this._nz((this.x - 1) & 0xff); break; // DEX
      case 0x88: this._rd(this.pc); this.y = this._nz((this.y - 1) & 0xff); break; // DEY

      // ---- flags -------------------------------------------------------------
      case 0x18: this._rd(this.pc); this.p &= ~FC; break;                          // CLC
      case 0x38: this._rd(this.pc); this.p |= FC; break;                           // SEC
      case 0xd8: this._rd(this.pc); this.p &= ~FD; break;                          // CLD
      case 0xf8: this._rd(this.pc); this.p |= FD; break;                           // SED
      case 0xb8: this._rd(this.pc); this.p &= ~FV; break;                          // CLV
      case 0x58: this._rd(this.pc); this._deferI(this.p & FI); this.p &= ~FI; break; // CLI
      case 0x78: this._rd(this.pc); this._deferI(this.p & FI); this.p |= FI; break;  // SEI

      // ---- branches ----------------------------------------------------------
      case 0x10: this._branch(!(this.p & FN)); break; // BPL
      case 0x30: this._branch(!!(this.p & FN)); break; // BMI
      case 0x50: this._branch(!(this.p & FV)); break; // BVC
      case 0x70: this._branch(!!(this.p & FV)); break; // BVS
      case 0x90: this._branch(!(this.p & FC)); break; // BCC
      case 0xb0: this._branch(!!(this.p & FC)); break; // BCS
      case 0xd0: this._branch(!(this.p & FZ)); break; // BNE
      case 0xf0: this._branch(!!(this.p & FZ)); break; // BEQ

      // ---- jumps / returns ---------------------------------------------------
      case 0x4c: this.pc = this._aAbs(); break;                                    // JMP abs
      case 0x6c: { // JMP (ind) — the page-wrap bug: $xxFF reads its high byte
        a = this._aAbs();                                                          // from $xx00, not the next page.
        const lo = this._rd(a);
        this.pc = lo | (this._rd((a & 0xff00) | ((a + 1) & 0xff)) << 8);
        break;
      }
      case 0x20: { // JSR — pushes the address of its own last byte, not the
        const lo = this._fetch();                                                  // return address; RTS adds the 1 back.
        this._peekStack();
        this._push((this.pc >> 8) & 0xff);
        this._push(this.pc & 0xff);
        this.pc = lo | (this._rd(this.pc) << 8);
        break;
      }
      case 0x60: { // RTS
        this._rd(this.pc); this._peekStack();
        const lo = this._pull(), hi = this._pull();
        this.pc = (lo | (hi << 8)) & 0xffff;
        this._rd(this.pc); // the +1 costs a cycle
        this.pc = (this.pc + 1) & 0xffff;
        break;
      }
      case 0x40: { // RTI — pulls P early, so a cleared I takes effect at once
        this._rd(this.pc); this._peekStack();
        this.p = (this._pull() & ~FB) | FU;
        const lo = this._pull(), hi = this._pull();
        this.pc = (lo | (hi << 8)) & 0xffff;
        break;
      }
      case 0x00: { // BRK — a two-byte instruction whose second byte is ignored
        this._fetch();
        this._interrupt(IRQ_VECTOR, true);
        break;
      }

      case 0xea: this._rd(this.pc); break;                                         // NOP

      // ---- illegal opcodes games actually use --------------------------------
      // These fell out of the unused bit patterns. Publishers used them for
      // speed (LAX is "LDA+LDX in one"), and a few games only work because
      // of them, so an emulator that "cleanly" traps illegals fails on real
      // carts.
      case 0xa7: a = this._aZp(); this.a = this.x = this._nz(this._rd(a)); break;   // LAX
      case 0xb7: a = this._aZpY(); this.a = this.x = this._nz(this._rd(a)); break;
      case 0xaf: a = this._aAbs(); this.a = this.x = this._nz(this._rd(a)); break;
      case 0xbf: a = this._aAbsIdx(this.y, false); this.a = this.x = this._nz(this._rd(a)); break;
      case 0xa3: a = this._aIndX(); this.a = this.x = this._nz(this._rd(a)); break;
      case 0xb3: a = this._aIndY(false); this.a = this.x = this._nz(this._rd(a)); break;

      case 0x87: this._wr(this._aZp(), this.a & this.x); break;                     // SAX (no flags)
      case 0x97: this._wr(this._aZpY(), this.a & this.x); break;
      case 0x8f: this._wr(this._aAbs(), this.a & this.x); break;
      case 0x83: this._wr(this._aIndX(), this.a & this.x); break;

      case 0xc7: this._dcp(this._aZp()); break;                                     // DCP = DEC + CMP
      case 0xd7: this._dcp(this._aZpX()); break;
      case 0xcf: this._dcp(this._aAbs()); break;
      case 0xdf: this._dcp(this._aAbsIdx(this.x, true)); break;
      case 0xdb: this._dcp(this._aAbsIdx(this.y, true)); break;
      case 0xc3: this._dcp(this._aIndX()); break;
      case 0xd3: this._dcp(this._aIndY(true)); break;

      case 0xe7: this._isc(this._aZp()); break;                                     // ISC = INC + SBC
      case 0xf7: this._isc(this._aZpX()); break;
      case 0xef: this._isc(this._aAbs()); break;
      case 0xff: this._isc(this._aAbsIdx(this.x, true)); break;
      case 0xfb: this._isc(this._aAbsIdx(this.y, true)); break;
      case 0xe3: this._isc(this._aIndX()); break;
      case 0xf3: this._isc(this._aIndY(true)); break;

      case 0x07: this._slo(this._aZp()); break;                                     // SLO = ASL + ORA
      case 0x17: this._slo(this._aZpX()); break;
      case 0x0f: this._slo(this._aAbs()); break;
      case 0x1f: this._slo(this._aAbsIdx(this.x, true)); break;
      case 0x1b: this._slo(this._aAbsIdx(this.y, true)); break;
      case 0x03: this._slo(this._aIndX()); break;
      case 0x13: this._slo(this._aIndY(true)); break;

      case 0x27: this._rla(this._aZp()); break;                                     // RLA = ROL + AND
      case 0x37: this._rla(this._aZpX()); break;
      case 0x2f: this._rla(this._aAbs()); break;
      case 0x3f: this._rla(this._aAbsIdx(this.x, true)); break;
      case 0x3b: this._rla(this._aAbsIdx(this.y, true)); break;
      case 0x23: this._rla(this._aIndX()); break;
      case 0x33: this._rla(this._aIndY(true)); break;

      case 0x47: this._sre(this._aZp()); break;                                     // SRE = LSR + EOR
      case 0x57: this._sre(this._aZpX()); break;
      case 0x4f: this._sre(this._aAbs()); break;
      case 0x5f: this._sre(this._aAbsIdx(this.x, true)); break;
      case 0x5b: this._sre(this._aAbsIdx(this.y, true)); break;
      case 0x43: this._sre(this._aIndX()); break;
      case 0x53: this._sre(this._aIndY(true)); break;

      case 0x67: this._rra(this._aZp()); break;                                     // RRA = ROR + ADC
      case 0x77: this._rra(this._aZpX()); break;
      case 0x6f: this._rra(this._aAbs()); break;
      case 0x7f: this._rra(this._aAbsIdx(this.x, true)); break;
      case 0x7b: this._rra(this._aAbsIdx(this.y, true)); break;
      case 0x63: this._rra(this._aIndX()); break;
      case 0x73: this._rra(this._aIndY(true)); break;

      case 0x0b: case 0x2b: // ANC #imm — AND then copy N into C (a free "shift
        this.a = this._nz(this.a & this._fetch());                                  // the sign bit into carry")
        this.p = (this.p & ~FC) | ((this.a >> 7) & 1);
        break;
      case 0x4b: // ALR/ASR #imm — AND then LSR A
        this.a = this._lsr(this.a & this._fetch());
        break;
      case 0x6b: { // ARR #imm — AND, ROR, then flags from the *result* bits,
        const v = this.a & this._fetch();                                           // which is what makes it useful for
        this.a = ((v >> 1) | ((this.p & FC) << 7)) & 0xff;                          // fast multiply/divide tricks.
        this._nz(this.a);
        this.p = (this.p & ~(FC | FV)) | ((this.a >> 6) & 1)
          | ((((this.a >> 6) ^ (this.a >> 5)) & 1) ? FV : 0);
        break;
      }
      case 0xcb: { // SBX/AXS #imm — X = (A & X) - imm, with CMP-style carry
        const v = this._fetch(), t = (this.a & this.x);
        this.x = (t - v) & 0xff;
        this.p = (this.p & ~(FN | FZ | FC)) | (this.x & 0x80) | (this.x === 0 ? FZ : 0)
          | (t >= v ? FC : 0);
        break;
      }
      // Unstable: these AND in a "magic" constant whose value depends on the
      // chip, temperature and what was last on the bus. 0xEE is the value
      // most emulators settle on; no known game depends on it.
      case 0x8b: this.a = this._nz((this.a | 0xee) & this.x & this._fetch()); break; // ANE/XAA
      case 0xab: this.a = this.x = this._nz((this.a | 0xee) & this._fetch()); break; // LXA
      case 0xbb: { // LAS — A = X = S = M & S
        const v = this._rd(this._aAbsIdx(this.y, false)) & this.s;
        this.a = this.x = this.s = this._nz(v);
        break;
      }
      // The "&(H+1)" stores. The value written is ANDed with the high byte
      // of the target address plus one, because the chip puts it on the bus
      // while the address is still forming. On a page cross the high byte
      // itself gets corrupted to that value — reproduced here, approximately.
      case 0x9c: this._sh(this.y, this.x); break; // SHY abs,X
      case 0x9e: this._sh(this.x, this.y); break;  // SHX abs,Y
      case 0x9f: this._sh(this.a & this.x, this.y); break; // SHA/AHX abs,Y
      case 0x93: { // SHA (zp),Y
        const z = this._fetch();
        const base = this._rd(z) | (this._rd((z + 1) & 0xff) << 8);
        this._shStore(this.a & this.x, base, this.y);
        break;
      }
      case 0x9b: // TAS/SHS abs,Y — also overwrites S
        this.s = this.a & this.x;
        this._sh(this.s, this.y);
        break;

      // Multi-byte NOPs. Assemblers emitted them as padding and a few games
      // land on them, so they must burn the right number of cycles.
      case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa:
        this._rd(this.pc); break;
      case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2:
        this._fetch(); break;
      case 0x04: case 0x44: case 0x64: this._rd(this._aZp()); break;
      case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4:
        this._rd(this._aZpX()); break;
      case 0x0c: this._rd(this._aAbs()); break;
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc:
        this._rd(this._aAbsIdx(this.x, false)); break;

      // JAM/KIL: the chip stops driving the bus and only RESET recovers it.
      // Model it as a halt rather than an exception — a crashed game is a
      // legitimate thing to observe in a debugger.
      case 0x02: case 0x12: case 0x22: case 0x32: case 0x42: case 0x52:
      case 0x62: case 0x72: case 0x92: case 0xb2: case 0xd2: case 0xf2:
        this.pc = (this.pc - 1) & 0xffff;
        this.jammed = true;
        break;

      default: // unreachable: every one of the 256 patterns is covered above
        this._rd(this.pc);
        break;
    }
  }

  // RMW + ALU combinations, sharing the real three-cycle RMW tail.
  _dcp(a) { const v = this._rd(a); this._wr(a, v); const r = (v - 1) & 0xff; this._wr(a, r); this._cmp(this.a, r); }
  _isc(a) { const v = this._rd(a); this._wr(a, v); const r = (v + 1) & 0xff; this._wr(a, r); this._sbc(r); }
  _slo(a) { const v = this._rd(a); this._wr(a, v); const r = this._asl(v); this._wr(a, r); this.a = this._nz(this.a | r); }
  _rla(a) { const v = this._rd(a); this._wr(a, v); const r = this._rol(v); this._wr(a, r); this.a = this._nz(this.a & r); }
  _sre(a) { const v = this._rd(a); this._wr(a, v); const r = this._lsr(v); this._wr(a, r); this.a = this._nz(this.a ^ r); }
  _rra(a) { const v = this._rd(a); this._wr(a, v); const r = this._ror(v); this._wr(a, r); this._adc(r); }

  _sh(value, idx) {
    const lo = this._fetch(), hi = this._fetch();
    this._shStore(value, lo | (hi << 8), idx);
  }

  _shStore(value, base, idx) {
    const addr = (base + idx) & 0xffff;
    this._rd((base & 0xff00) | (addr & 0xff)); // the always-present dummy read
    const v = value & (((base >> 8) + 1) & 0xff);
    // Page cross: the high address byte is replaced by the value itself.
    const target = ((base ^ addr) & 0xff00) ? ((v << 8) | (addr & 0xff)) : addr;
    this._wr(target, v);
  }

  // ---- state ---------------------------------------------------------------
  // Plain data, no ROM, no bus — the rewind ring buffer copies this a
  // thousand times per session, so it stays as small as the chip is.
  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      a: this.a, x: this.x, y: this.y, s: this.s, p: this.p, pc: this.pc,
      cycles: this.cycles,
      nmiPending: this.nmiPending, nmiLine: this.nmiLine, irqLine: this.irqLine,
      jammed: this.jammed, iHold: this._iHold,
      // Two booleans and a two-bit history, but leaving them out would make a
      // restore diverge only when a rewind happened to land on the cycle after
      // a taken branch or a BRK — the kind of bug that looks like "rewind is
      // flaky" rather than "the CPU state is incomplete".
      runIrq: this._runIrq, runIrqPrev: this._runIrqPrev,
      irqDelay: this._irqDelay, nmiDelay: this._nmiDelay,
      irqSeen: this._irqSeen, nmiSeen: this._nmiSeen,
      stallSeen: this._stallSeen, stallIrq: this._stallIrq, stallNmi: this._stallNmi,
    };
  }

  // exact inverse of getState — the pair is what makes deterministic
  // time-travel possible (snapshot, run ahead, restore, run again: identical)
  setState(s) {
    this.a = s.a; this.x = s.x; this.y = s.y; this.s = s.s; this.p = s.p; this.pc = s.pc;
    this.cycles = s.cycles ?? 0;
    this.nmiPending = !!s.nmiPending;
    this.nmiLine = !!s.nmiLine;
    this.irqLine = s.irqLine ?? 0;
    this.jammed = !!s.jammed;
    this._iHold = s.iHold ?? -1;
    this._runIrq = !!s.runIrq;
    this._runIrqPrev = !!s.runIrqPrev;
    this._irqDelay = !!s.irqDelay;
    this._nmiDelay = !!s.nmiDelay;
    this._irqSeen = s.irqSeen ?? this.irqLine;
    this._nmiSeen = s.nmiSeen ?? this.nmiPending;
    this._stallSeen = !!s.stallSeen; this._stallIrq = s.stallIrq ?? 0; this._stallNmi = !!s.stallNmi;
    return this;
  }

  // Aliases so the CPU reads like the machines do (machine88.js style).
  snapshot() { return this.getState(); }
  restore(s) { return this.setState(s); }
}

function incB(v) { return this._nz((v + 1) & 0xff); }
function decB(v) { return this._nz((v - 1) & 0xff); }

export function createM6502(bus, opts) {
  return new M6502(bus, opts);
}
