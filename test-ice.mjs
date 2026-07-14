// ICE round 2 (issue #6) — controller-level acceptance tests, headless.
// The debugger clamps onto machine-shaped objects from the outside, so
// everything here runs on the real Z80 core plus a minimal machine shell
// (and, where a real ROM is present, on a booted N-BASIC machine).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Z80 } from './z80.js';
import { assemble } from './z80asm.js';
import { IceController } from './demo/ice.js';
import {
  parsePattern, searchBytes, ChangeSearch, textVramModel, attrShort,
  thinTimeline, timelineView,
} from './demo/ice-tools.js';
import { Pc8001TextSystem } from './pc8001.js';
import { Pc8001Machine } from './machine.js';
import { regionAt } from './memmap.js';

// a machine-shaped shell around the real CPU core (same face as Pc8001Machine)
function fakeMachine(src, org = 0x100) {
  const r = assemble(src, { org });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  const memory = new Uint8Array(0x10000);
  memory.set(r.bytes, r.org);
  const outLog = [];
  const cpu = new Z80({
    read: (a) => memory[a & 0xffff],
    write: (a, v) => { memory[a & 0xffff] = v & 0xff; },
    in: () => 0xff,
    out: (p, v) => outLog.push([p & 0xff, v & 0xff]),
  });
  cpu.pc = r.org;
  return {
    sys: { memory }, cpu, frame: 0, outLog, symbols: r.symbols,
    stepFrame() {
      for (let i = 0; i < 2000 && !cpu.halted; i++) cpu.step();
      this.frame++;
      return this;
    },
  };
}

function attach(m) {
  const ctrl = new IceController();
  ctrl.attach(m);
  return ctrl;
}

test('ice: watchpoint pins the known writer (addr, value, pc of the culprit)', () => {
  const m = fakeMachine(`
        ORG 100h
        LD A,0AAh
victim: LD (0C000h),A     ; ← the byte-smasher we want to catch
        HALT
`);
  const ctrl = attach(m);
  const r = ctrl.setWatch('main', { lo: 0xc000, w: true });
  assert.ok(r.ok);
  m.stepFrame();
  assert.ok(ctrl.paused, 'watchpoint paused the machine');
  assert.equal(ctrl.hit.type, 'watch');
  assert.equal(ctrl.hit.rw, 'w');
  assert.equal(ctrl.hit.addr, 0xc000);
  assert.equal(ctrl.hit.value, 0xaa);
  assert.equal(ctrl.hit.pc, m.symbols.VICTIM, 'pc points at the writing instruction');
  ctrl.detach();
});

test('ice: read watchpoints, ranges, and value conditions', () => {
  const m = fakeMachine(`
        ORG 100h
        LD A,11h
        LD (0D005h),A      ; in range but value≠55h — condition must skip it
w2:     LD A,55h
        LD (0D008h),A      ; this one fires
        LD HL,0D005h
rd:     LD A,(HL)          ; read watch
        HALT
`);
  const ctrl = attach(m);
  ctrl.setWatch('main', { lo: 0xd000, hi: 0xd00f, w: true, cond: 'value == 0x55' });
  m.stepFrame();
  assert.equal(ctrl.hit.value, 0x55);
  assert.equal(ctrl.hit.addr, 0xd008);
  assert.equal(ctrl.hit.pc, (m.symbols.W2 + 2) & 0xffff);
  // now a read watch — resume past the write hit first
  ctrl.cpu('main').watches.length = 0;
  ctrl.setWatch('main', { lo: 0xd005, r: true, w: false });
  ctrl.resume();
  m.stepFrame();
  assert.equal(ctrl.hit.rw, 'r');
  assert.equal(ctrl.hit.addr, 0xd005);
  assert.equal(ctrl.hit.pc, m.symbols.RD);
  // broken condition disables itself instead of wedging
  ctrl.cpu('main').watches.length = 0;
  ctrl.setWatch('main', { lo: 0, hi: 0xffff, r: true, w: true, cond: 'no.such.thing' });
  ctrl.resume();
  m.stepFrame();
  assert.ok(!ctrl.paused, 'machine kept running');
  assert.equal(ctrl.cpu('main').watches[0].enabled, false);
  assert.ok(ctrl.cpu('main').watches[0].error, 'error recorded');
  ctrl.detach();
});

