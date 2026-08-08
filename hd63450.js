// hd63450 — Hitachi's four-channel DMA controller, the X68000's data pump.
//
// Nothing bulk moves on this machine without it. Channel 0 is the floppy
// controller, 1 is the SASI/SCSI hard disk, 2 is the expansion slot (the
// Mercury sound board lives there) and 3 is the ADPCM chip. Human68k reads
// every sector through channel 0, so a machine whose DMAC does not work does
// not boot — there is no programmed-I/O fallback in the IOCS.
//
// ## The shape of a transfer
//
// A channel has a memory side (MAR, stepped by SCR bits 3-2) and a device side
// (DAR, stepped by SCR bits 1-0), a count of operands (MTC) and a direction
// (OCR bit 7). What makes it interesting is that "operand" and "bus cycle" are
// not the same thing: with an 8-bit device (DCR bit 3 clear) a long operand is
// four separate byte reads of the same device register, because the device
// only has eight data pins. That is exactly how the floppy controller is
// wired, and getting it wrong reads every fourth byte of every sector.
//
// ## Request generation
//
// OCR bits 1-0 pick who decides when an operand moves:
//
//   00  auto-request at a "limited rate" (the DMAC takes some of the bus)
//   01  auto-request at maximum rate (the DMAC takes ALL of the bus, burst)
//   10  external request: the device raises DREQ, one operand per raise
//   11  reserved
//
// Only the burst mode runs to completion inside one call; everything else
// moves one operand and returns, which is what lets the CPU keep running
// while a disk read proceeds. The caller supplies a budget so an external-
// request channel advances at the device's real data rate rather than
// emptying a sector in zero machine time.
//
// Pure, deterministic, zero deps. The bus is injected: this file has never
// heard of an X68000 memory map.

export const SCHEMA_VERSION = 1;

// CSR
const CSR_COC = 0x80; // channel operation complete
const CSR_BTC = 0x40; // block transfer complete
const CSR_ERR = 0x10;
const CSR_ACT = 0x08; // channel active
// CCR
const CCR_STR = 0x80;
const CCR_CNT = 0x40;
const CCR_HLT = 0x20;
const CCR_SAB = 0x10;
const CCR_INT = 0x08;

// Channel error codes (CER), as the manual numbers them.
const ERR_CONFIG = 0x01;
const ERR_TIMING = 0x02;
const ERR_ADDR_MEM = 0x05;
const ERR_ADDR_DEV = 0x06;
const ERR_BUS_MEM = 0x09;
const ERR_BUS_DEV = 0x0a;
const ERR_COUNT = 0x0d;
const ERR_ABORT = 0x11;

class Channel {
  constructor() { this.reset(); }
  reset() {
    this.csr = 0; this.cer = 0;
    this.dcr = 0; this.ocr = 0; this.scr = 0; this.ccr = 0;
    this.mtc = 0; this.mar = 0; this.dar = 0; this.btc = 0; this.bar = 0;
    this.niv = 0; this.eiv = 0;
    this.mfc = 0; this.cpr = 0; this.dfc = 0; this.bfc = 0; this.gcr = 0;
    return this;
  }
}

export class Hd63450 {
  // `bus` needs read8/write8/read16/write16/read32/write32 over the 68000's
  // address space. `deviceReady(ch)` answers DREQ for external-request
  // channels. `onInterrupt()` is a hint that the IRQ line may have moved.
  constructor({ bus, deviceReady = () => false, onInterrupt = null } = {}) {
    this.bus = bus;
    this.deviceReady = deviceReady;
    this.onInterrupt = onInterrupt;
    this.ch = [new Channel(), new Channel(), new Channel(), new Channel()];
    this.intPendingMask = 0;
    this.lastInt = 0;
    this.gcr = 0;
  }

  reset() {
    for (const c of this.ch) c.reset();
    this.intPendingMask = 0;
    this.lastInt = 0;
    return this;
  }

  get intPending() { return this.intPendingMask !== 0; }

  // Vectored acknowledge, round-robin from wherever the last one left off so a
  // busy channel cannot starve the others.
  ack() {
    let i = this.lastInt;
    for (let n = 0; n < 4; n++) {
      const bit = 1 << i;
      if (this.intPendingMask & bit) {
        const c = this.ch[i];
        const v = (c.csr & CSR_ERR) ? c.eiv : c.niv;
        this.intPendingMask &= ~bit;
        this.lastInt = i;
        return v & 0xff;
      }
      i = (i + 1) & 3;
    }
    return -1;
  }

