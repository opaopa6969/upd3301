// ice — the ICE, headless.
//
// Everything demo/ice.html can measure, from a shell. The measurement itself is
// ../icecore.js (pure, machine-independent); this file is argument parsing,
// machine construction and printing.
//
// It exists because the M88 parity run (#32) re-invented the ICE six times as
// one-shot scripts. Each subcommand here is the ICE doing what one of those
// scripts does:
//
//   trace   ≡ tools/pc-trace.mjs      PC trace, PC-anchored arming
//   diff    ≡ tools/trace-diff.mjs    census + first structural divergence
//   read    ≡ tools/watch-read.mjs    what the CPU actually saw
//   write   ≡ tools/watch-write.mjs   who wrote here, with what banking
//   life    ≡ tools/life-scan.mjs     region-of-life over a whole run
//   loop    ≡ tools/loop-profile.mjs  waiting or runaway?
//   caps                              what the ICE can do on this machine
//   break                             run to a breakpoint and dump the scene
//
// The six originals stay where they are — #32's written procedures point at
// them and a running investigation is not a place to move furniture. This is
// the proof that they can be retired, not the retirement.
//
// Usage:
//   node tools/ice.mjs <cmd> [options]
//   node tools/ice.mjs help
//
// Machine selection is uniform across subcommands:
//   --machine pc8801|pc8001|nes|md   (default pc8801)
//   --disk <d88>      PC-88: mount into drives 0/1
//   --rom <file>      PC-8001 / NES / Mega Drive: the ROM image
//   --romdir <dir>    PC-88 ROM set (default: the M88 install)
//   --cpu main|sub|z80
//
// Machines that live on branches which have not merged yet (nes, md) fail with
// a plain message rather than a stack trace: the CLI is ready for them, the
// files are not here.

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { IceCore, traceDiff, bucketize, PC88_BUCKETS, hex as H } from '../icecore.js';

const hex = (v, w = 2) => (v >>> 0).toString(16).padStart(w, '0');

// ---- argv --------------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
// Flags that take no value — everything else consumes the next argv entry.
const FLAGS = new Set(['bytes', 'collapse', 'nodedupe', 'read', 'in', 'help']);
const opt = (name, dflt = null) => {
  const i = argv.indexOf('--' + name);
  return i < 0 ? dflt : argv[i + 1];
};
const flag = (name) => argv.includes('--' + name);
const num = (name, dflt) => { const v = opt(name); return v == null ? dflt : Number(v); };
const hexOpt = (name, dflt = -1) => { const v = opt(name); return v == null ? dflt : parseInt(v, 16); };
// Positional arguments, skipping flag values. Kept because the six originals
// are positional and muscle memory is a real cost.
function pos(n) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { if (!FLAGS.has(a.slice(2))) i++; continue; }
    out.push(a);
  }
  return out[n];
}

const DEFAULT_ROMDIR = '/mnt/c/var/emulator/エミュレーター本体/PC88/m88204';

// ---- machines ----------------------------------------------------------------
// A machine profile knows how to build the machine and what its interesting
// bytes are called. Everything in icecore.js is machine-independent; the
// machine-specific knowledge that a *report* needs lives here, in one table.

