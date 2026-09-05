const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const A4 = 440;

const TUNINGS = {
  standard: {
    label: "Standard (E A D G B E)",
    strings: [
      { name: "E", octave: 2, freq: 82.41 },
      { name: "A", octave: 2, freq: 110.0 },
      { name: "D", octave: 3, freq: 146.83 },
      { name: "G", octave: 3, freq: 196.0 },
      { name: "B", octave: 3, freq: 246.94 },
      { name: "E", octave: 4, freq: 329.63 },
    ],
  },
  openG: {
    label: "Open G (D G D G B D)",
    strings: [
      { name: "D", octave: 2, freq: 73.42 },
      { name: "G", octave: 2, freq: 98.0 },
      { name: "D", octave: 3, freq: 146.83 },
      { name: "G", octave: 3, freq: 196.0 },
      { name: "B", octave: 3, freq: 246.94 },
      { name: "D", octave: 4, freq: 293.66 },
    ],
  },
  openD: {
    label: "Open D (D A D F# A D)",
    strings: [
      { name: "D", octave: 2, freq: 73.42 },
      { name: "A", octave: 2, freq: 110.0 },
      { name: "D", octave: 3, freq: 146.83 },
      { name: "F#", octave: 3, freq: 185.0 },
      { name: "A", octave: 3, freq: 220.0 },
      { name: "D", octave: 4, freq: 293.66 },
    ],
  },
  openD6: {
    label: "Open D6 (D A D F# A B)",
    strings: [
      { name: "D", octave: 2, freq: 73.42 },
      { name: "A", octave: 2, freq: 110.0 },
      { name: "D", octave: 3, freq: 146.83 },
      { name: "F#", octave: 3, freq: 185.0 },
      { name: "A", octave: 3, freq: 220.0 },
      { name: "B", octave: 3, freq: 246.94 },
    ],
  },
};

const micButton = document.getElementById("micButton");
const statusEl = document.getElementById("status");
const noteEl = document.getElementById("note");
const freqEl = document.getElementById("frequency");
const needleEl = document.getElementById("needle");
const stringsEl = document.getElementById("strings");
const tuningSelect = document.getElementById("tuningSelect");

let audioContext = null;
let analyser = null;
let mediaStream = null;
let rafId = null;
let listening = false;

function frequencyToNote(frequency) {
  const semitonesFromA4 = 12 * Math.log2(frequency / A4);
  const rounded = Math.round(semitonesFromA4);
  const cents = Math.round((semitonesFromA4 - rounded) * 100);
  const noteIndex = (((rounded + 9) % 12) + 12) % 12; // A is index 9 from C
  const octave = 4 + Math.floor((rounded + 9) / 12);
  return { name: NOTE_NAMES[noteIndex], octave, cents };
}

// Autocorrelation-based pitch detection (ACF2+ style)
function autoCorrelate(buffer, sampleRate) {
  const SIZE = buffer.length;

  let rms = 0;
  for (let i = 0; i < SIZE; i++) {
    rms += buffer[i] * buffer[i];
  }
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1; // too quiet

  let r1 = 0;
  let r2 = SIZE - 1;
  const threshold = 0.2;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buffer[i]) < threshold) {
      r1 = i;
      break;
    }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buffer[SIZE - i]) < threshold) {
      r2 = SIZE - i;
      break;
    }
  }

  const trimmed = buffer.slice(r1, r2);
  const newSize = trimmed.length;

  const c = new Array(newSize).fill(0);
  for (let lag = 0; lag < newSize; lag++) {
    for (let i = 0; i < newSize - lag; i++) {
      c[lag] += trimmed[i] * trimmed[i + lag];
    }
  }

  let d = 0;
  while (d < newSize - 1 && c[d] > c[d + 1]) d++;

  let maxVal = -1;
  let maxPos = -1;
  for (let i = d; i < newSize; i++) {
    if (c[i] > maxVal) {
      maxVal = c[i];
      maxPos = i;
    }
  }

  let t0 = maxPos;
  if (t0 <= 0) return -1;

  const x1 = c[t0 - 1] ?? c[t0];
  const x2 = c[t0];
  const x3 = c[t0 + 1] ?? c[t0];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) t0 -= b / (2 * a);

  return sampleRate / t0;
}

