// ice — the browser face of the ICE. demo/ice.html opens from machine.html and
// grabs window.opener.__machine; every measurement underneath is icecore.js,
// which is pure and knows nothing about a DOM.
//
// What lives here and what does not (issue #37): this file owns *panes* —
// laying out registers, disassembly, the hex dump, the timeline tree, the label
// notebook, the assembler pane. It owns nothing that observes the machine. All
// of that (the step/stepFrame wraps, breakpoints, watchpoints, I/O breaks, the
// trace ring, the shadow call stack, the profiler, the recorders) moved to
// ../icecore.js so tools/ice.mjs can run the same instrumentation headless.
//
// The wrap trick, for readers who used to find it here: machine.stepFrame and
// cpu.step are replaced on the machine *instance*. While paused, stepFrame
// returns immediately, so the host page rAF loop spins without advancing the
// world. A breakpoint fires inside cpu.step by throwing a sentinel the
// stepFrame wrap catches — that aborts the frame mid-slice, exactly what an ICE
// does when it yanks WAIT. See icecore.js for the rest.
//
// Time travel (snapshot tree, branching, replay) stays here because it is a
// *view* built on core-provided snapshot()/restore() plus the input log the
// core records for us.

import { assemble } from '../z80asm.js';
import { analyze, exportSource } from '../z80anal.js';
import { PORTS_PC88_MAIN, PORTS_PC88_SUB } from '../z80anal.js';
import { regionAt, pinPresets, estimateUnused } from '../memmap.js';
import { labelMap, commentFor } from '../romlabels.js';
import {
  parsePattern, searchBytes, ChangeSearch, textVramModel, attrShort,
  thinTimeline, timelineView,
} from './ice-tools.js';
import {
  BREAK, IceController, hex, parseNum, compileCond, compileAccessCond, compileCondFor,
  writeReg, REG_FIELDS, regsModel, disasmList, hexDump,
} from '../icecore.js';
import { Z80_ARCH } from '../icearch.js';

// Re-exported so demo/ice.html, tests and any future pane keep one import site.
export {
  BREAK, IceController, hex, parseNum, compileCond, compileAccessCond, compileCondFor,
  writeReg, REG_FIELDS, regsModel, disasmList, hexDump,
};

