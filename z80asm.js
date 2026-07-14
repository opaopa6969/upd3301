// z80asm — two-pass Z80 macro assembler. Pure JS, zero deps, deterministic.
//
// Everything z80.js can execute has a spelling here: the full documented set
// plus the useful undocumented corners (SLL, IXH/IXL, the DDCB/FDCB
// register-copy forms, IN (C) / OUT (C),0). Two passes so labels can be
// referenced before they are born; errors are collected with line numbers,
// never thrown at the caller.
//
//   assemble(source, { org }) →
//     { bytes, org, symbols, listing, errors, warnings, fixups }
//
// Syntax:
//   label:            colon labels (a colon is required except for the
//                     `name EQU/MACRO/PROC/STRUC` forms)
//   .local            local labels, scoped to the previous global label
//                     (and to each macro/REPT expansion — two calls of the
//                     same macro don't collide)
//   numbers           10, 0x1F, 1Fh / 0FFh, 1010b / 0b1010, 'A', $=here
//   operators         + - * / % & | ^ << >> ~ and parentheses
//   ORG a / name EQU v / DB,DEFB,DEFM (strings ok) / DW,DEFW / DS,DEFS n[,fill] / END
//   MACRO name p1,p2 … ENDM   (also `name MACRO p1,p2`) / REPT n … ENDM
//
// Extras (the 1985 bedroom-assembler features, reborn):
//   name PROC USES bc,de … RET … name ENDP
//       prologue PUSHes, every unconditional RET grows the matching POPs.
//       A conditional RET inside is an ERROR — rewriting it would change
//       the meaning, so you write that epilogue yourself.
//   name STRUC / fields DB|DW|DS n / name ENDS
//       defines name.field offsets and name = total size, for ld a,(ix+p.x).
//   RELOC … ENDRELOC + FIXUPTABLE
//       records every absolute 16-bit reference (JP/CALL/LD rr,nn/DW) to a
//       label born inside the region; offsets (relative to the region start)
//       come back in result.fixups and FIXUPTABLE emits them as DW count
//       then DW offsets — feed it to a self-relocating loader. JPs that
//       could be JRs get a warning (a JR is relocatable for free).

export const SCHEMA_VERSION = 1;

class AsmError extends Error {}
const p1err = (m) => Object.assign(new AsmError(m), { p1: true });

// ---- lexical helpers -------------------------------------------------------
// The one genuinely annoying token: ' is both a string quote ('A') and a
// prime (AF'). Rule: a quote right after an identifier character is a prime.
const primeAt = (s, i) => s[i] === "'" && i > 0 && /[A-Za-z0-9_')]/.test(s[i - 1]);

function scanString(s, i) { // index just past the closing quote
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === q) return j + 1;
    j++;
  }
  return j;
}

function stripComment(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ';') return line.slice(0, i);
    if ((c === '"' || c === "'") && !primeAt(line, i)) i = scanString(line, i) - 1;
  }
  return line;
}

function splitTop(s, keepEmpty = false) { // split on commas outside () and strings
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c === '"' || c === "'") && !primeAt(s, i)) { i = scanString(s, i) - 1; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth <= 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  const trimmed = out.map((x) => x.trim());
  return keepEmpty ? trimmed : trimmed.filter((x) => x !== '');
}

