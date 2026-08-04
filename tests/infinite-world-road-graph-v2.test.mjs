import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { after } from 'node:test';

import { SETTLEMENT_TYPES } from '../src/settlement-type.js';
import { canonicalizeJson } from '../src/infinite-world/legacy-core/g0/canonical-json.js';
import { normalizeBoundaryEdgeCycle } from '../src/infinite-world/block-generator-v1.js';
import {
  SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
  createSettlementSemanticStableId,
} from '../src/infinite-world/settlement-semantic-identity.js';
import {
  ROAD_GRAPH_V1_PROFILE_REVISION,
  createRoadGraphV1,
} from '../src/infinite-world/road-graph-v1.js';
import { resolveRoadGraphV1ConnectivityGateways } from '../src/infinite-world/road-graph-v1-settlement-adapter.js';
import {
  ROAD_GRAPH_V2_EXPERIMENTAL_STAGE_GENERATOR_REGISTRY,
  ROAD_GRAPH_V2_GENERATOR_ID,
  ROAD_GRAPH_V2_ISOLATED_FALLBACK,
  ROAD_GRAPH_V2_PROFILE_REVISION,
  createRoadGraphV2,
  createRoadGraphV2Blocks,
  validateRoadGraphV2,
} from '../src/infinite-world/road-graph-v2.js';
import { createRoadGraphV2SettlementTemplate } from '../src/infinite-world/road-graph-v2-settlement-adapter.js';
import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { createMigratedSettlementTemplate } from '../src/infinite-world/single-rural-settlement.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import { parseSettlementRoadGraphGeneratorId } from '../src/infinite-world/sandbox-boot.js';

const repoRoot = resolve(import.meta.dirname, '..');
const worldSeed = 'W5 distributed golden';
const expectedBlockCounts = Object.freeze({ CITY: 3, TOWN: 2, RURAL: 1 });
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

async function actualGraphInput(candidate, { isolated = false } = {}) {
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
    gateways: isolated ? [] : resolveRoadGraphV1ConnectivityGateways({ candidate, connectivityGraph }),
    connectivityGraph,
  };
}

