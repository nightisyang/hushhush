const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CrossfadeEngine } = require('./crossfade.js');

describe('CrossfadeEngine', () => {

  function createEngine(opts = {}) {
    return CrossfadeEngine.create({
      fadeDuration: opts.fadeDuration ?? 5,
      bufferDuration: opts.bufferDuration ?? 60,
    });
  }

  // === Initial state ===

  describe('create', () => {
    it('starts with activeIndex=0, not crossfading', () => {
      const eng = createEngine();
      assert.equal(eng.activeIndex, 0);
      assert.equal(eng.crossfading, false);
    });
  });

  // === shouldTrigger ===

  describe('shouldTrigger', () => {
    it('triggers when timeLeft <= fadeDuration and not crossfading', () => {
      const eng = createEngine();
      assert.equal(CrossfadeEngine.shouldTrigger(eng, 4.5), true);
    });

    it('triggers at exactly fadeDuration', () => {
      const eng = createEngine();
      assert.equal(CrossfadeEngine.shouldTrigger(eng, 5.0), true);
    });

    it('does not trigger when timeLeft > fadeDuration', () => {
      const eng = createEngine();
      assert.equal(CrossfadeEngine.shouldTrigger(eng, 5.1), false);
    });

    it('does not trigger when already crossfading', () => {
      let eng = createEngine();
      eng = CrossfadeEngine.startCrossfade(eng, 5.0).engine;
      assert.equal(CrossfadeEngine.shouldTrigger(eng, 4.0), false);
    });
  });

  // === startCrossfade ===

  describe('startCrossfade', () => {
    it('sets crossfading to true', () => {
      const eng = createEngine();
      const { engine } = CrossfadeEngine.startCrossfade(eng, 5.0);
      assert.equal(engine.crossfading, true);
    });

    it('swaps activeIndex from 0 to 1', () => {
      const eng = createEngine();
      const { engine } = CrossfadeEngine.startCrossfade(eng, 5.0);
      assert.equal(engine.activeIndex, 1);
    });

    it('swaps activeIndex from 1 to 0', () => {
      let eng = createEngine();
      eng = CrossfadeEngine.startCrossfade(eng, 5.0).engine;
      eng = CrossfadeEngine.completeCrossfade(eng);
      const { engine } = CrossfadeEngine.startCrossfade(eng, 4.0);
      assert.equal(engine.activeIndex, 0);
    });

    it('returns nextStartOffset=0 when triggered exactly at fadeDuration', () => {
      const eng = createEngine();
      const { nextStartOffset } = CrossfadeEngine.startCrossfade(eng, 5.0);
      assert.equal(nextStartOffset, 0);
    });

    it('returns nextStartOffset>0 when triggered late', () => {
      const eng = createEngine();
      const { nextStartOffset } = CrossfadeEngine.startCrossfade(eng, 3.5);
      assert.equal(nextStartOffset, 1.5);
    });

    it('returns nextStartOffset=0 when triggered early (timeLeft > fadeDuration)', () => {
      const eng = createEngine();
      const { nextStartOffset } = CrossfadeEngine.startCrossfade(eng, 6.0);
      assert.equal(nextStartOffset, 0);
    });

    it('returns pauseDelay matching timeLeft in ms', () => {
      const eng = createEngine();
      const { pauseDelay } = CrossfadeEngine.startCrossfade(eng, 4.2);
      assert.equal(pauseDelay, 4200);
    });

    it('returns oldIndex pointing to the previous active', () => {
      const eng = createEngine();
      const { oldIndex, engine } = CrossfadeEngine.startCrossfade(eng, 5.0);
      assert.equal(oldIndex, 0);
      assert.equal(engine.activeIndex, 1);
    });
  });

  // === completeCrossfade ===

  describe('completeCrossfade', () => {
    it('sets crossfading to false', () => {
      let eng = createEngine();
      eng = CrossfadeEngine.startCrossfade(eng, 5.0).engine;
      eng = CrossfadeEngine.completeCrossfade(eng);
      assert.equal(eng.crossfading, false);
    });

    it('preserves activeIndex after completion', () => {
      let eng = createEngine();
      eng = CrossfadeEngine.startCrossfade(eng, 5.0).engine;
      assert.equal(eng.activeIndex, 1);
      eng = CrossfadeEngine.completeCrossfade(eng);
      assert.equal(eng.activeIndex, 1);
    });
  });

  // === Fade curve alignment ===

  describe('fade curve alignment', () => {
    it('offset ensures fade-in aligns with fade-out when late by 1s', () => {
      const eng = createEngine({ fadeDuration: 5 });
      const { nextStartOffset, pauseDelay } = CrossfadeEngine.startCrossfade(eng, 4.0);
      // 1s late → skip 1s of fade-in
      assert.equal(nextStartOffset, 1.0);
      // Old element should pause after 4s (its remaining time)
      assert.equal(pauseDelay, 4000);
      // At the moment of pause: old is at gain=0 (end of buffer),
      // new is at 5s into buffer (1s offset + 4s elapsed = 5s = end of fade-in, gain=1)
    });

    it('offset ensures fade-in aligns with fade-out when late by 2.5s', () => {
      const eng = createEngine({ fadeDuration: 5 });
      const { nextStartOffset } = CrossfadeEngine.startCrossfade(eng, 2.5);
      assert.equal(nextStartOffset, 2.5);
    });

    it('next buffer reaches full volume exactly when old buffer reaches silence', () => {
      const eng = createEngine({ fadeDuration: 5, bufferDuration: 60 });
      // Simulate a late trigger: 3.8s remaining
      const timeLeft = 3.8;
      const { nextStartOffset, pauseDelay } = CrossfadeEngine.startCrossfade(eng, timeLeft);

      // After pauseDelay ms, old buffer has ended (at 60s, gain=0)
      // New buffer is at position: nextStartOffset + timeLeft
      const newPositionAtPause = nextStartOffset + timeLeft;
      // This should equal fadeDuration (end of fade-in region, gain=1)
      assert.ok(Math.abs(newPositionAtPause - 5.0) < 0.001,
        `new buffer at ${newPositionAtPause}s, expected ~5.0s (end of fade-in)`);
    });
  });

  // === Full lifecycle (multiple crossfades) ===

  describe('multi-cycle', () => {
    it('alternates active index across 6 crossfades', () => {
      let eng = createEngine();
      const expected = [1, 0, 1, 0, 1, 0];
      for (let i = 0; i < 6; i++) {
        const result = CrossfadeEngine.startCrossfade(eng, 5.0);
        eng = result.engine;
        assert.equal(eng.activeIndex, expected[i], `cycle ${i}`);
        eng = CrossfadeEngine.completeCrossfade(eng);
      }
    });

    it('never triggers during active crossfade', () => {
      let eng = createEngine();
      eng = CrossfadeEngine.startCrossfade(eng, 5.0).engine;
      assert.equal(CrossfadeEngine.shouldTrigger(eng, 4.0), false);
      assert.equal(CrossfadeEngine.shouldTrigger(eng, 1.0), false);
    });

    it('triggers again after completion', () => {
      let eng = createEngine();
      eng = CrossfadeEngine.startCrossfade(eng, 5.0).engine;
      eng = CrossfadeEngine.completeCrossfade(eng);
      assert.equal(CrossfadeEngine.shouldTrigger(eng, 4.0), true);
    });
  });
});