function matchParen(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if ((c === '"' || c === "'") && !primeAt(s, j)) { j = scanString(s, j) - 1; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

const IDENT_RE = /^[.A-Za-z_@?][A-Za-z0-9_~.?]*/;

// rewrite identifier tokens (macro params, local-label suffixing) without
// touching string literals
function transformTokens(line, fn) {
  let out = '', i = 0;
  while (i < line.length) {
    const c = line[i];
    if ((c === '"' || c === "'") && !primeAt(line, i)) {
      const e = scanString(line, i);
      out += line.slice(i, e);
      i = e;
      continue;
    }
    const m = IDENT_RE.exec(line.slice(i));
    if (m) { out += fn(m[0]); i += m[0].length; continue; }
    out += c;
    i++;
  }
  return out;
}

// ---- statement parse -------------------------------------------------------
const NO_COLON_KEYWORDS = /^(EQU|=|MACRO|PROC|STRUC|ENDS|ENDP)$/i;

function parseStmt(text) {
  let s = stripComment(text);
  let label = null;
  const lm = /^\s*([.A-Za-z_@?][A-Za-z0-9_~.?]*)\s*:/.exec(s);
  if (lm) { label = lm[1]; s = s.slice(lm[0].length); }
  s = s.trim();
  if (!s) return { label, mnemonic: null, args: '' };
  const mm = /^(\S+)(?:\s+([\s\S]*))?$/.exec(s);
  let mnemonic = mm[1], args = (mm[2] ?? '').trim();
  if (!label) { // `name EQU v` / `name MACRO …` / `name PROC …` etc
    const am = /^(\S+)\s*([\s\S]*)$/.exec(args);
    if (am && NO_COLON_KEYWORDS.test(am[1])) {
      label = mnemonic;
      mnemonic = am[1];
      args = am[2].trim();
    }
  }
  return { label, mnemonic, args };
}

const cachedParse = (s) => (s.parsed ??= parseStmt(s.text));

// ---- expressions -----------------------------------------------------------
function evalExpr(src, ctx) {
  if (typeof src !== 'string' || !src.trim()) throw new AsmError('empty expression');
  let i = 0;
  const err = (m) => { throw new AsmError(`${m} in '${src.trim()}'`); };
  const ws = () => { while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++; };

  function number(t) {
    let m;
    if ((m = /^0[xX]([0-9A-Fa-f]+)$/.exec(t))) return parseInt(m[1], 16);
    if ((m = /^0[bB]([01]+)$/.exec(t))) return parseInt(m[1], 2);
    if ((m = /^([0-9][0-9A-Fa-f]*)[hH]$/.exec(t))) return parseInt(m[1], 16);
    if ((m = /^([01]+)[bB]$/.exec(t))) return parseInt(m[1], 2);
    if ((m = /^([0-9]+)[dD]?$/.exec(t))) return parseInt(m[1], 10);
    err(`bad number '${t}'`);
  }

  function ident(name) {
    const key = (name[0] === '.' ? (ctx.scope ?? '') + name : name).toUpperCase();
    if (ctx.usedSyms) ctx.usedSyms.add(key);
    if (ctx.symbols.has(key)) return ctx.symbols.get(key);
    if (ctx.pass === 1) { ctx.undef = true; return 0; } // pass 1: forward refs read as 0
    err(`undefined symbol '${name}'`);
  }

  function primary() {
    ws();
    const c = src[i];
    if (c === undefined) err('unexpected end of expression');
    if (c === '(') {
      i++;
      const v = bitor();
      ws();
      if (src[i] !== ')') err('missing )');
      i++;
      return v;
    }
    if (c === '-') { i++; return (-primary()) | 0; }
    if (c === '+') { i++; return primary(); }
    if (c === '~') { i++; return ~primary(); }
    if (c === '$') { i++; return ctx.addr & 0xffff; }
    if (c === "'" || c === '"') { // char literal
      i++;
      let ch = src[i];
      if (ch === undefined) err('unterminated char literal');
      if (ch === '\\') {
        i++;
        ch = { n: '\n', r: '\r', t: '\t', 0: '\0' }[src[i]] ?? src[i];
      }
      i++;
      if (src[i] !== c) err('char literal must be a single character');
      i++;
      return ch.charCodeAt(0);
    }
    let m = /^[0-9][0-9A-Za-z_]*/.exec(src.slice(i));
    if (m) { i += m[0].length; return number(m[0]); }
    m = IDENT_RE.exec(src.slice(i));
    if (m) { i += m[0].length; return ident(m[0]); }
    err(`unexpected '${c}'`);
  }

  function muldiv() {
    let v = primary();
    for (;;) {
      ws();
      const c = src[i];
      if (c === '*') { i++; v = (v * primary()) | 0; }
      else if (c === '/') { i++; const d = primary(); if (!d) err('division by zero'); v = (v / d) | 0; }
      else if (c === '%') { i++; const d = primary(); if (!d) err('modulo by zero'); v = v % d; }
      else return v;
    }
  }
  function addsub() {
    let v = muldiv();
    for (;;) {
      ws();
      const c = src[i];
      if (c === '+') { i++; v = (v + muldiv()) | 0; }
      else if (c === '-') { i++; v = (v - muldiv()) | 0; }
      else return v;
    }
  }
  function shift() {
    let v = addsub();
    for (;;) {
      ws();
      if (src.startsWith('<<', i)) { i += 2; v = v << addsub(); }
      else if (src.startsWith('>>', i)) { i += 2; v = v >>> addsub(); }
      else return v;
    }
  }
  function bitand() {
    let v = shift();
    for (;;) { ws(); if (src[i] === '&') { i++; v &= shift(); } else return v; }
  }
  function bitxor() {
    let v = bitand();
    for (;;) { ws(); if (src[i] === '^') { i++; v ^= bitand(); } else return v; }
  }
  function bitor() {
    let v = bitxor();
    for (;;) { ws(); if (src[i] === '|') { i++; v |= bitxor(); } else return v; }
  }

  const v = bitor();
  ws();
  if (i < src.length) err(`trailing '${src.slice(i)}'`);
  return v;
}

// ---- operands --------------------------------------------------------------
const R8N = { B: 0, C: 1, D: 2, E: 3, H: 4, L: 5, A: 7 };
const CCN = { NZ: 0, Z: 1, NC: 2, C: 3, PO: 4, PE: 5, P: 6, M: 7 };

function parseOp(sRaw) {
  const raw = sRaw.trim();
  const u = raw.toUpperCase();
  if (R8N[u] !== undefined) return { k: 'r', v: R8N[u], name: u };
  if (u === 'I' || u === 'R') return { k: 'ir', name: u };
  if (u === 'IXH' || u === 'IXL' || u === 'IYH' || u === 'IYL')
    return { k: 'half', reg: u.slice(0, 2), v: u[2] === 'H' ? 4 : 5, name: u };
  if (['BC', 'DE', 'HL', 'SP', 'AF', 'IX', 'IY'].includes(u)) return { k: 'rp', name: u };
  if (u === "AF'") return { k: 'af2', name: u };
  if (raw[0] === '(' && matchParen(raw, 0) === raw.length - 1) {
    const inner = raw.slice(1, -1).trim();
    const iu = inner.toUpperCase();
    if (['HL', 'BC', 'DE', 'SP', 'C', 'IX', 'IY'].includes(iu)) return { k: 'm', name: iu };
    const im = /^(IX|IY)\s*([+-][\s\S]+)$/i.exec(inner);
    if (im) return { k: 'idx', reg: im[1].toUpperCase(), expr: im[2] };
    return { k: 'mn', expr: inner };
  }
  return { k: 'imm', expr: raw, name: u };
}

// 8-bit-operand view: plain register, IXH/IXL half, (HL), or (IX/IY+d)
function r8info(o) {
  if (!o) return null;
  if (o.k === 'r') return { z: o.v, pfx: 0, half: false, mem: false, d: null };
  if (o.k === 'half') return { z: o.v, pfx: o.reg === 'IX' ? 0xdd : 0xfd, half: true, mem: false, d: null };
  if (o.k === 'm' && o.name === 'HL') return { z: 6, pfx: 0, half: false, mem: true, d: null };
  if (o.k === 'm' && (o.name === 'IX' || o.name === 'IY'))
    return { z: 6, pfx: o.name === 'IX' ? 0xdd : 0xfd, half: false, mem: true, d: '0' };
  if (o.k === 'idx') return { z: 6, pfx: o.reg === 'IX' ? 0xdd : 0xfd, half: false, mem: true, d: o.expr };
  return null;
}

const condOf = (o) => (o && (o.k === 'imm' || o.k === 'r') ? CCN[o.name] : undefined);

// branch targets live in label space: `JP b` means the label b, not the
// register — reinterpret register-shaped operands as symbols there
const asTarget = (o) =>
  (o && (o.k === 'r' || o.k === 'ir' || o.k === 'rp' || o.k === 'half')
    ? { k: 'imm', expr: o.name, name: o.name }
    : o);

const SIMPLE = {
  NOP: [0x00], HALT: [0x76], DI: [0xf3], EI: [0xfb], EXX: [0xd9],
  DAA: [0x27], CPL: [0x2f], CCF: [0x3f], SCF: [0x37], NEG: [0xed, 0x44],
  RLCA: [0x07], RLA: [0x17], RRCA: [0x0f], RRA: [0x1f],
  RLD: [0xed, 0x6f], RRD: [0xed, 0x67],
  RETI: [0xed, 0x4d], RETN: [0xed, 0x45],
  LDI: [0xed, 0xa0], LDIR: [0xed, 0xb0], LDD: [0xed, 0xa8], LDDR: [0xed, 0xb8],
  CPI: [0xed, 0xa1], CPIR: [0xed, 0xb1], CPD: [0xed, 0xa9], CPDR: [0xed, 0xb9],
  INI: [0xed, 0xa2], INIR: [0xed, 0xb2], IND: [0xed, 0xaa], INDR: [0xed, 0xba],
  OUTI: [0xed, 0xa3], OTIR: [0xed, 0xb3], OUTD: [0xed, 0xab], OTDR: [0xed, 0xbb],
};

const ROTC = { RLC: 0, RRC: 1, RL: 2, RR: 3, SLA: 4, SRA: 5, SLL: 6, SLI: 6, SRL: 7 };

function encodeInstr(mn, argstr, X) {
  const E = X.err;
  const ops = splitTop(argstr).map(parseOp);
  const one = () => { if (ops.length !== 1) E(`${mn} needs exactly one operand`); return ops[0]; };
  const pfxOf = (name) => (name === 'IX' ? 0xdd : name === 'IY' ? 0xfd : 0);
  const rpIdx = { BC: 0, DE: 1, HL: 2, IX: 2, IY: 2, SP: 3 };

  function alu(y) {
    let o;
    if (ops.length === 2) {
      if (!(ops[0].k === 'r' && ops[0].v === 7)) E(`${mn}: first operand must be A`);
      o = ops[1];
    } else o = one();
    const i = r8info(o);
    if (i) {
      const opb = 0x80 | (y << 3) | i.z;
      const out = i.pfx ? [i.pfx, opb] : [opb];
      if (i.mem && i.d !== null) out.push(X.disp(i.d));
      return out;
    }
    if (o.k === 'imm') return [0xc6 | (y << 3), X.imm8(o.expr)];
    E(`${mn}: bad operand`);
  }

  function cbRot(y, x, rest, noCopy) {
    if (!rest.length) E(`${mn}: missing operand`);
    const i = r8info(rest[0]);
    if (!i || i.half) E(`${mn}: bad operand`);
    const opb = (x << 6) | (y << 3);
    if (i.mem && i.pfx) { // (IX+d) [, r] — the copy form is the undocumented one
      let z = 6;
      if (rest.length === 2) {
        if (noCopy) E('BIT has no register-copy form');
        if (rest[1].k !== 'r') E('copy target must be B/C/D/E/H/L/A');
        z = rest[1].v;
      } else if (rest.length > 2) E(`${mn}: too many operands`);
      return [i.pfx, 0xcb, X.disp(i.d), opb | z];
    }
    if (rest.length !== 1) E(`${mn}: too many operands`);
    return [0xcb, opb | i.z];
  }

  function encLD() {
    if (ops.length !== 2) E('LD needs two operands');
    const [d, s] = ops;
    const di = r8info(d), si = r8info(s);
    if (di && si) { // LD r,r' / (HL)/(IX+d) either side
      if (di.mem && si.mem) E('LD (mem),(mem) does not exist');
      if ((di.half || si.half) && (di.mem || si.mem)) E('IXH/IXL cannot meet (HL)/(IX+d)');
      if (di.half && si.half && di.pfx !== si.pfx) E('cannot mix IX and IY halves');
      if ((di.half && !si.half && (si.z === 4 || si.z === 5)) ||
          (si.half && !di.half && (di.z === 4 || di.z === 5))) E('cannot mix H/L with IX/IY halves');
      const pfx = di.pfx || si.pfx;
      const out = pfx ? [pfx, 0x40 | (di.z << 3) | si.z] : [0x40 | (di.z << 3) | si.z];
      if (di.mem && di.d !== null) out.push(X.disp(di.d));
      else if (si.mem && si.d !== null) out.push(X.disp(si.d));
      return out;
    }
    if (di && s.k === 'imm') { // LD r,n (covers LD (IX+d),n — d before n)
      const out = di.pfx ? [di.pfx, 0x06 | (di.z << 3)] : [0x06 | (di.z << 3)];
      if (di.mem && di.d !== null) out.push(X.disp(di.d));
      out.push(X.imm8(s.expr));
      return out;
    }
    if (d.k === 'r' && d.v === 7) { // A ← special sources
      if (s.k === 'm' && s.name === 'BC') return [0x0a];
      if (s.k === 'm' && s.name === 'DE') return [0x1a];
      if (s.k === 'mn') return [0x3a, ...X.imm16(s.expr)];
      if (s.k === 'ir') return s.name === 'I' ? [0xed, 0x57] : [0xed, 0x5f];
    }
    if (s.k === 'r' && s.v === 7) { // special destinations ← A
      if (d.k === 'm' && d.name === 'BC') return [0x02];
      if (d.k === 'm' && d.name === 'DE') return [0x12];
      if (d.k === 'mn') return [0x32, ...X.imm16(d.expr)];
      if (d.k === 'ir') return d.name === 'I' ? [0xed, 0x47] : [0xed, 0x4f];
    }
    if (d.k === 'rp' && d.name !== 'AF') { // 16-bit loads
      const pfx = pfxOf(d.name), rp = rpIdx[d.name];
      if (s.k === 'imm') { // LD rr,nn — relocatable field
        const nn = X.imm16r(s.expr, pfx ? 2 : 1);
        return pfx ? [pfx, 0x01 | (rp << 4), ...nn] : [0x01 | (rp << 4), ...nn];
      }
      if (s.k === 'mn') {
        if (rp === 2) return pfx ? [pfx, 0x2a, ...X.imm16(s.expr)] : [0x2a, ...X.imm16(s.expr)];
        return [0xed, 0x4b | (rp << 4), ...X.imm16(s.expr)];
      }
      if (d.name === 'SP' && s.k === 'rp' && ['HL', 'IX', 'IY'].includes(s.name)) {
        const p2 = pfxOf(s.name);
        return p2 ? [p2, 0xf9] : [0xf9];
      }
    }
    if (d.k === 'mn' && s.k === 'rp' && s.name !== 'AF') {
      const pfx = pfxOf(s.name), rp = rpIdx[s.name];
      if (rp === 2) return pfx ? [pfx, 0x22, ...X.imm16(d.expr)] : [0x22, ...X.imm16(d.expr)];
      return [0xed, 0x43 | (rp << 4), ...X.imm16(d.expr)];
    }
    E('bad LD operands');
  }

  switch (mn) {
    case 'LD': return encLD();
    case 'PUSH': case 'POP': {
      const o = one();
      if (o.k !== 'rp' || o.name === 'SP') E(`${mn} takes BC/DE/HL/AF/IX/IY`);
      const base = mn === 'PUSH' ? 0xc5 : 0xc1;
      const idx = o.name === 'AF' ? 3 : rpIdx[o.name];
      const pfx = pfxOf(o.name);
      return pfx ? [pfx, base | (idx << 4)] : [base | (idx << 4)];
    }
    case 'EX': {
      if (ops.length !== 2) E('EX needs two operands');
      const [a, b] = ops;
      if (a.k === 'rp' && a.name === 'AF' && b.k === 'af2') return [0x08];
      if (a.k === 'rp' && a.name === 'DE' && b.k === 'rp' && b.name === 'HL') return [0xeb];
      if (a.k === 'm' && a.name === 'SP' && b.k === 'rp') {
        if (b.name === 'HL') return [0xe3];
        if (b.name === 'IX' || b.name === 'IY') return [pfxOf(b.name), 0xe3];
      }
      E('bad EX operands');
      break;
    }
    case 'ADD': {
      if (ops.length === 2 && ops[0].k === 'rp' && ['HL', 'IX', 'IY'].includes(ops[0].name)) {
        const dst = ops[0].name, src = ops[1];
        if (src.k !== 'rp') E('bad ADD source');
        const rp = src.name === dst ? 2 : { BC: 0, DE: 1, SP: 3 }[src.name];
        if (rp === undefined) E(`ADD ${dst},${src.name} does not exist`);
        const pfx = pfxOf(dst);
        return pfx ? [pfx, 0x09 | (rp << 4)] : [0x09 | (rp << 4)];
      }
      return alu(0);
    }
    case 'ADC': case 'SBC': {
      if (ops.length === 2 && ops[0].k === 'rp' && ops[0].name === 'HL') {
        if (ops[1].k !== 'rp' || ops[1].name === 'IX' || ops[1].name === 'IY' || ops[1].name === 'AF')
          E(`bad ${mn} HL,rr source`);
        return [0xed, (mn === 'ADC' ? 0x4a : 0x42) | (rpIdx[ops[1].name] << 4)];
      }
      return alu(mn === 'ADC' ? 1 : 3);
    }
    case 'SUB': return alu(2);
    case 'AND': return alu(4);
    case 'XOR': return alu(5);
    case 'OR': return alu(6);
    case 'CP': return alu(7);
    case 'INC': case 'DEC': {
      const o = one();
      const i = r8info(o);
      if (i) {
        const opb = (mn === 'INC' ? 0x04 : 0x05) | (i.z << 3);
        const out = i.pfx ? [i.pfx, opb] : [opb];
        if (i.mem && i.d !== null) out.push(X.disp(i.d));
        return out;
      }
      if (o.k === 'rp' && o.name !== 'AF') {
        const opb = (mn === 'INC' ? 0x03 : 0x0b) | (rpIdx[o.name] << 4);
        const pfx = pfxOf(o.name);
        return pfx ? [pfx, opb] : [opb];
      }
      E(`bad ${mn} operand`);
      break;
    }
    case 'RLC': case 'RRC': case 'RL': case 'RR':
    case 'SLA': case 'SRA': case 'SLL': case 'SLI': case 'SRL':
      return cbRot(ROTC[mn], 0, ops, false);
    case 'BIT': case 'RES': case 'SET': {
      if (ops.length < 2 || ops[0].k !== 'imm') E(`${mn} needs a bit number and an operand`);
      const b = X.bit(ops[0].expr);
      return cbRot(b, mn === 'BIT' ? 1 : mn === 'RES' ? 2 : 3, ops.slice(1), mn === 'BIT');
    }
    case 'JP': {
      if (ops.length === 1 && ops[0].k === 'm' && ['HL', 'IX', 'IY'].includes(ops[0].name)) {
        const pfx = pfxOf(ops[0].name);
        return pfx ? [pfx, 0xe9] : [0xe9];
      }
      let cc = null, tgt;
      if (ops.length === 2) { cc = condOf(ops[0]); if (cc === undefined) E('bad JP condition'); tgt = ops[1]; }
      else tgt = one();
      tgt = asTarget(tgt);
      if (tgt.k !== 'imm') E('bad JP target');
      const nn = X.imm16r(tgt.expr, 1, { jp: true, cond: cc });
      return [cc === null ? 0xc3 : 0xc2 | (cc << 3), ...nn];
    }
    case 'JR': {
      let cc = null, tgt;
      if (ops.length === 2) {
        cc = condOf(ops[0]);
        if (cc === undefined || cc > 3) E('JR only takes NZ/Z/NC/C');
        tgt = ops[1];
      } else tgt = one();
      tgt = asTarget(tgt);
      if (tgt.k !== 'imm') E('bad JR target');
      return [cc === null ? 0x18 : 0x20 | (cc << 3), X.rel(tgt.expr)];
    }
    case 'DJNZ': {
      const o = asTarget(one());
      if (o.k !== 'imm') E('bad DJNZ target');
      return [0x10, X.rel(o.expr)];
    }
    case 'CALL': {
      let cc = null, tgt;
      if (ops.length === 2) { cc = condOf(ops[0]); if (cc === undefined) E('bad CALL condition'); tgt = ops[1]; }
      else tgt = one();
      tgt = asTarget(tgt);
      if (tgt.k !== 'imm') E('bad CALL target');
      const nn = X.imm16r(tgt.expr, 1);
      return [cc === null ? 0xcd : 0xc4 | (cc << 3), ...nn];
    }
    case 'RET': {
      if (!ops.length) return [0xc9];
      const cc = condOf(ops[0]);
      if (cc === undefined || ops.length > 1) E('bad RET condition');
      return [0xc0 | (cc << 3)];
    }
    case 'RST': {
      const o = one();
      if (o.k !== 'imm') E('bad RST target');
      const v = X.ev(o.expr);
      if (X.pass === 2 && (v & ~0x38)) E('RST target must be one of 00h,08h,…,38h');
      return [0xc7 | (v & 0x38)];
    }
    case 'IN': {
      if (ops.length === 1 && ops[0].k === 'm' && ops[0].name === 'C') return [0xed, 0x70];
      if (ops.length !== 2) E('bad IN operands');
      const [d, s] = ops;
      if (s.k === 'mn') {
        if (!(d.k === 'r' && d.v === 7)) E('IN r,(n) only exists for A');
        return [0xdb, X.imm8(s.expr)];
      }
      if (s.k === 'm' && s.name === 'C') {
        if (d.k === 'r') return [0xed, 0x40 | (d.v << 3)];
        if (d.name === 'F') return [0xed, 0x70]; // IN F,(C) alias of IN (C)
      }
      E('bad IN operands');
      break;
    }
    case 'OUT': {
      if (ops.length !== 2) E('bad OUT operands');
      const [d, s] = ops;
      if (d.k === 'mn') {
        if (!(s.k === 'r' && s.v === 7)) E('OUT (n),r only exists for A');
        return [0xd3, X.imm8(d.expr)];
      }
      if (d.k === 'm' && d.name === 'C') {
        if (s.k === 'r') return [0xed, 0x41 | (s.v << 3)];
        if (s.k === 'imm' && (X.pass === 1 || X.ev(s.expr) === 0)) return [0xed, 0x71]; // OUT (C),0
      }
      E('bad OUT operands');
      break;
    }
    case 'IM': {
      const o = one();
      if (o.k !== 'imm') E('IM takes 0/1/2');
      const v = X.ev(o.expr);
      if (X.pass === 2 && (v < 0 || v > 2)) E('IM takes 0/1/2');
      return [0xed, [0x46, 0x56, 0x5e][v] ?? 0x46];
    }
    default: {
      const simple = SIMPLE[mn];
      if (simple) {
        if (ops.length) E(`${mn} takes no operands`);
        return simple.slice();
      }
      E(`unknown mnemonic '${mn}'`);
    }
  }
  return []; // unreachable — every branch returns or throws
}

// ---- macro / REPT / IRP / conditional expansion (the MACRO-80 layer) --------
// Everything here happens ONCE, before the two assembly passes — so IF and
// friends are automatically pass-consistent, and a forward-referenced label
// inside an IF is an honest error instead of a phase bug.

const BLOCK_OPENERS = new Set(['REPT', 'MACRO', 'IRP', 'IRPC']);
const COND_OPENERS = new Set(['IF', 'IFE', 'IF1', 'IF2', 'IFDEF', 'IFNDEF', 'IFB', 'IFNB', 'IFIDN', 'IFDIF']);

// every name the assembler itself understands — used for the M80 shadowing
// rule: a macro may shadow a builtin, and INSIDE that macro the name resolves
// back to the builtin (that's what makes a RET-shadow epilogue terminate)
const BUILTIN_MNEMONICS = new Set([
  'LD', 'PUSH', 'POP', 'EX', 'EXX', 'ADD', 'ADC', 'SUB', 'SBC', 'AND', 'XOR', 'OR', 'CP',
  'INC', 'DEC', 'RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SLL', 'SLI', 'SRL',
  'BIT', 'RES', 'SET', 'JP', 'JR', 'DJNZ', 'CALL', 'RET', 'RST', 'IN', 'OUT', 'IM',
  ...Object.keys(SIMPLE),
  'ORG', 'EQU', 'DB', 'DEFB', 'DEFM', 'DW', 'DEFW', 'DS', 'DEFS', 'END',
  'RELOC', 'ENDRELOC', 'FIXUPTABLE', 'PROC', 'ENDP', 'STRUC', 'ENDS',
]);

// split a macro-argument list: <…> guards a whole argument (commas inside
// stay put — that's how a list travels into IRP), () nests, strings skip.
// A '<' only opens a guard at the START of an argument, so `m 1<<2,x`
// still reads as a shift expression.
function splitArgs(s) {
  const out = [];
  let depth = 0, angle = 0, start = 0, atStart = true;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c === '"' || c === "'") && !primeAt(s, i)) { i = scanString(s, i) - 1; atStart = false; continue; }
    if (angle > 0) {
      if (c === '<') angle++;
      else if (c === '>') angle--;
      continue;
    }
    if (c === '<' && atStart) { angle = 1; atStart = false; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth <= 0) { out.push(s.slice(start, i)); start = i + 1; atStart = true; continue; }
    if (!/\s/.test(c)) atStart = false;
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim());
}

