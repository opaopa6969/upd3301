#!/usr/bin/env node
// nestools/sweep — run a whole directory of Famicom Disk System images headless
// and sort what happened into buckets.
//
// This is the move docs/m88-comparison.md used on 353 PC-8801 disks and
// mdtools/sweep.mjs used on 66 Mega Drive ROMs: run everything, classify
// mechanically, then only look at what failed. The difference here is that
// there is NO ORACLE. The PC-8801 sweep could diff against M88; this cannot
// diff against anything, because no reference emulator is installed and none
// of these disks has a known-good screenshot in the repository.
//
// So the sweep is self-consistency only. What makes the verdict better than a
// pixel heuristic is that a Disk System machine has a second, independent thing
// to look at: WHERE THE CPU IS. The FDS BIOS owns the vblank wait, so a running
// game and a dead one both park at $E1C5 between frames — but a running game
// leaves it and executes its own code in adapter RAM, and a dead one never
// does. "Frozen picture AND no code below $E000" is a fact about the machine,
// not a guess about the image.
//
//   reject   the .fds file did not parse, or the machine would not build
//   noload   the head never got past the first blocks: the BIOS never
//            managed to read the game off the disk
//   stuck    the picture stopped AND the CPU stopped running the game's own
//            code — the machine has given up. $90 is the BIOS's error byte.
//   black    it loaded and drew nothing but one backdrop colour
//   flat     two colours: it drew, but nothing recognisable
//   static   a picture that stopped changing and stayed stopped
//   ok       several colours, still moving
//
// "ok" is not "correct" — only a browser and a pair of eyes can say that. It
// means the disk loaded and the game is running. Anything else is worth opening.
//
// Usage:
//   FDS_BIOS=/path/disksys.rom node nestools/sweep.mjs <dir> [--frames N]
//                              [--jobs N] [--filter s] [--press start] [--json]

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDisk, loadBios } from './fdsrun.mjs';

const EXTS = new Set(['.fds']);

function* walk(dir) {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.has(extname(e).toLowerCase())) yield p;
  }
}

// The head has to reach at least the first file's data for anything to have
// been loaded; the disk header plus the file list is under a kilobyte, so a
// head that stopped there never read a game.
const LOADED_POS = 2000;

export function classify(r) {
  if (!r.ok) return 'reject';
  if (r.machine.cpu.jammed) return 'jammed';
  if (r.stuck) return 'stuck';
  if (r.drive.maxPos < LOADED_POS) return 'noload';
  if (r.maxColours <= 1) return 'black';
  if (r.maxColours <= 3) return 'flat';
  if (r.changedFrames === 0) return 'static';
  return 'ok';
}

function runOne(path, rel, bios, frames, press) {
  const t0 = Date.now();
  try {
    const r = runDisk(new Uint8Array(readFileSync(path)), { frames, bios, name: rel, sampleEvery: 4, press });
    const verdict = classify(r);
    return {
      disk: rel, verdict, ms: Date.now() - t0,
      game: r.ok ? r.info.game : '',
      sides: r.ok ? r.info.sides : 0,
      colours: r.ok ? r.maxColours : 0,
      lastColours: r.ok ? r.stats.colours : 0,
      topPct: r.ok ? +r.stats.topPct.toFixed(1) : 0,
      first: r.ok ? r.firstNonBlank : -1,
      animated: r.ok ? r.changedFrames : 0,
      maxPos: r.ok ? r.drive.maxPos : 0,
      flips: r.ok ? r.drive.flips : 0,
      stuck: r.ok ? r.stuck : false,
      biosCode: r.ok ? r.biosCode : 0,
      own: r.ok ? r.ownCode : 0,
      note: r.ok ? (r.image.warnings.slice(0, 1).join('') || '') : r.error,
    };
  } catch (e) {
    return { disk: rel, verdict: 'throw', ms: Date.now() - t0, note: e.message, colours: 0, maxPos: 0 };
  }
}

const HERE = fileURLToPath(import.meta.url);

function report(rows, frames, asJson) {
  const buckets = {};
  for (const r of rows) buckets[r.verdict] = (buckets[r.verdict] || 0) + 1;
  if (asJson) { console.log(JSON.stringify({ frames, buckets, rows }, null, 1)); return; }
  for (const r of rows) {
    console.log(`${r.verdict.padEnd(7)} ${r.disk.slice(0, 46).padEnd(46)} col=${String(r.colours).padStart(3)} top=${String(r.topPct).padStart(5)}% anim=${String(r.animated).padStart(4)} pos=${String(r.maxPos).padStart(6)} flip=${r.flips}${r.stuck ? ' own=' + r.own + ' $90=' + r.biosCode : ''} ${r.note}`);
  }
  console.log('---');
  console.log(Object.entries(buckets).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ') + `  total=${rows.length}`);
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--worker')) return worker();
  const dir = args[0];
  if (!dir) { console.error('usage: FDS_BIOS=... node nestools/sweep.mjs <dir> [--frames N] [--jobs N]'); process.exit(2); }
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const frames = parseInt(opt('--frames', '1200'), 10);
  const jobs = parseInt(opt('--jobs', '1'), 10);
  const filter = opt('--filter', null);
  const asJson = args.includes('--json');
  const biosPath = opt('--bios', process.env.FDS_BIOS);
  // Tapping START is not cheating: a fair number of titles put a "press start"
  // screen between the load and the game, and a sweep with no hands never gets
  // past it. The tap is a short press every 40 frames (see fdsrun), so a menu
  // that debounces sees an edge and a game that ignores it is unharmed.
  const press = opt('--press', null);
  const bios = loadBios(biosPath);

  const files = [...walk(dir)].filter((p) => !filter || p.includes(filter));
  process.stderr.write(`# ${files.length} disks, ${frames} frames each, ${jobs} job(s)\n`);

  if (jobs <= 1) {
    const rows = files.map((p, i) => {
      const row = runOne(p, relative(dir, p), bios, frames, press);
      process.stderr.write(`  ..${i + 1}/${files.length} ${row.verdict}\n`);
      return row;
    });
    report(rows, frames, asJson);
    return;
  }

  // Fan out over processes rather than threads: each run is a whole emulated
  // machine and shares nothing, so the only thing to coordinate is the list.
  const chunks = Array.from({ length: jobs }, () => []);
  files.forEach((f, i) => chunks[i % jobs].push(f));
  const results = await Promise.all(chunks.map((chunk) => new Promise((resolve, reject) => {
    const child = fork(HERE, ['--worker'], { stdio: ['pipe', 'pipe', 'inherit', 'ipc'] });
    const out = [];
    child.on('message', (m) => { if (m.row) { out.push(m.row); process.stderr.write(`  ..${m.row.verdict} ${m.row.disk}\n`); } });
    child.on('error', reject);
    child.on('exit', () => resolve(out));
    child.send({ files: chunk, dir, biosPath, frames, press });
  })));
  const rows = results.flat().sort((a, b) => (a.disk < b.disk ? -1 : 1));
  report(rows, frames, asJson);
}

function worker() {
  process.on('message', ({ files, dir, biosPath, frames, press }) => {
    const bios = loadBios(biosPath);
    for (const p of files) process.send({ row: runOne(p, relative(dir, p), bios, frames, press) });
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
