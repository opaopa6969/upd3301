// nesapu — the RP2A03's sound half: two pulses, a triangle, a noise channel,
// a DPCM player, and the frame counter that clocks them all.
//
// Pure JS, zero deps, deterministic. No DOM, no WebAudio: this file produces a
// plain Float32Array of samples and nothing else, exactly as ym2203.js does for
// the PC-8801. The host owns the audio device; the chip owns the numbers.
//
// ## Why it is clocked from the CPU and not pulled like the OPN
//
// ym2203.js advances its oscillators when render() asks for samples, because
// an FM chip is an independent clock domain: the Z80 writes registers, the chip
// plays. The 2A03 is not that chip. It IS the CPU — same die, same clock — and
// three of the things games depend on are CPU-cycle events, not audio events:
//
//   - the frame counter's IRQ, used as a general-purpose timer (blargg's
//     cpu_interrupts tests synchronise on it to the cycle),
//   - $4015's length-counter bits, polled by music drivers to decide when a
//     note has finished,
//   - the DMC's DMA, which *stops the CPU* for four cycles to fetch a byte.
//
// So tick() runs once per CPU cycle from the machine's clock, and the audio
// falls out of it: a box filter accumulates ~37 CPU cycles into one 48 kHz
// sample and pushes it into a ring that render() drains. Sound is an output of
// the simulation, not a driver of it — which is also what keeps rewind exact.
//
// ## Snapshot policy
//
// Everything the chip *is* (dividers, sequencers, envelopes, the DMC's shift
// register) is in getState(). The sample ring is NOT: it is output, like the
// PPU's frame buffer, and copying it into the host's 1000-snapshot rewind ring
// would cost more than the whole rest of the machine's state. The resampler's
// phase and filter memory ARE saved, so the *sequence of samples* produced
// after a restore is identical to the original run; only the handful of samples
// that had not been drained yet are lost, which is one audio buffer of silence
// at the moment you rewind and nothing after it.

export const SCHEMA_VERSION = 1;

// NTSC 2A03: the CPU clock, which is also the APU's.
export const NTSC_CPU_HZ = 1789772.7272727273;

// Length counter table. The odd entries are a linear 1..30 ramp, the even ones
// a set of musical note lengths — the hardware's own table, not a curve.
export const LENGTH_TABLE = Uint8Array.from([
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
]);

// Pulse duty cycles. Row 3 is row 1 negated, which is why 25% and "25% but
// upside down" sound identical alone and different when mixed against another
// pulse at the same frequency.
const DUTY = [
  Uint8Array.from([0, 1, 0, 0, 0, 0, 0, 0]),
  Uint8Array.from([0, 1, 1, 0, 0, 0, 0, 0]),
  Uint8Array.from([0, 1, 1, 1, 1, 0, 0, 0]),
  Uint8Array.from([1, 0, 0, 1, 1, 1, 1, 1]),
];

// Triangle: 32 steps down-then-up, so the DAC walks a staircase. There is no
// volume control at all — the only way to silence it is to stop the sequencer.
const TRI_SEQ = Uint8Array.from([
  15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
]);

// Noise and DMC periods, in CPU cycles (NTSC).
const NOISE_PERIOD = Uint16Array.from([
  4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
]);
const DMC_PERIOD = Uint16Array.from([
  428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54,
]);

// Frame counter, in CPU cycles. The 4-step sequence raises the IRQ on three
// consecutive cycles around the wrap, not one: a game that polls $4015 in a
// tight loop can catch it on any of them, and a one-cycle model makes
// blargg's apu_test/irq_flag_timing (and 5-branch_delays_irq, which
// synchronises on it) land two cycles off.
const F4_Q1 = 7457, F4_Q2 = 14913, F4_Q3 = 22371;
const F4_IRQ = 29828, F4_LAST = 29829, F4_WRAP = 29830;
const F5_Q3 = 29829, F5_LAST = 37281, F5_WRAP = 37282;

