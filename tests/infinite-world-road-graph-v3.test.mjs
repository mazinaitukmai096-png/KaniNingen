import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { after } from 'node:test';

import { SETTLEMENT_TYPES } from '../src/settlement-type.js';
import { SETTLEMENT_ROAD_PARAMETERS } from '../src/settlement-road-parameters.js';
import { canonicalizeJson } from '../src/infinite-world/legacy-core/g0/canonical-json.js';
import {
  ROAD_GRAPH_V1_GENERATOR_ID,
  createRoadGraphV1,
} from '../src/infinite-world/road-graph-v1.js';
import { resolveRoadGraphV1ConnectivityGateways } from '../src/infinite-world/road-graph-v1-settlement-adapter.js';
import {
  ROAD_GRAPH_V2_GENERATOR_ID,
  createRoadGraphV2,
} from '../src/infinite-world/road-graph-v2.js';
import {
  ROAD_GRAPH_V3_EXPERIMENTAL_STAGE_GENERATOR_REGISTRY,
  ROAD_GRAPH_V3_GENERATOR_ID,
  ROAD_GRAPH_V3_PROFILE_REVISION,
  analyzeRoadGraphV3,
  createRoadGraphV3,
  validateRoadGraphV3,
} from '../src/infinite-world/road-graph-v3.js';
import { createRoadGraphV3SettlementTemplate } from '../src/infinite-world/road-graph-v3-settlement-adapter.js';
import {
  SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
  createSettlementSemanticStableId,
} from '../src/infinite-world/settlement-semantic-identity.js';
import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { createMigratedSettlementTemplate } from '../src/infinite-world/single-rural-settlement.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import { parseSettlementRoadGraphGeneratorId } from '../src/infinite-world/sandbox-boot.js';

const repoRoot = resolve(import.meta.dirname, '..');
const baselineHead = '7f92b63373ba395ef71deac790f8ced264ebfc4b';
const worldSeeds = Object.freeze([
  'W5 distributed golden',
  'road-v3-seed-b',
  'road-v3-seed-c',
]);
const fixturePromises = worldSeeds.map(async worldSeed => {
  const generator = await createDistributedSettlementChunkGenerator({ worldSeed });
  const candidates = await generator.distributor.findInMacroRange(-10, 10, -10, 10);
  const byType = Object.fromEntries(Object.values(SETTLEMENT_TYPES).map(settlementType => [
    settlementType,
    candidates.find(candidate => candidate.settlementType === settlementType),
  ]));
  assert.ok(Object.values(byType).every(Boolean));
  return { worldSeed, generator, byType };
});

after(async () => {
  for (const fixturePromise of fixturePromises) {
    const { generator } = await fixturePromise;
    await generator.shutdown();
  }
});

async function graphInput(fixture, settlementType) {
  const candidate = fixture.byType[settlementType];
  const connectivityGraph = await fixture.generator.distributor.buildConnectivityGraphNear(
    candidate.center.x,
    candidate.center.z,
    candidate.radiusMeters,
  );
  return {
    worldSeedHash: fixture.generator.worldSeedHash,
    settlement: {
      settlementId: candidate.settlementId,
      settlementType,
      center: candidate.center,
      radiusMeters: candidate.radiusMeters,
      macroRegion: candidate.macroRegion,
    },
    gateways: resolveRoadGraphV1ConnectivityGateways({ candidate, connectivityGraph }),
    connectivityGraph,
    candidate,
  };
}

function assertCleanValidation(validation) {
  assert.equal(validation.valid, true, validation.errors.join('; '));
  assert.deepEqual({
    duplicateNodeCount: validation.duplicateNodeCount,
    duplicateNodePositionCount: validation.duplicateNodePositionCount,
    duplicateEdgeCount: validation.duplicateEdgeCount,
    orphanEdgeCount: validation.orphanEdgeCount,
    orphanNodeCount: validation.orphanNodeCount,
    selfLoopCount: validation.selfLoopCount,
    selfIntersectionCount: validation.selfIntersectionCount,
    disconnectedNodeCount: validation.disconnectedNodeCount,
    disconnectedRequiredGatewayCount: validation.disconnectedRequiredGatewayCount,
  }, {
    duplicateNodeCount: 0,
    duplicateNodePositionCount: 0,
    duplicateEdgeCount: 0,
    orphanEdgeCount: 0,
    orphanNodeCount: 0,
    selfLoopCount: 0,
    selfIntersectionCount: 0,
    disconnectedNodeCount: 0,
    disconnectedRequiredGatewayCount: 0,
  });
}

