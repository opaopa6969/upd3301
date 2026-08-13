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

// MSR bits. M88 calls EXM "NDM" (non-DMA mode); it is the same bit 5, and both
// names mean "an execution phase is running".
const RQM = 0x80, DIO = 0x40, EXM = 0x20, CB = 0x10;

// ST0 bits
const ST0_AT = 0x40; // abnormal termination
const ST0_IC = 0x80; // invalid command
const ST0_SE = 0x20; // seek end

const UNITS = 2; // the PC-8801 sub-board drives two units

export class Upd765 {
  constructor() {
    // Opt-in mechanical timing — see tick(). Set by the board that owns the
    // clock, and deliberately NOT touched by reset(): they describe the wiring,
    // not the chip's state.
    this.seekTiming = false; // 400 x steps + 500 ticks per SEEK/RECALIBRATE
    this.readTiming = false; // 250 << min(7,n) ticks before each sector read
    this.drives = [
      { disk: null, cyl: 0 }, { disk: null, cyl: 0 },
      { disk: null, cyl: 0 }, { disk: null, cyl: 0 },
    ];
    this.reset();
  }

  reset() {
    this.phase = 'idle'; // idle | command | execute | result
    // THE MSR IS A STATE VARIABLE, NOT A FUNCTION OF `phase`.
    //
    // It used to be derived (`switch (phase) { case 'execute': return RQM|EXM|CB|DIO; ...}`)
    // and that cost three failed attempts at the FDC timers (issue #13): a
    // derived MSR can only ever say "ready", so there is no way to express
    // "the chip is busy for the next 5 ms, ignore me". M88 keeps `status` as a
    // plain variable that each phase shift assigns and each transferred byte
    // clears — `FDC::Status()` is literally `return seekstate | status;`.
    this.status = RQM;
    this.seekBusy = 0;  // MSR D0B..D3B — drives with a seek still in flight
    this.acceptTc = false; // M88's `accepttc`: TC only bites during a transfer
    this.data = 0xff; // the data-bus latch (M88 `data`)
    this.cmd = [];
    this.cmdLen = 0;
    this.result = [];
    this.resultPos = 0;
    this.execBuf = null; // Uint8Array being transferred
    this.execPos = 0;
    this.execWrite = false;
    this.int = false; // INT pin
    this.seekEnd = []; // pending seek-end interrupts: [{us, st0, at}]
    this.us = 0; this.hd = 0;
    this._multi = null; // multi-sector read continuation
    this.now = 0;          // mechanical clock, in 10 µs ticks (see tick())
    this._timerAt = -1;    // pending phase timer, -1 = none (M88 `timerhandle`)
    this._timerKind = null; // what to do when it fires (M88 `t_phase`)
    return this;
  }

  // ---- the mechanical clock ---------------------------------------------------
  // Unit: 10 µs, straight from M88. `PC88::Proceed` says "1 tick = 10us" in so
  // many words, and everything else agrees — `PC88::Execute` does
  // `ticks * clock` with clock=40, i.e. 40 cycles at 4 MHz, and the frame is
  // 1792 ticks = 71,680 cycles.
  //
  // BOTH FLAGS ARE OFF BY DEFAULT, and that is not timidity. upd765.js is
  // shared with the X68000 board (x68fdd.js), which never calls tick(): a drive
  // told to take 90 ms and then never given a tick would seek forever. Only the
  // PC-8801 board (machine88.js) turns them on, and only it is measured.
  //
  // Whoever calls tick() must call it from REAL time, not from sub-CPU
  // T-states. The sub-CPU is deliberately over-fed while it waits on mechanics,
  // and a clock driven from its instruction count both ran 40% fast and — much
  // worse — shrank the very timers it was waiting for.
  tick(ticks) {
    this.now += ticks;
    // Seek completions come first. They are scheduled independently of the
    // phase timer in M88 (a separate event per drive), and every seek is at
    // least 900 ticks against a read timer's 500, so ordering inside one batch
    // has never been ambiguous in practice.
    for (const s of this.seekEnd) {
      if (s.at <= this.now) this.seekBusy &= ~(1 << s.us);
    }
    if (this._timerAt >= 0 && this._timerAt <= this.now) {
      const kind = this._timerKind;
      this._timerAt = -1; this._timerKind = null;
      // No closures: a snapshot has to be plain data, so the timer stores what
      // to do as a string and re-derives the arguments from state that is
      // already snapshotted (`cmd`, `_multi`).
      if (kind === 'readStart') this._beginRead((this.cmd[0] & 0x1f) === 0x0c);
      else if (kind === 'readNext') this._toExecRead(this._multi.sec.data);
    }
  }

