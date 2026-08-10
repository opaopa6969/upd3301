// huc6280 — the Hudson HuC6280, the PC Engine's CPU.
//
// It is a 65C02 with a memory management unit, a timer, an interrupt
// controller and an I/O port welded on, so this file is written as a SUBCLASS
// of m6502.js rather than a copy of it. That choice is the whole design and
// docs/pce-design.md §2 argues it at length; the short version is that what
// m6502.js is worth is not its opcode table but its *cycle model* — one bus
// access equals one cycle, with the chip's dummy accesses actually performed —
// and its interrupt machinery, which is validated to the cycle by nestest's
// 8991 lines. Both are exactly what the PC Engine needs and neither has
// anything to do with which opcodes exist. Inheriting keeps that verification
// intact (this file does not touch m6502.js, so nestest still guards it), and
// the ~60 opcodes the two chips do not share are overridden in one switch that
// falls through to the parent for the ~150 they do.
//
// What is genuinely new, and what this file therefore spends its length on:
//
//   MMU     Eight 8-bit "mapping registers" (MPR0-7) turn the 6502's 16-bit
//           address into a 21-bit one, 8KB at a time. Everything the console
//           has — cartridge, work RAM, save RAM, and the whole hardware page —
//           lives in that 2MB space and is paged into the 64KB window. The
//           registers live HERE, not in the machine, because TAM/TMA are CPU
//           instructions; the machine reads cpu.mpr to do the translation.
//   Zero page and stack move. On a 6502 they are $0000 and $0100. Here they
//           are $2000 and $2100 — i.e. inside whatever MPR1 points at. That is
//           why the addressing modes are overridden rather than inherited.
//   Speed   CSL/CSH switch the core between 1.79MHz and 7.16MHz. The master
//           clock does not change, the divider does, so the CPU reports its
//           divider and the machine converts (see machinepce.js).
//   T flag  Bit 5 of P — the bit a 6502 leaves permanently set — is a mode
//           flag here. SET turns it on for exactly one instruction, and while
//           it is on, ADC/AND/EOR/ORA read and write memory at $2000+X instead
//           of the accumulator.
//   Blocks  Five block-copy instructions (TII/TDD/TIN/TIA/TAI) that move up to
//           64KB in one opcode. They are why this core needs internal cycles
//           that are not bus accesses at all (see _io).
//   ST0/1/2 Direct writes to the video chip that bypass the address bus, so a
//           game can poke the VDC without spending an MPR on the hardware page.
//
// Suite contract: no Math.random, deterministic, plain-data getState/setState.

import { M6502, FC, FZ, FI, FD, FB, FV, FN } from './m6502.js';

export const SCHEMA_VERSION = 1;

// Bit 5 of the status register. A 6502 has an unused bit there that is always
// read as 1; the HuC6280 uses it as the "memory operation" flag.
export const FT = 0x20;

// The vectors are NOT in 6502 positions. RESET moved to the top of the table
// and the three maskable sources each got their own entry below it, which is
// what makes the interrupt controller ($1402/$1403) meaningful: three
// independent lines, three handlers, no dispatch code.
export const VEC_IRQ2 = 0xfff6;    // external / CD-ROM — and BRK
export const VEC_IRQ1 = 0xfff8;    // the VDC
export const VEC_TIMER = 0xfffa;   // the on-chip timer
export const VEC_NMI = 0xfffc;
export const VEC_RESET = 0xfffe;

// Interrupt sources, as bit positions in irqStatus / irqMask. The mask register
// at $1402 is a DISABLE mask: a set bit turns its source off.
export const IRQ2 = 0, IRQ1 = 1, TIMER = 2;

// The 6502's page zero and stack page, relocated. Both sit in the bank MPR1
// points at, which is how a PC Engine game gets a full 8KB of "fast" memory
// instead of the 6502's 256 bytes.
export const ZP_BASE = 0x2000;
export const STACK_BASE = 0x2100;

// Master clock 21.47727 MHz; the CPU divides it by 3 or by 12.
export const MASTER_HZ = 21477272.727272727;
export const CPU_HZ_FAST = MASTER_HZ / 3;    // 7.159 MHz
export const CPU_HZ_SLOW = MASTER_HZ / 12;   // 1.790 MHz

// The timer counts down once every 1024 CPU cycles at the FAST rate, i.e. every
// 3072 master clocks, regardless of what CSL/CSH have done — it hangs off the
// master clock, not off the core. 21477272/3072 = 6991 Hz, the figure the
// hardware documents quote.
export const TIMER_PERIOD_MASTER = 3072;

const sign8 = (v) => (v << 24) >> 24;

