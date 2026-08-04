import assert from 'node:assert/strict';
import test from 'node:test';

import { SETTLEMENT_TYPES } from '../src/settlement-type.js';
import {
  CANONICAL_SETTLEMENT_PLAN_SCHEMA,
  SETTLEMENT_NODE_QUANTIZATION,
  createCanonicalSettlementPlan,
  validateCanonicalSettlementPlan,
} from '../src/infinite-world/canonical-settlement-plan.js';
import {
  createDistributedSettlementChunkGenerator,
  projectMigratedSettlementTemplate,
} from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { createFormalNaturalChunkGenerator } from '../src/infinite-world/formal-natural-chunk-generator.js';
import { canonicalizeJson } from '../src/infinite-world/legacy-core/g0/canonical-json.js';
import { hashWorldSeed } from '../src/infinite-world/legacy-core/g0/seed.js';
import { sha256Hex } from '../src/infinite-world/legacy-core/g0/sha256.js';
import {
  LEGACY_MIGRATED_SETTLEMENT_ADAPTER,
  LEGACY_MIGRATED_SETTLEMENT_ADAPTER_ID,
  PRODUCTION_SETTLEMENT_GENERATOR_ADAPTER_REGISTRY,
  createLegacyMigratedSettlementTemplate,
} from '../src/infinite-world/legacy-migrated-settlement-adapter.js';
import {
  SETTLEMENT_GENERATOR_ADAPTER_SCHEMA,
  createSettlementGeneratorAdapterRegistry,
} from '../src/infinite-world/settlement-generator-adapter-registry.js';
import {
  SETTLEMENT_PROFILE_SCHEMA,
  createSettlementProfileRegistry,
} from '../src/infinite-world/settlement-profile-registry.js';
import {
  SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
  createSemanticIdKeyedRandom,
  createSettlementSemanticStableId,
} from '../src/infinite-world/settlement-semantic-identity.js';
import {
  SETTLEMENT_GENERATION_STAGES,
  createSettlementStageGeneratorRegistry,
} from '../src/infinite-world/settlement-stage-generator-registry.js';
import { createMigratedSettlementTemplate } from '../src/infinite-world/single-rural-settlement.js';
import { createW8SettlementParityOverlay } from '../src/infinite-world/w8-settlement-parity-overlay.js';
import {
  W8_SAVE_SCHEMA,
  W8_SAVE_SCHEMA_VERSION,
} from '../src/infinite-world/gameplay-contract.js';
import {
  InfiniteWorldState,
  decodeInfiniteWorldSave,
  encodeInfiniteWorldSave,
} from '../src/infinite-world/world-state-store.js';

const worldSeed = 'W5 distributed golden';

function canonicalPlan(overrides = {}) {
  return {
    schemaVersion: CANONICAL_SETTLEMENT_PLAN_SCHEMA,
    settlementId: 'settlement-semantic-v1:settlement:test',
    biomeContext: { biomeId: 'temperate', weights: { temperate: 1 } },
    settlementProfileId: 'legacy-rural',
    legacySettlementClass: SETTLEMENT_TYPES.RURAL,
    center: { x: 12.000001, z: -4.25 },
    roadGraph: {
      nodes: [
        { nodeId: 'node-a', x: 12.000001, z: -4.25 },
        { nodeId: 'node-b', x: 12.5, z: -4.25 },
      ],
      edges: [{ edgeId: 'edge-a', fromNodeId: 'node-a', toNodeId: 'node-b' }],
    },
    blocks: [{ blockId: 'block-a', edgeIds: ['edge-a'] }],
    lots: [{ lotId: 'lot-a', blockId: 'block-a' }],
    buildings: [{ buildingId: 'building-a', lotId: 'lot-a' }],
    ...overrides,
  };
}

async function representativeCandidates() {
  const generator = await createDistributedSettlementChunkGenerator({ worldSeed });
  const candidates = await generator.distributor.findInMacroRange(-10, 10, -10, 10);
  const result = Object.values(SETTLEMENT_TYPES).map(settlementType => (
    candidates.find(candidate => candidate.settlementType === settlementType)
  ));
  assert.ok(result.every(Boolean), 'test seed must provide CITY, TOWN, and RURAL candidates');
  return { generator, candidates: result };
}

test('CanonicalSettlementPlan validates an immutable contract with independent biome and profile fields', () => {
  const input = canonicalPlan();
  const plan = createCanonicalSettlementPlan(input);
  assert.equal(plan.biomeContext.biomeId, 'temperate');
  assert.equal(plan.settlementProfileId, 'legacy-rural');
  assert.equal(plan.legacySettlementClass, SETTLEMENT_TYPES.RURAL);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.biomeContext.weights));
  assert.ok(Object.isFrozen(plan.roadGraph.nodes));
  input.biomeContext.biomeId = 'desert';
  assert.equal(plan.biomeContext.biomeId, 'temperate');
  assert.equal(plan.settlementProfileId, 'legacy-rural');
  assert.deepEqual(SETTLEMENT_NODE_QUANTIZATION, {
    gridWidthMeters: 0.000001,
    epsilonMeters: 0.000000001,
  });
});

