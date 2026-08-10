// ym2151 — Yamaha's OPM, the X68000's music chip.
//
// Eight channels of four-operator FM at 4 MHz. It shares its ancestry with the
// YM2203 (OPN) in ym2203.js — the operator, the envelope shape, the algorithm
// table and the log/linear pair are the same ideas — but four things are
// genuinely different and all four are audible:
//
//   * eight channels, no PSG. Every voice is FM.
//   * the pitch is a KEY CODE, not an F-number. Three bits of octave and four
//     of note, plus a six-bit fraction, which is why an OPM tune transposes by
//     adding a constant rather than by multiplying.
//   * DT2, a coarse detune that multiplies the frequency by 1, 1.41, 1.58 or
//     1.73. There is nothing like it on the OPN, and it is where the metallic
//     bell timbres come from.
//   * a real LFO with four waveforms, and stereo — two bits per channel that
//     put it left, right, both or nowhere.
//
// The noise generator replaces the last operator of channel 7 only, which is
// how one chip does both music and a snare.
//
// ## Rate
//
// The chip produces one sample every 64 clocks: 62500 Hz at 4 MHz. Rather than
// run at that rate and resample, everything here advances by `rateratio`
// per output sample, a 7-bit fixed-point ratio. That is what the reference
// implementation does, and it keeps the envelope, the LFO and the noise in
// step with the phase — they are all driven per output sample, so resampling
// afterwards would detune the envelope, not just the pitch.
//
// Deterministic: the one place the hardware is random (LFO waveform 3) uses a
// seeded generator, so the same tune renders identically every time.

export const SCHEMA_VERSION = 1;

export const X68_OPM_CLOCK = 4000000;

const PGBITS = 9;
const RATIOBITS = 7;
const EG_BOTTOM = 955;

// ---- tables ------------------------------------------------------------------
// log -> linear. 8192 entries, alternating positive and negative, the top 256
// computed and the rest halved every 512 entries (i.e. 6 dB per octave of
// attenuation).
const CLTABLE = (() => {
  const t = new Int32Array(8192);
  let p = 0;
  for (let i = 0; i < 256; i++) {
    let v = Math.floor(Math.pow(2, 13 - i / 256));
    v = (v + 2) & ~3;
    t[p++] = v; t[p++] = -v;
  }
  while (p < 8192) { t[p] = (t[p - 512] / 2) | 0; p++; }
  return t;
})();
const logToLin = (a) => (a < 8192 ? CLTABLE[a] : 0);

// sin -> log. The value is attenuation*2 with the sign in the low bit, so a
// modulated lookup and an envelope add in the same domain.
const SINETABLE = (() => {
  const t = new Int32Array(1024);
  for (let i = 0; i < 512; i++) {
    const r = (i * 2 + 1) * Math.PI / 1024;
    const q = -256 * Math.log(Math.sin(r)) / Math.LN2;
    const s = Math.floor(q + 0.5) + 1;
    t[i] = s * 2;
    t[512 + i] = s * 2 + 1;
  }
  return t;
})();

// One octave of key codes. Entries 3, 7, 11 and 15 duplicate their neighbours
// because the OPM's note field skips four codes — the twelve real notes are
// the ones where (KC & 3) != 3.
const KCTABLE = [5197, 5506, 5833, 6180, 6180, 6547, 6937, 7349,
                 7349, 7786, 8249, 8740, 8740, 9259, 9810, 10394];
// The key fraction: 64 steps to a semitone, 768 to an octave.
const KFTABLE = (() => {
  const t = new Int32Array(64);
  for (let i = 0; i < 64; i++) t[i] = Math.floor(0x10000 * Math.pow(2, i / 768));
  return t;
})();

// DT1, indexed by DT1*32 + the block number. The upper half is the lower half
// negated: detune goes both ways.
const DTTABLE = (() => {
  const base = [
    ...new Array(32).fill(0),
    0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 4, 4, 4, 4,
    4, 6, 6, 6, 8, 8, 8, 10, 10, 12, 12, 14, 16, 16, 16, 16,
    2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 8, 8, 8, 10,
    10, 12, 12, 14, 16, 16, 18, 20, 22, 24, 26, 28, 32, 32, 32, 32,
    4, 4, 4, 4, 4, 6, 6, 6, 8, 8, 8, 10, 10, 12, 12, 14,
    16, 16, 18, 20, 22, 24, 26, 28, 32, 34, 38, 40, 44, 44, 44, 44,
  ];
  const t = new Int32Array(256);
  for (let i = 0; i < 128; i++) { t[i] = base[i]; t[128 + i] = -base[i]; }
  return t;
})();

