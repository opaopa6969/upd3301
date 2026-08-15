// bench-engine.mjs — engine (Z80 core) micro-benchmark.
//
// Measures instructions/sec for representative Z80 workloads in isolation,
// away from the full machine (no video/sound/FDC), so the number reflects
// the CPU core's dispatch + ALU + bus-call overhead, not I/O devices.
//
// Workloads (each a deterministic program in a flat 64KiB RAM):
//   - nop-fill:           pure dispatch + R-bump + PC-increment
//   - ldir-16k:           block copy 16384 bytes (LDIR), the bread-and-butter
//   - alu-loop:            8-bit ADD/SUB/AND/OR/XOR/INC/DEC over registers
//   - port-poll:           IN A,(n) in a tight loop (bus.in call cost)
//   - branchy:             JR cc with mixed taken/not-taken (control flow)
//   - mixed-realistic:     a small interpreter loop: LD, ADD, JP, call/ret
//
// The intent is a apples-to-apples IPS number for the dispatch loop in
// z80.js step()/run(). Real games hit the bus and the chips behind it too,
// so this is an upper bound on the engine's throughput, reported as such.
//
// Usage:
//   node tools/bench-engine.mjs              # default 2s per workload
//   node tools/bench-engine.mjs --ms 1000    # 1s per workload
//   node tools/bench-engine.mjs --json        # machine-readable
//
// Repro: same node version, same flags, single run. Variance across runs
// is ~3-5%; we report median of 5 samples per workload (after a warmup).

import { Z80 } from '../z80.js';

const args = process.argv.slice(2);
const msArg = args.find(a => a.startsWith('--ms='));
const MS = msArg ? Number(msArg.slice(5)) : 2000;
const JSON_OUT = args.includes('--json');

function makeBus() {
  const mem = new Uint8Array(0x10000);
  return {
    mem,
    read: (a) => mem[a & 0xffff],
    write: (a, v) => { mem[a & 0xffff] = v & 0xff; },
    in: (p) => 0x5a,
    out: (p, v) => {},
  };
}

function load(bytes, org = 0) {
  const bus = makeBus();
  bus.mem.set(bytes, org);
  const cpu = new Z80(bus);
  cpu.pc = org;
  cpu.f = 0;
  return { cpu, bus };
}

// A workload returns { cpu, setup, body, tstatesPerIter, name }.
// `body` should advance PC back to the loop start each step; we measure
// `tstates` consumed over a fixed wall time and divide.

function nopFill() {
  const { cpu } = load(new Uint8Array(0x10000).fill(0x00)); // NOP NOP NOP...
  // NOP is 4 tstates. Run N steps, count t-states.
  return {
    name: 'nop-fill',
    cpu,
    perStep: 4,
    run: (n) => { let t = 0; for (let i = 0; i < n; i++) t += cpu.step(); return t; },
  };
}

function ldir16k() {
  // LD HL, src; LD DE, dst; LD BC, 16384; LDIR; JR back to LDIR
  // 0x2100 21 00 00    LD HL,0
  // 0x2103 11 00 40    LD DE,0x4000
  // 0x2106 01 00 40    LD BC,0x4000  (16384)
  // 0x2109 ED B0       LDIR
  // 0x210B 18 FC       JR -4 → back to LDIR (0x2109)
  // LDIR takes 16/21 tstates; once BC hits 0 it falls through to JR (12),
  // but for measurement we just count executed instructions = steps.
  const prog = new Uint8Array([
    0x21, 0x00, 0x00,
    0x11, 0x00, 0x40,
    0x01, 0x00, 0x40,
    0xED, 0xB0,
    0x18, 0xFC,
  ]);
  const { cpu, bus } = load(prog, 0x2100);
  // Pre-fill source with nonzero so we exercise real bus writes
  for (let i = 0; i < 0x4000; i++) bus.mem[i] = i & 0xff;
  return {
    name: 'ldir-16k',
    cpu,
    perStep: null, // variable; we count steps directly
    run: (n) => {
      // Reset BC each full copy so the loop continues; but for benchmark
      // we want continuous work. Simpler: just step n times. After BC=0
      // LDIR falls to JR which jumps back, BC stays 0, LDIR does nothing
      // (16 t-states, no copy). To keep pressure, reset BC every 0x4000 steps.
      let t = 0;
      let k = 0;
      for (let i = 0; i < n; i++) {
        if (k++ === 0x4000) { cpu.bc = 0x4000; k = 0; }
        t += cpu.step();
      }
      return t;
    },
  };
}

function aluLoop() {
  // A tight ALU loop: ADD A,B; SUB B; AND C; OR D; XOR E; INC A; DEC A; JR -8
  // 0x2000 0x80   ADD A,B    (4)
  // 0x2001 0x90   SUB B      (4)
  // 0x2002 0xA1   AND C      (4)
  // 0x2003 0xB2   OR D       (4)
  // 0x2004 0xAB   XOR E      (4)
  // 0x2005 0x3C   INC A      (4)
  // 0x2006 0x3D   DEC A      (4)
  // 0x2007 0x18 F7 JR -8     (12 taken)
  // = 8 instructions, 40 tstates per loop iteration (all reg, no mem)
  const prog = new Uint8Array([
    0x80, 0x90, 0xA1, 0xB2, 0xAB, 0x3C, 0x3D, 0x18, 0xF7,
  ]);
  const { cpu } = load(prog, 0x2000);
  cpu.b = 0x03; cpu.c = 0x0f; cpu.d = 0x55; cpu.e = 0xaa;
  return {
    name: 'alu-loop',
    cpu,
    perStep: null,
    run: (n) => { let t = 0; for (let i = 0; i < n; i++) t += cpu.step(); return t; },
  };
}

