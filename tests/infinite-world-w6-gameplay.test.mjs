import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  INITIAL_SCALE_STAGE_ID,
  SCALE_STAGES,
} from '../src/scale-sandbox.js';
import {
  ATTACK_COOLDOWN,
  BOSS_HP,
  BOSS_RADIUS,
  BOSS_SCORE_VALUE,
  PLAYER_MAX_HP,
  TANK_HP,
  TANK_RADIUS,
  TANK_SCORE_VALUE,
} from '../src/constants.js';
import {
  PRODUCTION_HUMAN_VISUAL_SCALE,
  PRODUCTION_TANK_VISUAL_SCALE,
} from '../src/world-scale-rebalance.js';
import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import {
  W6_ATTACK_CONTRACT,
  W6_ENTITY_CONTRACTS,
  W6_INITIAL_SCALE_STAGE_ID,
  getW6ScaleProfile,
} from '../src/infinite-world/gameplay-contract.js';
import {
  InfiniteGameplayRuntime,
  createW6ChunkGameplay,
} from '../src/infinite-world/gameplay-runtime.js';
import {
  createChunkKey,
  logicalWorldToOwnedChunk,
  squareChunkCoordinates,
} from '../src/infinite-world/chunk-coordinates.js';
import {
  InfiniteWorldSaveStore,
  InfiniteWorldState,
  decodeInfiniteWorldSave,
} from '../src/infinite-world/world-state-store.js';

const repoRoot = resolve(import.meta.dirname, '..');

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

class FakeGameplayRenderer {
  constructor() {
    this.loaded = new Map();
    this.liveEntities = new Map();
    this.disposed = false;
    this.counts = { loaded: 0, unloaded: 0, rebased: 0 };
  }
  async rebase(origin) { this.origin = { ...origin }; this.counts.rebased += 1; }
  async loadChunk(key, states) {
    assert.equal(this.loaded.has(key), false);
    this.loaded.set(key, new Set(states.map(state => state.stableId)));
    for (const state of states) this.liveEntities.set(state.stableId, { ...state });
    this.counts.loaded += 1;
  }
  syncEntity(state) {
    if (!this.liveEntities.has(state.stableId)) return false;
    this.liveEntities.set(state.stableId, { ...state });
    return true;
  }
  async unloadChunk(key) {
    for (const stableId of this.loaded.get(key) ?? []) this.liveEntities.delete(stableId);
    this.loaded.delete(key);
    this.counts.unloaded += 1;
  }
  snapshot() {
    return {
      liveChunkGroups: this.loaded.size,
      liveEntityMeshes: this.liveEntities.size,
      sharedDisposed: this.disposed,
      counts: { ...this.counts },
    };
  }
  async shutdown() {
    this.loaded.clear();
    this.liveEntities.clear();
    this.disposed = true;
  }
}

function fakeFeatureRenderer() {
  return {
    destroyed: new Set(),
    refreshCount: 0,
    setFeatureDestroyed(stableId, destroyed) {
      if (destroyed) this.destroyed.add(stableId);
      else this.destroyed.delete(stableId);
      return true;
    },
    refreshFeatureStates() { this.refreshCount += 1; },
  };
}

async function generateSquare(generator, centerChunkX, centerChunkZ) {
  const chunks = new Map();
  await Promise.all(squareChunkCoordinates(centerChunkX, centerChunkZ, 1).map(async coordinate => {
    chunks.set(coordinate.key, await generator.generateChunk(coordinate.chunkX, coordinate.chunkZ));
  }));
  return chunks;
}

function runtimeInput(chunks, centerChunkX, centerChunkZ) {
  return {
    renderedKeys: squareChunkCoordinates(centerChunkX, centerChunkZ, 1).map(value => value.key),
    getChunkData: (chunkX, chunkZ) => chunks.get(createChunkKey(chunkX, chunkZ)) ?? null,
    renderOrigin: { renderOriginChunkX: centerChunkX, renderOriginChunkZ: centerChunkZ },
  };
}

