import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { orientedRectanglesOverlap } from '../src/building-lot.js';
import { SETTLEMENT_TYPES } from '../src/settlement-type.js';
import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { buildDeterministicBuildingsFromLots } from '../src/infinite-world/lot-building-adapter-v1.js';
import { ROAD_GRAPH_V3_GENERATOR_ID } from '../src/infinite-world/road-graph-v3.js';
import { createRoadGraphV3SettlementTemplate } from '../src/infinite-world/road-graph-v3-settlement-adapter.js';
import {
  SETTLEMENT_LOT_V1_GENERATOR_ID,
  createRoadGraphV3Blocks,
  createSettlementLotsV1,
  deriveSettlementBlockPolygon,
  settlementPolygonsOverlap,
} from '../src/infinite-world/settlement-lot-v1.js';
import {
  SETTLEMENT_LOT_V2_FALLBACK_PARAMETERS,
  SETTLEMENT_LOT_V2_GENERATOR_ID,
  SETTLEMENT_LOT_V2_PLACEMENT_SOURCES,
  buildDeterministicFrontageFallbackBuildingsV2,
} from '../src/infinite-world/settlement-lot-v2.js';
import {
  MIGRATED_SETTLEMENT_PROFILES,
} from '../src/infinite-world/single-rural-settlement.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';

const worldSeeds = Object.freeze([
  'W5 distributed golden',
  'road-v3-seed-b',
  'road-v3-seed-c',
]);
const q6 = value => Number(value.toFixed(6));

const fixturePromises = worldSeeds.map(async worldSeed => {
  const common = {
    worldSeed,
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V3_GENERATOR_ID,
  };
  const [v1, v2] = await Promise.all([
    createDistributedSettlementChunkGenerator({
      ...common,
      settlementLotMode: SETTLEMENT_LOT_V1_GENERATOR_ID,
    }),
    createDistributedSettlementChunkGenerator({
      ...common,
      settlementLotMode: SETTLEMENT_LOT_V2_GENERATOR_ID,
    }),
  ]);
  const candidates = await v2.distributor.findInMacroRange(-10, 10, -10, 10);
  const byType = Object.fromEntries(Object.values(SETTLEMENT_TYPES).map(settlementType => [
    settlementType,
    candidates.find(candidate => candidate.settlementType === settlementType),
  ]));
  assert.ok(Object.values(byType).every(Boolean));
  return { worldSeed, v1, v2, byType };
});

after(async () => {
  for (const fixturePromise of fixturePromises) {
    const fixture = await fixturePromise;
    await Promise.all([fixture.v1.shutdown(), fixture.v2.shutdown()]);
  }
});

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

function rectangle(building) {
  return {
    centerX: building.lot.centerX,
    centerZ: building.lot.centerZ,
    rotationY: building.rotationY,
    width: building.lot.widthMeters,
    depth: building.lot.depthMeters,
  };
}

function rectangleCorners(value) {
  const right = { x: Math.cos(value.rotationY), z: -Math.sin(value.rotationY) };
  const front = { x: Math.sin(value.rotationY), z: Math.cos(value.rotationY) };
  return [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([rs, fs]) => ({
    x: value.centerX + right.x * value.width / 2 * rs + front.x * value.depth / 2 * fs,
    z: value.centerZ + right.z * value.width / 2 * rs + front.z * value.depth / 2 * fs,
  }));
}

function roadRectangle(segment) {
  return {
    centerX: (segment.start.x + segment.end.x) / 2,
    centerZ: (segment.start.z + segment.end.z) / 2,
    rotationY: Math.atan2(segment.tangent.x, segment.tangent.z),
    width: segment.widthMeters,
    depth: Math.hypot(segment.end.x - segment.start.x, segment.end.z - segment.start.z),
  };
}

function closestPoint(value, segment) {
  const dx = segment.end.x - segment.start.x;
  const dz = segment.end.z - segment.start.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared <= 1e-12 ? 0 : Math.max(0, Math.min(
    1,
    ((value.x - segment.start.x) * dx + (value.z - segment.start.z) * dz) / lengthSquared,
  ));
  const point = { x: segment.start.x + dx * t, z: segment.start.z + dz * t };
  return { point, t, distance: Math.hypot(value.x - point.x, value.z - point.z) };
}

function axisAngleDegrees(first, second) {
  const dot = Math.max(-1, Math.min(1, Math.abs(first.x * second.x + first.z * second.z)));
  return Math.acos(dot) * 180 / Math.PI;
}