test('ice: OUT 51h break reads the CRTC parameter stream (acceptance)', () => {
  const m = fakeMachine(`
        ORG 100h
        LD A,28h
        OUT (51h),A
        LD A,4Fh
        OUT (51h),A
        LD A,05h
        OUT (51h),A
        HALT
`);
  const ctrl = attach(m);
  const r = ctrl.setIoBreak('main', { lo: 0x51, dirOut: true });
  assert.ok(r.ok);
  const params = [];
  for (let i = 0; i < 3; i++) {
    m.stepFrame();
    assert.ok(ctrl.paused, `break #${i}`);
    assert.equal(ctrl.hit.type, 'io');
    assert.equal(ctrl.hit.rw, 'out');
    assert.equal(ctrl.hit.addr, 0x51);
    params.push(ctrl.hit.value);
    ctrl.resume();
  }
  assert.deepEqual(params, [0x28, 0x4f, 0x05], 'the parameter stream, byte by byte');
  m.stepFrame();
  assert.ok(m.cpu.halted, 'ran to completion after the last break');
  ctrl.detach();
});

test('ice: IN break and port ranges', () => {
  const m = fakeMachine(`
        ORG 100h
        IN A,(30h)
        IN A,(40h)
        HALT
`);
  const ctrl = attach(m);
  ctrl.setIoBreak('main', { lo: 0x40, hi: 0x4f, dirIn: true, dirOut: false });
  m.stepFrame();
  assert.equal(ctrl.hit.rw, 'in');
  assert.equal(ctrl.hit.addr, 0x40, 'port 30h passed through, 40h fired');
  ctrl.detach();
});

test('ice: backtrace shows the nest, step-out unwinds 3 levels (acceptance)', () => {
  const m = fakeMachine(`
        ORG 200h
main:   CALL f1
after:  LD (9000h),A
        HALT
f1:     CALL f2
r1:     RET
f2:     CALL f3
r2:     RET
f3:     LD A,7
inner:  RET
`);
  const ctrl = attach(m);
  ctrl.setBreak('main', m.symbols.INNER); // deepest point of the nest
  m.stepFrame();
  assert.ok(ctrl.paused && ctrl.hit.pc === m.symbols.INNER);
  const bt = ctrl.backtrace('main');
  assert.deepEqual(bt.map((f) => f.entry), [m.symbols.F3, m.symbols.F2, m.symbols.F1], 'innermost first');
  assert.deepEqual(bt.map((f) => f.retTo), [m.symbols.R2, m.symbols.R1, m.symbols.AFTER]);
  // three step-outs climb back up, one frame at a time
  assert.ok(ctrl.stepOut('main').done);
  assert.equal(m.cpu.pc, m.symbols.R2);
  assert.ok(ctrl.stepOut('main').done);
  assert.equal(m.cpu.pc, m.symbols.R1);
  assert.ok(ctrl.stepOut('main').done);
  assert.equal(m.cpu.pc, m.symbols.AFTER);
  ctrl.detach();
});

test('ice: step-out falls back to the SP heuristic with an empty shadow stack', () => {
  const m = fakeMachine(`
        ORG 300h
        LD SP,0F000h
        CALL sub
back:   HALT
sub:    LD B,2
.l:     DJNZ .l
        RET
`);
  const ctrl = attach(m);
  // step manually INTO the call so no shadow frame is recorded… actually the
  // wrapped step sees the CALL; empty-stack case = attach after the call:
  for (let i = 0; i < 2; i++) ctrl.stepInto('main'); // LD SP + CALL recorded
  ctrl.detach();
  const ctrl2 = attach(m); // fresh attach: shadow stack empty, inside sub
  ctrl2.pause();
  const r = ctrl2.stepOut('main');
  assert.ok(r.done);
  assert.equal(m.cpu.pc, m.symbols.BACK, 'SP heuristic found the return');
  ctrl2.detach();
});

