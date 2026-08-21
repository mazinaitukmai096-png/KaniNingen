import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import {
  W6_ENTITY_CONTRACTS,
  W6_GAMEPLAY_SCHEMA,
  W6_PLAYER_MAX_HP,
  W6_SAVE_ENVELOPE_SCHEMA,
  W6_SAVE_SCHEMA,
  W6_SAVE_VERSION,
  W6_STATE_BOOTSTRAP_SCALE_STAGE_ID,
  W6_STATIC_TARGET_CONTRACTS,
  W7_GAMEPLAY_SCHEMA,
  W7_LEGACY_GAMEPLAY_SCHEMA,
  W7_LEGACY_SAVE_ENVELOPE_SCHEMA,
  W7_LEGACY_SAVE_SCHEMA,
  W7_LEGACY_SAVE_SCHEMA_VERSION,
  W7_SAVE_ENVELOPE_SCHEMA,
  W7_SAVE_SCHEMA,
  W7_SAVE_SCHEMA_VERSION,
  W8_BOSS_CONTRACT,
  W8_LEGACY_GAMEPLAY_SCHEMA,
  W8_LEGACY_SAVE_ENVELOPE_SCHEMA,
  W8_LEGACY_SAVE_SCHEMA,
  W8_LEGACY_SAVE_SCHEMA_VERSION,
  W8_V4_GAMEPLAY_SCHEMA,
  W8_V4_SAVE_ENVELOPE_SCHEMA,
  W8_V4_SAVE_SCHEMA,
  W8_V4_SAVE_SCHEMA_VERSION,
  createW6PlayerState,
  isW6ScaleStageId,
} from './gameplay-contract.js';
import { parseChunkKey } from './chunk-coordinates.js';
import {
  W8_DEFAULT_RENDER_DISTANCE_PRESET,
  normalizeW8RenderDistancePreset,
} from './render-distance-policy.js';

const FEATURE_MAX_HP_VALUES = new Set(
  Object.values(W6_STATIC_TARGET_CONTRACTS).map(contract => contract.maxHp),
);
const DEFAULT_EXPERIENCE_STATE = Object.freeze({
  hudHidden: false,
  settings: Object.freeze({
    mouseSensitivity: 1,
    volume: 0.5,
    quality: 'high',
    renderDistance: W8_DEFAULT_RENDER_DISTANCE_PRESET,
    showFps: false,
    fpsCap: 0,
    cameraShake: 1,
    antialias: true,
  }),
});
const DEFAULT_COMBAT_PROGRESS = Object.freeze({
  nextBossScore: W8_BOSS_CONTRACT.naturalSpawnScore,
  bossesDefeated: 0,
  attacksIssued: 0,
  damageDealt: 0,
});

function createDefaultBossBehavior() {
  return {
    phase: 'slither', phaseClock: 0, rage: false, hyperRage: false,
    breakStage: 0, verticalOffset: 0, verticalVelocity: 0,
    targetX: 0, targetZ: 0, acidSequence: 0,
    tailCooldownSeconds: 0, tailX: 0, tailZ: 0,
    phaseSequence: 0, lastPick: null, phaseDurationSeconds: null,
    landingApplied: false, recoverSpitWindow: -1, recoverStarAccumulator: 0,
    slitherAcidDecisionSequence: 0,
    segmentHp: Array.from({ length: W8_BOSS_CONTRACT.segmentCount }, () => 1),
  };
}

function validateCombatProgress(value = DEFAULT_COMBAT_PROGRESS) {
  return {
    nextBossScore: nonNegative(value.nextBossScore, 'combatProgress.nextBossScore'),
    bossesDefeated: nonNegativeInteger(value.bossesDefeated, 'combatProgress.bossesDefeated'),
    attacksIssued: nonNegativeInteger(value.attacksIssued, 'combatProgress.attacksIssued'),
    damageDealt: nonNegative(value.damageDealt, 'combatProgress.damageDealt'),
  };
}

function validateBossBehavior(value = createDefaultBossBehavior()) {
  if (!W8_BOSS_CONTRACT.behaviorStates.includes(value.phase)) throw new RangeError('unsupported Boss phase');
  const lastPick = value.lastPick ?? null;
  if (lastPick !== null && !W8_BOSS_CONTRACT.behaviorStates.includes(lastPick)) {
    throw new RangeError('unsupported previous Boss phase');
  }
  if (!Array.isArray(value.segmentHp) || value.segmentHp.length !== W8_BOSS_CONTRACT.segmentCount) {
    throw new TypeError('Boss segment state is incomplete');
  }
  return {
    phase: value.phase,
    phaseClock: nonNegative(value.phaseClock, 'boss.phaseClock'),
    rage: value.rage === true,
    hyperRage: value.hyperRage === true,
    breakStage: integerInRange(value.breakStage, 0, 3, 'boss.breakStage'),
    verticalOffset: finite(value.verticalOffset, 'boss.verticalOffset'),
    verticalVelocity: finite(value.verticalVelocity, 'boss.verticalVelocity'),
    targetX: finite(value.targetX, 'boss.targetX'),
    targetZ: finite(value.targetZ, 'boss.targetZ'),
    acidSequence: nonNegativeInteger(value.acidSequence, 'boss.acidSequence'),
    tailCooldownSeconds: nonNegative(value.tailCooldownSeconds ?? 0, 'boss.tailCooldownSeconds'),
    tailX: finite(value.tailX ?? 0, 'boss.tailX'),
    tailZ: finite(value.tailZ ?? 0, 'boss.tailZ'),
    phaseSequence: nonNegativeInteger(value.phaseSequence ?? 0, 'boss.phaseSequence'),
    lastPick,
    phaseDurationSeconds: value.phaseDurationSeconds === null
      || value.phaseDurationSeconds === undefined
      ? null : nonNegative(value.phaseDurationSeconds, 'boss.phaseDurationSeconds'),
    landingApplied: value.landingApplied === true,
    recoverSpitWindow: integerInRange(value.recoverSpitWindow ?? -1, -1,
      Number.MAX_SAFE_INTEGER, 'boss.recoverSpitWindow'),
    recoverStarAccumulator: nonNegative(value.recoverStarAccumulator ?? 0,
      'boss.recoverStarAccumulator'),
    slitherAcidDecisionSequence: nonNegativeInteger(value.slitherAcidDecisionSequence ?? 0,
      'boss.slitherAcidDecisionSequence'),
    segmentHp: value.segmentHp.map((hp, index) => numberInRange(hp, 0, 1, `boss.segmentHp[${index}]`)),
  };
}

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be non-negative`);
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

function integerInRange(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} is outside its supported integer range`);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
  return value;
}

function numberInRange(value, minimum, maximum, name) {
  const result = finite(value, name);
  if (result < minimum || result > maximum) throw new RangeError(`${name} is outside its supported range`);
  return result;
}