function junctions(roadGraph) {
  const degree = new Map();
  for (const edge of roadGraph.edges) {
    degree.set(edge.startNodeId, (degree.get(edge.startNodeId) ?? 0) + 1);
    degree.set(edge.endNodeId, (degree.get(edge.endNodeId) ?? 0) + 1);
  }
  return roadGraph.nodes.filter(node => (
    node.role?.includes('junction') || (degree.get(node.nodeId) ?? 0) >= 3
  ));
}

function placementSnapshot(template) {
  return template.buildings.map(building => ({
    stableId: building.stableId,
    placementSource: building.placementSource
      ?? SETTLEMENT_LOT_V2_PLACEMENT_SOURCES.LEGACY_SCATTER,
    frontageEdgeId: building.frontageEdgeId ?? building.frontageRoadId,
    fallbackAnchorId: building.fallbackAnchorId ?? null,
    x: building.x,
    z: building.z,
    rotationY: building.rotationY,
  })).sort((left, right) => left.stableId.localeCompare(right.stableId));
}

test('lot-v2 is gated by road-graph-v3 and W8 keeps overlay scatter disabled', async () => {
  await assert.rejects(createDistributedSettlementChunkGenerator({
    worldSeed: 'invalid lot-v2 combination',
    settlementLotMode: SETTLEMENT_LOT_V2_GENERATOR_ID,
  }), /lot-v2 requires/);
  const w8 = await createW8ParityChunkGenerator({
    worldSeed: 'lot-v2 W8 overlay contract',
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V3_GENERATOR_ID,
    settlementLotMode: SETTLEMENT_LOT_V2_GENERATOR_ID,
  });
  try {
    const candidate = await w8.distributor.findHomeSettlement(0, 0);
    const presentation = await w8.resolveSettlementPresentationTemplate({ candidate });
    assert.equal(presentation.settlementLotMode, SETTLEMENT_LOT_V2_GENERATOR_ID);
    assert.equal(presentation.overlayBuildingCount, 0);
    assert.equal(presentation.buildings.length, presentation.sourceBuildingCount);
  } finally {
    await w8.shutdown();
  }
});

