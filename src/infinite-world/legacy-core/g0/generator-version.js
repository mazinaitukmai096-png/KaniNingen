const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseGeneratorVersion(input) {
  if (typeof input !== 'string') throw new TypeError('generatorVersion must be a string');
  const match = VERSION_PATTERN.exec(input);
  if (!match) throw new TypeError('generatorVersion must use strict major.minor.patch syntax');
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new RangeError('generatorVersion components must be safe integers');
  }
  return Object.freeze({ major, minor, patch, id: input });
}

export function validateGeneratorVersion(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('generatorVersion must be an object');
  } else {
    try {
      const parsed = parseGeneratorVersion(value.id);
      if (parsed.major !== value.major || parsed.minor !== value.minor || parsed.patch !== value.patch) {
        errors.push('generatorVersion fields must match id');
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}
