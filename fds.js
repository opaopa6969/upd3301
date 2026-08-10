// fds — the Famicom Disk System: the .fds disk image, the drive, and the
// RAM adapter's wavetable sound channel.
//
// The Disk System is not a cartridge. It is a RAM adapter that plugs into the
// cartridge slot (32KB of program RAM at $6000-$DFFF, 8KB of character RAM,
// an 8KB BIOS at $E000, a timer, and a sound channel) plus a drive that reads
// a Mitsumi Quick Disk. That is why it is "mapper 20" in the .nes numbering
// even though no such board exists: the number names the *adapter*, and the
// game arrives as data on a disk instead of as a ROM.
//
// Why this file exists at all: this machine has no .nes cartridges. It has
// 192 .fds images and the BIOS. Implementing the Disk System is what turns a
// library of zero into a library of 192 — see docs/nes-design.md §12.
//
// ## The image format, and what is missing from it
//
// A Quick Disk track is a single spiral of bits with no sectors. The data on
// it is a chain of BLOCKS, each preceded by a gap of zero bits and a single
// "start" bit, and followed by a CRC:
//
//   [ lead-in gap ][1][ block 1: disk header, 56 bytes ][CRC][ gap ][1]
//   [ block 2: file count, 2 bytes ][CRC][ gap ][1][ block 3: file header,
//   16 bytes ][CRC][ gap ][1][ block 4: file data, 1+N bytes ][CRC] ...
//
// The .fds format keeps **only the block bytes**. Gaps, start bits and CRCs
// are all gone — the format was designed to be the smallest thing a BIOS-level
// emulator needs, not a faithful flux image. So an emulator has two choices:
// regenerate the missing layer and run a free-running head over it, or model
// the drive at the level the image actually describes. This file does the
// second; `FdsDrive`'s header explains why, and what it costs.
//
// ## Contract
//
// Pure, dependency-free, deterministic, plain-data state. No Math.random, no
// DOM, no imports. Parsing never throws for the ordinary kinds of damage a
// twenty-year-old disk image collection contains — `tryParseFds()` answers
// with data, exactly like `tryParseINes()` does, because a file picker gets
// handed junk as a matter of course.

export const SCHEMA_VERSION = 1;

// One side of a Quick Disk holds 65500 bytes of block data in the .fds format.
// The physical side holds more (the gaps and CRCs this format drops), which is
// why the number is not a power of two.
export const SIDE_SIZE = 65500;
// Write-log keys are (side * this + position). Bigger than any side can be, so
// one flat Map can hold the writes to all of them.
const WRITE_KEY_STRIDE = 0x20000;
export const HEADER_SIZE = 16;
const MAGIC = [0x46, 0x44, 0x53, 0x1a]; // "FDS\x1a"

// The drive reads about 96.4 kbit/s, i.e. one byte per ~149 CPU cycles. Games
// do not measure this, but the BIOS's own timeouts do: too fast and a disk
// "loads" in one frame and the BIOS's disk-change animation never runs, too
// slow and the BIOS gives up with error 21.
export const BYTE_CYCLES = 149;
// The head has to physically return to the start of the spiral, and the BIOS
// waits for it. A short constant is enough: nothing measures the seek, but
// something has to separate "reset" from "first byte".
export const SEEK_CYCLES = 200;

export class FdsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FdsError';
    this.code = code;
  }
}

export function isFds(bytes) {
  if (!bytes || bytes.length < 4) return false;
  if (MAGIC.every((b, i) => bytes[i] === b)) return true;
  // Headerless images are common: some tools strip the 16 bytes because the
  // header carries nothing but a side count that the file length already
  // gives away. A whole number of sides that starts with a disk-info block is
  // the only signature such a file has.
  return bytes.length % SIDE_SIZE === 0 && bytes.length > 0 && looksLikeSide(bytes, 0);
}

