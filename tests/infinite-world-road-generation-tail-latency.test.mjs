import assert from 'node:assert/strict';
import test from 'node:test';

import { selectSettlementBuildingType } from '../src/settlement-building-visuals.js';
import { LOGICAL_CHUNK_SIZE_METERS } from '../src/infinite-world/chunk-coordinates.js';
import { hashW5ChunkContent } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import {
  ROAD_GENERATION_COUNTER_ORDER,
  ROAD_GENERATION_SPAN_ORDER,
  ROAD_GENERATION_TIMING_SCHEMA,
  createRoadGenerationTimingRecorder,
} from '../src/infinite-world/road-generation-timing.js';
import {
  CHUNK_GENERATOR_MESSAGE,
  CHUNK_GENERATOR_PROTOCOL_VERSION,
} from '../src/infinite-world/chunk-data-service-protocol.js';
import { createChunkGeneratorWorkerCore } from '../src/infinite-world/chunk-generator-worker-core.js';
import { createNodeChunkGeneratorWorker } from '../src/infinite-world/node-worker-chunk-generator-adapter.js';
import {
  createW8ParityChunkGenerator,
  hashW8ParityChunkContent,
} from '../src/infinite-world/w8-parity-chunk-generator.js';
import {
  createW8SettlementBuildingTypeSelector,
} from '../src/infinite-world/w8-settlement-building-visual-policy.js';
import {
  createWorkerChunkGeneratorTransport,
} from '../src/infinite-world/worker-chunk-generator-transport.js';

const ROAD_HEAVY_OWNER = Object.freeze({ x: 55, z: 77 });
const ROAD_HEAVY_OWNER_KEY = `${ROAD_HEAVY_OWNER.x},${ROAD_HEAVY_OWNER.z}`;
const REPORTED_OWNER = Object.freeze({ x: 160, z: 29 });
const REPORTED_OWNER_CONTENT_HASH =
  'sha256:d3f2838c2b19a1862e55918a12a4d7fcf5fba47f4abe2fd0523cfd213378caab';
const REPORTED_OWNER_PREDECESSOR = Object.freeze({ x: 159, z: 29 });
const REPORTED_OWNER_COMPARISON = Object.freeze({ x: 161, z: 29 });
const ROAD_HEAVY_OWNER_CONTENT_HASH =
  'sha256:9dd3b8a235e2e59ccc143e568b2a3da1eff37906117c08a9f02523789a7f93e0';
const WORLD_SEED = 'KaniNingen Infinite Natural World';
const BUILDING_SELECTOR_INDEX_COUNT = 512;
const CANONICAL_MATRIX_OWNERS = Object.freeze([
  ROAD_HEAVY_OWNER,
  // This owner intersects the same canonical Settlement as ROAD_HEAVY_OWNER,
  // while retaining source Building records. It keeps the regression from
  // proving Road equality with an accidentally empty Building comparison.
  Object.freeze({ x: 58, z: 71 }),
]);
const CANONICAL_MATRIX_SETTLEMENT_ID = 'settlement-v1:7406aeda270ba27e647af7c6';
const CANONICAL_MATRIX_CENTER = Object.freeze({
  x: (ROAD_HEAVY_OWNER.x + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
  z: (ROAD_HEAVY_OWNER.z + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
});
const CANONICAL_RECORD_COLLECTIONS = Object.freeze([
  'vegetationCandidates',
  'rockCandidates',
  'settlementReferences',
  'settlementFeatures',
  'settlementOverlayFeatures',
  'waterSurfaces',
  'ambientDetails',
  'settlementLandmarks',
  'streetDetails',
  'riverRoadCrossings',
  'riverPorts',
]);
let canonicalMatrixServiceGeneration = 20_000;

function metricSummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = fraction => sorted[
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))
  ] ?? 0;
  return Object.freeze({
    samples: sorted.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maximumMs: sorted.at(-1) ?? 0,
  });
}

function canonicalStableIds(chunk) {
  const collect = (source, sourceName) => CANONICAL_RECORD_COLLECTIONS.flatMap(name => (
    (source?.[name] ?? []).map(record => Object.freeze({
      collection: `${sourceName}.${name}`,
      stableId: record.stableId ?? record.candidateId ?? record.settlementId ?? null,
    }))
  ));
  return Object.freeze([
    ...collect(chunk, 'w8'),
    ...collect(chunk.sourceChunkData, 'w5'),
  ].filter(record => typeof record.stableId === 'string')
    .sort((left, right) => (
      left.collection.localeCompare(right.collection)
        || left.stableId.localeCompare(right.stableId)
    )));
}

function canonicalFeatureRecords(chunk, predicate) {
  return Object.freeze([
    ...(chunk.settlementFeatures ?? []),
    ...(chunk.settlementOverlayFeatures ?? []),
    ...(chunk.sourceChunkData?.settlementFeatures ?? []),
  ].filter(predicate).sort((left, right) => left.stableId.localeCompare(right.stableId)));
}

function canonicalRoadRecords(chunk) {
  return canonicalFeatureRecords(chunk, feature => (
    feature.canonicalMajorRoad === true || feature.featureType === 'settlement-road'
  ));
}

function canonicalBuildingRecords(chunk) {
  return canonicalFeatureRecords(chunk, feature => (
    feature.featureType === 'building'
      || feature.featureType === 'settlement-building'
      || String(feature.schemaVersion ?? '').includes('building')
  ));
}

function canonicalSettlementMetadata(chunk) {
  return Object.freeze([
    ...(chunk.settlementReferences ?? []),
    ...(chunk.sourceChunkData?.settlementReferences ?? []),
  ].sort((left, right) => left.stableId.localeCompare(right.stableId)));
}

