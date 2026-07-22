import { deriveLocalSeed64 } from '../g0/deterministic-random.js';
import { sampleFeatureTerrainInfluence } from '../g3/biome-terrain.js';

const CHUNK_SIZE_METERS = 16;
const HEIGHT_UNIT_METERS = 0.001;
const q6 = value => Math.round(value * 1e6) / 1e6;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const smooth = value => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };

// All distances are meters and all vertical amplitudes are millimeters. Values are
// centralized here so Phase 1 terrain tuning does not become scattered magic data.
export const G5_MACRO_TERRAIN = Object.freeze({
  schemaVersion: 'macro-terrain-1',
  chunkSizeMeters: CHUNK_SIZE_METERS,
  heightUnitMeters: HEIGHT_UNIT_METERS,
  derivativeStepMeters: 0.5,
  maximumOffsetMm: 3200,
  maximumSlope: 0.58,
  domainWarp: Object.freeze({ spacingMeters: 192, amplitudeMeters: 22 }),
  macro: Object.freeze({ spacingMeters: 384, amplitudeMm: 1900 }),
  hills: Object.freeze({ spacingMeters: 88, amplitudeMm: 920 }),
  ridges: Object.freeze({ spacingMeters: 76, amplitudeMm: 1450 }),
  valleys: Object.freeze({ spacingMeters: 224, amplitudeMm: 820 }),
  localDetail: Object.freeze({ spacingMeters: 18, amplitudeMm: 180 }),
  featureConstraints: Object.freeze({ roadRadiusMeters: 2.6, crossingRadiusMeters: 2.1,
    structureRadiusMeters: 3.4, maximumCorrectionMm: 180 }),
});

function mix32(value) {
  let result = value >>> 0; result ^= result >>> 16; result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15; result = Math.imul(result, 0x846ca68b); result ^= result >>> 16; return result >>> 0;
}

function seed32(seed64, salt) {
  return mix32((Number.parseInt(seed64.slice(0, 8), 16) ^ Number.parseInt(seed64.slice(8), 16) ^ salt) >>> 0);
}

function lattice(seed, x, z) {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) throw new RangeError('noise lattice coordinates must be safe integers');
  const fold = value => {
    if (value >= -0x80000000 && value <= 0x7fffffff) return value >>> 0;
    const low = value >>> 0; const high = Math.trunc(value / 0x100000000);
    return mix32(low ^ mix32(high >>> 0));
  };
  return mix32(seed ^ Math.imul(fold(x), 0x1f123bb5) ^ Math.imul(fold(z), 0x5f356495)) / 0xffffffff;
}

function valueNoise(seed, x, z, spacing) {
  const gx = Math.floor(x / spacing); const gz = Math.floor(z / spacing);
  const tx = smooth(x / spacing - gx); const tz = smooth(z / spacing - gz);
  const a = lattice(seed, gx, gz); const b = lattice(seed, gx + 1, gz);
  const c = lattice(seed, gx, gz + 1); const d = lattice(seed, gx + 1, gz + 1);
  return ((a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz) * 2 - 1;
}

function fractal(seed, x, z, spacing, octaves) {
  let total = 0; let weight = 1; let weights = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += valueNoise(mix32(seed + octave * 0x9e3779b9), x, z, spacing / 2 ** octave) * weight;
    weights += weight; weight *= 0.5;
  }
  return total / weights;
}

function geometryDistance(point, geometry) {
  if (!geometry) return Infinity;
  const segment = (a, b) => { const dx = b.x - a.x; const dz = b.z - a.z; const length2 = dx * dx + dz * dz;
    const t = length2 ? clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / length2, 0, 1) : 0;
    return Math.hypot(point.x - a.x - dx * t, point.z - a.z - dz * t); };
  if (geometry.type === 'point') return Math.hypot(point.x - geometry.position.x, point.z - geometry.position.z);
  if (geometry.type === 'capsule') return Math.max(0, segment(geometry.start, geometry.end) - geometry.radius);
  if (geometry.type === 'polylineWithWidth') return Math.min(...geometry.points.slice(0, -1).map((value, index) => segment(value, geometry.points[index + 1]) - (geometry.widths[index] + geometry.widths[index + 1]) / 4));
  if (geometry.type === 'polygon2D') return Math.min(...geometry.vertices.map((value, index) => segment(value, geometry.vertices[(index + 1) % geometry.vertices.length])));
  return Infinity;
}

