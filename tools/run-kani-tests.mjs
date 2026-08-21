import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const KANI_TEST_MANIFEST_SCHEMA = 'kani-test-manifest-1';

const runnerRepoRoot = resolve(import.meta.dirname, '..');

function usage() {
  console.log([
    'Usage:',
    '  node tools/run-kani-tests.mjs [options] [tests/example.test.mjs ...]',
    '',
    'Options:',
    '  --output <manifest.json>     Write the complete run manifest.',
    '  --baseline <manifest.json>   Classify existing, resolved, and new failures.',
    '  --repo-root <path>           Run/hash tests from this repository or archive root.',
    '  --head-label <revision>      Record an explicit source revision for an archive.',
    '  --rerun-failures <count>     Total attempts for a failing file (default: 1).',
    '  --timeout-ms <milliseconds>  Per-file process timeout (default: 300000).',
    '',
    'Every test file runs serially in its own Node process. With a baseline, only',
    'new failures make the command fail; existing failures remain explicit.',
    'Test paths resolve from --repo-root; output/baseline paths resolve from the caller cwd.',
  ].join('\n'));
}

function normalizedPath(root, path) {
  return relative(root, path).replaceAll('\\', '/');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function commandResult(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? String(result.stdout ?? '').trim() : null;
}

export function parseTapFailures(output) {
  return Object.freeze(parseTapFailureRecords(output).map(failure => failure.title));
}

const normalizeDiagnosticText = value => String(value ?? '')
  .replace(/\u001b\[[0-9;]*m/g, '')
  .replace(/file:\/\/\/[A-Za-z]:[\\/][^\n]*?[\\/](?=(?:tests|src|tools)[\\/])/g, '<repo>/')
  .replace(/[A-Za-z]:[\\/][^\n]*?[\\/](?=(?:tests|src|tools)[\\/])/g, '<repo>/')
  .replace(/<repo>\\(?=(?:tests|src|tools)\\)/g, '<repo>/')
  .replace(/<repo>\/(?:tests|src|tools)[^\n]*/g, path => path.replaceAll('\\', '/'))
  .replace(/[ \t]+$/gm, '')
  .trim();

const unquoteTapScalar = value => {
  const text = String(value ?? '').trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  return text;
};

const tapField = (lines, fieldNames) => {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/);
    if (!match || !fieldNames.includes(match[2])) continue;
    const indentation = match[1].length;
    const scalar = match[3] ?? '';
    if (!['|-', '|', '>-', '>'].includes(scalar.trim())) return unquoteTapScalar(scalar);
    const values = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim().length === 0) {
        values.push('');
        continue;
      }
      const leading = line.match(/^\s*/)?.[0].length ?? 0;
      if (leading <= indentation) break;
      values.push(line.slice(Math.min(line.length, indentation + 2)));
    }
    return values.join('\n').trimEnd();
  }
  return '';
};

export function parseTapFailureRecords(output) {
  if (typeof output !== 'string' || output.length === 0) return Object.freeze([]);
  const lines = output.replaceAll('\r\n', '\n').split('\n');
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)not ok\s+\d+\s+-\s+(.+?)(?:\s+#.*)?\s*$/);
    if (!match) continue;
    const indentation = match[1].length;
    const block = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nextResult = lines[cursor].match(/^(\s*)(?:not )?ok\s+\d+\s+-\s+/);
      if (nextResult && nextResult[1].length <= indentation) break;
      if (indentation === 0 && /^1\.\.\d+\s*$/.test(lines[cursor])) break;
      block.push(lines[cursor]);
    }
    const title = normalizeDiagnosticText(match[2]);
    const message = normalizeDiagnosticText(tapField(block, ['error', 'message']));
    const normalizedStack = normalizeDiagnosticText(tapField(block, ['stack']));
    const stackFingerprint = createHash('sha256').update(normalizedStack).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify({
      title,
      message,
      normalizedStack,
    })).digest('hex');
    if (!title) continue;
    records.push(Object.freeze({
      testNumber: Number(lines[index].match(/not ok\s+(\d+)/)?.[1] ?? 0),
      title,
      message,
      normalizedStack,
      stackFingerprint,
      fingerprint,
    }));
  }
  return Object.freeze(records);
}

