'use strict';

async function runManualDeviceRefresh(runtime, options = {}) {
  if (!runtime) return;
  const limitsTask = Promise.resolve(runtime.refreshLimits({ all: true }, 'manual'));
  limitsTask.catch((error) => options.onLimitsError?.(error));
  await runtime.tick('manual', { forceHistory: options.forceHistory === true });
}

module.exports = {
  runManualDeviceRefresh
};
