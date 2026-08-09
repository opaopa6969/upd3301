#!/usr/bin/env node
// pcetools/pcerun — run one PC Engine HuCard headless and describe what came
// out. The counterpart to nestools/fdsrun.mjs, and it has the same problem:
// there is no oracle. No reference emulator is installed, no known-good
// screenshot of any of these 1169 titles is in the repository, and nothing in
// a .pce file says what it is supposed to look like.
//
// nestools solved that for the Disk System by finding a SECOND, INDEPENDENT
// thing to look at besides pixels — where the CPU was. The FDS BIOS owns the
// vblank wait, so "is the CPU executing the game's own code or only BIOS?" is a
// fact about the machine rather than a guess about the picture.
//
// A HuCard has no BIOS. There is no address range that means "not the game".
// So the second signal here is a different one: HOW MUCH CODE IS BEING
// EXECUTED. A PC Engine game that is running touches hundreds of distinct
// addresses every frame — an interrupt handler, a main loop, a music driver, a
// sprite updater. A game that has fallen over does one of three things, and all
// three are visible:
//
//   JMP *            one address
//   a polling loop   two to six addresses, forever
//   a crash into an  a handful, usually with the stack walking
//   unmapped bank
//
// So: run, then step a fixed number of instructions and count DISTINCT program
// counters. The threshold is measured, not chosen — see docs/pce-design.md §9
// and the numbers pcetools/sweep.mjs prints.
//
//   node pcetools/pcerun.mjs game.pce [--frames N] [--art] [--press run]

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { tryParsePce, summarizePce } from '../pcerom.js';
import { PceMachine, BUTTON } from '../machinepce.js';
import { MAX_WIDTH } from '../huc6270.js';

const RAMP = ' .:-=+*#%@';

// Twenty frames' worth of instructions at full speed. Long enough that a game
// blocked on a vblank wait still gets several turns round its main loop, short
// enough to stay cheap over a thousand titles.
const PROBE_INSTRUCTIONS = 200000;

export function runRom(bytes, {
  frames = 1800, name = 'rom', press = null, sampleEvery = 4, japanese = true,
  padSelDirections = true, cart = null,
} = {}) {
  if (!cart) {
    const parsed = tryParsePce(bytes);
    if (!parsed.ok) return { name, ok: false, error: parsed.error, code: parsed.code };
    cart = parsed.cart;
  }
  const parsed = { cart };
  let m;
  try {
    m = new PceMachine({ cart, japanese, padSelDirections });
  } catch (e) {
    return { name, ok: false, error: e.message, code: 'build-failed' };
  }

  const buttons = press
    ? press.split(',').map((k) => BUTTON[k.trim().toUpperCase()]).filter((b) => b !== undefined)
    : [];
  let prev = null, changed = 0, firstNonBlank = -1, maxColours = 0, frozen = 0;
  let vramPrev = 0, vramChanges = 0;
  for (let f = 0; f < frames; f++) {
    if (buttons.length) {
      // Tap, do not hold: a title screen waiting for a press needs the edge and
      // a menu that debounces needs the release.
      const down = (f % 40) < 8;
      for (const b of buttons) { if (down) m.padDown(b, 0); else m.padUp(b, 0); }
    }
    m.stepFrame();
    if (f % sampleEvery === 0) {
      const st = quickStats(m.frameBuf, m.frameWidth, m.frameHeight);
      if (firstNonBlank < 0 && st.colours > 1) firstNonBlank = f;
      // The BEST frame, not the last one. nestools learned this the expensive
      // way: a game spends much of its first minute on logos and black screens,
      // so "what was on screen when the run ended" answers the wrong question.
      if (st.colours > maxColours) maxColours = st.colours;
      if (prev !== null && st.hash !== prev) { changed++; frozen = 0; } else frozen += sampleEvery;
      prev = st.hash;
      const vh = hashWords(m.vdc.vram);
      if (vh !== vramPrev) { vramChanges++; vramPrev = vh; }
    }
  }

  const probe = codeProbe(m);
  return {
    name, ok: true, machine: m, cart: parsed.cart, info: summarizePce(parsed.cart),
    stats: fullStats(m.frameBuf, m.frameWidth, m.frameHeight),
    firstNonBlank, changedFrames: changed, maxColours, frozenFrames: frozen,
    vramChanges,
    distinctPc: probe.distinct,
    ramPc: probe.ram,
    jammed: m.cpu.jammed,
    // Measured on this library, not chosen: see docs/pce-design.md §9. The
    // animation condition is the belt to that brace — a machine drawing 10% of
    // its samples differently is alive whatever the instruction count says.
    dead: probe.distinct < 64 && changed * 10 < Math.max(1, Math.floor(frames / sampleEvery)),
    video: {
      width: m.frameWidth, height: m.frameHeight,
      bg: (m.vdc.reg[0x05] & 0x80) !== 0, spr: (m.vdc.reg[0x05] & 0x40) !== 0,
      irqEnable: m.vdc.reg[0x05] & 0x0f, irqMask: m.cpu.irqMask,
      dotClock: m.vce.ctrl & 3,
    },
  };
}

