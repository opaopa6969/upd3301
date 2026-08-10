#!/usr/bin/env node
// nestools/fdsrun — run one Famicom Disk System image headless and describe
// what came out, the same way nestools/screenshot.mjs does for a cartridge.
//
// A disk takes seconds to load on real hardware, and this emulator keeps that
// (the drive really does move one byte every 149 CPU cycles), so the default
// frame count is much higher than a cartridge needs: the BIOS's disk-insert
// screen, the load, and then the game's own title. 900 frames is 15 seconds.
//
// Neither the BIOS nor the disks are in this repository. See
// docs/nes-design.md §12 for where they live and how to check them.
//
//   FDS_BIOS=/path/disksys.rom node nestools/fdsrun.mjs game.fds [--frames N]
//
// Options:
//   --frames N   frames to run (default 900)
//   --bios PATH  the 8KB FDS BIOS (or set FDS_BIOS)
//   --side N     start on this disk side (default 0)
//   --art        print an ASCII thumbnail
//   --trace      print what the drive did (block reads, seeks, IRQs)
//   --press K    hold/tap a button for the whole run (start/a/b/select)

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { tryParseFds, makeFdsCart, summarizeFds } from '../fds.js';
import { NesMachine, BUTTON } from '../machinenes.js';

const RAMP = ' .:-=+*#%@';

export function loadBios(path = process.env.FDS_BIOS) {
  if (!path) throw new Error('no FDS BIOS: pass --bios or set FDS_BIOS (see docs/nes-design.md §12)');
  const b = new Uint8Array(readFileSync(path));
  if (b.length !== 8192) throw new Error(`FDS BIOS must be 8192 bytes, got ${b.length}: ${path}`);
  return b;
}

// Run a disk and report both the picture and what the drive was doing. The
// second half matters as much as the first: a disk that shows a blank screen
// because the drive never moved is a different bug from one that loaded fine
// and then hung, and only the drive counters tell them apart.
export function runDisk(bytes, {
  frames = 900, bios, side = 0, press = null, name = 'disk', sampleEvery = 1,
  autoFlip = true, flipAfter = 240,
} = {}) {
  const parsed = tryParseFds(bytes);
  if (!parsed.ok) return { name, ok: false, error: parsed.error, code: parsed.code };
  let m;
  try {
    m = new NesMachine({ cart: makeFdsCart(parsed.image, bios) });
  } catch (e) {
    return { name, ok: false, error: e.message, code: 'build-failed' };
  }
  if (side) m.disk.insert(side);

  const buttons = press ? press.split(',').map((k) => BUTTON[k.trim().toUpperCase()]).filter((b) => b !== undefined) : [];
  let prev = null, changed = 0, firstNonBlank = -1, maxPos = 0, resets = 0, lastReset = false, maxColours = 0;
  // A two-sided game stops dead and puts "turn the disk over" on the screen,
  // and a headless sweep has no hands. So the sweep grows some: if the drive
  // has been idle for four seconds and the disk has another side, turn it over.
  // That is what a player would do, and without it every multi-disk title in
  // the library counts as a failure for a reason that has nothing to do with
  // the emulation.
  let idle = 0, lastPos = -1, flips = 0, frozen = 0;
  for (let f = 0; f < frames; f++) {
    if (buttons.length) {
      // Tap rather than hold: a title screen that waits for a press needs the
      // edge, and a menu that debounces needs the release.
      const down = (f % 40) < 8;
      for (const b of buttons) { if (down) m.padDown(b, 0); else m.padUp(b, 0); }
    }
    m.stepFrame();
    if (m.disk.pos > maxPos) maxPos = m.disk.pos;
    if (m.disk.resetTransfer && !lastReset) resets++;
    lastReset = m.disk.resetTransfer;
    if (autoFlip && m.diskSides > 1) {
      // Idle head AND frozen picture. The head alone is not enough: a game
      // that is actually being played leaves the drive alone for minutes, and
      // ejecting the disk under it would be the sweep breaking the thing it
      // is measuring.
      idle = (m.disk.pos === lastPos && frozen >= flipAfter) ? idle + 1 : 0;
      lastPos = m.disk.pos;
      if (idle >= flipAfter) {
        m.setDiskSide((m.disk.side + 1) % m.diskSides, { ejectFrames: 4 });
        idle = 0; frozen = 0; flips++;
      }
    }
    if (f % sampleEvery === 0) {
      const st = quickStats(m.ppu.frameBuf);
      if (firstNonBlank < 0 && st.colours > 1) firstNonBlank = f;
      // The BEST frame, not the last one. A disk game spends a lot of its
      // first minute on a black screen — between the BIOS's load, the
      // publisher's logo and the game's own second load — so sampling the
      // final frame answers "what was on screen at second 20", which is not
      // the question. "Did this machine ever draw a real picture" is.
      if (st.colours > maxColours) maxColours = st.colours;
      if (prev !== null && st.hash !== prev) { changed++; frozen = 0; }
      else frozen += sampleEvery;
      prev = st.hash;
    }
  }
  const probe = biosProbe(m);
  return {
    name, ok: true, machine: m, image: parsed.image, info: summarizeFds(parsed.image),
    stats: fullStats(m.ppu.frameBuf), firstNonBlank, changedFrames: changed, maxColours,
    frozenFrames: frozen,
    ownCode: probe,
    // Measured, not picked: over 200,000 instructions after a 3600-frame run,
    // the two titles that are visibly dead score 420 and 460, the quietest
    // title that is visibly alive scores 2,795, and everything else scores
    // 160,000-200,000. 1,000 sits in the gap. The animation condition is the
    // belt to that brace — a game drawing 10% of its samples differently is
    // running whatever the instruction count says.
    stuck: probe < 1000 && changed * 10 < Math.max(1, Math.floor(frames / sampleEvery)),
    biosCode: m.ram[0x90],
    drive: {
      maxPos, resets, flips, side: m.disk.side, inserted: m.disk.inserted,
      endOfDisk: m.disk.endOfDisk, motorOn: m.disk.motorOn,
      writes: m.disk.writes.size,
    },
  };
}

