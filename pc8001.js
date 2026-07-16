// pc8001 — PC-8001-flavored wiring and rendering on top of the μPD3301 core
// and the μPD8257 DMA model. The chip core stays generic; everything
// PC-8001-specific (attribute byte interpretation, semigraphics, 40/80
// column dot doubling, port map) lives here — downstream reads and decides.
//
// Text VRAM line = 120 bytes: 80 character codes + 20 attribute pairs.
// Attribute pair = (position, value). The value byte has two flavors,
// distinguished by bit 3:
//   bit3=1 "color spec":    bit7=G bit6=R bit5=B, bit4=semigraphic
//   bit3=0 "function spec": bit7=semigraphic(mono) bit5=lowline bit4=upline
//                           bit2=reverse bit1=blink bit0=secret
// Each flavor updates its own running state from its position onward, so a
// color change does not reset reverse/blink and vice versa.
//
// Colors are 3-bit GRB indexes 0-7: 0 black, 1 blue, 2 red, 3 magenta,
// 4 green, 5 cyan, 6 yellow, 7 white.
//
// Semigraphic cell: the character code byte is a 2x4 block bitmap —
// bits 0-3 left column top→bottom, bits 4-7 right column top→bottom.

import { Upd3301 } from './index.js';
import { Upd8257 } from './upd8257.js';

export const SCHEMA_VERSION = 1;

export const PC8001 = Object.freeze({
  TEXT_VRAM: 0xf3c8, // N-BASIC default text VRAM base
  BYTES_PER_LINE: 120,
  CRTC_PARAM: 0x50,
  CRTC_COMMAND: 0x51,
  DMAC_BASE: 0x60, // 60h-67h channel regs, 68h mode
  SYSTEM_PORT: 0x30, // d0: 1=80col 0=40col, d1: 1=mono 0=color
});

export const ATTR = Object.freeze({
  COLOR_FLAG: 0x08,
  SEMIGRAPHIC: 0x10, // in color spec
  SEMIGRAPHIC_MONO: 0x80, // in function spec
  LOWLINE: 0x20,
  UPLINE: 0x10,
  REVERSE: 0x04,
  BLINK: 0x02,
  SECRET: 0x01,
});

export const DEFAULT_COLOR_SPEC = 0xe8; // white, no semigraphic (N-BASIC fill)

export function decodeAttrPair(value) {
  if (value & ATTR.COLOR_FLAG) {
    return {
      kind: 'color',
      color: (value >> 5) & 7, // G R B → index bit2=G bit1=R bit0=B
      semigraphic: (value & ATTR.SEMIGRAPHIC) !== 0,
    };
  }
  return {
    kind: 'function',
    semigraphicMono: (value & ATTR.SEMIGRAPHIC_MONO) !== 0,
    lowline: (value & ATTR.LOWLINE) !== 0,
    upline: (value & ATTR.UPLINE) !== 0,
    reverse: (value & ATTR.REVERSE) !== 0,
    blink: (value & ATTR.BLINK) !== 0,
    secret: (value & ATTR.SECRET) !== 0,
  };
}

// Expand one row of raw pairs into two per-column state arrays
// (colorSpec byte and functionSpec byte), PC-8001 dual-state semantics.
export function expandRowStates(pairs, attrsPerRow, cols, colorOut, funcOut) {
  let colorState = DEFAULT_COLOR_SPEC;
  let funcState = 0x00;
  if (attrsPerRow === 0) {
    colorOut.fill(DEFAULT_COLOR_SPEC, 0, cols);
    funcOut.fill(0, 0, cols);
    return { colorOut, funcOut };
  }
  // Pair k takes effect at its position; the first pair back-fills to
  // column 0 (chip quirk). A (0, 0) pair after the first is N-BASIC's
  // padding for unused slots and ends the list. Two pairs at the same
  // position both apply (e.g. a color spec and a function spec at column 0
  // — needed by the terminal layer).
  for (let k = 0; k < attrsPerRow; k++) {
    let start = k === 0 ? 0 : pairs[k * 2];
    const value = pairs[k * 2 + 1];
    if (k > 0 && pairs[k * 2] === 0 && value === 0) break; // padding sentinel
    let end = cols;
    if (k + 1 < attrsPerRow) {
      const next = pairs[(k + 1) * 2];
      end = next === 0 && pairs[(k + 1) * 2 + 1] === 0 ? cols : next;
    }
    if (value & ATTR.COLOR_FLAG) colorState = value;
    else funcState = value;
    for (let x = Math.min(start, cols); x < Math.min(end, cols); x++) {
      colorOut[x] = colorState;
      funcOut[x] = funcState;
    }
  }
  return { colorOut, funcOut };
}

