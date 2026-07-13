# roms/ — BYO-ROM

実機から吸い出したROMをここに置く（**gitには入らない**。.gitignore済み）。

| 期待ファイル | サイズ | 用途 |
|---|---|---|
| N80.ROM | 24576 (24KB) | N-BASIC 本体 (0000-5FFFh) |
| FONT.ROM / FONT80.ROM | 2048 (2KB) | キャラジェネ (256字×8バイト) |
| PC-80S31.ROM / DISK.ROM | 2048 / 8192 | ディスクユニットのサブZ80 ROM |

`node tools/identify-roms.mjs roms/` でサイズ・ハッシュから既知セットを判定できる。

## 自動読み込み（machine.html）

```sh
node tools/import-bios.mjs /mnt/c/Users/opaop/Downloads/BIOS   # 展開＋manifest生成
node serve.py 3301   # または python3 serve.py 3301
```
→ http://localhost:3301/demo/machine.html が `roms/manifest.json` を読んで
機種プルダウンを作り、既定機（PC-8001mkII）を自動起動する。

公開サイトにはROMを置かない（NEC著作権、2049年まで）ので、そちらでは
manifest.jsonが404 → 従来のファイル選択にフォールバックする。