// peel ONE layer of <> when it wraps the whole argument
function stripAngle(s) {
  const x = String(s).trim();
  if (x[0] !== '<') return x;
  let a = 0;
  for (let i = 0; i < x.length; i++) {
    const c = x[i];
    if ((c === '"' || c === "'") && !primeAt(x, i)) { i = scanString(x, i) - 1; continue; }
    if (c === '<') a++;
    else if (c === '>') { a--; if (a === 0) return i === x.length - 1 ? x.slice(1, -1) : x; }
  }
  return x;
}

// substitute macro parameters / LOCAL names / IRP variables into a body line,
// with M80 &-pasting: an '&' DIRECTLY adjacent to a substituted token is
// consumed (label&n → label1). An '&' with whitespace around it stays a
// bitwise AND — the pasting rule never reaches into expressions.
function substBody(line, map, suffix) {
  let out = '', i = 0;
  while (i < line.length) {
    const c = line[i];
    if ((c === '"' || c === "'") && !primeAt(line, i)) {
      // strings are opaque EXCEPT for the M80 idiom '&param' — the only way
      // a parameter reaches inside quotes
      const e = scanString(line, i);
      let str = line.slice(i, e);
      if (str.includes('&')) {
        str = str.replace(/&([.A-Za-z_@?][A-Za-z0-9_~.?]*)/g, (whole, name) =>
          map.get(name.toUpperCase()) ?? whole);
      }
      out += str;
      i = e;
      continue;
    }
    const m = IDENT_RE.exec(line.slice(i));
    if (m) {
      const tok = m[0];
      const rep = map.get(tok.toUpperCase());
      if (rep !== undefined) {
        if (out.endsWith('&')) out = out.slice(0, -1); // paste on the left
        out += rep;
        i += tok.length;
        if (line[i] === '&') i++; // paste on the right
        continue;
      }
      out += tok[0] === '.' ? tok + suffix : tok; // auto-scoped locals (our +α)
      i += tok.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function captureBlock(items, i, errors, what = 'REPT') {
  let depth = 1;
  const body = [];
  for (let j = i + 1; j < items.length; j++) {
    const q = cachedParse(items[j]);
    const qm = q.mnemonic ? q.mnemonic.toUpperCase() : null;
    if (qm && BLOCK_OPENERS.has(qm)) depth++;
    else if (qm === 'ENDM') { depth--; if (depth === 0) return [body, j + 1]; }
    body.push(items[j]);
  }
  errors.push({ line: items[i].line, message: `${what} without ENDM` });
  return [body, items.length];
}

// IF … [ELSE …] ENDIF, nesting-aware; returns both branches
function captureIf(items, i, errors) {
  let depth = 1;
  const thenB = [], elseB = [];
  let target = thenB;
  for (let j = i + 1; j < items.length; j++) {
    const q = cachedParse(items[j]);
    const qm = q.mnemonic ? q.mnemonic.toUpperCase() : null;
    if (qm && COND_OPENERS.has(qm)) depth++;
    else if (qm === 'ENDIF') { depth--; if (depth === 0) return [thenB, elseB, j + 1]; }
    else if (qm === 'ELSE' && depth === 1 && !q.args.trim()) { target = elseB; continue; }
    target.push(items[j]);
  }
  errors.push({ line: items[i].line, message: 'IF without ENDIF' });
  return [thenB, elseB, items.length];
}

function evalCond(mn, argstr, st) {
  const ev = (e) => evalExpr(e, { addr: 0, scope: '', pass: 2, symbols: st.equs });
  switch (mn) {
    case 'IF': return ev(argstr) !== 0;
    case 'IFE': return ev(argstr) === 0;
    case 'IF1': case 'IF2':
      // M80 ran the SOURCE twice; we expand once and assemble the result
      // twice, so pass-specific source is structurally impossible. Honesty
      // beats a silent half-truth.
      throw new AsmError(`${mn} cannot exist here: this assembler expands once, then assembles twice`);
    case 'IFDEF': case 'IFNDEF': {
      const name = argstr.trim().toUpperCase();
      if (!IDENT_RE.test(name) || IDENT_RE.exec(name)[0] !== name) {
        throw new AsmError(`${mn} needs a symbol name`);
      }
      const def = st.equs.has(name) || st.macros.has(name);
      return mn === 'IFDEF' ? def : !def;
    }
    case 'IFB': case 'IFNB': {
      const blank = stripAngle(argstr).trim() === '';
      return mn === 'IFB' ? blank : !blank;
    }
    case 'IFIDN': case 'IFDIF': {
      const parts = splitArgs(argstr);
      if (parts.length !== 2) throw new AsmError(`${mn} needs two <>-guarded arguments`);
      const same = stripAngle(parts[0]).toUpperCase() === stripAngle(parts[1]).toUpperCase();
      return mn === 'IFIDN' ? same : !same;
    }
    default: return false;
  }
}

// returns 'exitm' when an EXITM wants to unwind the innermost macro/REPT/IRP
function expandStream(items, st, out, depth, errors) {
  if (depth > 64) {
    errors.push({ line: items[0]?.line ?? 0, message: 'macro recursion too deep' });
    return undefined;
  }
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    const p = cachedParse(it);
    const mn = p.mnemonic ? p.mnemonic.toUpperCase() : null;

    if (mn && COND_OPENERS.has(mn)) {
      const [thenB, elseB, next] = captureIf(items, i, errors);
      let cond = false;
      try { cond = evalCond(mn, p.args, st); }
      catch (e) { errors.push({ line: it.line, message: `${mn}: ${e.message}` }); }
      if (p.label) out.push({ text: p.label + ':', line: it.line, file: it.file, from: it.from });
      const r = expandStream(cond ? thenB : elseB, st, out, depth + 1, errors);
      if (r === 'exitm') return 'exitm'; // EXITM inside IF unwinds the macro
      i = next;
      continue;
    }
    if (mn === 'ELSE' || mn === 'ENDIF') {
      errors.push({ line: it.line, message: `${mn} without IF` });
      i++;
      continue;
    }
    if (mn === 'EXITM') {
      if (st.inMacro > 0) return 'exitm';
      errors.push({ line: it.line, message: 'EXITM outside a macro/REPT/IRP' });
      i++;
      continue;
    }
    if (mn === 'PURGE') { // un-shadow: the builtin mnemonic comes back
      for (const nm of splitArgs(p.args)) if (nm) st.macros.delete(nm.toUpperCase());
      i++;
      continue;
    }
    if (mn === 'REPT') {
      const [body, next] = captureBlock(items, i, errors, 'REPT');
      let count = 0;
      try {
        count = evalExpr(p.args, { addr: 0, scope: '', pass: 2, symbols: st.equs });
        if (count < 0 || count > 65536) throw new AsmError('REPT count out of range');
      } catch (e) {
        errors.push({ line: it.line, message: 'REPT: ' + e.message });
        count = 0;
      }
      if (p.label) out.push({ text: p.label + ':', line: it.line, file: it.file, from: it.from });
      st.unique++;
      const id = st.unique;
      st.inMacro++;
      for (let k = 0; k < count; k++) {
        const suffixed = body.map((b) => ({
          text: substBody(b.text, EMPTY_MAP, `~r${id}_${k}`),
          line: b.line, file: b.file, from: it.line,
        }));
        if (expandStream(suffixed, st, out, depth + 1, errors) === 'exitm') break;
      }
      st.inMacro--;
      i = next;
      continue;
    }
    if (mn === 'IRP' || mn === 'IRPC') {
      const [body, next] = captureBlock(items, i, errors, mn);
      const parts = splitArgs(p.args);
      const varName = (parts[0] ?? '').trim();
      if (!varName) {
        errors.push({ line: it.line, message: `${mn} needs a variable name` });
        i = next;
        continue;
      }
      const listArg = parts.slice(1).join(',');
      const values = mn === 'IRP'
        ? splitArgs(stripAngle(listArg)) // <a,b,c> → one binding per element
        : [...stripAngle(listArg)]; // IRPC: one binding per character
      if (p.label) out.push({ text: p.label + ':', line: it.line, file: it.file, from: it.from });
      st.unique++;
      const id = st.unique;
      st.inMacro++;
      for (let k = 0; k < values.length; k++) {
        const map = new Map([[varName.toUpperCase(), values[k]]]);
        const bodyItems = body.map((b) => ({
          text: substBody(b.text, map, `~i${id}_${k}`),
          line: b.line, file: b.file, from: it.line,
        }));
        if (expandStream(bodyItems, st, out, depth + 1, errors) === 'exitm') break;
      }
      st.inMacro--;
      i = next;
      continue;
    }
    // macro call — with the M80 shadowing rule: while a builtin-shadowing
    // macro is expanding, its own name resolves back to the builtin
    if (mn && st.macros.has(mn) && !(st.active.has(mn) && BUILTIN_MNEMONICS.has(mn))) {
      const mac = st.macros.get(mn);
      if (p.label) out.push({ text: p.label + ':', line: it.line, file: it.file, from: it.from });
      const args = splitArgs(p.args).map((a) => {
        if (a[0] === '%') { // %expr: pass the VALUE, not the text (M80)
          try {
            return String(evalExpr(a.slice(1), { addr: 0, scope: '', pass: 2, symbols: st.equs }));
          } catch (e) {
            errors.push({ line: it.line, message: `%: ${e.message}` });
            return '0';
          }
        }
        return stripAngle(a); // <a,b> travels as one argument, unwrapped once
      });
      st.unique++;
      const id = st.unique;
      const map = new Map();
      mac.params.forEach((prm, k) => map.set(prm.toUpperCase(), args[k] ?? ''));
      // LOCAL declarations mint a fresh ??n name per expansion (M80), on top
      // of our automatic .label scoping
      const bodySrc = [];
      for (const b of mac.body) {
        const bp = cachedParse(b);
        if (!bp.label && bp.mnemonic && bp.mnemonic.toUpperCase() === 'LOCAL') {
          for (const nm of splitArgs(bp.args)) {
            if (nm) map.set(nm.toUpperCase(), `??${id}_${map.size}`);
          }
          continue;
        }
        bodySrc.push(b);
      }
      const bodyItems = bodySrc.map((b) => ({
        text: substBody(b.text, map, `~m${id}`),
        line: b.line, file: b.file, from: it.line,
      }));
      st.active.add(mn);
      st.inMacro++;
      expandStream(bodyItems, st, out, depth + 1, errors); // EXITM lands here
      st.inMacro--;
      st.active.delete(mn);
      i++;
      continue;
    }
    if (mn === 'ENDM') {
      errors.push({ line: it.line, message: 'ENDM without MACRO/REPT/IRP' });
      i++;
      continue;
    }
    if ((mn === 'EQU' || mn === '=') && p.label) {
      // best-effort record so IF / REPT counts can use it
      try {
        st.equs.set(p.label.toUpperCase(), evalExpr(p.args, { addr: 0, scope: '', pass: 2, symbols: st.equs }));
      } catch { /* real EQU handling happens in the passes */ }
    }
    out.push(it);
    i++;
  }
  return undefined;
}

const EMPTY_MAP = new Map();

// ---- PROC/USES: auto push/pop symmetry (the feature everyone reimplemented
// in their bedroom in 1985 — prologue PUSHes, every plain RET grows POPs) ---
const USES_OK = ['AF', 'BC', 'DE', 'HL', 'IX', 'IY'];

function procTransform(stmts, errors) {
  const out = [];
  let cur = null;
  for (const s of stmts) {
    const p = cachedParse(s);
    const mn = p.mnemonic ? p.mnemonic.toUpperCase() : null;
    if (mn === 'PROC') {
      if (cur) { errors.push({ line: s.line, message: 'nested PROC is not supported' }); continue; }
      if (!p.label) { errors.push({ line: s.line, message: 'PROC needs a name (name PROC …)' }); continue; }
      let uses = [];
      const args = p.args.trim();
      const um = /^USES\s+([\s\S]+)$/i.exec(args);
      if (um) uses = splitTop(um[1]).map((r) => r.toUpperCase());
      else if (args) errors.push({ line: s.line, message: "PROC only understands 'USES rr,…'" });
      const bad = uses.filter((r) => !USES_OK.includes(r));
      for (const r of bad) errors.push({ line: s.line, message: `USES: cannot push '${r}'` });
      uses = uses.filter((r) => USES_OK.includes(r));
      out.push({ text: p.label + ':', line: s.line, file: s.file, from: s.from });
      for (const r of uses) out.push({ text: 'PUSH ' + r, line: s.line, file: s.file, from: s.from });
      cur = { uses, line: s.line };
      continue;
    }
    if (mn === 'ENDP') {
      if (!cur) errors.push({ line: s.line, message: 'ENDP without PROC' });
      cur = null;
      continue;
    }
    if (cur && mn === 'RET') {
      if (p.args.trim()) {
        // rewriting RET cc would silently change meaning — refuse loudly
        errors.push({ line: s.line, message: 'conditional RET inside PROC USES — write that epilogue by hand' });
        out.push(s);
        continue;
      }
      if (p.label) out.push({ text: p.label + ':', line: s.line, file: s.file, from: s.from });
      for (const r of [...cur.uses].reverse()) out.push({ text: 'POP ' + r, line: s.line, file: s.file, from: s.from });
      out.push({ text: 'RET', line: s.line, file: s.file, from: s.from });
      continue;
    }
    out.push(s);
  }
  if (cur) errors.push({ line: cur.line, message: 'PROC without ENDP' });
  return out;
}

// ---- the assembler ----------------------------------------------------------
const fullName = (label, scope) => (label[0] === '.' ? scope + label : label).toUpperCase();

// INCLUDE resolution — textual splice with provenance. Every produced line
// remembers its {file, line}, so errors and the listing can say where a
// statement REALLY lives. The stack argument catches circular includes.
function loadLines(source, file, include, stack, errors) {
  const out = [];
  const lines = String(source).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const p = parseStmt(lines[i]);
    if (p.mnemonic && p.mnemonic.toUpperCase() === 'INCLUDE') {
      const m = /^["']([\s\S]*)["']$/.exec(p.args.trim());
      const path = m ? m[1] : p.args.trim();
      if (!include) {
        errors.push({ line: i + 1, file, message: 'INCLUDE needs a resolver: assemble(src, { include: (path) => source })' });
        continue;
      }
      if (stack.includes(path)) {
        errors.push({ line: i + 1, file, message: `circular INCLUDE: ${[...stack, path].join(' → ')}` });
        continue;
      }
      let sub = null;
      try { sub = include(path); } catch { sub = null; }
      if (sub == null) {
        errors.push({ line: i + 1, file, message: `INCLUDE not found: "${path}"` });
        continue;
      }
      if (p.label) out.push({ text: p.label + ':', line: i + 1, file });
      out.push(...loadLines(sub, path, include, [...stack, path], errors));
      continue;
    }
    out.push({ text: lines[i], line: i + 1, file });
  }
  return out;
}

export function assemble(source, { org = 0, include = null } = {}) {
  const errors = [];
  const warnings = [];

  // phase 0: INCLUDE splice (with file:line provenance), then pull MACRO
  // definitions out of the line stream
  const lineItems = loadLines(source, null, include, [], errors);
  const macros = new Map();
  const items = [];
  for (let i = 0; i < lineItems.length; i++) {
    const li = lineItems[i];
    const p = parseStmt(li.text);
    if (p.mnemonic && p.mnemonic.toUpperCase() === 'MACRO') {
      let name = p.label, paramStr = p.args;
      if (!name) { // `MACRO name p1,p2` form
        const m = /^([.A-Za-z_@?][A-Za-z0-9_~.?]*)\s*([\s\S]*)$/.exec(p.args);
        if (!m) { errors.push({ line: li.line, file: li.file, message: 'MACRO needs a name' }); continue; }
        name = m[1];
        paramStr = m[2];
      }
      const params = splitTop(paramStr);
      let depth = 1;
      const body = [];
      let j = i + 1;
      for (; j < lineItems.length; j++) {
        const q = parseStmt(lineItems[j].text);
        const qm = q.mnemonic ? q.mnemonic.toUpperCase() : null;
        if (qm && BLOCK_OPENERS.has(qm)) depth++;
        else if (qm === 'ENDM') { depth--; if (depth === 0) break; }
        body.push({ text: lineItems[j].text, line: lineItems[j].line, file: lineItems[j].file });
      }
      if (depth !== 0) errors.push({ line: li.line, file: li.file, message: 'MACRO without ENDM' });
      macros.set(name.toUpperCase(), { params, body });
      i = j;
      continue;
    }
    items.push({ text: li.text, line: li.line, file: li.file, from: 0 });
  }

  // phase 0b: expand macros/REPT, then PROC/USES
  const expanded = [];
  expandStream(items, { macros, equs: new Map(), unique: 0, active: new Set(), inMacro: 0 }, expanded, 0, errors);
  const stmts = procTransform(expanded, errors);

  // phase 0c: which labels are born inside RELOC regions? (syntactic — so
  // pass 1 can already count fixups for forward references)
  const relocLabels = new Set();
  {
    let scope = '', active = false;
    for (const s of stmts) {
      const p = cachedParse(s);
      const mn = p.mnemonic ? p.mnemonic.toUpperCase() : null;
      if (mn === 'RELOC') { active = true; continue; }
      if (mn === 'ENDRELOC') { active = false; continue; }
      if (p.label && mn !== 'EQU' && mn !== '=' && mn !== 'STRUC') {
        if (!p.label.startsWith('.')) scope = p.label.toUpperCase();
        if (active) relocLabels.add(fullName(p.label, scope));
      }
    }
  }

  // ---- passes ---------------------------------------------------------------
  const symbols = new Map();
  const image = new Uint8Array(0x10000);
  let minA = Infinity, maxA = -1;
  const listing = [];
  const defs = {}; // NAME → {file, line}: where each symbol was born (IDE nav)
  const fixups = [];
  let phaseFlagged = false;

  for (const pass of [1, 2]) {
    let addr = org & 0xffff;
    let scope = '';
    let struc = null;
    let fixCount = 0;
    const reloc = { active: false, start: 0 };
    let ended = false;

    for (const s of stmts) {
      if (ended) break;
      const p = cachedParse(s);
      const mn = p.mnemonic ? p.mnemonic.toUpperCase() : null;
      const lineErr = (m) =>
        errors.push({ line: s.line, file: s.file ?? null, message: m + (s.from ? ` (expanded from line ${s.from})` : '') });
      const list = (bytes = []) => {
        if (pass === 2) listing.push({ line: s.line, file: s.file ?? null, addr, bytes: Array.from(bytes), source: s.text });
      };
      const stmtAddr = addr;
      const ctx = { pass, addr: stmtAddr, scope, symbols, usedSyms: null };
      const evalStrict = (e) => evalExpr(e, { pass: 2, addr: stmtAddr, scope, symbols });

      // relocatable 16-bit field bookkeeping (+ the JP→JR hint)
      const relocNote = (used, off, target, opts = {}) => {
        if (!reloc.active) return;
        let hit = false;
        for (const u of used) if (relocLabels.has(u)) { hit = true; break; }
        if (!hit) return;
        if (opts.jp && (opts.cond === null || opts.cond < 4) && pass === 2) {
          const d = ((target - ((stmtAddr + 2) & 0xffff) + 0x8000) & 0xffff) - 0x8000;
          if (d >= -128 && d <= 127)
            warnings.push({ line: s.line, message: 'JP inside RELOC could be JR (relocatable for free)' });
        }
        fixCount++;
        if (pass === 2) fixups.push((stmtAddr + off - reloc.start) & 0xffff);
      };

      const X = {
        pass, addr: stmtAddr,
        err: (m) => { throw new AsmError(m); },
        ev: (e) => evalExpr(e, ctx),
        chk(v, lo, hi, what) {
          if (pass === 2 && (v < lo || v > hi)) X.err(`${what} out of range (${v})`);
          return v;
        },
        imm8(e) { return X.chk(X.ev(e), -128, 255, 'byte value') & 0xff; },
        disp(e) { return X.chk(X.ev(e), -128, 127, 'index displacement') & 0xff; },
        imm16(e) { const v = X.chk(X.ev(e), -32768, 65535, 'word value') & 0xffff; return [v & 0xff, v >> 8]; },
        imm16r(e, off, opts) {
          const used = new Set();
          const v = X.chk(evalExpr(e, { ...ctx, usedSyms: used }), -32768, 65535, 'word value') & 0xffff;
          relocNote(used, off, v, opts);
          return [v & 0xff, v >> 8];
        },
        rel(e) {
          const v = X.ev(e) & 0xffff;
          const d = ((v - ((stmtAddr + 2) & 0xffff) + 0x8000) & 0xffff) - 0x8000;
          X.chk(d, -128, 127, 'relative jump');
          return d & 0xff;
        },
        bit(e) { return X.chk(X.ev(e), 0, 7, 'bit number') & 7; },
      };

      try {
        // STRUC bodies define offsets, not bytes
        if (struc) {
          if (mn === 'ENDS') {
            symbols.set(struc.name, struc.offset);
            struc = null;
          } else if (mn || p.label) {
            const fname = p.label ?? p.mnemonic;
            const spec = p.label ? `${p.mnemonic ?? ''} ${p.args}`.trim() : p.args;
            const fm = /^(DB|DEFB|DW|DEFW|DS|DEFS)\b\s*([\s\S]*)$/i.exec(spec);
            if (!fm) throw new AsmError('STRUC fields must be DB/DW/DS');
            const unit = /^d(w|efw)$/i.test(fm[1]) ? 2 : 1;
            const arg = fm[2].trim();
            const cnt = arg && arg !== '?' ? evalStrict(arg) : 1;
            if (cnt < 0 || cnt > 0x10000) throw new AsmError('STRUC field size out of range');
            symbols.set(`${struc.name}.${fname.toUpperCase()}`, struc.offset);
            struc.offset += unit * cnt;
          }
          list();
          continue;
        }
        if (mn === 'STRUC') {
          if (!p.label) throw new AsmError('STRUC needs a name (name STRUC)');
          struc = { name: p.label.toUpperCase(), offset: 0 };
          list();
          continue;
        }

        if (mn === 'EQU' || mn === '=') {
          if (!p.label) throw new AsmError('EQU needs a label');
          const key = fullName(p.label, scope);
          if (pass === 1 && symbols.has(key)) { s._dup = true; lineErr(`duplicate symbol '${p.label}'`); }
          if (!s._dup) {
            let v = 0;
            try { v = evalExpr(p.args, ctx); } catch (e) { if (pass === 2) throw e; }
            symbols.set(key, v);
            if (pass === 1) defs[key] = { file: s.file ?? null, line: s.line };
          }
          list();
          continue;
        }

        if (p.label) {
          // duplicates are reported, not thrown — a throw here would skip the
          // statement's size on pass 1 and turn one mistake into phase noise
          const key = fullName(p.label, scope);
          if (pass === 1 && symbols.has(key)) { s._dup = true; lineErr(`duplicate label '${p.label}'`); }
          if (!s._dup) {
            symbols.set(key, addr);
            if (pass === 1) defs[key] = { file: s.file ?? null, line: s.line };
          }
          if (!p.label.startsWith('.')) { scope = p.label.toUpperCase(); ctx.scope = scope; }
        }
        if (!mn) { list(); continue; }

        if (mn === 'ORG') {
          if (pass === 1) {
            try { s._org = evalStrict(p.args) & 0xffff; }
            catch (e) { throw p1err('ORG: ' + e.message); }
          }
          if (s._org !== undefined) addr = s._org;
          if (pass === 2) listing.push({ line: s.line, file: s.file ?? null, addr, bytes: [], source: s.text });
          continue;
        }
        if (mn === 'END') { list(); ended = true; continue; }
        if (mn === 'RELOC') {
          if (reloc.active) throw new AsmError('nested RELOC');
          reloc.active = true;
          reloc.start = addr;
          list();
          continue;
        }
        if (mn === 'ENDRELOC') {
          if (!reloc.active) throw new AsmError('ENDRELOC without RELOC');
          reloc.active = false;
          list();
          continue;
        }

        let bytes;
        if (mn === 'FIXUPTABLE') {
          // DW count, then DW offsets (region-start-relative). Size must be
          // pass-stable, so fixCount is tracked identically on both passes —
          // put the table after ENDRELOC.
          if (pass === 1) { s._fixn = fixCount; bytes = new Array(2 + fixCount * 2).fill(0); }
          else {
            bytes = [fixCount & 0xff, (fixCount >> 8) & 0xff];
            for (const f of fixups) bytes.push(f & 0xff, (f >> 8) & 0xff);
          }
        } else if (mn === 'DB' || mn === 'DEFB' || mn === 'DEFM') {
          bytes = [];
          const itemsD = splitTop(p.args);
          if (!itemsD.length) X.err(`${mn} needs data`);
          for (const item of itemsD) {
            const q = item[0];
            if ((q === '"' || q === "'") && item[item.length - 1] === q && item.length >= 2 &&
                scanString(item, 0) === item.length) {
              for (let k = 1; k < item.length - 1; k++) {
                let ch = item[k];
                if (ch === '\\') { k++; ch = { n: '\n', r: '\r', t: '\t', 0: '\0' }[item[k]] ?? item[k]; }
                bytes.push(ch.charCodeAt(0) & 0xff);
              }
              continue;
            }
            bytes.push(X.imm8(item));
          }
        } else if (mn === 'DW' || mn === 'DEFW') {
          bytes = [];
          const itemsD = splitTop(p.args);
          if (!itemsD.length) X.err(`${mn} needs data`);
          itemsD.forEach((item, k) => bytes.push(...X.imm16r(item, k * 2)));
        } else if (mn === 'DS' || mn === 'DEFS') {
          if (pass === 1) {
            const parts = splitTop(p.args);
            if (!parts.length) throw p1err('DS needs a count');
            try {
              const n = evalStrict(parts[0]);
              const fill = parts[1] ? evalStrict(parts[1]) : 0;
              if (n < 0 || n > 0x10000) throw new AsmError('DS count out of range');
              s._ds = { n, fill: fill & 0xff };
            } catch (e) {
              throw p1err('DS: ' + e.message + ' (the count must be known on pass 1)');
            }
          }
          bytes = s._ds ? new Array(s._ds.n).fill(s._ds.fill) : [];
        } else {
          bytes = encodeInstr(mn, p.args, X);
        }

        if (pass === 1) s._addr1 = addr;
        else {
          if (s._addr1 !== addr && !phaseFlagged) {
            phaseFlagged = true;
            lineErr('phase error: addresses moved between passes');
          }
          let a = addr;
          for (const b of bytes) {
            image[a] = b & 0xff;
            if (a < minA) minA = a;
            if (a > maxA) maxA = a;
            a = (a + 1) & 0xffff;
          }
          listing.push({ line: s.line, file: s.file ?? null, addr, bytes: Array.from(bytes), source: s.text });
        }
        addr = (addr + bytes.length) & 0xffff;
      } catch (e) {
        if (!(e instanceof AsmError)) throw e;
        // pass 1 only surfaces its exclusive errors (dup labels, ORG/DS);
        // everything else re-raises on pass 2 and is reported there once
        if (pass === 2 || e.p1) lineErr(e.message);
      }
    }
    if (reloc.active && pass === 2) warnings.push({ line: 0, message: 'RELOC never closed (ENDRELOC missing)' });
    if (struc && pass === 2) errors.push({ line: 0, message: 'STRUC without ENDS' });
  }

  const outOrg = Number.isFinite(minA) ? minA : org & 0xffff;
  const bytes = maxA >= 0 ? image.slice(minA, maxA + 1) : new Uint8Array(0);
  return {
    schemaVersion: SCHEMA_VERSION,
    bytes,
    org: outOrg,
    symbols: Object.fromEntries(symbols),
    listing,
    errors,
    warnings,
    fixups,
    defs,
  };
}
