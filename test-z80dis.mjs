import test from 'node:test';
import assert from 'node:assert/strict';
import { disasm } from './z80dis.js';
import { assemble } from './z80asm.js';

const dis = (bytes, addr = 0, opts) => disasm((a) => bytes[(a - addr) & 0xffff] ?? 0, addr, opts);

test('z80dis: representative main-table instructions', () => {
  const cases = [
    [[0x00], 'NOP'],
    [[0x3e, 0x12], 'LD A,12h'],
    [[0x3e, 0xff], 'LD A,0FFh'], // hex letters get the classic leading 0
    [[0x41], 'LD B,C'],
    [[0x36, 0xaa], 'LD (HL),0AAh'],
    [[0x01, 0x34, 0x12], 'LD BC,1234h'],
    [[0x22, 0x00, 0xc0], 'LD (0C000h),HL'],
    [[0x3a, 0x00, 0xf0], 'LD A,(0F000h)'],
    [[0x08], "EX AF,AF'"],
    [[0xeb], 'EX DE,HL'],
    [[0xd9], 'EXX'],
    [[0x87], 'ADD A,A'],
    [[0x96], 'SUB (HL)'],
    [[0xfe, 0x28], 'CP 28h'],
    [[0x09], 'ADD HL,BC'],
    [[0x34], 'INC (HL)'],
    [[0x3b], 'DEC SP'],
    [[0x27], 'DAA'],
    [[0xc3, 0x00, 0x80], 'JP 8000h'],
    [[0xca, 0x00, 0x80], 'JP Z,8000h'],
    [[0xe9], 'JP (HL)'],
    [[0xcd, 0x00, 0x80], 'CALL 8000h'],
    [[0xc9], 'RET'],
    [[0xd8], 'RET C'],
    [[0xff], 'RST 38h'],
    [[0xc7], 'RST 00h'],
    [[0xdb, 0xfe], 'IN A,(0FEh)'],
    [[0xd3, 0xfe], 'OUT (0FEh),A'],
    [[0x76], 'HALT'],
    [[0xf3], 'DI'],
  ];
  for (const [bytes, text] of cases) {
    const d = dis(bytes);
    assert.equal(d.text, text);
    assert.equal(d.len, bytes.length, text);
    assert.deepEqual(d.bytes, bytes, text);
  }
});

test('z80dis: relative jumps resolve to absolute targets', () => {
  assert.equal(dis([0x10, 0xfe], 0x100).text, 'DJNZ 0100h'); // d = -2 → self
  assert.equal(dis([0x18, 0x00], 0x100).text, 'JR 0102h');
  assert.equal(dis([0x20, 0x10], 0x100).text, 'JR NZ,0112h');
  assert.equal(dis([0x38, 0x80], 0x100).text, 'JR C,0082h'); // backwards
});

test('z80dis: CB — rotates, BIT/RES/SET, undocumented SLL', () => {
  assert.equal(dis([0xcb, 0x00]).text, 'RLC B');
  assert.equal(dis([0xcb, 0x16]).text, 'RL (HL)');
  assert.equal(dis([0xcb, 0x37]).text, 'SLL A'); // undocumented
  assert.equal(dis([0xcb, 0x7e]).text, 'BIT 7,(HL)');
  assert.equal(dis([0xcb, 0x9a]).text, 'RES 3,D');
  assert.equal(dis([0xcb, 0xe1]).text, 'SET 4,C');
});

test('z80dis: ED — block ops, 16-bit arithmetic, I/R, holes as DB', () => {
  assert.equal(dis([0xed, 0xb0]).text, 'LDIR');
  assert.equal(dis([0xed, 0xa9]).text, 'CPD');
  assert.equal(dis([0xed, 0x4a]).text, 'ADC HL,BC');
  assert.equal(dis([0xed, 0x72]).text, 'SBC HL,SP');
  assert.equal(dis([0xed, 0x47]).text, 'LD I,A');
  assert.equal(dis([0xed, 0x5f]).text, 'LD A,R');
  assert.equal(dis([0xed, 0x44]).text, 'NEG');
  assert.equal(dis([0xed, 0x45]).text, 'RETN');
  assert.equal(dis([0xed, 0x4d]).text, 'RETI');
  assert.equal(dis([0xed, 0x56]).text, 'IM 1');
  assert.equal(dis([0xed, 0x70]).text, 'IN (C)'); // undocumented
  assert.equal(dis([0xed, 0x71]).text, 'OUT (C),0'); // undocumented
  assert.equal(dis([0xed, 0x4b, 0x34, 0x12]).text, 'LD BC,(1234h)');
  assert.equal(dis([0xed, 0x77]).text, 'DB 0EDh,77h'); // hole
  assert.equal(dis([0xed, 0x4c]).text, 'DB 0EDh,4Ch'); // NEG shadow stays a DB
});

