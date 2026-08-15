// rng — the random-number-generator finder, headless.
//
// Built for RNG *manipulation*, not for academic identification: the questions
// it answers are "which byte decides this", "what will the next draws be", and
// "what do I write to get the draw I want". The measurement underneath is
// ../icecore.js (the ICE, pure and machine-independent) and ../rngfind.js (the
// estimator, pure and import-free); this file is argument parsing, machine
// construction and printing, exactly like tools/ice.mjs.
//
//   scan     find candidate generators and classify them
//   verify   patch a byte, replay, and see whether the program noticed
//   callers  who draws from this generator, and what did they get
//   predict  the next N draws from a model
//   adjust   what to write NOW so that draw #N is the value you want
//   export   write the findings as an analysisdb document (issue #39)
//
// The workflow this is meant for:
//
//   1. node tools/rng.mjs scan   --disk game.d88 --settle 900 --frames 400
//   2. node tools/rng.mjs verify --disk game.d88 --addr E123 --value 99
//      → "confirmed" means the byte is really upstream. "REFUTED" means the
//        scan was wrong and you should look at the next candidate. A tool that
//        cannot tell you it was wrong is not worth running.
//   3. node tools/rng.mjs callers --disk game.d88 --site 8C10 --notes notes.json
//      → annotate what each call site is FOR. Nothing can do that for you.
//   4. node tools/rng.mjs adjust --model lcg:5,1 --want 07 --in 3
//
// Machine selection is the same as tools/ice.mjs:
//   --machine pc8801|pc8001|nes|md   --disk <d88>   --rom <file>   --romdir <dir>
//   --cpu main|sub

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { IceCore } from '../icecore.js';
import {
  observe, screen, sample, identifyState, identifyTable, findPointer,
  verifyByPatch, describe, resolveSite, searchInputs,
  predict, statesFor, CallerMap,
} from '../rngfind.js';

const H = (v, w = 4) => (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

// ---- argv --------------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
const FLAGS = new Set(['json', 'help', 'all', 'quiet', 'walkers', 'states']);
const opt = (name, dflt = null) => { const i = argv.indexOf('--' + name); return i < 0 ? dflt : argv[i + 1]; };
const flag = (name) => argv.includes('--' + name);
const num = (name, dflt) => { const v = opt(name); return v == null ? dflt : Number(v); };
const hexOpt = (name, dflt = -1) => { const v = opt(name); return v == null ? dflt : parseInt(v, 16); };
function pos(n) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { if (!FLAGS.has(a.slice(2))) i++; continue; }
    out.push(a);
  }
  return out[n];
}
function die(msg) { console.error('rng: ' + msg); process.exit(2); }

const DEFAULT_ROMDIR = '/mnt/c/var/emulator/エミュレーター本体/PC88/m88204';

// ---- scripted input ----------------------------------------------------------
// Most titles sit on a title screen until somebody presses something, and a
// title screen draws no random numbers. The first real-disk scans in this repo
// found 18 read sites in 600 frames — the whole machine was in a wait loop, and
// the "generators" it reported were the loop's own flags.
//
// So there is a scripted-input mode. It has to be a pure function of the frame
// number, because rngfind re-runs the machine from reset to sample and again to
// verify, and an input that differed between runs would turn "replay" into a
// different experiment while still looking like one.
//
// Matrix rows are the PC-8801 layout established in demo/machine.html (row 9 is
// SPACE ESC TAB ↓ BS INS CR ←, which is NOT the PC-8001's row 9 — that mistake
// left the decision key dead in the browser for a while).
const KEY88 = {
  space: [[9, 0]], esc: [[9, 1]], down: [[9, 3]], up: [[8, 1]],
  left: [[9, 7]], right: [[8, 2]],
  // Enter presses both the main CR and the tenkey RETURN: in-game menus read
  // one, disk-swap prompts read the other.
  enter: [[9, 6], [1, 7]], ret: [[9, 6], [1, 7]],
  z: [[5, 2]], x: [[5, 0]], y: [[5, 1]], n: [[3, 6]], f1: [[10, 0]],
  num5: [[0, 5]], num2: [[0, 2]], num8: [[1, 0]],
};

