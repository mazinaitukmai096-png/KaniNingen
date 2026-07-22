import { canonicalizeJson } from '../g0/canonical-json.js';
import { sha256Hex } from '../g0/sha256.js';

export const EDGE_DEFINITIONS = Object.freeze({
  north: Object.freeze({ opposite: 'south', axis: 'z', side: 'min', direction: Object.freeze({ x: 0, z: -1 }) }),
  east: Object.freeze({ opposite: 'west', axis: 'x', side: 'max', direction: Object.freeze({ x: 1, z: 0 }) }),
  south: Object.freeze({ opposite: 'north', axis: 'z', side: 'max', direction: Object.freeze({ x: 0, z: 1 }) }),
  west: Object.freeze({ opposite: 'east', axis: 'x', side: 'min', direction: Object.freeze({ x: -1, z: 0 }) }),
});

export function getEdgeVertexCoordinates(resolution, edge) {
  if (!EDGE_DEFINITIONS[edge]) throw new TypeError(`unsupported terrain edge ${edge}`);
  const coordinates = [];
  if (edge === 'north' || edge === 'south') {
    const z = edge === 'north' ? 0 : resolution.z - 1;
    for (let x = 0; x < resolution.x; x += 1) coordinates.push({ x, z });
  } else {
    const x = edge === 'west' ? 0 : resolution.x - 1;
    for (let z = 0; z < resolution.z; z += 1) coordinates.push({ x, z });
  }
  return coordinates;
}

export function localToWorld(position, chunkCoordinate, chunkSize = 16) {
  return { x: position.x + chunkCoordinate.x * chunkSize, z: position.z + chunkCoordinate.z * chunkSize };
}

export function createBorderSampleKey(worldPosition) {
  return `border-sample-v1:${Math.round(worldPosition.x * 1000)}:${Math.round(worldPosition.z * 1000)}`;
}

export function createCornerIdentity(worldPosition) {
  return `corner-v1:${Math.round(worldPosition.x * 1000)}:${Math.round(worldPosition.z * 1000)}`;
}

export function extractTerrainEdge(terrain, edge) {
  const vertices = [];
  const append = (x, z) => {
    const index = z * terrain.resolution.x + x;
    vertices.push({
      height: terrain.heights[index],
      materialWeights: terrain.materialWeights.slice(index * 5, index * 5 + 5),
      moisture: terrain.moisture[index],
      rockiness: terrain.rockiness[index],
    });
  };
  for (const coordinate of getEdgeVertexCoordinates(terrain.resolution, edge)) append(coordinate.x, coordinate.z);
  return {
    schemaVersion: 'terrain-edge-1', edge,
    heightUnitMeters: terrain.heightUnitMeters,
    materialOrder: [...terrain.materialOrder], vertices,
  };
}

function comparable(edgeData) {
  return { schemaVersion: edgeData.schemaVersion, heightUnitMeters: edgeData.heightUnitMeters,
    materialOrder: edgeData.materialOrder, vertices: edgeData.vertices };
}

export async function hashTerrainEdge(terrain, edge) {
  return `sha256:${await sha256Hex(canonicalizeJson(comparable(extractTerrainEdge(terrain, edge))))}`;
}

export function validateTerrainEdgePair(aTerrain, aEdge, bTerrain, bEdge) {
  const errors = [];
  if (EDGE_DEFINITIONS[aEdge]?.opposite !== bEdge) errors.push('terrain edges are not opposite');
  let a; let b;
  try { a = extractTerrainEdge(aTerrain, aEdge); b = extractTerrainEdge(bTerrain, bEdge); }
  catch (error) { return { valid: false, errors: [error.message] }; }
  if (a.heightUnitMeters !== b.heightUnitMeters) errors.push('height units differ');
  if (canonicalizeJson(a.materialOrder) !== canonicalizeJson(b.materialOrder)) errors.push('material orders differ');
  if (a.vertices.length !== b.vertices.length) errors.push('terrain edge resolutions differ');
  else a.vertices.forEach((vertex, index) => {
    const other = b.vertices[index];
    if (vertex.height !== other.height) errors.push(`height differs at boundary vertex ${index}`);
    if (canonicalizeJson(vertex.materialWeights) !== canonicalizeJson(other.materialWeights)) errors.push(`materialWeights differ at boundary vertex ${index}`);
    if (vertex.moisture !== other.moisture) errors.push(`moisture differs at boundary vertex ${index}`);
    if (vertex.rockiness !== other.rockiness) errors.push(`rockiness differs at boundary vertex ${index}`);
  });
  return { valid: errors.length === 0, errors };
}

export function extractTerrainCorner(terrain, corner) {
  const coordinates = {
    northwest: { x: 0, z: 0 }, northeast: { x: terrain.resolution.x - 1, z: 0 },
    southeast: { x: terrain.resolution.x - 1, z: terrain.resolution.z - 1 },
    southwest: { x: 0, z: terrain.resolution.z - 1 },
  }[corner];
  if (!coordinates) throw new TypeError(`unsupported terrain corner ${corner}`);
  const index = coordinates.z * terrain.resolution.x + coordinates.x;
  return { height: terrain.heights[index], materialWeights: terrain.materialWeights.slice(index * 5, index * 5 + 5),
    moisture: terrain.moisture[index], rockiness: terrain.rockiness[index] };
}
