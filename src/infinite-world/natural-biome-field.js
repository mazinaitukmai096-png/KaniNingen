import { deriveLocalSeed64 } from './legacy-core/g0/deterministic-random.js';

export const NATURAL_BIOME_ORDER = Object.freeze([
  'temperate-grassland',
  'mixed-woodland',
  'wetland',
  'rocky-highland',
]);

export const NATURAL_BIOME_DEFINITIONS = Object.freeze({
  'temperate-grassland': Object.freeze({
    category: 'natural-open-land',
    materialWeights: Object.freeze([0.72, 0.18, 0.06, 0.01, 0.03]),
    displayColor: Object.freeze([0.36, 0.55, 0.24]),
  }),
  'mixed-woodland': Object.freeze({
    category: 'natural-woodland',
    materialWeights: Object.freeze([0.58, 0.24, 0.1, 0.01, 0.07]),
    displayColor: Object.freeze([0.18, 0.39, 0.2]),
  }),
  wetland: Object.freeze({
    category: 'natural-wet-lowland',
    materialWeights: Object.freeze([0.32, 0.05, 0.48, 0.12, 0.03]),
    displayColor: Object.freeze([0.28, 0.44, 0.3]),
  }),
  'rocky-highland': Object.freeze({
    category: 'natural-highland',
    materialWeights: Object.freeze([0.2, 0.22, 0.08, 0.02, 0.48]),
    displayColor: Object.freeze([0.43, 0.44, 0.39]),
  }),
});

const q6 = value => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };

function mix32(value) {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  result ^= result >>> 16;
  return result >>> 0;
}

function seed32(seed64, salt) {
  return mix32((Number.parseInt(seed64.slice(0, 8), 16)
    ^ Number.parseInt(seed64.slice(8), 16) ^ salt) >>> 0);
}

function foldInteger(value) {
  if (!Number.isSafeInteger(value)) throw new RangeError('climate lattice coordinate must be a safe integer');
  if (value >= -0x80000000 && value <= 0x7fffffff) return value >>> 0;
  return mix32((value >>> 0) ^ mix32(Math.trunc(value / 0x100000000) >>> 0));
}

function lattice(seed, x, z) {
  return mix32(seed ^ Math.imul(foldInteger(x), 0x1f123bb5)
    ^ Math.imul(foldInteger(z), 0x5f356495)) / 0xffffffff;
}

function valueNoise(seed, x, z, spacing) {
  const gx = Math.floor(x / spacing);
  const gz = Math.floor(z / spacing);
  const tx = smooth(x / spacing - gx);
  const tz = smooth(z / spacing - gz);
  const a = lattice(seed, gx, gz);
  const b = lattice(seed, gx + 1, gz);
  const c = lattice(seed, gx, gz + 1);
  const d = lattice(seed, gx + 1, gz + 1);
  return ((a * (1 - tx) + b * tx) * (1 - tz)
    + (c * (1 - tx) + d * tx) * tz) * 2 - 1;
}

function fractal(seed, x, z, spacing, octaves) {
  let total = 0;
  let weight = 1;
  let weights = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += valueNoise(mix32(seed + octave * 0x9e3779b9), x, z, spacing / 2 ** octave) * weight;
    weights += weight;
    weight *= 0.5;
  }
  return total / weights;
}

function normalizeMemberships(raw) {
  const safe = NATURAL_BIOME_ORDER.map(biomeId => Math.max(0.000001, raw[biomeId] ?? 0));
  const total = safe.reduce((sum, value) => sum + value, 0);
  const memberships = NATURAL_BIOME_ORDER.map((biomeId, index) => ({
    biomeId,
    weight: q6(safe[index] / total),
  }));
  const drift = q6(1 - memberships.reduce((sum, item) => sum + item.weight, 0));
  const largestIndex = memberships.reduce((best, item, index) => (
    item.weight > memberships[best].weight ? index : best
  ), 0);
  memberships[largestIndex].weight = q6(memberships[largestIndex].weight + drift);
  memberships.sort((a, b) => b.weight - a.weight
    || (a.biomeId < b.biomeId ? -1 : a.biomeId > b.biomeId ? 1 : 0));
  return memberships;
}

