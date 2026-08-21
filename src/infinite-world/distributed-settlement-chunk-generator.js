import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { createChunkId } from './legacy-core/g0/chunk-id.js';
import { parseGeneratorVersion } from './legacy-core/g0/generator-version.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import { determineDetailCandidateOwner } from './legacy-core/g3/detail-candidates.js';
import { LOGICAL_CHUNK_SIZE_METERS, RENDER_CHUNK_SIZE } from './chunk-coordinates.js';
import { createFormalNaturalChunkGenerator } from './formal-natural-chunk-generator.js';
import {
  createSettlementDistributor,
  W5_SETTLEMENT_DISTRIBUTION,
} from './settlement-distributor.js';
import { createLegacyMigratedSettlementTemplate } from './legacy-migrated-settlement-adapter.js';
import {
  acquireW8SettlementBuildingGenerationCheckpoint,
} from './w8-settlement-building-visual-policy.js';
import { ROAD_GRAPH_V1_GENERATOR_ID } from './road-graph-v1.js';
import { createRoadGraphV1SettlementTemplate } from './road-graph-v1-settlement-adapter.js';
import { ROAD_GRAPH_V2_GENERATOR_ID } from './road-graph-v2.js';
import { createRoadGraphV2SettlementTemplate } from './road-graph-v2-settlement-adapter.js';
import { ROAD_GRAPH_V3_GENERATOR_ID } from './road-graph-v3.js';
import { createRoadGraphV3SettlementTemplate } from './road-graph-v3-settlement-adapter.js';
import { SETTLEMENT_LOT_V1_GENERATOR_ID } from './settlement-lot-v1.js';
import { SETTLEMENT_LOT_V2_GENERATOR_ID } from './settlement-lot-v2.js';
import {
  CHUNK_GENERATION_STAGE,
  measureChunkGenerationStage,
  measureChunkGenerationStageSync,
} from './chunk-generation-stage-timing.js';

export const W5_GENERATOR_VERSION = parseGeneratorVersion('500.0.0');
export const W5_CHUNK_DATA_SCHEMA = 'w5-distributed-settlement-chunk-data-1';
const SETTLEMENT_TEMPLATE_CACHE_CAPACITY = 128;
const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

function createGenerationControl(checkpoint = null, cooperativeCheckpoint = null) {
  if (checkpoint !== null && typeof checkpoint !== 'function') {
    throw new TypeError('generation checkpoint must be a function when provided');
  }
  if (cooperativeCheckpoint !== null && typeof cooperativeCheckpoint !== 'function') {
    throw new TypeError('cooperative generation checkpoint must be a function when provided');
  }
  return checkpoint || cooperativeCheckpoint
    ? Object.freeze({ checkpoint, cooperativeCheckpoint }) : null;
}

async function reachGenerationCheckpoint(control) {
  if (!control) return;
  if (control.cooperativeCheckpoint) await control.cooperativeCheckpoint();
  else control.checkpoint?.();
}

function chunkBounds(chunkX, chunkZ) {
  return {
    minX: chunkX * LOGICAL_CHUNK_SIZE_METERS,
    minZ: chunkZ * LOGICAL_CHUNK_SIZE_METERS,
    maxX: (chunkX + 1) * LOGICAL_CHUNK_SIZE_METERS,
    maxZ: (chunkZ + 1) * LOGICAL_CHUNK_SIZE_METERS,
  };
}

function rectangleDistance(center, bounds) {
  const nearestX = Math.max(bounds.minX, Math.min(center.x, bounds.maxX));
  const nearestZ = Math.max(bounds.minZ, Math.min(center.z, bounds.maxZ));
  return Math.hypot(nearestX - center.x, nearestZ - center.z);
}

