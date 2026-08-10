import test from 'node:test';
import assert from 'node:assert/strict';
import { M68000, BusError, VEC, SCHEMA_VERSION } from './m68000.js';

// A 68000 test machine: 1 MiB of RAM behind a 16-bit bus, exactly the shape a
// Mega Drive or X68000 port injects. Word/long accesses are split by the core,
// so the counters below see the same transaction count as real pins would.
function mkMachine(program = [], org = 0x1000, opts = {}) {
  const mem = new Uint8Array(0x100000);
  for (let i = 0; i < program.length; i++) {
    mem[(org + i * 2) & 0xfffff] = (program[i] >> 8) & 0xff;
    mem[(org + i * 2 + 1) & 0xfffff] = program[i] & 0xff;
  }
  const log = { reads: 0, writes: 0, ack: [] };
  const bus = {
    read16(a) { log.reads++; a &= 0xfffff; return (mem[a] << 8) | mem[a + 1]; },
    write16(a, v) { log.writes++; a &= 0xfffff; mem[a] = (v >> 8) & 0xff; mem[a + 1] = v & 0xff; },
    ...opts,
  };
  // Reset vectors: SSP = 0x8000, PC = org.
  const put32 = (a, v) => { for (let i = 0; i < 4; i++) mem[a + i] = (v >>> ((3 - i) * 8)) & 0xff; };
  put32(0, 0x8000);
  put32(4, org);
  const cpu = new M68000(bus);
  return { cpu, mem, bus, log, put32, org };
}

const rd32 = (mem, a) => ((mem[a] << 24) | (mem[a + 1] << 16) | (mem[a + 2] << 8) | mem[a + 3]) >>> 0;
const CCR = { C: 1, V: 2, Z: 4, N: 8, X: 16 };

test('m68000: reset loads SSP and PC from the vector table', () => {
  const { cpu } = mkMachine([0x4e71], 0x1000);
  assert.equal(cpu.a[7], 0x8000);
  assert.equal(cpu.pc, 0x1000);
  assert.equal(cpu.sr_s, 1, 'reset enters supervisor mode');
  assert.equal(cpu.sr_ipm, 7, 'reset masks all interrupts');
});

test('m68000: MOVE sets N/Z and clears V/C, MOVEA touches nothing', () => {
  const { cpu } = mkMachine([
    0x203c, 0xffff, 0x8000, // MOVE.L #FFFF8000,D0  -> N
    0x223c, 0x0000, 0x0000, // MOVE.L #0,D1         -> Z
    0x207c, 0xffff, 0x8000, // MOVEA.L #FFFF8000,A0 -> flags untouched
  ]);
  cpu.setCCR(CCR.C | CCR.V);
  cpu.step();
  assert.equal(cpu.d[0], 0xffff8000);
  assert.equal(cpu.getCCR(), CCR.N, 'MOVE clears V and C');
  cpu.step();
  assert.equal(cpu.getCCR(), CCR.Z);
  cpu.setCCR(CCR.C | CCR.V | CCR.Z);
  cpu.step();
  assert.equal(cpu.a[0], 0xffff8000, 'MOVEA sign-extends nothing for long');
  assert.equal(cpu.getCCR(), CCR.C | CCR.V | CCR.Z, 'MOVEA leaves the CCR alone');
});

test('m68000: MOVEA.W sign-extends into the full 32 bits', () => {
  const { cpu } = mkMachine([0x307c, 0x8001]); // MOVEA.W #8001,A0
  cpu.step();
  assert.equal(cpu.a[0], 0xffff8001);
});

// Carry and overflow are the classic place a 68000 core goes wrong: overflow is
// about signed range, carry about unsigned range, and they disagree constantly.
test('m68000: ADD/SUB carry and overflow disagree in the right places', () => {
  const { cpu } = mkMachine([
    0x103c, 0x007f, 0x0600, 0x0001, // MOVE.B #7F,D0 ; ADDI.B #1,D0 -> V, no C
    0x103c, 0x00ff, 0x0600, 0x0001, // MOVE.B #FF,D0 ; ADDI.B #1,D0 -> C+Z, no V
    0x103c, 0x0080, 0x0400, 0x0001, // MOVE.B #80,D0 ; SUBI.B #1,D0 -> V, no C
    0x103c, 0x0000, 0x0400, 0x0001, // MOVE.B #0,D0  ; SUBI.B #1,D0 -> C+N, no V
  ]);
  cpu.step(); cpu.step();
  assert.equal(cpu.d[0] & 0xff, 0x80);
  assert.equal(cpu.getCCR(), CCR.N | CCR.V);
  cpu.step(); cpu.step();
  assert.equal(cpu.d[0] & 0xff, 0x00);
  assert.equal(cpu.getCCR(), CCR.Z | CCR.C | CCR.X);
  cpu.step(); cpu.step();
  assert.equal(cpu.d[0] & 0xff, 0x7f);
  assert.equal(cpu.getCCR(), CCR.V);
  cpu.step(); cpu.step();
  assert.equal(cpu.d[0] & 0xff, 0xff);
  assert.equal(cpu.getCCR(), CCR.N | CCR.C | CCR.X);
});

