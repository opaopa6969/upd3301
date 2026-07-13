// tests: crt-xterm addon core (headless, fake xterm buffer) + build.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  rgbToGrb, PALETTE_TO_GRB, ANSI_TO_GRB,
  buildGlyphs, glyphIndexFor, TOFU_INDEX,
  cellToGrb, drawTerminalToIndexed, invertCellBlock,
  CrtRendererAddon,
} from './xterm/crt-xterm.js';
import { transformModule, bundleModules, buildHtml, OUT } from './xterm/build.mjs';
import { CrtPhosphor, PHOSPHORS } from './crt.js';
import { CrtTube } from './tube.js';
import { G } from './demo/font.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---- fakes: just enough IBufferCell / IBufferLine / view ---------------------

function makeCell({
  ch = ' ', fg = null, bg = null, fgRgb = null, bgRgb = null,
  inverse = false, bold = false, underline = false, blink = false,
} = {}) {
  return {
    getChars: () => ch,
    getWidth: () => 1,
    isFgRGB: () => fgRgb !== null,
    isBgRGB: () => bgRgb !== null,
    isFgPalette: () => fg !== null,
    isBgPalette: () => bg !== null,
    isFgDefault: () => fg === null && fgRgb === null,
    isBgDefault: () => bg === null && bgRgb === null,
    getFgColor: () => (fgRgb !== null ? fgRgb : fg),
    getBgColor: () => (bgRgb !== null ? bgRgb : bg),
    isInverse: () => inverse,
    isBold: () => bold,
    isUnderline: () => underline,
    isBlink: () => blink,
  };
}

function makeView(rows /* array of arrays of cells or null */, { cursorX = -1, cursorY = -1 } = {}) {
  const cols = Math.max(...rows.map((r) => (r ? r.length : 0)));
  return {
    cols, rows: rows.length,
    getLine: (y) => (rows[y] ? { getCell: (x) => rows[y][x] } : null),
    cursorX, cursorY,
  };
}

const draw = (view, opts) => {
  const out = new Uint8Array(view.cols * 8 * view.rows * 8);
  drawTerminalToIndexed(view, glyphs, out, { cursorOn: false, ...opts });
  return out;
};
const glyphs = buildGlyphs();

// ---- color quantization ------------------------------------------------------

test('rgbToGrb: primaries and white/black land on their GRB corners', () => {
  assert.equal(rgbToGrb(0, 0, 0), 0);
  assert.equal(rgbToGrb(255, 0, 0), 2);   // R = bit1
  assert.equal(rgbToGrb(0, 255, 0), 4);   // G = bit2
  assert.equal(rgbToGrb(0, 0, 255), 1);   // B = bit0
  assert.equal(rgbToGrb(255, 255, 0), 6); // yellow = G|R
  assert.equal(rgbToGrb(0, 255, 255), 5); // cyan = G|B
  assert.equal(rgbToGrb(255, 0, 255), 3); // magenta = R|B
  assert.equal(rgbToGrb(255, 255, 255), 7);
});

test('rgbToGrb: dark colors are rescued relative to their brightest gun', () => {
  assert.equal(rgbToGrb(0, 0, 128), 1, 'navy shows as blue, not black');
  assert.equal(rgbToGrb(128, 0, 0), 2, 'maroon shows as red');
  assert.equal(rgbToGrb(170, 85, 0), 6, 'brown shows as yellow (g >= max/2)');
  assert.equal(rgbToGrb(30, 30, 30), 0, 'near-black stays black');
  assert.equal(rgbToGrb(128, 128, 128), 7, 'mid gray goes white');
});

