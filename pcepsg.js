// pcepsg — the HuC6280's built-in programmable sound generator.
//
// Six channels of wavetable, not six oscillators. Each one owns 32 five-bit
// samples of RAM and plays them in a loop at a rate the game sets, so the
// "instrument" is data rather than a knob — the same idea as the Disk System's
// sound in fds.js, and the reason PC Engine music sounds nothing like a
// Famicom's fixed pulse/triangle set. On top of that:
//
//   - channels 4 and 5 can switch to a noise generator instead of their wave,
//   - channel 1 can be taken out of the mix and used to modulate channel 0's
//     frequency (the LFO), which is how vibrato is done,
//   - every channel has its own left/right balance, on top of a global one,
//   - a "direct D/A" mode lets the CPU write the output sample by sample,
//     which is how games play speech out of a wavetable channel.
//
// ## How it is clocked
//
// Like nesapu.js and unlike ym2203.js, this chip is pushed rather than pulled:
// the machine hands it master clocks as the CPU runs, and it puts finished
// samples in a ring that renderAudio() drains. The reason is the same one
// nesapu.js gives — the register writes are timed events inside the frame (a
// music driver writes them from a raster or timer interrupt), so rendering at
// the end of a frame with the final register values would flatten every note
// onset onto one instant. Catching up on demand costs a call per scanline and
// per register write, and buys sample-accurate note placement.
//
// Nobody has listened to this. The oscillators, the wave RAM, the noise LFSR
// and the resampler are verified numerically (see test-pce.mjs); the mixing
// coefficients are a documented-attenuation estimate, not an ear.

export const SCHEMA_VERSION = 1;

export const MASTER_HZ = 21477272.727272727;
export const PSG_HZ = MASTER_HZ / 6;      // 3.579545 MHz, the colour-burst clock
export const CHANNELS = 6;
export const WAVE_STEPS = 32;

// The chip attenuates in 1.5 dB steps and it has three attenuators in series:
// the channel's own five-bit level, its four-bit balance, and the global
// four-bit volume — the last two counting double because they are coarser. The
// sum is an index into this table. Past 0x3F the output is simply off; the
// hardware runs out of DAC before it runs out of index.
const ATTEN = (() => {
  const t = new Float32Array(0x60);
  for (let i = 0; i < t.length; i++) t[i] = i > 0x3f ? 0 : Math.pow(10, (-1.5 * i) / 20);
  return t;
})();

class PsgChannel {
  constructor() {
    this.wave = new Uint8Array(WAVE_STEPS);
    this.freq = 0;          // 12-bit period; 0 behaves as 4096
    this.control = 0;       // bit7 on, bit6 DDA, bits0-4 level
    this.balance = 0xff;
    this.waveIndex = 0;
    this.waveWrite = 0;
    this.dda = 0;
    this.counter = 1;
    this.out = 0;           // the sample currently on the DAC, 0-31
    this.noiseCtrl = 0;     // channels 4-5 only
    this.noiseCounter = 1;
    this.lfsr = 0x2aaaa;    // any non-zero seed; 18 bits
    this.noiseOut = 0;
  }
}

export class PcePsg {
  constructor({ sampleRate = 48000 } = {}) {
    this.sampleRate = sampleRate;
    this.psgPerSample = PSG_HZ / sampleRate;
    this.ch = Array.from({ length: CHANNELS }, () => new PsgChannel());
    this.select = 0;
    this.mainVol = 0;
    this.lfoFreq = 0;
    this.lfoCtrl = 0x80;    // LFO off
    // The output ring. Sized for a quarter second so a host that stalls does
    // not silently lose audio; it is deliberately NOT part of the snapshot (see
    // getState).
    this.ring = new Float32Array(1 << 14);
    this.ringRead = 0;
    this.ringWrite = 0;
    this._masterAcc = 0;
    this._toNextSample = this.psgPerSample;
    this._accL = 0; this._accR = 0; this._accN = 0;
  }

  powerOn() {
    for (const c of this.ch) {
      c.wave.fill(0);
      c.freq = 0; c.control = 0; c.balance = 0xff; c.waveIndex = 0; c.waveWrite = 0;
      c.dda = 0; c.counter = 1; c.out = 0; c.noiseCtrl = 0; c.noiseCounter = 1;
      c.lfsr = 0x2aaaa; c.noiseOut = 0;
    }
    this.select = 0; this.mainVol = 0; this.lfoFreq = 0; this.lfoCtrl = 0x80;
    return this.reset();
  }

  reset() {
    this.ringRead = this.ringWrite = 0;
    this._masterAcc = 0;
    this._toNextSample = this.psgPerSample;
    this._accL = this._accR = this._accN = 0;
    return this;
  }

