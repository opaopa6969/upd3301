import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble } from './z80asm.js';
import { Z80 } from './z80.js';

const bytesOf = (src, opts) => {
  const r = assemble(src, opts);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  return [...r.bytes];
};

// assemble + run on the real core until HALT, then let the caller inspect memory
function runProgram(src, { org = 0x100, maxSteps = 200000 } = {}) {
  const r = assemble(src, { org });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  const mem = new Uint8Array(0x10000);
  mem.set(r.bytes, r.org);
  const io = { out: [] };
  const cpu = new Z80({
    read: (a) => mem[a & 0xffff],
    write: (a, v) => { mem[a & 0xffff] = v & 0xff; },
    in: () => 0xff,
    out: (p, v) => io.out.push([p & 0xff, v]),
  });
  cpu.pc = r.org;
  let n = maxSteps;
  while (!cpu.halted && n-- > 0) cpu.step();
  assert.ok(n > 0, 'program must reach HALT');
  return { r, mem, cpu, io };
}

test('z80asm: instruction encoding spot checks', () => {
  const cases = [
    ['LD A,12h', [0x3e, 0x12]],
    ['LD B,C', [0x41]],
    ['LD (HL),0AAh', [0x36, 0xaa]],
    ['LD (IX+5),0AAh', [0xdd, 0x36, 0x05, 0xaa]],
    ['LD H,(IX+7Fh)', [0xdd, 0x66, 0x7f]],
    ['LD IXH,3', [0xdd, 0x26, 0x03]],
    ['LD IXL,B', [0xdd, 0x68]],
    ['LD BC,1234h', [0x01, 0x34, 0x12]],
    ['LD IY,8000h', [0xfd, 0x21, 0x00, 0x80]],
    ['LD HL,(4000h)', [0x2a, 0x00, 0x40]],
    ['LD (4000h),IX', [0xdd, 0x22, 0x00, 0x40]],
    ['LD BC,(4000h)', [0xed, 0x4b, 0x00, 0x40]],
    ['LD (4000h),SP', [0xed, 0x73, 0x00, 0x40]],
    ['LD SP,IX', [0xdd, 0xf9]],
    ['LD A,(BC)', [0x0a]],
    ['LD (DE),A', [0x12]],
    ['LD A,(0F000h)', [0x3a, 0x00, 0xf0]],
    ['LD I,A', [0xed, 0x47]],
    ['LD A,R', [0xed, 0x5f]],
    ['PUSH AF', [0xf5]],
    ['POP IX', [0xdd, 0xe1]],
    ["EX AF,AF'", [0x08]],
    ['EX (SP),IY', [0xfd, 0xe3]],
    ['ADD A,B', [0x80]],
    ['ADD B', [0x80]], // single-operand shorthand
    ['ADC A,0FFh', [0xce, 0xff]],
    ['SUB (HL)', [0x96]],
    ['SBC A,(IY-1)', [0xfd, 0x9e, 0xff]],
    ['AND 0Fh', [0xe6, 0x0f]],
    ['XOR A', [0xaf]],
    ['CP 28h', [0xfe, 0x28]],
    ['ADD HL,SP', [0x39]],
    ['ADD IX,IX', [0xdd, 0x29]],
    ['ADC HL,BC', [0xed, 0x4a]],
    ['SBC HL,SP', [0xed, 0x72]],
    ['INC (IX+2)', [0xdd, 0x34, 0x02]],
    ['DEC IYL', [0xfd, 0x2d]],
    ['INC IX', [0xdd, 0x23]],
    ['RLC B', [0xcb, 0x00]],
    ['SLL A', [0xcb, 0x37]], // undocumented
    ['SRL (HL)', [0xcb, 0x3e]],
    ['RL (IX+4)', [0xdd, 0xcb, 0x04, 0x16]],
    ['RR (IX+4),B', [0xdd, 0xcb, 0x04, 0x18]], // undocumented copy form
    ['BIT 7,(IY-1)', [0xfd, 0xcb, 0xff, 0x7e]],
    ['SET 0,(IX+3),B', [0xdd, 0xcb, 0x03, 0xc0]],
    ['RES 6,A', [0xcb, 0xb7]],
    ['JP 8000h', [0xc3, 0x00, 0x80]],
    ['JP PO,8000h', [0xe2, 0x00, 0x80]],
    ['JP (IY)', [0xfd, 0xe9]],
    ['CALL NC,8000h', [0xd4, 0x00, 0x80]],
    ['RET PE', [0xe8]],
    ['RETI', [0xed, 0x4d]],
    ['RST 38h', [0xff]],
    ['RST 8', [0xcf]],
    ['IN A,(0FEh)', [0xdb, 0xfe]],
    ['IN D,(C)', [0xed, 0x50]],
    ['IN (C)', [0xed, 0x70]],
    ['IN F,(C)', [0xed, 0x70]],
    ['OUT (51h),A', [0xd3, 0x51]],
    ['OUT (C),E', [0xed, 0x59]],
    ['OUT (C),0', [0xed, 0x71]],
    ['IM 2', [0xed, 0x5e]],
    ['NEG', [0xed, 0x44]],
    ['RRD', [0xed, 0x67]],
    ['LDIR', [0xed, 0xb0]],
    ['OTIR', [0xed, 0xb3]],
    ['CPD', [0xed, 0xa9]],
    ['HALT', [0x76]],
  ];
  for (const [src, want] of cases) assert.deepEqual(bytesOf(src), want, src);
});

