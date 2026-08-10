// analysisdb — the shared file format for reverse-engineering results.
// Pure JS, zero deps, deterministic.
//
// This repo already produces analysis as files (the ICE label DB, the RNG
// caller map of #38, the divergence notes in docs/m88-comparison.md). What was
// missing is a COMMON SHAPE, so that a result can travel as a pull request
// instead of as a screenshot. git gives the review, the blame and the merge for
// free; the only thing it cannot give is honesty about what was actually seen.
// That part is the schema's job:
//
// - `confidence` is required on every claim: observed | inferred | guess.
//   A guess is allowed — hiding that it is one is not.
// - `evidence` is required too, and its shape is checked against the
//   confidence: "observed" without a sample count is not an observation, and a
//   guess without a stated basis is a rumour. This is the honest-tails rule of
//   docs/ice-design.md pushed into the file format, because a shared file is
//   exactly where one person's hunch becomes everyone's fact.
// - `unclassified` is a first-class field. An empty tail is suspicious, not
//   praiseworthy.
// - `romHash` is mandatory. This repo has already been bitten: M88 loaded the
//   combined Pc88.rom while our harness read the separate files, and the sub
//   ROMs differed in 2021 of 8192 bytes (docs/m88-comparison.md). Labels for
//   one revision applied to another are worse than no labels, so merging
//   across a hash mismatch is REFUSED by default, not warned about and done
//   anyway.
//
// Merging is the reason this is code and not a convention. The rule is:
// a higher confidence wins; equal confidence with different names is a
// CONFLICT — both survive, the address is marked `disputed`, and `conflicts`
// records it. Nothing is ever silently overwritten. The winner is picked
// deterministically (rank, then name) so that merging in a different order —
// which is what parallel pull requests are — converges on the same file.
//
// Serialization is deterministic for the same reason: fixed key order, sorted
// addresses, no timestamps. A diff should show what changed in the analysis,
// not what changed in the clock.
//
//   validate(doc)            → { ok, errors, warnings }
//   merge(a, b, opts)        → { ok, doc, conflicts, warnings }
//   stringify(doc)           → canonical JSON text (git-diff friendly)
//   compareRomHash(a, b)     → match | mismatch | incomparable | unknown

export const SCHEMA_VERSION = 1;

// Ascending rank. The order IS the merge precedence, so it lives in one place.
export const CONFIDENCE = Object.freeze(['guess', 'inferred', 'observed']);

export function confidenceRank(c) {
  const i = CONFIDENCE.indexOf(c);
  return i < 0 ? -1 : i;
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && !ArrayBuffer.isView(v);

// ---- addresses --------------------------------------------------------------
// Keys are uppercase hex, at least four digits: "5A3C". Accepts what humans and
// tools actually type (numbers, 0x5a3c, 5a3ch, "5A3C") and refuses the rest —
// a typo'd key would otherwise become an address nobody can look up.
export function normalizeAddr(a) {
  if (typeof a === 'number') {
    if (!Number.isInteger(a) || a < 0 || a > 0xffffffff) return null;
    return a.toString(16).toUpperCase().padStart(4, '0');
  }
  if (typeof a !== 'string') return null;
  let s = a.trim().replace(/^\$/, '').replace(/^0x/i, '').replace(/h$/i, '');
  if (!/^[0-9a-fA-F]{1,8}$/.test(s)) return null;
  s = s.toUpperCase();
  return s.length < 4 ? s.padStart(4, '0') : s;
}

// ---- ROM identity -----------------------------------------------------------
// A hash is "<algo>:<hex>". sha256 comes from node:crypto or crypto.subtle
// (both async in the browser, which is why it is not computed here); hashBytes
// below is the synchronous pure fallback so a browser-side tool can always
// stamp SOMETHING. Two documents are comparable only on a shared algorithm —
// see compareRomHash.
const HASH_RE = /^[a-z0-9][a-z0-9_-]*:[0-9a-fA-F]{8,128}$/;

// FNV-1a in two 32-bit lanes with the length folded in, hex-encoded: 64 bits,
// synchronous, no crypto API. Same idea as romid.js contentKey (which is not
// reused here because its output embeds a colon, and this format parses on one).
export function hashBytes(bytes) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i] & 0xff;
    h1 = (((h1 ^ v) >>> 0) * 0x01000193) >>> 0;
    h2 = (((h2 + v) >>> 0) * 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  // fold the length: two dumps that differ only by trailing padding are not
  // the same ROM (an 0x800 disk.rom vs an 0x2000 one is a real distinction).
  const len = bytes.length >>> 0;
  h1 = ((h1 ^ len) * 0x01000193) >>> 0;
  h2 = ((h2 + len) * 0x85ebca6b) >>> 0;
  const hx = (h) => (h >>> 0).toString(16).padStart(8, '0');
  return 'fnv1a64:' + hx(h1) + hx(h2);
}

