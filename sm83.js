// sm83 — the Game Boy's CPU (Sharp SM83, the core inside the DMG/CGB SoC).
// Pure JS, zero deps, deterministic.
//
// ## Why this is not z80.js
//
// The SM83 is usually described as "a Z80 with bits missing", and the register
// names match, so the obvious move is to derive this from z80.js. That was
// tried on paper and rejected for two reasons, one structural and one about
// blast radius.
//
// The structural one: **z80.js is instruction-atomic**. Its `step()` runs a
// whole instruction against the bus and then returns a T-state count from a
// table. That is the right shape for a PC-8801, where nothing observes the
// machine between two halves of an instruction. It is the wrong shape here.
// The Game Boy's test suites measure *which* M-cycle of an instruction a
// memory access happens on: mooneye's `push_timing`, `call_timing`,
// `oam_dma_timing` and the whole `timer/` group all work by arranging for the
// PPU or the timer to change state between two bus cycles of one instruction
// and then reading the result. So this core is written the way m6502.js is
// (see docs/nes-design.md §4): **there is no cycle table**. Every bus access
// costs exactly one M-cycle, internal delays are explicit `_idle()` calls, and
// the machine's clock advances from inside the CPU's own bus. Cycle counts
// then come out right for free, and — much more usefully — the PPU, the timer
// and the DMA engine see the accesses in the real order.
//
// The blast radius one: z80.js is the CPU of the PC-8801, the machine this
// repository was originally about. `test-z80.mjs` is its regression net. A
// shared base class would put every Game Boy timing fix one edit away from
// that net, for a payoff that is smaller than it looks: no shadow registers,
// no IX/IY, no ED/DD/FD prefixes, no IN/OUT, four flags instead of six (no
// S, no P/V, and the low nibble of F is physically absent), a different DAA,
// different flags on 16-bit ADD, plus eleven opcodes that do not exist and
// twelve that the Z80 never had. What would actually be shared is a dozen
// lines of ALU.
//
// ## The bus
//
// Injected, and it is a *clock* as well as a memory:
//
//   read(a)  → byte, and one M-cycle passes
//   write(a, v)      and one M-cycle passes
//   tick()           one M-cycle passes with no memory access
//   irqPending()  → IE & IF & 0x1F, sampled live
//   irqAck(bit)      clear that bit of IF
//
// The access happens at the END of its M-cycle on hardware, so the machine
// ticks first and then performs the access; that is what puts a write to
// $FF46 (OAM DMA) and a read of $FF41 (STAT) on the right dot.
//
// ## Interrupts
//
// `irqPending()` is called by the CPU, not pushed at it, because two of the
// observable quirks are about *when* the flags are sampled:
//
//   - HALT wakes on `IE & IF` regardless of IME (mooneye halt_ime0_*).
//   - The interrupt vector is chosen AFTER the high byte of PC has been
//     pushed. If SP was $0000 that push lands on $FFFF — the IE register
//     itself — and the vector is decided from the value the push just wrote
//     (mooneye interrupts/ie_push).
//
// Suite contract: no Math.random, same program + same bus → identical state.
// getState()/setState() are exact inverses and return plain data.

export const SCHEMA_VERSION = 1;

// The SM83 keeps four flags in the high nibble of F. The low nibble is not
// "unused", it does not exist: writing $FF to F through POP AF reads back $F0
// (mooneye bits/reg_f).
export const FZ = 0x80, FN = 0x40, FH = 0x20, FC = 0x10;

// Interrupt sources, in priority order, and where each one vectors.
export const IRQ = Object.freeze({ VBLANK: 0, STAT: 1, TIMER: 2, SERIAL: 3, JOYPAD: 4 });
const VECTORS = [0x40, 0x48, 0x50, 0x58, 0x60];

// The eleven opcodes that are not wired to anything. On hardware they hang the
// CPU until reset — it is not an exception and not a NOP, and a ROM that
// reaches one is a ROM that has gone off the rails, which the host wants to be
// told about rather than have silently papered over.
const ILLEGAL = new Set([0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd]);

