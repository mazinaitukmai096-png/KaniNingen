import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { after } from 'node:test';

import { SETTLEMENT_TYPES } from '../src/settlement-type.js';
import {
  BLOCK_GENERATOR_V1_ID,
  BLOCK_V1_SOURCE_ROAD_GRAPH_VERSION,
  createRoadGraphV1Blocks,
  deriveBlockPolygon,
  normalizeBoundaryEdgeCycle,
  validateRoadGraphV1Blocks,
} from '../src/infinite-world/block-generator-v1.js';
import {
  EXPERIMENTAL_SETTLEMENT_STAGE_GENERATOR_REGISTRY,
  ROAD_GRAPH_V1_GENERATOR_ID,
  ROAD_GRAPH_V1_PROFILE_REVISION,
  ROAD_GRAPH_V1_SCHEMA,
  ROAD_GRAPH_V1_SEGMENT_SCHEMA,
  createRoadGraphV1,
  validateRoadGraphV1,
} from '../src/infinite-world/road-graph-v1.js';
import {
  createRoadGraphV1SettlementTemplate,
  resolveRoadGraphV1ConnectivityGateways,
} from '../src/infinite-world/road-graph-v1-settlement-adapter.js';
import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { canonicalizeJson } from '../src/infinite-world/legacy-core/g0/canonical-json.js';
import { hashWorldSeed } from '../src/infinite-world/legacy-core/g0/seed.js';
import { sha256Hex } from '../src/infinite-world/legacy-core/g0/sha256.js';
import {
  SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
  createSettlementSemanticStableId,
} from '../src/infinite-world/settlement-semantic-identity.js';

const repoRoot = resolve(import.meta.dirname, '..');
const worldSeed = 'W5 distributed golden';
const worldSeedHashPromise = hashWorldSeed(worldSeed).then(result => result.worldSeedHash);
const fixturePromise = (async () => {
  const generator = await createDistributedSettlementChunkGenerator({ worldSeed });
  const candidates = await generator.distributor.findInMacroRange(-10, 10, -10, 10);
  const byType = Object.fromEntries(Object.values(SETTLEMENT_TYPES).map(settlementType => [
    settlementType,
    candidates.find(candidate => candidate.settlementType === settlementType),
  ]));
  assert.ok(Object.values(byType).every(Boolean));
  return { generator, byType };
})();

after(async () => {
  const { generator } = await fixturePromise;
  await generator.shutdown();
});

