'use strict';

// Native Reasonix session metadata is deliberately kept outside the Tokscale
// period/session collections. Tokscale owns the aggregate usage contract:
// stats/*.jsonl is the aggregate authority. The .jsonl.meta, .events.jsonl and
// .jsonl.telemetry.json files are native Session/Project metadata; telemetry is
// trusted cumulative session usage, not authoritative per-turn usage.
// It is Node-only because it reads the Reasonix filesystem directly.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { REASONIX_CLIENT, resolveReasonixHome } = require('./reasonixPaths');
const {
  readBoundedJson,
  readReasonixTelemetryUsage,
  REASONIX_META_MAX_BYTES,
  REASONIX_TELEMETRY_USAGE_MAX_BYTES
} = require('./reasonixFileIo');
const { canonicalProjectKey, deterministicProjectLabel } = require('./projectKey');
const { normalizeModelNameForClient } = require('./usage');
const {
  readReasonixEventLog,
  countReasonixProviderMessages,
  tokenDataAvailable: reasonixTokenDataAvailable
} = require('./reasonixSessionDetail');

const META_SUFFIX = '.jsonl.meta';
const TELEMETRY_SUFFIX = '.jsonl.telemetry.json';
const EVENTS_SUFFIX = '.events.jsonl';
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

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean).map((value) => String(value)))];
}

function pathOptions(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  return {
    env,
    homeDir,
    platform,
    cwdDir: options.cwdDir || process.cwd(),
    pathModule: options.pathModule || path,
    allTimeSince: options.allTimeSince
  };
}

// The official layout has two generations in the wild:
//   <state>/sessions                 legacy/global sessions
//   <state>/projects/<key>/sessions  routed project sessions
// Watch the legacy sessions directory and the projects directory. The scanner
// only descends into the official one-level project/session layout.
function reasonixNativeSessionWatchRoots(options = {}) {
  const pathApi = options.pathModule || path;
  const stateHome = resolveReasonixHome(pathOptions(options));
  return uniquePaths([
    pathApi.join(stateHome, 'sessions'),
    pathApi.join(stateHome, 'projects')
  ]);
}

function reasonixSessionDirectories(options = {}) {
  const pathApi = options.pathModule || path;
  const roots = reasonixNativeSessionWatchRoots(options);
  const legacyRoot = roots[0];
  const projectsRoot = roots[1];
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
  return uniquePaths(directories);
}

function sessionRootSignature(directories) {
  return uniquePaths(directories).join('\0');
}

function isReasonixNativeSessionSidecar(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return name.endsWith(META_SUFFIX) || name.endsWith(TELEMETRY_SUFFIX) || name.endsWith(EVENTS_SUFFIX);
}

function sessionMetaPathForEvents(filePath, pathApi = path) {
  const name = pathApi.basename(String(filePath || ''));
  if (!name.endsWith(EVENTS_SUFFIX)) return '';
  const stem = name.slice(0, -EVENTS_SUFFIX.length);
  if (!stem) return '';
  return pathApi.join(pathApi.dirname(String(filePath)), `${stem}${META_SUFFIX}`);
}

