'use strict';

const crypto = require('node:crypto');
const {
  DEFAULT_API_PRICING_SNAPSHOT,
  buildProfileQuotaSnapshot,
  isSuccessorQuotaCycle,
  priceTokenComponents,
  sanitizeAccountingSampleList,
  sanitizeObservationList
} = require('./quotaEngine');

const ARCHIVE_VERSION = 1;
const PROVIDER = 'codex';
const FALLBACK_PROFILE_ID = 'codex-local';
const SCOPE_VERSION = '1';
const MAX_ARCHIVE_ROWS = 720;
// Fair retention budget for one (profile, window) stream. A Session window
// whose official percentage moves every few minutes can spend this budget and
// no more, so it can never crowd another stream's cycle anchors out of the
// archive-wide cap. See trimCodexQuotaArchiveRows for the full policy.
const MAX_ARCHIVE_ROWS_PER_WINDOW = 240;
// Stable, desensitized reason shown while Windows/WSL merged usage makes the
// local Codex counters unattributable (see wslUsageObscuresLocalCodex).
const WSL_MERGED_REASON = 'wsl-usage-merged-unattributable';
const CANONICAL_WINDOW_KINDS = Object.freeze(['session', 'weekly']);
const CONFIDENCE = new Set(['collecting', 'preliminary', 'stable', 'unstable']);
const COMPONENT_CATEGORIES = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite', 'unclassified']);

const COLLECTING_ESTIMATE = Object.freeze({
  observedTokens: null,
  pricedUsd: null,
  coverage: null,
  capacityUsd: null,
  remainingUsd: null,
  confidence: 'collecting',
  snapshotId: '',
  reasons: Object.freeze([])
});

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteNonNegInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function safeText(value, max = 240) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isoTimestamp(value) {
  const text = safeText(value, 40);
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

// Quota observations must be stamped with the time of this limits/usage
// snapshot, not a stale usage `updatedAt` that limits-only ticks preserve.
// Prefer the latest parseable of limits.updatedAt and usage updatedAt;
// receivedAt is last-resort ingest time; nothing parseable fails closed
// rather than minting Date.now().
function resolveCodexQuotaObservedAt(device, fallbackObservedAt) {
  const limitsAt = isoTimestamp(device?.limits?.updatedAt);
  const usageAt = isoTimestamp(device?.updatedAt);
  const times = [];
  if (limitsAt) times.push(Date.parse(limitsAt));
  if (usageAt) times.push(Date.parse(usageAt));
  if (times.length) return new Date(Math.max(...times)).toISOString();
  const receivedAt = isoTimestamp(device?.receivedAt);
  if (receivedAt) return receivedAt;
  return isoTimestamp(fallbackObservedAt);
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function finiteFraction(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 && number <= 1 ? number : null;
}

function emptyCodexQuotaArchive() {
  return {
    version: ARCHIVE_VERSION,
    observations: [],
    accountingSamples: [],
    scopes: {},
    windowState: {},
    lastProfileId: ''
  };
}

function cloneMap(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    out[key] = { ...entry };
  }
  return out;
}

function normalizeComponents(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [model, raw] of Object.entries(value)) {
    const id = safeText(model, 160);
    if (!id || !raw || typeof raw !== 'object') continue;
    const entry = {};
    for (const category of COMPONENT_CATEGORIES) {
      const tokens = finiteNonNegInt(raw[category]);
      if (tokens > 0) entry[category] = tokens;
    }
    if (Object.keys(entry).length) out[id] = entry;
  }
  return out;
}

function normalizeScope(profileId, value) {
  if (!value || typeof value !== 'object') return null;
  const id = safeText(profileId, 80) || safeText(value.profileId, 80);
  if (!id) return null;
  const scope = {
    profileId: id,
    totalTokens: finiteNonNegInt(value.totalTokens),
    pricedTokens: finiteNonNegInt(value.pricedTokens),
    unpricedTokens: finiteNonNegInt(value.unpricedTokens),
    apiEquivalentCostUsd: finiteNumber(value.apiEquivalentCostUsd) ?? 0,
    snapshotId: safeText(value.snapshotId, 120),
    lastObservedAt: isoTimestamp(value.lastObservedAt),
    models: Object.fromEntries(
      Object.entries(value.models || {})
        .map(([model, tokens]) => [safeText(model, 160), finiteNonNegInt(tokens)])
        .filter(([model, tokens]) => model && tokens > 0)
    ),
    components: normalizeComponents(value.components)
  };
  if (value.wslMerged === true) scope.wslMerged = true;
  return scope;
}

function normalizeWindowState(value) {
  if (!value || typeof value !== 'object') return null;
  const profileId = safeText(value.profileId, 80);
  const kind = safeText(value.kind, 32);
  if (!profileId || !CANONICAL_WINDOW_KINDS.includes(kind)) return null;
  const usedPercent = finiteNumber(value.usedPercent);
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100) return null;
  const state = {
    profileId,
    kind,
    limitId: safeText(value.limitId, 128),
    windowMinutes: finiteNumber(value.windowMinutes),
    resetsAt: isoTimestamp(value.resetsAt),
    usedPercent,
    segmentId: safeText(value.segmentId, 240),
    snapshotId: safeText(value.snapshotId, 120),
    observedAt: isoTimestamp(value.observedAt)
  };
  if (value.expired === true) state.expired = true;
  return state;
}

function archiveRowGroup(row) {
  return `${safeText(row?.profileId, 80)}|${safeText(row?.kind, 32)}`;
}

