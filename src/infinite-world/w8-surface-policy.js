import { LOGICAL_CHUNK_SIZE_METERS } from './chunk-coordinates.js';
import { sampleFormalTerrainHeightMeters } from './player-vertical-movement.js';
import {
  FINITE_WORLD_UNITS_PER_METER,
  MIGRATED_SETTLEMENT_PROFILES,
} from './single-rural-settlement.js';
import { resolveCanonicalRiverBed } from './canonical-river-realization.js';

export const W8_SURFACE_POLICY_IDS = Object.freeze({
  SETTLEMENT_GRADED: 'SETTLEMENT_GRADED',
  NATURAL_TERRAIN: 'NATURAL_TERRAIN',
});

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const smoothstep = value => value * value * (3 - 2 * value);
const srgbChannelToLinear = channel => (
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
);
const rgb = hex => [
  hex >> 16 & 0xff,
  hex >> 8 & 0xff,
  hex & 0xff,
].map(channel => srgbChannelToLinear(channel / 255));
const mixColor = (left, right, weight) => left.map((channel, index) =>
  channel + (right[index] - channel) * weight);

export function finiteSettlementSurfaceColorRgb(worldX, worldZ) {
  const base = rgb(0x7d8f4f);
  const dark = rgb(0x5c6b38);
  const green = rgb(0x8fae4f);
  const dirt = rgb(0x9a8264);
  const finiteX = worldX * FINITE_WORLD_UNITS_PER_METER;
  const finiteZ = worldZ * FINITE_WORLD_UNITS_PER_METER;
  const noise = (Math.sin(finiteX * 0.0004) * Math.cos(finiteZ * 0.0004)
    + Math.sin(finiteX * 0.0015 + finiteZ * 0.001) * 0.5) / 1.5;
  if (noise > 0.1) return Object.freeze(mixColor(base, green, Math.min(1, (noise - 0.1) * 1.3)));
  if (noise < -0.35) return Object.freeze(mixColor(base, dirt, Math.min(1, (-noise - 0.35) * 1.8)));
  if (noise < -0.1) return Object.freeze(mixColor(base, dark, Math.min(1, (-noise - 0.1) * 1.5)));
  return Object.freeze(base);
}

export function resolveCanonicalSurfaceColorRgb({ naturalColor, surface, worldX, worldZ }) {
  if (!Array.isArray(naturalColor) || naturalColor.length !== 3) {
    throw new TypeError('naturalColor must contain three channels');
  }
  const finiteColor = finiteSettlementSurfaceColorRgb(worldX, worldZ);
  return Object.freeze(naturalColor.map((channel, index) =>
    finiteColor[index] * surface.finiteWeight + channel * surface.naturalWeight));
}

function regionForReference(reference) {
  const profile = MIGRATED_SETTLEMENT_PROFILES[reference?.townType];
  if (!profile || profile.settlementType !== reference?.settlementType) return null;
  return Object.freeze({
    settlementId: reference.settlementId,
    settlementType: reference.settlementType,
    townType: reference.townType,
    center: Object.freeze({ ...reference.center }),
    flatCoreRadiusMeters: q6(profile.coreRadius / FINITE_WORLD_UNITS_PER_METER),
    transitionWidthMeters: q6((profile.radius - profile.coreRadius)
      / FINITE_WORLD_UNITS_PER_METER),
  });
}

export function createSettlementSurfacePolicy(settlementReferences = [], riverCorridors = []) {
  const regionsById = new Map();
  for (const reference of settlementReferences) {
    const region = regionForReference(reference);
    if (region) regionsById.set(region.settlementId, region);
  }
  return Object.freeze({
    schemaVersion: 'w8-settlement-surface-policy-1',
    regions: Object.freeze([...regionsById.values()]
      .sort((left, right) => left.settlementId.localeCompare(right.settlementId))),
    riverCorridors: Object.freeze([...riverCorridors]
      .filter(corridor => corridor?.schemaVersion === 'w8-canonical-river-surface-corridor-1')
      .sort((left, right) => (
        left.sourceStableId.localeCompare(right.sourceStableId)
        || JSON.stringify(left.centerlines).localeCompare(JSON.stringify(right.centerlines))
      ))),
  });
}

export function resolveCanonicalSurfaceWeights(policy, worldX, worldZ) {
  let naturalWeight = 1;
  let settlementId = null;
  for (const region of policy?.regions ?? []) {
    const distance = Math.hypot(worldX - region.center.x, worldZ - region.center.z);
    let regionNaturalWeight = 1;
    if (distance <= region.flatCoreRadiusMeters) regionNaturalWeight = 0;
    else if (distance < region.flatCoreRadiusMeters + region.transitionWidthMeters) {
      regionNaturalWeight = smoothstep(
        (distance - region.flatCoreRadiusMeters) / region.transitionWidthMeters,
      );
    }
    if (regionNaturalWeight < naturalWeight) {
      naturalWeight = regionNaturalWeight;
      settlementId = region.settlementId;
    }
  }
  naturalWeight = q6(naturalWeight);
  return Object.freeze({
    policyId: naturalWeight < 1
      ? W8_SURFACE_POLICY_IDS.SETTLEMENT_GRADED
      : W8_SURFACE_POLICY_IDS.NATURAL_TERRAIN,
    settlementId,
    naturalWeight,
    finiteWeight: q6(1 - naturalWeight),
  });
}

export function resolveCanonicalGroundSurface({ chunkData, worldX, worldZ }) {
  const source = chunkData?.sourceChunkData ?? chunkData;
  if (!source?.terrain) throw new TypeError('W5-backed ChunkData is required');
  if (![worldX, worldZ].every(Number.isFinite)) throw new TypeError('finite world coordinates are required');
  const minimumX = source.chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const minimumZ = source.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const epsilon = 1e-9;
  const sampleX = Math.max(minimumX + epsilon,
    Math.min(minimumX + LOGICAL_CHUNK_SIZE_METERS, worldX));
  const sampleZ = Math.max(minimumZ + epsilon,
    Math.min(minimumZ + LOGICAL_CHUNK_SIZE_METERS, worldZ));
  const naturalHeightMeters = sampleFormalTerrainHeightMeters(source, sampleX, sampleZ);
  const weights = resolveCanonicalSurfaceWeights(
    chunkData?.canonicalSurfacePolicy,
    worldX,
    worldZ,
  );
  const baseHeightMeters = naturalHeightMeters * weights.naturalWeight;
  const river = resolveCanonicalRiverBed(
    chunkData?.canonicalSurfacePolicy?.riverCorridors,
    worldX,
    worldZ,
  );
  const riverSurfaceHeightMeters = river.depthMeters > 0 ? baseHeightMeters : null;
  return Object.freeze({
    ...weights,
    heightMeters: q6(baseHeightMeters - river.depthMeters),
    baseHeightMeters: q6(baseHeightMeters),
    naturalHeightMeters: q6(naturalHeightMeters),
    riverStableId: river.sourceStableId,
    riverDistanceMeters: Number.isFinite(river.distanceMeters)
      ? q6(river.distanceMeters) : null,
    riverDepthMeters: q6(river.depthMeters),
    riverBankWeight: q6(river.bankWeight),
    riverSurfaceHeightMeters: riverSurfaceHeightMeters === null
      ? null : q6(riverSurfaceHeightMeters),
  });
}

export function sampleW8SurfaceHeightMeters(chunkData, worldX, worldZ) {
  return resolveCanonicalGroundSurface({ chunkData, worldX, worldZ }).heightMeters;
}