function nearestDistance(point, features, types) {
  const distances = features.filter(item => types.has(item.featureType)).map(item => geometryDistance(point, item.geometry));
  return distances.length ? Math.min(...distances) : Infinity;
}

function biomeWeightsAt(field, localX, localZ) {
  const fx = localX / CHUNK_SIZE_METERS * (field.resolution.x - 1); const fz = localZ / CHUNK_SIZE_METERS * (field.resolution.z - 1);
  const x0 = Math.floor(fx); const z0 = Math.floor(fz); const x1 = Math.min(x0 + 1, field.resolution.x - 1); const z1 = Math.min(z0 + 1, field.resolution.z - 1); const tx = fx - x0; const tz = fz - z0; const count = field.biomeOrder.length;
  const at = (x, z, biome) => field.weights[(z * field.resolution.x + x) * count + biome]; const result = {};
  field.biomeOrder.forEach((id, biome) => { result[id] = (at(x0, z0, biome) * (1 - tx) + at(x1, z0, biome) * tx) * (1 - tz) + (at(x0, z1, biome) * (1 - tx) + at(x1, z1, biome) * tx) * tz; });
  return result;
}

export async function createMacroTerrainEvaluator(worldSeedHash) {
  const seed64 = await deriveLocalSeed64({ worldSeedHash, namespace: 'g5-macro-terrain', semanticKey: G5_MACRO_TERRAIN.schemaVersion });
  const seeds = { warpX: seed32(seed64, 1), warpZ: seed32(seed64, 2), macro: seed32(seed64, 3), hills: seed32(seed64, 4), ridges: seed32(seed64, 5), valleys: seed32(seed64, 6), detail: seed32(seed64, 7) };
  return Object.freeze({
    evaluate(x, z, amplitudeScale = 1) {
      const warpX = valueNoise(seeds.warpX, x, z, G5_MACRO_TERRAIN.domainWarp.spacingMeters) * G5_MACRO_TERRAIN.domainWarp.amplitudeMeters;
      const warpZ = valueNoise(seeds.warpZ, x, z, G5_MACRO_TERRAIN.domainWarp.spacingMeters) * G5_MACRO_TERRAIN.domainWarp.amplitudeMeters;
      const wx = x + warpX; const wz = z + warpZ;
      const macro = fractal(seeds.macro, wx, wz, G5_MACRO_TERRAIN.macro.spacingMeters, 3) * G5_MACRO_TERRAIN.macro.amplitudeMm;
      const hills = fractal(seeds.hills, wx, wz, G5_MACRO_TERRAIN.hills.spacingMeters, 3) * G5_MACRO_TERRAIN.hills.amplitudeMm;
      const ridgeNoise = fractal(seeds.ridges, wx, wz, G5_MACRO_TERRAIN.ridges.spacingMeters, 3);
      const ridges = (1 - Math.abs(ridgeNoise)) ** 2 * G5_MACRO_TERRAIN.ridges.amplitudeMm;
      const valleyNoise = fractal(seeds.valleys, wx, wz, G5_MACRO_TERRAIN.valleys.spacingMeters, 2);
      const valleys = -(Math.max(0, 1 - Math.abs(valleyNoise) * 2.4) ** 2) * G5_MACRO_TERRAIN.valleys.amplitudeMm;
      const localDetail = fractal(seeds.detail, x, z, G5_MACRO_TERRAIN.localDetail.spacingMeters, 2) * G5_MACRO_TERRAIN.localDetail.amplitudeMm;
      const offsetMm = clamp((macro + hills + ridges + valleys + localDetail) * amplitudeScale, -G5_MACRO_TERRAIN.maximumOffsetMm, G5_MACRO_TERRAIN.maximumOffsetMm);
      return { offsetMm, components: { macroMm: macro, hillsMm: hills, ridgesMm: ridges, valleysMm: valleys, localDetailMm: localDetail }, warp: { x: warpX, z: warpZ } };
    },
  });
}