function updateDisplay(frequency) {
  if (frequency === -1 || !isFinite(frequency) || frequency <= 0) {
    noteEl.textContent = "–";
    freqEl.textContent = "0.0 Hz";
    needleEl.style.left = "50%";
    needleEl.style.background = "#4caf7d";
    return;
  }

  const { name, octave, cents } = frequencyToNote(frequency);
  noteEl.textContent = `${name}${octave}`;
  freqEl.textContent = `${frequency.toFixed(1)} Hz`;

  const clampedCents = Math.max(-50, Math.min(50, cents));
  const percent = 50 + (clampedCents / 50) * 50;
  needleEl.style.left = `${percent}%`;

  if (Math.abs(cents) <= 5) {
    needleEl.style.background = "#4caf7d";
  } else if (Math.abs(cents) <= 15) {
    needleEl.style.background = "#e0a83a";
  } else {
    needleEl.style.background = "#d9534f";
  }
}

function detectPitchLoop() {
  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);
  const frequency = autoCorrelate(buffer, audioContext.sampleRate);
  updateDisplay(frequency);
  rafId = requestAnimationFrame(detectPitchLoop);
}

async function startTuner() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    statusEl.textContent = "Microphone access denied or unavailable.";
    return;
  }

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;

  const source = audioContext.createMediaStreamSource(mediaStream);
  source.connect(analyser);

  listening = true;
  micButton.textContent = "Stop Tuner";
  micButton.classList.add("active");
  statusEl.textContent = "Listening… pluck a string";

  detectPitchLoop();
}

function stopTuner() {
  listening = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  if (audioContext) audioContext.close();

  audioContext = null;
  analyser = null;
  mediaStream = null;

  micButton.textContent = "Start Tuner";
  micButton.classList.remove("active");
  statusEl.textContent = 'Click "Start Tuner" and allow microphone access';
  updateDisplay(-1);
}

micButton.addEventListener("click", () => {
  if (listening) {
    stopTuner();
  } else {
    startTuner();
  }
});

// Reference tone playback
let toneContext = null;
let toneOscillator = null;
let toneButton = null;

function stopTone() {
  if (toneOscillator) {
    toneOscillator.stop();
    toneOscillator.disconnect();
    toneOscillator = null;
  }
  if (toneButton) {
    toneButton.classList.remove("playing");
    toneButton = null;
  }
}

function playTone(frequency, button) {
  if (toneOscillator && toneButton === button) {
    stopTone();
    return;
  }
  stopTone();

  if (!toneContext) {
    toneContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  const oscillator = toneContext.createOscillator();
  const gain = toneContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.value = 0.2;

  oscillator.connect(gain);
  gain.connect(toneContext.destination);
  oscillator.start();

  toneOscillator = oscillator;
  toneButton = button;
  button.classList.add("playing");
}

function renderStrings(tuningKey) {
  stopTone();
  stringsEl.innerHTML = "";
  TUNINGS[tuningKey].strings.forEach((string) => {
    const button = document.createElement("button");
    button.className = "string-button";
    button.innerHTML = `<strong>${string.name}${string.octave}</strong><small>${string.freq.toFixed(2)} Hz</small>`;
    button.addEventListener("click", () => playTone(string.freq, button));
    stringsEl.appendChild(button);
  });
}

Object.entries(TUNINGS).forEach(([key, tuning]) => {
  const option = document.createElement("option");
  option.value = key;
  option.textContent = tuning.label;
  tuningSelect.appendChild(option);
});

tuningSelect.addEventListener("change", () => renderStrings(tuningSelect.value));

renderStrings(tuningSelect.value);
