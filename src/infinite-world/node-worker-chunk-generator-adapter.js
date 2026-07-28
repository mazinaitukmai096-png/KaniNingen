import { Worker } from 'node:worker_threads';

export function createNodeChunkGeneratorWorker() {
  return new Worker(new URL('./chunk-generator-node-worker.js', import.meta.url), { type: 'module' });
}