function syntheticMilitaryBase({
  stableId,
  parentSettlementId,
  worldPosition,
  rotationY,
  chunkX = 0,
  chunkZ = 0,
}) {
  return {
    schemaVersion: 'w8-settlement-landmark-1',
    stableId,
    parentSettlementId,
    settlementType: 'RURAL',
    townType: 'military',
    landmarkType: 'militaryBase',
    worldPosition: { ...worldPosition },
    rotationY,
    widthMeters: 11,
    heightMeters: 6,
    depthMeters: 11,
    destructible: true,
    owningChunkCoordinate: { x: chunkX, z: chunkZ },
    logicalLocal: {
      x: worldPosition.x - chunkX * 16,
      z: worldPosition.z - chunkZ * 16,
    },
  };
}

test('W6 imports the protected Tiny/Mid/Max and Max Gameplay contracts without changing their values', () => {
  assert.equal(W6_INITIAL_SCALE_STAGE_ID, INITIAL_SCALE_STAGE_ID);
  assert.equal(W6_INITIAL_SCALE_STAGE_ID, 'MAX');
  assert.equal(W6_ATTACK_CONTRACT.cooldownMs, ATTACK_COOLDOWN);
  assert.equal(W6_ATTACK_CONTRACT.singleDamage, 550);
  assert.equal(W6_ATTACK_CONTRACT.doubleDamage, 650);
  assert.equal(W6_ENTITY_CONTRACTS.human.visualScale, PRODUCTION_HUMAN_VISUAL_SCALE);
  assert.deepEqual(W6_ENTITY_CONTRACTS.tank, {
    type: 'tank', maxHp: TANK_HP, radius: TANK_RADIUS, scoreValue: TANK_SCORE_VALUE,
    visualScale: PRODUCTION_TANK_VISUAL_SCALE, moveSpeed: 12, approachDistance: 1200,
    engageRange: 5000, despawnDistance: 6500,
  });
  assert.equal(W6_ENTITY_CONTRACTS.boss.maxHp, BOSS_HP);
  assert.equal(W6_ENTITY_CONTRACTS.boss.radius, BOSS_RADIUS);
  assert.equal(W6_ENTITY_CONTRACTS.boss.scoreValue, BOSS_SCORE_VALUE);
  assert.equal(getW6ScaleProfile('MAX').stage, SCALE_STAGES.MAX);
  assert.equal(getW6ScaleProfile('MAX').movementMetersPerSecond, 33);
  assert.equal(getW6ScaleProfile('MAX').singleAttackRadiusMeters, 8.75);
});

test('W6 deterministic Chunk gameplay preserves W5 ChunkData, hash, and Stable IDs', async () => {
  const generator = await createDistributedSettlementChunkGenerator({ worldSeed: 'W6 descriptor determinism' });
  const centerChunkX = Math.floor(generator.reviewSpawn.x / 16);
  const centerChunkZ = Math.floor(generator.reviewSpawn.z / 16);
  const chunk = await generator.generateChunk(centerChunkX, centerChunkZ);
  const before = structuredClone(chunk);
  const input = {
    chunkData: chunk,
    worldSeedHash: generator.worldSeedHash,
    generatorMajor: generator.generatorVersion.major,
  };
  const first = await createW6ChunkGameplay(input);
  const second = await createW6ChunkGameplay(input);
  assert.deepEqual(first, second);
  assert.deepEqual(chunk, before);
  assert.equal(chunk.contentHash, before.contentHash);
  assert.equal(first.entityDescriptors.every(value => value.stableId.startsWith(`wf1:${value.type}:`)), true);
  const ids = [...first.entityDescriptors, ...first.staticTargets].map(value => value.stableId);
  assert.equal(new Set(ids).size, ids.length);
});

