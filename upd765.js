// μPD765 — NEC's floppy disk controller. THE floppy chip: NEC designed it,
// Intel licensed it as the 8272, IBM put it in the PC. On the PC-8801 it
// lives on the disk sub-board, talked to by the sub-CPU through two ports:
// the main status register (MSR) and the data register.
//
// Everything is a little state machine of phases:
//
//   command phase    CPU writes the command byte + parameters
//   execution phase  data moves (in non-DMA mode: INT + RQM per byte,
//                    the sub-CPU does EI/HALT and gets woken per byte —
//                    that is literally what the 2KB sub ROM does)
//   result phase     CPU reads status bytes back
//
// The disk itself is a parsed D88 (see d88.js): sectors carry their own
// C/H/R/N ids, status and deleted-flags, so copy protections (bad CRCs,
// duplicate ids, odd sizes) flow through untouched — we return what the
// image says, the same way the real chip returned what the media said.
//
// Pure, deterministic, no deps. The board wires `intLine` to the sub-CPU.

import { findSector } from './d88.js';

export const SCHEMA_VERSION = 1;

// MSR bits
const RQM = 0x80, DIO = 0x40, EXM = 0x20, CB = 0x10;

// ST0 bits
const ST0_AT = 0x40; // abnormal termination
const ST0_IC = 0x80; // invalid command
const ST0_SE = 0x20; // seek end

const UNITS = 2; // the PC-8801 sub-board drives two units

export class Upd765 {
  constructor() {
    this.drives = [
      { disk: null, cyl: 0 }, { disk: null, cyl: 0 },
      { disk: null, cyl: 0 }, { disk: null, cyl: 0 },
    ];
    this.reset();
  }

  reset() {
    this.phase = 'idle'; // idle | command | execute | result
    this.cmd = [];
    this.cmdLen = 0;
    this.result = [];
    this.resultPos = 0;
    this.execBuf = null; // Uint8Array being transferred
    this.execPos = 0;
    this.execWrite = false;
    this.int = false; // INT pin
    this.seekEnd = []; // pending seek-end interrupts: [{us, st0}]
    this.us = 0; this.hd = 0;
    this._multi = null; // multi-sector read continuation
    return this;
  }

  insertDisk(unit, disk) { this.drives[unit & 3].disk = disk; return this; }
  ejectDisk(unit) { this.drives[unit & 3].disk = null; return this; }

  get intLine() { return this.int || this.seekEnd.length > 0; }

  // ---- MSR ------------------------------------------------------------------
  readStatus() {
    switch (this.phase) {
      case 'idle': return RQM;
      case 'command': return RQM | CB;
      case 'execute': return RQM | EXM | CB | (this.execWrite ? 0 : DIO);
      case 'result': return RQM | DIO | CB;
      default: return RQM;
    }
  }

  // ---- data register ----------------------------------------------------------
  write(v) {
    v &= 0xff;
    if (this.phase === 'idle') {
      this.cmd = [v];
      this.cmdLen = CMD_LEN[v & 0x1f] ?? 1;
      this.phase = this.cmd.length < this.cmdLen ? 'command' : 'command';
      if (this.cmd.length === this.cmdLen) this._start();
      return;
    }
    if (this.phase === 'command') {
      this.cmd.push(v);
      if (this.cmd.length === this.cmdLen) this._start();
      return;
    }
    if (this.phase === 'execute' && this.execWrite) {
      this.execBuf[this.execPos++] = v;
      this.int = false;
      if (this.execPos >= this.execBuf.length) this._execDone();
      else this.int = true; // non-DMA: next byte requested
      return;
    }
  }

  read() {
    if (this.phase === 'execute' && !this.execWrite) {
      const v = this.execBuf[this.execPos++];
      this.int = false;
      if (this.execPos >= this.execBuf.length) this._execDone();
      else this.int = true; // non-DMA: next byte ready
      return v;
    }
    if (this.phase === 'result') {
      this.int = false; // reading results drops INT
      const v = this.result[this.resultPos++] ?? 0xff;
      if (this.resultPos >= this.result.length) this.phase = 'idle';
      return v;
    }
    return 0xff;
  }

  // TC pin (on the PC-8801 sub-board, wired so that IN from port F8h pulses it)
  tc() {
    if (this.phase !== 'execute') return;
    this._endRw(0, 0, 0);
  }

