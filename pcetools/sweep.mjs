#!/usr/bin/env node
// pcetools/sweep — run a whole directory of PC Engine HuCards headless and sort
// what happened into buckets.
//
// The same move docs/m88-comparison.md used on 353 PC-8801 disks and
// nestools/sweep.mjs used on 192 Disk System images: run everything, classify
// mechanically, then only open what failed. And the same handicap as the
// Famicom sweep — THERE IS NO ORACLE. No reference emulator is installed, no
// known-good screenshot of any of these titles is in the repository, and a .pce
// file contains nothing that says what it should look like.
//
// What keeps the verdict better than a pixel heuristic is a second, independent
// signal. nestools had one for free (the FDS BIOS owns the vblank wait, so
// "is the CPU running the game's own code?" is a fact about the machine). A
// HuCard has no BIOS and no address range that means "not the game", so the
// signal here is HOW MUCH CODE RUNS: a live PC Engine game touches hundreds of
// distinct program counters every frame, and a dead one is in a loop of two to
// six. See pcerun.mjs for the probe and docs/pce-design.md §9 for the measured
// threshold.
//
//   reject   the .pce did not parse, or the machine would not build
//   dead     the CPU is going round in a tiny circle AND the picture is frozen
//   black    it ran, and drew nothing but one backdrop colour
//   flat     two or three colours: it drew, but nothing recognisable
//   static   a picture that stopped changing and stayed stopped
//   ok       several colours, still moving
//
// "ok" is not "correct" — only a browser and a pair of eyes can say that. It
// means the machine is running the game and the game is drawing. Anything else
// is worth opening.
//
// Usage:
//   node pcetools/sweep.mjs <dir> [--frames N] [--jobs N] [--filter s]
//                                 [--press run] [--json] [--pad-flip]
//                                 [--bank-rule hudson|mirror|modulo]

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runRom } from './pcerun.mjs';
import { tryParsePce, buildBankMap } from '../pcerom.js';

const EXTS = new Set(['.pce']);

function* walk(dir) {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.has(extname(e).toLowerCase())) yield p;
  }
}

export function classify(r) {
  if (!r.ok) return 'reject';
  if (r.jammed) return 'jammed';
  if (r.dead) return 'dead';
  if (r.maxColours <= 1) return 'black';
  if (r.maxColours <= 3) return 'flat';
  if (r.changedFrames === 0) return 'static';
  return 'ok';
}

function runOne(path, rel, opt) {
  const t0 = Date.now();
  try {
    const bytes = new Uint8Array(readFileSync(path));
    // The bank-rule switch exists because the two odd cartridge sizes (384KB
    // and 768KB) are not documented anywhere this was written from, and the
    // library itself is the only way to find out which rule is right. Sweeping
    // under both and counting is the measurement; see docs/pce-design.md §3.
    let cart = null;
    if (opt.bankRule) {
      const parsed = tryParsePce(bytes);
      if (parsed.ok) {
        cart = parsed.cart;
        cart.banks = buildBankMap(cart.rom.length, cart.mapper, opt.bankRule);
      }
    }
    const r = runRom(bytes, {
      frames: opt.frames, name: rel, sampleEvery: 4, press: opt.press,
      padSelDirections: opt.padSelDirections, cart,
    });
    const verdict = classify(r);
    return {
      rom: rel, verdict, ms: Date.now() - t0,
      size: r.ok ? r.info.size : 0,
      board: r.ok ? r.info.board : '',
      sgx: r.ok ? r.info.superGrafx : false,
      rev: r.ok ? r.info.bitReversed : false,
      hdr: r.ok ? r.info.hadHeader : false,
      colours: r.ok ? r.maxColours : 0,
      lastColours: r.ok ? r.stats.colours : 0,
      topPct: r.ok ? +r.stats.topPct.toFixed(1) : 0,
      first: r.ok ? r.firstNonBlank : -1,
      animated: r.ok ? r.changedFrames : 0,
      vram: r.ok ? r.vramChanges : 0,
      pcs: r.ok ? r.distinctPc : 0,
      ramPc: r.ok ? r.ramPc : 0,
      w: r.ok ? r.video.width : 0,
      h: r.ok ? r.video.height : 0,
      bg: r.ok ? r.video.bg : false,
      spr: r.ok ? r.video.spr : false,
      pc: r.ok ? r.machine.cpu.pc : 0,
      note: r.ok ? (r.info.warnings.slice(0, 1).join('') || '') : r.error,
    };
  } catch (e) {
    return { rom: rel, verdict: 'throw', ms: Date.now() - t0, note: e.message, colours: 0, pcs: 0 };
  }
}

