import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { createChunkId } from './legacy-core/g0/chunk-id.js';
import { createDeterministicRandom, deriveLocalSeed64 } from './legacy-core/g0/deterministic-random.js';
import { parseGeneratorVersion } from './legacy-core/g0/generator-version.js';
import { normalizeWorldSeed, hashWorldSeed } from './legacy-core/g0/seed.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import { createWorldFeatureId } from './legacy-core/g0/stable-id.js';
import { extractTerrainEdge, hashTerrainEdge } from './legacy-core/g2/terrain-edge.js';
import {
  LOGICAL_CHUNK_SIZE_METERS,
  RENDER_CHUNK_SIZE,
  assertLogicalChunkCoordinate,
  createChunkKey,
  logicalLocalToWorldMeters,
  logicalWorldToOwnedChunk,
} from './chunk-coordinates.js';

export const W1A_GENERATOR_VERSION = parseGeneratorVersion('100.0.0');
export const W1A_CHUNK_DATA_SCHEMA = 'w1a-chunk-data-1';

const MATERIAL_ORDER = Object.freeze(['soil', 'grass', 'sand', 'rock', 'water']);
const FLAT_TERRAIN_TEMPLATE = Object.freeze({
  schemaVersion: 'w1a-flat-terrain-1',
  resolution: Object.freeze({ x: 2, z: 2 }),
  heightUnitMeters: 1,
  materialOrder: MATERIAL_ORDER,
  heights: Object.freeze([0, 0, 0, 0]),
  materialWeights: Object.freeze([
    0.08, 0.92, 0, 0, 0,
    0.08, 0.92, 0, 0, 0,
    0.08, 0.92, 0, 0, 0,
    0.08, 0.92, 0, 0, 0,
  ]),
  moisture: Object.freeze([0.45, 0.45, 0.45, 0.45]),
  rockiness: Object.freeze([0.16, 0.16, 0.16, 0.16]),
});

function cloneFlatTerrain() {
  return {
    ...FLAT_TERRAIN_TEMPLATE,
    resolution: { ...FLAT_TERRAIN_TEMPLATE.resolution },
    materialOrder: [...MATERIAL_ORDER],
    heights: [...FLAT_TERRAIN_TEMPLATE.heights],
    materialWeights: [...FLAT_TERRAIN_TEMPLATE.materialWeights],
    moisture: [...FLAT_TERRAIN_TEMPLATE.moisture],
    rockiness: [...FLAT_TERRAIN_TEMPLATE.rockiness],
  };
}

async function createEdgeData(terrain) {
  const entries = await Promise.all(['north', 'east', 'south', 'west'].map(async edge => [
    edge,
    {
      schemaVersion: 'w1a-edge-data-1',
      hash: await hashTerrainEdge(terrain, edge),
      terrainEdge: extractTerrainEdge(terrain, edge),
    },
  ]));
  return Object.fromEntries(entries);
}

async function createProxy({
  type, slot, random, chunkId, chunkX, chunkZ, worldSeedHash,
}) {
  const minimumInset = 0.08;
  const usableFraction = 1 - minimumInset * 2;
  const logicalLocalX = (minimumInset + await random.float01(`${type}:${slot}:x`) * usableFraction)
    * LOGICAL_CHUNK_SIZE_METERS;
  const logicalLocalZ = (minimumInset + await random.float01(`${type}:${slot}:z`) * usableFraction)
    * LOGICAL_CHUNK_SIZE_METERS;
  const logicalWorldMeters = logicalLocalToWorldMeters(chunkX, chunkZ, logicalLocalX, logicalLocalZ);
  const owner = logicalWorldToOwnedChunk(logicalWorldMeters.x, logicalWorldMeters.z);
  if (owner.chunkX !== chunkX || owner.chunkZ !== chunkZ) {
    throw new Error(`sandbox proxy owner mismatch for ${chunkX},${chunkZ}:${type}:${slot}`);
  }
  const idResult = await createWorldFeatureId({
    stableIdSchema: 'wf1',
    worldSeedHash,
    generatorMajor: W1A_GENERATOR_VERSION.major,
    featureType: `sandbox-${type}-proxy`,
    parentStableId: chunkId,
    purposeKey: 'w1a-sandbox-proxy',
    semanticLocalKey: `${createChunkKey(chunkX, chunkZ)}:${type}:slot-${slot}`,
  });
  return {
    stableId: idResult.stableId,
    logicalLocalX,
    logicalLocalZ,
    logicalWorldMeters,
    yawRadians: await random.float01(`${type}:${slot}:yaw`) * Math.PI * 2,
    scale: type === 'tree'
      ? 0.75 + await random.float01(`${type}:${slot}:scale`) * 0.55
      : 0.55 + await random.float01(`${type}:${slot}:scale`) * 0.75,
    metadata: {
      sandboxProxy: true,
      formalCandidate: false,
      proxyType: type,
      semanticSlot: slot,
      ownerChunkX: owner.chunkX,
      ownerChunkZ: owner.chunkZ,
    },
  };
}