function normalizedShapeSignature(graph) {
  const radius = graph.metadata.radiusMeters;
  const nodesById = new Map(graph.nodes.map(node => [node.nodeId, node]));
  const lengths = graph.edges.map(edge => {
    const start = nodesById.get(edge.startNodeId).position;
    const end = nodesById.get(edge.endNodeId).position;
    return Math.round(Math.hypot(end.x - start.x, end.z - start.z) / radius * 10000);
  }).sort((left, right) => left - right);
  const degree = new Map(graph.nodes.map(node => [node.nodeId, 0]));
  graph.edges.forEach(edge => {
    degree.set(edge.startNodeId, degree.get(edge.startNodeId) + 1);
    degree.set(edge.endNodeId, degree.get(edge.endNodeId) + 1);
  });
  return canonicalizeJson({
    lengths,
    degrees: [...degree.values()].sort((left, right) => left - right),
    cycleRank: analyzeRoadGraphV3(graph).cycleRank,
  });
}

test('v3 registers only a Road Graph stage and its settlement adapter stays road-only', async () => {
  assert.equal(
    ROAD_GRAPH_V3_EXPERIMENTAL_STAGE_GENERATOR_REGISTRY.get('roadGraph', ROAD_GRAPH_V3_GENERATOR_ID)?.generate,
    createRoadGraphV3,
  );
  assert.equal(ROAD_GRAPH_V3_EXPERIMENTAL_STAGE_GENERATOR_REGISTRY.get('block', 'block-v1'), null);
  const fixture = await fixturePromises[0];
  for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
    const input = await graphInput(fixture, settlementType);
    const template = await createRoadGraphV3SettlementTemplate({
      worldSeedHash: input.worldSeedHash,
      candidate: input.candidate,
      connectivityGraph: input.connectivityGraph,
    });
    assert.equal(template.roadSummary.generatorId, ROAD_GRAPH_V3_GENERATOR_ID);
    assert.equal(template.roadSummary.roadOnly, true);
    assert.equal(template.roadSummary.blockCount, 0);
    assert.ok(template.roads.length > 0);
    assert.deepEqual(template.blocks, []);
    assert.deepEqual(template.buildings, []);
    assert.equal(template.requestedBuildingCount, 0);
    assert.equal(template.buildingShortageCount, 0);
    assert.equal(template.gatewayHandoffs.length, input.gateways.length);
  }
});

