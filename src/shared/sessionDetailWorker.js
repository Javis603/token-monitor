'use strict';

const { parentPort, workerData } = require('node:worker_threads');

const { resolveSessionDetailForPlatform } = require('./sessionDetailResolver');

(async () => {
  try {
    const detail = await resolveSessionDetailForPlatform(workerData);
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
})();
