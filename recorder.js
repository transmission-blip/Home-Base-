"use strict";

/* ---------- Effect definitions ---------- */

const FX_UI = {
  dist: {
    label: "Distortion",
    types: { off: "Off", overdrive: "Overdrive", crunch: "Crunch", fuzz: "Fuzz", bitcrush: "Bitcrusher" },
    params: [
      { key: "drive", label: "Drive", min: 0, max: 1, fmt: pct },
      { key: "tone", label: "Tone", min: 0, max: 1, fmt: pct },
    ],
  },
  delay: {
    label: "Delay",
    types: { off: "Off", slapback: "Slapback", digital: "Digital", tape: "Tape echo", pingpong: "Ping-pong" },
    params: [
      { key: "time", label: "Time", min: 0.03, max: 1.2, fmt: (v) => Math.round(v * 1000) + " ms" },
      { key: "feedback", label: "Feedback", min: 0, max: 0.9, fmt: pct },
      { key: "mix", label: "Mix", min: 0, max: 1, fmt: pct },
    ],
    presets: {
      slapback: { time: 0.11, feedback: 0.1, mix: 0.5 },
      digital: { time: 0.38, feedback: 0.4, mix: 0.35 },
      tape: { time: 0.3, feedback: 0.5, mix: 0.4 },
      pingpong: { time: 0.25, feedback: 0.5, mix: 0.4 },
    },
  },
  reverb: {
    label: "Reverb",
    types: { off: "Off", room: "Room", hall: "Hall", plate: "Plate", spring: "Spring" },
    params: [
      { key: "decay", label: "Decay", min: 0, max: 1, step: 0.05, fmt: pct },
      { key: "mix", label: "Mix", min: 0, max: 1, fmt: pct },
    ],
  },
};

function pct(v) {
  return Math.round(v * 100) + "%";
}

function defaultFx() {
  return {
    dist: { type: "off", drive: 0.5, tone: 0.6 },
    delay: { type: "off", time: 0.35, feedback: 0.35, mix: 0.35 },
    reverb: { type: "off", decay: 0.5, mix: 0.3 },
  };
}

const TRACK_COLORS = ["#4caf7d", "#5aa9e6", "#e0a83a", "#c77dff", "#ef767a", "#49dcb1", "#f4a261", "#8ecae6"];
const TAIL_SECONDS = 3;

/* ---------- Distortion curves ---------- */

function distCurve(type, amount) {
  const n = type === "bitcrush" ? 65536 : 4096;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    let y = x;
    if (type === "overdrive") {
      const k = 1 + amount * 20;
      y = Math.tanh(k * x) / Math.tanh(k);
    } else if (type === "crunch") {
      // Asymmetric clipping, like a pushed tube stage
      const k = 2 + amount * 30;
      y = x >= 0 ? Math.tanh(k * x) : 0.8 * Math.tanh(0.5 * k * x);
    } else if (type === "fuzz") {
      const k = 10 + amount * 150;
      y = Math.sign(x) * (1 - Math.exp(-k * Math.abs(x)));
    } else if (type === "bitcrush") {
      const levels = Math.pow(2, 8 - amount * 6) / 2;
      y = Math.round(x * levels) / levels;
    }
    curve[i] = y;
  }
  return curve;
}

function distPostGain(type, amount) {
  if (type === "fuzz") return 0.35;
  if (type === "bitcrush") return 1;
  return 0.6 / (1 + 2 * amount);
}

function toneFreq(tone) {
  return 400 * Math.pow(50, tone); // 400 Hz .. 20 kHz
}

/* ---------- Reverb impulse responses (generated, no samples needed) ---------- */

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const irCache = new Map();

