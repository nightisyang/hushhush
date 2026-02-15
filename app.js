(() => {
  let playing = false, toggling = false;
  let currentBlobUrl = null;
  let renderTimeout = null;
  let timerInterval = null, timerEnd = null;

  // --- DOM refs ---
  const audioEl      = document.getElementById("silentAudio");
  const playBtn      = document.getElementById("playBtn");
  const playIcon     = document.getElementById("playIcon");
  const stopIcon     = document.getElementById("stopIcon");
  const volSlider    = document.getElementById("volume");
  const volVal       = document.getElementById("volVal");
  const lowCutSlider = document.getElementById("lowCut");
  const lowCutVal    = document.getElementById("lowCutVal");
  const highCutSlider= document.getElementById("highCut");
  const highCutVal   = document.getElementById("highCutVal");
  const modSlider    = document.getElementById("modulation");
  const modVal       = document.getElementById("modVal");
  const modSpeedSldr = document.getElementById("modSpeed");
  const modSpeedVal  = document.getElementById("modSpeedVal");
  const presetsEl    = document.getElementById("presets");
  const timerDisp    = document.getElementById("timerDisplay");

  // --- Built-in presets ---
  const BUILTIN_PRESETS = [
    { name: "Deep Sleep",  color: "brown", volume: 25, lowCut: 0,   highCut: 800,   modulation: 40, modSpeed: 10 },
    { name: "Focus",       color: "pink",  volume: 20, lowCut: 80,  highCut: 8000,  modulation: 0,  modSpeed: 15 },
    { name: "Rain-ish",    color: "pink",  volume: 35, lowCut: 200, highCut: 6000,  modulation: 25, modSpeed: 20 },
    { name: "Fan",         color: "brown", volume: 30, lowCut: 60,  highCut: 2000,  modulation: 0,  modSpeed: 15 },
    { name: "Bright",      color: "white", volume: 20, lowCut: 0,   highCut: 20000, modulation: 0,  modSpeed: 15 },
  ];

  // --- Server-side WAV generation (nginx serves the result as a real file) ---
  async function generateOnServer(color, lowCut, highCut, modulation, modSpeed) {
    const res = await fetch("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color, lowCut, highCut, modulation, modSpeed }),
    });
    if (!res.ok) throw new Error("Generate failed");
  }

  async function loadAudio() {
    const s = getState();
    const wasPlaying = playing && !audioEl.paused;

    await generateOnServer(s.color, s.lowCut, s.highCut, s.modulation, s.modSpeed);

    // Load the server-generated WAV (real nginx URL — iOS keeps this alive)
    audioEl.src = "/current-noise.wav?" + Date.now();
    audioEl.volume = s.volume / 100;

    await new Promise((resolve) => {
      audioEl.addEventListener("canplaythrough", resolve, { once: true });
      setTimeout(resolve, 5000);
    });

    if (wasPlaying) {
      await audioEl.play().catch(() => {});
    }
  }

  // Debounced version for slider changes (avoids excessive re-renders)
  function scheduleRerender() {
    if (!playing) return;
    clearTimeout(renderTimeout);
    renderTimeout = setTimeout(() => loadAudio(), 250);
  }

  // --- State ---
  function getActiveColor() {
    return document.querySelector(".color-btn.active")?.dataset.color || "white";
  }

  function getState() {
    return {
      color: getActiveColor(),
      volume: parseInt(volSlider.value),
      lowCut: parseInt(lowCutSlider.value),
      highCut: parseInt(highCutSlider.value),
      modulation: parseInt(modSlider.value),
      modSpeed: parseInt(modSpeedSldr.value),
    };
  }

  function applyState(s) {
    document.querySelectorAll(".color-btn").forEach(b => b.classList.toggle("active", b.dataset.color === s.color));

    volSlider.value = s.volume;
    volVal.textContent = s.volume + "%";

    lowCutSlider.value = s.lowCut;
    lowCutVal.textContent = s.lowCut === 0 ? "Off" : s.lowCut + " Hz";

    highCutSlider.value = s.highCut;
    updateHighCutLabel();

    modSlider.value = s.modulation;
    modVal.textContent = s.modulation === 0 ? "Off" : s.modulation + "%";

    modSpeedSldr.value = s.modSpeed;
    updateModSpeedLabel();

    // Update volume immediately (no re-render needed)
    audioEl.volume = s.volume / 100;

    // Re-render if playing (new color/filters/modulation)
    if (playing) loadAudio();
  }

  // --- Custom presets (localStorage) ---
  function loadCustomPresets() {
    try { return JSON.parse(localStorage.getItem("noise_presets") || "[]"); }
    catch { return []; }
  }
  function saveCustomPresets(list) {
    localStorage.setItem("noise_presets", JSON.stringify(list));
  }

  function renderPresets() {
    presetsEl.innerHTML = "";
    const all = [...BUILTIN_PRESETS.map(p => ({ ...p, builtin: true })), ...loadCustomPresets().map(p => ({ ...p, builtin: false }))];
    all.forEach((p, i) => {
      const btn = document.createElement("button");
      btn.className = "preset-btn" + (p.builtin ? "" : " custom");
      btn.textContent = p.name;
      if (!p.builtin) {
        const x = document.createElement("span");
        x.className = "delete-x";
        x.textContent = "\u00d7";
        btn.appendChild(x);
      }
      btn.addEventListener("click", (e) => {
        if (e.target.classList.contains("delete-x")) {
          const customs = loadCustomPresets();
          customs.splice(i - BUILTIN_PRESETS.length, 1);
          saveCustomPresets(customs);
          renderPresets();
          return;
        }
        document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        applyState(p);
      });
      presetsEl.appendChild(btn);
    });
  }

  // --- Save preset dialog ---
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
  dialogOverlay.addEventListener("click", (e) => {
    if (e.target === dialogOverlay) dialogOverlay.classList.remove("open");
  });
  document.getElementById("dialogSave").addEventListener("click", () => {
    const name = presetNameInput.value.trim();
    if (!name) return;
    const customs = loadCustomPresets();
    customs.push({ name, ...getState() });
    saveCustomPresets(customs);
    dialogOverlay.classList.remove("open");
    renderPresets();
  });
  presetNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("dialogSave").click();
  });

  // --- Play / Stop ---
  async function toggle() {
    if (toggling) return;
    toggling = true;

    try {
      if (!playing) {
        await loadAudio();
        await audioEl.play();
        playing = true;
      } else {
        audioEl.pause();
        playing = false;
        clearTimer();
        timerDisp.textContent = "";
        document.querySelectorAll(".timer-btn").forEach(b => b.classList.remove("active"));
        document.querySelector('.timer-btn[data-min="0"]').classList.add("active");
      }
      updatePlayBtn();
      updateMediaSession();
    } finally {
      toggling = false;
    }
  }

  function updatePlayBtn() {
    playIcon.style.display = playing ? "none" : "block";
    stopIcon.style.display = playing ? "block" : "none";
    playBtn.classList.toggle("active", playing);
  }

  // --- Media Session (lock screen controls on iOS & Android) ---
  function updateMediaSession() {
    if (!("mediaSession" in navigator)) return;
    if (playing) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: getActiveColor().charAt(0).toUpperCase() + getActiveColor().slice(1) + " Noise",
        artist: "HushHush",
        album: "Ambient Noise",
      });
      navigator.mediaSession.playbackState = "playing";
    } else {
      navigator.mediaSession.playbackState = "paused";
    }
  }

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", toggle);
    navigator.mediaSession.setActionHandler("pause", toggle);
    navigator.mediaSession.setActionHandler("stop", () => { if (playing) toggle(); });
  }

  playBtn.addEventListener("click", toggle);

  // --- Color buttons ---
  document.getElementById("colors").addEventListener("click", (e) => {
    const btn = e.target.closest(".color-btn");
    if (!btn) return;
    document.querySelectorAll(".color-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    clearActivePreset();
    updateMediaSession();
    scheduleRerender();
  });

  // --- Volume (real-time via audio.volume, no re-render) ---
  volSlider.addEventListener("input", () => {
    volVal.textContent = volSlider.value + "%";
    audioEl.volume = parseInt(volSlider.value) / 100;
    clearActivePreset();
  });

  // --- Low cut (requires re-render) ---
  lowCutSlider.addEventListener("input", () => {
    const v = parseInt(lowCutSlider.value);
    lowCutVal.textContent = v === 0 ? "Off" : v + " Hz";
    clearActivePreset();
    scheduleRerender();
  });

  // --- High cut (requires re-render) ---
  function updateHighCutLabel() {
    const v = parseInt(highCutSlider.value);
    if (v >= 20000) highCutVal.textContent = "Off";
    else if (v >= 1000) highCutVal.textContent = (v / 1000).toFixed(1) + " kHz";
    else highCutVal.textContent = v + " Hz";
  }
  highCutSlider.addEventListener("input", () => {
    updateHighCutLabel();
    clearActivePreset();
    scheduleRerender();
  });

  // --- Modulation (requires re-render) ---
  modSlider.addEventListener("input", () => {
    const m = parseInt(modSlider.value);
    modVal.textContent = m === 0 ? "Off" : m + "%";
    clearActivePreset();
    scheduleRerender();
  });

  // --- Mod speed (requires re-render) ---
  function updateModSpeedLabel() {
    const v = parseInt(modSpeedSldr.value);
    if (v < 25) modSpeedVal.textContent = "Slow";
    else if (v < 50) modSpeedVal.textContent = "Medium";
    else if (v < 75) modSpeedVal.textContent = "Fast";
    else modSpeedVal.textContent = "Very fast";
  }
  modSpeedSldr.addEventListener("input", () => {
    updateModSpeedLabel();
    clearActivePreset();
    scheduleRerender();
  });

  function clearActivePreset() {
    document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
  }

  // --- Timer ---
  document.querySelector(".timer-row").addEventListener("click", (e) => {
    const btn = e.target.closest(".timer-btn");
    if (!btn) return;
    document.querySelectorAll(".timer-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const min = parseInt(btn.dataset.min, 10);
    clearTimer();
    if (min > 0) startTimer(min);
    else timerDisp.textContent = "";
  });

  function startTimer(min) {
    timerEnd = Date.now() + min * 60 * 1000;
    updateTimerDisplay();
    timerInterval = setInterval(() => {
      if (Date.now() >= timerEnd) {
        clearTimer();
        if (playing) toggle();
        timerDisp.textContent = "";
        document.querySelectorAll(".timer-btn").forEach(b => b.classList.remove("active"));
        document.querySelector('.timer-btn[data-min="0"]').classList.add("active");
      } else {
        updateTimerDisplay();
      }
    }, 1000);
  }

  function updateTimerDisplay() {
    if (!timerEnd) return;
    const diff = Math.max(0, timerEnd - Date.now());
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    timerDisp.textContent = `${m}:${s.toString().padStart(2, "0")} remaining`;
  }

  function clearTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    timerEnd = null;
  }

  // --- Audio Session API (tells iOS this is a playback app) ---
  if (navigator.audioSession) {
    navigator.audioSession.type = "playback";
  }

  // --- Init ---
  renderPresets();
})();
