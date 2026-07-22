import { canonicalizeJson } from '../g0/canonical-json.js';
import { createDeterministicRandom, deriveLocalSeed64 } from '../g0/deterministic-random.js';
import { sha256Hex } from '../g0/sha256.js';
import { determineLocalFeatureOwner } from '../g2/feature-projection.js';
import { sampleFeatureTerrainInfluence } from './biome-terrain.js';

const CHUNK_SIZE = 16;
const SCHEMA = 'detail-candidates-1';
const LIMITS = Object.freeze({ vegetation: 512, rocks: 256, bareGround: 128 });
const CELLS = Object.freeze({ vegetation: 0.5, rocks: 0.5, bareGround: 1 });
const TYPES = new Set(['vegetation', 'rock', 'bare-ground']);
const q = value => Math.round(value * 1e6) / 1e6;
const clamp = value => Math.max(0, Math.min(1, value));

export function determineDetailCandidateOwner(worldPosition) { return determineLocalFeatureOwner(worldPosition, CHUNK_SIZE); }

function sampleIndex(terrain, localX, localZ) {
  const x = Math.max(0, Math.min(terrain.resolution.x - 1, Math.round(localX / CHUNK_SIZE * (terrain.resolution.x - 1))));
  const z = Math.max(0, Math.min(terrain.resolution.z - 1, Math.round(localZ / CHUNK_SIZE * (terrain.resolution.z - 1))));
  return z * terrain.resolution.x + x;
}

function sampleTerrain(chunk, worldPosition) {
  const localX = worldPosition.x - chunk.chunkCoordinate.x * CHUNK_SIZE; const localZ = worldPosition.z - chunk.chunkCoordinate.z * CHUNK_SIZE;
  const index = sampleIndex(chunk.terrain, localX, localZ); const offset = index * 5;
  return { index, height: chunk.terrain.heights[index] * chunk.terrain.heightUnitMeters,
    materials: chunk.terrain.materialWeights.slice(offset, offset + 5), moisture: chunk.terrain.moisture[index], rockiness: chunk.terrain.rockiness[index] };
}

function biomeWeightsAt(chunk, worldPosition) {
  const field = chunk.biomeField; const localX = worldPosition.x - chunk.chunkCoordinate.x * CHUNK_SIZE; const localZ = worldPosition.z - chunk.chunkCoordinate.z * CHUNK_SIZE;
  const fx = localX / CHUNK_SIZE * (field.resolution.x - 1); const fz = localZ / CHUNK_SIZE * (field.resolution.z - 1);
  const x0 = Math.floor(fx); const z0 = Math.floor(fz); const x1 = Math.min(x0 + 1, field.resolution.x - 1); const z1 = Math.min(z0 + 1, field.resolution.z - 1); const tx = fx - x0; const tz = fz - z0; const count = field.biomeOrder.length;
  const at = (x, z, biome) => field.weights[(z * field.resolution.x + x) * count + biome];
  return field.biomeOrder.map((biomeId, biome) => ({ biomeId, weight: q((at(x0, z0, biome) * (1 - tx) + at(x1, z0, biome) * tx) * (1 - tz) + (at(x0, z1, biome) * (1 - tx) + at(x1, z1, biome) * tx) * tz) }));
}

export async function createDetailCandidateId({ worldSeedHash, generatorMajor = 3, candidateType, quantizedWorldCell, semanticKey }) {
  if (!TYPES.has(candidateType) || !Number.isSafeInteger(quantizedWorldCell?.x) || !Number.isSafeInteger(quantizedWorldCell?.z) || typeof semanticKey !== 'string' || !semanticKey) throw new TypeError('invalid Detail candidate identity input');
  const canonicalInput = canonicalizeJson({ schema: 'detail-candidate-id-1', worldSeedHash, generatorMajor, candidateType, quantizedWorldCell, semanticKey });
  return { candidateId: `detail-v1:${candidateType}:${(await sha256Hex(canonicalInput)).slice(0, 24)}`, canonicalInput };
}

export function calculateTerrainSlope(terrain, localX, localZ, chunkSize = CHUNK_SIZE) {
  const spacing = chunkSize / (terrain.resolution.x - 1); const x = Math.max(0, Math.min(terrain.resolution.x - 1, Math.round(localX / spacing))); const z = Math.max(0, Math.min(terrain.resolution.z - 1, Math.round(localZ / spacing)));
  const height = (ix, iz) => terrain.heights[iz * terrain.resolution.x + ix] * terrain.heightUnitMeters;
  const x0 = Math.max(0, x - 1); const x1 = Math.min(terrain.resolution.x - 1, x + 1); const z0 = Math.max(0, z - 1); const z1 = Math.min(terrain.resolution.z - 1, z + 1);
  const dx = (height(x1, z) - height(x0, z)) / ((x1 - x0 || 1) * spacing); const dz = (height(x, z1) - height(x, z0)) / ((z1 - z0 || 1) * spacing);
  return q(Math.hypot(dx, dz));
}

