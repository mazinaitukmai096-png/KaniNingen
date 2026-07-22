import {
  ATTACK_COOLDOWN,
  BOMB_COOLDOWN,
  BOMB_DAMAGE_AMOUNT,
  BOMB_DAMAGE_RADIUS,
  BOMB_PUSH_RADIUS,
  BOSS_HP,
  BOSS_BODY_CONTACT_DAMAGE,
  BOSS_BODY_CONTACT_RANGE,
  BOSS_CHARGE_DAMAGE,
  BOSS_CHARGE_DAMAGE_RAGE,
  BOSS_CHARGE_DURATION_FROM_SLITHER,
  BOSS_CHARGE_HIT_RADIUS,
  BOSS_CHARGE_PUSH_FORCE,
  BOSS_CHARGE_SPEED,
  BOSS_CHARGE_SPEED_RAGE,
  BOSS_PLAYER_KNOCKBACK_DECAY,
  BOSS_RADIUS,
  BOSS_SCORE_VALUE,
  BOSS_SLITHER_APPROACH_DIST,
  BOSS_SLITHER_SPEED,
  BOSS_SLITHER_SPEED_RAGE,
  BOSS_SLITHER_DURATION,
  CHARGE_THRESHOLD,
  DEBUG_BOSS_SPAWN_DIST,
  PLAYER_MAX_HP,
  SAVE_VERSION,
  TANK_APPROACH_DIST,
  TANK_BULLET_DAMAGE,
  TANK_BULLET_HIT_RADIUS,
  TANK_BULLET_LIFE,
  TANK_BULLET_SPEED,
  TANK_DESPAWN_DIST,
  TANK_ENGAGE_RANGE,
  TANK_FIRE_INTERVAL_BASE,
  TANK_FIRE_INTERVAL_MIN,
  TANK_FIRE_INTERVAL_SCORE_DIVISOR,
  TANK_HP,
  TANK_MOVE_SPEED,
  TANK_RADIUS,
  TANK_SCORE_VALUE,
} from '../constants.js';
import {
  INITIAL_SCALE_STAGE_ID,
  SCALE_STAGE_IDS,
  SCALE_STAGES,
  canScaleStageDamageTarget,
  getScaleStage,
} from '../scale-sandbox.js';
import {
  PRODUCTION_HUMAN_VISUAL_SCALE,
  PRODUCTION_TANK_VISUAL_SCALE,
} from '../world-scale-rebalance.js';
import { FINITE_WORLD_UNITS_PER_METER } from './single-rural-settlement.js';

export const W6_GAMEPLAY_SCHEMA = 'w6-infinite-gameplay-1';
export const W6_SAVE_SCHEMA = 'w6-infinite-world-save-1';
export const W6_SAVE_ENVELOPE_SCHEMA = 'w6-infinite-world-save-envelope-1';
export const W6_SAVE_VERSION = SAVE_VERSION;
export const W7_GAMEPLAY_SCHEMA = 'w7-infinite-full-experience-1';
export const W7_SAVE_SCHEMA = 'w7-infinite-world-save-2';
export const W7_SAVE_ENVELOPE_SCHEMA = 'w7-infinite-world-save-envelope-2';
export const W7_SAVE_SCHEMA_VERSION = 2;
export const W6_INITIAL_SCALE_STAGE_ID = INITIAL_SCALE_STAGE_ID;
export const W6_PLAYER_MAX_HP = PLAYER_MAX_HP;

export const W6_ATTACK_CONTRACT = Object.freeze({
  cooldownMs: ATTACK_COOLDOWN,
  singleDamage: 550,
  doubleDamage: 650,
});

export const W7_CORE_COMBAT_CONTRACT = Object.freeze({
  tank: Object.freeze({
    fireIntervalMinimumMs: TANK_FIRE_INTERVAL_MIN,
    fireIntervalBaseMs: TANK_FIRE_INTERVAL_BASE,
    fireIntervalScoreDivisor: TANK_FIRE_INTERVAL_SCORE_DIVISOR,
    bulletSpeed: TANK_BULLET_SPEED,
    bulletLifeFrames: TANK_BULLET_LIFE,
    bulletHitRadius: TANK_BULLET_HIT_RADIUS,
    bulletDamage: TANK_BULLET_DAMAGE,
    bulletCameraShake: 35,
  }),
  building: Object.freeze({
    damagedHitStopMs: 32,
    destroyedHitStopMs: 65,
    destroyedShakeMinimum: 50,
    destroyedShakeRadiusFactor: 0.21,
    destroyedShakeMaximum: 88,
  }),
  healing: Object.freeze({
    human: 1,
    house: 3,
    tower: 5,
    church: 10,
    school: 12,
    rock: 2,
    pebble: 0.5,
  }),
});

export const W7_NUCLEAR_CONTRACT = Object.freeze({
  allowedScaleStageId: 'MAX',
  chargeThresholdMs: CHARGE_THRESHOLD,
  cooldownMs: BOMB_COOLDOWN,
  damageRadius: BOMB_DAMAGE_RADIUS,
  pushRadius: BOMB_PUSH_RADIUS,
  damageAmount: BOMB_DAMAGE_AMOUNT,
  cameraShake: 450,
});

