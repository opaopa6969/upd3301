// gbppu — the Game Boy / Game Boy Color picture processing unit.
// Pure JS, zero deps, deterministic. No DOM: the output is plain data.
//
// ## What this models, and what it does not
//
// Real hardware builds a scanline with a pixel FIFO: two shift registers
// (background and objects) fed by a fetcher that walks the tile map, stalling
// while sprites are patched in. Emulating the FIFO gets you the last few
// percent — mid-scanline register writes, the "mealybug" tests — at the cost
// of a much larger and much slower core.
//
// This renderer is **line-based**: it latches which objects are on the line at
// the mode 2 → mode 3 boundary, and paints the whole line at the mode 3 →
// mode 0 boundary. dmg-acid2's own README says a line-based renderer is
// sufficient for it, and that is the test that decides whether the *picture*
// is right. What a line-based renderer cannot do is honour a write to SCX or
// LCDC that lands in the middle of a line; §11 of docs/gb-design.md lists that
// as a known hole rather than hiding it.
//
// **Mode timing is not line-based.** The clock here runs in dots (T-cycles at
// 4.194 MHz), 456 per line, and the mode boundaries move: mode 3 is longer
// when the background is scrolled to a fractional tile, longer again when the
// window opens, and longer again per object on the line. Games use those
// boundaries as a raster clock, and mooneye's `ppu/` group measures them to
// the dot, so they get modelled properly even though the pixels do not.
//
// ## Interrupts
//
// The PPU raises two of the five. VBlank is an edge — it happens once, when
// LY becomes 144. STAT is not: hardware ORs four conditions into one wire and
// the interrupt fires on the wire's RISING edge only. That is why a game that
// enables the HBlank and LYC sources together gets *fewer* interrupts than a
// game that enables one (mooneye stat_irq_blocking), and it is why this file
// keeps `_statLine` instead of raising an interrupt at each condition.
//
// The flags are read and cleared by the machine, so this file needs no
// callback and no reference to a CPU.

export const SCHEMA_VERSION = 1;

export const SCREEN_W = 160, SCREEN_H = 144;
export const DOTS_PER_LINE = 456, LINES_PER_FRAME = 154;

export const MODE = Object.freeze({ HBLANK: 0, VBLANK: 1, OAM: 2, DRAW: 3 });

// The OAM scan is 80 dots and mode 3 starts there — for interrupts, for the
// VRAM lock, for everything the hardware does. But the two mode bits a game
// READS out of STAT lag the real transition by one M-cycle. That single fact
// reconciles three tests that otherwise contradict each other:
//
//   hblank_ly_scx_timing  the mode 0 INTERRUPT is 204 dots before LY changes,
//                         i.e. mode 0 really does start at dot 252
//   intr_2_0_timing       the mode 0 interrupt arrives 252 dots after the
//                         mode 2 one, i.e. the mode 2 interrupt is at dot 0
//   intr_2_mode0_timing   but a STAT READ does not show mode 0 until dot 256
//
// Any attempt to satisfy the third by moving a boundary breaks one of the
// first two. The boundaries are right; the register is late.
const MODE2_DOTS = 80;
const STAT_MODE_LAG = 4;

// The four shades a DMG can produce, as the dmg-acid2 README asks them to be
// written so that its reference image can be compared byte for byte.
export const DMG_SHADES = Uint8Array.from([0xff, 0xaa, 0x55, 0x00]);

