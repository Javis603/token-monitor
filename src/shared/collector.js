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
const {
  applyPeriodDelta,
  emptyPeriod,
  extractUsageBundleFromTokscale,
  extractUsageFromTokscale,
  mergePeriods,
  UNATTRIBUTED_USAGE_CLIENT
} = require('./usage');
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

// Cursor/antigravity usage only changes when these syncs run, so re-running them
// on every ordinary tick is pure overhead — each one spawns a subprocess and
// rewrites the tokscale cache (issue #15). Keep them on their own slow cadence.
const SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
// A watch event on an Antigravity IDE source root means the cache is now stale,
// so waiting out the idle cadence would throw away the seconds-level refresh the
// watcher exists for. It gets a shorter floor rather than no floor: `tokscale
// antigravity sync` re-fetches over RPC and rewrites *every* known session
// artifact on every run (upstream keeps `artifactHash`/`lastModifiedMs` in the
// manifest but never short-circuits on them), on top of a `ps` over the whole
// process table and an `lsof` per candidate — so its cost grows with the user's
// session count, and the hot source file is a SQLite WAL that churns for the
// whole turn. Removing the floor entirely would leave issue #15's load half
// unguarded even though its self-trigger half is structurally gone.
const SYNC_SOURCE_EVENT_MIN_INTERVAL_MS = 10 * 1000;
const lastSyncAt = { cursor: 0, antigravity: 0 };

function syncDue(kind, nowMs = Date.now(), minIntervalMs = SYNC_MIN_INTERVAL_MS) {
  const elapsed = nowMs - lastSyncAt[kind];
  // A backwards clock step (an NTP correction, a VM resume) leaves a stamp in
  // the future, and a negative elapsed compares below every floor — including
  // the zero floor, which would refuse the manual refresh outright. The stamp is
  // meaningless once the clock it came from is gone, so treat it as due and
  // re-anchor. Deliberately Date.now rather than a monotonic source: every other
  // deadline in this file is wall-clock too, and one hybrid would be worse than
  // this guard.
  if (elapsed >= 0 && elapsed < minIntervalMs) return false;
  lastSyncAt[kind] = nowMs;
  return true;
}

// 0 when this kind may sync now, otherwise the milliseconds left on its floor.
// A floor that refuses a sync has to hand back a deadline: dropping the request
// instead would strand the change until the fallback interval, which is the
// latency the watcher exists to remove. Same rollback handling as syncDue — a
// stamp from a clock that no longer exists is not something to wait out.
// setTimeout stores its delay in a 32-bit signed int and silently rewrites
// anything larger — or non-finite — to 1ms, turning a "wait a while" into a
// spin. Every delay derived from configuration goes through here.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

function clampTimerDelayMs(value, fallbackMs) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(1, parsed));
}

function msUntilSyncDue(kind, minIntervalMs, nowMs = Date.now()) {
  const elapsed = nowMs - lastSyncAt[kind];
  if (elapsed < 0) return 0;
  return Math.max(0, minIntervalMs - elapsed);
}

// Whether a self-synced client is named by one of the tick's sync selections.
// `true` means all of them (the manual refresh button, where the user is
// explicitly asking for fresh numbers); an array means only those. The
// distinction matters because each sync is its own subprocess: a Cursor sign-in
// has no reason to pay for `tokscale antigravity sync`, and issue #15 is exactly
// what happens when these spawns stop being rationed.
function selfSyncSelected(selection, kind) {
  if (selection === true) return true;
  return Array.isArray(selection) && selection.includes(kind);
}

// How long this kind must have been idle before the tick may sync it. An
// explicit user action waits for nothing; a watch event on a raw source root
// waits out the short floor; everything else keeps the idle cadence.
function selfSyncMinIntervalMs(options, kind) {
  if (selfSyncSelected(options.forceSelfSync, kind)) return 0;
  if (selfSyncSelected(options.sourceSelfSync, kind)) return SYNC_SOURCE_EVENT_MIN_INTERVAL_MS;
  return SYNC_MIN_INTERVAL_MS;
}

function mergeSelfSyncSelection(left, right) {
  if (left === true || right === true) return true;
  const merged = [
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : [])
  ];
  return merged.length ? [...new Set(merged)] : null;
}

