// z80anal — static analysis of assembled Z80 code, one subroutine at a time.
// Pure JS, zero deps, deterministic.
//
// Feed it what z80asm.js hands back (bytes + org + symbols) and it walks each
// routine (label → unconditional RET/JP/next label) collecting what a caller
// actually wants to know before trusting someone else's code:
//
// - destroyed / input / saved registers. "Saved" = PUSH…POP symmetric pairs;
//   destroyed registers of CALLed routines propagate transitively through the
//   call graph (fixed-point, so recursion converges; indirect JP (HL) marks
//   the routine "unknown" instead of lying).
// - I/O ports touched, annotated with PC-8801 port names (main or sub board
//   — the tables live here as constants). IN r,(C) forms are "dynamic".
// - memory touched through immediate addresses, read/write split, annotated
//   with the known PC-88 regions (text VRAM, RAM hooks, disk work, GVRAM
//   window). (HL)-style access is "dynamic".
// - stack lint: PUSH/POP imbalance at RET, POP with nothing pushed (that's
//   your return address!), and paths reaching the same spot at different
//   depths.
// - T-states: min/max along the linear walk (both branch outcomes), using
//   the same cycle accounting as z80.js so ICE timings agree with what this
//   emulator actually charges.
// - extras: cross references (who calls whom) and ⚡ self-modifying-code
//   detection (a store into the code range is an era-appropriate art form,
//   so it's a warning with sparkle, not an error).
//
//   analyze(bytes, org, symbols, { ports: 'pc88-main' | 'pc88-sub' | null })
//     → { schemaVersion, routines: [...], xref }

import { disasm, hexN } from './z80dis.js';

export const SCHEMA_VERSION = 1;

// ---- machine annotation tables ----------------------------------------------
export const PORTS_PC88_MAIN = [
  [0x00, 0x0f, 'keyboard matrix'],
  [0x10, 0x10, 'printer / calendar latch'],
  [0x20, 0x21, '8251 SIO (CMT/RS232C)'],
  [0x30, 0x30, 'system: 40/80col, CMT motor'],
  [0x31, 0x31, 'memory/graphics: ROM/RAM, GVRAM on, color'],
  [0x32, 0x32, 'ext-ROM bank / palette mode (SR)'],
  [0x40, 0x40, 'in: VRTC/strobe, out: misc'],
  [0x44, 0x45, 'YM2203 sound'],
  [0x50, 0x50, 'CRTC μPD3301 parameter'],
  [0x51, 0x51, 'CRTC μPD3301 command/status'],
  [0x54, 0x5b, 'palette (512-color cube)'],
  [0x5c, 0x5f, 'GVRAM window select (B/R/G/RAM)'],
  [0x60, 0x68, 'DMAC μPD8257'],
  [0x70, 0x70, 'text window offset'],
  [0x71, 0x71, 'ext ROM select'],
  [0xe2, 0xe3, 'EMM bank'],
  [0xe4, 0xe4, 'interrupt level (μPD8214)'],
  [0xe6, 0xe6, 'interrupt mask'],
  [0xfc, 0xff, 'FDD sub-system 8255 (main side)'],
];

export const PORTS_PC88_SUB = [
  [0xf4, 0xf4, 'drive mode'],
  [0xf7, 0xf7, 'printer port (unused)'],
  [0xf8, 0xf8, 'in: FDC TC pulse / out: drive motors'],
  [0xfa, 0xfa, 'μPD765 FDC status'],
  [0xfb, 0xfb, 'μPD765 FDC data'],
  [0xfc, 0xff, 'FDD sub-system 8255 (sub side)'],
];

export const MEM_PC88 = [
  [0xed00, 0xeeff, 'RAM hooks'],
  [0xef00, 0xefff, 'disk work area'],
  [0xf300, 0xf3c7, 'BASIC work'],
  [0xf3c8, 0xfeb7, 'text VRAM'],
  [0xfeb8, 0xffff, 'work area / function keys'],
  [0xc000, 0xffff, 'GVRAM window (when banked in)'],
];

