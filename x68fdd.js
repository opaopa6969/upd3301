// x68fdd — X68000 floppy images and the drive side of the µPD72065.
//
// The controller itself is upd765.js, unchanged: the X68000's µPD72065 is a
// µPD765 with a faster clock and a couple of extra commands, and every command
// Human68k's IOCS issues (SPECIFY / RECALIBRATE / SEEK / SENSE INT / SENSE
// DEVICE / READ ID / READ DATA / WRITE DATA / READ DIAGNOSTIC) is plain µPD765.
// So this file supplies the two things upd765.js does not know about:
//
//   1. the disk. Images arrive as .XDF/.IMG (a flat dump), .DIM (a flat dump
//      with a track-presence bitmap) or .D88 (already sector-addressed). All
//      three are turned into the *same* structure d88.js produces, because
//      that is what upd765.js's findSector() reads.
//   2. the drive control registers at $E94005/$E94007, which have nothing to
//      do with the FDC — they are the front panel: motor, drive select, eject,
//      the eject-inhibit latch and the access LED.
//
// ## Why the interrupt is split in two
//
// upd765.js models a chip in NON-DMA mode: `int` goes high once per byte to
// ask the CPU for the next one. The X68000 wires the same pin to the DMAC's
// DREQ and takes the *command-complete* interrupt through the I/O controller
// at IRQ level 1. Those are the same pin on the real part; the difference is
// only which phase you are in. So `dataReady` reports `int` during the
// execution phase (that is a DREQ) and `intPending` reports it during the
// result phase (that is the interrupt). Getting this wrong lands the machine
// in an IRQ storm during every sector read.
//
// Pure, deterministic, zero deps.

import { parseD88All, findSector } from './d88.js';
import { Upd765 } from './upd765.js';

export const SCHEMA_VERSION = 1;

// DIM's media byte selects the whole geometry. Index = the byte at offset 0.
// Bytes 4-8 are not defined by the format.
const DIM_GEOMETRY = [
  { name: '2HD', sectors: 8, n: 3, cylinders: 77 },   // 0: 1232 KB, the X68000 native format
  { name: '2HS', sectors: 9, n: 3, cylinders: 80 },   // 1: 1440 KB with 1 KB sectors
  { name: '2HC', sectors: 15, n: 2, cylinders: 80 },  // 2: 1200 KB, the PC/AT-ish one
  { name: '2HDE', sectors: 9, n: 3, cylinders: 80 },  // 3: same shape as 2HS
  null, null, null, null, null,
  { name: '2HQ', sectors: 18, n: 2, cylinders: 80 },  // 9: 1440 KB with 512 byte sectors
];

const DIM_HEADER_SIZE = 256;
const DIM_TRACKS = 170;
const DIM_SIGNATURE = 'DIFC HEADER  ';

// Flat dumps carry no header at all, so the size is the only evidence. 2HD is
// listed first because on this machine it is the overwhelming default; the two
// 1440 KB readings are genuinely ambiguous (9x1024 and 18x512 are the same
// number of bytes) and `format` in the options can force either.
const RAW_GEOMETRY = [
  { name: '2HD', sectors: 8, n: 3, cylinders: 77, size: 8 * 1024 * 154 },
  { name: '2HS', sectors: 9, n: 3, cylinders: 80, size: 9 * 1024 * 160 },
  { name: '2HC', sectors: 15, n: 2, cylinders: 80, size: 15 * 512 * 160 },
  { name: '2HD85', sectors: 8, n: 3, cylinders: 85, size: 8 * 1024 * 170 },
];

