[English](./smoke.md) · **日本語**

# ブラウザ・スモークテスト

`demo/machine.html` は約3200行あり、6体のエージェントが**一度もブラウザで開かないまま**書いた。
このリポジトリの他のテストはすべてエミュレータの**コア**を叩くもので、ページをmountして
メニューを押してキーを叩くものは一つも無かった。このハーネスは本物のheadless Chromeで
それを9機種ぶんやる。

```sh
npm run smoke              # または: node tools/smoke.mjs
node tools/smoke.mjs --json        # 機械可読レポートをstdoutへ
node tools/smoke.mjs --no-fakeroms # 合成ROMの段階を飛ばす
CHROME_PATH=/path/to/chrome npm run smoke
```

**実行できた**検査が全部通れば exit 0。スクリーンショットと `report.json` は
[`docs/smoke-shots/`](./smoke-shots/) に出て、コミットもされる。
そのコミット時点の証拠がコードの隣に残る。

## 構成

- `tools/cdp.mjs` — Nodeのグローバル `WebSocket` の上に載せた約200行のCDPクライアント。
  **依存ゼロ**（リポジトリの流儀どおり）。ブラウザを**ダウンロードしない**。
  マシンに既にあるもの（`~/.cache/puppeteer`, `~/.cache/ms-playwright`,
  `/usr/bin/google-chrome`, `chromium` …）を探し、無ければ無いと正直に言う。
- `tools/smoke.mjs` — `node:http` の静的サーバ＋検査本体。
- `tools/fakeroms.mjs` — 合成ROMイメージ。**吸い出しではない**。
  ヘッダとリセットベクタだけ正しく、あとはゼロと小さなループ。
  なぜ要るか: デモはROMを読むまで machine オブジェクトを作らず、キーハンドラは
  `if (!machine) return` で始まる。つまりROM無しのスモークテストは**虚空にキーを叩いている**
  だけで何も分からない。合成ROMは**ページ自身のfile input経由**で流し込むので、
  ピッカーの配線ごと端から端まで検査される。

本物のROMはゲームボーイの分だけ。`gbroms/dmg-acid2.gb.gz`（MIT, Matt Currie）が
最初からリポジトリに入っている。

## ここに記録した実行の結果

Chrome 148.0.7778.97 headless / WSL2 · **125検査・125 pass・0 fail・0 skip**

| 機種 | モード切替 | 📁メニューのピッカー | ROM読込 | フレーム進行 | 正しい機種が生きている | キー入力 | 画面 |
|---|---|---|---|---|---|---|---|
| PC-8001 | ok | ok | ok（合成） | ok | ok `80x25 hsync=15360Hz` | ok | [n80.png](./smoke-shots/n80.png) |
| PC-8801 | ok | ok | ok（合成） | ok | ok `hsync=` | ok | [n88.png](./smoke-shots/n88.png) |
| ファミコン | ok | ok | ok（合成） | ok | ok（ボード名が出る） | ok | [nes.png](./smoke-shots/nes.png) |
| PCエンジン | ok | ok | ok（合成） | ok | ok（ボード名が出る） | ok | [pce.png](./smoke-shots/pce.png) |
| メガドライブ | ok | ok | ok（合成） | ok | ok（リージョンが出る） | ok | [md.png](./smoke-shots/md.png) |
| ゲームボーイ | ok | ok | **ok（実ROM）** | ok | ok | ok | [gb.png](./smoke-shots/gb.png) |
| X68000 | ok | ok | ok（合成） | ok | ok `640x512 31kHz` | ok | [x68.png](./smoke-shots/x68.png) |
| アーケード(Seta) | ok | ok | ok（合成） | ok | ok `Thunder & Lightning … ROT270` | ok | [seta.png](./smoke-shots/seta.png) |
| PC-9801 | ok | ok | ok（合成） | ok | ok `640x400` | ok | [pc98.png](./smoke-shots/pc98.png) |

他に確認したこと: 初回ツアーが出てESCで消えること、6つのメニューが実マウスクリックで
開くこと、9本のROMピッカーが開いた📁メニューの中に見えていて**クリックすると本当に
ファイルダイアログが上がる**こと、一時停止・ジョグ・シャトル・◀◀巻き戻しボタン・速度セレクタ、
クリーン/CRT切替、パッド設定パネル、ソフトキーボード（キーを押すところまで）、
PNG出力、リセット。

