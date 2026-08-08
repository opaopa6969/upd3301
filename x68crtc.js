// x68crtc — the X68000's CRT controller.
//
// Sharp did not buy a CRTC for this machine, they designed one, and it shows.
// Where a PC-8801's µPD3301 counts characters, this part counts dots and lets
// software set every edge of the raster: horizontal total, sync width, the two
// display edges, the same four vertically, plus a programmable line at which
// it raises an interrupt. That is why X68000 games change resolution mid-frame
// and why a 512x512 screen and a 768x512 screen are the same hardware with
// different numbers in R00-R07.
//
// It also owns three things that are not "timing" at all, because they need
// the video memory bus and the CRTC is what has it:
//
//   * the raster copy — one text scanline copied to another, per plane, in
//     hardware. Text scrolling is built on it.
//   * the fast clear — one whole plane wiped during the next vertical blank
//     without the CPU touching it.
//   * the memory mode register R20, which decides how many colours the
//     graphics planes have and therefore what an address into graphics VRAM
//     even means. See x68video.js.
//
// ## Geometry
//
// The visible width is (R03 - R02) * 8 dots and the visible height is
// R07 - R06 raster lines. Two bits of R20 then say how those raster lines map
// to picture lines: at 31 kHz with the 256-line flag clear each raster is a
// picture line; the low-resolution 512-line mode doubles them; the
// high-resolution 256-line mode halves them. `verticalStep` carries that
// factor in halves so the arithmetic stays integer.
//
// Pure, deterministic, zero deps. This file holds no pixels — it tells
// x68video.js where they go.

export const SCHEMA_VERSION = 1;

// 68000 clocks in one frame. The machine's dot clock is derived from the same
// crystal, so a frame is an exact integer of CPU cycles in both modes: 15.98
// kHz horizontal gives 61.46 Hz, 31.5 kHz gives 55.46 Hz.
export const CLOCKS_PER_FRAME_NORMAL = 162707;
export const CLOCKS_PER_FRAME_HIGH = 180310;

const REGS = 48; // 24 registers, two bytes each

export class X68Crtc {
  // `onRasterCopy(srcLine, dstLine, planeMask)` and `onFastClear(planeMask)`
  // are the two operations that reach into video memory. The CRTC decides
  // when; x68video.js decides what the bytes are.
  constructor({ onRasterCopy = null, onFastClear = null } = {}) {
    this.onRasterCopy = onRasterCopy;
    this.onFastClear = onFastClear;
    this.reg = new Uint8Array(REGS);
    this.reset();
  }

  reset() {
    this.reg.fill(0);
    // The IPL programs everything before it turns the display on, but a
    // machine that starts with a zero total line count divides by zero on the
    // first frame. These are the 768x512 / 31 kHz numbers the IPL settles on.
    this.writeReg(0x00, 0x00); this.writeReg(0x01, 0x89);  // R00 H total
    this.writeReg(0x08, 0x02); this.writeReg(0x09, 0x8a);  // R04 V total = 650
    this.writeReg(0x0c, 0x00); this.writeReg(0x0d, 0x28);  // R06 V start
    this.writeReg(0x0e, 0x02); this.writeReg(0x0f, 0x28);  // R07 V end
    this.writeReg(0x04, 0x00); this.writeReg(0x05, 0x0a);  // R02 H start
    this.writeReg(0x06, 0x00); this.writeReg(0x07, 0x5a);  // R03 H end
    this.writeReg(0x29, 0x15);                             // R20 lo: 31 kHz, 512 lines

    this.mode = 0;            // $E80481, the operation port
    this.fastClear = 0;       // frames of fast-clear still to run
    this.fastClearMask = 0;
    this.rcFlag = [false, false];
    this._recompute();
    return this;
  }

  // ---- registers -------------------------------------------------------------
  // R00-R23 live at $E80000 as big-endian byte pairs; the operation port is a
  // separate byte at $E80481. Registers above R23 do not exist.
  read(a) {
    if ((a & 0x7ff) === 0x481) {
      // The fast-clear bit reads back as 1 only while the wipe is running —
      // writing it does not make it appear, the next vertical blank does.
      return this.fastClear ? (this.mode | 0x02) : (this.mode & 0xfd);
    }
    const r = a & 0x3f;
    // Only the raster-copy and fast-clear registers read back. The timing
    // registers are write-only on this part.
    if (r >= 0x28 && r <= 0x2b) return this.reg[r];
    return 0x00;
  }

  write(a, v) {
    v &= 0xff;
    if ((a & 0x7ff) === 0x481) { this._writeMode(v); return; }
    const r = a & 0x3f;
    if (r >= REGS) return;
    if (this.reg[r] === v && r !== 0x2c && r !== 0x2d) return;
    this.writeReg(r, v);
  }

  writeReg(r, v) {
    this.reg[r] = v & 0xff;
    if (r === 0x2c || r === 0x2d) {
      // R22 is the raster-copy source/destination pair. Programs leave the
      // copy bit of the operation port set and just keep changing these, so
      // the copy has to fire on the write, not on the mode bit. It fires when
      // the DESTINATION is written, because that is the one that says "now".
      this.rcFlag[r - 0x2c] = true;
      if ((this.mode & 0x08) && this.rcFlag[1]) this._rasterCopy();
      return;
    }
    this._recompute();
  }

