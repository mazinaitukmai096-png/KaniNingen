export const SANDBOX_MAIN_MODULE_SPECIFIER = './sandbox-main.js?v=w8-finite-parity';

function describeEntryError(error) {
  const name = String(error?.name || 'Error');
  const message = String(error?.message || error || 'Sandbox module import failed');
  const stackFirstLine = String(error?.stack || `${name}: ${message}`).split(/\r?\n/, 1)[0];
  return Object.freeze({ name, message, stackFirstLine });
}

function renderModuleBoot(hud) {
  if (!hud) return;
  hud.textContent = 'W8 / FINITE EXPERIENCE PARITY\n起動中: MODULE_BOOT';
}

function renderModuleImportFailure({ hud, error, moduleUrl, entryBridge }) {
  const described = describeEntryError(error);
  if (!entryBridge?.snapshot?.().reported && hud) {
    hud.textContent = [
      'W8 / FINITE EXPERIENCE PARITY',
      '起動失敗: MODULE_IMPORT',
      `${described.name}: ${described.message}`,
      `Stack: ${described.stackFirstLine}`,
      `Module: ${moduleUrl}`,
    ].join('\n');
  }
  return described;
}

export function createSandboxModuleEntry({
  globalObject = globalThis,
  documentObject = globalObject.document,
  hud = documentObject?.querySelector?.('#hud'),
  moduleSpecifier = SANDBOX_MAIN_MODULE_SPECIFIER,
  moduleUrl = new URL(moduleSpecifier, import.meta.url).href,
  importModule = () => import('./sandbox-main.js?v=w8-finite-parity'),
} = {}) {
  let entryPromise = null;
  let importExecutionCount = 0;
  let bootExecutionCount = 0;

  function startSandboxEntryOnce() {
    if (entryPromise) return entryPromise;
    const entryBridge = globalObject.__infiniteWorldEntryBridge;
    if (!entryBridge?.snapshot?.().reported) renderModuleBoot(hud);
    entryPromise = Promise.resolve()
      .then(async () => {
        importExecutionCount += 1;
        const sandboxModule = await importModule(moduleSpecifier);
        if (typeof sandboxModule?.startInfiniteWorldSandbox !== 'function') {
          throw new TypeError(`${moduleSpecifier} does not export startInfiniteWorldSandbox`);
        }
        bootExecutionCount += 1;
        const outcome = await sandboxModule.startInfiniteWorldSandbox();
        return Object.freeze({ ok: true, outcome });
      })
      .catch(error => Object.freeze({
        ok: false,
        error: renderModuleImportFailure({
          hud,
          error,
          moduleUrl,
          entryBridge,
        }),
      }));
    return entryPromise;
  }

  return Object.freeze({
    startSandboxEntryOnce,
    get promise() { return entryPromise; },
    snapshot: () => Object.freeze({
      started: entryPromise !== null,
      importExecutionCount,
      bootExecutionCount,
      moduleSpecifier,
      moduleUrl,
    }),
  });
}

if (typeof document !== 'undefined') {
  globalThis.__infiniteWorldEntryBridge?.markModuleStarted?.();
  const entry = createSandboxModuleEntry();
  const promise = entry.startSandboxEntryOnce();
  globalThis.__infiniteWorldHttpEntry = Object.freeze({
    promise,
    startSandboxEntryOnce: entry.startSandboxEntryOnce,
    snapshot: entry.snapshot,
  });
}
