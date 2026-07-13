# crt-xterm — xterm.js を1979年のCRTにするレンダラーaddon

[English](./README.md) · **日本語**

いつものwebターミナル、ただし光子だけ45年前。このaddonはxterm.js標準の
レンダラーを隠して、毎フレームをこのrepoのCRT物理スタックに通して描き直す:
セル → 8×8ビットマップグリフ → GRB 8色フレーム → [`crt.js`](../crt.js) の
蛍光体減衰 → [`tube.js`](../tube.js) のシャドウマスク/バレル/走査線 →
canvas。入力・選択の挙動・クリップボード・IMEは100% xterm.jsのまま —
差し替わるのは光だけ。

## addonの使い方

xterm.js は **peer依存**（addonはimportしない）。xterm.jsを好きな方法で
読み込んでから:

```html
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script type="module">
  import { CrtRendererAddon } from './xterm/crt-xterm.js';

  const term = new Terminal({ cursorBlink: false });
  term.open(document.getElementById('terminal'));
  term.loadAddon(new CrtRendererAddon({
    phosphor: 'P22',     // P22 | LONG | P39 | P7 | AMBER | PLASMA
    mask: 'aperture',    // aperture | shadow | slot | none
    maskPitch: 3,
    barrel: 0.06,
    focus: 0.8,          // ビーム幅（FOCUSノブ）
    bright: 1.2,
    contrast: 1.0,
    flicker: false,      // 決定論の10Hzビート（撮影フリッカー再現）
    strict1979: false,   // セル背景色を捨てる（PC-8001の真実）
    cursorBlink: true,
    outputScale: 2,      // 出力解像度の倍率（性能ノブ）
  }));
</script>
```

実行中の操作: `addon.setOptions({ phosphor: 'P39' })`、
`addon.setEnabled(false)`（xterm.js標準描画へライブ復帰）、
`addon.dispose()`。

色は1979年のGRB 8色へ量子化する — xtermの16/256/truecolorは全部
黒/青/赤/マゼンタ/緑/シアン/黄/白の最近傍へ落ちる。暗い色は最大チャンネル
基準で救済（navyは黒でなく青になる）。`strict1979: true` はさらにセル単位の
背景色を捨てる。反転表示は生きる — 実機が背景色を偽装した方法そのものだから。

## ttyd: ファイル1個、フラグ1個

[ttyd](https://github.com/tsl0922/ttyd)（MIT）は `--index` でクライアント
ページを差し替えられる。単一ファイルをビルドして:

```sh
node xterm/build.mjs                       # → xterm/dist/ttyd-crt.html
ttyd --writable --index xterm/dist/ttyd-crt.html bash
```

デプロイはこれで全部。`dist/ttyd-crt.html` には `crt-xterm.js` + `crt.js` +
`tube.js` + `demo/font.js`（すべて自作コード）がインライン埋め込み済みで、
xterm.jsとfit addonだけページロード時にjsDelivr CDNから来る。ページは
ttydのWebSocketプロトコルを実装している（サブプロトコル `tty`、クライアント
は `{AuthToken, columns, rows}` 送信後 `'0'+入力` / `'1'+リサイズJSON` /
`'2'`=pause / `'3'`=resume、サーバは `'0'+出力` / `'1'+タイトル` /
`'2'+設定`）。フロー制御と自動再接続込み — ttyd mainの
`html/src/components/terminal/xterm/index.ts` で裏取り済み。

サーバからの設定注入も効く: `--client-option crtPhosphor=P39` のような
`crt*` キーはaddonへ、それ以外はxterm.jsのoptionsへ流れる。

ページには畳めるノブパネル（蛍光体/マスク/明るさ/フリッカー/strict-1979、
localStorageに保存）と、標準レンダラーへ戻す **CRT** トグルがある。ttydの
いない場所で開くと（例: `python3 serve.py`）ローカルエコーのデモモードに
落ちる。`?ws=` でWebSocket先を上書きできるので、開発ページから本物のttydに
も繋げる。

### volta-platform への組み込み

各ttydインスタンスに起動引数を1個足すだけ。volta側のコード変更はゼロ:

1. `xterm/dist/ttyd-crt.html` をサービスから読める場所へコピー
   （例: `/opt/volta/assets/ttyd-crt.html`）。
2. そのインスタンスのttyd起動コマンドに
   `--index /opt/volta/assets/ttyd-crt.html` を追加。
3. リバースプロキシ設定は無変更でいい: ページは自分のURLから `/token` と
   `/ws` を導出する（純正クライアントと同じ規則）ので、パスマウントされた
   インスタンスもそのまま動く。

## 開発

- `xterm/ttyd-crt.html` は開発ページ**兼**ビルドテンプレート。
  `BUILD:BUNDLE` マーカー間で本物のESモジュールを読み、
  `node xterm/build.mjs` がそこをインラインバンドルへ差し替える。
- `build.mjs` は依存ゼロの素朴なバンドラで、このrepoのコードスタイルしか
  理解しない。扱えると証明できない構文が残ったら黙って壊れず throw する。
- テスト: `node --test test-crt-xterm.mjs`（headless — ラスタコアはフェイク
  バッファを食べ、ビルドテストは出力バンドルを実際に評価する）。

## 既知の制約

- **ASCIIのみ。** 印字可能ASCII（小文字含む）は手描き5×7グリフ、それ以外 —
  CJK・罫線・絵文字 — は市松模様の豆腐になる。日本語表示は明示的にスコープ外。
- 選択ハイライトとカーソルはaddonが描き直す（ハードウェア風の反転表示）。
  xtermのdecoration/オーバーレイとIMEプレビューはCRT中は見えない。
- 見た目はheadlessでは**未検証** — パイプラインはRGBAバイトまでテスト済み、
  実際の光り方は目視が必要。
- distページはロード時にCDN到達が必要（xterm.jsはMITだが他人のコードなので
  埋め込まない）。

## ライセンス

このrepoと同じMIT。単一ファイルビルドに埋め込むのは自作コードのみ
（`crt.js`・`tube.js`・`demo/font.js` — フォントは手描き、public domain、
うちのもの）。xterm.js（MIT）とttyd（MIT）は外部依存として使うだけで、
ここでは再配布しない。
