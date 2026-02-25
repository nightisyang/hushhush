const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// === renderOffline: extracted from app.js for testability ===
// This must stay in sync with the implementation in app.js.
function renderOffline(offCtx) {
  return new Promise(function(resolve, reject) {
    offCtx.oncomplete = function(e) { resolve(e.renderedBuffer); };
    var result = offCtx.startRendering();
    if (result && typeof result.then === 'function') {
      result.then(resolve, reject);
    }
  });
}

// === resumeLiveContext: extracted logic for testability ===
function resumeLiveContext(liveCtx) {
  if (liveCtx && (liveCtx.state === 'suspended' || liveCtx.state === 'interrupted')) {
    return liveCtx.resume();
  }
  return Promise.resolve();
}

// === Media Session helpers: extracted from app.js for testability ===
function setMediaActionHandlerSafe(mediaSession, action, handler) {
  if (!mediaSession) return;
  try {
    mediaSession.setActionHandler(action, handler);
  } catch (e) {}
}

function setMediaPlaybackState(mediaSession, state) {
  if (!mediaSession) return;
  try {
    mediaSession.playbackState = state;
  } catch (e) {}
}

function updateMediaSession(mediaSession, hasMediaMetadata, MediaMetadataCtor, getMediaTitle, settings, sessionArtwork, playbackState) {
  if (!mediaSession) return;
  if (hasMediaMetadata) {
    try {
      mediaSession.metadata = new MediaMetadataCtor({
        title: getMediaTitle(settings),
        artist: 'HushHush',
        album: 'Baby Sleep',
        artwork: sessionArtwork,
      });
    } catch (e) {}
  }
  if (playbackState) setMediaPlaybackState(mediaSession, playbackState);
}

