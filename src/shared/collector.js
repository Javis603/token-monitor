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
const { emptyPeriod, extractUsageFromTokscale } = require('./usage');
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

function tokscaleBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'tokscale.exe' : 'tokscale';
}

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

function runTokscale({ clients, flags, commandTimeoutMs }) {
  const userArgs = ['--json', '--client', clients, '--group-by', 'client,session,model', ...flags];
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

async function maybeSyncCursor(clientsCsv, logger) {
  const enabled = new Set(normalizeClientsCsv(clientsCsv).split(',').filter(Boolean));
  if (!enabled.has('cursor')) return;
  if (!cursorAuth.readActiveAccount()) return;
  try {
    await cursorAuth.runCursorSync();
  } catch (err) {
    if (typeof logger === 'function') logger(`cursor sync failed: ${err.message}`);
  }
}

async function maybeSyncAntigravity(clientsCsv, logger) {
  const enabled = new Set(normalizeClientsCsv(clientsCsv).split(',').filter(Boolean));
  if (!enabled.has('antigravity')) return;
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

async function collectUsageOnce(options) {
  const { clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion = appVersion(), agentRuntime = '', skipAllTime = false } = options;
  const normalizedClients = normalizeClientsCsv(clients);
  let today = emptyPeriod();
  let month = emptyPeriod();
  let allTime = emptyPeriod();
  if (normalizedClients) {
    await maybeSyncCursor(normalizedClients, options.logger);
    await maybeSyncAntigravity(normalizedClients, options.logger);
    const todayJson = await runTokscale({ clients: normalizedClients, flags: ['--today'], commandTimeoutMs });
    const monthJson = await runTokscale({ clients: normalizedClients, flags: ['--month'], commandTimeoutMs });
    if (!skipAllTime) {
      const allTimeJson = await runTokscale({ clients: normalizedClients, flags: ['--since', allTimeSince], commandTimeoutMs });
      allTime = extractUsageFromTokscale(allTimeJson);
    }
    today = extractUsageFromTokscale(todayJson);
    month = extractUsageFromTokscale(monthJson);
    applySessionTimestamps({ today, month, allTime }, options.homeDir || os.homedir());
  }
  const summary = {
    deviceId,
    hostname: os.hostname(),
    platform: `${process.platform}-${process.arch}`,
    updatedAt: new Date().toISOString(),
    agentVersion,
    ...(agentRuntime ? { agentRuntime } : {}),
    trackedClients: normalizedClients ? normalizedClients.split(',') : [],
    today,
    month,
    allTime
  };
  if (options.limitsEnabled !== false) {
    summary.limits = options.limitsCollector
      ? await options.limitsCollector.snapshot(Boolean(options.forceLimits))
      : await collectLimitsOnce(options);
  }
  return summary;
}

function watchPathsForClients(clientsCsv) {
  const home = os.homedir();
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const candidates = [];
  if (enabled.has('claude')) {
    candidates.push(path.join(home, '.claude', 'projects'));
    candidates.push(path.join(home, '.claude', 'transcripts'));
  }
  if (enabled.has('codex')) {
    candidates.push(path.join(home, '.codex', 'sessions'));
  }
  if (enabled.has('hermes')) {
    candidates.push(process.env.HERMES_HOME || path.join(home, '.hermes'));
  }
  if (enabled.has('opencode')) {
    candidates.push(path.join(home, '.local', 'share', 'opencode'));
  }
  if (enabled.has('openclaw')) {
    candidates.push(path.join(home, '.openclaw', 'agents'));
  }
  if (enabled.has('cursor')) {
    candidates.push(path.join(home, '.config', 'tokscale', 'cursor-cache'));
  }
  if (enabled.has('antigravity')) {
    candidates.push(path.join(home, '.config', 'tokscale', 'antigravity-cache'));
  }
  return candidates.filter((candidate) => { try { return fs.statSync(candidate).isDirectory(); } catch (_) { return false; } });
}

function startCollector(options) {
  const {
    clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion, agentRuntime,
    intervalMs, watchEnabled, watchDebounceMs, limitsEnabled,
    onUpdate, onError, logger
  } = options;
  const log = logger || (() => {});
  const limitsCollector = limitsEnabled !== false ? createLimitsCollector(options) : null;
  let tickInFlight = false;
  let tickPending = false;
  let pendingForceLimits = false;
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
    const skipAllTime = typeof tickOptions.skipAllTime === 'boolean' ? tickOptions.skipAllTime : String(reason).startsWith('watch:');
    try {
      const summary = await collectUsageOnce({
        ...options,
        clients,
        allTimeSince,
        commandTimeoutMs,
        deviceId,
        agentVersion,
        agentRuntime,
        limitsCollector,
        forceLimits: Boolean(tickOptions.forceLimits),
        skipAllTime
      });
      if (stopped) return;
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
      return new Promise((resolve) => pendingWaiters.push(resolve));
    }
    tickInFlight = true;
    try {
      await performTick(reason, tickOptions);
      while (tickPending && !stopped) {
        const forceLimits = pendingForceLimits;
        tickPending = false;
        pendingForceLimits = false;
        await performTick('coalesced', { forceLimits });
      }
    } finally {
      tickInFlight = false;
      if (stopped || !tickPending) resolvePendingWaiters();
    }
  }

  function scheduleTick(reason) {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = null; runTick(reason); }, watchDebounceMs);
  }

  function setupWatchers() {
    if (!watchEnabled) return;
    const dirs = watchPathsForClients(clients);
    if (dirs.length === 0) {
      log('No watchable client data directories found; relying on fallback interval only.');
      return;
    }
    const pollIntervalMs = 10000;
    try {
      const watcher = chokidar.watch(dirs, {
        ignoreInitial: true,
        persistent: true,
        usePolling: true,
        interval: pollIntervalMs,
        binaryInterval: 15000,
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 1000 }
      });
      watcher.on('all', (event, filePath) => scheduleTick(`watch:${event}:${path.basename(filePath || '')}`));
      watcher.on('error', (error) => log(`chokidar error: ${error.message}`));
      watchers.push(watcher);
      for (const dir of dirs) log(`Watching ${dir} (polling ${Math.round(pollIntervalMs / 1000)}s)`);
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

function discoverEarliestActivity(home = os.homedir()) {
  const candidates = [
    path.join(home, '.claude', 'projects'),
    path.join(home, '.claude', 'transcripts'),
    path.join(home, '.codex', 'sessions'),
    process.env.HERMES_HOME,
    path.join(home, '.hermes'),
    path.join(home, '.local', 'share', 'opencode'),
    path.join(home, '.openclaw', 'agents'),
    path.join(home, '.config', 'tokscale', 'cursor-cache'),
    path.join(home, '.config', 'tokscale', 'antigravity-cache'),
  ].filter(Boolean);

  let earliest = null;
  const MAX_PER_DIR = 100;

  for (const dir of candidates) {
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) continue;
      const dirTime = stat.birthtime || stat.mtime;
      if (!earliest || dirTime < earliest) earliest = dirTime;

      const entries = fs.readdirSync(dir);
      const limit = Math.min(entries.length, MAX_PER_DIR);
      for (let i = 0; i < limit; i++) {
        try {
          const entryStat = fs.statSync(path.join(dir, entries[i]));
          const entryTime = entryStat.birthtime || entryStat.mtime;
          if (entryTime < earliest) earliest = entryTime;
        } catch (_) {}
      }
    } catch (_) {}
  }

  return earliest ? earliest.toISOString().slice(0, 10) : null;
}

module.exports = {
  applySessionTimestamps,
  collectUsageOnce,
  decideResolver,
  discoverEarliestActivity,
  sessionTimestampMap,
  locateBundledBinary,
  readDownloadedPointer,
  resolvePlatformBinary,
  startCollector,
  tokscaleCommand,
  watchPathsForClients
};
