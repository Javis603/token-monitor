'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chokidar = require('chokidar');
const semver = require('semver');
const { readJson, sharedDataDir } = require('./config');
const { appVersion } = require('./appVersion');
const { normalizeClientsCsv } = require('./clientTracking');
const {
  CLIENT_HEALTH_VERSION,
  MAX_DIAGNOSTICS_PER_CLIENT,
  deriveClientOverall
} = require('./clientHealth');
const { tokscalePackageNameForPlatform, tokscalePlatformKey } = require('./tokscalePlatform');
const { customPricingPath } = require('./tokscaleConfig');
const {
  applyPeriodDelta,
  emptyPeriod,
  extractUsageBundleFromTokscale,
  extractUsageFromTokscale,
  mergePeriods,
  normalizeClientName,
  UNATTRIBUTED_USAGE_CLIENT
} = require('./usage');
const { collectWslUsage: collectWslUsageImpl, emptyWslBundle, probeWslState: probeWslStateImpl } = require('./wslUsage');
const { hermesProfileWatchDirs, resolveHermesHome } = require('./hermesProfiles');
const { mergeHistories, parseGraphResult, normalizeHistory } = require('./history');
const { retainDailyHistory, retainLiveDailyHistory } = require('./dailyHistoryArchive');
const cursorAuth = require('./cursorAuth');
const { findSessionFiles, codexSessionFile } = require('./sessionFiles');
const opencodeSession = require('./opencodeSession');
const { buildPromaHistoryGraph, buildPromaPeriods, collectPromaRows } = require('./promaUsage');
const { hashKey } = require('./hashKey');
const { hostOsInfo, normalizeOsInfo } = require('./osVersion');
const {
  clampTimerDelayMs,
  createSelfSyncThrottle,
  createSourceSyncQueue,
  mergeSelfSyncSelection
} = require('./selfSyncThrottle');
const {
  LIMITS_RESET_BOUNDARY_MAX_TIMER_MS,
  nextLimitsResetBoundary,
  pruneAttemptedResetBoundaries
} = require('./limitResetBoundary');

function toUnpackedPath(p) {
  // electron-builder asarUnpack stores real files at .../app.asar.unpacked/...
  // require.resolve() returns the .../app.asar/... path, which spawn() can't read.
  const asarSeg = `${path.sep}app.asar${path.sep}`;
  return p && p.includes(asarSeg) ? p.replace(asarSeg, `${path.sep}app.asar.unpacked${path.sep}`) : p;
}

const TOKSCALE_BIN_JS = toUnpackedPath(require.resolve('tokscale/bin.js'));

function bundledPackageCandidates() {
  const primary = tokscalePackageNameForPlatform();
  if (primary) return [primary];
  if (process.platform === 'linux') {
    if (process.arch === 'arm64') return ['@tokscale/cli-linux-arm64-gnu', '@tokscale/cli-linux-arm64-musl'];
    if (process.arch === 'x64') return ['@tokscale/cli-linux-x64-gnu', '@tokscale/cli-linux-x64-musl'];
  }
  return [];
}

function locateBundledBinary() {
  const binaryName = process.platform === 'win32' ? 'tokscale.exe' : 'tokscale';
  for (const pkg of bundledPackageCandidates()) {
    try {
      const pkgPath = require.resolve(`${pkg}/package.json`);
      const binPath = toUnpackedPath(path.join(path.dirname(pkgPath), 'bin', binaryName));
      const pkgJson = readJson(pkgPath, {});
      if (fs.existsSync(binPath)) {
        return { source: 'bundled', path: binPath, version: String(pkgJson.version || '0.0.0'), packageName: pkg };
      }
    } catch (_) {}
  }
  return null;
}

function readDownloadedPointer() {
  const currentPath = path.join(sharedDataDir(), 'tokscale', 'current.json');
  const current = readJson(currentPath, null);
  if (!current || typeof current !== 'object') return null;
  if (current.platform && current.platform !== tokscalePlatformKey()) return null;
  if (!semver.valid(current.version)) return null;
  if (typeof current.path !== 'string' || !path.isAbsolute(current.path)) return null;
  try {
    const stat = fs.statSync(current.path);
    if (!stat.isFile()) return null;
    if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) return null;
  } catch (_) {
    return null;
  }
  return {
    source: 'downloaded',
    path: current.path,
    version: current.version,
    installedAt: current.installedAt || '',
    integrity: current.integrity || ''
  };
}

function decideResolver({ downloaded, bundled, shim }) {
  if (downloaded && !bundled) return downloaded;
  if (downloaded && bundled && semver.valid(downloaded.version) && semver.valid(bundled.version) && semver.gt(downloaded.version, bundled.version)) {
    return downloaded;
  }
  return bundled || shim || null;
}

function resolvePlatformBinary() {
  const bundled = locateBundledBinary();
  const downloaded = readDownloadedPointer();
  const shim = { source: 'shim', path: TOKSCALE_BIN_JS, version: null };
  return decideResolver({ downloaded, bundled, shim });
}

