// machine88 — PC-8801 (mkII SR and friends).
//
// The text pipeline is the SAME silicon as the PC-8001: μPD3301 + μPD8257,
// DMA channel 2, VRAM in main RAM. What the 8801 adds — and what this file
// is — is the layer the 8001 never had:
//
// - Bank switching. 0000-7FFF is ROM (N88 main, or N80 in N-mode) or RAM
//   (port 31h bit1); 6000-7FFF can instead be one of 4 extension ROM banks
//   (port 71h). C000-FFFF is main RAM or one GVRAM plane (ports 5Ch-5Fh).
// - Interrupts through a μPD8214 priority controller (ports E4h/E6h) —
//   8801 BASIC is interrupt-driven, not a polling loop. VRTC is level 1,
//   IM2 vectors from the level.
// - GVRAM: three 16KB planes (B, R, G) = 640x200 per-dot color, composited
//   *under* the text layer.
// - SR's V2 palette: 8 entries from a 512-color cube (3 bits per gun),
//   ports 54h-5Bh. Yes — the same 512 cube we dithered video into.
//
// Bring your own ROM: pass {main, ext, n80} images (see tools/split-pc88rom).
// Pure, deterministic, headless-testable. No ROM ships with this repo.

import { Z80 } from './z80.js';
import { Upd3301 } from './index.js';
import { Upd8257 } from './upd8257.js';
import { renderScreen } from './pc8001.js';
import { I8255, crossWire } from './i8255.js';
import { Pc80s31 } from './pc80s31.js';
import { snapObj, restoreObj } from './snap.js';
import { Ym2203 } from './ym2203.js';
import { Ym2608 } from './ym2608.js';

export const SCHEMA_VERSION = 1;

const GVRAM_SIZE = 0x4000; // 16KB per plane, window at C000-FFFF

