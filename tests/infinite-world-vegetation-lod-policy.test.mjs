import test from 'node:test';
import assert from 'node:assert/strict';

import {
  W8_VEGETATION_LOD_KINDS,
  W8_VEGETATION_VISIBILITY_CONTRACT_SCHEMA,
  evaluateW8VegetationLodBlend,
  resolveW8CanonicalFarTreeDensityOpacity,
  resolveW8CanonicalFarTreeDensityRank,
  resolveW8CanonicalFarTreeDensityThreshold,
  resolveW8VegetationLodBlend,
  resolveW8VegetationLodPolicy,
  resolveW8VegetationVisibilityContract,
} from '../src/infinite-world/vegetation-lod-policy.js';

const q6 = value => Math.round(value * 1e6) / 1e6;

test('canonical Far Tree density is Stable-ID keyed, nested, and monotonic on approach', () => {
  const policy = resolveW8VegetationLodPolicy(W8_VEGETATION_LOD_KINDS.TREE, 'current');
  assert.deepEqual(policy.farDensity, {
    schemaVersion: 'w8-canonical-far-tree-density-1',
    innerDistanceMeters: 140,
    outerDistanceMeters: 300,
    innerDensity: 0.48,
    outerDensity: 0.24,
    rankFadeWidth: 0.012,
  });
  assert.equal(resolveW8CanonicalFarTreeDensityThreshold(policy, 300), 0.24);
  assert.equal(resolveW8CanonicalFarTreeDensityThreshold(policy, 220), 0.36);
  assert.equal(resolveW8CanonicalFarTreeDensityThreshold(policy, 140), 0.48);
  const stableIds = Array.from({ length: 105 }, (_, index) => (
    `detail-v1:vegetation:canonical-far-density:${index}`
  ));
  const selectedAt = distance => new Set(stableIds.filter(stableId => (
    resolveW8CanonicalFarTreeDensityRank(stableId)
      < resolveW8CanonicalFarTreeDensityThreshold(policy, distance)
  )));
  const outer = selectedAt(300);
  const middle = selectedAt(220);
  const inner = selectedAt(140);
  const subset = (left, right) => [...left].every(stableId => right.has(stableId));
  assert.equal(subset(outer, middle), true);
  assert.equal(subset(middle, inner), true);
  assert.equal(inner.size < stableIds.length, true);
  const ranks = Object.fromEntries(stableIds.map(stableId => [
    stableId, resolveW8CanonicalFarTreeDensityRank(stableId),
  ]));
  const reversedRanks = Object.fromEntries([...stableIds].reverse().map(stableId => [
    stableId, resolveW8CanonicalFarTreeDensityRank(stableId),
  ]));
  assert.deepEqual(ranks, reversedRanks);
  for (const stableId of stableIds) {
    let previous = 0;
    let becameVisible = false;
    for (let distance = 300; distance >= 140; distance -= 1) {
      const opacity = resolveW8CanonicalFarTreeDensityOpacity({
        policy,
        distanceMeters: distance,
        stableId,
      });
      assert.ok(opacity + 1e-6 >= previous,
        `${stableId} became less visible while approaching at ${distance}m`);
      previous = opacity;
    }
    for (let distance = 300; distance >= 0; distance -= 1) {
      const blend = resolveW8VegetationLodBlend({
        kind: W8_VEGETATION_LOD_KINDS.TREE,
        distanceMeters: distance,
        renderDistancePreset: 'current',
      });
      const totalOpacity = blend.full + blend.forest + blend.atmospheric
        + blend.far * resolveW8CanonicalFarTreeDensityOpacity({
          policy,
          distanceMeters: distance,
          stableId,
        });
      if (totalOpacity > 0) becameVisible = true;
      if (becameVisible) assert.ok(totalOpacity > 0, `${stableId} disappeared at ${distance}m`);
    }
  }
});

test('Natural visibility contract preserves the formal Object-specific preset distances', () => {
  const expected = {
    short: { tree: 163.636364, bush: 84, grass: 64, rock: 84 },
    standard: { tree: 218.181818, bush: 112, grass: 67.2, rock: 112 },
    current: { tree: 300, bush: 140, grass: 84, rock: 140 },
  };
  for (const [preset, visibilityByKind] of Object.entries(expected)) {
    const contract = resolveW8VegetationVisibilityContract(preset);
    assert.equal(contract.schemaVersion, W8_VEGETATION_VISIBILITY_CONTRACT_SCHEMA);
    assert.equal(contract.renderDistancePreset, preset);
    assert.equal(resolveW8VegetationVisibilityContract(preset), contract);
    for (const [kind, exactDistanceMeters] of Object.entries(visibilityByKind)) {
      assert.equal(contract.byKind[kind].exactDistanceMeters, exactDistanceMeters);
      assert.equal(
        contract.byKind[kind].exactDistanceMeters,
        resolveW8VegetationLodPolicy(kind, preset).visibilityMeters,
      );
      assert.equal(contract.byKind[kind].horizonDistanceMeters, null);
    }
  }
});