export class GbPpu {
  constructor({ cgb = false } = {}) {
    this.cgb = cgb;
    // Two banks on a Color, one on a DMG. Bank 1 holds the map ATTRIBUTES —
    // per-tile palette, per-tile flip, per-tile priority — which is how the
    // Color adds colour without changing the tile format.
    this.vram = new Uint8Array(cgb ? 0x4000 : 0x2000);
    this.vbk = 0;
    this.oam = new Uint8Array(160);

    // Output. Sixteen bits per pixel: a shade index 0-3 on a DMG, a 15-bit
    // BGR555 colour on a Color. Output, not state — see the snapshot note in
    // docs/gb-design.md §9.
    this.frameBuf = new Uint16Array(SCREEN_W * SCREEN_H);

    // Colour RAM, 8 palettes of 4 colours for each of background and objects.
    this.bgPal = new Uint8Array(64);
    this.objPal = new Uint8Array(64);
    this.bcps = 0; this.ocps = 0;
    this.opri = 0; // CGB register $FF6C: which object priority rule is in use

    this._lineObjs = [];   // latched at the mode 2 → mode 3 boundary
    this._lineBgIdx = new Uint8Array(SCREEN_W);   // per-pixel background COLOUR INDEX (not shade)
    this._lineBgPrio = new Uint8Array(SCREEN_W);  // CGB: the map attribute's priority bit

    this.powerOn();
  }

  powerOn() {
    this.vram.fill(0);
    this.oam.fill(0);
    this.bgPal.fill(0xff);
    this.objPal.fill(0xff);
    this.reset();
    return this;
  }

  // Post-boot register values. The boot ROM leaves the LCD on with the
  // background enabled and BGP set to the usual dark-on-light ramp, which is
  // why a cartridge that never touches LCDC still draws something.
  reset() {
    this.lcdc = 0x91;
    this.stat = 0x85;
    this.scy = 0; this.scx = 0;
    this.ly = 0; this.lyc = 0;
    this.bgp = 0xfc; this.obp0 = 0xff; this.obp1 = 0xff;
    this.wy = 0; this.wx = 0;
    this.vbk = 0;

    this.mode = MODE.HBLANK;
    this._prevMode = MODE.HBLANK;
    this._absDot = 0;             // monotonic dots, for the STAT lag above
    this._modeChangedAt = -STAT_MODE_LAG;
    this.dot = 0;                 // dots into the current line
    this.mode3End = MODE2_DOTS + 172; // recomputed per line
    this._statLine = false;
    this._lycBit = true;   // LY = LYC = 0 out of the boot ROM
    this._earlyOam = false;
    this._wyTriggered = false;
    this._windowLine = 0;
    this._drewWindow = false;
    // The frame after the LCD is switched on is not shown: hardware needs a
    // full frame to lock, and mooneye's lcdon_timing depends on the first LY=0
    // being shorter than a normal line.
    this._discardFrame = false;
    this._lyForCompare = 0;

    this.vblankReq = false;
    this.statReq = false;
    this.frameComplete = false;
    this.frameBuf.fill(this.cgb ? 0x7fff : 0);
    return this;
  }

  // ---- register file -------------------------------------------------------
  readReg(addr) {
    switch (addr) {
      case 0xff40: return this.lcdc;
      // Bit 7 reads as 1 on hardware, and the mode bits read 0 while the LCD
      // is off — a game polling for mode 0 to write VRAM would otherwise wait
      // forever after switching the screen off.
      // The coincidence bit is LATCHED, not computed on read: switching the
      // PPU off stops the comparison clock, so the bit keeps whatever it said
      // and changing LYC while the screen is off does nothing (mooneye
      // stat_lyc_onoff). The mode bits, having no clock at all, read 0.
      case 0xff41: return (this.stat & 0x78) | 0x80 | (this._lycBit ? 4 : 0) | (this.lcdOn ? this._statMode() : 0);
      case 0xff42: return this.scy;
      case 0xff43: return this.scx;
      case 0xff44: return this.lcdOn ? this._lyForCompare : 0;
      case 0xff45: return this.lyc;
      case 0xff47: return this.bgp;
      case 0xff48: return this.obp0;
      case 0xff49: return this.obp1;
      case 0xff4a: return this.wy;
      case 0xff4b: return this.wx;
      case 0xff4f: return this.cgb ? (this.vbk | 0xfe) : 0xff;
      case 0xff68: return this.cgb ? this.bcps | 0x40 : 0xff;
      case 0xff69: return this.cgb ? this.bgPal[this.bcps & 0x3f] : 0xff;
      case 0xff6a: return this.cgb ? this.ocps | 0x40 : 0xff;
      case 0xff6b: return this.cgb ? this.objPal[this.ocps & 0x3f] : 0xff;
      case 0xff6c: return this.cgb ? (this.opri | 0xfe) : 0xff;
      default: return 0xff;
    }
  }

