// machineseta — a Seta arcade board as a machine, on the same contract as
// Pc8801Machine, NesMachine, MegaDriveMachine and X68000Machine: `stepFrame()`,
// `frame`, `snapshot()`, `restore()`, `schemaVersion`. demo/machine.html builds
// fast-forward, rewind and jog-shuttle on that contract and nothing else.
//
// ## Why an arcade board is the cheapest machine in this repository
//
// There is no BIOS, no disk controller, no keyboard, no bank switching and no
// operating system. The board is a 68000, one ROM, sixteen kilobytes of RAM and
// two custom chips, and it starts running the game from the reset vector. What
// is left to write is a memory map — which is why this file is a third the size
// of machinex68.js while covering four different boards.
//
// It is also the machine where rewind works best. A snapshot is about 50 KB
// (measured numbers in docs/seta-design.md) against the X68000's 1.5 MB, so the
// host's byte-budgeted ring holds thousands of frames: a whole minute of play
// can be scrubbed backwards.
//
// ## One class, several boards
//
// Seta reused the same three chips across a decade with the address decoder
// rewired each time. Rather than a class per game, a board is a 256-entry table
// saying what each 64 KB page of the 68000's address space is, and the read and
// write paths switch on that. Adding a board is adding a row, not a file.
//
// ## What is deliberately not modelled
//
// The X1-012 tilemap chip (so the boards that have one — msgundam, wrofaero,
// eightfrc, zingzip and the rest — are not here), the second Z80 that a few
// later boards carry, the 6-bit tilemap colour modes, and any board with an
// OKI6295 instead of an X1-010. docs/seta-design.md lists the consequences and
// what each unsupported set would need.

import { M68000 } from './m68000.js';
import { X1001, decodeSpriteTiles } from './x1001.js';
import { X1010 } from './x1010.js';
import { SETA_SETS, buildSetaSet } from './setarom.js';

export const SCHEMA_VERSION = 1;

// A player's control panel, in the order the board presents it on the data bus.
// Note LEFT/RIGHT come before UP/DOWN — this is Seta's "type 1" wiring and it
// is not the order any console uses.
export const BUTTON = Object.freeze({
  LEFT: 0, RIGHT: 1, UP: 2, DOWN: 3, B1: 4, B2: 5, START: 7,
});
export const COIN = Object.freeze({ COIN1: 0, COIN2: 1, SERVICE: 2, TILT: 3 });

// A coin switch is a mechanical contact; the game wants to see it closed for
// several frames or it will not count. MAME's PORT_IMPULSE(5) is the same
// value, arrived at the same way.
const COIN_IMPULSE_FRAMES = 5;

// Page codes for the address decoder. One per kind of thing a 64 KB page can
// be; the fine decode inside a page is board-independent because Seta kept the
// chips at the same offsets within their page every time.
const P = {
  NONE: 0, ROM: 1, RAM: 2, SND: 3, IPL1ACK: 4, IPL0ACK: 5, PROT: 6, COIN: 7,
  DSW: 8, PAL: 9, IN: 10, SPRY: 11, SPRC: 12, DUMMY: 13, NVRAM: 14, TRACK: 15,
  EXTRAM: 16, NOP: 17,
};