// Mixer lookup tables. The two DACs are non-linear (a resistor ladder into a
// common node), so summing the channels linearly gives a mix that is too loud
// when several channels play at once — audibly wrong on chords. These are the
// documented curves, precomputed.
const PULSE_TABLE = new Float32Array(31);
const TND_TABLE = new Float32Array(203);
for (let i = 0; i < 31; i++) PULSE_TABLE[i] = 95.52 / (8128 / i + 100);
for (let i = 0; i < 203; i++) TND_TABLE[i] = 163.67 / (24329 / i + 100);
PULSE_TABLE[0] = 0; TND_TABLE[0] = 0;

// ---------------------------------------------------------------------------
// A volume envelope: shared by both pulses and the noise channel.
class Envelope {
  constructor() { this.reset(); }
  reset() {
    this.constant = false; this.volume = 0; this.loop = false;
    this.start = false; this.divider = 0; this.decay = 0;
  }
  // $4000/$4004/$400C low bits.
  write(v) {
    this.loop = (v & 0x20) !== 0;
    this.constant = (v & 0x10) !== 0;
    this.volume = v & 0x0f;
  }
  // Clocked on quarter frames.
  clock() {
    if (this.start) { this.start = false; this.decay = 15; this.divider = this.volume; return; }
    if (this.divider > 0) { this.divider--; return; }
    this.divider = this.volume;
    if (this.decay > 0) this.decay--;
    else if (this.loop) this.decay = 15;
  }
  get output() { return this.constant ? this.volume : this.decay; }
  save() { return [this.constant ? 1 : 0, this.volume, this.loop ? 1 : 0, this.start ? 1 : 0, this.divider, this.decay]; }
  load(a) {
    this.constant = !!a[0]; this.volume = a[1]; this.loop = !!a[2];
    this.start = !!a[3]; this.divider = a[4]; this.decay = a[5];
  }
}

// ---------------------------------------------------------------------------
class Pulse {
  // `two` selects the second pulse's sweep, whose negate mode subtracts one
  // less — the reason a descending sweep on channel 1 and channel 2 with the
  // same registers end up a semitone apart.
  constructor(two) { this.two = two; this.env = new Envelope(); this.reset(); }
  reset() {
    this.enabled = false;
    this.duty = 0; this.step = 0;
    this.timer = 0; this.period = 0;   // period is in CPU cycles, = 2*(t+1)
    this.rawPeriod = 0;
    this.length = 0; this.halt = false;
    this.sweepEnabled = false; this.sweepPeriod = 0; this.sweepNegate = false;
    this.sweepShift = 0; this.sweepReload = false; this.sweepDivider = 0;
    this.env.reset();
  }

  write(reg, v) {
    switch (reg) {
      case 0: this.duty = v >> 6; this.halt = (v & 0x20) !== 0; this.env.write(v); break;
      case 1:
        this.sweepEnabled = (v & 0x80) !== 0;
        this.sweepPeriod = (v >> 4) & 7;
        this.sweepNegate = (v & 0x08) !== 0;
        this.sweepShift = v & 7;
        this.sweepReload = true;
        break;
      case 2: this.setPeriod((this.rawPeriod & 0x700) | v); break;
      case 3:
        this.setPeriod((this.rawPeriod & 0xff) | ((v & 7) << 8));
        if (this.enabled) this.length = LENGTH_TABLE[v >> 3];
        // The phase resets but the timer does not — writing $4003 in a loop
        // makes a buzz, not silence.
        this.step = 0;
        this.env.start = true;
        break;
      default: break;
    }
  }

  setPeriod(t) { this.rawPeriod = t & 0x7ff; this.period = this.rawPeriod * 2 + 1; }

  // The sweep unit mutes the channel when the target would be out of range,
  // even with the sweep disabled — which is how games silence a pulse by
  // writing a period below 8.
  get target() {
    const d = this.rawPeriod >> this.sweepShift;
    return this.sweepNegate ? this.rawPeriod - d - (this.two ? 0 : 1) : this.rawPeriod + d;
  }
  get muted() { return this.rawPeriod < 8 || this.target > 0x7ff; }