export class SM83 {
  constructor(bus) {
    this.bus = bus;
    // A debug hook, not hardware: `LD B,B` is a no-op that every mooneye test
    // executes at the point it has decided pass or fail (their
    // `magic_breakpoint`). Leaving a place to notice it costs one comparison
    // per instruction and turns the whole suite into something that can be
    // judged headlessly, without a serial cable or a screen scraper.
    this.onBreakpoint = null;
    this.reset();
  }

  // Post-boot-ROM state. The Game Boy's boot ROM is 256 bytes that show the
  // logo and then unmap themselves, and the cartridge is self-contained after
  // that — so an emulator with no boot ROM only has to arrive at $0100 with
  // the registers the boot ROM would have left. Those values are not cosmetic:
  // mooneye's `boot_regs-*` tests check them one register at a time, and games
  // do read them (the classic being "H is 1 on DMG and 0 on CGB").
  reset({ model = 'dmg' } = {}) {
    if (model === 'cgb') {
      this.a = 0x11; this.f = 0x80;
      this.b = 0x00; this.c = 0x00; this.d = 0xff; this.e = 0x56;
      this.h = 0x00; this.l = 0x0d;
    } else {
      this.a = 0x01; this.f = 0xb0;
      this.b = 0x00; this.c = 0x13; this.d = 0x00; this.e = 0xd8;
      this.h = 0x01; this.l = 0x4d;
    }
    this.sp = 0xfffe;
    this.pc = 0x0100;
    this.ime = false;
    // The EI latch. What makes it subtle is not how long it lasts but WHERE
    // it is resolved: after the interrupt check of the following instruction
    // and before that instruction executes. So the instruction after EI always
    // runs, `EI; DI` never lets anything through (DI resolves the latch and
    // then clears IME again), and eighteen EIs in a row still take the
    // interrupt after the second one — mooneye's ei_sequence pins the pushed
    // return address to the byte.
    this._eiDelay = false;
    this.halted = false;
    this.haltBug = false;   // HALT with IME=0 and an interrupt already pending
    this.stopped = false;
    this.jammed = false;
    this.cycles = 0;        // M-cycles since power-on; the machine's clock is the bus
    return this;
  }

  // Starting from $0000 with a real boot ROM mapped: everything is zero and
  // the boot ROM sets it all up itself. Kept because a user who owns the 256
  // bytes should be able to see the logo scroll.
  resetToBootRom() {
    this.reset();
    this.a = 0; this.f = 0; this.b = 0; this.c = 0; this.d = 0; this.e = 0;
    this.h = 0; this.l = 0; this.sp = 0; this.pc = 0;
    return this;
  }

  getState() {
    const { a, f, b, c, d, e, h, l, sp, pc, ime, halted, haltBug, stopped, jammed, cycles } = this;
    return {
      schemaVersion: SCHEMA_VERSION,
      a, f, b, c, d, e, h, l, sp, pc,
      ime, eiDelay: this._eiDelay, halted, haltBug, stopped, jammed, cycles,
    };
  }

  setState(s) {
    this.a = s.a; this.f = s.f & 0xf0;
    this.b = s.b; this.c = s.c; this.d = s.d; this.e = s.e; this.h = s.h; this.l = s.l;
    this.sp = s.sp; this.pc = s.pc;
    this.ime = s.ime; this._eiDelay = !!s.eiDelay;
    this.halted = s.halted; this.haltBug = s.haltBug ?? false;
    this.stopped = s.stopped ?? false; this.jammed = s.jammed ?? false;
    this.cycles = s.cycles ?? 0;
    return this;
  }