function attemptFailureRecords(attempt) {
  if (attempt?.pass) return Object.freeze([]);
  if (Array.isArray(attempt?.failures) && attempt.failures.length > 0) {
    return Object.freeze(attempt.failures.map(failure => {
      const title = String(failure.title ?? failure.name ?? '<process-failure>');
      const message = normalizeDiagnosticText(failure.message ?? '');
      const normalizedStack = normalizeDiagnosticText(failure.normalizedStack ?? '');
      const stackFingerprint = String(failure.stackFingerprint ?? '')
        || createHash('sha256').update(normalizedStack).digest('hex');
      const fingerprint = String(failure.fingerprint ?? '')
        || createHash('sha256').update(JSON.stringify({
          title, message, normalizedStack,
        })).digest('hex');
      return Object.freeze({
        title,
        message,
        normalizedStack,
        stackFingerprint,
        fingerprint,
        legacy: false,
      });
    }));
  }
  const reparsed = parseTapFailureRecords(`${attempt?.stdout ?? ''}\n${attempt?.stderr ?? ''}`);
  if (reparsed.length > 0) return reparsed;
  const names = Array.isArray(attempt?.failureNames) && attempt.failureNames.length > 0
    ? attempt.failureNames
    : [attempt?.timedOut ? '<process-timeout>' : '<process-failure>'];
  const processDiagnostic = Object.freeze({
    timedOut: attempt?.timedOut === true,
    exitCode: Number.isInteger(attempt?.exitCode) ? attempt.exitCode : null,
    signal: typeof attempt?.signal === 'string' ? attempt.signal : null,
    errorName: normalizeDiagnosticText(attempt?.error?.name ?? ''),
    errorCode: normalizeDiagnosticText(attempt?.error?.code ?? ''),
    errorMessage: normalizeDiagnosticText(attempt?.error?.message ?? ''),
    stderr: normalizeDiagnosticText(attempt?.stderr ?? ''),
  });
  const hasProcessDiagnostic = processDiagnostic.timedOut
    || processDiagnostic.exitCode !== null
    || processDiagnostic.signal !== null
    || processDiagnostic.errorName.length > 0
    || processDiagnostic.errorCode.length > 0
    || processDiagnostic.errorMessage.length > 0
    || processDiagnostic.stderr.length > 0;
  return Object.freeze(names.map(title => Object.freeze({
    title: String(title),
    message: hasProcessDiagnostic ? JSON.stringify(processDiagnostic) : '',
    normalizedStack: '',
    stackFingerprint: hasProcessDiagnostic
      ? createHash('sha256').update('').digest('hex') : '',
    fingerprint: hasProcessDiagnostic
      ? createHash('sha256').update(JSON.stringify({
        title: String(title),
        processDiagnostic,
      })).digest('hex') : '',
    legacy: !hasProcessDiagnostic,
  })));
}

function failureFingerprint(attempt) {
  if (attempt.pass) return Object.freeze([]);
  return Object.freeze(attemptFailureRecords(attempt).map(failure => (
    failure.fingerprint || `legacy:${failure.title}`
  )));
}

function classifyAttempts(attempts) {
  if (attempts[0]?.pass) return 'pass';
  if (attempts.some(attempt => attempt.pass)) return 'timing-sensitive';
  const fingerprints = attempts.map(attempt => JSON.stringify(failureFingerprint(attempt)));
  return new Set(fingerprints).size === 1 && attempts.length > 1
    ? 'deterministic' : attempts.length > 1 ? 'variable' : 'unclassified';
}

