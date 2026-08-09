// upd7220 — NEC's µPD7220 Graphics Display Controller.
//
// The chip that made the PC-9801 what it was. Where the µPD3301 in this
// repository is a text-only CRTC that shovels characters out of DMA, the 7220
// generates the video timing AND draws: it has an arithmetic unit that walks
// lines, arcs and rectangles through video memory on its own, and a command
// FIFO the CPU talks to through two ports.
//
// A PC-9801 has TWO of them, which is the thing to hold on to while reading
// this file. GDC1 (the "master") scans the text plane and is the one that
// actually produces HSYNC and VSYNC for the board. GDC2 (the "slave") scans
// the graphics planes and is locked to the master's sync. They are the same
// part with different parameters, so this file knows nothing about which is
// which — `master: true` only changes which of them claims to drive sync.
//
// ## The two address spaces
//
// The GDC addresses video memory in 16-bit WORDS (18 bits of EAD) plus a
// 4-bit dot address (dAD) that selects a bit inside the word. Drawing walks
// (EAD, dAD); the CPU-facing read/write commands walk EAD alone. Everything
// here is in those units — turning them into a PC-9801 plane offset is
// pc98video.js's job, through the injected memory interface.
//
// The interface is:
//   { read(ead), write(ead, data, mask) }
// where `data` and `mask` are 16-bit and only the masked bits are written.
// That is exactly the shape of the chip's own bus cycle, and it is what lets
// the machine put the GRCG in the path without this file knowing.
//
// Pure, deterministic, zero deps.

export const SCHEMA_VERSION = 1;

// Status register bits, as the CPU reads them from the low port.
export const ST = {
  DRDY: 0x01,     // read data ready
  FULL: 0x02,     // FIFO full
  EMPTY: 0x04,    // FIFO empty
  DRAW: 0x08,     // drawing in progress
  DMA: 0x10,      // DMA execute
  VSYNC: 0x20,    // vertical sync active
  HBLANK: 0x40,   // horizontal blanking active
  LPEN: 0x80,     // light pen detected
};

// The eight drawing directions. Each octant is bounded by one axis direction
// and one 45-degree direction; the GDC always steps along the AXIS and adds the
// perpendicular when the error term says so, so both are needed per octant.
const DIR_DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DIR_DY = [1, 1, 0, -1, -1, -1, 0, 1];

// 14-bit two's complement — the width of the figure-drawing parameters.
const s14 = (v) => ((v & 0x3fff) ^ 0x2000) - 0x2000;

export class Upd7220 {
  constructor({ mem = null, master = false, name = 'gdc' } = {}) {
    this.mem = mem || { read: () => 0, write: () => {} };
    this.master = !!master;
    this.name = name;
    this.reset();
  }

  reset() {
    this.params = [];          // parameter bytes for the command in progress
    this.cmd = -1;             // command byte, or -1 when idle
    this.fifo = [];            // bytes waiting to be read back (RDAT, CURD)
    this.status = ST.EMPTY;

    // Sync parameters. The defaults are the PC-9801's 640x400 text screen so
    // that a machine which never programs the chip still has a geometry.
    this.displayEnabled = false;
    this.syncMode = 0;         // the RESET/SYNC command's P1
    this.hs = 0; this.vs = 0; this.hfp = 0; this.hbp = 0; this.vfp = 0; this.vbp = 0;
    this.aw = 80;              // active display words per line
    this.al = 400;             // active display lines
    this.pitch = 80;           // words per line in memory

    // Parameter RAM: four display partitions of four bytes each. In graphics
    // mode the upper eight bytes double as the graphics-character pattern.
    this.pram = new Uint8Array(16);
    this.pramPtr = 0;

    // Cursor and character characteristics.
    this.ead = 0; this.dad = 0;
    this.lr = 15;              // lines per character row - 1
    this.blinkRate = 0;
    this.cursorOn = false;
    this.cursorTop = 0; this.cursorBottom = 15;
    this.blinkCounter = 0;

    this.zoomDisplay = 0; this.zoomWrite = 0;
    this.mask = 0xffff;
    this.mod = 0;              // WDAT/FIGD write mode: replace/complement/reset/set

    // FIGS
    this.figDir = 0; this.figType = 0;
    this.dc = 0; this.d = 0; this.d2 = 0; this.d1 = 0; this.dm = 0;
    this.figDrawn = 0;

    // Transfer state for WDAT/RDAT.
    this.rwType = 0;           // 0/1 = word, 2 = low byte, 3 = high byte
    this.rwCount = 0;
    this.wdatLow = 0; this.wdatHave = 0;

    this.vsyncActive = false;
    this.hblankActive = false;
    this.lastDrawn = 0;        // dots drawn by the last figure, for tests
    return this;
  }

