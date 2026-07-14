// romstore.js — per-browser ROM/disk persistence in IndexedDB.
//
// The emulator is pure client-side JS and ships with NO ROMs (NEC's N-BASIC,
// game disks — all copyrighted). A user brings their own dump. Without storage
// they'd re-pick the files on every reload; this keeps each uploaded blob in
// the browser's IndexedDB, keyed by role, so a return visit auto-boots. The
// bytes never leave the machine — this is "upload once", not "upload to us".
//
// Roles: 'rom' (boot ROM), 'font' (CGROM), 'disk' (a .d88 image). Extend freely.

const DB = 'upd3301-roms';
const STORE = 'blobs';

function open() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => { rq.result.createObjectStore(STORE, { keyPath: 'role' }); };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

function tx(db, mode) { return db.transaction(STORE, mode).objectStore(STORE); }

export async function putRom(role, name, bytes) {
  const db = await open();
  return new Promise((resolve, reject) => {
    // store a copy of the bytes (a Uint8Array view over a transferred buffer
    // can detach); slice() gives IndexedDB a stable ArrayBuffer to clone.
    const rq = tx(db, 'readwrite').put({ role, name, bytes: bytes.slice(), at: 0 });
    rq.onsuccess = () => resolve();
    rq.onerror = () => reject(rq.error);
  });
}

export async function getRom(role) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const rq = tx(db, 'readonly').get(role);
    rq.onsuccess = () => resolve(rq.result ? { name: rq.result.name, bytes: new Uint8Array(rq.result.bytes) } : null);
    rq.onerror = () => reject(rq.error);
  });
}

export async function listRoms() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const rq = tx(db, 'readonly').getAll();
    rq.onsuccess = () => resolve((rq.result || []).map((r) => ({ role: r.role, name: r.name, size: r.bytes.byteLength })));
    rq.onerror = () => reject(rq.error);
  });
}

export async function clearRoms() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const rq = tx(db, 'readwrite').clear();
    rq.onsuccess = () => resolve();
    rq.onerror = () => reject(rq.error);
  });
}