// pages: [firstPage, lastPage, code]. A page is `address >>> 16`.
export const SETA_BOARDS = Object.freeze({
  // Thunder & Lightning. 8 MHz 68000, sprites only, vblank drives IPL2 and the
  // game acknowledges it by touching $200000. A registered PAL sits in the
  // write-only window at $400000 and the game checks it; without the PAL the
  // board soft-resets itself in a loop.
  thunderl: {
    cpuHz: 8000000, x1sndHz: 16000000, fps: 60,
    romSize: 0x10000, ramBase: 0xffc000, ramSize: 0x4000,
    width: 512, height: 256, visX: [0, 384], visY: [8, 248],
    rotation: 270, bgPen: 0x1f0, paletteWords: 0x200,
    irq: 'vblank', irqLevel: 2, irqHold: false, protection: 'thunderl',
    dsw: 0xe9ff, coinsDip: 0xe0,
    // The offsets differ between upright and cocktail because the picture is
    // mirrored about a pivot the chip does not know the position of. The
    // upright pair is the one that matters here.
    sprite: { fgXoffs: 0, fgFlipXoffs: 0, fgYoffs: 0x0e, fgFlipYoffs: -0x12,
              bgYoffs: -0x1, bgFlipYoffs: 0x1 },
    pages: [[0x00, 0x00, P.ROM], [0x10, 0x13, P.SND], [0x20, 0x20, P.IPL1ACK],
            [0x30, 0x30, P.NOP], [0x40, 0x41, P.PROT], [0x50, 0x50, P.COIN],
            [0x60, 0x60, P.DSW], [0x70, 0x70, P.PAL], [0xb0, 0xb0, P.IN],
            [0xc0, 0xc0, P.DUMMY], [0xd0, 0xd0, P.SPRY], [0xe0, 0xe3, P.SPRC],
            [0xff, 0xff, P.RAM]],
  },

  // Wit's: the same PCB one year earlier, without the protection PAL and with
  // two extra player ports wired into the same page.
  wits: {
    cpuHz: 8000000, x1sndHz: 16000000, fps: 60,
    romSize: 0x10000, ramBase: 0xffc000, ramSize: 0x4000,
    width: 512, height: 256, visX: [0, 384], visY: [8, 248],
    rotation: 0, bgPen: 0x1f0, paletteWords: 0x200,
    irq: 'vblank', irqLevel: 2, irqHold: false, protection: null,
    dsw: 0xffff, coinsDip: 0xe0, players: 4,
    sprite: { fgXoffs: 0, fgFlipXoffs: 0, fgYoffs: 0x0e, fgFlipYoffs: -0x12,
              bgYoffs: -0x1, bgFlipYoffs: 0x1 },
    pages: [[0x00, 0x00, P.ROM], [0x10, 0x13, P.SND], [0x20, 0x20, P.IPL1ACK],
            [0x30, 0x30, P.NOP], [0x50, 0x50, P.COIN], [0x60, 0x60, P.DSW],
            [0x70, 0x70, P.PAL], [0xb0, 0xb0, P.IN], [0xc0, 0xc0, P.DUMMY],
            [0xd0, 0xd0, P.SPRY], [0xe0, 0xe3, P.SPRC], [0xe4, 0xe7, P.EXTRAM],
            [0xff, 0xff, P.RAM]],
  },

  // Krazy Bowl, five years later: a bigger program, 64 KB of RAM at the other
  // end of the map, trackballs, battery-backed settings, and a scanline timer
  // instead of a plain vblank — two interrupts a frame, both auto-clearing on
  // acknowledge rather than waiting for the game to write an ack register.
  krzybowl: {
    cpuHz: 14318181, x1sndHz: 14318181, fps: 60,
    romSize: 0x80000, ramBase: 0xf00000, ramSize: 0x10000,
    width: 512, height: 256, visX: [8, 312], visY: [8, 248],
    rotation: 270, bgPen: 0x1f0, paletteWords: 0x200,
    irq: 'scanline12', irqHold: true, protection: null,
    dsw: 0xffff, coinsDip: 0xf0,
    sprite: { fgXoffs: 0, fgFlipXoffs: 0, fgYoffs: 0x0e, fgFlipYoffs: -0x06,
              bgYoffs: -0x1, bgFlipYoffs: -0x3 },
    pages: [[0x00, 0x07, P.ROM], [0x10, 0x10, P.NOP], [0x20, 0x20, P.NOP],
            [0x30, 0x30, P.DSW], [0x40, 0x40, P.NOP], [0x50, 0x50, P.IN],
            [0x60, 0x60, P.TRACK], [0x80, 0x80, P.NVRAM], [0xa0, 0xa3, P.SND],
            [0xb0, 0xb0, P.PAL], [0xc0, 0xc3, P.SPRC], [0xd0, 0xd0, P.DUMMY],
            [0xe0, 0xe0, P.SPRY], [0xf0, 0xf0, P.RAM]],
  },
  // Ultraman Club, 1992. Sprites only again, but a 16 MHz 68000, a level 3
  // interrupt that the acknowledge cycle clears rather than an ack register,
  // sprite ROMs that are NOT interleaved, and a palette page whose upper three
  // quarters are ordinary RAM.
  umanclub: {
    cpuHz: 16000000, x1sndHz: 16000000, fps: 60,
    romSize: 0x40000, ramBase: 0x200000, ramSize: 0x10000,
    width: 512, height: 256, visX: [0, 384], visY: [8, 248],
    rotation: 0, bgPen: 0x1f0, paletteWords: 0x200, palTailRam: true,
    irq: 'vblank', irqLevel: 3, irqHold: true, protection: null,
    dsw: 0xffff, coinsDip: 0xf0,
    sprite: { fgXoffs: 0, fgFlipXoffs: 0, fgYoffs: 0x0e, fgFlipYoffs: -0x12,
              bgYoffs: -0x1, bgFlipYoffs: 0x1 },
    pages: [[0x00, 0x03, P.ROM], [0x20, 0x20, P.RAM], [0x30, 0x30, P.PAL],
            [0x40, 0x40, P.IN], [0x50, 0x50, P.COIN], [0x60, 0x60, P.DSW],
            [0xa0, 0xa0, P.SPRY], [0xa8, 0xa8, P.DUMMY], [0xb0, 0xb3, P.SPRC],
            [0xc0, 0xc3, P.SND]],
  },
});

