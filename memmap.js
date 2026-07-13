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
