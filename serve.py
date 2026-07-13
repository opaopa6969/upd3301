#!/usr/bin/env python3
"""Static server with Cache-Control: no-cache.

python http.server sends no cache headers, so Cloudflare edge-caches .js
with a default TTL — after a deploy, fresh HTML can import stale modules
(missing-export SyntaxErrors). no-cache = revalidate every time (cheap 304s,
Last-Modified still works); CF respects it and stops caching.

Usage: python3 serve.py [port]
"""
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3301
    HTTPServer(('0.0.0.0', port), NoCacheHandler).serve_forever()