test('only the rendered 3x3 Chunk set simulates and unload/revisit restores destruction and entities', async () => {
  const generator = await createDistributedSettlementChunkGenerator({ worldSeed: 'W6 lifecycle persistence' });
  const centerX = Math.floor(generator.reviewSpawn.x / 16);
  const centerZ = Math.floor(generator.reviewSpawn.z / 16);
  const firstChunks = await generateSquare(generator, centerX, centerZ);
  const secondChunks = await generateSquare(generator, centerX + 3, centerZ);
  const allChunks = new Map([...firstChunks, ...secondChunks]);
  const state = new InfiniteWorldState({ worldSeedHash: generator.worldSeedHash, playerSpawn: generator.reviewSpawn });
  const renderer = new FakeGameplayRenderer();
  const featureRenderer = fakeFeatureRenderer();
  const runtime = new InfiniteGameplayRuntime({
    worldSeedHash: generator.worldSeedHash,
    generatorMajor: generator.generatorVersion.major,
    state,
    renderAdapter: renderer,
    featureRenderAdapter: featureRenderer,
  });

  await runtime.syncActiveChunks(runtimeInput(allChunks, centerX, centerZ));
  assert.equal(runtime.snapshot().activeSimulationChunkCount, 9);
  assert.equal(runtime.snapshot().activeSimulationChunkKeys.length, 9);
  assert.equal(renderer.snapshot().liveChunkGroups, 9);
  const model = [...runtime.activeChunks.values()].find(value => value.staticTargets.length && value.entityDescriptors.length)
    ?? [...runtime.activeChunks.values()].find(value => value.staticTargets.length);
  assert.ok(model);
  const target = model.staticTargets[0];
  runtime.damageStableId(target.stableId, target.maxHp);
  assert.equal(state.isFeatureDestroyed(target.stableId), true);
  const entityDescriptor = [...runtime.activeChunks.values()].flatMap(value => value.entityDescriptors)[0];
  assert.ok(entityDescriptor, 'review Settlement must materialize a Human');
  runtime.damageStableId(entityDescriptor.stableId, 10);
  const savedEntity = { ...state.entityStates.get(entityDescriptor.stableId) };

  await runtime.syncActiveChunks(runtimeInput(allChunks, centerX + 3, centerZ));
  assert.equal(runtime.snapshot().activeSimulationChunkCount, 9);
  assert.equal(renderer.snapshot().liveChunkGroups, 9);
  await runtime.syncActiveChunks(runtimeInput(allChunks, centerX, centerZ));
  assert.equal(state.isFeatureDestroyed(target.stableId), true);
  assert.deepEqual(state.entityStates.get(entityDescriptor.stableId), savedEntity);
  assert.equal(renderer.snapshot().liveChunkGroups, 9);
  assert.equal(featureRenderer.refreshCount, 3);

  await runtime.shutdown();
  assert.equal(renderer.snapshot().liveChunkGroups, 0);
  assert.equal(renderer.snapshot().liveEntityMeshes, 0);
  assert.equal(renderer.snapshot().sharedDisposed, true);
});