function canonicalPresentationOwnerWitness(owner) {
  return Object.freeze({
    schemaVersion: owner.schemaVersion,
    chunkId: owner.chunkId,
    contentHash: owner.contentHash,
    chunkX: owner.chunkX,
    chunkZ: owner.chunkZ,
    resource: owner.resource,
    canonicalSurfacePolicy: owner.canonicalSurfacePolicy,
    riverProjection: owner.riverProjection,
  });
}

function assertFiniteSettlementReferences(chunk, label) {
  for (const [scope, references] of [
    ['W8', chunk.settlementReferences ?? []],
    ['W5', chunk.sourceChunkData?.settlementReferences ?? []],
  ]) {
    for (const reference of references) {
      assert.equal(typeof reference.settlementId, 'string',
        `${label} ${scope} Settlement reference requires an ID`);
      for (const [name, value] of [
        ['macroRegion.x', reference.macroRegion?.x],
        ['macroRegion.z', reference.macroRegion?.z],
        ['center.x', reference.center?.x],
        ['center.z', reference.center?.z],
        ['radiusMeters', reference.radiusMeters],
        ['urbanization', reference.urbanization],
        ['terrainSuitability', reference.terrainSuitability],
      ]) {
        assert.ok(Number.isFinite(value),
          `${label} ${scope} ${reference.settlementId} has non-finite ${name}`);
      }
    }
  }
}

function assertFiniteSettlementCandidate(
  candidate,
  expectedSettlementId = CANONICAL_MATRIX_SETTLEMENT_ID,
) {
  assert.ok(candidate, 'the canonical order fixture Settlement must exist');
  if (expectedSettlementId !== null) {
    assert.equal(candidate.settlementId, expectedSettlementId);
  }
  for (const [name, value] of [
    ['center.x', candidate.center?.x],
    ['center.z', candidate.center?.z],
    ['radiusMeters', candidate.radiusMeters],
    ['urbanization', candidate.urbanization],
    ['terrainSuitability', candidate.terrainSuitability],
  ]) {
    assert.ok(Number.isFinite(value), `${candidate.settlementId} has non-finite ${name}`);
  }
}

async function assertCanonicalChunkEquality(actual, expected, label) {
  assertFiniteSettlementReferences(actual, `${label} actual`);
  assertFiniteSettlementReferences(expected, `${label} expected`);
  assert.equal(actual.chunkX, expected.chunkX, `${label} owner X drifted`);
  assert.equal(actual.chunkZ, expected.chunkZ, `${label} owner Z drifted`);
  assert.equal(actual.chunkId, expected.chunkId, `${label} canonical Chunk ID drifted`);
  assert.equal(actual.contentHash, expected.contentHash, `${label} content hash drifted`);
  assert.equal(
    actual.sourceW5ContentHash,
    expected.sourceW5ContentHash,
    `${label} source W5 hash drifted`,
  );
  assert.equal(await hashW8ParityChunkContent(actual), actual.contentHash,
    `${label} W8 content hash is not reproducible`);
  assert.equal(await hashW5ChunkContent(actual.sourceChunkData), actual.sourceW5ContentHash,
    `${label} source W5 content hash is not reproducible`);
  assert.deepEqual(canonicalStableIds(actual), canonicalStableIds(expected),
    `${label} Stable IDs drifted`);
  assert.deepEqual(canonicalSettlementMetadata(actual), canonicalSettlementMetadata(expected),
    `${label} Settlement metadata drifted`);
  assert.deepEqual(canonicalRoadRecords(actual), canonicalRoadRecords(expected),
    `${label} canonical Roads or their XYZ/Y drifted`);
  assert.deepEqual(canonicalBuildingRecords(actual), canonicalBuildingRecords(expected),
    `${label} Buildings or their XYZ/Y drifted`);
  assert.deepEqual(actual.terrain, expected.terrain, `${label} canonical Terrain Y drifted`);
  assert.deepEqual(actual.sourceChunkData.terrain, expected.sourceChunkData.terrain,
    `${label} source Terrain Y drifted`);
  // Full equality is intentional: it covers every canonical position-bearing
  // record, not only the named regression witnesses above.
  assert.deepEqual(actual, expected, `${label} complete canonical ChunkData drifted`);
}

async function createCanonicalWorkerHarness() {
  const serviceGeneration = canonicalMatrixServiceGeneration;
  canonicalMatrixServiceGeneration += 1;
  const transport = createWorkerChunkGeneratorTransport({
    worldSeed: WORLD_SEED,
    serviceGeneration,
    workerFactory: createNodeChunkGeneratorWorker,
  });
  let requestId = serviceGeneration * 10_000;
  await transport.initialize();
  return Object.freeze({
    transport,
    generateChunk: owner => transport.generateChunk({
      requestId: requestId += 1,
      chunkX: owner.x,
      chunkZ: owner.z,
    }),
    generatePresentationOwner: owner => transport.generatePresentationOwner({
      chunkX: owner.x,
      chunkZ: owner.z,
    }),
    generateForestHorizonManifest: owner => transport.generateForestHorizonManifest({
      chunkX: owner.x,
      chunkZ: owner.z,
      consumerId: `p0-canonical-eviction-${serviceGeneration}`,
      epoch: 1,
    }),
    findTargetCandidate: async () => {
      const candidates = await transport.findSettlementsNear(
        CANONICAL_MATRIX_CENTER.x,
        CANONICAL_MATRIX_CENTER.z,
        0,
      );
      const candidate = candidates.find(value => (
        value.settlementId === CANONICAL_MATRIX_SETTLEMENT_ID
      ));
      assertFiniteSettlementCandidate(candidate);
      return candidate;
    },
    findSettlementsNear: (centerWorldX, centerWorldZ, radiusMeters = 0) => (
      transport.findSettlementsNear(centerWorldX, centerWorldZ, radiusMeters)
    ),
    resolveTemplate: candidate => transport.resolveSettlementPresentationTemplate({ candidate }),
    resolveTargetTemplate: candidate => transport.resolveSettlementPresentationTemplate({
      candidate,
    }),
    resolveCoverage: async () => {
      const coverage = await transport.resolveCanonicalMajorRoadOwnerCoverage({
        centerWorldX: CANONICAL_MATRIX_CENTER.x,
        centerWorldZ: CANONICAL_MATRIX_CENTER.z,
        radiusMeters: 0,
      });
      assert.ok(coverage.roadCount > 0,
        'the order regression query must resolve canonical MAJOR Roads');
      return coverage;
    },
    requestDiagnostics: () => transport.requestDiagnostics(),
    snapshot: () => transport.snapshot(),
    shutdown: () => transport.shutdown(),
  });
}

