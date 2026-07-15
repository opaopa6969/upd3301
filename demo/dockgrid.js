// dockgrid.js — tmux-style tiling for panel-heavy pages (the debugger/IDE views).
//
// Panels live in vertical COLUMNS. Drag a panel by its header to move it within a
// column or into another column, at any vertical spot; drag a column's gutter to
// rebalance widths; drag a panel's bottom edge to set its height; and ⧉ pops a
// panel into its own window (closing it returns it to its spot). This is what
// flex-wrap couldn't do: put a tall panel in one column and stack several short
// ones beside it. The whole layout (columns, widths, panel order, heights)
// persists per storageKey. Dependency-free.

let styled = false;
function injectStyle() {
  if (styled) return; styled = true;
  const s = document.createElement('style');
  s.textContent = `
  .dock-grid { display:flex; align-items:stretch; gap:0; }
  .dock-col { display:flex; flex-direction:column; gap:8px; min-width:220px; }
  .dock-gutter { flex:0 0 10px; cursor:col-resize; align-self:stretch; position:relative; }
  .dock-gutter::before { content:''; position:absolute; left:4px; top:0; bottom:0; width:2px; background:#2a2a38; border-radius:1px; }
  .dock-gutter:hover::before { background:#4a8; }
  .dock-panel { overflow:auto; resize:vertical; box-sizing:border-box; }
  .dock-panel > h2 { cursor:grab; position:sticky; top:0; background:inherit; z-index:1; }
  .dock-panel > h2::before { content:'⠿ '; color:#556; }
  .dock-panel.dragging { opacity:.45; outline:1px dashed #4a8; }
  .dock-panel.dropbefore-v { box-shadow:0 -3px 0 #4a8; }
  .dock-col.dropend > :last-child { box-shadow:0 3px 0 #4a8; }
  `;
  document.head.appendChild(s);
}

