// gbapu — the Game Boy's sound hardware. Pure JS, zero deps, deterministic.
// No DOM, no WebAudio: the output is a plain array of samples.
//
// Four channels, and the interesting thing about them is that they are not
// four independent oscillators — they are four *counters* sharing one 512 Hz
// heartbeat, and that heartbeat is derived from the same DIV register the
// timer uses. Writing $FF04 to reset DIV therefore changes the phase of the
// music (and of the length counters), which is why the frame sequencer here is
// driven by the machine from a DIV bit rather than by a divider of its own.
// In CGB double-speed mode DIV runs twice as fast and the bit moves from 4 to
// 5, so the heartbeat stays at 512 Hz — that is the machine's business.
//
// ## Pull or push
//
// nesapu.js argued that a 2A03 has to be clocked from the CPU because two of
// its outputs (the frame IRQ, the length-counter status bits) are not sound.
// The same is true here, minus the IRQ: NR52's bits 0-3 tell a music driver
// which channels have run out of length, and drivers poll them. So `tick(t)`
// is called from the machine's clock and the samples fall out as a
// by-product, exactly as on the Famicom side.
//
// ## Precision
//
// The channel timers run in T-cycles and are exact. The mixer is not: the
// per-channel DAC on hardware is a resistor ladder feeding an analogue mixer
// with a per-side volume control and a high-pass that makes the "charge"
// audible when a channel is switched off mid-note. The high-pass is modelled
// (it is the difference between a click and no click), the rest is linear.
//
// Suite contract: no Math.random. The noise channel is a linear-feedback shift
// register, which is a *hardware* pseudo-random source — same seed, same
// sequence, and it is part of the snapshot.

export const SCHEMA_VERSION = 1;

// The duty patterns, as eight-bit masks read one bit per step.
const DUTY = Uint8Array.from([0x01, 0x81, 0x87, 0x7e]); // 12.5% / 25% / 50% / 75%

// The noise channel's clock divisor, indexed by NR43's low three bits. The
// zero entry is half the next one, which is the only irregularity.
const NOISE_DIVISOR = Uint16Array.from([8, 16, 32, 48, 64, 80, 96, 112]);

// Bits that read back as 1 on a register that is only partly implemented.
const READ_MASK = {
  0xff10: 0x80, 0xff11: 0x3f, 0xff12: 0x00, 0xff13: 0xff, 0xff14: 0xbf,
  0xff15: 0xff, 0xff16: 0x3f, 0xff17: 0x00, 0xff18: 0xff, 0xff19: 0xbf,
  0xff1a: 0x7f, 0xff1b: 0xff, 0xff1c: 0x9f, 0xff1d: 0xff, 0xff1e: 0xbf,
  0xff1f: 0xff, 0xff20: 0xff, 0xff21: 0x00, 0xff22: 0x00, 0xff23: 0xbf,
  0xff24: 0x00, 0xff25: 0x00, 0xff26: 0x70,
};

// ---------------------------------------------------------------------------
// The pieces every channel shares. Kept as mixins-by-hand rather than a base
// class because the four channels differ in which pieces they have, and an
// inheritance chain that has to be defeated with `if (this.hasSweep)` is worse
// than four explicit constructors.

class LengthCounter {
  constructor(max) { this.max = max; this.value = 0; this.enabled = false; }
  load(n) { this.value = this.max - n; }
  // Returns true when it has just run out and the channel must go silent.
  clock() {
    if (!this.enabled || this.value === 0) return false;
    return --this.value === 0;
  }
  reload() { if (this.value === 0) this.value = this.max; }
}

class Envelope {
  constructor() { this.initial = 0; this.direction = 0; this.period = 0; this.volume = 0; this.timer = 0; this.running = false; }
  write(v) { this.initial = v >> 4; this.direction = (v >> 3) & 1; this.period = v & 7; }
  trigger() { this.volume = this.initial; this.timer = this.period || 8; this.running = true; }
  clock() {
    if (!this.running) return;
    if (--this.timer > 0) return;
    this.timer = this.period || 8;
    if (this.period === 0) return;
    const next = this.volume + (this.direction ? 1 : -1);
    if (next < 0 || next > 15) { this.running = false; return; }
    this.volume = next;
  }
}

// ---------------------------------------------------------------------------

