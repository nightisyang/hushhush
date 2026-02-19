// ===== Configuration =====
const SAMPLE_RATE = 44100;
const DURATION = 60;       // seconds per buffer
const FADE = 5;            // crossfade seconds for regen transitions
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
const silentAudio    = document.getElementById("silentAudio");
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

// ===== State =====
let machine = HushState.create();
let genToken = 0;
let pendingBuffer = null;
let pendingSettings = null;
let pendingError = null;
let pendingRegen = false;
let activePreset = null;
let timerInterval = null;
let timerEnd = null;
let loadedSettingsKey = null;
let activeColor = "white";
let cachedVolume = 0.3;
let playingSettings = null;
let suspendedWhilePlaying = false;

// Audio source tracking (AudioBufferSourceNode is one-shot — new node per play/resume)
let activeSource = null;
let activeSourceGain = null;
let activeBuffer = null;
let fadingOutSource = null;
let fadingOutGain = null;
let activeTransition = null;

// ===== Live AudioContext =====
let liveCtx = null;
let masterGain = null;

function createSilentBlob() {
  // 1s of silent 16-bit mono PCM WAV (all-zero = true silence, even on iOS where volume is read-only)
  var n = 44100;
  var buf = new ArrayBuffer(44 + n * 2);
  var v = new DataView(buf);
  v.setUint32(0, 0x52494646, false);
  v.setUint32(4, 36 + n * 2, true);
  v.setUint32(8, 0x57415645, false);
  v.setUint32(12, 0x666d7420, false);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 44100, true);
  v.setUint32(28, 88200, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  v.setUint32(36, 0x64617461, false);
  v.setUint32(40, n * 2, true);
  return new Blob([buf], { type: 'audio/wav' });
}

function ensureLiveContext() {
  if (liveCtx) return;
  liveCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = liveCtx.createGain();
  masterGain.gain.value = cachedVolume;
  masterGain.connect(liveCtx.destination);
  silentAudio.src = URL.createObjectURL(createSilentBlob());
  silentAudio.load();

  liveCtx.onstatechange = () => {
    if ((liveCtx.state === 'suspended' || liveCtx.state === 'interrupted') && (machine.phase === 'playing' || machine.phase === 'regenerating')) {
      suspendedWhilePlaying = true;
      dispatch('AUDIO_CONTEXT_SUSPENDED');
    }
  };
}

function resumeLiveContext() {
  if (liveCtx && (liveCtx.state === 'suspended' || liveCtx.state === 'interrupted')) return liveCtx.resume();
  return Promise.resolve();
}

// ===== Buffer Cache =====
const bufferCache = new Map();

function settingsKey(s) {
  return `${s.color}|${s.lowCut}|${s.highCut}|${s.mod}|${s.modSpeed}`;
}

// ===== Offline Rendering Compat (iOS 12 webkitOfflineAudioContext) =====
// iOS 12's webkitOfflineAudioContext.startRendering() returns undefined instead
// of a Promise — it only supports the legacy oncomplete callback API.
// This shim handles both the modern Promise-based and legacy callback-based APIs.
function renderOffline(offCtx) {
  return new Promise(function(resolve, reject) {
    offCtx.oncomplete = function(e) { resolve(e.renderedBuffer); };
    var result = offCtx.startRendering();
    if (result && typeof result.then === 'function') {
      result.then(resolve, reject);
    }
  });
}

// ===== Noise Sample Generation =====
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

// ===== Generation Pipeline (seamless loop via SeamlessLoop.blend) =====
const WAV_SAMPLES = SAMPLE_RATE * DURATION;
const FADE_SAMPLES = FADE * SAMPLE_RATE;
const RENDER_SAMPLES = WAV_SAMPLES + FADE_SAMPLES;

