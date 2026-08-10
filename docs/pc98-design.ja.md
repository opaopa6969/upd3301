[English](./pc98-design.md) · **日本語**

# PC-9801

このリポジトリにおける V30 世代 PC-9801 の実装である。DOM に依存しない
pure JavaScript で、他機種と同じ `stepFrame()` / `frame` / `snapshot()` /
`restore()` / `schemaVersion` 契約を満たす。

現状、ROM 不要の自作テスト BIOS は GDC の表示開始まで走り、640x400 の
テキスト画面を生成する。実機由来の V30 BIOS 起動はまだ未検証である。
開発中に利用できた ITF は PC-9801RS 相当の 80386 用で、V30 が実行できない
386 命令まで到達するため、この CPU モデルの起動 ROM としては互換でない。

## 1. ファイルと部品

| ファイル | 担当 |
|---|---|
| `machinepc98.js` | メモリ/I/O、割込、リセット、タイミング、キーボード、音源、snapshot |
| `i8086.js` | 8086/V30 CPU |
| `upd7220.js` | 2基の GDC、コマンド FIFO、描画エンジン |
| `pc98video.js` | テキスト VRAM、4プレーン、フォント窓、GRCG、パレット、合成 |
| `i8237.js`, `i8253.js`, `i8259.js`, `i8255.js` | DMA、タイマ、カスケード PIC、PPI |
| `pc98fdd.js` | D88/FDI/raw 媒体と共通 µPD765 の PC-98 用ラッパ |
| `test-pc98.mjs` | ROM 不要の CPU・機械・画面・snapshot・FDD テスト |
| `pc98tools/boot.mjs` | headless 起動と未実装 I/O の追跡 |

`upd765.js` は既存機種と共有し、変更していない。

## 2. メモリとリセット

```
$00000-$9FFFF  メイン RAM 640 KB
$A0000-$A3FFF  テキストコードと属性
$A4000-$A4FFF  キャラクタジェネレータ窓
$A8000-$BFFFF  グラフィック B/R/G プレーン
$C0000-$DFFFF  オプション ROM 窓
$E0000-$E7FFF  グラフィック輝度プレーン
$E8000-$FFFFF  BIOS 96 KB
$F8000-$FFFFF  リセット直後の ITF 32 KB オーバーレイ
```

ITF があればリセットベクタも ITF から読む。ポート `$043D` への書き込みで
ITF を外し、下の BIOS を見せる。BIOS、ITF、フォント、サウンド ROM、装着中の
ディスクは不変入力であり snapshot には入れない。

`$0439` はリセット値 0 の読み書き可能な DMA access-control latch である。
ここを一般的な open bus の `$FF` にすると、後期ファームウェアは不正な機械状態と
判断して system shutdown 経路へ入る。この latch と ITF bank は reset/snapshot
対象に含める必要がある。

## 3. I/O のバイトレーン規則

PC-98 は同じ 16-bit I/O ブロックの片方のバイトレーンに 8-bit 部品、反対側に
別の部品を置くことが多い。ワード I/O は順序付きの2回のバイト I/O として実行する。
例えば `OUTW $70` は `$70` のテキスト微調整レジスタと `$71` の PIT channel 0
の両方へ届く。片方を捨てると、装置への書き込みが無音で消える。

これは X68000 実装で見つかった罠と同型で、CPU は動いていても表示設定だけが
完了しない症状になる。`machinepc98.js` の `_in16` / `_out16` は必ず2本の
byte 経路を呼ぶ。

主なブロックは system PPI `$31/$33/$35/$37`、printer PPI
`$40/$42/$44/$46`、偶数側の text-scroll `$70-$7A`、奇数側の PIT
`$71-$77`、mouse PPI `$7FD9/$7FDB/$7FDD/$7FDF` である。

## 4. shutdown に見えた原因

独立した2つの不具合が重なっていた。