function runAttempt(filePath, timeoutMs, repoRoot) {
  const args = [
    '--test',
    '--test-reporter=tap',
    '--test-concurrency=1',
    '--test-force-exit',
    filePath,
  ];
  const startedAtMs = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const durationMs = Date.now() - startedAtMs;
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const combined = `${stdout}\n${stderr}`;
  const failures = parseTapFailureRecords(combined);
  return Object.freeze({
    pass: result.status === 0,
    exitCode: result.status,
    signal: result.signal ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    error: result.error ? {
      name: result.error.name,
      message: result.error.message,
      code: result.error.code ?? null,
    } : null,
    durationMs,
    failureNames: Object.freeze(failures.map(failure => failure.title)),
    failures,
    stdout,
    stderr,
    command: Object.freeze([process.execPath, ...args]),
  });
}

function manifestFailures(manifest) {
  const failures = new Map();
  for (const file of manifest?.files ?? []) {
    if (file.pass === true) continue;
    const attempt = file.attempts?.[0] ?? {};
    const records = attemptFailureRecords({ ...attempt, pass: false });
    failures.set(file.path, Object.freeze({
      sha256: typeof file.sha256 === 'string' ? file.sha256 : null,
      records,
    }));
  }
  return failures;
}

export function compareTestManifests(baseline, current) {
  if (baseline?.schemaVersion !== KANI_TEST_MANIFEST_SCHEMA
    || current?.schemaVersion !== KANI_TEST_MANIFEST_SCHEMA) {
    throw new TypeError('baseline and current manifests must use kani-test-manifest-1');
  }
  const baselineFailures = manifestFailures(baseline);
  const currentFailures = manifestFailures(current);
  const baselineFiles = new Map((baseline.files ?? []).map(file => [file.path, file]));
  const currentFiles = new Map((current.files ?? []).map(file => [file.path, file]));
  const existingFailures = [];
  const newFailures = [];
  const resolvedFailures = [];
  const changedTestFiles = [...currentFiles]
    .filter(([path, file]) => {
      const baselineFile = baselineFiles.get(path);
      return baselineFile && (typeof baselineFile.sha256 !== 'string'
        || typeof file.sha256 !== 'string' || baselineFile.sha256 !== file.sha256);
    })
    .map(([path]) => path);
  const describeFailure = (path, failure, extra = {}) => Object.freeze({
    path,
    name: failure.title,
    ...(failure.legacy ? {} : {
      message: failure.message,
      stackFingerprint: failure.stackFingerprint,
      fingerprint: failure.fingerprint,
    }),
    ...extra,
  });
  const recordsMatch = (baselineRecord, currentRecord) => (
    baselineRecord.legacy || currentRecord.legacy
      ? baselineRecord.title === currentRecord.title
      : baselineRecord.fingerprint === currentRecord.fingerprint
  );
  for (const [path, currentFailure] of currentFailures) {
    const baselineFailure = baselineFailures.get(path) ?? null;
    const sameTestSource = baselineFailure !== null
      && baselineFailure.sha256 !== null
      && baselineFailure.sha256 === currentFailure.sha256;
    const unmatchedBaseline = sameTestSource
      ? [...baselineFailure.records] : [];
    for (const record of currentFailure.records) {
      const matchingIndex = unmatchedBaseline.findIndex(candidate => (
        recordsMatch(candidate, record)
      ));
      const target = matchingIndex >= 0 ? existingFailures : newFailures;
      if (matchingIndex >= 0) unmatchedBaseline.splice(matchingIndex, 1);
      target.push(describeFailure(path, record));
    }
  }
  for (const [path, baselineFailure] of baselineFailures) {
    if (!currentFiles.has(path)) continue;
    const currentRecords = [...(currentFailures.get(path)?.records ?? [])];
    for (const record of baselineFailure.records) {
      const matchingIndex = currentRecords.findIndex(candidate => (
        recordsMatch(record, candidate)
      ));
      if (matchingIndex >= 0) currentRecords.splice(matchingIndex, 1);
      else {
        resolvedFailures.push(describeFailure(path, record));
      }
    }
  }
  for (const path of baselineFiles.keys()) {
    if (currentFiles.has(path)) continue;
    newFailures.push(Object.freeze({
      path,
      name: '<baseline-test-file-missing>',
      reason: 'baseline-test-file-missing',
    }));
  }
  const sort = values => values.sort((left, right) => (
    left.path.localeCompare(right.path) || left.name.localeCompare(right.name)
  ));
  sort(existingFailures);
  sort(newFailures);
  sort(resolvedFailures);
  changedTestFiles.sort((left, right) => left.localeCompare(right));
  return Object.freeze({
    pass: newFailures.length === 0,
    existingFailures: Object.freeze(existingFailures),
    newFailures: Object.freeze(newFailures),
    resolvedFailures: Object.freeze(resolvedFailures),
    changedTestFiles: Object.freeze(changedTestFiles),
  });
}