  // ---- registers ($0800-$0809 of the hardware bank) -------------------------
  // Nine registers, eight of which act on whichever channel $0800 last
  // selected. The machine must call run() before every write so that the
  // samples already produced were produced with the OLD values.
  write(addr, v) {
    v &= 0xff;
    const c = this.ch[this.select];
    switch (addr & 0x0f) {
      case 0: this.select = v & 7; return;
      case 1: this.mainVol = v; return;
      case 2: if (this.select < CHANNELS) c.freq = (c.freq & 0xf00) | v; return;
      case 3: if (this.select < CHANNELS) c.freq = (c.freq & 0x0ff) | ((v & 0x0f) << 8); return;
      case 4: {
        if (this.select >= CHANNELS) return;
        const wasDda = (c.control & 0x40) !== 0;
        c.control = v;
        // Turning a channel off resets its wave pointer, which is what lets a
        // driver retrigger a note from the start of the waveform rather than
        // from wherever the previous note happened to stop.
        if (!(v & 0x80)) { c.waveIndex = 0; c.waveWrite = 0; }
        else if (!(v & 0x40) && wasDda) c.waveIndex = 0;
        return;
      }
      case 5: if (this.select < CHANNELS) c.balance = v; return;
      case 6: {
        if (this.select >= CHANNELS) return;
        if (c.control & 0x40) { c.dda = v & 0x1f; c.out = c.dda; return; }  // direct D/A
        // Filling the wave RAM. The write pointer is separate from the play
        // pointer and wraps at 32, so a driver can rewrite a waveform while it
        // plays (and several do, for a cheap PWM effect).
        c.wave[c.waveWrite] = v & 0x1f;
        c.waveWrite = (c.waveWrite + 1) & (WAVE_STEPS - 1);
        return;
      }
      case 7: if (this.select >= 4 && this.select < CHANNELS) c.noiseCtrl = v; return;
      case 8: this.lfoFreq = v; return;
      case 9: this.lfoCtrl = v; return;
      default: return;
    }
  }

  read(addr) {
    // The PSG is write-only; the bus leaves the last value on it. Returning
    // something plausible rather than 0 keeps games that read-modify-write a
    // register from clearing it.
    return 0xff;
  }

  // ---- clocking -------------------------------------------------------------
  // `master` is master clocks, the unit the whole machine runs on. Six of them
  // make one PSG clock.
  run(master) {
    this._masterAcc += master;
    let clocks = (this._masterAcc / 6) | 0;
    if (clocks <= 0) return;
    this._masterAcc -= clocks * 6;
    while (clocks > 0) {
      const k = Math.min(clocks, Math.max(1, Math.ceil(this._toNextSample)));
      this._advance(k);
      clocks -= k;
      this._toNextSample -= k;
      if (this._toNextSample <= 0) {
        this._emit();
        this._toNextSample += this.psgPerSample;
      }
    }
  }

  // Advance every channel by k PSG clocks, accumulating the area under its
  // output so the emitted sample is an average rather than a point probe. That
  // is a one-pole box filter and it is what keeps a channel whose period is
  // shorter than a sample interval from aliasing into a whistle.
  _advance(k) {
    const lfoOn = !(this.lfoCtrl & 0x80) && (this.lfoCtrl & 3) !== 0;
    const lfoShift = ((this.lfoCtrl & 3) - 1) * 4;
    let l = 0, r = 0;
    for (let i = 0; i < CHANNELS; i++) {
      const c = this.ch[i];
      // Channel 1 is consumed by the LFO when it is on: it stops being audible
      // and becomes channel 0's frequency modulation.
      const muted = lfoOn && i === 1;
      let period;
      if (i === 0 && lfoOn) {
        const mod = (this.ch[1].out - 16) << lfoShift;
        period = (c.freq + mod) & 0xfff;
      } else if (i === 1 && lfoOn) {
        period = (c.freq * (this.lfoFreq || 1)) & 0xffff;
      } else {
        period = c.freq;
      }
      if (period === 0) period = i === 1 && lfoOn ? 0x10000 : 0x1000;

      const noise = i >= 4 && (c.noiseCtrl & 0x80) !== 0;
      let area = 0;
      if (!(c.control & 0x80)) {
        // Channel off: the DAC holds the last written level in DDA mode and
        // sits at the midpoint otherwise. Either way it contributes no motion.
        area = 0;
      } else if (c.control & 0x40) {
        area = (c.dda - 16) * k;                       // direct D/A: no oscillator
      } else if (noise) {
        let rem = k;
        const np = Math.max(64, (0x1f - (c.noiseCtrl & 0x1f)) * 64);
        while (rem > 0) {
          const step = Math.min(rem, c.noiseCounter);
          area += (c.noiseOut - 16) * step;
          c.noiseCounter -= step; rem -= step;
          if (c.noiseCounter <= 0) {
            c.noiseCounter = np;
            // An 18-bit maximal-length LFSR. The output is full scale or
            // nothing, which is why noise on this chip is louder than a wave of
            // the same nominal level.
            const bit = (c.lfsr ^ (c.lfsr >> 1)) & 1;
            c.lfsr = ((c.lfsr >> 1) | (bit << 17)) & 0x3ffff;
            c.noiseOut = (c.lfsr & 1) ? 31 : 0;
          }
        }
      } else {
        let rem = k;
        while (rem > 0) {
          const step = Math.min(rem, c.counter);
          area += (c.out - 16) * step;
          c.counter -= step; rem -= step;
          if (c.counter <= 0) {
            c.counter = period;
            c.waveIndex = (c.waveIndex + 1) & (WAVE_STEPS - 1);
            c.out = c.wave[c.waveIndex];
          }
        }
      }
      if (muted) continue;
      const lvl = c.control & 0x1f;
      const al = (0x1f - lvl) + 2 * (0x0f - ((c.balance >> 4) & 0x0f)) + 2 * (0x0f - ((this.mainVol >> 4) & 0x0f));
      const ar = (0x1f - lvl) + 2 * (0x0f - (c.balance & 0x0f)) + 2 * (0x0f - (this.mainVol & 0x0f));
      l += area * ATTEN[Math.min(0x5f, al)];
      r += area * ATTEN[Math.min(0x5f, ar)];
    }
    this._accL += l;
    this._accR += r;
    this._accN += k;
  }

