import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import test, { after } from 'node:test';

import { SETTLEMENT_TYPES } from '../src/settlement-type.js';
import { canonicalizeJson } from '../src/infinite-world/legacy-core/g0/canonical-json.js';
import { hashWorldSeed } from '../src/infinite-world/legacy-core/g0/seed.js';
import {
  BLOCK_GENERATOR_V1_ID,
  createRoadGraphV1Blocks,
} from '../src/infinite-world/block-generator-v1.js';
import {
  SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
  createSettlementSemanticStableId,
} from '../src/infinite-world/settlement-semantic-identity.js';
import {
  EXPERIMENTAL_SETTLEMENT_STAGE_GENERATOR_REGISTRY,
  ROAD_GRAPH_CLASSES,
  ROAD_GRAPH_ISOLATED_FALLBACK,
  ROAD_GRAPH_V1_GENERATOR_ID,
  ROAD_GRAPH_V1_PROFILE_REVISION,
  ROAD_GRAPH_V1_SEGMENT_SCHEMA,
  createRoadGraphV1,
  validateRoadGraphV1,
  validateRoadGraphV1Segment,
} from '../src/infinite-world/road-graph-v1.js';
import {
  createRoadGraphV1SettlementTemplate,
  resolveRoadGraphV1ConnectivityGateways,
} from '../src/infinite-world/road-graph-v1-settlement-adapter.js';
import {
  createDistributedSettlementChunkGenerator,
  projectMigratedSettlementTemplate,
} from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { createMigratedSettlementTemplate } from '../src/infinite-world/single-rural-settlement.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import { createCanonicalMajorRoadNetwork } from '../src/infinite-world/canonical-major-road-network.js';
import {
  SETTLEMENT_ROAD_GATEWAY_HANDOFF_SCHEMA,
  validateSettlementRoadGatewayHandoff,
} from '../src/infinite-world/settlement-road-gateway-handoff.js';
import { parseSettlementRoadGraphGeneratorId } from '../src/infinite-world/sandbox-boot.js';
import { createChunkGeneratorInitializeRequest } from '../src/infinite-world/chunk-data-service-protocol.js';

const repoRoot = resolve(import.meta.dirname, '..');
const worldSeed = 'W5 distributed golden';
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
  const fixture = await fixturePromise;
  await fixture.generator.shutdown();
});

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

function fakeFormalChunk(chunkX, chunkZ) {
  return {
    chunkX,
    chunkZ,
    terrain: {
      resolution: { x: 2, z: 2 },
      heightUnitMeters: 1,
      heights: [0, 0, 0, 0],
    },
  };
}

test('road-graph-v1 and block-v1 are registered only as their experimental stages', () => {
  const descriptor = EXPERIMENTAL_SETTLEMENT_STAGE_GENERATOR_REGISTRY.get(
    'roadGraph',
    ROAD_GRAPH_V1_GENERATOR_ID,
  );
  assert.equal(descriptor.generatorId, 'road-graph-v1');
  assert.equal(descriptor.stage, 'roadGraph');
  assert.equal(descriptor.generate, createRoadGraphV1);
  const blockDescriptor = EXPERIMENTAL_SETTLEMENT_STAGE_GENERATOR_REGISTRY.get(
    'block',
    BLOCK_GENERATOR_V1_ID,
  );
  assert.equal(blockDescriptor.generatorId, BLOCK_GENERATOR_V1_ID);
  assert.equal(blockDescriptor.stage, 'block');
  assert.equal(blockDescriptor.generate, createRoadGraphV1Blocks);
  assert.equal(EXPERIMENTAL_SETTLEMENT_STAGE_GENERATOR_REGISTRY.get('block', 'road-graph-v1'), null);
});

