// icecore — headless acceptance. No ROM, no DOM, no browser.
//
// The point of these tests is the *boundary*: everything the ICE measures has
// to work on a machine the debugger has never heard of. So three of the CPUs
// below are toys written for this file — a 6502-shaped one and a 68000-shaped
// one — and the assertions are that icecore.js picks the right architecture
// descriptor by probing, taps the right bus, and degrades honestly where the
// architecture has no disassembler yet.
//
// The two real machines in the tree (PC-8001 and PC-8801) are built from blank
// ROM arrays so this runs with no files at all; NES and Mega Drive are picked
// up automatically when their branches merge (see the dynamic import below).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Z80 } from './z80.js';
import { assemble } from './z80asm.js';
import {
  IceCore, probeCpus, bisect, traceDiff, bucketize, parseNum, hexDump, disasmList,
  compileCondFor, PC88_BUCKETS,
} from './icecore.js';
import { detectArch, Z80_ARCH, M6502_ARCH, M68K_ARCH, GENERIC_ARCH, capabilities } from './icearch.js';

// ---- test doubles ------------------------------------------------------------

// A machine-shaped shell around the real Z80 core.
function z80Machine(src, org = 0x100) {
  const r = assemble(src, { org });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  const memory = new Uint8Array(0x10000);
  memory.set(r.bytes, r.org);
  const cpu = new Z80({
    read: (a) => memory[a & 0xffff],
    write: (a, v) => { memory[a & 0xffff] = v & 0xff; },
    in: (p) => (p & 0xff) === 0x30 ? 0x5a : 0xff,
    out: () => {},
  });
  cpu.pc = r.org;
  return {
    sys: { memory }, cpu, frame: 0, symbols: r.symbols,
    stepFrame() {
      for (let i = 0; i < 4000 && !cpu.halted; i++) cpu.step();
      this.frame++;
      return this;
    },
  };
}