test('ice: instruction trace ring records the road to a breakpoint', () => {
  const m = fakeMachine(`
        ORG 100h
a1:     LD A,1
a2:     LD B,2
a3:     LD C,3
stop:   HALT
`);
  const ctrl = attach(m);
  ctrl.setBreak('main', m.symbols.STOP);
  m.stepFrame();
  assert.ok(ctrl.paused);
  const rows = ctrl.traceView('main', 8);
  const pcs = rows.map((r) => r.pc);
  // the bp'd instruction did NOT execute, so the trace ends just before it
  assert.deepEqual(pcs.slice(-3), [m.symbols.A1, m.symbols.A2, m.symbols.A3]);
  // pre-execution: at A2 (LD B,2), B is still 0; at A3 it reads 2
  assert.equal(rows[rows.length - 2].bc >> 8, 0, 'regs are pre-execution state');
  assert.equal(rows[rows.length - 1].bc >> 8, 2);
  assert.equal(rows.length && rows[rows.length - 1].frame, m.frame, 'frame recorded for time travel');
  ctrl.traceClear('main');
  assert.equal(ctrl.traceView('main', 8).length, 0);
  ctrl.detach();
});

test('ice-tools: pattern parsing and byte/ASCII search', () => {
  assert.deepEqual(parsePattern('41 42 43'), [0x41, 0x42, 0x43]);
  assert.deepEqual(parsePattern('C000'), [0xc0, 0x00]);
  assert.deepEqual(parsePattern('"AB"'), [0x41, 0x42]);
  assert.equal(parsePattern('xyz'), null);
  assert.equal(parsePattern(''), null);
  const mem = new Uint8Array(0x10000);
  mem.set([0x41, 0x42, 0x43], 0x8000);
  mem.set([0x41, 0x42, 0x43], 0x9000);
  const read = (a) => mem[a & 0xffff];
  assert.deepEqual(searchBytes(read, parsePattern('"ABC"')), [0x8000, 0x9000]);
  assert.deepEqual(searchBytes(read, [0x42, 0x43], { start: 0x8800 }), [0x9001]);
});

test('ice-tools: change search corners a moving byte', () => {
  const mem = new Uint8Array(0x10000).fill(0x00);
  mem[0x8123] = 5; // the "cursor"
  mem[0x4444] = 9; // a decoy that also changes, differently
  const read = (a) => mem[a & 0xffff];
  const cs = new ChangeSearch();
  cs.init(read);
  mem[0x8123]++; // 6
  mem[0x4444]--; // 8
  assert.equal(cs.filter(read, 'gt'), 1, 'one byte increased');
  assert.deepEqual(cs.list(read, 4), [{ addr: 0x8123, value: 6, prev: 6 }]);
  mem[0x8123]++; // 7
  assert.equal(cs.filter(read, 'gt'), 1);
  assert.equal(cs.filter(read, 'eq'), 1, 'stable since last photo');
  assert.equal(cs.filter(read, 'val', 7), 1);
  mem[0x8123] = 0;
  assert.equal(cs.filter(read, 'gt'), 0, 'candidates can die');
});

test('ice-tools: text VRAM / attribute viewer model (μPD3301 truth)', () => {
  const sys = new Pc8001TextSystem();
  sys.initTextMode(); // 80x25, VRAM at F3C8, DMA ch2 autoload — the N-BASIC boot shape
  sys.line(0).text(0, 'HELLO').attrs(0, 0x48, 10, 0x04); // color 2 from col 0, REVERSE from col 10
  const model = textVramModel({ sys });
  assert.ok(model, 'model built from live CRTC/DMAC programming');
  assert.equal(model.base, 0xf3c8);
  assert.equal(model.cols, 80);
  assert.equal(model.rows, 25);
  assert.equal(model.stride, 120);
  assert.equal(model.count, 25 * 120);
  assert.ok(model.enabled, 'DMA ch2 enabled');
  const row = model.rowsData[0];
  assert.ok(row.text.startsWith('HELLO'));
  assert.equal(row.addr, 0xf3c8);
  assert.deepEqual(row.pairs.map((p) => [p.pos, p.val]), [[0, 0x48], [10, 0x04]]);
  assert.equal(row.pairs[0].text, 'COL2');
  assert.equal(row.pairs[1].text, 'REV');
  // effect ranges: attribute state switches exactly at column 10
  assert.equal(row.spans[0].from, 0);
  assert.equal(row.spans[0].to, 9);
  assert.equal(row.spans[1].from, 10);
  assert.equal(attrShort(0xe8), 'COL7');
  assert.equal(attrShort(0x04), 'REV');
});

