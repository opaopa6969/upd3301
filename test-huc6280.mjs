// HuC6280 core tests. The parent 6502 is already covered by test-6502.mjs and
// by nestest (8991 lines, see nestools/nestest.mjs), and this file does not
// touch m6502.js — so what is worth testing here is exactly what the subclass
// changes: the relocated page zero and stack, the MMU, the block moves, the T
// flag, the CMOS additions, the timer and the three interrupt vectors.

import test from 'node:test';
import assert from 'node:assert/strict';
import { HuC6280, ZP_BASE, STACK_BASE, VEC_RESET, VEC_IRQ1, VEC_IRQ2, VEC_TIMER, VEC_NMI, FT, IRQ1, IRQ2, TIMER, TIMER_PERIOD_MASTER } from './huc6280.js';
import { FC, FZ, FI, FD, FN, FV } from './m6502.js';

// A flat 64KB bus with no MMU: the CPU's mpr is irrelevant because this bus
// never looks at it. That keeps the instruction tests about instructions.
function flatBus() {
  const mem = new Uint8Array(0x10000);
  let idle = 0;
  return {
    mem,
    read: (a) => mem[a & 0xffff],
    write: (a, v) => { mem[a & 0xffff] = v & 0xff; },
    idle: (n) => { idle += n; },
    get idleCycles() { return idle; },
  };
}

// Load a program at $E000, point the reset vector at it, and run n instructions.
function run(code, n = 1, setup = null) {
  const bus = flatBus();
  bus.mem.set(code, 0xe000);
  bus.mem[VEC_RESET] = 0x00; bus.mem[VEC_RESET + 1] = 0xe0;
  const cpu = new HuC6280(bus);
  cpu.reset();
  if (setup) setup(cpu, bus);
  for (let i = 0; i < n; i++) cpu.step();
  return { cpu, bus };
}

test('reset takes its vector from $FFFE, not $FFFC', () => {
  const bus = flatBus();
  bus.mem[0xfffe] = 0x34; bus.mem[0xffff] = 0x12;
  bus.mem[0xfffc] = 0xff; bus.mem[0xfffd] = 0xff;
  const cpu = new HuC6280(bus).reset();
  assert.equal(cpu.pc, 0x1234);
  assert.equal(cpu.mpr[7], 0x00, 'MPR7 comes up as bank 0 so $E000-$FFFF is the cartridge');
  assert.equal(cpu.fast, false, 'the console starts at 1.79MHz');
});

test('page zero lives at $2000 and the stack at $2100', () => {
  // LDA #$5A / STA $10 (zero page) / PHA
  const { cpu, bus } = run([0xa9, 0x5a, 0x85, 0x10, 0x48], 3);
  assert.equal(bus.mem[ZP_BASE | 0x10], 0x5a);
  assert.equal(bus.mem[0x0010], 0, 'nothing was written to the 6502 page zero');
  // reset() decrements S three times (the chip pushes with writes suppressed),
  // so the first push after a reset lands at $21FA, not $21FD.
  assert.equal(bus.mem[STACK_BASE | 0xfa], 0x5a);
  assert.equal(cpu.s, 0xf9);
});

test('(zp) indirect addressing reads its pointer out of $2000', () => {
  const { cpu } = run([0xb2, 0x40], 1, (c, bus) => {
    bus.mem[ZP_BASE | 0x40] = 0x00;
    bus.mem[ZP_BASE | 0x41] = 0x30;
    bus.mem[0x3000] = 0x77;
  });
  assert.equal(cpu.a, 0x77);
});

test('TAM sets every selected MPR, TMA reads one back', () => {
  // LDA #$F8 / TAM #$06  (MPR1 and MPR2) / LDA #$00 / TMA #$04
  const { cpu } = run([0xa9, 0xf8, 0x53, 0x06, 0xa9, 0x00, 0x43, 0x04], 4);
  assert.equal(cpu.mpr[1], 0xf8);
  assert.equal(cpu.mpr[2], 0xf8);
  assert.equal(cpu.mpr[0], 0x00);
  assert.equal(cpu.a, 0xf8, 'TMA #$04 reads MPR2');
});

