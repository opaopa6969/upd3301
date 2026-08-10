// ym2612 — the Mega Drive's FM chip (YM2612 / OPN2), built on the OPN core in
// ym2203.js rather than beside it. The operator maths, the envelope generator,
// the LOG-SIN/EXP signal path and the timers are the same silicon lineage; what
// OPN2 adds over OPN is a second register bank (channels 4-6), stereo panning,
// an LFO with per-channel depth, channel 3's four independent frequencies, and
// the 8-bit DAC that hangs off channel 6 and plays every sampled drum and voice
// clip on the console.
//
// ## The clock, and why it is halved on the way to the base class
//
// ym2203.js derives its FM tick from clock/72, which is the OPN divider. OPN2
// divides by 144. Rather than parameterise the base class, the constructor
// hands it half the real clock: 7.67 MHz / 2 / 72 == 7.67 MHz / 144, so the FM
// rate AND both timer periods come out right with no changes upstream. The
// real clock stays on `chipClockHz` for anyone who needs it. This is exact,
// not approximate — the numbers are the same numbers.
//
// One consequence worth writing down: on a Mega Drive the YM2612 is clocked at
// mclk/7, the same wire as the 68000, so one FM tick is exactly 7 x 144 = 1008
// master clocks. The machine can count FM ticks in integers with no drift.
//
// ## What the DAC is for
//
// Writing $2B bit 7 replaces channel 6's FM output with whatever byte was last
// written to $2A. Sound drivers feed it from the Z80 in a tight timed loop, so
// on this console the "sixth FM channel" is usually a drum sampler. Games that
// forget to clear the bit lose a channel — and so does an emulator that forgets
// to implement it, in the opposite direction: it plays a stuck FM note under
// the whole soundtrack.
//
// ## Known simplifications (also in docs/md-design.md)
//
// - The LFO is a triangle at the documented rates, applied as a phase-modulation
//   offset and an amplitude-modulation attenuation. The real chip's PM is a
//   piecewise table indexed by the top bits of F-number; this is close in
//   depth and identical in rate, which is what vibrato depends on audibly.
// - The DAC is written at the moment the register is written and held until the
//   next write. The real chip's ladder has a well-known distortion the
//   "Mega Drive sound" is partly made of; that is not modelled.
// - The busy flag reads back as clear: writes complete instantly here, and a
//   driver that polls it just proceeds.

import { Ym2203, FmChannel, SCHEMA_VERSION as OPN_SCHEMA } from './ym2203.js';

export const SCHEMA_VERSION = 1;

// mclk/7 on an NTSC Mega Drive — the same clock the 68000 runs on.
export const MD_YM_CLOCK = 7670453;

// LFO rates in Hz for the eight settings of $22 bits 0-2 (the published table).
const LFO_HZ = [3.98, 5.56, 6.02, 6.37, 6.88, 9.63, 48.1, 72.2];
// Phase-modulation depth per PMS setting, as a fraction of a semitone-ish
// F-number wobble. PMS 0 is off; 7 is the wide "siren" vibrato.
const PMS_DEPTH = [0, 0.0033, 0.0066, 0.0099, 0.0132, 0.0198, 0.0396, 0.0792];
// Amplitude-modulation depth per AMS setting, in envelope attenuation units
// (the chip's 1.4 / 5.9 / 11.8 dB).
const AMS_DEPTH = [0, 15, 63, 126];
// 9 channel fields + 4 operators x 15 fields; see getState().
const CH_STATE_WORDS = 9 + 4 * 15;

