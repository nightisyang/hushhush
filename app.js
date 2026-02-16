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

// Cache frequently-queried DOM elements
const volValEl       = document.getElementById("volVal");
const lowCutValEl    = document.getElementById("lowCutVal");
const highCutValEl   = document.getElementById("highCutVal");
const modValEl       = document.getElementById("modVal");
const modSpeedValEl  = document.getElementById("modSpeedVal");
const colorBtns      = document.querySelectorAll(".color-btn");
const timerBtns      = document.querySelectorAll(".timer-btn");
const hasMediaSession = 'mediaSession' in navigator;
const hasPositionState = hasMediaSession && 'setPositionState' in navigator.mediaSession;

// ===== State =====
let machine = HushState.create();
let genToken = 0;
let pendingBlob = null;
let pendingSettings = null;
let pendingError = null;
let activeAudio = audioA;
let nextAudio = audioB;
let activePreset = null;
let timerInterval = null;
let timerEnd = null;
let currentBlobA = null;
let currentBlobB = null;
let loadedSettingsKey = null;
let activeColor = "white";
let cachedVolume = 0.3;
let playingSettings = null;
let regenLoad = false;
var crossfade = CrossfadeEngine.create({ fadeDuration: FADE, bufferDuration: DURATION });
const audioElements = [audioA, audioB];

// ===== Live AudioContext for volume control (iOS ignores <audio>.volume) =====
let liveCtx = null;
let gainNode = null;
function ensureLiveContext() {
  if (liveCtx) return;
  liveCtx = new (window.AudioContext || window.webkitAudioContext)();
  gainNode = liveCtx.createGain();
  gainNode.gain.value = cachedVolume;
  gainNode.connect(liveCtx.destination);
  var srcA = liveCtx.createMediaElementSource(audioA);
  var srcB = liveCtx.createMediaElementSource(audioB);
  srcA.connect(gainNode);
  srcB.connect(gainNode);
}
function resumeLiveContext() {
  if (liveCtx && liveCtx.state === 'suspended') liveCtx.resume();
}

// ===== Blob Cache =====
const blobCache = new Map();

function settingsKey(s) {
  return `${s.color}|${s.lowCut}|${s.highCut}|${s.mod}|${s.modSpeed}`;
}

// ===== Noise Sample Generation =====
// Writes directly into a provided Float32Array to avoid allocation + copy
function generateSamples(color, out) {
  const length = out.length;

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
      const inv = 1 / 1.02;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) * inv;
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

}

// ===== WAV Encoding =====
// Pre-compute the static 44-byte WAV header (constant for all generations)
const WAV_SAMPLES = SAMPLE_RATE * DURATION;
const WAV_HEADER = new Uint8Array(44);
{
  const v = new DataView(WAV_HEADER.buffer);
  const hdr = WAV_HEADER;
  // "RIFF"
  hdr[0] = 82; hdr[1] = 73; hdr[2] = 70; hdr[3] = 70;
  v.setUint32(4, 36 + WAV_SAMPLES * 2, true);
  // "WAVE"
  hdr[8] = 87; hdr[9] = 65; hdr[10] = 86; hdr[11] = 69;
  // "fmt "
  hdr[12] = 102; hdr[13] = 109; hdr[14] = 116; hdr[15] = 32;
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  // "data"
  hdr[36] = 100; hdr[37] = 97; hdr[38] = 116; hdr[39] = 97;
  v.setUint32(40, WAV_SAMPLES * 2, true);
}

function encodeWAV(samples) {
  const len = samples.length;
  const buf = new ArrayBuffer(44 + len * 2);
  new Uint8Array(buf, 0, 44).set(WAV_HEADER);

  const pcm = new Int16Array(buf, 44);
  for (let i = 0; i < len; i++) {
    const s = samples[i];
    pcm[i] = s > 0 ? (s < 1 ? s * 0x7FFF : 0x7FFF) : (s > -1 ? s * 0x8000 : -0x8000);
  }

  return new Blob([buf], { type: "audio/wav" });
}