  _arm(ticks, kind) { this._timerAt = this.now + ticks; this._timerKind = kind; }
  _cancelTimer() { this._timerAt = -1; this._timerKind = null; }

  // A seek-end interrupt is only pending once its tick has arrived. With
  // seekTiming off `at` is 0 and everything is due immediately, which is
  // exactly what this chip did before the clock existed.
  _dueSeek(take) {
    for (let i = 0; i < this.seekEnd.length; i++) {
      if (this.seekEnd[i].at <= this.now) return take ? this.seekEnd.splice(i, 1)[0] : this.seekEnd[i];
    }
    return undefined;
  }

  // M88 FDC::Seek. Two things about the distance are easy to get wrong:
  //
  //   seektime = seekcount && diskwait ? (400 * Abs(seekcount) + 500) : 10;
  //
  // (1) a zero-distance seek still costs 10 ticks, it is not free; and
  // (2) `seekcount` is in 96-TPI steps. M88 keeps the head position in those
  //     and doubles the requested cylinder on the way in (`cy <<= drive[dr].dd`,
  //     and dd is 1 unless port F4h declares a 96-TPI drive — the PC-8801 sub
  //     ROM never writes F4h, so it is always 1). Our `cyl` is the logical
  //     cylinder, so the step count is twice the difference.
  _seekTicks(fromCyl, toCyl) {
    if (!this.seekTiming) return 0;
    const steps = 2 * Math.abs(toCyl - fromCyl);
    return steps ? 400 * steps + 500 : 10;
  }

  _seekDone(us, delay) {
    this.seekEnd.push({
      us,
      // seeks succeed on any *existing* drive unit, disk or not — the head
      // moves regardless; only a nonexistent unit fails (AT|SE|NR)
      st0: us < UNITS ? ST0_SE | us : ST0_AT | ST0_SE | 0x08 | us,
      at: this.now + delay,
    });
    if (delay > 0) this.seekBusy |= 1 << us; // MSR D0B..D3B while the head moves
  }

  // ---- phase shifts (M88's ShiftToXxxPhase) -----------------------------------
  // Each one assigns the whole status word. Keeping the assignments here — and
  // nowhere else — is what makes the MSR auditable: to know what the CPU sees,
  // read these five functions, not a switch over `phase`.
  _toIdle() { this.phase = 'idle'; this.status = RQM; this.acceptTc = false; }
  _toCommand() { this.phase = 'command'; this.status = RQM | CB; this.acceptTc = false; }
  _toExecRead(buf) {
    this.phase = 'execute'; this.execWrite = false;
    this.execBuf = buf; this.execPos = 0;
    this.status = RQM | DIO | EXM | CB;
    this.acceptTc = true;
    this.int = true; // non-DMA: first byte ready
  }
  _toExecWrite(buf) {
    this.phase = 'execute'; this.execWrite = true;
    this.execBuf = buf; this.execPos = 0;
    this.status = RQM | EXM | CB;
    this.acceptTc = true;
    this.int = true; // non-DMA: first byte wanted
  }

  // Rebuild `status` the way the old derived MSR would have. Only for restoring
  // snapshots taken before the MSR became a variable: those carry `phase` but
  // no `status`, and leaving `status` at its idle default made every restored
  // mid-transfer read return 0xff (test-x68's round-trip caught it).
  _statusFromPhase() {
    switch (this.phase) {
      case 'command': this.status = RQM | CB; this.acceptTc = false; break;
      case 'execute': this.status = RQM | EXM | CB | (this.execWrite ? 0 : DIO); this.acceptTc = true; break;
      case 'result': this.status = RQM | DIO | CB; this.acceptTc = false; break;
      default: this.status = RQM; this.acceptTc = false; break;
    }
  }