test('CSL and CSH change the clock divider, not the cycle count', () => {
  const { cpu } = run([0xd4], 1);              // CSH
  assert.equal(cpu.fast, true);
  assert.equal(cpu.clockDiv, 3);
  const b = run([0xd4, 0x54], 2);              // CSH then CSL
  assert.equal(b.cpu.fast, false);
  assert.equal(b.cpu.clockDiv, 12);
});

test('SXY / SAX / SAY swap without touching the flags', () => {
  const { cpu } = run([0xa9, 0x01, 0xa2, 0x02, 0xa0, 0x03, 0x02], 4); // LDA/LDX/LDY/SXY
  assert.equal(cpu.x, 0x03);
  assert.equal(cpu.y, 0x02);
  const p = cpu.p;
  cpu.bus.mem[0xe007] = 0x22;                  // SAX
  cpu.step();
  assert.equal(cpu.a, 0x03);
  assert.equal(cpu.x, 0x01);
  assert.equal(cpu.p, p, 'the swaps leave the status register alone');
});

test('CLA / CLX / CLY clear without touching the flags', () => {
  const { cpu } = run([0xa9, 0x00, 0xa9, 0x80, 0x62], 3); // LDA #$00 / LDA #$80 / CLA
  assert.equal(cpu.a, 0);
  assert.equal(cpu.p & FN, FN, 'N still describes the LDA #$80, not the CLA');
});

test('ST0/ST1/ST2 go to the bus\'s video port, not to memory', () => {
  const seen = [];
  const bus = flatBus();
  bus.st = (port, v) => seen.push([port, v]);
  bus.mem.set([0x03, 0x05, 0x13, 0x80, 0x23, 0x00], 0xe000);
  bus.mem[VEC_RESET] = 0x00; bus.mem[VEC_RESET + 1] = 0xe0;
  const cpu = new HuC6280(bus).reset();
  cpu.step(); cpu.step(); cpu.step();
  assert.deepEqual(seen, [[0, 0x05], [1, 0x80], [2, 0x00]]);
});

test('BSR pushes the address of its last byte, like JSR', () => {
  // $E000: BSR +2 ; $E002: INX ; $E003: RTS -- target $E004: RTS
  const { cpu } = run([0x44, 0x02, 0xe8, 0x00, 0x60], 3);
  assert.equal(cpu.x, 1, 'RTS must come back to the INX, not skip it');
  // This is the bug the 1169-title sweep found: pushing the return address
  // instead of return-minus-one silently swallows one byte after every call.
});

test('TII copies forward and leaves A/X/Y alone', () => {
  const bus = flatBus();
  bus.mem.set([0x73, 0x00, 0x40, 0x00, 0x50, 0x04, 0x00], 0xe000); // TII $4000,$5000,4
  bus.mem[VEC_RESET] = 0x00; bus.mem[VEC_RESET + 1] = 0xe0;
  bus.mem.set([1, 2, 3, 4], 0x4000);
  const cpu = new HuC6280(bus).reset();
  cpu.a = 0xaa; cpu.x = 0xbb; cpu.y = 0xcc;
  const before = cpu.cycles;
  cpu.step();
  assert.deepEqual(Array.from(bus.mem.subarray(0x5000, 0x5004)), [1, 2, 3, 4]);
  assert.equal(cpu.a, 0xaa); assert.equal(cpu.x, 0xbb); assert.equal(cpu.y, 0xcc);
  assert.equal(cpu.cycles - before, 17 + 6 * 4, 'documented 17 + 6 per byte');
});

