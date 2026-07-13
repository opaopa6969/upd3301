// tube — the glass: spatial physics of a color CRT.
//
// Sits after the phosphor layer (crt.js). The phosphor gives per-dot
// luminance on a perfect grid; the tube makes it look like television:
//
// - Beam spot: the electron beam is a Gaussian blob wider than one triad.
//   The spot straddles neighboring mask openings, so edges bleed color —
//   this IS the "nijimi". FOCUS is continuous (0 sharp … 2 defocused).
// - Oblique landing: the beam leaves one gun and is deflected; at the
//   center it lands perpendicular, at the edges it lands at an angle, so
//   the spot stretches and grows — focus degrades with r² (edgeDefocus).
//   And the three guns sit apart, so their deflection errors differ:
//   convergence error shifts R and B in opposite directions, growing
//   toward the edges — the classic color fringing on corners.
// - Shadow mask / aperture grille: 'aperture' (Trinitron vertical stripes),
//   'shadow' (delta dot triads), 'slot' (in-line slots), 'none'. Modeled as
//   a per-output-pixel per-channel transmission pattern with a gain that
//   keeps average brightness roughly constant.
// - Glass: barrel distortion (curved faceplate + deflection), a faint ghost
//   from the inner-surface reflection, corner vignette.
// - The knobs on the back: FOCUS (beamWidth), H-SIZE / V-SIZE (scan
//   amplitude — shrink it and the border goes dark), via setGeometry().
// - Interlace lives in the phosphor layer; the tube is field-agnostic.
//
// Pure and deterministic: geometry/mask work is precomputed into LUTs
// (per gun, because of convergence); apply() is a gather loop. No
// Math.random, no DOM.

import { tintMatrix } from './crt.js';

export const SCHEMA_VERSION = 2;

export const MASKS = Object.freeze(['none', 'aperture', 'shadow', 'slot']);

export class CrtTube {
  constructor({
    srcWidth, srcHeight,
    outWidth = srcWidth, outHeight = srcHeight * 2,
    mask = 'aperture',
    maskPitch = 3, // output pixels per triad period
    maskLeak = 0.12, // how much of a gun leaks through neighboring openings
    beamWidth = 1.0, // FOCUS knob: 0 = sharp, 1 = nominal, 2 = defocused
    barrel = 0.06, // barrel distortion strength
    ghost = 0.07, // inner-glass reflection strength (0 disables)
    ghostShift = 0.012, // reflection offset toward the center, normalized
    vignette = 0.18,
    hSize = 1.0, // H-SIZE knob: horizontal scan width (1 = fills the glass)
    vSize = 1.0, // V-SIZE knob: vertical scan height
    edgeDefocus = 0.35, // how much focus degrades per r² (oblique landing)
    convergence = 0.0035, // R/B gun mis-registration per r² (color fringes)
  } = {}) {
    this.srcWidth = srcWidth;
    this.srcHeight = srcHeight;
    this.outWidth = outWidth;
    this.outHeight = outHeight;
    this.beamWidth = beamWidth;
    this.ghost = ghost;
    this.edgeDefocus = edgeDefocus;
    this.geometry = {
      mask, maskPitch, maskLeak, barrel, ghostShift, vignette,
      hSize, vSize, convergence,
    };

    const n = outWidth * outHeight;
    // per-gun geometry LUTs (convergence error differs per gun)
    this.lutIdx = [new Int32Array(n), new Int32Array(n), new Int32Array(n)];
    this.lutFx = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    this.lutFy = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    this.lutGhostIdx = new Int32Array(n);
    this.lutVig = new Float32Array(n);
    this.lutR2 = new Float32Array(n); // radius² per output pixel (for focus falloff)
    this.maskR = new Float32Array(n);
    this.maskG = new Float32Array(n);
    this.maskB = new Float32Array(n);

    const m = srcWidth * srcHeight;
    this._blur1 = [new Float32Array(m), new Float32Array(m), new Float32Array(m)];
    this._blur2 = [new Float32Array(m), new Float32Array(m), new Float32Array(m)];
    this._tmp = new Float32Array(m);
    this.rebuild();
  }