// Sustain level: fifteen even steps and then "all the way down".
const SLTABLE = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 124];
const FBTABLE = [31, 7, 6, 5, 4, 3, 2, 1];
const DECAYTABLE2 = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2047, 2047, 2047, 2047, 2047];
const DT2LV = [1, 1.4139999151229858, 1.5810000896453857, 1.7319999933242798];

// The envelope's per-step shape. Sixty-four rates by eight sub-steps: the
// pattern is what gives the chip its characteristic non-linear attack.
const ATTACKTABLE = (() => {
  const t = new Int32Array(64 * 8);
  const put = (r, a) => { for (let i = 0; i < 8; i++) t[r * 8 + i] = a[i]; };
  const rep = (v) => [v, v, v, v, v, v, v, v];
  put(0, rep(-1)); put(1, rep(-1));
  for (let r = 2; r <= 5; r++) put(r, rep(4));
  put(6, [4, 4, 4, -1, 4, 4, 4, -1]); put(7, [4, 4, 4, -1, 4, 4, 4, -1]);
  const cycle = [
    [4, -1, 4, -1, 4, -1, 4, -1],
    [4, 4, 4, -1, 4, -1, 4, -1],
    [4, 4, 4, -1, 4, 4, 4, -1],
    [4, 4, 4, 4, 4, 4, 4, -1],
  ];
  for (let r = 8; r <= 47; r++) put(r, cycle[r & 3]);
  put(48, rep(4));
  put(49, [3, 4, 4, 4, 3, 4, 4, 4]); put(50, [3, 4, 3, 4, 3, 4, 3, 4]);
  put(51, [3, 3, 3, 4, 3, 3, 3, 4]); put(52, rep(3));
  put(53, [2, 3, 3, 3, 2, 3, 3, 3]); put(54, [2, 3, 2, 3, 2, 3, 2, 3]);
  put(55, [2, 2, 2, 3, 2, 2, 2, 3]); put(56, rep(2));
  put(57, [1, 2, 2, 2, 1, 2, 2, 2]); put(58, [1, 2, 1, 2, 1, 2, 1, 2]);
  put(59, [1, 1, 1, 2, 1, 1, 1, 2]);
  for (let r = 60; r <= 63; r++) put(r, rep(0));
  return t;
})();

// The decay side is the same shape read as an increment rather than a shift.
const DECAYTABLE1 = (() => {
  const map = { '-1': 0, 0: 16, 1: 8, 2: 4, 3: 2, 4: 1 };
  const t = new Int32Array(64 * 8);
  for (let i = 0; i < 64 * 8; i++) t[i] = map[String(ATTACKTABLE[i])];
  return t;
})();

// PMS depth. The OPM's row of the reference table; the 0.6 is the reference
// implementation's fudge for the real chip's modulation index.
const PMS_DEPTH = [0, 1 / 480, 2 / 480, 4 / 480, 10 / 480, 20 / 480, 80 / 480, 140 / 480];
const PMTABLE = (() => {
  const t = [];
  for (let i = 0; i < 8; i++) {
    const row = new Int32Array(256);
    for (let j = 0; j < 256; j++) {
      row[j] = Math.trunc(0x10000 * (0.6 * PMS_DEPTH[i] * Math.sin(2 * j * Math.PI / 256)));
    }
    t.push(row);
  }
  return t;
})();
// AMS depth: off, then roughly 24, 48 and 96 dB of sweep.
const AMS_SHIFT = [31, 2, 1, 0];
const AMTABLE = (() => {
  const t = [];
  for (let i = 0; i < 4; i++) {
    const row = new Int32Array(256);
    for (let j = 0; j < 256; j++) row[j] = ((((j * 4) >> AMS_SHIFT[i]) * 2) << 2);
    t.push(row);
  }
  return t;
})();

// The LFO's four waveforms, as a phase-indexed pair of (pitch, amplitude).
// Waveform 3 is noise; a seeded generator stands in for the chip's, so a
// replay is a replay.
function lfoTables(seed) {
  const pm = [], am = [];
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 16) & 0xff; };
  for (let type = 0; type < 4; type++) {
    const p = new Int32Array(512), a = new Int32Array(512);
    let r = 0;
    for (let c = 0; c < 512; c++) {
      let pv, av;
      if (type === 0) { pv = (((c + 0x100) & 0x1ff) >> 1) - 0x80; av = 0xff - (c >> 1); }
      else if (type === 1) { av = c < 0x100 ? 0xff : 0; pv = c < 0x100 ? 0x7f : -0x80; }
      else if (type === 2) {
        let q = (c + 0x80) & 0x1ff;
        pv = q < 0x100 ? q - 0x80 : 0x17f - q;
        av = c < 0x100 ? 0xff - c : c - 0x100;
      } else {
        if (!(c & 3)) r = rnd();
        av = r; pv = r - 0x80;
      }
      a[c] = av; p[c] = -pv - 1;
    }
    pm.push(p); am.push(a);
  }
  return { pm, am };
}

