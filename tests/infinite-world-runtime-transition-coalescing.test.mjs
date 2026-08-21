import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuntimeTransitionLatestTargetQueue } from '../src/infinite-world/sandbox-boot.js';

const owner = (chunkX, chunkZ) => ({
  chunkX,
  chunkZ,
  key: `${chunkX},${chunkZ}`,
});

test('latest transition target coalesces intermediate owners and drains only the newest Player owner', () => {
  const queue = createRuntimeTransitionLatestTargetQueue();

  assert.equal(queue.queue(owner(33, 24), {
    speedMetersPerSecond: 30,
    velocityX: 0,
    velocityZ: 30,
    scaleStageId: 'MAX',
  }, {
    required: true,
    activeOwnerKey: '33,23',
  }), true);

  assert.equal(queue.queue(owner(33, 25), {
    speedMetersPerSecond: 30,
    velocityX: 0,
    velocityZ: 30,
    scaleStageId: 'MAX',
  }, {
    required: true,
    activeOwnerKey: '33,23',
  }), true);

  assert.deepEqual(queue.snapshot('33,23'), {
    activeOwnerKey: '33,23',
    queuedOwnerKey: '33,25',
    targetUpdateCount: 2,
    drainCount: 0,
  });

  const next = queue.consume(owner(33, 25), { centered: false });
  assert.equal(next.owner.key, '33,25');
  assert.equal(next.required, true);
  assert.equal(next.movement.speedMetersPerSecond, 30);
  assert.deepEqual(queue.snapshot(null), {
    activeOwnerKey: null,
    queuedOwnerKey: null,
    targetUpdateCount: 2,
    drainCount: 1,
  });
});

test('returning to the active transition owner clears a stale queued target', () => {
  const queue = createRuntimeTransitionLatestTargetQueue();
  queue.queue(owner(33, 25), null, { activeOwnerKey: '33,24' });
  assert.equal(queue.snapshot('33,24').queuedOwnerKey, '33,25');

  assert.equal(queue.queue(owner(33, 24), null, { activeOwnerKey: '33,24' }), false);
  assert.equal(queue.snapshot('33,24').queuedOwnerKey, null);
});

test('consume uses the current Player owner even if the last queued owner became stale', () => {
  const queue = createRuntimeTransitionLatestTargetQueue();
  queue.queue(owner(33, 25), { speedMetersPerSecond: 30 }, {
    required: true,
    activeOwnerKey: '33,24',
  });

  const next = queue.consume(owner(34, 25), { centered: false });
  assert.equal(next.owner.key, '34,25');
  assert.equal(next.required, false);
  assert.equal(next.movement, null);
});

test('consume does not schedule work when runtime already matches the Player owner', () => {
  const queue = createRuntimeTransitionLatestTargetQueue();
  queue.queue(owner(33, 25), null, { activeOwnerKey: '33,24' });
  assert.equal(queue.consume(owner(33, 25), { centered: true }), null);
  assert.equal(queue.snapshot(null).queuedOwnerKey, null);
});
