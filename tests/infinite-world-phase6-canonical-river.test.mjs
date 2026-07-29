import assert from 'node:assert/strict';
import test from 'node:test';

import {
  W8_CANONICAL_RIVER,
  createCanonicalRiverProjection,
  distanceToCanonicalRiverCenterline,
} from '../src/infinite-world/canonical-river-realization.js';
import { hashWorldSeed } from '../src/infinite-world/legacy-core/g0/seed.js';
import { G2_C_WORLD_FEATURES } from '../src/infinite-world/legacy-core/g2/world-chunk-generator.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import {
  createSettlementSurfacePolicy,
  resolveCanonicalGroundSurface,
} from '../src/infinite-world/w8-surface-policy.js';

const seed = 'KaniNingen Infinite Natural World';
const { worldSeedHash } = await hashWorldSeed(seed);

const segmentDistance = (point, start, end) => {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared)) : 0;
  return Math.hypot(point.x - start.x - dx * t, point.z - start.z - dz * t);
};

test('River projection uses the G2 Corridor and shares exact continuation ports across Chunk owners', async () => {
  const [west, east, repeated] = await Promise.all([
    createCanonicalRiverProjection({ worldSeedHash, chunkX: 0, chunkZ: 0 }),
    createCanonicalRiverProjection({ worldSeedHash, chunkX: 1, chunkZ: 0 }),
    createCanonicalRiverProjection({ worldSeedHash, chunkX: 0, chunkZ: 0 }),
  ]);
  assert.deepEqual(repeated, west);
  assert.equal(west.waterSurface.waterType, 'river');
  assert.equal(west.waterSurface.widthMeters, G2_C_WORLD_FEATURES.river.width);
  assert.equal(west.waterSurface.riverDepthMeters, G2_C_WORLD_FEATURES.river.depth);
  assert.equal(west.waterSurface.flowDirection, 'startToEnd');
  assert.deepEqual(west.waterSurface.owningChunkCoordinate, { x: 0, z: 0 });
  assert.deepEqual(east.waterSurface.owningChunkCoordinate, { x: 1, z: 0 });
  for (const point of [...west.waterSurface.centerlines.flat(), ...east.waterSurface.centerlines.flat()]) {
    assert.ok(Math.abs(point.z
      - (G2_C_WORLD_FEATURES.river.slope * point.x + G2_C_WORLD_FEATURES.river.intercept))
      <= 0.0000011);
  }
  const westEast = west.ports.find(port => port.edge === 'east');
  const eastWest = east.ports.find(port => port.edge === 'west');
  assert.ok(westEast);
  assert.ok(eastWest);
  assert.equal(westEast.portId, eastWest.portId);
  assert.deepEqual(westEast.worldPosition, eastWest.worldPosition);
  assert.equal(west.waterSurface.stableId === east.waterSurface.stableId, false);
  assert.equal(west.sourceStableId, east.sourceStableId);
});

test('Settlement avoidance moves only the River and keeps the complete bank outside its radius', async () => {
  const settlement = Object.freeze({
    settlementId: 'settlement-v1:phase6-river-avoidance',
    center: Object.freeze({ x: 100, z: 40.2 }),
    radiusMeters: 20,
  });
  const lines = [];
  for (let chunkZ = -1; chunkZ <= 4; chunkZ += 1) {
    for (let chunkX = 3; chunkX <= 9; chunkX += 1) {
      const projection = await createCanonicalRiverProjection({
        worldSeedHash,
        chunkX,
        chunkZ,
        settlementReferences: [settlement],
      });
      lines.push(...(projection.waterSurface?.centerlines ?? []));
    }
  }
  assert.ok(lines.length > 0);
  let minimumDistance = Infinity;
  for (const line of lines) {
    for (let index = 0; index < line.length - 1; index += 1) {
      minimumDistance = Math.min(minimumDistance,
        segmentDistance(settlement.center, line[index], line[index + 1]));
    }
  }
  assert.ok(minimumDistance >= settlement.radiusMeters + W8_CANONICAL_RIVER.bankExtentMeters,
    `River bank entered Settlement: ${minimumDistance}`);
  assert.deepEqual(settlement.center, { x: 100, z: 40.2 });
});

test('canonical Surface Policy carves the existing River depth without mutating source terrain', async () => {
  const projection = await createCanonicalRiverProjection({
    worldSeedHash,
    chunkX: 0,
    chunkZ: 0,
  });
  const heights = Array(33 * 33).fill(1000);
  const source = Object.freeze({
    chunkX: 0,
    chunkZ: 0,
    terrain: Object.freeze({
      resolution: Object.freeze({ x: 33, z: 33 }),
      heightUnitMeters: 0.001,
      heights: Object.freeze([...heights]),
    }),
  });
  const chunkData = Object.freeze({
    ...source,
    canonicalSurfacePolicy: createSettlementSurfacePolicy(
      [],
      [projection.surfaceCorridor],
    ),
  });
  const center = projection.waterSurface.centerlines[0][0];
  const bed = resolveCanonicalGroundSurface({
    chunkData,
    worldX: center.x,
    worldZ: center.z,
  });
  assert.equal(bed.baseHeightMeters, 1);
  assert.equal(bed.riverDepthMeters, W8_CANONICAL_RIVER.depthMeters);
  assert.equal(bed.heightMeters, 1 - W8_CANONICAL_RIVER.depthMeters);
  assert.equal(bed.riverSurfaceHeightMeters, 1);
  const dry = resolveCanonicalGroundSurface({ chunkData, worldX: 0, worldZ: 15 });
  assert.equal(dry.heightMeters, 1);
  assert.deepEqual(source.terrain.heights, heights);
});