const inTable = (table, v) => {
  for (const [lo, hi, name] of table) if (v >= lo && v <= hi) return name;
  return null;
};

export function portName(port, machine = 'pc88-main') {
  const table = machine === 'pc88-sub' ? PORTS_PC88_SUB : machine === 'pc88-main' ? PORTS_PC88_MAIN : null;
  return table ? inTable(table, port & 0xff) : null;
}

export function memName(addr) {
  return inTable(MEM_PC88, addr & 0xffff);
}

// ---- per-instruction metadata ------------------------------------------------
// What one instruction reads/writes/costs. Register grain: A F B C D E H L
// I R IX IY SP (index registers as whole units). T-states follow z80.js's
// accounting (standard values; prefixed forms pay the prefix fetch).
const RN = ['B', 'C', 'D', 'E', 'H', 'L', null, 'A'];

export function metaOf(read, addr) {
  addr &= 0xffff;
  let len = 0;
  let pfx = 0, ixy = null;
  const rd = () => read((addr + len++) & 0xffff) & 0xff;
  const rd16 = () => { const lo = rd(); return lo | (rd() << 8); };
  const m = {
    len: 0, t: [4, 4], reads: [], writes: [], flow: 'next', target: null,
    push: null, pop: null, io: null, mem: null, dyn: false, sp: false,
  };
  const R = (...r) => { for (const x of r) if (x) m.reads.push(x); };
  const W = (...r) => { for (const x of r) if (x) m.writes.push(x); };
  const T = (a, b = a) => { m.t = [a + pfx, b + pfx]; };
  const done = () => { m.len = len; return m; };

  let op = rd();
  if (op === 0xdd || op === 0xfd) {
    const nxt = read((addr + len) & 0xffff) & 0xff;
    if (nxt === 0xdd || nxt === 0xfd || nxt === 0xed) { T(4); return done(); } // dead prefix
    ixy = op === 0xdd ? 'IX' : 'IY';
    op = rd();
    pfx = 4;
  }

  const rpRegs = (i) => (i === 0 ? ['B', 'C'] : i === 1 ? ['D', 'E'] : i === 2 ? (ixy ? [ixy] : ['H', 'L']) : ['SP']);
  const rp2Regs = (i) => (i === 3 ? ['A', 'F'] : rpRegs(i));
  const rpName = (i) => (i === 0 ? 'BC' : i === 1 ? 'DE' : i === 2 ? (ixy ?? 'HL') : 'SP');
  const rp2Name = (i) => (i === 3 ? 'AF' : rpName(i));

  // ---- CB ----
  if (op === 0xcb) {
    if (ixy) { rd(); R(ixy); m.dyn = true; } // d byte; address via IX/IY
    const op2 = rd();
    const x = op2 >> 6, y = (op2 >> 3) & 7, z = op2 & 7;
    const memForm = !!ixy || z === 6;
    if (!ixy && z === 6) { R('H', 'L'); m.dyn = true; }
    const reg = ixy ? (z !== 6 ? RN[z] : null) : (z !== 6 ? RN[z] : null);
    if (x === 0) { // rotates/shifts
      if (y === 2 || y === 3) R('F'); // RL/RR pull carry in
      if (!memForm) R(reg);
      if (reg) W(reg); // includes the DDCB copy form
      W('F');
      T(ixy ? 23 : memForm ? 15 : 8);
    } else if (x === 1) { // BIT
      if (!memForm) R(reg);
      W('F');
      T(ixy ? 20 : memForm ? 12 : 8);
    } else { // RES/SET
      if (!memForm) R(reg);
      if (reg) W(reg);
      T(ixy ? 23 : memForm ? 15 : 8);
    }
    return done();
  }

  // ---- ED ----
  if (op === 0xed) {
    const op2 = rd();
    const x = op2 >> 6, y = (op2 >> 3) & 7, z = op2 & 7;
    if (x === 1) {
      switch (z) {
        case 0: // IN r,(C)
          R('B', 'C');
          if (y !== 6) W(RN[y]);
          W('F');
          m.io = { dir: 'in', port: null };
          T(12);
          return done();
        case 1: // OUT (C),r
          R('B', 'C');
          if (y !== 6) R(RN[y]);
          m.io = { dir: 'out', port: null };
          T(12);
          return done();
        case 2: // ADC/SBC HL,rp
          R('H', 'L', 'F', ...rpRegs(y >> 1));
          W('H', 'L', 'F');
          T(15);
          return done();
        case 3: { // LD (nn),rp / LD rp,(nn)
          const nn = rd16();
          if (y & 1) { W(...rpRegs(y >> 1)); m.mem = { addr: nn, rw: 'r', size: 2 }; }
          else { R(...rpRegs(y >> 1)); m.mem = { addr: nn, rw: 'w', size: 2 }; }
          T(20);
          return done();
        }
        case 4: R('A'); W('A', 'F'); T(8); return done(); // NEG
        case 5: m.flow = 'ret'; T(14); return done(); // RETN/RETI
        case 6: T(8); return done(); // IM
        default:
          switch (y) {
            case 0: R('A'); W('I'); T(9); return done();
            case 1: R('A'); W('R'); T(9); return done();
            case 2: R('I'); W('A', 'F'); T(9); return done();
            case 3: R('R'); W('A', 'F'); T(9); return done();
            case 4: case 5: R('A', 'H', 'L'); W('A', 'F'); m.dyn = true; T(18); return done(); // RRD/RLD
            default: T(8); return done();
          }
      }
    }
    if (x === 2 && z <= 3 && y >= 4) { // block ops
      const repeat = y >= 6;
      m.dyn = true;
      if (z === 0) { R('B', 'C', 'D', 'E', 'H', 'L'); W('B', 'C', 'D', 'E', 'H', 'L', 'F'); }
      else if (z === 1) { R('A', 'B', 'C', 'H', 'L'); W('B', 'C', 'H', 'L', 'F'); }
      else if (z === 2) { R('B', 'C', 'H', 'L'); W('B', 'H', 'L', 'F'); m.io = { dir: 'in', port: null }; }
      else { R('B', 'C', 'H', 'L'); W('B', 'H', 'L', 'F'); m.io = { dir: 'out', port: null }; }
      T(16, repeat ? 21 : 16);
      return done();
    }
    T(8);
    return done();
  }

  const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
  const useHalves = ixy && !(x === 1 ? (y === 6 || z === 6) : x === 0 ? y === 6 : z === 6);
  // one 8-bit operand: regs read for addressing, whether it's memory
  const rop = (i) => {
    if (i === 6) {
      m.dyn = true;
      if (ixy) { rd(); return { regs: [ixy], mem: true }; }
      return { regs: ['H', 'L'], mem: true };
    }
    if (useHalves && (i === 4 || i === 5)) return { regs: [ixy], mem: false };
    return { regs: [RN[i]], mem: false };
  };

  if (x === 1) {
    if (op === 0x76) { m.flow = 'halt'; T(4); return done(); }
    const dst = rop(y), src = rop(z);
    R(...src.regs);
    if (dst.mem) R(...dst.regs); // address computation
    else W(...dst.regs);
    T(dst.mem || src.mem ? (ixy ? 19 : 7) : 4);
    return done();
  }
  if (x === 2) {
    const o = rop(z);
    R('A', ...o.regs);
    if (y === 1 || y === 3) R('F'); // ADC/SBC
    if (y === 7) W('F'); // CP leaves A alone
    else W('A', 'F');
    T(o.mem ? (ixy ? 19 : 7) : 4);
    return done();
  }
  if (x === 0) {
    switch (z) {
      case 0:
        if (y === 0) { T(4); return done(); } // NOP
        if (y === 1) { R('A', 'F'); W('A', 'F'); T(4); return done(); } // EX AF,AF'
        if (y === 2) { // DJNZ
          const d = (rd() << 24) >> 24;
          R('B'); W('B');
          m.flow = 'branch';
          m.target = (addr + len + d) & 0xffff;
          T(8, 13);
          return done();
        }
        if (y === 3) { // JR
          const d = (rd() << 24) >> 24;
          m.flow = 'jump';
          m.target = (addr + len + d) & 0xffff;
          T(12);
          return done();
        }
        { // JR cc
          const d = (rd() << 24) >> 24;
          R('F');
          m.flow = 'branch';
          m.target = (addr + len + d) & 0xffff;
          T(7, 12);
          return done();
        }
      case 1:
        if (y & 1) { // ADD HL,rp
          R(...rpRegs(2), ...rpRegs(y >> 1));
          W(...rpRegs(2), 'F');
          T(11);
          return done();
        }
        rd16(); // LD rp,nn
        W(...rpRegs(y >> 1));
        if ((y >> 1) === 3) m.sp = true;
        T(10);
        return done();
      case 2:
        switch (y) {
          case 0: R('B', 'C', 'A'); m.dyn = true; T(7); return done(); // LD (BC),A
          case 1: R('B', 'C'); W('A'); m.dyn = true; T(7); return done();
          case 2: R('D', 'E', 'A'); m.dyn = true; T(7); return done();
          case 3: R('D', 'E'); W('A'); m.dyn = true; T(7); return done();
          case 4: { const nn = rd16(); R(...rpRegs(2)); m.mem = { addr: nn, rw: 'w', size: 2 }; T(16); return done(); }
          case 5: { const nn = rd16(); W(...rpRegs(2)); m.mem = { addr: nn, rw: 'r', size: 2 }; T(16); return done(); }
          case 6: { const nn = rd16(); R('A'); m.mem = { addr: nn, rw: 'w', size: 1 }; T(13); return done(); }
          default: { const nn = rd16(); W('A'); m.mem = { addr: nn, rw: 'r', size: 1 }; T(13); return done(); }
        }
      case 3: // INC/DEC rp
        R(...rpRegs(y >> 1));
        W(...rpRegs(y >> 1));
        if ((y >> 1) === 3) m.sp = true;
        T(6);
        return done();
      case 4: case 5: { // INC/DEC r
        const o = rop(y);
        R(...o.regs);
        if (o.mem) { /* rw through memory */ }
        else W(...o.regs);
        W('F');
        T(o.mem ? (ixy ? 23 : 11) : 4);
        return done();
      }
      case 6: { // LD r,n
        const o = rop(y); // (IX+d): d before n
        rd();
        if (o.mem) R(...o.regs);
        else W(...o.regs);
        T(o.mem ? (ixy ? 19 : 10) : 7);
        return done();
      }
      default:
        if (y <= 3) { R('A'); if (y === 2 || y === 3) R('F'); W('A', 'F'); T(4); return done(); } // RLCA…RRA
        if (y === 4) { R('A', 'F'); W('A', 'F'); T(4); return done(); } // DAA
        if (y === 5) { R('A'); W('A', 'F'); T(4); return done(); } // CPL
        if (y === 6) { W('F'); T(4); return done(); } // SCF
        R('F'); W('F'); T(4); return done(); // CCF
    }
  }
  // x === 3
  switch (z) {
    case 0: R('F'); m.flow = 'retcond'; T(5, 11); return done(); // RET cc
    case 1:
      if (!(y & 1)) { // POP
        W(...rp2Regs(y >> 1));
        m.pop = rp2Name(y >> 1);
        T(10);
        return done();
      }
      switch (y >> 1) {
        case 0: m.flow = 'ret'; T(10); return done(); // RET
        case 1: R('B', 'C', 'D', 'E', 'H', 'L'); W('B', 'C', 'D', 'E', 'H', 'L'); T(4); return done(); // EXX
        case 2: R(...rpRegs(2)); m.flow = 'jumpind'; T(4); return done(); // JP (HL)
        default: R(...rpRegs(2)); W('SP'); m.sp = true; T(6); return done(); // LD SP,HL
      }
    case 2: { // JP cc,nn
      const nn = rd16();
      R('F');
      m.flow = 'branch';
      m.target = nn;
      T(10, 10);
      return done();
    }
    case 3:
      switch (y) {
        case 0: { const nn = rd16(); m.flow = 'jump'; m.target = nn; T(10); return done(); } // JP nn
        case 2: { const n = rd(); R('A'); m.io = { dir: 'out', port: n }; T(11); return done(); }
        case 3: { const n = rd(); W('A'); m.io = { dir: 'in', port: n }; T(11); return done(); }
        case 4: R('SP', ...rpRegs(2)); W(...rpRegs(2)); m.dyn = true; T(19); return done(); // EX (SP),HL
        case 5: R('D', 'E', 'H', 'L'); W('D', 'E', 'H', 'L'); T(4); return done(); // EX DE,HL
        default: T(4); return done(); // DI/EI
      }
    case 4: { // CALL cc,nn
      const nn = rd16();
      R('F');
      m.flow = 'call';
      m.cond = true;
      m.target = nn;
      T(10, 17);
      return done();
    }
    case 5:
      if (!(y & 1)) { // PUSH
        R(...rp2Regs(y >> 1));
        m.push = rp2Name(y >> 1);
        T(11);
        return done();
      }
      { const nn = rd16(); m.flow = 'call'; m.target = nn; T(17); return done(); } // CALL nn
    case 6: { // ALU A,n
      rd();
      R('A');
      if (y === 1 || y === 3) R('F');
      if (y === 7) W('F');
      else W('A', 'F');
      T(7);
      return done();
    }
    default: // RST
      m.flow = 'call';
      m.target = y << 3;
      T(11);
      return done();
  }
}

