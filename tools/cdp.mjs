// cdp.mjs — a minimal Chrome DevTools Protocol client, zero dependencies.
//
// Why not Playwright/Puppeteer: this repo is "pure JS, zero deps" and its test
// story is `node --test` with nothing installed. Adding a browser automation
// framework (and its ~300 transitive packages) just to click a menu would be a
// bigger change than the thing being tested. Node 22+ ships a global WebSocket
// and Chrome speaks CDP over it, so the whole driver is this file.
//
// The browser BINARY still has to exist. We do not download one; we look for one
// that is already on the machine (Puppeteer/Playwright caches, or a system
// Chrome/Chromium). findChrome() returns null when there is none, and callers
// are expected to report that honestly rather than pretend the check passed.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// Candidate locations, most-specific first. Globs are expanded by hand because
// a version directory ("linux-148.0.7778.97", "chromium-1228") is unpredictable.
function* candidates() {
  if (process.env.CHROME_PATH) yield process.env.CHROME_PATH;
  const home = homedir();
  const globDirs = (base, leaf) => {
    if (!existsSync(base)) return [];
    // newest-looking last → prefer the highest version directory
    return readdirSync(base).sort().reverse().map((d) => join(base, d, ...leaf));
  };
  // Puppeteer cache: ~/.cache/puppeteer/chrome/<ver>/chrome-linux64/chrome
  for (const p of globDirs(join(home, '.cache/puppeteer/chrome'), ['chrome-linux64', 'chrome'])) yield p;
  for (const p of globDirs(join(home, '.cache/puppeteer/chrome-headless-shell'), ['chrome-headless-shell-linux64', 'chrome-headless-shell'])) yield p;
  // Playwright cache: ~/.cache/ms-playwright/chromium-<rev>/chrome-linux{,64}/chrome
  for (const base of [join(home, '.cache/ms-playwright')]) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base).sort().reverse()) {
      if (!/^chromium/.test(d)) continue;
      for (const sub of ['chrome-linux64', 'chrome-linux']) {
        yield join(base, d, sub, 'chrome');
        yield join(base, d, sub, 'headless_shell');
      }
    }
  }
  // System installs
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge']) yield p;
}

export function findChrome() {
  for (const p of candidates()) if (p && existsSync(p)) return p;
  return null;
}

// One CDP connection = one WebSocket. Requests are id-matched; events fan out to
// handlers registered by method name.
class Conn {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id); if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
        return;
      }
      for (const h of this.handlers.get(msg.method) || []) h(msg.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: CDP timeout`));
      }, 30000);
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  // Wait for one occurrence of an event (or time out).
  once(method, ms = 10000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method}: event timeout`)), ms);
      this.on(method, (p) => { clearTimeout(t); resolve(p); });
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await sleep(250);
  }
  throw new Error(`no response from ${url}`);
}

export async function launchBrowser({ exe = findChrome(), port = 0, width = 1280, height = 1500 } = {}) {
  if (!exe) throw new Error('no Chrome/Chromium binary found (set CHROME_PATH)');
  // Port 0 would make Chrome pick one and write it to DevToolsActivePort; picking
  // a random high port ourselves is simpler and good enough for a test run.
  const p = port || (10000 + Math.floor(Math.random() * 20000));
  const profile = await mkdtemp(join(tmpdir(), 'upd3301-smoke-'));
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    // Deterministic-ish rendering, and no first-run/network chatter polluting the
    // console log we are about to assert on.
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`, `--remote-debugging-port=${p}`, 'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = [];
  proc.stderr.on('data', (d) => stderr.push(String(d)));
  proc.on('error', (e) => stderr.push(String(e)));
  let version;
  try {
    version = await fetchJson(`http://127.0.0.1:${p}/json/version`);
  } catch (e) {
    proc.kill('SIGKILL');
    throw new Error(`chrome did not come up: ${e.message}\n${stderr.join('')}`);
  }
  const list = await fetchJson(`http://127.0.0.1:${p}/json/list`);
  const page = list.find((t) => t.type === 'page');
  if (!page) { proc.kill('SIGKILL'); throw new Error('no page target'); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('websocket failed')), { once: true });
  });
  const cdp = new Conn(ws);
  return {
    cdp, version, exe,
    async close() {
      cdp.close();
      proc.kill('SIGTERM');
      await sleep(200);
      try { proc.kill('SIGKILL'); } catch {}
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// ---- page-level conveniences -------------------------------------------------

export async function evaluate(cdp, expression, { awaitPromise = true } = {}) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise, userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description || d.text || 'evaluate threw');
  }
  return r.result.value;
}

// `clip` crops (and `clip.scale` downsamples) server-side. Cropping to the part
// of the page that has content and halving the scale is what keeps a directory
// of committed screenshots to a sane size — a full 1280x1400 PNG is ~85 KB and
// nine tenths of it is empty background.
export async function screenshot(cdp, { fullPage = false, clip = null } = {}) {
  const opts = { format: 'png' };
  if (fullPage) opts.captureBeyondViewport = true;
  if (clip) opts.clip = { x: 0, y: 0, scale: 1, ...clip };
  const { data } = await cdp.send('Page.captureScreenshot', opts);
  return Buffer.from(data, 'base64');
}

// Key events. `key`/`code`/`keyCode` all matter: the demo reads e.key for most
// machines but e.code for the 8801 tenkey, so a driver that sends only one of
// them would silently exercise half the handler.
const KEYS = {
  ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, ' ': { code: 'Space', keyCode: 32, text: ' ' },
  Shift: { code: 'ShiftLeft', keyCode: 16 }, Escape: { code: 'Escape', keyCode: 27 },
  Control: { code: 'ControlLeft', keyCode: 17 }, Backspace: { code: 'Backspace', keyCode: 8 },
  Tab: { code: 'Tab', keyCode: 9 },
};
function keySpec(key) {
  if (KEYS[key]) return { key, ...KEYS[key] };
  if (key.length === 1) {
    const up = key.toUpperCase();
    const code = /[a-z]/i.test(key) ? `Key${up}` : /[0-9]/.test(key) ? `Digit${key}` : '';
    return { key, code, keyCode: up.charCodeAt(0), text: key };
  }
  return { key, code: key, keyCode: 0 };
}
export async function keyDown(cdp, key) {
  const s = keySpec(key);
  await cdp.send('Input.dispatchKeyEvent', {
    type: s.text ? 'keyDown' : 'rawKeyDown', key: s.key, code: s.code,
    windowsVirtualKeyCode: s.keyCode, nativeVirtualKeyCode: s.keyCode, text: s.text || '',
  });
}
export async function keyUp(cdp, key) {
  const s = keySpec(key);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: s.key, code: s.code,
    windowsVirtualKeyCode: s.keyCode, nativeVirtualKeyCode: s.keyCode,
  });
}
export async function press(cdp, key, holdMs = 40) {
  await keyDown(cdp, key); await sleep(holdMs); await keyUp(cdp, key);
}

export async function mouse(cdp, type, x, y, button = 'left') {
  await cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button, buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  });
}
export async function dragTo(cdp, x0, y0, x1, y1, steps = 6) {
  await mouse(cdp, 'mousePressed', x0, y0);
  for (let i = 1; i <= steps; i++) {
    await mouse(cdp, 'mouseMoved', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
    await sleep(20);
  }
  await mouse(cdp, 'mouseReleased', x1, y1);
}

export { sleep };