// ===== Generation Pipeline (single native OfflineAudioContext render) =====
async function generateNoise(settings) {
  const key = settingsKey(settings);
  if (blobCache.has(key)) return blobCache.get(key);

  const offCtx = new OfflineCtx(1, WAV_SAMPLES, SAMPLE_RATE);
  const buffer = offCtx.createBuffer(1, WAV_SAMPLES, SAMPLE_RATE);
  generateSamples(settings.color, buffer.getChannelData(0));

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
    color:    activeColor,
    lowCut:   parseInt(lowCutSlider.value),
    highCut:  parseInt(highCutSlider.value),
    mod:      parseInt(modSlider.value),
    modSpeed: parseInt(modSpeedSlider.value),
  };
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
}

function resetBuffers() {
  activeAudio = audioA;
  nextAudio = audioB;
  audioA.currentTime = 0;
  audioB.currentTime = 0;
  audioB.pause();
}

function waitForReady(el) {
  return new Promise((resolve, reject) => {
    function onReady() { el.removeEventListener("error", onError); resolve(); }
    function onError(e) { el.removeEventListener("canplaythrough", onReady); reject(e); }
    el.addEventListener("canplaythrough", onReady, { once: true });
    el.addEventListener("error", onError, { once: true });
  });
}

// ===== Crossfade Engine =====
function handleTimeUpdate(e) {
  const audio = e.target;
  if (audio !== activeAudio || (machine.phase !== 'playing' && machine.phase !== 'regenerating')) return;
  if (regenLoad) return;

  const timeLeft = audio.duration - audio.currentTime;
  if (!CrossfadeEngine.shouldTrigger(crossfade, timeLeft)) return;

  const result = CrossfadeEngine.startCrossfade(crossfade, timeLeft);
  crossfade = result.engine;

  const oldEl = audioElements[result.oldIndex];
  const newEl = audioElements[crossfade.activeIndex];
  activeAudio = newEl;
  nextAudio = oldEl;

  newEl.currentTime = result.nextStartOffset;
  newEl.play().catch(() => {});

  // Pause old element after overlap to prevent it looping back
  setTimeout(() => {
    oldEl.pause();
    crossfade = CrossfadeEngine.completeCrossfade(crossfade);
  }, result.pauseDelay);

  // Re-assert media session after crossfade so lock screen stays attached
  if (playingSettings) updateMediaSession(playingSettings);
}

audioA.addEventListener("timeupdate", handleTimeUpdate);
audioB.addEventListener("timeupdate", handleTimeUpdate);

// Bidirectional MediaSession sync: re-assert "playing" on any audio play/pause
// so the lock screen never flickers to "paused" during crossfade
function syncPlaybackState() {
  if ((machine.phase === 'playing' || machine.phase === 'regenerating') && hasMediaSession) {
    navigator.mediaSession.playbackState = 'playing';
  }
}
audioA.addEventListener("play", syncPlaybackState);
audioB.addEventListener("play", syncPlaybackState);
audioA.addEventListener("pause", syncPlaybackState);
audioB.addEventListener("pause", syncPlaybackState);

// ===== UI State =====
function updatePlayUI(state) {
  // state: "stopped" | "loading" | "playing"
  playIcon.style.display  = state === "stopped" ? "block" : "none";
  stopIcon.style.display  = state === "playing" ? "block" : "none";
  loadIcon.style.display  = state === "loading" ? "block" : "none";
  playBtn.classList.toggle("active", state === "playing");
  playBtn.classList.toggle("loading", state === "loading");
  document.body.classList.toggle("playing", state === "playing");
}

var statusTimer = null;
var statusTarget = null;
function setStatus(text) {
  if (text === statusTarget) return;
  statusTarget = text;
  clearTimeout(statusTimer);
  statusEl.classList.add('fade-out');
  statusTimer = setTimeout(function() {
    statusEl.textContent = text;
    statusEl.classList.remove('fade-out');
  }, 300);
}

// ===== Playback Control (State Machine) =====
function dispatch(event) {
  const result = HushState.send(machine, event);
  machine = result.machine;
  executeActions(result.actions);
  document.getElementById('timerRow').classList.toggle('disabled', machine.phase === 'idle');
}

