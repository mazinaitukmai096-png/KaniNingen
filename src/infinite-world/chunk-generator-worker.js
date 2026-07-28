import { createChunkGeneratorWorkerCore } from './chunk-generator-worker-core.js';

const core = createChunkGeneratorWorkerCore({
  postMessage: message => globalThis.postMessage(message),
});

globalThis.addEventListener('message', event => {
  void core.receive(event.data);
});