test('Road crossings create Bridge-ready metadata without modifying Road geometry', async () => {
  const road = Object.freeze({
    schemaVersion: 'w8-road-projection-1',
    stableId: 'wf1:settlement-road:phase6-projected-road',
    sourceStableId: 'wf1:settlement-road:phase6-source-road',
    featureType: 'settlement-road',
    start: Object.freeze({ x: 8, z: 0 }),
    end: Object.freeze({ x: 8, z: 16 }),
    widthMeters: 3,
  });
  const before = structuredClone(road);
  const projection = await createCanonicalRiverProjection({
    worldSeedHash,
    chunkX: 0,
    chunkZ: 0,
    roads: [road],
  });
  assert.deepEqual(road, before);
  assert.equal(projection.roadCrossings.length, 1);
  const [crossing] = projection.roadCrossings;
  assert.equal(crossing.bridgeRequired, true);
  assert.equal(crossing.roadStableId, road.sourceStableId);
  assert.equal(crossing.projectedRoadStableId, road.stableId);
  assert.deepEqual(crossing.owningChunkCoordinate, { x: 0, z: 0 });
  assert.deepEqual(projection.waterSurface.crossingReferences, [crossing.stableId]);
  assert.equal(crossing.worldPosition.x, 8);
  assert.equal(crossing.worldPosition.z,
    G2_C_WORLD_FEATURES.river.slope * 8 + G2_C_WORLD_FEATURES.river.intercept);
});

test('Near and Far River projections preserve owner, Stable ID, XZ, width, and flow', async () => {
  const near = await createCanonicalRiverProjection({
    worldSeedHash,
    chunkX: 1,
    chunkZ: 0,
    sampleSurfaceHeight: () => 0.75,
  });
  const far = await createCanonicalRiverProjection({
    worldSeedHash,
    chunkX: 1,
    chunkZ: 0,
  });
  assert.equal(near.waterSurface.stableId, far.waterSurface.stableId);
  assert.equal(near.waterSurface.sourceStableId, far.waterSurface.sourceStableId);
  assert.deepEqual(near.waterSurface.owningChunkCoordinate,
    far.waterSurface.owningChunkCoordinate);
  assert.equal(near.waterSurface.widthMeters, far.waterSurface.widthMeters);
  assert.equal(near.waterSurface.flowDirection, far.waterSurface.flowDirection);
  assert.deepEqual(near.waterSurface.centerlines.map(line => line.map(({ x, z }) => ({ x, z }))),
    far.waterSurface.centerlines.map(line => line.map(({ x, z }) => ({ x, z }))));
  const point = near.waterSurface.centerlines[0][0];
  assert.ok(distanceToCanonicalRiverCenterline(
    [near.surfaceCorridor], point.x, point.z,
  ).distanceMeters <= 1e-12);
});

test('W8 ChunkData realizes River water and bed while preserving the source terrain record', async () => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: seed });
  const [west, east] = await Promise.all([
    generator.generateChunk(0, 0),
    generator.generateChunk(1, 0),
  ]);
  const westRiver = west.waterSurfaces.find(surface => surface.waterType === 'river');
  const eastRiver = east.waterSurfaces.find(surface => surface.waterType === 'river');
  assert.ok(westRiver);
  assert.ok(eastRiver);
  assert.equal(west.presentationLayers.water.includes(westRiver), true);
  assert.equal(west.canonicalSurfacePolicy.riverCorridors.length, 1);
  assert.equal(west.terrain, west.sourceChunkData.terrain,
    'River realization must not replace or mutate the source terrain arrays');
  assert.equal(west.sourceW5ContentHash, west.sourceChunkData.contentHash);
  assert.deepEqual(westRiver.owningChunkCoordinate, { x: 0, z: 0 });
  assert.deepEqual(eastRiver.owningChunkCoordinate, { x: 1, z: 0 });
  const westEast = west.riverPorts.find(port => port.edge === 'east');
  const eastWest = east.riverPorts.find(port => port.edge === 'west');
  assert.equal(westEast.portId, eastWest.portId);
  assert.deepEqual(westEast.worldPosition, eastWest.worldPosition);
  const center = westRiver.centerlines[0][0];
  const surface = resolveCanonicalGroundSurface({
    chunkData: west,
    worldX: center.x,
    worldZ: center.z,
  });
  assert.equal(surface.heightMeters,
    surface.baseHeightMeters - W8_CANONICAL_RIVER.depthMeters);
  assert.equal(west.generationProof.canonicalRiverCorridorConnected, true);
});
