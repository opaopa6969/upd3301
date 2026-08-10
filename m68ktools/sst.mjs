// Decoder for the SingleStepTests/m68000 `.json.bin` container.
//
// The upstream repo ships its per-instruction test vectors in a small binary
// container instead of raw JSON (the JSON expands to gigabytes). The layout is
// documented by the repo's own decode.py; this is the same format read from JS
// so the harness needs no Python. The data itself is never committed here —
// see docs/m68000-design.md for the fetch step.
//
// Every record is length-prefixed and magic-tagged, which is what makes a
// truncated or half-downloaded file fail loudly instead of silently decoding
// garbage into "test failures".

import { readFileSync } from 'node:fs';

const MAGIC_FILE = 0x1a3f5d71;
const MAGIC_TEST = 0xabc12367;
const MAGIC_NAME = 0x89abcdef;
const MAGIC_STATE = 0x01234567;
const MAGIC_TRANS = 0x456789ab;

const REG_ORDER = [
  'd0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7',
  'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'usp',
  'ssp', 'sr', 'pc',
];

const KIND = { 0: 'n', 1: 'w', 2: 'r', 3: 't', 4: 're', 5: 'we' };

class Reader {
  constructor(buf) { this.v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); this.p = 0; }
  u8() { const v = this.v.getUint8(this.p); this.p += 1; return v; }
  u16() { const v = this.v.getUint16(this.p, true); this.p += 2; return v; }
  u32() { const v = this.v.getUint32(this.p, true); this.p += 4; return v; }
  bytes(n) { const v = new Uint8Array(this.v.buffer, this.v.byteOffset + this.p, n); this.p += n; return v; }
  header(magic, what) {
    this.u32(); // record length, unused: every record is self-delimiting
    const m = this.u32();
    if (m !== magic) throw new Error(`sst: bad ${what} magic ${m.toString(16)} at ${this.p - 4}`);
  }
}

function readName(r) {
  r.header(MAGIC_NAME, 'name');
  const len = r.u32();
  return new TextDecoder().decode(r.bytes(len));
}

function readState(r) {
  r.header(MAGIC_STATE, 'state');
  const st = {};
  for (const k of REG_ORDER) st[k] = r.u32();
  st.prefetch = [r.u32(), r.u32()];
  const n = r.u32();
  // RAM comes as 16-bit words because the real bus is 16 bits wide; split into
  // the byte pairs the comparison works in.
  const ram = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const addr = r.u32(), data = r.u16();
    ram[i * 2] = [addr, data >> 8];
    ram[i * 2 + 1] = [addr | 1, data & 0xff];
  }
  st.ram = ram;
  return st;
}

function readTransactions(r) {
  r.header(MAGIC_TRANS, 'transactions');
  const cycles = r.u32();
  const n = r.u32();
  const list = new Array(n);
  for (let i = 0; i < n; i++) {
    const tw = r.u8(), c = r.u32();
    if (tw === 0) { list[i] = { kind: 'n', cycles: c }; continue; }
    const fc = r.u32(), addr = r.u32(), data = r.u32(), uds = r.u32(), lds = r.u32();
    list[i] = { kind: KIND[tw], cycles: c, fc, addr, data, uds, lds, width: uds + lds === 2 ? 'w' : 'b' };
  }
  return { cycles, list };
}

export function decodeTests(buf) {
  const r = new Reader(buf);
  const magic = r.u32();
  if (magic !== MAGIC_FILE) throw new Error('sst: not a SingleStepTests .json.bin file');
  const n = r.u32();
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    r.header(MAGIC_TEST, 'test');
    const name = readName(r);
    const initial = readState(r);
    const final = readState(r);
    const { cycles, list } = readTransactions(r);
    out[i] = { name, initial, final, cycles, transactions: list };
  }
  return out;
}

export function loadTestFile(path) {
  return decodeTests(readFileSync(path));
}

export { REG_ORDER };
