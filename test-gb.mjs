// test-gb — Game Boy / Game Boy Color.
//
// Two halves. The first is the usual unit work against hand-built cartridges
// (gbmbc.js's buildGbRom, the same trick ines.js uses so that no copyrighted
// ROM has to exist for the suite to mean anything). The second RUNS REAL TEST
// ROMS — mooneye's acceptance suite, its MBC suite, and dmg-acid2 — because
// this console is the one in this repository whose verification corpus is
// redistributable, so CI can do the real thing instead of skipping.
//
// The whole file runs in a couple of seconds and needs nothing from outside
// the repository. See gbroms/README.md for where the ROMs come from and under
// which licence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { SM83, FZ, FN, FH, FC } from './sm83.js';
import { GbPpu, SCREEN_W, SCREEN_H, MODE } from './gbppu.js';
import { GbApu } from './gbapu.js';
import {
  parseGbRom, tryParseGbRom, buildGbRom, createMbc, tryCreateMbc, MBCS, summarizeGbRom,
} from './gbmbc.js';
import { GbMachine, BUTTON, FRAME_HZ } from './machinegb.js';
import { runTest, judgeMooneye, judgeBlargg, snapSize, loadRom } from './gbtools/gbrun.mjs';
import { compareAcid2 } from './gbtools/acid2.mjs';

// ---------------------------------------------------------------------------
// A bus with no machine behind it: RAM, a cycle counter, and a settable
// interrupt state. Enough to measure an instruction's M-cycles and the order
// of its accesses, which is the property sm83.js is built around.
function testBus({ ie = 0, iflags = 0 } = {}) {
  const mem = new Uint8Array(0x10000);
  const log = [];
  const bus = {
    mem, log, cycles: 0, ie, iflags,
    read(a) { bus.cycles++; log.push(['r', a]); return mem[a]; },
    write(a, v) { bus.cycles++; log.push(['w', a, v]); mem[a] = v; },
    tick() { bus.cycles++; log.push(['i']); },
    irqPending() { return bus.ie & bus.iflags & 0x1f; },
    irqAck(bit) { bus.iflags &= ~(1 << bit); },
  };
  return bus;
}

function cpuAt(code, at = 0xc000, opts = {}) {
  const bus = testBus(opts);
  bus.mem.set(code, at);
  const cpu = new SM83(bus);
  cpu.pc = at;
  return { cpu, bus };
}

// ---- sm83: the instruction set ---------------------------------------------

test('sm83: F has no low nibble', () => {
  const { cpu, bus } = cpuAt([0xf1]);          // POP AF
  cpu.sp = 0xd000;
  bus.mem[0xd000] = 0xff; bus.mem[0xd001] = 0x12;
  cpu.step();
  assert.equal(cpu.f, 0xf0);
  assert.equal(cpu.a, 0x12);
});

test('sm83: DAA after addition and after subtraction', () => {
  // 0x09 + 0x08 = 0x11 in BCD
  const { cpu } = cpuAt([0x27]);
  cpu.a = 0x11; cpu.f = FH;
  cpu.step();
  assert.equal(cpu.a, 0x17);
  // subtraction path: the adjustment is driven by H/C only, never by digits
  const b = cpuAt([0x27]);
  b.cpu.a = 0x0b; b.cpu.f = FN | FH;
  b.cpu.step();
  assert.equal(b.cpu.a, 0x05);
});

test('sm83: ADD SP,e uses bit 3 and bit 7, ADD HL,rr uses 11 and 15', () => {
  const a = cpuAt([0xe8, 0x01]);               // ADD SP,+1
  a.cpu.sp = 0x000f;
  a.cpu.step();
  assert.equal(a.cpu.sp, 0x0010);
  assert.equal(a.cpu.f & (FZ | FN | FH | FC), FH);
  const b = cpuAt([0x29]);                     // ADD HL,HL
  b.cpu.hl = 0x0800; b.cpu.f = FZ;
  b.cpu.step();
  assert.equal(b.cpu.hl, 0x1000);
  assert.equal(b.cpu.f & FZ, FZ, 'ADD HL,rr leaves Z alone');
  assert.equal(b.cpu.f & FH, FH);
});

test('sm83: LD (HL+),A and LD (HL-),A', () => {
  const { cpu, bus } = cpuAt([0x22, 0x32]);
  cpu.hl = 0xd000; cpu.a = 0x5a;
  cpu.step();
  assert.equal(bus.mem[0xd000], 0x5a);
  assert.equal(cpu.hl, 0xd001);
  cpu.step();
  assert.equal(cpu.hl, 0xd000);
});

