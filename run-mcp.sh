#!/bin/sh
# upd3301-mcp — MCP server launcher
# PORT env (default 9270), 0.0.0.0 bind
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
export PORT="${PORT:-9270}"
exec node --experimental-global-webcrypto mcp/server.mjs