export class Ym2612 extends Ym2203 {
  constructor({ clockHz = MD_YM_CLOCK, sampleRate = 48000 } = {}) {
    // See the header: halving the clock makes the base class's /72 into /144.
    super({ clockHz: clockHz / 2, sampleRate });
    this.chipClockHz = clockHz;

    // Six channels. The base render loop iterates this.ch, so growing the
    // array is all channels 4-6 need structurally.
    this.ch = [new FmChannel(), new FmChannel(), new FmChannel(),
               new FmChannel(), new FmChannel(), new FmChannel()];
    for (const c of this.ch) { c.ams = 0; c.pms = 0; for (const o of c.ops) o.am = false; }
    this.chMute = [false, false, false, false, false, false];

    // Second register bank, reached through the second address/data pair.
    this.addr1 = 0;
    this.reg1 = new Uint8Array(256);

    // The DAC on channel 6.
    this.dacEnable = false;
    this.dacData = 0;

    this.lfoEnable = false;
    this.lfoFreq = 0;
    this.lfoPhase = 0;

    // Channel 3 special mode: each operator gets its own frequency, which is
    // how the console's bell/chime patches and most of its sound effects are
    // made. $27 bits 7-6 select it.
    this.ch3Mode = 0;
    this.ch3Fnum = new Uint16Array(3); // operators 1,2,3 (operator 4 uses $A2/$A6)
    this.ch3Block = new Uint8Array(3);

    // The Mega Drive's YM2612 is mono per channel but stereo per bus; the
    // OPN base has no stereo path, so render() below is ours.
    this.mute = { fm: false, ssg: true }; // there is no SSG on an OPN2
  }

  // ---- bus -------------------------------------------------------------------
  // Four byte-wide registers at $4000-$4003 on the Z80 bus (and $A04000 on the
  // 68000's). Address then data, twice over — one pair per bank.
  write(offset, value) {
    switch (offset & 3) {
      case 0: this.addr = value & 0xff; break;
      case 1: this._writeBank0(this.addr, value & 0xff); break;
      case 2: this.addr1 = value & 0xff; break;
      case 3: this._writeBank1(this.addr1, value & 0xff); break;
      default: break;
    }
    return this;
  }

  // Every one of the four addresses returns the same status byte on a real
  // chip. Bit 7 is BUSY and bits 1-0 are the timer overflow flags; the busy
  // bit is never set here because a write to this model costs no time.
  read(_offset = 0) { return this.status & 0x03; }

  _writeBank0(a, v) {
    this.reg[a] = v;
    if (a === 0x22) { this.lfoEnable = (v & 8) !== 0; this.lfoFreq = v & 7; return; }
    if (a === 0x24) { this.timerA = (this.timerA & 3) | (v << 2); return; }
    if (a === 0x25) { this.timerA = (this.timerA & 0x3fc) | (v & 3); return; }
    if (a === 0x26) { this.timerB = v; return; }
    if (a === 0x27) {
      this.ch3Mode = (v >> 6) & 3;
      this.irqEnableA = (v & 4) !== 0;
      this.irqEnableB = (v & 8) !== 0;
      if (v & 0x10) this.status &= ~1;
      if (v & 0x20) this.status &= ~2;
      const runA = (v & 1) !== 0, runB = (v & 2) !== 0;
      if (runA && !this.timerARun) this.timerACount = 1024 - this.timerA;
      if (runB && !this.timerBRun) this.timerBCount = (256 - this.timerB) * 16;
      this.timerARun = runA; this.timerBRun = runB;
      return;
    }
    if (a === 0x28) return this._keyReg(v);
    if (a === 0x2a) { this.dacData = v; return; }
    if (a === 0x2b) { this.dacEnable = (v & 0x80) !== 0; return; }
    // $A8-$AE in bank 0 are channel 3's per-operator frequencies. They sit in
    // the address range the channel decoder would otherwise read as "channel
    // 0", so they have to be caught before it.
    if (a >= 0xa8 && a <= 0xaa) { const i = a - 0xa8; this.ch3Fnum[i] = (this.ch3Fnum[i] & 0x700) | v; return; }
    if (a >= 0xac && a <= 0xae) {
      const i = a - 0xac;
      this.ch3Fnum[i] = (this.ch3Fnum[i] & 0xff) | ((v & 7) << 8);
      this.ch3Block[i] = (v >> 3) & 7;
      return;
    }
    if (a < 0x30) return; // SSG address space on an OPN; nothing here
    const c = a & 3;
    if (c > 2) return;    // $x3/$x7/... are unmapped
    this._writeFm2(c, a, v);
  }