export class GbApu {
  constructor({ sampleRate = 48000, clockHz = 4194304 } = {}) {
    this.sampleRate = sampleRate;
    this.clockHz = clockHz;
    this.cyclesPerSample = clockHz / sampleRate;

    this.wave = new Uint8Array(16);
    // A ring the machine drains through render(). It is OUTPUT, so it is not
    // in the snapshot — but the resampler's phase and the high-pass memory
    // are, so the samples after a restore continue the same waveform.
    this._ring = new Float32Array(1 << 16);
    this._wr = 0; this._rd = 0;
    this._sampleAcc = 0;
    this._hpL = 0; this._hpR = 0; this._capL = 0; this._capR = 0;

    this.powerOn();
  }

  powerOn() {
    this.enabled = true;
    this.nr50 = 0x77; this.nr51 = 0xf3;
    this._seqStep = 0;
    this.ch1 = {
      on: false, duty: 2, dutyStep: 0, timer: 0, freq: 0,
      len: new LengthCounter(64), env: new Envelope(),
      sweepPeriod: 0, sweepDir: 0, sweepShift: 0,
      sweepTimer: 0, sweepEnabled: false, sweepShadow: 0, sweepNegUsed: false,
      nr10: 0x80, nr11: 0xbf, nr12: 0xf3, nr13: 0xff, nr14: 0xbf,
    };
    this.ch2 = {
      on: false, duty: 0, dutyStep: 0, timer: 0, freq: 0,
      len: new LengthCounter(64), env: new Envelope(),
      nr21: 0x3f, nr22: 0x00, nr23: 0xff, nr24: 0xbf,
    };
    this.ch3 = {
      on: false, dacOn: false, pos: 0, timer: 0, freq: 0, volume: 0, sample: 0, access: 0,
      len: new LengthCounter(256),
      nr30: 0x7f, nr31: 0xff, nr32: 0x9f, nr33: 0xff, nr34: 0xbf,
    };
    this.ch4 = {
      on: false, lfsr: 0x7fff, width: 0, shift: 0, divisor: 0, timer: 0,
      len: new LengthCounter(64), env: new Envelope(),
      nr41: 0xff, nr42: 0x00, nr43: 0x00, nr44: 0xbf,
    };
    this.ch1.env.write(0xf3); this.ch1.duty = 2;
    this.wave.fill(0);
    this._wr = 0; this._rd = 0; this._sampleAcc = 0;
    this._hpL = 0; this._hpR = 0;
    return this;
  }

  reset() { return this; }

  // ---- registers -----------------------------------------------------------
  read(addr) {
    if (addr >= 0xff30 && addr < 0xff40) {
      // While the wave channel is playing, wave RAM belongs to it. On a DMG
      // the CPU gets $FF — EXCEPT in the two-cycle window right after the
      // channel has just fetched a byte, when it sees that byte rather than
      // the one it asked for. Games do not do this on purpose; blargg does.
      if (this.ch3.on) return this.ch3.access > 0 ? this.wave[this.ch3.pos >> 1] : 0xff;
      return this.wave[addr - 0xff30];
    }
    if (addr === 0xff26) {
      return 0x70 | (this.enabled ? 0x80 : 0)
        | (this.ch1.on ? 1 : 0) | (this.ch2.on ? 2 : 0) | (this.ch3.on ? 4 : 0) | (this.ch4.on ? 8 : 0);
    }
    const mask = READ_MASK[addr];
    if (mask === undefined) return 0xff;
    const raw = this._rawReg(addr);
    return raw | mask;
  }

  _rawReg(addr) {
    const c1 = this.ch1, c2 = this.ch2, c3 = this.ch3, c4 = this.ch4;
    switch (addr) {
      case 0xff10: return c1.nr10; case 0xff11: return c1.nr11; case 0xff12: return c1.nr12;
      case 0xff13: return c1.nr13; case 0xff14: return c1.nr14;
      case 0xff16: return c2.nr21; case 0xff17: return c2.nr22;
      case 0xff18: return c2.nr23; case 0xff19: return c2.nr24;
      case 0xff1a: return c3.nr30; case 0xff1b: return c3.nr31; case 0xff1c: return c3.nr32;
      case 0xff1d: return c3.nr33; case 0xff1e: return c3.nr34;
      case 0xff20: return c4.nr41; case 0xff21: return c4.nr42;
      case 0xff22: return c4.nr43; case 0xff23: return c4.nr44;
      case 0xff24: return this.nr50; case 0xff25: return this.nr51;
      default: return 0;
    }
  }