  // ---- commands -----------------------------------------------------------
  _start() {
    const op = this.cmd[0] & 0x1f;
    if (globalThis.__fdcCmd) globalThis.__fdcCmd(op, [...this.cmd]);
    this.us = this.cmd.length > 1 ? this.cmd[1] & 3 : this.us;
    this.hd = this.cmd.length > 1 ? (this.cmd[1] >> 2) & 1 : this.hd;

    switch (op) {
      case 0x03: // SPECIFY — timings + ND bit; nothing observable for us
        this.phase = 'idle';
        return;

      case 0x04: { // SENSE DEVICE STATUS → ST3
        const d = this.drives[this.us];
        let st3 = this.us | (this.hd << 2) | 0x08 | 0x20; // two-side, ready
        if (d.cyl === 0) st3 |= 0x10; // track 0
        if (d.disk?.writeProtect) st3 |= 0x40;
        if (!d.disk) st3 &= ~0x20; // not ready
        this._results([st3]);
        return;
      }

      case 0x07: { // RECALIBRATE — head to track 0, then seek-end INT
        const d = this.drives[this.us];
        d.cyl = 0;
        // seeks succeed on any *existing* drive unit, disk or not — the head
        // moves regardless; only a nonexistent unit fails (AT|SE|NR)
        this.seekEnd.push({
          us: this.us,
          st0: this.us < UNITS ? ST0_SE | this.us : ST0_AT | ST0_SE | 0x08 | this.us,
        });
        this.phase = 'idle';
        return;
      }

      case 0x0f: { // SEEK
        const d = this.drives[this.us];
        d.cyl = this.cmd[2];
        this.seekEnd.push({
          us: this.us,
          st0: this.us < UNITS ? ST0_SE | this.us : ST0_AT | ST0_SE | 0x08 | this.us,
        });
        this.phase = 'idle';
        return;
      }

      case 0x08: { // SENSE INTERRUPT STATUS
        const p = this.seekEnd.shift();
        if (p) this._results([p.st0, this.drives[p.us].cyl]);
        else this._results([ST0_IC, 0]); // nothing pending → invalid
        return;
      }

      case 0x0a: { // READ ID — next sector id passing under the head
        const d = this.drives[this.us];
        const trk = d.disk?.tracks[d.cyl * 2 + this.hd];
        if (!trk || !trk.sectors.length) {
          this._results([ST0_AT | this.us | (this.hd << 2), 0x01, 0, d.cyl, this.hd, 1, 1]);
          return;
        }
        d._idx = ((d._idx ?? -1) + 1) % trk.sectors.length; // disk rotation
        const s = trk.sectors[d._idx];
        this._results([this.us | (this.hd << 2), 0, 0, s.c, s.h, s.r, s.n]);
        return;
      }

      case 0x06: case 0x0c: // READ DATA / READ DELETED DATA
        this._startRead(op === 0x0c);
        return;

      case 0x02: // READ DIAGNOSTIC (read track) — protections love this
        this._startReadTrack();
        return;

      case 0x05: case 0x09: // WRITE DATA / WRITE DELETED DATA
        this._startWrite(op === 0x09);
        return;

      case 0x0d: { // FORMAT A TRACK — accept & discard the id stream
        const bytes = this.cmd[3] * 4; // 4 id bytes per sector
        this.execBuf = new Uint8Array(Math.max(4, bytes));
        this.execPos = 0;
        this.execWrite = true;
        this._multi = { format: true };
        this.phase = 'execute';
        this.int = true;
        return;
      }

      default: // invalid
        this._results([ST0_IC]);
        return;
    }
  }

  _startRead(wantDeleted) {
    const [, , c, h, r, n] = this.cmd;
    const eot = this.cmd[6];
    const d = this.drives[this.us];
    const sk = (this.cmd[0] & 0x20) !== 0;
    if (!d.disk) return this._rwError(0x08, c, h, r, n);
    let sec = findSector(d.disk, d.cyl, this.hd, r, n);
    if (sec && sk && sec.deleted !== wantDeleted) {
      sec = findSector(d.disk, d.cyl, this.hd, r + 1, n); // skip to next
    }
    if (globalThis.__fdcLog) globalThis.__fdcLog('RD', { c, h, r, n, cyl: d.cyl, hd: this.hd, found: !!sec, size: sec ? 128 << sec.n : 0 });
    if (!sec) return this._rwError(0x04, c, h, r, n); // ST1 ND
    this._multi = { c, h, r, n, eot, deleted: wantDeleted, sec };
    this.execBuf = sec.data;
    this.execPos = 0;
    this.execWrite = false;
    this.phase = 'execute';
    this.int = true; // first byte ready
  }

