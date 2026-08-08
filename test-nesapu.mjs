// test-nesapu — the APU, the DMC's grip on the CPU, and the second wave of
// cartridge boards.
//
// The APU is the one part of this machine that produces a stream rather than a
// state, so the tests come in two flavours: the ones that check the chip's
// *timing* (which is what games actually depend on — the frame counter is an
// IRQ source before it is a sound source) and the ones that check the sample
// stream stays deterministic across a snapshot/restore, because rewind is the
// reason this whole console is here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NesApu, LENGTH_TABLE } from './nesapu.js';
import { NesMachine } from './machinenes.js';
import { buildINes, parseINes } from './ines.js';
import { MAPPERS, createMapper, supportedMappers, MIRROR } from './nesmapper.js';

// A cartridge whose reset vector points at a program we hand in. Same helper
// shape as test-nes.mjs so the two files read alike.
function cartWith(code, { mapper = 0, prgBanks = 2, chr = 8192, at = 0x8000 } = {}) {
  const prg = new Uint8Array(prgBanks * 0x4000);
  prg.set(code, at - 0x8000);
  // Vectors live in the last bank, which is where every board maps $FFFA-$FFFF.
  const v = prg.length - 6;
  prg[v] = 0x00; prg[v + 1] = 0x80;         // NMI  -> $8000
  prg[v + 2] = at & 0xff; prg[v + 3] = at >> 8; // RESET
  prg[v + 4] = 0x00; prg[v + 5] = 0x80;     // IRQ  -> $8000
  return parseINes(buildINes({ mapper, prg, chr: chr ? new Uint8Array(chr) : null }));
}

const runFrames = (m, n) => { for (let i = 0; i < n; i++) m.stepFrame(); return m; };

// ---------------------------------------------------------------------------
// The frame counter

test('apu: the 4-step frame counter raises its IRQ 29831 cycles after $4017=$00', () => {
  const apu = new NesApu();
  apu.write(0x17, 0x00);
  // The flag latches, so "how long is it set" has to be measured by clearing
  // it every cycle and asking whether the sequencer put it back.
  let firstSet = -1, lastSet = -1;
  for (let c = 1; c <= 40000; c++) {
    apu.tick();
    if (apu.frameIrq) { if (firstSet < 0) firstSet = c; lastSet = c; apu.frameIrq = false; }
    if (firstSet >= 0 && c > firstSet + 10) break;
  }
  // The write itself is cycle 0; the flag comes up on 29831 and stays up for
  // three cycles, which is what lets a polling loop catch it at all.
  assert.equal(firstSet, 29831, 'first set');
  assert.equal(lastSet, 29833, 'still set two cycles later');
});

test('apu: $4017 bit 6 inhibits the IRQ and clears a pending one', () => {
  const apu = new NesApu();
  apu.write(0x17, 0x00);
  for (let c = 0; c < 29840; c++) apu.tick();
  assert.equal(apu.frameIrq, true);
  apu.write(0x17, 0x40);
  assert.equal(apu.frameIrq, false, 'writing the inhibit bit acknowledges too');
  for (let c = 0; c < 60000; c++) apu.tick();
  assert.equal(apu.frameIrq, false, 'and no new one arrives');
});

test('apu: 5-step mode never interrupts, and clocks the sequence on the write', () => {
  const apu = new NesApu();
  apu.write(0x15, 0x01);
  apu.write(0x03, 0x08);            // load pulse 1's length counter
  const loaded = apu.pulse1.length;
  assert.equal(loaded, LENGTH_TABLE[1]);
  apu.write(0x17, 0x80);            // 5-step: half frame happens immediately
  for (let i = 0; i < 4; i++) apu.tick(); // let the 3-4 cycle delay expire
  assert.equal(apu.pulse1.length, loaded - 1, 'the immediate half-frame ticked it');
  for (let c = 0; c < 100000; c++) { apu.tick(); assert.equal(apu.frameIrq, false); }
});

test('apu: reading $4015 acknowledges the frame IRQ but not the DMC IRQ', () => {
  const apu = new NesApu();
  apu.write(0x17, 0x00);
  for (let c = 0; c < 29840; c++) apu.tick();
  assert.equal(apu.readStatus() & 0x40, 0x40);
  assert.equal(apu.frameIrq, false, 'the read cleared it');

  apu.dmc.irq = true;
  assert.equal(apu.readStatus() & 0x80, 0x80);
  assert.equal(apu.dmc.irq, true, 'only a $4015 WRITE clears the DMC flag');
  apu.write(0x15, 0);
  assert.equal(apu.dmc.irq, false);
});

