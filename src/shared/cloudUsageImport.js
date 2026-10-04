'use strict';

const MAX_RECORDS = 10000;
const TOKEN_FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'];
const CREATION_SOURCES = ['manual', 'dot', 'unknown'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function optionalCount(value, key, field) {
  if (!own(value, key) || value[key] === null) return null;
  return requireCount(value[key], field);
}

function safeAdd(left, right, field) {
  if (right > Number.MAX_SAFE_INTEGER - left) {
    throw new RangeError(`${field} exceeds the safe integer range`);
  }
  return left + right;
}

function requireDate(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${field} must be a real UTC date in YYYY-MM-DD format`);
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be a real UTC date in YYYY-MM-DD format`);
  }
  return value;
}

function requireIdentity(value, field) {
  if (typeof value !== 'string' || value.length > 200 || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string of at most 200 characters`);
  }
  // These are opaque authority-owned identities. Trimming or changing case would
  // collapse distinct records; export names and device ids never enter the key.
  return value;
}

function rejectUnsupportedUsageFields(value, field) {
  for (const key of Object.keys(value)) {
    const normalized = key.replace(/[-_]/g, '').toLowerCase();
    if (normalized === 'error') throw new TypeError(`${field} must not contain an error`);
    if (normalized === 'threadusage' && value[key] !== null) {
      throw new TypeError(`${field} must not contain estimated thread usage`);
    }
    if ((normalized.includes('estimate')
      && (/(token|usage|task|thread)/.test(normalized) || /^(estimated|isestimated)$/.test(normalized)))
      || (/^(taskusage|tasktokens|tasktokenusage)$/.test(normalized) && value[key] !== null)) {
      throw new TypeError(`${field} must not contain task usage estimates`);
    }
    if (normalized === 'measurement' && value[key] !== 'reported') {
      throw new TypeError(`${field}.measurement must be reported`);
    }
  }
}

/**
 * Normalize an offline official account/usage/read result. The daily buckets and
 * lifetime summary overlap, so no combined total or cloud attribution is made.
 */
function normalizeCodexAccountUsage(response) {
  requireObject(response, 'response');
  rejectUnsupportedUsageFields(response, 'response');
  let result = response;
  if (own(response, 'result')) {
    if (!own(response, 'id') || (response.id !== null
      && typeof response.id !== 'string' && !Number.isSafeInteger(response.id))) {
      throw new TypeError('response must be a result or a JSON-RPC response with an id');
    }
    result = requireObject(response.result, 'response.result');
    rejectUnsupportedUsageFields(result, 'response.result');
  }
  const summary = requireObject(result.summary, 'summary');
  rejectUnsupportedUsageFields(summary, 'summary');
  const normalizedSummary = {
    lifetimeTokens: optionalCount(summary, 'lifetimeTokens', 'summary.lifetimeTokens'),
    peakDailyTokens: optionalCount(summary, 'peakDailyTokens', 'summary.peakDailyTokens')
  };

  let dailyUsageBuckets = null;
  if (own(result, 'dailyUsageBuckets') && result.dailyUsageBuckets !== null) {
    if (!Array.isArray(result.dailyUsageBuckets) || result.dailyUsageBuckets.length > MAX_RECORDS) {
      throw new TypeError(`dailyUsageBuckets must be null or an array of at most ${MAX_RECORDS} records`);
    }
    const buckets = new Map();
    for (const [index, raw] of result.dailyUsageBuckets.entries()) {
      const field = `dailyUsageBuckets[${index}]`;
      const bucket = requireObject(raw, field);
      rejectUnsupportedUsageFields(bucket, field);
      const startDate = requireDate(bucket.startDate, `${field}.startDate`);
      const tokens = requireCount(bucket.tokens, `${field}.tokens`);
      if (buckets.has(startDate) && buckets.get(startDate) !== tokens) {
        throw new TypeError('dailyUsageBuckets contain conflicting counts for the same date');
      }
      buckets.set(startDate, tokens);
    }
    dailyUsageBuckets = [...buckets.keys()].sort().map(startDate => ({ startDate, tokens: buckets.get(startDate) }));
  }
  return {
    source: 'codex-account-usage',
    scope: 'account',
    execution: 'unknown',
    measurement: 'reported',
    canCombineWithLocal: false,
    realtime: false,
    summary: normalizedSummary,
    dailyUsageBuckets
  };
}

function normalizeTaskRecord(raw, field) {
  const record = requireObject(raw, field);
  rejectUnsupportedUsageFields(record, field);
  if (record.measurement !== 'reported') throw new TypeError(`${field}.measurement must be reported`);
  if (record.execution !== 'cloud') throw new TypeError(`${field}.execution must be cloud`);
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new TypeError(`${field}.revision must be a positive safe integer`);
  }
  const creationSource = record.creationSource ?? 'unknown';
  if (!CREATION_SOURCES.includes(creationSource)) {
    throw new TypeError(`${field}.creationSource must be manual, dot, or unknown`);
  }
  const creationSourceConflict = record.creationSourceConflict === undefined ? false : record.creationSourceConflict;
  if (typeof creationSourceConflict !== 'boolean') {
    throw new TypeError(`${field}.creationSourceConflict must be boolean`);
  }
  if (creationSourceConflict && creationSource !== 'unknown') {
    throw new TypeError(`${field}.creationSourceConflict requires unknown creationSource`);
  }
  const rawTokens = requireObject(record.tokens, `${field}.tokens`);
  rejectUnsupportedUsageFields(rawTokens, `${field}.tokens`);
  const tokens = {};
  for (const key of TOKEN_FIELDS) tokens[key] = requireCount(rawTokens[key], `${field}.tokens.${key}`);
  if (tokens.cachedInputTokens > tokens.inputTokens) {
    throw new TypeError(`${field}.tokens.cachedInputTokens must be a subset of inputTokens`);
  }
  if (tokens.reasoningOutputTokens > tokens.outputTokens) {
    throw new TypeError(`${field}.tokens.reasoningOutputTokens must be a subset of outputTokens`);
  }
  safeAdd(tokens.inputTokens, tokens.outputTokens, `${field}.tokens total`);
  return {
    provider: requireIdentity(record.provider, `${field}.provider`),
    scopeId: requireIdentity(record.scopeId, `${field}.scopeId`),
    taskId: requireIdentity(record.taskId, `${field}.taskId`),
    date: requireDate(record.date, `${field}.date`),
    model: requireIdentity(record.model, `${field}.model`),
    revision: record.revision,
    measurement: 'reported',
    execution: 'cloud',
    creationSource,
    creationSourceConflict,
    tokens
  };
}

function recordKey(record) {
  // provider identifies the actual measuring authority, never the exporter.
  return JSON.stringify([record.provider, record.scopeId, record.taskId, record.date, record.model]);
}

function taskKey(record) {
  return JSON.stringify([record.provider, record.scopeId, record.taskId]);
}

function collectTaskAttribution(records) {
  const attribution = new Map();
  for (const record of records) {
    const key = taskKey(record);
    if (!attribution.has(key)) attribution.set(key, { knownSources: new Set(), conflictSeen: false });
    const evidence = attribution.get(key);
    if (record.creationSource !== 'unknown') evidence.knownSources.add(record.creationSource);
    if (record.creationSourceConflict) evidence.conflictSeen = true;
  }
  return attribution;
}

function projectTaskAttribution(records, attribution) {
  return records.map(record => {
    const evidence = attribution.get(taskKey(record));
    const creationSourceConflict = evidence.conflictSeen || evidence.knownSources.size > 1;
    const creationSource = creationSourceConflict || evidence.knownSources.size === 0
      ? 'unknown' : [...evidence.knownSources][0];
    return { ...record, creationSource, creationSourceConflict };
  });
}

function sameCounts(left, right) {
  return TOKEN_FIELDS.every(key => left.tokens[key] === right.tokens[key]);
}

function requireRecords(value, field) {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) {
    throw new TypeError(`${field} must be an array of at most ${MAX_RECORDS} records`);
  }
  return value.map((record, index) => normalizeTaskRecord(record, `${field}[${index}]`));
}

function buildReport(records) {
  const totals = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  const daily = new Map();
  const tasks = new Set();
  const conflictTasks = new Set();
  const creationSources = {};
  for (const source of CREATION_SOURCES) creationSources[source] = { taskCount: 0, recordCount: 0, totalTokens: 0 };
  for (const record of records) {
    const total = safeAdd(record.tokens.inputTokens, record.tokens.outputTokens, 'report.totalTokens');
    totals.totalTokens = safeAdd(totals.totalTokens, total, 'report.totalTokens');
    for (const key of TOKEN_FIELDS) totals[key] = safeAdd(totals[key], record.tokens[key], `report.${key}`);
    daily.set(record.date, safeAdd(daily.get(record.date) || 0, total, 'report.daily totalTokens'));
    const bucket = creationSources[record.creationSource];
    bucket.recordCount = safeAdd(bucket.recordCount, 1, 'report.creationSources recordCount');
    bucket.totalTokens = safeAdd(bucket.totalTokens, total, 'report.creationSources totalTokens');
    const key = taskKey(record);
    if (!tasks.has(key)) bucket.taskCount = safeAdd(bucket.taskCount, 1, 'report.creationSources taskCount');
    tasks.add(key);
    if (record.creationSourceConflict) conflictTasks.add(key);
  }
  return {
    source: 'cloud-task-import',
    scope: 'task-day',
    execution: 'cloud',
    measurement: 'reported',
    realtime: false,
    canCombineWithLocal: false,
    taskCount: tasks.size,
    recordCount: records.length,
    ...totals,
    creationSources,
    attributionConflictTaskCount: conflictTasks.size,
    daily: [...daily.keys()].sort().map(date => ({ date, totalTokens: daily.get(date) }))
  };
}

/**
 * Import this project's custom, non-official task-day snapshot schema. A higher
 * revision replaces the whole snapshot, including downward corrections. Work
 * happens on fresh objects, so all validation/conflict failures are atomic.
 */
function importCloudTaskUsage(envelope, previousLedger = null) {
  requireObject(envelope, 'envelope');
  rejectUnsupportedUsageFields(envelope, 'envelope');
  if (envelope.version !== 1 || envelope.kind !== 'cloud-task-usage') {
    throw new TypeError('envelope must have version 1 and kind cloud-task-usage');
  }

  const previousRecords = [];
  if (previousLedger !== null) {
    requireObject(previousLedger, 'previousLedger');
    if (previousLedger.version !== 1 || previousLedger.kind !== 'cloud-task-usage-ledger') {
      throw new TypeError('previousLedger must have version 1 and kind cloud-task-usage-ledger');
    }
    previousRecords.push(...requireRecords(previousLedger.records, 'previousLedger.records'));
    const seen = new Set();
    for (const record of previousRecords) {
      const key = recordKey(record);
      if (seen.has(key)) throw new TypeError('previousLedger.records must contain unique snapshot identities');
      seen.add(key);
    }
    // A corrupt previous total must fail even when an incoming revision would
    // overwrite it. The persisted report itself is untrusted and is rebuilt.
    buildReport(projectTaskAttribution(previousRecords, collectTaskAttribution(previousRecords)));
  }
  const incoming = requireRecords(envelope.records, 'envelope.records');
  const merged = new Map();
  const revisions = new Map();
  for (const record of [...previousRecords, ...incoming]) {
    const key = recordKey(record);
    if (!revisions.has(key)) revisions.set(key, new Map());
    const seenRevisions = revisions.get(key);
    if (seenRevisions.has(record.revision) && !sameCounts(seenRevisions.get(record.revision), record)) {
      throw new TypeError('records contain conflicting counts for the same snapshot revision');
    }
    seenRevisions.set(record.revision, record);
    const previous = merged.get(key);
    if (!previous || record.revision > previous.revision) merged.set(key, record);
  }
  if (merged.size > MAX_RECORDS) {
    throw new RangeError(`merged ledger exceeds ${MAX_RECORDS} records`);
  }
  // Creation labels are offline declarations, not authenticated provenance.
  // Even stale counters can supply attribution evidence for the whole task.
  // Persisting the conflict bit keeps a later known label from erasing history.
  const attribution = collectTaskAttribution([...previousRecords, ...incoming]);
  const records = projectTaskAttribution([...merged.keys()].sort().map(key => merged.get(key)), attribution);
  return { version: 1, kind: 'cloud-task-usage-ledger', records, report: buildReport(records) };
}

module.exports = { normalizeCodexAccountUsage, importCloudTaskUsage };