test('CanonicalSettlementPlan validation rejects invalid schemas, classes, IDs, graph references, and node precision', () => {
  assert.throws(() => validateCanonicalSettlementPlan(canonicalPlan({ schemaVersion: 'wrong' })), /schemaVersion/);
  assert.throws(() => validateCanonicalSettlementPlan(canonicalPlan({ legacySettlementClass: 'VILLAGE' })), /legacySettlementClass/);
  assert.throws(() => validateCanonicalSettlementPlan(canonicalPlan({ settlementProfileId: '' })), /settlementProfileId/);
  assert.throws(() => validateCanonicalSettlementPlan(canonicalPlan({
    roadGraph: { nodes: [], edges: [{ edgeId: 'edge-a', fromNodeId: 'missing', toNodeId: 'missing' }] },
  })), /unknown node/);
  assert.throws(() => validateCanonicalSettlementPlan(canonicalPlan({
    center: { x: 0.0000005, z: 0 },
  })), /quantized/);
});

test('Settlement profile and every stage generator registry register, resolve, freeze, and reject duplicates', () => {
  const profiles = createSettlementProfileRegistry();
  const profile = profiles.register({
    schemaVersion: SETTLEMENT_PROFILE_SCHEMA,
    settlementProfileId: 'legacy-rural',
    legacySettlementClass: SETTLEMENT_TYPES.RURAL,
    parameters: { radiusMeters: 87.75 },
  });
  assert.equal(profiles.get('legacy-rural'), profile);
  assert.throws(() => profiles.register(profile), /duplicate/);
  profiles.freeze();
  assert.throws(() => profiles.register({ ...profile, settlementProfileId: 'another-profile' }), /frozen/);

  const stages = createSettlementStageGeneratorRegistry();
  for (const stage of SETTLEMENT_GENERATION_STAGES) {
    const generate = value => value;
    const registered = stages.register({ stage, generatorId: 'contract-only', generate });
    assert.equal(stages.get(stage, 'contract-only'), registered);
    assert.throws(() => stages.register({ stage, generatorId: 'contract-only', generate }), /duplicate/);
  }
  assert.deepEqual(SETTLEMENT_GENERATION_STAGES, ['roadGraph', 'block', 'lot', 'building']);
  stages.freeze();
  assert.throws(() => stages.register({ stage: 'roadGraph', generatorId: 'future', generate() {} }), /frozen/);
});

test('legacy-migrated-v1 is registered as an exact adapter over the sole legacy authority', () => {
  assert.equal(LEGACY_MIGRATED_SETTLEMENT_ADAPTER.schemaVersion, SETTLEMENT_GENERATOR_ADAPTER_SCHEMA);
  assert.equal(LEGACY_MIGRATED_SETTLEMENT_ADAPTER_ID, 'legacy-migrated-v1');
  assert.equal(LEGACY_MIGRATED_SETTLEMENT_ADAPTER.generate, createMigratedSettlementTemplate);
  assert.deepEqual(
    PRODUCTION_SETTLEMENT_GENERATOR_ADAPTER_REGISTRY.get(LEGACY_MIGRATED_SETTLEMENT_ADAPTER_ID),
    LEGACY_MIGRATED_SETTLEMENT_ADAPTER,
  );
  assert.equal(PRODUCTION_SETTLEMENT_GENERATOR_ADAPTER_REGISTRY.frozen, true);
  const registry = createSettlementGeneratorAdapterRegistry();
  registry.register(LEGACY_MIGRATED_SETTLEMENT_ADAPTER);
  assert.throws(() => registry.register(LEGACY_MIGRATED_SETTLEMENT_ADAPTER), /duplicate/);
});

test('legacy adapter preserves canonical JSON, hashes, Stable IDs, geometry, and projections for CITY/TOWN/RURAL', async () => {
  const { generator, candidates } = await representativeCandidates();
  const formal = await createFormalNaturalChunkGenerator({ worldSeed });
  for (const candidate of candidates) {
    const direct = await createMigratedSettlementTemplate({ candidate });
    const adapted = await createLegacyMigratedSettlementTemplate({ candidate });
    const directJson = canonicalizeJson(direct);
    const adaptedJson = canonicalizeJson(adapted);
    assert.equal(adaptedJson, directJson, candidate.settlementType);
    assert.equal(await sha256Hex(adaptedJson), await sha256Hex(directJson), candidate.settlementType);
    assert.deepEqual(
      adapted.roads.map(road => road.stableId),
      direct.roads.map(road => road.stableId),
      candidate.settlementType,
    );
    assert.deepEqual(
      adapted.buildings.map(building => ({
        stableId: building.stableId,
        x: building.x,
        z: building.z,
        lot: building.lot,
      })),
      direct.buildings.map(building => ({
        stableId: building.stableId,
        x: building.x,
        z: building.z,
        lot: building.lot,
      })),
      candidate.settlementType,
    );
    const ownerX = Math.floor(candidate.center.x / 16);
    const ownerZ = Math.floor(candidate.center.z / 16);
    const naturalChunk = await formal.generateChunk(ownerX, ownerZ);
    assert.deepEqual(
      projectMigratedSettlementTemplate(adapted, naturalChunk),
      projectMigratedSettlementTemplate(direct, naturalChunk),
      candidate.settlementType,
    );
    assert.deepEqual(await generator.resolveSettlementTemplate({ candidate }), direct);
  }
});

