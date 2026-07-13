// crt — the physical layer, part 1: phosphor physics.
//
// Everything below the μPD3301 is digital and frame-atomic; this module is
// where photons happen. A phosphor is characterized here by:
//
// - Two-component decay per gun. Real phosphor decay is roughly hyperbolic;
//   we approximate it with a fast "flash" component and a slow "afterglow"
//   tail, each exponential:
//     fast(t+dt) = max(fast · e^(-dt/tauFast), drive)
//     tail(t+dt) = max(tail · e^(-dt/tauTail), drive · tailFrac)
//   The max() models re-excitation; an undriven dot just decays.
// - Differential persistence: each gun (R,G,B) has its own constants. On a
//   real P22 tube blue dies first and red lingers, so a white flash decays
//   through an orange ghost. That falls out of the numbers here.
// - Emission color: guns don't emit ideal R/G/B. `primaries[gun] = [r,g,b]`
//   is the linear light each gun's phosphor actually radiates; a mono tube
//   (P39 green) is just three guns all mapped to green. The tail may have
//   its own color (`tailPrimaries`) — that's the P7 radar phosphor: a
//   blue-white flash whose afterglow is yellow-green.
// - Burn-in: excitation accumulates dose; efficiency = 1/(1 + burnRate·dose).
//   Leave a screen up long enough and its ghost stays. Off by default.
//
// Constants are order-of-magnitude honest, tuned so the character of each
// phosphor is visible at 60 Hz frame granularity — not colorimetry.
//
// Pure, zero deps, deterministic. Suite-contract compliant.

export const SCHEMA_VERSION = 2;

const ID3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export const PHOSPHORS = Object.freeze({
  P22: {
    name: 'P22 (color TV, short)',
    tau: [0.0015, 0.0008, 0.0004],
    tailTau: [0.15, 0.08, 0.05],
    tailFrac: [0.045, 0.02, 0.012],
    primaries: [[1, 0.22, 0.12], [0.2, 1, 0.16], [0.14, 0.18, 1]],
  },
  LONG: {
    name: 'hypothetical long color',
    tau: [0.12, 0.12, 0.12],
    tailTau: [0.4, 0.4, 0.4],
    tailFrac: [0.05, 0.05, 0.05],
    primaries: [[1, 0.22, 0.12], [0.2, 1, 0.16], [0.14, 0.18, 1]],
  },
  P39: {
    name: 'P39 (long green mono)',
    tau: [0.2, 0.2, 0.2],
    tailTau: [0.55, 0.55, 0.55],
    tailFrac: [0.08, 0.08, 0.08],
    // every gun lands on the same green phosphor, weighted like luma
    primaries: [[0.09, 0.3, 0.05], [0.16, 0.55, 0.09], [0.04, 0.15, 0.02]],
  },
  P7: {
    name: 'P7 (radar: blue flash, yellow afterglow)',
    tau: [0.004, 0.004, 0.004],
    tailTau: [0.9, 0.9, 0.9],
    tailFrac: [0.16, 0.16, 0.16],
    primaries: [[0.35, 0.45, 1], [0.35, 0.45, 1], [0.35, 0.45, 1]].map(
      (p, i) => p.map((v) => v * [0.35, 0.5, 0.15][i])),
    tailPrimaries: [[0.75, 0.9, 0.15], [0.75, 0.9, 0.15], [0.75, 0.9, 0.15]].map(
      (p, i) => p.map((v) => v * [0.35, 0.5, 0.15][i])),
  },
});

// GRB index (0..7) → per-gun drive bit
export function indexToRgb(i) {
  return [(i >> 1) & 1, (i >> 2) & 1, i & 1];
}

export class CrtPhosphor {
  // Either pass `phosphor: PHOSPHORS.P22` (full character) or a bare
  // `tau: [r,g,b]` (single-exponential, identity emission — handy in tests).
  constructor({ width, height, phosphor = null, tau = null, drive = 1.0, burnRate = 0 } = {}) {
    this.width = width;
    this.height = height;
    this.drive = drive;
    this.burnRate = burnRate;
    const n = width * height;
    this.fast = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    this.tail = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    this.dose = burnRate > 0
      ? [new Float32Array(n), new Float32Array(n), new Float32Array(n)] : null;
    this._comp = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    this.setPhosphor(phosphor ?? (tau ? { tau } : PHOSPHORS.P22));
  }