  _writeBank1(a, v) {
    this.reg1[a] = v;
    if (a < 0x30) return; // bank 1 has no global registers at all
    const c = a & 3;
    if (c > 2) return;
    this._writeFm2(c + 3, a, v);
  }

  // The OPN base handles everything except the two bits it has no use for:
  // the per-operator AM enable ($60 bit 7) and the per-channel LFO depths
  // ($B4 bits 6-4 and 2-0).
  _writeFm2(ci, a, v) {
    this._writeFm(ci, a, v);
    const ch = this.ch[ci];
    const slot = [0, 2, 1, 3][(a >> 2) & 3];
    if ((a & 0xf0) === 0x60) ch.ops[slot].am = (v & 0x80) !== 0;
    else if ((a & 0xfc) === 0xb4) { ch.ams = (v >> 4) & 3; ch.pms = v & 7; }
  }

  // $28: bits 2-0 are the channel (0-2 = FM1-3, 4-6 = FM4-6; 3 and 7 are not
  // channels), bits 7-4 the four operator key bits.
  _keyReg(v) {
    const sel = v & 7;
    if (sel === 3 || sel === 7) return;
    const idx = (sel & 3) + ((sel & 4) ? 3 : 0);
    const ch = this.ch[idx];
    for (let i = 0; i < 4; i++) this._key(ch.ops[i], (v & (0x10 << i)) !== 0);
    ch.keyOn = v >> 4;
    return this;
  }

  // ---- render ----------------------------------------------------------------
  // Stereo, because the pan bits are the one thing every Mega Drive soundtrack
  // uses and a mono sum throws them away. `renderMono` is the convenience the
  // machine's own renderAudio() uses for the demo's single-channel path.
  render(outL, outR, n = outL.length) {
    const chs = this.ch;
    for (let i = 0; i < n; i++) {
      this.fmAcc += this.fmStep;
      let ticks = 0;
      while (this.fmAcc >= 1) { this.fmAcc -= 1; ticks++; }
      if (ticks === 0) ticks = 1; // never let a channel's phase stall

      let l = 0, r = 0;
      for (let t = 0; t < ticks; t++) {
        this._lfoTick();
        l = 0; r = 0;
        for (let ci = 0; ci < 6; ci++) {
          let s;
          if (ci === 5 && this.dacEnable) s = (this.dacData - 128) / 128;
          else s = this._fmChannelLfo(chs[ci], ci);
          if (this.chMute[ci]) continue;
          const c = chs[ci];
          if (c.left) l += s;
          if (c.right) r += s;
        }
      }
      // Six channels summing to +/-1 each would clip constantly; the chip's own
      // output stage divides by the channel count and a real Mega Drive's
      // amplifier is what supplies the rest of the character. A soft limiter
      // keeps the rail instead of wrapping.
      outL[i] = softClip(l / 3);
      if (outR) outR[i] = softClip(r / 3);
    }
    return outL;
  }

  renderMono(out, n = out.length) {
    if (!this._monoR || this._monoR.length < n) this._monoR = new Float32Array(n);
    this.render(out, this._monoR, n);
    for (let i = 0; i < n; i++) out[i] = (out[i] + this._monoR[i]) * 0.5;
    return out;
  }

  _lfoTick() {
    if (!this.lfoEnable) { this.lfoPhase = 0; return; }
    const fmRate = this.clockHz / 72; // FM ticks per second (see the header)
    this.lfoPhase += LFO_HZ[this.lfoFreq] / fmRate;
    if (this.lfoPhase >= 1) this.lfoPhase -= 1;
  }

  // A triangle from -1 to +1 for PM, and a 0..1 ramp for AM (the chip's AM is
  // unipolar: it only ever attenuates).
  _lfoPm() { const p = this.lfoPhase; return p < 0.5 ? (p * 4 - 1) : (3 - p * 4); }
  _lfoAm() { const p = this.lfoPhase; return p < 0.5 ? p * 2 : 2 - p * 2; }

