// ice-tools — the pure logic behind ICE round 2 panels (issue #6): memory
// search, cheat-engine-style change search, and the μPD3301 text-VRAM /
// attribute viewer. No DOM here — everything is testable under node --test,
// the DOM in ice.js just renders what these return.

import { decodeAttrPair, expandRowStates } from '../pc8001.js';

export const SCHEMA_VERSION = 1;

// ---- byte / ASCII search -------------------------------------------------------
// "41 42 43", "41,42", "4142" (even-length hex run) or "text" / 'text'
export function parsePattern(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (!s) return null;
  const q = s[0];
  if ((q === '"' || q === "'") && s.length >= 3 && s[s.length - 1] === q) {
    return [...s.slice(1, -1)].map((ch) => ch.charCodeAt(0) & 0xff);
  }
  const parts = s.split(/[\s,]+/).filter(Boolean);
  const bytes = [];
  for (const p of parts) {
    if (!/^[0-9A-Fa-f]+$/.test(p) || p.length % 2) return null;
    for (let i = 0; i < p.length; i += 2) bytes.push(parseInt(p.slice(i, i + 2), 16));
  }
  return bytes.length ? bytes : null;
}

export function searchBytes(read, pattern, { start = 0, end = 0x10000, limit = 256 } = {}) {
  const hits = [];
  if (!pattern?.length) return hits;
  const n = pattern.length;
  for (let a = start; a <= end - n; a++) {
    let ok = true;
    for (let i = 0; i < n; i++) {
      if ((read((a + i) & 0xffff) & 0xff) !== pattern[i]) { ok = false; break; }
    }
    if (ok) {
      hits.push(a);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

// ---- change search (the cheat-engine loop) --------------------------------------
// init() photographs all 64KB; each filter() compares the live memory against
// the previous photograph, keeps the addresses that match the relation, and
// re-photographs. Three or four filters usually corner a work-area byte.
export class ChangeSearch {
  constructor(size = 0x10000) {
    this.size = size;
    this.snap = null;
    this.alive = null; // Uint8Array mask; null until init
  }

  init(read) {
    this.snap = new Uint8Array(this.size);
    this.alive = new Uint8Array(this.size).fill(1);
    for (let a = 0; a < this.size; a++) this.snap[a] = read(a) & 0xff;
    return this.size;
  }

  count() {
    if (!this.alive) return 0;
    let n = 0;
    for (let a = 0; a < this.size; a++) if (this.alive[a]) n++;
    return n;
  }

  // op: 'eq' | 'ne' | 'gt' | 'lt' (vs previous photo) | 'val' (vs operand)
  filter(read, op, operand = 0) {
    if (!this.alive) return 0;
    let kept = 0;
    for (let a = 0; a < this.size; a++) {
      const v = read(a) & 0xff;
      if (this.alive[a]) {
        const p = this.snap[a];
        const keep =
          op === 'eq' ? v === p :
          op === 'ne' ? v !== p :
          op === 'gt' ? v > p :
          op === 'lt' ? v < p :
          op === 'val' ? v === (operand & 0xff) : false;
        if (keep) kept++;
        else this.alive[a] = 0;
      }
      this.snap[a] = v; // everyone gets re-photographed, survivors and not
    }
    return kept;
  }

  list(read, limit = 64) {
    const out = [];
    if (!this.alive) return out;
    for (let a = 0; a < this.size && out.length < limit; a++) {
      if (this.alive[a]) out.push({ addr: a, value: read(a) & 0xff, prev: this.snap[a] });
    }
    return out;
  }
}

// ---- text VRAM / attribute viewer (the μPD3301 specialty) ------------------------
// Reads what the DMA channel 2 would haul: base address and stride from the
// live DMAC/CRTC programming, characters + raw attribute pairs from RAM
// through the DMAC's own readMemory (bank-truth: exactly what the chip sees),
// and the expanded per-column effect via the same expandRowStates the
// renderer uses. So the viewer never lies about what the screen will do.
const FUNC_FLAGS = [
  [0x80, 'SG'], [0x20, 'LL'], [0x10, 'UL'], [0x04, 'REV'], [0x02, 'BLK'], [0x01, 'SEC'],
];

export function attrShort(value) {
  const d = decodeAttrPair(value);
  if (d.kind === 'color') return `COL${d.color}${d.semigraphic ? '+SG' : ''}`;
  const f = FUNC_FLAGS.filter(([bit]) => value & bit).map(([, nm]) => nm);
  return f.length ? f.join('+') : 'plain';
}

export function textVramModel(machine, { maxRows = 64 } = {}) {
  const crtc = machine?.crtc ?? machine?.sys?.crtc;
  const dmac = machine?.dmac ?? machine?.sys?.dmac;
  const ch = dmac?.channels?.[2];
  if (!crtc || !dmac || !ch) return null;
  const mask = ch.exCount != null ? ch.exMask : 0xffff;
  const read = (a) => dmac.readMemory(a & mask) & 0xff;
  const cols = crtc.cols | 0, rows = Math.min(crtc.rows | 0, maxRows);
  if (!cols || !rows) {
    return { base: ch.baseAddr, count: 0, stride: 0, cols, rows, enabled: !!dmac.enabled?.(2), ve: !!crtc.ve, rowsData: [] };
  }
  const abpr = crtc.attrBytesPerRow ?? (crtc.attrsPerRow ?? 0) * 2;
  const stride = cols + abpr;
  const base = ch.baseAddr;
  const count = ch.exCount ?? ((ch.baseCount & 0x3fff) + 1);
  const rowsData = [];
  const colorRow = new Uint8Array(cols), funcRow = new Uint8Array(cols);
  const rawRow = new Uint8Array(abpr);
  for (let y = 0; y < rows; y++) {
    const addr = (base + y * stride) & mask;
    let text = '';
    for (let x = 0; x < cols; x++) {
      const c = read(addr + x);
      text += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '·';
    }
    for (let i = 0; i < abpr; i++) rawRow[i] = read(addr + cols + i);
    const pairs = [];
    if (!crtc.attrPerCell) {
      for (let k = 0; k < (crtc.attrsPerRow ?? 0); k++) {
        const pos = rawRow[k * 2], val = rawRow[k * 2 + 1];
        if (k > 0 && pos === 0 && val === 0) break; // N-BASIC padding sentinel
        pairs.push({ k, pos, val, text: attrShort(val) });
      }
      expandRowStates(rawRow, crtc.attrsPerRow ?? 0, cols, colorRow, funcRow);
    } else {
      for (let x = 0; x < cols; x++) { colorRow[x] = rawRow[x]; funcRow[x] = 0; }
    }
    // compress per-column state into spans — the "effect range" overlay
    const spans = [];
    let from = 0;
    for (let x = 1; x <= cols; x++) {
      if (x === cols || colorRow[x] !== colorRow[from] || funcRow[x] !== funcRow[from]) {
        spans.push({ from, to: x - 1, color: colorRow[from], func: funcRow[from] });
        from = x;
      }
    }
    rowsData.push({ y, addr, text, pairs, spans });
  }
  return {
    base, count, stride, cols, rows,
    attrsPerRow: crtc.attrsPerRow ?? 0,
    attrPerCell: !!crtc.attrPerCell,
    enabled: !!dmac.enabled?.(2),
    ve: !!crtc.ve,
    rowsData,
  };
}