  _startReadTrack() {
    const [, , c, h, r, n] = this.cmd;
    const d = this.drives[this.us];
    const trk = d.disk?.tracks[d.cyl * 2 + this.hd];
    if (!trk || !trk.sectors.length) return this._rwError(0x04, c, h, r, n);
    // stream every sector from the index hole, ignoring id match
    const total = trk.sectors.reduce((a, s) => a + s.size, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const s of trk.sectors) { buf.set(s.data, o); o += s.size; }
    this._multi = { c, h, r, n, eot: r, sec: trk.sectors[0] };
    this.execBuf = buf;
    this.execPos = 0;
    this.execWrite = false;
    this.phase = 'execute';
    this.int = true;
  }

  _startWrite(deleted) {
    const [, , c, h, r, n] = this.cmd;
    const d = this.drives[this.us];
    if (!d.disk) return this._rwError(0x08, c, h, r, n);
    if (d.disk.writeProtect) return this._rwError(0x02, c, h, r, n); // ST1 NW
    const sec = findSector(d.disk, d.cyl, this.hd, r, n);
    if (!sec) return this._rwError(0x04, c, h, r, n);
    sec.deleted = deleted;
    this._multi = { c, h, r, n, eot: this.cmd[6], sec };
    this.execBuf = sec.data;
    this.execPos = 0;
    this.execWrite = true;
    this.phase = 'execute';
    this.int = true;
  }

  _execDone() {
    const m = this._multi;
    // On the PC-8801 disk sub-board the sub-CPU reads exactly the bytes it wants
    // and then pulses TC (IN from port F8h → tc()), so a read normally ends via
    // TC, not by the FDC running off the track. We serve the current sector's
    // bytes; when the host keeps reading past a sector boundary we auto-advance
    // to R+1 (genuine multi-sector). If we can't advance we terminate NORMALLY —
    // TC would have arrived here on real hardware. (Do NOT synthesize an
    // End-of-Cylinder abnormal status: with TC-driven reads it never occurs, and
    // forcing it broke single-sector protection reads where R>EOT, e.g. the
    // C0/H82/R87 sector of 軽井沢誘拐案内.)
    if (m && !m.format && m.r < m.eot) {
      const d = this.drives[this.us];
      const next = findSector(d.disk, d.cyl, this.hd, m.r + 1, m.n);
      if (next && !this.execWrite) {
        m.r++;
        m.sec = next;
        this.execBuf = next.data;
        this.execPos = 0;
        this.int = true;
        return;
      }
    }
    this._endRw(0, 0, 0);
  }

  _endRw(st0extra, st1, st2) {
    const m = this._multi ?? { c: 0, h: this.hd, r: 1, n: 1, sec: null };
    const sec = m.sec;
    // a sector whose stored status is non-zero (protection!) reports it:
    // D88 status 0xB0 = data CRC error → ST1 DE, 0xF0 = no data → ST1 ND
    let xst1 = st1, xst2 = st2, st0 = this.us | (this.hd << 2) | st0extra;
    if (sec && sec.status) {
      st0 |= ST0_AT;
      if (sec.status === 0xa0 || sec.status === 0xb0) { xst1 |= 0x20; xst2 |= (sec.status === 0xb0 ? 0x20 : 0); }
      else if (sec.status === 0xf0) xst1 |= 0x04;
      else xst1 |= 0x20;
    }
    if (sec?.deleted && !m.deleted) xst2 |= 0x40; // ST2 CM: hit deleted data
    this._results([st0, xst1, xst2, sec?.c ?? m.c, sec?.h ?? m.h, sec?.r ?? m.r, sec?.n ?? m.n]);
  }

  _rwError(st1, c, h, r, n) {
    this._multi = null;
    this._results([ST0_AT | this.us | (this.hd << 2), st1, 0, c, h, r, n]);
  }

  _results(bytes) {
    this.result = bytes;
    this.resultPos = 0;
    this.phase = 'result';
    this.execBuf = null;
    this._multi = null;
    this.int = true; // INT until first result byte is read
  }

  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      phase: this.phase, us: this.us, hd: this.hd,
      cyls: this.drives.map((d) => d.cyl),
      int: this.intLine,
    };
  }
}

// parameter-byte counts per opcode (including the opcode byte)
const CMD_LEN = {
  0x02: 9, 0x03: 3, 0x04: 2, 0x05: 9, 0x06: 9, 0x07: 2,
  0x08: 1, 0x09: 9, 0x0a: 2, 0x0c: 9, 0x0d: 6, 0x0f: 3,
  0x11: 9, 0x19: 9, 0x1d: 9, // scans (unimplemented → invalid at _start)
};
