'use strict';

// Stands in for a chokidar watcher that fails with a descriptor-exhaustion
// error, so the host's error rebuilding can be tested without exhausting the
// real per-user watch budget.
const { parentPort } = require('node:worker_threads');

parentPort.postMessage({ type: 'ready' });
parentPort.postMessage({ type: 'error', message: 'ENOSPC: no space left on device, watch', code: 'ENOSPC' });
parentPort.on('message', (message) => {
  if (message?.type !== 'close') return;
  parentPort.postMessage({ type: 'closed' });
  parentPort.close();
});
