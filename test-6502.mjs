// 6502 tests: flags, addressing modes, and above all CYCLES — the NES
// video chip runs at 3x the CPU clock, so a one-cycle error is a visible
// glitch, not a rounding error. The heavyweight verification is nestest
// (see nestools/nestest.mjs); this file pins the pieces individually so a
// nestest failure has somewhere to land.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { M6502, FC, FZ, FI, FD, FB, FU, FV, FN } from './m6502.js';

// A flat 64KB bus that records accesses — dummy reads and the RMW double
// write are part of the contract, so the tests need to see them.
function mk(program, org = 0x0200) {
  const mem = new Uint8Array(0x10000);
  mem.set(program, org);
  const log = { reads: [], writes: [] };
  const bus = {
    read(a) { log.reads.push(a); return mem[a]; },
    write(a, v) { log.writes.push([a, v]); mem[a] = v; },
  };
  const cpu = new M6502(bus);
  cpu.pc = org;
  cpu.p = FU; // start with a clean slate (no I) so IRQ tests are explicit
  return { cpu, mem, log, bus };
}

const step = (cpu) => cpu.step();

test('6502: LDA/LDX/LDY set N and Z, STA writes', () => {
  const { cpu, mem } = mk([
    0xa9, 0x00,       // LDA #$00
    0xa2, 0x80,       // LDX #$80
    0xa0, 0x7f,       // LDY #$7F
    0x8d, 0x00, 0x03, // STA $0300
  ]);
  step(cpu); assert.equal(cpu.a, 0x00); assert.ok(cpu.p & FZ); assert.ok(!(cpu.p & FN));
  step(cpu); assert.equal(cpu.x, 0x80); assert.ok(cpu.p & FN); assert.ok(!(cpu.p & FZ));
  step(cpu); assert.equal(cpu.y, 0x7f); assert.ok(!(cpu.p & FN) && !(cpu.p & FZ));
  step(cpu); assert.equal(mem[0x0300], 0x00);
});

test('6502: instruction cycle counts (the base table falls out of bus accesses)', () => {
  const cases = [
    [[0xea], 2, 'NOP'],
    [[0xa9, 0x01], 2, 'LDA #'],
    [[0xa5, 0x10], 3, 'LDA zp'],
    [[0xb5, 0x10], 4, 'LDA zp,X'],
    [[0xad, 0x00, 0x03], 4, 'LDA abs'],
    [[0x8d, 0x00, 0x03], 4, 'STA abs'],
    [[0x9d, 0x00, 0x03], 5, 'STA abs,X (always pays the dummy read)'],
    [[0xa1, 0x10], 6, 'LDA (zp,X)'],
    [[0xb1, 0x10], 5, 'LDA (zp),Y'],
    [[0x06, 0x10], 5, 'ASL zp'],
    [[0x16, 0x10], 6, 'ASL zp,X'],
    [[0x0e, 0x00, 0x03], 6, 'ASL abs'],
    [[0x1e, 0x00, 0x03], 7, 'ASL abs,X'],
    [[0x4c, 0x00, 0x03], 3, 'JMP abs'],
    [[0x6c, 0x00, 0x03], 5, 'JMP (ind)'],
    [[0x20, 0x00, 0x03], 6, 'JSR'],
    [[0x48], 3, 'PHA'],
    [[0x68], 4, 'PLA'],
    [[0x00], 7, 'BRK'],
  ];
  for (const [prog, want, name] of cases) {
    const { cpu } = mk(prog);
    assert.equal(step(cpu), want, `${name} should take ${want} cycles`);
  }
});

test('6502: page-cross penalty on indexed reads, none on stores', () => {
  // LDA $02FF,X with X=1 crosses into $0300: the chip reads $0200 first
  // (the un-carried address) and then the right one.
  const { cpu, log } = mk([0xa2, 0x01, 0xbd, 0xff, 0x02]);
  step(cpu);
  assert.equal(step(cpu), 5, 'LDA abs,X across a page boundary costs 5');
  assert.ok(log.reads.includes(0x0200), 'the bogus pre-carry read really happens');
  assert.ok(log.reads.includes(0x0300));

  const noCross = mk([0xa2, 0x01, 0xbd, 0x00, 0x02]);
  step(noCross.cpu);
  assert.equal(step(noCross.cpu), 4, 'no page cross: 4');

  const store = mk([0xa2, 0x01, 0x9d, 0x00, 0x02]);
  step(store.cpu);
  assert.equal(step(store.cpu), 5, 'stores always cost the extra cycle');
});

