import test from 'node:test';
import assert from 'node:assert/strict';

import {
  W8_CANONICAL_TREE_DENSITY_REFERENCE_METERS,
  W8_CANONICAL_TREE_DENSITY_SCHEMA,
  W8_CANONICAL_TREE_DENSITY_THRESHOLDS,
  W8_CANONICAL_TREE_DENSITY_TIERS,
  W8_VEGETATION_LOD_KINDS,
  W8_VEGETATION_VISIBILITY_CONTRACT_SCHEMA,
  evaluateW8VegetationLodBlend,
  isW8CanonicalTreeDensitySelected,
  resolveW8CanonicalFarTreeDensityOpacity,
  resolveW8CanonicalFarTreeDensityRank,
  resolveW8CanonicalFarTreeDensityThreshold,
  resolveW8CanonicalTreeDensityOpacity,
  resolveW8CanonicalTreeDensityThreshold,
  resolveW8CanonicalTreeDensityTier,
  resolveW8VegetationLodBlend,
  resolveW8VegetationLodPolicy,
  resolveW8VegetationVisibilityContract,
} from '../src/infinite-world/vegetation-lod-policy.js';

const q6 = value => Math.round(value * 1e6) / 1e6;

test('canonical Tree presentation keeps one Stable-ID population at every distance', () => {
  const policy = resolveW8VegetationLodPolicy(W8_VEGETATION_LOD_KINDS.TREE, 'current');
  assert.deepEqual(policy.farDensity, {
    schemaVersion: W8_CANONICAL_TREE_DENSITY_SCHEMA,
    nearMaximumDistanceMeters: 100,
    midMaximumDistanceMeters: 200,
    farMaximumDistanceMeters: 300,
    transitionWidthMeters: 8,
    nearToMid: { minimum: 100, maximum: 108 },
    midToFar: { minimum: 192, maximum: 200 },
    nearDensity: 1,
    midDensity: 1,
    farDensity: 1,
    rankFadeWidth: 0.012,
    innerDistanceMeters: 100,
    outerDistanceMeters: 300,
    innerDensity: 1,
    outerDensity: 1,
    outerFade: { minimum: 296, maximum: 304 },
  });
  assert.deepEqual(W8_CANONICAL_TREE_DENSITY_REFERENCE_METERS, {
    nearMaximum: 100, midMaximum: 200, farMaximum: 300,
    transitionWidth: 8, outerFadeWidth: 8,
  });
  assert.deepEqual(W8_CANONICAL_TREE_DENSITY_THRESHOLDS, {
    near: 1, mid: 1, far: 1,
  });
  const expectedThresholds = new Map([
    [0, 1], [100, 1], [104, 1], [108, 1],
    [150, 1], [192, 1], [196, 1], [200, 1], [300, 1],
  ]);
  for (const [distance, expected] of expectedThresholds) {
    assert.equal(resolveW8CanonicalTreeDensityThreshold(policy, distance), expected);
    assert.equal(resolveW8CanonicalFarTreeDensityThreshold(policy, distance), expected);
  }
  assert.equal(resolveW8CanonicalTreeDensityTier(policy, 100),
    W8_CANONICAL_TREE_DENSITY_TIERS.NEAR);
  assert.equal(resolveW8CanonicalTreeDensityTier(policy, 100.001),
    W8_CANONICAL_TREE_DENSITY_TIERS.MID);
  assert.equal(resolveW8CanonicalTreeDensityTier(policy, 200),
    W8_CANONICAL_TREE_DENSITY_TIERS.FAR);
  const stableIds = Array.from({ length: 105 }, (_, index) => (
    `detail-v1:vegetation:canonical-far-density:${index}`
  ));
  const selectedAt = distance => new Set(stableIds.filter(stableId => (
    isW8CanonicalTreeDensitySelected({ policy, distanceMeters: distance, stableId })
  )));
  const outer = selectedAt(300);
  const middle = selectedAt(150);
  const inner = selectedAt(100);
  const subset = (left, right) => [...left].every(stableId => right.has(stableId));
  assert.equal(subset(outer, middle), true);
  assert.equal(subset(middle, inner), true);
  assert.deepEqual(outer, middle);
  assert.deepEqual(middle, inner);
  assert.equal(inner.size, stableIds.length);
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
    for (let distance = 300; distance >= 0; distance -= 1) {
      const opacity = resolveW8CanonicalTreeDensityOpacity({
        policy,
        distanceMeters: distance,
        stableId,
      });
      assert.equal(opacity, resolveW8CanonicalFarTreeDensityOpacity({
        policy, distanceMeters: distance, stableId,
      }));
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
  assert.equal(stableIds.every(stableId => resolveW8CanonicalTreeDensityOpacity({
    policy, distanceMeters: 100, stableId,
  }) === 1), true, 'the complete Near identity set must be fully opaque');
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
  assert.deepEqual(tree.fullToForest, { minimum: 100, maximum: 108 });
  assert.deepEqual(tree.forestToAtmospheric, { minimum: 192, maximum: 196 });
  assert.deepEqual(tree.atmosphericFade, { minimum: 196, maximum: 200 });
  assert.deepEqual(tree.farFade, { minimum: 296, maximum: 304 });
});

test('Tree cross-fades conserve opacity through canonical Far and into Fog', () => {
  const at = distanceMeters => resolveW8VegetationLodBlend({
    kind: 'tree', distanceMeters, renderDistancePreset: 'current',
  });
  assert.deepEqual(
    [at(104).full, at(104).forest, at(104).atmospheric, at(104).totalOpacity],
    [0.5, 0.5, 0, 1],
  );
  assert.deepEqual(
    [at(194).full, at(194).forest, at(194).atmospheric, at(194).totalOpacity],
    [0, 0.5, 0.5, 1],
  );
  assert.equal(at(196).totalOpacity, 1);
  assert.deepEqual(
    [at(198).atmospheric, at(198).far, at(198).totalOpacity],
    [0.5, 0.5, 1],
  );
  assert.deepEqual([at(200).atmospheric, at(200).far], [0, 1]);
  assert.equal(at(296).totalOpacity, 1);
  assert.equal(at(300).totalOpacity, 0.5);
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