test('m68000: ADDX/SUBX chain multi-precision and only ever clear Z', () => {
  const { cpu } = mkMachine([
    0x203c, 0x0000, 0x0000, // MOVE.L #0,D0
    0x223c, 0x0000, 0x0000, // MOVE.L #0,D1
    0xd380,                 // ADDX.L D0,D1  (X=1 from the caller)
  ]);
  cpu.step(); cpu.step();
  cpu.fz = 1; cpu.fx = 1;
  cpu.step();
  assert.equal(cpu.d[1], 1);
  assert.equal(cpu.fz, 0, 'a non-zero result clears Z');
  assert.equal(cpu.fx, 0);
  // and the zero case leaves Z as it found it
  cpu.d[0] = 0; cpu.d[1] = 0; cpu.pc = 0x1006; cpu.fz = 1; cpu.fx = 0;
  cpu.step();
  assert.equal(cpu.d[1], 0);
  assert.equal(cpu.fz, 1, 'a zero result leaves Z untouched');
});

test('m68000: CMP does not disturb X', () => {
  const { cpu } = mkMachine([0x0c00, 0x0001]); // CMPI.B #1,D0
  cpu.d[0] = 0;
  cpu.fx = 1;
  cpu.step();
  assert.equal(cpu.fc, 1, 'borrow sets C');
  assert.equal(cpu.fx, 1, 'but never X');
});

test('m68000: ASL sets V when the sign changes anywhere during the shift', () => {
  const { cpu } = mkMachine([
    0xe300, // ASL.B #1,D0
    0xe300, // ASL.B #1,D0
  ]);
  cpu.d[0] = 0x40;
  cpu.step();
  assert.equal(cpu.d[0] & 0xff, 0x80);
  assert.equal(cpu.fv, 1, '40 -> 80 flips the sign');
  cpu.d[0] = 0xc0;
  cpu.pc = 0x1000;
  cpu.step();
  assert.equal(cpu.d[0] & 0xff, 0x80);
  assert.equal(cpu.fv, 0, 'C0 -> 80 keeps the sign');
  assert.equal(cpu.fc, 1);
});

test('m68000: shifts of zero places leave X alone; ROXL of zero copies X into C', () => {
  const { cpu } = mkMachine([
    0xe0a8, // LSR.L D0,D0  (count from D0)
    0xe1b0, // ROXL.L D0,D0
  ]);
  cpu.d[0] = 0;
  cpu.fx = 1; cpu.fc = 0;
  cpu.step();
  assert.equal(cpu.fx, 1, 'zero shift count keeps X');
  assert.equal(cpu.fc, 0, 'and clears C');
  cpu.d[0] = 0; cpu.fx = 1; cpu.fc = 0;
  cpu.step();
  assert.equal(cpu.fc, 1, 'ROXL #0 reports X in C');
  assert.equal(cpu.fx, 1);
});

test('m68000: ROL/ROR never touch X', () => {
  const { cpu } = mkMachine([0xe19f]); // ROL.L #8,D7
  cpu.d[7] = 0x12345678;
  cpu.fx = 1;
  cpu.step();
  assert.equal(cpu.d[7], 0x34567812);
  assert.equal(cpu.fx, 1);
});

