import assert from 'node:assert/strict';
import test from 'node:test';

import { InfiniteWorldState } from '../src/infinite-world/world-state-store.js';

const createState = () => new InfiniteWorldState({
  worldSeed: 'feature-damage-revision-test',
  worldSeedHash: `sha256:${'d'.repeat(64)}`,
  playerSpawn: { x: 0, z: 0 },
});

test('feature destruction snapshot is canonical and reused across unrelated frame state', () => {
  const state = createState();
  const empty = state.featureDestructionSnapshot();
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.destroyedStableIds, []);
  assert.equal(state.featureDestructionSnapshot(), empty);

  state.tickGameplayTime(16);
  state.updatePlayer({ x: 1, z: 2 });
  assert.equal(state.featureDestructionSnapshot(), empty);

  state.damageFeature({ stableId: 'wf1:tree:partial', maxHp: 80 }, 40);
  assert.equal(state.featureDamageRevision, 0,
    'partial HP changes do not invalidate the destroyed-ID membership');
  assert.equal(state.featureDestructionSnapshot(), empty);

  state.damageFeature({ stableId: 'wf1:tree:z', maxHp: 80 }, 80);
  state.damageFeature({ stableId: 'wf1:rock:a', maxHp: 600 }, 600);
  const destroyed = state.featureDestructionSnapshot();
  assert.equal(destroyed.revision, 2);
  assert.deepEqual(destroyed.destroyedStableIds, ['wf1:rock:a', 'wf1:tree:z']);
  assert.equal(destroyed.signature, '["wf1:rock:a","wf1:tree:z"]');
  assert.equal(state.featureDestructionSnapshot(), destroyed);

  state.damageFeature({ stableId: 'wf1:rock:a', maxHp: 600 }, 600);
  assert.equal(state.featureDestructionSnapshot(), destroyed,
    'repeated damage to an already-destroyed feature is a revision no-op');
});

test('feature destruction revision changes only when restore, restart, or removal changes membership', () => {
  const state = createState();
  state.damageFeature({ stableId: 'wf1:tree:test', maxHp: 80 }, 80);
  const damaged = state.featureDestructionSnapshot();
  const save = state.createSaveSnapshot();

  state.restoreSaveSnapshot(save);
  const restored = state.featureDestructionSnapshot();
  assert.equal(restored, damaged,
    'same-content hydration is handled by full reconcile and does not change membership revision');
  assert.deepEqual(restored.destroyedStableIds, damaged.destroyedStableIds);

  assert.equal(state.forgetFeatureDamage('wf1:tree:test'), true);
  const forgotten = state.featureDestructionSnapshot();
  assert.deepEqual(forgotten.destroyedStableIds, []);
  assert.equal(state.forgetFeatureDamage('wf1:tree:test'), false);
  assert.equal(state.featureDestructionSnapshot(), forgotten);

  state.restoreSaveSnapshot(save);
  const restoredMembership = state.featureDestructionSnapshot();
  assert.deepEqual(restoredMembership.destroyedStableIds, ['wf1:tree:test']);
  assert.ok(restoredMembership.revision > forgotten.revision);

  const revisionBeforeRestart = restoredMembership.revision;
  state.restartRun({ playerSpawn: { x: 4, z: 5 }, scaleStageId: 'TINY' });
  assert.ok(state.featureDamageRevision > revisionBeforeRestart);
  assert.deepEqual(state.featureDestructionSnapshot().destroyedStableIds, []);

  const emptyAfterRestart = state.featureDestructionSnapshot();
  state.restartRun({ playerSpawn: { x: 6, z: 7 }, scaleStageId: 'TINY' });
  assert.equal(state.featureDestructionSnapshot(), emptyAfterRestart,
    'restarting an already-clean membership does not manufacture a content revision');
});

test('feature destruction delta cache matches the full Map oracle under mixed updates', () => {
  const state = createState();
  let randomState = 0x9e3779b9;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState;
  };
  let previousSnapshot = state.featureDestructionSnapshot();
  for (let step = 0; step < 2_000; step += 1) {
    const stableId = `wf1:tree:delta-${random() % 96}`;
    if (random() % 5 === 0) state.forgetFeatureDamage(stableId);
    else state.damageFeature({ stableId, maxHp: 80 }, random() % 3 === 0 ? 80 : 5);

    const expected = [...state.featureDamage.values()]
      .filter(record => record.destroyed === true)
      .map(record => record.stableId)
      .sort((left, right) => left.localeCompare(right));
    const membershipChanged = expected.length !== previousSnapshot.destroyedStableIds.length
      || expected.some((stableIdValue, index) => (
        stableIdValue !== previousSnapshot.destroyedStableIds[index]
      ));
    const snapshot = state.featureDestructionSnapshot();
    assert.deepEqual(snapshot.destroyedStableIds, expected);
    assert.equal(snapshot.signature, JSON.stringify(expected));
    assert.equal(snapshot.revision,
      previousSnapshot.revision + Number(membershipChanged));
    if (!membershipChanged) assert.equal(snapshot, previousSnapshot);
    previousSnapshot = snapshot;
  }
});
