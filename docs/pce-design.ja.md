# PCエンジン実装

## 1. 対象と機種契約

初代PCエンジン / TurboGrafx-16 のHuCardを、PC-8001・PC-8801・ファミコンと
同じ決定論ホストへ追加する実装である。コアはpure JavaScript・依存ゼロで、
DOMも乱数源も参照しない。

`PceMachine` はホスト契約を満たす：

- `stepFrame()` と単調増加する `frame`
- `update(dt, onFrame)` と `frameHz`
- `snapshot()` / `restore()` と `schemaVersion`
- 能力としての `render()` / `renderAudio()`

カートリッジは不変データとして参照保持し、スナップショットには入れない。
スナップショットに入るのはCPU・RAM・VDC・VCE・PSG・パッド・マッパー・
マスタークロックの可変状態で、~~出力であるフレームバッファと音声リングも除外する~~
— **フレームバッファをこの列に入れていたのは間違いだった。2026-08-11 訂正。**
ホストは restore してからステップせずに描く（`demo/machine.html` の
`restoreIdx()`）ので、絵の入っていないスナップショットは巻き戻し前のフレームを
返す。いまは `frameWidth x frameHeight` の窓を有効9bitに詰めて入れる：256x224 で
64,512バイト。VRAM 64KB が大半だった約80KB に上積みして実測143KB。音声リングは
出力のままで、引き続き入れない。[docs/machine-contract.ja.md](./machine-contract.ja.md) §2.6 参照。

## 2. HuC6280 CPU

`huc6280.js` は `m6502.js` のサブクラスである。共通コアからnestest 8,991行で
検証済みのバスサイクルモデルと割込機構を受け継ぎ、NMOS 6502と異なる部分だけを
置き換える：

- 8本のMPRで16bit論理アドレスを2MB物理空間へ8KB単位で写像
- ゼロページとスタックを `$2000` / `$2100` へ移動
- `CSL` / `CSH` によるマスタークロック12分周 / 3分周
- 次の ORA/AND/EOR/ADC を `$2000+X` 経由にするTフラグ
- TAM/TMA、ST0/ST1/ST2、ブロック転送、ビット分岐、65C02命令
- 3系統のマスク可能割込、マスク/状態レジスタ、個別ベクタ
- 3,072マスタークロックごとに刻む内蔵タイマ

ブロック転送は1バイト6サイクルだがバスアクセスは2回しかない。その内部サイクル中も
映像を進めるため、CPUバスに任意の `idle(n)` を追加した。`PceMachine` はread/writeと
同様にidleでも全機器の時刻を進める。

テストは全256 opcodeの停止可能なdecode、主要拡張命令、CMOS十進演算、MMU、割込、
タイマ、状態往復と決定論を確認する。`m6502.js` は変更しておらず、nestest は
8,991/8,991、判定バイト `00 00` を維持している。

## 3. HuCardイメージとバンク

`pcerom.js` はヘッダ無し `.pce` を読み、実コレクションにある次の損傷を扱う：

- 512バイトのcopier header
- リセットベクタから検出するbit reverse dump
- 小さな末尾ゴミと最終バンク欠損
- 384KB / 768KB の非2冪配置
- 2.5MB Street Fighter II' のバンク切替基板

標準マップは128ページ。256KB以上のカードでROM外へ出たflat addressは256KB下へ
折り返す。この規則は1枚のスクリーンショットから決めず、1,169イメージ全体を
`hudson` / `mirror` / `modulo` で比較した。Street Fighter II' は先頭512KBを固定し、
4つの512KB領域の1つをbank `$40-$7F` に置く。

HuCard自体に機種種別フィールドはない。そのためSuperGrafx警告は明示オプション、または
ファイル名の `SGX` / `SuperGrafx` ヒントだけで出す。ROM内のbyte patternは命令とは限らず
画像データでもあるため、走査による推測は大量の偽陽性を生んだ。第2 VDC・VPC・32KB
SuperGrafx RAM・CD-ROM・Arcade Cardは未実装である。

## 4. マスタークロック同期

唯一の時刻基準は21.47727MHzマスタークロックである：

| 対象 | 分周 / 周期 |
|---|---:|
| HuC6280 fast / slow | 3 / 12 |
| VCE dot clock | 4 / 3 / 2 |
| PSG | 6 |
| CPU timer | 3,072 master clocks |
| 1 scanline | 1,365 master clocks |

VCEが262/263 lineを選ぶため、`frameHz` は60へ丸めず算出する。各lineには先頭eventと
後段の描画eventを置く。この間隔によってraster IRQ handlerが同じlineの描画前にscrollや
paletteを変更できる。現実装はscanline単位であり、line途中のVDC効果と厳密なVRAM
contentionは対象外である。