// Which ALU operation the T flag redirects, and how its operand is addressed.
// Only these four instructions are affected; everything else ignores T.
const ALU_ORA = 0, ALU_AND = 1, ALU_EOR = 2, ALU_ADC = 3;
const AM_IMM = 0, AM_ZP = 1, AM_ZPX = 2, AM_ABS = 3, AM_ABSX = 4, AM_ABSY = 5,
  AM_INDX = 6, AM_INDY = 7, AM_IND = 8;
const T_OPS = new Uint8Array(256).fill(0xff);
{
  const rows = [
    [ALU_ORA, [0x09, AM_IMM], [0x05, AM_ZP], [0x15, AM_ZPX], [0x0d, AM_ABS], [0x1d, AM_ABSX], [0x19, AM_ABSY], [0x01, AM_INDX], [0x11, AM_INDY], [0x12, AM_IND]],
    [ALU_AND, [0x29, AM_IMM], [0x25, AM_ZP], [0x35, AM_ZPX], [0x2d, AM_ABS], [0x3d, AM_ABSX], [0x39, AM_ABSY], [0x21, AM_INDX], [0x31, AM_INDY], [0x32, AM_IND]],
    [ALU_EOR, [0x49, AM_IMM], [0x45, AM_ZP], [0x55, AM_ZPX], [0x4d, AM_ABS], [0x5d, AM_ABSX], [0x59, AM_ABSY], [0x41, AM_INDX], [0x51, AM_INDY], [0x52, AM_IND]],
    [ALU_ADC, [0x69, AM_IMM], [0x65, AM_ZP], [0x75, AM_ZPX], [0x6d, AM_ABS], [0x7d, AM_ABSX], [0x79, AM_ABSY], [0x61, AM_INDX], [0x71, AM_INDY], [0x72, AM_IND]],
  ];
  for (const [alu, ...modes] of rows) for (const [op, am] of modes) T_OPS[op] = (alu << 4) | am;
}

export class HuC6280 extends M6502 {
  constructor(bus, opts = {}) {
    super(bus, opts);
    // Unlike the 2A03, this chip's BCD adder is wired up.
    this.decimal = opts.decimal !== false;
  }

  powerOn() {
    super.powerOn();
    // MPR0-7. Reset only defines MPR7 (see reset()); the rest come up with
    // whatever was in them, which every game overwrites in its first dozen
    // instructions. Zero is the reproducible choice.
    this.mpr = new Uint8Array(8);
    this.mprLatch = 0;          // the value TMA last read, for open-bus reads
    this.fast = false;          // CSL/CSH — the console starts slow
    this.irqStatus = 0;         // level per source (IRQ2/IRQ1/TIMER)
    // $1402 is a DISABLE mask and it comes up as zero, i.e. all three sources
    // ENABLED. That is not a guess: Alien Crush (and most of the library) never
    // writes $1402 at all — it sets up the VDC, does CLI, and waits for the
    // frame counter its vblank handler increments. Coming up with everything
    // masked hangs those titles at the first vblank wait, which is what this
    // emulator did until the sweep found it.
    this.irqMask = 0;
    this.irqDisableLatch = 7;
    // The on-chip timer. It belongs to the CPU, not the machine: its registers
    // are at $0C00/$0C01 in the hardware page but its interrupt is a CPU vector
    // and its clock is the CPU's, so keeping it here means the machine only has
    // to hand it master cycles.
    this.timerReload = 0;       // $0C00, 7 bits
    this.timerValue = 0;        // the live down-counter
    this.timerRun = false;      // $0C01 bit 0
    this.timerAcc = 0;          // master clocks toward the next tick
    return this;
  }

  // RESET: the vector is at $FFFE, not $FFFC, and MPR7 comes up as $00 so that
  // $E000-$FFFF is cartridge bank 0 — which is why every HuCard has its vector
  // table at file offset $1FF6-$1FFF.
  reset() {
    this._rd(this.pc); this._rd(this.pc);
    this._rd(STACK_BASE | this.s); this.s = (this.s - 1) & 0xff;
    this._rd(STACK_BASE | this.s); this.s = (this.s - 1) & 0xff;
    this._rd(STACK_BASE | this.s); this.s = (this.s - 1) & 0xff;
    this.p = (this.p | FI) & ~(FD | FT);
    this.mpr[7] = 0x00;
    this.fast = false;
    this.timerRun = false;
    this.timerAcc = 0;
    this.irqMask = 0;
    this.irqStatus = 0;
    this.irqLine = 0;
    this.pc = this._rd(VEC_RESET) | (this._rd(VEC_RESET + 1) << 8);
    this.jammed = false;
    this.nmiPending = false;
    this._iHold = -1;
    this._irqDelay = false;
    this._nmiDelay = false;
    this._nmiSeen = false;
    this._irqSeen = 0;
    return this;
  }

