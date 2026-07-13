import test from 'node:test';
import assert from 'node:assert/strict';
import { Z80 } from './z80.js';
import { Pc8001TextSystem } from './pc8001.js';

const F = { C: 1, N: 2, PV: 4, F3: 8, H: 16, F5: 32, Z: 64, S: 128 };

function mkMachine(program, org = 0) {
  const mem = new Uint8Array(0x10000);
  mem.set(program, org);
  const io = { writes: [], reads: {}, inValue: 0x5a };
  const bus = {
    read: (a) => mem[a],
    write: (a, v) => { mem[a] = v; },
    in: (p) => { io.reads[p] = (io.reads[p] ?? 0) + 1; return io.inValue; },
    out: (p, v) => io.writes.push([p, v]),
  };
  const cpu = new Z80(bus);
  cpu.pc = org;
  cpu.f = 0;
  return { cpu, mem, io };
}

function runSteps(cpu, n) { let t = 0; for (let i = 0; i < n; i++) t += cpu.step(); return t; }
function runUntilHalt(cpu, max = 100000) {
  let t = 0;
  while (!cpu.halted && max-- > 0) t += cpu.step();
  assert.ok(max > 0, 'program should HALT');
  return t;
}

test('Z80: 8-bit loads and ADD flag edges', () => {
  const { cpu } = mkMachine([
    0x3e, 0x7f, // LD A,7Fh
    0x06, 0x01, // LD B,01h
    0x80, // ADD A,B → 80h: S PV H
    0x3e, 0xff, 0xc6, 0x01, // LD A,FFh; ADD A,1 → 0: Z C H
    0x76,
  ]);
  runSteps(cpu, 3);
  assert.equal(cpu.a, 0x80);
  assert.ok(cpu.f & F.S && cpu.f & F.PV && cpu.f & F.H);
  assert.ok(!(cpu.f & F.C) && !(cpu.f & F.N));
  runSteps(cpu, 2);
  assert.equal(cpu.a, 0);
  assert.ok(cpu.f & F.Z && cpu.f & F.C && cpu.f & F.H);
});

test('Z80: SUB/CP flags, CP copies F5/F3 from the operand', () => {
  const { cpu } = mkMachine([
    0x3e, 0x00, 0xd6, 0x01, // LD A,0; SUB 1 → FFh: S H N C
    0x3e, 0x10, 0xfe, 0x28, // LD A,10h; CP 28h → borrow; F5/F3 from 0x28
    0x76,
  ]);
  runSteps(cpu, 2);
  assert.equal(cpu.a, 0xff);
  assert.ok(cpu.f & F.S && cpu.f & F.H && cpu.f & F.N && cpu.f & F.C);
  runSteps(cpu, 2);
  assert.equal(cpu.a, 0x10, 'CP does not store');
  assert.ok(cpu.f & F.C);
  assert.equal(cpu.f & (F.F5 | F.F3), 0x28 & (F.F5 | F.F3));
});

test('Z80: DAA packs BCD after add and after subtract', () => {
  const { cpu } = mkMachine([
    0x3e, 0x15, 0xc6, 0x27, 0x27, // LD A,15h; ADD 27h; DAA → 42h
    0x3e, 0x99, 0xc6, 0x01, 0x27, // 99h + 01h → DAA → 00h, C
    0x3e, 0x42, 0xd6, 0x15, 0x27, // 42h - 15h → DAA → 27h
    0x76,
  ]);
  runSteps(cpu, 3);
  assert.equal(cpu.a, 0x42);
  runSteps(cpu, 3);
  assert.equal(cpu.a, 0x00);
  assert.ok(cpu.f & F.C && cpu.f & F.Z);
  runSteps(cpu, 3);
  assert.equal(cpu.a, 0x27);
});

test('Z80: 16-bit ADD/SBC and register pairs', () => {
  const { cpu } = mkMachine([
    0x21, 0xff, 0x7f, // LD HL,7FFFh
    0x11, 0x01, 0x00, // LD DE,0001h
    0x19, // ADD HL,DE → 8000h (no S/Z change, H from bit 11)
    0xb7, // OR A (clear carry)
    0xed, 0x52, // SBC HL,DE → 7FFFh
    0x76,
  ]);
  runSteps(cpu, 3);
  assert.equal(cpu.hl, 0x8000);
  assert.ok(cpu.f & F.H);
  runSteps(cpu, 2);
  assert.equal(cpu.hl, 0x7fff);
  assert.ok(!(cpu.f & F.C) && cpu.f & F.N);
});

