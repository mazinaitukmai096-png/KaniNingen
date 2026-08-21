import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAYER_MAX_SPRINT_METERS_PER_SECOND } from '../src/player-scale-profile.js';
import { LOGICAL_CHUNK_SIZE_METERS } from '../src/infinite-world/chunk-coordinates.js';
import { getW6ScaleProfile } from '../src/infinite-world/gameplay-contract.js';
import {
  PRODUCTION_FRAME_MS,
  PRODUCTION_FRAME_SECONDS,
  bootProductionSchedulingHarness,
  productionHarnessGpuUploadContractSnapshot,
  productionHarnessResidentSafetyMetrics,
  productionHarnessTraverseVisitCount,
} from './helpers/infinite-world-production-scheduling-harness.mjs';

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

const NATURAL_LOD_GPU_ATTRIBUTE_NAMES = new Set([
  'w8NaturalAnchorXZ',
  'w8NaturalInitialReveal',
]);

const naturalLodAttributes = harness => harness.gpuMirrorSnapshot().filter(attribute => (
  NATURAL_LOD_GPU_ATTRIBUTE_NAMES.has(attribute.attributeName)
    && attribute.path.includes('w8-persistent-static-natural-pages')
));

const naturalLodMirrorsReady = harness => {
  const attributes = naturalLodAttributes(harness);
  return attributes.length > 0 && attributes.every(attribute => (
    attribute.gpuArray !== null
      && attribute.gpuVersion === attribute.cpuVersion
      && attribute.gpuArray.length === attribute.cpuArray.length
      && attribute.gpuArray.every((value, index) => Object.is(value, attribute.cpuArray[index]))
  ));
};

function assertNaturalLodGpuMirrors(harness, phase) {
  const attributes = naturalLodAttributes(harness);
  assert.ok(attributes.length > 0,
    `${phase}: persistent Natural LOD attributes must exist`);
  assert.deepEqual(new Set(attributes.map(attribute => attribute.attributeName)),
    NATURAL_LOD_GPU_ATTRIBUTE_NAMES,
    `${phase}: persistent Natural must expose anchor and reveal attributes`);
  for (const attribute of attributes) {
    assert.notEqual(attribute.gpuArray, null,
      `${phase}: ${attribute.path} ${attribute.attributeName} must have a renderer-side mirror`);
    assert.equal(attribute.gpuVersion, attribute.cpuVersion,
      `${phase}: ${attribute.path} ${attribute.attributeName} versions must match`);
    assert.deepEqual(attribute.gpuArray, attribute.cpuArray,
      `${phase}: ${attribute.path} ${attribute.attributeName} CPU/GPU values must match`);
  }
  return attributes;
}

const gpuMirrorMismatchCount = attributes => attributes.filter(attribute => (
  attribute.gpuArray === null
    || attribute.gpuVersion !== attribute.cpuVersion
    || attribute.gpuArray.length !== attribute.cpuArray.length
    || attribute.gpuArray.some((value, index) => !Object.is(value, attribute.cpuArray[index]))
)).length;


function assertVisualContinuityReceiptState(snapshot, phase) {
  const continuity = snapshot.visualContinuity ?? null;
  assert.notEqual(continuity, null,
    `${phase}: production boot must expose the always-on visual continuity registry`);
  assert.ok(continuity.expectedOwnerCount > 0,
    `${phase}: Natural policy coverage must populate the Expected denominator`);
  assert.ok(continuity.coarseDrawableCount > 0,
    `${phase}: policy-owned Presentation pages must reach CoarseDrawable`);
  assert.ok(continuity.detailDrawableCount > 0,
    `${phase}: Full owners must reach DetailDrawable after the coarse contract is complete`);
  assert.equal(snapshot.treePathAudit?.near?.pathId, 'near-tree',
    `${phase}: the normal Near Tree route must remain registered`);
  assert.ok(snapshot.treePathAudit.near.publicationSources.includes('runtime-chunk-load'),
    `${phase}: the Near Tree route must remain owned by runtime Chunk publication`);
  assert.ok((continuity.renderFrames?.completedFrameCount ?? 0) > 0,
    `${phase}: drawable lifecycle must contain a completed renderer receipt`);
  assert.equal(continuity.actualDrawableLatencyMs?.includesMissingOwners, true,
    `${phase}: continuity latency must retain missing expected owners in its denominator`);
}

function assertMaxSprint(step, name) {
  const speed = magnitude(step) / PRODUCTION_FRAME_SECONDS;
  assertNear(speed, PLAYER_MAX_SPRINT_METERS_PER_SECOND, 1e-7,
    `${name} must use the production MAX sprint speed`);
}