  // How many master clocks one CPU cycle costs right now. The machine multiplies
  // by this instead of keeping two clocks, which is what makes CSL/CSH free:
  // the video chip never learns that the CPU changed speed.
  get clockDiv() { return this.fast ? 3 : 12; }
  get cpuHz() { return this.fast ? CPU_HZ_FAST : CPU_HZ_SLOW; }

  // ---- internal cycles -----------------------------------------------------
  // m6502.js has no concept of a cycle that is not a bus access, because a 6502
  // has almost none that matter. The HuC6280 does: TAM is five cycles with two
  // accesses, and a block transfer is six cycles per byte with two. So the bus
  // grows one optional method — idle(n) — and the machine advances the video
  // chip through it exactly as it does through read/write. A bus that does not
  // implement idle() still works; it just runs its video clock off the accesses
  // alone, which is what the unit tests do.
  _io(n = 1) {
    this.cycles += n;
    if (this.bus.idle) this.bus.idle(n);
    this._endCycle();
  }

  // ---- relocated page zero and stack ---------------------------------------
  // Everything below exists only because ZP_BASE and STACK_BASE are not 0 and
  // $100. The bodies are the parent's, with the base added.
  _aZp() { return ZP_BASE | this._fetch(); }
  _aZpX() { const z = this._fetch(); this._rd(ZP_BASE | z); return ZP_BASE | ((z + this.x) & 0xff); }
  _aZpY() { const z = this._fetch(); this._rd(ZP_BASE | z); return ZP_BASE | ((z + this.y) & 0xff); }

  _aIndX() {
    const z = this._fetch();
    this._rd(ZP_BASE | z);
    const p = (z + this.x) & 0xff;
    return this._rd(ZP_BASE | p) | (this._rd(ZP_BASE | ((p + 1) & 0xff)) << 8);
  }

  _aIndY(always) {
    const z = this._fetch();
    const base = this._rd(ZP_BASE | z) | (this._rd(ZP_BASE | ((z + 1) & 0xff)) << 8);
    const addr = (base + this.y) & 0xffff;
    if (always || ((base ^ addr) & 0xff00)) this._rd((base & 0xff00) | (addr & 0xff));
    return addr;
  }

  // (zp) with no index — the 65C02 addition that removes the "waste an index
  // register to dereference a pointer" tax.
  _aInd() {
    const z = this._fetch();
    return this._rd(ZP_BASE | z) | (this._rd(ZP_BASE | ((z + 1) & 0xff)) << 8);
  }

  // JMP (abs,X) — the other 65C02 addition, used for jump tables.
  _aIndAbsX() {
    const base = this._aAbs();
    const a = (base + this.x) & 0xffff;
    return this._rd(a) | (this._rd((a + 1) & 0xffff) << 8);
  }

  _push(v) { this._wr(STACK_BASE | this.s, v & 0xff); this.s = (this.s - 1) & 0xff; }
  _pull() { this.s = (this.s + 1) & 0xff; return this._rd(STACK_BASE | this.s); }
  _peekStack() { this._rd(STACK_BASE | this.s); }

  // ---- read-modify-write ---------------------------------------------------
  // The NMOS 6502 writes the OLD value back before the new one, and NES games
  // lean on that doubled write. A CMOS core does not: it spends an internal
  // cycle instead. Keeping the parent's version here would double every write
  // to a VDC or PSG register reached through INC/DEC/ASL — which on this
  // machine means a doubled VRAM auto-increment, i.e. corruption that only
  // appears in games that use RMW on hardware. Hence the override.
  _rmw(addr, fn) {
    const v = this._rd(addr);
    this._io(1);
    this._wr(addr, fn.call(this, v));
  }

  // ---- decimal mode --------------------------------------------------------
  // The 2A03 has no BCD adder so m6502.js models the NMOS quirks (Z from the
  // binary result, N/V from a half-corrected one) behind an off-by-default
  // flag. A CMOS part fixes all of that: the flags describe the decimal result,
  // at the price of one extra cycle. Both halves matter — a game that adds
  // scores in BCD and then branches on Z gets the wrong answer with NMOS flags.
  _adc(v) {
    if (!(this.decimal && (this.p & FD))) return super._adc(v);
    const a = this.a, c = this.p & FC ? 1 : 0;
    let lo = (a & 0x0f) + (v & 0x0f) + c;
    let hi = (a >> 4) + (v >> 4);
    if (lo > 9) { lo -= 10; hi++; }
    let carry = 0;
    if (hi > 9) { hi -= 10; carry = 1; }
    const r = ((hi << 4) | (lo & 0x0f)) & 0xff;
    const bin = (a + v + c) & 0xff;
    this.p = (this.p & ~(FN | FV | FZ | FC)) | (r & 0x80) | (r === 0 ? FZ : 0)
      | ((~(a ^ v) & (a ^ bin) & 0x80) ? FV : 0) | (carry ? FC : 0);
    this.a = r;
    this._io(1);
  }

