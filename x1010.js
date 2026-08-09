// x1010 — the Seta X1-010, a 16-voice wavetable-and-sample generator in an
// 80-pin PQFP (a programmed Mitsubishi M60016 gate array).
//
// Pure, deterministic, zero deps. The chip is a block of RAM the CPU writes and
// the chip reads; there is no command protocol and no FIFO, so this file is
// mostly a mixer with an unusual register map.
//
// ## Two completely different voices per channel, chosen by one bit
//
//   PCM (bit 1 clear)  — the channel plays 8-bit signed samples straight out of
//     the sample ROM. Start and end are given in 4 KB units, and the "end"
//     field is stored as 0x100 minus the block number, so a longer sample is a
//     SMALLER number. The step is a 4.4 fixed-point rate.
//   Waveform (bit 1 set) — the channel plays a 128-byte wave out of the chip's
//     own RAM, at a 6.10 fixed-point pitch, with its volume taken sample by
//     sample from a 128-byte envelope also in chip RAM.
//
// So the same eight registers mean different things depending on one bit, which
// is why the register struct below is commented twice. Getting the split wrong
// gives silence rather than noise, because the PCM path's "end" test fires
// immediately on a waveform's register values.
//
// ## Rate
//
// The chip runs at clock/512 — 31250 Hz from the usual 16 MHz crystal. Rather
// than resample with a filter, this generates at the native rate and holds each
// sample until the next one is due, with an integer phase accumulator. That is
// a zero-order hold: the arithmetic stays integer (so a snapshot restores to
// bit-identical output), and the aliasing it adds is above what the 8-bit
// source has anyway. docs/seta-design.md says so out loud.
//
// Checked against MAME's x1_010.cpp. Not verified against a real board or a
// speaker — see the honesty section of the design doc.

export const SCHEMA_VERSION = 1;

export const NUM_CHANNELS = 16;
const REG_SIZE = 0x2000;
// MAME's VOL_BASE: 2*32*256/30, truncated. Kept exactly, including the
// truncation, because it sets the absolute output level.
const VOL_BASE = Math.floor(2 * 32 * 256 / 30);   // 546
const OUT_SCALE = 1 / (32768 * 256);

export class X1010 {
  // `rom` is the x1snd region — the chip addresses it directly, the CPU cannot
  // see it. `clockHz` is the crystal; the sample rate follows from it.
  constructor({ rom = null, clockHz = 16000000, sampleRate = 48000 } = {}) {
    this.schemaVersion = SCHEMA_VERSION;
    this.rom = rom || new Uint8Array(0);
    this.clockHz = clockHz;
    this.sampleRate = sampleRate;
    this.nativeRate = Math.floor(clockHz / 512);
    this.reg = new Uint8Array(REG_SIZE);
    // The 68000 side is 16 bits wide but the chip is 8. The high byte of every
    // word write is latched here and given back on read, so a game that reads
    // back a register it wrote as a word sees what it wrote. Nothing in the
    // sound path looks at it — it is a bus artefact, not chip state.
    this.hiByte = new Uint8Array(REG_SIZE);
    this.smpOffset = new Uint32Array(NUM_CHANNELS);
    this.envOffset = new Uint32Array(NUM_CHANNELS);
    this.reset();
  }

  reset() {
    this.reg.fill(0);
    this.hiByte.fill(0);
    this.smpOffset.fill(0);
    this.envOffset.fill(0);
    this.soundEnable = 0;
    this._phase = 0;
    this._curL = 0; this._curR = 0;
    return this;
  }

  // The coin-lockout register carries a "sound enable" bit. It is recorded
  // because a snapshot should hold it, but it does not gate the mixer: MAME
  // found that gating it silences games that never set the bit, so the real
  // chip evidently does something subtler. Same choice here, same reason.
  enableWrite(v) { this.soundEnable = v ? 1 : 0; }

  read(offset) { return this.reg[offset & (REG_SIZE - 1)]; }

  write(offset, data) {
    offset &= REG_SIZE - 1;
    data &= 0xff;
    const ch = offset >> 3, reg = offset & 7;
    // Key-on is an EDGE, not a level: bit 0 going 0->1 rewinds the channel to
    // the start of its sample and its envelope. A game that retriggers a voice
    // by writing the same byte twice must not restart it, and a game that
    // restarts a looping sample relies on this firing.
    if (ch < NUM_CHANNELS && reg === 0 && (this.reg[offset] & 1) === 0 && (data & 1) !== 0) {
      this.smpOffset[ch] = 0;
      this.envOffset[ch] = 0;
    }
    this.reg[offset] = data;
  }

  wordRead(offset) {
    offset &= REG_SIZE - 1;
    return (this.hiByte[offset] << 8) | this.reg[offset];
  }