function executeActions(actions) {
  for (const action of actions) {
    switch (action) {
      case 'STOP_AUDIO':
        audioA.pause();
        audioB.pause();
        break;
      case 'UI_LOADING':
        updatePlayUI('loading');
        break;
      case 'UI_PLAYING':
        updatePlayUI('playing');
        setStatus('Playing');
        playingSettings = pendingSettings || getSettings();
        updateMediaSession(playingSettings);
        break;
      case 'UI_STOPPED':
        updatePlayUI('stopped');
        setStatus('Paused');
        playingSettings = null;
        clearTimer();
        if (hasMediaSession) navigator.mediaSession.playbackState = 'paused';
        break;
      case 'GENERATE':
        executeGeneration();
        break;
      case 'LOAD_AUDIO':
        executeLoadAudio();
        break;
      case 'PLAY_AUDIO':
        if (regenLoad) {
          // Regeneration: crossfade from old audio to newly generated audio
          nextAudio.currentTime = 0;
          nextAudio.play().then(() => {
            if (machine.phase === 'playing') updateMediaSession(pendingSettings || getSettings());
          }).catch(() => {});
          const oldEl = activeAudio;
          activeAudio = nextAudio;
          nextAudio = oldEl;
          const rToken = genToken;
          const rBlob = pendingBlob;
          const rKey = settingsKey(pendingSettings);
          setTimeout(() => {
            if (rToken === genToken) {
              const url = URL.createObjectURL(rBlob);
              if (oldEl === audioA) {
                if (currentBlobA) URL.revokeObjectURL(currentBlobA);
                currentBlobA = url;
              } else {
                if (currentBlobB) URL.revokeObjectURL(currentBlobB);
                currentBlobB = url;
              }
              oldEl.src = url;
              oldEl.load();
              loadedSettingsKey = rKey;
            }
          }, FADE * 1000);
        } else {
          resetBuffers();
          activeAudio.play().then(() => {
            if (machine.phase === 'playing') updateMediaSession(pendingSettings || getSettings());
          }).catch(() => {});
          loadedSettingsKey = settingsKey(pendingSettings);
        }
        regenLoad = false;
        break;
      case 'RESUME_AUDIO':
        resetBuffers();
        activeAudio.play().then(() => {
          if (machine.phase === 'playing') updateMediaSession(getSettings());
        }).catch(() => {});
        break;
      case 'SHOW_ERROR':
        setStatus('Error: ' + (pendingError ? pendingError.message : 'Unknown'));
        if (machine.phase === 'playing') updatePlayUI('playing');
        break;
    }
  }
}

async function executeGeneration() {
  const token = ++genToken;
  const settings = getSettings();
  pendingSettings = settings;
  setStatus('Generating ' + settings.color + ' noise\u2026');

  try {
    const blob = await generateNoise(settings);
    if (token !== genToken) return;
    pendingBlob = blob;
    dispatch('GEN_COMPLETE');
  } catch (err) {
    if (token !== genToken) return;
    pendingError = err;
    dispatch('ERROR');
  }
}

async function executeLoadAudio() {
  const token = genToken;
  regenLoad = (machine.phase === 'regenerating');

  if (regenLoad) {
    // Load new audio into nextAudio only — don't disrupt current playback
    const url = URL.createObjectURL(pendingBlob);
    if (nextAudio === audioA) {
      if (currentBlobA) URL.revokeObjectURL(currentBlobA);
      currentBlobA = url;
    } else {
      if (currentBlobB) URL.revokeObjectURL(currentBlobB);
      currentBlobB = url;
    }
    nextAudio.src = url;
    nextAudio.load();
    try {
      await waitForReady(nextAudio);
      if (token !== genToken) return;
      dispatch('AUDIO_READY');
    } catch (err) {
      if (token !== genToken) return;
      pendingError = err;
      dispatch('ERROR');
    }
  } else {
    loadBlob(pendingBlob);
    try {
      await waitForReady(audioA);
      if (token !== genToken) return;
      dispatch('AUDIO_READY');
    } catch (err) {
      if (token !== genToken) return;
      pendingError = err;
      dispatch('ERROR');
    }
  }
}

playBtn.addEventListener("click", () => {
  ensureLiveContext();
  resumeLiveContext();
  if (machine.phase !== 'idle') {
    dispatch('STOP');
  } else {
    const key = settingsKey(getSettings());
    dispatch(key === loadedSettingsKey && currentBlobA ? 'PLAY_CACHED' : 'PLAY');
  }
});