// Render a μPD3301 screen snapshot to an indexed bitmap (values 0-7).
// cgrom: Uint8Array(256 * 16), glyph line = cgrom[code * 16 + line],
// bit 7 = leftmost dot. width80=false doubles every dot (PC-8001 40-column
// mode slows the character clock; the CRTC itself just sees 40 columns).
export function renderScreen(screen, {
  cgrom,
  colorMode = true,
  width80 = true,
  out = null,
  pcg = null, // optional PCG overlay { ram: Uint8Array(0x400), on: bool }: redefines
              // glyphs 0x80-0xFF (8 rows each). Opt-in — omit for stock font.
              // NOTE: visual overlay is browser-side and currently unverified.
} = {}) {
  const { cols, rows, linesPerChar, cells, attrPairs, attrsPerRow } = screen;
  const abpr = screen.attrBytesPerRow ?? attrsPerRow * 2;
  const dotW = width80 ? 1 : 2;
  const width = cols * 8 * dotW;
  const height = rows * linesPerChar;
  const pixels = out && out.length === width * height ? out : new Uint8Array(width * height);
  pixels.fill(0);
  // `ink` = 1 wherever a character dot is actually drawn, INDEPENDENT of colour.
  // A black-on-graphics character (fg = 0) writes pixel 0 — indistinguishable
  // from "no character" if you only look at the colour. The ink mask lets the
  // 8801 compositor make displayed text OPAQUE over the graphics plane (so a
  // game can mask its off-screen scratch by writing black/reverse-space text),
  // which colour alone can't express. Callers that don't composite ignore it.
  const ink = new Uint8Array(width * height);
  if (!screen.displayEnabled) return { width, height, pixels, ink, schemaVersion: SCHEMA_VERSION };

  const colorRow = new Uint8Array(cols);
  const funcRow = new Uint8Array(cols);
  const cursor = screen.cursor;

  for (let y = 0; y < rows; y++) {
    const rowAttrs = attrPairs.subarray(y * abpr, (y + 1) * abpr);
    if (screen.attrPerCell) {
      // one byte per cell: bit3 picks which state it carries, the other
      // state stays at its default for that cell
      for (let x = 0; x < cols; x++) {
        const b = rowAttrs[x];
        if (b & ATTR.COLOR_FLAG) { colorRow[x] = b; funcRow[x] = 0; }
        else { colorRow[x] = DEFAULT_COLOR_SPEC; funcRow[x] = b; }
      }
    } else {
      expandRowStates(rowAttrs, attrsPerRow, cols, colorRow, funcRow);
    }
    for (let x = 0; x < cols; x++) {
      const code = cells[y * cols + x];
      const colorSpec = colorRow[x];
      const func = funcRow[x];
      const semigraphic = colorMode
        ? (colorSpec & ATTR.SEMIGRAPHIC) !== 0
        : (func & ATTR.SEMIGRAPHIC_MONO) !== 0;
      const fg = colorMode ? (colorSpec >> 5) & 7 : 7;
      const secret = (func & ATTR.SECRET) !== 0;
      const blinkOff = (func & ATTR.BLINK) !== 0 && !screen.attrBlinkOn;
      let reverse = (func & ATTR.REVERSE) !== 0;
      if (screen.reverseDisplay) reverse = !reverse;
      const isCursor = cursor.on && cursor.x === x && cursor.y === y;

      for (let line = 0; line < linesPerChar; line++) {
        let tile;
        if (semigraphic) {
          const band = Math.min(3, (line * 4 / linesPerChar) | 0);
          const left = (code >> band) & 1;
          const right = (code >> (4 + band)) & 1;
          tile = (left ? 0xf0 : 0) | (right ? 0x0f : 0);
        } else if (pcg && pcg.on && code >= 0x80 && line < 8) {
          tile = pcg.ram[(code & 0x7f) * 8 + line]; // PCG-redefined glyph (visual-unverified)
        } else {
          tile = cgrom ? cgrom[code * 16 + line] : 0;
        }
        if (secret || blinkOff) tile = 0;
        if (!semigraphic) {
          if ((func & ATTR.LOWLINE) && line === linesPerChar - 1) tile = 0xff;
          if ((func & ATTR.UPLINE) && line === 0) tile = 0xff;
        }
        if (reverse) tile ^= 0xff;
        if (isCursor && (cursor.block || line === linesPerChar - 1)) tile ^= 0xff;

        const py = y * linesPerChar + line;
        let px = x * 8 * dotW;
        for (let bit = 7; bit >= 0; bit--) {
          const on = (tile >> bit) & 1;
          const v = on ? fg : 0;
          const p = py * width + px;
          pixels[p] = v; ink[p] = on; px++;
          if (dotW === 2) { pixels[p + 1] = v; ink[p + 1] = on; px++; }
        }
      }
    }
  }
  return { width, height, pixels, ink, schemaVersion: SCHEMA_VERSION };
}

// A whole PC-8001-ish text subsystem: 64KB memory + μPD8257 + μPD3301,
// wired through the real I/O port numbers.
export class Pc8001TextSystem {
  constructor({ frameHz = 60, memoryBytes = 0x10000 } = {}) {
    // memoryBytes > 64KB is UEX fantasy territory (with the DMAC's extended
    // address mask) — the real machine tops out at 0x10000
    this.memory = new Uint8Array(memoryBytes);
    this.dmac = new Upd8257({ readMemory: (a) => this.memory[a] });
    this.crtc = new Upd3301({ frameHz, drq: (buf) => this.dmac.drqPull(2, buf) });
    this.width80 = true;
    this.colorMode = true;
  }