export class Pc8801Machine {
  constructor({
    main, ext = null, n80 = null, sub = null, mode = 'n88',
    frameHz = 60, clockHz = 3_993_600, dmaSteal = 0.3, sb2 = false,
    kanji = null, kanji2 = null,
  } = {}) {
    if (!main || main.length < 0x8000) throw new Error('need a 32KB N88 main ROM');
    this.romMain = main;
    this.romExt = ext; // 4 x 8KB banks (6000-7FFF)
    this.romN80 = n80;

    // Kanji ROM (第1/第2水準, 128 KB each). PC-8801 games read a 16×16 glyph
    // through I/O ports (0xE8/0xE9 for level-1, 0xEC/0xED for level-2) and blit
    // it into GVRAM themselves — the text screen has no hardware kanji mode. So
    // implementing the READ ports is all it takes for kanji to appear (in the
    // graphics layer we already render). Without it those reads returned 0xFF →
    // the game blitted an all-ones 16×16 block = the "white box" per kanji.
    // Address model (QUASI88/xmil): a 16-bit word address; byte = rom[addr*2 +
    // (port&1)]. The game computes the address (incl. the row), so we just index.
    this.kanjiRom = kanji ? (kanji instanceof Uint8Array ? kanji : Uint8Array.from(kanji)) : null;
    this.kanji2Rom = kanji2 ? (kanji2 instanceof Uint8Array ? kanji2 : Uint8Array.from(kanji2)) : null;
    this.kanjiAddr = 0; this.kanji2Addr = 0;

    // disk sub-system: a second Z80 running disk.rom, reached only through
    // the crossed 8255 pair at FCh-FFh. Without a sub ROM the ports float
    // high and the boot ROM times out into BASIC, same as a drive-less 88.
    this.sub = sub ? new Pc80s31({ rom: sub, clockHz }) : null;
    this.pio = this.sub ? new I8255() : null;
    if (this.sub) crossWire(this.pio, this.sub.pio);

    // power-on DRAM reads mostly-high on the real board, and the boot ROM
    // *depends* on it: the drive-presence tables at EF2D/EF35 are only
    // written by an option ROM's hook — absent one, bit4 of the power-on
    // garbage must read 1 ("no drive") or the ROM invents phantom drives
    // and boots from them instead of the sub-system.
    this.ram = new Uint8Array(0x10000).fill(0xff);
    this.gvram = [new Uint8Array(GVRAM_SIZE), new Uint8Array(GVRAM_SIZE), new Uint8Array(GVRAM_SIZE)];
    // Dedicated 4 KB TEXT VRAM (mkII SR V2). It is PHYSICALLY separate from main
    // RAM: the CRTC's DMA always reads this, while the CPU sees it at 0xF000-
    // 0xFFFF only when port32 bit4 == 0 (bit4 == 1 swaps in main RAM there as a
    // scratch area). Ys II fills the top/bottom mask into tvram, then uses main
    // RAM at 0xF000 as scroll scratch — without the split we were rendering the
    // scratch (full-screen magenta semigraphics) as the text plane. (M88:
    // pc88.cpp ConnectRd(GetTVRAM(),0xf000,0x1000); memory.cpp UpdateF0.)
    this.tvram = new Uint8Array(0x1000);

    // bank state
    this.romEnabled = true; // port 31h bit1 = 0 → ROM at 0000-7FFF
    // 'n80' = the machine's N-BASIC mode (the DIP switch / mode selector).
    // It needs no disk sub-system, so it boots on a bare emulated machine.
    this.n80mode = mode === 'n80';
    this.extMapped = false; // port 71h bit0=0 → ext ROM at 6000-7FFF
    this._port71 = 0xff; // the raw latch (read back by the call dispatcher)
    this._port31 = 0;
    // SR's GVRAM ALU: three planes written in ONE cycle, with logic ops and
    // a colour-compare read. It is why SR games scroll at all. 34h picks the
    // op per plane, 35h the mode/compare/enable, 32h b6 turns the window on.
    this._alu1 = 0; // per-plane op (bits: B=0x11, R=0x22, G=0x44)
    this._alu2 = 0; // b0-2 compare colour, b4-5 mode, b7 = VRAM (not RAM)
    this._aluBuf = [0, 0, 0]; // latched planes from the last ALU read
    this._port32 = 0; // bits 0-1 = EROMSL (which ext bank)
    this.gvramWindow = -1; // -1 = RAM at C000-FFFF; 0..2 = plane B/R/G
    this.gvramOn = false; // port 31h bit3
    this._port53 = 0; // port 53h display mask: b0 text-off, b1 graph-off
    this.mono = false;
    this.line400 = false;

    // palette: 8 entries, 3 bits per gun (SR V2 → 512-color cube)
    this.palette = new Uint8Array(8 * 3);
    for (let i = 0; i < 8; i++) { // power-up: the 8 primaries at full level
      this.palette[i * 3] = (i & 2) ? 7 : 0; // R
      this.palette[i * 3 + 1] = (i & 4) ? 7 : 0; // G
      this.palette[i * 3 + 2] = (i & 1) ? 7 : 0; // B
    }
    this._palLatch = 0;

    // interrupts (μPD8214 priority controller)
    // E4h: acceptance threshold — source n is delivered while its level ≤
    //      threshold (SIO=1, VSYNC=2, RTC=3, SOUND=5); bit3 = open all.
    //      Accepting an interrupt RESETS the threshold to 0: every handler
    //      re-arms via OUT E4h. (This is why 8801 BASIC writes E4h a lot.)
    // E6h: per-source enable — bit0 RTC (1/600s), bit1 VSYNC, bit2 SIO.
    // IM2 vector low byte = source number × 2 (SIO=0, VSYNC=1, RTC=2, SND=4).
    this.intLevels = 0;
    this.intMaskBits = 0;
    this.intPending = 0; // bit per source number

    this._opnCyc = 0; // OPN-timer cycle accumulator (in real master clocks)
    this._opnIrqPrev = false; // rising-edge detect for the SOUND IRQ
    // the OPN runs at full clock; the CPU budget is dmaSteal-reduced. Scale
    // CPU cycles → real clocks so the sound-chip timer keeps real time.
    this._opnClkPerCpu = (clockHz / frameHz) / (Math.round(clockHz / frameHz * (1 - dmaSteal)));
    this._pioLast = -1;
    this._pioPoll = 0;
    this.keys = new Uint8Array(16).fill(0xff);
    // Joystick: PC-8801 wires the pads to the OPN (YM2203) I/O port A/B, read
    // through OPN register 0x0E (pad 1) / 0x0F (pad 2). Active-low bits:
    // b0=up b1=down b2=left b3=right b4=trig1 b5=trig2. Idle = 0xff (nothing).
    this.joy = new Uint8Array([0xff, 0xff]);
    // diagnostic: per-port read counter for the keyboard matrix (0x00-0x0F), so
    // we can SEE which rows a game actually polls instead of guessing the layout.
    this._kbReads = new Uint32Array(16);
    // 30h/31h DIP reads. N88 V2 mode: 30h bit0=1 (N88), upper bits pulled
    // high; 31h bit7=0 (V2), bit6=1 (H). All-FF here *looks* harmless but
    // means "V1 + every terminal option on" — the boot ROM then wanders off
    // into terminal-mode setup instead of booting the disk.
    this.dipsw = [0xdb, 0x79];

    // YM2203 (OPN): FM×3 + SSG×3 + 2 timers, at ports 44h/45h. Its IRQ is
    // the μPD8214's SOUND source (number 4, level 5) — the music driver's
    // clock. Registers in, samples out; the machine only carries it.
    this.opn = new Ym2203({ clockHz, sampleRate: 48000 });
    // Sound Board II (OPNA) — optional, at ports A8h-ABh. Default off so a
    // plain machine looks driveless-OPN to the game (the empirically-observed
    // fallback). Enable to iterate SB2 detection / capture OPNA arrangements.
    this.opna = sb2 ? new Ym2608({ clockHz, sampleRate: 48000 }) : null;
    this.crtc = new Upd3301({ frameHz, drq: (buf) => this.dmac.drqPull(2, buf) });
    // per-character-row palette snapshots (raster palette): stepFrame samples
    // this.palette into rowPal[row] at the raster time each row is scanned, so
    // a mid-frame palette change (Ys II's scroll mask goes black then back)
    // shows on the right rows. 64 rows max × 8 entries × 3 guns.
    this.rowPal = new Uint8Array(64 * 24);
    this._crtcRow = 0;
    // the CRTC pulls text via DMA channel 2 from 0xF000+; in V2 that is the
    // dedicated tvram, NOT main RAM (so a game scratching main-RAM 0xF000 can't
    // corrupt the displayed text). Other addresses read main RAM as before.
    this.dmac = new Upd8257({ readMemory: (a) => { a &= 0xffff; return (this._tvramOn && a >= 0xf000) ? this.tvram[a - 0xf000] : this.ram[a]; } });
    this.width80 = true;

    this.frameHz = frameHz; // vertical refresh the emulation is pacing to
    this.clockHz = clockHz;
    this.dmaSteal = dmaSteal;
    this.frameT = Math.round(clockHz / frameHz * (1 - dmaSteal));
    // the sub board has its own bus — no DMA steal there. Per T-state of
    // main CPU progress, the sub runs this many:
    this.subRatio = (clockHz / frameHz) / this.frameT;
    this.tInFrame = 0;
    this.frame = 0;

    this.cpu = new Z80({
      read: (a) => this.readMem(a),
      write: (a, v) => this.writeMem(a, v),
      in: (p) => this.in(p & 0xff),
      out: (p, v) => this.out(p & 0xff, v),
    });
    this.cpu.pc = 0;
  }

