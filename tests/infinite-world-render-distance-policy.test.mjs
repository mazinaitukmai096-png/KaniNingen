import test from 'node:test';
import assert from 'node:assert/strict';
import {
  W8_DEFAULT_RENDER_DISTANCE_PRESET,
  W8_RENDER_FOG_COLOR_HEX,
  W8_RENDER_DISTANCE_PRESETS,
  normalizeW8RenderDistancePreset,
  resolveW8RenderDistancePolicy,
  resolveW8SettlementHandoffState,
} from '../src/infinite-world/render-distance-policy.js';
import {
  W8_SETTLEMENT_SILHOUETTE_COLOR_HEX,
  resolveW8RemoteSettlementAtmosphere,
  resolveW8SettlementPresentationPolicy,
} from '../src/infinite-world/settlement-presentation-policy.js';
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
      majorSilhouette: policy.majorSilhouetteVisibilityMeters,
      settlementHorizon: policy.settlementHorizonMeters,
    }],
  )), {
    short: {
      natural: 84, terrainRiver: 192, generalObject: 112.5,
      majorSilhouette: 163.636364, settlementHorizon: 352,
    },
    standard: {
      natural: 112, terrainRiver: 256, generalObject: 150,
      majorSilhouette: 218.181818, settlementHorizon: 656.25,
    },
    current: {
      natural: 140, terrainRiver: 352, generalObject: 187.5,
      majorSilhouette: 300, settlementHorizon: 875,
    },
  });
  assert.equal(Object.isFrozen(W8_RENDER_DISTANCE_PRESETS), true);
  assert.equal(resolveW8RenderDistancePolicy('invalid'), W8_RENDER_DISTANCE_PRESETS.current);
  assert.equal(normalizeW8RenderDistancePreset(undefined), 'current');
});

test('Building handoff bands are centered on each unchanged full-distance boundary', () => {
  const expected = {
    short: { start: 80.4, center: 84, end: 87.6, width: 7.2 },
    standard: { start: 107.2, center: 112, end: 116.8, width: 9.6 },
    current: { start: 134, center: 140, end: 146, width: 12 },
  };
  for (const [presetId, values] of Object.entries(expected)) {
    const lod = resolveW8RenderDistancePolicy(presetId).settlementLod;
    assert.deepEqual({
      start: lod.handoffStartMeters,
      center: lod.fullDistanceMeters,
      end: lod.handoffEndMeters,
      width: lod.handoffWidthMeters,
    }, values);

    const samples = [
      [values.center - 10, 1, 0, 'full'],
      [values.start, 1, 0, 'full'],
      [values.center, 0.5, 0.5, 'full-horizon-handoff'],
      [values.end, 0, 1, 'horizon'],
      [values.center + 10, 0, 1, 'horizon'],
    ];
    for (const [distanceMeters, fullOpacity, horizonOpacity, selectedTier] of samples) {
      const state = resolveW8SettlementHandoffState(distanceMeters, presetId);
      assert.equal(state.fullOpacity, fullOpacity);
      assert.equal(state.horizonOpacity, horizonOpacity);
      assert.equal(state.totalOpacity, 1);
      assert.equal(state.selectedTier, selectedTier);
    }
  }
});

test('Building handoff is continuous at one-centimeter resolution and direction-independent', () => {
  for (const presetId of ['short', 'standard', 'current']) {
    const lod = resolveW8RenderDistancePolicy(presetId).settlementLod;
    const forward = [];
    for (let centimeters = Math.round((lod.handoffStartMeters - 0.1) * 100);
      centimeters <= Math.round((lod.handoffEndMeters + 0.1) * 100);
      centimeters += 1) {
      const state = resolveW8SettlementHandoffState(centimeters / 100, presetId);
      assert.ok(state.fullOpacity >= 0 && state.fullOpacity <= 1);
      assert.ok(state.horizonOpacity >= 0 && state.horizonOpacity <= 1);
      assert.equal(state.totalOpacity, 1);
      assert.notEqual(state.fullOpacity === 0 && state.horizonOpacity === 0, true);
      if (forward.length > 0) {
        assert.ok(Math.abs(state.horizonOpacity - forward.at(-1).horizonOpacity) < 0.003,
          `${presetId} handoff must not jump between adjacent centimeter samples`);
      }
      forward.push(state);
    }
    const reverse = [...forward].reverse().map(state => (
      resolveW8SettlementHandoffState(state.distanceMeters, presetId)
    ));
    assert.deepEqual(reverse, [...forward].reverse(),
      `${presetId} handoff must not depend on approach direction or frame history`);
  }
});

