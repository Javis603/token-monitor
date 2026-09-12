'use strict';

const fs = require('node:fs');
const os = require('node:os');
const { hashKey } = require('./hashKey');
const claudeSessionMetadata = require('./providers/claude/sessionMetadata');
const codexSession = require('./providers/codex/sessionMetadata');
const opencodeSession = require('./providers/opencode/session');
const kimiSessionMetadata = require('./providers/kimi/sessionMetadata');
const dshSessionMetadata = require('./providers/dsh/sessionMetadata');

function isoFromDate(value) {
  const date = value instanceof Date ? value : new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function isoFromMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? isoFromDate(new Date(ms)) : '';
}

function timestampFromSessionId(id) {
  const raw = String(id || '');
  const isoMatch = raw.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (isoMatch) return isoFromDate(isoMatch[0]);
  const localMatch = raw.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})[:-](\d{2})(?:[:-](\d{2}))?/);
  if (!localMatch) return '';
  const [, year, month, day, hour, minute, second = '0'] = localMatch;
  return isoFromDate(new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
}

function readFileTail(filePath, bytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const length = Math.min(bytes, stat.size);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function timestampFromJsonLine(line) {
  try {
    const obj = JSON.parse(line);
    return isoFromDate(obj.timestamp || obj.updatedAt || obj.updated_at || obj.createdAt || obj.created_at);
  } catch (_) {
    return '';
  }
}

// Tokscale's session-grouped JSON carries per-session facts beside the rows:
// `sessions` (title and activity bounds per client and session id) and
// `workspaces` (each workspace key's label and the real path it decodes to).
// Folding them onto the rows lets the shared extractor read them through the
// aliases it already understands, so nothing downstream needs to know the scan
// supplied them. A binary that does not emit the arrays leaves every row
// untouched and the file-reading resolvers below still answer.
function applyTokscaleSessionMetadata(json, { resolveProjects = true } = {}) {
  const rows = Array.isArray(json?.entries) ? json.entries : [];
  const result = { sessions: 0, projects: 0 };
  if (rows.length === 0) return result;

  const sessionMeta = new Map();
  for (const entry of Array.isArray(json?.sessions) ? json.sessions : []) {
    const client = String(entry?.client || '').trim();
    const sessionId = String(entry?.sessionId ?? entry?.session_id ?? '').trim();
    if (client && sessionId) sessionMeta.set(`${client}:${sessionId}`, entry);
  }
  // Identity is resolved per workspace, not per row: a scan has far more rows
  // than workspaces, and projectIdentity hashes.
  const identities = new Map();
  for (const entry of Array.isArray(json?.workspaces) ? json.workspaces : []) {
    const key = String(entry?.workspaceKey ?? entry?.workspace_key ?? '').trim();
    if (!key || identities.has(key)) continue;
    // Only a decoded path is an answer. It is what makes Claude Code's
    // dash-mangled slug and Codex's plain path name one project, and tokscale
    // returns none when the key is opaque or its directory is gone — exactly
    // the cases where a transcript still records the real `cwd`, so hashing the
    // raw key here would both lose that answer and mint a second identity for a
    // directory that already has one. Leaving it unattributed hands the session
    // back to the file-reading resolvers.
    const path = String(entry?.path || '').trim();
    const identity = path ? projectIdentity(path) : {};
    identities.set(key, identity.projectId
      ? { projectId: identity.projectId, projectLabel: identity.projectLabel || String(entry?.label || '').trim() }
      : null);
  }
  if (sessionMeta.size === 0 && identities.size === 0) return result;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const client = String(row.client || '').trim();
    const sessionId = String(row.sessionId ?? row.session_id ?? '').trim();
    const meta = client && sessionId ? sessionMeta.get(`${client}:${sessionId}`) : null;
    if (meta) {
      // 0 is tokscale's "no usable timestamp", not the epoch.
      const startedAt = isoFromMs(meta.firstActiveMs ?? meta.first_active_ms);
      const lastUsedAt = isoFromMs(meta.lastActiveMs ?? meta.last_active_ms);
      if (startedAt && !row.startedAt) row.startedAt = startedAt;
      if (lastUsedAt && !row.lastUsedAt) row.lastUsedAt = lastUsedAt;
      const title = String(meta.title || '').trim();
      if (title && !row.sessionTitle) row.sessionTitle = title;
      result.sessions += 1;
    }
    if (!resolveProjects) continue;
    const workspaceKey = String(row.workspaceKey ?? row.workspace_key ?? '').trim();
    if (!workspaceKey || row.projectId) continue;
    const identity = identities.get(workspaceKey);
    if (!identity) continue;
    row.projectId = identity.projectId;
    row.projectLabel = identity.projectLabel;
    result.projects += 1;
  }
  return result;
}