test('legacy adapter is seed deterministic under repetition, reverse order, and parallel generation', async () => {
  const { candidates } = await representativeCandidates();
  const first = [];
  for (const candidate of candidates) first.push(await createLegacyMigratedSettlementTemplate({ candidate }));
  const repeated = [];
  for (const candidate of candidates) repeated.push(await createLegacyMigratedSettlementTemplate({ candidate }));
  const reverse = [];
  for (const candidate of [...candidates].reverse()) {
    reverse.push(await createLegacyMigratedSettlementTemplate({ candidate }));
  }
  reverse.reverse();
  const parallel = await Promise.all(candidates.map(candidate => (
    createLegacyMigratedSettlementTemplate({ candidate })
  )));
  assert.deepEqual(repeated, first);
  assert.deepEqual(reverse, first);
  assert.deepEqual(parallel, first);
});

test('W8 production default obtains the legacy source template through the adapter without output drift', async () => {
  const { generator, candidates } = await representativeCandidates();
  for (const candidate of candidates) {
    const direct = await createMigratedSettlementTemplate({ candidate });
    const [defaultOverlay, explicitLegacyOverlay] = await Promise.all([
      createW8SettlementParityOverlay({ candidate, worldSeedHash: generator.worldSeedHash }),
      createW8SettlementParityOverlay({
        candidate,
        worldSeedHash: generator.worldSeedHash,
        sourceTemplate: direct,
      }),
    ]);
    assert.equal(canonicalizeJson(defaultOverlay), canonicalizeJson(explicitLegacyOverlay));
    assert.deepEqual(
      defaultOverlay.buildings.map(building => building.stableId),
      explicitLegacyOverlay.buildings.map(building => building.stableId),
    );
  }
});

test('semantic Stable ID keyed RNG is deterministic and remains a separate future contract', async () => {
  const { worldSeedHash } = await hashWorldSeed(worldSeed);
  const input = {
    schemaVersion: SETTLEMENT_SEMANTIC_STABLE_ID_SCHEMA,
    worldSeedHash,
    settlementId: 'settlement-v1:test',
    semanticKind: 'road-node',
    semanticLocalKey: 'junction:central',
  };
  const firstId = await createSettlementSemanticStableId(input);
  const secondId = await createSettlementSemanticStableId(input);
  assert.deepEqual(secondId, firstId);
  const firstRandom = await createSemanticIdKeyedRandom({
    worldSeedHash,
    semanticStableId: firstId.stableId,
  });
  const secondRandom = await createSemanticIdKeyedRandom({
    worldSeedHash,
    semanticStableId: secondId.stableId,
  });
  assert.equal(await firstRandom.float01('building:7'), await secondRandom.float01('building:7'));
  assert.notEqual(await firstRandom.float01('building:7'), await firstRandom.float01('building:8'));
});

test('Save v5 round-trip remains unchanged and contains no architecture recipe fields', async () => {
  const { worldSeedHash } = await hashWorldSeed(worldSeed);
  const state = new InfiniteWorldState({ worldSeed, worldSeedHash, playerSpawn: { x: 0, z: 0 } });
  const before = state.createSaveSnapshot();
  const serialized = await encodeInfiniteWorldSave(before);
  const envelope = JSON.parse(serialized);
  assert.equal(envelope.payload.schemaVersion, W8_SAVE_SCHEMA);
  assert.equal(envelope.payload.schemaVersionNumber, W8_SAVE_SCHEMA_VERSION);
  assert.equal(Object.hasOwn(envelope.payload, 'generationRecipeVersion'), false);
  assert.equal(Object.hasOwn(envelope.payload, 'settlementProfileId'), false);
  assert.equal(Object.hasOwn(envelope.payload, 'biomeContext'), false);
  const restored = new InfiniteWorldState({
    worldSeed,
    worldSeedHash,
    playerSpawn: { x: 10, z: 10 },
  });
  restored.restoreSaveSnapshot(await decodeInfiniteWorldSave(serialized, { worldSeedHash }));
  assert.deepEqual(restored.createSaveSnapshot(), before);
});
