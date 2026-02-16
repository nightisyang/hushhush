// state.js — Pure state machine for HushHush playback lifecycle
// States: idle, generating, regenerating, playing
// Pure function: send(machine, event) → { machine, actions }
var HushState = (function() {
  function create() {
    return { phase: 'idle', dirty: false };
  }

  function send(machine, event) {
    var phase = machine.phase;
    var dirty = machine.dirty;

    if (phase === 'idle') {
      if (event === 'PLAY')
        return { machine: { phase: 'generating', dirty: false }, actions: ['STOP_AUDIO', 'UI_LOADING', 'GENERATE'] };
      if (event === 'PLAY_CACHED')
        return { machine: { phase: 'playing', dirty: false }, actions: ['RESUME_AUDIO', 'UI_PLAYING'] };
      return { machine: machine, actions: [] };
    }

    if (phase === 'generating') {
      if (event === 'STOP' || event === 'PLAY')
        return { machine: { phase: 'idle', dirty: false }, actions: ['STOP_AUDIO', 'UI_STOPPED'] };
      if (event === 'SETTINGS_CHANGED')
        return { machine: { phase: 'generating', dirty: true }, actions: ['STOP_AUDIO'] };
      if (event === 'GEN_COMPLETE') {
        if (dirty) return { machine: { phase: 'generating', dirty: false }, actions: ['GENERATE'] };
        return { machine: { phase: 'generating', dirty: false }, actions: ['LOAD_AUDIO'] };
      }
      if (event === 'AUDIO_READY') {
        if (dirty) return { machine: { phase: 'generating', dirty: false }, actions: ['GENERATE'] };
        return { machine: { phase: 'playing', dirty: false }, actions: ['PLAY_AUDIO', 'UI_PLAYING'] };
      }
      if (event === 'ERROR')
        return { machine: { phase: 'idle', dirty: false }, actions: ['SHOW_ERROR', 'UI_STOPPED'] };
      return { machine: machine, actions: [] };
    }

    if (phase === 'regenerating') {
      if (event === 'STOP' || event === 'PLAY')
        return { machine: { phase: 'idle', dirty: false }, actions: ['STOP_AUDIO', 'UI_STOPPED'] };
      if (event === 'SETTINGS_CHANGED')
        return { machine: { phase: 'regenerating', dirty: true }, actions: [] };
      if (event === 'GEN_COMPLETE') {
        if (dirty) return { machine: { phase: 'regenerating', dirty: false }, actions: ['GENERATE'] };
        return { machine: { phase: 'regenerating', dirty: false }, actions: ['LOAD_AUDIO'] };
      }
      if (event === 'AUDIO_READY') {
        if (dirty) return { machine: { phase: 'regenerating', dirty: false }, actions: ['GENERATE'] };
        return { machine: { phase: 'playing', dirty: false }, actions: ['PLAY_AUDIO', 'UI_PLAYING'] };
      }
      if (event === 'ERROR')
        return { machine: { phase: 'playing', dirty: false }, actions: ['SHOW_ERROR'] };
      return { machine: machine, actions: [] };
    }

    if (phase === 'playing') {
      if (event === 'STOP' || event === 'PLAY')
        return { machine: { phase: 'idle', dirty: false }, actions: ['STOP_AUDIO', 'UI_STOPPED'] };
      if (event === 'SETTINGS_CHANGED')
        return { machine: { phase: 'regenerating', dirty: false }, actions: ['UI_LOADING', 'GENERATE'] };
      return { machine: machine, actions: [] };
    }

    return { machine: machine, actions: [] };
  }

  return { create: create, send: send };
})();

if (typeof module !== 'undefined') module.exports = { HushState: HushState };