// ===== Media Session =====
if (hasMediaSession) {
  navigator.mediaSession.setActionHandler("play", () => {
    resumeLiveContext();
    if (machine.phase === 'idle') {
      const key = settingsKey(getSettings());
      dispatch(key === loadedSettingsKey && currentBlobA ? 'PLAY_CACHED' : 'PLAY');
    }
  });
  navigator.mediaSession.setActionHandler("pause", () => { if (machine.phase !== 'idle') dispatch('STOP'); });
  navigator.mediaSession.setActionHandler("stop", () => { if (machine.phase !== 'idle') dispatch('STOP'); });
  navigator.mediaSession.setActionHandler("seekbackward", null);
  navigator.mediaSession.setActionHandler("seekforward", null);
  navigator.mediaSession.setActionHandler("seekto", null);
  navigator.mediaSession.setActionHandler("previoustrack", null);
  navigator.mediaSession.setActionHandler("nexttrack", null);
}

// Lock screen artwork — absolute HTTPS URLs required for iOS Now Playing
const sessionArtwork = [
  { src: new URL('icon-96.png', location.href).href,  sizes: '96x96',   type: 'image/png' },
  { src: new URL('icon-256.png', location.href).href, sizes: '256x256', type: 'image/png' },
  { src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' },
];

function getMediaTitle(settings) {
  if (activePreset) return activePreset;
  return settings.color.charAt(0).toUpperCase() + settings.color.slice(1) + " Noise";
}

function updateMediaSession(settings) {
  if (!hasMediaSession) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: getMediaTitle(settings),
    artist: "HushHush",
    album: "Baby Sleep",
    artwork: sessionArtwork,
  });
  navigator.mediaSession.playbackState = "playing";
  if (hasPositionState) {
    try {
      navigator.mediaSession.setPositionState({
        duration: DURATION,
        playbackRate: 1,
        position: activeAudio.currentTime || 0,
      });
    } catch (e) {}
  }
}

// ===== UI: Color Buttons =====
document.getElementById("colors").addEventListener("click", (e) => {
  const btn = e.target.closest(".color-btn");
  if (!btn) return;
  colorBtns.forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  activeColor = btn.dataset.color;
  settingsChanged();
});

// ===== UI: Sliders =====
function updateSliderFill(slider) {
  var min = parseFloat(slider.min), max = parseFloat(slider.max);
  slider.style.setProperty('--fill', ((parseFloat(slider.value) - min) / (max - min) * 100) + '%');
}

volSlider.addEventListener("input", () => {
  volValEl.textContent = volSlider.value + "%";
  updateSliderFill(volSlider);
  cachedVolume = parseInt(volSlider.value) / 100;
  if (gainNode) gainNode.gain.value = cachedVolume;
  saveSettings();
});

lowCutSlider.addEventListener("input", () => {
  const v = parseInt(lowCutSlider.value);
  lowCutValEl.textContent = v === 0 ? "Off" : v + " Hz";
  updateSliderFill(lowCutSlider);
});

highCutSlider.addEventListener("input", () => {
  const v = parseInt(highCutSlider.value);
  highCutValEl.textContent = v >= 20000 ? "Off" : v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : v + " Hz";
  updateSliderFill(highCutSlider);
});

const MOD_LABELS = ["Slow", "Medium", "Fast", "Very fast"];
modSlider.addEventListener("input", () => {
  const v = parseInt(modSlider.value);
  modValEl.textContent = v === 0 ? "Off" : v + "%";
  updateSliderFill(modSlider);
});

modSpeedSlider.addEventListener("input", () => {
  modSpeedValEl.textContent = MOD_LABELS[Math.min(parseInt(modSpeedSlider.value) / 25 | 0, 3)];
  updateSliderFill(modSpeedSlider);
});

function deactivatePreset() {
  if (!activePreset) return;
  activePreset = null;
  const active = presetsEl.querySelector(".preset-btn.active");
  if (active) active.classList.remove("active");
}

