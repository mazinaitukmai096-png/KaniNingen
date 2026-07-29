import assert from 'node:assert/strict';
import test from 'node:test';

import {
  W8_CANONICAL_MAJOR_ROAD,
  createCanonicalMajorRoadNetwork,
  createCanonicalMajorRoadCacheKey,
  createCanonicalMajorRoadObstacles,
  majorRoadSegmentIntersectsObstacle,
  projectCanonicalMajorRoadsToChunk,
} from '../src/infinite-world/canonical-major-road-network.js';
import {
  createW8ParityChunkGenerator,
  sampleW8SurfaceHeightMeters,
} from '../src/infinite-world/w8-parity-chunk-generator.js';
import { decomposeLogicalWorldPosition } from '../src/infinite-world/chunk-coordinates.js';
import { canonicalizeJson } from '../src/infinite-world/legacy-core/g0/canonical-json.js';
import { sha256Hex } from '../src/infinite-world/legacy-core/g0/sha256.js';

const q6 = value => Math.round(value * 1e6) / 1e6;
const node = (stableId, x, z, radiusMeters, settlementType, role, ownerX) => Object.freeze({
  stableId,
  ownerRegion: Object.freeze({ x: ownerX, z: 0 }),
  settlementType,
  role,
  center: Object.freeze({ x, z }),
  radiusMeters,
  connectivityTier: settlementType === 'CITY' ? 'REGIONAL_HUB'
    : settlementType === 'TOWN' ? 'LOCAL_CENTER' : 'LOCAL',
  candidateNeighborIds: Object.freeze([]),
});
const edge = (stableId, first, second, ownerX = 0) => Object.freeze({
  schemaVersion: 'w5-settlement-connectivity-edge-1',
  stableId,
  settlementIds: Object.freeze([first, second].sort()),
  ownerRegion: Object.freeze({ x: ownerX, z: 0 }),
  distanceMeters: 100,
});

const syntheticNodes = Object.freeze([
  node('settlement-a', 0, 0, 10, 'CITY', 'capital', 0),
  node('settlement-b', 100, 0, 10, 'TOWN', 'church_town', 1),
  node('settlement-c', 100, 100, 10, 'RURAL', 'suburb', 1),
]);
const syntheticEdges = Object.freeze([
  edge('edge-a-b', 'settlement-a', 'settlement-b'),
  edge('edge-b-c', 'settlement-b', 'settlement-c', 1),
]);
const syntheticGraph = Object.freeze({
  schemaVersion: 'w5-settlement-connectivity-graph-1',
  center: Object.freeze({ x: 50, z: 50 }),
  radiusMeters: 100,
  nodes: syntheticNodes,
  edges: syntheticEdges,
});
const syntheticObstacles = createCanonicalMajorRoadObstacles({
  buildings: [
    {
      stableId: 'building-ab', x: 50, z: 0, rotationY: 0,
      widthMeters: 12, depthMeters: 12,
      lot: {
        lotStatus: 'ACTIVE', centerX: 50, centerZ: 0,
        widthMeters: 16, depthMeters: 16,
      },
    },
    {
      stableId: 'building-bc', x: 100, z: 50, rotationY: 0,
      widthMeters: 10, depthMeters: 10,
    },
  ],
  landmarks: [{
    stableId: 'landmark-ab', worldPosition: { x: 62, z: 0 }, rotationY: 0,
    widthMeters: 4, depthMeters: 4,
  }],
});

async function syntheticNetwork(graph = syntheticGraph) {
  return createCanonicalMajorRoadNetwork({
    worldSeedHash: 'sha256:phase5g-synthetic',
    graph,
    resolveObstacles: async () => syntheticObstacles,
  });
}

