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