function clipSegment(start, end, bounds) {
  const dx = end.x - start.x; const dz = end.z - start.z;
  let t0 = 0; let t1 = 1;
  for (const [p, r] of [
    [-dx, start.x - bounds.minX], [dx, bounds.maxX - start.x],
    [-dz, start.z - bounds.minZ], [dz, bounds.maxZ - start.z],
  ]) {
    if (Math.abs(p) < 1e-12) { if (r < 0) return null; continue; }
    const t = r / p;
    if (p < 0) { if (t > t1) return null; t0 = Math.max(t0, t); }
    else { if (t < t0) return null; t1 = Math.min(t1, t); }
  }
  if (t1 - t0 <= 1e-9) return null;
  return {
    start: { x: q6(start.x + dx * t0), z: q6(start.z + dz * t0) },
    end: { x: q6(start.x + dx * t1), z: q6(start.z + dz * t1) },
  };
}

function sampleTerrainHeight(chunk, point) {
  const terrain = chunk.terrain;
  const localX = point.x - chunk.chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const localZ = point.z - chunk.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const fx = Math.max(0, Math.min(terrain.resolution.x - 1,
    localX / LOGICAL_CHUNK_SIZE_METERS * (terrain.resolution.x - 1)));
  const fz = Math.max(0, Math.min(terrain.resolution.z - 1,
    localZ / LOGICAL_CHUNK_SIZE_METERS * (terrain.resolution.z - 1)));
  const x0 = Math.floor(fx); const z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, terrain.resolution.x - 1);
  const z1 = Math.min(z0 + 1, terrain.resolution.z - 1);
  const tx = fx - x0; const tz = fz - z0;
  const at = (x, z) => terrain.heights[z * terrain.resolution.x + x] * terrain.heightUnitMeters;
  return q6((at(x0, z0) * (1 - tx) + at(x1, z0) * tx) * (1 - tz)
    + (at(x0, z1) * (1 - tx) + at(x1, z1) * tx) * tz);
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x; const dz = end.z - start.z;
  const length2 = dx * dx + dz * dz;
  const t = length2 ? Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.z - start.z) * dz) / length2)) : 0;
  return Math.hypot(point.x - start.x - dx * t, point.z - start.z - dz * t);
}

export function settlementTemplateConflictsWithCandidate(candidate, template) {
  const radius = candidate.metadata?.candidateRadiusMeters ?? 0;
  if (Math.hypot(candidate.worldPosition.x - template.center.x, candidate.worldPosition.z - template.center.z)
    > template.influenceRadiusMeters + radius + 1) return false;
  if (template.roads.some(road => distanceToSegment(candidate.worldPosition, road.start, road.end)
    <= road.widthMeters / 2 + radius + 0.25)) return true;
  return template.buildings.some(building => Math.hypot(
    candidate.worldPosition.x - building.x,
    candidate.worldPosition.z - building.z,
  ) <= building.radiusMeters + radius + 0.35);
}

