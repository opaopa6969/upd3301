# 他のエミュレータとの比較 — 何を「エミュレート」しているか

このリポジトリの立ち位置を、証拠つきで明確にする。**主張ではなく実行結果**で示す。

## 実証1: 27色トリック（DMA 2画面分）

```
$ node tools/prove-27color.mjs
frame-by-frame color index of the same dot: RED → GREEN → RED → GREEN → RED → GREEN
what the long-persistence phosphor integrates: R=1.13 G=1.25 B=0.28
  → the eye sees YELLOW-ish: a color the 8-color hardware cannot produce.
DMA state: ch2 addr=F3C8h count=5999 (autoload from ch3 wraps it back)
```

やったことは **port 65h に 8000h+5999 を書いただけ**（ベーマガ1990-07「MAGICAL
COLOR」と同じ）。この現象のための特別扱いコードはリポジトリに存在しない。
μPD8257 がカウント通りにバイトを運び、μPD3301 が来たバイトを表示し、蛍光体が
時間積分した結果として **勝手に27色が出る**。

## 実証2: チップレベルか、画面スクレイパか

```
$ node tools/prove-chip-level.mjs
VRAM moved to 0x8123 via the DMA controller alone.
CRTC now displays: "THE CRTC DOES NOT KNOW WHERE MEMORY IS"
✓ chip-level: the display follows the DMA, not a hardcoded address

Re-RESET the CRTC with different parameters → 40x12, 16 lines/char, hsync=18240Hz
```

- **DMACのch2アドレスだけ**を書き換えると、VRAMが0x8123（誰のVRAMでもない番地）に
  移っても画面が追従する。「F3C8hを読んで80×25を描く」実装では不可能。
- CRTCを再RESETすれば **40×12・16ライン文字**（実機が一度も起動したことのない
  ジオメトリ）でも動く。水平同期も18240Hzに変わる。

## 設計の違い（要点）

| | 典型的なPC-88エミュ | このリポジトリ |
|---|---|---|
| 目的 | **ソフトを動かす**（ゲームが正しく動けば正しい） | **ハードを理解する**（チップの因果を再現する） |
| CRTC | 多くは機能レベル（VRAM番地＋80×25を直接描画）※ | ポート/コマンド/5バイトRESET/行DMA |
| DMA | 画面転送は省略または簡略化されがち※ | ch2/オートロード/ターミナルカウントを実装 |
| 27色技 | 実装依存（DMAを省略していると出ない）※ | **チップの帰結として自然に出る** |
| 表示 | ピクセルを出力して終わり | **蛍光体（2成分減衰・発光色・焼付）＋管（マスク・ビーム・偏向・ガラス）** |
| FDD | 実装済み（ゲームが動く） | **未実装**（D88は読めるが起動はできない） |
| 網羅性 | 実機のほぼ全機能 | テキスト系のみ。88のN88モードは未起動 |

※ 各エミュの実装は本文の調査結果を参照。

## 正直な結論

**ゲームを遊ぶなら他のエミュを使うべき**。QUASI88/M88/MAMEは何年もかけて
FDC・FM音源・グラフィック・タイミングを作り込んでいる。このリポジトリはFDDすら
動かない。

一方で、このリポジトリにしかないもの：

1. **DMAとCRTCの因果が生きている** — 27色技が「再現」ではなく「発生」する
2. **物理層** — 蛍光体の物性（P22の青が先に死ぬ、P7の二層残光）、∵マスク、
   ビームスポット、走査線の隙間、偏向崩壊、V-HOLD、15kHzの音
3. **決定論と検証可能性** — 85本のテストが全部headlessで走る。「たぶん合ってる」
   ではなく「同じ入力→同じビット」

つまりこれは**エミュレータというより、1979年のハードウェアの実行可能な教科書**。
