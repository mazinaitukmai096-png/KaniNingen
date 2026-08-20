import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  W8_CANONICAL_WORLD_OBJECT_SCHEMA,
  W8_CANONICAL_WORLD_OBJECT_TYPES,
  W8_RESERVED_WORLD_DETAIL_TYPES,
  resolveW8CanonicalWorldObject,
} from '../src/infinite-world/world-object-canonical-contract.js';

const repoRoot = resolve(import.meta.dirname, '..');
const owner = Object.freeze({ x: 2, z: -2 });
const position = Object.freeze({ x: 44.25, y: 1.5, z: -18.75 });

const tree = Object.freeze({
  candidateId: 'detail-v1:vegetation:canonical-tree',
  candidateType: 'vegetation',
  subtype: 'broadleaf-tree',
  variationSeed: 0.5,
  orientationSeed: 0.25,
  worldPosition: position,
  owningChunkCoordinate: owner,
  metadata: Object.freeze({ candidateRadiusMeters: 0.32, boundsType: 'horizontal-circle' }),
});

const building = Object.freeze({
  stableId: 'settlement-building-v1:canonical-house',
  featureType: 'settlement-building',
  buildingType: 'house',
  settlementId: 'settlement-v1:canonical-town',
  worldPosition: position,
  owningChunkCoordinate: owner,
  rotationY: 0.375,
  widthMeters: 6,
  heightMeters: 4,
  depthMeters: 5,
  radiusMeters: 4,
  visual: Object.freeze({ wallColor: 0xaabbcc, roofColor: 0x663322, roofScale: 1 }),
});

const cow = Object.freeze({
  stableId: 'wf1:settlement-landmark:canonical-cow',
  featureType: 'settlement-landmark',
  landmarkType: 'cow',
  parentSettlementId: 'settlement-v1:canonical-rural',
  worldPosition: position,
  owningChunkCoordinate: owner,
  rotationY: 0.75,
  widthMeters: 1.8,
  heightMeters: 1.5,
  depthMeters: 0.9,
});

const rock = Object.freeze({
  candidateId: 'detail-v1:rock:canonical-medium',
  candidateType: 'rock',
  subtype: 'medium-rock',
  sizeClass: 'medium',
  variationSeed: 0.75,
  orientationSeed: 0.5,
  worldPosition: position,
  owningChunkCoordinate: owner,
  metadata: Object.freeze({ candidateRadiusMeters: 0.22, boundsType: 'horizontal-circle' }),
});

const assertBaseContract = (source, expectedType) => {
  const first = resolveW8CanonicalWorldObject(source);
  const second = resolveW8CanonicalWorldObject(source);
  assert.equal(first, second);
  assert.equal(first.schemaVersion, W8_CANONICAL_WORLD_OBJECT_SCHEMA);
  assert.equal(first.objectType, expectedType);
  assert.equal(first.stableId, source.candidateId ?? source.stableId);
  assert.deepEqual(first.owner, owner);
  assert.deepEqual(first.position, position);
  assert.equal(first.worldPosition, first.position);
  assert.equal(first.owningChunkCoordinate, first.owner);
  for (const value of [
    first, first.owner, first.position, first.rotation, first.visualBounds,
    first.collision, first.interaction, first.destruction, first.lodPolicy,
    first.presentation, first.presentation.parts, first.extension,
  ]) assert.equal(Object.isFrozen(value), true);
  assert.equal(typeof first.collision.shape, 'string');
  assert.equal(typeof first.interaction.enabled, 'boolean');
  assert.equal(
    first.destruction.stateKey,
    first.destruction.destructible ? first.stableId : null,
  );
  assert.ok(first.lodPolicy.near);
  assert.ok(first.presentation.partSetKey);
  assert.ok(first.presentation.parts.length > 0);
  return first;
};

