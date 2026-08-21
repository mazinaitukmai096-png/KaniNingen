import assert from 'node:assert/strict';
import test from 'node:test';

import { SETTLEMENT_TYPES } from '../src/settlement-type.js';
import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { createRoadGraphV3SettlementTemplate } from '../src/infinite-world/road-graph-v3-settlement-adapter.js';

test('v3 Building boundary checkpoints preserve the canonical template', async () => {
  const generator = await createDistributedSettlementChunkGenerator({
    worldSeed: 'W5 distributed golden',
  });
  try {
    const candidates = await generator.distributor.findInMacroRange(-10, 10, -10, 10);
    const candidate = candidates.find(value => value.settlementType === SETTLEMENT_TYPES.RURAL);
    assert.ok(candidate);
    const connectivityGraph = await generator.distributor.buildConnectivityGraphNear(
      candidate.center.x,
      candidate.center.z,
      candidate.radiusMeters,
    );
    let boundaryCheckpointCount = 0;
    const input = {
      worldSeedHash: generator.worldSeedHash,
      candidate,
      connectivityGraph,
    };
    const [actual, expected] = await Promise.all([
      createRoadGraphV3SettlementTemplate({
        ...input,
        checkpoint(details) {
          if (details?.site === 'road-v3-settlement-building-boundary') {
            boundaryCheckpointCount += 1;
          }
        },
      }),
      createRoadGraphV3SettlementTemplate(input),
    ]);

    assert.ok(boundaryCheckpointCount >= 2);
    assert.deepEqual(actual, expected);
  } finally {
    await generator.shutdown();
  }
});
