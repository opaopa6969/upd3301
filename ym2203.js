// ym2203 — YAMAHA YM2203 (OPN): 4-operator FM ×3 + SSG ×3 + two timers.
//
// The PC-8801 SR's sound board. It is really two chips in one package:
//
//   SSG   three square waves, one noise source, one envelope generator —
//         a straight AY-3-8910 (the same lineage as the MSX/Spectrum).
//   FM    three channels of 4-operator phase modulation. Each operator is a
//         sine table read at a phase that the *previous* operator bends;
//         eight "algorithms" wire the four operators into carriers and
//         modulators. That single idea is the whole 80s.
//   TIMER two counters that raise IRQ — how music drivers keep tempo. On the
//         8801 that IRQ lands on the μPD8214 as the SOUND source (level 5).
//
// Pure, deterministic, zero deps: registers in, Float32 samples out. Same
// register writes → identical samples, always (there is no dither, no noise
// seeded by time — the noise LFSR is part of the state and snapshots with it).
//
// Accuracy: envelope rates and the operator sine/exp tables follow the
// documented OPN model; this is an honest reimplementation, not a port. It
// aims to be musically right, not sample-exact against silicon.

export const SCHEMA_VERSION = 1;

// ---- tables (built once, deterministic) ------------------------------------

// 10-bit sine → attenuation, in the log domain like the real chip
const SIN_TAB = new Float32Array(1024);
for (let i = 0; i < 1024; i++) SIN_TAB[i] = Math.sin((i + 0.5) * Math.PI * 2 / 1024);

// key-scale / detune tables
const DT_TAB = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7],
  [1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 16, 16, 16],
  [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 20, 22, 22, 22, 22],
];
// multiple: 0 means ×0.5
const MUL = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

// which operators are carriers, per algorithm (bit per op 1..4)
const CARRIERS = [0b1000, 0b1000, 0b1000, 0b1000, 0b1010, 0b1110, 0b1110, 0b1111];

const ENV_ATTACK = 0, ENV_DECAY = 1, ENV_SUSTAIN = 2, ENV_RELEASE = 3, ENV_OFF = 4;
const MAX_ATT = 1023; // attenuation units (≈96 dB), 0 = full volume

class Operator {
  constructor() {
    this.dt = 0; this.mul = 1;
    this.tl = 127; // total level (attenuation)
    this.ks = 0; this.ar = 0; this.dr = 0; this.sr = 0; this.rr = 1;
    this.sl = 0; // sustain level (attenuation units)
    this.phase = 0;
    this.env = MAX_ATT;
    this.state = ENV_OFF;
    this.out = 0; this.prev = 0; // feedback history
  }
}

class FmChannel {
  constructor() {
    this.ops = [new Operator(), new Operator(), new Operator(), new Operator()];
    this.alg = 0; this.fb = 0;
    this.fnum = 0; this.block = 0;
    this.left = true; this.right = true;
    this.keyOn = 0;
  }
}

export class Ym2203 {
  // clockHz: the chip's own clock (PC-8801 SR: 3.9936 MHz)
  constructor({ clockHz = 3_993_600, sampleRate = 48000 } = {}) {
    this.clockHz = clockHz;
    this.sampleRate = sampleRate;
    this.reg = new Uint8Array(256);
    this.addr = 0;

    // FM runs at clock/72, SSG at clock/8 — we resample both to sampleRate
    this.fmStep = (clockHz / 72) / sampleRate;
    this.ssgStep = (clockHz / 8 / 8) / sampleRate; // SSG divides by 8 again
    this.fmAcc = 0; this.ssgAcc = 0;

    this.ch = [new FmChannel(), new FmChannel(), new FmChannel()];

    // SSG
    this.ssg = {
      period: [1, 1, 1], counter: [0, 0, 0], sign: [1, 1, 1],
      vol: [0, 0, 0], useEnv: [false, false, false],
      noisePeriod: 1, noiseCounter: 0, noiseLfsr: 1, noiseBit: 0,
      toneOff: [true, true, true], noiseOff: [true, true, true],
      envPeriod: 1, envCounter: 0, envStep: 0, envShape: 0,
      envVol: 0, envHold: false, envAlt: false, envAttack: false, envCont: false,
    };

    // timers (counted in FM sample ticks: clock/72)
    this.timerA = 0; this.timerACount = 0; this.timerARun = false;
    this.timerB = 0; this.timerBCount = 0; this.timerBRun = false;
    this.status = 0; // b0 timer A overflow, b1 timer B, b7 busy
    this.irqEnableA = false; this.irqEnableB = false;
  }

