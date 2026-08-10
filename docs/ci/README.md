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
済ませ、`node --test`（490件超）を回していなかった。その結果、決定論契約の破れ
（`_subMark`/`_subDebt` が snapshot に入っていない）が **2日間 main に載ったまま**に
なった。`test-snapshot.mjs` は**ちゃんと落ちて教えていた**。検出器はあったのに、
網にかけていなかっただけ。これは測定器を足しても防げない種類の失敗なので、CI で
構造的に塞ぐ。

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
- ROM が要るテストは**自分で skip する**。ただし `tools/type-test.mjs` だけは
  この branch では import 時に `roms/N80_2.ROM` を読むので skip できない。
  そのガードは `m88-parity-autorun`（`b5b5d72`）に入っているので、それがマージ
  されるまでの間、`test` ジョブは `node --test` に明示的な glob を渡して
  そのファイルだけ外している（`node --test` が自力で拾う集合と、それ以外は同一。
  実測 493 tests / 475 pass / 18 skip）