test('three classes by three seeds satisfy common topology and class grammar metrics', async () => {
  const graphsByType = Object.fromEntries(Object.values(SETTLEMENT_TYPES).map(type => [type, []]));
  for (const fixturePromise of fixturePromises) {
    const fixture = await fixturePromise;
    for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
      const input = await graphInput(fixture, settlementType);
      const graph = await createRoadGraphV3(input);
      const metrics = analyzeRoadGraphV3(graph);
      graphsByType[settlementType].push(graph);
      assertCleanValidation(validateRoadGraphV3(graph));
      assert.equal(graph.metadata.planar, true);
      assert.equal(graph.metadata.roadOnly, true);
      assert.equal(graph.metadata.blockGeneratorConnected, false);
      assert.equal(graph.metadata.requiredGatewayNodeIds.length, input.gateways.length);
      assert.ok(metrics.junctionSpacingCoefficientOfVariation > 0);
      assert.ok(metrics.maximumStraightContinuationLength
        <= graph.metadata.straightContinuationLimitMeters + 1e-6);
      assert.ok(metrics.gatewayContinuityAngles.every(angle => angle < 25));
      assert.deepEqual(graph.metadata.profileUsage, {
        roadPattern: SETTLEMENT_ROAD_PARAMETERS[settlementType].roadPattern,
        localSpineCount: SETTLEMENT_ROAD_PARAMETERS[settlementType].localSpineCount,
        localBranchCount: SETTLEMENT_ROAD_PARAMETERS[settlementType].localBranchCount,
        junctionSpacingMultiplier: SETTLEMENT_ROAD_PARAMETERS[settlementType].junctionSpacingMultiplier,
        localCurvature: SETTLEMENT_ROAD_PARAMETERS[settlementType].localCurvature,
        gridBias: SETTLEMENT_ROAD_PARAMETERS[settlementType].gridBias,
        deadEndBias: SETTLEMENT_ROAD_PARAMETERS[settlementType].deadEndBias,
        densityMultiplier: SETTLEMENT_ROAD_PARAMETERS[settlementType].densityMultiplier,
        centerConnectionBias: SETTLEMENT_ROAD_PARAMETERS[settlementType].centerConnectionBias,
        outerRoadBias: SETTLEMENT_ROAD_PARAMETERS[settlementType].outerRoadBias,
        resolvedLocalGrowthCount: settlementType === SETTLEMENT_TYPES.RURAL ? 3
          : settlementType === SETTLEMENT_TYPES.TOWN ? 5 : 6,
        resolvedMajorRouteCount: graph.metadata.profileUsage.resolvedMajorRouteCount,
      });

      const bendNodeIds = new Set(graph.nodes.filter(node => node.role === 'bend').map(node => node.nodeId));
      const degree = new Map(graph.nodes.map(node => [node.nodeId, 0]));
      graph.edges.forEach(edge => {
        degree.set(edge.startNodeId, degree.get(edge.startNodeId) + 1);
        degree.set(edge.endNodeId, degree.get(edge.endNodeId) + 1);
      });
      assert.ok(bendNodeIds.size > 0);
      assert.ok([...bendNodeIds].every(nodeId => degree.get(nodeId) === 2));
      assert.equal(graph.edges.length, graph.segments.length);

      if (settlementType === SETTLEMENT_TYPES.RURAL) {
        assert.equal(new Set(graph.edges.filter(edge => edge.class === 'collector')
          .map(edge => edge.flags.routeId)).size, 1);
        assert.ok(metrics.exactRightAngleRate < 0.25);
        assert.ok(metrics.cycleRank >= 0 && metrics.cycleRank <= 1);
        const junctionDegrees = [...degree.values()].filter(value => value >= 3);
        assert.ok(junctionDegrees.filter(value => value === 3).length >= junctionDegrees.length * 0.75);
      } else if (settlementType === SETTLEMENT_TYPES.TOWN) {
        assert.equal(new Set(graph.edges.filter(edge => edge.class === 'collector')
          .map(edge => edge.flags.routeId)).size, 1);
        assert.ok(metrics.exactRightAngleRate < 0.5);
        assert.ok(metrics.cycleRank >= 1 && metrics.cycleRank <= 3);
        assert.ok(metrics.localDeadEndRatio >= graph.metadata.deadEndTargetRange.minimum);
        assert.ok(metrics.localDeadEndRatio <= graph.metadata.deadEndTargetRange.maximum);
        assert.ok(graph.edges.filter(edge => edge.flags.localGrowth)
          .every(edge => edge.flags.through === false));
      } else {
        const majorRoutes = new Set(graph.edges.filter(edge => edge.flags.hierarchy === 'major-route')
          .map(edge => edge.flags.routeId));
        assert.ok(majorRoutes.size >= 2 && majorRoutes.size <= 3);
        assert.ok(graph.edges.some(edge => edge.flags.crossConnection && edge.flags.incomplete));
        assert.ok(metrics.centerJunctionDensity > metrics.outerJunctionDensity);
        assert.ok(metrics.exactRightAngleRate < 0.5);
        assert.ok(metrics.cycleRank >= 2 && metrics.cycleRank <= 3);
      }
    }
  }
  assert.ok(new Set(graphsByType.CITY.map(graph => analyzeRoadGraphV3(graph).cycleRank)).size > 1,
    'CITY cycle rank must vary across seeds');
  for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
    assert.equal(new Set(graphsByType[settlementType].map(normalizedShapeSignature)).size, 3,
      `${settlementType} seeds must differ beyond rotation and scale`);
  }
});

test('semantic Stable IDs, gateway order, repetition, reverse order, and parallel execution are deterministic', async () => {
  const fixtures = await Promise.all(fixturePromises);
  const inputs = await Promise.all(fixtures.flatMap(fixture => Object.values(SETTLEMENT_TYPES)
    .map(settlementType => graphInput(fixture, settlementType))));
  const serial = [];
  for (const input of inputs) serial.push(await createRoadGraphV3(input));
  const repeat = [];
  for (const input of inputs) repeat.push(await createRoadGraphV3(input));
  assert.deepEqual(repeat, serial);
  const reversed = [];
  for (const input of [...inputs].reverse()) reversed.push(await createRoadGraphV3(input));
  reversed.reverse();
  assert.deepEqual(reversed, serial);
  assert.deepEqual(await Promise.all(inputs.map(input => createRoadGraphV3(input))), serial);
  assert.deepEqual(await Promise.all(inputs.map(input => createRoadGraphV3({
    ...input,
    gateways: [...input.gateways].reverse(),
  }))), serial);

  for (let index = 0; index < serial.length; index += 1) {
    const graph = serial[index];
    const input = inputs[index];
    for (const node of graph.nodes) {
      const identity = await createSettlementSemanticStableId({
        schemaVersion: SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
        worldSeedHash: input.worldSeedHash,
        settlementId: graph.settlementId,
        semanticKind: 'road-node',
        semanticLocalKey: canonicalizeJson({
          settlementSemanticId: graph.settlementId,
          nodeRole: node.role,
          logicalPosition: node.position,
          purpose: node.purpose,
        }),
      });
      assert.equal(node.nodeId, identity.stableId);
    }
    for (const edge of graph.edges) {
      const identity = await createSettlementSemanticStableId({
        schemaVersion: SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
        worldSeedHash: input.worldSeedHash,
        settlementId: graph.settlementId,
        semanticKind: 'road-edge',
        semanticLocalKey: canonicalizeJson({
          endpointNodeIds: [edge.startNodeId, edge.endNodeId].sort(),
          roadClass: edge.class,
          edgePurpose: edge.purpose,
          profileRevision: ROAD_GRAPH_V3_PROFILE_REVISION,
        }),
      });
      assert.equal(edge.edgeId, identity.stableId);
    }
    const reordered = Object.freeze({
      ...graph,
      nodes: Object.freeze([...graph.nodes].reverse()),
      edges: Object.freeze([...graph.edges].reverse()),
      segments: Object.freeze([...graph.segments].reverse()),
    });
    assertCleanValidation(validateRoadGraphV3(reordered));
  }
});

