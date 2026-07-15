// crt-panel — the CRT's control surface as a reusable component.
//
// Every page that puts something on a tube wants the same controls: which
// phosphor, which mask, the rear knobs, 200/400 lines, power. They were
// copy-pasted across five pages; this is that panel, once.
//
// The panel owns *display* state only — phosphor spec, tube geometry,
// knob values. It never touches the logical stack (no CRTC, no ROM). Pages
// give it a mount point and read `panel.phosphor`, `panel.tube(w, h)`,
// `panel.knobs` when they blit.
//
// Collapsible (the "hide" button) with the state remembered in
// localStorage, because a machine emulator does not want a wall of knobs
// in the way of the screen.

import { CrtPhosphor, PHOSPHORS, rollScan } from '../crt.js';
import { CrtTube } from '../tube.js';
import { t } from './i18n.js';

export const PHOSPHOR_LABELS = [
  ['P22', 'P22'], ['LONG', '長残光'], ['P39', 'P39緑'], ['P7', 'P7レーダー'],
  ['AMBER', 'アンバー'], ['PLASMA', 'プラズマ橙'],
];
export const TUBE_LABELS = [
  ['none', '物理OFF'], ['aperture', 'グリル'], ['shadow', 'シャドウ'],
  ['slot', 'スロット'], ['plasma', 'プラズマ格子'],
];

const KNOBS = [
  ['focus', 'FOCUS', 0, 2, 0.05, 0.8],
  ['hSize', 'H-SIZE', 0.7, 1.15, 0.01, 1],
  ['vSize', 'V-SIZE', 0.7, 1.15, 0.01, 1],
  ['bright', 'BRIGHT', 0.4, 3, 0.05, 1.2],
  ['pitch', 'PITCH', 2, 9, 1, 3],
  ['conv', 'CONV', 0, 0.02, 0.001, 0.004],
  ['barrel', 'BARREL', -0.12, 0.25, 0.01, 0.06],
  ['contrast', 'CONTRAST', 0.5, 1.8, 0.05, 1],
  ['vhold', 'V-HOLD', -20, 20, 0.5, 0],
];

export class CrtPanel {
  constructor(mount, { storageKey = 'crt-panel', collapsed = false, onChange = null } = {}) {
    this.storageKey = storageKey;
    this.onChange = onChange;
    this.phosName = 'P22';
    this.tubeMode = 'aperture';
    this.interlaced = false;
    this.line400 = false;
    this.knobs = Object.fromEntries(KNOBS.map(([k, , , , , d]) => [k, d]));
    this.knobs.tint = 0;
    this.knobs.tintOn = false;
    this.knobs.ghost = 0.07;
    this.power = { state: 'on', t: 0 };
    this._tubes = {};
    this._phosphor = null;
    this._w = 0;
    this._h = 0;
    this._rollPos = 0;
    this._rollBuf = null;
    this._restore();
    this._build(mount);
    this._collapse(collapsed || this._saved?.collapsed || false);
  }

  // ---- physical objects, sized to whatever the page is drawing ----------
  phosphor(w, h) {
    if (!this._phosphor || this._w !== w || this._h !== h) {
      this._w = w; this._h = h;
      this._phosphor = new CrtPhosphor({ width: w, height: h, phosphor: PHOSPHORS[this.phosName] });
      this._tubes = {};
      this._rollBuf = new Uint8Array(w * h);
    }
    return this._phosphor;
  }

  // ss = supersample factor. The mask/scanlines are drawn at ss× the native
  // 640×400 output, so a higher-scale display gets a proportionally FINER mask
  // pitch (a real high-dot-pitch monitor shows more, finer triads for the same
  // picture) with no moiré (the backing is 1:1 with the screen). Cached per
  // (mode, ss) so switching scale doesn't rebuild the geometry every frame.
  tube(w, h, ss = 1) {
    this.phosphor(w, h); // keeps sizes in sync
    const key = this.tubeMode + '@' + ss;
    if (!this._tubes[key]) {
      const k = this.knobs;
      this._tubes[key] = new CrtTube({
        srcWidth: w, srcHeight: h, outWidth: w * ss, outHeight: h * 2 * ss,
        // maskPitch is in OUTPUT pixels, NOT scaled by ss — so a 2× backing packs
        // 2× as many triads across the same picture = a genuinely FINER pitch
        // (a high-end Trinitron GDM ran ~0.24 mm ≈ ×2–×3 here), not just a smoother
        // render of the same coarse mask. Min ~3 px/triad to resolve R·G·B.
        mask: this.tubeMode, maskPitch: k.pitch, convergence: k.conv,
        barrel: k.barrel, ghost: k.ghost, beamWidth: k.focus,
        hSize: k.hSize, vSize: k.vSize,
        // 400-line packs the traces until the gaps vanish; 200-line leaves
        // real black glass between them
        scanlineDepth: this.line400 ? 0.3 : 1.0,
        beamHeight: this.line400 ? 1.0 : 0.35,
      });
      this._tubes[key].ss = ss; // remember so knob recompute keeps the pitch scaled
    }
    return this._tubes[key];
  }

