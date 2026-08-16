import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  PRESENTATION_OWNER_SCHEMA,
  createPresentationOwnerGenerator,
  createPresentationOwnerResource,
  derivePresentationOwnerCoarseSummary,
  expandPresentationAuxiliaryRecord,
  expandPresentationNaturalRecord,
  expandPresentationStructureRecord,
  validatePresentationOwnerResource,
} from '../src/infinite-world/presentation-owner-generator.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import { createNodeChunkGeneratorWorker } from '../src/infinite-world/node-worker-chunk-generator-adapter.js';
import { createInlineChunkGeneratorTransport } from '../src/infinite-world/inline-chunk-generator-transport.js';
import { createWorkerChunkGeneratorTransport } from '../src/infinite-world/worker-chunk-generator-transport.js';
import { createWorldGenerationRequestEnvelope } from '../src/infinite-world/world-generation-scheduler.js';
import { resolveCanonicalGroundSurface } from '../src/infinite-world/w8-surface-policy.js';
import { resolveW8CanonicalWorldObject } from '../src/infinite-world/world-object-canonical-contract.js';

const seed = 'KaniNingen Infinite Natural World';
const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

test('PresentationOwner schema is compact and excludes Full-only payload', async () => {
  const generator = await createPresentationOwnerGenerator({ worldSeed: seed });
  const { resource, diagnostics } = await generator.generateOwner(20, 20);
  assert.equal(resource.schemaVersion, PRESENTATION_OWNER_SCHEMA);
  assert.equal(validatePresentationOwnerResource(resource).valid, true);
  for (const forbidden of [
    'terrain', 'grass', 'gameplay', 'collision', 'generationProof', 'contentHash',
  ]) {
    assert.equal(forbidden in resource, false);
  }
  assert.equal(diagnostics.denseTerrainMaterialized, false);
  assert.equal(diagnostics.fullNaturalExpanded, false);
  assert.equal(diagnostics.grassGenerated, false);
  assert.equal(diagnostics.gameplayGenerated, false);
  assert.equal(diagnostics.fullSettlementGenerated, false);
  assert.equal(diagnostics.largeContentHashGenerated, false);
  assert.ok(diagnostics.latticeSampleCount < 33 * 33);
  assert.ok(resource.natural.every(record => ['tree', 'shrub', 'rock'].includes(record.objectType)));
  const summary = derivePresentationOwnerCoarseSummary(resource);
  assert.equal(summary.ownerKey, resource.identity.owner.key);
  assert.equal(summary.terrainRequired, true);
  assert.deepEqual(summary.structureStableIds, []);
  const compactTrees = resource.natural.filter(record => record.objectType === 'tree');
  assert.equal(summary.canonicalTreeCount, compactTrees.length);
  assert.equal('forestCoverageFloorStableId' in summary, false);
  assert.ok(summary.selectedForestStableIds.every(stableId => (
    compactTrees.some(record => record.stableId === stableId)
  )), 'coarse forest IDs must be canonical PresentationOwner Tree identities');
});

test('coarse summary admits only canonical anchors inside its immutable owner domain', () => {
  const base = createPresentationOwnerResource({
    worldSeedHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    chunkX: 10,
    chunkZ: 20,
  });
  const resource = Object.freeze({
    ...base,
    natural: Object.freeze([
      Object.freeze({
        stableId: 'tree:inside', owner: '10,20', position: Object.freeze([168, 0, 328]),
        objectType: 'tree', densityRank: 0,
      }),
      Object.freeze({
        stableId: 'tree:outside-anchor', owner: '10,20', position: Object.freeze([176, 0, 328]),
        objectType: 'tree', densityRank: 0,
      }),
      Object.freeze({
        stableId: 'tree:cross-owner', owner: '11,20', position: Object.freeze([168, 0, 328]),
        objectType: 'tree', densityRank: 0,
      }),
    ]),
    structures: Object.freeze([
      Object.freeze({
        stableId: 'building:inside', owner: '10,20', position: Object.freeze([168, 0, 328]),
        objectType: 'building',
      }),
      Object.freeze({
        stableId: 'building:outside-anchor', owner: '10,20',
        position: Object.freeze([168, 0, 336]), objectType: 'building',
      }),
    ]),
  });
  const summary = derivePresentationOwnerCoarseSummary(resource, {
    playerX: -1_000_000,
    playerZ: 1_000_000,
    maximumDistanceMeters: 1,
  });
  assert.equal(summary.ownerKey, '10,20');
  assert.deepEqual(summary.structureStableIds, ['building:inside']);
  assert.deepEqual(summary.selectedForestStableIds, ['tree:inside']);
  assert.equal('forestCoverageFloorStableId' in summary, false);
  assert.equal(summary.canonicalTreeCount, 1);
});