async function generateCanonicalBundle(
  harness,
  owners = CANONICAL_MATRIX_OWNERS,
  { template = null } = {},
) {
  const chunkTimes = [];
  const chunks = [];
  for (const owner of owners) {
    const startedAt = performance.now();
    chunks.push(await harness.generateChunk(owner));
    chunkTimes.push(performance.now() - startedAt);
  }
  const presentationOwners = [];
  for (const owner of CANONICAL_MATRIX_OWNERS) {
    presentationOwners.push(await harness.generatePresentationOwner(owner));
  }
  const resolvedTemplate = template ?? await harness.resolveTargetTemplate(
    await harness.findTargetCandidate(),
  );
  const chunksByOwner = new Map(chunks.map(chunk => [`${chunk.chunkX},${chunk.chunkZ}`, chunk]));
  return Object.freeze({
    chunks: Object.freeze(CANONICAL_MATRIX_OWNERS.map(owner => (
      chunksByOwner.get(`${owner.x},${owner.z}`)
    ))),
    presentationOwners: Object.freeze(presentationOwners),
    template: resolvedTemplate,
    chunkTimes: Object.freeze(chunkTimes),
  });
}

async function assertCanonicalBundleEquality(actual, expected, label) {
  assert.equal(actual.chunks.length, expected.chunks.length);
  for (let index = 0; index < expected.chunks.length; index += 1) {
    await assertCanonicalChunkEquality(
      actual.chunks[index],
      expected.chunks[index],
      `${label} owner ${expected.chunks[index].chunkX},${expected.chunks[index].chunkZ}`,
    );
  }
  assert.deepEqual(
    actual.presentationOwners.map(canonicalPresentationOwnerWitness),
    expected.presentationOwners.map(canonicalPresentationOwnerWitness),
    `${label} PresentationOwner identity/resource drifted`);
  assert.deepEqual(actual.template, expected.template,
    `${label} complete Settlement template drifted`);
}

