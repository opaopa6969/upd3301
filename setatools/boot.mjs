#!/usr/bin/env node
// setatools/boot — run a Seta board headlessly and report what came out.
//
// A picture can be judged without a screen: count the dots that are not the
// background, count the distinct colours, and print an ASCII thumbnail. That is
// what nestools/screenshot.mjs, mdtools and x68tools/boot.mjs do, and it is the
// only honest way to say "this board boots" from a terminal.
//
// Usage:
//   node setatools/boot.mjs --zip /path/to/thunderl.zip [--set thunderl]
//                           [--frames 600] [--coin] [--start]
//                           [--thumb] [--raw] [--trace] [--ppm out.ppm]
//
// The ROM path is an argument, never a constant: no ROM is committed here.

import { readFileSync, writeFileSync } from 'node:fs';
import { loadSetaRomSet } from '../setarom.js';
import { SetaMachine, BUTTON } from '../machineseta.js';

function args(argv) {
  const o = { frames: 600 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[k] = true;
    else { o[k] = next; i++; }
  }
  return o;
}

const RAMP = ' .:-=+*#%@';

export function stats(frame) {
  const { width: W, height: H, rgb } = frame;
  const colours = new Set();
  const hist = new Map();
  for (let i = 0; i < W * H; i++) {
    const c = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
    colours.add(c);
    hist.set(c, (hist.get(c) || 0) + 1);
  }
  // "nonzero" is the wrong question on a board whose background is a palette
  // entry the game chooses. The honest measure is "pixels that are not the most
  // common colour" — that is the drawn content.
  let bg = 0, bgN = -1;
  for (const [c, n] of hist) if (n > bgN) { bgN = n; bg = c; }
  return { width: W, height: H, pixels: W * H, bg, bgN,
           drawn: W * H - bgN, colours: colours.size,
           pct: W * H ? (100 * (W * H - bgN) / (W * H)) : 0 };
}

export function thumbnail(frame, cols = 60, rows = 40) {
  const { width: W, height: H, rgb } = frame;
  if (!W || !H) return '(no picture)';
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let s = '';
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor(c * W / cols), x1 = Math.max(x0 + 1, Math.floor((c + 1) * W / cols));
      const y0 = Math.floor(r * H / rows), y1 = Math.max(y0 + 1, Math.floor((r + 1) * H / rows));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 3;
          sum += (rgb[i] * 299 + rgb[i + 1] * 587 + rgb[i + 2] * 114) / 1000;
          n++;
        }
      }
      const v = n ? sum / n : 0;
      s += RAMP[Math.min(RAMP.length - 1, Math.floor(v / 256 * RAMP.length))];
    }
    lines.push(s);
  }
  return lines.join('\n');
}

// How big one rewind slot really is. JSON is the wrong measure (a Uint8Array
// serialises as an object with thousands of keys), so typed arrays are counted
// at their byte length and everything else at eight bytes a value. Same
// arithmetic as mdtools/screenshot.mjs and the host's ring budget, so the
// numbers in the docs are comparable across machines.
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

// Per-part breakdown, so the design doc can say WHERE the bytes go.
export function snapshotBreakdown(snap) {
  const out = {};
  for (const k of Object.keys(snap)) {
    const one = {}; one[k] = snap[k];
    out[k] = snapshotBytes(one);
  }
  return out;
}

export function writePpm(path, frame) {
  const { width: W, height: H, rgb } = frame;
  const head = Buffer.from(`P6\n${W} ${H}\n255\n`, 'ascii');
  writeFileSync(path, Buffer.concat([head, Buffer.from(rgb.buffer, rgb.byteOffset, W * H * 3)]));
}

export async function bootSet({ zip, set = null, frames = 600, coinAt = -1, startAt = -1, onFrame = null }) {
  const bytes = new Uint8Array(readFileSync(zip));
  const romset = await loadSetaRomSet(bytes, { set, name: zip });
  const m = new SetaMachine({ romset });
  for (let f = 0; f < frames; f++) {
    if (f === coinAt) m.insertCoin(0);
    if (f === startAt) m.padDown(BUTTON.START, 0);
    if (f === startAt + 4) m.padUp(BUTTON.START, 0);
    m.stepFrame();
    if (onFrame) onFrame(m, f);
  }
  return { machine: m, romset };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = args(process.argv);
  if (!o.zip) { console.error('need --zip <romset.zip>'); process.exit(2); }
  const frames = parseInt(o.frames, 10) || 600;
  const coinAt = o.coin ? Math.floor(frames * 0.4) : -1;
  const startAt = o.start ? Math.floor(frames * 0.5) : -1;
  const { machine, romset } = await bootSet({
    zip: o.zip, set: typeof o.set === 'string' ? o.set : null, frames, coinAt, startAt,
    onFrame: o.trace ? (m, f) => {
      if (f % 60 === 0) console.log(`  f${f} pc=${m.cpu.pc.toString(16)} sr=${m.cpu.sr.toString(16)} irq=${m.irqLines} prot=${m.protReg.toString(16)}`);
    } : null,
  });
  console.log(`${romset.set} — ${romset.title} (${romset.year} ${romset.maker}), board ${romset.board}`);
  for (const w of romset.warnings) console.log(`  ! ${w}`);
  console.log(`  ROMs: ${romset.matched.length} matched, ${romset.missing.length} missing`);
  const frame = machine.render({ rotate: o.raw ? false : null });
  const s = stats(frame);
  console.log(`  ${s.width}x${s.height} drawn=${s.drawn} (${s.pct.toFixed(1)}%) colours=${s.colours} bg=#${s.bg.toString(16).padStart(6, '0')}`);
  const snap = machine.snapshot();
  console.log(`  pc=${machine.cpu.pc.toString(16)} halted=${machine.cpu.halted} frame=${machine.frame} snapshot=${(snapshotBytes(snap) / 1024).toFixed(1)} KB`);
  if (o.snapsize) {
    const parts = Object.entries(snapshotBreakdown(snap)).sort((a, b) => b[1] - a[1]);
    for (const [k, n] of parts) if (n >= 64) console.log(`    ${k.padEnd(12)} ${(n / 1024).toFixed(1)} KB`);
  }
  if (o.thumb) console.log(thumbnail(frame));
  if (typeof o.ppm === 'string') { writePpm(o.ppm, frame); console.log(`  wrote ${o.ppm}`); }
}
