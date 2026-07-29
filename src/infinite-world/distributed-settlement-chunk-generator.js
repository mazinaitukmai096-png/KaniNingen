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
import { createMigratedSettlementTemplate } from './single-rural-settlement.js';

export const W5_GENERATOR_VERSION = parseGeneratorVersion('500.0.0');
export const W5_CHUNK_DATA_SCHEMA = 'w5-distributed-settlement-chunk-data-1';
const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

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

function conflictsWithTemplate(candidate, template) {
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

function projectTemplate(template, chunk) {
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
      worldPosition: Object.freeze({ ...midpoint, y: sampleTerrainHeight(chunk, midpoint) }),
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
        y: sampleTerrainHeight(chunk, building),
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

export async function hashW5ChunkContent(content) {
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
  return `sha256:${await sha256Hex(canonicalizeJson(envelope))}`;
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

export async function createDistributedSettlementChunkGenerator({ worldSeed = 'KaniNingen Infinite Natural World' } = {}) {
  const formalGenerator = await createFormalNaturalChunkGenerator({ worldSeed });
  const distributor = await createSettlementDistributor({ worldSeedHash: formalGenerator.worldSeedHash });
  const reviewSettlement = await distributor.findHomeSettlement(0, 0);
  const templateCache = new Map();
  const templateCacheCapacity = 128;
  let templatesMaterialized = 0;
  let templateGenerationMs = 0;
  let templateCacheHits = 0;
  let templateCacheMisses = 0;

  async function getTemplate(candidate) {
    if (templateCache.has(candidate.settlementId)) {
      templateCacheHits += 1;
      const cached = templateCache.get(candidate.settlementId);
      templateCache.delete(candidate.settlementId);
      templateCache.set(candidate.settlementId, cached);
      return cached;
    }
    templateCacheMisses += 1;
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    const template = await createMigratedSettlementTemplate({ candidate });
    templateGenerationMs += (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
    templatesMaterialized += 1;
    return lruSet(templateCache, candidate.settlementId, template, templateCacheCapacity);
  }

  return Object.freeze({
    worldSeed: formalGenerator.worldSeed,
    worldSeedHash: formalGenerator.worldSeedHash,
    seed64: formalGenerator.seed64,
    generatorVersion: W5_GENERATOR_VERSION,
    distributor,
    reviewSpawn: Object.freeze({ ...reviewSettlement.center, settlementId: reviewSettlement.settlementId }),
    async resolveSettlementTemplate({ candidate } = {}) {
      if (!candidate?.settlementId) throw new TypeError('Settlement candidate is required');
      return getTemplate(candidate);
    },
    async generateChunk(chunkX, chunkZ) {
      const formal = await formalGenerator.generateChunk(chunkX, chunkZ);
      const bounds = chunkBounds(formal.chunkX, formal.chunkZ);
      const chunkCenter = {
        x: (bounds.minX + bounds.maxX) / 2,
        z: (bounds.minZ + bounds.maxZ) / 2,
      };
      const candidates = await distributor.findSettlementsNear(
        chunkCenter.x,
        chunkCenter.z,
        Math.SQRT2 * LOGICAL_CHUNK_SIZE_METERS / 2,
      );
      const candidateInfluence = { CITY: 204, TOWN: 95, RURAL: 88 };
      const intersectingCandidates = candidates.filter(candidate => (
        rectangleDistance(candidate.center, bounds) <= candidateInfluence[candidate.settlementType]
      ));
      const templates = await Promise.all(intersectingCandidates.map(getTemplate));
      const projections = templates.map(template => projectTemplate(template, formal));
      const settlementReferences = projections.flatMap(projection => projection.references)
        .sort((a, b) => a.stableId.localeCompare(b.stableId));
      const settlementFeatures = projections.flatMap(projection => projection.features)
        .sort((a, b) => a.stableId.localeCompare(b.stableId));
      const vegetationCandidates = formal.vegetationCandidates.filter(candidate => (
        !templates.some(template => conflictsWithTemplate(candidate, template))
      ));
      const rockCandidates = formal.rockCandidates.filter(candidate => (
        !templates.some(template => conflictsWithTemplate(candidate, template))
      ));
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
      const chunkData = { ...content, contentHash: await hashW5ChunkContent(content) };
      const validation = validateW5DistributedChunkData(chunkData);
      if (!validation.valid) throw new Error(`invalid W5 ChunkData: ${validation.errors.join('; ')}`);
      return chunkData;
    },
    snapshot: () => Object.freeze({
      templateCacheSize: templateCache.size,
      templateCacheCapacity,
      templatesMaterialized,
      templateGenerationMs,
      templateCacheHits,
      templateCacheMisses,
      distributor: distributor.snapshot(),
    }),
  });
}