function getIR(type, decay, sampleRate) {
  const key = type + "|" + decay.toFixed(2) + "|" + sampleRate;
  if (irCache.has(key)) return irCache.get(key);

  const cfg = {
    room: { rt: 0.3 + decay * 0.9, pre: 0.005, fade: 0.002, a0: 0.9, a1: 0.25 },
    hall: { rt: 1.5 + decay * 3.5, pre: 0.025, fade: 0.04, a0: 0.7, a1: 0.12 },
    plate: { rt: 0.8 + decay * 2.2, pre: 0, fade: 0.001, a0: 1, a1: 0.5 },
    spring: { rt: 1 + decay * 2, pre: 0, fade: 0.001, a0: 0.5, a1: 0.2 },
  }[type];

  const len = Math.ceil((cfg.rt + cfg.pre) * sampleRate);
  const buf = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate });
  const pre = Math.floor(cfg.pre * sampleRate);

  for (let ch = 0; ch < 2; ch++) {
    const rand = mulberry32(1234 + ch * 77 + type.length * 13);
    const d = buf.getChannelData(ch);
    let lp = 0;
    const noiseLevel = type === "spring" ? 0.25 : 1;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sampleRate;
      const env = Math.exp((-6.9 * t) / cfg.rt) * Math.min(1, t / cfg.fade);
      // One-pole lowpass that closes over time: highs die faster than lows
      const a = cfg.a0 + (cfg.a1 - cfg.a0) * Math.min(1, t / cfg.rt);
      lp += a * (rand() * 2 - 1 - lp);
      d[i] = lp * env * noiseLevel;
    }

    if (type === "room") {
      // A few discrete early reflections off nearby walls
      const taps = ch === 0 ? [0.007, 0.013, 0.021, 0.034, 0.047] : [0.009, 0.016, 0.025, 0.031, 0.052];
      taps.forEach((tt, k) => {
        const idx = pre + Math.floor(tt * sampleRate);
        if (idx < len) d[idx] += (k % 2 ? -1 : 1) * 0.7 * Math.pow(0.8, k);
      });
    }

    if (type === "spring") {
      // Springs are dispersive: each bounce arrives as a short upward chirp
      const period = ch === 0 ? 0.037 : 0.041;
      const chirpLen = Math.floor(0.028 * sampleRate);
      for (let k = 0; k * period < cfg.rt; k++) {
        const start = Math.floor(k * period * sampleRate);
        const amp = Math.exp((-6.9 * k * period) / cfg.rt) * (k % 2 ? -1 : 1);
        let phase = 0;
        for (let j = 0; j < chirpLen && start + j < len; j++) {
          const p = j / chirpLen;
          phase += (2 * Math.PI * (300 + 3700 * p * p)) / sampleRate;
          d[start + j] += Math.sin(phase) * amp * Math.sin(Math.PI * p) * 0.6;
        }
      }
    }
  }

  irCache.set(key, buf);
  return buf;
}

/* ---------- Effect chain: distortion -> delay -> reverb ---------- */

