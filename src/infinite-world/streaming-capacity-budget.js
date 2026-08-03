export const NATURAL_OWNER_BUILD_QUEUE_MAXIMUM = 4;

/**
 * Keeps enough already-ready Natural owners queued to remove the one-frame
 * idle gap between serialized owner builds.  The queue remains deliberately
 * small: every build still crosses the existing host-task boundary and every
 * synchronous slice remains governed by the presentation time budget.
 */
export function resolveNaturalOwnerBuildQueueTarget({ backlog = 0 } = {}) {
  if (!Number.isSafeInteger(backlog) || backlog < 0) {
    throw new RangeError('Natural owner backlog must be a non-negative safe integer');
  }
  if (backlog === 0) return 0;
  if (backlog === 1) return 1;
  return Math.min(
    NATURAL_OWNER_BUILD_QUEUE_MAXIMUM,
    2 + Math.floor((backlog - 2) / 16),
  );
}