test('explicit v3 flag works while v1, v2, legacy, and production default remain unchanged', async () => {
  assert.equal(parseSettlementRoadGraphGeneratorId('road-graph-v3'), ROAD_GRAPH_V3_GENERATOR_ID);
  assert.equal(parseSettlementRoadGraphGeneratorId('road-graph-v2'), ROAD_GRAPH_V2_GENERATOR_ID);
  assert.equal(parseSettlementRoadGraphGeneratorId('road-graph-v1'), ROAD_GRAPH_V1_GENERATOR_ID);
  assert.equal(parseSettlementRoadGraphGeneratorId(null), null);

  const defaultGenerator = await createDistributedSettlementChunkGenerator({ worldSeed: worldSeeds[0] });
  const defaultCandidate = await defaultGenerator.distributor.findHomeSettlement(0, 0);
  assert.deepEqual(
    await defaultGenerator.resolveSettlementTemplate({ candidate: defaultCandidate }),
    await createMigratedSettlementTemplate({ candidate: defaultCandidate }),
  );
  assert.equal(Object.hasOwn(defaultGenerator, 'settlementRoadGraphGeneratorId'), false);
  await defaultGenerator.shutdown();

  const fixture = await fixturePromises[0];
  const input = await graphInput(fixture, SETTLEMENT_TYPES.TOWN);
  assert.equal((await createRoadGraphV1(input)).generatorId, ROAD_GRAPH_V1_GENERATOR_ID);
  assert.equal((await createRoadGraphV2(input)).generatorId, ROAD_GRAPH_V2_GENERATOR_ID);

  const v3Generator = await createDistributedSettlementChunkGenerator({
    worldSeed: worldSeeds[0],
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V3_GENERATOR_ID,
  });
  const candidate = await v3Generator.distributor.findHomeSettlement(0, 0);
  const template = await v3Generator.resolveSettlementTemplate({ candidate });
  assert.equal(v3Generator.settlementRoadGraphGeneratorId, ROAD_GRAPH_V3_GENERATOR_ID);
  assert.equal(template.roadSummary.generatorId, ROAD_GRAPH_V3_GENERATOR_ID);
  assert.deepEqual(template.blocks, []);
  assert.deepEqual(template.buildings, []);
  await v3Generator.shutdown();

  const w8 = await createW8ParityChunkGenerator({
    worldSeed: 'KaniNingen Infinite Natural World',
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V3_GENERATOR_ID,
  });
  assert.equal(w8.settlementRoadGraphGeneratorId, ROAD_GRAPH_V3_GENERATOR_ID);
  await w8.shutdown();
});

test('forbidden generators and production algorithms remain byte-identical to the baseline HEAD', () => {
  const unchangedPaths = [
    'src/infinite-world/road-graph-v1.js',
    'src/infinite-world/road-graph-v1-settlement-adapter.js',
    'src/infinite-world/road-graph-v2.js',
    'src/infinite-world/road-graph-v2-settlement-adapter.js',
    'src/infinite-world/block-generator-v1.js',
    'src/infinite-world/legacy-migrated-settlement-adapter.js',
    'src/infinite-world/single-rural-settlement.js',
    'src/building-lot.js',
    'src/road-town-structure.js',
  ];
  for (const path of unchangedPaths) {
    const current = readFileSync(resolve(repoRoot, path), 'utf8');
    const baseline = execFileSync('git', ['show', `${baselineHead}:${path}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(current, baseline, `${path} must remain byte-identical`);
  }
});
