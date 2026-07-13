// upd8257 — minimal NEC μPD8257 (Intel 8257 clone) DMA controller model,
// covering what the PC-8001 text pipeline uses.
//
// 4 channels, each with a 16-bit address register and a 14-bit terminal
// count register whose top 2 bits select the transfer mode (01 write,
// 10 read i.e. memory → device). Register writes are byte-pairs gated by a
// shared low/high flip-flop. Mode port bit layout: bits 0-3 enable channels,
// bit 6 TC-stop, bit 7 autoload (channel 2 reloads from channel 3 on TC;
// while autoload is on, programming channel 2 also loads channel 3).
//
// PC-8001 wiring: channel 2 feeds the μPD3301 CRTC. I/O ports 60h-67h are
// the address/count pairs, 68h mode set / status read. N-BASIC programs
// ch2 address = text VRAM (F3C8h) and count = 8000h + 2999 (read mode,
// 3000 bytes = 25 rows × 120 bytes).
//
// Pure, deterministic, no deps. Memory access goes through the readMemory
// callback so the model owns no RAM.

export const SCHEMA_VERSION = 1;

export const DMA_MODE = Object.freeze({ VERIFY: 0, WRITE: 1, READ: 2 });

export class Upd8257 {
  constructor({ readMemory = () => 0 } = {}) {
    this.readMemory = readMemory;
    this.channels = [];
    for (let i = 0; i < 4; i++) {
      this.channels.push({
        baseAddr: 0, baseCount: 0, mode: 0,
        addr: 0, count: 0, // live counters
        exCount: null, // EX mode: byte count beyond the 14-bit register
        tc: false,
      });
    }
    this.modeReg = 0;
    this._flipflop = 0;
  }

  get autoload() { return (this.modeReg & 0x80) !== 0; }
  enabled(ch) { return (this.modeReg & (1 << ch)) !== 0; }

  // ports 0-7: ch address / terminal count pairs, port 8: mode/status
  writePort(port, value) {
    value &= 0xff;
    if (port === 8) {
      this.modeReg = value;
      this._flipflop = 0;
      return;
    }
    const ch = (port >> 1) & 3;
    const isCount = (port & 1) === 1;
    const c = this.channels[ch];
    if (isCount) {
      if (this._flipflop === 0) c.baseCount = (c.baseCount & 0x3f00) | value | (c.baseCount & 0xc000);
      else c.baseCount = (c.baseCount & 0x00ff) | (value << 8);
      if (this._flipflop === 1) {
        c.mode = (c.baseCount >> 14) & 3;
        c.count = c.baseCount & 0x3fff;
        c.exCount = null; // port writes return the channel to real 14-bit mode
        c.tc = false;
      }
    } else {
      if (this._flipflop === 0) c.baseAddr = (c.baseAddr & 0xff00) | value;
      else c.baseAddr = (c.baseAddr & 0x00ff) | (value << 8);
      c.addr = c.baseAddr;
    }
    if (this._flipflop === 1 && this.autoload && ch === 2) {
      // autoload: programming ch2 loads ch3 with the same parameters
      const c3 = this.channels[3];
      if (isCount) { c3.baseCount = c.baseCount; }
      else { c3.baseAddr = c.baseAddr; }
    }
    this._flipflop ^= 1;
  }

  readPort(port) {
    if (port === 8) {
      let s = 0;
      for (let i = 0; i < 4; i++) if (this.channels[i].tc) s |= 1 << i;
      for (let i = 0; i < 4; i++) this.channels[i].tc = false;
      return s;
    }
    const ch = (port >> 1) & 3;
    const c = this.channels[ch];
    const v = (port & 1) === 1 ? c.count : c.addr;
    const byte = this._flipflop === 0 ? v & 0xff : (v >> 8) & 0xff;
    this._flipflop ^= 1;
    return byte;
  }

  // EX mode: fantasy silicon rev matching the μPD3301's resetEx — program a
  // channel with a byte count beyond the 14-bit register, bypassing the port
  // encoding. Used for extended terminal screens whose frame exceeds 16K.
  setChannelEx(ch, { addr, count, autoload = true }) {
    const c = this.channels[ch];
    // extended address mask: smallest power of two covering the transfer
    let mask = 0xffff;
    while (mask < addr + count - 1) mask = (mask << 1) | 1;
    c.exMask = mask;
    c.baseAddr = addr & mask;
    c.addr = c.baseAddr;
    c.mode = DMA_MODE.READ;
    c.exCount = count;
    c.count = count - 1;
    c.tc = false;
    this.modeReg |= 1 << ch;
    if (autoload && ch === 2) {
      this.modeReg |= 0x80;
      const c3 = this.channels[3];
      c3.baseAddr = c.baseAddr;
      c3.exCount = count;
    }
    return this;
  }

  // Device-side burst pull (what a μPD3301 DRQ does): fill buf from the
  // channel's current address, decrementing the count. Returns bytes served.
  drqPull(ch, buf) {
    const c = this.channels[ch];
    if (!this.enabled(ch)) return 0;
    let served = 0;
    const mask = c.exCount != null ? c.exMask : 0xffff;
    for (let i = 0; i < buf.length; i++) {
      buf[i] = this.readMemory(c.addr & mask) & 0xff;
      c.addr = (c.addr + 1) & mask;
      served++;
      if (c.count === 0) {
        // terminal count reached on this byte
        c.tc = true;
        if (ch === 2 && this.autoload) {
          const c3 = this.channels[3];
          c.addr = c3.baseAddr;
          c.count = c3.exCount != null ? c3.exCount - 1 : c3.baseCount & 0x3fff;
        } else if (this.modeReg & 0x40) {
          this.modeReg &= ~(1 << ch); // TC stop: disable channel
          break;
        } else {
          c.count = c.exCount != null ? c.exCount - 1 : c.baseCount & 0x3fff;
          c.addr = c.baseAddr;
        }
      } else {
        c.count--;
      }
    }
    return served;
  }
}

export function createUpd8257(opts) {
  return new Upd8257(opts);
}