test('P0 real Node Worker request orders preserve one complete canonical World', {
  timeout: 600_000,
}, async t => {
  const benchmarkRows = [];
  let evictionBenchmark = null;

  const runIsolated = async (label, operation) => {
    const harness = await createCanonicalWorkerHarness();
    const startedAt = performance.now();
    try {
      const bundle = await operation(harness);
      const operationWallMs = performance.now() - startedAt;
      const diagnostics = await harness.requestDiagnostics();
      const transport = harness.snapshot();
      assert.equal(transport.kind, 'worker');
      assert.equal(transport.mode, 'worker');
      assert.equal(transport.fallbackOccurred, false,
        `${label} must use the real Node Worker rather than inline fallback`);
      assert.equal(transport.pendingCount, 0);
      benchmarkRows.push(Object.freeze({
        label,
        operationWallMs,
        chunk: metricSummary(bundle.chunkTimes),
        ...(bundle.warmChunkTimes
          ? { warmChunk: metricSummary(bundle.warmChunkTimes) }
          : {}),
        workerGenerationP50Ms: transport.generationMsP50,
        workerGenerationMaximumMs: transport.generationMsMaximum,
        workerSettlementTemplateP50Ms: transport.settlementTemplateMsP50,
        workerSettlementTemplateMaximumMs: transport.settlementTemplateMsMaximum,
        workerRoadCoverageP50Ms: transport.canonicalMajorRoadOwnerQueryMsP50,
        workerRoadCoverageMaximumMs: transport.canonicalMajorRoadOwnerQueryMsMaximum,
      }));
      return Object.freeze({ bundle, diagnostics });
    } finally {
      // Every scenario owns a fresh process so no request-order state leaks
      // into the next case, and a failed assertion cannot strand a Worker.
      await harness.shutdown();
    }
  };

  const fresh = await runIsolated('fresh', async harness => {
    const bundle = await generateCanonicalBundle(harness);
    const warmChunks = [];
    const warmChunkTimes = [];
    for (const owner of CANONICAL_MATRIX_OWNERS) {
      const startedAt = performance.now();
      warmChunks.push(await harness.generateChunk(owner));
      warmChunkTimes.push(performance.now() - startedAt);
    }
    return Object.freeze({
      ...bundle,
      warmChunks: Object.freeze(warmChunks),
      warmChunkTimes: Object.freeze(warmChunkTimes),
    });
  });
  const canonical = fresh.bundle;
  assert.ok(canonicalRoadRecords(canonical.chunks[0]).length > 0,
    'the Road owner must provide a non-empty canonical Road witness');
  assert.ok(canonicalBuildingRecords(canonical.chunks[1]).length > 0,
    'the Settlement owner must provide a non-empty canonical Building witness');
  for (let index = 0; index < canonical.chunks.length; index += 1) {
    await assertCanonicalChunkEquality(
      canonical.warmChunks[index],
      canonical.chunks[index],
      `fresh warm revisit ${index}`,
    );
  }

  const coverageFirst = await runIsolated('coverage-first', async harness => {
    await harness.resolveCoverage();
    return generateCanonicalBundle(harness);
  });
  await assertCanonicalBundleEquality(coverageFirst.bundle, canonical, 'coverage-first');

  const templateFirst = await runIsolated('template-first', async harness => {
    const candidate = await harness.findTargetCandidate();
    const template = await harness.resolveTargetTemplate(candidate);
    return generateCanonicalBundle(harness, CANONICAL_MATRIX_OWNERS, { template });
  });
  await assertCanonicalBundleEquality(templateFirst.bundle, canonical, 'template-first');

  const presentationFirst = await runIsolated('PresentationOwner-first', async harness => {
    for (const owner of CANONICAL_MATRIX_OWNERS) {
      await harness.generatePresentationOwner(owner);
    }
    return generateCanonicalBundle(harness);
  });
  await assertCanonicalBundleEquality(
    presentationFirst.bundle,
    canonical,
    'PresentationOwner-first',
  );

  for (let iteration = 1; iteration <= 3; iteration += 1) {
    const parallel = await runIsolated(`parallel-${iteration}`, async harness => {
      const candidate = await harness.findTargetCandidate();
      const chunkStartedAt = CANONICAL_MATRIX_OWNERS.map(() => performance.now());
      // Call order deliberately gives coverage a head start in the message
      // queue while all canonical consumers remain outstanding together.
      const coveragePromise = harness.resolveCoverage();
      const templatePromise = harness.resolveTargetTemplate(candidate);
      const chunkPromises = CANONICAL_MATRIX_OWNERS.map(owner => harness.generateChunk(owner));
      const presentationPromises = CANONICAL_MATRIX_OWNERS
        .map(owner => harness.generatePresentationOwner(owner));
      const [chunks, presentationOwners, , template] = await Promise.all([
        Promise.all(chunkPromises),
        Promise.all(presentationPromises),
        coveragePromise,
        templatePromise,
      ]);
      return Object.freeze({
        chunks: Object.freeze(chunks),
        presentationOwners: Object.freeze(presentationOwners),
        template,
        chunkTimes: Object.freeze(chunkStartedAt.map(startedAt => (
          performance.now() - startedAt
        ))),
      });
    });
    await assertCanonicalBundleEquality(parallel.bundle, canonical, `parallel-${iteration}`);
  }

  const reverse = await runIsolated('reverse', async harness => {
    for (const owner of [...CANONICAL_MATRIX_OWNERS].reverse()) {
      await harness.generatePresentationOwner(owner);
    }
    const candidate = await harness.findTargetCandidate();
    const template = await harness.resolveTargetTemplate(candidate);
    await harness.resolveCoverage();
    return generateCanonicalBundle(
      harness,
      [...CANONICAL_MATRIX_OWNERS].reverse(),
      { template },
    );
  });
  await assertCanonicalBundleEquality(reverse.bundle, canonical, 'reverse');

  const eviction = await runIsolated('cache-eviction-revisit', async harness => {
    const targetCandidate = await harness.findTargetCandidate();
    const firstTemplate = await harness.resolveTargetTemplate(targetCandidate);
    const beforeEvictionBundle = await generateCanonicalBundle(
      harness,
      CANONICAL_MATRIX_OWNERS,
      { template: firstTemplate },
    );
    const afterTarget = await harness.requestDiagnostics();
    const requiredDistinctTemplates = Math.max(
      afterTarget.settlementOverlayCacheCapacity,
      afterTarget.source.templateCacheCapacity,
    );
    assert.ok(requiredDistinctTemplates >= 128,
      'the real Worker eviction case must exercise the production cache capacity');

    const seenSettlementIds = new Set([targetCandidate.settlementId]);
    const queryTimes = [];
    const templateTimes = [];
    let churnedTemplateCount = 0;
    for (let probe = 0;
      churnedTemplateCount < requiredDistinctTemplates
        && probe < requiredDistinctTemplates * 4;
      probe += 1) {
      // Probe distinct, widely separated Macro Regions through public Worker
      // requests. No test-only cache capacity or invalidation hook is used.
      const regionX = 10 + (probe % 16) * 3;
      const regionZ = 10 + Math.floor(probe / 16) * 3;
      const queryStartedAt = performance.now();
      const candidates = await harness.findSettlementsNear(
        regionX * 768 + 384,
        regionZ * 768 + 384,
        0,
      );
      queryTimes.push(performance.now() - queryStartedAt);
      for (const candidate of candidates) {
        if (churnedTemplateCount >= requiredDistinctTemplates) break;
        if (seenSettlementIds.has(candidate.settlementId)) continue;
        assertFiniteSettlementCandidate(candidate, null);
        seenSettlementIds.add(candidate.settlementId);
        const templateStartedAt = performance.now();
        await harness.resolveTemplate(candidate);
        templateTimes.push(performance.now() - templateStartedAt);
        churnedTemplateCount += 1;
      }
    }
    assert.equal(churnedTemplateCount, requiredDistinctTemplates,
      'the real Worker must materialize enough distinct templates to evict the target');

    const afterChurn = await harness.requestDiagnostics();
    assert.equal(afterChurn.settlementOverlayCacheSize,
      afterChurn.settlementOverlayCacheCapacity);
    assert.ok(afterChurn.settlementOverlayCacheEvictionCount
      > afterTarget.settlementOverlayCacheEvictionCount,
    'the target revisit must be preceded by an actual production overlay-cache eviction');
    assert.equal(afterChurn.source.templateCacheSize, afterChurn.source.templateCacheCapacity);
    assert.ok(afterChurn.source.templateCacheMisses
      >= afterTarget.source.templateCacheMisses + requiredDistinctTemplates,
    'the source cache must materialize the distinct eviction templates');

    const overlayMissesBeforeRevisit =
      afterChurn.canonicalMajorRoad.settlementTemplateCacheMisses;
    const sourceMissesBeforeRevisit = afterChurn.source.templateCacheMisses;
    const revisitStartedAt = performance.now();
    const revisitedTemplate = await harness.resolveTargetTemplate(targetCandidate);
    const revisitTemplateMs = performance.now() - revisitStartedAt;
    assert.deepEqual(revisitedTemplate, firstTemplate,
      'evicted Settlement template must rematerialize identically');
    const afterRevisit = await harness.requestDiagnostics();
    assert.equal(
      afterRevisit.canonicalMajorRoad.settlementTemplateCacheMisses,
      overlayMissesBeforeRevisit + 1,
      'the revisited W8 template must be an overlay-cache miss',
    );
    assert.equal(afterRevisit.source.templateCacheMisses, sourceMissesBeforeRevisit + 1,
      'the revisited source template must be a source-cache miss');

    const manifestCapacity = afterRevisit.presentationManifestCache.capacity;
    const manifestChurnCount = manifestCapacity + 1;
    const manifestTimes = [];
    for (let index = 0; index < manifestChurnCount; index += 1) {
      const startedAt = performance.now();
      const manifest = await harness.generateForestHorizonManifest({
        x: 1_000 + index,
        z: 2_000,
      });
      manifestTimes.push(performance.now() - startedAt);
      assert.ok(manifest?.contentHash,
        `Forest Horizon churn owner ${index} must return a canonical manifest`);
    }
    const afterOwnerChurn = await harness.requestDiagnostics();
    assert.ok(afterOwnerChurn.canonicalOwnerCache.counts.evictions
      > afterRevisit.canonicalOwnerCache.counts.evictions,
    'Forest Horizon churn must evict settled canonical owners');
    assert.ok(afterOwnerChurn.presentationManifestCache.counts.evictions
      > afterRevisit.presentationManifestCache.counts.evictions,
    'Forest Horizon churn must evict settled presentation manifests');
    assert.equal(afterOwnerChurn.canonicalOwnerCache.size,
      afterOwnerChurn.canonicalOwnerCache.capacity);
    assert.equal(afterOwnerChurn.presentationManifestCache.size,
      afterOwnerChurn.presentationManifestCache.capacity);

    const canonicalLoadsBeforeOwnerRevisit = afterOwnerChurn.canonicalOwnerCache.counts.loads;
    const manifestBuildsBeforeOwnerRevisit =
      afterOwnerChurn.presentationManifestCache.counts.builds;
    const afterEvictionBundle = await generateCanonicalBundle(
      harness,
      CANONICAL_MATRIX_OWNERS,
      { template: revisitedTemplate },
    );
    const afterOwnerRevisit = await harness.requestDiagnostics();
    assert.ok(afterOwnerRevisit.canonicalOwnerCache.counts.loads
      >= canonicalLoadsBeforeOwnerRevisit + CANONICAL_MATRIX_OWNERS.length,
    'target owners must be loaded again after actual canonical-owner eviction');
    assert.ok(afterOwnerRevisit.presentationManifestCache.counts.builds
      >= manifestBuildsBeforeOwnerRevisit + CANONICAL_MATRIX_OWNERS.length,
    'target Full manifests must be built again after actual manifest eviction');

    evictionBenchmark = Object.freeze({
      productionCapacity: requiredDistinctTemplates,
      churnedTemplateCount,
      query: metricSummary(queryTimes),
      template: metricSummary(templateTimes),
      revisitTemplateMs,
      overlayEvictions: afterRevisit.settlementOverlayCacheEvictionCount
        - afterTarget.settlementOverlayCacheEvictionCount,
      sourceMisses: afterRevisit.source.templateCacheMisses
        - afterTarget.source.templateCacheMisses,
      manifestChurnCount,
      forestHorizonManifest: metricSummary(manifestTimes),
      canonicalOwnerEvictions: afterOwnerChurn.canonicalOwnerCache.counts.evictions
        - afterRevisit.canonicalOwnerCache.counts.evictions,
      presentationManifestEvictions:
        afterOwnerChurn.presentationManifestCache.counts.evictions
          - afterRevisit.presentationManifestCache.counts.evictions,
      canonicalOwnerReloads: afterOwnerRevisit.canonicalOwnerCache.counts.loads
        - canonicalLoadsBeforeOwnerRevisit,
      presentationManifestRebuilds:
        afterOwnerRevisit.presentationManifestCache.counts.builds
          - manifestBuildsBeforeOwnerRevisit,
    });
    return Object.freeze({
      ...afterEvictionBundle,
      beforeEvictionBundle,
    });
  });
  await assertCanonicalBundleEquality(
    eviction.bundle.beforeEvictionBundle,
    canonical,
    'before cache eviction',
  );
  await assertCanonicalBundleEquality(eviction.bundle, canonical, 'cache eviction/revisit');

  t.diagnostic(JSON.stringify({
    schemaVersion: 'p0-canonical-request-order-worker-benchmark-1',
    worldSeed: WORLD_SEED,
    owners: CANONICAL_MATRIX_OWNERS,
    canonicalHashes: canonical.chunks.map(chunk => Object.freeze({
      owner: `${chunk.chunkX},${chunk.chunkZ}`,
      contentHash: chunk.contentHash,
      sourceW5ContentHash: chunk.sourceW5ContentHash,
    })),
    scenarios: benchmarkRows,
    eviction: evictionBenchmark,
  }));
});

