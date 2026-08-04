import { createMigratedSettlementTemplate } from './single-rural-settlement.js';
import {
  SETTLEMENT_GENERATOR_ADAPTER_SCHEMA,
  createSettlementGeneratorAdapterRegistry,
} from './settlement-generator-adapter-registry.js';

export const LEGACY_MIGRATED_SETTLEMENT_ADAPTER_ID = 'legacy-migrated-v1';

export const LEGACY_MIGRATED_SETTLEMENT_ADAPTER = Object.freeze({
  schemaVersion: SETTLEMENT_GENERATOR_ADAPTER_SCHEMA,
  adapterId: LEGACY_MIGRATED_SETTLEMENT_ADAPTER_ID,
  generate: createMigratedSettlementTemplate,
});

const productionRegistry = createSettlementGeneratorAdapterRegistry();
productionRegistry.register(LEGACY_MIGRATED_SETTLEMENT_ADAPTER);
productionRegistry.freeze();

export const PRODUCTION_SETTLEMENT_GENERATOR_ADAPTER_REGISTRY = productionRegistry;

export function createLegacyMigratedSettlementTemplate(input) {
  return PRODUCTION_SETTLEMENT_GENERATOR_ADAPTER_REGISTRY.generate(
    LEGACY_MIGRATED_SETTLEMENT_ADAPTER_ID,
    input,
  );
}
