import { deriveLocalSeed64 } from './legacy-core/g0/deterministic-random.js';
import {
  W8_PRESENTATION_DISTANCE_KINDS,
  W8_RENDER_DISTANCE_PRESET_IDS,
  resolveW8PresentationDistanceProfile,
} from './render-distance-policy.js';
import { resolveW8CanonicalFarTreeDensityRank } from './vegetation-lod-policy.js';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const smoothstep = value => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

export const W8_NATURAL_PRESENTATION_PHASE_1 = Object.freeze({
  // Keep the original field seed so this revision changes density deliberately
  // without randomly relocating every grove/open-land feature in the world.
  schemaVersion: 'w8-natural-presentation-phase-3',
  fieldSeedVersion: 'w8-natural-presentation-phase-1',
  macroFieldSpacingMeters: 96,
  groveFieldSpacingMeters: 32,
  spawnFeatherMeters: 18,
  spawnHardClearanceMeters: 12,
  settlementDensity: Object.freeze({
    coreMaximumRadiusScale: 0.70,
    innerFeatherMaximumRadiusScale: 1.00,
    outerFeatherStartRadiusScale: 1.35,
    fullRecoveryRadiusScale: 1.80,
    coreFactor: 0.12,
    innerFactor: 0.24,
    outerFactor: 0.55,
  }),
  treeHabitat: Object.freeze({
    macroFieldWeight: 0.25,
    groveFieldWeight: 0.35,
    minimumAcceptance: 0.18,
    maximumAcceptance: 0.88,
    contrastStart: 0.14,
    contrastWidth: 0.30,
  }),
});

// This is observer-independent world-generation membership, not a
// distance-dependent presentation threshold. Every canonical Natural producer
// applies the same Stable-ID rank, so the selected half remains immutable across
// Near, Mid, and Far while avoiding submission of the former full Tree set.
export const W8_CANONICAL_TREE_WORLD_DENSITY_THRESHOLD = 0.5;

export const W8_NATURAL_CANONICAL_VISIBILITY_METERS = Object.freeze(Object.fromEntries(
  Object.values(W8_RENDER_DISTANCE_PRESET_IDS).map(renderDistancePreset => [
    renderDistancePreset,
    resolveW8PresentationDistanceProfile(
      W8_PRESENTATION_DISTANCE_KINDS.NATURAL,
      renderDistancePreset,
    ).visibilityMeters,
  ]),
));

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
  const density = W8_NATURAL_PRESENTATION_PHASE_1.settlementDensity;
  let factor = 1;
  for (const reference of settlementReferences ?? []) {
    const radius = reference?.radiusMeters;
    if (!Number.isFinite(radius) || radius <= 0) continue;
    const q = Math.hypot(point.x - reference.center.x, point.z - reference.center.z) / radius;
    let candidateFactor = 1;
    if (q <= density.coreMaximumRadiusScale) {
      candidateFactor = density.coreFactor;
    } else if (q < density.innerFeatherMaximumRadiusScale) {
      candidateFactor = density.coreFactor
        + (density.innerFactor - density.coreFactor) * smoothstep(
          (q - density.coreMaximumRadiusScale)
            / (density.innerFeatherMaximumRadiusScale - density.coreMaximumRadiusScale),
        );
    } else if (q < density.outerFeatherStartRadiusScale) {
      candidateFactor = density.innerFactor
        + (density.outerFactor - density.innerFactor) * smoothstep(
          (q - density.innerFeatherMaximumRadiusScale)
            / (density.outerFeatherStartRadiusScale - density.innerFeatherMaximumRadiusScale),
        );
    } else if (q < density.fullRecoveryRadiusScale) {
      candidateFactor = density.outerFactor
        + (1 - density.outerFactor) * smoothstep(
          (q - density.outerFeatherStartRadiusScale)
            / (density.fullRecoveryRadiusScale - density.outerFeatherStartRadiusScale),
        );
    }
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
    semanticKey: W8_NATURAL_PRESENTATION_PHASE_1.fieldSeedVersion,
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
    const habitat = W8_NATURAL_PRESENTATION_PHASE_1.treeHabitat;
    const habitatScore = clamp(
      biomeWeight(candidate, 'mixed-woodland') * 0.5
        + biomeWeight(candidate, 'wetland') * 0.2
        + biomeWeight(candidate, 'temperate-grassland') * 0.1
        - biomeWeight(candidate, 'rocky-highland') * 0.3
        + moisture * 0.15
        - slope * 0.25
        - rockiness * 0.2
        + (macroField - 0.5) * habitat.macroFieldWeight
        + (groveField - 0.5) * habitat.groveFieldWeight,
      0,
      1,
    );
    // The former 0.44 floor made almost every 64 m cell moderately wooded.
    // Keep dense habitat capable of supporting a forest, but lower the floor
    // and steepen the continuous response so the same world-fixed fields can
    // produce broad, genuinely open land without distance-based Tree popping.
    const baseAcceptance = habitat.minimumAcceptance
      + (habitat.maximumAcceptance - habitat.minimumAcceptance) * smoothstep(
        (habitatScore - habitat.contrastStart) / habitat.contrastWidth,
      );
    const settlementFactor = evaluateW8SettlementDensityFactor(settlementReferences, point);
    const spawnFactor = evaluateW8SpawnDensityFactor({
      candidate,
      experienceSpawn,
      introDistanceMeters,
    });
    const acceptance = baseAcceptance * settlementFactor * spawnFactor;
    const rank = hashText(rankSeed, candidate.candidateId ?? candidate.stableId ?? '') / 0xffffffff;
    const densityRank = resolveW8CanonicalFarTreeDensityRank(
      candidate.candidateId ?? candidate.stableId ?? '',
    );
    return Object.freeze({
      macroField,
      groveField,
      habitatScore,
      baseAcceptance,
      settlementFactor,
      spawnFactor,
      acceptance,
      rank,
      densityRank,
      accepted: rank < acceptance
        && densityRank < W8_CANONICAL_TREE_WORLD_DENSITY_THRESHOLD,
    });
  };

  return Object.freeze({
    schemaVersion: W8_NATURAL_PRESENTATION_PHASE_1.schemaVersion,
    evaluateTree,
    selectVegetation({ candidates, settlementReferences, experienceSpawn, introDistanceMeters }) {
      // Formal shrub proposals are generation-only reservations. The actual
      // Bush world decoration is the ambient-detail path, matching the finite
      // game: non-colliding, non-destructible, and Near-only.
      return Object.freeze((candidates ?? []).filter(candidate => (
        candidate?.subtype !== 'shrub'
        && evaluateTree({
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
