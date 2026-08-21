import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceSettlementRoadRibbonMeshWork,
  buildSettlementRoadRibbonMeshData,
  createSettlementRoadRibbonMeshWork,
  createRoadRibbonHeightSampler,
} from '../src/infinite-world/render/settlement-road-ribbon-geometry.js';
import { SETTLEMENT_TYPES } from '../src/settlement-type.js';
import { createDistributedSettlementChunkGenerator } from '../src/infinite-world/distributed-settlement-chunk-generator.js';
import { ROAD_GRAPH_V3_GENERATOR_ID } from '../src/infinite-world/road-graph-v3.js';
import { SETTLEMENT_LOT_V2_GENERATOR_ID } from '../src/infinite-world/settlement-lot-v2.js';
import { sampleW8SurfaceHeightMeters } from '../src/infinite-world/w8-surface-policy.js';
import { LOGICAL_CHUNK_SIZE_METERS } from '../src/infinite-world/chunk-coordinates.js';

const road = ({ id, start, end, width = 4, route = id, order = 0 }) => ({
  stableId: id,
  featureType: 'settlement-road',
  routeId: route,
  routeOrder: order,
  roadClass: 'local',
  widthMeters: width,
  start,
  end,
});

const build = roads => buildSettlementRoadRibbonMeshData({
  roads,
  heightAt: (x, z) => Math.round((x * 0.01 + z * 0.005) * 1e6) / 1e6,
});

function assertValidMesh(mesh) {
  assert.equal(mesh.positions.length % 3, 0);
  assert.equal(mesh.normals.length, mesh.positions.length);
  assert.equal(mesh.indices.length % 3, 0);
  assert.equal(mesh.stats.degenerateTriangleCount, 0);
  assert.equal(mesh.stats.duplicateFaceCount, 0);
  assert.equal([...mesh.positions].every(Number.isFinite), true);
  assert.equal([...mesh.normals].every(Number.isFinite), true);
  assert.equal([...mesh.indices].every(Number.isSafeInteger), true);
  assert.equal([...mesh.normals].every((value, index) => value === (index % 3 === 1 ? 1 : 0)), true);
  for (let index = 0; index < mesh.indices.length; index += 3) {
    assert.equal(new Set(mesh.indices.slice(index, index + 3)).size, 3);
  }
}

test('ordered route ribbons remove degree-2 seams and fill T, Y, cross, and general junctions', () => {
  const networks = [
    [
      road({ id: 'bend-a', route: 'bend', order: 0, start: { x: -12, z: 0 }, end: { x: 0, z: 0 } }),
      road({ id: 'bend-b', route: 'bend', order: 1, start: { x: 0, z: 0 }, end: { x: 8, z: 7 } }),
    ],
    [
      road({ id: 't-a', start: { x: -10, z: 0 }, end: { x: 0, z: 0 } }),
      road({ id: 't-b', start: { x: 0, z: 0 }, end: { x: 10, z: 0 } }),
      road({ id: 't-c', start: { x: 0, z: 0 }, end: { x: 0, z: 10 } }),
    ],
    [0, 120, 240].map((degrees, index) => {
      const angle = degrees * Math.PI / 180;
      return road({
        id: `y-${index}`,
        start: { x: 0, z: 0 },
        end: { x: Math.cos(angle) * 10, z: Math.sin(angle) * 10 },
      });
    }),
    [0, 90, 180, 270].map((degrees, index) => {
      const angle = degrees * Math.PI / 180;
      return road({
        id: `cross-${index}`,
        start: { x: 0, z: 0 },
        end: { x: Math.cos(angle) * 10, z: Math.sin(angle) * 10 },
      });
    }),
    [0, 55, 135, 215, 305].map((degrees, index) => {
      const angle = degrees * Math.PI / 180;
      return road({
        id: `general-${index}`,
        width: 2.5 + index * 0.5,
        start: { x: 0, z: 0 },
        end: { x: Math.cos(angle) * 12, z: Math.sin(angle) * 12 },
      });
    }),
  ];
  const meshes = networks.map(build);
  for (const mesh of meshes) assertValidMesh(mesh);
  assert.equal(meshes[0].stats.junctionCount, 0);
  assert.equal(meshes[0].stats.polylineCount, 1);
  assert.deepEqual(meshes.slice(1).map(mesh => mesh.stats.junctionCount), [1, 1, 1, 1]);
  assert.equal(meshes.slice(1).every(mesh => mesh.stats.triangleCount > mesh.stats.roadRecordCount * 2), true);
});

