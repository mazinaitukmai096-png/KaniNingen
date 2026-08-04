import {
  NEW_GAME_PLAYER_SCALE_STAGE_ID,
  PLAYER_SCALE_PROFILES,
  PLAYER_SCALE_STAGE_IDS,
  resolvePlayerScaleProfile,
} from './player-scale-profile.js';

export const SCALE_STAGE_IDS = PLAYER_SCALE_STAGE_IDS;
export const INITIAL_SCALE_STAGE_ID = NEW_GAME_PLAYER_SCALE_STAGE_ID;
export const SCALE_STAGES = PLAYER_SCALE_PROFILES;

export const HUMAN_VISUAL_SCALES = Object.freeze({
  CURRENT: 1,
  COMPARE_065: 0.65,
  PRODUCTION_050: 0.5,
  COMPARE_040: 0.4,
});

export function getScaleStage(stageId) {
  return resolvePlayerScaleProfile(stageId);
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
      || target.type === 'house';
  }

  return false;
}

// Atomic本体は将来のLegendary Capstone資産として保持し、Scale Sandbox中は封印する。
export function isScaleSandboxAtomicEnabled() {
  return false;
}