test('Human and Tank use deterministic Stable IDs while W7D excludes natural Boss descriptors', async () => {
  const generator = await createDistributedSettlementChunkGenerator({ worldSeed: 'W6 entity types' });
  const militaryBase = syntheticMilitaryBase({
    stableId: 'wf1:settlement-landmark:4f78c17144582be88b122cce58f06c08',
    parentSettlementId: 'settlement-v1:test-military',
    worldPosition: { x: 3.25, y: 1.75, z: 11.5 },
    rotationY: 0.625,
  });
  const chunkData = {
    chunkX: 0,
    chunkZ: 0,
    vegetationCandidates: [],
    rockCandidates: [],
    settlementFeatures: [{
      stableId: 'settlement-building-v1:test-house',
      featureType: 'settlement-building',
      buildingType: 'house',
      radiusMeters: 2,
      worldPosition: { x: 4, y: 0, z: 4 },
      owningChunkCoordinate: { x: 0, z: 0 },
    }],
    settlementReferences: [{
      settlementId: 'settlement-v1:test-military', townType: 'military', settlementType: 'RURAL', center: { x: 8, z: 8 },
    }, {
      settlementId: 'settlement-v1:test-city', townType: 'capital', settlementType: 'CITY', center: { x: 9, z: 9 },
    }],
    settlementLandmarks: [militaryBase],
  };
  const model = await createW6ChunkGameplay({
    chunkData,
    worldSeedHash: generator.worldSeedHash,
    generatorMajor: generator.generatorVersion.major,
  });
  assert.deepEqual(model.entityDescriptors.map(value => value.type).sort(), ['human', 'tank']);
  assert.equal(model.entityDescriptors.every(value => value.ownerChunkKey === '0,0'), true);
  assert.equal(model.entityDescriptors.every(value => value.stableId.startsWith(`wf1:${value.type}:`)), true);
  const tank = model.entityDescriptors.find(value => value.type === 'tank');
  assert.equal(tank.stableId, 'wf1:tank:98a5c14ed33ac2dccc75eccd200d280f');
  assert.equal(tank.canonicalInput,
    '{"featureType":"tank","generatorMajor":500,"parentStableId":"settlement-v1:test-military",'
    + '"purposeKey":"w6-tank-encounter","semanticLocalKey":"ordinal:0","stableIdSchema":"wf1",'
    + '"worldSeedHash":"sha256:c921781ff04701f358e86852ce255ce72608c818f88d3e5d2d4e961c51f59006"}');
  assert.deepEqual({
    baseStableId: tank.baseStableId,
    x: tank.x,
    y: tank.baseY,
    z: tank.z,
    rotationY: tank.rotationY,
    ownerChunkKey: tank.ownerChunkKey,
    baseX: tank.baseX,
    baseZ: tank.baseZ,
    baseOwnerChunkKey: tank.baseOwnerChunkKey,
  }, {
    baseStableId: militaryBase.stableId,
    x: militaryBase.worldPosition.x,
    y: militaryBase.worldPosition.y,
    z: militaryBase.worldPosition.z,
    rotationY: militaryBase.rotationY,
    ownerChunkKey: '0,0',
    baseX: militaryBase.worldPosition.x,
    baseZ: militaryBase.worldPosition.z,
    baseOwnerChunkKey: '0,0',
  });
  assert.notDeepEqual({ x: tank.x, z: tank.z }, chunkData.settlementReferences[0].center);

  const regenerated = await createW6ChunkGameplay({
    chunkData: structuredClone(chunkData),
    worldSeedHash: generator.worldSeedHash,
    generatorMajor: generator.generatorVersion.major,
  });
  assert.deepEqual(regenerated.entityDescriptors.find(value => value.type === 'tank'), tank);

  const state = new InfiniteWorldState({ worldSeedHash: generator.worldSeedHash, playerSpawn: { x: 4, z: 4 } });
  const runtime = new InfiniteGameplayRuntime({
    worldSeedHash: generator.worldSeedHash,
    generatorMajor: generator.generatorVersion.major,
    state,
    renderAdapter: new FakeGameplayRenderer(),
    featureRenderAdapter: fakeFeatureRenderer(),
  });
  const activeInput = {
    renderedKeys: ['0,0'],
    getChunkData: () => chunkData,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  };
  await runtime.syncActiveChunks(activeInput);
  const beforeRevisit = { ...state.entityStates.get(tank.stableId) };
  await runtime.syncActiveChunks({ ...activeInput, renderedKeys: [], getChunkData: () => null });
  await runtime.syncActiveChunks(activeInput);
  assert.deepEqual(state.entityStates.get(tank.stableId), beforeRevisit);
  assert.deepEqual(runtime.activeChunks.get('0,0').entityDescriptors.find(value => value.type === 'tank'), tank);
  await runtime.shutdown();
});

test('real W5 military through W8 parity materializes Tank while capital no longer materializes a natural Boss', async () => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: 'W8 parity golden seed' });
  const candidates = await generator.distributor.findInMacroRange(-8, 8, -8, 8);
  for (const [townType, expectedEntityType] of [['military', 'tank']]) {
    const candidate = candidates.find(value => value.townType === townType);
    assert.ok(candidate, `${townType} candidate must exist in the deterministic fixture`);
    const owner = logicalWorldToOwnedChunk(candidate.center.x, candidate.center.z);
    const chunkData = await generator.generateChunk(owner.chunkX, owner.chunkZ);
    assert.equal(chunkData.sourceChunkData.contentHash, chunkData.sourceW5ContentHash);
    assert.ok(chunkData.settlementLandmarks.some(value => value.landmarkType === 'militaryBase'
      && value.parentSettlementId === candidate.settlementId));
    const model = await createW6ChunkGameplay({
      chunkData,
      worldSeedHash: generator.worldSeedHash,
      generatorMajor: generator.generatorVersion.major,
    });
    const entity = model.entityDescriptors.find(value => value.type === expectedEntityType);
    assert.ok(entity, `${expectedEntityType} must materialize in the Settlement center owner Chunk`);
    assert.equal(entity.ownerChunkKey, owner.key);
    assert.equal(entity.stableId.startsWith(`wf1:${expectedEntityType}:`), true);
  }
  const capital = candidates.find(value => value.townType === 'capital');
  assert.ok(capital);
  const capitalOwner = logicalWorldToOwnedChunk(capital.center.x, capital.center.z);
  const capitalChunk = await generator.generateChunk(capitalOwner.chunkX, capitalOwner.chunkZ);
  const capitalModel = await createW6ChunkGameplay({
    chunkData: capitalChunk,
    worldSeedHash: generator.worldSeedHash,
    generatorMajor: generator.generatorVersion.major,
  });
  assert.equal(capitalModel.entityDescriptors.some(value => value.type === 'boss'), false);
});