const PHASE_ATTACK = 0, PHASE_DECAY = 1, PHASE_SUSTAIN = 2, PHASE_RELEASE = 3, PHASE_OFF = 4;

class Operator {
  constructor(chip) { this.chip = chip; this.reset(); }

  reset() {
    this.dt1 = 0; this.dt2 = 0; this.mul = 0;
    this.tl = 127; this.tlLatch = 127; this.ks = 0;
    this.ar = 0; this.dr = 0; this.sr = 0; this.rr = 2; this.sl = 0;
    this.amon = false; this.ms = 0;
    this.dp = 0; this.bn = 0;
    this.pgCount = 0; this.pgDiff = 0; this.pgDiffLfo = 0;
    this.egLevel = EG_BOTTOM; this.egLevelNext = EG_BOTTOM;
    this.egPhase = PHASE_OFF; this.egCount = 0; this.egCurve = 0;
    this.egRate = 0; this.egCountDiff = 0; this.egOut = 0x3ff << 3;
    this.tlOut = 127 * 8; this.ksr = 0;
    this.out = 0; this.out2 = 0;
    this.keyon = false;
    this.changed = true;
  }

  setDpBn(dp, bn) { this.dp = dp; this.bn = bn; this.changed = true; }

  prepare() {
    if (!this.changed) return;
    this.changed = false;
    const c = this.chip;
    this.pgDiff = Math.imul((this.dp + DTTABLE[this.dt1 * 32 + this.bn]) | 0, c.multable[this.dt2][this.mul]) | 0;
    this.pgDiffLfo = this.pgDiff >> 11;
    this.ksr = this.bn >> (3 - this.ks);
    this.tlOut = this.tl * 8;
    this.amsTable = AMTABLE[this.amon ? ((this.ms >> 4) & 3) : 0];
    this._rate();
    this._egUpdate();
  }

  _rate() {
    switch (this.egPhase) {
      case PHASE_ATTACK: this._setRate(this.ar ? Math.min(63, this.ar + this.ksr) : 0); break;
      case PHASE_DECAY: this._setRate(this.dr ? Math.min(63, this.dr + this.ksr) : 0); break;
      case PHASE_SUSTAIN: this._setRate(this.sr ? Math.min(63, this.sr + this.ksr) : 0); break;
      case PHASE_RELEASE: this._setRate(Math.min(63, this.rr + this.ksr)); break;
      default: this._setRate(0); break;
    }
  }

  _setRate(rate) {
    this.egRate = rate;
    this.egCountDiff = DECAYTABLE2[rate >> 2] * this.chip.rateRatio;
  }

  _egUpdate() { this.egOut = Math.min(this.tlOut + this.egLevel, 0x3ff) << 3; }

  // The phase machine falls through on purpose: an attack rate the key
  // scaling has pushed to maximum skips straight to decay, and a decay with
  // no sustain level to reach skips straight to sustain.
  shiftPhase(next) {
    switch (next) {
      case PHASE_ATTACK:
        this.tl = this.tlLatch;
        this.tlOut = this.tl * 8;
        if ((this.ar + this.ksr) < 62) {
          this._setRate(this.ar ? Math.min(63, this.ar + this.ksr) : 0);
          this.egPhase = PHASE_ATTACK;
          break;
        }
      // falls through
      case PHASE_DECAY:
        if (this.sl) {
          this.egLevel = 0;
          this.egLevelNext = this.sl * 8;
          this._setRate(this.dr ? Math.min(63, this.dr + this.ksr) : 0);
          this.egPhase = PHASE_DECAY;
          break;
        }
      // falls through
      case PHASE_SUSTAIN:
        this.egLevel = this.sl * 8;
        this.egLevelNext = 0x400;
        this._setRate(this.sr ? Math.min(63, this.sr + this.ksr) : 0);
        this.egPhase = PHASE_SUSTAIN;
        break;
      case PHASE_RELEASE:
        if (this.egPhase === PHASE_ATTACK || this.egLevel < EG_BOTTOM) {
          this.egLevelNext = 0x400;
          this._setRate(Math.min(63, this.rr + this.ksr));
          this.egPhase = PHASE_RELEASE;
          break;
        }
      // falls through
      default:
        this.egLevel = EG_BOTTOM;
        this.egLevelNext = EG_BOTTOM;
        this._egUpdate();
        this._setRate(0);
        this.egPhase = PHASE_OFF;
        break;
    }
  }

  keyOn() {
    if (this.keyon) return;
    this.keyon = true;
    if (this.egPhase === PHASE_OFF || this.egPhase === PHASE_RELEASE) {
      this.shiftPhase(PHASE_ATTACK);
      this._egUpdate();
      this.out = this.out2 = 0;
      this.pgCount = 0;
    }
  }