  setMemory(mem) { this.mem = mem; return this; }

  // ---- the two ports ---------------------------------------------------------
  // Even port: status on read, parameter on write. Odd port: FIFO on read,
  // command on write. On the PC-9801 they are $60/$62 and $A0/$A2.
  readStatus() {
    let s = this.status & ~(ST.VSYNC | ST.HBLANK | ST.EMPTY | ST.FULL | ST.DRDY);
    if (this.vsyncActive) s |= ST.VSYNC;
    if (this.hblankActive) s |= ST.HBLANK;
    if (this.fifo.length === 0) s |= ST.EMPTY;
    else s |= ST.DRDY;
    if (this.fifo.length >= 16) s |= ST.FULL;
    return s & 0xff;
  }

  readFifo() {
    if (!this.fifo.length) return 0xff;
    const v = this.fifo.shift();
    // A word-wide RDAT keeps refilling from memory as the CPU drains the FIFO,
    // which is how a screen dump reads more than sixteen bytes.
    if (this.fifo.length === 0 && this.rwCount > 0) this._rdatFill();
    return v & 0xff;
  }

  writeParam(v) {
    v &= 0xff;
    if (this.cmd < 0) return;          // a parameter with no command is dropped
    this.params.push(v);
    this._tryExecute(false);
  }

  writeCommand(v) {
    v &= 0xff;
    // A new command byte abandons whatever was still collecting parameters —
    // the chip has one command register, not a queue of them.
    this.cmd = v;
    this.params.length = 0;
    this.wdatHave = 0;
    this._tryExecute(true);
  }

  // ---- command dispatch ------------------------------------------------------
  // Commands take a fixed or variable number of parameters. The variable ones
  // (FIGS, PRAM, WDAT) act on each parameter as it arrives, so `immediate` is
  // only about the zero-parameter commands.
  _tryExecute(fresh) {
    const c = this.cmd, p = this.params;
    switch (c) {
      case 0x00:                                   // RESET
      case 0x0e: case 0x0f:                        // SYNC (display off / on)
        if (c !== 0x00) this.displayEnabled = (c & 1) !== 0;
        if (fresh && c === 0x00) this._resetOnCommand();
        if (p.length >= 8) { this._applySync(p); this.cmd = -1; }
        return;

      case 0x0c: case 0x0d:                        // BCTRL: blank / unblank
        this.displayEnabled = (c & 1) !== 0;
        this.cmd = -1; return;

      case 0x6b:                                   // START: display on
        this.displayEnabled = true;
        this.cmd = -1; return;

      case 0x6e: case 0x6f:                        // VSYNC: slave / master
        this.master = (c & 1) !== 0;
        this.cmd = -1; return;

      case 0x46:                                   // ZOOM
        if (p.length >= 1) {
          this.zoomDisplay = (p[0] >> 4) & 0x0f;
          this.zoomWrite = p[0] & 0x0f;
          this.cmd = -1;
        }
        return;

      case 0x47:                                   // PITCH
        if (p.length >= 1) { this.pitch = p[0] || 1; this.cmd = -1; }
        return;

      case 0x49:                                   // CURS: set the drawing address
        if (p.length >= 1) this.ead = (this.ead & 0x3ff00) | p[0];
        if (p.length >= 2) this.ead = (this.ead & 0x300ff) | (p[1] << 8);
        if (p.length >= 3) {
          this.ead = (this.ead & 0x0ffff) | ((p[2] & 0x03) << 16);
          this.dad = (p[2] >> 4) & 0x0f;
          this.cmd = -1;
        }
        return;

      case 0x4a:                                   // MASK
        if (p.length >= 2) { this.mask = (p[0] | (p[1] << 8)) & 0xffff; this.cmd = -1; }
        return;

      case 0x4b:                                   // CCHAR
        if (p.length >= 1) {
          this.lr = p[0] & 0x1f;
          this.cursorOn = (p[0] & 0x80) !== 0;
        }
        if (p.length >= 2) {
          this.blinkRate = (this.blinkRate & 0x1c) | ((p[1] >> 6) & 3);
          this.cursorTop = p[1] & 0x1f;
        }
        if (p.length >= 3) {
          this.blinkRate = ((p[2] & 0x07) << 2) | (this.blinkRate & 3);
          this.cursorBottom = (p[2] >> 3) & 0x1f;
          this.cmd = -1;
        }
        return;

      case 0x4c: this._figs(); return;             // FIGS
      case 0x6c: this._figd(); this.cmd = -1; return;  // FIGD
      case 0x68: this._gchrd(); this.cmd = -1; return; // GCHRD

      case 0xe0:                                   // CURD: read back the address
        this.fifo.push(this.ead & 0xff, (this.ead >> 8) & 0xff,
          ((this.ead >> 16) & 0x03) | ((this.dad & 0x0f) << 4));
        this.cmd = -1; return;

      case 0xc0:                                   // LPRD: no light pen here
        this.fifo.push(0, 0, 0);
        this.cmd = -1; return;

      default:
        if (c >= 0x70 && c <= 0x7f) {              // PRAM
          if (fresh) this.pramPtr = c & 0x0f;
          else if (p.length) {
            this.pram[this.pramPtr & 0x0f] = p[p.length - 1];
            this.pramPtr = (this.pramPtr + 1) & 0x0f;
            if (this.pramPtr === 0) this.cmd = -1;
          }
          return;
        }
        if ((c & 0xe4) === 0x20) { this._wdat(fresh); return; }
        if ((c & 0xe4) === 0xa0) { this._rdat(fresh); return; }
        if ((c & 0xe4) === 0x24) { this._dmaw(fresh); return; }
        if ((c & 0xe4) === 0xa4) { this._dmar(fresh); return; }
        this.cmd = -1;
        return;
    }
  }

