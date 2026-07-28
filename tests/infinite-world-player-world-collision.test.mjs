import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAYER_WORLD_COLLISION_LIMITS,
  resolveCanonicalPlayerMovement,
} from '../src/infinite-world/player-world-collision.js';

const collider = ({
  stableId,
  x,
  z,
  radius = 1,
  blocksPlayer = true,
  shape = 'circle',
}) => Object.freeze({
  stableId,
  owner: Object.freeze({ x: Math.floor(x / 16), z: Math.floor(z / 16) }),
  position: Object.freeze({ x, y: 0, z }),
  collision: Object.freeze({
    shape,
    radiusMeters: radius,
    halfExtents: null,
    heightMeters: radius * 2,
    blocksPlayer,
  }),
  destruction: Object.freeze({ destructible: true, stateKey: stableId }),
});

const resolve = ({
  startX = 0,
  startZ = 0,
  displacementX = 0,
  displacementZ = 0,
  playerRadiusMeters = 0.5,
  colliders = [],
  ...options
} = {}) => resolveCanonicalPlayerMovement({
  startX,
  startZ,
  displacementX,
  displacementZ,
  playerRadiusMeters,
  maximumColliderRadiusMeters: Math.max(0, ...colliders.map(value => value.collision.radiusMeters)),
  queryColliders: () => colliders,
  ...options,
});

const distanceTo = (result, object) => Math.hypot(
  result.x - object.position.x,
  result.z - object.position.z,
);

test('front contact stops at a canonical circle without penetration', () => {
  const obstacle = collider({ stableId: 'front', x: 2, z: 0, radius: 1 });
  const result = resolve({ displacementX: 4, colliders: [obstacle] });
  assert.equal(result.collided, true);
  assert.ok(result.x <= 0.500001);
  assert.ok(distanceTo(result, obstacle) >= 1.5 - 1e-7);
});

test('diagonal contact slides along the surface and retains tangent movement', () => {
  const obstacle = collider({ stableId: 'slide', x: 0, z: 0, radius: 1 });
  const result = resolve({
    startX: 0,
    startZ: 1.5,
    displacementX: 1,
    displacementZ: -1,
    colliders: [obstacle],
  });
  assert.equal(result.collided, true);
  assert.ok(result.x > 0.9, `tangent X ${result.x}`);
  assert.ok(result.z > 0.9, `sliding Z ${result.z}`);
  assert.ok(distanceTo(result, obstacle) >= 1.5 - 1e-7);
});

test('swept collision prevents high-speed tunneling', () => {
  const obstacle = collider({ stableId: 'sweep', x: 50, z: 0, radius: 2 });
  const result = resolve({
    displacementX: 100,
    colliders: [obstacle],
    maximumSubsteps: 2,
  });
  assert.equal(result.substepLimitReached, true);
  assert.ok(result.x <= 47.500001, `swept X ${result.x}`);
  assert.ok(distanceTo(result, obstacle) >= 2.5 - 1e-7);
});

test('substep and iteration limits are explicit and finite', () => {
  const unobstructed = resolve({ displacementX: 100, maximumSubsteps: 3 });
  assert.equal(unobstructed.substepCount, 3);
  assert.equal(unobstructed.substepLimitReached, true);
  assert.equal(unobstructed.x, 100);

  const obstacle = collider({ stableId: 'iteration', x: 0, z: 0, radius: 1 });
  const limited = resolve({
    startX: -1.5,
    displacementX: 2,
    displacementZ: 1,
    colliders: [obstacle],
    maximumSubsteps: 1,
    maximumIterationsPerSubstep: 1,
  });
  assert.equal(limited.iterationLimitReached, true);
  assert.ok(Number.isFinite(limited.x));
  assert.ok(Number.isFinite(limited.z));
  assert.ok(limited.iterationCount <= 2);
});

test('starting inside a collider pushes out by the minimum separating distance', () => {
  const obstacle = collider({ stableId: 'inside', x: 0, z: 0, radius: 1 });
  const result = resolve({ displacementX: 0.1, colliders: [obstacle] });
  assert.equal(result.collided, true);
  assert.ok(distanceTo(result, obstacle) >= 1.5 - 1e-7);
  assert.ok(result.x > 0);
});

test('multiple contacts and narrow gaps remain finite without abnormal warping', () => {
  const obstacles = [
    collider({ stableId: 'left', x: -0.8, z: 0, radius: 1 }),
    collider({ stableId: 'right', x: 0.8, z: 0, radius: 1 }),
    collider({ stableId: 'forward', x: 0, z: 1.2, radius: 0.75 }),
  ];
  const result = resolve({
    displacementZ: 0.5,
    playerRadiusMeters: 0.3,
    colliders: obstacles,
  });
  assert.ok(Number.isFinite(result.x));
  assert.ok(Number.isFinite(result.z));
  assert.ok(Math.hypot(result.x, result.z) < 5);
  assert.ok(result.collisionStableIds.length >= 2);
});

test('zero displacement is an exact no-op and performs no broadphase query', () => {
  let queryCount = 0;
  const result = resolveCanonicalPlayerMovement({
    startX: 12.5,
    startZ: -7.25,
    displacementX: 0,
    displacementZ: 0,
    playerRadiusMeters: 0.5,
    maximumColliderRadiusMeters: 4,
    queryColliders() { queryCount += 1; return []; },
  });
  assert.equal(result.x, 12.5);
  assert.equal(result.z, -7.25);
  assert.equal(result.substepCount, 0);
  assert.equal(queryCount, 0);
});

test('only blocksPlayer controls participation and the resolver has bounded defaults', () => {
  const disabled = collider({
    stableId: 'disabled', x: 1, z: 0, radius: 10, blocksPlayer: false,
  });
  const result = resolve({ displacementX: 2, colliders: [disabled] });
  assert.equal(result.collided, false);
  assert.equal(result.x, 2);
  assert.deepEqual(PLAYER_WORLD_COLLISION_LIMITS, {
    maximumSubsteps: 32,
    maximumIterationsPerSubstep: 4,
    minimumSubstepDistanceMeters: 0.25,
  });
});
