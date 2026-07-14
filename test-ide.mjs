// IDE layer (issue: "本格開発ならIDE") — headless tests for the pure parts:
// INCLUDE resolution with provenance, project navigation, the editor
// highlighter, and the μPD3301 attribute designer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble } from './z80asm.js';
import {
  highlightAsm, normalizePath, makeResolver, findRefs,
  makeAttrGrid, paintAttr, packAttrRow, rowBudget, packedRowBytes,
  gridToDb, gridToVram, gridToTermCode, gridFromModel, verifyRow,
} from './demo/ide-tools.js';
import { textVramModel } from './demo/ice-tools.js';
import { Pc8001TextSystem } from './pc8001.js';

test('ide: INCLUDE splices files with file:line provenance', () => {
  const files = new Map([
    ['lib/util.z80', 'double: ADD A,A\n        RET\n'],
  ]);
  const r = assemble(`
        ORG 100h
        INCLUDE "lib/util.z80"
main:   LD A,3
        CALL double
        HALT
`, { org: 0x100, include: (p) => files.get(p) ?? null });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.symbols.DOUBLE, 0x100);
  // defs carry the origin of every symbol — the jump-to-definition backbone
  assert.deepEqual(r.defs.DOUBLE, { file: 'lib/util.z80', line: 1 });
  assert.deepEqual(r.defs.MAIN, { file: null, line: 4 });
  // listing rows remember their file too
  const inc = r.listing.find((l) => /ADD A,A/.test(l.source));
  assert.equal(inc.file, 'lib/util.z80');
});

test('ide: INCLUDE errors — missing resolver, missing file, circular chain', () => {
  const r1 = assemble('INCLUDE "x.z80"');
  assert.match(r1.errors[0].message, /needs a resolver/);
  const r2 = assemble('INCLUDE "x.z80"', { include: () => null });
  assert.match(r2.errors[0].message, /not found/);
  const files = new Map([
    ['a.z80', 'INCLUDE "b.z80"'],
    ['b.z80', 'INCLUDE "a.z80"'],
  ]);
  const r3 = assemble('INCLUDE "a.z80"', { include: (p) => files.get(p) ?? null });
  assert.equal(r3.errors.length, 1);
  assert.match(r3.errors[0].message, /circular INCLUDE: a\.z80 → b\.z80 → a\.z80/);
  assert.equal(r3.errors[0].file, 'b.z80');
});

test('ide: errors from included files carry the file name', () => {
  const files = new Map([['bad.inc', 'NOP\nBOGUS 1\n']]);
  const r = assemble('INCLUDE "bad.inc"\nNOP', { include: (p) => files.get(p) ?? null });
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].file, 'bad.inc');
  assert.equal(r.errors[0].line, 2);
});

test('ide: resolver handles includer-relative paths', () => {
  assert.equal(normalizePath('src/main.z80', 'util.inc'), 'src/util.inc');
  assert.equal(normalizePath('src/main.z80', '../lib/a.inc'), 'lib/a.inc');
  assert.equal(normalizePath('', 'lib/a.inc'), 'lib/a.inc');
  const files = new Map([
    ['src/main.z80', 'INCLUDE "util.inc"'],
    ['src/util.inc', 'U EQU 1'],
  ]);
  const { include } = makeResolver(files);
  const r = assemble(files.get('src/main.z80'), { include });
  // the top-level file isn't on the resolver stack, so "util.inc" resolves
  // from the root — push the entry manually the way the IDE build does
  void r;
  const res2 = makeResolver(files);
  res2.include('src/main.z80'); // enter the entry file
  const r2 = assemble(files.get('src/main.z80'), { include: res2.include });
  assert.equal(r2.errors.length, 0, JSON.stringify(r2.errors));
  assert.equal(r2.symbols.U, 1);
});

test('ide: findRefs is token-exact across files', () => {
  const files = new Map([
    ['a.z80', 'puts: RET\n CALL puts\n CALL putstr\n'],
    ['b.z80', ' JP puts ; tail\n'],
  ]);
  const refs = findRefs(files, 'puts');
  assert.deepEqual(refs.map((r) => [r.file, r.line]), [['a.z80', 1], ['a.z80', 2], ['b.z80', 1]]);
});

