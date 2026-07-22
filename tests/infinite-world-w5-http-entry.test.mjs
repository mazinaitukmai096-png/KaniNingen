import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

import {
  SANDBOX_MAIN_MODULE_SPECIFIER,
  createSandboxModuleEntry,
} from '../src/infinite-world/sandbox-entry.js';

const repoRoot = resolve(import.meta.dirname, '..');
const javascriptMime = /^application\/javascript(?:;|$)/i;

function localImportSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith('./') || match[1].startsWith('../')) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
      const filePath = resolve(repoRoot, relativePath || 'infinite-world-sandbox.html');
      if (filePath !== repoRoot && !filePath.startsWith(`${repoRoot}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const body = await readFile(filePath);
      const type = extname(filePath) === '.html'
        ? 'text/html; charset=utf-8'
        : 'application/javascript; charset=utf-8';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    } catch (error) {
      response.writeHead(error?.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error?.message || String(error));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close(error => (error ? rejectClose(error) : resolveClose()));
    }),
  };
}

async function assertExactFilesystemCase(url) {
  let directory = repoRoot;
  const segments = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean);
  for (const segment of segments) {
    const names = await readdir(directory);
    assert.equal(names.includes(segment), true, `filesystem case mismatch below ${directory}: ${segment}`);
    directory = resolve(directory, segment);
  }
}

function findImportCycle(records) {
  const visiting = new Set();
  const visited = new Set();
  function visit(url, path) {
    if (visiting.has(url)) return [...path, url];
    if (visited.has(url)) return null;
    visiting.add(url);
    const record = records.get(url);
    for (const importedUrl of record?.imports ?? []) {
      const cycle = visit(importedUrl, [...path, url]);
      if (cycle) return cycle;
    }
    visiting.delete(url);
    visited.add(url);
    return null;
  }
  for (const url of records.keys()) {
    const cycle = visit(url, []);
    if (cycle) return cycle;
  }
  return null;
}

test('real HTTP entry and recursive local import graph resolve with JavaScript MIME and source bodies', async () => {
  const staticServer = await startStaticServer();
  try {
    const htmlUrl = `${staticServer.origin}/infinite-world-sandbox.html?v=w5-http-entry-fix`;
    const htmlResponse = await fetch(htmlUrl);
    const html = await htmlResponse.text();
    assert.equal(htmlResponse.status, 200);
    assert.match(htmlResponse.headers.get('content-type'), /^text\/html(?:;|$)/i);
    const entryMatch = html.match(/<script\s+type="module"\s+src="([^"]+)"/);
    assert.ok(entryMatch, 'module entry script is missing');

    const entryUrl = new URL(entryMatch[1], htmlUrl).href;
    const queue = [{ url: entryUrl, referrer: htmlUrl, specifier: entryMatch[1] }];
    const visited = new Map();
    while (queue.length) {
      const edge = queue.shift();
      if (visited.has(edge.url)) continue;
      const response = await fetch(edge.url);
      const body = await response.text();
      const contentType = response.headers.get('content-type') || '';
      const importedSpecifiers = localImportSpecifiers(body);
      const imports = importedSpecifiers.map(specifier => new URL(specifier, edge.url).href);
      const record = { ...edge, status: response.status, contentType, body, imports };
      visited.set(edge.url, record);
      assert.equal(response.status, 200, `HTTP ${response.status} for ${edge.url} from ${edge.referrer}`);
      assert.match(contentType, javascriptMime, `non-JavaScript MIME for ${edge.url}: ${contentType}`);
      assert.doesNotMatch(body, /<!doctype\s+html/i, `HTML fallback body returned for ${edge.url}`);
      await assertExactFilesystemCase(edge.url);
      for (const specifier of importedSpecifiers) {
        queue.push({ url: new URL(specifier, edge.url).href, referrer: edge.url, specifier });
      }
    }

    assert.ok(visited.size >= 40, `expected complete W5 graph, received ${visited.size} modules`);
    assert.equal([...visited.keys()].some(url => url.includes('/sandbox-entry.js?v=w5-http-entry-fix')), true);
    assert.equal([...visited.keys()].some(url => url.includes('/sandbox-main.js?v=w5-http-entry-fix')), true);
    assert.equal([...visited.keys()].some(url => url.endsWith('/src/infinite-world/runtime-timing.js')), true);
    assert.equal([...visited.values()].every(record => record.status === 200 && javascriptMime.test(record.contentType)), true);
    assert.equal(findImportCycle(visited), null, 'entry import graph must remain acyclic');
  } finally {
    await staticServer.close();
  }
});

test('dynamic bootstrap imports main and invokes its named start export only once', async () => {
  const hud = { textContent: '' };
  let imports = 0;
  let boots = 0;
  const entry = createSandboxModuleEntry({
    hud,
    moduleUrl: 'http://127.0.0.1:8021/src/infinite-world/sandbox-main.js?v=w5-http-entry-fix',
    importModule: async specifier => {
      imports += 1;
      assert.equal(specifier, SANDBOX_MAIN_MODULE_SPECIFIER);
      return {
        async startInfiniteWorldSandbox() {
          boots += 1;
          return { ok: true };
        },
      };
    },
  });
  const first = entry.startSandboxEntryOnce();
  const second = entry.startSandboxEntryOnce();
  assert.equal(first, second);
  assert.match(hud.textContent, /起動中: MODULE_BOOT/);
  const outcome = await first;
  assert.equal(outcome.ok, true);
  assert.equal(imports, 1);
  assert.equal(boots, 1);
  assert.equal(entry.snapshot().importExecutionCount, 1);
  assert.equal(entry.snapshot().bootExecutionCount, 1);
});

test('nested dynamic import rejection becomes an actual MODULE_IMPORT HUD diagnostic', async () => {
  const hud = { textContent: '' };
  const importError = new SyntaxError('Unexpected token in nested-module.js');
  importError.stack = 'SyntaxError: Unexpected token in nested-module.js\n    at nested-module.js:4:2';
  const entry = createSandboxModuleEntry({
    hud,
    moduleUrl: 'http://127.0.0.1:8021/src/infinite-world/sandbox-main.js?v=w5-http-entry-fix',
    importModule: async () => { throw importError; },
  });
  const outcome = await entry.startSandboxEntryOnce();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.name, 'SyntaxError');
  assert.equal(outcome.error.message, 'Unexpected token in nested-module.js');
  assert.equal(outcome.error.stackFirstLine, 'SyntaxError: Unexpected token in nested-module.js');
  assert.match(hud.textContent, /起動失敗: MODULE_IMPORT/);
  assert.match(hud.textContent, /SyntaxError: Unexpected token in nested-module\.js/);
  assert.match(hud.textContent, /Stack: SyntaxError: Unexpected token in nested-module\.js/);
  assert.match(hud.textContent, /Module: http:\/\/127\.0\.0\.1:8021\/src\/infinite-world\/sandbox-main\.js\?v=w5-http-entry-fix/);
});

test('missing named start export is reported instead of silently stopping', async () => {
  const hud = { textContent: '' };
  const entry = createSandboxModuleEntry({ hud, importModule: async () => ({}) });
  const outcome = await entry.startSandboxEntryOnce();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.name, 'TypeError');
  assert.match(outcome.error.message, /does not export startInfiniteWorldSandbox/);
  assert.match(hud.textContent, /起動失敗: MODULE_IMPORT/);
});

test('named start export rejection is consumed and reported with the actual boot error', async () => {
  const hud = { textContent: '' };
  const entry = createSandboxModuleEntry({
    hud,
    importModule: async () => ({
      startInfiniteWorldSandbox: async () => { throw new ReferenceError('THREE is unavailable'); },
    }),
  });
  const outcome = await entry.startSandboxEntryOnce();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.name, 'ReferenceError');
  assert.equal(outcome.error.message, 'THREE is unavailable');
  assert.match(hud.textContent, /起動失敗: MODULE_IMPORT/);
  assert.match(hud.textContent, /ReferenceError: THREE is unavailable/);
});

test('dynamic bootstrap preserves the first pre-module resource error instead of overwriting it', async () => {
  const hud = { textContent: '起動失敗: MODULE_LOAD\nSource: https://example.test/three.min.js' };
  let imports = 0;
  const entry = createSandboxModuleEntry({
    hud,
    globalObject: {
      __infiniteWorldEntryBridge: {
        snapshot: () => ({ reported: true }),
      },
    },
    importModule: async () => {
      imports += 1;
      return { startInfiniteWorldSandbox: async () => { throw new Error('later boot failure'); } };
    },
  });
  const originalHud = hud.textContent;
  const outcome = await entry.startSandboxEntryOnce();
  assert.equal(outcome.ok, false);
  assert.equal(imports, 1);
  assert.equal(hud.textContent, originalHud);
});

test('runtime timing module preserves the formal metric export and value contract', async () => {
  const timing = await import('../src/infinite-world/runtime-timing.js');
  assert.deepEqual(Object.keys(timing).sort(), [
    'MetricSeries',
    'PerformanceLedger',
    'evaluateW1APerformanceWarnings',
  ]);
  const series = new timing.MetricSeries(3);
  for (const value of [4, 1, 9, 16]) series.record(value);
  assert.deepEqual(series.snapshot(), {
    count: 4,
    sampleCount: 3,
    latest: 16,
    p50: 9,
    p95: 16,
    max: 16,
  });
});
