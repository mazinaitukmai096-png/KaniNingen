export const PLAYER_WORLD_COLLISION_LIMITS = Object.freeze({
  maximumSubsteps: 32,
  maximumIterationsPerSubstep: 4,
  minimumSubstepDistanceMeters: 0.25,
});

const EPSILON = 1e-9;
const CONTACT_EPSILON_METERS = 1e-7;
const SUPPORTED_CIRCLE_SHAPES = new Set(['circle', 'horizontal-circle']);

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function positive(value, name) {
  const result = finite(value, name);
  if (result <= 0) throw new RangeError(`${name} must be positive`);
  return result;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function canonicalCircleCollider(object) {
  const collision = object?.collision;
  if (collision?.blocksPlayer !== true || !SUPPORTED_CIRCLE_SHAPES.has(collision.shape)) return null;
  if (typeof object.stableId !== 'string' || !object.stableId
    || !Number.isSafeInteger(object.owner?.x) || !Number.isSafeInteger(object.owner?.z)
    || !Number.isFinite(object.position?.x) || !Number.isFinite(object.position?.z)
    || !Number.isFinite(collision.radiusMeters) || collision.radiusMeters <= 0) {
    throw new TypeError('blocking canonical circle collider is malformed');
  }
  return object;
}

function deterministicNormal(stableId, preferredX, preferredZ) {
  const preferredLength = Math.hypot(preferredX, preferredZ);
  if (preferredLength > EPSILON) {
    return { x: preferredX / preferredLength, z: preferredZ / preferredLength };
  }
  let hash = 2166136261;
  for (const character of stableId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const angle = (hash >>> 0) / 0x1_0000_0000 * Math.PI * 2;
  return { x: Math.cos(angle), z: Math.sin(angle) };
}

function contactNormal(x, z, collider, preferredX, preferredZ) {
  const offsetX = x - collider.position.x;
  const offsetZ = z - collider.position.z;
  const length = Math.hypot(offsetX, offsetZ);
  if (length > EPSILON) return { x: offsetX / length, z: offsetZ / length };
  return deterministicNormal(collider.stableId, preferredX, preferredZ);
}

function overlapDepth(x, z, playerRadiusMeters, collider) {
  const combinedRadius = playerRadiusMeters + collider.collision.radiusMeters;
  return combinedRadius - Math.hypot(
    x - collider.position.x,
    z - collider.position.z,
  );
}

function deepestOverlap(x, z, playerRadiusMeters, colliders) {
  let result = null;
  for (const collider of colliders) {
    const depth = overlapDepth(x, z, playerRadiusMeters, collider);
    if (depth <= CONTACT_EPSILON_METERS) continue;
    if (!result || depth > result.depth + EPSILON
      || (Math.abs(depth - result.depth) <= EPSILON
        && collider.stableId.localeCompare(result.collider.stableId) < 0)) {
      result = { collider, depth };
    }
  }
  return result;
}

function depenetrate({
  x,
  z,
  playerRadiusMeters,
  colliders,
  preferredX,
  preferredZ,
  maximumIterations,
  collisionIds,
}) {
  let iterations = 0;
  for (; iterations < maximumIterations; iterations += 1) {
    const overlap = deepestOverlap(x, z, playerRadiusMeters, colliders);
    if (!overlap) break;
    const normal = contactNormal(
      x, z, overlap.collider, preferredX, preferredZ,
    );
    const pushDistance = overlap.depth + CONTACT_EPSILON_METERS;
    x += normal.x * pushDistance;
    z += normal.z * pushDistance;
    collisionIds.add(overlap.collider.stableId);
  }
  return {
    x,
    z,
    iterations,
    limitReached: iterations === maximumIterations
      && deepestOverlap(x, z, playerRadiusMeters, colliders) !== null,
  };
}

function firstSweepContact(x, z, moveX, moveZ, playerRadiusMeters, colliders) {
  const movementSquared = moveX * moveX + moveZ * moveZ;
  if (movementSquared <= EPSILON) return null;
  let result = null;
  for (const collider of colliders) {
    const offsetX = x - collider.position.x;
    const offsetZ = z - collider.position.z;
    const combinedRadius = playerRadiusMeters + collider.collision.radiusMeters;
    const distanceTerm = offsetX * offsetX + offsetZ * offsetZ
      - combinedRadius * combinedRadius;
    const approach = offsetX * moveX + offsetZ * moveZ;
    let time = null;
    if (distanceTerm <= CONTACT_EPSILON_METERS) {
      const normal = contactNormal(x, z, collider, moveX, moveZ);
      if (moveX * normal.x + moveZ * normal.z < -EPSILON) time = 0;
    } else if (approach < 0) {
      const discriminant = approach * approach - movementSquared * distanceTerm;
      if (discriminant >= 0) {
        const candidate = (-approach - Math.sqrt(Math.max(0, discriminant)))
          / movementSquared;
        if (candidate >= 0 && candidate <= 1) time = candidate;
      }
    }
    if (time === null) continue;
    if (!result || time < result.time - EPSILON
      || (Math.abs(time - result.time) <= EPSILON
        && collider.stableId.localeCompare(result.collider.stableId) < 0)) {
      result = { collider, time };
    }
  }
  return result;
}

function resolveSubstep({
  x,
  z,
  moveX,
  moveZ,
  playerRadiusMeters,
  colliders,
  maximumIterations,
  collisionIds,
}) {
  const overlapResolution = depenetrate({
    x,
    z,
    playerRadiusMeters,
    colliders,
    preferredX: moveX,
    preferredZ: moveZ,
    maximumIterations,
    collisionIds,
  });
  x = overlapResolution.x;
  z = overlapResolution.z;
  let remainingX = moveX;
  let remainingZ = moveZ;
  let sweepIterations = 0;
  let iterationLimitReached = overlapResolution.limitReached;
  const sweepIterationBudget = Math.max(0, maximumIterations - overlapResolution.iterations);

  for (; sweepIterations < sweepIterationBudget; sweepIterations += 1) {
    if (Math.hypot(remainingX, remainingZ) <= EPSILON) break;
    const contact = firstSweepContact(
      x, z, remainingX, remainingZ, playerRadiusMeters, colliders,
    );
    if (!contact) {
      x += remainingX;
      z += remainingZ;
      remainingX = 0;
      remainingZ = 0;
      break;
    }
    x += remainingX * contact.time;
    z += remainingZ * contact.time;
    const normal = contactNormal(x, z, contact.collider, remainingX, remainingZ);
    x += normal.x * CONTACT_EPSILON_METERS;
    z += normal.z * CONTACT_EPSILON_METERS;
    collisionIds.add(contact.collider.stableId);
    const remainderScale = Math.max(0, 1 - contact.time);
    remainingX *= remainderScale;
    remainingZ *= remainderScale;
    const normalMovement = remainingX * normal.x + remainingZ * normal.z;
    if (normalMovement < 0) {
      remainingX -= normal.x * normalMovement;
      remainingZ -= normal.z * normalMovement;
    }
  }
  if (sweepIterations === sweepIterationBudget
    && Math.hypot(remainingX, remainingZ) > EPSILON) iterationLimitReached = true;

  const finalIterationBudget = Math.max(
    0,
    maximumIterations - overlapResolution.iterations - sweepIterations,
  );
  const finalResolution = depenetrate({
    x,
    z,
    playerRadiusMeters,
    colliders,
    preferredX: moveX,
    preferredZ: moveZ,
    maximumIterations: finalIterationBudget,
    collisionIds,
  });
  return {
    x: finalResolution.x,
    z: finalResolution.z,
    iterationCount: overlapResolution.iterations + sweepIterations + finalResolution.iterations,
    iterationLimitReached: iterationLimitReached || finalResolution.limitReached,
  };
}

export function resolveCanonicalPlayerMovement({
  startX,
  startZ,
  displacementX,
  displacementZ,
  playerRadiusMeters,
  maximumColliderRadiusMeters = 0,
  queryColliders,
  maximumSubsteps = PLAYER_WORLD_COLLISION_LIMITS.maximumSubsteps,
  maximumIterationsPerSubstep = PLAYER_WORLD_COLLISION_LIMITS.maximumIterationsPerSubstep,
  minimumSubstepDistanceMeters = PLAYER_WORLD_COLLISION_LIMITS.minimumSubstepDistanceMeters,
} = {}) {
  let x = finite(startX, 'startX');
  let z = finite(startZ, 'startZ');
  const moveX = finite(displacementX, 'displacementX');
  const moveZ = finite(displacementZ, 'displacementZ');
  const radius = positive(playerRadiusMeters, 'playerRadiusMeters');
  const maximumColliderRadius = finite(maximumColliderRadiusMeters, 'maximumColliderRadiusMeters');
  if (maximumColliderRadius < 0) {
    throw new RangeError('maximumColliderRadiusMeters must not be negative');
  }
  if (typeof queryColliders !== 'function') {
    throw new TypeError('queryColliders must be a function');
  }
  const substepLimit = positiveInteger(maximumSubsteps, 'maximumSubsteps');
  const iterationLimit = positiveInteger(
    maximumIterationsPerSubstep, 'maximumIterationsPerSubstep',
  );
  const minimumSubstep = positive(
    minimumSubstepDistanceMeters, 'minimumSubstepDistanceMeters',
  );
  const distance = Math.hypot(moveX, moveZ);
  if (distance <= EPSILON) {
    return Object.freeze({
      x,
      z,
      collided: false,
      collisionStableIds: Object.freeze([]),
      substepCount: 0,
      requestedSubstepCount: 0,
      substepLimitReached: false,
      iterationCount: 0,
      iterationLimitReached: false,
    });
  }

  const targetSubstepDistance = Math.max(minimumSubstep, radius);
  const requestedSubstepCount = Math.max(1, Math.ceil(distance / targetSubstepDistance));
  const substepCount = Math.min(substepLimit, requestedSubstepCount);
  const substepX = moveX / substepCount;
  const substepZ = moveZ / substepCount;
  const collisionIds = new Set();
  let iterationCount = 0;
  let iterationLimitReached = false;

  for (let index = 0; index < substepCount; index += 1) {
    const padding = radius + maximumColliderRadius;
    const queryBounds = Object.freeze({
      minimumX: Math.min(x, x + substepX) - padding,
      minimumZ: Math.min(z, z + substepZ) - padding,
      maximumX: Math.max(x, x + substepX) + padding,
      maximumZ: Math.max(z, z + substepZ) + padding,
    });
    const colliders = [];
    const seen = new Set();
    for (const object of queryColliders(queryBounds) ?? []) {
      const collider = canonicalCircleCollider(object);
      if (!collider || seen.has(collider.stableId)) continue;
      seen.add(collider.stableId);
      colliders.push(collider);
    }
    colliders.sort((left, right) => left.stableId.localeCompare(right.stableId));
    const resolved = resolveSubstep({
      x,
      z,
      moveX: substepX,
      moveZ: substepZ,
      playerRadiusMeters: radius,
      colliders,
      maximumIterations: iterationLimit,
      collisionIds,
    });
    if (!Number.isFinite(resolved.x) || !Number.isFinite(resolved.z)) {
      throw new Error('canonical Player collision produced a non-finite position');
    }
    x = resolved.x;
    z = resolved.z;
    iterationCount += resolved.iterationCount;
    iterationLimitReached ||= resolved.iterationLimitReached;
  }

  return Object.freeze({
    x,
    z,
    collided: collisionIds.size > 0,
    collisionStableIds: Object.freeze([...collisionIds].sort((a, b) => a.localeCompare(b))),
    substepCount,
    requestedSubstepCount,
    substepLimitReached: requestedSubstepCount > substepLimit,
    iterationCount,
    iterationLimitReached,
  });
}