function buildFx(ctx, fx) {
  const nodes = [];
  const oscs = [];
  const mk = (n) => (nodes.push(n), n);
  const gain = (v) => {
    const g = mk(ctx.createGain());
    g.gain.value = v;
    return g;
  };
  const filter = (type, freq) => {
    const f = mk(ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = freq;
    return f;
  };

  const input = gain(1);
  const output = gain(1);
  let head = input;
  const P = {};

  if (fx.dist.type !== "off") {
    const shaper = mk(ctx.createWaveShaper());
    shaper.oversample = fx.dist.type === "bitcrush" ? "none" : "4x";
    const dcBlock = filter("highpass", 30);
    const tone = filter("lowpass", 8000);
    const post = gain(1);
    head.connect(shaper);
    shaper.connect(dcBlock);
    dcBlock.connect(tone);
    tone.connect(post);
    head = post;
    Object.assign(P, { shaper, tone, post });
  }

  if (fx.delay.type !== "off") {
    const type = fx.delay.type;
    const out = gain(1);
    const wet = gain(0);
    head.connect(out);
    wet.connect(out);
    P.wet = wet;
    P.delays = [];
    P.fbs = [];

    const mkDelay = () => {
      const d = mk(ctx.createDelay(2));
      d.channelCount = type === "pingpong" ? 1 : 2;
      d.channelCountMode = type === "pingpong" ? "explicit" : "max";
      P.delays.push(d);
      return d;
    };
    const mkFb = () => {
      const g = gain(0);
      P.fbs.push(g);
      return g;
    };

    if (type === "pingpong") {
      const dL = mkDelay();
      const dR = mkDelay();
      const fbL = mkFb();
      const fbR = mkFb();
      const panL = mk(ctx.createStereoPanner());
      const panR = mk(ctx.createStereoPanner());
      panL.pan.value = -1;
      panR.pan.value = 1;
      head.connect(dL);
      dL.connect(fbL);
      fbL.connect(dR);
      dR.connect(fbR);
      fbR.connect(dL);
      dL.connect(panL);
      dR.connect(panR);
      panL.connect(wet);
      panR.connect(wet);
    } else {
      const d = mkDelay();
      const fb = mkFb();
      head.connect(d);
      d.connect(wet);
      let loop = d;
      if (type === "tape") {
        // Each repeat gets darker and thinner, with a little wow on the "tape speed"
        const lp = filter("lowpass", 2200);
        const hp = filter("highpass", 150);
        loop.connect(lp);
        lp.connect(hp);
        loop = hp;
        const lfo = mk(ctx.createOscillator());
        lfo.frequency.value = 0.45;
        const depth = gain(0.0015);
        lfo.connect(depth);
        depth.connect(d.delayTime);
        lfo.start();
        oscs.push(lfo);
      } else if (type === "slapback") {
        const lp = filter("lowpass", 5000);
        loop.connect(lp);
        loop = lp;
      }
      loop.connect(fb);
      fb.connect(d);
    }
    head = out;
  }

  if (fx.reverb.type !== "off") {
    const out = gain(1);
    const dry = gain(1);
    const wet = gain(0);
    const conv = mk(ctx.createConvolver());
    head.connect(dry);
    dry.connect(out);
    head.connect(conv);
    conv.connect(wet);
    wet.connect(out);
    head = out;
    Object.assign(P, { conv, revDry: dry, revWet: wet });
  }

  head.connect(output);

  let first = true;
  let irKey = "";
  let curveKey = "";
  function set(fx) {
    const sp = (param, v) => {
      if (first) param.value = v;
      else param.setTargetAtTime(v, ctx.currentTime, 0.02);
    };
    if (P.shaper) {
      const key = fx.dist.type + fx.dist.drive;
      if (key !== curveKey) {
        P.shaper.curve = distCurve(fx.dist.type, fx.dist.drive);
        curveKey = key;
      }
      sp(P.tone.frequency, toneFreq(fx.dist.tone));
      sp(P.post.gain, distPostGain(fx.dist.type, fx.dist.drive));
    }
    if (P.wet) {
      P.delays.forEach((d) => sp(d.delayTime, fx.delay.time));
      P.fbs.forEach((g) => sp(g.gain, fx.delay.feedback));
      sp(P.wet.gain, fx.delay.mix);
    }
    if (P.conv) {
      const key = fx.reverb.type + fx.reverb.decay;
      if (key !== irKey) {
        P.conv.buffer = getIR(fx.reverb.type, fx.reverb.decay, ctx.sampleRate);
        irKey = key;
      }
      sp(P.revDry.gain, 1 - 0.6 * fx.reverb.mix);
      sp(P.revWet.gain, 1.4 * fx.reverb.mix);
    }
    first = false;
  }
  set(fx);

  function dispose() {
    oscs.forEach((o) => {
      try {
        o.stop();
      } catch (e) {}
    });
    nodes.forEach((n) => n.disconnect());
  }

  return { input, output, set, dispose };
}

function fxTypes(fx) {
  return fx.dist.type + "/" + fx.delay.type + "/" + fx.reverb.type;
}

/* A full track strip: fx -> volume -> pan -> destination */
function buildStrip(ctx, track, dest, anySolo) {
  const fx = buildFx(ctx, track.fx);
  const vol = ctx.createGain();
  const pan = ctx.createStereoPanner();
  vol.gain.value = audibleGain(track, anySolo);
  pan.pan.value = track.pan;
  fx.output.connect(vol);
  vol.connect(pan);
  pan.connect(dest);
  return { fx, vol, pan, types: fxTypes(track.fx) };
}

function buildMaster(ctx, level) {
  const gain = ctx.createGain();
  gain.gain.value = level;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  gain.connect(limiter);
  limiter.connect(ctx.destination);
  return gain;
}

function audibleGain(track, anySolo) {
  return track.mute || (anySolo && !track.solo) ? 0 : track.volume;
}

/* ---------- State ---------- */

const $ = (id) => document.getElementById(id);
const els = {
  tracks: $("tracks"),
  empty: $("empty"),
  time: $("time"),
  status: $("status"),
  play: $("playBtn"),
  stop: $("stopBtn"),
  rec: $("recBtn"),
  rewind: $("rewindBtn"),
  metroOn: $("metroOn"),
  countIn: $("countIn"),
  bpm: $("bpm"),
  master: $("master"),
  micBtn: $("micBtn"),
  meter: $("inputMeter"),
  device: $("deviceSelect"),
  monitor: $("monitor"),
  latency: $("latency"),
  importBtn: $("importBtn"),
  file: $("fileInput"),
  exportBtn: $("exportBtn"),
  newBtn: $("newBtn"),
};

const tracks = []; // { id, name, buffer, offset, volume, pan, mute, solo, fx, color, nodes, source, el }
const state = {
  playing: false,
  recording: false,
  startCtxTime: 0,
  startPos: 0,
  pos: 0,
  viewDur: 15,
  nextBeat: 0,
};

let ctx = null;
let master = null;
let clickBus = null;
let mic = null; // { stream, source, analyser, recorder, monitor, meterBuf }
let rec = null; // in-progress recording: { chunksL, chunksR, peaks, frames, startPos, el, canvas, done }
let nextId = 1;

function setStatus(msg, isError) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("error", !!isError);
}

function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    master = buildMaster(ctx, Number(els.master.value));
    clickBus = ctx.createGain();
    clickBus.gain.value = 0.5;
    clickBus.connect(ctx.destination);
    tracks.forEach(attachStrip);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function anySolo() {
  return tracks.some((t) => t.solo);
}

function attachStrip(track) {
  if (!ctx) return;
  if (track.nodes) {
    track.nodes.fx.dispose();
    track.nodes.vol.disconnect();
    track.nodes.pan.disconnect();
  }
  track.nodes = buildStrip(ctx, track, master, anySolo());
  if (track.source) track.source.connect(track.nodes.fx.input);
}

function refreshGains() {
  const solo = anySolo();
  tracks.forEach((t) => {
    if (t.nodes) t.nodes.vol.gain.setTargetAtTime(audibleGain(t, solo), ctx.currentTime, 0.015);
  });
}

function fxChanged(track) {
  if (track.nodes) {
    if (track.nodes.types !== fxTypes(track.fx)) attachStrip(track);
    else track.nodes.fx.set(track.fx);
  }
  saveMeta();
}