test('canonical MAJOR Roads are a deterministic one-to-one projection of graph edges', async () => {
  const first = await syntheticNetwork();
  const reversed = await syntheticNetwork(Object.freeze({
    ...syntheticGraph,
    nodes: Object.freeze([...syntheticNodes].reverse()),
    edges: Object.freeze([...syntheticEdges].reverse()),
  }));

  assert.equal(W8_CANONICAL_MAJOR_ROAD.widthMeters, 2.25);
  assert.equal(first.graphEdgeCount, syntheticEdges.length);
  assert.equal(first.roadCount, syntheticEdges.length);
  assert.equal(new Set(first.roads.map(road => road.stableId)).size, first.roadCount);
  assert.deepEqual(first, reversed);
  assert.deepEqual(
    new Set(first.roads.map(road => road.connectivityEdgeId)),
    new Set(syntheticEdges.map(value => value.stableId)),
  );
  assert.equal(first.roads.some(road => (
    road.settlementIds.includes('settlement-a') && road.settlementIds.includes('settlement-c')
  )), false, 'Road generation must not invent the missing complete-graph edge');

  const nodesById = new Map(syntheticNodes.map(value => [value.stableId, value]));
  for (const road of first.roads) {
    assert.equal(road.roadKind, 'MAJOR');
    assert.equal(road.widthMeters, W8_CANONICAL_MAJOR_ROAD.widthMeters);
    assert.equal(road.segments.length, road.points.length - 1);
    assert.deepEqual(road.settlementCenters, road.settlementIds.map(id => nodesById.get(id).center));
    road.terminals.forEach((terminal, index) => {
      const settlement = nodesById.get(road.settlementIds[index]);
      assert.ok(Math.hypot(
        terminal.x - settlement.center.x,
        terminal.z - settlement.center.z,
      ) <= settlement.radiusMeters + W8_CANONICAL_MAJOR_ROAD.widthMeters * 2
        + W8_CANONICAL_MAJOR_ROAD.obstacleClearanceMeters + 1e-6);
    });
    for (const segment of road.segments) {
      assert.ok(Math.hypot(
        segment.end.x - segment.start.x,
        segment.end.z - segment.start.z,
      ) <= W8_CANONICAL_MAJOR_ROAD.routeGridStepMeters + 1e-6);
      assert.equal(syntheticObstacles.some(obstacle => (
        majorRoadSegmentIntersectsObstacle(segment.start, segment.end, obstacle)
      )), false);
    }
  }
});

test('MAJOR Road cache identity rejects stale source, Surface, and contract versions', () => {
  const base = {
    worldSeedHash: `sha256:${'a'.repeat(64)}`,
    roadEdgeStableId: 'edge-cache-a',
    sourceContentHashes: [{
      settlementStableId: 'settlement-a',
      contentHash: `sha256:${'b'.repeat(64)}`,
    }],
    surfacePolicyVersion: 'surface-v1',
  };
  const key = createCanonicalMajorRoadCacheKey(base);
  assert.equal(key, createCanonicalMajorRoadCacheKey({
    ...base,
    sourceContentHashes: [...base.sourceContentHashes].reverse(),
  }));
  assert.notEqual(key, createCanonicalMajorRoadCacheKey({
    ...base,
    sourceContentHashes: [{
      ...base.sourceContentHashes[0],
      contentHash: `sha256:${'c'.repeat(64)}`,
    }],
  }));
  assert.notEqual(key, createCanonicalMajorRoadCacheKey({
    ...base,
    surfacePolicyVersion: 'surface-v2',
  }));
  assert.notEqual(key, createCanonicalMajorRoadCacheKey({
    ...base,
    roadContractVersion: 'road-v2',
  }));
});

