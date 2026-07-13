// tube — the glass: spatial physics of a color CRT.
//
// Sits after the phosphor layer (crt.js). The phosphor gives per-dot
// luminance on a perfect grid; the tube makes it look like television:
//
// - Beam spot: the electron beam is a Gaussian blob wider than one triad.
//   Modeled as a separable pre-blur of the source. This IS the "nijimi" —
//   the spot straddles neighboring mask openings, so edges bleed color.
// - Shadow mask / aperture grille: the mask only lets each gun reach its
//   own phosphor stripes/dots. Types: 'aperture' (Trinitron vertical
//   stripes), 'shadow' (delta dot triads), 'slot' (in-line slot mask),
//   'none'. Modeled as a per-output-pixel per-channel transmission pattern
//   with a gain that keeps average brightness roughly constant.
// - Glass: barrel distortion (curved faceplate + deflection), plus a faint
//   ghost image from the inner-surface reflection (light bounces between
//   phosphor and the front glass), plus corner vignette.
// - Interlace lives in the phosphor layer (which lines get excited per
//   field); the tube is field-agnostic.
//
// Pure and deterministic: all geometry/mask work is precomputed into LUTs
// in the constructor; apply() is a gather loop. No Math.random, no DOM.

export const SCHEMA_VERSION = 1;

export const MASKS = Object.freeze(['none', 'aperture', 'shadow', 'slot']);

export class CrtTube {
  constructor({
    srcWidth, srcHeight,
    outWidth = srcWidth, outHeight = srcHeight * 2,
    mask = 'aperture',
    maskPitch = 3, // output pixels per triad period
    maskLeak = 0.12, // how much of a gun leaks through neighboring openings
    beamWidth = 1.0, // FOCUS knob: beam spot size, 0 = sharp, >1 = defocused
    barrel = 0.06, // barrel distortion strength
    ghost = 0.07, // inner-glass reflection strength (0 disables)
    ghostShift = 0.012, // reflection offset toward the center, normalized
    vignette = 0.18,
    hSize = 1.0, // H-SIZE knob: horizontal scan width (1 = fills the glass)
    vSize = 1.0, // V-SIZE knob: vertical scan height
  } = {}) {
    this.srcWidth = srcWidth;
    this.srcHeight = srcHeight;
    this.outWidth = outWidth;
    this.outHeight = outHeight;
    this.beamWidth = beamWidth;
    this.ghost = ghost;
    this.geometry = { mask, maskPitch, maskLeak, barrel, ghostShift, vignette, hSize, vSize };

    const n = outWidth * outHeight;
    // geometry LUT: source sample position (fixed-point bilinear)
    this.lutIdx = new Int32Array(n); // top-left source index, -1 = outside
    this.lutFx = new Float32Array(n); // x fraction
    this.lutFy = new Float32Array(n); // y fraction
    this.lutGhostIdx = new Int32Array(n);
    this.lutVig = new Float32Array(n);
    // mask transmission per channel
    this.maskR = new Float32Array(n);
    this.maskG = new Float32Array(n);
    this.maskB = new Float32Array(n);

    this._blurR = new Float32Array(srcWidth * srcHeight);
    this._blurG = new Float32Array(srcWidth * srcHeight);
    this._blurB = new Float32Array(srcWidth * srcHeight);
    this._tmp = new Float32Array(srcWidth * srcHeight);
    this._tmp2 = new Float32Array(srcWidth * srcHeight);
    this.rebuild();
  }

