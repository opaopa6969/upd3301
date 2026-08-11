// snapjson — carry a machine snapshot through JSON without losing it.
//
// Snapshots are built out of typed arrays, and this is what JSON does to one:
//
//     JSON.parse(JSON.stringify(new Uint8Array([1,2,3])))   →   {"0":1,"1":2,"2":3}
//
// which is not a typed array. The trap is what happens next: `TypedArray.set()`
// accepts that object, copies **zero** elements from it, and throws nothing. A
// round trip through raw JSON therefore empties every buffer in a snapshot in
// total silence — the restore succeeds, the machine reports no error, and it
// resumes from blank RAM.
//
// This was found by a test that was itself wrong. test-determinism.mjs used
// `JSON.parse(JSON.stringify(...))` to "force plain data" and then compared 15
// frames later; the emptied snapshot re-converged by then, so two mistakes
// cancelled and the case passed. The contract suite caught it (test-contract.mjs).
//
// Nothing in the repository serialises snapshots today — the rewind ring and the
// ICE keep them in memory, analysisdb.js has its own format — so the hole is
// latent rather than live. But "save state to a file", "post a repro alongside
// an analysis note" and "hand a snapshot to a worker" are all one line away from
// it, and that line looks correct.
//
// The encoding tags typed arrays instead of letting them decay:
//
//     { $t: 'u8', d: 'base64…' }
//
// Base64 rather than an array of numbers because the ring is budgeted in bytes:
// `Array.from()` on a 64KB buffer costs about eight bytes per byte in JSON,
// base64 costs four thirds.
//
// Pure, dependency-free, deterministic. Round-tripping is exact: encode(decode(x))
// and decode(encode(x)) both reproduce their input, including nested buffers.

export const SCHEMA_VERSION = 1;

const CTORS = {
  u8: Uint8Array, u8c: Uint8ClampedArray, i8: Int8Array,
  u16: Uint16Array, i16: Int16Array,
  u32: Uint32Array, i32: Int32Array,
  f32: Float32Array, f64: Float64Array,
};
const TAGS = new Map(Object.entries(CTORS).map(([tag, C]) => [C, tag]));

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = (() => { const m = new Uint8Array(128); for (let i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i; return m; })();

/** Base64 without relying on Buffer or btoa — this file runs anywhere. */
function toB64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
        + (b === undefined ? '=' : B64[(n >> 6) & 63])
        + (c === undefined ? '=' : B64[n & 63]);
  }
  return out;
}

function fromB64(s) {
  let len = (s.length >> 2) * 3;
  if (s.endsWith('==')) len -= 2; else if (s.endsWith('=')) len -= 1;
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64I[s.charCodeAt(i)] << 18) | (B64I[s.charCodeAt(i + 1)] << 12)
            | (B64I[s.charCodeAt(i + 2)] << 6) | B64I[s.charCodeAt(i + 3)];
    if (o < len) out[o++] = (n >> 16) & 0xff;
    if (o < len) out[o++] = (n >> 8) & 0xff;
    if (o < len) out[o++] = n & 0xff;
  }
  return out;
}

/**
 * Turn a snapshot into something `JSON.stringify` cannot damage. Plain values
 * pass through untouched, so the result stays readable for everything that is
 * not a buffer.
 */
export function encode(v) {
  if (v == null || typeof v !== 'object') return v;
  const tag = TAGS.get(v.constructor);
  if (tag) {
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return { $t: tag, d: toB64(bytes) };
  }
  if (Array.isArray(v)) return v.map(encode);
  // An encoded buffer being re-encoded would nest forever; treat it as opaque.
  if (typeof v.$t === 'string') return v;
  const out = {};
  for (const k of Object.keys(v)) {
    const e = encode(v[k]);
    // `undefined` is dropped by JSON anyway; dropping it here makes the encoded
    // form and the decoded form agree on which keys exist.
    if (e !== undefined) out[k] = e;
  }
  return out;
}

/** The inverse. Anything not carrying a `$t` tag is returned as it arrived. */
export function decode(v) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decode);
  if (typeof v.$t === 'string' && typeof v.d === 'string') {
    const C = CTORS[v.$t];
    if (!C) throw new Error(`snapjson: unknown buffer tag "${v.$t}"`);
    const bytes = fromB64(v.d);
    return C === Uint8Array ? bytes
      : new C(bytes.buffer, bytes.byteOffset, bytes.byteLength / C.BYTES_PER_ELEMENT);
  }
  const out = {};
  for (const k of Object.keys(v)) out[k] = decode(v[k]);
  return out;
}

/** `stringify(snap)` / `parse(text)` — the pair callers actually want. */
export const stringify = (snap, space) => JSON.stringify(encode(snap), null, space);
export const parse = (text) => decode(JSON.parse(text));
