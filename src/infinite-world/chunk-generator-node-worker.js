import { parentPort } from 'node:worker_threads';
import { createChunkGeneratorWorkerCore } from './chunk-generator-worker-core.js';

if (!parentPort) throw new Error('Chunk generator Node worker requires parentPort');
const core = createChunkGeneratorWorkerCore({ postMessage: message => parentPort.postMessage(message) });
parentPort.on('message', message => { void core.receive(message); });