const MACHINES = {
  pc8801: {
    buckets: PC88_BUCKETS,
    async build() {
      const { Pc8801Machine } = await import('../machine88.js');
      const { parseD88All } = await import('../d88.js');
      const { loadRomSet } = await import('./romset.mjs');
      const { main, ext, sub } = loadRomSet(opt('romdir', DEFAULT_ROMDIR));
      const m = new Pc8801Machine({ main, ext, sub, mode: opt('mode', 'n88') });
      // --tvram on|off forces the F000-FFFF routing, to test whether that
      // mapping is what changes a title's fate (see docs/m88-comparison.md).
      const tv = opt('tvram', 'normal');
      if (tv !== 'normal') Object.defineProperty(m, '_tvramOn', { get: () => tv === 'on' });
      const disk = opt('disk') ?? pos(0);
      if (disk) parseD88All(new Uint8Array(readFileSync(resolve(disk)))).forEach((img, u) => { if (u < 2) m.insertDisk(u, img); });
      return m;
    },
    // The one-line "where is this machine" fingerprint the M88 comparison used.
    fingerprint(m) {
      let tvnz = 0; for (const b of m.tvram) if (b) tvnz++;
      let ramF0 = 0; for (let a = 0xf000; a <= 0xffff; a++) if (m.ram[a]) ramF0++;
      return { e6cd: m.ram[0xe6cd], p31: m._port31, p32: m._port32, gw: m.gvramWindow, tvnz, ramF0 };
    },
    fpText: (f) => `E6CD=${hex(f.e6cd)} p31=${hex(f.p31)} p32=${hex(f.p32)} gw=${f.gw} tvNZ=${f.tvnz}`,
    // Where a write actually landed. C000-FFFF is main RAM, a GVRAM plane, the
    // ALU or text VRAM depending on ports 31h/32h/5xh, so the destination is
    // part of the evidence — this is what watch-write.mjs prints as dest=.
    annotate(m, hit) {
      const a = hit.addr;
      let dest = 'ram';
      if (a >= 0x8000 && a < 0x8400 && !m.n80mode && (m._port31 & 6) === 0) dest = `txtwnd+${hex(m._txtwnd, 4)}`;
      else if (a >= 0xc000 && m._aluOn()) dest = 'ALU';
      else if (a >= 0xc000 && m.gvramWindow >= 0) dest = `gvram${m.gvramWindow}`;
      else if (a >= 0xf000 && m._tvramOn && (m._port32 & 0x10) === 0) dest = 'tvram';
      return { dest, p31: m._port31, p32: m._port32, gw: m.gvramWindow };
    },
  },
  pc8001: {
    buckets: [[0x1000, 'LOW<1000'], [0x6000, '1000-5fff'], [0x8000, 'ROM top'], [0xc000, '8000-bfff'], [0x10000, 'c000-ffff']],
    async build() {
      const { Pc8001Machine } = await import('../machine.js');
      const rom = new Uint8Array(readFileSync(resolve(opt('rom') ?? pos(0) ?? 'roms/N80_2.ROM')));
      return new Pc8001Machine({ rom });
    },
    fingerprint: () => ({}),
    fpText: () => '',
  },
  nes: {
    // The 6502's zero page and stack page are a different world from the Z80's
    // low memory; the buckets have to follow the machine, which is why
    // icecore.bucketize takes them as an argument.
    buckets: [[0x100, 'zeropage'], [0x200, 'stack'], [0x800, 'RAM'], [0x8000, 'regs/SRAM'], [0x10000, 'PRG ROM']],
    async build() {
      const { NesMachine } = await import('../machinenes.js');
      return new NesMachine({ rom: new Uint8Array(readFileSync(resolve(opt('rom') ?? pos(0)))) });
    },
    fingerprint: () => ({}),
    fpText: () => '',
  },
  md: {
    buckets: [[0x400000, 'cart ROM'], [0xa00000, 'reserved'], [0xc00000, 'IO/Z80'], [0xe00000, 'VDP'], [0x1000000, 'work RAM']],
    async build() {
      const { MegaDriveMachine } = await import('../machinemd.js');
      return new MegaDriveMachine({ rom: new Uint8Array(readFileSync(resolve(opt('rom') ?? pos(0)))) });
    },
    fingerprint: () => ({}),
    fpText: () => '',
  },
};

