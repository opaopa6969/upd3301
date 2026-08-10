// i8259 — Intel 8259A programmable interrupt controller.
//
// Eight request lines in, one INT pin and a vector out. A PC-9801 has two of
// them, the slave cascaded onto the master's IRQ7 (not IRQ2 — that is the
// PC/AT, and getting it wrong means the floppy controller's interrupt never
// arrives). This file knows nothing about that: the machine wires them.
//
// The initialisation sequence is the awkward part and the reason this is not
// just a mask register. The CPU writes ICW1 to the even port, which starts a
// state machine that expects ICW2 (the vector base) and, depending on ICW1's
// bits, ICW3 (the cascade wiring) and ICW4, on the odd port. Only after that
// do writes to the odd port mean "mask".
//
// Priority is fixed (IRQ0 highest) with the in-service register blocking
// equal and lower requests until the handler sends EOI. Rotating priority and
// the special-mask mode are accepted and ignored; nothing on a 9801's boot
// path uses them.
//
// Pure, deterministic, zero deps.

export const SCHEMA_VERSION = 1;

export class I8259 {
  constructor({ name = 'pic', onOutput = null } = {}) {
    this.name = name;
    this.onOutput = onOutput;   // called when the INT pin changes
    this.reset();
  }

  reset() {
    this.irr = 0;               // requests seen
    this.isr = 0;               // requests being serviced
    this.imr = 0xff;            // masked off until the CPU says otherwise
    this.base = 0;              // ICW2: vector = base + irq
    this.initState = 0;         // 0 = running, 1..3 = expecting ICW2/3/4
    this.icw1 = 0; this.icw3 = 0; this.icw4 = 0;
    this.autoEoi = false;
    this.readIsr = false;       // OCW3 selected ISR instead of IRR for reads
    this.level = new Uint8Array(8);   // last state of each input line
    this.int = false;
    this.slaveMask = 0;         // which IRQ carries a cascaded slave
    return this;
  }

  // ---- input lines ----------------------------------------------------------
  // Edge-triggered: a line that is already high does not re-request. That is
  // what stops a level-held device (the FDC's interrupt, say) from re-entering
  // its own handler the instant it returns.
  raise(irq) {
    const b = 1 << (irq & 7);
    if (!this.level[irq & 7]) {
      this.level[irq & 7] = 1;
      this.irr |= b;
      this._update();
    }
  }

  lower(irq) {
    this.level[irq & 7] = 0;
    this.irr &= ~(1 << (irq & 7));
    this._update();
  }

  pulse(irq) { this.lower(irq); this.raise(irq); }

  // ---- ports ----------------------------------------------------------------
  // Even port: ICW1 / OCW2 / OCW3. Odd port: ICW2-4 / OCW1 (the mask).
  write(even, v) {
    v &= 0xff;
    if (even) {
      if (v & 0x10) {                       // ICW1
        this.icw1 = v;
        this.initState = 1;
        this.imr = 0;
        this.isr = 0;
        this.readIsr = false;
        this._update();
        return;
      }
      if (v & 0x08) {                       // OCW3
        if (v & 0x02) this.readIsr = (v & 1) !== 0;
        return;
      }
      // OCW2: end of interrupt, in one of its several spellings.
      const mode = (v >> 5) & 7;
      if (mode === 1 || mode === 5) {       // non-specific EOI
        const b = this._highestSet(this.isr);
        if (b >= 0) this.isr &= ~(1 << b);
      } else if (mode === 3 || mode === 7) { // specific EOI
        this.isr &= ~(1 << (v & 7));
      }
      this._update();
      return;
    }

    switch (this.initState) {
      case 1:
        this.base = v & 0xf8;
        this.initState = (this.icw1 & 0x02) ? ((this.icw1 & 0x01) ? 3 : 0) : 2;
        return;
      case 2:
        this.icw3 = v;
        this.slaveMask = v;
        this.initState = (this.icw1 & 0x01) ? 3 : 0;
        return;
      case 3:
        this.icw4 = v;
        this.autoEoi = (v & 0x02) !== 0;
        this.initState = 0;
        return;
      default:
        this.imr = v;
        this._update();
        return;
    }
  }

  read(even) {
    if (even) return this.readIsr ? this.isr : this.irr;
    return this.imr;
  }

  // ---- the CPU acknowledges ----------------------------------------------------
  // Returns the vector, or -1 if the request vanished between the pin going
  // high and the acknowledge (a spurious interrupt on real hardware; here the
  // caller simply does not take one).
  ack() {
    const b = this._highestPending();
    if (b < 0) return -1;
    this.irr &= ~(1 << b);
    if (!this.autoEoi) this.isr |= (1 << b);
    this._update();
    return { irq: b, vector: (this.base + b) & 0xff };
  }

  _highestSet(v) {
    for (let i = 0; i < 8; i++) if (v & (1 << i)) return i;
    return -1;
  }

  // Fixed priority: a request only wins if nothing of equal or higher priority
  // is already in service.
  _highestPending() {
    const active = this.irr & ~this.imr;
    if (!active) return -1;
    for (let i = 0; i < 8; i++) {
      const b = 1 << i;
      if (this.isr & b) return -1;          // this one or better is busy
      if (active & b) return i;
    }
    return -1;
  }

  _update() {
    const on = this._highestPending() >= 0;
    if (on !== this.int) {
      this.int = on;
      if (this.onOutput) this.onOutput(on);
    }
  }

  get intPending() { return this.int; }

  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      irr: this.irr, isr: this.isr, imr: this.imr, base: this.base,
      initState: this.initState, icw1: this.icw1, icw3: this.icw3, icw4: this.icw4,
      autoEoi: this.autoEoi, readIsr: this.readIsr,
      level: Array.from(this.level), int: this.int, slaveMask: this.slaveMask,
    };
  }

  setState(s) {
    this.irr = s.irr; this.isr = s.isr; this.imr = s.imr; this.base = s.base;
    this.initState = s.initState; this.icw1 = s.icw1; this.icw3 = s.icw3; this.icw4 = s.icw4;
    this.autoEoi = s.autoEoi; this.readIsr = s.readIsr;
    this.level.set(s.level); this.int = s.int; this.slaveMask = s.slaveMask;
    return this;
  }
}

export default I8259;