export function projectMigratedSettlementTemplate(
  template,
  chunk,
  { sampleTerrainHeightAt = null } = {},
) {
  if (sampleTerrainHeightAt !== null && typeof sampleTerrainHeightAt !== 'function') {
    throw new TypeError('sampleTerrainHeightAt must be a function when provided');
  }
  const sampleHeight = point => sampleTerrainHeightAt === null
    ? sampleTerrainHeight(chunk, point)
    : q6(sampleTerrainHeightAt(point.x, point.z));
  const bounds = chunkBounds(chunk.chunkX, chunk.chunkZ);
  if (rectangleDistance(template.center, bounds) > template.influenceRadiusMeters) {
    return { features: [], references: [] };
  }
  const features = [];
  for (const road of template.roads) {
    const clipped = clipSegment(road.start, road.end, bounds);
    if (!clipped) continue;
    const midpoint = {
      x: q6((clipped.start.x + clipped.end.x) / 2),
      z: q6((clipped.start.z + clipped.end.z) / 2),
    };
    features.push(Object.freeze({
      ...road,
      settlementType: template.settlementType,
      stableId: `${road.stableId}:chunk:${chunk.chunkX}:${chunk.chunkZ}`,
      sourceStableId: road.stableId,
      start: Object.freeze(clipped.start),
      end: Object.freeze(clipped.end),
      worldPosition: Object.freeze({ ...midpoint, y: sampleHeight(midpoint) }),
      owningChunkCoordinate: Object.freeze({ x: chunk.chunkX, z: chunk.chunkZ }),
    }));
  }
  for (const building of template.buildings) {
    const owner = determineDetailCandidateOwner({ x: building.x, z: building.z });
    if (owner.x !== chunk.chunkX || owner.z !== chunk.chunkZ) continue;
    features.push(Object.freeze({
      ...building,
      settlementType: template.settlementType,
      worldPosition: Object.freeze({
        x: building.x,
        y: sampleHeight(building),
        z: building.z,
      }),
      owningChunkCoordinate: Object.freeze(owner),
    }));
  }
  features.sort((a, b) => a.stableId.localeCompare(b.stableId));
  return {
    features,
    references: [Object.freeze({
      schemaVersion: 'w5-settlement-chunk-reference-1',
      stableId: `${template.settlementId}:chunk:${chunk.chunkX}:${chunk.chunkZ}`,
      settlementId: template.settlementId,
      settlementType: template.settlementType,
      townType: template.townType,
      macroRegion: template.macroRegion,
      center: template.center,
      radiusMeters: template.radiusMeters,
      influenceRadiusMeters: template.influenceRadiusMeters,
      urbanization: template.urbanization,
      terrainSuitability: template.terrainSuitability,
      roadSegmentCount: template.roads.length,
      buildingCount: template.buildings.length,
      requestedBuildingCount: template.requestedBuildingCount,
    })],
  };
}

function lruSet(map, key, value, capacity) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > capacity) map.delete(map.keys().next().value);
  return value;
}

function settlementTemplateCandidateIdentity(candidate) {
  if (typeof candidate?.settlementId !== 'string' || candidate.settlementId.length === 0) {
    throw new TypeError('Settlement candidate requires a non-empty settlementId');
  }
  if (typeof candidate.settlementType !== 'string' || candidate.settlementType.length === 0
    || typeof candidate.townType !== 'string' || candidate.townType.length === 0) {
    throw new TypeError(`Settlement candidate ${candidate.settlementId} requires canonical types`);
  }
  if (!Number.isSafeInteger(candidate.macroRegion?.x)
    || !Number.isSafeInteger(candidate.macroRegion?.z)) {
    throw new TypeError(`Settlement candidate ${candidate.settlementId} requires a canonical macroRegion`);
  }
  if (![candidate.center?.x, candidate.center?.z, candidate.radiusMeters,
    candidate.urbanization, candidate.terrainSuitability].every(Number.isFinite)) {
    throw new TypeError(`Settlement candidate ${candidate.settlementId} requires finite canonical metadata`);
  }
  if (candidate.radiusMeters <= 0) {
    throw new RangeError(`Settlement candidate ${candidate.settlementId} requires a positive radiusMeters`);
  }
  // These are the candidate fields read by every supported Settlement template
  // adapter, including the connectivity-graph query used by Road Graph modes.
  // Per-generator world/config identity is fixed outside the candidate.
  return canonicalizeJson({
    settlementId: candidate.settlementId,
    settlementType: candidate.settlementType,
    townType: candidate.townType,
    macroRegion: candidate.macroRegion,
    center: candidate.center,
    radiusMeters: candidate.radiusMeters,
    urbanization: candidate.urbanization,
    terrainSuitability: candidate.terrainSuitability,
  });
}

function snapshotSettlementTemplateCandidate(candidate) {
  const snapshot = Object.freeze({
    settlementId: candidate?.settlementId,
    settlementType: candidate?.settlementType,
    townType: candidate?.townType,
    macroRegion: candidate?.macroRegion && typeof candidate.macroRegion === 'object'
      ? Object.freeze({ ...candidate.macroRegion })
      : candidate?.macroRegion,
    center: candidate?.center && typeof candidate.center === 'object'
      ? Object.freeze({ ...candidate.center })
      : candidate?.center,
    radiusMeters: candidate?.radiusMeters,
    urbanization: candidate?.urbanization,
    terrainSuitability: candidate?.terrainSuitability,
  });
  return Object.freeze({
    candidate: snapshot,
    candidateIdentity: settlementTemplateCandidateIdentity(snapshot),
  });
}

