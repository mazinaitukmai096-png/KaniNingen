import { FINITE_WORLD_UNITS_PER_METER } from './single-rural-settlement.js';

// How far a Settlement Road's ribbon is drawn above the terrain it follows. The value was
// duplicated in two places that had to agree and did so by coincidence: the render
// adapter's `3 / PRODUCTION_VISUAL_UNITS_PER_METER` and the ribbon geometry's `0.075`
// default. It belongs in one place because a third consumer now needs it - the player's
// feet, which were resting on the terrain while the road they appeared to stand on floated
// this far above them.
export const SETTLEMENT_ROAD_SURFACE_LIFT_METERS = 3 / FINITE_WORLD_UNITS_PER_METER;

// The Road shape a surface-height test needs: two endpoints and a width. Nothing else about
// a Road matters for deciding whether someone is standing on it, and the gameplay runtime
// caches this rather than whole Chunks - `#rememberTankTerrainChunk` keeps terrain and drops
// the rest to avoid pinning 15.76 MiB of presentation payload behind a 128-entry cache.
// Settlement Roads are 0.2% of that payload and this form is smaller again.
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
