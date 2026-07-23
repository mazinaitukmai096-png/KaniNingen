import test from 'node:test';
import assert from 'node:assert/strict';

import {
  W8_COMBAT_COMMAND_TYPES,
  W8_PRESENTATION_EVENT_SCHEMA,
  createCombatCommand,
} from '../src/infinite-world/gameplay-contract.js';
import { InfiniteGameplayRuntime } from '../src/infinite-world/gameplay-runtime.js';
import { InfiniteWorldState } from '../src/infinite-world/world-state-store.js';

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
});

test('Atomic follows airborne, cooldown, persistent-state, and Restart event order', async () => {
  const { state, runtime } = fixture({
    getChunkDataForQuery: async (chunkX, chunkZ) => ({
      chunkX, chunkZ, vegetationCandidates: [], rockCandidates: [],
      settlementFeatures: [], settlementReferences: [], ambientDetails: [],
      streetDetails: [], settlementLandmarks: [], waterSurfaces: [],
    }),
  });
  const release = createCombatCommand(W8_COMBAT_COMMAND_TYPES.CHARGE_RELEASE, {
    airborne: true, chargeMs: 1_800,
  });
  const first = await runtime.executeCombatCommand(release);
  assert.equal(first.accepted, true);
  assert.ok(first.queriedChunkKeys.length > 9);
  assert.equal(state.nuclearCooldownMs, 12_000);
  assert.equal((await runtime.executeCombatCommand(release)).reason, 'cooldown');
  assert.equal(runtime.consumePresentationEffects().events.some(event => event.type === 'nuclear-destruction'), true);
  await runtime.restart({
    playerSpawn: { x: 0, z: 0 },
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  });
  assert.equal(state.nuclearCooldownMs, 0);
  assert.equal(runtime.snapshot().activeProjectileCount, 0);
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