// How many DIFFERENT addresses does this machine execute? A bitmap over the
// 16-bit logical space, because that is what "the CPU is going round in a small
// circle" is a statement about. The count of instructions that landed in RAM is
// tracked separately: a game whose code runs from work RAM (a decompressor, a
// music driver copied out of ROM) is alive even if its ROM footprint is small.
function codeProbe(m) {
  const seen = new Uint8Array(0x10000);
  let distinct = 0, ram = 0;
  for (let i = 0; i < PROBE_INSTRUCTIONS; i++) {
    const pc = m.cpu.pc;
    if (!seen[pc]) { seen[pc] = 1; distinct++; }
    if (m.mpr[pc >> 13] === 0xf8) ram++;
    if (m.cpu.jammed) break;
    m.cpu.step();
  }
  return { distinct, ram };
}

function hashWords(a) {
  let h = 2166136261;
  for (let i = 0; i < a.length; i += 61) h = ((h ^ a[i]) * 16777619) >>> 0;
  return h;
}

// A cheap per-frame fingerprint. A full histogram every frame costs more than
// the emulation; this is only ever asked "did the picture change".
function quickStats(buf, w, h) {
  let hash = 2166136261;
  const seen = new Map();
  for (let y = 0; y < h; y++) {
    const o = y * MAX_WIDTH;
    for (let x = 0; x < w; x += 3) {
      const v = buf[o + x];
      hash = ((hash ^ v) * 16777619) >>> 0;
      if (!seen.has(v)) seen.set(v, 1);
    }
  }
  return { hash, colours: seen.size };
}

export function fullStats(buf, w, h) {
  const hist = new Map();
  const n = w * h;
  for (let y = 0; y < h; y++) {
    const o = y * MAX_WIDTH;
    for (let x = 0; x < w; x++) {
      const v = buf[o + x];
      hist.set(v, (hist.get(v) || 0) + 1);
    }
  }
  let top = 0, topIdx = 0;
  for (const [c, k] of hist) if (k > top) { top = k; topIdx = c; }
  return { pixels: n, colours: hist.size, topColour: topIdx, topPct: (top / n) * 100 };
}

export function thumbnail(buf, w, h, cols = 64, rows = 30) {
  let s = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0, n = 0;
      const x0 = ((c * w) / cols) | 0, x1 = Math.max(x0 + 1, (((c + 1) * w) / cols) | 0);
      const y0 = ((r * h) / rows) | 0, y1 = Math.max(y0 + 1, (((r + 1) * h) / rows) | 0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = buf[y * MAX_WIDTH + x];
          // 9-bit GGGRRRBBB -> rough luminance
          sum += (((v >> 6) & 7) * 0.587 + ((v >> 3) & 7) * 0.299 + (v & 7) * 0.114) / 7;
          n++;
        }
      }
      s += RAMP[Math.min(RAMP.length - 1, ((sum / n) * RAMP.length) | 0)];
    }
    s += '\n';
  }
  return s;
}

function main(argv) {
  const args = argv.slice(2);
  const file = args[0];
  if (!file) { console.error('usage: node pcetools/pcerun.mjs <game.pce> [--frames N] [--art]'); process.exit(2); }
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const r = runRom(new Uint8Array(readFileSync(file)), {
    frames: parseInt(opt('--frames', '1800'), 10),
    press: opt('--press', null),
    name: basename(file),
    padSelDirections: !args.includes('--pad-flip'),
  });
  if (!r.ok) { console.log(`FAIL ${r.name}: ${r.error}`); process.exit(1); }
  console.log(`${r.name}`);
  console.log(`  ${r.info.board}${r.info.hadHeader ? ' (512B header)' : ''}${r.info.bitReversed ? ' (bit-reversed)' : ''}${r.info.superGrafx ? ' (SuperGrafx)' : ''} reset=$${r.info.resetVector.toString(16)}${r.info.warnings.length ? '  warn: ' + r.info.warnings.join('; ') : ''}`);
  console.log(`  video ${r.video.width}x${r.video.height} dot=${r.video.dotClock} bg=${r.video.bg} spr=${r.video.spr} vdcIrq=$${r.video.irqEnable.toString(16)} irqMask=$${r.video.irqMask.toString(16)}`);
  console.log(`  colours=${r.stats.colours} (best ${r.maxColours}) top=$${r.stats.topColour.toString(16)} (${r.stats.topPct.toFixed(1)}%) firstNonBlank=${r.firstNonBlank} animated=${r.changedFrames} vramChanges=${r.vramChanges}`);
  console.log(`  cpu pc=$${r.machine.cpu.pc.toString(16)} distinctPc=${r.distinctPc} ramPc=${r.ramPc} jammed=${r.jammed} dead=${r.dead}`);
  console.log(`  mpr=[${Array.from(r.machine.mpr).map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`);
  if (args.includes('--art')) console.log(thumbnail(r.machine.frameBuf, r.machine.frameWidth, r.machine.frameHeight));
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
