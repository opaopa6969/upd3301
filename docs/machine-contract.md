**English** · [日本語](./machine-contract.ja.md)

# The machine contract

Every machine in this repository — PC-8001, PC-8801, Famicom, PC Engine, Mega Drive, X68000, the Seta arcade board, PC-9801, Game Boy — satisfies one small interface, and the host in `demo/machine.html` implements fast-forward, rewind, jog-shuttle and the ICE's branching undo tree on top of that interface and nothing else. **Satisfy the contract and time travel comes for free.** Break it and time travel breaks quietly, in a way nobody notices for two days.

`test-contract.mjs` is that contract as executable checks. It runs **without any ROM**, on every machine module it finds, and it fails if you add a machine and forget to list it.

This document is for the person adding the tenth machine. [§1](#1-the-interface) is the interface, [§2](#2-the-checks) is what is checked and which accident each check comes from, [§3](#3-adding-a-machine-to-the-suite) is how to put a new machine under it, [§4](#4-what-is-known-to-be-broken) is what is currently failing and why.

---

## 1. The interface

```js
class YourMachine {
  constructor(opts)               // throws if it cannot boot (no ROM, bad image)
  schemaVersion                   // === the module's exported SCHEMA_VERSION
  frame                           // frames run since power-on
  stepFrame()                     // run exactly one video frame; returns this
  update(dt, onFrame)             // accumulate real time, emit whole frames
  snapshot()                      // → plain data, everything mutable, nothing immutable
  restore(s)                      // write s back into the LIVE objects
  render(opts)                    // → { width, height, rgb | pixels, schemaVersion }
  renderAudio(out, n)             // fill a mono Float32Array; returns samples written
}
export const SCHEMA_VERSION = 1;
export function createYourMachine(opts) { return new YourMachine(opts); }
```

Three properties carry all the weight:

**Determinism.** Same construction, same inputs, same number of `stepFrame()` calls → byte-identical machine. No `Math.random`, no `Date.now`, no uninitialised memory, no iteration order that depends on insertion.

**`snapshot()` is complete and `restore()` is total.** Complete: everything that affects the future is in it — including clocks, debts, latches and phase counters, which is where it always goes wrong. Total: `restore()` writes every one of those fields back, into objects that may never have seen that frame.

**The picture belongs to the snapshot.** See [§2.6](#26-restoring-a-snapshot-brings-its-picture-back). This is the one that looks wrong and is right.

## 2. The checks

`test-contract.mjs` runs ten cases against every machine. Each one exists because something specific went wrong.

### 2.0 `the screen actually moves`

Not a contract check — a check on the tests. Every picture assertion below compares two pictures, and two blank screens are equal. So the synthetic program for each machine has to repaint the screen every frame, and this case proves it does before anything trusts it.

`test-gb.mjs` says it best: *"A ROM whose PICTURE moves, which counterRom()'s does not: with no tile data uploaded, every pixel of every frame is colour 0 and a rewind test against it cannot fail."*

It bites in both directions. The PC-8001 program had a wrong DMA terminal count and the screen froze after frame 1 — with the rest of the suite still passing. The PC-9801 program used a free-running counter and produced nine distinct screens in twenty frames; it now waits on the text GDC's VSYNC bit.

### 2.1 `the same program run twice lands in the same place`

Two fresh machines, same program, N frames, compare. Catches a clock, `Math.random`, or an uninitialised buffer before snapshots are even involved.

### 2.2 `restoring a snapshot replays the identical timeline`

Forward, snapshot, forward, restore, forward again — land on the same state. This is the property the rewind ring, the jog-shuttle and the ICE's undo tree are all built on.

### 2.3 `a snapshot restores onto a different machine instance`

**This is the case that catches a field missing from `restore()` entirely.** Restoring in place passes by accident whenever a field is never written back, because the live object still holds the right value. A machine that has never been to that frame has no such safety net.

Origin: on 2026-08-10 the PC-8801's sub-CPU clock (`_subMark` / `_subDebt`) was missing from `snapshot()`, so a restored machine ran its two CPUs at a different relative phase — invisible for a frame or two, then divergent. It sat on `main` for two days.

### 2.4 `the snapshot carries no ROM`

ROM is immutable and the machine already holds it, so a copy in every snapshot multiplies the rewind ring's memory by the ROM size for no information.

Checked **by content, not by size**. The suite fills the unused part of every ROM image with a marker byte and then looks for arrays that are entirely that byte, or that are byte-for-byte one of the images. A size threshold would be either too loose to catch anything or would fail for honest reasons — a PC-8801 snapshot is legitimately 64K of RAM plus 48K of GVRAM plus a sub board.

### 2.5 `the snapshot is plain data`

The snapshot tree may contain only numbers, strings, booleans, `null`, plain objects, plain arrays and typed arrays. A `Map`, a `Set`, a class instance, a function, `undefined` — anything else — is state the host cannot copy, and it does not complain on the way back, it just comes back empty.

Then the snapshot is copied (`structuredClone`, which is what the host's ring effectively does) and restored into a fresh machine, and the two are compared **immediately, before stepping**. Comparing after a few frames is how this class of bug hides: a running program overwrites its own work RAM within a frame or two, so a snapshot that lost the RAM entirely still converges to the right answer.

That is not hypothetical. `test-determinism.mjs` had a case that round-tripped the snapshot through `JSON.parse(JSON.stringify(...))` to "force plain data" and then ran fifteen frames before comparing. Both halves were wrong and they cancelled out — see [§4.1](#41-a-snapshot-does-not-survive-raw-json).

### 2.6 `restoring a snapshot brings its picture back`

**The frame buffer is part of the snapshot.**

Three of the machines here said otherwise, in almost the same words: *the frame buffers are output, regenerated by the next frame, snapshots are taken at frame boundaries.* Every clause of that is true and the conclusion is wrong, because **nobody steps a frame before showing the picture**. `demo/machine.html`'s `restoreIdx()` restores and does not step; the main loop then draws whatever `render()` returns. So a snapshot with no picture in it hands back the frame that was on screen when the user started scrubbing, and every slot of a 120-frame rewind ring shows frame 120.

Found on the Game Boy on 2026-08-10, by accident. `test-gb.mjs` puts it plainly:

> The Seta machine passed every contract test in this file and still landed on the wrong frame 61 times out of 250 when the host rewound, because its picture was a function of history rather than of state.

The size objection is answered by **packing, not by omitting**. A picture carries far fewer bits per pixel than the buffer it lives in, and `snap.js` has the helpers:

| machine | picture in the snapshot | cost |
|---|---|---|
| Game Boy (DMG) | 2 bits/pixel packed | 5,760 B |
| Game Boy (CGB) | raw `Uint16Array` | 46,080 B |
| Famicom | 6-bit palette index packed + emphasis run-length encoded | 46,084 B |
| PC Engine | the `frameWidth x frameHeight` window, 9 bits/pixel packed | 64,512 B at 256x224 |
| PC-8001 / PC-8801 / PC-9801 | *nothing* — `render()` re-derives the picture from state that is already in the snapshot | 0 B |
| Seta | *nothing* — `restore()` calls `video.drawFrame()` and re-derives it | 0 B |

The last two rows are the point: a machine whose `render()` is a pure function of snapshotted state needs no picture in the snapshot. **The contract is on the observable, not on the field.**

There are two checks, and the second one matters more: the same thing across instances, which is what a ring does after a reset. The destination has never drawn that frame, so nothing can be left over to make the comparison pass by accident. The X68000 fails only the second one for a second, independent reason — see [§4.3](#43-x68000-two-causes).

### 2.7 `schemaVersion is on the machine and on the snapshot`

The module exports `SCHEMA_VERSION`; the instance carries `schemaVersion`; `snapshot()` and `render()` both stamp it. A host that has to guess is a host that will guess wrong the first time the layout moves.

### 2.8 `every machine module in the tree is in the registry`

`readdirSync` for `machine*.js`, compared against the registry. **A machine that is not listed is a machine nobody is checking.** This is the check that makes the suite grow with the repository instead of quietly falling behind it.

## 3. Adding a machine to the suite

Add one entry to `REGISTRY` in `test-contract.mjs`:

```js
{
  id: 'yourmachine',
  title: 'Your Machine',
  module: './machineyours.js',
  export: 'YourMachine',
  branch: 'your-branch',        // omit once it is merged; skips with this reason until then
  build(M) {
    const { rom, images } = yourRom();
    return { m: new M({ rom }), images };   // `images` = the ROM images, for §2.4
  },
  step: (m) => m.stepFrame(),
  picture: (m) => m.render(),
  state: (m) => ({ /* read off the LIVE machine, never off snapshot() */ }),
}
```

Three things to get right.

**`state()` reads the live machine, not `snapshot()`.** If the fingerprint came from `snapshot()`, a field that `snapshot()` forgets would be invisible to the comparison and the test would agree with the bug. Include the CPU state, the frame counter, and a slice of memory **that the test program actually writes** — the Mega Drive entry writes its counter into work RAM purely so the fingerprint has something with content in it.

**`images` is every ROM image handed to the constructor.** §2.4 fills their unused tails with the marker byte and hunts for them in the snapshot.

**The program has to animate the screen.** No ROM: assemble it. `z80asm.js` exists for the Z80 machines; everything else is hand-assembled bytes with the meaning of each line in a comment. The cheapest moving picture is usually *the backdrop colour*, because it repaints every pixel with one register write and needs no tile data, no name table and no vblank handshake:

| architecture | how the synthetic program moves the screen |
|---|---|
| Z80 (PC-8801) | graphics plane on, GVRAM window at `C000`, scribble a moving pattern |
| Z80 (PC-8001) | program the μPD8257 + μPD3301 as N-BASIC does, then rewrite the top row once per VRTC edge |
| 6502 (Famicom) | rendering **off** — the 2C02 still paints every visible dot with palette entry 0 — and rewrite `$3F00` in a loop |
| HuC6280 (PC Engine) | VDC `CR = 0` (burst mode), rewrite VCE palette entry 0 |
| 68000 (Mega Drive) | VRAM all zero → every pixel is the backdrop; rewrite CRAM entry 0 |
| 68000 (X68000) | graphics page on, GVRAM all zero; rewrite graphics palette entry 0 |
| 68000 (Seta) | rewrite pen `$1F0`, the board's background pen |
| 8086 (PC-9801) | one text cell, rewritten **on the GDC's VSYNC edge** |
| SM83 (Game Boy) | upload one striped tile and a chequered map, then scroll one pixel per frame on `LY` |

And a warning the Game Boy taught this suite: **do not assert that the picture differs after a fixed number of frames.** `RUN` was 16 and the GB scroll program has a sixteen-frame period, so frame 40 was byte-identical to frame 24 and the guard fired on a machine that was behaving perfectly. The check now steps until the picture is demonstrably different.

**If a machine cannot pass a check today, make it a `todo` with the reason** — an `entry.todos` key per check id. `test-fdc-spec.mjs` set that precedent: a target you have not met is worth more written down than taken out. Never delete a check to make a machine pass.

## 4. What is known to be broken

### 4.1 A snapshot does not survive raw JSON

`todo` on every machine. Snapshots are built out of typed arrays, and `JSON.parse(JSON.stringify(a))` turns a `Uint8Array` into `{"0":…,"1":…}` — from which `TypedArray.set()` copies **zero** elements, **without throwing**. A raw JSON round-trip therefore empties every buffer in the snapshot in total silence.

Nothing in the repository does this today: the rewind ring and the ICE keep snapshots in memory, and `analysisdb.js` has its own format. It is latent, not live. Closing it means either `Array.from()` on every buffer — roughly eight bytes per byte in the ring, which is the thing the ring is budgeted against — or a tagged encoder both sides agree on. Neither is a per-machine change, so it is recorded rather than papered over, and the enforced contract is [§2.5](#25-the-snapshot-is-plain-data).

### 4.2 PC-8801

Two `todo`s, both one-line fixes, both in `machine88.js`, which was off-limits in the change that added this suite:

- `_snapFdc()` copies `drive._idx`, which `upd765.js` only creates on the first sector read, so an untouched drive puts `_idx: undefined` in the snapshot.
- The module exports `SCHEMA_VERSION` but neither the instance nor the snapshot carries `schemaVersion`.

### 4.3 Mega Drive

`mdvdp.js` keeps the picture out of `getState()`, and `machinemd.js` snapshots `sramDirty: undefined` until the game writes save RAM. Both verified against `origin/megadrive`; adding `frameRgb` to `getState()`/`setState()` makes both picture cases pass. 320x240x3 = 230,400 B is the lazy shape — `renderLine()` resolves CRAM to RGB per pixel, so a parallel 8-bit plane (6-bit CRAM entry plus two shadow/highlight bits) would be 76,800 B, and `snap.js`'s `packPixels` is already there for it.

### 4.4 X68000: two causes

The picture is missing from the snapshot, **and** the video's screen size is never re-derived on restore. `x68video.beginFrame()` is what copies the CRTC size into `width`/`height`, and only `stepFrame()` calls it — so a fresh machine that has been restored but not stepped renders a **1x1** picture. One line (`this.video.beginFrame()` at the end of `machinex68.restore()`) fixes that half; both verified against `origin/x68000`.

This is the case that only a restore onto a *different* instance can see, which is why [§2.3](#23-a-snapshot-restores-onto-a-different-machine-instance) and the second picture check exist.

### 4.5 PC-9801 renders into an aliased buffer

Not a failure, a trap. `pc98video.render()` returns its **internal** buffer when no `out` is given, so two successive results alias the same memory; every other machine allocates. The suite is safe because it reduces each picture to a key immediately, but a ring test that holds `render().rgb` will find all its slots identical for a reason that has nothing to do with snapshots.

---

## See also

- `test-contract.mjs` — the suite
- `test-determinism.mjs` — the PC-8801 original this generalises
- `test-gb.mjs` — the host rewind ring test that found the frame-buffer bug
- `snap.js` — `snapObj`/`restoreObj`, and the picture packing helpers
- [docs/nes-design.md](./nes-design.md) §5, [docs/gb-design.md](./gb-design.md) §12