// ---- routine-level analysis ---------------------------------------------------
const PAIR_REGS = { BC: ['B', 'C'], DE: ['D', 'E'], HL: ['H', 'L'], AF: ['A', 'F'], IX: ['IX'], IY: ['IY'], SP: ['SP'] };
const REG_ORDER = ['A', 'F', 'B', 'C', 'D', 'E', 'H', 'L', 'IX', 'IY', 'SP', 'I', 'R'];
const sortRegs = (set) => REG_ORDER.filter((r) => set.has(r));

export function analyze(bytes, org, symbols = {}, { ports = 'pc88-main' } = {}) {
  org &= 0xffff;
  const end = org + bytes.length;
  const read = (a) => (a >= org && a < end ? bytes[a - org] : 0);

  // label map: symbol value → name(s), only labels that land in the code.
  // Local labels (NAME.LOOP) mark loop targets, not routine boundaries.
  const byAddr = new Map();
  for (const [name, v] of Object.entries(symbols)) {
    if (typeof v !== 'number' || v < org || v >= end) continue;
    if (name.includes('.') || name.includes('~')) continue;
    if (byAddr.has(v)) byAddr.get(v).push(name);
    else byAddr.set(v, [name]);
  }
  const starts = [...byAddr.keys()].sort((a, b) => a - b);
  if (!starts.length || starts[0] !== org) starts.unshift(org);

  const routines = starts.map((addr, i) => ({
    name: byAddr.get(addr)?.join('/') ?? (addr === org ? '(entry)' : `L${addr.toString(16).toUpperCase().padStart(4, '0')}`),
    addr,
    limit: starts[i + 1] ?? end,
    end: addr,
    inputs: new Set(),
    writes: new Set(),
    saves: new Set(),
    calls: [],
    callers: [],
    io: [],
    mem: [],
    warnings: [],
    tStates: { min: 0, max: 0, loop: false },
    unknown: false,
  }));
  const routineAt = new Map(routines.map((r) => [r.addr, r]));

  for (const r of routines) {
    let a = r.addr;
    const written = new Set();
    const pushStack = [];
    let depth = 0, lintOn = true;
    const depthAt = new Map(); // branch target → expected depth
    const seenIO = new Set(), seenMem = new Set(), seenCalls = new Set();

    while (a < r.limit) {
      if (depthAt.has(a) && lintOn && depthAt.get(a) !== depth) {
        r.warnings.push({ type: 'stack', message: `paths reach ${hex4(a)} at different stack depths` });
        lintOn = false;
      }
      const m = metaOf(read, a);
      const next = (a + m.len) & 0xffff;
      r.tStates.min += m.t[0];
      r.tStates.max += m.t[1];

      for (const reg of m.reads) if (!written.has(reg)) r.inputs.add(reg);
      for (const reg of m.writes) { written.add(reg); r.writes.add(reg); }

      if (m.push) {
        pushStack.push(m.push);
        depth++;
      }
      if (m.pop) {
        if (pushStack.length) {
          const top = pushStack.pop();
          if (top === m.pop) for (const reg of PAIR_REGS[m.pop]) r.saves.add(reg);
          // mismatched pair = data move through the stack, not a save
        } else if (lintOn) {
          r.warnings.push({ type: 'stack', message: `POP ${m.pop} with nothing pushed — that's the return address` });
          lintOn = false;
        }
        depth = Math.max(0, depth - 1);
      }
      if (m.sp && lintOn) lintOn = false; // SP surgery — depth lint would just lie

      if (m.io) {
        const key = `${m.io.dir}:${m.io.port ?? 'dyn'}`;
        if (!seenIO.has(key)) {
          seenIO.add(key);
          r.io.push({
            dir: m.io.dir,
            port: m.io.port,
            dynamic: m.io.port === null,
            name: m.io.port === null ? null : portName(m.io.port, ports),
          });
        }
      }
      if (m.mem) {
        const key = `${m.mem.rw}:${m.mem.addr}`;
        if (!seenMem.has(key)) {
          seenMem.add(key);
          r.mem.push({ addr: m.mem.addr, rw: m.mem.rw, name: memName(m.mem.addr) });
        }
        if (m.mem.rw === 'w' && m.mem.addr >= org && m.mem.addr < end) {
          const t = routines.filter((q) => q.addr <= m.mem.addr).pop();
          r.warnings.push({
            type: 'selfmod',
            message: `⚡ self-modifying: writes ${t ? t.name + '+' + (m.mem.addr - t.addr) : hex4(m.mem.addr)}`,
          });
        }
      }
      if (m.dyn) r.dynamicMem = true;

      if (m.flow === 'call') {
        if (m.target !== null && !seenCalls.has(m.target)) {
          seenCalls.add(m.target);
          r.calls.push({ addr: m.target, name: routineAt.get(m.target)?.name ?? null, external: !routineAt.has(m.target) });
        }
      } else if (m.flow === 'branch') {
        if (m.target !== null) {
          if (m.target >= r.addr && m.target < r.limit) {
            if (m.target <= a) r.tStates.loop = true;
            if (!depthAt.has(m.target)) depthAt.set(m.target, depth);
            else if (lintOn && depthAt.get(m.target) !== depth) {
              r.warnings.push({ type: 'stack', message: `paths reach ${hex4(m.target)} at different stack depths` });
              lintOn = false;
            }
          } else if (!seenCalls.has(m.target)) { // conditional tail jump
            seenCalls.add(m.target);
            r.calls.push({ addr: m.target, name: routineAt.get(m.target)?.name ?? null, external: !routineAt.has(m.target), tail: true });
          }
        }
      } else if (m.flow === 'jump') {
        if (m.target !== null && (m.target < r.addr || m.target >= r.limit)) {
          if (!seenCalls.has(m.target)) {
            seenCalls.add(m.target);
            r.calls.push({ addr: m.target, name: routineAt.get(m.target)?.name ?? null, external: !routineAt.has(m.target), tail: true });
          }
          a = next;
          break; // tail jump out — routine over
        }
        if (m.target !== null && m.target <= a) { r.tStates.loop = true; a = next; break; } // closed loop
        // forward jump inside the routine: keep walking linearly
      } else if (m.flow === 'jumpind') {
        r.unknown = true; // JP (HL) — the analyzer can't see where
        a = next;
        break;
      } else if (m.flow === 'ret') {
        if (depth !== 0 && lintOn)
          r.warnings.push({ type: 'stack', message: `RET with ${depth} item(s) still pushed` });
        a = next;
        break;
      } else if (m.flow === 'retcond') {
        if (depth !== 0 && lintOn) {
          r.warnings.push({ type: 'stack', message: `conditional RET with ${depth} item(s) still pushed` });
          lintOn = false;
        }
      } else if (m.flow === 'halt') {
        a = next;
        break;
      }
      a = next;
      if (m.len === 0) break; // safety — cannot happen, but never loop forever
    }
    r.end = a;
  }

  // transitive destroyed-register propagation over the call graph.
  // Sets only grow, so the fixed point exists; recursion just converges.
  const destroys = new Map(routines.map((r) => [r.addr, new Set(r.writes)]));
  let changed = true;
  let guard = routines.length * 16 + 16;
  while (changed && guard-- > 0) {
    changed = false;
    for (const r of routines) {
      const d = destroys.get(r.addr);
      for (const c of r.calls) {
        if (c.external) { if (!r.unknown) { r.unknown = true; changed = true; } continue; }
        const callee = routineAt.get(c.addr);
        const cd = destroys.get(callee.addr);
        for (const reg of cd) if (!d.has(reg)) { d.add(reg); changed = true; }
        if (callee.unknown && !r.unknown) { r.unknown = true; changed = true; }
      }
    }
  }

  // xref: who calls whom
  for (const r of routines) {
    for (const c of r.calls) {
      const callee = routineAt.get(c.addr);
      if (callee && !callee.callers.includes(r.name)) callee.callers.push(r.name);
    }
  }

  const xref = {};
  const result = routines.map((r) => {
    const destroyed = new Set(destroys.get(r.addr));
    for (const reg of r.saves) destroyed.delete(reg); // PROC-style wrap protects
    xref[r.name] = r.callers.slice();
    return {
      name: r.name,
      addr: r.addr,
      end: r.end,
      size: r.end - r.addr,
      inputs: sortRegs(r.inputs),
      destroys: sortRegs(destroyed),
      saves: sortRegs(r.saves),
      calls: r.calls,
      callers: r.callers,
      io: r.io,
      mem: r.mem,
      warnings: r.warnings,
      tStates: r.tStates,
      unknown: r.unknown,
      dynamicMem: !!r.dynamicMem,
    };
  });

  return { schemaVersion: SCHEMA_VERSION, routines: result, xref };
}