test('CITY/TOWN across three seeds use only Lots and validated frontage fallback', async () => {
  const metricRows = [];
  for (const fixturePromise of fixturePromises) {
    const fixture = await fixturePromise;
    for (const settlementType of [SETTLEMENT_TYPES.CITY, SETTLEMENT_TYPES.TOWN]) {
      const candidate = fixture.byType[settlementType];
      const [v1, v2] = await Promise.all([
        fixture.v1.resolveSettlementTemplate({ candidate }),
        fixture.v2.resolveSettlementTemplate({ candidate }),
      ]);
      assert.ok(v2.lotSummary.closedBlockCount > 0);
      assert.equal(v2.lotSummary.legacyScatterBuildingCount, 0);
      assert.equal(v2.lotSummary.scatterFallbackBuildingCount, 0);
      assert.equal(v2.lotSummary.fallbackValidation.valid, true);
      assert.equal(v2.lotSummary.lotValidation.valid, true);
      assert.equal(v2.lotSummary.buildingValidation.valid, true);
      assert.equal(v2.buildings.length, v2.lotSummary.usedLotCount
        + v2.lotSummary.frontageFallbackBuildingCount);
      assert.equal(v2.lotSummary.usedLotCount + v2.lotSummary.emptyLotCount, v2.lots.length);
      assert.ok(v2.buildings.length <= v2.requestedBuildingCount);

      const edgesById = new Map(v2.roadGraph.edges.map(edge => [edge.edgeId, edge]));
      const segmentsById = new Map(v2.roadGraph.segments.map(segment => [segment.edgeId, segment]));
      const blockPolygons = v2.blocks.filter(block => block.isClosed === true)
        .map(block => deriveSettlementBlockPolygon({ roadGraph: v2.roadGraph, block }));
      const fallback = v2.buildings.filter(building => (
        building.placementSource === SETTLEMENT_LOT_V2_PLACEMENT_SOURCES.FRONTAGE_FALLBACK
      ));
      const lotBuildings = v2.buildings.filter(building => (
        building.placementSource === SETTLEMENT_LOT_V2_PLACEMENT_SOURCES.LOT
      ));
      assert.equal(new Set(v2.buildings.map(building => building.stableId)).size, v2.buildings.length);
      assert.ok(fallback.length > 0);
      assert.equal(v2.buildings.filter(building => !building.placementSource).length, 0);

      let overThirtyDegreeCount = 0;
      let maximumNearestRoadError = 0;
      let minimumFallbackSpacing = Infinity;
      let maximumAdjacentAxisDifference = 0;
      for (const building of fallback) {
        const edge = edgesById.get(building.frontageEdgeId);
        const assigned = segmentsById.get(building.frontageEdgeId);
        assert.ok(edge);
        assert.ok(assigned);
        assert.equal(edge.flags.frontageEligible, true);
        const front = { x: Math.sin(building.rotationY), z: Math.cos(building.rotationY) };
        assert.ok(axisAngleDegrees(front, assigned.normal) < 1e-4);
        const nearest = v2.roadGraph.segments.map(segment => ({
          segment,
          ...closestPoint(building, segment),
        })).sort((left, right) => left.distance - right.distance
          || left.segment.edgeId.localeCompare(right.segment.edgeId))[0];
        const nearestError = axisAngleDegrees(front, nearest.segment.normal);
        maximumNearestRoadError = Math.max(maximumNearestRoadError, nearestError);
        if (nearestError > 30 + 1e-6) overThirtyDegreeCount += 1;
        const frontagePoint = closestPoint(building, assigned).point;
        const minimumJunctionDistance = Math.min(...junctions(v2.roadGraph).map(node => Math.hypot(
          frontagePoint.x - node.position.x,
          frontagePoint.z - node.position.z,
        )));
        assert.ok(minimumJunctionDistance
          >= SETTLEMENT_LOT_V2_FALLBACK_PARAMETERS.junctionClearanceMeters - 1e-5);
        const footprint = rectangleCorners(rectangle(building));
        assert.equal(blockPolygons.some(polygon => settlementPolygonsOverlap(footprint, polygon)), false);
        for (const road of v2.roadGraph.segments) {
          assert.equal(orientedRectanglesOverlap({
            centerX: building.x,
            centerZ: building.z,
            rotationY: building.rotationY,
            width: building.widthMeters,
            depth: building.depthMeters,
          }, roadRectangle(road)), false);
        }
      }
      assert.equal(overThirtyDegreeCount, 0);
      for (let first = 0; first < v2.buildings.length; first += 1) {
        for (let second = first + 1; second < v2.buildings.length; second += 1) {
          assert.equal(orientedRectanglesOverlap(
            rectangle(v2.buildings[first]),
            rectangle(v2.buildings[second]),
          ), false);
          if (v2.buildings[first].placementSource !== v2.buildings[second].placementSource) {
            assert.notEqual(v2.buildings[first].stableId, v2.buildings[second].stableId);
          }
          if (v2.buildings[first].placementSource === SETTLEMENT_LOT_V2_PLACEMENT_SOURCES.FRONTAGE_FALLBACK
            && v2.buildings[second].placementSource === SETTLEMENT_LOT_V2_PLACEMENT_SOURCES.FRONTAGE_FALLBACK
            && v2.buildings[first].frontageRouteId === v2.buildings[second].frontageRouteId
            && v2.buildings[first].frontageSide === v2.buildings[second].frontageSide) {
            minimumFallbackSpacing = Math.min(minimumFallbackSpacing, Math.hypot(
              v2.buildings[first].x - v2.buildings[second].x,
              v2.buildings[first].z - v2.buildings[second].z,
            ));
            maximumAdjacentAxisDifference = Math.max(maximumAdjacentAxisDifference, axisAngleDegrees(
              { x: Math.sin(v2.buildings[first].rotationY), z: Math.cos(v2.buildings[first].rotationY) },
              { x: Math.sin(v2.buildings[second].rotationY), z: Math.cos(v2.buildings[second].rotationY) },
            ));
          }
        }
      }
      assert.equal(lotBuildings.some(building => !building.sourceLotId), false);
      metricRows.push(Object.freeze({
        seed: fixture.worldSeed,
        settlementType,
        v1BuildingCount: v1.buildings.length,
        v1LotBuildingCount: v1.buildings.filter(building => building.sourceLotId).length,
        v1LegacyScatterCount: v1.buildings.filter(building => !building.sourceLotId).length,
        v2BuildingCount: v2.buildings.length,
        v2LotBuildingCount: lotBuildings.length,
        v2FrontageFallbackCount: fallback.length,
        v2LegacyScatterCount: 0,
        emptyLotCount: v2.lotSummary.emptyLotCount,
        shortageCount: v2.buildingShortageCount,
        minimumFallbackSpacing: Number.isFinite(minimumFallbackSpacing)
          ? q6(minimumFallbackSpacing) : null,
        maximumNearestRoadError: q6(maximumNearestRoadError),
        maximumAdjacentAxisDifference: q6(maximumAdjacentAxisDifference),
      }));
    }
  }
  assert.equal(metricRows.length, 6);
  assert.ok(metricRows.every(row => row.v2LegacyScatterCount === 0));
  assert.ok(metricRows.every(row => row.v2BuildingCount < row.v1BuildingCount));
});

