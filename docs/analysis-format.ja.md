[English](./analysis-format.md) · **日本語**

# 解析フォーマット — 主張だけでなく証拠を添えて共有する

解析成果はすでにファイルとして出ている。ICE の Label DB
（[ice-design](./ice-design.ja.md)）、乱数の呼び出し元マップ（#38）、乖離の調査記録
（[m88-comparison](./m88-comparison.ja.md)）。足りなかったのは**共通の形式**と**置き場所**
だけで、それさえあれば成果はスクリーンショットではなく **pull request** として流通する。

- `analysisdb.js` — 読み書き・検証・マージ。pure・依存ゼロ・決定論。
- `analysis/<machine>/<slug>.json` — 成果物そのもの。
- `test-analysisdb.mjs` — `node --test`。**ROM不要**で走る。

## 掲示板ではなく git な理由

| | 掲示板 | git |
|---|---|---|
| 誤った解析が広まる | 訂正が埋もれる | **PR レビューで止まる** |
| なぜそう判断したか | 本文に書くだけ | **履歴に残る。`git blame` で追える** |
| 複数人の解析の統合 | 手作業 | **マージ** |
| インフラ | 認証・モデレーション・ホスティング | **ゼロ** |

そして**ラベルは ROM ではない**。番地・名前・分布は、ROM を配れない場面でも共有できる。

## この形式が機械的に守らせたい掟

> 観測されなかったものは *unclassified* と出す。推測で埋めない。
> — [ice-design](./ice-design.ja.md)

一人でデバッガに向かっているうちは、これは心がけで足りる。共有ファイルではそうはいかない。
**一人の推測が全員の事実になる**のは、まさに共有ファイルの上だからだ。だからスキーマの側で
「主張には領収書を持たせる」ことにして、持っていない成果物はバリデータが弾く。

## 成果物の形

```json
{
  "schemaVersion": 1,
  "machine": "pc8801",
  "cpu": "main",
  "title": "N88-BASIC メインROM — ディスクブート経路",
  "romHash": { "main": ["sha256:4644eb…", "fnv1a64:92f541f044383460"] },
  "labels": {
    "5A3C": {
      "name": "encounter_check",
      "confidence": "observed",
      "evidence": { "samples": 412, "hits": 26, "expected": "1/16" },
      "note": "AND 0Fh -> JR Z",
      "source": "tools/rng-callers.mjs"
    }
  },
  "rng": { "kind": "lcg", "a": 5, "c": 1, "confidence": "observed",
           "evidence": { "samples": 200, "predicted": "200/200" } },
  "unclassified": [{ "addr": "6F1A", "reason": "毎フレーム読まれるが比較されない" }],
  "notes": "…",
  "sources": ["romlabels.js", "docs/m88-comparison.md"]
}
```

### フィールドの意味

| フィールド | 必須 | 何のためにあるか |
|---|---|---|
| `schemaVersion` | ✔ | 1。**新しいスキーマの文書は読まずに拒否する**。見えないフィールドを黙って落とすのが、マージで他人の成果を消す手口だから。 |
| `machine` | ✔ | `pc8801` / `pc8001` など。**置いてあるディレクトリ名と一致**すること。 |
| `cpu` | | `main` / `sub`。**1文書＝1アドレス空間**。跨いだマージは拒否する。サブ基板の `02B4` とメインの `02B4` は無関係。 |
| `title` | | 何を解析したか（人間向け）。 |
| `romHash` | ✔ | 下記。 |
| `source` / `date` / `generator` | | 出所。**自動では何も刻まない**（決定論の節を参照）。 |
| `labels` | ✔ | 番地 → 主張。空でもよい。空の解析は恥ではない。 |
| `rng` | | 乱数生成器の同定（#38）。他の主張と同じく `confidence`/`evidence` を持つ。 |
| `unclassified` | | 正直な尻尾。**一級市民**。下記。 |
| `conflicts` | | マージ時に**導出**される。積み上げない。 |
| `notes` / `sources` | | 散文と参照。 |

知らないトップレベルのフィールドは**保持したうえで警告**する。新しい生産者がフィールドを
足しても、このリーダが握り潰さないように。

### `romHash` — 実際に起きた事故を二度と起こさないための欄

ラベルはリビジョン固有だ。別リビジョンに他人のラベルを当てるのは、ラベルが無いより悪い。
**だいたい動いてしまう**からだ。

これは机上の心配ではない。M88 は結合イメージ `Pc88.rom` を優先し、無いときだけ個別ファイルに
落ちる。こちらのハーネスは個別ファイルを読んでいた。**二つのエミュレータは別リビジョンの ROM を
走らせていた**し、それ以前の比較は全部汚染されている（[m88-comparison](./m88-comparison.ja.md)）。

| ROM | 相違バイト数 |
|---|---|
| main N88 | 107 / 32768 |
| N88 拡張 | 141 / 32768 |
| sub (DISK) | **2021 / 8192** |

**ひどく食い違ったのはサブROMだけ**だった。だから `romHash` は**役割ごと**に持つ。