  writeReg(addr, v) {
    v &= 0xff;
    switch (addr) {
      case 0xff40: {
        const wasOn = this.lcdOn;
        this.lcdc = v;
        const nowOn = this.lcdOn;
        if (wasOn && !nowOn) this._lcdOff();
        else if (!wasOn && nowOn) this._lcdOn();
        break;
      }
      // Only the five source-enable bits are writable; the mode and
      // coincidence bits are the PPU's to report.
      case 0xff41: this.stat = (this.stat & 0x87) | (v & 0x78); this._updateStat(); break;
      case 0xff42: this.scy = v; break;
      case 0xff43: this.scx = v; break;
      case 0xff44: break;                       // LY is read-only
      case 0xff45: this.lyc = v; this._updateStat(); break;
      case 0xff47: this.bgp = v; break;
      case 0xff48: this.obp0 = v; break;
      case 0xff49: this.obp1 = v; break;
      case 0xff4a: this.wy = v; break;
      case 0xff4b: this.wx = v; break;
      case 0xff4f: if (this.cgb) this.vbk = v & 1; break;
      case 0xff68: if (this.cgb) this.bcps = v & 0xbf; break;
      case 0xff69: if (this.cgb) {
        this.bgPal[this.bcps & 0x3f] = v;
        // Auto-increment: the game writes 64 bytes in a row without touching
        // the index register again, which is the whole point of the pair.
        if (this.bcps & 0x80) this.bcps = 0x80 | ((this.bcps + 1) & 0x3f);
      } break;
      case 0xff6a: if (this.cgb) this.ocps = v & 0xbf; break;
      case 0xff6b: if (this.cgb) {
        this.objPal[this.ocps & 0x3f] = v;
        if (this.ocps & 0x80) this.ocps = 0x80 | ((this.ocps + 1) & 0x3f);
      } break;
      case 0xff6c: if (this.cgb) this.opri = v & 1; break;
      default: break;
    }
  }

  get lcdOn() { return (this.lcdc & 0x80) !== 0; }

  // See STAT_MODE_LAG. `_absDot` is a monotonic dot counter so that a
  // transition can be compared with "now" across a line boundary.
  _statMode() { return (this._absDot - this._modeChangedAt) < STAT_MODE_LAG ? this._prevMode : this.mode; }

  _setMode(m) {
    if (m === this.mode) return;
    this._prevMode = this.mode;
    this._modeChangedAt = this._absDot;
    this.mode = m;
  }

  // Switching the LCD off resets the raster to the top of the frame and blanks
  // the picture. The blanking is not cosmetic: it is what keeps the frame
  // buffer a function of STATE rather than of history, so that rewinding to a
  // frame boundary and replaying produces the same image. (The Seta machine
  // learned this the expensive way — see docs/gb-design.md §9.)
  _lcdOff() {
    this.mode = MODE.HBLANK;
    this._prevMode = MODE.HBLANK;
    this._modeChangedAt = this._absDot - STAT_MODE_LAG;
    this.dot = 0;
    this.ly = 0;
    this._lyForCompare = 0;
    this._windowLine = 0;
    this._wyTriggered = false;
    this._statLine = false;
    this._earlyOam = false;
    this.frameBuf.fill(this.cgb ? 0x7fff : 0);
  }