export async function createNaturalBiomeEvaluator({ worldSeedHash }) {
  const seed64 = await deriveLocalSeed64({
    worldSeedHash,
    namespace: 'w2-natural-biome-climate',
    semanticKey: 'natural-biome-field-1',
  });
  const seeds = Object.freeze({
    temperature: seed32(seed64, 11),
    moisture: seed32(seed64, 23),
    forest: seed32(seed64, 37),
  });

  const evaluateMoisture = position => {
      if (![position?.x, position?.z].every(Number.isFinite)) {
        throw new TypeError('finite biome position is required');
      }
      return q6(clamp(0.5 + fractal(
        seeds.moisture,
        position.x,
        position.z,
        768,
        3,
      ) * 0.48));
  };
  const evaluateWithMoisture = (position, macroSample, slope, moisture) => {
      const temperature = q6(clamp(0.5 + fractal(seeds.temperature, position.x, position.z, 1536, 3) * 0.42));
      const forestPatch = q6(clamp(0.5 + fractal(seeds.forest, position.x, position.z, 224, 2) * 0.5));
      const elevationMeters = 0.4 + macroSample.offsetMm * 0.001;
      const ridge = clamp(macroSample.components.ridgesMm / 1450);
      const valley = clamp(-macroSample.components.valleysMm / 820);
      const high = smooth((elevationMeters - 0.85) / 2.1);
      const steep = smooth((slope - 0.025) / 0.16);
      const wet = smooth((moisture - 0.58) / 0.3);
      const mild = 1 - Math.abs(temperature - 0.52);
      const memberships = normalizeMemberships({
        'temperate-grassland': 0.28 + mild * 0.72 + (1 - wet) * 0.32 + (1 - forestPatch) * 0.35 - steep * 0.42,
        'mixed-woodland': 0.16 + moisture * 0.58 + forestPatch * 0.92 + mild * 0.28 - steep * 0.3,
        wetland: 0.05 + wet * 1.45 + valley * 0.68 - high * 0.72 - steep * 0.42,
        'rocky-highland': 0.04 + high * 1.15 + steep * 1.22 + ridge * 0.62 + (1 - moisture) * 0.18,
      });
      return Object.freeze({
        memberships: Object.freeze(memberships.map(Object.freeze)),
        primaryBiomeId: memberships[0].biomeId,
        climate: Object.freeze({ temperature, moisture, forestPatch }),
      });
  };
  return Object.freeze({
    evaluateMoisture,
    evaluateWithMoisture,
    evaluate(position, macroSample, slope) {
      return evaluateWithMoisture(
        position,
        macroSample,
        slope,
        evaluateMoisture(position),
      );
    },
  });
}

export function naturalMaterialWeights(memberships, moisture, rockiness, slope) {
  const values = [0, 0, 0, 0, 0];
  for (const membership of memberships) {
    const profile = NATURAL_BIOME_DEFINITIONS[membership.biomeId];
    profile.materialWeights.forEach((weight, index) => { values[index] += weight * membership.weight; });
  }
  const steep = smooth((slope - 0.035) / 0.2);
  values[0] *= 1 - steep * 0.78;
  values[1] += (1 - moisture) * 0.12;
  values[2] += moisture * 0.18;
  values[3] += Math.max(0, moisture - 0.78) * 0.08;
  values[4] += rockiness * 0.55 + steep * 0.35;
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  const normalized = values.map(value => q6(Math.max(0, value) / total));
  const drift = q6(1 - normalized.reduce((sum, value) => sum + value, 0));
  const largest = normalized.reduce((best, value, index) => value > normalized[best] ? index : best, 0);
  normalized[largest] = q6(normalized[largest] + drift);
  return normalized;
}

export function summarizeNaturalBiomeSamples(samples, resolution) {
  const totals = Object.fromEntries(NATURAL_BIOME_ORDER.map(biomeId => [biomeId, 0]));
  const climate = { temperature: 0, moisture: 0, forestPatch: 0 };
  for (const sample of samples) {
    for (const membership of sample.memberships) totals[membership.biomeId] += membership.weight / samples.length;
    for (const key of Object.keys(climate)) climate[key] += sample.climate[key] / samples.length;
  }
  const averageMemberships = normalizeMemberships(totals);
  return Object.freeze({
    schemaVersion: 'w2-natural-biome-field-1',
    resolution: Object.freeze({ x: resolution, z: resolution }),
    biomeOrder: NATURAL_BIOME_ORDER,
    samples: Object.freeze(samples),
    averageMemberships: Object.freeze(averageMemberships.map(Object.freeze)),
    primaryBiomeId: averageMemberships[0].biomeId,
    climateSummary: Object.freeze(Object.fromEntries(
      Object.entries(climate).map(([key, value]) => [key, q6(value)]),
    )),
  });
}