test('m68000: BCD add and subtract, including the correction that borrows out', () => {
  const { cpu } = mkMachine([0xc300, 0x8300]); // ABCD D0,D1 ; SBCD D0,D1
  cpu.d[0] = 0x19; cpu.d[1] = 0x28; cpu.fx = 0;
  cpu.step();
  assert.equal(cpu.d[1] & 0xff, 0x47, '28 + 19 = 47');
  assert.equal(cpu.fc, 0);
  // B2 - AD: the low-digit correction underflows the byte and that sets carry
  cpu.d[0] = 0xad; cpu.d[1] = 0xb2; cpu.fx = 0;
  cpu.step();
  assert.equal(cpu.d[1] & 0xff, 0xff);
  assert.equal(cpu.fc, 1);
  assert.equal(cpu.fx, 1);
});

test('m68000: MULS/MULU sign handling and DIVU/DIVS quotient placement', () => {
  const { cpu } = mkMachine([
    0xc1c1, // MULS.W D1,D0
    0xc0c1, // MULU.W D1,D0
    0x80c1, // DIVU.W D1,D0
    0x81c1, // DIVS.W D1,D0
  ]);
  cpu.d[0] = 0xffff; cpu.d[1] = 0x0002; // -1 * 2
  cpu.step();
  assert.equal(cpu.d[0], 0xfffffffe);
  cpu.d[0] = 0xffff; cpu.d[1] = 0x0002; // 65535 * 2
  cpu.step();
  assert.equal(cpu.d[0], 0x0001fffe);
  cpu.d[0] = 0x00000045; cpu.d[1] = 0x0010; // 69 / 16 = 4 rem 5
  cpu.step();
  assert.equal(cpu.d[0] & 0xffff, 4, 'quotient in the low word');
  assert.equal(cpu.d[0] >>> 16, 5, 'remainder in the high word');
  cpu.d[0] = 0xffffffbb; cpu.d[1] = 0x0010; // -69 / 16 = -4 rem -5
  cpu.step();
  assert.equal((cpu.d[0] & 0xffff) << 16 >> 16, -4);
  assert.equal((cpu.d[0] >>> 16) << 16 >> 16, -5, 'remainder takes the dividend sign');
});

test('m68000: DIVU by zero traps through vector 5 and leaves the register alone', () => {
  const { cpu, put32 } = mkMachine([0x80c1]); // DIVU.W D1,D0
  put32(VEC.ZERO_DIVIDE * 4, 0x2000);
  cpu.d[0] = 0x1234; cpu.d[1] = 0;
  cpu.step();
  assert.equal(cpu.pc, 0x2000);
  assert.equal(cpu.d[0], 0x1234);
});

test('m68000: DIVU overflow sets V and leaves the destination unchanged', () => {
  const { cpu } = mkMachine([0x80c1]);
  cpu.d[0] = 0xffffffff; cpu.d[1] = 1;
  cpu.step();
  assert.equal(cpu.fv, 1);
  assert.equal(cpu.d[0], 0xffffffff);
});

test('m68000: addressing modes reach the right words', () => {
  const { cpu, mem } = mkMachine([
    0x2039, 0x0000, 0x2000, // MOVE.L (00002000).L,D0
    0x2028, 0x0004,         // MOVE.L (4,A0),D0
    0x2030, 0x0004,         // MOVE.L (4,A0,D0.W),D0   [brief extension]
    0x203a, 0x0002,         // MOVE.L (2,PC),D0
  ]);
  const put = (a, v) => { for (let i = 0; i < 4; i++) mem[a + i] = (v >>> ((3 - i) * 8)) & 0xff; };
  put(0x2000, 0xcafebabe);
  cpu.step();
  assert.equal(cpu.d[0], 0xcafebabe);
  cpu.a[0] = 0x1ffc;
  put(0x2000, 0x11223344);
  cpu.step();
  assert.equal(cpu.d[0], 0x11223344);
  cpu.a[0] = 0x2000; cpu.d[0] = 0x0010;
  put(0x2014, 0x55667788);
  cpu.step();
  assert.equal(cpu.d[0], 0x55667788, '(4,A0,D0.W) = 2000+4+10');
});

test('m68000: -(A7)/(A7)+ move the stack by two even for byte operands', () => {
  const { cpu } = mkMachine([0x1f00, 0x101f]); // MOVE.B D0,-(A7) ; MOVE.B (A7)+,D0
  cpu.a[7] = 0x4000;
  cpu.d[0] = 0x5a;
  cpu.step();
  assert.equal(cpu.a[7], 0x3ffe, 'byte push still keeps A7 even');
  cpu.step();
  assert.equal(cpu.a[7], 0x4000);
  assert.equal(cpu.d[0] & 0xff, 0x5a);
});

