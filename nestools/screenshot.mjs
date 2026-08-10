#!/usr/bin/env node
// screenshot.mjs — run a .nes ROM headless and report what came out.
//
// "Does it boot?" is not a yes/no an emulator can answer for itself, but the
// frame buffer can be measured: a game that reached its title screen has
// hundreds of distinct colours over most of the picture, and a game that died
// has one colour, or 61,440 identical pixels, or a screen full of tile $00.
// So this prints the numbers AND a coarse ASCII thumbnail, which is enough to
// recognise a title screen by eye in a terminal.
//
// ROMs are not in this repository and must not be committed. Point the tool at
// wherever yours live:
//   node nestools/screenshot.mjs game.nes --frames 300 --art
//
// Options:
//   --frames N   frames to run before sampling (default 240 ≈ 4 seconds)
//   --art        print a 64x30 ASCII thumbnail
//   --ppm FILE   write the frame as a binary PPM (viewable, diffable)
//   --press K    hold a button for the whole run (start/a/b/select)

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tryParseINes, summarizeINes } from '../ines.js';
import { tryCreateMapper } from '../nesmapper.js';
import { NesMachine, BUTTON } from '../machinenes.js';

const RAMP = ' .:-=+*#%@';

export function runRom(bytes, { frames = 240, press = null, name = 'rom' } = {}) {
  const parsed = tryParseINes(bytes);
  if (!parsed.ok) return { name, ok: false, error: parsed.error };
  const cart = parsed.cart;
  const support = tryCreateMapper(cart);
  if (!support.ok) return { name, ok: false, error: support.error, info: summarizeINes(cart) };

  const m = new NesMachine({ cart });
  if (press) for (const k of press.split(',')) {
    const bit = BUTTON[k.trim().toUpperCase()];
    if (bit !== undefined) m.padDown(bit, 0);
  }
  // A held button has to be released and pressed again for menus that debounce;
  // toggling every 30 frames covers both "hold to skip" and "press to start".
  for (let f = 0; f < frames; f++) {
    if (press && f % 30 === 0) {
      for (const k of press.split(',')) {
        const bit = BUTTON[k.trim().toUpperCase()];
        if (bit !== undefined) { if (f % 60 === 0) m.padDown(bit, 0); else m.padUp(bit, 0); }
      }
    }
    m.stepFrame();
  }

  const buf = m.ppu.frameBuf;
  const hist = new Uint32Array(64);
  for (let i = 0; i < buf.length; i++) hist[buf[i] & 0x3f]++;
  let colours = 0, top = 0, topIdx = 0;
  for (let c = 0; c < 64; c++) {
    if (hist[c]) colours++;
    if (hist[c] > top) { top = hist[c]; topIdx = c; }
  }
  return {
    name, ok: true, machine: m,
    info: summarizeINes(cart),
    frames,
    colours,
    dominant: topIdx,
    dominantPct: Math.round((top / buf.length) * 100),
    nonBackdrop: buf.length - top,
    pc: m.cpu.pc,
  };
}

// Luminance-ranked ASCII, sampled 4x8 → one character.
export function asciiArt(m, cols = 64, rows = 30) {
  const f = m.render();
  const { width: W, height: H, rgb } = f;
  const out = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      let sum = 0, n = 0;
      const x0 = Math.floor((c * W) / cols), x1 = Math.floor(((c + 1) * W) / cols);
      const y0 = Math.floor((r * H) / rows), y1 = Math.floor(((r + 1) * H) / rows);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const o = (y * W + x) * 3;
        sum += 0.299 * rgb[o] + 0.587 * rgb[o + 1] + 0.114 * rgb[o + 2];
        n++;
      }
      const v = n ? sum / n / 255 : 0;
      line += RAMP[Math.min(RAMP.length - 1, Math.round(v * (RAMP.length - 1)))];
    }
    out.push(line);
  }
  return out.join('\n');
}

export function writePpm(m, path) {
  const { width: W, height: H, rgb } = m.render();
  const header = Buffer.from(`P6\n${W} ${H}\n255\n`, 'ascii');
  writeFileSync(path, Buffer.concat([header, Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length)]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const frames = Number(opt('--frames', 240));
  const press = opt('--press', null);
  const ppm = opt('--ppm', null);
  const art = args.includes('--art');
  const paths = args.filter((a, i) => !a.startsWith('--') && !['--frames', '--press', '--ppm'].includes(args[i - 1]));
  const roms = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) { if (f.endsWith('.nes')) roms.push(join(p, f)); }
    else roms.push(p);
  }
  if (!roms.length) { console.error('usage: node nestools/screenshot.mjs <rom.nes|dir> [--frames N] [--art] [--ppm out.ppm] [--press start]'); process.exit(2); }
  for (const path of roms) {
    let r;
    try { r = runRom(readFileSync(path), { frames, press, name: basename(path) }); }
    catch (e) { r = { name: basename(path), ok: false, error: e.message }; }
    if (!r.ok) { console.log(`SKIP  ${r.name}: ${r.error}`); continue; }
    const i = r.info;
    console.log(`${r.name}  [${i.board} · ${i.prgKB}K PRG · ${i.chrKB || i.chrRamKB + 'K CHR-RAM'} · ${i.mirroring}]`);
    console.log(`      after ${r.frames} frames: ${r.colours} colours, backdrop $${r.dominant.toString(16)} covers ${r.dominantPct}%, pc=$${r.pc.toString(16)}`);
    if (art) console.log(asciiArt(r.machine));
    if (ppm) { writePpm(r.machine, ppm); console.log(`      wrote ${ppm}`); }
  }
}
