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

export const MASKS = Object.freeze(['none', 'aperture', 'shadow', 'slot', 'plasma']);

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
    // The beam draws discrete lines with a Gaussian vertical profile; between
    // them sits unlit glass. scanlineDepth is how much of that gap goes black
    // (1 = nothing between the lines but darkness — the real 200-line look);
    // beamHeight is the line's thickness as a fraction of the line pitch
    // (~0.45 on a 200-line CRT: the gap is as wide as the line. 400-line
    // packs the lines until the gaps close → beamHeight ~1).
    // Gamma encoding lifts dim values hard (linear 0.05 → displayed 0.25), so
    // "a bit dark between the lines" reads as grey. A real 200-line CRT is
    // near-black between traces: full depth, and a beam thinner than half the
    // pitch so its tail doesn't reach the next row.
    scanlineDepth = 1.0,
    beamHeight = 0.35,
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
      hSize, vSize, convergence, scanlineDepth, beamHeight,
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
      hSize, vSize, convergence, scanlineDepth, beamHeight,
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
        let vigv = Math.max(0, 1 - vignette * r2 * r2);
        // Scanline structure. Each source line is a beam trace with a
        // Gaussian vertical profile of width `beamHeight` (in line pitches);
        // the space between traces is unlit glass. A 200-line CRT drawn on a
        // 400-row raster therefore alternates lit / black, and that black is
        // *black*, not "slightly dimmer" — which is what the old cosine
        // shading got wrong.
        if (scanlineDepth > 0 && Math.abs(bv) <= 1) {
          // Work inside one source line's band (one line pitch). The trace's
          // phase is a free parameter on real glass; we land it on the first
          // output row of the band so a 2x raster can actually *show* the
          // gap — otherwise both samples straddle the trace symmetrically
          // and you get two half-lit rows instead of line + black.
          // Phase off the RAW output row v, NOT the barrel-warped bv: the raster
          // is a straight physical sweep, so scanlines must stay horizontal and
          // evenly spaced. Deriving the phase from bv let the barrel locally
          // stretch the line grid, and where that beat against the beam period a
          // bright horizontal band appeared (worse under supersampling, and
          // x-dependent via r2 → it showed up off to one side).
          const rowsPerLine = outHeight / srcHeight;
          const sy = (v + 1) / 2 * srcHeight;
          const u = sy - Math.floor(sy); // 0..1 within the band
          const c = 0.5 / rowsPerLine; // trace center on the first row
          const d = Math.min(Math.abs(u - c), Math.abs(u - c - 1), Math.abs(u - c + 1));
          const sigma = Math.max(0.04, beamHeight * 0.5);
          const beam = Math.exp(-(d * d) / (2 * sigma * sigma));
          vigv *= (1 - scanlineDepth) + scanlineDepth * beam;
        }
        this.lutVig[i] = vigv;

        // mask pattern
        let mr = 1, mg = 1, mb = 1, g2 = gain;
        if (mask === 'aperture' || mask === 'slot') {
          // stripes, area-sampled: one output pixel spans [a, b) in stripe
          // units (period 3, one unit per gun); point sampling would skip
          // whole stripes when pitch < 3 (blue dies → yellow cast).
          const a = x * 3 / maskPitch;
          const b = (x + 1) * 3 / maskPitch;
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
          if (mask === 'slot') {
            // dark horizontal gaps between slots, staggered by column
            const colStagger = (Math.floor(x / maskPitch) % 2) * ((maskPitch * 2) >> 1);
            if ((y + colStagger) % (maskPitch * 2) === 0) { mr *= 0.35; mg *= 0.35; mb *= 0.35; }
          }
        } else if (mask === 'plasma') {
          // gas-plasma panel: square pixel cells with thin dark ribs between
          // them, identical for all channels (it's monochrome light)
          const cell = Math.max(2, maskPitch);
          const fx2 = ((x % cell) + cell) % cell, fy2 = ((y % cell) + cell) % cell;
          const rib = (fx2 < 1 || fy2 < 1) ? 0.25 : 1;
          mr = mg = mb = rib;
          const fill = ((cell - 1) / cell) ** 2;
          g2 = Math.min(1.8, 1 / (fill + 0.25 * (1 - fill)));
        } else if (mask === 'shadow') {
          // the real shadow mask: round-dot triads in delta (∵) arrangement
          // on a hex lattice — per gun, transmission is a soft circular
          // aperture around the nearest dot center of that gun's sublattice
          const p = maskPitch * 2; // triad pitch in output pixels
          const hh = p * 0.866; // hex row height
          const r0 = p * 0.30, aa = 0.8; // dot radius, anti-alias width
          const D = [[0, -0.29 * p], [-0.25 * p, 0.145 * p], [0.25 * p, 0.145 * p]]; // R G B ∵
          const m = [0, 0, 0];
          for (let c = 0; c < 3; c++) {
            let best = 1e9;
            const ry = Math.round(y / hh);
            for (let dr = -1; dr <= 1; dr++) {
              const row = ry + dr;
              const cy2 = row * hh + D[c][1];
              const xoff = (row & 1) * (p / 2) + D[c][0];
              const rx = Math.round((x - xoff) / p);
              for (let dc = -1; dc <= 1; dc++) {
                const cx2 = (rx + dc) * p + xoff;
                const d2 = (x - cx2) * (x - cx2) + (y - cy2) * (y - cy2);
                if (d2 < best) best = d2;
              }
            }
            const cov = Math.min(1, Math.max(0, (r0 + aa / 2 - Math.sqrt(best)) / aa));
            m[c] = maskLeak + (1 - maskLeak) * cov;
          }
          [mr, mg, mb] = m;
          // brightness normalization: average circular coverage per gun
          const avgCov = Math.PI * r0 * r0 / (p * hh);
          g2 = Math.min(2.5, 1 / (maskLeak + (1 - maskLeak) * avgCov));
        }
        this.maskR[i] = mr * g2;
        this.maskG[i] = mg * g2;
        this.maskB[i] = mb * g2;
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
    // second blur stage is only reachable when per-pixel focus can exceed 1
    const needB2 = Math.min(2, this.beamWidth + this.edgeDefocus * 2) > 1;
    for (let ch = 0; ch < 3; ch++) {
      this._blurPass(lum[ch], this._blur1[ch]);
      if (needB2) this._blurPass(this._blur1[ch], this._blur2[ch]);
    }
    const masks = [this.maskR, this.maskG, this.maskB];
    const w = this.srcWidth;
    let lut = null;
    if (gamma !== 1) { // pow per subpixel is the hot spot; 4096-entry LUT
      if (!this._glut || this._glutGamma !== gamma) {
        const inv = 1 / gamma;
        this._glut = new Float32Array(4096);
        for (let i = 0; i < 4096; i++) this._glut[i] = (i / 4095) ** inv;
        this._glutGamma = gamma;
      }
      lut = this._glut;
    }
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
      r = Math.min(1, r); g = Math.min(1, g); b = Math.min(1, b);
      if (lut) {
        r = lut[(r * 4095) | 0]; g = lut[(g * 4095) | 0]; b = lut[(b * 4095) | 0];
      }
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