  _resetOnCommand() {
    this.displayEnabled = false;
    this.fifo.length = 0;
    this.rwCount = 0;
  }

  // The sync parameters, in the datasheet's order. Only the counts that decide
  // how big the picture is are kept as separate fields; the rest is timing the
  // machine derives its own frame rate from.
  // The eight parameter bytes, in the datasheet's packing. The two vertical
  // counts are the ones that matter to a machine — AW says how wide the
  // picture is in words and AL how many lines it has — and both are split
  // across byte boundaries, which is why this is a table rather than a loop.
  //
  //   P1  mode
  //   P2  DS(7-6)          AW-2(5-0)
  //   P3  VS low 3(7-5)    HS-1(4-0)
  //   P4  HFP-1(7-2)       VS high 2(1-0)
  //   P5  --               HBP-1(5-0)
  //   P6  --               VFP(5-0)
  //   P7  AL low 8
  //   P8  VBP(7-2)         AL high 2(1-0)
  _applySync(p) {
    this.syncMode = p[0];
    this.aw = (p[1] & 0x3f) + 2;
    this.hs = (p[2] & 0x1f) + 1;
    this.vs = ((p[3] & 0x03) << 3) | ((p[2] >> 5) & 0x07);
    this.hfp = ((p[3] >> 2) & 0x3f) + 1;
    this.hbp = (p[4] & 0x3f) + 1;
    this.vfp = p[5] & 0x3f;
    this.al = ((p[7] & 0x03) << 8) | p[6];
    this.vbp = (p[7] >> 2) & 0x3f;
    // The pitch defaults to the display width unless PITCH says otherwise. A
    // machine that programs SYNC and never PITCH gets a sane memory layout.
    if (!this._pitchSet) this.pitch = Math.max(1, this.aw);
  }