test('sm83: LDH reaches $FF00-$FFFF with a one-byte operand', () => {
  const { cpu, bus } = cpuAt([0xe0, 0x80, 0xf0, 0x80]);
  cpu.a = 0x99;
  cpu.step();
  assert.equal(bus.mem[0xff80], 0x99);
  cpu.a = 0;
  cpu.step();
  assert.equal(cpu.a, 0x99);
});

// The M-cycle counts are the reason this core exists; a table would be easy to
// get wrong in exactly the places mooneye measures.
test('sm83: instruction lengths in M-cycles', () => {
  const cases = [
    [[0x00], 1, 'NOP'],
    [[0x01, 0, 0], 3, 'LD BC,nn'],
    [[0x03], 2, 'INC BC'],
    [[0x34], 3, 'INC (HL)'],
    [[0x08, 0, 0xd0], 5, 'LD (nn),SP'],
    [[0xc3, 0, 0xc0], 4, 'JP nn'],
    [[0xe9], 1, 'JP HL'],
    [[0xcd, 0, 0xc0], 6, 'CALL nn'],
    [[0xc9], 4, 'RET'],
    [[0xd9], 4, 'RETI'],
    [[0xc5], 4, 'PUSH BC'],
    [[0xc1], 3, 'POP BC'],
    [[0xc7], 4, 'RST 00'],
    [[0xe8, 1], 4, 'ADD SP,e'],
    [[0xf8, 1], 3, 'LD HL,SP+e'],
    [[0xf9], 2, 'LD SP,HL'],
    [[0xcb, 0x00], 2, 'RLC B'],
    [[0xcb, 0x06], 4, 'RLC (HL)'],
    [[0xcb, 0x46], 3, 'BIT 0,(HL) — reads, never writes back'],
  ];
  for (const [code, want, name] of cases) {
    const { cpu, bus } = cpuAt(code);
    cpu.sp = 0xd000; cpu.hl = 0xd100;
    cpu.step();
    assert.equal(bus.cycles, want, `${name}: ${bus.cycles} M-cycles, want ${want}`);
  }
});

test('sm83: a conditional branch costs a cycle more when it is taken', () => {
  for (const [f, want] of [[0, 3], [FZ, 2]]) {           // JR NZ,e
    const { cpu, bus } = cpuAt([0x20, 0x02]);
    cpu.f = f;
    cpu.step();
    assert.equal(bus.cycles, want);
  }
  for (const [f, want] of [[0, 5], [FZ, 2]]) {           // RET NZ
    const { cpu, bus } = cpuAt([0xc0]);
    cpu.sp = 0xd000; cpu.f = f;
    cpu.step();
    assert.equal(bus.cycles, want);
  }
});

test('sm83: PUSH writes the high byte first', () => {
  const { cpu, bus } = cpuAt([0xc5]);
  cpu.sp = 0x0000; cpu.bc = 0x1234;
  cpu.step();
  const writes = bus.log.filter((e) => e[0] === 'w');
  assert.deepEqual(writes, [['w', 0xffff, 0x12], ['w', 0xfffe, 0x34]]);
});

test('sm83: EI lets the instruction after it run first', () => {
  // EI ; INC B ; (interrupt here)
  const { cpu, bus } = cpuAt([0xfb, 0x04, 0x04]);
  bus.ie = 0x01; bus.iflags = 0x01;
  cpu.sp = 0xd000;
  cpu.step();                       // EI
  assert.equal(cpu.ime, false);
  cpu.step();                       // INC B — must execute
  assert.equal(cpu.b, 1);
  cpu.step();                       // now the interrupt
  assert.equal(cpu.pc, 0x40);
  assert.equal(cpu.b, 1);
});

test('sm83: EI followed immediately by DI lets nothing through', () => {
  const { cpu, bus } = cpuAt([0xfb, 0xf3, 0x04]);
  bus.ie = 0x01; bus.iflags = 0x01;
  cpu.sp = 0xd000;
  cpu.step(); cpu.step(); cpu.step();
  assert.equal(cpu.pc, 0xc003);
  assert.equal(cpu.b, 1, 'the INC ran, so no interrupt was taken');
});

test('sm83: interrupt dispatch is five M-cycles and pushes PC', () => {
  const { cpu, bus } = cpuAt([0x00]);
  bus.ie = 0x04; bus.iflags = 0x04;   // timer
  cpu.ime = true; cpu.sp = 0xd000;
  const n = cpu.step();
  assert.equal(n, 5);
  assert.equal(cpu.pc, 0x50);
  assert.equal(cpu.ime, false);
  assert.equal(bus.mem[0xcffe], 0x00);
  assert.equal(bus.mem[0xcfff], 0xc0);
  assert.equal(bus.iflags, 0, 'the flag is acknowledged');
});

