export const SETTLEMENT_GENERATOR_ADAPTER_SCHEMA = 'settlement-generator-adapter-1';

const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function validateAdapter(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Settlement generator adapter must be an object');
  }
  if (input.schemaVersion !== SETTLEMENT_GENERATOR_ADAPTER_SCHEMA) {
    throw new TypeError(`adapter.schemaVersion must be ${SETTLEMENT_GENERATOR_ADAPTER_SCHEMA}`);
  }
  if (typeof input.adapterId !== 'string' || !ADAPTER_ID_PATTERN.test(input.adapterId)) {
    throw new TypeError('adapterId must be a lower-case kebab-case key');
  }
  if (typeof input.generate !== 'function') throw new TypeError('adapter.generate must be a function');
  return Object.freeze({
    schemaVersion: SETTLEMENT_GENERATOR_ADAPTER_SCHEMA,
    adapterId: input.adapterId,
    generate: input.generate,
  });
}

export class SettlementGeneratorAdapterRegistry {
  #adapters = new Map();
  #frozen = false;

  register(input) {
    if (this.#frozen) throw new Error('SettlementGeneratorAdapterRegistry is frozen');
    const adapter = validateAdapter(input);
    if (this.#adapters.has(adapter.adapterId)) {
      throw new Error(`duplicate Settlement generator adapter: ${adapter.adapterId}`);
    }
    this.#adapters.set(adapter.adapterId, adapter);
    return adapter;
  }

  get(adapterId) {
    return this.#adapters.get(adapterId) ?? null;
  }

  async generate(adapterId, input) {
    const adapter = this.get(adapterId);
    if (!adapter) throw new RangeError(`unknown Settlement generator adapter: ${adapterId}`);
    return adapter.generate(input);
  }

  list() {
    return Object.freeze([...this.#adapters.values()]
      .sort((left, right) => left.adapterId.localeCompare(right.adapterId)));
  }

  freeze() {
    this.#frozen = true;
    return this;
  }

  get frozen() { return this.#frozen; }
}

export const createSettlementGeneratorAdapterRegistry = () => (
  new SettlementGeneratorAdapterRegistry()
);
