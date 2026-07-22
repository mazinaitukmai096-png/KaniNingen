import { canonicalizeJson } from './canonical-json.js';
import { createChunkId } from './chunk-id.js';
import { validateGeneratorVersion } from './generator-version.js';
import { sha256Hex } from './sha256.js';
import { validateWorldSeedHash } from './seed.js';

const MATERIAL_ORDER = Object.freeze(['grass', 'drySoil', 'wetSoil', 'sand', 'rock']);
const RESOLUTIONS = new Set([17, 33, 65, 129]);
const LIMITS = Object.freeze({ biomes: 3, references: 64, local: 256, vegetation: 32, spawns: 64, ports: 32, water: 32 });

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finiteUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1
    && Math.abs(value * 1e6 - Math.round(value * 1e6)) < 1e-7;
}

function checkArray(errors, value, name, limit) {
  if (!Array.isArray(value)) errors.push(`${name} must be an array`);
  else if (value.length > limit) errors.push(`${name} exceeds limit ${limit}`);
}

function validateTerrain(errors, terrain) {
  if (!plainObject(terrain)) { errors.push('terrain must be an object'); return; }
  const x = terrain.resolution?.x;
  const z = terrain.resolution?.z;
  if (!RESOLUTIONS.has(x) || !RESOLUTIONS.has(z)) {
    errors.push('terrain resolution must use 17, 33, 65, or 129 per axis');
    return;
  }
  const count = x * z;
  if (terrain.heightUnitMeters !== 0.001) errors.push('heightUnitMeters must be 0.001');
  if (!Array.isArray(terrain.heights) || terrain.heights.length !== count) {
    errors.push(`heights length must be ${count}`);
  } else if (!terrain.heights.every(value => Number.isInteger(value) && value >= -32768 && value <= 32767)) {
    errors.push('heights must contain signed millimeter integers');
  }
  if (!Array.isArray(terrain.materialOrder)
    || terrain.materialOrder.length !== MATERIAL_ORDER.length
    || terrain.materialOrder.some((value, index) => value !== MATERIAL_ORDER[index])) {
    errors.push('materialOrder is invalid');
  }
  if (!Array.isArray(terrain.materialWeights) || terrain.materialWeights.length !== count * 5) {
    errors.push(`materialWeights length must be ${count * 5}`);
  } else {
    for (let index = 0; index < count; index += 1) {
      const weights = terrain.materialWeights.slice(index * 5, index * 5 + 5);
      if (!weights.every(finiteUnit) || Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) > 1e-6) {
        errors.push(`materialWeights are invalid at vertex ${index}`);
        break;
      }
    }
  }
  for (const field of ['moisture', 'rockiness']) {
    if (!Array.isArray(terrain[field]) || terrain[field].length !== count
      || !terrain[field].every(finiteUnit)) errors.push(`${field} must contain ${count} unit values`);
  }
  checkArray(errors, terrain.waterBodies, 'terrain.waterBodies', LIMITS.water);
  if (Array.isArray(terrain.waterBodies) && !terrain.waterBodies.every(plainObject)) {
    errors.push('waterBodies must contain plain JSON objects');
  }
}

export function validateChunkData(value) {
  const errors = [];
  try { canonicalizeJson(value); } catch (error) { errors.push(error.message); }
  if (!plainObject(value)) return Object.freeze({ valid: false, errors: Object.freeze([...errors, 'ChunkData must be an object']) });
  if (value.schemaVersion !== 'chunk-data-1') errors.push('schemaVersion must be chunk-data-1');
  const version = validateGeneratorVersion(value.generatorVersion);
  errors.push(...version.errors);
  if (!validateWorldSeedHash(value.worldSeedHash)) errors.push('invalid worldSeedHash');
  if (!plainObject(value.chunkCoordinate)
    || !Number.isSafeInteger(value.chunkCoordinate.x) || !Number.isSafeInteger(value.chunkCoordinate.z)) {
    errors.push('chunkCoordinate must contain safe integer x and z');
  }
  if (version.valid && validateWorldSeedHash(value.worldSeedHash) && plainObject(value.chunkCoordinate)) {
    try {
      const expected = createChunkId({
        worldSeedHash: value.worldSeedHash,
        generatorMajor: value.generatorVersion.major,
        chunkCoordinate: value.chunkCoordinate,
      });
      if (value.chunkId !== expected) errors.push('chunkId does not match world, major, and coordinates');
    } catch (error) { errors.push(error.message); }
  }
  if (!plainObject(value.bounds)
    || !['minX', 'minZ', 'maxX', 'maxZ'].every(key => Number.isFinite(value.bounds[key]))
    || value.bounds.maxX <= value.bounds.minX || value.bounds.maxZ <= value.bounds.minZ) {
    errors.push('bounds must be a finite positive 2D extent');
  }
  checkArray(errors, value.biomeMemberships, 'biomeMemberships', LIMITS.biomes);
  if (Array.isArray(value.biomeMemberships)) {
    if (!value.biomeMemberships.every(item => plainObject(item) && typeof item.biomeId === 'string'
      && item.biomeId && finiteUnit(item.weight))) errors.push('biomeMemberships are invalid');
    else if (Math.abs(value.biomeMemberships.reduce((sum, item) => sum + item.weight, 0) - 1) > 1e-6) {
      errors.push('biomeMembership weights must sum to 1');
    }
  }
  validateTerrain(errors, value.terrain);
  checkArray(errors, value.featureReferences, 'featureReferences', LIMITS.references);
  checkArray(errors, value.localFeatures, 'localFeatures', LIMITS.local);
  checkArray(errors, value.vegetationZones, 'vegetationZones', LIMITS.vegetation);
  checkArray(errors, value.spawnCandidates, 'spawnCandidates', LIMITS.spawns);
  for (const field of ['featureReferences', 'localFeatures', 'vegetationZones', 'spawnCandidates']) {
    if (Array.isArray(value[field]) && !value[field].every(plainObject)) errors.push(`${field} must contain plain objects`);
  }
  if (!plainObject(value.adjacency)) errors.push('adjacency must be an object');
  else for (const direction of ['north', 'east', 'south', 'west']) {
    const edge = value.adjacency[direction];
    if (!plainObject(edge) || typeof edge.terrainEdgeHash !== 'string'
      || !Array.isArray(edge.featurePorts) || edge.featurePorts.length > LIMITS.ports
      || !edge.featurePorts.every(plainObject)) errors.push(`adjacency.${direction} is invalid`);
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function canonicalizeChunkData(chunk) {
  const validation = validateChunkData(chunk);
  if (!validation.valid) throw new TypeError(validation.errors.join('; '));
  return canonicalizeJson(chunk);
}

export async function hashCanonicalChunkData(chunk) {
  return `sha256:${await sha256Hex(canonicalizeChunkData(chunk))}`;
}

// Diagnostic compatibility alias. World identity must use G1 hashChunkOutput().
export async function hashChunkData(chunk) {
  return hashCanonicalChunkData(chunk);
}

export function roundTripChunkData(chunk) {
  const validation = validateChunkData(chunk);
  if (!validation.valid) throw new TypeError(validation.errors.join('; '));
  const result = JSON.parse(canonicalizeJson(chunk));
  const resultValidation = validateChunkData(result);
  if (!resultValidation.valid) throw new Error('ChunkData changed during JSON round-trip');
  return result;
}
