import {
  CAM_INITIAL_DIST,
  CAM_INITIAL_PITCH,
  CAM_MAX_DIST,
  CAM_MAX_PITCH,
  CAM_MIN_DIST,
  CAM_MIN_PITCH,
  PLAYER_GRAVITY,
  PLAYER_JUMP_VELOCITY,
  PLAYER_RADIUS,
  PLAYER_SPEED,
} from './constants.js';

export const SCALE_STAGE_IDS = Object.freeze({
  TINY: 'TINY',
  MID: 'MID',
  MAX: 'MAX',
});

export const INITIAL_SCALE_STAGE_ID = SCALE_STAGE_IDS.MAX;

export const SCALE_STAGES = Object.freeze({
  [SCALE_STAGE_IDS.TINY]: Object.freeze({
    id: SCALE_STAGE_IDS.TINY,
    label: 'Tiny',
    visualScale: 0.15,
    collisionRadius: PLAYER_RADIUS * 0.15,
    movementSpeed: PLAYER_SPEED * 0.5,
    jumpVelocity: PLAYER_JUMP_VELOCITY * 0.6,
    gravity: PLAYER_GRAVITY,
    attackOffsetX: 30,
    attackOffsetZ: 36,
    singleAttackRadius: 70,
    doubleAttackRadius: 76,
    landingRadius: 110,
    landingPushRadius: 220,
    landingShake: 12,
    playerShakeMultiplier: 0.15,
    cameraShakeCap: 36,
    windArcRadius: 38,
    windArcParticleScale: 0.4,
    cameraDistance: 140,
    cameraMinDistance: 90,
    cameraMaxDistance: 360,
    cameraHeight: 55,
    cameraNear: 1,
    cameraPitch: 0.55,
    cameraMinPitch: 0.05,
    cameraMaxPitch: 1.5,
    cameraTargetHeight: 18,
    cameraYawRestriction: 'FULL',
    cameraRotationSensitivity: 1,
    cameraGroundClearance: 6,
    allowedTargetClass: 'TINY_SANDBOX',
  }),
  [SCALE_STAGE_IDS.MID]: Object.freeze({
    id: SCALE_STAGE_IDS.MID,
    label: 'Mid',
    visualScale: 0.45,
    collisionRadius: PLAYER_RADIUS * 0.45,
    movementSpeed: PLAYER_SPEED * 0.75,
    jumpVelocity: PLAYER_JUMP_VELOCITY * 0.8,
    gravity: PLAYER_GRAVITY,
    attackOffsetX: 80,
    attackOffsetZ: 85,
    singleAttackRadius: 165,
    doubleAttackRadius: 180,
    landingRadius: 230,
    landingPushRadius: 460,
    landingShake: 36,
    playerShakeMultiplier: 0.45,
    cameraShakeCap: 96,
    windArcRadius: 90,
    windArcParticleScale: 0.55,
    cameraDistance: 280,
    cameraMinDistance: 180,
    cameraMaxDistance: 650,
    cameraHeight: 115,
    cameraNear: 4,
    cameraPitch: 0.55,
    cameraMinPitch: 0.08,
    cameraMaxPitch: 1.42,
    cameraTargetHeight: 65,
    cameraYawRestriction: 'FULL',
    cameraRotationSensitivity: 1,
    cameraGroundClearance: 10,
    allowedTargetClass: 'MID_SANDBOX',
  }),
  [SCALE_STAGE_IDS.MAX]: Object.freeze({
    id: SCALE_STAGE_IDS.MAX,
    label: 'Max',
    visualScale: 1,
    collisionRadius: PLAYER_RADIUS,
    movementSpeed: PLAYER_SPEED,
    jumpVelocity: PLAYER_JUMP_VELOCITY,
    gravity: PLAYER_GRAVITY,
    attackOffsetX: 180,
    attackOffsetZ: 180,
    singleAttackRadius: 350,
    doubleAttackRadius: 380,
    landingRadius: 500,
    landingPushRadius: 1000,
    landingShake: 80,
    playerShakeMultiplier: 1,
    cameraShakeCap: Infinity,
    windArcRadius: 180,
    windArcParticleScale: 1,
    cameraDistance: CAM_INITIAL_DIST,
    cameraMinDistance: CAM_MIN_DIST,
    cameraMaxDistance: CAM_MAX_DIST,
    cameraHeight: 200,
    cameraNear: 10,
    cameraPitch: CAM_INITIAL_PITCH,
    cameraMinPitch: CAM_MIN_PITCH,
    cameraMaxPitch: CAM_MAX_PITCH,
    cameraTargetHeight: 120,
    cameraYawRestriction: 'FULL',
    cameraRotationSensitivity: 1,
    cameraGroundClearance: 12,
    allowedTargetClass: 'ALL',
  }),
});

export const HUMAN_VISUAL_SCALES = Object.freeze({
  CURRENT: 1,
  COMPARE_065: 0.65,
  PRODUCTION_050: 0.5,
  COMPARE_040: 0.4,
});

export function getScaleStage(stageId) {
  const stage = SCALE_STAGES[stageId];
  if (!stage) throw new RangeError(`Unknown scale sandbox stage: ${stageId}`);
  return stage;
}

export function canScaleStageDamageTarget(stageId, target) {
  const stage = getScaleStage(stageId);
  if (stage.allowedTargetClass === 'ALL') return true;
  if (!target || typeof target.type !== 'string') return false;

  if (stage.allowedTargetClass === 'TINY_SANDBOX') {
    return target.type === 'pebble' || (target.type === 'tree' && target.radius <= 25);
  }

  if (stage.allowedTargetClass === 'MID_SANDBOX') {
    return target.type === 'tree'
      || target.type === 'pebble'
      || target.type === 'human'
      || (target.type === 'house' && target.radius <= 60);
  }

  return false;
}

// Atomic本体は将来のLegendary Capstone資産として保持し、Scale Sandbox中は封印する。
export function isScaleSandboxAtomicEnabled() {
  return false;
}
