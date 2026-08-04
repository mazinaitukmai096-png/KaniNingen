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

export const PLAYER_SCALE_STAGE_IDS = Object.freeze({
  TINY: 'TINY',
  MID: 'MID',
  MAX: 'MAX',
});

export const NEW_GAME_PLAYER_SCALE_STAGE_ID = PLAYER_SCALE_STAGE_IDS.TINY;

const TINY_REFERENCE_VISUAL_SCALE = 0.08;
const TINY_VISUAL_SCALE = 0.05;
const TINY_LINEAR_SCALE = TINY_VISUAL_SCALE / TINY_REFERENCE_VISUAL_SCALE;
const scaleTinyLinearValue = value => value * TINY_LINEAR_SCALE;
const finiteMetersPerSecondToFrameSpeed = value => value * 40 / 60;

const PLAYER_LEG_HALF_WIDTH_UNITS = 7.5;
const PLAYER_LEG_HALF_HEIGHT_UNITS = 22.5;
const PLAYER_LEG_ROTATION_RADIANS = 0.35;
const PLAYER_MODEL_MAXIMUM_Y_UNITS = 73;
const playerLegVerticalExtent = Math.abs(Math.sin(PLAYER_LEG_ROTATION_RADIANS))
  * PLAYER_LEG_HALF_WIDTH_UNITS
  + Math.abs(Math.cos(PLAYER_LEG_ROTATION_RADIANS)) * PLAYER_LEG_HALF_HEIGHT_UNITS;

export const PLAYER_MODEL_VERTICAL_BOUNDS_UNITS = Object.freeze({
  minimum: -playerLegVerticalExtent,
  maximum: PLAYER_MODEL_MAXIMUM_Y_UNITS,
  height: PLAYER_MODEL_MAXIMUM_Y_UNITS + playerLegVerticalExtent,
});

function createProfile({
  id,
  label,
  visualScale,
  movementSpeed,
  sprintMultiplier,
  jumpVelocity,
  gravity,
  attackOffsetX,
  attackOffsetZ,
  singleAttackRadius,
  doubleAttackRadius,
  landingRadius,
  landingPushRadius,
  landingShake,
  playerShakeMultiplier,
  cameraShakeCap,
  windArcRadius,
  windArcParticleScale,
  cameraDistance,
  cameraMinDistance,
  cameraMaxDistance,
  cameraHeight,
  cameraNear,
  cameraPitch,
  cameraMinPitch,
  cameraMaxPitch,
  cameraTargetHeight,
  cameraGroundClearance,
  allowedTargetClass,
}) {
  const collisionRadius = PLAYER_RADIUS * visualScale;
  const collisionHeight = PLAYER_MODEL_VERTICAL_BOUNDS_UNITS.height * visualScale;
  const footOffset = -PLAYER_MODEL_VERTICAL_BOUNDS_UNITS.minimum * visualScale;
  const playerHitBounds = Object.freeze({
    shape: 'vertical-ellipsoid',
    radius: collisionRadius,
    halfHeight: collisionHeight / 2,
    centerOffsetY: (
      PLAYER_MODEL_VERTICAL_BOUNDS_UNITS.minimum
      + PLAYER_MODEL_VERTICAL_BOUNDS_UNITS.maximum
    ) * visualScale / 2,
  });
  return Object.freeze({
    id,
    label,
    visualScale,
    collisionRadius,
    collisionHeight,
    footOffset,
    playerHitBounds,
    movementSpeed,
    sprintMultiplier,
    jumpVelocity,
    gravity,
    attackOffsetX,
    attackOffsetZ,
    singleAttackRadius,
    doubleAttackRadius,
    landingRadius,
    landingPushRadius,
    landingShake,
    playerShakeMultiplier,
    cameraShakeCap,
    windArcRadius,
    windArcParticleScale,
    cameraDistance,
    cameraMinDistance,
    cameraMaxDistance,
    cameraHeight,
    cameraNear,
    cameraPitch,
    cameraMinPitch,
    cameraMaxPitch,
    cameraTargetHeight,
    cameraYawRestriction: 'FULL',
    cameraRotationSensitivity: 1,
    cameraGroundClearance,
    allowedTargetClass,
  });
}

export const PLAYER_SCALE_PROFILES = Object.freeze({
  [PLAYER_SCALE_STAGE_IDS.TINY]: createProfile({
    id: PLAYER_SCALE_STAGE_IDS.TINY,
    label: 'Tiny',
    visualScale: TINY_VISUAL_SCALE,
    movementSpeed: finiteMetersPerSecondToFrameSpeed(4),
    sprintMultiplier: 1.35,
    jumpVelocity: PLAYER_JUMP_VELOCITY * 0.09,
    gravity: PLAYER_GRAVITY / 7,
    attackOffsetX: scaleTinyLinearValue(8),
    attackOffsetZ: scaleTinyLinearValue(10),
    singleAttackRadius: scaleTinyLinearValue(18),
    doubleAttackRadius: scaleTinyLinearValue(22),
    landingRadius: scaleTinyLinearValue(28),
    landingPushRadius: scaleTinyLinearValue(48),
    landingShake: scaleTinyLinearValue(6),
    playerShakeMultiplier: TINY_VISUAL_SCALE,
    cameraShakeCap: scaleTinyLinearValue(20),
    windArcRadius: scaleTinyLinearValue(20),
    windArcParticleScale: scaleTinyLinearValue(0.22),
    cameraDistance: scaleTinyLinearValue(85),
    cameraMinDistance: scaleTinyLinearValue(50),
    cameraMaxDistance: scaleTinyLinearValue(220),
    cameraHeight: scaleTinyLinearValue(32),
    cameraNear: scaleTinyLinearValue(0.5),
    cameraPitch: 0.55,
    cameraMinPitch: 0.05,
    cameraMaxPitch: 1.5,
    cameraTargetHeight: scaleTinyLinearValue(8),
    cameraGroundClearance: scaleTinyLinearValue(3),
    allowedTargetClass: 'TINY_SANDBOX',
  }),
  [PLAYER_SCALE_STAGE_IDS.MID]: createProfile({
    id: PLAYER_SCALE_STAGE_IDS.MID,
    label: 'Mid',
    visualScale: 0.45,
    movementSpeed: PLAYER_SPEED * 0.75,
    sprintMultiplier: 1.45,
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
    cameraGroundClearance: 10,
    allowedTargetClass: 'MID_SANDBOX',
  }),
  [PLAYER_SCALE_STAGE_IDS.MAX]: createProfile({
    id: PLAYER_SCALE_STAGE_IDS.MAX,
    label: 'Max',
    visualScale: 1,
    movementSpeed: PLAYER_SPEED,
    sprintMultiplier: 1.45,
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
    cameraGroundClearance: 12,
    allowedTargetClass: 'ALL',
  }),
});

export function resolvePlayerScaleProfile(stageId) {
  const profile = PLAYER_SCALE_PROFILES[stageId];
  if (!profile) throw new RangeError(`Unknown Player Scale stage: ${stageId}`);
  return profile;
}