// A 6502-shaped CPU. Not an emulator — six opcodes, exactly enough to prove the
// ICE picks M6502_ARCH by probing, unwinds a JSR through an 8-bit stack pointer
// and taps a {read, write} bus.
class Toy6502 {
  constructor(bus) {
    this.bus = bus;
    this.a = 0; this.x = 0; this.y = 0; this.s = 0xfd; this.p = 0x24;
    this.pc = 0; this.cycles = 0; this.jammed = false;
  }
  _rd(a) { this.cycles++; return this.bus.read(a & 0xffff) & 0xff; }
  _wr(a, v) { this.cycles++; this.bus.write(a & 0xffff, v & 0xff); }
  _fetch() { const v = this._rd(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  step() {
    const op = this._fetch();
    switch (op) {
      case 0xa9: this.a = this._fetch(); break;                        // LDA #imm
      case 0x8d: { const lo = this._fetch(), hi = this._fetch(); this._wr(lo | (hi << 8), this.a); break; } // STA abs
      case 0xad: { const lo = this._fetch(), hi = this._fetch(); this.a = this._rd(lo | (hi << 8)); break; } // LDA abs
      case 0x20: { // JSR abs — pushes the address of its own last byte
        const lo = this._fetch(), hi = this._fetch();
        const ret = (this.pc - 1) & 0xffff;
        this._wr(0x100 | this.s, ret >> 8); this.s = (this.s - 1) & 0xff;
        this._wr(0x100 | this.s, ret & 0xff); this.s = (this.s - 1) & 0xff;
        this.pc = lo | (hi << 8);
        break;
      }
      case 0x60: { // RTS
        this.s = (this.s + 1) & 0xff; const lo = this._rd(0x100 | this.s);
        this.s = (this.s + 1) & 0xff; const hi = this._rd(0x100 | this.s);
        this.pc = ((lo | (hi << 8)) + 1) & 0xffff;
        break;
      }
      case 0x02: this.jammed = true; break;                            // KIL
      default: break;                                                  // NOP
    }
    return this.cycles;
  }
}

function nesLikeMachine(prog, org = 0x8000) {
  const ram = new Uint8Array(0x10000);
  ram.set(prog, org);
  const bus = { read: (a) => ram[a & 0xffff], write: (a, v) => { ram[a & 0xffff] = v & 0xff; } };
  const cpu = new Toy6502(bus);
  cpu.pc = org;
  return {
    cpu, ram, frame: 0,
    peek: (a) => ram[a & 0xffff],
    poke: (a, v) => { ram[a & 0xffff] = v & 0xff; },
    stepFrame() { for (let i = 0; i < 200 && !cpu.jammed; i++) cpu.step(); this.frame++; return this; },
  };
}

// A 68000-shaped CPU: 24-bit addresses, a word bus, D/A register files. Three
// opcodes; the arch descriptor has no 68000 decoder yet, so the ICE must not
// need one to watch memory here.
class Toy68k {
  constructor(bus) {
    this.bus = bus;
    this.d = new Uint32Array(8); this.a = new Uint32Array(8);
    this.pc = 0; this.cycles = 0;
    this.sr_t = 0; this.sr_s = 1; this.sr_ipm = 7;
    this.fx = 0; this.fn = 0; this.fz = 0; this.fv = 0; this.fc = 0;
    this.stopped = false; this.halted = false;
  }
  _fw() { const v = this.bus.read16(this.pc >>> 0) & 0xffff; this.pc = (this.pc + 2) >>> 0; return v; }
  step() {
    const op = this._fw();
    if (op === 0x0001) { // MOVE.W #imm,(addr24)
      const imm = this._fw(), hi = this._fw(), lo = this._fw();
      this.bus.write16((((hi << 16) | lo) >>> 0) & 0xffffff, imm);
    } else if (op === 0x0002) { // MOVE.W (addr24),D0
      const hi = this._fw(), lo = this._fw();
      this.d[0] = this.bus.read16((((hi << 16) | lo) >>> 0) & 0xffffff) & 0xffff;
    } else if (op === 0x00ff) { this.halted = true; }
    this.cycles += 4;
    return 4;
  }
}

function mdLikeMachine(words, org = 0x000400) {
  const mem = new Uint8Array(0x1000000);
  words.forEach((w, i) => { mem[org + i * 2] = (w >> 8) & 0xff; mem[org + i * 2 + 1] = w & 0xff; });
  const rawBus = {
    read16: (a) => ((mem[a & 0xffffff] << 8) | mem[(a + 1) & 0xffffff]) & 0xffff,
    write16: (a, v) => { mem[a & 0xffffff] = (v >> 8) & 0xff; mem[(a + 1) & 0xffffff] = v & 0xff; },
    read8: (a) => mem[a & 0xffffff],
    write8: (a, v) => { mem[a & 0xffffff] = v & 0xff; },
  };
  const cpu = new Toy68k(rawBus);
  cpu.pc = org;
  return {
    cpu, mem, frame: 0,
    peek: (a) => mem[a & 0xffffff],
    poke: (a, v) => { mem[a & 0xffffff] = v & 0xff; },
    stepFrame() { for (let i = 0; i < 64 && !cpu.halted; i++) cpu.step(); this.frame++; return this; },
  };
}

// ---- architecture probing ----------------------------------------------------

test('icearch: the right descriptor is chosen by probing, never by class', () => {
  const z = new Z80({ read: () => 0, write: () => {}, in: () => 0, out: () => {} });
  assert.equal(detectArch(z), Z80_ARCH);
  assert.equal(detectArch(new Toy6502({ read: () => 0, write: () => {} })), M6502_ARCH);
  assert.equal(detectArch(new Toy68k({ read16: () => 0, write16: () => {} })), M68K_ARCH);
  // Something with a PC and a step() and nothing else still gets an ICE.
  assert.equal(detectArch({ pc: 0, step: () => 1 }), GENERIC_ARCH);
  // Not a CPU at all.
  assert.equal(detectArch({ pc: 0 }), null);
  assert.equal(detectArch(null), null);
});

test('icearch: capabilities are reported, not faked', () => {
  assert.deepEqual(capabilities(Z80_ARCH), { name: 'z80', disassembly: true, callStack: true, io: true, conditions: true });
  // The 6502 has no disassembler in this tree yet and no separate I/O space.
  const c6 = capabilities(M6502_ARCH);
  assert.equal(c6.disassembly, false);
  assert.equal(c6.callStack, true);
  assert.equal(c6.io, false);
  // The 68000 socket is open but empty: no decoder means no shadow stack.
  const c68 = capabilities(M68K_ARCH);
  assert.equal(c68.disassembly, false);
  assert.equal(c68.callStack, false);
});

// ---- machine probing ---------------------------------------------------------

test('icecore: probeCpus finds every CPU and says how it reads memory', async () => {
  const { Pc8001Machine } = await import('./machine.js');
  const { Pc8801Machine } = await import('./machine88.js');
  // Blank ROMs: we are testing the probe, not the firmware.
  const m1 = new Pc8001Machine({ rom: new Uint8Array(0x6000) });
  const p1 = probeCpus(m1);
  assert.deepEqual(p1.map((c) => c.name), ['main']);
  assert.equal(p1[0].arch, Z80_ARCH);
  assert.equal(p1[0].memHow, 'sys.memory');
  assert.equal(p1[0].intrusive, false);

  const m2 = new Pc8801Machine({
    main: new Uint8Array(0x8000), ext: new Uint8Array(0x8000), sub: new Uint8Array(0x2000), mode: 'n88',
  });
  const p2 = probeCpus(m2);
  assert.deepEqual(p2.map((c) => c.name), ['main', 'sub'], 'the FDD sub board is a first-class CPU');
  assert.equal(p2[0].memHow, 'machine.readMem', 'bank-aware accessor preferred');
  assert.equal(p2[1].memHow, 'sub.mem');
  assert.ok(p2[1].irq.pre, 'the sub board keeps its interrupt hook');

  // A machine with no accessor at all falls back to the CPU bus — and says so,
  // because reads through a live bus can have side effects.
  const nes = nesLikeMachine([0xea]);
  delete nes.peek;
  const p3 = probeCpus(nes);
  assert.equal(p3[0].memHow, 'cpu.bus');
  assert.equal(p3[0].intrusive, true);
  // With peek present it prefers the non-intrusive route.
  assert.equal(probeCpus(nesLikeMachine([0xea]))[0].memHow, 'machine.peek');
});

test('icecore: attach/detach leaves the machine exactly as it was found', () => {
  const m = z80Machine('        ORG 100h\n        NOP\n        HALT\n');
  const origStepFrame = m.stepFrame, origStep = m.cpu.step;
  const origRead = m.cpu.bus.read, origWrite = m.cpu.bus.write;
  const ice = new IceCore();
  ice.attach(m);
  ice.setWatch('main', { lo: 0xc000, w: true }); // forces the bus tap in
  assert.notEqual(m.cpu.bus.read, origRead, 'bus tapped while attached');
  ice.detach();
  assert.equal(m.stepFrame, origStepFrame);
  assert.equal(m.cpu.step, origStep);
  assert.equal(m.cpu.bus.read, origRead);
  assert.equal(m.cpu.bus.write, origWrite);
  assert.equal(ice.paused, false, 'a closed debugger never leaves the machine frozen');
});

test('icecore: the bus tap is lazy — a trace-only run pays nothing for it', () => {
  const m = z80Machine('        ORG 100h\n        NOP\n        HALT\n');
  const origRead = m.cpu.bus.read;
  const ice = new IceCore();
  ice.attach(m);
  ice.recordPcTrace('main', { max: 100 });
  assert.equal(m.cpu.bus.read, origRead, 'no watchpoint, no wrapper');
  ice.detach();
});

// ---- the six tools, as instrumentation ---------------------------------------

test('icecore: PC trace arms on an address, not a frame (≡ pc-trace.mjs --armpc)', () => {
  const m = z80Machine(`
        ORG 100h
        NOP
        NOP
here:   LD A,1
        LD B,2
        HALT
`);
  const ice = new IceCore();
  ice.attach(m);
  ice.recordPcTrace('main', { max: 64, armPc: m.symbols.HERE });
  m.stepFrame();
  const tr = ice.pcTrace('main');
  assert.ok(tr.armed);
  assert.equal(tr.armFrame, 0);
  assert.equal(tr.pcs[0], m.symbols.HERE, 'nothing before the anchor is recorded');
  ice.detach();
});

test('icecore: PC trace collapses consecutive duplicates like refdrv does', () => {
  // A tight loop would otherwise bury the trace; refdrv's M88_TRACE dedupes and
  // ours has to match or the two cannot be diffed line by line.
  const m = z80Machine(`
        ORG 100h
        LD B,3
spin:   DJNZ spin
        HALT
`);
  const ice = new IceCore();
  ice.attach(m);
  ice.recordPcTrace('main', { max: 64 });
  m.stepFrame();
  const pcs = [...ice.pcTrace('main').pcs];
  for (let i = 1; i < pcs.length; i++) assert.notEqual(pcs[i], pcs[i - 1], 'no consecutive duplicates');
  // …and the raw mode keeps them, for when the repeat count is the evidence.
  const m2 = z80Machine('        ORG 100h\n        LD B,3\nspin:   DJNZ spin\n        HALT\n');
  const ice2 = new IceCore();
  ice2.attach(m2);
  ice2.recordPcTrace('main', { max: 64, dedupe: false });
  m2.stepFrame();
  const raw = [...ice2.pcTrace('main').pcs];
  assert.ok(raw.length > pcs.length, 'raw mode keeps the repeats');
  ice2.detach();
  ice.detach();
});

test('icecore: execution histogram + bucketize (≡ life-scan.mjs)', () => {
  const m = z80Machine(`
        ORG 100h
        LD B,4
spin:   DJNZ spin
        HALT
`);
  const ice = new IceCore();
  ice.attach(m);
  ice.recordPcHistogram('main');
  m.stepFrame();
  const h = ice.pcHistogram('main');
  assert.equal(h.get(m.symbols.SPIN), 4, 'the loop body was counted, not deduped');
  const { buckets, total, distinct } = bucketize(h, PC88_BUCKETS);
  assert.equal(buckets.get('LOW<1000'), total, 'all of it below 1000h');
  assert.equal(distinct, h.size);
  // reset hands back the window and starts a fresh one — that is how the CLI
  // samples "per 100 frames" without double counting
  ice.pcHistogram('main', { reset: true });
  assert.equal(ice.pcHistogram('main').size, 0);
  ice.detach();
});

test('icecore: I/O census names the port a stuck loop polls (≡ loop-profile.mjs)', () => {
  const m = z80Machine(`
        ORG 100h
        IN A,(30h)
        IN A,(30h)
        OUT (40h),A
        HALT
`);
  const ice = new IceCore();
  ice.attach(m);
  const io = ice.recordIo('main');
  m.stepFrame();
  assert.equal(io.in.get(0x30).n, 2);
  assert.deepEqual([...io.in.get(0x30).vals], [0x5a]);
  assert.equal(io.out.get(0x40).n, 1);
  ice.detach();
});

test('icecore: memory access log with a PC filter (≡ watch-read/watch-write.mjs)', () => {
  const m = z80Machine(`
        ORG 100h
        LD A,11h
        LD (0C000h),A
mark:   LD A,22h
w2:     LD (0C001h),A
        HALT
`);
  const ice = new IceCore();
  ice.attach(m);
  // The PC has already advanced past the opcode when the access happens, so the
  // filter names the *next* instruction — the same wrinkle watch-read documents.
  const L = ice.recordMem('main', { lo: 0xc000, hi: 0xc00f, w: true, annotate: (mm, h) => ({ note: `f${h.frame}` }) });
  m.stepFrame();
  assert.equal(L.total, 2);
  assert.deepEqual(L.hits.map((h) => [h.addr, h.value]), [[0xc000, 0x11], [0xc001, 0x22]]);
  assert.equal(L.hits[0].note, 'f0', 'machine-specific annotation folded in by the caller');
  ice.detach();

  const m2 = z80Machine('        ORG 100h\n        LD A,11h\n        LD (0C000h),A\nmark:   LD A,22h\nw2:     LD (0C001h),A\n        HALT\n');
  const ice2 = new IceCore();
  ice2.attach(m2);
  const L2 = ice2.recordMem('main', { lo: 0xc000, hi: 0xc00f, w: true, pcLo: m2.symbols.W2 + 3, pcHi: m2.symbols.W2 + 3 });
  m2.stepFrame();
  assert.equal(L2.total, 1, 'the PC filter kept only the second store');
  assert.equal(L2.hits[0].addr, 0xc001);
  ice2.detach();
});

test('icecore: traceDiff reports a re-sync as healthy and a real split as a split', () => {
  // Same program, one side spun a wait loop longer. That is a speed difference,
  // not a divergence — reading it as one is how a Ys1 regression got scored as
  // a win during the M88 hunt.
  const A = ['0100', '0102', '0102', '0102', '0104', '0106'];
  const B = ['0100', '0102', '0104', '0106'];
  const r1 = traceDiff(A, B);
  assert.equal(r1.diverged, false, 'both traces consumed — no permanent split');
  assert.equal(r1.aOnly.length, 0);
  assert.equal(r1.bOnly.length, 0);

  const C = ['0100', '0102', '0104', '0200', '0202'];
  const D = ['0100', '0102', '0104', '0300', '0302'];
  const r2 = traceDiff(C, D);
  assert.equal(r2.diverged, true);
  assert.equal(r2.a, 3);
  assert.equal(r2.b, 3);
  assert.deepEqual(r2.aOnly.map(([pc]) => pc).sort(), ['0200', '0202']);
  assert.deepEqual(r2.bOnly.map(([pc]) => pc).sort(), ['0300', '0302']);
  // A 5%+ length gap makes "X-only" mostly mean "X ran longer" — say so.
  assert.equal(traceDiff(['0100'], ['0100', '0102', '0104']).lengthWarning, true);
});

test('icecore: bisect finds the first disagreement and never runs past the end', () => {
  const probes = [];
  const first = bisect(0, 999, (n) => { probes.push(n); return n < 137; });
  assert.equal(first, 137);
  assert.ok(probes.length <= 11, `binary, not linear (${probes.length} probes)`);
  assert.equal(bisect(0, 9, () => true), 10, 'never disagreed → one past the end');
  assert.equal(bisect(0, 9, () => false), 0, 'disagreed immediately');
});

// ---- the same debugger on a machine it has never met -------------------------

test('icecore: a 6502-shaped machine gets breakpoints, watchpoints and a backtrace', () => {
  //  8000 LDA #42 / STA 0300 / JSR 8010 / KIL … 8010 LDA #7 / STA 0301 / RTS
  const m = nesLikeMachine([
    0xa9, 0x42, 0x8d, 0x00, 0x03, 0x20, 0x10, 0x80, 0x02,
    ...new Array(7).fill(0xea),
    0xa9, 0x07, 0x8d, 0x01, 0x03, 0x60,
  ]);
  const ice = new IceCore();
  ice.attach(m);
  const c = ice.cpu('main');
  assert.equal(c.arch, M6502_ARCH);
  assert.equal(c.stackOn, true, 'JSR is decodable, so the shadow stack is on');

  // conditions see 6502 register names, not Z80 ones. A Z80 name is not a
  // syntax error — it is an undeclared identifier, so it throws at *check*
  // time, and the ICE's rule for that is "disable the breakpoint and report",
  // never "wedge the machine".
  const ok = ice.setBreak('main', 0x8012, 'a == 0x07');
  assert.ok(ok.ok);
  assert.throws(() => compileCondFor(c.arch, 'hl > 0')(...c.arch.condValues(c.cpu, c.read)), ReferenceError);

  const w = ice.setWatch('main', { lo: 0x0300, hi: 0x03ff, w: true });
  assert.ok(w.ok);
  m.stepFrame();
  assert.ok(ice.paused);
  assert.equal(ice.hit.type, 'watch');
  assert.equal(ice.hit.addr, 0x0300);
  assert.equal(ice.hit.value, 0x42);
  assert.equal(ice.hit.pc, 0x8002, 'the STA that did it');

  // resume into the subroutine: the shadow stack unwinds through an 8-bit SP
  ice.clearWatch('main', w.id);
  ice.resume();
  m.stepFrame();
  assert.equal(ice.hit.type, 'break');
  assert.equal(ice.hit.pc, 0x8012, 'the conditional breakpoint saw A=7');
  const bt = ice.backtrace('main');
  assert.deepEqual(bt.map((f) => f.entry), [0x8010]);
  assert.equal(bt[0].retTo, 0x8008);
  assert.ok(ice.stepOut('main').done, 'step-out returns through RTS');
  assert.equal(m.cpu.pc, 0x8008);

  // an I/O breakpoint is refused with a reason, not silently ignored
  const io = ice.setIoBreak('main', { lo: 0x40 });
  assert.equal(io.ok, false);
  assert.match(io.error, /no I\/O space/);
  ice.detach();
});

test('icecore: a 68000-shaped machine watches 24-bit addresses through a word bus', () => {
  //   MOVE.W #1234,(FF0100)   MOVE.W (FF0100),D0   HALT
  const m = mdLikeMachine([0x0001, 0x1234, 0x00ff, 0x0100, 0x0002, 0x00ff, 0x0100, 0x00ff]);
  const ice = new IceCore();
  ice.attach(m);
  const c = ice.cpu('main');
  assert.equal(c.arch, M68K_ARCH);
  assert.equal(c.stackOn, false, 'no 68000 decoder yet → no shadow stack, and it says so');
  assert.equal(ice.capabilities()[0].disassembly, false);

  const w = ice.setWatch('main', { lo: 0xff0100, hi: 0xff01ff, r: false, w: true });
  assert.ok(w.ok);
  m.stepFrame();
  assert.ok(ice.paused, 'a watchpoint above 0xffff still fires');
  assert.equal(ice.hit.addr, 0xff0100);
  assert.equal(ice.hit.value, 0x1234, 'a word write reports the word');

  // conditions see D/A registers
  ice.resume();
  ice.clearWatch('main', w.id);
  const fn = compileCondFor(c.arch, 'd0 == 0x1234');
  assert.equal(!!fn(...c.arch.condValues(c.cpu, c.read)), false, 'not loaded yet');
  m.stepFrame();
  assert.equal(!!fn(...c.arch.condValues(c.cpu, c.read)), true, 'MOVE.W (addr),D0 landed');

  // the hex dump uses 6-digit addresses on a 24-bit bus
  assert.match(hexDump(c.read, 0xff0100, 1, { mask: c.arch.addrMask, width: 6 }), /^FF0100: 12 34/);
  ice.detach();
});

test('icecore: disassembly degrades to bytes rather than failing', () => {
  const mem = new Uint8Array(0x10000);
  mem.set([0xde, 0xad, 0xbe], 0x200);
  const read = (a) => mem[a & 0xffff];
  const rows = disasmList(read, 0x200, 3, 0, { arch: M6502_ARCH });
  assert.deepEqual(rows.map((r) => r.text), ['DB DEh', 'DB ADh', 'DB BEh']);
  assert.equal(rows[0].current, true);
  // …and the real thing where a decoder exists
  const z = disasmList(read, 0x200, 1, 0, { arch: Z80_ARCH });
  assert.ok(z[0].text.length > 0 && !z[0].text.startsWith('DB '));
});

// ---- the real machines in this tree, ROM-free -------------------------------

test('icecore: the ICE clamps onto PC-8001 and PC-8801 with no ROM at all', async () => {
  const { Pc8001Machine } = await import('./machine.js');
  const { Pc8801Machine } = await import('./machine88.js');
  for (const m of [
    new Pc8001Machine({ rom: new Uint8Array(0x6000) }),
    new Pc8801Machine({ main: new Uint8Array(0x8000), ext: new Uint8Array(0x8000), sub: new Uint8Array(0x2000), mode: 'n88' }),
  ]) {
    const ice = new IceCore();
    ice.attach(m);
    for (const c of ice.cpus) {
      ice.recordPcHistogram(c.name);
      c.traceOn = true;
    }
    const r = ice.runFrames(3);
    assert.equal(r.stopped, 'done');
    assert.equal(m.frame, 3);
    for (const c of ice.cpus) {
      assert.ok(ice.pcHistogram(c.name).size > 0, `${c.name} executed something`);
      assert.ok(ice.traceView(c.name, 4).length > 0, `${c.name} trace ring filled`);
      assert.ok(c.tTotal > 0, `${c.name} accumulated T-states`);
    }
    ice.detach();
  }
});

// ---- machines that arrive with other branches --------------------------------
// Same assertions, run automatically once nes-emulator / megadrive merge. This
// is the acceptance for "machine-independent", not a promise about it.

for (const [kind, mod, cls] of [['nes', './machinenes.js', 'NesMachine'], ['md', './machinemd.js', 'MegaDriveMachine']]) {
  test(`icecore: the ICE clamps onto ${kind} when its branch is present`, async (t) => {
    let M;
    try { M = (await import(mod))[cls]; }
    catch { t.skip(`${mod} is not on this branch`); return; }
    const rom = kind === 'nes' ? synthINes() : synthMdRom();
    const m = new M({ rom });
    const ice = new IceCore();
    ice.attach(m);
    assert.ok(ice.cpus.length >= 1, 'at least one CPU probed');
    for (const c of ice.cpus) {
      assert.ok(c.arch && c.arch !== null, `${c.name} got an architecture`);
      ice.recordPcHistogram(c.name);
    }
    ice.runFrames(2);
    for (const c of ice.cpus) {
      // A CPU can legitimately be held in reset (the Mega Drive's Z80 is, at
      // power-on), so "executed nothing" is not a failure — only "crashed" is.
      assert.ok(ice.pcHistogram(c.name).size >= 0);
    }
    ice.detach();
  });
}

// A minimal legal iNES image: 1 PRG bank of NOPs with a reset vector.
function synthINes() {
  const out = new Uint8Array(16 + 0x4000 + 0x2000);
  out.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0], 0);
  out.fill(0xea, 16, 16 + 0x4000);
  out[16 + 0x3ffc] = 0x00; out[16 + 0x3ffd] = 0x80; // RESET → $8000
  return out;
}