  insertDisk(unit, disk) { this.drives[unit & 3].disk = disk; return this; }
  ejectDisk(unit) { this.drives[unit & 3].disk = null; return this; }

  get intLine() { return this.int || this._dueSeek(false) !== undefined; }

  // ---- MSR ------------------------------------------------------------------
  // M88: `uint FDC::Status(uint) { return seekstate | status; }` — a variable
  // read, nothing else. `phase` is deliberately NOT consulted here.
  readStatus() { return this.seekBusy | this.status; }

  // ---- data register ----------------------------------------------------------
  // Both accessors open with M88's guard. This is the mechanism the whole
  // timer story rests on: while RQM is low the port is DEAD — a write changes
  // nothing at all, a read yields nothing. The driver spins; when the timer
  // raises RQM the spin ends. Attempt #3 at the read timer parked the wait in
  // the command phase *without* this guard, so the driver's data bytes were
  // appended to the command byte stream and 02A8h span 406,610 times.
  write(v) {
    // M88 FDC::SetData: `if ((status & (S_RQM | S_DIO)) == S_RQM)`.
    // RQM low → busy; DIO high → the chip wants to be read, not written.
    if ((this.status & (RQM | DIO)) !== RQM) return;
    this.data = v & 0xff;
    this.status &= ~RQM; // one RQM per byte; whoever consumes it raises it again
    this.int = false;
    switch (this.phase) {
      case 'idle':
        this.cmd = [this.data];
        this.cmdLen = CMD_LEN[this.data & 0x1f] ?? 1;
        if (this.cmd.length < this.cmdLen) this._toCommand();
        else this._start();
        return;
      case 'command':
        this.cmd.push(this.data);
        if (this.cmd.length < this.cmdLen) this.status |= RQM; // more parameters wanted
        else this._start(); // the command decides what the MSR says next
        return;
      case 'execute':
        if (!this.execWrite) return;
        this.execBuf[this.execPos++] = this.data;
        if (this.execPos < this.execBuf.length) { this.status |= RQM; this.int = true; }
        else { this.status &= ~EXM; this._execDone(); } // M88 drops NDM before the tail
        return;
      default:
        return;
    }
  }

  read() {
    // M88 FDC::GetData: `if ((status & (S_RQM | S_DIO)) == (S_RQM | S_DIO))`.
    //
    // M88 returns the stale `data` latch when the guard fails; we return 0xff,
    // which is what this method has always returned outside a readable phase.
    // Keeping that identical was the point — the MSR rewrite had to be a pure
    // refactor before any timer went on top of it. Nothing polls the data port
    // while RQM is low anyway: the sub ROM's bulk loop at 0300h gates on EXM,
    // and the handshakes at 029Ah/02A8h gate on RQM|DIO.
    if ((this.status & (RQM | DIO)) !== (RQM | DIO)) return 0xff;
    this.int = false;
    this.status &= ~RQM;
    if (this.phase === 'execute') {
      const v = this.execBuf[this.execPos++];
      this.data = v;
      if (this.execPos < this.execBuf.length) { this.status |= RQM; this.int = true; }
      else { this.status &= ~EXM; this._execDone(); }
      return v;
    }
    // result phase
    const v = this.result[this.resultPos++] ?? 0xff;
    this.data = v;
    if (this.resultPos < this.result.length) this.status |= RQM;
    else this._toIdle();
    return v;
  }

  // TC pin (on the PC-8801 sub-board, wired so that IN from port F8h pulses it)
  tc() {
    // M88 gates on `accepttc`, which is raised by the exec-phase shifts and
    // cleared everywhere else. That is not the same as `phase === 'execute'`
    // once timers exist: between two sectors of a multi-sector read M88 is
    // parked on a timer with the transfer not running, yet TC is still armed.
    if (!this.acceptTc) return;
    this.acceptTc = false;
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
        this._toIdle();
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
        const delay = this._seekTicks(d.cyl, 0);
        d.cyl = 0;
        this._seekDone(this.us, delay);
        this._toIdle();
        return;
      }