test('RURAL Block 0 preserves the exact legacy scatter result', async () => {
  let zeroBlockFixtureCount = 0;
  for (const fixturePromise of fixturePromises) {
    const fixture = await fixturePromise;
    const candidate = fixture.byType[SETTLEMENT_TYPES.RURAL];
    const [v1, v2] = await Promise.all([
      fixture.v1.resolveSettlementTemplate({ candidate }),
      fixture.v2.resolveSettlementTemplate({ candidate }),
    ]);
    if (v2.blocks.length !== 0) continue;
    zeroBlockFixtureCount += 1;
    assert.deepEqual(v2.buildings, v1.buildings);
    assert.equal(v2.lotSummary.frontageFallbackBuildingCount, 0);
    assert.equal(v2.lotSummary.legacyScatterBuildingCount, v1.buildings.length);
  }
  assert.ok(zeroBlockFixtureCount > 0);
});

test('lot-v2 ignores repetition, settlement order, Block order, edge order, and parallelism', async () => {
  const fixtures = await Promise.all(fixturePromises);
  const inputs = await Promise.all(fixtures.flatMap(fixture => (
    [SETTLEMENT_TYPES.CITY, SETTLEMENT_TYPES.TOWN].map(async settlementType => {
      const candidate = fixture.byType[settlementType];
      return {
        worldSeedHash: fixture.v2.worldSeedHash,
        candidate,
        connectivityGraph: await fixture.v2.distributor.buildConnectivityGraphNear(
          candidate.center.x,
          candidate.center.z,
          candidate.radiusMeters,
        ),
        settlementLotMode: SETTLEMENT_LOT_V2_GENERATOR_ID,
      };
    })
  )));
  const serial = [];
  for (const input of inputs) serial.push(await createRoadGraphV3SettlementTemplate(input));
  const repeat = [];
  for (const input of inputs) repeat.push(await createRoadGraphV3SettlementTemplate(input));
  assert.deepEqual(repeat.map(placementSnapshot), serial.map(placementSnapshot));
  const reverse = [];
  for (const input of [...inputs].reverse()) {
    reverse.push(await createRoadGraphV3SettlementTemplate(input));
  }
  reverse.reverse();
  assert.deepEqual(reverse.map(placementSnapshot), serial.map(placementSnapshot));
  const parallel = await Promise.all(inputs.map(createRoadGraphV3SettlementTemplate));
  assert.deepEqual(parallel.map(placementSnapshot), serial.map(placementSnapshot));

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
    const lotBuildings = await buildDeterministicBuildingsFromLots({
      town: localTown(input.candidate),
      settlementId: input.candidate.settlementId,
      roadGraph: reversedGraph,
      candidate: input.candidate,
      lots: Object.freeze([...lotResult.lots].reverse()),
    });
    const fallback = await buildDeterministicFrontageFallbackBuildingsV2({
      town: localTown(input.candidate),
      settlementId: input.candidate.settlementId,
      roadGraph: reversedGraph,
      candidate: input.candidate,
      blocks: Object.freeze([...blocks].reverse()),
      lots: Object.freeze([...lotResult.lots].reverse()),
      lotBuildings: Object.freeze([...lotBuildings.buildings].reverse()),
    });
    const expected = template.buildings.filter(building => (
      building.placementSource === SETTLEMENT_LOT_V2_PLACEMENT_SOURCES.FRONTAGE_FALLBACK
    )).map(building => ({
      stableId: building.stableId,
      frontageEdgeId: building.frontageEdgeId,
      fallbackAnchorId: building.fallbackAnchorId,
      x: q6(building.x - input.candidate.center.x),
      z: q6(building.z - input.candidate.center.z),
      rotationY: building.rotationY,
    })).sort((left, right) => left.stableId.localeCompare(right.stableId));
    assert.deepEqual(fallback.buildings.map(building => ({
      stableId: building.stableId,
      frontageEdgeId: building.frontageEdgeId,
      fallbackAnchorId: building.fallbackAnchorId,
      x: building.x,
      z: building.z,
      rotationY: building.rotationY,
    })), expected);
  }
});
