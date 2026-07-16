[English](./README.md) · **日本語**

# m88ref — ヘッドレスM88を「実機相当のリファレンス神託」にする

うちのpure-JS PC-8801エミュ（`upd3301`）が、他のエミュでは普通に起動するゲームで
コケたら、犯人は**うち**だ。ここは **M88M**（名作 PC-8801 エミュ M88 のクロス
プラットフォーム移植）を**ヘッドレスでスクリプト駆動できる神託**に仕立てる場所。
同じディスクを起動し、フックを刺して、M88とうちの挙動を**1命令ずつ・1バイトずつ・
RAM領域ごと**に突き合わせる。この差分こそが、「固まる」という症状を**たった1個の
食い違った値**まで絞り込む道具になる。

これは軽井沢誘拐案内を解いた（まだ解いてる最中の）手法そのもの。うちのFDc・8255
ハンドシェイク・コピープロテクト読み・ゲームが注入する`SW-LOADER`が全部忠実だと
**証明**できたのは、M88が*同一の*FATテーブル・ディレクトリエントリ・読み順を吐いた
から。おかげで起動ハングを「入れ子のローダ段」1つまで絞れた。

## 中身

| ファイル | 説明 |
|------|------|
| `build.sh` | M88Mを固定コミットでクローン→フック適用→コア+`refdrv`ビルド |
| `m88m-hooks.patch` | トレースフック（`git apply`可能な差分・3ファイル） |
| `refdrv.cpp` | ヘッドレスdriver: `.d88`起動→フック駆動→状態ダンプ |
| `PATCHES.md` | 各フックの説明（新しいM88Mへ移植する用） |
| `README.md` | English版 |

M88M本体をリポジトリに入れる必要はない ── `build.sh`が取ってきてパッチを当てる。

## ビルド

```sh
./build.sh                 # → _m88m_build/M88M/refdrv
```
`git`・`g++`（C++17）・`ar`・zlibヘッダ（`-lz`）が必要。クリーンクローンから再現
検証済み（コア41オブジェクト）。コアは `-DM88_PORTABLE -DM88_NO_Z80_X86
-fpermissive -Wno-narrowing` でビルド、raylib/GUIフロントは飛ばして画面出力は空
スタブ。M88Mコミット `6fc74b5` に固定（パッチはこのツリーに対するもの）。

## 実行

```sh
refdrv <romDir> <disk.d88> [frames] [win0 win1]
```
- `romDir` — M88ネイティブROMのディレクトリ。ローダは**cwd相対・一部大小区別あり**で
  開く（`N88.ROM`/`n88.rom`, `DISK.ROM`, `N88_0.ROM`..`N88_3.ROM`, `kanji1.rom`,
  `kanji2.rom`, `N80.ROM`, `FONT.ROM`, `pc88.rom`=結合ROM・サブROMはoffset
  0x14000）。`refdrv`が`chdir()`するので、ROMセットが要求する大小両方の綴りを置く。
  素の `m88204` セットでそのまま動く。
- `frames` — 60Hzフレーム数（既定600）。~250でメニューに到達。

例（このリポジトリが差分を取る参照実行）:
```sh
refdrv /path/to/m88roms /path/to/karuizawa.d88 250
```

### refdrvに埋めたconfig（軽井沢が起動する設定）
`basicmode=N88V2`, `clock=40`(4MHz), `dipsw=1829`,
`flags = enableopna | subcpucontrol | enablewait | precisemixing | mixsoundalways`。
別のマシン設定が要るゲームは `refdrv.cpp` の `Config` ブロックを変える。

## refdrvが吐くもの（フック）

パッチが関数ポインタのフックを刺し、`refdrv.cpp`が配線する:

- **FDCコマンド/結果/読み** — 全`READ DATA`のID（`C H R N EOT`）と全7バイト結果相
  （`ST0 ST1 ST2 C H R N`）。µPD765の結果ID/end-of-cylinder挙動（`R←R+1`、末尾EOTで
  `C+1/R=1`ラップ）を確定したのはこれ。
- **メインCPU PCトレース** — 任意イベント（例: 6回目のFDC結果）でarm、境界付き・連続
  重複除去、ファイル出力してうちと集合/prefix比較。
