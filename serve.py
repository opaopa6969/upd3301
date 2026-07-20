#!/usr/bin/env python3
"""Static server: Cache-Control: no-cache + an owner-only gate for opn-scope.

python http.server sends no cache headers, so Cloudflare edge-caches .js
with a default TTL — after a deploy, fresh HTML can import stale modules
(missing-export SyntaxErrors). no-cache = revalidate every time. (Note: a CF
"Browser Cache TTL" rule can still override this at the edge; see
docs/emulator-hosting-design — versioned imports are the belt-and-suspenders.)

Owner-only gate: the opn-scope demo replays real game music (Ys / Sorcerian
OPN register traces + mp3s), which must not be public. The volta-gateway runs
auth only on authenticated hosts (emulator.unlaxer.org) and injects
`X-Volta-User-Id`; on the public host (3301.unlaxer.org) no auth runs, and the
gateway strips any client-supplied `X-Volta-*` (forgery prevention on every
route). So we gate the opn-scope html + its data files on that header:
  - no `X-Volta-User-Id` (public / anonymous)  -> 403
  - `OPNSCOPE_ALLOW` set and id not in it       -> 403
  - otherwise (authenticated, and owner if the allowlist is set) -> served
Set `OPNSCOPE_ALLOW=<your volta user id>` to lock it to the owner alone; leave
it unset to allow any authenticated volta user. The granted user id is logged
(stderr -> journal) so you can discover your id after logging in once.

Per-user ROM/disk library (/api/store/*): the browser keeps ROMs in IndexedDB,
which is per-browser — switch machines or clear site data and a hand-curated
library of hundreds of disks is gone. These endpoints give an AUTHENTICATED user
a server-side copy to re-hydrate from, gated on the same gateway-injected
`X-Volta-User-Id` as opn-scope (so the public host, where the gateway strips
X-Volta-*, gets 403 and the client silently falls back to browser-only).
NOTE this deliberately reverses romstore.js's "the bytes never leave the machine"
stance FOR AUTHENTICATED USERS ONLY — it is the owner's own dumps on the owner's
own private host. Anonymous/public traffic can never reach it.
  GET    /api/store/ping           -> {ok, uid, total, quota}
  GET    /api/store/list           -> {items:[{role,name,size,at}], total, quota}
  GET    /api/store/get?role=R     -> the blob (application/octet-stream)
  PUT    /api/store/put?role=R&name=N  (body = bytes) -> {ok, size}
  DELETE /api/store/del?role=R     -> {ok}
Neither the user id nor the role is ever used as a path component — both are
hashed — so a hostile role string cannot escape the store directory.
Env: USERSTORE_DIR (default ./userdata), USERSTORE_MAX_BLOB, USERSTORE_MAX_TOTAL.

Usage: python3 serve.py [port]
"""
import hashlib
import json
import os
import sys
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# comma-separated volta user ids allowed to reach opn-scope; empty = any authed
ALLOW = {x.strip() for x in os.environ.get('OPNSCOPE_ALLOW', '').split(',') if x.strip()}

_HERE = os.path.dirname(os.path.abspath(__file__))
STORE_DIR = os.environ.get('USERSTORE_DIR') or os.path.join(_HERE, 'userdata')
MAX_BLOB = int(os.environ.get('USERSTORE_MAX_BLOB', 64 * 1024 * 1024))       # 64MB/file
MAX_TOTAL = int(os.environ.get('USERSTORE_MAX_TOTAL', 8 * 1024 * 1024 * 1024))  # 8GB/user
_store_lock = threading.Lock()


def _uid_dir(uid):
    """Per-user directory. The uid is HASHED, never used as a path component."""
    return os.path.join(STORE_DIR, hashlib.sha256(uid.encode('utf-8')).hexdigest()[:16])


def _blob_path(d, role):
    """Blob filename is the hash of the role — arbitrary role strings are safe."""
    return os.path.join(d, 'blobs', hashlib.sha256(role.encode('utf-8')).hexdigest()[:32] + '.bin')


def _index_path(d):
    return os.path.join(d, 'index.json')


def _load_index(d):
    try:
        with open(_index_path(d), 'r', encoding='utf-8') as f:
            idx = json.load(f)
        return idx if isinstance(idx, dict) else {}
    except Exception:
        return {}


def _save_index(d, idx):
    os.makedirs(d, exist_ok=True)
    tmp = _index_path(d) + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False)
    os.replace(tmp, _index_path(d))  # atomic: a crash never leaves a half index


def _index_total(idx):
    return sum(int(v.get('size', 0)) for v in idx.values())


def _is_gated(path):
    p = path.split('?', 1)[0]
    if not p.startswith('/demo/'):
        return False
    return (p.endswith('/opn-scope.html')
            or p.endswith('-trace.json')
            or p.endswith('-regs.json')
            or p.endswith('.mp3'))