function validateExperience(experience = DEFAULT_EXPERIENCE_STATE) {
  if (!experience || typeof experience !== 'object' || !experience.settings) {
    throw new TypeError('experience settings are required');
  }
  const settings = experience.settings;
  if (!['high', 'medium', 'low'].includes(settings.quality)) {
    throw new RangeError('unsupported graphics quality');
  }
  if (![0, 30, 60, 120].includes(settings.fpsCap)) throw new RangeError('unsupported FPS cap');
  if (typeof settings.showFps !== 'boolean' || typeof settings.antialias !== 'boolean'
    || typeof experience.hudHidden !== 'boolean') {
    throw new TypeError('HUD, FPS visibility, and antialias must be boolean');
  }
  return {
    hudHidden: experience.hudHidden,
    settings: {
      mouseSensitivity: numberInRange(settings.mouseSensitivity, 0.1, 3, 'mouseSensitivity'),
      volume: numberInRange(settings.volume, 0, 1, 'volume'),
      quality: settings.quality,
      renderDistance: normalizeW8RenderDistancePreset(settings.renderDistance),
      showFps: settings.showFps,
      fpsCap: settings.fpsCap,
      cameraShake: numberInRange(settings.cameraShake, 0, 2, 'cameraShake'),
      antialias: settings.antialias,
    },
  };
}

function migrateTankLifecycleState(record, { spawned = record?.alive === true } = {}) {
  if (record?.type !== 'tank') return record;
  return {
    ...record,
    spawned: record.spawned ?? spawned,
    baseX: record.baseX ?? record.x,
    baseZ: record.baseZ ?? record.z,
    lastShotAtMs: record.lastShotAtMs ?? 0,
    gunPitch: record.gunPitch ?? 0,
    stuckCheckClock: record.stuckCheckClock ?? 0,
    stuckRemainingSeconds: record.stuckRemainingSeconds ?? 0,
    avoidAngle: record.avoidAngle ?? record.rotationY ?? 0,
    lastX: record.lastX ?? record.x,
    lastZ: record.lastZ ?? record.z,
    aiState: record.aiState || (record.spawned ?? spawned ? 'acquire' : 'reserve'),
  };
}

function migrateParityV5EntityState(record) {
  if (record?.type === 'human') {
    return {
      ...record,
      knockdownSeconds: record.knockdownSeconds ?? 0,
      humanTimer: record.humanTimer ?? 0,
      wiggleTime: record.wiggleTime ?? 0,
      tripTimer: record.tripTimer ?? 0,
      idleWaitTimer: record.idleWaitTimer ?? 0,
      fleeAngleOffset: record.fleeAngleOffset ?? 0,
      waterAvoidTimer: record.waterAvoidTimer ?? 0,
      waterAvoidX: record.waterAvoidX ?? 0,
      waterAvoidZ: record.waterAvoidZ ?? 0,
      targetBuildingStableId: record.targetBuildingStableId ?? null,
      humanRandomSequence: record.humanRandomSequence ?? 0,
    };
  }
  if (record?.type === 'boss') {
    return {
      ...record,
      bossBehavior: { ...createDefaultBossBehavior(), ...(record.bossBehavior ?? {}) },
    };
  }
  return record;
}

function migrateParityV5State(snapshot) {
  return {
    ...snapshot,
    player: { ...snapshot.player, acidDebuffSeconds: snapshot.player?.acidDebuffSeconds ?? 0 },
    entityStates: (snapshot.entityStates ?? []).map(migrateParityV5EntityState),
    experience: {
      ...snapshot.experience,
      settings: { ...snapshot.experience?.settings, antialias: snapshot.experience?.settings?.antialias ?? true },
    },
  };
}

const REQUIRED_HUMAN_V5_FIELDS = Object.freeze([
  'knockdownSeconds', 'humanTimer', 'wiggleTime', 'tripTimer', 'idleWaitTimer',
  'fleeAngleOffset', 'waterAvoidTimer', 'waterAvoidX', 'waterAvoidZ',
  'targetBuildingStableId', 'humanRandomSequence',
]);
const REQUIRED_BOSS_V5_FIELDS = Object.freeze([
  'phase', 'phaseClock', 'rage', 'hyperRage', 'breakStage', 'verticalOffset',
  'verticalVelocity', 'targetX', 'targetZ', 'acidSequence', 'tailCooldownSeconds',
  'tailX', 'tailZ', 'phaseSequence', 'lastPick', 'phaseDurationSeconds',
  'landingApplied', 'recoverSpitWindow', 'recoverStarAccumulator',
  'slitherAcidDecisionSequence', 'segmentHp',
]);