  _int(n) {
    if (this.ch[n].ccr & CCR_INT) {
      this.intPendingMask |= (1 << n);
      if (this.onInterrupt) this.onInterrupt();
    }
  }

  _error(n, code) {
    const c = this.ch[n];
    c.cer = code;
    c.csr |= CSR_ERR;
    c.csr &= ~CSR_ACT;
    c.ccr &= ~CCR_STR;
    this._int(n);
  }

  // ---- registers -------------------------------------------------------------
  read(a) {
    const n = (a >> 6) & 3;
    const off = a & 0x3f;
    const c = this.ch[n];
    switch (off) {
      case 0x00: return c.csr;
      case 0x01: return c.cer;
      case 0x04: return c.dcr;
      case 0x05: return c.ocr;
      case 0x06: return c.scr;
      case 0x07: return c.ccr;
      case 0x0a: return (c.mtc >> 8) & 0xff;
      case 0x0b: return c.mtc & 0xff;
      case 0x0c: return (c.mar >>> 24) & 0xff;
      case 0x0d: return (c.mar >>> 16) & 0xff;
      case 0x0e: return (c.mar >>> 8) & 0xff;
      case 0x0f: return c.mar & 0xff;
      case 0x14: return (c.dar >>> 24) & 0xff;
      case 0x15: return (c.dar >>> 16) & 0xff;
      case 0x16: return (c.dar >>> 8) & 0xff;
      case 0x17: return c.dar & 0xff;
      case 0x1a: return (c.btc >> 8) & 0xff;
      case 0x1b: return c.btc & 0xff;
      case 0x1c: return (c.bar >>> 24) & 0xff;
      case 0x1d: return (c.bar >>> 16) & 0xff;
      case 0x1e: return (c.bar >>> 8) & 0xff;
      case 0x1f: return c.bar & 0xff;
      case 0x25: return c.niv;
      case 0x27: return c.eiv;
      case 0x29: return c.mfc;
      case 0x2d: return c.cpr;
      case 0x31: return c.dfc;
      case 0x39: return c.bfc;
      case 0x3f: return this.gcr;
      default: return 0x00;
    }
  }

  write(a, v) {
    const n = (a >> 6) & 3;
    const off = a & 0x3f;
    const c = this.ch[n];
    v &= 0xff;
    switch (off) {
      // Status bits are write-ONE-to-clear, but ACT and PCS are the live state
      // of the channel and the pin: a handler writing $FF must not be able to
      // stop a running transfer by accident.
      case 0x00: c.csr &= (~v | 0x09); return;
      case 0x01: c.cer &= ~v; return;
      case 0x04: c.dcr = v; return;
      case 0x05: c.ocr = v; return;
      case 0x06: c.scr = v; return;
      case 0x07: this._writeCcr(n, v); return;
      case 0x0a: c.mtc = ((v << 8) | (c.mtc & 0xff)) & 0xffff; return;
      case 0x0b: c.mtc = ((c.mtc & 0xff00) | v) & 0xffff; return;
      case 0x0c: c.mar = ((v << 24) | (c.mar & 0x00ffffff)) >>> 0; return;
      case 0x0d: c.mar = ((c.mar & 0xff00ffff) | (v << 16)) >>> 0; return;
      case 0x0e: c.mar = ((c.mar & 0xffff00ff) | (v << 8)) >>> 0; return;
      case 0x0f: c.mar = ((c.mar & 0xffffff00) | v) >>> 0; return;
      case 0x14: c.dar = ((v << 24) | (c.dar & 0x00ffffff)) >>> 0; return;
      case 0x15: c.dar = ((c.dar & 0xff00ffff) | (v << 16)) >>> 0; return;
      case 0x16: c.dar = ((c.dar & 0xffff00ff) | (v << 8)) >>> 0; return;
      case 0x17: c.dar = ((c.dar & 0xffffff00) | v) >>> 0; return;
      case 0x1a: c.btc = ((v << 8) | (c.btc & 0xff)) & 0xffff; return;
      case 0x1b: c.btc = ((c.btc & 0xff00) | v) & 0xffff; return;
      case 0x1c: c.bar = ((v << 24) | (c.bar & 0x00ffffff)) >>> 0; return;
      case 0x1d: c.bar = ((c.bar & 0xff00ffff) | (v << 16)) >>> 0; return;
      case 0x1e: c.bar = ((c.bar & 0xffff00ff) | (v << 8)) >>> 0; return;
      case 0x1f: c.bar = ((c.bar & 0xffffff00) | v) >>> 0; return;
      case 0x25: c.niv = v; return;
      case 0x27: c.eiv = v; return;
      case 0x29: c.mfc = v; return;
      case 0x2d: c.cpr = v; return;
      case 0x31: c.dfc = v; return;
      case 0x39: c.bfc = v; return;
      case 0x3f: this.gcr = v; return;
      default: return;
    }
  }