const hex4 = (v) => v.toString(16).toUpperCase().padStart(4, '0') + 'h';

// ---- source export (the mini-IDA move) ----------------------------------------
// Turn a memory range back into z80asm source: code where execution can
// reach (from the range start and any extra entry points), DB rows for the
// rest, labels both defined and substituted into operands. The contract is
// hard: reassembling the output at the same ORG reproduces the input bytes
// exactly. Reassembling at a different ORG relocates it — in-range
// references ride their labels, out-of-range absolutes stay put (they point
// at ROM/work areas that didn't move).
//
//   exportSource(read, start, end, { labels, org, entries })
//     labels:  Map(addr → name) — your labeling session
//     org:     ORG to emit (default start; set differently to relocate)
//     entries: extra code entry points for reachability (default: start)
export function exportSource(read, start, end, { labels = new Map(), org = start, entries = [] } = {}) {
  start &= 0xffff;
  end = Math.min(end, 0x10000);
  const inRange = (a) => a >= start && a < end;
  const kind = new Uint8Array(end - start); // 0 data, 1 code head, 2 code tail
  const K = (a) => kind[a - start];

  // reachability: follow flow from the entry points; a labeled data blob is
  // NOT an entry point, so strings stay DB instead of becoming nonsense code
  const queue = [start, ...entries].filter(inRange);
  while (queue.length) {
    let a = queue.pop();
    while (inRange(a) && K(a) === 0) {
      const m = metaOf(read, a);
      if (!inRange(a + m.len - 1)) break; // would spill past the range — leave as data
      kind[a - start] = 1;
      for (let i = 1; i < m.len; i++) kind[a - start + i] = 2;
      if (m.target !== null && inRange(m.target)) queue.push(m.target);
      if (m.flow === 'jump' || m.flow === 'ret' || m.flow === 'jumpind' || m.flow === 'halt') break;
      a += m.len;
    }
  }

  // collect every 16-bit operand in the decoded code (disasm text always
  // spells them as 4 hex digits) and decide how each one will be written
  const place = new Map(); // addr → label to define in the listing
  const subst = new Map(); // value → operand text
  const equs = [];
  for (const [a, n] of labels) if (inRange(a) && K(a) !== 2) place.set(a, n);
  const auto = (a) => {
    if (!place.has(a)) place.set(a, 'L_' + a.toString(16).toUpperCase().padStart(4, '0'));
    return place.get(a);
  };
  const headOf = (a) => { let h = a; while (h > start && K(h) === 2) h--; return h; };
  {
    let a = start;
    while (a < end) {
      if (K(a) !== 1) { a++; continue; }
      const d = disasm(read, a);
      for (const mm of d.text.matchAll(/\b0?([0-9A-F]{4})h\b/g)) {
        const v = parseInt(mm[1], 16);
        if (subst.has(v)) continue;
        if (inRange(v)) {
          if (K(v) === 2) { // mid-instruction (self-mod target, odd data ref)
            const h = headOf(v);
            const base = labels.get(h) ?? auto(h);
            if (labels.has(v)) { // user's name survives as a relative EQU
              equs.push(`${labels.get(v)} EQU ${base}+${v - h}`);
              subst.set(v, labels.get(v));
            } else subst.set(v, `${base}+${v - h}`);
          } else subst.set(v, labels.get(v) ?? auto(v));
        } else if (labels.has(v)) { // named external — absolute on purpose
          equs.push(`${labels.get(v)} EQU ${hexN(v, 4)}`);
          subst.set(v, labels.get(v));
        }
      }
      a += d.len;
    }
  }

  const fix = (text) => text.replace(/\b0?([0-9A-F]{4})h\b/g, (mm, hx) => subst.get(parseInt(hx, 16)) ?? mm);

  const out = [
    `; ICE export ${hexN(start, 4)}-${hexN(end - 1, 4)}` + (org !== start ? ` relocated to ${hexN(org, 4)}` : ''),
    ...[...new Set(equs)],
    `        ORG ${hexN(org, 4)}`,
  ];
  let a = start;
  while (a < end) {
    if (place.has(a)) out.push(place.get(a) + ':');
    if (K(a) === 1) {
      const d = disasm(read, a);
      out.push('        ' + fix(d.text));
      a += d.len;
    } else {
      const row = [];
      do {
        row.push(hexN(read(a) & 0xff, 2));
        a++;
      } while (a < end && K(a) !== 1 && !place.has(a) && row.length < 8);
      out.push('        DB ' + row.join(','));
    }
  }
  return out.join('\n') + '\n';
}
