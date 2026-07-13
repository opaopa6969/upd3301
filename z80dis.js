// z80dis — Z80 disassembler. Pure JS, zero deps, deterministic.
//
// Mirrors z80.js's decoder (same x/y/z field split, same prefix rules), so
// anything the CPU core will execute has a spelling here: full main table,
// CB, ED, DD/FD (including the undocumented IXH/IXL halves and SLL), and
// DDCB/FDCB with the undocumented register-copy forms.
//
// Roundtrip contract with z80asm.js: any byte stream the assembler emits
// disassembles to text the assembler re-assembles to the SAME bytes. To keep
// that honest, encodings z80.js treats as wasted prefixes or ED holes come
// out as `DB` lines (a dead DD before an unprefixable op is its own 1-byte
// `DB 0DDh`, exactly how the silicon burns 4 T on it and moves on). The two
// famous ED duplicates ED63/ED6B keep their real meaning (`LD (nn),HL`) —
// a debugger should tell you what runs, not play byte-purity games.
//
// disasm(read, addr, { syntax }) → { text, len, bytes }
//   read:   (addr) => byte  callback (so it can point at live machine memory)
//   syntax: 'zilog' (default) or 'intel' — Intel 8080 mnemonics (MOV/MVI/
//           LXI/JMP/CNZ…) for the 8080-compatible subset, matching the
//           monitor culture PC-88 people grew up with. Z80-only encodings
//           (JR/DJNZ/EXX/CB/ED/DD/FD) have no 8080 spelling and stay Zilog.

export const SCHEMA_VERSION = 1;

const R = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'];
const R8080 = ['B', 'C', 'D', 'E', 'H', 'L', 'M', 'A'];
const RP = ['BC', 'DE', 'HL', 'SP'];
const RP8080 = ['B', 'D', 'H', 'SP'];
const CC = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'];
const ALU = ['ADD A,', 'ADC A,', 'SUB ', 'SBC A,', 'AND ', 'XOR ', 'OR ', 'CP '];
const ALU8080 = ['ADD ', 'ADC ', 'SUB ', 'SBB ', 'ANA ', 'XRA ', 'ORA ', 'CMP '];
const ALUI8080 = ['ADI ', 'ACI ', 'SUI ', 'SBI ', 'ANI ', 'XRI ', 'ORI ', 'CPI '];
const ROT = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SLL', 'SRL'];
const ACCROT = ['RLCA', 'RRCA', 'RLA', 'RRA', 'DAA', 'CPL', 'SCF', 'CCF'];
const ACCROT8080 = ['RLC', 'RRC', 'RAL', 'RAR', 'DAA', 'CMA', 'STC', 'CMC'];
const BLK = [
  ['LDI', 'CPI', 'INI', 'OUTI'],
  ['LDD', 'CPD', 'IND', 'OUTD'],
  ['LDIR', 'CPIR', 'INIR', 'OTIR'],
  ['LDDR', 'CPDR', 'INDR', 'OTDR'],
];

const sign8 = (v) => (v << 24) >> 24;

// classic assembler hex: uppercase, 'h' suffix, leading 0 when it starts
// with a letter (0FFh) so it stays a number to the parser
export function hexN(v, w) {
  let s = (v & 0xffff).toString(16).toUpperCase().padStart(w, '0');
  if (s.charCodeAt(0) > 0x39) s = '0' + s;
  return s + 'h';
}

