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
  .dock-panel.dropbefore { box-shadow:-3px 0 0 #4a8; }
  .dock-panel.dropafter  { box-shadow: 3px 0 0 #4a8; }
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
  const clearMarks = () => { for (const p of panels()) p.classList.remove('dropbefore', 'dropafter'); };

  for (const p of panels()) {
    p.classList.add('dock-panel');
    const k = keyOf(p);
    if (heights[k]) p.style.height = heights[k] + 'px';
    const handle = p.querySelector(handleSel) || p;
    // only let a drag START from the header (so text selection in the body works)
    handle.addEventListener('mousedown', () => { p.draggable = true; });
    handle.addEventListener('mouseup', () => { p.draggable = false; });
    p.addEventListener('dragstart', (e) => { dragged = p; p.classList.add('dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', k); } catch {} });
    p.addEventListener('dragend', () => { p.draggable = false; p.classList.remove('dragging'); clearMarks(); dragged = null; });
    p.addEventListener('dragover', (e) => {
      if (!dragged || dragged === p) return; e.preventDefault();
      const r = p.getBoundingClientRect();
      const before = (e.clientX - r.left) < r.width / 2;
      clearMarks(); p.classList.add(before ? 'dropbefore' : 'dropafter');
    });
    p.addEventListener('drop', (e) => {
      if (!dragged || dragged === p) return; e.preventDefault();
      const before = p.classList.contains('dropbefore');
      grid.insertBefore(dragged, before ? p : p.nextSibling);
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
