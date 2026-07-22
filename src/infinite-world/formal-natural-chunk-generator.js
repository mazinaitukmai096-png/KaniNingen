import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { createChunkId } from './legacy-core/g0/chunk-id.js';
import { deriveLocalSeed64 } from './legacy-core/g0/deterministic-random.js';
import { parseGeneratorVersion } from './legacy-core/g0/generator-version.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import {
  compareFormalDetailCandidates,
  createDetailCandidateId,
  determineDetailCandidateOwner,
} from './legacy-core/g3/detail-candidates.js';
import { createMacroTerrainEvaluator, G5_MACRO_TERRAIN } from './legacy-core/g5/macro-terrain.js';
import {
  createG6DRockProfile,
  createRockCandidateG6D,
  G6_D_ROCK,
  vegetationBoundsOverlap,
} from './legacy-core/g6/rock-redistribution.js';
import { LOGICAL_CHUNK_SIZE_METERS, RENDER_CHUNK_SIZE } from './chunk-coordinates.js';
import { createNaturalChunkGenerator } from './natural-chunk-generator.js';

export const W3_GENERATOR_VERSION = parseGeneratorVersion('300.0.0');
export const W3_CHUNK_DATA_SCHEMA = 'w3-formal-natural-detail-chunk-data-1';
export const W3_FORMAL_DETAILS = Object.freeze({
  schemaVersion: 'w3-formal-natural-details-1',
  vegetationCellSizeMeters: 2,
  rockProposalCellSizeMeters: 2,
  maximumVegetationPerChunk: 64,
  maximumRocksPerChunk: 64,
  vegetationRadiusMeters: Object.freeze({
    'broadleaf-tree': 0.32,
    'conifer-tree': 0.28,
    'wetland-tree': 0.34,
    shrub: 0.2,
  }),
});

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const clamp = value => Math.max(0, Math.min(1, value));

function mix32(value) {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  result ^= result >>> 16;
  return result >>> 0;
}

function foldInteger(value) {
  if (!Number.isSafeInteger(value)) throw new RangeError('formal detail cell coordinate must be safe');
  if (value >= -0x80000000 && value <= 0x7fffffff) return value >>> 0;
  return mix32((value >>> 0) ^ mix32(Math.trunc(value / 0x100000000) >>> 0));
}

function cellUnit(seed, x, z, salt) {
  return mix32(seed ^ Math.imul(foldInteger(x), 0x1f123bb5)
    ^ Math.imul(foldInteger(z), 0x5f356495) ^ Math.imul(salt, 0x9e3779b9)) / 0xffffffff;
}

function seed32(seed64) {
  return mix32(Number.parseInt(seed64.slice(0, 8), 16) ^ Number.parseInt(seed64.slice(8), 16));
}

function sampleTerrain(chunk, point) {
  const terrain = chunk.terrain;
  const localX = point.x - chunk.chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const localZ = point.z - chunk.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const fx = clamp(localX / LOGICAL_CHUNK_SIZE_METERS) * (terrain.resolution.x - 1);
  const fz = clamp(localZ / LOGICAL_CHUNK_SIZE_METERS) * (terrain.resolution.z - 1);
  const x0 = Math.floor(fx); const z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, terrain.resolution.x - 1);
  const z1 = Math.min(z0 + 1, terrain.resolution.z - 1);
  const tx = fx - x0; const tz = fz - z0;
  const interpolate = (values, stride = 1, offset = 0) => {
    const at = (x, z) => values[(z * terrain.resolution.x + x) * stride + offset];
    return (at(x0, z0) * (1 - tx) + at(x1, z0) * tx) * (1 - tz)
      + (at(x0, z1) * (1 - tx) + at(x1, z1) * tx) * tz;
  };
  return Object.freeze({
    height: q6(interpolate(terrain.heights) * terrain.heightUnitMeters),
    slope: q6(interpolate(terrain.finalSlopes)),
    moisture: q6(interpolate(terrain.moisture)),
    rockiness: q6(interpolate(terrain.rockiness)),
    grassMaterial: q6(interpolate(terrain.materialWeights, 5, 0)),
    rockMaterial: q6(interpolate(terrain.materialWeights, 5, 4)),
  });
}