test('PresentationOwner generation is independent of owner enumeration and async completion order', async () => {
  const generator = await createPresentationOwnerGenerator({ worldSeed: seed });
  const coordinates = [[20, 20], [21, 20], [20, 21], [21, 21]];
  const generate = async order => new Map(await Promise.all(order.map(async ([chunkX, chunkZ]) => {
    const result = await generator.generateOwner(chunkX, chunkZ);
    return [`${chunkX},${chunkZ}`, result.resource];
  })));
  const forward = await generate(coordinates);
  const reversed = await generate([...coordinates].reverse());
  const parallel = await generate([coordinates[2], coordinates[0], coordinates[3], coordinates[1]]);
  for (const [key, resource] of forward) {
    assert.deepEqual(reversed.get(key), resource);
    assert.deepEqual(parallel.get(key), resource);
  }
});

test('shared Natural semantic kernel preserves Full Stable ID, owner, position, subtype, and visual identity', async t => {
  const full = await createW8ParityChunkGenerator({ worldSeed: seed });
  try {
    const presentation = await createPresentationOwnerGenerator({
      worldSeed: seed,
      experienceSpawn: full.experienceSpawn,
    });
    let compared = 0;
    for (const [chunkX, chunkZ] of [[20, 20], [30, -30], [10, 10]]) {
      const exact = await full.generateChunk(chunkX, chunkZ);
      assert.equal(exact.settlementReferences.length, 0);
      assert.equal(exact.waterSurfaces.length, 0);
      const result = await presentation.generateOwner(chunkX, chunkZ);
      const presentationById = new Map(result.resource.natural.map(record => [record.stableId, record]));
      const fullNatural = [
        ...exact.presentationLayers.natural.vegetation,
        ...exact.presentationLayers.natural.rocks,
      ];
      assert.deepEqual([...presentationById.keys()].sort(), fullNatural
        .map(record => record.candidateId).sort());
      for (const source of fullNatural) {
        const canonical = resolveW8CanonicalWorldObject(source);
        const compact = presentationById.get(canonical.stableId);
        assert.equal(compact.owner, `${canonical.owner.x},${canonical.owner.z}`);
        assert.deepEqual(compact.position, [
          q6(canonical.position.x),
          q6(canonical.position.y),
          q6(canonical.position.z),
        ]);
        assert.equal(compact.subtype, canonical.subtype);
        assert.equal(compact.rotationY, q6(canonical.rotation.y));
        assert.deepEqual(compact.dimensions, [
          q6(canonical.visualBounds.width),
          q6(canonical.visualBounds.height),
          q6(canonical.visualBounds.depth),
        ]);
        assert.equal(compact.visualKind, canonical.presentation.partSetKey);
        compared += 1;
      }
    }
    t.diagnostic(JSON.stringify({ comparedNaturalObjects: compared, identityMismatch: 0 }));
  } finally {
    await full.shutdown();
  }
});