  plotOpts() {
    // "flicker feel": a 60Hz raster shown on a 60Hz display cancels out, so
    // what reads as CRT flicker is the ~10Hz beat you get filming one — a
    // slow luminance throb. Deterministic (frame-counted), no randomness.
    let flick = 1;
    if (this.knobs.flickerOn) {
      this._flickerPhase = (this._flickerPhase ?? 0) + 1;
      const beat = Math.sin(this._flickerPhase * 2 * Math.PI * 10 / 60);
      const hum = Math.sin(this._flickerPhase * 2 * Math.PI * 1.7 / 60); // mains drift
      flick = 1 - 0.10 * (0.5 + 0.5 * beat) - 0.04 * (0.5 + 0.5 * hum);
    }
    return {
      scale: this.knobs.bright * flick,
      tint: this.knobs.tintOn ? this.knobs.tint : 0,
      contrast: this.knobs.contrast,
    };
  }

  get line2() { return this.line400 ? 1.0 : 0.55; } // second scanline dimming

  // V-HOLD + power collapse, applied to an indexed frame before excitation
  applyDeflection(src, w, h, frame) {
    const blank = Math.round(h * 0.12), total = h + blank;
    const k = this.knobs;
    if (k.vhold !== 0) {
      const wobble = 1 + 0.8 * Math.sin(this._rollPos / total * Math.PI * 2);
      this._rollPos = (this._rollPos + k.vhold * wobble + total) % total;
    } else if (this._rollPos !== 0) {
      this._rollPos = this._rollPos < total / 2
        ? this._rollPos * 0.8 : total - (total - this._rollPos) * 0.8;
      if (this._rollPos < 0.6 || this._rollPos > total - 0.6) this._rollPos = 0;
    }
    if (this._rollPos === 0) return src;
    if (!this._rollBuf || this._rollBuf.length !== w * h) this._rollBuf = new Uint8Array(w * h);
    const stretch = 1 + Math.min(0.5, Math.abs(k.vhold) * 0.03)
      * Math.sin(this._rollPos / total * Math.PI * 4);
    return rollScan(src, this._rollBuf, w, h, Math.round(this._rollPos) % total, blank, 1, stretch);
  }

