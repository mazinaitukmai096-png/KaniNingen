import { createWorldStreamingPlan } from './world-streaming-plan.js';
import {
  NATURAL_COVERAGE_KEY_SCHEMA,
  WORLD_STREAMING_PUBLICATION_CONTEXT_SCHEMA,
  createWorldStreamingPublicationContext,
  sameNaturalCoverageKey,
} from './natural-streaming-coverage.js';

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
  const matches = planned.length === observed.length
    && planned.every((key, index) => key === observed[index]);
  const plannedSet = matches ? null : new Set(planned);
  const observedSet = matches ? null : new Set(observed);
  const missingFromPlan = matches ? [] : observed.filter(key => !plannedSet.has(key));
  const shadowOnly = matches ? [] : planned.filter(key => !observedSet.has(key));
  return Object.freeze({
    matches: matches || (missingFromPlan.length === 0 && shadowOnly.length === 0),
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
    const sharedSnapshotIdentity = policyPlan.sourceSnapshot !== null
      && observed.sourceSnapshot === policyPlan.sourceSnapshot;
    const observedKeys = (values, label) => sharedSnapshotIdentity
      ? values : normalizeObservedKeys(values, label);
    const required = compareKeys(
      policyPlan.requiredOwnerKeys,
      observedKeys(observed.requiredOwnerKeys ?? [], `${policyPlan.kind}.required`),
    );
    const requested = compareKeys(
      policyPlan.requestOwnerKeys,
      observedKeys(observed.requestOwnerKeys ?? [], `${policyPlan.kind}.requested`),
    );
    const retained = compareKeys(
      policyPlan.retainedOwnerKeys,
      observedKeys(observed.retainedOwnerKeys ?? [], `${policyPlan.kind}.retained`),
    );
    return Object.freeze({
      kind: policyPlan.kind,
      observed: true,
      sharedSnapshotIdentity,
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
  let publicationSequence = 0;
  let latestPlan = null;
  let latestCoverageKey = null;
  let latestPublicationContext = null;
  let latestComparison = null;
  let lastPlanDurationMs = 0;
  let maximumPlanDurationMs = 0;
  const planDurationSamples = [];
  const counts = {
    coveragePlanBuilds: 0,
    coveragePlanReuses: 0,
    coverageInvalidations: 0,
    coverageBuildFailures: 0,
    corruptCacheFallbacks: 0,
    publicationContextUpdates: 0,
  };
  const commitPlan = (plan, comparison, durationMs, coverageKey = null) => {
    sequence = plan.sequence;
    latestPlan = plan;
    latestCoverageKey = coverageKey;
    latestComparison = comparison;
    lastPlanDurationMs = durationMs;
    maximumPlanDurationMs = Math.max(maximumPlanDurationMs, lastPlanDurationMs);
    planDurationSamples.push(lastPlanDurationMs);
    if (planDurationSamples.length > PLAN_DURATION_SAMPLE_CAPACITY) {
      planDurationSamples.shift();
    }
  };
  const buildPlan = (input, coverageKey = null) => {
    const startedAt = clock();
    const generatedAtMs = input.generatedAtMs ?? startedAt;
    const candidateSequence = sequence + 1;
    const plan = createWorldStreamingPlan({
      ...input,
      sequence: candidateSequence,
      generatedAtMs,
      policies: registry.list(),
    });
    const comparison = compareCurrentRequests(plan, input.currentRequests);
    commitPlan(plan, comparison, Math.max(0, clock() - startedAt), coverageKey);
    return plan;
  };
  return Object.freeze({
    mode: WORLD_STREAMING_COORDINATOR_MODE.SHADOW,
    createShadowPlan(input = {}) {
      return buildPlan(input);
    },
    createPublicationContext(input = {}) {
      const context = createWorldStreamingPublicationContext({
        ...input,
        sequence: ++publicationSequence,
        generatedAtMs: input.generatedAtMs ?? clock(),
      });
      latestPublicationContext = context;
      counts.publicationContextUpdates += 1;
      return context;
    },
    resolveCoveragePlan({
      coverageKey,
      publicationContext,
      createPlanInput = null,
      ...input
    } = {}) {
      if (coverageKey?.schemaVersion !== NATURAL_COVERAGE_KEY_SCHEMA) {
        throw new TypeError(`coverageKey must be ${NATURAL_COVERAGE_KEY_SCHEMA}`);
      }
      if (publicationContext?.schemaVersion
        !== WORLD_STREAMING_PUBLICATION_CONTEXT_SCHEMA) {
        throw new TypeError(
          `publicationContext must be ${WORLD_STREAMING_PUBLICATION_CONTEXT_SCHEMA}`,
        );
      }
      if (createPlanInput !== null && typeof createPlanInput !== 'function') {
        throw new TypeError('createPlanInput must be a function when provided');
      }
      latestPublicationContext = publicationContext;
      const cachedPlanValid = latestPlan?.schemaVersion === 'world-streaming-plan-1'
        && latestCoverageKey?.schemaVersion === NATURAL_COVERAGE_KEY_SCHEMA;
      if (sameNaturalCoverageKey(latestCoverageKey, coverageKey) && cachedPlanValid) {
        counts.coveragePlanReuses += 1;
        return Object.freeze({
          plan: latestPlan,
          coverageKey: latestCoverageKey,
          publicationContext,
          regenerated: false,
        });
      }
      if (sameNaturalCoverageKey(latestCoverageKey, coverageKey) && !cachedPlanValid) {
        counts.corruptCacheFallbacks += 1;
      }
      try {
        const planInput = createPlanInput?.() ?? input;
        const plan = buildPlan({
          ...planInput,
          generatedAtMs: publicationContext.generatedAtMs,
          stateRevision: publicationContext.stateRevision,
          originGeneration: publicationContext.originGeneration,
        }, coverageKey);
        counts.coveragePlanBuilds += 1;
        return Object.freeze({
          plan,
          coverageKey,
          publicationContext,
          regenerated: true,
        });
      } catch (error) {
        counts.coverageBuildFailures += 1;
        throw error;
      }
    },
    invalidateCoverage() {
      latestCoverageKey = null;
      counts.coverageInvalidations += 1;
      return true;
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: 'world-streaming-coordinator-snapshot-1',
        mode: WORLD_STREAMING_COORDINATOR_MODE.SHADOW,
        planCount: sequence,
        publicationSequence,
        latestPlan,
        latestCoverageKey,
        latestPublicationContext,
        latestComparison,
        policyRegistry: registry.snapshot(),
        performance: Object.freeze({
          sampleCapacity: PLAN_DURATION_SAMPLE_CAPACITY,
          sampleCount: planDurationSamples.length,
          lastPlanDurationMs,
          p95PlanDurationMs: percentile(planDurationSamples, 0.95),
          maximumPlanDurationMs,
        }),
        counts: Object.freeze({ ...counts }),
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