export function makeTiling(grid, { storageKey = 'tiling', panelSel = '.panel', handleSel = 'h2', cols = 3 } = {}) {
  if (!grid) return;
  injectStyle();
  const lsGet = (k, d) => { try { const v = localStorage.getItem(storageKey + k); return v == null ? JSON.parse(d) : JSON.parse(v); } catch { return JSON.parse(d); } };
  const lsSet = (k, v) => { try { localStorage.setItem(storageKey + k, JSON.stringify(v)); } catch {} };

  const allPanels = [...grid.querySelectorAll(panelSel)];
  const keyOf = (p) => p.dataset.dockkey || (p.dataset.dockkey = (p.querySelector('h2')?.textContent || p.id || 'p').trim().slice(0, 40));
  const byKey = new Map(allPanels.map((p) => [keyOf(p), p]));
  allPanels.forEach((p) => p.classList.add('dock-panel'));

  // heights per key
  const heights = lsGet('-h', '{}');
  const saveHeights = () => lsSet('-h', heights);

  // ---- pop-out (detach a panel into its own window) --------------------------
  const popupDocs = globalThis.__dockPopupDocs || (globalThis.__dockPopupDocs = new Set());
  globalThis.__dockFindEl = (id) => { for (const d of popupDocs) { const e = d.getElementById(id); if (e) return e; } return null; };
  function popOut(p) {
    const w = window.open('', '', 'width=520,height=460'); if (!w) return;
    const d = w.document;
    d.title = p.querySelector('h2')?.textContent || 'panel';
    d.body.style.cssText = 'margin:0;padding:8px;background:#101014;color:#ccd;font-family:ui-monospace,monospace;box-sizing:border-box';
    for (const st of document.querySelectorAll('style')) d.head.appendChild(st.cloneNode(true));
    const ph = document.createComment('popout'); p.parentNode.insertBefore(ph, p);
    const saved = p.style.cssText; p.draggable = false;
    p.style.cssText = 'height:calc(100vh - 16px);width:100%;box-sizing:border-box;overflow:auto;resize:none;margin:0';
    d.body.appendChild(p); popupDocs.add(d);
    let done = false;
    const back = () => { if (done) return; done = true; popupDocs.delete(d); p.style.cssText = saved; if (ph.parentNode) { ph.parentNode.insertBefore(p, ph); ph.remove(); } saveLayout(); try { if (!w.closed) w.close(); } catch {} };
    const iv = setInterval(() => { if (w.closed) { clearInterval(iv); back(); } }, 400);
    try { w.addEventListener('pagehide', back, { once: true }); } catch {}
  }

  // ---- drag state ------------------------------------------------------------
  let dragged = null;
  const clearMarks = () => { grid.querySelectorAll('.dropbefore-v').forEach((e) => e.classList.remove('dropbefore-v')); grid.querySelectorAll('.dock-col.dropend').forEach((e) => e.classList.remove('dropend')); };

  function setupPanel(p) {
    const k = keyOf(p);
    if (heights[k]) p.style.height = heights[k] + 'px';
    // pop-out button
    if (!p.querySelector('.dock-pop')) {
      p.style.position = p.style.position || 'relative';
      const pop = document.createElement('button'); pop.className = 'dock-pop'; pop.textContent = '⧉';
      pop.title = '別ウィンドウに切り離す（閉じると戻る）';
      pop.style.cssText = 'position:absolute;top:5px;right:6px;z-index:2;padding:0 6px;font-size:12px';
      pop.addEventListener('mousedown', (e) => e.stopPropagation());
      pop.addEventListener('click', (e) => { e.stopPropagation(); popOut(p); });
      p.appendChild(pop);
    }
    const handle = p.querySelector(handleSel) || p;
    handle.addEventListener('mousedown', () => { p.draggable = true; });
    handle.addEventListener('mouseup', () => { p.draggable = false; });
    p.addEventListener('dragstart', (e) => { dragged = p; p.classList.add('dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', k); } catch {} });
    p.addEventListener('dragend', () => { p.draggable = false; p.classList.remove('dragging'); clearMarks(); dragged = null; });
    if (window.ResizeObserver) new ResizeObserver(() => { if (p.style.height) { heights[k] = Math.round(p.getBoundingClientRect().height); saveHeights(); } }).observe(p);
  }

  function setupCol(colEl) {
    colEl.addEventListener('dragover', (e) => {
      if (!dragged) return; e.preventDefault();
      clearMarks();
      const ps = [...colEl.querySelectorAll(':scope > .dock-panel')];
      const before = ps.find((p) => p !== dragged && e.clientY < p.getBoundingClientRect().top + p.offsetHeight / 2);
      if (before) { before.classList.add('dropbefore-v'); colEl._dropRef = before; }
      else { colEl.classList.add('dropend'); colEl._dropRef = null; }
    });
    colEl.addEventListener('drop', (e) => {
      if (!dragged) return; e.preventDefault();
      colEl.insertBefore(dragged, colEl._dropRef || null); // null → append to end
      clearMarks(); saveLayout();
    });
  }

  // gutter drag → rebalance the two columns it sits between
  function makeGutter(leftCol, rightCol) {
    const g = document.createElement('div'); g.className = 'dock-gutter';
    let startX, lw, rw;
    g.addEventListener('pointerdown', (e) => { startX = e.clientX; lw = leftCol.getBoundingClientRect().width; rw = rightCol.getBoundingClientRect().width; g.setPointerCapture(e.pointerId); e.preventDefault(); });
    g.addEventListener('pointermove', (e) => {
      if (startX == null) return;
      const dx = e.clientX - startX;
      const nl = Math.max(200, lw + dx), nr = Math.max(200, rw - dx);
      leftCol.style.flex = `0 0 ${nl}px`; rightCol.style.flex = `0 0 ${nr}px`;
    });
    g.addEventListener('pointerup', (e) => { startX = null; try { g.releasePointerCapture(e.pointerId); } catch {} saveLayout(); });
    return g;
  }

  function saveLayout() {
    const colsData = [...grid.querySelectorAll(':scope > .dock-col')].map((c) => ({
      w: Math.round(c.getBoundingClientRect().width),
      keys: [...c.querySelectorAll(':scope > .dock-panel')].map(keyOf),
    }));
    lsSet('-cols', colsData);
  }

  // ---- build -----------------------------------------------------------------
  grid.classList.add('dock-grid');
  let layout = lsGet('-cols', 'null');
  const known = new Set(allPanels.map(keyOf));
  if (!Array.isArray(layout) || !layout.length) {
    // default: distribute panels across `cols` columns as evenly as possible
    const n = Math.max(1, cols), per = Math.ceil(allPanels.length / n);
    layout = []; for (let i = 0; i < n; i++) layout.push({ w: 0, keys: allPanels.slice(i * per, (i + 1) * per).map(keyOf) });
  }
  // ensure every panel appears exactly once (append newcomers to the last column)
  const placed = new Set(layout.flatMap((c) => c.keys).filter((k) => known.has(k)));
  const missing = [...known].filter((k) => !placed.has(k));
  if (missing.length) layout[layout.length - 1].keys.push(...missing);

  grid.textContent = '';
  const colEls = [];
  layout.forEach((col, ci) => {
    const colEl = document.createElement('div'); colEl.className = 'dock-col';
    if (col.w) colEl.style.flex = `0 0 ${col.w}px`; else colEl.style.flex = '1 1 0';
    for (const k of col.keys) { const p = byKey.get(k); if (p) { colEl.appendChild(p); setupPanel(p); } }
    setupCol(colEl);
    if (ci) grid.appendChild(makeGutter(colEls[colEls.length - 1], colEl));
    grid.appendChild(colEl); colEls.push(colEl);
  });

  return {
    reset() { lsSet('-cols', null); lsSet('-h', {}); location.reload(); },
    save: saveLayout,
  };
}

// Back-compat alias: pages that called makeDockable get the tiling layout.
export const makeDockable = makeTiling;