  write(addr, v) {
    v &= 0xff;
    if (addr >= 0xff30 && addr < 0xff40) {
      if (this.ch3.on) { if (this.ch3.access > 0) this.wave[this.ch3.pos >> 1] = v; }
      else this.wave[addr - 0xff30] = v;
      return;
    }
    if (addr === 0xff26) {
      const on = (v & 0x80) !== 0;
      if (!on && this.enabled) this._powerOff();
      else if (on && !this.enabled) this._powerOn();
      return;
    }
    // With the master switch off every register is read-only and reads zero —
    // except the length counters on a DMG, which stay writable. Getting this
    // wrong makes a game that powers the APU down between tracks come back
    // with the wrong note lengths.
    if (!this.enabled) {
      if (addr === 0xff11 || addr === 0xff16 || addr === 0xff1b || addr === 0xff20) {
        this._writeLengthOnly(addr, v);
      }
      return;
    }
    const c1 = this.ch1, c2 = this.ch2, c3 = this.ch3, c4 = this.ch4;
    switch (addr) {
      // ---- channel 1: square with a frequency sweep ----
      case 0xff10:
        c1.nr10 = v;
        c1.sweepPeriod = (v >> 4) & 7; c1.sweepDir = (v >> 3) & 1; c1.sweepShift = v & 7;
        // Clearing the direction bit after a negate-mode calculation has
        // already happened switches the channel off. Real hardware, and
        // blargg's "sweep details" checks it.
        if (!c1.sweepDir && c1.sweepNegUsed) c1.on = false;
        break;
      case 0xff11: c1.nr11 = v; c1.duty = v >> 6; c1.len.load(v & 0x3f); break;
      case 0xff12:
        c1.nr12 = v; c1.env.write(v);
        if ((v & 0xf8) === 0) c1.on = false;      // the DAC is off: no current, no sound
        break;
      case 0xff13: c1.nr13 = v; c1.freq = (c1.freq & 0x700) | v; break;
      case 0xff14: this._writeCtrl(c1, v, 1); break;

      // ---- channel 2: the same, without the sweep ----
      case 0xff16: c2.nr21 = v; c2.duty = v >> 6; c2.len.load(v & 0x3f); break;
      case 0xff17: c2.nr22 = v; c2.env.write(v); if ((v & 0xf8) === 0) c2.on = false; break;
      case 0xff18: c2.nr23 = v; c2.freq = (c2.freq & 0x700) | v; break;
      case 0xff19: this._writeCtrl(c2, v, 2); break;

      // ---- channel 3: 32 four-bit samples from wave RAM ----
      case 0xff1a: c3.nr30 = v; c3.dacOn = (v & 0x80) !== 0; if (!c3.dacOn) c3.on = false; break;
      case 0xff1b: c3.nr31 = v; c3.len.load(v); break;
      case 0xff1c: c3.nr32 = v; c3.volume = (v >> 5) & 3; break;
      case 0xff1d: c3.nr33 = v; c3.freq = (c3.freq & 0x700) | v; break;
      case 0xff1e: this._writeCtrl(c3, v, 3); break;

      // ---- channel 4: noise from a shift register ----
      case 0xff20: c4.nr41 = v; c4.len.load(v & 0x3f); break;
      case 0xff21: c4.nr42 = v; c4.env.write(v); if ((v & 0xf8) === 0) c4.on = false; break;
      case 0xff22:
        c4.nr43 = v;
        c4.shift = v >> 4; c4.width = (v >> 3) & 1; c4.divisor = v & 7;
        break;
      case 0xff23: this._writeCtrl(c4, v, 4); break;

      case 0xff24: this.nr50 = v; break;
      case 0xff25: this.nr51 = v; break;
      default: break;
    }
  }

  _writeLengthOnly(addr, v) {
    if (addr === 0xff11) { this.ch1.nr11 = (this.ch1.nr11 & 0xc0) | (v & 0x3f); this.ch1.len.load(v & 0x3f); }
    else if (addr === 0xff16) { this.ch2.nr21 = (this.ch2.nr21 & 0xc0) | (v & 0x3f); this.ch2.len.load(v & 0x3f); }
    else if (addr === 0xff1b) { this.ch3.nr31 = v; this.ch3.len.load(v); }
    else if (addr === 0xff20) { this.ch4.nr41 = (this.ch4.nr41 & 0xc0) | (v & 0x3f); this.ch4.len.load(v & 0x3f); }
  }