function parseArguments(args) {
  const invocationRoot = process.cwd();
  const options = {
    repoRoot: runnerRepoRoot,
    headLabel: null,
    output: null,
    baseline: null,
    rerunFailures: 1,
    timeoutMs: 300_000,
    files: [],
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--help' || value === '-h') {
      options.help = true;
      continue;
    }
    if (['--output', '--baseline', '--repo-root', '--head-label',
      '--rerun-failures', '--timeout-ms'].includes(value)) {
      const next = args[index + 1];
      if (next === undefined) throw new TypeError(`${value} requires a value`);
      index += 1;
      if (value === '--output') options.output = resolve(invocationRoot, next);
      else if (value === '--baseline') options.baseline = resolve(invocationRoot, next);
      else if (value === '--repo-root') options.repoRoot = resolve(invocationRoot, next);
      else if (value === '--head-label') options.headLabel = next;
      else if (value === '--rerun-failures') options.rerunFailures = Number(next);
      else options.timeoutMs = Number(next);
      continue;
    }
    if (value.startsWith('-')) throw new TypeError(`unknown option: ${value}`);
    options.files.push(value);
  }
  options.files = options.files.map(file => resolve(options.repoRoot, file));
  if (options.headLabel !== null && options.headLabel.trim().length === 0) {
    throw new RangeError('--head-label must not be empty');
  }
  if (!Number.isSafeInteger(options.rerunFailures) || options.rerunFailures < 1
    || options.rerunFailures > 10) {
    throw new RangeError('--rerun-failures must be an integer from 1 to 10');
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new RangeError('--timeout-ms must be an integer of at least 1000');
  }
  return options;
}

function testFiles(options) {
  const files = options.files.length > 0 ? options.files : readdirSync(resolve(options.repoRoot, 'tests'))
    .filter(name => name.endsWith('.test.mjs'))
    .map(name => resolve(options.repoRoot, 'tests', name));
  const unique = [...new Set(files)].sort((left, right) => left.localeCompare(right));
  for (const file of unique) {
    if (!existsSync(file)) throw new Error(`test file does not exist: ${file}`);
    if (!file.endsWith('.test.mjs')) throw new Error(`not a .test.mjs file: ${file}`);
  }
  return unique;
}

