[English](./comparison.md) · **日本語**

# 他のエミュレータとの比較 — ソースを読んで確かめた

「ちゃんとハードからエミュレートしているのか？」「DMAを2画面分にすると27色になるのか？」
という問いに、**各エミュレータの実ソースを読んで**答える。推測ではなく引用で示す。

調査対象: QUASI88 (libretro mirror, 0.6.4相当) / MAME (master) / M88 (rururutan/m88 mirror) /
j80 (Java, HAL8999作。ソース非公開のため同梱ドキュメントと同梱デモから判定) /
vavi-apps-emu88 (Java, ソースあり)

---

## 結論の要約

| | QUASI88 | MAME | M88 | j80 | **本repo** |
|---|---|---|---|---|---|
| 画面の出所 | **VRAM直読み**（DMACのch2アドレスを基点に毎フレーム同じ場所を読む） | 8257→dack_w→3301行FIFO | PD8257::RequestRead→CRTC行バッファ | DMA経由（※ソース非公開、ドキュメントから判定） | DRQ→DMA pull→行バッファ |
| DMAカウンタ(TC) | **未実装**（レジスタに書くだけで誰も読まない） | 実装 | 実装 | 実装（履歴に「TC設定時のWrビット混入バグ修正」等） | 実装 |
| オートロード(ch3→ch2) | **未実装** | 実装 | 実装 | 実装（同梱デモが `out &h68,&hc4` を使用） | 実装 |
| **27色技の「機構」** | **原理的に不可能** | **再現される** | **再現される** | **再現される**（作者が「Twenty-7対応」と明記、専用デモ同梱） | **再現される** |
| **27色技の「混色」** | — | **しない**（毎フレームbitmapクリア、残光なし） | 未確認 | 未確認 | **する**（蛍光体が時間積分） |
| アトリビュートペア展開 | 実装 | 実装 | 実装 | 実装（可変組数・行跨ぎのブリンク/シークレット継承まで） | 実装 |
| 20ペア/行の上限 | 実装 | 実装 | **無し** | 可変組数対応（履歴に明記） | 実装 |
| DMAアンダーラン | **未実装**（statusをクリアするだけ） | **未実装**（TODOに明記） | 実装 | **実装**（TRACE ONで警告表示） | 実装 |
| DMAのラスタ内タイミング | 無し（ウェイト数だけ逆算） | **無し**（TODOに明記：フレーム末に一括転送） | **行単位**（scheduler） | 未確認 | 無し（フレーム粒度） |
| FDD / ゲーム | 動く | 動く | 動く | 動く | **動かない** |
| 蛍光体・管の物理 | 無し | 無し（HLSLシェーダは別レイヤ） | 未確認 | 無し | **有り** |

（もうひとつのJava製 `vavi-apps-emu88` も読んだが、CRTC RESETパラメータを全部捨てて
80×25固定描画、DMAはモード書き込み時の一括コピー1回きり。TC=5999を書くと
`tvram[49]` 参照で**例外を投げて落ちる**。比較表には含めない。）

**要点：チップレベルで作っているのは MAME と M88 も同じ**。「うちだけが本物」という主張は
成り立たない。うちが唯一持っているのは **蛍光体・管の物理層**（＝混色が実際に起きること）と、
決定論・headlessテストの徹底。

---

## 1. QUASI88 — CRTCのコマンドは解釈するが、データパスはVRAM直読み

`src/screen.c` の `crtc_make_text_attr()`:

```c
char_start_addr = text_dma_addr.W;              /* = dmac_address[2] */
attr_start_addr = text_dma_addr.W + crtc_sz_columns;
for( i=0; i<crtc_sz_lines; i++ ){
    ...
    *text_attr++ = ((Ushort)main_ram[ c_addr++ ] << 8 ) | global_attr;
```

DMACのch2 **アドレス**を基点に、毎フレーム `main_ram` を直接読む。行DMAもFIFOも無い。
そして `src/crtcdmac.c` のカウンタは:

```c
void dmac_out_counter( byte addr, byte data ){
  if( dmac_flipflop==0 ) dmac_counter[ addr ].B.l=data;
  else                   dmac_counter[ addr ].B.h=data;
  dmac_flipflop ^= 0x1;
}
byte dmac_in_status( void ){ return 0x1f; }   /* 常に「全ch TC到達済」を返すだけ */
```

`dmac_counter[]` は**書き込みとstate save以外どこからも参照されない**。オートロードもTCも無い。