const projectPathCache = new Map();

function projectPathFromJsonl(filePath) {
  let text;
  let cacheKey;
  try {
    const stat = fs.statSync(filePath);
    cacheKey = `${stat.size}:${stat.mtimeMs}`;
    const cached = projectPathCache.get(filePath);
    if (cached?.key === cacheKey) return cached.value;
    const fd = fs.openSync(filePath, 'r');
    try {
      const size = Math.min(256 * 1024, fs.fstatSync(fd).size);
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, 0);
      text = buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) { return ''; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj;
      const value = payload.cwd || payload.project_path || payload.projectPath || payload.workingDirectory || payload.working_directory;
      if (typeof value === 'string' && value.trim()) {
        const result = value.trim();
        projectPathCache.set(filePath, { key: cacheKey, value: result });
        return result;
      }
    } catch (_) { /* skip partial or non-JSON lines */ }
  }
  projectPathCache.set(filePath, { key: cacheKey, value: '' });
  return '';
}

function normalizeProjectPath(value) {
  let normalized = String(value || '').trim().replace(/\\/g, '/');
  if (!normalized) return '';
  const windows = /^[a-z]:\//i.test(normalized) || normalized.startsWith('//');
  const root = normalized === '/' || /^[a-z]:\/$/i.test(normalized);
  if (!root) normalized = normalized.replace(/\/+$/, '');
  return windows ? normalized.toLowerCase() : normalized;
}

function projectIdentity(value) {
  const normalized = normalizeProjectPath(value);
  if (!normalized) return {};
  const root = normalized === '/' || /^[a-z]:\/$/i.test(normalized);
  let displayPath = String(value || '').trim().replace(/\\/g, '/');
  if (!root) displayPath = displayPath.replace(/\/+$/, '');
  const label = root ? (normalized === '/' ? '/' : `${normalized[0].toUpperCase()}:\\`) : displayPath.split('/').pop();
  return { projectId: hashKey('project', normalized), projectLabel: label };
}

// This cache intentionally outlives one collection tick, so idle JSONL
// sessions do not need to be reopened.
const jsonlTimestampCache = new Map();

function lastJsonlTimestamp(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return ''; }
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = jsonlTimestampCache.get(filePath);
  if (cached?.key === cacheKey) return cached.value;
  const tail = readFileTail(filePath);
  const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let value = '';
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const timestamp = timestampFromJsonLine(lines[index]);
    if (timestamp) { value = timestamp; break; }
  }
  if (!value) value = stat.mtime.toISOString();
  jsonlTimestampCache.set(filePath, { key: cacheKey, value });
  return value;
}

function fileSessionMetadata(sessionId, filePath, context, existing = {}) {
  const { resolveProjects } = context;
  const startedAt = timestampFromSessionId(sessionId);
  const lastUsedAt = lastJsonlTimestamp(filePath) || startedAt;
  const identity = resolveProjects ? projectIdentity(projectPathFromJsonl(filePath)) : {};
  return {
    ...existing,
    startedAt,
    lastUsedAt,
    ...identity
  };
}

// Every provider adapter accepts (Set<sessionId>, context) and returns a Map
// keyed by bare session id. Storage-specific cache and refresh policy stays in
// the adapter; the registry only owns selection and the common row contract.
// retryAfterTimestampFallback preserves the providers whose metadata can arrive
// after tokscale first exposes a session id. Kimi and unknown clients retain the
// existing one-shot id-timestamp fallback.
const SESSION_METADATA_RESOLVERS = new Map([
  ['opencode', { resolve: opencodeSession.resolveSessionMetadata, retryAfterTimestampFallback: true }],
  ['claude', { resolve: claudeSessionMetadata.resolveSessionMetadata, retryAfterTimestampFallback: true }],
  ['codex', { resolve: codexSession.resolveSessionMetadata, retryAfterTimestampFallback: true }],
  ['kimi', { resolve: kimiSessionMetadata.resolveSessionMetadata, retryAfterTimestampFallback: false }],
  ['dsh', { resolve: dshSessionMetadata.resolveSessionMetadata, retryAfterTimestampFallback: true }]
]);

function resolverDefinition(entry) {
  return typeof entry === 'function' ? { resolve: entry, retryAfterTimestampFallback: false } : entry;
}

function sessionRefsForPeriods(periods) {
  const refs = new Map();
  for (const period of Object.values(periods || {})) {
    for (const session of Object.values(period?.sessions || {})) {
      if (!session?.client || !session?.sessionId) continue;
      refs.set(`${session.client}:${session.sessionId}`, { client: session.client, sessionId: session.sessionId });
    }
  }
  return refs;
}

