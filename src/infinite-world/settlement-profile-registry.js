import { LEGACY_SETTLEMENT_CLASSES } from './canonical-settlement-plan.js';

export const SETTLEMENT_PROFILE_SCHEMA = 'settlement-profile-1';

const PROFILE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const LEGACY_SETTLEMENT_CLASS_SET = new Set(LEGACY_SETTLEMENT_CLASSES);

function requireProfileId(value) {
  if (typeof value !== 'string' || !PROFILE_ID_PATTERN.test(value)) {
    throw new TypeError('settlementProfileId must be a lower-case kebab-case key');
  }
  return value;
}

function immutableParameters(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('profile parameters must be finite');
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map(immutableParameters));
  if (!value || typeof value !== 'object') {
    throw new TypeError('profile parameters must contain only JSON values');
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, immutableParameters(entry)]),
  ));
}

export function validateSettlementProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Settlement profile must be an object');
  }
  if (input.schemaVersion !== SETTLEMENT_PROFILE_SCHEMA) {
    throw new TypeError(`profile.schemaVersion must be ${SETTLEMENT_PROFILE_SCHEMA}`);
  }
  if (!LEGACY_SETTLEMENT_CLASS_SET.has(input.legacySettlementClass)) {
    throw new RangeError(`unsupported legacySettlementClass: ${input.legacySettlementClass}`);
  }
  return Object.freeze({
    schemaVersion: SETTLEMENT_PROFILE_SCHEMA,
    settlementProfileId: requireProfileId(input.settlementProfileId),
    legacySettlementClass: input.legacySettlementClass,
    parameters: immutableParameters(input.parameters ?? {}),
  });
}

export class SettlementProfileRegistry {
  #profiles = new Map();
  #frozen = false;

  register(input) {
    if (this.#frozen) throw new Error('SettlementProfileRegistry is frozen');
    const profile = validateSettlementProfile(input);
    if (this.#profiles.has(profile.settlementProfileId)) {
      throw new Error(`duplicate Settlement profile: ${profile.settlementProfileId}`);
    }
    this.#profiles.set(profile.settlementProfileId, profile);
    return profile;
  }

  get(settlementProfileId) {
    return this.#profiles.get(settlementProfileId) ?? null;
  }

  list() {
    return Object.freeze([...this.#profiles.values()].sort((left, right) => (
      left.settlementProfileId.localeCompare(right.settlementProfileId)
    )));
  }

  freeze() {
    this.#frozen = true;
    return this;
  }

  get frozen() { return this.#frozen; }
}

export const createSettlementProfileRegistry = () => new SettlementProfileRegistry();