// ---------------------------------------------------------------------------
// Length counters and channels

test('apu: $4015 disables a channel by zeroing its length, and blocks reloads', () => {
  const apu = new NesApu();
  apu.write(0x15, 0x0f);
  for (const [reg, ch] of [[0x03, 'pulse1'], [0x07, 'pulse2'], [0x0b, 'triangle'], [0x0f, 'noise']]) {
    apu.write(reg, 0x28);
    assert.ok(apu[ch].length > 0, `${ch} loaded`);
  }
  apu.write(0x15, 0x00);
  for (const ch of ['pulse1', 'pulse2', 'triangle', 'noise']) {
    assert.equal(apu[ch].length, 0, `${ch} cleared`);
  }
  apu.write(0x03, 0x28);
  assert.equal(apu.pulse1.length, 0, 'a disabled channel ignores a length load');
});

test('apu: the halt bit suspends length clocking', () => {
  const apu = new NesApu();
  apu.write(0x15, 0x01);
  apu.write(0x00, 0x20);   // halt = 1
  apu.write(0x03, 0x28);
  const len = apu.pulse1.length;
  apu.write(0x17, 0x80);   // 5-step: immediate half frame
  for (let i = 0; i < 4; i++) apu.tick();
  assert.equal(apu.pulse1.length, len, 'halted: not clocked');
});

test('apu: the sweep unit mutes a pulse whose period is below 8', () => {
  const apu = new NesApu();
  apu.write(0x15, 0x01);
  apu.write(0x00, 0x3f);   // constant volume 15, halt so the length survives
  apu.write(0x03, 0x28);
  apu.pulse1.setPeriod(0x100);
  apu.pulse1.step = 1;     // a duty step that is "on"
  assert.ok(apu.pulse1.output > 0);
  apu.pulse1.setPeriod(4);
  assert.equal(apu.pulse1.output, 0, 'periods under 8 are silenced by the sweep unit');
});

test('apu: the noise LFSR is 15 bits and its short mode has a 93-step period', () => {
  const apu = new NesApu();
  apu.noise.mode = true;
  apu.noise.shift = 1;
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    seen.add(apu.noise.shift);
    apu.noise.timer = 0; apu.noise.tick();
  }
  assert.equal(seen.size, 93, 'short mode repeats after 93 steps');
  assert.ok(!seen.has(0), 'the register never reaches zero, so it never locks up');
});

// ---------------------------------------------------------------------------
// The mixer and the sample stream

test('apu: silence is silence, and the mix is non-linear', () => {
  const apu = new NesApu();
  assert.equal(apu.mix(), 0, 'nothing enabled -> exactly zero, not a DC offset');
  apu.pulse1.enabled = true; apu.pulse1.length = 10;
  apu.pulse1.env.constant = true; apu.pulse1.env.volume = 15;
  apu.pulse1.setPeriod(0x100); apu.pulse1.step = 1;
  const one = apu.mix();
  apu.pulse2.enabled = true; apu.pulse2.length = 10;
  apu.pulse2.env.constant = true; apu.pulse2.env.volume = 15;
  apu.pulse2.setPeriod(0x100); apu.pulse2.step = 1;
  const two = apu.mix();
  assert.ok(two > one, 'two channels are louder than one');
  assert.ok(two < one * 2, 'but not twice as loud — the DAC is a resistor ladder');
});

test('apu: render() drains the ring and holds the last sample on underrun', () => {
  const apu = new NesApu({ sampleRate: 48000 });
  apu.write(0x15, 0x01);
  apu.write(0x00, 0x3f);
  apu.write(0x02, 0x00); apu.write(0x03, 0x29); // audible period, long length
  for (let c = 0; c < 20000; c++) apu.tick();
  const produced = apu.pending;
  assert.ok(produced > 500, `produced ${produced} samples in 20k cycles`);
  const out = new Float32Array(produced + 32);
  apu.render(out, out.length);
  assert.equal(apu.pending, 0);
  for (let i = produced; i < out.length; i++) {
    assert.equal(out[i], out[produced - 1], 'underrun holds, it does not click to zero');
  }
});