function assertCleanGraphValidation(validation) {
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

test('road-graph-v2 and unchanged block-v1 are connected through experimental stage contracts', () => {
  const roadDescriptor = ROAD_GRAPH_V2_EXPERIMENTAL_STAGE_GENERATOR_REGISTRY.get(
    'roadGraph',
    ROAD_GRAPH_V2_GENERATOR_ID,
  );
  const blockDescriptor = ROAD_GRAPH_V2_EXPERIMENTAL_STAGE_GENERATOR_REGISTRY.get('block', 'block-v1');
  assert.equal(roadDescriptor?.generate, createRoadGraphV2);
  assert.equal(blockDescriptor?.generate, createRoadGraphV2Blocks);
  const blockSource = readFileSync(resolve(repoRoot, 'src/infinite-world/block-generator-v1.js'), 'utf8');
  const baselineBlockSource = execFileSync('git', [
    'show',
    'a455a4d2cacfba6c87268fbcd8ea37fc8210eff7:src/infinite-world/block-generator-v1.js',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(blockSource, baselineBlockSource, 'Block generator must remain byte-identical');
});

test('actual CITY/TOWN/RURAL graphs are planar connected hierarchies with bounded Blocks', async () => {
  const { byType } = await fixturePromise;
  for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
    const input = await actualGraphInput(byType[settlementType]);
    const graph = await createRoadGraphV2(input);
    const blocks = await createRoadGraphV2Blocks({ worldSeedHash: input.worldSeedHash, roadGraph: graph });
    assert.equal(graph.generatorId, ROAD_GRAPH_V2_GENERATOR_ID);
    assert.equal(graph.metadata.planar, true);
    assert.equal(graph.metadata.blockCandidateCount, expectedBlockCounts[settlementType]);
    assert.equal(blocks.length, expectedBlockCounts[settlementType]);
    assertCleanGraphValidation(validateRoadGraphV2(graph));
    assert.deepEqual(
      new Set(graph.edges.map(edge => edge.class)),
      new Set(['arterial', 'collector', 'local', 'alley']),
    );
    assert.equal(graph.edges.filter(edge => edge.class === 'local').length, blocks.length + 1);
    assert.ok(graph.edges.filter(edge => edge.class === 'local')
      .every(edge => edge.flags.blockBoundary === true));
    assert.ok(blocks.every(block => block.isClosed && block.boundaryEdgeIds.length >= 4));
  }
});

test('isolated CITY/TOWN/RURAL fallback still creates a Block without fictitious arterials', async () => {
  const { byType } = await fixturePromise;
  for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
    const input = await actualGraphInput(byType[settlementType], { isolated: true });
    const graph = await createRoadGraphV2(input);
    const blocks = await createRoadGraphV2Blocks({ worldSeedHash: input.worldSeedHash, roadGraph: graph });
    assert.equal(graph.metadata.gatewayMode, 'ISOLATED_FALLBACK');
    assert.equal(graph.metadata.fallbackType, ROAD_GRAPH_V2_ISOLATED_FALLBACK);
    assert.equal(graph.metadata.fictitiousGatewayCount, 0);
    assert.equal(graph.edges.some(edge => edge.class === 'arterial'), false);
    assert.equal(blocks.length, expectedBlockCounts[settlementType]);
    assertCleanGraphValidation(validateRoadGraphV2(graph));
  }
});

test('Road Node, Edge, and Block Stable IDs retain semantic contracts', async () => {
  const { byType } = await fixturePromise;
  const input = await actualGraphInput(byType.CITY);
  const graph = await createRoadGraphV2(input);
  const node = graph.nodes[0];
  const expectedNode = await createSettlementSemanticStableId({
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
  assert.equal(node.nodeId, expectedNode.stableId);
  const edge = graph.edges[0];
  const expectedEdge = await createSettlementSemanticStableId({
    schemaVersion: SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
    worldSeedHash: input.worldSeedHash,
    settlementId: graph.settlementId,
    semanticKind: 'road-edge',
    semanticLocalKey: canonicalizeJson({
      endpointNodeIds: [edge.startNodeId, edge.endNodeId].sort(),
      roadClass: edge.class,
      edgePurpose: edge.purpose,
      profileRevision: ROAD_GRAPH_V2_PROFILE_REVISION,
    }),
  });
  assert.equal(edge.edgeId, expectedEdge.stableId);
  for (const block of await createRoadGraphV2Blocks({ worldSeedHash: input.worldSeedHash, roadGraph: graph })) {
    const expectedBlock = await createSettlementSemanticStableId({
      schemaVersion: SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
      worldSeedHash: input.worldSeedHash,
      settlementId: graph.settlementId,
      semanticKind: 'block',
      semanticLocalKey: canonicalizeJson(normalizeBoundaryEdgeCycle(block.boundaryEdgeIds)),
    });
    assert.equal(block.id, expectedBlock.stableId);
  }
});

test('repetition, reverse order, parallelism, and edge/node enumeration preserve graphs and Blocks', async () => {
  const { byType } = await fixturePromise;
  const inputs = await Promise.all(Object.values(SETTLEMENT_TYPES).map(type => actualGraphInput(byType[type])));
  const first = [];
  for (const input of inputs) first.push(await createRoadGraphV2(input));
  const repeated = [];
  for (const input of inputs) repeated.push(await createRoadGraphV2(input));
  const gatewayReordered = await Promise.all(inputs.map(input => createRoadGraphV2({
    ...input,
    gateways: [...input.gateways].reverse(),
  })));
  const reversed = [];
  for (const input of [...inputs].reverse()) reversed.push(await createRoadGraphV2(input));
  reversed.reverse();
  const parallel = await Promise.all(inputs.map(input => createRoadGraphV2(input)));
  assert.deepEqual(repeated, first);
  assert.deepEqual(gatewayReordered, first);
  assert.deepEqual(reversed, first);
  assert.deepEqual(parallel, first);

  for (let index = 0; index < first.length; index += 1) {
    const graph = first[index];
    const baselineBlocks = await createRoadGraphV2Blocks({
      worldSeedHash: inputs[index].worldSeedHash,
      roadGraph: graph,
    });
    const reorderedGraph = Object.freeze({
      ...graph,
      nodes: Object.freeze([...graph.nodes].reverse()),
      edges: Object.freeze([...graph.edges].reverse()),
      segments: Object.freeze([...graph.segments].reverse()),
    });
    const [reorderedBlocks, parallelBlocks] = await Promise.all([
      createRoadGraphV2Blocks({ worldSeedHash: inputs[index].worldSeedHash, roadGraph: reorderedGraph }),
      createRoadGraphV2Blocks({ worldSeedHash: inputs[index].worldSeedHash, roadGraph: graph }),
    ]);
    assert.deepEqual(reorderedBlocks, baselineBlocks);
    assert.deepEqual(parallelBlocks, baselineBlocks);
    assert.deepEqual(
      [...reorderedGraph.nodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
      graph.nodes,
    );
    assert.deepEqual(
      [...reorderedGraph.edges].sort((left, right) => left.edgeId.localeCompare(right.edgeId)),
      graph.edges,
    );
  }
});

test('v2 template keeps the Building algorithm and publishes Blocks for every Settlement class', async () => {
  const { generator, byType } = await fixturePromise;
  const buildingSource = readFileSync(resolve(repoRoot, 'src/infinite-world/single-rural-settlement.js'), 'utf8');
  const baselineBuildingSource = execFileSync('git', [
    'show',
    'a455a4d2cacfba6c87268fbcd8ea37fc8210eff7:src/infinite-world/single-rural-settlement.js',
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(buildingSource, baselineBuildingSource, 'Building/Lot algorithm must remain byte-identical');
  for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
    const candidate = byType[settlementType];
    const input = await actualGraphInput(candidate);
    const template = await createRoadGraphV2SettlementTemplate({
      worldSeedHash: generator.worldSeedHash,
      candidate,
      connectivityGraph: input.connectivityGraph,
    });
    assert.equal(template.roadSummary.generatorId, ROAD_GRAPH_V2_GENERATOR_ID);
    assert.equal(template.roadSummary.blockCount, expectedBlockCounts[settlementType]);
    assert.equal(template.blocks.length, expectedBlockCounts[settlementType]);
    assert.ok(template.buildings.length > 0);
    const roadIds = new Set(template.roads.map(road => road.stableId));
    assert.ok(template.buildings.every(building => roadIds.has(building.frontageRoadId)));
  }
});

test('road-graph-v2 is explicit while v1 and the production default remain unchanged', async () => {
  assert.equal(parseSettlementRoadGraphGeneratorId('road-graph-v2'), ROAD_GRAPH_V2_GENERATOR_ID);
  const defaultGenerator = await createDistributedSettlementChunkGenerator({ worldSeed });
  const defaultCandidate = await defaultGenerator.distributor.findHomeSettlement(0, 0);
  assert.deepEqual(
    await defaultGenerator.resolveSettlementTemplate({ candidate: defaultCandidate }),
    await createMigratedSettlementTemplate({ candidate: defaultCandidate }),
  );
  assert.equal(Object.hasOwn(defaultGenerator, 'settlementRoadGraphGeneratorId'), false);
  await defaultGenerator.shutdown();

  const v2Generator = await createDistributedSettlementChunkGenerator({
    worldSeed,
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V2_GENERATOR_ID,
  });
  const candidate = await v2Generator.distributor.findHomeSettlement(0, 0);
  const template = await v2Generator.resolveSettlementTemplate({ candidate });
  assert.equal(v2Generator.settlementRoadGraphGeneratorId, ROAD_GRAPH_V2_GENERATOR_ID);
  assert.equal(template.roadSummary.generatorId, ROAD_GRAPH_V2_GENERATOR_ID);
  assert.ok(template.blocks.length >= 1);
  await v2Generator.shutdown();

  const input = await actualGraphInput((await fixturePromise).byType.TOWN);
  const v1 = await createRoadGraphV1(input);
  assert.equal(v1.profileRevision, ROAD_GRAPH_V1_PROFILE_REVISION);
  assert.equal(v1.generatorId, 'road-graph-v1');

  const w8 = await createW8ParityChunkGenerator({
    worldSeed: 'KaniNingen Infinite Natural World',
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V2_GENERATOR_ID,
  });
  assert.equal(w8.settlementRoadGraphGeneratorId, ROAD_GRAPH_V2_GENERATOR_ID);
  await w8.shutdown();
});
