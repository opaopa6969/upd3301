[English](./z80asm.md) · **日本語**

# z80asm — マクロアセンブラ フルリファレンス

依存ゼロのJS1ファイル（`z80asm.js`）に入った2パスZ80マクロアセンブラ。
ICEのアセンブラペインの中で育ち、作者の「USESみたいなものをマクロで
組めるくらいの表現力」というリクエストでMACRO-80互換を獲得した。
実際に組めるようになった証拠は[ユーザーランドUSESの実例](#userland-uses)へ。

```js
import { assemble } from './z80asm.js';
const r = assemble(source, { org: 0x9000 });
// r = { bytes, org, symbols, listing, errors, warnings, fixups }
```

エラーは例外でなく `{line, message}` の配列で収集される。マクロ展開から
生まれた行のエラーには `(expanded from line N)` が付く。

## ソース形式

```asm
label:  LD A,10        ; コロンラベル
.loop:  DJNZ .loop     ; ローカルラベル — 直前のグローバルラベル配下
name    EQU 42         ; EQU/MACRO/PROC/STRUC/ENDS/ENDP形はコロン不要
        JR label       ; コメントは ;
```

ニーモニック・レジスタ・シンボルは大文字小文字を区別しない。Z80全命令
対応。未文書命令の使いどころも入ってる（`SLL`、`IXH/IXL/IYH/IYL`、
`RR (IX+4),B` などのDDCB/FDCBレジスタコピー形、`IN (C)`、`OUT (C),0`）。

## 数値と式

| 形式 | 例 |
|---|---|
| 10進 | `10`, `10d` |
| 16進 | `0x1F`, `1Fh`, `0FFh`（`h`形式は先頭が数字であること） |
| 2進 | `1010b`, `0b1010` |
| 文字 | `'A'`, `'\n'` |
| 現在地 | `$` = その文の先頭アドレス |

演算子はCライクな優先順位で `+ - * / % & | ^ << >> ~` と括弧。
アセンブル時に評価される式なら前方参照OK（第2パスが解決する）。
**例外**は`IF`族の条件式 — 展開時に評価されるので、まだ存在しない
シンボルは正直にエラーになる。

## 疑似命令

| 命令 | 意味 |
|---|---|
| `ORG addr` | 配置先（パス1で確定していること） |
| `name EQU expr`（`=`も可） | 定数定義 |
| `DB / DEFB / DEFM` | バイト列。文字列可: `DB "HI",13,10,0` |
| `DW / DEFW` | リトルエンディアンのワード |
| `DS n [, fill]` | n バイト確保（個数はパス1で確定していること） |
| `END` | ここでアセンブル終了 |
| `INCLUDE "path"` | resolverコールバック経由のテキストinclude（IDE参照） |

## マクロ

```asm
out2    MACRO port, val     ; MACRO out2 port,val の形式も可
        LD A,val
        OUT (port),A
        ENDM

        out2 51h, 0         ; 展開
        out2 51h, <1, 2>    ; <…>は丸ごと1引数（中のカンマは割れない）
        out2 51h, %(N*2+1)  ; %式は評価した「値」を渡す（テキストでなく）
```

- `REPT n … ENDM` — n回反復（nはそこまでに定義済みのEQUが使える）
- `IRP r,<bc,de,hl> … ENDM` — `<>`括りリストを反復、`r`に逐次束縛
- `IRPC c,ABC … ENDM` — 文字反復。文字列リテラル内は `'&c'` で置換
  （M80の流儀）
- `LOCAL a,b` — 展開毎にユニーク名を発行（M80式）。うちの自動スコープ
  `.label` でも同じことができる（両方有効）
- `EXITM` — 一番内側のマクロ/REPT/IRP展開を途中脱出（IF内から使うのが定番）
- `PURGE name` — マクロ定義を削除（下のシャドウイング参照）

### `&` 連結

`label&n:` はパラメータをトークンに貼り付ける — `n = 2` なら `label2:`。
`&` が消費されるのは**置換パラメータに空白なしで隣接**しているときだけ。
`a & b` のように空白があればビットANDのまま。M80より意図的に厳しくした
（M80には守るべき`&`演算子が無かった）。

### 条件アセンブル

```asm
        IF 式            ; 非0で真
          …
        ELSE
          …
        ENDIF
```

| 形式 | 真になる条件 |
|---|---|
| `IF 式` | 式 ≠ 0 |
| `IFE 式` | 式 = 0 |
| `IFDEF name` / `IFNDEF` | シンボルかマクロが（そこまでに）定義済み / 未定義 |
| `IFB <引数>` / `IFNB` | 引数が空 / 空でない — 可変長風マクロに |
| `IFIDN <a>,<b>` / `IFDIF` | 引数テキストが一致（大文字小文字無視）/ 相違 |

条件は2パスの**前**、展開時に1回だけ評価される — だからパス間で
矛盾しようがない。IF内でラベル（アドレス）を参照したら、展開器には
知りようがない前方参照なので正直にエラー。

### ニーモニックシャドウイングと PURGE

マクロは組み込みニーモニックと同名でよい — **マクロが勝つ**。
そのマクロ自身の本体の中では、同名は**組み込み**に解決される
（M80の規則。`RET`シャドウが無限再帰しないのはこのおかげ）。
`PURGE name` でマクロを消せば組み込みが戻る。

<a id="userland-uses"></a>
### 実例: ユーザーランドUSES

組み込みの `PROC USES` シュガーを、生のマクロ部品だけで再構築する。
`RET` をシャドウすれば、全部の戻り口にエピローグが自動で生える:

```asm
PROLOG  MACRO
        PUSH BC
        PUSH DE
        ENDM
RET     MACRO               ; 組み込みをシャドウ
        POP DE
        POP BC
        RET                 ; ← シャドウの中ではこれが組み込みのRET
        ENDM

f:      PROLOG
        LD BC,0
        RET                 ; POP DE / POP BC / RET に展開される
        PURGE RET           ; 以降のRETは組み込みに戻る
```

これは次とバイト単位で一致する:

```asm
f PROC USES BC,DE
        LD BC,0
        RET
f ENDP
```

## MACRO-80 差分表

| 機能 | 状態 | 備考 |
|---|---|---|
| `MACRO` / `ENDM` / `REPT` | 互換 | `name MACRO` と `MACRO name` 両形式 |
| `IRP` / `IRPC` | 互換 | `<>`リスト、文字列内は`'&c'` |
| `LOCAL` | 互換 | ＋うちの自動`.label`スコープも併用可 |
| `EXITM` | 互換 | マクロ/REPT/IRPを巻き戻す |
| `IF/IFE/ELSE/ENDIF`, `IFDEF/IFNDEF`, `IFB/IFNB`, `IFIDN/IFDIF` | 互換 | 展開時評価・パス一貫 |
| `&`連結・`%式`値渡し | 互換 | `&`は空白なし隣接のみ |
| ニーモニックシャドウ＋`PURGE` | 互換 | シャドウ内の同名は組み込み解決 |
| `IF1` / `IF2` | **非対応** | 1回展開＋2パス構造なのでパス別ソースは存在できない — 明確なエラー |
| IF内のマクロ定義 | **非対応** | 定義は展開前に収集されるため、`IFNDEF`ガード付き再定義はガードにならない |
| `.PHASE/.DEPHASE`, `PUBLIC/EXTRN`, `.REQUEST` | 非対応 | 単一イメージ・リンカ無し |
| ローカルラベル `.name` | **拡張** | 直前グローバル配下＋展開毎に自動スコープ |
| オペランドの前方参照 | **拡張** | M80は宣言が要ったが、うちは第2パスが解決する |
| `PROC USES` / `STRUC` / `RELOC` / `FIXUPTABLE` | **拡張** | 石器シュガー。[ICE設計](./ice-design.ja.md)参照 |
| エラーの出所表示 | **拡張** | マクロ由来のエラーに `(expanded from line N)` |

## 拡張の詳細

### PROC USES

```asm
f PROC USES BC,DE      ; プロローグ: PUSH BC / PUSH DE
        RET            ; 素のRETは全部 POP DE / POP BC / RET に
f ENDP
```

内側の条件付き `RET NZ` は**エラー** — 書き換えたら意味が変わるので、
そのエピローグは自分で書く。

### STRUC

```asm
player STRUC
x       DB 0
hp      DW 0
player ENDS            ; player.x=0, player.hp=1, player=3（総サイズ）
        LD A,(IX+player.x)
```

### RELOC / FIXUPTABLE

```asm
RELOC
start:  LD HL,msg      ; 領域内ラベルへの絶対参照を自動記録
        JP start       ; ← 警告: JRで届く距離（JRはタダでリロケータブル）
msg:    DB "HI",0
ENDRELOC
table:  FIXUPTABLE     ; DW 件数, DW オフセット…（領域先頭相対）を埋め込む
```

同じオフセット列は `result.fixups` でも取れる — どちらでも自己再配置
ローダに食わせられる。
