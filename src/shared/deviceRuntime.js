'use strict';

const { createDeviceState } = require('./deviceState');
const { createLimitsRuntime } = require('./limitsRuntime');
const { createUsageRuntime } = require('./usageRuntime');

let nextRuntimeEpoch = 1;

function createDeviceRuntime(options = {}, deps = {}) {
  const epoch = nextRuntimeEpoch++;
  const makeDeviceState = deps.createDeviceState || createDeviceState;
  const makeUsageRuntime = deps.createUsageRuntime || createUsageRuntime;
  const makeLimitsRuntime = deps.createLimitsRuntime || createLimitsRuntime;
  const sink = options.sink || null;
  let active = true;

  const deviceState = makeDeviceState({
    epoch,
    envelope: options.envelope,
    ...(Object.prototype.hasOwnProperty.call(options, 'initialLimits')
      ? { initialLimits: options.initialLimits }
      : {}),
    onRecord(record, meta) {
      if (!active) return;
      try {
        options.onRecord?.(record, meta);
      } catch (error) {
        try {
          options.onError?.(error, 'record');
        } catch {
          // Optional observers must never block the delivery path.
        }
      }
      if (sink?.enqueue) {
        Promise.resolve(sink.enqueue(record, meta.revision)).catch((error) => {
          options.onError?.(error, 'sink');
        });
      }
    }
  });

  const usageOptions = {
    ...(options.usageOptions || {}),
    onUpdate(summary, reason) {
      if (!active) return;
      const transformed = options.transformUsage
        ? options.transformUsage(summary, reason, { preview: false })
        : summary;
      deviceState.updateUsage(transformed, reason, { epoch, preview: false });
    }
  };
  if (options.progressive === true) {
    usageOptions.onPreview = (summary, reason = 'progress') => {
      if (!active) return;
      const transformed = options.transformUsage
        ? options.transformUsage(summary, reason, { preview: true })
        : summary;
      deviceState.updateUsage(transformed, reason, { epoch, preview: true });
    };
  } else {
    delete usageOptions.onPreview;
  }
  const limitsOptions = {
    ...(options.limitsOptions || {}),
    ...(Object.prototype.hasOwnProperty.call(options, 'initialLimits')
      && !Object.prototype.hasOwnProperty.call(options.limitsOptions || {}, 'previousLimits')
      ? { previousLimits: options.initialLimits }
      : {})
  };
  const limitsDeps = {
    ...(deps.limitsDeps || {}),
    onUpdate(summary) {
      if (!active) return;
      deviceState.updateLimits(summary, 'limits', { epoch });
    }
  };

  const usageRuntime = makeUsageRuntime(usageOptions, deps.usageDeps || {});
  const limitsRuntime = makeLimitsRuntime(limitsOptions, limitsDeps);

  function stop() {
    if (!active) return;
    active = false;
    deviceState.stop();
    usageRuntime?.stop?.();
    limitsRuntime?.stop?.();
    sink?.stop?.();
  }

  return {
    clearLimits: (scope, reason) => limitsRuntime.clear(scope, reason),
    flush: () => sink?.flush?.() || Promise.resolve(),
    getSnapshot: () => deviceState.getSnapshot(),
    reconfigureLimits: (next) => limitsRuntime.reconfigure(next),
    refreshClient: (clientId, refreshOptions) => usageRuntime.refreshClient(clientId, refreshOptions),
    refreshLimits: (scope, reason) => limitsRuntime.refresh(scope, reason),
    stop,
    tick: (reason, tickOptions) => usageRuntime.tick(reason, tickOptions)
  };
}

module.exports = {
  createDeviceRuntime
};