test('PALETTE_TO_GRB: ANSI 16, the 6x6x6 cube and the gray ramp', () => {
  assert.deepEqual([...PALETTE_TO_GRB.slice(0, 8)], ANSI_TO_GRB);
  assert.deepEqual([...PALETTE_TO_GRB.slice(8, 16)], ANSI_TO_GRB, 'bright = same GRB');
  assert.equal(PALETTE_TO_GRB[196], 2, 'cube 196 = (255,0,0)');
  assert.equal(PALETTE_TO_GRB[21], 1, 'cube 21 = (0,0,255)');
  assert.equal(PALETTE_TO_GRB[46], 4, 'cube 46 = (0,255,0)');
  assert.equal(PALETTE_TO_GRB[232], 0, 'darkest gray (8,8,8) is black');
  assert.equal(PALETTE_TO_GRB[255], 7, 'lightest gray is white');
});

test('cellToGrb: palette, RGB and default paths', () => {
  assert.deepEqual(cellToGrb(makeCell({ fg: 1, bg: 4 })), { fg: 2, bg: 1 }); // red on blue
  assert.deepEqual(cellToGrb(makeCell({ fgRgb: 0xff8800 })), { fg: 6, bg: 0 }); // orange → yellow
  assert.deepEqual(cellToGrb(makeCell({})), { fg: 7, bg: 0 });
});

// ---- glyphs ------------------------------------------------------------------

test('buildGlyphs: demo font glyphs land in the right slot with the right bits', () => {
  const rowsA = G.A.trim().split(/\s+/);
  const idx = glyphIndexFor('A'.codePointAt(0));
  assert.equal(idx, 0x41 - 0x20);
  for (let r = 0; r < 7; r++) {
    assert.equal(glyphs[idx * 8 + r], parseInt(rowsA[r], 2) << 3);
  }
  assert.equal(glyphs[idx * 8 + 7], 0, 'row 7 is the blank gap/underline row');
});

test('buildGlyphs: full printable ASCII coverage, lowercase included', () => {
  for (let c = 0x21; c < 0x7f; c++) {
    const idx = glyphIndexFor(c);
    assert.notEqual(idx, TOFU_INDEX, `printable 0x${c.toString(16)} must have a glyph`);
    let lit = 0;
    for (let r = 0; r < 8; r++) lit |= glyphs[idx * 8 + r];
    assert.notEqual(lit, 0, `glyph for '${String.fromCharCode(c)}' must have pixels`);
  }
});

test('glyphIndexFor: space, printable ASCII, and tofu for the rest', () => {
  assert.equal(glyphIndexFor(0x20), 0);
  assert.equal(glyphIndexFor(0), 0, 'null cell renders as space');
  assert.equal(glyphIndexFor('あ'.codePointAt(0)), TOFU_INDEX);
  assert.equal(glyphIndexFor(0x2588), TOFU_INDEX, 'box drawing is out of scope');
  const tofu = glyphs.slice(TOFU_INDEX * 8, TOFU_INDEX * 8 + 7);
  assert.ok(tofu.every((b) => b !== 0), 'tofu is visible on every row');
});

// ---- raster core ---------------------------------------------------------------

test('draw: a white A on black puts fg where the glyph bits are', () => {
  const view = makeView([[makeCell({ ch: 'A' })]]);
  const out = draw(view);
  // G.A row 0 = 01110 → columns 1..3 lit
  assert.deepEqual([...out.slice(0, 8)], [0, 7, 7, 7, 0, 0, 0, 0]);
  assert.equal(out[7 * 8], 0, 'bottom row stays background');
});

test('draw: palette colors quantize (ANSI red fg, blue bg)', () => {
  const view = makeView([[makeCell({ ch: 'A', fg: 1, bg: 4 })]]);
  const out = draw(view);
  assert.equal(out[1], 2, 'glyph pixel is GRB red');
  assert.equal(out[0], 1, 'background pixel is GRB blue');
});

test('draw: inverse swaps fg/bg', () => {
  const out = draw(makeView([[makeCell({ ch: 'A', fg: 1, bg: 4, inverse: true })]]));
  assert.equal(out[1], 1, 'glyph pixel now bg color');
  assert.equal(out[0], 2, 'background now fg color');
});