/**
 * Wrap stepFrame so that a fixed key script is applied by frame number. Done on
 * the machine *before* the ICE attaches, so the ICE's own stepFrame wrapper sits
 * outside it and every path (runFrames, replay) gets the same input.
 */
function withKeyScript(machine, spec) {
  if (!spec) return machine;
  const names = spec.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const cells = names.map((n) => KEY88[n] ?? die(`unknown key "${n}" (have: ${Object.keys(KEY88).join(' ')})`));
  const every = num('every', 90);
  const hold = num('hold', 6);
  const until = num('until', 1e9);
  const orig = machine.stepFrame.bind(machine);
  machine.stepFrame = function (...a) {
    const f = machine.frame;
    if (f < until) {
      const phase = f % every;
      const which = cells[Math.floor(f / every) % cells.length];
      if (phase === 0) for (const [r, b] of which) machine.keyDown(r, b);
      else if (phase === hold) for (const [r, b] of which) machine.keyUp(r, b);
    }
    return orig(...a);
  };
  return machine;
}

// ---- machines ----------------------------------------------------------------
// Kept as a factory rather than a built machine: rngfind re-runs from reset to
// sample and again to verify, and determinism is the only reason that is legal.
// Anything that made open() return the *same* machine twice would silently turn
// "replay" into "continue", which is a different experiment.

const MACHINES = {
  pc8801: {
    async open() {
      const { Pc8801Machine } = await import('../machine88.js');
      const { mountD88 } = await import('./mount.mjs');
      const { loadRomSet } = await import('./romset.mjs');
      const { main, ext, sub, n80 } = loadRomSet(opt('romdir', DEFAULT_ROMDIR));
      const diskPath = opt('disk') ?? pos(0);
      const diskBytes = diskPath ? new Uint8Array(readFileSync(resolve(diskPath))) : null;
      return () => {
        const m = new Pc8801Machine({ main, ext, sub, n80, mode: opt('mode', 'n88') });
        if (diskBytes) mountD88(m, diskBytes); // same machine as the sweep — tools/mount.mjs
        return withKeyScript(m, opt('keys'));
      };
    },
    async romHash() {
      const { hashBytes } = await import('../analysisdb.js');
      const { loadRomSet } = await import('./romset.mjs');
      const { main, ext, sub, n80 } = loadRomSet(opt('romdir', DEFAULT_ROMDIR));
      const out = { main: hashBytes(main), ext: hashBytes(ext), sub: hashBytes(sub) };
      const d = opt('disk') ?? pos(0);
      if (d) out.disk = hashBytes(new Uint8Array(readFileSync(resolve(d))));
      return out;
    },
  },
  pc8001: {
    async open() {
      const { Pc8001Machine } = await import('../machine.js');
      const rom = new Uint8Array(readFileSync(resolve(opt('rom') ?? pos(0) ?? 'roms/N80_2.ROM')));
      return () => new Pc8001Machine({ rom });
    },
    async romHash() {
      const { hashBytes } = await import('../analysisdb.js');
      return { main: hashBytes(new Uint8Array(readFileSync(resolve(opt('rom') ?? pos(0) ?? 'roms/N80_2.ROM')))) };
    },
  },
  nes: {
    async open() {
      const { NesMachine } = await import('../machinenes.js');
      const rom = new Uint8Array(readFileSync(resolve(opt('rom') ?? pos(0))));
      return () => new NesMachine({ rom });
    },
    async romHash() {
      const { hashBytes } = await import('../analysisdb.js');
      return { '*': hashBytes(new Uint8Array(readFileSync(resolve(opt('rom') ?? pos(0))))) };
    },
  },
  md: {
    async open() {
      const { MegaDriveMachine } = await import('../machinemd.js');
      const rom = new Uint8Array(readFileSync(resolve(opt('rom') ?? pos(0))));
      return () => new MegaDriveMachine({ rom });
    },
    async romHash() {
      const { hashBytes } = await import('../analysisdb.js');
      return { '*': hashBytes(new Uint8Array(readFileSync(resolve(opt('rom') ?? pos(0))))) };
    },
  },
};

