// reachdiff's rules, tested against the case that motivated it.
//
// ROM-free: the module is pure set arithmetic. The tool that fills the sets
// (tools/reach.mjs) needs refdrv and disks; this does not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regions, reachDiff, format } from './reachdiff.js';

test('scattered addresses in one routine become one region', () => {
  // A trace records instruction starts, so a 40-byte routine shows up as a
  // dozen addresses with gaps. Reporting them individually buries the finding.
  const r = regions([0x52a9, 0x52b1, 0x52c7, 0x52d5, 0x52e2, 0x52ee]);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].lo, r[0].hi, r[0].count], [0x52a9, 0x52ee, 6]);
});

test('one routine stays whole, and separate ones stay separate', () => {
  // Measured on JIKO_PZL: 1009-1073 is a single routine reported as 19
  // instruction starts across 106 bytes, while 30a9 is somewhere else entirely.
  const r = regions([0x1009, 0x103d, 0x1073, 0x30a9]);
  assert.equal(r.length, 2, '1009..1073 is one routine; 30a9 is not part of it');
  assert.deepEqual([r[0].lo, r[0].hi], [0x1009, 0x1073]);
  assert.equal(r[1].lo, 0x30a9);
});

test('what each side ran alone, and where we first went our own way', () => {
  // JIKO_PZL, measured 2026-08-12 over 320 frames: 2,872 addresses shared, we
  // enter a region at f20 that M88 never touches, and M88 runs code we never
  // reach. Before this the same question was asked one address at a time —
  // four refdrv runs to learn one fact.
  const ours = new Set([0x100, 0x101, 0x3a85, 0x3dca, 0x52d5]);
  const ref = new Set([0x100, 0x101, 0x0020, 0x3f4c]);
  const first = new Map([[0x3a85, 20], [0x3dca, 20], [0x52d5, 292]]);
  const d = reachDiff(ours, ref, first);

  assert.equal(d.shared, 2);
  assert.equal(d.onlyOurs.length, 3);
  assert.equal(d.onlyRef.length, 2);
  assert.equal(d.firstExclusive.firstFrame, 20, 'the earliest exclusive region is the one to open');
  assert.equal(d.firstExclusive.lo, 0x3a85);
});

test('with no frame map it still says what differs, just not when', () => {
  const d = reachDiff([1, 2, 3], [2, 3, 4]);
  assert.equal(d.shared, 2);
  assert.equal(d.onlyOurs[0].lo, 1);
  assert.equal(d.onlyRef[0].lo, 4);
  assert.equal(d.firstExclusive, null, 'no frames means no earliest');
});

test('identical runs report nothing exclusive', () => {
  // The expected result for a title that matches: the interesting output is
  // empty, and it has to be visibly empty rather than an error.
  const d = reachDiff([1, 2, 3], [1, 2, 3]);
  assert.equal(d.shared, 3);
  assert.deepEqual(d.onlyOurs, []);
  assert.deepEqual(d.onlyRef, []);
  assert.equal(d.firstExclusive, null);
});

test('the summary names the earliest divergence, not just the biggest', () => {
  // A later region can be far larger — it is downstream of the branch, so
  // opening it first wastes the investigation.
  const ours = new Set([0x200, 0x900, 0x901, 0x902, 0x903]);
  const first = new Map([[0x200, 5], [0x900, 400], [0x901, 400], [0x902, 400], [0x903, 400]]);
  const d = reachDiff(ours, new Set([0x100]), first);
  assert.equal(d.firstExclusive.lo, 0x200);
  assert.match(format(d), /earliest divergence: we enter 0200/);
});