function buildPageMap(board) {
  const m = new Uint8Array(256);   // P.NONE
  for (const [lo, hi, code] of board.pages) for (let p = lo; p <= hi; p++) m[p] = code;
  return m;
}

export class SetaMachine {
  // Either `romset` (already built by setarom.js) or `files` + `set`.
  constructor({ romset = null, files = null, set = null, sampleRate = 48000, dsw = null } = {}) {
    if (!romset && files) romset = buildSetaSet(files, set || 'thunderl');
    if (!romset) throw new Error('SetaMachine needs a ROM set (romset or files)');
    this.romset = romset;
    this.set = romset.set;
    this.title = romset.title;
    const board = SETA_BOARDS[romset.board];
    if (!board) throw new Error(`no board description for ${romset.board}`);
    this.boardName = romset.board;
    this.board = board;
    this.schemaVersion = SCHEMA_VERSION;
    this.pageMap = buildPageMap(board);

    this.rom = romset.regions.maincpu;
    this.ram = new Uint8Array(board.ramSize);
    this.paletteram = new Uint16Array(board.paletteWords);
    // Only allocated when the board actually decodes them. 16 KB of scratch RAM
    // that no board but Wit's has would otherwise ride along in every rewind
    // slot of every game — a quarter of thunderl's snapshot spent on nothing.
    const has = (code) => board.pages.some((p) => p[2] === code);
    this.nvram = has(P.NVRAM) ? new Uint8Array(0x100) : null;
    this.extram = (has(P.EXTRAM) || board.palTailRam) ? new Uint8Array(0x4000) : null;
    this.dummy = 0;

    const gfx = decodeSpriteTiles(romset.regions.gfx1 || new Uint8Array(0));
    this.gfxTiles = gfx.count;
    this.video = new X1001({
      tiles: gfx.tiles, tileCount: gfx.count,
      width: board.width, height: board.height,
      // A cocktail cabinet flips the picture; the blank rows under the visible
      // area have to be added back or the flipped image sits too high.
      flipYAdjust: board.height - board.visY[1],
      penMask: board.paletteWords - 1,
      ...board.sprite,
    });
    this.sound = new X1010({
      rom: romset.regions.x1snd || null,
      clockHz: board.x1sndHz, sampleRate,
    });

    this.cpu = new M68000({
      read16: (a) => this._read16(a),
      write16: (a, v) => this._write16(a, v),
      read8: (a) => this._read8(a),
      write8: (a, v) => this._write8(a, v),
      // Level-triggered on this board, so the acknowledge cycle takes an
      // autovector and the LINE stays where the machine put it. `scanline12`
      // boards clear the line here instead — see _irqAck.
      irqAck: (level) => this._irqAck(level),
    });

    this.dsw = dsw === null ? board.dsw : (dsw & 0xffff);
    this.inputs = new Uint8Array(4);   // P1..P4, 1 = pressed
    this.coinsIn = 0;                  // COIN/SERVICE/TILT, 1 = closed
    this._coinTimer = new Uint8Array(4);
    this.trackball = new Int16Array(4); // P1 X/Y, P2 X/Y — read as 12-bit counters

    this.frame = 0;
    this._acc = 0;
    this.powerOn();
  }

  powerOn() {
    this.ram.fill(0);
    this.paletteram.fill(0);
    if (this.nvram) this.nvram.fill(0);
    if (this.extram) this.extram.fill(0);
    this.video.powerOn();
    this.sound.reset();
    this.frame = 0;
    this._acc = 0;
    this._cycRem = 0;
    return this.reset();
  }