export function evaluateBareGroundEligibility({ drySoil, boundaryDistance, crossingDistance, passageDistance, gardenWeight, residentialWeight }) {
  const compacted = Math.max(boundaryDistance === null ? 0 : clamp(1 - boundaryDistance / 2.5), crossingDistance === null ? 0 : clamp(1 - crossingDistance / 1.5), passageDistance === null ? 0 : clamp(1 - passageDistance / 1.5));
  return q(clamp(drySoil * 0.58 + compacted * 0.32 + gardenWeight * 0.08 + residentialWeight * 0.12));
}

export function evaluateVegetationEligibility({ grass, moisture, slope, riverDistance, crossingDistance, passageDistance, structureBoundaryDistance = null, gardenWeight, residentialWeight, bareGroundEligibility }) {
  if (riverDistance !== null && riverDistance <= 0) return 0;
  const path = Math.max(crossingDistance === null ? 0 : clamp(1 - crossingDistance / 1.8), passageDistance === null ? 0 : clamp(1 - passageDistance / 1.5));
  const terrain = clamp(1 - slope / 0.45); const moistureFit = 0.65 + 0.35 * clamp(1 - Math.abs(moisture - 0.55) / 0.55);
  const compactedEdge = structureBoundaryDistance === null ? 0 : clamp(1 - structureBoundaryDistance / 2.5);
  return q(clamp(grass * terrain * moistureFit * (0.72 + gardenWeight * 0.38) * (1 - residentialWeight * 0.48) * (1 - path * 0.78) * (1 - compactedEdge * 0.48) * (1 - bareGroundEligibility * 0.7)));
}

export function evaluateRockEligibility({ rockMaterial, rockiness, rockBandDistance, riverDistance, crossingDistance, passageDistance, residentialWeight }) {
  const band = rockBandDistance === null ? 0 : clamp(1 - rockBandDistance / 4); const riverGravel = riverDistance === null ? 0 : clamp(1 - Math.max(0, riverDistance) / 3);
  const path = Math.max(crossingDistance === null ? 0 : clamp(1 - crossingDistance / 1.5), passageDistance === null ? 0 : clamp(1 - passageDistance / 1.5));
  return q(clamp((rockMaterial * 0.34 + rockiness * 0.42 + band * 0.34 + riverGravel * 0.12) * (1 - path * 0.68) * (1 - residentialWeight * 0.55)));
}

function nullable(value) { return Number.isFinite(value) ? q(value) : null; }
function featureIds(features, influence) {
  const thresholds = { river: influence.river.distance <= 6, 'rock-band': influence.rockDistance <= 4, 'structure-boundary': influence.boundaryDistance <= 3, crossing: influence.crossingDistance <= 2, passage: influence.passageDistance <= 2 };
  return features.filter(item => thresholds[item.featureType]).map(item => item.stableId).sort();
}

async function buildCandidate({ chunk, features, random, category, candidateType, subtype, cellX, cellZ, cellSize, eligibility, terrain, memberships, influence }) {
  const semanticKey = `${subtype}:slot-0`; const identity = await createDetailCandidateId({ worldSeedHash: chunk.worldSeedHash, candidateType, quantizedWorldCell: { x: cellX, z: cellZ }, semanticKey });
  const key = `${candidateType}:${cellX}:${cellZ}:${semanticKey}`; const orientationSeed = q(await random.float01(`${key}:orientation`)); const variationSeed = q(await random.float01(`${key}:variation`));
  const position = { x: q((cellX + 0.5) * cellSize), z: q((cellZ + 0.5) * cellSize) }; const sampled = sampleTerrain(chunk, position); position.y = q(sampled.height);
  const densityMetric = eligibility * (0.8 + variationSeed * 0.4); const densityClass = densityMetric >= 0.48 ? 'dense' : densityMetric >= 0.25 ? 'moderate' : 'sparse';
  const sizeClass = candidateType === 'vegetation' ? (subtype === 'tall-grass' ? 'tall' : subtype === 'medium-grass' ? 'medium' : 'small') : candidateType === 'rock' ? (subtype === 'medium-rock' ? 'medium' : 'small') : 'area';
  return { schemaVersion: 'detail-candidate-1', ...identity, candidateType, subtype, worldPosition: position,
    owningChunkCoordinate: determineDetailCandidateOwner(position), sourceBiomeWeights: memberships, sourceFeatureIds: featureIds(features, influence),
    densityClass, sizeClass, orientationSeed, variationSeed, eligibility: q(eligibility), metadata: { cellSizeMeters: cellSize, slope: terrain.slope,
      riverDistance: nullable(influence.river.distance), rockBandDistance: nullable(influence.rockDistance), structureBoundaryDistance: nullable(influence.boundaryDistance),
      crossingDistance: nullable(influence.crossingDistance), passageDistance: nullable(influence.passageDistance), bareGroundEligibility: terrain.bareGroundEligibility, category } };
}

