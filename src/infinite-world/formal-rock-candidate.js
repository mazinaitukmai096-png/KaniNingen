import { createDeterministicRandom } from './legacy-core/g0/deterministic-random.js';
import {
  classifyRockTerrainContext,
  createG6DRockCandidateId,
  G6_D_ROCK,
  selectRockSubtypeG6D,
} from './legacy-core/g6/rock-redistribution.js';

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

// This non-legacy adapter preserves the protected G6-D result while allowing
// the Infinite World caller to reuse work and a deterministic occupancy roll.
export async function createFormalRockCandidate({
  profile,
  worldSeedHash,
  quantizedWorldCell,
  point,
  terrain,
  macro,
  river,
  vegetationCandidates,
  sourceBiomeWeights = [],
  sourceFeatureIds = [],
  occupancyRoll = null,
}) {
  const preliminaryRadius = G6_D_ROCK.candidateRadiusMeters['small-stone'];
  const preliminary = await classifyRockTerrainContext({
    profile,
    worldPosition: point,
    finalSlope: terrain.slope,
    ridge: macro.ridge,
    curvature: macro.curvature,
    rockiness: terrain.rockiness,
    rockMaterial: terrain.rockMaterial,
    rockRadiusMeters: preliminaryRadius,
    riverDistance: river?.distance ?? Infinity,
    riverHalfWidth: river?.width / 2 ?? 0,
    vegetationCandidates,
  });
  if (!preliminary.eligible || preliminary.score < G6_D_ROCK.proposal.minimumScore) return null;

  const riverShoreDistance = river ? river.distance - river.width / 2 : Infinity;
  const subtype = selectRockSubtypeG6D({ eligibility: preliminary, riverShoreDistance });
  const radius = G6_D_ROCK.candidateRadiusMeters[subtype];
  const eligibility = radius === preliminaryRadius ? preliminary : await classifyRockTerrainContext({
    profile,
    worldPosition: point,
    finalSlope: terrain.slope,
    ridge: macro.ridge,
    curvature: macro.curvature,
    rockiness: terrain.rockiness,
    rockMaterial: terrain.rockMaterial,
    rockRadiusMeters: radius,
    riverDistance: river?.distance ?? Infinity,
    riverHalfWidth: river?.width / 2 ?? 0,
    vegetationCandidates,
  });
  if (!eligibility.eligible || eligibility.score < G6_D_ROCK.proposal.minimumScore) return null;

  const random = createDeterministicRandom(profile.fieldSeed);
  const key = `${quantizedWorldCell.x}:${quantizedWorldCell.z}`;
  const resolvedOccupancyRoll = occupancyRoll === null
    ? await random.float01(`occupancy:${key}`)
    : occupancyRoll;
  if (!Number.isFinite(resolvedOccupancyRoll)
    || resolvedOccupancyRoll < 0 || resolvedOccupancyRoll >= 1) {
    throw new RangeError('Rock occupancyRoll must be in [0, 1)');
  }
  if (resolvedOccupancyRoll >= eligibility.score
    * G6_D_ROCK.proposal.subtypeOccupancy[subtype]
    * G6_D_ROCK.proposal.occupancyScale) return null;

  const identity = await createG6DRockCandidateId({
    worldSeedHash,
    subtype,
    quantizedWorldCell,
    semanticSlot: G6_D_ROCK.semanticSlot,
  });
  const orientationSeed = q6(await random.float01(`orientation:${key}`));
  const variationSeed = q6(await random.float01(`variation:${key}`));
  return {
    schemaVersion: 'detail-candidate-1',
    ...identity,
    candidateType: 'rock',
    subtype,
    worldPosition: { x: q6(point.x), y: q6(terrain.height), z: q6(point.z) },
    owningChunkCoordinate: null,
    sourceBiomeWeights,
    sourceFeatureIds: [...sourceFeatureIds].sort(),
    densityClass: eligibility.score >= 0.48
      ? 'dense' : eligibility.score >= 0.25 ? 'moderate' : 'sparse',
    sizeClass: subtype === 'medium-rock' ? 'medium' : 'small',
    orientationSeed,
    variationSeed,
    eligibility: eligibility.score,
    metadata: {
      cellSizeMeters: G6_D_ROCK.cellSizeMeters,
      semanticSlot: G6_D_ROCK.semanticSlot,
      candidateRadiusMeters: radius,
      boundsType: 'horizontal-circle',
      slope: q6(terrain.slope),
      ridge: q6(macro.ridge),
      curvature: q6(macro.curvature),
      rockiness: q6(terrain.rockiness),
      rockMaterial: q6(terrain.rockMaterial),
      riverDistance: Number.isFinite(riverShoreDistance) ? q6(riverShoreDistance) : null,
      rockField: eligibility.components.cluster,
      rockStrata: eligibility.components.strata,
      category: 'rocks',
    },
  };
}
