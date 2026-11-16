/* Tab transcriber core: pitch detection, note tracking, fretboard placement and text export.
   No DOM in here, so it runs the same in the browser and under Node for testing. */
(function (root) {
  "use strict";

  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const STEPS_PER_BAR = 16; // one column = a sixteenth note
  const MAX_FRET = 20;

  // Open-string pitches as MIDI note numbers, low string to high.
  const TUNINGS = {
    standard: { label: "Standard (E A D G B E)", midi: [40, 45, 50, 55, 59, 64] },
    dropD: { label: "Drop D (D A D G B E)", midi: [38, 45, 50, 55, 59, 64] },
    halfDown: { label: "Half step down (Eb Ab Db Gb Bb Eb)", midi: [39, 44, 49, 54, 58, 63] },
    dadgad: { label: "DADGAD (D A D G A D)", midi: [38, 45, 50, 55, 57, 62] },
    openG: { label: "Open G (D G D G B D)", midi: [38, 43, 50, 55, 59, 62] },
    openD: { label: "Open D (D A D F# A D)", midi: [38, 45, 50, 54, 57, 62] },
    openD6: { label: "Open D6 (D A D F# A B)", midi: [38, 45, 50, 54, 57, 59] },
  };

  function pitchClass(midi) {
    return NOTE_NAMES[((midi % 12) + 12) % 12];
  }

  function midiName(midi) {
    return pitchClass(midi) + (Math.floor(midi / 12) - 1);
  }

  function midiFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function freqMidi(freq) {
    return 69 + 12 * Math.log2(freq / 440);
  }

  /* ---------- Pitch detection (YIN) ---------- */

  const scratch = {};
  function scratchArray(name, length) {
    if (!scratch[name] || scratch[name].length < length) scratch[name] = new Float32Array(length);
    return scratch[name];
  }

  /* Returns { freq, loose, rms }. freq is null when the frame is silent or has no clear pitch;
     loose is a second opinion that differs from freq only when two notes overlap.
     Expects roughly 2048 samples at 44.1/48 kHz. */
  function detectPitch(buf, sampleRate) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    if (rms < 0.003) return { freq: null, loose: null, rms };

    // Halve the sample rate: guitar fundamentals top out near 1.3 kHz, and it quarters the work.
    let x = buf;
    let fs = sampleRate;
    if (sampleRate >= 32000) {
      const half = buf.length >> 1;
      x = scratchArray("x", half).subarray(0, half);
      for (let i = 0; i < half; i++) x[i] = (buf[2 * i] + buf[2 * i + 1]) * 0.5;
      fs = sampleRate / 2;
    }

    const tauMin = Math.max(2, Math.floor(fs / 1400));
    const tauMax = Math.min(Math.ceil(fs / 62), x.length >> 1);
    const W = x.length - tauMax;
    const d = scratchArray("d", tauMax + 2);
    let running = 0;
    d[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const diff = x[j] - x[j + tau];
        s += diff * diff;
      }
      running += s;
      d[tau] = running > 0 ? (s * tau) / running : 1;
    }

    const pick = (threshold) => {
      for (let t = tauMin; t < tauMax; t++) {
        if (d[t] < threshold) {
          while (t + 1 < tauMax && d[t + 1] < d[t]) t++;
          return t;
        }
      }
      return -1;
    };
    const toFreq = (tau) => {
      if (fs !== sampleRate && fs / tau > 350) return refine(buf, sampleRate, tau * 2);
      const a = d[tau - 1];
      const b = d[tau];
      const c = d[tau + 1];
      const denom = a - 2 * b + c;
      const shift = denom ? (a - c) / (2 * denom) : 0;
      return fs / (tau + (Math.abs(shift) < 1 ? shift : 0));
    };

    let tau = pick(0.15);
    if (tau < 0) {
      let best = tauMin;
      for (let t = tauMin + 1; t < tauMax; t++) if (d[t] < d[best]) best = t;
      if (d[best] > 0.25) tau = -1;
      else tau = best;
    }
    // "Loose" reading: the shortest period that fits reasonably well. When an older note is still
    // ringing underneath, this finds the newly picked, louder one.
    const looseTau = pick(0.3);
    return {
      freq: tau > 0 ? toFreq(tau) : null,
      loose: looseTau > 0 ? (looseTau === tau ? null : toFreq(looseTau)) : null,
      rms,
    };
  }

  /* High notes have periods of only a few samples once the rate is halved, so re-measure the
     period at the full rate around the coarse estimate. */
  function refine(buf, sampleRate, tau0) {
    const lo = Math.max(2, tau0 - 3);
    const hi = tau0 + 3;
    const W = Math.min(buf.length - hi - 1, 1024);
    const e = [];
    for (let tau = lo - 1; tau <= hi + 1; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const diff = buf[j] - buf[j + tau];
        s += diff * diff;
      }
      e.push(s);
    }
    let k = 1;
    for (let i = 2; i < e.length - 1; i++) if (e[i] < e[k]) k = i;
    const denom = e[k - 1] - 2 * e[k] + e[k + 1];
    const shift = denom ? (e[k - 1] - e[k + 1]) / (2 * denom) : 0;
    return sampleRate / (lo - 1 + k + (Math.abs(shift) < 1 ? shift : 0));
  }

  /* ---------- Note tracking: turns a stream of pitch frames into discrete notes ---------- */

  function createTracker(options) {
    const gate = (options && options.gate) || 0.006;
    const notes = [];
    const hist = [];
    let cur = null; // note currently sounding
    let cand = null; // a different pitch that has to hold steady before it replaces `cur`
    let pendingAttack = null; // time of the last sharp rise in level (a pick stroke)
    let lastAttack = -1;

    function start(midi, t) {
      cur = { midi, start: t, last: t, end: t };
      cand = null;
    }

    function end(t) {
      if (!cur) return;
      cur.end = Math.max(t, cur.start);
      if (cur.end - cur.start >= 0.05) notes.push({ midi: cur.midi, start: cur.start, end: cur.end });
      cur = null;
    }

    function toMidi(freq) {
      if (!freq) return null;
      const midi = Math.round(freqMidi(freq));
      return midi < 28 || midi > 92 ? null : midi;
    }

    function push(t, freq, rms, loose) {
      while (hist.length && t - hist[0].t > 0.07) hist.shift();
      let ref = Infinity;
      for (const h of hist) ref = Math.min(ref, h.rms);
      hist.push({ t, rms });
      if (hist.length > 1 && rms > gate * 2 && rms > ref * 1.8 && t - lastAttack > 0.1) {
        lastAttack = t;
        pendingAttack = t;
      }
      if (pendingAttack !== null && t - pendingAttack > 0.2) pendingAttack = null;

      const loud = rms >= gate;
      let midi = loud ? toMidi(freq) : null;
      const alt = loud ? toMidi(loose) : null;

      if (!cur) {
        if (midi === null) {
          cand = null;
          return;
        }
        if (!cand || cand.midi !== midi) cand = { midi, since: t, n: 1 };
        else cand.n++;
        if (cand.n >= 2 && t - cand.since >= 0.02) {
          const since = cand.since;
          start(midi, since);
          cur.last = t;
          pendingAttack = null;
        }
        return;
      }

      // Just after a pick stroke, if the main reading still says "the old note" (or nothing), the
      // old note is probably ringing on underneath a new one: trust the second opinion.
      if (pendingAttack !== null && alt !== null && (midi === cur.midi || midi === null)) midi = alt;
      // While a note that was found that way sustains, either reading may confirm it.
      else if (alt === cur.midi) midi = alt;

      if (midi === cur.midi) {
        cur.last = t;
        cand = null;
        // Same pitch picked again.
        if (pendingAttack !== null && pendingAttack - cur.start > 0.09) {
          const at = pendingAttack;
          pendingAttack = null;
          end(at);
          start(midi, at);
          cur.last = t;
        }
        return;
      }

      if (midi === null) {
        cand = null;
        if (t - cur.last > 0.09) end(cur.last);
        return;
      }

      if (!cand || cand.midi !== midi) cand = { midi, since: t, n: 1 };
      else cand.n++;
      // A pitch change with no pick stroke is a hammer-on, pull-off or slide, and those are small
      // steps. Bigger unpicked jumps are a ringing string or an overtone showing through: ignore.
      const picked = pendingAttack !== null;
      const legato = Math.abs(midi - cur.midi) <= 5;
      if ((picked || legato) && cand.n >= 2 && t - cand.since >= (picked ? 0.02 : 0.04)) {
        const since = cand.since;
        end(since);
        start(midi, since);
        cur.last = t;
        pendingAttack = null;
      } else if (t - cur.last > 0.25) {
        end(cur.last);
      }
    }

    return {
      push,
      flush() {
        if (cur) end(cur.last);
        cand = null;
      },
      /* Finished notes plus the one still ringing, for live display. */
      snapshot() {
        if (cur && cur.last - cur.start >= 0.05) {
          return notes.concat([{ midi: cur.midi, start: cur.start, end: cur.last }]);
        }
        return notes.slice();
      },
      current() {
        return cur ? cur.midi : null;
      },
    };
  }

  /* Run the tracker over a whole mono recording. `onProgress` gets 0..1 and the work yields to the
     event loop between chunks so the page stays responsive. */
  async function analyzeSamples(samples, sampleRate, onProgress) {
    const size = 2048;
    const hop = 1024;
    const tracker = createTracker();
    const frames = Math.max(0, Math.floor((samples.length - size) / hop) + 1);
    for (let i = 0; i < frames; i++) {
      const frame = samples.subarray(i * hop, i * hop + size);
      const r = detectPitch(frame, sampleRate);
      tracker.push((i * hop + size / 2) / sampleRate, r.freq, r.rms, r.loose);
      if (i % 150 === 149) {
        if (onProgress) onProgress(i / frames);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    tracker.flush();
    return tracker.snapshot();
  }

  /* ---------- Rhythm: note start times -> grid columns ---------- */

  /* mode "auto": guess the pulse from the playing (the most common gap counts as an eighth note).
     mode "bpm":  snap to sixteenths at the given tempo.
     mode "even": ignore timing, one note every eighth.
     Returns { steps, bpm } where steps[i] is the column of note i relative to the first note. */
  function layoutNotes(notes, mode, bpm) {
    const steps = [];
    if (!notes.length) return { steps, bpm };
    if (mode === "even") {
      notes.forEach((_, i) => steps.push(i * 2));
      return { steps, bpm };
    }
    if (mode === "bpm") {
      const stepDur = 60 / bpm / 4;
      const t0 = notes[0].start;
      let prev = -1;
      for (const n of notes) {
        const s = Math.max(prev + 1, Math.round((n.start - t0) / stepDur));
        steps.push(s);
        prev = s;
      }
      return { steps, bpm };
    }
    const gaps = [];
    for (let i = 1; i < notes.length; i++) gaps.push(notes[i].start - notes[i - 1].start);
    const usable = gaps.filter((g) => g > 0.06 && g < 3).sort((a, b) => a - b);
    const median = usable.length ? usable[usable.length >> 1] : 0.3;
    const unit = median / 2;
    steps.push(0);
    for (let i = 0; i < gaps.length; i++) {
      const jump = Math.min(STEPS_PER_BAR, Math.max(1, Math.round(gaps[i] / unit)));
      steps.push(steps[i] + jump);
    }
    let guess = 60 / (median * 2);
    while (guess < 60) guess *= 2;
    while (guess > 180) guess /= 2;
    return { steps, bpm: Math.round(guess) };
  }

  /* ---------- Fretboard placement ---------- */

  function positionsFor(midi, tuning) {
    const out = [];
    for (let s = 0; s < tuning.length; s++) {
      const fret = midi - tuning[s];
      if (fret >= 0 && fret <= MAX_FRET) out.push({ string: s, fret });
    }
    return out;
  }

  /* Pick a string and fret for each pitch so the hand moves as little as possible
     (shortest path through the candidate positions). Unplayable pitches come back null. */
  function assignFrets(midis, tuning) {
    const result = midis.map(() => null);
    const layers = [];
    midis.forEach((m, i) => {
      const options = positionsFor(m, tuning);
      if (options.length) layers.push({ i, options });
    });
    if (!layers.length) return result;

    const nodeCost = (p) => p.fret * 0.12 + (p.fret > 12 ? (p.fret - 12) * 0.3 : 0);
    const moveCost = (a, b) => {
      const strings = Math.abs(a.string - b.string) * 0.35;
      if (a.fret === 0 || b.fret === 0) return strings + 0.4;
      return strings + Math.abs(a.fret - b.fret);
    };

    let costs = layers[0].options.map(nodeCost);
    const back = [];
    for (let k = 1; k < layers.length; k++) {
      const prev = layers[k - 1].options;
      const here = layers[k].options;
      const next = [];
      const from = [];
      for (let j = 0; j < here.length; j++) {
        let best = Infinity;
        let arg = 0;
        for (let p = 0; p < prev.length; p++) {
          const c = costs[p] + moveCost(prev[p], here[j]);
          if (c < best) {
            best = c;
            arg = p;
          }
        }
        next.push(best + nodeCost(here[j]));
        from.push(arg);
      }
      back.push(from);
      costs = next;
    }
    let j = costs.indexOf(Math.min(...costs));
    for (let k = layers.length - 1; k >= 0; k--) {
      result[layers[k].i] = layers[k].options[j];
      if (k > 0) j = back[k - 1][j];
    }
    return result;
  }

  /* Notes -> grid columns. A column is an array of six cells (low string first), each a fret or null. */
  function notesToColumns(notes, tuning, mode, bpm) {
    const placed = assignFrets(notes.map((n) => n.midi), tuning);
    const kept = [];
    const positions = [];
    notes.forEach((n, i) => {
      if (placed[i]) {
        kept.push(n);
        positions.push(placed[i]);
      }
    });
    const layout = layoutNotes(kept, mode, bpm);
    const cols = [];
    kept.forEach((_, i) => {
      const c = layout.steps[i];
      while (cols.length <= c) cols.push(emptyColumn());
      cols[c][positions[i].string] = positions[i].fret;
    });
    return { cols, bpm: layout.bpm, count: kept.length };
  }

  function emptyColumn() {
    return [null, null, null, null, null, null];
  }

  function columnIsEmpty(col) {
    return col.every((v) => v === null);
  }

  function lastUsedColumn(cols) {
    for (let i = cols.length - 1; i >= 0; i--) if (!columnIsEmpty(cols[i])) return i;
    return -1;
  }

  /* ---------- Plain-text tab ---------- */

  function toAscii(cols, tuning, title, barsPerLine) {
    const perLine = barsPerLine || 2;
    const last = lastUsedColumn(cols);
    const bars = Math.max(1, Math.ceil((last + 1) / STEPS_PER_BAR));
    const labels = tuning.map(pitchClass);
    const labelWidth = Math.max(...labels.map((l) => l.length));
    const lines = [];
    if (title) lines.push(title, "");
    for (let b = 0; b < bars; b += perLine) {
      for (let s = tuning.length - 1; s >= 0; s--) {
        let line = labels[s].padEnd(labelWidth) + "|";
        for (let bar = b; bar < Math.min(bars, b + perLine); bar++) {
          line += "-";
          for (let k = 0; k < STEPS_PER_BAR; k++) {
            const col = cols[bar * STEPS_PER_BAR + k] || emptyColumn();
            const v = col[s];
            line += v === null ? "--" : String(v).padEnd(2, "-");
          }
          line += "|";
        }
        lines.push(line);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  const api = {
    NOTE_NAMES,
    STEPS_PER_BAR,
    MAX_FRET,
    TUNINGS,
    pitchClass,
    midiName,
    midiFreq,
    freqMidi,
    detectPitch,
    createTracker,
    analyzeSamples,
    layoutNotes,
    assignFrets,
    notesToColumns,
    emptyColumn,
    columnIsEmpty,
    lastUsedColumn,
    toAscii,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TabCore = api;
})(typeof self !== "undefined" ? self : this);