// Internal shape: { role: [hash, ...] }. A bare string means "the whole ROM
// set, unsplit" and is stored under '*'. Roles matter because the accident this
// field exists to prevent was role-local: only the SUB rom differed.
export function normalizeRomHash(h) {
  const out = {};
  const push = (role, v) => {
    if (typeof v !== 'string') return;
    const s = v.trim();
    if (!s) return;
    (out[role] ||= []).push(s);
  };
  if (typeof h === 'string') push('*', h);
  else if (Array.isArray(h)) for (const v of h) push('*', v);
  else if (isPlain(h)) {
    for (const role of Object.keys(h).sort()) {
      const v = h[role];
      if (Array.isArray(v)) for (const one of v) push(role, one);
      else push(role, v);
    }
  }
  for (const role of Object.keys(out)) out[role] = [...new Set(out[role])].sort();
  return out;
}

const algoOf = (h) => String(h).split(':', 1)[0].toLowerCase();

// Compare two romHash fields.
//   match        — every role they share agrees on every shared algorithm
//   mismatch     — a shared role disagrees on a shared algorithm  → do not merge
//   incomparable — they share a role but no algorithm (e.g. sha256 vs fnv1a64)
//   unknown      — no shared role at all (one says {main,sub}, the other '*')
// "incomparable" and "unknown" are deliberately NOT "match": not being able to
// check is not the same as having checked.
export function compareRomHash(a, b) {
  const A = normalizeRomHash(a), B = normalizeRomHash(b);
  const roles = Object.keys(A).filter((r) => r in B).sort();
  const perRole = {};
  let mismatch = false, matched = 0, incomparable = 0;
  for (const r of roles) {
    const algosA = new Set(A[r].map(algoOf));
    const shared = B[r].map(algoOf).filter((x) => algosA.has(x));
    if (!shared.length) { perRole[r] = 'incomparable'; incomparable++; continue; }
    const bad = shared.some((al) => {
      const x = A[r].filter((h) => algoOf(h) === al).join(',');
      const y = B[r].filter((h) => algoOf(h) === al).join(',');
      return x.toLowerCase() !== y.toLowerCase();
    });
    perRole[r] = bad ? 'mismatch' : 'match';
    if (bad) mismatch = true; else matched++;
  }
  let status;
  if (!roles.length) status = 'unknown';
  else if (mismatch) status = 'mismatch';
  else if (matched) status = 'match';
  else if (incomparable) status = 'incomparable';
  else status = 'unknown';
  return { status, roles: perRole, shared: roles };
}

// Union of two romHash fields — only ever called once they have been found
// compatible (or the caller forced it, in which case the doc says so).
function unionRomHash(a, b) {
  const A = normalizeRomHash(a), B = normalizeRomHash(b);
  const out = {};
  for (const r of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()) {
    out[r] = [...new Set([...(A[r] || []), ...(B[r] || [])])].sort();
  }
  // keep the single-role, single-hash case as a plain string: the format should
  // not look bureaucratic for the simple case.
  const roles = Object.keys(out);
  if (roles.length === 1 && roles[0] === '*' && out['*'].length === 1) return out['*'][0];
  const flat = {};
  for (const r of roles) flat[r] = out[r].length === 1 ? out[r][0] : out[r];
  return flat;
}

// ---- unclassified -----------------------------------------------------------
// Accepts the shorthand "6F1A: read but purpose unknown" as well as
// { addr, reason }. Normalized to the object form so merges can dedupe on the
// address instead of on prose.
export function normalizeUnclassified(entry) {
  if (typeof entry === 'string') {
    const m = /^\s*([$0-9a-fA-FxXh]{1,10})\s*[:：]\s*(.+)$/.exec(entry);
    if (m) {
      const addr = normalizeAddr(m[1]);
      if (addr) return { addr, reason: m[2].trim() };
    }
    const reason = entry.trim();
    return reason ? { reason } : null;
  }
  if (!isPlain(entry)) return null;
  const out = {};
  const addr = entry.addr === undefined ? null : normalizeAddr(entry.addr);
  if (addr) out.addr = addr;
  const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
  if (reason) out.reason = reason;
  for (const k of Object.keys(entry)) {
    if (k !== 'addr' && k !== 'reason') out[k] = entry[k];
  }
  return out.reason || out.addr ? out : null;
}

