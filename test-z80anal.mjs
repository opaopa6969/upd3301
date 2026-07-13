import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble } from './z80asm.js';
import { analyze, portName, memName, metaOf, exportSource } from './z80anal.js';

function analyzed(src, opts) {
  const r = assemble(src);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  return analyze(r.bytes, r.org, r.symbols, opts);
}
const routine = (an, name) => an.routines.find((r) => r.name === name);

test('z80anal: destroyed / input / saved registers, transitive through CALLs', () => {
  const an = analyzed(`
        ORG 8000h
top:    CALL middle
        RET

middle: LD D,7          ; destroys D locally…
        CALL leaf       ; …and inherits leaf's A
        RET

leaf:   LD A,1
        RET

keeper PROC USES BC
        LD BC,0
        RET
keeper ENDP
`);
  const leaf = routine(an, 'LEAF');
  assert.deepEqual(leaf.destroys, ['A']);
  const middle = routine(an, 'MIDDLE');
  assert.deepEqual(middle.destroys, ['A', 'D']); // A propagated from leaf
  const top = routine(an, 'TOP');
  assert.deepEqual(top.destroys, ['A', 'D']); // two hops
  const keeper = routine(an, 'KEEPER');
  assert.deepEqual(keeper.saves, ['B', 'C']);
  assert.deepEqual(keeper.destroys, []); // PUSH/POP wrap protects the writes
});

test('z80anal: inputs are reads-before-writes', () => {
  const an = analyzed(`
        ORG 8000h
addbc:  LD A,B          ; reads B before anything writes it
        ADD A,C         ; reads C
        LD B,0          ; writes B after the read — still an input
        RET
`);
  const r = routine(an, 'ADDBC');
  assert.deepEqual(r.inputs, ['B', 'C']);
  assert.ok(r.destroys.includes('A') && r.destroys.includes('B') && r.destroys.includes('F'));
});

test('z80anal: recursion converges, indirect JP marks unknown', () => {
  const an = analyzed(`
        ORG 8000h
rec:    LD A,1
        CALL rec        ; direct recursion — fixed point, not a hang
        RET

vec:    JP (HL)         ; the analyzer cannot see through this

user:   CALL vec
        RET
`);
  assert.deepEqual(routine(an, 'REC').destroys, ['A']);
  assert.ok(routine(an, 'VEC').unknown);
  assert.ok(routine(an, 'USER').unknown, 'unknown propagates to callers');
});

test('z80anal: I/O ports collected and annotated (main and sub tables)', () => {
  const an = analyzed(`
        ORG 8000h
crtc:   LD A,28h
        OUT (51h),A
        IN A,(40h)
        OUT (C),A       ; dynamic
        RET
`);
  const io = routine(an, 'CRTC').io;
  const out51 = io.find((i) => i.port === 0x51);
  assert.equal(out51.dir, 'out');
  assert.match(out51.name, /μPD3301/);
  const in40 = io.find((i) => i.port === 0x40);
  assert.match(in40.name, /VRTC/);
  assert.ok(io.some((i) => i.dynamic), 'OUT (C),A marked dynamic');
  // sub-board table
  const sub = analyzed(`
        ORG 0h
fdc:    IN A,(0FAh)
        OUT (0F8h),A
        RET
`, { ports: 'pc88-sub' });
  const sio = routine(sub, 'FDC').io;
  assert.match(sio.find((i) => i.port === 0xfa).name, /FDC status/);
  assert.match(sio.find((i) => i.port === 0xf8).name, /motor/);
  // helpers directly
  assert.match(portName(0x60), /DMAC/);
  assert.equal(portName(0x99), null);
});

test('z80anal: memory access map with region names, dynamic flagged', () => {
  const an = analyzed(`
        ORG 8000h
vram:   LD A,(0F3C8h)
        LD (0EF00h),A
        LD HL,(0ED10h)
        LD (HL),3        ; dynamic
        RET
`);
  const r = routine(an, 'VRAM');
  const rd = r.mem.find((m) => m.addr === 0xf3c8);
  assert.equal(rd.rw, 'r');
  assert.match(rd.name, /text VRAM/);
  const wr = r.mem.find((m) => m.addr === 0xef00);
  assert.equal(wr.rw, 'w');
  assert.match(wr.name, /disk work/);
  assert.match(r.mem.find((m) => m.addr === 0xed10).name, /RAM hooks/);
  assert.ok(r.dynamicMem);
  assert.match(memName(0xf400), /text VRAM/);
});

test('z80anal: stack lint — imbalance, POP-first, diverging paths', () => {
  const an = analyzed(`
        ORG 8000h
leak:   PUSH BC
        RET

steal:  POP HL
        RET

diverge: PUSH BC
        JR Z,.merge      ; local target — stays inside this routine
        POP BC
.merge: NOP
        RET
`);
  assert.match(routine(an, 'LEAK').warnings[0].message, /RET with 1 item/);
  assert.equal(routine(an, 'LEAK').warnings[0].type, 'stack');
  assert.match(routine(an, 'STEAL').warnings[0].message, /nothing pushed/);
  assert.ok(routine(an, 'DIVERGE').warnings.some((w) => /different stack depths/.test(w.message)));
});