test('m68000: MOVEM stores predecrement in reverse and restores in order', () => {
  const { cpu, mem } = mkMachine([
    0x48e7, 0xc000, // MOVEM.L D0-D1,-(A7)
    0x4cdf, 0x0003, // MOVEM.L (A7)+,D0-D1
  ]);
  cpu.a[7] = 0x4000;
  cpu.d[0] = 0x11111111; cpu.d[1] = 0x22222222;
  cpu.step();
  assert.equal(cpu.a[7], 0x3ff8);
  assert.equal(rd32(mem, 0x3ff8), 0x11111111, 'D0 ends up lowest');
  assert.equal(rd32(mem, 0x3ffc), 0x22222222);
  cpu.d[0] = 0; cpu.d[1] = 0;
  cpu.step();
  assert.equal(cpu.d[0], 0x11111111);
  assert.equal(cpu.d[1], 0x22222222);
  assert.equal(cpu.a[7], 0x4000);
});

test('m68000: MOVEM.W sign-extends into the full register', () => {
  const { cpu, mem } = mkMachine([0x4c98, 0x0001]); // MOVEM.W (A0)+,D0
  mem[0x2000] = 0x80; mem[0x2001] = 0x00;
  cpu.a[0] = 0x2000;
  cpu.step();
  assert.equal(cpu.d[0], 0xffff8000);
  assert.equal(cpu.a[0], 0x2002);
});

test('m68000: MOVEP walks every other byte', () => {
  const { cpu, mem } = mkMachine([0x01c8, 0x0000]); // MOVEP.L D0,(0,A0)
  cpu.a[0] = 0x2000;
  cpu.d[0] = 0xdeadbeef;
  cpu.step();
  assert.equal(mem[0x2000], 0xde);
  assert.equal(mem[0x2002], 0xad);
  assert.equal(mem[0x2004], 0xbe);
  assert.equal(mem[0x2006], 0xef);
  assert.equal(mem[0x2001], 0, 'the odd bytes are untouched');
});

test('m68000: DBcc loops until the counter passes zero', () => {
  const { cpu } = mkMachine([
    0x5200,         // ADDQ.B #1,D0
    0x51c9, 0xfffc, // DBF D1,-4
  ]);
  cpu.d[0] = 0; cpu.d[1] = 3;
  for (let i = 0; i < 8; i++) cpu.step();
  assert.equal(cpu.d[0] & 0xff, 4, 'the body runs count+1 times');
  assert.equal(cpu.d[1] & 0xffff, 0xffff, 'and the counter ends at -1');
});

test('m68000: Scc writes all ones or all zeros', () => {
  const { cpu } = mkMachine([0x57c0, 0x56c0]); // SEQ D0 ; SNE D0
  cpu.fz = 1;
  cpu.step();
  assert.equal(cpu.d[0] & 0xff, 0xff);
  cpu.step();
  assert.equal(cpu.d[0] & 0xff, 0x00);
});

test('m68000: LINK/UNLK build and tear down a frame', () => {
  const { cpu } = mkMachine([
    0x4e56, 0xfff0, // LINK A6,#-16
    0x4e5e,         // UNLK A6
  ]);
  cpu.a[7] = 0x4000; cpu.a[6] = 0x12345678;
  cpu.step();
  assert.equal(cpu.a[6], 0x3ffc);
  assert.equal(cpu.a[7], 0x3fec);
  cpu.step();
  assert.equal(cpu.a[7], 0x4000);
  assert.equal(cpu.a[6], 0x12345678);
});

test('m68000: EXG swaps across register files', () => {
  const { cpu } = mkMachine([0xc188, 0xc141, 0xc34d]); // EXG D0,A0 ; EXG D0,D1 ; EXG A1,A5
  cpu.d[0] = 1; cpu.a[0] = 2;
  cpu.step();
  assert.equal(cpu.d[0], 2); assert.equal(cpu.a[0], 1);
  cpu.d[0] = 3; cpu.d[1] = 4;
  cpu.step();
  assert.equal(cpu.d[0], 4); assert.equal(cpu.d[1], 3);
  cpu.a[1] = 5; cpu.a[5] = 6;
  cpu.step();
  assert.equal(cpu.a[1], 6); assert.equal(cpu.a[5], 5);
});

// ---- exceptions -------------------------------------------------------------

