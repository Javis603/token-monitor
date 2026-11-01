'use strict';

const { performance } = require('node:perf_hooks');
const { createHmac, randomBytes } = require('node:crypto');
const { CURRENCY_CODES } = require('../../shared/currency');
const { normalizeQuery, projectResource, sessionSources, projectSessionRow, matchesRow, compareRows } = require('../../shared/plugins/businessData');

const { setImmediate: immediate } = require('node:timers/promises');
const { createSessionBacking, buildSessionIndex, isLargeSessionPlan, PAGE_SCRATCH_BYTES } = require('./lazySessions');
const { createLiveRateResource } = require('./liveRate');

// Loaders reuse host-owned caches/resolvers. History may read the authenticated
// host history endpoint. They never collect, probe providers, refresh credentials,
// or bypass the host scheduler. Their result belongs to one source/
// resource revision; a late result is discarded. No timers or loaders exist without demand.
function createBusinessDataService({ identitySecret = randomBytes(32), loadHistory, loadAllTime, loadSubscriptions, now = Date.now, snapshotTtlMs = 60000, maxPayloadBytes = 56 * 1024 } = {}) {
  maxPayloadBytes = Math.max(1024, Math.min(56 * 1024, maxPayloadBytes));
  let latest = { stats: null, extras: {}, revision: 0, sourceGeneration: 0, loaderVersions: {}, deviceScopes: new Map() };
  let disposed = false;
  let sequence = 0;
  const snapshots = new Map(), subscriptions = new Map(), epochs = new Map(), loaders = new Map();
  const projections = new Map(), budgets = new Map();
  const requests = new Set(), builds = new Map(), pagePins = new Map();
  const liveRates = createLiveRateResource({ now, onChange: () => {
    latest = { ...latest, revision: latest.revision + 1 };
    for (const s of subscriptions.values()) if (s.query.resource === 'liveRate') {
      const stamp = dependency(latest, s.query, s.pluginId);
      if (stamp !== s.stamp) { s.stamp = stamp; invalidate(s); }
    }
  } });
  const backing = createSessionBacking({ admit(bytes) {
    if (backing.bytes() + lazyBytes() + bytes > 128 * 1024 * 1024) throw new Error('budgetExceeded');
  } });
  function deleteSnapshot(id) {
    const snapshot = snapshots.get(id);
    snapshots.delete(id);
    if (snapshot?.lease && !pagePins.has(snapshot)) snapshot.lease.release();
  }
  const objectIds = new WeakMap();
  let objectSequence = 0;
  // Host snapshots are immutable. Dependency keys only inspect shallow metadata
  // and references: publishing without readers never walks a collection.
  const ref = value => {
    if (!value || typeof value !== 'object') return value ?? null;
    if (!objectIds.has(value)) objectIds.set(value, ++objectSequence);
    return objectIds.get(value);
  };
  const usageFields = 'totalTokens tokens costUsd cost totalCost unpricedTokens inputTokens outputTokens cacheReadTokens cacheWriteTokens reasoningTokens unclassifiedTokens messageCount timedTokens timedOutputTokens timedDurationMs contextTokens contextWindow activeTimeMs tokenComponentsAvailable';
  const fields = (value, names) => names.split(' ').map(name => ref(value?.[name]));
  const periodResources = ['usage', 'models', 'tools', 'sessions', 'projects'];
  function loaderDependency(captured, name) {
    const e = captured.extras;
    return JSON.stringify([e.sourceId || 'default', e.identityEpoch || '1', name,
      name === 'history' ? [e.historyRevision ?? (e.history !== undefined ? null : ref(captured.stats)), e.preferences?.historyEnabled]
        : name === 'allTime' ? e.allTimeRevision ?? (e.allTime !== undefined ? null : ref(captured.stats))
          : e.subscriptionsRevision ?? (e.subscriptions !== undefined ? null : ref(captured.stats)), ref(e[name])]);
  }
  const loaderRevision = (captured, name) => `${name}:${captured.loaderVersions[name] ?? 0}`;
  function dependency(captured, q, pluginId) {
    const { stats, extras: e } = captured;
    const base = [captured.sourceGeneration, e.sourceId || 'default', e.identityEpoch || '1', !!stats, q.resource, q.period];
    if (q.resource === 'liveRate') return JSON.stringify([...base, liveRates.revision(liveRateScope(captured, q, pluginId))]);
    if (q.resource === 'history') return JSON.stringify([...base, loaderRevision(captured, 'history'), ref(stats?.history)]);
    if (q.resource === 'subscriptions') return JSON.stringify([...base, loaderRevision(captured, 'subscriptions'), ref(stats?.subscriptions), e.subscriptionContext?.date, CURRENCY_CODES.map(code => e.subscriptionContext?.rates?.[code]), stats?.stale, ref(stats?.limits)]);
    if (q.resource === 'status') return JSON.stringify([...base, ref(stats?.devices), stats?.updatedAt, stats?.projectsIncomplete, fields(e.status, 'collection sync availability'), fields(e.preferences, 'currency timeZone locale sessionTitlesEnabled historyEnabled projectsEnabled')]);
    if (q.resource === 'devices') return JSON.stringify([...base, ref(stats?.devices)]);
    const sourceParts = source => {
      const p = source?.periods?.[q.period];
      // Accounting timestamps alone do not restart traversal. Reused pages keep
      // their original collectedAt/asOf; status/devices expose current freshness.
      const meta = [source?.deviceId, source?.stale, !!p];
      if (q.resource === 'limits') return [source?.deviceId, ref(source?.limits)];
      if (q.resource === 'usage') return [...meta, fields(p, usageFields), fields(p?.capabilities, 'tokenComponents throughput'), ref(source?.periodWindows)];
      if (q.resource === 'models' || q.resource === 'tools') {
        const prefix = q.resource === 'models' ? 'model' : 'client';
        return [...meta, p?.unpricedTokens, fields(p, 'costUsd cost totalCost'), ref(p?.[prefix === 'model' ? 'models' : 'clients']), fields(p, `${prefix}Costs ${prefix}UnpricedTokens ${prefix}CacheReads ${prefix}CacheWrites ${prefix}Outputs ${prefix}UnclassifiedTokens modelThroughput clientModels clientModelCosts`)];
      }
      if (q.resource === 'sessions') return [...meta, ref(p?.sessions), ref(p?.sessionActivity), ref(source?.sessionDetailsOmitted)];
      return [...meta, ref(p?.projects), fields(source, 'projectsIncomplete periodProjectsOmitted projectsEnabled allTimeProjectsOmitted allTimeProjectsIncomplete')];
    };
    return JSON.stringify([...base, sourceParts(stats), (stats?.devices || []).map(sourceParts),
      q.resource === 'sessions' ? e.preferences?.sessionTitlesEnabled !== false : null,
      q.period === 'allTime' && periodResources.includes(q.resource) ? loaderRevision(captured, 'allTime') : null]);
  }
  const live = (q, stamp, pluginId) => !disposed && dependency(latest, q, pluginId) === stamp;
  // Traversal is immutable, including when a Hub sends fresh JSON objects.
  // Relevant data changes invalidate subscriptions/new first pages, but cannot
  // restart an admitted traversal. Privacy/source changes are immediate fences.
  const cursorFence = (captured, q) => JSON.stringify([captured.sourceGeneration,
    q.resource === 'liveRate' ? fields(captured.extras.liveRateContext, 'hubMode deviceId clients') : null,
    q.resource === 'sessions' ? captured.extras.preferences?.sessionTitlesEnabled !== false : null,
    q.resource === 'history' ? captured.extras.preferences?.historyEnabled !== false : null,
    q.resource === 'projects' ? captured.extras.preferences?.projectsEnabled !== false : null]);
  // These are admission limits, not silent truncation. Rows beyond the bound
  // need a narrower device scope (or a future host-side paging adapter).
  const MAX_COLLECTION_ROWS = 5000, MAX_COLLECTION_BYTES = 8 * 1024 * 1024;
  const MAX_OWNER_BYTES = 12 * 1024 * 1024, MAX_TOTAL_BYTES = 64 * 1024 * 1024;
  function admit(pluginId, cost) {
    let b = budgets.get(pluginId);
    if (!b) {
      if (budgets.size >= 128) {
        for (const [id, entry] of budgets) if (now() - entry.at > 60000) budgets.delete(id);
        if (budgets.size >= 128) throw new Error('budgetExceeded');
      }
      budgets.set(pluginId, b = { tokens: 24, at: now() });
    }
    b.tokens = Math.min(24, b.tokens + Math.max(0, now() - b.at) * 4 / 1000);
    b.at = now();
    // A cache miss pays a fixed token. Cached projections only pay measured
    // filter/sort work, but must still have headroom before starting that work.
    if (b.tokens < 1) throw Object.assign(new Error('rateLimited'), { retryAfterMs: Math.ceil((1 - b.tokens) * 1000 / 4) });
    b.tokens -= cost;
    return b;
  }
  function preflight(stats, extras, q, opaque) {
    let count = 0, work = 0;
    function inspect(value, top = false, depth = 0) {
      if (!value || typeof value !== 'object') return;
      if (depth > 24) throw new Error('budgetExceeded');
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (++work > 200000 || (top && ++count > MAX_COLLECTION_ROWS)) throw new Error('budgetExceeded');
        // Bound nested models/providers/windows before allocating DTO arrays.
        const child = value[key];
        if (child && typeof child === 'object') inspect(child, false, depth + 1);
      }
    }
    const restricted = !!q.filter.deviceId;
    const allowed = d => !q.filter.deviceId || q.filter.deviceId === opaque('device', d.deviceId);
    const devices = stats?.devices || [];
    if (devices.length > MAX_COLLECTION_ROWS) throw new Error('budgetExceeded');
    let sources = restricted ? devices.filter(allowed) : [stats];
    if (q.resource === 'sessions') {
      for (const context of sessionSources(stats, extras, q, opaque).contexts) {
        inspect(context.sessions, true);
        inspect(context.sessionActivity);
      }
      return;
    }
    if (periodResources.includes(q.resource)) {
      for (const source of sources) {
        const p = !restricted && source === stats && q.period === 'allTime' && extras.allTime ? { ...source?.periods?.allTime, ...extras.allTime } : source?.periods?.[q.period];
        const name = { models: 'models', tools: 'clients', sessions: 'sessions', projects: 'projects' }[q.resource];
        if (name) inspect(p?.[name], true);
        if (q.resource === 'tools') inspect(p?.clientModels);
      }
    } else if (q.resource === 'history') {
      const h = extras.history ?? stats?.history;
      const buckets = q.resolution === 'summary' ? [h?.summary] : h?.[q.resolution];
      if (q.groupBy === 'none') inspect(buckets, true);
      else {
        if ((buckets?.length || 0) > MAX_COLLECTION_ROWS) throw new Error('budgetExceeded');
        for (const bucket of buckets || []) inspect(bucket?.[q.groupBy === 'client' ? 'perClient' : 'perModel'], true);
      }
    } else if (q.resource === 'subscriptions') {
      const d = extras.subscriptions ?? stats?.subscriptions;
      inspect(Array.isArray(d) ? d : d?.subscriptions, true);
      // Forecast matching traverses the complete source account set.
      inspect(stats?.limits?.providers, true);
    } else if (q.resource === 'limits') {
      for (const source of sources) inspect(source?.limits?.providers, true);
    } else if (q.resource === 'status') {
      for (const d of devices.filter(allowed)) inspect(d.clientHealth);
    }
  }
  const snapshotPriority = s => s.traversed ? 2 : live(s.query, s.stamp, s.pluginId) ? 1 : 0;
  function retainProjection(value) {
    // Retire obsolete first-page caches before an admitted traversal. When all
    // candidates are traversed, original creation order remains the fallback.
    // Only this plugin's entries are candidates, even at global saturation.
    const traversed = new Set([...snapshots.values()].filter(s => s.traversed).map(s => s.projectionId));
    const priority = p => traversed.has(p.id) ? 2 : live(p.query, p.stamp, p.pluginId) ? 1 : 0;
    const own = [...projections.values()].filter(p => p.pluginId === value.pluginId).sort((a, b) => priority(a) - priority(b));
    let ownBytes = own.reduce((n, p) => n + p.bytes, 0);
    while (own.length && (own.length >= 4 || ownBytes + value.bytes > MAX_OWNER_BYTES)) {
      const old = own.shift(); ownBytes -= old.bytes; projections.delete(old.id);
      for (const [id, s] of snapshots) if (s.projectionId === old.id) deleteSnapshot(id);
    }
    if ([...projections.values()].reduce((n, p) => n + p.bytes, 0) + value.bytes > MAX_TOTAL_BYTES) throw new Error('budgetExceeded');
    if (projections.size >= 512) throw new Error('budgetExceeded');
    lazyAdmission(value.pluginId, value.bytes);
    projections.set(value.id, value);
  }
  const sign = value => createHmac('sha256', identitySecret).update(JSON.stringify(value)).digest('base64url');
  const currentAuth = value => typeof value === 'function' ? value() : value;
  function authority(value) {
    const a = currentAuth(value);
    if (!a || a.active !== true || typeof a.pluginId !== 'string' || !a.pluginId) throw new Error('denied');
    return { pluginId: a.pluginId, active: true, revision: a.revision ?? null, epoch: epochs.get(a.pluginId) || 0 };
  }
  // Binds plugin ownership and generation; this is not a password hash.
  const authorityFingerprint = a => sign(a);
  const queryKey = q => sign({ ...q, page: { limit: q.page.limit } });
  function liveRateScope(captured, q, pluginId) {
    if (!q.filter.deviceId) return null;
    let scopes = captured.deviceScopes.get(pluginId);
    if (!scopes) {
      // Resolve opaque IDs once per plugin and captured source, not once per
      // subscription/dependency check. A publication replaces this snapshot.
      const identity = [pluginId, captured.extras.sourceId || 'default', captured.extras.identityEpoch || '1', 'device'];
      scopes = new Map((captured.stats?.devices || []).map(d => [`device_${sign([...identity, String(d.deviceId)])}`, d.deviceId]));
      captured.deviceScopes.set(pluginId, scopes);
    }
    return scopes.get(q.filter.deviceId);
  }
  function syncLiveRates() {
    const scopes = new Set();
    for (const s of subscriptions.values()) if (s.query.resource === 'liveRate') {
      const scope = liveRateScope(latest, s.query, s.pluginId);
      if (scope !== undefined) scopes.add(scope);
    }
    liveRates.setScopes(scopes);
  }

  function envelope(code, revision = latest.revision) {
    return { version: 1, schemaVersion: 1, snapshotRevision: revision, availability: code, rows: [], pageInfo: { nextCursor: null, hasMore: false }, aggregateCoverage: { kind: 'unavailable', totalRows: null } };
  }
  function assertLive(value, key) {
    if (disposed || authorityFingerprint(authority(value)) !== key) throw new Error('denied');
  }
  async function load(name, loader, captured, auth, key, capturedSessions = false) {
    if (captured.extras[name] !== undefined || typeof loader !== 'function') return captured.extras[name];
    const cacheKey = loaderRevision(captured, name);
    let pending = loaders.get(cacheKey);
    if (!pending) {
      // The adapter receives host scope and the immutable captured stats, never
      // a plugin-selected URL/path. Failed reads retry only after a short delay.
      pending = { retryAt: Infinity, promise: Promise.resolve().then(() => loader({ sourceId: captured.extras.sourceId || 'default', snapshotRevision: captured.revision, stats: captured.stats })) };
      pending.promise.catch(() => { pending.retryAt = now() + 1000; });
      loaders.set(cacheKey, pending);
    }
    let value, failed;
    try { value = await pending.promise; } catch (error) { failed = error; }
    assertLive(auth, key);
    if (disposed || (!capturedSessions && loaderRevision(latest, name) !== cacheKey)) throw new Error('snapshotExpired');
    if (failed) throw failed;
    return value;
  }
  function sweep() {
    for (const [key, value] of snapshots) if (now() - value.createdAt > snapshotTtlMs) deleteSnapshot(key);
    for (const [key, value] of projections) if (now() - value.createdAt > snapshotTtlMs) {
      projections.delete(key);
      for (const [id, snapshot] of snapshots) if (snapshot.projectionId === key) deleteSnapshot(id);
    }
    for (const [key, value] of loaders) if (now() >= value.retryAt) loaders.delete(key);
  }
  function page(snapshot, offset, q) {
    const result = { ...snapshot.envelope, rows: [], pageInfo: { nextCursor: null, hasMore: false }, aggregateCoverage: { ...snapshot.envelope.aggregateCoverage } };
    let bytes = Buffer.byteLength(JSON.stringify(result)) + 512;
    let index = offset;
    for (; index < snapshot.rows.length && result.rows.length < q.page.limit; index++) {
      const row = snapshot.rows[index];
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes + size > maxPayloadBytes) {
        if (result.rows.length === 0) return envelope('payloadTooLarge', snapshot.revision);
        break;
      }
      bytes += size;
      result.rows.push(row);
    }
    if (index < snapshot.rows.length) {
      result.pageInfo.hasMore = true;
      result.pageInfo.nextCursor = `${snapshot.id}.${index}.${sign([snapshot.id, index, snapshot.queryKey, snapshot.authorityFingerprint, snapshot.revision])}`;
    }
    result.aggregateCoverage.pageRows = result.rows.length;
    // Detach all nested DTOs so an in-process bridge cannot mutate cached pages.
    return JSON.parse(JSON.stringify(result));
  }
  // Internal third argument only; it never changes the plugin wire query.
  async function query(raw, auth, { owner, signal } = {}) {
    let request;
    try {
      const a = authority(auth), key = authorityFingerprint(a);
      if (requests.size >= 128 || [...requests].filter(r => r.pluginId === a.pluginId).length >= 32
        || (owner && [...requests].filter(r => r.owner === owner).length >= 16)) return envelope('budgetExceeded');
      let reject;
      const cancelled = new Promise((_, fail) => { reject = fail; });
      request = { owner, pluginId: a.pluginId, error: null, cancel(code = 'denied') {
        if (!request.error) { request.error = new Error(code); reject(request.error); }
      }, check() {
        if (request.error) throw request.error;
        assertLive(auth, key);
        if (signal?.aborted) throw new Error('denied');
        if (request.fence !== undefined && request.fence !== cursorFence(latest, request.query)) throw new Error('snapshotExpired');
      } };
      requests.add(request);
      const abort = () => request.cancel();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        request.check();
        const result = await Promise.race([queryInternal(raw, auth, request), cancelled]);
        request.check(); return result;
      } finally { signal?.removeEventListener('abort', abort); }
    } catch (error) { return envelope(error.message === 'snapshotExpired' ? 'snapshotExpired' : 'denied'); }
    finally {
      if (request) {
        requests.delete(request);
        for (const build of builds.values()) build.waiters.delete(request);
      }
    }
  }
  const lazySnapshots = () => new Set([...snapshots.values(), ...pagePins.keys()].filter(s => s.lazy));
  function lazyBytes(pluginId) {
    let bytes = 0;
    for (const s of lazySnapshots()) if (!pluginId || s.pluginId === pluginId) bytes += s.bytes;
    for (const b of builds.values()) if (!pluginId || b.pluginId === pluginId) bytes += b.bytes;
    for (const [s, count] of pagePins) if (!pluginId || s.pluginId === pluginId) bytes += count * PAGE_SCRATCH_BYTES;
    for (const p of projections.values()) if (!pluginId || p.pluginId === pluginId) bytes += p.bytes;
    return bytes;
  }
  function lazyAdmission(pluginId, bytes) {
    if (lazyBytes(pluginId) + bytes > 64 * 1024 * 1024 || backing.bytes() + lazyBytes() + bytes > 128 * 1024 * 1024) throw new Error('budgetExceeded');
  }
  function makeSnapshot(captured, q, a, key, stamp, projected, rows, projectionId, createdAt = now()) {
    const asOf = typeof captured.stats?.updatedAt === 'string' ? captured.stats.updatedAt : null;
    const ageMs = asOf && Number.isFinite(Date.parse(asOf)) ? Math.max(0, now() - Date.parse(asOf)) : null;
    return { id: randomBytes(16).toString('hex'), traversed: false, fence: cursorFence(captured, q), stamp, query: q, projectionId, revision: captured.revision, authorityFingerprint: key, pluginId: a.pluginId, queryKey: queryKey(q), rows, createdAt, envelope: { version: 1, schemaVersion: 1, snapshotRevision: captured.revision, asOf, collectedAt: asOf, freshness: { ageMs, state: ageMs === null ? 'unknown' : ageMs > 120000 ? 'stale' : 'fresh' }, availability: projected.availability, redacted: projected.redacted ? ['identities'] : [], aggregateCoverage: { kind: projected.incomplete ? 'partial' : projected.availability === 'available' ? 'authorizedCollection' : 'unavailable', totalRows: rows.length, filtered: Object.keys(q.filter).length > 0, totalsArePageSums: false } } };
  }
  function retainSnapshot(snapshot) {
    for (const [id, s] of snapshots) if (!s.traversed && s.authorityFingerprint === snapshot.authorityFingerprint && s.queryKey === snapshot.queryKey) deleteSnapshot(id);
    const own = [...snapshots.values()].filter(s => s.pluginId === snapshot.pluginId).sort((a, b) => snapshotPriority(a) - snapshotPriority(b));
    while (own.length >= 8) deleteSnapshot(own.shift().id);
    if (snapshots.size >= 256) throw new Error('budgetExceeded');
    snapshots.set(snapshot.id, snapshot);
  }
  async function lazyQuery(plan, captured, q, a, key, stamp, opaque, request, budget) {
    const buildKey = sign([key, stamp, queryKey(q)]);
    let build = builds.get(buildKey);
    if (!build) {
      if (builds.size >= 4 || [...builds.values()].filter(b => b.pluginId === a.pluginId).length >= 2) throw new Error('budgetExceeded');
      lazyAdmission(a.pluginId, PAGE_SCRATCH_BYTES);
      build = { bytes: PAGE_SCRATCH_BYTES, pluginId: a.pluginId, waiters: new Set(), createdAt: captured.capturedAt ?? now(), fence: cursorFence(captured, q) };
      builds.set(buildKey, build);
      const check = () => {
        for (const waiter of build.waiters) {
          try { waiter.check(); } catch (error) { waiter.cancel(error.message); build.waiters.delete(waiter); }
        }
        if (disposed || !build.waiters.size) throw new Error('denied');
        if (build.fence !== cursorFence(latest, q) || now() - build.createdAt > Math.min(snapshotTtlMs, 10000)) throw new Error('snapshotExpired');
      };
      // Start in a microtask so this first waiter is registered before check().
      build.promise = Promise.resolve().then(async () => {
        const charge = ms => { budget.tokens -= ms / 10; };
        build.lease = backing.pin(plan, a.pluginId, { check, charge });
        const projected = await buildSessionIndex(plan, q, opaque, { check, charge, lease: build.lease, reserve(bytes) {
          lazyAdmission(a.pluginId, bytes - build.bytes); build.bytes = bytes;
        } });
        check();
        const snapshot = makeSnapshot(captured, q, a, key, stamp, projected, projected.rows, null, build.createdAt);
        Object.assign(snapshot, { lease: projected.rows.length ? build.lease : null, lazy: true, bytes: projected.bytes, plan: projected.plan, opaque, owners: new Set() });
        for (const waiter of build.waiters) snapshot.owners.add(waiter.owner);
        retainSnapshot(snapshot);
        build.bytes = 0; // The retained snapshot now owns the incremental charge.
        if (snapshot.lease) { snapshot.lease.detach(); build.lease = null; } // Transfer the pin, not its charge.
        return snapshot;
      }).finally(() => { builds.delete(buildKey); build.lease?.release(); });
    }
    build.waiters.add(request);
    const snapshot = await build.promise;
    request.check();
    return lazyPage(snapshot, 0, q, request);
  }
  async function lazyPage(snapshot, offset, q, request) {
    let pages = 0, ownPages = 0;
    for (const [s, count] of pagePins) { pages += count; if (s.pluginId === snapshot.pluginId) ownPages += count; }
    if (pages >= 8 || ownPages >= 4) throw new Error('budgetExceeded');
    lazyAdmission(snapshot.pluginId, PAGE_SCRATCH_BYTES);
    pagePins.set(snapshot, (pagePins.get(snapshot) || 0) + 1);
    snapshot.owners.add(request.owner);
    const check = () => {
      request.check();
      if (snapshot.fence !== cursorFence(latest, q) || now() - snapshot.createdAt > snapshotTtlMs) throw new Error('snapshotExpired');
    };
    const result = { ...snapshot.envelope, rows: [], pageInfo: { nextCursor: null, hasMore: false }, aggregateCoverage: { ...snapshot.envelope.aggregateCoverage } };
    let bytes = Buffer.byteLength(JSON.stringify(result)) + 512, index = offset;
    let started = performance.now();
    const charge = () => { const budget = budgets.get(snapshot.pluginId); if (budget) budget.tokens -= (performance.now() - started) / 10; };
    try {
      check();
      for (; index < snapshot.rows.length && result.rows.length < q.page.limit; index++) {
        const row = projectSessionRow(snapshot.rows[index].locator, snapshot.plan, snapshot.opaque);
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (bytes + size > maxPayloadBytes) {
          if (!result.rows.length) return envelope('payloadTooLarge', snapshot.revision);
          break;
        }
        bytes += size; result.rows.push(row);
        if (result.rows.length % 16 === 0 || performance.now() - started >= 4) {
          charge(); await immediate(); check(); started = performance.now();
        }
      }
      if (index < snapshot.rows.length) {
        result.pageInfo.hasMore = true;
        result.pageInfo.nextCursor = `${snapshot.id}.${index}.${sign([snapshot.id, index, snapshot.queryKey, snapshot.authorityFingerprint, snapshot.revision])}`;
      }
      result.aggregateCoverage.pageRows = result.rows.length;
      const detached = JSON.parse(JSON.stringify(result));
      charge(); await immediate(); check(); started = performance.now();
      return detached;
    } finally {
      charge(); const count = pagePins.get(snapshot) - 1;
      if (count) pagePins.set(snapshot, count);
      else { pagePins.delete(snapshot); if (!snapshots.has(snapshot.id)) snapshot.lease?.release(); }
    }
  }
  async function queryInternal(raw, auth, request) {

    let q, a, key;
    try {
      if (disposed) return envelope('denied');
      q = normalizeQuery(raw);
      request.query = q; request.fence = cursorFence(latest, q);
      request.check();
      a = authority(auth); key = authorityFingerprint(a);
      sweep();
      if (q.page.cursor) {
        const [snapshotId, rawOffset, signature] = q.page.cursor.split('.');
        const snapshot = snapshots.get(snapshotId), offset = Number(rawOffset);
        if (!snapshot || now() - snapshot.createdAt > snapshotTtlMs || snapshot.fence !== cursorFence(latest, snapshot.query)) return envelope('snapshotExpired');
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= snapshot.rows.length || snapshot.authorityFingerprint !== key || snapshot.queryKey !== queryKey(q) || signature !== sign([snapshot.id, offset, snapshot.queryKey, snapshot.authorityFingerprint, snapshot.revision])) return envelope('invalidCursor');
        snapshot.traversed = true;
        return snapshot.lazy ? await lazyPage(snapshot, offset, q, request) : page(snapshot, offset, q);
      }
      if (q.filter.deviceId && ['history', 'subscriptions'].includes(q.resource)) return envelope('scopeUnavailable');
      let captured = latest;
      if (q.resource === 'liveRate') {
        const deviceId = liveRateScope(captured, q, a.pluginId);
        if (deviceId === undefined) return envelope('scopeUnavailable');
        captured = { ...latest, extras: { ...latest.extras, liveRate: liveRates.read(deviceId) } };
      }
      const stamp = dependency(captured, q, a.pluginId), qKey = queryKey(q), capturedAt = now();
      const reusable = [...snapshots.values()].find(s => s.stamp === stamp && s.authorityFingerprint === key && s.queryKey === qKey);
      if (reusable) return reusable.lazy ? await lazyPage(reusable, 0, q, request) : page(reusable, 0, q);
      const neutral = { ...q, filter: q.filter.deviceId ? { deviceId: q.filter.deviceId } : {}, sort: { field: 'id', direction: 'asc' }, page: { limit: 100, cursor: null } };
      const projectionId = sign([key, stamp, neutral]);
      let projection = projections.get(projectionId);
      if (projection?.error) return envelope(projection.error);
      const pendingBuild = builds.get(sign([key, stamp, qKey]));
      if (pendingBuild) { captured = null; return await lazyQuery(null, null, q, a, key, stamp, null, request, null); }
      const budget = admit(a.pluginId, projection ? 0 : 1);
      let extras = { ...captured.extras };
      if (!projection && q.resource === 'history' && !captured.stats?.history) extras.history = await load('history', loadHistory, captured, auth, key);
      if (!projection && q.period === 'allTime' && periodResources.includes(q.resource)) extras.allTime = await load('allTime', loadAllTime, captured, auth, key, q.resource === 'sessions');
      if (!projection && q.resource === 'subscriptions' && !captured.stats?.subscriptions) extras.subscriptions = await load('subscriptions', loadSubscriptions, captured, auth, key);
      assertLive(auth, key);
      request.check();
      if (!projection && q.resource === 'sessions') {
        const identityScope = [a.pluginId, extras.sourceId || 'default', extras.identityEpoch || '1'];
        const opaque = (kind, value) => `${kind}_${sign([...identityScope, kind, String(value)])}`;
        const plan = sessionSources(captured.stats, extras, q, opaque);
        if (isLargeSessionPlan(plan)) {
          // Async work only pins selected session maps/records and scalar source
          // metadata, never the unrelated graph reachable from captured stats.
          const metadata = { stats: { updatedAt: captured.stats?.updatedAt },
            extras: { preferences: { sessionTitlesEnabled: extras.preferences?.sessionTitlesEnabled } },
            revision: captured.revision, sourceGeneration: captured.sourceGeneration, capturedAt };
          captured = null; extras = null;
          return await lazyQuery(plan, metadata, q, a, key, stamp, opaque, request, budget);
        }
      }
      if (!live(q, stamp, a.pluginId)) return envelope('snapshotExpired');
      const started = performance.now();
      // An awaited loader may have been shared by another query.
      projection = projections.get(projectionId);
      if (!projection) {
        try {
          const identityScope = [a.pluginId, extras.sourceId || 'default', extras.identityEpoch || '1'];
          const opaque = (kind, value) => `${kind}_${sign([...identityScope, kind, String(value)])}`;
          try {
            preflight(captured.stats, extras, neutral, opaque);
            const projected = projectResource(captured.stats, extras, neutral, a, opaque);
            if (projected.rows.length > MAX_COLLECTION_ROWS) throw new Error('budgetExceeded');
            let bytes = 0;
            for (const row of projected.rows) {
              bytes += Buffer.byteLength(JSON.stringify(row));
              if (bytes > MAX_COLLECTION_BYTES) throw new Error('budgetExceeded');
            }
            projection = { id: projectionId, pluginId: a.pluginId, stamp, query: q, createdAt: now(), bytes, projected };
          } catch (error) {
            if (error.message !== 'budgetExceeded') throw error;
            // Memoize oversized collections too: varied search strings cannot
            // repeatedly pay preflight/projection costs for the same source.
            projection = { id: projectionId, pluginId: a.pluginId, stamp, query: q, createdAt: now(), bytes: 0, error: 'budgetExceeded' };
          }
          retainProjection(projection);
        } finally { budget.tokens -= (performance.now() - started) / 10; }
      }
      if (projection.error) throw new Error(projection.error);
      const filterStarted = performance.now();
      const projected = projection.projected;
      // Query snapshots hold references to one authorized projection, not copies.
      const rows = projected.rows.filter(row => matchesRow(row, q));
      rows.sort((x, y) => compareRows(x, y, q));
      budget.tokens -= (performance.now() - filterStarted) / 10;
      const snapshot = makeSnapshot(captured, q, a, key, stamp, projected, rows, projectionId);
      retainSnapshot(snapshot);
      return page(snapshot, 0, q);
    } catch (error) {
      if (error.message === 'rateLimited') {
        // No polling is required from live readers: a denied refetch always
        // leaves one follow-up signal, including after the last publication.
        const qKey = queryKey(q);
        for (const s of subscriptions.values()) if (s.authorityFingerprint === key && s.queryKey === qKey) invalidate(s, false, error.retryAfterMs);
        return { ...envelope('rateLimited'), retryAfterMs: error.retryAfterMs };
      }
      return envelope(['denied', 'snapshotExpired', 'unsupportedVersion', 'unsupportedResource', 'invalidQuery', 'invalidPeriod', 'invalidFilter', 'invalidSort', 'invalidPage', 'scopeUnavailable', 'budgetExceeded'].includes(error.message) ? error.message : 'temporarilyUnavailable');
    }
  }
  function stop(subscription) {
    subscription.controller.abort();
    subscription.closed = true; subscriptions.delete(subscription.id);
    if (subscription.timer) clearTimeout(subscription.timer);
    subscription.timer = null; subscription.retryAt = 0;
    syncLiveRates();
  }
  function deliver(subscription, value) {
    if (subscription.closed || disposed) return;
    try {
      if (authorityFingerprint(authority(subscription.getAuth)) !== subscription.authorityFingerprint) { stop(subscription); return; }
      subscription.callback(value);
    } catch { stop(subscription); }
  }
  function invalidate(subscription, reset = false, retryAfterMs = 0) {
    if (subscription.closed) return;
    // A later ordinary update must not downgrade a queued privacy/source reset.
    subscription.reset ||= reset;
    if (retryAfterMs) subscription.retryAt = Math.max(subscription.retryAt, now() + retryAfterMs);
    if (!subscription.initialized) return;
    // Privacy/source resets must clear displayed data at the normal deadline,
    // even in CPU debt. Ordinary updates share the delayed retry; neither they
    // nor another denial may postpone an already queued reset. Its refetch still
    // obeys admission and can leave a new retry on this same timer slot.
    const due = subscription.reset ? now() + 100 : Math.max(now() + 100, subscription.retryAt);
    if (subscription.timer) {
      if (subscription.reset ? subscription.timerAt <= due : subscription.timerAt >= subscription.retryAt) return;
      clearTimeout(subscription.timer);
    }
    subscription.timerAt = due;
    subscription.timer = setTimeout(() => {
      subscription.timer = null; subscription.retryAt = 0;
      const reset = subscription.reset; subscription.reset = false;
      deliver(subscription, { type: 'invalidate', version: 1, snapshotRevision: latest.revision, sequence: ++subscription.sequence, refetch: true, reset });
    }, Math.min(2147483647, due - now()));
    subscription.timer.unref?.();
  }
  return {
    query,
    publish(stats, extras = {}) {
      if (disposed) return;
      const previous = latest;
      const sourceChanged = (extras.sourceId || 'default') !== (previous.extras.sourceId || 'default') || (extras.identityEpoch || '1') !== (previous.extras.identityEpoch || '1');
      latest = { stats, extras: { ...extras, preferences: extras.preferences ? { ...extras.preferences } : undefined, subscriptionContext: extras.subscriptionContext ? { date: extras.subscriptionContext.date, rates: Object.fromEntries(CURRENCY_CODES.map(code => [code, extras.subscriptionContext.rates?.[code]])) } : undefined }, revision: previous.revision + 1, sourceGeneration: previous.sourceGeneration + Number(sourceChanged), loaderVersions: {}, deviceScopes: new Map() };
      for (const name of ['history', 'allTime', 'subscriptions']) latest.loaderVersions[name] = sourceChanged || loaderDependency(previous, name) !== loaderDependency(latest, name) ? latest.revision : previous.loaderVersions[name];
      sweep();
      syncLiveRates();
      liveRates.publish(stats, extras);
      for (const request of requests) {
        try { request.check(); } catch (error) { request.cancel(error.message); }
      }
      for (const [id, s] of snapshots) if (s.fence !== cursorFence(latest, s.query)) deleteSnapshot(id);
      // Retained pages share their original projection. Keep those bytes in the
      // same owner/global ledger until the final cursor releases them or expires.
      const retained = new Set([...snapshots.values()].map(s => s.projectionId));
      for (const [id, p] of projections) if (!live(p.query, p.stamp, p.pluginId) && !retained.has(id)) projections.delete(id);
      const loaderKeys = new Set(['history', 'allTime', 'subscriptions'].map(name => loaderRevision(latest, name)));
      for (const id of loaders.keys()) if (!loaderKeys.has(id)) loaders.delete(id);
      for (const subscription of subscriptions.values()) {
        const stamp = dependency(latest, subscription.query, subscription.pluginId), fence = cursorFence(latest, subscription.query);
        const reset = fence !== subscription.fence;
        if (stamp !== subscription.stamp || reset) {
          subscription.stamp = stamp; subscription.fence = fence; invalidate(subscription, reset);
        }
      }
    },
    // Registration is synchronous; the initial callback is always a microtask.
    // Callbacks receive {type:'snapshot',value,sequence} or an invalidation.
    subscribe(owner, raw, getAuth, callback, requestedId) {
      if (disposed || typeof owner !== 'string' || !owner || typeof callback !== 'function') throw new Error('invalidSubscription');
      const q = normalizeQuery(raw), a = authority(getAuth);
      if (q.page.cursor) throw new Error('denied');
      const id = requestedId || `business-${++sequence}`;
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || subscriptions.has(id) || subscriptions.size >= 128 || [...subscriptions.values()].filter(s => s.owner === owner).length >= 16) throw new Error('subscriptionLimit');
      const subscription = { controller: new AbortController(), id, owner, query: q, queryKey: queryKey(q), retryAt: 0, timerAt: 0, stamp: dependency(latest, q, a.pluginId), fence: cursorFence(latest, q), reset: false, pluginId: a.pluginId, getAuth, callback, authorityFingerprint: authorityFingerprint(a), initialized: false, closed: false, timer: null, sequence: 0 };
      subscriptions.set(id, subscription);
      syncLiveRates();
      if (q.resource === 'liveRate') subscription.stamp = dependency(latest, q, a.pluginId);
      const initialStamp = subscription.stamp;
      Promise.resolve().then(() => subscription.closed ? null : query(q, getAuth, { owner, signal: subscription.controller.signal })).then(value => {
        if (subscription.closed) return;
        deliver(subscription, { type: 'snapshot', version: 1, value, sequence: ++subscription.sequence });
        subscription.initialized = true;
        if (initialStamp !== dependency(latest, q, a.pluginId) || subscription.reset || subscription.retryAt) invalidate(subscription);
      });
      return id;
    },
    unsubscribe(owner, id) { const s = subscriptions.get(id); if (!s || s.owner !== owner) return false; stop(s); return true; },
    releaseOwner(owner) {
      for (const s of subscriptions.values()) if (s.owner === owner) stop(s);
      for (const request of requests) if (request.owner === owner) request.cancel();
      for (const [id, s] of snapshots) if (s.lazy) {
        s.owners.delete(owner); if (!s.owners.size) deleteSnapshot(id);
      }
    },
    revoke(pluginId) {
      for (const request of requests) if (request.pluginId === pluginId) request.cancel();
      epochs.set(pluginId, (epochs.get(pluginId) || 0) + 1);
      for (const s of subscriptions.values()) if (s.pluginId === pluginId) stop(s);
      for (const [id, snapshot] of snapshots) if (snapshot.pluginId === pluginId) deleteSnapshot(id);
      for (const [id, projection] of projections) if (projection.pluginId === pluginId) projections.delete(id);
      latest.deviceScopes.delete(pluginId);
    },
    dispose() { disposed = true; for (const request of requests) request.cancel(); for (const s of subscriptions.values()) stop(s); liveRates.dispose(); for (const id of snapshots.keys()) deleteSnapshot(id); projections.clear(); budgets.clear(); loaders.clear(); latest = { stats: null, extras: {}, revision: latest.revision + 1, deviceScopes: new Map() }; }
  };
}
module.exports = { createBusinessDataService };
