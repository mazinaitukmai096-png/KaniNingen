import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { canonicalizeJsonWithContext } from './canonical-json-serialization-context.js';
import { createChunkId } from './legacy-core/g0/chunk-id.js';
import { parseGeneratorVersion } from './legacy-core/g0/generator-version.js';
import { hashWorldSeed, normalizeWorldSeed } from './legacy-core/g0/seed.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import { hashTerrainEdge, extractTerrainEdge } from './legacy-core/g2/terrain-edge.js';
import { createMacroTerrainEvaluator, G5_MACRO_TERRAIN } from './legacy-core/g5/macro-terrain.js';
import {
  LOGICAL_CHUNK_SIZE_METERS,
  RENDER_CHUNK_SIZE,
  assertLogicalChunkCoordinate,
} from './chunk-coordinates.js';
import {
  NATURAL_BIOME_DEFINITIONS,
  NATURAL_BIOME_ORDER,
  createNaturalBiomeEvaluator,
  naturalMaterialWeights,
  summarizeNaturalBiomeSamples,
} from './natural-biome-field.js';
import {
  CHUNK_GENERATION_STAGE,
  measureChunkGenerationStage,
  measureChunkGenerationStageSync,
} from './chunk-generation-stage-timing.js';

export const W2_GENERATOR_VERSION = parseGeneratorVersion('200.0.0');
export const W2_CHUNK_DATA_SCHEMA = 'w2-natural-chunk-data-1';
export const W2_TERRAIN_RESOLUTION = 33;
export const W2_TERRAIN_STEP_METERS =
  LOGICAL_CHUNK_SIZE_METERS / (W2_TERRAIN_RESOLUTION - 1);
const TERRAIN_STEP_METERS = W2_TERRAIN_STEP_METERS;
const HEIGHT_UNIT_METERS = 0.001;
const EXTENDED_RESOLUTION = W2_TERRAIN_RESOLUTION + 2;
const NATURAL_MATERIAL_ORDER = Object.freeze(['grass', 'drySoil', 'wetSoil', 'sand', 'rock']);
const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const clamp = value => Math.max(0, Math.min(1, value));

function extendedIndex(x, z) {
  return (z + 1) * EXTENDED_RESOLUTION + x + 1;
}