```json
"romHash": { "main": "sha256:…", "ext": "sha256:…", "sub": "sha256:…" }
```

単一ROMの機種なら素の文字列でよい（内部では役割 `*` に入る）。ひとつの役割に
**アルゴリズム違いの複数ハッシュ**を並べてもよい。ブラウザ側の書き出し（同期・pure な
`analysisdb.hashBytes` の `fnv1a64`）と、`node:crypto` の `sha256` を突き合わせられるように
するためだ。

`compareRomHash(a, b)` の答えは4種類あり、「進んでよい」のは1つだけ:

- `match` — 共通の役割すべてが、共通のアルゴリズムすべてで一致。
- `mismatch` — 共通の役割が食い違う。**`merge()` は拒否する**（`{ force: true }` を明示した
  場合を除く）。強行したマージは**その事実を成果物の `notes` に自白として書き込む**。
  リビジョンを跨いだマージは、実行した人の頭の中ではなく**ファイルに見えていなければならない**。
- `incomparable` — 役割は共通だがアルゴリズムが共通でない（sha256 と fnv1a64）。警告つきで
  マージする。***照合できなかったことは、照合して一致したことではない。***
- `unknown` — 共通の役割がそもそも無い。同じ扱い。`{ allowUnknownRom: false }` で
  「積極的な一致」を要求できる。

### `confidence` と `evidence` — 主張には領収書を

`confidence` は3段階。`evidence` は必須で、**そのshapeは confidence によって変わる**。
満たさない文書はバリデータが弾く。

| confidence | 意味 | evidence に要るもの |
|---|---|---|
| `observed` | 機械がそう振る舞い、**数えた** | `samples` > 0（＋あるなら `hits` / `expected` / `distribution` …） |
| `inferred` | コードを読んで導いた／他の結果から導いた | `basis` / `from` / `method`、または観測回数 |
| `guess` | そう思う | `basis` — **なぜそう思うか**を書く |

**推測は歓迎する。禁じるのは「無記名の推測」**。この表はそのためにある。

ついでに2つの検査が無料でついてくる:

- `hits > samples` は**エラー**。主張が誤っている以前に測定が誤っている。
- `observed` の `hits/samples` が、自分で書いた `expected`（"1/16" など）から大きく外れて
  いれば**警告**。数字は本物、読み方が間違っているかもしれない。#38 が求めた自己検証そのもので、
  解釈と実測分布が合わないときは**解釈が負け**、その番地は `unclassified` に落ちる。

ここで引いている線に注意してほしい。**`observed` とは「誰かが数えた」ということ**だ。
`analysis/pc8801/n88-fr-boot-path.json` の22ルーチンは `romlabels.js` では `verified`
（命令単位で歩いた）扱いだが、この形式では `inferred` になっている。当時のセッションが
**回数を記録していない**からだ。この格下げは意図的で、形式が意図どおり働いている証拠でもある。

### `unclassified` — 一級市民

要素は `{ addr, reason }`（略記 `"6F1A: 読まれるが用途不明"` も同じものにパースされる）。
尻尾が空でないことは恥ではない。むしろ**ラベルだらけなのに尻尾が空**の文書には警告が出る。

マージは**尻尾を消さない**。あとからラベルが付いた番地でも消さない。「誰かが見に行って、
分からなかった」は立派な発見だし、マージで消すと**マージした順序で結果が変わる**。
「いま open な尻尾はどれか」はフィールドではなく関数で出す:

```js
openTails(doc)   // → まだラベルで決着していない要素
```

ある番地が open から外れるのは、**係争中でない** `inferred` 以上のラベルが付いたときだけ。
**`guess` では尻尾は閉じない**。推測は未知を「名前のついた未知」に変えるだけで、知識には
変えないからだ。

## マージ — ここで嘘をつかせない

`merge(a, b, opts)` → `{ ok, doc, conflicts, warnings }`

1. **`machine` / `cpu` が違う** → 拒否。
2. **`romHash` 不一致** → 拒否（上記）。
3. **同じ番地・同じ名前** → 1つにまとめる。evidence は**足し算しない**。二つの文書が同じ
   走行を記述している可能性があり、observation を水増しすれば**誰も観測していない確信**を
   でっち上げることになる。大きい方の測定が `evidence` の席を取り、他方は `alternatives` に残る。
4. **同じ番地・別の名前・confidence が違う** → 高い方が勝ち、**負けた方も `alternatives` に
   残す**。`conflicts` に `resolution: "by-confidence"` で記録。
5. **同じ番地・別の名前・confidence が同格** → **衝突**。両方残し、その要素に
   `"disputed": true` を立て、`conflicts` に `resolution: "disputed"` で記録する。
   **黙って上書きすることは絶対にない**。`name` の席に入る方は決定的に選ぶ
   （confidence → 観測回数 → 名前）が、これは**誰がマージしても同じバイト列になるため**の
   表示上の都合であって判定ではない。`disputed` がそう言っている。

