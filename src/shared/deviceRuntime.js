'use strict';

const { createDeviceState } = require('./deviceState');
const { createLimitsRuntime } = require('./limitsRuntime');
const { createUsageRuntime } = require('./usageRuntime');

let nextRuntimeEpoch = 1;
const SUPERSEDED_USAGE_DIAGNOSTIC_CODES = new Set(['subprocess-termination-unconfirmed']);

function createDeviceRuntime(options = {}, deps = {}) {
  const epoch = nextRuntimeEpoch++;
  const makeDeviceState = deps.createDeviceState || createDeviceState;
  const makeUsageRuntime = deps.createUsageRuntime || createUsageRuntime;
  const makeLimitsRuntime = deps.createLimitsRuntime || createLimitsRuntime;
  const sink = options.sink || null;
  let active = true;
  let usageGeneration = 0;

  function forwardDiagnosticEvent(event) {
    if (!active) return;
    try {
      options.onDiagnosticEvent?.(event);
    } catch (error) {
      try {
        options.onError?.(error, 'diagnostic');
      } catch {
        // Diagnostic observers must never block usage or limits delivery.
      }
    }
  }

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

  function usageRuntimeOptions(nextUsageOptions = {}, runtimeOptions = {}) {
    const generation = ++usageGeneration;
    const configured = {
      ...nextUsageOptions,
      ...runtimeOptions,
      onUpdate(summary, reason) {
        if (!active || generation !== usageGeneration) return;
        const transformed = options.transformUsage
          ? options.transformUsage(summary, reason, { preview: false })
          : summary;
        deviceState.updateUsage(transformed, reason, { epoch, preview: false });
        return transformed;
      },
      onDiagnosticEvent(event) {
        if (!active) return;
        if (
          generation !== usageGeneration
          && !SUPERSEDED_USAGE_DIAGNOSTIC_CODES.has(event?.code)
        ) return;
        try {
          nextUsageOptions?.onDiagnosticEvent?.(event);
        } catch (error) {
          try { options.onError?.(error, 'usage-diagnostic'); } catch (_) {}
        }
        forwardDiagnosticEvent(event);
      }
    };
    if (options.progressive === true) {
      configured.onPreview = (summary, reason = 'progress') => {
        if (!active || generation !== usageGeneration) return;
        const transformed = options.transformUsage
          ? options.transformUsage(summary, reason, { preview: true })
          : summary;
        deviceState.updateUsage(transformed, reason, { epoch, preview: true });
      };
    } else {
      delete configured.onPreview;
    }
    return configured;
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
    },
    onEvent(event) {
      if (!active) return;
      try {
        deps.limitsDeps?.onEvent?.(event);
      } catch (error) {
        try { options.onError?.(error, 'limits-diagnostic'); } catch (_) {}
      }
      if (event?.type === 'retry-scheduled') {
        forwardDiagnosticEvent({
          subsystem: 'limits',
          code: 'limits-retry-scheduled',
          provider: event.provider
        });
      }
    }
  };

  let activeUsageOptions = options.usageOptions || {};
  let usageRuntime = makeUsageRuntime(usageRuntimeOptions(activeUsageOptions), deps.usageDeps || {});
  const limitsRuntime = makeLimitsRuntime(limitsOptions, limitsDeps);

  function reconfigureUsage(nextUsageOptions = {}) {
    if (!active) return null;
    // Invalidating the generation before starting the replacement makes late
    // callbacks from a custom or non-cooperative collector harmless even if its
    // physical work takes longer to stop.
    usageGeneration += 1;
    const previousUsageRuntime = usageRuntime;
    previousUsageRuntime?.stop?.();
    let startBarrier = null;
    try {
      startBarrier = previousUsageRuntime?.whenIdle?.() || null;
    } catch (error) {
      try { options.onError?.(error, 'usage-stop'); } catch (_) {}
    }
    if (startBarrier) {
      startBarrier = Promise.resolve(startBarrier).catch((error) => {
        try { options.onError?.(error, 'usage-stop'); } catch (_) {}
      });
    }
    try {
      usageRuntime = makeUsageRuntime(
        usageRuntimeOptions(nextUsageOptions, startBarrier ? { startBarrier } : {}),
        deps.usageDeps || {}
      );
      activeUsageOptions = nextUsageOptions;
    } catch (error) {
      // Starting first would overlap the old and new collectors, including
      // their watcher descriptor sets. Restore the last known-good config
      // instead so a failed replacement cannot leave usage permanently dead.
      usageRuntime = makeUsageRuntime(
        usageRuntimeOptions(activeUsageOptions, startBarrier ? { startBarrier } : {}),
        deps.usageDeps || {}
      );
      throw error;
    }
    return true;
  }

  // Clearing `active` first is what severs the downstream callbacks; the child
  // stops are cleanup. `options` reaches the collector only: `skipCloseWatchers`
  // is its concern, not part of a teardown protocol the other two share.
  function stop(options = {}) {
    if (!active) return;
    active = false;
    deviceState.stop();
    usageRuntime?.stop?.(options);
    limitsRuntime?.stop?.();
    sink?.stop?.();
  }

  return {
    // clearLimits returns null after stop. Promise-based controls resolve to
    // their no-op sentinel without delegating to stopped producers.
    clearLimits: (scope, reason) => active ? limitsRuntime.clear(scope, reason) : null,
    flush: () => active ? (sink?.flush?.() || Promise.resolve()) : Promise.resolve(),
    getDiagnostics: () => ({
      usage: usageRuntime?.getDiagnostics?.() ?? null,
      limits: limitsRuntime?.getDiagnostics?.() ?? null
    }),
    getSnapshot: () => deviceState.getSnapshot(),
    reconfigureUsage,
    reconfigureLimits: (next) => active ? limitsRuntime.reconfigure(next) : null,
    refreshClient: (clientId, refreshOptions) => active
      ? usageRuntime.refreshClient(clientId, refreshOptions)
      : Promise.resolve(false),
    refreshLimits: (scope, reason) => active
      ? limitsRuntime.refresh(scope, reason)
      : Promise.resolve(false),
    stop,
    tick: (reason, tickOptions) => active
      ? usageRuntime.tick(reason, tickOptions)
      : Promise.resolve(false)
  };
}

module.exports = {
  createDeviceRuntime
};