test('ice: memmap region names resolve for both machines', () => {
  assert.match(regionAt('pc8001', 0xf3c8).name, /text VRAM/);
  assert.match(regionAt('pc8801', 0xef14).name, /disk BASIC work/);
  assert.equal(regionAt('pc8801', 0xef14).confidence, 'verified');
});

// ---- the flagship acceptance: find N-BASIC's cursor work byte with three
// change-search refinements on a real booted machine (skips without a ROM)
test('ice: change search finds the N-BASIC cursor work in 3 refinements', async (t) => {
  let rom;
  try { rom = new Uint8Array(await readFile('roms/N80_2.ROM')); }
  catch { t.skip('no ROM (BYO)'); return; }
  const m = new Pc8001Machine({ rom });
  const ctrl = new IceController();
  ctrl.attach(m);
  const c = ctrl.cpu('main');
  c.traceOn = false; // keep the boot quick — the search only needs memory
  c.stackOn = false;
  for (let i = 0; i < 150; i++) m.stepFrame(); // boot to the BASIC prompt
  const read = c.read;

  // type one letter, run a few frames for the ROM's key scan + echo
  const typeA = () => {
    m.keyDown(2, 1); // 'A' in the matrix
    for (let i = 0; i < 4; i++) m.stepFrame();
    m.keyUp(2, 1);
    for (let i = 0; i < 4; i++) m.stepFrame();
  };

  const cs = new ChangeSearch();
  cs.init(read);
  let count = 0x10000;
  for (let i = 0; i < 3; i++) { // three refinements: cursor column strictly grows
    typeA();
    count = cs.filter(read, 'gt');
    assert.ok(count > 0, `refinement ${i + 1} kept ${count}`);
  }
  assert.ok(count <= 32, `three refinements cornered it to ${count} candidate(s)`);
  // prove one candidate really tracks the cursor: type once more → +1 exactly
  const cands = cs.list(read, 32);
  const before = cands.map((x) => ({ addr: x.addr, v: read(x.addr) }));
  typeA();
  const tracking = before.filter((x) => read(x.addr) === (x.v + 1) & 0xff || read(x.addr) === x.v + 1);
  assert.ok(tracking.length >= 1, 'at least one survivor increments with the cursor');
  ctrl.detach();
});

// ---- time-travel snapshot thinning (author feedback: "the tree explodes") -------
function mkTl() {
  const nodes = new Map();
  let next = 1;
  const add = (parent, frame, pinned = false) => {
    const id = next++;
    nodes.set(id, { id, parent, frame, children: [], pinned });
    const p = nodes.get(parent);
    if (p) p.children.push(id);
    return id;
  };
  return { nodes, add };
}
function chainFrom(t, from, count, startFrame, step = 30) {
  let p = from;
  for (let i = 0; i < count; i++) p = t.add(p, startFrame + i * step);
  return p;
}
function checkConsistent(nodes, rootId) {
  // every parent link resolves and the whole tree hangs off the root
  const seen = new Set();
  const walk = (id) => {
    const n = nodes.get(id);
    assert.ok(n, `node ${id} exists`);
    seen.add(id);
    for (const c of n.children) {
      assert.equal(nodes.get(c)?.parent, id, `child ${c} points back at ${id}`);
      walk(c);
    }
  };
  walk(rootId);
  assert.equal(seen.size, nodes.size, 'no orphans after thinning');
}

