import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NATURAL_OWNER_BUILD_QUEUE_MAXIMUM,
  resolveNaturalOwnerBuildQueueTarget,
} from '../src/infinite-world/streaming-capacity-budget.js';

test('Natural owner build queue target is bounded and backlog-aware', () => {
  assert.equal(resolveNaturalOwnerBuildQueueTarget({ backlog: 0 }), 0);
  assert.equal(resolveNaturalOwnerBuildQueueTarget({ backlog: 1 }), 1);
  assert.equal(resolveNaturalOwnerBuildQueueTarget({ backlog: 2 }), 2);
  assert.equal(resolveNaturalOwnerBuildQueueTarget({ backlog: 17 }), 2);
  assert.equal(resolveNaturalOwnerBuildQueueTarget({ backlog: 18 }), 3);
  assert.equal(resolveNaturalOwnerBuildQueueTarget({ backlog: 34 }), 4);
  assert.equal(resolveNaturalOwnerBuildQueueTarget({ backlog: 10_000 }), 4);
  assert.equal(NATURAL_OWNER_BUILD_QUEUE_MAXIMUM, 4);
});

test('Natural owner build queue target rejects invalid backlog', () => {
  for (const backlog of [-1, 0.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => resolveNaturalOwnerBuildQueueTarget({ backlog }), RangeError);
  }
});
