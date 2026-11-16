/* Chord-capable transcription for the Tab Transcriber.
   Runs Spotify's Basic Pitch model (vendor/basic-pitch) in the browser on a finished recording and
   returns the notes it hears, several at a time if need be. The model and TensorFlow.js are a
   couple of megabytes, so they are only fetched the first time they are needed. */
(function () {
  "use strict";

  const Core = window.TabCore;
  const BASE = "vendor/basic-pitch/";
  const RATE = 22050; // what the model was trained on
  const FRAMES_PER_SECOND = RATE / 256;
  let ready = null;

  function load() {
    if (!ready) {
      ready = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = BASE + "basic-pitch.bundle.js";
        script.onload = resolve;
        script.onerror = () => reject(new Error("Could not load the chord model."));
        document.head.appendChild(script);
      }).then(async () => {
        const lib = window.BasicPitchLib;
        const model = await lib.tf.loadGraphModel(BASE + "model.json");
        return { lib, model };
      });
      // A failed download shouldn't stop a later attempt.
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  }

  async function resample(samples, sampleRate) {
    if (sampleRate === RATE) return samples;
    const length = Math.ceil((samples.length * RATE) / sampleRate);
    try {
      const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ctx = new Offline(1, length, RATE);
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
      return (await ctx.startRendering()).getChannelData(0);
    } catch (e) {
      // Browsers that can't render at this rate: average each stretch of input instead.
      const out = new Float32Array(length);
      const step = sampleRate / RATE;
      for (let i = 0; i < length; i++) {
        const from = Math.floor(i * step);
        const to = Math.min(samples.length, Math.max(from + 1, Math.floor((i + 1) * step)));
        let sum = 0;
        for (let j = from; j < to; j++) sum += samples[j];
        out[i] = sum / (to - from);
      }
      return out;
    }
  }

  /* Quiet recordings (a phone across the room) get the same treatment as loud ones. */
  function normalize(samples) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    if (peak < 0.001) return samples;
    const gain = 0.9 / peak;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
    return out;
  }

  /* samples: mono Float32Array. Resolves to notes [{ midi, start, end, amp, onset }], cleaned of
     the model's usual false alarms. onProgress gets 0..1. */
  async function transcribe(samples, sampleRate, onProgress) {
    const { lib, model } = await load();
    const audio = normalize(await resample(samples, sampleRate));
    const frames = [];
    const onsets = [];
    lib.tf.engine().startScope();
    try {
      await new lib.BasicPitch(model).evaluateModel(
        audio,
        (f, o) => {
          for (const row of f) frames.push(row);
          for (const row of o) onsets.push(row);
        },
        (p) => onProgress && onProgress(p)
      );
    } finally {
      lib.tf.engine().endScope();
    }
    if (!frames.length) return [];

    // Guitar range only: roughly low C on a dropped string up to the top of the neck.
    const found = lib.noteFramesToTime(lib.outputToNotesPoly(frames, onsets, 0.5, 0.3, 5, false, 1400, 65, true, 11));
    const notes = found.map((n) => {
      const frame = Math.round(n.startTimeSeconds * FRAMES_PER_SECOND);
      let onset = 0;
      for (let k = Math.max(0, frame - 3); k <= Math.min(onsets.length - 1, frame + 3); k++) {
        onset = Math.max(onset, onsets[k][n.pitchMidi - 21] || 0);
      }
      return {
        midi: n.pitchMidi,
        start: n.startTimeSeconds,
        end: n.startTimeSeconds + n.durationSeconds,
        amp: n.amplitude,
        onset,
      };
    });
    return Core.cleanPolyNotes(notes);
  }

  window.TabPoly = { transcribe, preload: load };
})();
