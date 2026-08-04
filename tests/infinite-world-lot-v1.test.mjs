import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { after } from 'node:test';

import { orientedRectanglesOverlap } from '../src/building-lot.js';
import { SETTLEMENT_TYPES } from '../src/settlement-type.js';
import { createChunkGeneratorInitializeRequest } from '../src/infinite-world/chunk-data-service-protocol.js';
import { logicalWorldToOwnedChunk } from '../src/infinite-world/chunk-coordinates.js';
import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import {
  adaptSettlementLotsToBuildingDescriptors,
  buildDeterministicBuildingsFromLots,
  createLotBuildingPlacementInput,
} from '../src/infinite-world/lot-building-adapter-v1.js';
import { canonicalizeJson } from '../src/infinite-world/legacy-core/g0/canonical-json.js';
import { ROAD_GRAPH_V3_GENERATOR_ID } from '../src/infinite-world/road-graph-v3.js';
import { createRoadGraphV3SettlementTemplate } from '../src/infinite-world/road-graph-v3-settlement-adapter.js';
import {
  SETTLEMENT_LOT_V1_GENERATOR_ID,
  createRoadGraphV3Blocks,
  createSettlementLotsV1,
  deriveSettlementBlockPolygon,
  pointInSettlementPolygon,
  validateSettlementLotsV1,
} from '../src/infinite-world/settlement-lot-v1.js';
import { parseSettlementLotMode } from '../src/infinite-world/sandbox-boot.js';
import { MIGRATED_SETTLEMENT_PROFILES } from '../src/infinite-world/single-rural-settlement.js';
import {
  SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
  createSettlementSemanticStableId,
} from '../src/infinite-world/settlement-semantic-identity.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';

const repoRoot = resolve(import.meta.dirname, '..');
const baselineHead = '43b3f8d57c941bdb7e91937e1ad73fb435a56639';
const worldSeeds = Object.freeze([
  'W5 distributed golden',
  'road-v3-seed-b',
  'road-v3-seed-c',
]);
const q6 = value => Number(value.toFixed(6));

const fixturePromises = worldSeeds.map(async worldSeed => {
  const generator = await createDistributedSettlementChunkGenerator({
    worldSeed,
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V3_GENERATOR_ID,
    settlementLotMode: SETTLEMENT_LOT_V1_GENERATOR_ID,
  });
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
    const fixture = await fixturePromise;
    await fixture.generator.shutdown();
  }
});

async function templateInput(fixture, settlementType) {
  const candidate = fixture.byType[settlementType];
  return {
    worldSeedHash: fixture.generator.worldSeedHash,
    candidate,
    connectivityGraph: await fixture.generator.distributor.buildConnectivityGraphNear(
      candidate.center.x,
      candidate.center.z,
      candidate.radiusMeters,
    ),
    settlementLotMode: SETTLEMENT_LOT_V1_GENERATOR_ID,
  };
}

function localTown(candidate) {
  const profile = MIGRATED_SETTLEMENT_PROFILES[candidate.townType];
  return Object.freeze({
    id: candidate.settlementId,
    x: 0,
    z: 0,
    radius: profile.radius,
    coreRadius: profile.coreRadius,
    type: candidate.townType,
    settlementType: candidate.settlementType,
  });
}

function buildingRectangle(building) {
  return {
    centerX: building.lot.centerX,
    centerZ: building.lot.centerZ,
    rotationY: building.rotationY,
    width: building.lot.widthMeters,
    depth: building.lot.depthMeters,
  };
}

test('lot-v1 is accepted only with road-graph-v3 and is carried by Worker initialization', async () => {
  assert.equal(parseSettlementLotMode(null), null);
  assert.equal(parseSettlementLotMode('lot-v1'), SETTLEMENT_LOT_V1_GENERATOR_ID);
  assert.throws(() => parseSettlementLotMode('lot-v2'), /unsupported experimental Settlement Lot/);
  assert.deepEqual(createChunkGeneratorInitializeRequest({
    serviceGeneration: 1,
    worldSeed: 'lot protocol',
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V3_GENERATOR_ID,
    settlementLotMode: SETTLEMENT_LOT_V1_GENERATOR_ID,
  }), {
    type: 'chunk-generator:initialize',
    protocolVersion: 2,
    serviceGeneration: 1,
    worldSeed: 'lot protocol',
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V3_GENERATOR_ID,
    settlementLotMode: SETTLEMENT_LOT_V1_GENERATOR_ID,
  });
  await assert.rejects(createDistributedSettlementChunkGenerator({
    worldSeed: 'invalid lot combination',
    settlementLotMode: SETTLEMENT_LOT_V1_GENERATOR_ID,
  }), /lot-v1 requires/);
});

