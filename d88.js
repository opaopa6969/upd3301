// d88 — the PC-88/98 world's floppy image format.
//
// A D88 is a flat dump of a disk *as the FDC sees it*: not a filesystem, but
// tracks of sectors, each sector carrying its own ID (C,H,R,N), density, a
// deleted-data flag and a status byte. That is exactly what a μPD765 needs
// to answer READ DATA / READ ID, which is why copy-protected disks survive
// in this format — bad sectors, duplicate IDs and odd sector sizes are all
// representable.
//
// Layout:
//   0x00  17 bytes  name (SJIS, NUL-padded)
//   0x11   9 bytes  reserved
//   0x1A   1 byte   write protect (0x10 = protected)
//   0x1B   1 byte   media type (0x00 2D, 0x10 2DD, 0x20 2HD)
//   0x1C   4 bytes  disk size (LE)
//   0x20  164×4     track table: file offset of each track (0 = no track)
//   ...            sectors, each: C,H,R,N, count(LE16), density, deleted,
//                  status, 5 reserved, size(LE16), then `size` data bytes
//
// Pure, deterministic, zero deps. A parsed image is plain data — the FDC
// model (or a tool) decides what to do with it.

export const SCHEMA_VERSION = 1;

export const MEDIA = Object.freeze({ 0x00: '2D', 0x10: '2DD', 0x20: '2HD' });
const HEADER_SIZE = 0x2b0; // 0x20 + 164*4
const TRACKS = 164;

const dec = (bytes) => {
  let s = '';
  for (const b of bytes) {
    if (b === 0) break;
    s += b < 0x80 ? String.fromCharCode(b) : '.'; // SJIS names: ASCII only, rest dotted
  }
  return s;
};

// Parse a D88 (or the first image of a multi-image .d88) into plain data.
export function parseD88(bytes, offset = 0) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (o) => offset + o;
  if (bytes.length - offset < HEADER_SIZE) throw new Error('too short for a D88 header');

  const name = dec(bytes.subarray(at(0), at(17)));
  const writeProtect = bytes[at(0x1a)] === 0x10;
  const mediaByte = bytes[at(0x1b)];
  const diskSize = dv.getUint32(at(0x1c), true);
  if (diskSize < HEADER_SIZE || offset + diskSize > bytes.length + 1) {
    throw new Error(`bad disk size ${diskSize}`);
  }

  const tracks = [];
  let maxEnd = HEADER_SIZE;
  for (let t = 0; t < TRACKS; t++) {
    const tOff = dv.getUint32(at(0x20 + t * 4), true);
    if (!tOff) { tracks.push(null); continue; }
    const sectors = [];
    let p = offset + tOff;
    let count = 1;
    for (let i = 0; i < count; i++) {
      if (p + 16 > bytes.length) break;
      const c = bytes[p], h = bytes[p + 1], r = bytes[p + 2], n = bytes[p + 3];
      count = dv.getUint16(p + 4, true) || 1;
      const density = bytes[p + 6]; // 0x00 = MFM (double), 0x40 = FM (single)
      const deleted = bytes[p + 7] === 0x10;
      const status = bytes[p + 8];
      const size = dv.getUint16(p + 14, true);
      const data = bytes.subarray(p + 16, p + 16 + size);
      sectors.push({ c, h, r, n, density, deleted, status, size, data });
      p += 16 + size;
      if (i === 0 && count === 0) break;
    }
    maxEnd = Math.max(maxEnd, p - offset);
    tracks.push({ index: t, cylinder: t >> 1, head: t & 1, sectors });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    name, writeProtect,
    media: MEDIA[mediaByte] ?? `0x${mediaByte.toString(16)}`,
    mediaByte, diskSize, tracks,
    nextOffset: offset + diskSize, // multi-image D88s chain
  };
}

// All images in a (possibly multi-disk) file.
export function parseD88All(bytes) {
  const disks = [];
  let off = 0;
  while (off + HEADER_SIZE <= bytes.length) {
    const d = parseD88(bytes, off);
    disks.push(d);
    if (d.nextOffset <= off) break;
    off = d.nextOffset;
  }
  return disks;
}

// FDC-side lookup: find a sector by its ID on a given track.
export function findSector(disk, cylinder, head, r, n = null) {
  const t = disk.tracks[cylinder * 2 + head];
  if (!t) return null;
  return t.sectors.find((s) => s.r === r && (n === null || s.n === n)) ?? null;
}

// Human summary — what a tool (or the demo) shows about a mounted disk.
export function summarize(disk) {
  const used = disk.tracks.filter(Boolean);
  const sectors = used.reduce((a, t) => a + t.sectors.length, 0);
  const bytes = used.reduce((a, t) => a + t.sectors.reduce((b, s) => b + s.size, 0), 0);
  const sizes = [...new Set(used.flatMap((t) => t.sectors.map((s) => 128 << s.n)))].sort((a, b) => a - b);
  const oddities = [];
  if (used.some((t) => t.sectors.some((s) => s.status !== 0))) oddities.push('bad-status sectors');
  if (used.some((t) => t.sectors.some((s) => s.deleted))) oddities.push('deleted data');
  if (used.some((t) => new Set(t.sectors.map((s) => s.r)).size !== t.sectors.length)) {
    oddities.push('duplicate sector IDs');
  }
  if (used.some((t) => t.sectors.some((s) => s.density === 0x40))) oddities.push('FM (single density)');
  return {
    schemaVersion: SCHEMA_VERSION,
    name: disk.name, media: disk.media, writeProtect: disk.writeProtect,
    tracks: used.length, sectors, bytes, sectorSizes: sizes,
    oddities, // copy protection lives here
  };
}

// Build a D88 (used by tests and by anything that wants to author a disk).
export function buildD88({ name = '', media = 0x00, writeProtect = false, tracks = [] } = {}) {
  const trackBlobs = tracks.map((sectors) => {
    if (!sectors || !sectors.length) return null;
    const parts = sectors.map((s) => {
      const size = s.data.length;
      const buf = new Uint8Array(16 + size);
      const dv = new DataView(buf.buffer);
      buf[0] = s.c; buf[1] = s.h; buf[2] = s.r; buf[3] = s.n ?? 1;
      dv.setUint16(4, sectors.length, true);
      buf[6] = s.density ?? 0x00;
      buf[7] = s.deleted ? 0x10 : 0x00;
      buf[8] = s.status ?? 0x00;
      dv.setUint16(14, size, true);
      buf.set(s.data, 16);
      return buf;
    });
    const total = parts.reduce((a, p) => a + p.length, 0);
    const blob = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { blob.set(p, o); o += p.length; }
    return blob;
  });

  const bodySize = trackBlobs.reduce((a, b) => a + (b ? b.length : 0), 0);
  const out = new Uint8Array(HEADER_SIZE + bodySize);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < Math.min(16, name.length); i++) out[i] = name.charCodeAt(i) & 0x7f;
  out[0x1a] = writeProtect ? 0x10 : 0x00;
  out[0x1b] = media;
  dv.setUint32(0x1c, out.length, true);
  let o = HEADER_SIZE;
  for (let t = 0; t < TRACKS; t++) {
    const blob = trackBlobs[t];
    if (!blob) continue;
    dv.setUint32(0x20 + t * 4, o, true);
    out.set(blob, o);
    o += blob.length;
  }
  return out;
}
