// ===== Configuration =====
const SAMPLE_RATE = 44100;
const DURATION = 60;       // seconds per buffer
const FADE = 5;            // crossfade overlap seconds
const MAX_CACHE = 5;
const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

// ===== Built-in Presets =====
const BUILTIN_PRESETS = [
  { name: "Shush",       color: "pink",  lowCut: 200, highCut: 4000,  mod: 0,  modSpeed: 15 },
  { name: "Womb",        color: "brown", lowCut: 20,  highCut: 500,   mod: 15, modSpeed: 8  },
  { name: "Fan",         color: "brown", lowCut: 60,  highCut: 2000,  mod: 0,  modSpeed: 15 },
  { name: "Rain",        color: "pink",  lowCut: 200, highCut: 6000,  mod: 25, modSpeed: 20 },
  { name: "Deep Sleep",  color: "brown", lowCut: 0,   highCut: 800,   mod: 40, modSpeed: 10 },
  { name: "Bright",      color: "white", lowCut: 0,   highCut: 20000, mod: 0,  modSpeed: 15 },
];

// ===== DOM =====
const audioA         = document.getElementById("audioA");
const audioB         = document.getElementById("audioB");
const playBtn        = document.getElementById("playBtn");
const playIcon       = document.getElementById("playIcon");
const stopIcon       = document.getElementById("stopIcon");
const loadIcon       = document.getElementById("loadIcon");
const statusEl       = document.getElementById("status");
const presetsEl      = document.getElementById("presets");
const volSlider      = document.getElementById("volume");
const lowCutSlider   = document.getElementById("lowCut");
const highCutSlider  = document.getElementById("highCut");
const modSlider      = document.getElementById("modulation");
const modSpeedSlider = document.getElementById("modSpeed");

// ===== State =====
let playing = false;
let generating = false;
let dirty = false;            // settings changed during generation
let activeAudio = audioA;
let nextAudio = audioB;
let crossfadeScheduled = false;
let activePreset = null;
let timerInterval = null;
let timerEnd = null;
let currentBlobA = null;
let currentBlobB = null;
let loadedSettingsKey = null;
let filterTimeout = null;

// ===== Blob Cache =====
const blobCache = new Map();

function settingsKey(s) {
  return [s.color, s.lowCut, s.highCut, s.mod, s.modSpeed].join("|");
}

// ===== Noise Sample Generation =====
function generateSamples(color, length) {
  const out = new Float32Array(length);

  switch (color) {
    case "white":
      for (let i = 0; i < length; i++) out[i] = Math.random() * 2 - 1;
      break;

    case "pink": {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
      break;
    }

    case "brown": {
      let last = 0;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        out[i] = last * 3.5;
      }
      break;
    }

    case "blue": {
      let prev = 0;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        out[i] = (w - prev) * 0.5;
        prev = w;
      }
      break;
    }

    case "violet": {
      let p1 = 0, p2 = 0;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        out[i] = (w - 2 * p1 + p2) * 0.3;
        p2 = p1;
        p1 = w;
      }
      break;
    }
  }

  return out;
}

