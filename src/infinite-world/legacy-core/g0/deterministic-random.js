import { canonicalizeJson } from './canonical-json.js';
import { isLowerHex, sha256Hex } from './sha256.js';
import { validateWorldSeedHash } from './seed.js';

export async function deriveLocalSeed64({ worldSeedHash, namespace, semanticKey }) {
  if (!validateWorldSeedHash(worldSeedHash)) throw new TypeError('invalid worldSeedHash');
  if (typeof namespace !== 'string' || !namespace) throw new TypeError('namespace is required');
  if (typeof semanticKey !== 'string') throw new TypeError('semanticKey must be a string');
  const digest = await sha256Hex(canonicalizeJson({
    schema: 'local-seed-v1', worldSeedHash, namespace, semanticKey,
  }));
  return digest.slice(0, 16);
}

async function keyedUint64(seed64, key) {
  if (!isLowerHex(seed64, 16)) throw new TypeError('seed64 must be 16 lowercase hex digits');
  if (typeof key !== 'string') throw new TypeError('random key must be a string');
  const digest = await sha256Hex(canonicalizeJson({ schema: 'random-v1', seed64, key }));
  return BigInt(`0x${digest.slice(0, 16)}`);
}

export function createDeterministicRandom(seed64) {
  if (!isLowerHex(seed64, 16)) throw new TypeError('seed64 must be 16 lowercase hex digits');
  return Object.freeze({
    uint64: key => keyedUint64(seed64, key),
    async float01(key) {
      const value = await keyedUint64(seed64, key);
      return Number(value >> 11n) / 0x20_0000_0000_0000;
    },
    async integer(key, minimum, maximum) {
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
        throw new RangeError('integer bounds must be ordered safe integers');
      }
      const span = BigInt(maximum - minimum + 1);
      return minimum + Number(await keyedUint64(seed64, key) % span);
    },
  });
}
