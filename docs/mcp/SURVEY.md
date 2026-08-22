# MCP 化調査 — upd3301

> Phase 1 / 読み取り中心。設計・実装・issue 登録はしない。

## 概要

NEC μPD3301 CRTC エミュレータを起点に、PC-8001 / PC-8801 / PCエンジン /
メガドライブ / ファミコン / X68000 / PC-9801 / ゲームボーイ / セタアーケード
をブラウザで動かす純 JavaScript エミュレータ。依存ゼロ・決定論・headless
テスト可能。既に `3301.unlaxer.org` で稼働中（systemd, `/healthz` あり）。
`package.json` の subpath exports で多数のライブラリモジュールを公開している。

## 判定と理由

**判定: `wrap`** — 既存のライブラリ関数を薄く包んで MCP tool として公開する。

理由:
- 既に volta にサービスとして登録済み（`3301.unlaxer.org`, healthz 有り）だが
  MCP バックエンドは無い。
- エミュレーション本体はブラウザ内で動き、著作権ROM（NEC分は2049年まで）を
  要するため、agent が直接触る価値は薄い。
- 一方、以下は pure JS・依存ゼロ・ROM不要で、agent が呼んで嬉しい計算能力:
  - Z80 マクロアセンブラ（`z80asm.js`）
  - Z80 逆アセンブラ（`z80dis.js`）
  - CRT 物理レンダラー（`crt.js` + `tube.js`）
  - ROM 識別（`romid.js`）
  - 解析DB 検証・マージ（`analysisdb.js`）
  - D88 ディスクメタデータ読み取り（`d88.js`）
- これらを薄く包む MCP サーバを立て、volta catalog の `upd3301` エントリに
  mcp バックエンドを追加すれば参加できる。規約のうち新規実装が必要なのは
  MCP サーバ本体（`/mcp`, `/healthz`, `PORT`, `0.0.0.0` bind）のみ。

## 公開候補

| kind | name | io | 副作用 | 長時間 | 対応 |
|---|---|---|---|---|---|
| tool | `z80_assemble` | source + {org} → {bytes, symbols, listing, errors, warnings} | none | no | `z80asm.js:assemble()` |
| tool | `z80_disassemble` | bytes + addr → {text, len, bytes} | none | no | `z80dis.js:disasm()` |
| tool | `crt_render` | indexed/RGBA pixels + {phosphor, mask, barrel, w, h} → RGBA (base64) | none | no | `crt.js:CrtPhosphor` + `tube.js:CrtTube` |
| tool | `rom_identify` | filename → {role, label, sizes, supported} \| null | none | no | `romid.js:identify()` |
| tool | `analysis_validate` | analysis doc (JSON) → {ok, errors, warnings} | none | no | `analysisdb.js:validate()` |
| tool | `analysis_merge` | doc A + doc B → {doc, conflicts, warnings} | none | no | `analysisdb.js:merge()` |
| tool | `d88_info` | D88 bytes (hex) → {name, media, sectors, ...} | none | no | `d88.js:parseD88()` |
| resource | `spec` | `upd3301://spec` — 能力の機械可読仕様 | — | — | — |
| resource | `guide` | `upd3301://guide` — 使い方 | — | — | — |
| resource | `rom_hashes` | `upd3301://rom_hashes` — ROMハッシュ表 | — | — | `index.html` |
| skill | `retro-reverse-analysis` | レトロPCの逆アセンブルと解析の手順 | — | — | locality: repo |

## 組み合わせ例

1. `upd3301__z80_assemble` → Z80コードをアセンブル → 得た bytes を
   `upd3301__z80_disassemble` で逆アセンブル（往復テスト）
2. `upd3301__crt_render` → 他サービス（showcase / design）の生成した
   ピクセルをCRT物理でレンダリング → レトロ風映像素材
3. `upd3301__rom_identify` → ROMファイル名を識別 →
   `upd3301__d88_info` → ディスク構造を把握 → 解析DBに記録

## 依存と協調

| 相手 repo | 向き | 能力 | 現状 | 備考 |
|---|---|---|---|---|
| `ttyd-crt` | provides_to | CRT物理レンダラー (`crt.js` + `tube.js`) | exists_now | `ttyd-crt` はこのリポジトリの `crt.js`/`tube.js` を使ってターミナル出力をCRT管面でレンダリング。volta catalog に `crt.unlaxer.org` として登録済み |

Phase 2 で issue-hub に協調を起票する可能性: `ttyd-crt` 側が
`upd3301__crt_render` を直接呼べるようになれば、CRTガラスの更新を
両リポジトリで一元化できる。

## ライブラリのサーバ化

該当しない（`needed: false`）。既にサービスとして稼働中のため、新規に
サーバを立てるのではなく、既存の `serve.py` とは別ポートで MCP サーバ
プロセスを追加し、volta catalog の `upd3301` エントリに mcp バックエンド
を追加する形。

新規作業:
- MCP サーバ本体（Node.js, `/mcp` + `/healthz`, `PORT` env, `0.0.0.0` bind）
- volta catalog の `upd3301` エントリに mcp バックエンドを追加

推定規模: **S**

## リスク

- **ROM著作権**: アセンブラ/逆アセンブラ/CRTレンダラー/ROM識別/解析DB は
  ROM不要だが、エミュレーション実行系は BYO-ROM 必須（NEC著作権 2049年まで）
  → agent が直接触る対象から外した。
- **CRTレンダリングのI/O形式**: `Uint8Array` を MCP で受け渡すには
  base64/hex エンコードが必要。PNG出力なら別途エンコーダが要る
  （repo は依存ゼロ方針）。
- **決定論**: 保証済み（`Math.random` 不使用）だが、MCP サーバの
  プロセス管理・状態は別途設計が必要。
- **解析DBの merge**: 可換・結合的・冪等だが、スキーマバージョン不一致や
  `romHash` 不一致を弾くため、呼び手がスキーマを理解している必要がある。

## 持ち主への質問

1. CRTレンダリング tool の出力形式を base64 RGBA にするか、PNG画像にするか
   （PNGエンコーダ追加の可否）。
2. MCP サーバを `serve.py` と同じポートでは動かせない（別ポート or 別
   プロセス）。volta catalog の `upd3301` エントリに mcp バックエンドを
   追加する形でよいか。
3. `z80asm.js` / `z80dis.js` 以外に、68000 逆アセンブラ（現在未実装・
   ニーモニックが出ない）を MCP tool に含めるか。
4. 解析DBの tool 化で、`merge` の `opts`（`force` / `allowUnknownRom`）を
   どう公開するか。