test('6502: (zp),Y page cross and the zero-page pointer wrap', () => {
  const { cpu, mem } = mk([0xa0, 0x01, 0xb1, 0xff]); // LDA ($FF),Y
  mem[0xff] = 0x34; mem[0x00] = 0x12; // pointer high byte wraps to $00, not $0100
  mem[0x1235] = 0x5a;
  step(cpu);
  assert.equal(step(cpu), 5);
  assert.equal(cpu.a, 0x5a);
});

test('6502: RMW writes the old value back before the new one', () => {
  // Games use that doubled write on purpose (INC on a mapper or APU
  // register hits it twice), so it is behaviour, not an artefact.
  const { cpu, mem, log } = mk([0xe6, 0x10]); // INC $10
  mem[0x10] = 0x41;
  step(cpu);
  assert.deepEqual(log.writes, [[0x10, 0x41], [0x10, 0x42]]);
  assert.equal(mem[0x10], 0x42);
});

test('6502: ADC/SBC carry and overflow edges', () => {
  const { cpu } = mk([
    0x18, 0x69, 0x50,       // CLC; ADC #$50  (A=$50 -> $A0, V set, N set)
    0x18, 0x69, 0x50,       // CLC; ADC #$50  ($A0+$50 = $F0, no V)
    0x38, 0xe9, 0x01,       // SEC; SBC #$01
  ]);
  cpu.a = 0x50;
  step(cpu); step(cpu);
  assert.equal(cpu.a, 0xa0);
  assert.ok(cpu.p & FV, 'positive + positive = negative sets V');
  assert.ok(cpu.p & FN);
  assert.ok(!(cpu.p & FC));
  step(cpu); step(cpu);
  assert.equal(cpu.a, 0xf0);
  assert.ok(!(cpu.p & FV));
  step(cpu); step(cpu);
  assert.equal(cpu.a, 0xef);
  assert.ok(cpu.p & FC, 'no borrow leaves carry set');
});

test('6502: decimal mode is off on the 2A03 and on by request', () => {
  const nes = mk([0xf8, 0x18, 0x69, 0x01]); // SED; CLC; ADC #$01
  nes.cpu.a = 0x09;
  step(nes.cpu); step(nes.cpu); step(nes.cpu);
  assert.equal(nes.cpu.a, 0x0a, '2A03 ignores D: binary result');

  const mem = new Uint8Array(0x10000);
  mem.set([0xf8, 0x18, 0x69, 0x01], 0x200);
  const cpu = new M6502({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } }, { decimal: true });
  cpu.pc = 0x200; cpu.p = FU; cpu.a = 0x09;
  cpu.step(); cpu.step(); cpu.step();
  assert.equal(cpu.a, 0x10, 'a plain NMOS 6502 does BCD');
});

test('6502: CMP/BIT flags', () => {
  const { cpu, mem } = mk([0xc9, 0x10, 0x24, 0x10]); // CMP #$10; BIT $10
  cpu.a = 0x10;
  step(cpu);
  assert.ok(cpu.p & FZ && cpu.p & FC, 'equal: Z and C');
  mem[0x10] = 0xc0; // N and V come straight from the operand
  cpu.a = 0x00;
  step(cpu);
  assert.ok(cpu.p & FN && cpu.p & FV && cpu.p & FZ);
});