  // ---- memory ------------------------------------------------------------
  readMem(a) {
    a &= 0xffff;
    if (a < 0x8000 && this.romEnabled) {
      if (a >= 0x6000 && this.extMapped && this.romExt && !this.n80mode) {
        const bank = this._port32 & 3; // EROMSL
        return this.romExt[bank * 0x2000 + (a - 0x6000)] ?? 0xff;
      }
      const rom = this.n80mode && this.romN80 ? this.romN80 : this.romMain;
      return rom[a] ?? 0xff;
    }
    if (a >= 0xc000 && this._aluOn()) return this._aluRead(a - 0xc000);
    if (a >= 0xc000 && this.gvramWindow >= 0) {
      return this.gvram[this.gvramWindow][a - 0xc000];
    }
    if (a >= 0xf000 && this._tvramOn && (this._port32 & 0x10) === 0) return this.tvram[a - 0xf000];
    return this.ram[a];
  }

  // V2 (mkII SR) dedicated text VRAM is active: N88 mode with the V2 DIP bit set
  // (port31 read bit6). Priority at 0xF000 is GVRAM window > tvram > main RAM.
  get _tvramOn() { return !this.n80mode && (this.dipsw[1] & 0x40) !== 0; }

  // the ALU window is open when 32h b6 (extended VRAM) and 35h b7 (VRAM, not
  // main RAM) are both set — otherwise C000-FFFF is plain RAM or one plane
  _aluOn() { return (this._port32 & 0x40) !== 0 && (this._alu2 & 0x80) !== 0; }

  // ALU read: latch all three planes, and RETURN the colour-compare result —
  // a 1 bit means "this dot is the compare colour". One read tells the CPU
  // where a whole 8-dot span matches a colour; that is the scroll primitive.
  _aluRead(o) {
    const cmp = this._alu2 & 7;
    let m = 0xff;
    for (let p = 0; p < 3; p++) {
      const v = this.gvram[p][o];
      this._aluBuf[p] = v;
      m &= (cmp & (1 << p)) ? v : ~v; // plane must be 1 where the colour has it
    }
    return m & 0xff;
  }

  // ALU write: mode 0 = per-plane logic op from 34h (AND-NOT / OR / XOR),
  // modes 1-3 = replay the latched planes (block copy without re-reading).
  _aluWrite(o, v) {
    switch (this._alu2 & 0x30) {
      case 0x00: {
        let op = this._alu1;
        for (let p = 0; p < 3; p++, op >>= 1) {
          switch (op & 0x11) {
            case 0x00: this.gvram[p][o] &= ~v; break;
            case 0x01: this.gvram[p][o] |= v; break;
            case 0x10: this.gvram[p][o] ^= v; break;
            default: break; // 0x11 = leave this plane alone
          }
        }
        return;
      }
      case 0x10: // restore all three planes as latched
        for (let p = 0; p < 3; p++) this.gvram[p][o] = this._aluBuf[p];
        return;
      case 0x20: this.gvram[0][o] = this._aluBuf[1]; return; // R → B
      default: this.gvram[1][o] = this._aluBuf[0]; return; // B → R
    }
  }

  writeMem(a, v) {
    a &= 0xffff;
    v &= 0xff;
    if (a >= 0xc000 && this._aluOn()) { this._aluWrite(a - 0xc000, v); return; }
    if (a >= 0xc000 && this.gvramWindow >= 0) {
      this.gvram[this.gvramWindow][a - 0xc000] = v;
      return;
    }
    if (a >= 0xf000 && this._tvramOn && (this._port32 & 0x10) === 0) { this.tvram[a - 0xf000] = v; return; }
    this.ram[a] = v; // RAM is always writable underneath the ROM
  }

