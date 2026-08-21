import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import {
  canonicalizeJsonWithContext,
  createCanonicalJsonSerializationContext,
} from './canonical-json-serialization-context.js';
import { createChunkId } from './legacy-core/g0/chunk-id.js';
import {
  createDeterministicRandom,
  deriveLocalSeed64,
} from './legacy-core/g0/deterministic-random.js';
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
  G6_D_ROCK,
  vegetationBoundsOverlap,
} from './legacy-core/g6/rock-redistribution.js';
import { createFormalRockCandidate } from './formal-rock-candidate.js';
import { LOGICAL_CHUNK_SIZE_METERS, RENDER_CHUNK_SIZE } from './chunk-coordinates.js';
import { createNaturalChunkGenerator } from './natural-chunk-generator.js';
import {
  CHUNK_GENERATION_STAGE,
  measureChunkGenerationStage,
  measureChunkGenerationStageSync,
} from './chunk-generation-stage-timing.js';

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

function createGenerationControl(checkpoint = null, cooperativeCheckpoint = null) {
  if (checkpoint !== null && typeof checkpoint !== 'function') {
    throw new TypeError('Formal Natural checkpoint must be a function when provided');
  }
  if (cooperativeCheckpoint !== null && typeof cooperativeCheckpoint !== 'function') {
    throw new TypeError('Formal Natural cooperative checkpoint must be a function when provided');
  }
  return checkpoint || cooperativeCheckpoint
    ? Object.freeze({ checkpoint, cooperativeCheckpoint }) : null;
}

async function reachGenerationCheckpoint(control) {
  if (!control) return;
  if (control.cooperativeCheckpoint) await control.cooperativeCheckpoint();
  else control.checkpoint?.();
}

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

function cellRandomBase(seed, x, z) {
  return seed ^ Math.imul(foldInteger(x), 0x1f123bb5)
    ^ Math.imul(foldInteger(z), 0x5f356495);
}