async function generateNoise(settings) {
  const key = settingsKey(settings);
  if (bufferCache.has(key)) return bufferCache.get(key);

  const offCtx = new OfflineCtx(1, RENDER_SAMPLES, SAMPLE_RATE);
  const buffer = offCtx.createBuffer(1, RENDER_SAMPLES, SAMPLE_RATE);
  generateSamples(settings.color, buffer.getChannelData(0));

  const src = offCtx.createBufferSource();
  src.buffer = buffer;
  let node = src;

  if (settings.lowCut > 0) {
    const hp = offCtx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = settings.lowCut;
    node.connect(hp);
    node = hp;
  }

  if (settings.highCut < 20000) {
    const lp = offCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = settings.highCut;
    node.connect(lp);
    node = lp;
  }

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

  node.connect(offCtx.destination);
  src.start();

  const rendered = await renderOffline(offCtx);
  const blended = SeamlessLoop.blend(rendered.getChannelData(0), WAV_SAMPLES, FADE_SAMPLES);

  // Create AudioBuffer from blended samples (used directly by AudioBufferSourceNode)
  var resultBuffer = offCtx.createBuffer(1, WAV_SAMPLES, SAMPLE_RATE);
  resultBuffer.getChannelData(0).set(blended);

  if (bufferCache.size >= MAX_CACHE) {
    const oldest = bufferCache.keys().next().value;
    bufferCache.delete(oldest);
  }
  bufferCache.set(key, resultBuffer);

  return resultBuffer;
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

// ===== Audio Playback (AudioBufferSourceNode.loop = true) =====
function startSource(buf, gain) {
  var source = liveCtx.createBufferSource();
  source.buffer = buf;
  source.loop = true;
  source.connect(gain);
  source.start();
  return source;
}

function stopSource(src) {
  if (src) try { src.stop(); } catch(e) {}
}

// ===== UI State =====
function updatePlayUI(state) {
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
        stopSource(activeSource);
        activeSource = null;
        if (activeSourceGain) { activeSourceGain.disconnect(); activeSourceGain = null; }
        stopSource(fadingOutSource);
        fadingOutSource = null;
        if (fadingOutGain) { fadingOutGain.disconnect(); fadingOutGain = null; }
        if (activeTransition) { clearTimeout(activeTransition); activeTransition = null; }
        silentAudio.pause();
        break;
      case 'UI_LOADING':
        updatePlayUI('loading');
        break;
      case 'UI_PLAYING':
        updatePlayUI('playing');
        playingSettings = pendingSettings || getSettings();
        updateMediaSession(playingSettings);
        if (activeTransition) {
          var name = activePreset || playingSettings.color.charAt(0).toUpperCase() + playingSettings.color.slice(1) + ' noise';
          setStatus('Switching to ' + name + '\u2026');
        } else {
          setStatus('Playing');
        }
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
        if (pendingRegen) {
          // Regen: crossfade from active source to new source via GainNodes
          stopSource(fadingOutSource);
          if (fadingOutGain) fadingOutGain.disconnect();
          if (activeTransition) clearTimeout(activeTransition);

          fadingOutSource = activeSource;
          fadingOutGain = activeSourceGain;

          var now = liveCtx.currentTime;

          // Fade out old
          fadingOutGain.gain.cancelScheduledValues(0);
          fadingOutGain.gain.setValueAtTime(1, now);
          fadingOutGain.gain.linearRampToValueAtTime(0, now + FADE);

          // Fade in new
          activeSourceGain = liveCtx.createGain();
          activeSourceGain.gain.setValueAtTime(0, now);
          activeSourceGain.gain.linearRampToValueAtTime(1, now + FADE);
          activeSourceGain.connect(masterGain);
          activeSource = startSource(pendingBuffer, activeSourceGain);
          activeBuffer = pendingBuffer;
          loadedSettingsKey = settingsKey(pendingSettings);

          // After fade: clean up old source + update status
          var oldSrc = fadingOutSource;
          var oldGain = fadingOutGain;
          activeTransition = setTimeout(function() {
            activeTransition = null;
            stopSource(oldSrc);
            oldGain.disconnect();
            if (fadingOutSource === oldSrc) { fadingOutSource = null; fadingOutGain = null; }
            if (machine.phase === 'playing') {
              if (timerEnd) {
                updateTimerDisplay(true);
              } else {
                setStatus('Playing');
              }
            }
          }, FADE * 1000);

          updateMediaSession(pendingSettings || getSettings());
        } else {
          // Fresh play
          activeSourceGain = liveCtx.createGain();
          activeSourceGain.gain.value = 1;
          activeSourceGain.connect(masterGain);
          activeSource = startSource(pendingBuffer, activeSourceGain);
          activeBuffer = pendingBuffer;
          loadedSettingsKey = settingsKey(pendingSettings);
          updateMediaSession(pendingSettings || getSettings());
        }
        pendingRegen = false;
        break;
      case 'RESUME_AUDIO':
        activeSourceGain = liveCtx.createGain();
        activeSourceGain.gain.value = 1;
        activeSourceGain.connect(masterGain);
        activeSource = startSource(activeBuffer, activeSourceGain);
        updateMediaSession(getSettings());
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
    const buffer = await generateNoise(settings);
    if (token !== genToken) return;
    pendingBuffer = buffer;
    dispatch('GEN_COMPLETE');
  } catch (err) {
    if (token !== genToken) return;
    pendingError = err;
    dispatch('ERROR');
  }
}

