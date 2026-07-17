// Cassette (CMT) tape images — pure JS, dependency-free, deterministic.
//
// Byte-level model matching M88's TapeManager + SIO (uPD8251): the tape delivers
// *bytes* into the USART receive register at the block's baud rate; the CPU polls
// RXRDY (port 21h bit1) and reads each byte (port 20h). Port 40h bit2 is the
// carrier-detect line, high while the tape is parked on a MARK. This is how
// N-BASIC's CLOAD actually loads — it configures the 8251 (OUT 21h), waits for
// carrier (IN 40h b2), then reads bytes (IN 21h → RXRDY, IN 20h → data). It is
// NOT an FSK waveform decoded on 40h (an earlier guess; the ROM disassembly and
// M88's sio.cpp/tapemgr.cpp both show the 8251 byte path).
//
// T88 layout (little-endian): 24-byte magic, then tags {id:u16, len:u16, data}:
//   1     VERSION  data = u16 (0x100)
//   0x100 BLANK    BlankTag { pos:u32, tick:u32 }         (silence)
//   0x101 DATA     DataTag  { pos:u32, tick:u32, len:u16, type:u16, bytes[len] }
//   0x102 SPACE    BlankTag                                (silence)
//   0x103 MARK     BlankTag                                (carrier tone)
//   0     END
// DataTag.type bit8 (0x100) = 1200 baud, else 600. A tag's duration is
// (pos + tick) − running-position, in "tick units". One tick unit = clockHz/4800
// CPU T-states: a 1200-baud byte spans 44 units, a 600-baud byte 88 (matching
// M88's SetTimer(44|88), whose "100000/4800" comment names the same 4800).

const T88_MAGIC = 'PC-8801 Tape Image(T88)';
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function parseT88(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (String.fromCharCode(...b.subarray(0, T88_MAGIC.length)) !== T88_MAGIC) throw new Error('not a T88 tape image');
  const segs = [];
  let o = 24, run = 0;
  while (o + 4 <= b.length) {
    const id = u16(b, o), len = u16(b, o + 2), d = o + 4;
    o += 4 + len;
    if (id === 0) { segs.push({ kind: 'end' }); break; }
    else if (id === 1) { /* VERSION — ignore */ }
    else if (id === 0x103) { const pos = u32(b, d), tick = u32(b, d + 4); segs.push({ kind: 'mark', dur: Math.max(1, pos + tick - run) }); run = pos + tick; }
    else if (id === 0x100 || id === 0x102) { const pos = u32(b, d), tick = u32(b, d + 4); segs.push({ kind: 'gap', dur: Math.max(1, pos + tick - run) }); run = pos + tick; }
    else if (id === 0x101) {
      const pos = u32(b, d), tick = u32(b, d + 4), n = u16(b, d + 8), type = u16(b, d + 10);
      segs.push({ kind: 'data', bytes: b.subarray(d + 12, d + 12 + n), baud: (type & 0x100) ? 1200 : 600 });
      run = pos + tick;
    }
  }
  return segs;
}

// A raw .cas / .cmt file is a flat byte stream: present it as one DATA block
// behind a MARK so a plain CLOAD finds carrier then bytes.
export function parseCas(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [{ kind: 'mark', dur: 2000 }, { kind: 'data', bytes: b, baud: 600 }, { kind: 'end' }];
}

export function loadTape(name, bytes, clockHz = 3993600) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const isT88 = String.fromCharCode(...b.subarray(0, T88_MAGIC.length)) === T88_MAGIC;
  return new Tape(isT88 ? parseT88(b) : parseCas(b), clockHz);
}

// 8251 status bits
const TXRDY = 0x01, RXRDY = 0x02, TXE = 0x04, OE = 0x10, FE = 0x20;
// Cap MARK/GAP durations so multi-second tape leaders don't make CLOAD crawl.
// Real pre-data marks are ≥1000 units (~0.2 s) — plenty for the CPU to detect
// and confirm carrier — so capping the long leaders/gaps keeps sync but loads
// fast. Data bytes are unaffected (delivered at baud, accelerated on read).
const DUR_CAP = 2400;

