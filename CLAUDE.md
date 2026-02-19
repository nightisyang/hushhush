# HushHush

Baby sleep noise generator. Vanilla JS, no build step, no dependencies. Served via nginx on a Raspberry Pi.

Live at: hushhush.bunchmunch.rocks

## Architecture

Single-page app: `index.html` (all CSS inline) + three JS files loaded via script tags with `?v=N` cache busting.

**Audio pipeline:**
1. `OfflineAudioContext` renders 65s of noise (60s + 5s fade overlap) with filters/tremolo
2. `SeamlessLoop.blend()` crossfades the loop boundary for seamless continuity
3. `AudioBufferSourceNode.loop = true` plays the buffer with sample-accurate gapless looping
4. A silent `<audio>` element (all-zero PCM WAV) keeps MediaSession/lock screen controls alive
5. Per-source `GainNode` crossfade handles regen transitions when settings change during playback

**State machine** (`state.js`): Pure function, 4 phases — `idle` / `generating` / `regenerating` / `playing`. Drives all playback via `dispatch(event)` + `executeActions()` pattern. The dirty flag collapses rapid settings changes into a single regeneration.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup + all CSS inline. Single `<audio id="silentAudio">` for MediaSession bridge |
| `app.js` | Audio engine, action handlers, UI logic, settings persistence |
| `state.js` | Pure state machine (no DOM, testable in Node.js) |
| `loop.js` | `SeamlessLoop.blend()` — linear crossfade at loop boundary |
| `state.test.js` | 43 state machine tests |
| `loop.test.js` | 8 blend function tests |
| `manifest.json` | PWA manifest — `display: minimal-ui` for Android install, iOS browser fallback |
| `sw.js` | Service worker — cache-first offline support, versioned cache |

## Running Tests

```bash
node --test loop.test.js state.test.js
```

All tests run in Node.js with `node:test` — no test framework needed.

## Development

Serve with any static HTTP server. Bump the `?v=N` query string on all three `<script>` tags in `index.html` when deploying changes.

Current version: `v=29`

## Style Guide

- Prefer `const`/`let` over `var`, arrow functions over `function` expressions
- No build step, no transpilation — code must run directly in browsers
- Keep `state.js` and `loop.js` pure and Node-testable (no DOM, no browser APIs)
- `app.js` uses `var` in some older sections — prefer modern style for new code
- No TypeScript, no JSDoc unless it adds real clarity
- Minimal comments — only where logic isn't self-evident

## Key Decisions

- **PWA with `display: minimal-ui`.** Manifest and service worker are back. `minimal-ui` gives Android an install prompt and app-like experience, while iOS falls back to a regular browser tab (preserving background audio and MediaSession). The service worker caches all assets for offline use — bump `CACHE_VERSION` in `sw.js` when deploying.
- **No `<audio>` for playback.** `<audio loop>` has an audible decode gap at the loop boundary in all browsers. `AudioBufferSourceNode.loop = true` is the only way to get sample-accurate gapless looping.
- **Silent audio for MediaSession.** Browsers require a playing `<audio>` element for lock screen controls. A 1s silent WAV blob (all-zero PCM) serves this role. iOS `<audio>.volume` is read-only, so the WAV must contain actual silence.
- **Offline rendering.** Noise is rendered via `OfflineAudioContext` (not real-time AudioWorklet) so the entire buffer is ready before playback starts. This avoids glitches on low-power devices.
- **`AudioBufferSourceNode` is one-shot.** Can't restart after `.stop()`. Resume creates a fresh node from the cached `activeBuffer`.
- **User gesture on iOS.** `silentAudio.play()` must be called synchronously in click/media session handlers before any async work, or iOS will reject it.

## iOS Gotchas

- Safari iOS does NOT display MediaSession metadata (title/artist/artwork) on lock screen. Known Apple bug since iOS 16.x. Controls may work but no metadata shown. Chrome on iOS works.
- `<audio>.volume` is read-only on iOS — always 1.0. Silent audio must use actual zero PCM data.
- AudioContext starts suspended on iOS — must call `resume()` inside a user gesture handler.

## Settings Persistence

All settings (color, volume, filters, modulation, active preset) persist in `localStorage` under `hushhush_settings`. Custom presets stored separately under `hushhush_presets`.
