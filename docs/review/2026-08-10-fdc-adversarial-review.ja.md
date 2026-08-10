[English](./2026-08-10-fdc-adversarial-review.md) · **日本語**

# 敵対的レビュー (2026-08-10) — µPD765 / VRTC 実装を一次資料に照らす

2026-08-08〜10 の自律走行（[#32](https://github.com/opaopa6969/upd3301/issues/32)）で入れた
FDC・サブCPU・VRTC の修正について、**別モデル（codex）に反証を依頼**した結果。

依頼時の条件: **M88 のソースを根拠にしないこと**（M88 自体が反証対象。実際に
`SubSystem::PatchROM()` がサブROMのモータ待ちを NOP で潰しているのを発見済み）。
Intel 8272 仕様書・µPD765A/B データシート・MAME の `upd765.cpp` / `upd3301.cpp` /
`pc8801.cpp` を根拠とし、`upd765.js` を単体で叩いて結果バイト列を実測している。

**「353本の一致率が上がったこと」は実機忠実性の証明にならない。** その前提で読むこと。

---

## 反証できた点

### 1. EOT 前に次セクタが無いとき、ND を立てず正常終了する【高】

`upd765.js:319`。`_idIncrement()` が継続を返した後に `findSector()` が失敗しても、
そのまま `_endRw(0,0,0)` に落ちる。規定では **ST0.IC=01 / ST1.ND=1 の異常終了**。

実測: side 1 / R=1 が存在しない MT 読みで `00 00 00 00 01 01 00`（＝正常値）を返した。

### 2. TC なしの EOT 到達を正常終了にしている【高】

`upd765.js:289`, `upd765.js:329`。µPD765 は **TC で終わるのが基本**で、TC が来ないまま
最終セクタを越えようとしたら **End of Cylinder（ST0 異常終了 + ST1.EN=0x80）**。
現行は MT=0 でも MT=1 の side 1 完了でも正常終了。

**しかも `test-fdd.mjs:77`（期待値は91行目）が、この仕様外挙動をテストで固定している。**

### 3. TC 受信で即 result phase へ入り、CRC と結果ID更新を省略【高】

`upd765.js:117`。READ は TC 後もセクタ末尾まで読んで CRC を確認、WRITE は残りを 00 で
埋めるのが規定。結果 CHRN も Intel Table 4 に従うべきところ、TC 時点のセクタ ID を
そのまま返している。`test-fdd.mjs:105` は「result phase に入った」しか見ていない。

### 4. `m.stHd` が「interrupt 時点の head」になっていない【高】

`upd765.js:318`, `upd765.js:344`。ST0.HD の規定は **「interrupt 時点の head state」**で
あって「最後に完了したセクタの head」ではない。

実測: side 1 の先頭バイトを読んだ時点で TC を打つと **結果 H=1 なのに ST0.HD=0**。
ND 経路でも古い side 0 が残る。

→ **「ST0 は転送に使ったヘッド、結果IDは前進後のヘッド」という分離の結論は妥当。
誤りは永続 `m.stHd` という実装の方。**

### 5. WRITE DATA / WRITE DELETED DATA のマルチセクタと MT が丸ごと未実装【高】

`upd765.js:259`, `upd765.js:303`。`_startWrite()` が MT を `_multi` に保存せず、
`_execDone()` の継続処理が `!this.execWrite` 条件で WRITE を除外している。
1セクタ書いて正常終了する。Intel 仕様は WRITE の MT/EN/ND/結果ID を READ と同じと明記。

### 6. READ DIAGNOSTIC / READ A TRACK が `_idIncrement()` の副作用を受けている【高】

`upd765.js:241`, `upd765.js:309`。規定は index hole 後から EOT 個を読み各 ID を IDR と
比較（**MT/SK は不許可**）だが、現行は物理トラック全セクタを無条件連結し、`_multi.eot` に
開始 R を入れるため即 EOT 扱いになる。

**「結果IDを IDIncrement に揃える」変更が、MT=0 の READ A TRACK まで波及していた。**

### 7. 「`phase !== 'execute'` は mechanics 待ち」という説明はコード上成立しない【高】

`machine88.js:653`, `pc80s31.js:49`。motor 出力は `this.motor = v` で保存するだけで
**READY にも index にも効かず**、SEEK は**即時完了**、READ DATA は head load も settling も
ID 探索も待たず即 `execute` に入る。つまり「execute 以外＝モータ/シーク待ち」という分類が
実際の FDC 状態を表していない。

> **「モータを模擬していないことへの代償」は因果が逆。**
> モータを模擬しないなら実機より**早く**準備完了するのだから、
> さらに CPU を16倍にする物理的理由はない。

M88 の ROM パッチと同種の**互換ハックの疑い**【中】。

**おまけの具体的バグ**: `machine88.js:449` の `_pioPoll` は**ポート番号を区別せず、
書き込みでもリセットされない**。FC–FFh の別ポートから同じ値が来ただけで poll と数える。

### 8. VRTC の絶対周期が CRTC 実値から導かれていない【高】

`machine88.js:379`, `machine88.js:714`。比率には rows/vblankRows しか使っておらず、
フレーム時間は **`frameHz=60` 固定**。実際は

- VRTC = `vblankRows × linesPerChar / fH`
- フレーム = `(rows+vblankRows) × linesPerChar / fH`
- `fH` は pixel clock と `(cols+hblankChars)` に依存

実測: ROM 初期化後は 80列/20行/10raster/6blank rows/32blank chars →
**15kHz 系なら約 61.46Hz・VRTC 約 3.76ms**。60Hz 固定だと 3.85ms。
MAME も 15k/20行=61.462Hz、24k/20行=56.424Hz（タイトルにより約68Hzまで変わる）。

### 9. VRTC ポーリング値と VSYNC 割り込みが約1 blank 期間ずれている【高】

`machine88.js:393`, `machine88.js:682`, `index.js:289`。port 40h の VRTC は
**表示期間終了時**に high になるのに、VSYNC 割り込みは `endFrame()`（**blank 終端**）で出る。
µPD3301 の End-of-screen 割り込みは VRTC high 遷移時。20+6行なら**約 3.8ms ずれる**。

---

## 反証できなかった点

- **MT の side 0→side 1 継続そのもの** — 仕様どおり。M88 固有ではない
- **MT=1 かつ HD=1 開始時に次シリンダへ進まないこと** — 正しい（MT は1シリンダの両面に限定）。
  ただし「C+1/H=0/R=1 で正常終了」は別問題で、TC 終了なら Table 4 の C+1/H反転/R=1、
  TC なしなら EOC 異常終了（MAME は C を進めず H反転/R=1）。
  **異常終了になること自体は【高】、厳密な CHRN は【中】**
- **ST0 と結果 H を分離する意図** — 妥当。誤りは実装（上記4）
- **8255 アクセスを同期点にすること** — 反証できず。ただし**「モータの模擬」ではなく
  単なる CPU スケジューラの粒度補正**、という位置づけの訂正。実測で main/sub ROM は
  制御語 0x91 + BSR、つまり Mode 1/2 の IBF/OBF/INTR ハンドシェイクではなく
  **Mode 0 の port C ソフトウェアハンドシェイク**
- **`rows/(rows+vblankRows)` という比率そのもの** — 反証できず。
  µPD3301 は character row 単位で数えるので `linesPerChar` が相殺される

---

## 追加で出てきた見落とし

- **SK で最初のセクタを飛ばした場合、`sec` だけ R+1 に差し替えて `m.r` は旧値のまま**
  （`upd765.js:225`）→ 完了後に同じ R+1 を再探索して**同じセクタを二度転送**する。
  後続セクタでは deleted/normal mark の判定自体をしていない
- **中間セクタの CRC/status が失われる**。次セクタを `m.sec` に代入した時点で消え、
  最終セクタの status しか `_endRw()` に届かない
- **`d88.js:100` の探索は物理 track と R/N しか比較せず、ID field の C/H・回転順・
  duplicate ID を無視**。プロテクトディスクでは MT より大きな差になり得る
- MT=0 の READ DATA も新 `_idIncrement()` を通るので EOT 正常終了問題の影響下にある。
  READ ID と FORMAT は別経路で直接影響なしを確認
- **現行はデータレジスタ読み出しと同じ JS 呼び出し内で次の INT を立てるので、
  オーバーランが構造的に起こり得ない**

---

## 提案された回帰テスト

画面一致ではなく **ST0/ST1/ST2/C/H/R/N と実際に選択された物理 side** を検査する:

```
MT{0,1} × 開始HD{0,1} × 終了条件{EOT前TC / EOT上TC / TCなしEOC / 次IDなし / CRC・CM}
```

の直積。加えて WRITE の MT、READ A TRACK、SK/deleted、VRTC edge と VSYNC の同時性。

## より妥当なサブシステムのモデル（提案）

8255 latch を I/O 命令時刻で反映 / motor ON 後の READY と index hole 位相 /
SPECIFY の HLT・HUT・SRT / SEEK の step pulse / IDAM 探索の 2 index hole timeout /
FM・MFM の1バイト周期 / non-DMA の byte request INT・RQM・EXM と
**サービス期限超過時の ST1.OR**（READ で FM 27µs / MFM 13µs）/ TC 後のセクタ末尾・CRC 処理。