  // Recompute the geometry + mask LUTs (call after twisting a knob that
  // changes them: setGeometry). Deterministic — same params, same LUTs.
  rebuild() {
    const { srcWidth, srcHeight, outWidth, outHeight } = this;
    const { mask, maskPitch, maskLeak, barrel, ghostShift, vignette, hSize, vSize } = this.geometry;
    const gain = mask === 'none' ? 1 : Math.min(2.2, 3 / (1 + 2 * maskLeak));
    for (let y = 0; y < outHeight; y++) {
      for (let x = 0; x < outWidth; x++) {
        const i = y * outWidth + x;
        // normalized [-1, 1]
        const u = (x + 0.5) / outWidth * 2 - 1;
        const v = (y + 0.5) / outHeight * 2 - 1;
        const r2 = u * u + v * v;
        // barrel: screen coords bulge outward → sample pulls inward at edges.
        // H/V-SIZE scale the deflection: smaller size → the raster shrinks
        // on the glass and the border goes dark, just like the real knob.
        const su = u * (1 + barrel * r2) / hSize;
        const sv = v * (1 + barrel * r2) / vSize;
        if (Math.abs(su) > 1 || Math.abs(sv) > 1) {
          this.lutIdx[i] = -1;
          continue;
        }
        const sx = (su + 1) / 2 * srcWidth - 0.5;
        const sy = (sv + 1) / 2 * srcHeight - 0.5;
        const x0 = Math.max(0, Math.min(srcWidth - 2, Math.floor(sx)));
        const y0 = Math.max(0, Math.min(srcHeight - 2, Math.floor(sy)));
        this.lutIdx[i] = y0 * srcWidth + x0;
        this.lutFx[i] = Math.min(1, Math.max(0, sx - x0));
        this.lutFy[i] = Math.min(1, Math.max(0, sy - y0));
        // ghost: inner reflection displaced toward center
        const gu = su * (1 - ghostShift * 2), gv = sv * (1 - ghostShift * 2);
        const gx = Math.round((gu + 1) / 2 * srcWidth - 0.5);
        const gy = Math.round((gv + 1) / 2 * srcHeight - 0.5);
        this.lutGhostIdx[i] = Math.max(0, Math.min(srcHeight - 1, gy)) * srcWidth
          + Math.max(0, Math.min(srcWidth - 1, gx));
        this.lutVig[i] = Math.max(0, 1 - vignette * r2 * r2);

        // mask pattern
        let mr = 1, mg = 1, mb = 1;
        if (mask === 'aperture' || mask === 'slot' || mask === 'shadow') {
          let phase;
          if (mask === 'shadow') {
            // delta triads: odd triad rows offset by half a period
            const rowBand = Math.floor(y / maskPitch);
            phase = Math.floor((x + (rowBand % 2) * (maskPitch / 2)) / (maskPitch / 3)) % 3;
          } else {
            phase = Math.floor(x / (maskPitch / 3)) % 3;
          }
          mr = phase === 0 ? 1 : maskLeak;
          mg = phase === 1 ? 1 : maskLeak;
          mb = phase === 2 ? 1 : maskLeak;
          if (mask === 'slot' || mask === 'shadow') {
            // dark horizontal gaps between slots/dots, staggered by column
            const stagger = (Math.floor(x / maskPitch) % 2) * ((maskPitch * 2) >> 1);
            if ((y + stagger) % (maskPitch * 2) === 0) { mr *= 0.35; mg *= 0.35; mb *= 0.35; }
          }
        }
        this.maskR[i] = mr * gain;
        this.maskG[i] = mg * gain;
        this.maskB[i] = mb * gain;
      }
    }
    return this;
  }

  // Twist a knob: merge partial geometry (hSize, vSize, barrel, ...) and
  // rebuild the LUTs.
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

  // FOCUS: beamWidth is continuous. 0 = perfectly sharp, 1 = one Gaussian
  // pass, 2 = two passes; fractions blend between the neighboring integers.
  _blurChannel(src, dst) {
    const f = Math.max(0, Math.min(2, this.beamWidth));
    if (f === 0) { dst.set(src); return; }
    const n = src.length;
    this._blurPass(src, dst);
    if (f <= 1) {
      if (f < 1) for (let i = 0; i < n; i++) dst[i] = src[i] + (dst[i] - src[i]) * f;
      return;
    }
    const t2 = this._tmp2;
    t2.set(dst);
    this._blurPass(t2, dst);
    const g = f - 1;
    if (g < 1) for (let i = 0; i < n; i++) dst[i] = t2[i] + (dst[i] - t2[i]) * g;
  }

  // lum: [R, G, B] Float32Arrays of srcWidth*srcHeight (phosphor output).
  // Returns RGBA Uint8ClampedArray of outWidth*outHeight.
  apply(lum, out, { gamma = 2.2, scale = 1 } = {}) {
    const n = this.outWidth * this.outHeight;
    const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
    this._blurChannel(lum[0], this._blurR);
    this._blurChannel(lum[1], this._blurG);
    this._blurChannel(lum[2], this._blurB);
    const chans = [this._blurR, this._blurG, this._blurB];
    const masks = [this.maskR, this.maskG, this.maskB];
    const w = this.srcWidth;
    const inv = 1 / gamma;
    const ghost = this.ghost;
    for (let i = 0; i < n; i++) {
      const idx = this.lutIdx[i];
      if (idx < 0) {
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 0; rgba[i * 4 + 3] = 255;
        continue;
      }
      const fx = this.lutFx[i], fy = this.lutFy[i];
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy, w11 = fx * fy;
      const gi = this.lutGhostIdx[i];
      const vig = this.lutVig[i];
      for (let ch = 0; ch < 3; ch++) {
        const L = chans[ch];
        let val = L[idx] * w00 + L[idx + 1] * w10 + L[idx + w] * w01 + L[idx + w + 1] * w11;
        if (ghost > 0) val += L[gi] * ghost;
        val *= masks[ch][i] * vig * scale;
        rgba[i * 4 + ch] = 255 * Math.min(1, val) ** inv;
      }
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }
}

export function createCrtTube(opts) {
  return new CrtTube(opts);
}