function projectLength() {
  return tracks.reduce((m, t) => Math.max(m, t.offset + t.buffer.duration), 0);
}

function currentPos() {
  if (!state.playing) return state.pos;
  return state.startPos + Math.max(0, ctx.currentTime - state.startCtxTime);
}

function beatLen() {
  const bpm = Math.min(240, Math.max(40, Number(els.bpm.value) || 100));
  return 60 / bpm;
}

/* ---------- Transport ---------- */

function startSources(t0, pos) {
  tracks.forEach((t) => {
    stopSource(t);
    const end = t.offset + t.buffer.duration;
    if (pos >= end) return;
    const src = ctx.createBufferSource();
    src.buffer = t.buffer;
    src.connect(t.nodes.fx.input);
    if (pos < t.offset) src.start(t0 + (t.offset - pos), 0);
    else src.start(t0, pos - t.offset);
    t.source = src;
  });
}

function stopSource(t) {
  if (t.source) {
    try {
      t.source.stop();
    } catch (e) {}
    t.source.disconnect();
    t.source = null;
  }
}

function beginTransport(t0, pos) {
  state.playing = true;
  state.startCtxTime = t0;
  state.startPos = pos;
  state.nextBeat = Math.ceil(pos / beatLen() - 1e-6);
  startSources(t0, pos);
  updateTransportUi();
}

function play() {
  if (state.playing) return;
  if (!tracks.length) {
    setStatus("Record or import a track first.");
    return;
  }
  ensureCtx();
  if (state.pos >= projectLength() - 0.05) state.pos = 0;
  setStatus("");
  beginTransport(ctx.currentTime + 0.06, state.pos);
}

async function stop() {
  if (!state.playing) return;
  state.pos = currentPos();
  state.playing = false;
  tracks.forEach(stopSource);
  if (state.recording) await finishRecording();
  updateTransportUi();
}

function seek(pos) {
  if (state.recording) return;
  pos = Math.max(0, pos);
  if (state.playing) {
    state.playing = false;
    state.pos = pos;
    beginTransport(ctx.currentTime + 0.05, pos);
  } else {
    state.pos = pos;
  }
}

function updateTransportUi() {
  els.play.classList.toggle("active", state.playing && !state.recording);
  els.rec.classList.toggle("active", state.recording);
}

/* ---------- Metronome ---------- */

function click(time, accent) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = accent ? 1600 : 1100;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(1, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  osc.connect(g);
  g.connect(clickBus);
  osc.start(time);
  osc.stop(time + 0.06);
}

setInterval(() => {
  if (!state.playing || !els.metroOn.checked) return;
  const beat = beatLen();
  for (;;) {
    const t = state.startCtxTime + state.nextBeat * beat - state.startPos;
    if (t > ctx.currentTime + 0.12) break;
    if (t >= ctx.currentTime) click(t, state.nextBeat % 4 === 0);
    state.nextBeat++;
  }
}, 25);

/* ---------- Microphone ---------- */

const RECORDER_WORKLET = `
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
`;

let workletReady = null;

async function ensureMic(deviceId) {
  ensureCtx();
  if (mic && !deviceId) return mic;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !ctx.audioWorklet) {
    throw new Error("This browser can't record audio here (needs HTTPS and a modern browser).");
  }
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (deviceId) audio.deviceId = { exact: deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio });

  if (!workletReady) {
    const url = URL.createObjectURL(new Blob([RECORDER_WORKLET], { type: "application/javascript" }));
    workletReady = ctx.audioWorklet.addModule(url);
  }
  await workletReady;

  if (mic) {
    mic.source.disconnect();
    mic.stream.getTracks().forEach((t) => t.stop());
  }

  const source = ctx.createMediaStreamSource(stream);
  const analyser = (mic && mic.analyser) || ctx.createAnalyser();
  analyser.fftSize = 1024;
  let recorder = mic && mic.recorder;
  let monitor = mic && mic.monitor;
  if (!recorder) {
    recorder = new AudioWorkletNode(ctx, "take-recorder");
    const sink = ctx.createGain();
    sink.gain.value = 0;
    recorder.connect(sink);
    sink.connect(ctx.destination);
    recorder.port.onmessage = onRecorderMessage;
    monitor = ctx.createGain();
    monitor.gain.value = els.monitor.checked ? 1 : 0;
    monitor.connect(ctx.destination);
  }
  source.connect(analyser);
  source.connect(recorder);
  source.connect(monitor);
  mic = { stream, source, analyser, recorder, monitor, meterBuf: new Float32Array(analyser.fftSize) };

  if (localStorage.getItem("hb-latency") === null) {
    const settings = stream.getAudioTracks()[0].getSettings();
    const total = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + (settings.latency || 0);
    els.latency.value = Math.min(500, Math.round(total * 1000));
  }

  els.micBtn.textContent = "Microphone on";
  els.micBtn.disabled = true;
  listDevices(stream);
  return mic;
}

