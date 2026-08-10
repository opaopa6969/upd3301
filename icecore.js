// icecore — the ICE's measurement floor. Pure, DOM-free, machine-independent.
//
// Why this file exists (the receipt): during the M88 parity run (#32) every bug
// we killed lived in the seam between the sub-CPU, the 8255 pair and the FDC —
// exactly what demo/ice.html was built to watch — and we could not use it,
// because the work was headless and the ICE was a browser window. So the same
// instrumentation got re-invented six times as one-shot scripts (tools/
// pc-trace.mjs, watch-read.mjs, watch-write.mjs, life-scan.mjs,
// loop-profile.mjs, trace-diff.mjs). Every rewrite was a worse version of code
// that already existed. This module is that code with the DOM taken out; the
// browser ICE (demo/ice.js) and the headless CLI (tools/ice.mjs) are both
// clients of it.
//
// Rules kept from the original ICE:
//
//   1. **The core is never edited.** Every measurement is a method wrap
//      installed at attach() and removed at detach(). Nothing here knows a
//      machine's internals.
//   2. **Never abort mid-instruction.** A bus tap that wants to break sets
//      `pendingBreak`; the step wrap turns that into a break AFTER the opcode
//      completes. Aborting mid-opcode leaves the CPU half-executed and
//      determinism in pieces.
//   3. **The debugger never trips its own wire.** ICE's own peeks (hex dump,
//      disassembly, conditions) go through `entry.read`, which bypasses the bus
//      tap. DMA pulls also live outside the CPU bus: watchpoints are a CPU
//      instrument, by design.
//
// Machine independence is a **capability probe**, never `instanceof` — the same
// generalisation demo/machine.html made for its own machine switches. A machine
// is anything with `stepFrame()` and at least one CPU-shaped object. How to
// read its memory is *discovered* and then *reported* (`memHow`), because a
// debugger that silently reads through the live CPU bus perturbs what it
// measures, and you deserve to know when it had no other option.

import { detectArch, Z80_ARCH, capabilities } from './icearch.js';

export const SCHEMA_VERSION = 1;
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

// Conditions are compiled once with new Function and see only the names the
// architecture hands them — no scope capture, no globals reachable by accident.
export function compileCondFor(arch, cond, extra = []) {
  return new Function(...extra, ...arch.condVars, `return (${cond});`);
}
// Z80-shaped shims, kept because the ICE UI and every saved breakpoint
// condition were written against these two names.
export const compileCond = (cond) => compileCondFor(Z80_ARCH, cond);
export const compileAccessCond = (cond) => compileCondFor(Z80_ARCH, cond, ['value', 'addr']);

// ---- machine probing ---------------------------------------------------------

// How to read a CPU's memory without going through its live bus, in descending
// order of honesty. Returns {read, write, how, intrusive}.
function probeMem(machine, cpu, arch, hint = {}) {
  const mask = arch.addrMask;
  if (hint.read) return { read: hint.read, write: hint.write ?? (() => {}), how: hint.how ?? 'explicit', intrusive: false };
  // A machine-level accessor is the right answer when it exists: it resolves
  // banking the way the program sees it (this is why watch-write.mjs wrapped
  // machine.writeMem rather than the bus).
  if (cpu === machine.cpu) {
    if (typeof machine.readMem === 'function') {
      return {
        read: (a) => machine.readMem(a & mask) & 0xff,
        write: (a, v) => machine.writeMem?.(a & mask, v & 0xff),
        how: 'machine.readMem', intrusive: false,
      };
    }
    if (typeof machine.peek === 'function') {
      return {
        read: (a) => machine.peek(a & mask) & 0xff,
        write: (a, v) => machine.poke?.(a & mask, v & 0xff),
        how: 'machine.peek', intrusive: false,
      };
    }
    const flat = machine.sys?.memory ?? (machine.memory instanceof Uint8Array ? machine.memory : null);
    if (flat) {
      return {
        read: (a) => flat[a & mask] ?? 0xff,
        write: (a, v) => { flat[a & mask] = v & 0xff; },
        how: 'sys.memory', intrusive: false,
      };
    }
  }
  // Last resort: the CPU's own bus. It sees exactly what the program sees, and
  // it can have side effects (an NES read of $2002 clears vblank). Flagged so
  // callers can say so rather than quietly perturbing the run.
  const br = arch.busRead?.(cpu), bw = arch.busWrite?.(cpu);
  if (br) return { read: br, write: bw ?? (() => {}), how: 'cpu.bus', intrusive: true };
  return { read: () => 0xff, write: () => {}, how: 'none', intrusive: false };
}

