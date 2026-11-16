"use strict";

/* Backing band: a step-sequenced drum machine and an auto-playing chord keyboard.
   Both follow the recorder's transport and BPM, loop for as long as it runs, and are
   included in the exported mix. Loaded before recorder.js; uses its globals at call time. */

/* ---------- Drums ---------- */

const STEPS = 16;
const DRUM_ROWS = [
  ["kick", "Kick"],
  ["snare", "Snare"],
  ["clap", "Clap"],
  ["hat", "Hi-hat"],
  ["open", "Open hat"],
  ["tom", "Tom"],
];

const DRUM_PRESETS = {
  rock: { label: "Rock", kick: "x.......x.x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
  pop: { label: "Pop", kick: "x.....x.x.......", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x.", open: "..............x." },
  four: { label: "Four on the floor", kick: "x...x...x...x...", clap: "....x.......x...", hat: "x.x.x.x.x.x.x.x.", open: "..x...x...x...x." },
  hiphop: { label: "Hip-hop", kick: "x......x..x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.xx", swing: 0.35 },
  funk: { label: "Funk", kick: "x..x......x..x..", snare: "....x..x.x..x...", hat: "xxxxxxxxxxxxxxxx" },
  half: { label: "Half-time", kick: "x.........x.....", snare: "........x.......", hat: "x.x.x.x.x.x.x.x." },
  ballad: { label: "Ballad", kick: "x.......x.x.....", snare: "....x.......x...", hat: "x...x...x...x..." },
  onedrop: { label: "One drop", kick: "........x.......", snare: "........x.......", hat: "x.x.x.x.x.x.x.x.", open: "......x......x.." },
  toms: { label: "Tom groove", kick: "x.......x.......", snare: "....x.......x...", tom: "..x.x.x...x.x.xx" },
};

function patternFromPreset(name) {
  const preset = DRUM_PRESETS[name];
  const pattern = {};
  DRUM_ROWS.forEach(([row]) => {
    const str = preset[row] || "";
    pattern[row] = Array.from({ length: STEPS }, (_, i) => str[i] === "x");
  });
  return pattern;
}

const drums = { on: false, preset: "rock", swing: 0, vol: 0.8, pattern: patternFromPreset("rock") };

function drumHit(c, dest, row, t, vel = 1) {
  const g = c.createGain();
  g.connect(dest);
  const env = (peak, decay) => {
    g.gain.setValueAtTime(peak * vel, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + decay);
  };
  const noise = (filterType, freq, decay, q) => {
    const src = c.createBufferSource();
    src.buffer = getNoise("hiss", c.sampleRate);
    const f = c.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    if (q) f.Q.value = q;
    src.connect(f);
    f.connect(g);
    // Start at a different spot in the noise each hit so repeats don't sound identical
    src.start(t, (t * 7.31) % 3);
    src.stop(t + decay + 0.05);
  };
  const tone = (type, from, to, sweep, decay, level = 1) => {
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + sweep);
    const og = c.createGain();
    og.gain.value = level;
    osc.connect(og);
    og.connect(g);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  };

  if (row === "kick") {
    tone("sine", 160, 45, 0.11, 0.4);
    env(1, 0.4);
  } else if (row === "snare") {
    tone("triangle", 240, 170, 0.06, 0.12, 0.5);
    noise("highpass", 1800, 0.2);
    env(0.7, 0.2);
  } else if (row === "clap") {
    noise("bandpass", 1300, 0.25, 1.2);
    // Three quick bursts, then the tail
    g.gain.setValueAtTime(0.0008, t);
    [0, 0.012, 0.024].forEach((d) => {
      g.gain.setValueAtTime(0.9 * vel, t + d);
      g.gain.exponentialRampToValueAtTime(0.15 * vel, t + d + 0.01);
    });
    g.gain.setValueAtTime(0.8 * vel, t + 0.036);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.25);
  } else if (row === "hat") {
    noise("highpass", 7500, 0.06);
    env(0.35, 0.06);
  } else if (row === "open") {
    noise("highpass", 6500, 0.35);
    env(0.3, 0.35);
  } else if (row === "tom") {
    tone("sine", 190, 95, 0.2, 0.35);
    env(0.8, 0.35);
  }
}

