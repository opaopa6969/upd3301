// YM2608 (OPNA) — the Sound Board II chip. Phase-0/1 scaffold: a superset of
// the YM2203 (OPN) core, adding the second register bank (FM channels 4-6 and
// the ADPCM/rhythm register file) reached on the PC-88 at I/O ports
// 0xAA (addr1) / 0xAB (data1); bank 0 is at 0xA8 (addr0) / 0xA9 (data0+status).
// (Port mapping confirmed by disassembling a real music disk — see
// docs/opna-design.md §9. NOT 0x46/0x47.)
//
// Implemented here: 6-voice FM (bank-1 FM4-6 reuse the OPN register layout),
// the $28 key-on group bit, SSG (inherited), timers/status/IRQ (inherited).
// Stubbed for later phases: ADPCM-A rhythm decode, ADPCM-B PCM, stereo pan.
// The register WRITES for those are captured into reg1 so a boot/trace can be
// inspected before the decoders exist.
//
// Contract: pure, deterministic, no DOM/three. Same signal path as ym2203.js.

import { Ym2203, FmChannel, SCHEMA_VERSION as OPN_SCHEMA } from './ym2203.js';

export const SCHEMA_VERSION = 1;

export class Ym2608 extends Ym2203 {
  constructor(opts = {}) {
    super(opts);
    // OPNA carries six FM channels (OPN's three + a second bank of three). The
    // render loop already iterates this.ch, so growing the array to six gives
    // 6-voice FM for free. FM effective clock matches the OPN on PC-88 (the
    // 8 MHz part with its /2 prescaler) — kept equal here; the exact prescaler
    // ($2D-$2F) is flagged for verification in the design doc.
    this.ch = [new FmChannel(), new FmChannel(), new FmChannel(),
               new FmChannel(), new FmChannel(), new FmChannel()];
    // per-voice mute grows to 6 FM + 3 SSG; SSG muting moves to base 6 so it
    // no longer collides with FM4-6 (OPN kept SSG at 3).
    this.chMute = [false, false, false, false, false, false, false, false, false];
    this.ssgMuteBase = 6;

    // second register bank
    this.addr1 = 0;
    this.reg1 = new Uint8Array(256);

    // ADPCM register mirrors. Rhythm = ADPCM-A ($00-$0D bank1); the delta-PCM
    // channel = ADPCM-B ($10-$1B bank1, decoder still deferred).
    //   key/total/level/lr : the register file (as written by the driver)
    //   pos                : per-drum playback pointer, in SOURCE samples
    //   on                 : per-drum playing flag (1 while the sample runs)
    this.rhythm = {
      key: 0, total: 63, level: new Uint8Array(6), lr: new Uint8Array(6),
      pos: new Float64Array(6), on: new Uint8Array(6),
    };
    this.adpcmB = { ctrl: 0, lr: 0, start: 0, end: 0, limit: 0, deltaN: 0, level: 0 };

    // Rhythm ROM: the six drum PCM waveforms (BD, SD, TOP, HH, TOM, RIM), one
    // Float32Array each in [-1,1], side-loaded like the BIOS ROMs (the real
    // YM2608 has these in an internal mask ROM as ADPCM-A; we accept already-
    // decoded PCM so the core stays pure — no file I/O in the chip). Index by
    // the $00 key bit: 0=BD 1=SD 2=TOP 3=HH 4=TOM 5=RIM. null → drums silent.
    this.rhythmRom = null;
    this.rhythmRate = 44100;              // source sample rate of the ROM WAVs
    this.rhythmStep = this.rhythmRate / this.sampleRate; // ptr advance / out-sample
    this.rhythmGain = 0.8;                // rhythm bus level (live knob)
  }

