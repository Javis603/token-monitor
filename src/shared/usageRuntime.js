'use strict';

const { startCollector } = require('./collector');

function createUsageRuntime(options = {}, deps = {}) {
  const start = typeof deps.startCollector === 'function' ? deps.startCollector : startCollector;
  return start(options);
}

module.exports = {
  createUsageRuntime
};
