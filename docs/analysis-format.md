**English** · [日本語](./analysis-format.ja.md)

# The analysis format — sharing what was found, with the evidence attached

Reverse engineering already produces files here: the ICE label DB
([ice-design](./ice-design.md)), the RNG caller map (#38), the divergence notes in
[m88-comparison](./m88-comparison.md). What was missing was a common shape and a
place to put it, so a result can travel as a **pull request** instead of as a
screenshot.

- `analysisdb.js` — read, validate, merge. Pure, zero deps, deterministic.
- `analysis/<machine>/<slug>.json` — the documents themselves.
- `test-analysisdb.mjs` — `node --test`, no ROM required.

## Why git, not a message board

| | board | git |
|---|---|---|
| a wrong analysis spreads | the correction sinks | **a PR review stops it** |
| why you concluded that | body text, if you remember | **history; `git blame` finds it** |
| combining two people's work | by hand | **merge** |
| infrastructure | auth, moderation, hosting | **none** |

And a label file is not a ROM. Addresses, names and distributions can be shared
where the ROM itself cannot.

## The rule this format exists to enforce

> What was not observed is shown as *unclassified*, never guessed.
> — [ice-design](./ice-design.md)

Alone at a debugger, that rule is a habit. In a shared file it has to be
mechanical, because a shared file is exactly where **one person's hunch becomes
everyone's fact**. So the schema makes a claim carry its own receipts, and the
validator refuses documents that do not.

## A document

```json
{
  "schemaVersion": 1,
  "machine": "pc8801",
  "cpu": "main",
  "title": "N88-BASIC main ROM — the disk boot path",
  "romHash": { "main": ["sha256:4644eb…", "fnv1a64:92f541f044383460"] },
  "labels": {
    "5A3C": {
      "name": "encounter_check",
      "confidence": "observed",
      "evidence": { "samples": 412, "hits": 26, "expected": "1/16" },
      "note": "AND 0Fh -> JR Z",
      "source": "tools/rng-callers.mjs"
    }
  },
  "rng": { "kind": "lcg", "a": 5, "c": 1, "confidence": "observed",
           "evidence": { "samples": 200, "predicted": "200/200" } },
  "unclassified": [{ "addr": "6F1A", "reason": "read every frame, never compared" }],
  "notes": "…",
  "sources": ["romlabels.js", "docs/m88-comparison.md"]
}
```

### Field by field

| field | required | what it is for |
|---|---|---|
| `schemaVersion` | yes | 1. A document from a newer schema is **refused**, not half-read — silently dropping fields you cannot see is how a merge loses someone's work. |
| `machine` | yes | `pc8801`, `pc8001`, … Must equal the directory it lives in. |
| `cpu` | | `main` / `sub`. **One document, one address space.** Merging across it is refused: `02B4` on the sub board has nothing to do with `02B4` on the main. |
| `title` | | What was analysed, for humans. |
| `romHash` | yes | See below. |
| `source` / `date` / `generator` | | Provenance. Nothing is auto-stamped — see *determinism*. |
| `labels` | yes | address → claim. May be empty; an empty analysis is honest. |
| `rng` | | Generator identification (#38). Carries `confidence`/`evidence` like any claim. |
| `unclassified` | | The honest tail. First-class, see below. |
| `conflicts` | | **Derived** on merge, never accumulated. |
| `notes` / `sources` | | Prose and references. |

Unknown top-level fields are kept and warned about, so a newer producer can add
a field without this reader destroying it.

### `romHash` — the field that prevents the accident that already happened

Labels are revision-specific. Applying one revision's labels to another is worse
than having no labels, because they will mostly work.

This is not hypothetical here. M88 loads a combined `Pc88.rom` and only falls
back to the separate files; our harness read the separate files. The two
emulators ran **different ROM revisions**, and every comparison before that
discovery is contaminated ([m88-comparison](./m88-comparison.md)):

| ROM | bytes differing |
|---|---|
| main N88 | 107 / 32768 |
| N88 extension | 141 / 32768 |
| sub (DISK) | **2021 / 8192** |

Only the sub ROM differed badly, which is why `romHash` is **per-role**:

```json
"romHash": { "main": "sha256:…", "ext": "sha256:…", "sub": "sha256:…" }
```

A bare string is allowed for a single-ROM machine (stored internally under the
role `*`). A role may carry **several hashes in different algorithms** — that is
how a browser-side export (synchronous `fnv1a64` from `analysisdb.hashBytes`)
stays comparable with a `sha256` stamped by `node:crypto`.

`compareRomHash(a, b)` returns one of four answers, and only one of them is
"go ahead":

- `match` — every shared role agrees on every shared algorithm.
- `mismatch` — a shared role disagrees. **`merge()` refuses** unless you pass
  `{ force: true }`, and a forced merge writes its own confession into the
  document's `notes`. A cross-revision merge must be visible in the file, not
  only in whoever ran it.
- `incomparable` — they share a role but no algorithm (sha256 vs fnv1a64).
  Merged with a warning. *Not being able to check is not the same as having
  checked.*
- `unknown` — no shared role at all. Same treatment; pass
  `{ allowUnknownRom: false }` to demand a positive match.

### `confidence` and `evidence` — a claim carries its receipts

`confidence` is one of three, and `evidence` is required with a shape that
matches it. The validator rejects the document otherwise:

| confidence | means | evidence must contain |
|---|---|---|
| `observed` | the machine did it and **you counted** | `samples` > 0 (plus `hits`, `expected`, `distribution`, … as you have them) |
| `inferred` | you read the code, or derived it from another result | `basis` / `from` / `method`, or a sample count |
| `guess` | you think so | `basis` — say **why** |

A guess is welcome. An *anonymous* guess is what this table exists to prevent.

Two more checks fall out of it for free:

- `hits > samples` is rejected. The measurement is wrong before the claim is.
- an `observed` claim whose `hits/samples` is far from its stated `expected`
  ("1/16") gets a **warning**: the numbers are real, the reading of them may not
  be. That is the self-check #38 asks for — when the interpretation disagrees
  with the measured distribution, the interpretation loses and the address
  belongs in `unclassified`.

Note the line this draws: **`observed` means someone counted.** The 22 routines
in `analysis/pc8801/n88-fr-boot-path.json` are marked `verified` in
`romlabels.js` — walked instruction by instruction — yet they appear as
`inferred`, because those sessions never recorded a count. That demotion is
deliberate and it is the format working as intended.

### `unclassified` — a first-class field

An entry is `{ addr, reason }` (the shorthand `"6F1A: read but never compared"`
is parsed into the same thing). A non-empty tail is not an embarrassment; an
**empty** tail on a document full of labels raises a validator warning.

Merging **never deletes a tail entry**, even when a label now explains the
address. "Someone looked here and could not tell" is a finding, and deleting on
merge would make the result depend on the order the merges happened in. The live
view is a function, not a field:

```js
openTails(doc)   // → the entries not yet settled by a label
```

An address leaves that view only when a **non-disputed** label of `inferred` or
better covers it. A `guess` does not close a tail: it turns an unknown into a
*named* unknown, not into knowledge.

## Merging — the part that must not lie

`merge(a, b, opts)` → `{ ok, doc, conflicts, warnings }`.

1. **Different `machine` or `cpu`** → refused.
2. **`romHash` mismatch** → refused (see above).
3. **Same address, same name** → one entry. Evidence is **never summed**: two
   documents may well describe the same run, and inflating a sample count
   manufactures confidence nobody observed. The larger measurement wins the
   `evidence` slot and the other is kept in `alternatives`.
4. **Same address, different name, different confidence** → the higher
   confidence wins and **the loser is kept** in `alternatives`; `conflicts`
   records it with `resolution: "by-confidence"`.
5. **Same address, different name, equal confidence** → **conflict**. Both
   survive, the entry is marked `"disputed": true`, and `conflicts` records it
   with `resolution: "disputed"`. Nothing is ever silently overwritten. The name
   in the `name` slot is picked deterministically (confidence, then sample
   count, then the name itself) purely so that everyone's merge produces the
   same bytes — it is a display choice, not a verdict, and `disputed` says so.

Merging is **commutative, associative and idempotent**: `merge(a, b)` and
`merge(b, a)` serialize identically, and re-merging a document you already
absorbed changes nothing. This is not decoration — parallel pull requests land
in whatever order the maintainer clicks, and all orders must converge.

`mergeAll([...])` folds a list and stops at the first refusal, so a bad
`romHash` cannot be laundered by being third in the queue.

## Determinism, because the diff is the review

`stringify(doc)` writes canonical text: fixed key order, addresses sorted,
two-space indent, trailing newline, **no timestamps**. A `git diff` should show
what changed in the analysis, not what changed in the clock. The test suite
checks that every file under `analysis/` is byte-identical to
`stringify(parse(…))`, so a hand-edited file is caught before review.

## Where files live

```
analysis/<machine>/<slug>.json      analysis/pc8801/pc80s31-sub-rom.json
```

The directory name must equal the document's `machine` field (tested). One
document per subject and per address space; keep them small enough to review.

Shipped examples, both built from this repo's own PC-8801 investigations:

- `analysis/pc8801/pc80s31-sub-rom.json` — the FDD sub-CPU ROM: command
  dispatch, and the motor settle delay at `02B4` whose inner loop at `02BB` was
  measured at **262144 iterations per call** while M88 never touches it (M88
  patches out the two `CALL 02B4h` sites at `00FB`/`0105` — *we* are the
  faithful one there).
- `analysis/pc8801/n88-fr-boot-path.json` — the main ROM's disk-boot path and
  8255 handshake, with `E6CD` (the comparison harness's fingerprint byte) and
  `FCCF` (a lead that did **not** pan out) recorded as open tails.

## API

```js
import {
  SCHEMA_VERSION, CONFIDENCE, confidenceRank,
  createDoc, validate, assertValid, parse, stringify,
  normalizeAddr, hashBytes, normalizeRomHash, compareRomHash,
  merge, mergeAll, openTails,
  fromLabelMap, toLabelMap, fromRngCallers,
} from './analysisdb.js';           // package export: "upd3301/analysisdb"
```

- `validate(doc)` → `{ ok, errors, warnings }`; `assertValid` throws with every
  error listed.
- `hashBytes(u8)` → `fnv1a64:…`, synchronous and pure (the browser's
  `crypto.subtle` is not). Use `sha256` from `node:crypto` where you can, and
  stamp both.
- `fromLabelMap(pairs, meta, opts)` — ICE `[addr, name]` pairs → a document.
  Names export as `guess` by default: the DB stores a name, not the observation
  behind it.
- `toLabelMap(doc, { minConfidence = 'inferred' })` — back into the ICE.
  Guesses are excluded by default; `disputed` names come back with a `?`.
- `fromRngCallers(callers, meta)` — #38's caller map → a document. A caller with
  no established meaning becomes an **unclassified entry that still carries its
  numbers**. Being counted and being understood are different things.

### For the tools writing into this format

- **#37 (headless ICE)**: `demo/ice.js` gained one extra export button
  (`解析書出`) next to the existing JSON export; nothing else in it moved. It
  builds `fromLabelMap([...state.labels], …)` and stamps `romHash` from the
  machine's actual ROM images (`romMain`, `romExt`, and the sub board's — a 2KB
  `disk.rom` is mirrored four times over the sub's 8KB space, so the 2KB prefix
  is hashed to match the *file*).
- **#38 (RNG)**: `fromRngCallers` takes
  `{ pc, samples, hits, pattern, expected, distribution, meaning }`. Leave
  `meaning` empty when the distribution does not back the interpretation — the
  document is more useful with an honest hole in it.

## Known holes

- **The ICE keeps one label map for both CPUs.** Its export therefore may mix
  main- and sub-board addresses under a single `cpu` field; the exported
  document says so in its own `notes`. Split before committing.
- **No trust or identity model.** `source` is a string anyone can write. The
  review is the PR, and that is the whole security model.
- **Address keys are flat hex.** No banks. On a machine where `6F06` means
  different things depending on the selected bank, the document must say which
  in `notes` — the schema cannot express it yet.
- **`evidence` is deliberately open.** Only `samples` / `hits` / `expected` /
  `basis` / `from` / `method` are understood; everything else is carried but not
  checked.
- **Hashes are of ROM images, not of the running machine.** A document says
  which ROMs were loaded, not what was patched into RAM afterwards.
