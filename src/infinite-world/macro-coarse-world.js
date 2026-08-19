import { PLAYER_MAX_SPRINT_METERS_PER_SECOND } from '../player-scale-profile.js';

export const MACRO_CELL_SIZE_METERS = 64;
export const MACRO_OWNER_SIZE_METERS = 16;
export const MACRO_OWNERS_PER_AXIS = MACRO_CELL_SIZE_METERS / MACRO_OWNER_SIZE_METERS;
export const MACRO_RESIDENT_RADIUS_METERS = 416;
export const MACRO_VISIBLE_RADIUS_METERS = 352;
export const MACRO_MAX_NEW_CELLS_PER_FRAME = 1;
export const MACRO_DEFAULT_MAX_IN_FLIGHT = 2;
export const MACRO_MAX_RETAINED_CELLS = 174;
export const MACRO_MAX_SPRINT_METERS_PER_SECOND = PLAYER_MAX_SPRINT_METERS_PER_SECOND;

const EPSILON = 1e-9;
const INITIAL_FILL_RADII_METERS = Object.freeze([100, 200, 300, 352]);

const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

function assertMacroCoordinate(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  return Object.is(value, -0) ? 0 : value;
}

function assertFinitePoint(worldX, worldZ) {
  if (![worldX, worldZ].every(Number.isFinite)) {
    throw new TypeError('finite logical world coordinates are required');
  }
}

export function macroCellKey(macroX, macroZ) {
  return `${assertMacroCoordinate(macroX, 'macroX')},${assertMacroCoordinate(macroZ, 'macroZ')}`;
}

export function parseMacroCellKey(key) {
  if (typeof key !== 'string' || !/^-?\d+,-?\d+$/.test(key)) {
    throw new TypeError('invalid Macro cell key');
  }
  const [macroX, macroZ] = key.split(',').map(Number);
  return Object.freeze({
    macroX: assertMacroCoordinate(macroX, 'macroX'),
    macroZ: assertMacroCoordinate(macroZ, 'macroZ'),
  });
}

export function logicalWorldToMacroCell(worldX, worldZ) {
  assertFinitePoint(worldX, worldZ);
  const rawMacroX = Math.floor(worldX / MACRO_CELL_SIZE_METERS);
  const rawMacroZ = Math.floor(worldZ / MACRO_CELL_SIZE_METERS);
  const macroX = Object.is(rawMacroX, -0) ? 0 : rawMacroX;
  const macroZ = Object.is(rawMacroZ, -0) ? 0 : rawMacroZ;
  return Object.freeze({ macroX, macroZ, key: macroCellKey(macroX, macroZ) });
}

export function macroCellBounds(macroX, macroZ) {
  assertMacroCoordinate(macroX, 'macroX');
  assertMacroCoordinate(macroZ, 'macroZ');
  const minimumX = macroX * MACRO_CELL_SIZE_METERS;
  const minimumZ = macroZ * MACRO_CELL_SIZE_METERS;
  return Object.freeze({
    minimumX,
    minimumZ,
    maximumX: minimumX + MACRO_CELL_SIZE_METERS,
    maximumZ: minimumZ + MACRO_CELL_SIZE_METERS,
    centerX: minimumX + MACRO_CELL_SIZE_METERS / 2,
    centerZ: minimumZ + MACRO_CELL_SIZE_METERS / 2,
  });
}

export function pointToMacroCellAabbDistance(worldX, worldZ, macroX, macroZ) {
  assertFinitePoint(worldX, worldZ);
  const bounds = macroCellBounds(macroX, macroZ);
  const dx = worldX < bounds.minimumX
    ? bounds.minimumX - worldX
    : worldX > bounds.maximumX ? worldX - bounds.maximumX : 0;
  const dz = worldZ < bounds.minimumZ
    ? bounds.minimumZ - worldZ
    : worldZ > bounds.maximumZ ? worldZ - bounds.maximumZ : 0;
  return Math.hypot(dx, dz);
}

function coverageEntry(macroX, macroZ, centerWorldX, centerWorldZ) {
  const bounds = macroCellBounds(macroX, macroZ);
  return Object.freeze({
    macroX,
    macroZ,
    key: macroCellKey(macroX, macroZ),
    bounds,
    distanceMeters: q6(pointToMacroCellAabbDistance(
      centerWorldX,
      centerWorldZ,
      macroX,
      macroZ,
    )),
  });
}