  reset() {
    this.irqLines = 0;               // bitmask of asserted 68000 IPL levels
    this._debt = 0;
    this.line = 0;
    this.protReg = 0;
    this.coinCtrl = 0;
    this._shownPal = new Uint16Array(this.board.paletteWords);
    this.video.reset();
    this.cpu.reset();                // re-reads SSP/PC now that the ROM is mapped
    return this;
  }

  // ---- interrupts ------------------------------------------------------------
  _setIrq(level, on) {
    const before = this.irqLines;
    if (on) this.irqLines |= (1 << level); else this.irqLines &= ~(1 << level);
    if (this.irqLines !== before) this._pushIrq();
  }

  _pushIrq() {
    let lvl = 0;
    for (let i = 7; i >= 1; i--) if (this.irqLines & (1 << i)) { lvl = i; break; }
    this.cpu.setIRQ(lvl);
  }

  // A negative return means "autovector", which is what these boards do: there
  // is no vector generator on the bus. The boards that use HOLD_LINE also drop
  // the request here, because on those the acknowledge cycle is the only thing
  // that ever clears it.
  _irqAck(level) {
    if (this.board.irqHold) {
      this.irqLines &= ~(1 << level);
      this._pushIrq();
    }
    return -1;
  }

  // ---- the 68000 bus ---------------------------------------------------------
  _read16(a) {
    a &= 0xffffff;
    switch (this.pageMap[a >>> 16]) {
      case P.ROM: { const r = this.rom; return a + 1 < r.length ? ((r[a] << 8) | r[a + 1]) : 0; }
      case P.RAM: { const o = this._ramOff(a); return o < 0 ? 0 : ((this.ram[o] << 8) | this.ram[o + 1]); }
      case P.EXTRAM: { const o = a & 0x3ffe; return this.extram ? ((this.extram[o] << 8) | this.extram[o + 1]) : 0; }
      case P.SND: return this.sound.wordRead((a & 0x3fff) >> 1);
      // Reading the acknowledge register acknowledges. Several Seta games do
      // exactly that (a MOVE from the port, result discarded) instead of a
      // write, so a read-only handler here leaves the interrupt asserted and
      // the game re-enters its handler forever.
      case P.IPL1ACK: this._setIrq(2, false); return 0;
      case P.IPL0ACK: this._setIrq(1, false); return 0;
      case P.DSW: return (a & 2) ? (this.dsw & 0xff) : ((this.dsw >> 8) & 0xff);
      case P.PAL: return this._palRead(a);
      case P.IN: return this._inputRead(a);
      case P.SPRY: return this._spryRead(a);
      case P.SPRC: return this.video.codeRead((a & 0x3fff) >> 1);
      case P.DUMMY: return this.dummy;
      case P.NVRAM: { const o = a & 0x1fe; return this.nvram ? ((this.nvram[o] << 8) | this.nvram[o + 1]) : 0; }
      case P.TRACK: return this._trackRead(a);
      default: return 0;   // MAME's unmapped-read value for these maps
    }
  }

  _write16(a, v) {
    a &= 0xffffff; v &= 0xffff;
    switch (this.pageMap[a >>> 16]) {
      case P.RAM: { const o = this._ramOff(a); if (o >= 0) { this.ram[o] = v >> 8; this.ram[o + 1] = v & 0xff; } return; }
      case P.EXTRAM: { if (this.extram) { const o = a & 0x3ffe; this.extram[o] = v >> 8; this.extram[o + 1] = v & 0xff; } return; }
      case P.SND: this.sound.wordWrite((a & 0x3fff) >> 1, v); return;
      case P.IPL1ACK: this._setIrq(2, false); return;
      case P.IPL0ACK: this._setIrq(1, false); return;
      case P.PROT: this._protWrite(a); return;
      case P.COIN: this._coinWrite(v & 0xff); return;
      case P.PAL: this._palWrite(a, v); return;
      case P.SPRY: this._spryWrite(a, v); return;
      case P.SPRC: this.video.codeWrite((a & 0x3fff) >> 1, v); return;
      case P.DUMMY: this.dummy = v; return;
      case P.NVRAM: { if (this.nvram) { const o = a & 0x1fe; this.nvram[o] = v >> 8; this.nvram[o + 1] = v & 0xff; } return; }
      default: return;
    }
  }