  clockSweep() {
    if (this.sweepDivider === 0 && this.sweepEnabled && this.sweepShift > 0 && !this.muted) {
      const t = this.target;
      if (t >= 0 && t <= 0x7ff) this.setPeriod(t);
    }
    if (this.sweepDivider === 0 || this.sweepReload) { this.sweepDivider = this.sweepPeriod; this.sweepReload = false; }
    else this.sweepDivider--;
  }

  clockLength() { if (this.length > 0 && !this.halt) this.length--; }

  tick() {
    if (this.timer > 0) { this.timer--; return; }
    this.timer = this.period;
    this.step = (this.step + 1) & 7;
  }

  get output() {
    if (!this.enabled || this.length === 0 || this.muted) return 0;
    return DUTY[this.duty][this.step] ? this.env.output : 0;
  }

  save() {
    return [
      this.enabled ? 1 : 0, this.duty, this.step, this.timer, this.period, this.rawPeriod,
      this.length, this.halt ? 1 : 0, this.sweepEnabled ? 1 : 0, this.sweepPeriod,
      this.sweepNegate ? 1 : 0, this.sweepShift, this.sweepReload ? 1 : 0, this.sweepDivider,
      ...this.env.save(),
    ];
  }
  load(a) {
    this.enabled = !!a[0]; this.duty = a[1]; this.step = a[2]; this.timer = a[3];
    this.period = a[4]; this.rawPeriod = a[5]; this.length = a[6]; this.halt = !!a[7];
    this.sweepEnabled = !!a[8]; this.sweepPeriod = a[9]; this.sweepNegate = !!a[10];
    this.sweepShift = a[11]; this.sweepReload = !!a[12]; this.sweepDivider = a[13];
    this.env.load(a.slice(14));
  }
}

// ---------------------------------------------------------------------------
class Triangle {
  constructor() { this.reset(); }
  reset() {
    this.enabled = false;
    this.step = 0; this.timer = 0; this.period = 0;
    this.length = 0; this.control = false;
    this.linear = 0; this.linearReload = 0; this.reloadFlag = false;
  }

  write(reg, v) {
    switch (reg) {
      case 0: this.control = (v & 0x80) !== 0; this.linearReload = v & 0x7f; break;
      case 2: this.period = (this.period & 0x700) | v; break;
      case 3:
        this.period = (this.period & 0xff) | ((v & 7) << 8);
        if (this.enabled) this.length = LENGTH_TABLE[v >> 3];
        this.reloadFlag = true;
        break;
      default: break;
    }
  }

  clockLinear() {
    if (this.reloadFlag) this.linear = this.linearReload;
    else if (this.linear > 0) this.linear--;
    if (!this.control) this.reloadFlag = false;
  }
  clockLength() { if (this.length > 0 && !this.control) this.length--; }

  // Clocked at the full CPU rate — one octave above the pulses for the same
  // period value.
  tick() {
    if (this.timer > 0) { this.timer--; return; }
    this.timer = this.period;
    // Periods of 0 or 1 put the sequencer above the audible range; the real
    // chip still runs it, producing an ultrasonic buzz that games use as
    // "off". Freezing it here would instead leave a DC step in the mix.
    if (this.length > 0 && this.linear > 0) this.step = (this.step + 1) & 31;
  }

  get output() {
    if (!this.enabled) return 0;
    if (this.period < 2) return 7; // ultrasonic: the DAC averages to mid-scale
    return TRI_SEQ[this.step];
  }

  save() {
    return [this.enabled ? 1 : 0, this.step, this.timer, this.period, this.length,
      this.control ? 1 : 0, this.linear, this.linearReload, this.reloadFlag ? 1 : 0];
  }
  load(a) {
    this.enabled = !!a[0]; this.step = a[1]; this.timer = a[2]; this.period = a[3];
    this.length = a[4]; this.control = !!a[5]; this.linear = a[6];
    this.linearReload = a[7]; this.reloadFlag = !!a[8];
  }
}

// ---------------------------------------------------------------------------
class Noise {
  constructor() { this.env = new Envelope(); this.reset(); }
  reset() {
    this.enabled = false;
    this.shift = 1;  // power-on value; a zero register would never leave zero
    this.mode = false;
    this.timer = 0; this.period = NOISE_PERIOD[0] - 1;
    this.length = 0; this.halt = false;
    this.env.reset();
  }