// ---- the page ------------------------------------------------------------------
// ---- the page ------------------------------------------------------------------
// mountIcePage(document, env) wires the static skeleton in ice.html. env:
//   getMachine()     → the live machine (opener's __machine) or null
//   openerAlive()    → false when the parent window is gone
//   raf(cb)          → requestAnimationFrame (injectable for headless smoke)
//   t(s)             → i18n
//   storage          → { get(k), set(k,v) } (localStorage in the browser)
//   download(name,s) → save text as a file (Blob+<a> in the browser)
export function mountIcePage(doc, env) {
  // Look in the main document, then in any panels that dockgrid has popped out
  // into their own windows (so their live updates keep flowing after the move).
  const $ = (id) => doc.getElementById(id) || (globalThis.__dockFindEl ? globalThis.__dockFindEl(id) : null);
  const t = env.t ?? ((s) => s);
  const storage = env.storage ?? { get: () => null, set: () => {} };
  const ctrl = new IceController();
  const state = {
    active: 'main',
    memAddr: 0,
    syntax: 'zilog',
    // Breakpoints survive machine reboots. Keyed by the *probed* CPU name, so a
    // board with a third CPU (the Mega Drive's sound Z80) gets its own drawer
    // instead of writing into an undefined one.
    savedBps: {},
    labels: new Map(), // addr → name: user labeling + merged asm symbols
    labelsKey: null,
    lastAsm: null,
    editing: null, // { field, input } while a register cell is being typed into
    disFocus: null, // backtrace-frame view override for the disasm window
    watchExprs: [], // live watch expressions {expr, fn, error}
    changeSearch: new ChangeSearch(),
    // ROM annotation presets (romlabels.js): per-CPU, user labels win
    presets: { main: new Map(), sub: new Map() },
  };
  const lang = env.lang ?? 'ja';
  // time travel: snapshot nodes form a tree; branches are born when you
  // resume from the past. Needs machine.snapshot()/restore() in the core.
  const SNAP_EVERY = 30, SNAP_CAP = 80, SNAP_RECENT = 8; // ≈4s of dense history
  const tl = {
    nodes: new Map(), rootId: 0, current: 0, next: 1,
    inputLog: [], treeVer: 0, renderVer: -1,
    expanded: new Set(), // fold-rows the user clicked open
  };
  const ttOK = (m) => typeof m?.snapshot === 'function' && typeof m?.restore === 'function';

  const els = {};
  for (const id of ['conn', 'minfo', 'clock', 'tabmain', 'tabsub', 'bpause', 'bcont', 'bstep',
    'bover', 'bstepout', 'bframe', 'bsyntax', 'regs', 'reginfo', 'regshadow', 'dis', 'memaddr', 'mem',
    'memregion', 'memup', 'memdown', 'mempgup', 'mempgdn', 'waddr', 'wdata', 'bwrite', 'bpaddr', 'bpcond', 'bpbtn', 'bplist', 'fdc', 'fdcbox',
    'asrc', 'aorg', 'basm', 'bsetpc', 'brun', 'aout', 'anal',
    'btundo', 'btredo', 'btsnap', 'tree', 'ttinfo',
    'bprof', 'bprofreset', 'prof', 'stack',
    'laddr', 'lname', 'bladd', 'blexport', 'blimport',
    'exps', 'expe', 'expo', 'bexp', 'bexpsave', 'bexpwrite', 'exptext', 'pinnote',
    'bpromasm', 'bpromexp',
    'walo', 'wahi', 'war', 'waw', 'wacond', 'bwadd', 'wlist',
    'iosel', 'iolo', 'iohi', 'ioin', 'ioout', 'iocond', 'bioadd', 'iolist',
    'spat', 'bsearch', 'sres', 'bcsinit', 'bcsne', 'bcseq', 'bcsgt', 'bcslt',
    'csval', 'bcsval', 'csinfo', 'csres', 'bunused', 'unusedout',
    'wxexpr', 'bwxadd', 'wxlist',
    'trace', 'btrace', 'btraceclr', 'vram', 'vraminfo', 'metabox', 'presetnote']) {
    els[id] = $(id);
  }

  const activeCpu = () => ctrl.cpu(state.active) ?? ctrl.cpus[0] ?? null;
  // label resolution: the user's own names shadow the ROM presets
  const presetAt = (a) => state.presets[state.active]?.get(a & 0xffff) ?? null;
  const labelOf = (a) => state.labels.get(a & 0xffff) ?? presetAt(a)?.name ?? null;
  const kindOf = (m) => (m?.sys ? 'pc8001' : 'pc8801'); // for memmap lookups
  const regionText = (addr) => {
    const m = ctrl.machine;
    if (!m || state.active !== 'main') return '';
    const r = regionAt(kindOf(m), addr & 0xffff);
    if (!r) return '';
    return `${r.name} [${r.kind}]` + (r.confidence !== 'verified' ? ` (${r.confidence})` : '');
  };

  // --- register cells (click to edit while paused) -------------------------
  // Built from the architecture descriptor, not from a fixed Z80 list: the
  // sub-board is a Z80 today, but a 68000 or 6502 tab has a different set and
  // the pane has to follow it. Rebuilt only when the arch actually changes.
  const regCells = new Map();
  let regArch = null;
  function buildRegCells(arch) {
    if (regArch === arch) return;
    regArch = arch;
    regCells.clear();
    els.regs.textContent = '';
    for (const [name, width] of arch?.regFields ?? REG_FIELDS) {
      const cell = doc.createElement('span');
      cell.className = 'regcell';
      cell.onclick = () => beginRegEdit(name, width, cell);
      els.regs.appendChild(cell);
      regCells.set(name, cell);
    }
  }
  buildRegCells(null);

  function beginRegEdit(name, width, cell) {
    if (!ctrl.paused || state.editing) return; // live registers are a moving target
    const c = activeCpu();
    if (!c) return;
    const input = doc.createElement('input');
    input.value = hex(regsModel(c.cpu, c.arch).val[name], width);
    input.size = width + 1;
    input.className = 'regedit';
    const commit = (apply) => {
      if (state.editing?.input !== input) return;
      state.editing = null;
      if (apply) {
        const v = parseNum(input.value);
        if (v !== null) writeReg(c.cpu, name, v, c.arch);
      }
      try { cell.removeChild(input); } catch { /* already re-rendered */ }
      renderAll();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
    };
    input.onblur = () => commit(true);
    state.editing = { field: name, input };
    cell.textContent = name + ' ';
    cell.appendChild(input);
    input.focus?.();
  }

  // --- label DB (the mini-IDA notebook) -------------------------------------
  function labelsKeyFor(m) {
    // machine kind + a fingerprint of low ROM bytes keeps sessions apart
    let h = 0;
    const rd = ctrl.cpu('main')?.read;
    for (let i = 0; i < 64; i++) h = ((h * 31) + (rd ? rd(i) & 0xff : 0)) >>> 0;
    return `ice-labels-${m.sub ? '88' : '8001'}-${h.toString(16)}`;
  }
  function loadLabels(m) {
    state.labelsKey = labelsKeyFor(m);
    state.labels = new Map();
    try {
      const raw = storage.get(state.labelsKey);
      if (raw) for (const [a, n] of JSON.parse(raw)) state.labels.set(a & 0xffff, String(n));
    } catch { /* corrupt store — start clean */ }
  }
  function saveLabels() {
    if (state.labelsKey) { try { storage.set(state.labelsKey, JSON.stringify([...state.labels])); } catch { } }
  }
  function setLabel(addr, name) {
    addr &= 0xffff;
    if (name) state.labels.set(addr, name);
    else state.labels.delete(addr);
    saveLabels();
  }

  // --- attach / reconnect ----------------------------------------------------
  function plantBps() {
    for (const c of ctrl.cpus) {
      for (const [addr, cond] of state.savedBps[c.name] ?? []) ctrl.setBreak(c.name, addr, cond);
    }
  }
  function syncAttach() {
    let m = null;
    try { m = env.getMachine(); } catch { m = null; }
    if (!m || !m.cpu) {
      if (ctrl.machine) ctrl.detach();
      const dead = env.openerAlive && env.openerAlive() === false;
      setConn(dead ? t('切断（親ウィンドウが閉じられた）') : t('マシン待ち — machine.htmlでROMを読み込んで'), 'bad');
      return null;
    }
    if (ctrl.machine !== m) {
      ctrl.attach(m);
      ctrl.onInput = (type, frame, row, bit) => { // the replay diary
        tl.inputLog.push([frame, type, row, bit]);
        if (tl.inputLog.length > 20000) tl.inputLog.splice(0, 4000); // old replays go stale, new ones stay exact
      };
      plantBps();
      if (!ctrl.cpu(state.active)) state.active = 'main';
      loadLabels(m);
      // ROM annotation presets — the analyzed understanding of the ROMs
      // (romlabels.js). User labels shadow these; deleting reverts.
      state.presets = {
        main: kindOf(m) === 'pc8801' ? labelMap('n88-fr') : new Map(),
        sub: m.sub ? labelMap('pc80s31') : new Map(),
      };
      const pm = state.presets.main.size, ps = state.presets.sub.size;
      els.presetnote.textContent = pm + ps
        ? `${t('ROM注釈プリセット')}: main ${pm} / sub ${ps} — ${t('ラベル行クリックで解説とmetaが出る')}`
        : t('（このROMの注釈プリセットは無い）');
      els.pinnote.textContent = t('pin推奨（動かせない領域）') + ': '
        + pinPresets(kindOf(m)).slice(0, 5).map((r) => `${hex(r.start, 4)}-${hex(r.end, 4)} ${r.name}`).join(' / ')
        + (pinPresets(kindOf(m)).length > 5 ? ' …' : '');
      // reset the timeline for the fresh machine
      tl.nodes.clear();
      tl.inputLog = [];
      tl.next = 1;
      tl.current = 0;
      tl.rootId = 0;
      tl.expanded.clear();
      tl.treeVer++;
      if (ttOK(m)) takeSnap(m, 0);
      updateTabs();
    }
    return m;
  }

  function setConn(text, cls) {
    els.conn.textContent = text;
    els.conn.className = 'conn ' + cls;
  }

  function updateTabs() {
    const hasSub = !!ctrl.cpu('sub');
    els.tabsub.style.display = hasSub ? '' : 'none';
    els.tabmain.className = state.active === 'main' ? 'tab on' : 'tab';
    els.tabsub.className = state.active === 'sub' ? 'tab on' : 'tab';
    els.fdcbox.style.display = hasSub && state.active === 'sub' ? '' : 'none';
    rebuildIoSel();
  }

  function rebuildIoSel() { // port-name presets from z80anal's tables
    els.iosel.textContent = '';
    const table = state.active === 'sub' ? PORTS_PC88_SUB : PORTS_PC88_MAIN;
    const opt0 = doc.createElement('option');
    opt0.value = '';
    opt0.textContent = t('（ポート名から選ぶ）');
    els.iosel.appendChild(opt0);
    for (const [lo, hi, name] of table) {
      const o = doc.createElement('option');
      o.value = `${lo}-${hi}`;
      o.textContent = `${hex(lo, 2)}${hi !== lo ? '-' + hex(hi, 2) : ''}h ${name}`;
      els.iosel.appendChild(o);
    }
  }

  // --- time travel -------------------------------------------------------------
  function snapSize(o) { // rough bytes, for the tree header
    if (o == null) return 0;
    if (typeof o === 'object' && typeof o.length === 'number' && typeof o !== 'string') {
      if (typeof o[0] === 'number' || o.length === 0) return o.length;
    }
    if (Array.isArray(o)) return o.reduce((s, x) => s + snapSize(x), 8);
    if (typeof o === 'object') return Object.values(o).reduce((s, x) => s + snapSize(x), 8);
    return 8;
  }
  function takeSnap(m, parentId, pinned = false) {
    let node;
    try {
      node = { id: tl.next++, parent: parentId, frame: m.frame, snap: m.snapshot(), children: [], pinned };
    } catch { return null; }
    node.size = snapSize(node.snap);
    tl.nodes.set(node.id, node);
    const p = tl.nodes.get(parentId);
    if (p) p.children.push(node.id);
    else tl.rootId = node.id;
    tl.current = node.id;
    tl.treeVer++;
    // rr-style thinning: dense recent past, exponentially sparse deep past.
    // Root / branch points / tips / pinned / current always survive; the
    // deterministic replay just gets a longer run-up from a sparser region.
    const { removed } = thinTimeline(tl.nodes, tl.rootId, {
      current: tl.current, keepRecent: SNAP_RECENT, cap: SNAP_CAP, baseSpacing: SNAP_EVERY,
    });
    if (removed.length) tl.treeVer++;
    return node;
  }
  function ensureWrapped(m) {
    // restore() writes into the same objects on this core, but stay paranoid:
    // if a future core swaps the cpu object, re-clamp and re-plant
    const c = ctrl.cpu('main');
    if (c && c.cpu !== m.cpu) { ctrl.attach(m); plantBps(); }
  }
  function jumpTo(id) {
    const m = ctrl.machine;
    const node = tl.nodes.get(id);
    if (!m || !node || !ttOK(m)) return;
    if (!ctrl.paused) ctrl.pause();
    m.restore(node.snap);
    ensureWrapped(m);
    tl.current = id;
    tl.treeVer++;
    renderAll();
  }
  function seekFrame(target) {
    const m = ctrl.machine;
    if (!m || !ttOK(m)) return;
    if (!ctrl.paused) ctrl.pause();
    target = Math.max(0, target);
    if (target < m.frame) { // restore the newest ancestor at or before target
      let n = tl.nodes.get(tl.current);
      while (n && n.frame > target) n = tl.nodes.get(n.parent);
      if (!n) { renderAll(); return; }
      m.restore(n.snap);
      ensureWrapped(m);
      tl.current = n.id;
      tl.treeVer++;
    }
    if (target > m.frame) ctrl.replayTo(target, tl.inputLog); // deterministic re-run
    renderAll();
  }
  function branchIfNeeded() {
    // resuming from the past (or from a node that already has a future)
    // starts a new branch under the current node
    const m = ctrl.machine;
    if (!m || !ttOK(m)) return;
    const cur = tl.nodes.get(tl.current);
    if (!cur) return;
    if (cur.frame !== m.frame || cur.children.length > 0) takeSnap(m, tl.current);
  }

  // --- rendering ---------------------------------------------------------------
  function renderRegs(c) {
    buildRegCells(c.arch);
    const m = regsModel(c.cpu, c.arch);
    for (const [name, width] of c.arch.regFields) {
      if (state.editing?.field === name) continue; // don't clobber the input
      regCells.get(name).textContent = `${name} ${hex(m.val[name], width)}`;
    }
    els.reginfo.textContent = m.info;
    els.regshadow.textContent = m.shadow;
  }

  // disassembly lines are elements (not one <pre>) so a click can name an
  // address — the labeling gesture of the mini-IDA loop
  const disPool = [];
  function disLine(i) {
    while (disPool.length <= i) {
      const div = doc.createElement('div');
      div.className = 'disline';
      div._addr = -1;
      div.onclick = () => {
        if (div._addr < 0) return;
        els.laddr.value = hex(div._addr, 4);
        els.lname.value = labelOf(div._addr) ?? '';
        els.metabox.textContent = metaText(div._addr); // the reverse-engineer's tooltip
        els.lname.focus?.();
      };
      els.dis.appendChild(div);
      disPool.push(div);
    }
    return disPool[i];
  }

  // romlabels meta: everything we verified about a ROM routine, one glance
  function metaText(addr) {
    const pe = presetAt(addr);
    if (!pe) return '';
    const lines = [`${pe.name} — ${commentFor(pe, lang)}`
      + (pe.confidence !== 'verified' ? `  (${pe.confidence})` : '')];
    const mt = pe.meta;
    if (mt) {
      const parts = [];
      if (mt.clobbers?.length) parts.push(`${t('破壊')}: ${mt.clobbers.join(',')}`);
      if (mt.inputs?.length) parts.push(`${t('入力')}: ${mt.inputs.join(',')}`);
      if (mt.saves?.length) parts.push(`${t('保存')}: ${mt.saves.join(',')}`);
      for (const io of mt.io ?? []) {
        parts.push(`${io.dir === 'in' ? 'IN' : 'OUT'} ${io.port == null ? '(C)' : hex(io.port, 2) + 'h'}${io.name ? '(' + io.name + ')' : ''}`);
      }
      for (const mm of mt.mem ?? []) parts.push(`${mm.rw}:${hex(mm.addr, 4)}${mm.name ? '(' + mm.name + ')' : ''}`);
      if (mt.tStates) {
        parts.push(`${mt.tStates.min}${mt.tStates.max !== mt.tStates.min ? '〜' + mt.tStates.max : ''}T`
          + (mt.tStates.loop ? t('（ループ・下限のみ）') : ''));
      }
      if (parts.length) lines.push(parts.join(' / '));
      if (mt.unknown) lines.push(t('⚠ 間接フローあり — 解析は不完全'));
    }
    return lines.join('\n');
  }
  function renderDis(c) {
    const center = state.disFocus ?? c.arch.pcOf(c.cpu); // a clicked backtrace frame wins
    const rows = disasmList(c.read, center, 20, 6, { arch: c.arch, syntax: state.syntax, label: labelOf });
    let i = 0;
    for (const r of rows) {
      if (r.label) {
        const lp = disLine(i++);
        const pe = presetAt(r.addr);
        const cm = pe ? commentFor(pe, lang) : '';
        lp.textContent = `        ${r.label}:` + (cm ? `  ; ${cm}` : '');
        lp._addr = r.addr;
        lp.className = 'disline dislabel';
      }
      const bp = c.bps.get(r.addr);
      const mark = bp ? (bp.enabled ? '●' : '○') : ' ';
      const cur = r.addr === c.cpu.pc ? '▶' : ' '; // ▶ stays on the real PC even when a frame is focused
      const bytes = r.bytes.map((b) => hex(b, 2)).join(' ').padEnd(12);
      const line = disLine(i++);
      line.textContent = `${mark}${cur} ${hex(r.addr, 4)}  ${bytes} ${r.text}`;
      line._addr = r.addr;
      line.className = 'disline' + (r.addr === c.cpu.pc ? ' discur' : '');
    }
    for (; i < disPool.length; i++) { disPool[i].textContent = ''; disPool[i]._addr = -1; }
  }

  function renderMem(c) {
    els.mem.textContent = hexDump(c.read, state.memAddr, 16,
      { mask: c.arch.addrMask, width: c.arch.addrMask > 0xffff ? 6 : 4 });
    els.memregion.textContent = regionText(state.memAddr); // memmap annotation
    els.memregion.className = 'region' + (/approx/.test(els.memregion.textContent) ? ' approx' : '');
  }

  // --- round 2 panels ------------------------------------------------------
  function renderStack(c) {
    els.stack.textContent = '';
    const mkRow = (text, addr) => {
      const row = doc.createElement('div');
      row.className = 'stackrow';
      row.textContent = text;
      row.onclick = () => { state.disFocus = addr; renderAll(); };
      els.stack.appendChild(row);
    };
    const nm = (a) => labelOf(a) ?? hex(a, 4);
    mkRow(`#0 ▶ ${nm(c.cpu.pc)}  PC=${hex(c.cpu.pc, 4)}`, c.cpu.pc);
    const bt = ctrl.backtrace(c.name).slice(0, 16);
    bt.forEach((f, i) => {
      mkRow(`#${i + 1}  ${nm(f.entry)}  ${t('戻り先')} ${hex(f.retTo, 4)}  SP=${hex(f.sp, 4)}`, f.entry);
    });
    if (!bt.length) {
      const row = doc.createElement('div');
      row.className = 'stackrow dim';
      row.textContent = t('（CALL未観測 — attach後にCALLが実行されると積まれる）');
      els.stack.appendChild(row);
    }
  }

  function renderWatchList() {
    const c = activeCpu();
    els.wlist.textContent = '';
    for (const cc of ctrl.cpus) {
      for (const w of cc.watches) {
        const row = doc.createElement('div');
        row.className = 'listrow' + (w.enabled ? '' : ' dim');
        const range = w.lo === w.hi ? hex(w.lo, 4) : `${hex(w.lo, 4)}-${hex(w.hi, 4)}`;
        const reg = cc.name === 'main' ? regionText(w.lo) : '';
        row.textContent = `${cc.name} ${range} ${w.r ? 'R' : ''}${w.w ? 'W' : ''}`
          + (w.cond ? ` if ${w.cond}` : '') + (reg ? `  — ${reg}` : '')
          + (w.enabled ? '' : `  ${t('無効')}: ${w.error}`);
        row.onclick = () => { ctrl.clearWatch(cc.name, w.id); renderAll(); };
        els.wlist.appendChild(row);
      }
    }
    if (!els.wlist.children.length) els.wlist.textContent = t('（なし — クリックで削除）');
    void c;
  }

  function renderIoList() {
    els.iolist.textContent = '';
    for (const cc of ctrl.cpus) {
      for (const w of cc.iobps) {
        const row = doc.createElement('div');
        row.className = 'listrow' + (w.enabled ? '' : ' dim');
        const range = w.lo === w.hi ? hex(w.lo, 2) : `${hex(w.lo, 2)}-${hex(w.hi, 2)}`;
        row.textContent = `${cc.name} port ${range} ${w.in ? 'IN' : ''}${w.in && w.out ? '/' : ''}${w.out ? 'OUT' : ''}`
          + (w.cond ? ` if ${w.cond}` : '')
          + (w.enabled ? '' : `  ${t('無効')}: ${w.error}`);
        row.onclick = () => { ctrl.clearIoBreak(cc.name, w.id); renderAll(); };
        els.iolist.appendChild(row);
      }
    }
    if (!els.iolist.children.length) els.iolist.textContent = t('（なし — クリックで削除）');
  }

  function renderWx(c) {
    els.wxlist.textContent = '';
    for (const wx of state.watchExprs) {
      const row = doc.createElement('div');
      row.className = 'listrow';
      let text;
      try {
        // The argument list comes from the architecture, so an expression
        // compiled for the sub tab and one compiled for a 68000 tab each see
        // their own register names. A stale expression just throws and says so.
        const v = wx.fn(...c.arch.condValues(c.cpu, c.read));
        text = typeof v === 'number' ? `${wx.expr} = ${hex(v & 0xffff, v > 0xff ? 4 : 2)} (${v})` : `${wx.expr} = ${v}`;
      } catch (e) { text = `${wx.expr} — ${String(e?.message ?? e)}`; }
      row.textContent = text;
      row.onclick = () => { state.watchExprs = state.watchExprs.filter((x) => x !== wx); renderAll(); };
      els.wxlist.appendChild(row);
    }
    if (!state.watchExprs.length) els.wxlist.textContent = t('（式を追加 — 例: hl, mem(0xEF14), bc+de）');
  }

  function renderTrace(c) {
    els.trace.textContent = '';
    if (!c.traceOn) { els.trace.textContent = t('（トレースOFF）'); return; }
    const rows = ctrl.traceView(c.name, 24);
    for (const r of rows) {
      const row = doc.createElement('div');
      row.className = 'listrow';
      let text = '';
      try { text = c.arch.disasm ? c.arch.disasm(c.read, r.pc, { syntax: state.syntax }).text : ''; } catch { text = '?'; }
      row.textContent = `f=${String(r.frame).padStart(6)} ${hex(r.pc, 4)} ${text.padEnd(18)}`
        + ` AF=${hex(r.af, 4)} BC=${hex(r.bc, 4)} DE=${hex(r.de, 4)} HL=${hex(r.hl, 4)} SP=${hex(r.sp, 4)}`;
      row.onclick = () => traceJump(r);
      els.trace.appendChild(row);
    }
    if (!rows.length) els.trace.textContent = t('（まだ何も実行してない）');
  }

  function renderVram(m) {
    let model = null;
    try { model = textVramModel(m); } catch { model = null; }
    if (!model) {
      els.vraminfo.textContent = t('CRTC/DMACが見つからない');
      els.vram.textContent = '';
      return;
    }
    els.vraminfo.textContent =
      `base=${hex(model.base, 4)} stride=${model.stride} count=${model.count}`
      + ` ${model.cols}×${model.rows} attrs/row=${model.attrsPerRow}`
      + ` DMA:${model.enabled ? 'ON' : 'OFF'} VE:${model.ve ? 'ON' : 'OFF'}`;
    const lines = [];
    for (const row of model.rowsData) {
      lines.push(`${String(row.y).padStart(2)} ${hex(row.addr, 4)} |${row.text}|`);
      if (row.pairs.length || row.spans.length > 1) {
        const pairs = row.pairs.map((p) => `(${p.pos},${hex(p.val, 2)} ${p.text})`).join(' ');
        const spans = row.spans.map((s) => {
          const parts = [attrShort(s.color)];
          if (s.func) parts.push(attrShort(s.func));
          return `${s.from}-${s.to}:${parts.join('+')}`;
        }).join(' ');
        lines.push(`        ${pairs}${pairs && spans ? '  →  ' : ''}${spans}`);
      }
    }
    els.vram.textContent = lines.join('\n');
  }

  // trace row click → time travel to (approximately) that instruction:
  // rewind to the row's frame, then crawl forward until the recorded
  // pc/sp/af triple matches. Breakpoints hold their fire during the crawl.
  function traceJump(row) {
    const m = ctrl.machine;
    if (!m || !ttOK(m)) return;
    seekFrame(row.frame);
    const c = activeCpu();
    if (!c) return;
    let budget = 400000;
    ctrl.replaying = true;
    try {
      while (budget-- > 0 && !(c.cpu.pc === row.pc && c.cpu.sp === row.sp && c.cpu.af === row.af)) {
        ctrl.stepInto(state.active, false);
      }
    } finally { ctrl.replaying = false; }
    renderAll();
  }

  function renderBps() {
    const lines = [];
    for (const c of ctrl.cpus) {
      for (const [addr, bp] of c.bps) {
        const name = labelOf(addr);
        let s = `${c.name}  ${hex(addr, 4)}${name ? ' (' + name + ')' : ''}`;
        if (bp.cond) s += `  if ${bp.cond}`;
        if (!bp.enabled) s += `  — ${t('無効')}: ${bp.error}`;
        lines.push(s);
      }
    }
    els.bplist.textContent = lines.length ? lines.join('\n') : t('（なし — アドレスを入れて±で追加）');
  }

  function renderFdc(m) {
    if (!m.sub || state.active !== 'sub') return;
    try {
      const st = m.sub.getState ? m.sub.getState() : { fdc: m.sub.fdc?.getState?.() };
      els.fdc.textContent = JSON.stringify(st, null, 1);
    } catch (e) { els.fdc.textContent = String(e); }
  }

  function clockHzOf(m) {
    // the cores don't retain clockHz, but frameT × 60 is the effective
    // executed clock (DMA steal already subtracted) — the honest number
    return m.clockHz ?? (m.frameT ? m.frameT * 60 : 4_000_000);
  }
  function renderClock(m, c) {
    const clk = clockHzOf(m);
    els.clock.textContent =
      `T=${c.tTotal}  ≈${(c.tTotal / clk).toFixed(3)}s @${(clk / 1e6).toFixed(2)}MHz  frame=${m.frame ?? '?'}`;
  }

  function renderTree(m) {
    if (tl.renderVer === tl.treeVer) return; // redraw only when the tree changed
    tl.renderVer = tl.treeVer;
    els.tree.textContent = '';
    if (!ttOK(m)) {
      els.ttinfo.textContent = t('coreがsnapshot/restore未対応（古いmachine.js）');
      return;
    }
    let total = 0;
    for (const n of tl.nodes.values()) total += n.size ?? 0;
    // compressed view: boring degree-1 runs fold into one "─⋯×N─" edge;
    // clicking the fold expands it once (collapses again on the next fold)
    const rows = timelineView(tl.nodes, tl.rootId, {
      current: tl.current, nearCurrent: 3, expanded: tl.expanded,
    });
    for (const r of rows) {
      const row = doc.createElement('div');
      if (r.type === 'gap') {
        row.className = 'treerow gap';
        row.textContent = `${'· '.repeat(r.depth)}│ ─⋯×${r.count}─`;
        const ids = r.ids;
        row.onclick = () => {
          for (const id of ids) tl.expanded.add(id);
          tl.treeVer++;
          renderAll();
        };
      } else {
        row.className = 'treerow' + (r.current ? ' on' : '') + (r.pinned ? ' pin' : '');
        const mark = r.current ? '▶' : r.pinned ? '📸' : r.branch ? '┳' : '○';
        row.textContent = `${'· '.repeat(r.depth)}${mark} f=${r.frame}`;
        row.onclick = () => jumpTo(r.id);
      }
      els.tree.appendChild(row);
    }
    els.ttinfo.textContent =
      `${tl.nodes.size}/${SNAP_CAP} snap ≈${(total / 1024) | 0}KB — `
      + t('古い一本道は間引き済み（決定論再実行で正確性は不変・再実行が伸びるだけ）') + ' / '
      + t('D88へのセクタ書込は巻き戻らない');
  }

  function renderProf(c, m) {
    if (!c.profOn) { els.prof.textContent = t('（OFF — ⏱で計測開始）'); return; }
    const clk = clockHzOf(m);
    const rows = [...c.profData.routines.entries()]
      .map(([addr, r]) => ({ addr, ...r }))
      .sort((x, y) => y.total - x.total)
      .slice(0, 20);
    const head = `${t('ルーチン').padEnd(14)}${'calls'.padStart(8)}${'self T'.padStart(12)}${'total T'.padStart(12)}${'ms'.padStart(9)}`;
    const lines = rows.map((r) => {
      const name = (labelOf(r.addr) ?? hex(r.addr, 4)).slice(0, 13);
      return `${name.padEnd(14)}${String(r.calls).padStart(8)}${String(r.self).padStart(12)}${String(r.total).padStart(12)}${(r.total / clk * 1000).toFixed(2).padStart(9)}`;
    });
    els.prof.textContent = [head, ...lines].join('\n') || head;
  }

  function renderAll() {
    const m = ctrl.machine;
    if (!m) return;
    const c = activeCpu();
    if (!c) return;
    if (ctrl.paused) {
      const h = ctrl.hit;
      let msg;
      if (!h) msg = t('一時停止中');
      else if (h.type === 'watch') msg = `⛔ WATCH ${h.rw.toUpperCase()} ${hex(h.addr, 4)}=${hex(h.value, 2)} @${hex(h.pc, 4)} (${h.cpu})`;
      else if (h.type === 'io') msg = `⛔ I/O ${h.rw.toUpperCase()} port ${hex(h.addr, 2)}=${hex(h.value, 2)} @${hex(h.pc, 4)} (${h.cpu})`;
      else msg = `⛔ BREAK ${h.cpu} @ ${hex(h.pc, 4)}`;
      setConn(msg, 'pause');
    } else setConn(t('実行中'), 'run');
    els.minfo.textContent = `${m.sub ? 'PC-8801 main+sub' : 'PC-8001'}  [${state.active}]`;
    renderClock(m, c);
    renderRegs(c);
    renderDis(c);
    renderMem(c);
    renderBps();
    renderStack(c);
    renderWatchList();
    renderIoList();
    renderWx(c);
    renderTrace(c);
    renderVram(m);
    renderFdc(m);
    renderTree(m);
    renderProf(c, m);
  }

  // --- controls -----------------------------------------------------------------
  els.bpause.onclick = () => { state.disFocus = null; ctrl.pause(); renderAll(); };
  els.bcont.onclick = () => { state.disFocus = null; branchIfNeeded(); ctrl.resume(); renderAll(); };
  els.bstep.onclick = () => {
    state.disFocus = null;
    if (!ctrl.paused) ctrl.pause();
    ctrl.stepInto(state.active);
    renderAll();
  };
  els.bover.onclick = () => {
    state.disFocus = null;
    if (!ctrl.paused) ctrl.pause();
    ctrl.stepOver(state.active);
    renderAll();
  };
  els.bstepout.onclick = () => {
    state.disFocus = null;
    if (!ctrl.paused) ctrl.pause();
    ctrl.stepOut(state.active);
    renderAll();
  };
  els.bframe.onclick = () => {
    state.disFocus = null;
    if (!ctrl.paused) ctrl.pause();
    branchIfNeeded();
    ctrl.frameStep();
    renderAll();
  };
  els.bsyntax.onclick = () => {
    state.syntax = state.syntax === 'zilog' ? 'intel' : 'zilog';
    els.bsyntax.textContent = state.syntax === 'zilog' ? 'Zilog' : 'Intel 8080';
    renderAll();
  };
  els.tabmain.onclick = () => { state.active = 'main'; updateTabs(); renderAll(); };
  els.tabsub.onclick = () => { if (ctrl.cpu('sub')) { state.active = 'sub'; updateTabs(); renderAll(); } };

  els.btundo.onclick = () => seekFrame((ctrl.machine?.frame ?? 1) - 1);
  els.btredo.onclick = () => seekFrame((ctrl.machine?.frame ?? 0) + 1);
  els.btsnap.onclick = () => { // manual snapshots are pinned — thinning never eats them
    const m = ctrl.machine;
    if (m && ttOK(m)) { takeSnap(m, tl.current, true); renderAll(); }
  };

  els.bprof.onclick = () => {
    const c = activeCpu();
    if (!c) return;
    c.profOn = !c.profOn;
    els.bprof.className = c.profOn ? 'on' : '';
    renderAll();
  };
  els.bprofreset.onclick = () => {
    const c = activeCpu();
    if (c) { ctrl.profReset(c.name); c.tTotal = 0; renderAll(); }
  };

  els.memaddr.onchange = () => {
    const v = parseNum(els.memaddr.value);
    if (v !== null) state.memAddr = v & 0xffff;
    renderAll();
  };
  const stepMem = (delta) => { state.memAddr = (state.memAddr + delta) & 0xfff0; els.memaddr.value = hex(state.memAddr, 4); renderAll(); };
  if (els.memup) els.memup.onclick = () => stepMem(-16);      // one 16-byte line up
  if (els.memdown) els.memdown.onclick = () => stepMem(16);   // one line down
  if (els.mempgup) els.mempgup.onclick = () => stepMem(-256); // 16 lines up
  if (els.mempgdn) els.mempgdn.onclick = () => stepMem(256);  // 16 lines down
  els.bwrite.onclick = () => {
    const c = activeCpu();
    const a = parseNum(els.waddr.value);
    if (!c || a === null) return;
    const bytes = els.wdata.value.trim().split(/[\s,]+/).map(parseNum).filter((v) => v !== null);
    bytes.forEach((v, i) => c.write((a + i) & 0xffff, v));
    state.memAddr = a & 0xfff0;
    els.memaddr.value = hex(state.memAddr, 4);
    renderAll();
  };

  els.bpbtn.onclick = () => {
    const addr = parseNum(els.bpaddr.value);
    if (addr === null) return;
    const cond = els.bpcond.value.trim() || null;
    const c = activeCpu();
    if (!c) return;
    const saved = (state.savedBps[c.name] ??= new Map());
    const key = addr & c.arch.addrMask;
    if (c.bps.has(key) && !cond) { // toggle off
      ctrl.clearBreak(c.name, addr);
      saved.delete(key);
    } else {
      const r = ctrl.setBreak(c.name, addr, cond);
      if (!r.ok) { els.bplist.textContent = t('条件式エラー') + ': ' + r.error; return; }
      saved.set(key, cond);
    }
    renderAll();
  };

  // --- watchpoints / I/O breaks ---------------------------------------------------
  els.bwadd.onclick = () => {
    const lo = parseNum(els.walo.value);
    if (lo === null) return;
    const hi = parseNum(els.wahi.value);
    const r = !!els.war.checked, w = !!els.waw.checked;
    if (!r && !w) return;
    const res = ctrl.setWatch(state.active, { lo, hi, r, w, cond: els.wacond.value.trim() || null });
    if (!res.ok) { els.wlist.textContent = t('条件式エラー') + ': ' + res.error; return; }
    renderAll();
  };
  els.bioadd.onclick = () => {
    const lo = parseNum(els.iolo.value);
    if (lo === null) return;
    const hi = parseNum(els.iohi.value);
    const dirIn = !!els.ioin.checked, dirOut = !!els.ioout.checked;
    if (!dirIn && !dirOut) return;
    const res = ctrl.setIoBreak(state.active, { lo, hi, dirIn, dirOut, cond: els.iocond.value.trim() || null });
    if (!res.ok) { els.iolist.textContent = t('条件式エラー') + ': ' + res.error; return; }
    renderAll();
  };
  els.iosel.onchange = () => { // port-name preset → fills the range fields
    const v = els.iosel.value;
    if (!v) return;
    const [lo, hi] = v.split('-').map(Number);
    els.iolo.value = hex(lo, 2);
    els.iohi.value = hi !== lo ? hex(hi, 2) : '';
  };

  // --- memory search / change search / watch expressions ---------------------------
  els.bsearch.onclick = () => {
    const c = activeCpu();
    const pat = parsePattern(els.spat.value);
    els.sres.textContent = '';
    if (!c || !pat) { els.sres.textContent = t('パターンが変（hex列 か "文字列"）'); return; }
    const hits = searchBytes(c.read, pat, { limit: 64 });
    if (!hits.length) { els.sres.textContent = t('（見つからない）'); return; }
    for (const a of hits) {
      const row = doc.createElement('div');
      row.className = 'listrow';
      row.textContent = `${hex(a, 4)}  ${regionText(a)}`;
      row.onclick = () => { state.memAddr = a & 0xfff0; els.memaddr.value = hex(state.memAddr, 4); renderAll(); };
      els.sres.appendChild(row);
    }
  };
  function renderCsList() {
    const c = activeCpu();
    els.csres.textContent = '';
    if (!c) return;
    for (const x of state.changeSearch.list(c.read, 24)) {
      const row = doc.createElement('div');
      row.className = 'listrow';
      row.textContent = `${hex(x.addr, 4)} = ${hex(x.value, 2)}  ${regionText(x.addr)}`;
      row.onclick = () => { state.memAddr = x.addr & 0xfff0; els.memaddr.value = hex(state.memAddr, 4); renderAll(); };
      els.csres.appendChild(row);
    }
  }
  const csFilter = (op, operand) => {
    const c = activeCpu();
    if (!c || !state.changeSearch.alive) { els.csinfo.textContent = t('まず📸初期化して'); return; }
    const n = state.changeSearch.filter(c.read, op, operand);
    els.csinfo.textContent = `${n} ${t('候補')}`;
    renderCsList();
  };
  els.bcsinit.onclick = () => {
    const c = activeCpu();
    if (!c) return;
    state.changeSearch.init(c.read);
    els.csinfo.textContent = t('全64KBを撮影した — 値を動かしてから絞り込む');
    els.csres.textContent = '';
  };
  els.bcsne.onclick = () => csFilter('ne');
  els.bcseq.onclick = () => csFilter('eq');
  els.bcsgt.onclick = () => csFilter('gt');
  els.bcslt.onclick = () => csFilter('lt');
  els.bcsval.onclick = () => {
    const v = parseNum(els.csval.value);
    if (v !== null) csFilter('val', v);
  };
  els.bunused.onclick = () => { // execution-coverage complement of user RAM
    const c = ctrl.cpu('main');
    const m = ctrl.machine;
    if (!c || !m) return;
    const runs = estimateUnused(kindOf(m), c.coverage).sort((a, b) => b.bytes - a.bytes).slice(0, 8);
    els.unusedout.textContent = runs.length
      ? runs.map((r2) => `${hex(r2.start, 4)}-${hex(r2.end, 4)} (${r2.bytes}B)`).join('\n')
      : t('（userRAMに未実行領域なし）');
  };
  els.bwxadd.onclick = () => {
    const expr = els.wxexpr.value.trim();
    if (!expr) return;
    const ac = activeCpu();
    try { state.watchExprs.push({ expr, fn: compileCondFor(ac?.arch ?? Z80_ARCH, expr) }); }
    catch (e) { els.wxlist.textContent = t('条件式エラー') + ': ' + String(e?.message ?? e); return; }
    els.wxexpr.value = '';
    renderAll();
  };

  // --- trace ------------------------------------------------------------------------
  els.btrace.className = 'on';
  els.btrace.onclick = () => {
    const c = activeCpu();
    if (!c) return;
    c.traceOn = !c.traceOn;
    els.btrace.className = c.traceOn ? 'on' : '';
    renderAll();
  };
  els.btraceclr.onclick = () => { ctrl.traceClear(state.active); renderAll(); };

  // --- labels -------------------------------------------------------------------
  els.bladd.onclick = () => {
    const a = parseNum(els.laddr.value);
    if (a === null) return;
    setLabel(a, els.lname.value.trim()); // empty name = delete
    renderAll();
  };
  els.blexport.onclick = () => {
    env.download?.('ice-labels.json', JSON.stringify([...state.labels], null, 1));
  };
  els.blimport.onchange = async (e) => {
    const f = e.target?.files?.[0];
    if (!f) return;
    try {
      const arr = JSON.parse(await f.text());
      for (const [a, n] of arr) state.labels.set(a & 0xffff, String(n));
      saveLabels();
      renderAll();
    } catch (err) { els.bplist.textContent = 'labels import: ' + err.message; }
  };

  // --- assembler pane -------------------------------------------------------------
  els.basm.onclick = () => {
    const c = activeCpu();
    const orgv = parseNum(els.aorg.value) ?? 0x9000;
    const res = assemble(els.asrc.value, { org: orgv });
    state.lastAsm = res;
    if (res.errors.length) {
      els.aout.textContent = res.errors.map((e) => `L${e.line}: ${e.message}`).join('\n');
      els.anal.textContent = '';
      return;
    }
    if (c) for (let i = 0; i < res.bytes.length; i++) c.write((res.org + i) & 0xffff, res.bytes[i]);
    for (const [k, v] of Object.entries(res.symbols)) { // symbols join the label DB
      if (typeof v === 'number' && !k.includes('~') && !k.includes('.')) state.labels.set(v & 0xffff, k);
    }
    saveLabels();
    let msg = `${res.bytes.length} bytes → ${hex(res.org, 4)}h  (${t('書き込み先')}: ${state.active})`;
    if (res.warnings.length) msg += '\n' + res.warnings.map((w) => `L${w.line}: ⚠ ${w.message}`).join('\n');
    if (res.fixups.length) msg += `\nfixups: ${res.fixups.map((f) => hex(f, 4)).join(' ')}`;
    els.aout.textContent = msg;
    renderAnal(res);
    renderAll();
  };
  els.bsetpc.onclick = () => {
    const c = activeCpu();
    const v = parseNum(els.aorg.value);
    if (c && v !== null) { if (!ctrl.paused) ctrl.pause(); c.cpu.pc = v & 0xffff; renderAll(); }
  };
  els.brun.onclick = () => { branchIfNeeded(); ctrl.resume(); renderAll(); };

  function renderAnal(res) {
    els.anal.textContent = '';
    let an;
    try {
      an = analyze(res.bytes, res.org, res.symbols, { ports: state.active === 'sub' ? 'pc88-sub' : 'pc88-main' });
    } catch (e) { els.anal.textContent = String(e); return; }
    const head = doc.createElement('div');
    head.className = 'analhead';
    head.textContent = t('ルーチン / 破壊 / 入力 / 保存 / I/O / mem / T / 警告');
    els.anal.appendChild(head);
    for (const r of an.routines) {
      const row = doc.createElement('div');
      row.className = 'analrow' + (r.warnings.length ? ' warn' : '');
      const io = r.io.map((i) => `${i.dir === 'in' ? '←' : '→'}${i.port === null ? '(C)' : hex(i.port, 2)}${i.name ? '=' + i.name : ''}`).join(' ');
      const mem = r.mem.map((mm) => `${mm.rw}${hex(mm.addr, 4)}${mm.name ? '=' + mm.name : ''}`).join(' ');
      const tS = r.tStates.min === r.tStates.max ? `${r.tStates.min}T` : `${r.tStates.min}〜${r.tStates.max}T`;
      row.textContent = `${r.name} @${hex(r.addr, 4)}  破壊:${r.destroys.join('') || '-'}${r.unknown ? '+?' : ''}`
        + `  入力:${r.inputs.join('') || '-'}  保存:${r.saves.join('') || '-'}`
        + (io ? `  IO:${io}` : '') + (mem ? `  MEM:${mem}` : '')
        + `  ${tS}${r.tStates.loop ? '×loop' : ''}`
        + (r.callers.length ? `  ←${r.callers.join(',')}` : '')
        + (r.warnings.length ? '  ' + r.warnings.map((w) => w.message).join(' / ') : '');
      row.onclick = () => jumpToLabel(r.name.split('/')[0]);
      els.anal.appendChild(row);
    }
  }

  function jumpToLabel(name) {
    const src = els.asrc.value;
    const re = new RegExp(`^\\s*${name}\\b`, 'im');
    const m = re.exec(src);
    if (!m) return;
    els.asrc.focus?.();
    try {
      els.asrc.selectionStart = m.index;
      els.asrc.selectionEnd = m.index + m[0].length;
    } catch { /* headless shim */ }
  }

  // --- source export / relocate ----------------------------------------------
  function doExport() {
    const c = activeCpu();
    if (!c) return null;
    const s = parseNum(els.exps.value), e = parseNum(els.expe.value);
    if (s === null || e === null || e < s) {
      els.exptext.value = t('範囲を addr,addr で入れて（終了は含む）');
      return null;
    }
    const o = parseNum(els.expo.value);
    // extra reachability seeds: breakpointed addresses are code by
    // definition (you were stepping there) — labels alone could be data
    const text = exportSource(c.read, s, e + 1, {
      labels: state.labels,
      org: o ?? s,
      entries: [...c.bps.keys()].filter((a) => a >= s && a <= e),
    });
    els.exptext.value = text;
    return text;
  }
  els.bexp.onclick = () => { doExport(); };
  els.bexpsave.onclick = () => {
    const text = els.exptext.value || doExport();
    if (text) env.download?.(`ice-${els.exps.value || 'export'}.z80`, text);
  };
  els.bexpwrite.onclick = () => { // relocate: assemble the export and poke it in
    const c = activeCpu();
    if (!c) return;
    const text = els.exptext.value || doExport();
    if (!text) return;
    const res = assemble(text);
    if (res.errors.length) {
      els.exptext.value = res.errors.map((e) => `; L${e.line}: ${e.message}`).join('\n') + '\n' + text;
      return;
    }
    for (let i = 0; i < res.bytes.length; i++) c.write((res.org + i) & 0xffff, res.bytes[i]);
    state.memAddr = res.org & 0xfff0;
    els.memaddr.value = hex(state.memAddr, 4);
    renderAll();
  };

  // --- ICE → IDE promotion (author workflow: experiment here, manage there) ---
  function promoteToIde(source, org, symbols) {
    if (!source || !source.trim()) return;
    const payload = { type: 'promote', source, org: org ?? null, symbols: symbols ?? null };
    env.broadcast?.send?.(payload);
    try { storage.set('upd3301-promote', JSON.stringify(payload)); } catch { /* box stays empty */ }
    els.aout.textContent = t('📤 IDEへ送った（IDE未起動でも起動時に拾われる）');
  }
  els.bpromasm.onclick = () => promoteToIde(els.asrc.value, parseNum(els.aorg.value), state.lastAsm?.symbols ?? null);
  els.bpromexp.onclick = () => {
    const text = els.exptext.value || doExport();
    if (text) promoteToIde(text, parseNum(els.expo.value) ?? parseNum(els.exps.value), null);
  };
  // …and the way back: the IDE broadcasts build symbols into the label DB
  env.broadcast?.listen?.((msg) => {
    if (msg?.type === 'labels' && Array.isArray(msg.labels)) {
      for (const [a, n] of msg.labels) state.labels.set(a & 0xffff, String(n));
      saveLabels();
      renderAll();
    }
  });

  // --- main loop ---------------------------------------------------------------
  function tick() {
    const m = syncAttach();
    if (m) {
      if (ttOK(m) && !ctrl.paused) { // periodic auto-snapshot while running
        const cur = tl.nodes.get(tl.current);
        if (!cur) takeSnap(m, 0);
        else if (m.frame - cur.frame >= SNAP_EVERY) takeSnap(m, tl.current);
      }
      renderAll();
    }
    env.raf(tick);
  }
  env.raf(tick);

  return { ctrl, state, tl, renderAll, seekFrame, jumpTo, els };
}