test('z80asm: relative jumps and range errors', () => {
  assert.deepEqual(bytesOf('ORG 100h\nx: DJNZ x'), [0x10, 0xfe]);
  assert.deepEqual(bytesOf('ORG 100h\nJR $'), [0x18, 0xfe]);
  assert.deepEqual(bytesOf('ORG 100h\nJR NZ,$+2'), [0x20, 0x00]);
  const r = assemble('ORG 100h\nJR 8000h');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 2);
  assert.match(r.errors[0].message, /relative jump out of range/);
});

test('z80asm: expressions — radices, chars, $, precedence', () => {
  assert.deepEqual(bytesOf('DB 10, 0x1F, 1Fh, 0FFh, 1010b, 0b101'), [10, 0x1f, 0x1f, 0xff, 10, 5]);
  assert.deepEqual(bytesOf("DB 'A', 'A'+1, '\\n'"), [65, 66, 10]);
  assert.deepEqual(bytesOf('DB 2+3*4, (2+3)*4'), [14, 20]);
  assert.deepEqual(bytesOf('DB 0F0h & 3Fh, 1 << 4, 80h >> 3, 5 | 2, 7 ^ 1, ~0 & 0FFh'), [0x30, 0x10, 0x10, 7, 6, 0xff]);
  assert.deepEqual(bytesOf('ORG 1234h\nDW $'), [0x34, 0x12]);
  assert.deepEqual(bytesOf('DB "AB",0'), [0x41, 0x42, 0]);
  assert.deepEqual(bytesOf('N EQU 3\nDS N, 0EEh'), [0xee, 0xee, 0xee]);
});

test('z80asm: forward references and local labels', () => {
  const r = assemble(`
        ORG 8000h
        JP fwd            ; forward reference resolves on pass 2
first:  LD B,2
.loop:  DJNZ .loop
second: LD B,3
.loop:  DJNZ .loop        ; same local name, new scope
fwd:    HALT
`);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.symbols['FIRST.LOOP'] !== undefined, true);
  assert.equal(r.symbols['SECOND.LOOP'] !== undefined, true);
  assert.equal(r.bytes[1] | (r.bytes[2] << 8), r.symbols.FWD);
});

