import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getW6ScaleProfile } from '../src/infinite-world/gameplay-contract.js';
import { LOGICAL_CHUNK_SIZE_METERS } from '../src/infinite-world/chunk-coordinates.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import { ROAD_GRAPH_V3_GENERATOR_ID } from '../src/infinite-world/road-graph-v3.js';
import { SETTLEMENT_LOT_V2_GENERATOR_ID } from '../src/infinite-world/settlement-lot-v2.js';
import {
  PLAYER_MODEL_VERTICAL_BOUNDS_UNITS,
  createPlayerVerticalMovementState,
  getScalePlayerVerticalMetrics,
  resetPlayerGrounding,
  sampleFormalTerrainHeightMeters,
  stepPlayerVerticalMovement,
  tryStartPlayerJump,
} from '../src/infinite-world/player-vertical-movement.js';
import {
  SETTLEMENT_ROAD_SURFACE_LIFT_METERS,
  createRoadSurfaceLiftSampler,
  projectRoadSurfaceSegments,
  roadSurfaceLiftMetersAt,
} from '../src/infinite-world/settlement-road-surface.js';

function createTerrainChunk(chunkX = 0, chunkZ = 0, heights = [
  0, 1000, 4000,
  2000, 10000, 6000,
  3000, 5000, 7000,
]) {
  return {
    chunkX,
    chunkZ,
    terrain: {
      resolution: { x: 3, z: 3 },
      heightUnitMeters: 0.001,
      heights,
    },
  };
}

test('formal Player Terrain query matches the rendered triangle surface in logical coordinates', () => {
  const chunk = createTerrainChunk();
  assert.equal(sampleFormalTerrainHeightMeters(chunk, 4, 2), 1);
  assert.equal(sampleFormalTerrainHeightMeters(chunk, 6, 6), 5.75);
  assert.equal(sampleFormalTerrainHeightMeters(chunk, 16, 8), 6);
  assert.throws(() => sampleFormalTerrainHeightMeters(chunk, 16.01, 8), /does not own logical position/);

  const negative = createTerrainChunk(-1, -1);
  assert.equal(sampleFormalTerrainHeightMeters(negative, 0, 0), 7);
});

test('Terrain height and Player root Y are independent of render origin and rebase count', () => {
  const chunk = createTerrainChunk();
  const profile = getW6ScaleProfile('MAX');
  const heightBeforeRebase = sampleFormalTerrainHeightMeters(chunk, 6, 6);
  const state = createPlayerVerticalMovementState();
  resetPlayerGrounding(state, { terrainHeightMeters: heightBeforeRebase, scaleProfile: profile });
  const rootBeforeRebase = state.rootY;

  for (const ignoredRenderOrigin of [
    { renderOriginChunkX: 0, renderOriginChunkZ: 0, rebaseCount: 0 },
    { renderOriginChunkX: 12345, renderOriginChunkZ: -6789, rebaseCount: 400 },
  ]) {
    assert.ok(ignoredRenderOrigin);
    const heightAfterRebase = sampleFormalTerrainHeightMeters(chunk, 6, 6);
    stepPlayerVerticalMovement(state, {
      deltaSeconds: 0,
      terrainHeightMeters: heightAfterRebase,
      scaleProfile: profile,
    });
    assert.equal(heightAfterRebase, heightBeforeRebase);
    assert.equal(state.rootY, rootBeforeRebase);
  }
});

test('Tiny, Mid, and Max derive foot offset, height, and radius without changing Scale values', () => {
  assert.ok(PLAYER_MODEL_VERTICAL_BOUNDS_UNITS.minimum < 0);
  assert.ok(PLAYER_MODEL_VERTICAL_BOUNDS_UNITS.maximum > 0);
  for (const stageId of ['TINY', 'MID', 'MAX']) {
    const profile = getW6ScaleProfile(stageId);
    const metrics = getScalePlayerVerticalMetrics(profile);
    assert.equal(metrics.stageId, stageId);
    assert.equal(metrics.footOffsetMeters,
      -PLAYER_MODEL_VERTICAL_BOUNDS_UNITS.minimum * profile.stage.visualScale / 40);
    assert.equal(metrics.heightMeters,
      PLAYER_MODEL_VERTICAL_BOUNDS_UNITS.height * profile.stage.visualScale / 40);
    assert.equal(metrics.radiusMeters, profile.stage.collisionRadius / 40);
    assert.equal(metrics.jumpVelocityMetersPerSecond, profile.stage.jumpVelocity / 40 * 60);
    assert.equal(metrics.gravityMetersPerSecondSquared, profile.stage.gravity / 40 * 3600);
  }
});

