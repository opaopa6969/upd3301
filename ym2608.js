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

    // ADPCM register mirrors (decoders land in later phases). Rhythm = ADPCM-A
    // ($00-$0D bank1), the delta-PCM channel = ADPCM-B ($10-$1B bank1).
    this.rhythm = { key: 0, total: 0, level: new Uint8Array(6), lr: new Uint8Array(6) };
    this.adpcmB = { ctrl: 0, lr: 0, start: 0, end: 0, limit: 0, deltaN: 0, level: 0 };
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
    // ADPCM-A rhythm ($00-$0D) — mirror now, decode later.
    if (a === 0x00) { this.rhythm.key = v; return; }
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

  getState() {
    const s = super.getState();
    s.schemaVersion = SCHEMA_VERSION;
    s.opna = {
      addr1: this.addr1,
      reg1: Array.from(this.reg1),
      rhythm: { key: this.rhythm.key, total: this.rhythm.total, level: Array.from(this.rhythm.level), lr: Array.from(this.rhythm.lr) },
      adpcmB: { ...this.adpcmB },
    };
    return s;
  }

  setState(s) {
    if (typeof super.setState === 'function') super.setState(s);
    if (s.opna) {
      this.addr1 = s.opna.addr1 | 0;
      this.reg1 = Uint8Array.from(s.opna.reg1 || []);
      if (s.opna.rhythm) { this.rhythm.key = s.opna.rhythm.key; this.rhythm.total = s.opna.rhythm.total; this.rhythm.level = Uint8Array.from(s.opna.rhythm.level); this.rhythm.lr = Uint8Array.from(s.opna.rhythm.lr); }
      if (s.opna.adpcmB) this.adpcmB = { ...s.opna.adpcmB };
    }
  }
}

export function createYm2608(opts) { return new Ym2608(opts); }