// Shared handler: any setting change invalidates + regenerates if playing
function settingsChanged() {
  deactivatePreset();
  loadedSettingsKey = null;
  saveSettings();
  if (machine.phase !== 'idle') dispatch('SETTINGS_CHANGED');
}

// Filters/mod use "change" event (fires on release) with debounce
function onFilterChange() {
  deactivatePreset();
  loadedSettingsKey = null;
  saveSettings();
  if (machine.phase === 'idle') return;
  dispatch('SETTINGS_CHANGED');
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

function updateSliderLabels(p) {
  lowCutValEl.textContent = p.lowCut === 0 ? "Off" : p.lowCut + " Hz";
  highCutValEl.textContent = p.highCut >= 20000 ? "Off" : p.highCut >= 1000 ? (p.highCut / 1000).toFixed(1) + " kHz" : p.highCut + " Hz";
  modValEl.textContent = p.mod === 0 ? "Off" : p.mod + "%";
  modSpeedValEl.textContent = MOD_LABELS[Math.min(p.modSpeed / 25 | 0, 3)];
  updateSliderFill(lowCutSlider);
  updateSliderFill(highCutSlider);
  updateSliderFill(modSlider);
  updateSliderFill(modSpeedSlider);
}

var sliderAnimations = new Map();

function animateSlider(slider, target, duration) {
  var prev = sliderAnimations.get(slider);
  if (prev) cancelAnimationFrame(prev);
  var from = parseFloat(slider.value);
  var to = target;
  if (from === to) { updateSliderFill(slider); return; }
  var start = performance.now();
  function step(now) {
    var t = Math.min((now - start) / duration, 1);
    // ease-out cubic
    var ease = 1 - Math.pow(1 - t, 3);
    slider.value = from + (to - from) * ease;
    updateSliderFill(slider);
    if (t < 1) {
      sliderAnimations.set(slider, requestAnimationFrame(step));
    } else {
      sliderAnimations.delete(slider);
    }
  }
  sliderAnimations.set(slider, requestAnimationFrame(step));
}

function applyPreset(preset) {
  colorBtns.forEach(b => b.classList.toggle("active", b.dataset.color === preset.color));
  activeColor = preset.color;

  animateSlider(lowCutSlider, preset.lowCut, 300);
  animateSlider(highCutSlider, preset.highCut, 300);
  animateSlider(modSlider, preset.mod, 300);
  animateSlider(modSpeedSlider, preset.modSpeed, 300);
  updateSliderLabels(preset);

  activePreset = preset.name;
  loadedSettingsKey = null;
  renderPresets();
  saveSettings();
  if (machine.phase !== 'idle') dispatch('SETTINGS_CHANGED');
}

let allPresets = [];

function renderPresets() {
  allPresets = [...BUILTIN_PRESETS, ...getCustomPresets()];
  const frag = document.createDocumentFragment();

  for (let i = 0; i < allPresets.length; i++) {
    const p = allPresets[i];
    const btn = document.createElement("button");
    btn.className = "preset-btn" + (p.custom ? " custom" : "") + (activePreset === p.name ? " active" : "");
    btn.textContent = p.name;
    btn.dataset.idx = i;
    if (p.custom) {
      const x = document.createElement("span");
      x.className = "delete-x";
      x.textContent = "\u00d7";
      btn.appendChild(x);
    }
    frag.appendChild(btn);
  }

  presetsEl.textContent = "";
  presetsEl.appendChild(frag);
}

// Event delegation — single listener for all preset buttons
presetsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".preset-btn");
  if (!btn) return;
  const p = allPresets[btn.dataset.idx];
  if (!p) return;

  if (e.target.classList.contains("delete-x")) {
    const customs = getCustomPresets().filter(c => c.name !== p.name);
    saveCustomPresetsToStorage(customs);
    if (activePreset === p.name) activePreset = null;
    btn.style.transition = 'opacity 0.2s, transform 0.2s';
    btn.style.opacity = '0';
    btn.style.transform = 'scale(0.8)';
    setTimeout(() => renderPresets(), 200);
    return;
  }
  applyPreset(p);
});

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
  if (BUILTIN_PRESETS.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    alert('"' + name + '" is a built-in preset name. Please choose a different name.');
    return;
  }

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
  timerBtns.forEach(b => b.classList.toggle("active", b.dataset.min === "0"));
  // Restore "Playing" status if still playing
  if (machine.phase === 'playing' || machine.phase === 'regenerating') {
    setStatus('Playing');
  }
}