async function listDevices(stream) {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    if (devices.length < 2) return;
    const current = stream.getAudioTracks()[0].getSettings().deviceId;
    els.device.innerHTML = "";
    devices.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || "Input " + (i + 1);
      opt.selected = d.deviceId === current;
      els.device.appendChild(opt);
    });
    els.device.hidden = false;
  } catch (e) {}
}

/* ---------- Recording ---------- */

function onRecorderMessage(e) {
  if (!rec) return;
  if (e.data.done) {
    rec.done();
    return;
  }
  const { l, r } = e.data;
  rec.chunksL.push(l);
  rec.chunksR.push(r);
  rec.frames += l.length;
  let peak = 0;
  for (let i = 0; i < l.length; i++) {
    const v = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    if (v > peak) peak = v;
  }
  rec.peaks.push(peak);
}

let arming = false;

async function record() {
  if (state.recording) return stop();
  if (arming) return;
  arming = true;
  try {
    if (state.playing) await stop();
    await ensureMic();
  } catch (err) {
    setStatus(micErrorMessage(err), true);
    return;
  } finally {
    arming = false;
  }

  const pos = state.pos;
  const beat = beatLen();
  const countBeats = els.countIn.checked ? 4 : 0;
  const t0 = ctx.currentTime + 0.15 + countBeats * beat;
  for (let k = countBeats; k >= 1; k--) click(t0 - k * beat, k === countBeats);

  rec = { chunksL: [], chunksR: [], peaks: [], frames: 0, startPos: pos, done: null };
  mic.recorder.port.postMessage({ cmd: "start", frame: Math.round(t0 * ctx.sampleRate) });
  state.recording = true;
  beginTransport(t0, pos);
  renderRecLane();
  setStatus(countBeats ? "Count-in…" : "Recording…");
}

async function finishRecording() {
  const take = rec;
  await new Promise((resolve) => {
    take.done = resolve;
    mic.recorder.port.postMessage({ cmd: "stop" });
    setTimeout(resolve, 500); // never hang if the worklet is unresponsive
  });
  state.recording = false;
  rec = null;
  if (take.el) take.el.remove();

  const sr = ctx.sampleRate;
  const skip = Math.round((Math.max(0, Number(els.latency.value) || 0) / 1000) * sr);
  const len = take.frames - skip;
  if (len < sr * 0.2) {
    setStatus("Take was too short — nothing saved.");
    updateEmpty();
    return;
  }

  const L = flatten(take.chunksL, take.frames);
  const R = flatten(take.chunksR, take.frames);
  let sumL = 0;
  let sumR = 0;
  for (let i = 0; i < take.frames; i++) {
    sumL += L[i] * L[i];
    sumR += R[i] * R[i];
  }
  // Audio interfaces often put the instrument on just one input: use whichever side has signal
  const mono = new Float32Array(len);
  const useL = sumR < sumL * 0.003;
  const useR = sumL < sumR * 0.003;
  for (let i = 0; i < len; i++) {
    const a = L[i + skip];
    const b = R[i + skip];
    mono[i] = useL ? a : useR ? b : (a + b) / 2;
  }

  const buffer = new AudioBuffer({ length: len, numberOfChannels: 1, sampleRate: sr });
  buffer.copyToChannel(mono, 0);
  addTrack({ name: "Track " + nextId, buffer, offset: take.startPos });
  state.pos = take.startPos;
  setStatus(sumL + sumR < 1e-7 ? "Saved, but the take is silent — check your input device." : "Take saved.");
}

function flatten(chunks, total) {
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function micErrorMessage(err) {
  if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
    return "Microphone access was blocked. Allow it in your browser's site settings.";
  }
  if (err && (err.name === "NotFoundError" || err.name === "OverconstrainedError")) {
    return "No microphone or audio input was found.";
  }
  return (err && err.message) || "Couldn't start the microphone.";
}

/* ---------- Tracks ---------- */

function addTrack({ id, name, buffer, offset = 0, volume = 0.8, pan = 0, mute = false, solo = false, fx, color }, skipSave) {
  const track = {
    id: id || nextId,
    name,
    buffer,
    offset,
    volume,
    pan,
    mute,
    solo,
    fx: fx || defaultFx(),
    color: color || TRACK_COLORS[(id || nextId) % TRACK_COLORS.length],
    nodes: null,
    source: null,
    el: null,
  };
  nextId = Math.max(nextId, track.id) + 1;
  tracks.push(track);
  attachStrip(track);
  renderTrack(track);
  updateEmpty();
  fitView();
  if (!skipSave) {
    saveAudio(track);
    saveMeta();
  }
  return track;
}

function removeTrack(track) {
  stopSource(track);
  if (track.nodes) {
    track.nodes.fx.dispose();
    track.nodes.vol.disconnect();
    track.nodes.pan.disconnect();
  }
  tracks.splice(tracks.indexOf(track), 1);
  track.el.remove();
  refreshGains();
  updateEmpty();
  fitView();
  deleteAudio(track.id);
  saveMeta();
}

