import {
  assertLogicalChunkCoordinate,
  createChunkKey,
  parseChunkKey,
} from './chunk-coordinates.js';

export const RUNTIME_TRANSITION_CONTRACT_SCHEMA = 'w8-runtime-transition-contract-1';

function normalizeChunkKeys(keys, label) {
  if (!Array.isArray(keys)) throw new TypeError(`${label} must be an array`);
  const normalized = keys.map(key => {
    const coordinate = parseChunkKey(key);
    return createChunkKey(coordinate.chunkX, coordinate.chunkZ);
  }).sort((left, right) => left.localeCompare(right));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate Chunk keys`);
  }
  return Object.freeze(normalized);
}

export function createChunkCoverageSignature(keys, label = 'Chunk coverage') {
  const normalized = normalizeChunkKeys(keys, label);
  return `${normalized.length}:${normalized.join('|')}`;
}

export function createRuntimeTransitionContract({
  generation,
  centerChunkX,
  centerChunkZ,
  renderedKeys,
  activeDataKeys,
} = {}) {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new RangeError('transition generation must be a positive safe integer');
  }
  const centerX = assertLogicalChunkCoordinate(centerChunkX, 'centerChunkX');
  const centerZ = assertLogicalChunkCoordinate(centerChunkZ, 'centerChunkZ');
  const centerChunkKey = createChunkKey(centerX, centerZ);
  const renderedSignature = createChunkCoverageSignature(renderedKeys, 'renderedKeys');
  const activeDataSignature = createChunkCoverageSignature(activeDataKeys, 'activeDataKeys');
  return Object.freeze({
    schemaVersion: RUNTIME_TRANSITION_CONTRACT_SCHEMA,
    generation,
    centerChunkX: centerX,
    centerChunkZ: centerZ,
    centerChunkKey,
    renderedSignature,
    activeDataSignature,
    coverageSignature: `center=${centerChunkKey};rendered=${renderedSignature};active=${activeDataSignature}`,
  });
}

export function isRuntimeTransitionContract(value) {
  if (!(value?.schemaVersion === RUNTIME_TRANSITION_CONTRACT_SCHEMA
    && Number.isSafeInteger(value.generation)
    && value.generation >= 1
    && Number.isSafeInteger(value.centerChunkX)
    && Number.isSafeInteger(value.centerChunkZ)
    && typeof value.centerChunkKey === 'string'
    && typeof value.renderedSignature === 'string'
    && typeof value.activeDataSignature === 'string'
    && typeof value.coverageSignature === 'string')) return false;
  try {
    const centerChunkX = assertLogicalChunkCoordinate(value.centerChunkX, 'centerChunkX');
    const centerChunkZ = assertLogicalChunkCoordinate(value.centerChunkZ, 'centerChunkZ');
    const centerChunkKey = createChunkKey(centerChunkX, centerChunkZ);
    return value.centerChunkKey === centerChunkKey
      && value.coverageSignature === `center=${centerChunkKey};rendered=${
        value.renderedSignature};active=${value.activeDataSignature}`;
  } catch {
    return false;
  }
}

export function sameRuntimeTransitionContract(left, right) {
  return isRuntimeTransitionContract(left)
    && isRuntimeTransitionContract(right)
    && left.generation === right.generation
    && left.centerChunkKey === right.centerChunkKey
    && left.renderedSignature === right.renderedSignature
    && left.activeDataSignature === right.activeDataSignature
    && left.coverageSignature === right.coverageSignature;
}