  _lcdOn() {
    this.dot = 0;
    this.ly = 0;
    this._lyForCompare = 0;
    this._windowLine = 0;
    this._wyTriggered = false;
    this._discardFrame = true;
    // The first line after power-on runs mode 0 where mode 2 would be: the
    // OAM scan does not happen, so no OAM STAT interrupt fires on that line.
    this.mode = MODE.HBLANK;
    this._prevMode = MODE.HBLANK;
    this._modeChangedAt = this._absDot - STAT_MODE_LAG;
    this._statLine = false;
    this._updateStat();
  }

  // ---- CPU access to VRAM and OAM -----------------------------------------
  // The CPU and the PPU share these buses. While the PPU is using one, the
  // CPU's read returns $FF and its write is dropped. Games rely on both
  // directions: they wait for mode 0 before uploading tiles, and they *also*
  // rely on being able to touch OAM during mode 0 and vblank only.
  // These follow the LAGGED mode, not the real one: mooneye's
  // intr_2_oam_ok_timing measures when OAM becomes readable again after the
  // mode 2 interrupt and gets the same answer as intr_2_mode0_timing gets for
  // when STAT shows mode 0 — so the lock and the register move together.
  canAccessVram() { return !this.lcdOn || this._statMode() !== MODE.DRAW; }
  canAccessOam() { const m = this._statMode(); return !this.lcdOn || (m !== MODE.OAM && m !== MODE.DRAW); }

  readVram(addr, bank = this.vbk) {
    if (!this.canAccessVram()) return 0xff;
    return this.vram[(addr & 0x1fff) | (this.cgb && bank ? 0x2000 : 0)];
  }

  writeVram(addr, v, bank = this.vbk) {
    if (!this.canAccessVram()) return;
    this.vram[(addr & 0x1fff) | (this.cgb && bank ? 0x2000 : 0)] = v;
  }

  readOam(addr) { return this.canAccessOam() ? this.oam[addr & 0xff] : 0xff; }
  writeOam(addr, v) { if (this.canAccessOam()) this.oam[addr & 0xff] = v; }
  // DMA writes to OAM go through the PPU's own port, not the CPU's, so they
  // are not blocked the way a CPU write is.
  writeOamDma(addr, v) { this.oam[addr & 0xff] = v; }

  // ---- the clock -----------------------------------------------------------
  // `t` dots. The machine calls this with 4 (or 2 in CGB double speed) per
  // M-cycle; the loop below is written to survive any step size because the
  // DMA and speed-switch paths use odd ones.
  tick(t) {
    if (!this.lcdOn) return;
    while (t > 0) {
      const next = this._nextEventDot();
      const step = Math.min(t, next - this.dot);
      this.dot += step;
      this._absDot += step;
      t -= step;
      if (this.dot >= next) this._event();
    }
  }

  // The dot at which the current line's next state change happens. Four
  // candidates, and the one at 452 is the surprise: the STAT interrupt that
  // means "a new line's OAM scan is starting" is raised ONE M-CYCLE BEFORE the
  // line does. It is not an off-by-one, it is how the circuit is built, and
  // mooneye's intr_2_* tests measure the gap between that interrupt and the
  // mode 3 / mode 0 boundaries to the dot. Without the four dots every one of
  // them lands one loop iteration early.
  _nextEventDot() {
    if (this.ly === LINES_PER_FRAME - 1 && this.dot < 4) return 4;
    let n = DOTS_PER_LINE;
    // Line 144's OAM STAT source has to be taken back down at the point the
    // scan would have ended, on a line that has no mode 2 at all.
    if (this._earlyOam && this.dot < MODE2_DOTS) n = Math.min(n, MODE2_DOTS);
    if (this.ly < SCREEN_H) {
      if (this.mode === MODE.OAM && this.dot < MODE2_DOTS) return MODE2_DOTS;
      if (this.mode === MODE.DRAW && this.dot < this.mode3End) return Math.min(n, this.mode3End);
    }
    return n;
  }

