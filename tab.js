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
    "tuning", "mode", "bpm", "playBtn", "undoBtn", "insertBtn", "deleteBtn", "copyBtn",
    "downloadBtn", "clearBtn", "tab", "pad",
  ]) {
    els[id] = document.getElementById(id);
  }

  const state = { title: "", tuning: "standard", mode: "auto", bpm: 100, cols: [] };
  let sel = { col: 0, string: 5 }; // string 0 = lowest
  let cellEls = []; // cellEls[col][string]
  let undoStack = [];
  let newRange = null; // columns written by the latest take, shown highlighted
  let lastDigit = null;

  const tuningMidi = () => Core.TUNINGS[state.tuning].midi;

  /* ---------- Model helpers ---------- */

  /* Keep whole bars, with one empty bar after the last note so there's always room to add more. */
  function normalize() {
    const last = Core.lastUsedColumn(state.cols);
    const bars = Math.max(MIN_BARS, Math.ceil((last + 1) / STEPS) + 1);
    state.cols.length = Math.min(state.cols.length, bars * STEPS);
    while (state.cols.length < bars * STEPS) state.cols.push(Core.emptyColumn());
    sel.col = Math.max(0, Math.min(sel.col, state.cols.length - 1));
  }

  function snapshot() {
    return JSON.stringify(state.cols.slice(0, Core.lastUsedColumn(state.cols) + 1));
  }

  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 60) undoStack.shift();
  }

  function undo() {
    if (!undoStack.length || listening) return;
    state.cols = JSON.parse(undoStack.pop());
    newRange = null;
    commit();
  }

  function save() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ title: state.title, tuning: state.tuning, mode: state.mode, bpm: state.bpm, cols: JSON.parse(snapshot()) })
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
      if (saved.bpm >= 40 && saved.bpm <= 240) state.bpm = saved.bpm;
      state.title = typeof saved.title === "string" ? saved.title : "";
      if (Array.isArray(saved.cols)) {
        state.cols = saved.cols
          .filter((c) => Array.isArray(c) && c.length === 6)
          .map((c) => c.map((v) => (Number.isInteger(v) && v >= 0 && v <= 24 ? v : null)));
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
    if (listening) return;
    if (state.cols[sel.col][sel.string] === value) return;
    pushUndo();
    state.cols[sel.col][sel.string] = value;
    const keep = lastDigit;
    commit();
    lastDigit = keep;
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
    if (listening) return;
    pushUndo();
    state.cols.splice(sel.col, 0, Core.emptyColumn());
    newRange = null;
    commit();
  }

  function deleteColumn() {
    if (listening) return;
    pushUndo();
    state.cols.splice(sel.col, 1);
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
  }

  /* ---------- Turning heard notes into tab ---------- */

  let take = null; // { base, startCol } while a take is being written

  function beginTake() {
    pushUndo();
    const last = Core.lastUsedColumn(state.cols);
    take = {
      base: state.cols.slice(0, last + 1),
      startCol: last < 0 ? 0 : Math.ceil((last + 1) / STEPS) * STEPS,
      empty: last < 0,
    };
  }

  /* Lay the take's notes out after the existing tab. Called repeatedly while listening. */
  function writeTake(notes) {
    const made = Core.notesToColumns(notes, tuningMidi(), state.mode, state.bpm);
    const cols = take.base.map((c) => c.slice());
    while (cols.length < take.startCol) cols.push(Core.emptyColumn());
    state.cols = cols.concat(made.cols);
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

  let listening = null; // { ctx, stream, timer, tracker }

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
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const tracker = Core.createTracker();
    let shown = -1;

    beginTake();
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      const r = Core.detectPitch(buf, ctx.sampleRate);
      tracker.push(ctx.currentTime, r.freq, r.rms, r.loose);
      els.meter.style.width = Math.min(100, Math.sqrt(r.rms) * 220) + "%";
      showHeard(tracker.current());
      const notes = tracker.snapshot();
      if (notes.length !== shown) {
        shown = notes.length;
        writeTake(notes);
        const lastCol = newRange ? cellEls[newRange[1]] : null;
        if (lastCol) lastCol[0].scrollIntoView({ block: "nearest" });
      }
    }, 20);

    listening = { ctx, stream, timer, tracker };
    els.listenBtn.textContent = "■ Stop listening";
    els.listenBtn.classList.add("active");
    els.fileBtn.disabled = true;
    setStatus("Listening… play one note at a time, and let each one sound clearly.");
  }

  function stopListening() {
    if (!listening) return;
    const { ctx, stream, timer, tracker } = listening;
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
    listening = null;
    tracker.flush();
    els.listenBtn.textContent = "● Listen and transcribe";
    els.listenBtn.classList.remove("active");
    els.fileBtn.disabled = false;
    els.meter.style.width = "0";
    showHeard(null);
    endTake(tracker.snapshot(), "the microphone");
  }

  els.listenBtn.addEventListener("click", () => (listening ? stopListening() : startListening()));

  /* ---------- Transcribing an audio file ---------- */

  els.fileBtn.addEventListener("click", () => els.fileInput.click());

  els.fileInput.addEventListener("change", async () => {
    const file = els.fileInput.files[0];
    els.fileInput.value = "";
    if (!file || listening) return;
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
      const notes = await Core.analyzeSamples(mono, audio.sampleRate, (p) =>
        setStatus(`Listening to ${file.name}… ${Math.round(p * 100)}%`)
      );
      beginTake();
      endTake(notes, file.name);
    } catch (e) {
      setStatus(`Couldn't read ${file.name} as audio. Try a WAV, MP3 or M4A file.`);
    } finally {
      els.listenBtn.disabled = false;
      els.fileBtn.disabled = false;
    }
  });

  /* ---------- Playback ---------- */

  let playback = null; // { ctx, raf }

  function pluck(ctx, midi, when) {
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    const freq = Core.midiFreq(midi);
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(Math.min(9000, freq * 9), when);
    filter.frequency.exponentialRampToValueAtTime(Math.max(300, freq * 1.5), when + 0.5);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.22, when + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 1.3);
    osc.connect(filter).connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 1.35);
  }

  function togglePlay() {
    if (playback) stopPlayback();
    else startPlayback();
  }

  function startPlayback() {
    if (listening) return;
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
    for (let c = from; c <= last; c++) {
      state.cols[c].forEach((fret, s) => {
        if (fret !== null) pluck(ctx, tuning[s] + fret, t0 + (c - from) * step);
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
    return Core.toAscii(state.cols, tuningMidi(), header);
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
    if (listening || Core.lastUsedColumn(state.cols) < 0) return;
    stopPlayback();
    pushUndo();
    state.cols = [];
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
  els.mode.value = state.mode;
  els.bpm.value = state.bpm;
  buildPad();
  render();
})();