export function createMacroResidentCoverage({
  macroX,
  macroZ,
  radiusMeters = MACRO_RESIDENT_RADIUS_METERS,
} = {}) {
  assertMacroCoordinate(macroX, 'macroX');
  assertMacroCoordinate(macroZ, 'macroZ');
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0) {
    throw new RangeError('Macro resident radius must be finite and non-negative');
  }
  const center = macroCellBounds(macroX, macroZ);
  const reach = Math.ceil(radiusMeters / MACRO_CELL_SIZE_METERS) + 1;
  const cells = [];
  for (let z = macroZ - reach; z <= macroZ + reach; z += 1) {
    for (let x = macroX - reach; x <= macroX + reach; x += 1) {
      const entry = coverageEntry(x, z, center.centerX, center.centerZ);
      if (entry.distanceMeters <= radiusMeters + EPSILON) cells.push(entry);
    }
  }
  cells.sort((left, right) => (
    left.distanceMeters - right.distanceMeters
      || left.macroZ - right.macroZ
      || left.macroX - right.macroX
  ));
  return Object.freeze(cells);
}

function coverageMap(coverage) {
  if (!Array.isArray(coverage)) throw new TypeError('Macro coverage must be an array');
  return new Map(coverage.map(cell => [cell.key, cell]));
}

export function diffMacroCoverage(previousCoverage = [], nextCoverage = []) {
  const previous = coverageMap(previousCoverage);
  const next = coverageMap(nextCoverage);
  const unchanged = [];
  const entering = [];
  const leaving = [];
  for (const cell of nextCoverage) {
    if (previous.has(cell.key)) unchanged.push(cell);
    else entering.push(cell);
  }
  for (const cell of previousCoverage) {
    if (!next.has(cell.key)) leaving.push(cell);
  }
  return Object.freeze({
    unchanged: Object.freeze(unchanged),
    entering: Object.freeze(entering),
    leaving: Object.freeze(leaving),
  });
}

export function macroInitialFillCohorts({
  macroX = 0,
  macroZ = 0,
  playerX = null,
  playerZ = null,
} = {}) {
  const center = macroCellBounds(macroX, macroZ);
  const hasPlayer = Number.isFinite(playerX) && Number.isFinite(playerZ);
  if ((playerX !== null || playerZ !== null) && !hasPlayer) {
    throw new TypeError('initial fill player coordinates must both be finite');
  }
  const cohortCenterX = hasPlayer ? playerX : center.centerX;
  const cohortCenterZ = hasPlayer ? playerZ : center.centerZ;
  const resident = createMacroResidentCoverage({ macroX, macroZ });
  return Object.freeze(Object.fromEntries(INITIAL_FILL_RADII_METERS.map(radius => [
    radius,
    Object.freeze(resident.filter(cell => pointToMacroCellAabbDistance(
      cohortCenterX,
      cohortCenterZ,
      cell.macroX,
      cell.macroZ,
    ) <= radius + EPSILON).map(cell => cell.key)),
  ])));
}

function hashString(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
}

function normalizeGroundSample(value, worldX, worldZ) {
  const heightMeters = typeof value === 'number'
    ? value
    : finite(value?.heightMeters, finite(value?.height, Number.NaN));
  if (!Number.isFinite(heightMeters)) {
    throw new TypeError(`canonical Macro ground sample is invalid at ${worldX},${worldZ}`);
  }
  const color = value?.color ?? value?.colorRgb ?? value?.surfaceColor;
  return Object.freeze({
    heightMeters,
    color: Object.freeze(Array.isArray(color) && color.length === 3
      && color.every(Number.isFinite) ? [...color] : [0.28, 0.42, 0.2]),
    riverSurfaceHeightMeters: Number.isFinite(value?.riverSurfaceHeightMeters)
      ? value.riverSurfaceHeightMeters
      : Number.isFinite(value?.riverSurfaceHeight) ? value.riverSurfaceHeight : null,
    riverStableId: value?.riverStableId ?? null,
  });
}