export class Tape {
  constructor(segments, clockHz = 3993600) {
    this.segs = segments || [];
    this.clockHz = clockHz;
    this.tPerUnit = clockHz / 4800; // T-states per T88 tick unit
    this.reset();
  }

  reset() {
    this.motor = false;
    this.rxen = false;
    this.sioClear = true;                 // 8251 awaiting a mode instruction
    this.status = TXRDY | TXE;            // no byte yet
    this.data = 0xff;
    this._playT = 0; this._lastNow = null;
    this.segIdx = 0; this.byteIdx = 0; this.segStart = 0; this.nextByteT = 0;
    this._enterSeg(0);
  }

  setMotor(on) { on = !!on; if (!on) this._lastNow = null; this.motor = on; }

  _segDur(s) { return Math.min(s.dur || 1, DUR_CAP) * this.tPerUnit; }

  _enterSeg(i) {
    this.segIdx = i; this.segStart = this._playT; this.byteIdx = 0;
    const s = this.segs[i];
    if (s && s.kind === 'data') this.nextByteT = this._playT + (s.baud === 1200 ? 44 : 88) * this.tPerUnit;
  }
  _advance() { if (this.segIdx < this.segs.length) this._enterSeg(this.segIdx + 1); }

  // Advance the play clock (only while the motor runs) and run the byte-delivery
  // state machine. `now` is a monotonic machine T-state count.
  pump(now) {
    if (this.motor) { if (this._lastNow != null && now > this._lastNow) this._playT += now - this._lastNow; this._lastNow = now; }
    else { this._lastNow = null; return; }
    let guard = 0;
    while (guard++ < 100000) {
      const s = this.segs[this.segIdx];
      if (!s || s.kind === 'end') return;
      if (s.kind === 'mark' || s.kind === 'gap') {
        if (this._playT >= this.segStart + this._segDur(s)) { this._advance(); continue; }
        return;
      }
      // data segment
      if (this.byteIdx >= s.bytes.length) { this._advance(); continue; }
      if (this.rxen && !(this.status & RXRDY) && this._playT >= this.nextByteT) {
        this.data = s.bytes[this.byteIdx];
        this.status |= RXRDY;                                        // deliver one byte
        this.nextByteT = this._playT + (s.baud === 1200 ? 44 : 88) * this.tPerUnit; // next at baud
      }
      return;
    }
  }

  // IN 21h — 8251 status.
  status8251() { return this.status; }

  // IN 20h — 8251 receive data. Clears RXRDY and requests the next byte "soon"
  // (M88's SetEvent(event,1) after a read), so a keeping-up CPU streams a block
  // at read speed rather than crawling at the baud rate.
  readData() {
    const f = this.status & RXRDY;
    this.status &= ~RXRDY;
    if (f) { this.byteIdx++; this.nextByteT = this._playT + this.tPerUnit; }
    return this.data;
  }

  // OUT 21h — 8251 mode/command word. Subset: mode instruction leaves clear mode;
  // command bits set receive-enable / error-reset / internal-reset.
  writeControl(d) {
    if (this.sioClear) { this.sioClear = false; return; } // mode instruction consumed
    if (d & 0x40) { this.sioClear = true; this.status = TXRDY | TXE; this.rxen = false; return; } // internal reset
    if (d & 0x10) this.status &= ~(OE | FE);              // error reset
    this.rxen = (d & 4) !== 0;                            // receive enable
  }

  // IN 40h bit2 — carrier detect (high over a MARK while the motor runs).
  carrier() { const s = this.segs[this.segIdx]; return !!(this.motor && s && s.kind === 'mark'); }
  atEnd() { const s = this.segs[this.segIdx]; return !s || s.kind === 'end'; }
}
