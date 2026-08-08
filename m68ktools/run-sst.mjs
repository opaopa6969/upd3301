// Run the SingleStepTests/m68000 vectors against m68000.js.
//
// This is the 68000 equivalent of what m88ref/ does for the Z80 side of the
// house: a reference implementation (here MAME's microcoded 68000, frozen into
// several million recorded single-instruction transitions) is diffed against
// ours state-by-state, so a disagreement names the exact opcode and the exact
// register instead of "the game hangs".
//
// The vectors are not committed — they are ~200MB. Fetch them first:
//   m68ktools/fetch-tests.sh [dir]        (default ./m68k-tests)
// then point the runner at the directory:
//   node m68ktools/run-sst.mjs --dir ./m68k-tests
//
// Options:
//   --dir <path>    where the .json.bin files live (or $M68K_TESTS)
//   --only <re>     only files whose name matches this regex
//   --limit <n>     stop after n cases per file
//   --cycles        also compare clock periods (off by default: see docs)
//   --strict-aerr   also require the group-0 frame's (unpredictable) PC field
//   --verbose       print the first few failing cases in full
//   --json          emit a machine-readable summary on stdout

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadTestFile } from './sst.mjs';
import { M68000 } from '../m68000.js';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(name);

const dir = arg('--dir', process.env.M68K_TESTS || './m68k-tests');
const only = arg('--only');
const limit = Number(arg('--limit', '0')) || 0;
const checkCycles = flag('--cycles');
const verbose = flag('--verbose');
const strictAerr = flag('--strict-aerr');
// Skip every case whose instruction aborted with an address error. What is left
// is the behaviour real software can actually observe, so this number is the
// one a machine port should care about.
const skipAerr = flag('--no-aerr');
const asJson = flag('--json');

// MAME's 68000 keeps only these SR bits; the rest read back as zero, so the
// comparison masks both sides rather than pretending the chip stores them.
const SR_MASK = 0xa71f;
// The vectors record PC as MAME's m_au ("next prefetch address"), which runs
// four bytes ahead of the instruction actually being executed.
const PC_BIAS = 4;

const MEM = new Uint8Array(0x1000000);
let touched = [];

const bus = {
  read8(a) { return MEM[a & 0xffffff]; },
  write8(a, v) { a &= 0xffffff; MEM[a] = v & 0xff; touched.push(a); },
  read16(a) { a &= 0xffffff; return (MEM[a] << 8) | MEM[a + 1]; },
  write16(a, v) {
    a &= 0xffffff;
    MEM[a] = (v >> 8) & 0xff; MEM[a + 1] = v & 0xff;
    touched.push(a, a + 1);
  },
};

const cpu = new M68000(bus);

function loadState(st) {
  const s = st.sr & SR_MASK;
  const supervisor = (s & 0x2000) !== 0;
  cpu.restore({
    d: [st.d0, st.d1, st.d2, st.d3, st.d4, st.d5, st.d6, st.d7],
    a: [st.a0, st.a1, st.a2, st.a3, st.a4, st.a5, st.a6, supervisor ? st.ssp : st.usp],
    usp: st.usp, ssp: st.ssp,
    pc: (st.pc - PC_BIAS) >>> 0,
    ppc: (st.pc - PC_BIAS) >>> 0,
    sr: s,
    stopped: false, halted: false, irq: 0, irqPrev: 0, traceLatch: 0, cycles: 0,
  });
}

function diffState(test, cycles) {
  const f = test.final;
  const bad = [];
  const names = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
  for (let i = 0; i < 8; i++) if (cpu.d[i] !== f[names[i]]) bad.push([names[i], f[names[i]], cpu.d[i]]);
  for (let i = 0; i < 7; i++) if (cpu.a[i] !== f['a' + i]) bad.push(['a' + i, f['a' + i], cpu.a[i]]);
  if (cpu.usp !== f.usp) bad.push(['usp', f.usp, cpu.usp]);
  if (cpu.ssp !== f.ssp) bad.push(['ssp', f.ssp, cpu.ssp]);
  if (cpu.getSR() !== (f.sr & SR_MASK)) bad.push(['sr', f.sr & SR_MASK, cpu.getSR()]);
  // A stopped CPU issues no further prefetch, so the reference's PC latch stays
  // put and the four-byte queue bias does not apply to it.
  const wantPC = (f.pc - (cpu.stopped ? 0 : PC_BIAS)) >>> 0;
  if (cpu.pc !== wantPC) bad.push(['pc', wantPC, cpu.pc]);
  for (const [addr, val] of f.ram) {
    if (MEM[addr & 0xffffff] !== val) bad.push(['ram@' + (addr >>> 0).toString(16), val, MEM[addr & 0xffffff]]);
  }
  if (checkCycles && cycles !== test.cycles) bad.push(['cycles', test.cycles, cycles]);
  return bad;
}