  // ---- figure drawing --------------------------------------------------------
  _figs() {
    const p = this.params;
    if (p.length >= 1) {
      this.figDir = p[0] & 0x07;
      this.figType = (p[0] >> 3) & 0x1f;
    }
    if (p.length >= 3) this.dc = ((p[2] & 0x3f) << 8) | p[1];
    if (p.length >= 5) this.d = ((p[4] & 0x3f) << 8) | p[3];
    if (p.length >= 7) this.d2 = ((p[6] & 0x3f) << 8) | p[5];
    if (p.length >= 9) this.d1 = ((p[8] & 0x3f) << 8) | p[7];
    if (p.length >= 11) { this.dm = ((p[10] & 0x3f) << 8) | p[9]; this.cmd = -1; }
  }

  // FIGD executes whatever FIGS described. Which of the figure-type bits is set
  // decides the shape; nothing set at all means "a run of DC dots along DIR",
  // which is how the ROM clears a line.
  _figd() {
    const t = this.figType;
    if (t & 0x08) this._drawArc();
    else if (t & 0x10) this._drawRect();
    else if (t & 0x02) this._drawLine();
    else if (t & 0x04) this._drawLine();
    else this._drawRun();
  }

  // A dot is one bit inside one word. `mod` picks how it lands: 0 replace,
  // 1 complement, 2 clear, 3 set — the same four modes WDAT uses.
  _dot(ead, dad) {
    const bit = 1 << (dad & 0x0f);
    const a = ead & 0x3ffff;
    const m = bit & this.mask;
    if (!m) return;
    switch (this.mod & 3) {
      case 0: this.mem.write(a, 0xffff, m); break;
      case 1: this.mem.write(a, ~this.mem.read(a), m); break;
      case 2: this.mem.write(a, 0x0000, m); break;
      default: this.mem.write(a, 0xffff, m); break;
    }
  }

  // Move one step in direction `dir`. X moves inside the word (the dot address)
  // and carries into the word address; Y is a whole pitch.
  _step(dir) {
    const dx = DIR_DX[dir & 7], dy = DIR_DY[dir & 7];
    if (dx > 0) {
      this.dad = (this.dad + 1) & 0x0f;
      if (this.dad === 0) this.ead = (this.ead + 1) & 0x3ffff;
    } else if (dx < 0) {
      this.dad = (this.dad - 1) & 0x0f;
      if (this.dad === 0x0f) this.ead = (this.ead - 1) & 0x3ffff;
    }
    if (dy) this.ead = (this.ead + dy * this.pitch) & 0x3ffff;
  }

  _drawRun() {
    const n = this.dc + 1;
    for (let i = 0; i < n; i++) {
      this._dot(this.ead, this.dad);
      if (i !== n - 1) this._step(this.figDir);
    }
    this.lastDrawn = n;
  }

  // The chip's own Bresenham. DC counts steps along the octant's AXIS; D is the
  // error term and D1/D2 its two increments. The host has already done the
  // arithmetic — this only has to walk it the same way the silicon does.
  _drawLine() {
    const dir = this.figDir & 7;
    // Each octant is bounded by an axis direction and a diagonal one. The axis
    // is the even-numbered neighbour, the diagonal the odd-numbered one.
    const axis = (dir & 1) ? ((dir + 1) & 7) : dir;
    const diag = (dir & 1) ? dir : ((dir + 1) & 7);
    let err = s14(this.d);
    const d1 = s14(this.d1), d2 = s14(this.d2);
    const n = this.dc + 1;
    for (let i = 0; i < n; i++) {
      this._dot(this.ead, this.dad);
      if (i === n - 1) break;
      if (err >= 0) { this._step(diag); err += d2; }
      else { this._step(axis); err += d1; }
    }
    this.lastDrawn = n;
  }

  // A rectangle is four runs. DC is the length of the first and third sides and
  // D of the second and fourth; the direction turns 90 degrees at each corner.
  _drawRect() {
    const lens = [this.dc, this.d, this.dc, this.d];
    let dir = this.figDir & 7;
    let drawn = 0;
    for (let side = 0; side < 4; side++) {
      const n = (lens[side] & 0x3fff) + 1;
      for (let i = 0; i < n; i++) {
        this._dot(this.ead, this.dad);
        this._step(dir);
        drawn++;
      }
      dir = (dir + 2) & 7;         // 90 degrees, two octants
    }
    this.lastDrawn = drawn;
  }

