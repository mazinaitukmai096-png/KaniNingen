import { createWorldStreamingPlan } from './world-streaming-plan.js';

export const WORLD_STREAMING_COORDINATOR_MODE = Object.freeze({ SHADOW: 'shadow' });
const PLAN_DURATION_SAMPLE_CAPACITY = 256;

const defaultClock = () => globalThis.performance?.now?.() ?? Date.now();

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function normalizeObservedKeys(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  return Object.freeze([...new Set(values)].sort());
}

function compareKeys(planned, observed) {
  const plannedSet = new Set(planned);
  const observedSet = new Set(observed);
  const missingFromPlan = observed.filter(key => !plannedSet.has(key));
  const shadowOnly = planned.filter(key => !observedSet.has(key));
  return Object.freeze({
    matches: missingFromPlan.length === 0 && shadowOnly.length === 0,
    plannedCount: planned.length,
    observedCount: observed.length,
    missingFromPlan: Object.freeze(missingFromPlan),
    shadowOnly: Object.freeze(shadowOnly),
  });
}

function compareCurrentRequests(plan, currentRequests = {}) {
  const comparisons = plan.policyPlans.map(policyPlan => {
    const observed = currentRequests[policyPlan.kind];
    if (!observed) {
      return Object.freeze({
        kind: policyPlan.kind,
        observed: false,
        matches: null,
        required: null,
        requested: null,
        retained: null,
      });
    }
    const required = compareKeys(
      policyPlan.requiredOwnerKeys,
      normalizeObservedKeys(observed.requiredOwnerKeys ?? [], `${policyPlan.kind}.required`),
    );
    const requested = compareKeys(
      policyPlan.requestOwnerKeys,
      normalizeObservedKeys(observed.requestOwnerKeys ?? [], `${policyPlan.kind}.requested`),
    );
    const retained = compareKeys(
      policyPlan.retainedOwnerKeys,
      normalizeObservedKeys(observed.retainedOwnerKeys ?? [], `${policyPlan.kind}.retained`),
    );
    return Object.freeze({
      kind: policyPlan.kind,
      observed: true,
      matches: required.matches && requested.matches && retained.matches,
      required,
      requested,
      retained,
    });
  });
  const observedComparisons = comparisons.filter(value => value.observed);
  return Object.freeze({
    schemaVersion: 'world-streaming-shadow-comparison-1',
    matches: observedComparisons.length > 0
      && observedComparisons.every(value => value.matches),
    observedPolicyCount: observedComparisons.length,
    policies: Object.freeze(comparisons),
  });
}

export function createWorldStreamingCoordinator({ registry, clock = defaultClock } = {}) {
  if (!registry?.frozen || typeof registry.list !== 'function') {
    throw new TypeError('World Streaming Coordinator requires a frozen policy registry');
  }
  if (typeof clock !== 'function') throw new TypeError('Coordinator clock must be a function');
  let sequence = 0;
  let latestPlan = null;
  let latestComparison = null;
  let lastPlanDurationMs = 0;
  let maximumPlanDurationMs = 0;
  const planDurationSamples = [];
  return Object.freeze({
    mode: WORLD_STREAMING_COORDINATOR_MODE.SHADOW,
    createShadowPlan(input = {}) {
      const startedAt = clock();
      const generatedAtMs = input.generatedAtMs ?? startedAt;
      const plan = createWorldStreamingPlan({
        ...input,
        sequence: ++sequence,
        generatedAtMs,
        policies: registry.list(),
      });
      latestPlan = plan;
      latestComparison = compareCurrentRequests(plan, input.currentRequests);
      lastPlanDurationMs = Math.max(0, clock() - startedAt);
      maximumPlanDurationMs = Math.max(maximumPlanDurationMs, lastPlanDurationMs);
      planDurationSamples.push(lastPlanDurationMs);
      if (planDurationSamples.length > PLAN_DURATION_SAMPLE_CAPACITY) {
        planDurationSamples.shift();
      }
      return plan;
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: 'world-streaming-coordinator-snapshot-1',
        mode: WORLD_STREAMING_COORDINATOR_MODE.SHADOW,
        planCount: sequence,
        latestPlan,
        latestComparison,
        policyRegistry: registry.snapshot(),
        performance: Object.freeze({
          sampleCapacity: PLAN_DURATION_SAMPLE_CAPACITY,
          sampleCount: planDurationSamples.length,
          lastPlanDurationMs,
          p95PlanDurationMs: percentile(planDurationSamples, 0.95),
          maximumPlanDurationMs,
        }),
        ownership: Object.freeze({
          mesh: false,
          material: false,
          gameplay: false,
          worker: false,
          renderRoot: false,
        }),
      });
    },
  });
}