test('sm83: the vector is chosen after the high byte of PC is pushed (ie_push)', () => {
  // SP = 0 → the high byte lands on $FFFF, which IS the IE register. The bus
  // here models that: writing $FFFF changes what irqPending() answers.
  const bus = testBus();
  bus.ie = 0x01; bus.iflags = 0x1f;
  const realWrite = bus.write;
  bus.write = (a, v) => { realWrite(a, v); if (a === 0xffff) bus.ie = v; };
  bus.mem.set([0x00], 0xc000);
  const cpu = new SM83(bus);
  cpu.pc = 0xc000; cpu.ime = true; cpu.sp = 0x0000;
  cpu.step();
  // PC's high byte is $C0, so IE becomes $C0 — no bit in 0..4 survives, and
  // the dispatch has nowhere to go.
  assert.equal(cpu.pc, 0x0000);
});

test('sm83: the halt bug executes the next byte twice', () => {
  //  HALT ; INC B ; ...  with IME=0 and an interrupt already pending
  const { cpu, bus } = cpuAt([0x76, 0x04, 0x00]);
  bus.ie = 0x01; bus.iflags = 0x01;
  cpu.ime = false;
  cpu.step();                       // HALT — does not halt
  assert.equal(cpu.halted, false);
  assert.equal(cpu.haltBug, true);
  cpu.step();                       // INC B, and PC does not advance
  assert.equal(cpu.b, 1);
  assert.equal(cpu.pc, 0xc001);
  cpu.step();                       // the same INC B again
  assert.equal(cpu.b, 2);
});

test('sm83: HALT wakes on IE & IF even with IME clear', () => {
  const { cpu, bus } = cpuAt([0x76, 0x04]);
  cpu.ime = false;
  cpu.step();
  assert.equal(cpu.halted, true);
  cpu.step();
  assert.equal(cpu.halted, true, 'nothing pending: still asleep');
  bus.ie = 0x01; bus.iflags = 0x01;
  cpu.step();
  assert.equal(cpu.halted, false);
  cpu.step();
  assert.equal(cpu.b, 1, 'no handler ran, execution simply continued');
});

test('sm83: the unwired opcodes lock the CPU instead of throwing', () => {
  for (const op of [0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd]) {
    const { cpu } = cpuAt([op]);
    cpu.step();
    assert.equal(cpu.jammed, true, `$${op.toString(16)} should jam`);
    assert.equal(cpu.pc, 0xc000, 'and stay put');
  }
});

test('sm83: every one of the 256 opcodes decodes', () => {
  for (let op = 0; op < 256; op++) {
    const { cpu, bus } = cpuAt([op, 0x00, 0x00]);
    cpu.sp = 0xd000; cpu.hl = 0xd100;
    assert.doesNotThrow(() => cpu.step(), `opcode $${op.toString(16)}`);
    if (op === 0xcb) {
      for (let cb = 0; cb < 256; cb++) {
        const c = cpuAt([0xcb, cb]);
        c.cpu.hl = 0xd100;
        assert.doesNotThrow(() => c.cpu.step(), `CB $${cb.toString(16)}`);
      }
    }
    assert.ok(bus.cycles > 0);
  }
});

test('sm83: state round-trips exactly', () => {
  const { cpu } = cpuAt([0x3c, 0x04, 0x0c]);
  cpu.step();
  const s = cpu.getState();
  cpu.step(); cpu.step();
  const after = cpu.getState();
  cpu.setState(s);
  cpu.step(); cpu.step();
  assert.deepEqual(cpu.getState(), after);
});

// ---- gbmbc -----------------------------------------------------------------

test('gbmbc: the header is parsed and obvious damage becomes a warning', () => {
  const rom = buildGbRom({ title: 'HELLO', type: 0x1b, ramSize: 8192 });
  const cart = parseGbRom(rom);
  assert.equal(cart.title, 'HELLO');
  assert.equal(cart.mbc, 'mbc5');
  assert.equal(cart.hasBattery, true);
  assert.equal(cart.ramSize, 8192);
  assert.equal(cart.logoOk, true);
  assert.equal(cart.headerChecksumOk, true);
  assert.deepEqual(cart.warnings, []);
  rom[0x104] ^= 0xff;
  assert.ok(parseGbRom(rom).warnings.some((w) => /logo/.test(w)));
});

