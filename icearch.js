// icearch — what the ICE needs to know about a CPU, as plain data.
//
// The debugger itself (icecore.js) does not know Z80 from 68000. Everything
// architecture-shaped is behind one of these descriptors, so adding a CPU is
// filling in a table rather than editing the debugger. That is the whole
// promise of issue #37: "swap the disassembler and the ICE comes with it".
//
// Selection is a *capability probe*, never `instanceof`. The machine hosts in
// this repo already learned that lesson (demo/machine.html used to branch on
// `machine instanceof Pc8801Machine`); a probe keeps working when a core is
// re-exported, subclassed, or arrives from another branch that has not merged
// yet — which is exactly the situation the 68000/6502 cores are in today.
//
// Contract (all fields optional except name/addrMask/pcOf):
//   name        'z80' | 'm6502' | 'm68000' | …
//   addrMask    address wrap for memory (0xffff, 0xffffff, …)
//   ioMask      port wrap, or null when the CPU has no I/O space
//   pcOf(cpu)   → program counter
//   setPc(cpu,v)
//   spOf(cpu)   → stack pointer, for the shadow call stack's SP unwind
//   spMask      wrap for the SP comparison (0xffff on Z80, 0xff on 6502…)
//   pushBytes   how many bytes a subroutine call pushes (return-slot size)
//   disasm(read, addr, opts) → {text, len, bytes}   — null when we have none
//   isCall(text)                                    — for step-over
//   callAt(read, pc) → {target, retTo} | null       — for the shadow stack
//   condVars / condValues(cpu, read)  — the names a breakpoint condition sees
//   regFields   [[NAME, hexWidth], …] for a register display
//   regsModel(cpu) → {val, flags, info, shadow}
//   tapBus(cpu, hooks) → untap() | null
//
// A descriptor with no disasm/callAt still gives you breakpoints, watchpoints,
// traces, PC histograms and coverage. It degrades, it does not fail — and it
// says which parts are missing (see `capabilities()`).

import { disasm as z80disasm } from './z80dis.js';

export const SCHEMA_VERSION = 1;

