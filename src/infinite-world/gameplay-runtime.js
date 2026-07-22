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
  const owner = logicalWorldToOwnedChunk(reference.center.x, reference.center.z);
  if (owner.chunkX !== chunkData.chunkX || owner.chunkZ !== chunkData.chunkZ) return null;
  const type = 'tank';
  const contract = W6_ENTITY_CONTRACTS[type];
  const result = await entityStableId({
    worldSeedHash,
    generatorMajor,
    featureType: type,
    parentStableId: reference.settlementId,
    purposeKey: `w6-${type}-encounter`,
  });
  return Object.freeze({
    stableId: result.stableId,
    canonicalInput: result.canonicalInput,
    ownerChunkKey: owner.key,
    type,
    maxHp: contract.maxHp,
    radius: contract.radius,
    scoreValue: contract.scoreValue,
    x: reference.center.x,
    z: reference.center.z,
    rotationY: 0,
    aiState: 'engage',
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
    this.combatSequence = 0;
    this.pendingCameraShake = 0;
    this.hitStopUntil = -Infinity;
    this.playerKnockback = { x: 0, z: 0, decayPerFrame: 0.85 };
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

  #emitCombatEffect({ type, x, z, durationSeconds, cameraShake = 0, hitStopMs = 0 }) {
    const effect = {
      id: `combat-effect:${++this.combatSequence}`,
      type,
      x: q6(x),
      z: q6(z),
      remainingSeconds: durationSeconds,
    };
    this.combatEffects.push(effect);
    this.pendingCameraShake = Math.max(this.pendingCameraShake, cameraShake);
    if (hitStopMs > 0) this.hitStopUntil = Math.max(this.hitStopUntil, this.clock() + hitStopMs);
    this.counts.combatEffects += 1;
    return effect;
  }

  #syncTransientCombat() {
    this.renderAdapter.syncTransientCombat?.(this.projectiles, this.combatEffects);
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
      for (const target of model.staticTargets) this.#registerStableId(target.stableId, key);
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

  update({ deltaSeconds, player } = {}) {
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
    this.state.tickNuclearCooldown(boundedDelta * 1000);
    for (const model of this.activeChunks.values()) {
      for (const descriptor of model.entityDescriptors) {
        const entity = this.state.entityStates.get(descriptor.stableId);
        if (!entity?.alive) continue;
        const distance = Math.sqrt(distanceSquared(entity, player));
        if (entity.type === 'human') {
          const contract = W6_ENTITY_CONTRACTS.human;
          if (distance < finiteWorldUnitsToMeters(contract.fleeRange)) {
            entity.aiState = 'flee';
            this.#moveToward(entity, player,
              finiteWorldFrameSpeedToMetersPerSecond(contract.fleeSpeed), boundedDelta, true);
          } else {
            entity.aiState = 'idle';
            entity.x += Math.sin(entity.rotationY) * finiteWorldFrameSpeedToMetersPerSecond(contract.idleSpeed) * boundedDelta;
            entity.z += Math.cos(entity.rotationY) * finiteWorldFrameSpeedToMetersPerSecond(contract.idleSpeed) * boundedDelta;
            clampToOwner(entity);
          }
        } else if (entity.type === 'tank') {
          const contract = W6_ENTITY_CONTRACTS.tank;
          if (distance <= finiteWorldUnitsToMeters(contract.engageRange)
            && distance > finiteWorldUnitsToMeters(contract.approachDistance)) {
            entity.aiState = 'engage';
            this.#moveToward(entity, player,
              finiteWorldFrameSpeedToMetersPerSecond(contract.moveSpeed), boundedDelta);
          } else entity.aiState = 'hold';
          const combat = W7_CORE_COMBAT_CONTRACT.tank;
          const intervalSeconds = Math.max(
            combat.fireIntervalMinimumMs,
            combat.fireIntervalBaseMs - this.state.player.score * combat.fireIntervalScoreDivisor,
          ) / 1000;
          const nextAiClock = entity.aiClock + boundedDelta;
          if (distance <= finiteWorldUnitsToMeters(contract.engageRange)
            && Math.floor(nextAiClock / intervalSeconds) > Math.floor(entity.aiClock / intervalSeconds)) {
            const dx = player.x - entity.x;
            const dz = player.z - entity.z;
            const length = Math.hypot(dx, dz);
            if (length > 1e-9) {
              this.projectiles.push({
                id: `${entity.stableId}:shot:${Math.floor(nextAiClock / intervalSeconds)}`,
                ownerChunkKey: entity.ownerChunkKey,
                x: entity.x,
                z: entity.z,
                directionX: dx / length,
                directionZ: dz / length,
                remainingSeconds: combat.bulletLifeFrames / 60,
              });
              this.counts.tankShots += 1;
            }
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
      const cycleSeconds = bossCombat.slitherDurationSeconds + bossCombat.chargeDurationSeconds;
      const cycleTime = manualBoss.aiClock % cycleSeconds;
      const charging = cycleTime >= bossCombat.slitherDurationSeconds;
      const rage = manualBoss.hp / manualBoss.maxHp <= 0.5;
      manualBoss.aiState = charging ? 'charge' : 'slither';
      if (charging || distance > finiteWorldUnitsToMeters(contract.approachDistance)) {
        let dx = player.x - manualBoss.x;
        let dz = player.z - manualBoss.z;
        const length = Math.hypot(dx, dz);
        if (length > 1e-9) {
          dx /= length;
          dz /= length;
          const speed = charging
            ? (rage ? bossCombat.chargeSpeedRage : bossCombat.chargeSpeed)
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
    const bulletSpeed = finiteWorldFrameSpeedToMetersPerSecond(W7_CORE_COMBAT_CONTRACT.tank.bulletSpeed);
    const bulletHitRadius = finiteWorldUnitsToMeters(W7_CORE_COMBAT_CONTRACT.tank.bulletHitRadius);
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      const start = { x: projectile.x, z: projectile.z };
      projectile.x += projectile.directionX * bulletSpeed * boundedDelta;
      projectile.z += projectile.directionZ * bulletSpeed * boundedDelta;
      projectile.remainingSeconds -= boundedDelta;
      const hit = this.state.player.hp > 0 && pointSegmentDistanceSquared(
        this.state.player,
        start,
        projectile,
      ) <= bulletHitRadius ** 2;
      if (hit) {
        const wasAlive = this.state.player.hp > 0;
        this.state.damagePlayer(W7_CORE_COMBAT_CONTRACT.tank.bulletDamage);
        this.#emitCombatEffect({
          type: 'tank-impact', x: projectile.x, z: projectile.z, durationSeconds: 0.18,
          cameraShake: W7_CORE_COMBAT_CONTRACT.tank.bulletCameraShake,
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

  attack(mode = 'single', now = this.clock()) {
    if (!['single', 'double'].includes(mode)) throw new RangeError('attack mode must be single or double');
    if (this.state.player.hp <= 0) {
      return Object.freeze({ accepted: false, reason: 'player-dead', hits: Object.freeze([]) });
    }
    if (now - this.lastAttackAt < W6_ATTACK_CONTRACT.cooldownMs) {
      this.counts.attackCooldownRejected += 1;
      return Object.freeze({ accepted: false, hits: Object.freeze([]) });
    }
    this.lastAttackAt = now;
    this.counts.attacks += 1;
    const profile = getW6ScaleProfile(this.state.activeScaleStageId);
    const radius = mode === 'single' ? profile.singleAttackRadiusMeters : profile.doubleAttackRadiusMeters;
    const damage = mode === 'single' ? W6_ATTACK_CONTRACT.singleDamage : W6_ATTACK_CONTRACT.doubleDamage;
    const facingY = this.state.player.facingY;
    const attackCenters = (mode === 'single' ? [1] : [1, -1]).map(side => {
      const offsetX = profile.attackOffsetXMeters * side;
      const offsetZ = profile.attackOffsetZMeters;
      return {
        x: this.state.player.x + offsetX * Math.cos(facingY) + offsetZ * Math.sin(facingY),
        z: this.state.player.z + offsetZ * Math.cos(facingY) - offsetX * Math.sin(facingY),
      };
    });
    const insideAttack = target => attackCenters.some(center => distanceSquared(target, center) <= radius ** 2);
    const hits = [];
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
        });
        hits.push(Object.freeze({ stableId: target.stableId, type: target.type, destroyed: result.destroyed }));
      }
      for (const descriptor of model.entityDescriptors) {
        const entity = this.state.entityStates.get(descriptor.stableId);
        if (!entity?.alive
          || !canW6StageDamageTarget(this.state.activeScaleStageId, entity)
          || !insideAttack(entity)) continue;
        const result = this.state.damageEntity(entity.stableId, damage);
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
      if (!result.alive) {
        this.counts.destroyedEntities += 1;
        this.state.player.score += W6_ENTITY_CONTRACTS.boss.scoreValue;
      }
      this.#emitCombatEffect({
        type: result.alive ? 'entity-impact' : 'entity-destruction',
        x: manualBoss.x,
        z: manualBoss.z,
        durationSeconds: result.alive ? 0.16 : 0.8,
        cameraShake: damage / 7 * profile.stage.playerShakeMultiplier,
      });
      this.renderAdapter.syncManualBoss?.(manualBoss);
      hits.push(Object.freeze({
        stableId: manualBoss.stableId,
        type: 'boss',
        destroyed: !result.alive,
      }));
    }
    this.#syncTransientCombat();
    return Object.freeze({ accepted: true, mode, damage, radiusMeters: radius, hits: Object.freeze(hits) });
  }

  async spawnManualBoss() {
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
      purposeKey: `w7-manual-boss:${sequence}`,
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
    this.renderAdapter.syncManualBoss?.(boss);
    this.counts.manualBossSpawns += 1;
    return Object.freeze({
      accepted: true,
      stableId: boss.stableId,
      sequence,
      spawnDistanceMeters,
      ownerChunkKey,
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
      if (!entity.alive || !inside(entity)) continue;
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
      }
      this.renderAdapter.syncManualBoss?.(manualBoss);
      hitStableIds.push(manualBoss.stableId);
    }
    hitStableIds.sort((a, b) => a.localeCompare(b));
    this.state.setNuclearCooldown(W7_NUCLEAR_CONTRACT.cooldownMs);
    this.#emitCombatEffect({
      type: 'nuclear-destruction', x, z, durationSeconds: 2.2,
      cameraShake: W7_NUCLEAR_CONTRACT.cameraShake,
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
    const result = Object.freeze({ cameraShake: this.pendingCameraShake });
    this.pendingCameraShake = 0;
    return result;
  }

  async restart({ playerSpawn, renderOrigin } = {}) {
    this.state.restartRun({ playerSpawn });
    this.projectiles.length = 0;
    this.combatEffects.length = 0;
    this.pendingCameraShake = 0;
    this.hitStopUntil = -Infinity;
    this.playerKnockback = { x: 0, z: 0, decayPerFrame: 0.85 };
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
    return Object.freeze({
      schemaVersion: 'w6-infinite-gameplay-runtime-1',
      activeSimulationChunkCount: this.activeChunks.size,
      activeSimulationChunkKeys: Object.freeze(sorted(this.activeChunks.keys())),
      simulatedEntityCount,
      simulatedStaticTargetCount,
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