  write(reg, v) {
    switch (reg) {
      case 0: this.halt = (v & 0x20) !== 0; this.env.write(v); break;
      case 2: this.mode = (v & 0x80) !== 0; this.period = NOISE_PERIOD[v & 0x0f] - 1; break;
      case 3: if (this.enabled) this.length = LENGTH_TABLE[v >> 3]; this.env.start = true; break;
      default: break;
    }
  }

  clockLength() { if (this.length > 0 && !this.halt) this.length--; }

  tick() {
    if (this.timer > 0) { this.timer--; return; }
    this.timer = this.period;
    // 15-bit LFSR. The mode bit moves the tap from bit 1 to bit 6, which turns
    // the 32767-step pseudo-noise into a 93-step buzz — the "metallic" mode.
    const fb = (this.shift ^ (this.mode ? (this.shift >> 6) : (this.shift >> 1))) & 1;
    this.shift = (this.shift >> 1) | (fb << 14);
  }

  get output() {
    if (!this.enabled || this.length === 0 || (this.shift & 1)) return 0;
    return this.env.output;
  }

  save() {
    return [this.enabled ? 1 : 0, this.shift, this.mode ? 1 : 0, this.timer, this.period,
      this.length, this.halt ? 1 : 0, ...this.env.save()];
  }
  load(a) {
    this.enabled = !!a[0]; this.shift = a[1]; this.mode = !!a[2]; this.timer = a[3];
    this.period = a[4]; this.length = a[5]; this.halt = !!a[6];
    this.env.load(a.slice(7));
  }
}

// ---------------------------------------------------------------------------
// The DMC is the only channel that touches the CPU bus. It fetches a byte at a
// time from PRG space and, while it does, HALTS the processor — which is why it
// belongs in a CPU-clocked APU and why a game that plays samples during a
// scanline-timed raster split sees the split wobble. The stall is not modelled
// here (the machine owns the bus); this class only says "I need a byte now" and
// the machine performs the DMA and calls fill().
class Dmc {
  constructor() { this.reset(); }
  reset() {
    this.enabled = false;
    this.irqEnabled = false; this.irq = false; this.loop = false;
    this.period = DMC_PERIOD[0] - 1; this.timer = 0;
    this.output = 0;
    this.sampleAddr = 0xc000; this.sampleLen = 1;
    this.curAddr = 0xc000; this.bytesLeft = 0;
    this.buffer = 0; this.bufferFull = false;
    this.shift = 0; this.bitsLeft = 8; this.silence = true;
    this.needByte = false;
  }