  // Byte accesses are handled explicitly rather than synthesized from words.
  // m68000.js can synthesize them, but the synthesis is a read-modify-write and
  // half this map is registers where a spurious read has a side effect — the
  // interrupt acknowledge ports, most obviously, which would then fire on every
  // byte write to their page. The 68000 has UDS/LDS strobes for this reason.
  _read8(a) {
    a &= 0xffffff;
    switch (this.pageMap[a >>> 16]) {
      case P.ROM: return a < this.rom.length ? this.rom[a] : 0;
      case P.RAM: { const o = a - this.board.ramBase; return (o >= 0 && o < this.board.ramSize) ? this.ram[o] : 0; }
      case P.EXTRAM: return this.extram ? this.extram[a & 0x3fff] : 0;
      case P.SND: return (a & 1) ? this.sound.read((a & 0x3fff) >> 1) : ((this.sound.wordRead((a & 0x3fff) >> 1) >> 8) & 0xff);
      case P.IPL1ACK: this._setIrq(2, false); return 0;
      case P.IPL0ACK: this._setIrq(1, false); return 0;
      case P.DSW: { const w = (a & 2) ? (this.dsw & 0xff) : ((this.dsw >> 8) & 0xff); return (a & 1) ? (w & 0xff) : (w >> 8); }
      default: { const w = this._read16(a & ~1); return (a & 1) ? (w & 0xff) : ((w >> 8) & 0xff); }
    }
  }

  _write8(a, v) {
    a &= 0xffffff; v &= 0xff;
    switch (this.pageMap[a >>> 16]) {
      case P.RAM: { const o = (a - this.board.ramBase); if (o >= 0 && o < this.board.ramSize) this.ram[o] = v; return; }
      case P.EXTRAM: if (this.extram) this.extram[a & 0x3fff] = v; return;
      case P.SND: if (a & 1) this.sound.write((a & 0x3fff) >> 1, v); return;
      case P.COIN: if (a & 1) this._coinWrite(v); return;
      case P.IPL1ACK: this._setIrq(2, false); return;
      case P.IPL0ACK: this._setIrq(1, false); return;
      case P.PROT: this._protWrite(a); return;
      // The rest of the map is 16-bit RAM inside the customs; a byte write there
      // replaces one half and leaves the other, which is what the strobes do.
      default: {
        const w = this._read16(a & ~1);
        this._write16(a & ~1, (a & 1) ? ((w & 0xff00) | v) : ((w & 0x00ff) | (v << 8)));
        return;
      }
    }
  }

  // The palette is 0x400 bytes at the foot of its page. On some boards the rest
  // of the page is ordinary RAM the game uses for something else; masking the
  // address down to 0x3ff on those would alias it onto the colours and repaint
  // the screen every time the game touched its scratch space.
  _palRead(a) {
    const o = a & 0xffff;
    if (o < 0x400) return this.paletteram[o >> 1];
    return this.extram ? ((this.extram[o & 0x3ffe] << 8) | this.extram[(o & 0x3ffe) + 1]) : 0;
  }

  _palWrite(a, v) {
    const o = a & 0xffff;
    if (o < 0x400) { this.paletteram[o >> 1] = v; return; }
    if (this.extram) { const i = o & 0x3ffe; this.extram[i] = v >> 8; this.extram[i + 1] = v & 0xff; }
  }

  _ramOff(a) {
    const o = a - this.board.ramBase;
    return (o >= 0 && o < this.board.ramSize) ? (o & ~1) : -1;
  }

  // ---- the customs seen from the bus -----------------------------------------
  // $x00000-$x005ff is the Y table and the tilemap scroll; $x00600-$x00607 is
  // the four control bytes. Same offsets on every board that has this chip.
  _spryRead(a) {
    const o = a & 0x7ff;
    if (o >= 0x600) return this.video.ctrlRead((o & 7) >> 1);
    return this.video.ylowRead(o >> 1);
  }

  _spryWrite(a, v) {
    const o = a & 0x7ff;
    // The chip is 8 bits wide: only the low byte of a word write reaches it.
    if (o >= 0x600) this.video.ctrlWrite((o & 7) >> 1, v & 0xff);
    else this.video.ylowWrite(o >> 1, v & 0xff);
  }