test('ide: highlighter classifies tokens and escapes HTML', () => {
  const h = highlightAsm('loop: LD A,(HL) ; x<y & "s"');
  assert.match(h, /hl-lab[^>]*>loop/);
  assert.match(h, /hl-mn[^>]*>LD/);
  assert.match(h, /hl-reg[^>]*>A/);
  assert.match(h, /hl-com/);
  assert.ok(h.includes('&lt;'), 'comment < escaped');
  assert.match(highlightAsm('N EQU 0FFh'), /hl-ps[^>]*>EQU/);
  assert.match(highlightAsm('DB 12h,34h'), /hl-num[^>]*>12h/);
  assert.match(highlightAsm(`DB "a<b"`), /hl-str[^>]*>"a&lt;b"/);
});

// ---- attribute designer -----------------------------------------------------------
test('ide/attr: a run of identical cells compresses to one pair (acceptance)', () => {
  const g = makeAttrGrid(80, 1);
  paintAttr(g, 10, 0, 39, 0, { color: 2 }); // one red run
  const pairs = packAttrRow(g, 0);
  // anchor pair at 0 (chip quirk: first pair backfills), the run, the return to default
  assert.deepEqual(pairs, [[0, 0xe8], [10, 0x48], [40, 0xe8]]);
  assert.ok(verifyRow(g, 0).ok, 'expandRowStates reproduces the painted state');
});

test('ide/attr: color and function are independent state machines', () => {
  const g = makeAttrGrid(80, 1);
  paintAttr(g, 0, 0, 79, 0, { color: 3 });
  paintAttr(g, 20, 0, 29, 0, { reverse: true });
  const pairs = packAttrRow(g, 0);
  // color once at 0; function on at 20, off at 30 — 3 pairs total
  assert.equal(pairs.length, 3);
  assert.ok(verifyRow(g, 0).ok);
  const both = paintAttr(makeAttrGrid(80, 1), 5, 0, 9, 0, { color: 6, blink: true });
  const p2 = packAttrRow(both, 0);
  // both specs change at column 5 → two pairs at the same position (chip-legal)
  assert.deepEqual(p2.filter(([pos]) => pos === 5).length, 2);
  assert.ok(verifyRow(both, 0).ok);
});

test('ide/attr: the 20-pair budget flags overflowing rows (acceptance)', () => {
  const g = makeAttrGrid(80, 1);
  for (let x = 0; x < 40; x += 2) paintAttr(g, x, 0, x, 0, { color: (x / 2) % 8 }); // zebra
  const b = rowBudget(g, 0);
  assert.ok(b.count > 20, `zebra needs ${b.count} pairs`);
  assert.ok(b.over, 'over-budget flagged');
  const calm = makeAttrGrid(80, 1);
  paintAttr(calm, 0, 0, 79, 0, { color: 7 });
  assert.ok(!rowBudget(calm, 0).over);
});

test('ide/attr: packed bytes pad with the (0,0) sentinel and stay in budget', () => {
  const g = makeAttrGrid(80, 1);
  paintAttr(g, 4, 0, 7, 0, { secret: true });
  const bytes = packedRowBytes(packAttrRow(g, 0), 40);
  assert.equal(bytes.length, 40);
  assert.equal(bytes[bytes.length - 1], 0, 'padded');
  assert.ok(verifyRow(g, 0).ok);
});

test('ide/attr: DB output reassembles; VRAM writes land on the attr area', () => {
  const g = makeAttrGrid(80, 2);
  paintAttr(g, 0, 0, 9, 0, { color: 4, semi: false });
  paintAttr(g, 0, 1, 79, 1, { upline: true });
  const src = gridToDb(g);
  const r = assemble(src);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.bytes.length, 2 * 40, 'attrBytes per row × rows');
  const writes = gridToVram(g);
  assert.equal(writes[0].addr, 0xf3c8 + 80); // row 0 attr area
  assert.equal(writes[1].addr, 0xf3c8 + 120 + 80); // row 1
  assert.equal(writes[0].bytes.length, 40);
  const code = gridToTermCode(g);
  assert.match(code, /sys\.line\(0\)\.attrs\(/);
});

test('ide/attr: importing the live screen round-trips through the designer', () => {
  const sys = new Pc8001TextSystem();
  sys.initTextMode();
  sys.line(3).text(0, 'HELLO').attrs(0, 0x48, 10, 0x04); // color 2, REV from col 10
  const model = textVramModel({ sys });
  const grid = gridFromModel(model);
  assert.equal(grid.cols, 80);
  assert.equal(grid.color[3 * 80 + 0], 0x48);
  assert.equal(grid.func[3 * 80 + 10], 0x04);
  // pack the imported state back and verify it reproduces itself
  assert.ok(verifyRow(grid, 3).ok);
  const pairs = packAttrRow(grid, 3);
  assert.deepEqual(pairs, [[0, 0x48], [10, 0x04]]);
});
