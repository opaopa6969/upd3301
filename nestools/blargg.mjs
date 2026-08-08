#!/usr/bin/env node
// blargg.mjs — run blargg's NES test ROMs headless and report pass/fail.
//
// The reason these ROMs are usable from a script at all: they do not only
// draw their verdict on screen, they write it into the cartridge's work RAM.
// $6001-$6003 hold the signature $DE $B0 $61 ("this really is a test in
// progress"), $6000 holds the status — $80 running, $81 "reset me", anything
// below $80 is the final result with 0 = passed — and $6004 onwards holds a
// NUL-terminated message. So a headless run is a loop over stepFrame() and a
// peek at PRG-RAM, with no PPU output needed.
//
// Some of the older suites (the 2005 sprite tests) print to the screen first
// and only mirror it to $6000 at the end, so this tool also reads the
// nametable back as text: blargg's font puts each glyph at the tile index of
// its own ASCII code, which makes the nametable a character buffer.
//
// ROMs are NOT in this repository (do not commit test ROMs). Fetch them:
//   curl -L -o /tmp/nes-test-roms.zip \
//     https://github.com/christopherpow/nes-test-roms/archive/refs/heads/master.zip
//   unzip -q /tmp/nes-test-roms.zip -d /tmp
//
// Usage:
//   node nestools/blargg.mjs <rom.nes> [more.nes ...] [--frames N] [--verbose]
//   NES_TEST_ROMS=/tmp/nes-test-roms-master node nestools/blargg.mjs --suite ppu_vbl_nmi

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseINes } from '../ines.js';
import { NesMachine } from '../machinenes.js';
import { tryCreateMapper } from '../nesmapper.js';

const SUITES = {
  ppu_vbl_nmi: 'ppu_vbl_nmi/rom_singles',
  sprite_hit: 'sprite_hit_tests_2005.10.05',
  sprite_overflow: 'sprite_overflow_tests',
  mmc3: 'mmc3_test',
  cpu_interrupts: 'cpu_interrupts_v2/rom_singles',
  instr_test: 'instr_test-v5/rom_singles',
  oam_read: 'oam_read',
  vbl_timing: 'vbl_nmi_timing',
};

export function runTestRom(bytes, { frames = 2400, name = 'rom' } = {}) {
  const cart = parseINes(bytes);
  const support = tryCreateMapper(cart);
  if (!support.ok) return { name, ok: false, status: -1, text: support.error, frames: 0 };
  const m = new NesMachine({ cart });
  let started = false;
  let resetPending = 0;
  for (let f = 0; f < frames; f++) {
    m.stepFrame();
    const r = m.testResult();
    if (!r) {
      // The 2005-era suites only draw their verdict. Poll the screen so they
      // stop as soon as they are done instead of burning the frame budget.
      if (f % 15 === 14) {
        const screen = nametableText(m);
        if (/passed|failed|error/i.test(screen)) {
          return { name, ok: /passed/i.test(screen) && !/failed|error/i.test(screen), status: null, text: screen.trim(), frames: f + 1 };
        }
      }
      continue;
    }
    if (r.status === 0x80) { started = true; continue; }
    if (r.status === 0x81) {
      // "reset me": the ROM wants a real RESET at least 100ms from now.
      if (resetPending === 0) resetPending = f + 12;
      else if (f >= resetPending) { m.reset(); resetPending = 0; }
      started = true;
      continue;
    }
    if (started || r.status < 0x80) {
      return { name, ok: r.status === 0, status: r.status, text: r.text.trim(), frames: f + 1 };
    }
  }
  // No verdict anywhere: report what the ROM drew, so a hang is diagnosable.
  const screen = nametableText(m);
  const hit = /(passed|failed|error)/i.exec(screen);
  return {
    name, ok: /passed/i.test(screen) && !/failed/i.test(screen),
    status: hit ? null : -2,
    text: screen.trim() || '(no output — test never wrote $6000 and drew nothing)',
    frames,
    timeout: true,
  };
}

// blargg's font is laid out so that tile number == ASCII code, which turns the
// nametable into a plain character buffer.
export function nametableText(m) {
  const lines = [];
  for (let row = 0; row < 30; row++) {
    let line = '';
    for (let col = 0; col < 32; col++) {
      const c = m.ppu.ciram[row * 32 + col];
      line += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ' ';
    }
    line = line.trimEnd();
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

function collect(args) {
  const roms = [];
  const root = process.env.NES_TEST_ROMS || '/tmp/nes-test-roms-master';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--suite') {
      const dir = join(root, SUITES[args[++i]] ?? args[i]);
      for (const f of readdirSync(dir).sort()) if (f.endsWith('.nes')) roms.push(join(dir, f));
    } else if (args[i] === '--frames' || args[i] === '--verbose') {
      if (args[i] === '--frames') i++;
    } else if (statSync(args[i]).isDirectory()) {
      for (const f of readdirSync(args[i]).sort()) if (f.endsWith('.nes')) roms.push(join(args[i], f));
    } else roms.push(args[i]);
  }
  return roms;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--frames');
  const frames = fi >= 0 ? Number(args[fi + 1]) : 2400;
  const verbose = args.includes('--verbose');
  const roms = collect(args);
  if (!roms.length) {
    console.error('usage: node nestools/blargg.mjs <rom.nes|dir> [...] [--suite NAME] [--frames N] [--verbose]');
    console.error('suites: ' + Object.keys(SUITES).join(', '));
    process.exit(2);
  }
  let pass = 0;
  for (const path of roms) {
    let r;
    try { r = runTestRom(readFileSync(path), { frames, name: basename(path) }); }
    catch (e) { r = { name: basename(path), ok: false, status: -3, text: e.message, frames: 0 }; }
    if (r.ok) pass++;
    const tag = r.ok ? 'PASS' : 'FAIL';
    const st = r.status === null ? '  ' : String(r.status).padStart(3);
    console.log(`${tag} ${st}  ${r.name}${r.timeout ? ' (timeout)' : ''}`);
    if ((!r.ok || verbose) && r.text) console.log('       ' + r.text.replace(/\n/g, '\n       '));
  }
  console.log(`\n${pass}/${roms.length} passed`);
  process.exit(pass === roms.length ? 0 : 1);
}