function sampleBiomeWeights(chunk, point) {
  const field = chunk.biomeField;
  const localX = point.x - chunk.chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const localZ = point.z - chunk.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const fx = clamp(localX / LOGICAL_CHUNK_SIZE_METERS) * (field.resolution.x - 1);
  const fz = clamp(localZ / LOGICAL_CHUNK_SIZE_METERS) * (field.resolution.z - 1);
  const x0 = Math.floor(fx); const z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, field.resolution.x - 1);
  const z1 = Math.min(z0 + 1, field.resolution.z - 1);
  const tx = fx - x0; const tz = fz - z0;
  const at = (x, z, biomeId) => field.samples[z * field.resolution.x + x].memberships
    .find(item => item.biomeId === biomeId)?.weight ?? 0;
  return field.biomeOrder.map(biomeId => ({
    biomeId,
    weight: q6((at(x0, z0, biomeId) * (1 - tx) + at(x1, z0, biomeId) * tx) * (1 - tz)
      + (at(x0, z1, biomeId) * (1 - tx) + at(x1, z1, biomeId) * tx) * tz),
  }));
}

function chooseVegetationSubtype(weights, terrain, subtypeRoll) {
  const byId = Object.fromEntries(weights.map(item => [item.biomeId, item.weight]));
  if ((byId.wetland ?? 0) > 0.34 && terrain.moisture > 0.6) return 'wetland-tree';
  if ((byId['rocky-highland'] ?? 0) > 0.38 || terrain.moisture < 0.32) return 'conifer-tree';
  if ((byId['mixed-woodland'] ?? 0) > 0.3 || subtypeRoll < 0.68) return 'broadleaf-tree';
  return 'shrub';
}

async function createVegetationCandidates(chunk, placementSeed) {
  const size = W3_FORMAL_DETAILS.vegetationCellSizeMeters;
  const cellsPerChunk = LOGICAL_CHUNK_SIZE_METERS / size;
  const startX = chunk.chunkX * cellsPerChunk;
  const startZ = chunk.chunkZ * cellsPerChunk;
  const candidateTasks = [];
  for (let localZ = 0; localZ < cellsPerChunk; localZ += 1) {
    for (let localX = 0; localX < cellsPerChunk; localX += 1) {
      const cellX = startX + localX; const cellZ = startZ + localZ;
      const point = {
        x: q6((cellX + 0.5) * size + (cellUnit(placementSeed, cellX, cellZ, 1) - 0.5) * size * 0.54),
        z: q6((cellZ + 0.5) * size + (cellUnit(placementSeed, cellX, cellZ, 2) - 0.5) * size * 0.54),
      };
      const owner = determineDetailCandidateOwner(point);
      if (owner.x !== chunk.chunkX || owner.z !== chunk.chunkZ) continue;
      const terrain = sampleTerrain(chunk, point);
      const sourceBiomeWeights = sampleBiomeWeights(chunk, point);
      const weights = Object.fromEntries(sourceBiomeWeights.map(item => [item.biomeId, item.weight]));
      const slopeFit = clamp(1 - terrain.slope / 0.34);
      const rockPenalty = clamp(1 - terrain.rockiness * 0.78);
      const eligibility = q6(clamp((
        (weights['mixed-woodland'] ?? 0) * 0.92
        + (weights['temperate-grassland'] ?? 0) * 0.5
        + (weights.wetland ?? 0) * 0.66
        + (weights['rocky-highland'] ?? 0) * 0.15
      ) * slopeFit * rockPenalty));
      if (cellUnit(placementSeed, cellX, cellZ, 3) >= eligibility * 0.58) continue;
      const subtype = chooseVegetationSubtype(
        sourceBiomeWeights,
        terrain,
        cellUnit(placementSeed, cellX, cellZ, 4),
      );
      const identityTask = createDetailCandidateId({
        worldSeedHash: chunk.worldSeedHash,
        generatorMajor: 3,
        candidateType: 'vegetation',
        quantizedWorldCell: { x: cellX, z: cellZ },
        semanticKey: `${subtype}:slot-0`,
      });
      const orientationSeed = q6(cellUnit(placementSeed, cellX, cellZ, 5));
      const variationSeed = q6(cellUnit(placementSeed, cellX, cellZ, 6));
      const radius = W3_FORMAL_DETAILS.vegetationRadiusMeters[subtype];
      candidateTasks.push(identityTask.then(identity => Object.freeze({
        schemaVersion: 'detail-candidate-1',
        ...identity,
        candidateType: 'vegetation',
        subtype,
        worldPosition: Object.freeze({ x: point.x, y: terrain.height, z: point.z }),
        owningChunkCoordinate: Object.freeze(owner),
        sourceBiomeWeights: Object.freeze(sourceBiomeWeights.map(Object.freeze)),
        sourceFeatureIds: Object.freeze([]),
        densityClass: eligibility >= 0.48 ? 'dense' : eligibility >= 0.25 ? 'moderate' : 'sparse',
        sizeClass: subtype === 'shrub' ? 'small' : 'medium',
        orientationSeed,
        variationSeed,
        eligibility,
        metadata: Object.freeze({
          cellSizeMeters: size,
          semanticSlot: 'slot-0',
          candidateRadiusMeters: radius,
          boundsType: 'horizontal-circle',
          slope: terrain.slope,
          moisture: terrain.moisture,
          rockiness: terrain.rockiness,
          category: 'vegetation',
        }),
      })));
    }
  }
  const output = await Promise.all(candidateTasks);
  return output.sort(compareFormalDetailCandidates).slice(0, W3_FORMAL_DETAILS.maximumVegetationPerChunk);
}

