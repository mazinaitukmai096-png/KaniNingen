import { createDeterministicRandom, deriveLocalSeed64 } from '../g0/deterministic-random.js';

const CHUNK_SIZE = 16;
const RESOLUTION = 33;
const STEP = CHUNK_SIZE / (RESOLUTION - 1);
const MATERIAL_ORDER = Object.freeze(['grass', 'drySoil', 'wetSoil', 'sand', 'rock']);
const q6 = value => Math.round(value * 1e6) / 1e6;
const clamp = value => Math.max(0, Math.min(1, value));
const smoothstep = value => { const t = clamp(value); return t * t * (3 - 2 * t); };

function segmentDistance(point, a, b) {
  const dx = b.x - a.x; const dz = b.z - a.z; const length2 = dx * dx + dz * dz;
  const t = length2 ? clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / length2) : 0;
  return { distance: Math.hypot(point.x - a.x - dx * t, point.z - a.z - dz * t), t };
}

function polylineDistance(point, geometry) {
  let best = { distance: Infinity, width: 0 };
  for (let index = 0; index < geometry.points.length - 1; index += 1) {
    const hit = segmentDistance(point, geometry.points[index], geometry.points[index + 1]);
    const width = geometry.widths[index] + (geometry.widths[index + 1] - geometry.widths[index]) * hit.t;
    if (hit.distance < best.distance) best = { distance: hit.distance, width };
  }
  return best;
}

function geometryDistance(point, geometry) {
  if (!geometry) return Infinity;
  if (geometry.type === 'point') return Math.hypot(point.x - geometry.position.x, point.z - geometry.position.z);
  if (geometry.type === 'capsule') return Math.max(0, segmentDistance(point, geometry.start, geometry.end).distance - geometry.radius);
  if (geometry.type === 'polylineWithWidth') { const hit = polylineDistance(point, geometry); return Math.max(0, hit.distance - hit.width / 2); }
  if (geometry.type === 'polygon2D') return Math.min(...geometry.vertices.map((value, index) => segmentDistance(point, value, geometry.vertices[(index + 1) % geometry.vertices.length]).distance));
  return Infinity;
}

export function interpolateBiomeWeights(field, localX, localZ) {
  const fx = localX / CHUNK_SIZE * (field.resolution.x - 1); const fz = localZ / CHUNK_SIZE * (field.resolution.z - 1);
  const x0 = Math.floor(fx); const z0 = Math.floor(fz); const x1 = Math.min(x0 + 1, field.resolution.x - 1); const z1 = Math.min(z0 + 1, field.resolution.z - 1);
  const tx = fx - x0; const tz = fz - z0; const count = field.biomeOrder.length;
  const weight = (x, z, biome) => field.weights[(z * field.resolution.x + x) * count + biome];
  return field.biomeOrder.map((biomeId, biome) => ({ biomeId, weight: q6(
    (weight(x0, z0, biome) * (1 - tx) + weight(x1, z0, biome) * tx) * (1 - tz)
    + (weight(x0, z1, biome) * (1 - tx) + weight(x1, z1, biome) * tx) * tz) }));
}

export function evaluateBiomeTerrainGridPoint({ sourceIndex, position, memberships, microFieldValue, worldFeatures }) {
  const membership = Object.fromEntries(memberships.map(item => [item.biomeId, item.weight]));
  const base = sampleBaseTerrainAtWorldPosition(position, memberships, microFieldValue); const influence = sampleFeatureTerrainInfluence(position, worldFeatures);
  const riverCore = smoothstep(1 - influence.river.distance / Math.max(0.1, influence.river.width * 0.55));
  const riverBiome = membership.riverbank ?? 0; const crossing = smoothstep(1 - influence.crossingDistance / 1.4);
  const riverDepthMm = 45 * riverCore * riverBiome * (1 - crossing * 0.62);
  const residential = membership['residential-low-density'] ?? 0; const boundary = smoothstep(1 - influence.boundaryDistance / 2.5) * residential;
  const rock = smoothstep(1 - influence.rockDistance / 3.2); const heightMm = Math.round(base.heightMm - riverDepthMm + rock * 24 - boundary * (base.heightMm - 24) * 0.55);
  const riverWet = smoothstep(1 - influence.river.distance / 5) * riverBiome; const drainWet = smoothstep(1 - influence.drainDistance / 2.2);
  const crossingDry = crossing * riverCore; const materials = [...base.materials];
  materials[0] -= riverWet * 0.28 + rock * 0.1; materials[1] += boundary * 0.24 + crossingDry * 0.22; materials[2] += riverWet * 0.42 + drainWet * 0.12; materials[3] += riverWet * 0.22 + crossingDry * 0.12; materials[4] += rock * 0.62 + riverWet * 0.04;
  return {
    sourceIndex,
    heightMm: Object.is(heightMm, -0) ? 0 : heightMm,
    materialWeights: normalizeMaterials(materials),
    moisture: q6(clamp(base.moisture + riverWet * 0.42 + drainWet * 0.18 - crossingDry * 0.08)),
    rockiness: q6(clamp(0.025 + rock * 0.78 + riverWet * 0.08 - residential * 0.025)),
  };
}