  wordWrite(offset, v) {
    offset &= REG_SIZE - 1;
    this.hiByte[offset] = (v >> 8) & 0xff;
    this.write(offset, v & 0xff);
  }

  // ---- generation -----------------------------------------------------------
  // One native sample. Every channel is examined every time; sixteen voices at
  // 31 kHz is half a million iterations a second, which is not worth a
  // dirty-channel list that could go stale after a restore.
  _generate() {
    let l = 0, r = 0;
    const reg = this.reg, rom = this.rom, romLen = rom.length;
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const b = ch * 8;
      const status = reg[b];
      if (!(status & 1)) continue;                 // key off
      const div = (status & 0x80) ? 1 : 0;         // frequency divider (downtown)
      if (!(status & 2)) {
        // ---- PCM ----
        const start = reg[b + 4] << 12;
        const end = (0x100 - reg[b + 5]) << 12;
        const volL = ((reg[b + 1] >> 4) & 0xf) * VOL_BASE;
        const volR = (reg[b + 1] & 0xf) * VOL_BASE;
        let step = reg[b + 2] >> div;
        // A frequency of zero would never advance. MAME calls its substitute a
        // hack and so is this; it keeps Meta Fox audible.
        if (step === 0) step = 4;
        const delta = this.smpOffset[ch] >>> 4;
        if (start + delta >= end) { reg[b] = status & 0xfe; continue; }  // key off at the end
        const a = start + delta;
        const data = a < romLen ? ((rom[a] << 24) >> 24) : 0;
        l += data * volL; r += data * volR;
        this.smpOffset[ch] = (this.smpOffset[ch] + step) >>> 0;
      } else {
        // ---- waveform ----
        const start = ((reg[b + 1] << 7) + 0x1000) & (REG_SIZE - 1);
        const step = ((reg[b + 3] << 8) + reg[b + 2]) >> div;
        const env = (reg[b + 5] << 7) & (REG_SIZE - 1);
        const envStep = reg[b + 4];
        const envDelta = this.envOffset[ch] >>> 10;
        // "Envelope one shot": run the envelope once and stop. Without the flag
        // the envelope index simply wraps and the note sustains forever.
        if ((status & 4) !== 0 && envDelta >= 0x80) { reg[b] = status & 0xfe; continue; }
        const vol = reg[env + (envDelta & 0x7f)];
        const volL = ((vol >> 4) & 0xf) * VOL_BASE;
        const volR = (vol & 0xf) * VOL_BASE;
        const data = (reg[start + ((this.smpOffset[ch] >>> 10) & 0x7f)] << 24) >> 24;
        l += data * volL; r += data * volR;
        this.smpOffset[ch] = (this.smpOffset[ch] + step) >>> 0;
        this.envOffset[ch] = (this.envOffset[ch] + envStep) >>> 0;
      }
    }
    this._curL = l * OUT_SCALE;
    this._curR = r * OUT_SCALE;
  }

  // Fill `n` samples at the host rate. The phase accumulator is integer, so the
  // same machine state and the same n always produce the same bytes.
  render(outL, outR, n = outL.length, gain = 1) {
    for (let i = 0; i < n; i++) {
      this._phase += this.nativeRate;
      while (this._phase >= this.sampleRate) { this._phase -= this.sampleRate; this._generate(); }
      outL[i] = this._curL * gain;
      if (outR) outR[i] = this._curR * gain;
    }
    return outL;
  }

  // Mono sum, added into an existing buffer — the shape machinemd.js uses.
  renderAddMono(out, n = out.length, gain = 0.5) {
    for (let i = 0; i < n; i++) {
      this._phase += this.nativeRate;
      while (this._phase >= this.sampleRate) { this._phase -= this.sampleRate; this._generate(); }
      out[i] += (this._curL + this._curR) * 0.5 * gain;
    }
    return out;
  }

  // ---- state ----------------------------------------------------------------
  // 8 KB of chip RAM plus the 8 KB high-byte shadow plus two offsets per voice.
  // The sample ROM is not here — it is ROM.
  getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      reg: this.reg.slice(),
      hiByte: this.hiByte.slice(),
      smpOffset: this.smpOffset.slice(),
      envOffset: this.envOffset.slice(),
      soundEnable: this.soundEnable,
      phase: this._phase,
      curL: this._curL, curR: this._curR,
    };
  }

  setState(s) {
    this.reg.set(s.reg);
    this.hiByte.set(s.hiByte);
    this.smpOffset.set(s.smpOffset);
    this.envOffset.set(s.envOffset);
    this.soundEnable = s.soundEnable | 0;
    this._phase = s.phase | 0;
    this._curL = s.curL || 0; this._curR = s.curR || 0;
    return this;
  }
}

export default X1010;