  _emit() {
    const n = this._accN || 1;
    // Mono out, same as machine88.renderAudio() and nesapu — the host's pump is
    // one channel. The two sides are averaged rather than dropped so a game
    // that pans a lead hard left is still audible.
    const v = ((this._accL + this._accR) / 2 / n) / (16 * CHANNELS);
    this._accL = this._accR = 0; this._accN = 0;
    const next = (this.ringWrite + 1) & (this.ring.length - 1);
    if (next !== this.ringRead) { this.ring[this.ringWrite] = v; this.ringWrite = next; }
  }

  // Drain into a mono Float32Array; identical signature to
  // machine88.renderAudio() and NesMachine.renderAudio(), so the host's audio
  // pump does not have to know which machine it is talking to.
  render(out, n = out.length) {
    for (let i = 0; i < n; i++) {
      if (this.ringRead === this.ringWrite) { out[i] = 0; continue; }
      out[i] = this.ring[this.ringRead];
      this.ringRead = (this.ringRead + 1) & (this.ring.length - 1);
    }
    return out;
  }

  // ---- state ---------------------------------------------------------------
  // The chip's registers and every oscillator's phase, but NOT the sample ring
  // — that is output, exactly like a framebuffer. The resampler's own phase IS
  // included, so the sample stream after a restore lines up with the one before
  // it rather than starting a fresh sub-sample offset.
  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      select: this.select, mainVol: this.mainVol,
      lfoFreq: this.lfoFreq, lfoCtrl: this.lfoCtrl,
      masterAcc: this._masterAcc, toNextSample: this._toNextSample,
      accL: this._accL, accR: this._accR, accN: this._accN,
      ch: this.ch.map((c) => ({
        wave: c.wave.slice(), freq: c.freq, control: c.control, balance: c.balance,
        waveIndex: c.waveIndex, waveWrite: c.waveWrite, dda: c.dda,
        counter: c.counter, out: c.out,
        noiseCtrl: c.noiseCtrl, noiseCounter: c.noiseCounter, lfsr: c.lfsr, noiseOut: c.noiseOut,
      })),
    };
  }

  setState(s) {
    this.select = s.select; this.mainVol = s.mainVol;
    this.lfoFreq = s.lfoFreq; this.lfoCtrl = s.lfoCtrl;
    this._masterAcc = s.masterAcc; this._toNextSample = s.toNextSample;
    this._accL = s.accL; this._accR = s.accR; this._accN = s.accN;
    for (let i = 0; i < CHANNELS; i++) {
      const c = this.ch[i], d = s.ch[i];
      c.wave.set(d.wave); c.freq = d.freq; c.control = d.control; c.balance = d.balance;
      c.waveIndex = d.waveIndex; c.waveWrite = d.waveWrite; c.dda = d.dda;
      c.counter = d.counter; c.out = d.out;
      c.noiseCtrl = d.noiseCtrl; c.noiseCounter = d.noiseCounter; c.lfsr = d.lfsr; c.noiseOut = d.noiseOut;
    }
    return this;
  }
}

export function createPcePsg(opts) { return new PcePsg(opts); }