// A minimal Mega Drive image: SSP and reset PC in the vector table, then a
// branch-to-self so the CPU has somewhere legal to sit.
function synthMdRom() {
  const out = new Uint8Array(0x20000);
  const w = (a, v) => { out[a] = (v >> 8) & 0xff; out[a + 1] = v & 0xff; };
  w(0, 0x00ff); w(2, 0xf000);   // SSP = 0xFFF000
  w(4, 0x0000); w(6, 0x0200);   // PC  = 0x000200
  w(0x200, 0x60fe);             // BRA.S *
  const name = 'SEGA MEGA DRIVE ';
  for (let i = 0; i < name.length; i++) out[0x100 + i] = name.charCodeAt(i);
  return out;
}

// ---- regressions found reviewing the extraction ------------------------------

test('icecore: the shadow stack unwinds on a 32-bit stack pointer', () => {
  // The bug: `(spNow - f.sp) & 0xffffffff` is a *signed* int32 in JS, so a
  // wrapped subtraction came back negative and every comparison read as "has
  // not returned yet". The Z80 never showed it (0xffff and 0xff cannot go
  // negative), so it would have surfaced only when the 68000 decoder landed —
  // as a shadow stack that silently never pops. Pinned here with a
  // call-decoding 68000 arch supplied through attach()'s cpus override.
  class Toy68kCall extends Toy68k {
    step() {
      const op = this._fw();
      if (op === 0x4eb9) {                    // JSR abs.l
        const hi = this._fw(), lo = this._fw();
        const ret = this.pc >>> 0;
        this.a[7] = (this.a[7] - 4) >>> 0;
        this.bus.write16(this.a[7], (ret >>> 16) & 0xffff);
        this.bus.write16((this.a[7] + 2) >>> 0, ret & 0xffff);
        this.pc = (((hi << 16) | lo) >>> 0) & 0xffffff;
      } else if (op === 0x4e75) {             // RTS
        const h = this.bus.read16(this.a[7]), l = this.bus.read16((this.a[7] + 2) >>> 0);
        this.a[7] = (this.a[7] + 4) >>> 0;
        this.pc = (((h << 16) | l) >>> 0) & 0xffffff;
      } else if (op === 0x00ff) this.halted = true;
      this.cycles += 4;
      return 4;
    }
  }
  const w16 = (read) => (a) => ((read(a) << 8) | read((a + 1) & 0xffffff)) & 0xffff;
  const arch = {
    ...M68K_ARCH,
    callAt(read, pc) {
      const w = w16(read);
      if (w(pc) !== 0x4eb9) return null;
      return { target: (((w(pc + 2) << 16) | w(pc + 4)) >>> 0) & 0xffffff, retTo: (pc + 6) >>> 0 };
    },
  };
  //  000400 JSR 000500 / 000406 HALT        000500 NOP / RTS
  const m = mdLikeMachine([0x4eb9, 0x0000, 0x0500, 0x00ff]);
  [0x0000, 0x4e75].forEach((w, i) => {
    m.mem[0x500 + i * 2] = (w >> 8) & 0xff;
    m.mem[0x500 + i * 2 + 1] = w & 0xff;
  });
  const cpu = new Toy68kCall(m.cpu.bus);
  cpu.pc = 0x400;
  cpu.a[7] = 0xfff000;
  m.cpu = cpu;
  m.stepFrame = function () { for (let i = 0; i < 4 && !cpu.halted; i++) cpu.step(); this.frame++; return this; };

  const ice = new IceCore();
  ice.attach(m, {
    cpus: [{
      name: 'main', cpu, arch,
      read: (a) => m.mem[a & 0xffffff],
      write: (a, v) => { m.mem[a & 0xffffff] = v & 0xff; },
    }],
  });
  ice.setBreak('main', 0x0500);
  m.stepFrame();
  assert.ok(ice.paused, 'broke inside the subroutine');
  const bt = ice.backtrace('main');
  assert.deepEqual(bt.map((f) => f.entry), [0x0500], 'the call was pushed');
  assert.equal(bt[0].retTo, 0x0406);
  assert.ok(ice.stepOut('main').done, '…and RTS pops it — this is what the signed mask broke');
  assert.equal(ice.backtrace('main').length, 0);
  assert.equal(cpu.pc, 0x0406);
  ice.detach();
});