test('Vegetation LOD policy is shared, ordered, and safe across Near-owner handoff', () => {
  for (const preset of ['short', 'standard', 'current']) {
    for (const kind of Object.values(W8_VEGETATION_LOD_KINDS)) {
      const first = resolveW8VegetationLodPolicy(kind, preset);
      const second = resolveW8VegetationLodPolicy(kind, preset);
      assert.equal(first, second, `${preset}/${kind} policy must be shared`);
      assert.equal(first.fullToForest.minimum >= 48, true, `${preset}/${kind}`);
      assert.equal(first.fullToForest.minimum < first.fullToForest.maximum, true);
      if (first.forestToAtmospheric) {
        assert.equal(first.fullToForest.maximum < first.forestToAtmospheric.minimum, true);
        assert.equal(first.forestToAtmospheric.minimum
          < first.forestToAtmospheric.maximum, true);
        assert.equal(first.forestToAtmospheric.maximum
          <= first.atmosphericFade.minimum, true);
      }
      assert.equal(first.atmosphericFade.minimum < first.atmosphericFade.maximum, true);
      assert.equal(first.atmosphericFade.maximum <= first.visibilityMeters, true);
      if (kind === W8_VEGETATION_LOD_KINDS.TREE) {
        assert.equal(first.farEntry, first.atmosphericFade);
        assert.equal(first.farVisibilityMeters, first.visibilityMeters);
      }
    }
  }
  const tree = resolveW8VegetationLodPolicy('tree', 'current');
  assert.deepEqual(tree.fullToForest, { minimum: 54, maximum: 58 });
  assert.deepEqual(tree.forestToAtmospheric, { minimum: 76, maximum: 84 });
  assert.deepEqual(tree.atmosphericFade, { minimum: 124, maximum: 140 });
});

test('Tree cross-fades conserve opacity through canonical Far and into Fog', () => {
  const at = distanceMeters => resolveW8VegetationLodBlend({
    kind: 'tree', distanceMeters, renderDistancePreset: 'current',
  });
  assert.deepEqual(
    [at(56).full, at(56).forest, at(56).atmospheric, at(56).totalOpacity],
    [0.5, 0.5, 0, 1],
  );
  assert.deepEqual(
    [at(80).full, at(80).forest, at(80).atmospheric, at(80).totalOpacity],
    [0, 0.5, 0.5, 1],
  );
  assert.equal(at(124).totalOpacity, 1);
  assert.deepEqual(
    [at(132).atmospheric, at(132).far, at(132).totalOpacity],
    [0.5, 0.5, 1],
  );
  assert.deepEqual(
    [at(138).atmospheric, at(138).far, at(138).totalOpacity],
    [0.042969, 0.957031, 1],
  );
  assert.deepEqual([at(140).atmospheric, at(140).far], [0, 1]);
  assert.equal(at(276).totalOpacity, 1);
  assert.equal(at(290).totalOpacity, 0.5);
  assert.equal(at(300).totalOpacity, 0.055394);
  assert.equal(at(300).visible, true);
  assert.equal(at(304).totalOpacity, 0);
  assert.equal(at(304).visible, false);
});

test('Tree, Bush, Grass, and Rock evaluate their own distance without allocation churn', () => {
  for (const kind of Object.values(W8_VEGETATION_LOD_KINDS)) {
    const policy = resolveW8VegetationLodPolicy(kind, 'current');
    const target = {};
    const center = (policy.fullToForest.minimum + policy.fullToForest.maximum) / 2;
    assert.equal(evaluateW8VegetationLodBlend(policy, center, target), target);
    assert.equal(target.crossFade, true);
    assert.equal(target.full, 0.5);
    assert.equal(q6(target.forest + target.atmospheric), 0.5);
    assert.equal(target.totalOpacity, 1);
    assert.equal(target.policy, policy);

    const separateObject = {};
    evaluateW8VegetationLodBlend(policy, 0, separateObject);
    assert.equal(separateObject.full, 1);
    assert.equal(target.full, 0.5, 'one Object distance cannot overwrite another Object state');
  }
});