  // ---- protection ------------------------------------------------------------
  // thunderl's PAL16V8 latches a value computed from the ADDRESS of the write,
  // not the data. The game writes to a handful of addresses in $400000-$41ffff
  // and then reads $b0000c expecting a particular byte; a mismatch soft-resets
  // the board. The equations are the PAL's, recovered by brute force.
  _protWrite(a) {
    const addr = a & 0x1ffff;
    const b = (n) => (addr >> n) & 1;
    const nb = (n) => 1 - b(n);
    const t5 = b(6) & b(13);
    const t2 = b(2) | nb(6);
    const t3 = t2 | nb(8);
    const t6 = t5 | nb(16);
    this.protReg = (
      (b(2) << 0)
      | ((b(2) & nb(3)) << 1)
      | (t2 << 2)
      | (t3 << 3)
      | ((b(3) & nb(11) & b(15)) << 4)
      | (t5 << 5)
      | (t6 << 6)
      | ((t6 & t3) << 7)
    ) & 0xff;
  }

  // ---- inputs ----------------------------------------------------------------
  // Everything is active low: a closed switch pulls the line to 0. Bits with no
  // switch on them read 0, which is what MAME's port default gives.
  _inputRead(a) {
    const o = a & 0xff;
    if (this.board.protection === 'thunderl' && o === 0x0c) return this.protReg;
    switch (o) {
      case 0x00: return (~this.inputs[0]) & 0xff;
      case 0x02: return (~this.inputs[1]) & 0xff;
      case 0x04: return (((~this.coinsIn) & 0x0f) | this.board.coinsDip) & 0xff;
      case 0x08: return (~this.inputs[2]) & 0xff;
      case 0x0a: return (~this.inputs[3]) & 0xff;
      default: return 0;
    }
  }

  // The uPD4701 trackball counters. Not driven by anything yet: krzybowl reads
  // a standing zero and its attract mode runs, but the ball does not move.
  _trackRead(a) {
    const which = (a & 0x08) ? 2 : 0;
    const axis = (a & 0x04) ? 1 : 0;
    const v = this.trackball[which + axis] & 0xfff;
    return (a & 2) ? ((v >> 8) & 0x0f) : (v & 0xff);
  }

  _coinWrite(v) {
    this.coinCtrl = v;
    this.sound.enableWrite(v & 0x40);
  }

  // ---- input API -------------------------------------------------------------
  padDown(bit, player = 0) { this.inputs[player & 3] |= (1 << bit); return this; }
  padUp(bit, player = 0) { this.inputs[player & 3] &= ~(1 << bit); return this; }
  setPad(mask, player = 0) { this.inputs[player & 3] = mask & 0xff; return this; }
  setDip(v) { this.dsw = v & 0xffff; return this; }
  // Hold a coin switch closed for a few frames, the way a real coin does.
  insertCoin(slot = 0) { this._coinTimer[slot & 3] = COIN_IMPULSE_FRAMES; return this; }
  setService(on) { if (on) this.coinsIn |= (1 << COIN.SERVICE); else this.coinsIn &= ~(1 << COIN.SERVICE); return this; }

  // ---- run -------------------------------------------------------------------
  // The clock does not divide evenly into 60 frames a second (8 MHz gives
  // 133333 1/3 cycles a frame), so the remainder is carried in an integer: one
  // extra cycle every third frame. Floats here would make two runs of the same
  // input diverge after a few minutes, which is exactly what rewind cannot have.
  _frameCycles() {
    const per = (this.board.cpuHz / this.board.fps);
    const whole = Math.floor(per);
    this._cycRem += Math.round((per - whole) * 3);
    let extra = 0;
    while (this._cycRem >= 3) { this._cycRem -= 3; extra++; }
    return whole + extra;
  }

  stepFrame() {
    // Coin switches release on a frame boundary, so the count is the same
    // whatever the host's frame rate is doing.
    for (let s = 0; s < 4; s++) {
      if (this._coinTimer[s]) {
        this.coinsIn |= (1 << s);
        if (--this._coinTimer[s] === 0) this.coinsIn &= ~(1 << s);
      }
    }

    const lines = this.board.height;
    const budget = this._frameCycles();
    const vblank = this.board.visY[1];
    let spent = 0;
    // A step STARTS at the first line of vertical blanking and ends at the next
    // one. That is not the obvious phase, and it is chosen for a specific
    // reason.
    //
    // The picture has to be taken when blanking begins: that is what the
    // monitor has just finished scanning out, and it is before the game's
    // vblank handler rewrites sprite RAM for the next field. Taking it anywhere
    // later includes writes the player could not have seen.
    //
    // But it also has to be a function of the SNAPSHOT and not of history, or
    // `restore()` cannot reproduce the frame it restores to — the state it
    // carries is sprite RAM as it stands after the handler ran, and redrawing
    // from that gives a different picture. Rewinding through 250 slots of
    // Thunder & Lightning got the wrong frame on a quarter of them, which is
    // exactly the kind of fault that only shows up when the time travel is
    // actually used.
    //
    // Starting the step at blanking satisfies both: the draw at the end of the
    // step IS the start of blanking, so the state the snapshot holds is the
    // state the field was drawn from.
    for (let i = 0; i < lines; i++) {
      const line = (vblank + i) % lines;
      this.line = line;
      this._lineHook(line, vblank);
      const upto = Math.floor((i + 1) * budget / lines);
      this._runCycles(upto - spent);
      spent = upto;
    }
    this._drawFrame();
    this.frame++;
    return this;
  }

