'use strict';
const { performance } = require('node:perf_hooks');
const { setImmediate: immediate } = require('node:timers/promises');
const { sessionEntries, sessionFields, projectSessionActivity, sessionModelMatches, matchesRow, compareRows } = require('../../shared/plugins/businessData');

// Conservative admission accounting, not a V8 heap measurement. The shared
// ledger charges source maps and raw rows; each index charges its own keys,
// locators, merge arrays and page/serialization scratch.
const RESERVATION_BYTES = 32 * 1024 * 1024;
const PAGE_SCRATCH_BYTES = 1024 * 1024;
const MAX_ROW_BYTES = 256 * 1024;
const MAX_WORK = 2000000;
const MAX_ROWS = 100000;
function* backingCost(value, depth = 0) {
  if (typeof value === 'string') { yield 24 + value.length * 2; return; }
  if (!value || typeof value !== 'object') { yield 16; return; }
  if (depth > 20) throw new Error('budgetExceeded');
  yield 64;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    yield 32 + key.length * 2;
    yield* backingCost(value[key], depth + 1);
  }
}
// A lease pins complete immutable maps, including filtered-out raw fields. Map
// storage is charged once; identical COW row objects share a physical charge.
// Weak measurement caches do not themselves keep host rows alive. Nested objects
// shared by *different* row objects are conservatively counted more than once.
function createSessionBacking({ admit = () => {} } = {}) {
  const sources = new Map(), generations = new Map(), measurements = new WeakMap(), ids = new WeakMap();
  let nextId = 0, bytes = 0, measuredRows = 0;
  const add = amount => {
    if (bytes + amount > 128 * 1024 * 1024) throw new Error('budgetExceeded');
    admit(amount); bytes += amount;
  };
  function release(lease) {
    if (lease.released) return;
    lease.released = true;
    const generation = lease.generation;
    const pins = generation.plugins.get(lease.pluginId) - 1;
    if (pins) generation.plugins.set(lease.pluginId, pins); else generation.plugins.delete(lease.pluginId);
    if (!generation.plugins.size) generations.delete(generation.key);
    for (const state of lease.sources) {
      state.leases.delete(lease);
      if (state.leases.size || state.running) continue;
      discard(state);
    }
    lease.sources = [];
  }
  function discard(state) {
    sources.delete(state.source);
    state.source = null;
    bytes -= state.bytes;
    for (const row of state.rows) if (--row.pins === 0) bytes -= row.bytes;
    state.rows.clear();
  }
  async function measure(state) {
    let steps = 0, start = performance.now();
    const reader = () => {
      let error;
      for (const lease of state.leases) {
        try { lease.check(); lease.validate(state); return lease; } catch (failure) { error = failure; }
      }
      throw error || new Error('denied');
    };
    const charge = () => reader().charge(performance.now() - start);
    const checkpoint = async () => {
      charge(); await immediate(); reader(); start = performance.now(); steps = 0;
    };
    const due = () => ++steps >= 128 || performance.now() - start >= 4;
    try {
      await checkpoint();
      for (const key in state.source) {
        if (!Object.hasOwn(state.source, key)) continue;
        if (++state.count > MAX_ROWS) throw new Error('budgetExceeded');
        reader();
        const value = state.source[key];
        // Source keys, hash slots and ledger membership are retained even when
        // every query filters the row out. Bound enormous source keys as well.
        const keyBytes = 192 + key.length * 2;
        if (keyBytes > MAX_ROW_BYTES) throw new Error('budgetExceeded');
        add(keyBytes); state.bytes += keyBytes;
        const object = value && typeof value === 'object';
        let row = object ? measurements.get(value) : null;
        if (!row) {
          let rowBytes = 0;
          for (const cost of backingCost(value)) {
            if (++state.work > MAX_WORK || (rowBytes += cost) + keyBytes > MAX_ROW_BYTES) throw new Error('budgetExceeded');
            if (due()) await checkpoint();
          }
          // Another COW map may have finished measuring this row while we yielded.
          row = object && measurements.get(value) || { bytes: rowBytes, pins: 0 };
          if (object) measurements.set(value, row);
          measuredRows++;
        }
        if (row.bytes + keyBytes > MAX_ROW_BYTES) throw new Error('budgetExceeded');
        if (!state.rows.has(row)) {
          if (!row.pins) add(row.bytes);
          row.pins++; state.rows.add(row);
        }
        if (due()) await checkpoint();
      }
      await checkpoint();
    } finally {
      // On cancellation, a final owner may already have gone away.
      try { charge(); } catch { /* No remaining CPU account. */ }
      state.running = false;
      if (!state.leases.size) discard(state);
    }
  }
  function pin(plan, pluginId, callbacks) {
    const maps = [...new Set(plan.contexts.flatMap(c => [c.sessions, c.sessionActivity]).filter(Boolean))];
    if (maps.length > 5000) throw new Error('budgetExceeded');
    const key = maps.map(map => { if (!ids.has(map)) ids.set(map, ++nextId); return ids.get(map); }).sort((a, b) => a - b).join(',');
    let generation = generations.get(key);
    // Four distinct captured map sets per plugin, eight across the service.
    // Multiple queries/authorities share a pin entitlement, never their DTOs.
    if (!generation?.plugins.has(pluginId) && [...generations.values()].filter(g => g.plugins.has(pluginId)).length >= 4) throw new Error('budgetExceeded');
    if (!generation && generations.size >= 8) throw new Error('budgetExceeded');
    if (!generation) generations.set(key, generation = { key, plugins: new Map() });
    generation.plugins.set(pluginId, (generation.plugins.get(pluginId) || 0) + 1);
    let rows = 0, work = 0;
    const visited = new Map();
    const lease = { ...callbacks, pluginId, generation, sources: [], released: false,
      validate(state) {
        const previous = visited.get(state) || { count: 0, work: 0 };
        rows += state.count - previous.count; work += state.work - previous.work;
        visited.set(state, { count: state.count, work: state.work });
        if (rows > MAX_ROWS || work > MAX_WORK) throw new Error('budgetExceeded');
      },
      detach() { lease.check = () => {}; lease.charge = () => {}; visited.clear(); },
      async ready() {
        for (const state of lease.sources) {
          lease.check();
          if (!state.promise) { state.running = true; state.promise = measure(state); }
          await state.promise;
          lease.check(); lease.validate(state);
        }
      }, release() { release(lease); } };
    try {
      for (const source of maps) {
        let state = sources.get(source);
        if (!state) {
          add(256);
          sources.set(source, state = { source, count: 0, work: 0, bytes: 256, rows: new Set(), leases: new Set(), running: false });
        }
        state.leases.add(lease); lease.sources.push(state);
      }
      return lease;
    } catch (error) { release(lease); throw error; }
  }
  return { pin, bytes: () => bytes,
    usage: () => ({ bytes, sources: sources.size, generations: generations.size, measuredRows }) };
}
function isLargeSessionPlan(plan) {
  let count = 0;
  for (const locator of sessionEntries(plan)) {
    void locator;
    if (++count > 5000) return true;
  }
  return false;
}
async function buildSessionIndex(plan, query, opaque, { check, charge, lease, reserve = () => {} }) {
  await lease.ready(); // Source work has its own meter; do not charge its await twice.
  let steps = 0, rowCount = 0;
  let bytes = PAGE_SCRATCH_BYTES, start = performance.now();
  const checkpoint = async () => {
    charge(performance.now() - start);
    check();
    await immediate(); // A microtask alone would starve IPC and cancellation.
    check(); start = performance.now(); steps = 0;
  };
  const due = () => ++steps >= 128 || performance.now() - start >= 4;
  const rows = [];
  try {
    await checkpoint();
    for (const locator of sessionEntries(plan)) {
      if (++rowCount > MAX_ROWS) throw new Error('budgetExceeded');
      const fields = sessionFields(locator, plan, opaque);
      if (matchesRow(fields, query, query.filter.model === undefined ? undefined : sessionModelMatches(locator.session, query.filter.model))) {
        // Locators retain scalar context only. The separate lease owns the
        // complete selected maps; neither retains unrelated host stats.
        const context = { scopeKey: locator.context.scopeKey, base: locator.context.base };
        // Resolve once for this immutable index. The lease also charges and
        // pins the captured overlay map, including unprojected observations.
        const liveActivity = locator.context.sessionActivity ? projectSessionActivity(locator) : undefined;
        const value = query.sort.field === 'knownUsd' ? fields.cost.knownUsd : fields[query.sort.field];
        const key = { id: fields.id, [query.sort.field]: value };
        if (query.sort.field === 'knownUsd') key.cost = { knownUsd: value };
        const activityBytes = liveActivity ? 160 + (liveActivity.state?.length || 0) * 2 + (liveActivity.observedAt?.length || 0) * 2 : 0;
        const indexBytes = 256 + activityBytes + fields.id.length * 2 + (typeof value === 'string' ? value.length * 2 : 16);
        bytes += indexBytes;
        if (bytes > RESERVATION_BYTES) throw new Error('budgetExceeded');
        reserve(bytes);
        rows.push({ locator: { session: locator.session, key: locator.key, context, liveActivity }, key, ordinal: rowCount });
      }
      if (due()) await checkpoint();
    }
    const order = (a, b) => compareRows(a.key, b.key, query) || a.ordinal - b.ordinal;
    // Bounded native runs followed by incremental stable bottom-up merge.
    let sorted = [], scratch = new Array(rows.length);
    for (let i = 0; i < rows.length; i += 128) {
      sorted.push(...rows.slice(i, i + 128).sort(order));
      await checkpoint();
    }
    for (let width = 128; width < rows.length; width *= 2) {
      for (let left = 0; left < rows.length; left += width * 2) {
        const mid = Math.min(left + width, rows.length), end = Math.min(mid + width, rows.length);
        let a = left, b = mid;
        for (let out = left; out < end; out++) {
          scratch[out] = a < mid && (b >= end || order(sorted[a], sorted[b]) <= 0) ? sorted[a++] : sorted[b++];
          if (due()) await checkpoint();
        }
      }
      [sorted, scratch] = [scratch, sorted];
    }
    await checkpoint();
    return { rows: sorted, bytes,
      plan: { identities: plan.identities, titles: plan.titles },
      availability: plan.availability, redacted: plan.redacted, incomplete: plan.incomplete };
  } finally { charge(performance.now() - start); }
}
module.exports = { createSessionBacking, buildSessionIndex, isLargeSessionPlan, RESERVATION_BYTES, PAGE_SCRATCH_BYTES };