// The group-0 (bus/address error) stack frame carries a PC field that the
// 68000 User's Manual itself calls unpredictable — "two to six bytes beyond"
// the instruction, depending on how far the prefetch had run when the access
// aborted. Reproducing the reference's exact value means reproducing its
// prefetch microcode, so those cases are counted separately instead of being
// quietly ignored or quietly failed. Everything else in the frame (SSW,
// faulting address, IR, SR, handler PC, stack pointer) is compared strictly.
function isAerrPCOnly(bad, sp) {
  if (bad.length === 0) return false;
  const lo = (sp + 10) & 0xffffff, hi = (sp + 13) & 0xffffff;
  for (const [k] of bad) {
    if (!k.startsWith('ram@')) return false;
    const a = parseInt(k.slice(4), 16);
    if (a < lo || a > hi) return false;
  }
  return true;
}

function runFile(path) {
  const tests = loadTestFile(path);
  const n = limit ? Math.min(limit, tests.length) : tests.length;
  let pass = 0;
  const fails = [];
  let aerrPCOnly = 0;
  let skipped = 0;
  const cycleOnly = { count: 0, delta: new Map() };
  for (let i = 0; i < n; i++) {
    const t = tests[i];
    // Clear only what the previous case dirtied: 16MB memsets dominate otherwise.
    for (const a of touched) MEM[a] = 0;
    touched = [];
    for (const [addr, val] of t.initial.ram) { MEM[addr & 0xffffff] = val; touched.push(addr & 0xffffff); }
    for (const [addr] of t.final.ram) touched.push(addr & 0xffffff);
    loadState(t.initial);
    let cycles = 0;
    try { cycles = cpu.step(); } catch (e) { fails.push({ name: t.name, error: String(e) }); continue; }
    if (skipAerr && cpu.lastFault) { skipped++; continue; }
    const bad = diffState(t, cycles);
    if (bad.length === 0) { pass++; continue; }
    if (isAerrPCOnly(bad, cpu.a[7] >>> 0)) {
      aerrPCOnly++;
      if (!strictAerr) { pass++; continue; }
    }
    if (bad.length === 1 && bad[0][0] === 'cycles') {
      cycleOnly.count++;
      const d = bad[0][2] - bad[0][1];
      cycleOnly.delta.set(d, (cycleOnly.delta.get(d) || 0) + 1);
    }
    if (fails.length < 2000) fails.push({ name: t.name, bad });
  }
  return { total: n - skipped, pass, fails, cycleOnly, aerrPCOnly };
}

function hex(v) { return (v >>> 0).toString(16).padStart(8, '0'); }

let files;
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.json.bin')).sort();
} catch {
  console.error(`m68ktools/run-sst: cannot read ${dir}. Run m68ktools/fetch-tests.sh first.`);
  process.exit(2);
}
if (only) { const re = new RegExp(only, 'i'); files = files.filter((f) => re.test(f)); }
if (files.length === 0) { console.error(`m68ktools/run-sst: no .json.bin files matched in ${dir}`); process.exit(2); }

let totalTests = 0, totalPass = 0, totalAerr = 0;
const report = [];
for (const f of files) {
  const path = join(dir, f);
  if (!statSync(path).isFile()) continue;
  const r = runFile(path);
  totalTests += r.total; totalPass += r.pass;
  const name = f.replace('.json.bin', '');
  report.push({ name, total: r.total, pass: r.pass, fail: r.total - r.pass, cycleOnly: r.cycleOnly.count, aerrPCOnly: r.aerrPCOnly });
  totalAerr += r.aerrPCOnly;
  if (!asJson) {
    const ok = r.pass === r.total;
    const cyc = (r.cycleOnly.count ? ` (${r.cycleOnly.count} cycle-only)` : '')
      + (r.aerrPCOnly ? ` (${r.aerrPCOnly} aerr-frame-PC)` : '');
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${r.pass}/${r.total}${cyc}`);
    if (!ok && verbose) {
      for (const bad of r.fails.slice(0, 5)) {
        if (bad.error) { console.log(`   ${bad.name}: threw ${bad.error}`); continue; }
        console.log(`   ${bad.name}`);
        for (const [k, want, got] of bad.bad) {
          console.log(`      ${k}: want ${typeof want === 'number' ? hex(want) : want} got ${typeof got === 'number' ? hex(got) : got}`);
        }
      }
      if (r.cycleOnly.count) {
        const deltas = [...r.cycleOnly.delta.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
        console.log(`   cycle deltas: ${deltas.map(([d, c]) => `${d > 0 ? '+' : ''}${d}x${c}`).join(' ')}`);
      }
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ dir, totalTests, totalPass, totalAerr, files: report }, null, 2));
} else {
  console.log(`\n${totalPass}/${totalTests} cases pass (${((totalPass / totalTests) * 100).toFixed(3)}%)`
    + (totalAerr ? `, of which ${totalAerr} matched only after relaxing the group-0 frame PC` : ''));
}
process.exit(totalPass === totalTests ? 0 : 1);