test('gbmbc: a file that cannot be a cartridge is an answer, not an exception', () => {
  const r = tryParseGbRom(new Uint8Array(16));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TOO_SHORT');
  const ok = tryParseGbRom(buildGbRom({}));
  assert.equal(ok.ok, true);
});

test('gbmbc: an unimplemented board is an answer too', () => {
  const cart = parseGbRom(buildGbRom({ type: 0x22 }));   // MBC7
  const r = tryCreateMbc(cart);
  assert.equal(r.ok, false);
  assert.equal(r.mbc, 'mbc7');
  assert.match(r.error, /not implemented/);
});

test('gbmbc: MBC1 has the bank-0 hole and the mode flag', () => {
  const rom = buildGbRom({ type: 0x03, size: 512 * 1024, ramSize: 32768 });
  for (let b = 0; b < 32; b++) rom[b * 0x4000] = b;      // stamp each bank
  const m = createMbc(parseGbRom(rom));
  m.regWrite(0x2000, 0x00);
  assert.equal(m.read(0x4000), 1, 'bank $00 reads as $01');
  m.regWrite(0x2000, 0x05);
  assert.equal(m.read(0x4000), 5);
  m.regWrite(0x4000, 0x01);                              // upper bits
  assert.equal(m.read(0x4000), 0x25);
  m.regWrite(0x2000, 0x00);
  assert.equal(m.read(0x4000), 0x21, 'the hole applies to $20 as well');
  assert.equal(m.read(0x0000), 0, 'mode 0: the low window is fixed at bank 0');
  m.regWrite(0x6000, 0x01);
  assert.equal(m.read(0x0000), 0x20, 'mode 1: the upper bits reach the low window');
});

test('gbmbc: MBC2 RAM is four bits wide and the register decode uses A8', () => {
  const m = createMbc(parseGbRom(buildGbRom({ type: 0x06 })));
  assert.equal(m.ram.length, 512);
  m.regWrite(0x0000, 0x0a);                              // A8 clear → RAM enable
  m.writeRam(0, 0xf7);
  assert.equal(m.readRam(0), 0xf7, 'the upper nibble reads back as ones');
  m.writeRam(0, 0x05);
  assert.equal(m.readRam(0), 0xf5);
  m.regWrite(0x0100, 0x03);                              // A8 set → ROM bank
  assert.equal(m.romBank, 3);
  m.regWrite(0x0100, 0x00);
  assert.equal(m.romBank, 1, 'bank 0 is not selectable');
});

test('gbmbc: MBC3 RTC counts emulated seconds and never asks the host clock', () => {
  const m = createMbc(parseGbRom(buildGbRom({ type: 0x10, ramSize: 8192 })));
  m.regWrite(0x0000, 0x0a);
  m.regWrite(0x4000, 0x08);                              // seconds register
  m.tick(4194304 * 90);
  assert.equal(m.readRam(0), 0, 'not latched yet');
  m.regWrite(0x6000, 0x00); m.regWrite(0x6000, 0x01);    // latch
  assert.equal(m.readRam(0), 30);
  m.regWrite(0x4000, 0x09);
  assert.equal(m.readRam(0), 1, 'minutes');
  // Determinism: the same number of cycles gives the same time, always.
  const n = createMbc(parseGbRom(buildGbRom({ type: 0x10, ramSize: 8192 })));
  n.tick(4194304 * 90);
  assert.deepEqual(n.rtc, m.rtc);
});

test('gbmbc: MBC5 has nine bits of bank and no hole', () => {
  const rom = buildGbRom({ type: 0x1b, size: 1024 * 1024, ramSize: 8192 });
  const m = createMbc(parseGbRom(rom));
  m.regWrite(0x2000, 0x00);
  assert.equal(m.romBank, 0, 'bank $000 really is bank $000');
  m.regWrite(0x2000, 0xff); m.regWrite(0x3000, 0x01);
  assert.equal(m.romBank, 0x1ff);
});

test('gbmbc: every board round-trips its state (the bug that only shows on rewind)', () => {
  for (const [name, type] of [['none', 0x00], ['mbc1', 0x03], ['mbc2', 0x06], ['mbc3', 0x10], ['mbc5', 0x1b], ['huc1', 0xff]]) {
    const cart = parseGbRom(buildGbRom({ type, size: 256 * 1024, ramSize: type === 0x06 ? 0 : 8192 }));
    const a = createMbc(cart), b = createMbc(cart);
    assert.equal(a.constructor, MBCS[name], name);
    // Poke every register the board has, then copy the state across.
    for (const addr of [0x0000, 0x2000, 0x3000, 0x4000, 0x6000]) a.write(addr, 0x0a);
    a.write(0x2000, 3); a.write(0x4000, 1); a.write(0xa000, 0x77);
    a.tick(4194304 * 5);
    b.setState(a.getState());
    assert.deepEqual(b.getState(), a.getState(), name);
    for (const addr of [0x0000, 0x4000, 0xa000]) assert.equal(b.read(addr), a.read(addr), `${name} @${addr.toString(16)}`);
  }
});