function updateEmpty() {
  els.empty.hidden = tracks.length > 0 || state.recording;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function rangeInput(min, max, step, value) {
  const r = el("input");
  r.type = "range";
  r.min = min;
  r.max = max;
  r.step = step;
  r.value = value;
  return r;
}

function renderTrack(track) {
  const root = el("div", "track");
  root.style.setProperty("--track-color", track.color);
  const main = el("div", "track-main");
  const head = el("div", "track-head");

  const top = el("div", "track-top");
  const name = el("input", "track-name");
  name.value = track.name;
  name.setAttribute("aria-label", "Track name");
  name.addEventListener("change", () => {
    track.name = name.value.trim() || "Track " + track.id;
    name.value = track.name;
    saveMeta();
  });
  const mute = el("button", "chip mute", "M");
  mute.title = "Mute";
  mute.classList.toggle("on", track.mute);
  mute.addEventListener("click", () => {
    track.mute = !track.mute;
    mute.classList.toggle("on", track.mute);
    refreshGains();
    saveMeta();
  });
  const solo = el("button", "chip solo", "S");
  solo.title = "Solo";
  solo.classList.toggle("on", track.solo);
  solo.addEventListener("click", () => {
    track.solo = !track.solo;
    solo.classList.toggle("on", track.solo);
    refreshGains();
    saveMeta();
  });
  const del = el("button", "chip del", "✕");
  del.title = "Delete track";
  del.addEventListener("click", () => {
    if (confirm('Delete "' + track.name + '"? This can\'t be undone.')) removeTrack(track);
  });
  top.append(name, mute, solo, del);

  const volRow = el("label", "row");
  const vol = rangeInput(0, 1.5, 0.01, track.volume);
  vol.addEventListener("input", () => {
    track.volume = Number(vol.value);
    refreshGains();
    saveMeta();
  });
  volRow.append(el("span", "", "Vol"), vol);

  const panRow = el("label", "row");
  const pan = rangeInput(-1, 1, 0.05, track.pan);
  pan.addEventListener("input", () => {
    track.pan = Number(pan.value);
    if (track.nodes) track.nodes.pan.pan.setTargetAtTime(track.pan, ctx.currentTime, 0.015);
    saveMeta();
  });
  pan.addEventListener("dblclick", () => {
    pan.value = 0;
    pan.dispatchEvent(new Event("input"));
  });
  panRow.append(el("span", "", "Pan"), pan);

  head.append(top, volRow, panRow);

  const lane = el("div", "lane");
  const canvas = el("canvas");
  const playhead = el("div", "playhead");
  lane.append(canvas, playhead);
  lane.addEventListener("click", (e) => {
    const rect = lane.getBoundingClientRect();
    seek(((e.clientX - rect.left) / rect.width) * state.viewDur);
  });

  main.append(head, lane);

  const fxRow = el("div", "fx");
  Object.keys(FX_UI).forEach((kind) => fxRow.append(renderFxBlock(track, kind)));

  root.append(main, fxRow);
  track.el = root;
  track.canvas = canvas;
  track.playhead = playhead;
  els.tracks.append(root);
  drawWave(track);
}

function renderFxBlock(track, kind) {
  const ui = FX_UI[kind];
  const settings = track.fx[kind];
  const block = el("div", "fx-block");
  block.classList.toggle("on", settings.type !== "off");

  const title = el("div", "fx-title");
  const select = el("select");
  select.setAttribute("aria-label", ui.label + " type");
  Object.entries(ui.types).forEach(([value, label]) => {
    const opt = el("option", "", label);
    opt.value = value;
    opt.selected = value === settings.type;
    select.append(opt);
  });
  title.append(el("span", "", ui.label), select);
  block.append(title);

  const controls = {};
  ui.params.forEach((p) => {
    const row = el("label", "fx-param");
    const slider = rangeInput(p.min, p.max, p.step || 0.01, settings[p.key]);
    const val = el("span", "fx-val", p.fmt(settings[p.key]));
    slider.addEventListener("input", () => {
      settings[p.key] = Number(slider.value);
      val.textContent = p.fmt(settings[p.key]);
      fxChanged(track);
    });
    controls[p.key] = { slider, val, fmt: p.fmt };
    row.append(el("span", "", p.label), slider, val);
    block.append(row);
  });

  select.addEventListener("change", () => {
    settings.type = select.value;
    const preset = ui.presets && ui.presets[select.value];
    if (preset) {
      Object.entries(preset).forEach(([key, v]) => {
        settings[key] = v;
        controls[key].slider.value = v;
        controls[key].val.textContent = controls[key].fmt(v);
      });
    }
    block.classList.toggle("on", settings.type !== "off");
    fxChanged(track);
  });

  return block;
}

function renderRecLane() {
  const root = el("div", "track recording");
  const main = el("div", "track-main");
  const head = el("div", "track-head");
  head.append(el("div", "rec-label", "● Recording"));
  const lane = el("div", "lane");
  const canvas = el("canvas");
  lane.append(canvas);
  main.append(head, lane);
  root.append(main);
  els.tracks.append(root);
  rec.el = root;
  rec.canvas = canvas;
  updateEmpty();
  root.scrollIntoView({ block: "nearest" });
}

/* ---------- Waveforms ---------- */

function sizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas.getContext("2d");
}

