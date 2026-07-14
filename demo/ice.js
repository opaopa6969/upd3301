// ice — an ICE-style debugger that clamps onto a *live* machine in another
// window. demo/ice.html opens from machine.html and grabs
// window.opener.__machine; everything here works from the outside: no core
// file is touched, the hooks are method wraps installed at attach() and
// removed at detach().
//
// The wrap trick: machine.stepFrame and cpu.step are replaced on the machine
// *instance*. While paused, stepFrame returns immediately, so the host page's
// rAF loop spins without advancing the world (its update(dt) still drains the
// accumulator — no catch-up burst on resume). A breakpoint fires inside
// cpu.step by throwing a sentinel that the stepFrame wrap catches — that
// aborts the frame mid-slice, exactly what an ICE does when it yanks WAIT.
//
// Breakpoints are per-CPU (main / FDD sub board) and optionally conditional:
// the condition is a JS expression compiled once with new Function, seeing
// registers (a f b c d e h l af bc de hl ix iy sp pc i r im iff1) and
// mem(addr). A condition that throws disables its breakpoint and reports —
// better than silently breaking (or not breaking) forever.

import { disasm } from '../z80dis.js';
import { assemble } from '../z80asm.js';
import { analyze, exportSource } from '../z80anal.js';
import { PORTS_PC88_MAIN, PORTS_PC88_SUB } from '../z80anal.js';
import { regionAt, pinPresets, estimateUnused } from '../memmap.js';
import { labelMap, commentFor } from '../romlabels.js';
import {
  parsePattern, searchBytes, ChangeSearch, textVramModel, attrShort,
  thinTimeline, timelineView,
} from './ice-tools.js';

export const BREAK = Symbol('ice-break');

export const hex = (v, w) => (v ?? 0).toString(16).toUpperCase().padStart(w, '0');