  // NRx4: the top bit triggers, the next bit enables the length counter, and
  // the low three bits are the top of the frequency.
  //
  // The length counter is where all the strangeness lives. It is clocked on
  // the EVEN steps of the frame sequencer, so "which half of a length period
  // are we in" is observable — and enabling the counter during the half where
  // the next step will NOT clock it makes the hardware clock it once extra,
  // there and then. A trigger that reloads an empty counter in the same half
  // loses a step for the same reason. Music drivers were written against this
  // and blargg's "len ctr" tests spend most of their length on it.
  _writeCtrl(ch, v, which) {
    const wasEnabled = ch.len.enabled;
    if (which === 4) ch.nr44 = v;
    else if (which === 3) { ch.nr34 = v; ch.freq = (ch.freq & 0xff) | ((v & 7) << 8); }
    else if (which === 2) { ch.nr24 = v; ch.freq = (ch.freq & 0xff) | ((v & 7) << 8); }
    else { ch.nr14 = v; ch.freq = (ch.freq & 0xff) | ((v & 7) << 8); }
    ch.len.enabled = (v & 0x40) !== 0;

    const extra = (this._seqStep & 1) === 1; // the next sequencer step is NOT a length step
    const trigger = (v & 0x80) !== 0;
    if (extra && !wasEnabled && ch.len.enabled && ch.len.value > 0) {
      if (--ch.len.value === 0 && !trigger) ch.on = false;
    }
    if (trigger) this._trigger(ch, which, extra);
  }

  _trigger(ch, which, extra) {
    ch.on = true;
    // Only a counter that had actually expired is reloaded — and only that
    // reload can lose its first step.
    if (ch.len.value === 0) {
      ch.len.value = ch.len.max;
      if (ch.len.enabled && extra) ch.len.value--;
    }

    if (which === 3) {
      ch.timer = (2048 - ch.freq) * 2;
      ch.pos = 0;
      if (!ch.dacOn) ch.on = false;
      return;
    }
    if (which === 4) {
      ch.env.trigger();
      ch.lfsr = 0x7fff;
      ch.timer = (NOISE_DIVISOR[ch.divisor] << ch.shift);
      if ((ch.nr42 & 0xf8) === 0) ch.on = false;
      return;
    }
    ch.env.trigger();
    ch.timer = (2048 - ch.freq) * 4;
    if (which === 1) {
      ch.sweepShadow = ch.freq;
      ch.sweepTimer = ch.sweepPeriod || 8;
      ch.sweepEnabled = ch.sweepPeriod !== 0 || ch.sweepShift !== 0;
      ch.sweepNegUsed = false;
      // The overflow check happens at trigger time too, and can silence the
      // channel before it has made a sound.
      if (ch.sweepShift !== 0) this._sweepCalc(ch);
    }
    if ((which === 1 ? ch.nr12 : ch.nr22) & 0xf8) { /* DAC on */ } else ch.on = false;
  }

  // Powering the sound hardware down zeroes every register and silences every
  // channel — but on a DMG it does NOT touch the length counters, and the
  // wave RAM survives on every model. A game that powers the APU down between
  // tracks and back up comes back with the note lengths it left, which is what
  // blargg's "len ctr during power" checks. (A Color does clear them; this
  // emulates the DMG, and the difference is noted in docs/gb-design.md §11.)
  _powerOff() {
    this.enabled = false;
    this.nr50 = 0; this.nr51 = 0;
    this._seqStep = 0;
    const c1 = this.ch1, c2 = this.ch2, c3 = this.ch3, c4 = this.ch4;
    c1.on = c2.on = c3.on = c4.on = false;
    c1.nr10 = 0; c1.nr11 = 0; c1.nr12 = 0; c1.nr13 = 0; c1.nr14 = 0;
    c2.nr21 = 0; c2.nr22 = 0; c2.nr23 = 0; c2.nr24 = 0;
    c3.nr30 = 0; c3.nr31 = 0; c3.nr32 = 0; c3.nr33 = 0; c3.nr34 = 0;
    c4.nr41 = 0; c4.nr42 = 0; c4.nr43 = 0; c4.nr44 = 0;
    c1.duty = 0; c2.duty = 0; c1.freq = 0; c2.freq = 0; c3.freq = 0; c3.volume = 0;
    c3.dacOn = false;
    c4.shift = 0; c4.width = 0; c4.divisor = 0;
    c1.sweepPeriod = 0; c1.sweepDir = 0; c1.sweepShift = 0; c1.sweepEnabled = false; c1.sweepNegUsed = false;
    c1.env.write(0); c2.env.write(0); c4.env.write(0);
    c1.env.volume = 0; c2.env.volume = 0; c4.env.volume = 0;
    c1.env.running = false; c2.env.running = false; c4.env.running = false;
    c1.len.enabled = c2.len.enabled = c3.len.enabled = c4.len.enabled = false;
  }

