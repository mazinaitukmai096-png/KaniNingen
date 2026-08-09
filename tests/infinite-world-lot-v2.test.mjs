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
  RURAL_FRONTAGE_FALLBACK_PLACEMENT_MODE,
  RURAL_FRONTAGE_JUNCTION_CLEARANCE_METERS,
  RURAL_VILLAGE_CORE_DENSITY_GRADIENT,
  buildDeterministicFrontageFallbackBuildingsV2,
  buildDeterministicRuralFrontageFallbackBuildingsV2,
} from '../src/infinite-world/settlement-lot-v2.js';
import {
  MIGRATED_SETTLEMENT_PROFILES,
} from '../src/infinite-world/single-rural-settlement.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';

const worldSeeds = Object.freeze([
  'W5 distributed golden',
  'road-v3-seed-a',
  'road-v3-seed-b',
  'road-v3-seed-c',
  'road-v3-seed-d',
  'road-v3-seed-h',
  'road-v3-seed-i',
  'road-v3-seed-j',
  'road-v3-seed-m',
  'road-v3-seed-s',
  'road-v3-seed-t',
  'road-v3-seed-u',
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

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return q6(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

function mean(values) {
  return values.length === 0 ? null : q6(values.reduce((sum, value) => sum + value, 0) / values.length);
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
    frontageInterval: building.frontageInterval ?? null,
    frontageSide: building.frontageSide ?? null,
    setbackMeters: building.setbackMeters ?? null,
    frontageEdgeClass: building.frontageEdgeClass ?? null,
    fallbackAnchorId: building.fallbackAnchorId ?? null,
    x: building.x,
    z: building.z,
    rotationY: building.rotationY,
  })).sort((left, right) => left.stableId.localeCompare(right.stableId));
}