export function compareFormalDetailCandidates(a, b) { return a.candidateId.localeCompare(b.candidateId); }

export function applyFormalDetailCategoryLimit(items, limit) { return [...items].sort(compareFormalDetailCandidates).slice(0, limit); }

async function evaluateFormalDetailCandidateCellG3({ chunk, worldFeatures, random, category, candidateType, cellX, cellZ, cellSize }) {
  const position = { x: (cellX + 0.5) * cellSize, z: (cellZ + 0.5) * cellSize }; if (determineDetailCandidateOwner(position).x !== chunk.chunkCoordinate.x || determineDetailCandidateOwner(position).z !== chunk.chunkCoordinate.z) return null;
  const sampled = sampleTerrain(chunk, position); const memberships = biomeWeightsAt(chunk, position); const weights = Object.fromEntries(memberships.map(item => [item.biomeId, item.weight]));
  const influence = sampleFeatureTerrainInfluence(position, worldFeatures);
  const terrain = { ...sampled, slope: calculateTerrainSlope(chunk.terrain, position.x - chunk.chunkCoordinate.x * CHUNK_SIZE, position.z - chunk.chunkCoordinate.z * CHUNK_SIZE) };
  const common = { drySoil: sampled.materials[1], boundaryDistance: nullable(influence.boundaryDistance), crossingDistance: nullable(influence.crossingDistance), passageDistance: nullable(influence.passageDistance), gardenWeight: weights['garden-edge'] ?? 0, residentialWeight: weights['residential-low-density'] ?? 0 };
  const bare = evaluateBareGroundEligibility(common); let eligibility; let subtype;
  terrain.bareGroundEligibility = bare;
  if (candidateType === 'bare-ground') { eligibility = bare; subtype = influence.crossingDistance < 1.5 ? 'compacted-crossing' : 'dry-soil-patch'; }
  else if (candidateType === 'vegetation') { eligibility = evaluateVegetationEligibility({ grass: sampled.materials[0], moisture: sampled.moisture, slope: terrain.slope, riverDistance: nullable(influence.river.distance - influence.river.width / 2), crossingDistance: common.crossingDistance, passageDistance: common.passageDistance, structureBoundaryDistance: common.boundaryDistance, gardenWeight: common.gardenWeight, residentialWeight: common.residentialWeight, bareGroundEligibility: bare }); subtype = influence.crossingDistance < 2 || influence.passageDistance < 2 ? 'low-grass' : sampled.moisture > 0.7 ? 'tall-grass' : sampled.moisture > 0.42 ? 'medium-grass' : (await random.float01(`veg:${cellX}:${cellZ}:fallen`)) < 0.12 ? 'fallen-grass' : 'low-grass'; }
  else { eligibility = evaluateRockEligibility({ rockMaterial: sampled.materials[4], rockiness: sampled.rockiness, rockBandDistance: nullable(influence.rockDistance), riverDistance: nullable(influence.river.distance), crossingDistance: common.crossingDistance, passageDistance: common.passageDistance, residentialWeight: common.residentialWeight }); subtype = eligibility > 0.72 && common.residentialWeight < 0.35 ? 'medium-rock' : influence.river.distance < 3 ? 'gravel' : 'small-stone'; }
  const roll = await random.float01(`${candidateType}:${cellX}:${cellZ}:eligibility`); if (roll >= eligibility * (candidateType === 'bare-ground' ? 0.62 : candidateType === 'rock' ? 0.48 : 0.72)) return null;
  return buildCandidate({ chunk, features: worldFeatures, random, category, candidateType, subtype, cellX, cellZ, cellSize, eligibility, terrain, memberships, influence });
}

function evaluateFormalRockCandidateCellG3(input) { return evaluateFormalDetailCandidateCellG3({ ...input, category: 'rocks', candidateType: 'rock', cellSize: CELLS.rocks }); }
function evaluateFormalBareGroundCandidateCellG3(input) { return evaluateFormalDetailCandidateCellG3({ ...input, category: 'bareGround', candidateType: 'bare-ground', cellSize: CELLS.bareGround }); }