/**
 * Which CPUs does this machine have, and how do we reach each one's memory?
 * Pure capability probe — no machine class is named anywhere in here.
 *
 * Returns [{name, cpu, arch, read, write, memHow, intrusive, irq}].
 * Pass `{cpus: [...]}` to attach() to override entirely (a machine that hides
 * its CPUs behind unusual names can just say so).
 */
export function probeCpus(machine) {
  const out = [];
  const push = (name, cpu, hint = {}, irq = {}) => {
    const arch = detectArch(cpu);
    if (!arch) return;
    const mem = probeMem(machine, cpu, arch, hint);
    out.push({ name, cpu, arch, read: mem.read, write: mem.write, memHow: mem.how, intrusive: mem.intrusive, irq });
  };

  if (machine.cpu) {
    push('main', machine.cpu, {}, {
      // Some machines service interrupts between instructions inside their own
      // stepFrame; a manual single-step has to mirror that or stepping through
      // an IRQ-driven boot behaves differently from running it.
      post: typeof machine._serviceInterrupts === 'function' ? () => machine._serviceInterrupts() : null,
    });
  }
  // A sub-board CPU with its own private memory (the PC-8801's FDD board is the
  // one in this repo). Probed by shape: `.cpu` plus a flat `.mem`.
  if (machine.sub?.cpu && machine.sub.cpu !== machine.cpu) {
    const smem = machine.sub.mem;
    const smask = smem?.length ? smem.length - 1 : 0x7fff;
    push('sub', machine.sub.cpu,
      smem ? {
        read: (a) => smem[a & smask] ?? 0xff,
        write: (a, v) => { smem[a & smask] = v & 0xff; },
        how: 'sub.mem',
      } : {},
      {
        // The sub board's interrupt line is raised by its FDC. Mirroring it
        // here is what makes a manual single-step on the sub CPU behave like
        // the machine's own run loop.
        pre: () => { if (machine.sub.fdc?.intLine) machine.sub.cpu.intRequest?.(0x00); },
      });
  }
  // A second, differently-architected CPU on the same board (the Mega Drive's
  // sound Z80 next to the 68000). No private accessor exists, so it falls
  // through to its own bus — and says so.
  if (machine.z80 && machine.z80 !== machine.cpu) push('z80', machine.z80);
  return out;
}

// ---- the debugger ------------------------------------------------------------

const TRACE_CAP = 4096;

export class IceCore {
  constructor() {
    this.machine = null;
    this.paused = false;
    this.hit = null;
    this.cpus = [];
    this._origStepFrame = null;
    this._origKeys = null;
    this.replaying = false; // breakpoints hold their fire during a replay
    this.onInput = null; // (type, frame, row, bit) — the time-travel input log
    // set inside a bus callback mid-instruction; the step wrap turns it into a
    // clean break AFTER the instruction completes
    this.pendingBreak = null;
    this._accessId = 0;
  }

  cpu(name) { return this.cpus.find((c) => c.name === name) ?? null; }

  get frame() { return this.machine?.frame ?? 0; }

  // What this attachment can actually do, per CPU. Print it rather than
  // showing an empty disassembly pane and letting the user guess.
  capabilities() {
    return this.cpus.map((c) => ({
      cpu: c.name, memHow: c.memHow, intrusiveRead: c.intrusive, ...capabilities(c.arch),
    }));
  }

