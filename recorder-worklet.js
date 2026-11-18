"use strict";

/* Captures microphone audio for the recorder, starting at an exact sample. */
class TakeRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.start = 0;
    this.size = 2048;
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data.cmd === "start") {
        this.on = true;
        this.start = e.data.frame;
        this.n = 0;
      } else if (e.data.cmd === "stop") {
        this.flush();
        this.on = false;
        this.port.postMessage({ done: true });
      }
    };
  }
  flush() {
    if (this.n) {
      this.port.postMessage({ l: this.l.slice(0, this.n), r: this.r.slice(0, this.n) });
      this.n = 0;
    }
  }
  process(inputs) {
    if (!this.on) return true;
    const inp = inputs[0] || [];
    const l = inp[0];
    const r = inp[1] || l;
    let from = this.start - currentFrame;
    if (from >= 128) return true;
    if (from < 0) from = 0;
    for (let i = from; i < 128; i++) {
      this.l[this.n] = l ? l[i] : 0;
      this.r[this.n] = r ? r[i] : 0;
      if (++this.n === this.size) this.flush();
    }
    return true;
  }
}
registerProcessor("take-recorder", TakeRecorder);