async function generateFormalDetailCategoryCandidatesG3({ chunk, worldFeatures, random, category, candidateType, cellSize }) {
  const output = []; const evaluateCell = candidateType === 'rock' ? evaluateFormalRockCandidateCellG3 : candidateType === 'bare-ground' ? evaluateFormalBareGroundCandidateCellG3 : evaluateFormalDetailCandidateCellG3;
  const minCellX = Math.floor(chunk.chunkCoordinate.x * CHUNK_SIZE / cellSize); const maxCellX = Math.ceil((chunk.chunkCoordinate.x + 1) * CHUNK_SIZE / cellSize) - 1;
  const minCellZ = Math.floor(chunk.chunkCoordinate.z * CHUNK_SIZE / cellSize); const maxCellZ = Math.ceil((chunk.chunkCoordinate.z + 1) * CHUNK_SIZE / cellSize) - 1;
  for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
    const candidate = await evaluateCell({ chunk, worldFeatures, random, category, candidateType, cellX, cellZ, cellSize }); if (candidate) output.push(candidate);
  }
  return applyFormalDetailCategoryLimit(output, LIMITS[category]);
}

async function createFormalDetailRandomG3(worldSeedHash) {
  const seed = await deriveLocalSeed64({ worldSeedHash, namespace: 'g3-detail-candidates', semanticKey: 'detail-candidates-1' });
  return createDeterministicRandom(seed);
}

export async function generateFormalRockCandidatesForChunkG3({ chunk, worldFeatures }) {
  return generateFormalDetailCategoryCandidatesG3({ chunk, worldFeatures, random: await createFormalDetailRandomG3(chunk.worldSeedHash), category: 'rocks', candidateType: 'rock', cellSize: CELLS.rocks });
}

export async function generateFormalBareGroundCandidatesForChunkG3({ chunk, worldFeatures }) {
  return generateFormalDetailCategoryCandidatesG3({ chunk, worldFeatures, random: await createFormalDetailRandomG3(chunk.worldSeedHash), category: 'bareGround', candidateType: 'bare-ground', cellSize: CELLS.bareGround });
}

export async function generateDetailCandidatesForChunk({ chunk, worldFeatures }) {
  const random = await createFormalDetailRandomG3(chunk.worldSeedHash);
  const bareGround = await generateFormalDetailCategoryCandidatesG3({ chunk, worldFeatures, random, category: 'bareGround', candidateType: 'bare-ground', cellSize: CELLS.bareGround });
  const vegetation = await generateFormalDetailCategoryCandidatesG3({ chunk, worldFeatures, random, category: 'vegetation', candidateType: 'vegetation', cellSize: CELLS.vegetation });
  const rocks = await generateFormalDetailCategoryCandidatesG3({ chunk, worldFeatures, random, category: 'rocks', candidateType: 'rock', cellSize: CELLS.rocks });
  return { schemaVersion: SCHEMA, vegetation, rocks, bareGround };
}

export function validateDetailCandidates(details) {
  const errors = []; if (details?.schemaVersion !== SCHEMA) errors.push('invalid detailCandidates schemaVersion'); const ids = new Set();
  for (const [category, expectedType] of [['vegetation', 'vegetation'], ['rocks', 'rock'], ['bareGround', 'bare-ground']]) {
    const items = details?.[category]; if (!Array.isArray(items) || items.length > LIMITS[category]) { errors.push(`${category} candidates are invalid`); continue; }
    if (items.some((item, index) => index > 0 && items[index - 1].candidateId.localeCompare(item.candidateId) > 0)) errors.push(`${category} candidates are not sorted`);
    for (const item of items) { if (item?.schemaVersion !== 'detail-candidate-1' || item.candidateType !== expectedType || typeof item.candidateId !== 'string' || !item.candidateId) errors.push(`invalid ${category} candidate`);
      if (ids.has(item.candidateId)) errors.push(`duplicate candidateId ${item.candidateId}`); ids.add(item.candidateId);
      if (![item.worldPosition?.x, item.worldPosition?.y, item.worldPosition?.z, item.orientationSeed, item.variationSeed, item.eligibility].every(Number.isFinite)) errors.push(`non-finite ${category} candidate`);
      if (item.eligibility < 0 || item.eligibility > 1 || determineDetailCandidateOwner(item.worldPosition).x !== item.owningChunkCoordinate?.x || determineDetailCandidateOwner(item.worldPosition).z !== item.owningChunkCoordinate?.z) errors.push(`invalid ${category} ownership or eligibility`);
      if (!Array.isArray(item.sourceBiomeWeights) || !Array.isArray(item.sourceFeatureIds) || !item.metadata || typeof item.metadata !== 'object') errors.push(`invalid ${category} sources`); }
  }
  return { valid: errors.length === 0, errors };
}

export const G3_D_DETAIL = Object.freeze({ schemaVersion: SCHEMA, limits: LIMITS, cellSizesMeters: CELLS });