function runCli(args) {
  let options;
  try {
    options = parseArguments(args);
  } catch (error) {
    console.error(error.message);
    usage();
    return 2;
  }
  if (options.help) {
    usage();
    return 0;
  }
  let baseline = null;
  if (options.baseline) {
    try {
      baseline = JSON.parse(readFileSync(options.baseline, 'utf8'));
    } catch (error) {
      console.error(`failed to read baseline: ${error.message}`);
      return 2;
    }
  }
  let files;
  try {
    files = testFiles(options);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const startedAt = new Date().toISOString();
  const results = [];
  for (const [index, filePath] of files.entries()) {
    const path = normalizedPath(options.repoRoot, filePath);
    console.log(`[${index + 1}/${files.length}] ${path}`);
    const attempts = [runAttempt(filePath, options.timeoutMs, options.repoRoot)];
    process.stdout.write(attempts[0].stdout);
    process.stderr.write(attempts[0].stderr);
    if (!attempts[0].pass) {
      for (let attempt = 1; attempt < options.rerunFailures; attempt += 1) {
        console.log(`[rerun ${attempt + 1}/${options.rerunFailures}] ${path}`);
        const rerun = runAttempt(filePath, options.timeoutMs, options.repoRoot);
        attempts.push(rerun);
        process.stdout.write(rerun.stdout);
        process.stderr.write(rerun.stderr);
      }
    }
    results.push(Object.freeze({
      path,
      sha256: sha256(filePath),
      pass: attempts[0].pass,
      classification: classifyAttempts(attempts),
      attempts: Object.freeze(attempts),
    }));
  }
  const detectedGitRoot = commandResult(
    'git', ['rev-parse', '--show-toplevel'], options.repoRoot,
  );
  const targetOwnsGitMetadata = detectedGitRoot !== null
    && resolve(detectedGitRoot).toLowerCase() === resolve(options.repoRoot).toLowerCase();
  const detectedHead = targetOwnsGitMetadata
    ? commandResult('git', ['rev-parse', 'HEAD'], options.repoRoot) : null;
  const detectedStatus = targetOwnsGitMetadata
    ? commandResult('git', ['status', '--short'], options.repoRoot) : null;
  const runnerHead = commandResult('git', ['rev-parse', 'HEAD'], runnerRepoRoot);
  const runnerStatus = commandResult('git', ['status', '--short'], runnerRepoRoot);
  const manifest = {
    schemaVersion: KANI_TEST_MANIFEST_SCHEMA,
    startedAt,
    finishedAt: new Date().toISOString(),
    repository: Object.freeze({
      root: options.repoRoot,
      head: options.headLabel ?? detectedHead,
      headSource: options.headLabel !== null
        ? 'explicit' : detectedHead !== null ? 'git' : 'unavailable',
      detectedHead,
      detectedGitRoot: targetOwnsGitMetadata ? detectedGitRoot : null,
      dirty: detectedStatus === null ? null : detectedStatus !== '',
    }),
    environment: Object.freeze({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
    runner: Object.freeze({
      script: normalizedPath(runnerRepoRoot, resolve(import.meta.dirname, 'run-kani-tests.mjs')),
      scriptSha256: sha256(resolve(import.meta.dirname, 'run-kani-tests.mjs')),
      repositoryRoot: runnerRepoRoot,
      repositoryHead: runnerHead,
      repositoryDirty: runnerStatus === null ? null : runnerStatus !== '',
      isolatedProcessPerFile: true,
      testConcurrency: 1,
      forceExit: true,
      timeoutMs: options.timeoutMs,
      rerunFailures: options.rerunFailures,
    }),
    files: Object.freeze(results),
  };
  const comparison = baseline ? compareTestManifests(baseline, manifest) : null;
  manifest.gate = comparison ?? Object.freeze({
    pass: results.every(result => result.pass),
    existingFailures: Object.freeze([]),
    newFailures: Object.freeze(results.filter(result => !result.pass).flatMap(result => (
      attemptFailureRecords(result.attempts[0]).map(failure => Object.freeze({
        path: result.path,
        name: failure.title,
        ...(failure.legacy ? {} : {
          message: failure.message,
          stackFingerprint: failure.stackFingerprint,
          fingerprint: failure.fingerprint,
        }),
      }))
    ))),
    resolvedFailures: Object.freeze([]),
    changedTestFiles: Object.freeze([]),
  });
  if (options.output) {
    writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(options.output);
  }
  console.log(JSON.stringify({
    files: results.length,
    passedFiles: results.filter(result => result.pass).length,
    failedFiles: results.filter(result => !result.pass).length,
    existingFailures: manifest.gate.existingFailures.length,
    newFailures: manifest.gate.newFailures.length,
    resolvedFailures: manifest.gate.resolvedFailures.length,
    changedTestFiles: manifest.gate.changedTestFiles.length,
    pass: manifest.gate.pass,
  }));
  return manifest.gate.pass ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2));
}