function nonMonotonicIndices(count) {
  // 173 is coprime with 512, so this is a deterministic permutation rather
  // than a sequential cache-fill order.
  return Object.freeze(Array.from({ length: count }, (_, offset) => (
    (offset * 173) % count + 1
  )));
}

function roadTimingContext() {
  const recorder = createRoadGenerationTimingRecorder();
  return {
    recorder,
    deadlineAtMs: null,
    deadlineMissAtStart: false,
    cold: false,
    run: null,
    completedRun: null,
  };
}

function canonicalMajorRoadFeatures(chunk) {
  return chunk.settlementFeatures.filter(feature => feature.canonicalMajorRoad === true);
}

function assertRoadTimingSnapshot(snapshot, owner = ROAD_HEAVY_OWNER) {
  assert.ok(snapshot);
  assert.equal(snapshot.schemaVersion, ROAD_GENERATION_TIMING_SCHEMA);
  assert.equal(snapshot.ownerKey, `${owner.x},${owner.z}`);
  assert.deepEqual(snapshot.owner, owner);
  assert.equal(snapshot.status, 'completed');
  assert.equal(typeof snapshot.cold, 'boolean');
  assert.equal(typeof snapshot.deadlineMiss, 'boolean');
  assert.ok(Number.isFinite(snapshot.roadTotalMs));
  assert.ok(snapshot.roadTotalMs >= 0);
  assert.equal(typeof snapshot.cache.hits, 'number');
  assert.equal(typeof snapshot.cache.misses, 'number');
  assert.ok(Array.isArray(snapshot.settlementTypes));

  let partitionedTotalMs = 0;
  for (const span of ROAD_GENERATION_SPAN_ORDER) {
    const timing = snapshot.spans[span];
    assert.ok(timing, `missing Road timing span: ${span}`);
    assert.ok(Number.isFinite(timing.durationMs), `${span} has invalid duration`);
    assert.ok(Number.isSafeInteger(timing.callCount), `${span} has invalid call count`);
    assert.ok(timing.durationMs >= 0);
    assert.ok(timing.callCount >= 0);
    partitionedTotalMs += timing.durationMs;
  }
  assert.ok(Math.abs(partitionedTotalMs - snapshot.roadTotalMs) < 0.000001);

  for (const counter of ROAD_GENERATION_COUNTER_ORDER) {
    assert.ok(Number.isSafeInteger(snapshot.counters[counter]), `missing counter: ${counter}`);
    assert.ok(snapshot.counters[counter] >= 0);
  }
  assert.ok(Object.keys(snapshot.functionTimings).length > 0);
  for (const timing of Object.values(snapshot.functionTimings)) {
    assert.ok(Number.isFinite(timing.totalMs));
    assert.ok(Number.isFinite(timing.p50Ms));
    assert.ok(Number.isFinite(timing.p95Ms));
    assert.ok(Number.isFinite(timing.maxMs));
    assert.ok(Number.isSafeInteger(timing.callCount));
  }
}

