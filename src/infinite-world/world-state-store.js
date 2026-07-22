import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import {
  W6_ENTITY_CONTRACTS,
  W6_GAMEPLAY_SCHEMA,
  W6_INITIAL_SCALE_STAGE_ID,
  W6_PLAYER_MAX_HP,
  W6_SAVE_ENVELOPE_SCHEMA,
  W6_SAVE_SCHEMA,
  W6_SAVE_VERSION,
  W6_STATIC_TARGET_CONTRACTS,
  createW6PlayerState,
  isW6ScaleStageId,
} from './gameplay-contract.js';
import { parseChunkKey } from './chunk-coordinates.js';

const FEATURE_MAX_HP_VALUES = new Set(
  Object.values(W6_STATIC_TARGET_CONTRACTS).map(contract => contract.maxHp),
);

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be non-negative`);
  return value;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
  return value;
}

function sortedRecords(map) {
  return [...map.values()].sort((a, b) => a.stableId.localeCompare(b.stableId));
}

function cloneRecord(value) {
  return { ...value };
}

function validatePlayer(player) {
  if (!player || typeof player !== 'object') throw new TypeError('save player is required');
  const maxHp = nonNegative(player.maxHp, 'player.maxHp');
  const hp = nonNegative(player.hp, 'player.hp');
  if (maxHp !== W6_PLAYER_MAX_HP) throw new Error('player.maxHp does not match the protected Gameplay contract');
  if (hp > maxHp) throw new RangeError('player.hp exceeds player.maxHp');
  return {
    x: finite(player.x, 'player.x'),
    z: finite(player.z, 'player.z'),
    hp,
    maxHp,
    score: nonNegative(player.score, 'player.score'),
    facingY: finite(player.facingY, 'player.facingY'),
  };
}

function validateFeatureDamage(records) {
  if (!Array.isArray(records)) throw new TypeError('featureDamage must be an array');
  const result = new Map();
  for (const record of records) {
    const stableId = requiredString(record?.stableId, 'featureDamage.stableId');
    const maxHp = nonNegative(record.maxHp, 'featureDamage.maxHp');
    if (!FEATURE_MAX_HP_VALUES.has(maxHp)) throw new Error(`unknown feature maxHp: ${stableId}`);
    const damage = nonNegative(record.damage, 'featureDamage.damage');
    if (damage > maxHp) throw new RangeError(`feature damage exceeds maxHp: ${stableId}`);
    const destroyed = record.destroyed === true;
    if (destroyed !== (damage >= maxHp)) throw new Error(`feature destruction flag mismatch: ${stableId}`);
    if (result.has(stableId)) throw new Error(`duplicate feature damage Stable ID: ${stableId}`);
    result.set(stableId, { stableId, maxHp, damage, destroyed });
  }
  return result;
}

function validateEntityStates(records) {
  if (!Array.isArray(records)) throw new TypeError('entityStates must be an array');
  const result = new Map();
  for (const record of records) {
    const stableId = requiredString(record?.stableId, 'entityState.stableId');
    const maxHp = nonNegative(record.maxHp, 'entityState.maxHp');
    const hp = nonNegative(record.hp, 'entityState.hp');
    if (hp > maxHp) throw new RangeError(`entity hp exceeds maxHp: ${stableId}`);
    const alive = record.alive === true;
    if (alive !== (hp > 0)) throw new Error(`entity alive flag mismatch: ${stableId}`);
    const type = requiredString(record.type, 'entityState.type');
    const contract = W6_ENTITY_CONTRACTS[type];
    if (!contract || maxHp !== contract.maxHp || !stableId.startsWith(`wf1:${type}:`)) {
      throw new Error(`entity Gameplay contract mismatch: ${stableId}`);
    }
    const ownerChunkKey = requiredString(record.ownerChunkKey, 'entityState.ownerChunkKey');
    parseChunkKey(ownerChunkKey);
    const validated = {
      stableId,
      ownerChunkKey,
      type,
      maxHp,
      hp,
      alive,
      x: finite(record.x, 'entityState.x'),
      z: finite(record.z, 'entityState.z'),
      rotationY: finite(record.rotationY, 'entityState.rotationY'),
      aiState: requiredString(record.aiState, 'entityState.aiState'),
      aiClock: nonNegative(record.aiClock, 'entityState.aiClock'),
    };
    if (result.has(stableId)) throw new Error(`duplicate entity Stable ID: ${stableId}`);
    result.set(stableId, validated);
  }
  return result;
}

export class InfiniteWorldState {
  constructor({ worldSeedHash, playerSpawn } = {}) {
    this.worldSeedHash = requiredString(worldSeedHash, 'worldSeedHash');
    this.activeScaleStageId = W6_INITIAL_SCALE_STAGE_ID;
    this.player = cloneRecord(createW6PlayerState(playerSpawn));
    this.featureDamage = new Map();
    this.entityStates = new Map();
    this.manualBossStableId = null;
    this.manualBossSequence = 0;
    this.nuclearCooldownMs = 0;
    this.revision = 0;
  }

  setScaleStage(stageId) {
    if (!isW6ScaleStageId(stageId)) throw new RangeError(`unknown scale stage: ${stageId}`);
    if (this.activeScaleStageId !== stageId) {
      this.activeScaleStageId = stageId;
      this.revision += 1;
    }
    return stageId;
  }

  updatePlayer(patch) {
    const next = validatePlayer({ ...this.player, ...patch });
    Object.assign(this.player, next);
    this.revision += 1;
    return Object.freeze({ ...next });
  }

  damagePlayer(amount) {
    const damage = nonNegative(amount, 'player damage');
    if (damage === 0 || this.player.hp <= 0) return Object.freeze({ ...this.player });
    this.player.hp = Math.max(0, this.player.hp - damage);
    this.revision += 1;
    return Object.freeze({ ...this.player });
  }

  healPlayer(amount) {
    const healing = nonNegative(amount, 'player healing');
    if (healing === 0 || this.player.hp <= 0) return Object.freeze({ ...this.player });
    this.player.hp = Math.min(this.player.maxHp, this.player.hp + healing);
    this.revision += 1;
    return Object.freeze({ ...this.player });
  }

  restartRun({ playerSpawn } = {}) {
    const spawn = {
      x: finite(playerSpawn?.x, 'restart playerSpawn.x'),
      z: finite(playerSpawn?.z, 'restart playerSpawn.z'),
    };
    this.activeScaleStageId = W6_INITIAL_SCALE_STAGE_ID;
    Object.assign(this.player, createW6PlayerState(spawn));
    this.featureDamage.clear();
    this.entityStates.clear();
    this.manualBossStableId = null;
    this.manualBossSequence = 0;
    this.nuclearCooldownMs = 0;
    this.revision += 1;
    return this.snapshot();
  }

  ensureEntity(descriptor) {
    const stableId = requiredString(descriptor?.stableId, 'entity descriptor stableId');
    const existing = this.entityStates.get(stableId);
    if (existing) {
      if (existing.ownerChunkKey !== descriptor.ownerChunkKey
        || existing.type !== descriptor.type
        || existing.maxHp !== descriptor.maxHp) {
        throw new Error(`Stable ID collision or entity contract mismatch: ${stableId}`);
      }
      return existing;
    }
    const type = requiredString(descriptor.type, 'entity type');
    const contract = W6_ENTITY_CONTRACTS[type];
    if (!contract || descriptor.maxHp !== contract.maxHp || !stableId.startsWith(`wf1:${type}:`)) {
      throw new Error(`entity Gameplay contract mismatch: ${stableId}`);
    }
    const ownerChunkKey = requiredString(descriptor.ownerChunkKey, 'entity ownerChunkKey');
    parseChunkKey(ownerChunkKey);
    const state = {
      stableId,
      ownerChunkKey,
      type,
      maxHp: nonNegative(descriptor.maxHp, 'entity maxHp'),
      hp: nonNegative(descriptor.maxHp, 'entity hp'),
      alive: descriptor.maxHp > 0,
      x: finite(descriptor.x, 'entity x'),
      z: finite(descriptor.z, 'entity z'),
      rotationY: finite(descriptor.rotationY ?? 0, 'entity rotationY'),
      aiState: requiredString(descriptor.aiState ?? 'idle', 'entity aiState'),
      aiClock: 0,
    };
    this.entityStates.set(stableId, state);
    this.revision += 1;
    return state;
  }

  moveEntityOwner(stableId, ownerChunkKey) {
    const state = this.entityStates.get(requiredString(stableId, 'entity stableId'));
    if (!state) throw new Error(`unknown entity Stable ID: ${stableId}`);
    parseChunkKey(requiredString(ownerChunkKey, 'entity ownerChunkKey'));
    if (state.ownerChunkKey !== ownerChunkKey) {
      state.ownerChunkKey = ownerChunkKey;
      this.revision += 1;
    }
    return state;
  }

  setManualBoss(stableId, sequence) {
    const entity = this.entityStates.get(requiredString(stableId, 'manual Boss Stable ID'));
    if (!entity || entity.type !== 'boss') throw new Error('manual Boss must exist in the entity registry');
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('manual Boss sequence must be positive');
    this.manualBossStableId = stableId;
    this.manualBossSequence = sequence;
    this.revision += 1;
    return entity;
  }

  setNuclearCooldown(milliseconds) {
    this.nuclearCooldownMs = nonNegative(milliseconds, 'nuclear cooldown');
    this.revision += 1;
    return this.nuclearCooldownMs;
  }

  tickNuclearCooldown(deltaMilliseconds) {
    const delta = nonNegative(deltaMilliseconds, 'nuclear cooldown delta');
    if (delta === 0 || this.nuclearCooldownMs === 0) return this.nuclearCooldownMs;
    this.nuclearCooldownMs = Math.max(0, this.nuclearCooldownMs - delta);
    this.revision += 1;
    return this.nuclearCooldownMs;
  }

  damageEntity(stableId, amount) {
    const state = this.entityStates.get(requiredString(stableId, 'entity stableId'));
    if (!state) throw new Error(`unknown entity Stable ID: ${stableId}`);
    const damage = nonNegative(amount, 'entity damage');
    if (!state.alive || damage === 0) return Object.freeze({ ...state });
    state.hp = Math.max(0, state.hp - damage);
    state.alive = state.hp > 0;
    this.revision += 1;
    return Object.freeze({ ...state });
  }

  damageFeature(descriptor, amount) {
    const stableId = requiredString(descriptor?.stableId, 'feature stableId');
    const maxHp = nonNegative(descriptor.maxHp, 'feature maxHp');
    if (!FEATURE_MAX_HP_VALUES.has(maxHp)) throw new Error(`unknown feature maxHp: ${stableId}`);
    const damageAmount = nonNegative(amount, 'feature damage');
    const existing = this.featureDamage.get(stableId);
    if (existing && existing.maxHp !== maxHp) {
      throw new Error(`Stable ID collision or feature contract mismatch: ${stableId}`);
    }
    const damage = Math.min(maxHp, (existing?.damage ?? 0) + damageAmount);
    const record = { stableId, maxHp, damage, destroyed: damage >= maxHp };
    if (damage > 0) this.featureDamage.set(stableId, record);
    this.revision += 1;
    return Object.freeze({ ...record });
  }

  isFeatureDestroyed(stableId) {
    return this.featureDamage.get(stableId)?.destroyed === true;
  }

  featureHp(stableId, maxHp) {
    return Math.max(0, maxHp - (this.featureDamage.get(stableId)?.damage ?? 0));
  }

  createSaveSnapshot() {
    return {
      schemaVersion: W6_SAVE_SCHEMA,
      gameplaySchemaVersion: W6_GAMEPLAY_SCHEMA,
      saveVersion: W6_SAVE_VERSION,
      worldSeedHash: this.worldSeedHash,
      activeScaleStageId: this.activeScaleStageId,
      player: { ...this.player },
      featureDamage: sortedRecords(this.featureDamage).map(cloneRecord),
      entityStates: sortedRecords(this.entityStates).map(cloneRecord),
      manualBossStableId: this.manualBossStableId,
      manualBossSequence: this.manualBossSequence,
      nuclearCooldownMs: this.nuclearCooldownMs,
    };
  }

  restoreSaveSnapshot(snapshot) {
    if (snapshot?.schemaVersion !== W6_SAVE_SCHEMA
      || snapshot?.gameplaySchemaVersion !== W6_GAMEPLAY_SCHEMA
      || snapshot?.saveVersion !== W6_SAVE_VERSION) {
      throw new Error('unsupported Infinite World save schema or version');
    }
    if (snapshot.worldSeedHash !== this.worldSeedHash) throw new Error('save world seed does not match runtime');
    if (!isW6ScaleStageId(snapshot.activeScaleStageId)) throw new Error('invalid saved scale stage');
    const player = validatePlayer(snapshot.player);
    const featureDamage = validateFeatureDamage(snapshot.featureDamage);
    const entityStates = validateEntityStates(snapshot.entityStates);
    const manualBossStableId = snapshot.manualBossStableId ?? null;
    const manualBossSequence = snapshot.manualBossSequence ?? 0;
    const nuclearCooldownMs = nonNegative(snapshot.nuclearCooldownMs ?? 0, 'nuclearCooldownMs');
    if (!Number.isSafeInteger(manualBossSequence) || manualBossSequence < 0) {
      throw new TypeError('manualBossSequence must be a non-negative integer');
    }
    if (manualBossStableId !== null) {
      const boss = entityStates.get(requiredString(manualBossStableId, 'manualBossStableId'));
      if (!boss || boss.type !== 'boss' || manualBossSequence < 1) {
        throw new Error('manual Boss save record does not match the entity registry');
      }
    } else if (manualBossSequence !== 0) {
      throw new Error('manual Boss sequence requires a Stable ID');
    }
    this.activeScaleStageId = snapshot.activeScaleStageId;
    Object.assign(this.player, player);
    this.featureDamage = featureDamage;
    this.entityStates = entityStates;
    this.manualBossStableId = manualBossStableId;
    this.manualBossSequence = manualBossSequence;
    this.nuclearCooldownMs = nuclearCooldownMs;
    this.revision += 1;
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      schemaVersion: W6_GAMEPLAY_SCHEMA,
      worldSeedHash: this.worldSeedHash,
      activeScaleStageId: this.activeScaleStageId,
      player: Object.freeze({ ...this.player }),
      featureDamageCount: this.featureDamage.size,
      destroyedFeatureCount: [...this.featureDamage.values()].filter(value => value.destroyed).length,
      entityStateCount: this.entityStates.size,
      destroyedEntityCount: [...this.entityStates.values()].filter(value => !value.alive).length,
      manualBoss: this.manualBossStableId === null ? null : Object.freeze({
        stableId: this.manualBossStableId,
        sequence: this.manualBossSequence,
        ...cloneRecord(this.entityStates.get(this.manualBossStableId)),
      }),
      nuclearCooldownMs: this.nuclearCooldownMs,
      revision: this.revision,
    });
  }
}

async function checksumForPayload(payload) {
  return `sha256:${await sha256Hex(canonicalizeJson(payload))}`;
}

export async function encodeInfiniteWorldSave(snapshot) {
  const payload = structuredClone(snapshot);
  return JSON.stringify({
    schemaVersion: W6_SAVE_ENVELOPE_SCHEMA,
    checksum: await checksumForPayload(payload),
    payload,
  });
}

export async function decodeInfiniteWorldSave(serialized, { worldSeedHash } = {}) {
  let envelope;
  try {
    envelope = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Infinite World save is not valid JSON: ${error.message}`);
  }
  if (envelope?.schemaVersion !== W6_SAVE_ENVELOPE_SCHEMA
    || typeof envelope?.checksum !== 'string' || !envelope.payload) {
    throw new Error('invalid Infinite World save envelope');
  }
  const actualChecksum = await checksumForPayload(envelope.payload);
  if (actualChecksum !== envelope.checksum) throw new Error('Infinite World save checksum mismatch');
  if (worldSeedHash && envelope.payload.worldSeedHash !== worldSeedHash) {
    throw new Error('Infinite World save belongs to a different seed');
  }
  return structuredClone(envelope.payload);
}