// ---- documents --------------------------------------------------------------
const DOC_KEYS = ['schemaVersion', 'machine', 'cpu', 'title', 'romHash', 'source', 'date',
  'labels', 'rng', 'unclassified', 'conflicts', 'notes', 'sources', 'generator'];
const LABEL_KEYS = ['name', 'confidence', 'evidence', 'note', 'source', 'disputed', 'alternatives'];

// Build a normalized document. Nothing is invented: no timestamp is stamped
// (that would churn every diff and break the determinism law), no confidence is
// defaulted (the whole point is that the author states it).
export function createDoc(fields = {}) {
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    machine: String(fields.machine ?? ''),
    romHash: fields.romHash ?? '',
    labels: {},
    unclassified: [],
  };
  if (fields.cpu) doc.cpu = String(fields.cpu);
  if (fields.title) doc.title = String(fields.title);
  if (fields.source) doc.source = String(fields.source);
  if (fields.date) doc.date = String(fields.date);
  if (fields.notes) doc.notes = String(fields.notes);
  if (fields.generator) doc.generator = String(fields.generator);
  if (Array.isArray(fields.sources)) doc.sources = fields.sources.map(String);
  if (fields.rng) doc.rng = { ...fields.rng };
  for (const [k, v] of Object.entries(fields.labels ?? {})) {
    const addr = normalizeAddr(k);
    if (addr) doc.labels[addr] = normalizeLabel(v);
  }
  for (const u of fields.unclassified ?? []) {
    const n = normalizeUnclassified(u);
    if (n) doc.unclassified.push(n);
  }
  if (Array.isArray(fields.conflicts) && fields.conflicts.length) doc.conflicts = fields.conflicts;
  return doc;
}

function normalizeLabel(v) {
  if (!isPlain(v)) return v; // let validate() report it rather than mangling it
  const out = {};
  for (const k of LABEL_KEYS) if (v[k] !== undefined) out[k] = v[k];
  for (const k of Object.keys(v)) if (!(k in out)) out[k] = v[k];
  if (Array.isArray(out.alternatives)) out.alternatives = out.alternatives.map(normalizeLabel);
  return out;
}