  write(reg, v) {
    switch (reg) {
      case 0:
        this.irqEnabled = (v & 0x80) !== 0;
        this.loop = (v & 0x40) !== 0;
        this.period = DMC_PERIOD[v & 0x0f] - 1;
        if (!this.irqEnabled) this.irq = false;
        break;
      // Writing the level directly is how games play PCM by brute force
      // ("$4011 banging"): 7 bits straight into the DAC.
      case 1: this.output = v & 0x7f; break;
      case 2: this.sampleAddr = 0xc000 | (v << 6); break;
      case 3: this.sampleLen = (v << 4) | 1; break;
      default: break;
    }
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) { this.bytesLeft = 0; this.needByte = false; }
    else if (this.bytesLeft === 0) { this.restart(); this.requestIfHungry(); }
    this.irq = false; // $4015 writes always acknowledge the DMC IRQ
  }

  restart() { this.curAddr = this.sampleAddr; this.bytesLeft = this.sampleLen; }

  requestIfHungry() { if (!this.bufferFull && this.bytesLeft > 0) this.needByte = true; }

  // Called by the machine once it has stolen the cycles and read the byte.
  fill(value) {
    this.needByte = false;
    this.buffer = value & 0xff;
    this.bufferFull = true;
    this.curAddr = this.curAddr === 0xffff ? 0x8000 : this.curAddr + 1; // wraps to $8000, not $0000
    this.bytesLeft--;
    if (this.bytesLeft === 0) {
      if (this.loop) this.restart();
      else if (this.irqEnabled) this.irq = true;
    }
  }

  tick() {
    if (this.timer > 0) { this.timer--; return; }
    this.timer = this.period;
    if (!this.silence) {
      // Delta modulation: each bit nudges the level by 2, clamped. The clamp is
      // why a badly-authored sample "sticks" at the rails instead of wrapping.
      if (this.shift & 1) { if (this.output <= 125) this.output += 2; }
      else if (this.output >= 2) this.output -= 2;
    }
    this.shift >>= 1;
    if (--this.bitsLeft === 0) {
      this.bitsLeft = 8;
      if (this.bufferFull) { this.silence = false; this.shift = this.buffer; this.bufferFull = false; }
      else this.silence = true;
      this.requestIfHungry();
    }
  }

  save() {
    return [this.enabled ? 1 : 0, this.irqEnabled ? 1 : 0, this.irq ? 1 : 0, this.loop ? 1 : 0,
      this.period, this.timer, this.output, this.sampleAddr, this.sampleLen, this.curAddr,
      this.bytesLeft, this.buffer, this.bufferFull ? 1 : 0, this.shift, this.bitsLeft,
      this.silence ? 1 : 0, this.needByte ? 1 : 0];
  }
  load(a) {
    this.enabled = !!a[0]; this.irqEnabled = !!a[1]; this.irq = !!a[2]; this.loop = !!a[3];
    this.period = a[4]; this.timer = a[5]; this.output = a[6]; this.sampleAddr = a[7];
    this.sampleLen = a[8]; this.curAddr = a[9]; this.bytesLeft = a[10]; this.buffer = a[11];
    this.bufferFull = !!a[12]; this.shift = a[13]; this.bitsLeft = a[14];
    this.silence = !!a[15]; this.needByte = !!a[16];
  }
}

// ---------------------------------------------------------------------------
export class NesApu {
  constructor({ sampleRate = 48000, cpuHz = NTSC_CPU_HZ, ringSize = 16384 } = {}) {
    this.sampleRate = sampleRate;
    this.cpuHz = cpuHz;
    this.cyclesPerSample = cpuHz / sampleRate; // ~37.3
    this.pulse1 = new Pulse(false);
    this.pulse2 = new Pulse(true);
    this.triangle = new Triangle();
    this.noise = new Noise();
    this.dmc = new Dmc();
    this.ring = new Float32Array(ringSize);
    // Expansion audio. Sound chips outside the 2A03 live on the cartridge (VRC6,
    // Sunsoft 5B, Namco 163) or on the Disk System's RAM adapter, and they are
    // summed into the console's audio pin, not into the 2A03's own DAC. So the
    // hook is here in the mixer and nowhere else: the owner of the chip clocks
    // it (it is on the CPU clock either way) and this only reads `output`.
    // Keeping it a plain object rather than a subclass is what lets nesmapper.js
    // own the FDS channel without nesapu.js knowing what a disk is.
    this.expansion = null;
    this.powerOn();
  }

  powerOn() {
    this.pulse1.reset(); this.pulse2.reset();
    this.triangle.reset(); this.noise.reset(); this.dmc.reset();
    this.frameCycle = 0;
    this.mode5 = false;
    this.irqInhibit = false;
    this.frameIrq = false;
    this.writeDelay = 0;      // $4017 takes effect 3-4 CPU cycles later
    this.writeValue = 0;
    this.lastFrameWrite = 0;
    this.cpuCycle = 0;        // parity only; decides that 3-vs-4
    this._resetRing();
    this._resetFilters();
    return this;
  }

  // A reset is not a power-on. The RESET line clears $4015 and re-triggers the
  // frame counter, but the registers keep their values — and the mode bit in
  // particular survives, because what happens is that the LAST value written to
  // $4017 is written again. An emulator that treats reset as power-on restarts
  // a game's music driver in 4-step mode when it had chosen 5-step, and
  // apu_reset/4017_written says so in as many words.
  reset() {
    this.write(0x15, 0);            // silence the channels, clear the DMC IRQ
    this.dmc.output &= 1;           // the DPCM level survives only in its bit 0
    this.frameIrq = false;
    // The rewrite happens while the CPU is still in its own 7-cycle reset
    // sequence, not 3-4 cycles after an instruction, so the usual write delay
    // does not apply. apu_reset/4017_timing prints the gap between the
    // effective write and the first instruction of the program; hardware
    // reports 9-12 and this lands on 9.
    this.write(0x17, this.lastFrameWrite);
    this.writeDelay = 2; this._applyFrameWrite();
    return this;
  }