export class InfiniteWorldSaveStore {
  constructor({ storage, worldSeedHash } = {}) {
    if (storage && (typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function')) {
      throw new TypeError('storage must implement getItem and setItem');
    }
    this.storage = storage ?? null;
    this.worldSeedHash = requiredString(worldSeedHash, 'worldSeedHash');
    this.key = `KaniNingen:InfiniteWorld:${this.worldSeedHash}`;
    this.counts = { saved: 0, loaded: 0, missing: 0, failed: 0 };
  }

  async save(state) {
    if (!(state instanceof InfiniteWorldState) || state.worldSeedHash !== this.worldSeedHash) {
      throw new TypeError('matching InfiniteWorldState is required');
    }
    const serialized = await encodeInfiniteWorldSave(state.createSaveSnapshot());
    try {
      this.storage?.setItem(this.key, serialized);
      this.counts.saved += 1;
      return serialized;
    } catch (error) {
      this.counts.failed += 1;
      throw error;
    }
  }

  async loadSnapshot() {
    let serialized;
    try {
      serialized = this.storage?.getItem(this.key) ?? null;
    } catch (error) {
      this.counts.failed += 1;
      throw error;
    }
    if (serialized === null) {
      this.counts.missing += 1;
      return null;
    }
    try {
      const snapshot = await decodeInfiniteWorldSave(serialized, { worldSeedHash: this.worldSeedHash });
      this.counts.loaded += 1;
      return snapshot;
    } catch (error) {
      this.counts.failed += 1;
      throw error;
    }
  }

  async loadInto(state) {
    const snapshot = await this.loadSnapshot();
    if (!snapshot) return null;
    state.restoreSaveSnapshot(snapshot);
    return state.snapshot();
  }

  snapshot() {
    return Object.freeze({
      schemaVersion: W6_SAVE_ENVELOPE_SCHEMA,
      key: this.key,
      persistentStorage: this.storage !== null,
      counts: Object.freeze({ ...this.counts }),
    });
  }
}
