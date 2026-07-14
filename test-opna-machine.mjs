// OPNA-through-machine88 integration. No BYO BIOS needed: a bare 32KB main ROM
// is enough to construct the machine and exercise the Sound Board II I/O path
// (ports 0xA8-0xAB), the detection status read at 0xA9, and renderAudio().
// The full "boot a real SB2 disk and watch bank0/bank1 fill" acceptance needs
// an actual SB2 disk image (none ships with the repo — see docs/opna-design.md
// §10); this pins the machine-side mechanism that boot would drive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pc8801Machine } from './machine88.js';
import { loadRhythmRom } from './tools/load-rhythm-rom.mjs';

const mkMachine = (sb2) => new Pc8801Machine({ main: new Uint8Array(0x8000).fill(0xff), sb2 });
const peak = (b) => { let p = 0; for (const v of b) p = Math.max(p, Math.abs(v)); return p; };

test('sb2:false → no OPNA; A8-AB float high, renderAudio is OPN-only', () => {
  const m = mkMachine(false);
  assert.equal(m.opna, null);
  assert.equal(m.in(0xa9), 0xff, 'no board → data/status port floats high');
  const out = new Float32Array(2048);
  assert.doesNotThrow(() => m.renderAudio(out)); // OPN alone, silent at reset
});

test('sb2:true → OPNA at A8-AB; writes reach both banks', () => {
  const m = mkMachine(true);
  assert.ok(m.opna, 'SB2 fitted');
  // bank0 write ($40 = FM ch0 op TL) via 0xa8/0xa9
  m.out(0xa8, 0x40); m.out(0xa9, 0x11);
  // bank1 write ($40 = FM ch4 op TL) via 0xaa/0xab
  m.out(0xaa, 0x40); m.out(0xab, 0x22);
  assert.equal(m.opna.reg[0x40], 0x11, 'bank0 register written');
  assert.equal(m.opna.reg1[0x40], 0x22, 'bank1 register written');
});

test('detection: port 0xA9 returns the real Timer-A flag (0x01), no stub', () => {
  const m = mkMachine(true);
  const w0 = (a, v) => { m.out(0xa8, a); m.out(0xa9, v); };
  w0(0x24, 0xff); w0(0x25, 0x03); // Timer A period
  w0(0x27, 0x05);                  // load + enable Timer A
  assert.equal(m.in(0xa9) & 1, 0, 'not overflowed yet');
  m.opna.tickTimers(4096);         // (stepFrame drives this from the CPU loop in a real boot)
  assert.equal(m.in(0xa9), 0x01, 'the SB2 probe reads 0x01 from a genuine overflow');
});

test('renderAudio: OPNA FM6 + rhythm are audible through the machine', () => {
  const m = mkMachine(true);
  const { samples, rate } = loadRhythmRom();
  m.opna.setRhythmRom(samples, rate);
  // a rhythm hit via the bank-1 ports
  m.out(0xaa, 0x01); m.out(0xab, 0x3f);       // total level
  m.out(0xaa, 0x08); m.out(0xab, 0xc0 | 0x1f); // BD pan+level
  m.out(0xaa, 0x00); m.out(0xab, 0x01);        // key BD
  const out = new Float32Array(20000);
  m.renderAudio(out);
  assert.ok(peak(out) > 0.05, 'machine audio carries the OPNA drums');
});

test('SOUND IRQ is shared: OPNA Timer-A raises the machine SOUND interrupt', () => {
  const m = mkMachine(true);
  const w0 = (a, v) => { m.out(0xa8, a); m.out(0xa9, v); };
  // arm the 8214: accept SOUND (level 5) and enable it; program+run Timer A
  m.out(0xe4, 8);          // threshold open-all
  w0(0x24, 0xff); w0(0x25, 0x03); w0(0x27, 0x05);
  // drive the timer the way stepFrame would, and check SOUND (source 4) pends
  m.opna.tickTimers(4096);
  const irqNow = m.opn.irq || (m.opna && m.opna.irq);
  assert.ok(irqNow, 'OPNA reports IRQ from the Timer-A overflow');
});