  _resetRing() { this.ringHead = 0; this.ringTail = 0; this.last = 0; this.sampleAcc = 0; this.sampleSum = 0; this.sampleCount = 0; }
  _resetFilters() { this.hp1 = 0; this.hp1p = 0; this.hp2 = 0; this.hp2p = 0; this.lp = 0; }

  // ---- CPU-side registers ---------------------------------------------------
  write(addr, value) {
    value &= 0xff;
    switch (addr & 0x1f) {
      case 0x00: case 0x01: case 0x02: case 0x03: this._chWrite(this.pulse1, addr & 3, value); break;
      case 0x04: case 0x05: case 0x06: case 0x07: this._chWrite(this.pulse2, addr & 3, value); break;
      case 0x08: case 0x09: case 0x0a: case 0x0b: this._chWrite(this.triangle, addr & 3, value); break;
      case 0x0c: case 0x0d: case 0x0e: case 0x0f: this._chWrite(this.noise, addr & 3, value); break;
      case 0x10: case 0x11: case 0x12: case 0x13: this.dmc.write(addr & 3, value); break;
      case 0x15:
        this.pulse1.enabled = (value & 1) !== 0; if (!this.pulse1.enabled) this.pulse1.length = 0;
        this.pulse2.enabled = (value & 2) !== 0; if (!this.pulse2.enabled) this.pulse2.length = 0;
        this.triangle.enabled = (value & 4) !== 0; if (!this.triangle.enabled) this.triangle.length = 0;
        this.noise.enabled = (value & 8) !== 0; if (!this.noise.enabled) this.noise.length = 0;
        this.dmc.setEnabled((value & 0x10) !== 0);
        break;
      case 0x17:
        // Not applied here: the divider is reset 3 CPU cycles after the write
        // if it landed on an APU cycle (even CPU cycle) and 4 if between.
        // Games time $4017 writes against the sequence they are resetting, so
        // applying it immediately shifts every subsequent frame IRQ by 3-4
        // cycles — which is exactly the error blargg's 4017_timing measures.
        this.writeValue = value;
        this.lastFrameWrite = value;
        this.writeDelay = (this.cpuCycle & 1) ? 4 : 3;
        this.irqInhibit = (value & 0x40) !== 0;
        if (this.irqInhibit) this.frameIrq = false;
        break;
      default: break;
    }
  }

  // A write and a length clock that land on the same cycle interact — a reload
  // during the clock is swallowed unless the counter had already reached zero,
  // and a halt-bit change takes effect after the clock rather than before.
  // `lenClockedThisCycle` is here for that, but the *pairing* is not right yet:
  // this model ticks the APU before the CPU's access completes (see
  // machinenes._tick3), so "the same cycle" is off by one against hardware and
  // blocking the reload here moved blargg's 11.len_reload_timing from failing
  // subtest 4 to failing subtest 3. Left visible and unused rather than half
  // applied. See docs/nes-design.md §11.
  _chWrite(ch, reg, value) { ch.write(reg, value); }

  // $4015 read: length-counter status, the two IRQ flags, and — as a side
  // effect — acknowledgement of the frame IRQ.
  readStatus(openBus = 0) {
    let v = 0;
    if (this.pulse1.length > 0) v |= 0x01;
    if (this.pulse2.length > 0) v |= 0x02;
    if (this.triangle.length > 0) v |= 0x04;
    if (this.noise.length > 0) v |= 0x08;
    if (this.dmc.bytesLeft > 0) v |= 0x10;
    if (this.frameIrq) v |= 0x40;
    if (this.dmc.irq) v |= 0x80;
    // Reading acknowledges the frame IRQ. The documented "set on the same
    // cycle as the read stays set" quirk needs no special case here: the APU
    // ticks before the CPU's read completes (see machinenes._tick3), so a flag
    // raised on this cycle is read as 1 and then cleared — and the sequencer
    // raises it again on the next two cycles anyway. Adding the special case
    // on top widens the window to four cycles and apu_test/6-irq_flag_timing
    // reports "flag last set too late".
    // (The DMC IRQ is not acknowledged by a read at all: it needs a $4015 write.)
    this.frameIrq = false;
    return v | (openBus & 0x20);
  }

