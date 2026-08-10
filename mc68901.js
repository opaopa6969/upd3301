// mc68901 — the Motorola MFP, the X68000's interrupt controller, its four
// timers and the port the keyboard talks through.
//
// Everything time-related on this machine passes through here. The 200 Hz
// system tick Human68k counts on is Timer C; the vertical and horizontal sync
// the display code waits for arrive as GPIP edges; the keyboard is a 2400 baud
// serial link into the receiver. There is no separate PIC — the MFP *is* the
// machine's interrupt level 6, and it hands the 68000 a vector directly
// (vectored, not autovectored), which is why m68000.js's `irqAck` hook exists.
//
// ## The two register groups
//
// Sixteen interrupt sources sit in two bytes. Numbering them is the part
// everyone gets backwards, so, once, explicitly: source 0 is the HIGHEST
// priority and lives in bit 7 of the A registers; source 15 is the lowest and
// lives in bit 0 of the B registers. The vector number runs the other way —
// bit 7 of A is vector 15, bit 0 of B is vector 0 — so `vector = 15 - source`
// happens to hold for the whole range. The top nibble comes from VR.
//
//   A: 7 GPIP7(HSYNC) 6 GPIP6(CRTC raster) 5 TimerA 4 RxFull 3 RxError
//      2 TxEmpty 1 TxError 0 TimerB
//   B: 7 GPIP5 6 GPIP4(VDISP) 5 TimerC 4 TimerD 3 GPIP3(OPM) 2 GPIP2(POWER)
//      1 GPIP1(EXPON) 0 GPIP0(RTC alarm)
//
// ## The clock
//
// The MFP runs at 4 MHz against the 68000's 10 MHz. That ratio is 5/2, which
// is not an integer, so the timers are driven in HALF 68000 cycles: one MFP
// clock is five of them, and a prescaler of 200 is 1000. Nothing accumulates
// a float and the same input gives the same interrupt on the same cycle
// forever, which is what the rewind ring needs.
//
// Pure, deterministic, zero deps.

export const SCHEMA_VERSION = 1;

export const REG = Object.freeze({
  GPIP: 0, AER: 1, DDR: 2, IERA: 3, IERB: 4, IPRA: 5, IPRB: 6,
  ISRA: 7, ISRB: 8, IMRA: 9, IMRB: 10, VR: 11,
  TACR: 12, TBCR: 13, TCDCR: 14, TADR: 15, TBDR: 16, TCDR: 17, TDDR: 18,
  SCR: 19, UCR: 20, RSR: 21, TSR: 22, UDR: 23,
});

// Interrupt source numbers, 0 = highest.
export const SRC = Object.freeze({
  GPIP7: 0, GPIP6: 1, TIMER_A: 2, RX_FULL: 3, RX_ERROR: 4,
  TX_EMPTY: 5, TX_ERROR: 6, TIMER_B: 7,
  GPIP5: 8, GPIP4: 9, TIMER_C: 10, TIMER_D: 11,
  GPIP3: 12, GPIP2: 13, GPIP1: 14, GPIP0: 15,
});

// The MC68901's prescalers, in MFP clocks. Index = the low three bits of a
// timer control register; 0 means the timer is stopped.
const PRESCALER = [0, 4, 10, 16, 50, 64, 100, 200];
// One MFP clock is 5 half-68000-cycles (4 MHz against 10 MHz).
const HALF_CYCLES_PER_MFP_CLOCK = 5;

export class Mc68901 {
  constructor() {
    this.reg = new Uint8Array(24);
    this.reset();
  }

  reset() {
    this.reg.fill(0);
    // Power-on values the IPL relies on finding: the timers stopped, the
    // receiver enabled, and GPIP configured all-input.
    this.reg[REG.GPIP] = 0x00;
    this.reg[REG.VR] = 0x00;
    this.reg[REG.RSR] = 0x01;   // RE (receiver enable)
    this.reg[REG.TSR] = 0x80;   // the transmitter is always ready here
    this.reload = [0, 0, 0, 0];
    this.tick = [0, 0, 0, 0];   // per-timer prescaler remainder, in half-cycles
    this.count = [0, 0, 0, 0];  // the live down-counters
    this.gpip = 0x00;           // the pin levels the machine drives
    this.prevGpip = 0x00;
    this.rxByte = 0;
    this.rxFull = false;
    return this;
  }

