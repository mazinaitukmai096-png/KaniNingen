export const SETTLEMENT_GENERATION_STAGES = Object.freeze([
  'roadGraph',
  'block',
  'lot',
  'building',
]);

const STAGE_SET = new Set(SETTLEMENT_GENERATION_STAGES);
const GENERATOR_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function requireStage(stage) {
  if (!STAGE_SET.has(stage)) throw new RangeError(`unsupported Settlement generation stage: ${stage}`);
  return stage;
}

function requireGeneratorId(generatorId) {
  if (typeof generatorId !== 'string' || !GENERATOR_ID_PATTERN.test(generatorId)) {
    throw new TypeError('Settlement stage generatorId must be a lower-case kebab-case key');
  }
  return generatorId;
}

export class SettlementStageGeneratorRegistry {
  #generators = new Map(SETTLEMENT_GENERATION_STAGES.map(stage => [stage, new Map()]));
  #frozen = false;

  register({ stage, generatorId, generate }) {
    if (this.#frozen) throw new Error('SettlementStageGeneratorRegistry is frozen');
    const normalizedStage = requireStage(stage);
    const normalizedId = requireGeneratorId(generatorId);
    if (typeof generate !== 'function') throw new TypeError('Settlement stage generate must be a function');
    const stageGenerators = this.#generators.get(normalizedStage);
    if (stageGenerators.has(normalizedId)) {
      throw new Error(`duplicate ${normalizedStage} Settlement stage generator: ${normalizedId}`);
    }
    const descriptor = Object.freeze({
      stage: normalizedStage,
      generatorId: normalizedId,
      generate,
    });
    stageGenerators.set(normalizedId, descriptor);
    return descriptor;
  }

  get(stage, generatorId) {
    return this.#generators.get(requireStage(stage))?.get(generatorId) ?? null;
  }

  list(stage) {
    return Object.freeze([...this.#generators.get(requireStage(stage)).values()]
      .sort((left, right) => left.generatorId.localeCompare(right.generatorId)));
  }

  freeze() {
    this.#frozen = true;
    return this;
  }

  get frozen() { return this.#frozen; }
}

export const createSettlementStageGeneratorRegistry = () => new SettlementStageGeneratorRegistry();