  _event() {
    if (this.dot >= DOTS_PER_LINE) { this._endOfLine(); return; }
    if (this.ly === LINES_PER_FRAME - 1 && this.dot >= 4 && this.dot < DOTS_PER_LINE) {
      // Line 153 is the odd one: LY reads 153 for four dots and then reads 0
      // for the rest of the line, while the line itself runs to completion.
      // Games use LYC=0 to get an interrupt at the very top of the frame and
      // would get it a line early without this.
      if (this._lyForCompare !== 0) { this._lyForCompare = 0; this._updateStat(); return; }
    }
    if (this.ly < SCREEN_H && this.mode === MODE.OAM) {
      // End of the OAM scan: the object list for this line is now fixed, and
      // with it the length of mode 3.
      this._latchObjects();
      this._setMode(MODE.DRAW);
      this.mode3End = MODE2_DOTS + this._mode3Length();
      this._earlyOam = false;
      this._updateStat();
      return;
    }
    if (this.ly < SCREEN_H && this.mode === MODE.DRAW) {
      this._renderLine();
      this._setMode(MODE.HBLANK);
      this._updateStat();
      return;
    }
    // A vblank line taking the early signal back down at dot 80.
    this._earlyOam = false;
    this._updateStat();
  }

  _endOfLine() {
    this.dot -= DOTS_PER_LINE;
    this.ly++;
    if (this.ly === LINES_PER_FRAME) {
      this.ly = 0;
      this._windowLine = 0;
      this._wyTriggered = false;
      this._discardFrame = false;
    }
    this._lyForCompare = this.ly;

    if (this.ly === SCREEN_H) {
      this._setMode(MODE.VBLANK);
      // Vblank still begins with what is electrically an OAM slot, so a game
      // that only enabled the mode 2 STAT source gets an interrupt here too.
      this._earlyOam = true;
      // The one interrupt that is an edge, not a level. It fires even on the
      // frame the LCD does not display, because it is the raster reaching the
      // bottom, not the picture being finished.
      this.vblankReq = true;
      this.frameComplete = true;
    } else if (this.ly < SCREEN_H) {
      this._setMode(MODE.OAM);
      // WY is compared against LY once per line, and once it has matched the
      // window is armed for the REST OF THE FRAME — moving WY back down later
      // does not disarm it. Games use that to open the window part-way down.
      if (this.ly === this.wy) this._wyTriggered = true;
    }
    this._updateStat();
  }

  _lycEq() { return this._lyForCompare === this.lyc; }

  // The four STAT sources are ORed into one wire; the interrupt is the wire's
  // rising edge. Everything that can change any of the four calls this.
  _updateStat() {
    if (!this.lcdOn) { this._statLine = false; return; }
    this._lycBit = this._lycEq();
    const s = this.stat;
    const line = ((s & 0x08) && this.mode === MODE.HBLANK)
      || ((s & 0x10) && this.mode === MODE.VBLANK)
      // The OAM source is high from four dots before the line starts until
      // the OAM scan ends — including on line 144, which the hardware still
      // begins with what is electrically an OAM slot even though it is vblank.
      || ((s & 0x20) && (this.mode === MODE.OAM || this._earlyOam))
      || ((s & 0x40) && this._lycBit);
    if (line && !this._statLine) this.statReq = true;
    this._statLine = !!line;
  }