test('6502: branches cost 2/3/4 (not taken / taken / taken across a page)', () => {
  const notTaken = mk([0xd0, 0x02]); // BNE +2 with Z set
  notTaken.cpu.p |= FZ;
  assert.equal(step(notTaken.cpu), 2);

  const taken = mk([0xd0, 0x02]);
  assert.equal(step(taken.cpu), 3);
  assert.equal(taken.cpu.pc, 0x0204);

  // put the branch so that the target lands in the next page
  const cross = mk([0xd0, 0x7f], 0x02f0);
  assert.equal(step(cross.cpu), 4);
  assert.equal(cross.cpu.pc, 0x0371);
});

test('6502: JMP (ind) reproduces the page-wrap bug', () => {
  const { cpu, mem } = mk([0x6c, 0xff, 0x02], 0x0600); // JMP ($02FF)
  mem[0x02ff] = 0x34;
  mem[0x0300] = 0xaa; // what a fixed chip would use
  mem[0x0200] = 0x12; // what the real one uses: the pointer wraps inside its page
  step(cpu);
  assert.equal(cpu.pc, 0x1234);
});

test('6502: JSR/RTS round trip pushes return-1', () => {
  const { cpu, mem } = mk([0x20, 0x00, 0x03]); // JSR $0300
  mem[0x0300] = 0x60; // RTS
  step(cpu);
  assert.equal(cpu.pc, 0x0300);
  assert.equal(cpu.s, 0xfb);
  assert.equal(mem[0x01fd], 0x02);
  assert.equal(mem[0x01fc], 0x02, 'pushed address points at the JSR operand high byte');
  assert.equal(step(cpu), 6);
  assert.equal(cpu.pc, 0x0203);
});

test('6502: BRK pushes B, IRQ does not, RTI restores', () => {
  const { cpu, mem } = mk([0x00, 0xff]); // BRK (its second byte is skipped)
  mem[0xfffe] = 0x00; mem[0xffff] = 0x04;
  mem[0x0400] = 0x40; // RTI
  step(cpu);
  assert.equal(cpu.pc, 0x0400);
  assert.ok(cpu.p & FI, 'entering the handler masks IRQs');
  assert.equal(mem[0x01fb] & FB, FB, 'BRK marks the pushed status');
  step(cpu);
  assert.equal(cpu.pc, 0x0202, 'BRK is two bytes wide');
  assert.equal(cpu.p & FB, 0, 'B never lands back in the register');

  const irq = mk([0xea]);
  irq.mem[0xfffe] = 0x00; irq.mem[0xffff] = 0x04;
  irq.cpu.irq(true);
  assert.equal(step(irq.cpu), 7);
  assert.equal(irq.mem[0x01fb] & FB, 0, 'an IRQ pushes B clear — that is how the handler tells them apart');
});

test('6502: NMI is edge-triggered and beats a pending IRQ', () => {
  const { cpu, mem } = mk([0xea, 0xea]);
  mem[0xfffa] = 0x00; mem[0xfffb] = 0x05;
  mem[0xfffe] = 0x00; mem[0xffff] = 0x04;
  mem[0x0500] = 0xea; // the NMI handler: just a NOP
  cpu.irq(true);
  cpu.setNmi(true);
  assert.equal(step(cpu), 7);
  assert.equal(cpu.pc, 0x0500, 'NMI wins over a pending IRQ');
  cpu.setNmi(true); // the PPU still holds the line low: no new edge
  step(cpu);
  assert.equal(cpu.pc, 0x0501, 'a held line does not re-trigger');
  cpu.setNmi(false);
  cpu.setNmi(true); // fresh falling edge
  step(cpu);
  assert.equal(cpu.pc, 0x0500, 'and I being set does not mask an NMI');
});