test('Rock, Tree, Building, and Cow share one immutable canonical World Object shape', () => {
  const canonicalRock = assertBaseContract(rock, 'rock');
  const canonicalTree = assertBaseContract(tree, 'tree');
  const canonicalBuilding = assertBaseContract(building, 'building');
  const canonicalCow = assertBaseContract(cow, 'cow');

  assert.equal(canonicalRock.collision.radiusMeters, canonicalRock.visualBounds.width / 2);
  assert.equal(canonicalRock.collision.shape, 'circle');
  assert.equal(canonicalRock.collision.blocksPlayer, true);
  assert.equal(canonicalRock.interaction.targetType, 'rock');
  assert.deepEqual(canonicalRock.lodPolicy.presentationTiers, ['full', 'atmospheric']);
  assert.equal(canonicalTree.collision.radiusMeters, 0.32);
  assert.equal(canonicalTree.collision.blocksPlayer, false);
  assert.equal(canonicalTree.interaction.targetType, 'tree');
  assert.deepEqual(
    canonicalTree.lodPolicy.presentationTiers,
    ['full', 'forest', 'atmospheric', 'horizon'],
  );
  assert.equal(canonicalBuilding.collision.radiusMeters, 4);
  assert.equal(canonicalBuilding.collision.blocksPlayer, false);
  assert.equal(canonicalBuilding.collision.cameraShape, 'oriented-box');
  assert.equal(canonicalBuilding.interaction.targetType, 'house');
  assert.deepEqual(canonicalBuilding.visualBounds, { width: 6, height: 4, depth: 5 });
  assert.equal(canonicalCow.interaction.targetType, 'cow');
  assert.equal(canonicalCow.collision.blocksPlayer, false);
  assert.equal(canonicalCow.destruction.destructible, true);
  assert.deepEqual(canonicalCow.lodPolicy.presentationTiers, ['full', 'horizon']);
});

test('formal and ambient Shrub are pure Near-only decoration while other World Details retain identity', () => {
  const shrub = resolveW8CanonicalWorldObject(Object.freeze({
    ...tree,
    candidateId: 'detail-v1:vegetation:canonical-shrub',
    subtype: 'shrub',
    metadata: Object.freeze({ candidateRadiusMeters: 0.2 }),
  }));
  const haystack = resolveW8CanonicalWorldObject(Object.freeze({
    ...cow,
    stableId: 'wf1:settlement-landmark:canonical-haystack',
    landmarkType: 'haystack',
    widthMeters: 2.2,
    heightMeters: 2.4,
    depthMeters: 2.2,
  }));
  const lamp = resolveW8CanonicalWorldObject(Object.freeze({
    stableId: 'wf1:street-detail:canonical-lamp',
    detailType: 'streetLamp',
    parentRoadStableId: 'wf1:road:canonical',
    worldPosition: position,
    owningChunkCoordinate: owner,
    rotationY: 0,
  }));
  const sign = resolveW8CanonicalWorldObject(Object.freeze({
    stableId: 'wf1:street-detail:canonical-sign',
    detailType: 'roadSign',
    parentRoadStableId: 'wf1:road:canonical',
    worldPosition: position,
    owningChunkCoordinate: owner,
    rotationY: 0,
  }));
  const grassSource = Object.freeze({
    stableId: 'wf1:ambient-detail:canonical-grass',
    detailType: 'grass',
    worldPosition: position,
    owningChunkCoordinate: owner,
    rotationY: 0.25,
    variation: 1.1,
  });
  const ambientShrubSource = Object.freeze({
    ...grassSource,
    stableId: 'wf1:ambient-detail:canonical-shrub',
    detailType: 'shrub',
  });
  const grass = assertBaseContract(grassSource, 'grass');
  const ambientShrub = assertBaseContract(ambientShrubSource, 'shrub');

  assert.equal(shrub.objectType, 'shrub');
  assert.equal(shrub.collision.shape, 'none');
  assert.equal(shrub.collision.blocksPlayer, false);
  assert.equal(shrub.interaction.enabled, false);
  assert.equal(shrub.interaction.targetType, null);
  assert.equal(shrub.destruction.destructible, false);
  assert.equal(shrub.lodPolicy.visibilityClass, 'natural');
  assert.equal(shrub.lodPolicy.outer, null);
  assert.equal(shrub.lodPolicy.far, null);
  assert.deepEqual(shrub.lodPolicy.presentationTiers, ['full']);
  assert.equal(grass.stableId, grassSource.stableId);
  assert.deepEqual(grass.owner, owner);
  assert.equal(grass.destruction.destructible, false);
  assert.deepEqual(grass.lodPolicy.presentationTiers, ['full', 'forest', 'atmospheric']);
  assert.equal(ambientShrub.collision.shape, 'none');
  assert.equal(ambientShrub.interaction.enabled, false);
  assert.equal(ambientShrub.destruction.destructible, false);
  assert.equal(ambientShrub.lodPolicy.visibilityClass, 'natural');
  assert.deepEqual(ambientShrub.lodPolicy.presentationTiers, ['full']);
  assert.equal(haystack.objectType, 'haystack');
  assert.equal(haystack.collision.blocksPlayer, false);
  assert.equal(haystack.interaction.targetType, 'haystack');
  assert.equal(lamp.interaction.enabled, false);
  assert.equal(lamp.collision.blocksPlayer, false);
  assert.equal(lamp.destruction.destructible, false);
  assert.equal(lamp.lodPolicy.outer, null);
  assert.equal(sign.interaction.targetType, 'roadSign');
  assert.equal(sign.collision.blocksPlayer, false);
  assert.equal(sign.destruction.stateKey, sign.stableId);

  for (const landmarkType of ['barn', 'factory', 'militaryBase']) {
    const landmark = resolveW8CanonicalWorldObject(Object.freeze({
      ...cow,
      stableId: `wf1:settlement-landmark:canonical-${landmarkType}`,
      landmarkType,
    }));
    assert.equal(landmark.collision.blocksPlayer, false, landmarkType);
  }
});