  _writeCcr(n, v) {
    const c = this.ch[n];
    const old = c.ccr;
    // STR is a command, not a bit the program can take back: writing zero to
    // it while a channel runs does not stop the channel. SAB is how you stop.
    c.ccr = (v & 0xef) | (old & CCR_STR);

    if ((v & CCR_SAB) && (c.ccr & CCR_STR)) { this._error(n, ERR_ABORT); return; }
    if (v & CCR_HLT) return;

    if (v & CCR_STR) {
      if (old & CCR_HLT) {         // resuming from halt
        c.csr |= CSR_ACT;
        this.run(n, Infinity);
        return;
      }
      if (c.csr & 0xf8) { this._error(n, ERR_TIMING); return; }
      c.csr |= CSR_ACT;
      if (c.ocr & 0x08) {          // array / linked-array chaining
        c.mar = this.bus.read32(c.bar) & 0xffffff;
        c.mtc = this.bus.read16(c.bar + 4);
        if (c.ocr & 0x04) c.bar = this.bus.read32(c.bar + 6) >>> 0;
        else {
          c.bar = (c.bar + 6) >>> 0;
          if (!c.btc) { this._error(n, 0x0f); return; }
        }
      }
      if (!c.mtc) { this._error(n, ERR_COUNT); return; }
      c.cer = 0;
      // Some drivers read the counter immediately after starting to see
      // whether anything moved, so give the channel a moment right here.
      this.run(n, Infinity);
    }

    if ((v & CCR_CNT) && !c.mtc) {
      if (!(c.ccr & CCR_STR)) { this._error(n, ERR_TIMING); return; }
      if (c.ccr & CCR_CNT && c.ocr & 0x08) { this._error(n, ERR_CONFIG); return; }
      c.mar = c.bar; c.mtc = c.btc;
      c.csr |= CSR_ACT;
      c.bar = 0; c.btc = 0;
      if (!c.mar) { c.csr |= CSR_BTC; this._int(n); return; }
      if (!c.mtc) { this._error(n, ERR_COUNT); return; }
      c.ccr &= ~CCR_CNT;
      this.run(n, Infinity);
    }
  }

  // ---- transfer --------------------------------------------------------------
  // `budget` caps how many operands may move in this call. Burst channels
  // ignore it (the CPU has no bus while they run, which is the point); an
  // external-request channel uses it to run at the device's real rate.
  run(n, budget = 1) {
    const c = this.ch[n];
    const burst = (c.ocr & 3) === 1;
    const external = (c.ocr & 3) === 2;
    let moved = 0;
    while ((c.csr & CSR_ACT) && !(c.ccr & CCR_HLT) && !(c.csr & CSR_COC) && c.mtc) {
      if (external && !this.deviceReady(n)) break;
      if (!burst && moved >= budget) break;
      if (!this._operand(n)) return moved;   // bus/address fault: channel is dead
      moved++;
      c.mtc = (c.mtc - 1) & 0xffff;
      if (!c.mtc) { if (!this._blockDone(n)) return moved; }
      if (!burst && !external) break;        // limited-rate auto: one per call
    }
    return moved;
  }