  // ---- UI ----------------------------------------------------------------
  _build(mount) {
    const wrap = document.createElement('div');
    wrap.className = 'crt-panel';
    const bar = document.createElement('div');
    bar.className = 'row';
    const toggle = document.createElement('button');
    toggle.id = 'crtpanel-toggle';
    toggle.textContent = t('CRT設定');
    toggle.onclick = () => this._collapse(!this.collapsed);
    bar.appendChild(toggle);
    wrap.appendChild(bar);

    const body = document.createElement('div');
    body.id = 'crtpanel-body';

    const rowOf = (label) => {
      const r = document.createElement('div');
      r.className = 'row';
      const l = document.createElement('span');
      l.className = 'lbl';
      l.textContent = t(label);
      r.appendChild(l);
      body.appendChild(r);
      return r;
    };

    const group = (row, items, current, set) => {
      const btns = {};
      for (const [key, label] of items) {
        const b = document.createElement('button');
        b.textContent = t(label);
        b.classList.toggle('on', key === current());
        b.onclick = () => {
          set(key);
          for (const [k2, b2] of Object.entries(btns)) b2.classList.toggle('on', k2 === key);
          this._save();
          this.onChange?.();
        };
        btns[key] = b;
        row.appendChild(b);
      }
      return btns;
    };

    group(rowOf('蛍光体:'), PHOSPHOR_LABELS, () => this.phosName, (k) => {
      this.phosName = k;
      this._phosphor?.setPhosphor(PHOSPHORS[k]);
    });

    const tubeRow = rowOf('管:');
    group(tubeRow, TUBE_LABELS, () => this.tubeMode, (k) => { this.tubeMode = k; });
    const flag = (label, get, set) => {
      const b = document.createElement('button');
      b.textContent = t(label);
      b.classList.toggle('on', get());
      b.onclick = () => {
        set(!get());
        b.classList.toggle('on', get());
        this._tubes = {}; // geometry-affecting flags rebuild the tube
        this._save();
        this.onChange?.();
      };
      tubeRow.appendChild(b);
    };
    flag('インターレース', () => this.interlaced, (v) => { this.interlaced = v; });
    flag('400ライン', () => this.line400, (v) => { this.line400 = v; });
    flag('フリッカー', () => !!this.knobs.flickerOn, (v) => { this.knobs.flickerOn = v; });
    const ghostLabel = document.createElement('label');
    ghostLabel.style.cssText = 'color:#778;font-size:12px';
    ghostLabel.textContent = t('ガラス反射');
    const ghostCb = document.createElement('input');
    ghostCb.type = 'checkbox';
    ghostCb.checked = this.knobs.ghost > 0;
    ghostCb.style.margin = '2px';
    ghostCb.onchange = () => {
      this.knobs.ghost = ghostCb.checked ? 0.07 : 0;
      for (const tb of Object.values(this._tubes)) tb.ghost = this.knobs.ghost;
      this._save();
    };
    ghostLabel.appendChild(ghostCb);
    tubeRow.appendChild(ghostLabel);

    const knobRow = rowOf('ノブ:');
    knobRow.classList.add('knobs');
    for (const [key, label, min, max, step] of KNOBS) {
      const lab = document.createElement('label');
      lab.textContent = label + ' ';
      const inp = document.createElement('input');
      inp.type = 'range';
      inp.min = String(min); inp.max = String(max); inp.step = String(step);
      inp.value = String(this.knobs[key]);
      inp.oninput = () => {
        this.knobs[key] = +inp.value;
        if (key === 'focus') for (const tb of Object.values(this._tubes)) tb.beamWidth = this.knobs.focus;
        else if (['hSize', 'vSize', 'pitch', 'conv', 'barrel'].includes(key)) {
          for (const tb of Object.values(this._tubes)) {
            tb.setGeometry({
              hSize: this.knobs.hSize, vSize: this.knobs.vSize, maskPitch: this.knobs.pitch,
              convergence: this.knobs.conv, barrel: this.knobs.barrel,
            });
          }
        }
        this._save();
      };
      lab.appendChild(inp);
      knobRow.appendChild(lab);
    }
    // TINT with its enable checkbox (a phase error only exists when it does)
    const tintLab = document.createElement('label');
    tintLab.textContent = 'TINT ';
    const tintCb = document.createElement('input');
    tintCb.type = 'checkbox';
    tintCb.checked = this.knobs.tintOn;
    tintCb.onchange = () => { this.knobs.tintOn = tintCb.checked; this._save(); };
    const tintRange = document.createElement('input');
    tintRange.type = 'range';
    tintRange.min = '-60'; tintRange.max = '60'; tintRange.step = '1';
    tintRange.value = String(this.knobs.tint * 180 / Math.PI);
    tintRange.oninput = () => { this.knobs.tint = (+tintRange.value) * Math.PI / 180; this._save(); };
    tintLab.appendChild(tintCb);
    tintLab.appendChild(tintRange);
    knobRow.appendChild(tintLab);

    wrap.appendChild(body);
    mount.appendChild(wrap);
    this._body = body;
    this._toggle = toggle;
  }

  _collapse(on) {
    this.collapsed = on;
    this._body.style.display = on ? 'none' : '';
    this._toggle.textContent = (on ? '▸ ' : '▾ ') + t('CRT設定');
    this._toggle.classList.toggle('on', !on);
    this._save();
  }

  _save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({
        phosName: this.phosName, tubeMode: this.tubeMode, interlaced: this.interlaced,
        line400: this.line400, knobs: this.knobs, collapsed: this.collapsed,
      }));
    } catch {}
  }

  _restore() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const s = JSON.parse(raw);
      this._saved = s;
      if (s.phosName && PHOSPHORS[s.phosName]) this.phosName = s.phosName;
      if (s.tubeMode) this.tubeMode = s.tubeMode;
      this.interlaced = !!s.interlaced;
      this.line400 = !!s.line400;
      Object.assign(this.knobs, s.knobs ?? {});
    } catch {}
  }
}

export function mountCrtPanel(mount, opts) {
  return new CrtPanel(mount, opts);
}
