import {
  bootInfiniteWorldSandbox,
  createSandboxBootState,
  createSandboxEntryController,
  recordSandboxBootFailure,
  snapshotSandboxBootState,
} from './sandbox-boot.js';

let sandboxStart = null;

function recreateBootError(outcome) {
  const error = new Error(outcome.error?.message || 'Infinite World sandbox boot failed');
  error.name = outcome.error?.name || 'Error';
  if (outcome.error?.stack) error.stack = outcome.error.stack;
  return error;
}

export function startInfiniteWorldSandbox({
  globalObject = globalThis,
  documentObject = globalObject.document,
} = {}) {
  if (sandboxStart) return sandboxStart;
  if (!documentObject) return Promise.reject(new TypeError('sandbox entry requires a document'));

  const bootState = createSandboxBootState();
  const hud = documentObject.querySelector('#hud');

  const entryController = createSandboxEntryController({
    documentObject,
    state: bootState,
    hud,
    async runSandboxBoot() {
      const viewport = documentObject.querySelector('#viewport');
      const sandbox = await bootInfiniteWorldSandbox({
        globalObject,
        THREE: globalObject.THREE,
        viewport,
        hud,
        state: bootState,
      });
      globalObject.__w1aSandbox = sandbox;
      globalObject.__infiniteWorldSandbox = sandbox;
      return sandbox;
    },
    handleBootFailure(error) {
      recordSandboxBootFailure({ state: bootState, hud, error });
    },
  });

  globalObject.__infiniteWorldBoot = Object.freeze({
    promise: entryController.promise,
    startSandboxOnce: entryController.startSandboxOnce,
    snapshot: () => Object.freeze({
      ...snapshotSandboxBootState(bootState),
      entry: entryController.snapshot(),
    }),
  });

  entryController.install();
  sandboxStart = entryController.promise.then(outcome => {
    if (!outcome.ok) throw recreateBootError(outcome);
    return outcome;
  });
  return sandboxStart;
}
