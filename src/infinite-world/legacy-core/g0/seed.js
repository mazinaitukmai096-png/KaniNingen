import { isLowerHex, sha256Hex } from './sha256.js';

export function normalizeWorldSeed(input) {
  if (typeof input !== 'string') throw new TypeError('worldSeed must be a string');
  return input.normalize('NFC').trim();
}

export async function hashWorldSeed(normalizedSeed) {
  if (typeof normalizedSeed !== 'string' || normalizedSeed !== normalizeWorldSeed(normalizedSeed)) {
    throw new TypeError('worldSeed must already be normalized');
  }
  const digest = await sha256Hex(normalizedSeed);
  return Object.freeze({ worldSeedHash: `sha256:${digest}`, seed64: digest.slice(0, 16) });
}

export function validateWorldSeedHash(value) {
  return typeof value === 'string' && value.startsWith('sha256:')
    && isLowerHex(value.slice(7), 64);
}
