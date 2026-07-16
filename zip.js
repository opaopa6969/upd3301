// Minimal ZIP reader — pure JS, no dependencies. Parses the archive and inflates
// DEFLATE members with the platform's DecompressionStream (present in modern
// browsers and Node ≥ 18), so there is no bundled inflate code and nothing to
// fetch (Artifact/CSP-safe). Store (method 0) and DEFLATE (method 8) are
// supported; other methods are skipped. Truncated/corrupt members are skipped
// (best-effort), so one bad file doesn't sink the rest.
//
// Filenames: UTF-8 when the archive flags it (bit 11), otherwise decoded as
// Shift-JIS — retro PC-88 archives are almost always CP932. The raw bytes are
// kept on `.rawName` if a caller wants to re-decode.
//
// Usage:  const entries = await unzip(uint8);   // [{ name, bytes }]
//         const imgs    = await unzipImages(uint8); // disk/tape only, big-first
//
// This exists so a .zip full of .d88 / .t88 images "just works": unzip it, hand
// the disk/tape files to the normal loaders, and if there is more than one let
// the user pick.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

const SIG_EOCD = 0x06054b50;
const SIG_CEN  = 0x02014b50;
const SIG_LOC  = 0x04034b50;

const utf8 = new TextDecoder('utf-8', { fatal: false });
let sjis = null; // TextDecoder('shift_jis') is available in browsers and Node
try { sjis = new TextDecoder('shift_jis', { fatal: false }); } catch { sjis = utf8; }
function decodeName(raw, flags) {
  return (flags & 0x800) ? utf8.decode(raw) : sjis.decode(raw); // bit 11 = UTF-8
}

function findEOCD(b) {
  const min = 22;
  if (b.length < min) return -1;
  const start = Math.max(0, b.length - min - 0xffff);
  for (let i = b.length - min; i >= start; i--) {
    if (u32(b, i) === SIG_EOCD) return i;
  }
  return -1;
}

async function inflateRaw(compressed) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(compressed).body.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// pull one member's bytes given its local-header offset; null on any problem
async function readMember(b, locOff) {
  if (u32(b, locOff) !== SIG_LOC) return null;
  const flags   = u16(b, locOff + 6);
  const method  = u16(b, locOff + 8);
  let compSize  = u32(b, locOff + 18);
  const nameLen = u16(b, locOff + 26);
  const extraLen = u16(b, locOff + 28);
  const rawName = b.subarray(locOff + 30, locOff + 30 + nameLen);
  const name    = decodeName(rawName, flags);
  if (name.endsWith('/')) return { name, skip: true };
  const dataOff = locOff + 30 + nameLen + extraLen;
  if (!compSize && (flags & 0x08)) compSize = b.length - dataOff; // streamed size unknown → take the rest
  const comp = b.subarray(dataOff, dataOff + compSize);
  try {
    let data;
    if (method === 0) data = comp.slice();
    else if (method === 8) data = await inflateRaw(comp);
    else return { name, skip: true };
    return { name, rawName: rawName.slice(), bytes: data, next: dataOff + compSize };
  } catch { return { name, skip: true, next: dataOff + compSize }; } // truncated/bad member
}

// Parse a ZIP → [{ name, rawName, bytes }]. Prefers the central directory;
// falls back to walking local headers when it's missing (some streamed zips).
export async function unzip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 4 || u32(b, 0) !== SIG_LOC) throw new Error('not a ZIP (no PK local header)');
  const out = [];
  const eocd = findEOCD(b);
  if (eocd >= 0) {
    const count = u16(b, eocd + 10);
    let p = u32(b, eocd + 16);
    for (let i = 0; i < count && u32(b, p) === SIG_CEN; i++) {
      const nameLen = u16(b, p + 28), extraLen = u16(b, p + 30), cmtLen = u16(b, p + 32);
      const locOff = u32(b, p + 42);
      p += 46 + nameLen + extraLen + cmtLen;
      const m = await readMember(b, locOff);
      if (m && !m.skip) out.push(m);
    }
    if (out.length) return out;
  }
  // fallback: no usable central directory — walk local file headers in order
  let o = 0;
  while (o + 30 <= b.length && u32(b, o) === SIG_LOC) {
    const m = await readMember(b, o);
    if (!m) break;
    if (!m.skip && m.bytes) out.push(m);
    if (!m.next || m.next <= o) break;
    o = m.next;
  }
  return out;
}

// Disk / tape image extensions we know how to hand to a loader downstream.
export const DISK_TAPE_RE = /\.(d88|88d|d8u|hdm|tfd|xdf|t88|cas|cmt|n80)$/i;

// unzip, keep only disk/tape images, largest-first (the game is usually the
// biggest member; readmes/loaders sort last).
export async function unzipImages(bytes) {
  const all = await unzip(bytes);
  return all.filter((e) => DISK_TAPE_RE.test(e.name))
            .sort((a, b) => b.bytes.length - a.bytes.length);
}