  keyOff() { if (this.keyon) { this.keyon = false; this.shiftPhase(PHASE_RELEASE); } }
  get isOn() { return this.egPhase !== PHASE_OFF; }

  _egStep() {
    this.egCount -= this.egCountDiff;
    if (this.egCount > 0) return;
    this.egCount = (2047 * 3) << RATIOBITS;
    if (this.egPhase === PHASE_ATTACK) {
      const c = ATTACKTABLE[this.egRate * 8 + (this.egCurve & 7)];
      if (c >= 0) {
        this.egLevel -= 1 + (this.egLevel >> c);
        if (this.egLevel <= 0) this.shiftPhase(PHASE_DECAY);
      }
    } else {
      this.egLevel += DECAYTABLE1[this.egRate * 8 + (this.egCurve & 7)];
      if (this.egLevel >= this.egLevelNext) this.shiftPhase(this.egPhase + 1);
    }
    this._egUpdate();
    this.egCurve++;
  }

  calc(input) {
    this._egStep();
    this.out2 = this.out;
    const p = this.pgCount;
    this.pgCount = (this.pgCount + this.pgDiff) >>> 0;
    const pgin = (p >>> 19) + (input >> 1);
    this.out = logToLin(this.egOut + SINETABLE[pgin & 1023]);
    return this.out;
  }

  calcL(input) {
    this._egStep();
    const p = this.pgCount;
    this.pgCount = (this.pgCount + this.pgDiff + ((Math.imul(this.pgDiffLfo, this.chip.pmv) >> 5) | 0)) >>> 0;
    const pgin = (p >>> 19) + (input >> 1);
    this.out = logToLin(this.egOut + SINETABLE[pgin & 1023] + this.amsTable[this.chip.aml]);
    return this.out;
  }

  // Self feedback: the operator modulates itself with the average of its last
  // two outputs, which is what makes the sawtooth-ish timbres.
  calcFb(fb) {
    this._egStep();
    const inp = (this.out + this.out2) | 0;
    this.out2 = this.out;
    const p = this.pgCount;
    this.pgCount = (this.pgCount + this.pgDiff) >>> 0;
    let pgin = p >>> 19;
    if (fb < 31) pgin += ((inp << 17) >> fb) >> 19;
    this.out = logToLin(this.egOut + SINETABLE[pgin & 1023]);
    return this.out2;
  }

  calcFbL(fb) {
    this._egStep();
    const inp = (this.out + this.out2) | 0;
    this.out2 = this.out;
    const p = this.pgCount;
    this.pgCount = (this.pgCount + this.pgDiff + ((Math.imul(this.pgDiffLfo, this.chip.pmv) >> 5) | 0)) >>> 0;
    let pgin = p >>> 19;
    if (fb < 31) pgin += ((inp << 17) >> fb) >> 19;
    this.out = logToLin(this.egOut + SINETABLE[pgin & 1023] + this.amsTable[this.chip.aml]);
    return this.out;
  }

  // The noise operator bypasses the sine entirely: its output is the envelope
  // level with the LFSR's bit as a sign.
  calcN(noise) {
    this._egStep();
    const lv = Math.max(0, 0x3ff - (this.tlOut + this.egLevel)) << 1;
    return (noise & 1) ? lv : -lv;
  }
}

class Channel {
  constructor(chip) {
    this.chip = chip;
    this.op = [new Operator(chip), new Operator(chip), new Operator(chip), new Operator(chip)];
    this.alg = 0; this.fb = FBTABLE[0]; this.pan = 3;
    this.kc = 0; this.kf = 0;
    this.buf = [0, 0, 0, 0];
  }

  reset() { for (const o of this.op) o.reset(); this.alg = 0; this.fb = FBTABLE[0]; this.pan = 3; this.kc = this.kf = 0; }

  setKcKf(kc, kf) {
    const oct = (kc >> 4) & 7;
    let kcv = KCTABLE[kc & 15];
    kcv = (((kcv + 2) / 4) | 0) * 4;
    const dp = (Math.floor(kcv * KFTABLE[kf & 63] / 0x80000) << oct) | 0;
    const bn = (kc >> 2) & 31;
    for (const o of this.op) o.setDpBn(dp, bn);
  }

  keyControl(mask) {
    for (let i = 0; i < 4; i++) { if (mask & (1 << i)) this.op[i].keyOn(); else this.op[i].keyOff(); }
  }

  // Returns two flags: bit0 "something is sounding", bit1 "this channel wants
  // the LFO". The mixer uses them to skip whole channels.
  prepare() {
    for (const o of this.op) o.prepare();
    this.pms = PMTABLE[this.op[0].ms & 7];
    const key = (this.op[0].isOn || this.op[1].isOn || this.op[2].isOn || this.op[3].isOn) ? 1 : 0;
    const amon = this.op[0].amon || this.op[1].amon || this.op[2].amon || this.op[3].amon;
    const lfo = (this.op[0].ms & (amon ? 0x37 : 7)) ? 2 : 0;
    return key | lfo;
  }