test('Tank slot rejects missing or ambiguous primary Military Base without Settlement-center fallback', async () => {
  const generator = await createDistributedSettlementChunkGenerator({ worldSeed: 'W6 entity types' });
  const slotStableId = 'wf1:tank:98a5c14ed33ac2dccc75eccd200d280f';
  const primary = syntheticMilitaryBase({
    stableId: 'wf1:settlement-landmark:4f78c17144582be88b122cce58f06c08',
    parentSettlementId: 'settlement-v1:test-military',
    worldPosition: { x: 3.25, y: 1.75, z: 11.5 },
    rotationY: 0.625,
  });
  const chunkData = {
    chunkX: 0,
    chunkZ: 0,
    vegetationCandidates: [],
    rockCandidates: [],
    settlementFeatures: [],
    settlementReferences: [{
      settlementId: 'settlement-v1:test-military',
      townType: 'military',
      settlementType: 'RURAL',
      center: { x: 8, z: 8 },
    }],
  };
  const create = settlementLandmarks => createW6ChunkGameplay({
    chunkData: { ...chunkData, settlementLandmarks },
    worldSeedHash: generator.worldSeedHash,
    generatorMajor: generator.generatorVersion.major,
  });
  await assert.rejects(() => create([]), error => {
    assert.match(error.message, /^invalid gameplay chunk 0,0:/);
    assert.match(error.message, /requires exactly one primary Military Base, got 0/);
    assert.equal(error.message.includes(slotStableId), true);
    return true;
  });

  const duplicate = {
    ...primary,
    stableId: 'wf1:settlement-landmark:00000000000000000000000000000000',
    worldPosition: { x: 12.5, y: 2.25, z: 5.75 },
  };
  await assert.rejects(() => create([primary, duplicate]), error => {
    assert.match(error.message, /^invalid gameplay chunk 0,0:/);
    assert.match(error.message, /requires exactly one primary Military Base, got 2/);
    for (const stableId of [slotStableId, primary.stableId, duplicate.stableId]) {
      assert.equal(error.message.includes(stableId), true);
    }
    return true;
  });
});

