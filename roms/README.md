# roms/ — BYO-ROM

実機から吸い出したROMをここに置く（**gitには入らない**。.gitignore済み）。

| 期待ファイル | サイズ | 用途 |
|---|---|---|
| N80.ROM | 24576 (24KB) | N-BASIC 本体 (0000-5FFFh) |
| FONT.ROM / FONT80.ROM | 2048 (2KB) | キャラジェネ (256字×8バイト) |
| PC-80S31.ROM / DISK.ROM | 2048 / 8192 | ディスクユニットのサブZ80 ROM |

`node tools/identify-roms.mjs roms/` でサイズ・ハッシュから既知セットを判定できる。

## ハッシュ表（手元の吸出しの照合用）

CRC32/SHA-1 が一致すれば同一ダンプ。機種・BASICバージョン違いで別ハッシュの正規ROMもあるので、まずサイズが合っていれば起動を試せる。基準は **PC-8801MC** の一式。
（照合: `crc32 <file>` / `sha1sum <file>`。ランディング <../index.html> にも同じ表を掲載。）

### PC-8801 N88 BIOS一式

| ファイル | サイズ | CRC32 | SHA-1 |
|---|---|---|---|
| n88.rom | 32768 | 356D5719 | 5d9ba80d593a5119f52aae1ccd61a1457b4a89a1 |
| n88_0.rom | 8192 | A72697D7 | 5aedbc5916d67ef28767a2b942864765eea81bb8 |
| n88_1.rom | 8192 | 7AD5D943 | 4ae4d37409ff99411a623da9f6a44192170a854e |
| n88_2.rom | 8192 | 1D6277B6 | dd9c3e50169b75bb707ef648f20d352e6a8bcfe4 |
| n88_3.rom | 8192 | 692CBCD8 | af452aed79b072c4d17985830b7c5dca64d4b412 |
| disk.rom | 8192 | A222ECF0 | 79e9c0786a14142f7a83690bf41fb4f60c5c1004 |
| n80.rom（任意） | 32768 | 8A2A1E17 | 06dae1db384aa29d81c5b6ed587877e7128fcb35 |

### 漢字ROM（漢字表示用・実装予定）

| ファイル | サイズ | CRC32 | SHA-1 |
|---|---|---|---|
| kanji1.rom（第1水準） | 131072 | 6178BD43 | 82e11a177af6a5091dd67f50a2f4bafda84d6556 |
| kanji2.rom（第2水準） | 131072 | 376EB677 | bcf96584e2ba362218b813be51ea21573d1a2a78 |

### PC-8001

| ファイル | サイズ | CRC32 | SHA-1 |
|---|---|---|---|
| N80_2.ROM | 32768 | 03CCE7B6 | c12d34e42021110930fed45a8af98db52136f1fb |

## 自動読み込み（machine.html）

```sh
node tools/import-bios.mjs /mnt/c/Users/opaop/Downloads/BIOS   # 展開＋manifest生成
node serve.py 3301   # または python3 serve.py 3301
```
→ http://localhost:3301/demo/machine.html が `roms/manifest.json` を読んで
機種プルダウンを作り、既定機（PC-8001mkII）を自動起動する。

公開サイトにはROMを置かない（NEC著作権、2049年まで）ので、そちらでは
manifest.jsonが404 → 従来のファイル選択にフォールバックする。
