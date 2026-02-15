# HushHush

A lightweight, installable progressive web app for generating ambient noise. Built with vanilla JavaScript and the Web Audio API — no dependencies, no build step.

## Features

- **5 noise colors** — White, Pink, Brown, Blue, and Violet
- **Tunable filters** — Low cut, high cut, and amplitude modulation with adjustable speed
- **Presets** — Built-in presets (Deep Sleep, Focus, Rain-ish, Fan, Bright) plus save/delete your own
- **Sleep timer** — 15m, 30m, 1h, or 2h auto-shutoff with countdown display
- **Installable PWA** — Add to home screen on iOS/Android for a native app experience
- **Offline support** — Service worker caches all assets for use without a network connection
- **No tracking, no ads** — Runs entirely in your browser

## Getting Started

Serve the files with any static HTTP server:

```bash
# Python
python3 -m http.server 8000

# Node
npx serve .
```

Then open `http://localhost:8000` in your browser.

## How It Works

Noise is generated in real-time using an `AudioWorkletProcessor` (`noise-processor.js`) that produces a buffer of random samples shaped by the selected noise color algorithm. The signal is then routed through Web Audio highpass/lowpass filters and an LFO-driven gain node for modulation before reaching the output.

## File Structure

```
index.html           — UI markup and styles
app.js               — Application logic, audio graph, presets, timer
noise-processor.js   — AudioWorklet noise generation (white/pink/brown/blue/violet)
sw.js                — Service worker for offline caching
manifest.json        — PWA manifest
icon-192.svg         — App icon (192x192)
icon-512.svg         — App icon (512x512)
```

## License

MIT