test('TDD copies backwards, TIN holds the destination, TIA/TAI alternate', () => {
  const mk = (op, src, dst, len) => [op, src & 0xff, src >> 8, dst & 0xff, dst >> 8, len & 0xff, len >> 8];
  {
    const bus = flatBus();
    bus.mem.set(mk(0xc3, 0x4003, 0x5003, 4), 0xe000);
    bus.mem[VEC_RESET] = 0x00; bus.mem[VEC_RESET + 1] = 0xe0;
    bus.mem.set([1, 2, 3, 4], 0x4000);
    const cpu = new HuC6280(bus).reset(); cpu.step();
    assert.deepEqual(Array.from(bus.mem.subarray(0x5000, 0x5004)), [1, 2, 3, 4]);
  }
  {
    const bus = flatBus();
    bus.mem.set(mk(0xd3, 0x4000, 0x5000, 4), 0xe000);  // TIN
    bus.mem[VEC_RESET] = 0x00; bus.mem[VEC_RESET + 1] = 0xe0;
    bus.mem.set([1, 2, 3, 4], 0x4000);
    const cpu = new HuC6280(bus).reset(); cpu.step();
    assert.equal(bus.mem[0x5000], 4, 'every byte went to the same address');
    assert.equal(bus.mem[0x5001], 0);
  }
  {
    const bus = flatBus();
    bus.mem.set(mk(0xe3, 0x4000, 0x5000, 4), 0xe000);  // TIA
    bus.mem[VEC_RESET] = 0x00; bus.mem[VEC_RESET + 1] = 0xe0;
    bus.mem.set([1, 2, 3, 4], 0x4000);
    const cpu = new HuC6280(bus).reset(); cpu.step();
    assert.deepEqual(Array.from(bus.mem.subarray(0x5000, 0x5002)), [3, 4],
      'the destination alternates between two addresses');
  }
  {
    const bus = flatBus();
    bus.mem.set(mk(0xf3, 0x4000, 0x5000, 4), 0xe000);  // TAI
    bus.mem[VEC_RESET] = 0x00; bus.mem[VEC_RESET + 1] = 0xe0;
    bus.mem.set([1, 2], 0x4000);
    const cpu = new HuC6280(bus).reset(); cpu.step();
    assert.deepEqual(Array.from(bus.mem.subarray(0x5000, 0x5004)), [1, 2, 1, 2],
      'the source alternates between two addresses');
  }
});

test('SET redirects the next ADC to $2000+X and lasts one instruction', () => {
  // SET / ADC #$05 / ADC #$01
  const { cpu, bus } = run([0xf4, 0x69, 0x05, 0x69, 0x01], 1, (c, b) => {
    c.x = 0x10;
    b.mem[ZP_BASE | 0x10] = 0x20;
  });
  assert.equal(cpu.p & FT, FT, 'SET arms the T flag');
  cpu.step();
  assert.equal(bus.mem[ZP_BASE | 0x10], 0x25, 'the memory byte was the accumulator');
  assert.equal(cpu.a, 0, 'A was not touched');
  assert.equal(cpu.p & FT, 0, 'T is consumed');
  cpu.step();
  assert.equal(cpu.a, 1, 'the next ADC is an ordinary one again');
});

test('TST tests memory against an immediate mask', () => {
  const { cpu } = run([0x93, 0x20, 0x00, 0x30], 1, (c, bus) => { bus.mem[0x3000] = 0xa0; });
  assert.equal(cpu.p & FZ, 0, '$A0 & $20 is not zero');
  assert.equal(cpu.p & FN, FN, 'N comes from bit 7 of the memory byte');
  assert.equal(cpu.p & FV, 0, 'V comes from bit 6 of the memory byte');
});

test('RMB/SMB/BBR/BBS work on page zero', () => {
  // SMB3 $10 / RMB0 $10 / BBS3 $10,+2 / (skipped) INX / INY
  const { cpu, bus } = run([0xb7, 0x10, 0x07, 0x10, 0xbf, 0x10, 0x01, 0xe8, 0xc8], 4, (c, b) => {
    b.mem[ZP_BASE | 0x10] = 0x01;
  });
  assert.equal(bus.mem[ZP_BASE | 0x10], 0x08, 'bit 3 set, bit 0 cleared');
  assert.equal(cpu.x, 0, 'the branch was taken, so the INX was skipped');
  assert.equal(cpu.y, 1);
});

test('TSB and TRB report the OLD state in Z only', () => {
  // LDA #$0F / TSB $20 / TRB $20
  const { cpu, bus } = run([0xa9, 0x0f, 0x04, 0x20, 0x14, 0x20], 2, (c, b) => {
    b.mem[ZP_BASE | 0x20] = 0xf0;
  });
  assert.equal(bus.mem[ZP_BASE | 0x20], 0xff);
  assert.equal(cpu.p & FZ, FZ, 'none of A\'s bits were set before TSB');
  cpu.step();
  assert.equal(bus.mem[ZP_BASE | 0x20], 0xf0);
  assert.equal(cpu.p & FZ, 0, 'they were all set before TRB');
});