- **`E6CD`/`EC88`書き込み** — ゲームのキーボードスキャン門と ロードポインタ。遷移時に
  書込みPC付きで記録（E6CD=ffはロード未完の*症状*で、ロード完了時のみ`pc=0x1b92`が
  クリアすると判明）。
- **サブCPU RAMダンプ** — `GetMem2()->GetRAM()`（サブaddr `A` → `ram[A-0x4000]`）。
  ディレクトリエントリ・FATテーブル・`FAT[cluster]`。FATウォークがうちとバイト一致と
  証明したのはこれ。
- **メイン受信バイト列 / サブFDCデータ数** — バイト厳密な転送差分用。

調べたい相にフックをarm/照準して`refdrv.cpp`を編集、再ビルド（コアlibがあれば数秒で
再リンク）、再実行。

## 手法 ── クロスエミュ差分デバッグ

神託は半分。もう半分は、**うちの**エミュを*同じ*意味論的地点で計装して差分を取ること。
ループ:

1. **両方をヘッドレスで再現。** 同じ`.d88`・同じフレーム数・決定論PRNG。うちはpure-JS
   なので小さなNodeハーネスで駆動: `new Pc8801Machine({main,ext,sub,...})` →
   `insertDisk(0, parseD88All(...)[0])` → ループで`stepFrame()`、そして`cpu.step`・
   `sub.cpu.bus.write`・`fdc._results`・`globalThis.__fdcCmd`をフック。
2. **粗→細で差分。** 目に見えて違う所（E6CD・tvram・読み回数）から始め、二分探索:
   FDC結果ID → メインPCトレース（最長共通prefix）→ サブCPU RAM領域 → 最初に食い違う
   1バイト/ポート読み/結果フィールド。
3. **食い違った値を出所まで追う。** バッファの間違ったバイト → それを格納したFDC読み →
   そのバイトを生`.d88`セクタと比較。うちがディスク*と*M88の両方に一致するなら、その
   入力はシロ。1段上へ。
4. **告発より、無実の証明。** 作業の大半は容疑者を*晴らす*こと（プロテクト・ROM版・
   サブfirmware・ハンドシェイク・タイミング）── M88が同一状態を生むと証明して。全ての
   無実証明を生き延びた奴が犯人。

### agent用prompt（サブエージェントに貼る）

> `upd3301/` のpure-JS PC-8801エミュが `<TITLE>.d88` を起動できない（M88では起動する）
> 理由をデバッグせよ。`upd3301/m88ref/` をcycle-accurateなリファレンス神託として使う。
> `_m88m_build/M88M/refdrv` が無ければ `m88ref/build.sh` でビルド。**両方**のエミュを
> 同じディスク・同じフレーム数でヘッドレス実行。粗→細の二分探索で分岐を局所化する:
> FDCコマンド/結果列 → メインCPU PCトレース（最長共通prefix）→ サブCPU RAM領域
> （`refdrv`が `GetMem2()->GetRAM()` でダンプ）→ 最初に食い違う1バイト/ポート読み/
> 結果フィールドまで。疑わしいバイトは、それを生んだFDC読みまで辿り、生`.d88`セクタと
> 比較 ── うちがディスクとM88の両方に一致すればその層はシロ、1段上へ。`refdrv.cpp` に
> フックを足す/照準し（再ビルドは数秒）、うちのエミュも*同じ*意味論的地点でNodeハーネス
> により計装せよ（`new Pc8801Machine` → `insertDisk` → `stepFrame`、`cpu.step`・
> `sub.cpu.bus.write`・`fdc._results`・`globalThis.__fdcCmd` をフック）。局所化した
> 単一の分岐と、M88が同一状態を生むと証明して*晴らした*サブシステムを報告せよ。晴らした
> 容疑者と証拠の「闘いの記録」を残しながら進めること。

## 新しいM88Mへの移植

パッチはコミット `6fc74b5` に固定。適用できなくなったら `PATCHES.md`（各フックの
アンカーとペイロード）から作り直し、`build.sh` の `M88M_COMMIT` を貼り直す。フックは
極小の関数ポインタ呼び出し: `Z80C::SingleStep`, `Z80C::Write8`, `FDC::ReadData`,
`FDC::GetData`, `FDC::ShiftToResultPhase7`, `SubSystem::M_Read0`。