test('z80anal: T-states — straight-line exact, branches as min/max, loops flagged', () => {
  // LD A,5 (7T) + RET (10T)
  const an1 = analyzed(`
        ORG 0h
f:      LD A,5
        RET
`);
  assert.deepEqual(routine(an1, 'F').tStates, { min: 17, max: 17, loop: false });
  // LD B,8 (7) + DJNZ (8/13) + RET (10)
  const an2 = analyzed(`
        ORG 0h
w:      LD B,8
.l:     DJNZ .l
        RET
`);
  assert.deepEqual(routine(an2, 'W').tStates, { min: 25, max: 30, loop: true });
  // conditional RET: 5/11
  const an3 = analyzed(`
        ORG 0h
g:      RET Z
        RET
`);
  assert.deepEqual(routine(an3, 'G').tStates, { min: 15, max: 21, loop: false });
});

test('z80anal: metaOf T-states match z80.js for a few knowns', () => {
  const t = (bytes) => metaOf((a) => bytes[a] ?? 0, 0).t;
  assert.deepEqual(t([0x00]), [4, 4]); // NOP
  assert.deepEqual(t([0x3e, 1]), [7, 7]); // LD A,n
  assert.deepEqual(t([0xc3, 0, 0]), [10, 10]); // JP
  assert.deepEqual(t([0xcd, 0, 0]), [17, 17]); // CALL
  assert.deepEqual(t([0xed, 0xb0]), [16, 21]); // LDIR
  assert.deepEqual(t([0xcb, 0x06]), [15, 15]); // RLC (HL)
  assert.deepEqual(t([0xdd, 0x34, 2]), [27, 27]); // INC (IX+d) — z80.js charges 4+23
});

test('z80anal: xref and self-modifying-code detection', () => {
  const an = analyzed(`
        ORG 8000h
main:   CALL util
        JP tail

util:   RET

tail:   LD A,0C9h
        LD (util),A      ; patching code — the 1985 art form
        RET
`);
  assert.deepEqual(an.xref.UTIL, ['MAIN']);
  assert.deepEqual(an.xref.TAIL, ['MAIN']); // tail jumps count as calls
  assert.deepEqual(routine(an, 'MAIN').calls.map((c) => c.name).sort(), ['TAIL', 'UTIL']);
  const w = routine(an, 'TAIL').warnings.find((x) => x.type === 'selfmod');
  assert.match(w.message, /⚡/);
  assert.match(w.message, /UTIL\+0/);
});

test('z80anal: exportSource roundtrips byte-exactly, with labels and data', () => {
  const src = `
        ORG 8000h
main:   LD HL,msg
        CALL puts
        JR done
msg:    DB "HI!",0
puts:   LD A,(HL)
        OUT (51h),A
        RET
done:   CALL 0F000h      ; external absolute
        HALT
`;
  const r = assemble(src);
  assert.equal(r.errors.length, 0);
  const read = (a) => r.bytes[a - r.org] ?? 0;
  const end = r.org + r.bytes.length;
  const labels = new Map([[r.symbols.PUTS, 'PUTS'], [r.symbols.MSG, 'MSG']]);
  const text = exportSource(read, r.org, end, { labels });
  // labels appear as definitions AND as operand references
  assert.match(text, /^PUTS:$/m);
  assert.match(text, /CALL PUTS/);
  assert.match(text, /LD HL,MSG/);
  // the string was never reachable as code → DB, not instructions
  assert.match(text, /DB 48h,49h,21h,00h/);
  // external absolute untouched
  assert.match(text, /CALL 0F000h/);
  // the hard contract: reassembling reproduces the exact bytes
  const r2 = assemble(text);
  assert.equal(r2.errors.length, 0, JSON.stringify(r2.errors));
  assert.equal(r2.org, r.org);
  assert.deepEqual([...r2.bytes], [...r.bytes]);
});

test('z80anal: exportSource with a different ORG relocates in-range refs only', () => {
  const src = `
        ORG 8000h
main:   LD HL,msg
        CALL sub
        HALT
sub:    LD A,(0F3C8h)    ; out-of-range absolute — must NOT move
        RET
msg:    DB 1,2,3
`;
  const r = assemble(src);
  const read = (a) => r.bytes[a - r.org] ?? 0;
  const end = r.org + r.bytes.length;
  const text = exportSource(read, r.org, end, { org: 0x9000 });
  const r2 = assemble(text);
  assert.equal(r2.errors.length, 0, JSON.stringify(r2.errors));
  assert.equal(r2.org, 0x9000);
  // CALL sub moved by +1000h, the ROM absolute stayed
  const callAt = (bytes, base) => {
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0xcd) return bytes[i + 1] | (bytes[i + 2] << 8);
  };
  assert.equal(callAt(r.bytes) - r.org, callAt(r2.bytes) - 0x9000, 'CALL target rode the relocation');
  const absAt = (bytes) => {
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x3a) return bytes[i + 1] | (bytes[i + 2] << 8);
  };
  assert.equal(absAt(r2.bytes), 0xf3c8, 'external absolute untouched');
  // LD HL,msg (relocatable data ref) also rode along
  const ldhl = (bytes) => {
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x21) return bytes[i + 1] | (bytes[i + 2] << 8);
  };
  assert.equal(ldhl(r.bytes) - r.org, ldhl(r2.bytes) - 0x9000, 'LD HL,msg rode the relocation');
});

test('z80anal: calls out of the image are external → unknown', () => {
  const an = analyzed(`
        ORG 8000h
f:      CALL 0F000h      ; some ROM routine we cannot see
        RET
`);
  const r = routine(an, 'F');
  assert.ok(r.unknown);
  assert.equal(r.calls[0].external, true);
});