async function opener() {
  const kind = opt('machine', 'pc8801');
  const profile = MACHINES[kind];
  if (!profile) die(`unknown --machine ${kind} (have: ${Object.keys(MACHINES).join(', ')})`);
  let build;
  try { build = await profile.open(); }
  catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') die(`--machine ${kind}: its machine module is not on this branch yet.`);
    throw e;
  }
  const cpu = opt('cpu', 'main');
  const open = () => {
    const machine = build();
    const ice = new IceCore();
    ice.attach(machine);
    const c = ice.cpu(cpu);
    if (!c) die(`no CPU named "${cpu}" (have: ${ice.cpus.map((x) => x.name).join(', ') || 'none'})`);
    c.traceOn = false; // the register ring is dead weight for a census
    return { machine, ice, cpu };
  };
  return { open, cpu, kind, profile };
}

// ---- scan --------------------------------------------------------------------

async function cmdScan() {
  const { open, cpu, kind } = await opener();
  const frames = num('frames', 300);
  const settle = num('settle', 600);
  const o = {
    cpu, frames, settle,
    minReads: num('minreads', 8),
    minWrites: num('minwrites', 4),
    maxWriters: num('maxwriters', 6),
    minDistinct: num('mindistinct', 12),
    maxTableSpan: num('maxspan', 8192),
    top: num('top', 8),
  };

  const t0 = Date.now();
  const p1 = open();
  const census = observe(p1.ice, o);
  p1.ice.detach();
  const cands = screen(census, o);

  console.log(`=== census: ${kind} cpu=${cpu} settle=${settle}f window=${census.frames}f ===`);
  console.log(`bus accesses ${census.total}  (instruction fetches ${census.fetches} dropped, `
    + `stack ${census.stackHits} dropped)  read sites ${census.sites.size}  write sites ${census.stores.size}`
    + `${census.sitesDropped ? `  [${census.sitesDropped} sites over the cap — raise --sitesmax]` : ''}`);
  if (!census.total) {
    console.log('nothing on the bus at all — is the machine running? try a larger --settle');
    return;
  }

  // Pass 2 on the survivors. A fresh machine, from reset: same input, same run.
  const addrs = cands.state.map((s) => [s.lo, s.hi]);
  const pcs = cands.walker.map((w) => w.pc);
  let hits = [];
  // The pass-2 machine stays ATTACHED after the run, because it is also the only
  // machine in the right *state* to disassemble against. A freshly built one is
  // at frame 0 with the boot banks selected, and on the PC-8801 every read site
  // in RAM then decodes as `RST 38h` (FFh through the ROM window) — which is
  // what the first version printed for all 602 sites of a real title.
  const p2 = open();
  const s = sample(p2.ice, {
    cpu, frames, settle, addrs, pcs,
    keep: num('keep', 60000), keepPer: num('keepper', 4000),
  });
  hits = s.hits;
  if (s.dropped) console.log(`(per-candidate sample budget reached: ${s.dropped} further hits not kept)`);

  const c = p2.ice.cpu(cpu);
  const site = (pcAfter) => {
    const r = resolveSite(c.read, c.arch.disasm, pcAfter, { mask: c.arch.addrMask });
    return r.resolved ? `${H(r.addr)} ${r.text}${r.ambiguous ? ' (?)' : ''}` : `${H(pcAfter)} (pc after operands)`;
  };

  console.log(`\n=== state candidates (LCG / LFSR / counter) — ${cands.state.length} ===`);
  const states = [];
  for (const cand of cands.state) {
    const id = identifyState(cand, hits);
    states.push(id);
    console.log(`  ${H(cand.lo)}${cand.bytes > 1 ? `-${H(cand.hi)}` : '     '}  r=${String(cand.reads).padStart(6)} w=${String(cand.writes).padStart(6)}`
      + `  callers=${cand.callers.length}  → ${describe(id.model)}`);
    console.log(`      fitted on ${id.fittedOn} (${id.samples.reads} read / ${id.samples.writes} write samples)`);
    for (const r of cand.readers.slice(0, 3)) console.log(`      read  by ${site(r)}`);
    for (const w of cand.writers.slice(0, 3)) console.log(`      write by ${H(w)}`);
    if (id.sequence.length) console.log(`      seq ${id.sequence.slice(0, 16).map((v) => H(v, 2)).join(' ')}`);
  }
  if (!cands.state.length) console.log('  (none)');
  for (const n of cands.notes.slice(0, 6)) console.log(`  note: ${n}`);

  console.log(`\n=== table candidates (a pointer walking a run of bytes) — ${cands.walker.length} ===`);
  const tables = [];
  for (const cand of cands.walker) {
    const id = identifyTable(cand, hits);
    tables.push(id);
    console.log(`  ${site(cand.pc)}`);
    console.log(`      ${H(cand.lo)}-${H(cand.hi)} stride ${cand.stride} distinct ${cand.distinct}${cand.distinctCapped ? '+' : ''}`
      + `  reads ${cand.reads}  wraps ${cand.wraps}  density ${cand.density.toFixed(2)}  callers ${cand.callers.length}`
      + `${cand.writtenBytes ? `  [${cand.writtenBytes} writes into the span — RAM table, not ROM]` : ''}`);
    console.log(`      coverage ${(id.model.coverage * 100).toFixed(0)}% of ${id.model.length} entries`
      + `${id.model.mutable ? '  (mutable — the bytes changed under us)' : ''}`);
    for (const [pc, n] of cand.callers.slice(0, 4)) console.log(`      called from ${H(pc)} ×${n}`);
  }
  if (!cands.walker.length) console.log('  (none)');

  if (tables.length) {
    const ptrs = findPointer(tables[0].indexSequence, hits, cands.state);
    console.log(`\n=== index pointer for the top table ===`);
    if (!ptrs.length) console.log('  not found — no observed RAM byte tracks the index. The pointer may be a register, kept in a bank we did not watch, or the walk is not an index walk at all.');
    for (const p of ptrs.slice(0, 4)) {
      console.log(`  ${H(p.addr)}  tracks index+${p.offset} in ${(p.match * 100).toFixed(0)}% of ${p.samples} samples`);
      console.log(`      → this is the knob: write here, and the next draw moves. Prove it with:`);
      console.log(`        node tools/rng.mjs verify ${diskArgEcho()} --addr ${H(p.addr)} --value 40 --probe ${H(tables[0].model.lo)}-${H(tables[0].model.hi)}`);
    }
  }

  const unclassified = states.filter((s) => s.model.kind === 'unclassified');
  console.log(`\n=== unclassified (kept on purpose) — ${unclassified.length} ===`);
  for (const u of unclassified.slice(0, 8)) console.log(`  ${H(u.addr)}: ${u.model.reason}`);
  if (!cands.state.length && !cands.walker.length) {
    console.log('\nNo candidate survived screening. That is a real answer, not a failure:');
    console.log('  - the title may not have drawn a random number in this window (try --settle later, or reach the game proper)');
    console.log('  - the generator may live on the sub CPU (--cpu sub)');
    console.log('  - the state may be a register or the Z80 R register, which never touches the bus');
  }
  console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  p2.ice.detach();

  if (flag('json')) {
    const out = { schemaVersion: 1, machine: kind, cpu, settle, frames, states, tables };
    const f = opt('out', 'rng-scan.json');
    writeFileSync(f, JSON.stringify(out, null, 2) + '\n');
    console.log(`wrote ${f}  (raw candidates — this is NOT an analysis document; use \`callers --export\` for that)`);
  }
}

