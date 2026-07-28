import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { InfiniteGameplayRuntime } from '../src/infinite-world/gameplay-runtime.js';
import {
  InfiniteWorldSaveStore,
  InfiniteWorldState,
} from '../src/infinite-world/world-state-store.js';

const repoRoot = resolve(import.meta.dirname, '..');
const worldSeedHash = `sha256:${'4'.repeat(64)}`;

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const renderer = () => ({
  async rebase() {},
  async loadChunk() {},
  syncEntity() { return false; },
  async unloadChunk() {},
  snapshot() { return {}; },
  async shutdown() {},
});

const naturalCandidate = ({
  candidateId,
  candidateType,
  subtype,
  x,
  z,
  ownerX,
  ownerZ,
  radius,
  variationSeed = 0,
}) => Object.freeze({
  candidateId,
  candidateType,
  subtype,
  sizeClass: candidateType === 'rock' ? 'medium' : undefined,
  variationSeed,
  orientationSeed: 0.25,
  worldPosition: Object.freeze({ x, y: 0, z }),
  owningChunkCoordinate: Object.freeze({ x: ownerX, z: ownerZ }),
  metadata: Object.freeze({
    candidateRadiusMeters: radius,
    boundsType: 'horizontal-circle',
  }),
});

const chunkData = ({ chunkX, chunkZ, rocks = [], vegetation = [], buildings = [] }) => ({
  chunkX,
  chunkZ,
  generatorVersion: Object.freeze({ major: 800, minor: 0, patch: 0 }),
  presentationLayers: Object.freeze({
    natural: Object.freeze({
      rocks: Object.freeze(rocks),
      vegetation: Object.freeze(vegetation),
    }),
  }),
  rockCandidates: Object.freeze(rocks),
  vegetationCandidates: Object.freeze(vegetation),
  settlementFeatures: Object.freeze(buildings),
  settlementReferences: Object.freeze([]),
  settlementLandmarks: Object.freeze([]),
  ambientDetails: Object.freeze([]),
  streetDetails: Object.freeze([]),
  waterSurfaces: Object.freeze([]),
});

async function createRuntimeWithChunks(chunks, state = new InfiniteWorldState({
  worldSeedHash,
  playerSpawn: { x: 13, z: 0 },
})) {
  const runtime = new InfiniteGameplayRuntime({
    worldSeedHash,
    generatorMajor: 800,
    state,
    renderAdapter: renderer(),
  });
  await runtime.syncActiveChunks({
    renderedKeys: [],
    activeDataKeys: [...chunks.keys()],
    getChunkData: (chunkX, chunkZ) => chunks.get(`${chunkX},${chunkZ}`) ?? null,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  });
  return { runtime, state };
}

test('Gameplay broadphase resolves a blocking canonical Rock across a Chunk boundary', async () => {
  const rock = naturalCandidate({
    candidateId: 'detail-v1:rock:boundary',
    candidateType: 'rock',
    subtype: 'medium-rock',
    x: 16.5,
    z: 0,
    ownerX: 1,
    ownerZ: 0,
    radius: 0.2,
  });
  const chunks = new Map([['1,0', chunkData({ chunkX: 1, chunkZ: 0, rocks: [rock] })]]);
  const { runtime } = await createRuntimeWithChunks(chunks);
  const result = runtime.resolvePlayerHorizontalMovement({
    startX: 13,
    startZ: 0,
    displacementX: 7,
    displacementZ: 0,
    playerRadiusMeters: 0.5,
  });
  const target = runtime.spatialChunks.get('1,0').staticTargets[0];
  assert.equal(target.canonicalObject.collision.blocksPlayer, true);
  assert.equal(target.canonicalObject.collision.radiusMeters > rock.metadata.candidateRadiusMeters, true);
  assert.equal(result.collided, true);
  assert.deepEqual(result.collisionStableIds, [rock.candidateId]);
  assert.ok(result.x < rock.worldPosition.x);
  assert.equal(runtime.snapshot().playerBlockingColliderCount, 1);
  await runtime.shutdown();
});

