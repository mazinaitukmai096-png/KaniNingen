import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  W8_LOGICAL_TERRAIN_BAND,
  auditW8ContinuousTerrainCoverage,
  createW8ClipmapTopology,
  createW8LogicalTerrainContract,
  resolveW8LogicalTerrainCellOwner,
} from '../src/infinite-world/render/w8-distant-presentation.js';

const center = (chunkX, chunkZ) => Object.freeze({ chunkX, chunkZ });

test('High, Medium, and Low are one canonical logical Terrain contract', () => {
  const contract = createW8LogicalTerrainContract('current');
  assert.deepEqual({
    extentMeters: contract.extentMeters,
    heightSource: contract.heightSource,
    colorSource: contract.colorSource,
    sampleIdentity: contract.sampleIdentity,
    boundaryOwnership: contract.boundaryOwnership,
    bands: contract.bands.map(band => ({
      id: band.id,
      minimum: band.minimumChebyshevMeters,
      maximum: band.maximumChebyshevMeters,
      spacing: band.sampleSpacingMeters,
    })),
  }, {
    extentMeters: 352,
    heightSource: 'canonical-final-ground',
    colorSource: 'canonical-surface-color',
    sampleIdentity: 'world-fixed-xz',
    boundaryOwnership: 'inner-band-owns-boundary-vertex;outer-band-owns-next-cell',
    bands: [
      { id: 'high', minimum: 0, maximum: 24, spacing: 0.5 },
      { id: 'medium', minimum: 24, maximum: 40, spacing: 1 },
      { id: 'low', minimum: 40, maximum: 352, spacing: [4, 8, 16] },
    ],
  });
  assert.equal(resolveW8LogicalTerrainCellOwner({ localX: 0, localZ: 0 }),
    W8_LOGICAL_TERRAIN_BAND.HIGH);
  assert.equal(resolveW8LogicalTerrainCellOwner({ localX: 24, localZ: 0 }),
    W8_LOGICAL_TERRAIN_BAND.MEDIUM);
  assert.equal(resolveW8LogicalTerrainCellOwner({ localX: 40, localZ: 0 }),
    W8_LOGICAL_TERRAIN_BAND.LOW);
  assert.equal(resolveW8LogicalTerrainCellOwner({ localX: 351.5, localZ: 0 }),
    W8_LOGICAL_TERRAIN_BAND.LOW);
  assert.equal(resolveW8LogicalTerrainCellOwner({ localX: 352, localZ: 0 }), null);
});

test('Low topology begins at the Medium boundary and owns every outward cell exactly once', () => {
  const topology = createW8ClipmapTopology('current');
  const cellKeys = new Set();
  let area = 0;
  for (const cell of topology.cells) {
    assert.equal(resolveW8LogicalTerrainCellOwner({
      localX: cell.centerX,
      localZ: cell.centerZ,
    }), W8_LOGICAL_TERRAIN_BAND.LOW);
    assert.equal(cell.indices.length, 6);
    assert.equal(new Set(cell.indices).size, 4);
    const key = `${cell.centerX},${cell.centerZ},${cell.widthMeters},${cell.depthMeters}`;
    assert.equal(cellKeys.has(key), false, `duplicate Low cell ${key}`);
    cellKeys.add(key);
    area += cell.widthMeters * cell.depthMeters;
  }
  assert.equal(area, 704 * 704 - 80 * 80);
  assert.equal(topology.indices.length, topology.cells.length * 6);
});

