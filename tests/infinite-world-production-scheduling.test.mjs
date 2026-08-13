import test from 'node:test';
import assert from 'node:assert/strict';

import { LOGICAL_CHUNK_SIZE_METERS } from '../src/infinite-world/chunk-coordinates.js';
import { getW6ScaleProfile } from '../src/infinite-world/gameplay-contract.js';
import {
  PRODUCTION_FRAME_MS,
  PRODUCTION_FRAME_SECONDS,
  bootProductionSchedulingHarness,
} from './helpers/infinite-world-production-scheduling-harness.mjs';

const MAX_SPRINT_METERS_PER_SECOND = 47.85;
const POSITION_EPSILON_METERS = 1e-9;

const logicalPosition = snapshot => Object.freeze({
  x: snapshot.spatial.playerLogical.x,
  z: snapshot.spatial.playerLogical.z,
});

const displacement = (before, after) => Object.freeze({
  x: after.x - before.x,
  z: after.z - before.z,
});

const magnitude = value => Math.hypot(value.x, value.z);
const normalized = value => {
  const length = magnitude(value);
  return Object.freeze({ x: value.x / length, z: value.z / length });
};
const dot = (left, right) => left.x * right.x + left.z * right.z;

function assertNear(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, received ${actual}`);
}

function assertStopped(before, after, message) {
  assert.ok(magnitude(displacement(before, after)) <= POSITION_EPSILON_METERS, message);
}

const naturalDensityAttributes = harness => harness.gpuMirrorSnapshot().filter(attribute => (
  attribute.attributeName === 'w8NaturalDensityRank'
));

const naturalDensityMirrorsReady = harness => {
  const attributes = naturalDensityAttributes(harness);
  return attributes.length > 0 && attributes.every(attribute => (
    attribute.gpuArray !== null
      && attribute.gpuVersion === attribute.cpuVersion
      && attribute.gpuArray.length === attribute.cpuArray.length
      && attribute.gpuArray.every((value, index) => Object.is(value, attribute.cpuArray[index]))
  ));
};

function assertNaturalDensityGpuMirrors(harness, phase) {
  const densityAttributes = naturalDensityAttributes(harness);
  assert.ok(densityAttributes.length > 0,
    `${phase}: rendered Natural density attributes must exist`);
  for (const attribute of densityAttributes) {
    assert.notEqual(attribute.gpuArray, null,
      `${phase}: ${attribute.path} density must have a renderer-side mirror`);
    assert.equal(attribute.gpuVersion, attribute.cpuVersion,
      `${phase}: ${attribute.path} density versions must match`);
    assert.deepEqual(attribute.gpuArray, attribute.cpuArray,
      `${phase}: ${attribute.path} density CPU/GPU values must match`);
  }
  return densityAttributes;
}


function assertVisualContinuityReceiptState(snapshot, phase) {
  const continuity = snapshot.visualContinuity ?? null;
  assert.notEqual(continuity, null,
    `${phase}: production boot must expose the always-on visual continuity registry`);
  assert.ok(continuity.expectedOwnerCount > 0,
    `${phase}: Natural policy coverage must populate the Expected denominator`);
  assert.ok(continuity.coarseDrawableCount > 0,
    `${phase}: policy-owned Presentation pages must reach CoarseDrawable`);
  assert.ok(continuity.detailDrawableCount > 0,
    `${phase}: Full owners must reach DetailDrawable independently of coarse availability`);
  const nearOwners = continuity.owners.filter(owner => (
    owner.nearRepresentationAvailableAt !== null
  ));
  assert.ok(nearOwners.length > 0,
    `${phase}: the normal Near renderer must update the shared owner lifecycle`);
  assert.ok(nearOwners.some(owner => owner.canonicalStableIds.length > 0),
    `${phase}: Near availability must retain canonical Natural Stable IDs`);
  assert.ok((continuity.renderFrames?.completedFrameCount ?? 0) > 0,
    `${phase}: drawable lifecycle must contain a completed renderer receipt`);
  assert.equal(continuity.actualDrawableLatencyMs?.includesMissingOwners, true,
    `${phase}: continuity latency must retain missing expected owners in its denominator`);
}

function assertMaxSprint(step, name) {
  const speed = magnitude(step) / PRODUCTION_FRAME_SECONDS;
  assertNear(speed, MAX_SPRINT_METERS_PER_SECOND, 1e-7,
    `${name} must use the production MAX sprint speed`);
}

const ownerOf = position => Object.freeze({
  chunkX: Math.floor(position.x / LOGICAL_CHUNK_SIZE_METERS),
  chunkZ: Math.floor(position.z / LOGICAL_CHUNK_SIZE_METERS),
});

test('full production boot scheduling stays continuous through MAX sprint direction changes', {
  timeout: 120_000,
}, async t => {
  const diagnose = message => {
    t.diagnostic(message);
    if (process.env.KANININGEN_DEBUG_PRODUCTION_HARNESS === '1') {
      process.stderr.write(`[production-harness] ${message}\n`);
    }
  };
  const maxProfile = getW6ScaleProfile('MAX');
  assert.equal(maxProfile.sprintMetersPerSecond, MAX_SPRINT_METERS_PER_SECOND,
    'the test speed is read against the protected production scale contract');

    const harness = await bootProductionSchedulingHarness();
  try {
    const booted = harness.snapshot();
    const initialRendererCount = harness.environment.renderer().renderCount;
    const initialTransportGenerated = booted.chunkDataService.transport.counts.generated;
    const initialTerrainCommitCount = booted.presentation.localTerrainCommitCount;
    const initialStaticPlanCount = booted.staticObjectStreaming.counts.plans;
    const initialBuildingPublicationCount = booted.buildingSettlementStreaming.counts.published;

    assert.equal(booted.boot.status, 'ready');
    assert.equal(booted.experience.runPhase, 'playing');
    assert.equal(booted.gameplay.state.activeScaleStageId, 'MAX');
    assert.equal(booted.chunkDataService.transport.kind, 'worker');
    assert.equal(booted.chunkDataService.transport.mode, 'worker',
      JSON.stringify(booted.chunkDataService.transport.fallbackReason));
    assert.equal(booted.chunkDataService.transport.fallbackOccurred, false);
    assert.ok(initialTransportGenerated >= 25,
      'boot must obtain the resident set through the production Worker transport');
    assert.ok(booted.chunkDataService.counts.transportCalls >= 25,
      'the full ChunkDataService must dispatch the initial resident set');
    assert.equal(booted.presentationOwnerData.transport.serviceGeneration,
      booted.chunkDataService.transport.serviceGeneration,
      'Full and PresentationOwner services must share one production Worker transport');
    assert.ok(booted.presentationOwnerData.counts.requests < 1_757,
      'boot must not require-prewarm the complete 368 m Presentation coverage');
    assert.equal(booted.ownerGeneration.maximumConcurrentRequests, 1,
      'the global owner queue must feed exactly one operation into the serial Worker');
    assert.equal(booted.staticObjectStreaming.counts.plans > 0, true);
    assert.equal(booted.staticObjectStreaming.prefetchedOwnerCount, 0,
      'stationary boot must not create a degenerate velocity corridor');
    assert.equal(booted.staticObjectStreaming.admissionWindowCapacity, 4);
    assert.ok(booted.staticObjectStreaming.admissionWindowCount <= 4);
    assert.ok(booted.staticObjectStreaming.backlog <= 4,
      'the full Natural coverage must remain an immutable cursor, not materialized tasks');
    assert.equal(booted.visualContinuity.expectedOwnerCount,
      booted.staticObjectStreaming.requiredOwnerCount,
      'lazy admission must preserve the full immutable Expected denominator');
    assert.deepEqual(new Set(booted.staticObjectStreaming.policyKinds), new Set([
      'natural-tree',
      'natural-bush',
      'natural-grass',
      'natural-rock',
    ]));
    assert.ok(booted.treePathAudit.near.instanceCount > 0,
      'Natural must be present through the normal near renderer path');
    assert.equal(booted.presentation.visibleCanonicalTreeCount, 0,
      'Full Chunk boot data must not seed the policy-owned persistent Natural presentation');
    assert.equal(booted.presentation.staticTreePublishedOwnerCount, 0,
      'persistent Natural publication must wait for compact PresentationOwner policy pages');
    assert.ok(initialTerrainCommitCount >= 1);
    assert.notEqual(booted.presentation.activeLocalTerrainRootId, null);
    assert.ok(booted.presentation.canonicalBuildingRecordCount > 0);
    assert.ok(booted.presentation.canonicalRoadRecordCount > 0);
    assert.equal(booted.buildingSettlementStreaming.mode, 'shared');
    assert.ok(initialBuildingPublicationCount >= 1);
    assert.equal(booted.presentation.buildingPublicationSource, 'shared-streaming-plan');
    assert.equal(booted.presentation.settlementRoadPublicationSource, 'shared-streaming-plan');
    assert.ok(booted.renderInfo.drawCalls > 0,
      'the production scene must reach the renderer boundary');
    diagnose('production harness booted through Worker/CDS/static/Terrain/Road/Building');

    const initialPosition = logicalPosition(booted);
    await harness.advanceFrame({ hostDelayMs: 2 });
    assertStopped(initialPosition, logicalPosition(harness.snapshot()),
      'initial no-input frame must not move Player');

    let warmed = await harness.advanceUntil(snapshot => (
      snapshot.chunkDataService.transport.counts.presentationOwnersGenerated > 0
      && snapshot.presentation.staticTreePublishedOwnerCount > 0
      && snapshot.presentation.visibleCanonicalTreeCount > 0
    ), {
      maximumFrames: 300,
      hostDelayMs: 3,
      message: 'production PresentationOwner and static Natural publication did not warm',
    });
    // Ready-page builds can complete in a host-task turn following a render.
    // Keep advancing the real loop until the policy-published mesh itself has
    // crossed the renderer/GPU boundary.
    for (let frame = 0; frame < 30 && !naturalDensityMirrorsReady(harness); frame += 1) {
      await harness.advanceFrame({ hostDelayMs: 2 });
    }
    warmed = harness.snapshot();
    assert.equal(warmed.staticObjectStreaming.counts.failed, 0);
    assert.ok(warmed.staticObjectStreaming.admissionWindowCount <= 4);
    assert.ok(warmed.staticObjectStreaming.backlog <= 4);
    assert.ok(warmed.presentationOwnerData.counts.transportCalls > 0,
      'static Natural must request compact PresentationOwner resources through CDS');
    assert.ok(warmed.chunkDataService.transport.counts.presentationOwnersGenerated > 0,
      'the shared Worker must generate PresentationOwner resources');
    assert.ok(warmed.presentation.visibleCanonicalTreeCount > 0,
      'canonical Natural records must arrive through policy-owned Presentation pages');
    const warmedDensityAttributes = assertNaturalDensityGpuMirrors(harness, 'warm');
    assertVisualContinuityReceiptState(warmed, 'warm');
    diagnose(`static Natural warmed (${warmedDensityAttributes.length} density attributes)`);

    async function runInputFrame(name, codes) {
      harness.releaseAll();
      harness.press(...codes);
      const before = logicalPosition(harness.snapshot());
      await harness.advanceFrame({ hostDelayMs: 2 });
      const after = logicalPosition(harness.snapshot());
      const step = displacement(before, after);
      assertMaxSprint(step, name);
      return Object.freeze({ before, after, step, direction: normalized(step) });
    }

    const straight = await runInputFrame('straight', ['KeyW', 'ShiftLeft']);
    assertNear(straight.direction.x, 0, 1e-10, 'straight X direction');
    assertNear(straight.direction.z, -1, 1e-10, 'straight Z direction');

    const diagonal = await runInputFrame('diagonal', ['KeyW', 'KeyD', 'ShiftLeft']);
    assertNear(diagonal.direction.x, Math.SQRT1_2, 1e-10, 'diagonal X normalization');
    assertNear(diagonal.direction.z, -Math.SQRT1_2, 1e-10, 'diagonal Z normalization');

    const rightAngle = await runInputFrame('90-degree turn', ['KeyD', 'ShiftLeft']);
    assertNear(dot(straight.direction, rightAngle.direction), 0, 1e-10,
      'D sprint must be orthogonal to the original W sprint');

    const reversal = await runInputFrame('180-degree reversal', ['KeyS', 'ShiftLeft']);
    assertNear(dot(straight.direction, reversal.direction), -1, 1e-10,
      'S sprint must reverse the original W sprint');
    const reversalDensityAttributes = assertNaturalDensityGpuMirrors(harness, 'reversal');
    assert.ok(reversalDensityAttributes.length >= warmedDensityAttributes.length,
      'reversal must not lose rendered Natural density attribute mirrors');
    assertVisualContinuityReceiptState(harness.snapshot(), 'reversal');
    diagnose('initial/straight/diagonal/90/reversal input scenarios completed');

    harness.releaseAll();
    const stoppedBefore = logicalPosition(harness.snapshot());
    await harness.advanceFrame({ hostDelayMs: 2 });
    assertStopped(stoppedBefore, logicalPosition(harness.snapshot()),
      'stop frame must preserve Player position');

    const cameraOnlyBefore = harness.snapshot();
    harness.mouseMove({ movementX: 120, movementY: 0 });
    await harness.advanceFrame({ hostDelayMs: 2 });
    const cameraOnlyAfter = harness.snapshot();
    assertStopped(logicalPosition(cameraOnlyBefore), logicalPosition(cameraOnlyAfter),
      'camera-only yaw must not move Player');
    assert.notEqual(cameraOnlyAfter.experience.camera.yaw, cameraOnlyBefore.experience.camera.yaw,
      'the camera-only scenario must pass through the production mouse input handler');
    assert.equal(cameraOnlyAfter.staticObjectStreaming.counts.plans,
      cameraOnlyBefore.staticObjectStreaming.counts.plans,
      'camera-only yaw must not trigger a velocity-prefetch coverage request');

    const restart = await runInputFrame('restart after camera yaw', ['KeyW', 'ShiftLeft']);
    const yaw = cameraOnlyAfter.experience.camera.yaw;
    assertNear(restart.direction.x, -Math.sin(yaw), 1e-10,
      'restart X direction must follow camera yaw');
    assertNear(restart.direction.z, -Math.cos(yaw), 1e-10,
      'restart Z direction must follow camera yaw');

    const centerAtBoot = Object.freeze({
      chunkX: booted.runtime.centerChunkX,
      chunkZ: booted.runtime.centerChunkZ,
    });
    let crossedOwner = ownerOf(logicalPosition(harness.snapshot()));
    for (let frame = 0; frame < 48
      && crossedOwner.chunkX === centerAtBoot.chunkX
      && crossedOwner.chunkZ === centerAtBoot.chunkZ; frame += 1) {
      await harness.advanceFrame({ hostDelayMs: 2 });
      crossedOwner = ownerOf(logicalPosition(harness.snapshot()));
    }
    harness.releaseAll();
    assert.notDeepEqual(crossedOwner, centerAtBoot,
      'actual MAX sprint must cross a logical Chunk boundary without position injection');
    diagnose(`MAX sprint crossed into ${crossedOwner.chunkX},${crossedOwner.chunkZ}`);

    const settled = await harness.advanceUntil(snapshot => (
      snapshot.runtime.centerChunkX === crossedOwner.chunkX
      && snapshot.runtime.centerChunkZ === crossedOwner.chunkZ
      && snapshot.runtime.streaming.transitionPending === false
      && snapshot.runtime.streaming.preparationPending === false
      && snapshot.presentation.localTerrainTransitionGeneration
        === snapshot.runtime.transitionContract.generation
    ), {
      maximumFrames: 240,
      hostDelayMs: 3,
      message: 'real Worker/CDS/Terrain transition did not settle at the Player owner',
    });

    assert.ok(settled.chunkDataService.transport.counts.generated > initialTransportGenerated,
      'crossing must generate replacement owners through the Worker transport');
    assert.ok(settled.presentation.localTerrainCommitCount > initialTerrainCommitCount,
      'Terrain replacement must commit after the movement-driven transition');
    assert.ok(settled.staticObjectStreaming.counts.plans > initialStaticPlanCount,
      'movement-driven coverage must produce a new static Natural plan');
    assert.ok(settled.buildingSettlementStreaming.counts.published
      >= initialBuildingPublicationCount,
    'Building/Settlement shared publication must remain live across the transition');
    assert.equal(settled.presentation.buildingPublicationSource, 'shared-streaming-plan');
    assert.equal(settled.presentation.settlementRoadPublicationSource, 'shared-streaming-plan');
    assert.ok(settled.presentation.canonicalBuildingRecordCount > 0);
    assert.ok(settled.presentation.canonicalRoadRecordCount > 0);
    assert.equal(settled.staticObjectStreaming.counts.failed, 0);
    assert.ok(settled.staticObjectStreaming.admissionWindowCount <= 4);
    assert.ok(settled.staticObjectStreaming.backlog <= 4);
    assert.equal(settled.chunkDataService.transport.fallbackOccurred, false);
    diagnose('movement-driven Worker/CDS/Terrain transition settled');

    const schedulerSnapshot = harness.scheduler.snapshot();
    for (let index = 1; index < schedulerSnapshot.frameTimestamps.length; index += 1) {
      assertNear(
        schedulerSnapshot.frameTimestamps[index] - schedulerSnapshot.frameTimestamps[index - 1],
        PRODUCTION_FRAME_MS,
        1e-9,
        `virtual frame ${index} duration`,
      );
    }
    assert.equal(schedulerSnapshot.pendingAnimationFrameCount, 1,
      'the production loop must retain exactly one next-frame request');
    assert.equal(
      harness.environment.renderer().renderCount,
      initialRendererCount + schedulerSnapshot.frameCount,
      'every injected production rAF must reach render exactly once',
    );
    if (settled.visualContinuity) {
      assert.equal(
        settled.visualContinuity.renderFrames.completedFrameCount,
        harness.environment.renderer().renderCount,
        'renderer acknowledger must issue exactly one completed receipt per production render',
      );
    }

    t.diagnostic(JSON.stringify({
      virtualFrames: schedulerSnapshot.frameCount,
      player: settled.spatial.playerLogical,
      runtimeCenter: [settled.runtime.centerChunkX, settled.runtime.centerChunkZ],
      workerCounts: settled.chunkDataService.transport.counts,
      terrainCommits: settled.presentation.localTerrainCommitCount,
      staticPlans: settled.staticObjectStreaming.counts.plans,
      staticPublishedOwners: settled.presentation.staticTreePublishedOwnerCount,
      buildingPublications: settled.buildingSettlementStreaming.counts.published,
      rendererDrawCalls: settled.renderInfo.drawCalls,
      densityAttributeCount: reversalDensityAttributes.length,
    }));
  } finally {
    await harness.shutdown();
  }
});