/* ---------- Chords ---------- */

const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const NOTES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const KEY_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

const PROGRESSIONS = {
  major: [
    { label: "I – V – vi – IV (pop)", degs: [0, 4, 5, 3] },
    { label: "I – IV – V – IV (rock)", degs: [0, 3, 4, 3] },
    { label: "I – vi – IV – V (50s)", degs: [0, 5, 3, 4] },
    { label: "vi – IV – I – V (anthem)", degs: [5, 3, 0, 4] },
    { label: "ii – V – I – I (jazz)", degs: [1, 4, 0, 0] },
    { label: "I – IV (two-chord jam)", degs: [0, 3] },
    { label: "12-bar blues", degs: [0, 0, 0, 0, 3, 3, 0, 0, 4, 3, 0, 4], q: "7" },
  ],
  minor: [
    { label: "i – VI – III – VII (epic)", degs: [0, 5, 2, 6] },
    { label: "i – iv – v – i", degs: [0, 3, 4, 0] },
    { label: "i – VII – VI – VII (rock)", degs: [0, 6, 5, 6] },
    { label: "i – iv (two-chord jam)", degs: [0, 3] },
    { label: "12-bar minor blues", degs: [0, 0, 0, 0, 3, 3, 0, 0, 4, 3, 0, 4] },
  ],
};

function slotsFromPreset(scale, index) {
  const p = PROGRESSIONS[scale][index];
  return p.degs.map((d) => (p.q ? { d, q: p.q } : { d }));
}

const chords = {
  on: false,
  key: 0,
  scale: "major",
  preset: 0,
  slots: slotsFromPreset("major", 0),
  sevenths: false,
  sound: "keys",
  style: "sustain",
  bass: true,
  vol: 0.6,
};

function noteName(pc) {
  const flats = chords.scale === "major" ? [1, 3, 5, 8, 10].includes(chords.key) : [0, 2, 3, 5, 7, 10].includes(chords.key);
  return (flats ? NOTES_FLAT : NOTES_SHARP)[((pc % 12) + 12) % 12];
}

/* Build the chord on a scale degree by stacking thirds inside the key. */
function chordInfo(slot) {
  const sc = SCALES[chords.scale];
  const at = (i) => sc[(slot.d + i) % 7] + 12 * Math.floor((slot.d + i) / 7);
  const root = at(0);
  let intervals = [0, at(2) - root, at(4) - root];
  if (slot.q === "7") intervals = [0, 4, 7, 10];
  else if (chords.sevenths) intervals.push(at(6) - root);

  const [, third, fifth, seventh] = intervals;
  const minor = third === 3;
  const dim = fifth === 6;
  let suffix = dim ? "dim" : minor ? "m" : "";
  if (seventh !== undefined) {
    suffix = dim ? "m7b5" : minor ? "m7" : seventh === 11 ? "maj7" : "7";
  }
  const roman = (minor || dim ? ROMAN[slot.d].toLowerCase() : ROMAN[slot.d]) + (dim ? "°" : "") + (seventh !== undefined ? "7" : "");
  const rootPc = chords.key + root;
  // Keep every chord in the same register so changes move smoothly instead of jumping around
  const notes = intervals
    .map((i) => {
      let n = 48 + rootPc + i;
      while (n >= 65) n -= 12;
      while (n < 53) n += 12;
      return n;
    })
    .sort((a, b) => a - b);
  return { name: noteName(rootPc) + suffix, roman, notes, bass: 36 + (rootPc % 12) };
}

function scaleHint() {
  const sc = SCALES[chords.scale];
  const names = sc.map((s) => noteName(chords.key + s));
  const penta = (chords.scale === "major" ? [0, 1, 2, 4, 5] : [0, 2, 3, 4, 6]).map((i) => names[i]);
  return { all: names.join("  "), penta: penta.join("  ") };
}

function midiFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function playNote(c, dest, midi, t, dur, sound, vel = 1) {
  const f = midiFreq(midi);
  const g = c.createGain();
  g.connect(dest);
  const end = t + dur;
  const osc = (type, freq, level, detune) => {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    const og = c.createGain();
    og.gain.value = level;
    o.connect(og);
    o.start(t);
    o.stop(end + 0.6);
    return og;
  };
  g.gain.setValueAtTime(0.0001, t);

  if (sound === "organ") {
    [1, 2, 3, 4].forEach((h, i) => osc("sine", f * h, [0.5, 0.3, 0.15, 0.08][i]).connect(g));
    g.gain.linearRampToValueAtTime(0.22 * vel, t + 0.012);
    g.gain.setValueAtTime(0.22 * vel, end);
    g.gain.linearRampToValueAtTime(0.0001, end + 0.06);
  } else if (sound === "pad") {
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    osc("sawtooth", f, 0.5, -8).connect(lp);
    osc("sawtooth", f, 0.5, 8).connect(lp);
    lp.connect(g);
    const attack = Math.min(0.3, dur / 2);
    g.gain.linearRampToValueAtTime(0.19 * vel, t + attack);
    g.gain.setValueAtTime(0.19 * vel, end);
    g.gain.linearRampToValueAtTime(0.0001, end + 0.45);
  } else {
    // Electric-piano-like: a round body plus a bell overtone that fades quickly
    osc("sine", f, 1).connect(g);
    osc("triangle", f, 0.25).connect(g);
    const bell = osc("sine", f * 4, 0.18);
    bell.gain.setValueAtTime(0.18, t);
    bell.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    bell.connect(g);
    g.gain.linearRampToValueAtTime(0.24 * vel, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.075 * vel, t + Math.min(dur, 1.6));
    g.gain.setValueAtTime(0.075 * vel, Math.max(end, t + 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, end + 0.25);
  }
}

/* ---------- Sequencing ---------- */

function stepLen() {
  return beatLen() / 4;
}

function backingActive() {
  return drums.on || chords.on;
}

/* Schedule everything that starts on 16th-note step `n` (counted from the start of the song). */
function scheduleStep(c, drumDest, chordDest, n, t) {
  const s = stepLen();
  const inBar = n % STEPS;
  if (drums.on) {
    const when = t + (n % 2 ? drums.swing * s * 0.6 : 0);
    DRUM_ROWS.forEach(([row]) => {
      if (drums.pattern[row][inBar]) drumHit(c, drumDest, row, when);
    });
  }
  if (chords.on && chords.slots.length) {
    const slot = chords.slots[Math.floor(n / STEPS) % chords.slots.length];
    const info = chordInfo(slot);
    const beat = s * 4;
    if (chords.style === "sustain") {
      if (inBar === 0) info.notes.forEach((m) => playNote(c, chordDest, m, t, beat * 4 * 0.97, chords.sound));
    } else if (chords.style === "pulse") {
      if (inBar % 4 === 0) info.notes.forEach((m) => playNote(c, chordDest, m, t, beat * 0.8, chords.sound, inBar ? 0.75 : 1));
    } else if (inBar % 2 === 0) {
      const up = info.notes;
      const seq = up.length > 3 ? [0, 1, 2, 3, 2, 1, 2, 1] : [0, 1, 2, 1, 0, 1, 2, 1];
      const idx = seq[(inBar / 2) % seq.length];
      playNote(c, chordDest, up[idx] + (idx === 0 && inBar === 8 ? 12 : 0), t, beat * 0.9, chords.sound, 0.9);
    }
    if (chords.bass && (inBar === 0 || inBar === 8)) {
      playNote(c, chordDest, info.bass, t, beat * 1.9, chords.sound === "pad" ? "organ" : chords.sound, 1.1);
    }
  }
}

// Keeps the backing band sitting under a typical recorded take rather than on top of it
const BACKING_TRIM = 0.6;

const backing = { drumBus: null, chordBus: null, session: null, nextStep: 0, lastCol: -1, lastBar: -1 };

function backingInit(c, dest) {
  backing.drumBus = c.createGain();
  backing.chordBus = c.createGain();
  backing.drumBus.gain.value = drums.vol * BACKING_TRIM;
  backing.chordBus.gain.value = chords.vol * BACKING_TRIM;
  backing.drumBus.connect(dest);
  backing.chordBus.connect(dest);
}

function stepTime(n) {
  return state.startCtxTime + n * stepLen() - state.startPos;
}

function backingStart(silent) {
  backingStop();
  if (silent) return;
  const drum = ctx.createGain();
  const chord = ctx.createGain();
  drum.connect(backing.drumBus);
  chord.connect(backing.chordBus);
  backing.session = { drum, chord };
  backing.nextStep = Math.ceil(state.startPos / stepLen() - 1e-6);

  // Starting mid-bar: sound the current chord straight away rather than waiting for the next bar
  const barLen = stepLen() * STEPS;
  const into = state.startPos % barLen;
  if (chords.on && chords.slots.length && chords.style === "sustain" && into > 0.05) {
    const slot = chords.slots[Math.floor(state.startPos / barLen) % chords.slots.length];
    chordInfo(slot).notes.forEach((m) => playNote(ctx, chord, m, state.startCtxTime, barLen - into, chords.sound));
  }
  backingPump();
}

function backingStop() {
  const s = backing.session;
  if (!s) return;
  backing.session = null;
  [s.drum, s.chord].forEach((g) => {
    g.gain.setTargetAtTime(0, ctx.currentTime, 0.015);
    setTimeout(() => g.disconnect(), 300);
  });
}

function backingPump() {
  const s = backing.session;
  if (!s || !state.playing) return;
  for (;;) {
    const t = stepTime(backing.nextStep);
    if (t > ctx.currentTime + 0.15) break;
    if (t >= ctx.currentTime - 0.005) scheduleStep(ctx, s.drum, s.chord, backing.nextStep, Math.max(t, ctx.currentTime));
    backing.nextStep++;
  }
}

setInterval(backingPump, 25);

/* How long the backing should run in an exported mix (seconds). */
function backingLength(trackLen) {
  if (!backingActive()) return 0;
  const bar = stepLen() * STEPS;
  if (trackLen > 0) return Math.ceil(trackLen / bar - 1e-6) * bar;
  return bar * (chords.on ? chords.slots.length * 2 : 4);
}

function backingRender(off, dest, seconds) {
  if (!backingActive()) return;
  const drumBus = off.createGain();
  const chordBus = off.createGain();
  drumBus.gain.value = drums.vol * BACKING_TRIM;
  chordBus.gain.value = chords.vol * BACKING_TRIM;
  drumBus.connect(dest);
  chordBus.connect(dest);
  const s = stepLen();
  for (let n = 0; n * s < seconds - 1e-6; n++) scheduleStep(off, drumBus, chordBus, n, n * s);
}

/* ---------- UI ---------- */

const backingUi = { cells: [], slotEls: [], now: null };

function backingChanged() {
  if (backing.drumBus) {
    backing.drumBus.gain.setTargetAtTime(drums.vol * BACKING_TRIM, ctx.currentTime, 0.02);
    backing.chordBus.gain.setTargetAtTime(chords.vol * BACKING_TRIM, ctx.currentTime, 0.02);
  }
  saveMeta();
}

function labelled(text, control, cls) {
  const l = el("label", cls || "num");
  l.append(el("span", "", text), control);
  return l;
}

function selectOf(options, value, onChange) {
  const s = el("select");
  options.forEach(([v, text]) => {
    const o = el("option", "", text);
    o.value = v;
    s.append(o);
  });
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

function onSwitch(target, summaryEl, name) {
  const box = el("input");
  box.type = "checkbox";
  box.checked = target.on;
  const sync = () => (summaryEl.textContent = name + (target.on ? " — on" : " — off"));
  box.addEventListener("change", () => {
    target.on = box.checked;
    sync();
    backingChanged();
  });
  sync();
  return labelled("On", box, "check");
}

function renderDrums(root) {
  const panel = el("details", "panel backing");
  const summary = el("summary");
  const title = el("span");
  summary.append(title);
  const body = el("div", "backing-body");
  const controls = el("div", "group");

  const presetSel = selectOf(
    [...Object.entries(DRUM_PRESETS).map(([k, p]) => [k, p.label]), ["custom", "Custom"]],
    drums.preset,
    (v) => {
      if (v === "custom") return;
      drums.preset = v;
      drums.pattern = patternFromPreset(v);
      drums.swing = DRUM_PRESETS[v].swing || 0;
      swing.value = drums.swing;
      paint();
      backingChanged();
    }
  );
  const swing = rangeInput(0, 0.7, 0.01, drums.swing);
  swing.addEventListener("input", () => {
    drums.swing = Number(swing.value);
    backingChanged();
  });
  const vol = rangeInput(0, 1.2, 0.01, drums.vol);
  vol.addEventListener("input", () => {
    drums.vol = Number(vol.value);
    backingChanged();
  });
  const clear = el("button", "small-btn", "Clear");
  clear.addEventListener("click", () => {
    DRUM_ROWS.forEach(([row]) => drums.pattern[row].fill(false));
    drums.preset = "custom";
    presetSel.value = "custom";
    paint();
    backingChanged();
  });
  controls.append(
    onSwitch(drums, title, "Drums"),
    labelled("Beat", presetSel),
    labelled("Swing", swing, "slider"),
    labelled("Volume", vol, "slider"),
    clear
  );

  const grid = el("div", "drum-grid");
  backingUi.cells = [];
  DRUM_ROWS.forEach(([row, label]) => {
    grid.append(el("div", "drum-label", label));
    for (let i = 0; i < STEPS; i++) {
      const cell = el("button", "drum-cell" + (Math.floor(i / 4) % 2 ? " alt" : ""));
      cell.setAttribute("aria-label", label + " step " + (i + 1));
      cell.addEventListener("click", () => {
        const on = (drums.pattern[row][i] = !drums.pattern[row][i]);
        cell.classList.toggle("on", on);
        drums.preset = "custom";
        presetSel.value = "custom";
        if (on && !state.playing) {
          ensureCtx();
          drumHit(ctx, backing.drumBus, row, ctx.currentTime + 0.01);
        }
        backingChanged();
      });
      backingUi.cells.push({ cell, row, i });
      grid.append(cell);
    }
  });
  const paint = () => backingUi.cells.forEach(({ cell, row, i }) => cell.classList.toggle("on", drums.pattern[row][i]));
  paint();

  body.append(controls, grid, el("p", "fx-note", "Tap squares to build a beat. Each row is one bar of 16 steps; the shading marks the four beats. Press play to hear it loop."));
  panel.append(summary, body);
  root.append(panel);
}

function renderChords(root) {
  const panel = el("details", "panel backing");
  const summary = el("summary");
  const title = el("span");
  summary.append(title);
  const body = el("div", "backing-body");
  const controls = el("div", "group");
  const slotRow = el("div", "chord-slots");
  const hint = el("p", "fx-note");

  const presetOptions = () => [...PROGRESSIONS[chords.scale].map((p, i) => [String(i), p.label]), ["custom", "Custom"]];
  const refillPresets = () => {
    presetSel.innerHTML = "";
    presetOptions().forEach(([v, text]) => {
      const o = el("option", "", text);
      o.value = v;
      presetSel.append(o);
    });
    presetSel.value = String(chords.preset);
  };
  const usePreset = (i) => {
    chords.preset = i;
    chords.slots = slotsFromPreset(chords.scale, i);
  };

  const keySel = selectOf(KEY_NAMES.map((k, i) => [String(i), k]), String(chords.key), (v) => {
    chords.key = Number(v);
    paint();
    backingChanged();
  });
  const scaleSel = selectOf([["major", "Major"], ["minor", "Minor"]], chords.scale, (v) => {
    chords.scale = v;
    usePreset(0);
    refillPresets();
    paint();
    backingChanged();
  });
  const presetSel = selectOf([], "", (v) => {
    if (v === "custom") return;
    usePreset(Number(v));
    paint();
    backingChanged();
  });
  const soundSel = selectOf([["keys", "Electric piano"], ["organ", "Organ"], ["pad", "Soft pad"]], chords.sound, (v) => {
    chords.sound = v;
    backingChanged();
  });
  const styleSel = selectOf([["sustain", "Held chords"], ["pulse", "On every beat"], ["arp", "Arpeggio"]], chords.style, (v) => {
    chords.style = v;
    backingChanged();
  });
  const checkbox = (key, text) => {
    const box = el("input");
    box.type = "checkbox";
    box.checked = chords[key];
    box.addEventListener("change", () => {
      chords[key] = box.checked;
      paint();
      backingChanged();
    });
    const l = el("label", "check");
    l.append(box, el("span", "", text));
    return l;
  };
  const vol = rangeInput(0, 1.2, 0.01, chords.vol);
  vol.addEventListener("input", () => {
    chords.vol = Number(vol.value);
    backingChanged();
  });

  controls.append(
    onSwitch(chords, title, "Chords"),
    labelled("Key", keySel),
    scaleSel,
    labelled("Progression", presetSel),
    labelled("Sound", soundSel),
    labelled("Playing", styleSel),
    checkbox("bass", "Bass note"),
    checkbox("sevenths", "7th chords"),
    labelled("Volume", vol, "slider")
  );

  const markCustom = () => {
    chords.preset = "custom";
    presetSel.value = "custom";
  };

  function paint() {
    slotRow.innerHTML = "";
    backingUi.slotEls = [];
    chords.slots.forEach((slot, idx) => {
      const box = el("div", "chord-slot");
      const info = chordInfo(slot);
      const options = [0, 1, 2, 3, 4, 5, 6].map((d) => {
        const c = chordInfo({ d });
        return [String(d), c.name + "  (" + c.roman + ")"];
      });
      if (slot.q) options.push(["q", info.name + "  (" + info.roman + ")"]);
      const sel = selectOf(options, slot.q ? "q" : String(slot.d), (v) => {
        if (v === "q") return;
        chords.slots[idx] = { d: Number(v) };
        markCustom();
        paint();
        backingChanged();
      });
      sel.setAttribute("aria-label", "Chord for bar " + (idx + 1));
      const remove = el("button", "chip del", "✕");
      remove.title = "Remove this bar";
      remove.addEventListener("click", () => {
        if (chords.slots.length < 2) return;
        chords.slots.splice(idx, 1);
        markCustom();
        paint();
        backingChanged();
      });
      box.append(el("span", "chord-bar", "Bar " + (idx + 1)), el("strong", "chord-name", info.name), sel, remove);
      backingUi.slotEls.push(box);
      slotRow.append(box);
    });
    const add = el("button", "small-btn", "+ Add bar");
    add.addEventListener("click", () => {
      if (chords.slots.length >= 16) return;
      chords.slots.push({ d: 0 });
      markCustom();
      paint();
      backingChanged();
    });
    slotRow.append(add);
    const h = scaleHint();
    hint.textContent =
      "One chord per bar, looping. To improvise in " + KEY_NAMES[chords.key] + " " + chords.scale +
      ", these notes fit: " + h.all + ".  Can't-go-wrong five: " + h.penta + ".";
    backing.lastBar = -1;
  }

  refillPresets();
  paint();
  body.append(controls, slotRow, hint);
  panel.append(summary, body);
  root.append(panel);
}

/* Called every animation frame: light up the current drum step and chord. */
function backingTick(pos) {
  const live = state.playing && backing.session && ctx.currentTime >= state.startCtxTime;
  const step = live ? Math.floor(pos / stepLen() + 1e-6) : -1;
  const col = step < 0 || !drums.on ? -1 : step % STEPS;
  if (col !== backing.lastCol) {
    backingUi.cells.forEach(({ cell, i }) => cell.classList.toggle("now", i === col));
    backing.lastCol = col;
  }
  const bar = step < 0 || !chords.on || !chords.slots.length ? -1 : Math.floor(step / STEPS) % chords.slots.length;
  if (bar !== backing.lastBar) {
    backingUi.slotEls.forEach((box, i) => box.classList.toggle("now", i === bar));
    backing.lastBar = bar;
  }
}

function backingMeta() {
  return { drums, chords };
}

function initBacking(meta) {
  if (meta && meta.drums) {
    Object.assign(drums, meta.drums);
    DRUM_ROWS.forEach(([row]) => {
      const saved = (meta.drums.pattern || {})[row] || [];
      drums.pattern[row] = Array.from({ length: STEPS }, (_, i) => !!saved[i]);
    });
  }
  if (meta && meta.chords) {
    Object.assign(chords, meta.chords);
    if (!SCALES[chords.scale]) chords.scale = "major";
    chords.slots = (chords.slots || []).filter((s) => s && s.d >= 0 && s.d <= 6);
    if (!chords.slots.length) chords.slots = slotsFromPreset(chords.scale, 0);
  }
  const root = document.getElementById("backing");
  renderDrums(root);
  renderChords(root);
}