test('STZ, INC A, DEC A, PHX/PLX, BRA, JMP (abs,X)', () => {
  const { cpu, bus } = run([0x64, 0x30, 0x1a, 0x3a, 0x3a], 4, null);
  assert.equal(bus.mem[ZP_BASE | 0x30], 0);
  assert.equal(cpu.a, 0xff, 'INC A then DEC A twice from zero wraps');
  const j = run([0x7c, 0x00, 0x40], 1, (c, b) => {
    c.x = 2;
    b.mem[0x4002] = 0x34; b.mem[0x4003] = 0x12;
  });
  assert.equal(j.cpu.pc, 0x1234);
  const br = run([0x80, 0x02, 0x00, 0x00, 0xe8], 2);
  assert.equal(br.cpu.x, 1, 'BRA is always taken');
});

test('JMP (abs) has the 65C02 fix, not the NMOS page-wrap bug', () => {
  const { cpu } = run([0x6c, 0xff, 0x30], 1, (c, b) => {
    b.mem[0x30ff] = 0x34; b.mem[0x3100] = 0x12; b.mem[0x3000] = 0xee;
  });
  assert.equal(cpu.pc, 0x1234);
});

test('bit 5 of P is the T flag, not a stuck 1', () => {
  // SET / PHP / PLA  -- the pushed byte must carry T
  const { cpu } = run([0xf4, 0x08, 0x68], 3);
  assert.equal(cpu.a & FT, FT);
  // and a plain PHP must not invent it
  const b = run([0x08, 0x68], 2);
  assert.equal(b.cpu.a & FT, 0);
});

test('the three maskable interrupts have three vectors, and $1402 gates them', () => {
  const mk = (vec, at) => {
    const bus = flatBus();
    bus.mem.set([0xea, 0xea, 0xea], 0xe000);
    bus.mem[VEC_RESET] = 0x00; bus.mem[VEC_RESET + 1] = 0xe0;
    bus.mem[vec] = at & 0xff; bus.mem[vec + 1] = at >> 8;
    return bus;
  };
  for (const [src, vec, target] of [[IRQ1, VEC_IRQ1, 0x1111], [IRQ2, VEC_IRQ2, 0x2222], [TIMER, VEC_TIMER, 0x3333]]) {
    const bus = mk(vec, target);
    const cpu = new HuC6280(bus).reset();
    cpu.p &= ~FI;
    cpu.setIrq(src, true);
    cpu.step();
    assert.equal(cpu.pc, target, `source ${src} uses its own vector`);
  }
  // masked off
  const bus = mk(VEC_IRQ1, 0x1111);
  const cpu = new HuC6280(bus).reset();
  cpu.p &= ~FI;
  cpu.ioWrite(0x1402, 1 << IRQ1);
  cpu.setIrq(IRQ1, true);
  cpu.step();
  assert.equal(cpu.pc, 0xe001, 'a masked source does not interrupt');
});

test('NMI has its own vector and BRK uses the IRQ2 one', () => {
  const bus = flatBus();
  bus.mem.set([0x00, 0x00], 0xe000);
  bus.mem[VEC_RESET] = 0x00; bus.mem[VEC_RESET + 1] = 0xe0;
  bus.mem[VEC_IRQ2] = 0x55; bus.mem[VEC_IRQ2 + 1] = 0x44;
  bus.mem[VEC_NMI] = 0x99; bus.mem[VEC_NMI + 1] = 0x88;
  bus.mem[0x4455] = 0xea;                    // the BRK handler: one NOP
  const cpu = new HuC6280(bus).reset();
  cpu.step();
  assert.equal(cpu.pc, 0x4455, 'BRK goes through $FFF6');
  assert.equal(cpu.p & FD, 0, 'entering an interrupt clears decimal');
  cpu.nmi();
  // An interrupt sequence does not poll for interrupts, so the handler's first
  // instruction always runs before the NMI is taken.
  cpu.step();
  assert.equal(cpu.pc, 0x4456);
  cpu.step();
  assert.equal(cpu.pc, 0x8899);
});

