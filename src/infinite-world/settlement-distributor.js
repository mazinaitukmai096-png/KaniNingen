import { SETTLEMENT_TYPES } from '../settlement-type.js';
import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { deriveLocalSeed64 } from './legacy-core/g0/deterministic-random.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import { createMacroTerrainEvaluator } from './legacy-core/g5/macro-terrain.js';
import { createNaturalBiomeEvaluator } from './natural-biome-field.js';

export const W5_SETTLEMENT_DISTRIBUTION = Object.freeze({
  schemaVersion: 'w5-settlement-distribution-1',
  macroRegionSizeMeters: 768,
  maximumInfluenceRadiusMeters: 220,
  minimumDistanceMeters: Object.freeze({
    [SETTLEMENT_TYPES.RURAL]: 640,
    [SETTLEMENT_TYPES.TOWN]: 960,
    [SETTLEMENT_TYPES.CITY]: 1536,
  }),
  urbanizationThresholds: Object.freeze({ town: 0.42, city: 0.67 }),
  minimumTerrainSuitability: 0.34,
  minimumProposalPriority: 0.24,
});

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const clamp = value => Math.max(0, Math.min(1, value));

function mix32(value) {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  result ^= result >>> 16;
  return result >>> 0;
}

function foldInteger(value) {
  if (!Number.isSafeInteger(value)) throw new RangeError('Macro Region coordinate must be safe');
  if (value >= -0x80000000 && value <= 0x7fffffff) return value >>> 0;
  return mix32((value >>> 0) ^ mix32(Math.trunc(value / 0x100000000) >>> 0));
}

function seed32(seed64) {
  return mix32(Number.parseInt(seed64.slice(0, 8), 16) ^ Number.parseInt(seed64.slice(8), 16));
}

function cellUnit(seed, x, z, salt) {
  return mix32(seed ^ Math.imul(foldInteger(x), 0x1f123bb5)
    ^ Math.imul(foldInteger(z), 0x5f356495) ^ Math.imul(salt, 0x9e3779b9)) / 0xffffffff;
}

function smooth(value) {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function regionField(seed, regionX, regionZ, spacingRegions, salt) {
  const gx = Math.floor(regionX / spacingRegions);
  const gz = Math.floor(regionZ / spacingRegions);
  const tx = smooth(regionX / spacingRegions - gx);
  const tz = smooth(regionZ / spacingRegions - gz);
  const at = (x, z) => cellUnit(seed, x, z, salt);
  return (at(gx, gz) * (1 - tx) + at(gx + 1, gz) * tx) * (1 - tz)
    + (at(gx, gz + 1) * (1 - tx) + at(gx + 1, gz + 1) * tx) * tz;
}

function chooseSettlementType(urbanization) {
  if (urbanization >= W5_SETTLEMENT_DISTRIBUTION.urbanizationThresholds.city) return SETTLEMENT_TYPES.CITY;
  if (urbanization >= W5_SETTLEMENT_DISTRIBUTION.urbanizationThresholds.town) return SETTLEMENT_TYPES.TOWN;
  return SETTLEMENT_TYPES.RURAL;
}

function chooseTownType(settlementType, roll) {
  if (settlementType === SETTLEMENT_TYPES.CITY) return 'capital';
  if (settlementType === SETTLEMENT_TYPES.TOWN) return roll < 0.5 ? 'church_town' : 'school_town';
  if (roll < 1 / 3) return 'residential';
  if (roll < 2 / 3) return 'military';
  return 'suburb';
}

function candidateWins(first, second) {
  if (first.selectionScore !== second.selectionScore) return first.selectionScore > second.selectionScore;
  if (first.macroRegion.z !== second.macroRegion.z) return first.macroRegion.z < second.macroRegion.z;
  return first.macroRegion.x < second.macroRegion.x;
}

function lruSet(map, key, value, capacity) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > capacity) map.delete(map.keys().next().value);
  return value;
}

