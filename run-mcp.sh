#!/bin/sh
# upd3301-mcp — MCP server launcher
# PORT env (default 9270), 0.0.0.0 bind
cd "$(dirname "$0")/.."
export PORT="${PORT:-9270}"
exec node mcp/server.mjs