function archiveSegmentKey(row) {
  return `${archiveRowGroup(row)}|${safeText(row?.segmentId, 240)}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// One (profile, window) stream split into its quota-cycle segments. Rows are
// chronological, so a segment's first row is the cycle baseline the engine's
// `last - first` delta is measured against and its last row is the cycle's
// latest point; those two rows are the anchors that prove the cycle's
// boundaries and current state. Integrity markers (`unsettled`) are also
// anchors: dropping them would let retention turn a gapped cycle into a
// clean full-cycle claim.
function streamSegmentList(rows, indices) {
  const order = [];
  const bySegmentId = new Map();
  for (const index of indices) {
    const segmentId = safeText(rows[index]?.segmentId, 240);
    let segment = bySegmentId.get(segmentId);
    if (!segment) {
      segment = { key: archiveRowGroup(rows[index]), segmentId, indices: [] };
      bySegmentId.set(segmentId, segment);
      order.push(segment);
    }
    segment.indices.push(index);
  }
  return order;
}

function isIntegrityAnchor(row) {
  return row?.unsettled === true;
}

function segmentAnchorIndices(rows, segment) {
  const indices = segment.indices;
  if (!indices.length) return [];
  const anchors = new Set([indices[0], indices[indices.length - 1]]);
  const integrity = indices.filter((index) => isIntegrityAnchor(rows[index]));
  const extra = integrity.filter((index) => !anchors.has(index));
  // Prefer every integrity marker. If they would overflow the per-stream cap
  // by themselves, keep a deterministic first+last pair so a surviving
  // segment can never lose the fact that it had a gap.
  if (anchors.size + extra.length <= MAX_ARCHIVE_ROWS_PER_WINDOW) {
    for (const index of extra) anchors.add(index);
  } else if (integrity.length) {
    anchors.add(integrity[0]);
    anchors.add(integrity[integrity.length - 1]);
  }
  return [...anchors].sort((left, right) => left - right);
}

function segmentAnchorCount(rows, segment) {
  return segmentAnchorIndices(rows, segment).length;
}

// Retention plan for one evidence array. Returns null when the array already
// fits every cap (nothing is rewritten), else `{ kept, evictedSegments }`:
// `kept` is the set of retained row indexes, `evictedSegments` the
// archive-segment keys dropped whole. Policy, applied in order:
//   1. anchors first — every surviving (profile, window, cycle) segment keeps
//      its baseline row, its latest row, and any `unsettled` integrity
//      markers before any fair-share budget is spent, so a fully observed
//      cycle can never degrade into a partial one and a gapped cycle can
//      never be upgraded into a clean one;
//   2. when even the anchors overflow a cap, whole segments are evicted
//      keeping the newest cycles — an old cycle loses all of its rows rather
//      than keeping a middle slice that can no longer prove anything;
//   3. the remaining budget is dealt round-robin across streams, newest row
//      first, so a hyperactive stream can spend at most its own per-stream
//      budget and never another stream's anchors.
function planArchiveRowRetention(rows) {
  const streamOrder = [];
  const streamIndices = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const key = archiveRowGroup(rows[index]);
    let indices = streamIndices.get(key);
    if (!indices) {
      indices = [];
      streamIndices.set(key, indices);
      streamOrder.push(key);
    }
    indices.push(index);
  }
  const overPerStream = streamOrder.some((key) => streamIndices.get(key).length > MAX_ARCHIVE_ROWS_PER_WINDOW);
  if (rows.length <= MAX_ARCHIVE_ROWS && !overPerStream) return null;

  const segmentsByStream = new Map();
  for (const key of streamOrder) {
    segmentsByStream.set(key, streamSegmentList(rows, streamIndices.get(key)));
  }

  // Anchor budgets, newest cycles first: per stream, then globally.
  const anchorCandidates = [];
  for (const key of streamOrder) {
    const segments = segmentsByStream.get(key);
    let budget = MAX_ARCHIVE_ROWS_PER_WINDOW;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const cost = segmentAnchorCount(rows, segments[index]);
      if (cost > budget) continue;
      budget -= cost;
      anchorCandidates.push(segments[index]);
    }
  }
  const keptSegments = new Set();
  let globalBudget = MAX_ARCHIVE_ROWS;
  for (const segment of [...anchorCandidates].sort((left, right) => right.indices[0] - left.indices[0])) {
    const cost = segmentAnchorCount(rows, segment);
    if (cost > globalBudget) continue;
    globalBudget -= cost;
    keptSegments.add(segment);
  }

  const kept = new Set();
  const evictedSegments = new Set();
  const perStreamKept = new Map();
  const anchorsBySegment = new Map();
  for (const key of streamOrder) {
    for (const segment of segmentsByStream.get(key)) {
      if (!keptSegments.has(segment)) {
        evictedSegments.add(`${segment.key}|${segment.segmentId}`);
        continue;
      }
      const anchors = segmentAnchorIndices(rows, segment);
      anchorsBySegment.set(segment, anchors);
      for (const index of anchors) kept.add(index);
      perStreamKept.set(key, (perStreamKept.get(key) || 0) + anchors.length);
    }
  }

  // Round-robin the leftover budget over each stream's non-anchor rows,
  // newest first. Taking one row per stream per turn is what keeps a single
  // hyperactive stream from spending the whole global budget.
  const cursors = new Map();
  for (const key of streamOrder) {
    const eligible = [];
    for (const segment of segmentsByStream.get(key)) {
      if (!keptSegments.has(segment)) continue;
      const anchors = new Set(anchorsBySegment.get(segment) || []);
      for (let index = segment.indices.length - 1; index >= 0; index -= 1) {
        const rowIndex = segment.indices[index];
        if (anchors.has(rowIndex)) continue;
        eligible.push(rowIndex);
      }
    }
    eligible.sort((left, right) => right - left);
    cursors.set(key, { eligible, position: 0 });
  }
  let remaining = MAX_ARCHIVE_ROWS - kept.size;
  let progressed = true;
  while (remaining > 0 && progressed) {
    progressed = false;
    for (const key of streamOrder) {
      if (remaining <= 0) break;
      if ((perStreamKept.get(key) || 0) >= MAX_ARCHIVE_ROWS_PER_WINDOW) continue;
      const cursor = cursors.get(key);
      if (cursor.position >= cursor.eligible.length) continue;
      kept.add(cursor.eligible[cursor.position]);
      cursor.position += 1;
      perStreamKept.set(key, (perStreamKept.get(key) || 0) + 1);
      remaining -= 1;
      progressed = true;
    }
  }
  return { kept, evictedSegments };
}

// Bounded, fair retention for the two evidence arrays, applied jointly so
// their contents stay explainable by each other: a segment evicted by either
// plan loses its rows in BOTH arrays, and a (profile, window) stream that
// survives in only one array is dropped from both — an observation whose
// window has no samples left (or the reverse) is exactly the orphan evidence
// retention must not keep. Deterministic: the same input always yields the
// same output, and an already-trimmed archive passes through unchanged.
function trimCodexQuotaArchiveRows(observations, accountingSamples) {
  const observationPlan = planArchiveRowRetention(observations);
  const samplePlan = planArchiveRowRetention(accountingSamples);
  if (!observationPlan && !samplePlan) return { observations, accountingSamples };
  const keptObservations = observationPlan
    ? observations.filter((_, index) => observationPlan.kept.has(index))
    : observations;
  const keptSamples = samplePlan
    ? accountingSamples.filter((_, index) => samplePlan.kept.has(index))
    : accountingSamples;
  const evictedSegments = new Set([
    ...(observationPlan ? observationPlan.evictedSegments : []),
    ...(samplePlan ? samplePlan.evictedSegments : [])
  ]);
  const survivesSegmentEviction = (row) => !evictedSegments.has(archiveSegmentKey(row));
  const filteredObservations = evictedSegments.size ? keptObservations.filter(survivesSegmentEviction) : keptObservations;
  const filteredSamples = evictedSegments.size ? keptSamples.filter(survivesSegmentEviction) : keptSamples;
  const observationStreams = new Set(filteredObservations.map(archiveRowGroup));
  const sampleStreams = new Set(filteredSamples.map(archiveRowGroup));
  if (observationStreams.size === sampleStreams.size
    && [...observationStreams].every((key) => sampleStreams.has(key))) {
    return { observations: filteredObservations, accountingSamples: filteredSamples };
  }
  const sharedStreams = new Set([...observationStreams].filter((key) => sampleStreams.has(key)));
  const inSharedStream = (row) => sharedStreams.has(archiveRowGroup(row));
  return {
    observations: filteredObservations.filter(inSharedStream),
    accountingSamples: filteredSamples.filter(inSharedStream)
  };
}

function normalizeCodexQuotaArchive(value) {
  const source = value && typeof value === 'object' ? value : {};
  const archive = emptyCodexQuotaArchive();
  const sanitizedObservations = sanitizeObservationList(source.observations).filter((row) => row.provider === PROVIDER);
  const sanitizedSamples = sanitizeAccountingSampleList(source.accountingSamples).filter((row) => row.provider === PROVIDER);
  const trimmed = trimCodexQuotaArchiveRows(sanitizedObservations, sanitizedSamples);
  archive.observations = trimmed.observations;
  archive.accountingSamples = trimmed.accountingSamples;
  for (const [key, entry] of Object.entries(source.scopes || {})) {
    const scope = normalizeScope(key, entry);
    if (scope) archive.scopes[scope.profileId] = scope;
  }
  for (const entry of Object.values(source.windowState || {})) {
    const window = normalizeWindowState(entry);
    if (!window) continue;
    archive.windowState[windowStateKey(window)] = window;
  }
  archive.lastProfileId = safeText(source.lastProfileId, 80);
  return archive;
}

function windowStateKey(window) {
  return `${window.profileId}|${window.kind}|${window.limitId || window.kind}`;
}

function scopeProfileId(accountKey) {
  const key = safeText(accountKey, 240);
  if (!key) return FALLBACK_PROFILE_ID;
  const hex = /^sha256:/i.test(key)
    ? key.slice(key.indexOf(':') + 1).replace(/[^a-f0-9]/gi, '').toLowerCase()
    : crypto.createHash('sha256').update(key).digest('hex');
  if (!hex) return FALLBACK_PROFILE_ID;
  return `sha256:${hex.slice(0, 16)}`;
}

function isLiveCodexProvider(provider) {
  return safeText(provider?.provider, 32).toLowerCase() === PROVIDER
    && safeText(provider?.status, 32).toLowerCase() === 'ok'
    && safeText(provider?.sourceDetail, 32).toLowerCase() !== 'managed';
}

function isLocalDeviceProvider(provider, options = {}) {
  const sourceDeviceId = safeText(provider?.sourceDeviceId, 120);
  const localDeviceId = safeText(options.localDeviceId, 120);
  if (sourceDeviceId) return Boolean(localDeviceId && sourceDeviceId === localDeviceId);
  return options.syncActive !== true;
}

function liveCodexProviderFrom(device) {
  const providers = device?.limits?.providers;
  if (!Array.isArray(providers)) return null;
  return providers.find(isLiveCodexProvider) || null;
}

function canonicalWindows(provider) {
  return (Array.isArray(provider?.windows) ? provider.windows : []).filter((window) => (
    window
    && window.additional !== true
    && CANONICAL_WINDOW_KINDS.includes(safeText(window.kind, 32))
    && finiteNumber(window.usedPercent) !== null
    && finiteNumber(window.usedPercent) >= 0
    && finiteNumber(window.usedPercent) <= 100
  ));
}

// The upstream collector merges the Windows and WSL period counters into one
// `allTime` before this adapter sees them. A WSL home that has produced Codex
// rows may hold a different Codex account, and the merged counters cannot be
// split after the fact, so local pricing must fail closed while that
// provenance is present. `wslStatus.withData` lists exactly the clients the
// WSL bundle contributed to the merged totals, so 'codex' in it is the
// conservative blocker; a disabled scan (`withData: []`) never blocks.
function wslUsageObscuresLocalCodex(device) {
  const status = device?.wslStatus;
  if (!status || typeof status !== 'object' || !Array.isArray(status.withData)) return false;
  return status.withData.some((client) => safeText(client, 48).toLowerCase() === PROVIDER);
}

function deriveCodexExclusiveUsage(period) {
  const models = {};
  const tokenComponents = {};
  const clientModels = period?.clientModels?.codex && typeof period.clientModels.codex === 'object'
    ? period.clientModels.codex
    : {};
  const globalModels = period?.models && typeof period.models === 'object' ? period.models : {};
  // Exact row-level evidence for Codex's own rows. A component entry here
  // closed over that client's rows at production time, so it prices Codex's
  // share even when another client uses the same model, and even when some
  // other client's rows left the global capability or the aggregate model
  // maps incomplete — that pollution must not make attributable Codex tokens
  // unpriced. An absent map on an old payload falls back to the conservative
  // aggregate-only path below. An explicit budget omit is not an old payload:
  // reconstructing remainder-as-input would treat stripped evidence as complete.
  const componentsOmitted = period?.clientModelTokenComponentsOmitted === true;
  const clientComponents = !componentsOmitted
    && period?.clientModelTokenComponents?.codex
    && typeof period.clientModelTokenComponents.codex === 'object'
    ? period.clientModelTokenComponents.codex
    : {};
  // Upstream stamps `capabilities.tokenComponents` on every period. True means
  // the producer really decomposed rows into cache/output categories, so the
  // row-sum remainder is proven input. Anything else has incomplete provenance
  // and the remainder must not be priced as input.
  const componentsProven = period?.capabilities?.tokenComponents === true;
  let modelSum = 0;

  for (const [rawModel, rawTokens] of Object.entries(clientModels)) {
    const model = safeText(rawModel, 160);
    const tokens = finiteNonNegInt(rawTokens);
    if (!model || tokens <= 0) continue;
    models[model] = tokens;
    modelSum += tokens;
    const exactComponents = clientComponents[rawModel];
    if (exactComponents && typeof exactComponents === 'object') {
      // Per-client evidence is trusted only when it closes within the trusted
      // client × model total. Categories beyond that total, or a claimed
      // closure that does not add up, fail the whole row closed instead of
      // guessing a split; categories below the total price their own share and
      // leave the residue unpriced (missing evidence, not reconstructed).
      const input = finiteNonNegInt(exactComponents.input);
      const output = finiteNonNegInt(exactComponents.output);
      const cacheRead = finiteNonNegInt(exactComponents.cacheRead);
      const cacheWrite = finiteNonNegInt(exactComponents.cacheWrite);
      const unclassified = finiteNonNegInt(exactComponents.unclassified);
      const accounted = input + output + cacheRead + cacheWrite + unclassified;
      if (accounted > tokens) {
        tokenComponents[model] = { unclassified: tokens, complete: false };
        continue;
      }
      tokenComponents[model] = {
        input,
        output,
        cacheRead,
        cacheWrite,
        ...(unclassified > 0 ? { unclassified } : {}),
        complete: accounted === tokens && unclassified === 0 && exactComponents.complete === true
      };
      continue;
    }
    if (componentsOmitted) {
      tokenComponents[model] = { unclassified: tokens, complete: false };
      continue;
    }
    const exclusive = finiteNonNegInt(globalModels[rawModel]) === tokens;
    const cacheRead = exclusive ? finiteNonNegInt(period?.modelCacheReads?.[rawModel]) : 0;
    const cacheWrite = exclusive ? finiteNonNegInt(period?.modelCacheWrites?.[rawModel]) : 0;
    const output = exclusive ? finiteNonNegInt(period?.modelOutputs?.[rawModel]) : 0;
    // Explicit upstream unclassified tokens are positively unknown: they must
    // never leak into input through the row-sum identity.
    const explicitUnclassified = exclusive ? finiteNonNegInt(period?.modelUnclassifiedTokens?.[rawModel]) : 0;
    const accounted = cacheRead + cacheWrite + output + explicitUnclassified;
    const remainder = tokens - accounted;
    if (!exclusive || accounted > tokens || remainder < 0) {
      // Component sums exceed the trusted model total: the whole row fails closed.
      tokenComponents[model] = { unclassified: tokens, complete: false };
      continue;
    }
    if (remainder > 0 && (!componentsProven || explicitUnclassified > 0)) {
      // The residual is not proven input (no component capability, or the
      // producer classified fewer tokens than the row-sum leaves open), so the
      // whole row stays unpriced rather than guessing an input split.
      tokenComponents[model] = { unclassified: tokens, complete: false };
      continue;
    }
    tokenComponents[model] = {
      input: remainder,
      output,
      cacheRead,
      cacheWrite,
      ...(explicitUnclassified > 0 ? { unclassified: explicitUnclassified } : {}),
      complete: true
    };
  }

  const clientTotal = finiteNonNegInt(period?.clients?.codex);
  const totalTokens = Math.max(modelSum, clientTotal);
  if (totalTokens > modelSum) {
    const remainder = totalTokens - modelSum;
    models[''] = (models[''] || 0) + remainder;
    tokenComponents[''] = {
      unclassified: (tokenComponents['']?.unclassified || 0) + remainder,
      complete: false
    };
  }

  return { models, tokenComponents, totalTokens };
}

function subtractComponents(current, previous) {
  const models = {};
  const tokenComponents = {};
  let totalTokens = 0;
  let rollback = false;
  const currentModels = current?.models || {};
  const previousModels = previous?.models || {};
  const currentComponents = current?.tokenComponents || {};
  const previousComponents = previous?.components || {};
  const names = new Set([...Object.keys(currentModels), ...Object.keys(previousModels)]);

  for (const model of names) {
    const currentTotal = finiteNonNegInt(currentModels[model]);
    const previousTotal = finiteNonNegInt(previousModels[model]);
    if (currentTotal < previousTotal) {
      rollback = true;
      break;
    }
    const deltaTotal = currentTotal - previousTotal;
    const currentRow = currentComponents[model] || {};
    const previousRow = previousComponents[model] || {};
    const deltaRow = {};
    let accounted = 0;
    for (const category of COMPONENT_CATEGORIES) {
      const next = finiteNonNegInt(currentRow[category]);
      const prev = finiteNonNegInt(previousRow[category]);
      if (next < prev) {
        rollback = true;
        break;
      }
      const delta = next - prev;
      if (delta > 0) {
        deltaRow[category] = delta;
        accounted += delta;
      }
    }
    if (rollback) break;
    if (accounted > deltaTotal) {
      rollback = true;
      break;
    }
    if (deltaTotal > 0) {
      models[model] = deltaTotal;
      totalTokens += deltaTotal;
      if (deltaTotal > accounted) {
        deltaRow.unclassified = (deltaRow.unclassified || 0) + (deltaTotal - accounted);
      }
      if (Object.keys(deltaRow).length) {
        tokenComponents[model] = { ...deltaRow, complete: currentRow.complete === true && accounted === deltaTotal };
      } else {
        tokenComponents[model] = { unclassified: deltaTotal, complete: false };
      }
    }
  }

  if (rollback) {
    return { rollback: true, models: {}, tokenComponents: {}, totalTokens: 0 };
  }
  return { rollback: false, models, tokenComponents, totalTokens };
}

function snapshotIdOf(snapshot) {
  return safeText(snapshot?.snapshotId, 120);
}

function priceDelta(delta, snapshot) {
  if (!delta.totalTokens) {
    return {
      pricedTokens: 0,
      unpricedTokens: 0,
      apiEquivalentCostUsd: 0,
      pricingCoverage: null,
      snapshotId: snapshotIdOf(snapshot)
    };
  }
  const priced = priceTokenComponents({
    models: delta.models,
    tokenComponents: delta.tokenComponents,
    totalTokens: delta.totalTokens
  }, { provider: PROVIDER, snapshot });
  return {
    pricedTokens: finiteNonNegInt(priced.pricedTokens),
    unpricedTokens: finiteNonNegInt(priced.unpricedTokens),
    apiEquivalentCostUsd: finiteNumber(priced.apiEquivalentCostUsd) ?? 0,
    pricingCoverage: finiteFraction(priced.pricingCoverage),
    snapshotId: snapshotIdOf(priced) || snapshotIdOf(snapshot)
  };
}

function zeroPricedDelta(snapshotId) {
  return {
    pricedTokens: 0,
    unpricedTokens: 0,
    apiEquivalentCostUsd: 0,
    pricingCoverage: null,
    snapshotId
  };
}

function cumulativeCoverage(pricedTokens, unpricedTokens) {
  const total = pricedTokens + unpricedTokens;
  return total > 0 ? pricedTokens / total : null;
}

function roundMoney(value) {
  return Number(value.toFixed(10));
}

function nextSegmentId(profileId, window, snapshotId, observedAt, previous) {
  const next = {
    resetsAt: window.resetsAt,
    usedPercent: window.usedPercent,
    observedAt
  };
  const snapshotChanged = previous && previous.snapshotId && previous.snapshotId !== snapshotId;
  const successor = previous ? isSuccessorQuotaCycle(previous, next) : false;
  if (!previous?.segmentId || snapshotChanged || successor) {
    return `${profileId}|${safeText(window.kind, 32)}|${isoTimestamp(window.resetsAt) || observedAt}|${snapshotId || 'none'}`;
  }
  return previous.segmentId;
}

// Newest sample of one (profile, window, segment) stream plus how many rows
// the segment already holds. An index (not just the row) is needed because a
// same-percent tick folds its increment into that very row in place, and the
// count tells the caller whether that row is still the segment's baseline.
function segmentSampleInfo(rows, profileId, kind, limitId, segmentId) {
  let newestIndex = -1;
  let sampleCount = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (
      row
      && row.profileId === profileId
      && row.kind === kind
      && (row.limitId || kind) === limitId
      && row.segmentId === segmentId
    ) {
      if (newestIndex === -1) newestIndex = index;
      sampleCount += 1;
    }
  }
  return { newestIndex, sampleCount };
}

function isReadyArchive(archive) {
  return Boolean(
    archive
    && archive.version === ARCHIVE_VERSION
    && Array.isArray(archive.observations)
    && Array.isArray(archive.accountingSamples)
    && archive.scopes
    && typeof archive.scopes === 'object'
    && archive.windowState
    && typeof archive.windowState === 'object'
  );
}

// Minimal, strict structural validation for the CURRENT archive version,
// run at the load boundary BEFORE the lenient normalize. It separates two
// very different kinds of damage: ordinary dirty values that normalize may
// compatibly clean (a malformed timestamp, an out-of-range percentage) from
// evidence whose structure is no longer believable (an array replaced by a
// string, a map replaced by a scalar or array, non-object rows). Only the
// second kind must lock the archive: normalizing it would silently turn the
// damage into empty collections and the next capture would overwrite the
// original file. Returns a stable non-empty error code, or '' when the
// document shape is believable.
function codexQuotaArchiveStructureError(value) {
  if (!isPlainObject(value)) return 'archive-not-object';
  if (!Array.isArray(value.observations)) return 'observations-not-array';
  if (!Array.isArray(value.accountingSamples)) return 'accounting-samples-not-array';
  if (!isPlainObject(value.scopes)) return 'scopes-not-object';
  if (!isPlainObject(value.windowState)) return 'window-state-not-object';
  if (value.lastProfileId !== undefined && typeof value.lastProfileId !== 'string') {
    return 'last-profile-id-not-string';
  }
  for (const row of value.observations) {
    if (!isPlainObject(row)) return 'observation-not-object';
  }
  for (const row of value.accountingSamples) {
    if (!isPlainObject(row)) return 'accounting-sample-not-object';
  }
  for (const entry of Object.values(value.scopes)) {
    if (!isPlainObject(entry)) return 'scope-entry-not-object';
  }
  for (const entry of Object.values(value.windowState)) {
    if (!isPlainObject(entry)) return 'window-state-entry-not-object';
  }
  return '';
}

// Change-point sampling. Raw usage watermarks, per-profile accumulators and
// window state advance on every trusted tick, but observation/accounting rows
// are only appended at real change points — first valid point of a segment,
// official percentage change, new quota cycle, pricing snapshot change, a
// rollback/gap that needs evidence, or a WSL mixed/reseed / account-return
// integrity boundary. A tick whose tokens grow while the official percentage
// holds still folds its increment into the segment's latest sample, so the
// next percentage change carries the whole same-percent accumulation instead
// of only the last tick. Same-percent boundary ticks are the exception: a
// WSL enter/reseed, or the first tick back on a profile that already has
// local evidence, appends an `unsettled` row instead, so the fold cannot
// glue pre-gap and post-reseed samples into one unbroken chain.
function observeCodexQuota(archive, input = {}) {
  const current = isReadyArchive(archive) ? archive : normalizeCodexQuotaArchive(archive);
  const device = input.device && typeof input.device === 'object' ? input.device : null;
  const usageDevice = (input.usageDevice && typeof input.usageDevice === 'object' ? input.usageDevice : device);
  const limitsDevice = (input.limitsDevice && typeof input.limitsDevice === 'object' ? input.limitsDevice : device);
  const provider = liveCodexProviderFrom(limitsDevice);
  const observedAt = isoTimestamp(input.observedAt)
    || resolveCodexQuotaObservedAt(limitsDevice || usageDevice);
  if (!provider || !observedAt) return current;
  const observedAtMs = Date.parse(observedAt);

  const profileId = scopeProfileId(provider.accountKey);
  const windows = canonicalWindows(provider);
  if (!windows.length) return current;

  const snapshot = input.snapshot || DEFAULT_API_PRICING_SNAPSHOT;
  const currentSnapshotId = snapshotIdOf(snapshot);
  const usage = deriveCodexExclusiveUsage(usageDevice?.allTime || {});
  const previousScope = current.scopes[profileId] || null;
  const wslBlocked = wslUsageObscuresLocalCodex(usageDevice);
  // Recovery from a merged span is a two-step handshake. The first clean tick
  // only re-baselines the Windows-only watermark: its delta versus the merged
  // watermark cannot be proven to be Windows usage, so it is not priced. Only
  // the next clean, monotonic tick is measured against that fresh baseline.
  const wslReseed = !wslBlocked && previousScope?.wslMerged === true;
  // Same-percent mixed/reseed ticks would otherwise be swallowed by the fold
  // optimization, leaving a 0%→100% cycle looking like an unbroken chain.
  // Entering an unattributable span, and the reseed that ends one, are forced
  // change points even when usedPercent is unchanged. Later mixed ticks at
  // the same percent still do not grow the ledger, and neither span is priced.
  const enteringWslMixed = wslBlocked && previousScope?.wslMerged !== true;
  const switchedAccount = Boolean(current.lastProfileId && current.lastProfileId !== profileId);
  // Switching back to a profile that already holds local evidence interrupts
  // that profile's observation chain even when the official percentage is
  // identical to the one seen before the switch: the return tick reseeds the
  // raw watermark, and without an integrity boundary the fold would glue
  // pre-switch and post-switch samples into one unbroken chain, letting a
  // switch-crossed cycle claim it was cleanly observed throughout. First
  // sight of a profile (`!previousScope`) is different: it only establishes a
  // baseline, so a brand-new account's first cycle is not polluted just
  // because some other profile ran before it. The marker is still skipped
  // when the return lands on a fresh segment baseline (a quota cycle that
  // started while another account was live): that cycle has no pre-gap
  // evidence to protect and must be allowed to become stable on its own.
  const accountReseed = switchedAccount && Boolean(previousScope);
  const integrityBoundary = enteringWslMixed || wslReseed || accountReseed;
  // First sight of a profile, a return from another account, a Windows/WSL
  // merged span, or the first clean tick after one: the increment across that
  // boundary is not attributable to this account, so it is not priced. The
  // raw watermark still advances, so the next trusted tick starts from a
  // clean baseline.
  const skipDelta = !previousScope || switchedAccount || wslBlocked || wslReseed;
  const delta = skipDelta
    ? { rollback: false, models: {}, tokenComponents: {}, totalTokens: 0 }
    : subtractComponents(usage, previousScope);
  const unsettledTick = delta.rollback;
  const creditDelta = !skipDelta && !unsettledTick;
  // A credited tick that actually moved the watermark; a zero delta must not
  // force a fresh archive object (and a JSON write) on every idle tick.
  const deltaAdvanced = creditDelta && delta.totalTokens > 0;
  const pricedDelta = creditDelta ? priceDelta(delta, snapshot) : zeroPricedDelta(currentSnapshotId);

  let next = null;
  const ensureClone = () => {
    if (next) return next;
    next = {
      version: ARCHIVE_VERSION,
      observations: current.observations.slice(),
      accountingSamples: current.accountingSamples.slice(),
      scopes: cloneMap(current.scopes),
      windowState: cloneMap(current.windowState),
      lastProfileId: current.lastProfileId || ''
    };
    return next;
  };

  for (const window of windows) {
    const kind = safeText(window.kind, 32);
    const limitId = safeText(window.limitId, 128) || kind;
    const usedPercent = finiteNumber(window.usedPercent);
    const windowMinutes = finiteNumber(window.windowMinutes);
    const resetsAt = isoTimestamp(window.resetsAt);
    const resetsAtMs = Date.parse(resetsAt);
    // Usage and limits refresh independently. Once the advertised reset time
    // has passed, a usage tick paired with that stale limits snapshot may
    // already belong to the next quota cycle. It cannot be credited to the
    // expired window without event-time accounting, so fail closed for this
    // window while still allowing a longer-lived window (for example Weekly)
    // to receive the same otherwise attributable delta.
    const windowExpired = Number.isFinite(observedAtMs)
      && Number.isFinite(resetsAtMs)
      && observedAtMs >= resetsAtMs;
    const stateKey = `${profileId}|${kind}|${limitId}`;
    const previousWindow = current.windowState[stateKey] || null;
    const snapshotChanged = Boolean(previousWindow?.snapshotId && previousWindow.snapshotId !== currentSnapshotId);
    const segmentId = nextSegmentId(profileId, {
      kind,
      resetsAt,
      usedPercent
    }, currentSnapshotId, observedAt, previousWindow);
    const newSegment = !previousWindow
      || previousWindow.segmentId !== segmentId
      || snapshotChanged
      || unsettledTick;
    const percentChanged = Boolean(previousWindow && previousWindow.usedPercent !== usedPercent);
    const enteringExpiredWindow = windowExpired && previousWindow?.expired !== true;
    const { newestIndex: sampleIndex, sampleCount } = segmentSampleInfo(
      current.accountingSamples, profileId, kind, limitId, segmentId
    );
    const previousSample = sampleIndex >= 0 ? current.accountingSamples[sampleIndex] : null;
    // A segment whose newest sample was evicted by retention cannot fold into
    // anything: restart its ledger at a fresh baseline instead of inventing
    // cumulative totals.
    const baselineMissing = newSegment || !previousSample;
    // The segment's first row is its zero baseline; folding into it would
    // destroy the anchor every cycle delta is measured against, so a
    // same-percent increment right after the baseline appends a row instead.
    const onlyBaselineRow = Boolean(previousSample) && sampleCount <= 1;
    const addPriced = baselineMissing || windowExpired ? 0 : pricedDelta.pricedTokens;
    const addUnpriced = baselineMissing || windowExpired ? 0 : pricedDelta.unpricedTokens;
    const addTokens = addPriced + addUnpriced;
    const changePoint = baselineMissing || percentChanged || integrityBoundary || enteringExpiredWindow;
    const appendRow = changePoint || onlyBaselineRow;
    const foldIntoSample = !appendRow && addTokens > 0;

    if (!appendRow && !foldIntoSample) continue;

    const target = ensureClone();
    if (appendRow) {
      const pricedTokens = baselineMissing ? 0 : finiteNonNegInt(previousSample?.pricedTokens) + addPriced;
      const unpricedTokens = baselineMissing ? 0 : finiteNonNegInt(previousSample?.unpricedTokens) + addUnpriced;
      // A baseline-protecting append (same percent, same segment) is not a
      // change point: it adds the sample row the folds will target, but no
      // observation, because nothing official changed.
      if (changePoint) {
        target.observations.push({
          observedAt,
          provider: PROVIDER,
          profileId,
          kind,
          limitId,
          windowMinutes,
          resetsAt,
          segmentId,
          usedPercent
        });
      }
      target.accountingSamples.push({
        observedAt,
        provider: PROVIDER,
        profileId,
        kind,
        limitId,
        windowMinutes,
        resetsAt,
        segmentId,
        usedPercent,
        sampleId: `${profileId}-${kind}-${observedAt}`.slice(0, 80),
        scopeVersion: SCOPE_VERSION,
        snapshotId: currentSnapshotId,
        observedTotalTokens: baselineMissing ? 0 : finiteNonNegInt(previousSample?.observedTotalTokens) + addTokens,
        pricedTokens,
        unpricedTokens,
        apiEquivalentCostUsd: baselineMissing
          ? 0
          : roundMoney((finiteNumber(previousSample?.apiEquivalentCostUsd) ?? 0) + pricedDelta.apiEquivalentCostUsd),
        pricingCoverage: cumulativeCoverage(pricedTokens, unpricedTokens),
        // unsettled leaves gap evidence through the existing cycle-gap
        // mechanism: a rollback, a merged WSL span, the reseed tick that ends
        // one, or a return from another account all price nothing locally, so
        // the cycle can never be advertised as cleanly observed across that
        // gap. An account return that lands on a fresh segment baseline is
        // excluded: a cycle that started while another account was live has
        // no pre-gap chain to protect.
        ...(unsettledTick || wslBlocked || wslReseed || windowExpired || (accountReseed && !baselineMissing)
          ? { unsettled: true }
          : {})
      });
    } else {
      // Same percentage, same segment: fold this tick's increment into the
      // existing change-point row so the ledger grows by zero rows.
      const pricedTokens = finiteNonNegInt(previousSample.pricedTokens) + addPriced;
      const unpricedTokens = finiteNonNegInt(previousSample.unpricedTokens) + addUnpriced;
      target.accountingSamples[sampleIndex] = {
        ...previousSample,
        observedAt,
        windowMinutes,
        resetsAt,
        observedTotalTokens: finiteNonNegInt(previousSample.observedTotalTokens) + addTokens,
        pricedTokens,
        unpricedTokens,
        apiEquivalentCostUsd: roundMoney((finiteNumber(previousSample.apiEquivalentCostUsd) ?? 0) + pricedDelta.apiEquivalentCostUsd),
        pricingCoverage: cumulativeCoverage(pricedTokens, unpricedTokens)
      };
    }
    target.windowState[stateKey] = {
      profileId,
      kind,
      limitId,
      windowMinutes,
      resetsAt,
      usedPercent,
      segmentId,
      snapshotId: currentSnapshotId,
      observedAt,
      ...(windowExpired ? { expired: true } : {})
    };
  }

  const scopeUnchanged = previousScope
    && previousScope.totalTokens === usage.totalTokens
    && previousScope.snapshotId === currentSnapshotId
    && (previousScope.wslMerged === true) === wslBlocked
    && !switchedAccount
    && !unsettledTick
    && !deltaAdvanced;
  if (!next && scopeUnchanged) return current;

  const target = ensureClone();
  target.lastProfileId = profileId;
  target.scopes[profileId] = {
    profileId,
    totalTokens: usage.totalTokens,
    // Per-profile lifetime credited accumulators: they advance only with a
    // trusted, attributable increment and never reset on reseed, so a restart
    // or an unattributable boundary cannot double-count or lose them.
    pricedTokens: finiteNonNegInt(previousScope?.pricedTokens) + (deltaAdvanced ? pricedDelta.pricedTokens : 0),
    unpricedTokens: finiteNonNegInt(previousScope?.unpricedTokens) + (deltaAdvanced ? pricedDelta.unpricedTokens : 0),
    apiEquivalentCostUsd: roundMoney(
      (finiteNumber(previousScope?.apiEquivalentCostUsd) ?? 0)
      + (deltaAdvanced ? pricedDelta.apiEquivalentCostUsd : 0)
    ),
    snapshotId: currentSnapshotId,
    lastObservedAt: observedAt,
    models: { ...usage.models },
    components: Object.fromEntries(
      Object.entries(usage.tokenComponents).map(([model, row]) => {
        const entry = {};
        for (const category of COMPONENT_CATEGORIES) {
          const tokens = finiteNonNegInt(row?.[category]);
          if (tokens > 0) entry[category] = tokens;
        }
        return [model, entry];
      }).filter(([, entry]) => Object.keys(entry).length)
    ),
    ...(wslBlocked ? { wslMerged: true } : {})
  };
  const trimmed = trimCodexQuotaArchiveRows(target.observations, target.accountingSamples);
  target.observations = trimmed.observations;
  target.accountingSamples = trimmed.accountingSamples;
  return target;
}

function projectWindowEstimate(summary) {
  if (!summary) return { ...COLLECTING_ESTIMATE, reasons: [] };
  const confidence = CONFIDENCE.has(summary.confidence) ? summary.confidence : 'collecting';
  const pricedUsd = positiveNumber(summary.locallyObservedApiEquivalent);
  const capacityUsd = positiveNumber(summary.estimatedCapacity);
  const usedPercent = finiteNumber(summary.officialUsedPercent);
  const officialPercentValid = usedPercent !== null && usedPercent >= 0 && usedPercent <= 100;
  // Capacity still has to be strictly > 0. Remaining is the one derived
  // amount that is mathematically 0 at 100% used, and that zero is a real
  // empty balance, not "no evidence". Collecting / missing capacity /
  // invalid percent still collapse to null so we never show a fake $0.
  const remainingUsd = capacityUsd === null || !officialPercentValid
    ? null
    : nonNegativeNumber(summary.derivedRemaining);
  return {
    observedTokens: positiveNumber(summary.locallyObservedTokens),
    pricedUsd,
    coverage: finiteFraction(summary.pricingCoverage),
    capacityUsd,
    remainingUsd,
    confidence,
    snapshotId: safeText(summary.pricingReferenceIdentity, 120),
    reasons: Array.isArray(summary.reasons) ? summary.reasons.slice(0, 16).map((reason) => safeText(reason, 80)).filter(Boolean) : []
  };
}

function projectCodexQuotaForProvider(archive, provider) {
  const profileId = scopeProfileId(provider?.accountKey);
  const normalized = isReadyArchive(archive) ? archive : normalizeCodexQuotaArchive(archive);
  const snapshot = buildProfileQuotaSnapshot({
    provider: PROVIDER,
    profileId,
    observations: normalized.observations,
    accountingSamples: normalized.accountingSamples
  });
  const wslMerged = normalized.scopes[profileId]?.wslMerged === true;
  const byKind = {};
  for (const summary of snapshot.accountQuotaSummaries || []) {
    const kind = safeText(summary.windowKind, 32);
    if (!CANONICAL_WINDOW_KINDS.includes(kind)) continue;
    if (wslMerged) {
      // Windows/WSL merged counters: the official percentage stays visible,
      // but local tokens and dollars are unattributable, so they fail closed
      // with a single stable reason instead of a merged total.
      const estimate = projectWindowEstimate(summary);
      byKind[kind] = {
        ...estimate,
        observedTokens: null,
        pricedUsd: null,
        coverage: null,
        confidence: 'collecting',
        reasons: [WSL_MERGED_REASON]
      };
      continue;
    }
    byKind[kind] = projectWindowEstimate(summary);
  }
  return { profileId, byKind };
}

function withWindowEstimate(window, estimate) {
  if (!window || !estimate) return window;
  if (window.quotaEstimate === estimate) return window;
  return { ...window, quotaEstimate: estimate };
}

function attachProviderEstimates(provider, archive, options) {
  if (!isLiveCodexProvider(provider) || !isLocalDeviceProvider(provider, options)) return provider;
  const projected = projectCodexQuotaForProvider(archive, provider);
  let changed = false;
  const windows = (provider.windows || []).map((window) => {
    const kind = safeText(window?.kind, 32);
    if (window?.additional === true || !CANONICAL_WINDOW_KINDS.includes(kind)) return window;
    const estimate = projected.byKind[kind] || { ...COLLECTING_ESTIMATE, reasons: [] };
    const next = withWindowEstimate(window, estimate);
    if (next !== window) changed = true;
    return next;
  });
  return changed ? { ...provider, windows } : provider;
}

function attachCodexQuotaEstimates(stats, archive, options = {}) {
  if (!stats || typeof stats !== 'object') return stats;
  const normalized = isReadyArchive(archive) ? archive : normalizeCodexQuotaArchive(archive);
  let changed = false;

  const mapProviders = (providers) => {
    if (!Array.isArray(providers)) return providers;
    let providerChanged = false;
    const next = providers.map((provider) => {
      const attached = attachProviderEstimates(provider, normalized, options);
      if (attached !== provider) providerChanged = true;
      return attached;
    });
    if (providerChanged) changed = true;
    return providerChanged ? next : providers;
  };

  const nextDevices = Array.isArray(stats.devices)
    ? stats.devices.map((device) => {
      const providers = device?.limits?.providers;
      const nextProviders = mapProviders(providers);
      if (nextProviders === providers) return device;
      return {
        ...device,
        limits: {
          ...device.limits,
          providers: nextProviders
        }
      };
    })
    : stats.devices;
  const nextLimitsProviders = mapProviders(stats.limits?.providers);
  if (!changed) return stats;
  return {
    ...stats,
    ...(Array.isArray(stats.devices) ? { devices: nextDevices } : {}),
    ...(stats.limits ? {
      limits: {
        ...stats.limits,
        providers: nextLimitsProviders
      }
    } : {})
  };
}

module.exports = {
  ARCHIVE_VERSION,
  CANONICAL_WINDOW_KINDS,
  FALLBACK_PROFILE_ID,
  MAX_ARCHIVE_ROWS,
  MAX_ARCHIVE_ROWS_PER_WINDOW,
  WSL_MERGED_REASON,
  attachCodexQuotaEstimates,
  codexQuotaArchiveStructureError,
  deriveCodexExclusiveUsage,
  emptyCodexQuotaArchive,
  resolveCodexQuotaObservedAt,
  isLiveCodexProvider,
  isLocalDeviceProvider,
  normalizeCodexQuotaArchive,
  observeCodexQuota,
  projectCodexQuotaForProvider,
  scopeProfileId,
  trimCodexQuotaArchiveRows,
  wslUsageObscuresLocalCodex
};