test('draw: strict1979 drops backgrounds but keeps reverse video readable', () => {
  const bgOnly = draw(makeView([[makeCell({ ch: 'A', fg: 1, bg: 4 })]]), { strict1979: true });
  assert.equal(bgOnly[0], 0, 'per-cell background is gone — 1979 has none');
  assert.equal(bgOnly[1], 2, 'foreground color survives');
  const rev = draw(makeView([[makeCell({ ch: 'A', fg: 1, inverse: true })]]), { strict1979: true });
  assert.equal(rev[0], 2, 'reverse = colored block');
  assert.equal(rev[1], 0, 'glyph punched out dark');
});

test('draw: blink attribute hides the glyph on the off phase only', () => {
  const cell = () => makeCell({ ch: 'A', blink: true });
  const on = draw(makeView([[cell()]]), { blinkOn: true });
  const off = draw(makeView([[cell()]]), { blinkOn: false });
  assert.equal(on[1], 7);
  assert.equal(off[1], 0, 'hidden: fg painted as bg');
});

test('draw: bold re-strikes the glyph one pixel right', () => {
  const plain = draw(makeView([[makeCell({ ch: 'l' })]]));
  const bold = draw(makeView([[makeCell({ ch: 'l', bold: true })]]));
  const count = (a) => a.reduce((s, v) => s + (v ? 1 : 0), 0);
  assert.ok(count(bold) > count(plain), 'bold lights more pixels');
});

test('draw: underline fills the whole bottom row', () => {
  const out = draw(makeView([[makeCell({ ch: 'A', underline: true })]]));
  assert.deepEqual([...out.slice(7 * 8, 8 * 8)], [7, 7, 7, 7, 7, 7, 7, 7]);
});

test('draw: cursor inverts its cell block', () => {
  const view = makeView([[makeCell({ ch: ' ' })]], { cursorX: 0, cursorY: 0 });
  const out = new Uint8Array(64);
  drawTerminalToIndexed(view, glyphs, out, { cursorOn: true });
  assert.ok([...out].every((v) => v === 7), 'empty cell + cursor = solid white block');
});

test('draw: missing lines render as background, cursor outside view is skipped', () => {
  const view = { cols: 2, rows: 2, getLine: () => null, cursorX: 0, cursorY: 5 };
  const out = new Uint8Array(2 * 8 * 2 * 8).fill(9);
  drawTerminalToIndexed(view, glyphs, out, { cursorOn: true });
  assert.ok([...out].every((v) => v === 0));
});

test('draw: deterministic — same view, same bytes', () => {
  const mk = () => makeView([
    [makeCell({ ch: 'H', fg: 2 }), makeCell({ ch: 'i', bg: 4 })],
    [makeCell({ ch: '~', inverse: true }), makeCell({ ch: 'あ' })],
  ], { cursorX: 1, cursorY: 1 });
  const a = new Uint8Array(2 * 8 * 2 * 8);
  const b = new Uint8Array(2 * 8 * 2 * 8);
  drawTerminalToIndexed(mk(), glyphs, a, { cursorOn: true });
  drawTerminalToIndexed(mk(), glyphs, b, { cursorOn: true });
  assert.deepEqual(a, b);
});

test('invertCellBlock: XOR 7 twice is identity', () => {
  const out = new Uint8Array(8 * 8 * 4);
  out.fill(5);
  invertCellBlock(out, 32, 1, 0, 2);
  assert.equal(out[8], 2);
  assert.equal(out[0], 5, 'outside the block untouched');
  invertCellBlock(out, 32, 1, 0, 2);
  assert.ok([...out].every((v) => v === 5));
});

// ---- full headless pipeline: cells → phosphor → tube → RGBA --------------------