test('Settlement Tree Y is canonical finalGround in Full, PresentationOwner, and Tree-cell paths', async t => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: seed });
  try {
    const chunkX = 35;
    const chunkZ = 24;
    const full = await generator.generateChunk(chunkX, chunkZ);
    const presentation = await generator.generatePresentationOwner(chunkX, chunkZ);
    const treeCell = await generator.generateCanonicalTreeCell(8, 6);
    const fullTrees = full.presentationLayers.natural.vegetation
      .filter(candidate => candidate.subtype !== 'shrub');
    const sourceById = new Map(full.vegetationCandidates.map(candidate => (
      [candidate.candidateId, candidate]
    )));
    const presentationById = new Map(presentation.resource.natural
      .filter(record => record.objectType === 'tree')
      .map(record => [record.stableId, record]));
    const cellById = new Map(treeCell.trees.map(record => [record.stableId, record]));
    let maximumFormerFloatMeters = 0;

    assert.ok(fullTrees.length > 0, 'the deterministic Settlement fixture must contain a Tree');
    for (const tree of fullTrees) {
      const source = sourceById.get(tree.candidateId);
      const compact = presentationById.get(tree.candidateId);
      const cellTree = cellById.get(tree.candidateId);
      assert.ok(source, `missing formal source Tree ${tree.candidateId}`);
      assert.ok(compact, `missing PresentationOwner Tree ${tree.candidateId}`);
      assert.ok(cellTree, `missing canonical Tree-cell Tree ${tree.candidateId}`);
      const ground = resolveCanonicalGroundSurface({
        chunkData: full,
        worldX: tree.worldPosition.x,
        worldZ: tree.worldPosition.z,
      });
      maximumFormerFloatMeters = Math.max(
        maximumFormerFloatMeters,
        Math.abs(source.worldPosition.y - ground.heightMeters),
      );
      assert.equal(tree.worldPosition.y, ground.heightMeters,
        'Full/Near Tree must use canonical finalGround Y');
      assert.equal(compact.position[1], ground.heightMeters,
        'PresentationOwner Tree must use canonical finalGround Y');
      assert.equal(cellTree.position[1], ground.heightMeters,
        'persistent Tree-cell Tree must use canonical finalGround Y');
    }
    assert.ok(maximumFormerFloatMeters > 0.5,
      'the fixture must expose the former Natural-base-Y floating regression');
    t.diagnostic(JSON.stringify({
      groundedTreeCount: fullTrees.length,
      maximumFormerFloatMeters: q6(maximumFormerFloatMeters),
    }));
  } finally {
    await generator.shutdown();
  }
});

test('pre-resolved sparse Settlement exclusions preserve exact Natural identity without Full generation in the owner path', async () => {
  const full = await createW8ParityChunkGenerator({ worldSeed: seed });
  try {
    const exact = await full.generateChunk(32, 24);
    const exactIds = new Set([
      ...exact.presentationLayers.natural.vegetation,
      ...exact.presentationLayers.natural.rocks,
    ].map(value => value.candidateId));
    const contextBase = {
      settlementReferences: exact.settlementReferences,
      settlementRegionRefs: exact.settlementReferences,
      canonicalSurfacePolicy: exact.canonicalSurfacePolicy,
      structures: exact.settlementFeatures,
    };
    const probe = await createPresentationOwnerGenerator({
      worldSeed: seed,
      experienceSpawn: full.experienceSpawn,
      resolvePresentationContext: async () => contextBase,
    });
    const probed = await probe.generateOwner(32, 24);
    const excludedNaturalStableIds = probed.resource.natural
      .map(value => value.stableId).filter(stableId => !exactIds.has(stableId));
    const presentation = await createPresentationOwnerGenerator({
      worldSeed: seed,
      experienceSpawn: full.experienceSpawn,
      resolvePresentationContext: async () => ({
        ...contextBase,
        excludedNaturalStableIds,
      }),
    });
    const result = await presentation.generateOwner(32, 24);
    assert.deepEqual(result.resource.natural.map(value => value.stableId).sort(), [...exactIds].sort());
    assert.equal(result.resource.structures.length, exact.settlementFeatures.length);
    assert.equal(result.diagnostics.fullSettlementGenerated, false);
  } finally {
    await full.shutdown();
  }
});

