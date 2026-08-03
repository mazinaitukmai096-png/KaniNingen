import { parseChunkKey } from './chunk-coordinates.js';

export const STREAMING_OWNER_DESCRIPTOR_SCHEMA = 'streaming-owner-descriptor-1';

const asEnabled = value => (typeof value === 'function' ? value : () => value === true);

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} is required`);
  return value;
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function touch(map, key, value) {
  map.delete(key);
  map.set(key, value);
  return value;
}

function trim(map, capacity) {
  while (map.size > capacity) map.delete(map.keys().next().value);
}

export function createStreamingOwnerMetadataCache({
  coordinateCapacity = 4096,
  classificationCapacity = 16384,
  diagnosticsEnabled = false,
  reuseParsedCoordinates = true,
  reuseClassifications = true,
} = {}) {
  const maximumCoordinateCount = positiveSafeInteger(
    coordinateCapacity,
    'coordinateCapacity',
  );
  const maximumClassificationCount = positiveSafeInteger(
    classificationCapacity,
    'classificationCapacity',
  );
  const diagnosticsAreEnabled = asEnabled(diagnosticsEnabled);
  const coordinates = new Map();
  const classifications = new Map();
  const classificationsByRevision = new Map();
  let frameId = null;
  let frameParsedInputs = null;
  let frameClassifiedInputs = null;
  let metrics = null;

  const ensureMetrics = () => {
    if (!diagnosticsAreEnabled()) return null;
    metrics ??= {
      parseCalls: 0,
      parseExecutions: 0,
      parseHits: 0,
      parseSameFrameDuplicates: 0,
      classifyCalls: 0,
      classifyExecutions: 0,
      classifyHits: 0,
      classifySameFrameDuplicates: 0,
      signatureBuilds: 0,
      descriptorAllocations: 0,
      parseInputs: new Set(),
      classifyInputs: new Set(),
      parseCallsByPath: new Map(),
      classifyCallsByPath: new Map(),
      classifyCallsByPolicy: new Map(),
      signatureBuildsByPath: new Map(),
    };
    return metrics;
  };

  const beginFrame = nextFrameId => {
    if (!diagnosticsAreEnabled()) return false;
    if (nextFrameId === frameId) return false;
    frameId = nextFrameId;
    frameParsedInputs = new Set();
    frameClassifiedInputs = new Set();
    return true;
  };

  const parse = (ownerKey, { path = 'unspecified' } = {}) => {
    const key = nonEmptyString(ownerKey, 'ownerKey');
    const diagnostic = ensureMetrics();
    if (diagnostic) {
      diagnostic.parseCalls += 1;
      diagnostic.parseInputs.add(key);
      increment(diagnostic.parseCallsByPath, path);
      if (frameParsedInputs?.has(key)) diagnostic.parseSameFrameDuplicates += 1;
      else frameParsedInputs?.add(key);
    }
    const cached = reuseParsedCoordinates ? coordinates.get(key) : null;
    if (cached) {
      if (diagnostic) diagnostic.parseHits += 1;
      return touch(coordinates, key, cached);
    }
    const parsed = parseChunkKey(key);
    const descriptor = Object.freeze({
      schemaVersion: STREAMING_OWNER_DESCRIPTOR_SCHEMA,
      key,
      ownerKey: key,
      ownerX: parsed.chunkX,
      ownerZ: parsed.chunkZ,
      chunkX: parsed.chunkX,
      chunkZ: parsed.chunkZ,
    });
    if (diagnostic) {
      diagnostic.parseExecutions += 1;
      diagnostic.descriptorAllocations += 1;
    }
    if (reuseParsedCoordinates) {
      coordinates.set(key, descriptor);
      trim(coordinates, maximumCoordinateCount);
    }
    return descriptor;
  };

  const deleteClassification = descriptor => {
    classifications.delete(descriptor);
    const revisionEntries = classificationsByRevision.get(descriptor.classificationRevision);
    const policyEntries = revisionEntries?.get(descriptor.policyKind);
    if (policyEntries?.get(descriptor.ownerKey) !== descriptor) return;
    policyEntries.delete(descriptor.ownerKey);
    if (policyEntries.size === 0) revisionEntries.delete(descriptor.policyKind);
    if (revisionEntries.size === 0) {
      classificationsByRevision.delete(descriptor.classificationRevision);
    }
  };

  const cacheClassification = descriptor => {
    let revisionEntries = classificationsByRevision.get(descriptor.classificationRevision);
    if (!revisionEntries) {
      revisionEntries = new Map();
      classificationsByRevision.set(descriptor.classificationRevision, revisionEntries);
    }
    let policyEntries = revisionEntries.get(descriptor.policyKind);
    if (!policyEntries) {
      policyEntries = new Map();
      revisionEntries.set(descriptor.policyKind, policyEntries);
    }
    policyEntries.set(descriptor.ownerKey, descriptor);
    classifications.set(descriptor, descriptor);
    while (classifications.size > maximumClassificationCount) {
      deleteClassification(classifications.keys().next().value);
    }
  };

  const classify = ({
    ownerKey,
    policyKind,
    revision,
    classifier,
    path = 'unspecified',
  } = {}) => {
    const key = nonEmptyString(ownerKey, 'ownerKey');
    const kind = nonEmptyString(policyKind, 'policyKind');
    const classificationRevision = nonEmptyString(revision, 'revision');
    if (typeof classifier !== 'function') throw new TypeError('classifier is required');
    const diagnostic = ensureMetrics();
    if (diagnostic) {
      const cacheKey = `${classificationRevision}\n${kind}\n${key}`;
      diagnostic.classifyCalls += 1;
      diagnostic.classifyInputs.add(cacheKey);
      increment(diagnostic.classifyCallsByPath, path);
      increment(diagnostic.classifyCallsByPolicy, kind);
      if (frameClassifiedInputs?.has(cacheKey)) diagnostic.classifySameFrameDuplicates += 1;
      else frameClassifiedInputs?.add(cacheKey);
    }
    const cached = reuseClassifications
      ? classificationsByRevision.get(classificationRevision)?.get(kind)?.get(key)
      : null;
    if (cached) {
      if (diagnostic) diagnostic.classifyHits += 1;
      touch(classifications, cached, cached);
      return cached;
    }
    const coordinate = parse(key, { path: `${path}:coordinate` });
    const resourceKind = classifier(coordinate);
    if (typeof resourceKind !== 'string' || !resourceKind) {
      throw new TypeError('streaming owner classifier must return a resource kind');
    }
    const descriptor = Object.freeze({
      ...coordinate,
      policyKind: kind,
      resourceKind,
      classificationRevision,
    });
    if (diagnostic) {
      diagnostic.classifyExecutions += 1;
      diagnostic.descriptorAllocations += 1;
    }
    if (reuseClassifications) {
      cacheClassification(descriptor);
    }
    return descriptor;
  };

  const recordSignature = (path = 'unspecified') => {
    const diagnostic = ensureMetrics();
    if (!diagnostic) return false;
    diagnostic.signatureBuilds += 1;
    increment(diagnostic.signatureBuildsByPath, path);
    return true;
  };

  const recordClassificationReuse = ({
    ownerKey,
    policyKind = 'combined-static-natural',
    revision = 'active-coverage',
    path = 'unspecified',
  } = {}) => {
    const diagnostic = ensureMetrics();
    if (!diagnostic) return false;
    const key = nonEmptyString(ownerKey, 'ownerKey');
    const kind = nonEmptyString(policyKind, 'policyKind');
    const classificationRevision = nonEmptyString(revision, 'revision');
    const cacheKey = `${classificationRevision}\n${kind}\n${key}`;
    diagnostic.classifyCalls += 1;
    diagnostic.classifyHits += 1;
    diagnostic.classifyInputs.add(cacheKey);
    increment(diagnostic.classifyCallsByPath, path);
    increment(diagnostic.classifyCallsByPolicy, kind);
    if (frameClassifiedInputs?.has(cacheKey)) diagnostic.classifySameFrameDuplicates += 1;
    else frameClassifiedInputs?.add(cacheKey);
    return true;
  };

  const retainClassificationRevision = ({ revision, descriptors = [] } = {}) => {
    const classificationRevision = nonEmptyString(revision, 'revision');
    if (!Array.isArray(descriptors)) throw new TypeError('descriptors must be an array');
    const retainedByPolicy = new Map();
    for (const descriptor of descriptors) {
      let retainedOwners = retainedByPolicy.get(descriptor.policyKind);
      if (!retainedOwners) {
        retainedOwners = new Set();
        retainedByPolicy.set(descriptor.policyKind, retainedOwners);
      }
      retainedOwners.add(descriptor.ownerKey);
    }
    for (const descriptor of classifications.keys()) {
      if (descriptor.classificationRevision !== classificationRevision
        || !retainedByPolicy.get(descriptor.policyKind)?.has(descriptor.ownerKey)) {
        deleteClassification(descriptor);
      }
    }
    return classifications.size;
  };

  const invalidateClassifications = () => {
    const size = classifications.size;
    classifications.clear();
    classificationsByRevision.clear();
    return size;
  };

  const snapshot = () => {
    const diagnostic = metrics;
    const empty = !diagnostic;
    const mapRecord = map => Object.freeze(Object.fromEntries(
      [...map.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ));
    const parseCalls = diagnostic?.parseCalls ?? 0;
    const classifyCalls = diagnostic?.classifyCalls ?? 0;
    return Object.freeze({
      schemaVersion: 'streaming-owner-metadata-diagnostics-1',
      enabled: !empty,
      frameId,
      coordinateCacheSize: coordinates.size,
      coordinateCapacity: maximumCoordinateCount,
      classificationCacheSize: classifications.size,
      classificationCapacity: maximumClassificationCount,
      parseCalls,
      parseUniqueInputCount: diagnostic?.parseInputs.size ?? 0,
      parseExecutions: diagnostic?.parseExecutions ?? 0,
      parseHits: diagnostic?.parseHits ?? 0,
      parseHitRate: parseCalls > 0 ? (diagnostic?.parseHits ?? 0) / parseCalls : 0,
      parseSameFrameDuplicates: diagnostic?.parseSameFrameDuplicates ?? 0,
      classifyCalls,
      classifyUniqueInputCount: diagnostic?.classifyInputs.size ?? 0,
      classifyExecutions: diagnostic?.classifyExecutions ?? 0,
      classifyHits: diagnostic?.classifyHits ?? 0,
      classifyHitRate: classifyCalls > 0 ? (diagnostic?.classifyHits ?? 0) / classifyCalls : 0,
      classifySameFrameDuplicates: diagnostic?.classifySameFrameDuplicates ?? 0,
      signatureBuilds: diagnostic?.signatureBuilds ?? 0,
      descriptorAllocations: diagnostic?.descriptorAllocations ?? 0,
      parseCallsByPath: empty ? Object.freeze({}) : mapRecord(diagnostic.parseCallsByPath),
      classifyCallsByPath: empty ? Object.freeze({}) : mapRecord(diagnostic.classifyCallsByPath),
      classifyCallsByPolicy: empty ? Object.freeze({}) : mapRecord(
        diagnostic.classifyCallsByPolicy,
      ),
      signatureBuildsByPath: empty ? Object.freeze({}) : mapRecord(
        diagnostic.signatureBuildsByPath,
      ),
    });
  };

  return Object.freeze({
    beginFrame,
    parse,
    classify,
    recordClassificationReuse,
    recordSignature,
    retainClassificationRevision,
    invalidateClassifications,
    snapshot,
  });
}