  // ---- register pairs ------------------------------------------------------
  get af() { return (this.a << 8) | this.f; }
  set af(v) { this.a = (v >> 8) & 0xff; this.f = v & 0xf0; }
  get bc() { return (this.b << 8) | this.c; }
  set bc(v) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
  get de() { return (this.d << 8) | this.e; }
  set de(v) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }
  get hl() { return (this.h << 8) | this.l; }
  set hl(v) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }

  // ---- the three things that cost time -------------------------------------
  _rd(a) { this.cycles++; return this.bus.read(a & 0xffff) & 0xff; }
  _wr(a, v) { this.cycles++; this.bus.write(a & 0xffff, v & 0xff); }
  _idle() { this.cycles++; this.bus.tick(); }

  _fetch() { const v = this._rd(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  _fetch16() { const lo = this._fetch(); return lo | (this._fetch() << 8); }

  // PUSH is four M-cycles: opcode, an internal one where SP is decremented,
  // then the two writes, high byte first. The order is visible: a push with
  // SP=$0000 writes IE ($FFFF) before $FFFE.
  _push(v) {
    this.sp = (this.sp - 1) & 0xffff;
    this._wr(this.sp, (v >> 8) & 0xff);
    this.sp = (this.sp - 1) & 0xffff;
    this._wr(this.sp, v & 0xff);
  }

  _pop() {
    const lo = this._rd(this.sp); this.sp = (this.sp + 1) & 0xffff;
    const hi = this._rd(this.sp); this.sp = (this.sp + 1) & 0xffff;
    return (hi << 8) | lo;
  }

  // ---- 8-bit ALU -----------------------------------------------------------
  _add(v, carry) {
    const a = this.a, r = a + v + carry, res = r & 0xff;
    this.f = (res === 0 ? FZ : 0)
      | (((a & 0x0f) + (v & 0x0f) + carry) > 0x0f ? FH : 0)
      | (r > 0xff ? FC : 0);
    this.a = res;
  }

  _sub(v, carry, store = true) {
    const a = this.a, r = a - v - carry, res = r & 0xff;
    this.f = (res === 0 ? FZ : 0) | FN
      | (((a & 0x0f) - (v & 0x0f) - carry) < 0 ? FH : 0)
      | (r < 0 ? FC : 0);
    if (store) this.a = res;
    return res;
  }

  _and(v) { this.a &= v; this.f = (this.a === 0 ? FZ : 0) | FH; }
  _xor(v) { this.a ^= v; this.f = this.a === 0 ? FZ : 0; }
  _or(v) { this.a |= v; this.f = this.a === 0 ? FZ : 0; }

  _inc8(v) {
    const r = (v + 1) & 0xff;
    this.f = (this.f & FC) | (r === 0 ? FZ : 0) | ((v & 0x0f) === 0x0f ? FH : 0);
    return r;
  }

  _dec8(v) {
    const r = (v - 1) & 0xff;
    this.f = (this.f & FC) | (r === 0 ? FZ : 0) | FN | ((v & 0x0f) === 0 ? FH : 0);
    return r;
  }

  // ADD HL,rr leaves Z alone and computes H/C from bit 11 / bit 15. The
  // asymmetry with ADD SP,e (which uses bit 3 / bit 7, because e is a *byte*
  // added to the low half) is real hardware, not a typo, and mooneye's
  // add_sp_e_timing / instr tests care.
  _addHl(v) {
    const hl = this.hl, r = hl + v;
    this.f = (this.f & FZ)
      | (((hl & 0x0fff) + (v & 0x0fff)) > 0x0fff ? FH : 0)
      | (r > 0xffff ? FC : 0);
    this.hl = r & 0xffff;
  }

  _addSpE(e) {
    const sp = this.sp, r = (sp + e) & 0xffff;
    this.f = (((sp & 0x0f) + (e & 0x0f)) > 0x0f ? FH : 0)
      | (((sp & 0xff) + (e & 0xff)) > 0xff ? FC : 0);
    return r;
  }

  // DAA on the SM83 is not the Z80's. There is no N-flag-driven table lookup
  // of the same shape: the adjustment is built from H/C and, only when the
  // previous op was an addition, from the digits themselves. Getting the
  // subtraction branch wrong is invisible until blargg's cpu_instrs 01 runs.
  _daa() {
    let a = this.a, adj = 0, carry = this.f & FC;
    if (this.f & FN) {
      if (this.f & FH) adj |= 0x06;
      if (carry) adj |= 0x60;
      a = (a - adj) & 0xff;
    } else {
      if ((this.f & FH) || (a & 0x0f) > 0x09) adj |= 0x06;
      if (carry || a > 0x99) { adj |= 0x60; carry = FC; }
      a = (a + adj) & 0xff;
    }
    this.a = a;
    this.f = (a === 0 ? FZ : 0) | (this.f & FN) | carry;
  }

  // ---- register file indexed the way the opcode map is --------------------
  // B C D E H L (HL) A. Index 6 is memory, which is why it costs a cycle.
  _getR(i) {
    switch (i) {
      case 0: return this.b; case 1: return this.c; case 2: return this.d;
      case 3: return this.e; case 4: return this.h; case 5: return this.l;
      case 6: return this._rd(this.hl); default: return this.a;
    }
  }

  _setR(i, v) {
    v &= 0xff;
    switch (i) {
      case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break;
      case 3: this.e = v; break; case 4: this.h = v; break; case 5: this.l = v; break;
      case 6: this._wr(this.hl, v); break; default: this.a = v;
    }
  }

  _cond(i) {
    switch (i) {
      case 0: return (this.f & FZ) === 0;
      case 1: return (this.f & FZ) !== 0;
      case 2: return (this.f & FC) === 0;
      default: return (this.f & FC) !== 0;
    }
  }

  // ---- one instruction (or one interrupt dispatch, or one halted cycle) ----
  step() {
    if (this.jammed) { this._idle(); return 1; }
    const start = this.cycles;


    // STOP is only left by a joypad line going low, which the machine reports
    // by clearing `stopped`; interrupts do not wake it.
    if (this.stopped) { this._idle(); return this.cycles - start; }

    if (this.halted) {
      // HALT is left by IE & IF alone; IME only decides whether the handler
      // then runs, which is the difference mooneye's halt_ime0_* measure.
      if (this.bus.irqPending()) {
        this.halted = false;
        if (this.ime) { this._interrupt(); return this.cycles - start; }
      } else {
        this._idle();
        return this.cycles - start;
      }
    }

    if (this.ime && this.bus.irqPending()) {
      this._interrupt();
      return this.cycles - start;
    }

    // The EI latch resolves HERE — past the interrupt check the following
    // instruction is entitled to skip, and before that instruction runs.
    if (this._eiDelay) { this.ime = true; this._eiDelay = false; }

    let op = this._fetch();
    if (this.haltBug) {
      // HALT executed with IME=0 while an interrupt was already pending does
      // not halt — it fails to increment PC, so the byte after HALT is
      // executed twice. Games hit this by accident and depend on the result.
      this.pc = (this.pc - 1) & 0xffff;
      this.haltBug = false;
    }
    this._exec(op);
    return this.cycles - start;
  }

  // Five M-cycles: two internal, two pushes, and the one where PC becomes the
  // vector. See the header for why the vector is chosen between the pushes.
  _interrupt() {
    this.ime = false;
    this._eiDelay = false;
    this.halted = false;
    this._idle();
    this._idle();
    const pc = this.pc;
    this.sp = (this.sp - 1) & 0xffff;
    this._wr(this.sp, (pc >> 8) & 0xff);
    const pending = this.bus.irqPending();
    let bit = -1;
    for (let i = 0; i < 5; i++) if (pending & (1 << i)) { bit = i; break; }
    this.sp = (this.sp - 1) & 0xffff;
    this._wr(this.sp, pc & 0xff);
    if (bit < 0) {
      // The push cancelled the request (it overwrote IE). The dispatch still
      // happens, it just has nowhere to go: PC becomes $0000.
      this.pc = 0x0000;
    } else {
      this.bus.irqAck(bit);
      this.pc = VECTORS[bit];
    }
    this._idle();
  }

  _exec(op) {
    // 0x40-0x7F is one dense block of LD r,r' with HALT punched out of the
    // middle, so it is worth taking before the switch.
    if (op >= 0x40 && op < 0x80) {
      if (op === 0x76) { this._halt(); return; }
      const dst = (op >> 3) & 7, src = op & 7;
      if (op === 0x40 && this.onBreakpoint) this.onBreakpoint(this);
      this._setR(dst, this._getR(src));
      return;
    }
    if (op >= 0x80 && op < 0xc0) { this._alu((op >> 3) & 7, this._getR(op & 7)); return; }

    switch (op) {
      case 0x00: return;                                            // NOP
      case 0x10: this._stop(); return;                              // STOP
      case 0xcb: this._cb(this._fetch()); return;

      // ---- 16-bit loads ----
      case 0x01: this.bc = this._fetch16(); return;
      case 0x11: this.de = this._fetch16(); return;
      case 0x21: this.hl = this._fetch16(); return;
      case 0x31: this.sp = this._fetch16(); return;
      // LD (nn),SP is the longest load: opcode, two address bytes, two writes.
      case 0x08: { const a = this._fetch16(); this._wr(a, this.sp & 0xff); this._wr((a + 1) & 0xffff, this.sp >> 8); return; }
      case 0xf9: this.sp = this.hl; this._idle(); return;            // LD SP,HL (4 M)
      case 0xf8: { const e = (this._fetch() << 24) >> 24; const r = this._addSpE(e); this._idle(); this.hl = r; return; }
      case 0xe8: { const e = (this._fetch() << 24) >> 24; const r = this._addSpE(e); this._idle(); this._idle(); this.sp = r; return; }

      // ---- 8-bit loads that only exist on this chip ----
      case 0x02: this._wr(this.bc, this.a); return;
      case 0x12: this._wr(this.de, this.a); return;
      case 0x22: this._wr(this.hl, this.a); this.hl = (this.hl + 1) & 0xffff; return;  // LD (HL+),A
      case 0x32: this._wr(this.hl, this.a); this.hl = (this.hl - 1) & 0xffff; return;  // LD (HL-),A
      case 0x0a: this.a = this._rd(this.bc); return;
      case 0x1a: this.a = this._rd(this.de); return;
      case 0x2a: this.a = this._rd(this.hl); this.hl = (this.hl + 1) & 0xffff; return;
      case 0x3a: this.a = this._rd(this.hl); this.hl = (this.hl - 1) & 0xffff; return;
      // LDH — the whole of $FF00-$FFFF (every hardware register plus the fast
      // 127 bytes of HRAM) reached with a one-byte operand. This is why Game
      // Boy code is small, and it has no Z80 equivalent.
      case 0xe0: this._wr(0xff00 | this._fetch(), this.a); return;
      case 0xf0: this.a = this._rd(0xff00 | this._fetch()); return;
      case 0xe2: this._wr(0xff00 | this.c, this.a); return;
      case 0xf2: this.a = this._rd(0xff00 | this.c); return;
      case 0xea: this._wr(this._fetch16(), this.a); return;
      case 0xfa: this.a = this._rd(this._fetch16()); return;

      // ---- 16-bit arithmetic. INC/DEC rr set no flags at all. ----
      case 0x03: this.bc = (this.bc + 1) & 0xffff; this._idle(); return;
      case 0x13: this.de = (this.de + 1) & 0xffff; this._idle(); return;
      case 0x23: this.hl = (this.hl + 1) & 0xffff; this._idle(); return;
      case 0x33: this.sp = (this.sp + 1) & 0xffff; this._idle(); return;
      case 0x0b: this.bc = (this.bc - 1) & 0xffff; this._idle(); return;
      case 0x1b: this.de = (this.de - 1) & 0xffff; this._idle(); return;
      case 0x2b: this.hl = (this.hl - 1) & 0xffff; this._idle(); return;
      case 0x3b: this.sp = (this.sp - 1) & 0xffff; this._idle(); return;
      case 0x09: this._addHl(this.bc); this._idle(); return;
      case 0x19: this._addHl(this.de); this._idle(); return;
      case 0x29: this._addHl(this.hl); this._idle(); return;
      case 0x39: this._addHl(this.sp); this._idle(); return;

      // ---- accumulator / flag ops ----
      case 0x07: { const c = (this.a >> 7) & 1; this.a = ((this.a << 1) | c) & 0xff; this.f = c ? FC : 0; return; }
      case 0x0f: { const c = this.a & 1; this.a = (this.a >> 1) | (c << 7); this.f = c ? FC : 0; return; }
      case 0x17: { const c = (this.f & FC) ? 1 : 0, n = (this.a >> 7) & 1; this.a = ((this.a << 1) | c) & 0xff; this.f = n ? FC : 0; return; }
      case 0x1f: { const c = (this.f & FC) ? 0x80 : 0, n = this.a & 1; this.a = (this.a >> 1) | c; this.f = n ? FC : 0; return; }
      case 0x27: this._daa(); return;
      case 0x2f: this.a ^= 0xff; this.f |= FN | FH; return;
      case 0x37: this.f = (this.f & FZ) | FC; return;
      case 0x3f: this.f = (this.f & FZ) | ((this.f & FC) ? 0 : FC); return;

      // ---- control flow. The extra M-cycle on a TAKEN branch is where the
      // program counter is loaded, and it is only spent if the branch is
      // taken — that difference is the whole of mooneye's *_cc_timing set.
      case 0xc3: { const t = this._fetch16(); this._idle(); this.pc = t; return; }
      case 0xe9: this.pc = this.hl; return;                          // JP HL: 1 M, no delay
      case 0x18: { const e = (this._fetch() << 24) >> 24; this._idle(); this.pc = (this.pc + e) & 0xffff; return; }
      case 0xcd: { const t = this._fetch16(); this._idle(); this._push(this.pc); this.pc = t; return; }
      case 0xc9: { const t = this._pop(); this._idle(); this.pc = t; return; }
      case 0xd9: { const t = this._pop(); this._idle(); this.pc = t; this.ime = true; this._eiDelay = false; return; }  // RETI: immediate, no EI delay

      case 0xc1: this.bc = this._pop(); return;
      case 0xd1: this.de = this._pop(); return;
      case 0xe1: this.hl = this._pop(); return;
      case 0xf1: this.af = this._pop(); return;
      case 0xc5: this._idle(); this._push(this.bc); return;
      case 0xd5: this._idle(); this._push(this.de); return;
      case 0xe5: this._idle(); this._push(this.hl); return;
      case 0xf5: this._idle(); this._push(this.af); return;

      case 0xf3: this.ime = false; this._eiDelay = false; return;    // DI is immediate
      case 0xfb: this._eiDelay = true; return;                       // EI is not

      default: break;
    }

    // ---- the regular sub-blocks, decoded rather than tabulated ----
    const y = (op >> 3) & 7, z = op & 7;
    switch (z) {
      case 0: // 0x20/28/30/38 JR cc,e — 0x00/08/10/18 were handled above
        if (op >= 0x20 && op <= 0x38) {
          const e = (this._fetch() << 24) >> 24;
          if (this._cond(y - 4)) { this._idle(); this.pc = (this.pc + e) & 0xffff; }
          return;
        }
        if (op >= 0xc0 && op <= 0xd8) { // RET cc
          this._idle();                 // the condition test costs a cycle on its own
          if (this._cond(y)) { const t = this._pop(); this._idle(); this.pc = t; }
          return;
        }
        break;
      case 2: // JP cc,nn
        if (op >= 0xc2 && op <= 0xda) {
          const t = this._fetch16();
          if (this._cond(y)) { this._idle(); this.pc = t; }
          return;
        }
        break;
      case 4: // CALL cc,nn
        if (op >= 0xc4 && op <= 0xdc) {
          const t = this._fetch16();
          if (this._cond(y)) { this._idle(); this._push(this.pc); this.pc = t; }
          return;
        }
        break;
      case 6: // ALU A,n
        if (op >= 0xc6) { this._alu(y, this._fetch()); return; }
        // INC r / DEC r / LD r,n live at z=4/5/6 in the low half
        break;
      case 7: // RST y*8
        if (op >= 0xc7) { this._idle(); this._push(this.pc); this.pc = y * 8; return; }
        break;
      default: break;
    }
    if (op < 0x40) {
      if (z === 4) { this._setR(y, this._inc8(this._getR(y))); return; }
      if (z === 5) { this._setR(y, this._dec8(this._getR(y))); return; }
      if (z === 6) { this._setR(y, this._fetch()); return; }
    }

    if (ILLEGAL.has(op)) { this.jammed = true; this.pc = (this.pc - 1) & 0xffff; return; }
    throw new Error(`sm83: unreachable opcode $${op.toString(16)}`); // decoder bug, not a ROM bug
  }

  _alu(kind, v) {
    switch (kind) {
      case 0: this._add(v, 0); return;
      case 1: this._add(v, (this.f & FC) ? 1 : 0); return;
      case 2: this._sub(v, 0); return;
      case 3: this._sub(v, (this.f & FC) ? 1 : 0); return;
      case 4: this._and(v); return;
      case 5: this._xor(v); return;
      case 6: this._or(v); return;
      default: this._sub(v, 0, false); return; // CP
    }
  }

  // ---- CB prefix: rotates/shifts/SWAP, then BIT/RES/SET ---------------------
  // BIT n,(HL) is three M-cycles, not four: it reads and never writes back.
  _cb(op) {
    const y = (op >> 3) & 7, z = op & 7;
    if (op < 0x40) {
      const v = this._getR(z);
      let r, c;
      switch (y) {
        case 0: c = (v >> 7) & 1; r = ((v << 1) | c) & 0xff; break;                    // RLC
        case 1: c = v & 1; r = (v >> 1) | (c << 7); break;                             // RRC
        case 2: c = (v >> 7) & 1; r = ((v << 1) | ((this.f & FC) ? 1 : 0)) & 0xff; break; // RL
        case 3: c = v & 1; r = (v >> 1) | ((this.f & FC) ? 0x80 : 0); break;           // RR
        case 4: c = (v >> 7) & 1; r = (v << 1) & 0xff; break;                          // SLA
        case 5: c = v & 1; r = (v >> 1) | (v & 0x80); break;                           // SRA
        case 6: c = 0; r = ((v << 4) | (v >> 4)) & 0xff; break;                        // SWAP
        default: c = v & 1; r = v >> 1; break;                                         // SRL
      }
      this.f = (r === 0 ? FZ : 0) | (c ? FC : 0);
      this._setR(z, r);
      return;
    }
    if (op < 0x80) { // BIT
      const v = this._getR(z);
      this.f = (this.f & FC) | FH | ((v & (1 << y)) ? 0 : FZ);
      return;
    }
    if (op < 0xc0) { this._setR(z, this._getR(z) & ~(1 << y)); return; } // RES
    this._setR(z, this._getR(z) | (1 << y));                             // SET
  }

  _halt() {
    if (this.ime) { this.halted = true; return; }
    // IME=0: if something is already pending the CPU does not halt at all and
    // the next byte is read twice (the "halt bug"). If nothing is pending it
    // halts and will wake, but without running a handler.
    if (this.bus.irqPending()) this.haltBug = true;
    else this.halted = true;
  }

  // STOP is a two-byte instruction on paper and a mess in practice. The one
  // use that matters is the CGB speed switch: with a switch armed in KEY1,
  // STOP performs it and execution continues. Otherwise the CPU sleeps until
  // a joypad line goes low, which the machine reports by clearing `stopped`.
  _stop() {
    this._fetch(); // the ignored second byte
    if (this.bus.speedSwitchArmed && this.bus.speedSwitchArmed()) { this.bus.doSpeedSwitch(); return; }
    this.stopped = true;
  }
}

export function createSM83(bus) { return new SM83(bus); }
