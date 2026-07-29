import { SETTLEMENT_TYPES } from '../settlement-type.js';
import { canonicalizeJson } from './legacy-core/g0/canonical-json.js';
import { deriveLocalSeed64 } from './legacy-core/g0/deterministic-random.js';
import { sha256Hex } from './legacy-core/g0/sha256.js';
import { createMacroTerrainEvaluator } from './legacy-core/g5/macro-terrain.js';
import { createNaturalBiomeEvaluator } from './natural-biome-field.js';
import {
  FINITE_WORLD_UNITS_PER_METER,
  MIGRATED_SETTLEMENT_PROFILES,
} from './single-rural-settlement.js';

const finiteDistanceMeters = (first, second) => Math.round(
  Math.hypot(first.x - second.x, first.z - second.z)
    / FINITE_WORLD_UNITS_PER_METER * 1e6,
) / 1e6;
const median = values => {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 1e6) / 1e6;
};
const FINITE_TOWN_CENTERS = Object.freeze({
  capital: Object.freeze({ x: 0, z: 0 }),
  church_town: Object.freeze({ x: 7_500, z: 7_500 }),
  school_town: Object.freeze({ x: -8_250, z: 6_750 }),
  residential: Object.freeze({ x: 7_500, z: -7_500 }),
  military: Object.freeze({ x: -7_500, z: -8_250 }),
  suburb: Object.freeze({ x: 0, z: 11_250 }),
});

const TYPE_PAIR_MINIMUM_DISTANCE_METERS = Object.freeze({
  [SETTLEMENT_TYPES.CITY]: Object.freeze({
    // finite has one CITY. Two existing 768m Macro Regions keep CITY a regional hub.
    [SETTLEMENT_TYPES.CITY]: 1_536,
    [SETTLEMENT_TYPES.TOWN]: median(['church_town', 'school_town'].map(role => (
      finiteDistanceMeters(FINITE_TOWN_CENTERS.capital, FINITE_TOWN_CENTERS[role])
    ))),
    [SETTLEMENT_TYPES.RURAL]: median(['residential', 'military', 'suburb'].map(role => (
      finiteDistanceMeters(FINITE_TOWN_CENTERS.capital, FINITE_TOWN_CENTERS[role])
    ))),
  }),
  [SETTLEMENT_TYPES.TOWN]: Object.freeze({
    [SETTLEMENT_TYPES.CITY]: median(['church_town', 'school_town'].map(role => (
      finiteDistanceMeters(FINITE_TOWN_CENTERS.capital, FINITE_TOWN_CENTERS[role])
    ))),
    [SETTLEMENT_TYPES.TOWN]: finiteDistanceMeters(
      FINITE_TOWN_CENTERS.church_town,
      FINITE_TOWN_CENTERS.school_town,
    ),
    [SETTLEMENT_TYPES.RURAL]: median(['church_town', 'school_town'].flatMap(townRole => (
      ['residential', 'military', 'suburb'].map(ruralRole => finiteDistanceMeters(
        FINITE_TOWN_CENTERS[townRole],
        FINITE_TOWN_CENTERS[ruralRole],
      ))
    ))),
  }),
  [SETTLEMENT_TYPES.RURAL]: Object.freeze({
    [SETTLEMENT_TYPES.CITY]: median(['residential', 'military', 'suburb'].map(role => (
      finiteDistanceMeters(FINITE_TOWN_CENTERS.capital, FINITE_TOWN_CENTERS[role])
    ))),
    [SETTLEMENT_TYPES.TOWN]: median(['church_town', 'school_town'].flatMap(townRole => (
      ['residential', 'military', 'suburb'].map(ruralRole => finiteDistanceMeters(
        FINITE_TOWN_CENTERS[townRole],
        FINITE_TOWN_CENTERS[ruralRole],
      ))
    ))),
    [SETTLEMENT_TYPES.RURAL]: median([
      finiteDistanceMeters(FINITE_TOWN_CENTERS.residential, FINITE_TOWN_CENTERS.military),
      finiteDistanceMeters(FINITE_TOWN_CENTERS.residential, FINITE_TOWN_CENTERS.suburb),
      finiteDistanceMeters(FINITE_TOWN_CENTERS.military, FINITE_TOWN_CENTERS.suburb),
    ]),
  }),
});