test('apu: the sample rate is honoured to better than 1%', () => {
  const apu = new NesApu({ sampleRate: 48000, cpuHz: 1789772.7272727273 });
  const cycles = 1789772;
  for (let c = 0; c < cycles; c++) { apu.tick(); if (apu.pending > 15000) apu.ringTail = apu.ringHead; }
  // Count what a full second produced by draining as we go.
  const apu2 = new NesApu({ sampleRate: 48000, ringSize: 65536 });
  let n = 0;
  for (let c = 0; c < 89488; c++) { const before = apu2.pending; apu2.tick(); if (apu2.pending > before) n++; }
  assert.ok(Math.abs(n - 2400) < 24, `${n} samples in 1/20 s, expected ~2400`);
});

// ---------------------------------------------------------------------------
// Determinism — the reason the whole machine exists

test('apu: same writes and cycles -> identical sample stream', () => {
  const drive = (apu) => {
    apu.write(0x15, 0x0f);
    apu.write(0x00, 0x8f); apu.write(0x02, 0x40); apu.write(0x03, 0x2a);
    apu.write(0x04, 0x4a); apu.write(0x06, 0x80); apu.write(0x07, 0x18);
    apu.write(0x08, 0xff); apu.write(0x0a, 0x20); apu.write(0x0b, 0x10);
    apu.write(0x0c, 0x3a); apu.write(0x0e, 0x05); apu.write(0x0f, 0x08);
    for (let c = 0; c < 60000; c++) apu.tick();
    const out = new Float32Array(apu.pending);
    apu.render(out, out.length);
    return out;
  };
  const a = drive(new NesApu()), b = drive(new NesApu());
  assert.equal(a.length, b.length);
  assert.deepEqual(Array.from(a), Array.from(b));
});

test('apu: snapshot -> run ahead -> restore -> replay gives the same samples', () => {
  const apu = new NesApu();
  apu.write(0x15, 0x0f);
  apu.write(0x00, 0x8f); apu.write(0x02, 0x40); apu.write(0x03, 0x2a);
  apu.write(0x0c, 0x3a); apu.write(0x0e, 0x03); apu.write(0x0f, 0x08);
  for (let c = 0; c < 5000; c++) apu.tick();

  const snap = apu.getState();
  // restore() drops undrained samples on purpose (they belong to a future that
  // has been rewound away), so drain here to compare like with like.
  apu.render(new Float32Array(apu.pending), apu.pending);
  const first = new Float32Array(400);
  for (let c = 0; c < 20000; c++) apu.tick();
  apu.render(first, first.length);

  apu.setState(snap);
  const again = new Float32Array(400);
  for (let c = 0; c < 20000; c++) apu.tick();
  apu.render(again, again.length);

  assert.deepEqual(Array.from(again), Array.from(first),
    'the resampler phase and filter memory are part of the state, so the stream repeats');
});

test('apu: getState carries no sample buffer', () => {
  const apu = new NesApu();
  for (let c = 0; c < 100000; c++) apu.tick();
  const json = JSON.stringify(apu.getState());
  assert.ok(json.length < 1200, `APU state is ${json.length} bytes of JSON — did the ring leak in?`);
  assert.ok(apu.pending > 2000, 'and there really were samples waiting');
});

// ---------------------------------------------------------------------------
// The DMC's grip on the CPU

test('machine: a DMC fetch steals four CPU cycles', () => {
  // JMP to itself: the CPU does nothing but burn cycles, so any extra ones
  // came from the sample fetch.
  const cart = cartWith([0x4c, 0x00, 0x80]);
  const m = new NesMachine({ cart });
  runFrames(m, 2);

  // A frame is a fixed number of PPU dots, so a DMA does not make the frame
  // longer — it makes the CPU get less done inside it. Measure per instruction.
  const steps = 20000;
  const idle = (() => {
    const q = new NesMachine({ cart });
    runFrames(q, 2);
    const c0 = q.cpu.cycles;
    for (let i = 0; i < steps; i++) q.cpu.step();
    return q.cpu.cycles - c0;
  })();

  m.apu.write(0x10, 0x0f);   // fastest rate, no loop, no IRQ
  m.apu.write(0x12, 0x00);   // sample at $C000
  m.apu.write(0x13, 0xff);   // a long sample
  m.apu.write(0x15, 0x10);   // start it
  const c0 = m.cpu.cycles;
  for (let i = 0; i < steps; i++) m.cpu.step();
  const withDmc = m.cpu.cycles - c0;
  assert.ok(withDmc > idle, `DMC stole cycles: ${withDmc} vs ${idle} idle`);
  // Rate 15 is one byte every 54*8 = 432 cycles, and 20000 JMPs are 60000
  // cycles, so ~139 fetches at 4 cycles each.
  const stolen = withDmc - idle;
  assert.ok(stolen > 300 && stolen < 900, `stolen cycles out of range: ${stolen}`);
});