function createPipelineCollector() {
  const events = [];
  const waiters = new Set();
  const onPipelineEvent = (type, details) => {
    const event = Object.freeze({ type, ...details });
    events.push(event);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve(event);
    }
  };
  const waitFor = (predicate, timeoutMs = 30_000) => {
    const recorded = events.find(predicate);
    if (recorded) return Promise.resolve(recorded);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error('timed out waiting for Worker Road diagnostic event'));
        }, timeoutMs),
      };
      waiters.add(waiter);
    });
  };
  return Object.freeze({ events, onPipelineEvent, waitFor });
}

async function generateWorkerChunk({
  transport,
  collector = null,
  requestId,
  owner = ROAD_HEAVY_OWNER,
}) {
  const chunk = await transport.generateChunk({
    requestId,
    chunkX: owner.x,
    chunkZ: owner.z,
  });
  const stageEvent = collector ? await collector.waitFor(event => (
    event.type === 'worker-chunk-stages' && event.requestId === requestId
  )) : null;
  return Object.freeze({ chunk, stageEvent });
}

test('reported owner has isolated, repeated, adjacent-order, and comparison-owner Worker reproduction coverage', {
  timeout: 90_000,
}, async () => {
  const isolatedCollector = createPipelineCollector();
  const isolatedTransport = createWorkerChunkGeneratorTransport({
    worldSeed: WORLD_SEED,
    serviceGeneration: 160,
    workerFactory: createNodeChunkGeneratorWorker,
    onPipelineEvent: isolatedCollector.onPipelineEvent,
  });
  const orderedCollector = createPipelineCollector();
  const orderedTransport = createWorkerChunkGeneratorTransport({
    worldSeed: WORLD_SEED,
    serviceGeneration: 161,
    workerFactory: createNodeChunkGeneratorWorker,
    onPipelineEvent: orderedCollector.onPipelineEvent,
  });
  try {
    await Promise.all([isolatedTransport.initialize(), orderedTransport.initialize()]);

    const isolated = await generateWorkerChunk({
      transport: isolatedTransport,
      collector: isolatedCollector,
      requestId: 16001,
      owner: REPORTED_OWNER,
    });
    assert.equal(isolated.chunk.contentHash, REPORTED_OWNER_CONTENT_HASH);
    assertRoadTimingSnapshot(isolated.stageEvent.roadTiming, REPORTED_OWNER);
    assert.equal(isolated.stageEvent.roadTimingSummary.runCount, 1);

    const repeated = [];
    for (const requestId of [16002, 16003, 16004]) {
      repeated.push(await generateWorkerChunk({
        transport: isolatedTransport,
        collector: isolatedCollector,
        requestId,
        owner: REPORTED_OWNER,
      }));
    }
    for (const result of repeated) {
      assert.equal(result.chunk.contentHash, REPORTED_OWNER_CONTENT_HASH);
      assert.equal(result.stageEvent.roadTiming, null,
        'canonical owner cache must avoid rebuilding Road work on a warm repeat');
      assert.equal(result.stageEvent.roadTimingSummary.runCount, 1);
    }

    await generateWorkerChunk({
      transport: orderedTransport,
      collector: orderedCollector,
      requestId: 16101,
      owner: REPORTED_OWNER_PREDECESSOR,
    });
    const ordered = await generateWorkerChunk({
      transport: orderedTransport,
      collector: orderedCollector,
      requestId: 16102,
      owner: REPORTED_OWNER,
    });
    const comparison = await generateWorkerChunk({
      transport: isolatedTransport,
      collector: isolatedCollector,
      requestId: 16005,
      owner: REPORTED_OWNER_COMPARISON,
    });
    assert.equal(ordered.chunk.contentHash, REPORTED_OWNER_CONTENT_HASH);
    assert.notEqual(comparison.chunk.chunkId, isolated.chunk.chunkId);
    assert.ok(comparison.stageEvent.roadTimingSummary.runCount >= 2);
  } finally {
    await Promise.all([isolatedTransport.shutdown(), orderedTransport.shutdown()]);
  }
});