  // The eight algorithms. Note that op[0]'s feedback call comes LAST in every
  // one of them: the modulator is a sample behind, which is part of the sound.
  calc() {
    const op = this.op, fb = this.fb;
    let r;
    switch (this.alg) {
      case 0: op[2].calc(op[1].out); op[1].calc(op[0].out); r = op[3].calc(op[2].out); op[0].calcFb(fb); break;
      case 1: op[2].calc(op[0].out + op[1].out); op[1].calc(0); r = op[3].calc(op[2].out); op[0].calcFb(fb); break;
      case 2: op[2].calc(op[1].out); op[1].calc(0); r = op[3].calc(op[0].out + op[2].out); op[0].calcFb(fb); break;
      case 3: op[2].calc(0); op[1].calc(op[0].out); r = op[3].calc(op[1].out + op[2].out); op[0].calcFb(fb); break;
      case 4: op[2].calc(0); r = op[1].calc(op[0].out); r += op[3].calc(op[2].out); op[0].calcFb(fb); break;
      case 5: r = op[2].calc(op[0].out); r += op[1].calc(op[0].out); r += op[3].calc(op[0].out); op[0].calcFb(fb); break;
      case 6: r = op[2].calc(0); r += op[1].calc(op[0].out); r += op[3].calc(0); op[0].calcFb(fb); break;
      default: r = op[2].calc(0); r += op[1].calc(0); r += op[3].calc(0); r += op[0].calcFb(fb); break;
    }
    return r;
  }

  calcLfo() {
    this.chip.pmv = this.pms[this.chip.pml];
    const op = this.op, fb = this.fb;
    let r;
    switch (this.alg) {
      case 0: op[2].calcL(op[1].out); op[1].calcL(op[0].out); r = op[3].calcL(op[2].out); op[0].calcFbL(fb); break;
      case 1: op[2].calcL(op[0].out + op[1].out); op[1].calcL(0); r = op[3].calcL(op[2].out); op[0].calcFbL(fb); break;
      case 2: op[2].calcL(op[1].out); op[1].calcL(0); r = op[3].calcL(op[0].out + op[2].out); op[0].calcFbL(fb); break;
      case 3: op[2].calcL(0); op[1].calcL(op[0].out); r = op[3].calcL(op[1].out + op[2].out); op[0].calcFbL(fb); break;
      case 4: op[2].calcL(0); r = op[1].calcL(op[0].out); r += op[3].calcL(op[2].out); op[0].calcFbL(fb); break;
      case 5: r = op[2].calcL(op[0].out); r += op[1].calcL(op[0].out); r += op[3].calcL(op[0].out); op[0].calcFbL(fb); break;
      case 6: r = op[2].calcL(0); r += op[1].calcL(op[0].out); r += op[3].calcL(0); op[0].calcFbL(fb); break;
      default: r = op[2].calcL(0); r += op[1].calcL(0); r += op[3].calcL(0); r += op[0].calcFbL(fb); break;
    }
    return r;
  }

  calcNoise(noise) {
    const op = this.op, fb = this.fb;
    op[0].calcFb(fb);
    op[1].calc(op[0].out);
    op[2].calc(0);
    const prev = op[3].out;
    op[3].out = op[3].calcN(noise);
    return op[2].out + prev;
  }
}

export class Ym2151 {
  constructor({ clockHz = X68_OPM_CLOCK, sampleRate = 48000, lfoSeed = 1 } = {}) {
    this.clockHz = clockHz;
    this.sampleRate = sampleRate;
    // One chip sample per 64 clocks. `rateRatio` converts that into steps of
    // the host's output rate, in 7-bit fixed point.
    this.fmClock = (clockHz / 64) | 0;
    this.rateRatio = (((this.fmClock << RATIOBITS) + (sampleRate >> 1)) / sampleRate) | 0;
    this.multable = [];
    for (let h = 0; h < 4; h++) {
      const row = new Int32Array(16);
      const rr = DT2LV[h] * this.rateRatio / (1 << (2 + RATIOBITS - PGBITS));
      for (let l = 0; l < 16; l++) row[l] = ((l ? l * 2 : 1) * rr) | 0;
      this.multable.push(row);
    }
    const lt = lfoTables(lfoSeed);
    this.lfoPm = lt.pm; this.lfoAm = lt.am;
    this.ch = [];
    for (let i = 0; i < 8; i++) this.ch.push(new Channel(this));
    this.reg = new Uint8Array(256);
    this.reset();
  }

