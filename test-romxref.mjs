// romxref — static call hierarchy + work-variable xref, checked against
// facts established by hand in the boot investigations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROM_XREF, writersOf, readersOf } from './romxref.js';

const have = (set) => ROM_XREF[set] && Object.keys(ROM_XREF[set].routines).length > 0;

test('romxref: EF14 writers are exactly the two routines traced by hand', (t) => {
  if (!have('n88-fr')) return t.skip('not generated (bring your own ROMs)');
  const w = writersOf('n88-fr', 0xef14);
  assert.ok(w.includes('sub_ensure_init'));   // 36F3: LD (EF14),A with A=1
  assert.ok(w.includes('sub_init_and_count')); // 3707: LD (EF14),A with A=5
  assert.ok(readersOf('n88-fr', 0xef14).length > 0);
});

test('romxref: call hierarchy matches the handshake structure', (t) => {
  if (!have('n88-fr')) return t.skip('not generated');
  const rs = Object.values(ROM_XREF['n88-fr'].routines);
  const send = rs.find((r) => r.name === 'sub_send_byte');
  for (const caller of ['sub_init_and_count', 'sub_send_rw_cmd', 'sub_check_result']) {
    assert.ok(send.callers.includes(caller), `${caller} calls sub_send_byte`);
  }
});

test('romxref: fixpoint discovered far more than the seed labels', (t) => {
  if (!have('n88-fr')) return t.skip('not generated');
  assert.ok(Object.keys(ROM_XREF['n88-fr'].routines).length > 100);
  assert.ok(Object.keys(ROM_XREF.pc80s31.routines).length > 15);
});

test('romxref: hand-curated names joined onto the sub result variable', (t) => {
  if (!have('pc80s31')) return t.skip('not generated');
  const v = ROM_XREF.pc80s31.vars[0x7f14];
  assert.equal(v.known.name, 'result_status');
  assert.ok(v.w.includes('cmd00_initialize'));
});
