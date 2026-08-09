// analysisdb — the shared analysis format (issue #39). No ROM is needed for any
// of this: the format is about claims and evidence, not about ROM bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SCHEMA_VERSION, CONFIDENCE, confidenceRank, hashBytes, normalizeAddr,
  normalizeRomHash, compareRomHash, createDoc, validate, assertValid,
  parse, stringify, merge, mergeAll, openTails, fromLabelMap, toLabelMap, fromRngCallers,
} from './analysisdb.js';

const ROM = 'sha256:' + 'ab'.repeat(32);
const ROM2 = 'sha256:' + 'cd'.repeat(32);

const base = (extra = {}) => createDoc({
  machine: 'pc8801', title: 't', romHash: ROM,
  unclassified: ['6F1A: read but never compared'], ...extra,
});
const obs = (name, samples = 10, extra = {}) =>
  ({ name, confidence: 'observed', evidence: { samples, ...extra } });

// ---- addresses / hashes -----------------------------------------------------
test('addresses normalize to canonical uppercase hex, junk is refused', () => {
  assert.equal(normalizeAddr('5a3c'), '5A3C');
  assert.equal(normalizeAddr('0x5A3C'), '5A3C');
  assert.equal(normalizeAddr('5a3ch'), '5A3C');
  assert.equal(normalizeAddr(0x75d), '075D');
  assert.equal(normalizeAddr(0x12345), '12345'); // banked/24-bit machines
  assert.equal(normalizeAddr('e6cd '), 'E6CD');
  assert.equal(normalizeAddr('xyz'), null);
  assert.equal(normalizeAddr(-1), null);
  assert.equal(normalizeAddr(null), null);
});

test('hashBytes is pure, deterministic and length-sensitive', () => {
  const a = Uint8Array.from([1, 2, 3]);
  assert.equal(hashBytes(a), hashBytes(Uint8Array.from([1, 2, 3])));
  assert.notEqual(hashBytes(a), hashBytes(Uint8Array.from([1, 2, 3, 0])));
  assert.match(hashBytes(a), /^fnv1a64:[0-9a-f]{16}$/);
});

// ---- validation -------------------------------------------------------------
test('a minimal well-formed document validates', () => {
  const doc = base({ labels: { '5A3C': obs('encounter_check', 412, { hits: 26, expected: '1/16' }) } });
  const r = validate(doc);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
});

test('romHash is required, and must look like <algo>:<hex>', () => {
  const noHash = validate(createDoc({ machine: 'pc8801', labels: {} }));
  assert.equal(noHash.ok, false);
  assert.ok(noHash.errors.some((e) => e.code === 'romhash'));

  const junk = validate(createDoc({ machine: 'pc8801', romHash: 'my rom', labels: {} }));
  assert.equal(junk.ok, false);
  assert.ok(junk.errors.some((e) => e.code === 'romhash'));

  assert.equal(validate(createDoc({ machine: 'pc8801', romHash: { main: ROM, sub: ROM2 }, labels: {} })).ok, true);
});

test('confidence is required and must be one of the three', () => {
  const bad = base({ labels: { '5A3C': { name: 'x', evidence: { samples: 3 } } } });
  assert.ok(validate(bad).errors.some((e) => e.code === 'confidence'));
  const wrong = base({ labels: { '5A3C': { name: 'x', confidence: 'pretty sure', evidence: { samples: 3 } } } });
  assert.ok(validate(wrong).errors.some((e) => e.code === 'confidence'));
  for (const c of CONFIDENCE) assert.ok(confidenceRank(c) >= 0);
});