export async function hashW5ChunkContent(content, { stageRecorder = null } = {}) {
  const envelope = {
    schemaVersion: 'w5-transitive-content-envelope-1',
    chunkId: content.chunkId,
    chunkX: content.chunkX,
    chunkZ: content.chunkZ,
    sourceW3ContentHash: content.generationProof.sourceW3ContentHash,
    vegetationCandidateIds: content.vegetationCandidates.map(candidate => candidate.candidateId),
    rockCandidateIds: content.rockCandidates.map(candidate => candidate.candidateId),
    settlementReferences: content.settlementReferences,
    settlementFeatures: content.settlementFeatures,
    generationProof: content.generationProof,
  };
  const serialized = stageRecorder
    ? measureChunkGenerationStageSync(
      stageRecorder,
      CHUNK_GENERATION_STAGE.SERIALIZE,
      () => canonicalizeJson(envelope),
    )
    : canonicalizeJson(envelope);
  const digest = stageRecorder
    ? await measureChunkGenerationStage(
      stageRecorder,
      CHUNK_GENERATION_STAGE.HASH,
      () => sha256Hex(serialized),
    )
    : await sha256Hex(serialized);
  return `sha256:${digest}`;
}

export function validateW5DistributedChunkData(chunkData) {
  const errors = [];
  if (chunkData?.schemaVersion !== W5_CHUNK_DATA_SCHEMA) errors.push('invalid W5 ChunkData schema');
  if (chunkData?.generatorVersion?.id !== W5_GENERATOR_VERSION.id) errors.push('invalid W5 generator version');
  if (!Array.isArray(chunkData?.settlementReferences) || chunkData.settlementReferences.length > 1) errors.push('invalid W5 Settlement references');
  const ids = new Set();
  for (const feature of chunkData?.settlementFeatures ?? []) {
    if (!['settlement-road', 'settlement-building'].includes(feature?.featureType)) errors.push('invalid W5 Settlement feature');
    if (typeof feature?.stableId !== 'string' || ids.has(feature.stableId)) errors.push('duplicate or invalid W5 Stable ID');
    ids.add(feature?.stableId);
    if (![feature?.worldPosition?.x, feature?.worldPosition?.y, feature?.worldPosition?.z].every(Number.isFinite)) errors.push('non-finite W5 feature');
    if (feature?.owningChunkCoordinate?.x !== chunkData.chunkX || feature?.owningChunkCoordinate?.z !== chunkData.chunkZ) errors.push('invalid W5 feature ownership');
  }
  if (chunkData?.generationProof?.settlementDistributionConnected !== true
    || chunkData?.generationProof?.fixedSettlementCount !== false) errors.push('W5 infinite Settlement distribution is not connected');
  if (chunkData?.generationProof?.gameplayConnected !== false) errors.push('W5 must not connect Gameplay');
  if (!/^sha256:[0-9a-f]{64}$/.test(chunkData?.contentHash ?? '')) errors.push('invalid contentHash');
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export async function createDistributedSettlementChunkGenerator({
  worldSeed = 'KaniNingen Infinite Natural World',
  settlementRoadGraphGeneratorId = null,
  settlementLotMode = null,
} = {}) {
  if (settlementRoadGraphGeneratorId !== null
    && settlementRoadGraphGeneratorId !== ROAD_GRAPH_V1_GENERATOR_ID
    && settlementRoadGraphGeneratorId !== ROAD_GRAPH_V2_GENERATOR_ID
    && settlementRoadGraphGeneratorId !== ROAD_GRAPH_V3_GENERATOR_ID) {
    throw new RangeError(`unsupported experimental Settlement Road Graph: ${settlementRoadGraphGeneratorId}`);
  }
  const useRoadGraphV1 = settlementRoadGraphGeneratorId === ROAD_GRAPH_V1_GENERATOR_ID;
  const useRoadGraphV2 = settlementRoadGraphGeneratorId === ROAD_GRAPH_V2_GENERATOR_ID;
  const useRoadGraphV3 = settlementRoadGraphGeneratorId === ROAD_GRAPH_V3_GENERATOR_ID;
  if (settlementLotMode !== null
    && settlementLotMode !== SETTLEMENT_LOT_V1_GENERATOR_ID
    && settlementLotMode !== SETTLEMENT_LOT_V2_GENERATOR_ID) {
    throw new RangeError(`unsupported experimental Settlement Lot mode: ${settlementLotMode}`);
  }
  if ((settlementLotMode === SETTLEMENT_LOT_V1_GENERATOR_ID
    || settlementLotMode === SETTLEMENT_LOT_V2_GENERATOR_ID) && !useRoadGraphV3) {
    throw new RangeError(`${settlementLotMode} requires settlementRoadGraphGeneratorId=road-graph-v3`);
  }
  const formalGenerator = await createFormalNaturalChunkGenerator({ worldSeed });
  const distributor = await createSettlementDistributor({ worldSeedHash: formalGenerator.worldSeedHash });
  const reviewSettlement = await distributor.findHomeSettlement(0, 0);
  const templateCache = new Map();
  const pendingTemplates = new Map();
  let isShutdown = false;
  let templatesMaterialized = 0;
  let templateGenerationMs = 0;
  let templateCacheHits = 0;
  let templateCacheMisses = 0;

  const createLegacyTemplateAtCheckpoints = async ({
    candidate,
    roadTimingRun,
    generationControl,
  }) => {
    await reachGenerationCheckpoint(generationControl);
    const unregisterBuildingCheckpoint = await acquireW8SettlementBuildingGenerationCheckpoint({
      townId: candidate.settlementId,
      checkpoint: generationControl?.checkpoint ?? null,
    });
    let template;
    try {
      generationControl?.checkpoint?.({
        site: `cooperative-migrated-settlement-lease:${candidate.settlementId}`,
      });
      template = await createLegacyMigratedSettlementTemplate({ candidate, roadTimingRun });
    } finally {
      unregisterBuildingCheckpoint?.();
    }
    await reachGenerationCheckpoint(generationControl);
    return template;
  };

  async function getTemplate(candidate, roadTimingRun = null, generationControl = null) {
    if (isShutdown) throw new Error('Distributed Settlement Chunk generator is shut down');
    const canonical = snapshotSettlementTemplateCandidate(candidate);
    candidate = canonical.candidate;
    const { candidateIdentity } = canonical;
    const cacheLookupStartedAt = roadTimingRun
      ? (globalThis.performance?.now?.() ?? Date.now()) : null;
    const cached = templateCache.get(candidate.settlementId);
    const pending = pendingTemplates.get(candidate.settlementId);
    if (cacheLookupStartedAt !== null) {
      roadTimingRun.recordFunction('source-template-cache-lookup', Math.max(0,
        (globalThis.performance?.now?.() ?? Date.now()) - cacheLookupStartedAt));
    }
    if (cached) {
      if (cached.candidateIdentity !== candidateIdentity) {
        throw new Error(
          `Settlement template candidate identity conflict for ${candidate.settlementId}`,
        );
      }
      templateCacheHits += 1;
      roadTimingRun?.recordCacheHit();
      templateCache.delete(candidate.settlementId);
      templateCache.set(candidate.settlementId, cached);
      return cached.template;
    }
    if (pending) {
      if (pending.candidateIdentity !== candidateIdentity) {
        throw new Error(
          `Pending Settlement template candidate identity conflict for ${candidate.settlementId}`,
        );
      }
      templateCacheHits += 1;
      roadTimingRun?.recordCacheHit();
      return pending.promise;
    }
    templateCacheMisses += 1;
    roadTimingRun?.recordCacheMiss();
    const promise = (async () => {
      const startedAt = globalThis.performance?.now?.() ?? Date.now();
      const connectivityGraph = await distributor.buildConnectivityGraphNear(
        candidate.center.x,
        candidate.center.z,
        candidate.radiusMeters,
        generationControl,
      );
      await reachGenerationCheckpoint(generationControl);
      const roadGraphTemplateOptions = {
        worldSeedHash: formalGenerator.worldSeedHash,
        candidate,
        connectivityGraph,
        roadTimingRun,
        ...(generationControl ?? {}),
        ...(settlementLotMode ? { settlementLotMode } : {}),
      };
      const template = useRoadGraphV3
        ? await createRoadGraphV3SettlementTemplate(roadGraphTemplateOptions)
        : useRoadGraphV2
          ? await createRoadGraphV2SettlementTemplate(roadGraphTemplateOptions)
        : useRoadGraphV1
          ? await createRoadGraphV1SettlementTemplate(roadGraphTemplateOptions)
          : await createLegacyTemplateAtCheckpoints({
            candidate,
            roadTimingRun,
            generationControl,
          });
      await reachGenerationCheckpoint(generationControl);
      if (isShutdown) return template;
      templateGenerationMs += (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
      templatesMaterialized += 1;
      lruSet(templateCache, candidate.settlementId, Object.freeze({
        candidateIdentity,
        template,
      }), SETTLEMENT_TEMPLATE_CACHE_CAPACITY);
      return template;
    })();
    const pendingEntry = Object.freeze({ candidateIdentity, promise });
    pendingTemplates.set(candidate.settlementId, pendingEntry);
    try {
      return await promise;
    } finally {
      if (pendingTemplates.get(candidate.settlementId) === pendingEntry) {
        pendingTemplates.delete(candidate.settlementId);
      }
    }
  }

  return Object.freeze({
    worldSeed: formalGenerator.worldSeed,
    worldSeedHash: formalGenerator.worldSeedHash,
    seed64: formalGenerator.seed64,
    generatorVersion: W5_GENERATOR_VERSION,
    distributor,
    reviewSpawn: Object.freeze({ ...reviewSettlement.center, settlementId: reviewSettlement.settlementId }),
    ...(settlementRoadGraphGeneratorId ? { settlementRoadGraphGeneratorId } : {}),
    ...(settlementLotMode ? { settlementLotMode } : {}),
    async resolveSettlementTemplate({
      candidate,
      roadTimingRun = null,
      checkpoint = null,
      cooperativeCheckpoint = null,
    } = {}) {
      if (!candidate?.settlementId) throw new TypeError('Settlement candidate is required');
      const generationControl = createGenerationControl(checkpoint, cooperativeCheckpoint);
      return getTemplate(candidate, roadTimingRun, generationControl);
    },
    async generateChunk(chunkX, chunkZ, {
      stageRecorder = null,
      checkpoint = null,
      cooperativeCheckpoint = null,
    } = {}) {
      if (isShutdown) throw new Error('Distributed Settlement Chunk generator is shut down');
      const generationControl = createGenerationControl(checkpoint, cooperativeCheckpoint);
      const formal = await formalGenerator.generateChunk(chunkX, chunkZ, {
        ...(stageRecorder ? { stageRecorder } : {}),
        ...(generationControl ?? {}),
      });
      await reachGenerationCheckpoint(generationControl);
      const settlementToken = stageRecorder?.start(CHUNK_GENERATION_STAGE.SETTLEMENT);
      const bounds = chunkBounds(formal.chunkX, formal.chunkZ);
      const chunkCenter = {
        x: (bounds.minX + bounds.maxX) / 2,
        z: (bounds.minZ + bounds.maxZ) / 2,
      };
      const candidates = await distributor.findSettlementsNear(
        chunkCenter.x,
        chunkCenter.z,
        Math.SQRT2 * LOGICAL_CHUNK_SIZE_METERS / 2,
        generationControl,
      );
      const candidateInfluence = { CITY: 204, TOWN: 95, RURAL: 88 };
      const intersectingCandidates = candidates.filter(candidate => (
        rectangleDistance(candidate.center, bounds) <= candidateInfluence[candidate.settlementType]
      ));
      const templates = await Promise.all(intersectingCandidates.map(candidate => (
        getTemplate(candidate, null, generationControl)
      )));
      await reachGenerationCheckpoint(generationControl);
      const projections = templates.map(template => projectMigratedSettlementTemplate(template, formal));
      const settlementReferences = projections.flatMap(projection => projection.references)
        .sort((a, b) => a.stableId.localeCompare(b.stableId));
      const settlementFeatures = projections.flatMap(projection => projection.features)
        .sort((a, b) => a.stableId.localeCompare(b.stableId));
      const vegetationCandidates = formal.vegetationCandidates.filter(candidate => (
        !templates.some(template => settlementTemplateConflictsWithCandidate(candidate, template))
      ));
      const rockCandidates = formal.rockCandidates.filter(candidate => (
        !templates.some(template => settlementTemplateConflictsWithCandidate(candidate, template))
      ));
      if (stageRecorder) stageRecorder.end(settlementToken);
      const chunkId = createChunkId({
        worldSeedHash: formalGenerator.worldSeedHash,
        generatorMajor: W5_GENERATOR_VERSION.major,
        chunkCoordinate: { x: formal.chunkX, z: formal.chunkZ },
      });
      const content = {
        schemaVersion: W5_CHUNK_DATA_SCHEMA,
        chunkId,
        chunkX: formal.chunkX,
        chunkZ: formal.chunkZ,
        logicalChunkSizeMeters: LOGICAL_CHUNK_SIZE_METERS,
        renderChunkSize: RENDER_CHUNK_SIZE,
        generatorVersion: { ...W5_GENERATOR_VERSION },
        terrain: formal.terrain,
        biomeField: formal.biomeField,
        naturalBiomeDefinitions: formal.naturalBiomeDefinitions,
        vegetationCandidates,
        rockCandidates,
        settlementReferences,
        settlementFeatures,
        settlementDistribution: W5_SETTLEMENT_DISTRIBUTION,
        edgeData: formal.edgeData,
        generationProof: {
          generator: 'w5-distributed-settlements',
          sourceW3ContentHash: formal.contentHash,
          settlementDistributionConnected: true,
          fixedSettlementCount: false,
          connectedSettlementTypes: ['CITY', 'RURAL', 'TOWN'],
          gameplayConnected: false,
          formalVegetationConnected: true,
          formalRockConnected: true,
        },
      };
      const contentHash = stageRecorder
        ? await hashW5ChunkContent(content, { stageRecorder })
        : await hashW5ChunkContent(content);
      await reachGenerationCheckpoint(generationControl);
      const chunkData = { ...content, contentHash };
      const validation = validateW5DistributedChunkData(chunkData);
      if (!validation.valid) throw new Error(`invalid W5 ChunkData: ${validation.errors.join('; ')}`);
      return chunkData;
    },
    async settleCancelledGeneration() {
      while (pendingTemplates.size > 0) {
        const pending = [...pendingTemplates.values()].map(entry => entry.promise);
        await Promise.allSettled(pending);
      }
    },
    async shutdown() {
      if (isShutdown) return;
      isShutdown = true;
      templateCache.clear();
      const pending = [...pendingTemplates.values()].map(entry => entry.promise);
      await Promise.allSettled(pending);
      pendingTemplates.clear();
      await distributor.shutdown?.();
      await formalGenerator.shutdown?.();
    },
    snapshot: () => Object.freeze({
      isShutdown,
      templateCacheSize: templateCache.size,
      templateCacheCapacity: SETTLEMENT_TEMPLATE_CACHE_CAPACITY,
      templateCachePendingCount: pendingTemplates.size,
      templatesMaterialized,
      templateGenerationMs,
      templateCacheHits,
      templateCacheMisses,
      distributor: distributor.snapshot(),
    }),
  });
}
