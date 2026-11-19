'use strict';

const { parentPort, threadId, workerData } = require('node:worker_threads');

parentPort.postMessage({ ok: true, detail: { ...workerData, threadId } });
