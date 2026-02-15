(() => {
  let ctx, sourceNode, highpassNode, lowpassNode, volumeGain, lfo, lfoDepth;
  let playing = false, toggling = false;
  let currentBufferedColor = null;
  let timerInterval = null, timerEnd = null;

  // --- Silent audio for iOS/iPadOS background playback ---
  const silentAudio = document.getElementById("silentAudio");

  // --- DOM refs ---
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

  // --- Noise buffer generation (runs once per color change, then loops natively) ---
  const BUFFER_DURATION = 60; // seconds — long enough that looping is inaudible

  function generateBuffer(color) {
    const sr = ctx.sampleRate;
    const length = sr * BUFFER_DURATION;
    const buffer = ctx.createBuffer(1, length, sr);
    const data = buffer.getChannelData(0);

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

    return buffer;
  }

  function startSource(color) {
    if (sourceNode) {
      sourceNode.stop();
      sourceNode.disconnect();
    }
    sourceNode = ctx.createBufferSource();
    sourceNode.buffer = generateBuffer(color);
    sourceNode.loop = true;
    sourceNode.connect(highpassNode);
    sourceNode.start();
    currentBufferedColor = color;
  }

  // --- Audio parameter helpers (all native Web Audio, zero JS on audio thread) ---
  function setFilter(node, value) {
    if (node && ctx) node.frequency.setTargetAtTime(value, ctx.currentTime, 0.02);
  }

  // Volume and modulation are coupled: both affect the gain node and LFO depth.
  //
  // Original formula:  vol *= 1 - mod * 0.8 * (1 - wave)
  //   where wave = 0.5 * (1 + sin(t)), oscillating 0..1
  //
  // Expanded:  gain = vol * (1 - mod*0.4) + vol * mod * 0.4 * sin(t)
  //   → gainNode center = vol * (1 - mod*0.4)
  //   → LFO depth        = vol * mod * 0.4
  function updateVolumeAndMod() {
    if (!volumeGain || !lfoDepth || !ctx) return;
    const vol = parseInt(volSlider.value) / 100;
    const mod = parseInt(modSlider.value) / 100;
    volumeGain.gain.setTargetAtTime(vol * (1 - mod * 0.4), ctx.currentTime, 0.02);
    lfoDepth.gain.setTargetAtTime(vol * mod * 0.4, ctx.currentTime, 0.02);
  }

  function updateModSpeed() {
    if (!lfo || !ctx) return;
    const speed = parseInt(modSpeedSldr.value) / 100;
    const hz = 0.05 + speed * 1.95; // 0.05–2.0 Hz
    lfo.frequency.setTargetAtTime(hz, ctx.currentTime, 0.02);
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
    // UI updates (always safe, no audio dependency)
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

    // Push to audio (no-ops if not initialized)
    if (ctx && s.color !== currentBufferedColor) startSource(s.color);
    setFilter(highpassNode, s.lowCut);
    setFilter(lowpassNode, s.highCut);
    updateVolumeAndMod();
    updateModSpeed();
  }

  function syncAllParams() {
    setFilter(highpassNode, parseInt(lowCutSlider.value));
    setFilter(lowpassNode, parseInt(highCutSlider.value));
    updateVolumeAndMod();
    updateModSpeed();
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

  // --- Audio init ---
  async function initAudio() {
    const newCtx = new AudioContext({ sampleRate: 44100 });
    try {
      const hp = newCtx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 0;
      hp.Q.value = 0.7;

      const lp = newCtx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 20000;
      lp.Q.value = 0.7;

      const vg = newCtx.createGain();

      // LFO: oscillator → depth scaler → volumeGain.gain
      const osc = newCtx.createOscillator();
      osc.type = "sine";
      const ld = newCtx.createGain();
      ld.gain.value = 0;
      osc.connect(ld);
      ld.connect(vg.gain);
      osc.start();

      // Chain: source → highpass → lowpass → volumeGain → destination
      hp.connect(lp).connect(vg).connect(newCtx.destination);

      // Commit to module state only after everything succeeds
      ctx = newCtx;
      highpassNode = hp;
      lowpassNode = lp;
      volumeGain = vg;
      lfo = osc;
      lfoDepth = ld;

      startSource(getActiveColor());
      syncAllParams();
    } catch (err) {
      newCtx.close();
      throw err;
    }
  }

  // --- Play / Stop ---
  async function toggle() {
    if (toggling) return;
    toggling = true;

    try {
      if (!playing) {
        if (!ctx) {
          await initAudio();
        } else if (getActiveColor() !== currentBufferedColor) {
          startSource(getActiveColor());
        }
        if (ctx.state === "suspended") await ctx.resume();
        silentAudio.play().catch(() => {});
        playing = true;
      } else {
        if (ctx) await ctx.suspend();
        silentAudio.pause();
        playing = false;
        clearTimer();
        timerDisp.textContent = "";
        document.querySelectorAll(".timer-btn").forEach(b => b.classList.remove("active"));
        document.querySelector('.timer-btn[data-min="0"]').classList.add("active");
      }
      updatePlayBtn();
    } finally {
      toggling = false;
    }
  }

  function updatePlayBtn() {
    playIcon.style.display = playing ? "none" : "block";
    stopIcon.style.display = playing ? "block" : "none";
    playBtn.classList.toggle("active", playing);
  }

  playBtn.addEventListener("click", toggle);

  // --- Color buttons ---
  document.getElementById("colors").addEventListener("click", (e) => {
    const btn = e.target.closest(".color-btn");
    if (!btn) return;
    document.querySelectorAll(".color-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    if (ctx && btn.dataset.color !== currentBufferedColor) {
      startSource(btn.dataset.color);
    }
    clearActivePreset();
  });

  // --- Volume ---
  volSlider.addEventListener("input", () => {
    volVal.textContent = volSlider.value + "%";
    updateVolumeAndMod();
    clearActivePreset();
  });

  // --- Low cut ---
  lowCutSlider.addEventListener("input", () => {
    const v = parseInt(lowCutSlider.value);
    lowCutVal.textContent = v === 0 ? "Off" : v + " Hz";
    setFilter(highpassNode, v);
    clearActivePreset();
  });

  // --- High cut ---
  function updateHighCutLabel() {
    const v = parseInt(highCutSlider.value);
    if (v >= 20000) highCutVal.textContent = "Off";
    else if (v >= 1000) highCutVal.textContent = (v / 1000).toFixed(1) + " kHz";
    else highCutVal.textContent = v + " Hz";
  }
  highCutSlider.addEventListener("input", () => {
    updateHighCutLabel();
    setFilter(lowpassNode, parseInt(highCutSlider.value));
    clearActivePreset();
  });

  // --- Modulation ---
  modSlider.addEventListener("input", () => {
    const m = parseInt(modSlider.value);
    modVal.textContent = m === 0 ? "Off" : m + "%";
    updateVolumeAndMod();
    clearActivePreset();
  });

  // --- Mod speed ---
  function updateModSpeedLabel() {
    const v = parseInt(modSpeedSldr.value);
    if (v < 25) modSpeedVal.textContent = "Slow";
    else if (v < 50) modSpeedVal.textContent = "Medium";
    else if (v < 75) modSpeedVal.textContent = "Fast";
    else modSpeedVal.textContent = "Very fast";
  }
  modSpeedSldr.addEventListener("input", () => {
    updateModSpeedLabel();
    updateModSpeed();
    clearActivePreset();
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