async function createProxies({ chunkId, chunkX, chunkZ, worldSeedHash }) {
  const localSeed64 = await deriveLocalSeed64({
    worldSeedHash,
    namespace: 'w1a-sandbox-chunk-proxies',
    semanticKey: createChunkKey(chunkX, chunkZ),
  });
  const random = createDeterministicRandom(localSeed64);
  const rockCount = await random.integer('rock-count', 0, 2);
  const vegetationProxies = await Promise.all(Array.from({ length: 4 }, (_, slot) => createProxy({
    type: 'tree', slot, random, chunkId, chunkX, chunkZ, worldSeedHash,
  })));
  const rockProxies = await Promise.all(Array.from({ length: rockCount }, (_, slot) => createProxy({
    type: 'rock', slot, random, chunkId, chunkX, chunkZ, worldSeedHash,
  })));
  const compareStableId = (a, b) => (a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0);
  vegetationProxies.sort(compareStableId);
  rockProxies.sort(compareStableId);
  return { vegetationProxies, rockProxies };
}

export function validateW1AChunkData(chunkData) {
  const errors = [];
  if (!chunkData || typeof chunkData !== 'object') return Object.freeze({ valid: false, errors: ['ChunkData is required'] });
  if (chunkData.schemaVersion !== W1A_CHUNK_DATA_SCHEMA) errors.push('invalid W1A ChunkData schema');
  if (typeof chunkData.chunkId !== 'string' || !chunkData.chunkId.startsWith('chunk-v1:')) errors.push('invalid chunkId');
  if (!Number.isSafeInteger(chunkData.chunkX) || !Number.isSafeInteger(chunkData.chunkZ)) errors.push('invalid chunk coordinates');
  if (chunkData.logicalChunkSizeMeters !== LOGICAL_CHUNK_SIZE_METERS) errors.push('invalid logical chunk size');
  if (chunkData.renderChunkSize !== RENDER_CHUNK_SIZE) errors.push('invalid render chunk size');
  if (chunkData.generatorVersion?.id !== W1A_GENERATOR_VERSION.id) errors.push('invalid generator version');
  if (!chunkData.terrain || !Array.isArray(chunkData.terrain.heights)) errors.push('terrain is required');
  if (!Array.isArray(chunkData.vegetationProxies)) errors.push('vegetationProxies are required');
  if (!Array.isArray(chunkData.rockProxies)) errors.push('rockProxies are required');
  for (const edge of ['north', 'east', 'south', 'west']) {
    if (typeof chunkData.edgeData?.[edge]?.hash !== 'string') errors.push(`missing ${edge} edge data`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(chunkData.contentHash ?? '')) errors.push('invalid contentHash');
  const ids = [...(chunkData.vegetationProxies ?? []), ...(chunkData.rockProxies ?? [])]
    .map(proxy => proxy.stableId);
  if (new Set(ids).size !== ids.length) errors.push('duplicate proxy IDs');
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export async function hashW1AChunkContent(chunkDataWithoutHash) {
  return `sha256:${await sha256Hex(canonicalizeJson(chunkDataWithoutHash))}`;
}

export async function createSandboxChunkGenerator({ worldSeed = 'KaniNingen W1A' } = {}) {
  const normalizedWorldSeed = normalizeWorldSeed(worldSeed);
  const { worldSeedHash, seed64 } = await hashWorldSeed(normalizedWorldSeed);

  return Object.freeze({
    worldSeed: normalizedWorldSeed,
    worldSeedHash,
    seed64,
    generatorVersion: W1A_GENERATOR_VERSION,
    async generateChunk(chunkXInput, chunkZInput) {
      const chunkX = assertLogicalChunkCoordinate(chunkXInput, 'chunkX');
      const chunkZ = assertLogicalChunkCoordinate(chunkZInput, 'chunkZ');
      const chunkId = createChunkId({
        worldSeedHash,
        generatorMajor: W1A_GENERATOR_VERSION.major,
        chunkCoordinate: { x: chunkX, z: chunkZ },
      });
      const terrain = cloneFlatTerrain();
      const [edgeData, proxies] = await Promise.all([
        createEdgeData(terrain),
        createProxies({ chunkId, chunkX, chunkZ, worldSeedHash }),
      ]);
      const content = {
        schemaVersion: W1A_CHUNK_DATA_SCHEMA,
        chunkId,
        chunkX,
        chunkZ,
        logicalChunkSizeMeters: LOGICAL_CHUNK_SIZE_METERS,
        renderChunkSize: RENDER_CHUNK_SIZE,
        generatorVersion: { ...W1A_GENERATOR_VERSION },
        terrain,
        vegetationProxies: proxies.vegetationProxies,
        rockProxies: proxies.rockProxies,
        edgeData,
      };
      const chunkData = { ...content, contentHash: await hashW1AChunkContent(content) };
      const validation = validateW1AChunkData(chunkData);
      if (!validation.valid) throw new Error(`invalid W1A ChunkData: ${validation.errors.join('; ')}`);
      return chunkData;
    },
  });
}
