---
name: retro-reverse-analysis
description: レトロPC（PC-8001/8801）のZ80バイナリやD88ディスクイメージを逆アセンブル・解析する手順。upd3301 MCP の tool を組み合わせる。
volta:
  version: 2
  namespace: upd3301
  locality: repo
  applies_when: Z80バイナリやD88ディスクイメージを解析・逆アセンブルするとき
  requires:
    tools:
      - z80_disassemble
      - rom_identify
      - d88_info
      - analysis_validate
      - analysis_merge
  min_role: MEMBER
  tags:
    - retro
    - z80
    - reverse-engineering
---

# レトロPCの逆アセンブルと解析

## 目的

PC-8001/8801 の ROM やディスクイメージから、コードを逆アセンブルし、
ラベル付けした解析レコードを作成・統合する。

## 手順

1. **ROMファイルの識別**: `upd3301__rom_identify` に filename を渡し、
   PC-8001/8801 の ROM か判定する。`role` が返れば解析対象。

2. **D88ディスクの構造把握**: `upd3301__d88_info` に D88 bytes を渡し、
   トラック・セクタ構成とコピープロテクトの有無（oddities）を把握する。

3. **逆アセンブル**: `upd3301__z80_disassemble` に bytes と addr を渡し、
   Z80コードを逆アセンブルする。`syntax: "intel"` で 8080 ニーモニックも可。

4. **解析レコードの作成**: `analysisdb.js` 形式の JSON ドキュメントを作成する。
   `schemaVersion`, `machine`, `romHash`, `labels` が必須。
   各ラベルに `confidence` (observed|inferred|guess) と `evidence` を付ける。

5. **検証**: `upd3301__analysis_validate` で解析レコードを検証する。
   `ok: true` になるまで修正する。

6. **マージ**: 複数の解析レコードを `upd3301__analysis_merge` で統合する。
   merge は可換・結合的・冪等。romHash 不一致は `force: true` で強制マージ可能。

## 組み合わせ

```
rom_identify → d88_info → z80_disassemble → analysis_validate → analysis_merge
```

## 注意

- romHash は必須。異なる ROM リビジョンへのラベル適用を防ぐ。
- merge の opts.force は最後の手段。理由を明記すること。
- Z80逆アセンブラは `z80asm.js` と往復テスト可能（アセンブル結果を逆アセンブルして一致確認）。