test('z80dis: DD/FD — IX/IY, halves, displacement, dead prefixes', () => {
  assert.equal(dis([0xdd, 0x21, 0x34, 0x12]).text, 'LD IX,1234h');
  assert.equal(dis([0xfd, 0x36, 0xfe, 0x55]).text, 'LD (IY-02h),55h'); // d then n
  assert.equal(dis([0xdd, 0x66, 0x7f]).text, 'LD H,(IX+7Fh)'); // plain H beside (IX+d)
  assert.equal(dis([0xdd, 0x26, 0x12]).text, 'LD IXH,12h'); // undocumented half
  assert.equal(dis([0xdd, 0x6c]).text, 'LD IXL,IXH');
  assert.equal(dis([0xfd, 0x84]).text, 'ADD A,IYH');
  assert.equal(dis([0xdd, 0xe9]).text, 'JP (IX)');
  assert.equal(dis([0xdd, 0xe3]).text, 'EX (SP),IX');
  assert.equal(dis([0xdd, 0x09]).text, 'ADD IX,BC');
  assert.equal(dis([0xdd, 0x29]).text, 'ADD IX,IX');
  // a prefix that changes nothing burns 4T on real silicon — shown as its own DB
  assert.deepEqual(dis([0xdd, 0x00]), { text: 'DB 0DDh', len: 1, bytes: [0xdd] });
  assert.equal(dis([0xdd, 0xdd, 0x21, 0x34, 0x12]).len, 1); // chain: first prefix dead
  assert.equal(dis([0xdd, 0xed, 0xb0]).len, 1); // ED ignores DD
});

test('z80dis: DDCB/FDCB — memory forms and undocumented register copies', () => {
  assert.equal(dis([0xdd, 0xcb, 0x05, 0x06]).text, 'RLC (IX+05h)');
  assert.equal(dis([0xdd, 0xcb, 0xfe, 0x06]).text, 'RLC (IX-02h)');
  assert.equal(dis([0xdd, 0xcb, 0x05, 0x00]).text, 'RLC (IX+05h),B'); // copy form
  assert.equal(dis([0xfd, 0xcb, 0x01, 0x7e]).text, 'BIT 7,(IY+01h)');
  assert.equal(dis([0xfd, 0xcb, 0x01, 0x78]).text, 'BIT 7,(IY+01h)'); // BIT has no copy
  assert.equal(dis([0xdd, 0xcb, 0x03, 0xc7]).text, 'SET 0,(IX+03h),A');
  assert.equal(dis([0xdd, 0xcb, 0x03, 0x96]).text, 'RES 2,(IX+03h)');
});

test('z80dis: Intel 8080 syntax for the 8080-compatible subset', () => {
  const i = { syntax: 'intel' };
  assert.equal(dis([0x78], 0, i).text, 'MOV A,B');
  assert.equal(dis([0x77], 0, i).text, 'MOV M,A');
  assert.equal(dis([0x3e, 0x12], 0, i).text, 'MVI A,12h');
  assert.equal(dis([0x36, 0x12], 0, i).text, 'MVI M,12h');
  assert.equal(dis([0x01, 0x34, 0x12], 0, i).text, 'LXI B,1234h');
  assert.equal(dis([0x31, 0x34, 0x12], 0, i).text, 'LXI SP,1234h');
  assert.equal(dis([0x09], 0, i).text, 'DAD B');
  assert.equal(dis([0x0a], 0, i).text, 'LDAX B');
  assert.equal(dis([0x12], 0, i).text, 'STAX D');
  assert.equal(dis([0x22, 0x34, 0x12], 0, i).text, 'SHLD 1234h');
  assert.equal(dis([0x3a, 0x34, 0x12], 0, i).text, 'LDA 1234h');
  assert.equal(dis([0x03], 0, i).text, 'INX B');
  assert.equal(dis([0x3c], 0, i).text, 'INR A');
  assert.equal(dis([0x35], 0, i).text, 'DCR M');
  assert.equal(dis([0x80], 0, i).text, 'ADD B');
  assert.equal(dis([0x9e], 0, i).text, 'SBB M');
  assert.equal(dis([0xa7], 0, i).text, 'ANA A');
  assert.equal(dis([0xfe, 0x28], 0, i).text, 'CPI 28h');
  assert.equal(dis([0xc6, 0x01], 0, i).text, 'ADI 01h');
  assert.equal(dis([0xc3, 0x00, 0x80], 0, i).text, 'JMP 8000h');
  assert.equal(dis([0xc2, 0x00, 0x80], 0, i).text, 'JNZ 8000h');
  assert.equal(dis([0xf2, 0x00, 0x80], 0, i).text, 'JP 8000h'); // Intel JP = jump-positive!
  assert.equal(dis([0xcc, 0x00, 0x80], 0, i).text, 'CZ 8000h');
  assert.equal(dis([0xc8], 0, i).text, 'RZ');
  assert.equal(dis([0xf5], 0, i).text, 'PUSH PSW');
  assert.equal(dis([0xe1], 0, i).text, 'POP H');
  assert.equal(dis([0xe3], 0, i).text, 'XTHL');
  assert.equal(dis([0xeb], 0, i).text, 'XCHG');
  assert.equal(dis([0xe9], 0, i).text, 'PCHL');
  assert.equal(dis([0xf9], 0, i).text, 'SPHL');
  assert.equal(dis([0x07], 0, i).text, 'RLC');
  assert.equal(dis([0x1f], 0, i).text, 'RAR');
  assert.equal(dis([0x2f], 0, i).text, 'CMA');
  assert.equal(dis([0x76], 0, i).text, 'HLT');
  assert.equal(dis([0xdb, 0x40], 0, i).text, 'IN 40h');
  assert.equal(dis([0xd3, 0x51], 0, i).text, 'OUT 51h');
  assert.equal(dis([0xef], 0, i).text, 'RST 5');
  // Z80-only encodings have no 8080 spelling and stay Zilog
  assert.equal(dis([0x10, 0xfe], 0, i).text, 'DJNZ 0000h');
  assert.equal(dis([0x18, 0x00], 0, i).text, 'JR 0002h');
  assert.equal(dis([0xcb, 0x00], 0, i).text, 'RLC B');
  assert.equal(dis([0xed, 0xb0], 0, i).text, 'LDIR');
  assert.equal(dis([0xdd, 0x21, 0x34, 0x12], 0, i).text, 'LD IX,1234h');
});