function ruralSelectionSnapshot(template) {
  if (template.settlementType !== SETTLEMENT_TYPES.RURAL || template.blocks.length !== 0) {
    return null;
  }
  const validation = template.lotSummary.fallbackValidation;
  return Object.freeze({
    villageCore: validation.villageCore,
    rawCandidateCount: validation.rawCandidateCount,
    candidateSetHash: validation.candidateSetHash,
    preVillageCoreSelectedSetHash: validation.preVillageCoreSelectedSetHash,
    selectedSetHash: validation.selectedSetHash,
    selectedCandidateCount: validation.selectedCandidateCount,
  });
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

test('CITY/TOWN baseline fixtures use only Lots and validated frontage fallback', async () => {
  const metricRows = [];
  for (const fixturePromise of fixturePromises.slice(0, 3)) {
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

test('production default RURAL applies a Road Graph village-core candidate density gradient', async t => {
  const common = {
    worldSeed: 'KaniNingen Infinite Natural World',
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V3_GENERATOR_ID,
  };
  const [scatterGenerator, selectedGenerator] = await Promise.all([
    createDistributedSettlementChunkGenerator({
      ...common,
      settlementLotMode: SETTLEMENT_LOT_V1_GENERATOR_ID,
    }),
    createDistributedSettlementChunkGenerator({
      ...common,
      settlementLotMode: SETTLEMENT_LOT_V2_GENERATOR_ID,
    }),
  ]);
  try {
    const candidate = await selectedGenerator.distributor.findHomeSettlement(0, 0);
    assert.equal(candidate.settlementId, 'settlement-v1:fe59f37f0137cbdb67a89f76');
    assert.equal(candidate.settlementType, SETTLEMENT_TYPES.RURAL);
    const [scatter, selected] = await Promise.all([
      scatterGenerator.resolveSettlementTemplate({ candidate }),
      selectedGenerator.resolveSettlementTemplate({ candidate }),
    ]);
    const validation = selected.lotSummary.fallbackValidation;
    assert.equal(selected.blocks.length, 0);
    assert.equal(scatter.buildings.length, 28);
    assert.equal(validation.rawCandidateCount, 24);
    assert.equal(validation.materializedCandidateVariantCount, 48);
    assert.equal(validation.preferredSideImmutableRejectedCandidateCount, 12);
    assert.equal(validation.preferredSideRoadOverlapCount, 12);
    assert.equal(validation.legacySequentialSelectedCount, 9);
    assert.equal(validation.immutableRejectedCandidateCount, 8);
    assert.equal(validation.immutableRejectReasonCounts.ROAD_OVERLAP, 8);
    assert.equal(validation.candidateConflictPairCount, 8);
    assert.deepEqual(validation.candidateConflictReasonPairCounts, {
      FRONTAGE: 6,
      BUILDING: 7,
    });
    assert.equal(validation.candidateConflictRejectedCount, 6);
    assert.equal(validation.candidateSetHash,
      'sha256:a7786a3ff8428829ad3286bf7859d1cf15507f0222d949d1e805573fc189b70d');
    assert.equal(validation.preVillageCoreSelectedSetHash,
      'sha256:8f5b81b06483f480742c25be2790402b017b25c77636be6170e032805523e495');
    assert.equal(validation.selectedSetHash,
      'sha256:22af32aa597f6d5b34f8390dc04030d4ea09c4c6220335a6b9aff24d0cf95a9c');
    assert.deepEqual(validation.preVillageCoreSelectionCounts, {
      total: 11,
      collector: 7,
      local: 4,
      deadEnd: 0,
      core: 5,
      middle: 4,
      outer: 2,
    });
    assert.equal(validation.selectionMode, 'RURAL_FRONTAGE_VILLAGE_CORE_GREEDY_V1');
    assert.equal(validation.candidateDensityMode,
      'RURAL_FRONTAGE_VILLAGE_CORE_DENSITY_GRADIENT_V1');
    assert.deepEqual(validation.villageCoreCandidateIntervals,
      RURAL_VILLAGE_CORE_DENSITY_GRADIENT.candidateIntervals);
    assert.deepEqual(validation.villageCore, {
      stableId: 'rural-village-core-v1:5c7ceac4f9796b325ef0e5b7',
      kind: 'PRIMARY_COLLECTOR_JUNCTION',
      nodeId: 'settlement-semantic-v1:road-node:5b9b233045898d9b905970cc251e84ca',
      nodeStableId: 'settlement-semantic-v1:road-node:5b9b233045898d9b905970cc251e84ca',
      edgeStableId: 'settlement-semantic-v1:road-edge:df29e709d678cbf0ccda392c669159bb',
      position: { x: 562.762989, z: 394.413389 },
      edgeT: 0,
      distanceMode: 'ROAD_GRAPH_SHORTEST_PATH',
      bands: { nearMaximumMeters: 35.1, middleMaximumMeters: 56.25 },
    });
    assert.equal(validation.selectedCandidateCount, 10);
    assert.equal(selected.buildings.length, 10);
    assert.deepEqual(validation.selectedClassCounts, {
      collector: 7,
      local: 3,
      'alley/dead-end': 0,
    });
    assert.deepEqual(validation.selectedVillageCoreBandCounts, {
      core: 5,
      middle: 3,
      outer: 2,
    });
    assert.equal(validation.alternateSideCandidateCount, 4);
    assert.equal(validation.selectedAlternateSideCandidateCount, 4);
    assert.deepEqual(validation.usableFrontageMeters, {
      totalMeters: 121.430911,
      coreMeters: 52.909434,
    });
    assert.deepEqual(validation.rawCandidateBandCounts, { core: 15, middle: 5, outer: 4 });
    assert.deepEqual(validation.rawCandidateClassCounts, {
      collector: 18,
      local: 6,
      'alley/dead-end': 0,
    });
    assert.deepEqual(validation.roadOverlapRejectBandCounts, {
      core: 5,
      middle: 1,
      outer: 2,
    });
    assert.equal(selected.lotSummary.legacyScatterBuildingCount, 0);
    assert.ok(selected.buildings.every(building => (
      building.placementMode === RURAL_FRONTAGE_FALLBACK_PLACEMENT_MODE
      && building.frontageEdgeId
      && building.villageCoreStableId === validation.villageCore.stableId
      && Number.isFinite(building.villageCoreDistanceMeters)
      && ['CORE', 'MIDDLE', 'OUTER'].includes(building.villageCoreBand)
    )));
    assert.deepEqual(validation.selectedVillageCoreDistancesMeters,
      selected.buildings.map(building => ({
        stableId: building.stableId,
        band: building.villageCoreBand,
        distanceMeters: building.villageCoreDistanceMeters,
      })).sort((left, right) => left.stableId.localeCompare(right.stableId)));
    const nearestBuildingDistances = selected.buildings.map((building, index) => Math.min(
      ...selected.buildings.filter((_, otherIndex) => otherIndex !== index).map(other => Math.hypot(
        building.x - other.x,
        building.z - other.z,
      )),
    ));
    const coreBuildings = selected.buildings.filter(building => building.villageCoreBand === 'CORE');
    const nearestCoreBuildingDistances = coreBuildings.map((building, index) => Math.min(
      ...coreBuildings.filter((_, otherIndex) => otherIndex !== index).map(other => Math.hypot(
        building.x - other.x,
        building.z - other.z,
      )),
    ));
    const frontageEdgeBuildingCounts = Object.fromEntries([...new Set(
      selected.buildings.map(building => building.frontageEdgeId),
    )].sort().map(edgeId => [
      edgeId,
      selected.buildings.filter(building => building.frontageEdgeId === edgeId).length,
    ]));
    t.diagnostic(JSON.stringify({
      settlementId: candidate.settlementId,
      oldScatterBuildingCount: scatter.buildings.length,
      legacySequentialBuildingCount: validation.legacySequentialSelectedCount,
      rawCandidateCount: validation.rawCandidateCount,
      rawCandidateBandCounts: validation.rawCandidateBandCounts,
      viableCandidateCount: validation.viableCandidateCount,
      usableFrontageMeters: validation.usableFrontageMeters,
      immutableRejectedCandidateCount: validation.immutableRejectedCandidateCount,
      immutableRejectReasonCounts: validation.immutableRejectReasonCounts,
      candidateConflictPairCount: validation.candidateConflictPairCount,
      candidateConflictReasonPairCounts: validation.candidateConflictReasonPairCounts,
      candidateConflictRejectedCount: validation.candidateConflictRejectedCount,
      villageCore: validation.villageCore,
      beforeVillageCore: validation.preVillageCoreSelectionCounts,
      selectedCandidateCount: validation.selectedCandidateCount,
      selectedClassCounts: validation.selectedClassCounts,
      selectedVillageCoreBandCounts: validation.selectedVillageCoreBandCounts,
      selectedVillageCoreDistancesMeters: validation.selectedVillageCoreDistancesMeters,
      nearestBuildingSpacingMeters: {
        min: q6(Math.min(...nearestBuildingDistances)),
        median: median(nearestBuildingDistances),
        max: q6(Math.max(...nearestBuildingDistances)),
      },
      nearestCoreBuildingSpacingMeters: {
        min: q6(Math.min(...nearestCoreBuildingDistances)),
        median: median(nearestCoreBuildingDistances),
        max: q6(Math.max(...nearestCoreBuildingDistances)),
      },
      comparison: {
        A_withoutVillageCore: {
          rawCandidateCount: 21,
          selectedCandidateCount: 9,
        },
        B_selectionWeightingOnly: {
          rawCandidateCount: 21,
          selectedCandidateCount: 10,
          bands: { core: 5, middle: 3, outer: 2 },
          classes: { collector: 6, local: 4, 'alley/dead-end': 0 },
        },
        C_candidateDensityGradient: {
          rawCandidateCount: validation.rawCandidateCount,
          viableCandidateCount: validation.viableCandidateCount,
          selectedCandidateCount: validation.selectedCandidateCount,
          bands: validation.selectedVillageCoreBandCounts,
          classes: validation.selectedClassCounts,
        },
      },
      frontageEdgeBuildingCounts,
    }));
  } finally {
    await Promise.all([scatterGenerator.shutdown(), selectedGenerator.shutdown()]);
  }
});

test('RURAL Block 0 uses deterministic frontage placement with no legacy scatter across twelve seeds', async t => {
  const metricRows = [];
  const allSetbacks = [];
  const allNearestBuildingDistances = [];
  const allNearestCoreBuildingDistances = [];
  const allFrontageDirectionErrors = [];
  for (const fixturePromise of fixturePromises) {
    const fixture = await fixturePromise;
    const candidate = fixture.byType[SETTLEMENT_TYPES.RURAL];
    const v2 = await fixture.v2.resolveSettlementTemplate({ candidate });
    assert.equal(v2.blocks.length, 0);
    assert.equal(v2.lotSummary.legacyScatterBuildingCount, 0);
    assert.equal(v2.lotSummary.scatterFallbackBuildingCount, 0);
    assert.equal(v2.lotSummary.frontageFallbackBuildingCount, v2.buildings.length);
    assert.ok(v2.buildings.length > 0);
    assert.equal(v2.lotSummary.fallbackValidation.valid, true);
    assert.equal(new Set(v2.buildings.map(building => building.stableId)).size, v2.buildings.length);

    const edges = new Map(v2.roadGraph.edges.map(edge => [edge.edgeId, edge]));
    const segments = new Map(v2.roadGraph.segments.map(segment => [segment.edgeId, segment]));
    const allJunctions = junctions(v2.roadGraph);
    const classCounts = { collector: 0, local: 0, 'alley/dead-end': 0 };
    const villageCoreBandCounts = { CORE: 0, MIDDLE: 0, OUTER: 0 };
    const sideCounts = { left: 0, right: 0 };
    const setbacks = [];
    const nearestBuildingDistances = [];
    const coreBuildings = v2.buildings.filter(building => building.villageCoreBand === 'CORE');
    const nearestCoreBuildingDistances = coreBuildings.map((building, index) => Math.min(
      ...coreBuildings.filter((_, otherIndex) => otherIndex !== index).map(other => Math.hypot(
        building.x - other.x,
        building.z - other.z,
      )),
    ));
    let junctionNearbyCount = 0;
    let frontageDirectionOverThirtyCount = 0;
    let roadOverlapCount = 0;
    let buildingOverlapCount = 0;
    let orphanCount = 0;
    for (const building of v2.buildings) {
      assert.equal(building.placementSource, SETTLEMENT_LOT_V2_PLACEMENT_SOURCES.FRONTAGE_FALLBACK);
      assert.equal(building.placementMode, RURAL_FRONTAGE_FALLBACK_PLACEMENT_MODE);
      assert.equal(building.sourceRoadGraphVersion, ROAD_GRAPH_V3_GENERATOR_ID);
      assert.ok(building.id);
      assert.ok(building.frontageEdgeId);
      assert.equal(building.side, building.frontageSide);
      assert.ok(edges.has(building.frontageEdgeId));
      assert.ok(segments.has(building.frontageEdgeId));
      assert.equal(building.sourceLotId, undefined);
      assert.equal(building.blockId, undefined);
      assert.equal(building.owner.settlementId, candidate.settlementId);
      assert.equal(building.placementSourceOwner.frontageEdgeId, building.frontageEdgeId);
      assert.equal(building.placementSourceOwner.sourceOwner.settlementId, candidate.settlementId);
      classCounts[building.frontageEdgeClass] += 1;
      assert.equal(building.villageCoreStableId,
        v2.lotSummary.fallbackValidation.villageCore.stableId);
      assert.ok(Number.isFinite(building.villageCoreDistanceMeters));
      villageCoreBandCounts[building.villageCoreBand] += 1;
      if (building.frontageSide < 0) sideCounts.left += 1;
      else sideCounts.right += 1;
      setbacks.push(building.setbackMeters);
      const segment = segments.get(building.frontageEdgeId);
      const front = { x: Math.sin(building.rotationY), z: Math.cos(building.rotationY) };
      const directionError = axisAngleDegrees(front, segment.normal);
      allFrontageDirectionErrors.push(directionError);
      if (directionError > 30 + 1e-6) frontageDirectionOverThirtyCount += 1;
      const frontagePoint = closestPoint(building, segment).point;
      if (Math.min(...allJunctions.map(node => Math.hypot(
        frontagePoint.x - node.position.x,
        frontagePoint.z - node.position.z,
      ))) < RURAL_FRONTAGE_JUNCTION_CLEARANCE_METERS - 1e-5) orphanCount += 1;
      if (building.junctionDistanceMeters < 24) junctionNearbyCount += 1;
      for (const road of v2.roadGraph.segments) {
        if (orientedRectanglesOverlap(rectangle(building), roadRectangle(road))) roadOverlapCount += 1;
      }
    }
    for (let first = 0; first < v2.buildings.length; first += 1) {
      let nearest = Infinity;
      for (let second = 0; second < v2.buildings.length; second += 1) {
        if (first === second) continue;
        nearest = Math.min(nearest, Math.hypot(
          v2.buildings[first].x - v2.buildings[second].x,
          v2.buildings[first].z - v2.buildings[second].z,
        ));
        if (second > first && orientedRectanglesOverlap(
          rectangle(v2.buildings[first]), rectangle(v2.buildings[second]),
        )) buildingOverlapCount += 1;
      }
      if (Number.isFinite(nearest)) nearestBuildingDistances.push(nearest);
    }
    allSetbacks.push(...setbacks);
    allNearestBuildingDistances.push(...nearestBuildingDistances);
    allNearestCoreBuildingDistances.push(...nearestCoreBuildingDistances);
    assert.equal(frontageDirectionOverThirtyCount, 0);
    assert.equal(roadOverlapCount, 0);
    assert.equal(buildingOverlapCount, 0);
    assert.equal(orphanCount, 0);
    assert.ok(classCounts.collector >= classCounts.local);
    metricRows.push(Object.freeze({
      seed: fixture.worldSeed,
      blockCount: v2.blocks.length,
      rawCandidateCount: v2.lotSummary.fallbackValidation.rawCandidateCount,
      viableCandidateCount: v2.lotSummary.fallbackValidation.viableCandidateCount,
      buildingCount: v2.buildings.length,
      collectorFrontageCount: classCounts.collector,
      localFrontageCount: classCounts.local,
      deadEndFrontageCount: classCounts['alley/dead-end'],
      villageCoreKind: v2.lotSummary.fallbackValidation.villageCore.kind,
      villageCoreStableId: v2.lotSummary.fallbackValidation.villageCore.stableId,
      coreBuildingCount: villageCoreBandCounts.CORE,
      middleBuildingCount: villageCoreBandCounts.MIDDLE,
      outerBuildingCount: villageCoreBandCounts.OUTER,
      legacyScatterCount: v2.lotSummary.legacyScatterBuildingCount,
      averageBuildingSpacingMeters: mean(nearestBuildingDistances),
      minimumBuildingSpacingMeters: q6(Math.min(...nearestBuildingDistances)),
      medianBuildingSpacingMeters: median(nearestBuildingDistances),
      maximumBuildingSpacingMeters: q6(Math.max(...nearestBuildingDistances)),
      minimumCoreBuildingSpacingMeters: q6(Math.min(...nearestCoreBuildingDistances)),
      medianCoreBuildingSpacingMeters: median(nearestCoreBuildingDistances),
      maximumCoreBuildingSpacingMeters: q6(Math.max(...nearestCoreBuildingDistances)),
      setbackMinMeters: q6(Math.min(...setbacks)),
      setbackMedianMeters: median(setbacks),
      setbackMaxMeters: q6(Math.max(...setbacks)),
      leftCount: sideCounts.left,
      rightCount: sideCounts.right,
      junctionNearbyCount,
      roadOverlapCount,
      buildingOverlapCount,
      orphanCount,
      duplicateStableIdCount: v2.buildings.length - new Set(
        v2.buildings.map(building => building.stableId),
      ).size,
      frontageDirectionOverThirtyCount,
    }));
  }
  assert.equal(metricRows.length, 12);
  assert.ok(metricRows.every(row => row.blockCount === 0));
  assert.ok(metricRows.every(row => row.legacyScatterCount === 0));
  assert.ok(metricRows.every(row => row.buildingCount >= 8 && row.buildingCount <= 15));
  assert.ok(metricRows.every(row => row.roadOverlapCount === 0
    && row.buildingOverlapCount === 0 && row.orphanCount === 0
    && row.duplicateStableIdCount === 0 && row.frontageDirectionOverThirtyCount === 0));
  const totals = metricRows.reduce((result, row) => ({
    building: result.building + row.buildingCount,
    collector: result.collector + row.collectorFrontageCount,
    local: result.local + row.localFrontageCount,
    deadEnd: result.deadEnd + row.deadEndFrontageCount,
    core: result.core + row.coreBuildingCount,
    middle: result.middle + row.middleBuildingCount,
    outer: result.outer + row.outerBuildingCount,
    left: result.left + row.leftCount,
    right: result.right + row.rightCount,
    roadOverlap: result.roadOverlap + row.roadOverlapCount,
    buildingOverlap: result.buildingOverlap + row.buildingOverlapCount,
    orphan: result.orphan + row.orphanCount,
    duplicate: result.duplicate + row.duplicateStableIdCount,
    overThirty: result.overThirty + row.frontageDirectionOverThirtyCount,
    legacyScatter: result.legacyScatter + row.legacyScatterCount,
  }), {
    building: 0, collector: 0, local: 0, deadEnd: 0, core: 0, middle: 0, outer: 0,
    left: 0, right: 0,
    roadOverlap: 0, buildingOverlap: 0, orphan: 0, duplicate: 0, overThirty: 0,
    legacyScatter: 0,
  });
  const buildingCounts = metricRows.map(row => row.buildingCount);
  const summary = Object.freeze({
    seedCount: metricRows.length,
    buildingCount: Object.freeze({
      min: Math.min(...buildingCounts), median: median(buildingCounts), max: Math.max(...buildingCounts),
    }),
    rawCandidateCount: Object.freeze({
      min: Math.min(...metricRows.map(row => row.rawCandidateCount)),
      median: median(metricRows.map(row => row.rawCandidateCount)),
      max: Math.max(...metricRows.map(row => row.rawCandidateCount)),
    }),
    viableCandidateCount: Object.freeze({
      min: Math.min(...metricRows.map(row => row.viableCandidateCount)),
      median: median(metricRows.map(row => row.viableCandidateCount)),
      max: Math.max(...metricRows.map(row => row.viableCandidateCount)),
    }),
    classCount: Object.freeze({
      collector: totals.collector, local: totals.local, deadEnd: totals.deadEnd,
      collectorRatio: q6(totals.collector / totals.building),
      localRatio: q6(totals.local / totals.building),
    }),
    villageCoreBandCount: Object.freeze({
      core: totals.core,
      middle: totals.middle,
      outer: totals.outer,
      coreRatio: q6(totals.core / totals.building),
      middleRatio: q6(totals.middle / totals.building),
      outerRatio: q6(totals.outer / totals.building),
    }),
    villageCoreKindCount: Object.freeze(Object.fromEntries(
      [...new Set(metricRows.map(row => row.villageCoreKind))].sort().map(kind => [
        kind,
        metricRows.filter(row => row.villageCoreKind === kind).length,
      ]),
    )),
    sideCount: Object.freeze({
      left: totals.left, right: totals.right, leftRatio: q6(totals.left / totals.building),
    }),
    setbackMeters: Object.freeze({
      min: q6(Math.min(...allSetbacks)), median: median(allSetbacks), max: q6(Math.max(...allSetbacks)),
    }),
    nearestBuildingSpacingMeters: Object.freeze({
      min: q6(Math.min(...allNearestBuildingDistances)),
      median: median(allNearestBuildingDistances),
      max: q6(Math.max(...allNearestBuildingDistances)),
    }),
    nearestCoreBuildingSpacingMeters: Object.freeze({
      min: q6(Math.min(...allNearestCoreBuildingDistances)),
      median: median(allNearestCoreBuildingDistances),
      max: q6(Math.max(...allNearestCoreBuildingDistances)),
    }),
    frontageDirectionErrorDegrees: Object.freeze({
      min: q6(Math.min(...allFrontageDirectionErrors)),
      median: median(allFrontageDirectionErrors),
      max: q6(Math.max(...allFrontageDirectionErrors)),
      overThirtyCount: totals.overThirty,
    }),
    validation: Object.freeze({
      frontageCount: totals.building,
      legacyScatterCount: totals.legacyScatter,
      roadOverlapCount: totals.roadOverlap,
      buildingOverlapCount: totals.buildingOverlap,
      orphanCount: totals.orphan,
      duplicateStableIdCount: totals.duplicate,
    }),
    comparison: Object.freeze({
      A_withoutVillageCore: Object.freeze({
        rawCandidateCount: { min: 18, median: 22.5, max: 24 },
        viableCandidateCount: { min: 10, median: 14, max: 16 },
        buildingCount: { min: 8, median: 10.5, max: 15 },
        collectorRatio: 0.653226,
        localRatio: 0.346774,
        nearestBuildingSpacingMedianMeters: 11.496903,
      }),
      B_selectionWeightingOnly: Object.freeze({
        rawCandidateCount: { min: 18, median: 22.5, max: 24 },
        viableCandidateCount: { min: 10, median: 14, max: 16 },
        buildingCount: { min: 8, median: 10, max: 15 },
        collectorRatio: 0.663934,
        localRatio: 0.336066,
        coreRatio: 0.532787,
        middleRatio: 0.311475,
        outerRatio: 0.155738,
        nearestBuildingSpacingMedianMeters: 11.264369,
      }),
      C_candidateDensityGradient: Object.freeze({
        rawCandidateCount: {
          min: Math.min(...metricRows.map(row => row.rawCandidateCount)),
          median: median(metricRows.map(row => row.rawCandidateCount)),
          max: Math.max(...metricRows.map(row => row.rawCandidateCount)),
        },
        viableCandidateCount: {
          min: Math.min(...metricRows.map(row => row.viableCandidateCount)),
          median: median(metricRows.map(row => row.viableCandidateCount)),
          max: Math.max(...metricRows.map(row => row.viableCandidateCount)),
        },
        buildingCount: {
          min: Math.min(...buildingCounts),
          median: median(buildingCounts),
          max: Math.max(...buildingCounts),
        },
        collectorRatio: q6(totals.collector / totals.building),
        localRatio: q6(totals.local / totals.building),
        coreRatio: q6(totals.core / totals.building),
        middleRatio: q6(totals.middle / totals.building),
        outerRatio: q6(totals.outer / totals.building),
        nearestBuildingSpacingMedianMeters: median(allNearestBuildingDistances),
        nearestCoreBuildingSpacingMedianMeters: median(allNearestCoreBuildingDistances),
      }),
    }),
  });
  assert.ok(summary.buildingCount.min >= 6);
  assert.ok(summary.buildingCount.median >= 9 && summary.buildingCount.median <= 12);
  assert.ok(summary.buildingCount.max <= 16);
  assert.ok(summary.classCount.collectorRatio >= 0.7
    && summary.classCount.collectorRatio <= 0.8);
  assert.ok(summary.classCount.localRatio >= 0.2 && summary.classCount.localRatio <= 0.3);
  assert.equal(totals.core + totals.middle + totals.outer, totals.building);
  assert.ok(summary.villageCoreBandCount.coreRatio >= 0.55
    && summary.villageCoreBandCount.coreRatio <= 0.7);
  assert.ok(summary.villageCoreBandCount.middleRatio >= 0.2
    && summary.villageCoreBandCount.middleRatio <= 0.35);
  assert.ok(summary.villageCoreBandCount.outerRatio >= 0.05
    && summary.villageCoreBandCount.outerRatio <= 0.15);
  t.diagnostic(JSON.stringify({ rows: metricRows, summary }));
});

test('Block-bearing RURAL remains on the existing lot-v2 Lot and frontage fallback path', async () => {
  const generator = await createDistributedSettlementChunkGenerator({
    worldSeed: 'road-v3-seed-e',
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V3_GENERATOR_ID,
    settlementLotMode: SETTLEMENT_LOT_V2_GENERATOR_ID,
  });
  try {
    const candidate = (await generator.distributor.findInMacroRange(-10, 10, -10, 10))
      .find(value => value.settlementType === SETTLEMENT_TYPES.RURAL);
    const template = await generator.resolveSettlementTemplate({ candidate });
    assert.ok(template.blocks.length > 0);
    assert.ok(template.lotSummary.closedBlockCount > 0);
    assert.equal(template.lotSummary.legacyScatterBuildingCount, 0);
    assert.ok(template.buildings.some(building => (
      building.placementSource === SETTLEMENT_LOT_V2_PLACEMENT_SOURCES.LOT
    )));
    const fallback = template.buildings.filter(building => (
      building.placementSource === SETTLEMENT_LOT_V2_PLACEMENT_SOURCES.FRONTAGE_FALLBACK
    ));
    assert.ok(fallback.length > 0);
    assert.equal(fallback.some(building => (
      building.placementMode === RURAL_FRONTAGE_FALLBACK_PLACEMENT_MODE
    )), false);
  } finally {
    await generator.shutdown();
  }
});

test('lot-v2 ignores repetition, settlement order, Block order, edge order, and parallelism', async () => {
  const fixtures = await Promise.all(fixturePromises);
  const inputs = await Promise.all(fixtures.flatMap((fixture, fixtureIndex) => (
    [
      ...(fixtureIndex < 3 ? [SETTLEMENT_TYPES.CITY, SETTLEMENT_TYPES.TOWN] : []),
      SETTLEMENT_TYPES.RURAL,
    ].map(async settlementType => {
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
  assert.deepEqual(repeat.map(ruralSelectionSnapshot), serial.map(ruralSelectionSnapshot));
  const reverse = [];
  for (const input of [...inputs].reverse()) {
    reverse.push(await createRoadGraphV3SettlementTemplate(input));
  }
  reverse.reverse();
  assert.deepEqual(reverse.map(placementSnapshot), serial.map(placementSnapshot));
  assert.deepEqual(reverse.map(ruralSelectionSnapshot), serial.map(ruralSelectionSnapshot));
  const parallel = await Promise.all(inputs.map(createRoadGraphV3SettlementTemplate));
  assert.deepEqual(parallel.map(placementSnapshot), serial.map(placementSnapshot));
  assert.deepEqual(parallel.map(ruralSelectionSnapshot), serial.map(ruralSelectionSnapshot));

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
    const fallback = input.candidate.settlementType === SETTLEMENT_TYPES.RURAL
      && blocks.length === 0
      ? await buildDeterministicRuralFrontageFallbackBuildingsV2({
        worldSeedHash: input.worldSeedHash,
        town: localTown(input.candidate),
        settlementId: input.candidate.settlementId,
        roadGraph: reversedGraph,
        candidate: input.candidate,
        blocks: Object.freeze([...blocks].reverse()),
        lots: Object.freeze([...lotResult.lots].reverse()),
        lotBuildings: Object.freeze([...lotBuildings.buildings].reverse()),
      })
      : await buildDeterministicFrontageFallbackBuildingsV2({
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
      frontageInterval: building.frontageInterval ?? null,
      frontageSide: building.frontageSide ?? null,
      setbackMeters: building.setbackMeters ?? null,
      placementMode: building.placementMode ?? null,
      x: q6(building.x - input.candidate.center.x),
      z: q6(building.z - input.candidate.center.z),
      rotationY: building.rotationY,
    })).sort((left, right) => left.stableId.localeCompare(right.stableId));
    assert.deepEqual(fallback.buildings.map(building => ({
      stableId: building.stableId,
      frontageEdgeId: building.frontageEdgeId,
      fallbackAnchorId: building.fallbackAnchorId,
      frontageInterval: building.frontageInterval ?? null,
      frontageSide: building.frontageSide ?? null,
      setbackMeters: building.setbackMeters ?? null,
      placementMode: building.placementMode ?? null,
      x: building.x,
      z: building.z,
      rotationY: building.rotationY,
    })), expected);
    if (input.candidate.settlementType === SETTLEMENT_TYPES.RURAL && blocks.length === 0) {
      assert.deepEqual(
        fallback.validation.villageCore,
        template.lotSummary.fallbackValidation.villageCore,
      );
      assert.equal(
        fallback.validation.candidateSetHash,
        template.lotSummary.fallbackValidation.candidateSetHash,
      );
      assert.equal(
        fallback.validation.preVillageCoreSelectedSetHash,
        template.lotSummary.fallbackValidation.preVillageCoreSelectedSetHash,
      );
      assert.equal(
        fallback.validation.selectedSetHash,
        template.lotSummary.fallbackValidation.selectedSetHash,
      );
      assert.equal(
        fallback.validation.selectedCandidateCount,
        template.lotSummary.fallbackValidation.selectedCandidateCount,
      );
    }
  }
});
