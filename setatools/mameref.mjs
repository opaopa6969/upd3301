#!/usr/bin/env node
// setatools/mameref — diff this machine against MAME.
//
// The method docs/m88-comparison.md used against M88 for the PC-8801, with one
// large simplification: MAME needs no patching. `-video none` plus a Lua script
// is enough to make it dump its state, so the oracle is an install rather than
// a build. See docs/seta-design.md section 9 for the whole procedure.
//
// Two modes, and they answer different questions.
//
//   --ref  <state dump>   compares work RAM, the palette and both sprite tables
//                         REGION BY REGION. A wrong picture has a dozen possible
//                         causes; a wrong region has one. If the regions agree
//                         and the screen does not, the fault is in x1001.js and
//                         nowhere else.
//
//   --pix  <pixel dump>   compares the finished picture PIXEL BY PIXEL. This is
//                         the one that found the real bug: MAME's sprite offset
//                         setters take (flip, noflip) — flip first — and reading
//                         them the other way puts the whole picture two pixels
//                         out vertically. No unit test would have noticed; the
//                         pixel diff found it in one run and pointed straight at
//                         "a constant vertical shift".
//
// Frame numbering: MAME's `register_frame_done` counts its first completed frame
// as 1, and the picture it holds corresponds to this machine's `frame` counter
// MINUS ONE. `--offset` accounts for that; -1 is the default for --pix because
// it is the alignment that actually matches.
//
// Usage:
//   node setatools/mameref.mjs --zip thunderl.zip --ref /tmp/ref.txt
//   node setatools/mameref.mjs --zip thunderl.zip --pix /tmp/pix.bin

import { readFileSync } from 'node:fs';
import { loadSetaRomSet } from '../setarom.js';
import { SetaMachine } from '../machineseta.js';

function args(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[k] = true; else { o[k] = next; i++; }
  }
  return o;
}

export function parseStateRef(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'frame') { cur = { frame: parseInt(rest, 10), regs: {}, mem: {} }; out.push(cur); continue; }
    if (!cur) continue;
    if (key === 'pc') {
      const m = rest.match(/^([0-9a-f]+) sr ([0-9a-f]+)$/);
      if (m) { cur.regs.pc = parseInt(m[1], 16); cur.regs.sr = parseInt(m[2], 16); }
      continue;
    }
    if (/^[da][0-7]$/.test(key)) { cur.regs[key] = parseInt(rest, 16) >>> 0; continue; }
    const bytes = new Uint8Array(rest.length >> 1);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(rest.substr(i * 2, 2), 16);
    cur.mem[key] = bytes;
  }
  return out;
}

// The pixel dump: one header line, then raw ARGB32 blocks in the header's order.
export function parsePixRef(buf) {
  const nl = buf.indexOf(10);
  const head = Buffer.from(buf.subarray(0, nl)).toString('ascii').trim().split(' ');
  const frames = head[1].split(',').map(Number);
  const width = +head[2], height = +head[3];
  return { frames, width, height, base: nl + 1, buf };
}

// Read the same regions out of this machine, through the same addresses, so a
// mistake in the address decoder shows up rather than hiding.
function readRegion(m, name) {
  const rd = (base, len) => { const b = new Uint8Array(len); for (let i = 0; i < len; i++) b[i] = m._read8(base + i); return b; };
  switch (name) {
    case 'ram': return rd(m.board.ramBase, m.board.ramSize);
    case 'pal': return rd(0x700000, 0x400);
    case 'spry': return rd(0xd00000, 0x600);
    case 'sprctrl': return rd(0xd00600, 8);
    case 'sprc': return rd(0xe00000, 0x4000);
    default: return null;
  }
}

function compare(a, b) {
  const n = Math.min(a.length, b.length);
  let diff = 0, first = -1;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) { diff++; if (first < 0) first = i; }
  return { diff, first, n };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = args(process.argv);
  if (!o.zip || (!o.ref && !o.pix)) {
    console.error('usage: node setatools/mameref.mjs --zip <romset.zip> (--ref <state dump> | --pix <pixel dump>) [--set name] [--offset N]');
    process.exit(2);
  }
  const romset = await loadSetaRomSet(new Uint8Array(readFileSync(o.zip)),
    { name: o.zip, set: typeof o.set === 'string' ? o.set : null });
  const m = new SetaMachine({ romset });
  let run = 0, bad = 0, total = 0;

  if (o.ref) {
    const offset = o.offset !== undefined ? parseInt(o.offset, 10) : 0;
    for (const snap of parseStateRef(readFileSync(o.ref, 'utf8'))) {
      while (run < snap.frame + offset) { m.stepFrame(); run++; }
      console.log(`== frame ${snap.frame}`);
      for (const name of Object.keys(snap.mem)) {
        const ours = readRegion(m, name);
        if (!ours) continue;
        total++;
        const c = compare(ours, snap.mem[name]);
        if (c.diff) bad++;
        console.log(`   ${name.padEnd(8)} ${c.diff}/${c.n} bytes differ (${(100 * c.diff / c.n).toFixed(2)}%)`
          + (c.diff ? `  first @ +0x${c.first.toString(16)} ours=${ours[c.first].toString(16)} mame=${snap.mem[name][c.first].toString(16)}` : ''));
      }
    }
    console.log(`${total - bad}/${total} regions identical`);
  }

  if (o.pix) {
    // The default alignment, explained in the header. Pass --offset 0 to see the
    // raw counter-to-counter comparison instead.
    const offset = o.offset !== undefined ? parseInt(o.offset, 10) : -1;
    const ref = parsePixRef(new Uint8Array(readFileSync(o.pix)));
    const { frames, width: W, height: H, base, buf } = ref;
    console.log(`ref ${frames.length} frames at ${W}x${H}, frame offset ${offset}`);
    for (let k = 0; k < frames.length; k++) {
      while (run < frames[k] + offset) { m.stepFrame(); run++; }
      // The board's own orientation: MAME's bitmap is not rotated for the cabinet.
      const fr = m.render({ rotate: false });
      if (fr.width !== W || fr.height !== H) { console.log(`   size mismatch: ours ${fr.width}x${fr.height}`); bad++; total++; continue; }
      const off = base + k * W * H * 4;
      let d = 0, firstBad = -1;
      for (let i = 0; i < W * H; i++) {
        const p = off + i * 4, q = i * 3;
        // ARGB32 little-endian in memory is B, G, R, A.
        if (fr.rgb[q] !== buf[p + 2] || fr.rgb[q + 1] !== buf[p + 1] || fr.rgb[q + 2] !== buf[p]) {
          d++; if (firstBad < 0) firstBad = i;
        }
      }
      total++; if (d) bad++;
      console.log(`   frame ${String(frames[k]).padStart(5)}  ${String(d).padStart(6)}/${W * H} pixels differ (${(100 * d / (W * H)).toFixed(3)}%)`
        + (d ? `  first at ${firstBad % W},${(firstBad / W) | 0}` : ''));
    }
    console.log(`${total - bad}/${total} frames pixel-identical`);
  }

  process.exit(bad ? 1 : 0);
}