// Home selection keeps continuity with a primary Settlement that was already
// viable under the pre-Phase-5F spacing contract. Regional distribution still
// uses the finite-derived type-pair contract below; this only prevents a newly
// unblocked, closer proposal from silently moving an existing world's start.
const HOME_PRIMARY_CONTINUITY_DISTANCE_METERS = Object.freeze({
  [SETTLEMENT_TYPES.RURAL]: 640,
  [SETTLEMENT_TYPES.TOWN]: 960,
  [SETTLEMENT_TYPES.CITY]: 1_536,
});

export const W5_SETTLEMENT_DISTRIBUTION = Object.freeze({
  schemaVersion: 'w5-settlement-distribution-1',
  regionalParityVersion: 'phase5f-regional-settlement-parity-1',
  macroRegionSizeMeters: 768,
  maximumInfluenceRadiusMeters: 220,
  proposalSlotsPerMacroRegion: 2,
  maximumSettlementsPerMacroRegion: 1,
  minimumDistanceMeters: Object.freeze({
    [SETTLEMENT_TYPES.RURAL]: TYPE_PAIR_MINIMUM_DISTANCE_METERS.RURAL.RURAL,
    [SETTLEMENT_TYPES.TOWN]: TYPE_PAIR_MINIMUM_DISTANCE_METERS.TOWN.TOWN,
    [SETTLEMENT_TYPES.CITY]: 1536,
  }),
  minimumDistanceMetersByTypePair: TYPE_PAIR_MINIMUM_DISTANCE_METERS,
  urbanizationThresholds: Object.freeze({ town: 0.42, city: 0.67 }),
  minimumTerrainSuitability: 0.34,
  minimumProposalPriority: 0.55,
  home: Object.freeze({
    nearbyRadiusMeters: 1_000,
    minimumNearbySettlementCount: 1,
    normalMovementMetersPerSecond: 16.5,
    firstFiveMinutesSeconds: 300,
  }),
  connectivity: Object.freeze({
    queryRadiusMeters: 1_536,
    maximumNeighborsByType: Object.freeze({
      [SETTLEMENT_TYPES.CITY]: 3,
      [SETTLEMENT_TYPES.TOWN]: 2,
      [SETTLEMENT_TYPES.RURAL]: 2,
    }),
  }),
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

function typePairMinimumDistance(firstType, secondType) {
  const distance = W5_SETTLEMENT_DISTRIBUTION
    .minimumDistanceMetersByTypePair[firstType]?.[secondType];
  if (!Number.isFinite(distance)) throw new RangeError('unsupported Settlement type pair');
  return distance;
}

function profileRadiusMeters(townType) {
  const radius = MIGRATED_SETTLEMENT_PROFILES[townType]?.radius;
  if (!Number.isFinite(radius)) throw new RangeError(`unsupported Settlement role: ${townType}`);
  return q6(radius / FINITE_WORLD_UNITS_PER_METER);
}

function candidateWins(first, second) {
  if (first.proposalKind !== second.proposalKind) return first.proposalKind === 'PRIMARY';
  if (first.selectionScore !== second.selectionScore) return first.selectionScore > second.selectionScore;
  if (first.macroRegion.z !== second.macroRegion.z) return first.macroRegion.z < second.macroRegion.z;
  if (first.macroRegion.x !== second.macroRegion.x) return first.macroRegion.x < second.macroRegion.x;
  return first.proposalSlot < second.proposalSlot;
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
  const connectivityNeighborCache = new Map();
  let isShutdown = false;
  const assertActive = () => {
    if (isShutdown) throw new Error('Settlement distributor is shut down');
  };
  const size = W5_SETTLEMENT_DISTRIBUTION.macroRegionSizeMeters;
  const maximumMinimumDistance = Math.max(...Object.values(
    W5_SETTLEMENT_DISTRIBUTION.minimumDistanceMetersByTypePair,
  ).flatMap(value => Object.values(value)));
  const conflictRegionRadius = Math.ceil((maximumMinimumDistance + size * 0.64) / size);

  function rawCandidate(regionX, regionZ, proposalSlot = 0) {
    assertActive();
    if (!Number.isInteger(proposalSlot)
      || proposalSlot < 0
      || proposalSlot >= W5_SETTLEMENT_DISTRIBUTION.proposalSlotsPerMacroRegion) {
      throw new RangeError('invalid Settlement proposal slot');
    }
    const key = `${regionX},${regionZ},${proposalSlot}`;
    if (rawCache.has(key)) {
      const cached = rawCache.get(key); rawCache.delete(key); rawCache.set(key, cached); return cached;
    }
    const proposalKind = proposalSlot === 0 ? 'PRIMARY' : 'AUXILIARY';
    const auxiliaryCell = proposalSlot === 0 ? 0 : Math.min(3, Math.floor(
      cellUnit(distributionSeed, regionX, regionZ, 97) * 4,
    ));
    const cellX = auxiliaryCell & 1;
    const cellZ = auxiliaryCell >> 1;
    const proposalSize = proposalKind === 'PRIMARY' ? size : size / 2;
    const proposalX = proposalKind === 'PRIMARY' ? regionX : regionX * 2 + cellX;
    const proposalZ = proposalKind === 'PRIMARY' ? regionZ : regionZ * 2 + cellZ;
    const saltOffset = proposalSlot * 11;
    const jitter = proposalSize * 0.32;
    const center = Object.freeze({
      x: q6((proposalX + 0.5) * proposalSize
        + (cellUnit(distributionSeed, proposalX, proposalZ, 1 + saltOffset) - 0.5) * jitter * 2),
      z: q6((proposalZ + 0.5) * proposalSize
        + (cellUnit(distributionSeed, proposalX, proposalZ, 2 + saltOffset) - 0.5) * jitter * 2),
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
    const urbanSampleX = proposalKind === 'PRIMARY' ? regionX : center.x / size - 0.5;
    const urbanSampleZ = proposalKind === 'PRIMARY' ? regionZ : center.z / size - 0.5;
    const urbanization = q6(clamp(
      regionField(distributionSeed, urbanSampleX, urbanSampleZ, 6, 31) * 0.72
      + regionField(distributionSeed, urbanSampleX, urbanSampleZ, 17, 47) * 0.28,
    ));
    const proposalPriority = q6(cellUnit(
      distributionSeed,
      proposalX,
      proposalZ,
      3 + saltOffset,
    ));
    if (terrainSuitability < W5_SETTLEMENT_DISTRIBUTION.minimumTerrainSuitability
      || proposalPriority < W5_SETTLEMENT_DISTRIBUTION.minimumProposalPriority) {
      return lruSet(rawCache, key, null, 8192);
    }
    const settlementType = chooseSettlementType(urbanization);
    const townType = chooseTownType(
      settlementType,
      cellUnit(distributionSeed, proposalX, proposalZ, 4 + saltOffset),
    );
    const candidate = Object.freeze({
      schemaVersion: 'w5-settlement-candidate-1',
      macroRegion: Object.freeze({ x: regionX, z: regionZ }),
      proposalKind,
      proposalSlot,
      proposalCell: Object.freeze({ x: proposalX, z: proposalZ }),
      center,
      settlementType,
      townType,
      radiusMeters: profileRadiusMeters(townType),
      urbanization,
      terrainSuitability,
      proposalPriority,
      selectionScore: q6(terrainSuitability * 0.58 + proposalPriority * 0.34 + urbanization * 0.08),
      minimumDistanceMeters: W5_SETTLEMENT_DISTRIBUTION.minimumDistanceMeters[settlementType],
      eligibility: Object.freeze({
        biomeAndSlope: terrainSuitability >= W5_SETTLEMENT_DISTRIBUTION.minimumTerrainSuitability,
        regionalUrbanization: settlementType === chooseSettlementType(urbanization),
      }),
    });
    return lruSet(rawCache, key, candidate, 8192);
  }

  function rawCandidatesInRegion(regionX, regionZ) {
    return Array.from(
      { length: W5_SETTLEMENT_DISTRIBUTION.proposalSlotsPerMacroRegion },
      (_, proposalSlot) => rawCandidate(regionX, regionZ, proposalSlot),
    ).filter(Boolean);
  }

  function hasHomePrimaryContinuity(candidate) {
    if (candidate.proposalKind !== 'PRIMARY') return false;
    for (let dz = -conflictRegionRadius; dz <= conflictRegionRadius; dz += 1) {
      for (let dx = -conflictRegionRadius; dx <= conflictRegionRadius; dx += 1) {
        const other = rawCandidate(
          candidate.macroRegion.x + dx,
          candidate.macroRegion.z + dz,
          0,
        );
        if (!other || other === candidate) continue;
        const requiredDistance = Math.max(
          HOME_PRIMARY_CONTINUITY_DISTANCE_METERS[candidate.settlementType],
          HOME_PRIMARY_CONTINUITY_DISTANCE_METERS[other.settlementType],
        );
        if (Math.hypot(
          candidate.center.x - other.center.x,
          candidate.center.z - other.center.z,
        ) >= requiredDistance) continue;
        if (candidateWins(other, candidate)) return false;
      }
    }
    return true;
  }

  async function acceptedCandidate(regionX, regionZ, proposalSlot = 0) {
    const key = `${regionX},${regionZ},${proposalSlot}`;
    if (acceptedCache.has(key)) {
      const cached = acceptedCache.get(key); acceptedCache.delete(key); acceptedCache.set(key, cached); return cached;
    }
    const candidate = rawCandidate(regionX, regionZ, proposalSlot);
    if (!candidate) return lruSet(acceptedCache, key, null, 4096);
    const regionRanked = rawCandidatesInRegion(regionX, regionZ).sort((first, second) => (
      candidateWins(first, second) ? -1 : candidateWins(second, first) ? 1 : 0
    ));
    if (regionRanked.indexOf(candidate)
      >= W5_SETTLEMENT_DISTRIBUTION.maximumSettlementsPerMacroRegion) {
      return lruSet(acceptedCache, key, null, 4096);
    }
    for (let dz = -conflictRegionRadius; dz <= conflictRegionRadius; dz += 1) {
      for (let dx = -conflictRegionRadius; dx <= conflictRegionRadius; dx += 1) {
        for (const other of rawCandidatesInRegion(regionX + dx, regionZ + dz)) {
          if (other === candidate) continue;
          const requiredDistance = typePairMinimumDistance(
            candidate.settlementType,
            other.settlementType,
          );
          if (Math.hypot(candidate.center.x - other.center.x, candidate.center.z - other.center.z)
            >= requiredDistance) continue;
          if (candidateWins(other, candidate)) return lruSet(acceptedCache, key, null, 4096);
        }
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
    if (isShutdown) return Object.freeze({ ...candidate, settlementId });
    return lruSet(acceptedCache, key, Object.freeze({ ...candidate, settlementId }), 4096);
  }

  async function findInMacroRange(minRegionX, maxRegionX, minRegionZ, maxRegionZ) {
    const tasks = [];
    for (let z = minRegionZ; z <= maxRegionZ; z += 1) {
      for (let x = minRegionX; x <= maxRegionX; x += 1) {
        for (let proposalSlot = 0;
          proposalSlot < W5_SETTLEMENT_DISTRIBUTION.proposalSlotsPerMacroRegion;
          proposalSlot += 1) tasks.push(acceptedCandidate(x, z, proposalSlot));
      }
    }
    return (await Promise.all(tasks)).filter(Boolean).sort((a, b) => (
      a.macroRegion.z - b.macroRegion.z
      || a.macroRegion.x - b.macroRegion.x
      || a.proposalSlot - b.proposalSlot
    ));
  }

  async function findSettlementCentersNear(x, z, radiusMeters) {
    if (![x, z, radiusMeters].every(Number.isFinite) || radiusMeters < 0) {
      throw new TypeError('invalid Settlement center query');
    }
    const minRegionX = Math.floor((x - radiusMeters) / size);
    const maxRegionX = Math.floor((x + radiusMeters) / size);
    const minRegionZ = Math.floor((z - radiusMeters) / size);
    const maxRegionZ = Math.floor((z + radiusMeters) / size);
    const candidates = await findInMacroRange(minRegionX, maxRegionX, minRegionZ, maxRegionZ);
    return candidates.filter(candidate => Math.hypot(
      candidate.center.x - x,
      candidate.center.z - z,
    ) <= radiusMeters);
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

  async function findHomeSettlement(x = 0, z = 0, maximumRings = 12) {
    const originRegionX = Math.floor(x / size);
    const originRegionZ = Math.floor(z / size);
    let qualifiedFallback = null;
    let fallback = null;
    for (let ring = 0; ring <= maximumRings; ring += 1) {
      const candidates = await findInMacroRange(
        originRegionX - ring,
        originRegionX + ring,
        originRegionZ - ring,
        originRegionZ + ring,
      );
      const audited = await Promise.all(candidates.map(async candidate => {
        const neighbors = (await findSettlementCentersNear(
          candidate.center.x,
          candidate.center.z,
          W5_SETTLEMENT_DISTRIBUTION.home.nearbyRadiusMeters,
        )).filter(other => other.settlementId !== candidate.settlementId);
        return {
          candidate,
          neighborCount: neighbors.length,
          primaryContinuity: hasHomePrimaryContinuity(candidate),
        };
      }));
      audited.sort((first, second) => (
        Math.hypot(first.candidate.center.x - x, first.candidate.center.z - z)
          - Math.hypot(second.candidate.center.x - x, second.candidate.center.z - z)
        || second.neighborCount - first.neighborCount
        || first.candidate.settlementId.localeCompare(second.candidate.settlementId)
      ));
      const qualified = audited.filter(value => (
        value.neighborCount >= W5_SETTLEMENT_DISTRIBUTION.home.minimumNearbySettlementCount
      ));
      const continuous = qualified.find(value => value.primaryContinuity);
      if (continuous) return continuous.candidate;
      if (!qualifiedFallback && qualified.length) qualifiedFallback = qualified[0];
      const best = [...audited].sort((first, second) => (
        second.neighborCount - first.neighborCount
        || Math.hypot(first.candidate.center.x - x, first.candidate.center.z - z)
          - Math.hypot(second.candidate.center.x - x, second.candidate.center.z - z)
        || first.candidate.settlementId.localeCompare(second.candidate.settlementId)
      ))[0];
      if (best && (!fallback || best.neighborCount > fallback.neighborCount)) fallback = best;
    }
    if (qualifiedFallback) return qualifiedFallback.candidate;
    if (fallback) return fallback.candidate;
    throw new RangeError('no Settlement Candidate found within the home search radius');
  }

  async function buildConnectivityGraphNear(x, z, radiusMeters) {
    const preference = Object.freeze({
      [SETTLEMENT_TYPES.CITY]: Object.freeze([
        SETTLEMENT_TYPES.TOWN,
        SETTLEMENT_TYPES.CITY,
        SETTLEMENT_TYPES.RURAL,
      ]),
      [SETTLEMENT_TYPES.TOWN]: Object.freeze([
        SETTLEMENT_TYPES.CITY,
        SETTLEMENT_TYPES.TOWN,
        SETTLEMENT_TYPES.RURAL,
      ]),
      [SETTLEMENT_TYPES.RURAL]: Object.freeze([
        SETTLEMENT_TYPES.TOWN,
        SETTLEMENT_TYPES.CITY,
        SETTLEMENT_TYPES.RURAL,
      ]),
    });
    const canonicalNeighborsFor = async candidate => {
      if (connectivityNeighborCache.has(candidate.settlementId)) {
        const cached = connectivityNeighborCache.get(candidate.settlementId);
        connectivityNeighborCache.delete(candidate.settlementId);
        connectivityNeighborCache.set(candidate.settlementId, cached);
        return cached;
      }
      const nearby = await findSettlementCentersNear(
        candidate.center.x,
        candidate.center.z,
        W5_SETTLEMENT_DISTRIBUTION.connectivity.queryRadiusMeters,
      );
      const limit = W5_SETTLEMENT_DISTRIBUTION.connectivity
        .maximumNeighborsByType[candidate.settlementType];
      const selected = nearby.filter(other => other.settlementId !== candidate.settlementId)
        .sort((first, second) => (
          preference[candidate.settlementType].indexOf(first.settlementType)
            - preference[candidate.settlementType].indexOf(second.settlementType)
          || Math.hypot(candidate.center.x - first.center.x, candidate.center.z - first.center.z)
            - Math.hypot(candidate.center.x - second.center.x, candidate.center.z - second.center.z)
          || first.settlementId.localeCompare(second.settlementId)
        ))
        .slice(0, limit);
      if (isShutdown) return Object.freeze(selected);
      return lruSet(
        connectivityNeighborCache,
        candidate.settlementId,
        Object.freeze(selected),
        4096,
      );
    };

    const coreNodes = await findSettlementCentersNear(x, z, radiusMeters);
    const neighborLists = await Promise.all(coreNodes.map(canonicalNeighborsFor));
    const byId = new Map(coreNodes.map(candidate => [candidate.settlementId, candidate]));
    for (const neighbors of neighborLists) {
      for (const candidate of neighbors) byId.set(candidate.settlementId, candidate);
    }
    const nodes = [...byId.values()].sort((first, second) => (
      first.settlementId.localeCompare(second.settlementId)
    ));
    const edgeMap = new Map();
    for (let candidateIndex = 0; candidateIndex < coreNodes.length; candidateIndex += 1) {
      const candidate = coreNodes[candidateIndex];
      for (const other of neighborLists[candidateIndex]) {
        const endpointIds = [candidate.settlementId, other.settlementId].sort();
        const edgeKey = endpointIds.join('|');
        if (edgeMap.has(edgeKey)) continue;
        const endpoints = endpointIds.map(id => byId.get(id));
        const owner = [...endpoints].sort((first, second) => (
          first.macroRegion.z - second.macroRegion.z
          || first.macroRegion.x - second.macroRegion.x
          || first.settlementId.localeCompare(second.settlementId)
        ))[0];
        edgeMap.set(edgeKey, Object.freeze({
          schemaVersion: 'w5-settlement-connectivity-edge-1',
          stableId: `settlement-connectivity-v1:${endpointIds.join(':')}`,
          settlementIds: Object.freeze(endpointIds),
          ownerRegion: owner.macroRegion,
          distanceMeters: q6(Math.hypot(
            endpoints[0].center.x - endpoints[1].center.x,
            endpoints[0].center.z - endpoints[1].center.z,
          )),
        }));
      }
    }
    const edges = [...edgeMap.values()].sort((first, second) => (
      first.stableId.localeCompare(second.stableId)
    ));
    const tier = Object.freeze({
      [SETTLEMENT_TYPES.CITY]: 'REGIONAL_HUB',
      [SETTLEMENT_TYPES.TOWN]: 'LOCAL_CENTER',
      [SETTLEMENT_TYPES.RURAL]: 'LOCAL',
    });
    return Object.freeze({
      schemaVersion: 'w5-settlement-connectivity-graph-1',
      center: Object.freeze({ x: q6(x), z: q6(z) }),
      radiusMeters: q6(radiusMeters),
      nodes: Object.freeze(nodes.map(candidate => Object.freeze({
        stableId: candidate.settlementId,
        ownerRegion: candidate.macroRegion,
        settlementType: candidate.settlementType,
        role: candidate.townType,
        center: candidate.center,
        radiusMeters: candidate.radiusMeters,
        connectivityTier: tier[candidate.settlementType],
        candidateNeighborIds: Object.freeze(edges
          .filter(edge => edge.settlementIds.includes(candidate.settlementId))
          .map(edge => edge.settlementIds.find(id => id !== candidate.settlementId))
          .sort()),
        isolationReason: edges.some(edge => edge.settlementIds.includes(candidate.settlementId))
          ? null : 'NO_SETTLEMENT_WITHIN_CANONICAL_CONNECTIVITY_RADIUS',
      }))),
      edges: Object.freeze(edges),
    });
  }

  return Object.freeze({
    schemaVersion: W5_SETTLEMENT_DISTRIBUTION.schemaVersion,
    worldSeedHash,
    rawCandidate,
    acceptedCandidate,
    findInMacroRange,
    findSettlementCentersNear,
    findSettlementsNear,
    findNearestSettlement,
    findHomeSettlement,
    buildConnectivityGraphNear,
    async shutdown() {
      if (isShutdown) return;
      isShutdown = true;
      rawCache.clear();
      acceptedCache.clear();
      connectivityNeighborCache.clear();
    },
    snapshot: () => Object.freeze({
      isShutdown,
      rawCacheSize: rawCache.size,
      rawCandidateCount: [...rawCache.values()].filter(Boolean).length,
      rawPrimaryCandidateCount: [...rawCache.values()].filter(value => (
        value?.proposalKind === 'PRIMARY'
      )).length,
      rawAuxiliaryCandidateCount: [...rawCache.values()].filter(value => (
        value?.proposalKind === 'AUXILIARY'
      )).length,
      acceptedCacheSize: acceptedCache.size,
      acceptedSettlementCount: [...acceptedCache.values()].filter(Boolean).length,
      acceptedPrimarySettlementCount: [...acceptedCache.values()].filter(value => (
        value?.proposalKind === 'PRIMARY'
      )).length,
      acceptedAuxiliarySettlementCount: [...acceptedCache.values()].filter(value => (
        value?.proposalKind === 'AUXILIARY'
      )).length,
      connectivityNeighborCacheSize: connectivityNeighborCache.size,
      connectivityNeighborCacheCapacity: 4096,
      proposalSlotsPerMacroRegion: W5_SETTLEMENT_DISTRIBUTION.proposalSlotsPerMacroRegion,
      maximumSettlementsPerMacroRegion: W5_SETTLEMENT_DISTRIBUTION.maximumSettlementsPerMacroRegion,
      rawCacheCapacity: 8192,
      acceptedCacheCapacity: 4096,
    }),
  });
}