  // ---- interrupt plumbing ---------------------------------------------------
  // A source only latches into IPR if its enable bit is set — a masked-off
  // source is invisible, but a *disabled* one never even happened, and the
  // difference shows up when a program enables an interrupt it has been
  // ignoring and does not want the backlog.
  request(src) {
    const group = src < 8 ? 0 : 1;
    const bit = 0x80 >> (src & 7);
    if (this.reg[REG.IERA + group] & bit) this.reg[REG.IPRA + group] |= bit;
    return this;
  }

  clear(src) {
    const group = src < 8 ? 0 : 1;
    this.reg[REG.IPRA + group] &= ~(0x80 >> (src & 7));
    return this;
  }

  // True when some enabled, unmasked, not-already-in-service source is
  // pending. The machine turns this into IPL6 on the 68000.
  get intPending() {
    return this._highest() >= 0;
  }

  _highest() {
    for (let g = 0; g < 2; g++) {
      const ipr = this.reg[REG.IPRA + g], imr = this.reg[REG.IMRA + g], isr = this.reg[REG.ISRA + g];
      const live = ipr & imr & ~isr;
      if (!live) continue;
      for (let i = 0; i < 8; i++) if (live & (0x80 >> i)) return g * 8 + i;
    }
    return -1;
  }

  // The interrupt acknowledge cycle. Returns the vector, or -1 if the source
  // went away between the request and the acknowledge (the 68000 then takes a
  // spurious interrupt, which is exactly what the hardware does).
  ack() {
    const src = this._highest();
    if (src < 0) return -1;
    const group = src < 8 ? 0 : 1;
    const bit = 0x80 >> (src & 7);
    this.reg[REG.IPRA + group] &= ~bit;
    // Software End-of-Interrupt mode (VR bit 3) parks the source in ISR until
    // the handler clears it, so a second edge cannot pre-empt itself.
    if (this.reg[REG.VR] & 0x08) this.reg[REG.ISRA + group] |= bit;
    return ((this.reg[REG.VR] & 0xf0) | (15 - src)) & 0xff;
  }

  // ---- GPIP -----------------------------------------------------------------
  // The machine drives the pins; the MFP turns the transitions AER selects into
  // interrupts. HSYNC and VDISP are ordinary pins here, which is why a program
  // can pick the leading or the trailing edge of the display period simply by
  // writing AER.
  setGpip(mask, level) {
    const before = this.gpip;
    if (level) this.gpip |= mask; else this.gpip &= ~mask;
    const changed = before ^ this.gpip;
    if (!changed) return this;
    for (let b = 0; b < 8; b++) {
      const m = 1 << b;
      if (!(changed & m)) continue;
      const want = (this.reg[REG.AER] & m) !== 0; // 1 = interrupt on rising
      const now = (this.gpip & m) !== 0;
      if (now === want) this.request(GPIP_SRC[b]);
    }
    return this;
  }

  // ---- the serial receiver (the keyboard) ------------------------------------
  pushRx(byte) {
    this.rxByte = byte & 0xff;
    this.rxFull = true;
    this.request(SRC.RX_FULL);
    return this;
  }

  // ---- registers -------------------------------------------------------------
  // Only odd addresses answer: the MFP is an 8-bit part on the upper half of a
  // 16-bit bus, so its registers are two bytes apart.
  read(a) {
    if (!(a & 1)) return 0xff;
    const r = (a & 0x3f) >> 1;
    if (r >= 24) return 0x00;
    switch (r) {
      case REG.GPIP: return this.gpip;
      case REG.UDR: {
        this.rxFull = false;
        return this.rxByte;
      }
      case REG.RSR: return (this.reg[REG.RSR] & 0x7f) | (this.rxFull ? 0x80 : 0x00);
      default: return this.reg[r];
    }
  }