function featureCorrection(point, features, rawOffsetMm) {
  const settings = G5_MACRO_TERRAIN.featureConstraints;
  const roadDistance = nearestDistance(point, features, new Set(['road', 'passage']));
  const influence = sampleFeatureTerrainInfluence(point, features);
  const road = smooth(1 - roadDistance / settings.roadRadiusMeters);
  const crossing = smooth(1 - influence.crossingDistance / settings.crossingRadiusMeters);
  const structure = smooth(1 - influence.boundaryDistance / settings.structureRadiusMeters);
  // Preserve the established riverbed and blend the Macro offset over a bank-scale
  // distance so the correction does not create an impassable cliff.
  const riverCore = smooth(1 - influence.river.distance / Math.max(6, influence.river.width * 3));
  const blend = Math.max(road * 0.48, crossing * 0.58, structure * 0.32);
  const limited = clamp(-rawOffsetMm * blend, -settings.maximumCorrectionMm, settings.maximumCorrectionMm);
  return -rawOffsetMm * riverCore + limited * (1 - riverCore);
}

export async function applyMacroTerrain({ chunk, worldFeatures, evaluator: sharedEvaluator }) {
  const terrain = structuredClone(chunk.terrain); const evaluator = sharedEvaluator ?? await createMacroTerrainEvaluator(chunk.worldSeedHash);
  const resolution = terrain.resolution; const spacing = CHUNK_SIZE_METERS / (resolution.x - 1); const features = [...worldFeatures].sort((a, b) => a.stableId.localeCompare(b.stableId));
  const heights = []; const macroBaseSlopes = []; const offsetsMm = [];
  const offsetAt = (worldX, worldZ, localX, localZ) => {
    const biome = biomeWeightsAt(chunk.biomeField, clamp(localX, 0, CHUNK_SIZE_METERS), clamp(localZ, 0, CHUNK_SIZE_METERS));
    const residential = biome['residential-low-density'] ?? 0; const riverbank = biome.riverbank ?? 0; const amplitudeScale = 1 - residential * 0.34 - riverbank * 0.08;
    const raw = evaluator.evaluate(worldX, worldZ, amplitudeScale).offsetMm;
    return raw + featureCorrection({ x: worldX, z: worldZ }, features, raw);
  };
  for (let z = 0; z < resolution.z; z += 1) for (let x = 0; x < resolution.x; x += 1) {
    const index = z * resolution.x + x; const localX = x * spacing; const localZ = z * spacing; const worldX = chunk.chunkCoordinate.x * CHUNK_SIZE_METERS + localX; const worldZ = chunk.chunkCoordinate.z * CHUNK_SIZE_METERS + localZ;
    const offsetMm = offsetAt(worldX, worldZ, localX, localZ); const heightMm = Math.round(terrain.heights[index] + offsetMm); const roundedOffset = Math.round(offsetMm); heights.push(Object.is(heightMm, -0) ? 0 : heightMm); offsetsMm.push(Object.is(roundedOffset, -0) ? 0 : roundedOffset);
    const d = G5_MACRO_TERRAIN.derivativeStepMeters;
    // The stored Macro slope is evaluated only from the globally addressable field.
    // Local Feature correction remains a render-height adjustment; Phase 2 may add a
    // separate final-surface normal contract once River Landscape is available.
    const dx = (evaluator.evaluate(worldX + d, worldZ).offsetMm - evaluator.evaluate(worldX - d, worldZ).offsetMm) * HEIGHT_UNIT_METERS / (2 * d);
    const dz = (evaluator.evaluate(worldX, worldZ + d).offsetMm - evaluator.evaluate(worldX, worldZ - d).offsetMm) * HEIGHT_UNIT_METERS / (2 * d);
    macroBaseSlopes.push(q6(Math.hypot(dx, dz)));
  }
  terrain.heights = heights;
  return { terrain, macroTerrain: { schemaVersion: G5_MACRO_TERRAIN.schemaVersion, macroBaseSlopes, offsetsMm,
    derivativeStepMeters: G5_MACRO_TERRAIN.derivativeStepMeters, diagnosticOnly: true } };
}