export function parseNum(s) {
  // ICE culture: bare digits are hex. 0x…, …h, and #decimal also accepted.
  if (typeof s !== 'string') return null;
  const x = s.trim();
  if (!x) return null;
  let m;
  if ((m = /^0[xX]([0-9A-Fa-f]+)$/.exec(x))) return parseInt(m[1], 16);
  if ((m = /^([0-9A-Fa-f]+)[hH]$/.exec(x))) return parseInt(m[1], 16);
  if ((m = /^#([0-9]+)$/.exec(x))) return parseInt(m[1], 10);
  if ((m = /^([0-9A-Fa-f]+)$/.exec(x))) return parseInt(m[1], 16);
  return null;
}

export function compileCond(cond) {
  // new Function: compiled once, no scope capture — the expression only sees
  // the registers and mem() we hand it on each check
  return new Function(
    'a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'af', 'bc', 'de', 'hl',
    'ix', 'iy', 'sp', 'pc', 'i', 'r', 'im', 'iff1', 'mem',
    `return (${cond});`
  );
}

// watch/IO-break conditions additionally see the access itself: value, and
// addr (the address or port that was touched)
export function compileAccessCond(cond) {
  return new Function(
    'value', 'addr',
    'a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'af', 'bc', 'de', 'hl',
    'ix', 'iy', 'sp', 'pc', 'i', 'r', 'im', 'iff1', 'mem',
    `return (${cond});`
  );
}

export class IceController {
  constructor() {
    this.machine = null;
    this.paused = false;
    this.hit = null;
    this.cpus = [];
    this._origStepFrame = null;
    this._origKeys = null;
    this.replaying = false; // breakpoints hold their fire during a replay
    this.onInput = null; // (type, frame, row, bit) — the time-travel input log
    // set inside a bus callback mid-instruction; the step wrap turns it into
    // a clean break AFTER the instruction completes (never abort mid-opcode —
    // that would leave the CPU half-executed and determinism in pieces)
    this.pendingBreak = null;
    this._accessId = 0;
  }

  cpu(name) { return this.cpus.find((c) => c.name === name) ?? null; }

  attach(machine) {
    this.detach();
    this.machine = machine;
    this.paused = false;
    this.hit = null;
    this.cpus = [];
    const self = this;
    // memory access adapts to whichever machine shape we got:
    // Pc8801Machine has readMem/writeMem (bank-aware), Pc8001Machine
    // exposes the flat text-system memory
    const mainRead = typeof machine.readMem === 'function'
      ? (a) => machine.readMem(a & 0xffff)
      : (a) => machine.sys?.memory?.[a & 0xffff] ?? 0xff;
    const mainWrite = typeof machine.writeMem === 'function'
      ? (a, v) => machine.writeMem(a & 0xffff, v & 0xff)
      : (a, v) => { if (machine.sys?.memory) machine.sys.memory[a & 0xffff] = v & 0xff; };
    if (machine.cpu) {
      this._addCpu('main', machine.cpu, mainRead, mainWrite, {
        post: () => machine._serviceInterrupts?.(), // mirror stepFrame's per-step IRQ check
      });
    }
    if (machine.sub?.cpu) {
      this._addCpu('sub', machine.sub.cpu,
        (a) => machine.sub.mem[a & 0x7fff] ?? 0xff,
        (a, v) => { machine.sub.mem[a & 0x7fff] = v & 0xff; },
        { pre: () => { if (machine.sub.fdc?.intLine) machine.sub.cpu.intRequest(0x00); } }); // same as Pc80s31.run
    }
    if (typeof machine.stepFrame === 'function') {
      const orig = machine.stepFrame;
      this._origStepFrame = orig;
      machine.stepFrame = function (...args) {
        if (self.paused) return machine; // frozen: the host rAF loop spins harmlessly
        try { return orig.apply(this, args); }
        catch (e) { if (e !== BREAK) throw e; return machine; }
      };
    }
    // input taps: replaying a deterministic machine only works if the key
    // events are re-injected on the same frames they originally landed on
    if (typeof machine.keyDown === 'function' && typeof machine.keyUp === 'function') {
      const kd = machine.keyDown, ku = machine.keyUp;
      this._origKeys = { kd, ku };
      machine.keyDown = function (row, bit) {
        self.onInput?.(0, machine.frame, row, bit);
        return kd.call(machine, row, bit);
      };
      machine.keyUp = function (row, bit) {
        self.onInput?.(1, machine.frame, row, bit);
        return ku.call(machine, row, bit);
      };
    }
  }

  detach() {
    if (this.machine) {
      if (this._origStepFrame) this.machine.stepFrame = this._origStepFrame;
      if (this._origKeys) {
        this.machine.keyDown = this._origKeys.kd;
        this.machine.keyUp = this._origKeys.ku;
      }
    }
    for (const c of this.cpus) {
      c.cpu.step = c.origStep;
      if (c.origBus) { // untap the bus
        c.origBus.bus.read = c.origBus.read;
        c.origBus.bus.write = c.origBus.write;
        c.origBus.bus.in = c.origBus.in;
        c.origBus.bus.out = c.origBus.out;
      }
    }
    this._origStepFrame = null;
    this._origKeys = null;
    this.machine = null;
    this.cpus = [];
    this.paused = false; // never leave a closed debugger holding the machine frozen
    this.hit = null;
    this.pendingBreak = null;
  }

  rawKey(type, row, bit) { // replay injection — bypasses the recording tap
    if (!this._origKeys || !this.machine) return;
    (type === 0 ? this._origKeys.kd : this._origKeys.ku).call(this.machine, row, bit);
  }

  _addCpu(name, cpu, read, write, irq = {}) {
    const self = this;
    const origStep = cpu.step;
    const TRACE_CAP = 4096;
    const entry = {
      name, cpu, read, write, origStep, irq,
      bps: new Map(), skipOnce: -1,
      watches: [], // {id, lo, hi, r, w, cond, fn, enabled, error}
      iobps: [], // {id, lo, hi, in, out, cond, fn, enabled, error}
      tTotal: 0, // T-states executed since attach (clock / wall-time display)
      stackOn: true, // shadow call stack (backtrace / step-out) — always cheapish
      profOn: false, // T accounting into the routines map
      profData: { stack: [], routines: new Map(), rootSelf: 0 },
      traceOn: true, // instruction trace ring
      trace: {
        cap: TRACE_CAP, n: 0,
        pc: new Uint16Array(TRACE_CAP), af: new Uint16Array(TRACE_CAP),
        bc: new Uint16Array(TRACE_CAP), de: new Uint16Array(TRACE_CAP),
        hl: new Uint16Array(TRACE_CAP), sp: new Uint16Array(TRACE_CAP),
        frame: new Uint32Array(TRACE_CAP),
      },
      // executed-PC coverage (main only) — feeds memmap.estimateUnused
      coverage: name === 'main' ? new Uint8Array(0x10000) : null,
      origBus: null,
    };

    // bus taps: watchpoints and I/O breaks see every CPU access without the
    // core knowing. ICE's own peeks (hex dump, disasm) use entry.read, which
    // bypasses the bus — the debugger never trips its own wire. DMA pulls go
    // through dmac.readMemory, also outside the bus: watchpoints are a CPU
    // instrument, by design.
    const bus = cpu.bus;
    if (bus) {
      entry.origBus = { bus, read: bus.read, write: bus.write, in: bus.in, out: bus.out };
      bus.read = (a) => {
        const v = entry.origBus.read(a);
        if (entry.watches.length && !self.replaying) self._accessCheck(entry, entry.watches, a & 0xffff, v & 0xff, 'r', 'watch');
        return v;
      };
      bus.write = (a, v) => {
        entry.origBus.write(a, v);
        if (entry.watches.length && !self.replaying) self._accessCheck(entry, entry.watches, a & 0xffff, v & 0xff, 'w', 'watch');
      };
      bus.in = (p) => {
        const v = entry.origBus.in(p);
        if (entry.iobps.length && !self.replaying) self._accessCheck(entry, entry.iobps, p & 0xff, v & 0xff, 'in', 'io');
        return v;
      };
      bus.out = (p, v) => {
        entry.origBus.out(p, v);
        if (entry.iobps.length && !self.replaying) self._accessCheck(entry, entry.iobps, p & 0xff, v & 0xff, 'out', 'io');
      };
    }

    cpu.step = function () {
      if (!self.replaying) { // breakpoints hold their fire during a replay
        const bp = entry.bps.get(cpu.pc);
        if (bp && bp.enabled) {
          if (entry.skipOnce === cpu.pc) entry.skipOnce = -1; // resuming off this bp
          else {
            let fire = true;
            if (bp.fn) {
              try {
                fire = !!bp.fn(cpu.a, cpu.f, cpu.b, cpu.c, cpu.d, cpu.e, cpu.h, cpu.l,
                  cpu.af, cpu.bc, cpu.de, cpu.hl, cpu.ix, cpu.iy, cpu.sp, cpu.pc,
                  cpu.i, cpu.r, cpu.im, cpu.iff1, entry.read);
              } catch (e) {
                bp.enabled = false; // a broken condition must not wedge the machine
                bp.error = String(e?.message ?? e);
                fire = false;
              }
            }
            if (fire) {
              self.paused = true;
              self.hit = { cpu: name, pc: cpu.pc };
              entry.skipOnce = -1;
              throw BREAK;
            }
          }
        } else if (entry.skipOnce !== cpu.pc) entry.skipOnce = -1;
      }
      const pcB = cpu.pc, spB = cpu.sp;
      if (entry.traceOn) { // ring: pre-execution state of every instruction
        const tr = entry.trace, i2 = tr.n % tr.cap;
        tr.pc[i2] = pcB;
        tr.af[i2] = cpu.af; tr.bc[i2] = cpu.bc; tr.de[i2] = cpu.de;
        tr.hl[i2] = cpu.hl; tr.sp[i2] = spB;
        tr.frame[i2] = self.machine?.frame ?? 0;
        tr.n++;
      }
      if (entry.coverage) entry.coverage[pcB] = 1;
      // shadow call stack: detect CALL/RST before executing, confirm after
      // (conditional calls only push when actually taken). Unwind by SP, so
      // RET variants / popped return addresses / interrupts all resolve
      // without opcode bookkeeping.
      let target = -1, retTo = 0;
      if (entry.stackOn) {
        const op = entry.read(pcB) & 0xff;
        if (op === 0xcd || (op & 0xc7) === 0xc4) {
          target = (entry.read((pcB + 1) & 0xffff) | (entry.read((pcB + 2) & 0xffff) << 8)) & 0xffff;
          retTo = (pcB + 3) & 0xffff;
        } else if ((op & 0xc7) === 0xc7) { target = op & 0x38; retTo = (pcB + 1) & 0xffff; } // RST
      }
      const t = origStep.call(cpu);
      entry.tTotal += t;
      if (entry.stackOn) {
        const P = entry.profData;
        const top = P.stack[P.stack.length - 1];
        if (top) top.self += t; else P.rootSelf += t;
        if (target >= 0 && cpu.pc === target && cpu.sp === ((spB - 2) & 0xffff) && P.stack.length < 512) {
          P.stack.push({ entry: target, sp: cpu.sp, retTo, self: 0, child: 0 });
          if (entry.profOn) {
            let r = P.routines.get(target);
            if (!r) { r = { calls: 0, self: 0, total: 0 }; P.routines.set(target, r); }
            r.calls++;
          }
        }
        while (P.stack.length) { // unwind every frame whose return slot is gone
          const f = P.stack[P.stack.length - 1];
          const d = (cpu.sp - f.sp) & 0xffff;
          if (d < 2 || d >= 0x8000) break;
          P.stack.pop();
          const tot = f.self + f.child;
          if (entry.profOn) {
            let r = P.routines.get(f.entry);
            if (!r) { r = { calls: 0, self: 0, total: 0 }; P.routines.set(f.entry, r); }
            r.self += f.self;
            r.total += tot;
          }
          const nt = P.stack[P.stack.length - 1];
          if (nt) nt.child += tot;
        }
      }
      if (self.pendingBreak) { // a watch/IO tap fired inside this instruction
        const pb = self.pendingBreak;
        self.pendingBreak = null;
        pb.pc = pcB; // the instruction that did the deed
        self.paused = true;
        self.hit = pb;
        throw BREAK;
      }
      return t;
    };
    this.cpus.push(entry);
  }

  // shared checker for watchpoints (rw: r/w) and I/O breaks (rw: in/out)
  _accessCheck(entry, list, addr, value, rw, type) {
    if (this.pendingBreak) return; // first hit of the instruction wins
    for (const w of list) {
      if (!w.enabled) continue;
      if (!w[rw]) continue;
      if (addr < w.lo || addr > w.hi) continue;
      if (w.fn) {
        const cpu = entry.cpu;
        let ok = false;
        try {
          ok = !!w.fn(value, addr,
            cpu.a, cpu.f, cpu.b, cpu.c, cpu.d, cpu.e, cpu.h, cpu.l,
            cpu.af, cpu.bc, cpu.de, cpu.hl, cpu.ix, cpu.iy, cpu.sp, cpu.pc,
            cpu.i, cpu.r, cpu.im, cpu.iff1, entry.read);
        } catch (e) {
          w.enabled = false; // a broken condition must not wedge the machine
          w.error = String(e?.message ?? e);
          continue;
        }
        if (!ok) continue;
      }
      this.pendingBreak = { type, cpu: entry.name, addr, value, rw, id: w.id };
      return;
    }
  }

  _addAccessBreak(list, { lo, hi = null, cond = null, ...flags }) {
    let fn = null;
    if (cond) {
      try { fn = compileAccessCond(cond); }
      catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    }
    const id = ++this._accessId;
    list.push({ id, lo: lo & 0xffff, hi: (hi ?? lo) & 0xffff, cond, fn, enabled: true, error: null, ...flags });
    return { ok: true, id };
  }

  setWatch(name, { lo, hi = null, r = false, w = true, cond = null }) {
    const c = this.cpu(name);
    if (!c) return { ok: false, error: 'no such CPU' };
    return this._addAccessBreak(c.watches, { lo, hi, cond, r, w });
  }

  setIoBreak(name, { lo, hi = null, dirIn = false, dirOut = true, cond = null }) {
    const c = this.cpu(name);
    if (!c) return { ok: false, error: 'no such CPU' };
    return this._addAccessBreak(c.iobps, { lo: lo & 0xff, hi: (hi ?? lo) & 0xff, cond, in: dirIn, out: dirOut });
  }

  clearWatch(name, id) {
    const c = this.cpu(name);
    if (c) c.watches = c.watches.filter((x) => x.id !== id);
  }

  clearIoBreak(name, id) {
    const c = this.cpu(name);
    if (c) c.iobps = c.iobps.filter((x) => x.id !== id);
  }

  // shadow-stack backtrace, innermost first: [{entry, retTo, sp}]
  backtrace(name) {
    const c = this.cpu(name);
    if (!c) return [];
    return [...c.profData.stack].reverse().map((f) => ({ entry: f.entry, retTo: f.retTo ?? 0, sp: f.sp }));
  }

  // run until the current shadow frame returns. Falls back to the SP
  // heuristic (run until SP rises above here) when the stack is empty —
  // e.g. right after attach, before any CALL was observed.
  stepOut(name) {
    const c = this.cpu(name);
    if (!c) return { done: false };
    const depth0 = c.profData.stack.length;
    const sp0 = c.cpu.sp;
    const hit0 = this.hit;
    let budget = 2_000_000;
    let first = true;
    while (budget-- > 0) {
      // the first step walks off the breakpoint we're parked on; after
      // that, breakpoints stay armed on the way out
      this.stepInto(name, first);
      first = false;
      if (this.hit !== hit0) return { done: false, brk: true };
      if (depth0 > 0) {
        if (c.profData.stack.length < depth0) return { done: true };
      } else {
        const d = (c.cpu.sp - sp0) & 0xffff;
        if (d >= 2 && d < 0x8000) return { done: true }; // return slot consumed
      }
    }
    return { done: false, budget: false };
  }

  // trace ring, oldest→newest: [{pc, af, bc, de, hl, sp, frame}]
  traceView(name, count = 32) {
    const c = this.cpu(name);
    if (!c) return [];
    const tr = c.trace;
    const n = Math.min(count, tr.n, tr.cap);
    const out = [];
    for (let k = tr.n - n; k < tr.n; k++) {
      const i = k % tr.cap;
      out.push({
        pc: tr.pc[i], af: tr.af[i], bc: tr.bc[i], de: tr.de[i],
        hl: tr.hl[i], sp: tr.sp[i], frame: tr.frame[i],
      });
    }
    return out;
  }

  traceClear(name) {
    const c = this.cpu(name);
    if (c) c.trace.n = 0;
  }

  profReset(name) {
    const c = this.cpu(name);
    if (c) c.profData = { stack: [], routines: new Map(), rootSelf: 0 };
  }

  setBreak(name, addr, cond = null) {
    const c = this.cpu(name);
    if (!c) return { ok: false, error: 'no such CPU' };
    let fn = null;
    if (cond) {
      try { fn = compileCond(cond); }
      catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    }
    c.bps.set(addr & 0xffff, { cond, fn, enabled: true, error: null });
    return { ok: true };
  }

  clearBreak(name, addr) { this.cpu(name)?.bps.delete(addr & 0xffff); }

  pause() { this.paused = true; }

  resume() {
    // stepping off a breakpoint: give the instruction under the cursor one
    // free pass, or we'd break forever on the same spot
    for (const c of this.cpus) if (c.bps.has(c.cpu.pc)) c.skipOnce = c.cpu.pc;
    this.paused = false;
    this.hit = null;
  }

  stepInto(name, skipBp = true) {
    // goes through the wrapped step so T-states and the profiler see manual
    // steps too; skipOnce keeps a breakpoint under the cursor quiet
    const c = this.cpu(name);
    if (!c) return 0;
    if (skipBp) c.skipOnce = c.cpu.pc;
    c.irq.pre?.();
    let t = 0;
    try { t = c.cpu.step(); } catch (e) { if (e !== BREAK) throw e; }
    c.irq.post?.();
    return t;
  }

  stepOver(name) {
    const c = this.cpu(name);
    if (!c) return { done: false };
    const d = disasm(c.read, c.cpu.pc);
    if (!/^(CALL|RST)\b/.test(d.text)) { this.stepInto(name); return { done: true }; }
    const target = (c.cpu.pc + d.len) & 0xffff;
    const hit0 = this.hit;
    this.stepInto(name);
    let budget = 2_000_000; // a runaway callee must not hang the debugger
    while (c.cpu.pc !== target && budget-- > 0) {
      this.stepInto(name, false); // callee breakpoints stay armed
      if (this.hit !== hit0) return { done: false, brk: true };
    }
    return { done: c.cpu.pc === target, budget: budget > 0 };
  }

  // deterministic re-execution: restore was done by the caller, this runs
  // forward to targetFrame re-injecting the logged inputs on their frames
  replayTo(targetFrame, inputLog) {
    const m = this.machine;
    if (!m || !this._origStepFrame) return;
    this.replaying = true;
    this.paused = false;
    try {
      let guard = 100000;
      while (m.frame < targetFrame && guard-- > 0) {
        for (const ev of inputLog) if (ev[0] === m.frame) this.rawKey(ev[1], ev[2], ev[3]);
        try { this._origStepFrame.call(m); } catch (e) { if (e !== BREAK) throw e; }
      }
    } finally {
      this.replaying = false;
      this.paused = true;
    }
  }

  frameStep() {
    if (!this._origStepFrame || !this.machine) return;
    for (const c of this.cpus) if (c.bps.has(c.cpu.pc)) c.skipOnce = c.cpu.pc;
    this.paused = false;
    try { this._origStepFrame.call(this.machine); }
    catch (e) { if (e !== BREAK) throw e; }
    this.paused = true;
  }
}

// ---- pure view models --------------------------------------------------------

export function writeReg(cpu, name, v) {
  const n = String(name).toLowerCase();
  if (['af', 'bc', 'de', 'hl', 'ix', 'iy', 'sp', 'pc'].includes(n)) { cpu[n] = v & 0xffff; return true; }
  if (n === 'i' || n === 'r') { cpu[n] = v & 0xff; return true; }
  if (n === 'im') { cpu.im = Math.min(2, Math.max(0, v | 0)); return true; }
  return false;
}

export const REG_FIELDS = [
  ['PC', 4], ['SP', 4], ['AF', 4], ['BC', 4], ['DE', 4], ['HL', 4],
  ['IX', 4], ['IY', 4], ['I', 2], ['R', 2], ['IM', 1],
];

export function regsModel(cpu) {
  const s = cpu.getState();
  const val = {
    PC: s.pc, SP: s.sp, AF: (s.a << 8) | s.f, BC: (s.b << 8) | s.c,
    DE: (s.d << 8) | s.e, HL: (s.h << 8) | s.l, IX: s.ix, IY: s.iy,
    I: s.i, R: s.r, IM: s.im,
  };
  const flags = 'SZ5H3PNC'.split('').map((ch, i) => ((s.f & (0x80 >> i)) ? ch : '·')).join('');
  const sh = s.shadow;
  return {
    val,
    flags,
    info: `F ${flags}  IFF ${s.iff1 ? 1 : 0}${s.iff2 ? 1 : 0}${s.halted ? '  ⏸HALT' : ''}`,
    shadow: `AF' ${hex((sh.a << 8) | sh.f, 4)}  BC' ${hex((sh.b << 8) | sh.c, 4)}`
      + `  DE' ${hex((sh.d << 8) | sh.e, 4)}  HL' ${hex((sh.h << 8) | sh.l, 4)}`,
  };
}

// disassembly window around pc: walk back a few candidate offsets until one
// lands exactly on pc (instructions are ≤4 bytes, so a resync is usually
// found), then decode forward
export function disasmList(read, pc, count = 16, back = 6, opts = {}) {
  pc &= 0xffff;
  let pre = [];
  for (let off = Math.min(back * 4, 32); off >= 1; off--) {
    let a = (pc - off) & 0xffff;
    const rows = [];
    while (a !== pc && ((pc - a) & 0xffff) <= off) {
      const d = disasm(read, a, opts);
      rows.push({ addr: a, text: d.text, len: d.len, bytes: d.bytes, current: false });
      a = (a + d.len) & 0xffff;
    }
    if (a === pc && rows.length > pre.length) {
      pre = rows.slice(-back);
      if (pre.length >= back) break;
    }
  }
  const rows = pre;
  let a = pc;
  while (rows.length < count) {
    const d = disasm(read, a, opts);
    rows.push({ addr: a, text: d.text, len: d.len, bytes: d.bytes, current: a === pc });
    a = (a + d.len) & 0xffff;
  }
  if (opts.label) for (const r of rows) r.label = opts.label(r.addr) ?? null;
  return rows;
}

export function hexDump(read, addr, rows = 16) {
  const lines = [];
  for (let r = 0; r < rows; r++) {
    const base = (addr + r * 16) & 0xffff;
    let hx = '', asc = '';
    for (let i = 0; i < 16; i++) {
      const v = read((base + i) & 0xffff) & 0xff;
      hx += hex(v, 2) + (i === 7 ? '  ' : ' ');
      asc += v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : '·';
    }
    lines.push(`${hex(base, 4)}: ${hx} ${asc}`);
  }
  return lines.join('\n');
}

// ---- the page ------------------------------------------------------------------
// ---- the page ------------------------------------------------------------------
// mountIcePage(document, env) wires the static skeleton in ice.html. env:
//   getMachine()     → the live machine (opener's __machine) or null
//   openerAlive()    → false when the parent window is gone
//   raf(cb)          → requestAnimationFrame (injectable for headless smoke)
//   t(s)             → i18n
//   storage          → { get(k), set(k,v) } (localStorage in the browser)
//   download(name,s) → save text as a file (Blob+<a> in the browser)
export function mountIcePage(doc, env) {
  const $ = (id) => doc.getElementById(id);
  const t = env.t ?? ((s) => s);
  const storage = env.storage ?? { get: () => null, set: () => {} };
  const ctrl = new IceController();
  const state = {
    active: 'main',
    memAddr: 0,
    syntax: 'zilog',
    savedBps: { main: new Map(), sub: new Map() }, // survive machine reboots
    labels: new Map(), // addr → name: user labeling + merged asm symbols
    labelsKey: null,
    lastAsm: null,
    editing: null, // { field, input } while a register cell is being typed into
    disFocus: null, // backtrace-frame view override for the disasm window
    watchExprs: [], // live watch expressions {expr, fn, error}
    changeSearch: new ChangeSearch(),
    // ROM annotation presets (romlabels.js): per-CPU, user labels win
    presets: { main: new Map(), sub: new Map() },
  };
  const lang = env.lang ?? 'ja';
  // time travel: snapshot nodes form a tree; branches are born when you
  // resume from the past. Needs machine.snapshot()/restore() in the core.
  const SNAP_EVERY = 30, SNAP_CAP = 80, SNAP_RECENT = 8; // ≈4s of dense history
  const tl = {
    nodes: new Map(), rootId: 0, current: 0, next: 1,
    inputLog: [], treeVer: 0, renderVer: -1,
    expanded: new Set(), // fold-rows the user clicked open
  };
  const ttOK = (m) => typeof m?.snapshot === 'function' && typeof m?.restore === 'function';

  const els = {};
  for (const id of ['conn', 'minfo', 'clock', 'tabmain', 'tabsub', 'bpause', 'bcont', 'bstep',
    'bover', 'bstepout', 'bframe', 'bsyntax', 'regs', 'reginfo', 'regshadow', 'dis', 'memaddr', 'mem',
    'memregion', 'waddr', 'wdata', 'bwrite', 'bpaddr', 'bpcond', 'bpbtn', 'bplist', 'fdc', 'fdcbox',
    'asrc', 'aorg', 'basm', 'bsetpc', 'brun', 'aout', 'anal',
    'btundo', 'btredo', 'btsnap', 'tree', 'ttinfo',
    'bprof', 'bprofreset', 'prof', 'stack',
    'laddr', 'lname', 'bladd', 'blexport', 'blimport',
    'exps', 'expe', 'expo', 'bexp', 'bexpsave', 'bexpwrite', 'exptext', 'pinnote',
    'bpromasm', 'bpromexp',
    'walo', 'wahi', 'war', 'waw', 'wacond', 'bwadd', 'wlist',
    'iosel', 'iolo', 'iohi', 'ioin', 'ioout', 'iocond', 'bioadd', 'iolist',
    'spat', 'bsearch', 'sres', 'bcsinit', 'bcsne', 'bcseq', 'bcsgt', 'bcslt',
    'csval', 'bcsval', 'csinfo', 'csres', 'bunused', 'unusedout',
    'wxexpr', 'bwxadd', 'wxlist',
    'trace', 'btrace', 'btraceclr', 'vram', 'vraminfo', 'metabox', 'presetnote']) {
    els[id] = $(id);
  }

  const activeCpu = () => ctrl.cpu(state.active) ?? ctrl.cpus[0] ?? null;
  // label resolution: the user's own names shadow the ROM presets
  const presetAt = (a) => state.presets[state.active]?.get(a & 0xffff) ?? null;
  const labelOf = (a) => state.labels.get(a & 0xffff) ?? presetAt(a)?.name ?? null;
  const kindOf = (m) => (m?.sys ? 'pc8001' : 'pc8801'); // for memmap lookups
  const regionText = (addr) => {
    const m = ctrl.machine;
    if (!m || state.active !== 'main') return '';
    const r = regionAt(kindOf(m), addr & 0xffff);
    if (!r) return '';
    return `${r.name} [${r.kind}]` + (r.confidence !== 'verified' ? ` (${r.confidence})` : '');
  };

  // --- register cells (click to edit while paused) -------------------------
  const regCells = new Map();
  for (const [name, width] of REG_FIELDS) {
    const cell = doc.createElement('span');
    cell.className = 'regcell';
    cell.onclick = () => beginRegEdit(name, width, cell);
    els.regs.appendChild(cell);
    regCells.set(name, cell);
  }

  function beginRegEdit(name, width, cell) {
    if (!ctrl.paused || state.editing) return; // live registers are a moving target
    const c = activeCpu();
    if (!c) return;
    const input = doc.createElement('input');
    input.value = hex(regsModel(c.cpu).val[name], width);
    input.size = width + 1;
    input.className = 'regedit';
    const commit = (apply) => {
      if (state.editing?.input !== input) return;
      state.editing = null;
      if (apply) {
        const v = parseNum(input.value);
        if (v !== null) writeReg(c.cpu, name, v);
      }
      try { cell.removeChild(input); } catch { /* already re-rendered */ }
      renderAll();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
    };
    input.onblur = () => commit(true);
    state.editing = { field: name, input };
    cell.textContent = name + ' ';
    cell.appendChild(input);
    input.focus?.();
  }

  // --- label DB (the mini-IDA notebook) -------------------------------------
  function labelsKeyFor(m) {
    // machine kind + a fingerprint of low ROM bytes keeps sessions apart
    let h = 0;
    const rd = ctrl.cpu('main')?.read;
    for (let i = 0; i < 64; i++) h = ((h * 31) + (rd ? rd(i) & 0xff : 0)) >>> 0;
    return `ice-labels-${m.sub ? '88' : '8001'}-${h.toString(16)}`;
  }
  function loadLabels(m) {
    state.labelsKey = labelsKeyFor(m);
    state.labels = new Map();
    try {
      const raw = storage.get(state.labelsKey);
      if (raw) for (const [a, n] of JSON.parse(raw)) state.labels.set(a & 0xffff, String(n));
    } catch { /* corrupt store — start clean */ }
  }
  function saveLabels() {
    if (state.labelsKey) { try { storage.set(state.labelsKey, JSON.stringify([...state.labels])); } catch { } }
  }
  function setLabel(addr, name) {
    addr &= 0xffff;
    if (name) state.labels.set(addr, name);
    else state.labels.delete(addr);
    saveLabels();
  }

  // --- attach / reconnect ----------------------------------------------------
  function plantBps() {
    for (const c of ctrl.cpus) {
      for (const [addr, cond] of state.savedBps[c.name] ?? []) ctrl.setBreak(c.name, addr, cond);
    }
  }
  function syncAttach() {
    let m = null;
    try { m = env.getMachine(); } catch { m = null; }
    if (!m || !m.cpu) {
      if (ctrl.machine) ctrl.detach();
      const dead = env.openerAlive && env.openerAlive() === false;
      setConn(dead ? t('切断（親ウィンドウが閉じられた）') : t('マシン待ち — machine.htmlでROMを読み込んで'), 'bad');
      return null;
    }
    if (ctrl.machine !== m) {
      ctrl.attach(m);
      ctrl.onInput = (type, frame, row, bit) => { // the replay diary
        tl.inputLog.push([frame, type, row, bit]);
        if (tl.inputLog.length > 20000) tl.inputLog.splice(0, 4000); // old replays go stale, new ones stay exact
      };
      plantBps();
      if (!ctrl.cpu(state.active)) state.active = 'main';
      loadLabels(m);
      // ROM annotation presets — the analyzed understanding of the ROMs
      // (romlabels.js). User labels shadow these; deleting reverts.
      state.presets = {
        main: kindOf(m) === 'pc8801' ? labelMap('n88-fr') : new Map(),
        sub: m.sub ? labelMap('pc80s31') : new Map(),
      };
      const pm = state.presets.main.size, ps = state.presets.sub.size;
      els.presetnote.textContent = pm + ps
        ? `${t('ROM注釈プリセット')}: main ${pm} / sub ${ps} — ${t('ラベル行クリックで解説とmetaが出る')}`
        : t('（このROMの注釈プリセットは無い）');
      els.pinnote.textContent = t('pin推奨（動かせない領域）') + ': '
        + pinPresets(kindOf(m)).slice(0, 5).map((r) => `${hex(r.start, 4)}-${hex(r.end, 4)} ${r.name}`).join(' / ')
        + (pinPresets(kindOf(m)).length > 5 ? ' …' : '');
      // reset the timeline for the fresh machine
      tl.nodes.clear();
      tl.inputLog = [];
      tl.next = 1;
      tl.current = 0;
      tl.rootId = 0;
      tl.expanded.clear();
      tl.treeVer++;
      if (ttOK(m)) takeSnap(m, 0);
      updateTabs();
    }
    return m;
  }

  function setConn(text, cls) {
    els.conn.textContent = text;
    els.conn.className = 'conn ' + cls;
  }

  function updateTabs() {
    const hasSub = !!ctrl.cpu('sub');
    els.tabsub.style.display = hasSub ? '' : 'none';
    els.tabmain.className = state.active === 'main' ? 'tab on' : 'tab';
    els.tabsub.className = state.active === 'sub' ? 'tab on' : 'tab';
    els.fdcbox.style.display = hasSub && state.active === 'sub' ? '' : 'none';
    rebuildIoSel();
  }

  function rebuildIoSel() { // port-name presets from z80anal's tables
    els.iosel.textContent = '';
    const table = state.active === 'sub' ? PORTS_PC88_SUB : PORTS_PC88_MAIN;
    const opt0 = doc.createElement('option');
    opt0.value = '';
    opt0.textContent = t('（ポート名から選ぶ）');
    els.iosel.appendChild(opt0);
    for (const [lo, hi, name] of table) {
      const o = doc.createElement('option');
      o.value = `${lo}-${hi}`;
      o.textContent = `${hex(lo, 2)}${hi !== lo ? '-' + hex(hi, 2) : ''}h ${name}`;
      els.iosel.appendChild(o);
    }
  }

  // --- time travel -------------------------------------------------------------
  function snapSize(o) { // rough bytes, for the tree header
    if (o == null) return 0;
    if (typeof o === 'object' && typeof o.length === 'number' && typeof o !== 'string') {
      if (typeof o[0] === 'number' || o.length === 0) return o.length;
    }
    if (Array.isArray(o)) return o.reduce((s, x) => s + snapSize(x), 8);
    if (typeof o === 'object') return Object.values(o).reduce((s, x) => s + snapSize(x), 8);
    return 8;
  }
  function takeSnap(m, parentId, pinned = false) {
    let node;
    try {
      node = { id: tl.next++, parent: parentId, frame: m.frame, snap: m.snapshot(), children: [], pinned };
    } catch { return null; }
    node.size = snapSize(node.snap);
    tl.nodes.set(node.id, node);
    const p = tl.nodes.get(parentId);
    if (p) p.children.push(node.id);
    else tl.rootId = node.id;
    tl.current = node.id;
    tl.treeVer++;
    // rr-style thinning: dense recent past, exponentially sparse deep past.
    // Root / branch points / tips / pinned / current always survive; the
    // deterministic replay just gets a longer run-up from a sparser region.
    const { removed } = thinTimeline(tl.nodes, tl.rootId, {
      current: tl.current, keepRecent: SNAP_RECENT, cap: SNAP_CAP, baseSpacing: SNAP_EVERY,
    });
    if (removed.length) tl.treeVer++;
    return node;
  }
  function ensureWrapped(m) {
    // restore() writes into the same objects on this core, but stay paranoid:
    // if a future core swaps the cpu object, re-clamp and re-plant
    const c = ctrl.cpu('main');
    if (c && c.cpu !== m.cpu) { ctrl.attach(m); plantBps(); }
  }
  function jumpTo(id) {
    const m = ctrl.machine;
    const node = tl.nodes.get(id);
    if (!m || !node || !ttOK(m)) return;
    if (!ctrl.paused) ctrl.pause();
    m.restore(node.snap);
    ensureWrapped(m);
    tl.current = id;
    tl.treeVer++;
    renderAll();
  }
  function seekFrame(target) {
    const m = ctrl.machine;
    if (!m || !ttOK(m)) return;
    if (!ctrl.paused) ctrl.pause();
    target = Math.max(0, target);
    if (target < m.frame) { // restore the newest ancestor at or before target
      let n = tl.nodes.get(tl.current);
      while (n && n.frame > target) n = tl.nodes.get(n.parent);
      if (!n) { renderAll(); return; }
      m.restore(n.snap);
      ensureWrapped(m);
      tl.current = n.id;
      tl.treeVer++;
    }
    if (target > m.frame) ctrl.replayTo(target, tl.inputLog); // deterministic re-run
    renderAll();
  }
  function branchIfNeeded() {
    // resuming from the past (or from a node that already has a future)
    // starts a new branch under the current node
    const m = ctrl.machine;
    if (!m || !ttOK(m)) return;
    const cur = tl.nodes.get(tl.current);
    if (!cur) return;
    if (cur.frame !== m.frame || cur.children.length > 0) takeSnap(m, tl.current);
  }

  // --- rendering ---------------------------------------------------------------
  function renderRegs(c) {
    const m = regsModel(c.cpu);
    for (const [name, width] of REG_FIELDS) {
      if (state.editing?.field === name) continue; // don't clobber the input
      regCells.get(name).textContent = `${name} ${hex(m.val[name], width)}`;
    }
    els.reginfo.textContent = m.info;
    els.regshadow.textContent = m.shadow;
  }

  // disassembly lines are elements (not one <pre>) so a click can name an
  // address — the labeling gesture of the mini-IDA loop
  const disPool = [];
  function disLine(i) {
    while (disPool.length <= i) {
      const div = doc.createElement('div');
      div.className = 'disline';
      div._addr = -1;
      div.onclick = () => {
        if (div._addr < 0) return;
        els.laddr.value = hex(div._addr, 4);
        els.lname.value = labelOf(div._addr) ?? '';
        els.metabox.textContent = metaText(div._addr); // the reverse-engineer's tooltip
        els.lname.focus?.();
      };
      els.dis.appendChild(div);
      disPool.push(div);
    }
    return disPool[i];
  }

  // romlabels meta: everything we verified about a ROM routine, one glance
  function metaText(addr) {
    const pe = presetAt(addr);
    if (!pe) return '';
    const lines = [`${pe.name} — ${commentFor(pe, lang)}`
      + (pe.confidence !== 'verified' ? `  (${pe.confidence})` : '')];
    const mt = pe.meta;
    if (mt) {
      const parts = [];
      if (mt.clobbers?.length) parts.push(`${t('破壊')}: ${mt.clobbers.join(',')}`);
      if (mt.inputs?.length) parts.push(`${t('入力')}: ${mt.inputs.join(',')}`);
      if (mt.saves?.length) parts.push(`${t('保存')}: ${mt.saves.join(',')}`);
      for (const io of mt.io ?? []) {
        parts.push(`${io.dir === 'in' ? 'IN' : 'OUT'} ${io.port == null ? '(C)' : hex(io.port, 2) + 'h'}${io.name ? '(' + io.name + ')' : ''}`);
      }
      for (const mm of mt.mem ?? []) parts.push(`${mm.rw}:${hex(mm.addr, 4)}${mm.name ? '(' + mm.name + ')' : ''}`);
      if (mt.tStates) {
        parts.push(`${mt.tStates.min}${mt.tStates.max !== mt.tStates.min ? '〜' + mt.tStates.max : ''}T`
          + (mt.tStates.loop ? t('（ループ・下限のみ）') : ''));
      }
      if (parts.length) lines.push(parts.join(' / '));
      if (mt.unknown) lines.push(t('⚠ 間接フローあり — 解析は不完全'));
    }
    return lines.join('\n');
  }
  function renderDis(c) {
    const center = state.disFocus ?? c.cpu.pc; // a clicked backtrace frame wins
    const rows = disasmList(c.read, center, 20, 6, { syntax: state.syntax, label: labelOf });
    let i = 0;
    for (const r of rows) {
      if (r.label) {
        const lp = disLine(i++);
        const pe = presetAt(r.addr);
        const cm = pe ? commentFor(pe, lang) : '';
        lp.textContent = `        ${r.label}:` + (cm ? `  ; ${cm}` : '');
        lp._addr = r.addr;
        lp.className = 'disline dislabel';
      }
      const bp = c.bps.get(r.addr);
      const mark = bp ? (bp.enabled ? '●' : '○') : ' ';
      const cur = r.addr === c.cpu.pc ? '▶' : ' '; // ▶ stays on the real PC even when a frame is focused
      const bytes = r.bytes.map((b) => hex(b, 2)).join(' ').padEnd(12);
      const line = disLine(i++);
      line.textContent = `${mark}${cur} ${hex(r.addr, 4)}  ${bytes} ${r.text}`;
      line._addr = r.addr;
      line.className = 'disline' + (r.addr === c.cpu.pc ? ' discur' : '');
    }
    for (; i < disPool.length; i++) { disPool[i].textContent = ''; disPool[i]._addr = -1; }
  }

  function renderMem(c) {
    els.mem.textContent = hexDump(c.read, state.memAddr, 16);
    els.memregion.textContent = regionText(state.memAddr); // memmap annotation
    els.memregion.className = 'region' + (/approx/.test(els.memregion.textContent) ? ' approx' : '');
  }

  // --- round 2 panels ------------------------------------------------------
  function renderStack(c) {
    els.stack.textContent = '';
    const mkRow = (text, addr) => {
      const row = doc.createElement('div');
      row.className = 'stackrow';
      row.textContent = text;
      row.onclick = () => { state.disFocus = addr; renderAll(); };
      els.stack.appendChild(row);
    };
    const nm = (a) => labelOf(a) ?? hex(a, 4);
    mkRow(`#0 ▶ ${nm(c.cpu.pc)}  PC=${hex(c.cpu.pc, 4)}`, c.cpu.pc);
    const bt = ctrl.backtrace(c.name).slice(0, 16);
    bt.forEach((f, i) => {
      mkRow(`#${i + 1}  ${nm(f.entry)}  ${t('戻り先')} ${hex(f.retTo, 4)}  SP=${hex(f.sp, 4)}`, f.entry);
    });
    if (!bt.length) {
      const row = doc.createElement('div');
      row.className = 'stackrow dim';
      row.textContent = t('（CALL未観測 — attach後にCALLが実行されると積まれる）');
      els.stack.appendChild(row);
    }
  }

  function renderWatchList() {
    const c = activeCpu();
    els.wlist.textContent = '';
    for (const cc of ctrl.cpus) {
      for (const w of cc.watches) {
        const row = doc.createElement('div');
        row.className = 'listrow' + (w.enabled ? '' : ' dim');
        const range = w.lo === w.hi ? hex(w.lo, 4) : `${hex(w.lo, 4)}-${hex(w.hi, 4)}`;
        const reg = cc.name === 'main' ? regionText(w.lo) : '';
        row.textContent = `${cc.name} ${range} ${w.r ? 'R' : ''}${w.w ? 'W' : ''}`
          + (w.cond ? ` if ${w.cond}` : '') + (reg ? `  — ${reg}` : '')
          + (w.enabled ? '' : `  ${t('無効')}: ${w.error}`);
        row.onclick = () => { ctrl.clearWatch(cc.name, w.id); renderAll(); };
        els.wlist.appendChild(row);
      }
    }
    if (!els.wlist.children.length) els.wlist.textContent = t('（なし — クリックで削除）');
    void c;
  }

  function renderIoList() {
    els.iolist.textContent = '';
    for (const cc of ctrl.cpus) {
      for (const w of cc.iobps) {
        const row = doc.createElement('div');
        row.className = 'listrow' + (w.enabled ? '' : ' dim');
        const range = w.lo === w.hi ? hex(w.lo, 2) : `${hex(w.lo, 2)}-${hex(w.hi, 2)}`;
        row.textContent = `${cc.name} port ${range} ${w.in ? 'IN' : ''}${w.in && w.out ? '/' : ''}${w.out ? 'OUT' : ''}`
          + (w.cond ? ` if ${w.cond}` : '')
          + (w.enabled ? '' : `  ${t('無効')}: ${w.error}`);
        row.onclick = () => { ctrl.clearIoBreak(cc.name, w.id); renderAll(); };
        els.iolist.appendChild(row);
      }
    }
    if (!els.iolist.children.length) els.iolist.textContent = t('（なし — クリックで削除）');
  }

  function renderWx(c) {
    els.wxlist.textContent = '';
    for (const wx of state.watchExprs) {
      const row = doc.createElement('div');
      row.className = 'listrow';
      let text;
      try {
        const cpu = c.cpu;
        const v = wx.fn(cpu.a, cpu.f, cpu.b, cpu.c, cpu.d, cpu.e, cpu.h, cpu.l,
          cpu.af, cpu.bc, cpu.de, cpu.hl, cpu.ix, cpu.iy, cpu.sp, cpu.pc,
          cpu.i, cpu.r, cpu.im, cpu.iff1, c.read);
        text = typeof v === 'number' ? `${wx.expr} = ${hex(v & 0xffff, v > 0xff ? 4 : 2)} (${v})` : `${wx.expr} = ${v}`;
      } catch (e) { text = `${wx.expr} — ${String(e?.message ?? e)}`; }
      row.textContent = text;
      row.onclick = () => { state.watchExprs = state.watchExprs.filter((x) => x !== wx); renderAll(); };
      els.wxlist.appendChild(row);
    }
    if (!state.watchExprs.length) els.wxlist.textContent = t('（式を追加 — 例: hl, mem(0xEF14), bc+de）');
  }

  function renderTrace(c) {
    els.trace.textContent = '';
    if (!c.traceOn) { els.trace.textContent = t('（トレースOFF）'); return; }
    const rows = ctrl.traceView(c.name, 24);
    for (const r of rows) {
      const row = doc.createElement('div');
      row.className = 'listrow';
      let text = '';
      try { text = disasm(c.read, r.pc, { syntax: state.syntax }).text; } catch { text = '?'; }
      row.textContent = `f=${String(r.frame).padStart(6)} ${hex(r.pc, 4)} ${text.padEnd(18)}`
        + ` AF=${hex(r.af, 4)} BC=${hex(r.bc, 4)} DE=${hex(r.de, 4)} HL=${hex(r.hl, 4)} SP=${hex(r.sp, 4)}`;
      row.onclick = () => traceJump(r);
      els.trace.appendChild(row);
    }
    if (!rows.length) els.trace.textContent = t('（まだ何も実行してない）');
  }

  function renderVram(m) {
    let model = null;
    try { model = textVramModel(m); } catch { model = null; }
    if (!model) {
      els.vraminfo.textContent = t('CRTC/DMACが見つからない');
      els.vram.textContent = '';
      return;
    }
    els.vraminfo.textContent =
      `base=${hex(model.base, 4)} stride=${model.stride} count=${model.count}`
      + ` ${model.cols}×${model.rows} attrs/row=${model.attrsPerRow}`
      + ` DMA:${model.enabled ? 'ON' : 'OFF'} VE:${model.ve ? 'ON' : 'OFF'}`;
    const lines = [];
    for (const row of model.rowsData) {
      lines.push(`${String(row.y).padStart(2)} ${hex(row.addr, 4)} |${row.text}|`);
      if (row.pairs.length || row.spans.length > 1) {
        const pairs = row.pairs.map((p) => `(${p.pos},${hex(p.val, 2)} ${p.text})`).join(' ');
        const spans = row.spans.map((s) => {
          const parts = [attrShort(s.color)];
          if (s.func) parts.push(attrShort(s.func));
          return `${s.from}-${s.to}:${parts.join('+')}`;
        }).join(' ');
        lines.push(`        ${pairs}${pairs && spans ? '  →  ' : ''}${spans}`);
      }
    }
    els.vram.textContent = lines.join('\n');
  }

  // trace row click → time travel to (approximately) that instruction:
  // rewind to the row's frame, then crawl forward until the recorded
  // pc/sp/af triple matches. Breakpoints hold their fire during the crawl.
  function traceJump(row) {
    const m = ctrl.machine;
    if (!m || !ttOK(m)) return;
    seekFrame(row.frame);
    const c = activeCpu();
    if (!c) return;
    let budget = 400000;
    ctrl.replaying = true;
    try {
      while (budget-- > 0 && !(c.cpu.pc === row.pc && c.cpu.sp === row.sp && c.cpu.af === row.af)) {
        ctrl.stepInto(state.active, false);
      }
    } finally { ctrl.replaying = false; }
    renderAll();
  }

  function renderBps() {
    const lines = [];
    for (const c of ctrl.cpus) {
      for (const [addr, bp] of c.bps) {
        const name = labelOf(addr);
        let s = `${c.name}  ${hex(addr, 4)}${name ? ' (' + name + ')' : ''}`;
        if (bp.cond) s += `  if ${bp.cond}`;
        if (!bp.enabled) s += `  — ${t('無効')}: ${bp.error}`;
        lines.push(s);
      }
    }
    els.bplist.textContent = lines.length ? lines.join('\n') : t('（なし — アドレスを入れて±で追加）');
  }

  function renderFdc(m) {
    if (!m.sub || state.active !== 'sub') return;
    try {
      const st = m.sub.getState ? m.sub.getState() : { fdc: m.sub.fdc?.getState?.() };
      els.fdc.textContent = JSON.stringify(st, null, 1);
    } catch (e) { els.fdc.textContent = String(e); }
  }

  function clockHzOf(m) {
    // the cores don't retain clockHz, but frameT × 60 is the effective
    // executed clock (DMA steal already subtracted) — the honest number
    return m.clockHz ?? (m.frameT ? m.frameT * 60 : 4_000_000);
  }
  function renderClock(m, c) {
    const clk = clockHzOf(m);
    els.clock.textContent =
      `T=${c.tTotal}  ≈${(c.tTotal / clk).toFixed(3)}s @${(clk / 1e6).toFixed(2)}MHz  frame=${m.frame ?? '?'}`;
  }

  function renderTree(m) {
    if (tl.renderVer === tl.treeVer) return; // redraw only when the tree changed
    tl.renderVer = tl.treeVer;
    els.tree.textContent = '';
    if (!ttOK(m)) {
      els.ttinfo.textContent = t('coreがsnapshot/restore未対応（古いmachine.js）');
      return;
    }
    let total = 0;
    for (const n of tl.nodes.values()) total += n.size ?? 0;
    // compressed view: boring degree-1 runs fold into one "─⋯×N─" edge;
    // clicking the fold expands it once (collapses again on the next fold)
    const rows = timelineView(tl.nodes, tl.rootId, {
      current: tl.current, nearCurrent: 3, expanded: tl.expanded,
    });
    for (const r of rows) {
      const row = doc.createElement('div');
      if (r.type === 'gap') {
        row.className = 'treerow gap';
        row.textContent = `${'· '.repeat(r.depth)}│ ─⋯×${r.count}─`;
        const ids = r.ids;
        row.onclick = () => {
          for (const id of ids) tl.expanded.add(id);
          tl.treeVer++;
          renderAll();
        };
      } else {
        row.className = 'treerow' + (r.current ? ' on' : '') + (r.pinned ? ' pin' : '');
        const mark = r.current ? '▶' : r.pinned ? '📸' : r.branch ? '┳' : '○';
        row.textContent = `${'· '.repeat(r.depth)}${mark} f=${r.frame}`;
        row.onclick = () => jumpTo(r.id);
      }
      els.tree.appendChild(row);
    }
    els.ttinfo.textContent =
      `${tl.nodes.size}/${SNAP_CAP} snap ≈${(total / 1024) | 0}KB — `
      + t('古い一本道は間引き済み（決定論再実行で正確性は不変・再実行が伸びるだけ）') + ' / '
      + t('D88へのセクタ書込は巻き戻らない');
  }

  function renderProf(c, m) {
    if (!c.profOn) { els.prof.textContent = t('（OFF — ⏱で計測開始）'); return; }
    const clk = clockHzOf(m);
    const rows = [...c.profData.routines.entries()]
      .map(([addr, r]) => ({ addr, ...r }))
      .sort((x, y) => y.total - x.total)
      .slice(0, 20);
    const head = `${t('ルーチン').padEnd(14)}${'calls'.padStart(8)}${'self T'.padStart(12)}${'total T'.padStart(12)}${'ms'.padStart(9)}`;
    const lines = rows.map((r) => {
      const name = (labelOf(r.addr) ?? hex(r.addr, 4)).slice(0, 13);
      return `${name.padEnd(14)}${String(r.calls).padStart(8)}${String(r.self).padStart(12)}${String(r.total).padStart(12)}${(r.total / clk * 1000).toFixed(2).padStart(9)}`;
    });
    els.prof.textContent = [head, ...lines].join('\n') || head;
  }

  function renderAll() {
    const m = ctrl.machine;
    if (!m) return;
    const c = activeCpu();
    if (!c) return;
    if (ctrl.paused) {
      const h = ctrl.hit;
      let msg;
      if (!h) msg = t('一時停止中');
      else if (h.type === 'watch') msg = `⛔ WATCH ${h.rw.toUpperCase()} ${hex(h.addr, 4)}=${hex(h.value, 2)} @${hex(h.pc, 4)} (${h.cpu})`;
      else if (h.type === 'io') msg = `⛔ I/O ${h.rw.toUpperCase()} port ${hex(h.addr, 2)}=${hex(h.value, 2)} @${hex(h.pc, 4)} (${h.cpu})`;
      else msg = `⛔ BREAK ${h.cpu} @ ${hex(h.pc, 4)}`;
      setConn(msg, 'pause');
    } else setConn(t('実行中'), 'run');
    els.minfo.textContent = `${m.sub ? 'PC-8801 main+sub' : 'PC-8001'}  [${state.active}]`;
    renderClock(m, c);
    renderRegs(c);
    renderDis(c);
    renderMem(c);
    renderBps();
    renderStack(c);
    renderWatchList();
    renderIoList();
    renderWx(c);
    renderTrace(c);
    renderVram(m);
    renderFdc(m);
    renderTree(m);
    renderProf(c, m);
  }

  // --- controls -----------------------------------------------------------------
  els.bpause.onclick = () => { state.disFocus = null; ctrl.pause(); renderAll(); };
  els.bcont.onclick = () => { state.disFocus = null; branchIfNeeded(); ctrl.resume(); renderAll(); };
  els.bstep.onclick = () => {
    state.disFocus = null;
    if (!ctrl.paused) ctrl.pause();
    ctrl.stepInto(state.active);
    renderAll();
  };
  els.bover.onclick = () => {
    state.disFocus = null;
    if (!ctrl.paused) ctrl.pause();
    ctrl.stepOver(state.active);
    renderAll();
  };
  els.bstepout.onclick = () => {
    state.disFocus = null;
    if (!ctrl.paused) ctrl.pause();
    ctrl.stepOut(state.active);
    renderAll();
  };
  els.bframe.onclick = () => {
    state.disFocus = null;
    if (!ctrl.paused) ctrl.pause();
    branchIfNeeded();
    ctrl.frameStep();
    renderAll();
  };
  els.bsyntax.onclick = () => {
    state.syntax = state.syntax === 'zilog' ? 'intel' : 'zilog';
    els.bsyntax.textContent = state.syntax === 'zilog' ? 'Zilog' : 'Intel 8080';
    renderAll();
  };
  els.tabmain.onclick = () => { state.active = 'main'; updateTabs(); renderAll(); };
  els.tabsub.onclick = () => { if (ctrl.cpu('sub')) { state.active = 'sub'; updateTabs(); renderAll(); } };

  els.btundo.onclick = () => seekFrame((ctrl.machine?.frame ?? 1) - 1);
  els.btredo.onclick = () => seekFrame((ctrl.machine?.frame ?? 0) + 1);
  els.btsnap.onclick = () => { // manual snapshots are pinned — thinning never eats them
    const m = ctrl.machine;
    if (m && ttOK(m)) { takeSnap(m, tl.current, true); renderAll(); }
  };

  els.bprof.onclick = () => {
    const c = activeCpu();
    if (!c) return;
    c.profOn = !c.profOn;
    els.bprof.className = c.profOn ? 'on' : '';
    renderAll();
  };
  els.bprofreset.onclick = () => {
    const c = activeCpu();
    if (c) { ctrl.profReset(c.name); c.tTotal = 0; renderAll(); }
  };

  els.memaddr.onchange = () => {
    const v = parseNum(els.memaddr.value);
    if (v !== null) state.memAddr = v & 0xffff;
    renderAll();
  };
  els.bwrite.onclick = () => {
    const c = activeCpu();
    const a = parseNum(els.waddr.value);
    if (!c || a === null) return;
    const bytes = els.wdata.value.trim().split(/[\s,]+/).map(parseNum).filter((v) => v !== null);
    bytes.forEach((v, i) => c.write((a + i) & 0xffff, v));
    state.memAddr = a & 0xfff0;
    els.memaddr.value = hex(state.memAddr, 4);
    renderAll();
  };

  els.bpbtn.onclick = () => {
    const addr = parseNum(els.bpaddr.value);
    if (addr === null) return;
    const cond = els.bpcond.value.trim() || null;
    const c = activeCpu();
    if (!c) return;
    const saved = state.savedBps[c.name];
    if (c.bps.has(addr & 0xffff) && !cond) { // toggle off
      ctrl.clearBreak(c.name, addr);
      saved.delete(addr & 0xffff);
    } else {
      const r = ctrl.setBreak(c.name, addr, cond);
      if (!r.ok) { els.bplist.textContent = t('条件式エラー') + ': ' + r.error; return; }
      saved.set(addr & 0xffff, cond);
    }
    renderAll();
  };

  // --- watchpoints / I/O breaks ---------------------------------------------------
  els.bwadd.onclick = () => {
    const lo = parseNum(els.walo.value);
    if (lo === null) return;
    const hi = parseNum(els.wahi.value);
    const r = !!els.war.checked, w = !!els.waw.checked;
    if (!r && !w) return;
    const res = ctrl.setWatch(state.active, { lo, hi, r, w, cond: els.wacond.value.trim() || null });
    if (!res.ok) { els.wlist.textContent = t('条件式エラー') + ': ' + res.error; return; }
    renderAll();
  };
  els.bioadd.onclick = () => {
    const lo = parseNum(els.iolo.value);
    if (lo === null) return;
    const hi = parseNum(els.iohi.value);
    const dirIn = !!els.ioin.checked, dirOut = !!els.ioout.checked;
    if (!dirIn && !dirOut) return;
    const res = ctrl.setIoBreak(state.active, { lo, hi, dirIn, dirOut, cond: els.iocond.value.trim() || null });
    if (!res.ok) { els.iolist.textContent = t('条件式エラー') + ': ' + res.error; return; }
    renderAll();
  };
  els.iosel.onchange = () => { // port-name preset → fills the range fields
    const v = els.iosel.value;
    if (!v) return;
    const [lo, hi] = v.split('-').map(Number);
    els.iolo.value = hex(lo, 2);
    els.iohi.value = hi !== lo ? hex(hi, 2) : '';
  };

  // --- memory search / change search / watch expressions ---------------------------
  els.bsearch.onclick = () => {
    const c = activeCpu();
    const pat = parsePattern(els.spat.value);
    els.sres.textContent = '';
    if (!c || !pat) { els.sres.textContent = t('パターンが変（hex列 か "文字列"）'); return; }
    const hits = searchBytes(c.read, pat, { limit: 64 });
    if (!hits.length) { els.sres.textContent = t('（見つからない）'); return; }
    for (const a of hits) {
      const row = doc.createElement('div');
      row.className = 'listrow';
      row.textContent = `${hex(a, 4)}  ${regionText(a)}`;
      row.onclick = () => { state.memAddr = a & 0xfff0; els.memaddr.value = hex(state.memAddr, 4); renderAll(); };
      els.sres.appendChild(row);
    }
  };
  function renderCsList() {
    const c = activeCpu();
    els.csres.textContent = '';
    if (!c) return;
    for (const x of state.changeSearch.list(c.read, 24)) {
      const row = doc.createElement('div');
      row.className = 'listrow';
      row.textContent = `${hex(x.addr, 4)} = ${hex(x.value, 2)}  ${regionText(x.addr)}`;
      row.onclick = () => { state.memAddr = x.addr & 0xfff0; els.memaddr.value = hex(state.memAddr, 4); renderAll(); };
      els.csres.appendChild(row);
    }
  }
  const csFilter = (op, operand) => {
    const c = activeCpu();
    if (!c || !state.changeSearch.alive) { els.csinfo.textContent = t('まず📸初期化して'); return; }
    const n = state.changeSearch.filter(c.read, op, operand);
    els.csinfo.textContent = `${n} ${t('候補')}`;
    renderCsList();
  };
  els.bcsinit.onclick = () => {
    const c = activeCpu();
    if (!c) return;
    state.changeSearch.init(c.read);
    els.csinfo.textContent = t('全64KBを撮影した — 値を動かしてから絞り込む');
    els.csres.textContent = '';
  };
  els.bcsne.onclick = () => csFilter('ne');
  els.bcseq.onclick = () => csFilter('eq');
  els.bcsgt.onclick = () => csFilter('gt');
  els.bcslt.onclick = () => csFilter('lt');
  els.bcsval.onclick = () => {
    const v = parseNum(els.csval.value);
    if (v !== null) csFilter('val', v);
  };
  els.bunused.onclick = () => { // execution-coverage complement of user RAM
    const c = ctrl.cpu('main');
    const m = ctrl.machine;
    if (!c || !m) return;
    const runs = estimateUnused(kindOf(m), c.coverage).sort((a, b) => b.bytes - a.bytes).slice(0, 8);
    els.unusedout.textContent = runs.length
      ? runs.map((r2) => `${hex(r2.start, 4)}-${hex(r2.end, 4)} (${r2.bytes}B)`).join('\n')
      : t('（userRAMに未実行領域なし）');
  };
  els.bwxadd.onclick = () => {
    const expr = els.wxexpr.value.trim();
    if (!expr) return;
    try { state.watchExprs.push({ expr, fn: compileCond(expr) }); }
    catch (e) { els.wxlist.textContent = t('条件式エラー') + ': ' + String(e?.message ?? e); return; }
    els.wxexpr.value = '';
    renderAll();
  };

  // --- trace ------------------------------------------------------------------------
  els.btrace.className = 'on';
  els.btrace.onclick = () => {
    const c = activeCpu();
    if (!c) return;
    c.traceOn = !c.traceOn;
    els.btrace.className = c.traceOn ? 'on' : '';
    renderAll();
  };
  els.btraceclr.onclick = () => { ctrl.traceClear(state.active); renderAll(); };

  // --- labels -------------------------------------------------------------------
  els.bladd.onclick = () => {
    const a = parseNum(els.laddr.value);
    if (a === null) return;
    setLabel(a, els.lname.value.trim()); // empty name = delete
    renderAll();
  };
  els.blexport.onclick = () => {
    env.download?.('ice-labels.json', JSON.stringify([...state.labels], null, 1));
  };
  els.blimport.onchange = async (e) => {
    const f = e.target?.files?.[0];
    if (!f) return;
    try {
      const arr = JSON.parse(await f.text());
      for (const [a, n] of arr) state.labels.set(a & 0xffff, String(n));
      saveLabels();
      renderAll();
    } catch (err) { els.bplist.textContent = 'labels import: ' + err.message; }
  };

  // --- assembler pane -------------------------------------------------------------
  els.basm.onclick = () => {
    const c = activeCpu();
    const orgv = parseNum(els.aorg.value) ?? 0x9000;
    const res = assemble(els.asrc.value, { org: orgv });
    state.lastAsm = res;
    if (res.errors.length) {
      els.aout.textContent = res.errors.map((e) => `L${e.line}: ${e.message}`).join('\n');
      els.anal.textContent = '';
      return;
    }
    if (c) for (let i = 0; i < res.bytes.length; i++) c.write((res.org + i) & 0xffff, res.bytes[i]);
    for (const [k, v] of Object.entries(res.symbols)) { // symbols join the label DB
      if (typeof v === 'number' && !k.includes('~') && !k.includes('.')) state.labels.set(v & 0xffff, k);
    }
    saveLabels();
    let msg = `${res.bytes.length} bytes → ${hex(res.org, 4)}h  (${t('書き込み先')}: ${state.active})`;
    if (res.warnings.length) msg += '\n' + res.warnings.map((w) => `L${w.line}: ⚠ ${w.message}`).join('\n');
    if (res.fixups.length) msg += `\nfixups: ${res.fixups.map((f) => hex(f, 4)).join(' ')}`;
    els.aout.textContent = msg;
    renderAnal(res);
    renderAll();
  };
  els.bsetpc.onclick = () => {
    const c = activeCpu();
    const v = parseNum(els.aorg.value);
    if (c && v !== null) { if (!ctrl.paused) ctrl.pause(); c.cpu.pc = v & 0xffff; renderAll(); }
  };
  els.brun.onclick = () => { branchIfNeeded(); ctrl.resume(); renderAll(); };

  function renderAnal(res) {
    els.anal.textContent = '';
    let an;
    try {
      an = analyze(res.bytes, res.org, res.symbols, { ports: state.active === 'sub' ? 'pc88-sub' : 'pc88-main' });
    } catch (e) { els.anal.textContent = String(e); return; }
    const head = doc.createElement('div');
    head.className = 'analhead';
    head.textContent = t('ルーチン / 破壊 / 入力 / 保存 / I/O / mem / T / 警告');
    els.anal.appendChild(head);
    for (const r of an.routines) {
      const row = doc.createElement('div');
      row.className = 'analrow' + (r.warnings.length ? ' warn' : '');
      const io = r.io.map((i) => `${i.dir === 'in' ? '←' : '→'}${i.port === null ? '(C)' : hex(i.port, 2)}${i.name ? '=' + i.name : ''}`).join(' ');
      const mem = r.mem.map((mm) => `${mm.rw}${hex(mm.addr, 4)}${mm.name ? '=' + mm.name : ''}`).join(' ');
      const tS = r.tStates.min === r.tStates.max ? `${r.tStates.min}T` : `${r.tStates.min}〜${r.tStates.max}T`;
      row.textContent = `${r.name} @${hex(r.addr, 4)}  破壊:${r.destroys.join('') || '-'}${r.unknown ? '+?' : ''}`
        + `  入力:${r.inputs.join('') || '-'}  保存:${r.saves.join('') || '-'}`
        + (io ? `  IO:${io}` : '') + (mem ? `  MEM:${mem}` : '')
        + `  ${tS}${r.tStates.loop ? '×loop' : ''}`
        + (r.callers.length ? `  ←${r.callers.join(',')}` : '')
        + (r.warnings.length ? '  ' + r.warnings.map((w) => w.message).join(' / ') : '');
      row.onclick = () => jumpToLabel(r.name.split('/')[0]);
      els.anal.appendChild(row);
    }
  }

  function jumpToLabel(name) {
    const src = els.asrc.value;
    const re = new RegExp(`^\\s*${name}\\b`, 'im');
    const m = re.exec(src);
    if (!m) return;
    els.asrc.focus?.();
    try {
      els.asrc.selectionStart = m.index;
      els.asrc.selectionEnd = m.index + m[0].length;
    } catch { /* headless shim */ }
  }

  // --- source export / relocate ----------------------------------------------
  function doExport() {
    const c = activeCpu();
    if (!c) return null;
    const s = parseNum(els.exps.value), e = parseNum(els.expe.value);
    if (s === null || e === null || e < s) {
      els.exptext.value = t('範囲を addr,addr で入れて（終了は含む）');
      return null;
    }
    const o = parseNum(els.expo.value);
    // extra reachability seeds: breakpointed addresses are code by
    // definition (you were stepping there) — labels alone could be data
    const text = exportSource(c.read, s, e + 1, {
      labels: state.labels,
      org: o ?? s,
      entries: [...c.bps.keys()].filter((a) => a >= s && a <= e),
    });
    els.exptext.value = text;
    return text;
  }
  els.bexp.onclick = () => { doExport(); };
  els.bexpsave.onclick = () => {
    const text = els.exptext.value || doExport();
    if (text) env.download?.(`ice-${els.exps.value || 'export'}.z80`, text);
  };
  els.bexpwrite.onclick = () => { // relocate: assemble the export and poke it in
    const c = activeCpu();
    if (!c) return;
    const text = els.exptext.value || doExport();
    if (!text) return;
    const res = assemble(text);
    if (res.errors.length) {
      els.exptext.value = res.errors.map((e) => `; L${e.line}: ${e.message}`).join('\n') + '\n' + text;
      return;
    }
    for (let i = 0; i < res.bytes.length; i++) c.write((res.org + i) & 0xffff, res.bytes[i]);
    state.memAddr = res.org & 0xfff0;
    els.memaddr.value = hex(state.memAddr, 4);
    renderAll();
  };

  // --- ICE → IDE promotion (author workflow: experiment here, manage there) ---
  function promoteToIde(source, org, symbols) {
    if (!source || !source.trim()) return;
    const payload = { type: 'promote', source, org: org ?? null, symbols: symbols ?? null };
    env.broadcast?.send?.(payload);
    try { storage.set('upd3301-promote', JSON.stringify(payload)); } catch { /* box stays empty */ }
    els.aout.textContent = t('📤 IDEへ送った（IDE未起動でも起動時に拾われる）');
  }
  els.bpromasm.onclick = () => promoteToIde(els.asrc.value, parseNum(els.aorg.value), state.lastAsm?.symbols ?? null);
  els.bpromexp.onclick = () => {
    const text = els.exptext.value || doExport();
    if (text) promoteToIde(text, parseNum(els.expo.value) ?? parseNum(els.exps.value), null);
  };
  // …and the way back: the IDE broadcasts build symbols into the label DB
  env.broadcast?.listen?.((msg) => {
    if (msg?.type === 'labels' && Array.isArray(msg.labels)) {
      for (const [a, n] of msg.labels) state.labels.set(a & 0xffff, String(n));
      saveLabels();
      renderAll();
    }
  });

  // --- main loop ---------------------------------------------------------------
  function tick() {
    const m = syncAttach();
    if (m) {
      if (ttOK(m) && !ctrl.paused) { // periodic auto-snapshot while running
        const cur = tl.nodes.get(tl.current);
        if (!cur) takeSnap(m, 0);
        else if (m.frame - cur.frame >= SNAP_EVERY) takeSnap(m, tl.current);
      }
      renderAll();
    }
    env.raf(tick);
  }
  env.raf(tick);

  return { ctrl, state, tl, renderAll, seekFrame, jumpTo, els };
}
