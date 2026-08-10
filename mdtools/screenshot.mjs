#!/usr/bin/env node
// mdtools/screenshot — run a Mega Drive ROM headless and describe what came out.
//
// A browser is the only place the picture can actually be looked at, so this
// tool answers the question a test can answer instead: is there a picture at
// all, and is it plausibly the one the ROM meant to draw? It reports the
// frame's statistics (how much of it is not the backdrop, how many distinct
// colours, whether it changed since the previous frame) and draws an ASCII
// thumbnail, which is enough to tell "title screen" from "black" from "one
// solid colour" without eyes.
//
// Usage:
//   node mdtools/screenshot.mjs <rom> [--frames N] [--ppm out.ppm] [--quiet]
//                                    [--region japan|usa|europe] [--snapsize]
//
// ROMs are never committed. See docs/md-design.md for where to get the ones
// this repo was tested against.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { tryParseMdRom, summarizeMdRom } from '../mdrom.js';
import { MegaDriveMachine } from '../machinemd.js';

const RAMP = ' .:-=+*#%@';

export function runRom(bytes, { frames = 600, region = null, name = '' } = {}) {
  const parsed = tryParseMdRom(bytes, { name });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const machine = new MegaDriveMachine({ cart: parsed.cart, region });
  let prev = null;
  let firstNonBlank = -1;
  let changedFrames = 0;
  for (let i = 0; i < frames; i++) {
    machine.stepFrame();
    const f = machine.render({});
    const st = stats(f);
    if (firstNonBlank < 0 && st.nonBackdrop > 0) firstNonBlank = i;
    if (prev && !sameBuffer(prev, f.rgb)) changedFrames++;
    prev = f.rgb.slice();
  }
  const f = machine.render({});
  return {
    ok: true, machine, cart: parsed.cart, frame: f,
    stats: stats(f), firstNonBlank, changedFrames,
  };
}

export function stats(f) {
  const { width: W, height: H, rgb } = f;
  const n = W * H;
  const colours = new Set();
  let nonBackdrop = 0;
  const bg = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  let lum = 0;
  for (let i = 0; i < n; i++) {
    const c = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
    colours.add(c);
    if (c !== bg) nonBackdrop++;
    lum += (rgb[i * 3] * 299 + rgb[i * 3 + 1] * 587 + rgb[i * 3 + 2] * 114) / 1000;
  }
  return {
    width: W, height: H, pixels: n,
    colours: colours.size,
    nonBackdrop,
    nonBackdropPct: (nonBackdrop / n) * 100,
    meanLuma: lum / n,
    cornerColour: bg,
  };
}

function sameBuffer(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// A luminance thumbnail. Averaging the block rather than sampling its centre
// keeps a one-pixel-wide title font visible instead of aliasing it away.
export function thumbnail(f, cols = 64) {
  const { width: W, height: H, rgb } = f;
  const rows = Math.max(1, Math.round((cols * H) / W / 2.1)); // characters are tall
  const bw = W / cols, bh = H / rows;
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      let sum = 0, count = 0;
      for (let y = Math.floor(r * bh); y < Math.min(H, Math.ceil((r + 1) * bh)); y++) {
        for (let x = Math.floor(c * bw); x < Math.min(W, Math.ceil((c + 1) * bw)); x++) {
          const o = (y * W + x) * 3;
          sum += (rgb[o] * 299 + rgb[o + 1] * 587 + rgb[o + 2] * 114) / 1000;
          count++;
        }
      }
      const v = count ? sum / count : 0;
      line += RAMP[Math.min(RAMP.length - 1, Math.floor((v / 255) * RAMP.length))];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export function writePpm(path, f) {
  const header = Buffer.from(`P6\n${f.width} ${f.height}\n255\n`, 'ascii');
  writeFileSync(path, Buffer.concat([header, Buffer.from(f.rgb.buffer, f.rgb.byteOffset, f.rgb.length)]));
}

// How big one rewind slot really is. JSON is the wrong measure (a Uint8Array
// serialises as an object with 65536 keys), so typed arrays are counted at
// their byte length and everything else at its JSON size.
export function snapshotBytes(snap) {
  let bytes = 0;
  const walk = (v) => {
    if (v == null) return;
    if (ArrayBuffer.isView(v)) { bytes += v.byteLength; return; }
    if (Array.isArray(v)) { bytes += v.length * 8; return; }
    if (typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k]); return; }
    bytes += 8;
  };
  walk(snap);
  return bytes;
}

function main(argv) {
  const args = argv.slice(2);
  if (!args.length) {
    console.error('usage: node mdtools/screenshot.mjs <rom> [--frames N] [--ppm out.ppm] [--region R] [--snapsize] [--quiet]');
    process.exit(2);
  }
  const romPath = args[0];
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const frames = parseInt(opt('--frames', '600'), 10);
  const region = opt('--region', null);
  const ppm = opt('--ppm', null);
  const quiet = args.includes('--quiet');

  const r = runRom(readFileSync(romPath), { frames, region, name: basename(romPath) });
  if (!r.ok) { console.error(`${basename(romPath)}: ${r.error}`); process.exit(1); }

  const s = r.stats;
  const info = summarizeMdRom(r.cart);
  console.log(`${basename(romPath)}  ${info.title || '(no title)'}  ${info.sizeKb}KB  ${info.regions}  checksum=${info.checksum}  sram=${info.sram}`);
  console.log(`frames=${frames}  ${s.width}x${s.height}  colours=${s.colours}  non-backdrop=${s.nonBackdropPct.toFixed(1)}%  mean-luma=${s.meanLuma.toFixed(1)}  first-nonblank-frame=${r.firstNonBlank}  animated-frames=${r.changedFrames}`);
  console.log(`pc=$${r.machine.cpu.pc.toString(16)}  halted=${r.machine.cpu.halted}  z80=${r.machine.z80Running ? 'running' : 'held'}  vdp.reg1=$${r.machine.vdp.reg[1].toString(16)}`);
  if (args.includes('--snapsize')) {
    const b = snapshotBytes(r.machine.snapshot());
    console.log(`snapshot=${(b / 1024).toFixed(1)}KB  ->  1000 slots = ${(b / 1024 / 1024 * 1000).toFixed(0)}MB`);
  }
  if (!quiet) console.log(thumbnail(r.frame));
  if (ppm) { writePpm(ppm, r.frame); console.log(`wrote ${ppm}`); }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
