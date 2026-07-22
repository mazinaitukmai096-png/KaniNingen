import { canonicalizeJson } from '../g0/canonical-json.js';
import { sha256Hex } from '../g0/sha256.js';
import { quantizeMillimeters } from './feature-bounds.js';

const EDGES = Object.freeze({
  north: { axis: 'z', side: 'min', outward: { x: 0, z: -1 }, opposite: 'south' },
  east: { axis: 'x', side: 'max', outward: { x: 1, z: 0 }, opposite: 'west' },
  south: { axis: 'z', side: 'max', outward: { x: 0, z: 1 }, opposite: 'north' },
  west: { axis: 'x', side: 'min', outward: { x: -1, z: 0 }, opposite: 'east' },
});

export async function createFeaturePortIdentity(input) {
  const canonical = canonicalizeJson({
    schema: 'feature-connection-1', worldSeedHash: input.worldSeedHash,
    generatorMajor: input.generatorMajor, featureId: input.featureId,
    semanticType: input.semanticType, boundaryAxis: input.boundaryAxis,
    quantizedWorldBoundary: input.quantizedWorldBoundary,
    semanticCrossingKey: input.semanticCrossingKey,
  });
  const digest = await sha256Hex(canonical);
  return { portId: `port-v1:${digest.slice(0, 32)}`, connectionKey: `sha256:${digest}` };
}

export function validateFeaturePort(port, edge, chunkBounds) {
  const errors = []; const definition = EDGES[edge];
  if (!port || typeof port !== 'object' || Array.isArray(port)) return { valid: false, errors: ['port must be an object'] };
  if (port.schemaVersion !== 'feature-port-1') errors.push('invalid port schemaVersion');
  if (port.edge !== edge || !definition) errors.push('port edge does not match adjacency edge');
  for (const field of ['portId', 'featureId', 'semanticType', 'connectionKey']) if (typeof port[field] !== 'string' || !port[field]) errors.push(`${field} is required`);
  if (!port.position || !Number.isFinite(port.position.x) || !Number.isFinite(port.position.z)) errors.push('port position is invalid');
  if (!port.direction || !Number.isFinite(port.direction.x) || !Number.isFinite(port.direction.z)) errors.push('port direction is invalid');
  else {
    const length = Math.hypot(port.direction.x, port.direction.z);
    if (Math.abs(length - 1) > 0.000001) errors.push('port direction must be normalized');
    else if (definition && port.direction.x * definition.outward.x + port.direction.z * definition.outward.z < Math.SQRT1_2) errors.push('port direction must face outward');
  }
  if (!Number.isFinite(port.width) || port.width <= 0 || port.width > 32) errors.push('port width is invalid');
  if (!Number.isFinite(port.elevation)) errors.push('port elevation is invalid');
  if (port.position && definition) {
    const expected = definition.side === 'min' ? chunkBounds[`min${definition.axis.toUpperCase()}`] : chunkBounds[`max${definition.axis.toUpperCase()}`];
    if (Math.abs(port.position[definition.axis] - expected) > 0.001) errors.push('port position is not on its edge');
    for (const value of [port.position.x, port.position.z, port.width, port.elevation]) {
      if (Number.isFinite(value) && Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-7) errors.push('port values must use millimeter quantization');
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateAdjacentPorts(a, b, origins = { a: { x: 0, z: 0 }, b: { x: 0, z: 0 } }) {
  const errors = [];
  if (!EDGES[a?.edge] || EDGES[a.edge].opposite !== b?.edge) errors.push('ports are not on opposite edges');
  if (a?.connectionKey !== b?.connectionKey || a?.semanticType !== b?.semanticType || a?.featureId !== b?.featureId) errors.push('port identities do not match');
  if (a?.position && b?.position) {
    const ax = a.position.x + (origins.a?.x ?? 0); const az = a.position.z + (origins.a?.z ?? 0);
    const bx = b.position.x + (origins.b?.x ?? 0); const bz = b.position.z + (origins.b?.z ?? 0);
    if (Math.abs(ax - bx) > 0.001 || Math.abs(az - bz) > 0.001) errors.push('port world positions do not match');
  }
  if (Math.abs((a?.width ?? Infinity) - (b?.width ?? 0)) > 0.001) errors.push('port widths do not match');
  if (Math.abs((a?.elevation ?? Infinity) - (b?.elevation ?? 0)) > 0.001) errors.push('port elevations do not match');
  if (a?.direction && b?.direction && a.direction.x * b.direction.x + a.direction.z * b.direction.z > -0.9998) errors.push('port directions are not opposed');
  return { valid: errors.length === 0, errors };
}

export { EDGES, quantizeMillimeters };