test('gbmbc: a snapshot never carries the ROM', () => {
  const cart = parseGbRom(buildGbRom({ type: 0x1b, size: 256 * 1024, ramSize: 8192 }));
  const m = createMbc(cart);
  const s = m.getState();
  assert.equal(s.ram, null, 'RAM nobody wrote is omitted');
  assert.ok(snapSize(s) < 200, `${snapSize(s)} bytes`);
  m.write(0x0000, 0x0a); m.write(0xa000, 1);
  assert.ok(m.getState().ram, 'once written, it travels');
});

test('gbmbc: summarizeGbRom says something a status bar can show', () => {
  const s = summarizeGbRom(parseGbRom(buildGbRom({ title: 'ZELDA', type: 0x1b, ramSize: 8192 })));
  assert.match(s, /ZELDA/);
  assert.match(s, /MBC5/);
  assert.match(s, /battery/);
});

// ---- gbppu -----------------------------------------------------------------

test('gbppu: STAT reports mode 0 while the LCD is off but keeps the LYC bit', () => {
  const p = new GbPpu({});
  p.lyc = 0;
  p.tick(4);
  assert.equal(p.readReg(0xff41) & 0x04, 0x04, 'LY=LYC=0');
  p.writeReg(0xff40, 0x11);                   // LCD off
  assert.equal(p.readReg(0xff41) & 0x03, 0, 'no mode without a clock');
  assert.equal(p.readReg(0xff41) & 0x04, 0x04, 'the comparison bit is latched');
  p.lyc = 5;
  assert.equal(p.readReg(0xff41) & 0x04, 0x04, 'and changing LYC while off does nothing');
});

test('gbppu: a frame is 154 lines of 456 dots and vblank is an edge', () => {
  const p = new GbPpu({});
  let vblanks = 0;
  for (let i = 0; i < 456 * 154 / 4; i++) {
    p.tick(4);
    if (p.vblankReq) { vblanks++; p.vblankReq = false; assert.equal(p.ly, 144); }
  }
  assert.equal(vblanks, 1);
  assert.equal(p.ly, 0);
});

test('gbppu: the STAT interrupt is the rising edge of an OR, not four sources', () => {
  const p = new GbPpu({});
  p.writeReg(0xff41, 0x08 | 0x20);            // HBlank + OAM
  let n = 0;
  for (let i = 0; i < 456 / 4; i++) { p.tick(4); if (p.statReq) { n++; p.statReq = false; } }
  assert.equal(n, 2, 'one per source per line, not one per dot');
});

test('gbppu: state round-trips', () => {
  const p = new GbPpu({ cgb: true });
  for (let i = 0; i < 1000; i++) p.tick(4);
  p.vram[0x100] = 0x5a; p.oam[4] = 0x33;
  const s = p.getState();
  const q = new GbPpu({ cgb: true });
  q.setState(s);
  assert.deepEqual(q.getState(), s);
});

// ---- gbapu -----------------------------------------------------------------

test('gbapu: the frame sequencer is a state machine, not a timer', () => {
  const a = new GbApu({});
  a.write(0xff26, 0x80);
  a.write(0xff11, 0x3f);                      // length 1
  a.write(0xff12, 0xf0);                      // DAC on
  a.write(0xff14, 0xc0 | 0x80);               // trigger, length enabled
  assert.equal(a.read(0xff26) & 1, 1, 'channel 1 is on');
  for (let i = 0; i < 16; i++) a.frameSequencerStep();
  assert.equal(a.read(0xff26) & 1, 0, 'and goes off when the length expires');
});

test('gbapu: powering down clears the registers but not the wave RAM', () => {
  const a = new GbApu({});
  a.write(0xff26, 0x80);
  a.write(0xff30, 0xab);
  a.write(0xff24, 0x77);
  a.write(0xff26, 0x00);
  assert.equal(a.read(0xff24), 0x00);
  assert.equal(a.read(0xff30), 0xab);
  assert.equal(a.read(0xff26) & 0x80, 0);
});

test('gbapu: the noise channel is deterministic', () => {
  const mk = () => {
    const a = new GbApu({});
    a.write(0xff26, 0x80); a.write(0xff21, 0xf0); a.write(0xff22, 0x00); a.write(0xff23, 0x80);
    const out = [];
    for (let i = 0; i < 200; i++) { a.tick(64); out.push(a.ch4.lfsr); }
    return out;
  };
  assert.deepEqual(mk(), mk());
});