test('m68000: an odd word access raises an address error with a seven-word frame', () => {
  const { cpu, mem, put32 } = mkMachine([0x3010]); // MOVE.W (A0),D0
  put32(VEC.ADDRESS_ERROR * 4, 0x3000);
  cpu.a[0] = 0x2001;
  cpu.a[7] = 0x4000;
  cpu.step();
  assert.equal(cpu.pc, 0x3000, 'vectored through 3');
  assert.equal(cpu.a[7], 0x4000 - 14, 'group-0 frames are 14 bytes');
  const ssw = (mem[0x3ff2] << 8) | mem[0x3ff3];
  assert.equal(ssw & 0x10, 0x10, 'R/W bit says read');
  assert.equal(ssw & 0x07, 0x05, 'function code: supervisor data');
  assert.equal(ssw & 0xffe0, 0x3010 & 0xffe0, 'the upper bits carry the opcode');
  assert.equal(rd32(mem, 0x3ff4), 0x2001, 'the faulting address');
  assert.equal((mem[0x3ff8] << 8) | mem[0x3ff9], 0x3010, 'the instruction register');
});

test('m68000: an odd branch target faults inside the branch', () => {
  const { cpu, put32 } = mkMachine([0x4ed0]); // JMP (A0)
  put32(VEC.ADDRESS_ERROR * 4, 0x3000);
  cpu.a[0] = 0x2001;
  cpu.a[7] = 0x4000;
  cpu.step();
  assert.equal(cpu.pc, 0x3000);
  assert.equal(cpu.a[7], 0x4000 - 14);
});

test('m68000: illegal, line-A and line-F each take their own vector', () => {
  for (const [op, vec] of [[0x4afc, VEC.ILLEGAL], [0xa000, VEC.LINE_A], [0xf000, VEC.LINE_F]]) {
    const { cpu, mem } = mkMachine([op]);
    for (let i = 0; i < 4; i++) mem[vec * 4 + i] = [0, 0, 0x30, 0][i];
    cpu.a[7] = 0x4000;
    cpu.step();
    assert.equal(cpu.pc, 0x3000, `vector ${vec}`);
    // stacked PC is the address of the offending instruction, not the next one
    assert.equal(rd32(mem, 0x3ffc), 0x1000);
  }
});

test('m68000: privileged instructions trap from user mode without executing', () => {
  const { cpu, mem, put32 } = mkMachine([0x46fc, 0x2700]); // MOVE #2700,SR
  put32(VEC.PRIVILEGE * 4, 0x3000);
  cpu.setSR(0x0000); // user mode
  cpu.a[7] = 0x5000; // USP
  cpu.ssp = 0x4000;
  cpu.step();
  assert.equal(cpu.pc, 0x3000);
  assert.equal(cpu.sr_s, 1, 'the handler runs supervisor');
  assert.equal(cpu.a[7], 0x4000 - 6, 'the frame goes on the supervisor stack');
  assert.equal(cpu.usp, 0x5000, 'the user stack is untouched');
  assert.equal(rd32(mem, 0x3ffc), 0x1000, 'stacked PC points at the instruction');
});

test('m68000: TRAP #n vectors to 32+n and stacks the following instruction', () => {
  const { cpu, mem, put32 } = mkMachine([0x4e43, 0x4e71]); // TRAP #3 ; NOP
  put32((VEC.TRAP + 3) * 4, 0x3000);
  cpu.a[7] = 0x4000;
  cpu.step();
  assert.equal(cpu.pc, 0x3000);
  assert.equal(rd32(mem, 0x3ffc), 0x1002);
});

test('m68000: TRAPV only traps when V is set', () => {
  const { cpu, put32 } = mkMachine([0x4e76, 0x4e76]);
  put32(VEC.TRAPV * 4, 0x3000);
  cpu.a[7] = 0x4000;
  cpu.fv = 0;
  assert.equal(cpu.step(), 4);
  assert.equal(cpu.pc, 0x1002);
  cpu.fv = 1;
  cpu.step();
  assert.equal(cpu.pc, 0x3000);
});