  reset() {
    this.reg.fill(0);
    for (const c of this.ch) c.reset();
    this.curReg = 0;
    this.status = 0;
    this.noise = 12345;
    this.noiseCount = 0;
    this.noiseDelta = 0;
    this.regTc = 0;
    this.lfoFreq = 0; this.lfoWave = 0; this.pmd = 0; this.amd = 0;
    this.lfoCount = 0; this.lfoCountDiff = 0; this.lfoStep = 0;
    this.pml = 0; this.aml = 0; this.pmv = 0;
    this.timerA = 0; this.timerB = 0;
    this.timerACount = 0; this.timerBCount = 0;
    this.timerStep = ((1000000 * 65536) / this.fmClock) | 0;
    this.regTa = [0, 0];
    this.usAcc = 0;
    this.irq = false;
    this._setTimerA(); this._setTimerB(0);
    return this;
  }

  // ---- registers -------------------------------------------------------------
  // Two ports: the address latch and the data. Reading gives the status byte,
  // whose two low bits are the timer overflow flags the driver polls.
  writeAddress(v) { this.curReg = v & 0xff; }

  writeData(v) {
    v &= 0xff;
    // CT1 and CT2 are general-purpose output pins, and on this machine they
    // are wired to things: CT1 forces the floppy controller ready, CT2 halves
    // the ADPCM's crystal. That is why register $1B has side effects outside
    // the sound chip.
    if (this.curReg === 0x1b && this.onCtrl) this.onCtrl((v >> 6) & 1, (v >> 7) & 1);
    this.setReg(this.curReg, v);
  }

  readStatus() { return this.status & 3; }

  setReg(addr, data) {
    if (addr >= 0x100) return;
    this.reg[addr] = data;
    const c = addr & 7;
    if (addr < 0x20) {
      switch (addr) {
        case 0x01:
          if (data & 2) { this.lfoCount = 0; }
          this.reg01 = data;
          return;
        case 0x08:
          if (!(this.regTc & 0x80)) this.ch[data & 7].keyControl((data >> 3) & 15);
          else {
            const ch = this.ch[data & 7];
            for (let i = 0; i < 4; i++) if (!(data & (8 << i))) ch.op[i].keyOff();
          }
          return;
        case 0x0f: this.noiseDelta = data; this.noiseCount = 0; return;
        case 0x10: this.regTa[0] = data; this._setTimerA(); return;
        case 0x11: this.regTa[1] = data & 3; this._setTimerA(); return;
        case 0x12: this._setTimerB(data); return;
        case 0x14: this._timerControl(data); return;
        case 0x18:
          this.lfoFreq = data;
          this.lfoCountDiff = ((this.rateRatio * ((16 + (data & 15)) << (16 - 4 - RATIOBITS))) / (1 << (15 - (data >> 4)))) | 0;
          return;
        case 0x19:
          if (data & 0x80) this.pmd = data & 0x7f; else this.amd = data & 0x7f;
          return;
        case 0x1b: this.lfoWave = data & 3; return;
        default: return;
      }
    }
    if (addr < 0x40) {
      const ch = this.ch[c];
      if (addr < 0x28) { ch.fb = FBTABLE[(data >> 3) & 7]; ch.alg = data & 7; ch.pan = (data >> 6) & 3; return; }
      if (addr < 0x30) { ch.kc = data; ch.setKcKf(ch.kc, ch.kf); return; }
      if (addr < 0x38) { ch.kf = data >> 2; ch.setKcKf(ch.kc, ch.kf); return; }
      // PMS and AMS arrive in one byte and are stored nibble-swapped, which is
      // how the operator reads them back out.
      const ms = ((data << 4) | (data >> 4)) & 0xff;
      for (const o of ch.op) { o.ms = ms; o.changed = true; }
      return;
    }
    // Operator registers. The slot field in the address is NOT the internal
    // operator order: M1, M2, C1, C2 in the register map are operators
    // 0, 2, 1, 3 here, which is also the order the key-on bits use.
    const slot = [0, 2, 1, 3][(addr >> 3) & 3];
    const op = this.ch[c].op[slot];
    switch ((addr >> 5) & 7) {
      case 2: op.dt1 = (data >> 4) & 7; op.mul = data & 15; break;
      case 3: op.tlLatch = data & 0x7f; if (!(this.regTc & 0x80)) op.tl = data & 0x7f; break;
      case 4: op.ks = (data >> 6) & 3; op.ar = (data & 0x1f) * 2; break;
      case 5: op.dr = (data & 0x1f) * 2; op.amon = (data & 0x80) !== 0; break;
      case 6: op.sr = (data & 0x1f) * 2; op.dt2 = (data >> 6) & 3; break;
      case 7: op.sl = SLTABLE[(data >> 4) & 15]; op.rr = (data & 0x0f) * 4 + 2; break;
      default: break;
    }
    op.changed = true;
  }

