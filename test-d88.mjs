import test from 'node:test';
import assert from 'node:assert/strict';
import { parseD88, parseD88All, buildD88, findSector, summarize } from './d88.js';

// a plain 2D disk: 40 cylinders x 2 heads x 16 sectors x 256 bytes
function plainDisk(name = 'TEST DISK') {
  const tracks = [];
  for (let t = 0; t < 80; t++) {
    const c = t >> 1, h = t & 1;
    tracks.push(Array.from({ length: 16 }, (_, i) => ({
      c, h, r: i + 1, n: 1,
      data: new Uint8Array(256).fill((c + h + i) & 0xff),
    })));
  }
  return buildD88({ name, media: 0x00, tracks });
}

test('D88: round-trip build → parse', () => {
  const img = plainDisk();
  const d = parseD88(img);
  assert.equal(d.name, 'TEST DISK');
  assert.equal(d.media, '2D');
  assert.equal(d.writeProtect, false);
  assert.equal(d.diskSize, img.length);
  const used = d.tracks.filter(Boolean);
  assert.equal(used.length, 80);
  assert.equal(used[0].sectors.length, 16);
  assert.equal(used[0].sectors[0].size, 256);
});

test('D88: FDC-style sector lookup by C/H/R', () => {
  const d = parseD88(plainDisk());
  const s = findSector(d, 5, 1, 3);
  assert.ok(s, 'sector found');
  assert.equal(s.c, 5); assert.equal(s.h, 1); assert.equal(s.r, 3);
  assert.equal(s.data[0], (5 + 1 + 2) & 0xff);
  assert.equal(findSector(d, 5, 1, 99), null, 'missing sector → null (FDC: no data)');
  assert.equal(findSector(d, 60, 0, 1), null, 'unformatted track → null');
});

test('D88: summary reports geometry', () => {
  const s = summarize(parseD88(plainDisk()));
  assert.equal(s.tracks, 80);
  assert.equal(s.sectors, 80 * 16);
  assert.equal(s.bytes, 80 * 16 * 256);
  assert.deepEqual(s.sectorSizes, [256]);
  assert.deepEqual(s.oddities, []);
});

test('D88: copy protection survives — bad status, deleted data, duplicate IDs', () => {
  const tracks = [];
  tracks[0] = [
    { c: 0, h: 0, r: 1, n: 1, data: new Uint8Array(256), status: 0xb0 }, // CRC error
    { c: 0, h: 0, r: 1, n: 1, data: new Uint8Array(256) }, // duplicate ID
    { c: 0, h: 0, r: 2, n: 1, data: new Uint8Array(256), deleted: true },
    { c: 0, h: 0, r: 3, n: 0, data: new Uint8Array(128), density: 0x40 }, // FM, 128B
  ];
  const d = parseD88(buildD88({ name: 'PROTECTED', tracks }));
  const s = summarize(d);
  assert.ok(s.oddities.includes('bad-status sectors'));
  assert.ok(s.oddities.includes('deleted data'));
  assert.ok(s.oddities.includes('duplicate sector IDs'));
  assert.ok(s.oddities.includes('FM (single density)'));
  assert.deepEqual(s.sectorSizes, [128, 256]);
  const t = d.tracks[0];
  assert.equal(t.sectors[0].status, 0xb0, 'the FDC will report this as an error');
  assert.equal(t.sectors[2].deleted, true);
});

test('D88: multi-disk images chain', () => {
  const a = plainDisk('DISK A');
  const b = plainDisk('DISK B');
  const both = new Uint8Array(a.length + b.length);
  both.set(a, 0); both.set(b, a.length);
  const disks = parseD88All(both);
  assert.equal(disks.length, 2);
  assert.equal(disks[0].name, 'DISK A');
  assert.equal(disks[1].name, 'DISK B');
});

test('D88: parsing is deterministic', () => {
  const img = plainDisk();
  assert.deepEqual(summarize(parseD88(img)), summarize(parseD88(img)));
});