test('m68000: CHK traps outside the bounds and reports the sign in N', () => {
  const { cpu, put32 } = mkMachine([0x4181, 0x4181]); // CHK.W D1,D0
  put32(VEC.CHK * 4, 0x3000);
  cpu.a[7] = 0x4000;
  cpu.d[0] = 5; cpu.d[1] = 10;
  cpu.step();
  assert.equal(cpu.pc, 0x1002, 'in range: no trap');
  assert.equal(cpu.fn, 0);
  cpu.d[0] = 0xffff; // -1
  cpu.step();
  assert.equal(cpu.pc, 0x3000);
  assert.equal(cpu.fn, 1, 'N reports the negative operand');
});

test('m68000: trace fires after the traced instruction, not before', () => {
  const { cpu, mem, put32 } = mkMachine([0x4e71, 0x4e71]); // NOP ; NOP
  put32(VEC.TRACE * 4, 0x3000);
  cpu.a[7] = 0x4000;
  cpu.sr_t = 1;
  cpu.step();
  assert.equal(cpu.pc, 0x1002, 'the NOP runs first');
  cpu.step();
  assert.equal(cpu.pc, 0x3000, 'then the trace exception');
  assert.equal(rd32(mem, 0x3ffc), 0x1002, 'stacked PC is the next instruction');
  assert.equal(cpu.sr_t, 0, 'the handler is not itself traced');
});

test('m68000: a bus error thrown by the bus becomes a group-0 exception', () => {
  const { cpu, mem, bus, put32 } = mkMachine([0x3010]); // MOVE.W (A0),D0
  const inner = bus.read16;
  bus.read16 = (a) => {
    if ((a & 0xfffff) === 0x2000) throw new BusError(0x2000, false);
    return inner(a);
  };
  put32(VEC.BUS_ERROR * 4, 0x3000);
  cpu.a[0] = 0x2000;
  cpu.a[7] = 0x4000;
  cpu.step();
  assert.equal(cpu.pc, 0x3000);
  assert.equal(cpu.a[7], 0x4000 - 14);
  assert.equal(rd32(mem, 0x3ff4), 0x2000);
});

// ---- interrupts -------------------------------------------------------------

test('m68000: interrupts autovector, respect the mask, and raise it', () => {
  const { cpu, put32 } = mkMachine([0x4e71, 0x4e71, 0x4e71]);
  put32((VEC.AUTOVECTOR + 4 - 1) * 4, 0x3000); // level 4 -> vector 28
  cpu.a[7] = 0x4000;
  cpu.sr_ipm = 5;
  cpu.setIRQ(4);
  cpu.step();
  assert.equal(cpu.pc, 0x1002, 'level 4 does not beat a mask of 5');
  cpu.sr_ipm = 3;
  cpu.step();
  assert.equal(cpu.pc, 0x3000, 'now it gets in');
  assert.equal(cpu.sr_ipm, 4, 'and the mask rises to its level');
  assert.equal(cpu.sr_s, 1);
});

test('m68000: a peripheral can answer the acknowledge with its own vector', () => {
  const { cpu, put32 } = mkMachine([0x4e71], 0x1000, { irqAck: () => 0x40 });
  put32(0x40 * 4, 0x3800);
  cpu.a[7] = 0x4000;
  cpu.sr_ipm = 0;
  cpu.setIRQ(2);
  cpu.step();
  assert.equal(cpu.pc, 0x3800);
});

test('m68000: level 7 is edge triggered so a stuck line does not loop', () => {
  const { cpu, put32 } = mkMachine([0x4e71, 0x4e71, 0x4e71]);
  put32((VEC.AUTOVECTOR + 6) * 4, 0x3000); // vector 31
  cpu.a[7] = 0x4000;
  cpu.sr_ipm = 7;
  cpu.setIRQ(7);
  cpu.step();
  assert.equal(cpu.pc, 0x3000, 'the edge gets through the mask');
  const sp = cpu.a[7];
  cpu.pc = 0x1000;
  cpu.step();
  assert.equal(cpu.a[7], sp, 'a level that never drops does not stack a second frame');
  assert.equal(cpu.pc, 0x1002, 'the handler just keeps running');
});

test('m68000: STOP halts until an interrupt, and is privileged', () => {
  const { cpu, put32 } = mkMachine([0x4e72, 0x2000, 0x4e71]);
  put32((VEC.AUTOVECTOR + 3) * 4, 0x3000); // level 4
  cpu.a[7] = 0x4000;
  cpu.step();
  assert.equal(cpu.stopped, true);
  assert.equal(cpu.sr_ipm, 0, 'STOP loaded the new SR');
  const before = cpu.pc;
  cpu.step();
  assert.equal(cpu.pc, before, 'stopped means stopped');
  cpu.setIRQ(4);
  cpu.step();
  assert.equal(cpu.stopped, false);
  assert.equal(cpu.pc, 0x3000);
});

