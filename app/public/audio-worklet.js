// AudioWorklet: mono input at the context rate (44.1/48 kHz) → 16 kHz s16le frames of 640
// samples (40 ms = 1280 bytes). Frames are only produced between {cmd:"start"} and {cmd:"stop"};
// on stop the partial tail is zero-padded and flushed so the last syllable is never lost.
class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.ratio = sampleRate / 16000;      // e.g. 3 or 2.75625
    this.pos = 0;                          // fractional read position into the input
    this.carry = new Float32Array(0);      // unconsumed input samples
    this.frame = new Int16Array(640);
    this.n = 0;
    this.sumSq = 0;
    this.port.onmessage = (e) => {
      const cmd = e.data && e.data.cmd;
      if (cmd === "start") { this.active = true; this.n = 0; this.sumSq = 0; this.pos = 0; this.carry = new Float32Array(0); }
      else if (cmd === "stop") { if (this.active) this.flush(true); this.active = false; this.port.postMessage({ stopped: true }); }
    };
  }
  push(s) {
    const v = s < -1 ? -1 : s > 1 ? 1 : s;
    this.frame[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    this.sumSq += v * v;
    if (this.n === 640) this.flush(false);
  }
  flush(pad) {
    if (this.n === 0) return;
    if (pad) { for (let i = this.n; i < 640; i++) this.frame[i] = 0; }
    const count = pad ? 640 : this.n;
    const out = this.frame.slice(0, count);
    const level = Math.sqrt(this.sumSq / this.n);
    this.port.postMessage({ pcm: out.buffer, level }, [out.buffer]);
    this.n = 0; this.sumSq = 0;
  }
  process(inputs) {
    if (!this.active) return true;
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    // Concatenate the carry and the new block, then resample with a box filter over `ratio` samples.
    const buf = new Float32Array(this.carry.length + ch.length);
    buf.set(this.carry, 0); buf.set(ch, this.carry.length);
    let p = this.pos;
    const r = this.ratio;
    while (p + r <= buf.length) {
      const a = Math.floor(p), b = Math.floor(p + r);
      let sum = 0;
      for (let i = a; i < b; i++) sum += buf[i];
      this.push(sum / (b - a || 1));
      p += r;
    }
    const keepFrom = Math.floor(p);
    this.carry = buf.slice(keepFrom);
    this.pos = p - keepFrom;
    return true;
  }
}
registerProcessor("pcm16k", Pcm16k);
