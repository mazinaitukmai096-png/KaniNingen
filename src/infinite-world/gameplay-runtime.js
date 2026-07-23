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
const BUILDING_TYPES = new Set(['house', 'tower', 'church', 'school']);

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
    const type = landmark.landmarkType === 'militaryBase' ? 'militaryBase' : 'house';
    const contract = W6_STATIC_TARGET_CONTRACTS[type];
    staticTargets.push(staticTarget(
      landmark,
      type,
      contract,
      landmark.worldPosition,
      type === 'militaryBase'
        ? contract.radius
        : Math.hypot(landmark.widthMeters, landmark.depthMeters) * 20,
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
    this.worldSeedHash = worldSeedHash;
    this.generatorMajor = generatorMajor;
    this.state = state;
    this.renderAdapter = renderAdapter;
    this.featureRenderAdapter = featureRenderAdapter;
    this.getChunkDataForQuery = getChunkDataForQuery;
    this.clock = clock;
    this.activeChunks = new Map();
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
    this.tankSpawnFrameAccumulator = 0;
    this.tankSpawnFrame = 0;
    this.reinforcementIds = new Set(
      [...this.state.entityStates.values()]
        .filter(entity => entity.type === 'tank' && (entity.reinforcementSequence ?? 0) > 0)
        .map(entity => entity.stableId),
    );
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
  }

  #emitPresentationEvent({
    type, x, z, directionX = 0, directionZ = 0, intensity = 1,
    lifetimeSeconds = 0.25, soundCue = null,
  }) {
    const event = Object.freeze({
      schemaVersion: W8_PRESENTATION_EVENT_SCHEMA,
      sequence: ++this.combatSequence,
      type,
      logicalPosition: Object.freeze({ x: q6(x), y: 0, z: q6(z) }),
      direction: Object.freeze({ x: q6(directionX), y: 0, z: q6(directionZ) }),
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
    type, x, z, durationSeconds, cameraShake = 0, hitStopMs = 0,
    directionX = 0, directionZ = 0, intensity = 1, soundCue = null,
  }) {
    const effect = {
      id: `combat-effect:${this.combatSequence + 1}`,
      type,
      x: q6(x),
      z: q6(z),
      remainingSeconds: durationSeconds,
    };
    this.combatEffects.push(effect);
    this.#emitPresentationEvent({
      type, x, z, directionX, directionZ, intensity,
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

  #tankHasLineOfSight(entity, player) {
    const clearance = W8_TANK_LIFECYCLE_CONTRACT.lineOfSightClearanceMeters;
    const playerDistanceSquared = distanceSquared(entity, player);
    for (const model of this.activeChunks.values()) {
      for (const obstacle of model.staticTargets) {
        if (obstacle.type === 'pebble' || this.state.isFeatureDestroyed(obstacle.stableId)) continue;
        if (distanceSquared(entity, obstacle) >= playerDistanceSquared) continue;
        const radius = finiteWorldUnitsToMeters(obstacle.radius) + clearance;
        if (pointSegmentDistanceSquared(obstacle, entity, player) < radius ** 2) return false;
      }
    }
    for (const obstacle of this.state.entityStates.values()) {
      if (obstacle === entity || !obstacle.alive || obstacle.spawned !== true
        || obstacle.type !== 'tank' || distanceSquared(entity, obstacle) >= playerDistanceSquared) continue;
      const radius = finiteWorldUnitsToMeters(W6_ENTITY_CONTRACTS.tank.radius) + clearance;
      if (pointSegmentDistanceSquared(obstacle, entity, player) < radius ** 2) return false;
    }
    return true;
  }

  #syncTank(entity) {
    if ((entity.reinforcementSequence ?? 0) > 0) this.renderAdapter.syncReinforcement?.(entity);
    else this.renderAdapter.syncEntity(entity);
  }

  #updateTank(entity, player, deltaSeconds) {
    if (!entity?.alive || entity.spawned !== true) {
      if (entity) this.#syncTank(entity);
      return;
    }
    const contract = W6_ENTITY_CONTRACTS.tank;
    const lifecycle = W8_TANK_LIFECYCLE_CONTRACT;
    const distance = Math.sqrt(distanceSquared(entity, player));
    if (distance >= finiteWorldUnitsToMeters(contract.despawnDistance)) {
      entity.spawned = false;
      entity.aiState = 'reserve';
      this.projectiles = this.projectiles.filter(projectile => projectile.ownerStableId !== entity.stableId);
      this.#syncTank(entity);
      return;
    }
    if (distance > finiteWorldUnitsToMeters(contract.engageRange)) {
      entity.aiState = 'search';
      this.#syncTank(entity);
      return;
    }

    entity.stuckCheckClock = Math.max(0, (entity.stuckCheckClock ?? 0) - deltaSeconds);
    if (entity.stuckCheckClock <= 0) {
      const movedSquared = (entity.x - (entity.lastX ?? entity.x)) ** 2
        + (entity.z - (entity.lastZ ?? entity.z)) ** 2;
      if (entity.aiState === 'engage' && movedSquared < lifecycle.stuckDistanceThresholdMetersSquared) {
        entity.stuckRemainingSeconds = lifecycle.stuckAvoidSeconds;
        const side = deterministicUnitFloat(`${this.worldSeedHash}:${entity.stableId}:${entity.fireSequence}:avoid`) >= 0.5 ? 1 : -1;
        entity.avoidAngle = normalizedAngle(entity.rotationY + side * Math.PI / 2);
      }
      entity.lastX = entity.x;
      entity.lastZ = entity.z;
      entity.stuckCheckClock = lifecycle.stuckCheckSeconds;
    }
    entity.stuckRemainingSeconds = Math.max(0, (entity.stuckRemainingSeconds ?? 0) - deltaSeconds);
    const stuck = entity.stuckRemainingSeconds > 0;
    const hasLineOfSight = this.#tankHasLineOfSight(entity, player);
    const targetHeading = Math.atan2(player.x - entity.x, player.z - entity.z);
    const bodyTarget = stuck ? entity.avoidAngle
      : hasLineOfSight ? targetHeading : normalizedAngle(targetHeading + Math.PI / 3);
    const frameScale = deltaSeconds * 60;
    entity.rotationY = turnTowardAngle(
      entity.rotationY,
      bodyTarget,
      lifecycle.bodyTurnRadiansPerFrame * frameScale,
    );
    const shouldMove = distance > finiteWorldUnitsToMeters(contract.approachDistance)
      || !hasLineOfSight || stuck;
    if (shouldMove) {
      entity.aiState = stuck ? 'avoid' : hasLineOfSight ? 'engage' : 'flank';
      const speed = finiteWorldFrameSpeedToMetersPerSecond(contract.moveSpeed);
      entity.x += Math.sin(entity.rotationY) * speed * deltaSeconds;
      entity.z += Math.cos(entity.rotationY) * speed * deltaSeconds;
      if ((entity.reinforcementSequence ?? 0) > 0) {
        const owner = logicalWorldToOwnedChunk(entity.x, entity.z).key;
        if (owner !== entity.ownerChunkKey) {
          this.state.moveEntityOwner(entity.stableId, owner);
          this.stableIdOwners.set(entity.stableId, owner);
        }
      }
    } else entity.aiState = 'hold';

    entity.turretRotationY = turnTowardAngle(
      entity.turretRotationY ?? entity.rotationY,
      targetHeading,
      lifecycle.turretTurnRadiansPerFrame * frameScale,
    );
    const horizontalDistance = Math.max(0.025, distance);
    const targetGunPitch = -Math.atan2(finiteWorldUnitsToMeters(-30), horizontalDistance);
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
    const aimComplete = Math.abs(normalizedAngle(targetHeading - entity.turretRotationY)) <= 0.06;
    if (hasLineOfSight && !stuck && aimComplete
      && this.state.gameplayTimeMs - entity.lastShotAtMs >= fireIntervalMs) {
      const dx = player.x - entity.x;
      const dz = player.z - entity.z;
      const length = Math.hypot(dx, dz) || 1;
      entity.fireSequence = (entity.fireSequence ?? 0) + 1;
      entity.lastShotAtMs = this.state.gameplayTimeMs;
      this.projectiles.push({
        id: `${entity.stableId}:shot:${entity.fireSequence}`,
        ownerStableId: entity.stableId,
        ownerChunkKey: entity.ownerChunkKey,
        x: entity.x, z: entity.z, directionX: dx / length, directionZ: dz / length,
        remainingSeconds: combat.bulletLifeFrames / 60, type: 'tank-shell',
      });
      this.#emitPresentationEvent({
        type: 'tank-fire', x: entity.x, z: entity.z,
        directionX: dx / length, directionZ: dz / length,
        intensity: 1.2, lifetimeSeconds: 0.2, soundCue: 'tank-fire',
      });
      this.counts.tankShots += 1;
    }
    this.#syncTank(entity);
    this.counts.entityUpdates += 1;
  }

  #activateBaseTank(entity, spawnFrame) {
    const scatter = W8_TANK_LIFECYCLE_CONTRACT.baseSpawnScatterMeters;
    const key = `${this.worldSeedHash}:${entity.stableId}:${spawnFrame}`;
    entity.x = entity.baseX + (deterministicUnitFloat(`${key}:x`) - 0.5) * scatter;
    entity.z = entity.baseZ + (deterministicUnitFloat(`${key}:z`) - 0.5) * scatter;
    entity.rotationY = deterministicUnitFloat(`${key}:heading`) * Math.PI * 2;
    entity.turretRotationY = entity.rotationY;
    entity.gunPitch = 0;
    entity.spawned = true;
    entity.aiState = 'acquire';
    entity.lastShotAtMs = this.state.gameplayTimeMs;
    entity.stuckCheckClock = 0;
    entity.stuckRemainingSeconds = 0;
    entity.lastX = entity.x;
    entity.lastZ = entity.z;
    this.#syncTank(entity);
  }

  #spawnFallbackTank(player, spawnFrame) {
    if (this.pendingTankReinforcement || typeof this.renderAdapter.syncReinforcement !== 'function') return;
    const sequence = this.state.nextTankReinforcementSequence();
    const pending = (async () => {
      const result = await entityStableId({
        worldSeedHash: this.worldSeedHash,
        generatorMajor: this.generatorMajor,
        featureType: 'tank',
        parentStableId: `infinite-world:${this.worldSeedHash}`,
        purposeKey: `w8-tank-reinforcement:${sequence}`,
      });
      if (this.isShutdown) return;
      const key = `${this.worldSeedHash}:fallback:${spawnFrame}:${sequence}`;
      const angle = deterministicUnitFloat(`${key}:angle`) * Math.PI * 2;
      const lifecycle = W8_TANK_LIFECYCLE_CONTRACT;
      const distance = lifecycle.fallbackMinimumDistanceMeters
        + deterministicUnitFloat(`${key}:distance`)
          * (lifecycle.fallbackMaximumDistanceMeters - lifecycle.fallbackMinimumDistanceMeters);
      const x = player.x + Math.sin(angle) * distance;
      const z = player.z + Math.cos(angle) * distance;
      const ownerChunkKey = logicalWorldToOwnedChunk(x, z).key;
      this.#registerStableId(result.stableId, ownerChunkKey);
      const tank = this.state.ensureEntity({
        stableId: result.stableId, ownerChunkKey, type: 'tank',
        maxHp: W6_ENTITY_CONTRACTS.tank.maxHp,
        x, z, rotationY: normalizedAngle(angle + Math.PI), aiState: 'acquire',
        reinforcementSequence: sequence, spawned: true,
        lastShotAtMs: this.state.gameplayTimeMs,
      });
      this.reinforcementIds.add(tank.stableId);
      this.renderAdapter.syncReinforcement(tank);
    })();
    this.pendingTankReinforcement = pending;
    void pending.finally(() => {
      if (this.pendingTankReinforcement === pending) this.pendingTankReinforcement = null;
    });
  }

  #maintainFiniteTankSpawns(player, deltaSeconds) {
    const lifecycle = W8_TANK_LIFECYCLE_CONTRACT;
    if (this.isShutdown || this.state.activeScaleStageId !== 'MAX' || deltaSeconds <= 0) return;
    this.tankSpawnFrameAccumulator += deltaSeconds * 60;
    while (this.tankSpawnFrameAccumulator >= 1) {
      this.tankSpawnFrameAccumulator -= 1;
      this.tankSpawnFrame += 1;
      const activeBoss = this.state.manualBossStableId
        ? this.state.entityStates.get(this.state.manualBossStableId)?.alive === true : false;
      const allowed = activeBoss ? lifecycle.bossTankLimit : Math.min(
        lifecycle.tankLimitMaximum,
        lifecycle.normalTankBaseLimit + Math.floor(this.state.player.score / lifecycle.tankLimitScoreDivisor),
      );
      const active = [...this.state.entityStates.values()]
        .filter(entity => entity.type === 'tank' && entity.alive && entity.spawned === true).length;
      if (active >= allowed) continue;
      const chance = lifecycle.spawnChanceBasePerFrame + Math.min(
        lifecycle.spawnChanceMaximumBonusPerFrame,
        this.state.player.score * lifecycle.spawnChanceScoreFactor,
      );
      if (deterministicUnitFloat(`${this.worldSeedHash}:tank-spawn:${this.tankSpawnFrame}`) >= chance) continue;
      const nearbyBases = [...this.state.entityStates.values()]
        .filter(entity => entity.type === 'tank' && entity.alive && entity.spawned !== true
          && (entity.reinforcementSequence ?? 0) === 0
          && this.activeChunks.has(entity.ownerChunkKey)
          && distanceSquared(entity, player) < lifecycle.baseSpawnRangeMeters ** 2)
        .sort((a, b) => a.stableId.localeCompare(b.stableId));
      if (nearbyBases.length > 0) {
        const selection = Math.floor(
          deterministicUnitFloat(`${this.worldSeedHash}:tank-base:${this.tankSpawnFrame}`) * nearbyBases.length,
        );
        this.#activateBaseTank(nearbyBases[Math.min(selection, nearbyBases.length - 1)], this.tankSpawnFrame);
      } else if (this.state.player.score > lifecycle.fallbackMinimumScore) {
        this.#spawnFallbackTank(player, this.tankSpawnFrame);
      }
    }
  }

  #registerStableId(stableId, ownerChunkKey) {
    const existingOwner = this.stableIdOwners.get(stableId);
    if (existingOwner && existingOwner !== ownerChunkKey) {
      throw new Error(`Stable ID collision across ${existingOwner} and ${ownerChunkKey}: ${stableId}`);
    }
    this.stableIdOwners.set(stableId, ownerChunkKey);
  }

  async syncActiveChunks({ renderedKeys, getChunkData, renderOrigin } = {}) {
    if (this.isShutdown) throw new Error('gameplay runtime is shut down');
    if (!Array.isArray(renderedKeys) || typeof getChunkData !== 'function') {
      throw new TypeError('renderedKeys and getChunkData are required');
    }
    const desired = new Set(renderedKeys);
    for (const key of sorted(this.activeChunks.keys())) {
      if (desired.has(key)) continue;
      await this.renderAdapter.unloadChunk(key);
      this.activeChunks.delete(key);
      this.projectiles = this.projectiles.filter(projectile => projectile.ownerChunkKey !== key);
      this.counts.chunksUnloaded += 1;
    }
    for (const key of sorted(desired)) {
      if (this.activeChunks.has(key)) continue;
      const { chunkX, chunkZ } = parseChunkKey(key);
      const chunkData = getChunkData(chunkX, chunkZ);
      if (!chunkData) throw new Error(`missing W6 simulation ChunkData: ${key}`);
      const model = await createW6ChunkGameplay({
        chunkData,
        worldSeedHash: this.worldSeedHash,
        generatorMajor: this.generatorMajor,
      });
      for (const target of model.staticTargets) {
        this.#registerStableId(target.stableId, key);
        if (target.type === 'militaryBase') this.state.reconcileFeatureDamage?.(target);
      }
      const entityStates = model.entityDescriptors.map(descriptor => {
        this.#registerStableId(descriptor.stableId, key);
        const existed = this.state.entityStates.has(descriptor.stableId);
        const entityState = this.state.ensureEntity(descriptor);
        if (existed) this.counts.revisits += 1;
        return entityState;
      });
      this.activeChunks.set(key, model);
      await this.renderAdapter.loadChunk(key, entityStates);
      this.counts.chunksLoaded += 1;
    }
    if (this.activeChunks.size !== desired.size) throw new Error('gameplay active Chunk set mismatch');
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

  update({ deltaSeconds, player, simulationEnabled = true } = {}) {
    if (this.isShutdown) return;
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new TypeError('deltaSeconds must be non-negative');
    const boundedDelta = Math.min(deltaSeconds, 0.05);
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
    if (simulationEnabled !== true) {
      this.#syncTransientCombat();
      return;
    }
    for (const model of this.activeChunks.values()) {
      for (const descriptor of model.entityDescriptors) {
        const entity = this.state.entityStates.get(descriptor.stableId);
        if (!entity?.alive) continue;
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
        } else if (entity.type === 'tank') {
          this.#updateTank(entity, player, boundedDelta);
        } else if (entity.type === 'boss') {
          const contract = W6_ENTITY_CONTRACTS.boss;
          if (distance > finiteWorldUnitsToMeters(contract.approachDistance)) {
            entity.aiState = 'slither';
            const speed = entity.hp / entity.maxHp <= 0.5 ? contract.rageMoveSpeed : contract.moveSpeed;
            this.#moveToward(entity, player, finiteWorldFrameSpeedToMetersPerSecond(speed), boundedDelta);
          }
        }
        entity.aiClock += boundedDelta;
        if (entity.type !== 'tank') {
          this.renderAdapter.syncEntity(entity);
          this.counts.entityUpdates += 1;
        }
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
    for (const stableId of this.reinforcementIds) {
      this.#updateTank(this.state.entityStates.get(stableId), player, boundedDelta);
    }
    this.#maintainFiniteTankSpawns(player, boundedDelta);
    const bulletSpeed = finiteWorldFrameSpeedToMetersPerSecond(W7_CORE_COMBAT_CONTRACT.tank.bulletSpeed);
    const bulletHitRadius = finiteWorldUnitsToMeters(W7_CORE_COMBAT_CONTRACT.tank.bulletHitRadius);
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      const start = { x: projectile.x, z: projectile.z };
      const projectileSpeed = projectile.type === 'acid' ? bulletSpeed * (50 / 60) : bulletSpeed;
      projectile.x += projectile.directionX * projectileSpeed * boundedDelta;
      projectile.z += projectile.directionZ * projectileSpeed * boundedDelta;
      projectile.remainingSeconds -= boundedDelta;
      let blocked = false;
      if (projectile.type === 'tank-shell') {
        for (const model of this.activeChunks.values()) {
          const obstacle = model.staticTargets.find(target => target.type !== 'pebble'
            && !this.state.isFeatureDestroyed(target.stableId)
            && pointSegmentDistanceSquared(target, start, projectile)
              <= finiteWorldUnitsToMeters(target.radius) ** 2);
          if (!obstacle) continue;
          const damage = this.state.damageFeature(obstacle, W7_CORE_COMBAT_CONTRACT.tank.bulletDamage);
          if (damage.destroyed) this.featureRenderAdapter?.setFeatureDestroyed?.(obstacle.stableId, true);
          this.#emitCombatEffect({
            type: 'tank-impact', x: projectile.x, z: projectile.z,
            durationSeconds: 0.18, soundCue: 'hit',
          });
          blocked = true;
          break;
        }
      }
      const hit = !blocked && this.state.player.hp > 0 && pointSegmentDistanceSquared(
        this.state.player,
        start,
        projectile,
      ) <= bulletHitRadius ** 2;
      if (hit) {
        const wasAlive = this.state.player.hp > 0;
        this.state.damagePlayer(projectile.type === 'acid' ? 6 : W7_CORE_COMBAT_CONTRACT.tank.bulletDamage);
        this.#emitCombatEffect({
          type: projectile.type === 'acid' ? 'acid-impact' : 'tank-impact',
          x: projectile.x, z: projectile.z, durationSeconds: 0.18,
          cameraShake: W7_CORE_COMBAT_CONTRACT.tank.bulletCameraShake,
          soundCue: projectile.type === 'acid' ? 'acid' : 'hit',
        });
        this.counts.playerHits += 1;
        if (wasAlive && this.state.player.hp <= 0) this.counts.playerDeaths += 1;
      }
      if (blocked || hit || projectile.remainingSeconds <= 0) this.projectiles.splice(index, 1);
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
    for (const model of this.activeChunks.values()) {
      for (const target of model.staticTargets) {
        if (this.state.isFeatureDestroyed(target.stableId)
          || !canW6StageDamageTarget(this.state.activeScaleStageId, target)
          || !insideAttack(target)) continue;
        const beforeDestroyed = this.state.isFeatureDestroyed(target.stableId);
        const result = this.state.damageFeature(target, damage);
        if (!beforeDestroyed && result.destroyed) {
          this.counts.destroyedFeatures += 1;
          this.state.player.score += target.scoreValue;
          this.state.healPlayer(W7_CORE_COMBAT_CONTRACT.healing[target.type] ?? 0);
          this.featureRenderAdapter?.setFeatureDestroyed?.(target.stableId, true);
        }
        const building = W7_CORE_COMBAT_CONTRACT.building;
        const destroyedNow = !beforeDestroyed && result.destroyed;
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
      }
      for (const descriptor of model.entityDescriptors) {
        const entity = this.state.entityStates.get(descriptor.stableId);
        if (!entity?.alive
          || (entity.type === 'tank' && entity.spawned !== true)
          || !canW6StageDamageTarget(this.state.activeScaleStageId, entity)
          || !insideAttack(entity)) continue;
        const result = this.state.damageEntity(entity.stableId, damage);
        if (entity.type === 'human' && result.alive) entity.knockdownSeconds = 1.15;
        if (!result.alive) {
          this.counts.destroyedEntities += 1;
          this.state.player.score += descriptor.scoreValue;
          this.state.healPlayer(W7_CORE_COMBAT_CONTRACT.healing[entity.type] ?? 0);
        }
        this.#emitCombatEffect({
          type: result.alive ? 'entity-impact' : 'entity-destruction',
          x: entity.x,
          z: entity.z,
          durationSeconds: result.alive ? 0.16 : 0.45,
          cameraShake: damage / 7 * profile.stage.playerShakeMultiplier,
          soundCue: result.alive ? 'hit' : 'splat',
        });
        this.renderAdapter.syncEntity(this.state.entityStates.get(entity.stableId));
        hits.push(Object.freeze({ stableId: entity.stableId, type: entity.type, destroyed: !result.alive }));
      }
    }
    const manualBoss = this.state.manualBossStableId
      ? this.state.entityStates.get(this.state.manualBossStableId)
      : null;
    if (manualBoss?.alive
      && canW6StageDamageTarget(this.state.activeScaleStageId, manualBoss)
      && insideAttack(manualBoss)) {
      const result = this.state.damageEntity(manualBoss.stableId, damage);
      this.#syncBossDamageStage(manualBoss);
      if (!result.alive) {
        this.counts.destroyedEntities += 1;
        this.state.player.score += W6_ENTITY_CONTRACTS.boss.scoreValue;
        this.state.updateCombatProgress({
          bossesDefeated: this.state.combatProgress.bossesDefeated + 1,
          nextBossScore: this.state.player.score + W8_BOSS_CONTRACT.nextSpawnScoreDelta,
        });
      }
      this.#emitCombatEffect({
        type: result.alive ? 'entity-impact' : 'entity-destruction',
        x: manualBoss.x,
        z: manualBoss.z,
        durationSeconds: result.alive ? 0.16 : 0.8,
        cameraShake: damage / 7 * profile.stage.playerShakeMultiplier,
        soundCue: result.alive ? 'hit' : 'roar',
      });
      this.renderAdapter.syncManualBoss?.(manualBoss);
      hits.push(Object.freeze({
        stableId: manualBoss.stableId,
        type: 'boss',
        destroyed: !result.alive,
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
      const wasDestroyed = this.state.isFeatureDestroyed(target.stableId);
      const damaged = this.state.damageFeature(target, W7_NUCLEAR_CONTRACT.damageAmount);
      if (!wasDestroyed && damaged.destroyed) {
        this.state.player.score += target.scoreValue;
        this.state.healPlayer(W7_CORE_COMBAT_CONTRACT.healing[target.type] ?? 0);
        this.counts.destroyedFeatures += 1;
      }
      hitStableIds.push(target.stableId);
    }
    for (const descriptor of [...entityDescriptors.values()].sort((a, b) => a.stableId.localeCompare(b.stableId))) {
      const entity = this.state.ensureEntity(descriptor);
      if (!entity.alive || (entity.type === 'tank' && entity.spawned !== true) || !inside(entity)) continue;
      const damaged = this.state.damageEntity(entity.stableId, W7_NUCLEAR_CONTRACT.damageAmount);
      if (!damaged.alive) {
        this.state.player.score += descriptor.scoreValue;
        this.state.healPlayer(W7_CORE_COMBAT_CONTRACT.healing[entity.type] ?? 0);
        this.counts.destroyedEntities += 1;
      }
      this.renderAdapter.syncEntity(entity);
      hitStableIds.push(entity.stableId);
    }
    const manualBoss = this.state.manualBossStableId
      ? this.state.entityStates.get(this.state.manualBossStableId)
      : null;
    if (manualBoss?.alive && inside(manualBoss) && !hitStableIds.includes(manualBoss.stableId)) {
      const damaged = this.state.damageEntity(manualBoss.stableId, W7_NUCLEAR_CONTRACT.damageAmount);
      if (!damaged.alive) {
        this.state.player.score += W6_ENTITY_CONTRACTS.boss.scoreValue;
        this.counts.destroyedEntities += 1;
        this.state.updateCombatProgress({
          bossesDefeated: this.state.combatProgress.bossesDefeated + 1,
          nextBossScore: this.state.player.score + W8_BOSS_CONTRACT.nextSpawnScoreDelta,
        });
      }
      this.renderAdapter.syncManualBoss?.(manualBoss);
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
    this.projectiles.length = 0;
    this.combatEffects.length = 0;
    this.presentationEvents.length = 0;
    this.pendingCameraShake = 0;
    this.hitStopUntil = -Infinity;
    this.playerKnockback = { x: 0, z: 0, decayPerFrame: 0.85 };
    this.lastAttackAt = -Infinity;
    for (const entity of this.state.entityStates.values()) {
      if (entity.type !== 'tank' || entity.spawned !== true || !entity.alive) continue;
      entity.aiState = 'acquire';
      entity.lastShotAtMs = this.state.gameplayTimeMs;
      entity.stuckCheckClock = 0;
      entity.stuckRemainingSeconds = 0;
      this.#syncTank(entity);
    }
    this.#syncTransientCombat();
    return this.snapshot();
  }

  async restart({ playerSpawn, renderOrigin } = {}) {
    this.state.restartRun({ playerSpawn });
    this.projectiles.length = 0;
    this.combatEffects.length = 0;
    this.presentationEvents.length = 0;
    this.pendingCameraShake = 0;
    this.hitStopUntil = -Infinity;
    this.playerKnockback = { x: 0, z: 0, decayPerFrame: 0.85 };
    this.reinforcementIds.clear();
    this.tankSpawnFrameAccumulator = 0;
    this.tankSpawnFrame = 0;
    this.renderAdapter.clearReinforcements?.();
    this.lastAttackAt = -Infinity;
    this.counts.restarts += 1;
    await this.refreshFromState({ renderOrigin });
    this.#syncTransientCombat();
    return this.snapshot();
  }

  damageStableId(stableId, amount) {
    for (const model of this.activeChunks.values()) {
      const target = model.staticTargets.find(value => value.stableId === stableId);
      if (target) {
        const result = this.state.damageFeature(target, amount);
        if (result.destroyed) this.featureRenderAdapter?.setFeatureDestroyed?.(stableId, true);
        return result;
      }
      const descriptor = model.entityDescriptors.find(value => value.stableId === stableId);
      if (descriptor) {
        const result = this.state.damageEntity(stableId, amount);
        this.renderAdapter.syncEntity(this.state.entityStates.get(stableId));
        return result;
      }
    }
    throw new Error(`Stable ID is not active: ${stableId}`);
  }

  async refreshFromState({ renderOrigin } = {}) {
    const activeModels = [...this.activeChunks.entries()];
    for (const [key] of activeModels) await this.renderAdapter.unloadChunk(key);
    for (const [key, model] of activeModels) {
      const states = model.entityDescriptors.map(descriptor => this.state.ensureEntity(descriptor));
      await this.renderAdapter.loadChunk(key, states);
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
    const activeTankCount = [...this.state.entityStates.values()]
      .filter(entity => entity.type === 'tank' && entity.alive && entity.spawned === true
        && this.activeChunks.has(entity.ownerChunkKey)).length;
    return Object.freeze({
      schemaVersion: 'w6-infinite-gameplay-runtime-1',
      activeSimulationChunkCount: this.activeChunks.size,
      activeSimulationChunkKeys: Object.freeze(sorted(this.activeChunks.keys())),
      simulatedEntityCount,
      simulatedStaticTargetCount,
      activeTankCount,
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
    await this.renderAdapter.shutdown();
    this.activeChunks.clear();
    this.stableIdOwners.clear();
    this.projectiles.length = 0;
    this.combatEffects.length = 0;
    this.renderAdapter.syncManualBoss?.(null);
    this.#syncTransientCombat();
    this.isShutdown = true;
  }
}