// ===== WAV Encoding =====
function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function encodeWAV(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);

  writeString(v, 0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  writeString(v, 8, "WAVE");
  writeString(v, 12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeString(v, 36, "data");
  v.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return new Blob([buf], { type: "audio/wav" });
}

// ===== Generation Pipeline (single native OfflineAudioContext render) =====
async function generateNoise(settings) {
  const key = settingsKey(settings);
  if (blobCache.has(key)) return blobCache.get(key);

  const totalSamples = SAMPLE_RATE * DURATION;
  const raw = generateSamples(settings.color, totalSamples);

  const offCtx = new OfflineCtx(1, totalSamples, SAMPLE_RATE);
  const buffer = offCtx.createBuffer(1, totalSamples, SAMPLE_RATE);
  buffer.getChannelData(0).set(raw);

  const src = offCtx.createBufferSource();
  src.buffer = buffer;
  let node = src;

  // Highpass filter (native BiquadFilterNode)
  if (settings.lowCut > 0) {
    const hp = offCtx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = settings.lowCut;
    node.connect(hp);
    node = hp;
  }

  // Lowpass filter (native BiquadFilterNode)
  if (settings.highCut < 20000) {
    const lp = offCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = settings.highCut;
    node.connect(lp);
    node = lp;
  }

  // Tremolo (native OscillatorNode → GainNode)
  if (settings.mod > 0) {
    const depth = settings.mod / 100 * 0.8;
    const freq = 0.05 + (settings.modSpeed / 100) * 1.95;
    const tremolo = offCtx.createGain();
    tremolo.gain.value = 1 - depth * 0.5;
    const lfo = offCtx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = freq;
    const lfoAmp = offCtx.createGain();
    lfoAmp.gain.value = depth * 0.5;
    lfo.connect(lfoAmp);
    lfoAmp.connect(tremolo.gain);
    lfo.start();
    node.connect(tremolo);
    node = tremolo;
  }

  // Fade in/out (native GainNode automation)
  const fade = offCtx.createGain();
  fade.gain.setValueAtTime(0, 0);
  fade.gain.linearRampToValueAtTime(1, FADE);
  fade.gain.setValueAtTime(1, DURATION - FADE);
  fade.gain.linearRampToValueAtTime(0, DURATION);
  node.connect(fade);
  node = fade;

  node.connect(offCtx.destination);
  src.start();

  const rendered = await offCtx.startRendering();
  const blob = encodeWAV(rendered.getChannelData(0));

  if (blobCache.size >= MAX_CACHE) {
    const oldest = blobCache.keys().next().value;
    blobCache.delete(oldest);
  }
  blobCache.set(key, blob);

  return blob;
}

// ===== Settings =====
function getSettings() {
  return {
    color:    document.querySelector(".color-btn.active")?.dataset.color || "white",
    lowCut:   parseInt(lowCutSlider.value),
    highCut:  parseInt(highCutSlider.value),
    mod:      parseInt(modSlider.value),
    modSpeed: parseInt(modSpeedSlider.value),
  };
}

function getVolume() {
  return parseInt(volSlider.value) / 100;
}

// ===== Audio Buffer Management =====
function revokeOldBlobs() {
  if (currentBlobA) { URL.revokeObjectURL(currentBlobA); currentBlobA = null; }
  if (currentBlobB) { URL.revokeObjectURL(currentBlobB); currentBlobB = null; }
}

function loadBlob(blob) {
  revokeOldBlobs();
  currentBlobA = URL.createObjectURL(blob);
  currentBlobB = URL.createObjectURL(blob);
  audioA.src = currentBlobA;
  audioB.src = currentBlobB;
  audioA.load();
  audioB.load();
  audioA.volume = getVolume();
  audioB.volume = getVolume();
}

function resetBuffers() {
  activeAudio = audioA;
  nextAudio = audioB;
  audioA.currentTime = 0;
  audioB.currentTime = 0;
  audioB.pause();
  crossfadeScheduled = false;
}

function waitForReady(el) {
  return new Promise((resolve, reject) => {
    el.addEventListener("canplaythrough", resolve, { once: true });
    el.addEventListener("error", reject, { once: true });
  });
}

// ===== Crossfade Engine =====
function handleTimeUpdate(e) {
  const audio = e.target;
  if (audio !== activeAudio || !playing) return;

  const timeLeft = audio.duration - audio.currentTime;
  if (timeLeft <= FADE && !crossfadeScheduled) {
    crossfadeScheduled = true;

    nextAudio.currentTime = 0;
    nextAudio.volume = getVolume();
    nextAudio.play().catch(() => {});

    const temp = activeAudio;
    activeAudio = nextAudio;
    nextAudio = temp;
    crossfadeScheduled = false;
  }
}

function handleEnded(e) {
  e.target.currentTime = 0;
}

audioA.addEventListener("timeupdate", handleTimeUpdate);
audioB.addEventListener("timeupdate", handleTimeUpdate);
audioA.addEventListener("ended", handleEnded);
audioB.addEventListener("ended", handleEnded);

// ===== UI State =====
function updatePlayUI(state) {
  // state: "stopped" | "loading" | "playing"
  playIcon.style.display  = state === "stopped" ? "block" : "none";
  stopIcon.style.display  = state === "playing" ? "block" : "none";
  loadIcon.style.display  = state === "loading" ? "block" : "none";
  playBtn.classList.toggle("active", state === "playing");
  playBtn.classList.toggle("loading", state === "loading");
}

// ===== Playback Control =====
async function loadAndPlay() {
  // If already generating, mark dirty so current run restarts with latest settings
  if (generating) {
    dirty = true;
    audioA.pause();
    audioB.pause();
    return;
  }

  const settings = getSettings();
  const key = settingsKey(settings);

  // Fast resume: same settings already loaded
  if (key === loadedSettingsKey && currentBlobA) {
    resetBuffers();
    activeAudio.volume = getVolume();
    await activeAudio.play();
    playing = true;
    updatePlayUI("playing");
    updateMediaSession(settings);
    return;
  }

  // Stop current audio, show loader
  audioA.pause();
  audioB.pause();
  generating = true;
  updatePlayUI("loading");

  do {
    dirty = false;
    const s = getSettings();
    statusEl.textContent = "Generating " + s.color + " noise\u2026";

    try {
      const blob = await generateNoise(s);
      if (dirty) continue;

      loadBlob(blob);
      await waitForReady(audioA);
      if (dirty) continue;

      resetBuffers();
      activeAudio.volume = getVolume();
      await activeAudio.play();
      playing = true;
      loadedSettingsKey = settingsKey(s);
      statusEl.textContent = "Playing";
      updateMediaSession(s);
    } catch (err) {
      statusEl.textContent = "Error: " + err.message;
      playing = false;
      break;
    }
  } while (dirty);

  generating = false;
  updatePlayUI(playing ? "playing" : "stopped");
}

function stopPlaying() {
  audioA.pause();
  audioB.pause();
  playing = false;
  crossfadeScheduled = false;
  statusEl.textContent = "";
  clearTimer();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = "paused";
  }
  updatePlayUI("stopped");
}

