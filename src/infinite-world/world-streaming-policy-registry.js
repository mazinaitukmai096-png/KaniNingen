export const WORLD_STREAMING_POLICY_SCHEMA = 'world-streaming-policy-1';

export const WORLD_STREAMING_POLICY_STREAM = Object.freeze({
  STATIC: 'static',
  DYNAMIC: 'dynamic',
  CRITICAL: 'critical',
});

const POLICY_KIND_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VALID_STREAMS = new Set(Object.values(WORLD_STREAMING_POLICY_STREAM));

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireKey(value, label) {
  if (typeof value !== 'string' || !POLICY_KIND_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lower-case kebab-case key`);
  }
  return value;
}

function requireNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

function normalizeBand(value, label) {
  const band = requireRecord(value, label);
  if (!Number.isSafeInteger(band.radiusChunks) || band.radiusChunks < 0) {
    throw new RangeError(`${label}.radiusChunks must be a non-negative safe integer`);
  }
  if (band.deadlineSeconds !== null && band.deadlineSeconds !== undefined) {
    requireNonNegative(band.deadlineSeconds, `${label}.deadlineSeconds`);
  }
  return Object.freeze({
    radiusChunks: band.radiusChunks,
    deadlineSeconds: band.deadlineSeconds ?? null,
  });
}

function normalizeDistanceBands(value) {
  const bands = requireRecord(value, 'policy.distanceBands');
  const required = normalizeBand(bands.required, 'policy.distanceBands.required');
  const prefetched = normalizeBand(bands.prefetched, 'policy.distanceBands.prefetched');
  const retained = normalizeBand(bands.retained, 'policy.distanceBands.retained');
  if (required.radiusChunks > prefetched.radiusChunks
    || prefetched.radiusChunks > retained.radiusChunks) {
    throw new RangeError('policy distance radii must be ordered required <= prefetched <= retained');
  }
  return Object.freeze({ required, prefetched, retained });
}

function normalizeVelocityPrefetch(value) {
  const policy = requireRecord(value, 'policy.velocityPrefetch');
  if (typeof policy.enabled !== 'boolean') {
    throw new TypeError('policy.velocityPrefetch.enabled must be boolean');
  }
  const leadSeconds = requireNonNegative(
    policy.leadSeconds,
    'policy.velocityPrefetch.leadSeconds',
  );
  const maximumDistanceMeters = requireNonNegative(
    policy.maximumDistanceMeters,
    'policy.velocityPrefetch.maximumDistanceMeters',
  );
  const sampleIntervalSeconds = requireNonNegative(
    policy.sampleIntervalSeconds,
    'policy.velocityPrefetch.sampleIntervalSeconds',
  );
  if (policy.enabled && (!(leadSeconds > 0) || !(maximumDistanceMeters > 0)
    || !(sampleIntervalSeconds > 0))) {
    throw new RangeError('enabled velocity prefetch requires positive lead, distance, and interval');
  }
  return Object.freeze({
    enabled: policy.enabled,
    leadSeconds,
    maximumDistanceMeters,
    sampleIntervalSeconds,
  });
}

function normalizeNamedRecord(value, label) {
  const record = requireRecord(value, label);
  return Object.freeze({ ...record, kind: requireKey(record.kind, `${label}.kind`) });
}

function normalizeDependencies(value, publicationGroup) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError('policy.publicationDependencies must be an array');
  const dependencies = value.map((entry, index) => requireKey(
    entry,
    `policy.publicationDependencies[${index}]`,
  ));
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error('policy publication dependencies must be unique');
  }
  if (dependencies.includes(publicationGroup)) {
    throw new Error('policy publication group cannot depend on itself');
  }
  return Object.freeze([...dependencies].sort());
}

export function validateWorldStreamingPolicy(input) {
  const policy = requireRecord(input, 'World Streaming policy');
  if (policy.schemaVersion !== WORLD_STREAMING_POLICY_SCHEMA) {
    throw new TypeError(`policy.schemaVersion must be ${WORLD_STREAMING_POLICY_SCHEMA}`);
  }
  const kind = requireKey(policy.kind, 'policy.kind');
  if (!VALID_STREAMS.has(policy.stream)) {
    throw new RangeError(`unsupported policy stream: ${policy.stream}`);
  }
  if (typeof policy.ownerResolver !== 'function') {
    throw new TypeError('policy.ownerResolver must be a function');
  }
  const publicationGroup = requireKey(policy.publicationGroup, 'policy.publicationGroup');
  return Object.freeze({
    schemaVersion: WORLD_STREAMING_POLICY_SCHEMA,
    kind,
    stream: policy.stream,
    distanceBands: normalizeDistanceBands(policy.distanceBands),
    velocityPrefetch: normalizeVelocityPrefetch(policy.velocityPrefetch),
    ownerResolver: policy.ownerResolver,
    generatorKind: requireKey(policy.generatorKind, 'policy.generatorKind'),
    cachePolicy: normalizeNamedRecord(policy.cachePolicy, 'policy.cachePolicy'),
    publicationGroup,
    publicationDependencies: normalizeDependencies(
      policy.publicationDependencies,
      publicationGroup,
    ),
    visibilityPolicy: normalizeNamedRecord(policy.visibilityPolicy, 'policy.visibilityPolicy'),
    persistencePolicy: normalizeNamedRecord(
      policy.persistencePolicy,
      'policy.persistencePolicy',
    ),
    criticality: requireKey(policy.criticality, 'policy.criticality'),
  });
}

function assertAcyclicPublicationGroups(policies) {
  const graph = new Map();
  for (const policy of policies) {
    if (!graph.has(policy.publicationGroup)) graph.set(policy.publicationGroup, new Set());
    for (const dependency of policy.publicationDependencies) {
      if (!graph.has(dependency)) graph.set(dependency, new Set());
      graph.get(policy.publicationGroup).add(dependency);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = group => {
    if (visiting.has(group)) throw new Error(`cyclic publication dependency at ${group}`);
    if (visited.has(group)) return;
    visiting.add(group);
    for (const dependency of graph.get(group) ?? []) visit(dependency);
    visiting.delete(group);
    visited.add(group);
  };
  for (const group of graph.keys()) visit(group);
}

export function createWorldStreamingPolicyRegistry() {
  const policies = new Map();
  let frozen = false;
  let version = 0;
  let frozenPolicies = null;
  return Object.freeze({
    register(input) {
      if (frozen) throw new Error('World Streaming policy registry is frozen');
      const policy = validateWorldStreamingPolicy(input);
      if (policies.has(policy.kind)) {
        throw new Error(`duplicate World Streaming policy: ${policy.kind}`);
      }
      policies.set(policy.kind, policy);
      version += 1;
      return policy;
    },
    freeze() {
      if (!frozen) {
        assertAcyclicPublicationGroups([...policies.values()]);
        frozenPolicies = Object.freeze([...policies.values()]
          .sort((left, right) => left.kind.localeCompare(right.kind)));
        frozen = true;
      }
      return this;
    },
    get(kind) {
      return policies.get(kind) ?? null;
    },
    list() {
      return frozenPolicies ?? Object.freeze([...policies.values()]
        .sort((left, right) => left.kind.localeCompare(right.kind)));
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: 'world-streaming-policy-registry-snapshot-1',
        frozen,
        version,
        policyCount: policies.size,
        policyKinds: Object.freeze([...policies.keys()].sort()),
      });
    },
    get frozen() { return frozen; },
    get version() { return version; },
  });
}