test('static, shifts, turns, reversal, and restart keep exact Terrain coverage and reuse', () => {
  const scenarios = Object.freeze({
    static: [center(0, 0), center(0, 0)],
    straight: [center(0, 0), center(1, 0)],
    diagonal: [center(0, 0), center(1, 1)],
    turn90: [center(0, 0), center(1, 0), center(1, 1)],
    reversal180: [center(0, 0), center(1, 0), center(0, 0)],
    stopRestart: [center(0, 0), center(1, 0), center(1, 0), center(2, 0)],
  });
  for (const [name, centers] of Object.entries(scenarios)) {
    const audit = auditW8ContinuousTerrainCoverage({ centers });
    assert.equal(audit.holeCount, 0, `${name}: hole`);
    assert.equal(audit.unintendedOverlapCount, 0, `${name}: overlap`);
    assert.equal(audit.invalidColorCount, 0, `${name}: invalid color`);
    assert.equal(audit.zeroColorCount, 0, `${name}: zero color`);
    assert.equal(audit.boundaryHeightMismatchMeters, 0, `${name}: height mismatch`);
    assert.equal(audit.staleGeometryCount, 0, `${name}: stale geometry`);
    assert.equal(audit.fullTerrainRebuildCount, 0, `${name}: full rebuild`);
    for (const transition of audit.transitions) {
      const stopped = transition.from.chunkX === transition.to.chunkX
        && transition.from.chunkZ === transition.to.chunkZ;
      assert.equal(transition.reusedOwnerSamples, stopped ? 25
        : (Math.abs(transition.from.chunkX - transition.to.chunkX) === 1
          && Math.abs(transition.from.chunkZ - transition.to.chunkZ) === 1 ? 16 : 20));
      assert.equal(transition.newOwnerSamples, stopped ? 0
        : 25 - transition.reusedOwnerSamples);
      assert.equal(transition.discardedOwnerSamples, transition.newOwnerSamples);
      assert.equal(transition.reusedLowSamples > 0, true);
    }
  }
});

test('60-second MAX Sprint path keeps rolling Terrain ahead with bounded entering work', t => {
  const centers = [center(0, 0)];
  let chunkX = 0;
  let chunkZ = 0;
  const directions = Object.freeze([
    Object.freeze([1, 0]),
    Object.freeze([1, 1]),
    Object.freeze([0, 1]),
    Object.freeze([-1, 0]),
    Object.freeze([-1, -1]),
    Object.freeze([0, -1]),
  ]);
  for (let transition = 0; transition < 201; transition += 1) {
    const [dx, dz] = directions[Math.floor(transition / 17) % directions.length];
    chunkX += dx;
    chunkZ += dz;
    centers.push(center(chunkX, chunkZ));
  }
  const audit = auditW8ContinuousTerrainCoverage({ centers });
  assert.equal(audit.holeCount, 0);
  assert.equal(audit.unintendedOverlapCount, 0);
  assert.equal(audit.invalidColorCount, 0);
  assert.equal(audit.boundaryHeightMismatchMeters, 0);
  assert.equal(audit.staleGeometryCount, 0);
  assert.equal(audit.fullTerrainRebuildCount, 0);
  assert.ok(audit.transitions.every(transition => (
    transition.reusedLowSamples >= 7_424
      && transition.newLowSamples <= 864
      && transition.reusedOwnerSamples >= 16
      && transition.newOwnerSamples <= 9
  )));
  t.diagnostic(JSON.stringify({
    durationSeconds: 60,
    centerTransitionCount: audit.transitions.length,
    terrainCoverageMiss: audit.holeCount,
    visualHole: audit.holeCount,
    presentationLag: audit.staleGeometryCount,
    fullTerrainRebuildCount: audit.fullTerrainRebuildCount,
    minimumLowReuse: Math.min(...audit.transitions.map(value => value.reusedLowSamples)),
    maximumNewLowSamples: Math.max(...audit.transitions.map(value => value.newLowSamples)),
    minimumOwnerReuse: Math.min(...audit.transitions.map(value => value.reusedOwnerSamples)),
    maximumNewOwners: Math.max(...audit.transitions.map(value => value.newOwnerSamples)),
  }));
});

test('production source has no drawable Safety Ring or non-canonical moisture-grid Water path', async () => {
  const source = await readFile(new URL(
    '../src/infinite-world/render/w8-distant-presentation.js',
    import.meta.url,
  ), 'utf8');
  assert.doesNotMatch(source, /enableTerrainSafetyRing/);
  assert.doesNotMatch(source, /Safety Ring|safetyRing/);
  assert.doesNotMatch(source, /w8-player-following-terrain-safety-ring/);
  assert.doesNotMatch(source, /safetyRingResourcesByPreset/);
  assert.doesNotMatch(source, /\n\s*requestSafetyRingForPlayer\(/);
  assert.doesNotMatch(source, /water-proxy|createDistantWaterProxies|DISTANT_WATER_PROXY/);
  assert.match(source, /midgroundOwnerSampleCache/);
  assert.match(source, /publicationScope: 'entering-owner-strip-and-low-ring'/);
  assert.match(source, /createFarRiverPresentation/);
  assert.match(source, /projection\.waterSurface/);
});
