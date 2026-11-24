'use strict';

// Native Reasonix session metadata is deliberately kept outside the Tokscale
// period/session collections. Tokscale owns the aggregate usage contract:
// stats/*.jsonl is the aggregate authority. The .jsonl.meta, .events.jsonl and
// .jsonl.telemetry.json files are native session metadata; telemetry is
// trusted cumulative session usage, not authoritative per-turn usage.
// It is Node-only because it reads the Reasonix filesystem directly.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { REASONIX_CLIENT, resolveReasonixHome } = require('./paths');
const META_SUFFIX = '.jsonl.meta';
const TELEMETRY_SUFFIX = '.jsonl.telemetry.json';
const EVENTS_SUFFIX = '.events.jsonl';
const {
  readBoundedJson,
  readReasonixTelemetryUsage,
  REASONIX_META_MAX_BYTES
} = require('./fileIo');
const { normalizeModelNameForClient } = require('../../usage');
const {
  readReasonixEventLog,
  countReasonixProviderMessages,
  reasonixBranchId,
  reasonixSessionFileRef
} = require('./sessionDetail');

const NATIVE_SESSION_PREFIX = `${REASONIX_CLIENT}:`;
const BRANCH_META_COUNTS_VERSION = 1;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function textValue(value, maxLength = 512) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maxLength) : '';
}

function firstText(value, keys, maxLength = 512) {
  const source = objectValue(value);
  if (!source) return '';
  for (const key of keys) {
    const text = textValue(source[key], maxLength);
    if (text) return text;
  }
  return '';
}

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[$,]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function hasFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' && value.trim() !== '') return Number.isFinite(Number(value.replace(/[$,]/g, '')));
  return false;
}

function nonNegativeNumber(value) {
  return Math.max(0, finiteNumber(value));
}

function integerValue(value) {
  return Math.max(0, Math.trunc(nonNegativeNumber(value)));
}

function firstValue(source, keys) {
  const value = objectValue(source);
  if (!value) return undefined;
  for (const key of keys) {
    if (hasOwn(value, key)) return value[key];
  }
  return undefined;
}

function firstNumber(source, keys) {
  const value = firstValue(source, keys);
  return hasFiniteNumber(value) ? finiteNumber(value) : 0;
}

function firstTimestamp(source, keys) {
  const value = firstValue(source, keys);
  let date = null;
  if (typeof value === 'number' && Number.isFinite(value)) date = new Date(value);
  else if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim();
    date = /^[-+]?\d+$/.test(text) ? new Date(Number(text)) : new Date(text);
  }
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
}

function dirExists(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; }
}

function fileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return '';
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (_) {
    return '';
  }
}

// The official layout has two generations in the wild:
//   <state>/sessions                 legacy/global sessions
//   <state>/projects/<key>/sessions  routed project sessions
// Read only the official one-level project/session layout when requested.
function reasonixSessionDirectories(options = {}) {
  const pathApi = options.pathModule || path;
  const home = resolveReasonixHome({ homeDir: os.homedir(), env: process.env, platform: process.platform, cwdDir: process.cwd(), ...options });
  const legacyRoot = pathApi.join(home, 'sessions');
  const projectsRoot = pathApi.join(home, 'projects');
  const directories = [];

  if (dirExists(legacyRoot)) directories.push(legacyRoot);
  if (dirExists(projectsRoot)) {
    let entries = [];
    try { entries = fs.readdirSync(projectsRoot, { withFileTypes: true }); } catch (_) {}
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const sessionsDir = pathApi.join(projectsRoot, entry.name, 'sessions');
      if (dirExists(sessionsDir)) directories.push(sessionsDir);
    }
  }
  return directories;
}

function sidecarCandidates(sessionDirectories, pathApi = path) {
  const byDirectoryAndStem = new Map();
  for (const directory of sessionDirectories || []) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      let suffix = '';
      if (name.endsWith(META_SUFFIX)) suffix = META_SUFFIX;
      else if (name.endsWith(TELEMETRY_SUFFIX)) suffix = TELEMETRY_SUFFIX;
      else if (name.endsWith(EVENTS_SUFFIX)) suffix = EVENTS_SUFFIX;
      if (!suffix) continue;
      const stem = name.slice(0, -suffix.length);
      if (!stem) continue;
      const filePath = pathApi.join(directory, name);
      // The stable public identity comes from BranchMeta.ID, but scanner/cache
      // identity must remain directory-local so routed projects can reuse a
      // filename without one sidecar pair overwriting another.
      const candidateKey = pathApi.join(directory, stem);
      const current = byDirectoryAndStem.get(candidateKey) || { stem, directory };
      if (suffix === META_SUFFIX) current.metaPath = filePath;
      else if (suffix === TELEMETRY_SUFFIX) current.telemetryPath = filePath;
      else current.eventPath = filePath;
      byDirectoryAndStem.set(candidateKey, current);
    }
  }
  return [...byDirectoryAndStem.values()].sort((left, right) => {
    const leftPath = left.metaPath || left.telemetryPath || '';
    const rightPath = right.metaPath || right.telemetryPath || '';
    return leftPath.localeCompare(rightPath);
  });
}

