// ring-audio-worklet — audio playback decoupled from the main thread.
//
// PUSH model: the MAIN thread renders the chip once per emulation frame (when the
// OPN registers are fresh) and posts those samples here; this worklet, living on
// the audio render thread, just drains its ring buffer to the output at 48 kHz.
// Because playback runs on the audio thread, a busy main thread (a 15 ms CRT sim,
// a game hammering the CPU) can no longer starve the callback — that was the
// ScriptProcessor's failure mode: the shared main thread was busy rendering when
// the audio buffer needed filling, so it broke up ("音が割れる").
//
// Why push and not pull: an earlier PULL worklet asked the main thread for big
// ~100 ms batches, so the main thread rendered 100 ms of sound against ONE frozen
// register snapshot and the tempo came out chunky. Push sends one ~16.7 ms frame
// at a time, each with that frame's fresh registers, so the beat stays tight.
//
// The main thread paces how much it pushes off audioCtx.currentTime, so the ring
// hovers around a small latency target; this worklet only needs to drain and
// report how full it is (so the pump can catch up after a jank without drifting).

class RingPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 48000;            // 1 s ring at 48 kHz (generous headroom)
    this.buf = new Float32Array(this.size);
    this.r = 0; this.w = 0; this.filled = 0;
    this.underruns = 0;
    this.tick = 0;
    this.port.onmessage = (e) => {
      const s = e.data && e.data.samples;
      if (!s) return;
      for (let i = 0; i < s.length; i++) {
        this.buf[this.w] = s[i];
        this.w = (this.w + 1) % this.size;
        if (this.filled < this.size) this.filled++;
        else this.r = (this.r + 1) % this.size; // ring full → drop oldest (overrun)
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    for (let i = 0; i < n; i++) {
      if (this.filled > 0) { out[i] = this.buf[this.r]; this.r = (this.r + 1) % this.size; this.filled--; }
      else { out[i] = 0; this.underruns++; } // ran dry → silence, main thread catches up
    }
    // report fill level back a few times a second so the pump can self-correct
    if ((this.tick++ & 7) === 0) this.port.postMessage({ filled: this.filled, underruns: this.underruns });
    return true;
  }
}

registerProcessor('ring-player', RingPlayer);