function diskArgEcho() {
  const d = opt('disk') ?? pos(0);
  return d ? `--disk ${d}` : '';
}

// ---- verify ------------------------------------------------------------------

async function cmdVerify() {
  const { open, cpu } = await opener();
  const addr = hexOpt('addr', -1);
  if (addr < 0) die('usage: rng.mjs verify --disk <d88> --addr <hex> [--value hex] [--at frames] [--frames n] [--probe lo[-hi]]');
  const value = hexOpt('value', 0x99);
  const probeArg = opt('probe');
  const probeAddr = probeArg
    ? (probeArg.includes('-')
      ? probeArg.split('-').map((x) => parseInt(x, 16))
      : parseInt(probeArg, 16))
    : null;
  const r = verifyByPatch(open, {
    cpu, addr, value,
    atFrame: num('at', 900), frames: num('frames', 120), probeAddr,
  });
  console.log(`patched [${H(addr)}] = ${H(value, 2)} at frame ${r.atFrame}, then ran ${r.frames} frames twice`);
  console.log(`  PC trace   A ${r.lenA} instrs (hash ${H(r.hashA, 8)})   B ${r.lenB} (hash ${H(r.hashB, 8)})`);
  if (r.probeChanged !== null) {
    console.log(`  probe ${probeArg}: ${r.probeChanged ? 'CHANGED' : 'identical'}`);
    if (r.probeChanged) {
      console.log(`    A ${r.probeA.map((v) => H(v, 2)).join(' ')}`);
      console.log(`    B ${r.probeB.map((v) => H(v, 2)).join(' ')}`);
    }
  }
  if (r.firstDiff >= 0) {
    console.log(`  the two runs part at instruction ${r.firstDiff}:`);
    console.log(`    A … ${r.contextA.map((p) => H(p)).join(' ')}`);
    console.log(`    B … ${r.contextB.map((p) => H(p)).join(' ')}`);
  }
  console.log(`\n${r.verdict}`);
  if (!r.changed && r.probeChanged !== true) {
    console.log('  (a REFUTED result is information: try the next candidate, or a later --at — a byte');
    console.log('   that has not been reached yet cannot be upstream of anything.)');
  }
}