export function disasm(read, addr, { syntax = 'zilog' } = {}) {
  addr &= 0xffff;
  const intel = syntax === 'intel';
  const bytes = [];
  const fetch = () => { const v = read((addr + bytes.length) & 0xffff) & 0xff; bytes.push(v); return v; };
  const fetch16 = () => { const lo = fetch(); return lo | (fetch() << 8); };
  let used = false; // did a DD/FD prefix actually change the instruction?

  const dispStr = (d) => (d < 0 ? '-' + hexN(-d, 2) : '+' + hexN(d, 2));

  function main(ixy) {
    const op = fetch();
    if (op === 0xdd || op === 0xfd) {
      if (ixy) return null; // prefix chain: the first prefix is dead weight
      const name = op === 0xdd ? 'IX' : 'IY';
      const mark = bytes.length;
      used = false;
      const t = main(name);
      if (t !== null && used) return t;
      bytes.length = mark; // roll back — emit the dead prefix as its own byte
      return 'DB ' + hexN(op, 2);
    }
    if (op === 0xcb) return cb(ixy);
    if (op === 0xed) return ixy ? null : ed(); // ED ignores DD/FD entirely

    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    let eaTxt = null;
    const EA = () => {
      if (eaTxt === null) {
        if (ixy) { used = true; eaTxt = `(${ixy}${dispStr(sign8(fetch()))})`; }
        else eaTxt = '(HL)';
      }
      return eaTxt;
    };
    // IX/IY halves substitute H/L unless the instruction touches (HL) —
    // the same real-chip rule z80.js implements
    const useHalves = ixy && !(x === 1 ? (y === 6 || z === 6) : x === 0 ? y === 6 : z === 6);
    const rN = (i) => {
      if (i === 6) return EA();
      if (useHalves && (i === 4 || i === 5)) { used = true; return ixy + (i === 4 ? 'H' : 'L'); }
      return R[i];
    };
    const rpN = (i) => {
      if (i === 2 && ixy) { used = true; return ixy; }
      return RP[i];
    };
    const hlN = () => { if (ixy) { used = true; return ixy; } return 'HL'; };
    // Intel spellings only apply to unprefixed encodings — under a prefix
    // we are in Z80-only territory and Zilog text is the truth
    const i80 = intel && !ixy;

    if (x === 1) {
      if (op === 0x76) return i80 ? 'HLT' : 'HALT';
      const dst = rN(y), src = rN(z); // EA (the d byte) resolves in fetch order
      return i80 ? `MOV ${R8080[y]},${R8080[z]}` : `LD ${dst},${src}`;
    }
    if (x === 2) {
      const o = rN(z);
      return i80 ? ALU8080[y] + R8080[z] : ALU[y] + o;
    }
    if (x === 0) {
      switch (z) {
        case 0: {
          if (y === 0) return 'NOP';
          if (y === 1) return "EX AF,AF'"; // Z80-only from here down
          const d = sign8(fetch());
          const target = hexN((addr + bytes.length + d) & 0xffff, 4);
          if (y === 2) return `DJNZ ${target}`;
          if (y === 3) return `JR ${target}`;
          return `JR ${CC[y - 4]},${target}`;
        }
        case 1:
          if (y & 1) return i80 ? `DAD ${RP8080[y >> 1]}` : `ADD ${hlN()},${rpN(y >> 1)}`;
          return i80 ? `LXI ${RP8080[y >> 1]},${hexN(fetch16(), 4)}`
            : `LD ${rpN(y >> 1)},${hexN(fetch16(), 4)}`;
        case 2:
          switch (y) {
            case 0: return i80 ? 'STAX B' : 'LD (BC),A';
            case 1: return i80 ? 'LDAX B' : 'LD A,(BC)';
            case 2: return i80 ? 'STAX D' : 'LD (DE),A';
            case 3: return i80 ? 'LDAX D' : 'LD A,(DE)';
            case 4: { const nn = hexN(fetch16(), 4); return i80 ? `SHLD ${nn}` : `LD (${nn}),${hlN()}`; }
            case 5: { const nn = hexN(fetch16(), 4); return i80 ? `LHLD ${nn}` : `LD ${hlN()},(${nn})`; }
            case 6: { const nn = hexN(fetch16(), 4); return i80 ? `STA ${nn}` : `LD (${nn}),A`; }
            default: { const nn = hexN(fetch16(), 4); return i80 ? `LDA ${nn}` : `LD A,(${nn})`; }
          }
        case 3:
          if (i80) return `${y & 1 ? 'DCX' : 'INX'} ${RP8080[y >> 1]}`;
          return `${y & 1 ? 'DEC' : 'INC'} ${rpN(y >> 1)}`;
        case 4: return i80 ? `INR ${R8080[y]}` : `INC ${rN(y)}`;
        case 5: return i80 ? `DCR ${R8080[y]}` : `DEC ${rN(y)}`;
        case 6: { // with a prefix the d byte comes before n — rN(y) fetches it
          const dst = rN(y);
          const n = hexN(fetch(), 2);
          return i80 ? `MVI ${R8080[y]},${n}` : `LD ${dst},${n}`;
        }
        default:
          return i80 ? ACCROT8080[y] : ACCROT[y];
      }
    }
    // x === 3
    switch (z) {
      case 0: return i80 ? ['RNZ', 'RZ', 'RNC', 'RC', 'RPO', 'RPE', 'RP', 'RM'][y] : `RET ${CC[y]}`;
      case 1:
        if (!(y & 1)) {
          const rp = y >> 1;
          if (i80) return `POP ${rp === 3 ? 'PSW' : RP8080[rp]}`;
          return `POP ${rp === 3 ? 'AF' : rpN(rp)}`;
        }
        switch (y >> 1) {
          case 0: return 'RET';
          case 1: return 'EXX';
          case 2: return i80 ? 'PCHL' : `JP (${hlN()})`;
          default: return i80 ? 'SPHL' : `LD SP,${hlN()}`;
        }
      case 2: {
        const nn = hexN(fetch16(), 4);
        if (i80) return `${['JNZ', 'JZ', 'JNC', 'JC', 'JPO', 'JPE', 'JP', 'JM'][y]} ${nn}`;
        return `JP ${CC[y]},${nn}`;
      }
      case 3:
        switch (y) {
          case 0: { const nn = hexN(fetch16(), 4); return i80 ? `JMP ${nn}` : `JP ${nn}`; }
          case 2: { const n = hexN(fetch(), 2); return i80 ? `OUT ${n}` : `OUT (${n}),A`; }
          case 3: { const n = hexN(fetch(), 2); return i80 ? `IN ${n}` : `IN A,(${n})`; }
          case 4: return i80 ? 'XTHL' : `EX (SP),${hlN()}`;
          case 5: return i80 ? 'XCHG' : 'EX DE,HL'; // never takes a prefix
          case 6: return 'DI';
          default: return 'EI';
        }
      case 4: {
        const nn = hexN(fetch16(), 4);
        if (i80) return `${['CNZ', 'CZ', 'CNC', 'CC', 'CPO', 'CPE', 'CP', 'CM'][y]} ${nn}`;
        return `CALL ${CC[y]},${nn}`;
      }
      case 5:
        if (!(y & 1)) {
          const rp = y >> 1;
          if (i80) return `PUSH ${rp === 3 ? 'PSW' : RP8080[rp]}`;
          return `PUSH ${rp === 3 ? 'AF' : rpN(rp)}`;
        }
        { const nn = hexN(fetch16(), 4); return `CALL ${nn}`; } // y=1 only; 3/5/7 are prefixes
      case 6: {
        const n = hexN(fetch(), 2);
        return i80 ? ALUI8080[y] + n : ALU[y] + n;
      }
      default:
        return i80 ? `RST ${y}` : `RST ${hexN(y << 3, 2)}`;
    }
  }

  function cb(ixy) {
    let eaTxt = null;
    if (ixy) { used = true; eaTxt = `(${ixy}${dispStr(sign8(fetch()))})`; } // d before op
    const op = fetch();
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    const tgt = ixy ? eaTxt : R[z];
    const copy = ixy && z !== 6 ? ',' + R[z] : ''; // undocumented register-copy form
    if (x === 0) return `${ROT[y]} ${tgt}${copy}`;
    if (x === 1) return `BIT ${y},${tgt}`; // BIT has no copy form
    return `${x === 2 ? 'RES' : 'SET'} ${y},${tgt}${copy}`;
  }

  function ed() {
    const op = fetch();
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    const db = () => `DB 0EDh,${hexN(op, 2)}`; // holes: what z80.js NOPs, we DB
    if (x === 1) {
      switch (z) {
        case 0: return y === 6 ? 'IN (C)' : `IN ${R[y]},(C)`;
        case 1: return y === 6 ? 'OUT (C),0' : `OUT (C),${R[y]}`;
        case 2: return `${y & 1 ? 'ADC' : 'SBC'} HL,${RP[y >> 1]}`;
        case 3: {
          const nn = hexN(fetch16(), 4);
          return y & 1 ? `LD ${RP[y >> 1]},(${nn})` : `LD (${nn}),${RP[y >> 1]}`;
        }
        case 4: return y === 0 ? 'NEG' : db(); // the 7 shadows execute as NEG too
        case 5: return y === 0 ? 'RETN' : y === 1 ? 'RETI' : db();
        case 6: return op === 0x46 ? 'IM 0' : op === 0x56 ? 'IM 1' : op === 0x5e ? 'IM 2' : db();
        default:
          switch (y) {
            case 0: return 'LD I,A';
            case 1: return 'LD R,A';
            case 2: return 'LD A,I';
            case 3: return 'LD A,R';
            case 4: return 'RRD';
            case 5: return 'RLD';
            default: return db();
          }
      }
    }
    if (x === 2 && z <= 3 && y >= 4) return BLK[y - 4][z];
    return db();
  }

  const text = main(null) ?? 'DB ' + hexN(bytes[0], 2);
  return { text, len: bytes.length, bytes };
}