test('shared ground kernel matches Full for normal, steep, Settlement, River, boundary, and rebase coordinates', async t => {
  const full = await createW8ParityChunkGenerator({ worldSeed: seed });
  const contexts = new Map();
  try {
    const normal = await full.generateChunk(20, 20);
    const settlement = await full.generateChunk(32, 24);
    const river = await full.generateChunk(0, 0);
    for (const chunk of [normal, settlement, river]) contexts.set(`${chunk.chunkX},${chunk.chunkZ}`, chunk);
    const presentation = await createPresentationOwnerGenerator({
      worldSeed: seed,
      resolvePresentationContext: async ({ ownerKey }) => ({
        canonicalSurfacePolicy: contexts.get(ownerKey)?.canonicalSurfacePolicy ?? null,
      }),
    });
    const road = settlement.settlementFeatures.find(
      feature => feature.featureType === 'settlement-road',
    );
    const building = settlement.settlementFeatures.find(
      feature => feature.featureType === 'settlement-building',
    );
    const roadCenter = {
      x: (road.start.x + road.end.x) / 2,
      z: (road.start.z + road.end.z) / 2,
    };
    const roadLength = Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z);
    const roadEdge = {
      x: roadCenter.x - (road.end.z - road.start.z) / roadLength * road.widthMeters / 2,
      z: roadCenter.z + (road.end.x - road.start.x) / roadLength * road.widthMeters / 2,
    };
    const points = [
      { label: 'normal', chunk: normal, x: 20 * 16 + 5.25, z: 20 * 16 + 7.75 },
      { label: 'steep', chunk: normal, x: 20 * 16 + 12.25, z: 20 * 16 + 2.75 },
      { label: 'cliff', chunk: normal, x: 20 * 16 + 14.75, z: 20 * 16 + 13.25 },
      { label: 'chunk-boundary', chunk: normal, x: 21 * 16 - 1e-7, z: 20 * 16 + 8 },
      { label: 'settlement-center', chunk: settlement,
        x: settlement.canonicalSurfacePolicy.regions[0].center.x,
        z: settlement.canonicalSurfacePolicy.regions[0].center.z },
      { label: 'settlement-edge', chunk: settlement,
        x: settlement.canonicalSurfacePolicy.regions[0].center.x
          + settlement.canonicalSurfacePolicy.regions[0].flatCoreRadiusMeters + 0.25,
        z: settlement.canonicalSurfacePolicy.regions[0].center.z },
      { label: 'road-center', chunk: settlement, ...roadCenter },
      { label: 'road-edge', chunk: settlement, ...roadEdge },
      { label: 'building-lot', chunk: settlement,
        x: building.lot?.centerX ?? building.worldPosition.x,
        z: building.lot?.centerZ ?? building.worldPosition.z },
    ];
    const riverPoint = river.canonicalSurfacePolicy.riverCorridors[0].centerlines[0][0];
    points.push(
      { label: 'river-center', chunk: river, x: riverPoint.x, z: riverPoint.z },
      { label: 'river-bank', chunk: river,
        x: riverPoint.x + river.canonicalSurfacePolicy.riverCorridors[0].widthMeters / 2,
        z: riverPoint.z },
    );
    const generators = new Map();
    for (const point of points) {
      const key = `${point.chunk.chunkX},${point.chunk.chunkZ}`;
      let result = generators.get(key);
      if (!result) {
        result = await presentation.generateOwner(point.chunk.chunkX, point.chunk.chunkZ);
        generators.set(key, result);
      }
      const expected = resolveCanonicalGroundSurface({
        chunkData: point.chunk,
        worldX: point.x,
        worldZ: point.z,
      });
      const actual = result.ground.finalGround(point.x, point.z);
      assert.deepEqual(actual, expected, `${point.label} shared height mismatch`);
      const preRiver = result.ground.settlementGround(point.x, point.z);
      assert.equal(preRiver.heightMeters, expected.baseHeightMeters);
      assert.equal(preRiver.riverDepthMeters, 0);
    }
    const rebaseOffset = { x: 8192, z: -4096 };
    const rebasePoint = points[0];
    const rebaseKernel = generators.get(`${normal.chunkX},${normal.chunkZ}`).ground;
    const logicalFromRender = {
      x: (rebasePoint.x - rebaseOffset.x) + rebaseOffset.x,
      z: (rebasePoint.z - rebaseOffset.z) + rebaseOffset.z,
    };
    assert.deepEqual(
      rebaseKernel.finalGround(logicalFromRender.x, logicalFromRender.z),
      rebaseKernel.finalGround(rebasePoint.x, rebasePoint.z),
    );
    t.diagnostic(JSON.stringify({ coordinateCount: points.length, maximumQ6Difference: 0 }));
  } finally {
    await full.shutdown();
  }
});

