#!/usr/bin/env node
// pc98tools/run-sst — run i8086.js against the SingleStepTests/8086 vectors.
//
// Same shape as m68ktools/run-sst.mjs: one test is "initial state -> one
// instruction -> expected final state", and the only honest way to say an
// instruction is right is to run every published case and count.
//
//   pc98tools/fetch-tests.sh                       # ~130 MB into ./i8086-tests
//   node pc98tools/run-sst.mjs --dir ./i8086-tests
//   node pc98tools/run-sst.mjs --dir ./i8086-tests --op D0 --verbose
//
// Options:
//   --dir D        where the .json.gz files are
//   --op HH[,HH]   only these opcodes
//   --limit N      only the first N tests per opcode
//   --verbose      print the first few mismatches per opcode with a diff
//   --nomem        compare registers only (memory writes are compared by default)
//   --undef        treat the flags the 8086 manual calls undefined as
//                  don't-care for the instructions where it says so
//
// The bus is a flat 1 MB array: the tests assume all of it is RAM and that the
// address space wraps at 0xFFFFF, which is exactly what i8086.js does.

import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { I8086, SREG, REG } from '../i8086.js';

function args(argv) {
  const o = { dir: './i8086-tests' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[k] = true;
    else { o[k] = next; i++; }
  }
  return o;
}

const RNAMES = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const SNAMES = ['es', 'cs', 'ss', 'ds'];

// The manual's "undefined" list, per instruction family. Only consulted with
// --undef; the default run compares every flag bit, because the whole point of
// a hardware-captured suite is that "undefined" still has an answer.
const UNDEF = {
  logic: 0x0010,                  // AF after AND/OR/XOR/TEST
  mul: 0x00d4,                    // SF ZF PF AF after MUL/IMUL
  div: 0x08d5,                    // everything after DIV/IDIV
  shift: 0x0010,                  // AF after a shift
  daa: 0x0800,                    // OF after DAA/DAS
  aaa: 0x08c4,                    // OF SF ZF PF after AAA/AAS
  aam: 0x0810,
  rot: 0x0000,
};

function undefMaskFor(opcode, modrm) {
  const o = opcode;
  if (o === 0xf6 || o === 0xf7) {
    const rf = (modrm >> 3) & 7;
    if (rf <= 1) return UNDEF.logic;
    if (rf === 4 || rf === 5) return UNDEF.mul;
    if (rf >= 6) return UNDEF.div;
    return 0;
  }
  if (o >= 0xd0 && o <= 0xd3) return UNDEF.shift;
  if (o === 0x27 || o === 0x2f) return UNDEF.daa;
  if (o === 0x37 || o === 0x3f) return UNDEF.aaa;
  if (o === 0xd4 || o === 0xd5) return UNDEF.aam;
  // The logical block: 08-0D, 20-25, 30-35, 84/85, A8/A9
  if ((o >= 0x08 && o <= 0x0d) || (o >= 0x20 && o <= 0x25) || (o >= 0x30 && o <= 0x35)
    || o === 0x84 || o === 0x85 || o === 0xa8 || o === 0xa9) return UNDEF.logic;
  if (o === 0x80 || o === 0x81 || o === 0x82 || o === 0x83) {
    const rf = (modrm >> 3) & 7;
    if (rf === 1 || rf === 4 || rf === 6) return UNDEF.logic;
  }
  return 0;
}