test('z80asm: errors carry line numbers and never throw', () => {
  const r = assemble(`  LD A,1
  BOGUS 3
  LD Q,5
x:  NOP
x:  NOP
  DB 999
`);
  const lines = r.errors.map((e) => e.line);
  assert.deepEqual(lines, [5, 2, 3, 6]); // pass1 (dup) first, then pass2 in order
  assert.match(r.errors.find((e) => e.line === 2).message, /unknown mnemonic/);
  assert.match(r.errors.find((e) => e.line === 5).message, /duplicate label/);
  assert.match(r.errors.find((e) => e.line === 6).message, /out of range/);
});

test('z80asm: listing and symbols come back', () => {
  const r = assemble('ORG 10h\nV EQU 42\nstart: LD A,V\n');
  assert.equal(r.errors.length, 0);
  assert.equal(r.symbols.V, 42);
  assert.equal(r.symbols.START, 0x10);
  const l = r.listing.find((x) => /LD A,V/.test(x.source));
  assert.equal(l.addr, 0x10);
  assert.deepEqual(l.bytes, [0x3e, 42]);
});

test('z80asm: MACRO expansion runs on the real core', () => {
  const { mem } = runProgram(`
STORE   MACRO val, at
        LD A,val
        LD (at),A
        ENDM

BASE    EQU 8000h
        ORG 100h
        STORE 11h, BASE
        STORE 22h, BASE+1
        LD B,3
        LD HL,BASE+2
.fill:  LD (HL),B
        INC HL
        DJNZ .fill
        REPT 4
        INC A
        ENDM
        LD (BASE+8),A
        HALT
`);
  assert.equal(mem[0x8000], 0x11);
  assert.equal(mem[0x8001], 0x22);
  assert.deepEqual([mem[0x8002], mem[0x8003], mem[0x8004]], [3, 2, 1]);
  assert.equal(mem[0x8008], 0x26); // 22h + 4 × INC A
});

test('z80asm: macro-local labels get a fresh scope per expansion', () => {
  const { mem } = runProgram(`
WAIT    MACRO n
        LD B,n
.w:     DJNZ .w
        ENDM
        ORG 100h
        WAIT 2
        WAIT 3            ; a second .w — must not collide
        LD A,7
        LD (8000h),A
        HALT
`);
  assert.equal(mem[0x8000], 7);
});

test('z80asm: macros calling macros, REPT nesting', () => {
  const r = assemble(`
PAIR    MACRO x
        DB x, x+1
        ENDM
QUAD    MACRO y
        PAIR y
        PAIR y+2
        ENDM
        QUAD 10
        REPT 2
        REPT 2
        DB 0EEh
        ENDM
        ENDM
`);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.deepEqual([...r.bytes], [10, 11, 12, 13, 0xee, 0xee, 0xee, 0xee]);
});

test('z80asm: PROC USES pushes on entry and pops at every RET — verified by execution', () => {
  const { mem } = runProgram(`
        ORG 100h
        LD BC,1111h
        LD DE,2222h
        LD SP,0F000h
        CALL wreck
        LD (9000h),BC      ; must have survived
        EX DE,HL
        LD (9002h),HL
        HALT

wreck PROC USES BC,DE
        LD BC,0
        LD DE,0
        RET
wreck ENDP
`);
  assert.deepEqual([mem[0x9000], mem[0x9001]], [0x11, 0x11]);
  assert.deepEqual([mem[0x9002], mem[0x9003]], [0x22, 0x22]);
});

test('z80asm: conditional RET inside PROC USES is an error, not a rewrite', () => {
  const r = assemble(`
f PROC USES BC
  RET NZ
  RET
f ENDP
`);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /conditional RET/);
});

test('z80asm: STRUC defines field offsets and total size', () => {
  const r = assemble(`
player STRUC
x   DS 1
y   DS 1
hp  DW
name DS 8
player ENDS
        LD A,(IX+player.hp)
`);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.symbols['PLAYER.X'], 0);
  assert.equal(r.symbols['PLAYER.Y'], 1);
  assert.equal(r.symbols['PLAYER.HP'], 2);
  assert.equal(r.symbols['PLAYER.NAME'], 4);
  assert.equal(r.symbols.PLAYER, 12);
  assert.deepEqual([...r.bytes], [0xdd, 0x7e, 0x02]);
});