test('Road Node and Edge Stable IDs exactly follow the semantic contracts', async () => {
  const { byType } = await fixturePromise;
  const input = await actualGraphInput(byType.CITY);
  const graph = await createRoadGraphV1(input);
  const node = graph.nodes[0];
  const expectedNode = await createSettlementSemanticStableId({
    schemaVersion: SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
    worldSeedHash: input.worldSeedHash,
    settlementId: input.settlement.settlementId,
    semanticKind: 'road-node',
    semanticLocalKey: canonicalizeJson({
      settlementSemanticId: input.settlement.settlementId,
      nodeRole: node.role,
      logicalPosition: node.position,
      purpose: node.purpose,
    }),
  });
  assert.equal(node.nodeId, expectedNode.stableId);
  const edge = graph.edges[0];
  const expectedEdge = await createSettlementSemanticStableId({
    schemaVersion: SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
    worldSeedHash: input.worldSeedHash,
    settlementId: input.settlement.settlementId,
    semanticKind: 'road-edge',
    semanticLocalKey: canonicalizeJson({
      endpointNodeIds: [edge.startNodeId, edge.endNodeId].sort(),
      roadClass: edge.class,
      edgePurpose: edge.purpose,
      profileRevision: ROAD_GRAPH_V1_PROFILE_REVISION,
    }),
  });
  assert.equal(edge.edgeId, expectedEdge.stableId);
});

test('CITY/TOWN/RURAL use actual connectivity gateways and expose the full hierarchy', async () => {
  const { byType } = await fixturePromise;
  for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
    const input = await actualGraphInput(byType[settlementType]);
    assert.ok(input.gateways.length > 0, `${settlementType} fixture requires actual gateways`);
    const connectivityEdgeIds = new Set(input.connectivityGraph.edges.map(edge => edge.stableId));
    assert.ok(input.gateways.every(gateway => connectivityEdgeIds.has(gateway.gatewayId)));
    const graph = await createRoadGraphV1(input);
    const classes = new Set(graph.segments.map(segment => segment.class));
    assert.deepEqual(classes, new Set(Object.values(ROAD_GRAPH_CLASSES)));
    assert.equal(graph.metadata.gatewayMode, 'CONNECTIVITY_GATEWAYS');
    assert.equal(graph.metadata.fictitiousGatewayCount, 0);
    assert.equal(graph.metadata.requiredGatewayIds.length, input.gateways.length);
    const validation = validateRoadGraphV1(graph);
    assert.equal(validation.valid, true, validation.errors.join('; '));
    assert.deepEqual({
      duplicateNodeCount: validation.duplicateNodeCount,
      duplicateEdgeCount: validation.duplicateEdgeCount,
      orphanEdgeCount: validation.orphanEdgeCount,
      selfLoopCount: validation.selfLoopCount,
      disconnectedRequiredGatewayCount: validation.disconnectedRequiredGatewayCount,
    }, {
      duplicateNodeCount: 0,
      duplicateEdgeCount: 0,
      orphanEdgeCount: 0,
      selfLoopCount: 0,
      disconnectedRequiredGatewayCount: 0,
    });
    const widths = Object.fromEntries(Object.values(ROAD_GRAPH_CLASSES).map(roadClass => [
      roadClass,
      graph.segments.find(segment => segment.class === roadClass).widthMeters,
    ]));
    assert.ok(widths.arterial > widths.collector);
    assert.ok(widths.collector > widths.local);
    assert.ok(widths.local > widths.alley);
    assert.equal(graph.nodes.some(node => node.position.x === graph.center.x
      && node.position.z === graph.center.z), false, 'Road Graph must not converge on the center point');
  }
});

test('isolated CITY/TOWN/RURAL fallback is deterministic and never restores fictitious three-spokes', async () => {
  const { generator, byType } = await fixturePromise;
  for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
    const candidate = byType[settlementType];
    const input = {
      worldSeedHash: generator.worldSeedHash,
      settlement: {
        settlementId: candidate.settlementId,
        settlementType,
        center: candidate.center,
        radiusMeters: candidate.radiusMeters,
        macroRegion: candidate.macroRegion,
      },
      gateways: [],
    };
    const [first, second] = await Promise.all([createRoadGraphV1(input), createRoadGraphV1(input)]);
    assert.deepEqual(second, first);
    assert.equal(first.metadata.gatewayMode, 'ISOLATED_FALLBACK');
    assert.equal(first.metadata.fallbackType, ROAD_GRAPH_ISOLATED_FALLBACK);
    assert.equal(first.metadata.fictitiousGatewayCount, 0);
    assert.equal(first.metadata.requiredGatewayIds.length, 0);
    assert.equal(first.segments.filter(segment => segment.class === ROAD_GRAPH_CLASSES.ARTERIAL).length, 0);
    assert.ok(first.segments.some(segment => segment.class === ROAD_GRAPH_CLASSES.COLLECTOR));
    assert.ok(first.segments.some(segment => segment.class === ROAD_GRAPH_CLASSES.LOCAL));
    assert.equal(validateRoadGraphV1(first).valid, true);

    const fallbackTemplate = await createRoadGraphV1SettlementTemplate({
      worldSeedHash: generator.worldSeedHash,
      candidate,
      connectivityGraph: {
        nodes: [{ stableId: candidate.settlementId, center: candidate.center }],
        edges: [],
      },
    });
    assert.equal(fallbackTemplate.roadSummary.gatewayMode, 'ISOLATED_FALLBACK');
    assert.equal(fallbackTemplate.roadSummary.fallbackType, ROAD_GRAPH_ISOLATED_FALLBACK);
    assert.ok(fallbackTemplate.buildings.length > 0);
    const fallbackRoadIds = new Set(fallbackTemplate.roads.map(road => road.stableId));
    assert.ok(fallbackTemplate.buildings.every(building => (
      fallbackRoadIds.has(building.frontageRoadId)
    )));
  }
});