// Sessions the scan already attributed to a project, so the file-reading path
// can skip re-deriving one. Kept per session rather than as a single flag for
// the whole collection: a scan covers only the clients whose parser records a
// workspace, and one client answering must not stop another client's resolver
// from answering for itself.
function sessionsWithProject(periods) {
  const attributed = new Set();
  for (const period of Object.values(periods || {})) {
    for (const session of Object.values(period?.sessions || {})) {
      if (session?.client && session?.sessionId && session.projectId) {
        attributed.add(`${session.client}:${session.sessionId}`);
      }
    }
  }
  return attributed;
}

function sessionMetadataMap(periods, home = os.homedir(), deps = {}) {
  const refs = sessionRefsForPeriods(periods);
  const metadata = deps.metadataCache || new Map();
  const resolvedSessionKeys = deps.resolvedSessionKeys || new Set();
  const attemptedSessionKeys = deps.attemptedSessionKeys || new Set();
  const resolveProjects = deps.resolveProjects !== false;
  const byClient = new Map();
  for (const ref of refs.values()) {
    const key = `${ref.client}:${ref.sessionId}`;
    if (resolvedSessionKeys.has(key)) continue;
    if (!deps.retryMisses && attemptedSessionKeys.has(key)) continue;
    if (!byClient.has(ref.client)) byClient.set(ref.client, new Set());
    byClient.get(ref.client).add(ref.sessionId);
  }

  const resolvers = deps.sessionMetadataResolvers || SESSION_METADATA_RESOLVERS;
  const attributed = sessionsWithProject(periods);
  const contextFor = (client) => ({
    deps,
    home,
    metadata,
    resolveProjects,
    projectIdentity,
    isoFromDate,
    // Reading a transcript in full to recover its project path is the expensive
    // half of this pass, so it is skipped for the sessions that already have one.
    // Resolvers that carry their own path (it comes with the record they already
    // read) keep seeing `resolveProjects` itself and stay unconditional.
    fileSessionMetadata: (sessionId, filePath, existing) => fileSessionMetadata(
      sessionId,
      filePath,
      { deps, resolveProjects: resolveProjects && !attributed.has(`${client}:${sessionId}`) },
      existing
    )
  });
  for (const [client, entry] of resolvers) {
    const sessionIds = byClient.get(client);
    if (!sessionIds) continue;
    const definition = resolverDefinition(entry);
    if (typeof definition?.resolve !== 'function') continue;
    const resolved = definition.resolve(sessionIds, contextFor(client));
    for (const [sessionId, meta] of resolved) {
      const key = `${client}:${sessionId}`;
      metadata.set(key, meta);
      if (meta.projectId) resolvedSessionKeys.add(key);
    }
  }

  for (const ref of refs.values()) {
    const key = `${ref.client}:${ref.sessionId}`;
    if (resolvedSessionKeys.has(key) || metadata.has(key)) continue;
    const timestamp = timestampFromSessionId(ref.sessionId);
    if (timestamp) metadata.set(key, { startedAt: timestamp, lastUsedAt: timestamp });
    const definition = resolverDefinition(resolvers.get(ref.client));
    if (!definition?.retryAfterTimestampFallback) resolvedSessionKeys.add(key);
  }
  for (const ref of refs.values()) attemptedSessionKeys.add(`${ref.client}:${ref.sessionId}`);
  return metadata;
}

function applySessionMetadata(periods, home, deps = {}) {
  const metadata = sessionMetadataMap(periods, home, deps);
  for (const period of Object.values(periods || {})) {
    for (const [key, session] of Object.entries(period?.sessions || {})) {
      const meta = metadata.get(key);
      if (!meta) continue;
      if (meta.startedAt && (!session.startedAt || Date.parse(meta.startedAt) < Date.parse(session.startedAt))) session.startedAt = meta.startedAt;
      if (meta.lastUsedAt && (!session.lastUsedAt || Date.parse(meta.lastUsedAt) > Date.parse(session.lastUsedAt))) session.lastUsedAt = meta.lastUsedAt;
      if (meta.projectId) session.projectId = meta.projectId;
      if (meta.projectLabel) session.projectLabel = meta.projectLabel;
      if (meta.title) session.title = meta.title;
      if (meta.sessionKind) session.sessionKind = meta.sessionKind;
    }
  }
}

module.exports = {
  applySessionMetadata,
  applyTokscaleSessionMetadata,
  // Compatibility aliases for existing callers; metadata now includes titles,
  // projects, and session kind in addition to timestamps.
  applySessionTimestamps: applySessionMetadata,
  projectIdentity,
  projectPathFromJsonl,
  sessionMetadataMap,
  sessionTimestampMap: sessionMetadataMap
};