// ---- callers -----------------------------------------------------------------

async function cmdCallers() {
  const { open, cpu, kind, profile } = await opener();
  const frames = num('frames', 300);
  const settle = num('settle', 600);
  const site = hexOpt('site', -1);
  const addr = hexOpt('addr', -1);
  if (site < 0 && addr < 0) die('usage: rng.mjs callers --disk <d88> (--site <read-site hex> | --addr <hex>) [--notes f.json]');

  const p = open();
  const s = sample(p.ice, {
    cpu, frames, settle,
    addrs: addr >= 0 ? [[addr, hexOpt('addrhi', addr)]] : [],
    pcs: site >= 0 ? [site] : [],
    keep: num('keep', 60000),
  });
  p.ice.detach();

  const cm = new CallerMap({ machine: kind, cpu, title: opt('title', '') });
  const notesFile = opt('notes');
  if (notesFile && existsSync(notesFile)) cm.loadNotes(JSON.parse(readFileSync(notesFile, 'utf8')));
  cm.ingest(s.hits, { sitePc: site >= 0 ? site : null });

  // `--note <pc>=<meaning>` may be repeated; this is the human half of the tool.
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--note') continue;
    const [k, ...rest] = String(argv[i + 1] ?? '').split('=');
    const pc = parseInt(k, 16);
    if (Number.isFinite(pc)) cm.annotate(pc, rest.join('=') || null);
  }

  console.log(`=== ${s.hits.length} draws over ${s.frames}f (settle ${settle}f), by call site ===`);
  console.log('a call site is the return address on the shadow call stack, i.e. WHO asked for the number.');
  for (const row of cm.toRngCallers()) {
    console.log(`  ${row.pc}  ×${String(row.samples).padStart(6)}  ${row.meaning ?? '(unannotated)'}`);
    console.log(`      ${row.pattern}`);
    console.log(`      values ${row.distribution}`);
  }
  if (!cm.entries.size) console.log('  (no draws — wrong --site, or nothing drew in this window)');
  if (notesFile) {
    writeFileSync(notesFile, JSON.stringify(cm.notesJson(), null, 2) + '\n');
    console.log(`\nnotes → ${notesFile} (edit it by hand; nothing here can guess what a draw MEANS)`);
  }

  if (flag('json') || opt('export')) {
    const { fromRngCallers, stringify, validate } = await import('../analysisdb.js');
    const doc = fromRngCallers(cm.toRngCallers(), {
      machine: kind, cpu, title: opt('title', undefined),
      romHash: await profile.romHash(),
      generator: 'tools/rng.mjs (issue #38)',
    });
    const v = validate(doc);
    for (const w of v.warnings) console.log(`  analysisdb warning: ${w.path}: ${w.message}`);
    if (!v.ok) for (const e of v.errors) console.log(`  analysisdb ERROR: ${e.path}: ${e.message}`);
    const f = opt('export', 'rng-callers.json');
    writeFileSync(f, stringify(doc));
    console.log(`analysis document → ${f}`);
  }
}

