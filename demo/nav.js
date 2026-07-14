// nav — the one navigation row, as a component.
//
// Every page used to hand-roll its own link row, and they drifted: half
// the pages had no way to reach the machine page at all. One list, one
// renderer; the current page shows as plain bold text. Add a page HERE
// and every page gets it.

import { t } from './i18n.js';

const PAGES = [
  ['index.html', 'CRT物理デモ'],
  ['machine.html', 'PC-8001/8801実機'],
  ['terminal.html', 'ターミナル'],
  ['video.html', '動画セミグラ'],
  ['crt-player.html', 'CRT動画プレイヤー'],
  ['rhythm.html', 'ドラムマシン'],
];
const REPO = 'https://github.com/opaopa6969/upd3301';

// mount into #navrow (or create one after the first <h1> if absent)
export function mountNav(current) {
  let p = document.getElementById('navrow');
  if (!p) {
    p = document.createElement('p');
    p.id = 'navrow';
    p.className = 'note';
    const h1 = document.querySelector('h1');
    h1?.parentNode?.insertBefore(p, h1.nextSibling);
  }
  const parts = ['▶ '];
  const frag = document.createDocumentFragment();
  frag.append('▶ ');
  PAGES.forEach(([file, label], i) => {
    if (i) frag.append(' · ');
    if (file === current) {
      const b = document.createElement('b');
      b.style.color = '#cde';
      b.textContent = t(label);
      frag.append(b);
    } else {
      const a = document.createElement('a');
      a.href = './' + file;
      a.style.color = '#8fd';
      a.textContent = t(label);
      frag.append(a);
    }
  });
  frag.append(' · ');
  const repo = document.createElement('a');
  repo.href = REPO;
  repo.style.color = '#8fd';
  repo.textContent = 'repo';
  frag.append(repo);
  p.replaceChildren(frag);
  return p;
}