  _sbc(v) {
    if (!(this.decimal && (this.p & FD))) return super._sbc(v);
    const a = this.a, c = this.p & FC ? 1 : 0;
    const bin = a - v - (1 - c);
    let lo = (a & 0x0f) - (v & 0x0f) - (1 - c);
    let hi = (a >> 4) - (v >> 4);
    if (lo & 0x10) { lo -= 6; hi--; }
    if (hi & 0x10) hi -= 6;
    const r = ((hi << 4) | (lo & 0x0f)) & 0xff;
    this.p = (this.p & ~(FN | FV | FZ | FC)) | (r & 0x80) | (r === 0 ? FZ : 0)
      | (((a ^ v) & (a ^ bin) & 0x80) ? FV : 0) | (bin >= 0 ? FC : 0);
    this.a = r;
    this._io(1);
  }

  // ---- interrupts ----------------------------------------------------------
  // Three maskable lines with three vectors, plus NMI. There is no vector
  // hijacking to model (that is an NMOS artefact of BRK and IRQ sharing one
  // vector, and here they do not share), so this is the plain sequence.
  _interrupt(vector, fromBrk) {
    if (!fromBrk) { this._rd(this.pc); this._rd(this.pc); }
    this._push((this.pc >> 8) & 0xff);
    this._push(this.pc & 0xff);
    this._push(fromBrk ? (this.p | FB) : (this.p & ~FB));
    // Entering an interrupt clears D and T. Clearing D is the fix a CMOS part
    // makes over the NMOS one (an NMOS handler that runs while SED is in force
    // adds in BCD and corrupts whatever it touched); clearing T is required or
    // a SET that was one instruction from firing would redirect the handler's
    // first ALU instruction into $2000+X.
    this.p = (this.p | FI) & ~(FD | FT);
    this.pc = this._rd(vector) | (this._rd(vector + 1) << 8);
    this._iHold = -1;
    this._nmiDelay = true;
  }

  // The machine (and the VDC, timer, CD interface) drive the three lines
  // through here. Level-triggered: a source holds its line until the device is
  // acknowledged, exactly like the NES mapper IRQ in m6502.js.
  setIrq(source, level) {
    const bit = 1 << source;
    this.irqStatus = level ? (this.irqStatus | bit) : (this.irqStatus & ~bit);
    this._syncIrqLine();
  }

  _syncIrqLine() {
    // The parent samples `irqLine` once per cycle; feeding it the already-masked
    // value means the mask register behaves like a real gate rather than
    // something step() has to remember to consult.
    this.irqLine = this.irqStatus & ~this.irqMask & 7;
    this._irqSeen = this.irqLine;
  }

  // ---- the on-chip timer ---------------------------------------------------
  // Counts down one step every TIMER_PERIOD_MASTER master clocks; on underflow
  // it reloads and raises TIMER. `n` is master clocks, so CSL/CSH do not change
  // the tempo of anything timed by it — which is the point of putting it on the
  // master clock, and why music drivers that use it stay in tune across a speed
  // change.
  clockTimer(n) {
    if (!this.timerRun) return;
    this.timerAcc += n;
    while (this.timerAcc >= TIMER_PERIOD_MASTER) {
      this.timerAcc -= TIMER_PERIOD_MASTER;
      if (this.timerValue === 0) {
        this.timerValue = this.timerReload;
        this.setIrq(TIMER, true);
      } else {
        this.timerValue--;
      }
    }
  }

  // The four CPU-internal registers the machine forwards from the hardware
  // page. Keeping them here rather than in machinepce.js is not tidiness: the
  // timer's reload semantics and the mask's effect on the interrupt line are
  // both CPU behaviour, and a machine that owned them would have to reach into
  // the CPU on every write anyway.
  ioRead(addr) {
    switch (addr & 0x1c03) {
      case 0x0c00: return this.timerValue & 0x7f;      // $0C00/$0C01: the counter
      case 0x0c01: return this.timerValue & 0x7f;
      case 0x1402: return this.irqMask & 7;
      case 0x1403: return this.irqStatus & 7;
      default: return null;                             // not ours
    }
  }

  ioWrite(addr, v) {
    switch (addr & 0x1c03) {
      case 0x0c00: this.timerReload = v & 0x7f; return true;
      case 0x0c01: {
        const run = (v & 1) !== 0;
        // Starting a stopped timer reloads it; re-writing the start bit while
        // it is already running does NOT, or a game that pokes $0C01 in a loop
        // would never let the counter reach zero.
        if (run && !this.timerRun) { this.timerValue = this.timerReload; this.timerAcc = 0; }
        this.timerRun = run;
        return true;
      }
      case 0x1402: this.irqMask = v & 7; this._syncIrqLine(); return true;
      // Writing $1403 acknowledges the TIMER interrupt. Nothing else does: the
      // VDC's line is cleared by reading the VDC status register and the CD
      // interface clears its own, so this register is not a general "clear all".
      case 0x1403: this.setIrq(TIMER, false); return true;
      default: return false;
    }
  }

