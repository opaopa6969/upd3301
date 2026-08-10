#!/usr/bin/env node
// x68tools/sweep — run a pile of disk images and classify what each one did.
//
// The PC-8801 side of this repository settled its accuracy by running 353
// disks in one go and only chasing the ones that came out wrong; this is the
// same idea for the X68000. A disk is judged from the frame buffer alone:
//
//   ok      the picture has content and more than one colour
//   flat    exactly one colour on screen. Often correct (a black loading
//           screen is a real thing) but worth a second look.
//   black   nothing at all, and the CPU is somewhere it should not be
//   halted  the 68000 took a double bus fault
//   slow    the wall-clock cap ran out before the frame count did
//   reject  the file would not parse as a floppy image
//
// Usage:
//   node x68tools/sweep.mjs --ipl IPL.DAT --cgrom CG.DAT --dir <dir>
//                           [--frames 1200] [--limit 50] [--maxms 30000]
//                           [--json out.json]

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { X68000Machine } from '../machinex68.js';
import { tryParseX68Disk, summarizeX68Disk, bootRecord } from '../x68fdd.js';

function args(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) o[k] = true; else { o[k] = n; i++; }
  }
  return o;
}

const EXT = /\.(dim|xdf|img|2hd|d88|88d|hdm)$/i;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(e) && st.size > 100000) out.push(p);
  }
  return out;
}

export function classify(machine) {
  const f = machine.render();
  const { width: W, height: H, rgb } = f;
  if (!W || !H) return { verdict: 'black', colours: 0, nonzero: 0, width: W, height: H };
  const seen = new Set();
  let nonzero = 0;
  for (let i = 0; i < W * H; i++) {
    const c = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
    seen.add(c);
    if (c) nonzero++;
  }
  const colours = seen.size;
  let verdict;
  if (machine.cpu.halted) verdict = 'halted';
  else if (colours <= 1 && nonzero === 0) verdict = 'black';
  else if (colours <= 1) verdict = 'flat';
  else verdict = 'ok';
  return { verdict, colours, nonzero, width: W, height: H };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = args(process.argv);
  if (!o.ipl || !o.dir) { console.error('need --ipl and --dir'); process.exit(2); }
  const ipl = new Uint8Array(readFileSync(o.ipl));
  const cgrom = o.cgrom ? new Uint8Array(readFileSync(o.cgrom)) : null;
  const sram = o.sram ? new Uint8Array(readFileSync(o.sram)) : null;
  const frames = parseInt(o.frames, 10) || 1200;
  const maxMs = parseInt(o.maxms, 10) || 30000;
  let files = walk(o.dir).sort();
  if (o.limit) files = files.slice(0, parseInt(o.limit, 10));

  const tally = {};
  const rows = [];
  for (const p of files) {
    const name = p.slice(o.dir.length + 1);
    let row;
    try {
      const parsed = tryParseX68Disk(new Uint8Array(readFileSync(p)), { name: p });
      if (!parsed.ok) { row = { name, verdict: 'reject', why: parsed.error }; }
      else {
        const disk = parsed.disk;
        const m = new X68000Machine({ ipl, cgrom, sram });
        m.insertDisk(0, disk);
        const t0 = Date.now();
        // A wall-clock cap, not just a frame count: an image that programs a
        // pathological screen can make one frame cost seconds, and one such
        // disk should not stall a sweep of four hundred.
        let ran = 0;
        for (let i = 0; i < frames; i++) {
          m.stepFrame();
          ran++;
          if (Date.now() - t0 > maxMs) break;
        }
        const c = classify(m);
        row = { name, ...c, frames: ran, ms: Date.now() - t0, pc: m.cpu.pc.toString(16),
                media: summarizeX68Disk(disk).media, boot: bootRecord(disk) };
        if (ran < frames) row.verdict = 'slow';
      }
    } catch (e) {
      row = { name, verdict: 'reject', why: e.message };
    }
    tally[row.verdict] = (tally[row.verdict] || 0) + 1;
    rows.push(row);
    console.log(`${row.verdict.padEnd(7)} ${String(row.colours ?? '').padStart(5)}c ${String(row.nonzero ?? '').padStart(7)}px ${(row.width ?? '') + 'x' + (row.height ?? '')} ${name}${row.why ? ' — ' + row.why : ''}`);
  }
  console.log('\n' + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join('  ') + `  total=${rows.length}`);
  if (o.json) writeFileSync(o.json, JSON.stringify(rows, null, 1));
}
