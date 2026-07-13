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

  toRGBA(out, { gamma = 2.2, scale = 1, tint = 0, contrast = 1 } = {}) {
    const n = this.width * this.height;
    const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
    const [R, G, B] = this.composite();
    const inv = 1 / gamma;
    const M = tint !== 0 ? tintMatrix(tint) : null;
    for (let i = 0; i < n; i++) {
      let r = R[i] * scale, g = G[i] * scale, b = B[i] * scale;
      if (M) {
        const r2 = M[0] * r + M[1] * g + M[2] * b;
        const g2 = M[3] * r + M[4] * g + M[5] * b;
        const b2 = M[6] * r + M[7] * g + M[8] * b;
        r = Math.max(0, r2); g = Math.max(0, g2); b = Math.max(0, b2);
      }
      r = Math.min(1, r) ** inv; g = Math.min(1, g) ** inv; b = Math.min(1, b) ** inv;
      if (contrast !== 1) {
        r = (r - 0.5) * contrast + 0.5;
        g = (g - 0.5) * contrast + 0.5;
        b = (b - 0.5) * contrast + 0.5;
      }
      rgba[i * 4] = 255 * r;
      rgba[i * 4 + 1] = 255 * g;
      rgba[i * 4 + 2] = 255 * b;
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

// Power-off: the deflection amplitude collapses, so the whole raster lands
// on a shrinking band — vertical dies first (bright horizontal line), then
// horizontal (a dot), while the beam energy concentrates: same electrons,
// less phosphor area. Model: remap every lit source pixel toward the
// center by (hScale, vScale), OR-ing gun bits where they pile up; the
// caller raises `drive` by the density factor 1/(hScale·vScale) so the
// piled-up phosphor is excited past 1.0 and its afterglow lingers.
export function collapseScan(src, dst, width, height, hScale, vScale) {
  dst.fill(0);
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    const ty = Math.round(cy + (y - cy) * vScale);
    const rowOff = ty * width;
    const o = y * width;
    for (let x = 0; x < width; x++) {
      const v = src[o + x];
      if (!v) continue;
      const tx = Math.round(cx + (x - cx) * hScale);
      dst[rowOff + tx] |= v;
    }
  }
  return dst;
}

// Analog drive: RGBA frames (a video, a framebuffer) excite the guns with
// continuous levels instead of GRB bits. Input is sRGB-encoded; a LUT
// linearizes (gamma 2.2) so the phosphor integrates light, not code values.
const DEGAMMA = new Float32Array(256);
for (let i = 0; i < 256; i++) DEGAMMA[i] = (i / 255) ** 2.2;

CrtPhosphor.prototype.stepAnalog = function stepAnalog(rgba, dt, { fieldParity = null } = {}) {
  const w = this.width, h = this.height;
  for (let gun = 0; gun < 3; gun++) {
    const F = this.fast[gun], T = this.tail[gun];
    const D = this.dose ? this.dose[gun] : null;
    const dFast = Math.exp(-dt / this.tau[gun]);
    const dTail = Math.exp(-dt / this.tailTau[gun]);
    const frac = this.tailFrac[gun];
    for (let y = 0; y < h; y++) {
      const excitable = fieldParity === null || (y & 1) === fieldParity;
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const i = o + x;
        let f = F[i] * dFast;
        let t = T[i] * dTail;
        if (excitable) {
          let e = DEGAMMA[rgba[i * 4 + gun]] * this.drive;
          if (D && e > 0) {
            e /= 1 + this.burnRate * D[i];
            D[i] += dt * e;
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
};

// NTSC tint: a chroma phase error rotates every hue at once — the reason
// American TVs shipped with a TINT knob. RGB → YIQ, rotate (I,Q) by rad,
// back to RGB, precombined into one 3x3 matrix (row-major, length 9).
export function tintMatrix(rad) {
  const A = [ // RGB → YIQ
    [0.299, 0.587, 0.114],
    [0.596, -0.274, -0.322],
    [0.211, -0.523, 0.312],
  ];
  // YIQ → RGB: exact numeric inverse of A, so tint 0 is exactly identity
  const inv3 = (m) => {
    const [a, b, c0, d, e, f, g, h, i] = m.flat();
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c0 * (d * h - e * g);
    return [
      [(e * i - f * h) / det, (c0 * h - b * i) / det, (b * f - c0 * e) / det],
      [(f * g - d * i) / det, (a * i - c0 * g) / det, (c0 * d - a * f) / det],
      [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ];
  };
  const B = inv3(A);
  const c = Math.cos(rad), s = Math.sin(rad);
  const R = [[1, 0, 0], [0, c, -s], [0, s, c]];
  const mul = (X, Y) => X.map((row, i) => Y[0].map((_, j) =>
    row.reduce((acc, v, k) => acc + v * Y[k][j], 0)));
  return mul(B, mul(R, A)).flat();
}