function setTimer(minutes) {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  timerEnd = null;
  timerBtns.forEach(b => b.classList.toggle("active", b.dataset.min === "0"));
  if (minutes <= 0) {
    if (machine.phase === 'playing' || machine.phase === 'regenerating') setStatus('Playing');
    return;
  }
  if (machine.phase === 'idle') return;

  timerBtns.forEach(b => b.classList.toggle("active", parseInt(b.dataset.min) === minutes));

  timerEnd = Date.now() + minutes * 60 * 1000;
  updateTimerDisplay(true);
  timerInterval = setInterval(() => {
    if (Date.now() >= timerEnd) {
      dispatch('STOP');
      return;
    }
    updateTimerDisplay(false);
  }, 1000);
}

function updateTimerDisplay(fade) {
  if (!timerEnd) return;
  const left = Math.max(0, timerEnd - Date.now());
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  const text = "Playing \u00b7 " + m + ":" + String(s).padStart(2, "0");
  if (fade) {
    setStatus(text);
  } else {
    // Direct update — no fade for every-second ticks
    statusTarget = text;
    statusEl.textContent = text;
  }
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
  // Highlight the browser the user is currently using
  const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
  document.getElementById("chromeSteps")?.classList.toggle("highlight", !isSafari);
  document.getElementById("safariSteps")?.classList.toggle("highlight", isSafari);
  installOverlay.classList.add("open");
});

document.getElementById("installClose").addEventListener("click", () => {
  installOverlay.classList.remove("open");
});

installOverlay.addEventListener("click", (e) => {
  if (e.target === installOverlay) installOverlay.classList.remove("open");
});

// ===== Settings Persistence =====
let saveTimeout = null;
function saveSettings() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const s = getSettings();
      s.volume = parseInt(volSlider.value);
      s.preset = activePreset || null;
      localStorage.setItem("hushhush_settings", JSON.stringify(s));
    } catch (e) {}
  }, 300);
}

function restoreSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("hushhush_settings"));
    if (!s) return;

    // Color
    if (s.color) {
      activeColor = s.color;
      colorBtns.forEach(b => b.classList.toggle("active", b.dataset.color === s.color));
    }

    // Sliders
    if (s.volume != null) { volSlider.value = s.volume; volValEl.textContent = s.volume + "%"; cachedVolume = s.volume / 100; }
    if (s.lowCut != null) lowCutSlider.value = s.lowCut;
    if (s.highCut != null) highCutSlider.value = s.highCut;
    if (s.mod != null) modSlider.value = s.mod;
    if (s.modSpeed != null) modSpeedSlider.value = s.modSpeed;
    updateSliderLabels({
      lowCut: parseInt(lowCutSlider.value),
      highCut: parseInt(highCutSlider.value),
      mod: parseInt(modSlider.value),
      modSpeed: parseInt(modSpeedSlider.value),
    });

    // Restore active preset
    if (s.preset) activePreset = s.preset;
  } catch (e) {}
}

// ===== Init =====
restoreSettings();
renderPresets();
[volSlider, lowCutSlider, highCutSlider, modSlider, modSpeedSlider].forEach(updateSliderFill);
if (activePreset) {
  statusTarget = "Ready \u00b7 " + activePreset;
} else {
  statusTarget = "Ready \u00b7 " + activeColor.charAt(0).toUpperCase() + activeColor.slice(1) + " noise";
}
statusEl.textContent = statusTarget;
document.getElementById('timerRow').classList.add('disabled');

// Customize toggle
var customizeToggle = document.getElementById('customizeToggle');
var advancedControls = document.getElementById('advancedControls');
if (localStorage.getItem('hushhush_customize') === 'open') {
  advancedControls.classList.add('open');
  customizeToggle.classList.add('open');
}
customizeToggle.addEventListener('click', function() {
  var isOpen = advancedControls.classList.toggle('open');
  customizeToggle.classList.toggle('open');
  localStorage.setItem('hushhush_customize', isOpen ? 'open' : '');
});

