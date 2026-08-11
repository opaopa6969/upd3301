**English** · [日本語](./smoke.ja.md)

# Browser smoke test

`demo/machine.html` is ~3200 lines built by six agents who never opened it in a
browser. Every other test in this repo drives an emulator **core**; none of them
mount the page, click a menu, or press a key. This harness does, in a real
headless Chrome, for all nine machines.

```sh
npm run smoke              # or: node tools/smoke.mjs
node tools/smoke.mjs --json        # machine-readable report on stdout
node tools/smoke.mjs --no-fakeroms # skip the synthetic-ROM phase
CHROME_PATH=/path/to/chrome npm run smoke
```

Exit code is 0 when every check that *could* run passed. Screenshots and
`report.json` land in [`docs/smoke-shots/`](./smoke-shots/) and are committed, so
the evidence for a given commit is in the tree next to the code.

## What it is made of

- `tools/cdp.mjs` — a ~200-line Chrome DevTools Protocol client over Node's
  global `WebSocket`. **Zero dependencies**, matching the rest of the repo.
  It does not download a browser; it finds one already on the machine
  (`~/.cache/puppeteer`, `~/.cache/ms-playwright`, `/usr/bin/google-chrome`,
  `chromium`, …) and reports honestly when there is none.
- `tools/smoke.mjs` — a static file server from `node:http`, plus the checks.
- `tools/fakeroms.mjs` — synthetic ROM images. **Not dumps**: correct headers and
  reset vectors, otherwise zeros and a small loop. They exist because the demo
  builds no machine object until a ROM is loaded, and its key handler opens with
  `if (!machine) return` — so a ROM-less smoke test presses keys into a void and
  learns nothing. They are fed in through the page's **own file inputs**, so the
  picker wiring is tested end to end rather than bypassed.

The one real ROM is the Game Boy's: `gbroms/dmg-acid2.gb.gz` (MIT, Matt Currie)
already ships with the repo.

## Result of the run recorded here

Chrome 148.0.7778.97 headless, WSL2 · **125 checks, 125 pass, 0 fail, 0 skip.**

| Machine | Mode switch | Picker in 📁 menu | ROM loads | Frames advance | Right machine live | Keys | Screenshot |
|---|---|---|---|---|---|---|---|
| PC-8001 | ok | ok | ok (synthetic) | ok | ok `80x25 hsync=15360Hz` | ok | [n80.png](./smoke-shots/n80.png) |
| PC-8801 | ok | ok | ok (synthetic) | ok | ok `hsync=` | ok | [n88.png](./smoke-shots/n88.png) |
| Famicom | ok | ok | ok (synthetic) | ok | ok (board named) | ok | [nes.png](./smoke-shots/nes.png) |
| PC Engine | ok | ok | ok (synthetic) | ok | ok (board named) | ok | [pce.png](./smoke-shots/pce.png) |
| Mega Drive | ok | ok | ok (synthetic) | ok | ok (region named) | ok | [md.png](./smoke-shots/md.png) |
| Game Boy | ok | ok | **ok (real ROM)** | ok | ok | ok | [gb.png](./smoke-shots/gb.png) |
| X68000 | ok | ok | ok (synthetic) | ok | ok `640x512 31kHz` | ok | [x68.png](./smoke-shots/x68.png) |
| Arcade (Seta) | ok | ok | ok (synthetic) | ok | ok `Thunder & Lightning … ROT270` | ok | [seta.png](./smoke-shots/seta.png) |
| PC-9801 | ok | ok | ok (synthetic) | ok | ok `640x400` | ok | [pc98.png](./smoke-shots/pc98.png) |

Also checked: the first-visit tour appears and ESC dismisses it; all six menus
open on a real mouse click; every one of the nine ROM pickers is visible inside
the open 📁 menu **and raises a real file chooser when clicked**; pause, jog,
shuttle, the ◀◀ rewind button and the speed selector; the clean/CRT toggle, the
pad-config panel, the soft keyboard (and pressing its keys), PNG export, reset.

**Console output: three 404s, all expected and all for optional resources** —
`/roms/manifest.json` (optional ROM manifest), `/favicon.ico` (not served by the
test server), `/api/store/ping` (the per-user ROM store, which only exists behind
`serve.py`). No exceptions, no warnings, nothing else.

## What is NOT verified

Be clear about this — a green run does not mean the page is right.

- **Real ROMs, on eight of nine machines.** The synthetic images prove the
  machine constructs, steps, renders and takes input. They do **not** prove a
  commercial game boots. Only the Game Boy is verified against a real ROM.
- **Pixel accuracy.** Only the Game Boy is checked for "a picture came out, and
  it is not one flat colour" ([gb-dmg-acid2-canvas.png](./smoke-shots/gb-dmg-acid2-canvas.png),
  the dmg-acid2 face). The core tests own accuracy; this harness does not.
- **Two machines legitimately render black here.** The PC-8801 and X68000 draw
  text from a font the *caller* supplies, and no font ROM ships with the repo, so
  their synthetic runs are blank by construction. That is not a failure and it is
  not evidence of correctness either.
- **Sound.** The audio worklet starts (it says so on the console) but nothing
  listens to the output.
- **Anything a human eye judges**: layout on a small screen, colour, whether the
  CRT simulation looks like a CRT, whether the Japanese reads well.
- **Other browsers.** Chromium only. No Firefox, no Safari, no mobile.
- **Gamepad input.** The Gamepad API cannot be driven from CDP, so `applyPad`'s
  gamepad half is exercised only through the keyboard half that shares its bit
  translation.
- **The ICE and IDE windows** (`bice` / `bide` open new windows) are not opened.

## Bugs this found

1. **The render loop went silent on a machine that draws nothing.** When
   `renderMachine()` returned a 0×0 frame — normal for the first frames after
   reset, permanent for a ROM that never programs the CRTC — the loop did
   `requestAnimationFrame(loop); return;` **before** updating the status line and
   the player bar. The result was indistinguishable from a ROM that had failed to
   load: the status line still showed the *previous* machine's message and the
   frame counter sat at 0 while the CPU was in fact running.
   **Fixed** in `demo/machine.html`: skip the drawing, still report. The status
   line now reads e.g. `PC-8001/N80 0.7ms/frame frame=125 pc=0001h 0x0 hsync=0Hz`,
   which says both "it is running" and "its CRTC is not programmed".
   Guarded by the `render · a 0x0 frame still updates the status line` check.

2. **The first-visit tour swallows every click, including automated ones.** Not a
   defect — `tour.js` is a full-viewport `position:fixed` overlay at `z-index:9999`
   that auto-starts 700 ms after load, by design, and any click on it dismisses
   it. But it means *anything* driving this page must dismiss the tour first, and
   the harness's first attempt silently clicked the overlay instead of the menu.
   Recorded as a check (`tour · auto-starts on first visit` / `ESC dismisses it` /
   `nothing overlays the menu bar afterwards`) rather than changed.

3. (Harness bug, for the record.) The PC-8001's boot ROM and the PC-8801's
   optional N-mode ROM are both called `n80.rom`. Writing both into one temp
   directory silently gave the 8001 the 8801's image — which is what surfaced
   bug 1. Each machine now gets its own directory.

## The picker regression this was built to catch

The four pickers that had gone missing from the 📁 menu (Mega Drive, X68000,
Seta, PC-9801) are present and clickable — see
[menu-file.png](./smoke-shots/menu-file.png), which shows all nine. The check is
deliberately strict: the input must be inside the **open** panel, have a non-zero
bounding box, and produce a `Page.fileChooserOpened` event when clicked. A
detached or hidden clone fails all three.
