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

  /* Returns { freq, loose, rms, hf }. freq is null when the frame is silent or has no clear pitch;
     loose is a second opinion that differs from freq only when two notes overlap.
     Expects roughly 2048 samples at 44.1/48 kHz. */
  function detectPitch(buf, sampleRate) {
    let sum = 0;
    let edge = 0;
    for (let i = 0; i < buf.length; i++) {
      sum += buf[i] * buf[i];
      if (i) edge += (buf[i] - buf[i - 1]) * (buf[i] - buf[i - 1]);
    }
    const rms = Math.sqrt(sum / buf.length);
    // "hf" weights the bright part of the sound, where the click of a pick shows up.
    const hf = Math.sqrt(edge / buf.length);
    if (rms < 0.003) return { freq: null, loose: null, rms, hf };

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
      hf,
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
      if (hist.length > 1 && rms > gate * 2 && rms > ref * 1.4 && t - lastAttack > 0.1) {
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
        // Same pitch picked again. Wait a moment before believing it: the first instant of a
        // new note on another pitch still reads as the old one.
        if (pendingAttack !== null && pendingAttack - cur.start > 0.09 && t - pendingAttack >= 0.05) {
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
      // A note that has only just begun and is already giving way was a misreading of the pick
      // attack (often an octave out), not a note: let the real pitch take its place.
      if (cur.last - cur.start < 0.07 && cand.n >= 2 && t - cand.since >= 0.02) {
        const since = cur.start;
        cur = null;
        start(midi, since);
        cur.last = t;
        pendingAttack = null;
      } else if ((picked || legato) && cand.n >= 2 && t - cand.since >= (picked ? 0.02 : 0.04)) {
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

  /* One reading of a moment of sound, as kept for the technique pass. */
  function frameOf(t, r) {
    return { t, freq: r.freq, loose: r.loose, m: r.freq ? freqMidi(r.freq) : null, rms: r.rms, hf: r.hf };
  }

  /* Single-pitch readings across a whole mono recording, about 45 a second. `onProgress` gets
     0..1 and the work yields to the event loop between chunks so the page stays responsive. */
  async function pitchFrames(samples, sampleRate, onProgress) {
    const size = sampleRate >= 32000 ? 2048 : 1024;
    const hop = size / 2;
    const count = Math.max(0, Math.floor((samples.length - size) / hop) + 1);
    const frames = [];
    for (let i = 0; i < count; i++) {
      const r = detectPitch(samples.subarray(i * hop, i * hop + size), sampleRate);
      frames.push(frameOf((i * hop + size / 2) / sampleRate, r));
      if (i % 150 === 149) {
        if (onProgress) onProgress(i / count);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    return frames;
  }

  /* Single-note transcription of a whole recording, techniques included. */
  async function analyzeSamples(samples, sampleRate, onProgress) {
    const frames = await pitchFrames(samples, sampleRate, onProgress);
    const tracker = createTracker();
    for (const f of frames) tracker.push(f.t, f.freq, f.rms, f.loose);
    tracker.flush();
    return markTechniques(tracker.snapshot(), frames);
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

  /* ---------- Techniques: hammer-ons, pull-offs, slides and bends ---------- */

  /* Both detectors report the notes inside a hammer-on, slide or bend, but not how each note was
     reached, and they chop a slow bend into semitone steps. This pass looks at the sound around
     each note start: was the string picked (a jump in level) or did the pitch just change? And if
     it changed, did it jump (hammer-on / pull-off) or travel (slide / bend)?

     notes:  [{ midi, start, end, ... }]
     frames: from pitchFrames() over the same recording
     Returns the notes with ids, and where it applies `how` ("h", "p", "/", "\\") plus `from` (the
     id of the note it came from), or `bend` (semitones) on a note that is bent upward. */
  const BEND_TIME = 0.115; // seconds; a slide covers a couple of frets faster than this

  function markTechniques(input, frames) {
    const notes = input.map((n) => Object.assign({}, n)).sort((a, b) => a.start - b.start || a.midi - b.midi);
    notes.forEach((n, i) => {
      n.id = i;
    });
    if (!frames || frames.length < 4) return notes;

    const lower = (t) => {
      let lo = 0;
      let hi = frames.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (frames[mid].t < t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const span = (t0, t1) => frames.slice(lower(t0), lower(t1));
    const median = (values) => {
      const s = values.slice().sort((a, b) => a - b);
      return s[s.length >> 1];
    };

    // A pick stroke shows as a jump in loudness, and even more in the brightness of the sound.
    const picked = (n) => {
      const before = span(n.start - 0.1, n.start - 0.025);
      const after = span(n.start - 0.025, n.start + 0.07);
      if (!before.length || !after.length) return true;
      const quietest = Math.min(...before.map((f) => f.rms));
      if (quietest < 0.004) return true;
      const rise = Math.max(...after.map((f) => f.rms)) / quietest;
      const brighter = Math.max(...after.map((f) => f.hf)) / Math.max(1e-6, Math.min(...before.map((f) => f.hf)));
      return rise > 1.2 || brighter > 1.3;
    };

    // 1. Link each unpicked note to the note it grew out of: the nearest pitch that stops just
    //    as this one starts.
    const byId = {};
    let kept = [];
    for (const n of notes) {
      byId[n.id] = n;
      if (!picked(n)) {
        let best = null;
        for (let i = kept.length - 1; i >= Math.max(0, kept.length - 8); i--) {
          const p = kept[i];
          if (p.start >= n.start - 0.03) continue;
          if (p.end < n.start - 0.1 || p.end > n.start + 0.12) continue;
          const d = Math.abs(n.midi - p.midi);
          if (d === 0 || d > 12) continue;
          if (!best || d < Math.abs(n.midi - best.midi)) best = p;
        }
        if (best) n.from = best.id;
      }
      kept.push(n);
    }

    // 2. A pitch that travels is heard as a run of very short notes. Fold each run into one move
    //    from its first note to its last.
    const gone = new Set();
    for (const c of kept) {
      const b = byId[c.from];
      if (!b || b.from === undefined) continue;
      const a = byId[b.from];
      const sameWay = Math.sign(c.midi - b.midi) === Math.sign(b.midi - a.midi);
      if (sameWay && b.end - b.start < 0.13) {
        gone.add(b.id);
        c.from = a.id;
        c.glideStart = b.glideStart === undefined ? b.start : b.glideStart;
        a.end = Math.max(a.end, b.end);
      }
    }
    kept = kept.filter((n) => !gone.has(n.id));

    // 3. Name each move.
    const bentTo = {}; // id of a note absorbed into a bend -> the bent note
    const out = [];
    for (const c of kept) {
      if (c.from === undefined) {
        out.push(c);
        continue;
      }
      if (bentTo[c.from]) {
        // Whatever follows a bend without a pick stroke is the bend being let down.
        const origin = bentTo[c.from];
        delete c.from;
        if (c.midi <= origin.midi + origin.bend && c.midi >= origin.midi) {
          origin.end = Math.max(origin.end, c.end);
          bentTo[c.id] = origin;
          continue;
        }
        out.push(c);
        continue;
      }
      const a = byId[c.from];
      const d = c.midi - a.midi;
      const lo = Math.min(a.midi, c.midi);
      const hi = Math.max(a.midi, c.midi);
      // Can the single-pitch reading be trusted here? Only if it agrees with both notes.
      const lands = span(c.start + 0.02, c.start + 0.14).some((f) => f.m !== null && Math.abs(f.m - c.midi) < 0.4);
      const leaves = span(Math.max(a.start, c.start - 0.5), c.start).some((f) => f.m !== null && Math.abs(f.m - a.midi) < 0.4);
      const trusted = lands && leaves;
      // Start looking a little way into the old note, so that the jump that began it isn't
      // mistaken for part of the move out of it.
      const from = Math.max(a.start + 0.06, c.start - 0.4);
      const between = trusted
        ? span(from, c.start + 0.03).filter((f) => f.m !== null && f.m > lo + 0.3 && f.m < hi - 0.3)
        : [];
      // One in-between reading is just the analysis window straddling a jump; a pitch that
      // really travels leaves several.
      const travelled = c.glideStart !== undefined || (Math.abs(d) >= 2 && between.length >= 2);

      // How long the pitch spent on the way: from the last moment it sat on the old note to the
      // first moment it sat on the new one. A finger sliding covers a fret or two quickly and in
      // steps; a string being pushed up takes longer and moves smoothly.
      let took = c.glideStart !== undefined ? c.start - c.glideStart : 0;
      if (trusted) {
        const around = span(from, c.start + 0.35);
        let left = -1;
        around.forEach((f, i) => {
          if (f.t <= c.start + 0.03 && f.m !== null && Math.abs(f.m - a.midi) <= 0.15) left = i;
        });
        const arrived = left < 0 ? -1 : around.findIndex((f, i) => i > left && f.m !== null && Math.abs(f.m - c.midi) <= 0.15);
        if (arrived > 0) took = around[arrived].t - around[left + 1].t;
      }

      if (d > 0 && d <= 3 && took >= BEND_TIME) {
        // Slow, smooth and upward by a little: the string is being pushed, not the finger moved.
        a.bend = d;
        a.end = Math.max(a.end, c.end);
        bentTo[c.id] = a;
        continue;
      }
      if (travelled) c.how = d > 0 ? "/" : "\\";
      else if (Math.abs(d) <= 5) c.how = d > 0 ? "h" : "p";
      else delete c.from;
      delete c.glideStart;
      out.push(c);
    }

    // 4. Bends the detector heard as one note: the pitch settles well above where it started.
    out.forEach((n, i) => {
      if (n.bend) return;
      const next = out.slice(i + 1).find((m) => m.start > n.start + 0.05);
      const until = Math.min(n.end + 0.3, next ? next.start - 0.02 : Infinity);
      const body = span(n.start + 0.03, until)
        .filter((f) => f.m !== null && Math.abs(f.m - n.midi) <= 3.5)
        .map((f) => f.m - n.midi);
      if (body.length < 6) return;
      const head = body.slice(0, Math.max(2, Math.floor(body.length / 4)));
      const tail = body.slice(Math.floor(body.length / 2));
      const settled = Math.max(...tail) - Math.min(...tail) < 0.6;
      const rise = median(tail);
      if (Math.abs(median(head)) <= 0.4 && settled && rise >= 0.7) n.bend = Math.min(3, Math.round(rise));
    });

    return out;
  }

  /* ---------- Tidying the chord model's output ---------- */

  const OVERTONES = [12, 19, 24, 28, 31];

  /* The chord-capable model (see tab-poly.js) hears everything that is sounding, which includes
     things nobody played: strings that are still ringing get reported again each time another
     note is picked, and the overtones of a strong note show up as faint notes of their own.
     Each note carries { midi, start, end, amp, onset } where `onset` is how sure the model was
     that the note began there. */
  function cleanPolyNotes(raw) {
    const notes = raw
      .filter((n) => n.onset >= 0.5)
      .map((n) => Object.assign({}, n))
      .sort((a, b) => a.start - b.start || a.midi - b.midi);

    // 1. One pitch reported twice in a row: either one pick stroke split in two, or a string that
    //    is still ringing being "re-heard" when something else is picked. Fold the repeat into the
    //    first note unless it looks like a real new attack. In a strum (three or more new notes
    //    at once) strings shared with the previous chord really are struck again, so believe
    //    repeats more readily there.
    const lastOf = {};
    const merged = [];
    for (const ev of clusterByStart(notes)) {
      const kind = ev.map((n) => {
        const prev = lastOf[n.midi];
        if (!prev) return "new";
        if (n.start - prev.start < 0.1) return "split";
        if (prev.end >= n.start - 0.06 && n.onset < 0.75) return "ringing";
        return "new";
      });
      const strum = ev.filter((n, i) => kind[i] === "new" && n.onset >= 0.7).length >= 3;
      ev.forEach((n, i) => {
        const prev = lastOf[n.midi];
        if (kind[i] === "split") {
          prev.end = Math.max(prev.end, n.end);
          prev.amp = Math.max(prev.amp, n.amp);
          prev.onset = Math.max(prev.onset, n.onset);
        } else if (kind[i] === "ringing" && !(strum && n.onset >= 0.6)) {
          prev.end = Math.max(prev.end, n.end);
        } else {
          merged.push(n);
          lastOf[n.midi] = n;
        }
      });
    }

    // 2. Faint notes nobody played. Next to one or two firmly picked notes, anything much quieter
    //    is an overtone or an echo of the room. A full chord is different: its upper notes really
    //    are quieter, and the same pitches really are doubled an octave up, so be forgiving there.
    const out = [];
    for (const ev of clusterByStart(merged)) {
      const loudest = Math.max(...ev.map((n) => n.amp));
      const chord = ev.filter((n) => n.amp >= loudest * 0.6).length >= 3;
      for (const n of ev) {
        if (n.amp < loudest * (chord ? 0.3 : 0.6)) continue;
        const overtone = ev.some(
          (low) => low !== n && OVERTONES.includes(n.midi - low.midi) && n.amp < low.amp * (chord ? 0.45 : 0.75)
        );
        if (!overtone) out.push(n);
      }
    }
    return out;
  }

  function clusterByStart(notes) {
    const groups = [];
    let last = -Infinity;
    for (const n of notes) {
      const g = groups[groups.length - 1];
      if (g && n.start - last < 0.045 && n.start - g[0].start < 0.09) g.push(n);
      else groups.push([n]);
      last = n.start;
    }
    return groups;
  }

  /* ---------- Events: notes that start together (a chord, a pinch, a strum) ---------- */

  function groupEvents(notes) {
    const sorted = notes.slice().sort((a, b) => a.start - b.start || a.midi - b.midi);
    const events = [];
    let lastStart = -Infinity;
    for (const n of sorted) {
      const ev = events[events.length - 1];
      // A strum spreads its notes over a few hundredths of a second.
      if (ev && n.start - lastStart < 0.045 && n.start - ev.start < 0.09) {
        const twin = ev.notes.find((m) => m.midi === n.midi);
        if (twin) twin.end = Math.max(twin.end, n.end);
        else ev.notes.push(eventNote(n));
      } else {
        events.push({ start: n.start, notes: [eventNote(n)] });
      }
      lastStart = n.start;
    }
    for (const ev of events) ev.notes.sort((a, b) => a.midi - b.midi);
    return events;
  }

  function eventNote(n) {
    const amp = n.amp === undefined ? 1 : n.amp;
    // "Unsure" notes are ones the detector was half-hearted about; the fingering step is allowed
    // to leave them out if playing them would mean an implausible leap.
    const unsure = amp < 0.5 || (n.onset !== undefined && n.onset < 0.7);
    return { midi: n.midi, end: n.end, amp, unsure, id: n.id, from: n.from, how: n.how, bend: n.bend };
  }

  /* ---------- Fretboard placement ---------- */

  const MAX_SHAPES = 18;
  const BEAM_WIDTH = 28;
  const DROP_COST = 2.5;

  /* Every way to hold a set of pitches at once: one string each, within reach of one hand. */
  function shapesFor(midis, tuning) {
    const shapes = [];
    const pos = [];
    const rec = (i, used, lo, hi) => {
      if (i === midis.length) {
        shapes.push(scoreShape(pos.slice(), lo, hi));
        return;
      }
      for (let s = 0; s < tuning.length; s++) {
        if (used & (1 << s)) continue;
        const fret = midis[i] - tuning[s];
        if (fret < 0 || fret > MAX_FRET) continue;
        let nlo = lo;
        let nhi = hi;
        if (fret > 0) {
          nlo = Math.min(lo, fret);
          nhi = Math.max(hi, fret);
          if (nhi - nlo > 4) continue;
        }
        pos.push({ string: s, fret, midi: midis[i] });
        rec(i + 1, used | (1 << s), nlo, nhi);
        pos.pop();
      }
    };
    rec(0, 0, Infinity, -Infinity);
    shapes.sort((a, b) => a.cost - b.cost);
    return shapes.slice(0, MAX_SHAPES);
  }

  function scoreShape(notes, lo, hi) {
    let cost = 0;
    const fretted = lo !== Infinity;
    if (fretted) {
      cost += lo * 0.2 + (hi > 12 ? (hi - 12) * 0.25 : 0);
      if (hi - lo === 4) cost += 1.5;
      else if (hi - lo === 3) cost += 0.2;
      // One finger can bar the lowest fret; the other three each hold one note.
      if (notes.filter((n) => n.fret > lo).length > 3) cost += 3;
    }
    // Pitches normally rise with the strings; a crossed shape is awkward.
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) if (notes[i].string > notes[j].string) cost += 1;
    }
    return { notes, lo: fretted ? lo : null, hi: fretted ? hi : null, cost };
  }

  /* Choose a string and fret for every note of every event. The search carries the state of the
     fretting hand along the piece: which fret position it is in, and which strings are still
     ringing, so that an arpeggio comes out as the chord shape it is held in and the hand only
     shifts position when it has to. Returns, per event, a list of { string, fret, midi }. */
  function fingerEvents(events, tuning) {
    let beam = [{ cost: 0, ha: null, hb: null, sounding: [], prev: null, shape: null }];
    for (const ev of events) {
      let pitches = ev.notes.filter((n) => tuning.some((open) => n.midi - open >= 0 && n.midi - open <= MAX_FRET));
      let shapes = [];
      // If the whole chord can't be held, let go of the quietest notes until it can.
      while (pitches.length) {
        shapes = shapesFor(pitches.map((n) => n.midi), tuning);
        if (shapes.length) break;
        const quietest = pitches.reduce((a, n) => (n.amp < a.amp ? n : a));
        pitches = pitches.filter((n) => n !== quietest);
      }
      if (!shapes.length) {
        beam = beam.map((st) => ({ cost: st.cost, ha: st.ha, hb: st.hb, sounding: st.sounding, prev: st, shape: null }));
        continue;
      }
      const info = {};
      for (const n of pitches) info[n.midi] = n;
      // Second option: play only the notes the detector was sure of. Costly, so it is taken
      // only when a faint note would otherwise force a big jump or an unplayable stretch.
      const sure = pitches.filter((n) => !n.unsure);
      if (sure.length < pitches.length) {
        const penalty = (pitches.length - sure.length) * DROP_COST;
        const fewer = sure.length ? shapesFor(sure.map((n) => n.midi), tuning) : [{ notes: [], lo: null, hi: null, cost: 0 }];
        shapes = shapes.concat(fewer.slice(0, 8).map((sh) => Object.assign({}, sh, { cost: sh.cost + penalty })));
      }

      const next = new Map();
      for (const st of beam) {
        const ringing = st.sounding.filter((r) => r.end > ev.start + 0.05);
        for (const sh of shapes) {
          let cost = st.cost + sh.cost;
          let lo = sh.lo === null ? Infinity : sh.lo;
          let hi = sh.hi === null ? -Infinity : sh.hi;
          const kept = [];
          for (const r of ringing) {
            const same = sh.notes.find((n) => n.string === r.string);
            if (same) {
              // Fretting a string that should still be ringing would cut that note short,
              // unless this note is hammered, pulled or slid from that very note.
              if (same.fret !== r.fret && info[same.midi].from !== r.id) cost += 2;
            } else {
              kept.push(r);
              if (r.fret > 0) {
                lo = Math.min(lo, r.fret);
                hi = Math.max(hi, r.fret);
              }
            }
          }
          if (hi - lo > 4) cost += (hi - lo - 4) * 1.5;

          // Hammer-ons, pull-offs and slides stay on one string; a bend needs a fretted note.
          let sliding = false;
          for (const n of sh.notes) {
            const meta = info[n.midi];
            if (meta.bend && n.fret === 0) cost += 4;
            if (meta.from === undefined) continue;
            if (meta.how === "/" || meta.how === "\\") sliding = true;
            const origin = st.sounding.find((r) => r.id === meta.from);
            if (origin && origin.string !== n.string) cost += 3;
          }

          // The hand sits with its first finger somewhere in [a, b] to reach this shape.
          let ha = st.ha;
          let hb = st.hb;
          if (sh.lo !== null) {
            const b = sh.lo;
            const a = Math.min(b, Math.max(1, sh.hi - 3));
            if (ha === null) {
              ha = a;
              hb = b;
            } else if (a > hb) {
              // A slide is how the hand changes position, so moving costs little then.
              cost += (a - hb) * (sliding ? 0.25 : 1);
              ha = hb = a;
            } else if (b < ha) {
              cost += (ha - b) * (sliding ? 0.25 : 1);
              ha = hb = b;
            } else {
              ha = Math.max(ha, a);
              hb = Math.min(hb, b);
            }
          }

          const sounding = kept.concat(
            sh.notes.map((n) => ({ string: n.string, fret: n.fret, end: info[n.midi].end, id: info[n.midi].id }))
          );
          sounding.sort((x, y) => x.string - y.string);
          const key = ha + "," + hb + "|" + sounding.map((n) => n.string + ":" + n.fret).join(",");
          const seen = next.get(key);
          if (!seen || cost < seen.cost) next.set(key, { cost, ha, hb, sounding, prev: st, shape: sh });
        }
      }
      beam = Array.from(next.values()).sort((x, y) => x.cost - y.cost).slice(0, BEAM_WIDTH);
    }

    const result = new Array(events.length);
    let st = beam[0];
    for (let i = events.length - 1; i >= 0; i--) {
      const meta = {};
      for (const n of events[i].notes) meta[n.midi] = n;
      result[i] = (st.shape ? st.shape.notes : []).map((n) => {
        const m = meta[n.midi];
        return { string: n.string, fret: n.fret, midi: n.midi, id: m.id, from: m.from, how: m.how, bend: m.bend };
      });
      st = st.prev;
    }
    return result;
  }

  /* Single-line convenience wrapper: a position for each pitch in turn (null if unplayable). */
  function assignFrets(midis, tuning) {
    const events = midis.map((midi, i) => ({ start: i, notes: [{ midi, end: i + 0.9, amp: 1 }] }));
    return fingerEvents(events, tuning).map((notes) => (notes.length ? { string: notes[0].string, fret: notes[0].fret } : null));
  }

  /* Notes -> grid columns. A column is an array of six cells (low string first), each a fret or
     null. `tech` is a second grid of the same shape holding the technique mark for each note:
     "h", "p", "/" or "\\" for how the note is reached from the one before it on that string, or
     "b1".."b3" for a note bent up by that many semitones. */
  function notesToColumns(notes, tuning, mode, bpm) {
    const fingered = [];
    const events = groupEvents(notes);
    fingerEvents(events, tuning).forEach((placed, i) => {
      if (placed.length) fingered.push({ start: events[i].start, placed });
    });
    const layout = layoutNotes(fingered, mode, bpm);
    const cols = [];
    const tech = [];
    const where = {};
    let count = 0;
    let marks = 0;
    fingered.forEach((ev, i) => {
      const c = layout.steps[i];
      while (cols.length <= c) {
        cols.push(emptyColumn());
        tech.push(emptyColumn());
      }
      for (const p of ev.placed) {
        cols[c][p.string] = p.fret;
        count++;
        if (p.id !== undefined) where[p.id] = p;
        // A mark only makes sense if the fingering agrees with it.
        const origin = p.from === undefined ? null : where[p.from];
        const rising = p.how === "h" || p.how === "/";
        if (p.how && origin && origin.string === p.string && (rising ? p.fret > origin.fret : p.fret < origin.fret)) {
          tech[c][p.string] = p.how;
          marks++;
        } else if (p.bend && p.fret > 0) {
          tech[c][p.string] = "b" + Math.min(3, p.bend);
          marks++;
        }
      }
    });
    return { cols, tech, bpm: layout.bpm, count, marks };
  }

  /* How one note reads in plain-text tab: h7, p5, /9, \\5, or 7b9 (the 7th fret bent up until it
     sounds like the 9th). */
  function cellToken(fret, mark) {
    if (fret === null || fret === undefined) return "";
    if (!mark) return String(fret);
    if (mark[0] === "b") return fret + "b" + (fret + Number(mark[1]));
    return mark + fret;
  }

  /* Where the fretting hand is, read back off the tab: the piece is split into the longest runs
     that fit under one hand without shifting, and each run is named by its lowest fret (its
     "position"). Returns [{ col, fret }] at each point the position changes. */
  function handPositions(cols) {
    const marks = [];
    let lo = Infinity;
    let hi = -Infinity;
    let startCol = -1;
    const close = () => {
      if (startCol < 0) return;
      if (!marks.length || marks[marks.length - 1].fret !== lo) marks.push({ col: startCol, fret: lo });
    };
    cols.forEach((col, c) => {
      let clo = Infinity;
      let chi = -Infinity;
      for (const v of col) {
        if (v !== null && v > 0) {
          clo = Math.min(clo, v);
          chi = Math.max(chi, v);
        }
      }
      if (clo === Infinity) return;
      const nlo = Math.min(lo, clo);
      const nhi = Math.max(hi, chi);
      if (startCol >= 0 && nhi - nlo <= Math.max(3, chi - clo)) {
        lo = nlo;
        hi = nhi;
      } else {
        close();
        lo = clo;
        hi = chi;
        startCol = c;
      }
    });
    close();
    return marks;
  }

  function roman(n) {
    const table = [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
    let out = "";
    for (const [value, sym] of table) {
      while (n >= value) {
        out += sym;
        n -= value;
      }
    }
    return out;
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

  function toAscii(cols, tuning, title, barsPerLine, tech) {
    const perLine = barsPerLine || 2;
    const last = lastUsedColumn(cols);
    const bars = Math.max(1, Math.ceil((last + 1) / STEPS_PER_BAR));
    const labels = tuning.map(pitchClass);
    const labelWidth = Math.max(...labels.map((l) => l.length));
    const token = (c, s) => cellToken(cols[c] ? cols[c][s] : null, tech && tech[c] ? tech[c][s] : null);
    const lines = [];
    if (title) lines.push(title, "");
    const marks = handPositions(cols);
    let anyTech = false;
    for (let b = 0; b < bars; b += perLine) {
      const from = b * STEPS_PER_BAR;
      const to = Math.min(bars, b + perLine) * STEPS_PER_BAR;
      // Each column is as wide as its widest entry, so "12" or "h7" never runs into a neighbour.
      const width = [];
      const x = [];
      let cursor = labelWidth + 1;
      for (let c = from; c < to; c++) {
        if ((c - from) % STEPS_PER_BAR === 0) cursor += 1;
        let w = 1;
        for (let s = 0; s < tuning.length; s++) w = Math.max(w, token(c, s).length);
        width[c] = w;
        x[c] = cursor;
        cursor += w + 1;
        if ((c - from) % STEPS_PER_BAR === STEPS_PER_BAR - 1) cursor += 1;
      }
      // Position markers (roman numerals) sit above the column where the hand shifts.
      let above = "";
      for (const m of marks) {
        if (m.col < from || m.col >= to) continue;
        above = above.padEnd(Math.max(x[m.col], above.length + (above ? 1 : 0))) + roman(m.fret);
      }
      if (above) lines.push(above);
      for (let s = tuning.length - 1; s >= 0; s--) {
        let line = labels[s].padEnd(labelWidth) + "|";
        for (let c = from; c < to; c++) {
          if ((c - from) % STEPS_PER_BAR === 0) line += "-";
          const t = token(c, s);
          if (/[^0-9]/.test(t)) anyTech = true;
          line += t.padEnd(width[c], "-") + "-";
          if ((c - from) % STEPS_PER_BAR === STEPS_PER_BAR - 1) line += "|";
        }
        lines.push(line);
      }
      lines.push("");
    }
    if (anyTech) {
      lines.push("h = hammer-on   p = pull-off   / = slide up   \\ = slide down");
      lines.push("b = bend: 7b9 means bend the 7th fret up until it sounds like the 9th");
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
    frameOf,
    pitchFrames,
    analyzeSamples,
    markTechniques,
    layoutNotes,
    cleanPolyNotes,
    groupEvents,
    fingerEvents,
    handPositions,
    roman,
    assignFrets,
    notesToColumns,
    cellToken,
    emptyColumn,
    columnIsEmpty,
    lastUsedColumn,
    toAscii,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TabCore = api;
})(typeof self !== "undefined" ? self : this);
