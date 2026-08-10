// pc98fdd — PC-9801 floppy images and the drive side of the µPD765.
//
// The controller itself is upd765.js, unchanged. That file was written for the
// PC-8801's disk sub-board and the PC-9801's is the same part; what differs is
// everything around it, and this is where "everything around it" lives:
//
//   1. the images. A PC-98 disk arrives as .D88 (already sector-addressed, and
//      d88.js parses it), as .FDI (a 4096-byte header then a flat dump), or as
//      a bare .HDM/.2HD/.IMG/.DUP flat dump whose geometry has to be guessed
//      from its size. All three end up in the structure d88.js produces,
//      because that is what upd765.js's findSector() reads.
//   2. the 1 MB interface's control registers at $94 and the mode port at $BE.
//      These are not the FDC — they are the drive: motor, DMA enable, the
//      controller's reset line and which density the drive is running at.
//
// ## The three things upd765.js does not know
//
// The X68000 hit these first and its notes are why this file exists in this
// shape. Same chip, same three problems:
//
//   * `int` in the execution phase is a DATA request, not an interrupt. The
//     PC-9801 wires it to the DMA controller's DREQ line and takes the
//     command-complete interrupt separately (IRQ11). Reporting the execution
//     phase as an interrupt gives an interrupt storm inside every sector.
//   * SPECIFY, SENSE DEVICE STATUS and SENSE INTERRUPT STATUS raise no
//     interrupt on real silicon. upd765.js raises one for every command,
//     because the 8801's sub-CPU polls and never notices. Here the BIOS's own
//     handler would race the polling loop and eat the result bytes.
//   * SENSE INTERRUPT STATUS with nothing pending returns ONE byte (ST0=$80).
//     upd765.js always appends the current cylinder, and the extra byte leaves
//     the result phase open with CB still set.
//
// Pure, deterministic, zero deps. upd765.js is not modified.

import { parseD88All } from './d88.js';
import { Upd765 } from './upd765.js';

export const SCHEMA_VERSION = 1;

// Flat images carry no header, so the file size is the only evidence. 2HD
// (1024-byte sectors, 8 per track, 77 cylinders) is the PC-98's own format and
// what a boot disk almost always is.
const RAW_GEOMETRY = [
  { name: '2HD', sectors: 8, n: 3, cylinders: 77, size: 1024 * 8 * 154 },   // 1,261,568
  { name: '2HD80', sectors: 8, n: 3, cylinders: 80, size: 1024 * 8 * 160 }, // 1,310,720
  { name: '1.44M', sectors: 18, n: 2, cylinders: 80, size: 512 * 18 * 160 },// 1,474,560
  { name: '2HC', sectors: 15, n: 2, cylinders: 80, size: 512 * 15 * 160 },  // 1,228,800
  { name: '2DD', sectors: 8, n: 2, cylinders: 80, size: 512 * 8 * 160 },    // 655,360
  { name: '2DD9', sectors: 9, n: 2, cylinders: 80, size: 512 * 9 * 160 },   // 737,280
];

const FDI_HEADER = 4096;