  // Interrupt sources, per board.
  _lineHook(line, vblank) {
    if (line === vblank && this.board.irq === 'vblank') this._setIrq(this.board.irqLevel, true);
    if (this.board.irq === 'scanline12') {
      if (line === 112) this._setIrq(2, true);
      if (line === 240) this._setIrq(1, true);
    }
  }

  _runCycles(n) {
    this._debt += n;
    const cpu = this.cpu;
    while (this._debt > 0) {
      // A double bus fault stops the chip until reset. Without this the loop
      // would spin forever on a set that did not build.
      if (cpu.halted) { this._debt = 0; return; }
      this._debt -= cpu.step();
    }
  }

  // Build the indexed field and take a copy of the palette as it stands right
  // now. The copy is what makes a rewound frame identical to the frame that was
  // shown: the game is free to rewrite the palette during blanking, and without
  // the copy a snapshot restored later would resolve the old picture through
  // the new colours.
  _drawFrame() {
    this.video.drawFrame(this.board.bgPen);
    this._shownPal.set(this.paletteram);
  }

  update(dt, onFrame = null) {
    this._acc += dt;
    const period = 1 / this.board.fps;
    while (this._acc >= period) { this._acc -= period; this.stepFrame(); if (onFrame) onFrame(); }
    return this;
  }