  peekStatus(openBus = 0) {
    const irq = this.frameIrq;
    const v = this.readStatus(openBus);
    this.frameIrq = irq;
    return v;
  }

  get irq() { return this.frameIrq || this.dmc.irq; }

  // ---- the clock ------------------------------------------------------------
  // One CPU cycle. Order matters: the frame sequencer runs before the channels
  // so a length counter that reaches zero on this cycle is already zero when
  // $4015 is read on it.
  tick() {
    this.cpuCycle++;
    this.lenClockedThisCycle = false;
    if (this.writeDelay > 0 && --this.writeDelay === 0) this._applyFrameWrite();
    this._frameTick();
    this.pulse1.tick();
    this.pulse2.tick();
    this.triangle.tick();
    this.noise.tick();
    this.dmc.tick();
    this._sampleTick();
  }

  _applyFrameWrite() {
    const v = this.writeValue;
    this.mode5 = (v & 0x80) !== 0;
    // The cycle on which the divider is reloaded is itself cycle 0 of the new
    // sequence, and _frameTick() below will bump the counter for this cycle —
    // so it starts one short. Off by one here and every quarter/half frame and
    // the frame IRQ land a cycle early (apu_test 5 and 6 say "too soon").
    this.frameCycle = -1;
    // Setting the 5-step mode clocks the sequence immediately — games use that
    // to force a length-counter tick at a known moment.
    if (this.mode5) { this._quarter(); this._half(); }
  }

  _frameTick() {
    this.frameCycle++;
    if (!this.mode5) {
      switch (this.frameCycle) {
        case F4_Q1: this._quarter(); break;
        case F4_Q2: this._quarter(); this._half(); break;
        case F4_Q3: this._quarter(); break;
        case F4_IRQ: this._raiseFrameIrq(); break;
        case F4_LAST: this._quarter(); this._half(); this._raiseFrameIrq(); break;
        case F4_WRAP: this._raiseFrameIrq(); this.frameCycle = 0; break;
        default: break;
      }
    } else {
      switch (this.frameCycle) {
        case F4_Q1: this._quarter(); break;
        case F4_Q2: this._quarter(); this._half(); break;
        case F5_Q3: this._quarter(); break;
        case F5_LAST: this._quarter(); this._half(); break;
        case F5_WRAP: this.frameCycle = 0; break;
        default: break;
      }
    }
  }

  _raiseFrameIrq() { if (!this.irqInhibit) this.frameIrq = true; }

  _quarter() {
    this.pulse1.env.clock();
    this.pulse2.env.clock();
    this.noise.env.clock();
    this.triangle.clockLinear();
  }

  _half() {
    this.lenClockedThisCycle = true;
    this.pulse1.clockLength(); this.pulse1.clockSweep();
    this.pulse2.clockLength(); this.pulse2.clockSweep();
    this.triangle.clockLength();
    this.noise.clockLength();
  }

  // ---- mixing and resampling ------------------------------------------------
  mix() {
    const p = PULSE_TABLE[this.pulse1.output + this.pulse2.output];
    const t = TND_TABLE[3 * this.triangle.output + 2 * this.noise.output + this.dmc.output];
    const e = this.expansion ? this.expansion.output : 0;
    return p + t + e;
  }

