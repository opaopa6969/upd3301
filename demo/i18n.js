// i18n — the demo pages are authored in Japanese; when the UA prefers any
// other language, swap the chrome to English. Static text is replaced by
// exact-match dictionary lookup on text nodes (so markup stays untouched);
// long explainer paragraphs swap wholesale by element id. Dynamic strings
// go through t().

export const lang = (globalThis.navigator?.language ?? 'ja').toLowerCase().startsWith('ja') ? 'ja' : 'en';

const DICT = {
  // shared chrome
  '⛶ 全画面': '⛶ Fullscreen',
  'Webカメラ': 'Webcam',
  '表示:': 'Display:',
  '蛍光体:': 'Phosphor:',
  '管:': 'Tube:',
  '裏のノブ:': 'Rear knobs:',
  'ノブ:': 'Knobs:',
  'モード:': 'Mode:',
  '変換:': 'Convert:',
  'FONT改造:': 'Font mod:',
  'FONT.ROM(2KB):': 'FONT.ROM (2KB):',
  '物理OFF': 'Physics OFF',
  'アパーチャグリル': 'Aperture grille',
  'シャドウマスク': 'Shadow mask',
  'スロットマスク': 'Slot mask',
  'インターレース': 'Interlace',
  '15kHz 音鳴り': '15 kHz whine',
  '400ライン': '400-line',
  'アンバー': 'Amber',
  'プラズマ橙': 'Plasma orange',
  'プラズマ格子': 'Plasma grid',
  'ガラス反射': 'Glass reflection',
  '焼き付き (加速)': 'Burn-in (accelerated)',
  '焼き付き': 'Burn-in',
  // nav
  'CRT物理デモ': 'CRT physics demo',
  'ターミナルデモ': 'Terminal demo',
  'ターミナル': 'Terminal',
  '動画セミグラデモ': 'Semigraphic video',
  '動画セミグラ': 'Semigraphic video',
  'PC-8031ドラムマシン': 'PC-8031 drum machine',
  'ドラムマシン': 'Drum machine',
  'CRT動画プレイヤー': 'CRT video player',
  'PC-8001実機': 'PC-8001 (the machine)',
  'リセット': 'Reset',
  '機種:': 'Machine:',
  'またはROMを選ぶ:': 'or pick a ROM:',
  'CRT設定': 'CRT settings',
  '起動モード:': 'Boot mode:',
  'N-BASIC (N80)': 'N-BASIC (N80)',
  'N88-BASIC (WIP)': 'N88-BASIC (WIP)',
  'N88起動はFDDサブCPU待ちで停止する（issue #4）': 'N88 boot stalls waiting for the FDD sub-CPU (issue #4)',
  // index
  'テキスト (80桁)': 'Text (80 col)',
  'テキスト (40桁)': 'Text (40 col)',
  '27色 (DMA 2画面)': '27 colors (DMA ×2 screens)',
  'RGB 3プレーン (DMA 3画面)': 'RGB 3-plane (DMA ×3 screens)',
  '画面反転 (RVV)': 'Reverse video (RVV)',
  'カラー': 'Color',
  'OUT &H51 (事故)': 'OUT &H51 (accident)',
  '無改造': 'Stock',
  'D5-D4ショート': 'Short D5-D4',
  'D3-D2ショート': 'Short D3-D2',
  '隣接全ショート (ボールド)': 'Short all adjacent (bold)',
  'P22 (青が先に死ぬ)': 'P22 (blue dies first)',
  '長残光カラー (仮想)': 'Long color (hypothetical)',
  'P39 緑モノクロ': 'P39 green mono',
  'P7 レーダー管': 'P7 radar',
  // player
  '長残光': 'Long persistence',
  'P39緑': 'P39 green',
  'P7レーダー': 'P7 radar',
  'グリル': 'Grille',
  'シャドウ': 'Shadow',
  'スロット': 'Slot',
  // terminal
  'EX 100×30 (全桁アトリビュート)': 'EX 100×30 (per-cell attrs)',
  'ORIGINAL 80×25 (20ペア/行)': 'ORIGINAL 80×25 (20 pairs/row)',
  '虹テスト (ペア溢れ実験)': 'Rainbow test (pair overflow)',
  // video
  'EX 160×50 (セル毎8色)': 'EX 160×50 (8 colors/cell)',
  'UEX 320×100 (640×400ドット)': 'UEX 320×100 (640×400 dots)',
  '動的2値化 (自動レベル)': 'Dynamic binarization (auto levels)',
  'ディザ': 'Dither',
  '線画 (アニメ)': 'Line art (anime)',
  '98風 (512中16色)': "'98-style (16 of 512)",
  'フルカラーディザ': 'Full-color dither',
  '紋様:': 'Screen:',
  '分散 (Bayer)': 'Dispersed (Bayer)',
  '網点 (印刷)': 'Halftone (print)',
  'ライン': 'Line screen',
  '27色ちらつき': '27-color flicker',
  '512色ちらつき': '512-color flicker',
  'は短残光: 時間ディザがちらつく（長残光推奨）': ' is short-persistence: temporal dither will flicker (try a long-persistence tube)',
  '⏺ 録画': '⏺ REC',
  '■ 停止': '■ Stop',
  '録画中…': 'recording…',
  'MP4を保存した': 'saved MP4',
  'WebMを保存した（MP4化: ffmpeg -i in.webm out.mp4）': 'saved WebM (to MP4: ffmpeg -i in.webm out.mp4)',
  '録画非対応のブラウザ': 'this browser cannot record',
  // rhythm
  'デモパターン': 'Demo pattern',
  'クリア': 'Clear',
  'FDD SEEK (ガガガッ)': 'FDD SEEK (grind)',
  'HEAD LOAD (ゴトッ)': 'HEAD LOAD (thunk)',
  'MOTOR ON/OFF (カチッ)': 'MOTOR ON/OFF (click)',
  // h1
  'μPD3301 terminal — ANSIエスケープ → アトリビュートペア変換層':
    'μPD3301 terminal — ANSI escapes → attribute-pair compiler',
  '動画 → セミグラフィック（失われた技術で映像を観る）':
    'Video → semigraphics (watching film through a lost technique)',
  'PC-8031 DRUM MACHINE — ディスクユニットで刻め':
    'PC-8031 DRUM MACHINE — groove on the disk unit',
  'CRT VIDEO PLAYER — 手持ちの動画をブラウン管で観る':
    'CRT VIDEO PLAYER — your videos on a cathode-ray tube',
  // dynamic hints
  '重い: 物理OFFかFOCUS 0を試して': 'slow: try Physics OFF or FOCUS 0',
  '重い: 物理OFF/ORIGINALを試して': 'slow: try Physics OFF / ORIGINAL',
};