  // One channel with the LFO folded in. The base class's _fmChannel reads the
  // channel's fnum/block and the operators' tl, so PM and AM are applied by
  // adjusting those around the call and putting them back — the alternative is
  // duplicating the whole operator loop here, which would then drift from the
  // OPN version every time either is fixed.
  _fmChannelLfo(ch, ci) {
    const special = ci === 2 && this.ch3Mode !== 0;
    const pm = this.lfoEnable && ch.pms ? this._lfoPm() * PMS_DEPTH[ch.pms] : 0;
    const am = this.lfoEnable && ch.ams ? this._lfoAm() * AMS_DEPTH[ch.ams] : 0;

    let saveF = 0;
    if (pm) {
      saveF = ch.fnum;
      ch.fnum = Math.max(0, Math.min(0x7ff, Math.round(ch.fnum * (1 + pm))));
    }
    let saved = null;
    if (am) {
      saved = [];
      for (const op of ch.ops) { saved.push(op.tl); if (op.am) op.tl = Math.min(127, op.tl + (am >> 3)); }
    }

    if (special) this._applyCh3Offsets(ch);
    const out = this._fmChannel(ch);

    if (saved) { for (let i = 0; i < 4; i++) ch.ops[i].tl = saved[i]; }
    if (pm) ch.fnum = saveF;
    return out;
  }

  // Channel 3 special mode: operators 1-3 take their frequency from $A8-$AE
  // and operator 4 keeps the channel's own $A2/$A6.
  //
  // The base class advances all four phases from ch.fnum, so rather than
  // duplicating the operator loop the DIFFERENCE between each operator's own
  // increment and the channel's is added first. Phase advance is additive, so
  // (phase + delta) + channel_increment == phase + own_increment exactly —
  // the operator's output this tick is computed from the right phase, and the
  // OPN operator path stays the single copy it should be.
  //
  // Slot order in the chip is 1,3,2,4 and $A8/$A9/$AA are in that same order,
  // hence the mapping below.
  _applyCh3Offsets(ch) {
    const SLOT_OF_REG = [0, 2, 1]; // $A8 -> op1, $A9 -> op3, $AA -> op2
    const chInc = (ch.fnum << ch.block) / 2048;
    for (let r = 0; r < 3; r++) {
      const op = ch.ops[SLOT_OF_REG[r]];
      const own = (this.ch3Fnum[r] << this.ch3Block[r]) / 2048;
      let p = (op.phase + (own - chInc) * op.mul) % 1024;
      if (p < 0) p += 1024;
      op.phase = p;
    }
  }