  // Box-filter down to sampleRate, then the console's own output stage: two
  // high-pass poles (90 Hz and 440 Hz) and a 14 kHz low-pass. Modelling the
  // *board* rather than the chip is the same choice machine88.js makes for the
  // OPN's resistor mixer, and it is what stops the mix sitting on a DC offset
  // that a triangle at rest would otherwise park it on.
  _sampleTick() {
    this.sampleSum += this.mix();
    this.sampleCount++;
    this.sampleAcc += 1;
    if (this.sampleAcc < this.cyclesPerSample) return;
    this.sampleAcc -= this.cyclesPerSample;
    const raw = this.sampleSum / this.sampleCount;
    this.sampleSum = 0; this.sampleCount = 0;

    const a1 = 0.988, a2 = 0.943, lpA = 0.815; // one-pole coefficients at 48 kHz
    let v = a1 * (this.hp1 + raw - this.hp1p); this.hp1 = v; this.hp1p = raw;
    let w = a2 * (this.hp2 + v - this.hp2p); this.hp2 = w; this.hp2p = v;
    this.lp += (w - this.lp) * (1 - lpA);

    this._push(this.lp);
  }

  _push(v) {
    const n = this.ring.length;
    const next = (this.ringHead + 1) % n;
    // Overflow means nobody is draining (the host has no audio context, or the
    // emulation is being fast-forwarded). Drop the oldest rather than grow:
    // stale audio is worse than missing audio, and an unbounded buffer would
    // be the one part of this machine that leaks.
    if (next === this.ringTail) this.ringTail = (this.ringTail + 1) % n;
    this.ring[this.ringHead] = v;
    this.ringHead = next;
  }

  get pending() {
    const n = this.ring.length;
    return (this.ringHead - this.ringTail + n) % n;
  }

  // Fill `out` with `n` samples. Same signature as ym2203.render(), so the
  // host's audio pump does not care which machine it is talking to. On
  // underrun the last sample is held: the emulation cannot be asked to produce
  // more audio without also advancing time, so a click is the only alternative.
  render(out, n = out.length) {
    const ring = this.ring, len = ring.length;
    for (let i = 0; i < n; i++) {
      if (this.ringTail !== this.ringHead) {
        this.last = ring[this.ringTail];
        this.ringTail = (this.ringTail + 1) % len;
      }
      out[i] = this.last;
    }
    return out;
  }

  // ---- state ---------------------------------------------------------------
  // The ring is deliberately absent (see the header). Everything here is a
  // number or a boolean, so snap.js copies it without knowing what it means.
  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      p1: this.pulse1.save(), p2: this.pulse2.save(),
      tri: this.triangle.save(), noi: this.noise.save(), dmc: this.dmc.save(),
      frameCycle: this.frameCycle, mode5: this.mode5, irqInhibit: this.irqInhibit,
      frameIrq: this.frameIrq, writeDelay: this.writeDelay, writeValue: this.writeValue,
      cpuCycle: this.cpuCycle,
      // resampler phase + filter memory: five floats that keep the sample
      // stream after a restore bit-identical to the original run
      rs: [this.sampleAcc, this.sampleSum, this.sampleCount, this.hp1, this.hp1p, this.hp2, this.hp2p, this.lp],
    };
  }

  setState(s) {
    this.pulse1.load(s.p1); this.pulse2.load(s.p2);
    this.triangle.load(s.tri); this.noise.load(s.noi); this.dmc.load(s.dmc);
    this.frameCycle = s.frameCycle; this.mode5 = s.mode5; this.irqInhibit = s.irqInhibit;
    this.frameIrq = s.frameIrq; this.writeDelay = s.writeDelay ?? 0;
    this.writeValue = s.writeValue ?? 0; this.cpuCycle = s.cpuCycle ?? 0;
    const r = s.rs || [];
    this.sampleAcc = r[0] ?? 0; this.sampleSum = r[1] ?? 0; this.sampleCount = r[2] ?? 0;
    this.hp1 = r[3] ?? 0; this.hp1p = r[4] ?? 0; this.hp2 = r[5] ?? 0; this.hp2p = r[6] ?? 0;
    this.lp = r[7] ?? 0;
    // The undrained samples belonged to a future that has been rewound away.
    this.ringHead = this.ringTail = 0;
    return this;
  }

  snapshot() { return this.getState(); }
  restore(s) { return this.setState(s); }
}

export function createNesApu(opts) { return new NesApu(opts); }
