// menubar.js — a top menu bar + pinnable dock, shared by the demo pages.
//
// The problem it solves: every demo grew its controls "五月雨式" into ever-taller
// rows of buttons until the screen was buried. This groups them: rarely-touched
// controls (file pickers, DIP switches, ROM/BIOS) live in DROPDOWN MENUS that are
// hidden until you open them; the handful you actually reach for mid-play get
// PINNED to a DOCK that stays visible. Any item can be pinned/unpinned with its ☆,
// and the choice persists per page.
//
// Usage: build your control elements as usual (keep their ids/handlers), then hand
// them to mountMenuBar as { menus:[{label,items:[{id,label,el}]}], dock:[ids] }.
// The component RELOCATES those elements into menus/dock — wiring is untouched.

let styled = false;
function injectStyle() {
  if (styled) return; styled = true;
  const css = `
  .mbar { display:flex; flex-wrap:wrap; align-items:center; gap:4px; background:#16161d; border:1px solid #2a2a38; border-radius:8px; padding:4px 6px; position:relative; z-index:20; }
  .mbar-brand { color:#8fd; font-weight:bold; font-size:13px; padding:0 8px 0 4px; }
  .mbar-btn { background:transparent; color:#bcd; border:1px solid transparent; border-radius:5px; padding:5px 12px; cursor:pointer; font:inherit; font-size:13px; }
  .mbar-btn:hover { background:#22222e; }
  .mbar-btn.open { background:#26314a; border-color:#3a4a6a; color:#def; }
  .mbar-menu { position:absolute; top:100%; margin-top:4px; min-width:230px; max-width:min(92vw,420px); background:#191922; border:1px solid #3a3a4c; border-radius:8px; box-shadow:0 8px 26px #000a; padding:6px; z-index:30; display:none; max-height:70vh; overflow:auto; }
  .mbar-menu.open { display:block; }
  .mbar-item { display:flex; align-items:center; gap:8px; padding:5px 4px; border-radius:5px; }
  .mbar-item:hover { background:#20202b; }
  .mbar-item + .mbar-item { border-top:1px solid #23232f; }
  .mbar-pin { background:transparent; border:none; color:#566; cursor:pointer; font-size:14px; width:22px; flex:none; padding:2px; border-radius:4px; }
  .mbar-pin.on { color:#fd6; }
  .mbar-pin:hover { background:#2a2a38; }
  .mbar-ilabel { color:#9ab; font-size:12px; flex:none; min-width:74px; }
  .mbar-slot { display:flex; align-items:center; gap:6px; flex-wrap:wrap; flex:1; }
  .mbar-slot .mbar-athome { color:#566; font-size:11px; }
  .dock { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; background:#101017; border:1px solid #23232f; border-radius:8px; padding:6px 8px; margin-top:6px; min-height:20px; }
  .dock:empty { display:none; }
  .dock-item { display:inline-flex; align-items:center; gap:5px; }
  .dock-item .mbar-ilabel { min-width:0; }
  `;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
}

export function mountMenuBar(container, spec) {
  injectStyle();
  const { storageKey = 'menubar', brand = '', menus = [] } = spec;
  const load = () => { try { return new Set(JSON.parse(localStorage.getItem(storageKey + '-pins') || '[]')); } catch { return new Set(); } };
  const pins = load();
  // seed default pins on first run (no stored key yet)
  if (localStorage.getItem(storageKey + '-pins') == null) {
    for (const m of menus) for (const it of m.items) if (it.pin) pins.add(it.id);
  }
  const save = () => { try { localStorage.setItem(storageKey + '-pins', JSON.stringify([...pins])); } catch {} };

  const bar = document.createElement('div'); bar.className = 'mbar';
  if (brand) { const b = document.createElement('span'); b.className = 'mbar-brand'; b.textContent = brand; bar.appendChild(b); }
  const dock = document.createElement('div'); dock.className = 'dock';

  const allItems = new Map(); // id → { it, slot, dockSlot, pinBtn }
  const panels = [];

  function place(id) {
    const rec = allItems.get(id); if (!rec) return;
    const pinned = pins.has(id);
    rec.pinBtn.classList.toggle('on', pinned);
    rec.pinBtn.textContent = pinned ? '★' : '☆';
    rec.pinBtn.title = pinned ? 'dockから外す' : 'dockに常設';
    if (pinned) { rec.dockSlot.appendChild(rec.it.el); rec.slot.querySelector('.mbar-athome').style.display = ''; }
    else { rec.slot.insertBefore(rec.it.el, rec.slot.querySelector('.mbar-athome')); rec.slot.querySelector('.mbar-athome').style.display = 'none'; }
    dock.querySelectorAll('.dock-item').forEach((d) => { if (!d.querySelector('*:not(.mbar-ilabel)')) {} });
  }

  for (const m of menus) {
    const btn = document.createElement('button'); btn.className = 'mbar-btn'; btn.textContent = m.label; bar.appendChild(btn);
    const panel = document.createElement('div'); panel.className = 'mbar-menu'; bar.appendChild(panel);
    btn._panel = panel; panels.push({ btn, panel });
    btn.onclick = (e) => {
      e.stopPropagation(); const willOpen = !panel.classList.contains('open'); closeAll();
      if (willOpen) { panel.classList.add('open'); btn.classList.add('open'); panel.style.left = Math.max(2, Math.min(btn.offsetLeft, bar.clientWidth - panel.offsetWidth - 4)) + 'px'; }
    };
    panel.onclick = (e) => e.stopPropagation();
    for (const it of m.items) {
      const row = document.createElement('div'); row.className = 'mbar-item';
      const pin = document.createElement('button'); pin.className = 'mbar-pin';
      const lab = document.createElement('span'); lab.className = 'mbar-ilabel'; lab.textContent = it.label || '';
      const slot = document.createElement('span'); slot.className = 'mbar-slot';
      const home = document.createElement('span'); home.className = 'mbar-athome'; home.textContent = '★ dockに常設中'; home.style.display = 'none';
      slot.appendChild(home);
      row.append(pin, lab, slot); panel.appendChild(row);
      // dock host for this item
      const dockItem = document.createElement('span'); dockItem.className = 'dock-item';
      const dlab = document.createElement('span'); dlab.className = 'mbar-ilabel'; dlab.textContent = it.label || '';
      dockItem.appendChild(dlab); dock.appendChild(dockItem);
      allItems.set(it.id, { it, slot, dockSlot: dockItem, pinBtn: pin });
      pin.onclick = (e) => { e.stopPropagation(); if (pins.has(it.id)) pins.delete(it.id); else pins.add(it.id); save(); place(it.id); reflowDock(); };
    }
  }
  function reflowDock() { // hide dock hosts whose item isn't pinned (keep dock tidy)
    for (const [id, rec] of allItems) rec.dockSlot.style.display = pins.has(id) ? '' : 'none';
  }
  function closeAll() { for (const p of panels) { p.panel.classList.remove('open'); p.btn.classList.remove('open'); } }
  document.addEventListener('click', closeAll);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });

  container.appendChild(bar); container.appendChild(dock);
  for (const id of allItems.keys()) place(id);
  reflowDock();
  return { closeAll, isPinned: (id) => pins.has(id) };
}
