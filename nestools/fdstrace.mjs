#!/usr/bin/env node
// nestools/fdstrace — watch what a Disk System game does to the drive.
//
// Every bug found in stage 4 was found with this. A disk that does not load
// says nothing useful on screen, but the register traffic says everything:
// which block the head was on when the BIOS gave up, whether it was reading or
// writing, and — the one that mattered most — whether the bytes a game wrote
// landed on the bytes they were supposed to replace.
//
//   FDS_BIOS=... node nestools/fdstrace.mjs <disk.fds> [--frames N] [--mode M]
//
// Modes:
//   ctl     (default) $4025/$4023 only — the shape of the transfer, one line
//           per block. This is the view that shows a load walking the disk.
//   data    every $4031 read and $4024 write, with the head position.
//   writes  only what reached the media, each line comparing the byte written
//           against the byte that was already there. A save should differ only
//           where the save data differs; a line where the BLOCK ID differs
//           means the head is misaligned and the BIOS's verify will loop.
//   pc      after the run, where the CPU actually is: a histogram over 200k
//           instructions. "$e1c5 199055" means the machine is parked in the
//           BIOS's vblank wait and nothing else is running.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { tryParseFds, makeFdsCart } from '../fds.js';
import { NesMachine } from '../machinenes.js';
import { loadBios } from './fdsrun.mjs';

function main(argv) {
  const args = argv.slice(2);
  const file = args[0];
  if (!file) { console.error('usage: FDS_BIOS=... node nestools/fdstrace.mjs <disk.fds> [--frames N] [--mode ctl|data|writes|pc]'); process.exit(2); }
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const frames = parseInt(opt('--frames', '2400'), 10);
  const mode = opt('--mode', 'ctl');
  const limit = parseInt(opt('--limit', '400'), 10);
  const bios = loadBios(opt('--bios', process.env.FDS_BIOS));

  const parsed = tryParseFds(new Uint8Array(readFileSync(file)));
  if (!parsed.ok) { console.error(`${basename(file)}: ${parsed.error}`); process.exit(1); }
  const m = new NesMachine({ cart: makeFdsCart(parsed.image, bios) });
  const mp = m.mapper, d = m.disk;
  let n = 0;
  const say = (s) => { if (n++ < limit) console.log(s); };
  const hex = (v, w = 2) => `$${(v & 0xff).toString(16).padStart(w, '0')}`;

  if (mode === 'ctl' || mode === 'data') {
    const wr = mp._regWrite.bind(mp), rd = mp._regRead.bind(mp);
    const wantW = (a) => mode === 'data' ? true : (a === 0x4025 || a === 0x4023);
    const wantR = (a) => mode === 'data' && a === 0x4031;
    mp._regWrite = (a, v) => { if (wantW(a)) say(`f${m.frame} W $${a.toString(16)}=${hex(v)} pc=$${m.cpu.pc.toString(16)} pos=${d.pos}`); return wr(a, v); };
    mp._regRead = (a) => { const r = rd(a); if (wantR(a)) say(`f${m.frame} R $${a.toString(16)}=${hex(r)} pc=$${m.cpu.pc.toString(16)} pos=${d.pos}`); return r; };
  }
  if (mode === 'writes') {
    const orig = d.writeData.bind(d);
    d.writeData = (v) => {
      const before = d.pos, skip = d.writeSkip, ready = d.byteReady;
      orig(v);
      if (!ready) return;
      const was = parsed.image.physical[d.side][before];
      say(`f${m.frame} pos=${before}${skip ? ' MARK' : ''} wrote=${hex(v)} was=${hex(was)}${!skip && v !== was ? '  <- differs' : ''} -> ${d.pos}`);
    };
  }

  for (let i = 0; i < frames; i++) m.stepFrame();

  if (mode === 'pc') {
    const hist = new Map();
    for (let i = 0; i < 200000 && !m.cpu.jammed; i++) {
      hist.set(m.cpu.pc, (hist.get(m.cpu.pc) || 0) + 1);
      m.cpu.step();
    }
    for (const [pc, c] of [...hist].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`  $${pc.toString(16)}  ${c}${pc >= 0xe000 ? '  (BIOS)' : ''}`);
    }
  }
  console.log(`# ${basename(file)} after ${m.frame} frames: pos=${d.pos} side=${d.side} motor=${d.motorOn} reset=${d.resetTransfer} rwStart=${d.rwStart} read=${d.readMode} writes=${d.writes.size} pc=$${m.cpu.pc.toString(16)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
