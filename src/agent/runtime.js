'use strict';

const { createDeviceRuntime } = require('../shared/deviceRuntime');
const { createOrderedSink } = require('../shared/orderedSink');

function createAgentDeviceRuntime(options = {}, deps = {}, overrides = {}) {
  const makeDeviceRuntime = deps.createDeviceRuntime || createDeviceRuntime;
  const makeOrderedSink = deps.createOrderedSink || createOrderedSink;
  const sink = overrides.sink === undefined
    ? makeOrderedSink({
        send: options.deliver
      })
    : overrides.sink;

  return makeDeviceRuntime({
    envelope: options.envelope,
    limitsOptions: options.limitsOptions,
    usageOptions: overrides.usageOptions || options.usageOptions,
    transformUsage: options.transformUsage,
    sink,
    onRecord: overrides.onRecord || options.onRecord,
    onError: options.onError
  }, deps.deviceRuntimeDeps || {});
}

function runAgent(options = {}, deps = {}) {
  const runtime = createAgentDeviceRuntime(options, deps);
  options.onRuntime?.(runtime);
  return runtime;
}

async function runAgentOnce(options = {}, deps = {}) {
  let latestRecord = null;
  let usageSettled = false;
  let resolveUsage;
  let rejectUsage;
  const usageReady = new Promise((resolve, reject) => {
    resolveUsage = resolve;
    rejectUsage = reject;
  });
  const originalUsageError = options.usageOptions?.onError;
  const usageOptions = {
    ...(options.usageOptions || {}),
    onError(error, reason) {
      originalUsageError?.(error, reason);
      if (!usageSettled) {
        usageSettled = true;
        rejectUsage(error);
      }
    }
  };
  const dryRun = options.dryRun === true;
  const runtime = createAgentDeviceRuntime(options, deps, {
    usageOptions,
    sink: dryRun ? null : undefined,
    onRecord(record, meta) {
      latestRecord = record;
      options.onRecord?.(record, meta);
      if (meta.source === 'usage' && !usageSettled) {
        usageSettled = true;
        resolveUsage(record);
      }
    }
  });
  options.onRuntime?.(runtime);

  const initialLimits = Promise.resolve(runtime.refreshLimits({}, 'startup-once')).catch((error) => {
    options.onError?.(error, 'limits:startup-once');
    return null;
  });

  try {
    await usageReady;
    await initialLimits;
    if (dryRun && latestRecord) await options.deliver?.(latestRecord);
    await runtime.flush();
    return latestRecord;
  } finally {
    runtime.stop();
  }
}

module.exports = {
  runAgent,
  runAgentOnce
};
