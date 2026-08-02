import test from 'node:test';
import assert from 'node:assert/strict';

import {
  W8_VEGETATION_LOD_KINDS,
  evaluateW8VegetationLodBlend,
  resolveW8VegetationLodBlend,
  resolveW8VegetationLodPolicy,
} from '../src/infinite-world/vegetation-lod-policy.js';

const q6 = value => Math.round(value * 1e6) / 1e6;

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
      assert.equal(first.atmosphericFade.maximum, first.visibilityMeters);
    }
  }
  const tree = resolveW8VegetationLodPolicy('tree', 'current');
  assert.deepEqual(tree.fullToForest, { minimum: 54, maximum: 58 });
  assert.deepEqual(tree.forestToAtmospheric, { minimum: 76, maximum: 84 });
  assert.deepEqual(tree.atmosphericFade, { minimum: 124, maximum: 140 });
});

test('Tree cross-fades conserve opacity through Forest horizon and into Fog', () => {
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
    [at(132).atmospheric, at(132).horizon, at(132).totalOpacity],
    [0.5, 0.5, 1],
  );
  assert.deepEqual(
    [at(138).atmospheric, at(138).horizon, at(138).totalOpacity],
    [0.042969, 0.957031, 1],
  );
  assert.deepEqual([at(140).atmospheric, at(140).horizon], [0, 1]);
  assert.equal(at(267).totalOpacity, 0.5);
  assert.equal(at(300).totalOpacity, 0);
  assert.equal(at(300).visible, false);
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