test('Presentation structure summary preserves Building and Road projection identity', async t => {
  const full = await createW8ParityChunkGenerator({ worldSeed: seed });
  try {
    const chunk = await full.generateChunk(32, 24);
    const resource = createPresentationOwnerResource({
      worldSeedHash: full.worldSeedHash,
      chunkX: chunk.chunkX,
      chunkZ: chunk.chunkZ,
      structures: chunk.settlementFeatures,
      settlementRegionRefs: chunk.settlementReferences,
    });
    assert.equal(resource.structures.length, chunk.settlementFeatures.length);
    const compactById = new Map(resource.structures.map(value => [value.stableId, value]));
    for (const source of chunk.settlementFeatures) {
      const compact = compactById.get(source.stableId);
      assert.ok(compact);
      assert.equal(compact.owner,
        `${source.owningChunkCoordinate.x},${source.owningChunkCoordinate.z}`);
      assert.deepEqual(compact.position, frozenExpectedPosition(source.worldPosition));
      if (source.featureType === 'settlement-building') {
        assert.equal(compact.objectType, 'building');
        assert.deepEqual(compact.dimensions, [
          source.widthMeters,
          source.heightMeters,
          source.depthMeters,
        ]);
        assert.equal(compact.rotationY, q6(source.rotationY));
      } else {
        assert.equal(compact.objectType, 'road');
        assert.equal(compact.sourceStableId, source.sourceStableId ?? source.stableId);
        assert.equal(compact.dimensions[0], source.widthMeters);
      }
    }
    const summary = derivePresentationOwnerCoarseSummary(resource);
    const requiredStructureIds = resource.structures.filter(record => (
      record.objectType === 'building'
        || (record.objectType === 'road' && record.canonicalMajorRoad === true)
    )).map(record => record.stableId).sort();
    assert.deepEqual(summary.structureStableIds, requiredStructureIds,
      'coarse contract must require Buildings and canonical major Road layout only');
    assert.ok(summary.structureStableIds.every(stableId => compactById.has(stableId)));
    assert.deepEqual(
      derivePresentationOwnerCoarseSummary(resource, {
        playerX: -1_000_000,
        playerZ: 1_000_000,
        maximumDistanceMeters: 1,
      }),
      summary,
      'immutable owner requirements must not freeze an observer-distance snapshot',
    );
    t.diagnostic(JSON.stringify({
      buildingCount: chunk.settlementFeatures.filter(value => value.featureType === 'settlement-building').length,
      roadCount: chunk.settlementFeatures.filter(value => value.featureType === 'settlement-road').length,
      identityMismatch: 0,
    }));
  } finally {
    await full.shutdown();
  }
});

