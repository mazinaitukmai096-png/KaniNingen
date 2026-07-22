import { validateWorldSeedHash } from './seed.js';

export function createChunkId({ worldSeedHash, generatorMajor, chunkCoordinate }) {
  if (!validateWorldSeedHash(worldSeedHash)) throw new TypeError('invalid worldSeedHash');
  if (!Number.isSafeInteger(generatorMajor) || generatorMajor < 0) {
    throw new TypeError('generatorMajor must be a non-negative safe integer');
  }
  const x = chunkCoordinate?.x;
  const z = chunkCoordinate?.z;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) {
    throw new TypeError('chunk coordinates must be safe integers');
  }
  return `chunk-v1:${generatorMajor}:${worldSeedHash.slice(7)}:${Object.is(x, -0) ? 0 : x}:${Object.is(z, -0) ? 0 : z}`;
}