  // Powering back up restarts the sequencer and the duty counters. The wave
  // channel's position is NOT reset here — only a trigger does that.
  _powerOn() {
    this.enabled = true;
    this._seqStep = 0;
    this.ch1.dutyStep = 0; this.ch2.dutyStep = 0;
  }

  // ---- the 512 Hz heartbeat ------------------------------------------------
  // Called by the machine on the falling edge of the DIV bit. Eight steps:
  // length on the even ones, sweep on 2 and 6, envelope on 7.
  frameSequencerStep() {
    if (!this.enabled) return;
    const step = this._seqStep;
    if ((step & 1) === 0) {
      if (this.ch1.len.clock()) this.ch1.on = false;
      if (this.ch2.len.clock()) this.ch2.on = false;
      if (this.ch3.len.clock()) this.ch3.on = false;
      if (this.ch4.len.clock()) this.ch4.on = false;
    }
    if (step === 2 || step === 6) this._sweepClock();
    if (step === 7) { this.ch1.env.clock(); this.ch2.env.clock(); this.ch4.env.clock(); }
    this._seqStep = (step + 1) & 7;
  }

  _sweepClock() {
    const c = this.ch1;
    if (--c.sweepTimer > 0) return;
    c.sweepTimer = c.sweepPeriod || 8;
    if (!c.sweepEnabled || c.sweepPeriod === 0) return;
    const f = this._sweepCalc(c);
    if (f <= 2047 && c.sweepShift !== 0) {
      c.sweepShadow = f;
      c.freq = f;
      c.nr13 = f & 0xff;
      c.nr14 = (c.nr14 & 0xf8) | ((f >> 8) & 7);
      this._sweepCalc(c); // the second, discarded calculation that can still overflow
    }
  }

  _sweepCalc(c) {
    let f = c.sweepShadow >> c.sweepShift;
    if (c.sweepDir) { f = c.sweepShadow - f; c.sweepNegUsed = true; }
    else f = c.sweepShadow + f;
    if (f > 2047) c.on = false;
    return f;
  }

  // ---- the sample clock ----------------------------------------------------
  tick(t) {
    const c1 = this.ch1, c2 = this.ch2, c3 = this.ch3, c4 = this.ch4;
    // The channel timers are exact; stepping them one T-cycle at a time would
    // be correct and slow, so each one is advanced in a loop that only runs
    // when it actually wraps.
    if (this.enabled) {
      c1.timer -= t;
      while (c1.timer <= 0) { c1.timer += (2048 - c1.freq) * 4 || 4; c1.dutyStep = (c1.dutyStep + 1) & 7; }
      c2.timer -= t;
      while (c2.timer <= 0) { c2.timer += (2048 - c2.freq) * 4 || 4; c2.dutyStep = (c2.dutyStep + 1) & 7; }
      c3.timer -= t;
      c3.access = Math.max(0, c3.access - t);
      while (c3.timer <= 0) {
        c3.timer += (2048 - c3.freq) * 2 || 2;
        c3.pos = (c3.pos + 1) & 31;
        const b = this.wave[c3.pos >> 1];
        c3.sample = (c3.pos & 1) ? (b & 0x0f) : (b >> 4);
        c3.access = 2;   // the window the CPU can slip a read or a write into
      }
      c4.timer -= t;
      while (c4.timer <= 0) {
        const period = NOISE_DIVISOR[c4.divisor] << c4.shift;
        c4.timer += period || 8;
        // The LFSR: XOR of the bottom two bits fed back into bit 14 (and into
        // bit 6 as well in "short" mode, which turns the noise into a
        // 127-step tone). This is the console's only randomness and it is
        // completely determined by its own state.
        const x = (c4.lfsr ^ (c4.lfsr >> 1)) & 1;
        c4.lfsr = (c4.lfsr >> 1) | (x << 14);
        if (c4.width) c4.lfsr = (c4.lfsr & ~0x40) | (x << 6);
      }
    }

    this._sampleAcc += t;
    while (this._sampleAcc >= this.cyclesPerSample) {
      this._sampleAcc -= this.cyclesPerSample;
      this._emit();
    }
  }

