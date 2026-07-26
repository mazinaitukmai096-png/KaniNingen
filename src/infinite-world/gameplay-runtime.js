import {
  LOGICAL_CHUNK_SIZE_METERS,
  createChunkKey,
  logicalWorldToOwnedChunk,
  parseChunkKey,
} from './chunk-coordinates.js';
import {
  W6_ATTACK_CONTRACT,
  W6_ENTITY_CONTRACTS,
  W6_STATIC_TARGET_CONTRACTS,
  W7_CORE_COMBAT_CONTRACT,
  W7_MANUAL_BOSS_CONTRACT,
  W7_NUCLEAR_CONTRACT,
  W8_BOSS_CONTRACT,
  W8_COMBAT_COMMAND_SCHEMA,
  W8_COMBAT_COMMAND_TYPES,
  W8_PRESENTATION_EVENT_SCHEMA,
  W8_TANK_LIFECYCLE_CONTRACT,
  canW6StageDamageTarget,
  finiteWorldFrameSpeedToMetersPerSecond,
  finiteWorldUnitsToMeters,
  getW6ScaleProfile,
} from './gameplay-contract.js';
import { createDeterministicRandom, deriveLocalSeed64 } from './legacy-core/g0/deterministic-random.js';
import { createWorldFeatureId } from './legacy-core/g0/stable-id.js';

const EPSILON_METERS = 0.05;
const BUILDING_TYPES = new Set(['house', 'tower', 'church', 'school', 'barn', 'factory']);
const TANK_COLLISION_OBSTACLE_TYPES = new Set([
  'house', 'rock', 'pebble', 'tower', 'church', 'school', 'militaryBase', 'barn', 'factory',
]);
const TANK_TERRAIN_QUERY_CACHE_CAPACITY = 128;

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function q6(value) {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function distanceSquared(a, b) {
  return (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
}

function pointSegmentDistanceSquared(point, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-12) return distanceSquared(point, start);
  const projection = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared));
  return distanceSquared(point, { x: start.x + dx * projection, z: start.z + dz * projection });
}

function normalizedAngle(value) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function turnTowardAngle(current, target, maximumDelta) {
  const difference = normalizedAngle(target - current);
  return normalizedAngle(current + Math.sign(difference) * Math.min(Math.abs(difference), maximumDelta));
}

function deterministicUnitFloat(key) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  return (hash >>> 0) / 0x1_0000_0000;
}

function ownerContains(ownerChunkKey, x, z) {
  return logicalWorldToOwnedChunk(x, z).key === ownerChunkKey;
}

export function chunksIntersectingLogicalCircle(centerX, centerZ, radiusMeters) {
  if (![centerX, centerZ, radiusMeters].every(Number.isFinite) || radiusMeters < 0) {
    throw new TypeError('finite circle center and non-negative radius are required');
  }
  const minimumChunkX = Math.floor((centerX - radiusMeters) / LOGICAL_CHUNK_SIZE_METERS);
  const maximumChunkX = Math.floor((centerX + radiusMeters) / LOGICAL_CHUNK_SIZE_METERS);
  const minimumChunkZ = Math.floor((centerZ - radiusMeters) / LOGICAL_CHUNK_SIZE_METERS);
  const maximumChunkZ = Math.floor((centerZ + radiusMeters) / LOGICAL_CHUNK_SIZE_METERS);
  const coordinates = [];
  for (let chunkZ = minimumChunkZ; chunkZ <= maximumChunkZ; chunkZ += 1) {
    for (let chunkX = minimumChunkX; chunkX <= maximumChunkX; chunkX += 1) {
      const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
      const maximumX = minimumX + LOGICAL_CHUNK_SIZE_METERS;
      const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
      const maximumZ = minimumZ + LOGICAL_CHUNK_SIZE_METERS;
      const nearestX = Math.max(minimumX, Math.min(maximumX, centerX));
      const nearestZ = Math.max(minimumZ, Math.min(maximumZ, centerZ));
      if ((nearestX - centerX) ** 2 + (nearestZ - centerZ) ** 2 <= radiusMeters ** 2) {
        coordinates.push(Object.freeze({ chunkX, chunkZ, key: createChunkKey(chunkX, chunkZ) }));
      }
    }
  }
  return Object.freeze(coordinates);
}

function clampToOwner(state) {
  const { chunkX, chunkZ } = parseChunkKey(state.ownerChunkKey);
  const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS + EPSILON_METERS;
  const maximumX = (chunkX + 1) * LOGICAL_CHUNK_SIZE_METERS - EPSILON_METERS;
  const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS + EPSILON_METERS;
  const maximumZ = (chunkZ + 1) * LOGICAL_CHUNK_SIZE_METERS - EPSILON_METERS;
  state.x = Math.max(minimumX, Math.min(maximumX, state.x));
  state.z = Math.max(minimumZ, Math.min(maximumZ, state.z));
}

async function entityStableId({ worldSeedHash, generatorMajor, featureType, parentStableId, purposeKey }) {
  return createWorldFeatureId({
    stableIdSchema: 'wf1',
    worldSeedHash,
    generatorMajor,
    featureType,
    parentStableId,
    purposeKey,
    semanticLocalKey: 'ordinal:0',
  });
}

async function humanDescriptor({ building, chunkData, worldSeedHash, generatorMajor }) {
  const result = await entityStableId({
    worldSeedHash,
    generatorMajor,
    featureType: 'human',
    parentStableId: building.stableId,
    purposeKey: 'w6-building-resident',
  });
  const seed64 = await deriveLocalSeed64({
    worldSeedHash,
    namespace: 'w6-human-spawn',
    semanticKey: result.stableId,
  });
  const random = createDeterministicRandom(seed64);
  const angle = await random.float01('angle') * Math.PI * 2;
  const distance = 0.5 + await random.float01('distance') * 0.75;
  let x = building.worldPosition.x + Math.cos(angle) * distance;
  let z = building.worldPosition.z + Math.sin(angle) * distance;
  const ownerChunkKey = createChunkKey(chunkData.chunkX, chunkData.chunkZ);
  if (!ownerContains(ownerChunkKey, x, z)) {
    x = building.worldPosition.x;
    z = building.worldPosition.z;
  }
  return Object.freeze({
    stableId: result.stableId,
    canonicalInput: result.canonicalInput,
    ownerChunkKey,
    type: 'human',
    maxHp: W6_ENTITY_CONTRACTS.human.maxHp,
    radius: W6_ENTITY_CONTRACTS.human.radius,
    scoreValue: W6_ENTITY_CONTRACTS.human.scoreValue,
    x: q6(x),
    z: q6(z),
    rotationY: q6(angle),
    aiState: 'idle',
  });
}

async function settlementEntityDescriptor({ reference, chunkData, worldSeedHash, generatorMajor }) {
  const isTank = reference.townType === 'military';
  if (!isTank) return null;
  const settlementOwner = logicalWorldToOwnedChunk(reference.center.x, reference.center.z);
  if (settlementOwner.chunkX !== chunkData.chunkX || settlementOwner.chunkZ !== chunkData.chunkZ) return null;
  const type = 'tank';
  const contract = W6_ENTITY_CONTRACTS[type];
  const result = await entityStableId({
    worldSeedHash,
    generatorMajor,
    featureType: type,
    parentStableId: reference.settlementId,
    purposeKey: `w6-${type}-encounter`,
  });
  const militaryBases = (chunkData.settlementLandmarks ?? []).filter(landmark =>
    landmark.landmarkType === 'militaryBase'
      && landmark.parentSettlementId === reference.settlementId);
  if (militaryBases.length !== 1) {
    throw new Error(
      `invalid gameplay chunk ${createChunkKey(chunkData.chunkX, chunkData.chunkZ)}: `
      + `Tank slot ${result.stableId} requires exactly one primary Military Base, got ${militaryBases.length}`
      + ` [${militaryBases.map(value => value.stableId).join(', ')}]`,
    );
  }
  const base = militaryBases[0];
  if (typeof base.stableId !== 'string' || !base.stableId
    || !Number.isFinite(base.worldPosition?.x)
    || !Number.isFinite(base.worldPosition?.y)
    || !Number.isFinite(base.worldPosition?.z)) {
    throw new Error(
      `invalid gameplay chunk ${createChunkKey(chunkData.chunkX, chunkData.chunkZ)}: `
      + `Military Base ${base.stableId ?? '<missing Stable ID>'} has no canonical transform`,
    );
  }
  const baseOwner = createChunkKey(
    base.owningChunkCoordinate?.x
      ?? logicalWorldToOwnedChunk(base.worldPosition.x, base.worldPosition.z).chunkX,
    base.owningChunkCoordinate?.z
      ?? logicalWorldToOwnedChunk(base.worldPosition.x, base.worldPosition.z).chunkZ,
  );
  if (baseOwner !== createChunkKey(chunkData.chunkX, chunkData.chunkZ)) {
    throw new Error(
      `invalid gameplay chunk ${createChunkKey(chunkData.chunkX, chunkData.chunkZ)}: `
      + `Military Base ${base.stableId} owns ${baseOwner}`,
    );
  }
  return Object.freeze({
    stableId: result.stableId,
    canonicalInput: result.canonicalInput,
    ownerChunkKey: baseOwner,
    type,
    maxHp: contract.maxHp,
    radius: contract.radius,
    scoreValue: contract.scoreValue,
    x: base.worldPosition.x,
    z: base.worldPosition.z,
    rotationY: base.rotationY ?? 0,
    aiState: 'reserve',
    spawned: false,
    baseStableId: base.stableId,
    baseX: base.worldPosition.x,
    baseY: base.worldPosition.y,
    baseZ: base.worldPosition.z,
    baseOwnerChunkKey: baseOwner,
  });
}

function distanceSquared3D(left, right) {
  return (left.x - right.x) ** 2
    + (left.y - right.y) ** 2
    + (left.z - right.z) ** 2;
}

function tankDistanceSquared3D(entity, tankY, player, playerY) {
  return (entity.x - player.x) ** 2
    + (tankY - playerY) ** 2
    + (entity.z - player.z) ** 2;
}

function rotateVectorXYZ(vector, rotationX, rotationY, rotationZ) {
  // Match Three.js' default Euler order exactly: XYZ local rotations transform
  // a column vector through fixed Z, then Y, then X axes.
  const cosZ = Math.cos(rotationZ);
  const sinZ = Math.sin(rotationZ);
  const afterZ = {
    x: vector.x * cosZ - vector.y * sinZ,
    y: vector.x * sinZ + vector.y * cosZ,
    z: vector.z,
  };
  const cosY = Math.cos(rotationY);
  const sinY = Math.sin(rotationY);
  const afterY = {
    x: afterZ.x * cosY + afterZ.z * sinY,
    y: afterZ.y,
    z: -afterZ.x * sinY + afterZ.z * cosY,
  };
  const cosX = Math.cos(rotationX);
  const sinX = Math.sin(rotationX);
  return {
    x: afterY.x,
    y: afterY.y * cosX - afterY.z * sinX,
    z: afterY.y * sinX + afterY.z * cosX,
  };
}

function staticTarget(feature, type, contract, position, radius = contract.radius) {
  return Object.freeze({
    stableId: feature.candidateId ?? feature.stableId,
    ownerChunkKey: createChunkKey(
      feature.owningChunkCoordinate?.x ?? logicalWorldToOwnedChunk(position.x, position.z).chunkX,
      feature.owningChunkCoordinate?.z ?? logicalWorldToOwnedChunk(position.x, position.z).chunkZ,
    ),
    type,
    maxHp: contract.maxHp,
    radius,
    scoreValue: contract.scoreValue,
    x: position.x,
    y: position.y ?? 0,
    z: position.z,
  });
}

export async function createW6ChunkGameplay({ chunkData, worldSeedHash, generatorMajor } = {}) {
  if (!chunkData || !Number.isSafeInteger(chunkData.chunkX) || !Number.isSafeInteger(chunkData.chunkZ)) {
    throw new TypeError('valid ChunkData is required');
  }
  const ownerChunkKey = createChunkKey(chunkData.chunkX, chunkData.chunkZ);
  const buildings = (chunkData.settlementFeatures ?? [])
    .filter(feature => feature.featureType === 'settlement-building');
  const entityDescriptors = await Promise.all(buildings.map(building => humanDescriptor({
    building, chunkData, worldSeedHash, generatorMajor,
  })));
  for (const reference of chunkData.settlementReferences ?? []) {
    const descriptor = await settlementEntityDescriptor({
      reference, chunkData, worldSeedHash, generatorMajor,
    });
    if (descriptor && !entityDescriptors.some(value => value.stableId === descriptor.stableId)) {
      entityDescriptors.push(descriptor);
    }
  }

  const staticTargets = [];
  for (const candidate of chunkData.vegetationCandidates ?? []) {
    const radius = (candidate.metadata?.candidateRadiusMeters ?? 0.625) * 40;
    staticTargets.push(staticTarget(
      candidate,
      'tree',
      W6_STATIC_TARGET_CONTRACTS.tree,
      candidate.worldPosition,
      radius,
    ));
  }
  for (const candidate of chunkData.rockCandidates ?? []) {
    const radius = (candidate.metadata?.candidateRadiusMeters ?? 0.6) * 40;
    const type = radius <= W6_STATIC_TARGET_CONTRACTS.pebble.radius ? 'pebble' : 'rock';
    staticTargets.push(staticTarget(
      candidate,
      type,
      W6_STATIC_TARGET_CONTRACTS[type],
      candidate.worldPosition,
      radius,
    ));
  }
  for (const building of buildings) {
    const contract = W6_STATIC_TARGET_CONTRACTS[building.buildingType];
    if (contract) staticTargets.push(staticTarget(
      building,
      building.buildingType,
      contract,
      building.worldPosition,
      building.radiusMeters * 40,
    ));
  }
  for (const detail of chunkData.ambientDetails ?? []) {
    staticTargets.push(staticTarget(
      detail,
      'tree',
      W6_STATIC_TARGET_CONTRACTS.tree,
      detail.worldPosition,
      detail.detailType === 'shrub' ? 18 : 10,
    ));
  }
  for (const detail of chunkData.streetDetails ?? []) {
    staticTargets.push(staticTarget(
      detail,
      'tree',
      W6_STATIC_TARGET_CONTRACTS.tree,
      detail.worldPosition,
      detail.detailType === 'streetLamp' ? 14 : 12,
    ));
  }
  for (const landmark of chunkData.settlementLandmarks ?? []) {
    const type = W6_STATIC_TARGET_CONTRACTS[landmark.landmarkType]
      ? landmark.landmarkType
      : 'house';
    const contract = W6_STATIC_TARGET_CONTRACTS[type];
    staticTargets.push(staticTarget(
      landmark,
      type,
      contract,
      landmark.worldPosition,
      contract.radius,
    ));
  }
  entityDescriptors.sort((a, b) => a.stableId.localeCompare(b.stableId));
  staticTargets.sort((a, b) => a.stableId.localeCompare(b.stableId));
  const ids = [...entityDescriptors, ...staticTargets].map(value => value.stableId);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw new Error(`Stable ID collision inside W6 gameplay chunk ${ownerChunkKey}`);
  }
  return Object.freeze({
    schemaVersion: 'w6-chunk-gameplay-1',
    chunkKey: ownerChunkKey,
    entityDescriptors: Object.freeze(entityDescriptors),
    staticTargets: Object.freeze(staticTargets),
    avoidanceSurfaces: Object.freeze([
      ...(chunkData.waterSurfaces ?? []).map(surface => Object.freeze({
        type: 'water', x: surface.worldPosition.x, z: surface.worldPosition.z,
        radius: Math.hypot(surface.widthMeters, surface.depthMeters) / 2,
      })),
      ...buildings.map(building => Object.freeze({
        type: 'building', x: building.worldPosition.x, z: building.worldPosition.z,
        radius: building.radiusMeters + 0.5,
      })),
    ]),
  });
}

