[English](./README.md) · **日本語**

# gbroms — テストROMと、その出どころ

このディレクトリが issue #42 の存在理由。このリポジトリの他の機種は再配布できない
BIOS を要求するので、CI ではテストが skip され、検証は「作者が自分のディスクで一度
やった」以上のものにならない。ゲームボーイだけは違う。256バイトのブートROMは
ロゴをスクロールして自分をメモリから外すだけなので、**カートリッジだけで機種が完結
する**。しかもこの機種のテストROM文化は、本当に自由に配れるコーパスを産んでいる。

だから**再配布できるものはここにコミットし、CI で実際に走らせる**。できないものは
**置かず**、それを使うテストは skip する。この両方が要点で、「CI が本物のテストROMを
走らせている」という主張は、境界を1本ずつ確認して初めて意味を持つ。

## コミットしてあるもの（ライセンスが再配布を許す）

| 中身 | ファイル | ライセンス | 作者 |
|---|---|---|---|
| **dmg-acid2** | `dmg-acid2.gb.gz`, `dmg-acid2-reference.png` | MIT — `LICENSE-dmg-acid2` | Matt Currie |
| **mooneye-gb** | `mooneye/acceptance/**`, `mooneye/emulator-only/**`（103ファイル） | MIT — `mooneye/LICENSE` | Joonas Javanainen |

ROM は **gzip で圧縮**して置いてある。凝りたいからではない。MBC のテストのいくつかは
8MB の大半がパディングで、gzip をかけるとコーパス全体が 26MB から 700KB 未満になる。
これは「コミットできるフィクスチャ」と「できないフィクスチャ」の差。
`gbtools/gbrun.mjs` は `.gb` と `.gb.gz` を同じように読むので、外部から持ってきた
ROM もそのまま使える。

`dmg-acid2-reference.png` は dmg-acid2 リポジトリの参照画像を 2bit グレースケールに
変換したもの。2bit は妥協ではない。DMG の階調はちょうど4段で、PNG 仕様が定める
2bit→8bit のスケーリングは `$00/$55/$AA/$FF` になる。これは dmg-acid2 の README が
エミュレータに出力するよう求めている4値そのもの。だから比較は**完全一致で、
どこにも許容誤差が無い**。

## コミットしていないもの（ライセンスが無い）

**blargg** の各スイート（`cpu_instrs` / `instr_timing` / `mem_timing` /
`mem_timing-2` / `halt_bug` / `interrupt_time` / `oam_bug` / `dmg_sound` /
`cgb_sound`）はゲームボーイのテストROMとして最も有名だが、**ROM にもソースにも
ライセンス表記も public domain 宣言も無い**。readme の最後にあるのはメールアドレス
だけ。みんながミラーしている、はライセンスではない。よって:

```sh
node gbtools/fetch-blargg.mjs          # → gbroms/blargg/（git 管理外）
node gbtools/verify.mjs --blargg       # 走らせて点数を出す
```

`test-gb.mjs` はこのディレクトリが無ければ blargg のテストを skip する。
クリーンな clone でスイートが通るのはそのため。

## 走らせ方

```sh
node --test test-gb.mjs                # アサーション（CI の回帰検出器）
node gbtools/verify.mjs                # 同じコーパスを点数として印字
node gbtools/verify.mjs --blargg       # 取得済みなら blargg も
node gbtools/acid2.mjs                 # 絵の比較＋ASCIIサムネイル
node gbtools/suite.mjs gbroms/mooneye/acceptance --mooneye --model dmg
```

現在の数字と既知の穴は `docs/gb-design.ja.md` の §10・§11 にある。