test('Settlement atmosphere keeps Current metadata and render reach while presets step through detail', () => {
  const expected = {
    short: { metadata: 352, full: 84, mid: 112.5, remote: false, end: 112.5 },
    standard: { metadata: 656.25, full: 112, mid: 150, remote: false, end: 150 },
    current: { metadata: 875, full: 140, mid: 187.5, remote: true, end: 875 },
  };
  for (const [presetId, values] of Object.entries(expected)) {
    const high = resolveW8SettlementPresentationPolicy('high', presetId);
    const medium = resolveW8SettlementPresentationPolicy('medium', presetId);
    const low = resolveW8SettlementPresentationPolicy('low', presetId);
    assert.equal(high.metadata.queryDistanceMeters, values.metadata);
    assert.equal(high.local.fullDistanceMeters, values.full);
    assert.equal(high.local.hiddenDistanceMeters, values.mid);
    assert.equal(high.remote.enabled, values.remote);
    assert.equal(high.remote.hiddenDistanceMeters, values.end);
    assert.equal(high.remote.fadeEndMeters, values.end);
    assert.equal(medium.remote.hiddenDistanceMeters, high.remote.hiddenDistanceMeters);
    assert.equal(low.remote.hiddenDistanceMeters, high.remote.hiddenDistanceMeters);
    assert.equal(high.remote.partsPerBuilding, 2);
    assert.equal(medium.remote.partsPerBuilding, 1);
    assert.equal(low.remote.partsPerBuilding, 1);
  }

  const start = resolveW8RemoteSettlementAtmosphere({
    boundaryDistanceMeters: 187.5,
    renderDistancePreset: 'current',
  });
  const middle = resolveW8RemoteSettlementAtmosphere({
    boundaryDistanceMeters: (187.5 + 875) / 2,
    renderDistancePreset: 'current',
  });
  const fogEdge = resolveW8RemoteSettlementAtmosphere({
    boundaryDistanceMeters: 300,
    renderDistancePreset: 'current',
  });
  const end = resolveW8RemoteSettlementAtmosphere({
    boundaryDistanceMeters: 875,
    renderDistancePreset: 'current',
  });
  assert.deepEqual(start, {
    visible: true,
    opacity: 1,
    fogBlend: 0,
    contrast: 1,
    colorHex: W8_SETTLEMENT_SILHOUETTE_COLOR_HEX,
  });
  assert.equal(fogEdge.opacity, 0.28);
  assert.equal(fogEdge.fogBlend, 0.72);
  assert.equal(fogEdge.contrast, 0.28);
  assert.ok(middle.opacity > 0 && middle.opacity < fogEdge.opacity);
  assert.ok(middle.fogBlend > fogEdge.fogBlend && middle.fogBlend < 0.96);
  assert.ok(Math.abs(middle.contrast - (1 - middle.fogBlend)) < 1e-6);
  assert.notEqual(middle.colorHex, start.colorHex);
  const startBefore = resolveW8RemoteSettlementAtmosphere({
    boundaryDistanceMeters: 187.499,
    renderDistancePreset: 'current',
  });
  const startAfter = resolveW8RemoteSettlementAtmosphere({
    boundaryDistanceMeters: 187.501,
    renderDistancePreset: 'current',
  });
  assert.ok(Math.abs(startBefore.opacity - startAfter.opacity) <= 0.000001);
  assert.equal(startBefore.colorHex, startAfter.colorHex);
  const endApproach = resolveW8RemoteSettlementAtmosphere({
    boundaryDistanceMeters: 874,
    renderDistancePreset: 'current',
  });
  assert.ok(endApproach.opacity >= 0 && endApproach.opacity < 0.00001);
  assert.deepEqual(end, {
    visible: false,
    opacity: 0,
    fogBlend: 0.96,
    contrast: 0.04,
    colorHex: 0x5ca8db,
  });
  assert.equal(W8_RENDER_FOG_COLOR_HEX, 0x5dade2);
});

test('remote Settlement atmosphere never reports an opacity-zero presentation as visible', () => {
  const roundedToTransparent = resolveW8RemoteSettlementAtmosphere({
    boundaryDistanceMeters: 874.9,
    renderDistancePreset: 'current',
  });
  assert.equal(roundedToTransparent.opacity, 0);
  assert.equal(roundedToTransparent.visible, false);
});

test('remote Settlement visibility follows the rounded opacity at the Current horizon', () => {
  const boundary = [
    [874, 0.000003, true],
    [874.5, 0.000001, true],
    [874.9, 0, false],
    [875, 0, false],
    [875.1, 0, false],
  ];
  for (const [boundaryDistanceMeters, opacity, visible] of boundary) {
    const atmosphere = resolveW8RemoteSettlementAtmosphere({
      boundaryDistanceMeters,
      renderDistancePreset: 'current',
    });
    assert.equal(atmosphere.opacity, opacity);
    assert.equal(atmosphere.visible, visible);
    assert.equal(atmosphere.visible, atmosphere.opacity > 0);
  }
  const beforeRoundingBoundary = resolveW8RemoteSettlementAtmosphere({
    boundaryDistanceMeters: 874.556,
    renderDistancePreset: 'current',
  });
  const afterRoundingBoundary = resolveW8RemoteSettlementAtmosphere({
    boundaryDistanceMeters: 874.5565,
    renderDistancePreset: 'current',
  });
  assert.deepEqual({
    opacity: beforeRoundingBoundary.opacity,
    visible: beforeRoundingBoundary.visible,
  }, { opacity: 0.000001, visible: true });
  assert.deepEqual({
    opacity: afterRoundingBoundary.opacity,
    visible: afterRoundingBoundary.visible,
  }, { opacity: 0, visible: false });
  for (let millimeters = 874_000; millimeters <= 875_100; millimeters += 1) {
    const atmosphere = resolveW8RemoteSettlementAtmosphere({
      boundaryDistanceMeters: millimeters / 1_000,
      renderDistancePreset: 'current',
    });
    assert.equal(atmosphere.visible, atmosphere.opacity > 0);
  }
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