function executeLoadAudio() {
  pendingRegen = (machine.phase === 'regenerating');
  // Buffer is already ready — no async loading needed with AudioBufferSourceNode
  dispatch('AUDIO_READY');
}

playBtn.addEventListener("click", async () => {
  ensureLiveContext();
  await resumeLiveContext();
  if (machine.phase !== 'idle') {
    dispatch('STOP');
  } else {
    suspendedWhilePlaying = false;
    // Start silent audio immediately (user gesture required on iOS)
    silentAudio.play().catch(function(){});
    const key = settingsKey(getSettings());
    dispatch(key === loadedSettingsKey && activeBuffer ? 'PLAY_CACHED' : 'PLAY');
  }
});

// ===== Media Session =====
if (hasMediaSession) {
  navigator.mediaSession.setActionHandler("play", async () => {
    ensureLiveContext();
    await resumeLiveContext();
    suspendedWhilePlaying = false;
    if (machine.phase === 'idle') {
      silentAudio.play().catch(function(){});
      const key = settingsKey(getSettings());
      dispatch(key === loadedSettingsKey && activeBuffer ? 'PLAY_CACHED' : 'PLAY');
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
  if (masterGain) masterGain.gain.value = cachedVolume;
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
  if (activeTransition) return;
  const left = Math.max(0, timerEnd - Date.now());
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  const text = "Playing \u00b7 " + m + ":" + String(s).padStart(2, "0");
  if (fade) {
    setStatus(text);
  } else {
    statusTarget = text;
    statusEl.textContent = text;
  }
}

document.getElementById("timerRow").addEventListener("click", (e) => {
  const btn = e.target.closest(".timer-btn");
  if (!btn) return;
  setTimer(parseInt(btn.dataset.min));
});

// ===== AudioContext Recovery =====
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !liveCtx) return;

  if (suspendedWhilePlaying && machine.phase === 'idle') {
    // Browser suspended AudioContext while we were playing — auto-resume
    suspendedWhilePlaying = false;
    resumeLiveContext().then(function() {
      silentAudio.play().catch(function(){});
      const key = settingsKey(getSettings());
      dispatch(key === loadedSettingsKey && activeBuffer ? 'PLAY_CACHED' : 'PLAY');
    }).catch(function(){});
  } else if (machine.phase === 'playing' || machine.phase === 'regenerating') {
    // Belt-and-suspenders: resume context if still in playing state
    resumeLiveContext();
  }
});

window.addEventListener('pageshow', async (e) => {
  if (!e.persisted || !liveCtx) return;
  // Page restored from bfcache — AudioContext may be broken
  await resumeLiveContext();
  if (suspendedWhilePlaying && machine.phase === 'idle') {
    suspendedWhilePlaying = false;
    silentAudio.play().catch(function(){});
    const key = settingsKey(getSettings());
    dispatch(key === loadedSettingsKey && activeBuffer ? 'PLAY_CACHED' : 'PLAY');
  }
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
  const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
  var chromeSteps = document.getElementById("chromeSteps");
  var safariSteps = document.getElementById("safariSteps");
  if (chromeSteps) chromeSteps.classList.toggle("highlight", !isSafari);
  if (safariSteps) safariSteps.classList.toggle("highlight", isSafari);
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

    if (s.color) {
      activeColor = s.color;
      colorBtns.forEach(b => b.classList.toggle("active", b.dataset.color === s.color));
    }

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
