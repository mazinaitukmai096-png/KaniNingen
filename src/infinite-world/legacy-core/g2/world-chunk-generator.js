import { canonicalizeJson } from '../g0/canonical-json.js';
import { createChunkId } from '../g0/chunk-id.js';
import { hashWorldSeed, normalizeWorldSeed } from '../g0/seed.js';
import { sha256Hex } from '../g0/sha256.js';
import { createWorldFeatureId } from '../g0/stable-id.js';
import { createFeaturePortIdentity } from '../g1/feature-port.js';
import { EDGE_DEFINITIONS, hashTerrainEdge } from './terrain-edge.js';

const CHUNK_SIZE = 16;
const VERSION = Object.freeze({ major: 1, minor: 0, patch: 0, id: '1.0.0' });
const RIVER = Object.freeze({ slope: 0.37, intercept: 3.2, width: 1.5, depth: 0.04, surfaceElevation: 0.02 });

export function getChunkWorldBounds(chunkCoordinate, chunkSize = CHUNK_SIZE) {
  if (!Number.isSafeInteger(chunkCoordinate?.x) || !Number.isSafeInteger(chunkCoordinate?.z)) {
    throw new TypeError('chunkCoordinate must contain safe integer x and z');
  }
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new TypeError('chunkSize must be positive');
  const minX = chunkCoordinate.x * chunkSize; const minZ = chunkCoordinate.z * chunkSize;
  return Object.freeze({ minX, minZ, maxX: minX + chunkSize, maxZ: minZ + chunkSize });
}

export function createWorldBorderSampleKey(worldX, worldZ, fieldType) {
  if (![worldX, worldZ].every(Number.isFinite) || typeof fieldType !== 'string' || !fieldType) throw new TypeError('invalid border sample input');
  return `world-border-v1:${fieldType}:${Math.round(worldX * 1000)}:${Math.round(worldZ * 1000)}`;
}

export function createWorldCornerIdentity(worldX, worldZ) {
  if (![worldX, worldZ].every(Number.isFinite)) throw new TypeError('invalid corner input');
  return `world-corner-v1:${Math.round(worldX * 1000)}:${Math.round(worldZ * 1000)}`;
}

function riverZ(x) { return RIVER.slope * x + RIVER.intercept; }

function quantizedPoint(point) {
  return { x: Math.round(point.x * 1000) / 1000, z: Math.round(point.z * 1000) / 1000 };
}

function intersectRiverWithBounds(bounds) {
  const candidates = [];
  const add = point => {
    const value = quantizedPoint(point);
    if (value.x < bounds.minX - 0.001 || value.x > bounds.maxX + 0.001
      || value.z < bounds.minZ - 0.001 || value.z > bounds.maxZ + 0.001) return;
    if (!candidates.some(item => item.x === value.x && item.z === value.z)) candidates.push(value);
  };
  add({ x: bounds.minX, z: riverZ(bounds.minX) }); add({ x: bounds.maxX, z: riverZ(bounds.maxX) });
  add({ x: (bounds.minZ - RIVER.intercept) / RIVER.slope, z: bounds.minZ });
  add({ x: (bounds.maxZ - RIVER.intercept) / RIVER.slope, z: bounds.maxZ });
  if (candidates.length !== 2) return null;
  candidates.sort((a, b) => a.x - b.x || a.z - b.z);
  return candidates;
}

function edgeForWorldPoint(point, bounds) {
  if (Math.abs(point.x - bounds.minX) <= 0.001) return 'west';
  if (Math.abs(point.x - bounds.maxX) <= 0.001) return 'east';
  if (Math.abs(point.z - bounds.minZ) <= 0.001) return 'north';
  if (Math.abs(point.z - bounds.maxZ) <= 0.001) return 'south';
  throw new Error('projected Feature endpoint is not on a Chunk edge');
}

async function createPort({ worldSeedHash, riverId, worldPoint, localPoint, edge }) {
  const definition = EDGE_DEFINITIONS[edge];
  const identity = await createFeaturePortIdentity({ worldSeedHash, generatorMajor: 1, featureId: riverId,
    semanticType: 'river-continuation', boundaryAxis: definition.axis,
    quantizedWorldBoundary: Math.round(worldPoint[definition.axis] * 1000),
    semanticCrossingKey: createWorldBorderSampleKey(worldPoint.x, worldPoint.z, 'river') });
  return { schemaVersion: 'feature-port-1', ...identity, featureId: riverId, edge,
    position: localPoint, direction: { ...definition.direction }, width: RIVER.width,
    elevation: RIVER.surfaceElevation, semanticType: 'river-continuation' };
}

