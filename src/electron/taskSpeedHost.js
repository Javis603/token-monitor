'use strict';
const { Worker } = require('node:worker_threads');
let worker;
let sequence = 0;
const pending = new Map();

function readTaskSpeedStats(args) {
  if (!worker) {
    const instance = new Worker(require.resolve('../shared/taskSpeedWorker'));
    worker = instance;
    instance.unref();
    let stopped = false;
    const fail = error => {
      if (stopped) return;
      stopped = true;
      for (const [id, request] of pending) {
        if (request.worker !== instance) continue;
        clearTimeout(request.timer);
        pending.delete(id);
        request.reject(error);
      }
      if (worker === instance) worker = null;
    };
    instance.fail = fail;
    instance.on('message', ({ id, result, error }) => {
      const request = pending.get(id);
      if (!request || request.worker !== instance) return;
      pending.delete(id);
      clearTimeout(request.timer);
      if (error) request.reject(new Error(error)); else request.resolve(result);
    });
    instance.on('error', fail);
    instance.on('exit', () => fail(new Error('Task reader stopped')));
  }
  const instance = worker;
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      instance.fail(new Error('Task speed data timed out'));
      void instance.terminate().catch(() => {});
    }, 60000);
    pending.set(id, { resolve, reject, timer, worker: instance });
    try { instance.postMessage({ id, args }); }
    catch (error) {
      instance.fail(error);
      void instance.terminate().catch(() => {});
    }
  });
}
module.exports = { readTaskSpeedStats };