  // Side-load the drum PCM. `samples` is an array of 6 Float32Array (or numeric
  // arrays) in [-1,1]; `rate` is their sample rate (default 44.1 kHz, the WAVs
  // in assets/opna-rhythm/). Deterministic: same ROM + same key writes → same
  // samples. Order MUST be [BD, SD, TOP, HH, TOM, RIM] to match the $00 bits.
  setRhythmRom(samples, rate = 44100) {
    this.rhythmRom = samples ? samples.map((s) => (s instanceof Float32Array ? s : Float32Array.from(s))) : null;
    this.rhythmRate = rate;
    this.rhythmStep = this.rhythmRate / this.sampleRate;
    return this;
  }

  // ---- bank 1 (ports 0xAA / 0xAB) -----------------------------------------
  writeAddr1(v) { this.addr1 = v & 0xff; }

  writeData1(v) {
    v &= 0xff;
    const a = this.addr1;
    this.reg1[a] = v;
    // FM channels 4-6 share the OPN operator/channel layout ($30-$B6).
    if (a >= 0x30 && a <= 0xb6) {
      const c = a & 3;
      if (c > 2) return; // $x3/$x7/... unused
      this._writeFm(3 + c, a, v);
      return;
    }
    // ADPCM-A rhythm ($00-$0D). $00 = the RTL control: bits0-5 select drums,
    // bit7 chooses the action — 0 = key-on (restart that drum's pointer),
    // 1 = dump (stop it). Same key writes → same triggers (deterministic).
    if (a === 0x00) {
      this.rhythm.key = v;
      const dump = (v & 0x80) !== 0;
      for (let i = 0; i < 6; i++) {
        if (!(v & (1 << i))) continue;
        if (dump) { this.rhythm.on[i] = 0; }
        else { this.rhythm.pos[i] = 0; this.rhythm.on[i] = 1; }
      }
      return;
    }
    if (a === 0x01) { this.rhythm.total = v & 0x3f; return; }
    if (a >= 0x08 && a <= 0x0d) { const i = a - 0x08; this.rhythm.lr[i] = v >> 6; this.rhythm.level[i] = v & 0x1f; return; }
    // ADPCM-B ($10-$1B) — mirror now, decode later.
    if (a >= 0x10 && a <= 0x1b) { this._adpcmBReg(a, v); return; }
  }

  _adpcmBReg(a, v) {
    const b = this.adpcmB;
    switch (a) {
      case 0x10: b.ctrl = v; break;
      case 0x11: b.lr = v >> 6; break;
      case 0x12: b.start = (b.start & 0xff00) | v; break;
      case 0x13: b.start = (b.start & 0xff) | (v << 8); break;
      case 0x14: b.end = (b.end & 0xff00) | v; break;
      case 0x15: b.end = (b.end & 0xff) | (v << 8); break;
      case 0x19: b.deltaN = (b.deltaN & 0xff00) | v; break;
      case 0x1a: b.deltaN = (b.deltaN & 0xff) | (v << 8); break;
      case 0x1b: b.level = v; break;
      default: break;
    }
  }

  // ---- $28 key-on with the OPNA group bit ---------------------------------
  // OPN used bits0-1 as the channel (0-2). OPNA adds bit2 as the group select:
  // bit2=0 -> FM1-3, bit2=1 -> FM4-6. (OPN's `v & 3` silently dropped it.)
  _keyReg(v) {
    const c = v & 3;
    if (c > 2) return; // c==3 is not a valid channel
    const idx = c + ((v & 4) ? 3 : 0);
    const ch = this.ch[idx];
    for (let i = 0; i < 4; i++) this._key(ch.ops[i], (v & (0x10 << i)) !== 0);
    ch.keyOn = v >> 4;
  }

  // ---- ADPCM-A rhythm synthesis -------------------------------------------
  // Per-drum gain from the two attenuation registers, in the chip's 0.75 dB
  // steps: total level ($01, 6-bit) attenuates the whole rhythm bus, individual
  // level ($08-$0D, 5-bit) attenuates one drum. Max (total=63, level=31) = 0 dB;
  // each step down is −0.75 dB. So a louder register value → a louder drum, and
  // the six drums keep their programmed relative balance.
  _rhythmGain(i) {
    const attSteps = (63 - this.rhythm.total) + (31 - this.rhythm.level[i]);
    return Math.pow(10, -(attSteps * 0.75) / 20);
  }

