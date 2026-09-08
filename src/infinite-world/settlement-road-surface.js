import { logicalWorldToOwnedChunk } from './chunk-coordinates.js';
import { FINITE_WORLD_UNITS_PER_METER } from './single-rural-settlement.js';

// How far a Settlement Road's ribbon is drawn above the terrain it follows. The value was
// duplicated in two places that had to agree and did so by coincidence: the render
// adapter's `3 / PRODUCTION_VISUAL_UNITS_PER_METER` and the ribbon geometry's `0.075`
// default. It belongs in one place because a third consumer now needs it - the player's
// feet, which were resting on the terrain while the road they appeared to stand on floated
// this far above them.
export const SETTLEMENT_ROAD_SURFACE_LIFT_METERS = 3 / FINITE_WORLD_UNITS_PER_METER;

// The Road shape a surface-height test needs: two endpoints and a width. Nothing else about
// a Road matters for deciding whether someone is standing on it.
//
// This must be given the owner Chunk's `settlementFeatures`, never the W5
// `sourceChunkData.settlementFeatures` it is built from. The major road network is appended
// to the owner Chunk after the source exists, so the source is missing every highway; and
// the source is pre-filter, so it still carries Roads that were dropped for intersecting a
// Building and are therefore never drawn.
export function projectRoadSurfaceSegments(settlementFeatures) {
  if (!Array.isArray(settlementFeatures)) return Object.freeze([]);
  const segments = [];
  for (const feature of settlementFeatures) {
    if (feature?.featureType !== 'settlement-road') continue;
    const { start, end, widthMeters } = feature;
    if (![start?.x, start?.z, end?.x, end?.z, widthMeters].every(Number.isFinite)) continue;
    if (widthMeters <= 0) continue;
    segments.push(Object.freeze({
      startX: start.x,
      startZ: start.z,
      endX: end.x,
      endZ: end.z,
      halfWidthMeters: widthMeters / 2,
    }));
  }
  return Object.freeze(segments);
}

function distanceToSegmentSquared(x, z, segment) {
  const deltaX = segment.endX - segment.startX;
  const deltaZ = segment.endZ - segment.startZ;
  const lengthSquared = deltaX * deltaX + deltaZ * deltaZ;
  const t = lengthSquared <= 0 ? 0 : Math.max(0, Math.min(1,
    ((x - segment.startX) * deltaX + (z - segment.startZ) * deltaZ) / lengthSquared));
  const nearestX = segment.startX + deltaX * t;
  const nearestZ = segment.startZ + deltaZ * t;
  return (x - nearestX) ** 2 + (z - nearestZ) ** 2;
}

// The lift to add to the terrain height at this point: the road surface if the point is
// inside a carriageway, otherwise nothing. This is a step at the kerb rather than a ramp,
// and deliberately so - the 0.075 m is a drawing offset, not a rise in the ground, so
// smoothing it would make a kerb that does not exist into something the world can trip on.
export function roadSurfaceLiftMetersAt(x, z, segments) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Array.isArray(segments)) return 0;
  for (const segment of segments) {
    if (distanceToSegmentSquared(x, z, segment) <= segment.halfWidthMeters ** 2) {
      return SETTLEMENT_ROAD_SURFACE_LIFT_METERS;
    }
  }
  return 0;
}

// A lift sampler over a Chunk store. `getChunkData` must be the same store the caller's
// terrain height comes from: the two halves of one contact decision taken from two different
// stores is exactly how this shipped broken the first time - the lift was answered from the
// gameplay runtime's Tank terrain cache, which the small scale stages never fill, so the
// condition that showed the symptom and the condition that made the fix work were mutually
// exclusive. A Chunk the store does not have lifts nothing, matching what a terrain height
// does on the same miss.
export function createRoadSurfaceLiftSampler(getChunkData) {
  if (typeof getChunkData !== 'function') {
    throw new TypeError('getChunkData must be a function');
  }
  // ChunkData is frozen and replaced rather than mutated, so one projection per Chunk lasts
  // as long as that Chunk is resident and is collected with it.
  const segmentsByChunkData = new WeakMap();
  return function roadSurfaceLiftMetersAtPosition(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const owner = logicalWorldToOwnedChunk(x, z);
    const chunkData = getChunkData(owner.chunkX, owner.chunkZ);
    if (!chunkData) return 0;
    let segments = segmentsByChunkData.get(chunkData);
    if (segments === undefined) {
      segments = projectRoadSurfaceSegments(chunkData.settlementFeatures);
      segmentsByChunkData.set(chunkData, segments);
    }
    return roadSurfaceLiftMetersAt(x, z, segments);
  };
}
