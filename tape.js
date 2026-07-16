// Cassette (CMT) tape images — pure JS, dependency-free, deterministic.
// Parses the T88 container ("PC-8801 Tape Image(T88)") into an ordered list of
// segments and models playback the way the μPD8251 USART sees it: a MARK
// segment raises the carrier line (port 40h bit2) with no data; a DATA segment
// streams bytes into the USART receive register (port 20h) at the block's baud.
// The model is demand-driven — the USART pulls the next byte when the CPU reads
// it — which sidesteps exact tape timing while still loading correctly.
//
// T88 layout (little-endian): 24-byte magic, then tags {id:u16, len:u16, data}:
//   1     VERSION  data = u16 (0x100)
//   0x100 BLANK    BlankTag { pos:u32, tick:u32 }
//   0x101 DATA     DataTag  { pos:u32, tick:u32, len:u16, type:u16, bytes[len] }
//   0x102 SPACE    BlankTag
//   0x103 MARK     BlankTag   (carrier tone)
//   0     END
// DataTag.type bit8 (0x100) = 1200 baud, else 600.

const T88_MAGIC = 'PC-8801 Tape Image(T88)';
const u16 = (b, o) => b[o] | (b[o + 1] << 8);

export function parseT88(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const magic = String.fromCharCode(...b.subarray(0, T88_MAGIC.length));
  if (magic !== T88_MAGIC) throw new Error('not a T88 tape image');
  const segments = [];
  let o = 24; // past the 24-byte magic (incl. NUL padding)
  while (o + 4 <= b.length) {
    const id = u16(b, o), len = u16(b, o + 2);
    const data = b.subarray(o + 4, o + 4 + len);
    o += 4 + len;
    if (id === 0) { segments.push({ kind: 'end' }); break; }          // END
    else if (id === 1) { /* VERSION — ignore */ }
    else if (id === 0x103) segments.push({ kind: 'mark' });           // MARK (carrier)
    else if (id === 0x102 || id === 0x100) segments.push({ kind: 'space' }); // SPACE/BLANK (gap)
    else if (id === 0x101) {                                          // DATA
      const type = u16(data, 8), n = u16(data, 4);
      segments.push({ kind: 'data', bytes: data.subarray(12, 12 + n), baud: (type & 0x100) ? 1200 : 600 });
    }
  }
  return segments;
}

// A raw .cas / .cmt file is (approximately) a flat byte stream with no framing;
// present it as one long DATA block behind a MARK so a plain CLOAD still finds
// carrier then bytes. (Header-framed CAS variants can be added later.)
export function parseCas(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [{ kind: 'mark' }, { kind: 'data', bytes: b, baud: 600 }, { kind: 'end' }];
}

export function loadTape(name, bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const isT88 = String.fromCharCode(...b.subarray(0, T88_MAGIC.length)) === T88_MAGIC;
  return new Tape(isT88 ? parseT88(b) : parseCas(b));
}

export class Tape {
  constructor(segments) { this.segs = segments || []; this.reset(); }
  reset() { this.i = 0; this.j = 0; this.motor = false; this._carrierSeen = false; }
  setMotor(on) { this.motor = !!on; }

  // Carrier-detect line (port 40h bit2): high while parked on a MARK segment.
  carrier() {
    const c = this.motor && this.segs[this.i] && this.segs[this.i].kind === 'mark';
    if (c) this._carrierSeen = true;
    return !!c;
  }

  // walk past a MARK the CPU has already detected, and any SPACE, onto DATA
  _advanceToData() {
    while (this.segs[this.i]) {
      const s = this.segs[this.i];
      if (s.kind === 'data') {
        if (this.j < s.bytes.length) return s;              // bytes still to read
        this.i++; this.j = 0; this._carrierSeen = false; continue; // exhausted → next segment
      }
      if (s.kind === 'end') return null;
      if (s.kind === 'mark' && !this._carrierSeen) return null; // wait for the CPU to detect carrier
      this.i++; this.j = 0; this._carrierSeen = false;      // skip a seen MARK or a SPACE
    }
    return null;
  }

  // 8251 RxRDY: a received byte is waiting.
  rxReady() {
    if (!this.motor) return false;
    const s = this._advanceToData();
    return !!(s && s.kind === 'data' && this.j < s.bytes.length);
  }

  // 8251 data read (port 20h): next tape byte, or 0xFF at end.
  read() {
    if (!this.rxReady()) return 0xff;
    const s = this.segs[this.i];
    const byte = s.bytes[this.j++];
    if (this.j >= s.bytes.length) { this.i++; this.j = 0; this._carrierSeen = false; }
    return byte;
  }

  atEnd() { return !this.segs[this.i] || this.segs[this.i].kind === 'end'; }
}