async function maybeSyncCursor(clientsCsv, logger, options = {}) {
  const enabled = new Set(normalizeClientsCsv(clientsCsv).split(',').filter(Boolean));
  if (!enabled.has('cursor')) return;
  if (!cursorAuth.readActiveAccount()) return;
  if (!syncDue('cursor', Date.now(), options.minIntervalMs)) return;
  try {
    await cursorAuth.runCursorSync();
  } catch (err) {
    if (typeof logger === 'function') logger(`cursor sync failed: ${err.message}`);
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
  if (!syncDue('antigravity', Date.now(), options.minIntervalMs)) return;
  if (typeof options.run === 'function') {
    await options.run();
    return;
  }
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
  const trackedClientSet = new Set(normalizedClients.split(',').filter(Boolean));
  const targetClients = [...new Set(normalizeClientsCsv(options.targetClients).split(',').filter((client) => trackedClientSet.has(client)))];
  const targetRequested = targetClients.length > 0;
  const targetTokscaleClients = targetClients.filter((client) => client !== 'proma').join(',');
  let today = emptyPeriod();
  let month = emptyPeriod();
  let allTime = emptyPeriod();
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
      minIntervalMs: selfSyncMinIntervalMs(options, 'cursor')
    });
    await maybeSyncAntigravity(syncClients, options.logger, options.homeDir || os.homedir(), {
      minIntervalMs: selfSyncMinIntervalMs(options, 'antigravity'),
      run: options.runAntigravitySync
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
// derivation and (minus the self-synced clients below) the chokidar watch list;
// Antigravity's read-only source roots are added back explicitly below.
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
  // MiMo Code: tokscale 4.8.0 unions the XDG data dir with orca's hook-sandbox
  // copy (scanner.rs `discover_micode_dbs_in_dirs`), and that copy can hold
  // sessions the XDG one is missing. Watch both so an orca-driven install still
  // refreshes in seconds; the orca root only exists on macOS in practice and a
  // missing dir is dropped by watchClientRootsForClients.
  add(
    'micode',
    path.join(home, '.local', 'share', 'mimocode'),
    path.join(home, 'Library', 'Application Support', 'orca', 'mimocode-hooks', 'shared', 'data')
  );
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
  if (hermesRoots.length === 0 && copilotRoots.length === 0 && antigravityRoots.length === 0) return undefined;
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
    return false; // paths outside the bounded Hermes/Copilot/Antigravity roots are never ignored
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
  // antigravity's watch candidate is only the IDE sync cache, so fold the native
  // IDE roots and the separate CLI data dir into the umbrella presence too. A
  // source-only or CLI-only install with no countable usage yet must read
  // `waiting`, not `missing`; the sync cache stays a valid presence signal for
  // snapshots taken before either of the others existed.
  if (Object.prototype.hasOwnProperty.call(presence, 'antigravity')
    && (dirExists(antigravityCliDataDir()) || antigravityDataPresent(os.homedir()))) {
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
    intervalMs, historyIntervalMs = 15 * 60 * 1000, historyEnabled = true, watchEnabled, watchDebounceMs,
    watchTriggersCollection = true, intervalRequiresActivity = false,
    onUpdate, onPreview, onError, logger
  } = options;
  const watchUsePolling = resolveWatchUsePolling(options.watchUsePolling);
  const watchNativeForced = watchPollingEnvOverride() === false;
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
  let pendingActivityRevision = null;
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
  const scheduledWatchClients = new Set();
  let scheduledWatchNeedsFullScan = false;
  // Clients whose raw self-sync source saw an event since the last tick. Kept
  // apart from scheduledWatchClients because the two answer different questions:
  // that set decides which partitions to rescan, this one decides which sync may
  // skip ahead of the idle cadence. An antigravity-cli write lands in the first
  // and not the second.
  const scheduledSourceSyncClients = new Set();
  let sourceSyncCatchUpTimer = null;
  // How long a catch-up waits when it comes due mid-tick. Mirrors the watch
  // debounce so the retry lands after the tick that displaced it, with a beat to
  // fall back on when the configured value is unusable.
  const SOURCE_SYNC_RETRY_MS = clampTimerDelayMs(watchDebounceMs, 1000);
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

  function resolvePendingWaiters() {
    const waiters = pendingWaiters;
    pendingWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async function performTick(reason, tickOptions = {}) {
    const includeHistory = shouldIncludeHistory(Date.now(), lastHistoryAt, historyIntervalMs, Boolean(tickOptions.forceHistory), historyEnabled);
    if (includeHistory) lastHistoryAt = Date.now();
    const todayKey = localTodayKey();
    const requestedTargetClients = [...new Set(normalizeClientsCsv(tickOptions.targetClients).split(',').filter(Boolean))];
    const targetAnchorReady = canTargetTodayPartitions(anchor, requestedTargetClients);
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
        forceSelfSync: tickOptions.forceSelfSync ?? null,
        sourceSelfSync: tickOptions.sourceSelfSync ?? null,
        targetClients: anchored && targetAnchorReady ? requestedTargetClients : [],
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
      await onUpdate?.(summary, reason);
      if (!anchored) setupWatchers();
      if (Number.isFinite(tickOptions.activityRevision)) {
        collectedActivityRevision = Math.max(collectedActivityRevision, tickOptions.activityRevision);
        initialCollectionComplete = true;
      }
      return true;
    } catch (error) {
      if (stopped) return;
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
      pendingActivityRevision = pendingActivityRevision === null
        ? tickActivityRevision
        : Math.max(pendingActivityRevision, tickActivityRevision);
      return new Promise((resolve) => pendingWaiters.push(resolve));
    }
    tickInFlight = true;
    try {
      acknowledgeSourceSync(effectiveTickOptions.forceSelfSync);
      await performTick(reason, effectiveTickOptions);
      while (tickPending && !stopped) {
        const forceHistory = pendingForceHistory;
        const forceSelfSync = pendingForceSelfSync;
        const sourceSelfSync = pendingSourceSelfSync;
        const todayOnly = pendingTodayOnly === true;
        const activityRevision = pendingActivityRevision;
        tickPending = false;
        pendingForceHistory = false;
        pendingForceSelfSync = null;
        pendingSourceSelfSync = null;
        pendingTodayOnly = null;
        pendingActivityRevision = null;
        acknowledgeSourceSync(forceSelfSync);
        await performTick('coalesced', {
          forceHistory,
          forceSelfSync,
          sourceSelfSync,
          todayOnly,
          ...(activityRevision === null ? {} : { activityRevision })
        });
      }
    } finally {
      tickInFlight = false;
      if (stopped || !tickPending) resolvePendingWaiters();
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

  // Drains only the clients whose floor has elapsed. One left behind arms a
  // catch-up for the moment it clears: a source event is a statement that the
  // cache is stale, and that stays true whether or not another event follows, so
  // the floor has to defer the sync rather than discard it. Without this a turn
  // ending inside the floor — two quick turns, or one right after startup —
  // would sit on stale numbers until the fallback interval.
  function takeSourceSyncClients() {
    const due = [];
    let soonestWaitMs = null;
    for (const client of scheduledSourceSyncClients) {
      const waitMs = msUntilSyncDue(client, SYNC_SOURCE_EVENT_MIN_INTERVAL_MS);
      if (waitMs === 0) due.push(client);
      else soonestWaitMs = soonestWaitMs === null ? waitMs : Math.min(soonestWaitMs, waitMs);
    }
    for (const client of due) scheduledSourceSyncClients.delete(client);
    // Recomputed across the whole pending set on every call, so re-arming with
    // it unconditionally always leaves the earliest deadline standing.
    if (soonestWaitMs !== null) armSourceSyncCatchUp(soonestWaitMs);
    return due.length > 0 ? due : null;
  }

  function armSourceSyncCatchUp(delayMs) {
    if (stopped) return;
    if (sourceSyncCatchUpTimer) clearTimeout(sourceSyncCatchUpTimer);
    sourceSyncCatchUpTimer = setTimeout(() => {
      sourceSyncCatchUpTimer = null;
      if (stopped) return;
      // Re-arm instead of queueing, and check before draining: runTick's coalesce
      // state carries the sync selections but not targetClients, so folding into
      // an in-flight tick would widen this into an all-client scan — the cost the
      // targeting exists to avoid, and it could drag an unrelated Cursor sync in
      // with it. Same reason scheduleTick re-arms.
      if (tickInFlight) { armSourceSyncCatchUp(SOURCE_SYNC_RETRY_MS); return; }
      const sourceSelfSync = takeSourceSyncClients();
      if (!sourceSelfSync) return;
      // The tick that carried this event already scanned against the stale
      // cache, so the catch-up has to rescan the same clients behind the sync.
      runTick('source-sync', { todayOnly: true, targetClients: sourceSelfSync, sourceSelfSync });
    }, clampTimerDelayMs(delayMs, SOURCE_SYNC_RETRY_MS));
  }

  // A forced sync satisfies any source event already waiting on the same client:
  // it re-reads the IDE from scratch, so leaving the client pending would spend a
  // second full sync ~one floor later on a change the forced run just picked up —
  // and a manual refresh is exactly what a user reaches for when the number looks
  // stale. Cleared where the tick actually starts rather than where it is queued,
  // since a forced tick waiting behind another has not synced anything yet; an
  // event arriving mid-tick re-enters through the watcher.
  function acknowledgeSourceSync(selection) {
    if (!selection || scheduledSourceSyncClients.size === 0) return;
    for (const client of [...scheduledSourceSyncClients]) {
      if (selfSyncSelected(selection, client)) scheduledSourceSyncClients.delete(client);
    }
    if (scheduledSourceSyncClients.size === 0 && sourceSyncCatchUpTimer) {
      clearTimeout(sourceSyncCatchUpTimer);
      sourceSyncCatchUpTimer = null;
    }
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
        sourceSelfSync: takeSourceSyncClients()
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
          scheduledSourceSyncClients.add(client);
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
      for (const dir of dirs) log(`Watching ${dir} (${usePolling ? 'polling 2s' : 'native events'})`);
    } catch (error) {
      watchedDirectoryKey = null;
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
    const sourceSelfSync = intervalRequiresActivity ? takeSourceSyncClients() : null;
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
    if (sourceSyncCatchUpTimer) { clearTimeout(sourceSyncCatchUpTimer); sourceSyncCatchUpTimer = null; }
    closeWatchers();
    watchedDirectoryKey = null;
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
      forceSelfSync: refreshOptions.forceSync === true ? [normalized] : null
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
  clampTimerDelayMs,
  clientDataDirPresence,
  clientWatchCandidates,
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
  resolveWatchUsePolling,
  selfSyncSourceRootsForClients,
  shouldIncludeHistory,
  SYNC_SOURCE_EVENT_MIN_INTERVAL_MS,
  startCollector,
  tokscaleCommand,
  tokscaleClientFilter,
  TOKSCALE_CLIENT_ALIASES,
  watcherOptions,
  watchIgnoreMatcher,
  watchPathsForClients
};