// ---- predict / adjust --------------------------------------------------------
// Both take a model on the command line rather than re-deriving it, so a model
// that came out of `scan` can be checked by hand against a printout, a wiki
// page, or a disassembly.

function parseModel(spec) {
  if (!spec) return null;
  const [kind, rest = ''] = spec.split(':');
  const n = rest.split(',').map((x) => parseInt(x, 16));
  const bits = num('bits', 8);
  if (kind === 'lcg') return { kind: 'lcg', bits, a: n[0], c: n[1] ?? 0 };
  if (kind === 'counter') return { kind: 'counter', bits, step: n[0] ?? 1 };
  if (kind === 'lfsr') return { kind: 'lfsr', bits, form: opt('form', 'galois-right'), taps: n[0] };
  if (kind === 'table') return { kind: 'table', lo: n[0], hi: n[1], stride: n[2] ?? 1, length: (n[1] - n[0]) + 1 };
  return null;
}

function cmdPredict() {
  const model = parseModel(opt('model') ?? pos(0));
  if (!model) die('usage: rng.mjs predict --model lcg:5,1 --state 07 [--n 16] [--bits 8]');
  const state = hexOpt('state', 0);
  const n = num('n', 16);
  console.log(describe(model));
  console.log(`from state ${H(state, 2)}, the next ${n} draws:`);
  console.log('  ' + predict(model, state, n).map((v) => H(v, 2)).join(' '));
}

function cmdAdjust() {
  const model = parseModel(opt('model') ?? pos(0));
  if (!model) die('usage: rng.mjs adjust --model lcg:5,1 --want 07 [--in 1]');
  const want = hexOpt('want', -1);
  if (want < 0) die('--want <hex> is required: which value do you want to come out?');
  const steps = num('in', 1);
  const s = statesFor(model, want, steps);
  console.log(describe(model));
  if (!s.length) {
    console.log(`no state produces ${H(want, 2)} after ${steps} draw(s).`);
    console.log('  For an LCG with an even multiplier this is normal — the map is not onto.');
    return;
  }
  console.log(`to get ${H(want, 2)} on draw #${steps}, write one of these into the state now:`);
  console.log('  ' + s.map((v) => H(v, 2)).join(' '));
  console.log('\nverify it before believing it:');
  console.log(`  node tools/rng.mjs verify --disk <d88> --addr <state addr> --value ${H(s[0], 2)} --probe <consumer addr>`);
}

// ---- search ------------------------------------------------------------------
// Issue #38's third act, and the thing a player actually wants: from here, what
// do I DO to get the outcome I want?
//
// Brute force is correct here in a way it never is on real hardware — same
// input, same state, always — so the search is an enumeration with restore()
// between trials. That is also why it needs snapshot(): re-running from reset
// for every trial would work and would take all day.