function requireOwnFields(value, fields, label) {
  if (!value || typeof value !== 'object') throw new TypeError(`${label} is required`);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${label}.${field} is required`);
  }
}

function validateCompleteV5ParityState(snapshot) {
  requireOwnFields(snapshot.player, ['acidDebuffSeconds'], 'player');
  requireOwnFields(snapshot.experience?.settings, ['antialias'], 'experience.settings');
  for (const record of snapshot.entityStates ?? []) {
    if (record?.type === 'human') requireOwnFields(record, REQUIRED_HUMAN_V5_FIELDS, 'human');
    if (record?.type === 'boss') {
      requireOwnFields(record.bossBehavior, REQUIRED_BOSS_V5_FIELDS, 'bossBehavior');
      if (typeof record.bossBehavior.rage !== 'boolean'
        || typeof record.bossBehavior.hyperRage !== 'boolean'
        || typeof record.bossBehavior.landingApplied !== 'boolean') {
        throw new TypeError('Boss v5 boolean state is invalid');
      }
    }
  }
}

function migrateW6SaveSnapshot(snapshot, { worldSeed }) {
  if (snapshot?.schemaVersion !== W6_SAVE_SCHEMA
    || snapshot?.gameplaySchemaVersion !== W6_GAMEPLAY_SCHEMA
    || snapshot?.saveVersion !== W6_SAVE_VERSION) {
    throw new Error('unsupported legacy Infinite World save schema or version');
  }
  const manualBossStableId = snapshot.manualBossStableId ?? null;
  const entityStates = Array.isArray(snapshot.entityStates)
    ? snapshot.entityStates.filter(record => record?.type !== 'boss'
      || record.stableId === manualBossStableId)
    : snapshot.entityStates;
  return {
    schemaVersion: W7_SAVE_SCHEMA,
    schemaVersionNumber: W7_SAVE_SCHEMA_VERSION,
    gameplaySchemaVersion: W7_GAMEPLAY_SCHEMA,
    legacySaveVersion: W6_SAVE_VERSION,
    worldSeed: requiredString(worldSeed, 'worldSeed'),
    worldSeedHash: snapshot.worldSeedHash,
    activeScaleStageId: snapshot.activeScaleStageId,
    player: snapshot.player,
    featureDamage: snapshot.featureDamage,
    entityStates: (entityStates ?? []).map(record => migrateTankLifecycleState(record)),
    manualBossStableId,
    manualBossSequence: manualBossStableId ? (snapshot.manualBossSequence ?? 1) : 0,
    nuclearCooldownMs: snapshot.nuclearCooldownMs ?? 0,
    experience: structuredClone(DEFAULT_EXPERIENCE_STATE),
    developerTools: false,
    combatProgress: structuredClone(DEFAULT_COMBAT_PROGRESS),
    tankReinforcementSequence: 0,
    gameplayTimeMs: 0,
  };
}

function migrateW7SaveSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== W7_LEGACY_SAVE_SCHEMA
    || snapshot?.schemaVersionNumber !== W7_LEGACY_SAVE_SCHEMA_VERSION
    || snapshot?.gameplaySchemaVersion !== W7_LEGACY_GAMEPLAY_SCHEMA) {
    throw new Error('unsupported W7 Infinite World save schema or version');
  }
  return {
    ...structuredClone(snapshot),
    schemaVersion: W7_SAVE_SCHEMA,
    schemaVersionNumber: W7_SAVE_SCHEMA_VERSION,
    gameplaySchemaVersion: W7_GAMEPLAY_SCHEMA,
    developerTools: snapshot.developerTools === true,
    combatProgress: structuredClone(snapshot.combatProgress ?? DEFAULT_COMBAT_PROGRESS),
    tankReinforcementSequence: snapshot.tankReinforcementSequence ?? 0,
    entityStates: (snapshot.entityStates ?? []).map(record => record.type === 'boss'
      ? { ...record, bossBehavior: record.bossBehavior ?? createDefaultBossBehavior(), aiState: record.aiState || 'slither' }
      : migrateTankLifecycleState(record)),
    gameplayTimeMs: snapshot.gameplayTimeMs ?? 0,
  };
}

function migrateW8SaveSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== W8_LEGACY_SAVE_SCHEMA
    || snapshot?.schemaVersionNumber !== W8_LEGACY_SAVE_SCHEMA_VERSION
    || snapshot?.gameplaySchemaVersion !== W8_LEGACY_GAMEPLAY_SCHEMA) {
    throw new Error('unsupported previous W8 Infinite World save schema or version');
  }
  return {
    ...structuredClone(snapshot),
    schemaVersion: W7_SAVE_SCHEMA,
    schemaVersionNumber: W7_SAVE_SCHEMA_VERSION,
    gameplaySchemaVersion: W7_GAMEPLAY_SCHEMA,
    gameplayTimeMs: snapshot.gameplayTimeMs ?? 0,
    entityStates: (snapshot.entityStates ?? []).map(record => migrateTankLifecycleState(record)),
  };
}

function migrateW8V4SaveSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== W8_V4_SAVE_SCHEMA
    || snapshot?.schemaVersionNumber !== W8_V4_SAVE_SCHEMA_VERSION
    || snapshot?.gameplaySchemaVersion !== W8_V4_GAMEPLAY_SCHEMA) {
    throw new Error('unsupported W8 v4 Infinite World save schema or version');
  }
  return {
    ...structuredClone(snapshot),
    schemaVersion: W7_SAVE_SCHEMA,
    schemaVersionNumber: W7_SAVE_SCHEMA_VERSION,
    gameplaySchemaVersion: W7_GAMEPLAY_SCHEMA,
  };
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
    acidDebuffSeconds: nonNegative(player.acidDebuffSeconds ?? 0, 'player.acidDebuffSeconds'),
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
    if (type === 'boss') validated.bossBehavior = validateBossBehavior(record.bossBehavior);
    if (type === 'tank') {
      validated.reinforcementSequence = nonNegativeInteger(record.reinforcementSequence ?? 0, 'tank.reinforcementSequence');
      validated.fireSequence = nonNegativeInteger(record.fireSequence ?? 0, 'tank.fireSequence');
      validated.turretRotationY = finite(record.turretRotationY ?? record.rotationY, 'tank.turretRotationY');
      validated.spawned = record.spawned === true;
      validated.baseX = finite(record.baseX ?? record.x, 'tank.baseX');
      validated.baseZ = finite(record.baseZ ?? record.z, 'tank.baseZ');
      validated.lastShotAtMs = nonNegative(record.lastShotAtMs ?? 0, 'tank.lastShotAtMs');
      validated.gunPitch = finite(record.gunPitch ?? 0, 'tank.gunPitch');
      validated.stuckCheckClock = nonNegative(record.stuckCheckClock ?? 0, 'tank.stuckCheckClock');
      validated.stuckRemainingSeconds = nonNegative(record.stuckRemainingSeconds ?? 0, 'tank.stuckRemainingSeconds');
      validated.avoidAngle = finite(record.avoidAngle ?? record.rotationY, 'tank.avoidAngle');
      validated.lastX = finite(record.lastX ?? record.x, 'tank.lastX');
      validated.lastZ = finite(record.lastZ ?? record.z, 'tank.lastZ');
    }
    if (type === 'human') {
      validated.knockdownSeconds = nonNegative(record.knockdownSeconds ?? 0, 'human.knockdownSeconds');
      validated.humanTimer = nonNegative(record.humanTimer ?? 0, 'human.humanTimer');
      validated.wiggleTime = nonNegative(record.wiggleTime ?? 0, 'human.wiggleTime');
      validated.tripTimer = nonNegative(record.tripTimer ?? 0, 'human.tripTimer');
      validated.idleWaitTimer = nonNegative(record.idleWaitTimer ?? 0, 'human.idleWaitTimer');
      validated.fleeAngleOffset = finite(record.fleeAngleOffset ?? 0, 'human.fleeAngleOffset');
      validated.waterAvoidTimer = nonNegative(record.waterAvoidTimer ?? 0, 'human.waterAvoidTimer');
      validated.waterAvoidX = finite(record.waterAvoidX ?? 0, 'human.waterAvoidX');
      validated.waterAvoidZ = finite(record.waterAvoidZ ?? 0, 'human.waterAvoidZ');
      validated.targetBuildingStableId = record.targetBuildingStableId === null
        || record.targetBuildingStableId === undefined
        ? null : requiredString(record.targetBuildingStableId, 'human.targetBuildingStableId');
      validated.humanRandomSequence = nonNegativeInteger(record.humanRandomSequence ?? 0,
        'human.humanRandomSequence');
    }
    if (result.has(stableId)) throw new Error(`duplicate entity Stable ID: ${stableId}`);
    result.set(stableId, validated);
  }
  return result;
}

function hydrateTankLifecycle(entityStates, tankReinforcementSequence) {
  let highestReinforcementSequence = 0;
  for (const state of entityStates.values()) {
    if (state.type !== 'tank' || state.reinforcementSequence === 0) continue;
    highestReinforcementSequence = Math.max(
      highestReinforcementSequence,
      state.reinforcementSequence,
    );
  }
  if (tankReinforcementSequence < highestReinforcementSequence) {
    throw new Error('tankReinforcementSequence is lower than a fallback Tank sequence');
  }
  for (const [stableId, state] of entityStates) {
    if (state.type !== 'tank') continue;
    if (state.reinforcementSequence === 0) {
      if (!state.alive && state.spawned) state.spawned = false;
      continue;
    }
    if (!state.alive || !state.spawned) {
      entityStates.delete(stableId);
    }
  }
  return entityStates;
}

export class InfiniteWorldState {
  constructor({ worldSeedHash, worldSeed = worldSeedHash, playerSpawn } = {}) {
    this.worldSeedHash = requiredString(worldSeedHash, 'worldSeedHash');
    this.worldSeed = requiredString(worldSeed, 'worldSeed');
    // The menu/bootstrap state is not a started run. New Game applies the Tiny
    // initial profile in restartRun(), while Continue restores the saved stage.
    this.activeScaleStageId = W6_STATE_BOOTSTRAP_SCALE_STAGE_ID;
    this.player = { ...cloneRecord(createW6PlayerState(playerSpawn)), acidDebuffSeconds: 0 };
    this.featureDamage = new Map();
    this._featureDamageRevision = 0;
    this._destroyedFeatureStableIds = new Set();
    this._featureDestructionSnapshot = null;
    this.entityStates = new Map();
    this.manualBossStableId = null;
    this.manualBossSequence = 0;
    this.nuclearCooldownMs = 0;
    this.developerTools = false;
    this.combatProgress = validateCombatProgress(DEFAULT_COMBAT_PROGRESS);
    this.tankReinforcementSequence = 0;
    this.gameplayTimeMs = 0;
    this.experience = validateExperience(DEFAULT_EXPERIENCE_STATE);
    this.revision = 0;
  }

  #setFeatureDestructionMembership(stableId, destroyed) {
    const wasDestroyed = this._destroyedFeatureStableIds.has(stableId);
    if (wasDestroyed === destroyed) return false;
    if (destroyed) this._destroyedFeatureStableIds.add(stableId);
    else this._destroyedFeatureStableIds.delete(stableId);
    this._featureDamageRevision += 1;
    this._featureDestructionSnapshot = null;
    return true;
  }

  #replaceFeatureDestructionMembership(featureDamage) {
    const destroyedStableIds = new Set([...featureDamage.values()]
      .filter(record => record.destroyed === true)
      .map(record => record.stableId));
    if (destroyedStableIds.size === this._destroyedFeatureStableIds.size
      && [...destroyedStableIds].every(stableId => (
        this._destroyedFeatureStableIds.has(stableId)
      ))) return false;
    this._destroyedFeatureStableIds = destroyedStableIds;
    this._featureDamageRevision += 1;
    this._featureDestructionSnapshot = null;
    return true;
  }

  get featureDamageRevision() {
    return this._featureDamageRevision;
  }

  featureDestructionSnapshot() {
    if (this._featureDestructionSnapshot !== null) return this._featureDestructionSnapshot;
    const destroyedStableIds = Object.freeze([...this._destroyedFeatureStableIds]
      .sort((left, right) => left.localeCompare(right)));
    this._featureDestructionSnapshot = Object.freeze({
      schemaVersion: 'feature-destruction-snapshot-1',
      revision: this._featureDamageRevision,
      destroyedStableIds,
      // JSON length/escaping makes the revision signature collision-free even
      // for a corrupt legacy Stable ID containing a delimiter character.
      signature: JSON.stringify(destroyedStableIds),
    });
    return this._featureDestructionSnapshot;
  }

  setScaleStage(stageId) {
    if (!isW6ScaleStageId(stageId)) throw new RangeError(`unknown scale stage: ${stageId}`);
    if (this.activeScaleStageId !== stageId) {
      this.activeScaleStageId = stageId;
      this.revision += 1;
    }
    return stageId;
  }

  updateExperience(patch = {}) {
    const next = validateExperience({
      ...this.experience,
      ...patch,
      settings: { ...this.experience.settings, ...(patch.settings ?? {}) },
    });
    this.experience = next;
    this.revision += 1;
    return Object.freeze({
      hudHidden: next.hudHidden,
      settings: Object.freeze({ ...next.settings }),
    });
  }

  setDeveloperTools(enabled) {
    this.developerTools = enabled === true;
    this.revision += 1;
    return this.developerTools;
  }

  updateCombatProgress(patch = {}) {
    this.combatProgress = validateCombatProgress({ ...this.combatProgress, ...patch });
    this.revision += 1;
    return Object.freeze({ ...this.combatProgress });
  }

  nextTankReinforcementSequence() {
    this.tankReinforcementSequence += 1;
    this.revision += 1;
    return this.tankReinforcementSequence;
  }

  tickGameplayTime(deltaMilliseconds) {
    const delta = nonNegative(deltaMilliseconds, 'gameplay time delta');
    if (delta > 0) {
      this.gameplayTimeMs += delta;
      this.revision += 1;
    }
    return this.gameplayTimeMs;
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

  restartRun({ playerSpawn, scaleStageId = this.activeScaleStageId } = {}) {
    const spawn = {
      x: finite(playerSpawn?.x, 'restart playerSpawn.x'),
      z: finite(playerSpawn?.z, 'restart playerSpawn.z'),
    };
    if (!isW6ScaleStageId(scaleStageId)) throw new RangeError(`unknown scale stage: ${scaleStageId}`);
    this.activeScaleStageId = scaleStageId;
    Object.assign(this.player, createW6PlayerState(spawn), { acidDebuffSeconds: 0 });
    this.featureDamage.clear();
    if (this._destroyedFeatureStableIds.size > 0) {
      this._destroyedFeatureStableIds.clear();
      this._featureDamageRevision += 1;
      this._featureDestructionSnapshot = null;
    }
    this.entityStates.clear();
    this.manualBossStableId = null;
    this.manualBossSequence = 0;
    this.nuclearCooldownMs = 0;
    this.combatProgress = validateCombatProgress(DEFAULT_COMBAT_PROGRESS);
    this.tankReinforcementSequence = 0;
    this.gameplayTimeMs = 0;
    this.revision += 1;
    return this.snapshot();
  }

  ensureEntity(descriptor) {
    const stableId = requiredString(descriptor?.stableId, 'entity descriptor stableId');
    if (this.featureDamage.has(stableId)) {
      throw new Error(`Stable ID collision between feature and entity state: ${stableId}`);
    }
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
    if (type === 'boss') state.bossBehavior = validateBossBehavior(descriptor.bossBehavior);
    if (type === 'tank') {
      state.reinforcementSequence = nonNegativeInteger(descriptor.reinforcementSequence ?? 0, 'tank reinforcementSequence');
      state.fireSequence = nonNegativeInteger(descriptor.fireSequence ?? 0, 'tank fireSequence');
      state.turretRotationY = finite(descriptor.turretRotationY ?? state.rotationY, 'tank turretRotationY');
      state.spawned = descriptor.spawned === true;
      state.baseX = finite(descriptor.baseX ?? state.x, 'tank baseX');
      state.baseZ = finite(descriptor.baseZ ?? state.z, 'tank baseZ');
      state.lastShotAtMs = nonNegative(descriptor.lastShotAtMs ?? 0, 'tank lastShotAtMs');
      state.gunPitch = finite(descriptor.gunPitch ?? 0, 'tank gunPitch');
      state.stuckCheckClock = nonNegative(descriptor.stuckCheckClock ?? 0, 'tank stuckCheckClock');
      state.stuckRemainingSeconds = nonNegative(descriptor.stuckRemainingSeconds ?? 0, 'tank stuckRemainingSeconds');
      state.avoidAngle = finite(descriptor.avoidAngle ?? state.rotationY, 'tank avoidAngle');
      state.lastX = finite(descriptor.lastX ?? state.x, 'tank lastX');
      state.lastZ = finite(descriptor.lastZ ?? state.z, 'tank lastZ');
    }
    if (type === 'human') {
      Object.assign(state, migrateParityV5EntityState({
        ...state,
        knockdownSeconds: descriptor.knockdownSeconds,
      }));
    }
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

  removeEntity(stableId) {
    const entityStableId = requiredString(stableId, 'entity stableId');
    if (!this.entityStates.delete(entityStableId)) return false;
    if (this.manualBossStableId === entityStableId) {
      this.manualBossStableId = null;
      this.manualBossSequence = 0;
    }
    this.revision += 1;
    return true;
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

  reconcileFeatureDamage(descriptor) {
    const stableId = requiredString(descriptor?.stableId, 'feature stableId');
    const maxHp = nonNegative(descriptor.maxHp, 'feature maxHp');
    const existing = this.featureDamage.get(stableId);
    if (!existing || existing.maxHp === maxHp) return existing ? Object.freeze({ ...existing }) : null;
    const isMilitaryBaseUpgrade = descriptor.type === 'militaryBase'
      && existing.maxHp === W6_STATIC_TARGET_CONTRACTS.house.maxHp
      && maxHp === W6_STATIC_TARGET_CONTRACTS.militaryBase.maxHp;
    if (!isMilitaryBaseUpgrade) {
      throw new Error(`Stable ID collision or feature contract mismatch: ${stableId}`);
    }
    const damage = existing.destroyed ? maxHp : Math.min(existing.damage, maxHp);
    const record = { stableId, maxHp, damage, destroyed: damage >= maxHp };
    this.featureDamage.set(stableId, record);
    this.#setFeatureDestructionMembership(stableId, record.destroyed);
    this.revision += 1;
    return Object.freeze({ ...record });
  }

  damageFeature(descriptor, amount) {
    const stableId = requiredString(descriptor?.stableId, 'feature stableId');
    if (this.entityStates.has(stableId)) {
      throw new Error(`Stable ID collision between feature and entity state: ${stableId}`);
    }
    const maxHp = nonNegative(descriptor.maxHp, 'feature maxHp');
    if (!FEATURE_MAX_HP_VALUES.has(maxHp)) throw new Error(`unknown feature maxHp: ${stableId}`);
    const damageAmount = nonNegative(amount, 'feature damage');
    this.reconcileFeatureDamage(descriptor);
    const existing = this.featureDamage.get(stableId);
    const damage = Math.min(maxHp, (existing?.damage ?? 0) + damageAmount);
    const record = { stableId, maxHp, damage, destroyed: damage >= maxHp };
    if (damage > 0) {
      this.featureDamage.set(stableId, record);
      this.#setFeatureDestructionMembership(stableId, record.destroyed);
    }
    this.revision += 1;
    return Object.freeze({ ...record });
  }

  forgetFeatureDamage(stableId) {
    const featureStableId = requiredString(stableId, 'feature stableId');
    const existing = this.featureDamage.get(featureStableId);
    if (!existing || !this.featureDamage.delete(featureStableId)) return false;
    if (existing.destroyed === true) {
      this.#setFeatureDestructionMembership(featureStableId, false);
    }
    this.revision += 1;
    return true;
  }

  isFeatureDestroyed(stableId) {
    return this.featureDamage.get(stableId)?.destroyed === true;
  }

  featureHp(stableId, maxHp) {
    return Math.max(0, maxHp - (this.featureDamage.get(stableId)?.damage ?? 0));
  }

  createSaveSnapshot() {
    return {
      schemaVersion: W7_SAVE_SCHEMA,
      schemaVersionNumber: W7_SAVE_SCHEMA_VERSION,
      gameplaySchemaVersion: W7_GAMEPLAY_SCHEMA,
      legacySaveVersion: W6_SAVE_VERSION,
      worldSeed: this.worldSeed,
      worldSeedHash: this.worldSeedHash,
      activeScaleStageId: this.activeScaleStageId,
      player: { ...this.player },
      featureDamage: sortedRecords(this.featureDamage).map(cloneRecord),
      entityStates: sortedRecords(this.entityStates).map(cloneRecord),
      manualBossStableId: this.manualBossStableId,
      manualBossSequence: this.manualBossSequence,
      nuclearCooldownMs: this.nuclearCooldownMs,
      experience: structuredClone(this.experience),
      developerTools: this.developerTools,
      combatProgress: structuredClone(this.combatProgress),
      tankReinforcementSequence: this.tankReinforcementSequence,
      gameplayTimeMs: this.gameplayTimeMs,
    };
  }

  restoreSaveSnapshot(snapshot) {
    const isCurrentV5 = snapshot?.schemaVersion === W7_SAVE_SCHEMA;
    const migrated = snapshot?.schemaVersion === W6_SAVE_SCHEMA
      ? migrateW6SaveSnapshot(snapshot, { worldSeed: this.worldSeed })
      : snapshot?.schemaVersion === W7_LEGACY_SAVE_SCHEMA
        ? migrateW7SaveSnapshot(snapshot)
        : snapshot?.schemaVersion === W8_LEGACY_SAVE_SCHEMA
          ? migrateW8SaveSnapshot(snapshot)
          : snapshot?.schemaVersion === W8_V4_SAVE_SCHEMA
            ? migrateW8V4SaveSnapshot(snapshot)
            : structuredClone(snapshot);
    const candidate = isCurrentV5 ? migrated : migrateParityV5State(migrated);
    if (candidate?.schemaVersion !== W7_SAVE_SCHEMA
      || candidate?.schemaVersionNumber !== W7_SAVE_SCHEMA_VERSION
      || candidate?.gameplaySchemaVersion !== W7_GAMEPLAY_SCHEMA
      || candidate?.legacySaveVersion !== W6_SAVE_VERSION) {
      throw new Error('unsupported Infinite World save schema or version');
    }
    validateCompleteV5ParityState(candidate);
    if (candidate.worldSeedHash !== this.worldSeedHash || candidate.worldSeed !== this.worldSeed) {
      throw new Error('save world seed does not match runtime');
    }
    if (!isW6ScaleStageId(candidate.activeScaleStageId)) throw new Error('invalid saved scale stage');
    const player = validatePlayer(candidate.player);
    const featureDamage = validateFeatureDamage(candidate.featureDamage);
    const entityStates = validateEntityStates(candidate.entityStates);
    for (const stableId of featureDamage.keys()) {
      if (entityStates.has(stableId)) {
        throw new Error(`Stable ID collision between feature and entity state: ${stableId}`);
      }
    }
    const manualBossStableId = candidate.manualBossStableId ?? null;
    const manualBossSequence = candidate.manualBossSequence ?? 0;
    const nuclearCooldownMs = nonNegative(candidate.nuclearCooldownMs ?? 0, 'nuclearCooldownMs');
    const experience = validateExperience(candidate.experience);
    if (typeof candidate.developerTools !== 'boolean') throw new TypeError('developerTools must be boolean');
    const combatProgress = validateCombatProgress(candidate.combatProgress);
    const tankReinforcementSequence = nonNegativeInteger(
      candidate.tankReinforcementSequence,
      'tankReinforcementSequence',
    );
    hydrateTankLifecycle(entityStates, tankReinforcementSequence);
    const gameplayTimeMs = nonNegative(candidate.gameplayTimeMs ?? 0, 'gameplayTimeMs');
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
    this.activeScaleStageId = candidate.activeScaleStageId;
    Object.assign(this.player, player);
    this.featureDamage = featureDamage;
    this.#replaceFeatureDestructionMembership(featureDamage);
    this.entityStates = entityStates;
    this.manualBossStableId = manualBossStableId;
    this.manualBossSequence = manualBossSequence;
    this.nuclearCooldownMs = nuclearCooldownMs;
    this.experience = experience;
    this.developerTools = candidate.developerTools;
    this.combatProgress = combatProgress;
    this.tankReinforcementSequence = tankReinforcementSequence;
    this.gameplayTimeMs = gameplayTimeMs;
    this.revision += 1;
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      schemaVersion: W7_GAMEPLAY_SCHEMA,
      worldSeed: this.worldSeed,
      worldSeedHash: this.worldSeedHash,
      activeScaleStageId: this.activeScaleStageId,
      player: Object.freeze({ ...this.player }),
      featureDamageCount: this.featureDamage.size,
      destroyedFeatureCount: this.featureDestructionSnapshot().destroyedStableIds.length,
      entityStateCount: this.entityStates.size,
      destroyedEntityCount: [...this.entityStates.values()].filter(value => !value.alive
        && !(value.type === 'tank'
          && value.reinforcementSequence === 0
          && value.spawned === false)).length,
      manualBoss: this.manualBossStableId === null ? null : Object.freeze({
        stableId: this.manualBossStableId,
        sequence: this.manualBossSequence,
        ...cloneRecord(this.entityStates.get(this.manualBossStableId)),
      }),
      nuclearCooldownMs: this.nuclearCooldownMs,
      experience: Object.freeze({
        hudHidden: this.experience.hudHidden,
        settings: Object.freeze({ ...this.experience.settings }),
      }),
      developerTools: this.developerTools,
      combatProgress: Object.freeze({ ...this.combatProgress }),
      tankReinforcementSequence: this.tankReinforcementSequence,
      gameplayTimeMs: this.gameplayTimeMs,
      revision: this.revision,
    });
  }
}

async function checksumForPayload(payload) {
  return `sha256:${await sha256Hex(canonicalizeJson(payload))}`;
}

export async function encodeInfiniteWorldSave(snapshot) {
  const payload = structuredClone(snapshot);
  const schemaVersion = payload?.schemaVersion === W7_SAVE_SCHEMA
    ? W7_SAVE_ENVELOPE_SCHEMA
    : payload?.schemaVersion === W6_SAVE_SCHEMA
      ? W6_SAVE_ENVELOPE_SCHEMA
      : payload?.schemaVersion === W7_LEGACY_SAVE_SCHEMA
        ? W7_LEGACY_SAVE_ENVELOPE_SCHEMA
        : payload?.schemaVersion === W8_V4_SAVE_SCHEMA
          ? W8_V4_SAVE_ENVELOPE_SCHEMA
        : payload?.schemaVersion === W8_LEGACY_SAVE_SCHEMA
          ? W8_LEGACY_SAVE_ENVELOPE_SCHEMA
      : null;
  if (!schemaVersion) throw new Error('unsupported Infinite World save payload schema');
  return JSON.stringify({
    schemaVersion,
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
  const matchingPayloadSchema = envelope?.schemaVersion === W6_SAVE_ENVELOPE_SCHEMA
    ? W6_SAVE_SCHEMA
    : envelope?.schemaVersion === W7_SAVE_ENVELOPE_SCHEMA
      ? W7_SAVE_SCHEMA
      : envelope?.schemaVersion === W7_LEGACY_SAVE_ENVELOPE_SCHEMA
        ? W7_LEGACY_SAVE_SCHEMA
        : envelope?.schemaVersion === W8_V4_SAVE_ENVELOPE_SCHEMA
          ? W8_V4_SAVE_SCHEMA
        : envelope?.schemaVersion === W8_LEGACY_SAVE_ENVELOPE_SCHEMA
          ? W8_LEGACY_SAVE_SCHEMA
      : null;
  if (!matchingPayloadSchema || typeof envelope?.checksum !== 'string' || !envelope.payload
    || envelope.payload.schemaVersion !== matchingPayloadSchema) {
    throw new Error('invalid Infinite World save envelope');
  }
  const actualChecksum = await checksumForPayload(envelope.payload);
  if (actualChecksum !== envelope.checksum) throw new Error('Infinite World save checksum mismatch');
  if (worldSeedHash && envelope.payload.worldSeedHash !== worldSeedHash) {
    throw new Error('Infinite World save belongs to a different seed');
  }
  return structuredClone(envelope.payload);
}

const SAVE_STORAGE_FALLBACK_MARKER_KEY = 'KaniNingen:InfiniteWorld:legacy-storage-authority';
const SAVE_STORAGE_FALLBACK_MARKER_VALUE = 'legacy-authority-v1';
const INDEXED_DB_PERSISTENT_FAILURE_THRESHOLD = 2;

function storageBackendError(phase, cause, fallbackMessage) {
  const error = new Error(cause?.message ?? fallbackMessage);
  error.name = 'SaveStorageBackendError';
  error.phase = phase;
  error.cause = cause;
  return error;
}

function storageUnavailableError(cause) {
  const detail = cause?.message ? `: ${cause.message}` : '';
  const error = new Error(`Infinite World save storage is unavailable${detail}`);
  error.name = 'SaveStorageUnavailableError';
  error.code = 'SAVE_STORAGE_UNAVAILABLE';
  error.cause = cause;
  return error;
}

export function isSaveStorageUnavailableError(error) {
  return error?.code === 'SAVE_STORAGE_UNAVAILABLE'
    || error?.name === 'SaveStorageUnavailableError';
}

export function createBrowserSaveStorage({ indexedDB, legacyStorage = null } = {}) {
  const usableLegacyStorage = legacyStorage
    && typeof legacyStorage.getItem === 'function'
    && typeof legacyStorage.setItem === 'function'
    ? legacyStorage : null;
  if (!indexedDB?.open) return usableLegacyStorage;

  let fallbackPinned = false;
  if (usableLegacyStorage) {
    try {
      fallbackPinned = usableLegacyStorage.getItem(SAVE_STORAGE_FALLBACK_MARKER_KEY)
        === SAVE_STORAGE_FALLBACK_MARKER_VALUE;
    } catch { /* the real operation will report legacy failure if fallback is needed */ }
  }
  let mode = fallbackPinned ? 'legacy-fallback' : 'indexeddb';
  let backendEpoch = fallbackPinned ? 1 : 0;
  let consecutiveFailureCount = 0;
  let fallbackCount = 0;
  let fallbackReason = fallbackPinned
    ? Object.freeze({ name: 'LegacyAuthorityMarker', message: 'legacy storage is authoritative' })
    : null;
  let fallbackPromise = null;
  let fallbackMarkerPromise = null;
  let fallbackMarkerWritten = fallbackPinned;
  let unavailableError = null;
  let writeGeneration = 0;
  let staleIndexedDbResultCount = 0;
  const latestWriteGenerationByKey = new Map();
  const knownIndexedDbValues = new Map();

  const databasePromise = fallbackPinned ? null : new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open('KaniNingenInfiniteWorld', 1);
    } catch (error) {
      reject(storageBackendError('open', error, 'IndexedDB open failed'));
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('saves')) request.result.createObjectStore('saves');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(storageBackendError(
      'open', request.error, 'IndexedDB open failed',
    ));
  });
  const transact = async (mode, operation) => {
    const database = await databasePromise;
    return new Promise((resolve, reject) => {
      let settled = false;
      let requestResult = null;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        resolve(requestResult);
      };
      const rejectOnce = error => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      let transaction;
      let request;
      try {
        transaction = database.transaction('saves', mode);
        request = operation(transaction.objectStore('saves'));
      } catch (error) {
        rejectOnce(storageBackendError('transaction', error, 'IndexedDB transaction failed'));
        return;
      }
      request.onsuccess = () => { requestResult = request.result ?? null; };
      request.onerror = () => rejectOnce(storageBackendError(
        'request', request.error, 'IndexedDB request failed',
      ));
      transaction.oncomplete = resolveOnce;
      transaction.onerror = () => rejectOnce(storageBackendError(
        'transaction', transaction.error, 'IndexedDB transaction failed',
      ));
      transaction.onabort = () => rejectOnce(storageBackendError(
        'transaction', transaction.error, 'IndexedDB transaction aborted',
      ));
    });
  };

  const markUnavailable = cause => {
    if (!unavailableError) unavailableError = storageUnavailableError(cause);
    if (mode !== 'unavailable') backendEpoch += 1;
    mode = 'unavailable';
    return unavailableError;
  };

  const legacyOperation = async ({ type, key, value, generation = null }) => {
    if (!usableLegacyStorage) throw markUnavailable(fallbackReason);
    try {
      let result;
      if (type === 'get') result = await usableLegacyStorage.getItem(key) ?? null;
      else if (generation >= (latestWriteGenerationByKey.get(key) ?? generation)) {
        await usableLegacyStorage.setItem(key, value);
        result = null;
      } else result = null;
      if (!fallbackMarkerWritten) {
        if (!fallbackMarkerPromise) {
          fallbackMarkerPromise = Promise.resolve().then(() => usableLegacyStorage.setItem(
            SAVE_STORAGE_FALLBACK_MARKER_KEY,
            SAVE_STORAGE_FALLBACK_MARKER_VALUE,
          )).then(() => { fallbackMarkerWritten = true; });
        }
        await fallbackMarkerPromise;
      }
      return result;
    } catch (error) {
      throw markUnavailable(error);
    }
  };

  const activateLegacyFallback = reason => {
    if (mode === 'legacy-fallback') return Promise.resolve();
    if (mode === 'unavailable') return Promise.reject(unavailableError);
    if (fallbackPromise) return fallbackPromise;
    fallbackReason = Object.freeze({
      name: reason?.name ?? 'Error', message: reason?.message ?? String(reason),
    });
    fallbackCount += 1;
    backendEpoch += 1;
    mode = 'switching';
    fallbackPromise = (async () => {
      if (!usableLegacyStorage) throw markUnavailable(reason);
      try {
        for (const [key, record] of knownIndexedDbValues) {
          if ((record.generation ?? 0) < (latestWriteGenerationByKey.get(key) ?? 0)) continue;
          await usableLegacyStorage.setItem(key, record.value);
        }
        mode = 'legacy-fallback';
      } catch (error) {
        throw markUnavailable(error);
      }
    })();
    return fallbackPromise;
  };

  const runOperation = async operation => {
    if (mode === 'switching') await fallbackPromise;
    if (mode === 'legacy-fallback') return legacyOperation(operation);
    if (mode === 'unavailable') throw unavailableError;
    const operationEpoch = backendEpoch;
    try {
      const result = operation.type === 'get'
        ? await transact('readonly', store => store.get(operation.key))
        : await transact('readwrite', store => store.put(operation.value, operation.key));
      if (operationEpoch !== backendEpoch || mode !== 'indexeddb') {
        staleIndexedDbResultCount += 1;
        if (mode === 'switching') await fallbackPromise;
        if (mode === 'unavailable') throw unavailableError;
        return legacyOperation(operation);
      }
      consecutiveFailureCount = 0;
      if (operation.type === 'get') {
        if (result !== null && result !== undefined) {
          knownIndexedDbValues.set(operation.key, { value: result, generation: 0 });
        }
      } else {
        knownIndexedDbValues.set(operation.key, {
          value: operation.value, generation: operation.generation,
        });
      }
      return result;
    } catch (error) {
      if (operationEpoch !== backendEpoch || mode !== 'indexeddb') {
        if (mode === 'switching') await fallbackPromise;
        if (mode === 'unavailable') throw unavailableError;
        return legacyOperation(operation);
      }
      if (error?.phase !== 'open') consecutiveFailureCount += 1;
      if (error?.phase !== 'open'
        && consecutiveFailureCount < INDEXED_DB_PERSISTENT_FAILURE_THRESHOLD) throw error;
      await activateLegacyFallback(error);
      return legacyOperation(operation);
    }
  };

  const createSetOperation = (key, value) => {
    const generation = ++writeGeneration;
    latestWriteGenerationByKey.set(key, generation);
    return { type: 'set', key, value, generation };
  };

  return Object.freeze({
    diagnosticStage: 'indexeddb',
    async getItem(key) {
      const stored = await runOperation({ type: 'get', key });
      if (stored !== null || mode !== 'indexeddb' || !usableLegacyStorage) return stored;
      const legacy = await usableLegacyStorage.getItem(key) ?? null;
      if (legacy === null) return null;
      await runOperation(createSetOperation(key, legacy));
      return legacy;
    },
    setItem(key, value) { return runOperation(createSetOperation(key, value)); },
    snapshot: () => Object.freeze({
      mode,
      backendEpoch,
      consecutiveFailureCount,
      fallbackCount,
      fallbackPinned,
      fallbackMarkerWritten,
      staleIndexedDbResultCount,
      fallbackReason,
    }),
  });
}

export class InfiniteWorldSaveStore {
  constructor({ storage, worldSeedHash, measure = async (_stage, operation) => operation() } = {}) {
    if (storage && (typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function')) {
      throw new TypeError('storage must implement getItem and setItem');
    }
    this.storage = storage ?? null;
    this.storageDiagnosticStage = storage?.diagnosticStage ?? 'storage';
    this.worldSeedHash = requiredString(worldSeedHash, 'worldSeedHash');
    if (typeof measure !== 'function') throw new TypeError('measure must be a function');
    this.measure = measure;
    this.key = `KaniNingen:InfiniteWorld:${this.worldSeedHash}`;
    this.counts = { saved: 0, loaded: 0, missing: 0, failed: 0 };
    this.saveGeneration = 0;
    this.committedSaveGeneration = 0;
    this.activeSaveRequest = null;
    this.pendingSaveRequest = null;
    this.saveWaiters = [];
    this.saveDrainPromise = null;
  }

  async save(state) {
    const result = await this.saveWithMetadata(state);
    return result.serialized;
  }

  saveWithMetadata(state) {
    return this.queueSave(state).completion;
  }

  queueSave(state) {
    if (!(state instanceof InfiniteWorldState) || state.worldSeedHash !== this.worldSeedHash) {
      throw new TypeError('matching InfiniteWorldState is required');
    }

    const revision = state.revision;
    const snapshot = structuredClone(state.createSaveSnapshot());
    const generation = this.saveGeneration + 1;
    this.saveGeneration = generation;
    const request = Object.freeze({ generation, revision, snapshot });
    const completion = new Promise((resolve, reject) => {
      this.saveWaiters.push({ generation, resolve, reject });
    });
    this.pendingSaveRequest = request;
    this.startSaveDrain();
    return Object.freeze({ generation, revision, completion });
  }

  startSaveDrain() {
    if (this.saveDrainPromise) return;
    const drain = this.drainSaveQueue();
    this.saveDrainPromise = drain;
    const finish = () => {
      if (this.saveDrainPromise === drain) this.saveDrainPromise = null;
      if (this.pendingSaveRequest) this.startSaveDrain();
    };
    void drain.then(finish, finish);
  }

  async drainSaveQueue() {
    while (this.pendingSaveRequest) {
      const request = this.pendingSaveRequest;
      this.pendingSaveRequest = null;
      this.activeSaveRequest = request;
      try {
        if (!this.storage) throw new Error('Infinite World save storage is unavailable');
        const serialized = await this.measure(
          'save-serialization',
          () => encodeInfiniteWorldSave(request.snapshot),
        );
        if (this.pendingSaveRequest?.generation > request.generation) continue;
        await this.measure(
          `save-${this.storageDiagnosticStage}`,
          () => this.storage.setItem(this.key, serialized),
        );
        this.counts.saved += 1;
        this.committedSaveGeneration = request.generation;
        this.resolveSaveWaiters(request.generation, Object.freeze({
          serialized,
          generation: request.generation,
          revision: request.revision,
        }));
      } catch (error) {
        this.counts.failed += 1;
        this.rejectSaveWaiters(request.generation, error);
      } finally {
        if (this.activeSaveRequest === request) this.activeSaveRequest = null;
      }
    }
  }

  resolveSaveWaiters(generation, result) {
    const remaining = [];
    for (const waiter of this.saveWaiters) {
      if (waiter.generation <= generation) waiter.resolve(result);
      else remaining.push(waiter);
    }
    this.saveWaiters = remaining;
  }

  rejectSaveWaiters(generation, error) {
    const remaining = [];
    for (const waiter of this.saveWaiters) {
      if (waiter.generation <= generation) waiter.reject(error);
      else remaining.push(waiter);
    }
    this.saveWaiters = remaining;
  }

  async loadSnapshot() {
    let serialized;
    try {
      serialized = await this.measure(`load-${this.storageDiagnosticStage}`, () => this.storage?.getItem(this.key) ?? null);
    } catch (error) {
      this.counts.failed += 1;
      throw error;
    }
    if (serialized === null) {
      this.counts.missing += 1;
      return null;
    }
    try {
      const snapshot = await this.measure(
        'load-serialization',
        () => decodeInfiniteWorldSave(serialized, { worldSeedHash: this.worldSeedHash }),
      );
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
    try {
      state.restoreSaveSnapshot(snapshot);
      return state.snapshot();
    } catch (error) {
      this.counts.failed += 1;
      throw error;
    }
  }

  snapshot() {
    return Object.freeze({
      schemaVersion: W7_SAVE_ENVELOPE_SCHEMA,
      key: this.key,
      persistentStorage: this.storage !== null,
      counts: Object.freeze({ ...this.counts }),
      storage: this.storage?.snapshot?.() ?? Object.freeze({
        mode: this.storage ? 'configured' : 'unavailable',
      }),
      queue: Object.freeze({
        requestedGeneration: this.saveGeneration,
        committedGeneration: this.committedSaveGeneration,
        activeGeneration: this.activeSaveRequest?.generation ?? null,
        pendingGeneration: this.pendingSaveRequest?.generation ?? null,
        waiterCount: this.saveWaiters.length,
      }),
    });
  }
}