test('grounded Player contacts slopes, retains zero downward velocity, and does not drift for 60 seconds', () => {
  for (const stageId of ['TINY', 'MID', 'MAX']) {
    const profile = getW6ScaleProfile(stageId);
    const metrics = getScalePlayerVerticalMetrics(profile);
    const state = createPlayerVerticalMovementState();
    resetPlayerGrounding(state, { terrainHeightMeters: 1.25, scaleProfile: profile });
    assert.equal(state.rootY - metrics.footOffsetMeters, 1.25);

    for (let frame = 0; frame < 3600; frame += 1) {
      stepPlayerVerticalMovement(state, {
        deltaSeconds: 1 / 60,
        terrainHeightMeters: 1.25,
        scaleProfile: profile,
      });
    }
    assert.equal(state.rootY, 1.25 + metrics.footOffsetMeters);
    assert.equal(state.velocityMetersPerSecond, 0);
    assert.equal(state.grounded, true);

    stepPlayerVerticalMovement(state, {
      deltaSeconds: 1 / 60,
      terrainHeightMeters: 2.125,
      scaleProfile: profile,
    });
    assert.equal(state.rootY, 2.125 + metrics.footOffsetMeters);
    assert.equal(state.velocityMetersPerSecond, 0);
  }
});

test('each Scale completes ten identical single-impulse jumps and resets velocity on landing', () => {
  for (const stageId of ['TINY', 'MID', 'MAX']) {
    const profile = getW6ScaleProfile(stageId);
    const state = createPlayerVerticalMovementState();
    resetPlayerGrounding(state, { terrainHeightMeters: 1.5, scaleProfile: profile });
    const apexes = [];
    for (let jump = 0; jump < 10; jump += 1) {
      assert.equal(tryStartPlayerJump(state, profile), true);
      assert.equal(tryStartPlayerJump(state, profile), false);
      let apex = state.rootY;
      let rose = false;
      let fell = false;
      for (let frame = 0; frame < 1200 && !state.grounded; frame += 1) {
        const before = state.rootY;
        stepPlayerVerticalMovement(state, {
          deltaSeconds: 1 / 120,
          terrainHeightMeters: 1.5,
          scaleProfile: profile,
        });
        apex = Math.max(apex, state.rootY);
        rose ||= state.rootY > before;
        fell ||= state.rootY < before;
      }
      assert.equal(rose, true);
      assert.equal(fell, true);
      assert.equal(state.grounded, true);
      assert.equal(state.velocityMetersPerSecond, 0);
      assert.equal(state.rootY, state.groundRootY);
      apexes.push(apex - state.groundRootY);
    }
    assert.ok(apexes[0] > 0);
    assert.ok(apexes.every(apex => Math.abs(apex - apexes[0]) < 1e-12));
  }
});

test('airborne root Y is absolute and Scale switching re-grounds with the new foot offset', () => {
  const max = getW6ScaleProfile('MAX');
  const tiny = getW6ScaleProfile('TINY');
  const state = createPlayerVerticalMovementState();
  resetPlayerGrounding(state, { terrainHeightMeters: 2, scaleProfile: max });
  assert.equal(tryStartPlayerJump(state, max), true);
  stepPlayerVerticalMovement(state, {
    deltaSeconds: 1 / 120,
    terrainHeightMeters: 2,
    scaleProfile: max,
  });
  const beforeRoot = state.rootY;
  const beforeVelocity = state.velocityMetersPerSecond;
  const gravity = getScalePlayerVerticalMetrics(max).gravityMetersPerSecondSquared;
  stepPlayerVerticalMovement(state, {
    deltaSeconds: 1 / 120,
    terrainHeightMeters: -20,
    scaleProfile: max,
  });
  const expectedVelocity = beforeVelocity - gravity / 120;
  assert.ok(Math.abs(state.rootY - (beforeRoot + expectedVelocity / 120)) < 1e-12);
  assert.equal(state.grounded, false);

  resetPlayerGrounding(state, { terrainHeightMeters: 2, scaleProfile: max });
  stepPlayerVerticalMovement(state, {
    deltaSeconds: 0,
    terrainHeightMeters: 2,
    scaleProfile: tiny,
  });
  const tinyMetrics = getScalePlayerVerticalMetrics(tiny);
  assert.equal(state.rootY, 2 + tinyMetrics.footOffsetMeters);
  assert.equal(state.heightMeters, tinyMetrics.heightMeters);
  assert.equal(state.radiusMeters, tinyMetrics.radiusMeters);
  assert.equal(state.velocityMetersPerSecond, 0);
  assert.equal(state.grounded, true);
});

