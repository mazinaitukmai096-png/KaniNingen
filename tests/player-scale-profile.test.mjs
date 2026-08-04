import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NEW_GAME_PLAYER_SCALE_STAGE_ID,
  PLAYER_MODEL_VERTICAL_BOUNDS_UNITS,
  PLAYER_SCALE_PROFILES,
  resolvePlayerScaleProfile,
} from '../src/player-scale-profile.js';
import { getW6ScaleProfile } from '../src/infinite-world/gameplay-contract.js';
import { segmentEllipsoidFirstHitT } from '../src/infinite-world/gameplay-runtime.js';

test('Player Scale resolver owns the complete Tiny, Mid, and Max physical profile', () => {
  assert.equal(NEW_GAME_PLAYER_SCALE_STAGE_ID, 'TINY');
  assert.deepEqual(
    Object.values(PLAYER_SCALE_PROFILES).map(profile => profile.visualScale),
    [0.08, 0.45, 1],
  );
  for (const stageId of ['TINY', 'MID', 'MAX']) {
    const profile = resolvePlayerScaleProfile(stageId);
    assert.equal(profile.collisionRadius, 65 * profile.visualScale);
    assert.equal(
      profile.collisionHeight,
      PLAYER_MODEL_VERTICAL_BOUNDS_UNITS.height * profile.visualScale,
    );
    assert.equal(
      profile.footOffset,
      -PLAYER_MODEL_VERTICAL_BOUNDS_UNITS.minimum * profile.visualScale,
    );
    assert.deepEqual(profile.playerHitBounds, {
      shape: 'vertical-ellipsoid',
      radius: profile.collisionRadius,
      halfHeight: profile.collisionHeight / 2,
      centerOffsetY: (
        PLAYER_MODEL_VERTICAL_BOUNDS_UNITS.minimum
        + PLAYER_MODEL_VERTICAL_BOUNDS_UNITS.maximum
      ) * profile.visualScale / 2,
    });
    assert.ok(profile.movementSpeed > 0);
    assert.ok(profile.sprintMultiplier > 1);
    assert.ok(profile.jumpVelocity > 0);
    assert.ok(profile.gravity > 0);
    assert.ok(profile.cameraNear > 0);
    assert.ok(profile.singleAttackRadius > 0);
    assert.ok(profile.windArcRadius > 0);
  }
  assert.throws(() => resolvePlayerScaleProfile('UNKNOWN'), /Unknown Player Scale stage/);
});

test('meter profile derives camera, movement, attack, vertical collision, and hit bounds once', () => {
  const assertNear = (actual, expected) => {
    assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
  };
  const tiny = getW6ScaleProfile('TINY');
  assert.equal(tiny.visualScale, 0.08);
  assert.equal(tiny.collision.radiusMeters, 0.13);
  assert.equal(tiny.collision.heightMeters, tiny.stage.collisionHeight / 40);
  assert.equal(tiny.collision.footOffsetMeters, tiny.stage.footOffset / 40);
  assertNear(tiny.movementMetersPerSecond, 5.28);
  assert.equal(tiny.sprintMultiplier, 1.35);
  assertNear(tiny.sprintMetersPerSecond, 7.128);
  assertNear(tiny.jumpVelocityMetersPerSecond, 4.32);
  assertNear(tiny.gravityMetersPerSecondSquared, 18);
  assert.equal(tiny.cameraDistanceMeters, 2.125);
  assert.equal(tiny.cameraHeightMeters, 0.8);
  assert.equal(tiny.cameraTargetHeightMeters, 0.2);
  assert.equal(tiny.cameraNearMeters, 0.0125);
  assert.equal(tiny.singleAttackRadiusMeters, 0.45);
  assert.equal(tiny.doubleAttackRadiusMeters, 0.55);
  assert.equal(tiny.landingRadiusMeters, 0.7);
  assert.equal(tiny.landingPushRadiusMeters, 1.2);
  assert.equal(tiny.windArcRadiusMeters, 0.5);
  assert.equal(tiny.playerHitBounds.shape, 'vertical-ellipsoid');
  assert.equal(tiny.playerHitBounds.radiusMeters, tiny.collision.radiusMeters);
  assert.equal(tiny.playerHitBounds.halfHeightMeters, tiny.collision.heightMeters / 2);
});

test('Scale-aware ellipsoid rejects the old fixed 3m Player hit volume', () => {
  const tiny = getW6ScaleProfile('TINY').playerHitBounds;
  const miss = segmentEllipsoidFirstHitT({
    start: { x: -1, y: 0, z: 1 },
    end: { x: 1, y: 0, z: 1 },
    center: { x: 0, y: 0, z: 0 },
    radiusX: tiny.radiusMeters,
    radiusY: tiny.halfHeightMeters,
    radiusZ: tiny.radiusMeters,
  });
  assert.equal(miss, Infinity, 'a path inside the legacy 3m sphere must miss Tiny bounds');

  const hit = segmentEllipsoidFirstHitT({
    start: { x: -1, y: 0, z: 0 },
    end: { x: 1, y: 0, z: 0 },
    center: { x: 0, y: 0, z: 0 },
    radiusX: tiny.radiusMeters,
    radiusY: tiny.halfHeightMeters,
    radiusZ: tiny.radiusMeters,
  });
  assert.ok(hit >= 0 && hit <= 1);
});
