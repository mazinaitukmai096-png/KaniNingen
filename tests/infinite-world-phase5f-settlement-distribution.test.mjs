import assert from 'node:assert/strict';
import test from 'node:test';

import { SETTLEMENT_TYPES } from '../src/settlement-type.js';
import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { hashWorldSeed } from '../src/infinite-world/legacy-core/g0/seed.js';
import {
  W5_SETTLEMENT_DISTRIBUTION,
  createSettlementDistributor,
} from '../src/infinite-world/settlement-distributor.js';

const FINITE_UNITS_PER_METER = 40;
const FINITE_TOWNS = Object.freeze([
  Object.freeze({ role: 'capital', type: 'CITY', x: 0, z: 0, radius: 4_860 }),
  Object.freeze({ role: 'church_town', type: 'TOWN', x: 7_500, z: 7_500, radius: 3_780 }),
  Object.freeze({ role: 'school_town', type: 'TOWN', x: -8_250, z: 6_750, radius: 3_780 }),
  Object.freeze({ role: 'residential', type: 'RURAL', x: 7_500, z: -7_500, radius: 3_510 }),
  Object.freeze({ role: 'military', type: 'RURAL', x: -7_500, z: -8_250, radius: 3_510 }),
  Object.freeze({ role: 'suburb', type: 'RURAL', x: 0, z: 11_250, radius: 3_240 }),
]);
const MULTI_SEEDS = Object.freeze([
  'KaniNingen Infinite Natural World',
  'W8 parity golden seed',
  'Phase5F alpha',
  'Phase5F beta',
  'Phase5F gamma',
  'Phase5F delta',
  'Phase5F epsilon',
  'Phase5F zeta',
]);

const distance = (left, right) => Math.hypot(left.x - right.x, left.z - right.z);

async function distributorFor(seed) {
  const { worldSeedHash } = await hashWorldSeed(seed);
  return createSettlementDistributor({ worldSeedHash });
}

test('Phase 5F type-pair spacing is finite-measured, symmetric, and keeps Settlement exteriors apart', async () => {
  const contract = W5_SETTLEMENT_DISTRIBUTION.minimumDistanceMetersByTypePair;
  assert.deepEqual(contract, {
    CITY: { CITY: 1536, TOWN: 265.826307, RURAL: 278.738789 },
    TOWN: { CITY: 265.826307, TOWN: 394.196176, RURAL: 375.234229 },
    RURAL: { CITY: 278.738789, TOWN: 375.234229, RURAL: 504.859201 },
  });
  for (const firstType of Object.values(SETTLEMENT_TYPES)) {
    for (const secondType of Object.values(SETTLEMENT_TYPES)) {
      assert.equal(contract[firstType][secondType], contract[secondType][firstType]);
    }
  }

  const finiteDistances = [];
  for (let leftIndex = 0; leftIndex < FINITE_TOWNS.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < FINITE_TOWNS.length; rightIndex += 1) {
      const left = FINITE_TOWNS[leftIndex];
      const right = FINITE_TOWNS[rightIndex];
      finiteDistances.push({
        centerMeters: distance(left, right) / FINITE_UNITS_PER_METER,
        exteriorMeters: (distance(left, right) - left.radius - right.radius)
          / FINITE_UNITS_PER_METER,
      });
    }
  }
  assert.ok(Math.abs(Math.min(...finiteDistances.map(value => value.centerMeters)) - 209.631373) < 1e-6);
  assert.ok(Math.abs(Math.max(...finiteDistances.map(value => value.centerMeters)) - 543.75) < 1e-6);
  assert.ok(Math.abs(Math.min(...finiteDistances.map(value => value.exteriorMeters)) - 34.131373) < 1e-6);

  const distributor = await distributorFor('Phase5F pair spacing');
  const candidates = await distributor.findInMacroRange(-12, 12, -12, 12);
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      const centerDistance = distance(left.center, right.center);
      assert.ok(centerDistance + 1e-6 >= contract[left.settlementType][right.settlementType]);
      assert.ok(centerDistance > left.radiusMeters + right.radiusMeters);
    }
  }
});

test('regional proposals preserve the legacy primary identity while adding at most one natural Settlement per Macro Region', async () => {
  const first = await distributorFor('KaniNingen Infinite Natural World');
  const second = await distributorFor('KaniNingen Infinite Natural World');
  const [firstCandidates, secondCandidates] = await Promise.all([
    first.findInMacroRange(-8, 8, -8, 8),
    second.findInMacroRange(-8, 8, -8, 8),
  ]);
  assert.deepEqual(firstCandidates, secondCandidates);
  const byRegion = Object.groupBy(firstCandidates, candidate => (
    `${candidate.macroRegion.x},${candidate.macroRegion.z}`
  ));
  assert.ok(Object.values(byRegion).every(values => (
    values.length <= W5_SETTLEMENT_DISTRIBUTION.maximumSettlementsPerMacroRegion
  )));
  assert.ok(firstCandidates.some(candidate => candidate.proposalKind === 'PRIMARY'));
  assert.ok(firstCandidates.some(candidate => candidate.proposalKind === 'AUXILIARY'));
  assert.ok(firstCandidates.some(candidate => (
    candidate.settlementId === 'settlement-v1:fe59f37f0137cbdb67a89f76'
      && candidate.proposalKind === 'PRIMARY'
      && candidate.center.x === 531.669985
      && candidate.center.z === 385.27344
  )), 'the existing primary Settlement keeps its Stable ID and transform');
  for (const candidate of firstCandidates) {
    const expectedType = candidate.urbanization
      >= W5_SETTLEMENT_DISTRIBUTION.urbanizationThresholds.city
      ? SETTLEMENT_TYPES.CITY
      : candidate.urbanization >= W5_SETTLEMENT_DISTRIBUTION.urbanizationThresholds.town
        ? SETTLEMENT_TYPES.TOWN
        : SETTLEMENT_TYPES.RURAL;
    assert.equal(candidate.settlementType, expectedType);
    assert.equal(candidate.eligibility.biomeAndSlope, true);
    assert.equal(candidate.eligibility.regionalUrbanization, true);
  }
});