const HERE = fileURLToPath(import.meta.url);

function report(rows, frames, asJson) {
  const buckets = {};
  for (const r of rows) buckets[r.verdict] = (buckets[r.verdict] || 0) + 1;
  if (asJson) { console.log(JSON.stringify({ frames, buckets, rows }, null, 1)); return; }
  for (const r of rows) {
    console.log(`${r.verdict.padEnd(7)} ${r.rom.slice(0, 48).padEnd(48)} col=${String(r.colours).padStart(3)} top=${String(r.topPct).padStart(5)}% anim=${String(r.animated).padStart(4)} vram=${String(r.vram).padStart(4)} pcs=${String(r.pcs).padStart(5)} ${String(r.w)}x${String(r.h)} ${r.bg ? 'B' : '-'}${r.spr ? 'S' : '-'} ${(r.size / 1024) | 0}K${r.rev ? ' rev' : ''}${r.sgx ? ' SGX' : ''} ${r.note}`);
  }
  console.log('---');
  console.log(Object.entries(buckets).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ') + `  total=${rows.length}`);
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--worker')) return worker();
  const dir = args[0];
  if (!dir) { console.error('usage: node pcetools/sweep.mjs <dir> [--frames N] [--jobs N]'); process.exit(2); }
  const get = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const opt = {
    frames: parseInt(get('--frames', '1800'), 10),
    press: get('--press', null),
    padSelDirections: !args.includes('--pad-flip'),
    bankRule: get('--bank-rule', null),
  };
  const jobs = parseInt(get('--jobs', '1'), 10);
  const filter = get('--filter', null);
  const asJson = args.includes('--json');

  const files = [...walk(dir)].filter((p) => !filter || p.includes(filter));
  process.stderr.write(`# ${files.length} HuCards, ${opt.frames} frames each, ${jobs} job(s)\n`);

  if (jobs <= 1) {
    const rows = files.map((p, i) => {
      const row = runOne(p, relative(dir, p), opt);
      process.stderr.write(`  ..${i + 1}/${files.length} ${row.verdict}\n`);
      return row;
    });
    report(rows, opt.frames, asJson);
    return;
  }

  // Fan out over processes, not threads: every run is a whole emulated machine
  // and shares nothing, so the only thing to coordinate is the list.
  const chunks = Array.from({ length: jobs }, () => []);
  files.forEach((f, i) => chunks[i % jobs].push(f));
  let done = 0;
  const results = await Promise.all(chunks.map((chunk) => new Promise((resolve, reject) => {
    const child = fork(HERE, ['--worker'], { stdio: ['pipe', 'pipe', 'inherit', 'ipc'] });
    const out = [];
    child.on('message', (m) => {
      if (!m.row) return;
      out.push(m.row);
      if (++done % 25 === 0) process.stderr.write(`  ..${done}/${files.length}\n`);
    });
    child.on('error', reject);
    child.on('exit', () => resolve(out));
    child.send({ files: chunk, dir, opt });
  })));
  const rows = results.flat().sort((a, b) => (a.rom < b.rom ? -1 : 1));
  report(rows, opt.frames, asJson);
}

function worker() {
  process.on('message', ({ files, dir, opt }) => {
    for (const p of files) process.send({ row: runOne(p, relative(dir, p), opt) });
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
