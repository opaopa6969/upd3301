// snap — deep-copy helpers for machine snapshots.
//
// Everything in this repo keeps its state in plain fields: numbers, bools,
// typed arrays, small plain objects. That discipline (no hidden closures
// holding state) is what makes time travel cheap: copy the fields out,
// copy them back in, and a deterministic machine lands on the exact same
// timeline. Functions are skipped on the way out and preserved on the way
// in — wiring (DRQ hooks, cross-wired 8255 reads) belongs to the board,
// not to the snapshot.
//
// Pure, dependency-free. Not a general serializer: no cycles, no Maps
// (callers handle those), no class reconstruction — restore() writes into
// EXISTING objects.

export const SCHEMA_VERSION = 1;

const isTyped = (v) => ArrayBuffer.isView(v) && !(v instanceof DataView);

// Copy the own enumerable state of `obj` into a plain object.
export function snapObj(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'function' || v === undefined) continue;
    out[k] = snapValue(v);
  }
  return out;
}

function snapValue(v) {
  if (v === null || typeof v !== 'object') return v;
  if (isTyped(v)) return v.slice();
  if (Array.isArray(v)) return v.map(snapValue);
  return snapObj(v);
}

// Write a snapshot back into an existing object. Typed arrays are copied
// in place when the length matches (keeps views/aliases alive); plain
// objects recurse; anything else is assigned.
export function restoreObj(obj, snap) {
  for (const k of Object.keys(snap)) {
    const v = snap[k];
    const cur = obj[k];
    if (isTyped(v)) {
      if (isTyped(cur) && cur.length === v.length) cur.set(v);
      else obj[k] = v.slice();
    } else if (Array.isArray(v)) {
      obj[k] = v.map(snapValue);
    } else if (v !== null && typeof v === 'object') {
      if (cur !== null && typeof cur === 'object' && !Array.isArray(cur) && !isTyped(cur)) {
        restoreObj(cur, v);
      } else {
        obj[k] = snapValue(v);
      }
    } else {
      obj[k] = v;
    }
  }
  return obj;
}