  // ---- timers ------------------------------------------------------------------
  _setTimerA() {
    const clka = (this.regTa[0] << 2) + (this.regTa[1] & 3);
    this.timerA = (1024 - clka) * this.timerStep;
  }

  _setTimerB(data) {
    this.regTb = data;
    this.timerB = (256 - data) * this.timerStep;
  }

  _timerControl(data) {
    const changed = this.regTc ^ data;
    this.regTc = data;
    if (data & 0x10) this._resetStatus(1);
    if (data & 0x20) this._resetStatus(2);
    // LOAD only acts on a transition, so writing the same value again does not
    // restart a timer that is already running.
    if (changed & 1) this.timerACount = (data & 1) ? this.timerA : 0;
    if (changed & 2) this.timerBCount = (data & 2) ? this.timerB : 0;
  }

  _setStatus(bits) {
    if (!(this.status & bits)) { this.status |= bits; this.irq = true; if (this.onIrq) this.onIrq(); }
  }

  _resetStatus(bits) {
    if (this.status & bits) { this.status &= ~bits; if (!this.status) this.irq = false; }
  }

  // `cycles` is 68000 clocks at 10 MHz; ten of them are a microsecond, and the
  // timers count microseconds.
  advance(cycles) {
    this.usAcc += cycles;
    const us = (this.usAcc / 10) | 0;
    if (us <= 0) return this;
    this.usAcc -= us * 10;
    this._count(us);
    return this;
  }

  _count(us) {
    if (this.timerACount) {
      this.timerACount -= us * 65536;
      if (this.timerACount <= 0) {
        // CSM mode retriggers every operator of every channel on the Timer A
        // overflow. It is how one chip plays formant speech.
        if (this.regTc & 0x80) for (const c of this.ch) { c.keyControl(0); c.keyControl(15); }
        while (this.timerACount <= 0) this.timerACount += this.timerA || 1;
        if (this.regTc & 4) this._setStatus(1);
      }
    }
    if (this.timerBCount) {
      // Timer B counts sixteen times slower than Timer A for the same value.
      this.timerBCount -= us * 4096;
      if (this.timerBCount <= 0) {
        while (this.timerBCount <= 0) this.timerBCount += this.timerB || 1;
        if (this.regTc & 8) this._setStatus(2);
      }
    }
  }

  // ---- synthesis --------------------------------------------------------------
  _noise() {
    this.noiseCount += 2 * this.rateRatio;
    if (this.noiseCount >= (32 << RATIOBITS)) {
      let n = 32 - (this.noiseDelta & 0x1f);
      if (n === 1) n = 2;
      this.noiseCount -= n << RATIOBITS;
      this.noise = (this.noise >> 1) ^ ((this.noise & 1) ? 0x8408 : 0);
    }
    return this.noise;
  }

  _lfo() {
    const c = (this.lfoCount >> 15) & 0x1fe;
    this.pml = ((this.lfoPm[this.lfoWave][c] * this.pmd / 128) + 0x80) & 255;
    this.aml = ((this.lfoAm[this.lfoWave][c] * this.amd / 128) | 0) & 255;
    this.lfoStep++;
    if ((this.lfoStep & 7) === 0) this.lfoCount = (this.lfoCount + this.lfoCountDiff) | 0;
  }

  // Stereo. `pan` is two bits: 1 is left, 2 is right, 3 is both and 0 is
  // nowhere at all — a channel panned to 0 is silent, which drivers use as a
  // mute.
  render(left, right, n) {
    let active = 0;
    for (let i = 0; i < 8; i++) active = (active << 2) | this.ch[i].prepare();
    if (!(active & 0x5555)) { for (let i = 0; i < n; i++) { left[i] = 0; right[i] = 0; } return; }
    if (this.reg01 & 0x02) active &= 0x5555;
    const useLfo = (active & 0xaaaa) !== 0;
    for (let i = 0; i < n; i++) {
      this._lfo();
      let l = 0, r = 0;
      for (let c = 0; c < 8; c++) {
        if (!(active & (0x4000 >> (c * 2)))) continue;
        let v;
        if (c === 7 && (this.noiseDelta & 0x80)) v = this.ch[7].calcNoise(this._noise());
        else v = useLfo ? this.ch[c].calcLfo() : this.ch[c].calc();
        const pan = this.ch[c].pan;
        if (pan & 1) l += v;
        if (pan & 2) r += v;
      }
      left[i] = Math.max(-0x10000, Math.min(0xffff, l)) / 0x10000;
      right[i] = Math.max(-0x10000, Math.min(0xffff, r)) / 0x10000;
    }
  }

  renderMono(out, n = out.length) {
    if (!this._l || this._l.length < n) { this._l = new Float32Array(n); this._r = new Float32Array(n); }
    this.render(this._l, this._r, n);
    for (let i = 0; i < n; i++) out[i] = (this._l[i] + this._r[i]) * 0.5;
    return out;
  }