async function openMachine() {
  const kind = opt('machine', 'pc8801');
  const profile = MACHINES[kind];
  if (!profile) die(`unknown --machine ${kind} (have: ${Object.keys(MACHINES).join(', ')})`);
  let m;
  try { m = await profile.build(); }
  catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') {
      die(`--machine ${kind}: its machine module is not on this branch yet.\n`
        + `        (nes → branch nes-emulator, md → branch megadrive; the CLI is ready for both)`);
    }
    throw e;
  }
  const ice = new IceCore();
  ice.attach(m);
  const cpuName = opt('cpu', 'main');
  if (!ice.cpu(cpuName)) {
    die(`no CPU named "${cpuName}" on this machine (have: ${ice.cpus.map((c) => c.name).join(', ') || 'none'})`);
  }
  return { m, ice, profile, cpu: cpuName };
}

function die(msg) { console.error('ice: ' + msg); process.exit(2); }

// ---- verdicts ----------------------------------------------------------------
// The judgement rules live in tools/verdict.js as pure, unit-tested functions
// (they have been wrong three times; test-verdict.mjs encodes each mistake).
// That file arrives with the M88 parity branch. Rather than re-deriving the
// thresholds here — which is precisely the sin this whole issue is about — we
// import it when it is present and report raw signals when it is not.
let verdict = null;
try { verdict = await import('./verdict.js'); } catch { verdict = null; }

// ---- subcommands -------------------------------------------------------------

async function cmdCaps() {
  const { ice, m } = await openMachine();
  console.log(`machine: ${opt('machine', 'pc8801')}  frame=${m.frame}  snapshot=${typeof m.snapshot === 'function' ? 'yes' : 'no'}`);
  for (const c of ice.capabilities()) {
    console.log(`  cpu ${c.cpu.padEnd(5)} arch=${c.name.padEnd(8)} mem=${c.memHow.padEnd(14)}`
      + `${c.intrusiveRead ? ' [reads go through the live bus — may perturb]' : ''}`
      + `  disasm=${c.disassembly ? 'yes' : 'NO'} callstack=${c.callStack ? 'yes' : 'NO'} io=${c.io ? 'yes' : 'NO'}`);
  }
  ice.detach();
}

// ≡ tools/pc-trace.mjs. Arming on a PC rather than a frame is the whole point:
// two emulators reach the same program point at different frame numbers, so
// "the first execution of address X" is the only shared anchor.
async function cmdTrace() {
  const { m, ice, profile, cpu } = await openMachine();
  const out = opt('out') ?? pos(1);
  const frames = num('frames', Number(pos(2) ?? 150));
  const armPc = hexOpt('armpc', -1);
  const from = num('from', armPc >= 0 ? -1 : 0);
  const max = num('max', 3_000_000);
  ice.cpu(cpu).traceOn = false; // the register ring is dead weight for a PC trace
  ice.cpu(cpu).stackOn = false;
  ice.recordPcTrace(cpu, { max, armPc, fromFrame: from, dedupe: !flag('nodedupe') });
  ice.runFrames(frames);
  const tr = ice.pcTrace(cpu);
  let s = '';
  for (let i = 0; i < tr.n; i++) s += hex(tr.pcs[i], 4) + '\n';
  if (out) writeFileSync(out, s); else process.stdout.write(s);
  const tag = out ? ` -> ${out}` : '';
  console.log(`# traced ${tr.n} instrs (${flag('nodedupe') ? 'raw' : 'deduped'})${tag}  armed at frame ${tr.armFrame}${armPc >= 0 ? ` (pc=${hex(armPc, 4)})` : ''}`);
  if (tr.full) console.log('# WARNING trace budget full — raise --max');
  const fp = profile.fingerprint(m);
  if (profile.fpText(fp)) console.log(`# final ${profile.fpText(fp)}`);
  ice.detach();
}