  // Recompute the geometry + mask LUTs (call after twisting a knob that
  // changes them: setGeometry). Deterministic — same params, same LUTs.
  rebuild() {
    const { srcWidth, srcHeight, outWidth, outHeight } = this;
    const {
      mask, maskPitch, maskLeak, barrel, ghostShift, vignette,
      hSize, vSize, convergence,
    } = this.geometry;
    const gain = mask === 'none' ? 1 : Math.min(2.2, 3 / (1 + 2 * maskLeak));
    // convergence error per gun: R and B deflect to opposite sides of G
    const conv = [convergence, 0, -convergence];
    for (let y = 0; y < outHeight; y++) {
      for (let x = 0; x < outWidth; x++) {
        const i = y * outWidth + x;
        const u = (x + 0.5) / outWidth * 2 - 1;
        const v = (y + 0.5) / outHeight * 2 - 1;
        const r2 = u * u + v * v;
        this.lutR2[i] = r2;
        // barrel: screen coords bulge outward → sample pulls inward at
        // edges. H/V-SIZE scale the deflection amplitude: smaller size →
        // the raster shrinks on the glass and the border goes dark.
        const bu = u * (1 + barrel * r2) / hSize;
        const bv = v * (1 + barrel * r2) / vSize;
        let inside = false;
        for (let gun = 0; gun < 3; gun++) {
          const su = bu * (1 + conv[gun] * r2);
          const sv = bv;
          if (Math.abs(su) > 1 || Math.abs(sv) > 1) {
            this.lutIdx[gun][i] = -1;
            continue;
          }
          inside = true;
          const sx = (su + 1) / 2 * srcWidth - 0.5;
          const sy = (sv + 1) / 2 * srcHeight - 0.5;
          const x0 = Math.max(0, Math.min(srcWidth - 2, Math.floor(sx)));
          const y0 = Math.max(0, Math.min(srcHeight - 2, Math.floor(sy)));
          this.lutIdx[gun][i] = y0 * srcWidth + x0;
          this.lutFx[gun][i] = Math.min(1, Math.max(0, sx - x0));
          this.lutFy[gun][i] = Math.min(1, Math.max(0, sy - y0));
        }
        // ghost: inner reflection displaced toward center (green geometry)
        if (inside) {
          const gu = Math.max(-1, Math.min(1, bu * (1 - ghostShift * 2)));
          const gv = Math.max(-1, Math.min(1, bv * (1 - ghostShift * 2)));
          const gx = Math.round((gu + 1) / 2 * srcWidth - 0.5);
          const gy = Math.round((gv + 1) / 2 * srcHeight - 0.5);
          this.lutGhostIdx[i] = Math.max(0, Math.min(srcHeight - 1, gy)) * srcWidth
            + Math.max(0, Math.min(srcWidth - 1, gx));
        } else {
          this.lutGhostIdx[i] = 0;
        }
        this.lutVig[i] = Math.max(0, 1 - vignette * r2 * r2);

        // mask pattern — area-sampled, not point-sampled: one output pixel
        // spans [a, b) in stripe units (period 3, one unit per gun), and
        // each gun's transmission comes from how much of the pixel lies on
        // its stripe. Point sampling skips whole stripes when pitch < 3
        // (a 2px pitch never lands on phase 2 → blue dies → yellow cast).
        let mr = 1, mg = 1, mb = 1;
        if (mask === 'aperture' || mask === 'slot' || mask === 'shadow') {
          const stagger = mask === 'shadow'
            ? (Math.floor(y / maskPitch) % 2) * (maskPitch / 2) : 0;
          const a = (x + stagger) * 3 / maskPitch;
          const b = (x + stagger + 1) * 3 / maskPitch;
          const cov = [0, 0, 0];
          for (let k = Math.floor(a / 3) - 1; k * 3 < b; k++) {
            for (let c = 0; c < 3; c++) {
              const lo = Math.max(a, k * 3 + c), hi = Math.min(b, k * 3 + c + 1);
              if (hi > lo) cov[c] += hi - lo;
            }
          }
          const len = b - a;
          mr = maskLeak + (1 - maskLeak) * cov[0] / len;
          mg = maskLeak + (1 - maskLeak) * cov[1] / len;
          mb = maskLeak + (1 - maskLeak) * cov[2] / len;
          if (mask === 'slot' || mask === 'shadow') {
            // dark horizontal gaps between slots/dots, staggered by column
            const colStagger = (Math.floor(x / maskPitch) % 2) * ((maskPitch * 2) >> 1);
            if ((y + colStagger) % (maskPitch * 2) === 0) { mr *= 0.35; mg *= 0.35; mb *= 0.35; }
          }
        }
        this.maskR[i] = mr * gain;
        this.maskG[i] = mg * gain;
        this.maskB[i] = mb * gain;
      }
    }
    return this;
  }