async function cmdSearch() {
  const { open, cpu } = await opener();
  const goalSpec = opt('goal');
  if (!goalSpec || !goalSpec.includes('=')) {
    die('usage: rng.mjs search --disk <d88> --goal <addr>=<value> [--at 900] [--frames 30] [--tries 120] [--press space]');
  }
  const [gA, gV] = goalSpec.split('=').map((x) => parseInt(x, 16));
  const at = num('at', 900);
  const frames = num('frames', 30);
  const tries = num('tries', 120);
  const press = opt('press');
  const cells = press ? (KEY88[press.toLowerCase()] ?? die(`unknown key "${press}"`)) : [];

  const { machine, ice } = open();
  const c = ice.cpu(cpu);
  const plans = [];
  for (let w = 0; w < tries; w++) {
    plans.push({
      label: press ? `wait ${w}f, press ${press}` : `wait ${w}f`,
      wait: w,
      keys: cells.map(([r, b]) => [0, r, b, w]),
    });
  }
  console.log(`searching ${plans.length} plans from frame ${at}: goal is [${H(gA)}] == ${H(gV, 2)} after ${frames} frames`);
  const r = searchInputs(machine, ice, {
    cpu, plans, frames, atFrame: at,
    goal: () => (c.read(gA) & 0xff) === (gV & 0xff),
  });
  if (r.ok) {
    console.log(`\nFOUND: ${r.plan.label}`);
    console.log(`  reproduce it: restore to frame ${at}, wait ${r.plan.wait} frames${press ? `, then press ${press}` : ''}, run ${frames} frames.`);
    console.log(`  (${r.tried.length} plans tried; determinism means this replays exactly.)`);
  } else {
    console.log(`\n${r.error ?? 'no plan reached the goal'}`);
    console.log('  Widen --tries, move --at, or check that the goal byte is the one that decides anything —');
    console.log('  `verify` will tell you whether it is downstream of the generator at all.');
  }
  ice.detach();
}

// ---- usage -------------------------------------------------------------------

function usage() {
  console.log(`rng — find and manipulate a game's random number generator.  (issue #38)

  node tools/rng.mjs scan    --disk <d88> [--settle 600] [--frames 300] [--cpu main|sub] [--json]
  node tools/rng.mjs verify  --disk <d88> --addr <hex> [--value hex] [--at 900] [--frames 120] [--probe lo[-hi]]
  node tools/rng.mjs callers --disk <d88> (--site <hex> | --addr <hex>) [--notes f.json] [--note PC=meaning] [--export doc.json]
  node tools/rng.mjs predict --model lcg:5,1 --state 07 [--n 16]
  node tools/rng.mjs adjust  --model lcg:5,1 --want 07 [--in 3]
  node tools/rng.mjs search  --disk <d88> --goal <addr>=<val> [--at 900] [--frames 30] [--tries 120] [--press space]

  input scripting (a title screen draws no random numbers):
    --keys space,enter,z --every 90 --hold 6 --until 3000

  common: --machine pc8801|pc8001|nes|md   --cpu main|sub   --romdir <dir>   --rom <file>

Read this before trusting a scan:
  * --settle matters more than --frames. The first few hundred frames of a real
    title are the disk loader, and a loader walks a thousand contiguous bytes
    from one PC — the exact signature of a random-number table.
  * A candidate is a hypothesis. \`verify\` is what turns it into a claim, and a
    REFUTED verdict is the tool working, not failing.
  * Nothing here can tell you what a draw MEANS. \`callers\` gives you the call
    sites and the measured distribution; the meaning is yours to write down.`);
}

const table = {
  scan: cmdScan, verify: cmdVerify, callers: cmdCallers,
  predict: cmdPredict, adjust: cmdAdjust, search: cmdSearch,
  help: usage, '--help': usage, '-h': usage,
};

if (!cmd || !table[cmd]) { usage(); process.exit(cmd ? 2 : 0); }
await table[cmd]();