function syntheticRoadGraph({ settlementType, hasGateway, hasBlock }) {
  const settlementId = `synthetic:${settlementType}:${hasGateway ? 'gateway' : 'isolated'}:${hasBlock ? 'block' : 'open'}`;
  const positions = hasBlock
    ? { a: { x: 0, z: 0 }, b: { x: 4, z: 0 }, c: { x: 4, z: 3 }, d: { x: 0, z: 3 } }
    : { a: { x: 0, z: 0 }, b: { x: 4, z: 0 }, c: { x: 4, z: 3 } };
  if (hasGateway) positions.g = { x: -3, z: 0 };
  const nodes = Object.freeze(Object.entries(positions).map(([nodeId, position]) => Object.freeze({
    nodeId,
    stableId: nodeId,
    role: nodeId === 'g' ? 'connectivity-gateway' : 'local-junction',
    position: Object.freeze(position),
    purpose: `synthetic:${nodeId}`,
  })));
  const pairs = hasBlock
    ? [['edge-a', 'a', 'b'], ['edge-b', 'b', 'c'], ['edge-c', 'c', 'd'], ['edge-d', 'd', 'a']]
    : [['edge-a', 'a', 'b'], ['edge-b', 'b', 'c']];
  if (hasGateway) pairs.push(['edge-gateway', 'a', 'g']);
  const sourceOwner = Object.freeze({ settlementId, macroRegion: Object.freeze({ x: 0, z: 0 }) });
  const edges = Object.freeze(pairs.map(([edgeId, startNodeId, endNodeId]) => Object.freeze({
    edgeId,
    stableId: edgeId,
    startNodeId,
    endNodeId,
    class: edgeId === 'edge-gateway' ? 'arterial' : 'local',
    purpose: `synthetic:${edgeId}`,
    profileRevision: ROAD_GRAPH_V1_PROFILE_REVISION,
    sourceOwner,
    flags: Object.freeze({ connectivityGateway: edgeId === 'edge-gateway' }),
  })));
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const segments = Object.freeze(edges.map(edge => {
    const start = nodesById.get(edge.startNodeId).position;
    const end = nodesById.get(edge.endNodeId).position;
    const length = Math.hypot(end.x - start.x, end.z - start.z);
    const tangent = Object.freeze({ x: (end.x - start.x) / length, z: (end.z - start.z) / length });
    return Object.freeze({
      schemaVersion: ROAD_GRAPH_V1_SEGMENT_SCHEMA,
      stableId: edge.edgeId,
      edgeId: edge.edgeId,
      class: edge.class,
      start,
      end,
      tangent,
      normal: Object.freeze({ x: -tangent.z, z: tangent.x }),
      widthMeters: edge.class === 'arterial' ? 1 : 0.5,
      sourceOwner,
      purpose: edge.purpose,
      flags: edge.flags,
    });
  }));
  return Object.freeze({
    schemaVersion: ROAD_GRAPH_V1_SCHEMA,
    generatorId: ROAD_GRAPH_V1_GENERATOR_ID,
    profileRevision: ROAD_GRAPH_V1_PROFILE_REVISION,
    coordinateSpace: 'logical-world-meters',
    settlementId,
    legacySettlementClass: settlementType,
    center: Object.freeze({ x: 2, z: 1.5 }),
    sourceOwner,
    metadata: Object.freeze({
      gatewayMode: hasGateway ? 'CONNECTIVITY_GATEWAYS' : 'ISOLATED_FALLBACK',
      fallbackType: hasGateway ? null : 'OFFSET_COLLECTOR_SPINE_WITH_LOCAL_BRANCHES',
      requiredGatewayIds: Object.freeze(hasGateway ? ['synthetic-gateway'] : []),
      requiredGatewayNodeIds: Object.freeze(hasGateway ? ['g'] : []),
      fictitiousGatewayCount: 0,
      authority: ROAD_GRAPH_V1_GENERATOR_ID,
    }),
    nodes,
    edges,
    segments,
  });
}

function signedArea(points) {
  let twiceArea = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    twiceArea += points[index].x * points[index + 1].z
      - points[index + 1].x * points[index].z;
  }
  return twiceArea / 2;
}

async function actualGraphInput(candidate) {
  const { generator } = await fixturePromise;
  const connectivityGraph = await generator.distributor.buildConnectivityGraphNear(
    candidate.center.x,
    candidate.center.z,
    candidate.radiusMeters,
  );
  return {
    worldSeedHash: generator.worldSeedHash,
    settlement: {
      settlementId: candidate.settlementId,
      settlementType: candidate.settlementType,
      center: candidate.center,
      radiusMeters: candidate.radiusMeters,
      macroRegion: candidate.macroRegion,
    },
    gateways: resolveRoadGraphV1ConnectivityGateways({ candidate, connectivityGraph }),
    connectivityGraph,
  };
}

test('block-v1 is an experimental block stage and remains separate from production adapters', () => {
  const descriptor = EXPERIMENTAL_SETTLEMENT_STAGE_GENERATOR_REGISTRY.get(
    'block',
    BLOCK_GENERATOR_V1_ID,
  );
  assert.equal(descriptor?.stage, 'block');
  assert.equal(descriptor?.generatorId, BLOCK_GENERATOR_V1_ID);
  assert.equal(descriptor?.generate, createRoadGraphV1Blocks);
  const adapterSource = readFileSync(
    resolve(repoRoot, 'src/infinite-world/road-graph-v1-settlement-adapter.js'),
    'utf8',
  );
  assert.doesNotMatch(adapterSource, /createRoadGraphV1Blocks|BLOCK_GENERATOR_V1_ID|\.blocks\b/);
});