  out(port, value) {
    if (port === PC8001.CRTC_PARAM) this.crtc.writeParam(value);
    else if (port === PC8001.CRTC_COMMAND) this.crtc.writeCommand(value);
    else if (port >= PC8001.DMAC_BASE && port <= PC8001.DMAC_BASE + 8) {
      this.dmac.writePort(port - PC8001.DMAC_BASE, value);
    } else if (port === PC8001.SYSTEM_PORT) {
      this.width80 = (value & 1) !== 0;
      this.colorMode = (value & 2) === 0;
    }
  }

  in(port) {
    if (port === PC8001.CRTC_PARAM) return this.crtc.readParam();
    if (port === PC8001.CRTC_COMMAND) return this.crtc.readStatus();
    if (port >= PC8001.DMAC_BASE && port <= PC8001.DMAC_BASE + 8) {
      return this.dmac.readPort(port - PC8001.DMAC_BASE);
    }
    return 0xff;
  }

  // Program the machine the way N-BASIC does at boot (80x25 color).
  initTextMode({ cols = 80, rows = 25, vramBase = PC8001.TEXT_VRAM } = {}) {
    const bytesPerFrame = rows * (cols + 40);
    this.out(0x30, cols === 80 ? 1 : 0); // d0=80col, d1=0 color
    // CRTC RESET + 5 params
    this.out(0x51, 0x00);
    this.out(0x50, 0x80 | (cols - 2)); // burst mode, chars per row
    this.out(0x50, 0x40 | (rows - 1)); // blink rate 32 frames, rows
    this.out(0x50, 0x00 | 7); // blink underline cursor, 8 lines/char
    this.out(0x50, (7 - 1) << 5 | (14 - 2)); // 7 vblank rows, hblank
    this.out(0x50, 0x00 | (20 - 1)); // attr mode 0, 20 attrs per row
    // DMAC: autoload, enable ch2
    this.out(0x68, 0x80 | 0x04);
    this.out(0x64, vramBase & 0xff);
    this.out(0x64, vramBase >> 8);
    const tc = 0x8000 | (bytesPerFrame - 1); // read mode + count
    this.out(0x65, tc & 0xff);
    this.out(0x65, tc >> 8);
    // interrupts unmasked, start display, cursor on at 0,0
    this.out(0x51, 0x40);
    this.out(0x51, 0x20);
    this.out(0x51, 0x81);
    this.out(0x50, 0);
    this.out(0x50, 0);
  }

  // convenience: write text + attribute pairs into VRAM
  line(y, { cols = 80, attrBytes = 40, vramBase = PC8001.TEXT_VRAM } = {}) {
    const base = vramBase + y * (cols + attrBytes);
    const mem = this.memory;
    return {
      text(x, str) {
        for (let i = 0; i < str.length; i++) mem[base + x + i] = str.charCodeAt(i) & 0xff;
        return this;
      },
      code(x, ...codes) {
        for (let i = 0; i < codes.length; i++) mem[base + x + i] = codes[i] & 0xff;
        return this;
      },
      attrs(...pairs) {
        // pairs: [pos, value, pos, value, ...]; unused slots pad with (0,0)
        for (let i = 0; i < attrBytes; i++) mem[base + cols + i] = 0;
        for (let i = 0; i < pairs.length && i < attrBytes; i++) mem[base + cols + i] = pairs[i] & 0xff;
        return this;
      },
    };
  }

  // EX mode: arbitrary geometry with enough attribute slots for per-cell
  // control (fantasy silicon rev on both chips — see resetEx/setChannelEx).
  initTextModeEx({
    cols = 80, rows = 25, linesPerChar = 8,
    attrsPerRow = null, attrPerCell = false, vramBase = 0x4000,
  } = {}) {
    const attrs = attrPerCell ? 0 : (attrsPerRow ?? cols * 2); // worst case: color+func change every cell
    const attrBytes = attrPerCell ? cols : attrs * 2;
    this.width80 = true;
    this.colorMode = true;
    this.crtc.resetEx({ cols, rows, linesPerChar, attrsPerRow: attrs, attrPerCell });
    this.dmac.setChannelEx(2, { addr: vramBase, count: rows * (cols + attrBytes) });
    this.out(0x51, 0x40); // unmask VRTC interrupt
    this.out(0x51, 0x20); // start display
    this.ex = { cols, rows, attrsPerRow: attrs, attrPerCell, attrBytesPerRow: attrBytes, vramBase };
    return this.ex;
  }

  update(dt) { this.crtc.update(dt); }
  render(opts = {}) {
    return renderScreen(this.crtc.getScreen(), {
      colorMode: this.colorMode,
      width80: this.width80,
      ...opts,
    });
  }
}