const ascii = (bytes) => {
  let s = '';
  for (const b of bytes) { if (b === 0) break; s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'; }
  return s;
};

// Build the d88.js-shaped track table from a flat run of track images.
// `present(t)` says whether track t exists on the medium; a track that does
// not exist is a hole the FDC answers with "no data", which is how a lot of
// X68000 copy protection is expressed.
function tracksFromFlat(bytes, base, geom, present) {
  const secSize = 128 << geom.n;
  const trackBytes = secSize * geom.sectors;
  const tracks = [];
  const total = geom.cylinders * 2;
  for (let t = 0; t < 164; t++) {
    if (t >= total || !present(t)) { tracks.push(null); continue; }
    const off = base + t * trackBytes;
    const sectors = [];
    for (let i = 0; i < geom.sectors; i++) {
      const p = off + i * secSize;
      // A truncated image (several in the wild are short by a track or two)
      // gives an empty sector rather than an exception: the drive would read
      // unformatted media there, and the loader is entitled to see that.
      const data = p + secSize <= bytes.length
        ? bytes.subarray(p, p + secSize)
        : new Uint8Array(secSize).fill(0xe5);
      sectors.push({
        c: t >> 1, h: t & 1, r: i + 1, n: geom.n,
        density: 0x00, deleted: false, status: 0x00,
        size: secSize, data,
      });
    }
    tracks.push({ index: t, cylinder: t >> 1, head: t & 1, sectors });
  }
  return tracks;
}

export function isDim(bytes) {
  if (bytes.length < DIM_HEADER_SIZE) return false;
  return ascii(bytes.subarray(0xab, 0xab + 13)) === DIM_SIGNATURE;
}

// .DIM — DITT's format. One byte of media type, 170 track-presence flags, a
// signature and a comment, then only the tracks whose flag is set, back to
// back. `overtrack` (the last header byte) being zero means "the flags are
// not meaningful, every track is there", which is what the writer does for a
// plain unprotected disk.
export function parseDim(bytes) {
  if (!isDim(bytes)) throw new Error('not a DIM image (no DIFC HEADER)');
  const type = bytes[0];
  const geom = DIM_GEOMETRY[type];
  if (!geom) throw new Error(`unsupported DIM media type ${type}`);
  const flags = bytes.subarray(1, 1 + DIM_TRACKS);
  const overtrack = bytes[255];
  const trackBytes = (128 << geom.n) * geom.sectors;

  // The file holds present tracks only, so the offset of track t is the count
  // of present tracks before it — not t itself.
  const offsets = new Int32Array(DIM_TRACKS).fill(-1);
  let o = DIM_HEADER_SIZE;
  for (let t = 0; t < DIM_TRACKS; t++) {
    const there = overtrack ? !!flags[t] : true;
    if (!there) continue;
    offsets[t] = o;
    o += trackBytes;
  }

  const tracks = [];
  const secSize = 128 << geom.n;
  for (let t = 0; t < 164; t++) {
    const off = t < DIM_TRACKS ? offsets[t] : -1;
    if (off < 0 || off >= bytes.length) { tracks.push(null); continue; }
    const sectors = [];
    for (let i = 0; i < geom.sectors; i++) {
      const p = off + i * secSize;
      const data = p + secSize <= bytes.length
        ? bytes.subarray(p, p + secSize)
        : new Uint8Array(secSize).fill(0xe5);
      sectors.push({
        c: t >> 1, h: t & 1, r: i + 1, n: geom.n,
        density: 0x00, deleted: false, status: 0x00,
        size: secSize, data,
      });
    }
    tracks.push({ index: t, cylinder: t >> 1, head: t & 1, sectors });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    format: 'DIM',
    // 1 type byte + 170 track flags + 15 of signature + 4 date + 4 time puts
    // the writer's free-text comment at 0xC2, 61 bytes of it.
    name: ascii(bytes.subarray(0xc2, 0xc2 + 61)),
    media: geom.name,
    writeProtect: false,
    tracks,
  };
}

// A flat dump. Every track is present and every sector is where arithmetic
// says it is; there is nowhere to record a bad CRC, which is why protected
// disks were never distributed this way.
export function parseRaw(bytes, format = null) {
  let geom = format ? RAW_GEOMETRY.find((g) => g.name === format) : null;
  if (!geom) geom = RAW_GEOMETRY.find((g) => g.size === bytes.length);
  if (!geom) {
    // Not an exact match: pick the largest geometry the file can fill whole
    // tracks of, so a dump padded or clipped by a few bytes still mounts.
    geom = RAW_GEOMETRY.find((g) => bytes.length >= g.size - (128 << g.n) * g.sectors);
  }
  if (!geom) throw new Error(`no X68000 floppy geometry fits ${bytes.length} bytes`);
  return {
    schemaVersion: SCHEMA_VERSION,
    format: 'XDF',
    name: '',
    media: geom.name,
    writeProtect: false,
    tracks: tracksFromFlat(bytes, 0, geom, () => true),
  };
}

// One entry point for the host: hand it a file and a name and it decides.
// Returns an ARRAY because a .d88 can hold several images in one file.
export function parseX68DiskAll(bytes, { name = '', format = null } = {}) {
  const ext = (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
  if (isDim(bytes)) return [parseDim(bytes)];
  if (ext === 'd88' || ext === '88d' || looksLikeD88(bytes)) {
    return parseD88All(bytes).map((d) => ({ ...d, format: 'D88' }));
  }
  return [parseRaw(bytes, format)];
}

export function parseX68Disk(bytes, opts = {}) { return parseX68DiskAll(bytes, opts)[0]; }

// D88's header is 0x2b0 bytes and its size field is the whole image; that
// pair of facts is specific enough to recognise without a magic number.
function looksLikeD88(bytes) {
  if (bytes.length < 0x2b0) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = dv.getUint32(0x1c, true);
  if (size < 0x2b0 || size > bytes.length) return false;
  const first = dv.getUint32(0x20, true);
  return first === 0 || (first >= 0x2b0 && first < size);
}

// Never throws: a file picker meets junk, and the caller wants to print a
// reason rather than lose the exception.
export function tryParseX68Disk(bytes, opts = {}) {
  try {
    const disks = parseX68DiskAll(bytes, opts);
    if (!disks.length) return { ok: false, error: 'no disk image found' };
    return { ok: true, disks, disk: disks[0] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function summarizeX68Disk(disk) {
  const used = disk.tracks.filter(Boolean);
  const sectors = used.reduce((a, t) => a + t.sectors.length, 0);
  const bytes = used.reduce((a, t) => a + t.sectors.reduce((b, s) => b + s.size, 0), 0);
  return {
    schemaVersion: SCHEMA_VERSION,
    format: disk.format || 'D88', media: disk.media, name: disk.name,
    tracks: used.length, sectors, bytes, writeProtect: !!disk.writeProtect,
  };
}

// Human68k names its boot disks in the boot sector, which is also the cheapest
// way for a sweep tool to tell a bootable disk from a data disk.
export function bootRecord(disk) {
  const sec = findSector(disk, 0, 0, 1, null);
  if (!sec || sec.size < 32) return null;
  const d = sec.data;
  return {
    bootable: d[0] === 0x60,          // BRA.S over the parameter block
    oem: ascii(d.subarray(2, 10)),
    label: ascii(d.subarray(0x0e, 0x1e)),
  };
}

// ---------------------------------------------------------------------------
// The drive side.

const DRIVES = 4;

export class X68Fdd {
  constructor() {
    this.fdc = new Upd765();
    this.disks = [null, null, null, null];
    this.reset();
  }

  reset() {
    this.fdc.reset();
    this.ctrl = 0;      // $E94005 latch
    this.select = -1;   // active drive, -1 = none selected
    this.motor = false;
    this.ejectMask = [false, false, false, false];
    this.ledBlink = [false, false, false, false];
    // The IOCS polls "has a disk been swapped" through the same IRQ, and the
    // machine posts it a few frames after insertion the way the real drive's
    // ready line settles. Zero means nothing pending.
    this.insertDelay = [0, 0, 0, 0];
    return this;
  }

  insert(unit, disk) {
    this.disks[unit & 3] = disk;
    this.fdc.insertDisk(unit & 3, disk);
    this.insertDelay[unit & 3] = 3;
    return this;
  }

  eject(unit) {
    if (this.ejectMask[unit & 3]) return this;  // the program has latched the door shut
    this.disks[unit & 3] = null;
    this.fdc.ejectDisk(unit & 3);
    this.insertDelay[unit & 3] = 3;
    return this;
  }

  isReady(unit) {
    return unit >= 0 && unit < DRIVES && !!this.disks[unit] && this.insertDelay[unit] === 0;
  }

  // Called once per frame: the ready line comes up a moment after the door
  // shuts, and the "media changed" interrupt fires then, not at insertion.
  tickFrame() {
    let changed = false;
    for (let i = 0; i < DRIVES; i++) {
      if (this.insertDelay[i] > 0 && --this.insertDelay[i] === 0) changed = true;
    }
    return changed;
  }

  // DREQ: the controller has a byte for the DMAC (or wants one).
  get dataReady() { return this.fdc.phase === 'execute'; }

  // The command-complete interrupt. Three things have to be true and each of
  // them cost a debugging session:
  //
  //   * not the execution phase. There the same pin is the data request, and
  //     routing that to the CPU is an interrupt storm.
  //   * not one of the commands that finish without interrupting. SPECIFY,
  //     SENSE DEVICE STATUS and SENSE INTERRUPT STATUS answer immediately and
  //     the controller does not raise INT for them. upd765.js sets its INT for
  //     every command because the PC-8801's sub-CPU polls rather than
  //     interrupts, so the distinction has to be made here. Without it the
  //     boot ROM's own interrupt handler races the polled code, reads the
  //     result bytes first, and the polled code waits for a result phase that
  //     already happened.
  //   * a pending seek-end always interrupts, whatever command is showing.
  get intPending() {
    const f = this.fdc;
    if (f.seekEnd.length > 0) return true;
    if (f.phase !== 'result' || !f.int) return false;
    const op = f.cmd[0] & 0x1f;
    return op !== 0x03 && op !== 0x04 && op !== 0x08;
  }

  // ---- registers -----------------------------------------------------------
  read(a) {
    switch (a & 7) {
      case 1: return this.fdc.readStatus();
      case 3: return this.fdc.read();
      // $E94005 reads back "the selected drive is ready". Bit 7 only; the
      // IOCS uses it to decide whether a drive is worth a SENSE DEVICE.
      case 5: {
        if ((this.ctrl & 1) && this.isReady(0)) return 0x80;
        if ((this.ctrl & 2) && this.isReady(1)) return 0x80;
        return 0x00;
      }
      default: return 0x00;
    }
  }

  write(a, v) {
    v &= 0xff;
    switch (a & 7) {
      case 3: {
        this.fdc.write(v);
        // SENSE INTERRUPT STATUS with nothing pending answers with ST0 = $80
        // (invalid command) and NOTHING ELSE — one result byte, not two. The
        // IOCS knows that: it reads ST0, sees the invalid bits, and stops. A
        // controller that still had a byte queued would sit in the result
        // phase with CB asserted forever, and the boot ROM's "wait for the
        // controller to go idle" loop never returns. upd765.js queues the
        // present-cylinder byte unconditionally because the PC-8801's sub-ROM
        // always reads both; trimming it here rather than there keeps that
        // machine's behaviour untouched.
        const f = this.fdc;
        if (f.phase === 'result' && (f.cmd[0] & 0x1f) === 0x08
            && f.result.length === 2 && (f.result[0] & 0xc0) === 0x80) {
          f.result = [f.result[0]];
        }
        return;
      }
      case 5: {
        // Bits 0-3 pick which drives this write is about, and the *falling*
        // edge of a drive's bit is what commits bits 5-7 to it. Programs park
        // the settings first and strobe them in afterwards, so acting on the
        // level instead of the edge ejects disks nobody asked to eject.
        for (let i = 0; i < 2; i++) {
          const bit = 1 << i;
          if ((this.ctrl & bit) && !(v & bit)) {
            if (this.ctrl & 0x20) this.eject(i);
            this.ejectMask[i] = (this.ctrl & 0x40) !== 0;
            this.ledBlink[i] = (this.ctrl & 0x80) !== 0;
          }
        }
        this.ctrl = v;
        return;
      }
      case 7:
        // Bit 7 is the motor. With it clear no drive is selected at all, which
        // is how the IOCS parks the head between accesses.
        this.select = (v & 0x80) ? (v & 3) : -1;
        this.motor = (v & 0x80) !== 0;
        return;
      default:
        return;
    }
  }

  // ---- snapshot ------------------------------------------------------------
  // upd765.js's own getState() is a summary for tools, not a restorable state,
  // and it is not ours to change. So the controller is serialised from the
  // outside here. The one thing that cannot be copied verbatim is `execBuf`:
  // it aliases a sector's data array, and a snapshot must not carry disk
  // contents. It is re-derived on restore from the sector ID instead.
  getState() {
    const f = this.fdc;
    const m = f._multi;
    return {
      schemaVersion: SCHEMA_VERSION,
      phase: f.phase, cmd: [...f.cmd], cmdLen: f.cmdLen,
      result: [...f.result], resultPos: f.resultPos,
      execPos: f.execPos, execWrite: f.execWrite,
      // A buffer that is not a sector (READ DIAGNOSTIC's whole track, FORMAT's
      // ID stream) is small and has nowhere else to live, so it travels.
      execBufOwn: f.execBuf && !this._bufIsSector(f.execBuf) ? Array.from(f.execBuf) : null,
      int: f.int, seekEnd: f.seekEnd.map((s) => ({ ...s })),
      us: f.us, hd: f.hd,
      cyls: f.drives.map((d) => d.cyl),
      idx: f.drives.map((d) => d._idx ?? -1),
      multi: m ? { c: m.c, h: m.h, r: m.r, n: m.n, eot: m.eot, deleted: !!m.deleted,
                   format: !!m.format, rc: m.rc, rr: m.rr, rAddr: !!m.rAddr,
                   secCyl: m.sec ? m.sec.c : -1, secHead: m.sec ? m.sec.h : -1,
                   secR: m.sec ? m.sec.r : -1, secN: m.sec ? m.sec.n : -1 } : null,
      ctrl: this.ctrl, select: this.select, motor: this.motor,
      ejectMask: [...this.ejectMask], ledBlink: [...this.ledBlink],
      insertDelay: [...this.insertDelay],
    };
  }

  _bufIsSector(buf) {
    for (const d of this.fdc.drives) {
      const disk = d.disk;
      if (!disk) continue;
      for (const t of disk.tracks) {
        if (!t) continue;
        for (const s of t.sectors) if (s.data === buf) return true;
      }
    }
    return false;
  }

  setState(s) {
    const f = this.fdc;
    f.phase = s.phase; f.cmd = [...s.cmd]; f.cmdLen = s.cmdLen;
    f.result = [...s.result]; f.resultPos = s.resultPos;
    f.execPos = s.execPos; f.execWrite = s.execWrite;
    f.int = s.int;
    f.seekEnd = s.seekEnd.map((x) => ({ ...x }));
    f.us = s.us; f.hd = s.hd;
    for (let i = 0; i < f.drives.length; i++) {
      f.drives[i].cyl = s.cyls[i];
      if (s.idx[i] >= 0) f.drives[i]._idx = s.idx[i];
    }
    if (!s.multi) { f._multi = null; }
    else {
      const m = s.multi;
      // Re-attach the sector by ID rather than by identity: the disk object is
      // the same one that was mounted, so the same ID names the same bytes.
      const sec = m.secR >= 0
        ? findSector(f.drives[f.us].disk || { tracks: [] }, m.secCyl, m.secHead, m.secR, m.secN)
        : null;
      f._multi = { c: m.c, h: m.h, r: m.r, n: m.n, eot: m.eot, deleted: m.deleted,
                   format: m.format, rc: m.rc, rr: m.rr, rAddr: m.rAddr, sec };
      if (s.execBufOwn) f.execBuf = Uint8Array.from(s.execBufOwn);
      else f.execBuf = sec ? sec.data : null;
    }
    if (!f._multi) f.execBuf = s.execBufOwn ? Uint8Array.from(s.execBufOwn) : null;
    this.ctrl = s.ctrl; this.select = s.select; this.motor = s.motor;
    this.ejectMask = [...s.ejectMask]; this.ledBlink = [...s.ledBlink];
    this.insertDelay = [...s.insertDelay];
    return this;
  }
}

export default X68Fdd;