  // ---- state -----------------------------------------------------------------
  // The operators live in a flat array rather than as objects: a snapshot is
  // taken every frame into the host's rewind ring, and thirty-two short-lived
  // objects a frame is thirty thousand a second of garbage.
  getState() {
    const ops = new Float64Array(8 * 4 * 22);
    let k = 0;
    for (const c of this.ch) {
      for (const o of c.op) {
        ops[k++] = o.dt1; ops[k++] = o.dt2; ops[k++] = o.mul; ops[k++] = o.tl;
        ops[k++] = o.tlLatch; ops[k++] = o.ks; ops[k++] = o.ar; ops[k++] = o.dr;
        ops[k++] = o.sr; ops[k++] = o.rr; ops[k++] = o.sl; ops[k++] = o.amon ? 1 : 0;
        ops[k++] = o.ms; ops[k++] = o.dp; ops[k++] = o.bn; ops[k++] = o.pgCount;
        ops[k++] = o.egLevel; ops[k++] = o.egLevelNext; ops[k++] = o.egPhase;
        ops[k++] = o.egCount; ops[k++] = o.egCurve; ops[k++] = (o.keyon ? 1 : 0) + (o.out * 4) + (o.out2 * 4194304);
      }
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      reg: Array.from(this.reg), ops: Array.from(ops),
      chan: this.ch.map((c) => ({ alg: c.alg, fb: c.fb, pan: c.pan, kc: c.kc, kf: c.kf })),
      curReg: this.curReg, status: this.status, noise: this.noise,
      noiseCount: this.noiseCount, noiseDelta: this.noiseDelta, regTc: this.regTc,
      lfoFreq: this.lfoFreq, lfoWave: this.lfoWave, pmd: this.pmd, amd: this.amd,
      lfoCount: this.lfoCount, lfoCountDiff: this.lfoCountDiff, lfoStep: this.lfoStep,
      pml: this.pml, aml: this.aml, pmv: this.pmv,
      timerA: this.timerA, timerB: this.timerB,
      timerACount: this.timerACount, timerBCount: this.timerBCount,
      regTa: [...this.regTa], regTb: this.regTb, usAcc: this.usAcc, irq: this.irq,
      reg01: this.reg01 ?? 0,
    };
  }

  setState(s) {
    this.reg.set(s.reg);
    let k = 0;
    for (let ci = 0; ci < 8; ci++) {
      const c = this.ch[ci];
      Object.assign(c, s.chan[ci]);
      for (const o of c.op) {
        o.dt1 = s.ops[k++]; o.dt2 = s.ops[k++]; o.mul = s.ops[k++]; o.tl = s.ops[k++];
        o.tlLatch = s.ops[k++]; o.ks = s.ops[k++]; o.ar = s.ops[k++]; o.dr = s.ops[k++];
        o.sr = s.ops[k++]; o.rr = s.ops[k++]; o.sl = s.ops[k++]; o.amon = s.ops[k++] !== 0;
        o.ms = s.ops[k++]; o.dp = s.ops[k++]; o.bn = s.ops[k++]; o.pgCount = s.ops[k++];
        o.egLevel = s.ops[k++]; o.egLevelNext = s.ops[k++]; o.egPhase = s.ops[k++];
        o.egCount = s.ops[k++]; o.egCurve = s.ops[k++];
        const packed = s.ops[k++];
        o.keyon = (packed % 2) !== 0;
        o.out2 = Math.round((packed - (o.keyon ? 1 : 0)) / 4194304);
        o.out = Math.round((packed - (o.keyon ? 1 : 0) - o.out2 * 4194304) / 4);
        o.changed = true;
      }
    }
    this.curReg = s.curReg; this.status = s.status; this.noise = s.noise;
    this.noiseCount = s.noiseCount; this.noiseDelta = s.noiseDelta; this.regTc = s.regTc;
    this.lfoFreq = s.lfoFreq; this.lfoWave = s.lfoWave; this.pmd = s.pmd; this.amd = s.amd;
    this.lfoCount = s.lfoCount; this.lfoCountDiff = s.lfoCountDiff; this.lfoStep = s.lfoStep;
    this.pml = s.pml; this.aml = s.aml; this.pmv = s.pmv;
    this.timerA = s.timerA; this.timerB = s.timerB;
    this.timerACount = s.timerACount; this.timerBCount = s.timerBCount;
    this.regTa = [...s.regTa]; this.regTb = s.regTb; this.usAcc = s.usAcc; this.irq = s.irq;
    this.reg01 = s.reg01;
    return this;
  }
}

export function createYm2151(opts) { return new Ym2151(opts); }
export default Ym2151;
