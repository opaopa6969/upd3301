// dockgrid.js — turn a grid of .panel boxes into a rearrangeable, resizable
// workspace (for the debugger-style pages that have many panels). Drag a panel by
// its HEADER to reorder it; drag a panel's bottom edge (native resize handle) to
// set its height. Order and heights persist per storageKey. Dependency-free —
// HTML5 drag-and-drop + CSS `resize` — so it drops into any page.

let styled = false;
function injectStyle() {
  if (styled) return; styled = true;
  const s = document.createElement('style');
  s.textContent = `
  /* FIXED height + internal scroll: a panel whose content grows (call stack,
     trace…) scrolls inside itself instead of getting taller and shoving its
     neighbours around. Drag the bottom edge to resize; the height is remembered. */
  .dock-panel { height: 240px; overflow: auto; resize: vertical; }
  .dock-panel > h2 { cursor: grab; position: sticky; top: 0; background: inherit; z-index: 1; }
  .dock-panel > h2::before { content: '⠿ '; color:#556; }
  .dock-panel.dragging { opacity:.45; outline:1px dashed #4a8; }
  .dock-panel.dropinto { outline:2px solid #4a8; outline-offset:-2px; }
  `;
  document.head.appendChild(s);
}

export function makeDockable(grid, { storageKey = 'dockgrid', panelSel = '.panel', handleSel = 'h2' } = {}) {
  if (!grid) return;
  injectStyle();
  const panels = () => [...grid.querySelectorAll(panelSel)];
  const keyOf = (p) => p.dataset.dockkey || (p.dataset.dockkey = (p.querySelector('h2')?.textContent || p.id || 'p').trim().slice(0, 40));
  const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(storageKey + k) || d); } catch { return JSON.parse(d); } };
  const lsSet = (k, v) => { try { localStorage.setItem(storageKey + k, JSON.stringify(v)); } catch {} };

  // flatten: pull every panel up to be a DIRECT child of the grid (dissolving any
  // display:contents column wrappers) so reordering via insertBefore is valid and
  // every panel is a real grid item.
  for (const p of panels()) grid.appendChild(p);

  // restore saved order
  const order = lsGet('-order', 'null');
  if (Array.isArray(order)) {
    const byKey = new Map(panels().map((p) => [keyOf(p), p]));
    for (const k of order) { const p = byKey.get(k); if (p) grid.appendChild(p); } // append in saved sequence
  }
  const saveOrder = () => lsSet('-order', panels().map(keyOf));
  const heights = lsGet('-h', '{}');
  const saveHeights = () => lsSet('-h', heights);

  let dragged = null;
  const clearMarks = () => { for (const p of panels()) p.classList.remove('dropinto'); };
  // swap two panels' positions (predictable 2-D exchange — no cascade reflow)
  function swapNodes(a, b) {
    if (a === b) return;
    const tmp = document.createComment('');
    a.parentNode.insertBefore(tmp, a);
    b.parentNode.insertBefore(a, b);
    tmp.parentNode.insertBefore(b, tmp);
    tmp.remove();
  }

  // ---- pop-out: detach a panel into its own window; closing it returns it -----
  // The panel NODE moves into the popup (its live updates keep working because the
  // page's element lookups also search these popup documents — see __dockFindEl).
  const popupDocs = globalThis.__dockPopupDocs || (globalThis.__dockPopupDocs = new Set());
  globalThis.__dockFindEl = (id) => { for (const d of popupDocs) { const e = d.getElementById(id); if (e) return e; } return null; };
  function popOut(p) {
    const w = window.open('', '', 'width=520,height=460');
    if (!w) return;
    const d = w.document;
    d.title = (p.querySelector('h2')?.textContent || 'panel');
    d.body.style.cssText = 'margin:0;padding:8px;background:#101014;color:#ccd;font-family:ui-monospace,monospace;box-sizing:border-box';
    for (const st of document.querySelectorAll('style')) d.head.appendChild(st.cloneNode(true));
    const ph = document.createComment('dock-popout');
    p.parentNode.insertBefore(ph, p);
    const savedCss = p.style.cssText, savedDraggable = p.draggable;
    p.draggable = false;
    p.style.cssText = 'height:calc(100vh - 16px);width:100%;box-sizing:border-box;overflow:auto;resize:none;margin:0';
    d.body.appendChild(p); // adopts the node into the popup document
    popupDocs.add(d);
    let done = false;
    const back = () => {
      if (done) return; done = true;
      popupDocs.delete(d);
      p.style.cssText = savedCss; p.draggable = savedDraggable;
      if (ph.parentNode) { ph.parentNode.insertBefore(p, ph); ph.remove(); } else grid.appendChild(p);
      try { if (!w.closed) w.close(); } catch {}
    };
    const iv = setInterval(() => { if (w.closed) { clearInterval(iv); back(); } }, 400);
    try { w.addEventListener('pagehide', back, { once: true }); } catch {}
  }

  for (const p of panels()) {
    p.classList.add('dock-panel');
    const k = keyOf(p);
    if (heights[k]) p.style.height = heights[k] + 'px';
    // pop-out button (top-right; not on the drag handle so it can't start a drag)
    p.style.position = p.style.position || 'relative';
    const pop = document.createElement('button');
    pop.textContent = '⧉'; pop.title = '別ウィンドウに切り離す（閉じると元に戻る）';
    pop.style.cssText = 'position:absolute;top:5px;right:6px;z-index:2;padding:0 6px;font-size:12px;line-height:1.6';
    pop.addEventListener('mousedown', (e) => e.stopPropagation());
    pop.addEventListener('click', (e) => { e.stopPropagation(); popOut(p); });
    p.appendChild(pop);
    const handle = p.querySelector(handleSel) || p;
    // only let a drag START from the header (so text selection in the body works)
    handle.addEventListener('mousedown', () => { p.draggable = true; });
    handle.addEventListener('mouseup', () => { p.draggable = false; });
    p.addEventListener('dragstart', (e) => { dragged = p; p.classList.add('dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', k); } catch {} });
    p.addEventListener('dragend', () => { p.draggable = false; p.classList.remove('dragging'); clearMarks(); dragged = null; });
    p.addEventListener('dragover', (e) => {
      if (!dragged || dragged === p) return; e.preventDefault();
      clearMarks(); p.classList.add('dropinto'); // whole target highlights → they'll swap
    });
    p.addEventListener('drop', (e) => {
      if (!dragged || dragged === p) return; e.preventDefault();
      swapNodes(dragged, p); // exchange the two panels' spots
      clearMarks(); saveOrder();
    });
    if (window.ResizeObserver) {
      new ResizeObserver(() => { if (p.style.height) { heights[k] = Math.round(parseFloat(p.style.height)); saveHeights(); } }).observe(p);
    }
  }
  return {
    reset() { lsSet('-order', null); lsSet('-h', {}); for (const p of panels()) p.style.height = ''; },
  };
}
