import test from 'node:test';
import assert from 'node:assert/strict';

import { SETTLEMENT_BUILDING_COMPOSITIONS } from '../src/settlement-building-visuals.js';
import {
  W8_SETTLEMENT_PARITY_DENSITY,
  createW8SettlementParityOverlay,
} from '../src/infinite-world/w8-settlement-parity-overlay.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import { logicalWorldToOwnedChunk } from '../src/infinite-world/chunk-coordinates.js';

const worldSeedHash = `sha256:${'6'.repeat(64)}`;
const fixtures = Object.freeze([
  ['capital', 'CITY'],
  ['church_town', 'TOWN'],
  ['school_town', 'TOWN'],
  ['residential', 'RURAL'],
  ['military', 'RURAL'],
  ['suburb', 'RURAL'],
]);

function candidate(townType, settlementType, index = 0) {
  return {
    settlementId: `settlement-v1:w8-parity-${townType}`,
    townType,
    settlementType,
    center: { x: index * 320, z: -index * 240 },
    macroRegion: { x: index, z: -index },
    urbanization: 0.75,
    terrainSuitability: 0.8,
  };
}

test('CITY, TOWN, and RURAL overlays reach finite opportunity density and composition deterministically', async () => {
  for (let index = 0; index < fixtures.length; index += 1) {
    const [townType, settlementType] = fixtures[index];
    const input = candidate(townType, settlementType, index);
    const [first, second] = await Promise.all([
      createW8SettlementParityOverlay({ candidate: input, worldSeedHash }),
      createW8SettlementParityOverlay({ candidate: input, worldSeedHash }),
    ]);
    assert.equal(first.shortageCount, 0, `${townType} must reach its finite density target`);
    assert.equal(first.sourceBuildingCount + first.overlayBuildingCount, first.targetBuildingCount);
    assert.deepEqual(first, second);
    assert.deepEqual(first.buildings.map(building => building.stableId),
      first.buildings.map(building => building.stableId).toSorted());
    assert.equal(first.buildings.every(building => building.parityOverlay === true), true);
    assert.equal(first.buildings.every(building => (
      building.owningChunkCoordinate.x === logicalWorldToOwnedChunk(building.x, building.z).chunkX
      && building.owningChunkCoordinate.z === logicalWorldToOwnedChunk(building.x, building.z).chunkZ
    )), true);

    const ratio = W8_SETTLEMENT_PARITY_DENSITY.buildingOpportunityRatioByTownType[townType];
    assert.equal(first.targetBuildingCount, Math.round(first.requestedOpportunityCount * ratio));
    const overlayCounts = Object.fromEntries(Object.keys(SETTLEMENT_BUILDING_COMPOSITIONS[settlementType])
      .map(type => [type, first.buildings.filter(building => building.buildingType === type).length]));
    assert.equal(Object.values(overlayCounts).reduce((sum, count) => sum + count, 0),
      first.overlayBuildingCount);
  }
});

test('W8 publishes one combined canonical feature array to near, far, and Gameplay consumers', async () => {
  const generator = await createW8ParityChunkGenerator({ worldSeed: 'W8 overlay consumer fixture' });
  const nearest = await generator.distributor.findNearestSettlement(0, 0);
  const owner = logicalWorldToOwnedChunk(nearest.center.x, nearest.center.z);
  const chunk = await generator.generateChunk(owner.chunkX, owner.chunkZ);
  assert.equal(chunk.sourceChunkData.settlementFeatures.some(feature => feature.parityOverlay), false);
  assert.equal(chunk.settlementOverlayFeatures.every(feature => feature.parityOverlay), true);
  assert.equal(chunk.presentationLayers.formal.roadsAndBuildings, chunk.settlementFeatures);
  assert.equal(chunk.settlementOverlayFeatures.every(feature =>
    chunk.settlementFeatures.includes(feature)), true);
  assert.equal(chunk.settlementReferences.every(reference =>
    reference.parityBuildingShortageCount === 0), true);
});