const ascii = (bytes) => {
  let s = '';
  for (const b of bytes) { if (b === 0) break; s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'; }
  return s;
};

function tracksFromFlat(bytes, base, geom) {
  const secSize = 128 << geom.n;
  const trackBytes = secSize * geom.sectors;
  const tracks = [];
  const total = geom.cylinders * 2;
  for (let t = 0; t < 164; t++) {
    if (t >= total) { tracks.push(null); continue; }
    const off = base + t * trackBytes;
    if (off >= bytes.length) { tracks.push(null); continue; }
    const sectors = [];
    for (let i = 0; i < geom.sectors; i++) {
      const p = off + i * secSize;
      // A short image (several in the wild are truncated) gives formatted-but-
      // empty media rather than an exception; the loader is entitled to see it.
      const data = p + secSize <= bytes.length
        ? bytes.subarray(p, p + secSize)
        : new Uint8Array(secSize).fill(0xe5);
      sectors.push({
        c: t >> 1, h: t & 1, r: i + 1, n: geom.n,
        density: 0x00, deleted: false, status: 0x00, size: secSize, data,
      });
    }
    tracks.push({ index: t, cylinder: t >> 1, head: t & 1, sectors });
  }
  return tracks;
}

export function isD88(bytes) {
  // A D88 declares its own size at $1C and its media byte at $1B. Both being
  // sane is a much better test than looking at the name field.
  if (bytes.length < 0x2b0) return false;
  const media = bytes[0x1b];
  if (media !== 0x00 && media !== 0x10 && media !== 0x20 && media !== 0x30 && media !== 0x40) return false;
  const size = bytes[0x1c] | (bytes[0x1d] << 8) | (bytes[0x1e] << 16) | (bytes[0x1f] << 24);
  return size >= 0x2b0 && size <= bytes.length + 1;
}

export function isFdi(bytes) {
  if (bytes.length <= FDI_HEADER) return false;
  // The FDI header is little-endian dwords: 0, type, header size, data size,
  // sector size, sectors/track, heads, cylinders. Header size being 4096 is
  // the reliable marker.
  const dw = (o) => bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
  return dw(8) === FDI_HEADER;
}

export function parseFdi(bytes) {
  const dw = (o) => bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
  const secSize = dw(16), sectors = dw(20), heads = dw(24), cylinders = dw(28);
  let n = 0;
  while ((128 << n) < secSize && n < 7) n++;
  const geom = { name: `FDI ${secSize}x${sectors}`, sectors, n, cylinders };
  if (!sectors || !cylinders || heads !== 2) throw new Error('unsupported FDI geometry');
  return {
    schemaVersion: SCHEMA_VERSION,
    name: ascii(bytes.subarray(0, 16)),
    writeProtect: false, media: geom.name, mediaByte: 0x20,
    diskSize: bytes.length,
    tracks: tracksFromFlat(bytes, FDI_HEADER, geom),
  };
}

export function parseRaw(bytes, { format = null } = {}) {
  let geom = format ? RAW_GEOMETRY.find((g) => g.name === format) : null;
  if (!geom) geom = RAW_GEOMETRY.find((g) => g.size === bytes.length);
  if (!geom) {
    // Not an exact match: take the largest geometry the file can hold, so a
    // padded or slightly truncated dump still mounts.
    geom = RAW_GEOMETRY.filter((g) => bytes.length >= g.size * 0.9)
      .sort((a, b) => b.size - a.size)[0];
  }
  if (!geom) throw new Error(`unrecognised raw floppy image of ${bytes.length} bytes`);
  return {
    schemaVersion: SCHEMA_VERSION,
    name: '', writeProtect: false, media: geom.name, mediaByte: 0x20,
    diskSize: bytes.length,
    tracks: tracksFromFlat(bytes, 0, geom),
  };
}

// One entry point for whatever the user dropped in.
export function parsePc98Disk(bytes, opts = {}) {
  if (isD88(bytes)) return parseD88All(bytes)[0];
  if (isFdi(bytes)) return parseFdi(bytes);
  return parseRaw(bytes, opts);
}

export function tryParsePc98Disk(bytes, opts = {}) {
  try { return { disk: parsePc98Disk(bytes, opts) }; }
  catch (e) { return { error: e.message }; }
}

export function summarizePc98Disk(disk) {
  const used = disk.tracks.filter(Boolean);
  const sectors = used.reduce((a, t) => a + t.sectors.length, 0);
  const bytes = used.reduce((a, t) => a + t.sectors.reduce((b, s) => b + s.size, 0), 0);
  return { name: disk.name, media: disk.media, tracks: used.length, sectors, bytes };
}

// The boot sector: cylinder 0, head 0, sector 1. The BIOS reads it to $1FC0:0000
// and jumps there, so what it contains is the single best clue about whether an
// image is bootable at all.
export function bootRecord(disk) {
  const t = disk.tracks[0];
  if (!t || !t.sectors.length) return null;
  const s = t.sectors.find((x) => x.r === 1) || t.sectors[0];
  return { size: s.size, first: Array.from(s.data.subarray(0, 16)), text: ascii(s.data.subarray(0, 16)) };
}

// ---- the drive side ---------------------------------------------------------------
export class Pc98Fdd {
  constructor() {
    this.fdc = new Upd765();
    this.reset();
  }

  reset() {
    this.fdc.reset();
    this.motor = false;
    this.dmaEnable = false;
    this.mode = 0;              // $BE: which density the drives are switched to
    this.us = 0;
    this.changed = [false, false, false, false];
    return this;
  }

  insert(unit, disk) { this.fdc.insertDisk(unit, disk); this.changed[unit & 3] = true; return this; }
  eject(unit) { this.fdc.ejectDisk(unit); this.changed[unit & 3] = true; return this; }
  get hasDisk() { return this.fdc.drives.some((d) => !!d.disk); }

  // The execution phase's INT is a data request, not an interrupt: it means
  // "the FIFO has a byte" and it goes to the DMA controller.
  get dataReady() { return this.fdc.phase === 'execute' && this.fdc.int; }

  // The interrupt the CPU sees is the command-complete one, and only for the
  // commands that actually raise it. SPECIFY finishes silently; the two SENSE
  // commands answer immediately and are read by polling.
  get intPending() {
    if (this.fdc.phase !== 'result') return this.fdc.seekEnd.length > 0;
    const op = this.fdc.cmd.length ? (this.fdc.cmd[0] & 0x1f) : 0;
    if (op === 0x03 || op === 0x04 || op === 0x08) return false;
    return this.fdc.int;
  }

  // ---- ports --------------------------------------------------------------------
  // $90 status, $92 data, $94 control. $BE selects 2HD or 2DD on machines whose
  // drives can do both.
  read(port) {
    switch (port & 0xff) {
      case 0x90: return this.fdc.readStatus();
      case 0x92: return this._readData();
      case 0x94: {
        // Bit 7 is "a disk was swapped", and the BIOS clears it by writing.
        let v = 0x00;
        if (this.changed[this.fdc.us]) v |= 0x80;
        if (this.motor) v |= 0x08;
        return v;
      }
      case 0xbe: return this.mode;
      default: return 0xff;
    }
  }

  write(port, v) {
    switch (port & 0xff) {
      case 0x92: this.fdc.write(v); return;
      case 0x94:
        // bit 3 DMA enable, bit 7 controller reset (active low on the board,
        // so writing it as zero is what actually resets).
        this.dmaEnable = (v & 0x08) !== 0;
        this.motor = (v & 0x08) !== 0;
        if (!(v & 0x80)) {
          this.fdc.reset();
          // A reset makes the chip raise its interrupt so the BIOS's four
          // SENSE INTERRUPT STATUS commands have something to collect.
          for (let u = 0; u < 4; u++) this.fdc.seekEnd.push({ us: u, st0: 0xc0 | u });
        }
        return;
      case 0xbe: this.mode = v & 0xff; return;
      default:
    }
  }

  _readData() {
    // Reading a result byte for a SENSE INTERRUPT STATUS that had nothing
    // pending must end the result phase after ONE byte. upd765.js pushes the
    // cylinder unconditionally; drop it here rather than editing that file.
    const op = this.fdc.cmd.length ? (this.fdc.cmd[0] & 0x1f) : 0;
    const v = this.fdc.read();
    if (op === 0x08 && this.fdc.phase === 'result'
      && this.fdc.result.length === 2 && this.fdc.result[0] === 0x80
      && this.fdc.resultPos === 1) {
      this.fdc.phase = 'idle';
      this.fdc.resultPos = 2;
    }
    return v;
  }

  // The DMA controller's view of the FDC: one byte in each direction.
  dmaRead() { return this.dataReady ? this.fdc.read() : -1; }
  dmaWrite(b) {
    if (this.fdc.phase !== 'execute' || !this.fdc.execWrite) return false;
    this.fdc.write(b);
    return true;
  }
  tc() { this.fdc.tc(); }

  clearChange(unit) { this.changed[unit & 3] = false; }

  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      fdc: {
        phase: this.fdc.phase, cmd: [...this.fdc.cmd], cmdLen: this.fdc.cmdLen,
        result: [...this.fdc.result], resultPos: this.fdc.resultPos,
        execPos: this.fdc.execPos, execWrite: this.fdc.execWrite,
        hasExec: !!this.fdc.execBuf,
        int: this.fdc.int, seekEnd: this.fdc.seekEnd.map((s) => ({ ...s })),
        us: this.fdc.us, hd: this.fdc.hd,
        cyls: this.fdc.drives.map((d) => d.cyl),
        multi: this.fdc._multi ? { ...this.fdc._multi, sec: undefined } : null,
      },
      motor: this.motor, dmaEnable: this.dmaEnable, mode: this.mode,
      changed: [...this.changed],
    };
  }

  setState(s) {
    const f = this.fdc, t = s.fdc;
    f.phase = t.phase; f.cmd = [...t.cmd]; f.cmdLen = t.cmdLen;
    f.result = [...t.result]; f.resultPos = t.resultPos;
    f.execWrite = t.execWrite; f.int = t.int;
    f.seekEnd = t.seekEnd.map((x) => ({ ...x }));
    f.us = t.us; f.hd = t.hd;
    t.cyls.forEach((c, i) => { f.drives[i].cyl = c; });
    // A transfer in flight is restored by pointing at the same sector again:
    // the sector's bytes are the disk's, and the disk is not in the snapshot.
    if (t.multi && t.multi.r !== undefined) {
      const d = f.drives[f.us];
      const trk = d.disk?.tracks[d.cyl * 2 + f.hd];
      const sec = trk?.sectors.find((x) => x.r === t.multi.r);
      f._multi = sec ? { ...t.multi, sec } : null;
      f.execBuf = sec ? sec.data : null;
      f.execPos = t.execPos;
    } else {
      f._multi = null; f.execBuf = null; f.execPos = 0;
      if (t.hasExec) f.phase = 'idle';
    }
    this.motor = s.motor; this.dmaEnable = s.dmaEnable; this.mode = s.mode;
    this.changed = [...s.changed];
    return this;
  }
}

export default Pc98Fdd;
