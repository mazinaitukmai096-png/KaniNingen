function assertSupported(value, stack) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`canonical JSON rejects ${typeof value}`);
  }
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
    for (const item of value) assertSupported(item, stack);
  } else {
    for (const key of Object.keys(value)) assertSupported(value[key], stack);
  }
  stack.delete(value);
}

function serialize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number'
    || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${serialize(value[key])}`).join(',')}}`;
}

export function canonicalizeJson(value) {
  assertSupported(value, new Set());
  return serialize(value);
}

export function isCanonicalJsonValue(value) {
  try {
    canonicalizeJson(value);
    return true;
  } catch {
    return false;
  }
}
