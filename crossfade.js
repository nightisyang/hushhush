// ===== Crossfade Engine (pure logic, no DOM) =====
// Extracted for testability. All audio/DOM side effects stay in app.js.

var CrossfadeEngine = {

  create: function(config) {
    return {
      fadeDuration: config.fadeDuration,
      bufferDuration: config.bufferDuration,
      activeIndex: 0,
      crossfading: false,
    };
  },

  shouldTrigger: function(engine, timeLeft) {
    if (engine.crossfading) return false;
    return timeLeft <= engine.fadeDuration;
  },

  startCrossfade: function(engine, timeLeft) {
    var oldIndex = engine.activeIndex;
    var nextIndex = oldIndex === 0 ? 1 : 0;
    var nextStartOffset = Math.max(0, engine.fadeDuration - timeLeft);
    var pauseDelay = Math.round(timeLeft * 1000);

    return {
      engine: {
        fadeDuration: engine.fadeDuration,
        bufferDuration: engine.bufferDuration,
        activeIndex: nextIndex,
        crossfading: true,
      },
      oldIndex: oldIndex,
      nextStartOffset: nextStartOffset,
      pauseDelay: pauseDelay,
    };
  },

  completeCrossfade: function(engine) {
    return {
      fadeDuration: engine.fadeDuration,
      bufferDuration: engine.bufferDuration,
      activeIndex: engine.activeIndex,
      crossfading: false,
    };
  },

};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CrossfadeEngine: CrossfadeEngine };
}