// ---- validation -------------------------------------------------------------
// Errors reject the document; warnings are for things a reviewer should look at
// but which are not wrong (an empty unclassified list, an unknown key from a
// newer producer, a document made only of guesses).
export function validate(doc) {
  const errors = [], warnings = [];
  const err = (path, message, code = 'invalid') => errors.push({ path, message, code });
  const warn = (path, message, code = 'note') => warnings.push({ path, message, code });

  if (!isPlain(doc)) return { ok: false, errors: [{ path: '', message: 'document must be an object', code: 'invalid' }], warnings };

  if (doc.schemaVersion !== SCHEMA_VERSION) {
    if (typeof doc.schemaVersion !== 'number') err('schemaVersion', 'missing or not a number', 'schema');
    else if (doc.schemaVersion > SCHEMA_VERSION) err('schemaVersion', `from the future (${doc.schemaVersion} > ${SCHEMA_VERSION}) — this reader would drop fields it cannot see`, 'schema');
    else warn('schemaVersion', `older schema (${doc.schemaVersion})`, 'schema');
  }
  if (typeof doc.machine !== 'string' || !doc.machine.trim()) err('machine', 'required (e.g. "pc8801")');
  if (doc.cpu !== undefined && (typeof doc.cpu !== 'string' || !doc.cpu.trim())) err('cpu', 'must be a non-empty string when present ("main" / "sub")');
  if (doc.title !== undefined && typeof doc.title !== 'string') err('title', 'must be a string');

  // romHash: the guard against applying labels to a different ROM revision.
  const rh = normalizeRomHash(doc.romHash);
  const roles = Object.keys(rh);
  if (!roles.length) err('romHash', 'required — labels are revision-specific, and this repo has already been bitten by a 2021/8192-byte sub-ROM difference', 'romhash');
  for (const r of roles) {
    for (const h of rh[r]) {
      if (!HASH_RE.test(h)) err(`romHash.${r}`, `"${h}" is not "<algo>:<hex>" (e.g. "sha256:…", "${hashBytes(new Uint8Array(0)).split(':')[0]}:…")`, 'romhash');
    }
  }

  if (!isPlain(doc.labels)) {
    err('labels', 'required object (may be empty — an empty analysis is honest)');
  } else {
    for (const [k, v] of Object.entries(doc.labels)) {
      const addr = normalizeAddr(k);
      if (!addr) { err(`labels.${k}`, 'key is not a hex address'); continue; }
      if (addr !== k) warn(`labels.${k}`, `not canonical; write it as "${addr}"`, 'canonical');
      validateClaim(v, `labels.${k}`, err, warn);
    }
  }

  if (doc.rng !== undefined && doc.rng !== null) {
    if (!isPlain(doc.rng)) err('rng', 'must be an object');
    else {
      if (typeof doc.rng.kind !== 'string' || !doc.rng.kind.trim()) err('rng.kind', 'required (lcg / lfsr / table / frame-counter / unknown)');
      validateEvidence(doc.rng, 'rng', err, warn);
    }
  }

  if (doc.unclassified !== undefined) {
    if (!Array.isArray(doc.unclassified)) err('unclassified', 'must be an array');
    else doc.unclassified.forEach((u, i) => {
      const n = normalizeUnclassified(u);
      if (!n) err(`unclassified[${i}]`, 'needs a reason ("6F1A: read, purpose unknown" or { addr, reason })');
      else if (!n.reason) err(`unclassified[${i}]`, 'needs a reason — an address alone says nothing');
    });
  }

  if (doc.conflicts !== undefined && !Array.isArray(doc.conflicts)) err('conflicts', 'must be an array');
  if (doc.notes !== undefined && typeof doc.notes !== 'string') err('notes', 'must be a string');
  if (doc.sources !== undefined && !Array.isArray(doc.sources)) err('sources', 'must be an array of strings');

  for (const k of Object.keys(doc)) {
    if (!DOC_KEYS.includes(k)) warn(k, 'unknown top-level field (kept, but no reader here understands it)', 'unknown-field');
  }

  // Honest-tails warnings. Neither is an error: a document may legitimately
  // have nothing left unexplained, and a document may legitimately be all
  // guesses — but a reviewer should see both facts before merging.
  const labelCount = isPlain(doc.labels) ? Object.keys(doc.labels).length : 0;
  if (labelCount && !(doc.unclassified?.length)) {
    warn('unclassified', 'empty: is everything really classified? unclassified is a first-class field here', 'honest-tails');
  }
  if (labelCount && isPlain(doc.labels)
    && Object.values(doc.labels).every((l) => isPlain(l) && l.confidence === 'guess')) {
    warn('labels', 'every label is a guess — fine, but say so in notes so a reader does not mistake it for a map', 'honest-tails');
  }

  return { ok: errors.length === 0, errors, warnings };
}

// A "claim" is anything that asserts a fact: a label, an rng identification,
// an alternative inside a conflict. All of them carry name/confidence/evidence.
function validateClaim(v, path, err, warn) {
  if (!isPlain(v)) { err(path, 'must be an object { name, confidence, evidence }'); return; }
  if (typeof v.name !== 'string' || !v.name.trim()) err(`${path}.name`, 'required');
  validateEvidence(v, path, err, warn);
  if (v.alternatives !== undefined) {
    if (!Array.isArray(v.alternatives)) err(`${path}.alternatives`, 'must be an array');
    else v.alternatives.forEach((alt, i) => validateClaim(alt, `${path}.alternatives[${i}]`, err, warn));
  }
  if (v.disputed !== undefined && typeof v.disputed !== 'boolean') err(`${path}.disputed`, 'must be a boolean');
}

