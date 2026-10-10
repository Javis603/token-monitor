'use strict';
const { parentPort } = require('node:worker_threads');
const { readTaskSpeedStats } = require('./taskSpeed');
parentPort.on('message', ({ id, args }) => {
  try { parentPort.postMessage({ id, result: readTaskSpeedStats(args) }); }
  catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
