// sn76489 — the Mega Drive's second sound chip (a Texas Instruments SN76489
// clone inside the VDP package). Three square-wave tone generators and one
// noise generator, one write-only byte-wide port, and no way to read anything
// back. It is the console's Master System inheritance, and Mega Drive games use
// it for exactly the jobs a square wave does better than FM: hi-hats, cymbal
// noise, the shimmer on top of a lead, and every coin/beep sound effect.
//
// ## The whole register interface
//
// One byte. Bit 7 says which kind of write it is:
//
//   1 c c t d d d d   latch: channel cc, type t (0 = tone/noise, 1 = volume),
//                     and the low 4 bits of the value
//   0 x d d d d d d   data: the high 6 bits of whatever was latched last
//
// So a 10-bit tone period takes two writes and a volume takes one. There is no
// address counter and no readback, which is why a driver that loses sync with
// the chip produces a stuck note rather than an error.
//
// ## Noise
//
// A 16-bit LFSR clocked from the same divider as the tones. Bit 2 of the noise
// register picks white (two taps XORed) or periodic (one tap, so the shift
// register cycles and you get a buzzy 1/16-duty pulse). Bits 1-0 pick the
// clock: /512, /1024, /2048, or "whatever channel 3's tone period is", which is
// how drivers sweep the noise pitch.
//
// The Sega variant taps bits 0 and 3 with a 16-bit register. The original TI
// part is 15-bit with different taps and sounds noticeably different — using
// the wrong one gives every Mega Drive drum the wrong colour.
//
// Contract: pure, deterministic, plain-data getState()/setState().

export const SCHEMA_VERSION = 1;

// mclk/15 on an NTSC Mega Drive — the same clock as the Z80.
export const MD_PSG_CLOCK = 3579545;

// The 4-bit attenuation is 2 dB per step, and 15 is off (not -30 dB).
const VOLUME = new Float32Array(16);
for (let i = 0; i < 15; i++) VOLUME[i] = Math.pow(10, -i * 2 / 20);
VOLUME[15] = 0;

const NOISE_TAPS = 0x0009; // bits 0 and 3
const LFSR_INIT = 0x8000;

export class Sn76489 {
  constructor({ clockHz = MD_PSG_CLOCK, sampleRate = 48000 } = {}) {
    this.schemaVersion = SCHEMA_VERSION;
    this.clockHz = clockHz;
    this.sampleRate = sampleRate;
    // The chip divides its clock by 16 before the tone counters, so a period
    // of P gives a square at clock / (32 * P).
    this.step = (clockHz / 16) / sampleRate;
    this.acc = 0;

    this.period = new Uint16Array(4);
    this.volume = new Uint8Array(4);
    this.counter = new Int32Array(4);
    this.sign = new Int8Array(4);
    this.latch = 0;      // which register the next data byte extends
    this.noise = 0;      // the noise control register
    this.lfsr = LFSR_INIT;
    this.reset();
  }

  reset() {
    this.period.fill(0);
    // Silence at power-on is what a driver expects to have to undo; a chip
    // that came up at full volume would scream between reset and the first
    // write, which real hardware does not.
    this.volume.fill(15);
    this.counter.fill(0);
    this.sign.fill(1);
    this.latch = 0;
    this.noise = 0;
    this.lfsr = LFSR_INIT;
    this.acc = 0;
    return this;
  }

  write(v) {
    v &= 0xff;
    if (v & 0x80) {
      this.latch = (v >> 4) & 7;
      const ch = (v >> 5) & 3;
      if (this.latch & 1) this.volume[ch] = v & 0x0f;
      else if (ch === 3) { this.noise = v & 0x0f; this.lfsr = LFSR_INIT; }
      else this.period[ch] = (this.period[ch] & 0x3f0) | (v & 0x0f);
    } else {
      const ch = (this.latch >> 1) & 3;
      if (this.latch & 1) this.volume[ch] = v & 0x0f;
      else if (ch === 3) { this.noise = v & 0x0f; this.lfsr = LFSR_INIT; }
      else this.period[ch] = (this.period[ch] & 0x0f) | ((v & 0x3f) << 4);
    }
    return this;
  }

  // One divider tick: every counter that reaches zero reloads and toggles.
  _tick() {
    for (let c = 0; c < 3; c++) {
      if (--this.counter[c] <= 0) {
        // Period 0 (and 1) put the square above hearing; the chip holds the
        // output high rather than toggling at the clock rate, and drivers use
        // that as a cheap "channel off" that still lets the DC through.
        const p = this.period[c];
        this.counter[c] = p === 0 ? 1 : p;
        if (p > 1) this.sign[c] = -this.sign[c];
        else this.sign[c] = 1;
      }
    }
    if (--this.counter[3] <= 0) {
      const rate = this.noise & 3;
      this.counter[3] = rate === 3 ? (this.period[2] || 1) : (0x10 << rate);
      // The LFSR shifts on every SECOND edge, i.e. once per full square cycle
      // of the noise clock; sign[3] carries that half-step.
      this.sign[3] = -this.sign[3];
      if (this.sign[3] > 0) {
        const white = (this.noise & 4) !== 0;
        const bit = white
          ? (parity(this.lfsr & NOISE_TAPS))
          : (this.lfsr & 1);
        this.lfsr = (this.lfsr >> 1) | (bit << 15);
      }
    }
  }

  _out() {
    let s = 0;
    for (let c = 0; c < 3; c++) s += this.sign[c] * VOLUME[this.volume[c]];
    s += ((this.lfsr & 1) ? 1 : -1) * VOLUME[this.volume[3]];
    return s * 0.25;
  }

  // Mono. The Mega Drive's PSG has no pan control — it is mixed to both
  // channels in the analogue stage, so the machine adds it to L and R equally.
  render(out, n = out.length) {
    for (let i = 0; i < n; i++) {
      this.acc += this.step;
      while (this.acc >= 1) { this.acc -= 1; this._tick(); }
      out[i] = this._out();
    }
    return out;
  }

  // Additive variant: the machine mixes FM and PSG into one buffer without a
  // second pass over it.
  renderAdd(out, n = out.length, gain = 1) {
    for (let i = 0; i < n; i++) {
      this.acc += this.step;
      while (this.acc >= 1) { this.acc -= 1; this._tick(); }
      out[i] += this._out() * gain;
    }
    return out;
  }

  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      period: Array.from(this.period),
      volume: Array.from(this.volume),
      counter: Array.from(this.counter),
      sign: Array.from(this.sign),
      latch: this.latch, noise: this.noise, lfsr: this.lfsr, acc: this.acc,
    };
  }

  setState(s) {
    for (let i = 0; i < 4; i++) {
      this.period[i] = s.period[i]; this.volume[i] = s.volume[i];
      this.counter[i] = s.counter[i]; this.sign[i] = s.sign[i];
    }
    this.latch = s.latch; this.noise = s.noise; this.lfsr = s.lfsr; this.acc = s.acc;
    return this;
  }
}

function parity(v) {
  v ^= v >> 8; v ^= v >> 4; v ^= v >> 2; v ^= v >> 1;
  return v & 1;
}

export function createSn76489(opts) { return new Sn76489(opts); }
export default Sn76489;