class NoCacheHandler(SimpleHTTPRequestHandler):
    def _gate_ok(self):
        if not _is_gated(self.path):
            return True
        uid = self.headers.get('X-Volta-User-Id')  # gateway-injected; client copies are stripped
        if not uid:
            return self._deny('authentication required - this content is owner-only')
        if ALLOW and uid not in ALLOW:
            return self._deny('not authorised for this content')
        sys.stderr.write('[opn-scope] granted uid=%s path=%s\n' % (uid, self.path))
        sys.stderr.flush()
        return True

    def _deny(self, msg):
        body = ('403 Forbidden - opn-scope is owner-only.\n%s\n' % msg).encode('utf-8')
        self.send_response(403)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()  # Cache-Control added by the override below
        self.wfile.write(body)
        return False

    # ---- per-user ROM/disk library -------------------------------------
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _store(self):
        """Handle /api/store/*; return True if this request was ours."""
        u = urlparse(self.path)
        if not u.path.startswith('/api/store/'):
            return False
        # Same gate as opn-scope: the gateway injects this only on authenticated
        # hosts and strips client-supplied copies everywhere, so no header means
        # public/anonymous — never allowed to touch a user library.
        uid = self.headers.get('X-Volta-User-Id')
        if not uid:
            self._json(403, {'error': 'authentication required'})
            return True
        if ALLOW and uid not in ALLOW:
            self._json(403, {'error': 'not authorised'})
            return True
        op = u.path[len('/api/store/'):]
        q = parse_qs(u.query)
        role = (q.get('role') or [''])[0]
        name = (q.get('name') or [''])[0] or role
        d = _uid_dir(uid)
        try:
            with _store_lock:
                idx = _load_index(d)
                if op == 'ping' and self.command == 'GET':
                    self._json(200, {'ok': True, 'count': len(idx), 'total': _index_total(idx), 'quota': MAX_TOTAL})
                elif op == 'list' and self.command == 'GET':
                    items = [{'role': r, 'name': v.get('name', r), 'size': int(v.get('size', 0)),
                              'at': int(v.get('at', 0))} for r, v in sorted(idx.items())]
                    self._json(200, {'items': items, 'total': _index_total(idx), 'quota': MAX_TOTAL})
                elif op == 'get' and self.command == 'GET':
                    if not role or role not in idx:
                        self._json(404, {'error': 'no such role'})
                    else:
                        with open(_blob_path(d, role), 'rb') as f:
                            blob = f.read()
                        self.send_response(200)
                        self.send_header('Content-Type', 'application/octet-stream')
                        self.send_header('Content-Length', str(len(blob)))
                        self.end_headers()
                        self.wfile.write(blob)
                elif op == 'put' and self.command in ('PUT', 'POST'):
                    n = int(self.headers.get('Content-Length') or 0)
                    if not role:
                        self._json(400, {'error': 'role required'})
                    elif n <= 0 or n > MAX_BLOB:
                        self._json(413, {'error': 'blob too large or empty', 'max': MAX_BLOB})
                    elif _index_total(idx) - int(idx.get(role, {}).get('size', 0)) + n > MAX_TOTAL:
                        self._json(507, {'error': 'quota exceeded', 'quota': MAX_TOTAL})
                    else:
                        blob = self.rfile.read(n)
                        bp = _blob_path(d, role)
                        os.makedirs(os.path.dirname(bp), exist_ok=True)
                        tmp = bp + '.tmp'
                        with open(tmp, 'wb') as f:
                            f.write(blob)
                        os.replace(tmp, bp)
                        idx[role] = {'name': name, 'size': len(blob), 'at': int(time.time())}
                        _save_index(d, idx)
                        self._json(200, {'ok': True, 'size': len(blob)})
                elif op == 'del' and self.command == 'DELETE':
                    if role in idx:
                        try:
                            os.remove(_blob_path(d, role))
                        except OSError:
                            pass
                        del idx[role]
                        _save_index(d, idx)
                    self._json(200, {'ok': True})
                else:
                    self._json(404, {'error': 'unknown op'})
        except Exception as exc:  # never leak a traceback to the client
            sys.stderr.write('[store] error uid=%s op=%s: %r\n' % (uid, op, exc))
            sys.stderr.flush()
            self._json(500, {'error': 'store failure'})
        return True

    def do_GET(self):
        if self._store():
            return
        # No server-side ROM manifest? Return an empty one (200 {}) instead of a
        # 404. machine.html handles both identically (falls back to BYO-ROM), but
        # the empty 200 keeps the browser console clean.
        p = self.path.split('?', 1)[0]
        if p == '/roms/manifest.json' and not os.path.exists(self.translate_path(p)):
            body = b'{}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self._gate_ok():
            super().do_GET()

    def do_PUT(self):
        if not self._store():
            self._json(405, {'error': 'method not allowed'})

    def do_POST(self):
        if not self._store():
            self._json(405, {'error': 'method not allowed'})

    def do_DELETE(self):
        if not self._store():
            self._json(405, {'error': 'method not allowed'})

    def do_HEAD(self):
        if self._gate_ok():
            super().do_HEAD()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3301
    if ALLOW:
        sys.stderr.write('[serve] opn-scope restricted to user ids: %s\n' % ', '.join(sorted(ALLOW)))
    HTTPServer(('0.0.0.0', port), NoCacheHandler).serve_forever()