test('machine: the DMC IRQ reaches the CPU and $4015 reports it', () => {
  const cart = cartWith([0x4c, 0x00, 0x80]);
  const m = new NesMachine({ cart });
  runFrames(m, 2);
  m.apu.write(0x10, 0x8f);   // IRQ enabled, no loop
  m.apu.write(0x12, 0x00);
  m.apu.write(0x13, 0x01);   // 17 bytes: ends quickly
  m.apu.write(0x15, 0x10);
  runFrames(m, 4);
  assert.equal(m.apu.dmc.irq, true, 'the sample ended and raised its IRQ');
  assert.ok(m.apu.peekStatus() & 0x80);
  assert.ok(m.cpu.irqLine !== 0, 'and the line is asserted');
});

test('machine: renderAudio has the same shape as the 8801 machine', () => {
  const m = new NesMachine({ cart: cartWith([0x4c, 0x00, 0x80]) });
  runFrames(m, 3);
  const buf = new Float32Array(800);
  const out = m.renderAudio(buf, buf.length);
  assert.equal(out, buf, 'fills in place and returns the buffer');
  assert.ok(buf.every((v) => Number.isFinite(v) && v >= -2 && v <= 2), 'sane sample range');
});

test('machine: adding the APU did not blow up the snapshot', () => {
  const m = new NesMachine({ cart: cartWith([0x4c, 0x00, 0x80]) });
  runFrames(m, 120);
  const s = m.snapshot();
  const json = JSON.stringify(s, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
  const apuJson = JSON.stringify(s.apu);
  assert.ok(apuJson.length < 800, `APU share of the snapshot is ${apuJson.length} bytes`);
  assert.ok(json.length < 60000, `whole snapshot is ${json.length} bytes`);
});

test('machine: a full snapshot/restore replays the same audio', () => {
  const m = new NesMachine({ cart: cartWith([0x4c, 0x00, 0x80]) });
  runFrames(m, 5);
  m.apu.write(0x15, 0x0f);
  m.apu.write(0x00, 0x8f); m.apu.write(0x02, 0x40); m.apu.write(0x03, 0x2a);
  const snap = m.snapshot();
  m.renderAudio(new Float32Array(m.apu.pending), m.apu.pending); // drain, see above

  const a = new Float32Array(1600);
  runFrames(m, 4); m.renderAudio(a, a.length);
  m.restore(snap);
  const b = new Float32Array(1600);
  runFrames(m, 4); m.renderAudio(b, b.length);
  assert.deepEqual(Array.from(b), Array.from(a));
});

// ---------------------------------------------------------------------------
// The new boards

test('mappers: the registry grew and every entry constructs', () => {
  const have = supportedMappers();
  for (const n of [0, 1, 2, 3, 4, 7, 9, 10, 11, 21, 22, 23, 24, 25, 26, 34, 66, 69, 71, 73, 75, 79, 87, 180, 206, 232]) {
    assert.ok(have.includes(n), `mapper ${n} missing`);
  }
  for (const n of have) {
    const cart = parseINes(buildINes({ mapper: n, prg: new Uint8Array(0x20000), chr: new Uint8Array(0x20000) }));
    const mp = createMapper(cart);
    assert.equal(typeof mp.cpuRead(0x8000), 'number');
    assert.equal(typeof mp.ppuRead(0x0000), 'number');
    // Every board must round-trip its own registers; forgetting saveRegs is
    // the classic mapper bug that only shows up when you rewind.
    const s = mp.getState();
    mp.setState(s);
    assert.deepEqual(mp.getState(), s, `mapper ${n} state round trip`);
  }
});

test('mapper 66 (GxROM): one byte picks both a 32KB PRG and an 8KB CHR bank', () => {
  const prg = new Uint8Array(0x20000); const chr = new Uint8Array(0x8000);
  for (let b = 0; b < 4; b++) prg[b * 0x8000] = 0xa0 + b;
  for (let b = 0; b < 4; b++) chr[b * 0x2000] = 0xc0 + b;
  const mp = createMapper(parseINes(buildINes({ mapper: 66, prg, chr })));
  mp.regWrite(0x8000, 0x21); // PRG bank 2, CHR bank 1
  assert.equal(mp.cpuRead(0x8000), 0xa2);
  assert.equal(mp.ppuRead(0x0000), 0xc1);
});

test('mapper 9 (MMC2): the CHR bank follows what the PPU fetched', () => {
  const chr = new Uint8Array(0x20000);
  for (let b = 0; b < 32; b++) chr[b * 0x1000] = b;
  const mp = createMapper(parseINes(buildINes({ mapper: 9, prg: new Uint8Array(0x20000), chr })));
  mp.regWrite(0xb000, 3);  // $0000 window, latch state FD
  mp.regWrite(0xc000, 7);  // $0000 window, latch state FE
  mp.ppuRead(0x0fd8);      // trigger: switch to the FD bank
  assert.equal(mp.ppuRead(0x0000), 3);
  mp.ppuRead(0x0fe8);      // trigger: switch to the FE bank
  assert.equal(mp.ppuRead(0x0000), 7);
  // MMC2 latches on the exact address; MMC4's range must not fire here.
  mp.ppuRead(0x0fd9);
  assert.equal(mp.ppuRead(0x0000), 7, 'MMC2 ignores $0FD9');
});

test('mapper 10 (MMC4): latches on the whole $?FD8-$?FDF range', () => {
  const chr = new Uint8Array(0x20000);
  for (let b = 0; b < 32; b++) chr[b * 0x1000] = b;
  const mp = createMapper(parseINes(buildINes({ mapper: 10, prg: new Uint8Array(0x20000), chr })));
  mp.regWrite(0xb000, 3); mp.regWrite(0xc000, 7);
  mp.ppuRead(0x0fe8); assert.equal(mp.ppuRead(0x0000), 7);
  mp.ppuRead(0x0fdd); assert.equal(mp.ppuRead(0x0000), 3, 'MMC4 does latch on $0FDD');
});

test('mapper 69 (FME-7): the IRQ counter counts down and wraps into an IRQ', () => {
  const mp = createMapper(parseINes(buildINes({ mapper: 69, prg: new Uint8Array(0x20000), chr: new Uint8Array(0x2000) })));
  assert.equal(mp.wantsCpuCycle, true);
  mp.regWrite(0x8000, 14); mp.regWrite(0xa000, 0x05); // counter low  = 5
  mp.regWrite(0x8000, 15); mp.regWrite(0xa000, 0x00); // counter high = 0
  mp.regWrite(0x8000, 13); mp.regWrite(0xa000, 0x81); // enable counter + IRQ
  for (let i = 0; i < 5; i++) { mp.cpuCycle(); assert.equal(mp.irq, false); }
  mp.cpuCycle();
  assert.equal(mp.irq, true, 'fires as it passes through zero');
});

test('mapper 69 (FME-7): $6000 is a fourth PRG window unless told to be RAM', () => {
  const prg = new Uint8Array(0x20000);
  for (let b = 0; b < 16; b++) prg[b * 0x2000] = 0x40 + b;
  const mp = createMapper(parseINes(buildINes({ mapper: 69, prg, chr: new Uint8Array(0x2000) })));
  mp.regWrite(0x8000, 8); mp.regWrite(0xa000, 0x05);  // bank 5, ROM (bit6 clear)
  assert.equal(mp.cpuRead(0x6000), 0x45);
  mp.regWrite(0x8000, 8); mp.regWrite(0xa000, 0xc0);  // RAM, enabled
  mp.cpuWrite(0x6000, 0x99);
  assert.equal(mp.cpuRead(0x6000), 0x99);
});

test('mapper 23 (VRC4): the IRQ timer runs in both cycle and scanline mode', () => {
  const mk = () => createMapper(parseINes(buildINes({ mapper: 23, prg: new Uint8Array(0x20000), chr: new Uint8Array(0x20000) })));
  const cyc = mk();
  cyc.regWrite(0xf000, 0x00); cyc.regWrite(0xf001, 0x0f); // latch = $F0
  cyc.regWrite(0xf002, 0x06);                              // enable, cycle mode
  let n = 0; while (!cyc.irq && n < 100) { cyc.cpuCycle(); n++; }
  assert.equal(n, 16, 'counts up from $F0 to $FF then fires');

  const scan = mk();
  scan.regWrite(0xf000, 0x00); scan.regWrite(0xf001, 0x0f);
  scan.regWrite(0xf002, 0x02);                             // enable, scanline mode
  n = 0; while (!scan.irq && n < 4000) { scan.cpuCycle(); n++; }
  // 16 clocks at 341/3 CPU cycles each. The fraction is the point: a whole
  // number of cycles per scanline would drift across a frame.
  assert.ok(Math.abs(n - 16 * 341 / 3) < 4, `scanline mode fired after ${n} cycles`);
});

test('mapper 21/22/23/25 (VRC2/4): the register index comes off different address lines', () => {
  const mk = (n) => createMapper(parseINes(buildINes({ mapper: n, prg: new Uint8Array(0x20000), chr: new Uint8Array(0x20000) })));
  // $9000 index 0 is mirroring on every revision; the index-1 address differs.
  const m23 = mk(23); m23.regWrite(0x9001, 1);
  assert.equal(m23.mirroring, MIRROR.HORIZONTAL, 'mapper 23: A0 carries index bit 0');
  const m25 = mk(25); m25.regWrite(0x9002, 1);
  assert.equal(m25.mirroring, MIRROR.HORIZONTAL, 'mapper 25: A0 and A1 are crossed');
  const m21 = mk(21); m21.regWrite(0x9002, 1);
  assert.equal(m21.mirroring, MIRROR.HORIZONTAL, 'mapper 21: index bit 0 is A1');
});

test('mapper 22 (VRC2a): CHR bank numbers are in 2KB units', () => {
  const chr = new Uint8Array(0x20000);
  for (let b = 0; b < 128; b++) chr[b * 0x400] = b;
  const mp = createMapper(parseINes(buildINes({ mapper: 22, prg: new Uint8Array(0x20000), chr })));
  // On VRC2a the written value is twice the 1KB bank, so 8 selects bank 4.
  mp.regWrite(0xb000, 8);   // low nibble of CHR slot 0 (A1/A0 crossed: $B000 -> index 0)
  assert.equal(mp.ppuRead(0x0000), 4);
});

test('mapper 232 (Quattro): the block register picks four banks at a time', () => {
  const prg = new Uint8Array(0x20000);
  for (let b = 0; b < 8; b++) prg[b * 0x4000] = 0x50 + b;
  const mp = createMapper(parseINes(buildINes({ mapper: 232, prg, chr: new Uint8Array(0x2000) })));
  mp.regWrite(0x8000, 1 << 3); // block 1
  mp.regWrite(0xc000, 2);      // bank 2 within it
  assert.equal(mp.cpuRead(0x8000), 0x56, 'block 1 bank 2 = absolute bank 6');
  assert.equal(mp.cpuRead(0xc000), 0x57, '$C000 is always the last bank of the block');
});

test('mapper 180 (UNROM 180): the fixed bank is the FIRST one', () => {
  const prg = new Uint8Array(0x20000);
  for (let b = 0; b < 8; b++) prg[b * 0x4000] = 0x60 + b;
  const mp = createMapper(parseINes(buildINes({ mapper: 180, prg, chr: new Uint8Array(0x2000) })));
  mp.regWrite(0x8000, 5);
  assert.equal(mp.cpuRead(0x8000), 0x60, '$8000 never moves');
  assert.equal(mp.cpuRead(0xc000), 0x65, '$C000 is the switchable window');
});

test('mapper 79 (NINA-003): the register lives below $6000', () => {
  const prg = new Uint8Array(0x10000);
  prg[0] = 0x11; prg[0x8000] = 0x22;
  const mp = createMapper(parseINes(buildINes({ mapper: 79, prg, chr: new Uint8Array(0x4000) })));
  assert.equal(mp.cpuRead(0x8000), 0x11);
  mp.cpuWrite(0x4100, 0x08);
  assert.equal(mp.cpuRead(0x8000), 0x22, 'PRG bank 1');
});

test('mappers: every new board runs a frame in the real machine without throwing', () => {
  for (const n of supportedMappers()) {
    const cart = cartWith([0x4c, 0x00, 0x80], { mapper: n, prgBanks: 8, chr: 0x8000 });
    const m = new NesMachine({ cart });
    runFrames(m, 3);
    const snap = m.snapshot();
    runFrames(m, 2);
    m.restore(snap);
    assert.equal(m.frame, snap.frame, `mapper ${n} restored`);
  }
});