test('Tiny/Mid/Max damage gates and legacy attack values drive active W6 gameplay', async () => {
  const generator = await createDistributedSettlementChunkGenerator({ worldSeed: 'W6 scale damage gates' });
  const chunkData = {
    chunkX: 0, chunkZ: 0, vegetationCandidates: [], rockCandidates: [],
    settlementFeatures: [{
      stableId: 'settlement-building-v1:scale-house', featureType: 'settlement-building',
      buildingType: 'house', radiusMeters: 2, worldPosition: { x: 4, y: 0, z: 4 },
      owningChunkCoordinate: { x: 0, z: 0 },
    }],
    settlementReferences: [{
      settlementId: 'settlement-v1:scale-military', townType: 'military', settlementType: 'RURAL', center: { x: 8, z: 8 },
    }, {
      settlementId: 'settlement-v1:scale-city', townType: 'capital', settlementType: 'CITY', center: { x: 9, z: 9 },
    }],
    settlementLandmarks: [syntheticMilitaryBase({
      stableId: 'wf1:settlement-landmark:11111111111111111111111111111111',
      parentSettlementId: 'settlement-v1:scale-military',
      worldPosition: { x: 8, y: 0, z: 8 },
      rotationY: 0,
    })],
  };
  const state = new InfiniteWorldState({ worldSeedHash: generator.worldSeedHash, playerSpawn: { x: 4, z: 4 } });
  const runtime = new InfiniteGameplayRuntime({
    worldSeedHash: generator.worldSeedHash,
    generatorMajor: generator.generatorVersion.major,
    state,
    renderAdapter: new FakeGameplayRenderer(),
    featureRenderAdapter: fakeFeatureRenderer(),
    clock: () => 0,
  });
  await runtime.syncActiveChunks({
    renderedKeys: ['0,0'],
    getChunkData: () => chunkData,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  });
  const byType = Object.fromEntries(
    [...runtime.activeChunks.values()][0].entityDescriptors.map(value => [value.type, value]),
  );
  state.setScaleStage('TINY');
  assert.deepEqual(runtime.attack('single', 0).hits, []);
  state.setScaleStage('MID');
  const mid = runtime.attack('single', ATTACK_COOLDOWN);
  assert.equal(mid.hits.some(value => value.type === 'human' && value.destroyed), true);
  assert.equal(mid.hits.some(value => value.type === 'house' && value.destroyed), true);
  assert.equal(state.entityStates.get(byType.tank.stableId).hp, TANK_HP);
  state.entityStates.get(byType.tank.stableId).spawned = true;
  state.setScaleStage('MAX');
  const max = runtime.attack('single', ATTACK_COOLDOWN * 2);
  assert.equal(max.hits.some(value => value.type === 'tank' && value.destroyed), true);
  await runtime.shutdown();
});

test('versioned save/load round-trip is deterministic and rejects corruption without mutating runtime state', async () => {
  const worldSeedHash = `sha256:${'1'.repeat(64)}`;
  const storage = new MemoryStorage();
  const state = new InfiniteWorldState({ worldSeedHash, playerSpawn: { x: 1, z: 2 } });
  assert.equal(state.player.maxHp, PLAYER_MAX_HP);
  state.setScaleStage('MID');
  state.updatePlayer({ x: 33, z: -17, score: 900 });
  state.damageFeature({ stableId: 'wf1:tree:test', maxHp: 80 }, 80);
  state.ensureEntity({
    stableId: 'wf1:tank:test', ownerChunkKey: '2,-2', type: 'tank', maxHp: TANK_HP,
    x: 34, z: -18, rotationY: 0.25, aiState: 'engage',
  });
  state.damageEntity('wf1:tank:test', 100);
  const store = new InfiniteWorldSaveStore({ storage, worldSeedHash });
  const serialized = await store.save(state);
  const decoded = await decodeInfiniteWorldSave(serialized, { worldSeedHash });
  assert.deepEqual(decoded, state.createSaveSnapshot());

  const restored = new InfiniteWorldState({ worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  await store.loadInto(restored);
  assert.deepEqual(restored.createSaveSnapshot(), state.createSaveSnapshot());

  const beforeCorruptLoad = restored.createSaveSnapshot();
  const envelope = JSON.parse(serialized);
  envelope.payload.player.score += 1;
  storage.setItem(store.key, JSON.stringify(envelope));
  await assert.rejects(() => store.loadInto(restored), /checksum mismatch/);
  assert.deepEqual(restored.createSaveSnapshot(), beforeCorruptLoad);
});

test('Infinite World is the documented official runtime while the finite entry remains the regression fixture', () => {
  const infiniteEntry = readFileSync(resolve(repoRoot, 'infinite-world-sandbox.html'), 'utf8');
  const finiteEntry = readFileSync(resolve(repoRoot, 'index.html'), 'utf8');
  const runtimeDocument = readFileSync(resolve(repoRoot, 'docs/infinite-world/RUNTIME-ENTRY.md'), 'utf8');
  assert.match(infiniteEntry, /W8 \/ FINITE EXPERIENCE PARITY/);
  assert.match(infiniteEntry, /sandbox-entry\.js\?v=w8-finite-parity/);
  assert.doesNotMatch(infiniteEntry, /src\/game\.js/);
  assert.match(finiteEntry, /src\/game\.js/);
  assert.match(runtimeDocument, /official KaniNingen full-experience runtime is `infinite-world-sandbox\.html`/);
  assert.match(runtimeDocument, /finite World remains byte-for-byte protected at `index\.html`/);
});
