[English](./library.md) · **日本語**

# 各部品をライブラリとして使う

このrepoの中身は全部「依存ゼロ・DOM不使用・決定論のESモジュール」なので、
どの層も生まれつきライブラリだ。`package.json` の subpath exports で
そのまま引ける：

```js
import { Upd3301 } from 'upd3301';            // CRTC本体
import { CrtPhosphor, PHOSPHORS } from 'upd3301/crt';
import { CrtTube } from 'upd3301/tube';
import { Terminal } from 'upd3301/term';
import { Z80 } from 'upd3301/z80';
```

（repoはprivate・未公開なので、git URL・ワークスペースパス・またはデモと
同じ importmap 方式で読み込む。）

## レイヤ地図

```
L3  ガラス   crt.js（蛍光体）  tube.js（マスク/ジオメトリ）  ← フレームバッファin
L2  内容     term.js（ANSI）   semivideo.js（動画変換）        RGBA out。下の層を
L1  基板     pc8001.js machine.js machine88.js pc80s31.js      一切知らない
L0  チップ   index.js(3301) upd8257 i8255 upd765 z80
             d88.js（メディア）
```

依存は必ず下向きで、**L3は下の層を一切importしない**。再利用で効くのは
まさにここ：

## CRTを純粋なレンダラーとして（何にでも）

`crt.js`＋`tube.js` はフレームバッファを受けてRGBAを返すだけ。ピクセルの
出自（3301でも自作ゲームでもターミナルでも動画でも）を問わない：

```js
import { CrtPhosphor, PHOSPHORS } from 'upd3301/crt';
import { CrtTube } from 'upd3301/tube';

const W = 640, H = 200;
const phos = new CrtPhosphor({ width: W, height: H, phosphor: PHOSPHORS.P22 });
const tube = new CrtTube({
  srcWidth: W, srcHeight: H, outWidth: W, outHeight: H * 2,
  mask: 'aperture', maskPitch: 3, barrel: 0.06,
});

// 毎フレーム:
phos.step(indexedPixels, 1 / 60);       // 0..7 の色インデックス Uint8Array
// フルカラーソースなら phos.stepAnalog(rgbaPixels, 1/60)
tube.apply(phos.composite(), imageData.data, { scale: 1.2 });
ctx.putImageData(imageData, 0, 0);
```

レンダラー契約はこの2呼び出しが全て。蛍光体の減衰・焼き付き・ガン別
コンバージェンス・シャドウマスク・樽型歪み・ガラス反射はこの間で起きる。
おまけの純関数も `crt.js` にある：`collapseScan`（電源断）、`rollScan`
（V-HOLD）、`tintMatrix`（NTSCのTINT）。

## ターミナル部品

`term.js` はANSIエスケープを3301のアトリビュート形式にコンパイルする
小さなターミナル——「1979年の描画をするxterm.js」だと思ってほしい：

```js
import { Terminal } from 'upd3301/term';

const t = new Terminal({ cols: 80, rows: 25 });
t.write('\x1b[31mhello \x1b[7m1979\x1b[0m\r\n');
const frame = t.render({ cgrom });  // → { width, height, pixels } インデックス
// frame.pixels を上の CrtPhosphor に流す
```

### xterm.jsについて

xterm.jsは**MITライセンス**なのでフォークも組み込みも自由（著作権表記の
保持だけ守ればいい）。ただ、きれいな統合はフォークじゃなくて
**レンダラーaddon**：xterm.jsの描画は差し替え可能なaddon構造で（公式の
canvas/WebGLレンダラーもaddon）、xterm.jsのバッファからセルを取って
`CrtPhosphor`/`CrtTube` に流す `crt-xterm` addonを書けば、フル機能の
本物ターミナルが本物のガラスを被る。フォークの保守も要らないし、
両側MITでライセンスも噛み合う。

## マシンもライブラリ

```js
import { Pc8001Machine } from 'upd3301/machine';    // Z80+ROM+3301+8257(+PC-8012バンク)
import { Pc8801Machine } from 'upd3301/machine88';  // +バンク・GVRAM・FDDサブシステム
import { parseD88 } from 'upd3301/d88';
```

全部headless：`machine.stepFrame()` → `machine.render()` /
`machine.screenText()`。ROMは同梱しない（bring your own）。