  // Advance every playing drum by one OUTPUT sample and return [L, R]. The pan
  // bits ($08-$0D b7=L b6=R, stored as lr: b1=L b0=R) route each drum; a drum
  // with neither bit set is silent (hardware-correct). Linear interpolation
  // resamples the ROM rate (44.1 kHz) to the output rate. Pointer past the end
  // clears the playing flag (one-shot). Deterministic.
  _rhythmTick() {
    const rom = this.rhythmRom;
    if (!rom) return [0, 0];
    let l = 0, r = 0;
    const R = this.rhythm;
    for (let i = 0; i < 6; i++) {
      if (!R.on[i]) continue;
      const w = rom[i];
      if (!w || w.length < 2) { R.on[i] = 0; continue; }
      const p = R.pos[i];
      const idx = p | 0;
      if (idx >= w.length) { R.on[i] = 0; continue; } // fully past the end → stop
      const frac = p - idx;
      const nxt = idx + 1 < w.length ? w[idx + 1] : w[idx]; // hold last sample at the tail
      const s = (w[idx] * (1 - frac) + nxt * frac) * this._rhythmGain(i);
      const lr = R.lr[i];
      if (lr & 2) l += s;
      if (lr & 1) r += s;
      R.pos[i] = p + this.rhythmStep;
    }
    return [l * this.rhythmGain, r * this.rhythmGain];
  }

  // OPN render() hook: fold the rhythm bus (mono = L+R) into the FM sum so the
  // drums pass through the board output stage with the FM. This is what makes
  // machine88.renderAudio() / the demo carry the drums with no extra wiring.
  _aux() {
    if (!this.rhythmRom) return 0;
    const [l, r] = this._rhythmTick();
    return l + r;
  }

  // Render ONLY the rhythm bus, in stereo — the ADPCM-A drum sub-mix, without
  // FM/SSG. Used to A/B the drums and to test pan/level in isolation. Does NOT
  // run the FM/SSG cores, so it must not be interleaved with render() on the
  // same instance (both advance the drum pointers).
  renderRhythm(outL, outR, n = outL.length) {
    for (let i = 0; i < n; i++) {
      const [l, r] = this._rhythmTick(); // gain already applied inside
      outL[i] = l;
      outR[i] = r;
    }
    return outL;
  }

  getState() {
    const s = super.getState();
    s.schemaVersion = SCHEMA_VERSION;
    s.opna = {
      addr1: this.addr1,
      reg1: Array.from(this.reg1),
      rhythm: {
        key: this.rhythm.key, total: this.rhythm.total,
        level: Array.from(this.rhythm.level), lr: Array.from(this.rhythm.lr),
        pos: Array.from(this.rhythm.pos), on: Array.from(this.rhythm.on),
      },
      adpcmB: { ...this.adpcmB },
    };
    return s;
  }

  setState(s) {
    if (typeof super.setState === 'function') super.setState(s);
    if (s.opna) {
      this.addr1 = s.opna.addr1 | 0;
      this.reg1 = Uint8Array.from(s.opna.reg1 || []);
      if (s.opna.rhythm) {
        const r = s.opna.rhythm;
        this.rhythm.key = r.key; this.rhythm.total = r.total;
        this.rhythm.level = Uint8Array.from(r.level); this.rhythm.lr = Uint8Array.from(r.lr);
        if (r.pos) this.rhythm.pos = Float64Array.from(r.pos);
        if (r.on) this.rhythm.on = Uint8Array.from(r.on);
      }
      if (s.opna.adpcmB) this.adpcmB = { ...s.opna.adpcmB };
    }
  }
}

export function createYm2608(opts) { return new Ym2608(opts); }
