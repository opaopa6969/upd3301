# MCP 化ステータス — upd3301

## 状態: registered（volta 参加完了）

### 完了

- **Phase 1** (survey): `docs/mcp/survey.json`, `docs/mcp/SURVEY.md`
- **Phase 2 (A) 設計**: `docs/mcp/DESIGN.md` — namespace `upd3301`, port 9270, 7 tools + 3 resources + 1 skill
- **Phase 2 (B) 協調**: issue-hub #340 (`ttyd-crt` 宛、crt_render の入出力形式)。返答待ち、暫定仕様で進行。
- **Phase 2 (C) 実装**:
  - `mcp/server.mjs` — Streamable HTTP `/mcp` + `/healthz`, PORT env, 0.0.0.0 bind
  - 7 tools: z80_assemble, z80_disassemble, crt_render, rom_identify, analysis_validate, analysis_merge, d88_info
  - 3 resources: `upd3301://spec`, `upd3301://guide`, `upd3301://rom_hashes`
  - 1 skill: `docs/skills/retro-reverse-analysis/SKILL.md`
  - `mcp/test.mjs` — e2e テスト 12件 全通過
  - `volta.service.json` — 既存 upd3301 エントリに mcp ブロック追加
  - `deploy/upd3301-mcp.service` — systemd user unit
  - `run-mcp.sh` — 起動スクリプト (Node.js v18 互換: `--experimental-global-webcrypto`)
- **Phase 2 (D) volta 参加**:
  - `volta__svc_add` dry-run → 確認 → `confirm: true`（既存の public visibility 維持、mcp ブロック追加）
  - PR #89/#90/#91 を main にマージ → prod で git pull
  - systemd user unit `upd3301-mcp.service` enable --now
  - `curl http://127.0.0.1:9270/healthz` → 200
  - `curl https://3301.unlaxer.org/healthz` → 200
  - `catalog__backend_status` → namespace `upd3301` status `ready`, tools 7, resources 3
  - `catalog__audit_backend` → connect ok, tools ok, spec ok, guide ok, annotations ok, healthz ok

### 監査 smoke テストについて

`catalog__audit_backend(smoke=true)` の smoke は全 tool が引数必須のため引数なしで失敗する（仕様: readOnlyHint tool を引数なしで呼ぶ）。サーバ側の問題ではない。本体の監査チェック（connect/tools/spec/guide/annotations/healthz）は全て ok。

### gateway_routes_diff について

`volta__gateway_routes_diff` の結果に `[新規] yume.unlaxer.org` が含まれたが、これは別エージェントが services.json に追加した yume-engine のもので、自分の upd3301 の変更ではない。upd3301 の gateway ルート（3301.unlaxer.org）は既存のまま変更なし。

### issue-hub

- issue #340: `[mcp] upd3301 ↔ ttyd-crt: crt_render tool の協調` — 返答待ち、暫定仕様で実装完了

### 未決事項

1. ttyd-crt 側からの返答待ち（crt_render の入出力形式の確定）
2. Node.js v24 未満の prod 環境で `--experimental-global-webcrypto` が必要（volta-mcp の SDK が globalThis.crypto を使うため）。Node.js v24+ では不要。

### PR

- PR #89: feat: MCP backend (namespace upd3301, port 9270) — MERGED
- PR #90: fix: run-mcp.sh cwd — MERGED
- PR #91: fix: Node.js v18 crypto — MERGED
