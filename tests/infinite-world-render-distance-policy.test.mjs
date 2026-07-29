import test from 'node:test';
import assert from 'node:assert/strict';
import {
  W8_DEFAULT_RENDER_DISTANCE_PRESET,
  W8_RENDER_DISTANCE_PRESETS,
  normalizeW8RenderDistancePreset,
  resolveW8RenderDistancePolicy,
} from '../src/infinite-world/render-distance-policy.js';
import {
  InfiniteWorldState,
  decodeInfiniteWorldSave,
  encodeInfiniteWorldSave,
} from '../src/infinite-world/world-state-store.js';

const WORLD_SEED_HASH = `sha256:${'9'.repeat(64)}`;

test('Render Distance exposes the three exact presets from one immutable policy source', () => {
  assert.equal(W8_DEFAULT_RENDER_DISTANCE_PRESET, 'current');
  assert.deepEqual(Object.fromEntries(Object.entries(W8_RENDER_DISTANCE_PRESETS).map(
    ([id, policy]) => [id, {
      natural: policy.naturalVisibilityMeters,
      terrainRiver: policy.terrainRiverExtentMeters,
      generalObject: policy.generalObjectVisibilityMeters,
      settlementHorizon: policy.settlementHorizonMeters,
    }],
  )), {
    short: { natural: 84, terrainRiver: 192, generalObject: 112.5, settlementHorizon: 352 },
    standard: { natural: 112, terrainRiver: 256, generalObject: 150, settlementHorizon: 656.25 },
    current: { natural: 140, terrainRiver: 352, generalObject: 187.5, settlementHorizon: 875 },
  });
  assert.equal(Object.isFrozen(W8_RENDER_DISTANCE_PRESETS), true);
  assert.equal(resolveW8RenderDistancePolicy('invalid'), W8_RENDER_DISTANCE_PRESETS.current);
  assert.equal(normalizeW8RenderDistancePreset(undefined), 'current');
});

test('missing and invalid saved Render Distance migrate to Current while a valid choice restarts intact', async () => {
  const missing = new InfiniteWorldState({
    worldSeed: 'render-distance-migration',
    worldSeedHash: WORLD_SEED_HASH,
    playerSpawn: { x: 0, z: 0 },
  });
  missing.restoreSaveSnapshot({
    ...missing.createSaveSnapshot(),
    experience: {
      ...missing.experience,
      settings: { ...missing.experience.settings, renderDistance: undefined },
    },
  });
  assert.equal(missing.experience.settings.renderDistance, 'current');

  missing.updateExperience({ settings: { renderDistance: 'corrupt' } });
  assert.equal(missing.experience.settings.renderDistance, 'current');
  missing.updateExperience({ settings: { renderDistance: 'standard' } });
  const encoded = await encodeInfiniteWorldSave(missing.createSaveSnapshot());
  const decoded = await decodeInfiniteWorldSave(encoded, { worldSeedHash: WORLD_SEED_HASH });
  const restarted = new InfiniteWorldState({
    worldSeed: 'render-distance-migration',
    worldSeedHash: WORLD_SEED_HASH,
    playerSpawn: { x: 0, z: 0 },
  });
  restarted.restoreSaveSnapshot(decoded);
  assert.equal(restarted.experience.settings.renderDistance, 'standard');
});