  // ---- video -----------------------------------------------------------------
  // The board draws into a 512x256 field of which a window is wired to the
  // monitor. `rotate` turns the cabinet: Thunder & Lightning's monitor is on its
  // side, so the honest picture is 240x384 portrait. Tools that compare against
  // MAME pass `rotate: false` and get the board's own orientation.
  render({ out = null, rotate = null, indexed = false, analog = true, pens = false } = {}) {
    const b = this.board;
    const [x0, x1] = b.visX, [y0, y1] = b.visY;
    const vw = x1 - x0, vh = y1 - y0;
    const rot = rotate === null ? (b.rotation === 270 || b.rotation === 90) : !!rotate;
    const W = rot ? vh : vw, H = rot ? vw : vh;
    const N = W * H;
    const src = this.video.bitmap, pal = this._shownPal, sw = b.width;
    const penMask = pal.length - 1;

    // The raw pen numbers plus the palette that resolves them. Nothing in the
    // host wants this; it exists so a comparison against MAME can be made in
    // the board's own units rather than through the DAC.
    if (pens) {
      const pixels = new Uint16Array(N);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          // ROT270 is a quarter turn anticlockwise: the board's right-hand edge
          // becomes the top of the picture.
          const sx = rot ? (vw - 1 - y) : x, sy = rot ? x : y;
          pixels[y * W + x] = src[(y0 + sy) * sw + (x0 + sx)];
        }
      }
      return { width: W, height: H, pixels, palette: pal.slice(), schemaVersion: SCHEMA_VERSION };
    }

    const rgb = (!indexed && out && out.length >= N * 3) ? out : new Uint8Array(N * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const sx = rot ? (vw - 1 - y) : x, sy = rot ? x : y;
        const c = pal[src[(y0 + sy) * sw + (x0 + sx)] & penMask];
        // RRRRRGGGGGBBBBB, five bits a channel, expanded the way the DAC does:
        // the top three bits are repeated into the bottom so full scale is 255.
        const r = (c >> 10) & 0x1f, g = (c >> 5) & 0x1f, bl = c & 0x1f;
        const o = (y * W + x) * 3;
        rgb[o] = (r << 3) | (r >> 2);
        rgb[o + 1] = (g << 3) | (g >> 2);
        rgb[o + 2] = (bl << 3) | (bl >> 2);
      }
    }
    if (!indexed) return { width: W, height: H, rgb, schemaVersion: SCHEMA_VERSION };

    // The shape the demo's phosphor pipeline takes, the same as mdvdp.js and
    // x68video.js: a 3-bit GRB index for the coarse path plus a per-gun drive
    // in 0..1 so a 512-colour picture is not collapsed to eight primaries.
    const pixels = (out && out.length === N) ? out : new Uint8Array(N);
    let drive = null;
    if (analog) {
      if (!this._driveBuf || this._driveBuf.length !== N * 3) this._driveBuf = new Float32Array(N * 3);
      drive = this._driveBuf;
    }
    for (let i = 0; i < N; i++) {
      const r = rgb[i * 3], g = rgb[i * 3 + 1], bl = rgb[i * 3 + 2];
      pixels[i] = (g >= 128 ? 4 : 0) | (r >= 128 ? 2 : 0) | (bl >= 128 ? 1 : 0);
      if (drive) { drive[i] = r / 255; drive[N + i] = g / 255; drive[2 * N + i] = bl / 255; }
    }
    return { width: W, height: H, pixels, drive, schemaVersion: SCHEMA_VERSION };
  }

  renderAudio(out, n = out.length) {
    out.fill(0, 0, n);
    this.sound.renderAddMono(out, n, 0.5);
    for (let i = 0; i < n; i++) {
      const v = out[i];
      out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
    return out;
  }

  // ---- time travel -------------------------------------------------------------
  // Mutable state only. The program ROM, the sprite ROM, the decoded tiles and
  // the sample ROM all stay where they are; what is left is 16 KB of work RAM,
  // 17 KB of sprite-chip RAM, 16 KB of sound-chip RAM and a kilobyte of palette.
  // Measured sizes are in docs/seta-design.md — this is the smallest snapshot of
  // any machine here after the Famicom's, which is what makes a long rewind
  // affordable on this board.
  snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      set: this.set, board: this.boardName,
      cpu: this.cpu.snapshot(),
      ram: this.ram.slice(),
      paletteram: this.paletteram.slice(),
      shownPal: this._shownPal.slice(),
      video: this.video.getState(),
      sound: this.sound.getState(),
      // Battery-backed settings and the scratch RAM some boards decode. Both are
      // small enough that skipping them when untouched would not pay for the
      // ambiguity it introduces.
      nvram: this.nvram ? this.nvram.slice() : null,
      extram: this.extram ? this.extram.slice() : null,
      dummy: this.dummy,
      dsw: this.dsw,
      inputs: this.inputs.slice(),
      coinsIn: this.coinsIn,
      coinTimer: this._coinTimer.slice(),
      trackball: this.trackball.slice(),
      irqLines: this.irqLines,
      protReg: this.protReg,
      coinCtrl: this.coinCtrl,
      debt: this._debt, cycRem: this._cycRem,
      line: this.line, frame: this.frame, acc: this._acc,
    };
  }

  restore(s) {
    this.cpu.restore(s.cpu);
    this.ram.set(s.ram);
    this.paletteram.set(s.paletteram);
    this._shownPal.set(s.shownPal);
    this.video.setState(s.video);
    this.sound.setState(s.sound);
    if (this.nvram && s.nvram) this.nvram.set(s.nvram);
    if (this.extram && s.extram) this.extram.set(s.extram);
    this.dummy = s.dummy | 0;
    this.dsw = s.dsw & 0xffff;
    this.inputs.set(s.inputs);
    this.coinsIn = s.coinsIn | 0;
    this._coinTimer.set(s.coinTimer);
    this.trackball.set(s.trackball);
    this.irqLines = s.irqLines | 0;
    this.protReg = s.protReg | 0;
    this.coinCtrl = s.coinCtrl | 0;
    this._debt = s.debt | 0;
    this._cycRem = s.cycRem | 0;
    this.line = s.line | 0;
    this.frame = s.frame | 0;
    this._acc = s.acc ?? 0;
    // The interrupt LINE is the machine's to drive, not the CPU's to remember:
    // re-assert it so the first instruction after a restore sees the same pins
    // as the first instruction before it.
    this._pushIrq();
    // The picture is derived from chip RAM, so redraw rather than store it.
    this.video.drawFrame(this.board.bgPen);
    return this;
  }
}

export function createSetaMachine(opts) { return new SetaMachine(opts); }
export { SETA_SETS };
export default SetaMachine;
