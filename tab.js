/* Tab Transcriber UI: listens through the mic (or reads an audio file), writes what it hears as
   guitar tab, and lets you fix it by hand. The audio analysis lives in tab-core.js. */
(function () {
  "use strict";

  const Core = window.TabCore;
  const STEPS = Core.STEPS_PER_BAR;
  const STORE_KEY = "hb-tab";
  const MIN_BARS = 4;

  const els = {};
  for (const id of [
    "listenBtn", "fileBtn", "fileInput", "heardNote", "heardPos", "meter", "status", "title",
    "tuning", "detect", "mode", "bpm", "playBtn", "undoBtn", "insertBtn", "deleteBtn", "copyBtn",
    "downloadBtn", "clearBtn", "tab", "pad",
  ]) {
    els[id] = document.getElementById(id);
  }

  // cols[c][s] is the fret on string s (0 = lowest) at column c, or null. tech[c][s] is that note's
  // technique mark: "h", "p", "/", "\\" (how it is reached from the note before it on the string)
  // or "b1".."b3" (bent up that many semitones).
  const state = { title: "", tuning: "standard", detect: "full", mode: "auto", bpm: 100, cols: [], tech: [] };
  const MARKS = ["h", "p", "/", "\\", "b1", "b2", "b3"];
  const BEND_LABEL = { b1: "½", b2: "1", b3: "1½" };
  let sel = { col: 0, string: 5 }; // string 0 = lowest
  let cellEls = []; // cellEls[col][string]
  let undoStack = [];
  let newRange = null; // columns written by the latest take, shown highlighted
  let lastDigit = null;
  let busy = false; // a recording is being worked out

  /* No editing while a take is being heard or worked out: the tab is about to be rewritten. */
  const locked = () => Boolean(listening) || busy;

  const tuningMidi = () => Core.TUNINGS[state.tuning].midi;

  /* ---------- Model helpers ---------- */

  /* Keep whole bars, with one empty bar after the last note so there's always room to add more. */
  function normalize() {
    const last = Core.lastUsedColumn(state.cols);
    const bars = Math.max(MIN_BARS, Math.ceil((last + 1) / STEPS) + 1);
    state.cols.length = Math.min(state.cols.length, bars * STEPS);
    while (state.cols.length < bars * STEPS) state.cols.push(Core.emptyColumn());
    // The technique grid shadows the fret grid: same size, and no mark without a note.
    state.tech.length = Math.min(state.tech.length, state.cols.length);
    while (state.tech.length < state.cols.length) state.tech.push(Core.emptyColumn());
    state.cols.forEach((col, c) => {
      col.forEach((v, i) => {
        if (v === null) state.tech[c][i] = null;
      });
    });
    sel.col = Math.max(0, Math.min(sel.col, state.cols.length - 1));
  }

  function snapshot() {
    const used = Core.lastUsedColumn(state.cols) + 1;
    return JSON.stringify({ cols: state.cols.slice(0, used), tech: state.tech.slice(0, used) });
  }

  function restore(text) {
    const saved = JSON.parse(text);
    state.cols = saved.cols;
    state.tech = saved.tech;
  }

  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 60) undoStack.shift();
  }

  function undo() {
    if (!undoStack.length || locked()) return;
    restore(undoStack.pop());
    newRange = null;
    commit();
  }

  function save() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          title: state.title,
          tuning: state.tuning,
          detect: state.detect,
          mode: state.mode,
          bpm: state.bpm,
          cols: JSON.parse(snapshot()).cols,
          tech: JSON.parse(snapshot()).tech,
        })
      );
    } catch (e) {
      /* storage full or unavailable: the tab still works for this visit */
    }
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY));
      if (!saved) return;
      if (Core.TUNINGS[saved.tuning]) state.tuning = saved.tuning;
      if (["auto", "bpm", "even"].includes(saved.mode)) state.mode = saved.mode;
      if (["full", "quick"].includes(saved.detect)) state.detect = saved.detect;
      if (saved.bpm >= 40 && saved.bpm <= 240) state.bpm = saved.bpm;
      state.title = typeof saved.title === "string" ? saved.title : "";
      if (Array.isArray(saved.cols)) {
        state.cols = saved.cols
          .filter((c) => Array.isArray(c) && c.length === 6)
          .map((c) => c.map((v) => (Number.isInteger(v) && v >= 0 && v <= 24 ? v : null)));
      }
      if (Array.isArray(saved.tech)) {
        state.tech = state.cols.map((_, c) => {
          const col = Array.isArray(saved.tech[c]) ? saved.tech[c] : [];
          return Core.emptyColumn().map((_, i) => (MARKS.includes(col[i]) ? col[i] : null));
        });
      }
    } catch (e) {
      /* ignore a corrupt save */
    }
  }

  function commit() {
    render();
    save();
  }

  /* ---------- Rendering ---------- */

  function render() {
    normalize();
    const style = getComputedStyle(document.documentElement);
    const cellW = parseFloat(style.getPropertyValue("--cell-w")) || 18;
    const barW = STEPS * cellW + 1;
    const room = els.tab.clientWidth - 24 - 26 - 2;
    const perRow = Math.max(1, Math.floor(room / barW));
    const bars = state.cols.length / STEPS;
    const labels = tuningMidi().map(Core.pitchClass);
    const shifts = {};
    for (const m of Core.handPositions(state.cols)) shifts[m.col] = m.fret;

    const frag = document.createDocumentFragment();
    cellEls = [];
    for (let b = 0; b < bars; b += perRow) {
      const row = document.createElement("div");
      row.className = "tab-row";
      const lab = document.createElement("div");
      lab.className = "labels";
      for (let s = 5; s >= 0; s--) {
        const span = document.createElement("span");
        span.textContent = labels[s];
        lab.appendChild(span);
      }
      row.appendChild(lab);
      for (let bar = b; bar < Math.min(bars, b + perRow); bar++) {
        const barEl = document.createElement("div");
        barEl.className = "bar";
        const num = document.createElement("span");
        num.className = "bar-num";
        num.textContent = bar + 1;
        barEl.appendChild(num);
        for (let k = 0; k < STEPS; k++) {
          const c = bar * STEPS + k;
          cellEls[c] = [];
          if (shifts[c] !== undefined) {
            const mark = document.createElement("span");
            mark.className = "pos-mark";
            mark.style.left = k * cellW + "px";
            mark.textContent = Core.roman(shifts[c]);
            mark.title = "Hand moves to fret " + shifts[c];
            barEl.appendChild(mark);
          }
          for (let s = 5; s >= 0; s--) {
            const cell = document.createElement("div");
            let cls = "cell";
            if (k % 4 === 0 && k > 0) cls += " beat";
            if (newRange && c >= newRange[0] && c <= newRange[1]) cls += " new";
            if (c === sel.col && s === sel.string) cls += " selected";
            cell.className = cls;
            cell.dataset.c = c;
            cell.dataset.s = s;
            const v = state.cols[c][s];
            if (v !== null) {
              const span = document.createElement("span");
              span.textContent = v;
              cell.appendChild(span);
              const mark = state.tech[c][s];
              if (mark) {
                const tag = document.createElement("i");
                const bend = mark[0] === "b";
                tag.className = bend ? "tech bend" : "tech";
                tag.textContent = bend ? "↑" + BEND_LABEL[mark] : mark;
                cell.appendChild(tag);
                cell.title = TECH_NAME[mark];
              }
            }
            barEl.appendChild(cell);
            cellEls[c][s] = cell;
          }
        }
        row.appendChild(barEl);
      }
      frag.appendChild(row);
    }
    els.tab.replaceChildren(frag);
    els.undoBtn.disabled = !undoStack.length;
  }

  const TECH_NAME = {
    h: "Hammer-on from the note before",
    p: "Pull-off from the note before",
    "/": "Slide up from the note before",
    "\\": "Slide down from the note before",
    b1: "Bend up a half step",
    b2: "Bend up a whole step",
    b3: "Bend up a step and a half",
  };

  function select(col, string, scroll) {
    const old = cellEls[sel.col] && cellEls[sel.col][sel.string];
    if (old) old.classList.remove("selected");
    sel = { col: Math.max(0, Math.min(col, state.cols.length - 1)), string: Math.max(0, Math.min(string, 5)) };
    const cell = cellEls[sel.col][sel.string];
    cell.classList.add("selected");
    if (scroll) cell.scrollIntoView({ block: "nearest" });
    lastDigit = null;
  }

  /* ---------- Editing ---------- */

  function setCell(value) {
    if (locked()) return;
    if (state.cols[sel.col][sel.string] === value) return;
    pushUndo();
    state.cols[sel.col][sel.string] = value;
    const keep = lastDigit;
    commit();
    lastDigit = keep;
  }

  /* Put a technique mark on the selected note; the same key again takes it off. "b" steps
     through whole-step, half-step and step-and-a-half bends. */
  function toggleTech(key) {
    if (locked()) return;
    if (state.cols[sel.col][sel.string] === null) {
      setStatus("Put a fret number here first, then mark how it's played.");
      return;
    }
    const cur = state.tech[sel.col][sel.string];
    let next;
    if (key === "b") next = { b2: "b1", b1: "b3", b3: null }[cur] || (cur === null || cur[0] !== "b" ? "b2" : null);
    else next = cur === key ? null : key;
    pushUndo();
    state.tech[sel.col][sel.string] = next;
    commit();
    setStatus(next ? TECH_NAME[next] + "." : "Mark removed.");
  }

  function typeDigit(d) {
    const now = Date.now();
    const cur = state.cols[sel.col][sel.string];
    // "1" then "2" quickly on the same spot means fret 12.
    if (
      lastDigit && lastDigit.col === sel.col && lastDigit.string === sel.string &&
      now - lastDigit.time < 1200 && (cur === 1 || cur === 2) && cur * 10 + d <= 24
    ) {
      lastDigit = null;
      setCell(cur * 10 + d);
      return;
    }
    lastDigit = { col: sel.col, string: sel.string, time: now };
    setCell(d);
  }

  function insertColumn() {
    if (locked()) return;
    pushUndo();
    state.cols.splice(sel.col, 0, Core.emptyColumn());
    state.tech.splice(sel.col, 0, Core.emptyColumn());
    newRange = null;
    commit();
  }

  function deleteColumn() {
    if (locked()) return;
    pushUndo();
    state.cols.splice(sel.col, 1);
    state.tech.splice(sel.col, 1);
    newRange = null;
    commit();
  }

  els.tab.addEventListener("click", (e) => {
    const cell = e.target.closest(".cell");
    if (!cell) return;
    select(Number(cell.dataset.c), Number(cell.dataset.s));
    els.tab.focus({ preventScroll: true });
  });

  document.addEventListener("keydown", (e) => {
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key >= "0" && e.key <= "9") {
      e.preventDefault();
      typeDigit(Number(e.key));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      select(sel.col - 1, sel.string, true);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      select(sel.col + 1, sel.string, true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      select(sel.col, sel.string + 1, true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      select(sel.col, sel.string - 1, true);
    } else if (["h", "p", "/", "\\", "b"].includes(e.key.toLowerCase())) {
      e.preventDefault();
      toggleTech(e.key.toLowerCase());
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      setCell(null);
    } else if (e.key === " " && tag !== "BUTTON") {
      e.preventDefault();
      togglePlay();
    }
  });

  function buildPad() {
    const add = (label, title, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      els.pad.appendChild(b);
    };
    add("←", "Move left", () => select(sel.col - 1, sel.string, true));
    for (let d = 0; d <= 9; d++) add(String(d), "Fret " + d, () => typeDigit(d));
    add("⌫", "Clear this note", () => setCell(null));
    add("→", "Move right", () => select(sel.col + 1, sel.string, true));
    add("h", "Hammer-on", () => toggleTech("h"));
    add("p", "Pull-off", () => toggleTech("p"));
    add("/", "Slide up", () => toggleTech("/"));
    add("\\", "Slide down", () => toggleTech("\\"));
    add("bend", "Bend: press again for half step, then a step and a half", () => toggleTech("b"));
  }

  /* ---------- Turning heard notes into tab ---------- */

  let take = null; // { base, startCol } while a take is being written

  function beginTake() {
    pushUndo();
    const last = Core.lastUsedColumn(state.cols);
    take = {
      base: state.cols.slice(0, last + 1),
      baseTech: state.tech.slice(0, last + 1),
      startCol: last < 0 ? 0 : Math.ceil((last + 1) / STEPS) * STEPS,
      empty: last < 0,
    };
  }

  /* Lay the take's notes out after the existing tab. Called repeatedly while listening. */
  function writeTake(notes) {
    const made = Core.notesToColumns(notes, tuningMidi(), state.mode, state.bpm);
    const cols = take.base.map((c) => c.slice());
    const tech = take.baseTech.map((c) => c.slice());
    while (cols.length < take.startCol) cols.push(Core.emptyColumn());
    while (tech.length < take.startCol) tech.push(Core.emptyColumn());
    state.cols = cols.concat(made.cols);
    state.tech = tech.concat(made.tech);
    newRange = made.cols.length ? [take.startCol, take.startCol + made.cols.length - 1] : null;
    take.bpm = made.bpm;
    take.count = made.count;
    render();
    return made;
  }

  function endTake(notes, source) {
    const made = writeTake(notes);
    if (!made.count) {
      undoStack.pop();
      setStatus(
        notes.length
          ? "Heard notes, but none that fit on the fretboard in this tuning."
          : "Didn't catch any notes. Try playing closer to the mic, one note at a time."
      );
    } else {
      // In "follow my playing" mode the tempo is a guess; adopt it for playback on a fresh tab.
      if (state.mode === "auto" && take.empty) {
        state.bpm = Math.max(40, Math.min(240, made.bpm));
        els.bpm.value = state.bpm;
      }
      sel.col = take.startCol;
      setStatus(`Wrote ${made.count} note${made.count === 1 ? "" : "s"} from ${source}. Tap any note to fix it.`);
    }
    take = null;
    commit();
    const first = cellEls[sel.col] && cellEls[sel.col][5];
    if (made.count && first) first.scrollIntoView({ block: "nearest" });
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  function showHeard(midi) {
    if (midi === null) {
      els.heardNote.textContent = "–";
      els.heardPos.innerHTML = "&nbsp;";
      return;
    }
    els.heardNote.textContent = Core.midiName(midi);
    const pos = Core.assignFrets([midi], tuningMidi())[0];
    els.heardPos.textContent = pos ? `string ${6 - pos.string}, fret ${pos.fret}` : "off the fretboard";
  }

  /* ---------- Listening through the microphone ---------- */

  let listening = null; // { ctx, stream, timer, tracker, chunks }

  // Collects the raw audio of a take so the chord model can go over it afterwards.
  const TAP_SOURCE = `
    class Tap extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
      process(inputs) {
        const ch = inputs[0][0];
        if (ch) {
          for (let i = 0; i < ch.length; i++) {
            this.buf[this.n++] = ch[i];
            if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
          }
        }
        return true;
      }
    }
    registerProcessor("tab-tap", Tap);`;

  function clock(seconds) {
    return Math.floor(seconds / 60) + ":" + String(Math.floor(seconds % 60)).padStart(2, "0");
  }

  async function startListening() {
    stopPlayback();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("This browser can't use the microphone here. Try 'Transcribe an audio file' instead.");
      return;
    }
    let stream;
    try {
      // The phone-call clean-up filters mangle sustained notes, so switch them off.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      setStatus("Microphone access was blocked. Allow it in your browser's site settings and try again.");
      return;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);

    // Full detection works on the whole recording once you stop, so keep the audio.
    let chunks = null;
    if (state.detect === "full" && ctx.audioWorklet) {
      try {
        const url = URL.createObjectURL(new Blob([TAP_SOURCE], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const tap = new AudioWorkletNode(ctx, "tab-tap");
        const mute = ctx.createGain();
        mute.gain.value = 0;
        source.connect(tap).connect(mute).connect(ctx.destination);
        chunks = [];
        tap.port.onmessage = (e) => chunks && chunks.push(e.data);
        if (window.TabPoly) window.TabPoly.preload().catch(() => {});
      } catch (e) {
        chunks = null;
      }
    }
    const full = chunks !== null;

    const buf = new Float32Array(analyser.fftSize);
    const tracker = Core.createTracker();
    const frames = []; // kept so hammer-ons, slides and bends can be told apart afterwards
    const began = ctx.currentTime;
    let shown = -1;

    beginTake();
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      const r = Core.detectPitch(buf, ctx.sampleRate);
      tracker.push(ctx.currentTime, r.freq, r.rms, r.loose);
      frames.push(Core.frameOf(ctx.currentTime, r));
      els.meter.style.width = Math.min(100, Math.sqrt(r.rms) * 220) + "%";
      showHeard(tracker.current());
      if (full) {
        // The tab is written when you stop; show that the take is running.
        const secs = Math.floor(ctx.currentTime - began);
        if (secs !== shown) {
          shown = secs;
          setStatus(`Recording… ${clock(secs)}. Play normally, chords and all, then press Stop and the tab is written.`);
        }
        return;
      }
      const notes = tracker.snapshot();
      if (notes.length !== shown) {
        shown = notes.length;
        writeTake(Core.markTechniques(notes, frames));
        const lastCol = newRange ? cellEls[newRange[1]] : null;
        if (lastCol) lastCol[0].scrollIntoView({ block: "nearest" });
      }
    }, 20);

    listening = { ctx, stream, timer, tracker, chunks, frames };
    els.listenBtn.textContent = full ? "■ Stop and write the tab" : "■ Stop listening";
    els.listenBtn.classList.add("active");
    els.fileBtn.disabled = true;
    if (!full) {
      setStatus(
        state.detect === "full"
          ? "Listening for single notes only: this browser can't record a take for chord detection."
          : "Listening… play one note at a time, and let each one sound clearly."
      );
    }
  }

  async function stopListening() {
    if (!listening) return;
    const { ctx, stream, timer, tracker, chunks, frames } = listening;
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    const sampleRate = ctx.sampleRate;
    ctx.close();
    listening = null;
    tracker.flush();
    els.listenBtn.textContent = "● Listen and transcribe";
    els.listenBtn.classList.remove("active");
    els.meter.style.width = "0";
    showHeard(null);

    let notes = Core.markTechniques(tracker.snapshot(), frames);
    let source = "the microphone";
    if (chunks && chunks.length) {
      const samples = new Float32Array(chunks.length * chunks[0].length);
      chunks.forEach((c, i) => samples.set(c, i * c.length));
      const better = await runChordModel(samples, sampleRate, "your take");
      if (better) notes = better;
      else source = "the microphone (single notes only: the chord model couldn't be loaded)";
    }
    els.fileBtn.disabled = false;
    endTake(notes, source);
  }

  /* Run the chord-capable model over a recording. Resolves to its notes, or null if the model
     can't be used (offline on first use, or a browser without the needed features). */
  async function runChordModel(samples, sampleRate, what) {
    if (!window.TabPoly) return null;
    busy = true;
    els.listenBtn.disabled = true;
    els.fileBtn.disabled = true;
    setStatus(`Working out ${what}… (the first time, this downloads a 2 MB model)`);
    try {
      const notes = await window.TabPoly.transcribe(samples, sampleRate, (p) =>
        setStatus(`Working out ${what}… ${Math.round(p * 100)}%`)
      );
      // The model says which notes; a second look at the sound says how each was played.
      return Core.markTechniques(notes, await Core.pitchFrames(samples, sampleRate));
    } catch (e) {
      console.warn("Chord model failed", e);
      return null;
    } finally {
      busy = false;
      els.listenBtn.disabled = false;
    }
  }

  els.listenBtn.addEventListener("click", () => (listening ? stopListening() : startListening()));

  /* ---------- Transcribing an audio file ---------- */

  els.fileBtn.addEventListener("click", () => els.fileInput.click());

  els.fileInput.addEventListener("change", async () => {
    const file = els.fileInput.files[0];
    els.fileInput.value = "";
    if (!file || locked()) return;
    stopPlayback();
    els.listenBtn.disabled = true;
    els.fileBtn.disabled = true;
    setStatus(`Reading ${file.name}…`);
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      let audio;
      try {
        audio = await ctx.decodeAudioData(await file.arrayBuffer());
      } finally {
        ctx.close();
      }
      const mono = new Float32Array(audio.length);
      for (let ch = 0; ch < audio.numberOfChannels; ch++) {
        const data = audio.getChannelData(ch);
        for (let i = 0; i < data.length; i++) mono[i] += data[i] / audio.numberOfChannels;
      }
      let notes = null;
      let source = file.name;
      if (state.detect === "full") {
        notes = await runChordModel(mono, audio.sampleRate, file.name);
        if (!notes) source += " (single notes only: the chord model couldn't be loaded)";
      }
      if (!notes) {
        busy = true;
        notes = await Core.analyzeSamples(mono, audio.sampleRate, (p) =>
          setStatus(`Listening to ${file.name}… ${Math.round(p * 100)}%`)
        );
        busy = false;
      }
      beginTake();
      endTake(notes, source);
    } catch (e) {
      setStatus(`Couldn't read ${file.name} as audio. Try a WAV, MP3 or M4A file.`);
    } finally {
      busy = false;
      els.listenBtn.disabled = false;
      els.fileBtn.disabled = false;
    }
  });

  /* ---------- Playback ---------- */

  let playback = null; // { ctx, raf }

  /* One note. `how` shapes it: hammered, pulled and slid notes have no pick attack, a slide
     glides in from `fromMidi`, and a bend pushes the pitch up after the note starts. Returns the
     note's volume control so the next note on the same string can cut it off. */
  function pluck(ctx, midi, when, how, fromMidi) {
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    const freq = Core.midiFreq(midi);
    const legato = how === "h" || how === "p" || how === "/" || how === "\\";
    osc.type = "sawtooth";
    if ((how === "/" || how === "\\") && fromMidi !== undefined) {
      osc.frequency.setValueAtTime(Core.midiFreq(fromMidi), when);
      osc.frequency.exponentialRampToValueAtTime(freq, when + 0.09);
    } else if (how && how[0] === "b") {
      osc.frequency.setValueAtTime(freq, when);
      osc.frequency.setValueAtTime(freq, when + 0.07);
      osc.frequency.exponentialRampToValueAtTime(Core.midiFreq(midi + Number(how[1])), when + 0.3);
    } else {
      osc.frequency.value = freq;
    }
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(Math.min(9000, freq * (legato ? 4 : 9)), when);
    filter.frequency.exponentialRampToValueAtTime(Math.max(300, freq * 1.5), when + 0.5);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(legato ? 0.13 : 0.22, when + (legato ? 0.012 : 0.004));
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 1.3);
    osc.connect(filter).connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 1.35);
    return gain;
  }

  function togglePlay() {
    if (playback) stopPlayback();
    else startPlayback();
  }

  function startPlayback() {
    if (locked()) return;
    const last = Core.lastUsedColumn(state.cols);
    if (last < 0) {
      setStatus("Nothing to play yet.");
      return;
    }
    let from = Math.floor(sel.col / STEPS) * STEPS;
    if (from > last) from = 0;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const step = 60 / state.bpm / 4;
    const t0 = ctx.currentTime + 0.12;
    const tuning = tuningMidi();
    const ringing = []; // per string: the note still sounding and its pitch
    for (let c = from; c <= last; c++) {
      state.cols[c].forEach((fret, s) => {
        if (fret === null) return;
        const when = t0 + (c - from) * step;
        const before = ringing[s];
        if (before) {
          // A string sounds one note at a time.
          before.gain.gain.cancelScheduledValues(when);
          before.gain.gain.setTargetAtTime(0.0001, when, 0.008);
        }
        const midi = tuning[s] + fret;
        ringing[s] = { gain: pluck(ctx, midi, when, state.tech[c][s], before ? before.midi : undefined), midi };
      });
    }
    let lit = -1;
    const light = (c) => {
      if (lit >= 0 && cellEls[lit]) cellEls[lit].forEach((el) => el.classList.remove("playing"));
      lit = c;
      if (c >= 0 && cellEls[c]) {
        cellEls[c].forEach((el) => el.classList.add("playing"));
        if (c % STEPS === 0) cellEls[c][0].scrollIntoView({ block: "nearest" });
      }
    };
    const tick = () => {
      const c = from + Math.floor((ctx.currentTime - t0) / step);
      if (c > last + 4) {
        stopPlayback();
        return;
      }
      if (c !== lit && c >= from) light(c);
      playback.raf = requestAnimationFrame(tick);
    };
    playback = { ctx, raf: 0, clear: () => light(-1) };
    playback.raf = requestAnimationFrame(tick);
    els.playBtn.textContent = "■ Stop";
  }

  function stopPlayback() {
    if (!playback) return;
    cancelAnimationFrame(playback.raf);
    playback.clear();
    playback.ctx.close();
    playback = null;
    els.playBtn.textContent = "▶ Play";
  }

  els.playBtn.addEventListener("click", togglePlay);

  /* ---------- Export ---------- */

  function asText() {
    const header = [state.title || "Untitled", `Tuning: ${Core.TUNINGS[state.tuning].label}   Tempo: ${state.bpm} BPM`].join("\n");
    return Core.toAscii(state.cols, tuningMidi(), header, 2, state.tech);
  }

  els.copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(asText());
      setStatus("Tab copied to the clipboard.");
    } catch (e) {
      setStatus("Couldn't reach the clipboard. Use Download .txt instead.");
    }
  });

  els.downloadBtn.addEventListener("click", () => {
    const name = (state.title || "tab").replace(/[^\w\- ]+/g, "").trim() || "tab";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([asText()], { type: "text/plain" }));
    a.download = name + ".txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  /* ---------- Controls ---------- */

  els.undoBtn.addEventListener("click", undo);
  els.insertBtn.addEventListener("click", insertColumn);
  els.deleteBtn.addEventListener("click", deleteColumn);

  els.clearBtn.addEventListener("click", () => {
    if (locked() || Core.lastUsedColumn(state.cols) < 0) return;
    stopPlayback();
    pushUndo();
    state.cols = [];
    state.tech = [];
    newRange = null;
    sel = { col: 0, string: 5 };
    commit();
    setStatus("Cleared. Undo brings it back.");
  });

  els.title.addEventListener("input", () => {
    state.title = els.title.value;
    save();
  });

  els.tuning.addEventListener("change", () => {
    state.tuning = els.tuning.value;
    commit();
  });

  els.detect.addEventListener("change", () => {
    state.detect = els.detect.value;
    save();
  });

  els.mode.addEventListener("change", () => {
    state.mode = els.mode.value;
    save();
  });

  els.bpm.addEventListener("change", () => {
    const v = Math.round(Number(els.bpm.value));
    state.bpm = Math.max(40, Math.min(240, v || 100));
    els.bpm.value = state.bpm;
    save();
  });

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  });

  /* ---------- Start ---------- */

  for (const [key, t] of Object.entries(Core.TUNINGS)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = t.label;
    els.tuning.appendChild(opt);
  }
  load();
  els.title.value = state.title;
  els.tuning.value = state.tuning;
  els.detect.value = state.detect;
  els.mode.value = state.mode;
  els.bpm.value = state.bpm;
  buildPad();
  render();
})();