// The player stood on the terrain while the road they appeared to be on was drawn
// SETTLEMENT_ROAD_SURFACE_LIFT_METERS above it. footOffsetMeters shrinks with the scale
// stage and the road lift does not, so the fixed 7.5 cm grew into a large fraction of a
// small player's height and they sank into the carriageway.
test('the surface underfoot includes the road, at every scale stage', () => {
  const terrainHeightMeters = 12.5;
  const onRoad = SETTLEMENT_ROAD_SURFACE_LIFT_METERS;
  const sunkByStage = new Map();
  for (const stageId of ['TINY', 'MID', 'MAX']) {
    const scaleProfile = getW6ScaleProfile(stageId);
    const metrics = getScalePlayerVerticalMetrics(scaleProfile);

    const offRoadState = createPlayerVerticalMovementState();
    const offRoad = resetPlayerGrounding(offRoadState, { terrainHeightMeters, scaleProfile });
    // Off the road nothing moves: a Settlement-free world behaves exactly as before.
    assert.equal(offRoad.groundRootY, terrainHeightMeters + metrics.footOffsetMeters);
    assert.equal(offRoad.surfaceLiftMeters, 0);

    const onRoadState = createPlayerVerticalMovementState();
    const grounded = resetPlayerGrounding(onRoadState, {
      terrainHeightMeters, scaleProfile, surfaceLiftMeters: onRoad,
    });
    assert.equal(grounded.surfaceLiftMeters, onRoad);
    assert.equal(grounded.groundRootY, terrainHeightMeters + onRoad + metrics.footOffsetMeters);
    // How deep the player used to be inside the road surface, as a share of their height.
    sunkByStage.set(stageId, onRoad / metrics.heightMeters);

    // Stepping holds the same surface rather than settling back onto bare terrain.
    const stepped = stepPlayerVerticalMovement(onRoadState, {
      deltaSeconds: 1 / 60, terrainHeightMeters, scaleProfile, surfaceLiftMeters: onRoad,
    });
    assert.equal(stepped.grounded, true);
    assert.equal(stepped.rootY, terrainHeightMeters + onRoad + metrics.footOffsetMeters);
  }
  // The symptom was reported as scale-dependent, and it is: the same 7.5 cm is a far larger
  // share of a small player. Whatever the ordering of the stages by height, the smallest
  // sank deepest, which is why this could not be fixed by a constant that ignores scale.
  const shares = [...sunkByStage.values()];
  assert.ok(Math.max(...shares) > Math.min(...shares) * 2,
    'the sinking depth must differ sharply across stages');
});

test('leaving the road is a step down, not a trap', () => {
  const scaleProfile = getW6ScaleProfile('MID');
  const metrics = getScalePlayerVerticalMetrics(scaleProfile);
  const terrainHeightMeters = 4;
  const state = createPlayerVerticalMovementState();
  resetPlayerGrounding(state, {
    terrainHeightMeters, scaleProfile, surfaceLiftMeters: SETTLEMENT_ROAD_SURFACE_LIFT_METERS,
  });

  // Walking off the kerb: the surface drops by the lift and the player follows it in one
  // step, still grounded. Nothing catches, and nothing has to fall.
  const offKerb = stepPlayerVerticalMovement(state, {
    deltaSeconds: 1 / 60, terrainHeightMeters, scaleProfile, surfaceLiftMeters: 0,
  });
  assert.equal(offKerb.grounded, true);
  assert.equal(offKerb.rootY, terrainHeightMeters + metrics.footOffsetMeters);

  // Walking back on is the mirror of it, so crossing the kerb repeatedly cannot drift.
  const backOn = stepPlayerVerticalMovement(state, {
    deltaSeconds: 1 / 60, terrainHeightMeters, scaleProfile,
    surfaceLiftMeters: SETTLEMENT_ROAD_SURFACE_LIFT_METERS,
  });
  assert.equal(backOn.grounded, true);
  assert.equal(backOn.rootY,
    terrainHeightMeters + SETTLEMENT_ROAD_SURFACE_LIFT_METERS + metrics.footOffsetMeters);

  // Ten crossings land exactly where one did: the step is stateless, so a player standing
  // on the kerb line cannot be shaken by it.
  for (let index = 0; index < 10; index += 1) {
    stepPlayerVerticalMovement(state, {
      deltaSeconds: 1 / 60, terrainHeightMeters, scaleProfile,
      surfaceLiftMeters: index % 2 === 0 ? 0 : SETTLEMENT_ROAD_SURFACE_LIFT_METERS,
    });
  }
  const settled = stepPlayerVerticalMovement(state, {
    deltaSeconds: 1 / 60, terrainHeightMeters, scaleProfile,
    surfaceLiftMeters: SETTLEMENT_ROAD_SURFACE_LIFT_METERS,
  });
  assert.equal(settled.rootY, backOn.rootY);
});