  // ---- the mixer -----------------------------------------------------------
  // Each channel's DAC turns a 0-15 digital level into an analogue one, and a
  // channel whose DAC is OFF contributes nothing at all — not silence at the
  // mid-point, but nothing, which is why switching a DAC off makes a click.
  _dac(level, on) { return on ? (level / 7.5) - 1 : 0; }

  _channelLevels() {
    const c1 = this.ch1, c2 = this.ch2, c3 = this.ch3, c4 = this.ch4;
    const v1 = (c1.on && ((DUTY[c1.duty] >> c1.dutyStep) & 1)) ? c1.env.volume : 0;
    const v2 = (c2.on && ((DUTY[c2.duty] >> c2.dutyStep) & 1)) ? c2.env.volume : 0;
    const v3 = c3.on && c3.volume ? (c3.sample >> (c3.volume - 1)) : 0;
    const v4 = (c4.on && !(c4.lfsr & 1)) ? c4.env.volume : 0;
    return [
      this._dac(v1, (c1.nr12 & 0xf8) !== 0),
      this._dac(v2, (c2.nr22 & 0xf8) !== 0),
      this._dac(v3, c3.dacOn),
      this._dac(v4, (c4.nr42 & 0xf8) !== 0),
    ];
  }

  _emit() {
    let l = 0, r = 0;
    if (this.enabled) {
      const v = this._channelLevels();
      const pan = this.nr51;
      for (let i = 0; i < 4; i++) {
        if (pan & (0x10 << i)) l += v[i];
        if (pan & (1 << i)) r += v[i];
      }
      l *= ((this.nr50 >> 4) & 7) + 1;
      r *= (this.nr50 & 7) + 1;
      l /= 32; r /= 32;
    }
    // The console's output capacitor. Without it, a channel whose DAC is
    // switched off leaves a DC step that the host's speakers turn into a pop;
    // with it, the step decays the way it does on hardware.
    const outL = l - this._capL; this._capL = l - outL * 0.999958;
    const outR = r - this._capR; this._capR = r - outR * 0.999958;
    const mono = (outL + outR) * 0.5;
    this._ring[this._wr & (this._ring.length - 1)] = mono;
    this._wr++;
  }

  // Same signature as machine88.renderAudio() and nesapu.render(): fill a mono
  // Float32Array. The host's audio pump does not know which machine it is
  // talking to.
  render(out, n = out.length) {
    const mask = this._ring.length - 1;
    let produced = 0;
    for (let i = 0; i < n; i++) {
      if (this._rd < this._wr) { out[i] = this._ring[this._rd & mask]; this._rd++; produced++; }
      else out[i] = produced ? out[produced - 1] : 0; // starved: hold, do not click
    }
    return produced;
  }

  available() { return this._wr - this._rd; }

  // ---- time travel ---------------------------------------------------------
  // The sample ring is output and stays out, but the resampler phase and the
  // high-pass memory are state: without them the waveform would restart at a
  // different sub-sample offset after every rewind and the sound would tick.
  getState() {
    const ch = (c) => {
      const o = { ...c };
      o.len = { value: c.len.value, enabled: c.len.enabled };
      if (c.env) o.env = { ...c.env };
      return o;
    };
    return {
      schemaVersion: SCHEMA_VERSION,
      enabled: this.enabled, nr50: this.nr50, nr51: this.nr51, seqStep: this._seqStep,
      wave: this.wave.slice(),
      ch1: ch(this.ch1), ch2: ch(this.ch2), ch3: ch(this.ch3), ch4: ch(this.ch4),
      sampleAcc: this._sampleAcc, capL: this._capL, capR: this._capR,
    };
  }

  setState(s) {
    this.enabled = s.enabled; this.nr50 = s.nr50; this.nr51 = s.nr51; this._seqStep = s.seqStep;
    this.wave.set(s.wave);
    const put = (dst, src) => {
      for (const k of Object.keys(src)) {
        if (k === 'len') { dst.len.value = src.len.value; dst.len.enabled = src.len.enabled; }
        else if (k === 'env') { Object.assign(dst.env, src.env); }
        else dst[k] = src[k];
      }
    };
    put(this.ch1, s.ch1); put(this.ch2, s.ch2); put(this.ch3, s.ch3); put(this.ch4, s.ch4);
    this._sampleAcc = s.sampleAcc; this._capL = s.capL; this._capR = s.capR;
    // Drop whatever had been produced but not yet drained: it belongs to the
    // future we just abandoned.
    this._rd = this._wr;
    return this;
  }
}

export function createGbApu(opts) { return new GbApu(opts); }