test('CITY/TOWN/RURAL across three seeds satisfy Lot, Building, ownership, and fallback validation', async () => {
  const metricRows = [];
  for (const fixturePromise of fixturePromises) {
    const fixture = await fixturePromise;
    for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
      const candidate = fixture.byType[settlementType];
      const template = await fixture.generator.resolveSettlementTemplate({ candidate });
      assert.equal(template.settlementLotMode, SETTLEMENT_LOT_V1_GENERATOR_ID);
      assert.equal(template.roadSummary.generatorId, ROAD_GRAPH_V3_GENERATOR_ID);
      assert.equal(template.roadSummary.roadOnly, false);
      assert.equal(template.lotSummary.lotValidation.valid, true);
      assert.equal(template.lotSummary.buildingValidation.valid, true);
      const validation = await validateSettlementLotsV1({
        worldSeedHash: fixture.generator.worldSeedHash,
        roadGraph: template.roadGraph,
        blocks: template.blocks,
        lots: template.lots,
      });
      assert.equal(validation.valid, true, validation.errors.join('; '));
      assert.deepEqual({
        duplicateLotIdCount: validation.duplicateLotIdCount,
        orphanLotCount: validation.orphanLotCount,
        invalidFrontageCount: validation.invalidFrontageCount,
        outsideBlockCount: validation.outsideBlockCount,
        selfIntersectionCount: validation.selfIntersectionCount,
        overlapCount: validation.overlapCount,
        authorityMismatchCount: validation.authorityMismatchCount,
      }, {
        duplicateLotIdCount: 0,
        orphanLotCount: 0,
        invalidFrontageCount: 0,
        outsideBlockCount: 0,
        selfIntersectionCount: 0,
        overlapCount: 0,
        authorityMismatchCount: 0,
      });
      const blocksById = new Map(template.blocks.map(block => [block.id, block]));
      const lotsById = new Map(template.lots.map(lot => [lot.id, lot]));
      for (const lot of template.lots) {
        assert.deepEqual(Object.keys(lot), [
          'id', 'blockId', 'frontageEdgeId', 'frontageInterval', 'depth', 'footprint',
          'isCorner', 'isFallback', 'sourceRoadGraphVersion', 'sourceBlockVersion', 'owner',
        ]);
        const block = blocksById.get(lot.blockId);
        assert.ok(block);
        assert.ok(block.boundaryEdgeIds.includes(lot.frontageEdgeId));
        assert.ok(lot.frontageInterval[0] >= 0 && lot.frontageInterval[1] <= 1);
        assert.ok(lot.frontageInterval[1] > lot.frontageInterval[0]);
        assert.equal(lot.isCorner, false);
        assert.equal(lot.isFallback, false);
        const expected = await createSettlementSemanticStableId({
          schemaVersion: SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
          worldSeedHash: fixture.generator.worldSeedHash,
          settlementId: template.settlementId,
          semanticKind: 'lot',
          semanticLocalKey: canonicalizeJson({
            blockId: lot.blockId,
            frontageEdgeId: lot.frontageEdgeId,
            frontageInterval: lot.frontageInterval,
            lotGeneratorVersion: SETTLEMENT_LOT_V1_GENERATOR_ID,
          }),
        });
        assert.equal(lot.id, expected.stableId);
      }
      const lotBuildings = template.buildings.filter(building => building.sourceLotId);
      assert.equal(new Set(lotBuildings.map(building => building.sourceLotId)).size,
        lotBuildings.length);
      for (const building of lotBuildings) {
        const lot = lotsById.get(building.sourceLotId);
        assert.ok(lot);
        assert.equal(building.blockId, lot.blockId);
        assert.deepEqual(building.owner, lot.owner);
        assert.equal(building.lot.lotId, lot.id);
        assert.equal(building.lot.parentBuildingId, building.stableId);
        assert.equal(building.lot.path.parentLotId, lot.id);
        assert.equal(building.lot.forecourt.parentLotId, lot.id);
        const frontX = Math.sin(building.rotationY);
        const frontZ = Math.cos(building.rotationY);
        assert.ok((building.lot.roadAccessX - building.x) * frontX
          + (building.lot.roadAccessZ - building.z) * frontZ > 0);
      }
      for (let first = 0; first < template.buildings.length; first += 1) {
        for (let second = first + 1; second < template.buildings.length; second += 1) {
          assert.equal(orientedRectanglesOverlap(
            buildingRectangle(template.buildings[first]),
            buildingRectangle(template.buildings[second]),
          ), false, `Building double placement: ${template.buildings[first].stableId}`);
        }
      }
      const lotBlockIds = new Set(template.lotSummary.blockResults
        .filter(result => result.mode === 'LOT').map(result => result.blockId));
      const lotCoverage = template.blocks.filter(block => lotBlockIds.has(block.id))
        .map(block => deriveSettlementBlockPolygon({ roadGraph: template.roadGraph, block }));
      for (const building of template.buildings.filter(value => !value.sourceLotId)) {
        assert.equal(lotCoverage.some(polygon => pointInSettlementPolygon({
          x: building.x,
          z: building.z,
        }, polygon)), false);
      }
      metricRows.push(Object.freeze({
        seed: fixture.worldSeed,
        settlementType,
        blockCount: template.blocks.length,
        lotCount: template.lots.length,
        lotUtilization: template.lotSummary.lotUtilization,
        scatterFallbackCount: template.lotSummary.scatterFallbackBuildingCount,
        buildingCount: template.buildings.length,
        emptyLotCount: template.lotSummary.emptyLotCount,
        frontageFailureCount: template.lotSummary.frontageFailureCount,
        duplicateOrphanOverlapCount: validation.duplicateLotIdCount
          + validation.orphanLotCount + validation.overlapCount,
      }));
    }
  }
  assert.equal(metricRows.length, 9);
  assert.ok(metricRows.some(row => row.lotCount > 0));
  assert.ok(metricRows.every(row => row.buildingCount > 0));
  assert.ok(metricRows.every(row => row.duplicateOrphanOverlapCount === 0));
});