  // One operand. `size` is the OCR size field; with an 8-bit device the DMAC
  // splits the operand into that many byte cycles on the device side.
  _operand(n) {
    const c = this.ch[n];
    const devIs16 = (c.dcr & 0x08) !== 0;
    const toMemory = (c.ocr & 0x80) !== 0;
    const size = (c.ocr >> 4) & 3;
    const marStep = (c.scr & 4) ? 1 : (c.scr & 8) ? -1 : 0;
    const darStep = (c.scr & 1) ? 1 : (c.scr & 2) ? -1 : 0;

    if (!devIs16) {
      // The device is eight bits wide, so however big the operand is it moves
      // one byte at a time and the device address walks in twos (the register
      // sits on one half of the bus).
      const bytes = size === 1 ? 2 : size === 2 ? 4 : 1;
      for (let i = 0; i < bytes; i++) {
        if (toMemory) this.bus.write8(c.mar, this.bus.read8(c.dar));
        else this.bus.write8(c.dar, this.bus.read8(c.mar));
        c.mar = (c.mar + marStep) & 0xffffff;
        c.dar = (c.dar + darStep * 2) & 0xffffff;
      }
      return true;
    }

    if (size === 0) {
      if (toMemory) this.bus.write8(c.mar, this.bus.read8(c.dar));
      else this.bus.write8(c.dar, this.bus.read8(c.mar));
      c.mar = (c.mar + marStep) & 0xffffff;
      c.dar = (c.dar + darStep) & 0xffffff;
    } else if (size === 2) {
      if ((c.mar | c.dar) & 1) { this._error(n, toMemory ? ERR_ADDR_DEV : ERR_ADDR_MEM); return false; }
      if (toMemory) this.bus.write32(c.mar, this.bus.read32(c.dar));
      else this.bus.write32(c.dar, this.bus.read32(c.mar));
      c.mar = (c.mar + marStep * 4) & 0xffffff;
      c.dar = (c.dar + darStep * 4) & 0xffffff;
    } else {
      if ((c.mar | c.dar) & 1) { this._error(n, toMemory ? ERR_ADDR_DEV : ERR_ADDR_MEM); return false; }
      if (toMemory) this.bus.write16(c.mar, this.bus.read16(c.dar));
      else this.bus.write16(c.dar, this.bus.read16(c.mar));
      c.mar = (c.mar + marStep * 2) & 0xffffff;
      c.dar = (c.dar + darStep * 2) & 0xffffff;
    }
    return true;
  }

  // MTC hit zero. Either another block follows (chain modes, or a continue
  // that the program armed while this one ran) or the channel is finished.
  _blockDone(n) {
    const c = this.ch[n];
    if (c.ocr & 0x08) {
      if (c.ocr & 0x04) {              // linked array: follow the pointer
        if (c.bar) {
          c.mar = this.bus.read32(c.bar) & 0xffffff;
          c.mtc = this.bus.read16(c.bar + 4);
          c.bar = this.bus.read32(c.bar + 6) >>> 0;
          if (!c.mtc) { this._error(n, ERR_COUNT); return false; }
        }
      } else {                          // array: walk the table
        c.btc = (c.btc - 1) & 0xffff;
        if (c.btc) {
          c.mar = this.bus.read32(c.bar) & 0xffffff;
          c.mtc = this.bus.read16(c.bar + 4);
          c.bar = (c.bar + 6) >>> 0;
          if (!c.mtc) { this._error(n, ERR_COUNT); return false; }
        }
      }
    } else if (c.ccr & CCR_CNT) {
      // Continuous operation: the program has already loaded the next block
      // into BAR/BTC, so the channel restarts without a gap. This is how the
      // ADPCM driver plays a stream longer than 64 KB without a click.
      c.csr |= CSR_BTC;
      this._int(n);
      if (c.bar) {
        c.mar = c.bar; c.mtc = c.btc;
        c.csr |= CSR_ACT;
        c.bar = 0; c.btc = 0;
        if (!c.mtc) { this._error(n, ERR_COUNT); return false; }
        c.ccr &= ~CCR_CNT;
      }
    }
    if (!c.mtc) {
      c.csr |= CSR_COC;
      c.csr &= ~CSR_ACT;
      this._int(n);
      return false;
    }
    return true;
  }

  // ---- state ------------------------------------------------------------------
  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      gcr: this.gcr, intPendingMask: this.intPendingMask, lastInt: this.lastInt,
      ch: this.ch.map((c) => ({
        csr: c.csr, cer: c.cer, dcr: c.dcr, ocr: c.ocr, scr: c.scr, ccr: c.ccr,
        mtc: c.mtc, mar: c.mar, dar: c.dar, btc: c.btc, bar: c.bar,
        niv: c.niv, eiv: c.eiv, mfc: c.mfc, cpr: c.cpr, dfc: c.dfc, bfc: c.bfc,
      })),
    };
  }

  setState(s) {
    this.gcr = s.gcr; this.intPendingMask = s.intPendingMask; this.lastInt = s.lastInt;
    for (let i = 0; i < 4; i++) Object.assign(this.ch[i], s.ch[i]);
    return this;
  }
}

export default Hd63450;
