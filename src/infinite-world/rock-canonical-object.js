// Phase 4A compatibility surface. The implementation now lives in the shared
// Phase 4B World Object canonical contract.
export {
  W8_FINITE_ROCK_PRESENTATION_METERS,
  W8_ROCK_CANONICAL_LOD_POLICY,
  resolveW8RockCandidateVisual,
  resolveW8RockCanonicalObject,
  resolveW8RockVisibilityMeters,
} from './world-object-canonical-contract.js';

export const W8_ROCK_CANONICAL_OBJECT_SCHEMA = 'w8-canonical-world-object-1';