test('pipeline: indexed frame lights the phosphor and reaches the glass', () => {
  const run = () => {
    const view = makeView([[makeCell({ ch: 'A', fg: 2 })]]);
    const idx = new Uint8Array(64);
    drawTerminalToIndexed(view, glyphs, idx, { cursorOn: false });
    const ph = new CrtPhosphor({ width: 8, height: 8, phosphor: PHOSPHORS.P39 });
    ph.step(idx, 1 / 60);
    const tube = new CrtTube({ srcWidth: 8, srcHeight: 8, outWidth: 16, outHeight: 32 });
    return tube.apply(ph.composite(), null, { scale: 1.2 });
  };
  const a = run();
  assert.ok(a.some((v, i) => i % 4 !== 3 && v > 0), 'some light made it to the output');
  assert.deepEqual(run(), a, 'whole pipeline is deterministic');
});

test('addon: constructs headless; activate demands a browser', () => {
  const addon = new CrtRendererAddon({ phosphor: 'AMBER', strict1979: true });
  assert.equal(addon.options.phosphor, 'AMBER');
  assert.equal(addon.options.mask, 'aperture', 'defaults merge under overrides');
  assert.throws(() => addon.activate({}), /requestAnimationFrame/);
  addon.setOptions({ bright: 2 });
  assert.equal(addon.options.bright, 2);
});

// ---- build.mjs -----------------------------------------------------------------

test('transformModule: imports become registry lookups, exports are collected', () => {
  const src = "import { a, b as c } from './dep.js';\n"
    + 'export const X = a + c;\nexport function f() { return X; }\n'
    + 'const hidden = 1;\nexport { hidden };\n';
  const m = transformModule(src, 'sub/mod.js');
  assert.deepEqual(m.deps, ['sub/dep.js']);
  assert.deepEqual(m.exports.sort(), ['X', 'f', 'hidden']);
  assert.match(m.code, /const \{ a, b: c \} = __req\("sub\/dep\.js"\)/);
  assert.doesNotMatch(m.code, /^\s*(import|export)\s/m);
});

test('transformModule: refuses syntax it cannot prove it handled', () => {
  assert.throws(() => transformModule('export default 42;\n', 'x.js'), /unhandled/);
});

test('bundleModules: each module defined once, entry resolvable, no module syntax', () => {
  const bundle = bundleModules();
  assert.equal(bundle.match(/__def\("crt\.js"/g).length, 1,
    'crt.js appears once though both tube.js and crt-xterm.js import it');
  for (const id of ['tube.js', 'demo/font.js', 'xterm/crt-xterm.js']) {
    assert.ok(bundle.includes(`__def("${id}"`), `${id} bundled`);
  }
  assert.doesNotMatch(bundle, /^\s*import\s/m);
  // the bundle actually runs headless and yields the addon
  const req = new Function(`${bundle}; return __req;`)();
  const mod = req('xterm/crt-xterm.js');
  assert.equal(typeof mod.CrtRendererAddon, 'function');
  assert.ok(mod.PHOSPHORS.P39, 're-exported phosphor table is live');
});

test('build.mjs CLI writes a closed, self-contained dist page', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'xterm/build.mjs')], { cwd: ROOT });
  const html = readFileSync(path.join(ROOT, OUT), 'utf8');
  const opens = (html.match(/<script[\s>]/g) || []).length;
  const closes = (html.match(/<\/script>/g) || []).length;
  assert.equal(opens, closes, 'script tags balance');
  assert.ok(html.trimEnd().endsWith('</html>'), 'document closes');
  assert.ok(!html.includes('BUILD:BUNDLE-START'), 'markers replaced');
  assert.ok(!html.includes("from './crt-xterm.js'"), 'no unresolved local imports');
  assert.ok(html.includes('window.CrtRendererAddon'), 'addon exposed to the page script');
  assert.ok(html.includes("['tty']"), 'ttyd subprotocol present');
  // the inlined bundle must evaluate: extract it and run with a window stub
  const m = html.match(/<script type="module">\n(\/\/ bundled by[\s\S]*?)<\/script>/);
  assert.ok(m, 'inlined bundle script found');
  const win = {};
  new Function('window', m[1])(win);
  assert.equal(typeof win.CrtRendererAddon, 'function');
  assert.ok(win.CrtPHOSPHORS.AMBER && Array.isArray(win.CrtMASKS));
});