const NOTES_EN = {
  'note-main': `27-color mode = port 65h ← 8000h+5999 (two screens alternate; the Bemaga 1990-07 trick).
    3-plane mode = 8000h+8999 (three screens) showing R/G/B one frame each — logically full
    per-dot color at 1/3 duty per gun. On short-persistence P22 it is flicker hell; on the
    long-persistence tube the glow bridges the dark frames into a dim but steady full-color
    image. The physical layer (crt.js phosphor decay) is what makes that difference.`,
  'note-term': `Click the canvas and type (Enter/Backspace; commands: help / beer / 3301 / clear).
    Escape sequences (SGR colors, reverse, blink, underline, cursor addressing, erase) compile
    into per-row (position, value) attribute pairs in VRAM, hauled every frame by the μPD8257.
    ORIGINAL mode enforces the real 20-pairs-per-row limit — overflow the rainbow test and the
    tail colors drop. EX mode is the fantasy silicon rev (resetEx / setChannelEx) with arbitrary
    geometry and per-cell attributes. The sine wave is drawn through the semigraphic API (setDot).`,
  'note-video': `Luma lives on the semigraphic dot grid (2×4 per cell), chroma on the cell grid
    (one color per cell) — the attribute-clash aesthetic of the PC-8001 / ZX Spectrum / MSX1
    family. Dynamic binarization stretches levels to the 2%–98% luma percentiles every frame
    before the Bayer dither. Line-art mode detects region boundaries per channel (anime is flat
    fills — the borders are the lines). 27-color flicker quantizes each gun to three levels and
    alternates the middle one per frame — watch it through the long-persistence phosphor.
    UEX 320×100 needs fantasy RAM beyond 64KB and is heavy with the tube on; watch ms/frame.`,
  'note-rhythm': `Keys: Z = seek, X = head load, C = MOTOR relay, V = BEEP. Homage to the culture
    of drumming on the PC-8031's absurdly loud head seek, and to N-BASIC's MOTOR statement
    (the cassette relay clicks on port 30h bit d3). BEEP is port 40h d5. Every trigger logs the
    OUT instruction that would make the same sound on real hardware. All sounds are WebAudio
    synthesis — physics imitation, not samples.`,
  'note-player': `No μPD3301 involved — just crt.js (phosphor: per-gun two-component decay,
    emission color, burn-in) and tube.js (mask, beam spot, convergence error, glass) applied to
    any video via analog drive (stepAnalog: sRGB linearized into excitation). Try P7 radar.
    POWER runs the deflection collapse too.`,
};

export const t = (s) => (lang === 'ja' ? s : (DICT[s] ?? s));

export function applyI18n() {
  if (lang === 'ja') return;
  for (const el of document.querySelectorAll('button, span, label, h1, a, td')) {
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        const k = node.textContent.trim();
        if (k && DICT[k]) node.textContent = node.textContent.replace(k, DICT[k]);
      }
    }
  }
  for (const [id, text] of Object.entries(NOTES_EN)) {
    const el = document.getElementById(id);
    if (el) el.textContent = text.replace(/\s+/g, ' ').trim();
  }
}
