#!/usr/bin/env node
// pc98tools/boot — run a PC-9801 headlessly and report what came out.
//
// A picture can be judged without a screen: count the dots that are not the
// background, count the distinct colours, print an ASCII thumbnail, and — the
// part that matters most on a text machine — dump the text plane as characters.
// That last one is the difference between "something is on the screen" and
// "the machine is asking for a system disk".
//
// Usage:
//   node pc98tools/boot.mjs --bios BIOS.ROM [--itf ITF.ROM] [--font FONT.ROM]
//                           [--fd0 disk.d88] [--fd1 disk2.d88]
//                           [--frames 600] [--thumb] [--text] [--trace]
//                           [--io] [--io-unknown] [--ppm out.ppm]

import { readFileSync, writeFileSync } from 'node:fs';
import { Pc98Machine } from '../machinepc98.js';
import { parsePc98Disk, summarizePc98Disk, bootRecord } from '../pc98fdd.js';

export function args(argv) {
  const o = { frames: 600 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[k] = true;
    else { o[k] = next; i++; }
  }
  return o;
}

const RAMP = ' .:-=+*#%@';

export function stats(frame) {
  const { width: W, height: H, rgb } = frame;
  const colours = new Set();
  let nonzero = 0;
  for (let i = 0; i < W * H; i++) {
    const c = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
    colours.add(c);
    if (c !== 0) nonzero++;
  }
  return { width: W, height: H, pixels: W * H, nonzero, colours: colours.size,
    pct: W * H ? (100 * nonzero / (W * H)) : 0 };
}

export function thumbnail(frame, cols = 100, rows = 30) {
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
      s += RAMP[Math.min(RAMP.length - 1, Math.floor((n ? sum / n : 0) / 256 * RAMP.length))];
    }
    lines.push(s);
  }
  return lines.join('\n');
}

// The text plane as characters. ASCII passes through, half-width katakana is
// transliterated so a Japanese prompt is legible in a terminal that may not
// have the font, and a kanji shows as its JIS code in brackets.
const KANA = '｡｢｣､･ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ';

export function textDump(machine, rows = 25, cols = 80) {
  const t = machine.video.tvram;
  const start = machine.gdcText.displayStart & 0xfff;
  const out = [];
  for (let r = 0; r < rows; r++) {
    let s = '';
    for (let c = 0; c < cols; c++) {
      const cell = (start + r * cols + c) & 0xfff;
      const code = t[cell * 2] | (t[cell * 2 + 1] << 8);
      const attr = t[0x2000 + cell * 2];
      if (!(attr & 1) || code === 0) { s += ' '; continue; }
      const hi = (code >> 8) & 0x7f, lo = code & 0xff;
      if (hi === 0) {
        if (lo >= 0x20 && lo < 0x7f) s += String.fromCharCode(lo);
        else if (lo >= 0xa1 && lo <= 0xdf) s += KANA[lo - 0xa1] || '?';
        else s += lo === 0 ? ' ' : '.';
      } else if (code & 0x8000) s += '';         // the right half of a kanji
      else s += `[${hi.toString(16)}${lo.toString(16)}]`;
    }
    out.push(s.replace(/\s+$/, ''));
  }
  return out.join('\n');
}

export function loadDisk(path) {
  const bytes = new Uint8Array(readFileSync(path));
  return parsePc98Disk(bytes, { name: path });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = args(process.argv);
  if (!o.bios) { console.error('need --bios <BIOS.ROM>'); process.exit(2); }
  const bios = new Uint8Array(readFileSync(o.bios));
  const itf = o.itf && o.itf !== true ? new Uint8Array(readFileSync(o.itf)) : null;
  const font = o.font && o.font !== true ? new Uint8Array(readFileSync(o.font)) : null;
  const sound = o.sound && o.sound !== true ? new Uint8Array(readFileSync(o.sound)) : null;

  const m = new Pc98Machine({ bios, itf, font, sound, v30: !o.i8086 });
  for (const [k, unit] of [['fd0', 0], ['fd1', 1]]) {
    if (!o[k] || o[k] === true) continue;
    const d = loadDisk(o[k]);
    console.log(`${k}: ${JSON.stringify(summarizePc98Disk(d))} boot=${JSON.stringify(bootRecord(d))}`);
    m.insertDisk(unit, d);
  }
  if (o.io) m.ioLog = [];
  if (o.io || o['io-unknown']) m.unknownIoLog = [];

  const frames = parseInt(o.frames, 10) || 600;
  const t0 = Date.now();
  for (let f = 0; f < frames; f++) {
    m.stepFrame();
    if (o.trace && (f % 30 === 0)) {
      const s = stats(m.render());
      console.log(`frame ${f}: cs:ip=${m.cpu.s[1].toString(16)}:${m.cpu.ip.toString(16)} `
        + `halted=${m.cpu.halted} itf=${m.itfEnabled} text=${m.video.textDisplay} `
        + `gfx=${m.video.gfxDisplay} nonzero=${s.nonzero} colours=${s.colours}`);
    }
  }
  const ms = Date.now() - t0;
  const frame = m.render();
  const s = stats(frame);
  console.log(`\n${frames} frames in ${ms} ms (${(frames * 1000 / ms).toFixed(1)} fps)`);
  console.log(`cs:ip=${m.cpu.s[1].toString(16)}:${m.cpu.ip.toString(16)} halted=${m.cpu.halted} `
    + `itf=${m.itfEnabled} textGDC=${m.gdcText.displayEnabled} gfxGDC=${m.gdcGfx.displayEnabled} `
    + `al=${m.gdcText.al}/${m.gdcGfx.al}`);
  console.log(`picture: ${s.width}x${s.height} nonzero=${s.nonzero} (${s.pct.toFixed(1)}%) colours=${s.colours}`);
  if (o.text) console.log('\n--- text plane ---\n' + textDump(m));
  if (o.thumb) console.log('\n' + thumbnail(frame));
  if (o.io && m.ioLog) {
    const seen = new Map();
    for (const e of m.ioLog) {
      const k = `${e.r ? 'IN ' : 'OUT'} ${e.p.toString(16).padStart(2, '0')}`;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    console.log('\n--- I/O ports touched ---');
    console.log([...seen.entries()].sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} x${n}`).join('\n'));
  }
  if ((o.io || o['io-unknown']) && m.unknownIoLog) {
    const seen = new Map();
    for (const e of m.unknownIoLog) {
      const k = `${e.r ? 'IN ' : 'OUT'} ${e.p.toString(16).padStart(2, '0')}`;
      const site = `${e.cs.toString(16).padStart(4, '0')}:${e.pc.toString(16).padStart(4, '0')}`;
      const old = seen.get(k);
      if (old) old.count++;
      else seen.set(k, { count: 1, site, value: e.v });
    }
    console.log('\n--- unmapped I/O ports ---');
    console.log([...seen.entries()].sort((a, b) => b[1].count - a[1].count)
      .map(([k, e]) => `${k} x${e.count} first=${e.site} value=${e.value.toString(16).padStart(2, '0')}`)
      .join('\n') || '(none)');
  }
  if (o.ppm && o.ppm !== true) {
    const hdr = Buffer.from(`P6\n${frame.width} ${frame.height}\n255\n`, 'ascii');
    writeFileSync(o.ppm, Buffer.concat([hdr, Buffer.from(frame.rgb.buffer, frame.rgb.byteOffset, frame.rgb.length)]));
    console.log(`wrote ${o.ppm}`);
  }
}
