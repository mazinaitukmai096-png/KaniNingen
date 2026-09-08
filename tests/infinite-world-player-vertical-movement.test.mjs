import test from 'node:test';
import assert from 'node:assert/strict';
import { getW6ScaleProfile } from '../src/infinite-world/gameplay-contract.js';
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