function drawWave(track) {
  const canvas = track.canvas;
  const g = sizeCanvas(canvas);
  const W = canvas.width;
  const H = canvas.height;
  g.clearRect(0, 0, W, H);
  const data = track.buffer.getChannelData(0);
  const sr = track.buffer.sampleRate;
  const x0 = (track.offset / state.viewDur) * W;
  const perPx = (state.viewDur * sr) / W;
  const stride = Math.max(1, Math.floor(perPx / 48));
  const mid = H / 2;
  g.fillStyle = track.color;
  const cols = Math.ceil(data.length / perPx);
  for (let c = 0; c < cols; c++) {
    const from = Math.floor(c * perPx);
    const to = Math.min(data.length, Math.floor((c + 1) * perPx));
    let lo = 0;
    let hi = 0;
    for (let i = from; i < to; i += stride) {
      const v = data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const top = mid - hi * mid * 0.95;
    const bottom = mid - lo * mid * 0.95;
    g.fillRect(x0 + c, top, 1, Math.max(1, bottom - top));
  }
}

function drawRecLane() {
  const g = sizeCanvas(rec.canvas);
  const W = rec.canvas.width;
  const H = rec.canvas.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = "#d9534f";
  const secPerPeak = 2048 / ctx.sampleRate;
  const pxPerPeak = (secPerPeak / state.viewDur) * W;
  const x0 = (rec.startPos / state.viewDur) * W;
  const mid = H / 2;
  for (let i = 0; i < rec.peaks.length; i++) {
    const h = Math.max(1, rec.peaks[i] * H * 0.95);
    g.fillRect(x0 + i * pxPerPeak, mid - h / 2, Math.max(1, pxPerPeak), h);
  }
}

function fitView() {
  const want = Math.max(15, projectLength() * 1.05);
  if (want !== state.viewDur) {
    state.viewDur = want;
    tracks.forEach(drawWave);
  }
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => tracks.forEach(drawWave), 150);
});

/* ---------- Animation loop ---------- */

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m + ":" + (rest < 10 ? "0" : "") + rest.toFixed(1);
}

function tick() {
  const pos = currentPos();

  if (state.playing && !state.recording && pos >= projectLength() + 0.2) {
    stop().then(() => (state.pos = 0));
  }
  if (state.recording) {
    if (ctx.currentTime >= state.startCtxTime && els.status.textContent === "Count-in…") setStatus("Recording…");
    if (pos > state.viewDur - 2) {
      state.viewDur *= 1.5;
      tracks.forEach(drawWave);
    }
    drawRecLane();
  }

  els.time.textContent = fmtTime(pos);
  const leftPct = Math.min(100, (pos / state.viewDur) * 100) + "%";
  tracks.forEach((t) => (t.playhead.style.left = leftPct));

  if (mic) {
    mic.analyser.getFloatTimeDomainData(mic.meterBuf);
    let peak = 0;
    for (let i = 0; i < mic.meterBuf.length; i++) peak = Math.max(peak, Math.abs(mic.meterBuf[i]));
    const db = 20 * Math.log10(peak || 1e-6);
    els.meter.style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + "%";
    els.meter.style.background = peak > 0.95 ? "var(--accent-bad)" : peak > 0.6 ? "var(--accent-warn)" : "var(--accent)";
  }

  requestAnimationFrame(tick);
}

/* ---------- Import / export ---------- */

async function importFiles(files) {
  ensureCtx();
  for (const file of files) {
    try {
      const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
      addTrack({ name: file.name.replace(/\.[^.]+$/, "").slice(0, 40), buffer, offset: 0 });
      setStatus("Imported " + file.name);
    } catch (e) {
      setStatus("Couldn't read " + file.name + " as audio.", true);
    }
  }
}

async function renderMix() {
  const sr = ctx ? ctx.sampleRate : 44100;
  const length = Math.ceil((projectLength() + TAIL_SECONDS) * sr);
  const off = new OfflineAudioContext(2, length, sr);
  const bus = buildMaster(off, Number(els.master.value));
  const solo = anySolo();
  tracks.forEach((t) => {
    if (audibleGain(t, solo) === 0) return;
    const strip = buildStrip(off, t, bus, solo);
    const src = off.createBufferSource();
    src.buffer = t.buffer;
    src.connect(strip.fx.input);
    src.start(t.offset);
  });
  return off.startRendering();
}

function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = frames * channels * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, bytes, true);
  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view], { type: "audio/wav" });
}

async function exportMix() {
  if (!tracks.length) {
    setStatus("Nothing to export yet.");
    return;
  }
  els.exportBtn.disabled = true;
  setStatus("Rendering mix…");
  try {
    const blob = encodeWav(await renderMix());
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "home-base-mix.wav";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    setStatus("Mix exported.");
  } catch (e) {
    setStatus("Export failed: " + e.message, true);
  }
  els.exportBtn.disabled = false;
}