  _writeMode(v) {
    // Bit 1 is owned by the fast-clear machinery, not by the program.
    this.mode = (v | (this.mode & 0x02)) & 0xff;
    if (this.mode & 0x08) { this._rasterCopy(); }
    if (this.mode & 0x02) {
      this.fastClearPending = true;
      // The mask latched at the moment of the write is the one that applies,
      // even if the program changes R21 before the blank arrives.
      this.fastClearMask = this.reg[0x2b] & 0x0f;
    }
  }

  _rasterCopy() {
    const src = this.reg[0x2c];
    const dst = this.reg[0x2d];
    const planes = this.reg[0x2b] & 0x0f;
    if (this.onRasterCopy) this.onRasterCopy(src, dst, planes);
    this.rcFlag[0] = false;
    this.rcFlag[1] = false;
  }

  // Called once per frame by the machine, at the end. The fast clear takes one
  // vertical sync period at 31 kHz and two at 15 kHz — programs time other
  // work against it, so it cannot be instantaneous.
  endFrame() {
    if (this.mode & 0x02) {
      if (this.fastClear) {
        if (--this.fastClear === 0) this.mode &= 0xfd;
      } else {
        this.fastClear = (this.reg[0x29] & 0x10) ? 1 : 2;
        // The wipe clears the NOT-selected nibbles: R21's four bits name the
        // planes to KEEP. x68video.js applies the mask.
        if (this.onFastClear) this.onFastClear(this.fastClearMask);
      }
    }
    return this;
  }

  // ---- derived geometry -------------------------------------------------------
  _recompute() {
    const r = this.reg;
    const w = (h, l) => ((r[h] << 8) | r[l]);
    this.hTotal = w(0x00, 0x01);
    this.hSyncEnd = w(0x02, 0x03);
    this.hStart = w(0x04, 0x05);
    this.hEnd = w(0x06, 0x07);
    this.vTotal = w(0x08, 0x09) || 1;
    this.vSyncEnd = w(0x0a, 0x0b);
    this.vStart = w(0x0c, 0x0d);
    this.vEnd = w(0x0e, 0x0f);
    this.hAdjust = w(0x10, 0x11);
    this.intLine = w(0x12, 0x13) & 1023;
    this.textScrollX = w(0x14, 0x15) & 1023;
    this.textScrollY = w(0x16, 0x17) & 1023;
    this.graphScrollX = [
      w(0x18, 0x19) & 1023, w(0x1c, 0x1d) & 511, w(0x20, 0x21) & 511, w(0x24, 0x25) & 511,
    ];
    this.graphScrollY = [
      w(0x1a, 0x1b) & 1023, w(0x1e, 0x1f) & 511, w(0x22, 0x23) & 511, w(0x26, 0x27) & 511,
    ];

    const lo = r[0x29];
    this.highReso = (lo & 0x10) !== 0;
    // Two bits, three cases. `verticalStep` is in halves of a raster line:
    // 2 = one picture line per raster, 1 = a raster is half a line (high-res
    // 256), 4 = a raster is two lines (low-res 512).
    const vBits = lo & 0x14;
    this.verticalStep = vBits === 0x10 ? 1 : vBits === 0x04 ? 4 : 2;
    this.colourMode = r[0x28] & 0x03;      // 0/1 = 16 colour, 2 = 256, 3 = 65536
    this.wide = (r[0x28] & 0x04) !== 0;    // the 1024x1024 layout
    this.dotClock = lo & 0x03;

    // With bits 2, 3 and 4 all set the CRTC runs a doubled vertical: one
    // displayed line advances TWO rasters of video memory.
    this.doubleScan = (lo & 0x1c) === 0x1c;

    const dotsX = (this.hEnd - this.hStart) * 8;
    const rasters = this.vEnd - this.vStart;
    this.width = dotsX > 0 ? Math.min(dotsX, 1024) : 0;
    const h = (rasters * this.verticalStep) / 2;
    this.height = h > 0 ? Math.min(h | 0, 1024) : 0;
    this.clocksPerFrame = this.highReso ? CLOCKS_PER_FRAME_HIGH : CLOCKS_PER_FRAME_NORMAL;
    this.clocksPerLine = (this.clocksPerFrame / this.vTotal) | 0;
  }

  // Which picture line a given raster line draws, or -1 outside the display.
  pictureLine(vline) {
    if (vline < this.vStart || vline >= this.vEnd) return -1;
    return (((vline - this.vStart) * this.verticalStep) / 2) | 0;
  }

  // ---- state -------------------------------------------------------------------
  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      reg: Array.from(this.reg),
      mode: this.mode, fastClear: this.fastClear, fastClearMask: this.fastClearMask,
      rcFlag: [...this.rcFlag],
    };
  }

  setState(s) {
    this.reg.set(s.reg);
    this.mode = s.mode; this.fastClear = s.fastClear; this.fastClearMask = s.fastClearMask;
    this.rcFlag = [...s.rcFlag];
    this._recompute();
    return this;
  }
}

export default X68Crtc;
