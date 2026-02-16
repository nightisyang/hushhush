const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { HushState } = require('./state.js');

const { create, send } = HushState;

describe('HushState', () => {

  // === Initial state ===

  it('creates initial state: idle, not dirty', () => {
    const m = create();
    assert.equal(m.phase, 'idle');
    assert.equal(m.dirty, false);
  });

  // === Idle state transitions (7 rows) ===

  describe('idle', () => {
    const idle = create();

    it('PLAY → generating', () => {
      const { machine, actions } = send(idle, 'PLAY');
      assert.equal(machine.phase, 'generating');
      assert.equal(machine.dirty, false);
      assert.deepEqual(actions, ['STOP_AUDIO', 'UI_LOADING', 'GENERATE']);
    });

    it('PLAY_CACHED → playing', () => {
      const { machine, actions } = send(idle, 'PLAY_CACHED');
      assert.equal(machine.phase, 'playing');
      assert.deepEqual(actions, ['RESUME_AUDIO', 'UI_PLAYING']);
    });

    it('STOP → idle (no-op)', () => {
      const { machine, actions } = send(idle, 'STOP');
      assert.equal(machine.phase, 'idle');
      assert.deepEqual(actions, []);
    });

    it('SETTINGS_CHANGED → idle (no-op)', () => {
      const { machine, actions } = send(idle, 'SETTINGS_CHANGED');
      assert.equal(machine.phase, 'idle');
      assert.deepEqual(actions, []);
    });

    it('GEN_COMPLETE → idle (stale, no-op)', () => {
      const { machine, actions } = send(idle, 'GEN_COMPLETE');
      assert.equal(machine.phase, 'idle');
      assert.deepEqual(actions, []);
    });

    it('AUDIO_READY → idle (stale, no-op)', () => {
      const { machine, actions } = send(idle, 'AUDIO_READY');
      assert.equal(machine.phase, 'idle');
      assert.deepEqual(actions, []);
    });

    it('ERROR → idle (stale, no-op)', () => {
      const { machine, actions } = send(idle, 'ERROR');
      assert.equal(machine.phase, 'idle');
      assert.deepEqual(actions, []);
    });
  });

  // === Generating state transitions (8 rows) ===

  describe('generating', () => {
    const generating = send(create(), 'PLAY').machine;

    it('STOP → idle', () => {
      const { machine, actions } = send(generating, 'STOP');
      assert.equal(machine.phase, 'idle');
      assert.equal(machine.dirty, false);
      assert.deepEqual(actions, ['STOP_AUDIO', 'UI_STOPPED']);
    });

    it('PLAY → idle (toggle off)', () => {
      const { machine, actions } = send(generating, 'PLAY');
      assert.equal(machine.phase, 'idle');
      assert.deepEqual(actions, ['STOP_AUDIO', 'UI_STOPPED']);
    });

    it('SETTINGS_CHANGED → generating (dirty)', () => {
      const { machine, actions } = send(generating, 'SETTINGS_CHANGED');
      assert.equal(machine.phase, 'generating');
      assert.equal(machine.dirty, true);
      assert.deepEqual(actions, ['STOP_AUDIO']);
    });

    it('GEN_COMPLETE (clean) → generating, LOAD_AUDIO', () => {
      const { machine, actions } = send(generating, 'GEN_COMPLETE');
      assert.equal(machine.phase, 'generating');
      assert.equal(machine.dirty, false);
      assert.deepEqual(actions, ['LOAD_AUDIO']);
    });

    it('GEN_COMPLETE (dirty) → generating, GENERATE (restart)', () => {
      const dirtyGen = send(generating, 'SETTINGS_CHANGED').machine;
      const { machine, actions } = send(dirtyGen, 'GEN_COMPLETE');
      assert.equal(machine.phase, 'generating');
      assert.equal(machine.dirty, false);
      assert.deepEqual(actions, ['GENERATE']);
    });

    it('AUDIO_READY (clean) → playing', () => {
      const { machine, actions } = send(generating, 'AUDIO_READY');
      assert.equal(machine.phase, 'playing');
      assert.equal(machine.dirty, false);
      assert.deepEqual(actions, ['PLAY_AUDIO', 'UI_PLAYING']);
    });

    it('AUDIO_READY (dirty) → generating, GENERATE (restart)', () => {
      const dirtyGen = send(generating, 'SETTINGS_CHANGED').machine;
      const { machine, actions } = send(dirtyGen, 'AUDIO_READY');
      assert.equal(machine.phase, 'generating');
      assert.equal(machine.dirty, false);
      assert.deepEqual(actions, ['GENERATE']);
    });

    it('ERROR → idle', () => {
      const { machine, actions } = send(generating, 'ERROR');
      assert.equal(machine.phase, 'idle');
      assert.equal(machine.dirty, false);
      assert.deepEqual(actions, ['SHOW_ERROR', 'UI_STOPPED']);
    });
  });

  // === Playing state transitions (6 rows) ===

  describe('playing', () => {
    let playing;
    {
      let m = send(create(), 'PLAY').machine;
      playing = send(m, 'AUDIO_READY').machine;
    }

    it('STOP → idle', () => {
      const { machine, actions } = send(playing, 'STOP');
      assert.equal(machine.phase, 'idle');
      assert.deepEqual(actions, ['STOP_AUDIO', 'UI_STOPPED']);
    });

    it('PLAY → idle (toggle off)', () => {
      const { machine, actions } = send(playing, 'PLAY');
      assert.equal(machine.phase, 'idle');
      assert.deepEqual(actions, ['STOP_AUDIO', 'UI_STOPPED']);
    });

    it('SETTINGS_CHANGED → regenerating (no STOP_AUDIO)', () => {
      const { machine, actions } = send(playing, 'SETTINGS_CHANGED');
      assert.equal(machine.phase, 'regenerating');
      assert.equal(machine.dirty, false);
      assert.deepEqual(actions, ['UI_LOADING', 'GENERATE']);
    });

    it('GEN_COMPLETE → playing (stale, no-op)', () => {
      const { machine, actions } = send(playing, 'GEN_COMPLETE');
      assert.equal(machine.phase, 'playing');
      assert.deepEqual(actions, []);
    });

    it('AUDIO_READY → playing (stale, no-op)', () => {
      const { machine, actions } = send(playing, 'AUDIO_READY');
      assert.equal(machine.phase, 'playing');
      assert.deepEqual(actions, []);
    });

    it('ERROR → playing (stale, no-op)', () => {
      const { machine, actions } = send(playing, 'ERROR');
      assert.equal(machine.phase, 'playing');
      assert.deepEqual(actions, []);
    });
  });

  // === Regenerating state transitions ===

  describe('regenerating', () => {
    let regenerating;
    {
      let m = send(create(), 'PLAY').machine;
      m = send(m, 'AUDIO_READY').machine;
      regenerating = send(m, 'SETTINGS_CHANGED').machine;
    }

    it('STOP → idle', () => {
      const { machine, actions } = send(regenerating, 'STOP');
      assert.equal(machine.phase, 'idle');
      assert.equal(machine.dirty, false);
      assert.deepEqual(actions, ['STOP_AUDIO', 'UI_STOPPED']);
    });

    it('PLAY → idle (toggle off)', () => {
      const { machine, actions } = send(regenerating, 'PLAY');
      assert.equal(machine.phase, 'idle');
      assert.deepEqual(actions, ['STOP_AUDIO', 'UI_STOPPED']);
    });

    it('SETTINGS_CHANGED → regenerating (dirty, no actions)', () => {
      const { machine, actions } = send(regenerating, 'SETTINGS_CHANGED');
      assert.equal(machine.phase, 'regenerating');
      assert.equal(machine.dirty, true);
      assert.deepEqual(actions, []);
    });

    it('GEN_COMPLETE (clean) → regenerating, LOAD_AUDIO', () => {
      const { machine, actions } = send(regenerating, 'GEN_COMPLETE');
      assert.equal(machine.phase, 'regenerating');
      assert.equal(machine.dirty, false);
      assert.deepEqual(actions, ['LOAD_AUDIO']);
    });

    it('GEN_COMPLETE (dirty) → regenerating, GENERATE (restart)', () => {
      const dirtyRegen = send(regenerating, 'SETTINGS_CHANGED').machine;
      const { machine, actions } = send(dirtyRegen, 'GEN_COMPLETE');
      assert.equal(machine.phase, 'regenerating');
      assert.equal(machine.dirty, false);
      assert.deepEqual(actions, ['GENERATE']);
    });

    it('AUDIO_READY (clean) → playing', () => {
      const { machine, actions } = send(regenerating, 'AUDIO_READY');
      assert.equal(machine.phase, 'playing');
      assert.equal(machine.dirty, false);
      assert.deepEqual(actions, ['PLAY_AUDIO', 'UI_PLAYING']);
    });

    it('AUDIO_READY (dirty) → regenerating, GENERATE (restart)', () => {
      const dirtyRegen = send(regenerating, 'SETTINGS_CHANGED').machine;
      const { machine, actions } = send(dirtyRegen, 'AUDIO_READY');
      assert.equal(machine.phase, 'regenerating');
      assert.equal(machine.dirty, false);
      assert.deepEqual(actions, ['GENERATE']);
    });

    it('ERROR → playing (keep old audio)', () => {
      const { machine, actions } = send(regenerating, 'ERROR');
      assert.equal(machine.phase, 'playing');
      assert.equal(machine.dirty, false);
      assert.deepEqual(actions, ['SHOW_ERROR']);
    });

    it('PLAY_CACHED → regenerating (no-op)', () => {
      const { machine, actions } = send(regenerating, 'PLAY_CACHED');
      assert.equal(machine.phase, 'regenerating');
      assert.deepEqual(actions, []);
    });
  });

  // === End-to-end scenarios ===

  describe('scenarios', () => {

    it('normal play cycle: PLAY → GEN_COMPLETE → AUDIO_READY → STOP', () => {
      let m = create();

      let r = send(m, 'PLAY');
      m = r.machine;
      assert.equal(m.phase, 'generating');

      r = send(m, 'GEN_COMPLETE');
      m = r.machine;
      assert.equal(m.phase, 'generating');
      assert.deepEqual(r.actions, ['LOAD_AUDIO']);

      r = send(m, 'AUDIO_READY');
      m = r.machine;
      assert.equal(m.phase, 'playing');
      assert.deepEqual(r.actions, ['PLAY_AUDIO', 'UI_PLAYING']);

      r = send(m, 'STOP');
      m = r.machine;
      assert.equal(m.phase, 'idle');
      assert.deepEqual(r.actions, ['STOP_AUDIO', 'UI_STOPPED']);
    });

    it('stop during generation prevents playback (bug fix)', () => {
      let m = create();

      m = send(m, 'PLAY').machine;
      assert.equal(m.phase, 'generating');

      m = send(m, 'STOP').machine;
      assert.equal(m.phase, 'idle');

      // Stale GEN_COMPLETE is ignored in idle
      let r = send(m, 'GEN_COMPLETE');
      assert.equal(r.machine.phase, 'idle');
      assert.deepEqual(r.actions, []);

      // Stale AUDIO_READY is also ignored
      r = send(m, 'AUDIO_READY');
      assert.equal(r.machine.phase, 'idle');
      assert.deepEqual(r.actions, []);
    });

    it('settings change during generation triggers restart on GEN_COMPLETE', () => {
      let m = create();

      m = send(m, 'PLAY').machine;
      m = send(m, 'SETTINGS_CHANGED').machine;
      assert.equal(m.dirty, true);

      // GEN_COMPLETE while dirty → restart generation
      const r = send(m, 'GEN_COMPLETE');
      assert.equal(r.machine.phase, 'generating');
      assert.equal(r.machine.dirty, false);
      assert.deepEqual(r.actions, ['GENERATE']);
    });

    it('settings change during audio load triggers restart on AUDIO_READY', () => {
      let m = create();

      m = send(m, 'PLAY').machine;

      // GEN_COMPLETE (clean) → LOAD_AUDIO
      let r = send(m, 'GEN_COMPLETE');
      m = r.machine;
      assert.deepEqual(r.actions, ['LOAD_AUDIO']);

      // Settings change during load
      m = send(m, 'SETTINGS_CHANGED').machine;
      assert.equal(m.dirty, true);

      // AUDIO_READY while dirty → restart
      r = send(m, 'AUDIO_READY');
      assert.equal(r.machine.phase, 'generating');
      assert.equal(r.machine.dirty, false);
      assert.deepEqual(r.actions, ['GENERATE']);
    });

    it('multiple settings changes collapse to one restart', () => {
      let m = create();

      m = send(m, 'PLAY').machine;
      m = send(m, 'SETTINGS_CHANGED').machine;
      m = send(m, 'SETTINGS_CHANGED').machine;
      m = send(m, 'SETTINGS_CHANGED').machine;
      assert.equal(m.dirty, true);

      // GEN_COMPLETE restarts once
      let r = send(m, 'GEN_COMPLETE');
      m = r.machine;
      assert.equal(m.dirty, false);
      assert.deepEqual(r.actions, ['GENERATE']);

      // Next GEN_COMPLETE proceeds normally
      r = send(m, 'GEN_COMPLETE');
      assert.deepEqual(r.actions, ['LOAD_AUDIO']);
    });

    it('fast resume with PLAY_CACHED', () => {
      const r = send(create(), 'PLAY_CACHED');
      assert.equal(r.machine.phase, 'playing');
      assert.deepEqual(r.actions, ['RESUME_AUDIO', 'UI_PLAYING']);
    });

    it('error during generation returns to idle', () => {
      let m = send(create(), 'PLAY').machine;
      const r = send(m, 'ERROR');
      assert.equal(r.machine.phase, 'idle');
      assert.deepEqual(r.actions, ['SHOW_ERROR', 'UI_STOPPED']);
    });

    it('regeneration: settings change while playing keeps audio running', () => {
      let m = create();
      m = send(m, 'PLAY').machine;
      m = send(m, 'AUDIO_READY').machine;
      assert.equal(m.phase, 'playing');

      // Settings change → regenerating (no STOP_AUDIO)
      let r = send(m, 'SETTINGS_CHANGED');
      m = r.machine;
      assert.equal(m.phase, 'regenerating');
      assert.ok(!r.actions.includes('STOP_AUDIO'));
      assert.deepEqual(r.actions, ['UI_LOADING', 'GENERATE']);

      // Generation completes → load audio
      r = send(m, 'GEN_COMPLETE');
      m = r.machine;
      assert.deepEqual(r.actions, ['LOAD_AUDIO']);

      // Audio loaded → play (crossfade)
      r = send(m, 'AUDIO_READY');
      m = r.machine;
      assert.equal(m.phase, 'playing');
      assert.deepEqual(r.actions, ['PLAY_AUDIO', 'UI_PLAYING']);
    });

    it('regeneration error keeps old audio playing', () => {
      let m = create();
      m = send(m, 'PLAY').machine;
      m = send(m, 'AUDIO_READY').machine;
      m = send(m, 'SETTINGS_CHANGED').machine;
      assert.equal(m.phase, 'regenerating');

      const r = send(m, 'ERROR');
      assert.equal(r.machine.phase, 'playing');
      assert.deepEqual(r.actions, ['SHOW_ERROR']);
    });

    it('multiple settings changes during regeneration collapse', () => {
      let m = create();
      m = send(m, 'PLAY').machine;
      m = send(m, 'AUDIO_READY').machine;
      m = send(m, 'SETTINGS_CHANGED').machine;
      assert.equal(m.phase, 'regenerating');

      // Multiple settings changes → just dirty
      m = send(m, 'SETTINGS_CHANGED').machine;
      m = send(m, 'SETTINGS_CHANGED').machine;
      assert.equal(m.dirty, true);

      // GEN_COMPLETE restarts
      let r = send(m, 'GEN_COMPLETE');
      m = r.machine;
      assert.equal(m.dirty, false);
      assert.deepEqual(r.actions, ['GENERATE']);

      // Next GEN_COMPLETE proceeds
      r = send(m, 'GEN_COMPLETE');
      assert.deepEqual(r.actions, ['LOAD_AUDIO']);
    });

    it('stop during regeneration stops everything', () => {
      let m = create();
      m = send(m, 'PLAY').machine;
      m = send(m, 'AUDIO_READY').machine;
      m = send(m, 'SETTINGS_CHANGED').machine;
      assert.equal(m.phase, 'regenerating');

      const r = send(m, 'STOP');
      assert.equal(r.machine.phase, 'idle');
      assert.deepEqual(r.actions, ['STOP_AUDIO', 'UI_STOPPED']);
    });

    it('stop + replay race: old generation stale in new generating state', () => {
      let m = create();

      // Start first generation
      m = send(m, 'PLAY').machine;
      assert.equal(m.phase, 'generating');

      // Stop
      m = send(m, 'STOP').machine;
      assert.equal(m.phase, 'idle');

      // Start second generation
      m = send(m, 'PLAY').machine;
      assert.equal(m.phase, 'generating');

      // State machine is in generating — GEN_COMPLETE would be processed.
      // genToken (in app.js) prevents the old generation's result from dispatching.
      // But if it did dispatch, LOAD_AUDIO fires — the app layer token guard is what
      // prevents loading stale audio. The state machine correctly processes the event.
      const r = send(m, 'GEN_COMPLETE');
      assert.equal(r.machine.phase, 'generating');
      assert.deepEqual(r.actions, ['LOAD_AUDIO']);
    });
  });
});
