#!/usr/bin/env node
// x68tools/boot — run an X68000 headlessly and report what came out.
//
// The whole point is that a picture can be judged without a screen: count the
// dots that are not the background, count the distinct colours, and print an
// ASCII thumbnail. That is what nestools/screenshot.mjs and mdtools do, and it
// is the only honest way to say "this disk boots" from a terminal.
//
// Usage:
//   node x68tools/boot.mjs --ipl IPLROM.DAT [--cgrom CGROM.DAT]
//                          [--fd0 disk.dim] [--fd1 disk2.dim]
//                          [--frames 600] [--ram 2097152]
//                          [--thumb] [--trace] [--png out.png]

import { readFileSync, writeFileSync } from 'node:fs';
import { X68000Machine } from '../machinex68.js';
import { parseX68Disk, summarizeX68Disk, bootRecord } from '../x68fdd.js';

function args(argv) {
  const o = { frames: 600 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) o[k] = true;
      else { o[k] = next; i++; }
    }
  }
  return o;
}

const RAMP = ' .:-=+*#%@';

export function stats(frame) {
  const { width: W, height: H, rgb } = frame;
  const colours = new Set();
  let nonzero = 0;
  for (let i = 0; i < W * H; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const c = (r << 16) | (g << 8) | b;
    colours.add(c);
    if (c !== 0) nonzero++;
  }
  return { width: W, height: H, pixels: W * H, nonzero, colours: colours.size,
           pct: W * H ? (100 * nonzero / (W * H)) : 0 };
}

export function thumbnail(frame, cols = 96, rows = 32) {
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

export function bootMachine({ ipl, cgrom, sram, disks = [], ram, frames = 600, onFrame = null }) {
  const m = new X68000Machine({ ipl, cgrom, sram, ram });
  disks.forEach((d, i) => { if (d) m.insertDisk(i, d); });
  for (let f = 0; f < frames; f++) {
    m.stepFrame();
    if (onFrame) onFrame(m, f);
  }
  return m;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = args(process.argv);
  if (!o.ipl) { console.error('need --ipl <IPLROM.DAT>'); process.exit(2); }
  const ipl = new Uint8Array(readFileSync(o.ipl));
  const cgrom = o.cgrom ? new Uint8Array(readFileSync(o.cgrom)) : null;
  const sram = o.sram ? new Uint8Array(readFileSync(o.sram)) : null;
  const disks = [];
  for (const k of ['fd0', 'fd1']) {
    if (!o[k]) { disks.push(null); continue; }
    const bytes = new Uint8Array(readFileSync(o[k]));
    const d = parseX68Disk(bytes, { name: o[k] });
    console.log(`${k}: ${JSON.stringify(summarizeX68Disk(d))} boot=${JSON.stringify(bootRecord(d))}`);
    disks.push(d);
  }

  const m = new X68000Machine({ ipl, cgrom, sram, ram: o.ram ? parseInt(o.ram, 10) : undefined });
  disks.forEach((d, i) => { if (d) m.insertDisk(i, d); });

  const frames = parseInt(o.frames, 10) || 600;
  const t0 = Date.now();
  let lastPc = 0;
  for (let f = 0; f < frames; f++) {
    m.stepFrame();
    lastPc = m.cpu.pc;
    if (o.trace && (f % 30 === 0)) {
      const s = stats(m.render());
      console.log(`frame ${f}: pc=${lastPc.toString(16)} sr=${m.cpu.getSR().toString(16)} ${s.width}x${s.height} nonzero=${s.nonzero} colours=${s.colours} halted=${m.cpu.halted}`);
    }
  }
  const ms = Date.now() - t0;
  const frame = m.render();
  const s = stats(frame);
  console.log(`\n${frames} frames in ${ms} ms (${(frames * 1000 / ms).toFixed(1)} fps)`);
  console.log(`pc=${m.cpu.pc.toString(16)} halted=${m.cpu.halted} crtc=${m.crtc.width}x${m.crtc.height} step=${m.crtc.verticalStep} highReso=${m.crtc.highReso}`);
  console.log(`picture: ${s.width}x${s.height} nonzero=${s.nonzero} (${s.pct.toFixed(1)}%) colours=${s.colours}`);
  if (o.thumb) console.log('\n' + thumbnail(frame));
  if (o.png) {
    // A raw PPM is enough for eyeballing outside the terminal and needs no
    // encoder; `pnmtopng` or any viewer will take it.
    const hdr = Buffer.from(`P6\n${frame.width} ${frame.height}\n255\n`, 'ascii');
    writeFileSync(o.png, Buffer.concat([hdr, Buffer.from(frame.rgb.buffer, frame.rgb.byteOffset, frame.rgb.length)]));
    console.log(`wrote ${o.png}`);
  }
}