test('future World Detail categories are reserved without generating new objects', () => {
  assert.deepEqual(W8_RESERVED_WORLD_DETAIL_TYPES, [
    'bench', 'trashBin', 'planter', 'vendingMachine', 'parkedCar', 'fence',
  ]);
  assert.equal(W8_CANONICAL_WORLD_OBJECT_TYPES.includes('rock'), true);
  assert.equal(W8_CANONICAL_WORLD_OBJECT_TYPES.includes('grass'), true);
  assert.equal(W8_CANONICAL_WORLD_OBJECT_TYPES.includes('building'), true);
  assert.equal(W8_RESERVED_WORLD_DETAIL_TYPES.every(type => (
    W8_CANONICAL_WORLD_OBJECT_TYPES.includes(type)
  )), true);
  const reservedBench = resolveW8CanonicalWorldObject(Object.freeze({
    stableId: 'wf1:reserved-detail:bench',
    detailType: 'bench',
    worldPosition: position,
    owningChunkCoordinate: owner,
    rotationY: 0,
  }));
  assert.equal(reservedBench.objectType, 'bench');
  assert.equal(reservedBench.interaction.enabled, false);
  assert.equal(reservedBench.destruction.destructible, false);
  assert.equal(reservedBench.collision.blocksPlayer, false);
  assert.deepEqual(reservedBench.presentation.parts, []);
});

test('Near, Distant, Gameplay, and Camera consume the shared canonical resolver', () => {
  const near = readFileSync(resolve(repoRoot,
    'src/infinite-world/render/chunk-render-adapter.js'), 'utf8');
  const distant = readFileSync(resolve(repoRoot,
    'src/infinite-world/render/w8-distant-presentation.js'), 'utf8');
  const gameplay = readFileSync(resolve(repoRoot,
    'src/infinite-world/gameplay-runtime.js'), 'utf8');
  assert.match(near, /resolveW8CanonicalWorldObject\(/);
  assert.match(distant, /resolveW8CanonicalWorldObject\(/);
  assert.match(gameplay, /resolveW8CanonicalWorldObject\(/);
  assert.match(near, /canonicalObject: canonical/);
  assert.match(near, /canonicalObject: canonical,/);
  assert.match(distant, /canonicalObjects\.push\(item\.object\.record\)/);
  assert.match(gameplay, /canonicalObject: canonical/);
});