function normalizeTerrainHeight(value) {
  const rounded = Math.round(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Shared source of truth for one canonical 0.5 m Natural lattice sample.
 * Dense W2 generation and the lightweight Presentation sampler both call this
 * function; only the surrounding materialization strategy differs.
 */
export function resolveCanonicalNaturalLatticeSample({
  position,
  macro,
  eastOffsetMm,
  westOffsetMm,
  southOffsetMm,
  northOffsetMm,
  biomeEvaluator,
}) {
  if (![position?.x, position?.z, macro?.offsetMm, eastOffsetMm, westOffsetMm,
    southOffsetMm, northOffsetMm].every(Number.isFinite)
    || typeof biomeEvaluator?.evaluateMoisture !== 'function'
    || typeof biomeEvaluator?.evaluateWithMoisture !== 'function') {
    throw new TypeError('canonical Natural lattice inputs are required');
  }
  const climateMoisture = biomeEvaluator.evaluateMoisture(position);
  const core = resolveCanonicalNaturalLatticeCoreSample({
    position,
    macro,
    eastOffsetMm,
    westOffsetMm,
    southOffsetMm,
    northOffsetMm,
    climateMoisture,
  });
  const biome = biomeEvaluator.evaluateWithMoisture(
    position,
    macro,
    core.slope,
    climateMoisture,
  );
  return Object.freeze({
    ...core,
    materialWeights: Object.freeze(naturalMaterialWeights(
      biome.memberships,
      core.moisture,
      core.rockiness,
      core.slope,
    )),
    biome,
  });
}

export function resolveCanonicalNaturalLatticeCoreSample({
  position,
  macro,
  eastOffsetMm,
  westOffsetMm,
  southOffsetMm,
  northOffsetMm,
  climateMoisture,
}) {
  if (![position?.x, position?.z, macro?.offsetMm, eastOffsetMm, westOffsetMm,
    southOffsetMm, northOffsetMm, climateMoisture].every(Number.isFinite)) {
    throw new TypeError('canonical Natural lattice core inputs are required');
  }
  const dx = (eastOffsetMm - westOffsetMm) * HEIGHT_UNIT_METERS
    / (2 * TERRAIN_STEP_METERS);
  const dz = (southOffsetMm - northOffsetMm) * HEIGHT_UNIT_METERS
    / (2 * TERRAIN_STEP_METERS);
  const slope = q6(Math.hypot(dx, dz));
  const heightMm = normalizeTerrainHeight(400 + macro.offsetMm);
  const ridge = clamp(macro.components.ridgesMm / G5_MACRO_TERRAIN.ridges.amplitudeMm);
  const steep = clamp(slope / Math.max(0.001, G5_MACRO_TERRAIN.maximumSlope));
  return Object.freeze({
    heightMm,
    slope,
    moisture: q6(clamp(climateMoisture
      + clamp(-macro.components.valleysMm / G5_MACRO_TERRAIN.valleys.amplitudeMm) * 0.12
      - ridge * 0.09)),
    rockiness: q6(clamp(0.035 + ridge * 0.36 + steep * 0.58)),
  });
}

export function createCanonicalNaturalSamplingKernel({ macroEvaluator, biomeEvaluator }) {
  if (typeof macroEvaluator?.evaluate !== 'function'
    || typeof biomeEvaluator?.evaluate !== 'function') {
    throw new TypeError('macro and biome evaluators are required');
  }
  const resolveLattice = (worldX, worldZ, macroAt) => {
    if (![worldX, worldZ].every(Number.isFinite)) {
      throw new TypeError('finite Natural lattice coordinates are required');
    }
    const macro = macroAt(worldX, worldZ);
    return resolveCanonicalNaturalLatticeSample({
      position: { x: worldX, z: worldZ },
      macro,
      eastOffsetMm: macroAt(worldX + TERRAIN_STEP_METERS, worldZ).offsetMm,
      westOffsetMm: macroAt(worldX - TERRAIN_STEP_METERS, worldZ).offsetMm,
      southOffsetMm: macroAt(worldX, worldZ + TERRAIN_STEP_METERS).offsetMm,
      northOffsetMm: macroAt(worldX, worldZ - TERRAIN_STEP_METERS).offsetMm,
      biomeEvaluator,
    });
  };
  const sampleLattice = (worldX, worldZ) => resolveLattice(
    worldX,
    worldZ,
    (x, z) => macroEvaluator.evaluate(x, z),
  );
  const createOwnerSampler = (chunkX, chunkZ) => {
    assertLogicalChunkCoordinate(chunkX, 'chunkX');
    assertLogicalChunkCoordinate(chunkZ, 'chunkZ');
    const originX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const coreCache = new Map();
    // Sparse vegetation consumers need biome memberships, but not the material
    // weights required by Rock/Full generation. Resolve those two layers lazily
    // so Tree-only cells do not materialize 25 unused material samples per owner.
    const biomeCache = new Map();
    const fullCache = new Map();
    const macroCache = new Map();
    const macroAt = (worldX, worldZ) => {
      const gridX = Math.round((worldX - originX) / TERRAIN_STEP_METERS);
      const gridZ = Math.round((worldZ - originZ) / TERRAIN_STEP_METERS);
      const key = (gridZ + 2) * 40 + gridX + 2;
      let sample = macroCache.get(key);
      if (!sample) {
        sample = macroEvaluator.evaluate(worldX, worldZ);
        macroCache.set(key, sample);
      }
      return sample;
    };
    const latticeCoordinates = (x, z) => {
      const boundedX = Math.max(0, Math.min(W2_TERRAIN_RESOLUTION - 1, x));
      const boundedZ = Math.max(0, Math.min(W2_TERRAIN_RESOLUTION - 1, z));
      return {
        boundedX,
        boundedZ,
        key: boundedZ * W2_TERRAIN_RESOLUTION + boundedX,
      };
    };
    const coreAt = (x, z) => {
      const { boundedX, boundedZ, key } = latticeCoordinates(x, z);
      let sample = coreCache.get(key);
      if (!sample) {
        const position = {
          x: originX + boundedX * TERRAIN_STEP_METERS,
          z: originZ + boundedZ * TERRAIN_STEP_METERS,
        };
        const macro = macroAt(position.x, position.z);
        const climateMoisture = biomeEvaluator.evaluateMoisture(position);
        sample = Object.freeze({
          ...resolveCanonicalNaturalLatticeCoreSample({
            position,
            macro,
            eastOffsetMm: macroAt(position.x + TERRAIN_STEP_METERS, position.z).offsetMm,
            westOffsetMm: macroAt(position.x - TERRAIN_STEP_METERS, position.z).offsetMm,
            southOffsetMm: macroAt(position.x, position.z + TERRAIN_STEP_METERS).offsetMm,
            northOffsetMm: macroAt(position.x, position.z - TERRAIN_STEP_METERS).offsetMm,
            climateMoisture,
          }),
          position,
          macro,
          climateMoisture,
        });
        coreCache.set(key, sample);
      }
      return sample;
    };
    const biomeAt = (x, z) => {
      const { key } = latticeCoordinates(x, z);
      let biome = biomeCache.get(key);
      if (!biome) {
        const core = coreAt(x, z);
        biome = biomeEvaluator.evaluateWithMoisture(
          core.position,
          core.macro,
          core.slope,
          core.climateMoisture,
        );
        biomeCache.set(key, biome);
      }
      return biome;
    };
    const fullAt = (x, z) => {
      const { key } = latticeCoordinates(x, z);
      let sample = fullCache.get(key);
      if (!sample) {
        const core = coreAt(x, z);
        const biome = biomeAt(x, z);
        sample = Object.freeze({
          ...core,
          biome,
          materialWeights: Object.freeze(naturalMaterialWeights(
            biome.memberships,
            core.moisture,
            core.rockiness,
            core.slope,
          )),
        });
        fullCache.set(key, sample);
      }
      return sample;
    };
    const coordinates = point => {
      const localX = point.x - originX;
      const localZ = point.z - originZ;
      const fx = clamp(localX / LOGICAL_CHUNK_SIZE_METERS)
        * (W2_TERRAIN_RESOLUTION - 1);
      const fz = clamp(localZ / LOGICAL_CHUNK_SIZE_METERS)
        * (W2_TERRAIN_RESOLUTION - 1);
      const x0 = Math.floor(fx); const z0 = Math.floor(fz);
      return {
        x0,
        z0,
        x1: Math.min(x0 + 1, W2_TERRAIN_RESOLUTION - 1),
        z1: Math.min(z0 + 1, W2_TERRAIN_RESOLUTION - 1),
        tx: fx - x0,
        tz: fz - z0,
      };
    };
    const interpolate = (point, select, sampleAt = coreAt) => {
      const { x0, z0, x1, z1, tx, tz } = coordinates(point);
      const northwest = select(sampleAt(x0, z0));
      const northeast = select(sampleAt(x1, z0));
      const southwest = select(sampleAt(x0, z1));
      const southeast = select(sampleAt(x1, z1));
      return (northwest * (1 - tx) + northeast * tx) * (1 - tz)
        + (southwest * (1 - tx) + southeast * tx) * tz;
    };
    const biomeSampleAt = (x, z) => biomeAt(x * 8, z * 8);
    const sampleBiomeWeights = point => {
      const localX = point.x - originX;
      const localZ = point.z - originZ;
      const fx = clamp(localX / LOGICAL_CHUNK_SIZE_METERS) * 4;
      const fz = clamp(localZ / LOGICAL_CHUNK_SIZE_METERS) * 4;
      const x0 = Math.floor(fx); const z0 = Math.floor(fz);
      const x1 = Math.min(x0 + 1, 4); const z1 = Math.min(z0 + 1, 4);
      const tx = fx - x0; const tz = fz - z0;
      const weight = (x, z, biomeId) => biomeSampleAt(x, z).memberships
        .find(item => item.biomeId === biomeId)?.weight ?? 0;
      return NATURAL_BIOME_ORDER.map(biomeId => ({
        biomeId,
        weight: q6((weight(x0, z0, biomeId) * (1 - tx)
          + weight(x1, z0, biomeId) * tx) * (1 - tz)
          + (weight(x0, z1, biomeId) * (1 - tx)
            + weight(x1, z1, biomeId) * tx) * tz),
      }));
    };
    return Object.freeze({
      chunkX,
      chunkZ,
      sampleTerrain(point, { includeMaterials = true } = {}) {
        const result = {
          height: q6(interpolate(point, sample => sample.heightMm) * HEIGHT_UNIT_METERS),
          slope: q6(interpolate(point, sample => sample.slope)),
          moisture: q6(interpolate(point, sample => sample.moisture)),
          rockiness: q6(interpolate(point, sample => sample.rockiness)),
        };
        if (includeMaterials) {
          result.grassMaterial = q6(interpolate(
            point,
            sample => sample.materialWeights[0],
            fullAt,
          ));
          result.rockMaterial = q6(interpolate(
            point,
            sample => sample.materialWeights[4],
            fullAt,
          ));
        }
        return Object.freeze(result);
      },
      sampleBiomeWeights,
      sampleNaturalHeightMeters(worldX, worldZ) {
        const point = { x: worldX, z: worldZ };
        const { x0, z0, x1, z1, tx, tz } = coordinates(point);
        const northwest = coreAt(x0, z0).heightMm * HEIGHT_UNIT_METERS;
        const northeast = coreAt(x1, z0).heightMm * HEIGHT_UNIT_METERS;
        const southwest = coreAt(x0, z1).heightMm * HEIGHT_UNIT_METERS;
        const southeast = coreAt(x1, z1).heightMm * HEIGHT_UNIT_METERS;
        if (tx + tz <= 1) {
          return northwest + tx * (northeast - northwest)
            + tz * (southwest - northwest);
        }
        return northeast * (1 - tz) + southwest * (1 - tx)
          + southeast * (tx + tz - 1);
      },
      snapshot() {
        return Object.freeze({
          latticeSampleCount: coreCache.size,
          fullBiomeSampleCount: biomeCache.size,
          macroSampleCount: macroCache.size,
        });
      },
    });
  };
  return Object.freeze({ sampleLattice, createOwnerSampler });
}

export async function createSharedCanonicalNaturalKernel({ worldSeedHash }) {
  if (typeof worldSeedHash !== 'string' || !worldSeedHash) {
    throw new TypeError('worldSeedHash is required');
  }
  const [macroEvaluator, biomeEvaluator] = await Promise.all([
    createMacroTerrainEvaluator(worldSeedHash),
    createNaturalBiomeEvaluator({ worldSeedHash }),
  ]);
  return createCanonicalNaturalSamplingKernel({ macroEvaluator, biomeEvaluator });
}

async function createEdgeData(terrain) {
  const entries = await Promise.all(['north', 'east', 'south', 'west'].map(async edge => [
    edge,
    {
      schemaVersion: 'w2-natural-edge-data-1',
      hash: await hashTerrainEdge(terrain, edge),
      terrainEdge: extractTerrainEdge(terrain, edge),
    },
  ]));
  return Object.fromEntries(entries);
}

function createGenerationControl(checkpoint = null, cooperativeCheckpoint = null) {
  if (checkpoint !== null && typeof checkpoint !== 'function') {
    throw new TypeError('Natural generation checkpoint must be a function when provided');
  }
  if (cooperativeCheckpoint !== null && typeof cooperativeCheckpoint !== 'function') {
    throw new TypeError('Natural cooperative checkpoint must be a function when provided');
  }
  return checkpoint || cooperativeCheckpoint
    ? Object.freeze({ checkpoint, cooperativeCheckpoint }) : null;
}

async function reachGenerationCheckpoint(control) {
  if (!control) return;
  if (control.cooperativeCheckpoint) await control.cooperativeCheckpoint();
  else control.checkpoint?.();
}

async function generateNaturalTerrain({
  chunkX,
  chunkZ,
  macroEvaluator,
  biomeEvaluator,
  generationControl = null,
}) {
  const originX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const originZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const extended = new Array(EXTENDED_RESOLUTION * EXTENDED_RESOLUTION);
  for (let z = -1; z <= W2_TERRAIN_RESOLUTION; z += 1) {
    for (let x = -1; x <= W2_TERRAIN_RESOLUTION; x += 1) {
      extended[extendedIndex(x, z)] = macroEvaluator.evaluate(
        originX + x * TERRAIN_STEP_METERS,
        originZ + z * TERRAIN_STEP_METERS,
      );
      if ((x + 2) % 8 === 0) await reachGenerationCheckpoint(generationControl);
    }
    await reachGenerationCheckpoint(generationControl);
  }

  const heights = [];
  const finalSlopes = [];
  const materialWeights = [];
  const moisture = [];
  const rockiness = [];
  const biomeSamples = [];
  let minimumHeightMm = Infinity;
  let maximumHeightMm = -Infinity;

  for (let z = 0; z < W2_TERRAIN_RESOLUTION; z += 1) {
    for (let x = 0; x < W2_TERRAIN_RESOLUTION; x += 1) {
      const macro = extended[extendedIndex(x, z)];
      const east = extended[extendedIndex(x + 1, z)].offsetMm;
      const west = extended[extendedIndex(x - 1, z)].offsetMm;
      const south = extended[extendedIndex(x, z + 1)].offsetMm;
      const north = extended[extendedIndex(x, z - 1)].offsetMm;
      const position = {
        x: originX + x * TERRAIN_STEP_METERS,
        z: originZ + z * TERRAIN_STEP_METERS,
      };
      const sample = resolveCanonicalNaturalLatticeSample({
        position,
        macro,
        eastOffsetMm: east,
        westOffsetMm: west,
        southOffsetMm: south,
        northOffsetMm: north,
        biomeEvaluator,
      });
      const { biome, heightMm, slope } = sample;
      const rockinessValue = sample.rockiness;
      const moistureValue = sample.moisture;
      heights.push(heightMm);
      finalSlopes.push(slope);
      moisture.push(moistureValue);
      rockiness.push(rockinessValue);
      materialWeights.push(...sample.materialWeights);
      minimumHeightMm = Math.min(minimumHeightMm, heightMm);
      maximumHeightMm = Math.max(maximumHeightMm, heightMm);
      if (x % 8 === 0 && z % 8 === 0) {
        biomeSamples.push(Object.freeze({
          position: Object.freeze(position),
          memberships: biome.memberships,
          primaryBiomeId: biome.primaryBiomeId,
          climate: biome.climate,
        }));
      }
      if ((x + 1) % 8 === 0) await reachGenerationCheckpoint(generationControl);
    }
    await reachGenerationCheckpoint(generationControl);
  }

  return {
    terrain: {
      schemaVersion: 'w2-natural-terrain-1',
      resolution: { x: W2_TERRAIN_RESOLUTION, z: W2_TERRAIN_RESOLUTION },
      heightUnitMeters: HEIGHT_UNIT_METERS,
      sampleSpacingMeters: TERRAIN_STEP_METERS,
      materialOrder: [...NATURAL_MATERIAL_ORDER],
      heights,
      finalSlopes,
      materialWeights,
      moisture,
      rockiness,
      waterBodies: [],
      heightRangeMeters: {
        minimum: q6(minimumHeightMm * HEIGHT_UNIT_METERS),
        maximum: q6(maximumHeightMm * HEIGHT_UNIT_METERS),
      },
    },
    biomeField: summarizeNaturalBiomeSamples(biomeSamples, 5),
  };
}

export async function hashW2ChunkContent(content, {
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

export function validateW2NaturalChunkData(chunkData) {
  const errors = [];
  if (!chunkData || typeof chunkData !== 'object') return Object.freeze({ valid: false, errors: ['ChunkData is required'] });
  if (chunkData.schemaVersion !== W2_CHUNK_DATA_SCHEMA) errors.push('invalid W2 ChunkData schema');
  if (chunkData.generatorVersion?.id !== W2_GENERATOR_VERSION.id) errors.push('invalid W2 generator version');
  if (!Number.isSafeInteger(chunkData.chunkX) || !Number.isSafeInteger(chunkData.chunkZ)) errors.push('invalid chunk coordinates');
  if (chunkData.logicalChunkSizeMeters !== LOGICAL_CHUNK_SIZE_METERS) errors.push('invalid logical chunk size');
  if (chunkData.renderChunkSize !== RENDER_CHUNK_SIZE) errors.push('invalid render chunk size');
  const terrain = chunkData.terrain;
  const count = W2_TERRAIN_RESOLUTION ** 2;
  if (terrain?.resolution?.x !== W2_TERRAIN_RESOLUTION || terrain?.resolution?.z !== W2_TERRAIN_RESOLUTION) errors.push('terrain must be 33x33');
  for (const [name, values, expected] of [
    ['heights', terrain?.heights, count],
    ['finalSlopes', terrain?.finalSlopes, count],
    ['materialWeights', terrain?.materialWeights, count * 5],
    ['moisture', terrain?.moisture, count],
    ['rockiness', terrain?.rockiness, count],
  ]) {
    if (!Array.isArray(values) || values.length !== expected || !values.every(Number.isFinite)) errors.push(`invalid terrain ${name}`);
  }
  if (Array.isArray(terrain?.materialWeights)) {
    for (let index = 0; index < count; index += 1) {
      const weights = terrain.materialWeights.slice(index * 5, index * 5 + 5);
      if (weights.some(value => value < 0 || value > 1)
        || Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) > 0.0000011) {
        errors.push(`invalid material weights at ${index}`);
        break;
      }
    }
  }
  if (!NATURAL_BIOME_ORDER.includes(chunkData.biomeField?.primaryBiomeId)) errors.push('invalid primary natural biome');
  if (!Array.isArray(chunkData.biomeField?.samples) || chunkData.biomeField.samples.length !== 25) errors.push('invalid natural biome samples');
  if ((chunkData.vegetationProxies?.length ?? -1) !== 0 || (chunkData.rockProxies?.length ?? -1) !== 0) errors.push('W2 must not contain vegetation/rock outputs');
  for (const edge of ['north', 'east', 'south', 'west']) {
    if (!/^sha256:[0-9a-f]{64}$/.test(chunkData.edgeData?.[edge]?.hash ?? '')) errors.push(`invalid ${edge} edge data`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(chunkData.contentHash ?? '')) errors.push('invalid contentHash');
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export async function createNaturalChunkGenerator({ worldSeed = 'KaniNingen Infinite Natural World' } = {}) {
  const normalizedWorldSeed = normalizeWorldSeed(worldSeed);
  const { worldSeedHash, seed64 } = await hashWorldSeed(normalizedWorldSeed);
  const [macroEvaluator, biomeEvaluator] = await Promise.all([
    createMacroTerrainEvaluator(worldSeedHash),
    createNaturalBiomeEvaluator({ worldSeedHash }),
  ]);
  return Object.freeze({
    worldSeed: normalizedWorldSeed,
    worldSeedHash,
    seed64,
    generatorVersion: W2_GENERATOR_VERSION,
    async generateChunk(chunkXInput, chunkZInput, {
      stageRecorder = null,
      canonicalJsonContext = null,
      checkpoint = null,
      cooperativeCheckpoint = null,
    } = {}) {
      const chunkX = assertLogicalChunkCoordinate(chunkXInput, 'chunkX');
      const chunkZ = assertLogicalChunkCoordinate(chunkZInput, 'chunkZ');
      const chunkId = createChunkId({
        worldSeedHash,
        generatorMajor: W2_GENERATOR_VERSION.major,
        chunkCoordinate: { x: chunkX, z: chunkZ },
      });
      const generationControl = createGenerationControl(checkpoint, cooperativeCheckpoint);
      const generateTerrain = () => generateNaturalTerrain({
        chunkX,
        chunkZ,
        macroEvaluator,
        biomeEvaluator,
        generationControl,
      });
      const natural = stageRecorder
        ? await measureChunkGenerationStage(
          stageRecorder,
          CHUNK_GENERATION_STAGE.TERRAIN,
          generateTerrain,
        )
        : await generateTerrain();
      await reachGenerationCheckpoint(generationControl);
      const edgeData = stageRecorder
        ? await measureChunkGenerationStage(
          stageRecorder,
          CHUNK_GENERATION_STAGE.HASH,
          () => createEdgeData(natural.terrain),
        )
        : await createEdgeData(natural.terrain);
      await reachGenerationCheckpoint(generationControl);
      const content = {
        schemaVersion: W2_CHUNK_DATA_SCHEMA,
        chunkId,
        chunkX,
        chunkZ,
        logicalChunkSizeMeters: LOGICAL_CHUNK_SIZE_METERS,
        renderChunkSize: RENDER_CHUNK_SIZE,
        generatorVersion: { ...W2_GENERATOR_VERSION },
        terrain: natural.terrain,
        biomeField: natural.biomeField,
        naturalBiomeDefinitions: NATURAL_BIOME_DEFINITIONS,
        vegetationProxies: [],
        rockProxies: [],
        edgeData,
        generationProof: {
          generator: 'w2-natural-terrain',
          legacyMacroTerrain: G5_MACRO_TERRAIN.schemaVersion,
          settlementConnected: false,
          gameplayConnected: false,
          formalVegetationConnected: false,
          formalRockConnected: false,
        },
      };
      const contentHash = stageRecorder
        ? await hashW2ChunkContent(content, { stageRecorder, canonicalJsonContext })
        : await hashW2ChunkContent(content, { canonicalJsonContext });
      await reachGenerationCheckpoint(generationControl);
      const chunkData = { ...content, contentHash };
      const validation = validateW2NaturalChunkData(chunkData);
      if (!validation.valid) throw new Error(`invalid W2 ChunkData: ${validation.errors.join('; ')}`);
      return chunkData;
    },
  });
}