const ownerOf = position => Object.freeze({
  chunkX: Math.floor(position.x / LOGICAL_CHUNK_SIZE_METERS),
  chunkZ: Math.floor(position.z / LOGICAL_CHUNK_SIZE_METERS),
});

test('production harness scene traversal visits each child once', () => {
  assert.equal(productionHarnessTraverseVisitCount(), 1);
});

test('production harness GPU mirrors follow Three r160 object-update eligibility', () => {
  assert.deepEqual(productionHarnessGpuUploadContractSnapshot(), {
    zeroCountGeometryUploaded: true,
    zeroCountInstanceMatrixUploaded: true,
    materialHiddenGeometryUploaded: true,
    materialHiddenIndexUploaded: false,
    hierarchyHiddenGeometryUploaded: false,
    visibleIndexUploaded: true,
    auditIncludesZeroCount: true,
    auditIncludesMaterialHiddenGeometry: true,
    auditIncludesMaterialHiddenIndex: false,
    auditIncludesHierarchyHidden: false,
    auditedMismatchCount: 0,
  });
});

test('production release gate excludes obsolete non-resident prefetch cancellation', () => {
  const metrics = productionHarnessResidentSafetyMetrics({
    chunkDataService: {
      counts: {
        cancelledOperations: 3,
        protectedOwnerEvictions: 0,
      },
    },
    runtime: {
      terrainReady: {
        residentWorld: {
          requiredCancellationByPrefetch: 0,
          coverageMiss: 0,
        },
        chunkDataSubscriberDiagnostics: {
          chunkDataDuplicateRequests: 0,
          chunkDataSameOwnerRerequestCount: 1,
        },
      },
    },
  });
  assert.deepEqual(metrics, {
    residentRequiredCancellationCount: 0,
    protectedOwnerEvictionCount: 0,
    concurrentDuplicateRerequestCount: 0,
    coverageMissCount: 0,
    allCancellationCount: 3,
    historicalSameOwnerRerequestCount: 1,
  });
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
  assert.equal(maxProfile.sprintMetersPerSecond, PLAYER_MAX_SPRINT_METERS_PER_SECOND,
    'the runtime meter profile must derive the protected production scale contract');

  const harness = await bootProductionSchedulingHarness();
  try {
    const booted = harness.snapshot();
    const initialWorldRendererCount = harness.environment.renderer().worldRenderCount;
    const initialStagingRendererCount = harness.environment.renderer().stagingRenderCount;
    const initialTransportGenerated = booted.chunkDataService.transport.counts.generated;
    const initialTerrainCommitCount = booted.presentation.localTerrainCommitCount;
    const initialStaticPlanCount = booted.staticObjectStreaming.counts.plans;
    const initialBuildingPublicationCount = booted.buildingSettlementStreaming.counts.published;

    assert.equal(booted.boot.status, 'ready');
    assert.equal(booted.experience.runPhase, 'playing');
    assert.equal(booted.gameplay.state.activeScaleStageId, 'MAX');
    assert.equal(booted.chunkDataService.transport.kind, 'worker-fixed-lanes');
    assert.equal(booted.chunkDataService.transport.mode, 'worker',
      JSON.stringify(booted.chunkDataService.transport.fallbackReason));
    assert.equal(booted.chunkDataService.transport.fallbackOccurred, false);
    assert.equal(booted.chunkDataService.transport.lanes.critical.mode, 'worker');
    assert.equal(booted.chunkDataService.transport.lanes.background.mode, 'worker');
    assert.ok(initialTransportGenerated >= 25,
      'boot must obtain the resident set through the production Worker transport');
    assert.ok(booted.chunkDataService.counts.transportCalls >= 25,
      'the full ChunkDataService must dispatch the initial resident set');
    assert.equal(booted.presentationOwnerData.transport.serviceGeneration,
      booted.chunkDataService.transport.serviceGeneration,
      'Full and PresentationOwner services must share one fixed-lane transport');
    assert.ok(booted.presentationOwnerData.counts.requests < 1_757,
      'boot must not require-prewarm the complete 368 m Presentation coverage');
    assert.equal(booted.ownerGeneration.maximumConcurrentRequests, 2,
      'the global owner queue must expose exactly the fixed Critical/Background lanes');
    assert.equal(booted.ownerGeneration.lanes.critical.maximumConcurrentRequests, 2,
      'Critical admits one required Full beside one cancellable future-Full');
    assert.equal(booted.ownerGeneration.lanes.background.maximumConcurrentRequests, 1,
      'Background remains single-flight');
    assert.equal(booted.staticObjectStreaming.counts.plans > 0, true);
    assert.equal(booted.staticObjectStreaming.prefetchedOwnerCount, 0,
      'stationary boot must not create a degenerate velocity corridor');
    assert.equal(booted.staticObjectStreaming.admissionWindowCapacity, 4);
    assert.ok(booted.staticObjectStreaming.admissionWindowCount <= 4);
    assert.ok(booted.staticObjectStreaming.backlog <= 4,
      'the full Natural coverage must remain an immutable cursor, not materialized tasks');
    assert.equal(booted.visualContinuity.expectedOwnerCount,
      booted.staticObjectStreaming.visualExpectedOwnerCount,
      'lazy admission must preserve the true visual Expected denominator');
    assert.equal(booted.visualContinuity.expectedOwnerCount,
      booted.staticObjectStreaming.bootCohortOwnerCount,
      'stationary boot must stage the true visual-current cohort');
    assert.ok(booted.visualContinuity.expectedOwnerCount
      < booted.staticObjectStreaming.requiredOwnerCount,
    'the 16 m resource prewarm margin must stay outside visual Expected');
    assert.ok(booted.staticObjectStreaming.coarsePrewarmOwnerCount > 0);
    assert.equal(
      booted.staticObjectStreaming.visualExpectedOwnerCount
        + booted.staticObjectStreaming.coarsePrewarmOwnerCount,
      booted.staticObjectStreaming.requiredOwnerCount,
      'visual Expected and coarse prewarm must partition the 368 m Resource window',
    );
    assert.deepEqual(new Set(booted.staticObjectStreaming.policyKinds), new Set([
      'natural-tree',
      'natural-rock',
    ]));
    // Road Graph v3 / Lot v2 can legitimately clear every Tree from the
    // initial Near footprint. Verify route ownership instead of fixture content.
    assert.equal(booted.treePathAudit.near.pathId, 'near-tree');
    assert.deepEqual(booted.treePathAudit.near.rootNames, ['w1a-render-root']);
    assert.deepEqual(booted.treePathAudit.near.publicationSources, ['runtime-chunk-load']);
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
    assertStopped(initialPosition, harness.logicalPlayerPosition(),
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
    for (let frame = 0; frame < 30 && !naturalLodMirrorsReady(harness); frame += 1) {
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
    const warmedNaturalLodAttributes = assertNaturalLodGpuMirrors(harness, 'warm');
    diagnose(JSON.stringify({
      continuityCounts: {
        expected: warmed.visualContinuity?.expectedOwnerCount,
        coarse: warmed.visualContinuity?.coarseDrawableCount,
        detail: warmed.visualContinuity?.detailDrawableCount,
      },
      resolvedCoarseRequirements:
        warmed.visualContinuity?.coarseComponentMetrics?.requirementsResolvedOwnerCount,
      missingForest:
        warmed.visualContinuity?.coarseComponentMetrics?.forest?.missingCount,
    }));
    assertVisualContinuityReceiptState(warmed, 'warm');

    const bootFilled = await harness.waitForBootCohortCoarse({
      maximumFrames: 6_000,
      hostDelayMs: 2,
      checkIntervalFrames: 30,
    });
    assert.equal(harness.bootCohort.expectedOwnerCount,
      booted.visualContinuity.expectedOwnerCount,
      'the immutable boot cohort must equal the boot Expected denominator');
    assert.equal(bootFilled.visualContinuity.coarseDrawableCount,
      harness.bootCohort.expectedOwnerCount,
      'the explicit test observation must wait for every boot Expected owner to become CoarseDrawable');
    assert.equal(
      bootFilled.visualContinuity.coarseComponentMetrics.requirementsUnresolvedOwnerCount,
      0,
      'full boot fill must resolve every owner coarse requirement summary',
    );
    for (const component of ['terrain', 'structure', 'forest']) {
      const metrics = bootFilled.visualContinuity.coarseComponentMetrics[component];
      assert.equal(metrics.missingCount, 0,
        `${component}: immutable boot cohort must have zero missing coarse components`);
      assert.equal(metrics.deadlineMissCount, 0,
        `${component}: immutable boot cohort must have zero coarse component deadline misses`);
      assert.equal(
        bootFilled.visualContinuity.currentReceiptCoarseComponentMetrics[component].missingCount,
        0,
        `${component}: immutable boot cohort must be present in the latest completed receipt`,
      );
    }
    const coarseSafetyFilled = await harness.advanceUntil(snapshot => (
      snapshot.staticObjectStreaming.coarsePrewarmOwnerCount > 0
        && snapshot.presentation.staticTreeCoarsePrewarmResidentOwnerCount
          === snapshot.staticObjectStreaming.coarsePrewarmOwnerCount
        && snapshot.presentation.staticTreeCoarsePrewarmPublishedOwnerCount
          === snapshot.staticObjectStreaming.coarsePrewarmOwnerCount
    ), {
      maximumFrames: 300,
      hostDelayMs: 2,
      checkIntervalFrames: 30,
      message: 'the 300-322.63 m coarse safety shell did not reach the existing publisher',
    });
    await harness.advanceFrame({ hostDelayMs: 2 });
    warmed = harness.snapshot();
    assert.equal(
      coarseSafetyFilled.presentation.staticTreeCoarsePrewarmPublishedOwnerCount,
      coarseSafetyFilled.staticObjectStreaming.coarsePrewarmOwnerCount,
    );
    assertNaturalLodGpuMirrors(harness, 'coarse-safety-receipt');
    harness.resetReleaseGateObservation();
    diagnose(`static Natural warmed (${warmedNaturalLodAttributes.length} LOD attributes)`);

    async function runInputFrame(name, codes, frameCount = 6) {
      harness.releaseAll();
      harness.press(...codes);
      const before = harness.logicalPlayerPosition();
      let previous = before;
      for (let frame = 0; frame < frameCount; frame += 1) {
        await harness.advanceFrame({ hostDelayMs: 2 });
        const current = harness.logicalPlayerPosition();
        assertMaxSprint(displacement(previous, current), `${name} frame ${frame + 1}`);
        previous = current;
      }
      const after = harness.logicalPlayerPosition();
      const step = displacement(before, after);
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
    const reversalNaturalLodAttributes = assertNaturalLodGpuMirrors(harness, 'reversal');
    assert.ok(reversalNaturalLodAttributes.length >= warmedNaturalLodAttributes.length,
      'reversal must not lose rendered Natural LOD attribute mirrors');
    assertVisualContinuityReceiptState(harness.snapshot(), 'reversal');
    for (const [index, codes] of [
      ['KeyW', 'ShiftLeft'],
      ['KeyD', 'ShiftLeft'],
      ['KeyS', 'ShiftLeft'],
      ['KeyA', 'ShiftLeft'],
      ['KeyW', 'KeyD', 'ShiftLeft'],
      ['KeyS', 'KeyA', 'ShiftLeft'],
    ].entries()) {
      await runInputFrame(`rapid direction ${index + 1}`, codes, 2);
    }
    diagnose('initial/straight/diagonal/90/reversal input scenarios completed');

    harness.releaseAll();
    const stoppedBefore = harness.logicalPlayerPosition();
    await harness.advanceFrame({ hostDelayMs: 2 });
    assertStopped(stoppedBefore, harness.logicalPlayerPosition(),
      'stop frame must preserve Player position');

    const yawBaseline = await harness.waitForStrictCoarseFill({
      maximumFrames: 600,
      hostDelayMs: 2,
      checkIntervalFrames: 30,
      requireVisualRequiredEqualsExpected: true,
      message: 'no-input yaw control could not reach a complete visual Expected baseline',
    });
    const preYawDeadlineMisses = yawBaseline.visualContinuity.owners
      .filter(owner => owner.state !== 'Retiring' && owner.deadlineMiss)
      .map(owner => ({
        ownerKey: owner.ownerKey,
        expectedAt: owner.expectedAt,
        firstPossibleVisibleAt: owner.firstPossibleVisibleAt,
        deadlineAtMs: owner.deadlineAtMs,
        coarseDrawableAt: owner.coarseDrawableAt,
        deadlineMissMs: owner.deadlineMissMs,
        terrainDrawableAt: owner.terrainDrawableAt,
        structureCoarseDrawableAt: owner.structureCoarseDrawableAt,
        forestCoarseDrawableAt: owner.forestCoarseDrawableAt,
        requiredForestStableIds: owner.requiredForestStableIds,
        drawnForestStableIds: owner.drawnForestStableIds,
      }));
    assert.equal(yawBaseline.visualContinuity.deadlineMissCount, 0,
      `pre-yaw steady visual baseline must retain zero coarse deadline misses: ${JSON.stringify(
        preYawDeadlineMisses,
      )}`);
    for (const component of ['terrain', 'structure', 'forest']) {
      assert.equal(
        yawBaseline.visualContinuity.coarseComponentMetrics[component].deadlineMissCount,
        0,
        `${component}: pre-yaw steady baseline must retain zero deadline misses`,
      );
    }

    const cameraControlBefore = harness.snapshot();
    await harness.advanceFrames(2, { hostDelayMs: 2 });
    const cameraOnlyBefore = harness.snapshot();
    const cameraControlDeltas = {
      ownerRequests: (cameraOnlyBefore.ownerGeneration.counts?.requested ?? 0)
        - (cameraControlBefore.ownerGeneration.counts?.requested ?? 0),
      presentationRequests: (cameraOnlyBefore.presentationOwnerData.counts?.requests ?? 0)
        - (cameraControlBefore.presentationOwnerData.counts?.requests ?? 0),
      canonicalCompose: (cameraOnlyBefore.presentation.canonicalComposeCount ?? 0)
        - (cameraControlBefore.presentation.canonicalComposeCount ?? 0),
    };
    const cameraOnlyGenerationBefore = {
      staticPlans: cameraOnlyBefore.staticObjectStreaming.counts.plans,
      transitionGeneration: cameraOnlyBefore.runtime.transitionContract.generation,
      terrainCommits: cameraOnlyBefore.presentation.localTerrainCommitCount,
      ownerRequests: cameraOnlyBefore.ownerGeneration.counts?.requested ?? 0,
      presentationRequests: cameraOnlyBefore.presentationOwnerData.counts?.requests ?? 0,
      canonicalCompose: cameraOnlyBefore.presentation.canonicalComposeCount ?? 0,
      staticCoverageGeneration: cameraOnlyBefore.staticObjectStreaming.coverageGeneration,
      staticPlanRevision: cameraOnlyBefore.staticObjectStreaming.planRevision,
      staticLatestPlanId: cameraOnlyBefore.staticObjectStreaming.latestPlanId,
      staticNaturalCoverageApplyCount:
        cameraOnlyBefore.presentation.staticNaturalCoverageApplyCount,
    };
    harness.mouseMove({ movementX: 120, movementY: 0 });
    await harness.advanceFrame({ hostDelayMs: 2 });
    const sampleYawAfter = harness.snapshot();
    const yawPerMouseUnit = Math.abs(
      sampleYawAfter.experience.camera.yaw - cameraOnlyBefore.experience.camera.yaw
    ) / 120;
    harness.mouseMove({ movementX: (Math.PI * 2) / yawPerMouseUnit - 120, movementY: 0 });
    await harness.advanceFrame({ hostDelayMs: 2 });
    const cameraOnlyAfter = harness.snapshot();
    assertStopped(logicalPosition(cameraOnlyBefore), logicalPosition(cameraOnlyAfter),
      'camera-only yaw must not move Player');
    const cameraYawChange = cameraOnlyAfter.experience.camera.yaw
      - cameraOnlyBefore.experience.camera.yaw;
    assertNear(Math.abs(cameraYawChange), Math.PI * 2, 1e-10,
      'the camera-only scenario must execute a true 2π yaw through production mouse input');
    assert.equal(cameraOnlyAfter.staticObjectStreaming.counts.plans,
      cameraOnlyBefore.staticObjectStreaming.counts.plans,
      'camera-only yaw must not trigger a velocity-prefetch coverage request');
    const cameraYawTriggeredGeneration = (
      cameraOnlyAfter.staticObjectStreaming.counts.plans
        - cameraOnlyGenerationBefore.staticPlans
    ) + (
      cameraOnlyAfter.runtime.transitionContract.generation
        - cameraOnlyGenerationBefore.transitionGeneration
    ) + (
      cameraOnlyAfter.presentation.localTerrainCommitCount
        - cameraOnlyGenerationBefore.terrainCommits
    );
    assert.equal(cameraYawTriggeredGeneration, 0,
      'camera-only yaw triggered generation must remain exactly zero');
    const cameraYawOwnerRequestDelta = (cameraOnlyAfter.ownerGeneration.counts?.requested ?? 0)
      - cameraOnlyGenerationBefore.ownerRequests;
    const cameraYawPresentationRequestDelta =
      (cameraOnlyAfter.presentationOwnerData.counts?.requests ?? 0)
      - cameraOnlyGenerationBefore.presentationRequests
      ;
    const cameraYawComposeDelta = (cameraOnlyAfter.presentation.canonicalComposeCount ?? 0)
      - cameraOnlyGenerationBefore.canonicalCompose;
    const cameraYawRawDeltas = {
      ownerRequests: cameraYawOwnerRequestDelta,
      presentationRequests: cameraYawPresentationRequestDelta,
      canonicalCompose: cameraYawComposeDelta,
    };
    assert.equal(cameraOnlyAfter.staticObjectStreaming.coverageGeneration,
      cameraOnlyGenerationBefore.staticCoverageGeneration,
      'camera yaw must not create a new static coverage generation');
    assert.equal(cameraOnlyAfter.staticObjectStreaming.planRevision,
      cameraOnlyGenerationBefore.staticPlanRevision,
      'camera yaw must not revise the static plan');
    assert.equal(cameraOnlyAfter.staticObjectStreaming.latestPlanId,
      cameraOnlyGenerationBefore.staticLatestPlanId,
      'camera yaw must not replace the static world plan');
    assert.equal(cameraOnlyAfter.presentation.staticNaturalCoverageApplyCount,
      cameraOnlyGenerationBefore.staticNaturalCoverageApplyCount,
      'camera yaw must not apply a new Natural coverage plan');
    diagnose(JSON.stringify({
      camera360Yaw: {
        yawChangeRadians: cameraYawChange,
        staticPlanDelta: cameraOnlyAfter.staticObjectStreaming.counts.plans
          - cameraOnlyBefore.staticObjectStreaming.counts.plans,
        rawOwnerRequestDelta: cameraYawOwnerRequestDelta,
        rawPresentationRequestDelta: cameraYawPresentationRequestDelta,
        rawComposeDelta: cameraYawComposeDelta,
        noInputControlDeltas: cameraControlDeltas,
        rawDeltasIncludeBackgroundStagedFill: true,
      },
    }));

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
    let crossedOwner = ownerOf(harness.logicalPlayerPosition());
    for (let frame = 0; frame < 48
      && crossedOwner.chunkX === centerAtBoot.chunkX
      && crossedOwner.chunkZ === centerAtBoot.chunkZ; frame += 1) {
      await harness.advanceFrame({ hostDelayMs: 2 });
      crossedOwner = ownerOf(harness.logicalPlayerPosition());
    }
    harness.releaseAll();
    assert.notDeepEqual(crossedOwner, centerAtBoot,
      'actual MAX sprint must cross a logical Chunk boundary without position injection');
    diagnose(`MAX sprint crossed into ${crossedOwner.chunkX},${crossedOwner.chunkZ}`);

    let settled = await harness.advanceUntil(snapshot => (
      snapshot.runtime.centerChunkX === crossedOwner.chunkX
      && snapshot.runtime.centerChunkZ === crossedOwner.chunkZ
      && snapshot.runtime.streaming.transitionPending === false
      && snapshot.runtime.streaming.preparationPending === false
      && snapshot.presentation.localTerrainTransitionGeneration
        === snapshot.runtime.transitionContract.generation
    ), {
      maximumFrames: 240,
      hostDelayMs: 3,
      checkIntervalFrames: 12,
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

    settled = await harness.waitForStrictCoarseFill({
      maximumFrames: 1_200,
      hostDelayMs: 2,
      checkIntervalFrames: 30,
      message: 'movement-driven Expected cohort did not finish strict aggregate coarse fill',
    });

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
      harness.environment.renderer().worldRenderCount,
      initialWorldRendererCount + schedulerSnapshot.frameCount,
      'every injected production rAF must reach render exactly once',
    );
    assert.equal(
      harness.environment.renderer().stagingRenderCount - initialStagingRendererCount,
      settled.runtime.renderUploadAdmission.counts.stagedBuckets,
      'every admitted upload bucket must use exactly one private staging render',
    );
    if (settled.visualContinuity) {
      assert.equal(
        settled.visualContinuity.renderFrames.completedFrameCount,
        harness.environment.renderer().worldRenderCount,
        'renderer acknowledger must issue exactly one completed receipt per world render',
      );
    }

    const releaseGate = harness.releaseGateMetrics();
    const gpuAttributes = harness.gpuMirrorSnapshot();
    const releaseProof = Object.freeze({
      gpuAttributeCount: gpuAttributes.length,
      gpuMismatchCount: gpuMirrorMismatchCount(gpuAttributes),
      scanErrorCount: settled.visualContinuity.lastReceiptPresentation.scanErrorCount,
      presentationResidentCancellation:
        settled.presentationOwnerData.counts.cancelledOperations,
      fullResidentCancellation:
        releaseGate.residentSafety.residentRequiredCancellationCount,
      fullAllCancellationDiagnostic:
        releaseGate.residentSafety.allCancellationCount,
      presentationResidentEviction:
        settled.presentationOwnerData.counts.protectedOwnerEvictions,
      fullResidentEviction:
        releaseGate.residentSafety.protectedOwnerEvictionCount,
      sameOwnerDuplicateRerequest:
        releaseGate.residentSafety.concurrentDuplicateRerequestCount,
      sameOwnerHistoricalRerequestDiagnostic:
        releaseGate.residentSafety.historicalSameOwnerRerequestCount,
      fullResidentCoverageMiss:
        releaseGate.residentSafety.coverageMissCount,
      terrainHole: settled.presentation.visibleTerrainHoleFrame,
      collisionMiss: settled.terrainCoverageDiagnostics.collisionCoverageMiss,
      movementBlock: settled.terrainCoverageDiagnostics.movementBlockedByTerrain,
    });
    assert.equal(releaseProof.gpuMismatchCount, 0,
      `renderer-eligible GPU mirrors must match exactly: ${JSON.stringify(releaseProof)}`);
    assert.equal(releaseProof.scanErrorCount, 0,
      'the completed Visual Continuity receipt scan must have zero errors');
    assert.equal(releaseProof.presentationResidentCancellation, 0,
      'Presentation resident generation must not be cancelled');
    assert.equal(releaseProof.fullResidentCancellation, 0,
      'Full resident generation must not be cancelled');
    assert.equal(releaseProof.presentationResidentEviction, 0,
      'Presentation resident owners must not be evicted');
    assert.equal(releaseProof.fullResidentEviction, 0,
      'Full resident owners must not be evicted');
    assert.equal(releaseProof.sameOwnerDuplicateRerequest, 0,
      'Full resident owners must not be requested twice during the same transition');
    assert.equal(releaseProof.fullResidentCoverageMiss, 0,
      'Full resident coverage must not miss a required owner');
    assert.equal(releaseProof.terrainHole, 0,
      'completed production frames must not expose a visible Terrain hole');
    assert.equal(releaseProof.collisionMiss, 0,
      'movement must not miss collision Terrain coverage');
    assert.equal(releaseProof.movementBlock, 0,
      'Terrain readiness must not block movement');
    assert.equal(settled.runtimeTransitionFault.mutationStopped, false);
    assert.equal(settled.runtimeTransitionFault.retry.status, 'idle',
      'a successful production transition must reset retry ownership');
    assert.equal(settled.runtimeTransitionFault.retry.attempts, 0);
    assert.equal(settled.runtimeTransitionFault.retry.timerCount, 0,
      'a successful production transition cannot retain a backoff timer');
    const nearUploadAdmission = settled.runtime.renderUploadAdmission;
    assert.equal(nearUploadAdmission?.schemaVersion,
      'render-upload-admission-snapshot-1',
    'production boot must route Near replacement owners through upload admission');
    assert.equal(nearUploadAdmission.ownerLimitPerFrame, 1);
    assert.equal(nearUploadAdmission.queueDepth, 0,
      'settled MAX sprint must drain every Near upload admission');
    assert.equal(nearUploadAdmission.pendingPublicationOwnerKey, null);
    assert.equal(nearUploadAdmission.counts.published, 3,
      'one entering Near column must publish exactly three replacement owners');
    assert.ok(nearUploadAdmission.counts.maximumFrameBytes
      <= nearUploadAdmission.budgetBytes,
    `Near upload bytes exceeded the per-render envelope: ${JSON.stringify(
      nearUploadAdmission,
    )}`);
    assert.equal(releaseGate.schemaVersion,
      'infinite-world-production-release-gate-metrics-1');
    assert.deepEqual(releaseGate.lifecycle, {
      ...releaseGate.lifecycle,
      expected: settled.visualContinuity.expectedOwnerCount,
      coarse: settled.visualContinuity.coarseDrawableCount,
      detail: settled.visualContinuity.detailDrawableCount,
      coarseMiss: settled.visualContinuity.deadlineMissCount,
      oldestCoarseMissingMs: settled.visualContinuity.oldestMissingAgeMs,
    }, 'release gate lifecycle counts must be the strict receipt-backed registry values');
    assert.equal(releaseGate.lifecycle.coarseMiss, 0,
      `finite MAX sprint scenario must have zero coarse drawable deadline misses: ${JSON.stringify(
        releaseGate,
      )}`);
    assert.deepEqual(releaseGate.coarseComponents,
      settled.visualContinuity.coarseComponentMetrics,
      'release gate component metrics must be the production registry snapshot');
    assert.deepEqual(releaseGate.currentCoarseComponents,
      settled.visualContinuity.currentReceiptCoarseComponentMetrics,
      'release gate must expose the latest completed-receipt component coverage');
    assert.equal(releaseGate.coarseComponents.terrain.missingCount, 0,
      'Terrain coarse coverage must be receipt-backed for every Expected owner');
    assert.equal(releaseGate.coarseComponents.requirementsUnresolvedOwnerCount, 0,
      'release gate must have zero unresolved coarse requirement summaries');
    for (const component of ['terrain', 'structure', 'forest']) {
      assert.equal(releaseGate.coarseComponents[component].missingCount, 0,
        `${component}: release gate must have zero missing coarse components`);
      assert.equal(releaseGate.coarseComponents[component].deadlineMissCount, 0,
        `${component}: release gate must have zero coarse component deadline misses`);
      assert.equal(releaseGate.currentCoarseComponents[component].missingCount, 0,
        `${component}: release gate must have zero current-receipt component holes`);
    }
    assert.deepEqual(releaseGate.coarseContinuity, {
      terrainDisappearanceFrames: 0,
      structureDisappearanceFrames: 0,
      forestDisappearanceFrames: 0,
    }, 'receipt-proven coarse components must not disappear during movement scenarios');
    assert.ok(releaseGate.lifecycle.detailMissingCount >= 0,
      'detailMissingCount is an explicitly labelled population, not a deadline-miss metric');
    assert.equal(Object.hasOwn(releaseGate.lifecycle, 'detailMiss'), false,
      'missing DetailDrawable owners must not be mislabeled as deadline misses');
    assert.ok(releaseGate.queues.generationAgeMs >= 0);
    assert.equal(releaseGate.queues.naturalWorkQueueAgeMeasurable, true);
    assert.ok(releaseGate.queues.naturalWorkQueueAgeMs >= 0);
    assert.ok(releaseGate.queues.naturalAdmissionCursorAgeMs >= 0);
    assert.ok(releaseGate.gpuUploadLatencyMs.count > 0,
      'actual renderer receipts must produce GPU upload latency samples');
    assert.ok(releaseGate.treePresenters.frameCount > 0,
      'steady MAX scenarios must record completed-receipt Tree presenter frames');
    assert.equal(releaseGate.treePresenters.zeroPresenterFrames, 0,
      `a previously presented required Tree must never have a zero-presenter frame: ${
        JSON.stringify(releaseGate.treePresenters.latest)}`);
    assert.equal(releaseGate.treePresenters.duplicatePresenterFrames, 0,
      `a canonical Tree must not have a duplicate presenter frame: ${
        JSON.stringify(releaseGate.treePresenters.latest)}`);
    assert.ok(releaseGate.treePresenters.duplicatePresenterFrames
      <= releaseGate.treePresenters.frameCount,
    'brief OLD-coarse/NEW-Near overlap receipts are allowed and remain measured');
    assert.equal(releaseGate.treePresenters.latest.duplicatePresenterCount, 0,
      `Near/coarse overlap must be gone after the settled release gate: ${
        JSON.stringify(releaseGate.treePresenters.latest)}`);
    assert.equal(releaseGate.treePresenters.duplicateCoarsePresenterFrames, 0,
      `one canonical coarse Tree identity must not appear in multiple coarse meshes: ${
        JSON.stringify(releaseGate.treePresenters.latest)}`);
    assert.equal(
      releaseGate.currentCoarseComponents.forest.drawableCount,
      releaseGate.currentCoarseComponents.forest.requiredCount,
      'the completed receipt must draw every required Forest Stable ID',
    );
    for (const [label, value] of Object.entries(releaseGate.bootFillMs)) {
      assert.ok(Number.isFinite(value) && value >= 0,
        `immutable boot cohort ${label} fill timing must be measured`);
    }
    assert.equal(releaseGate.densityAnnuli.length, 3);
    assert.deepEqual(releaseGate.densityAnnuli.map(value => value.label), [
      '0-100', '100-200', '200-300',
    ]);
    for (const annulus of releaseGate.densityAnnuli) {
      assert.equal(annulus.before.basis,
        'analytical-all-canonical-legacy-density-baseline',
      `${annulus.label}: Before must be labelled as an analytical legacy baseline`);
      assert.equal(annulus.before.measuredImplementation, false,
        `${annulus.label}: Before must not claim a measured old implementation run`);
      assert.ok(annulus.after.drawableCount <= annulus.before.canonicalCount,
        `${annulus.label}: submitted Tree count cannot exceed canonical input`);
      assert.ok(annulus.after.instanceCount <= annulus.before.instanceCount,
        `${annulus.label}: submitted instances cannot exceed canonical input`);
      assert.ok(annulus.after.triangleCount <= annulus.before.triangleCount,
        `${annulus.label}: submitted triangles cannot exceed canonical input`);
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
      naturalLodAttributeCount: reversalNaturalLodAttributes.length,
      cameraYawTriggeredGeneration,
      nearUploadAdmission,
      releaseProof,
      releaseGate,
    }));
  } finally {
    await harness.shutdown();
  }
});