  // ---- execution -----------------------------------------------------------
  step() {
    if (this.jammed) { this.cycles++; return 1; }
    const start = this.cycles;
    const iMask = this._iHold >= 0 ? this._iHold : (this.p & FI);
    this._iHold = -1;
    const nmiDelay = this._nmiDelay, irqDelay = this._irqDelay;
    this._nmiDelay = false; this._irqDelay = false;

    if (this._nmiSeen && this.nmiPending && !nmiDelay) {
      this.nmiPending = false;
      this._interrupt(VEC_NMI, false);
      return this.cycles - start;
    }
    if (this._irqSeen && !iMask && !irqDelay) {
      const live = this.irqStatus & ~this.irqMask & 7;
      if (live) {
        // Priority. Only one of the three can be entered per boundary; the
        // others keep their lines up and are taken on the way out of this one.
        const vec = (live & (1 << TIMER)) ? VEC_TIMER
          : (live & (1 << IRQ1)) ? VEC_IRQ1 : VEC_IRQ2;
        this._interrupt(vec, false);
        return this.cycles - start;
      }
    }

    // The T flag survives exactly one instruction, and it is a real bit of P
    // for the whole of that instruction — a PHP in the middle of a SET pushes
    // it set. So it is sampled here, honoured inside _exec, and cleared after
    // the instruction has run; SET itself sees t = 0 and therefore survives to
    // arm the NEXT one.
    const t = this.p & FT;
    this._exec(this._fetch());
    if (t) this.p &= ~FT;
    return this.cycles - start;
  }