test('Lot and Building results ignore settlement, Block, edge, repetition, and parallel order', async () => {
  const fixtures = await Promise.all(fixturePromises);
  const inputs = await Promise.all(fixtures.flatMap(fixture => Object.values(SETTLEMENT_TYPES)
    .map(settlementType => templateInput(fixture, settlementType))));
  const serial = [];
  for (const input of inputs) serial.push(await createRoadGraphV3SettlementTemplate(input));
  const repeat = [];
  for (const input of inputs) repeat.push(await createRoadGraphV3SettlementTemplate(input));
  assert.deepEqual(repeat, serial);
  const reverseSettlementOrder = [];
  for (const input of [...inputs].reverse()) {
    reverseSettlementOrder.push(await createRoadGraphV3SettlementTemplate(input));
  }
  reverseSettlementOrder.reverse();
  assert.deepEqual(reverseSettlementOrder, serial);
  assert.deepEqual(await Promise.all(inputs.map(createRoadGraphV3SettlementTemplate)), serial);

  for (let index = 0; index < serial.length; index += 1) {
    const template = serial[index];
    const input = inputs[index];
    const reversedGraph = Object.freeze({
      ...template.roadGraph,
      nodes: Object.freeze([...template.roadGraph.nodes].reverse()),
      edges: Object.freeze([...template.roadGraph.edges].reverse()),
      segments: Object.freeze([...template.roadGraph.segments].reverse()),
    });
    const blocks = await createRoadGraphV3Blocks({
      worldSeedHash: input.worldSeedHash,
      roadGraph: reversedGraph,
    });
    const lotResult = await createSettlementLotsV1({
      worldSeedHash: input.worldSeedHash,
      roadGraph: reversedGraph,
      blocks: Object.freeze([...blocks].reverse()),
    });
    assert.deepEqual(lotResult.lots, template.lots);
    assert.deepEqual(lotResult.blockResults, template.lotSummary.blockResults);
    const direct = await buildDeterministicBuildingsFromLots({
      town: localTown(input.candidate),
      settlementId: input.candidate.settlementId,
      roadGraph: reversedGraph,
      candidate: input.candidate,
      lots: Object.freeze([...lotResult.lots].reverse()),
    });
    const expectedLotBuildings = template.buildings.filter(building => building.sourceLotId)
      .map(building => ({
        stableId: building.stableId,
        sourceLotId: building.sourceLotId,
        x: q6(building.x - input.candidate.center.x),
        z: q6(building.z - input.candidate.center.z),
        rotationY: building.rotationY,
      })).sort((left, right) => left.stableId.localeCompare(right.stableId));
    assert.deepEqual(direct.buildings.map(building => ({
      stableId: building.stableId,
      sourceLotId: building.sourceLotId,
      x: building.x,
      z: building.z,
      rotationY: building.rotationY,
    })), expectedLotBuildings);
  }
});