test('a road surface is found only inside the carriageway', () => {
  const segments = projectRoadSurfaceSegments([
    { featureType: 'settlement-road', start: { x: 0, z: 0 }, end: { x: 10, z: 0 }, widthMeters: 4 },
    { featureType: 'settlement-building', worldPosition: { x: 5, z: 5 } },
  ]);
  assert.equal(segments.length, 1, 'only roads carry a surface');
  const lift = SETTLEMENT_ROAD_SURFACE_LIFT_METERS;
  assert.equal(roadSurfaceLiftMetersAt(5, 0, segments), lift, 'the centre line is on the road');
  assert.equal(roadSurfaceLiftMetersAt(5, 1.99, segments), lift, 'just inside the kerb');
  assert.equal(roadSurfaceLiftMetersAt(5, 2.01, segments), 0, 'just outside the kerb');
  assert.equal(roadSurfaceLiftMetersAt(0, 0, segments), lift, 'the end point itself is on it');
  // The test is a capsule, not a rectangle: the ends are rounded by the half width. That is
  // deliberate. Roads chain end to end and their mitred joins widen the ribbon slightly, so
  // a rectangle would leave slivers at the joins where the surface drops and returns - and
  // a player standing on one would be lifted and dropped every frame. Overshooting a true
  // dead end by a half width lifts someone 7.5 cm just past the road, which is harmless.
  assert.equal(roadSurfaceLiftMetersAt(-1, 0, segments), lift,
    'the rounded cap keeps joins gap-free at the cost of a little overshoot');
  assert.equal(roadSurfaceLiftMetersAt(-2.5, 0, segments), 0, 'but it does not reach forever');
  assert.equal(roadSurfaceLiftMetersAt(5, 0, []), 0, 'a Settlement-free world lifts nothing');
});

// The tests above are the judgement layer: given segments, is the surface decided correctly.
// They construct their segments from literals, so they say nothing about whether segments
// reach the judgement at all - and the first version of this fix shipped with a judgement
// that was never given any. These are the supply layer: real Chunks from the real generator,
// read through the sampler the running game uses.
async function generateRoadWindow() {
  const generator = await createW8ParityChunkGenerator({
    worldSeed: 'city-probe-22',
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V3_GENERATOR_ID,
    settlementLotMode: SETTLEMENT_LOT_V2_GENERATOR_ID,
  });
  const spawn = generator.experienceSpawn;
  const spawnChunkX = Math.floor(spawn.x / LOGICAL_CHUNK_SIZE_METERS);
  const spawnChunkZ = Math.floor(spawn.z / LOGICAL_CHUNK_SIZE_METERS);
  const chunks = new Map();
  let majorRoad = null;
  let settlementLane = null;
  for (let dz = -3; dz <= 3; dz += 1) {
    for (let dx = -3; dx <= 3; dx += 1) {
      const chunkX = spawnChunkX + dx;
      const chunkZ = spawnChunkZ + dz;
      const chunk = await generator.generateChunk(chunkX, chunkZ);
      chunks.set(`${chunkX},${chunkZ}`, chunk);
      const sourceIds = new Set((chunk.sourceChunkData?.settlementFeatures ?? [])
        .map(feature => feature.stableId));
      for (const feature of chunk.settlementFeatures ?? []) {
        if (feature.featureType !== 'settlement-road') continue;
        // The major road network is appended to the owner Chunk after its W5 source exists,
        // which is exactly what tells the two apart - and exactly what the broken supply
        // could not see.
        if (sourceIds.has(feature.stableId)) settlementLane ??= feature;
        else majorRoad ??= feature;
      }
    }
  }
  await generator.shutdown?.();
  return { chunks, majorRoad, settlementLane };
}

const roadWindow = await generateRoadWindow();