async function createRockCandidates(chunk, macroEvaluator, baseProfile, placementSeed, vegetationCandidates) {
  const size = W3_FORMAL_DETAILS.rockProposalCellSizeMeters;
  const cellsPerChunk = LOGICAL_CHUNK_SIZE_METERS / size;
  const startX = chunk.chunkX * cellsPerChunk;
  const startZ = chunk.chunkZ * cellsPerChunk;
  const profile = Object.freeze({ ...baseProfile, fieldCache: new Map() });
  const candidateTasks = [];
  for (let localZ = 0; localZ < cellsPerChunk; localZ += 1) {
    for (let localX = 0; localX < cellsPerChunk; localX += 1) {
      const proposalX = startX + localX; const proposalZ = startZ + localZ;
      const point = {
        x: q6((proposalX + 0.5) * size + (cellUnit(placementSeed, proposalX, proposalZ, 21) - 0.5) * size * 0.54),
        z: q6((proposalZ + 0.5) * size + (cellUnit(placementSeed, proposalX, proposalZ, 22) - 0.5) * size * 0.54),
      };
      const owner = determineDetailCandidateOwner(point);
      if (owner.x !== chunk.chunkX || owner.z !== chunk.chunkZ) continue;
      const terrain = sampleTerrain(chunk, point);
      if (terrain.rockiness + terrain.rockMaterial + terrain.slope * 2 < 0.16) continue;
      if (cellUnit(placementSeed, proposalX, proposalZ, 23) >= 0.36) continue;
      const macro = macroEvaluator.evaluate(point.x, point.z);
      const step = G5_MACRO_TERRAIN.derivativeStepMeters;
      const curvature = q6((
        macroEvaluator.evaluate(point.x + step, point.z).offsetMm
        + macroEvaluator.evaluate(point.x - step, point.z).offsetMm
        + macroEvaluator.evaluate(point.x, point.z + step).offsetMm
        + macroEvaluator.evaluate(point.x, point.z - step).offsetMm
        - 4 * macro.offsetMm
      ) * 0.001 / 4);
      const sourceBiomeWeights = sampleBiomeWeights(chunk, point);
      const quantizedWorldCell = {
        x: Math.floor(point.x / G6_D_ROCK.cellSizeMeters),
        z: Math.floor(point.z / G6_D_ROCK.cellSizeMeters),
      };
      const candidateTask = createRockCandidateG6D({
        profile,
        worldSeedHash: chunk.worldSeedHash,
        quantizedWorldCell,
        point,
        terrain: {
          height: terrain.height,
          slope: terrain.slope,
          rockiness: terrain.rockiness,
          rockMaterial: terrain.rockMaterial,
        },
        macro: {
          ridge: clamp(macro.components.ridgesMm / G5_MACRO_TERRAIN.ridges.amplitudeMm),
          curvature,
        },
        river: { distance: Infinity, width: 0 },
        vegetationCandidates,
        sourceBiomeWeights,
        sourceFeatureIds: [],
      });
      candidateTasks.push(candidateTask.then(candidate => {
        if (!candidate) return null;
        candidate.owningChunkCoordinate = owner;
        return Object.freeze(candidate);
      }));
    }
  }
  const output = (await Promise.all(candidateTasks)).filter(Boolean);
  return output.sort(compareFormalDetailCandidates).slice(0, W3_FORMAL_DETAILS.maximumRocksPerChunk);
}

