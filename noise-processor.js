// AudioWorklet processor — runs on the audio thread for glitch-free noise.

class NoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.color = "white";
    this.volume = 0.3;
    this.modulation = 0;     // 0–1
    this.modSpeed = 0.15;    // 0–1 mapped to Hz
    this.modPhase = 0;

    // Pink noise state (Voss-McCartney algorithm)
    this.pinkRows = new Float32Array(16);
    this.pinkRunning = 0;
    this.pinkIndex = 0;

    // Brown noise state
    this.brownLast = 0;

    // Blue noise state (needs its own previous sample)
    this.bluePrev = 0;

    // Violet noise state (needs two previous samples)
    this.violetPrev1 = 0;
    this.violetPrev2 = 0;

    this.port.onmessage = (e) => {
      if (e.data.color !== undefined) this.color = e.data.color;
      if (e.data.volume !== undefined) this.volume = e.data.volume;
      if (e.data.modulation !== undefined) this.modulation = e.data.modulation;
      if (e.data.modSpeed !== undefined) this.modSpeed = e.data.modSpeed;
    };
  }

  white() {
    return Math.random() * 2 - 1;
  }

  pink() {
    // Voss-McCartney: layer multiple random sources toggled at different rates
    const idx = this.pinkIndex;
    this.pinkIndex++;
    let numZeros = 0;
    let n = idx;
    while (n !== 0 && (n & 1) === 0) { numZeros++; n >>= 1; }
    if (numZeros < this.pinkRows.length) {
      this.pinkRunning -= this.pinkRows[numZeros];
      const newVal = Math.random() * 2 - 1;
      this.pinkRunning += newVal;
      this.pinkRows[numZeros] = newVal;
    }
    return (this.pinkRunning + (Math.random() * 2 - 1)) / (this.pinkRows.length + 1);
  }

  brown() {
    const w = Math.random() * 2 - 1;
    this.brownLast = (this.brownLast + 0.02 * w) / 1.02;
    return this.brownLast * 3.5;
  }

  blue() {
    // Differentiated white noise (successive differences)
    const w = this.white();
    const val = w - this.bluePrev;
    this.bluePrev = w;
    return val * 0.5;
  }

  violet() {
    const w = this.white();
    const val = w - 2 * this.violetPrev1 + this.violetPrev2;
    this.violetPrev2 = this.violetPrev1;
    this.violetPrev1 = w;
    return val * 0.5;
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    // Map modSpeed 0–1 to 0.05–2 Hz
    const modHz = 0.05 + this.modSpeed * 1.95;
    const modStep = modHz / sampleRate;

    for (let i = 0; i < out.length; i++) {
      let sample;
      switch (this.color) {
        case "pink":   sample = this.pink(); break;
        case "brown":  sample = this.brown(); break;
        case "blue":   sample = this.blue(); break;
        case "violet": sample = this.violet(); break;
        default:       sample = this.white();
      }

      let vol = this.volume;
      if (this.modulation > 0) {
        this.modPhase += modStep;
        if (this.modPhase > 1) this.modPhase -= 1;
        const wave = 0.5 * (1 + Math.sin(2 * Math.PI * this.modPhase));
        vol *= 1 - this.modulation * 0.8 * (1 - wave);
      }

      out[i] = sample * vol;
    }
    return true;
  }
}

registerProcessor("noise-processor", NoiseProcessor);