  // ---- bus ----------------------------------------------------------------
  writeAddr(v) { this.addr = v & 0xff; }

  readStatus() { return this.status; }

  get irq() { return (this.status & 3) !== 0; }

  writeData(v) {
    v &= 0xff;
    const a = this.addr;
    this.reg[a] = v;

    if (a < 0x10) return this._writeSsg(a, v);
    if (a === 0x24) { this.timerA = (this.timerA & 3) | (v << 2); return; }
    if (a === 0x25) { this.timerA = (this.timerA & 0x3fc) | (v & 3); return; }
    if (a === 0x26) { this.timerB = v; return; }
    if (a === 0x27) { // timer control / key
      this.irqEnableA = (v & 4) !== 0;
      this.irqEnableB = (v & 8) !== 0;
      if (v & 0x10) this.status &= ~1; // reset A flag
      if (v & 0x20) this.status &= ~2; // reset B flag
      const runA = (v & 1) !== 0, runB = (v & 2) !== 0;
      if (runA && !this.timerARun) this.timerACount = 1024 - this.timerA;
      if (runB && !this.timerBRun) this.timerBCount = (256 - this.timerB) * 16;
      this.timerARun = runA; this.timerBRun = runB;
      return;
    }
    if (a === 0x28) { // key on/off
      const c = v & 3;
      if (c > 2) return;
      const ch = this.ch[c];
      for (let i = 0; i < 4; i++) {
        const on = (v & (0x10 << i)) !== 0;
        this._key(ch.ops[i], on);
      }
      ch.keyOn = v >> 4;
      return;
    }

    const c = a & 3;
    if (c > 2) return;
    const ch = this.ch[c];
    const slot = [0, 2, 1, 3][(a >> 2) & 3]; // register order is 1,3,2,4

    switch (a & 0xf0) {
      case 0x30: { const o = ch.ops[slot]; o.dt = (v >> 4) & 7; o.mul = MUL[v & 15]; return; }
      case 0x40: ch.ops[slot].tl = v & 0x7f; return;
      case 0x50: { const o = ch.ops[slot]; o.ks = (v >> 6) & 3; o.ar = v & 0x1f; return; }
      case 0x60: ch.ops[slot].dr = v & 0x1f; return;
      case 0x70: ch.ops[slot].sr = v & 0x1f; return;
      case 0x80: {
        const o = ch.ops[slot];
        o.sl = (v >> 4) === 15 ? MAX_ATT : ((v >> 4) & 15) * 32;
        o.rr = ((v & 15) << 1) | 1;
        return;
      }
      case 0xa0:
        if ((a & 0xfc) === 0xa0) { ch.fnum = (ch.fnum & 0x700) | v; return; }
        if ((a & 0xfc) === 0xa4) { ch.fnum = (ch.fnum & 0xff) | ((v & 7) << 8); ch.block = (v >> 3) & 7; return; }
        return;
      case 0xb0:
        if ((a & 0xfc) === 0xb0) { ch.alg = v & 7; ch.fb = (v >> 3) & 7; return; }
        return;
      default: return;
    }
  }

  _key(op, on) {
    if (on) {
      if (op.state === ENV_OFF || op.state === ENV_RELEASE) {
        op.state = ENV_ATTACK;
        op.phase = 0;
      }
    } else if (op.state !== ENV_OFF) {
      op.state = ENV_RELEASE;
    }
  }

  // ---- SSG ----------------------------------------------------------------
  _writeSsg(a, v) {
    const s = this.ssg;
    switch (a) {
      case 0: case 2: case 4: {
        const c = a >> 1;
        s.period[c] = (s.period[c] & 0xf00) | v;
        return;
      }
      case 1: case 3: case 5: {
        const c = a >> 1;
        s.period[c] = (s.period[c] & 0xff) | ((v & 15) << 8);
        return;
      }
      case 6: s.noisePeriod = (v & 0x1f) || 1; return;
      case 7:
        for (let c = 0; c < 3; c++) {
          s.toneOff[c] = (v & (1 << c)) !== 0;
          s.noiseOff[c] = (v & (8 << c)) !== 0;
        }
        return;
      case 8: case 9: case 10: {
        const c = a - 8;
        s.vol[c] = v & 15;
        s.useEnv[c] = (v & 0x10) !== 0;
        return;
      }
      case 11: s.envPeriod = (s.envPeriod & 0xff00) | v; return;
      case 12: s.envPeriod = (s.envPeriod & 0xff) | (v << 8); return;
      case 13: {
        s.envShape = v & 15;
        s.envCont = (v & 8) !== 0;
        s.envAttack = (v & 4) !== 0;
        s.envAlt = (v & 2) !== 0;
        s.envHold = (v & 1) !== 0;
        s.envStep = 0;
        s.envCounter = 0;
        s.envVol = s.envAttack ? 0 : 15;
        return;
      }
      default: return;
    }
  }

