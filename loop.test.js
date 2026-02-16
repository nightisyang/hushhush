const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SeamlessLoop } = require('./loop.js');

describe('SeamlessLoop.blend', () => {

  // Helper: create a simple array of known values
  // For outputLength=10, fadeLength=3, we need 10+3=13 raw samples
  function makeSamples(n) {
    var arr = new Float32Array(n);
    for (var i = 0; i < n; i++) arr[i] = i;
    return arr;
  }

  it('output has correct length', () => {
    var samples = makeSamples(13);
    var out = SeamlessLoop.blend(samples, 10, 3);
    assert.equal(out.length, 10);
  });

  it('samples after fade zone copied unchanged', () => {
    var samples = makeSamples(13);
    var out = SeamlessLoop.blend(samples, 10, 3);
    // Indices 3..9 should be copied directly from samples[3..9]
    for (var i = 3; i < 10; i++) {
      assert.equal(out[i], samples[i], 'index ' + i);
    }
  });

  it('at i=0: output = 100% tail, 0% head', () => {
    var samples = makeSamples(13);
    var out = SeamlessLoop.blend(samples, 10, 3);
    // t = 0/3 = 0, so output[0] = samples[0]*0 + samples[10]*1 = 10
    assert.equal(out[0], samples[10]);
  });

  it('at midpoint: 50/50 blend', () => {
    // fadeLength=4 so midpoint is i=2, t=2/4=0.5
    var samples = makeSamples(14); // 10 + 4
    var out = SeamlessLoop.blend(samples, 10, 4);
    var expected = samples[2] * 0.5 + samples[12] * 0.5;
    assert.ok(Math.abs(out[2] - expected) < 0.001,
      'got ' + out[2] + ', expected ' + expected);
  });

  it('near fade end: approaching 100% head', () => {
    // fadeLength=4, at i=3: t=3/4=0.75
    var samples = makeSamples(14);
    var out = SeamlessLoop.blend(samples, 10, 4);
    var expected = samples[3] * 0.75 + samples[13] * 0.25;
    assert.ok(Math.abs(out[3] - expected) < 0.001,
      'got ' + out[3] + ', expected ' + expected);
  });

  it('loop continuity: output[last] and output[0] come from consecutive raw samples', () => {
    // output[9] = samples[9] (direct copy, outside fade zone)
    // output[0] blends samples[0] and samples[10]
    // samples[9] and samples[10] are consecutive in the raw buffer
    var samples = makeSamples(13);
    var out = SeamlessLoop.blend(samples, 10, 3);
    // output[9] comes from samples[9], output[0] is 100% samples[10]
    // These are consecutive raw samples → continuity
    assert.equal(out[9], 9);
    assert.equal(out[0], 10);
  });

  it('fadeLength=0: direct copy (no blend)', () => {
    var samples = makeSamples(10);
    var out = SeamlessLoop.blend(samples, 10, 0);
    for (var i = 0; i < 10; i++) {
      assert.equal(out[i], samples[i], 'index ' + i);
    }
  });

  it('linear interpolation verified at multiple known points', () => {
    // outputLength=10, fadeLength=4, need 14 samples
    // Use values where we can easily verify the math
    var samples = new Float32Array(14);
    for (var i = 0; i < 14; i++) samples[i] = i * 10;
    var out = SeamlessLoop.blend(samples, 10, 4);

    // i=0: t=0/4=0.00 → 0*0.00 + 100*1.00 = 100
    assert.ok(Math.abs(out[0] - 100) < 0.01, 'i=0: got ' + out[0]);
    // i=1: t=1/4=0.25 → 10*0.25 + 110*0.75 = 2.5 + 82.5 = 85
    assert.ok(Math.abs(out[1] - 85) < 0.01, 'i=1: got ' + out[1]);
    // i=2: t=2/4=0.50 → 20*0.50 + 120*0.50 = 10 + 60 = 70
    assert.ok(Math.abs(out[2] - 70) < 0.01, 'i=2: got ' + out[2]);
    // i=3: t=3/4=0.75 → 30*0.75 + 130*0.25 = 22.5 + 32.5 = 55
    assert.ok(Math.abs(out[3] - 55) < 0.01, 'i=3: got ' + out[3]);
    // i=4: direct copy → 40
    assert.equal(out[4], 40);
  });

});