test('evidence is required, and its shape follows the confidence claimed', () => {
  // no evidence at all
  assert.ok(validate(base({ labels: { '5A3C': { name: 'x', confidence: 'observed' } } }))
    .errors.some((e) => e.code === 'evidence'));
  // "observed" without a sample count is not an observation
  assert.ok(validate(base({ labels: { '5A3C': { name: 'x', confidence: 'observed', evidence: { basis: 'felt right' } } } }))
    .errors.some((e) => e.code === 'evidence'));
  // "guess" is allowed — but it must say why
  assert.ok(validate(base({ labels: { '5A3C': { name: 'x', confidence: 'guess', evidence: { note: 'dunno' } } } }))
    .errors.some((e) => e.code === 'evidence'));
  assert.equal(validate(base({
    labels: { '5A3C': { name: 'x', confidence: 'guess', evidence: { basis: 'name of the neighbouring routine' } } },
  })).ok, true);
  // inferred needs to say what it was inferred from
  assert.equal(validate(base({
    labels: { '5A3C': { name: 'x', confidence: 'inferred', evidence: { from: 'z80anal call graph' } } },
  })).ok, true);
  // a measurement that contradicts itself is rejected before the claim is judged
  assert.ok(validate(base({ labels: { '5A3C': obs('x', 10, { hits: 99 }) } })).errors.length > 0);
});

test('a measured distribution far from the stated expectation is flagged', () => {
  const r = validate(base({ labels: { '5A3C': obs('encounter', 400, { hits: 200, expected: '1/16' }) } }));
  assert.equal(r.ok, true); // it is a warning: the numbers are real, the reading may not be
  assert.ok(r.warnings.some((w) => w.code === 'distribution'));
});

test('an empty unclassified list is a warning, not a badge of honour', () => {
  const r = validate(createDoc({ machine: 'pc8801', romHash: ROM, labels: { '5A3C': obs('x') } }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.code === 'honest-tails'));
});

test('unclassified entries must carry a reason', () => {
  const r = validate(createDoc({ machine: 'pc8801', romHash: ROM, labels: {}, unclassified: [{ addr: '6F1A' }] }));
  assert.equal(r.ok, false);
});

test('assertValid throws with every error listed', () => {
  assert.throws(() => assertValid({ schemaVersion: 1, machine: '', labels: 3 }), /invalid/);
});

test('a document from a future schema is refused, not half-read', () => {
  const r = validate({ ...base({ labels: {} }), schemaVersion: 99 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'schema'));
});

// ---- serialization ----------------------------------------------------------
test('stringify is canonical: same content, same bytes, whatever the input order', () => {
  const a = createDoc({ machine: 'pc8801', romHash: ROM, labels: { 'FCD3': obs('a'), '075D': obs('b') } });
  const b = createDoc({ machine: 'pc8801', romHash: ROM, labels: { '075d': obs('b'), 'fcd3': obs('a') } });
  assert.equal(stringify(a), stringify(b));
  assert.ok(stringify(a).indexOf('"075D"') < stringify(a).indexOf('"FCD3"'));
  assert.equal(stringify(a).at(-1), '\n');
  assert.deepEqual(parse(stringify(a)), a); // round trip
});

// ---- romHash comparison -----------------------------------------------------
test('romHash comparison distinguishes match / mismatch / incomparable / unknown', () => {
  assert.equal(compareRomHash(ROM, ROM).status, 'match');
  assert.equal(compareRomHash(ROM, ROM2).status, 'mismatch');
  // different algorithms cannot be compared — that is not the same as matching
  assert.equal(compareRomHash(ROM, 'fnv1a64:0123456789abcdef').status, 'incomparable');
  // no shared role: {main,sub} vs a bare whole-set hash
  assert.equal(compareRomHash({ main: ROM }, ROM).status, 'unknown');
  // the accident this field exists for: only the SUB rom differs
  const r = compareRomHash({ main: ROM, sub: ROM }, { main: ROM, sub: ROM2 });
  assert.equal(r.status, 'mismatch');
  assert.deepEqual(r.roles, { main: 'match', sub: 'mismatch' });
  assert.deepEqual(normalizeRomHash(ROM), { '*': [ROM] });
});

