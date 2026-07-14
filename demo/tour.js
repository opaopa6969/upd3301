// tour.js — dependency-free spotlight guided tour + modal, for the demo pages.
//
// A tour is a list of steps: { el: '#selector' | null, title, body, before? }.
// `el: null` shows a centered card; otherwise the target is spotlighted
// (page dimmed around it, frame on it) with a speech-bubble next to it.
// `before()` runs before the step is shown — used to auto-expand collapsed
// panels so the target is actually visible when the spotlight lands.
//
// title/body are either plain strings (run through i18n t()) or bilingual
// objects { ja, en } picked by the UA language, same policy as i18n.js.
//
// The cardinal rule: you can ALWAYS leave — ESC, the ✕ button, or a click
// on the dark overlay all end the tour instantly. Any exit (skip or finish)
// is remembered in localStorage so the tour never auto-starts twice; the
// persistent "？ツアー" button restarts it whenever you want.

import { lang, t } from './i18n.js';

const pick = (v) =>
  v == null ? '' : typeof v === 'string' ? t(v) : (v[lang] ?? v.ja ?? v.en ?? '');

// ---- styles (injected once) ------------------------------------------------
let styled = false;
function ensureStyle() {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = `
  .tour-root { position:fixed; inset:0; z-index:9999; font-family:ui-monospace,monospace; }
  .tour-root.tour-center { background:rgba(4,6,12,.72); }
  .tour-hole { position:absolute; pointer-events:none; border:2px solid #4a8; border-radius:8px;
    box-shadow:0 0 0 200vmax rgba(4,6,12,.72), 0 0 18px rgba(80,220,150,.35);
    transition:top .18s ease, left .18s ease, width .18s ease, height .18s ease; }
  .tour-tip { position:absolute; max-width:360px; min-width:240px; background:#141a22;
    border:1px solid #4a8; border-radius:8px; padding:12px 14px 10px; color:#ccd;
    box-shadow:0 6px 30px rgba(0,0,0,.6); font-size:13px; line-height:1.6; }
  .tour-tip h3 { margin:0 22px 6px 0; font-size:14px; color:#8fd; }
  .tour-tip p { margin:0 0 10px; color:#bcd; white-space:pre-line; }
  .tour-tip b, .tour-tip code { color:#8fd; }
  .tour-x { position:absolute; top:6px; right:8px; background:none; border:none; color:#889;
    font-size:14px; cursor:pointer; padding:2px 4px; }
  .tour-x:hover { color:#fff; }
  .tour-nav { display:flex; align-items:center; gap:8px; }
  .tour-nav .tour-n { color:#778; font-size:12px; margin-right:auto; }
  .tour-nav button { background:#223; color:#cde; border:1px solid #446; border-radius:4px;
    padding:4px 10px; cursor:pointer; font-family:inherit; font-size:12px; }
  .tour-nav button:hover { background:#265; border-color:#4a8; }
  .tour-nav button:disabled { opacity:.35; cursor:default; }
  .tour-modal { position:fixed; inset:0; z-index:9999; background:rgba(4,6,12,.72);
    display:flex; align-items:center; justify-content:center; font-family:ui-monospace,monospace; }
  .tour-modal .tour-tip { position:relative; max-width:min(760px, 92vw); max-height:86vh; overflow:auto; }
  `;
  document.head.appendChild(s);
}