  // ---- how long mode 3 lasts ----------------------------------------------
  // 172 dots is the floor. Then:
  //   + SCX & 7   the fetcher throws away that many pixels at the left edge
  //   + 6         opening the window costs a fetcher restart
  //   + per object, 6 dots, plus up to 5 more when the object is the first one
  //     to land in its 8-pixel column and the fetcher has to be interrupted
  //     mid-tile.
  // The object term is an approximation of a FIFO this renderer does not have;
  // docs/gb-design.md §11 says which test that costs.
  _mode3Length() {
    let len = 172 + (this.scx & 7);
    if ((this.lcdc & 0x20) && this._wyTriggered && this.wx <= 166) len += 6;
    if (this.lcdc & 0x02) {
      let lastColumn = -1;
      for (const o of this._lineObjs) {
        len += 6;
        const column = (o.x + (this.scx & 7)) >> 3;
        if (column !== lastColumn) {
          const extra = 5 - ((o.x + this.scx) & 7);
          if (extra > 0) len += extra;
          lastColumn = column;
        }
      }
    }
    return Math.min(len, 289);
  }

  // ---- the object list -----------------------------------------------------
  // Selection is by Y only, in OAM order, and it stops at ten. An object at
  // X=0 is off-screen but still consumes one of the ten — which is exactly the
  // trick dmg-acid2 uses to check the limit.
  _latchObjects() {
    const objs = this._lineObjs;
    objs.length = 0;
    if (!(this.lcdc & 0x02)) return;
    const h = (this.lcdc & 0x04) ? 16 : 8;
    const oam = this.oam, ly = this.ly;
    for (let i = 0; i < 40 && objs.length < 10; i++) {
      const y = oam[i * 4] - 16;
      if (ly < y || ly >= y + h) continue;
      objs.push({ y, x: oam[i * 4 + 1] - 8, tile: oam[i * 4 + 2], attr: oam[i * 4 + 3], idx: i });
    }
    // Drawing order. On a DMG the object with the smaller X is in front, and
    // OAM order only breaks the tie. On a Color the OAM index alone decides —
    // unless the game asks for the DMG rule with $FF6C, which is what a Color
    // does when it is running a black-and-white cartridge.
    const dmgRule = !this.cgb || this.opri === 1;
    if (dmgRule) objs.sort((a, b) => (a.x - b.x) || (a.idx - b.idx));
    else objs.sort((a, b) => a.idx - b.idx);
  }

  // ---- painting one line ---------------------------------------------------
  _renderLine() {
    if (this._discardFrame) return;
    const ly = this.ly;
    this._drewWindow = false;
    this._paintBackground(ly);
    if (this.lcdc & 0x02) this._paintObjects(ly);
    if (this._drewWindow) this._windowLine++;
  }

  _paintBackground(ly) {
    const out = this.frameBuf, base = ly * SCREEN_W;
    const bgIdx = this._lineBgIdx, bgPrio = this._lineBgPrio;
    // LCDC bit 0 means two different things. On a DMG it switches the
    // background AND the window off, and the screen shows colour 0 through
    // BGP. On a Color it does not blank anything — it drops the background's
    // priority so every object is drawn in front of it.
    const bgEnabled = this.cgb || (this.lcdc & 0x01) !== 0;
    const winEnabled = bgEnabled && (this.lcdc & 0x20) !== 0 && this._wyTriggered;
    const wx = this.wx - 7;
    const tileBase = (this.lcdc & 0x10) ? 0x0000 : 0x1000;
    const signedTiles = (this.lcdc & 0x10) === 0;
    const bgMap = (this.lcdc & 0x08) ? 0x1c00 : 0x1800;
    const winMap = (this.lcdc & 0x40) ? 0x1c00 : 0x1800;
    const vram = this.vram;

    for (let x = 0; x < SCREEN_W; x++) {
      let idx = 0, prio = 0, colour = 0;
      if (bgEnabled) {
        const inWindow = winEnabled && x >= wx && this.wx <= 166;
        let mapAddr, fineX, fineY;
        if (inWindow) {
          this._drewWindow = true;
          const wxp = x - wx, wyp = this._windowLine;
          mapAddr = winMap + ((wyp >> 3) & 31) * 32 + ((wxp >> 3) & 31);
          fineX = wxp & 7; fineY = wyp & 7;
        } else {
          const bx = (x + this.scx) & 0xff, by = (ly + this.scy) & 0xff;
          mapAddr = bgMap + ((by >> 3) & 31) * 32 + ((bx >> 3) & 31);
          fineX = bx & 7; fineY = by & 7;
        }
        const tileNo = vram[mapAddr];
        const attr = this.cgb ? vram[mapAddr + 0x2000] : 0;
        if (attr & 0x40) fineY = 7 - fineY;            // vertical flip
        const bank = (attr & 0x08) ? 0x2000 : 0;
        const tileAddr = (signedTiles ? tileBase + (((tileNo << 24) >> 24) * 16) : tileBase + tileNo * 16) + fineY * 2;
        const lo = vram[bank + (tileAddr & 0x1fff)], hi = vram[bank + ((tileAddr + 1) & 0x1fff)];
        const bit = (attr & 0x20) ? fineX : 7 - fineX; // horizontal flip
        idx = ((hi >> bit) & 1) << 1 | ((lo >> bit) & 1);
        prio = (attr & 0x80) ? 1 : 0;
        colour = this.cgb ? this._cgbColour(this.bgPal, attr & 7, idx) : ((this.bgp >> (idx * 2)) & 3);
      } else {
        colour = this.cgb ? this._cgbColour(this.bgPal, 0, 0) : (this.bgp & 3);
      }
      bgIdx[x] = idx;
      bgPrio[x] = prio;
      out[base + x] = colour;
    }
  }

