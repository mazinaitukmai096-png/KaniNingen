import { deriveLocalSeed64 } from './legacy-core/g0/deterministic-random.js';
import { W8_RENDER_DISTANCE_PRESETS } from './render-distance-policy.js';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const smoothstep = value => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

export const W8_NATURAL_PRESENTATION_PHASE_1 = Object.freeze({
  schemaVersion: 'w8-natural-presentation-phase-1',
  macroFieldSpacingMeters: 96,
  groveFieldSpacingMeters: 32,
  spawnFeatherMeters: 18,
  spawnHardClearanceMeters: 12,
});

export const W8_NATURAL_CANONICAL_VISIBILITY_METERS = Object.freeze({
  short: W8_RENDER_DISTANCE_PRESETS.short.naturalVisibilityMeters,
  standard: W8_RENDER_DISTANCE_PRESETS.standard.naturalVisibilityMeters,
  current: W8_RENDER_DISTANCE_PRESETS.current.naturalVisibilityMeters,
});

function mix32(value) {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  result ^= result >>> 16;
  return result >>> 0;
}

function foldInteger(value) {
  if (!Number.isSafeInteger(value)) throw new RangeError('natural presentation coordinate must be safe');
  if (value >= -0x80000000 && value <= 0x7fffffff) return value >>> 0;
  return mix32((value >>> 0) ^ mix32(Math.trunc(value / 0x100000000) >>> 0));
}

function seed32(seed64, salt) {
  return mix32((Number.parseInt(seed64.slice(0, 8), 16)
    ^ Number.parseInt(seed64.slice(8), 16) ^ salt) >>> 0);
}

function hashText(seed, text) {
  let value = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x9e3779b1) >>> 0;
    value ^= value >>> 13;
  }
  return mix32(value);
}

function lattice(seed, x, z) {
  return mix32(seed ^ Math.imul(foldInteger(x), 0x1f123bb5)
    ^ Math.imul(foldInteger(z), 0x5f356495)) / 0xffffffff;
}