/* ---------- Persistence: settings in localStorage, audio in IndexedDB ---------- */

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("home-base-recorder", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("audio", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function audioStore(mode, fn) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction("audio", mode);
      const req = fn(tx.objectStore("audio"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    setStatus("Couldn't save to this browser's storage — export your mix before closing the tab.", true);
    return null;
  }
}

function saveAudio(track) {
  const channels = [];
  for (let c = 0; c < track.buffer.numberOfChannels; c++) channels.push(track.buffer.getChannelData(c).slice());
  return audioStore("readwrite", (s) => s.put({ id: track.id, sampleRate: track.buffer.sampleRate, channels }));
}

function deleteAudio(id) {
  return audioStore("readwrite", (s) => s.delete(id));
}

let metaTimer = null;
function saveMeta() {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(writeMeta, 200);
}

function writeMeta() {
  const meta = {
    bpm: els.bpm.value,
    metro: els.metroOn.checked,
    countIn: els.countIn.checked,
    master: els.master.value,
    tracks: tracks.map(({ id, name, offset, volume, pan, mute, solo, fx, color }) => ({
      id, name, offset, volume, pan, mute, solo, fx, color,
    })),
  };
  try {
    localStorage.setItem("hb-project", JSON.stringify(meta));
  } catch (e) {}
}

async function loadProject() {
  const latency = localStorage.getItem("hb-latency");
  if (latency !== null) els.latency.value = latency;
  let meta = null;
  try {
    meta = JSON.parse(localStorage.getItem("hb-project"));
  } catch (e) {}
  if (!meta) return;
  els.bpm.value = meta.bpm || 100;
  els.metroOn.checked = !!meta.metro;
  els.countIn.checked = !!meta.countIn;
  els.master.value = meta.master || 1;
  for (const m of meta.tracks || []) {
    const stored = await audioStore("readonly", (s) => s.get(m.id));
    if (!stored || !stored.channels || !stored.channels[0] || !stored.channels[0].length) continue;
    const buffer = new AudioBuffer({
      length: stored.channels[0].length,
      numberOfChannels: stored.channels.length,
      sampleRate: stored.sampleRate,
    });
    stored.channels.forEach((ch, c) => buffer.copyToChannel(ch, c));
    const fx = defaultFx();
    Object.keys(fx).forEach((k) => Object.assign(fx[k], m.fx && m.fx[k]));
    addTrack({ ...m, buffer, fx }, true);
  }
}

/* ---------- Wiring ---------- */

els.play.addEventListener("click", () => (state.playing ? stop() : play()));
els.stop.addEventListener("click", stop);
els.rec.addEventListener("click", record);
els.rewind.addEventListener("click", () => seek(0));
els.master.addEventListener("input", () => {
  if (master) master.gain.setTargetAtTime(Number(els.master.value), ctx.currentTime, 0.015);
  saveMeta();
});
[els.bpm, els.metroOn, els.countIn].forEach((e) => e.addEventListener("change", saveMeta));
els.latency.addEventListener("change", () => localStorage.setItem("hb-latency", els.latency.value));
els.monitor.addEventListener("change", async () => {
  if (els.monitor.checked && !mic) {
    try {
      await ensureMic();
    } catch (err) {
      els.monitor.checked = false;
      setStatus(micErrorMessage(err), true);
      return;
    }
  }
  if (mic) mic.monitor.gain.setTargetAtTime(els.monitor.checked ? 1 : 0, ctx.currentTime, 0.015);
});
els.micBtn.addEventListener("click", () => {
  ensureMic().then(
    () => setStatus("Microphone ready."),
    (err) => setStatus(micErrorMessage(err), true)
  );
});
els.device.addEventListener("change", () => {
  if (state.recording) return;
  ensureMic(els.device.value).catch((err) => setStatus(micErrorMessage(err), true));
});
els.importBtn.addEventListener("click", () => els.file.click());
els.file.addEventListener("change", () => {
  importFiles([...els.file.files]);
  els.file.value = "";
});
els.exportBtn.addEventListener("click", exportMix);
els.newBtn.addEventListener("click", async () => {
  if (!tracks.length) return;
  if (!confirm("Start a new project? All " + tracks.length + " track(s) will be deleted.")) return;
  await stop();
  [...tracks].forEach(removeTrack);
  state.pos = 0;
  setStatus("");
});

document.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  const typing = tag === "SELECT" || tag === "TEXTAREA" || (tag === "INPUT" && e.target.type !== "range" && e.target.type !== "checkbox");
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === "Space") {
    e.preventDefault();
    state.playing ? stop() : play();
  } else if (e.key === "r" || e.key === "R") {
    record();
  } else if (e.key === "Home") {
    seek(0);
  }
});

loadProject().then(() => {
  updateEmpty();
  requestAnimationFrame(tick);
});