**consoleエラーは404が3件だけで、全部が想定内・全部が省略可能なリソース** —
`/roms/manifest.json`（任意のROMマニフェスト）、`/favicon.ico`（テストサーバが配らない）、
`/api/store/ping`（`serve.py` の裏でしか存在しないユーザ別ROMストア）。
例外なし、警告なし、それ以外は何も出ない。

## 確認**できていない**こと

ここははっきりさせておく。全部緑でもページが正しいという意味にはならない。

- **実ROM（9機種中8機種）。** 合成ROMが証明するのは「機種が構築でき、ステップし、
  描画し、入力を受け取る」ところまで。**市販ゲームが起動する証明にはならない**。
  実ROMで検証したのはゲームボーイだけ。
- **描画の正しさ。** 「絵が出た、しかも単色ではない」を検査しているのはゲームボーイだけ
  （[gb-dmg-acid2-canvas.png](./smoke-shots/gb-dmg-acid2-canvas.png)＝dmg-acid2の顔）。
  精度はコアのテストの担当で、このハーネスの担当ではない。
- **2機種は正当に真っ黒。** PC-8801とX68000はテストを**呼び出し側が渡すフォント**で
  描くが、このリポジトリにフォントROMは入っていない。だから合成ROMでの実行は
  構造的に真っ黒になる。これは失敗ではないし、正しさの証拠でもない。
- **音。** audio workletは起動する（consoleがそう言う）が、出力を誰も聴いていない。
- **人間の目で見るもの全部**: 小さい画面でのレイアウト、色、CRTシミュレーションが
  CRTらしく見えるか、日本語が読みやすいか。
- **他のブラウザ。** Chromiumのみ。Firefoxもsafariもモバイルも無し。
- **ゲームパッド入力。** Gamepad APIはCDPから駆動できないので、`applyPad` の
  ゲームパッド側は、ビット変換を共有しているキーボード側を通してしか触れていない。
- **ICE / IDE ウィンドウ**（`bice` / `bide` は別ウィンドウを開く）は開いていない。

## 見つかったバグ

1. **何も描かない機種でレンダループが黙り込む。**
   `renderMachine()` が 0×0 のフレームを返したとき——リセット直後の数フレームでは普通に
   起きるし、CRTCを一度もプログラムしないROMでは永久に起きる——ループは
   ステータス行とプレイヤーバーを更新する**前**に
   `requestAnimationFrame(loop); return;` していた。
   結果、**ROMの読み込みに失敗した時と見分けがつかない**: ステータス行は*前の*機種の
   メッセージのままで、CPUは実際には走っているのにフレームカウンタは0のまま。
   **`demo/machine.html` で修正**: 描画は飛ばす、しかし報告はする。
   いまは `PC-8001/N80 0.7ms/frame frame=125 pc=0001h 0x0 hsync=0Hz` のように出て、
   「走ってはいる」と「CRTCが未設定」の両方が読める。
   `render · a 0x0 frame still updates the status line` の検査で守っている。

2. **初回ツアーが全部のクリックを飲み込む（自動操作も含めて）。**
   これは欠陥ではない。`tour.js` は `z-index:9999` の全画面 `position:fixed` オーバーレイで、
   読み込み700ms後に自動で始まり、そこをクリックすれば消える——設計どおり。
   ただし**このページを自動で叩くものは必ず先にツアーを閉じないといけない**。
   実際、ハーネスの最初の版はメニューではなくオーバーレイを押していた。
   直すのではなく検査として記録した（`tour · auto-starts on first visit` /
   `ESC dismisses it` / `nothing overlays the menu bar afterwards`）。

3. （ハーネス側のバグ。記録として。）PC-8001のブートROMとPC-8801の任意のN-mode ROMは
   どちらも `n80.rom` という名前。両方を同じ一時ディレクトリに書いたせいで、
   8001に8801のイメージが黙って渡っていた——それがバグ1をあぶり出した。
   いまは機種ごとに別ディレクトリに置いている。

## そもそもこれを作った動機だったピッカーの退行

📁メニューから消えていた4本（メガドライブ・X68000・Seta・PC-9801）は、
ちゃんと在って押せる。9本すべてが写っている
[menu-file.png](./smoke-shots/menu-file.png) を見てほしい。
検査はわざと厳しくしてある: そのinputは**開いている**パネルの中に居て、
bounding boxが0でなく、クリックすると `Page.fileChooserOpened` が飛ぶこと。
外れたクローンや隠れたクローンは3つとも落ちる。