function isPathInside(filePath, root, pathApi = path) {
  const resolved = pathApi.resolve(String(filePath || ''));
  const resolvedRoot = pathApi.resolve(String(root || ''));
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${pathApi.sep}`);
}

function isReasonixNativeSessionPath(filePath, roots = [], options = {}) {
  if (!filePath) return false;
  const pathApi = options.pathModule || path;
  return (roots || []).some((root) => isPathInside(filePath, root, pathApi));
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

function candidateSignature(candidate) {
  const meta = fileSignature(candidate?.metaPath);
  const telemetry = fileSignature(candidate?.telemetryPath);
  const events = fileSignature(candidate?.eventPath);
  if (!meta || (!telemetry && !events)) return '';
  return `${meta}|${telemetry}|${events}`;
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
      hasTranscript: true,
      tokenDataAvailable: reasonixTokenDataAvailable(events),
      // The current official event schema has no per-turn cost field. A
      // cumulative session cost cannot be split here without inventing a
      // distribution, so the renderer must keep the detail entry closed.
      perTurnCostAvailable: (() => {
        const turns = (events || []).filter((event) => event?.kind === 'turn');
        return turns.length > 0 && turns.every((event) => hasFiniteNumber(event?.cost));
      })(),
      ...(latestMessageMs > 0 ? { lastMessageAt: new Date(latestMessageMs).toISOString() } : {})
    };
  } catch (_) {
    return null;
  }
}

function projectIdentityFor(workspaceRoot, projectIdentity) {
  if (typeof projectIdentity !== 'function') return {};
  try {
    const identity = projectIdentity(workspaceRoot);
    if (!identity || typeof identity !== 'object') return {};
    return {
      projectId: textValue(identity.projectId, 256),
      projectLabel: textValue(identity.projectLabel, 256)
    };
  } catch (_) {
    return {};
  }
}

function validWorkspaceRoot(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//');
}

function readReasonixNativeSession(metaPath, telemetryPath, options = {}) {
  const fsApi = options.fsModule || fs;
  const meta = readBoundedJson(metaPath, REASONIX_META_MAX_BYTES, fsApi);
  if (!meta) return null;
  const branchMeta = objectValue(firstValue(meta, ['BranchMeta', 'branchMeta', 'branch_meta', 'branch']));
  const id = textValue(firstValue(meta, ['id', 'ID']), 256)
    || textValue(firstValue(branchMeta, ['id', 'ID']), 256);
  if (!id) return null;

  // `stats/*.jsonl` is the Tokscale aggregate authority. This native session
  // view reads BranchMeta and official events for identity, preview, timestamps
  // and message counts. `.jsonl.telemetry.json`, when present, is Reasonix
  // Desktop's official trusted cumulative session usage, not authoritative
  // per-turn usage. Without reliable per-turn usage/cost, Session Detail remains
  // closed.
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
  const scope = textValue(firstValue(meta, ['scope'])).toLowerCase() === 'project' ? 'project' : 'global';
  const workspaceRoot = textValue(firstValue(meta, ['workspace_root', 'workspaceRoot']), 4096);
  const project = scope === 'project' && validWorkspaceRoot(workspaceRoot)
    ? projectIdentityFor(workspaceRoot, options.projectIdentity)
    : {};
  const rawModel = textValue(firstValue(meta, ['model']), 256);
  const model = normalizeModelNameForClient(rawModel, REASONIX_CLIENT) || rawModel;
  const totalTokens = usage ? Math.max(0, Math.round(firstNumber(usage, ['totalTokens', 'total_tokens']))) : 0;
  const reportedCost = reportedCostUsd(usage);
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
    title: sessionTitle(meta, { trustedPreview: preview }),
    scope,
    ...(model ? { model, models: usage ? { [model]: totalTokens } : {} } : { models: {} }),
    ...(project.projectId ? { projectId: project.projectId } : {}),
    ...(project.projectLabel ? { projectLabel: project.projectLabel } : {}),
    ...(createdAt ? { createdAt, startedAt: createdAt } : {}),
    ...(updatedAt ? { updatedAt, lastUsedAt: updatedAt } : {}),
    ...(usage ? {
      totalTokens,
      promptTokens: integerValue(firstNumber(usage, ['promptTokens', 'prompt_tokens'])),
      completionTokens: integerValue(firstNumber(usage, ['completionTokens', 'completion_tokens'])),
      reasoningTokens: integerValue(firstNumber(usage, ['reasoningTokens', 'reasoning_tokens'])),
      cacheHitTokens: integerValue(firstNumber(usage, ['cacheHitTokens', 'cache_hit_tokens'])),
      cacheMissTokens: integerValue(firstNumber(usage, ['cacheMissTokens', 'cache_miss_tokens'])),
      cacheWriteTokens: integerValue(firstNumber(usage, ['cacheWriteTokens', 'cache_write_tokens'])),
      requestCount: integerValue(firstNumber(usage, ['requestCount', 'request_count']))
    } : { tokenDataUnavailable: true }),
    ...(reportedCost === undefined ? {} : { reportedCostUsd: reportedCost }),
    // This is a positive allow-list: no native row may open Session Detail
    // unless both per-turn usage and per-turn cost are explicitly available.
    // The current official snapshot events provide neither, while telemetry
    // only provides cumulative session values.
    sessionDetailAvailable: transcript?.tokenDataAvailable === true
      && transcript?.perTurnCostAvailable === true,
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
  const createdDay = localDayKey(createdAt);
  const createdMonth = localMonthKey(createdAt);
  const since = localDateBoundary(allTimeSince);
  const allTime = since !== null && createdAt.getTime() >= since;
  return {
    day: day === localDayKey(now) ? day : '',
    month: month === localMonthKey(now) ? month : '',
    allTime,
    dayTokensReliable: day === localDayKey(now) && createdDay === day,
    monthTokensReliable: month === localMonthKey(now) && createdMonth === month,
    allTimeTokensReliable: allTime
  };
}

function emptyNativeView() {
  return {
    sessions: { today: Object.create(null), month: Object.create(null), allTime: Object.create(null) },
    projects: { today: Object.create(null), month: Object.create(null), allTime: Object.create(null) }
  };
}

function projectEntry(projects, session) {
  if (!session.projectId || !session.projectLabel || session.tokenDataUnavailable === true || session.periodTokenDataUnavailable === true) return;
  const key = canonicalProjectKey(session.projectLabel) || session.projectId;
  if (!key) return;
  if (!projects[key]) {
    projects[key] = {
      projectId: session.projectId,
      label: session.projectLabel,
      tokens: 0,
      costUsd: 0,
      clients: Object.create(null),
      sessionIds: []
    };
  }
  const project = projects[key];
  project.label = deterministicProjectLabel(project.label, session.projectLabel);
  const tokens = Number(session.totalTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  project.tokens += tokens;
  project.clients[REASONIX_CLIENT] = (project.clients[REASONIX_CLIENT] || 0) + tokens;
  if (!project.sessionIds.includes(session.sessionId)) project.sessionIds.push(session.sessionId);
}

function sessionViewForPeriod(session, periodName, periodKeys) {
  const tokensReliable = periodName === 'today'
    ? periodKeys.dayTokensReliable === true
    : periodName === 'month'
      ? periodKeys.monthTokensReliable === true
      : periodKeys.allTimeTokensReliable === true;
  if (tokensReliable) return session;

  // The only available native telemetry is cumulative for the whole Branch.
  // There is no official per-turn usage field that would let us subtract the
  // older portion without guessing. Keep this marker for project rollups so a
  // lifetime total is never counted as today's usage, while the session row
  // may still show the trusted conversation-level total.
  return {
    ...session,
    periodTokenDataUnavailable: true
  };
}

function buildNativeView(entries, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const view = emptyNativeView();
  const day = localDayKey(now);
  const month = localMonthKey(now);
  const allTimeSince = options.allTimeSince;
  const projectsEnabled = options.projectsEnabled !== false;

  const sessionsById = new Map();
  for (const entry of entries || []) {
    if (!entry) continue;
    const previous = sessionsById.get(entry.sessionId);
    if (!previous) {
      sessionsById.set(entry.sessionId, entry);
      continue;
    }
    const previousTime = Date.parse(previous.lastUsedAt || previous.startedAt || '') || 0;
    const nextTime = Date.parse(entry.lastUsedAt || entry.startedAt || '') || 0;
    if (nextTime >= previousTime) sessionsById.set(entry.sessionId, entry);
  }

  for (const entry of sessionsById.values()) {
    const session = projectsEnabled ? entry : { ...entry, projectId: '', projectLabel: '' };
    const periodKeys = sessionPeriodKeys(session, now, allTimeSince);
    if (periodKeys.allTime) view.sessions.allTime[session.sessionId] = sessionViewForPeriod(session, 'allTime', periodKeys);
    if (periodKeys.month === month) view.sessions.month[session.sessionId] = sessionViewForPeriod(session, 'month', periodKeys);
    if (periodKeys.day === day) view.sessions.today[session.sessionId] = sessionViewForPeriod(session, 'today', periodKeys);
  }

  if (projectsEnabled) {
    for (const periodName of ['today', 'month', 'allTime']) {
      for (const session of Object.values(view.sessions[periodName])) projectEntry(view.projects[periodName], session);
    }
  }
  return view;
}

function scanEntries(options = {}, cache = new Map(), directories = null, forcedKeys = new Set()) {
  const sessionDirectories = directories || reasonixSessionDirectories(options);
  const candidates = sidecarCandidates(sessionDirectories, options.pathModule || path);
  const seen = new Set();
  const next = new Map();

  for (const candidate of candidates) {
    if (!candidate.metaPath || (!candidate.telemetryPath && !candidate.eventPath)) continue;
    const key = candidate.metaPath;
    seen.add(key);
    const signature = candidateSignature(candidate);
    if (!signature) continue;
    const previous = cache.get(key);
    if (previous?.signature === signature && !forcedKeys.has(key)) {
      next.set(key, previous);
      continue;
    }
    const session = readReasonixNativeSession(candidate.metaPath, candidate.telemetryPath, { ...options, eventPath: candidate.eventPath });
    next.set(key, { signature, session: session || null });
  }

  let changed = next.size !== cache.size;
  if (!changed) {
    for (const [key, entry] of next) {
      if (cache.get(key) !== entry) {
        changed = true;
        break;
      }
    }
  }
  return { entries: next, seen, changed };
}

function createReasonixNativeSessionCache(options = {}) {
  const resolvedOptions = pathOptions(options);
  const pathApi = resolvedOptions.pathModule || path;
  let entries = new Map();
  let dirty = true;
  let cachedView = null;
  let cachedViewKey = '';
  let invalidatedEventKeys = new Set();
  // A native session root may be created after the initial empty scan. Track the
  // roots that scanEntries actually used so a later refresh can recover without
  // relying on a watcher that was never registered for the missing directory.
  let scannedRootSignature = null;

  function invalidate(filePath) {
    if (!filePath) {
      dirty = true;
      cachedView = null;
      cachedViewKey = '';
      invalidatedEventKeys = new Set();
      return;
    }
    if (!isReasonixNativeSessionSidecar(filePath)) return;
    const eventKey = sessionMetaPathForEvents(filePath, pathApi);
    if (eventKey) {
      // Events are append-only transcript updates. Re-read only the matching
      // candidate on the next view, rather than walking every session again.
      invalidatedEventKeys.add(eventKey);
      cachedView = null;
      cachedViewKey = '';
      return;
    }
    dirty = true;
    cachedView = null;
    cachedViewKey = '';
  }

  function getView(viewOptions = {}) {
    const now = viewOptions.now instanceof Date ? viewOptions.now : new Date(viewOptions.now || Date.now());
    const projectsEnabled = viewOptions.projectsEnabled !== false;
    const allTimeSince = Object.prototype.hasOwnProperty.call(viewOptions, 'allTimeSince')
      ? viewOptions.allTimeSince
      : resolvedOptions.allTimeSince;
    const viewKey = `${localDayKey(now)}|${localMonthKey(now)}|${projectsEnabled ? 'projects' : 'no-projects'}|${String(allTimeSince ?? '')}`;
    const sessionDirectories = reasonixSessionDirectories(resolvedOptions);
    const rootSignature = sessionRootSignature(sessionDirectories);
    if (rootSignature !== scannedRootSignature) {
      dirty = true;
      cachedView = null;
      cachedViewKey = '';
    }
    // Re-enumerate candidates on every reconciliation tick. `scanEntries` keeps
    // unchanged sidecars by signature, so this notices add/delete/rename while
    // preserving the per-entry read/parse cache.
    const scanned = scanEntries(
      { ...resolvedOptions, projectIdentity: options.projectIdentity },
      entries,
      sessionDirectories,
      invalidatedEventKeys
    );
    entries = scanned.entries;
    dirty = false;
    scannedRootSignature = rootSignature;
    invalidatedEventKeys = new Set();
    if (scanned.changed) {
      cachedView = null;
      cachedViewKey = '';
    }
    if (!cachedView || cachedViewKey !== viewKey) {
      cachedView = buildNativeView([...entries.values()].map((entry) => entry.session), { now, projectsEnabled, allTimeSince });
      cachedViewKey = viewKey;
    }
    return cachedView;
  }

  return {
    getView,
    invalidate,
    invalidateAll: () => invalidate(),
    isDirty: () => dirty,
    sessionRoots: () => reasonixNativeSessionWatchRoots(resolvedOptions)
  };
}

function readReasonixNativeSessions(options = {}) {
  const cache = createReasonixNativeSessionCache(options);
  return cache.getView(options);
}

module.exports = {
  META_SUFFIX,
  NATIVE_SESSION_PREFIX,
  REASONIX_META_MAX_BYTES,
  REASONIX_TELEMETRY_USAGE_MAX_BYTES,
  TELEMETRY_SUFFIX,
  EVENTS_SUFFIX,
  buildNativeView,
  createReasonixNativeSessionCache,
  emptyNativeView,
  isReasonixNativeSessionPath,
  isReasonixNativeSessionSidecar,
  readReasonixNativeSession,
  readReasonixNativeSessions,
  reasonixNativeSessionWatchRoots,
  reasonixSessionDirectories
};