// text fixpoint: disassemble → reassemble → disassemble must reproduce the
// text. This covers the whole opcode space, including the DB fallbacks.
function fixpoint(bytes) {
  const d1 = dis(bytes);
  const res = assemble('ORG 0\n' + d1.text);
  assert.equal(res.errors.length, 0,
    `'${d1.text}' must assemble (${res.errors[0]?.message ?? ''})`);
  const d2 = dis([...res.bytes]);
  assert.equal(d2.text, d1.text, `fixpoint for [${bytes.map((b) => b.toString(16)).join(' ')}]`);
}

test('z80dis↔z80asm: full main-table sweep is a text fixpoint', () => {
  for (let op = 0; op < 256; op++) fixpoint([op, 0x12, 0x34, 0x05]);
});

test('z80dis↔z80asm: full CB sweep is a text fixpoint', () => {
  for (let op = 0; op < 256; op++) fixpoint([0xcb, op]);
});

test('z80dis↔z80asm: full ED sweep is a text fixpoint', () => {
  for (let op = 0; op < 256; op++) fixpoint([0xed, op, 0x12, 0x34]);
});

test('z80dis↔z80asm: full DD and DDCB sweeps are text fixpoints', () => {
  for (let op = 0; op < 256; op++) fixpoint([0xdd, op, 0x12, 0x34, 0x05]);
  for (let op = 0; op < 256; op++) fixpoint([0xfd, op, 0x12, 0x34, 0x05]);
  for (let op = 0; op < 256; op++) fixpoint([0xdd, 0xcb, 0x12, op]);
  for (let op = 0; op < 256; op++) fixpoint([0xfd, 0xcb, 0xf0, op]);
});

test('z80dis↔z80asm: byte-exact roundtrip over an assembled program', () => {
  // assembler output → disassemble everything → reassemble → identical bytes
  const src = `
        ORG 0C000h
start:  LD A,12h
        LD (IX+5),0BBh
        LD IXH,3
        LD BC,1234h
        LD (4002h),HL
        LD BC,(4006h)
        PUSH IX
        EX (SP),IX
        ADD IX,DE
        ADC HL,SP
        INC (IX+2)
        RL (IX+4)
        RR (IX+4),B
        SET 5,(IY+1),A
        BIT 0,(IX+0)
loop:   DJNZ loop
        JR NZ,loop
        JP (IX)
        CALL M,start
        IN (C)
        OUT (C),0
        LDIR
        RST 8
        HALT
`;
  const r1 = assemble(src);
  assert.equal(r1.errors.length, 0, JSON.stringify(r1.errors));
  const read = (a) => r1.bytes[a - r1.org] ?? 0;
  let a = r1.org;
  const lines = [`ORG 0${r1.org.toString(16).toUpperCase()}h`];
  while (a < r1.org + r1.bytes.length) {
    const d = disasm(read, a);
    lines.push(d.text);
    a += d.len;
  }
  const r2 = assemble(lines.join('\n'));
  assert.equal(r2.errors.length, 0, JSON.stringify(r2.errors));
  assert.equal(r2.org, r1.org);
  assert.deepEqual([...r2.bytes], [...r1.bytes]);
});