  attach(machine, opts = {}) {
    this.detach();
    this.machine = machine;
    this.paused = false;
    this.hit = null;
    this.cpus = [];
    const self = this;
    for (const spec of opts.cpus ?? probeCpus(machine)) this._addCpu(spec);
    if (typeof machine.stepFrame === 'function') {
      const orig = machine.stepFrame;
      this._origStepFrame = orig;
      machine.stepFrame = function (...args) {
        if (self.paused) return machine; // frozen: a host rAF loop spins harmlessly
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
    return this;
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
      c.untapBus?.();
      c.untapBus = null;
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

  _addCpu({ name, cpu, arch, read, write, memHow = 'explicit', intrusive = false, irq = {} }) {
    const self = this;
    const origStep = cpu.step;
    const mask = arch.addrMask;
    const entry = {
      name, cpu, arch, read, write, memHow, intrusive, origStep, irq,
      bps: new Map(), skipOnce: -1,
      watches: [], // {id, lo, hi, r, w, cond, fn, enabled, error}
      iobps: [], // {id, lo, hi, in, out, cond, fn, enabled, error}
      tTotal: 0, // T-states (or cycles) executed since attach
      stackOn: !!arch.callAt, // shadow call stack — impossible without a call decoder
      profOn: false, // T accounting into the routines map
      profData: { stack: [], routines: new Map(), rootSelf: 0 },
      traceOn: true, // register trace ring
      trace: {
        cap: TRACE_CAP, n: 0,
        pc: new Uint32Array(TRACE_CAP), af: new Uint16Array(TRACE_CAP),
        bc: new Uint16Array(TRACE_CAP), de: new Uint16Array(TRACE_CAP),
        hl: new Uint16Array(TRACE_CAP), sp: new Uint32Array(TRACE_CAP),
        frame: new Uint32Array(TRACE_CAP),
      },
      // executed-PC coverage, only where a flat 64K bitmap is meaningful
      coverage: name === 'main' && mask === 0xffff ? new Uint8Array(0x10000) : null,
      // headless recorders, all off until asked for — the hot path must stay
      // cheap for the multi-thousand-frame runs the CLI does
      rec: { pcHist: null, pcLog: null, ioHist: null, memLog: null },
      untapBus: null,
    };

    cpu.step = function () {
      const pcB = arch.pcOf(cpu);
      if (!self.replaying) { // breakpoints hold their fire during a replay
        const bp = entry.bps.get(pcB);
        if (bp && bp.enabled) {
          if (entry.skipOnce === pcB) entry.skipOnce = -1; // resuming off this bp
          else {
            let fire = true;
            if (bp.fn) {
              try { fire = !!bp.fn(...arch.condValues(cpu, entry.read)); }
              catch (e) {
                bp.enabled = false; // a broken condition must not wedge the machine
                bp.error = String(e?.message ?? e);
                fire = false;
              }
            }
            if (fire) {
              self.paused = true;
              self.hit = { type: 'break', cpu: name, pc: pcB };
              entry.skipOnce = -1;
              throw BREAK;
            }
          }
        } else if (entry.skipOnce !== pcB) entry.skipOnce = -1;
      }
      const spB = arch.spOf ? arch.spOf(cpu) : 0;
      const R = entry.rec;
      if (R.pcLog) self._logPc(R.pcLog, pcB);
      if (R.pcHist) R.pcHist.set(pcB, (R.pcHist.get(pcB) ?? 0) + 1);
      if (entry.traceOn) { // ring: pre-execution state of every instruction
        const tr = entry.trace, i2 = tr.n % tr.cap;
        tr.pc[i2] = pcB;
        tr.af[i2] = cpu.af ?? 0; tr.bc[i2] = cpu.bc ?? 0; tr.de[i2] = cpu.de ?? 0;
        tr.hl[i2] = cpu.hl ?? 0; tr.sp[i2] = spB;
        tr.frame[i2] = self.machine?.frame ?? 0;
        tr.n++;
      }
      if (entry.coverage) entry.coverage[pcB] = 1;
      // shadow call stack: detect the call before executing, confirm after
      // (conditional calls only push when actually taken). Unwind by SP, so RET
      // variants / popped return addresses / interrupts all resolve without
      // opcode bookkeeping.
      let target = -1, retTo = 0;
      if (entry.stackOn && arch.callAt) {
        const call = arch.callAt(entry.read, pcB);
        if (call) { target = call.target; retTo = call.retTo; }
      }
      const t = origStep.call(cpu);
      const tn = typeof t === 'number' ? t : 0;
      entry.tTotal += tn;
      if (entry.stackOn) {
        const P = entry.profData;
        const top = P.stack[P.stack.length - 1];
        if (top) top.self += tn; else P.rootSelf += tn;
        const spNow = arch.spOf ? arch.spOf(cpu) : 0;
        const spMask = arch.spMask ?? 0xffff;
        const push = arch.pushBytes ?? 2;
        const half = ((spMask >>> 1) + 1) >>> 0;
        if (target >= 0 && arch.pcOf(cpu) === target
          && spNow === ((spB - push) & spMask) && P.stack.length < 512) {
          P.stack.push({ entry: target, sp: spNow, retTo, self: 0, child: 0 });
          if (entry.profOn) {
            let r = P.routines.get(target);
            if (!r) { r = { calls: 0, self: 0, total: 0 }; P.routines.set(target, r); }
            r.calls++;
          }
        }
        while (P.stack.length) { // unwind every frame whose return slot is gone
          const f = P.stack[P.stack.length - 1];
          const d = (spNow - f.sp) & spMask;
          if (d < push || d >= half) break;
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
    return entry;
  }

  _logPc(L, pc) {
    if (!L.armed) {
      const f = this.machine?.frame ?? 0;
      if (L.armPc >= 0 ? pc === L.armPc : (L.fromFrame >= 0 && f >= L.fromFrame)) {
        L.armed = true;
        L.armFrame = f;
      } else return;
    }
    if (L.n >= L.max) { L.full = true; return; }
    if (L.dedupe && pc === L.prev) return; // a HALT or JR $ would bury the trace
    L.buf[L.n++] = pc;
    L.prev = pc;
  }

  // The bus tap is installed lazily: a trace-only headless run must not pay for
  // a wrapper on every memory access it never inspects.
  _ensureBus(entry) {
    if (entry.untapBus) return true;
    const self = this;
    const untap = entry.arch.tapBus?.(entry.cpu, {
      read: (a, v) => {
        const R = entry.rec;
        if (R.memLog) self._logMem(entry, R.memLog, a, v, 'r');
        if (entry.watches.length && !self.replaying) self._accessCheck(entry, entry.watches, a, v, 'r', 'watch');
      },
      write: (a, v) => {
        const R = entry.rec;
        if (R.memLog) self._logMem(entry, R.memLog, a, v, 'w');
        if (entry.watches.length && !self.replaying) self._accessCheck(entry, entry.watches, a, v, 'w', 'watch');
      },
      in: (p, v) => {
        const R = entry.rec;
        if (R.ioHist) self._logIo(entry, R.ioHist.in, p, v);
        if (entry.iobps.length && !self.replaying) self._accessCheck(entry, entry.iobps, p, v, 'in', 'io');
      },
      out: (p, v) => {
        const R = entry.rec;
        if (R.ioHist) self._logIo(entry, R.ioHist.out, p, v);
        if (entry.iobps.length && !self.replaying) self._accessCheck(entry, entry.iobps, p, v, 'out', 'io');
      },
    });
    entry.untapBus = untap;
    return !!untap;
  }

  _logMem(entry, L, addr, value, rw) {
    if (!L[rw]) return;
    if (addr < L.lo || addr > L.hi) return;
    const pc = entry.arch.pcOf(entry.cpu);
    if (L.pcLo >= 0 && (pc < L.pcLo || pc > L.pcHi)) return;
    L.total++;
    if (L.hits.length >= L.max) { L.capped = true; return; }
    const hit = { frame: this.machine?.frame ?? 0, pc, addr, value, rw };
    if (L.annotate) Object.assign(hit, L.annotate(this.machine, hit) ?? {});
    L.hits.push(hit);
    L.onHit?.(hit);
  }

  _logIo(entry, map, port, value) {
    let e = map.get(port);
    if (!e) { e = { n: 0, vals: new Set(), pcs: new Set() }; map.set(port, e); }
    e.n++;
    if (e.vals.size < 32) e.vals.add(value);
    if (e.pcs.size < 32) e.pcs.add(entry.arch.pcOf(entry.cpu));
  }

  // shared checker for watchpoints (rw: r/w) and I/O breaks (rw: in/out)
  _accessCheck(entry, list, addr, value, rw, type) {
    if (this.pendingBreak) return; // first hit of the instruction wins
    for (const w of list) {
      if (!w.enabled) continue;
      if (!w[rw]) continue;
      if (addr < w.lo || addr > w.hi) continue;
      if (w.fn) {
        let ok = false;
        try { ok = !!w.fn(value, addr, ...entry.arch.condValues(entry.cpu, entry.read)); }
        catch (e) {
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

  _addAccessBreak(entry, list, { lo, hi = null, cond = null, mask, ...flags }) {
    let fn = null;
    if (cond) {
      try { fn = compileCondFor(entry.arch, cond, ['value', 'addr']); }
      catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    }
    if (!this._ensureBus(entry)) return { ok: false, error: 'this CPU exposes no bus to tap' };
    const id = ++this._accessId;
    list.push({ id, lo: lo & mask, hi: (hi ?? lo) & mask, cond, fn, enabled: true, error: null, ...flags });
    return { ok: true, id };
  }

  setWatch(name, { lo, hi = null, r = false, w = true, cond = null }) {
    const c = this.cpu(name);
    if (!c) return { ok: false, error: 'no such CPU' };
    return this._addAccessBreak(c, c.watches, { lo, hi, cond, r, w, mask: c.arch.addrMask });
  }

  setIoBreak(name, { lo, hi = null, dirIn = false, dirOut = true, cond = null }) {
    const c = this.cpu(name);
    if (!c) return { ok: false, error: 'no such CPU' };
    if (c.arch.ioMask == null) return { ok: false, error: `${c.arch.name} has no I/O space — use a watchpoint` };
    return this._addAccessBreak(c, c.iobps, { lo, hi, cond, in: dirIn, out: dirOut, mask: c.arch.ioMask });
  }

  clearWatch(name, id) {
    const c = this.cpu(name);
    if (c) c.watches = c.watches.filter((x) => x.id !== id);
  }

  clearIoBreak(name, id) {
    const c = this.cpu(name);
    if (c) c.iobps = c.iobps.filter((x) => x.id !== id);
  }

  // ---- headless recorders ----------------------------------------------------
  // These are the six one-shot tools, re-expressed as instrumentation. They log
  // instead of breaking, so a whole run can be characterised without stopping.

  /**
   * The PC trace (tools/pc-trace.mjs). `armPc` matters more than it looks:
   * emulators reach the same program point at different frame numbers, so
   * "frame 60" is not a shared anchor between two emulators but "the first
   * execution of address X" is.
   */
  recordPcTrace(name, { max = 3_000_000, armPc = -1, fromFrame = armPc >= 0 ? -1 : 0, dedupe = true } = {}) {
    const c = this.cpu(name);
    if (!c) return null;
    c.rec.pcLog = {
      buf: new Uint32Array(max), n: 0, max, prev: -1, dedupe,
      armed: false, armPc, fromFrame, armFrame: -1, full: false,
    };
    return c.rec.pcLog;
  }

  pcTrace(name) {
    const L = this.cpu(name)?.rec.pcLog;
    if (!L) return null;
    return { pcs: L.buf.subarray(0, L.n), n: L.n, armed: L.armed, armFrame: L.armFrame, full: L.full };
  }

  /** Execution histogram (tools/life-scan.mjs, tools/loop-profile.mjs). */
  recordPcHistogram(name, on = true) {
    const c = this.cpu(name);
    if (c) c.rec.pcHist = on ? new Map() : null;
    return c?.rec.pcHist ?? null;
  }

  pcHistogram(name, { reset = false } = {}) {
    const c = this.cpu(name);
    const h = c?.rec.pcHist;
    if (!h) return null;
    if (!reset) return h;
    c.rec.pcHist = new Map();
    return h;
  }

  /** I/O census while spinning (tools/loop-profile.mjs). */
  recordIo(name, on = true) {
    const c = this.cpu(name);
    if (!c) return null;
    if (!on) { c.rec.ioHist = null; return null; }
    if (c.arch.ioMask == null) return null; // no I/O space: the answer is "none", honestly
    if (!this._ensureBus(c)) return null;
    c.rec.ioHist = { in: new Map(), out: new Map() };
    return c.rec.ioHist;
  }

  ioHistogram(name, { reset = false } = {}) {
    const c = this.cpu(name);
    const h = c?.rec.ioHist;
    if (!h) return null;
    if (reset) c.rec.ioHist = { in: new Map(), out: new Map() };
    return h;
  }

  /**
   * Memory access log (tools/watch-read.mjs, tools/watch-write.mjs). A read log
   * has no banking ambiguity: it records what the CPU actually got, already
   * resolved through whichever bank was selected — which is why comparing read
   * streams beat comparing memory dumps during the M88 hunt.
   *
   * `annotate(machine, hit)` lets a caller fold in machine-specific routing
   * (which bank the write landed in); the core stays machine-independent.
   */
  recordMem(name, { lo, hi = null, r = false, w = true, pcLo = -1, pcHi = pcLo, max = 4000, onHit = null, annotate = null } = {}) {
    const c = this.cpu(name);
    if (!c) return null;
    if (!this._ensureBus(c)) return null;
    c.rec.memLog = {
      lo: lo & c.arch.addrMask, hi: (hi ?? lo) & c.arch.addrMask,
      r, w, pcLo, pcHi, max, hits: [], total: 0, capped: false, onHit, annotate,
    };
    return c.rec.memLog;
  }

  memLog(name) { return this.cpu(name)?.rec.memLog ?? null; }

  // ---- inspection ------------------------------------------------------------

  // shadow-stack backtrace, innermost first: [{entry, retTo, sp}]
  backtrace(name) {
    const c = this.cpu(name);
    if (!c) return [];
    return [...c.profData.stack].reverse().map((f) => ({ entry: f.entry, retTo: f.retTo ?? 0, sp: f.sp }));
  }

  // run until the current shadow frame returns. Falls back to the SP heuristic
  // (run until SP rises above here) when the stack is empty — e.g. right after
  // attach, before any CALL was observed.
  stepOut(name) {
    const c = this.cpu(name);
    if (!c) return { done: false };
    const arch = c.arch;
    const depth0 = c.profData.stack.length;
    const sp0 = arch.spOf ? arch.spOf(c.cpu) : 0;
    const spMask = arch.spMask ?? 0xffff;
    const push = arch.pushBytes ?? 2;
    const half = ((spMask >>> 1) + 1) >>> 0;
    const hit0 = this.hit;
    let budget = 2_000_000;
    let first = true;
    while (budget-- > 0) {
      // the first step walks off the breakpoint we're parked on; after that,
      // breakpoints stay armed on the way out
      this.stepInto(name, first);
      first = false;
      if (this.hit !== hit0) return { done: false, brk: true };
      if (depth0 > 0) {
        if (c.profData.stack.length < depth0) return { done: true };
      } else {
        const d = ((arch.spOf ? arch.spOf(c.cpu) : 0) - sp0) & spMask;
        if (d >= push && d < half) return { done: true }; // return slot consumed
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
      try { fn = compileCondFor(c.arch, cond); }
      catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    }
    c.bps.set(addr & c.arch.addrMask, { cond, fn, enabled: true, error: null });
    return { ok: true };
  }

  clearBreak(name, addr) {
    const c = this.cpu(name);
    if (c) c.bps.delete(addr & c.arch.addrMask);
  }

  pause() { this.paused = true; }

  resume() {
    // stepping off a breakpoint: give the instruction under the cursor one free
    // pass, or we'd break forever on the same spot
    for (const c of this.cpus) {
      const pc = c.arch.pcOf(c.cpu);
      if (c.bps.has(pc)) c.skipOnce = pc;
    }
    this.paused = false;
    this.hit = null;
  }

  stepInto(name, skipBp = true) {
    // goes through the wrapped step so T-states and the profiler see manual
    // steps too; skipOnce keeps a breakpoint under the cursor quiet
    const c = this.cpu(name);
    if (!c) return 0;
    if (skipBp) c.skipOnce = c.arch.pcOf(c.cpu);
    c.irq.pre?.();
    let t = 0;
    try { t = c.cpu.step(); } catch (e) { if (e !== BREAK) throw e; }
    c.irq.post?.();
    return t;
  }

  stepOver(name) {
    const c = this.cpu(name);
    if (!c) return { done: false };
    const arch = c.arch;
    if (!arch.disasm) { this.stepInto(name); return { done: true, degraded: 'no disassembler' }; }
    const pc = arch.pcOf(c.cpu);
    const d = arch.disasm(c.read, pc);
    if (!arch.isCall(d.text)) { this.stepInto(name); return { done: true }; }
    const target = (pc + d.len) & arch.addrMask;
    const hit0 = this.hit;
    this.stepInto(name);
    let budget = 2_000_000; // a runaway callee must not hang the debugger
    while (arch.pcOf(c.cpu) !== target && budget-- > 0) {
      this.stepInto(name, false); // callee breakpoints stay armed
      if (this.hit !== hit0) return { done: false, brk: true };
    }
    return { done: arch.pcOf(c.cpu) === target, budget: budget > 0 };
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
    for (const c of this.cpus) {
      const pc = c.arch.pcOf(c.cpu);
      if (c.bps.has(pc)) c.skipOnce = pc;
    }
    this.paused = false;
    try { this._origStepFrame.call(this.machine); }
    catch (e) { if (e !== BREAK) throw e; }
    this.paused = true;
  }

  /**
   * The headless drive loop. Runs whole frames through the wrapped stepFrame so
   * breakpoints still fire; stops early on a break and says why.
   * `onFrame(frame, i)` returning `false` stops the run (that is how a CLI
   * implements "sample every 100 frames").
   */
  runFrames(n, { onFrame = null } = {}) {
    const m = this.machine;
    if (!m) return { frames: 0, stopped: 'no machine' };
    for (let i = 0; i < n; i++) {
      if (this.paused) return { frames: i, stopped: 'break', hit: this.hit };
      m.stepFrame();
      if (this.paused) return { frames: i + 1, stopped: 'break', hit: this.hit };
      if (onFrame && onFrame(m.frame, i) === false) return { frames: i + 1, stopped: 'caller' };
    }
    return { frames: n, stopped: 'done' };
  }
}

// The name the browser ICE has always used. Kept so saved sessions, tests and
// demo/ice.js keep compiling against one class.
export class IceController extends IceCore {}

// ---- pure analysis (no machine involved) -------------------------------------

/**
 * Snapshot bisection — the floor under Twin-run diff and under every "when did
 * it go wrong" question. `agrees(n)` must be deterministic and monotone: true
 * for every n below the divergence, false at and after it. Returns the first n
 * where it stops agreeing, or `hi + 1` if it never does.
 *
 * Kept pure (no snapshots in here) so it can be tested without a machine, and
 * so the caller decides whether "n" counts frames, instructions or samples.
 */
export function bisect(lo, hi, agrees) {
  let a = lo, b = hi + 1; // invariant: agrees(a-1) true, agrees(b) unknown→false
  while (a < b) {
    const mid = a + ((b - a) >> 1);
    if (agrees(mid)) a = mid + 1; else b = mid;
  }
  return a;
}

/**
 * Trace comparison (tools/trace-diff.mjs, as a function).
 *
 * A raw line-by-line diff of two emulators is useless: interrupts land a few
 * instructions apart, so healthy traces desynchronise constantly. What matters
 * is whether they keep *re-syncing*. And the more useful lens turned out to be
 * the census — which PCs one side executes that the other never does — because
 * "a wait loop spun 1620 times here and 71 there" is a speed difference, while
 * "a routine entered 598 times on one side and never on the other" is
 * structural.
 *
 * A and B are arrays of comparable keys (hex strings from pc-trace, or numbers).
 */
export function traceDiff(A, B, { window: WIN = 200000 } = {}) {
  const census = (X) => { const c = new Map(); for (const pc of X) c.set(pc, (c.get(pc) ?? 0) + 1); return c; };
  const ca = census(A), cb = census(B);
  const only = (x, y) => [...x].filter(([pc]) => !y.has(pc)).sort((p, q) => q[1] - p[1]);
  const aOnly = only(ca, cb), bOnly = only(cb, ca);

  // Index each side's positions per PC so realignment is a lookup, not a scan.
  // A spin loop can be hundreds of thousands of entries wide, and scanning that
  // window on every mismatch is what made an earlier version report a bogus
  // "permanent divergence" the moment the two sides spun a wait loop differently.
  const indexOf = (X) => {
    const m = new Map();
    for (let i = 0; i < X.length; i++) { const k = X[i]; if (!m.has(k)) m.set(k, []); m.get(k).push(i); }
    return m;
  };
  const aPos = indexOf(A), bPos = indexOf(B);
  const seek = (idx, pc, from) => {
    const arr = idx.get(pc);
    if (!arr) return -1;
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] >= from) { ans = arr[mid]; hi = mid - 1; } else lo = mid + 1; }
    return ans;
  };

  let i = 0, j = 0, resyncs = 0, lastResync = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { i++; j++; continue; }
    const jj = seek(bPos, A[i], j);
    if (jj >= 0 && jj - j <= WIN) { j = jj; resyncs++; lastResync = i; continue; }
    const ii = seek(aPos, B[j], i);
    if (ii >= 0 && ii - i <= WIN) { i = ii; resyncs++; lastResync = i; continue; }
    break;
  }
  const diverged = i < A.length && j < B.length;
  return {
    lenA: A.length, lenB: B.length,
    aOnly, bOnly, resyncs, lastResync,
    diverged, a: i, b: j,
    // A length difference of more than 5% means "X-only" mostly measures "X ran
    // longer" — say so instead of letting the census be read as a verdict.
    lengthWarning: Math.abs(A.length - B.length) > 0.05 * Math.max(A.length, B.length, 1),
  };
}

/**
 * Bucket an execution histogram by address range. life-scan.mjs hard-coded the
 * PC-8801's boundaries; here the edges are an argument, because "LOW<1000" is
 * meaningless on a 68000 and the 6502's zero page is not the Z80's.
 * `edges` is [[limit, name], …] ascending; the last entry catches the rest.
 */
export function bucketize(hist, edges) {
  const out = new Map(edges.map(([, name]) => [name, 0]));
  let total = 0;
  for (const [pc, n] of hist) {
    total += n;
    for (const [limit, name] of edges) {
      if (pc < limit) { out.set(name, out.get(name) + n); break; }
    }
  }
  return { buckets: out, total, distinct: hist.size };
}

export const PC88_BUCKETS = [
  [0x1000, 'LOW<1000'], [0x8000, '1000-7fff'], [0xc000, '8000-bfff'],
  [0xf000, 'c000-efff'], [0x10000, 'f000-ffff'],
];

// ---- pure view models --------------------------------------------------------
// Shared by the browser panes and the CLI: both want the same text.

export function writeReg(cpu, name, v, arch = Z80_ARCH) {
  return arch.writeReg ? arch.writeReg(cpu, name, v) : false;
}

export const REG_FIELDS = Z80_ARCH.regFields;

export function regsModel(cpu, arch = Z80_ARCH) { return arch.regsModel(cpu); }

// disassembly window around pc: walk back a few candidate offsets until one
// lands exactly on pc (instructions are ≤4 bytes on a Z80, so a resync is
// usually found), then decode forward. With no disassembler the rows carry
// bytes only — degraded, not broken.
export function disasmList(read, pc, count = 16, back = 6, opts = {}) {
  const arch = opts.arch ?? Z80_ARCH;
  const mask = arch.addrMask;
  const dis = opts.disasm ?? arch.disasm;
  pc &= mask;
  if (!dis) {
    const rows = [];
    for (let k = 0; k < count; k++) {
      const a = (pc + k) & mask;
      rows.push({ addr: a, text: `DB ${hex(read(a) & 0xff, 2)}h`, len: 1, bytes: [read(a) & 0xff], current: a === pc });
    }
    if (opts.label) for (const r of rows) r.label = opts.label(r.addr) ?? null;
    return rows;
  }
  let pre = [];
  for (let off = Math.min(back * 4, 32); off >= 1; off--) {
    let a = (pc - off) & mask;
    const rows = [];
    while (a !== pc && ((pc - a) & mask) <= off) {
      const d = dis(read, a, opts);
      rows.push({ addr: a, text: d.text, len: d.len, bytes: d.bytes, current: false });
      a = (a + d.len) & mask;
    }
    if (a === pc && rows.length > pre.length) {
      pre = rows.slice(-back);
      if (pre.length >= back) break;
    }
  }
  const rows = pre;
  let a = pc;
  while (rows.length < count) {
    const d = dis(read, a, opts);
    rows.push({ addr: a, text: d.text, len: d.len, bytes: d.bytes, current: a === pc });
    a = (a + d.len) & mask;
  }
  if (opts.label) for (const r of rows) r.label = opts.label(r.addr) ?? null;
  return rows;
}

export function hexDump(read, addr, rows = 16, { mask = 0xffff, width = 4 } = {}) {
  const lines = [];
  for (let r = 0; r < rows; r++) {
    const base = (addr + r * 16) & mask;
    let hx = '', asc = '';
    for (let i = 0; i < 16; i++) {
      const v = read((base + i) & mask) & 0xff;
      hx += hex(v, 2) + (i === 7 ? '  ' : ' ');
      asc += v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : '·';
    }
    lines.push(`${hex(base, width)}: ${hx} ${asc}`);
  }
  return lines.join('\n');
}