test('gbapu: state round-trips and the samples continue', () => {
  const a = new GbApu({});
  a.write(0xff26, 0x80); a.write(0xff12, 0xf0); a.write(0xff14, 0x87);
  for (let i = 0; i < 5000; i++) a.tick(4);
  const s = a.getState();
  const want = new Float32Array(64);
  for (let i = 0; i < 5000; i++) a.tick(4);
  a.render(want, 64);
  const b = new GbApu({});
  b.setState(s);
  for (let i = 0; i < 5000; i++) b.tick(4);
  const got = new Float32Array(64);
  b.render(got, 64);
  assert.deepEqual([...got], [...want]);
});

// ---- machinegb: the contract the host builds on ----------------------------

// A tiny ROM that does something observable: count in work RAM, enable the
// vblank interrupt, and change a background scroll register so the picture is
// a function of how long it has run.
function counterRom() {
  const code = [
    0x3e, 0x01, 0xe0, 0xff,       // LD A,1 ; LDH ($FF),A   IE = vblank
    0xfb,                         // EI
    0x21, 0x00, 0xc0,             // LD HL,$C000
    0x34,                         // INC (HL)
    0x7e,                         // LD A,(HL)
    0xe0, 0x43,                   // LDH ($43),A            SCX = counter
    0x18, 0xfa,                   // JR -6
  ];
  return buildGbRom({ code, title: 'COUNTER' });
}

test('machinegb: the contract', () => {
  const gb = new GbMachine({ rom: counterRom() });
  assert.equal(typeof gb.stepFrame, 'function');
  assert.equal(typeof gb.snapshot, 'function');
  assert.equal(typeof gb.restore, 'function');
  assert.equal(typeof gb.render, 'function');
  assert.equal(typeof gb.renderAudio, 'function');
  assert.equal(gb.schemaVersion, 1);
  assert.equal(gb.frame, 0);
  gb.stepFrame();
  assert.equal(gb.frame, 1);
  const img = gb.render();
  assert.equal(img.width, SCREEN_W);
  assert.equal(img.height, SCREEN_H);
  assert.equal(img.rgb.length, SCREEN_W * SCREEN_H * 3);
  const idx = gb.render({ indexed: true, analog: true });
  assert.equal(idx.pixels.length, SCREEN_W * SCREEN_H);
  assert.equal(idx.drive.length, SCREEN_W * SCREEN_H * 3);
});

test('machinegb: a frame is the right number of cycles', () => {
  const gb = new GbMachine({ rom: counterRom() });
  const before = gb.cpu.cycles;
  gb.stepFrame();
  const n = gb.cpu.cycles - before;
  assert.ok(Math.abs(n - 70224 / 4) < 8, `${n} M-cycles in a frame`);
  assert.ok(Math.abs(FRAME_HZ - 59.7275) < 0.001);
});

test('machinegb: the same input twice gives the same state', () => {
  const run = () => {
    const gb = new GbMachine({ rom: counterRom() });
    for (let i = 0; i < 40; i++) {
      if (i === 10) gb.padDown(BUTTON.A);
      if (i === 20) gb.padUp(BUTTON.A);
      gb.stepFrame();
    }
    return gb;
  };
  const a = run(), b = run();
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.deepEqual([...b.render().rgb], [...a.render().rgb]);
});

test('machinegb: snapshot, run ahead, restore, replay — identical', () => {
  const gb = new GbMachine({ rom: counterRom() });
  for (let i = 0; i < 30; i++) gb.stepFrame();
  const s = gb.snapshot();
  for (let i = 0; i < 25; i++) gb.stepFrame();
  const want = gb.snapshot();
  const wantImg = [...gb.render().rgb];
  gb.restore(s);
  for (let i = 0; i < 25; i++) gb.stepFrame();
  assert.deepEqual(gb.snapshot(), want);
  assert.deepEqual([...gb.render().rgb], wantImg, 'and the picture too');
});

test('machinegb: a replay that has an interrupt in it', () => {
  // The worst case for a snapshot: input arrives after the snapshot was taken,
  // and the interrupt it causes has to land in the same place on the replay.
  const gb = new GbMachine({ rom: counterRom() });
  for (let i = 0; i < 20; i++) gb.stepFrame();
  const s = gb.snapshot();
  const play = () => {
    for (let i = 0; i < 30; i++) {
      if (i === 5) gb.setPad(1 << BUTTON.START);   // joypad interrupt
      if (i === 9) gb.setPad(0);
      gb.stepFrame();
    }
    return gb.snapshot();
  };
  const want = play();
  gb.restore(s);
  assert.deepEqual(play(), want);
});