// ≡ tools/trace-diff.mjs, on the pure traceDiff() in icecore.js.
function cmdDiff() {
  const a = pos(0), b = pos(1);
  if (!a || !b) die('usage: ice.mjs diff <a.txt> <b.txt> [--window n] [--context n] [--top n]');
  const load = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const A = load(a), B = load(b);
  const CTX = num('context', 12), TOP = num('top', 15);
  const r = traceDiff(A, B, { window: num('window', 200000) });
  console.log(`A=${a} (${r.lenA})  B=${b} (${r.lenB})`);
  if (r.lengthWarning) console.log('! lengths differ by >5% — truncate the longer trace first, or "X-only" just means "X ran longer"');
  console.log('\n=== census ===');
  console.log(`A-only PCs: ${r.aOnly.length}   B-only PCs: ${r.bOnly.length}`);
  const show = (list, tag) => {
    if (!list.length) { console.log(`  (none ${tag})`); return; }
    const span = [Math.min(...list.map(([p]) => parseInt(p, 16))), Math.max(...list.map(([p]) => parseInt(p, 16)))];
    console.log(`  ${tag} span ${hex(span[0], 4)}-${hex(span[1], 4)}:`);
    for (const [pc, n] of list.slice(0, TOP)) console.log(`    ${pc}  ${String(n).padStart(7)}x`);
    if (list.length > TOP) console.log(`    … ${list.length - TOP} more`);
  };
  show(r.aOnly, 'A-only'); show(r.bOnly, 'B-only');
  console.log('\n=== first structural divergence ===');
  console.log(`re-syncs while both healthy: ${r.resyncs}`);
  if (!r.diverged) {
    console.log(`no permanent divergence within the traces (A consumed ${r.a}/${r.lenA}, B ${r.b}/${r.lenB})`);
    return;
  }
  console.log(`\n*** permanent divergence at A[${r.a}] / B[${r.b}] (last re-sync at A[${r.lastResync}]) ***`);
  console.log('--- A ---');
  for (let k = Math.max(0, r.a - CTX); k < Math.min(A.length, r.a + CTX); k++)
    console.log(`  ${k === r.a ? '>>' : '  '} ${String(k).padStart(8)}  ${A[k]}`);
  console.log('--- B ---');
  for (let k = Math.max(0, r.b - CTX); k < Math.min(B.length, r.b + CTX); k++)
    console.log(`  ${k === r.b ? '>>' : '  '} ${String(k).padStart(8)}  ${B[k]}`);
}

// ≡ tools/watch-read.mjs and tools/watch-write.mjs. One recorder, two default
// directions, because they were always the same instrument.
async function cmdWatch(rw) {
  const { m, ice, profile, cpu } = await openMachine();
  const range = opt('range') ?? pos(1);
  if (!range) die(`usage: ice.mjs ${rw} --disk <d88> --range <lo>[-<hi>] [--frames n] [--pc hex[-hex]] [--max n] [--bytes]`);
  const [loS, hiS] = String(range).split('-');
  const lo = parseInt(loS, 16);
  const hi = hiS ? parseInt(hiS, 16) : (rw === 'r' ? lo : lo + 0x0f);
  const frames = num('frames', Number(pos(2) ?? (rw === 'r' ? 200 : 400)));
  const pcArg = opt('pc');
  const [pcLo, pcHi] = pcArg == null ? [-1, -1]
    : (() => { const [x, y] = pcArg.split('-'); const l = parseInt(x, 16); return [l, y ? parseInt(y, 16) : l]; })();
  const max = num('max', 4000);
  const bytes = flag('bytes');
  const collapse = flag('collapse') || process.env.PCFILTER === '1';
  const c = ice.cpu(cpu);
  c.traceOn = false;
  c.stackOn = false;

  let printed = 0, lastKey = '', lastRun = 0;
  const dis = c.arch.disasm;
  ice.recordMem(cpu, {
    lo, hi, r: rw === 'r', w: rw === 'w', pcLo, pcHi, max: Number.MAX_SAFE_INTEGER,
    annotate: rw === 'w' ? profile.annotate : null,
    onHit(h) {
      if (bytes) { if (printed < max) { printed++; console.log(hex(h.value)); } return; }
      const key = `${h.pc}|${h.dest ?? ''}`;
      if (collapse && key === lastKey) { lastRun++; return; }
      if (collapse && lastRun > 0) console.log(`      … ×${lastRun + 1} more from the same PC`);
      lastRun = 0; lastKey = key;
      if (printed >= max) return;
      printed++;
      if (rw === 'r') {
        console.log(`RD f${String(h.frame).padStart(4, '0')} pc=${hex(h.pc, 4)} [${hex(h.addr, 4)}]=${hex(h.value)}`);
      } else {
        let d = '';
        try { d = dis ? dis(c.read, h.pc).text : ''; } catch { d = '?'; }
        console.log(`f${String(h.frame).padStart(4)} pc=${hex(h.pc, 4)} → [${hex(h.addr, 4)}]=${hex(h.value)}`
          + `${h.dest ? ` dest=${String(h.dest).padEnd(12)} p31=${hex(h.p31)} p32=${hex(h.p32)} gw=${h.gw}` : ''}${d ? ` | ${d}` : ''}`);
      }
    },
  });
  if (!bytes) {
    console.log(`=== ${rw === 'r' ? 'reads' : 'writes'} of ${hex(lo, 4)}-${hex(hi, 4)}`
      + `${pcLo >= 0 ? ` from pc=${hex(pcLo, 4)}-${hex(pcHi, 4)}` : ''} over ${frames}f (cpu=${cpu}) ===`);
  }
  ice.runFrames(frames);
  if (collapse && lastRun > 0) console.log(`      … ×${lastRun + 1} more from the same PC`);
  const L = ice.memLog(cpu);
  if (!bytes) {
    console.log(`\ntotal ${rw === 'r' ? 'reads' : 'writes'}: ${L.total}${printed < L.total ? ` (printed ${printed})` : ''}`);
    const fp = profile.fingerprint(m);
    if (profile.fpText(fp)) console.log(profile.fpText(fp));
  }
  ice.detach();
}