  // ---- I/O ----------------------------------------------------------------
  in(port) {
    if (port <= 0x0f) { if (this._kbReads) this._kbReads[port]++; return this.keys[port]; } // keyboard matrix
    if (port === 0x30) return this.dipsw[0];
    if (port === 0x31) return this.dipsw[1];
    if (port === 0x32) return this._port32; // readable on mkII SR and later
    // 71h is READ by the cross-bank call dispatcher (3ABE): it stows the
    // current bank state in its stack frame so the return trampoline can
    // put it back. Returning a constant here means every OS call restores
    // the WRONG bank on the way home.
    if (port === 0x71) return this._port71;
    if (port === 0x40) {
      // d5 = VRTC (high during retrace), d1 = CMT carrier etc.
      const vrtc = this.tInFrame > this.frameT * 0.86;
      return (vrtc ? 0x20 : 0x00) | 0x02;
    }
    if (port === 0x50) return this.crtc.readParam();
    if (port === 0x51) return this.crtc.readStatus();
    if (port >= 0x60 && port <= 0x68) return this.dmac.readPort(port - 0x60);
    if (port === 0x44) return this.opn.readStatus(); // OPN status (timer flags)
    if (port === 0x45) {
      // OPN I/O port A/B carry the joystick pad state on the PC-8801. When the
      // game selects reg 0x0E/0x0F and reads, hand back the live pad, not the
      // last register write (an input port reflects pins, not stored data).
      if (this.opn.addr === 0x0e) return this.joy[0];
      if (this.opn.addr === 0x0f) return this.joy[1];
      return this.opn.reg[this.opn.addr];
    }
    if (this.opna) { // Sound Board II (OPNA) at A8h-ABh
      // YM chips are write-only for registers; a read of the DATA port returns
      // the STATUS byte (busy + timer flags), which is exactly what the SB2
      // detection routine polls at 0xA9 (disassembled: OUT(C=A8),E; INC C; IN A,(C)).
      if (port === 0xa8 || port === 0xa9) return this.opna.readStatus();
      if (port === 0xaa || port === 0xab) return this.opna.readStatus(); // bank1 status (ADPCM flags: stubbed)
    }
    if (port === 0xe2 || port === 0xe3) return 0xff; // EMM
    // Kanji ROM data. The driver walks CONSECUTIVE word addresses and reads the
    // two bytes of each word (0xE8 = even byte, 0xE9 = odd), so returning
    // rom[(addr<<1) | (port&1)] hands back consecutive ROM bytes — the 32-byte
    // glyph in order. (A "split" addressing that fetches left/right 16 apart
    // instead scrambled it — the driver, not the ROM, defines the order.)
    // 0xE8/0xE9 = level-1, 0xEC/0xED = level-2. No ROM loaded → 0xFF (white box).
    // byte = rom[(addr<<1) | ((port&1)^1)] — the driver walks consecutive word
    // addresses, and 0xE8 returns the ODD byte / 0xE9 the EVEN (halves swapped
    // vs the naive even/odd). Confirmed on real kana. 0xE8/0xE9 = level-1,
    // 0xEC/0xED = level-2. No ROM loaded → 0xFF (game draws the "white box").
    if (port === 0xe8 || port === 0xe9) {
      if (!this.kanjiRom) return 0xff;
      return this.kanjiRom[((this.kanjiAddr << 1) | ((port & 1) ^ 1)) & (this.kanjiRom.length - 1)];
    }
    if (port === 0xec || port === 0xed) {
      if (!this.kanji2Rom) return 0xff;
      return this.kanji2Rom[((this.kanji2Addr << 1) | ((port & 1) ^ 1)) & (this.kanji2Rom.length - 1)];
    }
    // FCh-FFh: the main half of the 8255 pair to the disk sub-system. With
    // no sub board the inputs float high and the boot ROM's BC×D timeout
    // loop expires into BASIC; with one, the two ROMs do the real handshake.
    if (port >= 0xfc && port <= 0xff) {
      if (!this.pio) return 0xff;
      const v = this.pio.read(port - 0xfc);
      // main spinning on an unchanged answer = it is waiting for the sub.
      // Count it so stepFrame can lend the sub extra time (same trick
      // QUASI88 uses: on continuous PIO reads, switch to the sub CPU) —
      // otherwise the boot ROM's timeout beats the sub ROM's motor delay.
      if (v === this._pioLast) this._pioPoll++;
      else { this._pioLast = v; this._pioPoll = 0; }
      return v;
    }
    return 0xff;
  }