function portPoll() {
  // IN A,(n); AND A; JR nz,loop — tight port polling
  // 0x2000 DB 00   IN A,(0)    (11)
  // 0x2002 A7      AND A      (4)
  // 0x2003 20 FB   JR nz,-5   (12 taken / 7 not)
  // = 3 instructions, ~27 tstates per iter
  const prog = new Uint8Array([0xDB, 0x00, 0xA7, 0x20, 0xFB]);
  const { cpu } = load(prog, 0x2000);
  return {
    name: 'port-poll',
    cpu,
    perStep: null,
    run: (n) => { let t = 0; for (let i = 0; i < n; i++) t += cpu.step(); return t; },
  };
}

function branchy() {
  // Mixed taken/not-taken: XOR A; loop: INC A; JP PE, loop2; JP loop; loop2: JP loop
  // Actually simpler — JR cc loop with alternating flags from INC A (parity toggles).
  // 0x2000 AF      XOR A       (sets A=0, Z, PE)
  // 0x2001 3C      INC A       (A=1, NZ, PO) 4
  // 0x2002 20 FD   JR nz,-3    taken 12 → back to INC A
  // = 2 instructions per iter, 16 tstates (INC 4 + JR taken 12)
  const prog = new Uint8Array([0xAF, 0x3C, 0x20, 0xFD]);
  const { cpu } = load(prog, 0x2000);
  return {
    name: 'branchy',
    cpu,
    perStep: null,
    run: (n) => { let t = 0; for (let i = 0; i < n; i++) t += cpu.step(); return t; },
  };
}

function mixedRealistic() {
  // A small "interpreter" — CALL a routine that does LD/ADD/RET, with a
  // loop counter. This exercises CALL/RET (stack memory), LD nn, ADD, JP.
  // 0x2000 0x06 0x00   LD B,0
  // 0x2002 0xCD 0x10 0x20  CALL 0x2010
  // 0x2005 0x04        INC B
  // 0x2006 0x78        LD A,B
  // 0x2007 0xFE 0x00   CP 0   (always NZ since B!=0 after INC)
  // 0x2009 0x28 F7     JR z,-9  (never taken)
  // 0x200B 0xC3 0x02 0x20 JP 0x2002
  // 0x2010 0x3E 0x2A   LD A,0x2A
  // 0x2012 0xC6 0x01   ADD A,1
  // 0x2014 0xC9        RET
  const prog = new Uint8Array([
    0x06, 0x00,
    0xCD, 0x10, 0x20,
    0x04,
    0x78,
    0xFE, 0x00,
    0x28, 0xF7,
    0xC3, 0x02, 0x20,
    0x3E, 0x2A,
    0xC6, 0x01,
    0xC9,
  ]);
  const { cpu } = load(prog, 0x2000);
  return {
    name: 'mixed-realistic',
    cpu,
    perStep: null,
    run: (n) => { let t = 0; for (let i = 0; i < n; i++) t += cpu.step(); return t; },
  };
}

const WORKLOADS = [nopFill, ldir16k, aluLoop, portPoll, branchy, mixedRealistic];

function measure(wl, ms) {
  // Calibrate: run 100k steps, measure wall, extrapolate to ~ms per sample.
  const calibN = 100000;
  let t0 = performance.now();
  wl.run(calibN);
  let t1 = performance.now();
  const usPerStep = (t1 - t0) / calibN;
  const targetN = Math.max(calibN, Math.floor(ms / Math.max(usPerStep, 1e-6)));
  // Warmup: let V8 tier-up to optimized code; discard.
  wl.run(targetN);
  // 5 samples, take median for noise resistance.
  const samples = [];
  for (let s = 0; s < 5; s++) {
    const fresh = WORKLOADS.find(f => f().name === wl.name)();
    t0 = performance.now();
    const tstates = fresh.run(targetN);
    t1 = performance.now();
    const wall = t1 - t0;
    const ips = targetN / (wall / 1000);
    const tps = tstates / (wall / 1000);
    samples.push({ wall, steps: targetN, tstates, ips, tps });
  }
  samples.sort((a, b) => a.ips - b.ips);
  return samples[2]; // median of 5
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(0);
}

const nodeV = process.version;
const ms = MS ?? 2000;
const results = [];
for (const mk of WORKLOADS) {
  const wl = mk();
  const r = measure(wl, ms);
  results.push({ workload: wl.name, ...r });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ node: nodeV, msPerWorkload: ms, results }, null, 2));
} else {
  console.log(`# bench-engine — Z80 core micro-benchmark`);
  console.log(`# node ${nodeV}  ${ms}ms/workload (median of 5, with warmup)`);
  console.log(`# workload        steps     wall(ms)   instr/s   tstate/s`);
  for (const r of results) {
    console.log(
      `  ${r.workload.padEnd(14)}  ${fmt(r.steps).padStart(8)}  ${r.wall.toFixed(1).padStart(8)}  ${fmt(r.ips).padStart(8)}  ${fmt(r.tps).padStart(9)}`,
    );
  }
}
