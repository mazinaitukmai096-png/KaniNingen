import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
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

export const W2_GENERATOR_VERSION = parseGeneratorVersion('200.0.0');
export const W2_CHUNK_DATA_SCHEMA = 'w2-natural-chunk-data-1';
export const W2_TERRAIN_RESOLUTION = 33;
const TERRAIN_STEP_METERS = LOGICAL_CHUNK_SIZE_METERS / (W2_TERRAIN_RESOLUTION - 1);
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

function generateNaturalTerrain({ chunkX, chunkZ, macroEvaluator, biomeEvaluator }) {
  const originX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const originZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const extended = new Array(EXTENDED_RESOLUTION * EXTENDED_RESOLUTION);
  for (let z = -1; z <= W2_TERRAIN_RESOLUTION; z += 1) {
    for (let x = -1; x <= W2_TERRAIN_RESOLUTION; x += 1) {
      extended[extendedIndex(x, z)] = macroEvaluator.evaluate(
        originX + x * TERRAIN_STEP_METERS,
        originZ + z * TERRAIN_STEP_METERS,
      );
    }
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
      const dx = (east - west) * HEIGHT_UNIT_METERS / (2 * TERRAIN_STEP_METERS);
      const dz = (south - north) * HEIGHT_UNIT_METERS / (2 * TERRAIN_STEP_METERS);
      const slope = q6(Math.hypot(dx, dz));
      const position = {
        x: originX + x * TERRAIN_STEP_METERS,
        z: originZ + z * TERRAIN_STEP_METERS,
      };
      const biome = biomeEvaluator.evaluate(position, macro, slope);
      const heightMm = normalizeTerrainHeight(400 + macro.offsetMm);
      const ridge = clamp(macro.components.ridgesMm / G5_MACRO_TERRAIN.ridges.amplitudeMm);
      const steep = clamp(slope / Math.max(0.001, G5_MACRO_TERRAIN.maximumSlope));
      const rockinessValue = q6(clamp(0.035 + ridge * 0.36 + steep * 0.58));
      const moistureValue = q6(clamp(biome.climate.moisture
        + clamp(-macro.components.valleysMm / G5_MACRO_TERRAIN.valleys.amplitudeMm) * 0.12
        - ridge * 0.09));
      heights.push(heightMm);
      finalSlopes.push(slope);
      moisture.push(moistureValue);
      rockiness.push(rockinessValue);
      materialWeights.push(...naturalMaterialWeights(
        biome.memberships,
        moistureValue,
        rockinessValue,
        slope,
      ));
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
    }
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

export async function hashW2ChunkContent(content) {
  return `sha256:${await sha256Hex(canonicalizeJson(content))}`;
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
    async generateChunk(chunkXInput, chunkZInput) {
      const chunkX = assertLogicalChunkCoordinate(chunkXInput, 'chunkX');
      const chunkZ = assertLogicalChunkCoordinate(chunkZInput, 'chunkZ');
      const chunkId = createChunkId({
        worldSeedHash,
        generatorMajor: W2_GENERATOR_VERSION.major,
        chunkCoordinate: { x: chunkX, z: chunkZ },
      });
      const natural = generateNaturalTerrain({ chunkX, chunkZ, macroEvaluator, biomeEvaluator });
      const edgeData = await createEdgeData(natural.terrain);
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
      const chunkData = { ...content, contentHash: await hashW2ChunkContent(content) };
      const validation = validateW2NaturalChunkData(chunkData);
      if (!validation.valid) throw new Error(`invalid W2 ChunkData: ${validation.errors.join('; ')}`);
      return chunkData;
    },
  });
}