  _exec(op) {
    if (this.p & FT) {
      const spec = T_OPS[op];
      if (spec !== 0xff) return this._tAlu(spec >> 4, spec & 0x0f);
    }

    switch (op) {
      // ---- register shuffles (Hudson) ---------------------------------------
      // Three swaps and three clears, one byte each. They exist because the
      // 6502's two index registers are not enough for a machine whose block
      // moves and MMU want scratch space, and because "clear a register" was
      // otherwise LDA #0 (two bytes).
      case 0x02: { this._io(2); const v = this.x; this.x = this.y; this.y = v; return; }  // SXY
      case 0x22: { this._io(2); const v = this.a; this.a = this.x; this.x = v; return; }  // SAX
      case 0x42: { this._io(2); const v = this.a; this.a = this.y; this.y = v; return; }  // SAY
      case 0x62: this._io(1); this.a = 0; return;                                          // CLA
      case 0x82: this._io(1); this.x = 0; return;                                          // CLX
      case 0xc2: this._io(1); this.y = 0; return;                                          // CLY
      // Note: the swaps and clears do NOT touch the flags. That is not an
      // oversight in the hardware — it is what lets them sit inside a compare
      // chain without disturbing it.

      // ---- (zp) addressing (65C02) ------------------------------------------
      case 0x12: this.a = this._nz(this.a | this._rd(this._aInd())); return;   // ORA (zp)
      case 0x32: this.a = this._nz(this.a & this._rd(this._aInd())); return;   // AND (zp)
      case 0x52: this.a = this._nz(this.a ^ this._rd(this._aInd())); return;   // EOR (zp)
      case 0x72: this._adc(this._rd(this._aInd())); return;                    // ADC (zp)
      case 0x92: this._wr(this._aInd(), this.a); return;                       // STA (zp)
      case 0xb2: this.a = this._nz(this._rd(this._aInd())); return;            // LDA (zp)
      case 0xd2: this._cmp(this.a, this._rd(this._aInd())); return;            // CMP (zp)
      case 0xf2: this._sbc(this._rd(this._aInd())); return;                    // SBC (zp)

      // ---- video shortcuts (Hudson) -----------------------------------------
      // ST0/ST1/ST2 write the VDC's address latch and the two halves of its
      // data port without an address bus cycle. A game can therefore drive the
      // video chip with all eight MPRs pointed at its own code and data — no
      // window on the hardware page at all, which on a console with a 64KB
      // address space is worth an instruction.
      case 0x03: { const v = this._fetch(); this._io(2); this._st(0, v); return; }  // ST0
      case 0x13: { const v = this._fetch(); this._io(2); this._st(1, v); return; }  // ST1
      case 0x23: { const v = this._fetch(); this._io(2); this._st(2, v); return; }  // ST2

      // ---- the MMU ----------------------------------------------------------
      // TAM sets every MPR whose bit is set in the operand (games use it to
      // point several windows at one bank), TMA reads one back. Both are five
      // cycles: the register file is not on the bus.
      case 0x53: { // TAM #imm
        const m = this._fetch();
        this._io(3);
        for (let i = 0; i < 8; i++) if (m & (1 << i)) this.mpr[i] = this.a;
        return;
      }
      case 0x43: { // TMA #imm
        const m = this._fetch();
        this._io(3);
        // Several bits set is undefined on hardware; the wire-OR of the
        // selected registers is what a bus with no driver contention does, and
        // it degenerates to the sane answer for the single-bit case games use.
        let v = 0;
        for (let i = 0; i < 8; i++) if (m & (1 << i)) v |= this.mpr[i];
        this.a = v & 0xff;
        return;
      }

      // ---- block transfer ---------------------------------------------------
      case 0x73: this._block('tii'); return;
      case 0xc3: this._block('tdd'); return;
      case 0xd3: this._block('tin'); return;
      case 0xe3: this._block('tia'); return;
      case 0xf3: this._block('tai'); return;

      // ---- TST (Hudson) -----------------------------------------------------
      // BIT with an immediate mask and a memory operand, so a game can test a
      // hardware flag without loading the accumulator first.
      case 0x83: { const m = this._fetch(); this._tst(m, this._aZp()); return; }
      case 0x93: { const m = this._fetch(); this._tst(m, this._aAbs()); return; }
      case 0xa3: { const m = this._fetch(); this._tst(m, this._aZpX()); return; }
      case 0xb3: { const m = this._fetch(); this._tst(m, this._aAbsIdx(this.x, false)); return; }

      // ---- speed and mode ---------------------------------------------------
      case 0x54: this._io(2); this.fast = false; return;   // CSL — 1.79MHz
      case 0xd4: this._io(2); this.fast = true; return;    // CSH — 7.16MHz
      case 0xf4: this._io(1); this.p |= FT; return;        // SET — arm the T flag

      // ---- 65C02 additions ---------------------------------------------------
      case 0x80: this._branch(true); return;                                   // BRA
      case 0x44: { // BSR — JSR with a one-byte relative target
        const off = this._fetch();
        this._io(1);
        this._peekStack();
        // Like JSR, what goes on the stack is the address of the instruction's
        // LAST BYTE, not the return address; RTS adds the one back. Pushing the
        // return address instead makes every BSR return one byte late, which
        // does not crash — it silently skips whatever single-byte instruction
        // followed the call. The sweep found it as "Chew-Man-Fu loops forever":
        // its `BSR sub / INX / CPX #$0C / BNE` counter was never incremented
        // because the INX was the byte being skipped.
        const ret = (this.pc - 1) & 0xffff;
        this._push((ret >> 8) & 0xff);
        this._push(ret & 0xff);
        this.pc = (this.pc + sign8(off)) & 0xffff;
        return;
      }
      case 0x1a: this._io(1); this.a = this._nz((this.a + 1) & 0xff); return;   // INC A
      case 0x3a: this._io(1); this.a = this._nz((this.a - 1) & 0xff); return;   // DEC A
      case 0x5a: this._io(1); this._push(this.y); return;                       // PHY
      case 0x7a: this._io(1); this._peekStack(); this.y = this._nz(this._pull()); return; // PLY
      case 0xda: this._io(1); this._push(this.x); return;                       // PHX
      case 0xfa: this._io(1); this._peekStack(); this.x = this._nz(this._pull()); return; // PLX

      case 0x64: this._wr(this._aZp(), 0); return;                              // STZ
      case 0x74: this._wr(this._aZpX(), 0); return;
      case 0x9c: this._wr(this._aAbs(), 0); return;
      case 0x9e: this._wr(this._aAbsIdx(this.x, true), 0); return;

      case 0x04: this._bitOpMem(this._aZp(), true); return;                     // TSB zp
      case 0x0c: this._bitOpMem(this._aAbs(), true); return;                    // TSB abs
      case 0x14: this._bitOpMem(this._aZp(), false); return;                    // TRB zp
      case 0x1c: this._bitOpMem(this._aAbs(), false); return;                   // TRB abs

      case 0x34: this._bit(this._rd(this._aZpX())); return;                     // BIT zp,X
      case 0x3c: this._bit(this._rd(this._aAbsIdx(this.x, false))); return;     // BIT abs,X
      case 0x89: { // BIT #imm — the one BIT that touches Z only, because there
        const v = this._fetch();                                                // is no memory operand to copy N and V from
        this.p = (this.p & ~FZ) | ((this.a & v) === 0 ? FZ : 0);
        return;
      }
      case 0x7c: this.pc = this._aIndAbsX(); return;                            // JMP (abs,X)
      case 0x6c: { // JMP (abs) — the CMOS part fixed the $xxFF page-wrap bug
        const a = this._aAbs();
        this.pc = this._rd(a) | (this._rd((a + 1) & 0xffff) << 8);
        return;
      }

      // ---- Rockwell bit instructions ----------------------------------------
      // RMB/SMB clear or set one bit of a zero-page byte; BBR/BBS branch on
      // one. Sixteen opcodes each, and PC Engine code uses them constantly for
      // flag bytes, so they are decoded by pattern rather than case by case.
      case 0x07: case 0x17: case 0x27: case 0x37: case 0x47: case 0x57: case 0x67: case 0x77:
        this._bitSet(op >> 4, false); return;                                   // RMB0-7
      case 0x87: case 0x97: case 0xa7: case 0xb7: case 0xc7: case 0xd7: case 0xe7: case 0xf7:
        this._bitSet((op >> 4) & 7, true); return;                              // SMB0-7
      case 0x0f: case 0x1f: case 0x2f: case 0x3f: case 0x4f: case 0x5f: case 0x6f: case 0x7f:
        this._bitBranch(op >> 4, false); return;                                // BBR0-7
      case 0x8f: case 0x9f: case 0xaf: case 0xbf: case 0xcf: case 0xdf: case 0xef: case 0xff:
        this._bitBranch((op >> 4) & 7, true); return;                           // BBS0-7

      // ---- status register: bit 5 is T here, not a stuck 1 -------------------
      case 0x08: this._io(1); this._push(this.p | FB); return;                  // PHP
      case 0x28: { // PLP
        this._io(1); this._peekStack();
        const oldI = this.p & FI;
        this.p = this._pull() & ~FB;
        this._deferI(oldI);
        return;
      }
      case 0x40: { // RTI — pulls P (T and all) and takes effect at once
        this._io(1); this._peekStack();
        this.p = this._pull() & ~FB;
        const lo = this._pull(), hi = this._pull();
        this.pc = (lo | (hi << 8)) & 0xffff;
        return;
      }
      case 0x00: this._fetch(); this._interrupt(VEC_IRQ2, true); return;        // BRK -> IRQ2 vector

      // ---- the holes --------------------------------------------------------
      // A CMOS part has no illegal opcodes: every unused pattern is a NOP of a
      // documented length. Decoding them as the NMOS illegals the parent knows
      // about would be actively wrong — column $xB alone would turn 16 NOPs
      // into ANC/ALR/ARR/SBX and quietly rewrite the accumulator.
      case 0x0b: case 0x1b: case 0x2b: case 0x3b: case 0x4b: case 0x5b: case 0x6b: case 0x7b:
      case 0x8b: case 0x9b: case 0xab: case 0xbb: case 0xcb: case 0xdb: case 0xeb: case 0xfb:
      case 0x33: case 0x63:
        this._io(1); return;                                                    // 1-byte NOP
      case 0xe2: this._fetch(); return;                                         // 2-byte NOP
      case 0x5c: this._aAbs(); this._io(5); return;                             // 3-byte, 8-cycle NOP
      case 0xdc: case 0xfc: this._aAbs(); this._io(1); return;                  // 3-byte NOP

      default:
        // Everything the two chips share: loads, stores, arithmetic, branches,
        // jumps, flags. The parent's switch already has them, and its dummy
        // reads and page-cross behaviour are the ones this chip has too.
        return super._exec(op);
    }
  }