test('m68000: RTE restores SR and PC, and can drop back to user mode', () => {
  const { cpu, mem } = mkMachine([0x4e73]); // RTE
  cpu.a[7] = 0x4000;
  mem[0x4000] = 0x00; mem[0x4001] = 0x00; // SR = 0 -> user
  mem[0x4002] = 0x00; mem[0x4003] = 0x00; mem[0x4004] = 0x20; mem[0x4005] = 0x00; // PC
  cpu.usp = 0x5000;
  cpu.step();
  assert.equal(cpu.pc, 0x2000);
  assert.equal(cpu.sr_s, 0);
  assert.equal(cpu.a[7], 0x5000, 'A7 is now the user stack pointer');
});

test('m68000: USP and SSP swap with the S bit', () => {
  const { cpu } = mkMachine([0x4e71]);
  cpu.setSR(0x2000); // supervisor
  cpu.a[7] = 0x8000;
  cpu.usp = 0x5000;
  assert.equal(cpu.ssp, 0x8000);
  cpu.setSR(0x0000); // to user
  assert.equal(cpu.a[7], 0x5000);
  assert.equal(cpu.ssp, 0x8000);
  cpu.setSR(0x2000);
  assert.equal(cpu.a[7], 0x8000);
  assert.equal(cpu.usp, 0x5000);
});

test('m68000: MOVE from SR is readable in user mode (a 68000, not a 68010)', () => {
  const { cpu } = mkMachine([0x40c0]); // MOVE SR,D0
  cpu.setSR(0x0004);
  cpu.step();
  assert.equal(cpu.d[0] & 0xffff, 0x0004);
});

// ---- cycle counts -----------------------------------------------------------

test('m68000: instruction times follow the manual tables', () => {
  const cases = [
    [[0x4e71], 4, 'NOP'],
    [[0x7001], 4, 'MOVEQ'],
    [[0x2000], 4, 'MOVE.L D0,D0'],
    [[0x2010], 12, 'MOVE.L (A0),D0'],
    [[0x2080], 12, 'MOVE.L D0,(A0)'],
    [[0xd041], 4, 'ADD.W D1,D0'],
    [[0xd081], 8, 'ADD.L D1,D0'],
    [[0xd050], 8, 'ADD.W (A0),D0'],
    [[0x4840], 4, 'SWAP D0'],
    [[0x4e50, 0x0000], 16, 'LINK A0,#0'],
    [[0x4e58], 12, 'UNLK A0'],
    [[0x4e75], 16, 'RTS'],
    [[0x4e90], 16, 'JSR (A0)'],
    [[0x4ed0], 8, 'JMP (A0)'],
    [[0x41d0], 4, 'LEA (A0),A0'],
    [[0xe388], 10, 'LSL.L #1,D0'],
  ];
  for (const [prog, want, name] of cases) {
    const { cpu } = mkMachine(prog);
    cpu.a[7] = 0x4000;
    assert.equal(cpu.step(), want, name);
  }
});

test('m68000: shift time grows two cycles per bit', () => {
  const { cpu } = mkMachine([0xe188]); // LSL.L #8,D0
  assert.equal(cpu.step(), 8 + 2 * 8);
});

test('m68000: MULU time depends on the number of set bits in the source', () => {
  const a = mkMachine([0xc0c1]); // MULU.W D1,D0
  a.cpu.d[1] = 0x0000;
  assert.equal(a.cpu.step(), 38, 'no set bits');
  const b = mkMachine([0xc0c1]);
  b.cpu.d[1] = 0xffff;
  assert.equal(b.cpu.step(), 38 + 32, 'sixteen set bits');
});

// ---- determinism / snapshot --------------------------------------------------

const DETERMINISM_PROGRAM = [
  0x203c, 0x1234, 0x5678, // MOVE.L #12345678,D0
  0x223c, 0x0000, 0x00ff, // MOVE.L #FF,D1
  0xc0c1,                 // MULU.W D1,D0
  0xe388,                 // LSL.L #1,D0
  0x2200,                 // MOVE.L D0,D1
  0x0681, 0x0000, 0x1111, // ADDI.L #1111,D1
  0x2f01,                 // MOVE.L D1,-(A7)
  0x241f,                 // MOVE.L (A7)+,D2
  0x4841,                 // SWAP D1
  0x60f0,                 // BRA -16
];

