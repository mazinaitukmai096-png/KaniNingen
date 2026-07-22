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