test('merge refuses across a romHash mismatch, and says which role differs', () => {
  const a = base({ romHash: { main: ROM, sub: ROM }, labels: { '02BB': obs('motor_wait') } });
  const b = base({ romHash: { main: ROM, sub: ROM2 }, labels: { '02BB': obs('spin_delay') } });
  const r = merge(a, b);
  assert.equal(r.ok, false);
  assert.equal(r.doc.labels['02BB'].name, 'motor_wait'); // left untouched
  const w = r.warnings.find((x) => x.code === 'romhash-mismatch');
  assert.ok(w && w.roles.sub === 'mismatch' && w.roles.main === 'match');
});

test('a forced cross-revision merge leaves the confession in the file', () => {
  const a = base({ romHash: { sub: ROM }, labels: { '02BB': obs('motor_wait') } });
  const b = base({ romHash: { sub: ROM2 }, labels: { '0105': obs('call_spin_delay') } });
  const r = merge(a, b, { force: true });
  assert.equal(r.ok, true);
  assert.ok(r.doc.notes.includes('romHash MISMATCH'));
  assert.ok(r.warnings.some((x) => x.code === 'romhash-mismatch'));
});

test('mismatched machine or cpu does not merge (different address spaces)', () => {
  assert.equal(merge(base({ machine: 'pc8001' }), base({ machine: 'pc8801' })).ok, false);
  assert.equal(merge(base({ cpu: 'main' }), base({ cpu: 'sub' })).ok, false);
});