test('home selection uses only natural candidates and yields multiple first-five-minute activity points across seeds', async () => {
  const audits = [];
  const roleCountsBySeed = [];
  for (const seed of MULTI_SEEDS) {
    const generator = await createDistributedSettlementChunkGenerator({ worldSeed: seed });
    const home = generator.reviewSpawn;
    const nearby = (await generator.distributor.findSettlementCentersNear(
      home.x,
      home.z,
      1_500,
    )).sort((left, right) => (
      distance(left.center, home) - distance(right.center, home)
      || left.settlementId.localeCompare(right.settlementId)
    ));
    assert.equal(nearby[0].settlementId, home.settlementId);
    assert.notEqual(nearby[0].canonicalStartRegion, true);
    assert.ok(nearby.length >= 3);
    const secondDistance = distance(nearby[1].center, home);
    const thirdDistance = distance(nearby[2].center, home);
    assert.ok(secondDistance <= W5_SETTLEMENT_DISTRIBUTION.home.nearbyRadiusMeters);
    assert.ok(thirdDistance <= 1_500);
    assert.ok(secondDistance / W5_SETTLEMENT_DISTRIBUTION.home.normalMovementMetersPerSecond < 61);
    assert.ok(thirdDistance / W5_SETTLEMENT_DISTRIBUTION.home.normalMovementMetersPerSecond < 91);
    const counts = Object.fromEntries([350, 500, 750, 1_000, 1_500].map(radius => [
      radius,
      nearby.filter(candidate => distance(candidate.center, home) <= radius).length,
    ]));
    assert.ok(counts[1_500] <= 12, `${seed} exceeds the reviewed Horizon density budget`);
    audits.push(counts);
    roleCountsBySeed.push(Object.fromEntries(Object.entries(Object.groupBy(
      nearby,
      candidate => candidate.townType,
    )).map(([role, values]) => [role, values.length])));
  }
  assert.ok(new Set(audits.map(value => value[1_000])).size > 1);
  assert.ok(new Set(audits.map(value => value[1_500])).size > 1);
  assert.ok(roleCountsBySeed.some(counts => Object.values(counts).some(count => count > 1)));
  assert.ok(roleCountsBySeed.some(counts => !Object.hasOwn(counts, 'capital')));
});

test('home selection keeps an accepted primary start instead of moving to a newly unblocked closer proposal', async () => {
  const distributor = await distributorFor('W8 overlay consumer fixture');
  const home = await distributor.findHomeSettlement(0, 0);
  assert.equal(home.settlementId, 'settlement-v1:9d0de9f557ef5ac076708b20');
  assert.equal(home.proposalKind, 'PRIMARY');
  assert.deepEqual(home.center, { x: -292.674831, z: 497.678696 });
  const nearby = await distributor.findSettlementCentersNear(
    home.center.x,
    home.center.z,
    W5_SETTLEMENT_DISTRIBUTION.home.nearbyRadiusMeters,
  );
  assert.ok(nearby.some(candidate => candidate.settlementId !== home.settlementId));
});

test('connectivity metadata is deterministic, sparse, uniquely owned, and has no duplicate or isolated edge', async () => {
  const first = await createDistributedSettlementChunkGenerator({ worldSeed: 'Phase5F gamma' });
  const second = await createDistributedSettlementChunkGenerator({ worldSeed: 'Phase5F gamma' });
  const [a, b] = await Promise.all([
    first.distributor.buildConnectivityGraphNear(
      first.reviewSpawn.x,
      first.reviewSpawn.z,
      1_500,
    ),
    second.distributor.buildConnectivityGraphNear(
      second.reviewSpawn.x,
      second.reviewSpawn.z,
      1_500,
    ),
  ]);
  assert.deepEqual(a, b);
  assert.ok(a.nodes.length >= 3);
  assert.ok(a.edges.length < a.nodes.length * (a.nodes.length - 1) / 2);
  assert.equal(new Set(a.edges.map(edge => edge.stableId)).size, a.edges.length);
  assert.equal(new Set(a.edges.map(edge => edge.settlementIds.join('|'))).size, a.edges.length);
  const nodesById = new Map(a.nodes.map(node => [node.stableId, node]));
  for (const edge of a.edges) {
    assert.equal(edge.settlementIds.length, 2);
    assert.ok(edge.settlementIds.every(id => nodesById.has(id)));
    const owners = edge.settlementIds.map(id => nodesById.get(id).ownerRegion);
    assert.ok(owners.some(owner => (
      owner.x === edge.ownerRegion.x && owner.z === edge.ownerRegion.z
    )));
  }
  for (const node of a.nodes) {
    assert.ok(node.candidateNeighborIds.length > 0);
    assert.equal(new Set(node.candidateNeighborIds).size, node.candidateNeighborIds.length);
    assert.ok(node.candidateNeighborIds.every(id => nodesById.has(id)));
    assert.equal(node.connectivityTier, node.settlementType === SETTLEMENT_TYPES.CITY
      ? 'REGIONAL_HUB'
      : node.settlementType === SETTLEMENT_TYPES.TOWN ? 'LOCAL_CENTER' : 'LOCAL');
  }
});
