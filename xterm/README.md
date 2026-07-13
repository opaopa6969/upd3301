# crt-xterm — a 1979 CRT renderer addon for xterm.js

**English** · [日本語](./README.ja.md)

Your web terminal, but the photons are 45 years old. This addon hides
xterm.js's stock renderer and redraws every frame through this repo's CRT
physics stack: cells → 8×8 bitmap glyphs → an 8-color GRB frame →
[`crt.js`](../crt.js) phosphor decay → [`tube.js`](../tube.js) shadow
mask / barrel / scanlines → canvas. Input, selection behavior, clipboard and
IME handling stay 100% xterm.js — only the light is replaced.

## Using the addon

xterm.js is a **peer dependency**: the addon never imports it. Load xterm.js
however you like (CDN, bundler), then:

```html
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script type="module">
  import { CrtRendererAddon } from './xterm/crt-xterm.js';

  const term = new Terminal({ cursorBlink: false });
  term.open(document.getElementById('terminal'));
  term.loadAddon(new CrtRendererAddon({
    phosphor: 'P22',     // P22 | LONG | P39 | P7 | AMBER | PLASMA
    mask: 'aperture',    // aperture | shadow | slot | none
    maskPitch: 3,
    barrel: 0.06,
    focus: 0.8,          // beam width (FOCUS knob)
    bright: 1.2,
    contrast: 1.0,
    flicker: false,      // deterministic 10 Hz camera-beat throb
    strict1979: false,   // drop per-cell backgrounds (the PC-8001 truth)
    cursorBlink: true,
    outputScale: 2,      // tube output pixels per source pixel (perf knob)
  }));
</script>
```

Runtime control: `addon.setOptions({ phosphor: 'P39' })`,
`addon.setEnabled(false)` (hand the pixels back to xterm.js, live),
`addon.dispose()`.

Colors are quantized to the 8 GRB colors of 1979 — xterm's 16/256/truecolor
all land on the nearest of black/blue/red/magenta/green/cyan/yellow/white,
with dark colors rescued relative to their brightest gun (navy reads as
blue, not black). `strict1979: true` additionally drops per-cell
backgrounds; reverse video still works, because that's how the real machine
faked backgrounds.

## ttyd: one file, one flag

[ttyd](https://github.com/tsl0922/ttyd) (MIT) replaces its client page with
`--index`. Build the single-file page, then:

```sh
node xterm/build.mjs                       # → xterm/dist/ttyd-crt.html
ttyd --writable --index xterm/dist/ttyd-crt.html bash
```

That's the whole deployment: `dist/ttyd-crt.html` inlines `crt-xterm.js` +
`crt.js` + `tube.js` + `demo/font.js` (all ours); xterm.js and the fit addon
come from the jsDelivr CDN at page load. The page implements ttyd's
WebSocket protocol (subprotocol `tty`; client sends
`{AuthToken, columns, rows}` then `'0'+input` / `'1'+resize-JSON` /
`'2'`=pause / `'3'`=resume; server sends `'0'+output` / `'1'+title` /
`'2'+preferences`), including flow control and auto-reconnect — verified
against ttyd main (`html/src/components/terminal/xterm/index.ts`).

Server-pushed preferences work too: `--client-option crtPhosphor=P39`
steers the addon (any `crt*` key), other keys fall through to xterm.js
options.

The page has a collapsible knob panel (phosphor / mask / brightness /
flicker / strict-1979, persisted in localStorage) and a **CRT** button that
toggles back to the stock renderer. Opened without a ttyd behind it (e.g.
from `python3 serve.py`), it drops into a local-echo demo mode; `?ws=`
overrides the WebSocket URL for pointing a dev page at a live ttyd.

### volta-platform integration

Each ttyd instance only needs one extra start argument — no volta code
changes:

1. Copy `xterm/dist/ttyd-crt.html` somewhere the service can read
   (e.g. `/opt/volta/assets/ttyd-crt.html`).
2. Add `--index /opt/volta/assets/ttyd-crt.html` to that instance's ttyd
   command line.
3. Reverse-proxy config is untouched: the page derives `/token` and `/ws`
   from its own URL, exactly like the stock client, so path-mounted
   instances keep working.

## Development

- `xterm/ttyd-crt.html` is the dev page *and* the build template; it loads
  real ES modules between the `BUILD:BUNDLE` markers, which
  `node xterm/build.mjs` replaces with the inlined bundle.
- `build.mjs` is a zero-dependency bundler that only understands this
  repo's code style, and throws rather than emit anything it didn't prove
  it handled.
- Tests: `node --test test-crt-xterm.mjs` (headless — the raster core takes
  fake buffer objects; the build test evaluates the emitted bundle).

## Known limits

- **ASCII only.** Printable ASCII (lowercase included) has hand-drawn 5×7
  glyphs; everything else — CJK, box drawing, emoji — renders as a
  checkerboard tofu. Japanese output is explicitly out of scope here.
- Selection highlight and cursor are re-drawn by the addon (hardware-style
  reverse video); xterm decorations/overlays and IME preview are not
  visible while the CRT is on.
- Visual output is **not** verified headless — the pipeline is tested to
  the RGBA bytes, the actual glow needs eyeballs.
- The dist page needs the CDN reachable once per load (xterm.js is MIT but
  not ours to embed).

## License

MIT, like the rest of this repo. The single-file build embeds only our own
code (`crt.js`, `tube.js`, `demo/font.js` — the font is hand-drawn, public
domain, ours). xterm.js (MIT) and ttyd (MIT) are used as external
dependencies and are not redistributed here.