test('W8 cached building type selection is exactly parity-safe for 512 non-monotonic lookups', () => {
  const lookupOrder = nonMonotonicIndices(BUILDING_SELECTOR_INDEX_COUNT);
  assert.notDeepEqual(lookupOrder, Array.from({ length: BUILDING_SELECTOR_INDEX_COUNT },
    (_, index) => index + 1));

  for (const settlementType of ['CITY', 'TOWN', 'RURAL']) {
    const townId = `road-tail-latency-${settlementType.toLowerCase()}`;
    const cached = createW8SettlementBuildingTypeSelector({ settlementType, townId });
    const protectedTypes = new Map(lookupOrder.map(buildingIndex => [
      buildingIndex,
      selectSettlementBuildingType({ settlementType, townId, buildingIndex }),
    ]));
    for (const buildingIndex of lookupOrder) {
      assert.equal(
        cached(buildingIndex),
        protectedTypes.get(buildingIndex),
        `${settlementType} cached index ${buildingIndex} drifted from protected selection`,
      );
    }
    for (const buildingIndex of [...lookupOrder].reverse()) {
      assert.equal(
        cached(buildingIndex),
        protectedTypes.get(buildingIndex),
        `${settlementType} repeated cached index ${buildingIndex} drifted`,
      );
    }
  }
});

test('W8 Road diagnostics preserve the road-heavy canonical output with diagnostics on and off', {
  timeout: 60_000,
}, async () => {
  const [diagnosticGenerator, baselineGenerator] = await Promise.all([
    createW8ParityChunkGenerator({ worldSeed: WORLD_SEED }),
    createW8ParityChunkGenerator({ worldSeed: WORLD_SEED }),
  ]);
  try {
    const timingContext = roadTimingContext();
    const diagnosticChunk = await diagnosticGenerator.generateChunk(
      ROAD_HEAVY_OWNER.x,
      ROAD_HEAVY_OWNER.z,
      { roadTimingContext: timingContext },
    );
    const baselineChunk = await baselineGenerator.generateChunk(
      ROAD_HEAVY_OWNER.x,
      ROAD_HEAVY_OWNER.z,
    );

    assert.equal(diagnosticChunk.contentHash, ROAD_HEAVY_OWNER_CONTENT_HASH);
    assert.equal(baselineChunk.contentHash, ROAD_HEAVY_OWNER_CONTENT_HASH);
    assert.equal(diagnosticChunk.contentHash, baselineChunk.contentHash);
    assert.equal(diagnosticChunk.chunkId, baselineChunk.chunkId);
    assert.equal(await hashW8ParityChunkContent(diagnosticChunk), diagnosticChunk.contentHash);
    assert.equal(await hashW8ParityChunkContent(baselineChunk), baselineChunk.contentHash);

    const diagnosticRoads = canonicalMajorRoadFeatures(diagnosticChunk);
    const baselineRoads = canonicalMajorRoadFeatures(baselineChunk);
    assert.ok(diagnosticRoads.length > 0, 'the Road-heavy fixture must include projected Roads');
    assert.deepEqual(
      diagnosticRoads.map(feature => feature.stableId),
      baselineRoads.map(feature => feature.stableId),
    );
    // Full feature equality includes route geometry, portals, frontage handoff,
    // owner metadata, and each canonical Road stable ID.
    assert.deepEqual(diagnosticRoads, baselineRoads);
    assert.deepEqual(diagnosticChunk.riverRoadCrossings, baselineChunk.riverRoadCrossings);

    assertRoadTimingSnapshot(timingContext.completedRun);
    const timingSummary = timingContext.recorder.snapshot();
    assert.equal(timingSummary.runCount, 1);
    assert.equal(timingSummary.topRuns.length, 1);
    assert.deepEqual(timingSummary.topRuns[0], timingContext.completedRun);
  } finally {
    await Promise.all([diagnosticGenerator.shutdown(), baselineGenerator.shutdown()]);
  }
});