1. `$0439` が未実装で `$FF` を返し、ファームウェアの shutdown 分岐を選んだ。
2. V30 の opcode `$66/$67` を 386 の operand/address-size prefix と誤解していた。
   V30 では ModR/M が続く FPO2 escape で、memory form は no-op、register form は
   命令先頭を戻り先として interrupt vector 7 を取る。

両方の修正後、開発用 ITF の偽の text-VRAM error は消えた。その後に
operand-size prefix 付き `XOR EAX,EAX` や `REP STOSD` という本物の 80386
命令へ進むため、ここから先は V30 opcode 漏れではなく ROM/機種の不一致である。
その RS 用ファームウェアで残る未実装出力は `$0461/$0467` のみで、RS 系固有の
メモリ制御を V30 baseline に推測で入れることはしていない。

open-bus access は全 I/O trace と分離して記録できる。

```sh
node pc98tools/boot.mjs --bios BIOS.ROM --itf ITF.ROM --io-unknown --frames 180
```

集計には方向、port、値、回数、最初の CS:IP が含まれる。

## 5. 画面とホスト出力

GDC1 は 16 KB text plane、GDC2 は 32 KB x 4 の graphics plane を走査し、
text を graphics の上に合成する。GRCG は4プレーンへの tile direct write と
read-modify-write を実装する。`render()` は通常 RGB を返し、共通 CRT 経路向けには
GRB index と gun ごとの analog drive を返せる。

`demo/machine.html` には PC-98 ROM/FD selector を追加した。D88、FDI、代表的な
PC-98 raw geometry を読める。物理キーボード入力は PC-98 の serial make/break
code へ変換する。早送り、巻き戻し、jog、clean 表示、raw PNG、録画は通常の
machine 契約と capability probe に乗る。

## 6. FDC 境界

PC-98 ラッパは、割込駆動 host で共通 `upd765.js` を使うために3点を補う。

- execution phase の data request は command-complete interrupt ではなく DMA DREQ
- SPECIFY と SENSE 系 command は interrupt を発生させない
- pending の無い SENSE INTERRUPT STATUS は `ST0=$80` の1 byteだけを返す

D88 と同じ sector-addressed object を controller に渡し、FDI と raw
2HD/2HC/2DD はその形へ変換する。

## 7. snapshot と決定論

clean snapshot の typed-array 実測は約 672,000 bytes で、主成分は 640 KB RAM と
16 KB text VRAM である。最初の graphics write 後は 4 x 32 KB plane が加わり、
約 803,072 bytes になる。graphics dirty flag は単調増加で、plane の無い snapshot は
その時点まで全 zero だったことを意味するため、過去 snapshot へ依存せず restore できる。

host の rewind ring は固定 frame 数ではなく byte budget で決める。main RAM は毎回
完全コピーし、各 snapshot 単独で復元可能にする。時計は指定された固定 epoch から進め、
core では `Math.random`、DOM、host time を使わない。

YM2203 の register/timer は CPU から見える状態を正確に復元する。共有音源が内部 FM
envelope phase を公開しないため、rewind 直後だけ音が馴染む時間はあり得るが、CPU 可視状態は変わらない。

## 8. 検証状況

`test-pc98.mjs` は 96 KB BIOS、font、raw 2HD disk を自前生成し、著作権 ROM を必要と
しない。reset-vector boot、text pixel、共有 I/O byte lane、`$0439`、unknown-I/O log、
PPI 配置、snapshot、ITF bank、disk geometry、µPD765 境界を検査する。

既知の未完事項:

- V30 世代の実 BIOS/ディスクによる起動は未検証
- 80386 PC-9801RS firmware は V30 CPU scope 外
- RS 系の `$0461/$0467` は未実装
- headless 開発環境のためブラウザ visual は未検証

ハードウェア map の参照先: [MAME PC-9801 machine](https://github.com/mamedev/mame/blob/master/src/mame/nec/pc9801.cpp)、[MAME PC-9801 video](https://github.com/mamedev/mame/blob/master/src/mame/nec/pc9801_v.cpp)、[Renesas V25/V35 instruction manual](https://www.renesas.com/us/en/document/mah/v25tmv35tm-family-instructions)。