// The BIOS is the only oracle this sweep has, and asking it the right question
// takes care. "Did the run end with the PC inside BIOS ROM?" is useless: the
// FDS BIOS owns the vblank wait, so a game that is running perfectly ends
// almost every frame parked in the BIOS's spin loop at $E1C5. Using that as
// the test marks working games as broken — it did, on four titles.
//
// What separates them is what happens NEXT. A running game leaves the wait and
// executes thousands of instructions in adapter RAM every frame; a machine that
// has given up executes nothing but BIOS. So step the machine a few frames'
// worth of instructions and count where they land. If essentially none of them
// are the game's own code, the BIOS has stopped, and $90 is the number it
// stopped on.
//
// The window has to be generous. Twenty frames is long enough that a game
// waiting on vblank still gets a turn, and short enough to stay cheap. What it
// is NOT is a substitute for running long enough in the first place: a title
// that is still loading at frame 2400 executes no code of its own either, and
// looks exactly like one that died (磁界少年メット・マグ is the example — at
// 2400 frames it reads as stuck, at 3600 it is playing).
const BIOS_PROBE = 200000; // ~20 frames of instructions
function biosProbe(m) {
  let own = 0;
  for (let i = 0; i < BIOS_PROBE; i++) {
    if (m.cpu.pc < 0xe000) own++;
    if (m.cpu.jammed) break;
    m.cpu.step();
  }
  return own;
}

// A cheap per-frame fingerprint. A full colour histogram every frame costs more
// than the emulation does; this is only asked "did the picture change".
function quickStats(buf) {
  let hash = 2166136261, colours = 0;
  const seen = new Uint8Array(64);
  for (let i = 0; i < buf.length; i += 7) {
    hash = ((hash ^ buf[i]) * 16777619) >>> 0;
  }
  for (let i = 0; i < buf.length; i++) { const c = buf[i] & 0x3f; if (!seen[c]) { seen[c] = 1; colours++; } }
  return { hash, colours };
}

export function fullStats(buf) {
  const hist = new Uint32Array(64);
  for (let i = 0; i < buf.length; i++) hist[buf[i] & 0x3f]++;
  let colours = 0, top = 0, topIdx = 0;
  for (let c = 0; c < 64; c++) { if (hist[c]) colours++; if (hist[c] > top) { top = hist[c]; topIdx = c; } }
  return {
    pixels: buf.length, colours, topColour: topIdx,
    topPct: (top / buf.length) * 100,
    nonTopPct: 100 - (top / buf.length) * 100,
  };
}

export function thumbnail(buf, cols = 64, rows = 30) {
  const W = 256, H = 240;
  let s = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0, n = 0;
      const x0 = ((c * W) / cols) | 0, x1 = (((c + 1) * W) / cols) | 0;
      const y0 = ((r * H) / rows) | 0, y1 = (((r + 1) * H) / rows) | 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += LUMA[buf[y * W + x] & 0x3f]; n++; }
      s += RAMP[Math.min(RAMP.length - 1, ((sum / n) * RAMP.length) | 0)];
    }
    s += '\n';
  }
  return s;
}

// Rough luminance of the 64 NES colours, 0..1 — good enough to read a title
// screen out of a terminal.
const LUMA = (() => {
  const a = new Float32Array(64);
  for (let i = 0; i < 64; i++) {
    const lum = i & 0x0f, row = i >> 4;
    let v = lum === 0 ? 0.25 : lum <= 0x0c ? 0.35 + 0.05 * (row) : lum === 0x0d ? 0.05 : 0;
    if (lum >= 0x0e) v = 0;
    a[i] = Math.min(1, v * (1 + row * 0.25));
  }
  a[0x0f] = 0; a[0x1d] = 0;
  a[0x20] = a[0x30] = 1;
  return a;
})();

function main(argv) {
  const args = argv.slice(2);
  const file = args[0];
  if (!file) { console.error('usage: node nestools/fdsrun.mjs <disk.fds> [--frames N] [--bios PATH] [--art]'); process.exit(2); }
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const bios = loadBios(opt('--bios', process.env.FDS_BIOS));
  const r = runDisk(new Uint8Array(readFileSync(file)), {
    frames: parseInt(opt('--frames', '900'), 10),
    bios, side: parseInt(opt('--side', '0'), 10),
    press: opt('--press', null), name: basename(file),
  });
  if (!r.ok) { console.log(`FAIL ${r.name}: ${r.error}`); process.exit(1); }
  console.log(`${r.name}`);
  console.log(`  game=${r.info.game} sides=${r.info.sides} files=[${r.info.files.join(',')}]${r.info.warnings.length ? ' warn=' + r.info.warnings.join('; ') : ''}`);
  console.log(`  colours=${r.stats.colours} topColour=$${r.stats.topColour.toString(16)} (${r.stats.topPct.toFixed(1)}%) firstNonBlank=${r.firstNonBlank} animated=${r.changedFrames}`);
  console.log(`  drive: maxPos=${r.drive.maxPos} resets=${r.drive.resets} flips=${r.drive.flips} side=${r.drive.side} eod=${r.drive.endOfDisk} motor=${r.drive.motorOn} writes=${r.drive.writes}`);
  console.log(`  cpu pc=$${r.machine.cpu.pc.toString(16)} frame=${r.machine.frame}`);
  if (args.includes('--art')) console.log(thumbnail(r.machine.ppu.frameBuf));
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