const hex = (v, w) => (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

// ---- Z80 --------------------------------------------------------------------
// The names a condition expression sees. This list is load-bearing: the ICE UI
// and every saved breakpoint condition are written against it, so the order and
// spelling must not drift.
export const Z80_COND_VARS = [
  'a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'af', 'bc', 'de', 'hl',
  'ix', 'iy', 'sp', 'pc', 'i', 'r', 'im', 'iff1', 'mem',
];

export const Z80_ARCH = {
  name: 'z80',
  addrMask: 0xffff,
  // Z80 puts BC on the address bus for IN/OUT (C), but the machines here decode
  // 8 bits and the ICE has always matched I/O breaks on the low byte. Keeping
  // the mask means saved I/O breakpoints keep meaning what they meant.
  ioMask: 0xff,
  pcOf: (cpu) => cpu.pc,
  setPc: (cpu, v) => { cpu.pc = v & 0xffff; },
  spOf: (cpu) => cpu.sp,
  spMask: 0xffff,
  pushBytes: 2,
  disasm: z80disasm,
  isCall: (text) => /^(CALL|RST)\b/.test(text),
  // Detected BEFORE the instruction runs and confirmed after, because a
  // conditional CALL only pushes when it is actually taken.
  callAt(read, pc) {
    const op = read(pc) & 0xff;
    if (op === 0xcd || (op & 0xc7) === 0xc4) {
      return {
        target: (read((pc + 1) & 0xffff) | (read((pc + 2) & 0xffff) << 8)) & 0xffff,
        retTo: (pc + 3) & 0xffff,
      };
    }
    if ((op & 0xc7) === 0xc7) return { target: op & 0x38, retTo: (pc + 1) & 0xffff }; // RST
    return null;
  },
  condVars: Z80_COND_VARS,
  condValues: (cpu, read) => [
    cpu.a, cpu.f, cpu.b, cpu.c, cpu.d, cpu.e, cpu.h, cpu.l,
    cpu.af, cpu.bc, cpu.de, cpu.hl, cpu.ix, cpu.iy, cpu.sp, cpu.pc,
    cpu.i, cpu.r, cpu.im, cpu.iff1, read,
  ],
  regFields: [
    ['PC', 4], ['SP', 4], ['AF', 4], ['BC', 4], ['DE', 4], ['HL', 4],
    ['IX', 4], ['IY', 4], ['I', 2], ['R', 2], ['IM', 1],
  ],
  regsModel(cpu) {
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
  },
  writeReg(cpu, name, v) {
    const n = String(name).toLowerCase();
    if (['af', 'bc', 'de', 'hl', 'ix', 'iy', 'sp', 'pc'].includes(n)) { cpu[n] = v & 0xffff; return true; }
    if (n === 'i' || n === 'r') { cpu[n] = v & 0xff; return true; }
    if (n === 'im') { cpu.im = Math.min(2, Math.max(0, v | 0)); return true; }
    return false;
  },
  tapBus(cpu, hooks) {
    const bus = cpu.bus;
    if (!bus) return null;
    const o = { read: bus.read, write: bus.write, in: bus.in, out: bus.out };
    bus.read = (a) => { const v = o.read(a); hooks.read?.(a & 0xffff, v & 0xff, 1); return v; };
    bus.write = (a, v) => { o.write(a, v); hooks.write?.(a & 0xffff, v & 0xff, 1); };
    if (o.in) bus.in = (p) => { const v = o.in(p); hooks.in?.(p & 0xff, v & 0xff); return v; };
    if (o.out) bus.out = (p, v) => { o.out(p, v); hooks.out?.(p & 0xff, v & 0xff); };
    return () => { bus.read = o.read; bus.write = o.write; bus.in = o.in; bus.out = o.out; };
  },
  busRead: (cpu) => (cpu.bus ? (a) => cpu.bus.read(a & 0xffff) & 0xff : null),
  busWrite: (cpu) => (cpu.bus ? (a, v) => cpu.bus.write(a & 0xffff, v & 0xff) : null),
};

// ---- 6502 / 2A03 -------------------------------------------------------------
// No disassembler in the tree yet (the NES branch ships m6502.js only), so
// `disasm` is null and the ICE shows hex where it would show mnemonics. That is
// the honest degradation: everything that does not need decoding still works.
export const M6502_ARCH = {
  name: 'm6502',
  addrMask: 0xffff,
  ioMask: null, // memory-mapped I/O only — an I/O breakpoint is a watchpoint here
  pcOf: (cpu) => cpu.pc,
  setPc: (cpu, v) => { cpu.pc = v & 0xffff; },
  // The 6502's stack pointer is the low byte of a fixed page. Unwinding
  // compares S directly, so the mask is 8-bit.
  spOf: (cpu) => cpu.s,
  spMask: 0xff,
  pushBytes: 2,
  disasm: null,
  isCall: (text) => /^JSR\b/.test(text),
  callAt(read, pc) {
    if ((read(pc) & 0xff) !== 0x20) return null; // JSR abs
    return {
      target: (read((pc + 1) & 0xffff) | (read((pc + 2) & 0xffff) << 8)) & 0xffff,
      retTo: (pc + 3) & 0xffff,
    };
  },
  condVars: ['a', 'x', 'y', 's', 'p', 'pc', 'cycles', 'mem'],
  condValues: (cpu, read) => [cpu.a, cpu.x, cpu.y, cpu.s, cpu.p, cpu.pc, cpu.cycles ?? 0, read],
  regFields: [['PC', 4], ['A', 2], ['X', 2], ['Y', 2], ['S', 2], ['P', 2]],
  regsModel(cpu) {
    const val = { PC: cpu.pc, A: cpu.a, X: cpu.x, Y: cpu.y, S: cpu.s, P: cpu.p };
    const flags = 'NV-BDIZC'.split('').map((ch, i) => ((cpu.p & (0x80 >> i)) ? ch : '·')).join('');
    return { val, flags, info: `P ${flags}${cpu.jammed ? '  ⏸JAM' : ''}`, shadow: '' };
  },
  writeReg(cpu, name, v) {
    const n = String(name).toLowerCase();
    if (n === 'pc') { cpu.pc = v & 0xffff; return true; }
    if (['a', 'x', 'y', 's', 'p'].includes(n)) { cpu[n] = v & 0xff; return true; }
    return false;
  },
  tapBus(cpu, hooks) {
    const bus = cpu.bus;
    if (!bus || typeof bus.read !== 'function') return null;
    const o = { read: bus.read, write: bus.write };
    bus.read = (a) => { const v = o.read(a); hooks.read?.(a & 0xffff, v & 0xff, 1); return v; };
    bus.write = (a, v) => { o.write(a, v); hooks.write?.(a & 0xffff, v & 0xff, 1); };
    return () => { bus.read = o.read; bus.write = o.write; };
  },
  busRead: (cpu) => (cpu.bus ? (a) => cpu.bus.read(a & 0xffff) & 0xff : null),
  busWrite: (cpu) => (cpu.bus ? (a, v) => cpu.bus.write(a & 0xffff, v & 0xff) : null),
};

// ---- 68000 -------------------------------------------------------------------
// The acceptance socket for the 68000 ICE. m68000.js normalises whatever bus it
// is handed into {read16, write16, read8, write8} and stores that object on
// `cpu.bus`, so the tap goes on the normalised object and catches every access
// including the 8-bit halves the core synthesises.
//
// `callAt` is null on purpose: BSR/JSR need a real 68000 decoder to find the
// instruction length, and guessing would corrupt the shadow stack. Fill in
// `disasm` and `callAt` together when the disassembler lands.
export const M68K_ARCH = {
  name: 'm68000',
  addrMask: 0xffffff,
  ioMask: null,
  pcOf: (cpu) => cpu.pc >>> 0,
  setPc: (cpu, v) => { cpu.pc = v >>> 0; },
  spOf: (cpu) => cpu.a[7] >>> 0,
  spMask: 0xffffffff,
  pushBytes: 4,
  disasm: null,
  isCall: (text) => /^(JSR|BSR)\b/.test(text),
  callAt: null,
  condVars: [
    'd0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7',
    'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
    'pc', 'sr', 'cycles', 'mem',
  ],
  condValues: (cpu, read) => [
    cpu.d[0], cpu.d[1], cpu.d[2], cpu.d[3], cpu.d[4], cpu.d[5], cpu.d[6], cpu.d[7],
    cpu.a[0], cpu.a[1], cpu.a[2], cpu.a[3], cpu.a[4], cpu.a[5], cpu.a[6], cpu.a[7],
    cpu.pc >>> 0, M68K_ARCH.srOf(cpu), cpu.cycles ?? 0, read,
  ],
  srOf: (cpu) => ((cpu.sr_t ? 0x8000 : 0) | (cpu.sr_s ? 0x2000 : 0) | ((cpu.sr_ipm & 7) << 8)
    | (cpu.fx ? 0x10 : 0) | (cpu.fn ? 8 : 0) | (cpu.fz ? 4 : 0) | (cpu.fv ? 2 : 0) | (cpu.fc ? 1 : 0)),
  regFields: [['PC', 6], ['SR', 4],
    ['D0', 8], ['D1', 8], ['D2', 8], ['D3', 8], ['D4', 8], ['D5', 8], ['D6', 8], ['D7', 8],
    ['A0', 8], ['A1', 8], ['A2', 8], ['A3', 8], ['A4', 8], ['A5', 8], ['A6', 8], ['A7', 8]],
  regsModel(cpu) {
    const val = { PC: cpu.pc >>> 0, SR: M68K_ARCH.srOf(cpu) };
    for (let i = 0; i < 8; i++) { val[`D${i}`] = cpu.d[i] >>> 0; val[`A${i}`] = cpu.a[i] >>> 0; }
    const flags = `${cpu.fx ? 'X' : '·'}${cpu.fn ? 'N' : '·'}${cpu.fz ? 'Z' : '·'}${cpu.fv ? 'V' : '·'}${cpu.fc ? 'C' : '·'}`;
    return {
      val, flags,
      info: `CCR ${flags}  ${cpu.sr_s ? 'S' : 'U'} IPM${cpu.sr_ipm & 7}${cpu.stopped ? '  ⏸STOP' : ''}${cpu.halted ? '  ⏹HALT' : ''}`,
      shadow: '',
    };
  },
  writeReg(cpu, name, v) {
    const n = String(name).toUpperCase();
    if (n === 'PC') { cpu.pc = v >>> 0; return true; }
    let m = /^D([0-7])$/.exec(n);
    if (m) { cpu.d[+m[1]] = v >>> 0; return true; }
    m = /^A([0-7])$/.exec(n);
    if (m) { cpu.a[+m[1]] = v >>> 0; return true; }
    return false;
  },
  tapBus(cpu, hooks) {
    const bus = cpu.bus;
    if (!bus || typeof bus.read16 !== 'function') return null;
    const o = { read16: bus.read16, write16: bus.write16, read8: bus.read8, write8: bus.write8 };
    bus.read16 = (a) => { const v = o.read16(a); hooks.read?.(a >>> 0, v & 0xffff, 2); return v; };
    bus.write16 = (a, v) => { o.write16(a, v); hooks.write?.(a >>> 0, v & 0xffff, 2); };
    if (o.read8) bus.read8 = (a) => { const v = o.read8(a); hooks.read?.(a >>> 0, v & 0xff, 1); return v; };
    if (o.write8) bus.write8 = (a, v) => { o.write8(a, v); hooks.write?.(a >>> 0, v & 0xff, 1); };
    return () => { bus.read16 = o.read16; bus.write16 = o.write16; bus.read8 = o.read8; bus.write8 = o.write8; };
  },
  busRead: (cpu) => (cpu.bus?.read8 ? (a) => cpu.bus.read8(a >>> 0) & 0xff : null),
  busWrite: (cpu) => (cpu.bus?.write8 ? (a, v) => cpu.bus.write8(a >>> 0, v & 0xff) : null),
};

// ---- fallback ----------------------------------------------------------------
// Anything with `pc` and `step()`. Breakpoints, PC traces, histograms and
// coverage still work; conditions see only `pc` and `mem`.
export const GENERIC_ARCH = {
  name: 'generic',
  addrMask: 0xffff,
  ioMask: null,
  pcOf: (cpu) => cpu.pc >>> 0,
  setPc: (cpu, v) => { cpu.pc = v >>> 0; },
  spOf: (cpu) => (cpu.sp ?? cpu.s ?? 0) >>> 0,
  spMask: 0xffff,
  pushBytes: 2,
  disasm: null,
  isCall: () => false,
  callAt: null,
  condVars: ['pc', 'mem'],
  condValues: (cpu, read) => [GENERIC_ARCH.pcOf(cpu), read],
  regFields: [['PC', 4]],
  regsModel: (cpu) => ({ val: { PC: GENERIC_ARCH.pcOf(cpu) }, flags: '', info: '', shadow: '' }),
  writeReg(cpu, name, v) {
    if (String(name).toLowerCase() === 'pc') { cpu.pc = v >>> 0; return true; }
    return false;
  },
  tapBus(cpu, hooks) {
    const bus = cpu.bus;
    if (!bus || typeof bus.read !== 'function') return null;
    const o = { read: bus.read, write: bus.write };
    bus.read = (a) => { const v = o.read(a); hooks.read?.(a >>> 0, v & 0xff, 1); return v; };
    if (o.write) bus.write = (a, v) => { o.write(a, v); hooks.write?.(a >>> 0, v & 0xff, 1); };
    return () => { bus.read = o.read; bus.write = o.write; };
  },
  busRead: (cpu) => (cpu.bus?.read ? (a) => cpu.bus.read(a) & 0xff : null),
  busWrite: (cpu) => (cpu.bus?.write ? (a, v) => cpu.bus.write(a, v & 0xff) : null),
};

// Registry order matters: the first descriptor whose probe accepts the object
// wins, so more specific shapes must come before looser ones.
const REGISTRY = [
  // Z80: the shadow set + interrupt mode is a fingerprint nothing else has.
  { arch: Z80_ARCH, probe: (c) => typeof c.af === 'number' && typeof c.iff1 !== 'undefined' && typeof c.im === 'number' },
  // 68000: eight data and eight address registers as typed arrays.
  { arch: M68K_ARCH, probe: (c) => c.d?.length === 8 && c.a?.length === 8 && typeof c.pc === 'number' },
  // 6502: A/X/Y + the P status byte + an 8-bit S.
  { arch: M6502_ARCH, probe: (c) => typeof c.a === 'number' && typeof c.x === 'number' && typeof c.y === 'number' && typeof c.p === 'number' && typeof c.s === 'number' },
];

export function registerArch(arch, probe) {
  REGISTRY.unshift({ arch, probe });
  return arch;
}

export function detectArch(cpu) {
  if (!cpu || typeof cpu.step !== 'function') return null;
  for (const { arch, probe } of REGISTRY) {
    try { if (probe(cpu)) return arch; } catch { /* a probe must never throw the caller off */ }
  }
  return GENERIC_ARCH;
}

// What this descriptor can and cannot do, so a caller can say so out loud
// instead of quietly showing an empty panel.
export function capabilities(arch) {
  return {
    name: arch?.name ?? 'none',
    disassembly: !!arch?.disasm,
    callStack: !!arch?.callAt,
    io: arch?.ioMask != null,
    conditions: (arch?.condVars ?? []).length > 0,
  };
}
