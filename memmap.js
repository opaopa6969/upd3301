// memmap — annotated memory maps for the PC-8001 / PC-8801.
//
// Fixed regions with names, descriptions and an honesty tag:
//   confidence: 'verified'   — walked in this repo's own boot traces
//               'documented' — from period documentation / other emulators
//               'approx'     — best estimate, edges may be off
//
// Consumers: the ICE hex dump (annotate addresses), the relocation stone
// tools (pin presets — regions that must never move), and free-memory
// estimation (the complement of everything known, refined by trace
// coverage when available). Pure data + pure functions, zero deps.

export const SCHEMA_VERSION = 1;

// kind: rom | ext | vectors | hooks | work | shadow | vram | stack | user
const R = (start, end, name, kind, confidence, desc) =>
  Object.freeze({ start, end, name, kind, confidence, desc });

export const MAPS = Object.freeze({
  pc8001: Object.freeze([
    R(0x0000, 0x5fff, 'N-BASIC ROM', 'rom', 'verified',
      'N-BASIC 24KB。RST vectors at the bottom; writes fall through to nothing'),
    R(0x6000, 0x7fff, 'ext ROM / PC-8012 bank window', 'ext', 'verified',
      '拡張ROM。PC-8012バンクRAM有効時はここ(実際は0000-7FFF全体)がRAMに化ける'),
    R(0x8000, 0xf3c7, 'user RAM', 'user', 'documented',
      'ユーザー領域(32KB実装時)。上端はBASICワークとCLEAR文次第で下がる'),
    R(0xf3c8, 0xff7f, 'text VRAM', 'vram', 'verified',
      '120バイト×25行(80文字+アトリビュート20ペア)。DMAC ch2がここを毎フレーム運ぶ'),
    R(0xff80, 0xffff, 'N-BASIC work (top page)', 'work', 'approx',
      'BASICワーク末端。キーバッファ等。境界はROM版差あり'),
  ]),

  pc8801: Object.freeze([
    R(0x0000, 0x5fff, 'N88-BASIC ROM', 'rom', 'verified',
      'N88 main ROM(RAM裏あり)。RSTはOSコール入口(RST 30h=バンク間ディスパッチャ等)'),
    R(0x6000, 0x7fff, 'ext ROM window', 'ext', 'verified',
      '拡張ROM 4バンク。port 71h bit0でマップ、バンク番号はport 32h bit0-1(EROMSL)'),
    R(0x8000, 0x83ff, 'window (port 70h)', 'work', 'documented',
      '高速RAMアクセス用ウィンドウ。port 70hでオフセット指定'),
    R(0x8400, 0xe4ff, 'user RAM', 'user', 'documented',
      'ユーザー領域。上端はBASICワークとCLEAR文次第'),
    R(0xe500, 0xe5ff, 'boot stack', 'stack', 'verified',
      '起動時SP=E5FE。BASIC起動後はスタックは移動する'),
    R(0xe600, 0xe6ff, 'system shadows / BASIC flags', 'shadow', 'verified',
      'E6C0/E6C1/E6C2=port 30h/40h/31hのシャドウ(書き込み専用ポートの記憶)ほかBASICフラグ'),
    R(0xe700, 0xebff, 'N88-BASIC work', 'work', 'approx',
      'BASICインタプリタのワーク(E7E8=エリアポインタ等)。境界はROM版差あり'),
    R(0xec00, 0xecff, 'disk/boot work', 'work', 'verified',
      'EC7D=総ドライブ数, EC85=カレント, EC88, ECB4=ブートリトライカウンタ'),
    R(0xed00, 0xeeff, 'RAM hooks (JP table)', 'hooks', 'verified',
      '3バイト刻みのC3 xx xxフック群。EDF3=拡張ROMベクタコール用。書き換えでOS横取り'),
    R(0xef00, 0xef8f, 'disk BASIC work', 'work', 'verified',
      'EF14=タイムアウト, EF4A=unit, EF5D=interface, EF5F=track, EF60-64=ドライブ表, EF7F=DIP反転シャドウ'),
    R(0xf300, 0xf31f, 'IM2 interrupt vectors', 'vectors', 'verified',
      'I=F3。下位=ソース番号×2: F300=SIO, F302=VSYNC, F304=RTC(1/600s), F308=SOUND'),
    R(0xf3c8, 0xff7f, 'text VRAM', 'vram', 'verified',
      '120バイト×25行。8001と同じ3301+DMA ch2の管轄(FCB0=ファンクションキー行)'),
    R(0xff80, 0xffff, 'work (top page)', 'work', 'approx',
      'ワーク末端。境界はROM版差あり'),
  ]),
});