  out(port, v) {
    v &= 0xff;
    switch (port) {
      case 0x30: // system: 40/80 col, 20/25 lines, mono
        this.width80 = (v & 1) !== 0;
        return;
      case 0x31: // graphics control. The bits are NOT what you'd guess:
        // b0 = 1 → 200-line (0 = 400-line), b1 = 64K-RAM mode,
        // b2 = N-BASIC select, b3 = VRAM displayed, b4 = 1 → COLOR (0 = mono),
        // b5 = text 25 lines. Reading b0 as "400-line" and b2 as "mono"
        // (the earlier guess) makes every game come out mono and half-height.
        this._port31 = v;
        this.line400 = (v & 1) === 0;
        this.romEnabled = (v & 2) === 0;
        this.gvramOn = (v & 8) !== 0;
        this.mono = (v & 0x10) === 0;
        return;
      case 0x32: // mkII SR+: b5 = analog palette, b6 = ALU/extended VRAM window
        this._port32 = v;
        return;
      case 0x53: // display mask: b0 = 1 → text plane OFF, b1 = 1 → graphics OFF.
        // Ys II draws its whole map in GVRAM and sets b0 to hide the text plane;
        // without honouring this the leftover text VRAM occluded the map (black
        // centre). Opening keeps text ON (b0=0) so its scroll mask still works.
        this._port53 = v;
        return;
      case 0x44: this.opn.writeAddr(v); return; // OPN register select
      case 0x45: this.opn.writeData(v); return; // OPN register data
      case 0xa8: if (this.opna) this.opna.writeAddr(v); return;  // OPNA bank0 addr
      case 0xa9: if (this.opna) this.opna.writeData(v); return;  // OPNA bank0 data
      case 0xaa: if (this.opna) this.opna.writeAddr1(v); return; // OPNA bank1 addr
      case 0xab: if (this.opna) this.opna.writeData1(v); return; // OPNA bank1 data
      case 0x34: this._alu1 = v; return; // ALU op per plane
      case 0x35: this._alu2 = v; return; // ALU mode / compare colour / enable
      case 0x5c: this.gvramWindow = 0; return; // plane B into C000
      case 0x5d: this.gvramWindow = 1; return; // plane R
      case 0x5e: this.gvramWindow = 2; return; // plane G
      case 0x5f: this.gvramWindow = -1; return; // main RAM back
      case 0x50: this.crtc.writeParam(v); return;
      case 0x51: this.crtc.writeCommand(v); return;
      case 0x71: // extension ROM select — bit0 = 0 maps the ext ROM at
        // 6000-7FFF; WHICH of the 4 banks comes from port 32h bits 0-1
        // (EROMSL). Getting this split wrong sends every cross-bank call
        // in the N88 ROM into the wrong bank and the machine into the weeds.
        this._port71 = v;
        this.extMapped = (v & 1) === 0;
        return;
      case 0xe8: this.kanjiAddr = (this.kanjiAddr & 0xff00) | v; return;  // kanji1 addr low
      case 0xe9: this.kanjiAddr = (this.kanjiAddr & 0x00ff) | (v << 8); return; // kanji1 addr high
      case 0xec: this.kanji2Addr = (this.kanji2Addr & 0xff00) | v; return; // kanji2 addr low
      case 0xed: this.kanji2Addr = (this.kanji2Addr & 0x00ff) | (v << 8); return; // kanji2 addr high
      case 0xe4: this.intLevels = (v & 8) ? 7 : (v & 7); return; // 8214 threshold
      case 0xe6: // per-source enable; disabling a source drops its pending flag
        this.intMaskBits = v;
        if (!(v & 1)) this.intPending &= ~(1 << 2); // RTC
        if (!(v & 2)) this.intPending &= ~(1 << 1); // VSYNC
        if (!(v & 4)) this.intPending &= ~(1 << 0); // SIO
        return;
      default:
        break;
    }
    if (port >= 0x54 && port <= 0x5b) {
      // Palette. Port 32h bit5 picks the world:
      //   digital (mkII): one write, bits 0-2 = B/R/G, full-on or off
      //   analog (SR V2): 3 bits per gun from the 512-cube, but the port is
      //     8 bits wide — so it takes TWO writes, bit6 selecting which half:
      //     bit6=0 → B (bits 0-2) and R (bits 3-5); bit6=1 → G (bits 0-2).
      // (An R/B-swapped decode was tried to fix AE's title cyan, but it made
      // most other games worse — reverted; this order is right in general.)
      const i = (port - 0x54) * 3;
      if (this._port32 & 0x20) { // analog
        if (v & 0x40) this.palette[i + 1] = v & 7; // G
        else { this.palette[i + 2] = v & 7; this.palette[i] = (v >> 3) & 7; } // B, R
      } else { // digital: each bit is a gun, all-or-nothing
        this.palette[i] = (v & 2) ? 7 : 0; // R
        this.palette[i + 1] = (v & 4) ? 7 : 0; // G
        this.palette[i + 2] = (v & 1) ? 7 : 0; // B
      }
      return;
    }
    if (port >= 0x60 && port <= 0x68) { this.dmac.writePort(port - 0x60, v); return; }
    if (port >= 0xfc && port <= 0xff && this.pio) { this.pio.write(port - 0xfc, v); return; }
  }

  // ---- interrupts ---------------------------------------------------------
  // sources by number n (vector = n*2) and 8214 level: SIO n=0 lv1,
  // VSYNC n=1 lv2, RTC n=2 lv3, SOUND n=4 lv5.
  _serviceInterrupts() {
    if (!this.intPending || !this.intLevels) return;
    let no = -1;
    if (this.intLevels >= 1 && (this.intPending & 1)) no = 0;
    else if (this.intLevels >= 2 && (this.intPending & 2)) no = 1;
    else if (this.intLevels >= 3 && (this.intPending & 4)) no = 2;
    else if (this.intLevels >= 5 && (this.intPending & 16)) no = 4;
    if (no < 0) return;
    const t = this.cpu.intRequest(no * 2);
    if (t > 0) {
      this.intPending &= ~(1 << no);
      this.intLevels = 0; // 8214: acceptance closes the gate until re-armed
    }
  }