test('MAJOR Road projection is uniquely Chunk-owned, continuous, and uses only its ground sampler', async () => {
  const network = await syntheticNetwork();
  const sample = (x, z) => q6(x * 0.01 + z * 0.02);
  const features = [];
  for (let chunkZ = -3; chunkZ <= 8; chunkZ += 1) {
    for (let chunkX = -3; chunkX <= 8; chunkX += 1) {
      features.push(...projectCanonicalMajorRoadsToChunk({
        roads: network.roads,
        chunkX,
        chunkZ,
        sampleGroundHeight: sample,
      }));
    }
  }
  assert.ok(features.length > network.roads.reduce((sum, road) => sum + road.segments.length, 0));
  assert.equal(new Set(features.map(feature => feature.stableId)).size, features.length);
  for (const feature of features) {
    const owner = decomposeLogicalWorldPosition(feature.worldPosition.x, feature.worldPosition.z);
    assert.deepEqual(feature.owningChunkCoordinate, { x: owner.chunkX, z: owner.chunkZ });
    assert.equal(feature.roadKind, 'MAJOR');
    assert.equal(feature.widthMeters, W8_CANONICAL_MAJOR_ROAD.widthMeters);
    assert.equal(feature.worldPosition.y, sample(feature.worldPosition.x, feature.worldPosition.z));
    assert.equal(feature.start.y, sample(feature.start.x, feature.start.z));
    assert.equal(feature.end.y, sample(feature.end.x, feature.end.z));
  }

  const boundaryRoad = Object.freeze({
    stableId: 'boundary-road',
    settlementIds: Object.freeze(['settlement-a', 'settlement-b']),
    settlementCenters: Object.freeze([{ x: 0, z: 16 }, { x: 32, z: 16 }]),
    terminals: Object.freeze([{ x: 0, z: 16 }, { x: 32, z: 16 }]),
    connectivityEdgeId: 'boundary-edge',
    ownerRegion: Object.freeze({ x: 0, z: 0 }),
    widthMeters: W8_CANONICAL_MAJOR_ROAD.widthMeters,
    segments: Object.freeze([Object.freeze({
      stableId: 'boundary-road:segment:0', routeOrder: 0,
      start: Object.freeze({ x: 0, z: 16 }), end: Object.freeze({ x: 4, z: 16 }),
    })]),
  });
  const lower = projectCanonicalMajorRoadsToChunk({
    roads: [boundaryRoad], chunkX: 0, chunkZ: 0, sampleGroundHeight: () => 0,
  });
  const upper = projectCanonicalMajorRoadsToChunk({
    roads: [boundaryRoad], chunkX: 0, chunkZ: 1, sampleGroundHeight: () => 0,
  });
  // The established logical ownership contract assigns an exact grid line to
  // the west/north Chunk (local coordinate 16), never to both sides.
  assert.equal(lower.length, 1);
  assert.equal(upper.length, 0);
});