export function createMacroCoarseCellGenerator({
  sampleGround,
} = {}) {
  if (typeof sampleGround !== 'function') {
    throw new TypeError('Macro Terrain generator requires a canonical ground sampler');
  }
  return Object.freeze({
    async generateCell({ macroX, macroZ, context = null } = {}) {
      assertMacroCoordinate(macroX, 'macroX');
      assertMacroCoordinate(macroZ, 'macroZ');
      const key = macroCellKey(macroX, macroZ);
      const bounds = macroCellBounds(macroX, macroZ);
      const lattice = [];
      for (let z = 0; z <= MACRO_OWNERS_PER_AXIS; z += 1) {
        for (let x = 0; x <= MACRO_OWNERS_PER_AXIS; x += 1) {
          lattice.push(Object.freeze({
            worldX: bounds.minimumX + x * MACRO_OWNER_SIZE_METERS,
            worldZ: bounds.minimumZ + z * MACRO_OWNER_SIZE_METERS,
          }));
        }
      }
      const groundSamples = await Promise.all(lattice.map(async point => {
        const groundValue = await sampleGround(point.worldX, point.worldZ, context);
        return Object.freeze({
          point,
          ground: normalizeGroundSample(groundValue, point.worldX, point.worldZ),
        });
      }));
      const terrainSamples = Object.freeze(groundSamples.map(value => Object.freeze({
        worldX: value.point.worldX,
        worldZ: value.point.worldZ,
        heightMeters: value.ground.heightMeters,
        color: value.ground.color,
        riverSurfaceHeightMeters: value.ground.riverSurfaceHeightMeters,
        riverStableId: value.ground.riverStableId,
      })));
      let checksum = hashString(`${key}:macro-terrain-cell-1`);
      for (const sample of terrainSamples) {
        checksum = Math.imul(checksum ^ Math.round(sample.heightMeters * 1e6), 0x01000193) >>> 0;
        for (const component of sample.color) {
          checksum = Math.imul(checksum ^ Math.round(component * 1e6), 0x01000193) >>> 0;
        }
      }
      return Object.freeze({
        schemaVersion: 'macro-coarse-terrain-cell-1',
        key,
        macroX,
        macroZ,
        bounds,
        terrainSamples,
        checksum: checksum.toString(16).padStart(8, '0'),
      });
    },
  });
}

function visibleCell(cell, playerX, playerZ, radius = MACRO_VISIBLE_RADIUS_METERS) {
  return pointToMacroCellAabbDistance(
    playerX,
    playerZ,
    cell.macroX,
    cell.macroZ,
  ) <= radius + EPSILON;
}

function freezeKeys(values) {
  return Object.freeze([...values]);
}

