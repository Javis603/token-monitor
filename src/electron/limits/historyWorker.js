'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createHistoryDatabase } = require('./historyDatabase');
let database;
function report(error) { parentPort.postMessage({ error: error.message }); }
parentPort.on('message', ({ id, method, args, shutdown }) => {
  try {
    database ||= createHistoryDatabase(workerData.filePath, { onError: report });
    let result;
    if (method === 'close') database.close();
    else if (method === 'flush') result = true; // Earlier messages have already committed.
    else result = database[method](...args);
    if (id) parentPort.postMessage({ id, result });
    if (method === 'close') parentPort.close();
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
  finally {
    if (shutdown) { Atomics.store(new Int32Array(shutdown), 0, 1); Atomics.notify(new Int32Array(shutdown), 0); }
  }
});
