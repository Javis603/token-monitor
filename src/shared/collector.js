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
const { applyPeriodDelta, emptyPeriod, extractUsageFromTokscale, mergePeriods } = require('./usage');
const { collectWslUsage: collectWslUsageImpl, emptyWslBundle } = require('./wslUsage');
const { parseGraphResult, normalizeHistory } = require('./history');
const { collectLimitsOnce, createLimitsCollector } = require('./limitCollector');
const cursorAuth = require('./cursorAuth');
const { findSessionFiles, codexSessionFile } = require('./sessionFiles');
const opencodeSession = require('./opencodeSession');

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

function runTokscale({ clients, flags, commandTimeoutMs }) {
  return spawnTokscaleJson(['--json', '--client', clients, '--group-by', 'client,session,model', ...flags], commandTimeoutMs);
}

function runTokscaleGraph({ clients, commandTimeoutMs }) {
  return spawnTokscaleJson(['graph', '--client', clients, '--no-spinner'], commandTimeoutMs);
}

function lookupModelPricing(modelId, commandTimeoutMs = 15000) {
  const id = String(modelId || '').trim();
  if (!id) return Promise.reject(new Error('lookupModelPricing: modelId is required'));
  return spawnTokscaleJson(['pricing', id, '--json', '--no-spinner'], commandTimeoutMs);
}

function localTodayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

function lastJsonlTimestamp(filePath) {
  const tail = readFileTail(filePath);
  const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const timestamp = timestampFromJsonLine(lines[index]);
    if (timestamp) return timestamp;
  }
  try { return fs.statSync(filePath).mtime.toISOString(); } catch (_) { return ''; }
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
  const byClient = new Map();
  for (const ref of refs.values()) {
    if (!byClient.has(ref.client)) byClient.set(ref.client, new Set());
    byClient.get(ref.client).add(ref.sessionId);
  }

  const metadata = new Map();
  const applyFile = (client, sessionId, filePath) => {
    const startedAt = timestampFromSessionId(sessionId);
    const lastUsedAt = lastJsonlTimestamp(filePath) || startedAt;
    metadata.set(`${client}:${sessionId}`, { startedAt, lastUsedAt });
  };

  // OpenCode has no transcript file — its timestamps come from the opencode.db `session` table.
  const opencodeIds = byClient.get('opencode') || new Set();
  if (opencodeIds.size > 0) {
    const readOpencodeMeta = deps.readOpencodeMeta || ((ids) => opencodeSession.readSessionMeta(ids));
    for (const [sessionId, meta] of readOpencodeMeta(opencodeIds)) {
      const startedAt = meta.startedAt || '';
      const lastUsedAt = meta.lastUsedAt || startedAt;
      if (startedAt || lastUsedAt) metadata.set(`opencode:${sessionId}`, { startedAt, lastUsedAt });
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
    if (metadata.has(key)) continue;
    const timestamp = timestampFromSessionId(ref.sessionId);
    if (timestamp) metadata.set(key, { startedAt: timestamp, lastUsedAt: timestamp });
  }

  return metadata;
}

function applySessionTimestamps(periods, home, deps = {}) {
  const metadata = sessionTimestampMap(periods, home, deps);
  for (const period of Object.values(periods || {})) {
    for (const [key, session] of Object.entries(period?.sessions || {})) {
      const meta = metadata.get(key);
      if (!meta) continue;
      if (meta.startedAt && (!session.startedAt || Date.parse(meta.startedAt) < Date.parse(session.startedAt))) session.startedAt = meta.startedAt;
      if (meta.lastUsedAt && (!session.lastUsedAt || Date.parse(meta.lastUsedAt) > Date.parse(session.lastUsedAt))) session.lastUsedAt = meta.lastUsedAt;
    }
  }
}

// Cursor/antigravity usage only changes when these syncs run, so re-running them
// on every tick is pure overhead — each one spawns a subprocess and rewrites the
// tokscale cache (issue #15). Keep them on their own slow cadence.
const SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
const lastSyncAt = { cursor: 0, antigravity: 0 };

function syncDue(kind, nowMs = Date.now()) {
  if (nowMs - lastSyncAt[kind] < SYNC_MIN_INTERVAL_MS) return false;
  lastSyncAt[kind] = nowMs;
  return true;
}