  // ---- run ----------------------------------------------------------------
  // Main and sub CPUs interleave in ~100 T-state slices. The 8255 handshake
  // is level-polled on both sides, so slice granularity only paces the
  // transfer, it cannot break the protocol.
  stepFrame() {
    const SLICE = 100;
    // the 1/600s interval timer (level 0) — disk BASIC sleeps on it (EI/HALT),
    // so without these 10 ticks per frame the machine halts forever
    const timerPeriod = this.frameT / 10;
    let subDebt = 0;
    let nextTimer = this.tInFrame + timerPeriod;
    // raster-accurate text fetch: space the CRTC's per-row DMA + palette
    // snapshot across the frame, so mid-frame VRAM/palette rewrites land on the
    // rows actually scanning at that moment.
    this.crtc.beginFrame();
    this._crtcRow = 0;
    const dispRows = this.crtc.rows;
    const totalRows = (this.crtc.rows + this.crtc.vblankRows) || 1;
    const rowT = this.frameT / totalRows;
    while (this.tInFrame < this.frameT) {
      const target = Math.min(this.frameT, this.tInFrame + SLICE);
      const before = this.tInFrame;
      while (this.tInFrame < target) {
        const cyc = this.cpu.step();
        this.tInFrame += cyc;
        while (this._crtcRow < dispRows && this.tInFrame >= this._crtcRow * rowT) {
          this.crtc.fetchRow(this._crtcRow);
          this.rowPal.set(this.palette, this._crtcRow * 24);
          this._crtcRow++;
        }
        // OPN timers run on the chip's OWN clock at full speed — the ~30% DMA
        // bus-steal slows the CPU, not the sound chip. Advancing the timer by
        // raw CPU cycles ran it at 0.7× and dragged the tempo; scale back up
        // to real clock. And deliver the SOUND IRQ on the RISING edge only —
        // holding intPending high while the flag stood set re-fired the
        // handler many times per period, speeding the music the other way.
        // (Two errors that half-cancelled; the ear/FFT still caught ~1.2×.)
        this._opnCyc += cyc * this._opnClkPerCpu;
        if (this._opnCyc >= 72) {
          const t = (this._opnCyc / 72) | 0;
          this._opnCyc -= t * 72;
          this.opn.tickTimers(t);
          if (this.opna) this.opna.tickTimers(t); // SB2 shares the SOUND IRQ line
          const irqNow = this.opn.irq || (this.opna && this.opna.irq);
          if (irqNow && !this._opnIrqPrev) this.intPending |= 1 << 4; // SOUND, src 4
          this._opnIrqPrev = irqNow;
        }
        if (this.tInFrame >= nextTimer) {
          if (this.intMaskBits & 1) this.intPending |= 1 << 2; // RTC, source 2
          nextTimer += timerPeriod;
        }
        this._serviceInterrupts();
      }
      if (this.sub) {
        // polling main donates its wasted bus time to the sub (×16)
        const boost = this._pioPoll > 32 ? 16 : 1;
        subDebt += (this.tInFrame - before) * this.subRatio * boost;
        if (subDebt >= SLICE) subDebt -= this.sub.run(Math.floor(subDebt));
      }
    }
    this.tInFrame -= this.frameT;
    // any rows not yet reached (short/paused frame) — fetch + snapshot now
    while (this._crtcRow < dispRows) {
      this.crtc.fetchRow(this._crtcRow);
      this.rowPal.set(this.palette, this._crtcRow * 24);
      this._crtcRow++;
    }
    this.crtc.endFrame();
    if (this.intMaskBits & 2) this.intPending |= 1 << 1; // VSYNC, source 1
    this.frame++;
    return this;
  }

  insertDisk(unit, disk) { this.sub?.insertDisk(unit, disk); return this; }
  ejectDisk(unit) { this.sub?.ejectDisk(unit); return this; }

  // Live-tune the CPU's bus-steal fraction. The music tempo is anchored to the
  // OPN's own clock (via _opnClkPerCpu), so it stays put; only the CPU's cycles
  // per frame change. Lower steal = faster CPU-bound game logic (e.g. Ys II's
  // opening scroll) without touching the music — the knob for "video lags the
  // music" desync. Recomputes the frameT-derived ratios.
  setDmaSteal(v) {
    this.dmaSteal = Math.max(0, Math.min(0.6, v));
    this.frameT = Math.round(this.clockHz / this.frameHz * (1 - this.dmaSteal));
    this._opnClkPerCpu = (this.clockHz / this.frameHz) / this.frameT;
    this.subRatio = (this.clockHz / this.frameHz) / this.frameT;
    return this;
  }

  update(dt) {
    this._acc = (this._acc ?? 0) + dt;
    // pace to the machine's OWN refresh, not a hard-coded 60 — so constructing
    // with the real PC-8801 vertical rate makes the emulation (and the music
    // tempo that rides its clock) run at true speed. Default 60 → unchanged.
    const period = 1 / this.frameHz;
    while (this._acc >= period) { this._acc -= period; this.stepFrame(); }
    return this;
  }

  // ---- audio --------------------------------------------------------------
  // Fill `out` (Float32Array, mono) with the machine's sound at the chips'
  // fixed sampleRate (48 kHz). The built-in OPN (0x44/0x45) and — when Sound
  // Board II is fitted — the OPNA (0xA8-0xAB, FM6 + rhythm) are summed. Only
  // the chip the music driver actually addresses produces signal; the other
  // sits at reset and adds silence, so summing is safe either way. The chips
  // only advance their oscillators/envelopes when pulled, so this IS the sole
  // renderer — call it from the audio callback, same as the demo.
  //
  // Rhythm ROM: an OPNA with no rhythm ROM loaded plays FM only. Load the drum
  // PCM once after construction — `m.opna?.setRhythmRom(loadRhythmRom().samples)`
  // (tools/load-rhythm-rom.mjs in Node, or the fetch/decodeWav path in a page).
  renderAudio(out, n = out.length) {
    this.opn.render(out, n);
    if (this.opna) {
      if (!this._audioScratch || this._audioScratch.length < n) this._audioScratch = new Float32Array(n);
      const s = this._audioScratch.subarray(0, n);
      this.opna.render(s, n);
      for (let i = 0; i < n; i++) out[i] += s[i];
    }
    return out;
  }

