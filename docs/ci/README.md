# CI — 導入手順

`docs/ci/test.yml` を `.github/workflows/test.yml` にコピーすると CI が有効になる。

```sh
mkdir -p .github/workflows && cp docs/ci/test.yml .github/workflows/test.yml
git add .github/workflows/test.yml && git commit -m "ci: node --test と同梱ROM検証を全コミットで回す"
```

**なぜここに置いてあるか**: このファイルを追加したエージェントのトークンに GitHub の
`workflow` スコープが無く、`.github/workflows/` への push が拒否されたため
（`refusing to allow an OAuth App to create or update workflow ... without workflow scope`）。
人間が上記のコピーを1回行うか、トークンに `workflow` スコープを与える必要がある。

## ジョブは2本ある

### 1. `test` — 全体の回帰網

2026-08-08〜10 の自律走行中、毎回の回帰確認を `node test.mjs`（CRTC単体63件）で
済ませ、`node --test`（現在800件超）を回していなかった。その結果、決定論契約の破れ
（`_subMark`/`_subDebt` が snapshot に入っていない。`82da81c` で修正）が
**2日間 main に載ったまま**になった。`test-snapshot.mjs` は**ちゃんと落ちて教えて
いた**。検出器はあったのに、網にかけていなかっただけ。これは測定器を足しても防げ
ない種類の失敗なので、CI で構造的に塞ぐ。

### 2. `gameboy-roms` — 同梱ROMを**実際に走らせる**

issue #42 の一番の価値がこれ。他の機種は再配布できない BIOS を要求するので、
CI ではテストが skip され、「検証済み」は「作者の手元で一度やった」を意味していた。
ゲームボーイは BIOS 不要で、テストROMが MIT なので、`gbroms/` をコミットしてある。
CI は**クリーンな checkout で、何もダウンロードせずに** mooneye 103本と dmg-acid2 を
本当に実行する。

```
mooneye acceptance  59/75   (9 are for other hardware: DMG0 / MGB / SGB)
mooneye MBC         27/28
dmg-acid2           exact match
```

`gbtools/verify.mjs` は数字が下がったら exit 1 する。穴の一覧は毎回印字されるので、
「何本中何本か」がビルドログを見るだけで分かる（テストファイルを読まなくてよい）。

blargg のスイートは**ライセンス表記が無い**ので同梱していない。CI では
`continue-on-error: true` の best-effort ステップで取得して走らせる。ミラーが落ちて
いても、ネットワークが塞がれていても、ビルドは緑のまま。CI が依存してよいのは
同梱コーパスだけ、という線を引いてある。

## 前提

- **node 24 を固定**している。このリポジトリは素の `node` が v12 の環境では
  構文エラーで全滅するので、バージョンが黙って変わると CI の結果が無意味になる
- **依存インストールの手順は無い**。エミュレータと道具は契約として依存ゼロで、
  `package-lock.json` も意図的に存在しない
- ROM が要るテストは**自分で skip する**（`tools/type-test.mjs` は `roms/N80_2.ROM`
  が無ければ skip、`test-snapshot.mjs` 等も同様）。
  gameboy-2 の時点では `tools/type-test.mjs` が import 時に ROM を読んでいて
  skip できず、`test` ジョブは明示的な glob でそのファイルを外していた。
  そのガード（`m88-parity-autorun` の `b5b5d72`）はこの統合ブランチに入っているので、
  glob は外して素の `node --test` に戻してある。
  検証済み: **ROM無し 800 pass / 18 skip / 0 fail**

## 2026-08-10 追記: CI が実際に契約を守るようになった

導入時点では、**この CI を回しても決定論契約は検証されなかった**。
検証していたはずの `test-snapshot.mjs` は全ケースが

```js
if (!rom) return t.skip('no ROM (bring your own)')
```

で始まり、リポジトリは ROM を同梱しないので、**CI 上では必ず skip されていた**。
2日間の破れを見逃した原因はこれで、**「テストがある」と「テストが走る」は別**という
話だった。

`test-determinism.mjs`（`76bc7be`）を追加して解消した。`z80asm.js` で数命令を
合成して機械を走らせるので、**ROM もディスクも要らない**。CI でも新規 clone でも
必ず走る7件:

- 同じプログラムを2回走らせて同一
- snapshot → 前進 → restore → 前進 が同一タイムラインに着地
- **別インスタンスへの restore**（その場 restore は書き戻し忘れを見逃す）
- **サブCPUクロックが snapshot を生き延びる**（今回の回帰そのもの）
- snapshot が ROM を含まない / plain data である
- ディスクを挿しても決定論が壊れない

**契約テストは skip できてはいけない。** skip できるものは skip される。

なお ROM を要求するテスト（`test-fdd.mjs` の基板統合、`tools/type-test.mjs`）は
引き続き skip する。それらは「実タイトルが動くか」の検証であって契約の検証ではないので、
skip されても契約は守られる。この切り分けが今回の教訓。