test('CITY/TOWN/RURAL with and without gateways produce only real bounded faces', async () => {
  const worldSeedHash = await worldSeedHashPromise;
  for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
    for (const hasGateway of [false, true]) {
      for (const hasBlock of [false, true]) {
        const roadGraph = syntheticRoadGraph({ settlementType, hasGateway, hasBlock });
        assert.equal(validateRoadGraphV1(roadGraph).valid, true);
        const blocks = await createRoadGraphV1Blocks({ worldSeedHash, roadGraph });
        assert.equal(blocks.length, hasBlock ? 1 : 0, `${settlementType}/${hasGateway}/${hasBlock}`);
        if (!hasBlock) continue;
        const [block] = blocks;
        assert.deepEqual(Object.keys(block), [
          'id',
          'boundaryEdgeIds',
          'boundaryNodeIds',
          'isClosed',
          'districtTag',
          'sourceRoadGraphVersion',
        ]);
        assert.equal(block.isClosed, true);
        assert.equal(block.districtTag, null);
        assert.equal(block.sourceRoadGraphVersion, BLOCK_V1_SOURCE_ROAD_GRAPH_VERSION);
        assert.equal(Object.hasOwn(block, 'polygon'), false);
        assert.equal(Object.hasOwn(block, 'coordinates'), false);
        const polygon = deriveBlockPolygon({ roadGraph, block });
        assert.ok(signedArea(polygon) > 0, 'winding is normalized and area is positive');
        const validation = await validateRoadGraphV1Blocks({ worldSeedHash, roadGraph, blocks });
        assert.equal(validation.valid, true, validation.errors.join('; '));
        assert.deepEqual({
          duplicateEdgeCount: validation.duplicateEdgeCount,
          duplicateNodeCount: validation.duplicateNodeCount,
          selfIntersectionCount: validation.selfIntersectionCount,
          unknownReferenceCount: validation.unknownReferenceCount,
          duplicateFaceCount: validation.duplicateFaceCount,
          nonPositiveAreaCount: validation.nonPositiveAreaCount,
          nonNormalizedWindingCount: validation.nonNormalizedWindingCount,
          discontinuousBoundaryCount: validation.discontinuousBoundaryCount,
          openBoundaryCount: validation.openBoundaryCount,
        }, {
          duplicateEdgeCount: 0,
          duplicateNodeCount: 0,
          selfIntersectionCount: 0,
          unknownReferenceCount: 0,
          duplicateFaceCount: 0,
          nonPositiveAreaCount: 0,
          nonNormalizedWindingCount: 0,
          discontinuousBoundaryCount: 0,
          openBoundaryCount: 0,
        });
      }
    }
  }
});

test('Block Stable ID uses the start-and-direction-normalized boundary edge cycle', async () => {
  const worldSeedHash = await worldSeedHashPromise;
  const roadGraph = syntheticRoadGraph({
    settlementType: SETTLEMENT_TYPES.CITY,
    hasGateway: true,
    hasBlock: true,
  });
  const [block] = await createRoadGraphV1Blocks({ worldSeedHash, roadGraph });
  const normalizedCycle = normalizeBoundaryEdgeCycle(block.boundaryEdgeIds);
  assert.deepEqual(normalizedCycle, ['edge-a', 'edge-b', 'edge-c', 'edge-d']);
  assert.deepEqual(
    normalizeBoundaryEdgeCycle(['edge-c', 'edge-b', 'edge-a', 'edge-d']),
    normalizedCycle,
  );
  const expected = await createSettlementSemanticStableId({
    schemaVersion: SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
    worldSeedHash,
    settlementId: roadGraph.settlementId,
    semanticKind: 'block',
    semanticLocalKey: canonicalizeJson(normalizedCycle),
  });
  assert.equal(block.id, expected.stableId);
});

test('Block sets are invariant under repetition, reversed enumeration/orientation, and parallel generation', async () => {
  const worldSeedHash = await worldSeedHashPromise;
  const graphs = Object.values(SETTLEMENT_TYPES).map(settlementType => syntheticRoadGraph({
    settlementType,
    hasGateway: true,
    hasBlock: true,
  }));
  const generate = roadGraph => createRoadGraphV1Blocks({ worldSeedHash, roadGraph });
  const first = [];
  for (const graph of graphs) first.push(await generate(graph));
  const repeated = [];
  for (const graph of graphs) repeated.push(await generate(graph));
  const reverseSettlementOrder = [];
  for (const graph of [...graphs].reverse()) reverseSettlementOrder.push(await generate(graph));
  reverseSettlementOrder.reverse();
  const reversedGraphEnumeration = await Promise.all(graphs.map(graph => generate({
    ...graph,
    nodes: Object.freeze([...graph.nodes].reverse()),
    edges: Object.freeze([...graph.edges].reverse().map(edge => Object.freeze({
      ...edge,
      startNodeId: edge.endNodeId,
      endNodeId: edge.startNodeId,
    }))),
  })));
  const parallel = await Promise.all(graphs.map(generate));
  assert.deepEqual(repeated, first);
  assert.deepEqual(reverseSettlementOrder, first);
  assert.deepEqual(reversedGraphEnumeration, first);
  assert.deepEqual(parallel, first);
});

