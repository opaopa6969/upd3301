// ide-tools — the pure logic under demo/ide.html: syntax highlighting for
// the hand-rolled editor, project INCLUDE resolution, symbol navigation,
// and the μPD3301 attribute designer (the author's centerpiece: paint
// attributes with a mouse, watch the 20-pairs-per-row budget like a hawk).
// No DOM here — everything runs under node --test.

import { expandRowStates, DEFAULT_COLOR_SPEC } from '../pc8001.js';

export const SCHEMA_VERSION = 1;

// ---- syntax highlighting -----------------------------------------------------
// Token classes for the textarea+<pre> overlay editor. Output is HTML with
// <span class=hl-*> wrappers; input is ONE line (no newlines).
const MNEMONICS = new Set(('LD PUSH POP EX EXX ADD ADC SUB SBC AND XOR OR CP INC DEC RLC RRC RL RR SLA SRA '
  + 'SLL SLI SRL BIT RES SET JP JR DJNZ CALL RET RST IN OUT IM NOP HALT DI EI DAA CPL CCF SCF NEG '
  + 'RLCA RLA RRCA RRA RLD RRD RETI RETN LDI LDIR LDD LDDR CPI CPIR CPD CPDR INI INIR IND INDR '
  + 'OUTI OTIR OUTD OTDR').split(' '));
const PSEUDO = new Set(('ORG EQU DB DEFB DEFM DW DEFW DS DEFS END INCLUDE MACRO ENDM REPT IRP IRPC LOCAL '
  + 'EXITM PURGE IF IFE IF1 IF2 IFDEF IFNDEF IFB IFNB IFIDN IFDIF ELSE ENDIF PROC ENDP USES STRUC ENDS '
  + 'RELOC ENDRELOC FIXUPTABLE').split(' '));