// The teeth of the format. The evidence a claim must carry is a function of the
// confidence it claims:
//   observed — a sample count. "Observed" with nothing counted is not an
//              observation; it is a memory of one.
//   inferred — either samples or a stated basis: what was it inferred FROM?
//   guess    — a stated basis. A guess is welcome; an anonymous guess is how
//              one person's hunch becomes everyone's fact.
function validateEvidence(v, path, err, warn) {
  const c = v.confidence;
  if (typeof c !== 'string' || confidenceRank(c) < 0) {
    err(`${path}.confidence`, `required, one of ${CONFIDENCE.join(' | ')}`, 'confidence');
    return;
  }
  const e = v.evidence;
  if (!isPlain(e)) { err(`${path}.evidence`, 'required object — a claim without evidence is a rumour', 'evidence'); return; }
  if (!Object.keys(e).length) { err(`${path}.evidence`, 'is empty', 'evidence'); return; }

  const samples = typeof e.samples === 'number' ? e.samples : null;
  const basis = [e.basis, e.from, e.method].find((x) => typeof x === 'string' && x.trim());
  if (samples !== null && (!Number.isFinite(samples) || samples < 0)) err(`${path}.evidence.samples`, 'must be a non-negative number');
  if (typeof e.hits === 'number' && samples !== null && e.hits > samples) {
    err(`${path}.evidence`, `hits (${e.hits}) > samples (${samples}) — the measurement is wrong before the claim is`);
  }
  if (c === 'observed' && !(samples > 0)) {
    err(`${path}.evidence.samples`, 'confidence "observed" needs a positive sample count (how many times did you see it?)', 'evidence');
  }
  if (c === 'inferred' && !(samples > 0) && !basis) {
    err(`${path}.evidence`, 'confidence "inferred" needs evidence.basis (inferred from what?) or a sample count', 'evidence');
  }
  if (c === 'guess' && !basis) {
    err(`${path}.evidence.basis`, 'confidence "guess" needs a stated basis — say why you think so', 'evidence');
  }
  if (c === 'observed' && typeof e.hits === 'number' && typeof e.expected === 'string' && samples > 0) {
    // The self-check #38 asks for: an interpretation that disagrees with the
    // measured distribution is a wrong interpretation. We cannot parse every
    // "1/16"-shaped string, but we can check the obvious one.
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(e.expected);
    if (m) {
      const p = Number(m[1]) / Number(m[2]);
      const got = e.hits / samples;
      if (p > 0 && (got > p * 2 || got < p / 2)) {
        warn(`${path}.evidence`, `measured ${e.hits}/${samples} = ${got.toFixed(4)} is far from expected ${e.expected} (${p.toFixed(4)}) — the interpretation may be wrong; consider unclassified`, 'distribution');
      }
    }
  }
}

export function assertValid(doc) {
  const r = validate(doc);
  if (!r.ok) {
    const e = new Error('analysis document is invalid:\n' + r.errors.map((x) => `  ${x.path}: ${x.message}`).join('\n'));
    e.errors = r.errors;
    throw e;
  }
  return doc;
}

// ---- (de)serialization ------------------------------------------------------
export function parse(text) {
  const doc = JSON.parse(text);
  return createDoc(doc);
}

// Canonical text: fixed key order, addresses sorted, two-space indent, trailing
// newline. Two people who merged the same set of documents must produce the
// same bytes, or `git diff` stops being a review tool.
export function stringify(doc) {
  return JSON.stringify(canonical(doc), null, 2) + '\n';
}

function canonical(doc) {
  const out = {};
  const put = (k, v) => { if (v !== undefined) out[k] = v; };
  put('schemaVersion', doc.schemaVersion ?? SCHEMA_VERSION);
  put('machine', doc.machine);
  put('cpu', doc.cpu);
  put('title', doc.title);
  put('romHash', doc.romHash);
  put('source', doc.source);
  put('date', doc.date);
  if (isPlain(doc.labels)) {
    const labels = {};
    for (const k of Object.keys(doc.labels).sort()) labels[k] = canonicalLabel(doc.labels[k]);
    out.labels = labels;
  } else put('labels', doc.labels);
  put('rng', doc.rng);
  if (doc.unclassified !== undefined) {
    out.unclassified = Array.isArray(doc.unclassified)
      ? [...doc.unclassified].map((u) => normalizeUnclassified(u) ?? u).sort(cmpUnclassified)
      : doc.unclassified;
  }
  if (doc.conflicts !== undefined && (!Array.isArray(doc.conflicts) || doc.conflicts.length)) put('conflicts', doc.conflicts);
  put('notes', doc.notes);
  put('sources', doc.sources);
  put('generator', doc.generator);
  for (const k of Object.keys(doc)) if (!(k in out) && !DOC_KEYS.includes(k)) out[k] = doc[k];
  return out;
}

function canonicalLabel(l) {
  if (!isPlain(l)) return l;
  const out = {};
  for (const k of LABEL_KEYS) if (l[k] !== undefined) out[k] = k === 'alternatives' ? l[k].map(canonicalLabel) : l[k];
  for (const k of Object.keys(l).sort()) if (!(k in out)) out[k] = l[k];
  return out;
}

const cmpUnclassified = (a, b) => {
  const ka = (a?.addr ?? 'ZZZZZZZZ') + ' ' + (a?.reason ?? '');
  const kb = (b?.addr ?? 'ZZZZZZZZ') + ' ' + (b?.reason ?? '');
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

// ---- merging ----------------------------------------------------------------
// Candidate identity for dedup: name + confidence + evidence. Two documents
// that carry the same claim collapse to one (so merge(a, a) === a), while a
// differing evidence set survives as an alternative rather than being averaged
// into something nobody measured.
const claimKey = (c) => [String(c?.name ?? ''), String(c?.confidence ?? ''),
  stableJson(c?.evidence ?? null), String(c?.note ?? ''), String(c?.source ?? '')].join(' ');

function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}