  keyDown(row, bit) { this.keys[row] &= ~(1 << bit); return this; }
  keyUp(row, bit) { this.keys[row] |= 1 << bit; return this; }
  // Joystick (active-low): bit 0=up 1=down 2=left 3=right 4=trig1 5=trig2.
  joyDown(bit, pad = 0) { this.joy[pad] &= ~(1 << bit); return this; }
  joyUp(bit, pad = 0) { this.joy[pad] |= 1 << bit; return this; }

  // ---- time travel ---------------------------------------------------------
  // Deterministic machine + full state copy = rewindable execution, sub
  // board and FDC included. One caveat, documented rather than hidden:
  // mounted disk IMAGES are captured by reference, so sector writes are
  // not rewound (copying whole D88s per snapshot would cost megabytes).
  snapshot() {
    const s = {
      cpu: this.cpu.getState(),
      ram: this.ram.slice(),
      tvram: this.tvram.slice(),
      gvram: this.gvram.map((p) => p.slice()),
      palette: this.palette.slice(),
      keys: this.keys.slice(), joy: this.joy.slice(),
      dipsw: [...this.dipsw],
      crtc: snapObj(this.crtc),
      dmac: snapObj(this.dmac),
      bank: {
        romEnabled: this.romEnabled, extMapped: this.extMapped, port32: this._port32, port71: this._port71,
        port31: this._port31, alu1: this._alu1, alu2: this._alu2, aluBuf: [...this._aluBuf],
        gvramWindow: this.gvramWindow, gvramOn: this.gvramOn, port53: this._port53,
        mono: this.mono, line400: this.line400, width80: this.width80,
      },
      ints: { levels: this.intLevels, mask: this.intMaskBits, pending: this.intPending },
      pioPoll: { last: this._pioLast, count: this._pioPoll },
      tInFrame: this.tInFrame, frame: this.frame, acc: this._acc ?? 0,
    };
    if (this.sub) {
      s.pio = snapObj(this.pio);
      s.sub = {
        cpu: this.sub.cpu.getState(),
        mem: this.sub.mem.slice(),
        motor: this.sub.motor,
        pio: snapObj(this.sub.pio),
        fdc: this._snapFdc(),
      };
    }
    return s;
  }

  _snapFdc() {
    // explicit field list — snapObj would deep-copy whole mounted D88s.
    // drives/_multi/execBuf hold views INTO the disk images: reference them.
    const f = this.sub.fdc;
    return {
      phase: f.phase, cmdLen: f.cmdLen, cmd: [...f.cmd],
      result: [...f.result], resultPos: f.resultPos,
      execPos: f.execPos, execWrite: f.execWrite, int: f.int,
      seekEnd: f.seekEnd.map((p) => ({ ...p })), us: f.us, hd: f.hd,
      drives: f.drives.map((d) => ({ cyl: d.cyl, _idx: d._idx, disk: d.disk })),
      execBuf: f.execBuf,
      _multi: f._multi,
    };
  }

  restore(s) {
    this.cpu.setState(s.cpu);
    this.ram.set(s.ram);
    if (s.tvram) this.tvram.set(s.tvram);
    s.gvram.forEach((p, i) => this.gvram[i].set(p));
    this.palette.set(s.palette);
    for (let r = 0; r < 64; r++) this.rowPal.set(this.palette, r * 24); // restored frames: uniform (raster rebuilt on next stepFrame)
    this.keys.set(s.keys);
    if (s.joy) this.joy.set(s.joy);
    this.dipsw = [...s.dipsw];
    restoreObj(this.crtc, s.crtc);
    restoreObj(this.dmac, s.dmac);
    const b = s.bank;
    this.romEnabled = b.romEnabled; this.extMapped = b.extMapped; this._port32 = b.port32;
    this._port71 = b.port71 ?? 0xff;
    this._port31 = b.port31 ?? 0;
    this._alu1 = b.alu1 ?? 0; this._alu2 = b.alu2 ?? 0;
    this._aluBuf = [...(b.aluBuf ?? [0, 0, 0])];
    this.gvramWindow = b.gvramWindow; this.gvramOn = b.gvramOn; this._port53 = b.port53 ?? 0;
    this.mono = b.mono; this.line400 = b.line400; this.width80 = b.width80;
    this.intLevels = s.ints.levels; this.intMaskBits = s.ints.mask; this.intPending = s.ints.pending;
    this._pioLast = s.pioPoll.last; this._pioPoll = s.pioPoll.count;
    this.tInFrame = s.tInFrame; this.frame = s.frame; this._acc = s.acc;
    if (this.sub && s.sub) {
      restoreObj(this.pio, s.pio);
      this.sub.cpu.setState(s.sub.cpu);
      this.sub.mem.set(s.sub.mem);
      this.sub.motor = s.sub.motor;
      restoreObj(this.sub.pio, s.sub.pio);
      const f = this.sub.fdc;
      const fs = s.sub.fdc;
      for (const k of Object.keys(fs)) {
        if (k === 'drives' || k === 'execBuf' || k === '_multi') continue;
        f[k] = Array.isArray(fs[k]) ? fs[k].map((x) => (x && typeof x === 'object' ? { ...x } : x)) : fs[k];
      }
      f.drives.forEach((d, i) => { d.cyl = fs.drives[i].cyl; d._idx = fs.drives[i]._idx; d.disk = fs.drives[i].disk; });
      f.execBuf = fs.execBuf;
      f._multi = fs._multi;
    }
    return this;
  }