function cellUnitFromBase(base, salt) {
  return mix32(base ^ Math.imul(salt, 0x9e3779b9)) / 0xffffffff;
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

function chooseVegetationSubtype(byId, terrain, subtypeRoll) {
  if ((byId.wetland ?? 0) > 0.34 && terrain.moisture > 0.6) return 'wetland-tree';
  if ((byId['rocky-highland'] ?? 0) > 0.38 || terrain.moisture < 0.32) return 'conifer-tree';
  if ((byId['mixed-woodland'] ?? 0) > 0.3 || subtypeRoll < 0.68) return 'broadleaf-tree';
  return 'shrub';
}

async function createVegetationCandidates(
  chunk,
  placementSeed,
  sampleTerrainAt = sampleTerrain,
  sampleBiomeWeightsAt = sampleBiomeWeights,
  generationControl = null,
) {
  const size = W3_FORMAL_DETAILS.vegetationCellSizeMeters;
  const cellsPerChunk = LOGICAL_CHUNK_SIZE_METERS / size;
  const startX = chunk.chunkX * cellsPerChunk;
  const startZ = chunk.chunkZ * cellsPerChunk;
  const owner = Object.freeze({ x: chunk.chunkX, z: chunk.chunkZ });
  const candidateTasks = [];
  for (let localZ = 0; localZ < cellsPerChunk; localZ += 1) {
    for (let localX = 0; localX < cellsPerChunk; localX += 1) {
      const cellX = startX + localX; const cellZ = startZ + localZ;
      const randomBase = cellRandomBase(placementSeed, cellX, cellZ);
      const point = {
        x: q6((cellX + 0.5) * size + (cellUnitFromBase(randomBase, 1) - 0.5) * size * 0.54),
        z: q6((cellZ + 0.5) * size + (cellUnitFromBase(randomBase, 2) - 0.5) * size * 0.54),
      };
      // Jitter is strictly inside its 2 m semantic cell, so the owning 16 m
      // cell is already the validated candidate input owner.
      const admissionRoll = cellUnitFromBase(randomBase, 3);
      // eligibility is clamped to one, so a roll outside the absolute maximum
      // acceptance range can be rejected before any Terrain/Biome sampling.
      if (admissionRoll >= 0.58) continue;
      const sourceBiomeWeights = sampleBiomeWeightsAt(chunk, point);
      const weights = Object.fromEntries(sourceBiomeWeights.map(item => [item.biomeId, item.weight]));
      const habitatUpperBound = clamp(
        (weights['mixed-woodland'] ?? 0) * 0.92
        + (weights['temperate-grassland'] ?? 0) * 0.5
        + (weights.wetland ?? 0) * 0.66
        + (weights['rocky-highland'] ?? 0) * 0.15,
      );
      if (admissionRoll >= habitatUpperBound * 0.58) continue;
      const terrain = sampleTerrainAt(chunk, point, 'vegetation');
      const slopeFit = clamp(1 - terrain.slope / 0.34);
      const rockPenalty = clamp(1 - terrain.rockiness * 0.78);
      const eligibility = q6(clamp(habitatUpperBound * slopeFit * rockPenalty));
      if (admissionRoll >= eligibility * 0.58) continue;
      const subtype = chooseVegetationSubtype(
        weights,
        terrain,
        cellUnitFromBase(randomBase, 4),
      );
      const identityTask = createDetailCandidateId({
        worldSeedHash: chunk.worldSeedHash,
        generatorMajor: 3,
        candidateType: 'vegetation',
        quantizedWorldCell: { x: cellX, z: cellZ },
        semanticKey: `${subtype}:slot-0`,
      });
      const orientationSeed = q6(cellUnitFromBase(randomBase, 5));
      const variationSeed = q6(cellUnitFromBase(randomBase, 6));
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
    await reachGenerationCheckpoint(generationControl);
  }
  const output = await Promise.all(candidateTasks);
  return output.sort(compareFormalDetailCandidates).slice(0, W3_FORMAL_DETAILS.maximumVegetationPerChunk);
}

async function createRockCandidates(
  chunk,
  macroEvaluator,
  baseProfile,
  placementSeed,
  vegetationCandidates,
  sampleTerrainAt = sampleTerrain,
  sampleBiomeWeightsAt = sampleBiomeWeights,
  proposalSampleRate = 1,
  sharedFieldCache = null,
  generationControl = null,
) {
  const size = W3_FORMAL_DETAILS.rockProposalCellSizeMeters;
  const cellsPerChunk = LOGICAL_CHUNK_SIZE_METERS / size;
  const startX = chunk.chunkX * cellsPerChunk;
  const startZ = chunk.chunkZ * cellsPerChunk;
  const owner = Object.freeze({ x: chunk.chunkX, z: chunk.chunkZ });
  const profile = Object.freeze({ ...baseProfile, fieldCache: sharedFieldCache ?? new Map() });
  const fieldRandom = createDeterministicRandom(profile.fieldSeed);
  const candidateTasks = [];
  for (let localZ = 0; localZ < cellsPerChunk; localZ += 1) {
    for (let localX = 0; localX < cellsPerChunk; localX += 1) {
      const proposalX = startX + localX; const proposalZ = startZ + localZ;
      const randomBase = cellRandomBase(placementSeed, proposalX, proposalZ);
      // Sparse Far presentation evaluates only a deterministic subset of the
      // canonical proposal lattice. Every admitted result is still produced by
      // the exact Near Rock generator and therefore remains a real Rock.
      if (proposalSampleRate < 1 && cellUnitFromBase(randomBase, 24) >= proposalSampleRate) continue;
      const point = {
        x: q6((proposalX + 0.5) * size + (cellUnitFromBase(randomBase, 21) - 0.5) * size * 0.54),
        z: q6((proposalZ + 0.5) * size + (cellUnitFromBase(randomBase, 22) - 0.5) * size * 0.54),
      };
      // The proposal roll is semantic and independent of Terrain. Evaluate it
      // before sparse/dense sampling so rejected rock cells pay no height cost.
      if (cellUnitFromBase(randomBase, 23) >= 0.36) continue;
      const quantizedWorldCell = {
        x: Math.floor(point.x / G6_D_ROCK.cellSizeMeters),
        z: Math.floor(point.z / G6_D_ROCK.cellSizeMeters),
      };
      const occupancyKey = `${quantizedWorldCell.x}:${quantizedWorldCell.z}`;
      candidateTasks.push((async () => {
        // Final G6-D occupancy can never exceed occupancyScale because both
        // eligibility and subtype occupancy are <= 1. This exact upper-bound
        // precheck avoids Terrain/field work for the other 81.3% of proposals.
        const occupancyRoll = await fieldRandom.float01(`occupancy:${occupancyKey}`);
        if (occupancyRoll >= G6_D_ROCK.proposal.occupancyScale) return null;
        const terrain = sampleTerrainAt(chunk, point, 'rock');
        if (terrain.rockiness + terrain.rockMaterial + terrain.slope * 2 < 0.16) return null;
        const macro = macroEvaluator.evaluate(point.x, point.z);
        const step = G5_MACRO_TERRAIN.derivativeStepMeters;
        const curvature = q6((
          macroEvaluator.evaluate(point.x + step, point.z).offsetMm
          + macroEvaluator.evaluate(point.x - step, point.z).offsetMm
          + macroEvaluator.evaluate(point.x, point.z + step).offsetMm
          + macroEvaluator.evaluate(point.x, point.z - step).offsetMm
          - 4 * macro.offsetMm
        ) * 0.001 / 4);
        const candidate = await createFormalRockCandidate({
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
          sourceFeatureIds: [],
          occupancyRoll,
        });
        if (!candidate) return null;
        // Biome weights are output provenance only; defer them until the Rock
        // has actually passed canonical occupancy so rejected proposals do not
        // pay for interpolation.
        candidate.sourceBiomeWeights = sampleBiomeWeightsAt(chunk, point);
        return candidate;
      })().then(candidate => {
        if (!candidate) return null;
        candidate.owningChunkCoordinate = owner;
        return Object.freeze(candidate);
      }));
    }
    await reachGenerationCheckpoint(generationControl);
  }
  const output = (await Promise.all(candidateTasks)).filter(Boolean);
  return output.sort(compareFormalDetailCandidates).slice(0, W3_FORMAL_DETAILS.maximumRocksPerChunk);
}

export async function hashW3ChunkContent(content, {
  stageRecorder = null,
  canonicalJsonContext = null,
} = {}) {
  const serializeContent = () => canonicalJsonContext
    ? canonicalizeJsonWithContext(content, canonicalJsonContext)
    : canonicalizeJson(content);
  const serialized = stageRecorder
    ? measureChunkGenerationStageSync(
      stageRecorder,
      CHUNK_GENERATION_STAGE.SERIALIZE,
      serializeContent,
    )
    : serializeContent();
  const digest = stageRecorder
    ? await measureChunkGenerationStage(
      stageRecorder,
      CHUNK_GENERATION_STAGE.HASH,
      () => sha256Hex(serialized),
    )
    : await sha256Hex(serialized);
  return `sha256:${digest}`;
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

/**
 * One semantic candidate kernel shared by dense Full generation and the
 * sparse PresentationOwner path. Callers may supply a lazy terrain sampler,
 * but Stable-ID construction, admission, subtype choice, dimensions seeds,
 * ordering, and rock/vegetation conflicts remain this single implementation.
 */
export async function createFormalNaturalCandidateKernel({
  worldSeedHash,
  macroEvaluator: sharedMacroEvaluator = null,
} = {}) {
  if (typeof worldSeedHash !== 'string' || !worldSeedHash) {
    throw new TypeError('worldSeedHash is required');
  }
  const [macroEvaluator, rockProfile, placementSeed64] = await Promise.all([
    sharedMacroEvaluator ?? createMacroTerrainEvaluator(worldSeedHash),
    createG6DRockProfile({ worldSeedHash, worldFeatures: [] }),
    deriveLocalSeed64({
      worldSeedHash,
      namespace: 'w3-formal-natural-details',
      semanticKey: W3_FORMAL_DETAILS.schemaVersion,
    }),
  ]);
  const placementSeed = seed32(placementSeed64);
  const candidateInputFor = chunk => {
    if (!Number.isSafeInteger(chunk?.chunkX) || !Number.isSafeInteger(chunk?.chunkZ)) {
      throw new TypeError('candidate owner is required');
    }
    return chunk.worldSeedHash === worldSeedHash
      ? chunk : { ...chunk, worldSeedHash };
  };
  const generateVegetation = async ({
    chunk,
    sampleTerrainAt = sampleTerrain,
    sampleBiomeWeightsAt = sampleBiomeWeights,
    checkpoint = null,
    cooperativeCheckpoint = null,
  } = {}) => {
    const generationControl = createGenerationControl(checkpoint, cooperativeCheckpoint);
    const candidateInput = candidateInputFor(chunk);
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    const vegetationCandidates = await createVegetationCandidates(
      candidateInput,
      placementSeed,
      sampleTerrainAt,
      sampleBiomeWeightsAt,
      generationControl,
    );
    const completedAt = globalThis.performance?.now?.() ?? Date.now();
    return Object.freeze({
      vegetationCandidates: Object.freeze(vegetationCandidates),
      timings: Object.freeze({ vegetationMs: q6(completedAt - startedAt) }),
    });
  };
  const generateRocks = async ({
    chunk,
    vegetationCandidates,
    sampleTerrainAt = sampleTerrain,
    sampleBiomeWeightsAt = sampleBiomeWeights,
    proposalSampleRate = 1,
    sharedFieldCache = null,
    checkpoint = null,
    cooperativeCheckpoint = null,
  } = {}) => {
    const generationControl = createGenerationControl(checkpoint, cooperativeCheckpoint);
    const candidateInput = candidateInputFor(chunk);
    if (!Array.isArray(vegetationCandidates)) {
      throw new TypeError('canonical vegetation candidates are required for Rock conflicts');
    }
    if (!Number.isFinite(proposalSampleRate) || proposalSampleRate <= 0 || proposalSampleRate > 1) {
      throw new RangeError('proposalSampleRate must be in (0, 1]');
    }
    if (sharedFieldCache !== null && !(sharedFieldCache instanceof Map)) {
      throw new TypeError('sharedFieldCache must be a Map');
    }
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    const rockCandidates = await createRockCandidates(
      candidateInput,
      macroEvaluator,
      rockProfile,
      placementSeed,
      vegetationCandidates,
      sampleTerrainAt,
      sampleBiomeWeightsAt,
      proposalSampleRate,
      sharedFieldCache,
      generationControl,
    );
    const completedAt = globalThis.performance?.now?.() ?? Date.now();
    return Object.freeze({
      rockCandidates: Object.freeze(rockCandidates),
      timings: Object.freeze({ rockMs: q6(completedAt - startedAt) }),
    });
  };
  return Object.freeze({
    schemaVersion: 'shared-formal-natural-candidate-kernel-1',
    worldSeedHash,
    generateVegetation,
    generateRocks,
    async generate({
      chunk,
      sampleTerrainAt = sampleTerrain,
      sampleBiomeWeightsAt = sampleBiomeWeights,
      checkpoint = null,
      cooperativeCheckpoint = null,
    } = {}) {
      const vegetation = await generateVegetation({
        chunk,
        sampleTerrainAt,
        sampleBiomeWeightsAt,
        checkpoint,
        cooperativeCheckpoint,
      });
      const rocks = await generateRocks({
        chunk,
        vegetationCandidates: vegetation.vegetationCandidates,
        sampleTerrainAt,
        sampleBiomeWeightsAt,
        checkpoint,
        cooperativeCheckpoint,
      });
      return Object.freeze({
        vegetationCandidates: vegetation.vegetationCandidates,
        rockCandidates: rocks.rockCandidates,
        timings: Object.freeze({
          vegetationMs: vegetation.timings.vegetationMs,
          rockMs: rocks.timings.rockMs,
        }),
      });
    },
  });
}

export async function createFormalNaturalChunkGenerator({ worldSeed = 'KaniNingen Infinite Natural World' } = {}) {
  const naturalGenerator = await createNaturalChunkGenerator({ worldSeed });
  const candidateKernel = await createFormalNaturalCandidateKernel({
    worldSeedHash: naturalGenerator.worldSeedHash,
  });
  return Object.freeze({
    worldSeed: naturalGenerator.worldSeed,
    worldSeedHash: naturalGenerator.worldSeedHash,
    seed64: naturalGenerator.seed64,
    generatorVersion: W3_GENERATOR_VERSION,
    async generateChunk(chunkX, chunkZ, {
      stageRecorder = null,
      canonicalJsonContext = null,
      checkpoint = null,
      cooperativeCheckpoint = null,
    } = {}) {
      const generationControl = createGenerationControl(checkpoint, cooperativeCheckpoint);
      const serializationContext = canonicalJsonContext
        ?? createCanonicalJsonSerializationContext();
      const natural = stageRecorder
        ? await naturalGenerator.generateChunk(chunkX, chunkZ, {
          stageRecorder,
          canonicalJsonContext: serializationContext,
          ...(generationControl ?? {}),
        })
        : await naturalGenerator.generateChunk(chunkX, chunkZ, {
          canonicalJsonContext: serializationContext,
          ...(generationControl ?? {}),
        });
      await reachGenerationCheckpoint(generationControl);
      const naturalToken = stageRecorder?.start(CHUNK_GENERATION_STAGE.NATURAL);
      const { vegetationCandidates, rockCandidates } = await candidateKernel.generate({
        chunk: natural,
        ...(generationControl ?? {}),
      });
      await reachGenerationCheckpoint(generationControl);
      if (stageRecorder) stageRecorder.end(naturalToken);
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
      const contentHash = stageRecorder
        ? await hashW3ChunkContent(content, {
          stageRecorder,
          canonicalJsonContext: serializationContext,
        })
        : await hashW3ChunkContent(content, {
          canonicalJsonContext: serializationContext,
        });
      await reachGenerationCheckpoint(generationControl);
      const chunkData = { ...content, contentHash };
      const validation = validateW3FormalChunkData(chunkData);
      if (!validation.valid) throw new Error(`invalid W3 ChunkData: ${validation.errors.join('; ')}`);
      return chunkData;
    },
  });
}
