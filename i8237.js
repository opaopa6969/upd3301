// i8237 — Intel 8237A DMA controller.
//
// Four channels, each a 16-bit address and a 16-bit count plus an external
// page register that supplies the address bits the chip itself does not have.
// On a PC-9801 the page registers live at $21/$23/$25/$27 and carry A16-A23,
// which is how a 16-bit DMA controller reaches a megabyte.
//
// The floppy controller is the customer that matters: it raises DREQ once per
// byte and the transfer runs until the count underflows, at which point the
// chip asserts TC and the FDC ends the sector there rather than at the sector
// boundary. That wire — count exhausted means "stop now" — is why the count
// register is not just bookkeeping.
//
// Autoinitialise, address decrement and the mask/request registers are all
// modelled. Memory-to-memory transfers (channel 0 to 1) are not; nothing on a
// 9801 uses them.
//
// The machine injects the bus and the devices:
//   { read8(phys), write8(phys, v) }              memory
//   deviceRead(ch) -> byte | -1                    a device with data for us
//   deviceWrite(ch, byte) -> boolean               a device that wants a byte
//
// Pure, deterministic, zero deps.

export const SCHEMA_VERSION = 1;

const MODE_VERIFY = 0, MODE_WRITE = 1, MODE_READ = 2;

export class I8237 {
  constructor({ bus = null, deviceRead = null, deviceWrite = null, onTc = null } = {}) {
    this.bus = bus || { read8: () => 0xff, write8: () => {} };
    this.deviceRead = deviceRead;
    this.deviceWrite = deviceWrite;
    this.onTc = onTc;
    this.ch = [];
    for (let i = 0; i < 4; i++) {
      this.ch.push({ addr: 0, count: 0, baseAddr: 0, baseCount: 0, mode: 0, page: 0 });
    }
    this.reset();
  }

  reset() {
    for (const c of this.ch) {
      c.addr = 0; c.count = 0; c.baseAddr = 0; c.baseCount = 0; c.mode = 0; c.page = 0;
    }
    this.mask = 0x0f;           // every channel masked off after a reset
    this.request = 0;
    this.status = 0;            // low nibble TC, high nibble request
    this.command = 0;
    this.flipFlop = false;      // the low/high byte selector, shared by all four
    return this;
  }

  // ---- ports ------------------------------------------------------------------
  // The PC-9801 puts the channel registers on the ODD addresses $01-$0F and the
  // control registers on $11-$1F, interleaved with the interrupt controller on
  // the even ones. `offset` here is the register index 0-15.
  write(offset, v) {
    v &= 0xff;
    const o = offset & 0x0f;
    if (o < 8) {
      const c = this.ch[o >> 1];
      const high = this.flipFlop;
      this.flipFlop = !this.flipFlop;
      if ((o & 1) === 0) {
        if (high) { c.addr = (c.addr & 0x00ff) | (v << 8); c.baseAddr = c.addr; }
        else { c.addr = (c.addr & 0xff00) | v; c.baseAddr = c.addr; }
      } else if (high) { c.count = (c.count & 0x00ff) | (v << 8); c.baseCount = c.count; }
      else { c.count = (c.count & 0xff00) | v; c.baseCount = c.count; }
      return;
    }
    switch (o) {
      case 0x08: this.command = v; return;
      case 0x09:                                   // request register
        if (v & 4) this.request |= 1 << (v & 3); else this.request &= ~(1 << (v & 3));
        return;
      case 0x0a:                                   // single mask
        if (v & 4) this.mask |= 1 << (v & 3); else this.mask &= ~(1 << (v & 3));
        return;
      case 0x0b: this.ch[v & 3].mode = v; return;  // mode register
      case 0x0c: this.flipFlop = false; return;    // clear byte pointer
      case 0x0d: this.reset(); return;             // master clear
      case 0x0e: this.mask = 0; return;            // clear mask register
      case 0x0f: this.mask = v & 0x0f; return;     // write all mask bits
      default: return;
    }
  }

  read(offset) {
    const o = offset & 0x0f;
    if (o < 8) {
      const c = this.ch[o >> 1];
      const high = this.flipFlop;
      this.flipFlop = !this.flipFlop;
      const v = (o & 1) === 0 ? c.addr : c.count;
      return (high ? (v >> 8) : v) & 0xff;
    }
    if (o === 0x08) {                              // status: reading clears TC
      const s = this.status;
      this.status &= 0xf0;
      return s & 0xff;
    }
    if (o === 0x0f) return this.mask & 0x0f;
    return 0xff;
  }

  // The page registers are not part of the 8237 — they are a latch on the
  // board that supplies A16 and up. $21/$23/$25/$27, one per channel.
  writePage(chan, v) { this.ch[chan & 3].page = v & 0xff; }
  readPage(chan) { return this.ch[chan & 3].page; }

  // ---- transfer ------------------------------------------------------------------
  // Move up to `max` bytes on one channel. Returns how many actually moved,
  // which is however many the device had (or wanted). The caller decides the
  // rate — for a floppy that is one byte per 27 microseconds of media time, not
  // as fast as the bus will go.
  run(chan, max) {
    const c = this.ch[chan & 3];
    if (this.mask & (1 << (chan & 3))) return 0;
    if (this.command & 0x04) return 0;             // controller disabled
    const dir = (c.mode >> 2) & 3;
    const decrement = (c.mode & 0x20) !== 0;
    const autoInit = (c.mode & 0x10) !== 0;
    let moved = 0;

    for (let i = 0; i < max; i++) {
      const phys = ((c.page << 16) | c.addr) & 0xfffff;
      if (dir === MODE_WRITE) {                    // device -> memory
        const b = this.deviceRead ? this.deviceRead(chan) : -1;
        if (b < 0) break;
        this.bus.write8(phys, b & 0xff);
      } else if (dir === MODE_READ) {              // memory -> device
        const b = this.bus.read8(phys);
        if (!this.deviceWrite || !this.deviceWrite(chan, b)) break;
      } else {
        // Verify: the chip still walks the address and counts down, it just
        // does not drive the data bus. The BIOS uses it to time a seek.
        if (this.deviceRead && this.deviceRead(chan) < 0) break;
      }
      c.addr = (c.addr + (decrement ? -1 : 1)) & 0xffff;
      moved++;
      if (c.count === 0) {
        // Underflow: this was the last byte. TC goes out to the device.
        this.status |= 1 << (chan & 3);
        if (this.onTc) this.onTc(chan);
        if (autoInit) { c.addr = c.baseAddr; c.count = c.baseCount; }
        else this.mask |= 1 << (chan & 3);
        break;
      }
      c.count = (c.count - 1) & 0xffff;
    }
    return moved;
  }

  channelActive(chan) { return !(this.mask & (1 << (chan & 3))); }

  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      ch: this.ch.map((c) => ({ ...c })),
      mask: this.mask, request: this.request, status: this.status,
      command: this.command, flipFlop: this.flipFlop,
    };
  }

  setState(s) {
    for (let i = 0; i < 4; i++) Object.assign(this.ch[i], s.ch[i]);
    this.mask = s.mask; this.request = s.request; this.status = s.status;
    this.command = s.command; this.flipFlop = s.flipFlop;
    return this;
  }
}

export default I8237;