// Deterministic ordering of competing claims: strongest confidence first, then
// the larger sample count, then the name, then the whole claim. Order-independence
// matters more than any particular tie-break here — parallel pull requests merge
// in whatever order they land, and all orders must converge.
function cmpClaim(a, b) {
  const ra = confidenceRank(a.confidence), rb = confidenceRank(b.confidence);
  if (ra !== rb) return rb - ra;
  const sa = Number(a.evidence?.samples ?? -1), sb = Number(b.evidence?.samples ?? -1);
  if (sa !== sb) return sb - sa;
  const na = String(a.name ?? ''), nb = String(b.name ?? '');
  if (na !== nb) return na < nb ? -1 : 1;
  const ka = claimKey(a), kb = claimKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// Flatten a stored claim (which may already carry alternatives from an earlier
// merge) into the flat candidate set. Merging is then a max over a SET, which
// is what makes it commutative and associative.
function candidatesOf(claim) {
  if (!isPlain(claim)) return [];
  const { alternatives, disputed, ...main } = claim;
  const out = [main];
  for (const alt of alternatives ?? []) {
    const { alternatives: _a, disputed: _d, ...flat } = isPlain(alt) ? alt : {};
    if (Object.keys(flat).length) out.push(flat);
  }
  return out;
}

// Pick the winner and keep everyone else. `disputed` is set when the runner-up
// ties on confidence with a DIFFERENT name — that is the case where this module
// refuses to pretend it knows, and the reason `conflicts` exists.
function resolveClaim(cands) {
  const seen = new Map();
  for (const c of cands) if (isPlain(c) && c.name !== undefined) seen.set(claimKey(c), c);
  const list = [...seen.values()].sort(cmpClaim);
  if (!list.length) return null;
  const [winner, ...rest] = list;
  const wr = confidenceRank(winner.confidence);
  const disputed = rest.some((c) => confidenceRank(c.confidence) === wr && c.name !== winner.name);
  const out = { ...winner };
  if (rest.length) out.alternatives = rest; // losers are kept, never dropped

  if (disputed) out.disputed = true;
  return out;
}

// Conflicts are DERIVED from the merged labels, never accumulated, so that the
// same set of inputs always yields the same conflict list no matter how the
// merges were ordered.
function deriveConflicts(doc) {
  const out = [];
  for (const addr of Object.keys(doc.labels).sort()) {
    const l = doc.labels[addr];
    if (!isPlain(l) || !l.alternatives?.length) continue;
    out.push({
      kind: 'label',
      addr,
      resolution: l.disputed ? 'disputed' : 'by-confidence',
      winner: { name: l.name, confidence: l.confidence },
      candidates: [{ name: l.name, confidence: l.confidence, evidence: l.evidence, source: l.source },
      ...l.alternatives.map((a) => ({ name: a.name, confidence: a.confidence, evidence: a.evidence, source: a.source }))]
        .map((c) => { const o = {}; for (const [k, v] of Object.entries(c)) if (v !== undefined) o[k] = v; return o; }),
    });
  }
  if (isPlain(doc.rng) && doc.rng.alternatives?.length) {
    out.push({
      kind: 'rng',
      resolution: doc.rng.disputed ? 'disputed' : 'by-confidence',
      winner: { name: doc.rng.name ?? doc.rng.kind, confidence: doc.rng.confidence },
      candidates: [doc.rng, ...doc.rng.alternatives].map((c) => ({ kind: c.kind, name: c.name, confidence: c.confidence, evidence: c.evidence })),
    });
  }
  return out;
}

const FORCED_NOTE = 'MERGED ACROSS A romHash MISMATCH (forced). Labels in this file may come from a different ROM revision — verify before trusting.';

// merge(a, b) → { ok, doc, conflicts, warnings }
//
// opts.force        merge even when romHash mismatches (the document then says
//                   so in `notes` — a forced merge must be visible in the file,
//                   not only in whoever ran it)
// opts.allowUnknownRom  treat "no shared role" as mergeable (default true;
//                   set false to demand a positive hash match)
export function merge(a, b, opts = {}) {
  const { force = false, allowUnknownRom = true } = opts;
  const warnings = [];
  const left = createDoc(a), right = createDoc(b);

  if (left.machine && right.machine && left.machine !== right.machine) {
    warnings.push({ code: 'machine-mismatch', message: `machine differs: ${left.machine} vs ${right.machine}` });
    if (!force) return { ok: false, doc: left, conflicts: left.conflicts ?? [], warnings };
  }
  if ((left.cpu ?? 'main') !== (right.cpu ?? 'main')) {
    warnings.push({ code: 'cpu-mismatch', message: `cpu differs: ${left.cpu ?? 'main'} vs ${right.cpu ?? 'main'} — these are different address spaces` });
    if (!force) return { ok: false, doc: left, conflicts: left.conflicts ?? [], warnings };
  }

  const rh = compareRomHash(left.romHash, right.romHash);
  if (rh.status === 'mismatch') {
    const bad = Object.entries(rh.roles).filter(([, s]) => s === 'mismatch').map(([r]) => r).join(', ');
    warnings.push({
      code: 'romhash-mismatch', roles: rh.roles,
      message: `romHash differs on: ${bad}. These are different ROM revisions — applying one side's labels to the other is how 2021 of 8192 sub-ROM bytes went unnoticed (docs/m88-comparison.md). Pass { force: true } only if you know why.`,
    });
    if (!force) return { ok: false, doc: left, conflicts: left.conflicts ?? [], warnings };
  } else if (rh.status === 'incomparable') {
    warnings.push({ code: 'romhash-incomparable', roles: rh.roles, message: 'romHash uses different algorithms on both sides — equality was never checked. Re-stamp one side with the other\'s algorithm.' });
  } else if (rh.status === 'unknown') {
    warnings.push({ code: 'romhash-unknown', message: 'the two documents name no common ROM role, so the hashes were never compared.' });
    if (!allowUnknownRom && !force) return { ok: false, doc: left, conflicts: left.conflicts ?? [], warnings };
  }

  const doc = createDoc({
    machine: left.machine || right.machine,
    cpu: left.cpu ?? right.cpu,
    title: left.title ?? right.title,
    romHash: rh.status === 'mismatch' ? left.romHash : unionRomHash(left.romHash, right.romHash),
    source: left.source ?? right.source,
    date: left.date ?? right.date,
  });

  for (const addr of new Set([...Object.keys(left.labels), ...Object.keys(right.labels)])) {
    const resolved = resolveClaim([...candidatesOf(left.labels[addr]), ...candidatesOf(right.labels[addr])]);
    if (resolved) doc.labels[addr] = resolved;
  }

  if (left.rng || right.rng) {
    const cands = [...candidatesOf(left.rng ? { name: left.rng.kind, ...left.rng } : null),
    ...candidatesOf(right.rng ? { name: right.rng.kind, ...right.rng } : null)];
    const r = resolveClaim(cands);
    if (r) doc.rng = r;
  }

  // unclassified: union, deduped on address+reason, and nothing is deleted even
  // when a label now explains the address. Two reasons. "Someone looked here and
  // could not tell" is a finding, and a later name does not un-happen it. And
  // deleting during a merge would make the result depend on the ORDER the merges
  // happened in (settle-then-dispute would erase a tail that dispute-then-settle
  // keeps) — the one thing this module must never do. The live view of which
  // tails are still open is openTails() below.
  const uSeen = new Map();
  for (const u of [...left.unclassified, ...right.unclassified]) {
    uSeen.set((u.addr ?? '') + ' ' + (u.reason ?? ''), u);
  }
  doc.unclassified = [...uSeen.values()].sort(cmpUnclassified);

  const notes = [];
  for (const n of [left.notes, right.notes]) if (n && !notes.includes(n)) notes.push(n);
  if (rh.status === 'mismatch' && force && !notes.includes(FORCED_NOTE)) notes.push(FORCED_NOTE);
  if (notes.length) doc.notes = notes.join('\n\n');

  const sources = [...new Set([...(left.sources ?? []), ...(right.sources ?? [])])];
  if (sources.length) doc.sources = sources;

  const conflicts = deriveConflicts(doc);
  if (conflicts.length) doc.conflicts = conflicts;

  return { ok: true, doc, conflicts, warnings };
}

// Fold a list. Stops (ok:false) at the first refusal so a bad romHash cannot be
// laundered by being third in the queue.
export function mergeAll(docs, opts = {}) {
  const list = [...docs];
  if (!list.length) return { ok: true, doc: createDoc({}), conflicts: [], warnings: [] };
  let acc = createDoc(list[0]);
  const warnings = [];
  for (let i = 1; i < list.length; i++) {
    const r = merge(acc, list[i], opts);
    warnings.push(...r.warnings.map((w) => ({ ...w, index: i })));
    if (!r.ok) return { ok: false, doc: acc, conflicts: acc.conflicts ?? [], warnings };
    acc = r.doc;
  }
  return { ok: true, doc: acc, conflicts: acc.conflicts ?? [], warnings };
}

// Which unclassified entries are still open, given what the labels now claim.
// An address leaves the tail only when something ACTUALLY established what it
// is: a non-disputed label at `inferred` or better. A `guess` does not clear
// it — a guess turns an unknown into a NAMED unknown, not into knowledge, and
// this is the exact seam where one person's hunch would otherwise become
// everyone's fact. Entries with no address always stay (nothing can settle a
// question that was never pinned to an address).
export function openTails(doc, opts = {}) {
  const { minConfidence = 'inferred' } = opts;
  const min = confidenceRank(minConfidence);
  const labels = isPlain(doc?.labels) ? doc.labels : {};
  return (doc?.unclassified ?? [])
    .map((u) => normalizeUnclassified(u))
    .filter((u) => {
      if (!u) return false;
      if (!u.addr) return true;
      const l = labels[u.addr];
      return !(isPlain(l) && !l.disputed && confidenceRank(l.confidence) >= min);
    });
}

// ---- producers / consumers --------------------------------------------------
// The ICE label DB is [addr, name] pairs typed by a human while stepping. There
// is no recorded observation behind them, so they export as `guess` by default —
// not to insult the analyst, but because the file cannot tell the difference
// between a name earned by a trace and a name typed on a hunch, and this format
// refuses to guess in the reader's favour. Pass { confidence, evidence } once
// you can actually back them up.
export function fromLabelMap(entries, meta = {}, opts = {}) {
  const {
    confidence = 'guess',
    evidence = { basis: 'ICE label DB (typed by hand while stepping; no observation recorded)' },
  } = opts;
  const labels = {};
  for (const [addr, name] of entries) {
    const a = normalizeAddr(addr);
    if (!a || !String(name ?? '').trim()) continue;
    labels[a] = { name: String(name), confidence, evidence: { ...evidence } };
  }
  return createDoc({ ...meta, labels });
}

// Back into the ICE: [addr, name] pairs. Guesses are excluded by default —
// importing someone else's hunches as labels is exactly the failure this format
// exists to prevent. `disputed` addresses are marked so the UI can show that
// the name is contested rather than settled.
export function toLabelMap(doc, opts = {}) {
  const { minConfidence = 'inferred', markDisputed = true } = opts;
  const min = confidenceRank(minConfidence);
  const out = [];
  for (const addr of Object.keys(doc.labels ?? {}).sort()) {
    const l = doc.labels[addr];
    if (!isPlain(l) || confidenceRank(l.confidence) < min) continue;
    out.push([parseInt(addr, 16), markDisputed && l.disputed ? `${l.name}?` : l.name]);
  }
  return out;
}

// #38's RNG caller map → a document. Each caller is
//   { pc, samples, hits?, pattern?, meaning?, expected?, distribution? }
// A caller with no `meaning` (or a meaning the distribution contradicts, which
// the caller decides) does not become a label — it becomes an unclassified
// entry that still carries its numbers. Being counted and being understood are
// different things, and the format keeps them apart.
export function fromRngCallers(callers, meta = {}) {
  const labels = {};
  const unclassified = [];
  for (const c of callers) {
    const addr = normalizeAddr(c.pc ?? c.addr);
    if (!addr) continue;
    const evidence = {};
    if (c.samples !== undefined) evidence.samples = c.samples;
    if (c.hits !== undefined) evidence.hits = c.hits;
    if (c.expected !== undefined) evidence.expected = c.expected;
    if (c.pattern !== undefined) evidence.pattern = c.pattern;
    if (c.distribution !== undefined) evidence.distribution = c.distribution;
    if (c.basis !== undefined) evidence.basis = c.basis;
    if (!c.meaning) {
      unclassified.push({
        addr,
        reason: c.reason
          ?? `RNG consumer: ${c.pattern ? c.pattern + ', ' : ''}${c.samples ?? 0} samples, use not established`,
        evidence,
      });
      continue;
    }
    labels[addr] = {
      name: c.meaning,
      confidence: c.confidence ?? (c.samples > 0 ? 'observed' : 'guess'),
      evidence: Object.keys(evidence).length ? evidence : { basis: 'RNG caller map (#38)' },
    };
  }
  return createDoc({ ...meta, labels, unclassified });
}
