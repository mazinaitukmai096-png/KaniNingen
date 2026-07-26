import test from 'node:test';
import assert from 'node:assert/strict';

import {
  W8_COMBAT_COMMAND_TYPES,
  W8_PRESENTATION_EVENT_SCHEMA,
  createCombatCommand,
} from '../src/infinite-world/gameplay-contract.js';
import { InfiniteGameplayRuntime } from '../src/infinite-world/gameplay-runtime.js';
import { InfiniteWorldState } from '../src/infinite-world/world-state-store.js';
import { createW8AudioDirector } from '../src/infinite-world/w8-audio.js';

class RenderAdapter {
  constructor() { this.boss = null; }
  async rebase() {}
  async loadChunk() {}
  syncEntity() {}
  async unloadChunk() {}
  syncManualBoss(value) { this.boss = value; }
  snapshot() { return {}; }
  async shutdown() {}
}

function fixture({ getChunkDataForQuery = null } = {}) {
  const worldSeedHash = `sha256:${'9'.repeat(64)}`;
  const state = new InfiniteWorldState({ worldSeed: 'W8 command', worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  const render = new RenderAdapter();
  const runtime = new InfiniteGameplayRuntime({
    worldSeedHash, generatorMajor: 800, state, renderAdapter: render, clock: () => 0,
    getChunkDataForQuery,
  });
  return { state, render, runtime };
}

test('CombatCommand distinguishes left, right and both claws while gameplay resolves once', () => {
  const { runtime } = fixture();
  const left = runtime.executeCombatCommand(createCombatCommand(W8_COMBAT_COMMAND_TYPES.LEFT, { issuedAt: 0 }));
  const cooldown = runtime.executeCombatCommand(createCombatCommand(W8_COMBAT_COMMAND_TYPES.RIGHT, { issuedAt: 10 }));
  const both = runtime.executeCombatCommand(createCombatCommand(W8_COMBAT_COMMAND_TYPES.BOTH, { issuedAt: 500 }));
  assert.equal(left.accepted, true);
  assert.equal(left.mode, 'left');
  assert.equal(cooldown.accepted, false);
  assert.equal(both.accepted, true);
  assert.equal(both.mode, 'double');
  const events = runtime.consumePresentationEffects().events;
  assert.equal(events.every(event => event.schemaVersion === W8_PRESENTATION_EVENT_SCHEMA), true);
  assert.deepEqual(events.map(event => event.type), ['left-claw-swish', 'both-claw-swish']);
  assert.deepEqual(events.map(event => event.soundCueRepeats), [1, 2],
    'finite double-claw attack plays the Swish cue twice on the same presentation frame');
});

test('Audio consumes finite same-frame cue repetitions without duplicating presentation events', async () => {
  const parameter = () => ({
    value: 0,
    setValueAtTime() {},
    exponentialRampToValueAtTime() {},
    linearRampToValueAtTime() {},
  });
  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = 'running';
      this.destination = {};
    }
    createGain() {
      return { gain: parameter(), connect() {}, disconnect() {} };
    }
    createOscillator() {
      return {
        frequency: parameter(), connect() {}, disconnect() {}, start() {}, stop() {},
        onended: null,
      };
    }
    close() { return Promise.resolve(); }
  }
  const audio = createW8AudioDirector({ globalObject: { AudioContext: FakeAudioContext } });
  audio.consume([{ soundCue: 'swish', soundCueRepeats: 2 }]);
  assert.equal(audio.snapshot().playedCueCount, 2);
  await audio.dispose();
});

