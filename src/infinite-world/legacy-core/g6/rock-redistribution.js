import { createDeterministicRandom, deriveLocalSeed64 } from '../g0/deterministic-random.js';
import { createDetailCandidateId } from '../g3/detail-candidates.js';

const q6 = value => { const rounded = Math.round(value * 1e6) / 1e6; return Object.is(rounded, -0) ? 0 : rounded; };
const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };

export const G6_D_ROCK = Object.freeze({
  schemaVersion: 'g6-d1a-rock-field-1',
  generatorVersion: Object.freeze({ major: 6, minor: 3, patch: 0, id: 'worldgen-v6-d-rock-redistribution' }),
  candidateType: 'rock',
  cellSizeMeters: 0.5,
  maximumCandidatesPerCell: 1,
  maximumCandidatesPerChunk: 256,
  semanticSlot: 'slot-0',
  candidateRadiusMeters: Object.freeze({ 'medium-rock': 0.22, 'small-stone': 0.1, gravel: 0.045 }),
  field: Object.freeze({ clusterSpacingMeters: 3, strataSpacingMeters: 9 }),
  transitions: Object.freeze({
    // Meter clearances are measured from formal Feature geometry to the prospective Rock bounds.
    crossingClearanceMeters: 0.4,
    roadClearanceMeters: 0.25,
    passageClearanceMeters: 0.3,
    structureClearanceMeters: 0.35,
    rockBandFalloffMeters: 2.5,
  }),
  terrain: Object.freeze({ slopeStart: 0.015, slopeBlend: 0.1, curvatureBlend: 0.04 }),
  proposal: Object.freeze({ occupancyScale: 0.187, subtypeOccupancy: Object.freeze({ 'medium-rock': 0.4, 'small-stone': 1, gravel: 1 }), minimumScore: 0.055, gravelShoreMaximumMeters: 2, mediumRidge: 0.55, mediumSlope: 0.045, mediumRockiness: 0.42, mediumMaterial: 0.38 }),
});

const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.z);

function segmentDistance(point, a, b) {
  const dx = b.x - a.x; const dz = b.z - a.z; const length2 = dx * dx + dz * dz;
  const t = length2 ? clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / length2) : 0;
  return { distance: Math.hypot(point.x - a.x - dx * t, point.z - a.z - dz * t), t };
}