export async function hashW3ChunkContent(content) {
  return `sha256:${await sha256Hex(canonicalizeJson(content))}`;
}

export function validateW3FormalChunkData(chunkData) {
  const errors = [];
  if (chunkData?.schemaVersion !== W3_CHUNK_DATA_SCHEMA) errors.push('invalid W3 ChunkData schema');
  if (chunkData?.generatorVersion?.id !== W3_GENERATOR_VERSION.id) errors.push('invalid W3 generator version');
  if (!Number.isSafeInteger(chunkData?.chunkX) || !Number.isSafeInteger(chunkData?.chunkZ)) errors.push('invalid chunk coordinates');
  if (chunkData?.logicalChunkSizeMeters !== LOGICAL_CHUNK_SIZE_METERS || chunkData?.renderChunkSize !== RENDER_CHUNK_SIZE) errors.push('invalid Chunk scale');
  const allIds = new Set();
  for (const [name, type, limit] of [
    ['vegetationCandidates', 'vegetation', W3_FORMAL_DETAILS.maximumVegetationPerChunk],
    ['rockCandidates', 'rock', W3_FORMAL_DETAILS.maximumRocksPerChunk],
  ]) {
    const candidates = chunkData?.[name];
    if (!Array.isArray(candidates) || candidates.length > limit) { errors.push(`invalid ${name}`); continue; }
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate?.schemaVersion !== 'detail-candidate-1' || candidate?.candidateType !== type) errors.push(`invalid ${name} candidate`);
      if (typeof candidate?.candidateId !== 'string' || allIds.has(candidate.candidateId)) errors.push(`duplicate or invalid Candidate ID in ${name}`);
      allIds.add(candidate?.candidateId);
      if (index && candidates[index - 1].candidateId.localeCompare(candidate.candidateId) > 0) errors.push(`${name} is not sorted`);
      const owner = candidate?.worldPosition ? determineDetailCandidateOwner(candidate.worldPosition) : null;
      if (!owner || owner.x !== chunkData.chunkX || owner.z !== chunkData.chunkZ
        || owner.x !== candidate?.owningChunkCoordinate?.x || owner.z !== candidate?.owningChunkCoordinate?.z) errors.push(`invalid ${name} ownership`);
      if (![candidate?.worldPosition?.x, candidate?.worldPosition?.y, candidate?.worldPosition?.z,
        candidate?.orientationSeed, candidate?.variationSeed, candidate?.eligibility,
        candidate?.metadata?.candidateRadiusMeters].every(Number.isFinite)) errors.push(`non-finite ${name} candidate`);
    }
  }
  for (const rock of chunkData?.rockCandidates ?? []) {
    if (vegetationBoundsOverlap(rock.worldPosition, rock.metadata.candidateRadiusMeters, chunkData.vegetationCandidates)) {
      errors.push(`rock overlaps vegetation bounds: ${rock.candidateId}`);
    }
  }
  if (chunkData?.generationProof?.settlementConnected !== false || chunkData?.generationProof?.gameplayConnected !== false) errors.push('W3 must not connect Settlement or Gameplay');
  if (chunkData?.generationProof?.formalVegetationConnected !== true || chunkData?.generationProof?.formalRockConnected !== true) errors.push('W3 formal details are not connected');
  if (!/^sha256:[0-9a-f]{64}$/.test(chunkData?.contentHash ?? '')) errors.push('invalid contentHash');
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export async function createFormalNaturalChunkGenerator({ worldSeed = 'KaniNingen Infinite Natural World' } = {}) {
  const naturalGenerator = await createNaturalChunkGenerator({ worldSeed });
  const [macroEvaluator, rockProfile, placementSeed64] = await Promise.all([
    createMacroTerrainEvaluator(naturalGenerator.worldSeedHash),
    createG6DRockProfile({ worldSeedHash: naturalGenerator.worldSeedHash, worldFeatures: [] }),
    deriveLocalSeed64({
      worldSeedHash: naturalGenerator.worldSeedHash,
      namespace: 'w3-formal-natural-details',
      semanticKey: W3_FORMAL_DETAILS.schemaVersion,
    }),
  ]);
  const placementSeed = seed32(placementSeed64);
  return Object.freeze({
    worldSeed: naturalGenerator.worldSeed,
    worldSeedHash: naturalGenerator.worldSeedHash,
    seed64: naturalGenerator.seed64,
    generatorVersion: W3_GENERATOR_VERSION,
    async generateChunk(chunkX, chunkZ) {
      const natural = await naturalGenerator.generateChunk(chunkX, chunkZ);
      const candidateInput = { ...natural, worldSeedHash: naturalGenerator.worldSeedHash };
      const vegetationCandidates = await createVegetationCandidates(candidateInput, placementSeed);
      const rockCandidates = await createRockCandidates(
        candidateInput,
        macroEvaluator,
        rockProfile,
        placementSeed,
        vegetationCandidates,
      );
      const chunkId = createChunkId({
        worldSeedHash: naturalGenerator.worldSeedHash,
        generatorMajor: W3_GENERATOR_VERSION.major,
        chunkCoordinate: { x: natural.chunkX, z: natural.chunkZ },
      });
      const content = {
        schemaVersion: W3_CHUNK_DATA_SCHEMA,
        chunkId,
        chunkX: natural.chunkX,
        chunkZ: natural.chunkZ,
        logicalChunkSizeMeters: natural.logicalChunkSizeMeters,
        renderChunkSize: natural.renderChunkSize,
        generatorVersion: { ...W3_GENERATOR_VERSION },
        terrain: natural.terrain,
        biomeField: natural.biomeField,
        naturalBiomeDefinitions: natural.naturalBiomeDefinitions,
        vegetationCandidates,
        rockCandidates,
        edgeData: natural.edgeData,
        generationProof: {
          generator: 'w3-formal-natural-details',
          sourceW2ContentHash: natural.contentHash,
          legacyMacroTerrain: G5_MACRO_TERRAIN.schemaVersion,
          legacyRockRedistribution: G6_D_ROCK.schemaVersion,
          settlementConnected: false,
          gameplayConnected: false,
          formalVegetationConnected: true,
          formalRockConnected: true,
        },
      };
      const chunkData = { ...content, contentHash: await hashW3ChunkContent(content) };
      const validation = validateW3FormalChunkData(chunkData);
      if (!validation.valid) throw new Error(`invalid W3 ChunkData: ${validation.errors.join('; ')}`);
      return chunkData;
    },
  });
}