test('the timer counts master clocks and reloads on underflow', () => {
  const bus = flatBus();
  bus.mem[VEC_RESET] = 0x00; bus.mem[VEC_RESET + 1] = 0xe0;
  const cpu = new HuC6280(bus).reset();
  cpu.ioWrite(0x0c00, 2);          // reload = 2
  cpu.ioWrite(0x0c01, 1);          // start
  assert.equal(cpu.timerValue, 2, 'starting a stopped timer loads it');
  cpu.clockTimer(TIMER_PERIOD_MASTER);
  assert.equal(cpu.timerValue, 1);
  cpu.clockTimer(TIMER_PERIOD_MASTER);
  assert.equal(cpu.timerValue, 0);
  assert.equal(cpu.irqStatus & (1 << TIMER), 0, 'reaching zero is not the interrupt');
  cpu.clockTimer(TIMER_PERIOD_MASTER);
  assert.equal(cpu.irqStatus & (1 << TIMER), 1 << TIMER, 'stepping past zero is');
  assert.equal(cpu.timerValue, 2, 'and it reloads');
  cpu.ioWrite(0x1403, 0);          // acknowledge
  assert.equal(cpu.irqStatus & (1 << TIMER), 0);
});

test('decimal mode is CMOS: the flags describe the decimal result', () => {
  // SED / CLC / LDA #$09 / ADC #$01
  const { cpu } = run([0xf8, 0x18, 0xa9, 0x09, 0x69, 0x01], 4);
  assert.equal(cpu.a, 0x10);
  assert.equal(cpu.p & FZ, 0);
  // 0x99 + 0x01 = 0x00 with carry, and Z must be SET (an NMOS part would
  // compute Z from the binary 0x9A and leave it clear)
  const b = run([0xf8, 0x18, 0xa9, 0x99, 0x69, 0x01], 4);
  assert.equal(b.cpu.a, 0x00);
  assert.equal(b.cpu.p & FZ, FZ);
  assert.equal(b.cpu.p & FC, FC);
});

test('read-modify-write does not write twice', () => {
  const writes = [];
  const bus = flatBus();
  const w = bus.write;
  bus.write = (a, v) => { writes.push(a); w(a, v); };
  bus.mem.set([0xee, 0x00, 0x30], 0xe000);     // INC $3000
  bus.mem[VEC_RESET] = 0x00; bus.mem[VEC_RESET + 1] = 0xe0;
  const cpu = new HuC6280(bus).reset();
  writes.length = 0;
  cpu.step();
  assert.deepEqual(writes, [0x3000], 'a CMOS core spends an internal cycle, not a second write');
  assert.equal(bus.mem[0x3000], 1);
});

test('every one of the 256 opcodes decodes and terminates', () => {
  for (let op = 0; op < 256; op++) {
    const bus = flatBus();
    // Fill with the opcode plus plausible operands, and give the block moves a
    // length of one so they finish.
    bus.mem.fill(0x01, 0xe000, 0xe100);
    bus.mem[0xe000] = op;
    bus.mem[0xe005] = 0x01; bus.mem[0xe006] = 0x00;
    bus.mem[VEC_RESET] = 0x00; bus.mem[VEC_RESET + 1] = 0xe0;
    const cpu = new HuC6280(bus).reset();
    const before = cpu.cycles;
    cpu.step();
    assert.ok(cpu.cycles > before, `opcode $${op.toString(16)} spent no cycles`);
    assert.equal(cpu.jammed, false, `opcode $${op.toString(16)} jammed; a CMOS part has no JAM`);
  }
});

test('getState/setState round-trips the MMU, the speed and the timer', () => {
  const { cpu } = run([0xd4, 0xa9, 0x77, 0x53, 0xff], 3);
  cpu.ioWrite(0x0c00, 0x33);
  cpu.ioWrite(0x0c01, 1);
  cpu.setIrq(IRQ1, true);
  const s = JSON.parse(JSON.stringify(cpu.getState()));
  const bus2 = flatBus();
  const other = new HuC6280(bus2);
  other.setState(s);
  assert.deepEqual(Array.from(other.mpr), Array.from(cpu.mpr));
  assert.equal(other.fast, cpu.fast);
  assert.equal(other.timerReload, cpu.timerReload);
  assert.equal(other.timerRun, cpu.timerRun);
  assert.equal(other.irqStatus, cpu.irqStatus);
  assert.equal(other.irqLine, cpu.irqLine);
});

test('the same program run twice produces the same state (determinism)', () => {
  const prog = [0xd4, 0xa9, 0x12, 0x85, 0x10, 0xa2, 0x08, 0xca, 0xd0, 0xfd, 0x1a, 0x80, 0xf5];
  const a = run(prog, 500).cpu.getState();
  const b = run(prog, 500).cpu.getState();
  assert.deepEqual(a, b);
});