test('destroyed and save-restored Rocks stop blocking immediately', async () => {
  const rock = naturalCandidate({
    candidateId: 'detail-v1:rock:destroyed',
    candidateType: 'rock',
    subtype: 'medium-rock',
    x: 4,
    z: 0,
    ownerX: 0,
    ownerZ: 0,
    radius: 0.2,
  });
  const chunks = new Map([['0,0', chunkData({ chunkX: 0, chunkZ: 0, rocks: [rock] })]]);
  const first = await createRuntimeWithChunks(chunks);
  const target = first.runtime.spatialChunks.get('0,0').staticTargets[0];
  assert.equal(first.runtime.resolvePlayerHorizontalMovement({
    startX: 0, startZ: 0, displacementX: 8, displacementZ: 0, playerRadiusMeters: 0.5,
  }).collided, true);
  first.runtime.damageStableId(target.stableId, target.maxHp);
  const afterDestruction = first.runtime.resolvePlayerHorizontalMovement({
    startX: 0, startZ: 0, displacementX: 8, displacementZ: 0, playerRadiusMeters: 0.5,
  });
  assert.equal(afterDestruction.collided, false);
  assert.equal(afterDestruction.x, 8);

  const storage = new MemoryStorage();
  const store = new InfiniteWorldSaveStore({ storage, worldSeedHash });
  await store.save(first.state);
  const restoredState = new InfiniteWorldState({
    worldSeedHash,
    playerSpawn: { x: 0, z: 0 },
  });
  await store.loadInto(restoredState);
  const restored = await createRuntimeWithChunks(chunks, restoredState);
  const afterLoad = restored.runtime.resolvePlayerHorizontalMovement({
    startX: 0, startZ: 0, displacementX: 8, displacementZ: 0, playerRadiusMeters: 0.5,
  });
  assert.equal(restoredState.isFeatureDestroyed(rock.candidateId), true);
  assert.equal(afterLoad.collided, false);
  assert.equal(afterLoad.x, 8);
  await first.runtime.shutdown();
  await restored.runtime.shutdown();
});

test('non-blocking canonical Tree and Building preserve current Player movement', async () => {
  const tree = naturalCandidate({
    candidateId: 'detail-v1:vegetation:nonblocking-tree',
    candidateType: 'vegetation',
    subtype: 'broadleaf-tree',
    x: 3,
    z: 0,
    ownerX: 0,
    ownerZ: 0,
    radius: 0.5,
  });
  const building = Object.freeze({
    stableId: 'settlement-building-v1:nonblocking-house',
    featureType: 'settlement-building',
    buildingType: 'house',
    settlementId: 'settlement-v1:nonblocking',
    worldPosition: Object.freeze({ x: 6, y: 0, z: 0 }),
    owningChunkCoordinate: Object.freeze({ x: 0, z: 0 }),
    rotationY: 0,
    widthMeters: 6,
    heightMeters: 4,
    depthMeters: 5,
    radiusMeters: 4,
  });
  const chunks = new Map([['0,0', chunkData({
    chunkX: 0, chunkZ: 0, vegetation: [tree], buildings: [building],
  })]]);
  const { runtime } = await createRuntimeWithChunks(chunks);
  const result = runtime.resolvePlayerHorizontalMovement({
    startX: 0,
    startZ: 0,
    displacementX: 10,
    displacementZ: 0,
    playerRadiusMeters: 0.5,
  });
  assert.equal(result.collided, false);
  assert.equal(result.x, 10);
  assert.equal(runtime.snapshot().playerBlockingColliderCount, 0);
  await runtime.shutdown();
});

test('Player resolver is category-independent and does not consume presentation sources', () => {
  const resolverSource = readFileSync(resolve(repoRoot,
    'src/infinite-world/player-world-collision.js'), 'utf8');
  const gameplaySource = readFileSync(resolve(repoRoot,
    'src/infinite-world/gameplay-runtime.js'), 'utf8');
  assert.doesNotMatch(resolverSource, /\b(?:rock|tree|building)\b/i);
  assert.match(gameplaySource, /collision\?\.blocksPlayer !== true/);
  assert.doesNotMatch(gameplaySource, /resolvePlayerHorizontalMovement[\s\S]{0,1200}candidateRadiusMeters/);
  assert.doesNotMatch(gameplaySource, /resolvePlayerHorizontalMovement[\s\S]{0,1200}(?:Near|Outer|Far)/);
});
