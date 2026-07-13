// romlabels — the annotation DB for ROM internals earned in boot debugging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROM_LABELS, labelMap, commentFor } from './romlabels.js';

test('romlabels: every entry is bilingual and confidence-tagged', () => {
  for (const [name, set] of Object.entries(ROM_LABELS)) {
    assert.ok(set.title && set.note.ja && set.note.en, name);
    const seen = new Set();
    for (const l of set.labels) {
      assert.ok(!seen.has(l.addr), `${name} duplicate ${l.addr.toString(16)}`);
      seen.add(l.addr);
      assert.match(l.name, /^[a-z0-9_]+$/, `${name} ${l.name} asm-safe`);
      assert.ok(l.comment.ja.length > 0 && l.comment.en.length > 0);
      assert.ok(['verified', 'documented', 'approx'].includes(l.confidence));
    }
  }
});

test('romlabels: lookup and language fallback (ja default)', () => {
  const m = labelMap('n88-fr');
  assert.equal(m.get(0x37c9).name, 'sub_send_byte');
  assert.ok(commentFor(m.get(0x37c9)).includes('ATN')); // ja default
  assert.ok(commentFor(m.get(0x37c9), 'en').includes('ATN'));
  assert.equal(commentFor(m.get(0x37c9), 'fr'), commentFor(m.get(0x37c9), 'ja'));
  assert.equal(labelMap('nope').size, 0);
});

test('romlabels: the remote-execute discovery is recorded', () => {
  const m = labelMap('pc80s31');
  assert.equal(m.get(0x05da).name, 'cmd1b_remote_exec');
  assert.ok(commentFor(m.get(0x05da), 'en').includes('remote'));
});

test('romlabels: generated meta carries machine-verified facts', () => {
  const m = labelMap('n88-fr');
  const dip = m.get(0x36db).meta;
  if (!dip) return; // meta not generated without ROMs — the DB still works
  // IN A,(40h); AND 8; XOR 8; RET = 11+7+7+10 T-states, clobbers A+F only
  assert.deepEqual(dip.clobbers, ['A', 'F']);
  assert.equal(dip.tStates.min, 35);
  assert.ok(dip.io.some((x) => x.dir === 'in' && x.port === 0x40));

  // the sweep stops at the unconditional JP inside the wait loop, so this
  // routine's meta shows the handshake ports (C-bit ops via FFh, poll via
  // FEh) — an honest under-approximation, not a guess
  const send = m.get(0x37c9).meta;
  assert.ok(send.io.some((x) => x.dir === 'out' && x.port === 0xff), 'BSR via FFh');
  assert.ok(send.io.some((x) => x.dir === 'in' && x.port === 0xfe), 'handshake via FEh');

  const sub = labelMap('pc80s31');
  const motor = sub.get(0x02b4).meta;
  assert.ok(motor.tStates.loop, 'the settle delay is a loop');
});
