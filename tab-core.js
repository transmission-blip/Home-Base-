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
    return { midi: n.midi, end: n.end, amp, unsure };
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
      const endOf = {};
      for (const n of pitches) endOf[n.midi] = n.end;
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
              // Fretting a string that should still be ringing would cut that note short.
              if (same.fret !== r.fret) cost += 2;
            } else {
              kept.push(r);
              if (r.fret > 0) {
                lo = Math.min(lo, r.fret);
                hi = Math.max(hi, r.fret);
              }
            }
          }
          if (hi - lo > 4) cost += (hi - lo - 4) * 1.5;

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
              cost += a - hb;
              ha = hb = a;
            } else if (b < ha) {
              cost += ha - b;
              ha = hb = b;
            } else {
              ha = Math.max(ha, a);
              hb = Math.min(hb, b);
            }
          }

          const sounding = kept.concat(sh.notes.map((n) => ({ string: n.string, fret: n.fret, end: endOf[n.midi] })));
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
      result[i] = st.shape ? st.shape.notes : [];
      st = st.prev;
    }
    return result;
  }

  /* Single-line convenience wrapper: a position for each pitch in turn (null if unplayable). */
  function assignFrets(midis, tuning) {
    const events = midis.map((midi, i) => ({ start: i, notes: [{ midi, end: i + 0.9, amp: 1 }] }));
    return fingerEvents(events, tuning).map((notes) => (notes.length ? { string: notes[0].string, fret: notes[0].fret } : null));
  }

  /* Notes -> grid columns. A column is an array of six cells (low string first), each a fret or null. */
  function notesToColumns(notes, tuning, mode, bpm) {
    const fingered = [];
    const events = groupEvents(notes);
    fingerEvents(events, tuning).forEach((placed, i) => {
      if (placed.length) fingered.push({ start: events[i].start, placed });
    });
    const layout = layoutNotes(fingered, mode, bpm);
    const cols = [];
    let count = 0;
    fingered.forEach((ev, i) => {
      const c = layout.steps[i];
      while (cols.length <= c) cols.push(emptyColumn());
      for (const p of ev.placed) {
        cols[c][p.string] = p.fret;
        count++;
      }
    });
    return { cols, bpm: layout.bpm, count };
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

  function toAscii(cols, tuning, title, barsPerLine) {
    const perLine = barsPerLine || 2;
    const last = lastUsedColumn(cols);
    const bars = Math.max(1, Math.ceil((last + 1) / STEPS_PER_BAR));
    const labels = tuning.map(pitchClass);
    const labelWidth = Math.max(...labels.map((l) => l.length));
    const lines = [];
    if (title) lines.push(title, "");
    const marks = handPositions(cols);
    for (let b = 0; b < bars; b += perLine) {
      // Position markers (roman numerals) sit above the column where the hand shifts.
      const from = b * STEPS_PER_BAR;
      const to = Math.min(bars, b + perLine) * STEPS_PER_BAR;
      let above = "";
      for (const m of marks) {
        if (m.col < from || m.col >= to) continue;
        const bar = Math.floor(m.col / STEPS_PER_BAR) - b;
        const x = labelWidth + 1 + bar * (STEPS_PER_BAR * 2 + 2) + 1 + (m.col % STEPS_PER_BAR) * 2;
        above = above.padEnd(Math.max(x, above.length + (above ? 1 : 0))) + roman(m.fret);
      }
      if (above) lines.push(above);
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
    cleanPolyNotes,
    groupEvents,
    fingerEvents,
    handPositions,
    roman,
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
