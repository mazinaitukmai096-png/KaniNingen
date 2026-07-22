import {
  ATTACK_COOLDOWN,
  BOSS_HP,
  BOSS_RADIUS,
  BOSS_SCORE_VALUE,
  BOSS_SLITHER_APPROACH_DIST,
  BOSS_SLITHER_SPEED,
  BOSS_SLITHER_SPEED_RAGE,
  PLAYER_MAX_HP,
  SAVE_VERSION,
  TANK_APPROACH_DIST,
  TANK_DESPAWN_DIST,
  TANK_ENGAGE_RANGE,
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
export const W6_INITIAL_SCALE_STAGE_ID = INITIAL_SCALE_STAGE_ID;
export const W6_PLAYER_MAX_HP = PLAYER_MAX_HP;

export const W6_ATTACK_CONTRACT = Object.freeze({
  cooldownMs: ATTACK_COOLDOWN,
  singleDamage: 550,
  doubleDamage: 650,
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
