# MCP 化設計 — upd3301

> Phase 2 / 設計。namespace `upd3301`、種別 `wrap`（既存ライブラリを薄く包む）。
> 割当表 `docs/MCPIFY-phase2-plan.md` #80: port 9270。

## 1. namespace と種別

- **namespace**: `upd3301`
- **種別**: `wrap` — 既に volta にサービスとして登録済み（`3301.unlaxer.org`, port 3301, `/healthz` あり）だが MCP バックエンドが無い。既存の pure JS ライブラリ関数を薄く包んで MCP tool として公開する。エミュレーション実行系（ROM必須）は対象外。

## 2. tools 表

全 tool 副作用 `none`（純粋計算）、dry-run 不要、job 型不要、即時応答。`min_role` = `MEMBER`。

| name | 目的 | 入力 schema（要点） | 出力の形 | 副作用 | job型 | 所要 | maps_to |
|---|---|---|---|---|---|---|---|
| `z80_assemble` | Z80ソースをアセンブルする | `source: string`, `org?: number` | `{bytes(hex), org, symbols, listing, errors, warnings, fixups}` | none | no | <100ms | `z80asm.js:assemble()` |
| `z80_disassemble` | Z80バイナリを逆アセンブルする | `bytes: string(hex)`, `addr?: number`, `syntax?: "zilog"\|"intel"` | `{text, len, bytes(hex)}` | none | no | <100ms | `z80dis.js:disasm()` |
| `crt_render` | フレームをCRT物理（蛍光体・マスク・管面）でレンダリングする | `pixels: string(hex or base64)`, `width: int`, `height: int`, `mode: "indexed"\|"rgba"`, `phosphor?: string`, `mask?: string`, `barrel?: number`, `gamma?: number` | `{rgba(base64), width, height}` | none | no | <500ms | `crt.js:CrtPhosphor` + `tube.js:CrtTube` |
| `rom_identify` | ROMファイル名を識別して役割に割り当てる | `filename: string`, `size?: number` | `{role, label, sizes, supported, sizeWarn}` \| null | none | no | <10ms | `romid.js:identify()` |
| `analysis_validate` | 解析レコードを検証する | `doc: object(JSON)` | `{ok, errors, warnings}` | none | no | <10ms | `analysisdb.js:validate()` |
| `analysis_merge` | 2つの解析レコードをマージする | `docA: object`, `docB: object`, `force?: bool`, `allowUnknownRom?: bool` | `{ok, doc, conflicts, warnings}` | none | no | <10ms | `analysisdb.js:merge()` |
| `d88_info` | D88ディスクイメージのメタデータを読む | `bytes: string(hex or base64)` | `{name, media, tracks, sectors, bytes, sectorSizes, oddities, writeProtect}` | none | no | <10ms | `d88.js:parseD88All()` + `summarize()` |

全 tool に `annotations: { readOnlyHint: true, idempotentHint: true }` を付ける（全て純粋関数・副作用なし）。`destructiveHint` は付けない。

### CRT レンダリングの I/O 形式（暫定）

Phase 1 の open question #1 への回答: base64 RGBA で出力する（PNGエンコーダは依存ゼロ方針に反するため追加しない）。入力は indexed（0..7, 1 byte/pixel）または RGBA（4 bytes/pixel）を hex/base64 で。

## 3. resources 表

| uri | 内容 | mime |
|---|---|---|
| `upd3301://spec` | 能力の機械可読仕様（tools/list から自動生成 + compositions/depends_on 手書き） | `application/json` |
| `upd3301://guide` | 使い方ガイド（各 tool の入出力例・組み合わせ方） | `text/markdown` |
| `upd3301://rom_hashes` | ROM ハッシュ表（romid.js の ROM_TABLE を JSON 化） | `application/json` |

## 4. prompts / skills

### skill: `retro-reverse-analysis`

- **用途**: レトロPCの逆アセンブルと解析の手順（z80_disassemble → rom_identify → d88_info → analysis_validate → analysis_merge の流れ）
- **locality**: `repo`
- **applies_when**: Z80バイナリやD88ディスクイメージを解析するとき
- **requires**: tools `[z80_disassemble, rom_identify, d88_info, analysis_validate, analysis_merge]`
- **min_role**: `MEMBER`

ファイル: `docs/skills/retro-reverse-analysis/SKILL.md`

## 5. 組み合わせ例

1. **Z80 アセンブル往復テスト**: `upd3301__z80_assemble` → Z80コードをアセンブル → 得た bytes を `upd3301__z80_disassemble` で逆アセンブル → 元のソースと一致するか確認
2. **CRT レトロ風レンダリング**: 他サービス（showcase / design）の生成したピクセル → `upd3301__crt_render` でCRT物理レンダリング → レトロ風映像素材
3. **ROM解析パイプライン**: `upd3301__rom_identify` → ファイル名識別 → `upd3301__d88_info` → ディスク構造把握 → `upd3301__analysis_validate` → 解析レコード検証 → `upd3301__analysis_merge` で統合

## 6. 依存と協調

| 相手 repo | 向き | 能力 | 合意したいこと | 暫定案 |
|---|---|---|---|---|
| `ttyd-crt` | provides_to | CRT物理レンダラー (`crt.js` + `tube.js`) | `upd3301__crt_render` が ttyd-crt 側から直接呼べるか | 暫定: `crt_render` は独立して動く。ttyd-crt 側がこの tool を使う場合は hex RGBA で受け渡す |

issue-hub に `ttyd-crt` 宛の協調 issue を登録する（返答を待たず暫定仕様で進める）。

## 7. 非対応にした候補と理由

- **68000逆アセンブラ**: `m68000.js` に逆アセンブル機能が無い（ニーモニックが出ない）ため対象外
- **エミュレーション実行系** (`machine.stepFrame`, ICE, RNG分析): ROM必須・著作権リスク → agent が直接触る価値が薄い
- **Z80マクロアセンブラの include 機能**: ファイルシステムアクセスが要るため MCP では `source` テキストのみ対応

## 8. 参加方法

- **manifest**: `volta.service.json`（root）— 既存の `upd3301` エントリに `mcp` ブロックを追加
- **ポート**: 9270（割当表 #80。machine_ports で空き確認済み）
- **ホスト**: `192.168.1.50`（prod）
- **runtime**: `node`（systemd user unit）
- **auth**: `minRole: MEMBER`（既存サービスと同じ public visibility）
- **hostname**: `3301.unlaxer.org`（既存。MCP は別ポート 9270 で別プロセス）
- **exec_start**: `/home/opa/upd3301-mcp/run.sh`

既存の `serve.py`（port 3301）とは別プロセス。MCP サーバは `mcp/server.mjs`（Node.js, `/mcp` + `/healthz`, `PORT` env, `0.0.0.0` bind）。

## 9. テスト方針

e2e テスト（`mcp/test.mjs`）:
1. サーバ起動 → `/healthz` が 200
2. MCP クライアント（`StreamableHTTPClientTransport`）で `tools/list` → 7 tool が `upd3301` prefix 無しで見える
3. `z80_assemble` に "NOP\nJP 0" → bytes が `00 C3 00 00`
4. `z80_disassemble` に往復テスト
5. `rom_identify` に "n88.rom" → role が `n88main`
6. `d88_info` に最小D88 → メタデータが返る
7. `analysis_validate` に最小 doc → ok が true
8. `analysis_merge` に2つの doc → マージ結果
9. `crt_render` に小さい indexed pixels → RGBA が返る
10. `upd3301://spec` resource が取得できる
11. `upd3301://guide` resource が取得できる

CI があるなら `npm test` に組み込む。