  _paintObjects(ly) {
    const out = this.frameBuf, base = ly * SCREEN_W;
    const bgIdx = this._lineBgIdx, bgPrio = this._lineBgPrio;
    const h = (this.lcdc & 0x04) ? 16 : 8;
    const vram = this.vram;
    // Painted back to front, so the highest-priority object (first in the
    // sorted list) ends up on top without a per-pixel search.
    for (let n = this._lineObjs.length - 1; n >= 0; n--) {
      const o = this._lineObjs[n];
      if (o.x <= -8 || o.x >= SCREEN_W) continue;
      let row = ly - o.y;
      if (o.attr & 0x40) row = h - 1 - row;
      // In 8x16 mode the low bit of the tile number is ignored: the object is
      // two consecutive tiles and the hardware supplies the bit itself.
      const tile = h === 16 ? (o.tile & 0xfe) : o.tile;
      const bank = (this.cgb && (o.attr & 0x08)) ? 0x2000 : 0;
      const addr = tile * 16 + row * 2;
      const lo = vram[bank + (addr & 0x1fff)], hi = vram[bank + ((addr + 1) & 0x1fff)];
      const pal = this.cgb ? (o.attr & 7) : ((o.attr & 0x10) ? this.obp1 : this.obp0);
      for (let px = 0; px < 8; px++) {
        const x = o.x + px;
        if (x < 0 || x >= SCREEN_W) continue;
        const bit = (o.attr & 0x20) ? px : 7 - px;
        const idx = ((hi >> bit) & 1) << 1 | ((lo >> bit) & 1);
        if (idx === 0) continue;                        // colour 0 of an object is transparency
        // Priority. Colour 0 of the background always loses. Otherwise the
        // object's own priority bit decides on a DMG; on a Color the map
        // attribute can also claim the front, and LCDC bit 0 is a master
        // switch that hands every argument to the objects.
        if (bgIdx[x] !== 0) {
          if (this.cgb) {
            if ((this.lcdc & 0x01) && ((o.attr & 0x80) || bgPrio[x])) continue;
          } else if (o.attr & 0x80) continue;
        }
        out[base + x] = this.cgb ? this._cgbColour(this.objPal, pal, idx) : ((pal >> (idx * 2)) & 3);
      }
    }
  }

  // Colour RAM is little-endian BGR555, two bytes per colour.
  _cgbColour(pal, n, idx) {
    const o = n * 8 + idx * 2;
    return (pal[o] | (pal[o + 1] << 8)) & 0x7fff;
  }

