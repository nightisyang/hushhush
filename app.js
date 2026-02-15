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

  // --- Noise buffer generation ---
  const SAMPLE_RATE = 44100;
  const BUFFER_DURATION = 30; // seconds

  function fillNoise(data, color) {
    const length = data.length;
    switch (color) {
      case "white":
        for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
        break;

      case "pink": {
        const rows = new Float32Array(16);
        let running = 0;
        for (let i = 0; i < length; i++) {
          let numZeros = 0, n = i;
          while (n !== 0 && (n & 1) === 0) { numZeros++; n >>= 1; }
          if (numZeros < rows.length) {
            running -= rows[numZeros];
            const v = Math.random() * 2 - 1;
            running += v;
            rows[numZeros] = v;
          }
          data[i] = (running + (Math.random() * 2 - 1)) / 17;
        }
        break;
      }

      case "brown": {
        let last = 0;
        for (let i = 0; i < length; i++) {
          last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
          data[i] = last * 3.5;
        }
        break;
      }

      case "blue": {
        let prev = 0;
        for (let i = 0; i < length; i++) {
          const w = Math.random() * 2 - 1;
          data[i] = (w - prev) * 0.5;
          prev = w;
        }
        break;
      }

      case "violet": {
        let vp1 = 0, vp2 = 0;
        for (let i = 0; i < length; i++) {
          const w = Math.random() * 2 - 1;
          data[i] = (w - 2 * vp1 + vp2) * 0.5;
          vp2 = vp1;
          vp1 = w;
        }
        break;
      }
    }
  }

  // --- Offline render: noise → filters → modulation → WAV blob ---
  async function renderBlob(color, lowCut, highCut, mod, modSpeed) {
    const length = SAMPLE_RATE * BUFFER_DURATION;
    const offline = new OfflineAudioContext(1, length, SAMPLE_RATE);

    // Create and fill noise buffer
    const buffer = offline.createBuffer(1, length, SAMPLE_RATE);
    fillNoise(buffer.getChannelData(0), color);

    const source = offline.createBufferSource();
    source.buffer = buffer;

    // Highpass
    const hp = offline.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = lowCut;
    hp.Q.value = 0.7;

    // Lowpass
    const lp = offline.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = highCut;
    lp.Q.value = 0.7;

    // Gain + LFO modulation
    const modNorm = mod / 100;
    const gain = offline.createGain();
    gain.gain.value = 1 - modNorm * 0.4;

    if (modNorm > 0) {
      const osc = offline.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 0.05 + (modSpeed / 100) * 1.95;
      const depth = offline.createGain();
      depth.gain.value = modNorm * 0.4;
      osc.connect(depth);
      depth.connect(gain.gain);
      osc.start();
    }

    source.connect(hp).connect(lp).connect(gain).connect(offline.destination);
    source.start();

    const rendered = await offline.startRendering();
    return encodeWAV(rendered);
  }

  // --- WAV encoder ---
  function encodeWAV(audioBuffer) {
    const data = audioBuffer.getChannelData(0);
    const length = data.length;
    const buf = new ArrayBuffer(44 + length * 2);
    const v = new DataView(buf);

    // RIFF header
    writeStr(v, 0, "RIFF");
    v.setUint32(4, 36 + length * 2, true);
    writeStr(v, 8, "WAVE");

    // fmt chunk
    writeStr(v, 12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);         // PCM
    v.setUint16(22, 1, true);         // mono
    v.setUint32(24, SAMPLE_RATE, true);
    v.setUint32(28, SAMPLE_RATE * 2, true);
    v.setUint16(32, 2, true);         // block align
    v.setUint16(34, 16, true);        // bits per sample

    // data chunk
    writeStr(v, 36, "data");
    v.setUint32(40, length * 2, true);

    let off = 44;
    for (let i = 0; i < length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, data[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return new Blob([buf], { type: "audio/wav" });
  }

  function writeStr(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  // --- Load blob into <audio> ---
  async function loadAudio() {
    const s = getState();
    const blob = await renderBlob(s.color, s.lowCut, s.highCut, s.modulation, s.modSpeed);
    const url = URL.createObjectURL(blob);

    const wasPlaying = playing && !audioEl.paused;
    audioEl.src = url;
    audioEl.volume = s.volume / 100;

    if (wasPlaying) {
      await audioEl.play().catch(() => {});
    }

    // Clean up old blob
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = url;
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

  // --- Service Worker ---
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js");
  }

  // --- Init ---
  renderPresets();
})();