test('machinegb: a snapshot carries no ROM, and is small', () => {
  const gb = new GbMachine({ rom: counterRom() });
  for (let i = 0; i < 60; i++) gb.stepFrame();
  const s = gb.snapshot();
  const size = snapSize(s);
  // WRAM 8K + VRAM 8K + OAM 160 + HRAM 127 + a few hundred scalars.
  assert.ok(size > 16000 && size < 24000, `snapshot is ${size} bytes`);
  const json = JSON.stringify(s, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
  assert.equal(json.includes('"rom"'), false, 'no ROM in the snapshot');
});

test('machinegb: a Color cartridge gets a Color, and its snapshot is bigger', () => {
  const gb = new GbMachine({ rom: buildGbRom({ code: [0x18, 0xfe], cgb: true }) });
  assert.equal(gb.cgb, true);
  assert.equal(gb.cpu.a, 0x11, 'the boot register that tells a game which console it is on');
  for (let i = 0; i < 10; i++) gb.stepFrame();
  const size = snapSize(gb.snapshot());
  assert.ok(size > 45000 && size < 60000, `CGB snapshot is ${size} bytes`);
});

test('machinegb: the joypad reads zero for a pressed button', () => {
  const gb = new GbMachine({ rom: counterRom() });
  gb._writeIo(0xff00, 0x10);                  // select the button row
  assert.equal(gb._readJoypad() & 0x0f, 0x0f);
  gb.padDown(BUTTON.START);
  assert.equal(gb._readJoypad() & 0x08, 0, 'START pulls its line low');
  assert.ok(gb.iflags & 0x10, 'and requests the joypad interrupt');
});

test('machinegb: the timer is a bit of the divider, so writing DIV can tick it', () => {
  const gb = new GbMachine({ rom: counterRom() });
  gb._writeIo(0xff07, 0x05);                  // enable, 262144 Hz (bit 3)
  gb.divCounter = 0x0008;                     // selected bit high
  gb._timerBitPrev = true;
  gb.tima = 0;
  gb._writeIo(0xff04, 0x00);                  // reset → falling edge
  assert.equal(gb.tima, 1);
});

// ---- the host's transport, headless ---------------------------------------
// The Seta machine passed every contract test in this file and still landed on
// the wrong frame 61 times out of 250 when the host rewound, because its
// picture was a function of history rather than of state. The only test that
// catches that is this one: drive the same ring the host drives, then check
// that a restored-and-redrawn frame is the frame that was captured.

test('machinegb: the host rewind ring replays to the same picture', () => {
  const gb = new GbMachine({ rom: counterRom() });
  const REWIND_EVERY = 6;
  const ring = [];
  for (let f = 0; f < 600; f++) {
    gb.stepFrame();
    if (f % REWIND_EVERY === 0) ring.push({ frame: gb.frame, snap: gb.snapshot(), rgb: [...gb.render().rgb] });
  }
  assert.equal(ring.length, 100);
  let mismatches = 0;
  for (let i = ring.length - 1; i >= 0; i--) {
    gb.restore(ring[i].snap);
    const rgb = [...gb.render().rgb];
    if (gb.frame !== ring[i].frame) mismatches++;
    else for (let k = 0; k < rgb.length; k++) if (rgb[k] !== ring[i].rgb[k]) { mismatches++; break; }
  }
  assert.equal(mismatches, 0, `${mismatches}/${ring.length} slots came back as a different frame`);
});

test('machinegb: fast-forward is the same emulation, only sooner', () => {
  // The host multiplies dt rather than skipping work, so ×4 for a quarter of
  // the time has to land on exactly the state ×1 would have reached.
  const slow = new GbMachine({ rom: counterRom() });
  for (let i = 0; i < 120; i++) slow.update(1 / 60);
  const fast = new GbMachine({ rom: counterRom() });
  for (let i = 0; i < 30; i++) fast.update(4 / 60);
  assert.equal(fast.frame, slow.frame);
  assert.deepEqual(fast.snapshot().cpu, slow.snapshot().cpu);
});

test('machinegb: audio comes out as plain samples at the requested rate', () => {
  const gb = new GbMachine({ rom: counterRom(), sampleRate: 44100 });
  for (let i = 0; i < 10; i++) gb.stepFrame();
  const buf = new Float32Array(4096);
  const n = gb.renderAudio(buf, buf.length);
  assert.ok(n > 6000 / 10 * 0.5, `${n} samples for 10 frames`);
  for (const v of buf.subarray(0, n)) assert.ok(v >= -1.01 && v <= 1.01);
});

// ---------------------------------------------------------------------------
// The real thing. These need no environment variable and no download: the
// ROMs are in gbroms/ under the MIT licence (see gbroms/README.md).

const GBROMS = new URL('./gbroms/', import.meta.url).pathname;
const haveRoms = existsSync(join(GBROMS, 'mooneye', 'acceptance'));

function collectRoms(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...collectRoms(p));
    else if (/\.gbc?(\.gz)?$/i.test(e.name)) out.push(p);
  }
  return out.sort();
}