test('z80asm: RELOC records fixups; re-assembly at another ORG differs only there', () => {
  const src = (org) => `
        ORG ${org}
RELOC
head:   LD HL,msg
        CALL puts
        JR done            ; JR needs no fixup — that's the point of the lint
msg:    DB "HI",0
puts:   RET
done:   HALT
ENDRELOC
table:  FIXUPTABLE
`;
  const a = assemble(src('4000h'));
  const b = assemble(src('5000h'));
  assert.equal(a.errors.length, 0, JSON.stringify(a.errors));
  assert.deepEqual(a.fixups, [1, 4]); // LD HL,msg and CALL puts operands
  // FIXUPTABLE = DW count, then DW offsets
  const tOff = a.symbols.TABLE - a.org;
  assert.deepEqual([...a.bytes.slice(tOff, tOff + 6)], [2, 0, 1, 0, 4, 0]);
  // bytes must differ ONLY inside fixup fields (hi bytes here) — the table
  // itself is org-independent because offsets are region-relative
  const diffs = [];
  for (let i = 0; i < a.bytes.length; i++) if (a.bytes[i] !== b.bytes[i]) diffs.push(i);
  const allowed = new Set(a.fixups.flatMap((f) => [f, f + 1]));
  assert.ok(diffs.length > 0 && diffs.every((d) => allowed.has(d)), `diffs ${diffs} ⊆ fixups`);
});

test('z80asm: JP inside RELOC that fits a JR gets a warning', () => {
  const r = assemble(`
RELOC
a:  JP b
b:  RET
ENDRELOC
`);
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0].message, /could be JR/);
});

test('z80asm: fibonacci with forward refs, 16-bit ops and locals — full run', () => {
  const { mem } = runProgram(`
COUNT   EQU 10
        ORG 100h
        LD BC,COUNT
        LD HL,1
        LD DE,0
.fib:   PUSH HL            ; HL=F(n), DE=F(n-1)
        ADD HL,DE
        POP DE
        DEC BC
        LD A,B
        OR C
        JR NZ,.fib
        LD (8000h),HL      ; F(11) = 89
        HALT
`);
  assert.equal(mem[0x8000] | (mem[0x8001] << 8), 89);
});

// ---- MACRO-80 parity (author request: "enough expressiveness to build USES
// in userland") -----------------------------------------------------------------
test('z80asm/m80: IRP iterates a <>-guarded list (pushall)', () => {
  assert.deepEqual(bytesOf(`
pushall MACRO regs
        IRP r,<regs>
        PUSH r
        ENDM
        ENDM
        pushall <bc,de,hl>
`), [0xc5, 0xd5, 0xe5]);
});

test('z80asm/m80: IRPC iterates characters, &param reaches into strings', () => {
  assert.deepEqual(bytesOf(`
        IRPC c,AB
        DB '&c'
        ENDM
`), [0x41, 0x42]);
});

test('z80asm/m80: nested IF/ELSE/ENDIF and IFE', () => {
  assert.deepEqual(bytesOf(`
MODE    EQU 2
        IF MODE
          IFE MODE-2
            DB 1
          ELSE
            DB 2
          ENDIF
        ELSE
          DB 3
        ENDIF
`), [1]);
});

test('z80asm/m80: IFDEF sees EQUs and macros, IFNDEF the absence', () => {
  assert.deepEqual(bytesOf(`
X EQU 5
m MACRO
  ENDM
        IFDEF X
        DB 10
        ENDIF
        IFDEF m
        DB 11
        ENDIF
        IFNDEF nothere
        DB 12
        ENDIF
`), [10, 11, 12]);
});

test('z80asm/m80: IFB makes a variadic-style macro (acceptance)', () => {
  assert.deepEqual(bytesOf(`
emit    MACRO a,b
        IFB <b>
        DB a
        ELSE
        DB a,b
        ENDIF
        ENDM
        emit 1
        emit 2,3
`), [1, 2, 3]);
});