test('production Presentation provider preserves Full Natural and Structure identity without Full generation', async t => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: seed });
  try {
    let naturalCount = 0;
    let structureCount = 0;
    let expectedFullRequests = 0;
    for (const [chunkX, chunkZ] of [[32, 24], [33, 24], [0, 0], [20, 20]]) {
      const presentation = await generator.generatePresentationOwner(chunkX, chunkZ);
      const beforeFull = generator.snapshot().resourceGeneration;
      assert.equal(beforeFull.fullChunkRequests, expectedFullRequests);
      if (chunkX === 32 && chunkZ === 24) {
        assert.equal(beforeFull.fullChunkRequests, 0);
        assert.equal(beforeFull.presentationOwnerRequests, 1);
        assert.equal(beforeFull.presentationOwnerCompleted, 1);
      }
      const full = await generator.generateChunk(chunkX, chunkZ);
      expectedFullRequests += 1;
      const compactNatural = new Map(presentation.resource.natural.map(record => (
        [record.stableId, expandPresentationNaturalRecord(record)]
      )));
      const fullNatural = [
        ...full.presentationLayers.natural.vegetation,
        ...full.presentationLayers.natural.rocks,
      ].map(resolveW8CanonicalWorldObject);
      assert.deepEqual([...compactNatural.keys()].sort(), fullNatural
        .map(record => record.stableId).sort());
      for (const source of fullNatural) {
        const compact = compactNatural.get(source.stableId);
        assert.deepEqual(compact.owner, source.owner);
        assert.deepEqual(compact.position, {
          x: q6(source.position.x),
          y: q6(source.position.y),
          z: q6(source.position.z),
        });
        assert.deepEqual(compact.rotation, { y: q6(source.rotation.y) });
        assert.deepEqual(compact.visualBounds, {
          width: q6(source.visualBounds.width),
          height: q6(source.visualBounds.height),
          depth: q6(source.visualBounds.depth),
        });
        assert.equal(compact.subtype, source.subtype);
        assert.equal(compact.presentation.partSetKey, source.presentation.partSetKey);
        naturalCount += 1;
      }
      const compactStructures = new Map(presentation.resource.structures.map(record => (
        [record.stableId, expandPresentationStructureRecord(record)]
      )));
      assert.deepEqual([...compactStructures.keys()].sort(), full.settlementFeatures
        .map(record => record.stableId).sort());
      for (const source of full.settlementFeatures) {
        const compact = compactStructures.get(source.stableId);
        assert.deepEqual(compact.owningChunkCoordinate, source.owningChunkCoordinate);
        assert.deepEqual(compact.worldPosition, source.worldPosition);
        if (source.featureType === 'settlement-building') {
          assert.equal(compact.rotationY, source.rotationY);
          assert.equal(compact.widthMeters, source.widthMeters);
          assert.equal(compact.heightMeters, source.heightMeters);
          assert.equal(compact.depthMeters, source.depthMeters);
          assert.deepEqual(compact.visual, source.visual);
        } else {
          assert.equal(compact.sourceStableId, source.sourceStableId ?? source.stableId);
          assert.equal(compact.widthMeters, source.widthMeters);
          assert.deepEqual(compact.start, source.start);
          assert.deepEqual(compact.end, source.end);
        }
        structureCount += 1;
      }
      assert.ok(presentation.resource.water.every(record => (
        full.waterSurfaces.some(source => source.stableId === record.stableId)
      )));
      assert.equal(presentation.resource.landmarks.length, full.settlementLandmarks.length);
      const compactLandmarks = new Map(presentation.resource.landmarks.map(record => (
        [record.stableId, expandPresentationAuxiliaryRecord(record)]
      )));
      for (const source of full.settlementLandmarks) {
        const compact = compactLandmarks.get(source.stableId);
        assert.ok(compact);
        assert.equal(compact.parentSettlementId, source.parentSettlementId);
        assert.equal(compact.landmarkType, source.landmarkType);
        assert.deepEqual(compact.worldPosition, source.worldPosition);
        assert.equal(compact.rotationY, source.rotationY);
        assert.deepEqual(compact.owningChunkCoordinate, source.owningChunkCoordinate);
      }
      const compactStreet = new Map(presentation.resource.street.map(record => (
        [record.stableId, expandPresentationAuxiliaryRecord(record)]
      )));
      assert.deepEqual([...compactStreet.keys()].sort(), full.streetDetails
        .map(record => record.stableId).sort());
      for (const source of full.streetDetails) {
        const compact = compactStreet.get(source.stableId);
        assert.equal(compact.parentRoadStableId, source.parentRoadStableId);
        assert.equal(compact.detailType, source.detailType);
        assert.deepEqual(compact.worldPosition, source.worldPosition);
      }
    }
    t.diagnostic(JSON.stringify({
      presentationOwners: 4,
      naturalCount,
      structureCount,
      identityMismatch: 0,
    }));
  } finally {
    await generator.shutdown();
  }
});

function frozenExpectedPosition(position) {
  return [q6(position.x), q6(position.y), q6(position.z)];
}

