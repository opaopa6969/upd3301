#!/usr/bin/env node
// smoke.mjs — open demo/machine.html in a REAL headless Chrome and prove the UI
// works, for all nine machines.
//
// Why this exists: demo/machine.html is ~3200 lines that six agents edited
// blind. Every unit test in this repo runs an emulator CORE headlessly; none of
// them ever mounted the page, clicked a menu, or pressed a key. The bugs that
// live only here are exactly the ones a core test cannot see — a file picker
// with no menu entry, a status line reading a field this machine does not have,
// a pad table keyed by the wrong mode name, an overlay eating every click.
//
// Zero dependencies (see tools/cdp.mjs): a static file server from node:http, a
// Chrome that is already on the machine, CDP over the global WebSocket.
//
//   node tools/smoke.mjs                 # run everything, write shots + report
//   node tools/smoke.mjs --json          # machine-readable report on stdout
//   node tools/smoke.mjs --no-fakeroms   # skip the synthetic-ROM phase
//   CHROME_PATH=/path/to/chrome node tools/smoke.mjs
//
// Exit code 0 when every check that COULD run passed, 1 otherwise. A check that
// could not run is reported "skip" with a reason and is never counted as a pass:
// the entire point of this harness is to be honest about what was covered.
//
// The ROM problem, and what we do about it: the demo builds no machine object
// until a ROM is loaded, and its key handler starts with `if (!machine) return`.
// So a ROM-less smoke test presses keys into a void and learns nothing. Two ways
// out are used here — the Game Boy test ROMs that legitimately ship in gbroms/,
// and tools/fakeroms.mjs, which synthesises minimal legally-clean images (right
// headers and reset vectors, otherwise zeros) that are enough to construct and
// step each machine. Those go in through the page's OWN file inputs, so the
// picker wiring is tested end to end rather than bypassed.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findChrome, launchBrowser, evaluate, screenshot, press, keyDown, keyUp,
  mouse, dragTo, sleep,
} from './cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTDIR = join(ROOT, 'docs', 'smoke-shots');
const TMPDIR = join(ROOT, 'docs', 'smoke-shots', '.tmp');
const args = new Set(process.argv.slice(2));
const JSONOUT = args.has('--json');
const log = (...a) => { if (!JSONOUT) console.log(...a); };

// ---- static server -----------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.wasm': 'application/wasm', '.gz': 'application/gzip',
};
function serve(root) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      // Strip the query (the page's import map appends ?v=cache1) and refuse to
      // escape the root.
      const url = decodeURIComponent(req.url.split('?')[0]);
      const path = join(root, normalize(url).replace(/^(\.\.[/\\])+/, ''));
      if (!path.startsWith(root) || !existsSync(path)) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      createReadStream(path).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// ---- the nine machines -------------------------------------------------------
// `btn`    boot-mode button id
// `picker` the file input the 📁 menu must expose. Four of these (md, x68, seta,
//          pc98) had NO menu entry at one point, which is the bug class that
//          motivated this whole harness.
// `gen`    the tools/fakeroms.mjs generator, and `files` turns its output into
//          the (name, bytes) pairs the picker's onchange handler expects. Names
//          matter for the 8801 (romid.js dispatches on n88.rom / disk.rom / …);
//          for the X68000 and PC-98 the handlers dispatch on SIZE, not name.
// `expect` a substring the status line only prints when THIS machine is really
//          the live one. boot() deliberately leaves the previous machine running
//          when the new mode has no ROM yet (see the comment at machine.html's
//          `machine.crtc &&` guard), so "frames advance" alone would not prove
//          the right machine came up.
const MACHINES = [
  { id: 'n80', name: 'PC-8001', btn: 'mn80', picker: 'from', expect: 'hsync=',
    gen: 'fakePc8001Rom', files: (r) => [['n80.rom', r]] },
  { id: 'n88', name: 'PC-8801', btn: 'mn88', picker: 'from88', expect: 'hsync=',
    gen: 'fakePc8801Set', files: (s) => [
      ['n88.rom', s.main], ['disk.rom', s.sub], ['n80.rom', s.n80],
      ...(Array.isArray(s.ext) ? s.ext.map((b, i) => [`n88_${i}.rom`, b]) : [['n88ext.rom', s.ext]]),
    ] },
  { id: 'nes', name: 'Famicom', btn: 'mnes', picker: 'fnes', expect: 'fake.nes',
    gen: 'fakeNesCart', files: (r) => [['fake.nes', r]] },
  { id: 'pce', name: 'PC Engine', btn: 'mpce', picker: 'fpce', expect: 'fake.pce',
    gen: 'fakePceCart', files: (r) => [['fake.pce', r]] },
  { id: 'md', name: 'Mega Drive', btn: 'mmd', picker: 'fmd', expect: 'fake.md',
    gen: 'fakeMdCart', files: (r) => [['fake.md', r]] },
  // The Game Boy's ROM is REAL (gbroms/, MIT) and is materialised separately.
  { id: 'gb', name: 'Game Boy', btn: 'mgb', picker: 'fgb', expect: 'frame=', gen: null },
  { id: 'x68', name: 'X68000', btn: 'mx68', picker: 'fx68rom', expect: 'kHz',
    gen: 'fakeX68Set', files: (s) => [['IPLROM.DAT', s.ipl], ['CGROM.DAT', s.cgrom]] },
  { id: 'seta', name: 'Arcade (Seta)', btn: 'mseta', picker: 'fseta', expect: 'frame=',
    gen: 'fakeSetaZip', files: (r) => [['thunderl.zip', r]] },
  { id: 'pc98', name: 'PC-9801', btn: 'mpc98', picker: 'fpc98rom', expect: '640x400',
    gen: 'fakePc98Set', files: (s) => [['bios.rom', s.bios], ['itf.rom', s.itf],
      ['font.rom', s.font], ['sound.rom', s.sound]] },
];

