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
const { tokscalePackageNameForPlatform, tokscalePlatformKey } = require('./tokscalePlatform');
const { customPricingPath } = require('./tokscaleConfig');
const { applyPeriodDelta, emptyPeriod, extractUsageFromTokscale, mergePeriods } = require('./usage');
const { collectWslUsage: collectWslUsageImpl, emptyWslBundle, probeWslState: probeWslStateImpl } = require('./wslUsage');
const { hermesProfileWatchDirs, resolveHermesHome } = require('./hermesProfiles');
const { mergeHistories, parseGraphResult, normalizeHistory } = require('./history');
const { retainDailyHistory } = require('./dailyHistoryArchive');
const cursorAuth = require('./cursorAuth');
const { findSessionFiles, codexSessionFile } = require('./sessionFiles');
const opencodeSession = require('./opencodeSession');
const { buildPromaHistoryGraph, buildPromaPeriods, collectPromaRows } = require('./promaUsage');
const { hashKey } = require('./hashKey');
const { hostOsInfo, normalizeOsInfo } = require('./osVersion');
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
// id. Unknown ids are dropped silently by tokscale, so this is safe on any 4.x.
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

// Cursor/antigravity usage only changes when these syncs run, so re-running them
// on every tick is pure overhead — each one spawns a subprocess and rewrites the
// tokscale cache (issue #15). Keep them on their own slow cadence.
const SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
const lastSyncAt = { cursor: 0, antigravity: 0 };

function syncDue(kind, nowMs = Date.now(), force = false) {
  if (force) {
    lastSyncAt[kind] = nowMs;
    return true;
  }
  if (nowMs - lastSyncAt[kind] < SYNC_MIN_INTERVAL_MS) return false;
  lastSyncAt[kind] = nowMs;
  return true;
}

async function maybeSyncCursor(clientsCsv, logger, options = {}) {
  const enabled = new Set(normalizeClientsCsv(clientsCsv).split(',').filter(Boolean));
  if (!enabled.has('cursor')) return;
  if (!cursorAuth.readActiveAccount()) return;
  if (!syncDue('cursor', Date.now(), options.force === true)) return;
  try {
    await cursorAuth.runCursorSync();
  } catch (err) {
    if (typeof logger === 'function') logger(`cursor sync failed: ${err.message}`);
  }
}

// tokscale's antigravity sync reads the IDE's native session roots under
// ~/.gemini/; when none exist there is nothing to sync, so don't spawn at all.
const ANTIGRAVITY_DATA_ROOTS = ['antigravity', 'antigravity-ide', 'antigravity-backup'];

function antigravityDataPresent(home) {
  return ANTIGRAVITY_DATA_ROOTS.some((name) => dirExists(path.join(home, '.gemini', name)));
}