  setPhosphor(spec) {
    this.spec = spec;
    this.tau = [...spec.tau];
    this.tailTau = spec.tailTau ? [...spec.tailTau] : [1, 1, 1];
    this.tailFrac = spec.tailFrac ? [...spec.tailFrac] : [0, 0, 0];
    this.primaries = spec.primaries ?? ID3;
    this.tailPrimaries = spec.tailPrimaries ?? this.primaries;
    return this;
  }

  setTau(tau) { this.tau = [...tau]; return this; }

  setBurnRate(rate) {
    if (rate > 0 && !this.dose) {
      const n = this.width * this.height;
      this.dose = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    }
    this.burnRate = rate;
    return this;
  }

  reset() {
    for (const c of this.fast) c.fill(0);
    for (const c of this.tail) c.fill(0);
    if (this.dose) for (const c of this.dose) c.fill(0);
  }

  // One beam pass: pixels is a GRB-indexed (0..7) Uint8Array of width*height,
  // dt the time since the previous pass (typically 1/60 s).
  // fieldParity: null = progressive; 0/1 = interlaced field — only lines of
  // that parity are excited, the rest just decay, so each line refreshes at
  // half rate and detail flickers on short phosphor.
  step(pixels, dt, { fieldParity = null } = {}) {
    const w = this.width, h = this.height;
    for (let gun = 0; gun < 3; gun++) {
      const F = this.fast[gun], T = this.tail[gun];
      const D = this.dose ? this.dose[gun] : null;
      const dFast = Math.exp(-dt / this.tau[gun]);
      const dTail = Math.exp(-dt / this.tailTau[gun]);
      const frac = this.tailFrac[gun];
      const shift = gun === 0 ? 1 : gun === 1 ? 2 : 0; // R=bit1, G=bit2, B=bit0
      for (let y = 0; y < h; y++) {
        const excitable = fieldParity === null || (y & 1) === fieldParity;
        const o = y * w;
        for (let x = 0; x < w; x++) {
          const i = o + x;
          let f = F[i] * dFast;
          let t = T[i] * dTail;
          if (excitable && ((pixels[i] >> shift) & 1)) {
            let e = this.drive;
            if (D) {
              e /= 1 + this.burnRate * D[i];
              D[i] += dt;
            }
            if (e > f) f = e;
            const et = e * frac;
            if (et > t) t = et;
          }
          F[i] = f;
          T[i] = t;
        }
      }
    }
    return this;
  }

  // Linear emitted light per display channel: for each gun, flash and
  // afterglow radiate through their own emission colors.
  composite() {
    const n = this.width * this.height;
    const [R, G, B] = this._comp;
    R.fill(0); G.fill(0); B.fill(0);
    for (let gun = 0; gun < 3; gun++) {
      const F = this.fast[gun], T = this.tail[gun];
      const [pr, pg, pb] = this.primaries[gun];
      const [tr, tg, tb] = this.tailPrimaries[gun];
      for (let i = 0; i < n; i++) {
        const f = F[i], t = T[i];
        R[i] += f * pr + t * tr;
        G[i] += f * pg + t * tg;
        B[i] += f * pb + t * tb;
      }
    }
    return this._comp;
  }

  toRGBA(out, { gamma = 2.2, scale = 1 } = {}) {
    const n = this.width * this.height;
    const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
    const [R, G, B] = this.composite();
    const inv = 1 / gamma;
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = 255 * Math.min(1, R[i] * scale) ** inv;
      rgba[i * 4 + 1] = 255 * Math.min(1, G[i] * scale) ** inv;
      rgba[i * 4 + 2] = 255 * Math.min(1, B[i] * scale) ** inv;
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }

  // Raw per-gun luminance (flash + afterglow) at one pixel — for tests.
  sample(x, y) {
    const i = y * this.width + x;
    return {
      r: this.fast[0][i] + this.tail[0][i],
      g: this.fast[1][i] + this.tail[1][i],
      b: this.fast[2][i] + this.tail[2][i],
    };
  }
}

export function createCrtPhosphor(opts) {
  return new CrtPhosphor(opts);
}