  // Arc/circle. DC is the number of dots in the octant, D the radius, and DM
  // where the arc starts. The GDC's own algorithm is a mid-point circle walked
  // one octant at a time, which is what this reproduces.
  _drawArc() {
    const dir = this.figDir & 7;
    const axis = (dir & 1) ? ((dir + 1) & 7) : dir;
    const diag = (dir & 1) ? dir : ((dir + 1) & 7);
    const r = s14(this.d);
    const start = s14(this.dm);
    const n = this.dc + 1;
    let err = -r;
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      if (i >= start) { this._dot(this.ead, this.dad); drawn++; }
      if (err >= 0) { this._step(diag); err += 2 * (i - r) + 1; }
      else { this._step(axis); err += 2 * i + 1; }
    }
    this.lastDrawn = drawn;
  }

  // GCHRD paints the 8x8 pattern held in the upper half of the parameter RAM.
  // DC is how many times to repeat it along DIR and D how many rows.
  _gchrd() {
    const rows = (this.d & 0x3fff) + 1;
    const cols = (this.dc & 0x3fff) + 1;
    const startEad = this.ead, startDad = this.dad;
    let drawn = 0;
    for (let row = 0; row < rows; row++) {
      const pat = this.pram[8 + (row & 7)];
      this.ead = (startEad + row * this.pitch) & 0x3ffff;
      this.dad = startDad;
      for (let col = 0; col < cols; col++) {
        if ((pat >> (7 - (col & 7))) & 1) this._dot(this.ead, this.dad);
        this._step(2);              // +X
        drawn++;
      }
    }
    this.lastDrawn = drawn;
  }

  // ---- CPU data transfer ----------------------------------------------------
  // WDAT writes the parameter bytes into memory DC+1 times, stepping the
  // address by DIR each time. This is how the boot ROM clears a screen: set
  // FIGS with a big DC, then WDAT with two zero bytes.
  _wdat(fresh) {
    if (fresh) {
      this.rwType = (this.cmd >> 3) & 3;
      this.mod = this.cmd & 3;
      this.wdatHave = 0;
      return;
    }
    const p = this.params;
    const wantTwo = this.rwType === 0 || this.rwType === 1;
    if (wantTwo && p.length < 2) return;
    const lo = p[p.length - (wantTwo ? 2 : 1)];
    const hi = wantTwo ? p[p.length - 1] : 0;
    let data, mask;
    if (wantTwo) { data = lo | (hi << 8); mask = this.mask; }
    else if (this.rwType === 2) { data = lo | (lo << 8); mask = this.mask & 0x00ff; }
    else { data = lo | (lo << 8); mask = this.mask & 0xff00; }

    const n = this.dc + 1;
    for (let i = 0; i < n; i++) {
      this._writeWord(this.ead, data, mask);
      if (i !== n - 1) this._step(this.figDir);
    }
    // A second write with the same command repeats the whole run: the FIFO
    // stays open until a new command arrives.
    this.params.length = 0;
  }

  _writeWord(ead, data, mask) {
    const a = ead & 0x3ffff;
    switch (this.mod & 3) {
      case 0: this.mem.write(a, data, mask); break;
      case 1: this.mem.write(a, this.mem.read(a) ^ data, mask & data); break;
      case 2: this.mem.write(a, 0x0000, mask & data); break;
      default: this.mem.write(a, 0xffff, mask & data); break;
    }
  }

  _rdat(fresh) {
    if (!fresh) return;
    this.rwType = (this.cmd >> 3) & 3;
    this.mod = this.cmd & 3;
    this.rwCount = this.dc + 1;
    this.fifo.length = 0;
    this._rdatFill();
    this.cmd = -1;
  }

  _rdatFill() {
    while (this.rwCount > 0 && this.fifo.length < 16) {
      const v = this.mem.read(this.ead & 0x3ffff) & 0xffff;
      if (this.rwType === 2) this.fifo.push(v & 0xff);
      else if (this.rwType === 3) this.fifo.push((v >> 8) & 0xff);
      else this.fifo.push(v & 0xff, (v >> 8) & 0xff);
      this.rwCount--;
      this._step(this.figDir);
    }
  }

  // The DMA forms hand the transfer to an external controller. Nothing on a
  // PC-9801 boot path uses them, so they are accepted and the request line is
  // raised for a machine that wants to notice.
  _dmaw(fresh) { if (fresh) { this.dmaRequest = 'write'; this.cmd = -1; } }
  _dmar(fresh) { if (fresh) { this.dmaRequest = 'read'; this.cmd = -1; } }

  // ---- display ---------------------------------------------------------------
  // The four display partitions the parameter RAM describes. Each is a start
  // address and a line count; the text screen uses two of them for a split
  // scroll and the graphics screen uses one to pick which page is shown.
  partitions() {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const b = i * 4;
      const sad = this.pram[b] | (this.pram[b + 1] << 8) | ((this.pram[b + 2] & 0x03) << 16);
      const len = ((this.pram[b + 2] >> 4) & 0x0f) | (this.pram[b + 3] << 4);
      const wd = (this.pram[b + 3] >> 6) & 1;
      out.push({ sad, len: len & 0x3ff, wd });
      if (len === 0) break;
    }
    return out;
  }

  // Where the picture starts. A partition with a zero length means "the rest of
  // the screen", so the first entry is the one that matters for a whole-screen
  // display and the second only when the software has split it.
  get displayStart() { return this.partitions()[0]?.sad ?? 0; }

  // Called once per frame by the machine so the blink counter advances at a
  // rate a program can observe. The 7220 blinks at the rate CCHAR programmed,
  // in units of 32 frames.
  tickFrame() {
    this.blinkCounter = (this.blinkCounter + 1) & 0xffff;
    return this;
  }

  get cursorBlinkOn() {
    const rate = this.blinkRate || 8;
    return ((this.blinkCounter / rate) | 0) % 4 < 2;
  }

  setVsync(on) { this.vsyncActive = !!on; return this; }
  setHblank(on) { this.hblankActive = !!on; return this; }

  // ---- snapshot ---------------------------------------------------------------
  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      params: [...this.params], cmd: this.cmd, fifo: [...this.fifo],
      status: this.status, displayEnabled: this.displayEnabled, syncMode: this.syncMode,
      hs: this.hs, vs: this.vs, hfp: this.hfp, hbp: this.hbp, vfp: this.vfp, vbp: this.vbp,
      aw: this.aw, al: this.al, pitch: this.pitch,
      pram: Array.from(this.pram), pramPtr: this.pramPtr,
      ead: this.ead, dad: this.dad, lr: this.lr, blinkRate: this.blinkRate,
      cursorOn: this.cursorOn, cursorTop: this.cursorTop, cursorBottom: this.cursorBottom,
      blinkCounter: this.blinkCounter,
      zoomDisplay: this.zoomDisplay, zoomWrite: this.zoomWrite,
      mask: this.mask, mod: this.mod,
      figDir: this.figDir, figType: this.figType,
      dc: this.dc, d: this.d, d2: this.d2, d1: this.d1, dm: this.dm,
      rwType: this.rwType, rwCount: this.rwCount,
      master: this.master,
    };
  }

  setState(s) {
    this.params = [...s.params]; this.cmd = s.cmd; this.fifo = [...s.fifo];
    this.status = s.status; this.displayEnabled = s.displayEnabled; this.syncMode = s.syncMode;
    this.hs = s.hs; this.vs = s.vs; this.hfp = s.hfp; this.hbp = s.hbp;
    this.vfp = s.vfp; this.vbp = s.vbp;
    this.aw = s.aw; this.al = s.al; this.pitch = s.pitch;
    this.pram.set(s.pram); this.pramPtr = s.pramPtr;
    this.ead = s.ead; this.dad = s.dad; this.lr = s.lr; this.blinkRate = s.blinkRate;
    this.cursorOn = s.cursorOn; this.cursorTop = s.cursorTop; this.cursorBottom = s.cursorBottom;
    this.blinkCounter = s.blinkCounter;
    this.zoomDisplay = s.zoomDisplay; this.zoomWrite = s.zoomWrite;
    this.mask = s.mask; this.mod = s.mod;
    this.figDir = s.figDir; this.figType = s.figType;
    this.dc = s.dc; this.d = s.d; this.d2 = s.d2; this.d1 = s.d1; this.dm = s.dm;
    this.rwType = s.rwType; this.rwCount = s.rwCount;
    this.master = s.master;
    return this;
  }
}

export default Upd7220;