function looksLikeSide(bytes, off) {
  if (bytes[off] !== 0x01) return false;
  const magic = '*NINTENDO-HVC*';
  for (let i = 0; i < magic.length; i++) {
    if (bytes[off + 1 + i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}

const ascii = (bytes, off, len) => {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = bytes[off + i];
    if (c === 0) break;
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
  }
  return s;
};

// ---------------------------------------------------------------------------
// Parsing
//
// The block chain is walked rather than trusted: the file-count byte in block
// 2 disagrees with the actual number of block 3/4 pairs on a fair number of
// real images (a disk that was written to has files the original count does
// not know about, and some dumps are padded). Walking stops at the first byte
// that is not a block-3 marker, which is also how the BIOS itself stops.

function parseSide(bytes, off, warnings, sideIndex) {
  const info = { ok: false, files: [], blocks: [], dataEnd: 0 };
  if (!looksLikeSide(bytes, off)) {
    warnings.push(`side ${sideIndex}: no *NINTENDO-HVC* disk header`);
    return info;
  }
  info.ok = true;
  info.maker = bytes[off + 15];
  info.gameName = ascii(bytes, off + 16, 3);
  info.gameType = String.fromCharCode(bytes[off + 19] || 0x20);
  info.revision = bytes[off + 20];
  info.sideNumber = bytes[off + 21];   // 0 = side A, 1 = side B
  info.diskNumber = bytes[off + 22];   // 0 = first disk of a multi-disk game
  info.bootFileId = bytes[off + 25];
  info.blocks.push({ off: 0, len: 56 });
  let p = off + 56;
  if (bytes[p] !== 0x02) {
    warnings.push(`side ${sideIndex}: no file-count block`);
    info.dataEnd = 56;
    return info;
  }
  info.declaredFiles = bytes[p + 1];
  info.blocks.push({ off: p - off, len: 2 });
  p += 2;
  const limit = off + SIDE_SIZE;
  while (p + 16 <= limit && bytes[p] === 0x03) {
    const size = bytes[p + 13] | (bytes[p + 14] << 8);
    const file = {
      number: bytes[p + 1],
      id: bytes[p + 2],
      name: ascii(bytes, p + 3, 8),
      addr: bytes[p + 11] | (bytes[p + 12] << 8),
      size,
      // 0 = PRG (loaded into adapter RAM), 1 = CHR, 2 = nametable
      kind: bytes[p + 15],
      offset: p - off,
    };
    if (bytes[p + 16] !== 0x04) {
      warnings.push(`side ${sideIndex}: file "${file.name}" has no data block`);
      break;
    }
    if (p + 17 + size > limit) {
      warnings.push(`side ${sideIndex}: file "${file.name}" runs past the end of the side`);
      break;
    }
    info.files.push(file);
    info.blocks.push({ off: p - off, len: 16 });
    info.blocks.push({ off: p - off + 16, len: 1 + size });
    p += 16 + 1 + size;
  }
  info.dataEnd = p - off;
  return info;
}

// Turn a stripped side into the byte stream the drive actually moves through
// its shift register: every block followed by its two CRC bytes.
//
// This is the one piece of the missing format layer that HAS to come back. The
// gaps do not (the drive here never runs through one — see FdsDrive), but the
// CRC does, because the BIOS reads it through $4031 like any other byte: after
// the 56 bytes of the disk header it takes two more transfers, and if those
// two are the first bytes of the next block then every block after the first
// arrives one and a half bytes out of step and the load fails. That is exactly
// the failure this emulator had before the CRC bytes were put back.
//
// The VALUES are zero. Nothing checks them: the drive computes the CRC on
// hardware and reports the verdict in $4030 bit 4, and a .fds image has no CRCs
// to verify, so that bit is never set.
function buildPhysical(side, blocks) {
  const phys = new Uint8Array(SIDE_SIZE + blocks.length * 2);
  let sp = 0, pp = 0;
  for (const b of blocks) {
    const end = b.off + b.len;
    phys.set(side.subarray(sp, end), pp);
    pp += end - sp;
    sp = end;
    pp += 2; // CRC, left at zero
  }
  phys.set(side.subarray(sp), pp);
  return phys;
}

// The inverse: drop the CRC bytes again, so a disk that a game wrote to can be
// saved back out as an ordinary .fds file.
export function exportFds(image, drive = null) {
  const out = new Uint8Array(HEADER_SIZE + image.sideCount * SIDE_SIZE);
  out.set(MAGIC, 0);
  out[4] = image.sideCount;
  for (let s = 0; s < image.sideCount; s++) {
    const phys = drive ? drive.sides[s] : image.physical[s];
    const blocks = image.info[s].blocks;
    const base = HEADER_SIZE + s * SIDE_SIZE;
    let sp = 0, pp = 0;
    for (const b of blocks) {
      const end = b.off + b.len;
      out.set(phys.subarray(pp, pp + (end - sp)), base + sp);
      pp += end - sp; sp = end; pp += 2;
    }
    out.set(phys.subarray(pp, pp + (SIDE_SIZE - sp)), base + sp);
  }
  return out;
}

// Throws FdsError. Callers that are handed user files want tryParseFds().
export function parseFds(bytes) {
  if (!bytes || bytes.length < SIDE_SIZE / 2) {
    throw new FdsError('too-short', `not an FDS image: ${bytes ? bytes.length : 0} bytes`);
  }
  const hasHeader = MAGIC.every((b, i) => bytes[i] === b);
  const warnings = [];
  let body = hasHeader ? bytes.subarray(HEADER_SIZE) : bytes;
  let declaredSides = hasHeader ? bytes[4] : 0;

  let sideCount = Math.floor(body.length / SIDE_SIZE);
  if (sideCount === 0) throw new FdsError('too-short', `FDS image holds no complete side (${body.length} bytes)`);
  if (hasHeader && declaredSides && declaredSides !== sideCount) {
    // The header lies on plenty of images (it was often written by hand).
    // Trust the length, say so, and carry on.
    warnings.push(`header says ${declaredSides} sides, the file holds ${sideCount}`);
  }
  if (body.length % SIDE_SIZE !== 0) {
    warnings.push(`${body.length % SIDE_SIZE} trailing bytes after the last side (ignored)`);
  }
  if (sideCount > 8) {
    warnings.push(`${sideCount} sides is more than any real title; using the first 8`);
    sideCount = 8;
  }

  const sides = [];
  const info = [];
  for (let s = 0; s < sideCount; s++) {
    // A copy, not a view: the drive writes to these, and the caller's buffer
    // (often the whole file, often shared) must not change under it.
    const side = new Uint8Array(SIDE_SIZE);
    side.set(body.subarray(s * SIDE_SIZE, (s + 1) * SIDE_SIZE));
    sides.push(side);
    info.push(parseSide(side, 0, warnings, s));
  }
  const usable = info.filter((i) => i.ok).length;
  if (usable === 0) throw new FdsError('no-disk-header', 'no side carries a *NINTENDO-HVC* disk header');
  const physical = sides.map((s, i) => buildPhysical(s, info[i].blocks));

  return {
    schemaVersion: SCHEMA_VERSION,
    hasHeader, sideCount, sides, physical, info, warnings,
    gameName: info[0].gameName || '',
    maker: info[0].maker || 0,
  };
}

// Never throws. `{ ok:true, image }` or `{ ok:false, code, error }`.
export function tryParseFds(bytes) {
  try {
    return { ok: true, image: parseFds(bytes) };
  } catch (e) {
    if (e instanceof FdsError) return { ok: false, code: e.code, error: e.message };
    return { ok: false, code: 'parse-failed', error: String(e && e.message ? e.message : e) };
  }
}

export function summarizeFds(image) {
  return {
    game: image.gameName,
    sides: image.sideCount,
    files: image.info.map((i) => i.files.length),
    warnings: image.warnings,
  };
}

// Build an image in memory, so tests never need a copyrighted disk. `sides` is
// an array of arrays of { name, addr, size|data, kind, id }.
export function buildFds({ sides = [[]], gameName = 'TST', maker = 0x01, header = true } = {}) {
  const out = new Uint8Array((header ? HEADER_SIZE : 0) + sides.length * SIDE_SIZE);
  if (header) {
    out.set(MAGIC, 0);
    out[4] = sides.length;
  }
  sides.forEach((files, s) => {
    const base = (header ? HEADER_SIZE : 0) + s * SIDE_SIZE;
    out[base] = 0x01;
    for (let i = 0; i < 14; i++) out[base + 1 + i] = '*NINTENDO-HVC*'.charCodeAt(i);
    out[base + 15] = maker;
    for (let i = 0; i < 3; i++) out[base + 16 + i] = gameName.charCodeAt(i) || 0x20;
    out[base + 19] = 0x20;
    out[base + 21] = s & 1;         // side
    out[base + 22] = s >> 1;        // disk
    out[base + 25] = files.length;  // boot file count
    let p = base + 56;
    out[p] = 0x02; out[p + 1] = files.length; p += 2;
    files.forEach((f, n) => {
      const data = f.data || new Uint8Array(f.size || 0);
      out[p] = 0x03;
      out[p + 1] = n;
      out[p + 2] = f.id ?? n;
      const nm = (f.name || `FILE${n}`).padEnd(8, ' ');
      for (let i = 0; i < 8; i++) out[p + 3 + i] = nm.charCodeAt(i);
      out[p + 11] = (f.addr || 0) & 0xff;
      out[p + 12] = ((f.addr || 0) >> 8) & 0xff;
      out[p + 13] = data.length & 0xff;
      out[p + 14] = (data.length >> 8) & 0xff;
      out[p + 15] = f.kind ?? 0;
      p += 16;
      out[p] = 0x04;
      out.set(data, p + 1);
      p += 1 + data.length;
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// The drive
//
// ## Why the head does not free-run
//
// On hardware the disk spins whether or not anyone is listening, and the BIOS
// finds the next block by waiting for a start bit in the gap. The .fds format
// deleted the gaps, so a free-running head has nothing to wait *in*: between
// two blocks it would keep consuming bytes of the NEXT block while the BIOS is
// busy handling the previous one, and the disk would desynchronise. The usual
// answer is to regenerate the missing layer — insert 3537 zero bytes of
// lead-in, 122 between blocks, a 0x80 start byte and two CRC bytes — and then
// free-run over that. That works, but it makes the emulator's correctness
// depend on the gap sizes being right for every BIOS timeout, and the gap
// sizes are not in the image.
//
// This drive instead advances the head exactly when the CPU moves a byte
// through it: a read of $4031 in read mode, a write to $4024 in write mode.
// The byte CLOCK is still real — the transfer flag and its IRQ arrive
// BYTE_CYCLES after the previous byte, which is what paces the BIOS's transfer
// loop — but the head cannot run away from the program, so a block boundary
// can never be lost. The cost is honest and worth writing down: a game that
// times the drive by counting cycles instead of by watching $4030 would see a
// drive that waits for it. No known title does that (the BIOS owns the drive),
// and this is the model FCEUX has shipped for two decades.
//
// ## The CRC phase
//
// The two CRC bytes at the end of every block ARE in the stream this drive
// runs over — `buildPhysical()` above puts them back — because the BIOS reads
// them through $4031 exactly like data. Without them the head arrives at the
// next block two bytes early and the BIOS rejects it. What is NOT modelled is
// the CRC itself: $4030 bit 4 never reports an error, because a .fds image
// carries no CRCs that could be wrong.

export class FdsDrive {
  constructor(image) {
    this.image = image;
    this.sideCount = image ? image.sideCount : 0;
    // The drive's view of the media. Writes land here; `writes` records them
    // so a snapshot can carry the difference without carrying the disk.
    this.sides = image ? image.physical.map((s) => s.slice()) : [];
    this.writes = new Map(); // (side * WRITE_KEY_STRIDE + pos) -> byte
    this.side = 0;
    this.inserted = this.sideCount > 0;
    this.writeProtected = false;
    this.reset();
  }

  reset() {
    this.pos = 0;
    this.motorOn = false;
    this.resetTransfer = true;
    this.readMode = true;
    this.crcControl = false;
    this.rwStart = false;
    this.irqOnTransfer = false;
    this.transferFlag = false;
    this.diskIrq = false;
    this.endOfDisk = false;
    this.seekDelay = 0;
    this.writeSkip = 0;
    this.readLatch = 0;
    this.writeLatch = 0;
    this.byteReady = false;
  }

  // ---- media ---------------------------------------------------------------
  // Eject/insert is a real event to the BIOS: a game that asks for side B
  // polls $4032 bit 0 until the disk goes away and comes back. So a side change
  // is modelled as eject-then-insert rather than as a silent swap, and the
  // machine's `setDiskSide()` can hold the gap open for a few frames.
  eject() { this.inserted = false; this.pos = 0; this.endOfDisk = false; return this; }

  insert(side = this.side) {
    if (this.sideCount === 0) return this;
    this.side = ((side % this.sideCount) + this.sideCount) % this.sideCount;
    this.inserted = true;
    this.pos = 0;
    this.endOfDisk = false;
    return this;
  }

  get data() { return this.sides[this.side]; }

  // ---- the byte clock ------------------------------------------------------
  // One CPU cycle. The only thing that happens on a schedule is the transfer
  // flag; the head itself moves in _advance(), driven by the CPU.
  tick() {
    if (this.seekDelay > 0 && --this.seekDelay === 0) {
      this.transferFlag = true;
      this.byteReady = true;
      if (this.irqOnTransfer) this.diskIrq = true;
    }
  }

  scanning() { return this.inserted && this.motorOn && !this.resetTransfer; }

  _schedule() {
    this.transferFlag = false;
    this.diskIrq = false;
    this.byteReady = false;
    this.seekDelay = BYTE_CYCLES;
  }

  _advance() {
    if (this.pos + 1 >= this.data.length) { this.endOfDisk = true; this.seekDelay = 0; return; }
    this.pos++;
  }

  // $4031 is a LATCH, not a port that pulls the next byte off the disk. Reading
  // it when no byte has arrived has to give the last one back and leave the
  // head where it is — the FDS BIOS reads $4031 from its NMI handler on every
  // frame it spends waiting for vblank, and an emulator that advances the head
  // on every read walks the disk forward one byte per frame behind the
  // program's back. That is a desynchronisation with no symptom until, tens of
  // thousands of bytes later, a block starts in the wrong place.
  readData() {
    if (!this.inserted) return this.readLatch;
    if (!(this.byteReady && this.scanning() && this.rwStart && this.readMode)) {
      this.transferFlag = false;
      this.diskIrq = false;
      return this.readLatch;
    }
    const v = this.data[this.pos];
    this.readLatch = v;
    this._advance();
    this._schedule();
    return v;
  }

  writeData(value) {
    this.writeLatch = value & 0xff;
    if (!this.inserted || this.readMode) return;
    if (!this.byteReady || !this.scanning() || !this.rwStart) { this.transferFlag = false; this.diskIrq = false; return; }
    if (this.writeSkip > 0) {
      // Swallowed without moving the head — the mark was never in the stream —
      // but it still costs a byte period, so the clock has to restart or the
      // BIOS never gets its next transfer flag.
      this.writeSkip--;
      this._schedule();
      return;
    }
    if (!this.writeProtected) {
      // The CRC slots get written too. Their contents do not matter (nothing
      // verifies them) but their POSITIONS do, so writing through them is what
      // keeps a rewritten block the same length as the one it replaced.
      const off = this.side * WRITE_KEY_STRIDE + this.pos;
      this.data[this.pos] = this.writeLatch;
      this.writes.set(off, this.writeLatch);
    }
    this._advance();
    this._schedule();
  }

  // $4025.
  control(value) {
    this.motorOn = (value & 0x01) !== 0;
    const wasReset = this.resetTransfer;
    this.resetTransfer = (value & 0x02) !== 0;
    const wasRead = this.readMode;
    this.readMode = (value & 0x04) !== 0;
    const wasCrc = this.crcControl;
    this.crcControl = (value & 0x10) !== 0;
    const wasStart = this.rwStart;
    this.rwStart = (value & 0x40) !== 0;
    this.irqOnTransfer = (value & 0x80) !== 0;
    this.diskIrq = false;

    if (this.resetTransfer && !wasReset) {
      this.pos = 0;
      this.endOfDisk = false;
      this.seekDelay = SEEK_CYCLES;
    }
    // The first byte the BIOS pushes through $4024 after switching to write
    // mode is $80 — the block's START MARK, which is a single bit on the
    // physical disk and has no byte in a .fds image. Measured, not guessed:
    // 光神話パルテナの鏡 rewriting a file header writes $80, then $03 (the
    // block ID), then the name, and the stream underneath holds $03 at the
    // position the $80 arrived at. So the mark is swallowed *without moving
    // the head*, and every byte after it lands where it belongs.
    //
    // Getting this wrong is invisible until a game saves, and then it is not
    // subtle: the BIOS reads the block back to verify it, the compare fails
    // one byte in, and it rewrites forever. That is what Kid Icarus does on a
    // drive that lets the start mark consume a byte of the stream.
    // Ending a written block: the drive emits the CRC itself. The BIOS pushes
    // the first of the two CRC bytes through $4024 like any other byte and then
    // raises bit 4, and the hardware supplies the second — so the head has one
    // more slot to cross that no $4024 write will account for. Counted against
    // the real BIOS: without this the NEXT block starts one byte early, which
    // is invisible on the write itself and fatal on the verify.
    if (this.crcControl && !wasCrc && !this.readMode && this.rwStart && this.scanning()) this._advance();
    if (wasRead && !this.readMode) this.writeSkip = 1;
    if (this.rwStart && !wasStart) {
      // The head is being let loose on the next block. Give the BIOS its first
      // transfer flag after a seek's worth of gap rather than immediately.
      this.transferFlag = false;
      this.seekDelay = SEEK_CYCLES;
    }
    if (!this.rwStart) { this.seekDelay = 0; this.transferFlag = false; this.byteReady = false; }
    if (!this.motorOn) { this.seekDelay = 0; this.transferFlag = false; this.byteReady = false; }
  }

  // $4032. Every bit is "NOT ready" — the BIOS polls for zeroes.
  driveStatus() {
    let v = 0x40; // bits 3-7 read back as open bus on hardware; $40 is what sticks
    if (!this.inserted) v |= 0x05;      // no disk, and therefore not ready
    else {
      if (!this.scanning()) v |= 0x02;  // motor off or head held at the start
      if (this.writeProtected) v |= 0x04;
    }
    return v;
  }

  getState() {
    // The disk itself is immutable input, like PRG-ROM: it stays in the parsed
    // image and is never copied into a snapshot. What travels is the DIFFERENCE
    // a save game made — typically a few hundred bytes, and nothing at all for
    // the overwhelming majority of titles, which never write.
    const offs = new Int32Array(this.writes.size);
    const vals = new Uint8Array(this.writes.size);
    let i = 0;
    for (const [k, v] of this.writes) { offs[i] = k; vals[i] = v; i++; }
    return {
      side: this.side, inserted: this.inserted, pos: this.pos,
      motorOn: this.motorOn, resetTransfer: this.resetTransfer, readMode: this.readMode,
      crcControl: this.crcControl, rwStart: this.rwStart, irqOnTransfer: this.irqOnTransfer,
      transferFlag: this.transferFlag, diskIrq: this.diskIrq, endOfDisk: this.endOfDisk,
      seekDelay: this.seekDelay, writeSkip: this.writeSkip, byteReady: this.byteReady,
      readLatch: this.readLatch, writeLatch: this.writeLatch,
      writeProtected: this.writeProtected,
      writeOffs: offs, writeVals: vals,
    };
  }

  setState(s) {
    // Roll the media back by difference, not by copy: undo the writes that are
    // not in the snapshot, then apply the ones that are. A rewind ring cannot
    // afford a 65500-byte memcpy per side per frame, and it does not need one.
    const want = new Map();
    const offs = s.writeOffs || [], vals = s.writeVals || [];
    for (let i = 0; i < offs.length; i++) want.set(offs[i], vals[i]);
    for (const off of this.writes.keys()) {
      if (!want.has(off)) {
        const side = (off / WRITE_KEY_STRIDE) | 0, p = off % WRITE_KEY_STRIDE;
        if (this.sides[side]) this.sides[side][p] = this.image.physical[side][p];
      }
    }
    for (const [off, v] of want) {
      const side = (off / WRITE_KEY_STRIDE) | 0, p = off % WRITE_KEY_STRIDE;
      if (this.sides[side]) this.sides[side][p] = v;
    }
    this.writes = want;

    this.side = s.side; this.inserted = s.inserted; this.pos = s.pos;
    this.motorOn = s.motorOn; this.resetTransfer = s.resetTransfer; this.readMode = s.readMode;
    this.crcControl = s.crcControl; this.rwStart = s.rwStart; this.irqOnTransfer = s.irqOnTransfer;
    this.transferFlag = s.transferFlag; this.diskIrq = s.diskIrq; this.endOfDisk = s.endOfDisk;
    this.seekDelay = s.seekDelay; this.writeSkip = s.writeSkip; this.byteReady = !!s.byteReady;
    this.readLatch = s.readLatch; this.writeLatch = s.writeLatch;
    this.writeProtected = s.writeProtected;
    return this;
  }
}

// ---------------------------------------------------------------------------
// The sound channel
//
// The RAM adapter carries one extra voice, and it is the strangest one on the
// console: a 64-step wavetable at 6 bits per step, played back at a frequency
// that a SECOND wavetable — the modulation table — bends up and down while it
// plays. That is where the Disk System's characteristic wobble comes from
// (Zelda's title, Metroid's caves, Kid Icarus).
//
// The modulator is not a smooth LFO. It is a 32-entry table of five-way steps
// (+1, +2, +4, reset, -4, -2, -1) driving a signed 7-bit counter, and the
// counter is then folded into a pitch offset by an integer algorithm with two
// deliberate asymmetries (the +2/-1 rounding and the 192/-64 wrap). Emulating
// it as "add a sine" gets the wobble roughly right and the timbre entirely
// wrong, so the integer algorithm is reproduced exactly as documented.
//
// Clocked from the CPU, one tick per cycle, exactly like nesapu.js: this
// channel is on the same clock as the 2A03 and its output is summed into the
// same mixer (see nesapu's `expansion` hook).

const MOD_STEPS = [0, 1, 2, 4, 0, -4, -2, -1]; // index 4 means "reset to zero"

export class FdsAudio {
  constructor() {
    this.wave = new Uint8Array(64);
    this.mod = new Uint8Array(32);
    this.powerOn();
  }

  powerOn() {
    this.wave.fill(0);
    this.mod.fill(0);
    this.waveWriteEnable = false;
    this.masterVolume = 0;      // 0..3 -> 2/2, 2/3, 2/4, 2/5
    this.envSpeed = 0xff;       // $408A
    this.halt = true;           // $4083 bit 7
    this.envDisable = true;     // $4083 bit 6
    this.freq = 0;
    this.wavePhase = 0;
    this.wavePos = 0;

    this.volGain = 0; this.volSpeed = 0; this.volIncrease = false; this.volEnvDisable = true;
    this.volTimer = 0;
    this.modGain = 0; this.modSpeed = 0; this.modIncrease = false; this.modEnvDisable = true;
    this.modTimer = 0;

    this.modFreq = 0;
    this.modHalt = true;
    this.modPhase = 0;
    this.modPos = 0;
    this.modCounter = 0;        // signed 7-bit
    this.out = 0;
    return this;
  }

  reset() { return this; } // a reset does not clear the adapter's sound state

  write(addr, value) {
    const a = addr & 0xff;
    if (a >= 0x40 && a < 0x80) {
      // Wave RAM is only writable while the channel is held in "write" mode;
      // a game that forgets to set $4089 bit 7 gets its upload silently
      // dropped on hardware, and must get it dropped here too.
      if (this.waveWriteEnable) this.wave[a - 0x40] = value & 0x3f;
      return;
    }
    switch (a) {
      case 0x80: // volume envelope
        this.volEnvDisable = (value & 0x80) !== 0;
        this.volIncrease = (value & 0x40) !== 0;
        this.volSpeed = value & 0x3f;
        if (this.volEnvDisable) this.volGain = value & 0x3f;
        this.volTimer = (this.volSpeed + 1) * 8;
        break;
      case 0x82: this.freq = (this.freq & 0xf00) | (value & 0xff); break;
      case 0x83:
        this.freq = (this.freq & 0x0ff) | ((value & 0x0f) << 8);
        this.halt = (value & 0x80) !== 0;
        this.envDisable = (value & 0x40) !== 0;
        if (this.halt) { this.wavePhase = 0; this.wavePos = 0; }
        if (this.envDisable) { this.volTimer = (this.volSpeed + 1) * 8; this.modTimer = (this.modSpeed + 1) * 8; }
        break;
      case 0x84: // modulation envelope
        this.modEnvDisable = (value & 0x80) !== 0;
        this.modIncrease = (value & 0x40) !== 0;
        this.modSpeed = value & 0x3f;
        if (this.modEnvDisable) this.modGain = value & 0x3f;
        this.modTimer = (this.modSpeed + 1) * 8;
        break;
      case 0x85:
        this.modCounter = (value & 0x7f) << 25 >> 25; // sign-extend 7 bits
        this.modPhase = 0;
        break;
      case 0x86: this.modFreq = (this.modFreq & 0xf00) | (value & 0xff); break;
      case 0x87:
        this.modFreq = (this.modFreq & 0x0ff) | ((value & 0x0f) << 8);
        this.modHalt = (value & 0x80) !== 0;
        if (this.modHalt) this.modPhase = 0;
        break;
      case 0x88: // push two entries onto the modulation table
        if (this.modHalt) {
          this.mod[this.modPos & 31] = value & 7;
          this.mod[(this.modPos + 1) & 31] = value & 7;
          this.modPos = (this.modPos + 2) & 31;
        }
        break;
      case 0x89:
        this.masterVolume = value & 3;
        this.waveWriteEnable = (value & 0x80) !== 0;
        break;
      case 0x8a:
        this.envSpeed = value & 0xff;
        break;
      default: break;
    }
  }

  read(addr) {
    const a = addr & 0xff;
    if (a >= 0x40 && a < 0x80) return this.wave[a - 0x40] | 0x40;
    if (a === 0x90) return (this.volGain & 0x3f) | 0x40;
    if (a === 0x92) return (this.modGain & 0x3f) | 0x40;
    return -1; // "not mine" — the caller falls back to open bus
  }

  // The documented integer pitch bend. Every asymmetry here is load-bearing:
  // the rounding step adds +2 going up and -1 going down, and the fold points
  // are 192 and -64, not +-128. Replacing either with the "obvious" symmetric
  // version detunes the wobble by a few cents in one direction only, which is
  // audible as the vibrato leaning sharp.
  _pitchOffset() {
    let temp = this.modCounter * this.modGain;
    const remainder = temp & 0x0f;
    temp >>= 4;
    if (remainder > 0 && (temp & 0x80) === 0) temp += this.modCounter < 0 ? -1 : 2;
    if (temp >= 192) temp -= 256;
    else if (temp < -64) temp += 256;
    temp = (this.freq * temp) / 64;
    return temp < 0 ? Math.ceil(temp) : Math.floor(temp);
  }

  _clockModulator() {
    if (this.modHalt || this.modFreq === 0) return;
    this.modPhase += this.modFreq;
    while (this.modPhase >= 0x10000) {
      this.modPhase -= 0x10000;
      const step = this.mod[this.modPos];
      if (step === 4) this.modCounter = 0;
      else this.modCounter = ((this.modCounter + MOD_STEPS[step]) & 0x7f) << 25 >> 25;
      this.modPos = (this.modPos + 1) & 31;
    }
  }

  _clockEnvelopes() {
    // Both envelopes are held while the channel is halted, and $408A scales
    // both of their periods: an "envelope speed" of 0 stops them dead, which
    // is how a game freezes a sweep mid-flight.
    if (this.envDisable || this.envSpeed === 0) return;
    if (!this.volEnvDisable) {
      if (--this.volTimer <= 0) {
        this.volTimer = (this.volSpeed + 1) * 8 * this.envSpeed / 8 | 0 || 1;
        if (this.volIncrease) { if (this.volGain < 32) this.volGain++; }
        else if (this.volGain > 0) this.volGain--;
      }
    }
    if (!this.modEnvDisable) {
      if (--this.modTimer <= 0) {
        this.modTimer = (this.modSpeed + 1) * 8 * this.envSpeed / 8 | 0 || 1;
        if (this.modIncrease) { if (this.modGain < 32) this.modGain++; }
        else if (this.modGain > 0) this.modGain--;
      }
    }
  }

  tick() {
    this._clockEnvelopes();
    this._clockModulator();
    if (!this.halt && this.freq > 0) {
      const pitch = this.freq + this._pitchOffset();
      this.wavePhase += pitch > 0 ? pitch : 0;
      while (this.wavePhase >= 0x10000) {
        this.wavePhase -= 0x10000;
        this.wavePos = (this.wavePos + 1) & 63;
      }
    }
    // While the CPU is allowed to write wave RAM the DAC is disconnected and
    // holds its last level; without that, a game uploading a new waveform
    // sprays the old table's noise through the speaker.
    if (!this.waveWriteEnable) {
      const gain = this.volGain > 32 ? 32 : this.volGain;
      this.out = this.wave[this.wavePos] * gain;
    }
  }

  // Scaled into the same units nesapu.js mixes in (roughly 0..1 for the whole
  // 2A03). The Disk System's channel is loud — on hardware it is summed
  // through a different resistor than the 2A03's own mix and comes out at
  // comparable level. The constant below is an ear-free estimate; nobody has
  // listened to it (docs/nes-design.md §12).
  get output() {
    const MASTER = [1.0, 2 / 3, 2 / 4, 2 / 5];
    return (this.out / (63 * 32)) * MASTER[this.masterVolume] * 0.38;
  }

  getState() {
    return {
      wave: this.wave.slice(), mod: this.mod.slice(),
      n: [
        this.waveWriteEnable ? 1 : 0, this.masterVolume, this.envSpeed,
        this.halt ? 1 : 0, this.envDisable ? 1 : 0, this.freq, this.wavePhase, this.wavePos,
        this.volGain, this.volSpeed, this.volIncrease ? 1 : 0, this.volEnvDisable ? 1 : 0, this.volTimer,
        this.modGain, this.modSpeed, this.modIncrease ? 1 : 0, this.modEnvDisable ? 1 : 0, this.modTimer,
        this.modFreq, this.modHalt ? 1 : 0, this.modPhase, this.modPos, this.modCounter, this.out,
      ],
    };
  }

  setState(s) {
    this.wave.set(s.wave); this.mod.set(s.mod);
    const a = s.n;
    this.waveWriteEnable = !!a[0]; this.masterVolume = a[1]; this.envSpeed = a[2];
    this.halt = !!a[3]; this.envDisable = !!a[4]; this.freq = a[5]; this.wavePhase = a[6]; this.wavePos = a[7];
    this.volGain = a[8]; this.volSpeed = a[9]; this.volIncrease = !!a[10]; this.volEnvDisable = !!a[11]; this.volTimer = a[12];
    this.modGain = a[13]; this.modSpeed = a[14]; this.modIncrease = !!a[15]; this.modEnvDisable = !!a[16]; this.modTimer = a[17];
    this.modFreq = a[18]; this.modHalt = !!a[19]; this.modPhase = a[20]; this.modPos = a[21]; this.modCounter = a[22];
    this.out = a[23];
    return this;
  }
}

// ---------------------------------------------------------------------------
// A Disk System "cartridge": what the machine needs so that a .fds image can
// travel down exactly the same path an .nes cartridge does. The BIOS takes the
// place of PRG-ROM (it is the program that runs at reset), the adapter's 32KB
// is the work RAM, and the disk rides along as `disk`.
//
// The BIOS is not in this repository and never will be — see
// docs/nes-design.md §12 for where to get it and how to check it.
export function makeFdsCart(image, bios) {
  if (!bios || bios.length !== 8192) {
    throw new FdsError('bad-bios', `the FDS BIOS must be 8192 bytes (got ${bios ? bios.length : 0})`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    format: 'fds',
    mapper: 20,
    prg: bios instanceof Uint8Array ? bios : new Uint8Array(bios),
    chr: null,
    chrRam: 8192,
    prgRam: 32768,
    battery: true,
    mirroring: 'horizontal',
    trainer: null,
    disk: image,
    warnings: image.warnings.slice(),
    name: image.gameName,
  };
}