test('the running game is supplied with both classes of Road', () => {
  const { chunks, majorRoad, settlementLane } = roadWindow;
  assert.ok(majorRoad, 'the sampled world must contain an inter-Settlement major road');
  assert.ok(settlementLane, 'the sampled world must contain a Settlement street');
  // Widths are asserted because the two classes are the two halves of the reported symptom:
  // 2.25 m carriageways between Settlements and 1.85 m streets inside one.
  assert.ok(majorRoad.widthMeters > 2, `major road width ${majorRoad.widthMeters}`);
  assert.ok(settlementLane.widthMeters < 2, `street width ${settlementLane.widthMeters}`);

  const sampleLift = createRoadSurfaceLiftSampler(
    (chunkX, chunkZ) => chunks.get(`${chunkX},${chunkZ}`) ?? null,
  );
  const lift = SETTLEMENT_ROAD_SURFACE_LIFT_METERS;
  const pointOn = (road, t) => [
    road.start.x + (road.end.x - road.start.x) * t,
    road.start.z + (road.end.z - road.start.z) * t,
  ];
  // Every drawn Road in the window, not just the two representatives, and along its whole
  // length rather than at a few chosen points.
  const roads = [...chunks.values()].flatMap(chunk => (chunk.settlementFeatures ?? [])
    .filter(feature => feature.featureType === 'settlement-road'));
  assert.ok(roads.length >= 10, `the sampled world must carry Roads (${roads.length})`);
  for (const road of roads) {
    for (let step = 1; step < 40; step += 1) {
      assert.equal(sampleLift(...pointOn(road, step / 40)), lift,
        `${road.stableId} is drawn here and must lift the player`);
    }
  }
  // Endpoints are sampled a micrometre inside. A Road that terminates exactly on a Chunk
  // boundary has its last line owned by the neighbouring Chunk, which holds no piece of it,
  // so that one line answers 0 - measured at 2 of 38 endpoints here, and gone at an inset of
  // 1e-6 m. The seam has no width, the surface either side of it is right, and closing it
  // would cost a neighbour lookup on every frame near a boundary.
  for (const road of roads) {
    const length = Math.hypot(road.end.x - road.start.x, road.end.z - road.start.z);
    const inset = length > 0 ? 1e-6 / length : 0;
    assert.equal(sampleLift(...pointOn(road, inset)), lift, `${road.stableId} start`);
    assert.equal(sampleLift(...pointOn(road, 1 - inset)), lift, `${road.stableId} end`);
  }
  // A Chunk the store does not hold lifts nothing rather than throwing, which is the same
  // degradation the terrain height takes on the same miss.
  assert.equal(sampleLift(majorRoad.start.x + 1e6, majorRoad.start.z), 0);
});

test('the W5 source Chunk is not a supply of Roads', () => {
  const { chunks, majorRoad } = roadWindow;
  // This is the defect the fix was shipped with, kept as a guard. Reading the source Chunk
  // looks right - it is where Settlement Roads are generated, and it answers correctly on
  // every street - but it cannot see a single major road, so the failure was partial and
  // read as success.
  const sampleFromSource = createRoadSurfaceLiftSampler(
    (chunkX, chunkZ) => chunks.get(`${chunkX},${chunkZ}`)?.sourceChunkData ?? null,
  );
  const midpointX = (majorRoad.start.x + majorRoad.end.x) / 2;
  const midpointZ = (majorRoad.start.z + majorRoad.end.z) / 2;
  assert.equal(sampleFromSource(midpointX, midpointZ), 0,
    'if this ever lifts, the two feature lists have merged and the guard can go');

  let ownerRoads = 0;
  let sourceRoads = 0;
  for (const chunk of chunks.values()) {
    const roads = features => (features ?? [])
      .filter(feature => feature.featureType === 'settlement-road').length;
    ownerRoads += roads(chunk.settlementFeatures);
    sourceRoads += roads(chunk.sourceChunkData?.settlementFeatures);
  }
  assert.ok(ownerRoads > sourceRoads,
    `owner Chunks must carry more Roads than their sources (${ownerRoads} vs ${sourceRoads})`);
});

test('the sandbox reads the lift from the store it reads terrain heights from', () => {
  // The one link the sampler test above cannot reach: which store the running game hands it.
  // Answering a lift from a different store than the terrain height is what shipped broken,
  // and nothing in the sampler can detect it.
  const boot = readFileSync(
    resolve(import.meta.dirname, '..', 'src/infinite-world/sandbox-boot.js'),
    'utf8',
  );
  assert.match(boot, /createRoadSurfaceLiftSampler\(\s*\(chunkX, chunkZ\) => runtime\.getChunkData\(chunkX, chunkZ\),?\s*\)/);
  assert.match(boot, /const chunkData = queriedChunkData \?\? runtime\.getChunkData\(/);
  assert.doesNotMatch(boot, /roadSurfaceLiftMetersAt\(x, z\)/,
    'the lift must not come back from the gameplay runtime Tank terrain cache');
});
