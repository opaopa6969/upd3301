#!/usr/bin/env node
// nestest — verify m6502.js against the reference log, one instruction at a
// time. Same method as docs/m88-comparison.ja.md uses against M88: run a
// reference implementation and ours over the same program and diff the
// traces, so a divergence is reported at the exact instruction that caused
// it instead of as "the game looks wrong".
//
// nestest.nes is the 6502 world's acceptance test. Entered at $C000 it runs
// without a PPU, exercises every documented opcode and every documented
// illegal one, and someone long ago published a cycle-exact log of a real
// console running it. Matching PC/A/X/Y/P/SP/CYC line by line pins down not
// just the arithmetic but the *timing*, including page-cross penalties and
// the dummy reads.
//
// The ROM and the log are NOT in this repository (see docs/nes-design.md for
// where to get them). Point at them with env vars or arguments:
//
//   NESTEST_ROM=/path/nestest.nes NESTEST_LOG=/path/nestest.log \
//     node nestools/nestest.mjs
//   node nestools/nestest.mjs /path/nestest.nes /path/nestest.log
//
// Options: --limit N (stop after N log lines), --quiet, --context N.

import { readFile } from 'node:fs/promises';
import { parseINes } from '../ines.js';
import { M6502 } from '../m6502.js';

// A nestest-sized machine: work RAM, cartridge RAM, PRG, and stubs where
// the PPU and APU would be. nestest in automation mode never depends on a
// register read, which is exactly why it is the CPU test.
export function makeNestestBus(cart) {
  const ram = new Uint8Array(0x800);
  const prgRam = new Uint8Array(0x2000);
  const prg = cart.prg;
  const mask = prg.length - 1; // NROM: 16KB mirrors into $C000, 32KB does not
  const io = new Uint8Array(0x20);
  const bus = {
    ram, prgRam, io,
    read(addr) {
      if (addr < 0x2000) return ram[addr & 0x7ff];
      if (addr < 0x4000) return 0; // PPU registers: open bus for this harness
      if (addr < 0x4020) return io[addr & 0x1f];
      if (addr < 0x6000) return 0;
      if (addr < 0x8000) return prgRam[addr & 0x1fff];
      return prg[(addr - 0x8000) & mask];
    },
    write(addr, v) {
      if (addr < 0x2000) { ram[addr & 0x7ff] = v; return; }
      if (addr < 0x4000) return;
      if (addr < 0x4020) { io[addr & 0x1f] = v; return; }
      if (addr >= 0x6000 && addr < 0x8000) { prgRam[addr & 0x1fff] = v; }
      // writes to PRG-ROM go nowhere on NROM
    },
  };
  return bus;
}

const LINE = /^([0-9A-F]{4}).*?A:([0-9A-F]{2}) X:([0-9A-F]{2}) Y:([0-9A-F]{2}) P:([0-9A-F]{2}) SP:([0-9A-F]{2}).*?CYC:(\d+)/;

export function parseNestestLog(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    out.push({
      raw,
      pc: parseInt(m[1], 16), a: parseInt(m[2], 16), x: parseInt(m[3], 16),
      y: parseInt(m[4], 16), p: parseInt(m[5], 16), s: parseInt(m[6], 16),
      cyc: parseInt(m[7], 10),
    });
  }
  return out;
}

const hex = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

// Run the ROM against the log. Returns a plain report — the caller decides
// whether to print it (CLI) or assert on it (node --test).
export function runNestest(romBytes, logText, { limit = Infinity, context = 3 } = {}) {
  const cart = parseINes(romBytes);
  const bus = makeNestestBus(cart);
  const cpu = new M6502(bus);
  const lines = parseNestestLog(logText);
  if (!lines.length) return { ok: false, checked: 0, total: 0, error: 'log has no parsable lines' };

  // The log's first line is the documented automation entry state: PC=$C000,
  // P=$24 (I and the unused bit), SP=$FD, and 7 cycles already spent on the
  // power-up sequence.
  cpu.pc = lines[0].pc;
  cpu.a = lines[0].a; cpu.x = lines[0].x; cpu.y = lines[0].y;
  cpu.p = lines[0].p; cpu.s = lines[0].s; cpu.cycles = lines[0].cyc;

  const n = Math.min(lines.length, limit);
  for (let i = 0; i < n; i++) {
    const e = lines[i];
    const got = { pc: cpu.pc, a: cpu.a, x: cpu.x, y: cpu.y, p: cpu.p, s: cpu.s, cyc: cpu.cycles };
    for (const k of ['pc', 'a', 'x', 'y', 'p', 's', 'cyc']) {
      if (got[k] !== e[k]) {
        return {
          ok: false, checked: i, total: n, line: i + 1, field: k,
          expected: e, got,
          error: `line ${i + 1}: ${k} expected ${k === 'cyc' ? e[k] : '$' + hex(e[k], k === 'pc' ? 4 : 2)}`
            + ` got ${k === 'cyc' ? got[k] : '$' + hex(got[k], k === 'pc' ? 4 : 2)}`,
          before: lines.slice(Math.max(0, i - context), i + 1).map((l) => l.raw),
        };
      }
    }
    cpu.step();
    if (cpu.jammed) {
      return { ok: false, checked: i + 1, total: n, line: i + 1, error: `CPU jammed at line ${i + 1} (illegal KIL opcode)` };
    }
  }

  // nestest reports its own verdict in $02/$03: 00 00 means every subtest
  // passed. That is an independent check from the log diff — the log can
  // run out before the ROM finishes.
  const status = [bus.ram[0x02], bus.ram[0x03]];
  return {
    ok: true, checked: n, total: lines.length,
    status, statusOk: status[0] === 0 && status[1] === 0,
    cycles: cpu.cycles,
  };
}

async function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const romPath = args[0] ?? process.env.NESTEST_ROM;
  const logPath = args[1] ?? process.env.NESTEST_LOG;
  if (!romPath || !logPath) {
    console.error('usage: NESTEST_ROM=... NESTEST_LOG=... node nestools/nestest.mjs');
    console.error('   or: node nestools/nestest.mjs <nestest.nes> <nestest.log> [--limit=N] [--quiet]');
    console.error('\nThe ROM and log are not in this repo; see docs/nes-design.md for where to get them.');
    process.exit(2);
  }
  const rom = new Uint8Array(await readFile(romPath));
  const log = await readFile(logPath, 'utf8');
  const r = runNestest(rom, log, { limit: limitArg ? Number(limitArg.split('=')[1]) : Infinity });

  if (!r.ok) {
    console.error(`FAIL after ${r.checked} instructions: ${r.error}`);
    if (r.before) {
      console.error('\nlast good lines (reference):');
      for (const l of r.before) console.error('  ' + l);
    }
    if (r.got) {
      console.error(`\nours: PC:${hex(r.got.pc, 4)} A:${hex(r.got.a)} X:${hex(r.got.x)} Y:${hex(r.got.y)}`
        + ` P:${hex(r.got.p)} SP:${hex(r.got.s)} CYC:${r.got.cyc}`);
    }
    process.exit(1);
  }
  if (!flags.has('--quiet')) {
    console.log(`OK: ${r.checked}/${r.total} log lines matched (PC/A/X/Y/P/SP/CYC), ${r.cycles} CPU cycles`);
    console.log(`nestest status bytes $02/$03: ${hex(r.status[0])} ${hex(r.status[1])}`
      + (r.statusOk ? ' (all subtests passed)' : ' (see nestest.txt for the failure code)'));
  }
  process.exit(r.statusOk ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
