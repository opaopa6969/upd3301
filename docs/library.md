**English** · [日本語](./library.ja.md)

# Using the pieces as libraries

Everything in this repo is an ES module with zero dependencies, no DOM
access, and deterministic behavior — which means every layer is a library
whether it wanted to be one or not. `package.json` exposes them as subpath
exports:

```js
import { Upd3301 } from 'upd3301';            // the CRTC itself
import { CrtPhosphor, PHOSPHORS } from 'upd3301/crt';
import { CrtTube } from 'upd3301/tube';
import { Terminal } from 'upd3301/term';
import { Z80 } from 'upd3301/z80';
```

(The repo is private/unpublished; consume it via a git URL, a workspace
path, or a plain `<script type="module">` importmap like the demos do.)

## The layer map

```
L3  glass    crt.js (phosphor)  tube.js (mask/geometry)   ← framebuffer-in,
L2  content  term.js (ANSI)     semivideo.js (video)         RGBA-out; knows
L1  boards   pc8001.js machine.js machine88.js pc80s31.js    nothing of chips
L0  chips    index.js(3301) upd8257 i8255 upd765 z80
             d88.js (media)
```

Dependencies point strictly downward; **L3 does not import anything** from
the layers below. That is the part that matters for reuse:

## CRT as a pure renderer (for anything)

`crt.js` + `tube.js` take a framebuffer and return RGBA. They do not care
where the pixels came from — a 3301, your game, a terminal, a video:

```js
import { CrtPhosphor, PHOSPHORS } from 'upd3301/crt';
import { CrtTube } from 'upd3301/tube';

const W = 640, H = 200;
const phos = new CrtPhosphor({ width: W, height: H, phosphor: PHOSPHORS.P22 });
const tube = new CrtTube({
  srcWidth: W, srcHeight: H, outWidth: W, outHeight: H * 2,
  mask: 'aperture', maskPitch: 3, barrel: 0.06,
});

// per frame:
phos.step(indexedPixels, 1 / 60);       // Uint8Array of 0..7 color indices
// or: phos.stepAnalog(rgbaPixels, 1/60) for full-color sources
tube.apply(phos.composite(), imageData.data, { scale: 1.2 });
ctx.putImageData(imageData, 0, 0);
```

That is the whole renderer contract. Phosphor decay, burn-in, per-gun
convergence, shadow masks, barrel distortion and glass reflection all
happen between those two calls. Extras live in `crt.js` as pure functions:
`collapseScan` (power-off), `rollScan` (V-HOLD), `tintMatrix` (NTSC tint).

## Terminal as a component

`term.js` is a small ANSI-escape terminal that compiles its screen into the
3301's attribute format — think "xterm.js that renders like 1979":

```js
import { Terminal } from 'upd3301/term';

const t = new Terminal({ cols: 80, rows: 25 });
t.write('\x1b[31mhello \x1b[7m1979\x1b[0m\r\n');
const frame = t.render({ cgrom });  // → { width, height, pixels } indices
// feed frame.pixels into CrtPhosphor above
```

### On xterm.js

xterm.js is MIT-licensed, so both forking it and embedding it are fine
(keep the copyright notice, that's all). But the cleaner integration is not
a fork: xterm.js renders through **pluggable renderer addons** (that's what
its canvas/WebGL renderers are). A `crt-xterm` addon that pulls cell glyphs
from xterm.js's buffer and pushes them through `CrtPhosphor`/`CrtTube`
would give a real, full-featured terminal wearing real glass — no fork to
maintain, licenses compatible (MIT on both sides).

## Machines as libraries

```js
import { Pc8001Machine } from 'upd3301/machine';    // Z80+ROM+3301+8257(+PC-8012 banks)
import { Pc8801Machine } from 'upd3301/machine88';  // + banks, GVRAM, FDD sub-system
import { parseD88 } from 'upd3301/d88';
```

All headless: `machine.stepFrame()` then `machine.render()` /
`machine.screenText()`. ROMs are bring-your-own, never bundled.