playBtn.addEventListener("click", () => {
  if (playing || generating) stopPlaying();
  else loadAndPlay();
});

// ===== Media Session =====
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => { if (!playing) loadAndPlay(); });
  navigator.mediaSession.setActionHandler("pause", () => { if (playing) stopPlaying(); });
  navigator.mediaSession.setActionHandler("stop", () => { if (playing) stopPlaying(); });
  navigator.mediaSession.setActionHandler("seekbackward", null);
  navigator.mediaSession.setActionHandler("seekforward", null);
  navigator.mediaSession.setActionHandler("seekto", null);
  navigator.mediaSession.setActionHandler("previoustrack", null);
  navigator.mediaSession.setActionHandler("nexttrack", null);
}

function updateMediaSession(settings) {
  if (!("mediaSession" in navigator)) return;
  const label = settings.color.charAt(0).toUpperCase() + settings.color.slice(1);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: label + " Noise",
    artist: "HushHush",
    album: "Baby Sleep",
  });
  navigator.mediaSession.playbackState = "playing";
  if ("setPositionState" in navigator.mediaSession) {
    try { navigator.mediaSession.setPositionState({}); } catch (e) {}
  }
}

// ===== UI: Color Buttons =====
document.getElementById("colors").addEventListener("click", (e) => {
  const btn = e.target.closest(".color-btn");
  if (!btn) return;
  document.querySelectorAll(".color-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  settingsChanged();
});

// ===== UI: Sliders =====
volSlider.addEventListener("input", () => {
  document.getElementById("volVal").textContent = volSlider.value + "%";
  const vol = getVolume();
  audioA.volume = vol;
  audioB.volume = vol;
});

lowCutSlider.addEventListener("input", () => {
  const v = parseInt(lowCutSlider.value);
  document.getElementById("lowCutVal").textContent = v === 0 ? "Off" : v + " Hz";
});

highCutSlider.addEventListener("input", () => {
  const v = parseInt(highCutSlider.value);
  document.getElementById("highCutVal").textContent = v >= 20000 ? "Off" : v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : v + " Hz";
});

modSlider.addEventListener("input", () => {
  const v = parseInt(modSlider.value);
  document.getElementById("modVal").textContent = v === 0 ? "Off" : v + "%";
});

modSpeedSlider.addEventListener("input", () => {
  const v = parseInt(modSpeedSlider.value);
  const labels = ["Slow", "Medium", "Fast", "Very fast"];
  document.getElementById("modSpeedVal").textContent = labels[Math.min(Math.floor(v / 25), 3)];
});

// Shared handler: any setting change invalidates + regenerates if playing
function settingsChanged() {
  activePreset = null;
  loadedSettingsKey = null;
  renderPresets();
  if (playing || generating) loadAndPlay();
}

// Filters/mod use "change" event (fires on release) with debounce
function onFilterChange() {
  activePreset = null;
  loadedSettingsKey = null;
  renderPresets();
  if (!playing && !generating) return;
  clearTimeout(filterTimeout);
  filterTimeout = setTimeout(() => loadAndPlay(), 600);
}

lowCutSlider.addEventListener("change", onFilterChange);
highCutSlider.addEventListener("change", onFilterChange);
modSlider.addEventListener("change", onFilterChange);
modSpeedSlider.addEventListener("change", onFilterChange);

// ===== UI: Presets =====
function getCustomPresets() {
  try { return JSON.parse(localStorage.getItem("hushhush_presets") || "[]"); }
  catch { return []; }
}

function saveCustomPresetsToStorage(list) {
  localStorage.setItem("hushhush_presets", JSON.stringify(list));
}

function applyPreset(preset) {
  document.querySelectorAll(".color-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.color === preset.color);
  });

  lowCutSlider.value = preset.lowCut;
  lowCutSlider.dispatchEvent(new Event("input"));
  highCutSlider.value = preset.highCut;
  highCutSlider.dispatchEvent(new Event("input"));
  modSlider.value = preset.mod;
  modSlider.dispatchEvent(new Event("input"));
  modSpeedSlider.value = preset.modSpeed;
  modSpeedSlider.dispatchEvent(new Event("input"));

  activePreset = preset.name;
  loadedSettingsKey = null;
  renderPresets();
  if (playing || generating) loadAndPlay();
}