const REGISTERS = new Set(('A B C D E H L I R F AF BC DE HL IX IY SP PC IXH IXL IYH IYL').split(' '));

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlightAsm(line) {
  let out = '', i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === ';') { // comment to end of line
      out += `<span class="hl-com">${escapeHtml(line.slice(i))}</span>`;
      break;
    }
    if (c === '"' || (c === "'" && !/[A-Za-z0-9_')]/.test(line[i - 1] ?? ''))) {
      let j = i + 1;
      while (j < n && line[j] !== c) { if (line[j] === '\\') j++; j++; }
      out += `<span class="hl-str">${escapeHtml(line.slice(i, j + 1))}</span>`;
      i = j + 1;
      continue;
    }
    let m;
    if ((m = /^[0-9][0-9A-Fa-f]*[hH]|^0[xXbB][0-9A-Fa-f]+|^[0-9]+[dDbB]?/.exec(line.slice(i)))) {
      out += `<span class="hl-num">${m[0]}</span>`;
      i += m[0].length;
      continue;
    }
    if ((m = /^[.A-Za-z_@?][A-Za-z0-9_~.?]*/.exec(line.slice(i)))) {
      const tok = m[0], up = tok.toUpperCase();
      const isLabel = line[i + tok.length] === ':';
      const cls = isLabel || tok[0] === '.' ? 'hl-lab'
        : MNEMONICS.has(up) ? 'hl-mn'
        : PSEUDO.has(up) ? 'hl-ps'
        : REGISTERS.has(up) ? 'hl-reg'
        : 'hl-id';
      out += `<span class="${cls}">${escapeHtml(tok)}</span>`;
      i += tok.length;
      continue;
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

// ---- project resolution ---------------------------------------------------------
// files: Map(path → source). INCLUDE paths resolve relative to the includer
// with ./ and ../ folded; falls back to a project-root lookup.
export function normalizePath(base, path) {
  let p = path.replace(/\\/g, '/');
  if (!p.startsWith('/') && base) {
    const dir = base.split('/').slice(0, -1);
    for (const part of p.split('/')) {
      if (part === '.' || part === '') continue;
      else if (part === '..') dir.pop();
      else dir.push(part);
    }
    p = dir.join('/');
  }
  return p.replace(/^\//, '');
}

export function makeResolver(files) {
  const stack = []; // includer chain for relative resolution
  return {
    include: (path) => {
      const base = stack[stack.length - 1] ?? '';
      const norm = normalizePath(base, path);
      const hit = files.get(norm) ?? files.get(path) ?? null;
      if (hit != null) stack.push(files.has(norm) ? norm : path);
      return hit;
    },
  };
}

// textual references to a symbol across project files (xref for the editor —
// token-exact, string/comment-blind on purpose: cheap and predictable)
export function findRefs(files, name) {
  const out = [];
  const re = new RegExp(`(^|[^A-Za-z0-9_~.?])(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![A-Za-z0-9_~.?])`, 'i');
  for (const [file, src] of files) {
    const lines = String(src).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (m) out.push({ file, line: i + 1, col: m.index + m[1].length, text: lines[i].trim() });
    }
  }
  return out;
}

// ---- attribute designer (μPD3301 centerpiece) -------------------------------------
// The grid holds per-cell STATE (a color-spec byte and a function-spec byte,
// same encoding the chip uses); packing compresses runs into the chip's
// (position, value) pairs and counts them against the 20-per-row budget.

export function makeAttrGrid(cols = 80, rows = 25) {
  return {
    cols, rows,
    color: new Uint8Array(cols * rows).fill(DEFAULT_COLOR_SPEC),
    func: new Uint8Array(cols * rows).fill(0),
  };
}

// paint a rectangle. patch: { color:0-7, semi:bool, reverse, blink, secret,
// upline, lowline, resetColor:bool, resetFunc:bool } — only the aspects
// present in the patch change; the rest of the cell state survives.
const FUNC_BITS = { semigraphicMono: 0x80, lowline: 0x20, upline: 0x10, reverse: 0x04, blink: 0x02, secret: 0x01 };

export function paintAttr(grid, x1, y1, x2, y2, patch = {}) {
  const [xa, xb] = x1 <= x2 ? [x1, x2] : [x2, x1];
  const [ya, yb] = y1 <= y2 ? [y1, y2] : [y2, y1];
  for (let y = Math.max(0, ya); y <= Math.min(grid.rows - 1, yb); y++) {
    for (let x = Math.max(0, xa); x <= Math.min(grid.cols - 1, xb); x++) {
      const i = y * grid.cols + x;
      let cv = grid.color[i], fv = grid.func[i];
      if (patch.resetColor) cv = DEFAULT_COLOR_SPEC;
      if (patch.resetFunc) fv = 0;
      if (patch.color != null) cv = 0x08 | ((patch.color & 7) << 5) | (cv & 0x10);
      if (patch.semi != null) cv = (cv & ~0x10) | (patch.semi ? 0x10 : 0);
      for (const [k, bit] of Object.entries(FUNC_BITS)) {
        if (patch[k] != null) fv = (fv & ~bit) | (patch[k] ? bit : 0);
      }
      grid.color[i] = cv;
      grid.func[i] = fv;
    }
  }
  return grid;
}

// compress one row of per-cell state into (position, value) pairs — the
// exact inverse of expandRowStates. The chip quirk is honored: the FIRST
// pair always takes effect from column 0, so when the first change sits
// mid-row we prepend an explicit default pair to anchor the left edge.
export function packAttrRow(grid, y) {
  const { cols } = grid;
  const base = y * grid.cols;
  const pairs = [];
  let curColor = DEFAULT_COLOR_SPEC, curFunc = 0;
  for (let x = 0; x < cols; x++) {
    const cv = grid.color[base + x], fv = grid.func[base + x];
    if (cv !== curColor) { pairs.push([x, cv]); curColor = cv; }
    if (fv !== curFunc) { pairs.push([x, fv]); curFunc = fv; }
  }
  if (pairs.length && pairs[0][0] > 0) pairs.unshift([0, DEFAULT_COLOR_SPEC]);
  return pairs;
}

// row budget: the real chip fetches at most 20 pairs per row (EX mode is
// per-cell and unlimited — the UI says so instead of crying wolf)
export function rowBudget(grid, y, maxPairs = 20) {
  const pairs = packAttrRow(grid, y);
  return { pairs, count: pairs.length, over: pairs.length > maxPairs, max: maxPairs };
}

export function packedRowBytes(pairs, attrBytes = 40) {
  const out = new Uint8Array(attrBytes); // (0,0) padding = the chip's own sentinel
  for (let i = 0; i < pairs.length && i * 2 + 1 < attrBytes; i++) {
    out[i * 2] = pairs[i][0] & 0xff;
    out[i * 2 + 1] = pairs[i][1] & 0xff;
  }
  return out;
}

const h2 = (v) => v.toString(16).toUpperCase().padStart(2, '0') + 'h';
const pad0 = (v) => (v < 0xa0 ? '' : '0');

// (a) z80asm source: one labeled DB row per screen row + a copy-loop stub
export function gridToDb(grid, { vramBase = 0xf3c8, attrBytes = 40 } = {}) {
  const stride = grid.cols + attrBytes;
  const lines = [
    '; attribute table from the ICE attribute designer',
    `; target: text VRAM ${(vramBase).toString(16).toUpperCase()}h, stride ${stride}, attr bytes at +${grid.cols}`,
    'attrtab:',
  ];
  for (let y = 0; y < grid.rows; y++) {
    const bytes = packedRowBytes(packAttrRow(grid, y), attrBytes);
    for (let o = 0; o < attrBytes; o += 20) {
      const chunk = [...bytes.slice(o, o + 20)].map((b) => pad0(b) + h2(b)).join(',');
      lines.push(`        DB ${chunk}${o === 0 ? `   ; row ${y}` : ''}`);
    }
  }
  lines.push(
    '',
    '; copy it into the attribute area of every row:',
    `;   LD DE,${(vramBase + grid.cols).toString(16).toUpperCase()}h`,
    ';   LD HL,attrtab',
    `;   LD B,${grid.rows}`,
    `; .row: LD BC,${attrBytes} / LDIR / EX DE,HL / LD BC,${grid.cols} / ADD HL,BC / EX DE,HL / DJNZ .row`,
  );
  return lines.join('\n');
}

// (b) raw writes for the live machine: [{addr, bytes}] per row (attr area only)
export function gridToVram(grid, { vramBase = 0xf3c8, attrBytes = 40 } = {}) {
  const stride = grid.cols + attrBytes;
  const out = [];
  for (let y = 0; y < grid.rows; y++) {
    out.push({
      addr: (vramBase + y * stride + grid.cols) & 0xffff,
      bytes: packedRowBytes(packAttrRow(grid, y), attrBytes),
    });
  }
  return out;
}

// (c) a JS snippet against the text-system API (pc8001.js line().attrs())
export function gridToTermCode(grid) {
  const lines = ['// paste into a page holding a Pc8001TextSystem as `sys`'];
  for (let y = 0; y < grid.rows; y++) {
    const pairs = packAttrRow(grid, y);
    if (!pairs.length) continue;
    lines.push(`sys.line(${y}).attrs(${pairs.map(([p, v]) => `${p},0x${v.toString(16).toUpperCase().padStart(2, '0')}`).join(', ')});`);
  }
  return lines.join('\n');
}

// import the live machine's current screen (via ice-tools' textVramModel
// output) so editing starts from reality instead of a blank sheet
export function gridFromModel(model) {
  if (!model?.rowsData) return null;
  const grid = makeAttrGrid(model.cols, model.rows);
  for (const row of model.rowsData) {
    for (const span of row.spans) {
      for (let x = span.from; x <= span.to && x < model.cols; x++) {
        grid.color[row.y * model.cols + x] = span.color;
        grid.func[row.y * model.cols + x] = span.func;
      }
    }
  }
  return grid;
}

// verification helper (used by tests): expand our packed pairs through the
// SAME decoder the renderer uses and compare against the grid state
export function verifyRow(grid, y, attrsPerRow = 20) {
  const pairs = packAttrRow(grid, y);
  const flat = packedRowBytes(pairs, attrsPerRow * 2);
  const colorOut = new Uint8Array(grid.cols), funcOut = new Uint8Array(grid.cols);
  expandRowStates(flat, attrsPerRow, grid.cols, colorOut, funcOut);
  const base = y * grid.cols;
  for (let x = 0; x < grid.cols; x++) {
    if (colorOut[x] !== grid.color[base + x] || funcOut[x] !== grid.func[base + x]) {
      return { ok: false, x, expected: [grid.color[base + x], grid.func[base + x]], got: [colorOut[x], funcOut[x]] };
    }
  }
  return { ok: true };
}