test('z80asm/m80: IFIDN / IFDIF compare argument text', () => {
  assert.deepEqual(bytesOf(`
sel     MACRO x
        IFIDN <x>,<hl>
        DB 0AAh
        ELSE
        DB 0BBh
        ENDIF
        ENDM
        sel hl
        sel de
`), [0xaa, 0xbb]);
});

test('z80asm/m80: EXITM bails out of the expansion from inside an IF (acceptance)', () => {
  assert.deepEqual(bytesOf(`
gen     MACRO n
        DB 1
        IF n
        EXITM
        ENDIF
        DB 2
        ENDM
        gen 1
        gen 0
`), [1, 1, 2]);
});

test('z80asm/m80: &-pasting mints label&1, label&2 — and JR reaches them (acceptance)', () => {
  const r = assemble(`
mk      MACRO n
label&n: DB n
        ENDM
        ORG 100h
        mk 1
        mk 2
        JR label1
`, { org: 0x100 });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.symbols.LABEL1, 0x100);
  assert.equal(r.symbols.LABEL2, 0x101);
  assert.deepEqual([...r.bytes], [1, 2, 0x18, 0xfc]); // JR back to label1
});

test('z80asm/m80: LOCAL declarations get a fresh name per expansion (acceptance)', () => {
  assert.deepEqual(bytesOf(`
wait2   MACRO
        LOCAL lp
        LD B,2
lp:     DJNZ lp
        ENDM
        wait2
        wait2
`), [0x06, 0x02, 0x10, 0xfe, 0x06, 0x02, 0x10, 0xfe]);
});

test('z80asm/m80: %expr passes the evaluated VALUE, not the text (acceptance)', () => {
  assert.deepEqual(bytesOf(`
val     MACRO v
        DB v, v*2
        ENDM
N       EQU 4
        val %(N*2+1)
`), [9, 18]); // text-passing would make v*2 = (N*2+1)*2 = 18 too… prove it differently
});

test('z80asm/m80: %expr vs text-passing differ where precedence bites', () => {
  // text: 1+2*2 = 5 / value: (1+2)=3 → 3*2 = 6
  const text = bytesOf('m MACRO v\n DB v*2\n ENDM\n m 1+2');
  const value = bytesOf('m MACRO v\n DB v*2\n ENDM\n m %(1+2)');
  assert.deepEqual(text, [5]);
  assert.deepEqual(value, [6]);
});

test('z80asm/m80: mnemonic shadowing, builtin resolution inside the shadow, PURGE', () => {
  assert.deepEqual(bytesOf(`
RET     MACRO
        POP BC
        RET             ; inside the shadow this is the BUILTIN (M80 rule)
        ENDM
        PUSH BC
        RET             ; expands the macro
        PURGE RET
        RET             ; the builtin is back
`), [0xc5, 0xc1, 0xc9, 0xc9]);
});

test('z80asm/m80: userland USES via RET-shadow equals PROC USES byte-for-byte (acceptance)', () => {
  const viaProc = assemble(`
f PROC USES BC,DE
        LD BC,0
        RET
f ENDP
`);
  const viaShadow = assemble(`
PROLOG  MACRO
        PUSH BC
        PUSH DE
        ENDM
RET     MACRO
        POP DE
        POP BC
        RET
        ENDM
f:      PROLOG
        LD BC,0
        RET
        PURGE RET
`);
  assert.equal(viaProc.errors.length, 0);
  assert.equal(viaShadow.errors.length, 0);
  assert.deepEqual([...viaShadow.bytes], [...viaProc.bytes]);
});

test('z80asm/m80: IF1/IF2 and forward refs in IF fail honestly', () => {
  const r1 = assemble('IF1\nDB 1\nENDIF');
  assert.match(r1.errors[0].message, /expands once/);
  const r2 = assemble('IF future\nDB 1\nENDIF\nfuture EQU 1');
  assert.match(r2.errors[0].message, /undefined symbol/);
});