test('Worker core creates Road timing only for an explicit diagnostics request', async () => {
  const responses = [];
  const generationOptions = [];
  const generator = {
    worldSeed: WORLD_SEED,
    worldSeedHash: `sha256:${'a'.repeat(64)}`,
    generatorVersion: { major: 800, minor: 0, patch: 0 },
    experienceSpawn: { x: 0, z: 0 },
    reviewSpawn: { x: 0, z: 0 },
    distributor: { findSettlementsNear: async () => [] },
    async generateChunk(chunkX, chunkZ, options) {
      generationOptions.push(options);
      return {
        chunkId: `chunk:${chunkX}:${chunkZ}`,
        contentHash: `sha256:${'b'.repeat(64)}`,
      };
    },
  };
  const core = createChunkGeneratorWorkerCore({
    postMessage: message => responses.push(message),
    generatorFactory: async () => generator,
  });
  const request = ({ requestId, pipelineDiagnostics = false }) => ({
    type: CHUNK_GENERATOR_MESSAGE.GENERATE,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration: 77,
    requestId,
    chunkX: 4,
    chunkZ: -3,
    ...(pipelineDiagnostics ? { pipelineDiagnostics: true } : {}),
  });

  try {
    await core.receive({
      type: CHUNK_GENERATOR_MESSAGE.INITIALIZE,
      protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
      serviceGeneration: 77,
      worldSeed: WORLD_SEED,
    });
    responses.length = 0;
    await core.receive(request({ requestId: 7701 }));
    assert.equal(Object.hasOwn(generationOptions[0], 'roadTimingContext'), false);
    assert.deepEqual(responses.map(message => message.type), [
      CHUNK_GENERATOR_MESSAGE.GENERATED,
    ]);

    responses.length = 0;
    await core.receive(request({ requestId: 7702, pipelineDiagnostics: true }));
    assert.ok(generationOptions[1].roadTimingContext);
    assert.equal(generationOptions[1].roadTimingContext.recorder.snapshot().runCount, 0);
    assert.deepEqual(responses.map(message => message.type), [
      CHUNK_GENERATOR_MESSAGE.GENERATED,
      CHUNK_GENERATOR_MESSAGE.PIPELINE_TIMING,
    ]);
    assert.equal(responses[1].roadTiming, null);
    assert.equal(responses[1].roadTimingSummary.runCount, 0);
  } finally {
    await core.shutdown();
  }
});

test('Node Worker transport forwards Road diagnostics only when pipeline diagnostics are enabled', {
  timeout: 90_000,
}, async () => {
  const collector = createPipelineCollector();
  const diagnosticTransport = createWorkerChunkGeneratorTransport({
    worldSeed: WORLD_SEED,
    serviceGeneration: 55,
    workerFactory: createNodeChunkGeneratorWorker,
    onPipelineEvent: collector.onPipelineEvent,
  });
  const quietTransport = createWorkerChunkGeneratorTransport({
    worldSeed: WORLD_SEED,
    serviceGeneration: 56,
    workerFactory: createNodeChunkGeneratorWorker,
  });

  try {
    await Promise.all([diagnosticTransport.initialize(), quietTransport.initialize()]);
    const diagnostic = await generateWorkerChunk({
      transport: diagnosticTransport,
      collector,
      requestId: 5501,
    });
    const quiet = await generateWorkerChunk({
      transport: quietTransport,
      requestId: 5601,
    });

    assert.equal(diagnostic.chunk.contentHash, ROAD_HEAVY_OWNER_CONTENT_HASH);
    assert.equal(quiet.chunk.contentHash, ROAD_HEAVY_OWNER_CONTENT_HASH);
    assert.equal(diagnostic.chunk.chunkId, quiet.chunk.chunkId);
    assert.deepEqual(canonicalMajorRoadFeatures(diagnostic.chunk), canonicalMajorRoadFeatures(quiet.chunk));
    assert.deepEqual(diagnostic.chunk.riverRoadCrossings, quiet.chunk.riverRoadCrossings);

    assertRoadTimingSnapshot(diagnostic.stageEvent.roadTiming);
    assert.ok(diagnostic.stageEvent.roadTimingSummary);
    assert.equal(diagnostic.stageEvent.roadTimingSummary.runCount, 1);
    assert.equal(diagnostic.stageEvent.roadTimingSummary.topRuns.length, 1);
    assert.deepEqual(
      diagnostic.stageEvent.roadTimingSummary.topRuns[0],
      diagnostic.stageEvent.roadTiming,
    );

    const diagnosticSnapshot = diagnosticTransport.snapshot();
    const quietSnapshot = quietTransport.snapshot();
    assert.equal(diagnosticSnapshot.counts.pipelineTimingMessages, 1);
    assert.equal(quietSnapshot.counts.pipelineTimingMessages, 0);
    assert.equal(quietSnapshot.counts.pipelineTimingOrphans, 0);
    assert.equal(collector.events.some(event => (
      event.type === 'worker-chunk-stages' && event.requestId === 5601
    )), false, 'diagnostics-off requests must not emit a Road timing trailer');
  } finally {
    await Promise.all([diagnosticTransport.shutdown(), quietTransport.shutdown()]);
  }
});
