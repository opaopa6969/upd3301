// ring-audio-worklet — the modern replacement for the deprecated
// ScriptProcessorNode audio path. It runs on the audio render thread, so a busy
// MAIN thread (heavy CRT sim / a game hammering the CPU) no longer stutters the
// sound: the worklet keeps playing from a ring buffer while it waits.
//
// Pull model, cross-thread: the chip still only advances when samples are
// pulled, but now the WORKLET pulls — when its buffer runs low it posts
// { need: N } to the main thread, which renders N samples (machine.renderAudio)
// and posts them back as { samples }. The buffer (up to ~1 s, refilled at
// ~100 ms) absorbs main-thread jank; a genuine underrun emits silence, never a
// glitch-crash. If AudioWorklet is unavailable the page falls back to the old
// ScriptProcessor path (see demo/machine.html), so nothing regresses.

class RingPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 48000;              // 1 s ring at 48 kHz
    this.buf = new Float32Array(this.size);
    this.r = 0; this.w = 0; this.filled = 0;
    this.target = 2400;             // keep ~50 ms buffered (jank cushion vs latency)
    this.pending = false;           // a request is in flight → don't spam
    this.port.onmessage = (e) => {
      const s = e.data && e.data.samples;
      this.pending = false;
      if (!s) return;
      for (let i = 0; i < s.length; i++) {
        this.buf[this.w] = s[i];
        this.w = (this.w + 1) % this.size;
        if (this.filled < this.size) this.filled++;
        else this.r = (this.r + 1) % this.size; // ring full → drop oldest
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    for (let i = 0; i < n; i++) {
      if (this.filled > 0) { out[i] = this.buf[this.r]; this.r = (this.r + 1) % this.size; this.filled--; }
      else out[i] = 0; // underrun → silence (main thread is behind; catches up)
    }
    if (this.filled < this.target && !this.pending) {
      this.pending = true;
      this.port.postMessage({ need: (this.target * 2) - this.filled });
    }
    return true;
  }
}

registerProcessor('ring-player', RingPlayer);