  // ---- output --------------------------------------------------------------
  // Plain data, like machine88.render() and machinenes.render(). The 8-bit
  // values for a DMG are the ones dmg-acid2 asks for so that its reference
  // image can be compared without a tolerance; the Color conversion is the
  // formula from the same README.
  toRgb(out = null) {
    const n = SCREEN_W * SCREEN_H;
    const rgb = out && out.length === n * 3 ? out : new Uint8Array(n * 3);
    const buf = this.frameBuf;
    if (this.cgb) {
      for (let i = 0; i < n; i++) {
        const c = buf[i];
        const r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31;
        rgb[i * 3] = (r << 3) | (r >> 2);
        rgb[i * 3 + 1] = (g << 3) | (g >> 2);
        rgb[i * 3 + 2] = (b << 3) | (b >> 2);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const v = DMG_SHADES[buf[i] & 3];
        rgb[i * 3] = v; rgb[i * 3 + 1] = v; rgb[i * 3 + 2] = v;
      }
    }
    return rgb;
  }

  // ---- time travel ---------------------------------------------------------
  getState() {
    return {
      vram: this.vram.slice(),
      oam: this.oam.slice(),
      vbk: this.vbk,
      lcdc: this.lcdc, stat: this.stat, scy: this.scy, scx: this.scx,
      ly: this.ly, lyc: this.lyc, bgp: this.bgp, obp0: this.obp0, obp1: this.obp1,
      wy: this.wy, wx: this.wx,
      mode: this.mode, prevMode: this._prevMode, absDot: this._absDot,
      modeChangedAt: this._modeChangedAt, dot: this.dot, mode3End: this.mode3End,
      statLine: this._statLine, lycBit: this._lycBit, earlyOam: this._earlyOam, wyTriggered: this._wyTriggered,
      windowLine: this._windowLine, discardFrame: this._discardFrame,
      lyForCompare: this._lyForCompare,
      bgPal: this.cgb ? this.bgPal.slice() : null,
      objPal: this.cgb ? this.objPal.slice() : null,
      bcps: this.bcps, ocps: this.ocps, opri: this.opri,
      // The object list is derived from OAM and LY, but it is latched at a
      // boundary that a snapshot can fall between, so it travels too.
      lineObjs: this._lineObjs.map((o) => [o.y, o.x, o.tile, o.attr, o.idx]),
      vblankReq: this.vblankReq, statReq: this.statReq,
    };
  }

  setState(s) {
    this.vram.set(s.vram);
    this.oam.set(s.oam);
    this.vbk = s.vbk;
    this.lcdc = s.lcdc; this.stat = s.stat; this.scy = s.scy; this.scx = s.scx;
    this.ly = s.ly; this.lyc = s.lyc; this.bgp = s.bgp; this.obp0 = s.obp0; this.obp1 = s.obp1;
    this.wy = s.wy; this.wx = s.wx;
    this.mode = s.mode; this._prevMode = s.prevMode; this._absDot = s.absDot;
    this._modeChangedAt = s.modeChangedAt; this.dot = s.dot; this.mode3End = s.mode3End;
    this._statLine = s.statLine; this._lycBit = !!s.lycBit;
    this._earlyOam = !!s.earlyOam; this._wyTriggered = s.wyTriggered;
    this._windowLine = s.windowLine; this._discardFrame = s.discardFrame;
    this._lyForCompare = s.lyForCompare;
    if (s.bgPal) this.bgPal.set(s.bgPal);
    if (s.objPal) this.objPal.set(s.objPal);
    this.bcps = s.bcps; this.ocps = s.ocps; this.opri = s.opri;
    this._lineObjs = s.lineObjs.map(([y, x, tile, attr, idx]) => ({ y, x, tile, attr, idx }));
    this.vblankReq = s.vblankReq; this.statReq = s.statReq;
    return this;
  }
}