export class InfiniteGameplayRuntime {
  constructor({
    worldSeedHash,
    generatorMajor,
    state,
    renderAdapter,
    featureRenderAdapter = null,
    getChunkDataForQuery = null,
    sampleTerrainHeight = null,
    clock = () => globalThis.performance?.now?.() ?? Date.now(),
  } = {}) {
    if (typeof worldSeedHash !== 'string' || !worldSeedHash) throw new TypeError('worldSeedHash is required');
    if (!Number.isSafeInteger(generatorMajor) || generatorMajor < 0) throw new TypeError('generatorMajor is required');
    if (!state || typeof state.ensureEntity !== 'function') throw new TypeError('InfiniteWorldState is required');
    for (const method of ['rebase', 'loadChunk', 'syncEntity', 'unloadChunk', 'snapshot', 'shutdown']) {
      if (typeof renderAdapter?.[method] !== 'function') throw new TypeError(`gameplay renderAdapter.${method} is required`);
    }
    if (getChunkDataForQuery !== null && typeof getChunkDataForQuery !== 'function') {
      throw new TypeError('getChunkDataForQuery must be a function when provided');
    }
    if (sampleTerrainHeight !== null && typeof sampleTerrainHeight !== 'function') {
      throw new TypeError('sampleTerrainHeight must be a function when provided');
    }
    this.worldSeedHash = worldSeedHash;
    this.generatorMajor = generatorMajor;
    this.state = state;
    this.renderAdapter = renderAdapter;
    this.featureRenderAdapter = featureRenderAdapter;
    this.getChunkDataForQuery = getChunkDataForQuery;
    this.sampleTerrainHeight = sampleTerrainHeight;
    this.clock = clock;
    this.activeChunks = new Map();
    this.spatialChunks = new Map();
    this.maximumSpatialTargetRadiusMeters = finiteWorldUnitsToMeters(
      W6_ENTITY_CONTRACTS.human.radius,
    );
    this.stableIdOwners = new Map();
    this.lastAttackAt = -Infinity;
    this.projectiles = [];
    this.combatEffects = [];
    this.presentationEvents = [];
    this.combatSequence = 0;
    this.pendingCameraShake = 0;
    this.hitStopUntil = -Infinity;
    this.playerKnockback = { x: 0, z: 0, decayPerFrame: 0.85 };
    this.pendingBossSpawn = null;
    this.pendingTankReinforcement = null;
    this.pendingTankRuntimeError = null;
    this.tankSandboxSuppressed = state.activeScaleStageId !== 'MAX';
    this.tankSpawnEpoch = 0;
    this.tankSpawnFrameAccumulator = 0;
    this.tankSpawnFrame = 0;
    this.tankBindings = new Map();
    this.activeTankOccurrences = new Map();
    this.pendingTankSpawnReservations = new Map();
    this.tankOccurrenceGenerations = new Map();
    this.reinforcementIds = new Set();
    this.tankTerrainChunks = new Map();
    this.pendingTankTerrainChunks = new Map();
    this.tankTerrainQueryErrors = new Map();
    this.isShutdown = false;
    this.counts = {
      chunksLoaded: 0,
      chunksUnloaded: 0,
      simulationTicks: 0,
      entityUpdates: 0,
      attacks: 0,
      attackCooldownRejected: 0,
      destroyedFeatures: 0,
      destroyedEntities: 0,
      revisits: 0,
      tankShots: 0,
      playerHits: 0,
      playerDeaths: 0,
      combatEffects: 0,
      restarts: 0,
      nuclearAttacks: 0,
      nuclearChunksQueried: 0,
      nuclearTargetsHit: 0,
      manualBossSpawns: 0,
    };
    this.#rebuildTankOccurrences({ sync: false });
  }