マージは**可換・結合的・冪等**。`merge(a, b)` と `merge(b, a)` は同じ文字列になり、
一度取り込んだ文書をもう一度マージしても何も変わらない。飾りではない。並行する PR は
メンテナのクリック順に着地するので、**どの順でも同じところに収束**しなければならない。

`mergeAll([...])` は畳み込み、**最初の拒否で止まる**。3番目に並べれば通る、という
ロンダリングを許さないため。

## 決定論 — diff がレビューだから

`stringify(doc)` は正準テキストを書く。キー順固定、番地ソート、インデント2、末尾改行、
**タイムスタンプ無し**。`git diff` に出るべきは解析の変化であって、時計の変化ではない。
テストは `analysis/` 配下の全ファイルが `stringify(parse(…))` とバイト一致することを確認する
ので、手で書き換えたファイルはレビュー前に落ちる。

## 置き場所

```
analysis/<machine>/<slug>.json      analysis/pc8801/pc80s31-sub-rom.json
```

ディレクトリ名は文書の `machine` と一致すること（テスト済み）。1文書＝1主題・1アドレス空間。
**レビューできる大きさ**に保つ。

同梱の実例は2つ。どちらもこのリポジトリ自身の PC-8801 調査から作った:

- `analysis/pc8801/pc80s31-sub-rom.json` — FDDサブCPUのROM。コマンドディスパッチと、
  `02B4` のモータ整定待ち。その内側ループ `02BB` は**1回の呼び出しで262144回**回ると実測されて
  いる一方、M88 はそこを一度も踏まない（M88 は `00FB`/`0105` の `CALL 02B4h` を NOP で潰す。
  **忠実なのはこちら**）。
- `analysis/pc8801/n88-fr-boot-path.json` — メインROMのディスクブート経路と 8255 ハンド
  シェイク。比較ハーネスの指紋バイト `E6CD` と、**外れた筋** `FCCF` を open な尻尾として記録。

## API

```js
import {
  SCHEMA_VERSION, CONFIDENCE, confidenceRank,
  createDoc, validate, assertValid, parse, stringify,
  normalizeAddr, hashBytes, normalizeRomHash, compareRomHash,
  merge, mergeAll, openTails,
  fromLabelMap, toLabelMap, fromRngCallers,
} from './analysisdb.js';           // package export: "upd3301/analysisdb"
```

- `validate(doc)` → `{ ok, errors, warnings }`。`assertValid` は全エラーを並べて throw。
- `hashBytes(u8)` → `fnv1a64:…`。同期・pure（ブラウザの `crypto.subtle` は非同期）。
  可能なら `node:crypto` の `sha256` も併記する。
- `fromLabelMap(pairs, meta, opts)` — ICE の `[addr, name]` → 文書。名前は既定で `guess`
  として出る。**DB が持っているのは名前であって、その裏の観測ではない**から。
- `toLabelMap(doc, { minConfidence = 'inferred' })` — ICE へ戻す。既定で `guess` は除外、
  `disputed` な名前には `?` が付く。
- `fromRngCallers(callers, meta)` — #38 の呼び出し元マップ → 文書。**意味が確立していない
  呼び出し元は、数字を持ったまま unclassified になる**。数えたことと分かったことは別だから。

### この形式に書き出す側へ

- **#37（ICEのヘッドレス化）**: `demo/ice.js` に**書き出しボタンを1つ足しただけ**
  （既存のJSON書出の隣に `解析書出`）。他は動かしていない。中身は
  `fromLabelMap([...state.labels], …)` で、`romHash` は実際に載っている ROM イメージ
  （`romMain` / `romExt` / サブ基板）から刻む。2KB の `disk.rom` はサブの8KB空間に4回ミラー
  されるので、**ファイルと一致する**よう先頭2KBを取ってハッシュする。
- **#38（乱数）**: `fromRngCallers` は
  `{ pc, samples, hits, pattern, expected, distribution, meaning }` を取る。
  分布が解釈を支持しないときは `meaning` を空にすること。**正直な穴が開いている方が、
  文書としては役に立つ**。

## 残っている穴（正直に）

- **ICE は main/sub で Label DB を1つしか持っていない**。したがって書き出しは、`cpu` が
  言っているのと別のアドレス空間の番地を混ぜている可能性がある（書き出した文書自身の
  `notes` にそう書いてある）。`analysis/` に入れる前に分けること。
- **信頼・同一性のモデルは無い**。`source` は誰でも書ける文字列。レビューは PR であり、
  それが全てのセキュリティモデル。
- **番地キーは平坦な hex。バンクを表現できない**。`6F06` が選択バンクで別物になる機種では、
  どのバンクかを `notes` に書くしかない。
- **`evidence` は意図的に開いている**。理解されるのは `samples` / `hits` / `expected` /
  `basis` / `from` / `method` だけで、他は保持されるが検査されない。
- **ハッシュは ROM イメージのもので、走行中の機械のものではない**。どの ROM を積んだかは
  言えるが、その後 RAM に何を書き込んだかは言えない。
