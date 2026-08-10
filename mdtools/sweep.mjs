#!/usr/bin/env node
// mdtools/sweep — run a whole directory of Mega Drive ROMs headless and sort
// the results into buckets. The same move that worked on 353 PC-8801 disks in
// docs/m88-comparison.md: run everything, classify mechanically, then look
// only at the ones that failed.
//
// A ROM is judged by what its frame buffer looks like after N frames, because
// that is the one thing a headless run can see:
//
//   halted   the 68000 took a double bus fault and stopped — a real bug here
//   black    the picture never became anything but the backdrop
//   flat     one colour only: it drew, but nothing recognisable
//   static   a picture that never changed after it appeared
//   ok       a picture with several colours that kept moving
//
// "ok" is not "correct" — only a browser and a pair of eyes can say that. It
// means the machine got far enough to draw something that behaves like a title
// screen. Anything not "ok" is worth opening.
//
// Usage: node mdtools/sweep.mjs <dir> [--frames N] [--filter substring] [--json]

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { runRom } from './screenshot.mjs';

const EXTS = new Set(['.bin', '.md', '.gen', '.smd', '.68k']);

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.has(extname(e).toLowerCase())) yield p;
  }
}

export function classify(r) {
  if (!r.ok) return 'reject';
  if (r.machine.cpu.halted) return 'halted';
  if (r.stats.nonBackdrop === 0) return 'black';
  if (r.stats.colours <= 2) return 'flat';
  if (r.changedFrames === 0) return 'static';
  return 'ok';
}

function main(argv) {
  const args = argv.slice(2);
  const dir = args[0];
  if (!dir) { console.error('usage: node mdtools/sweep.mjs <dir> [--frames N] [--filter s] [--json]'); process.exit(2); }
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const frames = parseInt(opt('--frames', '300'), 10);
  const filter = opt('--filter', null);
  const asJson = args.includes('--json');

  const rows = [];
  const buckets = {};
  for (const p of walk(dir)) {
    if (filter && !p.includes(filter)) continue;
    const rel = relative(dir, p);
    let r, verdict, note = '';
    const t0 = Date.now();
    try {
      r = runRom(readFileSync(p), { frames, name: rel });
      verdict = classify(r);
      if (!r.ok) note = r.error;
    } catch (e) {
      verdict = 'throw';
      note = e.message;
    }
    const ms = Date.now() - t0;
    buckets[verdict] = (buckets[verdict] || 0) + 1;
    const row = {
      rom: rel, verdict, ms,
      colours: r && r.ok ? r.stats.colours : 0,
      fillPct: r && r.ok ? +r.stats.nonBackdropPct.toFixed(1) : 0,
      firstFrame: r && r.ok ? r.firstNonBlank : -1,
      animated: r && r.ok ? r.changedFrames : 0,
      title: r && r.ok ? (r.cart.overseasName || r.cart.domesticName || '').trim() : '',
      note,
    };
    rows.push(row);
    if (!asJson) {
      console.log(`${verdict.padEnd(7)} ${rel.padEnd(44)} colours=${String(row.colours).padStart(4)} fill=${String(row.fillPct).padStart(5)}%  first=${String(row.firstFrame).padStart(4)}  anim=${String(row.animated).padStart(4)}  ${row.note}`);
    }
  }
  if (asJson) console.log(JSON.stringify({ frames, buckets, rows }, null, 2));
  else {
    console.log('---');
    console.log(Object.entries(buckets).map(([k, v]) => `${k}=${v}`).join('  '), ` total=${rows.length}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