test('documents that never name a common ROM role are merged, but flagged', () => {
  const r = merge(base({ romHash: { main: ROM } }), base({ romHash: { sub: ROM2 } }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((x) => x.code === 'romhash-unknown'));
  assert.equal(merge(base({ romHash: { main: ROM } }), base({ romHash: { sub: ROM2 } }), { allowUnknownRom: false }).ok, false);
});

// ---- merge rules ------------------------------------------------------------
test('higher confidence wins, and the loser is kept as an alternative', () => {
  const a = base({ labels: { '5A3C': obs('encounter_check', 412, { hits: 26 }) } });
  const b = base({ labels: { '5A3C': { name: 'damage_roll', confidence: 'guess', evidence: { basis: 'called near the battle routine' } } } });
  const r = merge(a, b);
  assert.equal(r.ok, true);
  assert.equal(r.doc.labels['5A3C'].name, 'encounter_check');
  assert.equal(r.doc.labels['5A3C'].disputed, undefined); // settled by confidence
  assert.deepEqual(r.doc.labels['5A3C'].alternatives.map((x) => x.name), ['damage_roll']);
  assert.equal(r.conflicts[0].resolution, 'by-confidence');
  assert.equal(r.conflicts[0].candidates.length, 2);
});

test('EQUAL confidence with different names is a conflict, never a silent overwrite', () => {
  const a = base({ labels: { '5A3C': obs('encounter_check', 412) } });
  const b = base({ labels: { '5A3C': obs('drop_table_index', 412) } });
  const r = merge(a, b);
  assert.equal(r.ok, true);
  const l = r.doc.labels['5A3C'];
  assert.equal(l.disputed, true);
  // both names survive somewhere in the document — nothing was dropped
  const names = [l.name, ...l.alternatives.map((x) => x.name)].sort();
  assert.deepEqual(names, ['drop_table_index', 'encounter_check']);
  const c = r.conflicts.find((x) => x.addr === '5A3C');
  assert.equal(c.resolution, 'disputed');
  assert.deepEqual(c.candidates.map((x) => x.name).sort(), names);
  // and validation still passes: a disputed document is a legal document
  assert.equal(validate(r.doc).ok, true, JSON.stringify(validate(r.doc).errors));
});

test('merge is order-independent and idempotent (parallel PRs land in any order)', () => {
  const a = base({ labels: { '5A3C': obs('encounter_check', 412), '075D': obs('key_wait', 3) } });
  const b = base({ labels: { '5A3C': obs('drop_table_index', 412), 'FCD3': { name: 'decrypt_loop', confidence: 'inferred', evidence: { from: 'watch-write trace' } } } });
  const ab = merge(a, b).doc, ba = merge(b, a).doc;
  assert.equal(stringify(ab), stringify(ba));
  assert.equal(stringify(merge(ab, ab).doc), stringify(ab)); // idempotent
  assert.equal(stringify(merge(ab, a).doc), stringify(ab));  // absorbing an input again changes nothing

  const c = base({ labels: { '5A3C': { name: 'rng_consumer', confidence: 'guess', evidence: { basis: 'hunch' } } } });
  assert.equal(stringify(mergeAll([a, b, c]).doc), stringify(mergeAll([c, b, a]).doc)); // associative
});

test('samples are never summed — two files may describe the same run', () => {
  const a = base({ labels: { '5A3C': obs('encounter_check', 412) } });
  const r = merge(a, a);
  assert.equal(r.doc.labels['5A3C'].evidence.samples, 412);
  assert.equal(r.doc.labels['5A3C'].alternatives, undefined);
  // the same name with a different measurement keeps both, picking the larger
  const b = base({ labels: { '5A3C': obs('encounter_check', 900) } });
  const m = merge(a, b).doc.labels['5A3C'];
  assert.equal(m.evidence.samples, 900);
  assert.equal(m.alternatives[0].evidence.samples, 412);
  assert.equal(m.disputed, undefined); // same name: no dispute, just two runs
});

test('a guess does not close an open tail; an observation does', () => {
  const unk = base({ labels: {}, unclassified: [{ addr: '6F1A', reason: 'read every frame, never compared' }] });
  const guessed = base({ unclassified: [], labels: { '6F1A': { name: 'frame_counter', confidence: 'guess', evidence: { basis: 'increments once per frame' } } } });
  const kept = merge(unk, guessed).doc;
  assert.equal(openTails(kept).length, 1, 'a guess is not knowledge');
  assert.equal(kept.labels['6F1A'].name, 'frame_counter');

  const seen = base({ unclassified: [], labels: { '6F1A': obs('frame_counter', 60) } });
  const settled = merge(unk, seen).doc;
  assert.equal(openTails(settled).length, 0);
  // the record that someone once looked and could not tell is NOT deleted
  assert.equal(settled.unclassified.length, 1);
  // ... and a DISPUTED observation re-opens the tail, in either merge order
  const rival = base({ unclassified: [], labels: { '6F1A': obs('vrtc_latch', 60) } });
  assert.equal(openTails(mergeAll([unk, seen, rival]).doc).length, 1);
  assert.equal(openTails(mergeAll([rival, seen, unk]).doc).length, 1);
});

test('merge unions unclassified and notes without duplicating them', () => {
  const a = base({ labels: {}, unclassified: ['6F1A: unknown'], notes: 'n1' });
  const b = base({ labels: {}, unclassified: ['6F1A: unknown', '7000: also unknown'], notes: 'n2' });
  const r = merge(a, b).doc;
  assert.equal(r.unclassified.length, 2);
  assert.equal(r.notes, 'n1\n\nn2');
  assert.equal(merge(a, a).doc.notes, 'n1');
});

test('the merged document validates and survives a round trip', () => {
  const r = mergeAll([
    base({ labels: { '5A3C': obs('encounter_check', 412, { hits: 26, expected: '1/16' }) } }),
    base({ labels: { '5A3C': obs('drop_index', 412), '02BB': obs('motor_spin_wait', 262144) } }),
  ]).doc;
  assert.equal(validate(r).ok, true, JSON.stringify(validate(r).errors));
  assert.equal(stringify(parse(stringify(r))), stringify(r));
});

// ---- rng --------------------------------------------------------------------
test('an rng identification carries evidence like everything else', () => {
  const withRng = base({ labels: {}, rng: { kind: 'lcg', a: 5, c: 1, confidence: 'observed', evidence: { samples: 200, predicted: '200/200' } } });
  assert.equal(validate(withRng).ok, true, JSON.stringify(validate(withRng).errors));
  assert.equal(validate(base({ labels: {}, rng: { kind: 'lcg', a: 5 } })).ok, false);
  assert.equal(validate(base({ labels: {}, rng: { confidence: 'guess', evidence: { basis: 'x' } } })).ok, false);
});

test('two different rng identifications conflict instead of overwriting', () => {
  const a = base({ labels: {}, rng: { kind: 'lcg', confidence: 'inferred', evidence: { from: '3 consecutive samples' } } });
  const b = base({ labels: {}, rng: { kind: 'lfsr', confidence: 'inferred', evidence: { from: 'tap search' } } });
  const r = merge(a, b);
  assert.equal(r.doc.rng.disputed, true);
  assert.ok(r.conflicts.some((c) => c.kind === 'rng'));
});

// ---- producers / consumers --------------------------------------------------
test('ICE label pairs export as guesses (a typed name is not an observation)', () => {
  const doc = fromLabelMap([[0x5a3c, 'encounter'], [0x075d, 'wait_key'], [1, '']],
    { machine: 'pc8801', romHash: ROM, title: 'ICE session' });
  assert.deepEqual(Object.keys(doc.labels).sort(), ['075D', '5A3C']);
  assert.equal(doc.labels['5A3C'].confidence, 'guess');
  assert.equal(validate(doc).ok, true, JSON.stringify(validate(doc).errors));
  // and back: guesses do not silently become someone else's labels
  assert.deepEqual(toLabelMap(doc), []);
  assert.deepEqual(toLabelMap(doc, { minConfidence: 'guess' }), [[0x075d, 'wait_key'], [0x5a3c, 'encounter']]);
});

test('toLabelMap marks disputed names so the UI can show the argument', () => {
  const r = merge(base({ labels: { '5A3C': obs('a_name', 5) } }), base({ labels: { '5A3C': obs('b_name', 5) } })).doc;
  assert.equal(toLabelMap(r)[0][1].endsWith('?'), true);
});

test('an RNG caller map becomes labels only where the use was established', () => {
  const doc = fromRngCallers([
    { pc: 0x5a3c, samples: 412, hits: 26, expected: '1/16', pattern: 'AND 0Fh -> JR Z', meaning: 'encounter_check' },
    { pc: 0x6122, samples: 88, pattern: 'AND 03h -> ADD HL,DE', distribution: [21, 24, 19, 24] }, // no meaning
  ], { machine: 'pc8801', romHash: ROM, title: 'rng callers' });
  assert.equal(doc.labels['5A3C'].confidence, 'observed');
  assert.equal(doc.labels['6122'], undefined);
  assert.equal(doc.unclassified[0].addr, '6122');
  assert.deepEqual(doc.unclassified[0].evidence.distribution, [21, 24, 19, 24]);
  assert.equal(validate(doc).ok, true, JSON.stringify(validate(doc).errors));
});

// ---- the shipped analysis files --------------------------------------------
test('every file under analysis/ is valid and canonically formatted', async () => {
  const root = new URL('./analysis/', import.meta.url).pathname;
  let machines = [];
  try { machines = await readdir(root); } catch { return; } // no analysis/ yet: fine
  let files = 0;
  for (const m of machines) {
    if (!(await stat(join(root, m))).isDirectory()) continue;
    for (const f of await readdir(join(root, m))) {
      if (!f.endsWith('.json')) continue;
      files++;
      const text = await readFile(join(root, m, f), 'utf8');
      const doc = parse(text);
      const r = validate(doc);
      assert.equal(r.ok, true, `${m}/${f}: ${JSON.stringify(r.errors)}`);
      assert.equal(doc.machine, m, `${m}/${f}: machine must match its directory`);
      assert.equal(text, stringify(doc), `${m}/${f}: not canonical — run stringify() before committing`);
    }
  }
  assert.ok(files > 0, 'analysis/ exists but holds no documents');
});