      case 0x0f: { // SEEK
        const d = this.drives[this.us];
        const delay = this._seekTicks(d.cyl, this.cmd[2]);
        d.cyl = this.cmd[2];
        this._seekDone(this.us, delay);
        this._toIdle();
        return;
      }

      case 0x08: { // SENSE INTERRUPT STATUS
        const p = this._dueSeek(true); // a seek still in flight is not pending yet
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
        this._multi = { format: true };
        this._toExecWrite(new Uint8Array(Math.max(4, bytes)));
        return;
      }

      default: // invalid
        this._results([ST0_IC]);
        return;
    }
  }

  // M88's CmdReadData does NOT touch the disk in the command phase:
  //
  //     case commandphase:
  //         GetSectorParameters();
  //         SetTimer(executephase, 250 << Min(7, idr.n));
  //         return;
  //     case executephase:
  //         ReadData(...);
  //
  // and it returns with RQM still low (SetData cleared it; nothing raised it
  // again). So for the next `250 << n` ticks — 5 ms for the usual 256-byte
  // sector, the same order as a real 250 kbps MFM sector — the MSR reads CB and
  // nothing else, the data port is dead, and INT is low. Every driver in the
  // sub ROM copes: the bulk loop at 0300h sleeps in EI/HALT at 02FEh waiting
  // for the FDC's INT, and the handshakes at 029Ah/02A8h spin on RQM.
  //
  // Attempt #2 at this timer dropped RQM but left the execution phase (and so
  // EXM) up, and 0300h read 0xff out of a chip that had nothing yet.
  _startRead(wantDeleted) {
    if (!this.readTiming) return this._beginRead(wantDeleted);
    this._arm(250 << Math.min(7, this.cmd[5]), 'readStart');
  }

  _beginRead(wantDeleted) {
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
    // MT (bit 7) = multi-track: after the EOT sector on head 0, the command does
    // NOT end — it flips to head 1 of the same cylinder and carries on at R=1.
    // A 2D loader can pull a whole cylinder (both sides) in one command that way.
    this._multi = { c, h, r, n, eot, deleted: wantDeleted, sec, mt: (this.cmd[0] & 0x80) !== 0 };
    this._toExecRead(sec.data);
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
    this._toExecRead(buf);
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
    this._toExecWrite(sec.data);
  }

  // Advance the record ID after a sector completes, exactly as the µPD765 does
  // (this mirrors M88's `FDC::IDIncrement`). Returns true while the command
  // should keep going, false at end of cylinder.
  //
  //   R != EOT           → R+1, continue
  //   R == EOT, no MT    → R=1, C+1, stop
  //   R == EOT, MT       → R=1, flip the head. Landing on side 1 continues the
  //                        command; landing back on side 0 means both sides of
  //                        the cylinder are done, so C+1 and stop.
  //
  // The head flip is what a 2D loader relies on to pull a whole cylinder — both
  // sides, 32 sectors — in one command. Missing it made us deliver half the
  // data and leave the caller's buffer holding the *previous* transfer, which is
  // how Makaimura came to decrypt a stale sector into garbage code (issue #13).
  _idIncrement(m) {
    const atEot = m.r === m.eot;
    m.r = (m.r + 1) & 0xff;
    if (!atEot) return true;
    m.r = 1;
    if (m.mt) {
      this.hd ^= 1;
      m.h ^= 1;
      if (m.h & 1) return true;
    }
    m.c = (m.c + 1) & 0xff;
    return false;
  }

  _execDone() {
    const m = this._multi;
    // On the PC-8801 disk sub-board the sub-CPU reads exactly the bytes it wants
    // and then pulses TC (IN from port F8h → tc()). We serve the current sector's
    // bytes; when the host keeps reading past a sector boundary we auto-advance
    // to R+1 (genuine multi-sector read).
    if (m && !m.format && !this.execWrite) {
      const d = this.drives[this.us];
      // ST0 reports the head the transfer actually ran on, while the result ID
      // reports where the chip stopped — and under MT those disagree, because
      // finishing side 1 flips the ID back to side 0. Capture the head before
      // the flip. (M88 keeps the same split: a saved `hdue` feeds ST0 while
      // `idr.h` has already been toggled by IDIncrement.) Ys reads a cylinder
      // with MT starting on side 1 and checks ST0's HD bit; reporting the
      // post-flip head there makes it re-issue the same read forever.
      m.stHd = this.hd;
      if (this._idIncrement(m)) {
        const next = findSector(d.disk, d.cyl, this.hd, m.r, m.n);
        if (next) {
          m.sec = next;
          // M88 waits `250 << n` again between sectors:
          //     case execreadphase:
          //         if (!IDIncrement()) { SetTimer(timerphase, 20); return; }
          //         SetTimer(executephase, 250 << Min(7, idr.n));
          // read() has already cleared RQM and EXM and dropped INT, so the gap
          // looks like DIO|CB with the transfer visibly stopped — and `acceptTc`
          // stays up, so a TC pulse during the gap still ends the command.
          if (this.readTiming) this._arm(250 << Math.min(7, m.n), 'readNext');
          else this._toExecRead(next.data); // re-raises RQM|EXM for the next sector
          return;
        }
      }
      // Whether it continued or not, the ID now holds where the chip stopped —
      // that is exactly what the result phase reports. Termination stays NORMAL
      // (no abnormal/EN status): this post-command ID is what a disk loader reads
      // back to chain to the next cluster (the N88-DISK-BASIC FAT walk). Getting
      // it wrong under-reads the file — 軽井沢誘拐案内 stops mid-load.
      m.rAddr = true;
    }
    this._endRw(0, 0, 0);
  }

  _endRw(st0extra, st1, st2) {
    const m = this._multi ?? { c: 0, h: this.hd, r: 1, n: 1, sec: null };
    const sec = m.sec;
    // a sector whose stored status is non-zero (protection!) reports it:
    // D88 status 0xB0 = data CRC error → ST1 DE, 0xF0 = no data → ST1 ND
    const stHd = m.stHd !== undefined ? m.stHd : this.hd; // see _execDone
    let xst1 = st1, xst2 = st2, st0 = this.us | (stHd << 2) | st0extra;
    if (sec && sec.status) {
      st0 |= ST0_AT;
      if (sec.status === 0xa0 || sec.status === 0xb0) { xst1 |= 0x20; xst2 |= (sec.status === 0xb0 ? 0x20 : 0); }
      else if (sec.status === 0xf0) xst1 |= 0x04;
      else xst1 |= 0x20;
    }
    if (sec?.deleted && !m.deleted) xst2 |= 0x40; // ST2 CM: hit deleted data
    // result ID: normally the last sector's own id, but a completed read leaves
    // the "next sector" address (see _execDone) — m.rAddr overrides C/R then.
    // After a completed transfer `_idIncrement` has already walked the ID to
    // where the chip stopped, so report it verbatim; an aborted command reports
    // the sector it died on instead.
    const rc = m.rAddr ? m.c : (sec?.c ?? m.c);
    const rr = m.rAddr ? m.r : (sec?.r ?? m.r);
    const rh = m.rAddr ? m.h : (sec?.h ?? m.h);
    this._results([st0, xst1, xst2, rc, rh, rr, sec?.n ?? m.n]);
  }

  _rwError(st1, c, h, r, n) {
    this._multi = null;
    this._results([ST0_AT | this.us | (this.hd << 2), st1, 0, c, h, r, n]);
  }

  _results(bytes) {
    this.result = bytes;
    this.resultPos = 0;
    this.phase = 'result';
    this.status = RQM | DIO | CB; // M88 ShiftToResultPhase
    this.acceptTc = false;
    this._cancelTimer(); // M88's tcphase does DelTimer(); nothing outlives a result
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
