// ide — a small IDE for Z80 projects on the μPD3301 machines. The author's
// workflow, verbatim: "experiment in the ICE; what survives gets promoted to
// the IDE; build there, then debug in the ICE with symbols" — this page is
// the management half of that loop.
//
// - a project IS a real folder (File System Access API) when the browser
//   allows; otherwise an honest virtual project persisted via env.store
// - the editor is a textarea with a highlighted <pre> underlay — zero deps,
//   same as everything in demo/
// - builds run z80asm with the INCLUDE resolver over the project files;
//   errors carry file:line and click through to the source
// - the attribute designer paints μPD3301 attributes on a cell board and
//   keeps the 20-pairs-per-row budget honest (ide-tools.js does the math)
//
// All DOM access goes through `doc`, all platform access through `env`, so
// node can drive the whole page with a shim (see the smoke tests).

import { assemble } from '../z80asm.js';
import { analyze } from '../z80anal.js';
import {
  highlightAsm, makeResolver, findRefs,
  makeAttrGrid, paintAttr, rowBudget,
  gridToDb, gridToVram, gridToTermCode, gridFromModel,
} from './ide-tools.js';
import { textVramModel } from './ice-tools.js';
import { hex, parseNum } from './ice.js';

export const PROMOTE_KEY = 'upd3301-promote'; // ICE→IDE handoff box
export const CHANNEL = 'upd3301-ide';

const ASM_EXT = /\.(z80|asm|inc)$/i;