test('same seed is invariant under repetition, gateway placement order, reverse Settlement order, and parallel generation', async () => {
  const { byType } = await fixturePromise;
  const inputs = await Promise.all(Object.values(SETTLEMENT_TYPES).map(async settlementType => (
    actualGraphInput(byType[settlementType])
  )));
  const first = [];
  for (const input of inputs) first.push(await createRoadGraphV1(input));
  const repeated = [];
  for (const input of inputs) repeated.push(await createRoadGraphV1(input));
  const gatewayReordered = await Promise.all(inputs.map(input => createRoadGraphV1({
    ...input,
    gateways: [...input.gateways].reverse(),
  })));
  const reverse = [];
  for (const input of [...inputs].reverse()) reverse.push(await createRoadGraphV1(input));
  reverse.reverse();
  const parallel = await Promise.all(inputs.map(createRoadGraphV1));
  assert.deepEqual(repeated, first);
  assert.deepEqual(gatewayReordered, first);
  assert.deepEqual(reverse, first);
  assert.deepEqual(parallel, first);
});

test('segment interface is complete, logical-only, and rejects malformed vectors', async () => {
  const { byType } = await fixturePromise;
  const graph = await createRoadGraphV1(await actualGraphInput(byType.TOWN));
  for (const segment of graph.segments) {
    assert.equal(segment.schemaVersion, ROAD_GRAPH_V1_SEGMENT_SCHEMA);
    assert.deepEqual(Object.keys(segment).sort(), [
      'class', 'edgeId', 'end', 'flags', 'normal', 'purpose', 'schemaVersion',
      'sourceOwner', 'stableId', 'start', 'tangent', 'widthMeters',
    ]);
    assert.equal(validateRoadGraphV1Segment(segment).valid, true);
    assert.equal(Object.hasOwn(segment.start, 'y'), false);
    assert.equal(Object.hasOwn(segment.end, 'y'), false);
  }
  assert.equal(graph.coordinateSpace, 'logical-world-meters');
  const invalid = { ...graph.segments[0], tangent: { x: 2, z: 0 } };
  assert.equal(validateRoadGraphV1Segment(invalid).valid, false);
  const source = readFileSync(resolve(repoRoot, 'src/infinite-world/road-graph-v1.js'), 'utf8');
  assert.doesNotMatch(source, /floating.?origin|renderOrigin|camera|THREE/i);
});

