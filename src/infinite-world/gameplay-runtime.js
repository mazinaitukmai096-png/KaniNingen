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
  canW6StageDamageTarget,
  finiteWorldFrameSpeedToMetersPerSecond,
  finiteWorldUnitsToMeters,
  getW6ScaleProfile,
} from './gameplay-contract.js';
import { createDeterministicRandom, deriveLocalSeed64 } from './legacy-core/g0/deterministic-random.js';
import { createWorldFeatureId } from './legacy-core/g0/stable-id.js';

const EPSILON_METERS = 0.05;

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

function ownerContains(ownerChunkKey, x, z) {
  return logicalWorldToOwnedChunk(x, z).key === ownerChunkKey;
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
  const isBoss = reference.settlementType === 'CITY';
  if (!isTank && !isBoss) return null;
  const owner = logicalWorldToOwnedChunk(reference.center.x, reference.center.z);
  if (owner.chunkX !== chunkData.chunkX || owner.chunkZ !== chunkData.chunkZ) return null;
  const type = isBoss ? 'boss' : 'tank';
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
    aiState: type === 'boss' ? 'slither' : 'engage',
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
    clock = () => globalThis.performance?.now?.() ?? Date.now(),
  } = {}) {
    if (typeof worldSeedHash !== 'string' || !worldSeedHash) throw new TypeError('worldSeedHash is required');
    if (!Number.isSafeInteger(generatorMajor) || generatorMajor < 0) throw new TypeError('generatorMajor is required');
    if (!state || typeof state.ensureEntity !== 'function') throw new TypeError('InfiniteWorldState is required');
    for (const method of ['rebase', 'loadChunk', 'syncEntity', 'unloadChunk', 'snapshot', 'shutdown']) {
      if (typeof renderAdapter?.[method] !== 'function') throw new TypeError(`gameplay renderAdapter.${method} is required`);
    }
    this.worldSeedHash = worldSeedHash;
    this.generatorMajor = generatorMajor;
    this.state = state;
    this.renderAdapter = renderAdapter;
    this.featureRenderAdapter = featureRenderAdapter;
    this.clock = clock;
    this.activeChunks = new Map();
    this.stableIdOwners = new Map();
    this.lastAttackAt = -Infinity;
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
    };
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
    this.state.updatePlayer({ x: player.x, z: player.z });
    const boundedDelta = Math.min(deltaSeconds, 0.05);
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
    this.counts.simulationTicks += 1;
  }

  attack(mode = 'single', now = this.clock()) {
    if (!['single', 'double'].includes(mode)) throw new RangeError('attack mode must be single or double');
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
          this.featureRenderAdapter?.setFeatureDestroyed?.(target.stableId, true);
        }
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
        }
        this.renderAdapter.syncEntity(this.state.entityStates.get(entity.stableId));
        hits.push(Object.freeze({ stableId: entity.stableId, type: entity.type, destroyed: !result.alive }));
      }
    }
    return Object.freeze({ accepted: true, mode, damage, radiusMeters: radius, hits: Object.freeze(hits) });
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
    this.isShutdown = true;
  }
}