// ≡ tools/life-scan.mjs. A single frame's hot-PC list is not a diagnosis — a
// title can execute low memory legitimately while loading. Walk the whole run
// and look for a change that never recovers.
async function cmdLife() {
  const { m, ice, profile, cpu } = await openMachine();
  const last = num('frames', Number(pos(1) ?? 1500));
  const step = num('step', 100);
  const c = ice.cpu(cpu);
  c.traceOn = false;
  c.stackOn = false;
  ice.recordPcHistogram(cpu);
  const wide = profile.fpText(profile.fingerprint(m)) !== '';
  console.log(`frame  ${wide ? 'E6CD p31 p32 gw  tvNZ ramF0  ' : ''}distinctPC  region-of-life`);
  const samples = [];
  for (let f = 0; f <= last; f++) {
    if (f % step === 0 && f > 0) {
      const h = ice.pcHistogram(cpu, { reset: true });
      const { buckets, total, distinct } = bucketize(h, profile.buckets);
      const top = [...buckets].filter(([, v]) => v).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}:${Math.round(v * 100 / (total || 1))}%`).join(' ');
      const fp = profile.fingerprint(m);
      samples.push({ ...fp, frame: f, distinct });
      const head = wide
        ? `${hex(fp.e6cd)}   ${hex(fp.p31)}  ${hex(fp.p32)}  ${String(fp.gw).padStart(2)}  ${String(fp.tvnz).padStart(4)} ${String(fp.ramF0).padStart(6)}  `
        : '';
      console.log(`${String(f).padStart(5)}  ${head}${String(distinct).padStart(9)}  ${top}`);
    }
    m.stepFrame();
  }
  // A healthy title revisits a small set of PCs; a runaway sweeps thousands of
  // distinct addresses per frame and stops touching I/O. distinctPC is the tell.
  if (verdict && samples.length >= 2) {
    const tail = samples.slice(-3);
    console.log(`converged: ${verdict.isConverged(tail) ? 'yes' : 'NO — do not judge on this run'}`);
  }
  ice.detach();
}

// ≡ tools/loop-profile.mjs. "Waiting" and "runaway" look identical from outside
// (the screen stops changing) and need opposite fixes. Print both signals.
async function cmdLoop() {
  const { m, ice, profile, cpu } = await openMachine();
  const settle = num('settle', Number(pos(1) ?? 600));
  const window = num('window', 2);
  const c = ice.cpu(cpu);
  c.traceOn = false;
  c.stackOn = false;
  ice.runFrames(settle);
  ice.recordPcHistogram(cpu);
  const io = ice.recordIo(cpu);
  ice.runFrames(window);

  const h = ice.pcHistogram(cpu);
  const pcs = [...h].sort((a, b) => b[1] - a[1]);
  const ioCount = io ? [...io.in.values()].reduce((a, e) => a + e.n, 0) + [...io.out.values()].reduce((a, e) => a + e.n, 0) : 0;
  console.log(`=== settled at f${settle}, ${window}-frame profile (cpu=${cpu}, arch=${c.arch.name}) ===`);
  const cls = verdict
    ? verdict.classifyLoop({ distinctPCs: pcs.length, ioCount, halted: !!c.cpu.halted })
    : null;
  console.log(`distinct PCs: ${pcs.length}   I/O accesses: ${ioCount}   halted: ${!!c.cpu.halted}`
    + (cls ? `   → ${cls}` : '   (tools/verdict.js not on this branch — raw signals only)'));
  if (pcs.length) {
    const top = pcs.slice(0, 40).map(([k]) => k);
    const lo = Math.min(...top), hi = Math.max(...top);
    console.log(`hot span: ${hex(lo, 4)}-${hex(hi, 4)}`);
    if (c.arch.disasm) {
      console.log('--- disassembly from the hot span ---');
      let a = lo;
      while (a <= hi + 4 && a < lo + 64) {
        let d; try { d = c.arch.disasm(c.read, a); } catch { break; }
        console.log(`  ${hex(a, 4)}  ${String(h.get(a) ?? 0).padStart(6)}  ${d.text}`);
        a += d.len || 1;
      }
    } else {
      console.log(`(no disassembler for ${c.arch.name} — hot PCs only)`);
      for (const [pc, n] of pcs.slice(0, 12)) console.log(`  ${hex(pc, 4)}  ${String(n).padStart(6)}`);
    }
  }
  const ports = (map, tag) => {
    const e = [...map].sort((x, y) => y[1].n - x[1].n);
    if (!e.length) { console.log(`  (none — no ${tag} at all: it is not waiting on a device)`); return; }
    for (const [p, o] of e) {
      const from = o.pcs.size ? ` from pc={${[...o.pcs].slice(0, 4).map((x) => hex(x, 4)).join(',')}}` : '';
      console.log(`  ${tag} ${hex(p)}: ${String(o.n).padStart(7)}x vals={${[...o.vals].slice(0, 8).map((v) => hex(v)).join(',')}}${from}`);
    }
  };
  if (io) {
    console.log('--- IN ports while spinning ---'); ports(io.in, 'IN ');
    console.log('--- OUT ports while spinning ---'); ports(io.out, 'OUT');
  } else {
    console.log(`(${c.arch.name} has no separate I/O space — device polling shows up as a watchpoint, not a port)`);
  }
  const fp = profile.fingerprint(m);
  if (profile.fpText(fp)) console.log(`state: ${profile.fpText(fp)}`);
  ice.detach();
}

// Run to a breakpoint / watchpoint and dump the scene. This is the thing none of
// the six scripts could do: stop *at* the moment and look around.
async function cmdBreak() {
  const { ice, profile, m, cpu } = await openMachine();
  const frames = num('frames', 2000);
  const at = opt('at'), watch = opt('watch'), io = opt('io');
  const cond = opt('if');
  if (at) {
    const r = ice.setBreak(cpu, parseInt(at, 16), cond);
    if (!r.ok) die(`breakpoint: ${r.error}`);
  }
  if (watch) {
    const [l, h2] = watch.split('-');
    const r = ice.setWatch(cpu, {
      lo: parseInt(l, 16), hi: h2 ? parseInt(h2, 16) : null,
      r: flag('read'), w: !flag('read'), cond,
    });
    if (!r.ok) die(`watch: ${r.error}`);
  }
  if (io) {
    const [l, h2] = io.split('-');
    const r = ice.setIoBreak(cpu, {
      lo: parseInt(l, 16), hi: h2 ? parseInt(h2, 16) : null,
      dirIn: flag('in'), dirOut: !flag('in'), cond,
    });
    if (!r.ok) die(`io break: ${r.error}`);
  }
  if (!at && !watch && !io) die('usage: ice.mjs break --at <hex> | --watch <lo>[-<hi>] | --io <lo>[-<hi>] [--if <expr>]');
  const res = ice.runFrames(frames);
  if (res.stopped !== 'break') { console.log(`no hit in ${frames} frames (ran to frame ${m.frame})`); ice.detach(); return; }
  const c = ice.cpu(cpu);
  const h = ice.hit;
  console.log(`⛔ ${h.type} ${h.rw ?? ''} ${h.addr != null ? hex(h.addr, 4) + '=' + hex(h.value) : ''} @${hex(h.pc, 4)} (${h.cpu}) frame=${m.frame}`);
  const rm = c.arch.regsModel(c.cpu);
  console.log(Object.entries(rm.val).map(([k, v]) => `${k}=${H(v, 4)}`).join(' '));
  if (rm.info) console.log(rm.info);
  const bt = ice.backtrace(cpu);
  console.log('backtrace: ' + (bt.length ? bt.map((f) => `${hex(f.entry, 4)}→${hex(f.retTo, 4)}`).join(' / ') : '(no CALL observed since attach)'));
  console.log('--- last 16 instructions ---');
  for (const r of ice.traceView(cpu, 16)) {
    let d = '';
    try { d = c.arch.disasm ? c.arch.disasm(c.read, r.pc).text : ''; } catch { d = '?'; }
    console.log(`  f=${String(r.frame).padStart(5)} ${hex(r.pc, 4)}  ${d}`);
  }
  const fp = profile.fingerprint(m);
  if (profile.fpText(fp)) console.log(profile.fpText(fp));
  ice.detach();
}

function usage() {
  console.log(`ice — the ICE, headless.  (icecore.js is the same code demo/ice.html runs)

  node tools/ice.mjs caps   [--machine …]                          what this machine exposes
  node tools/ice.mjs trace  --disk <d88> --out <f> [--frames n] [--armpc hex] [--from f] [--max n]
  node tools/ice.mjs diff   <a.txt> <b.txt> [--window n] [--context n] [--top n]
  node tools/ice.mjs read   --disk <d88> --range <lo>[-<hi>] [--frames n] [--pc hex[-hex]] [--bytes]
  node tools/ice.mjs write  --disk <d88> --range <lo>[-<hi>] [--frames n] [--collapse]
  node tools/ice.mjs life   --disk <d88> [--frames n] [--step n] [--tvram on|off]
  node tools/ice.mjs loop   --disk <d88> [--settle n] [--window n]
  node tools/ice.mjs break  --disk <d88> (--at hex | --watch lo[-hi] | --io lo[-hi]) [--if expr] [--frames n]

  common: --machine pc8801|pc8001|nes|md   --cpu main|sub|z80   --romdir <dir>   --rom <file>

Equivalences with the one-shot scripts (kept in place; #32's procedures use them):
  trace ≡ pc-trace.mjs   diff ≡ trace-diff.mjs   read ≡ watch-read.mjs
  write ≡ watch-write.mjs   life ≡ life-scan.mjs   loop ≡ loop-profile.mjs`);
}

const table = {
  caps: cmdCaps, trace: cmdTrace, diff: cmdDiff,
  read: () => cmdWatch('r'), write: () => cmdWatch('w'),
  life: cmdLife, loop: cmdLoop, break: cmdBreak,
  help: usage, '--help': usage, '-h': usage,
};

if (!cmd || !table[cmd]) { usage(); process.exit(cmd ? 2 : 0); }
await table[cmd]();
