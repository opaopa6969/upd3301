// resultdiff — the pure part of the termination comparison (tools/results.mjs).
// No ROM, no disk, no refdrv: these run everywhere, which is the point. A
// contract test that can skip, will (see docs/lessons-from-the-parity-run.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRefdrvResults, tally, diffTallies, disagreement, describeStatus, statusKey, formatDiff,
} from './resultdiff.js';

// Verbatim refdrv output, including the surrounding noise it really emits.
const SAMPLE = `# hooks follow the SUB cpu (CPU2)
f47   RESULT ST[00 00 00] C0 H0 R1 N1
f51   RESULT ST[40 80 00] C1 H0 R1 N1
f51   RESULT ST[44 80 00] C1 H1 R1 N1
f60   RESULT ST[00 00 00] C0 H0 R2 N1
# M88 total FDC data bytes served to sub: 12345
`;

test('parses refdrv result lines and ignores everything else', () => {
  const r = parseRefdrvResults(SAMPLE);
  assert.equal(r.length, 4);
  assert.deepEqual(r[1], { st0: 0x40, st1: 0x80, st2: 0, c: 1, h: 0, r: 1, n: 1 });
});

test('a changed refdrv format yields nothing rather than something wrong', () => {
  // The failure this guards against: a silent detector. If refdrv's wording ever
  // changes, every title must come back "0 results" so the tool can complain —
  // never a partial parse that reads as agreement.
  assert.equal(parseRefdrvResults('f47 RESULT ST 00 00 00 C0 H0 R1 N1').length, 0);
  assert.equal(parseRefdrvResults('').length, 0);
});

test('tally counts by status pair, not by full result', () => {
  const t = tally(parseRefdrvResults(SAMPLE));
  assert.equal(t.get('00 00'), 2); // same status, different R — one bucket
  assert.equal(t.get('40 80'), 1);
  assert.equal(t.get('44 80'), 1);
});

test('diff reports both sides and is ordered by |delta|, then key', () => {
  const ref = tally([{ st0: 0x00, st1: 0x00 }, { st0: 0x40, st1: 0x80 }, { st0: 0x40, st1: 0x02 }]);
  const ours = tally([{ st0: 0x00, st1: 0x00 }, { st0: 0x40, st1: 0x80 }, { st0: 0x40, st1: 0x80 }]);
  const rows = diffTallies(ref, ours);
  assert.equal(rows[0].key, '40 02'); // |−1| ties with '40 80', '40 02' sorts first
  assert.equal(rows[0].ref, 1);
  assert.equal(rows[0].ours, 0);
  assert.equal(rows[0].delta, -1);
  assert.equal(rows.find((r) => r.key === '00 00').delta, 0);
});

test('the order does not depend on insertion order', () => {
  const a = diffTallies(tally([{ st0: 1, st1: 2 }, { st0: 3, st1: 4 }]), tally([]));
  const b = diffTallies(tally([{ st0: 3, st1: 4 }, { st0: 1, st1: 2 }]), tally([]));
  assert.deepEqual(a.map((r) => r.key), b.map((r) => r.key));
});

test('disagreement sums absolute deltas, so a swap scores two', () => {
  // Two extra abnormal endings and two fewer normal ones is a bigger problem
  // than being off by one, and has to outrank it.
  const ref = tally([{ st0: 0, st1: 0 }, { st0: 0, st1: 0 }]);
  const ours = tally([{ st0: 0x40, st1: 0x80 }, { st0: 0x40, st1: 0x80 }]);
  assert.equal(disagreement(diffTallies(ref, ours)), 4);
  const one = diffTallies(tally([{ st0: 0, st1: 0 }]), tally([]));
  assert.equal(disagreement(one), 1);
});

test('identical tallies score zero', () => {
  const t = () => tally(parseRefdrvResults(SAMPLE));
  assert.equal(disagreement(diffTallies(t(), t())), 0);
});

test('status pairs are described in words, with the ST1 bits kept straight', () => {
  assert.match(describeStatus(0x40, 0x80), /abnormal/);
  assert.match(describeStatus(0x40, 0x80), /EN \(end of cylinder\)/);
  assert.match(describeStatus(0x44, 0x80), /HD1/);
  assert.match(describeStatus(0x00, 0x00), /^normal, US0 HD0$/);
  // bit 2 is ND and bit 1 is NW — the pair that is easiest to swap by eye
  assert.match(describeStatus(0x40, 0x04), /ND \(no data\)/);
  assert.doesNotMatch(describeStatus(0x40, 0x04), /NW/);
  assert.match(describeStatus(0x40, 0x02), /NW \(not writable\)/);
  assert.doesNotMatch(describeStatus(0x40, 0x02), /ND/);
});

test('statusKey is the stable two-byte hex form', () => {
  assert.equal(statusKey(0x40, 0x80), '40 80');
  assert.equal(statusKey(0, 0), '00 00');
  assert.equal(statusKey(0x140, 0x02), '40 02'); // masked to a byte
});

test('formatDiff marks the rows that differ', () => {
  const rows = diffTallies(tally([{ st0: 0x40, st1: 0x02 }]), tally([{ st0: 0, st1: 0 }]));
  const text = formatDiff(rows, { refName: 'M88', oursName: 'ours' });
  assert.match(text, /ST0 ST1/);
  for (const line of text.split('\n').slice(1)) assert.match(line, /^\s{2}\*/); // both rows differ
});
