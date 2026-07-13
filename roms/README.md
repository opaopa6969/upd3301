# roms/ — BYO-ROM

実機から吸い出したROMをここに置く（**gitには入らない**。.gitignore済み）。

| 期待ファイル | サイズ | 用途 |
|---|---|---|
| N80.ROM | 24576 (24KB) | N-BASIC 本体 (0000-5FFFh) |
| FONT.ROM / FONT80.ROM | 2048 (2KB) | キャラジェネ (256字×8バイト) |
| PC-80S31.ROM / DISK.ROM | 2048 / 8192 | ディスクユニットのサブZ80 ROM |

`node tools/identify-roms.mjs roms/` でサイズ・ハッシュから既知セットを判定できる。
