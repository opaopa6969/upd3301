// resultdiff — compare how each emulator ENDS its FDC commands.
//
// The 353-title sweep compares a screen fingerprint: `ram[0xE6CD]` plus the
// non-zero byte counts of text and graphics RAM. That is memory, and memory is
// not everything a chip does. A command that should have ended abnormally but
// ended normally leaves the same bytes behind if the driver was not looking —
// which is exactly how "EOT is unreachable on this board" survived as a belief
// for three days while 316 titles reached it 3,934 times (issue #40).
//
// The result phase is where that difference is visible, and both sides already
// expose it:
//
//   * M88: refdrv prints every result phase, unmodified, as
//         f1234 RESULT ST[40 80 00] C1 H0 R1 N1
//   * ours: upd765.js hands the same seven bytes to `_results`
//
// So the two can be tallied into the same shape and subtracted. This module is
// the pure part: parse, tally, diff, and say in words what a status pair means.
// The tool that runs both emulators lives in tools/results.mjs.
//
// A worked example, Aggres at 1500 frames — the EOC columns agree exactly while
// `40 02` shows up only on M88's side, which is the next thread to pull:
//
//     ST0 ST1     M88   ours
//     00 00        15     18
//     04 00        10     10
//     40 80         5      5     <- End of Cylinder
//     44 80         4      6     <- End of Cylinder, HD=1
//     40 02         4      0
//     40 04         2      2
//
// Pure, dependency-free, deterministic.

export const SCHEMA_VERSION = 1;

const hex2 = (v) => (v & 0xff).toString(16).padStart(2, '0');

/** Key a result by its two status bytes — the part that says HOW it ended. */
export function statusKey(st0, st1) {
  return `${hex2(st0)} ${hex2(st1)}`;
}

// ST0 bits 7-6 hold IC (interrupt code). Everything else in ST0 is unit/head.
const IC_NAMES = ['normal', 'abnormal', 'invalid command', 'abnormal (ready changed)'];

/**
 * Put a status pair into words. Kept here, tested, and used by the CLI so a
 * table of hex never has to be decoded by hand — misreading ST1 bit 2 (ND) as
 * bit 1 (NW) is a five-minute detour every single time.
 */
export function describeStatus(st0, st1) {
  const flags = [];
  if (st1 & 0x80) flags.push('EN (end of cylinder)');
  if (st1 & 0x20) flags.push('DE (data error)');
  if (st1 & 0x10) flags.push('OR (overrun)');
  if (st1 & 0x04) flags.push('ND (no data)');
  if (st1 & 0x02) flags.push('NW (not writable)');
  if (st1 & 0x01) flags.push('MA (missing address mark)');
  const head = (st0 >> 2) & 1;
  const unit = st0 & 3;
  const ic = IC_NAMES[(st0 >> 6) & 3];
  return `${ic}, US${unit} HD${head}${flags.length ? ', ' + flags.join(', ') : ''}`;
}

/**
 * Pull result phases out of refdrv's stdout.
 *
 * refdrv prints one line per result phase and nothing else shares the format,
 * so a strict regex is both enough and a detector: if a future refdrv changes
 * its wording this returns an empty list rather than a wrong one, and the CLI
 * says so instead of reporting "no differences".
 */
export function parseRefdrvResults(text) {
  const out = [];
  const re = /RESULT ST\[([0-9a-f]{2}) ([0-9a-f]{2}) ([0-9a-f]{2})\] C(\d+) H(\d+) R(\d+) N(\d+)/g;
  for (const m of text.matchAll(re)) {
    out.push({
      st0: parseInt(m[1], 16), st1: parseInt(m[2], 16), st2: parseInt(m[3], 16),
      c: +m[4], h: +m[5], r: +m[6], n: +m[7],
    });
  }
  return out;
}

/** Count results per status pair. Input: [{st0, st1, ...}] */
export function tally(results) {
  const t = new Map();
  for (const r of results) {
    const k = statusKey(r.st0, r.st1);
    t.set(k, (t.get(k) ?? 0) + 1);
  }
  return t;
}

/**
 * Subtract two tallies.
 *
 * Sorted by |delta| descending, then by key, so the biggest disagreement is the
 * first line of output and the order never depends on Map insertion — two runs
 * of the same data print identically, which is what makes this diffable.
 */
export function diffTallies(refTally, oursTally) {
  const keys = new Set([...refTally.keys(), ...oursTally.keys()]);
  const rows = [...keys].map((key) => {
    const ref = refTally.get(key) ?? 0;
    const ours = oursTally.get(key) ?? 0;
    const [st0, st1] = key.split(' ').map((h) => parseInt(h, 16));
    return { key, ref, ours, delta: ours - ref, meaning: describeStatus(st0, st1) };
  });
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}

/**
 * Total disagreement across a diff: the sum of |delta|.
 *
 * Deliberately NOT "do the tallies match" — a title where we return two extra
 * abnormal terminations and two fewer normal ones scores 4, not 1, and should
 * outrank a title that is off by one. This is the number to watch across a
 * change; zero means the two sides ended every command the same way.
 */
export function disagreement(rows) {
  return rows.reduce((a, r) => a + Math.abs(r.delta), 0);
}

/** Render a diff as the fixed-width table used in issue comments and docs. */
export function formatDiff(rows, { refName = 'M88', oursName = 'ours' } = {}) {
  const lines = [`    ST0 ST1   ${refName.padStart(6)} ${oursName.padStart(6)}   meaning`];
  for (const r of rows) {
    const mark = r.delta === 0 ? ' ' : '*';
    lines.push(`  ${mark} ${r.key}     ${String(r.ref).padStart(6)} ${String(r.ours).padStart(6)}   ${r.meaning}`);
  }
  return lines.join('\n');
}