function runN(n) {
  const { cpu, mem } = mkMachine(DETERMINISM_PROGRAM);
  cpu.a[7] = 0x4000;
  for (let i = 0; i < n; i++) cpu.step();
  return { snap: cpu.snapshot(), mem: Buffer.from(mem.subarray(0x3f00, 0x4000)) };
}

test('m68000: the same program twice gives bit-identical state', () => {
  const a = runN(200), b = runN(200);
  assert.deepEqual(a.snap, b.snap);
  assert.deepEqual(a.mem, b.mem);
});

test('m68000: snapshot/restore round-trips and resumes identically', () => {
  const { cpu, mem } = mkMachine(DETERMINISM_PROGRAM);
  cpu.a[7] = 0x4000;
  for (let i = 0; i < 37; i++) cpu.step();
  const snap = cpu.snapshot();
  const memAt = Buffer.from(mem.subarray(0x3f00, 0x4000));

  // run ahead, then rewind and run the same distance again
  for (let i = 0; i < 60; i++) cpu.step();
  const ahead = cpu.snapshot();
  cpu.restore(snap);
  mem.set(memAt, 0x3f00);
  assert.deepEqual(cpu.snapshot(), snap, 'restore is the exact inverse');
  for (let i = 0; i < 60; i++) cpu.step();
  assert.deepEqual(cpu.snapshot(), ahead, 'and replay lands in the same place');
});

test('m68000: a snapshot is plain data, versioned, and carries no ROM', () => {
  const { cpu } = mkMachine(DETERMINISM_PROGRAM);
  const s = cpu.snapshot();
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  assert.equal(JSON.parse(JSON.stringify(s)).pc, s.pc, 'survives a JSON round trip');
  const bytes = JSON.stringify(s).length;
  assert.ok(bytes < 512, `snapshot should stay tiny for rewind buffers, got ${bytes} bytes`);
  for (const v of Object.values(s)) {
    assert.ok(typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v),
      'no typed arrays, no references to memory');
  }
});

test('m68000: a bus with only read16/write16 gets byte access synthesized', () => {
  const mem = new Uint8Array(0x10000);
  mem[0] = 0; mem[1] = 0; mem[2] = 0; mem[3] = 0x10; // reset vectors
  mem[7] = 0x00;
  const bus = {
    read16: (a) => ((mem[a & 0xffff] << 8) | mem[(a + 1) & 0xffff]),
    write16: (a, v) => { mem[a & 0xffff] = (v >> 8) & 0xff; mem[(a + 1) & 0xffff] = v & 0xff; },
  };
  const cpu = new M68000(bus);
  assert.equal(typeof bus.read8, 'undefined', 'the caller object is never mutated');
  // MOVE.B D0,(A0) with an odd destination has to hit the low byte only
  mem[0x1000] = 0x10; mem[0x1001] = 0x80; // MOVE.B D0,(A0)
  mem[0x2000] = 0xaa; mem[0x2001] = 0xbb;
  cpu.pc = 0x1000;
  cpu.a[0] = 0x2001;
  cpu.d[0] = 0x5a;
  cpu.step();
  assert.equal(mem[0x2000], 0xaa, 'the untouched half survives');
  assert.equal(mem[0x2001], 0x5a);
});

test('m68000: 32-bit accesses are split into two bus cycles', () => {
  const { cpu, log } = mkMachine([0x2080]); // MOVE.L D0,(A0)
  cpu.a[0] = 0x2000;
  log.writes = 0;
  cpu.step();
  assert.equal(log.writes, 2, 'a long store is two word writes');
});

test('m68000: TAS write-back can be disabled for hardware that suppresses it', () => {
  const { cpu, mem } = mkMachine([0x4ad0], 0x1000, {}); // TAS (A0)
  mem[0x2000] = 0x01;
  cpu.a[0] = 0x2000;
  cpu.tasWriteBack = false;
  cpu.step();
  assert.equal(mem[0x2000], 0x01, 'no write-back when the machine asks for none');
  assert.equal(cpu.fn, 0);
  cpu.tasWriteBack = true;
  cpu.pc = 0x1000;
  cpu.step();
  assert.equal(mem[0x2000], 0x81);
});