test('Atomic follows airborne, cooldown, persistent-state, and Restart event order', async () => {
  const { state, runtime } = fixture({
    getChunkDataForQuery: async (chunkX, chunkZ) => ({
      chunkX, chunkZ, vegetationCandidates: [], rockCandidates: [],
      settlementFeatures: [], settlementReferences: [], ambientDetails: [],
      streetDetails: [], settlementLandmarks: [], waterSurfaces: [],
    }),
  });
  await runtime.syncActiveChunks({
    activeDataKeys: ['0,0'],
    renderedKeys: ['0,0'],
    getChunkData: async (chunkX, chunkZ) => ({
      chunkX, chunkZ, vegetationCandidates: [], rockCandidates: [],
      settlementFeatures: [], settlementReferences: [], ambientDetails: [],
      streetDetails: [], settlementLandmarks: [], waterSurfaces: [],
    }),
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  });
  const release = createCombatCommand(W8_COMBAT_COMMAND_TYPES.CHARGE_RELEASE, {
    airborne: true, chargeMs: 1_800, originY: 12.5,
  });
  const first = await runtime.executeCombatCommand(release);
  assert.equal(first.accepted, true);
  assert.deepEqual(first.queriedChunkKeys, ['0,0']);
  assert.equal(state.nuclearCooldownMs, 12_000);
  assert.equal((await runtime.executeCombatCommand(release)).reason, 'cooldown');
  const releaseEvents = runtime.consumePresentationEffects().events;
  assert.equal(releaseEvents.some(event => event.type === 'charge-release'), true);
  assert.equal(releaseEvents.some(event => event.type === 'nuclear-destruction'), true);
  assert.equal(releaseEvents.find(event => event.type === 'nuclear-destruction').logicalPosition.y, 12.5);
  assert.equal(releaseEvents.at(-1).type, 'charge-release',
    'the control event remains after every Atomic destruction event');
  await runtime.restart({
    playerSpawn: { x: 0, z: 0 },
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  });
  assert.equal(state.nuclearCooldownMs, 0);
  assert.equal(runtime.snapshot().activeProjectileCount, 0);
});

test('short charge release clears presentation and resolves the protected double-claw attack', () => {
  const { runtime } = fixture();
  runtime.executeCombatCommand(createCombatCommand(W8_COMBAT_COMMAND_TYPES.CHARGE_START));
  const result = runtime.executeCombatCommand(createCombatCommand(
    W8_COMBAT_COMMAND_TYPES.CHARGE_RELEASE,
    { airborne: false, chargeMs: 500, issuedAt: 2_000 },
  ));
  assert.equal(result.accepted, true);
  const events = runtime.consumePresentationEffects().events;
  assert.equal(events.some(event => event.type === 'charge-release'), true);
  assert.equal(events.some(event => event.type === 'both-claw-swish'), true);
  assert.equal(events.some(event => event.type === 'nuclear-destruction'), false);
});

test('Charge commands retain airborne, Scale and cooldown rejection without gameplay mutation', async () => {
  const { state, runtime } = fixture();
  state.setScaleStage('MID');
  const before = state.createSaveSnapshot();
  assert.equal(runtime.executeCombatCommand(createCombatCommand(W8_COMBAT_COMMAND_TYPES.CHARGE_START)).accepted, true);
  const result = await runtime.executeCombatCommand(createCombatCommand(
    W8_COMBAT_COMMAND_TYPES.CHARGE_RELEASE,
    { airborne: true, chargeMs: 1800 },
  ));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'scale-not-allowed');
  assert.equal(state.player.hp, before.player.hp);
  assert.equal(state.nuclearCooldownMs, before.nuclearCooldownMs);
});

test('the finite 35,000 threshold schedules one deterministic natural Boss', async () => {
  const { state, runtime } = fixture();
  state.updatePlayer({ score: 35_000 });
  runtime.executeCombatCommand(createCombatCommand(W8_COMBAT_COMMAND_TYPES.LEFT, { issuedAt: 0 }));
  for (let attempt = 0; attempt < 20 && !state.manualBossStableId; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(state.manualBossStableId);
  assert.equal(state.entityStates.get(state.manualBossStableId).bossBehavior.phase, 'slither');
  assert.equal(state.combatProgress.nextBossScore, Number.MAX_SAFE_INTEGER);
});
