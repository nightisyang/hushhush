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
