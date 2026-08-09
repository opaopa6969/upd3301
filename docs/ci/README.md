# CI — 導入手順

`docs/ci/test.yml` を `.github/workflows/test.yml` にコピーすると CI が有効になる。

```sh
mkdir -p .github/workflows && cp docs/ci/test.yml .github/workflows/test.yml
git add .github/workflows/test.yml && git commit -m "ci: node --test を全コミットで回す"
```

**なぜここに置いてあるか**: このファイルを追加したエージェントのトークンに GitHub の
`workflow` スコープが無く、`.github/workflows/` への push が拒否されたため
（`refusing to allow an OAuth App to create or update workflow ... without workflow scope`）。
人間が上記のコピーを1回行うか、トークンに `workflow` スコープを与える必要がある。

## なぜ CI が要るか

2026-08-08〜10 の自律走行中、毎回の回帰確認を `node test.mjs`（CRTC単体63件）で
済ませ、`node --test`（313件）を回していなかった。その結果、決定論契約の破れ
（`_subMark`/`_subDebt` が snapshot に入っていない。`82da81c` で修正）が
**2日間 main に載ったまま**になった。

`test-snapshot.mjs` は**ちゃんと落ちて教えていた**。検出器はあったのに、網に
かけていなかっただけ。これは測定器を足しても防げない種類の失敗なので、
CI で構造的に塞ぐ。

## 前提

- **node 24 を固定**している。このリポジトリは素の `node` が v12 の環境では
  構文エラーで全滅するので、バージョンが黙って変わると CI の結果が無意味になる
- **依存インストールの手順は無い**。エミュレータと道具は契約として依存ゼロで、
  `package-lock.json` も意図的に存在しない
- ROM が要るテストは**自分で skip する**（`tools/type-test.mjs` は `roms/N80_2.ROM`
  が無ければ skip、`test-snapshot.mjs` 等も同様）。
  検証済み: **ROM無し 296 pass / 17 skip / 0 fail、ROMあり 313 pass / 0 fail**
