/**
 * Ephemeral canonical-JSON serialization context for one generator pipeline.
 *
 * W2 and W3 reuse immutable nested objects during a single generation call.
 * This context preserves the Legacy Core canonical JSON byte contract while
 * avoiding a second validation/serialization of those identical references.
 * The context is intentionally per-call so mutable public ChunkData is never
 * cached across requests.
 */
export function createCanonicalJsonSerializationContext() {
  return Object.freeze({
    validatedObjects: new WeakSet(),
    serializedObjects: new WeakMap(),
  });
}

function assertContext(context) {
  if (!(context?.validatedObjects instanceof WeakSet)
    || !(context?.serializedObjects instanceof WeakMap)) {
    throw new TypeError('canonical JSON serialization context is required');
  }
}

function assertSupported(value, stack, context) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`canonical JSON rejects ${typeof value}`);
  }
  if (context.validatedObjects.has(value)) return;
  if (stack.has(value)) throw new TypeError('canonical JSON rejects circular references');
  if (value instanceof Date || value instanceof Map || value instanceof Set
    || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError('canonical JSON rejects non-JSON object types');
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('canonical JSON rejects objects with custom prototypes');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('canonical JSON rejects symbol keys');
  }
  stack.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertSupported(item, stack, context);
  } else {
    for (const key of Object.keys(value)) assertSupported(value[key], stack, context);
  }
  stack.delete(value);
  context.validatedObjects.add(value);
}

function serialize(value, context) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number'
    || typeof value === 'string') return JSON.stringify(value);
  const cached = context.serializedObjects.get(value);
  if (cached !== undefined) return cached;

  let serialized;
  if (Array.isArray(value)) {
    const items = new Array(value.length);
    let containsStructuredValue = false;
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      items[index] = item;
      if (item !== null && typeof item === 'object') containsStructuredValue = true;
    }
    serialized = containsStructuredValue
      ? `[${items.map(item => serialize(item, context)).join(',')}]`
      : JSON.stringify(items);
  } else {
    const keys = Object.keys(value).sort();
    serialized = `{${keys.map(key => (
      `${JSON.stringify(key)}:${serialize(value[key], context)}`
    )).join(',')}}`;
  }
  context.serializedObjects.set(value, serialized);
  return serialized;
}

export function canonicalizeJsonWithContext(value, context) {
  assertContext(context);
  assertSupported(value, new Set(), context);
  return serialize(value, context);
}