  // Twist a knob: merge partial geometry (hSize, vSize, barrel, convergence,
  // ...) and rebuild the LUTs.
  setGeometry(partial) {
    Object.assign(this.geometry, partial);
    return this.rebuild();
  }

  // one separable Gaussian pass: 5-tap horizontal, 3-tap vertical
  _blurPass(src, dst) {
    const w = this.srcWidth, h = this.srcHeight;
    const t = this._tmp;
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const xm2 = Math.max(0, x - 2), xm1 = Math.max(0, x - 1);
        const xp1 = Math.min(w - 1, x + 1), xp2 = Math.min(w - 1, x + 2);
        t[o + x] = (src[o + xm2] + 4 * src[o + xm1] + 6 * src[o + x]
          + 4 * src[o + xp1] + src[o + xp2]) / 16;
      }
    }
    for (let y = 0; y < h; y++) {
      const ym = Math.max(0, y - 1) * w, yp = Math.min(h - 1, y + 1) * w, o = y * w;
      for (let x = 0; x < w; x++) {
        dst[o + x] = (t[ym + x] + 2 * t[o + x] + t[yp + x]) / 4;
      }
    }
  }

  // lum: [R, G, B] Float32Arrays of srcWidth*srcHeight (phosphor output).
  // Returns RGBA Uint8ClampedArray of outWidth*outHeight.
  // tint: NTSC chroma phase error in radians (see crt.js tintMatrix);
  // contrast: gain around mid after gamma encoding (the front-panel knob).
  apply(lum, out, { gamma = 2.2, scale = 1, tint = 0, contrast = 1 } = {}) {
    const n = this.outWidth * this.outHeight;
    const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
    for (let ch = 0; ch < 3; ch++) {
      this._blurPass(lum[ch], this._blur1[ch]);
      this._blurPass(this._blur1[ch], this._blur2[ch]);
    }
    const masks = [this.maskR, this.maskG, this.maskB];
    const w = this.srcWidth;
    const inv = 1 / gamma;
    const ghost = this.ghost;
    const beam = this.beamWidth, edge = this.edgeDefocus;
    const M = tint !== 0 ? tintMatrix(tint) : null;
    const vals = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      // per-pixel focus: nominal beam width plus oblique-landing falloff
      const f = Math.max(0, Math.min(2, beam + edge * this.lutR2[i]));
      const vig = this.lutVig[i];
      const gi = this.lutGhostIdx[i];
      for (let ch = 0; ch < 3; ch++) {
        const idx = this.lutIdx[ch][i];
        if (idx < 0) { vals[ch] = 0; continue; }
        const fx = this.lutFx[ch][i], fy = this.lutFy[ch][i];
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy, w11 = fx * fy;
        const S = lum[ch], B1 = this._blur1[ch], B2 = this._blur2[ch];
        let val;
        if (f <= 0) {
          val = S[idx] * w00 + S[idx + 1] * w10 + S[idx + w] * w01 + S[idx + w + 1] * w11;
        } else if (f <= 1) {
          const s = S[idx] * w00 + S[idx + 1] * w10 + S[idx + w] * w01 + S[idx + w + 1] * w11;
          const b = B1[idx] * w00 + B1[idx + 1] * w10 + B1[idx + w] * w01 + B1[idx + w + 1] * w11;
          val = s + (b - s) * f;
        } else {
          const b = B1[idx] * w00 + B1[idx + 1] * w10 + B1[idx + w] * w01 + B1[idx + w + 1] * w11;
          const b2 = B2[idx] * w00 + B2[idx + 1] * w10 + B2[idx + w] * w01 + B2[idx + w + 1] * w11;
          val = b + (b2 - b) * (f - 1);
        }
        if (ghost > 0) val += B1[gi] * ghost;
        vals[ch] = val * masks[ch][i] * vig * scale;
      }
      let r = vals[0], g = vals[1], b = vals[2];
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
}

export function createCrtTube(opts) {
  return new CrtTube(opts);
}