export async function createSettlementDistributor({ worldSeedHash }) {
  const [distributionSeed64, macroEvaluator, biomeEvaluator] = await Promise.all([
    deriveLocalSeed64({
      worldSeedHash,
      namespace: 'w5-settlement-distribution',
      semanticKey: W5_SETTLEMENT_DISTRIBUTION.schemaVersion,
    }),
    createMacroTerrainEvaluator(worldSeedHash),
    createNaturalBiomeEvaluator({ worldSeedHash }),
  ]);
  const distributionSeed = seed32(distributionSeed64);
  const rawCache = new Map();
  const acceptedCache = new Map();
  const size = W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters;
  const maximumMinimumDistance = Math.max(...Object.values(W5_SETTLEMENT_DISTRIBUTION.minimumDistanceMeters));
  const conflictRegionRadius = Math.ceil((maximumMinimumDistance + size * 0.64) / size);

  function rawCandidate(regionX, regionZ) {
    const key = `${regionX},${regionZ}`;
    if (rawCache.has(key)) {
      const cached = rawCache.get(key); rawCache.delete(key); rawCache.set(key, cached); return cached;
    }
    const jitter = size * 0.32;
    const center = Object.freeze({
      x: q6((regionX + 0.5) * size + (cellUnit(distributionSeed, regionX, regionZ, 1) - 0.5) * jitter * 2),
      z: q6((regionZ + 0.5) * size + (cellUnit(distributionSeed, regionX, regionZ, 2) - 0.5) * jitter * 2),
    });
    const macro = macroEvaluator.evaluate(center.x, center.z);
    const derivativeStep = 8;
    const dx = (macroEvaluator.evaluate(center.x + derivativeStep, center.z).offsetMm
      - macroEvaluator.evaluate(center.x - derivativeStep, center.z).offsetMm) * 0.001 / (derivativeStep * 2);
    const dz = (macroEvaluator.evaluate(center.x, center.z + derivativeStep).offsetMm
      - macroEvaluator.evaluate(center.x, center.z - derivativeStep).offsetMm) * 0.001 / (derivativeStep * 2);
    const slope = Math.hypot(dx, dz);
    const biome = biomeEvaluator.evaluate(center, macro, slope);
    const weights = Object.fromEntries(biome.memberships.map(item => [item.biomeId, item.weight]));
    const terrainSuitability = q6(clamp(
      (1 - clamp(slope / 0.24))
      * (1 - (weights.wetland ?? 0) * 0.48)
      * (1 - (weights['rocky-highland'] ?? 0) * 0.3)
      * (0.78 + (weights['temperate-grassland'] ?? 0) * 0.14 + (weights['mixed-woodland'] ?? 0) * 0.08),
    ));
    const urbanization = q6(clamp(
      regionField(distributionSeed, regionX, regionZ, 6, 31) * 0.72
      + regionField(distributionSeed, regionX, regionZ, 17, 47) * 0.28,
    ));
    const proposalPriority = q6(cellUnit(distributionSeed, regionX, regionZ, 3));
    if (terrainSuitability < W5_SETTLEMENT_DISTRIBUTION.minimumTerrainSuitability
      || proposalPriority < W5_SETTLEMENT_DISTRIBUTION.minimumProposalPriority) {
      return lruSet(rawCache, key, null, 8192);
    }
    const settlementType = chooseSettlementType(urbanization);
    const townType = chooseTownType(
      settlementType,
      cellUnit(distributionSeed, regionX, regionZ, 4),
    );
    const candidate = Object.freeze({
      schemaVersion: 'w5-settlement-candidate-1',
      macroRegion: Object.freeze({ x: regionX, z: regionZ }),
      center,
      settlementType,
      townType,
      urbanization,
      terrainSuitability,
      proposalPriority,
      selectionScore: q6(terrainSuitability * 0.58 + proposalPriority * 0.34 + urbanization * 0.08),
      minimumDistanceMeters: W5_SETTLEMENT_DISTRIBUTION.minimumDistanceMeters[settlementType],
    });
    return lruSet(rawCache, key, candidate, 8192);
  }

  async function acceptedCandidate(regionX, regionZ) {
    const key = `${regionX},${regionZ}`;
    if (acceptedCache.has(key)) {
      const cached = acceptedCache.get(key); acceptedCache.delete(key); acceptedCache.set(key, cached); return cached;
    }
    const candidate = rawCandidate(regionX, regionZ);
    if (!candidate) return lruSet(acceptedCache, key, null, 4096);
    for (let dz = -conflictRegionRadius; dz <= conflictRegionRadius; dz += 1) {
      for (let dx = -conflictRegionRadius; dx <= conflictRegionRadius; dx += 1) {
        if (dx === 0 && dz === 0) continue;
        const other = rawCandidate(regionX + dx, regionZ + dz);
        if (!other) continue;
        const requiredDistance = Math.max(candidate.minimumDistanceMeters, other.minimumDistanceMeters);
        if (Math.hypot(candidate.center.x - other.center.x, candidate.center.z - other.center.z) >= requiredDistance) continue;
        if (candidateWins(other, candidate)) return lruSet(acceptedCache, key, null, 4096);
      }
    }
    const settlementId = `settlement-v1:${(await sha256Hex(canonicalizeJson({
      schema: W5_SETTLEMENT_DISTRIBUTION.schemaVersion,
      worldSeedHash,
      macroRegion: candidate.macroRegion,
      center: candidate.center,
      settlementType: candidate.settlementType,
      townType: candidate.townType,
    }))).slice(0, 24)}`;
    return lruSet(acceptedCache, key, Object.freeze({ ...candidate, settlementId }), 4096);
  }

  async function findInMacroRange(minRegionX, maxRegionX, minRegionZ, maxRegionZ) {
    const tasks = [];
    for (let z = minRegionZ; z <= maxRegionZ; z += 1) {
      for (let x = minRegionX; x <= maxRegionX; x += 1) tasks.push(acceptedCandidate(x, z));
    }
    return (await Promise.all(tasks)).filter(Boolean).sort((a, b) => (
      a.macroRegion.z - b.macroRegion.z || a.macroRegion.x - b.macroRegion.x
    ));
  }

  async function findSettlementsNear(x, z, radiusMeters) {
    if (![x, z, radiusMeters].every(Number.isFinite) || radiusMeters < 0) throw new TypeError('invalid Settlement query');
    const expansion = radiusMeters + W5_SETTLEMENT_DISTRIBUTION.maximumInfluenceRadiusMeters;
    const minRegionX = Math.floor((x - expansion) / size);
    const maxRegionX = Math.floor((x + expansion) / size);
    const minRegionZ = Math.floor((z - expansion) / size);
    const maxRegionZ = Math.floor((z + expansion) / size);
    const candidates = await findInMacroRange(minRegionX, maxRegionX, minRegionZ, maxRegionZ);
    return candidates.filter(candidate => Math.hypot(candidate.center.x - x, candidate.center.z - z)
      <= expansion);
  }

  async function findNearestSettlement(x = 0, z = 0, maximumRings = 12) {
    const originRegionX = Math.floor(x / size);
    const originRegionZ = Math.floor(z / size);
    for (let ring = 0; ring <= maximumRings; ring += 1) {
      const candidates = await findInMacroRange(
        originRegionX - ring,
        originRegionX + ring,
        originRegionZ - ring,
        originRegionZ + ring,
      );
      if (candidates.length) return candidates.sort((a, b) => (
        Math.hypot(a.center.x - x, a.center.z - z) - Math.hypot(b.center.x - x, b.center.z - z)
        || a.settlementId.localeCompare(b.settlementId)
      ))[0];
    }
    throw new RangeError('no Settlement Candidate found within the review search radius');
  }

  return Object.freeze({
    schemaVersion: W5_SETTLEMENT_DISTRIBUTION.schemaVersion,
    worldSeedHash,
    rawCandidate,
    acceptedCandidate,
    findInMacroRange,
    findSettlementsNear,
    findNearestSettlement,
    snapshot: () => Object.freeze({
      rawCacheSize: rawCache.size,
      acceptedCacheSize: acceptedCache.size,
      rawCacheCapacity: 8192,
      acceptedCacheCapacity: 4096,
    }),
  });
}
