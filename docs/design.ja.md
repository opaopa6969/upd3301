[English](./design.md) · **日本語**

# 設計 — upd3301

## 契約（suite-contract 準拠）

- pure・依存ゼロのJavaScript。DOMなし・`three`なし・`Math.random`禁止。
- 決定論：同じポート書き込み＋同じメモリ＋同じ `update(dt)` 列 →
  ビット単位で同一の画面。ブリンク位相はフレームカウンタのみから導出。
- 固定ステップ：`update(dt)` は秒を積算し `frameHz`（既定60）でフレーム
  単位に実行。テスト用に `stepFrame()` も公開。
- 出力は plain data + `schemaVersion`：`getScreen()` はスカラと typed array
  （文字コード、生アトリビュートペア、展開済みアトリビュート）を返す。
  コアはアトリビュートバイトの「意味」を決めない — 下流が読んで判断する。

## レイヤと依存の向き

```
index.js  （μPD3301チップ — メモリも色もPC-8001も知らない）
upd8257.js（μPD8257 DMA — CRTCを知らない）
   ↑ 両方を import するのが
pc8001.js（配線＋アトリビュート意味論＋レンダラ＝「下流」）

crt.js   （物理層1: 蛍光体 — GRBインデックスのフレームを消費）
tube.js  （物理層2: マスク/ガラス — リニア光の3プレーンを消費）
   ↑ 全部を組み合わせるのは
demo/    （ブラウザデモ。手描きCGROMを注入）
```

論理スタック（index/upd8257/pc8001）と物理スタック（crt/tube）は互いに
import しない。demo/テストの層でだけ、plain data（インデックス画素→
輝度プレーン→RGBA）で接続される。物理スタック内では tube.js が crt.js の
純関数ヘルパ（tintMatrix）のみを import する。

`index.js` と `upd8257.js` は sibling を import しない。ループを閉じる
コーディネータ（DRQ → DMA pull → 行バイト）は `Pc8001TextSystem`。

## 主要スキーマ

`getScreen()`（schemaVersion 1）:
`{cols, rows, linesPerChar, skipLine, reverseDisplay, displayEnabled, frame,
cells: u8[rows*cols], attrs: u8[rows*cols], attrPairs: u8[rows*attrsPerRow*2],
attrsPerRow, attrMode, cursor {x, y, enabled, blink, block, on}, attrBlinkOn}`

`renderScreen()` → `{width, height, pixels: u8[w*h]（0..7 GRBインデックス）,
schemaVersion}`。

## 設計判断

- **DRQはpull型コールバック。** チップは行ごとに `drq(buf)` を呼び
  `桁数 + 2×アトリビュート数` バイトを期待。不足はUビット（アンダーラン）
  を立て、非公開のステータスbit7が落ちる — 実機と同じ。
- **アトリビュート展開**はMAMEの `default_attr_fetch` 準拠
  （fill-forward。先頭ペアは0桁目まで遡って充填。2ペア目以降の位置0は
  行末扱い — N-BASICが未使用スロットをそう埋めるため）。
- **PC-8001の2状態デコード**はチップの外：カラー指定（bit3=1）と機能指定
  （bit3=0）は別々の状態を更新する。色を変えても反転/点滅は解除されない。
- **CGROMは注入式。** 実機のキャラジェネROMは著作物なので同梱しない。
  テストは合成グリフ、デモは手描き5×7フォント。
- **タイミングはフレーム粒度。** ドットクロックなし。1フレーム分のDMAは
  `stepFrame()` 内で行順に実行（実機の水平帰線バーストと同順）。VRTCは
  フレーム終端の割り込み/ステータスとして観測（フレーム途中の線は見えない）。

## やらないこと

ライトペン、特殊制御文字（STATUS N）、DMAキャラクタモードとバースト
モードの区別、コンポジット映像のアーティファクトカラー。

## 検証

`node --test`（16本）：ジオメトリのデコード、行DMAバイト数、アンダーラン、
アトリビュート展開、VRTC割り込みマスク、カーソルブリンクの決定論、
固定ステップのフレーム正確性、8257のフリップフロップ/オートロード、
2状態アトリビュートデコード、フルシステム描画の決定論（2回実行の
ビット一致）、ベーマガ27色技（カウント2倍→2画面交互→オートロードで
巻き戻り）、40桁ドット倍幅、画面反転。