// ---- report bookkeeping ------------------------------------------------------
const results = [];      // { machine, check, status: pass|fail|skip, note }
const consoleLog = [];   // every console message + every uncaught exception
function record(machine, check, status, note = '') {
  results.push({ machine, check, status, note });
  const mark = status === 'pass' ? 'ok  ' : status === 'skip' ? 'skip' : 'FAIL';
  log(`  [${mark}] ${machine} · ${check}${note ? ' — ' + note : ''}`);
  return status === 'pass';
}
// Console noise that is not the page's fault, with why each is benign.
const BENIGN = [
  /favicon\.ico/,                        // we do not serve one
  /\/roms\/manifest\.json/,              // optional ROM manifest; absent by design
  /\/api\/store\//,                      // the userstore API only exists behind serve.py
  /Autoplay is only allowed/,            // headless has no user gesture yet
  /The AudioContext was not allowed/,    // same autoplay story
  /audio.*worklet/i,                     // audio path messages are console.log-level info
];
const isBenign = (t) => BENIGN.some((r) => r.test(t));
const badness = (m) => (m.level === 'error' || m.level === 'warning') && !isBenign(m.text);

// Snapshot the console, run `fn`, report anything new and non-benign.
async function watchConsole(label, machine, fn) {
  const before = consoleLog.length;
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  await sleep(150);
  const fresh = consoleLog.slice(before).filter(badness);
  if (threw) return record(machine, label, 'fail', threw.message.split('\n')[0]);
  if (fresh.length) return record(machine, label, 'fail', fresh.map((m) => `${m.level}: ${m.text}`).join(' | ').slice(0, 300));
  return record(machine, label, 'pass');
}

// Screenshots are COMMITTED, so they have to stay small: crop to the strip that
// actually has UI in it and scale it down. Full 1280x1400 PNGs are ~85 KB each
// and nine tenths empty background.
//
// The crop has to be MEASURED, not fixed: the canvas is sized by the machine, so
// an X68000 at "fit" is far taller than a Game Boy, and a fixed crop would cut
// off the status line — the one element every check in this file reads — for
// exactly the machines whose status line is most in doubt.
async function shot(cdp) {
  const h = await evaluate(cdp, `(() => {
    const g = document.getElementById('guts');
    const bottom = g ? g.getBoundingClientRect().bottom : 0;
    return Math.min(1400, Math.max(600, Math.ceil(bottom) + 30));
  })()`);
  // Keep the pixel budget roughly constant however tall the page got.
  const scale = Math.min(0.62, 560 / h);
  return screenshot(cdp, { clip: { x: 0, y: 0, width: 1280, height: h, scale } });
}

// The page keeps `machine` in ES-module scope — deliberately not on window — so
// the harness reads what the USER can see instead of reaching into internals.
// #guts is the status line ("<label>  N.Nms/frame  frame=N  pc=XXXXh"), and it
// only ever says frame= when a machine actually exists.
const PAGE_STATE = `(() => {
  const txt = (id) => (document.getElementById(id) || {}).textContent || '';
  const g = txt('guts');
  const mf = /frame=(\\d+)/.exec(g);
  return { guts: g, dipnote: txt('dipnote'), playinfo: txt('playinfo'),
           running: !!mf, frame: mf ? +mf[1] : null };
})()`;