test('Z80: stack, CALL/RET, RST, DJNZ loop', () => {
  const { cpu, mem } = mkMachine([
    0x31, 0x00, 0x90, // LD SP,9000h
    0x01, 0x34, 0x12, // LD BC,1234h
    0xc5, // PUSH BC
    0xd1, // POP DE
    0x06, 0x05, // LD B,5
    0x0e, 0x00, // LD C,0
    0x0c, // loop: INC C
    0x10, 0xfd, // DJNZ loop
    0xcd, 0x20, 0x00, // CALL 0020h
    0x76, // HALT (after RET)
  ]);
  mem[0x20] = 0x3e; mem[0x21] = 0x99; mem[0x22] = 0xc9; // LD A,99h; RET
  runUntilHalt(cpu);
  assert.equal(cpu.de, 0x1234);
  assert.equal(cpu.c, 5, 'DJNZ looped B times');
  assert.equal(cpu.b, 0);
  assert.equal(cpu.a, 0x99, 'CALL/RET round trip');
  assert.equal(cpu.sp, 0x9000);
});

test('Z80: CB bit ops and rotates', () => {
  const { cpu, mem } = mkMachine([
    0x21, 0x00, 0x80, // LD HL,8000h
    0x36, 0x01, // LD (HL),01h
    0xcb, 0x06, // RLC (HL) → 02h
    0xcb, 0xde, // SET 3,(HL) → 0Ah
    0xcb, 0x5e, // BIT 3,(HL) → Z clear
    0xcb, 0x66, // BIT 4,(HL) → Z set
    0x76,
  ]);
  runUntilHalt(cpu);
  assert.equal(mem[0x8000], 0x0a);
  assert.ok(cpu.f & F.Z, 'BIT 4 of 0Ah is zero');
});

test('Z80: IX displacement, IXH halves, DDCB', () => {
  const { cpu, mem } = mkMachine([
    0xdd, 0x21, 0x00, 0x40, // LD IX,4000h
    0xdd, 0x36, 0x05, 0xab, // LD (IX+5),ABh
    0xdd, 0x7e, 0x05, // LD A,(IX+5)
    0xdd, 0xcb, 0x05, 0xc6, // SET 0,(IX+5) → ABh|1 = ABh (already odd) — use bit 2
    0xdd, 0xcb, 0x05, 0xd6, // SET 2,(IX+5) → AFh
    0xdd, 0x7c, // LD A,IXH (undocumented) → 40h
    0x76,
  ]);
  runUntilHalt(cpu);
  assert.equal(mem[0x4005], 0xaf);
  assert.equal(cpu.a, 0x40);
});

test('Z80: EXX and EX AF swap register banks', () => {
  const { cpu } = mkMachine([
    0x01, 0x11, 0x11, // LD BC,1111h
    0x3e, 0xaa, // LD A,AAh
    0xd9, // EXX
    0x08, // EX AF,AF'
    0x01, 0x22, 0x22, // LD BC,2222h
    0xd9, // EXX back
    0x08,
    0x76,
  ]);
  runUntilHalt(cpu);
  assert.equal(cpu.bc, 0x1111);
  assert.equal(cpu.a, 0xaa);
  assert.equal(cpu.b_, 0x22);
});

test('Z80: LDIR block copy and CPIR search', () => {
  const src = 0x1000, dst = 0x2000;
  const { cpu, mem } = mkMachine([
    0x21, 0x00, 0x10, // LD HL,1000h
    0x11, 0x00, 0x20, // LD DE,2000h
    0x01, 0x0a, 0x00, // LD BC,10
    0xed, 0xb0, // LDIR
    0x21, 0x00, 0x10, // LD HL,1000h
    0x01, 0x0a, 0x00, // LD BC,10
    0x3e, 0x77, // LD A,77h
    0xed, 0xb1, // CPIR
    0x76,
  ]);
  for (let i = 0; i < 10; i++) mem[src + i] = 0x70 + i;
  runUntilHalt(cpu);
  for (let i = 0; i < 10; i++) assert.equal(mem[dst + i], 0x70 + i);
  assert.equal(cpu.hl, src + 8, 'CPIR stopped one past the 77h at src+7');
  assert.ok(cpu.f & F.Z);
  assert.ok(cpu.f & F.PV, 'BC not exhausted');
});

test('Z80: RRD/RLD rotate nibbles through (HL)', () => {
  const { cpu, mem } = mkMachine([
    0x21, 0x00, 0x30, // LD HL,3000h
    0x3e, 0x84, // LD A,84h
    0xed, 0x67, // RRD: A=8x→84→ A gets low nibble of (HL)
    0x76,
  ]);
  mem[0x3000] = 0x20;
  runUntilHalt(cpu);
  assert.equal(cpu.a, 0x80);
  assert.equal(mem[0x3000], 0x42);
});

test('Z80: OUT builds the 16-bit port from A/B', () => {
  const { cpu, io } = mkMachine([
    0x3e, 0x9a, // LD A,9Ah
    0xd3, 0x51, // OUT (51h),A → port 9A51h
    0x01, 0x34, 0x12, // LD BC,1234h
    0x3e, 0x55, // LD A,55h
    0xed, 0x79, // OUT (C),A → port 1234h
    0xdb, 0x40, // IN A,(40h)
    0x76,
  ]);
  runUntilHalt(cpu);
  assert.deepEqual(io.writes[0], [0x9a51, 0x9a]);
  assert.deepEqual(io.writes[1], [0x1234, 0x55]);
  assert.equal(cpu.a, 0x5a, 'IN A,(n) reads the bus');
});