  #emitPresentationEvent({
    type, x, y = 0, z, directionX = 0, directionY = 0, directionZ = 0, intensity = 1,
    lifetimeSeconds = 0.25, soundCue = null,
  }) {
    const event = Object.freeze({
      schemaVersion: W8_PRESENTATION_EVENT_SCHEMA,
      sequence: ++this.combatSequence,
      type,
      logicalPosition: Object.freeze({ x: q6(x), y: q6(y), z: q6(z) }),
      direction: Object.freeze({ x: q6(directionX), y: q6(directionY), z: q6(directionZ) }),
      scaleStageId: this.state.activeScaleStageId,
      intensity: q6(intensity),
      lifetimeSeconds: q6(lifetimeSeconds),
      soundCue,
    });
    this.presentationEvents.push(event);
    if (this.presentationEvents.length > 256) this.presentationEvents.shift();
    return event;
  }

  #emitCombatEffect({
    type, x, y = 0, z, durationSeconds, cameraShake = 0, hitStopMs = 0,
    directionX = 0, directionY = 0, directionZ = 0, intensity = 1, soundCue = null,
  }) {
    const effect = {
      id: `combat-effect:${this.combatSequence + 1}`,
      type,
      x: q6(x),
      z: q6(z),
      remainingSeconds: durationSeconds,
    };
    this.combatEffects.push(effect);
    if (this.combatEffects.length > 256) this.combatEffects.shift();
    this.#emitPresentationEvent({
      type, x, y, z, directionX, directionY, directionZ, intensity,
      lifetimeSeconds: durationSeconds, soundCue,
    });
    this.pendingCameraShake = Math.max(this.pendingCameraShake, cameraShake);
    if (hitStopMs > 0) this.hitStopUntil = Math.max(this.hitStopUntil, this.clock() + hitStopMs);
    this.counts.combatEffects += 1;
    return effect;
  }

  #syncTransientCombat() {
    this.renderAdapter.syncTransientCombat?.(this.projectiles, this.combatEffects);
  }

  #syncBossDamageStage(boss) {
    const behavior = boss?.bossBehavior;
    if (!behavior) return;
    const ratio = boss.hp / boss.maxHp;
    const stage = ratio <= W8_BOSS_CONTRACT.hyperRageHpRatio ? 3
      : ratio <= W8_BOSS_CONTRACT.rageHpRatio ? 2 : ratio <= 0.75 ? 1 : 0;
    behavior.rage = stage >= 2;
    behavior.hyperRage = stage >= 3;
    if (stage <= behavior.breakStage) return;
    const broken = Math.min(
      behavior.segmentHp.length,
      (stage - behavior.breakStage) * 3,
    );
    for (let index = behavior.segmentHp.length - 1; index >= 0 && index >= behavior.segmentHp.length - broken; index -= 1) {
      behavior.segmentHp[index] = 0;
    }
    behavior.breakStage = stage;
    this.#emitCombatEffect({
      type: 'boss-segment-break', x: boss.x, z: boss.z, durationSeconds: 0.8,
      cameraShake: 110, intensity: 2.4, hitStopMs: 70, soundCue: 'roar',
    });
  }

  #advanceBossBehavior(boss, player, deltaSeconds) {
    const behavior = boss.bossBehavior;
    if (!behavior || deltaSeconds <= 0) return;
    this.#syncBossDamageStage(boss);
    const durations = { slither: 6, sweep: 5, charge: 3, dig: 5, breach: 3.5, recover: 5 };
    behavior.phaseClock += deltaSeconds;
    const previousPhase = behavior.phase;
    if (behavior.phaseClock >= durations[behavior.phase]) {
      behavior.phaseClock = 0;
      if (behavior.phase === 'slither') {
        const choice = boss.aiClock < durations.slither + 0.1
          ? 2 : Math.floor(boss.aiClock / durations.slither) % 3;
        behavior.phase = choice === 0 ? 'sweep' : choice === 1 ? 'dig' : 'charge';
      } else if (behavior.phase === 'sweep') behavior.phase = 'charge';
      else if (behavior.phase === 'charge') behavior.phase = 'dig';
      else if (behavior.phase === 'dig') {
        behavior.phase = 'breach';
        behavior.targetX = player.x;
        behavior.targetZ = player.z;
        behavior.verticalVelocity = 75;
        this.#emitCombatEffect({
          type: 'boss-breach-warning', x: player.x, z: player.z, durationSeconds: 1,
          cameraShake: 45, intensity: 1.5, soundCue: 'rumble',
        });
      } else if (behavior.phase === 'breach') {
        behavior.phase = 'recover';
        behavior.verticalOffset = 0;
        this.#emitCombatEffect({
          type: 'boss-landing', x: boss.x, z: boss.z, durationSeconds: 1.2,
          cameraShake: 180, intensity: 3, hitStopMs: 90, soundCue: 'roar',
        });
      } else behavior.phase = 'slither';
    }
    if (behavior.phase === 'breach') {
      const progress = behavior.phaseClock / durations.breach;
      behavior.verticalOffset = Math.max(0, Math.sin(progress * Math.PI) * 3.75);
      const dx = behavior.targetX - boss.x;
      const dz = behavior.targetZ - boss.z;
      const length = Math.hypot(dx, dz);
      if (length > 0.01) {
        boss.x += dx / length * finiteWorldFrameSpeedToMetersPerSecond(35) * deltaSeconds;
        boss.z += dz / length * finiteWorldFrameSpeedToMetersPerSecond(35) * deltaSeconds;
      }
    }
    if (behavior.hyperRage) {
      const interval = 1.25;
      const prior = Math.floor((boss.aiClock - deltaSeconds) / interval);
      const next = Math.floor(boss.aiClock / interval);
      if (next > prior) {
        let dx = player.x - boss.x;
        let dz = player.z - boss.z;
        const length = Math.hypot(dx, dz) || 1;
        behavior.acidSequence += 1;
        this.projectiles.push({
          id: `${boss.stableId}:acid:${behavior.acidSequence}`,
          ownerChunkKey: boss.ownerChunkKey,
          x: boss.x, z: boss.z, directionX: dx / length, directionZ: dz / length,
          remainingSeconds: 3, type: 'acid',
        });
        this.#emitPresentationEvent({
          type: 'acid-spit', x: boss.x, z: boss.z,
          directionX: dx / length, directionZ: dz / length,
          intensity: 1.4, lifetimeSeconds: 0.35, soundCue: 'acid',
        });
      }
    }
    boss.aiState = behavior.phase;
    if (previousPhase !== behavior.phase && ['charge', 'sweep'].includes(behavior.phase)) {
      this.#emitPresentationEvent({
        type: `boss-${behavior.phase}`, x: boss.x, z: boss.z,
        intensity: 1.6, lifetimeSeconds: 0.45, soundCue: 'roar',
      });
    }
  }

  *#spatialStaticTargets() {
    const seen = new Set();
    for (const model of this.spatialChunks.values()) {
      for (const target of model.staticTargets) {
        if (seen.has(target.stableId)) continue;
        seen.add(target.stableId);
        yield target;
      }
    }
  }

  *#spatialModelsIntersectingAabb(minimumX, minimumZ, maximumX, maximumZ) {
    const minimumOwner = logicalWorldToOwnedChunk(
      Math.min(minimumX, maximumX),
      Math.min(minimumZ, maximumZ),
    );
    const maximumOwner = logicalWorldToOwnedChunk(
      Math.max(minimumX, maximumX),
      Math.max(minimumZ, maximumZ),
    );
    for (let chunkZ = minimumOwner.chunkZ; chunkZ <= maximumOwner.chunkZ; chunkZ += 1) {
      for (let chunkX = minimumOwner.chunkX; chunkX <= maximumOwner.chunkX; chunkX += 1) {
        const model = this.spatialChunks.get(createChunkKey(chunkX, chunkZ));
        if (model) yield model;
      }
    }
  }

  #refreshSpatialBroadphaseBounds() {
    let maximumRadius = finiteWorldUnitsToMeters(W6_ENTITY_CONTRACTS.human.radius);
    for (const model of this.spatialChunks.values()) {
      for (const target of model.staticTargets) {
        maximumRadius = Math.max(maximumRadius, finiteWorldUnitsToMeters(target.radius));
      }
    }
    this.maximumSpatialTargetRadiusMeters = maximumRadius;
  }

  *#tankShellWorldCandidates(start, end) {
    const padding = this.maximumSpatialTargetRadiusMeters
      + W7_CORE_COMBAT_CONTRACT.tank.worldCollisionPaddingMeters;
    for (const model of this.#spatialModelsIntersectingAabb(
      Math.min(start.x, end.x) - padding,
      Math.min(start.z, end.z) - padding,
      Math.max(start.x, end.x) + padding,
      Math.max(start.z, end.z) + padding,
    )) {
      yield* model.staticTargets;
      for (const descriptor of model.entityDescriptors) {
        if (descriptor.type !== 'human') continue;
        yield descriptor;
      }
    }
  }

  #registerSpatialGameplayModel(key, model, { startOccurrences = true } = {}) {
    for (const target of model.staticTargets) {
      this.#registerStableId(target.stableId, target.ownerChunkKey ?? key);
      if (target.type === 'militaryBase') this.state.reconcileFeatureDamage?.(target);
    }
    for (const descriptor of model.entityDescriptors) {
      if (descriptor.type !== 'tank') continue;
      this.#registerStableId(descriptor.stableId, descriptor.ownerChunkKey);
      const entity = this.state.ensureEntity(descriptor);
      this.#bindTank(entity, descriptor);
      if (startOccurrences && entity.alive && entity.spawned === true
        && !this.activeTankOccurrences.has(entity.stableId)) {
        this.#startTankOccurrence(entity, { sync: false });
      }
    }
  }

  #rememberTankTerrainChunk(key, chunkData) {
    if (!chunkData) return null;
    const source = chunkData.sourceChunkData;
    const cachedChunkData = source?.terrain
      ? Object.freeze({
        chunkX: chunkData.chunkX,
        chunkZ: chunkData.chunkZ,
        sourceChunkData: Object.freeze({
          chunkX: source.chunkX,
          chunkZ: source.chunkZ,
          terrain: source.terrain,
        }),
      })
      : chunkData;
    this.tankTerrainQueryErrors.delete(key);
    this.tankTerrainChunks.delete(key);
    this.tankTerrainChunks.set(key, cachedChunkData);
    while (this.tankTerrainChunks.size > TANK_TERRAIN_QUERY_CACHE_CAPACITY) {
      this.tankTerrainChunks.delete(this.tankTerrainChunks.keys().next().value);
    }
    return cachedChunkData;
  }

  #rememberTankTerrainQueryError(key, error) {
    this.tankTerrainQueryErrors.delete(key);
    this.tankTerrainQueryErrors.set(key, error);
    while (this.tankTerrainQueryErrors.size > TANK_TERRAIN_QUERY_CACHE_CAPACITY) {
      this.tankTerrainQueryErrors.delete(this.tankTerrainQueryErrors.keys().next().value);
    }
  }

  #requestTankTerrainChunk(x, z) {
    if (this.sampleTerrainHeight === null || this.getChunkDataForQuery === null) {
      return Promise.resolve(null);
    }
    const owner = logicalWorldToOwnedChunk(x, z);
    const cached = this.tankTerrainChunks.get(owner.key);
    if (cached) return Promise.resolve(cached);
    const queryError = this.tankTerrainQueryErrors.get(owner.key);
    if (queryError) return Promise.reject(queryError);
    const existing = this.pendingTankTerrainChunks.get(owner.key);
    if (existing) return existing;
    if (this.pendingTankTerrainChunks.size >= TANK_TERRAIN_QUERY_CACHE_CAPACITY) {
      return Promise.resolve(null);
    }
    const requestEpoch = this.tankSpawnEpoch;
    const pending = Promise.resolve()
      .then(() => this.getChunkDataForQuery(owner.chunkX, owner.chunkZ))
      .then(chunkData => {
        if (this.isShutdown || requestEpoch !== this.tankSpawnEpoch) return null;
        const source = chunkData?.sourceChunkData ?? chunkData;
        if (!Number.isSafeInteger(chunkData?.chunkX)
          || !Number.isSafeInteger(chunkData?.chunkZ)
          || createChunkKey(chunkData.chunkX, chunkData.chunkZ) !== owner.key
          || (chunkData?.sourceChunkData
            && (!Number.isSafeInteger(source?.chunkX)
              || !Number.isSafeInteger(source?.chunkZ)
              || createChunkKey(source.chunkX, source.chunkZ) !== owner.key))) {
          const error = new Error(`Tank terrain query returned malformed or wrong ChunkData for ${owner.key}`);
          error.code = 'ERR_TANK_TERRAIN_INTEGRITY';
          throw error;
        }
        return this.#rememberTankTerrainChunk(owner.key, chunkData);
      })
      .catch(error => {
        if (error?.code !== 'ERR_TANK_TERRAIN_INTEGRITY') return null;
        this.#rememberTankTerrainQueryError(owner.key, error);
        throw error;
      })
      .finally(() => {
        if (this.pendingTankTerrainChunks.get(owner.key) === pending) {
          this.pendingTankTerrainChunks.delete(owner.key);
        }
      });
    this.pendingTankTerrainChunks.set(owner.key, pending);
    return pending;
  }

  #tryTerrainHeightAt(x, z, requestMissingTerrain = true) {
    if (this.sampleTerrainHeight === null) return 0;
    const owner = logicalWorldToOwnedChunk(x, z);
    const height = this.sampleTerrainHeight(
      x,
      z,
      this.tankTerrainChunks.get(owner.key) ?? null,
    );
    if (height === null || height === undefined) {
      const queryError = this.tankTerrainQueryErrors.get(owner.key);
      if (queryError) throw queryError;
      if (requestMissingTerrain) void this.#requestTankTerrainChunk(x, z).catch(() => {});
      return null;
    }
    if (!Number.isFinite(height)) {
      throw new Error(`canonical terrain sampler returned a non-finite height at (${x}, ${z})`);
    }
    return height;
  }

  #terrainHeightAt(x, z) {
    const height = this.#tryTerrainHeightAt(x, z);
    if (height === null) {
      const owner = logicalWorldToOwnedChunk(x, z);
      throw new Error(`canonical terrain is not prepared for Tank query Chunk ${owner.key}`);
    }
    return height;
  }

  async #ensureTankTerrainAt(x, z, rotationY = 0) {
    if (this.sampleTerrainHeight === null) return true;
    const terrainEpoch = this.tankSpawnEpoch;
    const lifecycle = W8_TANK_LIFECYCLE_CONTRACT;
    const forwardX = Math.sin(rotationY);
    const forwardZ = Math.cos(rotationY);
    const rightX = Math.cos(rotationY);
    const rightZ = -Math.sin(rotationY);
    const points = [
      { x, z },
      {
        x: x + forwardX * lifecycle.trackHalfLengthMeters,
        z: z + forwardZ * lifecycle.trackHalfLengthMeters,
      },
      {
        x: x - forwardX * lifecycle.trackHalfLengthMeters,
        z: z - forwardZ * lifecycle.trackHalfLengthMeters,
      },
      {
        x: x + rightX * lifecycle.trackHalfWidthMeters,
        z: z + rightZ * lifecycle.trackHalfWidthMeters,
      },
      {
        x: x - rightX * lifecycle.trackHalfWidthMeters,
        z: z - rightZ * lifecycle.trackHalfWidthMeters,
      },
    ];
    const missing = points.filter(point => this.#tryTerrainHeightAt(point.x, point.z) === null);
    if (missing.length === 0) return true;
    await Promise.all(missing.map(point => this.#requestTankTerrainChunk(point.x, point.z)));
    if (this.isShutdown || terrainEpoch !== this.tankSpawnEpoch) return false;
    return points.every(point => this.#tryTerrainHeightAt(point.x, point.z) !== null);
  }

  #updateTankGroundPose(entity) {
    const occurrence = this.activeTankOccurrences.get(entity.stableId);
    if (!occurrence) return null;
    const lifecycle = W8_TANK_LIFECYCLE_CONTRACT;
    const forwardX = Math.sin(entity.rotationY);
    const forwardZ = Math.cos(entity.rotationY);
    const rightX = Math.cos(entity.rotationY);
    const rightZ = -Math.sin(entity.rotationY);
    const halfLength = lifecycle.trackHalfLengthMeters;
    const halfWidth = lifecycle.trackHalfWidthMeters;
    const front = this.#tryTerrainHeightAt(
      entity.x + forwardX * halfLength,
      entity.z + forwardZ * halfLength,
    );
    const back = this.#tryTerrainHeightAt(
      entity.x - forwardX * halfLength,
      entity.z - forwardZ * halfLength,
    );
    const right = this.#tryTerrainHeightAt(
      entity.x + rightX * halfWidth,
      entity.z + rightZ * halfWidth,
    );
    const left = this.#tryTerrainHeightAt(
      entity.x - rightX * halfWidth,
      entity.z - rightZ * halfWidth,
    );
    const groundY = this.#tryTerrainHeightAt(entity.x, entity.z);
    if (front === null || back === null || right === null || left === null || groundY === null) {
      occurrence.terrainReady = false;
      return occurrence;
    }
    occurrence.terrainReady = true;
    occurrence.groundY = groundY;
    occurrence.groundPitch = -Math.atan2(front - back, halfLength * 2);
    occurrence.groundRoll = Math.atan2(right - left, halfWidth * 2);
    return occurrence;
  }

  #tankPresentationState(entity) {
    const sandboxSuppressed = this.state.activeScaleStageId !== 'MAX';
    if (sandboxSuppressed) {
      const occurrence = this.activeTankOccurrences.get(entity.stableId);
      if (!occurrence) return null;
      return {
        ...entity,
        groundY: occurrence.groundY,
        groundPitch: occurrence.groundPitch,
        groundRoll: occurrence.groundRoll,
        sandboxSuppressed: true,
      };
    }
    const occurrence = this.#updateTankGroundPose(entity);
    if (!occurrence?.terrainReady) return null;
    return {
      ...entity,
      groundY: occurrence.groundY,
      groundPitch: occurrence.groundPitch,
      groundRoll: occurrence.groundRoll,
      sandboxSuppressed: false,
    };
  }

  #tankMuzzlePosition(entity) {
    const occurrence = this.#updateTankGroundPose(entity);
    if (!occurrence?.terrainReady) {
      throw new Error(`Tank occurrence terrain is not prepared: ${entity.stableId}`);
    }
    const lifecycle = W8_TANK_LIFECYCLE_CONTRACT;
    const pitchedMuzzle = rotateVectorXYZ(
      { x: 0, y: 0, z: lifecycle.muzzleForwardFromGunMeters },
      entity.gunPitch ?? 0,
      0,
      0,
    );
    pitchedMuzzle.z += lifecycle.gunPivotForwardMeters;
    const turretLocal = rotateVectorXYZ(
      pitchedMuzzle,
      0,
      normalizedAngle((entity.turretRotationY ?? entity.rotationY) - entity.rotationY),
      0,
    );
    turretLocal.y += lifecycle.turretPivotHeightMeters;
    turretLocal.z += lifecycle.turretPivotForwardMeters;
    const worldOffset = rotateVectorXYZ(
      turretLocal,
      occurrence.groundPitch,
      entity.rotationY,
      occurrence.groundRoll,
    );
    return Object.freeze({
      x: entity.x + worldOffset.x,
      y: occurrence.groundY + worldOffset.y,
      z: entity.z + worldOffset.z,
    });
  }

  #resolveTankObstacleCollisions(entity) {
    const tankRadius = finiteWorldUnitsToMeters(W6_ENTITY_CONTRACTS.tank.radius);
    const broadphaseRadius = tankRadius + this.maximumSpatialTargetRadiusMeters;
    for (const model of this.#spatialModelsIntersectingAabb(
      entity.x - broadphaseRadius,
      entity.z - broadphaseRadius,
      entity.x + broadphaseRadius,
      entity.z + broadphaseRadius,
    )) {
      for (const obstacle of model.staticTargets) {
        if (!TANK_COLLISION_OBSTACLE_TYPES.has(obstacle.type)
          || this.state.isFeatureDestroyed(obstacle.stableId)) continue;
        const obstacleRadius = finiteWorldUnitsToMeters(obstacle.radius);
        const minimumDistance = tankRadius + obstacleRadius;
        let dx = entity.x - obstacle.x;
        let dz = entity.z - obstacle.z;
        const squared = dx * dx + dz * dz;
        if (squared >= minimumDistance ** 2) continue;
        const distance = Math.sqrt(squared) || 0.001;
        const overlap = minimumDistance - distance;
        entity.x += dx / distance * overlap;
        entity.z += dz / distance * overlap;
      }
    }
  }

  #tankHasLineOfSight(entity, tankY, player, playerY) {
    const clearance = W8_TANK_LIFECYCLE_CONTRACT.lineOfSightClearanceMeters;
    const playerDistanceSquared = tankDistanceSquared3D(entity, tankY, player, playerY);
    if (playerDistanceSquared <= 1e-12) return true;
    const segmentX = player.x - entity.x;
    const segmentY = playerY - tankY;
    const segmentZ = player.z - entity.z;
    const blocksSegment = obstacle => {
      const obstacleX = obstacle.x - entity.x;
      const obstacleY = (obstacle.y ?? 0) - tankY;
      const obstacleZ = obstacle.z - entity.z;
      const projection = (obstacleX * segmentX + obstacleY * segmentY + obstacleZ * segmentZ)
        / playerDistanceSquared;
      if (projection <= 0 || projection >= 1) return false;
      const perpendicularX = obstacleX - segmentX * projection;
      const perpendicularY = obstacleY - segmentY * projection;
      const perpendicularZ = obstacleZ - segmentZ * projection;
      const radius = finiteWorldUnitsToMeters(obstacle.radius) + clearance;
      return perpendicularX * perpendicularX + perpendicularY * perpendicularY
        + perpendicularZ * perpendicularZ < radius ** 2;
    };
    const broadphasePadding = this.maximumSpatialTargetRadiusMeters + clearance;
    for (const model of this.#spatialModelsIntersectingAabb(
      Math.min(entity.x, player.x) - broadphasePadding,
      Math.min(entity.z, player.z) - broadphasePadding,
      Math.max(entity.x, player.x) + broadphasePadding,
      Math.max(entity.z, player.z) + broadphasePadding,
    )) {
      for (const obstacle of model.staticTargets) {
        if (obstacle.type === 'pebble' || this.state.isFeatureDestroyed(obstacle.stableId)) continue;
        if (blocksSegment(obstacle)) return false;
      }
    }
    for (const occurrence of this.activeTankOccurrences.values()) {
      const obstacle = this.state.entityStates.get(occurrence.slotStableId);
      if (!obstacle || obstacle === entity || !obstacle.alive || obstacle.spawned !== true
        || !blocksSegment({
          x: obstacle.x,
          y: occurrence.groundY,
          z: obstacle.z,
          radius: W6_ENTITY_CONTRACTS.tank.radius,
        })) continue;
      return false;
    }
    return true;
  }

  #bindTank(entity, descriptor = null) {
    if (entity?.type !== 'tank') return null;
    const reinforcement = (entity.reinforcementSequence ?? 0) > 0;
    const existing = this.tankBindings.get(entity.stableId);
    const baseStableId = descriptor?.baseStableId ?? existing?.baseStableId ?? null;
    const baseX = descriptor?.baseX ?? existing?.baseX ?? entity.baseX;
    const baseY = descriptor?.baseY ?? existing?.baseY ?? 0;
    const baseZ = descriptor?.baseZ ?? existing?.baseZ ?? entity.baseZ;
    const baseOwnerChunkKey = descriptor?.baseOwnerChunkKey
      ?? existing?.baseOwnerChunkKey
      ?? entity.ownerChunkKey;
    if (!reinforcement && descriptor) {
      if (typeof baseStableId !== 'string' || !baseStableId) {
        throw new Error(`Tank slot ${entity.stableId} has no canonical Military Base binding`);
      }
      if (existing?.baseStableId && existing.baseStableId !== baseStableId) {
        throw new Error(
          `Tank slot ${entity.stableId} changed Military Base binding `
          + `${existing.baseStableId} -> ${baseStableId}`,
        );
      }
      if (baseOwnerChunkKey !== entity.ownerChunkKey) {
        throw new Error(
          `Tank slot ${entity.stableId} owner ${entity.ownerChunkKey} `
          + `does not match Military Base owner ${baseOwnerChunkKey}`,
        );
      }
    }
    const binding = Object.freeze({
      slotStableId: entity.stableId,
      kind: reinforcement ? 'fallback' : 'base',
      baseStableId,
      baseX,
      baseY,
      baseZ,
      baseOwnerChunkKey,
    });
    this.tankBindings.set(entity.stableId, binding);
    return binding;
  }

  #startTankOccurrence(entity, { sync = true, runtimeGeneration = null } = {}) {
    if (!entity?.alive || entity.spawned !== true) return null;
    const existing = this.activeTankOccurrences.get(entity.stableId);
    if (existing) {
      if (runtimeGeneration !== null && existing.runtimeGeneration !== runtimeGeneration) return null;
      existing.currentOwnerChunkKey = logicalWorldToOwnedChunk(entity.x, entity.z).key;
      if (sync) this.#syncTank(entity);
      return existing;
    }
    const binding = this.#bindTank(entity);
    const generationWatermark = this.tankOccurrenceGenerations.get(entity.stableId) ?? 0;
    const nextRuntimeGeneration = runtimeGeneration ?? generationWatermark + 1;
    if (runtimeGeneration !== null && generationWatermark !== runtimeGeneration) return null;
    this.tankOccurrenceGenerations.set(entity.stableId, nextRuntimeGeneration);
    const occurrence = {
      slotStableId: entity.stableId,
      kind: binding.kind,
      runtimeGeneration: nextRuntimeGeneration,
      currentOwnerChunkKey: logicalWorldToOwnedChunk(entity.x, entity.z).key,
      terrainReady: false,
      groundY: binding.baseY,
      groundPitch: 0,
      groundRoll: 0,
    };
    this.activeTankOccurrences.set(entity.stableId, occurrence);
    if (binding.kind === 'fallback') this.reinforcementIds.add(entity.stableId);
    if (sync) this.#syncTank(entity);
    return occurrence;
  }

  #removeTankOccurrence(entity, { destroyed = false } = {}) {
    if (!entity?.stableId) return false;
    const stableId = entity.stableId;
    const occurrence = this.activeTankOccurrences.get(stableId);
    if (destroyed) {
      entity.hp = 0;
      entity.alive = false;
    }
    entity.spawned = false;
    entity.aiState = destroyed ? 'destroyed' : 'reserve';
    this.projectiles = this.projectiles.filter(projectile => projectile.ownerStableId !== stableId);
    this.activeTankOccurrences.delete(stableId);
    this.renderAdapter.removeReinforcement?.(stableId);
    if ((entity.reinforcementSequence ?? 0) > 0) {
      this.state.removeEntity?.(stableId);
      this.reinforcementIds.delete(stableId);
      this.stableIdOwners.delete(stableId);
      this.tankBindings.delete(stableId);
      this.tankOccurrenceGenerations.delete(stableId);
    } else {
      this.renderAdapter.syncEntity(entity);
    }
    this.#syncTransientCombat();
    return occurrence !== undefined;
  }

  #rebuildTankOccurrences({ sync = true } = {}) {
    for (const stableId of this.reinforcementIds) {
      this.stableIdOwners.delete(stableId);
      this.tankBindings.delete(stableId);
    }
    for (const stableId of [...this.tankBindings.keys()]) {
      if (!this.state.entityStates.has(stableId)) this.tankBindings.delete(stableId);
    }
    this.activeTankOccurrences.clear();
    this.reinforcementIds.clear();
    if (sync) this.renderAdapter.clearReinforcements?.();
    for (const entity of this.state.entityStates.values()) {
      if (entity.type !== 'tank') continue;
      this.#bindTank(entity);
      this.#registerStableId(entity.stableId, entity.ownerChunkKey);
      if ((entity.reinforcementSequence ?? 0) > 0) this.reinforcementIds.add(entity.stableId);
      if (entity.alive && entity.spawned === true) this.#startTankOccurrence(entity, { sync });
      else if (sync) this.#syncTank(entity);
    }
  }

  async #prepareActiveTankTerrainForPresentation() {
    const readyStableIds = new Set();
    const despawnDistance = finiteWorldUnitsToMeters(W6_ENTITY_CONTRACTS.tank.despawnDistance);
    for (const occurrence of [...this.activeTankOccurrences.values()]) {
      const entity = this.state.entityStates.get(occurrence.slotStableId);
      if (!entity?.alive || entity.spawned !== true) {
        if (entity) this.#removeTankOccurrence(entity, { destroyed: entity.alive === false });
        continue;
      }
      if (this.state.activeScaleStageId !== 'MAX') {
        readyStableIds.add(entity.stableId);
        continue;
      }
      const playerY = this.#terrainHeightAt(this.state.player.x, this.state.player.z);
      if (tankDistanceSquared3D(entity, occurrence.groundY, this.state.player, playerY)
        > despawnDistance ** 2) {
        this.#removeTankOccurrence(entity);
        continue;
      }
      if (await this.#ensureTankTerrainAt(entity.x, entity.z, entity.rotationY)) {
        const prepared = this.#updateTankGroundPose(entity);
        if (prepared?.terrainReady
          && tankDistanceSquared3D(entity, prepared.groundY, this.state.player, playerY)
            <= despawnDistance ** 2) {
          readyStableIds.add(entity.stableId);
        } else if (prepared?.terrainReady) {
          this.#removeTankOccurrence(entity);
        }
      }
    }
    return readyStableIds;
  }

  #syncTank(entity) {
    if (!entity?.stableId) return false;
    if (entity.alive && entity.spawned === true
      && this.activeTankOccurrences.has(entity.stableId)) {
      const presentationState = this.#tankPresentationState(entity);
      if (!presentationState) return false;
      const binding = this.tankBindings.get(entity.stableId) ?? this.#bindTank(entity);
      const usesOccurrenceRenderer = binding.kind === 'fallback'
        || !this.activeChunks.has(binding.baseOwnerChunkKey);
      if (usesOccurrenceRenderer) {
        return this.renderAdapter.syncReinforcement?.(presentationState) ?? false;
      }
      this.renderAdapter.removeReinforcement?.(entity.stableId);
      return this.renderAdapter.syncEntity(presentationState);
    }
    this.renderAdapter.removeReinforcement?.(entity.stableId);
    if ((entity.reinforcementSequence ?? 0) === 0) return this.renderAdapter.syncEntity(entity);
    return false;
  }

  #syncTankSandboxState() {
    const sandboxSuppressed = this.state.activeScaleStageId !== 'MAX';
    const changed = sandboxSuppressed !== this.tankSandboxSuppressed;
    this.tankSandboxSuppressed = sandboxSuppressed;
    if (changed) {
      this.tankSpawnEpoch += 1;
      this.tankSpawnFrameAccumulator = 0;
      this.pendingTankReinforcement = null;
      this.#cancelAllPendingTankSpawns();
      this.pendingTankTerrainChunks.clear();
    }
    if (sandboxSuppressed
      && this.projectiles.some(projectile => projectile.type === 'tank-shell')) {
      this.projectiles = this.projectiles.filter(projectile => projectile.type !== 'tank-shell');
    }
    if (changed) {
      for (const occurrence of this.activeTankOccurrences.values()) {
        this.#syncTank(this.state.entityStates.get(occurrence.slotStableId));
      }
    }
    return sandboxSuppressed;
  }

  #updateTank(entity, player, deltaSeconds) {
    if (!entity?.alive || entity.spawned !== true) {
      if (entity) this.#removeTankOccurrence(entity, { destroyed: entity.alive === false });
      return;
    }
    if (this.state.activeScaleStageId !== 'MAX') return;
    const contract = W6_ENTITY_CONTRACTS.tank;
    const lifecycle = W8_TANK_LIFECYCLE_CONTRACT;
    const occurrenceBeforeUpdate = this.activeTankOccurrences.get(entity.stableId);
    const playerY = Number.isFinite(player.y)
      ? player.y
      : this.#terrainHeightAt(player.x, player.z);
    const despawnDistance = finiteWorldUnitsToMeters(contract.despawnDistance);
    if (tankDistanceSquared3D(
      entity,
      occurrenceBeforeUpdate?.groundY ?? 0,
      player,
      playerY,
    ) > despawnDistance ** 2) {
      this.#removeTankOccurrence(entity);
      return;
    }
    let preparedGround = this.#updateTankGroundPose(entity);
    if (!preparedGround?.terrainReady) {
      this.counts.entityUpdates += 1;
      return;
    }
    if (tankDistanceSquared3D(entity, preparedGround.groundY, player, playerY)
      <= lifecycle.collisionActiveRangeMeters ** 2) {
      const beforeCollisionX = entity.x;
      const beforeCollisionZ = entity.z;
      this.#resolveTankObstacleCollisions(entity);
      preparedGround = this.#updateTankGroundPose(entity);
      if (!preparedGround?.terrainReady) {
        entity.x = beforeCollisionX;
        entity.z = beforeCollisionZ;
        this.#updateTankGroundPose(entity);
        this.counts.entityUpdates += 1;
        return;
      }
    }
    entity.aiClock += deltaSeconds;
    const distance = Math.sqrt(tankDistanceSquared3D(
      entity,
      preparedGround.groundY,
      player,
      playerY,
    ));
    if (distance > despawnDistance) {
      this.#removeTankOccurrence(entity);
      return;
    }
    if (distance >= finiteWorldUnitsToMeters(contract.engageRange)) {
      entity.aiState = 'search';
      this.#syncTank(entity);
      return;
    }

    entity.stuckCheckClock = Math.max(0, (entity.stuckCheckClock ?? 0) - deltaSeconds);
    if (entity.stuckCheckClock <= 0) {
      const movedSquared = (entity.x - (entity.lastX ?? entity.x)) ** 2
        + (entity.z - (entity.lastZ ?? entity.z)) ** 2;
      if (movedSquared < lifecycle.stuckDistanceThresholdMetersSquared) {
        entity.stuckRemainingSeconds = lifecycle.stuckAvoidSeconds;
        const recoveryOrdinal = Math.floor(entity.aiClock / lifecycle.stuckCheckSeconds);
        const side = deterministicUnitFloat(
          `${this.worldSeedHash}:${entity.stableId}:${recoveryOrdinal}:avoid`,
        ) >= 0.5 ? 1 : -1;
        entity.avoidAngle = normalizedAngle(entity.rotationY + side * Math.PI / 2);
      }
      entity.lastX = entity.x;
      entity.lastZ = entity.z;
      entity.stuckCheckClock = lifecycle.stuckCheckSeconds;
    }
    const stuck = (entity.stuckRemainingSeconds ?? 0) > 0;
    if (stuck) {
      entity.stuckRemainingSeconds = Math.max(0, entity.stuckRemainingSeconds - deltaSeconds);
    }
    const hasLineOfSight = this.#tankHasLineOfSight(
      entity,
      preparedGround.groundY,
      player,
      playerY,
    );
    const targetHeading = Math.atan2(player.x - entity.x, player.z - entity.z);
    const bodyTarget = stuck ? entity.avoidAngle
      : hasLineOfSight ? targetHeading : normalizedAngle(targetHeading + Math.PI / 3);
    const frameScale = deltaSeconds * 60;
    const turretRelativeYaw = normalizedAngle(
      (entity.turretRotationY ?? entity.rotationY) - entity.rotationY,
    );
    entity.rotationY = turnTowardAngle(
      entity.rotationY,
      bodyTarget,
      lifecycle.bodyTurnRadiansPerFrame * frameScale,
    );
    const shouldMove = distance > finiteWorldUnitsToMeters(contract.approachDistance)
      || !hasLineOfSight || stuck;
    const priorX = entity.x;
    const priorZ = entity.z;
    if (shouldMove) {
      entity.aiState = stuck ? 'avoid' : hasLineOfSight ? 'engage' : 'flank';
      const speed = finiteWorldFrameSpeedToMetersPerSecond(contract.moveSpeed);
      entity.x += Math.sin(entity.rotationY) * speed * deltaSeconds;
      entity.z += Math.cos(entity.rotationY) * speed * deltaSeconds;
    } else entity.aiState = 'hold';
    let occurrence = this.#updateTankGroundPose(entity);
    if (!occurrence?.terrainReady) {
      entity.x = priorX;
      entity.z = priorZ;
      occurrence = this.#updateTankGroundPose(entity);
      if (occurrence?.terrainReady) this.#syncTank(entity);
      this.counts.entityUpdates += 1;
      return;
    }
    const currentOwner = logicalWorldToOwnedChunk(entity.x, entity.z).key;
    const activeOccurrence = this.activeTankOccurrences.get(entity.stableId);
    if (activeOccurrence) activeOccurrence.currentOwnerChunkKey = currentOwner;
    if ((entity.reinforcementSequence ?? 0) > 0 && currentOwner !== entity.ownerChunkKey) {
      this.state.moveEntityOwner(entity.stableId, currentOwner);
      this.stableIdOwners.set(entity.stableId, currentOwner);
    }

    const postMoveTargetHeading = Math.atan2(player.x - entity.x, player.z - entity.z);
    const postMoveDistance = Math.sqrt(distanceSquared(entity, player));
    const turnedTurretRelativeYaw = turnTowardAngle(
      turretRelativeYaw,
      normalizedAngle(postMoveTargetHeading - entity.rotationY),
      lifecycle.turretTurnRadiansPerFrame * frameScale,
    );
    entity.turretRotationY = normalizedAngle(entity.rotationY + turnedTurretRelativeYaw);
    const horizontalDistance = Math.max(0.025, postMoveDistance);
    const playerAimY = playerY + lifecycle.playerAimHeightMeters;
    const gunPivotY = occurrence.groundY + lifecycle.turretPivotHeightMeters;
    const targetGunPitch = -Math.atan2(playerAimY - gunPivotY, horizontalDistance);
    entity.gunPitch = turnTowardAngle(
      entity.gunPitch ?? 0,
      targetGunPitch,
      lifecycle.gunPitchRadiansPerFrame * frameScale,
    );

    const combat = W7_CORE_COMBAT_CONTRACT.tank;
    const fireIntervalMs = Math.max(
      combat.fireIntervalMinimumMs,
      combat.fireIntervalBaseMs - this.state.player.score * combat.fireIntervalScoreDivisor,
    );
    if (hasLineOfSight && !stuck
      && this.state.gameplayTimeMs - entity.lastShotAtMs > fireIntervalMs) {
      const muzzle = this.#tankMuzzlePosition(entity);
      const dx = player.x - muzzle.x;
      const dy = playerAimY - muzzle.y;
      const dz = player.z - muzzle.z;
      const length = Math.hypot(dx, dy, dz) || 1;
      const firingOccurrence = this.activeTankOccurrences.get(entity.stableId);
      entity.fireSequence = (entity.fireSequence ?? 0) + 1;
      entity.lastShotAtMs = this.state.gameplayTimeMs;
      this.projectiles.push({
        id: `${entity.stableId}:shot:${entity.fireSequence}`,
        ownerStableId: entity.stableId,
        ownerChunkKey: entity.ownerChunkKey,
        ownerRuntimeGeneration: firingOccurrence.runtimeGeneration,
        x: muzzle.x,
        y: muzzle.y,
        z: muzzle.z,
        directionX: dx / length,
        directionY: dy / length,
        directionZ: dz / length,
        remainingSeconds: combat.bulletLifeFrames / 60, type: 'tank-shell',
      });
      this.#emitPresentationEvent({
        type: 'tank-fire', x: muzzle.x, y: muzzle.y, z: muzzle.z,
        directionX: dx / length, directionY: dy / length, directionZ: dz / length,
        intensity: 1.2, lifetimeSeconds: 0.2, soundCue: 'tank-fire',
      });
      this.counts.tankShots += 1;
    }
    this.#syncTank(entity);
    this.counts.entityUpdates += 1;
  }

  #allowedTankCount() {
    const lifecycle = W8_TANK_LIFECYCLE_CONTRACT;
    const activeBoss = this.state.manualBossStableId
      ? this.state.entityStates.get(this.state.manualBossStableId)?.alive === true : false;
    return activeBoss ? lifecycle.bossTankLimit : Math.min(
      lifecycle.tankLimitMaximum,
      lifecycle.normalTankBaseLimit
        + Math.floor(this.state.player.score / lifecycle.tankLimitScoreDivisor),
    );
  }

  #reserveTankSpawn({
    reservationKey,
    slotStableId = null,
    kind,
    baseStableId = null,
    spawnFrame,
    sequence = 0,
  }) {
    if (this.isShutdown || this.state.activeScaleStageId !== 'MAX') return null;
    if (this.activeTankOccurrences.size + this.pendingTankSpawnReservations.size
      >= this.#allowedTankCount()) return null;
    if (this.pendingTankSpawnReservations.has(reservationKey)
      || (slotStableId && (this.activeTankOccurrences.has(slotStableId)
        || this.pendingTankSpawnReservations.has(slotStableId)))) return null;
    let runtimeGeneration = null;
    if (slotStableId) {
      runtimeGeneration = (this.tankOccurrenceGenerations.get(slotStableId) ?? 0) + 1;
      this.tankOccurrenceGenerations.set(slotStableId, runtimeGeneration);
    }
    const reservation = {
      reservationKey,
      slotStableId,
      kind,
      baseStableId,
      spawnFrame,
      sequence,
      spawnEpoch: this.tankSpawnEpoch,
      runtimeGeneration,
      committed: false,
      promise: null,
    };
    this.pendingTankSpawnReservations.set(reservationKey, reservation);
    return reservation;
  }

  #assignTankReservationStableId(reservation, slotStableId) {
    if (!reservation || typeof slotStableId !== 'string' || !slotStableId
      || this.pendingTankSpawnReservations.get(reservation.reservationKey) !== reservation
      || this.activeTankOccurrences.has(slotStableId)
      || this.pendingTankSpawnReservations.has(slotStableId)) return false;
    this.pendingTankSpawnReservations.delete(reservation.reservationKey);
    reservation.reservationKey = slotStableId;
    reservation.slotStableId = slotStableId;
    reservation.runtimeGeneration = (this.tankOccurrenceGenerations.get(slotStableId) ?? 0) + 1;
    this.tankOccurrenceGenerations.set(slotStableId, reservation.runtimeGeneration);
    this.pendingTankSpawnReservations.set(slotStableId, reservation);
    return true;
  }

  #releaseTankSpawnReservation(reservation, { preserveGeneration = false } = {}) {
    if (reservation
      && this.pendingTankSpawnReservations.get(reservation.reservationKey) === reservation) {
      this.pendingTankSpawnReservations.delete(reservation.reservationKey);
      if (!preserveGeneration && !reservation.committed && reservation.kind === 'fallback'
        && reservation.slotStableId
        && !this.activeTankOccurrences.has(reservation.slotStableId)
        && !this.state.entityStates.has(reservation.slotStableId)
        && this.tankOccurrenceGenerations.get(reservation.slotStableId)
          === reservation.runtimeGeneration) {
        this.tankOccurrenceGenerations.delete(reservation.slotStableId);
      }
      return true;
    }
    return false;
  }

  #cancelAllPendingTankSpawns() {
    for (const reservation of [...this.pendingTankSpawnReservations.values()]) {
      this.#releaseTankSpawnReservation(reservation);
    }
  }

  #canCommitTankSpawnReservation(reservation) {
    if (!reservation || reservation.committed || this.isShutdown
      || reservation.spawnEpoch !== this.tankSpawnEpoch
      || this.state.activeScaleStageId !== 'MAX'
      || !reservation.slotStableId
      || this.pendingTankSpawnReservations.get(reservation.reservationKey) !== reservation
      || this.activeTankOccurrences.has(reservation.slotStableId)
      || this.tankOccurrenceGenerations.get(reservation.slotStableId)
        !== reservation.runtimeGeneration
      || this.activeTankOccurrences.size >= this.#allowedTankCount()) return false;
    if (reservation.kind === 'base'
      && (!reservation.baseStableId
        || this.state.isFeatureDestroyed(reservation.baseStableId))) return false;
    return true;
  }

  #commitBaseTankSpawn(entity, reservation, spawnState) {
    if (!this.#canCommitTankSpawnReservation(reservation)) return null;
    this.#releaseTankSpawnReservation(reservation, { preserveGeneration: true });
    Object.assign(entity, spawnState, {
      turretRotationY: spawnState.rotationY,
      gunPitch: 0,
      hp: entity.maxHp,
      alive: true,
      spawned: true,
      aiState: 'acquire',
      aiClock: 0,
      fireSequence: 0,
      lastShotAtMs: 0,
      stuckCheckClock: 0,
      stuckRemainingSeconds: 0,
      avoidAngle: spawnState.rotationY,
      lastX: spawnState.x,
      lastZ: spawnState.z,
    });
    this.projectiles = this.projectiles.filter(
      projectile => projectile.ownerStableId !== entity.stableId,
    );
    const occurrence = this.#startTankOccurrence(entity, {
      runtimeGeneration: reservation.runtimeGeneration,
    });
    if (!occurrence) throw new Error(`Tank spawn reservation commit failed: ${entity.stableId}`);
    reservation.committed = true;
    return occurrence;
  }

  #activateBaseTank(entity, spawnFrame) {
    const binding = this.tankBindings.get(entity.stableId) ?? this.#bindTank(entity);
    if (!binding?.baseStableId || this.state.isFeatureDestroyed(binding.baseStableId)) return null;
    const reservation = this.#reserveTankSpawn({
      reservationKey: entity.stableId,
      slotStableId: entity.stableId,
      kind: 'base',
      baseStableId: binding.baseStableId,
      spawnFrame,
    });
    if (!reservation) return null;
    const scatter = W8_TANK_LIFECYCLE_CONTRACT.baseSpawnScatterMeters;
    const key = `${this.worldSeedHash}:${entity.stableId}:${spawnFrame}`;
    const spawnState = {
      x: binding.baseX + (deterministicUnitFloat(`${key}:x`) - 0.5) * scatter,
      z: binding.baseZ + (deterministicUnitFloat(`${key}:z`) - 0.5) * scatter,
      rotationY: deterministicUnitFloat(`${key}:heading`) * Math.PI * 2,
    };
    const pending = (async () => {
      const terrainReady = await this.#ensureTankTerrainAt(
        spawnState.x,
        spawnState.z,
        spawnState.rotationY,
      );
      if (!terrainReady) return null;
      return this.#commitBaseTankSpawn(entity, reservation, spawnState);
    })();
    reservation.promise = pending;
    void pending.then(
      () => this.#releaseTankSpawnReservation(reservation),
      error => {
        this.#releaseTankSpawnReservation(reservation);
        if (!this.isShutdown && reservation.spawnEpoch === this.tankSpawnEpoch) {
          this.pendingTankRuntimeError ??= error;
        }
      },
    );
    return reservation;
  }

  #spawnFallbackTank(player, spawnFrame) {
    if (this.pendingTankReinforcement || typeof this.renderAdapter.syncReinforcement !== 'function') return;
    const sequence = this.state.nextTankReinforcementSequence();
    const reservation = this.#reserveTankSpawn({
      reservationKey: `fallback:${sequence}`,
      kind: 'fallback',
      spawnFrame,
      sequence,
    });
    if (!reservation) return;
    const spawnEpoch = reservation.spawnEpoch;
    const pending = (async () => {
      const result = await entityStableId({
        worldSeedHash: this.worldSeedHash,
        generatorMajor: this.generatorMajor,
        featureType: 'tank',
        parentStableId: `infinite-world:${this.worldSeedHash}`,
        purposeKey: `w8-tank-reinforcement:${sequence}`,
      });
      if (this.isShutdown || spawnEpoch !== this.tankSpawnEpoch
        || !this.#assignTankReservationStableId(reservation, result.stableId)) return null;
      const key = `${this.worldSeedHash}:fallback:${spawnFrame}:${sequence}`;
      const angle = deterministicUnitFloat(`${key}:angle`) * Math.PI * 2;
      const lifecycle = W8_TANK_LIFECYCLE_CONTRACT;
      const distance = lifecycle.fallbackMinimumDistanceMeters
        + deterministicUnitFloat(`${key}:distance`)
          * (lifecycle.fallbackMaximumDistanceMeters - lifecycle.fallbackMinimumDistanceMeters);
      const x = player.x + Math.sin(angle) * distance;
      const z = player.z + Math.cos(angle) * distance;
      const rotationY = deterministicUnitFloat(`${key}:heading`) * Math.PI * 2;
      const terrainReady = await this.#ensureTankTerrainAt(x, z, rotationY);
      if (!terrainReady || !this.#canCommitTankSpawnReservation(reservation)) return null;
      this.#releaseTankSpawnReservation(reservation, { preserveGeneration: true });
      const ownerChunkKey = logicalWorldToOwnedChunk(x, z).key;
      this.#registerStableId(result.stableId, ownerChunkKey);
      const tank = this.state.ensureEntity({
        stableId: result.stableId, ownerChunkKey, type: 'tank',
        maxHp: W6_ENTITY_CONTRACTS.tank.maxHp,
        x, z, rotationY, aiState: 'acquire',
        reinforcementSequence: sequence, spawned: true,
        lastShotAtMs: 0,
      });
      this.#bindTank(tank);
      const occurrence = this.#startTankOccurrence(tank, {
        runtimeGeneration: reservation.runtimeGeneration,
      });
      if (!occurrence) throw new Error(`Tank spawn reservation commit failed: ${tank.stableId}`);
      reservation.committed = true;
      return occurrence;
    })();
    reservation.promise = pending;
    this.pendingTankReinforcement = pending;
    void pending.then(
      () => {
        this.#releaseTankSpawnReservation(reservation);
        if (this.pendingTankReinforcement === pending) this.pendingTankReinforcement = null;
      },
      error => {
        this.#releaseTankSpawnReservation(reservation);
        if (this.pendingTankReinforcement === pending) this.pendingTankReinforcement = null;
        if (!this.isShutdown && spawnEpoch === this.tankSpawnEpoch) {
          this.pendingTankRuntimeError ??= error;
        }
      },
    );
  }

  #maintainFiniteTankSpawns(player, deltaSeconds) {
    const lifecycle = W8_TANK_LIFECYCLE_CONTRACT;
    if (this.isShutdown || this.state.activeScaleStageId !== 'MAX' || deltaSeconds <= 0) return;
    const frameScale = deltaSeconds * 60;
    const allowed = this.#allowedTankCount();
    const reserved = this.activeTankOccurrences.size + this.pendingTankSpawnReservations.size;
    if (reserved >= allowed) {
      this.tankSpawnFrameAccumulator = 0;
      return;
    }
    this.tankSpawnFrameAccumulator += frameScale;
    if (this.tankSpawnFrameAccumulator < 1) return;
    const evaluationFrameScale = this.tankSpawnFrameAccumulator;
    this.tankSpawnFrameAccumulator %= 1;
    this.tankSpawnFrame += 1;
    const chancePerFrame = lifecycle.spawnChanceBasePerFrame + Math.min(
      lifecycle.spawnChanceMaximumBonusPerFrame,
      this.state.player.score * lifecycle.spawnChanceScoreFactor,
    );
    const adjustedChance = 1 - Math.pow(1 - chancePerFrame, evaluationFrameScale);
    if (deterministicUnitFloat(`${this.worldSeedHash}:tank-spawn:${this.tankSpawnFrame}`)
      >= adjustedChance) return;
    const loadedBaseBindings = [];
    const playerY = Number.isFinite(player.y)
      ? player.y
      : this.#terrainHeightAt(player.x, player.z);
    for (const model of this.spatialChunks.values()) {
      for (const descriptor of model.entityDescriptors) {
        if (descriptor.type !== 'tank') continue;
        const binding = this.tankBindings.get(descriptor.stableId);
        if (binding?.kind === 'base') loadedBaseBindings.push(binding);
      }
    }
    const nearbyBaseBindings = loadedBaseBindings
      .filter(binding => binding.baseStableId
        && !this.state.isFeatureDestroyed(binding.baseStableId)
        && (binding.baseX - player.x) ** 2
          + (binding.baseY - playerY) ** 2
          + (binding.baseZ - player.z) ** 2 < lifecycle.baseSpawnRangeMeters ** 2);
    const availableBaseTanks = nearbyBaseBindings
      .filter(binding => !this.pendingTankSpawnReservations.has(binding.slotStableId))
      .map(binding => this.state.entityStates.get(binding.slotStableId))
      .filter(entity => entity && entity.spawned !== true)
      .sort((a, b) => a.stableId.localeCompare(b.stableId));
    if (nearbyBaseBindings.length > 0) {
      if (availableBaseTanks.length === 0) return;
      const selection = Math.floor(
        deterministicUnitFloat(`${this.worldSeedHash}:tank-base:${this.tankSpawnFrame}`)
          * availableBaseTanks.length,
      );
      this.#activateBaseTank(
        availableBaseTanks[Math.min(selection, availableBaseTanks.length - 1)],
        this.tankSpawnFrame,
      );
    } else if (this.state.player.score > lifecycle.fallbackMinimumScore) {
      this.#spawnFallbackTank(player, this.tankSpawnFrame);
    }
  }

  #registerStableId(stableId, ownerChunkKey) {
    const existingOwner = this.stableIdOwners.get(stableId);
    if (existingOwner && existingOwner !== ownerChunkKey) {
      throw new Error(`Stable ID collision across ${existingOwner} and ${ownerChunkKey}: ${stableId}`);
    }
    this.stableIdOwners.set(stableId, ownerChunkKey);
  }

  #collectCombatTargets() {
    const targets = new Map();
    for (const target of this.#spatialStaticTargets()) {
      targets.set(target.stableId, {
        kind: 'feature',
        stableId: target.stableId,
        type: target.type,
        target,
      });
    }
    for (const model of this.spatialChunks.values()) {
      for (const descriptor of model.entityDescriptors) {
        if (descriptor.type !== 'human') continue;
        this.#registerStableId(descriptor.stableId, descriptor.ownerChunkKey);
        const entity = this.state.ensureEntity(descriptor);
        if (!entity.alive) continue;
        targets.set(entity.stableId, {
          kind: 'entity',
          stableId: entity.stableId,
          type: entity.type,
          entity,
          descriptor,
        });
      }
    }
    for (const model of this.activeChunks.values()) {
      for (const descriptor of model.entityDescriptors) {
        if (descriptor.type === 'human') continue;
        const entity = this.state.entityStates.get(descriptor.stableId);
        if (!entity?.alive || (entity.type === 'tank' && entity.spawned !== true)) continue;
        targets.set(entity.stableId, {
          kind: entity.type === 'boss' ? 'boss' : 'entity',
          stableId: entity.stableId,
          type: entity.type,
          entity,
          descriptor,
        });
      }
    }
    for (const occurrence of this.activeTankOccurrences.values()) {
      const entity = this.state.entityStates.get(occurrence.slotStableId);
      if (!entity?.alive || entity.spawned !== true) continue;
      targets.set(entity.stableId, {
        kind: 'entity',
        stableId: entity.stableId,
        type: 'tank',
        entity,
        occurrence,
      });
    }
    const manualBoss = this.state.manualBossStableId
      ? this.state.entityStates.get(this.state.manualBossStableId)
      : null;
    if (manualBoss?.alive) {
      targets.set(manualBoss.stableId, {
        kind: 'boss',
        stableId: manualBoss.stableId,
        type: 'boss',
        entity: manualBoss,
      });
    }
    return targets;
  }

  resolveCombatTarget(stableId) {
    if (typeof stableId !== 'string' || !stableId) {
      throw new TypeError('combat target Stable ID is required');
    }
    const resolved = this.#collectCombatTargets().get(stableId);
    return resolved ? Object.freeze({ ...resolved }) : null;
  }

  applyCombatDamage(targetOrStableId, amount, {
    awardPlayerCredit = false,
    cameraShake = 0,
  } = {}) {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new TypeError('combat damage must be finite and non-negative');
    }
    const resolved = typeof targetOrStableId === 'string'
      ? this.resolveCombatTarget(targetOrStableId)
      : targetOrStableId;
    if (!resolved?.stableId || !['feature', 'entity', 'boss'].includes(resolved.kind)) {
      throw new Error(`Stable ID is not active: ${
        typeof targetOrStableId === 'string' ? targetOrStableId : targetOrStableId?.stableId
      }`);
    }
    if (resolved.kind === 'feature') {
      const target = resolved.target;
      if (!target) throw new Error(`Stable ID is not active: ${resolved.stableId}`);
      this.#registerStableId(target.stableId, target.ownerChunkKey);
      if (this.state.isFeatureDestroyed(target.stableId)) {
        return Object.freeze({
          stableId: resolved.stableId,
          type: resolved.type,
          kind: 'feature',
          destroyed: true,
          justDestroyed: false,
          hp: 0,
        });
      }
      if (target.type === 'militaryBase') this.state.reconcileFeatureDamage?.(target);
      const beforeDestroyed = this.state.isFeatureDestroyed(target.stableId);
      const result = this.state.damageFeature(target, amount);
      const justDestroyed = !beforeDestroyed && result.destroyed;
      if (justDestroyed) {
        this.counts.destroyedFeatures += 1;
        if (awardPlayerCredit) {
          this.state.player.score += target.scoreValue;
          this.state.healPlayer(W7_CORE_COMBAT_CONTRACT.healing[target.type] ?? 0);
        }
        if (target.type === 'militaryBase') {
          for (const reservation of [...this.pendingTankSpawnReservations.values()]) {
            if (reservation.baseStableId === target.stableId) {
              this.#releaseTankSpawnReservation(reservation);
            }
          }
        }
        this.featureRenderAdapter?.setFeatureDestroyed?.(target.stableId, true);
      }
      return Object.freeze({
        ...result,
        stableId: target.stableId,
        type: target.type,
        kind: 'feature',
        hp: Math.max(0, target.maxHp - result.damage),
        justDestroyed,
      });
    }

    const entity = resolved.entity ?? this.state.entityStates.get(resolved.stableId);
    if (!entity?.alive || (entity.type === 'tank' && entity.spawned !== true)) {
      return Object.freeze({
        stableId: resolved.stableId,
        type: resolved.type,
        kind: resolved.kind,
        alive: false,
        destroyed: true,
        justDestroyed: false,
        hp: 0,
      });
    }
    const beforeAlive = entity.alive;
    const result = this.state.damageEntity(entity.stableId, amount);
    const justDestroyed = beforeAlive && !result.alive;
    if (entity.type === 'tank') {
      if (justDestroyed) {
        const destroyedX = entity.x;
        const destroyedZ = entity.z;
        const destroyedY = this.activeTankOccurrences.get(entity.stableId)?.groundY
          ?? this.#terrainHeightAt(entity.x, entity.z);
        const finalized = this.#removeTankOccurrence(entity, { destroyed: true });
        if (finalized) {
          this.counts.destroyedEntities += 1;
          this.#emitCombatEffect({
            type: 'tank-destruction',
            x: destroyedX,
            y: destroyedY,
            z: destroyedZ,
            durationSeconds: 4,
            cameraShake,
            intensity: 1.8,
            soundCue: 'hit',
          });
          this.#emitPresentationEvent({
            type: 'tank-ruin',
            x: destroyedX,
            y: destroyedY,
            z: destroyedZ,
            intensity: 0.85,
            lifetimeSeconds: 15,
          });
          this.#emitPresentationEvent({
            type: 'tank-scar',
            x: destroyedX,
            y: destroyedY,
            z: destroyedZ,
            intensity: finiteWorldUnitsToMeters(W6_ENTITY_CONTRACTS.tank.radius),
            lifetimeSeconds: 0,
          });
          this.#syncTransientCombat();
        }
      } else if (amount > 0) {
        this.#emitCombatEffect({
          type: 'tank-impact',
          x: entity.x,
          y: this.activeTankOccurrences.get(entity.stableId)?.groundY
            ?? this.#terrainHeightAt(entity.x, entity.z),
          z: entity.z,
          durationSeconds: 0.16,
          cameraShake,
          soundCue: 'hit',
        });
        this.#syncTank(entity);
      }
      return Object.freeze({
        ...result,
        spawned: justDestroyed ? false : entity.spawned,
        type: 'tank',
        kind: 'entity',
        destroyed: !result.alive,
        justDestroyed,
      });
    }

    if (justDestroyed) {
      this.counts.destroyedEntities += 1;
      if (awardPlayerCredit) {
        const contract = W6_ENTITY_CONTRACTS[entity.type];
        this.state.player.score += contract?.scoreValue ?? 0;
        this.state.healPlayer(W7_CORE_COMBAT_CONTRACT.healing[entity.type] ?? 0);
        if (entity.type === 'boss') {
          this.state.updateCombatProgress({
            bossesDefeated: this.state.combatProgress.bossesDefeated + 1,
            nextBossScore: this.state.player.score + W8_BOSS_CONTRACT.nextSpawnScoreDelta,
          });
        }
      }
    }
    if (entity.type === 'boss') {
      this.renderAdapter.syncManualBoss?.(entity);
    } else {
      this.renderAdapter.syncEntity(entity);
    }
    return Object.freeze({
      ...result,
      type: entity.type,
      kind: resolved.kind,
      destroyed: !result.alive,
      justDestroyed,
    });
  }

  async syncActiveChunks({
    renderedKeys,
    activeDataKeys = renderedKeys,
    getChunkData,
    renderOrigin,
  } = {}) {
    if (this.isShutdown) throw new Error('gameplay runtime is shut down');
    if (!Array.isArray(renderedKeys) || !Array.isArray(activeDataKeys)
      || typeof getChunkData !== 'function') {
      throw new TypeError('activeDataKeys, renderedKeys and getChunkData are required');
    }
    const desired = new Set(renderedKeys);
    const desiredSpatial = new Set(activeDataKeys);
    for (const key of desired) {
      if (!desiredSpatial.has(key)) {
        throw new Error(`rendered gameplay Chunk ${key} is outside Active Data`);
      }
    }
    for (const key of sorted(this.activeChunks.keys())) {
      if (desired.has(key)) continue;
      await this.renderAdapter.unloadChunk(key);
      this.activeChunks.delete(key);
      this.projectiles = this.projectiles.filter(projectile =>
        projectile.ownerChunkKey !== key
        || (projectile.ownerStableId
          && this.activeTankOccurrences.has(projectile.ownerStableId)));
      this.counts.chunksUnloaded += 1;
    }
    for (const key of sorted(this.spatialChunks.keys())) {
      if (!desiredSpatial.has(key)) this.spatialChunks.delete(key);
    }
    for (const key of sorted(desiredSpatial)) {
      if (this.spatialChunks.has(key)) continue;
      const { chunkX, chunkZ } = parseChunkKey(key);
      const chunkData = await getChunkData(chunkX, chunkZ);
      if (!chunkData) throw new Error(`missing W6 Active Data ChunkData: ${key}`);
      const model = await createW6ChunkGameplay({
        chunkData,
        worldSeedHash: this.worldSeedHash,
        generatorMajor: this.generatorMajor,
      });
      this.spatialChunks.set(key, model);
      this.#registerSpatialGameplayModel(key, model);
    }
    this.#refreshSpatialBroadphaseBounds();
    for (const key of sorted(desired)) {
      if (this.activeChunks.has(key)) continue;
      const model = this.spatialChunks.get(key);
      if (!model) throw new Error(`missing W6 spatial gameplay model: ${key}`);
      for (const target of model.staticTargets) {
        this.#registerStableId(target.stableId, key);
        if (target.type === 'militaryBase') this.state.reconcileFeatureDamage?.(target);
      }
      const entityStates = model.entityDescriptors.map(descriptor => {
        this.#registerStableId(descriptor.stableId, key);
        const existed = this.state.entityStates.has(descriptor.stableId);
        const entityState = this.state.ensureEntity(descriptor);
        if (entityState.type === 'tank') {
          this.#bindTank(entityState, descriptor);
          if (entityState.alive && entityState.spawned === true) {
            this.#startTankOccurrence(entityState, { sync: false });
          }
        }
        if (existed) this.counts.revisits += 1;
        return entityState;
      });
      this.activeChunks.set(key, model);
      await this.renderAdapter.loadChunk(key, entityStates);
      for (const entityState of entityStates) {
        if (entityState.type === 'tank') this.#syncTank(entityState);
      }
      this.counts.chunksLoaded += 1;
    }
    if (this.activeChunks.size !== desired.size) throw new Error('gameplay active Chunk set mismatch');
    if (this.spatialChunks.size !== desiredSpatial.size) {
      throw new Error('gameplay Active Data Chunk set mismatch');
    }
    const terrainReadyTankIds = await this.#prepareActiveTankTerrainForPresentation();
    for (const stableId of terrainReadyTankIds) {
      this.#syncTank(this.state.entityStates.get(stableId));
    }
    await this.renderAdapter.rebase(renderOrigin);
    this.renderAdapter.syncManualBoss?.(
      this.state.manualBossStableId
        ? this.state.entityStates.get(this.state.manualBossStableId) ?? null
        : null,
    );
    this.#syncTransientCombat();
    this.featureRenderAdapter?.refreshFeatureStates?.();
    return this.snapshot();
  }

  #moveToward(state, target, speedMetersPerSecond, deltaSeconds, away = false) {
    let dx = target.x - state.x;
    let dz = target.z - state.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-9) return;
    dx /= length;
    dz /= length;
    if (away) { dx = -dx; dz = -dz; }
    state.x += dx * speedMetersPerSecond * deltaSeconds;
    state.z += dz * speedMetersPerSecond * deltaSeconds;
    state.rotationY = Math.atan2(dx, dz);
    clampToOwner(state);
  }

  update({ deltaSeconds, player, playerY = null, simulationEnabled = true } = {}) {
    if (this.isShutdown) return;
    if (this.pendingTankRuntimeError) {
      const error = this.pendingTankRuntimeError;
      this.pendingTankRuntimeError = null;
      throw error;
    }
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new TypeError('deltaSeconds must be non-negative');
    const boundedDelta = Math.min(deltaSeconds, 0.05);
    const combatPlayer = Number.isFinite(playerY)
      ? { x: player.x, y: playerY, z: player.z }
      : player;
    if (boundedDelta > 0 && (this.playerKnockback.x !== 0 || this.playerKnockback.z !== 0)) {
      player.x += this.playerKnockback.x * boundedDelta;
      player.z += this.playerKnockback.z * boundedDelta;
      const decay = this.playerKnockback.decayPerFrame ** (boundedDelta * 60);
      this.playerKnockback.x *= decay;
      this.playerKnockback.z *= decay;
      if (Math.hypot(this.playerKnockback.x, this.playerKnockback.z) < 0.01) {
        this.playerKnockback.x = 0;
        this.playerKnockback.z = 0;
      }
    }
    this.state.updatePlayer({ x: player.x, z: player.z });
    this.state.tickGameplayTime(boundedDelta * 1000);
    this.state.tickNuclearCooldown(boundedDelta * 1000);
    this.#syncTankSandboxState();
    if (simulationEnabled !== true) {
      this.#syncTransientCombat();
      return;
    }
    for (const model of this.activeChunks.values()) {
      for (const descriptor of model.entityDescriptors) {
        const entity = this.state.entityStates.get(descriptor.stableId);
        if (!entity?.alive) continue;
        if (entity.type === 'tank') {
          if (entity.spawned === true && !this.activeTankOccurrences.has(entity.stableId)) {
            this.#startTankOccurrence(entity);
          }
          continue;
        }
        const distance = Math.sqrt(distanceSquared(entity, player));
        if (entity.type === 'human') {
          const contract = W6_ENTITY_CONTRACTS.human;
          if (entity.knockdownSeconds > 0) {
            entity.knockdownSeconds = Math.max(0, entity.knockdownSeconds - boundedDelta);
            entity.aiState = entity.knockdownSeconds > 0 ? 'fallen' : 'recover';
          } else if (distance < finiteWorldUnitsToMeters(contract.fleeRange)) {
            const priorX = entity.x; const priorZ = entity.z;
            entity.aiState = 'flee';
            this.#moveToward(entity, player,
              finiteWorldFrameSpeedToMetersPerSecond(contract.fleeSpeed), boundedDelta, true);
            const obstacle = model.avoidanceSurfaces.find(surface =>
              distanceSquared(entity, surface) < surface.radius ** 2);
            if (obstacle) {
              entity.x = priorX; entity.z = priorZ;
              entity.rotationY += Math.PI * 0.5;
              entity.aiState = obstacle.type === 'water' ? 'avoid-water' : 'avoid-building';
            }
          } else {
            entity.aiState = 'idle';
            entity.x += Math.sin(entity.rotationY) * finiteWorldFrameSpeedToMetersPerSecond(contract.idleSpeed) * boundedDelta;
            entity.z += Math.cos(entity.rotationY) * finiteWorldFrameSpeedToMetersPerSecond(contract.idleSpeed) * boundedDelta;
            clampToOwner(entity);
          }
        } else if (entity.type === 'boss') {
          const contract = W6_ENTITY_CONTRACTS.boss;
          if (distance > finiteWorldUnitsToMeters(contract.approachDistance)) {
            entity.aiState = 'slither';
            const speed = entity.hp / entity.maxHp <= 0.5 ? contract.rageMoveSpeed : contract.moveSpeed;
            this.#moveToward(entity, player, finiteWorldFrameSpeedToMetersPerSecond(speed), boundedDelta);
          }
        }
        entity.aiClock += boundedDelta;
        this.renderAdapter.syncEntity(entity);
        this.counts.entityUpdates += 1;
      }
    }
    const manualBoss = this.state.manualBossStableId
      ? this.state.entityStates.get(this.state.manualBossStableId)
      : null;
    if (manualBoss?.alive) {
      const contract = W6_ENTITY_CONTRACTS.boss;
      const distance = Math.sqrt(distanceSquared(manualBoss, player));
      const bossCombat = W7_MANUAL_BOSS_CONTRACT;
      this.#advanceBossBehavior(manualBoss, player, boundedDelta);
      const charging = manualBoss.aiState === 'charge';
      const rage = manualBoss.bossBehavior?.rage === true;
      const moving = !['recover', 'breach'].includes(manualBoss.aiState);
      if (moving && (charging || manualBoss.aiState === 'sweep' || manualBoss.aiState === 'dig'
        || distance > finiteWorldUnitsToMeters(contract.approachDistance))) {
        let dx = player.x - manualBoss.x;
        let dz = player.z - manualBoss.z;
        const length = Math.hypot(dx, dz);
        if (length > 1e-9) {
          dx /= length;
          dz /= length;
          const speed = charging
            ? (rage ? bossCombat.chargeSpeedRage : bossCombat.chargeSpeed)
            : manualBoss.aiState === 'sweep' ? (rage ? 22 : 16)
              : manualBoss.aiState === 'dig' ? (rage ? 19 : 14)
                : (rage ? contract.rageMoveSpeed : contract.moveSpeed);
          manualBoss.x += dx * finiteWorldFrameSpeedToMetersPerSecond(speed) * boundedDelta;
          manualBoss.z += dz * finiteWorldFrameSpeedToMetersPerSecond(speed) * boundedDelta;
          manualBoss.rotationY = Math.atan2(dx, dz);
          const nextOwner = logicalWorldToOwnedChunk(manualBoss.x, manualBoss.z).key;
          this.state.moveEntityOwner(manualBoss.stableId, nextOwner);
          this.stableIdOwners.set(manualBoss.stableId, nextOwner);
        }
      }
      const playerHitRange = finiteWorldUnitsToMeters(
        charging ? bossCombat.chargeHitRadius : bossCombat.bodyContactRange,
      );
      const hitDistance = Math.sqrt(distanceSquared(manualBoss, player));
      if (boundedDelta > 0 && this.state.player.hp > 0 && hitDistance <= playerHitRange) {
        const damagePerFrame = charging
          ? (rage ? bossCombat.chargeDamageRage : bossCombat.chargeDamage)
          : bossCombat.bodyContactDamage;
        const wasAlive = this.state.player.hp > 0;
        this.state.damagePlayer(damagePerFrame * boundedDelta * 60);
        this.pendingCameraShake = Math.max(this.pendingCameraShake, charging ? 25 : 14);
        this.counts.playerHits += 1;
        if (charging && hitDistance > 1e-9) {
          this.applyPlayerKnockback({
            directionX: player.x - manualBoss.x,
            directionZ: player.z - manualBoss.z,
            metersPerSecond: finiteWorldFrameSpeedToMetersPerSecond(bossCombat.chargePushForce),
            decayPerFrame: bossCombat.playerKnockbackDecay,
          });
        }
        if (wasAlive && this.state.player.hp <= 0) this.counts.playerDeaths += 1;
      }
      manualBoss.aiClock += boundedDelta;
      this.renderAdapter.syncManualBoss?.(manualBoss);
      this.counts.entityUpdates += 1;
    } else {
      this.renderAdapter.syncManualBoss?.(manualBoss);
    }
    for (const occurrence of [...this.activeTankOccurrences.values()]) {
      this.#updateTank(this.state.entityStates.get(occurrence.slotStableId), combatPlayer, boundedDelta);
    }
    this.#maintainFiniteTankSpawns(combatPlayer, boundedDelta);
    const bulletSpeed = finiteWorldFrameSpeedToMetersPerSecond(W7_CORE_COMBAT_CONTRACT.tank.bulletSpeed);
    const bulletHitRadius = finiteWorldUnitsToMeters(W7_CORE_COMBAT_CONTRACT.tank.bulletHitRadius);
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      if (projectile.type === 'tank-shell') {
        const occurrence = this.activeTankOccurrences.get(projectile.ownerStableId);
        if (!occurrence
          || occurrence.runtimeGeneration !== projectile.ownerRuntimeGeneration) {
          this.projectiles.splice(index, 1);
          continue;
        }
        const speedMultiplier = Math.min(
          W7_CORE_COMBAT_CONTRACT.tank.difficultySpeedMaximum,
          1 + this.state.player.score
            * W7_CORE_COMBAT_CONTRACT.tank.difficultySpeedScoreFactor,
        );
        const projectileSpeed = bulletSpeed * speedMultiplier;
        const nextX = projectile.x + projectile.directionX * projectileSpeed * boundedDelta;
        const nextY = projectile.y + projectile.directionY * projectileSpeed * boundedDelta;
        const nextZ = projectile.z + projectile.directionZ * projectileSpeed * boundedDelta;
        const terrainHeight = this.#tryTerrainHeightAt(nextX, nextZ, false);
        projectile.terrainWaitSeconds = 0;
        projectile.x = nextX;
        projectile.y = nextY;
        projectile.z = nextZ;
        projectile.remainingSeconds -= boundedDelta;
        let hitSomething = false;
        const playerCenter = {
          x: this.state.player.x,
          y: (Number.isFinite(combatPlayer.y)
            ? combatPlayer.y
            : this.#terrainHeightAt(this.state.player.x, this.state.player.z)),
          z: this.state.player.z,
        };
        if (this.state.player.hp > 0
          && distanceSquared3D(playerCenter, projectile)
            < bulletHitRadius ** 2) {
          const wasAlive = this.state.player.hp > 0;
          this.state.damagePlayer(W7_CORE_COMBAT_CONTRACT.tank.bulletDamage);
          this.#emitCombatEffect({
            type: 'tank-impact',
            x: projectile.x,
            y: projectile.y,
            z: projectile.z,
            durationSeconds: 0.18,
            cameraShake: W7_CORE_COMBAT_CONTRACT.tank.bulletCameraShake,
            soundCue: 'hit',
          });
          this.counts.playerHits += 1;
          if (wasAlive && this.state.player.hp <= 0) this.counts.playerDeaths += 1;
          hitSomething = true;
        }
        if (!hitSomething) {
          for (const candidate of this.#tankShellWorldCandidates(projectile, projectile)) {
            let resolved;
            let sphere;
            if (candidate.type === 'human') {
              this.#registerStableId(candidate.stableId, candidate.ownerChunkKey);
              const entity = this.state.ensureEntity(candidate);
              if (!entity.alive) continue;
              resolved = {
                kind: 'entity',
                stableId: entity.stableId,
                type: entity.type,
                entity,
                descriptor: candidate,
              };
              sphere = {
                x: entity.x,
                y: this.#terrainHeightAt(entity.x, entity.z),
                z: entity.z,
                radius: finiteWorldUnitsToMeters(W6_ENTITY_CONTRACTS.human.radius)
                  + W7_CORE_COMBAT_CONTRACT.tank.worldCollisionPaddingMeters,
              };
            } else {
              if (this.state.isFeatureDestroyed(candidate.stableId)) continue;
              resolved = {
                kind: 'feature',
                stableId: candidate.stableId,
                type: candidate.type,
                target: candidate,
              };
              sphere = {
                x: candidate.x,
                y: candidate.y ?? this.#terrainHeightAt(candidate.x, candidate.z),
                z: candidate.z,
                radius: finiteWorldUnitsToMeters(candidate.radius)
                  + W7_CORE_COMBAT_CONTRACT.tank.worldCollisionPaddingMeters,
              };
            }
            if (distanceSquared3D(sphere, projectile) >= sphere.radius ** 2) continue;
            const result = this.applyCombatDamage(
              resolved,
              W7_CORE_COMBAT_CONTRACT.tank.worldCollisionDamage,
              { awardPlayerCredit: true },
            );
            this.#emitCombatEffect({
              type: result.justDestroyed
                ? (resolved.kind === 'feature' ? 'destruction' : 'entity-destruction')
                : 'tank-impact',
              x: projectile.x,
              y: projectile.y,
              z: projectile.z,
              durationSeconds: result.justDestroyed ? 0.45 : 0.18,
              soundCue: result.justDestroyed && resolved.kind !== 'feature' ? 'splat' : 'hit',
            });
            hitSomething = true;
            break;
          }
        }
        if (!hitSomething && terrainHeight !== null
          && projectile.y <= terrainHeight
            + W8_TANK_LIFECYCLE_CONTRACT.terrainHitClearanceMeters) {
          this.#emitCombatEffect({
            type: 'tank-impact',
            x: projectile.x,
            y: projectile.y,
            z: projectile.z,
            durationSeconds: 0.18,
            soundCue: 'hit',
          });
          hitSomething = true;
        }
        if (hitSomething || projectile.remainingSeconds <= 0) this.projectiles.splice(index, 1);
        continue;
      }

      const start = { x: projectile.x, z: projectile.z };
      const projectileSpeed = bulletSpeed * (50 / 60);
      projectile.x += projectile.directionX * projectileSpeed * boundedDelta;
      projectile.z += projectile.directionZ * projectileSpeed * boundedDelta;
      projectile.remainingSeconds -= boundedDelta;
      const hit = this.state.player.hp > 0 && pointSegmentDistanceSquared(
        this.state.player,
        start,
        projectile,
      ) <= bulletHitRadius ** 2;
      if (hit) {
        const wasAlive = this.state.player.hp > 0;
        this.state.damagePlayer(6);
        this.#emitCombatEffect({
          type: 'acid-impact',
          x: projectile.x,
          z: projectile.z,
          durationSeconds: 0.18,
          cameraShake: W7_CORE_COMBAT_CONTRACT.tank.bulletCameraShake,
          soundCue: 'acid',
        });
        this.counts.playerHits += 1;
        if (wasAlive && this.state.player.hp <= 0) this.counts.playerDeaths += 1;
      }
      if (hit || projectile.remainingSeconds <= 0) this.projectiles.splice(index, 1);
    }
    for (let index = this.combatEffects.length - 1; index >= 0; index -= 1) {
      this.combatEffects[index].remainingSeconds -= boundedDelta;
      if (this.combatEffects[index].remainingSeconds <= 0) this.combatEffects.splice(index, 1);
    }
    this.#syncTransientCombat();
    this.counts.simulationTicks += 1;
  }

  executeCombatCommand(command) {
    if (command?.schemaVersion !== W8_COMBAT_COMMAND_SCHEMA) throw new TypeError('CombatCommand schema is required');
    if (command.type === W8_COMBAT_COMMAND_TYPES.CHARGE_START) {
      this.#emitPresentationEvent({
        type: 'charge-start', x: this.state.player.x, z: this.state.player.z,
        intensity: 0.7, lifetimeSeconds: 0.2, soundCue: 'rumble',
      });
      return Object.freeze({ accepted: true, charging: true });
    }
    if (command.type === W8_COMBAT_COMMAND_TYPES.CHARGE_RELEASE) {
      return this.nuclearAttack({ airborne: command.airborne });
    }
    const mode = command.type === W8_COMBAT_COMMAND_TYPES.LEFT ? 'left'
      : command.type === W8_COMBAT_COMMAND_TYPES.RIGHT ? 'right'
        : command.type === W8_COMBAT_COMMAND_TYPES.BOTH ? 'double' : null;
    if (!mode) throw new RangeError(`unsupported CombatCommand: ${command.type}`);
    return this.attack(mode, command.issuedAt);
  }

  attack(mode = 'single', now = this.clock()) {
    if (!['single', 'left', 'right', 'double'].includes(mode)) {
      throw new RangeError('attack mode must be left, right, single or double');
    }
    if (this.state.player.hp <= 0) {
      return Object.freeze({ accepted: false, reason: 'player-dead', hits: Object.freeze([]) });
    }
    if (now - this.lastAttackAt < W6_ATTACK_CONTRACT.cooldownMs) {
      this.counts.attackCooldownRejected += 1;
      return Object.freeze({ accepted: false, hits: Object.freeze([]) });
    }
    this.lastAttackAt = now;
    this.counts.attacks += 1;
    this.state.updateCombatProgress({ attacksIssued: this.state.combatProgress.attacksIssued + 1 });
    const profile = getW6ScaleProfile(this.state.activeScaleStageId);
    const single = mode !== 'double';
    const radius = single ? profile.singleAttackRadiusMeters : profile.doubleAttackRadiusMeters;
    const damage = single ? W6_ATTACK_CONTRACT.singleDamage : W6_ATTACK_CONTRACT.doubleDamage;
    const facingY = this.state.player.facingY;
    const attackSides = mode === 'double' ? [1, -1] : mode === 'left' ? [-1] : [1];
    const attackCenters = attackSides.map(side => {
      const offsetX = profile.attackOffsetXMeters * side;
      const offsetZ = profile.attackOffsetZMeters;
      return {
        x: this.state.player.x + offsetX * Math.cos(facingY) + offsetZ * Math.sin(facingY),
        z: this.state.player.z + offsetZ * Math.cos(facingY) - offsetX * Math.sin(facingY),
      };
    });
    const insideAttack = target => attackCenters.some(center => distanceSquared(target, center) <= radius ** 2);
    const hits = [];
    this.#emitPresentationEvent({
      type: mode === 'double' ? 'both-claw-swish' : mode === 'left' ? 'left-claw-swish' : 'right-claw-swish',
      x: this.state.player.x, z: this.state.player.z,
      directionX: Math.sin(facingY), directionZ: Math.cos(facingY),
      intensity: mode === 'double' ? 1.35 : 1, lifetimeSeconds: 0.24, soundCue: 'swish',
    });
    const combatTargets = [...this.#collectCombatTargets().values()]
      .sort((a, b) => a.stableId.localeCompare(b.stableId));
    for (const resolved of combatTargets) {
      if (resolved.kind === 'boss') continue;
      if (resolved.kind === 'feature') {
        const target = resolved.target;
        if (this.state.isFeatureDestroyed(target.stableId)
          || !canW6StageDamageTarget(this.state.activeScaleStageId, target)
          || !insideAttack(target)) continue;
        const result = this.applyCombatDamage(resolved, damage, { awardPlayerCredit: true });
        const building = W7_CORE_COMBAT_CONTRACT.building;
        const destroyedNow = result.justDestroyed;
        const buildingHitStopMs = BUILDING_TYPES.has(target.type)
          ? (destroyedNow ? building.destroyedHitStopMs : building.damagedHitStopMs) : 0;
        const buildingShake = destroyedNow && BUILDING_TYPES.has(target.type)
          ? Math.min(building.destroyedShakeMaximum,
            building.destroyedShakeMinimum + target.radius * building.destroyedShakeRadiusFactor)
          : damage / 7 * profile.stage.playerShakeMultiplier;
        this.#emitCombatEffect({
          type: destroyedNow ? 'destruction' : 'impact',
          x: target.x,
          z: target.z,
          durationSeconds: destroyedNow ? 0.45 : 0.16,
          cameraShake: buildingShake,
          hitStopMs: buildingHitStopMs,
          soundCue: destroyedNow ? 'splat' : 'hit',
        });
        hits.push(Object.freeze({ stableId: target.stableId, type: target.type, destroyed: result.destroyed }));
        continue;
      }
      const entity = resolved.entity;
      if (!entity?.alive || (entity.type === 'tank' && entity.spawned !== true)
        || !canW6StageDamageTarget(this.state.activeScaleStageId, entity)
        || !insideAttack(entity)) continue;
      const entityShake = damage / 7 * profile.stage.playerShakeMultiplier;
      const result = this.applyCombatDamage(resolved, damage, {
        awardPlayerCredit: true,
        cameraShake: entityShake,
      });
      if (entity.type === 'human' && result.alive) entity.knockdownSeconds = 1.15;
      if (entity.type !== 'tank') {
        this.#emitCombatEffect({
          type: result.alive ? 'entity-impact' : 'entity-destruction',
          x: entity.x,
          z: entity.z,
          durationSeconds: result.alive ? 0.16 : 0.45,
          cameraShake: entityShake,
          soundCue: result.alive ? 'hit' : 'splat',
        });
      }
      hits.push(Object.freeze({ stableId: entity.stableId, type: entity.type, destroyed: !result.alive }));
    }
    const manualBoss = this.state.manualBossStableId
      ? this.state.entityStates.get(this.state.manualBossStableId)
      : null;
    if (manualBoss?.alive
      && canW6StageDamageTarget(this.state.activeScaleStageId, manualBoss)
      && insideAttack(manualBoss)) {
      const result = this.applyCombatDamage(
        {
          kind: 'boss',
          stableId: manualBoss.stableId,
          type: 'boss',
          entity: manualBoss,
        },
        damage,
        { awardPlayerCredit: true },
      );
      this.#syncBossDamageStage(manualBoss);
      this.#emitCombatEffect({
        type: result.alive ? 'entity-impact' : 'entity-destruction',
        x: manualBoss.x,
        z: manualBoss.z,
        durationSeconds: result.alive ? 0.16 : 0.8,
        cameraShake: damage / 7 * profile.stage.playerShakeMultiplier,
        soundCue: result.alive ? 'hit' : 'roar',
      });
      hits.push(Object.freeze({
        stableId: manualBoss.stableId,
        type: 'boss',
        destroyed: result.destroyed,
      }));
    }
    const damageDealt = hits.length * damage;
    this.state.updateCombatProgress({ damageDealt: this.state.combatProgress.damageDealt + damageDealt });
    if (this.state.player.score >= this.state.combatProgress.nextBossScore && !manualBoss?.alive) {
      void this.spawnNaturalBoss();
    }
    this.#syncTransientCombat();
    return Object.freeze({ accepted: true, mode, damage, radiusMeters: radius, hits: Object.freeze(hits) });
  }

  async spawnManualBoss() {
    return this.#spawnBoss('manual');
  }

  async spawnNaturalBoss() {
    return this.#spawnBoss('natural');
  }

  async #spawnBoss(spawnKind) {
    if (this.pendingBossSpawn) return this.pendingBossSpawn;
    const spawnPromise = this.#createBoss(spawnKind);
    this.pendingBossSpawn = spawnPromise;
    try {
      return await spawnPromise;
    } finally {
      if (this.pendingBossSpawn === spawnPromise) this.pendingBossSpawn = null;
    }
  }

  async #createBoss(spawnKind) {
    const existing = this.state.manualBossStableId
      ? this.state.entityStates.get(this.state.manualBossStableId)
      : null;
    if (existing?.alive) {
      return Object.freeze({ accepted: false, reason: 'manual-boss-already-active', stableId: existing.stableId });
    }
    const sequence = this.state.manualBossSequence + 1;
    const result = await entityStableId({
      worldSeedHash: this.worldSeedHash,
      generatorMajor: this.generatorMajor,
      featureType: 'boss',
      parentStableId: `infinite-world:${this.worldSeedHash}`,
      purposeKey: `w8-${spawnKind}-boss:${sequence}`,
    });
    const spawnDistanceMeters = finiteWorldUnitsToMeters(W7_MANUAL_BOSS_CONTRACT.spawnDistance);
    const x = this.state.player.x + Math.sin(this.state.player.facingY) * spawnDistanceMeters;
    const z = this.state.player.z + Math.cos(this.state.player.facingY) * spawnDistanceMeters;
    const ownerChunkKey = logicalWorldToOwnedChunk(x, z).key;
    const descriptor = {
      stableId: result.stableId,
      canonicalInput: result.canonicalInput,
      ownerChunkKey,
      type: 'boss',
      maxHp: W6_ENTITY_CONTRACTS.boss.maxHp,
      radius: W6_ENTITY_CONTRACTS.boss.radius,
      scoreValue: W6_ENTITY_CONTRACTS.boss.scoreValue,
      x: q6(x),
      z: q6(z),
      rotationY: q6(this.state.player.facingY + Math.PI),
      aiState: 'slither',
    };
    this.#registerStableId(descriptor.stableId, ownerChunkKey);
    const boss = this.state.ensureEntity(descriptor);
    this.state.setManualBoss(boss.stableId, sequence);
    if (spawnKind === 'natural') {
      this.state.updateCombatProgress({ nextBossScore: Number.MAX_SAFE_INTEGER });
    }
    this.#emitCombatEffect({
      type: 'boss-breach', x: boss.x, z: boss.z, durationSeconds: 1.1,
      cameraShake: 90, intensity: 2, soundCue: 'roar',
    });
    this.renderAdapter.syncManualBoss?.(boss);
    this.counts.manualBossSpawns += 1;
    return Object.freeze({
      accepted: true,
      stableId: boss.stableId,
      sequence,
      spawnDistanceMeters,
      ownerChunkKey,
      spawnKind,
    });
  }

  async nuclearAttack({ x = this.state.player.x, z = this.state.player.z, airborne = false } = {}) {
    if (this.state.activeScaleStageId !== W7_NUCLEAR_CONTRACT.allowedScaleStageId) {
      return Object.freeze({ accepted: false, reason: 'scale-not-allowed', hitStableIds: Object.freeze([]) });
    }
    if (!airborne) {
      return Object.freeze({ accepted: false, reason: 'air-release-required', hitStableIds: Object.freeze([]) });
    }
    if (this.state.nuclearCooldownMs > 0) {
      return Object.freeze({
        accepted: false,
        reason: 'cooldown',
        cooldownRemainingMs: this.state.nuclearCooldownMs,
        hitStableIds: Object.freeze([]),
      });
    }
    if (typeof this.getChunkDataForQuery !== 'function') {
      throw new Error('nuclear attack requires the existing ChunkData query');
    }
    const radiusMeters = finiteWorldUnitsToMeters(W7_NUCLEAR_CONTRACT.damageRadius);
    const coordinates = chunksIntersectingLogicalCircle(x, z, radiusMeters);
    const models = await Promise.all(coordinates.map(async coordinate => createW6ChunkGameplay({
      chunkData: await this.getChunkDataForQuery(coordinate.chunkX, coordinate.chunkZ),
      worldSeedHash: this.worldSeedHash,
      generatorMajor: this.generatorMajor,
    })));
    const staticTargets = new Map();
    const entityDescriptors = new Map();
    for (const model of models) {
      for (const target of model.staticTargets) {
        const existing = staticTargets.get(target.stableId);
        if (existing && existing.ownerChunkKey !== target.ownerChunkKey) {
          throw new Error(`Stable ID collision in nuclear query: ${target.stableId}`);
        }
        staticTargets.set(target.stableId, target);
        this.#registerStableId(target.stableId, target.ownerChunkKey);
      }
      for (const descriptor of model.entityDescriptors) {
        const existing = entityDescriptors.get(descriptor.stableId);
        if (existing && existing.ownerChunkKey !== descriptor.ownerChunkKey) {
          throw new Error(`Stable ID collision in nuclear query: ${descriptor.stableId}`);
        }
        entityDescriptors.set(descriptor.stableId, descriptor);
        this.#registerStableId(descriptor.stableId, descriptor.ownerChunkKey);
      }
    }
    const inside = target => distanceSquared(target, { x, z }) <= radiusMeters ** 2;
    const hitStableIds = [];
    for (const target of [...staticTargets.values()].sort((a, b) => a.stableId.localeCompare(b.stableId))) {
      if (!inside(target) || this.state.isFeatureDestroyed(target.stableId)) continue;
      this.applyCombatDamage(
        {
          kind: 'feature',
          stableId: target.stableId,
          type: target.type,
          target,
        },
        W7_NUCLEAR_CONTRACT.damageAmount,
        { awardPlayerCredit: true },
      );
      hitStableIds.push(target.stableId);
    }
    for (const descriptor of [...entityDescriptors.values()].sort((a, b) => a.stableId.localeCompare(b.stableId))) {
      const entity = this.state.ensureEntity(descriptor);
      if (entity.type === 'tank') this.#bindTank(entity, descriptor);
      if (!entity.alive || (entity.type === 'tank' && entity.spawned !== true) || !inside(entity)) continue;
      this.applyCombatDamage(
        {
          kind: entity.type === 'boss' ? 'boss' : 'entity',
          stableId: entity.stableId,
          type: entity.type,
          entity,
          descriptor,
        },
        W7_NUCLEAR_CONTRACT.damageAmount,
        { awardPlayerCredit: true },
      );
      hitStableIds.push(entity.stableId);
    }
    for (const occurrence of [...this.activeTankOccurrences.values()]
      .sort((a, b) => a.slotStableId.localeCompare(b.slotStableId))) {
      const tank = this.state.entityStates.get(occurrence.slotStableId);
      if (!tank?.alive || tank.spawned !== true || !inside(tank)
        || hitStableIds.includes(tank.stableId)) continue;
      this.applyCombatDamage(
        {
          kind: 'entity',
          stableId: tank.stableId,
          type: 'tank',
          entity: tank,
          occurrence,
        },
        W7_NUCLEAR_CONTRACT.damageAmount,
        { awardPlayerCredit: true },
      );
      hitStableIds.push(tank.stableId);
    }
    const manualBoss = this.state.manualBossStableId
      ? this.state.entityStates.get(this.state.manualBossStableId)
      : null;
    if (manualBoss?.alive && inside(manualBoss) && !hitStableIds.includes(manualBoss.stableId)) {
      this.applyCombatDamage(
        {
          kind: 'boss',
          stableId: manualBoss.stableId,
          type: 'boss',
          entity: manualBoss,
        },
        W7_NUCLEAR_CONTRACT.damageAmount,
        { awardPlayerCredit: true },
      );
      hitStableIds.push(manualBoss.stableId);
    }
    hitStableIds.sort((a, b) => a.localeCompare(b));
    this.state.setNuclearCooldown(W7_NUCLEAR_CONTRACT.cooldownMs);
    this.#emitCombatEffect({
      type: 'nuclear-destruction', x, z, durationSeconds: 2.2,
      cameraShake: W7_NUCLEAR_CONTRACT.cameraShake,
      intensity: 4, soundCue: 'atomic',
    });
    this.featureRenderAdapter?.refreshFeatureStates?.();
    this.#syncTransientCombat();
    this.counts.nuclearAttacks += 1;
    this.counts.nuclearChunksQueried += coordinates.length;
    this.counts.nuclearTargetsHit += hitStableIds.length;
    return Object.freeze({
      accepted: true,
      radiusMeters,
      damage: W7_NUCLEAR_CONTRACT.damageAmount,
      queriedChunkKeys: Object.freeze(coordinates.map(value => value.key)),
      hitStableIds: Object.freeze(hitStableIds),
    });
  }

  isHitStopped(now = this.clock()) {
    return now < this.hitStopUntil;
  }

  applyPlayerKnockback({ directionX, directionZ, metersPerSecond, decayPerFrame = 0.85 } = {}) {
    const length = Math.hypot(directionX, directionZ);
    if (!Number.isFinite(length) || length <= 1e-9 || !Number.isFinite(metersPerSecond)
      || metersPerSecond < 0 || !Number.isFinite(decayPerFrame) || decayPerFrame < 0 || decayPerFrame > 1) {
      throw new TypeError('valid player knockback vector, speed, and decay are required');
    }
    this.playerKnockback = {
      x: directionX / length * metersPerSecond,
      z: directionZ / length * metersPerSecond,
      decayPerFrame,
    };
    return Object.freeze({ ...this.playerKnockback });
  }

  consumePresentationEffects() {
    const result = Object.freeze({
      cameraShake: this.pendingCameraShake,
      events: Object.freeze(this.presentationEvents.splice(0)),
    });
    this.pendingCameraShake = 0;
    return result;
  }

  clearTransientCombat() {
    this.tankSpawnEpoch += 1;
    this.pendingTankReinforcement = null;
    this.pendingTankRuntimeError = null;
    this.tankSpawnFrameAccumulator = 0;
    this.#cancelAllPendingTankSpawns();
    this.pendingTankTerrainChunks.clear();
    this.tankTerrainQueryErrors.clear();
    this.projectiles.length = 0;
    this.combatEffects.length = 0;
    this.presentationEvents.length = 0;
    this.pendingCameraShake = 0;
    this.hitStopUntil = -Infinity;
    this.playerKnockback = { x: 0, z: 0, decayPerFrame: 0.85 };
    this.lastAttackAt = -Infinity;
    this.renderAdapter.clearReinforcements?.();
    this.renderAdapter.clearCombatPresentation?.();
    this.#rebuildTankOccurrences({ sync: false });
    this.#syncTransientCombat();
    return this.snapshot();
  }

  async restart({ playerSpawn, renderOrigin } = {}) {
    this.tankSpawnEpoch += 1;
    this.pendingTankReinforcement = null;
    this.pendingTankRuntimeError = null;
    this.#cancelAllPendingTankSpawns();
    this.pendingTankTerrainChunks.clear();
    this.tankTerrainQueryErrors.clear();
    this.state.restartRun({ playerSpawn });
    this.projectiles.length = 0;
    this.combatEffects.length = 0;
    this.presentationEvents.length = 0;
    this.pendingCameraShake = 0;
    this.hitStopUntil = -Infinity;
    this.playerKnockback = { x: 0, z: 0, decayPerFrame: 0.85 };
    this.activeTankOccurrences.clear();
    this.tankBindings.clear();
    this.tankOccurrenceGenerations.clear();
    this.reinforcementIds.clear();
    this.stableIdOwners.clear();
    this.tankSpawnFrameAccumulator = 0;
    this.tankSpawnFrame = 0;
    this.renderAdapter.clearReinforcements?.();
    this.renderAdapter.clearCombatPresentation?.();
    this.lastAttackAt = -Infinity;
    this.counts.restarts += 1;
    await this.refreshFromState({ renderOrigin });
    this.#syncTransientCombat();
    return this.snapshot();
  }

  damageStableId(stableId, amount) {
    return this.applyCombatDamage(stableId, amount);
  }

  async refreshFromState({ renderOrigin } = {}) {
    this.tankSpawnEpoch += 1;
    this.pendingTankReinforcement = null;
    this.pendingTankRuntimeError = null;
    this.tankSpawnFrameAccumulator = 0;
    this.#cancelAllPendingTankSpawns();
    this.pendingTankTerrainChunks.clear();
    this.tankTerrainQueryErrors.clear();
    const activeModels = [...this.activeChunks.entries()];
    for (const [key] of activeModels) await this.renderAdapter.unloadChunk(key);
    this.renderAdapter.clearReinforcements?.();
    this.activeTankOccurrences.clear();
    this.reinforcementIds.clear();
    this.tankBindings.clear();
    this.stableIdOwners.clear();
    for (const entity of this.state.entityStates.values()) {
      this.#registerStableId(entity.stableId, entity.ownerChunkKey);
    }
    for (const [key, model] of this.spatialChunks) {
      this.#registerSpatialGameplayModel(key, model, { startOccurrences: false });
    }
    for (const [key, model] of activeModels) {
      for (const target of model.staticTargets) this.#registerStableId(target.stableId, key);
      const states = model.entityDescriptors.map(descriptor => {
        this.#registerStableId(descriptor.stableId, key);
        const entity = this.state.ensureEntity(descriptor);
        if (entity.type === 'tank') this.#bindTank(entity, descriptor);
        return entity;
      });
      await this.renderAdapter.loadChunk(key, states);
    }
    this.#rebuildTankOccurrences({ sync: false });
    const terrainReadyTankIds = await this.#prepareActiveTankTerrainForPresentation();
    for (const stableId of terrainReadyTankIds) {
      this.#syncTank(this.state.entityStates.get(stableId));
    }
    await this.renderAdapter.rebase(renderOrigin);
    this.renderAdapter.syncManualBoss?.(
      this.state.manualBossStableId
        ? this.state.entityStates.get(this.state.manualBossStableId) ?? null
        : null,
    );
    this.featureRenderAdapter?.refreshFeatureStates?.();
  }

  snapshot() {
    const simulatedEntityCount = [...this.activeChunks.values()].reduce(
      (sum, model) => sum + model.entityDescriptors.length, 0,
    );
    const simulatedStaticTargetCount = [...this.activeChunks.values()].reduce(
      (sum, model) => sum + model.staticTargets.length, 0,
    );
    const activeTankCount = this.activeTankOccurrences.size;
    const pendingTankSpawnCount = this.pendingTankSpawnReservations.size;
    return Object.freeze({
      schemaVersion: 'w6-infinite-gameplay-runtime-1',
      activeSimulationChunkCount: this.activeChunks.size,
      activeSimulationChunkKeys: Object.freeze(sorted(this.activeChunks.keys())),
      activeDataChunkCount: this.spatialChunks.size,
      activeDataChunkKeys: Object.freeze(sorted(this.spatialChunks.keys())),
      simulatedEntityCount,
      simulatedStaticTargetCount,
      activeTankCount,
      pendingTankSpawnCount,
      reservedTankCapacityCount: activeTankCount + pendingTankSpawnCount,
      allowedTankCount: this.#allowedTankCount(),
      pendingTankSlotStableIds: Object.freeze(sorted(
        [...this.pendingTankSpawnReservations.values()]
          .map(reservation => reservation.slotStableId)
          .filter(Boolean),
      )),
      tankSlotCount: this.tankBindings.size - this.reinforcementIds.size,
      fallbackTankCount: this.reinforcementIds.size,
      tankOwnerRegistryCount: this.tankBindings.size,
      tankOccurrenceGenerationCount: this.tankOccurrenceGenerations.size,
      tankSandboxSuppressed: this.state.activeScaleStageId !== 'MAX',
      tankTerrainCacheCapacity: TANK_TERRAIN_QUERY_CACHE_CAPACITY,
      tankTerrainCacheCount: this.tankTerrainChunks.size,
      tankTerrainPendingQueryCount: this.pendingTankTerrainChunks.size,
      activeProjectileCount: this.projectiles.length,
      activeCombatEffectCount: this.combatEffects.length,
      hitStopped: this.isHitStopped(),
      state: this.state.snapshot(),
      render: this.renderAdapter.snapshot(),
      counts: Object.freeze({ ...this.counts }),
    });
  }

  async shutdown() {
    if (this.isShutdown) return;
    this.isShutdown = true;
    this.tankSpawnEpoch += 1;
    this.pendingTankReinforcement = null;
    this.pendingTankRuntimeError = null;
    this.#cancelAllPendingTankSpawns();
    await this.renderAdapter.shutdown();
    this.activeChunks.clear();
    this.spatialChunks.clear();
    this.stableIdOwners.clear();
    this.activeTankOccurrences.clear();
    this.tankBindings.clear();
    this.tankOccurrenceGenerations.clear();
    this.reinforcementIds.clear();
    this.tankTerrainChunks.clear();
    this.pendingTankTerrainChunks.clear();
    this.tankTerrainQueryErrors.clear();
    this.projectiles.length = 0;
    this.combatEffects.length = 0;
    this.renderAdapter.syncManualBoss?.(null);
    this.#syncTransientCombat();
  }
}