## 5. 映像

`huc6270.js` はHuC6270を1基実装する。32K×16bit VRAM、背景tile map、64 sprite、
raster/vblank/collision/overflow、VRAM DMA、SATB DMAを持つ。VDCはpalette indexを出し、
`huc6260.js` が512色9bit GRB palette、dot clock、monochrome変換を担当する。

完成したlineはその時点のVCE paletteで変換するので、raster handlerによるpalette変更が
後続lineだけに効く。コアは最大寸法の固定bufferとlive width/heightを持ち、`render()` は
RGB、または共通CRTホスト用のindexed + analog driveを返す。

既知の近似はdot単位でなくscanline単位の描画、VRAM/SATB DMAの即時完了、垂直phase合計の
補正、SuperGrafx第2映像系の欠如である。

## 6. 音声と入力

`pcepsg.js` は32 sample wavetable×6ch、direct D/A、ch4-5 noise、ch1→ch0 LFO、
channel/global stereo attenuation、決定論resamplingを実装する。PSGはmaster clockから
pushされるため、browserが音を要求した時ではなくsimulation内のregister write時刻で音が
変わる。ホストへは他機種と同じ `renderAudio(out, n)` 能力でmono mixを渡す。

パッドは I/II/SELECT/RUN と方向を2つのactive-low nibbleで返す。ホストはconsoleごとの
bit表を通して既存keyboard/gamepad actionを割り当て、入力loopを複製しない。

## 7. ホスト統合

`demo/machine.html` に `.pce` pickerとPCエンジン起動modeを追加した。HuCardは一度解析して
reset間も不変参照を保持し、boot時に新しい `PceMachine` を作る。描画・音声・snapshot・
入力は既存のcapability probeを使う。巻き戻し・ジョグシャトル・pause・速度変更に
PCE固有実装はない。

module scriptはheadlessで構文確認済み。ただしbrowser canvasの実描画と実音声はこの環境では
**visual / audible未検証**である。

## 8. テスト

Node 24で実行する：

```sh
export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"
node test-huc6280.mjs
node test-pce.mjs
node nestools/nestest.mjs \
  /tmp/nes-test-roms-master/other/nestest.nes \
  /tmp/nes-test-roms-master/other/nestest.log
```

PCEテストはparser修復、banking、VCE/VDC register、DMA、背景/sprite出力、PSG生成と状態、
機種timing、IRQ、pad、host contract、snapshot replay、決定論、Street Fighter II' 切替、
jamしたROMでも `stepFrame()` が戻ることを確認する。

## 9. 神託なし全件スイープ

`pcetools/pcerun.mjs` と `pcetools/sweep.mjs` はファミコンで用いた神託なし分類を踏襲する。
最終frameだけでは判定しない：

1. 長時間runを一定間隔でsampleし、最良の色数を保持
2. sample frame変化数とVRAM変化数を数える
3. run後に200,000命令進め、異なる論理PCの数を数える
4. CPUが小さなloopにいて、かつ画像も実質停止した時だけdeadとする

分類は `reject` / `jammed` / `dead` / `black` / `flat` / `static` / `ok`。
`ok` は十分なcodeを実行し、複数色で変化するframeを出した、という意味に限る。画素・timing・
音・gameplayの正しさを証明しない。展開済みdirectoryは並列、ZIPは `zip.js` から直接読める。
ZIP modeを単一processにするのは全member byteをIPCでも複製しないためである。

全1,169 imageの300-frame較正ではparse/build例外ゼロ、`ok=947`、`flat=95`、`black=38`、
`dead=89` だった。代替bank規則では `ok` が `mirror=865`、`modulo=868` まで落ち、既定の
256KB折り返しを支持した。

最終の無入力runは全imageを1,800 frame動かし、`ok=997`、`flat=37`、`black=32`、
`dead=103`。静止した入力待ちをcrashと誤認しないよう、40 frameごとにRUNを短く押す
1,800-frame runも行った。各imageについて2回の良い方を採用すると：

| 判定 | image数 |
|---|---:|
| `ok` | **1,015** |
| `flat` | 23 |
| `black` | 33 |
| `dead` | 98 |
| parse/build例外・jam・未分類static | **0** |

従って1,169本すべてがparse・構築・制限時刻までのrunを完了し、1,015本が強いheadless
起動信号を満たした。別の23本は実行して2〜3色を描く。残り131本は動作を主張しない：
98本は小さなCPU loopと実質静止画へ収束し、33本は単色のままである。多くは `[b1]` 等の
bad/overdumpで、同名の正常dumpは起動する。第2映像系が無いSuperGrafxも想定内の失敗を
含む。これは分類結果であり、visual compatibilityの結果ではない。