function sessionTitle(meta, { trustedPreview = '' } = {}) {
  return firstText(meta, ['custom_title', 'customTitle', 'name'])
    || firstText(meta, ['topic_title', 'topicTitle'])
    || trustedPreview
    || 'Reasonix Session';
}

function reportedCostUsd(usage) {
  const explicitUsd = firstValue(usage, ['sessionCostUsd', 'session_cost_usd']);
  if (hasFiniteNumber(explicitUsd)) return Math.max(0, finiteNumber(explicitUsd));

  const sessionCost = firstValue(usage, ['sessionCost', 'session_cost']);
  const sessionCurrency = textValue(firstValue(usage, ['sessionCurrency', 'session_currency']), 16).toUpperCase();
  if (sessionCurrency === 'USD' && hasFiniteNumber(sessionCost)) return Math.max(0, finiteNumber(sessionCost));
  return undefined;
}

function readTranscriptInfo(eventPath, replayLimits) {
  if (!eventPath) return null;
  try {
    const replay = readReasonixEventLog(eventPath, { replayLimits });
    if (!replay.ok) return null;
    const events = replay.events || [];
    let latestMessageMs = 0;
    for (const event of events || []) {
      const timestamp = Date.parse(event?.timestamp || '');
      if (Number.isFinite(timestamp) && timestamp > latestMessageMs) latestMessageMs = timestamp;
    }
    return {
      messageCount: countReasonixProviderMessages(events),
      ...(latestMessageMs > 0 ? { lastMessageAt: new Date(latestMessageMs).toISOString() } : {})
    };
  } catch (_) {
    return null;
  }
}

function readReasonixNativeSession(metaPath, telemetryPath, options = {}) {
  const fsApi = options.fsModule || fs;
  const meta = readBoundedJson(metaPath, REASONIX_META_MAX_BYTES, fsApi);
  if (!meta) return null;
  const id = reasonixBranchId(meta);
  if (!id) return null;

  // `stats/*.jsonl` is the Tokscale aggregate authority. This native session
  // view reads BranchMeta and official events for identity, preview, timestamps
  // and message counts. `.jsonl.telemetry.json`, when present, is Reasonix
  // Desktop's official trusted cumulative session usage, not authoritative
  // per-turn usage.
  const telemetryUsage = readReasonixTelemetryUsage(telemetryPath, fsApi);
  const usage = telemetryUsage && hasFiniteNumber(firstValue(telemetryUsage, ['totalTokens', 'total_tokens']))
    ? telemetryUsage
    : null;
  const eventFilePresent = Boolean(fileSignature(options.eventPath));
  const transcript = readTranscriptInfo(options.eventPath, options.replayLimits);
  if (eventFilePresent && !transcript) return null;
  if (!usage && !transcript) return null;

  const rawSchemaVersion = firstValue(meta, ['schema_version', 'schemaVersion']);
  const schemaVersion = hasFiniteNumber(rawSchemaVersion) ? integerValue(rawSchemaVersion) : 0;
  const countsTrusted = schemaVersion >= BRANCH_META_COUNTS_VERSION;
  const rawModel = textValue(firstValue(meta, ['model']), 256);
  const model = normalizeModelNameForClient(rawModel, REASONIX_CLIENT) || rawModel;
  const totalTokens = usage ? Math.max(0, Math.round(firstNumber(usage, ['totalTokens', 'total_tokens']))) : 0;
  const reportedCost = reportedCostUsd(usage);
  const promptTokens = integerValue(firstNumber(usage, ['promptTokens', 'prompt_tokens']));
  const cacheReadTokens = integerValue(firstNumber(usage, ['cacheHitTokens', 'cache_hit_tokens']));
  const explicitCacheMisses = firstValue(usage, ['cacheMissTokens', 'cache_miss_tokens']);
  const inputTokens = hasFiniteNumber(explicitCacheMisses)
    ? nonNegativeNumber(explicitCacheMisses)
    : Math.max(0, promptTokens - cacheReadTokens);
  const createdAt = firstTimestamp(meta, ['created_at', 'createdAt']);
  const updatedAt = firstTimestamp(meta, ['updated_at', 'updatedAt']);
  const topicId = textValue(firstValue(meta, ['topic_id', 'topicId']), 256);
  const topicTitle = firstText(meta, ['topic_title', 'topicTitle']);
  const customTitle = firstText(meta, ['custom_title', 'customTitle', 'name']);
  const preview = countsTrusted
    ? firstText(meta, ['preview'], 256) || firstText(meta?.preview, ['text', 'content', 'value'], 256)
    : '';

  return {
    native: true,
    client: REASONIX_CLIENT,
    sessionId: `${NATIVE_SESSION_PREFIX}${id}`,
    reasonixSessionRef: reasonixSessionFileRef(metaPath),
    title: sessionTitle(meta, { trustedPreview: preview }),
    ...(model ? { model, models: usage ? { [model]: totalTokens } : {} } : { models: {} }),
    ...(createdAt ? { createdAt, startedAt: createdAt } : {}),
    ...(updatedAt ? { updatedAt, lastUsedAt: updatedAt } : {}),
    ...(usage ? {
      totalTokens,
      inputTokens,
      cacheReadTokens,
      cacheReported: nonNegativeNumber(explicitCacheMisses) > 0,
      completionTokens: integerValue(firstNumber(usage, ['completionTokens', 'completion_tokens'])),
      reasoningTokens: integerValue(firstNumber(usage, ['reasoningTokens', 'reasoning_tokens'])),
      cacheWriteTokens: integerValue(firstNumber(usage, ['cacheWriteTokens', 'cache_write_tokens'])),
      requestCount: integerValue(firstNumber(usage, ['requestCount', 'request_count']))
    } : { tokenDataUnavailable: true }),
    ...(reportedCost === undefined ? {} : { reportedCostUsd: reportedCost }),
    sessionDetailAvailable: Boolean(transcript?.messageCount),
    ...(transcript ? { messageCount: transcript.messageCount } : {}),
    ...(transcript?.lastMessageAt ? { lastMessageAt: transcript.lastMessageAt } : {}),
    ...(hasFiniteNumber(rawSchemaVersion) ? { schemaVersion } : {}),
    ...(countsTrusted && hasFiniteNumber(firstValue(meta, ['turns'])) ? { turns: integerValue(firstNumber(meta, ['turns'])) } : {}),
    ...(topicId ? { topicId } : {}),
    ...(topicTitle ? { topicTitle } : {}),
    ...(customTitle ? { customTitle } : {}),
    ...(countsTrusted && preview ? { preview } : {}),
    ...(textValue(firstValue(meta, ['parent_id', 'parentId']), 256) ? { parentId: textValue(firstValue(meta, ['parent_id', 'parentId']), 256) } : {}),
    ...(hasFiniteNumber(firstValue(meta, ['fork_turn', 'forkTurn'])) ? { forkTurn: integerValue(firstValue(meta, ['fork_turn', 'forkTurn'])) } : {}),
    ...(hasFiniteNumber(firstValue(meta, ['fork_message_index', 'forkMessageIndex'])) ? { forkMessageIndex: integerValue(firstValue(meta, ['fork_message_index', 'forkMessageIndex'])) } : {})
  };
}

function localDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function localDateBoundary(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = textValue(value, 128);
  if (!text) return Number.NEGATIVE_INFINITY;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function sessionPeriodKeys(session, now, allTimeSince) {
  const createdAt = session?.createdAt ? new Date(session.createdAt) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) return { day: '', month: '', allTime: false };
  // A resumed branch keeps its original BranchMeta.created_at. When the
  // trusted official event log has message timestamps, use the latest one for
  // the bounded live windows; metadata.updated_at can also change for a title
  // rename and must not turn an old session into a new day's activity.
  const activityAt = session?.lastMessageAt ? new Date(session.lastMessageAt) : createdAt;
  const activityDate = Number.isNaN(activityAt.getTime()) ? createdAt : activityAt;
  const day = localDayKey(activityDate);
  const month = localMonthKey(activityDate);
  const since = localDateBoundary(allTimeSince);
  const allTime = since !== null && createdAt.getTime() >= since;
  return {
    day: day === localDayKey(now) ? day : '',
    month: month === localMonthKey(now) ? month : '',
    allTime,
  };
}

function readReasonixNativeSessions(options = {}) {
  const now = options.now || new Date();
  const byId = new Map();
  for (const { metaPath, telemetryPath, eventPath } of sidecarCandidates(reasonixSessionDirectories(options), options.pathModule)) {
    if (!metaPath || (!telemetryPath && !eventPath)) continue;
    const session = readReasonixNativeSession(metaPath, telemetryPath, { ...options, eventPath });
    if (!session) continue;
    const previous = byId.get(session.sessionId);
    const sortAt = row => Date.parse(row?.lastUsedAt || row?.startedAt || '') || 0;
    if (!previous || sortAt(session) >= sortAt(previous)) byId.set(session.sessionId, session);
  }

  const sessions = { today: {}, month: {}, allTime: {} };
  for (const session of byId.values()) {
    const periods = sessionPeriodKeys(session, now, options.allTimeSince);
    if (periods.day) sessions.today[session.sessionId] = session;
    if (periods.month) sessions.month[session.sessionId] = session;
    if (periods.allTime) sessions.allTime[session.sessionId] = session;
  }
  return sessions;
}

module.exports = { readReasonixNativeSession, readReasonixNativeSessions };