async function createMicroField(worldSeedHash) {
  const seed = await deriveLocalSeed64({ worldSeedHash, namespace: 'g3-terrain-microrelief', semanticKey: 'terrain-field-1' });
  const random = createDeterministicRandom(seed); const cache = new Map(); const spacing = 8;
  const lattice = (x, z) => { const key = `${x}:${z}`; if (!cache.has(key)) cache.set(key, random.float01(key)); return cache.get(key); };
  return async (x, z) => {
    const gx = Math.floor(x / spacing); const gz = Math.floor(z / spacing); const tx = x / spacing - gx; const tz = z / spacing - gz;
    const [a, b, c, d] = await Promise.all([lattice(gx, gz), lattice(gx + 1, gz), lattice(gx, gz + 1), lattice(gx + 1, gz + 1)]);
    return ((a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz - 0.5) * 2;
  };
}

export function createBiomeTerrainProfiles() {
  return Object.freeze({
    riverbank: Object.freeze({ reliefMm: 16, moisture: 0.62, materials: [0.38, 0.08, 0.34, 0.18, 0.02] }),
    'garden-edge': Object.freeze({ reliefMm: 22, moisture: 0.38, materials: [0.57, 0.31, 0.07, 0.03, 0.02] }),
    'residential-low-density': Object.freeze({ reliefMm: 7, moisture: 0.22, materials: [0.23, 0.68, 0.04, 0.03, 0.02] }),
  });
}

export function sampleBaseTerrainAtWorldPosition(position, memberships, microField = 0) {
  const profiles = createBiomeTerrainProfiles(); let relief = 0; let moisture = 0; const materials = [0, 0, 0, 0, 0];
  for (const membership of memberships) { const profile = profiles[membership.biomeId]; relief += profile.reliefMm * membership.weight; moisture += profile.moisture * membership.weight; profile.materials.forEach((value, index) => { materials[index] += value * membership.weight; }); }
  return { heightMm: Math.round(28 + microField * relief), moisture, materials };
}

export function sampleFeatureTerrainInfluence(position, features) {
  const byType = type => features.filter(item => item.featureType === type);
  const river = byType('river').map(item => polylineDistance(position, item.geometry)).sort((a, b) => a.distance - b.distance)[0] ?? { distance: Infinity, width: 0 };
  const crossingDistance = Math.min(Infinity, ...byType('crossing').map(item => geometryDistance(position, item.geometry)));
  const boundaryDistance = Math.min(Infinity, ...byType('structure-boundary').map(item => geometryDistance(position, item.geometry)));
  const drainDistance = Math.min(Infinity, ...byType('storm-drain').map(item => geometryDistance(position, item.geometry)));
  const rockDistance = Math.min(Infinity, ...byType('rock-band').map(item => geometryDistance(position, item.geometry)));
  const passageDistance = Math.min(Infinity, ...byType('passage').map(item => geometryDistance(position, item.geometry)));
  return { river, crossingDistance, boundaryDistance, drainDistance, rockDistance, passageDistance };
}

function normalizeMaterials(values) {
  const nonnegative = values.map(value => Math.max(0, value)); const total = nonnegative.reduce((sum, value) => sum + value, 0);
  const result = nonnegative.map(value => q6(value / total)); result[0] = q6(result[0] + q6(1 - result.reduce((sum, value) => sum + value, 0)));
  return result;
}

export async function generateTerrainFromBiomeField({ chunkCoordinate, biomeField, worldFeatures, worldSeedHash, waterBodies = [] }) {
  const heights = []; const materialWeights = []; const moisture = []; const rockiness = [];
  const microField = await createMicroField(worldSeedHash);
  for (let z = 0; z < RESOLUTION; z += 1) for (let x = 0; x < RESOLUTION; x += 1) {
    const localX = x * STEP; const localZ = z * STEP; const position = { x: chunkCoordinate.x * CHUNK_SIZE + localX, z: chunkCoordinate.z * CHUNK_SIZE + localZ };
    const sample = evaluateBiomeTerrainGridPoint({ sourceIndex: z * RESOLUTION + x, position, memberships: interpolateBiomeWeights(biomeField, localX, localZ),
      microFieldValue: await microField(position.x, position.z), worldFeatures });
    heights.push(sample.heightMm); materialWeights.push(...sample.materialWeights); moisture.push(sample.moisture); rockiness.push(sample.rockiness);
  }
  return { resolution: { x: RESOLUTION, z: RESOLUTION }, heightUnitMeters: 0.001, heights,
    materialOrder: [...MATERIAL_ORDER], materialWeights, moisture, rockiness, waterBodies: JSON.parse(JSON.stringify(waterBodies)) };
}

export function validateBiomeTerrainConsistency(terrain) {
  const errors = []; const count = RESOLUTION * RESOLUTION;
  if (terrain?.resolution?.x !== RESOLUTION || terrain?.resolution?.z !== RESOLUTION) errors.push('terrain resolution must be 33x33');
  if (terrain?.heights?.length !== count) errors.push('heights length is invalid');
  if (terrain?.materialWeights?.length !== count * 5) errors.push('materialWeights length is invalid');
  if (terrain?.moisture?.length !== count || terrain?.rockiness?.length !== count) errors.push('terrain scalar field length is invalid');
  for (let index = 0; index < count; index += 1) {
    const weights = terrain.materialWeights?.slice(index * 5, index * 5 + 5) ?? [];
    if (weights.length === 5 && Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) > 0.000001) errors.push(`material weights differ at ${index}`);
    if (![terrain.heights?.[index], terrain.moisture?.[index], terrain.rockiness?.[index], ...weights].every(Number.isFinite)) errors.push(`non-finite terrain value at ${index}`);
  }
  return { valid: errors.length === 0, errors };
}

export const G3_C_TERRAIN = Object.freeze({ chunkSize: CHUNK_SIZE, resolution: RESOLUTION, sampleSpacingMeters: STEP, materialOrder: MATERIAL_ORDER });