async function maybeSyncCursor(clientsCsv, logger) {
  const enabled = new Set(normalizeClientsCsv(clientsCsv).split(',').filter(Boolean));
  if (!enabled.has('cursor')) return;
  if (!cursorAuth.readActiveAccount()) return;
  if (!syncDue('cursor')) return;
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

async function collectHistoryOnce(options) {
  const clients = normalizeClientsCsv(options.clients);
  if (options.historyEnabled === false) return null;
  if (!clients) return null;
  const runGraph = options.runGraph || runTokscaleGraph;
  const capDays = Number.isFinite(options.capDays) ? options.capDays : HISTORY_CAP_DAYS;
  const todayKey = options.todayKey || localTodayKey();
  try {
    const graphJson = await runGraph({ clients, commandTimeoutMs: options.commandTimeoutMs || HISTORY_TIMEOUT_MS });
    const history = normalizeHistory(parseGraphResult(graphJson), { capDays, todayKey });
    return history.daily.length || history.monthly.length ? history : null;
  } catch (error) {
    if (typeof options.logger === 'function') options.logger(`tokscale graph failed: ${error.message}`);
    return null;
  }
}

function shouldIncludeHistory(nowMs, lastHistoryAtMs, historyIntervalMs, force, enabled = true) {
  if (enabled === false) return false;
  if (force) return true;
  return nowMs - (lastHistoryAtMs || 0) >= historyIntervalMs;
}
async function collectUsageOnce(options) {
  const { clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion = appVersion(), agentRuntime = '' } = options;
  const runTokscaleFn = options.runTokscale || runTokscale;
  const collectWsl = options.collectWslUsage || collectWslUsageImpl;
  const normalizedClients = normalizeClientsCsv(clients);
  let today = emptyPeriod();
  let month = emptyPeriod();
  let allTime = emptyPeriod();
  const anchor = options.todayOnlyAnchor;
  const anchorUsed = Boolean(anchor && anchor.dateKey === localTodayKey());
  if (normalizedClients) {
    await maybeSyncCursor(normalizedClients, options.logger);
    await maybeSyncAntigravity(normalizedClients, options.logger, options.homeDir || os.homedir());
    if (anchorUsed) {
      // Anchored tick (watch-triggered): every tokscale period scan costs the
      // same full load + filter, so scan only --today and update the broader
      // windows exactly via applyPeriodDelta — one spawn instead of three.
      const todayJson = await runTokscaleFn({ clients: normalizedClients, flags: ['--today'], commandTimeoutMs });
      today = extractUsageFromTokscale(todayJson);
      month = applyPeriodDelta(anchor.month, today, anchor.today);
      allTime = applyPeriodDelta(anchor.allTime, today, anchor.today);
    } else {
      // Serial on purpose: concurrent scans triple the peak CPU/IO load, which
      // is what let the issue #15 self-trigger loop spike tokscale past 500% CPU.
      const todayJson = await runTokscaleFn({ clients: normalizedClients, flags: ['--today'], commandTimeoutMs });
      const monthJson = await runTokscaleFn({ clients: normalizedClients, flags: ['--month'], commandTimeoutMs });
      const allTimeJson = await runTokscaleFn({ clients: normalizedClients, flags: ['--since', allTimeSince], commandTimeoutMs });
      today = extractUsageFromTokscale(todayJson);
      month = extractUsageFromTokscale(monthJson);
      allTime = extractUsageFromTokscale(allTimeJson);
    }
    applySessionTimestamps({ today, month, allTime }, options.homeDir || os.homedir());
  }

  // WSL contribution (Windows only; no-op elsewhere). Full tick scans running WSL
  // homes; watch tick reuses the frozen snapshot so the Windows-only delta anchor
  // above stays exact (issue #15). Merged before deriveClientStatus so a client
  // that only exists inside WSL still reports as active.
  const windowsPeriods = { today, month, allTime };
  let wslBundle = options.wslAnchor || emptyWslBundle();
  if (normalizedClients && !anchorUsed) {
    wslBundle = await collectWsl({
      clients: normalizedClients,
      allTimeSince,
      commandTimeoutMs,
      runTokscale: runTokscaleFn,
      logger: options.logger
    });
  }
  today = mergePeriods(windowsPeriods.today, wslBundle.today);
  month = mergePeriods(windowsPeriods.month, wslBundle.month);
  allTime = mergePeriods(windowsPeriods.allTime, wslBundle.allTime);
  if (typeof options.onAnchorComputed === 'function') {
    options.onAnchorComputed({ windowsPeriods, wslBundle });
  }

  const summary = {
    deviceId,
    hostname: os.hostname(),
    platform: `${process.platform}-${process.arch}`,
    updatedAt: new Date().toISOString(),
    agentVersion,
    ...(agentRuntime ? { agentRuntime } : {}),
    trackedClients: normalizedClients ? normalizedClients.split(',') : [],
    clientStatus: deriveClientStatus(normalizedClients, allTime),
    today,
    month,
    allTime
  };
  if (options.historyEnabled === false) {
    summary.history = null;
  } else if (options.includeHistory) {
    const history = await collectHistoryOnce({
      clients: normalizedClients,
      historyEnabled: options.historyEnabled,
      commandTimeoutMs: options.historyTimeoutMs,
      capDays: options.historyCapDays,
      todayKey: localTodayKey(),
      runGraph: options.runGraph,
      logger: options.logger
    });
    if (history) summary.history = history;
  }
  if (options.limitsEnabled !== false) {
    summary.limits = options.limitsCollector
      ? await options.limitsCollector.snapshot(Boolean(options.forceLimits))
      : await collectLimitsOnce(options);
  }
  return summary;
}

function dirExists(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; }
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
  add('hermes', process.env.HERMES_HOME || path.join(home, '.hermes'));
  add('opencode', path.join(home, '.local', 'share', 'opencode'));
  add('openclaw', path.join(home, '.openclaw', 'agents'));
  add('cursor', path.join(home, '.config', 'tokscale', 'cursor-cache'));
  add('antigravity', path.join(home, '.config', 'tokscale', 'antigravity-cache'));
  add('kimi', path.join(home, '.kimi', 'sessions'), path.join(process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code'), 'sessions'));
  add('qwen', path.join(home, '.qwen', 'projects'));
  add('grok', path.join(process.env.GROK_HOME || path.join(home, '.grok'), 'sessions'));
  add('copilot', path.join(home, '.copilot', 'otel'));
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

function watchPathsForClients(clientsCsv) {
  const candidates = [];
  for (const [client, dirs] of Object.entries(clientWatchCandidates(clientsCsv))) {
    if (SELF_SYNCED_CLIENTS.has(client)) continue;
    candidates.push(...dirs);
  }
  return candidates.filter(dirExists);
}

// Whether each tracked client has at least one data directory on disk.
function clientDataDirPresence(clientsCsv) {
  const presence = {};
  for (const [client, dirs] of Object.entries(clientWatchCandidates(clientsCsv))) {
    presence[client] = dirs.some(dirExists);
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

function startCollector(options) {
  const {
    clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion, agentRuntime,
    intervalMs, historyIntervalMs = 15 * 60 * 1000, historyEnabled = true, watchEnabled, watchDebounceMs, limitsEnabled,
    onUpdate, onError, logger
  } = options;
  const log = logger || (() => {});
  const limitsCollector = limitsEnabled !== false ? createLimitsCollector(options) : null;
  let tickInFlight = false;
  let tickPending = false;
  let pendingForceLimits = false;
  let pendingForceHistory = false;
  let lastHistoryAt = 0;
  // Last full-scan snapshot; lets watch ticks scan only --today and derive
  // month/allTime exactly (applyPeriodDelta). Reset by every full tick.
  // anchor holds Windows-only periods; wslAnchor is the WSL contribution frozen
  // between full ticks (WSL is not scanned on watch ticks).
  let anchor = null;
  let wslAnchor = null;
  let pendingWaiters = [];
  let debounceTimer = null;
  let intervalTimer = null;
  let stopped = false;
  const watchers = [];

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
        limitsCollector,
        includeHistory,
        forceLimits: Boolean(tickOptions.forceLimits),
        todayOnlyAnchor: anchored ? anchor : null,
        wslAnchor: anchored ? wslAnchor : null,
        onAnchorComputed: (x) => { captured = x; }
      });
      if (stopped) return;
      if (!anchored && captured) {
        anchor = { dateKey: todayKey, today: captured.windowsPeriods.today, month: captured.windowsPeriods.month, allTime: captured.windowsPeriods.allTime };
        wslAnchor = captured.wslBundle;
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
      pendingForceLimits = pendingForceLimits || Boolean(tickOptions.forceLimits);
      pendingForceHistory = pendingForceHistory || Boolean(tickOptions.forceHistory);
      return new Promise((resolve) => pendingWaiters.push(resolve));
    }
    tickInFlight = true;
    try {
      await performTick(reason, tickOptions);
      while (tickPending && !stopped) {
        const forceLimits = pendingForceLimits;
        const forceHistory = pendingForceHistory;
        tickPending = false;
        pendingForceLimits = false;
        pendingForceHistory = false;
        await performTick('coalesced', { forceLimits, forceHistory });
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
      const watcher = chokidar.watch(dirs, {
        ignoreInitial: true,
        persistent: true,
        usePolling: true,
        interval: 2000,
        binaryInterval: 5000,
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
    runTick('interval').finally(() => {
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

  return { stop, tick: (reason = 'manual', tickOptions = {}) => runTick(reason, tickOptions) };
}

module.exports = {
  applySessionTimestamps,
  collectHistoryOnce,
  collectUsageOnce,
  clientDataDirPresence,
  deriveClientStatus,
  statusFromSignals,
  decideResolver,
  localTodayKey,
  sessionTimestampMap,
  locateBundledBinary,
  lookupModelPricing,
  readDownloadedPointer,
  resolvePlatformBinary,
  shouldIncludeHistory,
  startCollector,
  tokscaleCommand,
  watchPathsForClients
};