export function mountIdePage(doc, env) {
  const $ = (id) => doc.getElementById(id);
  const t = env.t ?? ((s) => s);
  const storage = env.storage ?? { get: () => null, set: () => {} };

  const els = {};
  for (const id of ['bopen', 'bvirtual', 'projname', 'ftree', 'newfname', 'bnewfile',
    'curfile', 'bsave', 'edstatus', 'gutter', 'hl', 'ed',
    'symfilter', 'symlist', 'reflist',
    'entrysel', 'bbuild', 'buildout', 'errlist',
    'brunm', 'bsendsym', 'mstatus',
    'board', 'meter', 'dwarn', 'palette', 'dsemi', 'drev', 'dblink', 'dsecret',
    'dupline', 'dlowline', 'dreset', 'selx1', 'sely1', 'selx2', 'sely2', 'bpaint',
    'bimport', 'bwritevram', 'boutdb', 'boutterm', 'outtext',
    'promotebox', 'prominfo', 'promname', 'bpromsave', 'bpromdrop']) {
    els[id] = $(id);
  }

  const state = {
    project: null, // { name, kind, read(p), write(p,t), create(p,t), list() }
    current: null, // open file path
    dirty: false,
    build: null, // last assemble result
    buildFiles: null, // Map used for the last build (for refs)
    grid: makeAttrGrid(80, 25),
    brush: { color: 7 },
    sel: { x1: 0, y1: 0, x2: 9, y2: 0 },
    promote: null, // pending ICE handoff
  };

  // ---- project plumbing -----------------------------------------------------
  function filesMap() {
    const m = new Map();
    if (!state.project) return m;
    for (const p of state.project.list()) m.set(p, state.project.read(p));
    if (state.current && state.project.list().includes(state.current)) {
      m.set(state.current, els.ed.value); // the editor is the truth for the open file
    }
    return m;
  }

  function renderTree() {
    els.ftree.textContent = '';
    if (!state.project) { els.ftree.textContent = t('（プロジェクト未オープン）'); return; }
    const paths = [...state.project.list()].sort((a, b) => {
      const aa = ASM_EXT.test(a) ? 0 : 1, bb = ASM_EXT.test(b) ? 0 : 1;
      return aa - bb || (a < b ? -1 : 1);
    });
    for (const p of paths) {
      const row = doc.createElement('div');
      row.className = 'frow' + (p === state.current ? ' on' : '') + (ASM_EXT.test(p) ? '' : ' dim');
      row.textContent = (p === state.current && state.dirty ? '● ' : '  ') + p;
      row.onclick = () => openFile(p);
      els.ftree.appendChild(row);
    }
    els.projname.textContent = state.project
      ? `${state.project.name} (${state.project.kind === 'fsa' ? t('実フォルダ') : t('仮想（ブラウザ内）')})`
      : '';
    rebuildEntrySel();
  }

  function rebuildEntrySel() {
    els.entrysel.textContent = '';
    if (!state.project) return;
    const saved = storage.get('ide-entry:' + state.project.name);
    for (const p of state.project.list().filter((x) => ASM_EXT.test(x))) {
      const o = doc.createElement('option');
      o.value = p;
      o.textContent = p;
      if (p === saved) o.selected = true;
      els.entrysel.appendChild(o);
    }
    if (saved) els.entrysel.value = saved;
  }

  async function saveCurrent() {
    if (!state.project || !state.current) return;
    await state.project.write(state.current, els.ed.value);
    state.dirty = false;
    els.edstatus.textContent = t('保存した') + ' ✓';
    renderTree();
  }

  async function openFile(path, line = null) {
    if (!state.project) return;
    if (state.current && state.dirty) await saveCurrent(); // auto-save on switch
    state.current = path;
    state.dirty = false;
    els.ed.value = state.project.read(path) ?? '';
    els.curfile.textContent = path;
    renderEditor();
    renderTree();
    if (line != null) gotoLine(line);
  }

  function gotoLine(line) {
    const lines = els.ed.value.split('\n');
    const pos = lines.slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0);
    try {
      els.ed.focus?.();
      els.ed.selectionStart = pos;
      els.ed.selectionEnd = pos + (lines[line - 1]?.length ?? 0);
      const lh = 18; // sync with CSS line-height
      els.ed.scrollTop = Math.max(0, (line - 6) * lh);
    } catch { /* headless shim */ }
    renderEditor();
  }

  async function connectProject(project) {
    state.project = project;
    state.current = null;
    els.ed.value = '';
    els.curfile.textContent = '';
    renderTree();
    const first = project.list().find((p) => ASM_EXT.test(p)) ?? project.list()[0];
    if (first) await openFile(first);
    checkPromoteBox();
  }

  els.bopen.onclick = async () => {
    if (!env.fsa?.supported) {
      els.mstatus.textContent = t('このブラウザはFile System Access API非対応 — 仮想プロジェクトをどうぞ');
      return;
    }
    const project = await env.fsa.pick();
    if (project) await connectProject(project);
  };
  els.bvirtual.onclick = async () => {
    const project = await env.virtual();
    await connectProject(project);
  };
  els.bnewfile.onclick = async () => {
    const name = (els.newfname.value ?? '').trim();
    if (!state.project || !name) return;
    await state.project.create(name, '; ' + name + '\n');
    els.newfname.value = '';
    await openFile(name);
  };
  els.bsave.onclick = () => { saveCurrent(); };

  // ---- editor (textarea + highlighted underlay) --------------------------------
  function renderEditor() {
    const text = els.ed.value;
    const lines = text.split('\n');
    els.hl.innerHTML = lines.map(highlightAsm).join('\n') + '\n';
    els.gutter.textContent = lines.map((_, i) => String(i + 1).padStart(4)).join('\n');
    els.edstatus.textContent = `${lines.length} ${t('行')}${state.dirty ? '  ●' : ''}`;
  }
  els.ed.oninput = () => {
    state.dirty = true;
    renderEditor();
  };
  els.ed.onscroll = () => {
    try {
      els.hl.parentElement.scrollTop = els.ed.scrollTop;
      els.hl.parentElement.scrollLeft = els.ed.scrollLeft;
      els.gutter.style.transform = `translateY(${-els.ed.scrollTop}px)`;
    } catch { /* shim */ }
  };
  els.ed.onkeydown = (e) => {
    if (e.key === 'Tab') { // insert spaces, don't leave the editor
      e.preventDefault?.();
      const s = els.ed.selectionStart ?? els.ed.value.length;
      els.ed.value = els.ed.value.slice(0, s) + '        '.slice(0, 8 - (colOf(s) % 8)) + els.ed.value.slice(els.ed.selectionEnd ?? s);
      els.ed.selectionStart = els.ed.selectionEnd = s + (8 - (colOf(s) % 8));
      state.dirty = true;
      renderEditor();
    } else if (e.key === 'F12') {
      e.preventDefault?.();
      jumpToDefinitionAtCursor();
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault?.();
      saveCurrent();
    }
  };
  els.ed.onclick = (e) => {
    if (e?.ctrlKey || e?.metaKey) jumpToDefinitionAtCursor();
  };
  const colOf = (pos) => {
    const nl = els.ed.value.lastIndexOf('\n', pos - 1);
    return pos - nl - 1;
  };

  function tokenAtCursor() {
    const text = els.ed.value;
    const pos = els.ed.selectionStart ?? 0;
    let a = pos, b = pos;
    const ok = (ch) => /[A-Za-z0-9_~.?@]/.test(ch ?? '');
    while (a > 0 && ok(text[a - 1])) a--;
    while (b < text.length && ok(text[b])) b++;
    return a < b ? text.slice(a, b) : null;
  }

  // ---- build / navigation --------------------------------------------------------
  function buildProject() {
    if (!state.project) return null;
    const files = filesMap();
    const entry = els.entrysel.value || state.current;
    if (!entry || !files.has(entry)) {
      els.buildout.textContent = t('エントリファイルがない');
      return null;
    }
    storage.set('ide-entry:' + (state.project?.name ?? ''), entry);
    const resolver = makeResolver(files);
    resolver.include(entry); // enter the entry file (makes its includes relative)
    const orgv = parseNum(storage.get('ide-org') ?? '') ?? 0x9000;
    const res = assemble(files.get(entry), { org: orgv, include: resolver.include });
    res.entry = entry;
    state.build = res;
    state.buildFiles = files;
    renderBuild(res, entry);
    renderSymbols();
    return res;
  }
  els.bbuild.onclick = () => { buildProject(); };

  function renderBuild(res, entry) {
    els.errlist.textContent = '';
    if (res.errors.length) {
      els.buildout.textContent = `✗ ${res.errors.length} ${t('エラー')}`;
      for (const e of res.errors) {
        const row = doc.createElement('div');
        row.className = 'erow';
        row.textContent = `${e.file ?? entry}:${e.line}  ${e.message}`;
        row.onclick = () => openFile(e.file ?? entry, e.line);
        els.errlist.appendChild(row);
      }
      return;
    }
    let msg = `✓ ${res.bytes.length} bytes @ ${hex(res.org, 4)}h  (${Object.keys(res.symbols).length} symbols)`;
    if (res.warnings.length) msg += `  ⚠${res.warnings.length}`;
    els.buildout.textContent = msg;
  }

  function renderSymbols() {
    els.symlist.textContent = '';
    const res = state.build;
    if (!res) { els.symlist.textContent = t('（まずビルド）'); return; }
    const q = (els.symfilter.value ?? '').trim().toUpperCase();
    const names = Object.keys(res.symbols)
      .filter((n) => !n.includes('~') && (!q || n.includes(q)))
      .sort();
    for (const n of names.slice(0, 400)) {
      const row = doc.createElement('div');
      row.className = 'srow';
      const d = res.defs?.[n];
      row.textContent = `${n.padEnd(18)} ${hex(res.symbols[n] & 0xffff, 4)}  ${d ? `${d.file ?? res.entry}:${d.line}` : ''}`;
      row.onclick = () => { if (d) openFile(d.file ?? res.entry, d.line); };
      row.oncontextmenu = (e) => { e?.preventDefault?.(); showRefs(n); };
      els.symlist.appendChild(row);
    }
  }
  els.symfilter.oninput = () => renderSymbols();

  function jumpToDefinitionAtCursor() {
    const tok = tokenAtCursor();
    if (!tok) return;
    if (!state.build) buildProject();
    const d = state.build?.defs?.[tok.toUpperCase()];
    if (d) openFile(d.file ?? state.build.entry, d.line);
    else els.edstatus.textContent = t('定義が見つからない') + `: ${tok}`;
  }

  function showRefs(name) {
    els.reflist.textContent = '';
    const files = state.buildFiles ?? filesMap();
    const refs = findRefs(files, name);
    const head = doc.createElement('div');
    head.className = 'srow head';
    head.textContent = `${t('参照元')}: ${name} (${refs.length})`;
    els.reflist.appendChild(head);
    for (const r of refs.slice(0, 100)) {
      const row = doc.createElement('div');
      row.className = 'srow';
      row.textContent = `${r.file}:${r.line}  ${r.text}`;
      row.onclick = () => openFile(r.file, r.line);
      els.reflist.appendChild(row);
    }
  }

  // ---- machine / ICE handoff ------------------------------------------------------
  const machineWrite = (m) => (typeof m.writeMem === 'function'
    ? (a, v) => m.writeMem(a & 0xffff, v & 0xff)
    : (a, v) => { if (m.sys?.memory) m.sys.memory[a & 0xffff] = v & 0xff; });

  els.brunm.onclick = () => {
    const res = state.build ?? buildProject();
    if (!res || res.errors.length) return;
    const m = env.getMachine?.();
    if (!m) { els.mstatus.textContent = t('実機がいない — machine.htmlから開くと繋がる'); return; }
    const w = machineWrite(m);
    for (let i = 0; i < res.bytes.length; i++) w(res.org + i, res.bytes[i]);
    m.cpu.pc = res.org & 0xffff;
    els.mstatus.textContent = `▶ ${res.bytes.length} bytes → ${hex(res.org, 4)}h, PC=${hex(res.org, 4)}h`;
  };
  els.bsendsym.onclick = () => {
    const res = state.build ?? buildProject();
    if (!res) return;
    const labels = Object.entries(res.symbols)
      .filter(([n, v]) => typeof v === 'number' && !n.includes('~') && !n.includes('.'))
      .map(([n, v]) => [v & 0xffff, n]);
    env.broadcast?.send({ type: 'labels', labels });
    els.mstatus.textContent = `🔬 ${labels.length} ${t('シンボルをICEへ送った')}`;
  };

  // ---- ICE → IDE promotion (the workflow glue) -------------------------------------
  function offerPromotion(payload) {
    state.promote = payload;
    els.promotebox.style.display = '';
    els.prominfo.textContent = `${t('ICEからの持ち込み')}: ${payload.source.split('\n').length} ${t('行')}`
      + (payload.org != null ? `  ORG ${hex(payload.org, 4)}h` : '');
    if (!els.promname.value) els.promname.value = 'from-ice.z80';
  }
  function checkPromoteBox() {
    try {
      const raw = storage.get(PROMOTE_KEY);
      if (raw) offerPromotion(JSON.parse(raw));
    } catch { /* stale box */ }
  }
  els.bpromsave.onclick = async () => {
    if (!state.promote || !state.project) return;
    const name = (els.promname.value ?? 'from-ice.z80').trim();
    await state.project.create(name, state.promote.source);
    storage.set(PROMOTE_KEY, '');
    els.promotebox.style.display = 'none';
    state.promote = null;
    await openFile(name);
  };
  els.bpromdrop.onclick = () => {
    storage.set(PROMOTE_KEY, '');
    els.promotebox.style.display = 'none';
    state.promote = null;
  };
  env.broadcast?.listen((msg) => {
    if (msg?.type === 'promote') offerPromotion(msg);
  });

  // ---- attribute designer -----------------------------------------------------------
  const PALETTE_NAMES = ['黒', '青', '赤', '紫', '緑', '水', '黄', '白'];
  const PALETTE_RGB = ['#000', '#00f', '#f00', '#f0f', '#0f0', '#0ff', '#ff0', '#fff'];
  for (let cIdx = 0; cIdx < 8; cIdx++) {
    const b = doc.createElement('button');
    b.className = 'pal' + (cIdx === state.brush.color ? ' on' : '');
    b.textContent = String(cIdx);
    b.style.background = PALETTE_RGB[cIdx];
    b.style.color = cIdx >= 6 || cIdx === 4 || cIdx === 5 ? '#000' : '#fff';
    b.title = PALETTE_NAMES[cIdx];
    b.onclick = () => {
      state.brush.color = cIdx;
      for (let k = 0; k < els.palette.children.length; k++) {
        els.palette.children[k].className = 'pal' + (k === cIdx ? ' on' : '');
      }
    };
    els.palette.appendChild(b);
  }

  function brushPatch() {
    const p = {};
    if (els.dreset.checked) { p.resetColor = true; p.resetFunc = true; }
    else {
      p.color = state.brush.color;
      if (els.dsemi.checked) p.semi = true;
      if (els.drev.checked) p.reverse = true;
      if (els.dblink.checked) p.blink = true;
      if (els.dsecret.checked) p.secret = true;
      if (els.dupline.checked) p.upline = true;
      if (els.dlowline.checked) p.lowline = true;
    }
    return p;
  }

  function applyPaint(x1, y1, x2, y2) {
    paintAttr(state.grid, x1, y1, x2, y2, brushPatch());
    renderDesigner();
  }
  els.bpaint.onclick = () => {
    const v = (el, d) => parseNum(String(el.value)) ?? d;
    applyPaint(v(els.selx1, 0), v(els.sely1, 0), v(els.selx2, 0), v(els.sely2, 0));
  };

  // canvas board (browser only — the shim path paints through the inputs)
  const CW = 9, CH = 14;
  let dragging = null;
  function boardCtx() {
    try { return els.board.getContext?.('2d') ?? null; } catch { return null; }
  }
  function renderBoard() {
    const ctx = boardCtx();
    if (!ctx) return;
    const g = state.grid;
    els.board.width = g.cols * CW;
    els.board.height = g.rows * CH;
    for (let y = 0; y < g.rows; y++) {
      for (let x = 0; x < g.cols; x++) {
        const i = y * g.cols + x;
        const cv = g.color[i], fv = g.func[i];
        const color = (cv >> 5) & 7;
        ctx.fillStyle = fv & 0x04 ? '#ccc' : PALETTE_RGB[color]; // reverse → light
        ctx.fillRect(x * CW, y * CH, CW - 1, CH - 1);
        if (fv & 0x02) { ctx.fillStyle = '#f80'; ctx.fillRect(x * CW + 2, y * CH + 2, 3, 3); } // blink dot
        if (fv & 0x01) { ctx.fillStyle = '#222'; ctx.fillRect(x * CW, y * CH + 5, CW - 1, 3); } // secret
        if (fv & 0x10) { ctx.fillStyle = '#fff'; ctx.fillRect(x * CW, y * CH, CW - 1, 1); } // upline
        if (fv & 0x20) { ctx.fillStyle = '#fff'; ctx.fillRect(x * CW, y * CH + CH - 2, CW - 1, 1); } // lowline
        if (cv & 0x10) { ctx.fillStyle = '#888'; ctx.fillRect(x * CW + CW - 3, y * CH, 2, 2); } // semi flag
      }
    }
    if (dragging) {
      ctx.strokeStyle = '#8fd';
      const [xa, xb] = [Math.min(dragging.x1, dragging.x2), Math.max(dragging.x1, dragging.x2)];
      const [ya, yb] = [Math.min(dragging.y1, dragging.y2), Math.max(dragging.y1, dragging.y2)];
      ctx.strokeRect(xa * CW - 0.5, ya * CH - 0.5, (xb - xa + 1) * CW, (yb - ya + 1) * CH);
    }
  }
  const cellOf = (e) => ({
    x: Math.max(0, Math.min(state.grid.cols - 1, Math.floor((e.offsetX ?? 0) / CW))),
    y: Math.max(0, Math.min(state.grid.rows - 1, Math.floor((e.offsetY ?? 0) / CH))),
  });
  els.board.onmousedown = (e) => {
    const c = cellOf(e);
    dragging = { x1: c.x, y1: c.y, x2: c.x, y2: c.y };
    renderBoard();
  };
  els.board.onmousemove = (e) => {
    if (!dragging) return;
    const c = cellOf(e);
    dragging.x2 = c.x;
    dragging.y2 = c.y;
    renderBoard();
  };
  els.board.onmouseup = () => {
    if (!dragging) return;
    els.selx1.value = String(Math.min(dragging.x1, dragging.x2));
    els.sely1.value = String(Math.min(dragging.y1, dragging.y2));
    els.selx2.value = String(Math.max(dragging.x1, dragging.x2));
    els.sely2.value = String(Math.max(dragging.y1, dragging.y2));
    applyPaint(dragging.x1, dragging.y1, dragging.x2, dragging.y2);
    dragging = null;
  };

  function renderMeter() {
    const g = state.grid;
    const lines = [];
    let overs = 0;
    for (let y = 0; y < g.rows; y++) {
      const b = rowBudget(g, y);
      if (b.over) overs++;
      const bar = '█'.repeat(Math.min(20, b.count)) + (b.count > 20 ? '!' .repeat(b.count - 20) : '');
      lines.push(`${String(y).padStart(2)} ${String(b.count).padStart(2)}/20 ${b.over ? '⚠' : ' '} ${bar}`);
    }
    els.meter.textContent = lines.join('\n');
    els.dwarn.textContent = overs
      ? `⚠ ${overs} ${t('行が20ペア超過 — 実機では溢れる（EXモードならセル毎で制限なし）')}`
      : t('全行が20ペア以内 — 実機OK');
    els.dwarn.className = overs ? 'dwarn over' : 'dwarn';
  }
  function renderDesigner() { renderBoard(); renderMeter(); }

  els.boutdb.onclick = () => { els.outtext.value = gridToDb(state.grid); };
  els.boutterm.onclick = () => { els.outtext.value = gridToTermCode(state.grid); };
  els.bwritevram.onclick = () => {
    const m = env.getMachine?.();
    if (!m) { els.mstatus.textContent = t('実機がいない — machine.htmlから開くと繋がる'); return; }
    const w = machineWrite(m);
    for (const row of gridToVram(state.grid)) {
      for (let i = 0; i < row.bytes.length; i++) w(row.addr + i, row.bytes[i]);
    }
    els.mstatus.textContent = t('アトリビュートを実機VRAMへ書いた');
  };
  els.bimport.onclick = () => {
    const m = env.getMachine?.();
    if (!m) { els.mstatus.textContent = t('実機がいない — machine.htmlから開くと繋がる'); return; }
    let model = null;
    try { model = textVramModel(m); } catch { model = null; }
    const grid = model && gridFromModel(model);
    if (!grid) { els.mstatus.textContent = t('画面を読めなかった'); return; }
    state.grid = grid;
    renderDesigner();
    els.mstatus.textContent = t('実機の現画面を取り込んだ — ここから編集できる');
  };

  // ---- boot ------------------------------------------------------------------------
  renderTree();
  renderEditor();
  renderDesigner();
  checkPromoteBox();
  void analyze; // reserved: per-routine analysis view is ICE's job for now

  return { state, els, buildProject, openFile, renderDesigner, showRefs, offerPromotion };
}