test('miter limit deterministically falls back to a non-degenerate bevel', () => {
  const roads = [
    road({ id: 'sharp-a', route: 'sharp', order: 0, start: { x: -10, z: 0 }, end: { x: 0, z: 0 } }),
    road({ id: 'sharp-b', route: 'sharp', order: 1, start: { x: 0, z: 0 }, end: { x: -9, z: 1 } }),
  ];
  const mesh = buildSettlementRoadRibbonMeshData({ roads, miterLimit: 2, heightAt: () => 0 });
  assertValidMesh(mesh);
  assert.ok(mesh.stats.bevelJoinCount > 0);
  assert.ok(mesh.stats.triangleCount > roads.length * 2);
});

test('Chunk-clipped ribbons share exact boundary position, tangent width, and elevation', () => {
  const leftRoad = road({
    id: 'boundary:chunk:0:0', route: 'boundary',
    start: { x: 3, z: 5 }, end: { x: 16, z: 11 },
  });
  const rightRoad = road({
    id: 'boundary:chunk:1:0', route: 'boundary',
    start: { x: 16, z: 11 }, end: { x: 29, z: 17 },
  });
  const heightAt = (x, z) => Math.round((x * 0.01 + z * 0.005) * 1e6) / 1e6;
  const left = buildSettlementRoadRibbonMeshData({
    roads: [leftRoad], heightAt, clipBounds: { minX: 0, minZ: 0, maxX: 16, maxZ: 16 },
  });
  const right = buildSettlementRoadRibbonMeshData({
    roads: [rightRoad], heightAt, originX: 16,
    clipBounds: { minX: 16, minZ: 0, maxX: 32, maxZ: 32 },
  });
  const boundaryVertices = (mesh, localBoundaryX) => {
    const values = [];
    for (let index = 0; index < mesh.positions.length; index += 3) {
      if (mesh.positions[index] === localBoundaryX) {
        values.push(`${mesh.positions[index + 1].toFixed(6)},${mesh.positions[index + 2].toFixed(6)}`);
      }
    }
    return [...new Set(values)].sort();
  };
  assert.deepEqual(boundaryVertices(left, 16), boundaryVertices(right, 0));
  assert.equal(boundaryVertices(left, 16).length, 2);
  assert.equal(Math.max(...left.positions.filter((_, index) => index % 3 === 0)), 16);
  assert.equal(Math.min(...right.positions.filter((_, index) => index % 3 === 0)), 0);
});

test('vertex and index output ignores road, route, and asynchronous completion order', async () => {
  const roads = [
    road({ id: 'a0', route: 'a', order: 0, start: { x: -10, z: 0 }, end: { x: 0, z: 0 } }),
    road({ id: 'a1', route: 'a', order: 1, start: { x: 0, z: 0 }, end: { x: 10, z: 4 } }),
    road({ id: 'b0', route: 'b', order: 0, start: { x: 0, z: -10 }, end: { x: 0, z: 0 } }),
    road({ id: 'c0', route: 'c', order: 0, start: { x: 0, z: 0 }, end: { x: -6, z: 9 } }),
  ];
  const expected = build(roads);
  const variants = await Promise.all([
    roads,
    [...roads].reverse(),
    [roads[2], roads[0], roads[3], roads[1]],
    await Promise.all([...roads].reverse().map(value => Promise.resolve(value))),
  ].map(async values => build(await values)));
  for (const variant of variants) {
    assert.equal(variant.hash, expected.hash);
    assert.deepEqual([...variant.positions], [...expected.positions]);
    assert.deepEqual([...variant.indices], [...expected.indices]);
  }
});

