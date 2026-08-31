'use strict';

// One-shot worker entry: decrypts the Trae CN database and reads chat_turn rows
// off the Electron main thread. The decrypt is ~2s of synchronous CPU + 400MB of
// IO, which froze the widget on every collect when it ran in-process. Runs the
// same collectTraeSnapshot() the in-process fallback uses, then exits.

const { parentPort, workerData } = require('node:worker_threads');

const { collectTraeSnapshot } = require('./traeUsage');

try {
  const result = collectTraeSnapshot(workerData);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      name: error?.name,
      message: error?.message,
      code: error?.code,
      stack: error?.stack
    }
  });
}
