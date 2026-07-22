import { canonicalizeJson } from './canonical-json.js';
import { sha256Hex } from './sha256.js';
import { validateWorldSeedHash } from './seed.js';

function requiredString(value, name, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value)) throw new TypeError(`${name} is required`);
  return value;
}

function validateCommon(input, schema) {
  if (!input || typeof input !== 'object') throw new TypeError('Stable ID input is required');
  if (input.stableIdSchema !== schema) throw new TypeError(`stableIdSchema must be ${schema}`);
  if (!validateWorldSeedHash(input.worldSeedHash)) throw new TypeError('invalid worldSeedHash');
  if (!Number.isSafeInteger(input.generatorMajor) || input.generatorMajor < 0) {
    throw new TypeError('generatorMajor must be a non-negative safe integer');
  }
}

async function createId(prefix, type, canonicalInput) {
  const canonical = canonicalizeJson(canonicalInput);
  const digest = await sha256Hex(canonical);
  return Object.freeze({ stableId: `${prefix}:${type}:${digest.slice(0, 32)}`, canonicalInput: canonical });
}

export async function createWorldFeatureId(input) {
  validateCommon(input, 'wf1');
  const featureType = requiredString(input.featureType, 'featureType');
  const canonicalInput = {
    stableIdSchema: 'wf1',
    worldSeedHash: input.worldSeedHash,
    generatorMajor: input.generatorMajor,
    featureType,
    parentStableId: requiredString(input.parentStableId, 'parentStableId', true),
    purposeKey: requiredString(input.purposeKey, 'purposeKey'),
    semanticLocalKey: requiredString(input.semanticLocalKey, 'semanticLocalKey'),
  };
  return createId('wf1', featureType, canonicalInput);
}

const UNDIRECTED_RELATIONS = new Set(['connectsTo']);

export async function createFeatureEdgeId(input) {
  validateCommon(input, 'we1');
  const relationType = requiredString(input.relationType, 'relationType');
  let from = {
    featureId: requiredString(input.from?.featureId, 'from.featureId'),
    portId: requiredString(input.from?.portId, 'from.portId'),
  };
  let to = {
    featureId: requiredString(input.to?.featureId, 'to.featureId'),
    portId: requiredString(input.to?.portId, 'to.portId'),
  };
  if (UNDIRECTED_RELATIONS.has(relationType)) {
    const endpointKey = endpoint => `${endpoint.featureId}\u0000${endpoint.portId}`;
    if (endpointKey(from) > endpointKey(to)) [from, to] = [to, from];
  }
  const canonicalInput = {
    stableIdSchema: 'we1',
    worldSeedHash: input.worldSeedHash,
    generatorMajor: input.generatorMajor,
    relationType,
    from,
    to,
    semanticLocalKey: requiredString(input.semanticLocalKey, 'semanticLocalKey'),
  };
  return createId('we1', relationType, canonicalInput);
}

export function createStableIdRegistry() {
  const registry = new Map();
  return Object.freeze({
    register(result) {
      if (!result || typeof result.stableId !== 'string' || typeof result.canonicalInput !== 'string') {
        throw new TypeError('invalid Stable ID result');
      }
      const existing = registry.get(result.stableId);
      if (existing !== undefined && existing !== result.canonicalInput) {
        throw new Error(`Stable ID collision: ${result.stableId}`);
      }
      registry.set(result.stableId, result.canonicalInput);
      return result.stableId;
    },
    entries() {
      return [...registry.entries()].map(([stableId, canonicalInput]) => ({ stableId, canonicalInput }));
    },
  });
}