test('unchanged frontage/Building/Lot algorithm consumes the central adapter and changes placement only with topology', async () => {
  const { generator, byType } = await fixturePromise;
  const baselineSource = execFileSync('git', [
    'show',
    '1c94b9477434afc1ce9b5f8d4fe3ffaa9661a579:src/infinite-world/single-rural-settlement.js',
  ], { cwd: repoRoot, encoding: 'utf8' });
  const currentSource = readFileSync(
    resolve(repoRoot, 'src/infinite-world/single-rural-settlement.js'),
    'utf8',
  ).replace('export function buildDeterministicBuildings', 'function buildDeterministicBuildings');
  assert.equal(currentSource, baselineSource, 'Building/Lot algorithm source must remain byte-identical');

  for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
    const candidate = byType[settlementType];
    const input = await actualGraphInput(candidate);
    const experimental = await createRoadGraphV1SettlementTemplate({
      worldSeedHash: generator.worldSeedHash,
      candidate,
      connectivityGraph: input.connectivityGraph,
    });
    const legacy = await createMigratedSettlementTemplate({ candidate });
    assert.ok(experimental.buildings.length > 0);
    assert.equal(experimental.requestedBuildingCount, legacy.requestedBuildingCount);
    const roadIds = new Set(experimental.roads.map(road => road.stableId));
    assert.ok(experimental.buildings.every(building => roadIds.has(building.frontageRoadId)));
    assert.ok(experimental.buildings.every(building => (
      building.lot.lotStatus === 'ACTIVE'
      && [building.lot.path, building.lot.forecourt].every(rectangle => (
        [rectangle.centerX, rectangle.centerZ, rectangle.width, rectangle.depth].every(Number.isFinite)
      ))
    )));
    assert.notDeepEqual(
      experimental.buildings.map(building => [building.x, building.z, building.rotationY, building.frontageRoadId]),
      legacy.buildings.map(building => [building.x, building.z, building.rotationY, building.frontageRoadId]),
      `${settlementType} placement must differ because its Road Graph differs`,
    );
  }
});

test('experimental template projection is deterministic and continuous across Chunk seams', async () => {
  const { generator, byType } = await fixturePromise;
  const candidate = byType.CITY;
  const input = await actualGraphInput(candidate);
  const template = await createRoadGraphV1SettlementTemplate({
    worldSeedHash: generator.worldSeedHash,
    candidate,
    connectivityGraph: input.connectivityGraph,
  });
  const road = template.roads.find(value => (
    Math.floor(value.start.x / 16) !== Math.floor(value.end.x / 16)
    || Math.floor(value.start.z / 16) !== Math.floor(value.end.z / 16)
  ));
  assert.ok(road, 'fixture requires a cross-Chunk road');
  const minX = Math.floor(Math.min(road.start.x, road.end.x) / 16);
  const maxX = Math.floor(Math.max(road.start.x, road.end.x) / 16);
  const minZ = Math.floor(Math.min(road.start.z, road.end.z) / 16);
  const maxZ = Math.floor(Math.max(road.start.z, road.end.z) / 16);
  const projections = [];
  for (let z = minZ; z <= maxZ; z += 1) for (let x = minX; x <= maxX; x += 1) {
    const projection = projectMigratedSettlementTemplate(template, fakeFormalChunk(x, z));
    projections.push(...projection.features.filter(feature => feature.sourceStableId === road.stableId));
  }
  assert.ok(projections.length > 1);
  const endpointCounts = new Map();
  for (const projection of projections) for (const endpoint of [projection.start, projection.end]) {
    const key = `${endpoint.x},${endpoint.z}`;
    endpointCounts.set(key, (endpointCounts.get(key) ?? 0) + 1);
  }
  assert.ok([...endpointCounts.values()].some(count => count >= 2), 'adjacent projections must share an exact seam endpoint');
  assert.equal(new Set(projections.map(value => value.stableId)).size, projections.length);
  const repeated = [];
  for (let z = minZ; z <= maxZ; z += 1) for (let x = minX; x <= maxX; x += 1) {
    repeated.push(...projectMigratedSettlementTemplate(template, fakeFormalChunk(x, z)).features
      .filter(feature => feature.sourceStableId === road.stableId));
  }
  assert.deepEqual(repeated, projections);
});