export async function projectSectorFeaturesToChunk({ chunkCoordinate, worldSeedHash, riverId, chunkSize = CHUNK_SIZE }) {
  const worldBounds = getChunkWorldBounds(chunkCoordinate, chunkSize);
  const endpoints = intersectRiverWithBounds(worldBounds);
  if (!endpoints) return Object.freeze({ featureReferences: [], waterBodies: [], ports: [] });
  const localPoints = endpoints.map(point => ({ x: point.x - worldBounds.minX, z: point.z - worldBounds.minZ }));
  const ports = [];
  for (let index = 0; index < endpoints.length; index += 1) ports.push(await createPort({ worldSeedHash, riverId,
    worldPoint: endpoints[index], localPoint: localPoints[index], edge: edgeForWorldPoint(endpoints[index], worldBounds) }));
  const featureReference = { stableId: riverId, featureType: 'river',
    bounds: { type: 'polylineWithWidth', points: localPoints, widths: [RIVER.width, RIVER.width] },
    portIds: ports.map(port => port.portId) };
  const waterBody = { schemaVersion: 'water-body-1', stableId: `water-body-v1:${riverId}`,
    featureReferenceId: riverId, waterType: 'river', surfaceElevation: RIVER.surfaceElevation,
    centerline: localPoints, widthProfile: [RIVER.width, RIVER.width], depthProfile: [RIVER.depth, RIVER.depth],
    localBounds: { type: 'polylineWithWidth', points: localPoints, widths: [RIVER.width, RIVER.width] },
    crossingReferences: [], flowDirection: 'startToEnd',
    traversabilityProfile: [{ mode: 'wadeable', costMultiplier: 1.4 }, { mode: 'wadeable', costMultiplier: 1.4 }] };
  return Object.freeze({ featureReferences: [featureReference], waterBodies: [waterBody], ports });
}

function distanceToRiver(worldX, worldZ) {
  return Math.abs(RIVER.slope * worldX - worldZ + RIVER.intercept) / Math.hypot(RIVER.slope, 1);
}

function createTerrain(chunkCoordinate) {
  const heights = []; const materialWeights = []; const moisture = []; const rockiness = [];
  const bounds = getChunkWorldBounds(chunkCoordinate);
  for (let z = 0; z <= CHUNK_SIZE; z += 1) for (let x = 0; x <= CHUNK_SIZE; x += 1) {
    const worldX = bounds.minX + x; const worldZ = bounds.minZ + z; const distance = distanceToRiver(worldX, worldZ);
    const riverInfluence = Math.max(0, 1 - distance / (RIVER.width * 1.5));
    const baseMillimeters = 20 + ((Math.abs(worldX * 31 + worldZ * 17) % 7) - 3);
    const height = Math.round(baseMillimeters * (1 - riverInfluence) + (RIVER.surfaceElevation - RIVER.depth) * 1000 * riverInfluence);
    heights.push(Object.is(height, -0) ? 0 : height);
    const wet = Math.round(Math.max(0, 1 - distance / 3) * 1e6) / 1e6;
    const rock = Math.abs(Math.floor(worldX / 8) + Math.floor(worldZ / 8)) % 7 === 0 ? 0.25 : 0;
    materialWeights.push(1 - wet, 0, wet, 0, 0); moisture.push(wet); rockiness.push(rock);
  }
  return { resolution: { x: 17, z: 17 }, heightUnitMeters: 0.001, heights,
    materialOrder: ['grass', 'drySoil', 'wetSoil', 'sand', 'rock'], materialWeights, moisture, rockiness, waterBodies: [] };
}

async function createContext(worldSeed) {
  const { worldSeedHash } = await hashWorldSeed(normalizeWorldSeed(worldSeed));
  const riverId = (await createWorldFeatureId({ stableIdSchema: 'wf1', worldSeedHash, generatorMajor: 1,
    featureType: 'river', parentStableId: '', purposeKey: 'world-main-river', semanticLocalKey: 'linear-primary' })).stableId;
  return { worldSeedHash, riverId };
}

export async function generateChunkAtCoordinate({ worldSeed = 'g2-c-on-demand-golden', chunkCoordinate, chunkSize = CHUNK_SIZE }) {
  if (chunkSize !== CHUNK_SIZE) throw new RangeError('G2-C supports only 16m Chunks');
  const context = await createContext(worldSeed); const terrain = createTerrain(chunkCoordinate);
  const projection = await projectSectorFeaturesToChunk({ chunkCoordinate, chunkSize, ...context });
  terrain.waterBodies.push(...projection.waterBodies);
  const adjacency = {};
  for (const edge of ['north', 'east', 'south', 'west']) adjacency[edge] = {
    terrainEdgeHash: await hashTerrainEdge(terrain, edge),
    featurePorts: projection.ports.filter(port => port.edge === edge),
  };
  const coordinate = { x: chunkCoordinate.x, z: chunkCoordinate.z };
  const chunk = { schemaVersion: 'chunk-data-1', outputHashSchema: 'chunk-output-1', generatorVersion: { ...VERSION },
    worldSeedHash: context.worldSeedHash, chunkId: createChunkId({ worldSeedHash: context.worldSeedHash, generatorMajor: 1, chunkCoordinate: coordinate }),
    chunkCoordinate: coordinate, bounds: { minX: 0, minZ: 0, maxX: CHUNK_SIZE, maxZ: CHUNK_SIZE },
    biomeMemberships: [{ biomeId: 'riverbank', weight: 1 }], terrain,
    featureReferences: projection.featureReferences, localFeatures: [], featureEdges: [], vegetationZones: [], spawnCandidates: [], adjacency };
  chunk.generationProof = { generator: 'on-demand-world-chunk-g2-c', worldBounds: getChunkWorldBounds(coordinate),
    inputHash: `sha256:${await sha256Hex(canonicalizeJson(RIVER))}` };
  return chunk;
}

export const G2_C_WORLD_FEATURES = Object.freeze({ river: RIVER, chunkSize: CHUNK_SIZE });
