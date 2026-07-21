'use strict';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const PARTIAL_USAGE_CARRY_FIELDS = Object.freeze([
  'month',
  'allTime',
  'clientStatus',
  'wslStatus',
  'periodWindows',
  'projectsEnabled',
  'allTimeProjectsOmitted',
  'allTimeProjectsIncomplete',
  'sessionDetailsOmitted',
  'periodProjectsOmitted',
  'syncUploadIntervalMs'
]);

function cloneValue(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const entry of value) copy.push(cloneValue(entry, seen));
    return copy;
  }
  const copy = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) copy[key] = cloneValue(entry, seen);
  return copy;
}

function normalizedEnvelope(value) {
  const envelope = {};
  for (const [key, entry] of Object.entries(value || {})) {
    if (entry !== undefined) envelope[key] = cloneValue(entry);
  }
  return envelope;
}

function mergeUsagePart(previous, incoming) {
  const next = cloneValue(incoming || {});
  delete next.limits;
  if (!previous) return next;

  if (!hasOwn(next, 'history') && hasOwn(previous, 'history')) {
    next.history = cloneValue(previous.history);
  }

  const partial = !hasOwn(next, 'month') || !hasOwn(next, 'allTime');
  if (partial) {
    for (const field of PARTIAL_USAGE_CARRY_FIELDS) {
      if (!hasOwn(next, field) && hasOwn(previous, field)) {
        next[field] = cloneValue(previous[field]);
      }
    }
  }
  return next;
}

function createDeviceState(options = {}) {
  const epoch = options.epoch ?? 0;
  const envelope = normalizedEnvelope(options.envelope);
  const onRecord = typeof options.onRecord === 'function' ? options.onRecord : null;
  let usagePart = null;
  let limitsPart = hasOwn(options, 'initialLimits') ? cloneValue(options.initialLimits) : undefined;
  let currentRecord = null;
  let hasCompleteUsageBaseline = false;
  let revision = 0;
  let stopped = false;

  function accepts(meta) {
    if (stopped) return false;
    return !hasOwn(meta, 'epoch') || meta.epoch === epoch;
  }

  function publish(source, reason) {
    if (!usagePart || stopped) return null;
    const record = { ...cloneValue(usagePart), ...cloneValue(envelope) };
    if (limitsPart !== undefined) record.limits = cloneValue(limitsPart);
    currentRecord = record;
    revision += 1;
    const meta = { revision, source, reason, epoch };
    if (onRecord) onRecord(cloneValue(record), meta);
    return cloneValue(record);
  }

  function updateUsage(summary, reason = 'usage', meta = {}) {
    if (!accepts(meta)) return null;
    usagePart = mergeUsagePart(usagePart, summary);
    if (hasOwn(usagePart, 'month') && hasOwn(usagePart, 'allTime')) {
      hasCompleteUsageBaseline = true;
    }
    if (meta.preview === true && !hasCompleteUsageBaseline) return null;
    return publish('usage', reason);
  }

  function updateLimits(limits, reason = 'limits', meta = {}) {
    if (!accepts(meta)) return null;
    limitsPart = cloneValue(limits);
    return publish('limits', reason);
  }

  function getSnapshot() {
    return currentRecord ? cloneValue(currentRecord) : null;
  }

  function stop() {
    stopped = true;
  }

  return {
    getSnapshot,
    stop,
    updateLimits,
    updateUsage
  };
}

module.exports = {
  createDeviceState
};