function pointInsidePolygon(point, vertices) {
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index, index += 1) {
    const a = vertices[index]; const b = vertices[previous];
    if ((a.z > point.z) !== (b.z > point.z) && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function geometryDistance(point, geometry, polygonInteriorIsZero = true) {
  if (!geometry) return Infinity;
  if (geometry.type === 'point') return Math.hypot(point.x - geometry.position.x, point.z - geometry.position.z);
  if (geometry.type === 'circle') return Math.max(0, Math.hypot(point.x - geometry.center.x, point.z - geometry.center.z) - geometry.radius);
  if (geometry.type === 'capsule') return Math.max(0, segmentDistance(point, geometry.start, geometry.end).distance - geometry.radius);
  if (geometry.type === 'polylineWithWidth') {
    let best = Infinity;
    for (let index = 0; index < geometry.points.length - 1; index += 1) {
      const hit = segmentDistance(point, geometry.points[index], geometry.points[index + 1]);
      const width = geometry.widths[index] + (geometry.widths[index + 1] - geometry.widths[index]) * hit.t;
      best = Math.min(best, Math.max(0, hit.distance - width / 2));
    }
    return best;
  }
  if (geometry.type === 'polygon2D') {
    if (polygonInteriorIsZero && pointInsidePolygon(point, geometry.vertices)) return 0;
    return Math.min(...geometry.vertices.map((vertex, index) => segmentDistance(point, vertex, geometry.vertices[(index + 1) % geometry.vertices.length]).distance));
  }
  return Infinity;
}

function groupFeatures(worldFeatures) {
  const result = new Map();
  for (const feature of [...worldFeatures].sort((a, b) => a.stableId.localeCompare(b.stableId))) {
    if (!result.has(feature.featureType)) result.set(feature.featureType, []);
    result.get(feature.featureType).push(feature);
  }
  return result;
}

function nearestFeatureDistance(point, profile, types, polygonInteriorIsZero = true) {
  let best = Infinity;
  for (const type of types) for (const feature of profile.featuresByType.get(type) ?? []) best = Math.min(best, geometryDistance(point, feature.geometry, polygonInteriorIsZero));
  return best;
}

async function interpolatedField(random, cache, namespace, point, spacingMeters) {
  const gx = Math.floor(point.x / spacingMeters); const gz = Math.floor(point.z / spacingMeters);
  const tx = point.x / spacingMeters - gx; const tz = point.z / spacingMeters - gz;
  const at = (x, z) => { const key = `${namespace}:${x}:${z}`; if (!cache.has(key)) cache.set(key, random.float01(key)); return cache.get(key); };
  const [a, b, c, d] = await Promise.all([at(gx, gz), at(gx + 1, gz), at(gx, gz + 1), at(gx + 1, gz + 1)]);
  return q6((a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz);
}

export async function createG6DRockProfile({ worldSeedHash, worldFeatures = [] }) {
  if (!Array.isArray(worldFeatures) || worldFeatures.some(feature => typeof feature?.stableId !== 'string' || typeof feature?.featureType !== 'string')) throw new TypeError('invalid G6-D worldFeatures');
  const fieldSeed = await deriveLocalSeed64({ worldSeedHash, namespace: 'g6-d-rock-field', semanticKey: G6_D_ROCK.schemaVersion });
  return Object.freeze({ schemaVersion: G6_D_ROCK.schemaVersion, worldSeedHash, fieldSeed, featuresByType: groupFeatures(worldFeatures), fieldCache: new Map() });
}

export async function evaluateRockFieldAtWorldPosition(profile, worldPosition) {
  if (profile?.schemaVersion !== G6_D_ROCK.schemaVersion || !finitePoint(worldPosition)) throw new TypeError('invalid G6-D Rock field input');
  const random = createDeterministicRandom(profile.fieldSeed);
  const cluster = await interpolatedField(random, profile.fieldCache, 'cluster', worldPosition, G6_D_ROCK.field.clusterSpacingMeters);
  const strata = await interpolatedField(random, profile.fieldCache, 'strata', worldPosition, G6_D_ROCK.field.strataSpacingMeters);
  return Object.freeze({ schemaVersion: 'g6-d1a-rock-field-sample-1', cluster, strata, combined: q6(clamp(cluster * 0.72 + strata * 0.28)) });
}

export function vegetationBoundsOverlap(worldPosition, rockRadiusMeters, vegetationCandidates = []) {
  if (!finitePoint(worldPosition) || !Number.isFinite(rockRadiusMeters) || rockRadiusMeters < 0 || !Array.isArray(vegetationCandidates)) throw new TypeError('invalid G6-D Vegetation bounds input');
  if (vegetationCandidates.some(candidate => !finitePoint(candidate?.worldPosition) || !Number.isFinite(candidate?.metadata?.candidateRadiusMeters) || candidate.metadata.candidateRadiusMeters < 0)) throw new TypeError('invalid G6-C Vegetation Candidate bounds');
  return vegetationCandidates.some(candidate => {
    const position = candidate?.worldPosition; const radius = candidate?.metadata?.candidateRadiusMeters;
    return Math.hypot(worldPosition.x - position.x, worldPosition.z - position.z) <= rockRadiusMeters + radius;
  });
}

export function evaluateRockEligibility(input) {
  const values = [input?.finalSlope, input?.ridge, input?.curvature, input?.rockiness, input?.rockMaterial, input?.field?.cluster, input?.field?.strata];
  const distance = value => (Number.isFinite(value) && value >= 0) || value === Infinity;
  if (!values.every(Number.isFinite) || !distance(input?.rockBandDistance) || !distance(input?.riverDistance) || !Number.isFinite(input?.riverHalfWidth) || input.riverHalfWidth < 0 || !Number.isFinite(input?.rockRadiusMeters) || input.rockRadiusMeters < 0) throw new TypeError('invalid G6-D Rock eligibility input');
  const distances = input.featureDistances ?? {}; const clearance = G6_D_ROCK.transitions; const forbiddenReasons = [];
  if (input.riverDistance <= input.riverHalfWidth + input.rockRadiusMeters) forbiddenReasons.push('river-core');
  if ((distances.crossing ?? Infinity) <= clearance.crossingClearanceMeters + input.rockRadiusMeters) forbiddenReasons.push('crossing');
  if ((distances.road ?? Infinity) <= clearance.roadClearanceMeters + input.rockRadiusMeters) forbiddenReasons.push('road');
  if ((distances.passage ?? Infinity) <= clearance.passageClearanceMeters + input.rockRadiusMeters) forbiddenReasons.push('passage');
  if ((distances.structure ?? Infinity) <= clearance.structureClearanceMeters + input.rockRadiusMeters) forbiddenReasons.push('structure');
  if (input.vegetationOverlap) forbiddenReasons.push('vegetation-bounds');
  const slope = smooth((input.finalSlope - G6_D_ROCK.terrain.slopeStart) / G6_D_ROCK.terrain.slopeBlend);
  const ridge = clamp(input.ridge); const curvature = smooth(Math.abs(input.curvature) / G6_D_ROCK.terrain.curvatureBlend);
  const rockiness = clamp(input.rockiness); const material = clamp(input.rockMaterial);
  const rockBand = smooth(1 - input.rockBandDistance / clearance.rockBandFalloffMeters);
  const terrainScore = clamp(0.04 + slope * 0.14 + ridge * 0.22 + curvature * 0.08 + rockiness * 0.28 + material * 0.2 + rockBand * 0.25);
  const fieldFactor = 0.4 + input.field.cluster * 0.48 + input.field.strata * 0.12;
  return Object.freeze({ schemaVersion: 'g6-d1a-rock-eligibility-1', eligible: forbiddenReasons.length === 0, score: q6(forbiddenReasons.length ? 0 : clamp(terrainScore * fieldFactor)), forbiddenReasons: Object.freeze(forbiddenReasons), components: Object.freeze({ slope: q6(slope), ridge: q6(ridge), curvature: q6(curvature), rockiness: q6(rockiness), rockMaterial: q6(material), rockBand: q6(rockBand), cluster: q6(input.field.cluster), strata: q6(input.field.strata) }) });
}

export async function classifyRockTerrainContext({ profile, worldPosition, finalSlope, ridge, curvature, rockiness, rockMaterial, rockRadiusMeters, riverDistance = Infinity, riverHalfWidth = 0, vegetationCandidates = [] }) {
  if (!finitePoint(worldPosition)) throw new TypeError('invalid G6-D Rock context position');
  const field = await evaluateRockFieldAtWorldPosition(profile, worldPosition);
  const featureDistances = {
    crossing: nearestFeatureDistance(worldPosition, profile, ['crossing']),
    road: nearestFeatureDistance(worldPosition, profile, ['road']),
    passage: nearestFeatureDistance(worldPosition, profile, ['passage']),
    structure: nearestFeatureDistance(worldPosition, profile, ['structure-boundary'], false),
  };
  const rockBandDistance = nearestFeatureDistance(worldPosition, profile, ['rock-band']);
  const vegetationOverlap = vegetationBoundsOverlap(worldPosition, rockRadiusMeters, vegetationCandidates);
  return evaluateRockEligibility({ finalSlope, ridge, curvature, rockiness, rockMaterial, rockBandDistance, riverDistance, riverHalfWidth, rockRadiusMeters, featureDistances, vegetationOverlap, field });
}

export async function createG6DRockCandidateId({ worldSeedHash, subtype, quantizedWorldCell, semanticSlot }) {
  if (typeof subtype !== 'string' || !subtype || typeof semanticSlot !== 'string' || !semanticSlot) throw new TypeError('invalid G6-D Rock semantic identity');
  return createDetailCandidateId({ worldSeedHash, generatorMajor: 6, candidateType: G6_D_ROCK.candidateType, quantizedWorldCell, semanticKey: `${subtype}:${semanticSlot}` });
}

export function selectRockSubtypeG6D({ eligibility, riverShoreDistance }) {
  const component = eligibility.components; const proposal = G6_D_ROCK.proposal;
  if (riverShoreDistance >= 0 && riverShoreDistance <= proposal.gravelShoreMaximumMeters && component.slope < 0.62 && component.ridge < 0.55) return 'gravel';
  const mediumSignals = Number(component.ridge >= proposal.mediumRidge) + Number(component.slope >= smooth((proposal.mediumSlope - G6_D_ROCK.terrain.slopeStart) / G6_D_ROCK.terrain.slopeBlend))
    + Number(component.rockiness >= proposal.mediumRockiness) + Number(component.rockMaterial >= proposal.mediumMaterial) + Number(component.rockBand >= 0.55);
  return mediumSignals >= 2 ? 'medium-rock' : 'small-stone';
}

export async function createRockCandidateG6D({ profile, worldSeedHash, quantizedWorldCell, point, terrain, macro, river, vegetationCandidates, sourceBiomeWeights = [], sourceFeatureIds = [] }) {
  const preliminary = await classifyRockTerrainContext({ profile, worldPosition: point, finalSlope: terrain.slope, ridge: macro.ridge, curvature: macro.curvature,
    rockiness: terrain.rockiness, rockMaterial: terrain.rockMaterial, rockRadiusMeters: G6_D_ROCK.candidateRadiusMeters['small-stone'],
    riverDistance: river?.distance ?? Infinity, riverHalfWidth: river?.width / 2 ?? 0, vegetationCandidates });
  if (!preliminary.eligible || preliminary.score < G6_D_ROCK.proposal.minimumScore) return null;
  const riverShoreDistance = river ? river.distance - river.width / 2 : Infinity; const subtype = selectRockSubtypeG6D({ eligibility: preliminary, riverShoreDistance }); const radius = G6_D_ROCK.candidateRadiusMeters[subtype];
  const eligibility = await classifyRockTerrainContext({ profile, worldPosition: point, finalSlope: terrain.slope, ridge: macro.ridge, curvature: macro.curvature,
    rockiness: terrain.rockiness, rockMaterial: terrain.rockMaterial, rockRadiusMeters: radius, riverDistance: river?.distance ?? Infinity, riverHalfWidth: river?.width / 2 ?? 0, vegetationCandidates });
  if (!eligibility.eligible || eligibility.score < G6_D_ROCK.proposal.minimumScore) return null;
  const random = createDeterministicRandom(profile.fieldSeed); const key = `${quantizedWorldCell.x}:${quantizedWorldCell.z}`;
  if (await random.float01(`occupancy:${key}`) >= eligibility.score * G6_D_ROCK.proposal.subtypeOccupancy[subtype] * G6_D_ROCK.proposal.occupancyScale) return null;
  const identity = await createG6DRockCandidateId({ worldSeedHash, subtype, quantizedWorldCell, semanticSlot: G6_D_ROCK.semanticSlot });
  const orientationSeed = q6(await random.float01(`orientation:${key}`)); const variationSeed = q6(await random.float01(`variation:${key}`));
  return { schemaVersion: 'detail-candidate-1', ...identity, candidateType: 'rock', subtype, worldPosition: { x: q6(point.x), y: q6(terrain.height), z: q6(point.z) },
    owningChunkCoordinate: null, sourceBiomeWeights, sourceFeatureIds: [...sourceFeatureIds].sort(), densityClass: eligibility.score >= 0.48 ? 'dense' : eligibility.score >= 0.25 ? 'moderate' : 'sparse',
    sizeClass: subtype === 'medium-rock' ? 'medium' : 'small', orientationSeed, variationSeed, eligibility: eligibility.score,
    metadata: { cellSizeMeters: G6_D_ROCK.cellSizeMeters, semanticSlot: G6_D_ROCK.semanticSlot, candidateRadiusMeters: radius, boundsType: 'horizontal-circle', slope: q6(terrain.slope),
      ridge: q6(macro.ridge), curvature: q6(macro.curvature), rockiness: q6(terrain.rockiness), rockMaterial: q6(terrain.rockMaterial), riverDistance: Number.isFinite(riverShoreDistance) ? q6(riverShoreDistance) : null,
      rockField: eligibility.components.cluster, rockStrata: eligibility.components.strata, category: 'rocks' } };
}