test('resumable Road phases are bit-identical across randomized cursor schedules', () => {
  let randomState = 0x35a911cd;
  const random = () => {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return randomState / 2 ** 32;
  };
  const schedules = [[1], [7, 2, 31, 3], [64, 1, 5]];
  for (let sample = 0; sample < 32; sample += 1) {
    const count = 8 + Math.floor(random() * 56);
    const roads = Array.from({ length: count }, (_, index) => {
      const startX = Math.round((random() * 120 - 60) * 1e6) / 1e6;
      const startZ = Math.round((random() * 120 - 60) * 1e6) / 1e6;
      return road({
        id: `random:${sample}:${index}`,
        route: `random-route:${index % 9}`,
        order: index,
        width: 1.5 + random() * 5,
        start: { x: startX, z: startZ },
        end: {
          x: startX + 1 + random() * 24,
          z: startZ - 12 + random() * 24,
        },
      });
    });
    const options = {
      roads,
      heightAt: (x, z) => Math.round((x * 0.01 + z * 0.005) * 1e6) / 1e6,
      originX: -64,
      originZ: -64,
      clipBounds: { minX: -64, minZ: -64, maxX: 64, maxZ: 64 },
    };
    const expected = buildSettlementRoadRibbonMeshData(options);
    for (const schedule of schedules) {
      const work = createSettlementRoadRibbonMeshWork(options);
      let cursor = 0;
      while (!work.done) {
        advanceSettlementRoadRibbonMeshWork(work, {
          unitLimit: schedule[cursor % schedule.length],
        });
        cursor += 1;
      }
      assert.equal(work.result.hash, expected.hash, `hash sample=${sample}`);
      assert.deepEqual(work.result.stats, expected.stats, `stats sample=${sample}`);
      assert.deepEqual(work.result.positions, expected.positions, `positions sample=${sample}`);
      assert.deepEqual(work.result.normals, expected.normals, `normals sample=${sample}`);
      assert.deepEqual(work.result.indices, expected.indices, `indices sample=${sample}`);
    }
  }
});

test('192-road resumable stress keeps canonical output and bounded units/slices', t => {
  const roads = Array.from({ length: 192 }, (_, index) => {
    const lane = index % 12;
    const row = Math.floor(index / 12);
    return road({
      id: `stress:${index}`,
      route: `route:${row}`,
      order: lane,
      width: 1.75 + row * 0.1,
      start: { x: 80 + lane, z: 2 + row * 3 },
      end: { x: 84 + lane, z: 2.5 + row * 3 },
    });
  });
  const options = {
    roads,
    heightAt: (x, z) => Math.round((x * 0.01 + z * 0.005) * 1e6) / 1e6,
    originX: 80,
    originZ: 0,
    clipBounds: { minX: 80, minZ: 0, maxX: 96, maxZ: 64 },
  };
  const work = createSettlementRoadRibbonMeshWork(options);
  let maximumUnitMs = 0;
  let maximumSliceMs = 0;
  let unitCount = 0;
  while (!work.done) {
    const sliceStartedAt = performance.now();
    do {
      const unitStartedAt = performance.now();
      advanceSettlementRoadRibbonMeshWork(work, { unitLimit: 1 });
      maximumUnitMs = Math.max(maximumUnitMs, performance.now() - unitStartedAt);
      unitCount += 1;
    } while (!work.done && performance.now() - sliceStartedAt < 2);
    maximumSliceMs = Math.max(maximumSliceMs, performance.now() - sliceStartedAt);
  }
  assert.equal(work.result.hash, 'a2516fb6');
  assert.deepEqual(work.result.stats, {
    roadRecordCount: 192,
    routeCount: 16,
    polylineCount: 192,
    nodeCount: 384,
    junctionCount: 0,
    miterJoinCount: 0,
    bevelJoinCount: 0,
    vertexCount: 770,
    indexCount: 1200,
    triangleCount: 400,
    duplicateFaceCount: 0,
    degenerateTriangleCount: 0,
    uploadBytes: 23280,
  });
  assert.ok(maximumUnitMs <= 4, `Road unit ${maximumUnitMs.toFixed(3)}ms exceeds 4ms`);
  assert.ok(maximumSliceMs <= 8, `Road slice ${maximumSliceMs.toFixed(3)}ms exceeds 8ms`);
  t.diagnostic(JSON.stringify({ maximumUnitMs, maximumSliceMs, unitCount }));
});

function properSegmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const orient = (a, b, c) => (
    (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
  );
  const first = orient(firstStart, firstEnd, secondStart);
  const second = orient(firstStart, firstEnd, secondEnd);
  const third = orient(secondStart, secondEnd, firstStart);
  const fourth = orient(secondStart, secondEnd, firstEnd);
  return first * second < -1e-8 && third * fourth < -1e-8;
}

function countTriangleSelfIntersections(mesh) {
  const point = index => ({ x: mesh.positions[index * 3], z: mesh.positions[index * 3 + 2] });
  const triangles = [];
  for (let index = 0; index < mesh.indices.length; index += 3) {
    triangles.push([mesh.indices[index], mesh.indices[index + 1], mesh.indices[index + 2]]);
  }
  let intersections = 0;
  for (let leftIndex = 0; leftIndex < triangles.length; leftIndex += 1) {
    const left = triangles[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < triangles.length; rightIndex += 1) {
      const right = triangles[rightIndex];
      if (left.some(value => right.includes(value))) continue;
      const leftPoints = left.map(point);
      const rightPoints = right.map(point);
      const leftEdges = [[0, 1], [1, 2], [2, 0]];
      const rightEdges = [[0, 1], [1, 2], [2, 0]];
      if (leftEdges.some(([a, b]) => rightEdges.some(([c, d]) => properSegmentsIntersect(
        leftPoints[a], leftPoints[b], rightPoints[c], rightPoints[d],
      )))) intersections += 1;
    }
  }
  return intersections;
}

test('three CITY/TOWN seeds keep canonical data immutable and pass real-network geometry validation', async t => {
  const seeds = ['W5 distributed golden', 'road-v3-seed-b', 'road-v3-seed-c'];
  const rows = [];
  for (const worldSeed of seeds) {
    const generator = await createDistributedSettlementChunkGenerator({
      worldSeed,
      settlementRoadGraphGeneratorId: ROAD_GRAPH_V3_GENERATOR_ID,
      settlementLotMode: SETTLEMENT_LOT_V2_GENERATOR_ID,
    });
    try {
      const candidates = await generator.distributor.findInMacroRange(-10, 10, -10, 10);
      for (const settlementType of [SETTLEMENT_TYPES.CITY, SETTLEMENT_TYPES.TOWN]) {
        const candidate = candidates.find(value => value.settlementType === settlementType);
        assert.ok(candidate);
        const template = await generator.resolveSettlementTemplate({ candidate });
        const logicalBefore = JSON.stringify({
          roads: template.roads,
          blocks: template.roadGraph.metadata.blocks,
          buildings: template.buildings,
        });
        const startedAt = performance.now();
        const mesh = build(template.roads);
        const generationMs = performance.now() - startedAt;
        const repeated = build([...template.roads].reverse());
        assert.equal(repeated.hash, mesh.hash);
        assert.deepEqual([...repeated.positions], [...mesh.positions]);
        assert.deepEqual([...repeated.indices], [...mesh.indices]);
        assert.equal(JSON.stringify({
          roads: template.roads,
          blocks: template.roadGraph.metadata.blocks,
          buildings: template.buildings,
        }), logicalBefore);
        assertValidMesh(mesh);
        assert.equal(countTriangleSelfIntersections(mesh), 0, `${worldSeed}:${settlementType}`);
        assert.equal([...mesh.indices].every(index => index < mesh.stats.vertexCount), true);
        const junctions = new Map();
        for (const value of template.roads) {
          for (const endpoint of [value.start, value.end]) {
            const key = `${endpoint.x.toFixed(6)},${endpoint.z.toFixed(6)}`;
            junctions.set(key, (junctions.get(key) ?? 0) + 1);
          }
        }
        const oldJunctionCount = [...junctions.values()].filter(count => count >= 2).length;
        rows.push({
          worldSeed,
          settlementType,
          roads: template.roads.length,
          routes: mesh.stats.routeCount,
          polylines: mesh.stats.polylineCount,
          junctions: mesh.stats.junctionCount,
          oldDrawCalls: 1 + Number(oldJunctionCount > 0),
          newDrawCalls: 1,
          oldGeometryCount: 1,
          newGeometryCount: 1,
          oldVertexCount: 4,
          newVertexCount: mesh.stats.vertexCount,
          oldIndexCount: 6,
          newIndexCount: mesh.stats.indexCount,
          oldUploadBytes: (template.roads.length + oldJunctionCount) * 64 + 140,
          newUploadBytes: mesh.stats.uploadBytes,
          generationMs: Number(generationMs.toFixed(3)),
          hash: mesh.hash,
        });
      }
    } finally {
      await generator.shutdown();
    }
  }
  t.diagnostic(JSON.stringify(rows));
});