function renderPresets() {
  presetsEl.innerHTML = "";
  const all = [...BUILTIN_PRESETS, ...getCustomPresets()];

  all.forEach(p => {
    const btn = document.createElement("button");
    btn.className = "preset-btn" + (p.custom ? " custom" : "") + (activePreset === p.name ? " active" : "");
    btn.textContent = p.name;
    if (p.custom) {
      const x = document.createElement("span");
      x.className = "delete-x";
      x.textContent = "\u00d7";
      btn.appendChild(x);
    }

    btn.addEventListener("click", (e) => {
      if (e.target.classList.contains("delete-x")) {
        const customs = getCustomPresets().filter(c => c.name !== p.name);
        saveCustomPresetsToStorage(customs);
        if (activePreset === p.name) activePreset = null;
        renderPresets();
        return;
      }
      applyPreset(p);
    });

    presetsEl.appendChild(btn);
  });
}

// ===== UI: Save Preset Dialog =====
const dialogOverlay = document.getElementById("dialogOverlay");
const presetNameInput = document.getElementById("presetName");

document.getElementById("savePreset").addEventListener("click", () => {
  presetNameInput.value = "";
  dialogOverlay.classList.add("open");
  presetNameInput.focus();
});

document.getElementById("dialogCancel").addEventListener("click", () => {
  dialogOverlay.classList.remove("open");
});

document.getElementById("dialogSave").addEventListener("click", () => {
  const name = presetNameInput.value.trim();
  if (!name) return;

  const settings = getSettings();
  const customs = getCustomPresets().filter(c => c.name !== name);
  customs.push({
    name,
    color: settings.color,
    lowCut: settings.lowCut,
    highCut: settings.highCut,
    mod: settings.mod,
    modSpeed: settings.modSpeed,
    custom: true,
  });
  saveCustomPresetsToStorage(customs);
  activePreset = name;
  renderPresets();
  dialogOverlay.classList.remove("open");
});

presetNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("dialogSave").click();
  if (e.key === "Escape") dialogOverlay.classList.remove("open");
});

dialogOverlay.addEventListener("click", (e) => {
  if (e.target === dialogOverlay) dialogOverlay.classList.remove("open");
});

// ===== UI: Sleep Timer =====
function clearTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  timerEnd = null;
  document.getElementById("timerDisplay").textContent = "";
  document.querySelectorAll(".timer-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.min === "0");
  });
}

function setTimer(minutes) {
  clearTimer();
  if (minutes <= 0) return;

  document.querySelectorAll(".timer-btn").forEach(b => {
    b.classList.toggle("active", parseInt(b.dataset.min) === minutes);
  });

  timerEnd = Date.now() + minutes * 60 * 1000;
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    if (Date.now() >= timerEnd) {
      stopPlaying();
      return;
    }
    updateTimerDisplay();
  }, 1000);
}

function updateTimerDisplay() {
  if (!timerEnd) return;
  const left = Math.max(0, timerEnd - Date.now());
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  document.getElementById("timerDisplay").textContent = m + ":" + String(s).padStart(2, "0") + " remaining";
}

document.getElementById("timerRow").addEventListener("click", (e) => {
  const btn = e.target.closest(".timer-btn");
  if (!btn) return;
  setTimer(parseInt(btn.dataset.min));
});

// ===== Audio Session API =====
if (navigator.audioSession) {
  navigator.audioSession.type = "playback";
}

// ===== UI: QR & Install Modals =====
const qrOverlay = document.getElementById("qrOverlay");
const installOverlay = document.getElementById("installOverlay");

document.getElementById("qrBtn").addEventListener("click", () => {
  qrOverlay.classList.add("open");
});

document.getElementById("qrClose").addEventListener("click", () => {
  qrOverlay.classList.remove("open");
});

qrOverlay.addEventListener("click", (e) => {
  if (e.target === qrOverlay) qrOverlay.classList.remove("open");
});

document.getElementById("installBtn").addEventListener("click", () => {
  // Detect platform and highlight relevant section
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  document.getElementById("iosSteps").classList.toggle("highlight", isIOS || !isAndroid);
  document.getElementById("androidSteps").classList.toggle("highlight", isAndroid);
  installOverlay.classList.add("open");
});

document.getElementById("installClose").addEventListener("click", () => {
  installOverlay.classList.remove("open");
});

installOverlay.addEventListener("click", (e) => {
  if (e.target === installOverlay) installOverlay.classList.remove("open");
});

// ===== Init =====
renderPresets();
statusEl.textContent = "Ready";