  // ---- video --------------------------------------------------------------
  // Composite: graphics planes (palette-indexed) under the text layer.
  // Returns { width, height, rgb: Uint8Array(w*h*3) } with 0-255 per channel
  // (the 512 cube's 3-bit levels scaled to 8 bits).
  //
  // With `indexed: true` it instead returns { width, height, pixels } where
  // `pixels` is a GRB-indexed Uint8Array(w*h): the raw 0..7 palette index per
  // dot (bit0=B, bit1=R, bit2=G) — the SAME format the μPD3301 text renderer
  // and the CrtPhosphor beam-pass consume. That lets the shared demo CRT
  // pipeline (crt-panel → phosphor → tube) drive the 8801 exactly as it drives
  // the 8001. Caveat: the analog 512-colour palette collapses to its 8
  // primaries through the phosphor's GRB guns. The rgb path is untouched, so
  // offline colour capture (the Ys arrangement grabs) keeps full palette depth.
  // Compositing options (both default to the plain, always-safe behaviour):
  //   textOpaque — a DISPLAYED text dot occludes graphics even when its colour
  //     is black (uses the `ink` mask). Off: only a non-black text pixel wins
  //     (colour-only). This is the "hide the off-screen scratch with black
  //     text" behaviour; it is a hypothesis about the hardware, so it is opt-in.
  //   clipActive — blank everything outside the μPD3301 active window
  //     (cols·8 × rows·linesPerChar), i.e. show a black border instead of the
  //     GVRAM that lies outside what the CRTC is actually scanning. The other
  //     candidate for hiding edge scratch. No-op at a full 80×25 screen.
  //   hideText — skip the text/semigraphics layer entirely (graphics only).
  //     A diagnostic: if a "text is riding on top of the graphics" scene goes
  //     clean with this on, the bug is the text layer wrongly compositing.
  render({ cgrom, out = null, indexed = false, textOpaque = false, clipActive = false, hideText = false } = {}) {
    const crtc = this.crtc;
    // port 53h display mask: b0 hides the text plane, b1 hides graphics. Games
    // (Ys II) toggle the text plane off while showing a full-screen GVRAM map.
    const textOff = (this._port53 & 1) !== 0;
    const graphOff = (this._port53 & 2) !== 0;
    const text = (hideText || textOff) ? null : renderScreen(crtc.getScreen(), {
      cgrom, colorMode: !this.mono, width80: this.width80,
    });
    const ink = text ? text.ink : null;
    const W = 640, H = 200;
    const [B, R, G] = this.gvram;
    const activeW = clipActive ? Math.min(W, crtc.cols * 8) : W;
    const activeH = clipActive ? Math.min(H, crtc.rows * (crtc.linesPerChar || 8)) : H;
    // per-pixel composite → palette index 0..7
    const composite = (x, y, i) => {
      if (clipActive && (x >= activeW || y >= activeH)) return 0; // border
      let idx = 0;
      if (this.gvramOn && !graphOff) {
        const byte = (y * 80) + (x >> 3);
        const mask = 0x80 >> (x & 7);
        idx = ((G[byte] & mask) ? 4 : 0) | ((R[byte] & mask) ? 2 : 0) | ((B[byte] & mask) ? 1 : 0);
      }
      if (text) {
        if (textOpaque) { if (i < ink.length && ink[i]) idx = text.pixels[i]; }
        else { const t = i < text.pixels.length ? text.pixels[i] : 0; if (t) idx = t; }
      }
      return idx & 7;
    };
    if (indexed) {
      const pixels = out && out.length === W * H ? out : new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; pixels[i] = composite(x, y, i); }
      return { width: W, height: H, pixels, schemaVersion: SCHEMA_VERSION };
    }
    const rgb = out && out.length === W * H * 3 ? out : new Uint8Array(W * H * 3);
    // per-row palette (raster palette): each character row is coloured with the
    // palette captured when it was scanned. No rows displayed → the single
    // current palette. (The 512-cube RGB path only; the indexed CRT path shows
    // the 8 GRB primaries and doesn't consult the palette.)
    const raster = crtc.rows > 0;
    const lpc = crtc.linesPerChar || 8;
    const maxRow = crtc.rows - 1;
    for (let y = 0; y < H; y++) {
      const pal = raster ? this.rowPal : this.palette;
      const base = raster ? Math.min((y / lpc) | 0, maxRow) * 24 : 0;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const p = base + composite(x, y, i) * 3;
        rgb[i * 3] = pal[p] * 36; // 0..7 → 0..252
        rgb[i * 3 + 1] = pal[p + 1] * 36;
        rgb[i * 3 + 2] = pal[p + 2] * 36;
      }
    }
    return { width: W, height: H, rgb, schemaVersion: SCHEMA_VERSION };
  }

  screenText() {
    const { cells, cols, rows } = this.crtc;
    const lines = [];
    for (let y = 0; y < rows; y++) {
      let line = '';
      for (let x = 0; x < cols; x++) {
        const c = cells[y * cols + x];
        line += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ' ';
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }
}

export function createPc8801Machine(opts) {
  return new Pc8801Machine(opts);
}