  // ---- helpers --------------------------------------------------------------

  // The T flag's redirected ALU. The "accumulator" is the zero-page byte at
  // $2000+X: read it, run the operation, write it back. A is untouched, and the
  // flags come from the memory result. Three extra cycles pay for the two extra
  // accesses plus the address formation.
  _tAlu(alu, mode) {
    const v = this._tOperand(mode);
    const a = ZP_BASE | this.x;
    const acc = this._rd(a);
    let r;
    if (alu === ALU_ORA) r = this._nz(acc | v);
    else if (alu === ALU_AND) r = this._nz(acc & v);
    else if (alu === ALU_EOR) r = this._nz(acc ^ v);
    else {
      // ADC has flag rules (and a decimal mode) worth reusing rather than
      // re-deriving; borrow the accumulator for the duration.
      const save = this.a;
      this.a = acc;
      this._adc(v);
      r = this.a;
      this.a = save;
    }
    this._io(2);
    this._wr(a, r);
  }

  _tOperand(mode) {
    switch (mode) {
      case AM_IMM: return this._fetch();
      case AM_ZP: return this._rd(this._aZp());
      case AM_ZPX: return this._rd(this._aZpX());
      case AM_ABS: return this._rd(this._aAbs());
      case AM_ABSX: return this._rd(this._aAbsIdx(this.x, false));
      case AM_ABSY: return this._rd(this._aAbsIdx(this.y, false));
      case AM_INDX: return this._rd(this._aIndX());
      case AM_INDY: return this._rd(this._aIndY(false));
      default: return this._rd(this._aInd());
    }
  }