test('explicit flag selects road-graph-v1 through W5/W8 while default legacy output stays exact', async () => {
  assert.equal(parseSettlementRoadGraphGeneratorId('road-graph-v1'), 'road-graph-v1');
  assert.equal(parseSettlementRoadGraphGeneratorId(null), null);
  assert.equal(parseSettlementRoadGraphGeneratorId('legacy-migrated-v1'), null);
  assert.throws(() => parseSettlementRoadGraphGeneratorId('unknown'), /unsupported/);
  assert.deepEqual(createChunkGeneratorInitializeRequest({
    serviceGeneration: 1,
    worldSeed,
    settlementRoadGraphGeneratorId: 'road-graph-v1',
  }), {
    type: 'chunk-generator:initialize',
    protocolVersion: 2,
    serviceGeneration: 1,
    worldSeed,
    settlementRoadGraphGeneratorId: 'road-graph-v1',
  });

  const defaultGenerator = await createDistributedSettlementChunkGenerator({ worldSeed });
  const defaultCandidate = await defaultGenerator.distributor.findHomeSettlement(0, 0);
  assert.deepEqual(
    await defaultGenerator.resolveSettlementTemplate({ candidate: defaultCandidate }),
    await createMigratedSettlementTemplate({ candidate: defaultCandidate }),
  );
  const defaultChunk = await defaultGenerator.generateChunk(24, 29);
  assert.equal(defaultChunk.contentHash, 'sha256:ce5975036825d64069bb51b7d05d0b0aa9fddf4519fa298d6d1e5197ed56b835');
  assert.equal(Object.hasOwn(defaultGenerator, 'settlementRoadGraphGeneratorId'), false);
  await defaultGenerator.shutdown();

  const experimental = await createDistributedSettlementChunkGenerator({
    worldSeed,
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V1_GENERATOR_ID,
  });
  const experimentalCandidate = await experimental.distributor.findHomeSettlement(0, 0);
  const experimentalTemplate = await experimental.resolveSettlementTemplate({
    candidate: experimentalCandidate,
  });
  assert.equal(experimental.settlementRoadGraphGeneratorId, ROAD_GRAPH_V1_GENERATOR_ID);
  assert.equal(experimentalTemplate.roadSummary.generatorId, ROAD_GRAPH_V1_GENERATOR_ID);
  await experimental.shutdown();
});