test('Z80: EI delay, IM1 interrupt, HALT wake', () => {
  const { cpu } = mkMachine([
    0xed, 0x56, // IM 1
    0xfb, // EI
    0x00, // NOP (interrupts enabled only after this)
    0x76, // HALT
  ], 0x100);
  cpu.pc = 0x100;
  cpu.step(); // IM 1
  cpu.step(); // EI
  assert.equal(cpu.intRequest(), 0, 'not accepted immediately after EI');
  cpu.step(); // NOP → interrupts now on
  cpu.step(); // HALT
  assert.ok(cpu.halted);
  const t = cpu.intRequest();
  assert.ok(t > 0, 'interrupt accepted');
  assert.equal(cpu.pc, 0x38, 'IM 1 vectors to 38h');
  assert.equal(cpu.halted, false, 'interrupt wakes HALT');
  assert.equal(cpu.iff1, false, 'interrupts disabled during service');
});

test('Z80: NMI vectors to 66h and preserves IFF2', () => {
  const { cpu } = mkMachine([0xfb, 0x00, 0x76], 0x200);
  cpu.pc = 0x200;
  runSteps(cpu, 2); // EI; NOP
  assert.ok(cpu.iff1);
  cpu.nmi();
  assert.equal(cpu.pc, 0x66);
  assert.equal(cpu.iff1, false);
  assert.equal(cpu.iff2, true);
});

test('Z80: fibonacci program is deterministic', () => {
  const prog = [
    0x06, 0x0a, // LD B,10
    0x0e, 0x00, // LD C,0  (fib n-1)
    0x16, 0x01, // LD D,1  (fib n)
    0x79, // loop: LD A,C
    0x82, // ADD A,D
    0x4a, // LD C,D
    0x57, // LD D,A
    0x10, 0xfa, // DJNZ loop
    0x76,
  ];
  const run = () => { const { cpu } = mkMachine(prog); runUntilHalt(cpu); return cpu.getState(); };
  const s1 = run(), s2 = run();
  assert.equal(s1.d, 89, 'fib(11) = 89');
  assert.deepEqual(s1, s2);
});

test('Z80 drives the μPD3301/μPD8257 over OUT — text appears on screen', () => {
  const sys = new Pc8001TextSystem();
  const text = 'Z80 LIVES 3301';
  const O = (port, val) => [0x3e, val, 0xd3, port]; // LD A,v; OUT (p),A
  const prog = [
    // CRTC RESET + N-BASIC 80x25 parameters
    ...O(0x51, 0x00),
    ...O(0x50, 0x80 | 78), ...O(0x50, 0x40 | 24), ...O(0x50, 0x07),
    ...O(0x50, (6 << 5) | 12), ...O(0x50, 19),
    // DMAC: autoload + ch2, addr F3C8h, count 8000h+2999
    ...O(0x68, 0x84),
    ...O(0x64, 0xc8), ...O(0x64, 0xf3),
    ...O(0x65, 0xb7), ...O(0x65, 0x8b),
    // copy the text into VRAM with LDIR
    0x21, 0x00, 0x01, // LD HL,0100h (source)
    0x11, 0xc8, 0xf3, // LD DE,F3C8h
    0x01, text.length, 0x00, // LD BC,len
    0xed, 0xb0, // LDIR
    // attribute pair (0, E8h) at F3C8h+80
    0x3e, 0x00, 0x32, 0x18, 0xf4, // LD A,0; LD (F418h),A
    0x3e, 0xe8, 0x32, 0x19, 0xf4, // LD A,E8h; LD (F419h),A
    // START DISPLAY
    ...O(0x51, 0x20),
    0x76, // HALT
  ];
  sys.memory.set(prog, 0);
  for (let i = 0; i < text.length; i++) sys.memory[0x100 + i] = text.charCodeAt(i);
  const cpu = new Z80({
    read: (a) => sys.memory[a],
    write: (a, v) => { sys.memory[a] = v; },
    in: (p) => sys.in(p & 0xff),
    out: (p, v) => sys.out(p & 0xff, v),
  });
  cpu.pc = 0;
  runUntilHalt(cpu);
  sys.update(1 / 60); // one frame: DMA hauls what the Z80 wrote
  assert.equal(sys.crtc.cols, 80);
  assert.equal(sys.crtc.rows, 25);
  const got = String.fromCharCode(...sys.crtc.cells.subarray(0, text.length));
  assert.equal(got, text);
  const cgrom = new Uint8Array(256 * 16).fill(0xff);
  const img = sys.render({ cgrom });
  assert.equal(img.pixels[0], 7, 'white attribute reached the renderer');
});