test('Lot adapter supplies the complete placement input and failed fits remain empty Lots', async () => {
  const fixtures = await Promise.all(fixturePromises);
  const fixture = fixtures[0];
  const input = await templateInput(fixture, SETTLEMENT_TYPES.TOWN);
  const template = await createRoadGraphV3SettlementTemplate(input);
  assert.ok(template.lots.length > 0);
  const [descriptor] = adaptSettlementLotsToBuildingDescriptors({
    lots: template.lots,
    roadGraph: template.roadGraph,
    candidate: input.candidate,
  });
  const placement = createLotBuildingPlacementInput({
    descriptor,
    town: localTown(input.candidate),
    settlementId: input.candidate.settlementId,
    buildingType: 'house',
    buildingIndex: 1,
  });
  assert.deepEqual(Object.keys(placement), [
    'adapterVersion', 'lotId', 'blockId', 'anchorPosition', 'roadFacingRotation',
    'frontageRoad', 'frontageEdgeId', 'entrancePosition', 'availableFootprintBounds',
    'ownerContext', 'settlementContext', 'frontage', 'buildingLot',
  ]);
  assert.equal(placement.frontageEdgeId, descriptor.lot.frontageEdgeId);
  assert.equal(placement.ownerContext.settlementId, input.candidate.settlementId);
  assert.ok(template.lotSummary.emptyLotCount >= 0);
  assert.equal(template.lotSummary.usedLotCount + template.lotSummary.emptyLotCount,
    template.lots.length);
});

test('Lot source identity survives chunk ownership and W8 does not add scatter overlay', async () => {
  const fixtures = await Promise.all(fixturePromises);
  for (const fixture of fixtures) {
    for (const settlementType of Object.values(SETTLEMENT_TYPES)) {
      const template = await fixture.generator.resolveSettlementTemplate({
        candidate: fixture.byType[settlementType],
      });
      const building = template.buildings.find(value => value.sourceLotId);
      if (!building) continue;
      const owner = logicalWorldToOwnedChunk(building.x, building.z);
      const [first, repeated] = await Promise.all([
        fixture.generator.generateChunk(owner.chunkX, owner.chunkZ),
        fixture.generator.generateChunk(owner.chunkX, owner.chunkZ),
      ]);
      const projected = first.settlementFeatures.find(value => value.stableId === building.stableId);
      assert.ok(projected);
      assert.equal(projected.sourceLotId, building.sourceLotId);
      assert.deepEqual(repeated.settlementFeatures, first.settlementFeatures);
    }
  }
  const w8 = await createW8ParityChunkGenerator({
    worldSeed: 'KaniNingen Infinite Natural World',
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V3_GENERATOR_ID,
    settlementLotMode: SETTLEMENT_LOT_V1_GENERATOR_ID,
  });
  try {
    const candidate = await w8.distributor.findHomeSettlement(0, 0);
    const presentation = await w8.resolveSettlementPresentationTemplate({ candidate });
    assert.equal(presentation.settlementLotMode, SETTLEMENT_LOT_V1_GENERATOR_ID);
    assert.equal(presentation.overlayBuildingCount, 0);
    assert.equal(presentation.buildings.length, presentation.sourceBuildingCount);
  } finally {
    await w8.shutdown();
  }
});

test('lot-v1 disabled keeps protected Building body and existing generation paths unchanged', async () => {
  const protectedPath = 'src/infinite-world/single-rural-settlement.js';
  assert.equal(
    readFileSync(resolve(repoRoot, protectedPath), 'utf8'),
    execFileSync('git', ['show', `${baselineHead}:${protectedPath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    }),
  );
  const fixture = await fixturePromises[0];
  const input = await templateInput(fixture, SETTLEMENT_TYPES.CITY);
  const withoutLotFlag = await createRoadGraphV3SettlementTemplate({
    worldSeedHash: input.worldSeedHash,
    candidate: input.candidate,
    connectivityGraph: input.connectivityGraph,
  });
  assert.equal(withoutLotFlag.schemaVersion, 'w5-road-graph-v3-road-only-template-1');
  assert.deepEqual(withoutLotFlag.blocks, []);
  assert.equal(Object.hasOwn(withoutLotFlag, 'lots'), false);
  assert.equal(Object.hasOwn(withoutLotFlag, 'settlementLotMode'), false);
  const defaultGenerator = await createDistributedSettlementChunkGenerator({
    worldSeed: worldSeeds[0],
  });
  try {
    assert.equal(Object.hasOwn(defaultGenerator, 'settlementLotMode'), false);
    assert.equal(Object.hasOwn(defaultGenerator, 'settlementRoadGraphGeneratorId'), false);
  } finally {
    await defaultGenerator.shutdown();
  }
});