  // ST0/ST1/ST2. The port number is the VDC's own register select / data low /
  // data high, and the bus is asked for it by name so the machine can route it
  // to the video chip without the CPU knowing what a VDC is.
  _st(port, value) {
    if (this.bus.st) this.bus.st(port, value & 0xff);
    this.cycles++;
    if (this.bus.idle) this.bus.idle(1);
    this._endCycle();
  }

  _tst(mask, addr) {
    const v = this._rd(addr);
    this._io(3);
    // N and V come from the MEMORY byte (like BIT), Z from the AND with the
    // immediate mask — so one instruction can ask "is this flag set?" and "what
    // are the top two bits?" at once.
    this.p = (this.p & ~(FN | FV | FZ)) | (v & 0xc0) | ((v & mask) === 0 ? FZ : 0);
  }

  // TSB / TRB: set or clear the accumulator's bits in memory, and report
  // whether any of them were already set. Z is the ONLY flag touched, and it
  // reflects the value BEFORE the change — that is what makes them usable as a
  // test-and-set primitive.
  _bitOpMem(addr, set) {
    const v = this._rd(addr);
    this._io(1);
    this.p = (this.p & ~FZ) | ((v & this.a) === 0 ? FZ : 0);
    this._wr(addr, set ? (v | this.a) : (v & ~this.a));
  }

  _bitSet(bit, set) {
    const addr = this._aZp();
    const v = this._rd(addr);
    this._io(3);
    this._wr(addr, set ? (v | (1 << bit)) : (v & ~(1 << bit)));
  }

  _bitBranch(bit, wantSet) {
    const addr = this._aZp();
    const v = this._rd(addr);
    const off = this._fetch();
    this._io(2);
    const taken = ((v >> bit) & 1) === (wantSet ? 1 : 0);
    if (!taken) return;
    this._io(2);
    this.pc = (this.pc + sign8(off)) & 0xffff;
  }

  // ---- block transfer -------------------------------------------------------
  // Seven bytes: opcode, source, destination, length. Up to 64KB moved by one
  // instruction, at six cycles a byte, with interrupts held off for the whole
  // run — which is why a game that copies a screen with TII drops a frame's
  // worth of raster interrupts and why the five variants exist at all (TIN
  // writes a stream to one fixed port; TIA/TAI alternate two destination or
  // source bytes to de-interleave a bitplane).
  //
  // A/X/Y are pushed and pulled around the loop by the chip's own microcode, so
  // they read as preserved. Documentation disagrees about this; preserving is
  // the safe half of the disagreement, because software that assumes they
  // survive is common and software that assumes they are destroyed does not
  // exist.
  _block(kind) {
    let src = this._fetch() | (this._fetch() << 8);
    let dst = this._fetch() | (this._fetch() << 8);
    let len = this._fetch() | (this._fetch() << 8);
    if (len === 0) len = 0x10000;              // a zero length means the full 64KB
    // The fixed overhead the hardware pays before the first byte moves. Seven
    // of the documented 17 cycles are the opcode and its six operand bytes,
    // already spent above.
    this._io(10);
    let alt = 0;
    for (let i = 0; i < len; i++) {
      const v = this._rd(src & 0xffff);
      this._wr(dst & 0xffff, v);
      this._io(4);                              // six cycles a byte, two of them accesses
      switch (kind) {
        case 'tii': src++; dst++; break;                       // increment / increment
        case 'tdd': src--; dst--; break;                       // decrement / decrement
        case 'tin': src++; break;                              // increment / fixed
        case 'tia': src++; dst += (alt ^= 1) ? 1 : -1; break;  // increment / alternate
        case 'tai': src += (alt ^= 1) ? 1 : -1; dst++; break;  // alternate / increment
      }
    }
  }

  // ---- state ---------------------------------------------------------------
  getState() {
    const s = super.getState();
    s.mpr = Array.from(this.mpr);
    s.fast = this.fast;
    s.irqStatus = this.irqStatus;
    s.irqMask = this.irqMask;
    s.timerReload = this.timerReload;
    s.timerValue = this.timerValue;
    s.timerRun = this.timerRun;
    s.timerAcc = this.timerAcc;
    return s;
  }

  setState(s) {
    super.setState(s);
    if (s.mpr) this.mpr.set(s.mpr);
    this.fast = !!s.fast;
    this.irqStatus = s.irqStatus | 0;
    this.irqMask = s.irqMask ?? 0;
    this.timerReload = s.timerReload | 0;
    this.timerValue = s.timerValue | 0;
    this.timerRun = !!s.timerRun;
    this.timerAcc = s.timerAcc | 0;
    this._syncIrqLine();
    return this;
  }
}

export function createHuC6280(bus, opts) { return new HuC6280(bus, opts); }