test('open regions are omitted while the closed part of a mixed graph remains', async () => {
  const worldSeedHash = await worldSeedHashPromise;
  const roadGraph = syntheticRoadGraph({
    settlementType: SETTLEMENT_TYPES.TOWN,
    hasGateway: true,
    hasBlock: true,
  });
  const blocks = await createRoadGraphV1Blocks({ worldSeedHash, roadGraph });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].boundaryEdgeIds.includes('edge-gateway'), false);
  assert.equal(blocks[0].boundaryNodeIds.includes('g'), false);
});

test('actual road-graph-v1 CITY/TOWN/RURAL remain byte-stable and correctly yield zero Blocks', async () => {
  const { generator, byType } = await fixturePromise;
  const expectedHashes = {
    CITY: {
      gateway: 'e2885d1b73a74295fd12edd280eebcd3580a1a72dd7184ea6abca1e3ddc12d6d',
      isolated: 'f055a2f70af4e8834e77477d8559bb547f07cfe6453a38cd3308e7de55130bbb',
      roads: '0b09c76260a23bd4d6279de5cc95170ff66f06708b15a8a389f446b9f432242a',
      buildingLots: '23bc5599e23c895dacf49b5525feb67c9d0a3e16005311fe7d9bdc04aeadf608',
    },
    TOWN: {
      gateway: '4732b54e93f892bc09c2110a1c05884ae9e30c3bce6f870785e56deaeab73d16',
      isolated: '9f2ffb92474de48d95d5983377d8213d699153cf61d4525a692f162381932c11',
      roads: '9626b31b92b92d7f79252f8e5f0951bb96017eb4dbd4f6f42c4d2461903d28e5',
      buildingLots: '6a02dc9af3e3c65e81851f2afa1435467cfc9bdc876df1d1c8378115dd257a98',
    },
    RURAL: {
      gateway: 'fc71dd7a1d839014e20293497ddf6f9c7c13ea9ea0a595982c5ca28697fc60b2',
      isolated: '2c8dddf042e6ed7706d8a0e5cd84d189723b19f5d9e52cd28664a81d6edf95e2',
      roads: 'a73de8a74a364433e22b3574e83ea192e360405e90b6cf127629449f81ff2af5',
      buildingLots: 'f619faa733a73117d0f38744b5210057065254580a7115c110dd51a00386f325',
    },
  };
  for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
    const candidate = byType[settlementType];
    const input = await actualGraphInput(candidate);
    const gatewayGraph = await createRoadGraphV1(input);
    const isolatedGraph = await createRoadGraphV1({ ...input, gateways: [] });
    assert.equal(await sha256Hex(canonicalizeJson(gatewayGraph)), expectedHashes[settlementType].gateway);
    assert.equal(await sha256Hex(canonicalizeJson(isolatedGraph)), expectedHashes[settlementType].isolated);
    assert.equal((await createRoadGraphV1Blocks({
      worldSeedHash: generator.worldSeedHash,
      roadGraph: gatewayGraph,
    })).length, 0);
    assert.equal((await createRoadGraphV1Blocks({
      worldSeedHash: generator.worldSeedHash,
      roadGraph: isolatedGraph,
    })).length, 0);
    const template = await createRoadGraphV1SettlementTemplate({
      worldSeedHash: generator.worldSeedHash,
      candidate,
      connectivityGraph: input.connectivityGraph,
    });
    assert.equal(await sha256Hex(canonicalizeJson(template.roads)), expectedHashes[settlementType].roads);
    assert.equal(
      await sha256Hex(canonicalizeJson(template.buildings)),
      expectedHashes[settlementType].buildingLots,
    );
  }
});