async function maybeSyncAntigravity(clientsCsv, logger, home = os.homedir()) {
  const enabled = new Set(normalizeClientsCsv(clientsCsv).split(',').filter(Boolean));
  if (!enabled.has('antigravity')) return;
  if (!antigravityDataPresent(home)) return;
  if (!syncDue('antigravity')) return;
  const { bin, prefixArgs, env } = tokscaleCommand();
  await new Promise((resolve) => {
    const child = spawn(bin, [...prefixArgs, 'antigravity', 'sync'], { env, windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 30000);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && typeof logger === 'function') logger(`antigravity sync exited ${code}: ${stderr.trim().slice(0, 200)}`);
      resolve();
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
        todayKey,
        capDays,
        writeEnabled: options.dailyHistoryArchiveWriteEnabled
      });
      const retained = normalizeHistory(parseGraphResult(retainedGraph), { capDays, todayKey });
      return retained.daily.length || retained.monthly.length ? retained : null;
    } catch (error) {
      if (typeof options.logger === 'function') options.logger(`daily history archive failed: ${error.message}`);
    }
  }
  if (histories.length === 0) return null;
  const history = histories.length === 1 ? histories[0] : mergeHistories(histories, { todayKey });
  return history.daily.length || history.monthly.length ? history : null;
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
  let today = emptyPeriod();
  let month = emptyPeriod();
  let allTime = emptyPeriod();
  const anchor = options.todayOnlyAnchor;
  const anchorUsed = Boolean(anchor && anchor.dateKey === localTodayKey(collectedAt));
  let promaPeriods = null;
  let promaRows = null;
  let promaPricing = null;
  if (normalizedClients) {
    await maybeSyncCursor(tokscaleClients, options.logger, { force: options.forceCursorSync === true });
    await maybeSyncAntigravity(tokscaleClients, options.logger, options.homeDir || os.homedir());
    if (includesProma) {
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
      if (tokscaleClients) {
        const todayJson = await runTokscaleFn({ clients: tokscaleClients, flags: ['--today'], commandTimeoutMs });
        today = extractUsageFromTokscale(todayJson);
      }
      // The persisted anchor contains every Windows-side client, including
      // locally parsed Proma. Include its fresh today usage before deriving
      // broader windows so base + (fresh today - anchor today) stays exact.
      if (promaPeriods) today = mergePeriods(today, promaPeriods.today);
      month = applyPeriodDelta(anchor.month, today, anchor.today);
      allTime = applyPeriodDelta(anchor.allTime, today, anchor.today);
    } else if (tokscaleClients) {
      // Serial on purpose: concurrent scans triple the peak CPU/IO load, which
      // is what let the issue #15 self-trigger loop spike tokscale past 500% CPU.
      const todayJson = await runTokscaleFn({ clients: tokscaleClients, flags: ['--today'], commandTimeoutMs });
      today = extractUsageFromTokscale(todayJson);
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
    }
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
    options.onAnchorComputed({ windowsPeriods, wslBundle, wslStatus });
  }

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
    clientStatus: deriveClientStatus(normalizedClients, allTime),
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
      logger: options.logger
    });
    if (history) summary.history = history;
  }
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
// derivation and (minus the self-synced clients below) the chokidar watch list.
function clientWatchCandidates(clientsCsv) {
  const home = os.homedir();
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const byClient = {};
  const add = (client, ...dirs) => { if (enabled.has(client)) byClient[client] = dirs; };
  add('claude', path.join(home, '.claude', 'projects'), path.join(home, '.claude', 'transcripts'));
  add('codex', path.join(home, '.codex', 'sessions'));
  const hermesHome = resolveHermesHome({ env: process.env, homeDir: home });
  add('hermes', hermesHome, ...hermesProfileWatchDirs(hermesHome));
  add('opencode', path.join(home, '.local', 'share', 'opencode'));
  add('openclaw', path.join(home, '.openclaw', 'agents'));
  add('cursor', path.join(home, '.config', 'tokscale', 'cursor-cache'));
  add('antigravity', path.join(home, '.config', 'tokscale', 'antigravity-cache'));
  add('kimi', path.join(home, '.kimi', 'sessions'), path.join(process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code'), 'sessions'));
  add('qwen', path.join(home, '.qwen', 'projects'));
  add('grok', path.join(process.env.GROK_HOME || path.join(home, '.grok'), 'sessions'));
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
  add('copilot', path.join(home, '.copilot', 'otel'), ...new Set(copilotWorkspaceRoots));
  add('pi', path.join(home, '.pi', 'agent', 'sessions'), path.join(home, '.omp', 'agent', 'sessions'));
  // Zed: tokscale reads the XdgData root on every platform AND the native macOS
  // (Application Support) / Windows (LOCALAPPDATA) roots (see tokscale scanner.rs
  // cfg(macos)/cfg(windows) blocks) — watch all three so native mac/win users get
  // seconds-level refresh and a correct waiting/missing status.
  add(
    'zed',
    path.join(home, '.local', 'share', 'zed', 'threads'),
    path.join(home, 'Library', 'Application Support', 'Zed', 'threads'),
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Zed', 'threads')
  );
  // Kilo Code (VS Code ext): tokscale 3.1.3 only scans the Linux .config root and
  // the .vscode-server (remote) root for KiloCode — unlike Cline, it does NOT scan
  // the native macOS Application Support / Windows %APPDATA% roots. Watching those
  // would be dead watches + a false "waiting" status, so we mirror exactly what
  // tokscale reads. (Native mac/win support pending upstream tokscale.)
  add(
    'kilocode',
    path.join(home, '.config', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks'),
    path.join(home, '.vscode-server', 'data', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks')
  );
  add('micode', path.join(home, '.local', 'share', 'mimocode'));
  add('zcode', path.join(home, '.zcode', 'projects'));
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
  add('codebuddy', path.join(home, '.codebuddy', 'projects'), codebuddyExtLogs);
  // WorkBuddy (Tencent): watch only the detailed session dir (projects/*.jsonl,
  // the preferred source) — not the whole ~/.workbuddy app home, whose config /
  // auth churn would add polling load and spurious ticks with no usage change.
  // A legacy install with only ~/.workbuddy/workbuddy.db (no projects/) still
  // refreshes via the periodic full tick; the WSL marker stays the broader
  // `.workbuddy` so a db-only WSL home is still scanned.
  add('workbuddy', path.join(home, '.workbuddy', 'projects'));
  // Proma — session transcripts at ~/.proma/agent-sessions/*.jsonl
  add('proma', path.join(home, '.proma', 'agent-sessions'));
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
    path.join(home, '.kiro', 'sessions'),
    path.join(home, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent'),
    path.join(home, '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent'),
    path.join(home, '.config', 'kiro', 'User', 'globalStorage', 'kiro.kiroagent'),
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent'),
    path.join(home, '.local', 'share', 'kiro-cli'),
    path.join(home, 'Library', 'Application Support', 'kiro-cli')
  );
  add(
    'cline',
    path.join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'),
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'),
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'),
    path.join(home, '.vscode-server', 'data', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')
  );
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

function watchPathsForClients(clientsCsv) {
  const candidates = [];
  for (const [client, dirs] of Object.entries(clientWatchCandidates(clientsCsv))) {
    if (SELF_SYNCED_CLIENTS.has(client)) continue;
    candidates.push(...dirs);
  }
  // antigravity is self-synced (its IDE cache is written by our sync and must stay
  // watch-excluded), but its CLI data dir is safe to watch (no self-trigger loop)
  // and gives the seconds-level refresh the sync path can't. tokscaleClientFilter
  // pulls the antigravity-cli rows in on the tick.
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (enabled.has('antigravity')) candidates.push(antigravityCliDataDir());
  return [...new Set(candidates.filter(dirExists))];
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

function watchIgnoreMatcher(clientsCsv) {
  const candidates = clientWatchCandidates(clientsCsv);
  const hermesRoots = (candidates.hermes || []).map((dir) => path.resolve(dir));
  const hermesRootSet = new Set(hermesRoots);
  const copilotRoots = (candidates.copilot || [])
    .filter((dir) => path.basename(dir) === 'workspaceStorage')
    .map((dir) => path.resolve(dir));
  if (hermesRoots.length === 0 && copilotRoots.length === 0) return undefined;
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
    return false; // paths outside the bounded Hermes/Copilot roots are never ignored
  };
}

// Whether each tracked client has at least one data directory on disk.
function clientDataDirPresence(clientsCsv) {
  const presence = {};
  const candidates = clientWatchCandidates(clientsCsv);
  for (const [client, dirs] of Object.entries(candidates)) {
    presence[client] = dirs.some(dirExists);
  }
  // workspaceStorage is shared by every VS Code extension. Count it as Copilot
  // presence only when at least one workspace contains the chatSessions source
  // Tokscale actually parses; the broader root is watched solely to catch a new
  // workspace appearing after startup.
  if (Object.prototype.hasOwnProperty.call(presence, 'copilot')) {
    presence.copilot = (candidates.copilot || []).some((dir) => (
      path.basename(dir) === 'workspaceStorage' ? hasCopilotChatSessions(dir) : dirExists(dir)
    ));
  }
  // antigravity's watch candidate is only the IDE sync cache, so fold its separate
  // CLI data dir into the umbrella presence too — otherwise a CLI-only user with no
  // countable usage yet reads `missing` instead of `waiting`.
  if (Object.prototype.hasOwnProperty.call(presence, 'antigravity') && dirExists(antigravityCliDataDir())) {
    presence.antigravity = true;
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

function deriveClientStatus(clientsCsv, allTimePeriod) {
  const clients = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return statusFromSignals(clients, clientDataDirPresence(clientsCsv), allTimePeriod?.clients || {});
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

function configFingerprint(clientsCsv, allTimeSince, projectsEnabled = true) {
  // Deterministic string that captures the config inputs anchor correctness
  // depends on. When this changes, the persisted anchor is invalidated.
  return `${normalizeClientsCsv(clientsCsv)}|${allTimeSince}|projects:${projectsEnabled !== false ? 'on' : 'off'}`;
}

// Force a full scan at least this often even when the anchor is otherwise
// valid, so a long-running session periodically rescans month/allTime
// and picks up any changes that the delta-derivation might miss.
const FULL_SCAN_INTERVAL_MS = 60 * 60 * 1000;

function startCollector(options) {
  const {
    clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion, agentRuntime,
    intervalMs, historyIntervalMs = 15 * 60 * 1000, historyEnabled = true, watchEnabled, watchDebounceMs,
    onUpdate, onPreview, onError, logger
  } = options;
  const deviceOsInfo = options.osInfo === undefined
    ? hostOsInfo()
    : normalizeOsInfo(options.osInfo);
  const log = logger || (() => {});
  let tickInFlight = false;
  let tickPending = false;
  let pendingForceHistory = false;
  let pendingForceCursorSync = false;
  let lastHistoryAt = 0;
  // Last full-scan snapshot; lets watch ticks scan only --today and derive
  // month/allTime exactly (applyPeriodDelta). Reset by every full tick.
  // anchor holds Windows-only periods; wslAnchor is the WSL contribution frozen
  // between full ticks (WSL is not scanned on watch ticks).
  let anchor = null;
  let wslAnchor = null;
  let wslStatusAnchor = null;
  let lastFullScanAt = 0;
  let pendingWaiters = [];
  let debounceTimer = null;
  let intervalTimer = null;
  let stopped = false;
  const watchers = [];

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
          anchor = { dateKey: saved.dateKey, today: saved.today, month: saved.month, allTime: saved.allTime };
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

  function resolvePendingWaiters() {
    const waiters = pendingWaiters;
    pendingWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async function performTick(reason, tickOptions = {}) {
    const includeHistory = shouldIncludeHistory(Date.now(), lastHistoryAt, historyIntervalMs, Boolean(tickOptions.forceHistory), historyEnabled);
    if (includeHistory) lastHistoryAt = Date.now();
    const todayKey = localTodayKey();
    const anchored = Boolean(tickOptions.todayOnly && anchor && anchor.dateKey === todayKey);
    const refreshWsl = Boolean(tickOptions.refreshWsl);
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
        forceCursorSync: Boolean(tickOptions.forceCursorSync),
        todayOnlyAnchor: anchored ? anchor : null,
        wslAnchor: anchored ? wslAnchor : null,
        wslStatus: anchored ? wslStatusAnchor : null,
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
              // Only derive clientStatus when allTime is available; warm
              // scans carry the previous status forward in main.js.
              if (partial.allTime) {
                preview.clientStatus = deriveClientStatus(clients, partial.allTime);
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
      if (!anchored && captured) {
        anchor = { dateKey: todayKey, today: captured.windowsPeriods.today, month: captured.windowsPeriods.month, allTime: captured.windowsPeriods.allTime };
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
      } else if (anchored && refreshWsl && captured) {
        // Interval anchored ticks refresh WSL independently; update the
        // frozen snapshot so subsequent watch ticks see the fresh data.
        wslAnchor = captured.wslBundle;
        wslStatusAnchor = captured.wslStatus || null;
      }
      await onUpdate?.(summary, reason);
    } catch (error) {
      if (stopped) return;
      if (onError) onError(error, reason); else log(`collector tick failed (${reason}): ${error.message}`);
    }
  }

  async function runTick(reason, tickOptions = {}) {
    if (tickInFlight) {
      tickPending = true;
      pendingForceHistory = pendingForceHistory || Boolean(tickOptions.forceHistory);
      pendingForceCursorSync = pendingForceCursorSync || Boolean(tickOptions.forceCursorSync);
      return new Promise((resolve) => pendingWaiters.push(resolve));
    }
    tickInFlight = true;
    try {
      await performTick(reason, tickOptions);
      while (tickPending && !stopped) {
        const forceHistory = pendingForceHistory;
        const forceCursorSync = pendingForceCursorSync;
        tickPending = false;
        pendingForceHistory = false;
        pendingForceCursorSync = false;
        await performTick('coalesced', { forceHistory, forceCursorSync, todayOnly: forceCursorSync });
      }
    } finally {
      tickInFlight = false;
      if (stopped || !tickPending) resolvePendingWaiters();
    }
  }

  function scheduleTick(reason) {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // Re-arm instead of queueing onto the in-flight tick: the coalesce path
      // would re-run immediately on completion, stacking scans back-to-back.
      if (tickInFlight) { scheduleTick(reason); return; }
      runTick(reason, { todayOnly: true });
    }, watchDebounceMs);
  }

  function setupWatchers() {
    if (!watchEnabled) return;
    const dirs = watchPathsForClients(clients);
    if (dirs.length === 0) {
      log('No watchable client data directories found; relying on fallback interval only.');
      return;
    }
    try {
      const ignored = watchIgnoreMatcher(clients);
      const watcher = chokidar.watch(dirs, {
        ignoreInitial: true,
        persistent: true,
        usePolling: true,
        interval: 2000,
        binaryInterval: 5000,
        ...(ignored ? { ignored } : {}),
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 }
      });
      watcher.on('all', (event, filePath) => scheduleTick(`watch:${event}:${path.basename(filePath || '')}`));
      watcher.on('error', (error) => log(`chokidar error: ${error.message}`));
      watchers.push(watcher);
      for (const dir of dirs) log(`Watching ${dir} (polling 2s)`);
    } catch (error) {
      log(`Cannot watch ${dirs.join(', ')}: ${error.message}`);
    }
  }

  function loop() {
    if (stopped) return;
    // Full scan at least once per FULL_SCAN_INTERVAL_MS so the anchor
    // does not drift from reality over a long-running session.
    // lastFullScanAt === 0 means no valid timestamp exists (cold start,
    // unparseable, or future timestamp) — force a full scan immediately.
    const fullScanDue = lastFullScanAt === 0 || Date.now() - lastFullScanAt >= FULL_SCAN_INTERVAL_MS;
    const anchorToday = Boolean(!fullScanDue && anchor && anchor.dateKey === localTodayKey());
    runTick('interval', anchorToday ? { todayOnly: true, refreshWsl: true } : {}).finally(() => {
      if (stopped) return;
      intervalTimer = setTimeout(loop, intervalMs);
    });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (intervalTimer) { clearTimeout(intervalTimer); intervalTimer = null; }
    for (const watcher of watchers) {
      try { watcher.close(); } catch (_) {}
    }
    watchers.length = 0;
  }

  setupWatchers();
  loop();

  function refreshClient(clientId, refreshOptions = {}) {
    const normalized = String(clientId || '').trim().toLowerCase();
    if (normalized !== 'cursor') {
      throw new TypeError(`Unsupported targeted usage client: ${normalized || '(empty)'}`);
    }
    return runTick(`client:${normalized}`, {
      todayOnly: true,
      forceCursorSync: refreshOptions.forceSync === true
    });
  }

  return {
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
  clientDataDirPresence,
  computePeriodWindows,
  configFingerprint,
  deriveClientStatus,
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
  shouldIncludeHistory,
  startCollector,
  tokscaleCommand,
  watchIgnoreMatcher,
  watchPathsForClients
};