// === Interruption recovery loop: extracted from app.js for testability ===
function createInterruptionRecoveryController(config) {
  const RECOVERY_RETRY_MS = config.retryMs || 750;
  const RECOVERY_MAX_ATTEMPTS = config.maxAttempts || 8;
  let recoveryTimer = null;
  let recoveryAttempts = 0;
  let recoveryInFlight = false;
  let suspendedWhilePlaying = false;

  function clearInterruptionRecovery() {
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }
    recoveryAttempts = 0;
    recoveryInFlight = false;
  }

  function finishInterruptionRecovery() {
    suspendedWhilePlaying = false;
    clearInterruptionRecovery();
  }

  async function runInterruptionRecovery() {
    if (recoveryInFlight) return;
    recoveryInFlight = true;
    try {
      if (!config.liveCtx || !config.isPlaybackActivePhase()) {
        clearInterruptionRecovery();
        return;
      }
      if (config.liveCtx.state === 'running') {
        finishInterruptionRecovery();
        return;
      }

      try {
        await config.resumeLiveContext();
        await config.playSilentSessionAudio();
      } catch (e) {}

      if (!config.liveCtx || !config.isPlaybackActivePhase()) {
        clearInterruptionRecovery();
        return;
      }
      if (config.liveCtx.state === 'running') {
        finishInterruptionRecovery();
        return;
      }

      recoveryAttempts += 1;
      if (recoveryAttempts >= RECOVERY_MAX_ATTEMPTS) {
        clearInterruptionRecovery();
        config.dispatch('AUDIO_CONTEXT_SUSPENDED');
        return;
      }

      recoveryTimer = setTimeout(function() {
        recoveryTimer = null;
        runInterruptionRecovery();
      }, RECOVERY_RETRY_MS);
    } finally {
      recoveryInFlight = false;
    }
  }

  function beginInterruptionRecovery() {
    if (!config.liveCtx || !config.isPlaybackActivePhase()) return;
    suspendedWhilePlaying = true;
    if (!config.activeTransition() && !config.timerEnd()) config.setStatus('Reconnecting audio\u2026');
    if (recoveryTimer || recoveryInFlight) return;
    runInterruptionRecovery();
  }

  function getState() {
    return {
      suspendedWhilePlaying,
      recoveryAttempts,
      recoveryInFlight,
      hasTimer: !!recoveryTimer,
    };
  }

  return {
    beginInterruptionRecovery,
    getState,
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('renderOffline (iOS 12 compat shim)', () => {

  it('resolves via Promise when startRendering returns a Promise (modern browsers)', async () => {
    const fakeBuffer = { getChannelData: () => new Float32Array(10) };
    const offCtx = {
      oncomplete: null,
      startRendering() {
        return Promise.resolve(fakeBuffer);
      },
    };

    const result = await renderOffline(offCtx);
    assert.equal(result, fakeBuffer);
  });

  it('resolves via oncomplete when startRendering returns undefined (iOS 12)', async () => {
    const fakeBuffer = { getChannelData: () => new Float32Array(10) };
    const offCtx = {
      oncomplete: null,
      startRendering() {
        // iOS 12: startRendering() returns undefined, fires oncomplete later
        setTimeout(() => {
          offCtx.oncomplete({ renderedBuffer: fakeBuffer });
        }, 10);
        return undefined;
      },
    };

    const result = await renderOffline(offCtx);
    assert.equal(result, fakeBuffer);
  });

  it('resolves via oncomplete when startRendering returns non-thenable (edge case)', async () => {
    const fakeBuffer = { getChannelData: () => new Float32Array(10) };
    const offCtx = {
      oncomplete: null,
      startRendering() {
        // Some implementations might return a non-thenable truthy value
        setTimeout(() => {
          offCtx.oncomplete({ renderedBuffer: fakeBuffer });
        }, 10);
        return true; // truthy but not a Promise
      },
    };

    const result = await renderOffline(offCtx);
    assert.equal(result, fakeBuffer);
  });

  it('rejects when startRendering Promise rejects (modern browsers)', async () => {
    const offCtx = {
      oncomplete: null,
      startRendering() {
        return Promise.reject(new Error('rendering failed'));
      },
    };

    await assert.rejects(() => renderOffline(offCtx), { message: 'rendering failed' });
  });

  it('without shim: await undefined resolves to undefined (demonstrates the bug)', async () => {
    // This demonstrates what happens WITHOUT the shim on iOS 12:
    // startRendering() returns undefined, await undefined = undefined
    const offCtx = {
      oncomplete: null,
      startRendering() { return undefined; },
    };

    const result = await offCtx.startRendering();
    assert.equal(result, undefined);
    // Then rendered.getChannelData(0) would throw TypeError
    assert.throws(() => result.getChannelData(0), TypeError);
  });
});

describe('resumeLiveContext race condition', () => {

  it('resume must complete before dispatch to avoid playing on suspended context', async () => {
    const events = [];
    let resolveResume;

    const fakeCtx = {
      state: 'suspended',
      resume() {
        return new Promise((resolve) => {
          resolveResume = () => {
            events.push('resume-complete');
            fakeCtx.state = 'running';
            resolve();
          };
        });
      },
    };

    // WRONG (original code): fire-and-forget resume, dispatch immediately
    resumeLiveContext(fakeCtx);
    events.push('dispatch-PLAY');

    assert.deepEqual(events, ['dispatch-PLAY']);
    // Resume hasn't completed yet — AudioContext is still suspended!
    assert.equal(fakeCtx.state, 'suspended');

    // Now resolve the resume
    resolveResume();
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(events, ['dispatch-PLAY', 'resume-complete']);
    // dispatch happened BEFORE resume completed — this is the bug
  });

  it('awaiting resume ensures context is running before dispatch', async () => {
    const events = [];
    let resolveResume;

    const fakeCtx = {
      state: 'suspended',
      resume() {
        return new Promise((resolve) => {
          resolveResume = () => {
            events.push('resume-complete');
            fakeCtx.state = 'running';
            resolve();
          };
        });
      },
    };

    // CORRECT (fixed code): await resume, then dispatch
    const resumePromise = resumeLiveContext(fakeCtx);

    // Simulate async resume completing
    resolveResume();
    await resumePromise;

    events.push('dispatch-PLAY');

    // Resume completed BEFORE dispatch — context is running
    assert.equal(fakeCtx.state, 'running');
    assert.deepEqual(events, ['resume-complete', 'dispatch-PLAY']);
  });
});

describe('resumeLiveContext handles interrupted state (iOS Safari)', () => {

  it('resumes when state is "interrupted"', async () => {
    let resumed = false;
    const fakeCtx = {
      state: 'interrupted',
      resume() {
        resumed = true;
        fakeCtx.state = 'running';
        return Promise.resolve();
      },
    };

    await resumeLiveContext(fakeCtx);
    assert.equal(resumed, true);
    assert.equal(fakeCtx.state, 'running');
  });

  it('resumes when state is "suspended"', async () => {
    let resumed = false;
    const fakeCtx = {
      state: 'suspended',
      resume() {
        resumed = true;
        fakeCtx.state = 'running';
        return Promise.resolve();
      },
    };

    await resumeLiveContext(fakeCtx);
    assert.equal(resumed, true);
    assert.equal(fakeCtx.state, 'running');
  });

  it('no-ops when state is "running"', async () => {
    let resumed = false;
    const fakeCtx = {
      state: 'running',
      resume() { resumed = true; return Promise.resolve(); },
    };

    await resumeLiveContext(fakeCtx);
    assert.equal(resumed, false);
  });

  it('no-ops when context is null', async () => {
    const result = await resumeLiveContext(null);
    assert.equal(result, undefined);
  });
});

describe('Media Session hardening helpers', () => {

  it('setMediaActionHandlerSafe swallows unsupported action errors', () => {
    const actions = [];
    const fakeMediaSession = {
      setActionHandler(action) {
        actions.push(action);
        if (action === 'seekto') throw new TypeError('unsupported');
      },
    };

    assert.doesNotThrow(() => {
      setMediaActionHandlerSafe(fakeMediaSession, 'play', function(){});
      setMediaActionHandlerSafe(fakeMediaSession, 'seekto', null);
    });
    assert.deepEqual(actions, ['play', 'seekto']);
  });

  it('setMediaPlaybackState swallows readonly playbackState failures', () => {
    const fakeMediaSession = {};
    Object.defineProperty(fakeMediaSession, 'playbackState', {
      set() { throw new TypeError('readonly'); },
    });

    assert.doesNotThrow(() => {
      setMediaPlaybackState(fakeMediaSession, 'paused');
    });
  });

  it('updateMediaSession sets playback state even when metadata creation fails', () => {
    const fakeMediaSession = {};
    function BrokenMetadata() { throw new Error('metadata unavailable'); }

    assert.doesNotThrow(() => {
      updateMediaSession(
        fakeMediaSession,
        true,
        BrokenMetadata,
        () => 'White Noise',
        { color: 'white' },
        [{ src: 'icon-96.png' }],
        'playing'
      );
    });
    assert.equal(fakeMediaSession.playbackState, 'playing');
  });

  it('updateMediaSession writes metadata when MediaMetadata is supported', () => {
    const fakeMediaSession = {};
    function FakeMediaMetadata(data) { Object.assign(this, data); }

    updateMediaSession(
      fakeMediaSession,
      true,
      FakeMediaMetadata,
      () => 'Rain',
      { color: 'pink' },
      [{ src: 'icon-256.png' }],
      'paused'
    );

    assert.equal(fakeMediaSession.metadata.title, 'Rain');
    assert.equal(fakeMediaSession.metadata.artist, 'HushHush');
    assert.equal(fakeMediaSession.playbackState, 'paused');
  });
});

describe('interruption recovery loop', () => {

  it('recovers without dispatch when context resumes', async () => {
    const events = [];
    const liveCtx = { state: 'suspended' };
    const controller = createInterruptionRecoveryController({
      liveCtx,
      isPlaybackActivePhase: () => true,
      resumeLiveContext: async () => { liveCtx.state = 'running'; events.push('resume'); },
      playSilentSessionAudio: async () => { events.push('silent'); },
      dispatch: (event) => { events.push(event); },
      setStatus: (text) => { events.push(text); },
      activeTransition: () => false,
      timerEnd: () => null,
      retryMs: 5,
      maxAttempts: 3,
    });

    controller.beginInterruptionRecovery();
    await wait(25);

    assert.deepEqual(events, ['Reconnecting audio\u2026', 'resume', 'silent']);
    assert.equal(controller.getState().suspendedWhilePlaying, false);
    assert.equal(controller.getState().recoveryAttempts, 0);
  });

  it('dispatches AUDIO_CONTEXT_SUSPENDED after max retries', async () => {
    const dispatched = [];
    const liveCtx = { state: 'suspended' };
    const controller = createInterruptionRecoveryController({
      liveCtx,
      isPlaybackActivePhase: () => true,
      resumeLiveContext: async () => {},
      playSilentSessionAudio: async () => {},
      dispatch: (event) => { dispatched.push(event); },
      setStatus: () => {},
      activeTransition: () => false,
      timerEnd: () => null,
      retryMs: 5,
      maxAttempts: 1,
    });

    controller.beginInterruptionRecovery();
    await wait(20);

    assert.deepEqual(dispatched, ['AUDIO_CONTEXT_SUSPENDED']);
    assert.equal(controller.getState().hasTimer, false);
    assert.equal(controller.getState().recoveryAttempts, 0);
  });

  it('does not start recovery when playback is not active', async () => {
    const events = [];
    const liveCtx = { state: 'suspended' };
    const controller = createInterruptionRecoveryController({
      liveCtx,
      isPlaybackActivePhase: () => false,
      resumeLiveContext: async () => { events.push('resume'); },
      playSilentSessionAudio: async () => { events.push('silent'); },
      dispatch: (event) => { events.push(event); },
      setStatus: (text) => { events.push(text); },
      activeTransition: () => false,
      timerEnd: () => null,
      retryMs: 5,
      maxAttempts: 3,
    });

    controller.beginInterruptionRecovery();
    await wait(20);

    assert.deepEqual(events, []);
    assert.equal(controller.getState().suspendedWhilePlaying, false);
    assert.equal(controller.getState().recoveryAttempts, 0);
  });
});
