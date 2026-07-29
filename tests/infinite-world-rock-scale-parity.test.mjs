import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  resolveW8CanonicalCandidateSet,
} from '../src/infinite-world/render/w8-distant-presentation.js';
import {
  W8_FINITE_ROCK_PRESENTATION_METERS,
  W8_ROCK_CANONICAL_OBJECT_SCHEMA,
  W8_ROCK_CANONICAL_LOD_POLICY,
  resolveW8RockCandidateVisual,
  resolveW8RockCanonicalObject,
  resolveW8RockVisibilityMeters,
} from '../src/infinite-world/rock-canonical-object.js';
import { createW6ChunkGameplay } from '../src/infinite-world/gameplay-runtime.js';
import { W8_PARITY_FEATURE_PARTS } from '../src/infinite-world/render/w8-parity-visual-assets.js';

const repoRoot = resolve(import.meta.dirname, '..');
const closeTo = (actual, expected, message = '') => {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} !== ${expected}`);
};

const rockCandidate = ({
  candidateId = 'detail-v1:rock:scale-parity',
  subtype = 'small-stone',
  sizeClass = 'small',
  variationSeed = 0,
  orientationSeed = 0.25,
  radius = 0.1,
} = {}) => Object.freeze({
  candidateId,
  subtype,
  sizeClass,
  variationSeed,
  orientationSeed,
  worldPosition: Object.freeze({ x: 44.25, y: 1.5, z: -18.75 }),
  owningChunkCoordinate: Object.freeze({ x: 2, z: -2 }),
  metadata: Object.freeze({ candidateRadiusMeters: radius }),
});

test('W8 Rock presentation recovers finite pebble, medium, and large exterior dimensions', () => {
  const smallMinimum = resolveW8RockCandidateVisual(rockCandidate({ variationSeed: 0 }));
  const smallMaximum = resolveW8RockCandidateVisual(rockCandidate({ variationSeed: 1 }));
  const mediumMinimum = resolveW8RockCandidateVisual(rockCandidate({
    subtype: 'medium-rock', sizeClass: 'medium', radius: 0.22, variationSeed: 0,
  }));
  const mediumMaximum = resolveW8RockCandidateVisual(rockCandidate({
    subtype: 'medium-rock', sizeClass: 'medium', radius: 0.22, variationSeed: 0.499999999,
  }));
  const largeMinimum = resolveW8RockCandidateVisual(rockCandidate({
    subtype: 'medium-rock', sizeClass: 'medium', radius: 0.22, variationSeed: 0.5,
  }));
  const largeMaximum = resolveW8RockCandidateVisual(rockCandidate({
    subtype: 'medium-rock', sizeClass: 'medium', radius: 0.22, variationSeed: 1,
  }));

  assert.equal(smallMinimum.sizeClass, 'small');
  assert.equal(mediumMinimum.sizeClass, 'medium');
  assert.equal(largeMinimum.sizeClass, 'large');
  closeTo(smallMinimum.outerWidthMeters, 1.05, 'finite pebble minimum width');
  closeTo(smallMaximum.outerWidthMeters, 2.45, 'finite pebble maximum width');
  closeTo(mediumMinimum.outerWidthMeters, 200 / 56, 'finite rock medium minimum width');
  closeTo(mediumMaximum.outerWidthMeters, 325 / 56, 'finite rock medium maximum width');
  closeTo(largeMinimum.outerWidthMeters, 325 / 56, 'finite rock large minimum width');
  closeTo(largeMaximum.outerWidthMeters, 450 / 56, 'finite rock large maximum width');
  closeTo(largeMaximum.outerHeightMeters, 450 / 56, 'finite rock large height');
  closeTo(largeMaximum.rotationY, Math.PI / 2, 'orientation remains candidate-derived');
  assert.equal(W8_FINITE_ROCK_PRESENTATION_METERS.sourceCommit,
    'f8bc9f80c2af417bb585bff26c99522c4229ab8e');
});

test('Rock visual projection is read-only and retains canonical candidate identity, owner, placement, and count', () => {
  const small = rockCandidate({ candidateId: 'detail-v1:rock:small', variationSeed: 0.25 });
  const medium = rockCandidate({
    candidateId: 'detail-v1:rock:medium', subtype: 'medium-rock', sizeClass: 'medium',
    variationSeed: 0.75, radius: 0.22,
  });
  const original = structuredClone([small, medium]);
  const chunk = {
    generatorVersion: { major: 800, minor: 0, patch: 0 },
    presentationLayers: { natural: { vegetation: [], rocks: [small, medium] } },
    rockCandidates: [small, medium],
  };

  const source = resolveW8CanonicalCandidateSet(chunk);
  const visuals = source.rocks.map(resolveW8RockCandidateVisual);
  assert.deepEqual([small, medium], original);
  assert.equal(source.rocks.length, 2);
  assert.equal(source.rocks[0], small);
  assert.equal(source.rocks[1], medium);
  assert.deepEqual(source.rocks.map(candidate => candidate.candidateId), [
    'detail-v1:rock:small', 'detail-v1:rock:medium',
  ]);
  assert.deepEqual(source.rocks.map(candidate => candidate.owningChunkCoordinate), [
    { x: 2, z: -2 }, { x: 2, z: -2 },
  ]);
  assert.deepEqual(source.rocks.map(candidate => candidate.worldPosition), [
    { x: 44.25, y: 1.5, z: -18.75 }, { x: 44.25, y: 1.5, z: -18.75 },
  ]);
  assert.equal(visuals[0].sizeClass, 'small');
  assert.equal(visuals[1].sizeClass, 'large');
});

test('Rock canonical adapter derives visual, collision, LOD, and interaction from one read-only record', () => {
  const candidate = rockCandidate({
    candidateId: 'detail-v1:rock:canonical-large',
    subtype: 'medium-rock',
    sizeClass: 'medium',
    radius: 0.22,
    variationSeed: 1,
  });
  const original = structuredClone(candidate);
  const first = resolveW8RockCanonicalObject(candidate);
  const second = resolveW8RockCanonicalObject(candidate);

  assert.equal(first, second, 'one candidate object resolves to one canonical record reference');
  assert.equal(first.schemaVersion, W8_ROCK_CANONICAL_OBJECT_SCHEMA);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.visual), true);
  assert.equal(Object.isFrozen(first.collision), true);
  assert.equal(Object.isFrozen(first.interaction), true);
  assert.equal(Object.isFrozen(first.lodPolicy), true);
  assert.equal(first.stableId, candidate.candidateId);
  assert.deepEqual(first.owningChunkCoordinate, candidate.owningChunkCoordinate);
  assert.deepEqual(first.worldPosition, candidate.worldPosition);
  assert.notEqual(first.owningChunkCoordinate, candidate.owningChunkCoordinate);
  assert.notEqual(first.worldPosition, candidate.worldPosition);
  assert.equal(first.sizeClass, 'large');
  closeTo(first.visual.dimensionsMeters.width, 450 / 56, 'canonical exterior width');
  closeTo(first.visual.matrixDimensionsMeters.width, 450 / 112, 'canonical matrix scale');
  closeTo(first.collision.radiusMeters, first.visual.dimensionsMeters.width / 2,
    'collision derives from exterior width');
  closeTo(first.interaction.radiusMeters, first.collision.radiusMeters,
    'interaction derives from collision');
  assert.equal(first.interaction.targetType, 'rock');
  assert.equal(first.destruction.presentation, 'none',
    'destroyed Rock is removed instead of retaining a full-scale blocking visual');
  assert.equal(first.generationBounds.radiusMeters, 0.22,
    'generator placement radius remains an audited source value');
  assert.equal(first.lodPolicy, W8_ROCK_CANONICAL_LOD_POLICY);
  assert.equal(first.presentation.partSetKey, 'rock');
  assert.deepEqual(first.presentation.tiers, ['full']);
  assert.deepEqual(first.presentation.parts, W8_PARITY_FEATURE_PARTS.rock);
  assert.deepEqual(candidate, original, 'adapter does not mutate ChunkData candidate');
});

test('Rock canonical LOD follows Render Distance instead of visual quality', () => {
  const record = resolveW8RockCanonicalObject(rockCandidate());
  assert.equal(record.lodPolicy.visibilityClass, 'natural');
  assert.equal(resolveW8RockVisibilityMeters(record, 'short'), 84);
  assert.equal(resolveW8RockVisibilityMeters(record, 'standard'), 112);
  assert.equal(resolveW8RockVisibilityMeters(record, 'current'), 140);
  assert.equal(record.lodPolicy.proxy, false);
  assert.deepEqual(record.lodPolicy.presentationTiers, ['full']);
});

test('W8 Gameplay Rock target consumes canonical collision and interaction instead of generator bounds', async () => {
  const candidate = rockCandidate({
    candidateId: 'detail-v1:rock:gameplay-canonical',
    subtype: 'medium-rock',
    sizeClass: 'medium',
    radius: 0.22,
    variationSeed: 0.75,
  });
  const before = structuredClone(candidate);
  const canonical = resolveW8RockCanonicalObject(candidate);
  const model = await createW6ChunkGameplay({
    chunkData: {
      chunkX: 2,
      chunkZ: -2,
      generatorVersion: { major: 800, minor: 0, patch: 0 },
      vegetationCandidates: [],
      rockCandidates: [candidate],
      presentationLayers: { natural: { vegetation: [], rocks: [candidate] } },
      settlementFeatures: [],
      settlementReferences: [],
      settlementLandmarks: [],
      ambientDetails: [],
      streetDetails: [],
      waterSurfaces: [],
    },
    worldSeedHash: 'rock-canonical-gameplay-fixture',
    generatorMajor: 800,
  });
  const target = model.staticTargets.find(value => value.stableId === candidate.candidateId);
  assert.ok(target);
  assert.equal(target.type, canonical.interaction.targetType);
  assert.equal(target.maxHp, 600);
  assert.equal(target.scoreValue, 100);
  closeTo(target.radius / 40, canonical.collision.radiusMeters,
    'Gameplay collision consumes canonical metres');
  assert.equal(target.canonicalObjectSchema, W8_ROCK_CANONICAL_OBJECT_SCHEMA);
  assert.equal(target.collisionShape, canonical.collision.shape);
  assert.equal(target.visualSizeClass, canonical.sizeClass);
  assert.deepEqual(candidate, before);
});

test('Rock descriptor and Near/Distant/Gameplay paths use the canonical adapter', () => {
  assert.deepEqual(W8_PARITY_FEATURE_PARTS.rock, [{
    geometry: 'dodeca', material: 'rock', position: [0, 0.5, 0], scale: [1, 1, 1],
    rotation: [0, 0, 0], materialRole: null,
  }]);
  const nearSource = readFileSync(resolve(repoRoot,
    'src/infinite-world/render/chunk-render-adapter.js'), 'utf8');
  const farSource = readFileSync(resolve(repoRoot,
    'src/infinite-world/render/w8-distant-presentation.js'), 'utf8');
  const gameplaySource = readFileSync(resolve(repoRoot,
    'src/infinite-world/gameplay-runtime.js'), 'utf8');
  assert.match(nearSource, /resolveW8RockCanonicalObject\(candidate\)/);
  assert.match(farSource, /resolveW8RockCanonicalObject\(candidate\)/);
  assert.match(gameplaySource, /resolveW8RockCanonicalObject\(candidate\)/);
  assert.doesNotMatch(nearSource, /radiusMeters \* 2 \* variation/);

  // These are the finite relative scale baselines for a maximum large rock.
  const large = resolveW8RockCandidateVisual(rockCandidate({
    subtype: 'medium-rock', sizeClass: 'medium', radius: 0.22, variationSeed: 1,
  }));
  closeTo(large.outerHeightMeters / 3.625, (450 / 56) / 3.625, 'Rock : Tree');
  closeTo(large.outerHeightMeters / 1.75, (450 / 56) / 1.75, 'Rock : Human');
  closeTo(large.outerHeightMeters / 4, (450 / 56) / 4, 'Rock : finite house');
});