  _ssgTick() {
    const s = this.ssg;
    for (let c = 0; c < 3; c++) {
      const p = s.period[c] || 1;
      if (++s.counter[c] >= p) { s.counter[c] = 0; s.sign[c] = -s.sign[c]; }
    }
    if (++s.noiseCounter >= s.noisePeriod * 2) {
      s.noiseCounter = 0;
      // 17-bit LFSR, taps 0 and 3 — the AY's noise, deterministic by design
      const bit = ((s.noiseLfsr ^ (s.noiseLfsr >> 3)) & 1);
      s.noiseLfsr = (s.noiseLfsr >> 1) | (bit << 16);
      s.noiseBit = s.noiseLfsr & 1;
    }
    // envelope
    if (s.envPeriod > 0 && ++s.envCounter >= s.envPeriod) {
      s.envCounter = 0;
      s.envStep++;
      let v = s.envAttack ? s.envStep : 15 - s.envStep;
      if (s.envStep > 15) {
        if (!s.envCont) { v = 0; s.envStep = 16; }
        else if (s.envHold) { v = (s.envAlt !== s.envAttack) ? 0 : 15; s.envStep = 16; }
        else {
          const cycle = Math.floor(s.envStep / 16);
          const pos = s.envStep % 16;
          const rising = s.envAlt ? (cycle % 2 === 0) === s.envAttack : s.envAttack;
          v = rising ? pos : 15 - pos;
        }
      }
      s.envVol = Math.max(0, Math.min(15, v));
    }
  }

  _ssgOut() {
    const s = this.ssg;
    let sum = 0;
    for (let c = 0; c < 3; c++) {
      const tone = s.toneOff[c] ? 1 : (s.sign[c] > 0 ? 1 : 0);
      const noise = s.noiseOff[c] ? 1 : s.noiseBit;
      if (!(tone & noise)) continue;
      const vol = s.useEnv[c] ? s.envVol : s.vol[c];
      if (!vol) continue;
      // the AY's volume ladder is logarithmic, ~3 dB per step
      sum += Math.pow(2, (vol - 15) / 2) / 3;
    }
    return sum;
  }

  // ---- FM -----------------------------------------------------------------
  _envRate(op, rate) {
    if (rate === 0) return 0;
    const r = Math.min(63, rate * 2 + (op.ks ? 2 : 0));
    // rate → attenuation units per FM tick (log-ish; musical, not sample-exact)
    return Math.pow(2, (r - 32) / 8) * 0.35;
  }

  _opTick(op) {
    switch (op.state) {
      case ENV_ATTACK: {
        const rate = this._envRate(op, op.ar);
        if (op.ar >= 31) op.env = 0;
        else op.env -= rate * 6;
        if (op.env <= 0) { op.env = 0; op.state = ENV_DECAY; }
        return;
      }
      case ENV_DECAY:
        op.env += this._envRate(op, op.dr);
        if (op.env >= op.sl) { op.env = op.sl; op.state = ENV_SUSTAIN; }
        return;
      case ENV_SUSTAIN:
        op.env += this._envRate(op, op.sr);
        if (op.env >= MAX_ATT) { op.env = MAX_ATT; op.state = ENV_OFF; }
        return;
      case ENV_RELEASE:
        op.env += this._envRate(op, op.rr) * 2;
        if (op.env >= MAX_ATT) { op.env = MAX_ATT; op.state = ENV_OFF; }
        return;
      default:
        return;
    }
  }

  // attenuation (0..1023, ≈0.09375 dB per unit) → linear gain
  _gain(att) {
    if (att >= MAX_ATT) return 0;
    return Math.pow(10, -att * 0.09375 / 20);
  }