test('experimental W8 joins Road Graph arterials to canonical MAJOR Roads at gateway contracts', async () => {
  const generator = await createW8ParityChunkGenerator({
    worldSeed: 'KaniNingen Infinite Natural World',
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V1_GENERATOR_ID,
  });
  try {
    const query = {
      centerWorldX: 384,
      centerWorldZ: 384,
      radiusMeters: 1823.058008,
    };
    const [network, repeated, parallel] = await Promise.all([
      generator.resolveCanonicalMajorRoadNetwork(query),
      generator.resolveCanonicalMajorRoadNetwork(query),
      generator.resolveCanonicalMajorRoadNetwork(query),
    ]);
    assert.deepEqual(repeated, network);
    assert.deepEqual(parallel, network);
    assert.equal(network.graphEdgeCount, 16);
    assert.equal(network.roadCount, 16);
    assert.equal(network.roads.reduce((sum, road) => sum + road.segments.length, 0), 3084);
    assert.deepEqual(
      new Set(network.roads.map(road => road.connectivityEdgeId)),
      new Set(network.graph.edges.map(edge => edge.stableId)),
    );

    const undirectedSegmentKeys = new Set();
    const nodesById = new Map(network.graph.nodes.map(node => [node.stableId, node]));
    const gatewayConnections = network.roads.flatMap(road => road.gatewayConnections);
    assert.equal(gatewayConnections.filter(value => value.trimMode === 'DIRECT_GATEWAY').length, 22);
    assert.equal(gatewayConnections
      .filter(value => value.trimMode === 'SHARED_GATEWAY_TRUNK').length, 10);
    for (const road of network.roads) {
      assert.notEqual(road.settlementIds[0], road.settlementIds[1], 'self-loop');
      assert.equal(road.gatewayHandoffs.length, 2);
      assert.equal(road.gatewayConnections.length, 2);
      for (const handoff of road.gatewayHandoffs) {
        assert.equal(handoff.schemaVersion, SETTLEMENT_ROAD_GATEWAY_HANDOFF_SCHEMA);
        assert.equal(validateSettlementRoadGatewayHandoff(handoff).valid, true);
      }
      road.gatewayConnections.forEach((connection, endpointIndex) => {
        const handoff = road.gatewayHandoffs[endpointIndex];
        assert.equal(connection.gatewayStableId, handoff.gatewayStableId);
        if (connection.trimMode === 'DIRECT_GATEWAY') {
          assert.deepEqual(connection.majorConnectionPosition, handoff.logicalPosition);
          assert.deepEqual(road.terminals[endpointIndex], handoff.logicalPosition);
        } else {
          assert.equal(connection.trimMode, 'SHARED_GATEWAY_TRUNK');
          assert.notEqual(connection.sharedTrunkConnectivityEdgeId, road.connectivityEdgeId);
          assert.ok(connection.sharedTrunkConnectivityEdgeId);
        }
      });
      for (let index = 0; index < road.segments.length; index += 1) {
        const segment = road.segments[index];
        assert.notDeepEqual(segment.start, segment.end, 'zero-length segment');
        if (index > 0) assert.deepEqual(road.segments[index - 1].end, segment.start);
        const first = `${segment.start.x},${segment.start.z}`;
        const second = `${segment.end.x},${segment.end.z}`;
        const key = first < second ? `${first}|${second}` : `${second}|${first}`;
        assert.equal(undirectedSegmentKeys.has(key), false, `duplicate segment: ${key}`);
        undirectedSegmentKeys.add(key);
      }
    }

    const presentations = new Map();
    for (const node of network.graph.nodes) {
      presentations.set(node.stableId, await generator.resolveSettlementPresentationTemplate({
        candidate: {
          settlementId: node.stableId,
          settlementType: node.settlementType,
          townType: node.role,
          macroRegion: node.ownerRegion,
          center: node.center,
          radiusMeters: node.radiusMeters,
          urbanization: null,
          terrainSuitability: null,
        },
      }));
    }
    for (const road of network.roads) {
      road.gatewayHandoffs.forEach((handoff, endpointIndex) => {
        const arterial = presentations.get(handoff.settlementId).roads
          .find(candidate => candidate.stableId === handoff.arterialRoadStableId);
        assert.ok(arterial, 'gateway arterial exists');
        assert.equal(arterial.roadClass, 'arterial');
        assert.equal(arterial.flags.connectivityGateway, true);
        assert.ok([arterial.start, arterial.end].some(point => (
          point.x === handoff.logicalPosition.x && point.z === handoff.logicalPosition.z
        )), 'arterial reaches the gateway with gap 0');
        const first = `${arterial.start.x},${arterial.start.z}`;
        const second = `${arterial.end.x},${arterial.end.z}`;
        const arterialKey = first < second ? `${first}|${second}` : `${second}|${first}`;
        assert.equal(undirectedSegmentKeys.has(arterialKey), false, 'overlapping approach');
        assert.equal(nodesById.has(road.settlementIds[endpointIndex]), true);
      });
    }

    const sharedSources = new Map();
    for (const road of network.roads) {
      road.gatewayConnections.forEach((connection, endpointIndex) => {
        if (connection.trimMode !== 'SHARED_GATEWAY_TRUNK') return;
        sharedSources.set(
          `${road.settlementIds[endpointIndex]}:${connection.sharedTrunkConnectivityEdgeId}`,
          {
            node: nodesById.get(road.settlementIds[endpointIndex]),
            sourceEdgeId: connection.sharedTrunkConnectivityEdgeId,
          },
        );
      });
    }
    for (const { node, sourceEdgeId } of sharedSources.values()) {
      const localGraph = await generator.distributor.buildConnectivityGraphNear(
        node.center.x,
        node.center.z,
        node.radiusMeters,
      );
      assert.ok(localGraph.edges.some(edge => edge.stableId === sourceEdgeId), 'orphan road');
    }

    const allHandoffs = [...presentations.values()].flatMap(value => value.gatewayHandoffs);
    const resolveContractOnly = async () => ({
      obstacles: [],
      localRoads: [],
      gatewayHandoffs: allHandoffs,
    });
    const reversedGraph = Object.freeze({
      ...network.graph,
      nodes: Object.freeze([...network.graph.nodes].reverse()),
      edges: Object.freeze([...network.graph.edges].reverse()),
    });
    const [forwardContractNetwork, reverseContractNetwork, parallelContractNetwork] =
      await Promise.all([
        createCanonicalMajorRoadNetwork({
          worldSeedHash: generator.worldSeedHash,
          graph: network.graph,
          resolveObstacles: resolveContractOnly,
        }),
        createCanonicalMajorRoadNetwork({
          worldSeedHash: generator.worldSeedHash,
          graph: reversedGraph,
          resolveObstacles: resolveContractOnly,
        }),
        createCanonicalMajorRoadNetwork({
          worldSeedHash: generator.worldSeedHash,
          graph: network.graph,
          resolveObstacles: resolveContractOnly,
        }),
      ]);
    assert.deepEqual(reverseContractNetwork, forwardContractNetwork);
    assert.deepEqual(parallelContractNetwork, forwardContractNetwork);
  } finally {
    await generator.shutdown();
  }
});