export const W7_MANUAL_BOSS_CONTRACT = Object.freeze({
  spawnDistance: DEBUG_BOSS_SPAWN_DIST,
  simultaneousLimit: 1,
  slitherDurationSeconds: BOSS_SLITHER_DURATION,
  chargeDurationSeconds: BOSS_CHARGE_DURATION_FROM_SLITHER,
  chargeSpeed: BOSS_CHARGE_SPEED,
  chargeSpeedRage: BOSS_CHARGE_SPEED_RAGE,
  chargeHitRadius: BOSS_CHARGE_HIT_RADIUS,
  chargeDamage: BOSS_CHARGE_DAMAGE,
  chargeDamageRage: BOSS_CHARGE_DAMAGE_RAGE,
  chargePushForce: BOSS_CHARGE_PUSH_FORCE,
  bodyContactRange: BOSS_BODY_CONTACT_RANGE,
  bodyContactDamage: BOSS_BODY_CONTACT_DAMAGE,
  playerKnockbackDecay: BOSS_PLAYER_KNOCKBACK_DECAY,
});

export const W6_ENTITY_CONTRACTS = Object.freeze({
  human: Object.freeze({
    type: 'human',
    maxHp: 40,
    radius: 25,
    scoreValue: 100,
    visualScale: PRODUCTION_HUMAN_VISUAL_SCALE,
    idleSpeed: 3,
    fleeSpeed: 11,
    fleeRange: 2200,
  }),
  tank: Object.freeze({
    type: 'tank',
    maxHp: TANK_HP,
    radius: TANK_RADIUS,
    scoreValue: TANK_SCORE_VALUE,
    visualScale: PRODUCTION_TANK_VISUAL_SCALE,
    moveSpeed: TANK_MOVE_SPEED,
    approachDistance: TANK_APPROACH_DIST,
    engageRange: TANK_ENGAGE_RANGE,
    despawnDistance: TANK_DESPAWN_DIST,
  }),
  boss: Object.freeze({
    type: 'boss',
    maxHp: BOSS_HP,
    radius: BOSS_RADIUS,
    scoreValue: BOSS_SCORE_VALUE,
    visualScale: 1,
    moveSpeed: BOSS_SLITHER_SPEED,
    rageMoveSpeed: BOSS_SLITHER_SPEED_RAGE,
    approachDistance: BOSS_SLITHER_APPROACH_DIST,
  }),
});

export const W6_STATIC_TARGET_CONTRACTS = Object.freeze({
  tree: Object.freeze({ type: 'tree', maxHp: 80, radius: 25, scoreValue: 50 }),
  pebble: Object.freeze({ type: 'pebble', maxHp: 150, radius: 24, scoreValue: 20 }),
  rock: Object.freeze({ type: 'rock', maxHp: 600, radius: 50, scoreValue: 100 }),
  house: Object.freeze({ type: 'house', maxHp: 300, radius: 75, scoreValue: 200 }),
  tower: Object.freeze({ type: 'tower', maxHp: 1200, radius: 65, scoreValue: 800 }),
  church: Object.freeze({ type: 'church', maxHp: 2200, radius: 115, scoreValue: 1500 }),
  school: Object.freeze({ type: 'school', maxHp: 3500, radius: 145, scoreValue: 2500 }),
});

export function finiteWorldUnitsToMeters(value) {
  if (!Number.isFinite(value)) throw new TypeError('finite world units must be finite');
  return value / FINITE_WORLD_UNITS_PER_METER;
}

export function finiteWorldFrameSpeedToMetersPerSecond(value) {
  return finiteWorldUnitsToMeters(value) * 60;
}

export function getW6ScaleProfile(stageId) {
  const stage = getScaleStage(stageId);
  return Object.freeze({
    stage,
    movementMetersPerSecond: finiteWorldFrameSpeedToMetersPerSecond(stage.movementSpeed),
    singleAttackRadiusMeters: finiteWorldUnitsToMeters(stage.singleAttackRadius),
    doubleAttackRadiusMeters: finiteWorldUnitsToMeters(stage.doubleAttackRadius),
    attackOffsetXMeters: finiteWorldUnitsToMeters(stage.attackOffsetX),
    attackOffsetZMeters: finiteWorldUnitsToMeters(stage.attackOffsetZ),
    cameraDistanceMeters: finiteWorldUnitsToMeters(stage.cameraDistance),
    cameraHeightMeters: finiteWorldUnitsToMeters(stage.cameraHeight),
    cameraTargetHeightMeters: finiteWorldUnitsToMeters(stage.cameraTargetHeight),
  });
}

export function isW6ScaleStageId(value) {
  return Object.values(SCALE_STAGE_IDS).includes(value) && SCALE_STAGES[value] !== undefined;
}

export function canW6StageDamageTarget(stageId, target) {
  return canScaleStageDamageTarget(stageId, target);
}

export function createW6PlayerState({ x, z } = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new TypeError('finite player spawn is required');
  return Object.freeze({
    x,
    z,
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    score: 0,
    facingY: 0,
  });
}