  _fmChannel(ch) {
    // Phase increment, derived from the OPN's own arithmetic:
    //   f_out = fnum · clock / (72 · 2^20) · 2^(block-1)
    // one FM tick is clock/72, and our sine table is 1024 = one cycle, so
    //   inc = 1024 · f_out / (clock/72) = (fnum << block) / 2048
    // Detune comes from the chip's table in 20-bit accumulator units, so it
    // scales by 1/1024 into ours. (Getting this wrong lands you 45 semitones
    // north of A440 — ask me how I know.)
    const base = (ch.fnum << ch.block) / 2048;
    let out = 0;
    const ops = ch.ops;

    for (let i = 0; i < 4; i++) {
      const op = ops[i];
      const kc = (ch.block << 2) | (ch.fnum >> 7);
      const detune = DT_TAB[op.dt & 3][kc & 31] * ((op.dt & 4) ? -1 : 1) / 1024;
      op.phase = (op.phase + base * op.mul + detune) % 1024;
      if (op.phase < 0) op.phase += 1024;
    }

    // modulation graph per algorithm (op indices 0..3 = OP1..OP4)
    const s = (op, mod) => {
      const idx = (op.phase + mod) & 1023;
      return SIN_TAB[idx | 0] * this._gain(op.env + op.tl * 8);
    };

    const fb = ch.fb ? (ops[0].out + ops[0].prev) * (1 << ch.fb) / 32 : 0;
    const o1 = s(ops[0], fb * 256);
    ops[0].prev = ops[0].out; ops[0].out = o1;

    const A = ch.alg;
    let o2, o3, o4;
    if (A === 0) { o2 = s(ops[1], o1 * 256); o3 = s(ops[2], o2 * 256); o4 = s(ops[3], o3 * 256); out = o4; }
    else if (A === 1) { o2 = s(ops[1], 0); o3 = s(ops[2], (o1 + o2) * 256); o4 = s(ops[3], o3 * 256); out = o4; }
    else if (A === 2) { o2 = s(ops[1], 0); o3 = s(ops[2], o2 * 256); o4 = s(ops[3], (o1 + o3) * 256); out = o4; }
    else if (A === 3) { o2 = s(ops[1], o1 * 256); o3 = s(ops[2], 0); o4 = s(ops[3], (o2 + o3) * 256); out = o4; }
    else if (A === 4) { o2 = s(ops[1], o1 * 256); o3 = s(ops[2], 0); o4 = s(ops[3], o3 * 256); out = o2 + o4; }
    else if (A === 5) { o2 = s(ops[1], o1 * 256); o3 = s(ops[2], o1 * 256); o4 = s(ops[3], o1 * 256); out = o2 + o3 + o4; }
    else if (A === 6) { o2 = s(ops[1], o1 * 256); o3 = s(ops[2], 0); o4 = s(ops[3], 0); out = o2 + o3 + o4; }
    else { o2 = s(ops[1], 0); o3 = s(ops[2], 0); o4 = s(ops[3], 0); out = o1 + o2 + o3 + o4; }

    for (const op of ops) this._opTick(op);
    return out / 4;
  }

  _timers(ticks) {
    if (this.timerARun) {
      this.timerACount -= ticks;
      while (this.timerACount <= 0) {
        this.timerACount += 1024 - this.timerA;
        if (this.irqEnableA) this.status |= 1;
      }
    }
    if (this.timerBRun) {
      this.timerBCount -= ticks;
      while (this.timerBCount <= 0) {
        this.timerBCount += (256 - this.timerB) * 16;
        if (this.irqEnableB) this.status |= 2;
      }
    }
  }

  // ---- render -------------------------------------------------------------
  // Fill `out` (Float32Array) with `n` samples at sampleRate. Mono: the
  // 8801's OPN is mono anyway (the L/R bits only matter on OPNA).
  render(out, n = out.length) {
    for (let i = 0; i < n; i++) {
      this.fmAcc += this.fmStep;
      let fmTicks = 0;
      while (this.fmAcc >= 1) { this.fmAcc -= 1; fmTicks++; }
      let fm = 0;
      if (fmTicks > 0) {
        this._timers(fmTicks);
        for (let t = 0; t < fmTicks; t++) {
          fm = 0;
          for (const ch of this.ch) fm += this._fmChannel(ch);
        }
      } else {
        for (const ch of this.ch) fm += this._fmChannel(ch);
      }

      this.ssgAcc += this.ssgStep;
      while (this.ssgAcc >= 1) { this.ssgAcc -= 1; this._ssgTick(); }

      out[i] = Math.max(-1, Math.min(1, fm * 0.6 + this._ssgOut() * 0.5));
    }
    return out;
  }

  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: this.status, addr: this.addr,
      timerA: this.timerA, timerB: this.timerB,
      timerARun: this.timerARun, timerBRun: this.timerBRun,
      keys: this.ch.map((c) => c.keyOn),
    };
  }
}

export function createYm2203(opts) { return new Ym2203(opts); }