export function runOpcodeFile(path, opts = {}) {
  const raw = gunzipSync(readFileSync(path));
  const tests = JSON.parse(raw.toString('utf8'));
  const mem = new Uint8Array(0x100000);
  const bus = {
    read8: (a) => mem[a],
    write8: (a, v) => { mem[a] = v; },
    inb: () => 0xff,
    outb: () => {},
    intAck: () => 0xff,
  };
  const cpu = new I8086(bus);
  const limit = opts.limit ? Math.min(opts.limit, tests.length) : tests.length;
  let pass = 0;
  const fails = [];

  for (let t = 0; t < limit; t++) {
    const tc = tests[t];
    // Only the bytes the test names are defined; the rest of the megabyte is
    // whatever the previous test left, which is fine because every test writes
    // the addresses it cares about. Zeroing 1 MB per test would dominate.
    for (const [a, v] of tc.initial.ram) mem[a & 0xfffff] = v;

    const ir = tc.initial.regs;
    cpu.reset();
    for (let i = 0; i < 8; i++) cpu.r[i] = ir[RNAMES[i]] & 0xffff;
    for (let i = 0; i < 4; i++) cpu.s[i] = ir[SNAMES[i]] & 0xffff;
    cpu.ip = ir.ip & 0xffff;
    cpu.setFlags(ir.flags);

    try { cpu.step(); } catch (e) {
      fails.push({ idx: t, name: tc.name, why: 'threw: ' + e.message });
      continue;
    }

    const want = { ...ir, ...tc.final.regs };
    let ok = true;
    const diff = [];
    for (let i = 0; i < 8; i++) {
      if (cpu.r[i] !== (want[RNAMES[i]] & 0xffff)) {
        ok = false; diff.push(`${RNAMES[i]} got ${hex(cpu.r[i])} want ${hex(want[RNAMES[i]])}`);
      }
    }
    for (let i = 0; i < 4; i++) {
      if (cpu.s[i] !== (want[SNAMES[i]] & 0xffff)) {
        ok = false; diff.push(`${SNAMES[i]} got ${hex(cpu.s[i])} want ${hex(want[SNAMES[i]])}`);
      }
    }
    if (cpu.ip !== (want.ip & 0xffff)) { ok = false; diff.push(`ip got ${hex(cpu.ip)} want ${hex(want.ip)}`); }

    // The test's byte string may start with a segment override or a REP, so
    // find the opcode before asking what its undefined flags are.
    let bi = 0;
    while (bi < tc.bytes.length
      && [0x26, 0x2e, 0x36, 0x3e, 0xf0, 0xf1, 0xf2, 0xf3].includes(tc.bytes[bi])) bi++;
    const undefMask = opts.undef ? undefMaskFor(tc.bytes[bi], tc.bytes[bi + 1] ?? 0) : 0;
    const mask = 0xffff & ~undefMask;
    const gf = cpu.getFlags(), wf = want.flags & 0xffff;
    if (((gf ^ wf) & mask) !== 0) {
      ok = false;
      diff.push(`flags got ${hex(gf)} want ${hex(wf)} (differ: ${flagNames(gf ^ wf)})`);
    }

    if (!opts.nomem) {
      // A divide error pushes the flags, undefined bits and all. Under --undef
      // those two stack bytes are exempt for the same reason the flag word is.
      let skipLo = -1, skipHi = -1;
      if (undefMask && cpu.s[SREG.CS] !== (ir.cs & 0xffff)) {
        const sp = ((cpu.s[SREG.SS] << 4) + ((cpu.r[REG.SP] + 4) & 0xffff)) & 0xfffff;
        skipLo = sp; skipHi = (sp + 1) & 0xfffff;
      }
      for (const [a, v] of tc.final.ram) {
        const pa = a & 0xfffff;
        if (pa === skipLo || pa === skipHi) continue;
        if (mem[pa] !== v) {
          ok = false; diff.push(`mem[${a.toString(16)}] got ${mem[pa]} want ${v}`);
          break;
        }
      }
    }

    if (ok) pass++;
    else fails.push({ idx: t, name: tc.name, bytes: tc.bytes, diff });
  }
  return { total: limit, pass, fails };
}

const hex = (v) => '0x' + ((v ?? 0) & 0xffff).toString(16).padStart(4, '0');
function flagNames(m) {
  const N = [[0x0001, 'CF'], [0x0004, 'PF'], [0x0010, 'AF'], [0x0040, 'ZF'], [0x0080, 'SF'],
    [0x0100, 'TF'], [0x0200, 'IF'], [0x0400, 'DF'], [0x0800, 'OF']];
  return N.filter(([b]) => m & b).map(([, n]) => n).join(',') || 'reserved';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = args(process.argv);
  let files;
  try { files = readdirSync(o.dir).filter((f) => f.endsWith('.json.gz')).sort(); }
  catch { console.error(`no such directory ${o.dir}; run pc98tools/fetch-tests.sh first`); process.exit(2); }
  if (o.op) {
    const want = new Set(String(o.op).toUpperCase().split(',').map((s) => s.trim()));
    files = files.filter((f) => want.has(f.replace(/\.json\.gz$/, '').toUpperCase()));
  }
  if (!files.length) { console.error('no test files matched'); process.exit(2); }

  const opts = { limit: o.limit ? parseInt(o.limit, 10) : 0, nomem: !!o.nomem, undef: !!o.undef };
  let total = 0, pass = 0;
  const worst = [];
  for (const f of files) {
    const res = runOpcodeFile(join(o.dir, f), opts);
    total += res.total; pass += res.pass;
    const rate = res.total ? (100 * res.pass / res.total) : 100;
    if (res.pass !== res.total) {
      worst.push({ f, ...res, rate });
      if (o.verbose) {
        console.log(`\n${f}: ${res.pass}/${res.total} (${rate.toFixed(2)}%)`);
        for (const fail of res.fails.slice(0, 5)) {
          console.log(`  #${fail.idx} ${fail.name} [${(fail.bytes || []).map((b) => b.toString(16)).join(' ')}]`);
          for (const d of fail.diff || [fail.why]) console.log(`      ${d}`);
        }
      }
    }
  }
  worst.sort((a, b) => a.rate - b.rate);
  if (!o.verbose) {
    for (const w of worst.slice(0, 40)) {
      console.log(`${w.f}: ${w.pass}/${w.total} (${w.rate.toFixed(2)}%)  e.g. ${(w.fails[0].diff || [w.fails[0].why]).slice(0, 2).join(' | ')}`);
    }
  }
  console.log(`\n${pass} / ${total} = ${(100 * pass / total).toFixed(3)} %  (${files.length} opcode files, ${worst.length} imperfect)`);
}