// Named work variables — individual bytes whose MEANING we pinned down in
// this repo's boot investigations (all verified). The generated cross
// reference (romxref.js, via tools/gen-romxref.mjs) tells you WHO reads
// and writes them; this table tells you WHAT they are.
export const WORK_VARS = Object.freeze({
  pc8801: Object.freeze({
    0xe6c0: { name: 'shadow_port30', ja: 'port 30h(書込専用)のシャドウ', en: 'shadow of write-only port 30h' },
    0xe6c1: { name: 'shadow_port40', ja: 'port 40h出力のシャドウ', en: 'shadow of port 40h output' },
    0xe6c2: { name: 'shadow_port31', ja: 'port 31h(書込専用)のシャドウ', en: 'shadow of write-only port 31h' },
    0xe7e8: { name: 'basic_area_ptr', ja: 'BASICエリアポインタ', en: 'BASIC area pointer' },
    0xec7d: { name: 'drive_total', ja: '総ドライブ数(drivetab_buildが設定)', en: 'total drive count (set by drivetab_build)' },
    0xec85: { name: 'drive_current', ja: 'カレントドライブ', en: 'current drive' },
    0xecb4: { name: 'boot_retry_ctr', ja: 'ディスクブートのリトライカウンタ(最大4)', en: 'disk boot retry counter (max 4)' },
    0xef10: { name: 'sub_hs_bailmode', ja: 'ハンドシェイクタイムアウト時の脱出先選択', en: 'handshake-timeout bail-out selector' },
    0xef14: { name: 'sub_hs_timeout_d', ja: 'ハンドシェイクタイムアウトのD初期値(BC×D)', en: 'handshake timeout D reload (BC×D spins)' },
    0xef4a: { name: 'sub_rw_unit', ja: 'サブR/Wコマンドのユニット番号', en: 'unit number for sub R/W commands' },
    0xef5d: { name: 'sub_rw_iface', ja: 'インターフェース種別(EF64から転記、2=密結合)', en: 'interface type (copied from EF64; 2 = packed)' },
    0xef5f: { name: 'sub_rw_track', ja: 'サブR/Wコマンドのトラック', en: 'track for sub R/W commands' },
    0xef60: { name: 'drives_int_a', ja: '内蔵I/F Aのドライブ数(EF35表から)', en: 'internal i/f A drive count (from EF35 table)' },
    0xef61: { name: 'drives_int_b', ja: '内蔵I/F Bのドライブ数(EF2D表から)', en: 'internal i/f B drive count (from EF2D table)' },
    0xef62: { name: 'drives_sub', ja: 'サブシステムのドライブ数(cmd 07の答えから)', en: 'sub-system drive count (from the cmd 07 answer)' },
    0xef63: { name: 'sub_features', ja: 'サブ機能フラグ(cmd 0Bの答えのCPL&F0)', en: 'sub feature flags (CPL&F0 of the cmd 0B answer)' },
    0xef64: { name: 'drive_iface_tab', ja: 'ドライブ→インターフェース対応表(EF64-)', en: 'drive → interface table (EF64-)' },
    0xef7f: { name: 'dipsw_cpl', ja: 'DIP SW反転シャドウ(~30h | ~31h<<8)', en: 'inverted DIP shadow (~30h | ~31h<<8)' },
  }),
  pc80s31: Object.freeze({
    0x7f09: { name: 'motors_spun', ja: 'モーター安定済みフラグ(FFで02B4の1.7秒待ちをスキップ)', en: 'motors-spun flag (FF skips the 1.7s settle at 02B4)' },
    0x7f0c: { name: 'fdc_last_cmd', ja: '最後にFDCへ送ったコマンド', en: 'last command sent to the FDC' },
    0x7f14: { name: 'result_status', ja: 'cmd 06で返す結果ステータス(init直後=80h)', en: 'result status served by cmd 06 (80h right after init)' },
    0x7f15: { name: 'drive_map', ja: 'cmd 07で返すドライブマップ(RRAで詰めたプローブ結果)', en: 'drive map served by cmd 07 (probe carries packed via RRA)' },
    0x7f1c: { name: 'mode_flags', ja: 'cmd 17のドライブ別モードフラグ(7F1C-1F)', en: 'per-drive mode flags from cmd 17 (7F1C-1F)' },
    0x7f25: { name: 'remote_entry', ja: 'cmd 1Bリモート実行のエントリ(JP先が書かれる)', en: 'cmd 1B remote-exec entry (a JP lands here)' },
  }),
});

// look up the region an address falls in (null = unmapped/unknown)
export function regionAt(machine, addr) {
  const map = MAPS[machine];
  if (!map) return null;
  for (const r of map) if (addr >= r.start && addr <= r.end) return r;
  return null;
}

// regions that must never be relocated INTO or OUT of — the pin preset
// for the stone tools. Vectors, hooks, VRAM, work, shadows, stack: all
// position-sacred. Only 'user' (and holes) are fair game.
export function pinPresets(machine) {
  const map = MAPS[machine] ?? [];
  return map.filter((r) => r.kind !== 'user');
}

// Estimate unused memory: the user regions, minus anything a coverage
// map (Uint8Array flags per byte, 0 = untouched) says was touched.
// Without coverage this is just "where BASIC lets you live"; with it,
// the estimate turns empirical. Returns [{start, end, bytes}].
export function estimateUnused(machine, coverage = null) {
  const out = [];
  for (const r of (MAPS[machine] ?? [])) {
    if (r.kind !== 'user') continue;
    let runStart = -1;
    for (let a = r.start; a <= r.end + 1; a++) {
      const used = a <= r.end && coverage ? coverage[a] !== 0 : false;
      const inRange = a <= r.end;
      if (inRange && !used) {
        if (runStart < 0) runStart = a;
      } else if (runStart >= 0) {
        out.push({ start: runStart, end: a - 1, bytes: a - runStart });
        runStart = -1;
      }
    }
  }
  return out;
}