test('6502: CLI/SEI take effect one instruction late, RTI does not', () => {
  const { cpu, mem } = mk([0x58, 0xea, 0xea]); // CLI; NOP; NOP
  mem[0xfffe] = 0x00; mem[0xffff] = 0x04;
  cpu.p |= FI;
  cpu.irq(true);
  step(cpu); // CLI
  assert.equal(cpu.pc, 0x0201);
  step(cpu); // the NOP still runs: the mask change was sampled too late
  assert.equal(cpu.pc, 0x0202);
  step(cpu); // now the IRQ lands
  assert.equal(cpu.pc, 0x0400);

  // RTI pulls P early enough that a cleared I is in force immediately.
  const rti = mk([0x40]);
  rti.mem[0xfffe] = 0x00; rti.mem[0xffff] = 0x04;
  rti.mem[0x01fc] = FU;                            // pulled P: I clear
  rti.mem[0x01fd] = 0x50; rti.mem[0x01fe] = 0x02;  // return to $0250 (lo, hi)
  rti.cpu.s = 0xfb;
  rti.cpu.p |= FI;
  rti.cpu.irq(true);
  step(rti.cpu);
  assert.equal(rti.cpu.pc, 0x0250);
  step(rti.cpu);
  assert.equal(rti.cpu.pc, 0x0400, 'the IRQ is taken on the very next instruction');
});

test('6502: illegal opcodes games depend on', () => {
  const lax = mk([0xa7, 0x10]); // LAX $10
  lax.mem[0x10] = 0x80;
  assert.equal(step(lax.cpu), 3);
  assert.equal(lax.cpu.a, 0x80);
  assert.equal(lax.cpu.x, 0x80);
  assert.ok(lax.cpu.p & FN);

  const sax = mk([0x87, 0x10]); // SAX $10 stores A&X and touches no flag
  sax.cpu.a = 0xf0; sax.cpu.x = 0x3c; sax.cpu.p = FU | FZ;
  step(sax.cpu);
  assert.equal(sax.mem[0x10], 0x30);
  assert.equal(sax.cpu.p, FU | FZ);

  const dcp = mk([0xc7, 0x10]); // DCP $10 = DEC then CMP
  dcp.mem[0x10] = 0x43; dcp.cpu.a = 0x42;
  assert.equal(step(dcp.cpu), 5);
  assert.equal(dcp.mem[0x10], 0x42);
  assert.ok(dcp.cpu.p & FZ && dcp.cpu.p & FC);

  const slo = mk([0x07, 0x10]); // SLO $10 = ASL then ORA
  slo.mem[0x10] = 0x81; slo.cpu.a = 0x01;
  step(slo.cpu);
  assert.equal(slo.mem[0x10], 0x02);
  assert.equal(slo.cpu.a, 0x03);
  assert.ok(slo.cpu.p & FC, 'the shifted-out bit still lands in C');

  const anc = mk([0x0b, 0x80]); // ANC #$80 copies N into C
  anc.cpu.a = 0xff;
  step(anc.cpu);
  assert.equal(anc.cpu.a, 0x80);
  assert.ok(anc.cpu.p & FC && anc.cpu.p & FN);

  const sbx = mk([0xcb, 0x10]); // SBX #$10: X = (A&X) - imm
  sbx.cpu.a = 0xff; sbx.cpu.x = 0x20;
  step(sbx.cpu);
  assert.equal(sbx.cpu.x, 0x10);
  assert.ok(sbx.cpu.p & FC);

  const nop = mk([0x1c, 0xff, 0x02]); // NOP abs,X with a page cross: 5 cycles
  nop.cpu.x = 0x01;
  assert.equal(step(nop.cpu), 5);
  assert.equal(nop.cpu.pc, 0x0203, 'the 3-byte NOP consumes its operand');

  const jam = mk([0x02]);
  step(jam.cpu);
  assert.ok(jam.cpu.jammed, 'KIL stops the chip until RESET');
  const pc = jam.cpu.pc;
  step(jam.cpu);
  assert.equal(jam.cpu.pc, pc, 'and it stays stopped');
});

test('6502: RESET pulls the vector and rewinds the stack pointer by 3', () => {
  const { cpu, mem } = mk([]);
  mem[0xfffc] = 0x34; mem[0xfffd] = 0x12;
  cpu.s = 0x00;
  const before = cpu.cycles;
  cpu.reset();
  assert.equal(cpu.pc, 0x1234);
  assert.equal(cpu.s, 0xfd);
  assert.ok(cpu.p & FI);
  assert.equal(cpu.cycles - before, 7);
});

// ---- determinism: the property rewind is built on --------------------------