→ **port 65h に 5999 を書いても 2999 を書いても、描画は一切変わらない。**
QUASI88 では27色技は**原理的に再現できない**（フレームを跨いで進むアドレスカウンタという
状態変数そのものが存在しないため）。

CRTCのステータスも `CRTC_STATUS_U`（DMAアンダーラン）は**クリアされるだけで一度もセットされない**。

一方、アトリビュートの水平方向の挙動（20ペア制限、先着優先、色/装飾の2系統ラッチ）は
かなり忠実に実装されている。

---

## 2. MAME — チップレベル。27色の「機構」は再現される

配線 (`src/mame/nec/pc8001.cpp`):

```cpp
m_crtc->drq_wr_callback().set(m_dma, FUNC(i8257_device::dreq2_w));
m_dma->in_memr_cb().set(FUNC(pc8001_state::dma_mem_r));
m_dma->out_iow_cb<2>().set(m_crtc, FUNC(upd3301_device::dack_w));
```

μPD3301 側に**VRAMアドレスは存在しない**。あるのは行FIFOだけ (`upd3301.h`):

```cpp
u8 m_data_fifo[2][80];                            // row data FIFO
std::array<std::array<u8, 40+1>, 2> m_attr_fifo;  // attribute FIFO
```

`dack_w()` は届いたバイトを**バイト数だけで振り分ける**（先頭 `m_h` バイト＝文字、
続く `m_attr*2` ＝アトリビュート）。行が揃えば `draw_scanline()`。
**画面はDMAで運ばれたバイト列の産物**であり、VRAMを直接読むコードは無い。

i8257 のオートロード (`src/devices/machine/i8257.cpp`):

```cpp
if(tc) {
    m_status |= 1 << m_current_channel;
    if(al) {   // autoinitialize
        m_channel[2].m_address = m_channel[3].m_address;
        m_channel[2].m_count   = m_channel[3].m_count;
    }
}
```

**アドレスとカウントはフレームを跨いで保持され、VRTCでリセットされない。**
→ count=5999 なら、フレーム1で3000バイト、フレーム2で続きの3000バイト、
6000バイト目でTC→ch3から巻き戻し。**2画面交互は正しく起きる。**

**ただし混色はしない**。`screen_update` は `copybitmap` のみで、`reset_fifo_vrtc()` が
毎フレーム `m_bitmap.fill(0)` する。つまり MAME は **30Hzのちらつきとして出力する**
（実機CRTなら残光と目が積分して27色に見えるが、MAME自身は積分しない）。
スクリーンショットやコマ落ちでは片方の画面しか写らない。

既知の非正確点（ソース冒頭のTODO）：

```
- proper DMA timing (now the whole screen is transferred at the end of the frame, ...)
- DMA underrun (sorcerml in pc8801?). Should throw a status U irq;
```

---

## 3. M88 — 行単位DMA。タイミングはMAMEより細かい

`src/pc88/crtc.cpp` — CRTCが1行分をDMACから**ブロック転送で引く**:

```cpp
if (linesize > dmac->RequestRead(dmabank, dest, linesize))
{
    // DMA アンダーラン
    mode = (mode & ~(enable)) | clear;
    status = (status & ~0x10) | 0x08;
}
```

行ごとの転送がschedulerで `linetime` ごとに進むので、**DMAタイミングはMAMEより細かい**（行単位）。
MAMEが未実装のアンダーランも実装済み。

`src/pc88/pd8257.cpp` — ch2のautoinit:

```cpp
if (stat.count[bank] < 0) {
    if (bank == 2 && stat.autoinit) {
        stat.ptr[2] = stat.ptr[3];
        stat.count[2] = stat.count[3];
    }
}
```

→ **M88も2画面交互を再現する構造**。ただし20ペア/行の上限は無い
（`attrperline + width > 120` で無効化するだけ）。
（余談: `SetCount` に `stat.mode[3] = stat.mode[3];` という自己代入のタイポがある）

---

## 4. j80 (Java) — ソース非公開だが、27色技への対応を作者が明記

j80（作者 HAL8999、「OUT of STANDARD」）はソース非公開（配布jarは難読化済み）なので
コード引用はできない。だが同梱物が決定的だった。

`util/27view/tool/27view.txt` — **27色技を実行するN-BASICデモが同梱されている**:

```basic
200 out &h51,&h0          ' CRTC RESET
210 out &h68,&h80         ' 8257: autoload
220 out &h64,&h90:out &h64,&hc8   ' ch2 addr = C890h
230 out &h65,&h6f:out &h65,&h97   ' ch2 TC = 976Fh = 8000h + 5999 ← 2画面分！
240 out &h68,&hc4         ' autoload + TC stop + ch2 enable
250 out &h51,&h20         ' START DISPLAY
```

`doc/history.txt`（作者本人の開発記録）:

```
・VRAMサイズ可変対応(ポート 0x65 実装)
  　→ Twenty-7(PiO '84/) ２画面合成お絵描きツール に対応
・TRACE ON で、DMAアンダーラン発生時に警告を表示するようにした
・0,20組以外のアトリビュートサイズに対応した
```

つまり **j80 は27色技（実ソフト「Twenty-7」PiO '84年）に明示的に対応している**。
DMAアンダーランのトレース、可変アトリビュート組数、行を跨ぐブリンク/シークレット
継承まで履歴にあり、実装レベルはかなり深い。謝辞には「uPD3301A CRTC
ユーザーズ・マニュアル提供」とあり、実チップ資料ベースで書かれている。
ハイドライド作者の内藤時浩氏が「j80が一番いい」と評したという話があるが、
この調査結果はそれと整合する — **調べた中で、27色技への対応を明記していた
唯一の既存エミュレータが j80 だった**。

なお、もうひとつのJava製でソースが読める `vavi-apps-emu88` (umjammer) は対照的で、
CRTC RESET の5バイトパラメータを**ローカル変数に受けて捨てている**（行数・桁数・
アトリ組数がどこにも反映されない）、描画は80×25固定、DMAはモードレジスタ書き込み時の
一括コピー1回きり。TC=5999 を書くと `tvram[49]`（26行分しか確保されていない）で
**ArrayIndexOutOfBoundsException を投げる**。

---

## 5. 本repo — 同じチップレベル、その先に物理層

```
$ node tools/prove-27color.mjs
frame-by-frame color index of the same dot: RED → GREEN → RED → GREEN → RED → GREEN
what the long-persistence phosphor integrates: R=1.13 G=1.25 B=0.28
  → the eye sees YELLOW-ish: a color the 8-color hardware cannot produce.
```

port 65h に `8000h+5999` を書いただけ。トリック用の特別扱いコードはゼロ。
**そしてMAME/M88と違い、蛍光体が時間積分するので「混色」まで再現される** —
27色技が「ちらつき」ではなく「色」として見える。

```
$ node tools/prove-chip-level.mjs
VRAM moved to 0x8123 via the DMA controller alone.
CRTC now displays: "THE CRTC DOES NOT KNOW WHERE MEMORY IS"
Re-RESET the CRTC → 40x12, 16 lines/char, hsync=18240Hz
```

DMACのch2アドレスだけを書き換えるとVRAMが任意の番地に移動しても追従する。
CRTCを再RESETすれば実機が起動したことのないジオメトリでも動く。

---

## 正直な結論

- **「他のエミュはハードをちゃんとエミュレートしていない」は誤り。** MAMEとM88は
  うちと同じくチップレベルで、DMA→CRTCのデータパスを持っている。M88のDMAタイミングは
  うちより細かい（行単位 vs フレーム単位）。
- **QUASI88だけは違う**（VRAM直読み・TCもオートロードも無し）。27色技は動かない。
  ただしQUASI88の目的は「ソフトを速く正しく動かすこと」であり、これは設計判断として
  合理的である。
- **j80 は27色技への対応を明記した唯一の既存エミュ**。デモまで同梱している。
  ソースは読めないが、履歴の粒度（アンダーラントレース、可変アトリ組数）から
  チップレベル実装と判断できる。
- **ゲームを遊ぶなら他のエミュを使うべき**。うちはFDDが動かない。
- **うちにしかないもの**は「チップレベル」ではなく、その**先**にある:
  1. **物理層** — 蛍光体（P22の青が先に死ぬ、P7の二層残光、焼き付き）、∵シャドウマスク、
     ビームスポットの滲み、走査線の隙間、偏向崩壊、V-HOLD、15kHzの音鳴り。
     **MAMEは30Hzちらつきを出力するだけだが、うちは蛍光体が積分して実際に色になる。**
  2. **決定論と検証可能性** — 85本のテストが全てheadlessで走る。27色技もテストの一部。
  3. **教材性** — チップの因果が読めるサイズのコードで書かれている。

つまりこれは「より正確なエミュレータ」ではなく、**表示装置の物理までを含めた、
実行可能な教科書**である。
