// msm6258 — OKI's 4-bit ADPCM chip, the X68000's sampled sound.
//
// Two registers and no memory: the machine shovels bytes at it and it turns
// each nibble into a 12-bit sample. Every X68000 game's voice, drum and
// explosion is this part, fed by DMA channel 3 at somewhere between 3.9 and
// 15.6 kHz. There is no FIFO, so the transfer rate IS the sample rate — the
// DMAC asks for a byte exactly twice per sample period, and the machine, not
// this file, is what enforces that cadence.
//
// ## The codec
//
// ADPCM here means "the difference from the last sample, scaled by a step size
// that the differences themselves adjust". A nibble is a sign bit and three
// magnitude bits, and the step multiplier is
//
//     diff = sign * (step*b2 + step/2*b1 + step/4*b0 + step/8)
//
// with the step index moving by -1 for a small nibble and by +2/+4/+6/+8 for
// the big ones. The step table is geometric: step(n) = floor(16 * 1.1^n),
// 49 entries. Nothing here is approximated — the table is computed the same
// way the chip's ROM was, so a decoded sample is bit-exact against the
// reference decoder.
//
// The X68000 wires the sample rate to two places at once: the 8255's port C
// picks a divider, and the YM2151's CT1 pin picks the crystal. That is why
// changing the ADPCM rate on this machine means writing to the joystick port.
//
// Pure, deterministic, zero deps.

export const SCHEMA_VERSION = 1;

// Sample rates, indexed by (base clock bit) << 2 | (port C bits 3-2).
// The two halves are the 8 MHz and 4 MHz crystals through /512, /768, /1024.
const RATES = [7812.5, 10416.666666666666, 15625, 10416.666666666666,
               3906.25, 5208.333333333333, 7812.5, 5208.333333333333];

// Step index movement per nibble. Only the low three bits matter; the sign bit
// does not change the step.
const INDEX_SHIFT = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

// diff[step * 16 + nibble], built once. Integer arithmetic on purpose: the
// chip truncates each of the three partial products separately, and rounding
// them together changes the low bit of the output.
const DIFF = (() => {
  const t = new Int32Array(49 * 16);
  for (let step = 0; step <= 48; step++) {
    const val = Math.floor(16 * Math.pow(1.1, step));
    for (let n = 0; n < 16; n++) {
      const sign = (n & 8) ? -1 : 1;
      const b2 = (n >> 2) & 1, b1 = (n >> 1) & 1, b0 = n & 1;
      t[step * 16 + n] = sign * ((val * b2 + ((val / 2) | 0) * b1 + ((val / 4) | 0) * b0 + ((val / 8) | 0)) | 0);
    }
  }
  return t;
})();

export class Msm6258 {
  constructor({ sampleRate = 48000, cpuHz = 10000000 } = {}) {
    this.sampleRate = sampleRate;
    this.cpuHz = cpuHz;
    this.reset();
  }

  reset() {
    this.playing = false;
    this.step = 0;        // step index, 0..48
    this.out = 0;         // the running 12-bit signal
    this.portC = 0x0b;    // what the 8255 comes up with
    this.baseClock = 0;   // 0 = 8 MHz crystal, 4 = 4 MHz
    this.rateIndex = ((this.portC >> 2) & 3);
    this.rate = RATES[this.rateIndex];
    this.dmaAcc = 0;      // CPU cycles owed to the next DMA request
    this.dmaRequests = 0;
    this.phase = 0;       // resampler accumulator, in output samples
    this.last = 0;
    return this;
  }

  // ---- registers -------------------------------------------------------------
  // $E92001 command/status, $E92003 data. Both live on the odd byte.
  read(a) {
    if ((a & 7) === 1) return this.playing ? 0xc0 : 0x40;
    return 0x00;
  }

  write(a, v) {
    v &= 0xff;
    if ((a & 7) === 1) {
      // Bit 0 stops, bit 1 starts. Stop wins, which matters because drivers
      // write $01 then $02 to restart cleanly.
      if (v & 1) { this.playing = false; return; }
      if (v & 2) {
        if (!this.playing) { this.step = 0; this.out = 0; this.playing = true; }
      }
      return;
    }
    if ((a & 7) === 3) {
      if (!this.playing) return;
      // LOW nibble first. Getting the order wrong is audible immediately as a
      // buzz, because the two halves of every sample pair swap.
      this._nibble(v & 0x0f);
      this._nibble((v >> 4) & 0x0f);
    }
  }

  _nibble(n) {
    this.out += DIFF[this.step * 16 + n];
    // The accumulator is 12 bits signed. The chip clips rather than wrapping,
    // which is why an overdriven sample distorts instead of exploding.
    if (this.out > 2047) this.out = 2047; else if (this.out < -2048) this.out = -2048;
    this.step += INDEX_SHIFT[n];
    if (this.step > 48) this.step = 48; else if (this.step < 0) this.step = 0;
    this.last = this.out;
  }

  // ---- clocking ---------------------------------------------------------------
  setPortC(v) {
    this.portC = v & 0x0f;
    const idx = (this.baseClock & 4) | ((this.portC >> 2) & 3);
    if (idx !== this.rateIndex) { this.rateIndex = idx; this.rate = RATES[idx]; this.dmaAcc = 0; }
  }

  // The YM2151's CT1 output picks the crystal.
  setBaseClock(bit) {
    this.baseClock = bit ? 4 : 0;
    this.setPortC(this.portC);
  }

  // One byte is two samples, so the chip wants a byte every 2/rate seconds.
  advance(cycles) {
    if (!this.playing) return this;
    this.dmaAcc += cycles * this.rate;
    const per = this.cpuHz * 2;
    while (this.dmaAcc >= per) { this.dmaAcc -= per; this.dmaRequests++; }
    return this;
  }

  takeDmaRequests() { const n = this.dmaRequests; this.dmaRequests = 0; return n; }

  // The DMAC's external-request line. There is no FIFO to be full, so the
  // chip is ready whenever it is playing and the machine has decided a byte
  // is due.
  get wantsData() { return this.playing; }

  // ---- output -------------------------------------------------------------------
  // Sample and hold: the chip's output is a staircase at its own rate, and
  // reconstructing it any more cleverly would put a filter in front of a sound
  // whose grit is the point.
  renderAdd(out, n = out.length, gain = 1) {
    const scale = gain / 2048;
    const v = this.playing ? this.last * scale : 0;
    for (let i = 0; i < n; i++) out[i] += v;
    return out;
  }

  // ---- state ---------------------------------------------------------------------
  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      playing: this.playing, step: this.step, out: this.out, last: this.last,
      portC: this.portC, baseClock: this.baseClock, rateIndex: this.rateIndex,
      dmaAcc: this.dmaAcc, dmaRequests: this.dmaRequests,
    };
  }

  setState(s) {
    this.playing = s.playing; this.step = s.step; this.out = s.out; this.last = s.last;
    this.portC = s.portC; this.baseClock = s.baseClock; this.rateIndex = s.rateIndex;
    this.rate = RATES[this.rateIndex];
    this.dmaAcc = s.dmaAcc; this.dmaRequests = s.dmaRequests;
    return this;
  }
}

export default Msm6258;
