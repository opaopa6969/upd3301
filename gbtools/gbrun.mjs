// gbtools/gbrun — the shared half of the Game Boy verification tools.
//
// (`tools/` belongs to the PC-8801 parity work and is not to be touched, so
// the console's tools live here, next to `nestools/`.)
//
// Two test suites, two completely different ways of saying "passed", and
// neither of them needs a screen:
//
//   blargg   prints its report through the SERIAL PORT, one character at a
//            time, and also to the screen. Nothing is plugged into the link
//            port, so the bytes go nowhere on hardware — but an emulator can
//            read them, and that is the whole trick. The later suites
//            (mem_timing-2, halt_bug, oam_bug, the sound ones) do NOT use the
//            serial port; they leave the same text in cartridge RAM at $A000,
//            behind the signature $DE $B0 $61 — the identical protocol his
//            Famicom suites use at $6000.
//   mooneye  loads six registers with the start of the Fibonacci sequence
//            (3, 5, 8, 13, 21, 34) and executes `LD B,B`, which is a NOP the
//            authors chose as a software breakpoint. Any other value in those
//            registers means failure. It ALSO sends the same six bytes over
//            the serial port, so either detector works; the breakpoint is
//            faster because it does not need the test to finish sending.

import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { GbMachine } from '../machinegb.js';
import { parseGbRom } from '../gbmbc.js';

export const MOONEYE_PASS = [3, 5, 8, 13, 21, 34];

// The bundled ROMs in gbroms/ are stored gzipped. Not to be clever: several
// of mooneye's bank-switching tests are 8MB of mostly padding, and the whole
// corpus goes from 26MB to under 700KB — which is the difference between "a
// test fixture you can check in" and "a test fixture you cannot". A plain
// `.gb` is read as-is, so an external ROM still works unchanged.
export function readRomFile(path) {
  const p = existsSync(path) ? path : (existsSync(`${path}.gz`) ? `${path}.gz` : path);
  const bytes = new Uint8Array(readFileSync(p));
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return new Uint8Array(gunzipSync(Buffer.from(bytes)));
  return bytes;
}

export function loadRom(path) {
  return parseGbRom(readRomFile(path));
}

// Run until one of the detectors fires or the frame budget runs out. The
// budget is in frames because that is what a human would set a stopwatch by;
// most of these ROMs finish in well under a hundred.
export function runTest(romPath, { frames = 3600, model = 'auto', onFrame = null } = {}) {
  const cart = loadRom(romPath);
  const gb = new GbMachine({ cart, model });
  let breakpoint = null;
  gb.onBreakpoint = (cpu) => {
    if (breakpoint) return;
    const regs = [cpu.b, cpu.c, cpu.d, cpu.e, cpu.h, cpu.l];
    // `LD B,B` is a real instruction, and blargg's "06-ld r,r" executes it
    // 256 times on purpose. Only the two register patterns mooneye actually
    // signals with count as a breakpoint — otherwise the detector for one
    // suite silently truncates the other.
    const isPass = MOONEYE_PASS.every((v, i) => regs[i] === v);
    const isFail = regs.every((v) => v === 0x42);
    if (!isPass && !isFail) return;
    breakpoint = { b: cpu.b, c: cpu.c, d: cpu.d, e: cpu.e, h: cpu.h, l: cpu.l };
  };
  let ranFrames = 0;
  for (let i = 0; i < frames; i++) {
    gb.stepFrame();
    ranFrames++;
    if (onFrame) onFrame(gb, i);
    if (breakpoint) break;
    // blargg finishes by printing a line containing "Passed" or "Failed";
    // stopping there rather than at the frame limit keeps a full sweep quick.
    const ram = blarggRam(gb);
    if (ram && ram.status !== 0x80) break;
    const t = gb.serialText();
    if (t.includes('Passed') || t.includes('Failed') || t.includes('Error')) {
      // Give it a few more frames to finish the sentence.
      for (let j = 0; j < 4; j++) { gb.stepFrame(); ranFrames++; }
      break;
    }
  }
  const serial = gb.serialText();
  return { gb, cart, breakpoint, serial, frames: ranFrames };
}

export function judgeMooneye(r) {
  if (!r.breakpoint) {
    // Fall back to the serial report for a ROM that never reached the
    // breakpoint we watch (or for a hardware model it refuses to run on).
    const bytes = r.gb.serialOut;
    if (bytes.length >= 6) {
      const last = bytes.slice(-6);
      return { pass: MOONEYE_PASS.every((v, i) => last[i] === v), how: 'serial', regs: last };
    }
    return { pass: false, how: 'timeout', regs: null };
  }
  const { b, c, d, e, h, l } = r.breakpoint;
  const regs = [b, c, d, e, h, l];
  return { pass: MOONEYE_PASS.every((v, i) => regs[i] === v), how: 'breakpoint', regs };
}

// The $A000 report: a status byte, then $DE $B0 $61, then NUL-terminated
// text. The signature is what tells "the test has started" apart from "the
// save RAM happens to be zero".
export function blarggRam(gb) {
  const ram = gb.mbc && gb.mbc.ram;
  if (!ram || ram.length < 0x100) return null;
  if (ram[1] !== 0xde || ram[2] !== 0xb0 || ram[3] !== 0x61) return null;
  let text = '';
  for (let i = 4; i < ram.length && ram[i] !== 0 && text.length < 1024; i++) text += String.fromCharCode(ram[i]);
  return { status: ram[0], text };
}

export function judgeBlargg(r) {
  const ram = blarggRam(r.gb);
  if (ram && ram.status !== 0x80) return { pass: ram.status === 0, text: ram.text.trim() };
  const t = r.serial.replace(/\0/g, '');
  if (/Passed/.test(t)) return { pass: true, text: t.trim() };
  if (/Failed|Error/.test(t)) return { pass: false, text: t.trim() };
  return { pass: false, text: t.trim() || '(no serial output)' };
}

// A rough byte count for a snapshot, the same shape as the one demo/ice.js
// uses for its tree view: typed arrays cost their bytes, numbers cost eight,
// and the object overhead is a token amount so that a state made of a hundred
// scalars does not look free.
export function snapSize(o) {
  if (o == null) return 0;
  if (ArrayBuffer.isView(o)) return o.byteLength;
  if (typeof o === 'number') return 8;
  if (typeof o === 'boolean') return 1;
  if (typeof o === 'string') return o.length * 2;
  if (Array.isArray(o)) return o.reduce((s, x) => s + snapSize(x), 8);
  if (typeof o === 'object') return Object.values(o).reduce((s, x) => s + snapSize(x), 8);
  return 8;
}

// An ASCII thumbnail, for looking at a frame in a terminal. Same idea as
// nestools/screenshot.mjs.
export function asciiFrame(gb, cols = 64) {
  const { width, height, rgb } = gb.render();
  const rows = Math.max(1, Math.round((cols * height) / width / 2.2));
  const ramp = ' .:-=+*#%@';
  const lines = [];
  for (let ry = 0; ry < rows; ry++) {
    let line = '';
    for (let rx = 0; rx < cols; rx++) {
      const x = Math.floor((rx * width) / cols), y = Math.floor((ry * height) / rows);
      const o = (y * width + x) * 3;
      const lum = (rgb[o] * 0.3 + rgb[o + 1] * 0.59 + rgb[o + 2] * 0.11) / 255;
      line += ramp[Math.min(ramp.length - 1, Math.round((1 - lum) * (ramp.length - 1)))];
    }
    lines.push(line);
  }
  return lines.join('\n');
}