test('Chunk generation order and parallel completion preserve every per-Chunk ribbon hash', async () => {
  const createGenerator = () => createDistributedSettlementChunkGenerator({
    worldSeed: 'road-ribbon-chunk-order',
    settlementRoadGraphGeneratorId: ROAD_GRAPH_V3_GENERATOR_ID,
    settlementLotMode: SETTLEMENT_LOT_V2_GENERATOR_ID,
  });
  const generators = await Promise.all([createGenerator(), createGenerator(), createGenerator()]);
  try {
    const candidate = (await generators[0].distributor.findInMacroRange(-10, 10, -10, 10))
      .find(value => value.settlementType === SETTLEMENT_TYPES.CITY);
    assert.ok(candidate);
    const centerX = Math.floor(candidate.center.x / LOGICAL_CHUNK_SIZE_METERS);
    const centerZ = Math.floor(candidate.center.z / LOGICAL_CHUNK_SIZE_METERS);
    const coordinates = [];
    for (let z = centerZ - 2; z <= centerZ + 2; z += 1) {
      for (let x = centerX - 2; x <= centerX + 2; x += 1) coordinates.push([x, z]);
    }
    const [forwardChunks, reverseChunks, parallelChunks] = await Promise.all([
      (async () => {
        const chunks = [];
        for (const [x, z] of coordinates) chunks.push(await generators[0].generateChunk(x, z));
        return chunks;
      })(),
      (async () => {
        const chunks = [];
        for (const [x, z] of [...coordinates].reverse()) {
          chunks.push(await generators[1].generateChunk(x, z));
        }
        return chunks;
      })(),
      Promise.all(coordinates.map(([x, z]) => generators[2].generateChunk(x, z))),
    ]);
    const snapshot = chunks => Object.fromEntries(chunks.map(chunk => {
      const roads = chunk.settlementFeatures.filter(value => value.featureType === 'settlement-road');
      const heightAt = createRoadRibbonHeightSampler(roads, (value, point) => (
        Number.isFinite(point.y)
          ? point.y : sampleW8SurfaceHeightMeters(chunk, point.x, point.z)
      ));
      const minimumX = chunk.chunkX * LOGICAL_CHUNK_SIZE_METERS;
      const minimumZ = chunk.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
      const mesh = buildSettlementRoadRibbonMeshData({
        roads,
        heightAt,
        originX: minimumX,
        originZ: minimumZ,
        clipBounds: {
          minX: minimumX,
          minZ: minimumZ,
          maxX: minimumX + LOGICAL_CHUNK_SIZE_METERS,
          maxZ: minimumZ + LOGICAL_CHUNK_SIZE_METERS,
        },
      });
      return [`${chunk.chunkX},${chunk.chunkZ}`, mesh.hash];
    }).sort(([left], [right]) => left.localeCompare(right)));
    assert.deepEqual(snapshot(reverseChunks), snapshot(forwardChunks));
    assert.deepEqual(snapshot(parallelChunks), snapshot(forwardChunks));
  } finally {
    await Promise.all(generators.map(generator => generator.shutdown()));
  }
});