  write(a, v) {
    if (!(a & 1)) return;
    const r = (a & 0x3f) >> 1;
    if (r >= 24) return;
    v &= 0xff;
    switch (r) {
      case REG.IERA: case REG.IERB:
        this.reg[r] = v;
        // Disabling a source drops anything it had already latched. Without
        // this a driver that turns an interrupt off and on again takes the
        // stale one immediately.
        this.reg[r + 2] &= v;
        return;
      // IPR and ISR are write-ZERO-to-clear: the handler writes back a mask
      // with the bit it handled cleared. Writing ones does nothing.
      case REG.IPRA: case REG.IPRB: case REG.ISRA: case REG.ISRB:
        this.reg[r] &= v;
        return;
      case REG.TADR: this.reload[0] = v; this.count[0] = v; this.reg[r] = v; return;
      case REG.TBDR: this.reload[1] = v; this.count[1] = v; this.reg[r] = v; return;
      case REG.TCDR: this.reload[2] = v; this.count[2] = v; this.reg[r] = v; return;
      case REG.TDDR: this.reload[3] = v; this.count[3] = v; this.reg[r] = v; return;
      case REG.TSR: this.reg[r] = v | 0x80; return; // nothing consumes what we send
      case REG.UDR: return;                          // transmit: dropped on the floor
      case REG.GPIP: return;                         // all pins are inputs here
      default: this.reg[r] = v; return;
    }
  }

  // ---- timers ----------------------------------------------------------------
  // `halfCycles` is 68000 cycles times two. Delay mode only; a timer in event
  // count mode is stepped by the machine through countEvent() instead.
  advance(halfCycles) {
    this._delay(0, this.reg[REG.TACR] & 0x0f, halfCycles, SRC.TIMER_A);
    this._delay(1, this.reg[REG.TBCR] & 0x0f, halfCycles, SRC.TIMER_B);
    this._delay(2, (this.reg[REG.TCDCR] >> 4) & 0x07, halfCycles, SRC.TIMER_C);
    this._delay(3, this.reg[REG.TCDCR] & 0x07, halfCycles, SRC.TIMER_D);
    return this;
  }

  _delay(i, ctrl, halfCycles, src) {
    // Bit 3 set on A/B is event-count or pulse-width mode; neither is driven
    // by the prescaler. C and D only have three bits, so this test is a no-op
    // for them.
    if (ctrl & 0x08) return;
    const pre = PRESCALER[ctrl & 0x07];
    if (!pre) return;
    const period = pre * HALF_CYCLES_PER_MFP_CLOCK;
    this.tick[i] += halfCycles;
    while (this.tick[i] >= period) {
      this.tick[i] -= period;
      this._decrement(i, src);
    }
  }

  _decrement(i, src) {
    // A data register of 0 means 256 on this part: the counter is written
    // before it is used, and the reload of 0 rolls the whole way round.
    this.count[i] = (this.count[i] - 1) & 0xff;
    this.reg[REG.TADR + i] = this.count[i];
    if (this.count[i] === 0) {
      this.count[i] = this.reload[i];
      this.reg[REG.TADR + i] = this.reload[i];
      this.request(src);
    }
  }

  // Timer A in event-count mode counts a GPIP transition rather than the
  // clock. On the X68000 that pin is VDISP, which makes Timer A a programmable
  // "interrupt me every N frames" — several games' whole frame pacing.
  countEventA() {
    if ((this.reg[REG.TACR] & 0x0f) !== 0x08) return this;
    this._decrement(0, SRC.TIMER_A);
    return this;
  }

  get timerAEventMode() { return (this.reg[REG.TACR] & 0x0f) === 0x08; }

  // ---- state ------------------------------------------------------------------
  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      reg: Array.from(this.reg),
      reload: [...this.reload], tick: [...this.tick], count: [...this.count],
      gpip: this.gpip, rxByte: this.rxByte, rxFull: this.rxFull,
    };
  }

  setState(s) {
    this.reg.set(s.reg);
    this.reload = [...s.reload]; this.tick = [...s.tick]; this.count = [...s.count];
    this.gpip = s.gpip; this.rxByte = s.rxByte; this.rxFull = s.rxFull;
    return this;
  }
}

// GPIP bit -> interrupt source. Bit 7 is the highest priority source there is.
const GPIP_SRC = [SRC.GPIP0, SRC.GPIP1, SRC.GPIP2, SRC.GPIP3, SRC.GPIP4, SRC.GPIP5, SRC.GPIP6, SRC.GPIP7];

export default Mc68901;