  // ---- state -----------------------------------------------------------------
  // The full dynamic state, not just the registers: an operator's phase and
  // envelope are what make a restored note continue instead of restarting, and
  // the machine's snapshot has to be an exact inverse or a rewind changes the
  // music. Nothing immutable is stored (there is no ROM in this chip).
  //
  // The channel and operator state goes into one flat Float64Array rather than
  // 6 objects holding 4 objects holding 15 fields. That is not premature
  // tuning: the host keeps up to a thousand of these in its rewind ring, and
  // 30,000 short-lived objects per second of history is a garbage collector
  // problem that shows up as a stutter while scrubbing.
  getState() {
    const ch = new Float64Array(CH_STATE_WORDS * 6);
    for (let ci = 0; ci < 6; ci++) {
      const c = this.ch[ci];
      let o = ci * CH_STATE_WORDS;
      ch[o++] = c.alg; ch[o++] = c.fb; ch[o++] = c.fnum; ch[o++] = c.block;
      ch[o++] = c.left ? 1 : 0; ch[o++] = c.right ? 1 : 0; ch[o++] = c.keyOn;
      ch[o++] = c.ams; ch[o++] = c.pms;
      for (let oi = 0; oi < 4; oi++) {
        const p = c.ops[oi];
        ch[o++] = p.dt; ch[o++] = p.mul; ch[o++] = p.tl; ch[o++] = p.ks;
        ch[o++] = p.ar; ch[o++] = p.dr; ch[o++] = p.sr; ch[o++] = p.rr;
        ch[o++] = p.sl; ch[o++] = p.phase; ch[o++] = p.env; ch[o++] = p.state;
        ch[o++] = p.out; ch[o++] = p.prev; ch[o++] = p.am ? 1 : 0;
      }
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      opn: OPN_SCHEMA,
      reg: this.reg.slice(),
      reg1: this.reg1.slice(),
      chState: ch,
      addr: this.addr, addr1: this.addr1,
      status: this.status,
      timerA: this.timerA, timerB: this.timerB,
      timerACount: this.timerACount, timerBCount: this.timerBCount,
      timerARun: this.timerARun, timerBRun: this.timerBRun,
      irqEnableA: this.irqEnableA, irqEnableB: this.irqEnableB,
      dacEnable: this.dacEnable, dacData: this.dacData,
      lfoEnable: this.lfoEnable, lfoFreq: this.lfoFreq, lfoPhase: this.lfoPhase,
      ch3Mode: this.ch3Mode,
      ch3Fnum: Array.from(this.ch3Fnum), ch3Block: Array.from(this.ch3Block),
      fmAcc: this.fmAcc,
    };
  }

  setState(s) {
    for (let i = 0; i < 256; i++) { this.reg[i] = s.reg[i]; this.reg1[i] = s.reg1[i]; }
    this.addr = s.addr; this.addr1 = s.addr1;
    this.status = s.status;
    this.timerA = s.timerA; this.timerB = s.timerB;
    this.timerACount = s.timerACount; this.timerBCount = s.timerBCount;
    this.timerARun = s.timerARun; this.timerBRun = s.timerBRun;
    this.irqEnableA = s.irqEnableA; this.irqEnableB = s.irqEnableB;
    this.dacEnable = s.dacEnable; this.dacData = s.dacData;
    this.lfoEnable = s.lfoEnable; this.lfoFreq = s.lfoFreq; this.lfoPhase = s.lfoPhase;
    this.ch3Mode = s.ch3Mode;
    for (let i = 0; i < 3; i++) { this.ch3Fnum[i] = s.ch3Fnum[i]; this.ch3Block[i] = s.ch3Block[i]; }
    this.fmAcc = s.fmAcc;
    const ch = s.chState;
    for (let ci = 0; ci < 6; ci++) {
      const c = this.ch[ci];
      let o = ci * CH_STATE_WORDS;
      c.alg = ch[o++]; c.fb = ch[o++]; c.fnum = ch[o++]; c.block = ch[o++];
      c.left = ch[o++] !== 0; c.right = ch[o++] !== 0; c.keyOn = ch[o++];
      c.ams = ch[o++]; c.pms = ch[o++];
      for (let oi = 0; oi < 4; oi++) {
        const p = c.ops[oi];
        p.dt = ch[o++]; p.mul = ch[o++]; p.tl = ch[o++]; p.ks = ch[o++];
        p.ar = ch[o++]; p.dr = ch[o++]; p.sr = ch[o++]; p.rr = ch[o++];
        p.sl = ch[o++]; p.phase = ch[o++]; p.env = ch[o++]; p.state = ch[o++];
        p.out = ch[o++]; p.prev = ch[o++]; p.am = ch[o++] !== 0;
      }
    }
    return this;
  }
}

// A hard clip on a summed FM bus buzzes; the console's amplifier does not.
function softClip(v) {
  const a = v < 0 ? -v : v;
  if (a <= 0.85) return v;
  const sign = v < 0 ? -1 : 1;
  return sign * (0.85 + 0.15 * Math.tanh((a - 0.85) / 0.15));
}

export function createYm2612(opts) { return new Ym2612(opts); }
export default Ym2612;
