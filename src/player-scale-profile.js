import {
  PLAYER_GRAVITY,
  PLAYER_JUMP_VELOCITY,
  PLAYER_RADIUS,
} from './constants.js';

export const PLAYER_SCALE_STAGE_IDS = Object.freeze({
  TINY: 'TINY',
  MID: 'MID',
  MAX: 'MAX',
});

export const NEW_GAME_PLAYER_SCALE_STAGE_ID = PLAYER_SCALE_STAGE_IDS.TINY;

const TINY_REFERENCE_VISUAL_SCALE = 0.08;
const TINY_VISUAL_SCALE = 0.04;
const TINY_LINEAR_SCALE = TINY_VISUAL_SCALE / TINY_REFERENCE_VISUAL_SCALE;
const scaleTinyLinearValue = value => value * TINY_LINEAR_SCALE;
const finiteMetersPerSecondToFrameSpeed = value => value * 40 / 60;
const finiteFrameSpeedToMetersPerSecond = value => value / 40 * 60;
const MAX_SPRINT_METERS_PER_SECOND = 30;
const MAX_SPRINT_MULTIPLIER = 1.45;

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
  const cameraWheelZoomScale = Math.max(
    Number.EPSILON,
    (cameraMaxDistance - cameraMinDistance) / 1000,
  );
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
    cameraWheelZoomScale,
    cameraGroundClearance,
    allowedTargetClass,
  });
}

export const PLAYER_SCALE_PROFILES = Object.freeze({
  [PLAYER_SCALE_STAGE_IDS.TINY]: createProfile({
    id: PLAYER_SCALE_STAGE_IDS.TINY,
    label: 'Tiny',
    visualScale: TINY_VISUAL_SCALE,
    movementSpeed: finiteMetersPerSecondToFrameSpeed(3.5),
    sprintMultiplier: 1.3,
    jumpVelocity: PLAYER_JUMP_VELOCITY * 0.075,
    gravity: PLAYER_GRAVITY / 8,
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
    visualScale: 0.2,
    movementSpeed: finiteMetersPerSecondToFrameSpeed(12),
    sprintMultiplier: 1.4,
    jumpVelocity: PLAYER_JUMP_VELOCITY * 0.375,
    gravity: PLAYER_GRAVITY * 0.5,
    attackOffsetX: 36,
    attackOffsetZ: 38,
    singleAttackRadius: 74,
    doubleAttackRadius: 80,
    landingRadius: 102,
    landingPushRadius: 205,
    landingShake: 16,
    playerShakeMultiplier: 0.2,
    cameraShakeCap: 43,
    windArcRadius: 40,
    windArcParticleScale: 0.35,
    cameraDistance: 130,
    cameraMinDistance: 85,
    cameraMaxDistance: 300,
    cameraHeight: 55,
    cameraNear: 2,
    cameraPitch: 0.55,
    cameraMinPitch: 0.07,
    cameraMaxPitch: 1.46,
    cameraTargetHeight: 30,
    cameraGroundClearance: 5,
    allowedTargetClass: 'MID_SANDBOX',
  }),
  [PLAYER_SCALE_STAGE_IDS.MAX]: createProfile({
    id: PLAYER_SCALE_STAGE_IDS.MAX,
    label: 'Max',
    // The former MID profile is now the production maximum.  This caps the
    // player at the largest scale supported by the current world streaming
    // contract.  Sprint is capped at 30m/s to leave completion headroom for
    // future world density instead of running at the edge of generation.
    visualScale: 0.45,
    movementSpeed: finiteMetersPerSecondToFrameSpeed(
      MAX_SPRINT_METERS_PER_SECOND / MAX_SPRINT_MULTIPLIER,
    ),
    sprintMultiplier: MAX_SPRINT_MULTIPLIER,
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
    allowedTargetClass: 'ALL',
  }),
});

export const PLAYER_MAX_SPRINT_METERS_PER_SECOND = finiteFrameSpeedToMetersPerSecond(
  PLAYER_SCALE_PROFILES[PLAYER_SCALE_STAGE_IDS.MAX].movementSpeed,
) * PLAYER_SCALE_PROFILES[PLAYER_SCALE_STAGE_IDS.MAX].sprintMultiplier;

export function resolvePlayerScaleProfile(stageId) {
  const profile = PLAYER_SCALE_PROFILES[stageId];
  if (!profile) throw new RangeError(`Unknown Player Scale stage: ${stageId}`);
  return profile;
}