test('W8 materializes graph MAJOR Roads without changing LOCAL presentation or source W5 data', {
  timeout: 30_000,
}, async () => {
  const generator = await createW8ParityChunkGenerator();
  const networkRequest = () => generator.resolveCanonicalMajorRoadNetwork({
      centerWorldX: generator.reviewSpawn.x,
      centerWorldZ: generator.reviewSpawn.z,
      radiusMeters: 1_500,
    });
  const [network, duplicateNetwork] = await Promise.all([networkRequest(), networkRequest()]);
  const warmNetwork = await generator.resolveCanonicalMajorRoadNetwork({
    centerWorldX: generator.reviewSpawn.x,
    centerWorldZ: generator.reviewSpawn.z,
    radiusMeters: 1_500,
  });
  assert.equal(network.graph.edges.length, 14);
  assert.equal(network.roadCount, 14);
  assert.equal(network.roads.reduce((total, road) => total + road.segments.length, 0), 3_427);
  assert.deepEqual(
    Object.fromEntries(['DIRECT', 'LATERAL_DOGLEG', 'GRID_FALLBACK'].map(strategy => [
      strategy,
      network.roads.filter(road => road.routingStrategy === strategy).length,
    ])),
    { DIRECT: 11, LATERAL_DOGLEG: 3, GRID_FALLBACK: 0 },
  );
  assert.deepEqual(warmNetwork.roads, network.roads);
  assert.ok(duplicateNetwork.roads.every((road, index) => road === network.roads[index]));
  assert.ok(warmNetwork.roads.every((road, index) => road === network.roads[index]));
  assert.equal(
    `sha256:${await sha256Hex(canonicalizeJson(network.roads))}`,
    'sha256:8832201fd724d985d7122cd910d0af5383c6ab7bb60dbc50faa880769fdafbdc',
  );
  const shiftedGraph = await generator.distributor.buildConnectivityGraphNear(
    generator.reviewSpawn.x + 16,
    generator.reviewSpawn.z,
    1_500,
  );
  const shiftedNodes = new Map(shiftedGraph.nodes.map(value => [value.stableId, value]));
  for (const graphNode of network.graph.nodes.filter(value => (
    Math.hypot(
      value.center.x - generator.reviewSpawn.x,
      value.center.z - generator.reviewSpawn.z,
    ) <= 1_400
  ))) {
    assert.deepEqual(
      shiftedNodes.get(graphNode.stableId)?.candidateNeighborIds,
      graphNode.candidateNeighborIds,
      'a streaming query-window shift must not change a Settlement edge set',
    );
  }
  assert.ok(network.graph.nodes.length >= 3);
  assert.equal(network.roadCount, network.graph.edges.length);
  assert.equal(new Set(network.roads.map(road => road.connectivityEdgeId)).size,
    network.graph.edges.length);
  assert.ok(network.roads.every(road => road.obstacleAudit.buildingCount > 0));
  const nodesById = new Map(network.graph.nodes.map(value => [value.stableId, value]));
  assert.ok(network.roads.every(road => road.terminals.every((terminal, index) => {
    const endpoint = nodesById.get(road.settlementIds[index]);
    return Math.hypot(
      terminal.x - endpoint.center.x,
      terminal.z - endpoint.center.z,
    ) <= endpoint.radiusMeters;
  })));

  const targetRoad = network.roads[0];
  const targetSegment = targetRoad.segments[Math.floor(targetRoad.segments.length / 2)];
  const owner = decomposeLogicalWorldPosition(
    (targetSegment.start.x + targetSegment.end.x) / 2,
    (targetSegment.start.z + targetSegment.end.z) / 2,
  );
  const chunk = await generator.generateChunk(owner.chunkX, owner.chunkZ);
  const majorFeatures = chunk.settlementFeatures.filter(feature => feature.canonicalMajorRoad);
  assert.ok(majorFeatures.some(feature => feature.sourceStableId === targetRoad.stableId));
  assert.ok(majorFeatures.every(feature => feature.roadKind === 'MAJOR'));
  assert.ok(majorFeatures.every(feature => (
    feature.worldPosition.y === sampleW8SurfaceHeightMeters(
      chunk,
      feature.worldPosition.x,
      feature.worldPosition.z,
    )
  )));
  assert.equal(chunk.sourceChunkData.settlementFeatures.some(feature => (
    feature.canonicalMajorRoad === true
  )), false);
  assert.equal(chunk.streetDetails.some(detail => majorFeatures.some(feature => (
    detail.parentRoadStableId === feature.sourceStableId
  ))), false, 'Phase 5G must not extend World Detail generation');
  assert.deepEqual(
    chunk.presentationLayers.formal.roadsAndBuildings
      .filter(feature => feature.canonicalMajorRoad).map(feature => feature.stableId),
    majorFeatures.map(feature => feature.stableId),
  );
  const diagnostic = generator.snapshot().canonicalMajorRoad;
  assert.equal(diagnostic.widthMeters, 2.25);
  assert.equal(diagnostic.routesBuilt, network.roadCount);
  assert.ok(diagnostic.routeCacheHits >= network.roadCount);
  assert.ok(diagnostic.preparationBatchCount >= 1);
  assert.ok(diagnostic.preparationBatchMaximumMs > 0);
  assert.equal(diagnostic.routeStaleCacheRejections, 0);
  assert.equal(diagnostic.obstacleStaleCacheRejections, 0);
});
