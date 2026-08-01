'use strict';

const { parentPort, workerData } = require('node:worker_threads');

const { resolveSessionDetailForPlatform } = require('./sessionDetailResolver');

try {
  const detail = resolveSessionDetailForPlatform(workerData);
  parentPort.postMessage({ ok: true, detail });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      name: error?.name,
      message: error?.message,
      stack: error?.stack
    }
  });
}