test('Stage 2 cuts production Natural over to PresentationOwner and keeps Full scoped to runtime', async () => {
  const productionFiles = await Promise.all([
    '../src/infinite-world/chunk-data-service.js',
    '../src/infinite-world/chunk-runtime-manager.js',
    '../src/infinite-world/sandbox-boot.js',
    '../src/infinite-world/static-object-stream.js',
  ].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  const sandbox = productionFiles[2];
  assert.equal(sandbox.includes('workerTransport.generatePresentationOwner'), true);
  assert.equal(sandbox.includes("resourceKind: 'presentation'"), true);
  assert.equal(sandbox.includes("kind !== 'presentation'"), true);
  assert.equal(sandbox.includes('PRESENTATION_OWNER_CACHE_CAPACITY'), true);
  assert.equal(sandbox.includes('residentWorldCoverage.fullView.ownerKeys'), true);
  assert.equal(sandbox.includes('cacheCapacity: 2366'), false);
});

test('production Worker transports compact PresentationOwner without invoking Full Chunk generation', async () => {
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: seed,
    serviceGeneration: 822,
    workerFactory: createNodeChunkGeneratorWorker,
  });
  try {
    await transport.initialize();
    const owner = await transport.generatePresentationOwner({
      chunkX: 0,
      chunkZ: 0,
      consumerId: 'presentation-cutover-fixture',
    });
    assert.equal(owner.schemaVersion, 'w8-presentation-owner-data-1');
    assert.equal(owner.resource.schemaVersion, PRESENTATION_OWNER_SCHEMA);
    assert.equal(validatePresentationOwnerResource(owner.resource).valid, true);
    const snapshot = transport.snapshot();
    assert.equal(snapshot.counts.presentationOwnersGenerated, 1);
    const generatorSnapshot = await transport.requestDiagnostics();
    assert.equal(generatorSnapshot.resourceGeneration.fullChunkRequests, 0);
    assert.equal(generatorSnapshot.resourceGeneration.presentationOwnerCompleted, 1);
  } finally {
    await transport.shutdown();
  }
});

test('shared Inline scheduler namespaces equal Full and Presentation service request sequences', async () => {
  const transport = createInlineChunkGeneratorTransport({
    generator: {
      worldSeed: seed,
      worldSeedHash: 'presentation-inline-namespace',
      generatorVersion: Object.freeze({ major: 8, minor: 0, patch: 0 }),
      generateChunk: async (chunkX, chunkZ) => inlineFakeIdentity(chunkX, chunkZ, 'full'),
      generatePresentationOwner: async (chunkX, chunkZ) => Object.freeze({
        ...inlineFakeIdentity(chunkX, chunkZ, 'presentation'),
        schemaVersion: 'w8-presentation-owner-data-1',
        resource: Object.freeze({ schemaVersion: PRESENTATION_OWNER_SCHEMA }),
      }),
    },
  });
  const scheduler = createWorldGenerationRequestEnvelope({
    requestId: 1,
    operationKind: 'chunk',
    priority: 1,
    required: true,
    createdAtMs: 0,
    consumerId: 'full-service',
    epoch: 0,
  });
  try {
    await transport.initialize();
    const fullPromise = transport.generateChunk({
      requestId: 1,
      chunkX: 0,
      chunkZ: 0,
      scheduler,
    });
    const presentationPromise = transport.generatePresentationOwner({
      chunkX: 1,
      chunkZ: 0,
      scheduler,
    });
    const [full, presentation] = await Promise.all([fullPromise, presentationPromise]);
    assert.equal(full.chunkId, 'full:0,0');
    assert.equal(presentation.chunkId, 'presentation:1,0');
    assert.equal(transport.snapshot().scheduler.counts.failed, 0);
  } finally {
    await transport.shutdown();
  }
});

function inlineFakeIdentity(chunkX, chunkZ, prefix) {
  return Object.freeze({
    chunkX,
    chunkZ,
    chunkId: `${prefix}:${chunkX},${chunkZ}`,
    contentHash: `${prefix}-hash:${chunkX},${chunkZ}`,
  });
}
