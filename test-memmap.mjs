// memmap — sanity for the annotated memory maps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAPS, regionAt, pinPresets, estimateUnused } from './memmap.js';

test('memmap: regions are ordered, non-overlapping, and tagged', () => {
  for (const [machine, map] of Object.entries(MAPS)) {
    let prev = -1;
    for (const r of map) {
      assert.ok(r.start <= r.end, `${machine} ${r.name} range`);
      assert.ok(r.start > prev, `${machine} ${r.name} overlaps previous`);
      assert.ok(['verified', 'documented', 'approx'].includes(r.confidence));
      assert.ok(r.desc.length > 0);
      prev = r.end;
    }
  }
});

test('memmap: the places this repo actually walked resolve correctly', () => {
  assert.equal(regionAt('pc8801', 0xf3c8).name, 'text VRAM');
  assert.equal(regionAt('pc8801', 0xedf3).kind, 'hooks');
  assert.equal(regionAt('pc8801', 0xef14).name, 'disk BASIC work');
  assert.equal(regionAt('pc8801', 0xf302).kind, 'vectors');
  assert.equal(regionAt('pc8801', 0xecb4).name, 'disk/boot work');
  assert.equal(regionAt('pc8001', 0xf3c8).name, 'text VRAM');
  assert.equal(regionAt('pc8001', 0x0038).kind, 'rom');
  assert.equal(regionAt('pc8001', 0x9000).kind, 'user');
});

test('memmap: pin presets exclude only user regions', () => {
  for (const machine of Object.keys(MAPS)) {
    const pins = pinPresets(machine);
    assert.ok(pins.every((r) => r.kind !== 'user'));
    assert.ok(pins.some((r) => r.kind === 'vram'), `${machine} pins VRAM`);
  }
});

test('memmap: unused estimation, blank and with coverage', () => {
  // no coverage: the whole user region is "unused"
  const blank = estimateUnused('pc8801');
  assert.ok(blank.some((r) => r.start === 0x8400 && r.end === 0xe4ff));

  // coverage: touch a hole in the middle, the run splits
  const cov = new Uint8Array(0x10000);
  cov.fill(1, 0xa000, 0xa100);
  const runs = estimateUnused('pc8801', cov);
  assert.ok(runs.some((r) => r.end === 0x9fff));
  assert.ok(runs.some((r) => r.start === 0xa100));
  assert.ok(!runs.some((r) => r.start <= 0xa050 && r.end >= 0xa050));
});