// The tests that are written for hardware this emulator is not: a DMG 0, a
// Game Boy Pocket, a Super Game Boy. They are SUPPOSED to fail here, and
// pretending otherwise would be the dishonest way to make the number look
// better. Everything else in the list is a real, open hole — see
// docs/gb-design.md §11.
const OTHER_MODEL = [
  'boot_div-S', 'boot_div-dmg0', 'boot_div2-S', 'boot_hwio-S', 'boot_hwio-dmg0',
  'boot_regs-dmg0', 'boot_regs-mgb', 'boot_regs-sgb', 'boot_regs-sgb2',
];
const KNOWN_FAIL = [
  'oam_dma/reg_read', 'oam_dma_start',
  'ppu/intr_2_mode0_timing_sprites', 'ppu/lcdon_timing-GS', 'ppu/lcdon_write_timing-GS',
  'ppu/stat_lyc_onoff', 'serial/boot_sclk_align-dmgABCmgb',
];

test('mooneye: the acceptance suite', { skip: !haveRoms }, () => {
  const dir = join(GBROMS, 'mooneye', 'acceptance');
  const roms = collectRoms(dir);
  assert.equal(roms.length, 75, 'the bundled suite is complete');
  const failed = [];
  for (const rom of roms) {
    const name = rom.slice(dir.length + 1).replace(/\.gb(\.gz)?$/, '');
    const r = runTest(rom, { frames: 900, model: 'dmg' });
    if (!judgeMooneye(r).pass) failed.push(name);
  }
  const unexpected = failed.filter((n) => !OTHER_MODEL.includes(n) && !KNOWN_FAIL.includes(n));
  const fixed = [...OTHER_MODEL, ...KNOWN_FAIL].filter((n) => !failed.includes(n));
  assert.deepEqual(unexpected, [], 'a regression');
  assert.deepEqual(fixed.filter((n) => !OTHER_MODEL.includes(n)), [],
    'something started passing — good, but update KNOWN_FAIL and the docs');
  assert.equal(roms.length - failed.length, 59, '59/75, of which 9 are for other hardware');
});

test('mooneye: the MBC suite', { skip: !haveRoms }, () => {
  const dir = join(GBROMS, 'mooneye', 'emulator-only');
  const roms = collectRoms(dir);
  const failed = [];
  for (const rom of roms) {
    const r = runTest(rom, { frames: 900, model: 'dmg' });
    if (!judgeMooneye(r).pass) failed.push(rom.slice(dir.length + 1).replace(/\.gb(\.gz)?$/, ''));
  }
  // MBC1 multicarts are told apart from ordinary 8Mb MBC1 cartridges by a
  // heuristic on the ROM contents, which is not implemented — see §11.
  assert.deepEqual(failed, ['mbc1/multicart_rom_8Mb']);
  assert.equal(roms.length - failed.length, 27);
});

test('dmg-acid2: the picture matches the reference exactly', { skip: !haveRoms }, () => {
  const res = compareAcid2(join(GBROMS, 'dmg-acid2.gb.gz'), join(GBROMS, 'dmg-acid2-reference.png'));
  assert.equal(res.diff, 0, `${res.diff}/${res.total} pixels differ`);
});

test('dmg-acid2 also exercises the rewind ring on a real ROM', { skip: !haveRoms }, () => {
  const gb = new GbMachine({ cart: loadRom(join(GBROMS, 'dmg-acid2.gb.gz')), model: 'dmg' });
  const ring = [];
  for (let f = 0; f < 120; f++) {
    gb.stepFrame();
    ring.push({ frame: gb.frame, snap: gb.snapshot(), rgb: [...gb.render().rgb] });
  }
  for (let i = 0; i < ring.length; i += 7) {
    gb.restore(ring[i].snap);
    assert.equal(gb.frame, ring[i].frame);
    assert.deepEqual([...gb.render().rgb], ring[i].rgb, `slot ${i}`);
  }
});