// ---- main --------------------------------------------------------------------
async function main() {
  const exe = findChrome();
  if (!exe) {
    console.error('NO BROWSER: no Chrome/Chromium found. Looked in ~/.cache/puppeteer,');
    console.error('~/.cache/ms-playwright and the usual /usr/bin paths. Set CHROME_PATH.');
    process.exit(2);
  }
  log(`browser: ${exe}`);

  // Synthetic ROMs are optional: without them the harness still runs, it just
  // reports every "with a machine running" check as a skip rather than lying.
  let fake = null;
  if (!args.has('--no-fakeroms')) {
    try { fake = await import('./fakeroms.mjs'); }
    catch (e) { log(`(no tools/fakeroms.mjs — ROM-backed checks will be skipped: ${e.message})`); }
  }

  const { srv, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  log(`server:  ${base}`);
  await mkdir(SHOTDIR, { recursive: true });
  // Clear old shots first. A run that skips a machine must not leave last run's
  // picture of it lying around looking like evidence.
  for (const f of await readdir(SHOTDIR)) {
    if (f.endsWith('.png') || f === 'report.json') await rm(join(SHOTDIR, f), { force: true });
  }
  await mkdir(TMPDIR, { recursive: true });

  const browser = await launchBrowser({ exe });
  const { cdp } = browser;
  log(`chrome:  ${browser.version.Browser}`);

  // Collect EVERYTHING the page says. consoleAPICalled covers console.*;
  // exceptionThrown covers uncaught errors and rejected promises; Log.entryAdded
  // covers what only the browser reports (failed subresources, CSP, deprecations)
  // and which the other two never see.
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? a.unserializableValue ?? '').join(' ');
    consoleLog.push({ level: p.type, text, where: 'console' });
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    consoleLog.push({ level: 'error', text: d.exception?.description || d.text, where: 'exception' });
  });
  cdp.on('Log.entryAdded', (p) => {
    consoleLog.push({ level: p.entry.level, text: `${p.entry.text}${p.entry.url ? ' @' + p.entry.url : ''}`, where: 'log' });
  });

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false });

  // ---- 1. does the page load at all? ----------------------------------------
  log('\n== load ==');
  const loaded = cdp.once('Page.loadEventFired', 30000);
  await cdp.send('Page.navigate', { url: `${base}/demo/machine.html` });
  await loaded;
  await sleep(2500); // import map + autoLoad() + the tour's 700 ms auto-start
  const boot = await evaluate(cdp, `(() => ({
    title: document.title,
    hasCanvas: !!document.getElementById('crt'),
    menus: [...document.querySelectorAll('.mbar-btn')].map(b => b.textContent),
    fileInputs: document.querySelectorAll('input[type=file]').length,
  }))()`);
  record('page', 'loads with a canvas + menu bar', boot.hasCanvas && boot.menus.length >= 6 ? 'pass' : 'fail',
    `canvas=${boot.hasCanvas} menus=${boot.menus.length} fileInputs=${boot.fileInputs}`);
  const startupErrors = consoleLog.filter(badness);
  record('page', 'no startup errors/warnings', startupErrors.length ? 'fail' : 'pass',
    startupErrors.map((m) => `${m.level}: ${m.text}`).join(' | ').slice(0, 400));

  // ---- 2. the first-visit tour --------------------------------------------
  // It is a full-viewport fixed overlay at z-index 9999 that auto-starts 700 ms
  // in. Anything automated (or any user) that does not dismiss it has EVERY
  // click swallowed, so it is checked first and on purpose.
  log('\n== first-visit tour ==');
  const tour = await evaluate(cdp, `(() => {
    const r = document.querySelector('.tour-root');
    if (!r) return { present: false };
    const b = r.getBoundingClientRect();
    const tip = r.querySelector('.tour-tip');
    return { present: true, w: b.width, h: b.height,
             tip: tip ? tip.textContent.slice(0, 60) : null,
             covers: document.elementFromPoint(20, 20) === r || r.contains(document.elementFromPoint(20, 20)) };
  })()`);
  record('tour', 'auto-starts on first visit', tour.present ? 'pass' : 'fail',
    tour.present ? `${tour.w}x${tour.h} "${tour.tip}"` : 'no .tour-root appeared');
  if (tour.present) {
    await writeFile(join(SHOTDIR, 'tour.png'), await shot(cdp));
    await press(cdp, 'Escape');
    await sleep(300);
    const gone = await evaluate(cdp, `!document.querySelector('.tour-root')`);
    record('tour', 'ESC dismisses it', gone ? 'pass' : 'fail');
    if (!gone) { // fall back to a click on the overlay so the rest can run
      await mouse(cdp, 'mousePressed', 20, 20); await mouse(cdp, 'mouseReleased', 20, 20); await sleep(300);
    }
  }
  // Nothing must be left covering the page.
  const topLeft = await evaluate(cdp, `(() => {
    const e = document.elementFromPoint(140, 109);
    return e ? e.tagName + '.' + e.className : null; })()`);
  record('tour', 'nothing overlays the menu bar afterwards',
    topLeft && !/tour/.test(topLeft) ? 'pass' : 'fail', `elementFromPoint → ${topLeft}`);

  // ---- 3. the menu bar: are all nine pickers reachable? ----------------------
  log('\n== menu bar (📁 ファイル) ==');
  // Click the real button rather than calling the handler, so a menu that fails
  // to open (mispositioned, zero-size, covered) still counts as a failure.
  const fileBtnBox = await evaluate(cdp, `(() => {
    const b = [...document.querySelectorAll('.mbar-btn')].find(x => x.textContent.includes('ファイル'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
  if (!fileBtnBox) record('menu', 'file menu exists', 'fail', 'no 📁ファイル button in the menu bar');
  else {
    await mouse(cdp, 'mousePressed', fileBtnBox.x, fileBtnBox.y);
    await mouse(cdp, 'mouseReleased', fileBtnBox.x, fileBtnBox.y);
    await sleep(300);
    const open = await evaluate(cdp, `document.querySelectorAll('.mbar-menu.open').length`);
    record('menu', 'file menu opens on a real mouse click', open === 1 ? 'pass' : 'fail', `open panels=${open}`);
    await writeFile(join(SHOTDIR, 'menu-file.png'), await shot(cdp));
    // Each picker must be present, inside the OPEN panel, and non-zero sized.
    for (const m of MACHINES) {
      const st = await evaluate(cdp, `(() => {
        const el = document.getElementById(${JSON.stringify(m.picker)});
        if (!el) return { why: 'no such input' };
        const panel = el.closest('.mbar-menu');
        const r = el.getBoundingClientRect();
        return { ok: r.width > 0 && r.height > 0, inOpenPanel: !!(panel && panel.classList.contains('open')),
                 inMenu: !!panel, w: Math.round(r.width), h: Math.round(r.height) };
      })()`);
      record('menu', `picker #${m.picker} (${m.name}) visible in the open menu`,
        st.ok && st.inOpenPanel ? 'pass' : 'fail',
        st.why || `visible=${st.ok} inMenu=${st.inMenu} inOpenPanel=${st.inOpenPanel} ${st.w}x${st.h}`);
    }
    // Clicking must actually raise a file chooser. Page.fileChooserOpened (with
    // interception on) is the only way to prove the click reaches a live
    // <input type=file> rather than a detached or covered one.
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
    for (const m of MACHINES) {
      let fired = false;
      cdp.on('Page.fileChooserOpened', () => { fired = true; });
      const box = await evaluate(cdp, `(() => {
        const el = document.getElementById(${JSON.stringify(m.picker)});
        if (!el) return null; const r = el.getBoundingClientRect();
        if (!r.width) return null; return { x: r.x + 10, y: r.y + r.height/2 };
      })()`);
      if (!box) { record('menu', `clicking #${m.picker} opens a file chooser`, 'skip', 'input not visible'); continue; }
      await mouse(cdp, 'mousePressed', box.x, box.y);
      await mouse(cdp, 'mouseReleased', box.x, box.y);
      await sleep(220);
      record('menu', `clicking #${m.picker} opens a file chooser`, fired ? 'pass' : 'fail');
    }
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false });
  }
  await press(cdp, 'Escape'); await sleep(200); // close the menu

  // ---- 4. materialise whatever ROMs we can ---------------------------------
  // Real Game Boy test ROMs ship with the repo (MIT); everything else is
  // synthetic (tools/fakeroms.mjs) or simply absent. Done up front so the
  // no-ROM pass below knows which machines will never get a second screenshot.
  const romFiles = {};   // machine id → [absolute paths]
  const romWhy = {};     // machine id → why it has none
  const gbGz = join(ROOT, 'gbroms', 'dmg-acid2.gb.gz');
  if (existsSync(gbGz)) {
    const p = join(TMPDIR, 'dmg-acid2.gb');
    await writeFile(p, gunzipSync(await readFile(gbGz)));
    romFiles.gb = [p];
  } else romWhy.gb = 'gbroms/dmg-acid2.gb.gz missing';
  for (const m of MACHINES) {
    if (romFiles[m.id]) continue;
    if (!m.gen) { romWhy[m.id] = romWhy[m.id] || 'no ROM source'; continue; }
    if (!fake) { romWhy[m.id] = 'tools/fakeroms.mjs unavailable'; continue; }
    if (typeof fake[m.gen] !== 'function') { romWhy[m.id] = `fakeroms.mjs has no ${m.gen}()`; continue; }
    let out;
    try { out = fake[m.gen](); } catch (e) { romWhy[m.id] = `${m.gen}() threw: ${e.message}`; continue; }
    if (!out) { romWhy[m.id] = `${m.gen}() returned null (cannot be synthesised)`; continue; }
    // One directory per machine: the FILE NAME is load-bearing (romid.js routes
    // the 8801 set by name), and two machines legitimately want the same name —
    // the PC-8001's boot ROM and the 8801's optional N-mode ROM are both
    // "n80.rom". Sharing a directory silently gave the 8001 the 8801's image.
    const dir = join(TMPDIR, m.id);
    await mkdir(dir, { recursive: true });
    const paths = [];
    for (const [name, bytes] of m.files(out)) {
      if (!bytes) continue;
      const p = join(dir, name);
      await writeFile(p, bytes);
      paths.push(p);
    }
    if (paths.length) romFiles[m.id] = paths; else romWhy[m.id] = `${m.gen}() produced no files`;
  }
  log(`\nROMs: ${MACHINES.map((m) => `${m.id}=${romFiles[m.id] ? 'yes' : 'no'}`).join(' ')}`);

  // ---- 5. each machine, with no ROM -----------------------------------------
  // The state the very first visitor is in. What must hold: switching modes
  // throws nothing, the button lights, and the status line says what is missing.
  for (const m of MACHINES) {
    log(`\n== ${m.name} (${m.id}) — no ROM ==`);
    await watchConsole('switch mode', m.name, async () => {
      await evaluate(cdp, `document.getElementById(${JSON.stringify(m.btn)}).click()`);
      await sleep(600);
    });
    const st = await evaluate(cdp, `(() => Object.assign(${PAGE_STATE}, {
      on: document.getElementById(${JSON.stringify(m.btn)}).classList.contains('on') }))()`);
    record(m.name, 'boot-mode button lights up', st.on ? 'pass' : 'fail');
    record(m.name, 'status line explains the missing ROM',
      st.guts.length > 0 ? 'pass' : 'fail', st.guts.slice(0, 70));
    // The status line reads machine.crtc (X68000) / machine.board (Seta) every
    // frame; a missing guard there throws once per frame forever.
    await watchConsole('status line survives ~30 frames', m.name, () => sleep(550));
    await watchConsole('keys do not throw with no machine', m.name, async () => {
      await evaluate(cdp, `document.getElementById('crt').focus()`);
      for (const k of ['ArrowUp', 'ArrowLeft', 'z', 'x', 'Enter', ' ']) await press(cdp, k, 25);
    });
    // One screenshot per machine, and this is it for the ones that never get a
    // ROM — the ROM pass below shoots the rest in their more interesting state.
    if (!romFiles[m.id]) await writeFile(join(SHOTDIR, `${m.id}-norom.png`), await shot(cdp));
  }

  // ---- 6. each machine, WITH a ROM ------------------------------------------
  // The checks that matter: a machine object exists, frames advance, and the
  // input path (PAD_BITS / JOY_PORTS / OWN_KEYS / the 8801 key matrix) is
  // actually entered instead of being skipped by `if (!machine) return`.
  log('\n== with ROMs ==');
  const { root } = await cdp.send('DOM.getDocument');
  async function setFiles(inputId, paths) {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#' + inputId });
    if (!nodeId) throw new Error(`#${inputId} not in the DOM`);
    await cdp.send('DOM.setFileInputFiles', { files: paths, nodeId });
  }

  for (const m of MACHINES) {
    log(`\n-- ${m.name} with a ROM --`);
    const paths = romFiles[m.id];
    if (!paths) {
      for (const c of ['loads a ROM through its own picker', 'machine runs (frames advance)',
        'the RIGHT machine is live', 'input path reached without throwing']) {
        record(m.name, c, 'skip', romWhy[m.id] || 'no ROM available');
      }
      continue;
    }
    await evaluate(cdp, `document.getElementById(${JSON.stringify(m.btn)}).click()`);
    await sleep(300);
    const ok = await watchConsole('loads a ROM through its own picker', m.name, async () => {
      await setFiles(m.picker, paths);
      await sleep(2200);
    });
    const s1 = await evaluate(cdp, PAGE_STATE);
    if (!s1.running) {
      record(m.name, 'machine runs (frames advance)', 'fail',
        `status line never showed frame=: "${(s1.guts || s1.dipnote).slice(0, 90)}"`);
      record(m.name, 'the RIGHT machine is live', 'fail', 'nothing running');
    } else {
      await sleep(700);
      const s2 = await evaluate(cdp, PAGE_STATE);
      record(m.name, 'machine runs (frames advance)', s2.frame > s1.frame ? 'pass' : 'fail',
        `frame ${s1.frame} → ${s2.frame}`);
      // Guard against a stale machine: boot() bails out (leaving the PREVIOUS
      // machine running) when the new mode's ROM did not take, and the status
      // line would still count frames. `expect` only prints for this machine.
      record(m.name, 'the RIGHT machine is live', s2.guts.includes(m.expect) ? 'pass' : 'fail',
        `looking for "${m.expect}" in: ${s2.guts.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
    // Now the interesting one: keys with a live machine. Every mode has its own
    // arm of the key handler and none of them had ever been pressed by anything.
    await watchConsole('input path reached without throwing', m.name, async () => {
      await evaluate(cdp, `document.getElementById('crt').focus()`);
      for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'z', 'x', 'c',
        'Enter', ' ', 'Shift', '1', '5', 'a', 'w', 's', 'd', 'Escape', 'Tab', 'Backspace']) {
        await press(cdp, k, 22);
      }
      // Holding is a different path: the bit must survive across frames, which is
      // what actually reaches machine.setPad / machine.joy / machine.inputs.
      await keyDown(cdp, 'ArrowRight'); await sleep(250); await keyUp(cdp, 'ArrowRight');
      await keyDown(cdp, 'z'); await sleep(250); await keyUp(cdp, 'z');
      await sleep(200);
    });
    await writeFile(join(SHOTDIR, `${m.id}.png`), await shot(cdp));
  }

  // ---- 6b. a machine that draws NOTHING must still report -------------------
  // Regression guard. The render loop used to `return` early when a machine
  // rendered a 0x0 frame (its CRTC not programmed — normal right after reset,
  // permanent for a ROM that never programs it). That skipped the status line
  // and the player bar too, so the page looked frozen and identical to a ROM
  // that had failed to load. A ROM that runs but shows nothing must still SAY
  // that it is running. The 8801's N-mode image is a real example: it is a
  // valid 32 KB image the PC-8001 will happily execute, and it never touches
  // the CRTC.
  if (fake && typeof fake.fakePc8801Set === 'function') {
    log('\n== a machine that renders 0x0 still reports ==');
    const blankDir = join(TMPDIR, 'blank');
    await mkdir(blankDir, { recursive: true });
    const blank = join(blankDir, 'n80.rom');
    await writeFile(blank, fake.fakePc8801Set().n80);
    await evaluate(cdp, `document.getElementById('mn80').click()`);
    await sleep(300);
    await setFiles('from', [blank]);
    await sleep(1500);
    const b1 = await evaluate(cdp, PAGE_STATE);
    await sleep(700);
    const b2 = await evaluate(cdp, PAGE_STATE);
    record('render', 'a 0x0 frame still updates the status line',
      b2.running && b2.frame > b1.frame ? 'pass' : 'fail',
      `${(b2.guts || b2.dipnote).replace(/\s+/g, ' ').slice(0, 100)}`);
  } else record('render', 'a 0x0 frame still updates the status line', 'skip', 'needs fakeroms.mjs');

  // ---- 7. Game Boy: does a picture actually come out? ------------------------
  // The one machine with a REAL ROM in the repo (MIT test ROMs), so the only one
  // where "pixels came out, and they are not all the same colour" can be claimed.
  log('\n== Game Boy picture ==');
  if (!romFiles.gb) record('Game Boy', 'draws a real picture (dmg-acid2)', 'skip', romWhy.gb);
  else {
    await evaluate(cdp, `document.getElementById('mgb').click()`);
    await sleep(300);
    await setFiles('fgb', romFiles.gb);
    await sleep(3000); // dmg-acid2 needs a moment to draw its face
    // Read the CANVAS, because that is what a person would be looking at, and
    // it is the only thing that proves render + CRT sim + blit all ran.
    const pix = await evaluate(cdp, `(() => {
      const c = document.getElementById('crt');
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const hist = new Map(); let lit = 0;
      for (let i = 0; i < d.length; i += 4) {
        const k = (d[i] << 16) | (d[i+1] << 8) | d[i+2];
        hist.set(k, (hist.get(k) || 0) + 1);
        if (d[i] + d[i+1] + d[i+2] > 60) lit++;
      }
      return { w: c.width, h: c.height, distinct: hist.size, lit, px: d.length / 4 };
    })()`);
    record('Game Boy', 'draws a real picture (dmg-acid2)',
      pix.distinct >= 3 && pix.lit > pix.px * 0.02 ? 'pass' : 'fail',
      `${pix.w}x${pix.h} distinct colours=${pix.distinct} lit=${pix.lit}/${pix.px}`);
    await writeFile(join(SHOTDIR, 'gb-dmg-acid2.png'), await shot(cdp));
    const canvasPng = await evaluate(cdp, `document.getElementById('crt').toDataURL('image/png').slice(22)`);
    await writeFile(join(SHOTDIR, 'gb-dmg-acid2-canvas.png'), Buffer.from(canvasPng, 'base64'));
    // The Game Boy is the one console that is TOLD its buttons (setPad) rather
    // than polled, because a line going low requests the joypad IRQ.
    await watchConsole('pad input on a running machine', 'Game Boy', async () => {
      await evaluate(cdp, `document.getElementById('crt').focus()`);
      for (const k of ['ArrowUp', 'ArrowRight', 'z', 'x', 'Enter', ' ']) await press(cdp, k, 60);
      await sleep(300);
    });
  }

  // ---- 8. rewind UI (pause / shuttle / jog / rewind) -------------------------
  // Run against a LIVE machine (the Game Boy above) so the snapshot ring has
  // something in it — scrubbing an empty ring would prove nothing.
  log('\n== rewind UI ==');
  await watchConsole('pause / resume button', 'rewind', async () => {
    await evaluate(cdp, `document.getElementById('bpause').click()`); await sleep(400);
    await evaluate(cdp, `document.getElementById('bpause').click()`); await sleep(400);
  });
  const boxes = await evaluate(cdp, `(() => {
    const g = (id) => { const e = document.getElementById(id); if (!e) return null;
      const r = e.getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height }; };
    return { shuttle: g('shuttle'), track: g('track') };
  })()`);
  if (!boxes.shuttle) record('rewind', 'shuttle drag', 'fail', 'no #shuttle element');
  else {
    const s = boxes.shuttle, cy = s.y + s.h / 2;
    await watchConsole('shuttle drag left (rewind) then right (fast-forward)', 'rewind', async () => {
      await dragTo(cdp, s.x + s.w / 2, cy, s.x + 6, cy); await sleep(600);
      await mouse(cdp, 'mouseReleased', s.x + 6, cy);
      await dragTo(cdp, s.x + s.w / 2, cy, s.x + s.w - 6, cy); await sleep(600);
    });
  }
  if (!boxes.track) record('rewind', 'track jog', 'fail', 'no #track element');
  else {
    const t = boxes.track, ty = t.y + t.h / 2;
    await watchConsole('track jog (click, then drag backwards)', 'rewind', async () => {
      await mouse(cdp, 'mousePressed', t.x + t.w * 0.5, ty);
      await mouse(cdp, 'mouseReleased', t.x + t.w * 0.5, ty); await sleep(400);
      await dragTo(cdp, t.x + t.w * 0.9, ty, t.x + t.w * 0.15, ty); await sleep(500);
    });
  }
  await watchConsole('◀◀ rewind button (press and hold)', 'rewind', async () => {
    const c = await centreOf(cdp, 'brewind');
    await mouse(cdp, 'mousePressed', c[0], c[1]); await sleep(600);
    await mouse(cdp, 'mouseReleased', c[0], c[1]); await sleep(300);
  });
  await watchConsole('speed selector (fast-forward ×8)', 'rewind', async () => {
    await evaluate(cdp, `(() => { const s = document.getElementById('speed');
      if (!s) return; s.value = [...s.options].map(o=>o.value).includes('8') ? '8' : s.options[s.options.length-1].value;
      s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(700);
    await evaluate(cdp, `(() => { const s = document.getElementById('speed');
      if (!s) return; s.value = '1'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(300);
  });
  await writeFile(join(SHOTDIR, 'rewind.png'), await shot(cdp));

  // ---- 9. controls nobody had clicked ---------------------------------------
  log('\n== other controls ==');
  for (const [id, label] of [['bclean', 'クリーン表示 / CRT toggle'], ['bpad', 'pad config panel'],
    ['bsoftkb', 'soft keyboard'], ['bpng', 'PNG(raw) export'], ['breset', 'reset']]) {
    await watchConsole(label, 'controls', async () => {
      await evaluate(cdp, `(document.getElementById(${JSON.stringify(id)}) || { click(){} }).click()`);
      await sleep(450);
    });
  }
  await writeFile(join(SHOTDIR, 'controls.png'), await shot(cdp));

  // The soft keyboard is a whole second input surface (`button.sk` per key) and
  // switchMode() re-renders it per machine, so it has to be clicked for real —
  // a query that finds nothing must FAIL, not quietly pass.
  const sk = await evaluate(cdp, `(() => {
    const kb = document.getElementById('softkb');
    if (!kb) return { why: 'no #softkb element after clicking ⌨️キーボード' };
    const keys = kb.querySelectorAll('button.sk');
    if (!keys.length) return { why: 'the soft keyboard has no button.sk keys' };
    const r = kb.getBoundingClientRect();
    return { n: keys.length, x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  if (sk.why) record('controls', 'soft keyboard renders keys', 'fail', sk.why);
  else {
    record('controls', 'soft keyboard renders keys', 'pass', `${sk.n} keys, ${Math.round(sk.w)}x${Math.round(sk.h)}`);
    // It is position:fixed at the bottom of the viewport, so it needs its own
    // (small) screenshot — the crop used everywhere else does not reach it.
    await writeFile(join(SHOTDIR, 'softkb.png'),
      await screenshot(cdp, { clip: { x: Math.max(0, sk.x), y: Math.max(0, sk.y), width: Math.min(sk.w, 1280), height: Math.min(sk.h, 400), scale: 0.6 } }));
    await watchConsole('soft keyboard key press', 'controls', async () => {
      for (const nth of [5, 20, 40]) {
        await evaluate(cdp, `(() => {
          const k = document.querySelectorAll('#softkb button.sk')[${nth}];
          if (!k) return;
          for (const t of ['mousedown', 'mouseup', 'click'])
            k.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
        })()`);
        await sleep(150);
      }
    });
  }

  // Every other menu opens too — the four we never touched could be throwing.
  log('\n== the other menus ==');
  for (const label of ['システム', 'ディスク/テープ', '表示', '設定', 'ツール']) {
    await watchConsole(`menu "${label}" opens`, 'menu', async () => {
      const box = await evaluate(cdp, `(() => {
        const b = [...document.querySelectorAll('.mbar-btn')].find(x => x.textContent.includes(${JSON.stringify(label)}));
        if (!b) throw new Error('no such menu button');
        const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
      await mouse(cdp, 'mousePressed', box.x, box.y);
      await mouse(cdp, 'mouseReleased', box.x, box.y);
      await sleep(250);
      const open = await evaluate(cdp, `document.querySelectorAll('.mbar-menu.open').length`);
      if (open !== 1) throw new Error(`${open} panels open, expected 1`);
      await press(cdp, 'Escape');
      await sleep(150);
    });
  }

  // ---- report ---------------------------------------------------------------
  const fails = results.filter((r) => r.status === 'fail');
  const skips = results.filter((r) => r.status === 'skip');
  const report = {
    ranAt: new Date().toISOString(), browser: browser.version.Browser, exe,
    fakeRoms: fake ? Object.fromEntries(MACHINES.map((m) => [m.id, romFiles[m.id] ? 'yes' : romWhy[m.id]])) : 'not used',
    counts: { total: results.length, pass: results.length - fails.length - skips.length, fail: fails.length, skip: skips.length },
    results, console: dedupe(consoleLog),
  };
  await writeFile(join(SHOTDIR, 'report.json'), JSON.stringify(report, null, 2));
  if (JSONOUT) console.log(JSON.stringify(report, null, 2));
  else {
    log(`\n=== ${report.counts.pass} pass · ${report.counts.fail} fail · ${report.counts.skip} skip ===`);
    for (const f of fails) log(`  FAIL ${f.machine} · ${f.check} — ${f.note}`);
    for (const s of skips) log(`  SKIP ${s.machine} · ${s.check} — ${s.note}`);
    log(`\nconsole messages, deduplicated (${report.console.length}):`);
    for (const c of report.console) log(`  ${String(c.level).padEnd(8)} ${c.text.slice(0, 200)}`);
    log(`\nshots + report.json: ${SHOTDIR}`);
  }

  await rm(TMPDIR, { recursive: true, force: true });
  await browser.close();
  srv.close();
  process.exit(fails.length ? 1 : 0);
}

function dedupe(list) {
  const seen = new Set(), out = [];
  for (const c of list) {
    const k = `${c.level}|${c.text}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(c);
  }
  return out;
}

async function centreOf(cdp, id) {
  return (await evaluate(cdp, `(() => { const e = document.getElementById(${JSON.stringify(id)});
    if (!e) return null; const b = e.getBoundingClientRect(); return [b.x + b.width/2, b.y + b.height/2]; })()`)) || [0, 0];
}

main().catch((e) => { console.error(e); process.exit(1); });
