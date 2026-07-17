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

Usage: python3 serve.py [port]
"""
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

# comma-separated volta user ids allowed to reach opn-scope; empty = any authed
ALLOW = {x.strip() for x in os.environ.get('OPNSCOPE_ALLOW', '').split(',') if x.strip()}


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

    def do_GET(self):
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
