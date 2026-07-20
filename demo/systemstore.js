// systemstore.js — the SERVER-side ROM/disk library (serve.py /api/store/*).
//
// romstore.js keeps blobs in IndexedDB, which is per-browser: switch browsers,
// clear site data, or open the emulator on another machine and a hand-curated
// library of hundreds of disks looks empty. On an AUTHENTICATED host the server
// keeps a copy per volta user, and this module is the client for it.
//
// Availability is a property of the deployment, not a setting: the gateway
// injects X-Volta-User-Id only on authenticated hosts and strips client-supplied
// copies everywhere, so on the public host every call 403s. `available()` probes
// once and caches, and every function degrades to a no-op/empty result — callers
// can wire the UI unconditionally and it simply stays hidden when unavailable.
//
// Same role keys as romstore.js ('rom', 'font', 'n88main', 'disk:<path>', …),
// so a blob round-trips between the two stores untouched.

const BASE = '/api/store';

let _probe = null; // Promise<boolean>, cached

async function req(path, opts = {}) {
  const r = await fetch(BASE + path, opts);
  if (r.status === 403) return { denied: true, r };
  if (!r.ok) throw new Error(`system store ${r.status}`);
  return { denied: false, r };
}

// Is a server-side library reachable for this user? Cached; never throws.
export function available() {
  if (!_probe) {
    _probe = (async () => {
      try {
        const { denied, r } = await req('/ping');
        if (denied) return false;
        await r.json();
        return true;
      } catch { return false; }
    })();
  }
  return _probe;
}

// Force the next available() call to re-probe (e.g. after a login).
export function resetProbe() { _probe = null; }

export async function ping() {
  try {
    const { denied, r } = await req('/ping');
    return denied ? null : await r.json();
  } catch { return null; }
}

// [{ role, name, size, at }] — empty when the store is unavailable.
export async function list() {
  try {
    const { denied, r } = await req('/list');
    if (denied) return [];
    return (await r.json()).items || [];
  } catch { return []; }
}

// { name, bytes } or null.
export async function get(role) {
  try {
    const { denied, r } = await req('/get?role=' + encodeURIComponent(role));
    if (denied) return null;
    return { name: role, bytes: new Uint8Array(await r.arrayBuffer()) };
  } catch { return null; }
}

// Upload one blob. Returns true on success. Throws only on quota/size errors so
// a bulk import can report them; transport failures resolve false.
export async function put(role, name, bytes) {
  const q = `?role=${encodeURIComponent(role)}&name=${encodeURIComponent(name || role)}`;
  let r;
  try {
    r = await fetch(`${BASE}/put${q}`, { method: 'PUT', body: bytes.slice() });
  } catch { return false; }
  if (r.status === 403) return false;
  if (r.status === 413 || r.status === 507) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || 'system store rejected the blob');
  }
  return r.ok;
}

export async function del(role) {
  try {
    const { denied } = await req('/del?role=' + encodeURIComponent(role), { method: 'DELETE' });
    return !denied;
  } catch { return false; }
}