export function createMacroCoarseWorldController({
  generateCell,
  publishCell = () => true,
  retireCell = () => true,
  maximumNewCellsPerFrame = MACRO_MAX_NEW_CELLS_PER_FRAME,
  maximumPublicationsPerFrame = 1,
  maximumInFlight = MACRO_DEFAULT_MAX_IN_FLIGHT,
  maximumRetainedCells = MACRO_MAX_RETAINED_CELLS,
} = {}) {
  if (typeof generateCell !== 'function'
    || typeof publishCell !== 'function'
    || typeof retireCell !== 'function') {
    throw new TypeError('Macro controller requires generation/publication callbacks');
  }
  for (const [name, value] of Object.entries({
    maximumNewCellsPerFrame,
    maximumPublicationsPerFrame,
    maximumInFlight,
    maximumRetainedCells,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  let disposed = false;
  let center = null;
  let desiredCoverage = Object.freeze([]);
  let desiredByKey = new Map();
  const presented = new Map();
  const pending = new Map();
  const completionQueue = [];
  const completedKeys = new Set();
  const generatedCache = new Map();
  let requestSequence = 0;
  let frameSequence = 0;
  let coverageRevision = 0;
  let generationRequestCount = 0;
  let publicationCount = 0;
  let retirementCount = 0;
  let generationFailureCount = 0;
  let staleCompletionDiscardCount = 0;
  let stalePublicationCount = 0;
  let fullRebuildCount = 0;
  let coverageMissCount = 0;
  let residentOverflowCount = 0;
  let maximumPresentedCount = 0;
  let maximumPendingCount = 0;
  let maximumCompletionQueueLength = 0;
  let initialCenterKey = null;
  let initialPlayerX = null;
  let initialPlayerZ = null;
  let initialFillStartedFrame = null;
  const initialFillCompletedFrame = new Map();
  let initialVisibleFillComplete = false;
  let lastFrameResult = Object.freeze({
    requestedCellKeys: Object.freeze([]),
    publishedCellKeys: Object.freeze([]),
    retiredCellKeys: Object.freeze([]),
  });

  const updateCoverage = (playerX, playerZ) => {
    const nextCenter = logicalWorldToMacroCell(playerX, playerZ);
    if (center?.key === nextCenter.key) return false;
    const nextCoverage = createMacroResidentCoverage(nextCenter);
    desiredCoverage = nextCoverage;
    desiredByKey = coverageMap(nextCoverage);
    center = nextCenter;
    coverageRevision += 1;
    if (initialCenterKey === null) {
      initialCenterKey = center.key;
      initialPlayerX = playerX;
      initialPlayerZ = playerZ;
      initialFillStartedFrame = frameSequence;
    }
    return true;
  };

  const completion = (key, sequence, cell, error) => {
    if (disposed) return;
    pending.delete(key);
    completedKeys.add(key);
    completionQueue.push(Object.freeze({ key, sequence, cell, error }));
    maximumCompletionQueueLength = Math.max(maximumCompletionQueueLength, completionQueue.length);
  };

  const requestCell = (cell, context) => {
    if (pending.has(cell.key) || completedKeys.has(cell.key) || presented.has(cell.key)) {
      return false;
    }
    const cached = generatedCache.get(cell.key);
    if (cached) {
      completionQueue.push(Object.freeze({
        key: cell.key,
        sequence: ++requestSequence,
        cell: cached,
        error: null,
      }));
      completedKeys.add(cell.key);
      generatedCache.delete(cell.key);
      maximumCompletionQueueLength = Math.max(
        maximumCompletionQueueLength,
        completionQueue.length,
      );
      return true;
    }
    const sequence = ++requestSequence;
    generationRequestCount += 1;
    const work = Promise.resolve().then(() => generateCell({
      macroX: cell.macroX,
      macroZ: cell.macroZ,
      key: cell.key,
      requestSequence: sequence,
      coverageRevision,
      context,
    }));
    pending.set(cell.key, Object.freeze({ sequence, work }));
    maximumPendingCount = Math.max(maximumPendingCount, pending.size);
    work.then(
      value => completion(cell.key, sequence, value, null),
      error => completion(cell.key, sequence, null, error),
    );
    return true;
  };

  const retireLeavingCell = (playerX, playerZ) => {
    const candidates = [...presented.keys()]
      .filter(key => !desiredByKey.has(key))
      .map(key => ({ key, ...parseMacroCellKey(key) }))
      .sort((left, right) => (
        pointToMacroCellAabbDistance(playerX, playerZ, right.macroX, right.macroZ)
          - pointToMacroCellAabbDistance(playerX, playerZ, left.macroX, left.macroZ)
          || left.key.localeCompare(right.key)
      ));
    const leaving = candidates[0];
    if (!leaving) return null;
    retireCell(leaving.key, presented.get(leaving.key));
    presented.delete(leaving.key);
    retirementCount += 1;
    return leaving.key;
  };

  const publishCompletions = (playerX, playerZ) => {
    const publishedKeys = [];
    const retiredKeys = [];
    let processed = 0;
    while (completionQueue.length > 0 && processed < maximumPublicationsPerFrame) {
      const completed = completionQueue.shift();
      completedKeys.delete(completed.key);
      if (completed.error) {
        generationFailureCount += 1;
        processed += 1;
        continue;
      }
      if (!desiredByKey.has(completed.key)) {
        generatedCache.set(completed.key, completed.cell);
        while (generatedCache.size > maximumInFlight * 2) {
          generatedCache.delete(generatedCache.keys().next().value);
          staleCompletionDiscardCount += 1;
        }
        processed += 1;
        continue;
      }
      if (presented.has(completed.key)) {
        processed += 1;
        continue;
      }
      const retired = presented.size >= desiredCoverage.length
        ? retireLeavingCell(playerX, playerZ) : null;
      if (retired) retiredKeys.push(retired);
      if (presented.size >= maximumRetainedCells) {
        residentOverflowCount += 1;
        processed += 1;
        continue;
      }
      const cell = completed.cell?.key === completed.key
        ? completed.cell
        : Object.freeze({ ...completed.cell, key: completed.key });
      publishCell(cell);
      presented.set(completed.key, cell);
      publicationCount += 1;
      publishedKeys.push(completed.key);
      processed += 1;
    }
    maximumPresentedCount = Math.max(maximumPresentedCount, presented.size);
    return { publishedKeys, retiredKeys };
  };

  const priorityQueue = (playerX, playerZ, velocityX, velocityZ) => {
    const speed = Math.hypot(velocityX, velocityZ);
    const directionX = speed > EPSILON ? velocityX / speed : 0;
    const directionZ = speed > EPSILON ? velocityZ / speed : 0;
    return desiredCoverage.filter(cell => (
      !presented.has(cell.key) && !pending.has(cell.key) && !completedKeys.has(cell.key)
    ))
      .map(cell => {
        const distanceMeters = pointToMacroCellAabbDistance(
          playerX,
          playerZ,
          cell.macroX,
          cell.macroZ,
        );
        const visible = distanceMeters <= MACRO_VISIBLE_RADIUS_METERS + EPSILON;
        const ahead = directionX * (cell.bounds.centerX - playerX)
          + directionZ * (cell.bounds.centerZ - playerZ);
        const moving = speed > EPSILON;
        const nearCore = visible
          && distanceMeters <= INITIAL_FILL_RADII_METERS[0] + EPSILON;
        const forward = moving && ahead > 0;
        // The old queue completed the entire radial visible set before using
        // velocity at all.  Starting a sprint before initial fill therefore
        // left the forward edge behind old side/rear work for several seconds.
        // Keep the safety-critical 100 m core radial and deterministic, then
        // prioritize already-visible cells in the movement hemisphere.  The
        // Resident margin remains last and is only directionally prefetched.
        const priority = nearCore ? 0
          : visible && forward ? 1
            : visible ? 2
              : forward ? 3 : 4;
        return { cell, priority, ahead, distanceMeters };
      })
      .sort((left, right) => (
        left.priority - right.priority
          || left.distanceMeters - right.distanceMeters
          || (left.priority === 3 ? right.ahead - left.ahead : 0)
          || left.cell.macroZ - right.cell.macroZ
          || left.cell.macroX - right.cell.macroX
      ));
  };

  const updateInitialFill = () => {
    if (initialCenterKey === null || center?.key !== initialCenterKey) return;
    const { macroX, macroZ } = parseMacroCellKey(initialCenterKey);
    const cohorts = macroInitialFillCohorts({
      macroX,
      macroZ,
      playerX: initialPlayerX,
      playerZ: initialPlayerZ,
    });
    for (const radius of INITIAL_FILL_RADII_METERS) {
      if (initialFillCompletedFrame.has(radius)) continue;
      if (cohorts[radius].every(key => presented.has(key))) {
        initialFillCompletedFrame.set(radius, frameSequence);
      }
    }
    initialVisibleFillComplete = initialFillCompletedFrame.has(352);
  };

  const visibleMissingKeys = (playerX, playerZ) => desiredCoverage
    .filter(cell => visibleCell(cell, playerX, playerZ) && !presented.has(cell.key))
    .map(cell => cell.key);

  return Object.freeze({
    advanceFrame({
      playerX,
      playerZ,
      velocityX = 0,
      velocityZ = 0,
      context = null,
    } = {}) {
      if (disposed) return lastFrameResult;
      assertFinitePoint(playerX, playerZ);
      if (![velocityX, velocityZ].every(Number.isFinite)) {
        throw new TypeError('Macro prefetch velocity must be finite');
      }
      frameSequence += 1;
      const coverageChanged = updateCoverage(playerX, playerZ);
      const { publishedKeys, retiredKeys } = publishCompletions(playerX, playerZ);
      const requestedKeys = [];
      const queue = priorityQueue(playerX, playerZ, velocityX, velocityZ);
      const requestAllowance = Math.min(
        maximumNewCellsPerFrame,
        Math.max(0, maximumInFlight - pending.size),
      );
      for (let index = 0; index < queue.length && requestedKeys.length < requestAllowance; index += 1) {
        if (requestCell(queue[index].cell, context)) requestedKeys.push(queue[index].cell.key);
      }
      updateInitialFill();
      const missing = visibleMissingKeys(playerX, playerZ);
      if (initialVisibleFillComplete && missing.length > 0) coverageMissCount += missing.length;
      if (presented.size > maximumRetainedCells) residentOverflowCount += 1;
      lastFrameResult = Object.freeze({
        frameSequence,
        coverageChanged,
        coverageRevision,
        requestedCellKeys: freezeKeys(requestedKeys),
        publishedCellKeys: freezeKeys(publishedKeys),
        retiredCellKeys: freezeKeys(retiredKeys),
        visibleMissingCellKeys: freezeKeys(missing),
      });
      return lastFrameResult;
    },
    isReadyAt(worldX, worldZ) {
      return presented.has(logicalWorldToMacroCell(worldX, worldZ).key);
    },
    isCellReady(key) {
      return presented.has(key);
    },
    getPresentedCell(key) {
      return presented.get(key) ?? null;
    },
    presentedEntries() {
      return Object.freeze([...presented.entries()]);
    },
    snapshot() {
      const fill = Object.fromEntries(INITIAL_FILL_RADII_METERS.map(radius => {
        const completedFrame = initialFillCompletedFrame.get(radius) ?? null;
        return [radius, Object.freeze({
          completedFrame,
          elapsedFrames: completedFrame === null || initialFillStartedFrame === null
            ? null : completedFrame - initialFillStartedFrame,
          elapsedMillisecondsAt60Fps: completedFrame === null || initialFillStartedFrame === null
            ? null : q6((completedFrame - initialFillStartedFrame) * 1000 / 60),
        })];
      }));
      return Object.freeze({
        schemaVersion: 'macro-coarse-world-controller-stage-1-1',
        enabled: !disposed,
        center: center ? Object.freeze({ ...center }) : null,
        coverageRevision,
        residentRadiusMeters: MACRO_RESIDENT_RADIUS_METERS,
        visibleRadiusMeters: MACRO_VISIBLE_RADIUS_METERS,
        residentCellCount: desiredCoverage.length,
        presentedCellCount: presented.size,
        desiredReadyCellCount: [...desiredByKey.keys()].filter(key => presented.has(key)).length,
        retainedLeavingCellCount: [...presented.keys()].filter(key => !desiredByKey.has(key)).length,
        pendingCellCount: pending.size,
        completionQueueLength: completionQueue.length,
        generatedCacheSize: generatedCache.size,
        generationRequestCount,
        publicationCount,
        retirementCount,
        generationFailureCount,
        staleCompletionDiscardCount,
        stalePublicationCount,
        cameraYawRequestCount: 0,
        yawCoverageRevision: 0,
        fullRebuildCount,
        coverageMissCount,
        residentOverflowCount,
        maximumPresentedCount,
        maximumPendingCount,
        maximumCompletionQueueLength,
        maximumNewCellsPerFrame,
        maximumPublicationsPerFrame,
        maximumInFlight,
        maximumRetainedCells,
        initialFill: Object.freeze(fill),
        lastFrame: lastFrameResult,
      });
    },
    dispose() {
      disposed = true;
      pending.clear();
      completionQueue.length = 0;
      completedKeys.clear();
      generatedCache.clear();
      presented.clear();
      desiredCoverage = Object.freeze([]);
      desiredByKey = new Map();
    },
  });
}

export function resolveMacroThroughput({
  speedMetersPerSecond = MACRO_MAX_SPRINT_METERS_PER_SECOND,
  framesPerSecond = 60,
} = {}) {
  if (![speedMetersPerSecond, framesPerSecond].every(Number.isFinite)
    || speedMetersPerSecond < 0 || framesPerSecond <= 0) {
    throw new RangeError('Macro throughput inputs must be finite and non-negative');
  }
  const straightBoundaryCrossingsPerSecond = speedMetersPerSecond / MACRO_CELL_SIZE_METERS;
  const diagonalAxisBoundaryCrossingsPerSecond = straightBoundaryCrossingsPerSecond / Math.SQRT2;
  const straightEnteringCellsPerSecond = straightBoundaryCrossingsPerSecond * 15;
  const diagonalEnteringCellsPerSecond = diagonalAxisBoundaryCrossingsPerSecond * 21;
  const supplyCellsPerSecond = framesPerSecond * MACRO_MAX_NEW_CELLS_PER_FRAME;
  return Object.freeze({
    speedMetersPerSecond,
    framesPerSecond,
    straightBoundaryCrossingsPerSecond: q6(straightBoundaryCrossingsPerSecond),
    diagonalAxisBoundaryCrossingsPerSecond: q6(diagonalAxisBoundaryCrossingsPerSecond),
    straightEnteringCellsPerSecond: q6(straightEnteringCellsPerSecond),
    diagonalEnteringCellsPerSecond: q6(diagonalEnteringCellsPerSecond),
    supplyCellsPerSecond: q6(supplyCellsPerSecond),
    straightSupplyDemandMargin: straightEnteringCellsPerSecond > 0
      ? q6(supplyCellsPerSecond / straightEnteringCellsPerSecond) : null,
    diagonalSupplyDemandMargin: diagonalEnteringCellsPerSecond > 0
      ? q6(supplyCellsPerSecond / diagonalEnteringCellsPerSecond) : null,
  });
}