function tokscaleCommand() {
  const resolved = resolvePlatformBinary();
  const useDirect = Boolean(resolved && resolved.source !== 'shim');
  if (useDirect) return { bin: resolved.path, prefixArgs: [], env: process.env };
  return { bin: process.execPath, prefixArgs: [TOKSCALE_BIN_JS], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('tokscale produced empty stdout');
  try { return JSON.parse(text); } catch (_) {
    const starts = [text.indexOf('{'), text.indexOf('[')].filter((value) => value >= 0).sort((a, b) => a - b);
    for (const start of starts) {
      try { return JSON.parse(text.slice(start)); } catch (_inner) {}
    }
  }
  throw new Error(`Could not parse tokscale JSON output: ${text.slice(0, 300)}`);
}

function spawnTokscaleJson(userArgs, commandTimeoutMs) {
  const { bin, prefixArgs, env } = tokscaleCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...prefixArgs, ...userArgs], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`tokscale timed out after ${commandTimeoutMs}ms`)); }, commandTimeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`tokscale exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
      try { resolve(parseJsonOutput(stdout)); } catch (error) { reject(error); }
    });
  });
}

// A few tools surface as one umbrella client in our tracked-client list but as
// several client ids inside tokscale. Antigravity is the case today: tokscale 4.x
// reads the CLI (`agy`) from its own parse-local id `antigravity-cli` (no
// `antigravity sync`), separate from the IDE-backed `antigravity`. Widen the
// tokscale --client filter so those sub-source rows aren't filtered out;
// extractUsageFromTokscale's normalizeClientName folds them back into the umbrella
// id. Every alias must be a real tokscale client id: an unknown --client value is
// rejected with exit 2 and takes the whole scan down with it (verified on 4.7.0
// and 4.8.0), so this list is not a free-form place to invent sub-source names.
// Clients tokscale doesn't know at all — `proma`, which we parse ourselves — are
// stripped in collectUsageOnce before the filter is built, not dropped here.
const TOKSCALE_CLIENT_ALIASES = { antigravity: ['antigravity-cli'] };

function tokscaleClientFilter(clients) {
  const ordered = [];
  const seen = new Set();
  for (const id of String(clients ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
    if (!seen.has(id)) { seen.add(id); ordered.push(id); }
    for (const alias of TOKSCALE_CLIENT_ALIASES[id] || []) {
      if (!seen.has(alias)) { seen.add(alias); ordered.push(alias); }
    }
  }
  return ordered.join(',');
}

function runTokscale({ clients, flags, commandTimeoutMs }) {
  return spawnTokscaleJson(['--json', '--client', tokscaleClientFilter(clients), '--group-by', 'client,session,model', ...flags], commandTimeoutMs);
}

function runTokscaleGraph({ clients, commandTimeoutMs }) {
  return spawnTokscaleJson(['graph', '--client', tokscaleClientFilter(clients), '--no-spinner'], commandTimeoutMs);
}

function lookupModelPricing(modelId, commandTimeoutMs = 15000) {
  const id = String(modelId || '').trim();
  if (!id) return Promise.reject(new Error('lookupModelPricing: modelId is required'));
  return spawnTokscaleJson(['pricing', id, '--json', '--no-spinner'], commandTimeoutMs);
}

const PROMA_PRICING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PROMA_PRICING_LOOKUP_TIMEOUT_MS = 3000;
const promaPricingCache = new Map();

function promaPricingRevision() {
  try { return fs.statSync(customPricingPath()).mtimeMs; } catch (_) { return 0; }
}

function normalizePromaPricing(result) {
  const source = result?.pricing;
  if (!source || typeof source !== 'object') return null;
  const pick = (key) => {
    const value = Number(source[key]);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const pricing = {
    inputCostPerToken: pick('inputCostPerToken'),
    outputCostPerToken: pick('outputCostPerToken'),
    cacheReadInputTokenCost: pick('cacheReadInputTokenCost'),
    cacheCreationInputTokenCost: pick('cacheCreationInputTokenCost')
  };
  return pricing.inputCostPerToken !== undefined || pricing.outputCostPerToken !== undefined ? pricing : null;
}

async function resolvePromaPricing(rows, options = {}) {
  const lookup = options.lookupModelPricing || lookupModelPricing;
  const revision = options.pricingRevision ?? promaPricingRevision();
  const nowMs = options.nowMs ?? Date.now();
  // Pricing is supplementary: never let a missing catalog entry hold up the
  // live usage refresh for the normal tokscale command timeout.
  const commandTimeoutMs = options.commandTimeoutMs || PROMA_PRICING_LOOKUP_TIMEOUT_MS;
  const pricingByModel = {};
  const modelIds = [...new Set((Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.model || '').trim().toLowerCase()).filter(Boolean))];
  for (const modelId of modelIds) {
    const cached = promaPricingCache.get(modelId);
    if (cached && cached.revision === revision && nowMs - cached.at < PROMA_PRICING_CACHE_TTL_MS) {
      if (cached.pricing) pricingByModel[modelId] = cached.pricing;
      continue;
    }
    let pricing = null;
    try {
      pricing = normalizePromaPricing(await lookup(modelId, commandTimeoutMs));
    } catch (_) {
      // An unknown model, offline lookup, or custom channel must remain
      // cost-unavailable instead of inheriting an unrelated catalog price.
    }
    promaPricingCache.set(modelId, { at: nowMs, revision, pricing });
    if (pricing) pricingByModel[modelId] = pricing;
  }
  return pricingByModel;
}

function resetPromaPricingCache() {
  promaPricingCache.clear();
}

function localTodayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Stamp each posted snapshot with the UTC instant its today/month windows end
// (next local midnight / next month start, in this device's timezone). The hub
// uses these to expire a frozen snapshot once it goes offline past a day/month
// boundary, instead of counting stale "today" data forever (issue #37).
function computePeriodWindows(now = new Date()) {
  const startOfNextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return {
    today: { key: localTodayKey(now), endsAt: startOfNextDay.toISOString() },
    month: { key: monthKey, endsAt: startOfNextMonth.toISOString() }
  };
}

function isoFromDate(value) {
  const date = value instanceof Date ? value : new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
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

// Keyed by path -> { key: `size:mtimeMs`, value }, mirroring projectPathCache.
// The tail timestamp only moves when the transcript grows, so a mtime match lets
// a full-tick decoration skip re-reading every idle session (issue: periodic UI
// stutter once project tracking made this run on every session each tick).
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

function sessionTimestampMap(periods, home = os.homedir(), deps = {}) {
  const refs = sessionRefsForPeriods(periods);
  const metadata = deps.metadataCache || new Map();
  const resolvedSessionKeys = deps.resolvedSessionKeys || new Set();
  const attemptedSessionKeys = deps.attemptedSessionKeys || new Set();
  // Timestamps are always backfilled (the session view sorts by recency); project
  // identity is the part gated by the Projects opt-out (issue #182).
  const resolveProjects = deps.resolveProjects !== false;
  const byClient = new Map();
  for (const ref of refs.values()) {
    const key = `${ref.client}:${ref.sessionId}`;
    if (resolvedSessionKeys.has(key)) continue;
    if (!deps.retryMisses && attemptedSessionKeys.has(key)) continue;
    if (!byClient.has(ref.client)) byClient.set(ref.client, new Set());
    byClient.get(ref.client).add(ref.sessionId);
  }

  const applyFile = (client, sessionId, filePath) => {
    const startedAt = timestampFromSessionId(sessionId);
    const lastUsedAt = lastJsonlTimestamp(filePath) || startedAt;
    const identity = resolveProjects ? projectIdentity(projectPathFromJsonl(filePath)) : {};
    const key = `${client}:${sessionId}`;
    metadata.set(key, { startedAt, lastUsedAt, ...identity });
    if (identity.projectId) resolvedSessionKeys.add(key);
  };

  // OpenCode has no transcript file — its timestamps come from the opencode.db `session` table.
  const opencodeIds = byClient.get('opencode') || new Set();
  if (opencodeIds.size > 0) {
    const readOpencodeMeta = deps.readOpencodeMeta || (deps.scopedHome
      ? (ids) => opencodeSession.readSessionMetaForHome(ids, home, deps.opencodeDeps)
      : (ids) => opencodeSession.readSessionMeta(ids, deps.opencodeDeps));
    for (const [sessionId, meta] of readOpencodeMeta(opencodeIds)) {
      const startedAt = meta.startedAt || '';
      const lastUsedAt = meta.lastUsedAt || startedAt;
      const identity = resolveProjects ? projectIdentity(meta.projectPath) : {};
      const key = `opencode:${sessionId}`;
      if (startedAt || lastUsedAt || identity.projectId) metadata.set(key, { startedAt, lastUsedAt, ...identity });
      if (identity.projectId) resolvedSessionKeys.add(key);
    }
  }

  const claudeFiles = findSessionFiles(path.join(home, '.claude', 'projects'), byClient.get('claude') || []);
  for (const [sessionId, filePath] of claudeFiles) applyFile('claude', sessionId, filePath);

  const codexIds = byClient.get('codex') || new Set();
  const missingCodexIds = new Set();
  for (const sessionId of codexIds) {
    const filePath = codexSessionFile(home, sessionId);
    if (filePath) applyFile('codex', sessionId, filePath);
    else missingCodexIds.add(sessionId);
  }
  const codexFiles = findSessionFiles(path.join(home, '.codex', 'sessions'), missingCodexIds);
  for (const [sessionId, filePath] of codexFiles) applyFile('codex', sessionId, filePath);

  for (const ref of refs.values()) {
    const key = `${ref.client}:${ref.sessionId}`;
    if (resolvedSessionKeys.has(key)) continue;
    if (metadata.has(key)) continue;
    const timestamp = timestampFromSessionId(ref.sessionId);
    if (timestamp) metadata.set(key, { startedAt: timestamp, lastUsedAt: timestamp });
    if (!['claude', 'codex', 'opencode'].includes(ref.client)) resolvedSessionKeys.add(key);
  }
  for (const ref of refs.values()) attemptedSessionKeys.add(`${ref.client}:${ref.sessionId}`);

  return metadata;
}

// Copy freshly decorated identities/timestamps from `today` onto the same session
// in the delta-derived periods. Used on watch ticks, where month/allTime are not
// re-decorated: a session that started today is absent from the anchor, so its
// project label would otherwise be missing from the broader-period breakdown.
function propagateTodayProjects(today, periods) {
  for (const [key, session] of Object.entries(today?.sessions || {})) {
    if (!session) continue;
    for (const period of periods) {
      const target = period?.sessions?.[key];
      if (!target) continue;
      if (session.projectId && !target.projectId) {
        target.projectId = session.projectId;
        target.projectLabel = session.projectLabel;
      }
      if (session.startedAt && (!target.startedAt || Date.parse(session.startedAt) < Date.parse(target.startedAt))) {
        target.startedAt = session.startedAt;
      }
      if (session.lastUsedAt && (!target.lastUsedAt || Date.parse(session.lastUsedAt) > Date.parse(target.lastUsedAt))) {
        target.lastUsedAt = session.lastUsedAt;
      }
    }
  }
}

function applySessionTimestamps(periods, home, deps = {}) {
  const metadata = sessionTimestampMap(periods, home, deps);
  for (const period of Object.values(periods || {})) {
    for (const [key, session] of Object.entries(period?.sessions || {})) {
      const meta = metadata.get(key);
      if (!meta) continue;
      if (meta.startedAt && (!session.startedAt || Date.parse(meta.startedAt) < Date.parse(session.startedAt))) session.startedAt = meta.startedAt;
      if (meta.lastUsedAt && (!session.lastUsedAt || Date.parse(meta.lastUsedAt) > Date.parse(session.lastUsedAt))) session.lastUsedAt = meta.lastUsedAt;
      if (meta.projectId) session.projectId = meta.projectId;
      if (meta.projectLabel) session.projectLabel = meta.projectLabel;
    }
  }
}

// The process-wide rationing for cursor/antigravity syncs. Deliberately a single
// module-scoped instance with no per-call override: the tokscale cache it guards
// is one directory on disk, so a collector rebuilt by a settings change must not
// hand itself a fresh allowance — and a second instance would split the state
// that decides a sync from the state that schedules the catch-up waiting on it,
// which is the divergence this whole path keeps being bitten by. Tests read it
// through the export to pin a floor without driving a whole tick; a test wanting
// isolation builds its own with createSelfSyncThrottle() and drives that
// directly, rather than threading one back in here.
const selfSyncThrottle = createSelfSyncThrottle();

async function maybeSyncCursor(clientsCsv, logger, options = {}) {
  const enabled = new Set(normalizeClientsCsv(clientsCsv).split(',').filter(Boolean));
  if (!enabled.has('cursor')) return;
  if (!cursorAuth.readActiveAccount()) return;
  if (!selfSyncThrottle.claim('cursor', options.minIntervalMs)) return;
  const attempt = selfSyncThrottle.beginAttempt('cursor');
  try {
    await cursorAuth.runCursorSync();
    selfSyncThrottle.completeAttempt('cursor', attempt, false);
  } catch (err) {
    if (typeof logger === 'function') logger(`cursor sync failed: ${err.message}`);
    selfSyncThrottle.completeAttempt('cursor', attempt, true);
    options.onFailure?.('cursor');
  }
}

// tokscale's antigravity sync reads the IDE's native session roots under
// ~/.gemini/; when none exist there is nothing to sync, so don't spawn at all.
const ANTIGRAVITY_DATA_ROOTS = ['antigravity', 'antigravity-ide', 'antigravity-backup'];

function antigravityDataRoots(home = os.homedir()) {
  return ANTIGRAVITY_DATA_ROOTS.map((name) => path.join(home, '.gemini', name));
}

function antigravityDataPresent(home) {
  return antigravityDataRoots(home).some(dirExists);
}

async function maybeSyncAntigravity(clientsCsv, logger, home = os.homedir(), options = {}) {
  const enabled = new Set(normalizeClientsCsv(clientsCsv).split(',').filter(Boolean));
  if (!enabled.has('antigravity')) return;
  if (!antigravityDataPresent(home)) return;
  if (!selfSyncThrottle.claim('antigravity', options.minIntervalMs)) return;
  const attempt = selfSyncThrottle.beginAttempt('antigravity');
  if (typeof options.run === 'function') {
    try {
      await options.run();
      selfSyncThrottle.completeAttempt('antigravity', attempt, false);
    } catch (err) {
      if (typeof logger === 'function') logger(`antigravity sync failed: ${err.message}`);
      selfSyncThrottle.completeAttempt('antigravity', attempt, true);
      options.onFailure?.('antigravity');
    }
    return;
  }
  const { bin, prefixArgs, env } = tokscaleCommand();
  // Every outcome resolves — a stuck sync must not hold the tick open — so a
  // failure is only visible through onFailure. The caller needs it: the tick has
  // already consumed the source event that asked for this sync, and silently
  // scanning the unchanged cache would put the refresh back on the fallback
  // interval, which is the latency this whole path exists to remove.
  await new Promise((resolve) => {
    const child = spawn(bin, [...prefixArgs, 'antigravity', 'sync'], { env, windowsHide: true });
    let stderr = '';
    // One outcome per spawn. A child reports more than once — a SIGTERM'd
    // timeout still emits close afterwards, and error is usually followed by
    // close — which was harmless while every path only resolved a promise, but
    // onFailure has a side effect: re-arming the catch-up. A late duplicate could
    // land after a subsequent catch-up already succeeded and put the same source
    // event back into a set that no longer has anything to collect.
    let settled = false;
    let timer = null;
    // The failure code reaches the health record; stderr only ever reaches the
    // local log, since it is neither translatable nor reliably free of the
    // user's paths.
    const settle = (failed, code = '') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      selfSyncThrottle.completeAttempt('antigravity', attempt, failed, code);
      if (failed) options.onFailure?.('antigravity');
      resolve();
    };
    timer = setTimeout(() => { child.kill('SIGTERM'); settle(true, 'sync-timeout'); }, 30000);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', () => settle(true, 'sync-spawn-failed'));
    child.on('close', (code) => {
      if (code !== 0 && !settled && typeof logger === 'function') {
        logger(`antigravity sync exited ${code}: ${stderr.trim().slice(0, 200)}`);
      }
      settle(code !== 0, 'sync-exit-error');
    });
    child.stdin?.end();
  });
}

const HISTORY_CAP_DAYS = 370;
const HISTORY_TIMEOUT_MS = 60000;
const DEFAULT_HISTORY_INTERVAL_MS = 15 * 60 * 1000;
const HISTORY_INTERVAL_VALUES = new Set([5, 10, 15, 30, 60].map((minutes) => minutes * 60 * 1000));

function normalizeHistoryIntervalMs(value) {
  const parsed = Number(value);
  return HISTORY_INTERVAL_VALUES.has(parsed) ? parsed : DEFAULT_HISTORY_INTERVAL_MS;
}

async function collectHistoryOnce(options) {
  const startedAt = Date.now();
  const attemptedAt = new Date(startedAt).toISOString();
  let failureCode = null;
  const reportStatus = (success) => {
    try {
      options.onHistoryStatus?.({
        attemptedAt,
        successAt: success ? new Date().toISOString() : null,
        failureCode,
        durationMs: Math.max(0, Date.now() - startedAt)
      });
    } catch (_) {
      // Diagnostic observers must never affect history collection.
    }
  };
  const clients = normalizeClientsCsv(options.clients);
  if (options.historyEnabled === false) return null;
  const histories = [];
  const rawGraphs = [];
  const runGraph = options.runGraph || runTokscaleGraph;
  const capDays = Number.isFinite(options.capDays) ? options.capDays : HISTORY_CAP_DAYS;
  const todayKey = options.todayKey || localTodayKey();
  if (clients) {
    try {
      const graphJson = await runGraph({ clients, commandTimeoutMs: options.commandTimeoutMs || HISTORY_TIMEOUT_MS });
      rawGraphs.push(graphJson);
      histories.push(normalizeHistory(parseGraphResult(graphJson), { capDays, todayKey }));
    } catch (error) {
      failureCode = 'history-graph-failed';
      if (typeof options.logger === 'function') options.logger(`tokscale graph failed: ${error.message}`);
    }
  }
  if (options.promaGraph) {
    rawGraphs.push(options.promaGraph);
    histories.push(normalizeHistory(parseGraphResult(options.promaGraph), { capDays, todayKey }));
  }
  if (options.dailyHistoryArchiveEnabled) {
    try {
      const retainedGraph = retainDailyHistory(rawGraphs, {
        ...(options.dailyHistoryArchiveOptions || {}),
        liveDays: options.dailyHistoryLiveDays,
        todayKey,
        capDays,
        writeEnabled: options.dailyHistoryArchiveWriteEnabled
      });
      const retained = normalizeHistory(parseGraphResult(retainedGraph), { capDays, todayKey });
      const result = retained.daily.length || retained.monthly.length ? retained : null;
      reportStatus(failureCode === null);
      return result;
    } catch (error) {
      failureCode = failureCode || 'daily-history-archive-failed';
      if (typeof options.logger === 'function') options.logger(`daily history archive failed: ${error.message}`);
    }
  }
  if (histories.length === 0) {
    reportStatus(false);
    return null;
  }
  const history = histories.length === 1 ? histories[0] : mergeHistories(histories, { todayKey });
  const result = history.daily.length || history.monthly.length ? history : null;
  reportStatus(failureCode === null);
  return result;
}

function shouldIncludeHistory(nowMs, lastHistoryAtMs, historyIntervalMs, force, enabled = true) {
  if (enabled === false) return false;
  if (force) return true;
  return nowMs - (lastHistoryAtMs || 0) >= historyIntervalMs;
}
async function collectUsageOnce(options) {
  const { clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion = appVersion(), agentRuntime = '' } = options;
  // One snapshot, one instant: capture the clock before any tokscale scan and
  // reuse it for the today-window key and updatedAt, so a collection that
  // straddles local midnight cannot pair a day-N today scan with a day-N+1
  // window (issue #37 follow-up). Injectable for tests.
  const collectedAt = options.now != null ? new Date(options.now) : new Date();
  const runTokscaleFn = options.runTokscale || runTokscale;
  const collectWsl = options.collectWslUsage || collectWslUsageImpl;
  const probeWslStateFn = options.probeWslState || probeWslStateImpl;
  // Injectable only for the WSL-status gate, so tests can exercise the win32
  // build path on a non-Windows CI box (the real process.platform stays for
  // tokscale binary resolution, which is genuinely platform-bound).
  const platformValue = options.platform || process.platform;
  const osInfo = options.osInfo === undefined
    ? hostOsInfo()
    : normalizeOsInfo(options.osInfo);
  const normalizedClients = normalizeClientsCsv(clients);
  const projectsEnabled = options.projectsEnabled !== false;
  const localSessionMetadataDeps = {
    ...(options.sessionMetadataDeps || {}),
    metadataCache: new Map(),
    resolvedSessionKeys: new Set(),
    attemptedSessionKeys: new Set()
  };
  const decorateLocalPeriods = (periods, { retryMisses = false } = {}) => applySessionTimestamps(
    periods,
    options.homeDir || os.homedir(),
    { ...localSessionMetadataDeps, retryMisses, resolveProjects: projectsEnabled }
  );
  // tokscale doesn't know about Proma yet — filter it out of the subprocess
  // calls so --client doesn't reject an unknown value. Proma is parsed
  // separately below and merged back in.
  const tokscaleClients = normalizedClients ? normalizedClients.split(',').filter((c) => c !== 'proma').join(',') : normalizedClients;
  const includesProma = normalizedClients.split(',').includes('proma');
  const trackedClientSet = new Set(normalizedClients.split(',').filter(Boolean));
  const targetClients = [...new Set(normalizeClientsCsv(options.targetClients).split(',').filter((client) => trackedClientSet.has(client)))];
  const targetRequested = targetClients.length > 0;
  const targetTokscaleClients = targetClients.filter((client) => client !== 'proma').join(',');
  let today = emptyPeriod();
  let month = emptyPeriod();
  let allTime = emptyPeriod();
  let dailyHistoryLiveDays = options.dailyHistoryLiveDays;
  let todayPartitions = null;
  const anchor = options.todayOnlyAnchor;
  const anchorUsed = Boolean(
    anchor
    && anchor.dateKey === localTodayKey(collectedAt)
    && canTargetTodayPartitions(anchor, targetClients)
  );
  let promaPeriods = null;
  let promaRows = null;
  let promaPricing = null;
  if (normalizedClients) {
    const syncClients = targetRequested ? targetTokscaleClients : tokscaleClients;
    await maybeSyncCursor(syncClients, options.logger, {
      minIntervalMs: selfSyncThrottle.minIntervalForTick(options, 'cursor'),
      onFailure: options.onSelfSyncFailed
    });
    await maybeSyncAntigravity(syncClients, options.logger, options.homeDir || os.homedir(), {
      minIntervalMs: selfSyncThrottle.minIntervalForTick(options, 'antigravity'),
      run: options.runAntigravitySync,
      onFailure: options.onSelfSyncFailed
    });
    if (includesProma && (!targetRequested || targetClients.includes('proma'))) {
      try {
        promaRows = collectPromaRows();
        promaPricing = await resolvePromaPricing(promaRows, {
          lookupModelPricing: options.lookupModelPricing,
          commandTimeoutMs: options.pricingTimeoutMs ?? Math.min(commandTimeoutMs || PROMA_PRICING_LOOKUP_TIMEOUT_MS, PROMA_PRICING_LOOKUP_TIMEOUT_MS),
          pricingRevision: options.pricingRevision
        });
        const promaJson = buildPromaPeriods({ now: collectedAt, allTimeSince, rows: promaRows, pricingByModel: promaPricing });
        promaPeriods = {
          today: extractUsageFromTokscale(promaJson.today),
          month: extractUsageFromTokscale(promaJson.month),
          allTime: extractUsageFromTokscale(promaJson.allTime)
        };
      } catch (err) {
        if (typeof options.logger === 'function') options.logger(`proma parse failed: ${err.message}`);
      }
    }
    if (anchorUsed) {
      // Anchored tick (watch-triggered): every tokscale period scan costs the
      // same full load + filter, so scan only --today and update the broader
      // windows exactly via applyPeriodDelta — one spawn instead of three.
      const scanClients = targetRequested ? targetTokscaleClients : tokscaleClients;
      let freshPartitions = Object.create(null);
      let useTargetedPartitions = targetRequested;
      if (scanClients) {
        const todayJson = await runTokscaleFn({ clients: scanClients, flags: ['--today'], commandTimeoutMs });
        const bundle = extractUsageBundleFromTokscale(todayJson);
        freshPartitions = bundle.byClient;
        const unattributed = freshPartitions[UNATTRIBUTED_USAGE_CLIENT];
        if (targetRequested && periodHasUsage(unattributed)) {
          // A row without a client cannot be replaced safely inside one client
          // partition. Fall back to one all-client today scan for correctness.
          const fullTodayJson = await runTokscaleFn({ clients: tokscaleClients, flags: ['--today'], commandTimeoutMs });
          freshPartitions = extractUsageBundleFromTokscale(fullTodayJson).byClient;
          useTargetedPartitions = false;
        } else if (targetRequested) {
          // Empty tokscale output uses the unattributed fallback shape. Keep the
          // anchor's real unattributed partition while clearing the target.
          delete freshPartitions[UNATTRIBUTED_USAGE_CLIENT];
        }
      }
      if (promaPeriods) freshPartitions.proma = promaPeriods.today;
      todayPartitions = useTargetedPartitions
        ? replaceTodayPartitions(anchor.todayPartitions, freshPartitions, targetClients)
        : completeTodayPartitions(freshPartitions, normalizedClients);
      today = mergeTodayPartitions(todayPartitions);
      month = applyPeriodDelta(anchor.month, today, anchor.today);
      allTime = applyPeriodDelta(anchor.allTime, today, anchor.today);
    } else if (tokscaleClients) {
      // Serial on purpose: concurrent scans triple the peak CPU/IO load, which
      // is what let the issue #15 self-trigger loop spike tokscale past 500% CPU.
      const todayJson = await runTokscaleFn({ clients: tokscaleClients, flags: ['--today'], commandTimeoutMs });
      const todayBundle = extractUsageBundleFromTokscale(todayJson);
      today = todayBundle.period;
      todayPartitions = todayBundle.byClient;
      if (typeof options.onProgress === 'function') decorateLocalPeriods({ today });
      try { if (typeof options.onProgress === 'function') options.onProgress({ today, updatedAt: new Date().toISOString() }); } catch (_) {}
      const monthJson = await runTokscaleFn({ clients: tokscaleClients, flags: ['--month'], commandTimeoutMs });
      month = extractUsageFromTokscale(monthJson);
      if (typeof options.onProgress === 'function') decorateLocalPeriods({ today, month });
      try { if (typeof options.onProgress === 'function') options.onProgress({ today, month, updatedAt: new Date().toISOString() }); } catch (_) {}
      const allTimeJson = await runTokscaleFn({ clients: tokscaleClients, flags: ['--since', allTimeSince], commandTimeoutMs });
      allTime = extractUsageFromTokscale(allTimeJson);
    }
    // Always decorate: session timestamps drive the recency sort regardless of the
    // Projects opt-out (issue #182). decorateLocalPeriods gates only project identity
    // on projectsEnabled, so opting out still costs the timestamp backfill and nothing
    // more.
    if (anchorUsed) {
      // Watch tick: `today` is a fresh scan and must be decorated, but month/
      // allTime are derived from the last full-scan anchor and already carry each
      // session's project label + timestamps through applyPeriodDelta. Decorating
      // them again would re-stat every historical session file every few seconds
      // (the perceived UI stutter). Decorate only today, then propagate its freshly
      // resolved identities onto sessions that started today (absent from the anchor).
      decorateLocalPeriods({ today }, { retryMisses: true });
      propagateTodayProjects(today, [month, allTime]);
    } else {
      decorateLocalPeriods({ today, month, allTime }, { retryMisses: true });
    }
    if (promaPeriods && !anchorUsed) {
      today = mergePeriods(today, promaPeriods.today);
      month = mergePeriods(month, promaPeriods.month);
      allTime = mergePeriods(allTime, promaPeriods.allTime);
      todayPartitions = { ...(todayPartitions || {}), proma: promaPeriods.today };
    }
    todayPartitions = completeTodayPartitions(todayPartitions, normalizedClients);
    // Partition metadata is internal but must remain as complete as the public
    // period: a later targeted tick re-merges these sessions into `today`.
    propagateTodayProjects(today, Object.values(todayPartitions));
  }

  // WSL contribution (Windows only; no-op elsewhere). Full tick scans running WSL
  // homes; watch tick reuses the frozen snapshot so the Windows-only delta anchor
  // above stays exact (issue #15). Merged before deriveClientStatus so a client
  // that only exists inside WSL still reports as active.
  //
  // Three WSL refresh modes:
  // 1. refreshWsl (interval anchored tick): scan WSL fresh — the 5-minute interval
  //    is too long to let WSL go stale, but re-scanning tokscale is avoided.
  // 2. wslAnchor (watch anchored tick): reuse the frozen snapshot — WSL is heavy
  //    and watch ticks fire every few seconds.
  // 3. !anchorUsed (full scan): scan WSL as part of the complete rescan.
  const windowsPeriods = { today, month, allTime };
  let wslBundle = emptyWslBundle();
  let wslDetected = [];
  if (normalizedClients && options.wslScanEnabled !== false) {
    if (options.refreshWsl) {
      const wslResult = await collectWsl({
        clients: tokscaleClients,
        trackedClients: normalizedClients,
        allTimeSince,
        now: collectedAt,
        commandTimeoutMs,
        runTokscale: runTokscaleFn,
        resolvePromaPricing: (rows) => resolvePromaPricing(rows, {
          lookupModelPricing: options.lookupModelPricing,
          commandTimeoutMs: options.pricingTimeoutMs ?? Math.min(commandTimeoutMs || PROMA_PRICING_LOOKUP_TIMEOUT_MS, PROMA_PRICING_LOOKUP_TIMEOUT_MS),
          pricingRevision: options.pricingRevision
        }),
        logger: options.logger,
        decoratePeriods: (periods, home) => applySessionTimestamps(periods, home, { scopedHome: true, resolveProjects: projectsEnabled })
      });
      wslBundle = wslResult.bundle;
      wslDetected = wslResult.detected;
    } else if (options.wslAnchor) {
      wslBundle = options.wslAnchor;
    } else if (!anchorUsed) {
      const wslResult = await collectWsl({
        clients: tokscaleClients,
        trackedClients: normalizedClients,
        allTimeSince,
        now: collectedAt,
        commandTimeoutMs,
        runTokscale: runTokscaleFn,
        resolvePromaPricing: (rows) => resolvePromaPricing(rows, {
          lookupModelPricing: options.lookupModelPricing,
          commandTimeoutMs: options.pricingTimeoutMs ?? Math.min(commandTimeoutMs || PROMA_PRICING_LOOKUP_TIMEOUT_MS, PROMA_PRICING_LOOKUP_TIMEOUT_MS),
          pricingRevision: options.pricingRevision
        }),
        logger: options.logger,
        decoratePeriods: (periods, home) => applySessionTimestamps(periods, home, { scopedHome: true, resolveProjects: projectsEnabled })
      });
      wslBundle = wslResult.bundle;
      wslDetected = wslResult.detected;
    }
  }
  today = mergePeriods(windowsPeriods.today, wslBundle.today);
  month = mergePeriods(windowsPeriods.month, wslBundle.month);
  allTime = mergePeriods(windowsPeriods.allTime, wslBundle.allTime);

  // The renderer intentionally uses the live today period while a day is in
  // progress. Callers that do not defer capture persist the largest complete
  // live snapshot here; startCollector defers it until after transformUsage so
  // the saved value matches the period delivered to the renderer.
  if (
    options.historyEnabled !== false
    && options.dailyHistoryArchiveEnabled
    && options.deferLiveHistoryCapture !== true
  ) {
    try {
      const retainedLive = retainLiveDailyHistory(today, {
        ...(options.dailyHistoryArchiveOptions || {}),
        liveDays: dailyHistoryLiveDays,
        todayKey: localTodayKey(collectedAt),
        writeEnabled: options.dailyHistoryArchiveWriteEnabled
      });
      dailyHistoryLiveDays = retainedLive.liveDays || {};
    } catch (error) {
      if (typeof options.logger === 'function') options.logger(`daily live history archive failed: ${error.message}`);
    }
  }

  // WSL attribution (Windows only; null elsewhere). detected = markers found,
  // withData = clients whose WSL scan or local parser returned tokens. The gap
  // is the diagnostic (e.g. Hermes detected but unreadable over 9P).
  //
  // Like wslBundle, this is FROZEN between full scans: anchored watch ticks
  // (which skip the WSL scan) reuse the snapshot via options.wslStatus instead
  // of re-probing — otherwise every few-second watch tick would spawn wsl.exe
  // and stall the fast refresh path (issue #15's load concern).
  let wslStatus = null;
  if (platformValue === 'win32' && normalizedClients) {
    const reuseFrozen = !options.refreshWsl && options.wslAnchor && options.wslStatus;
    if (options.wslScanEnabled === false) {
      wslStatus = { state: 'disabled', detected: [], withData: [] };
    } else if (reuseFrozen) {
      wslStatus = options.wslStatus;
    } else {
      const probe = probeWslStateFn({});
      if (probe !== 'ok') {
        wslStatus = { state: probe, detected: [], withData: [] };
      } else {
        const withData = Object.keys(wslBundle.allTime.clients || {});
        const state = withData.length > 0 ? 'active' : 'no-data';
        wslStatus = { state, detected: wslDetected, withData };
      }
    }
  }

  if (typeof options.onAnchorComputed === 'function') {
    options.onAnchorComputed({ windowsPeriods, todayPartitions, wslBundle, wslStatus });
  }

  // One filesystem probe per tick, shared by the legacy status and the health
  // record below. Probing twice cost a second pass over every client's roots —
  // including the per-workspace walk Copilot needs — and let one snapshot report
  // a directory as both present and absent when it appeared between the two.
  const sourceChecks = clientSourceChecks(normalizedClients, { wslDetected: wslStatus?.detected });

  const summary = {
    deviceId,
    hostname: os.hostname(),
    platform: `${process.platform}-${process.arch}`,
    ...(osInfo.name ? { osName: osInfo.name } : {}),
    ...(osInfo.version ? { osVersion: osInfo.version } : {}),
    updatedAt: collectedAt.toISOString(),
    agentVersion,
    ...(agentRuntime ? { agentRuntime } : {}),
    projectsEnabled,
    trackedClients: normalizedClients ? normalizedClients.split(',') : [],
    clientStatus: deriveClientStatus(normalizedClients, allTime, { sourceChecks }),
    wslStatus,
    periodWindows: computePeriodWindows(collectedAt),
    today,
    month,
    allTime
  };
  if (options.historyEnabled === false) {
    summary.history = null;
  } else if (options.includeHistory) {
    const history = await collectHistoryOnce({
      clients: tokscaleClients,
      promaGraph: includesProma ? buildPromaHistoryGraph({ rows: promaRows || collectPromaRows(), pricingByModel: promaPricing || {} }) : null,
      historyEnabled: options.historyEnabled,
      commandTimeoutMs: options.historyTimeoutMs,
      capDays: options.historyCapDays,
      todayKey: localTodayKey(collectedAt),
      runGraph: options.runGraph,
      dailyHistoryArchiveEnabled: options.dailyHistoryArchiveEnabled,
      dailyHistoryArchiveWriteEnabled: options.dailyHistoryArchiveWriteEnabled,
      dailyHistoryArchiveOptions: options.dailyHistoryArchiveOptions,
      dailyHistoryLiveDays,
      onHistoryStatus: options.onHistoryStatus,
      logger: options.logger
    });
    if (history) summary.history = history;
  }
  // After history, so `lastActivityDay` can come from the daily buckets this
  // scan already produced rather than from a second source of truth.
  const clientHealth = deriveClientHealth(normalizedClients, allTime, {
    sourceChecks,
    wslStatus,
    observedAt: collectedAt,
    lastActivityDays: mergeClientActivityDays(
      options.lastActivityDays,
      summary.history,
      today,
      localTodayKey(collectedAt)
    )
  });
  if (clientHealth) summary.clientHealth = clientHealth;
  return summary;
}

function dirExists(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; }
}

function hasCopilotChatSessions(workspaceRoot) {
  try {
    return fs.readdirSync(workspaceRoot, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && dirExists(path.join(workspaceRoot, entry.name, 'chatSessions')));
  } catch (_) {
    return false;
  }
}

// Per-client data-dir candidates, keyed by client. Drives the detection-status
// derivation and (minus the self-synced clients below) the chokidar watch list;
// Antigravity's read-only source roots are added back explicitly below.
// The watched roots, each tagged with a stable id for its *kind*. One id may
// cover several paths: Copilot's workspaceStorage has a variant per platform and
// Kiro's IDE globalStorage has four, but "the VS Code workspace storage is
// missing" is the useful statement, not which spelling was probed. Absolute
// paths contain the user's home directory and never leave this process, so a
// health record carries the id instead — CLIENT_SOURCE_CHECK_IDS in
// clientHealth.js is the allowlist every id here must appear in.
function clientSourceRoots(clientsCsv) {
  const home = os.homedir();
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const byClient = {};
  const add = (client, ...roots) => {
    if (enabled.has(client)) byClient[client] = roots.map(([id, dir]) => ({ id, dir }));
  };
  add('claude', ['claude-projects', path.join(home, '.claude', 'projects')], ['claude-transcripts', path.join(home, '.claude', 'transcripts')]);
  add('codex', ['codex-sessions', path.join(home, '.codex', 'sessions')]);
  const hermesHome = resolveHermesHome({ env: process.env, homeDir: home });
  add('hermes', ['hermes-home', hermesHome], ...hermesProfileWatchDirs(hermesHome).map((dir) => ['hermes-profile', dir]));
  add('opencode', ['opencode-data', path.join(home, '.local', 'share', 'opencode')]);
  add('openclaw', ['openclaw-agents', path.join(home, '.openclaw', 'agents')]);
  add('cursor', ['tokscale-cursor-cache', path.join(home, '.config', 'tokscale', 'cursor-cache')]);
  add('antigravity', ['tokscale-antigravity-cache', path.join(home, '.config', 'tokscale', 'antigravity-cache')]);
  add('kimi', ['kimi-sessions', path.join(home, '.kimi', 'sessions')], ['kimi-code-sessions', path.join(process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code'), 'sessions')]);
  add('qwen', ['qwen-projects', path.join(home, '.qwen', 'projects')]);
  add('grok', ['grok-sessions', path.join(process.env.GROK_HOME || path.join(home, '.grok'), 'sessions')]);
  // Tokscale 4.5.2 also parses VS Code Copilot Chat JSONL under each
  // workspaceStorage/*/chatSessions directory. Watch the workspaceStorage roots
  // so newly created workspaces are picked up; watchIgnoreMatcher prunes every
  // sibling except chatSessions + workspace.json to keep polling bounded.
  const copilotWorkspaceRoots = [
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
    path.join(home, '.config', 'Code', 'User', 'workspaceStorage'),
    ...(process.platform === 'win32'
      ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'workspaceStorage')]
      : []),
    path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage')
  ];
  add(
    'copilot',
    ['copilot-otel', path.join(home, '.copilot', 'otel')],
    ...[...new Set(copilotWorkspaceRoots)].map((dir) => ['vscode-workspace-storage', dir])
  );
  add('pi', ['pi-sessions', path.join(home, '.pi', 'agent', 'sessions')], ['omp-sessions', path.join(home, '.omp', 'agent', 'sessions')]);
  // Zed: tokscale reads the XdgData root on every platform AND the native macOS
  // (Application Support) / Windows (LOCALAPPDATA) roots (see tokscale scanner.rs
  // cfg(macos)/cfg(windows) blocks) — watch all three so native mac/win users get
  // seconds-level refresh and a correct waiting/missing status.
  add(
    'zed',
    ['zed-threads', path.join(home, '.local', 'share', 'zed', 'threads')],
    ['zed-threads', path.join(home, 'Library', 'Application Support', 'Zed', 'threads')],
    ['zed-threads', path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Zed', 'threads')]
  );
  // Kilo Code (VS Code ext): tokscale 3.1.3 only scans the Linux .config root and
  // the .vscode-server (remote) root for KiloCode — unlike Cline, it does NOT scan
  // the native macOS Application Support / Windows %APPDATA% roots. Watching those
  // would be dead watches + a false "waiting" status, so we mirror exactly what
  // tokscale reads. (Native mac/win support pending upstream tokscale.)
  add(
    'kilocode',
    ['kilocode-tasks', path.join(home, '.config', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks')],
    ['kilocode-tasks', path.join(home, '.vscode-server', 'data', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks')]
  );
  // MiMo Code: tokscale 4.8.0 unions the XDG data dir with orca's hook-sandbox
  // copy (scanner.rs `discover_micode_dbs_in_dirs`), and that copy can hold
  // sessions the XDG one is missing. Watch both so an orca-driven install still
  // refreshes in seconds; the orca root only exists on macOS in practice and a
  // missing dir is dropped by watchClientRootsForClients.
  add(
    'micode',
    ['mimocode-data', path.join(home, '.local', 'share', 'mimocode')],
    ['mimocode-orca-data', path.join(home, 'Library', 'Application Support', 'orca', 'mimocode-hooks', 'shared', 'data')]
  );
  add('zcode', ['zcode-projects', path.join(home, '.zcode', 'projects')]);
  // CodeBuddy (Tencent): tokscale reads the home-relative CLI/WebUI JSONL dir on
  // every platform, plus the IDE / VS Code extension logs under a platform-
  // specific CodeBuddyExtension/Logs root (scanner.rs). Watch both so CLI and
  // IDE usage each refresh in seconds; the shared Code/logs tree is deliberately
  // not watched (too broad for polling — full ticks still scan it). No --home
  // host-DB fallback, so every root is safe to watch cross-platform.
  const codebuddyExtLogs = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'CodeBuddyExtension', 'Logs')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Logs')
      : path.join(home, '.local', 'share', 'CodeBuddyExtension', 'Logs');
  add('codebuddy', ['codebuddy-projects', path.join(home, '.codebuddy', 'projects')], ['codebuddy-extension-logs', codebuddyExtLogs]);
  // WorkBuddy (Tencent): watch only the detailed session dir (projects/*.jsonl,
  // the preferred source) — not the whole ~/.workbuddy app home, whose config /
  // auth churn would add polling load and spurious ticks with no usage change.
  // A legacy install with only ~/.workbuddy/workbuddy.db (no projects/) still
  // refreshes via the periodic full tick; the WSL marker stays the broader
  // `.workbuddy` so a db-only WSL home is still scanned.
  add('workbuddy', ['workbuddy-projects', path.join(home, '.workbuddy', 'projects')]);
  // Proma — session transcripts at ~/.proma/agent-sessions/*.jsonl
  add('proma', ['proma-sessions', path.join(home, '.proma', 'agent-sessions')]);
  // Kiro (AWS): tokscale reads home-relative roots — the sessions tree used by
  // both CLI and IDE, the Kiro IDE globalStorage root (native macOS / Linux /
  // Windows), and the kiro-cli sqlite dir. None falls back to a host-absolute
  // path under --home
  // (unlike Zed), so all are safe to watch cross-platform for seconds-level
  // refresh and a correct waiting/missing status.
  //
  // Note the deliberate Kiro-vs-kiro casing asymmetry below (do not "fix" it to
  // list both cases everywhere): tokscale scans both `Kiro` and `kiro` cased
  // globalStorage roots, but watchPathsForClients filters by dirExists, so the
  // COST of listing both differs by filesystem:
  //   - Linux/WSL (case-sensitive): a missing variant is filtered out at zero
  //     cost, and a real lowercase build is genuinely distinct — so list BOTH
  //     `.config/Kiro` and `.config/kiro` (free insurance for the case ambiguity
  //     that tokscale scanning both already signals exists in the wild).
  //   - macOS/Windows (case-insensitive): `Kiro` and `kiro` resolve to the SAME
  //     dir, so both would pass dirExists and double-watch one directory with no
  //     functional gain — so list only the canonical `Kiro` (it already resolves
  //     a lowercase install on these filesystems). Same reason zed lists one case.
  // Usage counting is unaffected either way: full scans run tokscale, which reads
  // every root; the watch list only governs refresh latency + the presence dot.
  // (APPDATA || home AppData\Roaming mirrors how cline resolves the Windows root.)
  add(
    'kiro',
    ['kiro-sessions', path.join(home, '.kiro', 'sessions')],
    ['kiro-ide-globalstorage', path.join(home, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')],
    ['kiro-ide-globalstorage', path.join(home, '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')],
    ['kiro-ide-globalstorage', path.join(home, '.config', 'kiro', 'User', 'globalStorage', 'kiro.kiroagent')],
    ['kiro-ide-globalstorage', path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')],
    ['kiro-cli-data', path.join(home, '.local', 'share', 'kiro-cli')],
    ['kiro-cli-data', path.join(home, 'Library', 'Application Support', 'kiro-cli')]
  );
  add(
    'cline',
    ['cline-tasks', path.join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')],
    ['cline-tasks', path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')],
    ['cline-tasks', path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')],
    ['cline-tasks', path.join(home, '.vscode-server', 'data', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')]
  );
  return byClient;
}

// The watcher only ever wants paths, so it keeps its original shape rather than
// learning about check ids it would immediately discard.
function clientWatchCandidates(clientsCsv) {
  const byClient = {};
  for (const [client, roots] of Object.entries(clientSourceRoots(clientsCsv))) {
    byClient[client] = roots.map((root) => root.dir);
  }
  return byClient;
}

// Clients whose dirs are tokscale caches written only by our own maybeSync* calls.
// Watching them turns every tick into the trigger for the next one (issue #15).
const SELF_SYNCED_CLIENTS = new Set(['cursor', 'antigravity']);

// The Antigravity CLI's parse-local data dir (honors GEMINI_CLI_HOME like tokscale).
// It belongs to the umbrella `antigravity` client but, unlike that client's IDE
// sync cache, is written by `agy` and never by us — so it is both watchable and a
// real presence signal, sharing this single source of truth.
function antigravityCliDataDir() {
  const geminiHome = process.env.GEMINI_CLI_HOME || path.join(os.homedir(), '.gemini');
  return path.join(geminiHome, 'antigravity-cli', 'conversations');
}

// Watch roots that feed a self-sync, keyed by client. Antigravity's IDE cache is
// written by our sync and must stay watch-excluded, but the native session roots
// are read-only inputs to that sync (tokscale only ever readdir/stats them —
// every write it makes lands in its own cache dir). Watching those gives the
// collector an event to target without recreating the issue #15
// cache-write -> watcher -> sync loop, and an event here is what earns the sync
// its short source-event floor.
//
// The parse-local antigravity-cli dir is deliberately not in here even though it
// shares the umbrella client id: tokscale reads it directly, so a CLI write has
// nothing to re-sync and must not pay for the subprocess.
function selfSyncSourceRootsForClients(clientsCsv) {
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const rootsByClient = {};
  if (enabled.has('antigravity')) {
    const sourceRoots = [...new Set(antigravityDataRoots().filter(dirExists))];
    if (sourceRoots.length > 0) rootsByClient.antigravity = sourceRoots;
  }
  return rootsByClient;
}

function watchClientRootsForClients(clientsCsv) {
  const rootsByClient = {};
  for (const [client, dirs] of Object.entries(clientWatchCandidates(clientsCsv))) {
    if (SELF_SYNCED_CLIENTS.has(client)) continue;
    const existing = [...new Set(dirs.filter(dirExists))];
    if (existing.length > 0) rootsByClient[client] = existing;
  }
  for (const [client, dirs] of Object.entries(selfSyncSourceRootsForClients(clientsCsv))) {
    rootsByClient[client] = [...new Set([...(rootsByClient[client] || []), ...dirs])];
  }
  // The Antigravity CLI writes parse-local SQLite that tokscale reads directly,
  // so it is also safe to watch and shares the umbrella client id. The filter
  // expands that id to antigravity-cli when the targeted scan runs.
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const antigravityCliDir = antigravityCliDataDir();
  if (enabled.has('antigravity') && dirExists(antigravityCliDir)) {
    rootsByClient.antigravity = [...new Set([...(rootsByClient.antigravity || []), antigravityCliDir])];
  }
  return rootsByClient;
}

function watchPathsForClients(clientsCsv) {
  return [...new Set(Object.values(watchClientRootsForClients(clientsCsv)).flat())];
}

function clientsForWatchPath(filePath, rootsByClient) {
  if (!filePath) return [];
  const resolved = path.resolve(filePath);
  const matched = [];
  for (const [client, roots] of Object.entries(rootsByClient || {})) {
    if (roots.some((root) => {
      const resolvedRoot = path.resolve(root);
      return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    })) matched.push(client);
  }
  return matched;
}

// Inside a Hermes home dir tokscale only reads the SQLite db; the rest is the
// Desktop App runtime (hermes-agent/node_modules/venv, logs, cache — 150k+ files
// for some users). A plain recursive watch of ~/.hermes pegged CPU at 100%+
// (issue #38). Watching the db files directly instead would miss the WAL/SHM
// sidecars Hermes creates after startup (no seconds-level refresh on a cold
// start), so we keep watching the dir but hand chokidar an `ignored` matcher
// that prunes everything under a Hermes home except the db family. chokidar
// never recurses into an ignored dir (so the runaway poll is gone), yet a
// newly created state.db-wal is still seen on the next top-level readdir.
const HERMES_DB_FILES = new Set(['state.db', 'state.db-wal', 'state.db-shm']);
// MiMo Code keeps a multi-gigabyte log/ tree alongside its SQLite state files.
// A plain recursive watch of ~/.local/share/mimocode storms the watcher (every
// SQLite WAL/SHM transaction is a chokidar event, the log dir holds thousands
// of rotated files). Tokscale discovers mimocode.db and
// mimocode-<channel>.db directly under each data root; the sidecars are not
// parsed but must stay watched so a write through WAL/SHM triggers a refresh.
// Keep the home dir watched but ignore everything except that direct db family.
// The home root itself stays watched so a freshly created database or sidecar
// still surfaces on the next top-level readdir.
const MICODE_DB_WATCH_PATTERN = /^mimocode(?:-[A-Za-z0-9._-]+)?\.db(?:-(?:wal|shm))?$/;
// Which parts of an Antigravity IDE home are worth an event. Not "what tokscale
// parses" — tokscale gets the token data over RPC from the running language
// server and only reads `brain/`+`conversations/` to enumerate session ids.
// These are the paths the IDE touches while a turn is in progress, so they are
// what tells us the synced cache went stale. The rest of the home is runtime and
// cache material (bin/, builtin/, crashes/, antigravity_state.pbtxt …) that
// would make every background write a scan trigger.
const ANTIGRAVITY_SOURCE_DIRS = new Set(['annotations', 'brain', 'conversations']);
const ANTIGRAVITY_SOURCE_FILES = new Set(['agyhub_summaries_proto.pb']);
// `brain/` is watched one level deep only. Its children are per-session working
// dirs holding plans, uploads and screenshots — on a 26-session home that is
// ~508 directories and ~780 files for ~4 changes a week, while the actual
// per-turn signal is `conversations/<id>.db-wal`. Recursing costs an inotify
// descriptor per directory on Linux, which is what makes the ENOSPC fallback to
// polling (sticky for the process) more likely, and once polling that whole tree
// gets stat'd every interval — the Hermes runaway of issue #38 in miniature.
// Watching `brain/` itself still catches a new session directory appearing.
const ANTIGRAVITY_SHALLOW_SOURCE_DIRS = new Set(['brain']);

function watchIgnoreMatcher(clientsCsv) {
  const candidates = clientWatchCandidates(clientsCsv);
  // canonicalWatchPath must be applied here too: chokidar reports events under
  // whatever root it was handed, so a matcher built on the uncanonicalised path
  // would stop matching on Windows and silently un-prune the Hermes runtime
  // (issue #38) while the watch itself still worked.
  const hermesRoots = (candidates.hermes || []).map((dir) => path.resolve(canonicalWatchPath(dir)));
  const hermesRootSet = new Set(hermesRoots);
  const copilotRoots = (candidates.copilot || [])
    .filter((dir) => path.basename(dir) === 'workspaceStorage')
    .map((dir) => path.resolve(canonicalWatchPath(dir)));
  const antigravityEnabled = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).includes('antigravity');
  const antigravityRoots = antigravityEnabled
    ? antigravityDataRoots().map((dir) => path.resolve(canonicalWatchPath(dir)))
    : [];
  const antigravityRootSet = new Set(antigravityRoots);
  const micodeRoots = (candidates.micode || []).map((dir) => path.resolve(canonicalWatchPath(dir)));
  const micodeRootSet = new Set(micodeRoots);
  if (hermesRoots.length === 0 && copilotRoots.length === 0 && antigravityRoots.length === 0 && micodeRoots.length === 0) return undefined;
  return (target) => {
    const resolved = path.resolve(target);
    // Every explicit watch root stays watched — the home dir AND each profile
    // dir. A profile dir lives under the home root, so the child-prune below
    // would otherwise ignore it (basename isn't a db file) before we recognise
    // it as a watch root in its own right, silencing profile-db change events.
    if (hermesRootSet.has(resolved)) return false;
    for (const root of hermesRoots) {
      if (resolved.startsWith(root + path.sep)) return !HERMES_DB_FILES.has(path.basename(resolved));
    }
    for (const root of copilotRoots) {
      if (resolved === root) return false;
      if (!resolved.startsWith(root + path.sep)) continue;
      const parts = path.relative(root, resolved).split(path.sep);
      if (parts.length === 1) return false; // workspace hash dir
      if (parts[1] === 'chatSessions') return false;
      if (parts.length === 2 && parts[1] === 'workspace.json') return false;
      return true;
    }
    if (antigravityRootSet.has(resolved)) return false;
    for (const root of antigravityRoots) {
      if (!resolved.startsWith(root + path.sep)) continue;
      const parts = path.relative(root, resolved).split(path.sep);
      if (parts.length === 1) {
        return !ANTIGRAVITY_SOURCE_DIRS.has(parts[0]) && !ANTIGRAVITY_SOURCE_FILES.has(parts[0]);
      }
      const firstChild = parts[0];
      if (!ANTIGRAVITY_SOURCE_DIRS.has(firstChild)) return true;
      // brain/<session> is kept (a new session shows up there); brain/<session>/**
      // is not — see ANTIGRAVITY_SHALLOW_SOURCE_DIRS.
      if (ANTIGRAVITY_SHALLOW_SOURCE_DIRS.has(firstChild)) return parts.length > 2;
      return false;
    }
    if (micodeRootSet.has(resolved)) return false;
    for (const root of micodeRoots) {
      if (!resolved.startsWith(root + path.sep)) continue;
      // Tokscale reads only direct children of each MiMo root. Keep those
      // database names and their WAL/SHM sidecars, but prune log/* and every
      // other recursive subtree before chokidar descends into it.
      if (path.dirname(resolved) !== root) return true;
      return !MICODE_DB_WATCH_PATTERN.test(path.basename(resolved));
    }
    return false; // paths outside the bounded Hermes/Copilot/Antigravity/MiCode roots are never ignored
  };
}

// Which source roots each tracked client actually has on disk, one entry per
// check id with same-kind paths collapsed by OR. clientDataDirPresence() is
// derived from this rather than computed beside it, so the presence dot in the
// UI and the health record can never disagree about what was found.
function sourceRootExists(root) {
  return root.id === 'vscode-workspace-storage'
    ? hasCopilotChatSessions(root.dir)
    : dirExists(root.dir);
}

function evaluatedClientSourceRoots(clientsCsv) {
  return Object.fromEntries(Object.entries(clientSourceRoots(clientsCsv)).map(([client, roots]) => [
    client,
    roots.map((root) => ({ ...root, exists: sourceRootExists(root) }))
  ]));
}

function clientSourceChecks(clientsCsv, options = {}) {
  const checks = {};
  const push = (client, id, exists) => {
    const list = checks[client] || (checks[client] = []);
    const found = list.find((entry) => entry.id === id);
    if (found) found.exists = found.exists || exists;
    else list.push({ id, exists });
  };
  for (const [client, roots] of Object.entries(evaluatedClientSourceRoots(clientsCsv))) {
    checks[client] = checks[client] || [];
    for (const { id, exists } of roots) push(client, id, exists);
  }
  // antigravity's watch candidate is only the IDE sync cache, which our own sync
  // writes. Its two real sources are separate checks so a health record can say
  // "the IDE is installed but the cache was never written" rather than collapse
  // all three into one boolean. A source-only or CLI-only install with no
  // countable usage yet must read `waiting`, not `missing`; the sync cache stays
  // a valid presence signal for snapshots taken before either of the others
  // existed.
  if (Object.prototype.hasOwnProperty.call(checks, 'antigravity')) {
    push('antigravity', 'antigravity-ide-source', antigravityDataPresent(os.homedir()));
    push('antigravity', 'antigravity-cli-data', dirExists(antigravityCliDataDir()));
  }
  // A client installed only inside WSL has no host directory, but its usage is
  // merged into the same periods — so without this its source reads `missing`
  // while the very same snapshot counts its tokens. The WSL marker is a source
  // that exists; it just lives in a filesystem this process reaches through
  // `wsl.exe` rather than through `fs`.
  for (const client of options.wslDetected || []) {
    if (Object.prototype.hasOwnProperty.call(checks, client)) push(client, 'wsl-home', true);
  }
  return checks;
}

// Every directory a tracked client's usage can come from on this machine, keyed
// by client as {id, dir, exists} — the path-level table behind
// clientSourceChecks(), before same-id roots are collapsed into one boolean.
//
// Only the diagnostics panel wants this shape: a user asking "is it looking
// where I installed it" needs the paths, and a check id cannot answer that. The
// self-synced clients are why it is not simply clientSourceRoots(): that table
// holds antigravity's *sync cache*, which is ours and says nothing about which
// Antigravity is installed — the IDE session roots and the CLI's own data dir
// are the ones that answer it, and they are checks without being watch roots.
function clientDiagnosticRoots(clientsCsv) {
  const byClient = evaluatedClientSourceRoots(clientsCsv);
  if (byClient.antigravity) {
    byClient.antigravity.unshift(
      ...antigravityDataRoots().map((dir) => ({ id: 'antigravity-ide-source', dir, exists: dirExists(dir) })),
      { id: 'antigravity-cli-data', dir: antigravityCliDataDir(), exists: dirExists(antigravityCliDataDir()) }
    );
  }
  return byClient;
}

// Whether each tracked client has at least one data directory on disk. Takes
// pre-computed checks when the caller already has them: a tick derives the
// legacy status and the health record from one probe, so the two cannot
// disagree about a directory created between two scans of the same snapshot.
function clientDataDirPresence(clientsCsv, options = {}) {
  const presence = {};
  for (const [client, checks] of Object.entries(options.sourceChecks || clientSourceChecks(clientsCsv, options))) {
    presence[client] = checks.some((check) => check.exists);
  }
  return presence;
}

// Pure detection-status derivation, given the two existing signals per client:
// `active`  — tokscale read all-time usage for it,
// `waiting` — its data directory exists but no usage was found,
// `missing` — no data directory on disk.
function statusFromSignals(clients, presence, usageClients) {
  const status = {};
  for (const client of clients) {
    if (Number(usageClients?.[client] || 0) > 0) status[client] = 'active';
    else if (presence?.[client]) status[client] = 'waiting';
    else status[client] = 'missing';
  }
  return status;
}

function deriveClientStatus(clientsCsv, allTimePeriod, options = {}) {
  const clients = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return statusFromSignals(clients, clientDataDirPresence(clientsCsv, options), allTimePeriod?.clients || {});
}

// The most recent day each client has recorded usage on, read out of the daily
// history buckets this scan already produced. Deliberately not called "last
// used": it is the newest day the collector *holds data for*, which is the
// honest answer to "is this tool quiet, or are we failing to read it". Per-turn
// timestamps would be the stronger signal and tokscale does not expose them.
function clientActivityDaysFromHistory(history) {
  const days = {};
  for (const bucket of history?.daily || []) {
    const key = String(bucket?.date || '').slice(0, 10);
    if (!key) continue;
    for (const [rawClient, usage] of Object.entries(bucket?.perClient || {})) {
      if (Number(usage?.tokens || 0) <= 0) continue;
      // Folds tokscale's aliases onto the umbrella id, so an antigravity-cli day
      // counts as an antigravity day — the same id the health record is keyed on.
      const client = normalizeClientName(rawClient);
      if (!client) continue;
      if (!days[client] || key > days[client]) days[client] = key;
    }
  }
  return days;
}

// A history refresh runs on its own slower cadence than a usage tick, so a tick
// that skipped it keeps the caller's previous map rather than blanking the
// field. Merged per client rather than swapped wholesale: collectHistoryOnce()
// deliberately survives one source failing while another succeeds, so a refresh
// that returns only Proma's days must not erase what the last one knew about
// Codex. Today's already-collected period is also authoritative for the date: it
// closes the cadence gap without another graph scan. A day only ever moves
// forward, so the newest value wins where sources overlap.
function mergeClientActivityDays(previous, history, todayPeriod, todayKey) {
  const merged = { ...(previous || {}) };
  const candidates = clientActivityDaysFromHistory(history);
  const currentDay = String(todayKey || '').slice(0, 10);
  if (currentDay) {
    for (const [rawClient, tokens] of Object.entries(todayPeriod?.clients || {})) {
      if (Number(tokens || 0) <= 0) continue;
      const client = normalizeClientName(rawClient);
      if (client && (!candidates[client] || currentDay > candidates[client])) {
        candidates[client] = currentDay;
      }
    }
  }
  for (const [client, day] of Object.entries(candidates)) {
    // Per client, newest wins. A plain spread would let a fresh-but-older value
    // push a known day backwards — history is a rolling window and a refresh can
    // legitimately return a shorter one, so "fresh" does not imply "later".
    if (!merged[client] || day > merged[client]) merged[client] = day;
  }
  return merged;
}

// Per-client diagnostics. Every input is a filesystem or subprocess observation
// that only this process can make, which is why the record is built here;
// clientHealth.js owns the shape, the enums and the validation the hub re-runs.
//
// Detail is attached only to clients that are not healthy. A working client is
// fully described by the fixed core, and this record is per client per device on
// a document the hub keeps — so "which of Copilot's two roots is missing" is
// worth its bytes exactly when something is wrong.
function deriveClientHealth(clientsCsv, allTimePeriod, options = {}) {
  const clients = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (clients.length === 0) return null;
  // Injectable so a test can state the filesystem instead of depending on one:
  // every `overall` below turns on whether a directory exists, which makes the
  // developer's machine and a CI runner disagree about the same input.
  const checksByClient = options.sourceChecks || clientSourceChecks(clientsCsv);
  const usageClients = allTimePeriod?.clients || {};
  const wslDetected = new Set(options.wslStatus?.detected || []);
  const wslWithData = new Set(options.wslStatus?.withData || []);
  const activityDays = options.lastActivityDays || {};
  const throttle = options.selfSyncThrottle || selfSyncThrottle;
  const result = {};
  for (const client of clients) {
    const checks = checksByClient[client] || [];
    const detected = checks.filter((check) => check.exists);
    const liveTokens = Number(usageClients[client] || 0);
    const sync = SELF_SYNCED_CLIENTS.has(client) ? throttle.syncStatus(client) : null;
    const entry = {
      source: {
        state: checks.length === 0 ? 'unknown' : (detected.length > 0 ? 'detected' : 'missing'),
        detectedCount: detected.length,
        checkedCount: checks.length
      },
      collection: { state: sync ? sync.state : 'direct' },
      data: { liveTokens: liveTokens > 0 ? liveTokens : 0 }
    };
    // Kept even for a healthy self-synced client: "last synced two minutes ago"
    // is the answer to "why is today still 0", not a fault report.
    if (sync?.lastAttemptAt) entry.collection.lastAttemptAt = new Date(sync.lastAttemptAt).toISOString();
    if (sync?.lastSuccessAt) entry.collection.lastSuccessAt = new Date(sync.lastSuccessAt).toISOString();
    const activityDay = activityDays[client];
    if (activityDay) entry.data.lastActivityDay = activityDay;
    const overall = deriveClientOverall(entry);
    if (overall !== 'healthy') {
      if (checks.length > 0 && detected.length < checks.length) {
        entry.source.checks = checks.map(({ id, exists }) => ({ id, exists }));
      }
      const codes = [];
      // Only "nothing at all" is a fault. A client's roots are alternatives, not
      // dependencies — Antigravity's IDE cache, native sources and CLI data are
      // three ways to have it installed, and so are Kiro's three — so a partial
      // set is the normal shape of a normal install. `checks` still ships as
      // neutral evidence of which ones were found.
      if (checks.length > 0 && detected.length === 0) codes.push('source-missing');
      if (sync?.failureCode) codes.push(sync.failureCode);
      if (detected.length > 0 && liveTokens <= 0) codes.push('no-usage-observed');
      // States a fact, not a cause: a marker without usage can equally mean the
      // tool is installed in that distro and simply unused.
      if (wslDetected.has(client) && !wslWithData.has(client)) codes.push('wsl-detected-no-data');
      // An object per diagnostic even though `code` is the only field today: the
      // extension point is inside the entry, and every diagnostics format worth
      // copying (LSP, ESLint, SARIF, RFC 9457) is shaped this way. Growing an
      // object stays compatible; turning `string[]` into `object[]` would not.
      // Severity is deliberately absent — it depends on which client the code
      // lands on, which only the renderer knows.
      if (codes.length > 0) {
        entry.diagnostics = codes.slice(0, MAX_DIAGNOSTICS_PER_CLIENT).map((code) => ({ code }));
      }
    }
    entry.overall = overall;
    result[client] = entry;
  }
  const health = { version: CLIENT_HEALTH_VERSION, clients: result };
  if (options.observedAt) health.observedAt = new Date(options.observedAt).toISOString();
  return health;
}

// The frozen wslAnchor is only valid to merge into a preview period when it was
// captured in the same calendar window: today only if the anchor is from today,
// month only if from the same month. Otherwise a cross-day / cross-month full
// scan would briefly add the previous period's WSL usage to the preview before
// the final fresh scan corrects it. Returns the WSL period to merge, or null.
function wslPeriodsForPreview(wslAnchor, anchorDateKey, todayKey) {
  if (!wslAnchor) return { today: null, month: null };
  const key = anchorDateKey || '';
  return {
    today: key === todayKey ? wslAnchor.today : null,
    month: key.slice(0, 7) === todayKey.slice(0, 7) ? wslAnchor.month : null
  };
}

function completeTodayPartitions(partitions, clientsCsv) {
  const completed = { ...(partitions || {}) };
  for (const client of normalizeClientsCsv(clientsCsv).split(',').filter(Boolean)) {
    if (!Object.prototype.hasOwnProperty.call(completed, client)) completed[client] = emptyPeriod();
  }
  return completed;
}

function replaceTodayPartitions(current, fresh, targetClients) {
  const next = { ...(current || {}) };
  for (const client of targetClients || []) next[client] = emptyPeriod();
  for (const [client, period] of Object.entries(fresh || {})) next[client] = period;
  return next;
}

function mergeTodayPartitions(partitions) {
  return mergePeriods(...Object.values(partitions || {}));
}

function periodHasUsage(period) {
  if (!period) return false;
  return Number(period.totalTokens || 0) > 0
    || Number(period.costUsd || 0) > 0
    || Object.keys(period.sessions || {}).length > 0;
}

function canTargetTodayPartitions(anchor, targetClients) {
  if (!targetClients?.length) return true;
  return Boolean(
    anchor?.todayPartitions
    && !periodHasUsage(anchor.todayPartitions[UNATTRIBUTED_USAGE_CLIENT])
    && targetClients.every((client) => Object.prototype.hasOwnProperty.call(anchor.todayPartitions, client))
  );
}

function configFingerprint(clientsCsv, allTimeSince, projectsEnabled = true) {
  // Deterministic string that captures the config inputs anchor correctness
  // depends on. When this changes, the persisted anchor is invalidated.
  return `${normalizeClientsCsv(clientsCsv)}|${allTimeSince}|projects:${projectsEnabled !== false ? 'on' : 'off'}`;
}

// Force a full scan at least this often even when the anchor is otherwise
// valid, so a long-running session periodically rescans month/allTime
// and picks up any changes that the delta-derivation might miss.
const FULL_SCAN_INTERVAL_MS = 60 * 60 * 1000;

// Escape hatch for filesystems that never deliver native events — network
// mounts, some FUSE drivers, container bind mounts. chokidar has its own
// CHOKIDAR_USEPOLLING override, but that is chokidar's surface, not ours: it
// is undocumented for our users and can change with a dependency bump, so
// support asks would have no stable answer. Resolved here rather than in each
// entry point so the widget and the headless agent cannot drift apart.
// Tri-state on purpose: unset must fall through to the caller's value, which
// is why parseBoolean's fallback semantics don't fit. The default is native on
// every platform — chokidar 4 has no per-platform backend left to differ on,
// and the failure cases it cannot cover are handled by the watch-descriptor
// fallback below rather than by pre-emptively polling everywhere.
//
// Returns undefined when unset, which is what keeps that tri-state readable to
// callers that need to tell "no opinion" from an explicit "never poll".
function watchPollingEnvOverride(env = process.env) {
  const raw = String(env.TOKEN_MONITOR_WATCH_POLLING ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function resolveWatchUsePolling(preferred, env = process.env) {
  const override = watchPollingEnvOverride(env);
  if (override !== undefined) return override;
  if (typeof preferred === 'boolean') return preferred;
  return false;
}

// Kernel watch descriptors are a per-user budget shared with every other
// watcher on the machine (inotify on Linux, file descriptors on macOS/BSD), and
// editors are the usual heavy consumer — a busy Linux desktop can hand us
// ENOSPC on startup through no fault of ours. chokidar reports that
// asynchronously on the watcher, so without this the watch would just stop
// delivering events and live mode would silently decay to hourly
// reconciliation. Polling needs no descriptors at all, which makes it the
// correct degraded mode rather than merely a slower one. An explicit
// TOKEN_MONITOR_WATCH_POLLING=0 opts out: with native events now the default
// everywhere, suppressing this fallback is the only thing that direction of the
// override still does.
const WATCH_DESCRIPTOR_ERROR_CODES = new Set(['ENOSPC', 'EMFILE', 'ENFILE']);

// Windows only: libuv asserts that the filename ReadDirectoryChangesW hands
// back starts with the directory string it was given, and calls abort() when it
// does not (src/win/fs-event.c). An 8.3 short path such as C:\Users\RUNNER~1\…
// is reported back in its long form and trips exactly that assert, taking the
// whole process down. That is a native abort, so handleWatchError can never see
// it and the polling fallback cannot save us — the only guard is to hand
// chokidar the canonical long path in the first place. Junctions reach the same
// assert by the same route. Identity off Windows, so watch roots elsewhere stay
// byte-identical to the paths tokscale reads.
function canonicalWatchPath(dir) {
  if (process.platform !== 'win32') return dir;
  try { return fs.realpathSync.native(dir); }
  catch (_) { return dir; }
}

function watcherOptions(usePolling, ignored) {
  return {
    ignoreInitial: true,
    persistent: true,
    ...(usePolling
      ? { usePolling: true, interval: 2000, binaryInterval: 5000 }
      : { usePolling: false }),
    ...(ignored ? { ignored } : {}),
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 }
  };
}

function startCollector(options) {
  const {
    clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion, agentRuntime,
    historyIntervalMs = 15 * 60 * 1000, historyEnabled = true, watchEnabled,
    watchTriggersCollection = true, intervalRequiresActivity = false,
    onUpdate, onPreview, onError, onDiagnosticEvent, logger
  } = options;
  // Normalized once, at the edge. These arrive straight from CLI flags and env
  // vars (TOKEN_MONITOR_WATCH_DEBOUNCE_MS, TOKEN_MONITOR_INTERVAL_MS) by way of
  // a bare Number(), so Infinity and past-32-bit values reach us intact — and
  // setTimeout rewrites those to 1ms, turning the debounce's mid-tick re-arm and
  // the interval loop into spins. Clamping here means no timer below can
  // reintroduce that by forgetting.
  const watchDebounceMs = clampTimerDelayMs(options.watchDebounceMs, 1500);
  const intervalMs = clampTimerDelayMs(options.intervalMs, 5 * 60 * 1000);
  const watchUsePolling = resolveWatchUsePolling(options.watchUsePolling);
  const watchNativeForced = watchPollingEnvOverride() === false;
  const trackedClients = new Set(normalizeClientsCsv(clients).split(',').filter(Boolean));
  const deviceOsInfo = options.osInfo === undefined
    ? hostOsInfo()
    : normalizeOsInfo(options.osInfo);
  const log = logger || (() => {});
  let tickInFlight = false;
  let tickPending = false;
  let pendingForceHistory = false;
  let pendingForceSelfSync = null;
  let pendingSourceSelfSync = null;
  // null until something is actually pending. Tracked separately from the
  // force-sync flags on purpose: a coalesced replay must stay a full scan
  // unless *every* tick folded into it asked for today-only, and deriving that
  // from a force flag would let a manual refresh quietly become a warm scan.
  let pendingTodayOnly = null;
  // null means no pending scope yet; true means an all-client replay; otherwise
  // this Set is the union of targeted today-only requests waiting behind the
  // active tick. A broader request can upgrade this scope but never narrow it.
  let pendingTargetClients = null;
  let pendingActivityRevision = null;
  let lastHistoryAt = 0;
  let lastHistoryAttemptAt = 0;
  let lastHistorySuccessAt = 0;
  let lastHistoryFailureCode = null;
  let lastHistoryScanDurationMs = null;
  // Last full-scan snapshot; lets watch ticks scan only --today and derive
  // month/allTime exactly (applyPeriodDelta). Reset by every full tick.
  // anchor holds Windows-only periods; wslAnchor is the WSL contribution frozen
  // between full ticks (WSL is not scanned on watch ticks).
  let anchor = null;
  let wslAnchor = null;
  let wslStatusAnchor = null;
  // The last-activity days a history refresh produced, carried across the ticks
  // that skip history. Read back out of the record this collector just published
  // rather than kept as a second copy, so the two cannot drift; a restart simply
  // relearns them from the first tick, which always includes history.
  let activityDaysAnchor = {};
  // Keep the highest complete live day in this collector even when another
  // process owns the shared archive. A watch tick can then hand its value to a
  // later full/history tick instead of losing it at the tick boundary.
  let liveDailyHistoryDays = {};
  let lastFullScanAt = 0;
  let pendingWaiters = [];
  let debounceTimer = null;
  let intervalTimer = null;
  let stopped = false;
  let lastTickAttemptAt = 0;
  let lastTickSuccessAt = 0;
  let lastTickFailureAt = 0;
  let lastTickDurationMs = null;
  let lastTickScope = 'full';
  let lastTickReasonCode = null;
  let lastTickFailureCode = null;
  let watchFallbackCode = null;
  let lastWatchFailureCode = null;
  let tickHadFailure = false;
  const scheduledWatchClients = new Set();
  let scheduledWatchNeedsFullScan = false;
  // Source events waiting on the shared throttle, and the timer that comes back
  // for them. Built here rather than at module scope because its timer has to
  // die with this collector; the throttle it reads deadlines from is shared, so
  // a rebuild inherits the floors it must not reset. `retryMs` mirrors the watch
  // debounce so a catch-up displaced by an in-flight tick lands just after it.
  const sourceSyncQueue = createSourceSyncQueue({
    throttle: selfSyncThrottle,
    retryMs: watchDebounceMs,
    isBusy: () => tickInFlight,
    // The tick that carried this event already scanned against the stale cache,
    // so the catch-up has to rescan the same clients behind the sync.
    onDue: (sourceSelfSync) => runTick('source-sync', {
      todayOnly: true,
      targetClients: sourceSelfSync,
      sourceSelfSync
    })
  });
  const selfSyncedClients = normalizeClientsCsv(clients).split(',').filter((client) => SELF_SYNCED_CLIENTS.has(client));
  let activityRevision = 0;
  let collectedActivityRevision = 0;
  let initialCollectionComplete = false;
  const watchers = [];
  let watchedDirectoryKey = null;
  // Sticky: once the kernel has refused us watch descriptors, every later
  // rebuild (a client gaining or losing a data directory) stays on polling for
  // the rest of the process. Retrying native events on each rebuild would just
  // rediscover the same exhausted budget.
  let watchDescriptorFallback = false;

  function emitDiagnosticEvent(event) {
    try {
      onDiagnosticEvent?.(event);
    } catch (_) {
      // Diagnostics observers must never affect collection or watcher state.
    }
  }

  function tickReasonCode(reason) {
    const value = String(reason || '').trim().toLowerCase();
    if (value.startsWith('watch:')) return 'watch-event';
    if (value.startsWith('client:')) return 'targeted-client';
    if (value === 'source-sync') return 'source-sync';
    if (value === 'coalesced') return 'coalesced';
    if (value === 'interval') return 'interval';
    if (value === 'manual') return 'manual';
    return 'other';
  }

  function tickScopeCode(tickOptions = {}) {
    if (tickOptions.todayOnly === true && Array.isArray(tickOptions.targetClients) && tickOptions.targetClients.length > 0) {
      return 'targeted';
    }
    return tickOptions.todayOnly === true ? 'today' : 'full';
  }

  function timestampOrNull(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0
      ? new Date(Number(value)).toISOString()
      : null;
  }

  function cloneDiagnosticValue(value) {
    if (value === null || value === undefined) return value ?? null;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }

  // On-disk anchor: persist full-scan snapshots so the collector can reuse
  // month/allTime across restarts. On the first interval tick the anchor is
  // valid for today and configFingerprint matches, only --today is scanned
  // and month/allTime are derived via applyPeriodDelta.
  const anchorPath = path.join(sharedDataDir(), 'collector-anchor.json');
  if (options.anchorPersistenceEnabled !== false) {
    try {
      const saved = readJson(anchorPath, null);
      if (saved && saved.dateKey === localTodayKey()) {
        const fp = configFingerprint(clients, allTimeSince, options.projectsEnabled);
        if (saved.configFingerprint === fp) {
          anchor = {
            dateKey: saved.dateKey,
            today: saved.today,
            month: saved.month,
            allTime: saved.allTime,
            // Per-client partitions are deliberately rebuilt by the first
            // anchored all-client tick after restart. Persisted partitions
            // could be stale for clients that changed while the app was down.
            todayPartitions: null
          };
          // Don't restore a persisted WSL snapshot when WSL scanning is now off —
          // the configFingerprint intentionally ignores the toggle (host periods
          // stay valid), so without this gate a warm-scan preview would briefly
          // re-merge the old WSL totals before the first full tick clears them.
          wslAnchor = options.wslScanEnabled !== false ? (saved.wslBundle || null) : null;
          wslStatusAnchor = options.wslScanEnabled !== false ? (saved.wslStatus || null) : null;
          if (saved.fullScanAt) {
            const parsed = Date.parse(saved.fullScanAt);
            // Only trust timestamps that are valid and not in the future.
            // Invalid, future, or missing timestamps leave lastFullScanAt at 0,
            // which forces a full scan on the first interval tick (see loop()).
            if (Number.isFinite(parsed) && parsed <= Date.now()) {
              lastFullScanAt = parsed;
            }
          }
        }
      }
    } catch (_) {}
  }

  function resolveWaiters(waiters, result) {
    for (const resolve of waiters) resolve(result);
  }

  async function performTick(reason, tickOptions = {}) {
    const tickStartedAt = Date.now();
    const includeHistory = shouldIncludeHistory(Date.now(), lastHistoryAt, historyIntervalMs, Boolean(tickOptions.forceHistory), historyEnabled);
    if (includeHistory) {
      lastHistoryAt = Date.now();
      lastHistoryAttemptAt = tickStartedAt;
    }
    const todayKey = localTodayKey();
    const requestedTargetClients = [...new Set(normalizeClientsCsv(tickOptions.targetClients).split(',').filter(Boolean))];
    const targetAnchorReady = canTargetTodayPartitions(anchor, requestedTargetClients);
    const anchored = Boolean(tickOptions.todayOnly && anchor && anchor.dateKey === todayKey);
    const refreshWsl = Boolean(tickOptions.refreshWsl);
    const hadPreviousFailure = tickHadFailure;
    lastTickAttemptAt = tickStartedAt;
    lastTickReasonCode = tickReasonCode(reason);
    lastTickScope = tickScopeCode(tickOptions);
    try {
      let captured = null;
      const summary = await collectUsageOnce({
        ...options,
        clients,
        allTimeSince,
        commandTimeoutMs,
        deviceId,
        agentVersion,
        agentRuntime,
        osInfo: deviceOsInfo,
        includeHistory,
        // Capture after the runtime's transformUsage hook so the archive uses
        // the same today period that the user actually sees. The process-local
        // liveDays overlay is passed into any graph scan that happens first.
        deferLiveHistoryCapture: true,
        dailyHistoryLiveDays: liveDailyHistoryDays,
        onHistoryStatus: includeHistory ? (status) => {
          lastHistoryAttemptAt = Date.parse(status.attemptedAt) || lastHistoryAttemptAt;
          const successAt = Date.parse(status.successAt);
          if (Number.isFinite(successAt)) lastHistorySuccessAt = successAt;
          lastHistoryFailureCode = status.failureCode || null;
          lastHistoryScanDurationMs = status.durationMs;
        } : null,
        forceSelfSync: tickOptions.forceSelfSync ?? null,
        sourceSelfSync: tickOptions.sourceSelfSync ?? null,
        // Both selections name clients whose pending source event this tick has
        // already consumed — the queue's drain for one, its acknowledgement for
        // the other — so either is a legitimate restore.
        onSelfSyncFailed: (kind) => sourceSyncQueue.restore(
          mergeSelfSyncSelection(tickOptions.sourceSelfSync, tickOptions.acknowledgedSourceSync) || [],
          kind
        ),
        targetClients: anchored && targetAnchorReady ? requestedTargetClients : [],
        todayOnlyAnchor: anchored ? anchor : null,
        wslAnchor: anchored ? wslAnchor : null,
        wslStatus: anchored ? wslStatusAnchor : null,
        lastActivityDays: activityDaysAnchor,
        refreshWsl: anchored ? refreshWsl : false,
        onAnchorComputed: (x) => { captured = x; },
        onProgress: (partial) => {
          if (!partial.today) return;
          try {
            if (typeof onPreview === 'function') {
              // Frozen WSL snapshot, gated so a cross-day/cross-month full scan
              // doesn't merge a stale period's WSL usage into the preview.
              const wsl = wslPeriodsForPreview(wslAnchor, anchor?.dateKey, todayKey);
              const preview = {
                deviceId, hostname: os.hostname(),
                platform: `${process.platform}-${process.arch}`,
                ...(deviceOsInfo.name ? { osName: deviceOsInfo.name } : {}),
                ...(deviceOsInfo.version ? { osVersion: deviceOsInfo.version } : {}),
                updatedAt: partial.updatedAt,
                agentVersion, agentRuntime,
                trackedClients: (clients || '').split(',').filter(Boolean),
                // Merge the frozen WSL snapshot into today (as month/allTime do
                // below) so the today card keeps its WSL contribution during a
                // warm scan instead of dropping to host-only until the final tick.
                today: wsl.today ? mergePeriods(partial.today, wsl.today) : partial.today
              };
              // Only include month/allTime when actually scanned. During warm
              // full scans the main.js handler carries the previous values
              // forward for omitted fields, so these cards don't flash empty.
              if (partial.month) {
                preview.month = wsl.month
                  ? mergePeriods(partial.month, wsl.month)
                  : partial.month;
              }
              if (partial.allTime) {
                preview.allTime = wslAnchor
                  ? mergePeriods(partial.allTime, wslAnchor.allTime)
                  : partial.allTime;
              }
              onPreview(preview);
            }
          } catch (_) {
            // Progressive push errors must not abort the remaining period scans.
            // The final onUpdate will report the complete data.
          }
        }
      });
      if (stopped) return;
      for (const [client, entry] of Object.entries(summary.clientHealth?.clients || {})) {
        if (entry.data?.lastActivityDay) activityDaysAnchor[client] = entry.data.lastActivityDay;
      }
      if (!anchored && captured) {
        anchor = {
          dateKey: todayKey,
          today: captured.windowsPeriods.today,
          month: captured.windowsPeriods.month,
          allTime: captured.windowsPeriods.allTime,
          todayPartitions: captured.todayPartitions
        };
        wslAnchor = captured.wslBundle;
        wslStatusAnchor = captured.wslStatus || null;
        lastFullScanAt = Date.now();
        if (options.anchorPersistenceEnabled !== false) {
          try {
            fs.mkdirSync(path.dirname(anchorPath), { recursive: true });
            fs.writeFileSync(anchorPath, JSON.stringify({
              dateKey: anchor.dateKey,
              today: anchor.today,
              month: anchor.month,
              allTime: anchor.allTime,
              wslBundle: wslAnchor,
              wslStatus: wslStatusAnchor,
              configFingerprint: configFingerprint(clients, allTimeSince, options.projectsEnabled),
              fullScanAt: new Date().toISOString()
            }));
          } catch (_) {}
        }
      } else if (anchored && captured) {
        // Keep the rolling per-client today partitions fresh for targeted
        // watch ticks. WSL stays independently frozen between interval ticks.
        if (captured.todayPartitions) anchor.todayPartitions = captured.todayPartitions;
        if (refreshWsl) {
          wslAnchor = captured.wslBundle;
          wslStatusAnchor = captured.wslStatus || null;
        }
      }
      const transformedSummary = await onUpdate?.(summary, reason);
      const visibleSummary = transformedSummary && typeof transformedSummary === 'object'
        ? transformedSummary
        : summary;
      if (historyEnabled !== false && options.dailyHistoryArchiveEnabled) {
        try {
          const visibleAt = visibleSummary.updatedAt || summary.updatedAt;
          const visibleDate = visibleAt ? new Date(visibleAt) : new Date();
          const visibleDateKey = Number.isFinite(visibleDate.getTime())
            ? localTodayKey(visibleDate)
            : todayKey;
          const retainedLive = retainLiveDailyHistory(visibleSummary.today, {
            ...(options.dailyHistoryArchiveOptions || {}),
            liveDays: liveDailyHistoryDays,
            todayKey: visibleDateKey,
            // Watch ticks update the in-memory maximum on every refresh, but
            // only full/history ticks write it. This avoids a disk write for
            // every few-second watch event without dropping the value before
            // the next tick or local-day rollover.
            writeEnabled: !anchored || includeHistory
              || anchor?.dateKey !== visibleDateKey
              ? options.dailyHistoryArchiveWriteEnabled
              : false
          });
          liveDailyHistoryDays = retainedLive.liveDays || {};
        } catch (error) {
          log(`daily live history archive failed: ${error.message}`);
        }
      }
      const tickFinishedAt = Date.now();
      lastTickSuccessAt = tickFinishedAt;
      lastTickDurationMs = Math.max(0, tickFinishedAt - tickStartedAt);
      lastTickFailureCode = null;
      tickHadFailure = false;
      if (hadPreviousFailure) {
        emitDiagnosticEvent({
          subsystem: 'collector',
          code: 'collector-recovered',
          durationMs: lastTickDurationMs
        });
      }
      if (!anchored) setupWatchers();
      if (Number.isFinite(tickOptions.activityRevision)) {
        collectedActivityRevision = Math.max(collectedActivityRevision, tickOptions.activityRevision);
        initialCollectionComplete = true;
      }
      return true;
    } catch (error) {
      if (stopped) return;
      const tickFinishedAt = Date.now();
      lastTickFailureAt = tickFinishedAt;
      lastTickDurationMs = Math.max(0, tickFinishedAt - tickStartedAt);
      lastTickFailureCode = 'tick-failed';
      tickHadFailure = true;
      emitDiagnosticEvent({
        subsystem: 'collector',
        code: 'collector-tick-failed',
        scope: lastTickScope,
        durationMs: lastTickDurationMs
      });
      // takeWatchClients() already drained the pending set, so the clients this
      // tick was meant to cover are gone. Force the next tick to scan all of
      // them in every mode: in live mode the next watch event would otherwise
      // target only its own client and leave the failed one serving the stale
      // anchor partition until the 5–30 minute interval reconciles it, which
      // breaks the seconds-level freshness live mode promises.
      scheduledWatchNeedsFullScan = true;
      if (onError) onError(error, reason); else log(`collector tick failed (${reason}): ${error.message}`);
      return false;
    }
  }

  function mergePendingTargetScope(tickOptions) {
    const todayOnly = tickOptions.todayOnly === true;
    const targets = [...new Set(normalizeClientsCsv(tickOptions.targetClients).split(',').filter(Boolean))];
    if (!todayOnly || targets.length === 0) {
      pendingTargetClients = true;
      return;
    }
    if (pendingTargetClients === true) return;
    if (!(pendingTargetClients instanceof Set)) pendingTargetClients = new Set();
    for (const client of targets) pendingTargetClients.add(client);
  }

  async function runTick(reason, tickOptions = {}) {
    const tickActivityRevision = Number.isFinite(tickOptions.activityRevision)
      ? tickOptions.activityRevision
      : activityRevision;
    const effectiveTickOptions = { ...tickOptions, activityRevision: tickActivityRevision };
    if (tickInFlight) {
      tickPending = true;
      pendingForceHistory = pendingForceHistory || Boolean(tickOptions.forceHistory);
      pendingForceSelfSync = mergeSelfSyncSelection(pendingForceSelfSync, tickOptions.forceSelfSync);
      pendingSourceSelfSync = mergeSelfSyncSelection(pendingSourceSelfSync, tickOptions.sourceSelfSync);
      pendingTodayOnly = pendingTodayOnly === null
        ? Boolean(tickOptions.todayOnly)
        : pendingTodayOnly && Boolean(tickOptions.todayOnly);
      mergePendingTargetScope(tickOptions);
      pendingActivityRevision = pendingActivityRevision === null
        ? tickActivityRevision
        : Math.max(pendingActivityRevision, tickActivityRevision);
      return new Promise((resolve) => pendingWaiters.push(resolve));
    }
    tickInFlight = true;
    try {
      const initialResult = await performTick(reason, {
        ...effectiveTickOptions,
        acknowledgedSourceSync: sourceSyncQueue.acknowledge(effectiveTickOptions.forceSelfSync)
      });
      while (tickPending && !stopped) {
        const forceHistory = pendingForceHistory;
        const forceSelfSync = pendingForceSelfSync;
        const sourceSelfSync = pendingSourceSelfSync;
        const todayOnly = pendingTodayOnly === true;
        const targetClients = todayOnly && pendingTargetClients instanceof Set
          ? [...pendingTargetClients]
          : [];
        const activityRevision = pendingActivityRevision;
        const waiters = pendingWaiters;
        pendingWaiters = [];
        tickPending = false;
        pendingForceHistory = false;
        pendingForceSelfSync = null;
        pendingSourceSelfSync = null;
        pendingTodayOnly = null;
        pendingTargetClients = null;
        pendingActivityRevision = null;
        const acknowledgedSourceSync = sourceSyncQueue.acknowledge(forceSelfSync);
        const result = await performTick('coalesced', {
          forceHistory,
          forceSelfSync,
          sourceSelfSync,
          acknowledgedSourceSync,
          todayOnly,
          targetClients,
          ...(activityRevision === null ? {} : { activityRevision })
        });
        resolveWaiters(waiters, result === true);
      }
      return initialResult === true;
    } finally {
      tickInFlight = false;
      if (stopped && pendingWaiters.length > 0) {
        const waiters = pendingWaiters;
        pendingWaiters = [];
        resolveWaiters(waiters, false);
      }
    }
  }

  function recordWatchClients(eventClients) {
    if (Array.isArray(eventClients)) {
      if (eventClients.length === 0) scheduledWatchNeedsFullScan = true;
      else for (const client of eventClients) scheduledWatchClients.add(client);
    }
  }

  function takeWatchClients(additionalClients = []) {
    const targetClients = scheduledWatchNeedsFullScan
      ? []
      : [...new Set([...scheduledWatchClients, ...additionalClients])];
    scheduledWatchClients.clear();
    scheduledWatchNeedsFullScan = false;
    return targetClients;
  }

  function scheduleTick(reason, eventClients) {
    if (stopped) return;
    recordWatchClients(eventClients);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // Re-arm instead of queueing onto the in-flight tick: the coalesce path
      // would re-run immediately on completion, stacking scans back-to-back.
      if (tickInFlight) { scheduleTick(reason); return; }
      // A raw source event means that client's synced cache may now be stale, so
      // its sync drops to the short floor instead of waiting out the idle
      // cadence. Its cache is deliberately outside the watcher, so a sync here
      // cannot create the issue #15 self-trigger loop.
      runTick(reason, {
        todayOnly: true,
        targetClients: takeWatchClients(),
        sourceSelfSync: sourceSyncQueue.takeDue()
      });
    }, watchDebounceMs);
  }

  function closeWatchers() {
    for (const watcher of watchers) {
      try { watcher.close(); } catch (_) {}
    }
    watchers.length = 0;
  }

  function handleWatchError(error) {
    log(`chokidar error: ${error.message}`);
    if (stopped || watchUsePolling || watchNativeForced || watchDescriptorFallback) return;
    if (!WATCH_DESCRIPTOR_ERROR_CODES.has(error?.code)) return;
    watchDescriptorFallback = true;
    watchFallbackCode = error.code;
    emitDiagnosticEvent({
      subsystem: 'watcher',
      code: 'watcher-polling-fallback',
      detailCode: error.code
    });
    log(`Native file events unavailable (${error.code}); falling back to 2s polling.`);
    // Rebuilding from inside chokidar's own error emit would close the watcher
    // mid-dispatch, so hand it to the next tick of the loop instead.
    setImmediate(() => {
      if (stopped) return;
      watchedDirectoryKey = null;
      setupWatchers();
    });
  }

  function setupWatchers() {
    if (!watchEnabled) return;
    // Canonicalise before anything derives from these roots, so the paths handed
    // to chokidar and the paths clientsForWatchPath matches against are the same
    // strings. Resolving only one of the two would silently break attribution.
    const rootsByClient = Object.fromEntries(
      Object.entries(watchClientRootsForClients(clients))
        .map(([client, dirs]) => [client, dirs.map(canonicalWatchPath)])
    );
    // A subset of the same roots, matched separately so a write to a client's
    // parse-local data cannot pass for a write to its self-sync source.
    const sourceSyncRootsByClient = Object.fromEntries(
      Object.entries(selfSyncSourceRootsForClients(clients))
        .map(([client, dirs]) => [client, dirs.map(canonicalWatchPath)])
    );
    const dirs = [...new Set(Object.values(rootsByClient).flat())];
    const directoryKey = dirs.join('\0');
    if (directoryKey === watchedDirectoryKey) return;
    closeWatchers();
    if (dirs.length === 0) {
      watchedDirectoryKey = directoryKey;
      lastWatchFailureCode = null;
      log('No watchable client data directories found; relying on fallback interval only.');
      return;
    }
    const usePolling = watchUsePolling || watchDescriptorFallback;
    try {
      const ignored = watchIgnoreMatcher(clients);
      const watcher = chokidar.watch(dirs, watcherOptions(usePolling, ignored));
      watcher.on('all', (event, filePath) => {
        activityRevision += 1;
        if (tickPending) {
          pendingActivityRevision = pendingActivityRevision === null
            ? activityRevision
            : Math.max(pendingActivityRevision, activityRevision);
        }
        const eventClients = clientsForWatchPath(filePath, rootsByClient);
        for (const client of clientsForWatchPath(filePath, sourceSyncRootsByClient)) {
          sourceSyncQueue.record(client);
        }
        if (watchTriggersCollection) {
          scheduleTick(
            `watch:${event}:${path.basename(filePath || '')}`,
            eventClients
          );
        } else recordWatchClients(eventClients);
      });
      watcher.on('error', handleWatchError);
      watchers.push(watcher);
      watchedDirectoryKey = directoryKey;
      lastWatchFailureCode = null;
      for (const dir of dirs) log(`Watching ${dir} (${usePolling ? 'polling 2s' : 'native events'})`);
    } catch (error) {
      watchedDirectoryKey = null;
      lastWatchFailureCode = 'watcher-rebuild-failed';
      emitDiagnosticEvent({ subsystem: 'watcher', code: 'watcher-rebuild-failed' });
      log(`Cannot watch ${dirs.join(', ')}: ${error.message}`);
    }
  }

  function loop() {
    if (stopped) return;
    const activityRevisionAtStart = activityRevision;
    // Native watchers are an optimization, not the source of truth. Always
    // retain the hourly reconciliation path for missed events, newly created
    // client directories, WSL-only activity, and cross-day metadata refreshes.
    const fullScanDue = lastFullScanAt === 0 || Date.now() - lastFullScanAt >= FULL_SCAN_INTERVAL_MS;
    if (
      intervalRequiresActivity &&
      initialCollectionComplete &&
      !fullScanDue &&
      activityRevisionAtStart <= collectedActivityRevision
    ) {
      intervalTimer = setTimeout(loop, intervalMs);
      return;
    }
    // Full scan at least once per FULL_SCAN_INTERVAL_MS so the anchor
    // does not drift from reality over a long-running session.
    // lastFullScanAt === 0 means no valid timestamp exists (cold start,
    // unparseable, or future timestamp) — force a full scan immediately.
    const anchorToday = Boolean(!fullScanDue && anchor && anchor.dateKey === localTodayKey());
    const sourceSelfSync = intervalRequiresActivity ? sourceSyncQueue.takeDue() : null;
    const targetClients = intervalRequiresActivity ? takeWatchClients(selfSyncedClients) : [];
    runTick('interval', {
      ...(anchorToday ? { todayOnly: true, refreshWsl: true, targetClients } : {}),
      ...(sourceSelfSync ? { sourceSelfSync } : {}),
      activityRevision: activityRevisionAtStart
    }).finally(() => {
      if (stopped) return;
      intervalTimer = setTimeout(loop, intervalMs);
    });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (intervalTimer) { clearTimeout(intervalTimer); intervalTimer = null; }
    sourceSyncQueue.stop();
    closeWatchers();
    watchedDirectoryKey = null;
  }

  function getDiagnostics() {
    const watchMode = !watchEnabled
      ? 'disabled'
      : (watchUsePolling || watchDescriptorFallback ? 'polling' : 'native');
    const state = stopped
      ? 'stopped'
      : tickInFlight
        ? 'running'
        : lastTickFailureCode
          ? 'failed'
          : 'idle';
    return {
      state,
      collectionMode: watchTriggersCollection ? 'live' : intervalRequiresActivity ? 'smart' : 'interval',
      intervalMs,
      watchDebounceMs,
      watchEnabled,
      watchMode,
      watchFallbackCode,
      lastWatchFailureCode,
      tickInFlight,
      tickPending,
      lastTickReasonCode,
      lastTickScope,
      lastTickAttemptAt: timestampOrNull(lastTickAttemptAt),
      lastTickSuccessAt: timestampOrNull(lastTickSuccessAt),
      lastTickFailureAt: timestampOrNull(lastTickFailureAt),
      lastTickDurationMs,
      lastFullScanAt: timestampOrNull(lastFullScanAt),
      lastHistoryAttemptAt: timestampOrNull(lastHistoryAttemptAt),
      lastHistorySuccessAt: timestampOrNull(lastHistorySuccessAt),
      lastHistoryFailureCode,
      lastHistoryScanDurationMs,
      lastFailureCode: lastTickFailureCode,
      wslStatus: cloneDiagnosticValue(wslStatusAnchor)
    };
  }

  setupWatchers();
  loop();

  // A rescan of one tool. Was cursor-only because a Cursor sign-in was the only
  // caller; the machinery underneath was always per-client, so the guard was a
  // narrower contract than the implementation. `targetClients` keeps the scan to
  // the partition being asked about instead of every client's today.
  function refreshClient(clientId, refreshOptions = {}) {
    const normalized = String(clientId || '').trim().toLowerCase();
    if (!normalized || !trackedClients.has(normalized)) {
      throw new TypeError(`Unsupported targeted usage client: ${normalized || '(empty)'}`);
    }
    return runTick(`client:${normalized}`, {
      todayOnly: true,
      targetClients: [normalized],
      // Only the self-synced clients have a sync to force; naming any other here
      // would be read by nothing.
      forceSelfSync: refreshOptions.forceSync === true && SELF_SYNCED_CLIENTS.has(normalized) ? [normalized] : null
    });
  }

  return {
    getDiagnostics,
    refreshClient,
    stop,
    tick: (reason = 'manual', tickOptions = {}) => runTick(reason, tickOptions)
  };
}

module.exports = {
  applySessionTimestamps,
  projectIdentity,
  projectPathFromJsonl,
  collectHistoryOnce,
  collectUsageOnce,
  clientActivityDaysFromHistory,
  clientDataDirPresence,
  clientDiagnosticRoots,
  clientSourceChecks,
  clientSourceRoots,
  clientWatchCandidates,
  computePeriodWindows,
  configFingerprint,
  deriveClientHealth,
  deriveClientStatus,
  mergeClientActivityDays,
  wslPeriodsForPreview,
  statusFromSignals,
  decideResolver,
  DEFAULT_HISTORY_INTERVAL_MS,
  HISTORY_INTERVAL_VALUES,
  LIMITS_RESET_BOUNDARY_MAX_TIMER_MS,
  localTodayKey,
  nextLimitsResetBoundary,
  normalizeHistoryIntervalMs,
  sessionTimestampMap,
  locateBundledBinary,
  lookupModelPricing,
  normalizePromaPricing,
  pruneAttemptedResetBoundaries,
  readDownloadedPointer,
  resolvePlatformBinary,
  resolvePromaPricing,
  resetPromaPricingCache,
  resolveWatchUsePolling,
  selfSyncSourceRootsForClients,
  // The process-wide sync throttle this module drives. Exported so a test can
  // read or pin a client's floor directly instead of inferring it from tick
  // timings; the collector never takes a second instance.
  selfSyncThrottle,
  shouldIncludeHistory,
  startCollector,
  tokscaleCommand,
  tokscaleClientFilter,
  TOKSCALE_CLIENT_ALIASES,
  watcherOptions,
  watchIgnoreMatcher,
  watchPathsForClients
};
