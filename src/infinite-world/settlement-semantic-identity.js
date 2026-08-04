import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import {
  createDeterministicRandom,
  deriveLocalSeed64,
} from './legacy-core/g0/deterministic-random.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import { validateWorldSeedHash } from './legacy-core/g0/seed.js';

export const SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA = 'settlement-semantic-stable-id-1';
export const SETTLEMENT_SEMANTIC_RNG_SCHEMA = 'settlement-semantic-rng-1';

const SEMANTIC_KIND_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

export function validateSettlementSemanticStableIdInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Settlement semantic Stable ID input is required');
  }
  if (input.schemaVersion !== SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA) {
    throw new TypeError(`schemaVersion must be ${SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA}`);
  }
  if (!validateWorldSeedHash(input.worldSeedHash)) throw new TypeError('invalid worldSeedHash');
  if (typeof input.semanticKind !== 'string' || !SEMANTIC_KIND_PATTERN.test(input.semanticKind)) {
    throw new TypeError('semanticKind must be a lower-case kebab-case key');
  }
  return Object.freeze({
    schemaVersion: SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
    worldSeedHash: input.worldSeedHash,
    settlementId: requireString(input.settlementId, 'settlementId'),
    semanticKind: input.semanticKind,
    semanticLocalKey: requireString(input.semanticLocalKey, 'semanticLocalKey'),
  });
}

export async function createSettlementSemanticStableId(input) {
  const contract = validateSettlementSemanticStableIdInput(input);
  const canonicalInput = canonicalizeJson(contract);
  const digest = await sha256Hex(canonicalInput);
  return Object.freeze({
    stableId: `settlement-semantic-v1:${contract.semanticKind}:${digest.slice(0, 32)}`,
    canonicalInput,
  });
}

export async function createSemanticIdKeyedRandom({ worldSeedHash, semanticStableId }) {
  if (!validateWorldSeedHash(worldSeedHash)) throw new TypeError('invalid worldSeedHash');
  requireString(semanticStableId, 'semanticStableId');
  const seed64 = await deriveLocalSeed64({
    worldSeedHash,
    namespace: SETTLEMENT_SEMANTIC_RNG_SCHEMA,
    semanticKey: semanticStableId,
  });
  return createDeterministicRandom(seed64);
}