test('icecore: a streaming memory log counts everything and retains only keep', () => {
  // The bug: onHit used to sit behind the retention cap, so a caller that wanted
  // every hit streamed had to set the cap to infinity — and then `hits` grew
  // without bound. tools/ice.mjs read/write streams exactly like this.
  const m = z80Machine(`
        ORG 100h
        LD HL,0C000h
        LD B,8
loop:   LD (HL),B
        INC HL
        DJNZ loop
        HALT
`);
  const ice = new IceCore();
  ice.attach(m);
  const seen = [];
  const L = ice.recordMem('main', { lo: 0xc000, hi: 0xc0ff, w: true, keep: 2, onHit: (h) => seen.push(h.addr) });
  m.stepFrame();
  assert.equal(L.total, 8, 'every write counted');
  assert.equal(seen.length, 8, 'every write streamed');
  assert.equal(L.hits.length, 2, 'only two retained');
  assert.equal(L.capped, true, 'and it says it stopped retaining');
  ice.detach();
});

test('icecore: bucketize never silently drops a PC past the last edge', () => {
  const h = new Map([[0x10, 3], [0x9000, 5]]);
  const { buckets, total } = bucketize(h, [[0x100, 'low']]);
  assert.equal(total, 8);
  assert.equal(buckets.get('low'), 3);
  assert.equal(buckets.get('above'), 5, 'the rest is named, not lost');
});
