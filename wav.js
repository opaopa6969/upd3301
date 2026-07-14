// wav.js — a tiny, pure PCM-WAV decoder. No deps, no I/O: bytes in, samples
// out, so it runs identically in Node (fs.readFile → Uint8Array) and the
// browser (fetch → arrayBuffer). Used to turn the OPNA rhythm-ROM WAVs
// (assets/opna-rhythm/, 16-bit mono 44.1 kHz) into the Float32Array the
// Ym2608.setRhythmRom() bus expects. Handles canonical PCM WAV (fmt 1) with
// 8/16/24/32-bit integer or 32-bit float samples; multi-channel is downmixed
// to mono (the drum ROM is mono anyway). Not a general media decoder —
// deliberately small and deterministic.

// Decode a WAV byte buffer to { rate, channels, data: Float32Array(mono) }.
export function decodeWav(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 12 || dv.getUint32(0, false) !== 0x52494646 /*RIFF*/ ||
      dv.getUint32(8, false) !== 0x57415645 /*WAVE*/) {
    throw new Error('not a RIFF/WAVE file');
  }
  let fmt = null, dataOff = -1, dataLen = 0;
  let p = 12;
  while (p + 8 <= b.length) {
    const id = dv.getUint32(p, false);
    const sz = dv.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 0x666d7420 /*'fmt '*/) {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        rate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 0x64617461 /*'data'*/) {
      dataOff = body; dataLen = sz;
    }
    p = body + sz + (sz & 1); // chunks are word-aligned
  }
  if (!fmt) throw new Error('no fmt chunk');
  if (dataOff < 0) throw new Error('no data chunk');
  dataLen = Math.min(dataLen, b.length - dataOff);

  const { channels, bits, format } = fmt;
  const isFloat = format === 3;
  const bytesPer = bits >> 3;
  const frameBytes = bytesPer * channels;
  const frames = frameBytes ? Math.floor(dataLen / frameBytes) : 0;
  const out = new Float32Array(frames);
  const norm = bits === 8 ? 128 : (1 << (bits - 1)); // 8-bit PCM is unsigned

  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const o = dataOff + f * frameBytes + c * bytesPer;
      let s;
      if (isFloat) {
        s = bits === 64 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
      } else if (bits === 8) {
        s = (dv.getUint8(o) - 128) / norm;
      } else if (bits === 16) {
        s = dv.getInt16(o, true) / norm;
      } else if (bits === 24) {
        let v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
        if (v & 0x800000) v -= 0x1000000;
        s = v / norm;
      } else if (bits === 32) {
        s = dv.getInt32(o, true) / norm;
      } else {
        throw new Error('unsupported bit depth: ' + bits);
      }
      acc += s;
    }
    out[f] = acc / channels; // downmix to mono
  }
  return { rate: fmt.rate, channels, data: out };
}
