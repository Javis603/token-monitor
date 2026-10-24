'use strict';

// The Data Bus: one host-owned store of typed readings that plugin views,
// sandboxed plugin code and background alerts all read from. Sources sample
// only while something demands them, at the fastest interval any current
// demand asks for. Visible surfaces and background work file separate
// demands, so hiding every window leaves background alerts at their own slow
// cadence instead of either freezing them or keeping the UI rate alive.

const LIFECYCLES = Object.freeze(['visible', 'background']);
const DEFAULT_HISTORY = 120;

function createDataBus({
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  defer = queueMicrotask,
  historyLimit = DEFAULT_HISTORY,
  historyBytesLimit = 4 * 1024 * 1024,
  currentBytesLimit = 8 * 1024 * 1024,
  pluginHistoryBytesLimit = 1024 * 1024,
  pluginCurrentBytesLimit = 2 * 1024 * 1024,
  onError = () => {}
} = {}) {
  const sources = new Map();
  const demands = new Map();
  const aliases = new Map();
  const listeners = new Set();
  let pending = null;
  let disposed = false;
  let currentBytes = 0;
  let retainedBytes = 0;
  // Host sources and each plugin.<id>. namespace keep separate ledgers, and
  // all plugins together share a pool apart from the host. A plugin over its
  // quota fails only its own publishes and evicts only its own history.
  const ledgers = new Map();
  const newLedger = () => ({ currentBytes: 0, historyBytes: 0, samples: new Set() });
  let plugins = newLedger();
  const ownerOf = id => /^plugin\.[^.]+\./.exec(id)?.[0] || '';
  function ledgerFor(owner) {
    let ledger = ledgers.get(owner);
    if (!ledger) { ledger = newLedger(); ledgers.set(owner, ledger); }
    return ledger;
  }

  function entryFor(id) {
    let entry = sources.get(id);
    if (!entry) {
      const owner = ownerOf(id);
      entry = { id, owner, ledger: ledgerFor(owner), sample: null, minIntervalMs: 0, timer: null, intervalMs: 0, value: undefined, at: 0, sampledAt: null, history: [], historyBytes: 0, valueBytes: 0, sampling: false, generation: 0, reset: null, samples: 0, errors: 0 };
      sources.set(id, entry);
    }
    return entry;
  }

  function flush() {
    const changed = pending;
    pending = null;
    if (disposed || !changed) return;
    for (const listener of [...listeners]) {
      try { listener(changed); } catch (error) { onError(error); }
    }
  }

  // Coalesces every publish in one turn into a single notification.
  function notify(id) {
    if (pending) {
      pending.add(id);
      return;
    }
    pending = new Set([id]);
    defer(flush);
  }

  function forget(sample) {
    const { entry } = sample;
    if (!entry.ledger.samples.delete(sample)) return;
    entry.ledger.historyBytes -= sample.bytes;
    if (entry.owner) { plugins.samples.delete(sample); plugins.historyBytes -= sample.bytes; }
    retainedBytes -= sample.bytes;
    sample.entry.historyBytes -= sample.bytes;
    const index = sample.entry.history.indexOf(sample);
    if (index >= 0) sample.entry.history.splice(index, 1);
  }

  function record(entry, value, at) {
    const bytes = (JSON.stringify(value)?.length || 0) * 3, delta = bytes - entry.valueBytes;
    const { ledger, owner } = entry;
    if (bytes > 256 * 1024 || ledger.currentBytes + delta > (owner ? pluginCurrentBytesLimit : currentBytesLimit) || owner && plugins.currentBytes + delta > currentBytesLimit) throw new Error('plugin source storage budget exceeded');
    ledger.currentBytes += delta;
    if (owner) plugins.currentBytes += delta;
    currentBytes += delta;
    entry.valueBytes = bytes;
    entry.value = value;
    entry.at = at;
    // Only numeric histories are exposed. Do not retain drawing lists, text
    // or other large values merely to return a chart gap later.
    const project = (item, depth = 0) => {
      if (typeof item === 'number') return Number.isFinite(item) ? item : null;
      if (!item || Array.isArray(item) || typeof item !== 'object' || depth >= 4) return null;
      return Object.fromEntries(Object.entries(item).slice(0, 32).map(([key, child]) => [key, project(child, depth + 1)]));
    };
    const historical = project(value);
    const sample = { value: historical, at, entry, bytes: JSON.stringify(historical).length * 3 + 24 };
    entry.history.push(sample);
    entry.historyBytes += sample.bytes;
    ledger.samples.add(sample); ledger.historyBytes += sample.bytes;
    if (owner) { plugins.samples.add(sample); plugins.historyBytes += sample.bytes; }
    retainedBytes += sample.bytes;
    while (entry.history.length && (entry.history.length > historyLimit || entry.historyBytes > 32 * 1024)) forget(entry.history[0]);
    while (ledger.historyBytes > (owner ? pluginHistoryBytesLimit : historyBytesLimit) && ledger.samples.size) forget(ledger.samples.values().next().value);
    while (owner && plugins.historyBytes > historyBytesLimit && plugins.samples.size) forget(plugins.samples.values().next().value);
    notify(entry.id);
  }

  function effectiveInterval(id) {
    let interval = 0;
    for (const demand of demands.values()) {
      if (!demand.sources.has(id) && ![...demand.sources].some(source => aliases.get(source)?.source === id)) continue;
      interval = interval ? Math.min(interval, demand.intervalMs) : demand.intervalMs;
    }
    const entry = sources.get(id);
    return interval && entry ? Math.max(interval, entry.minIntervalMs) : interval;
  }

  async function runSample(entry) {
    if (entry.sampling || !entry.sample || disposed) return;
    entry.sampling = true;
    const generation = entry.generation;
    entry.samples += 1;
    // The cadence runs from the attempt, not from the last value: a sampler
    // that yields nothing (CPU priming, a failed read) must still wait.
    entry.sampledAt = now();
    try {
      const value = await entry.sample();
      if (value !== undefined && !disposed && generation === entry.generation && effectiveInterval(entry.id)) {
        record(entry, value, now());
        for (const [id, alias] of aliases) if (alias.source === entry.id && effectiveInterval(id)) {
          const projected = alias.project(value);
          if (projected !== undefined) record(entryFor(id), projected, now());
        }
      }
    } catch (error) {
      entry.errors += 1;
      onError(error);
    } finally {
      entry.sampling = false;
    }
  }

  function schedule(entry) {
    if (entry.timer) clearTimer(entry.timer);
    entry.timer = null;
    const interval = entry.sample ? effectiveInterval(entry.id) : 0;
    if (entry.intervalMs && !interval) { entry.generation++; entry.sampledAt = null; entry.reset?.(); }
    entry.intervalMs = interval;
    if (!interval || disposed || entry.sampling) return;
    const due = entry.sampledAt === null ? 0 : Math.max(0, entry.sampledAt + interval - now());
    entry.timer = setTimer(async function tick() {
      entry.timer = null;
      await runSample(entry);
      if (entry.intervalMs) schedule(entry);
    }, due);
    entry.timer?.unref?.();
  }

  function rescheduleAll(ids) {
    for (const id of new Set([...ids].map(id => aliases.get(id)?.source || id))) {
      const entry = sources.get(id);
      if (entry?.sample) schedule(entry);
    }
  }

  return {
    // A pull source sampled on demand; push sources are just published to.
    defineSource(id, { sample, reset, minIntervalMs = 1000 } = {}) {
      const entry = entryFor(id);
      entry.reset = typeof reset === 'function' ? reset : null;
      entry.sample = typeof sample === 'function' ? sample : null;
      entry.minIntervalMs = Math.max(0, minIntervalMs);
      schedule(entry);
    },
    defineAlias(id, source, project) {
      if (id === source || aliases.has(source) || typeof project !== 'function') throw new Error('invalid source alias');
      entryFor(id).minIntervalMs = sources.get(source)?.minIntervalMs || 0;
      aliases.set(id, { source, project });
    },
    publish(id, value, at = now()) {
      if (disposed) return;
      record(entryFor(id), value, at);
    },
    clearSourcesWithPrefix(prefix) {
      for (const [id, entry] of sources) {
        if (!id.startsWith(prefix)) continue;
        entry.generation++; entry.reset?.();
        if (entry.timer) clearTimer(entry.timer);
        for (const sample of [...entry.history]) forget(sample);
        currentBytes -= entry.valueBytes; entry.ledger.currentBytes -= entry.valueBytes;
        if (entry.owner) plugins.currentBytes -= entry.valueBytes;
        sources.delete(id);
      }
      const live = new Set([...sources.values()].map(entry => entry.owner));
      for (const owner of ledgers.keys()) if (!live.has(owner)) ledgers.delete(owner);
    },
    memoryUsage: () => ({ currentBytes, historyBytes: retainedBytes }),
    read(id) {
      const entry = sources.get(id);
      return entry && entry.value !== undefined ? { value: entry.value, at: entry.at } : null;
    },
    // The newest `count` readings, oldest first. `field` projects object
    // readings (sys.memory → percent); non-numbers become null so a chart
    // shows a gap rather than a fabricated zero.
    history(id, count = DEFAULT_HISTORY, field = '') {
      const entry = sources.get(id);
      if (!entry) return [];
      return entry.history.slice(-count).map(({ value }) => {
        const picked = field ? pickField(value, field) : value;
        return typeof picked === 'number' && Number.isFinite(picked) ? picked : null;
      });
    },
    historyPoints(id, count = DEFAULT_HISTORY, field = '') {
      const entry = sources.get(id);
      return (count > 0 ? (entry?.history || []).slice(-Math.min(DEFAULT_HISTORY, Math.floor(count))) : []).map(({ value, at }) => {
        const picked = field ? pickField(value, field) : value;
        return { at, value: typeof picked === 'number' && Number.isFinite(picked) ? picked : null };
      });
    },
    setDemand(consumer, { sources: ids = [], lifecycle = 'visible', intervalMs = 2000 } = {}) {
      const previous = demands.get(consumer);
      const next = {
        sources: new Set(ids),
        lifecycle: LIFECYCLES.includes(lifecycle) ? lifecycle : 'visible',
        intervalMs: Math.max(250, Math.round(intervalMs) || 2000)
      };
      if (next.sources.size) demands.set(consumer, next);
      else demands.delete(consumer);
      rescheduleAll(new Set([...(previous?.sources || []), ...next.sources]));
    },
    clearDemand(consumer) {
      const previous = demands.get(consumer);
      if (!previous) return;
      demands.delete(consumer);
      rescheduleAll(previous.sources);
    },
    clearDemandsWithPrefix(prefix) {
      const affected = new Set();
      for (const [consumer, demand] of demands) {
        if (!consumer.startsWith(prefix)) continue;
        demands.delete(consumer);
        for (const id of demand.sources) affected.add(id);
      }
      rescheduleAll(affected);
    },
    demandFor(consumer) {
      const demand = demands.get(consumer);
      return demand ? { sources: [...demand.sources], lifecycle: demand.lifecycle, intervalMs: demand.intervalMs } : null;
    },
    // Which lifecycles currently keep a source alive, for diagnostics and the
    // manager's "is anything visible" checks.
    sourceDemand(id) {
      const lifecycles = new Set();
      for (const demand of demands.values()) if (demand.sources.has(id)) lifecycles.add(demand.lifecycle);
      return { intervalMs: effectiveInterval(id), lifecycles: [...lifecycles] };
    },
    effectiveInterval,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stats() {
      return Object.fromEntries([...sources.values()].map((entry) => [entry.id, {
        intervalMs: entry.intervalMs, samples: entry.samples, errors: entry.errors, at: entry.at
      }]));
    },
    dispose() {
      disposed = true;
      for (const entry of sources.values()) if (entry.timer) clearTimer(entry.timer);
      sources.clear();
      ledgers.clear(); plugins = newLedger();
      currentBytes = 0;
      retainedBytes = 0;
      demands.clear();
      listeners.clear();
    }
  };
}

function pickField(value, field) {
  let current = value;
  for (const key of String(field).split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

module.exports = { LIFECYCLES, createDataBus, pickField };