function worldValueNoise(seed, worldX, worldZ, spacingMeters) {
  const gridX = Math.floor(worldX / spacingMeters);
  const gridZ = Math.floor(worldZ / spacingMeters);
  const tx = smoothstep(worldX / spacingMeters - gridX);
  const tz = smoothstep(worldZ / spacingMeters - gridZ);
  const a = lattice(seed, gridX, gridZ);
  const b = lattice(seed, gridX + 1, gridZ);
  const c = lattice(seed, gridX, gridZ + 1);
  const d = lattice(seed, gridX + 1, gridZ + 1);
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

function biomeWeight(candidate, biomeId) {
  return candidate?.sourceBiomeWeights?.find(weight => weight.biomeId === biomeId)?.weight ?? 0;
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared <= 1e-12 ? 0 : clamp(
    ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared,
    0,
    1,
  );
  return Math.hypot(point.x - start.x - dx * t, point.z - start.z - dz * t);
}

export function evaluateW8SettlementDensityFactor(settlementReferences, point) {
  let factor = 1;
  for (const reference of settlementReferences ?? []) {
    const radius = reference?.radiusMeters;
    if (!Number.isFinite(radius) || radius <= 0) continue;
    const q = Math.hypot(point.x - reference.center.x, point.z - reference.center.z) / radius;
    let candidateFactor = 1;
    if (q <= 0.65) candidateFactor = 0.18;
    else if (q < 0.8) candidateFactor = 0.18 + (0.28 - 0.18) * smoothstep((q - 0.65) / 0.15);
    else if (q < 1) candidateFactor = 0.28 + (0.72 - 0.28) * smoothstep((q - 0.8) / 0.2);
    else if (q < 1.25) candidateFactor = 0.72 + (1 - 0.72) * smoothstep((q - 1) / 0.25);
    factor = Math.min(factor, candidateFactor);
  }
  return factor;
}

export function evaluateW8SpawnDensityFactor({
  candidate,
  experienceSpawn,
  introDistanceMeters,
}) {
  if (!experienceSpawn) return 1;
  const radius = candidate?.metadata?.candidateRadiusMeters ?? 0.625;
  const end = {
    x: experienceSpawn.x + Math.sin(experienceSpawn.facingY) * introDistanceMeters,
    z: experienceSpawn.z + Math.cos(experienceSpawn.facingY) * introDistanceMeters,
  };
  const signedDistance = distanceToSegment(candidate.worldPosition, experienceSpawn, end)
    - (radius + W8_NATURAL_PRESENTATION_PHASE_1.spawnHardClearanceMeters);
  return smoothstep(signedDistance / W8_NATURAL_PRESENTATION_PHASE_1.spawnFeatherMeters);
}

export async function createW8NaturalPresentationPhase1Policy({ worldSeedHash }) {
  const seed64 = await deriveLocalSeed64({
    worldSeedHash,
    namespace: 'w8-natural-presentation-phase-1',
    semanticKey: W8_NATURAL_PRESENTATION_PHASE_1.schemaVersion,
  });
  const macroSeed = seed32(seed64, 0x51ed270b);
  const groveSeed = seed32(seed64, 0x68bc21eb);
  const rankSeed = seed32(seed64, 0x85ebca6b);

  const evaluateTree = ({
    candidate,
    settlementReferences = [],
    experienceSpawn = null,
    introDistanceMeters,
  }) => {
    const point = candidate?.worldPosition;
    if (!point || candidate?.subtype === 'shrub') return Object.freeze({ accepted: false });
    const macroField = worldValueNoise(
      macroSeed,
      point.x,
      point.z,
      W8_NATURAL_PRESENTATION_PHASE_1.macroFieldSpacingMeters,
    );
    const groveField = worldValueNoise(
      groveSeed,
      point.x,
      point.z,
      W8_NATURAL_PRESENTATION_PHASE_1.groveFieldSpacingMeters,
    );
    const slope = clamp((candidate.metadata?.slope ?? 0) / 0.18, 0, 1);
    const moisture = clamp(candidate.metadata?.moisture ?? 0, 0, 1);
    const rockiness = clamp(candidate.metadata?.rockiness ?? 0, 0, 1);
    const habitatScore = clamp(
      biomeWeight(candidate, 'mixed-woodland') * 0.5
        + biomeWeight(candidate, 'wetland') * 0.2
        + biomeWeight(candidate, 'temperate-grassland') * 0.1
        - biomeWeight(candidate, 'rocky-highland') * 0.3
        + moisture * 0.15
        - slope * 0.25
        - rockiness * 0.2
        + (macroField - 0.5) * 0.25
        + (groveField - 0.5) * 0.35,
      0,
      1,
    );
    // Phase 1 works only from the legacy-visible Tree subset.  Preserve enough
    // baseline acceptance for meadow candidates, then let the two continuous
    // fields create the grove/open-land contrast instead of emptying a whole
    // Settlement neighborhood.
    const baseAcceptance = 0.44 + 0.36 * smoothstep((habitatScore - 0.12) / 0.36);
    const settlementFactor = evaluateW8SettlementDensityFactor(settlementReferences, point);
    const spawnFactor = evaluateW8SpawnDensityFactor({
      candidate,
      experienceSpawn,
      introDistanceMeters,
    });
    const acceptance = baseAcceptance * settlementFactor * spawnFactor;
    const rank = hashText(rankSeed, candidate.candidateId ?? candidate.stableId ?? '') / 0xffffffff;
    return Object.freeze({
      macroField,
      groveField,
      habitatScore,
      baseAcceptance,
      settlementFactor,
      spawnFactor,
      acceptance,
      rank,
      accepted: rank < acceptance,
    });
  };

  return Object.freeze({
    schemaVersion: W8_NATURAL_PRESENTATION_PHASE_1.schemaVersion,
    evaluateTree,
    selectVegetation({ candidates, settlementReferences, experienceSpawn, introDistanceMeters }) {
      return Object.freeze((candidates ?? []).filter(candidate => (
        candidate?.subtype === 'shrub'
          || evaluateTree({
            candidate,
            settlementReferences,
            experienceSpawn,
            introDistanceMeters,
          }).accepted
      )));
    },
  });
}

export function isW8NaturalCandidateVisible() {
  // Stage 3B: the former 12m quantized cluster threshold was a presentation-only
  // filter that made density appear to reset at Chunk-like intervals.  Candidate
  // admission now remains with the existing continuous 96m/32m Phase 1 fields.
  return true;
}