// A deterministic pseudo-program. No Math.random anywhere in this repo; a
// tiny LCG gives us a reproducible blob of "code" to hammer the decoder.
function fillDeterministic(mem, seed) {
  let s = seed >>> 0;
  for (let i = 0x0200; i < 0x0800; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    mem[i] = (s >>> 16) & 0xff;
  }
  // Keep it out of the JAM opcodes so the run actually goes somewhere:
  // every $x2 pattern that would halt becomes a NOP.
  const jam = new Set([0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2]);
  for (let i = 0x0200; i < 0x0800; i++) if (jam.has(mem[i])) mem[i] = 0xea;
  // ...and land back at the top instead of wandering into the vectors.
  mem[0x07fd] = 0x4c; mem[0x07fe] = 0x00; mem[0x07ff] = 0x02; // JMP $0200
}

function fingerprint(cpu, mem) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < 0x800; i++) { h ^= mem[i]; h = Math.imul(h, 16777619) >>> 0; }
  return JSON.stringify({ ...cpu.getState(), mem: h });
}

function mkDeterministic(seed) {
  const mem = new Uint8Array(0x10000);
  fillDeterministic(mem, seed);
  const cpu = new M6502({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
  cpu.pc = 0x0200; cpu.p = FU;
  return { cpu, mem };
}

test('6502: same program + same input -> identical state (twice)', () => {
  const run = () => {
    const { cpu, mem } = mkDeterministic(0x1234);
    for (let i = 0; i < 20000; i++) cpu.step();
    return fingerprint(cpu, mem);
  };
  assert.equal(run(), run());
});

test('6502: snapshot -> run ahead -> restore -> replay lands on the same timeline', () => {
  const { cpu, mem } = mkDeterministic(0xc0de);
  for (let i = 0; i < 5000; i++) cpu.step();

  const cpuSnap = cpu.snapshot();
  const memSnap = mem.slice(); // the machine snapshots RAM; the CPU only has registers

  for (let i = 0; i < 3000; i++) cpu.step();
  const first = fingerprint(cpu, mem);

  cpu.restore(cpuSnap);
  mem.set(memSnap);
  for (let i = 0; i < 3000; i++) cpu.step();
  assert.equal(fingerprint(cpu, mem), first);
});

test('6502: an interrupt arriving after a snapshot replays identically', () => {
  const { cpu, mem } = mkDeterministic(0xbeef);
  mem[0xfffa] = 0x00; mem[0xfffb] = 0x02;
  for (let i = 0; i < 1000; i++) cpu.step();
  const snap = cpu.snapshot();
  const memSnap = mem.slice();

  const play = () => {
    for (let i = 0; i < 500; i++) {
      if (i === 137) cpu.nmi(); // input arrives mid-replay: the hard case
      cpu.step();
    }
    return fingerprint(cpu, mem);
  };
  const first = play();
  cpu.restore(snap); mem.set(memSnap);
  assert.equal(play(), first);
});

test('6502: getState/setState is an exact inverse', () => {
  const { cpu } = mkDeterministic(0x5a5a);
  for (let i = 0; i < 777; i++) cpu.step();
  const s = cpu.getState();
  const before = JSON.stringify(s);
  cpu.setState(JSON.parse(before));
  assert.equal(JSON.stringify(cpu.getState()), before);
  assert.equal(s.schemaVersion, 1);
});

// ---- nestest ---------------------------------------------------------------
// The real acceptance test. BYO-ROM: it is not in this repo (see
// docs/nes-design.md), so the test skips unless the paths are given.
test('6502: nestest log matches instruction by instruction', async (t) => {
  const romPath = process.env.NESTEST_ROM;
  const logPath = process.env.NESTEST_LOG;
  if (!romPath || !logPath) return t.skip('set NESTEST_ROM and NESTEST_LOG (see docs/nes-design.md)');
  const { runNestest } = await import('./nestools/nestest.mjs');
  const rom = new Uint8Array(await readFile(romPath));
  const log = await readFile(logPath, 'utf8');
  const r = runNestest(rom, log);
  assert.ok(r.ok, r.error);
  assert.ok(r.statusOk, `nestest status bytes: ${r.status}`);
});
