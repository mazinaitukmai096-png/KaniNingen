const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export const W8_NATURAL_CANONICAL_VISIBILITY_METERS = Object.freeze({
  high: 56,
  medium: 48,
  low: 40,
});

function presentationClusterRoll(candidate) {
  const x = Math.floor((candidate?.worldPosition?.x ?? 0) / 12);
  const z = Math.floor((candidate?.worldPosition?.z ?? 0) / 12);
  let value = Math.imul(x ^ 0x51ed270b, 0x85ebca6b)
    ^ Math.imul(z ^ 0x68bc21eb, 0xc2b2ae35);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return (value >>> 0) / 0x1_0000_0000;
}

export function isW8NaturalCandidateVisible(candidate) {
  if (candidate?.candidateId === undefined) return true;
  const cluster = presentationClusterRoll(candidate);
  const clusteredThreshold = cluster < 0.28 ? 0.32 : cluster < 0.65 ? 0.58 : 0.78;
  const subtypeAdjustment = candidate.subtype === 'shrub' ? -0.08 : 0;
  return candidate.variationSeed >= clamp(
    clusteredThreshold + subtypeAdjustment,
    0.12,
    0.82,
  );
}