test('ice-tools: thinning never eats root / branch points / tips / pins / recent M', () => {
  const t = mkTl();
  const root = t.add(0, 0);
  const mid = chainFrom(t, root, 20, 30); // long boring run
  const branch = t.add(mid, 700); // this node will fork
  const tipA = chainFrom(t, branch, 10, 730);
  const pinned = t.add(branch, 1000, true); // manual snap on branch B
  const tipB = chainFrom(t, pinned, 15, 1030);
  const current = tipB;
  const before = t.nodes.size;
  const recent = [...t.nodes.keys()].slice(-8);
  const { removed } = thinTimeline(t.nodes, root, { current, keepRecent: 8, cap: 80, baseSpacing: 30 });
  assert.ok(removed.length > 0, 'something was thinned');
  assert.ok(t.nodes.size < before);
  for (const id of [root, branch, tipA, tipB, pinned, current]) {
    assert.ok(t.nodes.has(id), `protected node ${id} survives`);
  }
  for (const id of recent) assert.ok(t.nodes.has(id), `recent node ${id} untouched`);
  assert.ok(t.nodes.get(branch).children.length >= 2, 'still a branch point');
  checkConsistent(t.nodes, root);
});

test('ice-tools: deep past thins exponentially, recent past stays dense', () => {
  const t = mkTl();
  const root = t.add(0, 0);
  const tip = chainFrom(t, root, 120, 30);
  thinTimeline(t.nodes, root, { current: tip, keepRecent: 8, cap: 999, baseSpacing: 30 });
  // average frame gap in the oldest surviving third ≫ the newest third
  const frames = [...t.nodes.values()].map((n) => n.frame).sort((a, b) => a - b);
  const gaps = frames.slice(1).map((f, i) => f - frames[i]);
  const third = Math.floor(gaps.length / 3);
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(avg(gaps.slice(0, third)) > avg(gaps.slice(-third)) * 1.5,
    `old ${avg(gaps.slice(0, third)).toFixed(0)} vs new ${avg(gaps.slice(-third)).toFixed(0)}`);
  // the newest 8 survived wall-to-wall (gap = base spacing)
  assert.deepEqual(gaps.slice(-7), [30, 30, 30, 30, 30, 30, 30]);
  checkConsistent(t.nodes, root);
});

test('ice-tools: the cap holds even after exponential thinning', () => {
  const t = mkTl();
  const root = t.add(0, 0);
  let p = root;
  for (let i = 0; i < 300; i++) p = t.add(p, (i + 1) * 30);
  thinTimeline(t.nodes, root, { current: p, keepRecent: 8, cap: 80, baseSpacing: 30 });
  assert.ok(t.nodes.size <= 80, `size ${t.nodes.size} ≤ 80`);
  assert.ok(t.nodes.has(root) && t.nodes.has(p));
  checkConsistent(t.nodes, root);
});

test('ice-tools: timelineView folds boring runs into counted gaps', () => {
  const t = mkTl();
  const root = t.add(0, 0);
  const mid = chainFrom(t, root, 30, 30);
  const branch = t.add(mid, 1000);
  const tipA = chainFrom(t, branch, 12, 1030);
  const tipB = chainFrom(t, branch, 12, 1030);
  const rows = timelineView(t.nodes, root, { current: tipB, nearCurrent: 3 });
  const gaps = rows.filter((r) => r.type === 'gap');
  const nodesShown = rows.filter((r) => r.type === 'node');
  assert.ok(gaps.length >= 2, 'runs folded');
  // every node is either shown or accounted for inside a gap
  const total = nodesShown.length + gaps.reduce((a, g) => a + g.count, 0);
  assert.equal(total, t.nodes.size, 'nothing lost in the folding');
  // root, branch, both tips, current visible
  for (const id of [root, branch, tipA, tipB]) {
    assert.ok(nodesShown.some((r) => r.id === id), `node ${id} visible`);
  }
  // near-current ancestors stay visible even mid-chain
  const cur = rows.find((r) => r.type === 'node' && r.current);
  assert.equal(cur.id, tipB);
  // expanding a gap reveals its nodes
  const rows2 = timelineView(t.nodes, root, { current: tipB, nearCurrent: 3, expanded: new Set(gaps[0].ids) });
  assert.ok(rows2.filter((r) => r.type === 'node').length > nodesShown.length, 'expansion shows more');
});