// ---- tour ------------------------------------------------------------------
export function startTour(steps, { storageKey = 'tour', onEnd = null } = {}) {
  ensureStyle();
  if (document.querySelector('.tour-root')) return null; // one at a time

  const root = document.createElement('div');
  root.className = 'tour-root';
  const hole = document.createElement('div');
  hole.className = 'tour-hole';
  const tip = document.createElement('div');
  tip.className = 'tour-tip';
  root.appendChild(hole);
  root.appendChild(tip);

  let i = 0;
  let alive = true;

  function end(finished) {
    if (!alive) return;
    alive = false;
    try { localStorage.setItem(storageKey, finished ? 'done' : 'skip'); } catch {}
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('resize', onMove);
    removeEventListener('scroll', onMove, true);
    root.remove();
    onEnd?.(finished);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); prev(); }
  }
  const onMove = () => { if (alive) place(); };

  // exit on a click anywhere on the dark part (the tip stops propagation)
  root.addEventListener('click', () => end(false));
  tip.addEventListener('click', (e) => e.stopPropagation());

  function target() {
    const st = steps[i];
    if (!st.el) return null;
    const el = document.querySelector(st.el);
    return el && el.getClientRects().length ? el : null; // hidden → center card
  }

  function place() {
    const el = target();
    const vw = innerWidth, vh = innerHeight;
    if (!el) { // centered card
      root.classList.add('tour-center');
      hole.style.display = 'none';
      tip.style.maxWidth = '420px';
      tip.style.left = Math.max(12, (vw - tip.offsetWidth) / 2) + 'px';
      tip.style.top = Math.max(12, (vh - tip.offsetHeight) / 2.4) + 'px';
      return;
    }
    root.classList.remove('tour-center');
    let r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > vh) { // bring it into view first
      el.scrollIntoView({ block: 'center' });
      r = el.getBoundingClientRect();
    }
    const pad = 6;
    hole.style.display = '';
    hole.style.left = (r.left - pad) + 'px';
    hole.style.top = (r.top - pad) + 'px';
    hole.style.width = (r.width + pad * 2) + 'px';
    hole.style.height = (r.height + pad * 2) + 'px';
    tip.style.maxWidth = '360px';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let top = r.bottom + pad + 10;             // below…
    if (top + th > vh - 8) top = r.top - pad - th - 10; // …else above…
    if (top < 8) top = Math.min(vh - th - 8, r.bottom - th - 12); // …else inside
    let left = Math.min(Math.max(8, r.left), vw - tw - 8);
    tip.style.left = left + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  }

  function render() {
    const st = steps[i];
    st.before?.();
    tip.innerHTML = '';
    const x = document.createElement('button');
    x.className = 'tour-x';
    x.textContent = '✕';
    x.onclick = () => end(false);
    const h = document.createElement('h3');
    h.textContent = pick(st.title);
    const p = document.createElement('p');
    p.innerHTML = pick(st.body); // step bodies are our own strings (may hold <b>)
    const nav = document.createElement('div');
    nav.className = 'tour-nav';
    const n = document.createElement('span');
    n.className = 'tour-n';
    n.textContent = `${i + 1}/${steps.length}`;
    const bp = document.createElement('button');
    bp.textContent = '◂ ' + t('前へ');
    bp.disabled = i === 0;
    bp.onclick = prev;
    const bn = document.createElement('button');
    bn.textContent = i === steps.length - 1 ? t('完了') + ' ✓' : t('次へ') + ' ▸';
    bn.onclick = next;
    nav.append(n, bp, bn);
    tip.append(x, h, p, nav);
    place();
    place(); // second pass: size-dependent placement settles
  }

  function next() { if (i >= steps.length - 1) end(true); else { i++; render(); } }
  function prev() { if (i > 0) { i--; render(); } }

  document.addEventListener('keydown', onKey, true);
  addEventListener('resize', onMove);
  addEventListener('scroll', onMove, true);
  document.body.appendChild(root);
  render();
  return { end: () => end(false), next, prev };
}

// Persistent "？ツアー" button + first-visit auto start.
export function mountTourButton(mount, steps, { storageKey = 'tour', auto = true, delay = 700 } = {}) {
  ensureStyle();
  const b = document.createElement('button');
  b.textContent = t('？ツアー');
  b.title = lang === 'ja' ? 'ガイドツアーを開始' : 'Start the guided tour';
  b.onclick = () => startTour(steps, { storageKey });
  if (mount.tagName === 'H1') {
    // header-right placement: small, floated, doesn't inherit the h1 font
    b.style.cssText = 'float:right;font-size:13px;font-weight:400;margin-top:2px';
  }
  mount.appendChild(b);
  let seen = null;
  try { seen = localStorage.getItem(storageKey); } catch {}
  if (auto && !seen) setTimeout(() => startTour(steps, { storageKey }), delay);
  return b;
}

// ---- modal (keyboard help etc.) ---------------------------------------------
// Same exits as the tour: ESC, ✕, click outside the panel.
export function showModal({ title, html }) {
  ensureStyle();
  const root = document.createElement('div');
  root.className = 'tour-modal';
  const panel = document.createElement('div');
  panel.className = 'tour-tip';
  const x = document.createElement('button');
  x.className = 'tour-x';
  x.textContent = '✕';
  const h = document.createElement('h3');
  h.textContent = pick(title);
  const body = document.createElement('div');
  body.innerHTML = html;
  panel.append(x, h, body);
  root.appendChild(panel);
  function close() {
    document.removeEventListener('keydown', onKey, true);
    root.remove();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }
  x.onclick = close;
  root.addEventListener('click', close);
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(root);
  return { close };
}
