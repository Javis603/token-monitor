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
const { PERIODS, emptyPeriod, extractUsageFromTokscale, normalizePeriod } = require('./usage');
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

function normalizeRequestedPeriods(value) {
  if (value === undefined || value === null || value === '') return PERIODS.slice();
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const period = String(item || '').trim();
    if (!PERIODS.includes(period) || seen.has(period)) continue;
    seen.add(period);
    out.push(period);
  }
  return out.length > 0 ? out : PERIODS.slice();
}

function periodFlags(periodName, allTimeSince) {
  if (periodName === 'today') return ['--today'];
  if (periodName === 'month') return ['--month'];
  return ['--since', allTimeSince];
}

function cachedPeriods(previousPeriods) {
  const periods = {};
  for (const periodName of PERIODS) periods[periodName] = normalizePeriod(previousPeriods?.[periodName]);
  return periods;
}

function hasPeriodUsage(period) {
  return Number(period?.totalTokens || 0) > 0
    || Number(period?.costUsd || 0) > 0
    || Object.keys(period?.clients || {}).length > 0
    || Object.keys(period?.sessions || {}).length > 0;
}

function objectDelta(previousObject, nextObject) {
  return Object.fromEntries(Array.from(new Set([
    ...Object.keys(previousObject || {}),
    ...Object.keys(nextObject || {})
  ])).map((key) => [key, (nextObject?.[key] || 0) - (previousObject?.[key] || 0)]));
}

function nestedObjectDelta(previousObject, nextObject) {
  return Object.fromEntries(Array.from(new Set([
    ...Object.keys(previousObject || {}),
    ...Object.keys(nextObject || {})
  ])).map((key) => [key, objectDelta(previousObject?.[key], nextObject?.[key])]));
}

function deltaHasChanges(delta) {
  if (delta.totalTokens !== 0 || delta.costUsd !== 0) return true;
  const hasObjectChanges = (object) => Object.values(object || {}).some((value) => Number(value || 0) !== 0);
  const hasNestedChanges = (object) => Object.values(object || {}).some((value) => hasObjectChanges(value));
  return hasObjectChanges(delta.clients)
    || hasObjectChanges(delta.clientCosts)
    || hasObjectChanges(delta.models)
    || hasObjectChanges(delta.modelCosts)
    || hasNestedChanges(delta.clientModels)
    || hasNestedChanges(delta.clientModelCosts)
    || Object.values(delta.sessions || {}).some((session) => deltaHasChanges(session));
}

// The period windows are nested (today -> month -> allTime), so a source delta can
// be projected upward when both old and new source snapshots are known.
function periodDelta(previous, next) {
  const previousPeriod = normalizePeriod(previous);
  const nextPeriod = normalizePeriod(next);
  return {
    totalTokens: nextPeriod.totalTokens - previousPeriod.totalTokens,
    costUsd: nextPeriod.costUsd - previousPeriod.costUsd,
    clients: objectDelta(previousPeriod.clients, nextPeriod.clients),
    clientCosts: objectDelta(previousPeriod.clientCosts, nextPeriod.clientCosts),
    models: objectDelta(previousPeriod.models, nextPeriod.models),
    modelCosts: objectDelta(previousPeriod.modelCosts, nextPeriod.modelCosts),
    clientModels: nestedObjectDelta(previousPeriod.clientModels, nextPeriod.clientModels),
    clientModelCosts: nestedObjectDelta(previousPeriod.clientModelCosts, nextPeriod.clientModelCosts),
    sessions: Object.fromEntries(Array.from(new Set([
      ...Object.keys(previousPeriod.sessions || {}),
      ...Object.keys(nextPeriod.sessions || {})
    ])).map((key) => [key, sessionDelta(previousPeriod.sessions?.[key], nextPeriod.sessions?.[key])]))
  };
}

function sessionDelta(previous, next) {
  const previousSession = previous || {};
  const nextSession = next || {};
  return {
    client: nextSession.client || previousSession.client || '',
    sessionId: nextSession.sessionId || previousSession.sessionId || '',
    totalTokens: Number(nextSession.totalTokens || 0) - Number(previousSession.totalTokens || 0),
    costUsd: Number(nextSession.costUsd || 0) - Number(previousSession.costUsd || 0),
    messageCount: Number(nextSession.messageCount || 0) - Number(previousSession.messageCount || 0),
    inputTokens: Number(nextSession.inputTokens || 0) - Number(previousSession.inputTokens || 0),
    outputTokens: Number(nextSession.outputTokens || 0) - Number(previousSession.outputTokens || 0),
    cacheReadTokens: Number(nextSession.cacheReadTokens || 0) - Number(previousSession.cacheReadTokens || 0),
    cacheWriteTokens: Number(nextSession.cacheWriteTokens || 0) - Number(previousSession.cacheWriteTokens || 0),
    reasoningTokens: Number(nextSession.reasoningTokens || 0) - Number(previousSession.reasoningTokens || 0),
    startedAt: nextSession.startedAt || previousSession.startedAt || '',
    lastUsedAt: nextSession.lastUsedAt || previousSession.lastUsedAt || '',
    models: objectDelta(previousSession.models, nextSession.models),
    modelCosts: objectDelta(previousSession.modelCosts, nextSession.modelCosts),
    providers: objectDelta(previousSession.providers, nextSession.providers)
  };
}

function addPositiveDelta(object, key, value, round = true) {
  const nextValue = Math.max(0, (object[key] || 0) + value);
  const normalizedValue = round ? Math.round(nextValue) : nextValue;
  if (normalizedValue > 0) object[key] = normalizedValue; else delete object[key];
}

function addNestedPositiveDelta(object, outerKey, innerKey, value, round = true) {
  if (!object[outerKey]) object[outerKey] = {};
  addPositiveDelta(object[outerKey], innerKey, value, round);
  if (Object.keys(object[outerKey]).length === 0) delete object[outerKey];
}

function applySessionDeltaEstimate(sessions, key, delta) {
  const existing = sessions[key] || {
    client: delta.client,
    sessionId: delta.sessionId,
    totalTokens: 0,
    costUsd: 0,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    startedAt: '',
    lastUsedAt: '',
    models: {},
    modelCosts: {},
    providers: {}
  };
  existing.client = existing.client || delta.client;
  existing.sessionId = existing.sessionId || delta.sessionId;
  for (const keyName of ['totalTokens', 'messageCount', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    existing[keyName] = Math.max(0, Math.round(Number(existing[keyName] || 0) + Number(delta[keyName] || 0)));
  }
  existing.costUsd = Math.max(0, Number(existing.costUsd || 0) + Number(delta.costUsd || 0));
  if (delta.startedAt && (!existing.startedAt || Date.parse(delta.startedAt) < Date.parse(existing.startedAt || 0))) existing.startedAt = delta.startedAt;
  if (delta.lastUsedAt && (!existing.lastUsedAt || Date.parse(delta.lastUsedAt) > Date.parse(existing.lastUsedAt || 0))) existing.lastUsedAt = delta.lastUsedAt;
  for (const [model, value] of Object.entries(delta.models || {})) addPositiveDelta(existing.models, model, value);
  for (const [model, value] of Object.entries(delta.modelCosts || {})) addPositiveDelta(existing.modelCosts, model, value, false);
  for (const [provider, value] of Object.entries(delta.providers || {})) addPositiveDelta(existing.providers, provider, value);
  if (existing.totalTokens > 0 || existing.costUsd > 0) sessions[key] = existing; else delete sessions[key];
}

function applyPeriodDeltaEstimate(period, delta) {
  const next = normalizePeriod(period);
  next.totalTokens = Math.max(0, Math.round(next.totalTokens + delta.totalTokens));
  next.costUsd = Math.max(0, next.costUsd + delta.costUsd);
  for (const [client, value] of Object.entries(delta.clients || {})) {
    addPositiveDelta(next.clients, client, value);
  }
  for (const [client, value] of Object.entries(delta.clientCosts || {})) {
    addPositiveDelta(next.clientCosts, client, value, false);
  }
  for (const [model, value] of Object.entries(delta.models || {})) {
    addPositiveDelta(next.models, model, value);
  }
  for (const [model, value] of Object.entries(delta.modelCosts || {})) {
    addPositiveDelta(next.modelCosts, model, value, false);
  }
  for (const [client, models] of Object.entries(delta.clientModels || {})) {
    for (const [model, value] of Object.entries(models || {})) {
      addNestedPositiveDelta(next.clientModels, client, model, value);
    }
  }
  for (const [client, models] of Object.entries(delta.clientModelCosts || {})) {
    for (const [model, value] of Object.entries(models || {})) {
      addNestedPositiveDelta(next.clientModelCosts, client, model, value, false);
    }
  }
  for (const [key, value] of Object.entries(delta.sessions || {})) {
    applySessionDeltaEstimate(next.sessions, key, value);
  }
  return next;
}

function estimateBroaderPeriods(previousPeriods, nextPeriods, refreshedNames, loadedPeriods, logger) {
  const estimatedNames = [];
  if (!previousPeriods) return estimatedNames;
  const sources = [
    { source: 'today', targets: ['month', 'allTime'] },
    { source: 'month', targets: ['allTime'] }
  ];
  for (const { source, targets } of sources) {
    if (!refreshedNames.includes(source)) continue;
    const sourceLoaded = loadedPeriods?.has(source) || hasPeriodUsage(previousPeriods[source]);
    // Without a source baseline, a first refresh would look like a giant delta.
    if (!sourceLoaded) continue;
    const nextTargets = targets.filter((periodName) => !refreshedNames.includes(periodName) && hasPeriodUsage(nextPeriods[periodName]));
    if (nextTargets.length === 0) continue;
    const delta = periodDelta(previousPeriods[source], nextPeriods[source]);
    if (!deltaHasChanges(delta)) continue;
    if (delta.totalTokens < 0 || delta.costUsd < 0) {
      logger?.(`Usage estimate: ${source} delta decreased tokens=${delta.totalTokens} cost=${delta.costUsd.toFixed(6)}`);
    }
    for (const periodName of nextTargets) {
      nextPeriods[periodName] = { ...applyPeriodDeltaEstimate(nextPeriods[periodName], delta), estimated: true };
      estimatedNames.push(periodName);
    }
    logger?.(`Usage estimate: applied ${source} delta tokens=${delta.totalTokens} cost=${delta.costUsd.toFixed(6)} to ${nextTargets.join(',')}`);
  }
  return estimatedNames;
}

function isoFromDate(value) {
  const date = value instanceof Date ? value : new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function localDateKeys(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value || '');
  if (Number.isNaN(date.getTime())) return { day: '', month: '' };
  // Match the desktop UI's local calendar semantics for Today/Month boundaries.
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return { day: `${year}-${month}-${day}`, month: `${year}-${month}` };
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
  const { clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion = appVersion(), agentRuntime = '' } = options;
  const normalizedClients = normalizeClientsCsv(clients);
  const requestedPeriods = normalizeRequestedPeriods(options.periods);
  const periods = normalizedClients ? cachedPeriods(options.previousPeriods) : cachedPeriods(null);
  if (normalizedClients) {
    const refreshedPeriods = {};
    const loadedPeriods = options.loadedPeriods instanceof Set ? options.loadedPeriods : new Set(options.loadedPeriods || []);
    const dirtyPeriods = options.dirtyPeriods instanceof Set ? options.dirtyPeriods : new Set(options.dirtyPeriods || []);
    const onlyIfDirty = Boolean(options.onlyIfDirty);
    const periodsToRefresh = [];
    const refreshedNames = [];
    const cachedNames = [];
    for (const periodName of requestedPeriods) {
      const periodLoaded = loadedPeriods.has(periodName);
      if (onlyIfDirty && periodLoaded && !dirtyPeriods.has(periodName)) {
        cachedNames.push(periodName);
        continue;
      }
      periodsToRefresh.push(periodName);
    }
    if (periodsToRefresh.length > 0) {
      await maybeSyncCursor(normalizedClients, options.logger);
      await maybeSyncAntigravity(normalizedClients, options.logger);
    }
    for (const periodName of periodsToRefresh) {
      const startedAt = Date.now();
      const json = await runTokscale({ clients: normalizedClients, flags: periodFlags(periodName, allTimeSince), commandTimeoutMs });
      periods[periodName] = extractUsageFromTokscale(json);
      refreshedPeriods[periodName] = periods[periodName];
      refreshedNames.push(periodName);
      if (options.logger) {
        options.logger(`Usage period ${periodName}: refreshed in ${Date.now() - startedAt}ms tokens=${periods[periodName].totalTokens}`);
      }
    }
    if (options.logger && (refreshedNames.length > 0 || cachedNames.length > 0)) {
      const parts = [];
      if (refreshedNames.length > 0) parts.push(`refreshed=${refreshedNames.join(',')}`);
      if (cachedNames.length > 0) parts.push(`cache-hit=${cachedNames.join(',')}`);
      options.logger(`Usage periods: ${parts.join(' ')}`);
    }
    const estimatedNames = estimateBroaderPeriods(options.previousPeriods, periods, refreshedNames, loadedPeriods, options.logger);
    const timestampPeriods = { ...refreshedPeriods };
    // Estimated periods may now contain real session deltas from the refreshed source period.
    for (const periodName of estimatedNames) timestampPeriods[periodName] = periods[periodName];
    applySessionTimestamps(timestampPeriods, options.homeDir || os.homedir());
  }
  const summary = {
    deviceId,
    hostname: os.hostname(),
    platform: `${process.platform}-${process.arch}`,
    updatedAt: new Date().toISOString(),
    agentVersion,
    ...(agentRuntime ? { agentRuntime } : {}),
    trackedClients: normalizedClients ? normalizedClients.split(',') : [],
    today: periods.today || emptyPeriod(),
    month: periods.month || emptyPeriod(),
    allTime: periods.allTime || emptyPeriod()
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
    intervalMs, watchEnabled, watchDebounceMs, watchCooldownMs = 5_000, limitsEnabled,
    onUpdate, onError, logger
  } = options;
  const log = logger || (() => {});
  const limitsCollector = limitsEnabled !== false ? createLimitsCollector(options) : null;
  let tickInFlight = false;
  let tickPending = false;
  let pendingForceLimits = false;
  const pendingPeriods = new Set();
  let pendingOnlyIfDirty = true;
  let pendingWaiters = [];
  let debounceTimer = null;
  let intervalTimer = null;
  let stopped = false;
  const watchers = [];
  let lastPeriods = null;
  let lastUsageTickFinishedAt = 0;
  const loadedPeriods = new Set();
  const dirtyPeriods = new Set(PERIODS);
  let dirtyVersion = 0;
  const periodDirtyVersions = new Map(PERIODS.map((periodName) => [periodName, dirtyVersion]));
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const nowMs = () => {
    const value = now();
    const date = value instanceof Date ? value : new Date(value || '');
    return Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  };
  let lastDateKeys = null;

  function resolvePendingWaiters() {
    const waiters = pendingWaiters;
    pendingWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function requestedPeriodsForTick(tickOptions = {}) {
    return normalizeRequestedPeriods(tickOptions.periods || options.periods);
  }

  function tickOptionsWithDateBoundary(tickOptions = {}) {
    const currentDateKeys = localDateKeys(now());
    const crossedBoundary = lastDateKeys && (
      lastDateKeys.day !== currentDateKeys.day ||
      lastDateKeys.month !== currentDateKeys.month
    );
    lastDateKeys = currentDateKeys;
    if (!crossedBoundary) return tickOptions;
    log(`Usage date boundary crossed: ${currentDateKeys.day}; refreshing all periods`);
    markAllPeriodsDirty();
    return { ...tickOptions, periods: PERIODS };
  }

  function addPendingTick(tickOptions = {}) {
    tickPending = true;
    pendingForceLimits = pendingForceLimits || Boolean(tickOptions.forceLimits);
    for (const periodName of requestedPeriodsForTick(tickOptions)) pendingPeriods.add(periodName);
    // Any explicit non-dirty refresh in the batch should make the coalesced tick force-refresh.
    pendingOnlyIfDirty = pendingOnlyIfDirty && Boolean(tickOptions.onlyIfDirty);
  }

  function takePendingTickOptions() {
    const forceLimits = pendingForceLimits;
    const periods = pendingPeriods.size > 0 ? Array.from(pendingPeriods) : undefined;
    const onlyIfDirty = pendingOnlyIfDirty;
    tickPending = false;
    pendingForceLimits = false;
    pendingPeriods.clear();
    pendingOnlyIfDirty = true;
    return { forceLimits, periods, onlyIfDirty };
  }

  function markAllPeriodsDirty() {
    dirtyVersion += 1;
    for (const periodName of PERIODS) {
      dirtyPeriods.add(periodName);
      periodDirtyVersions.set(periodName, dirtyVersion);
    }
  }

  function scheduleDirtyRefresh(reason, delayMs, cooldownMs) {
    // This keeps exactly one delayed watch refresh alive; re-entry replaces the timer.
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const cooldownRemaining = Math.max(0, cooldownMs - (nowMs() - lastUsageTickFinishedAt));
      if (tickInFlight || cooldownRemaining > 0) {
        const nextDelayMs = Math.max(watchDebounceMs, cooldownRemaining);
        log(`Usage refresh delayed (${reason}); next watch refresh in ${nextDelayMs}ms`);
        scheduleDirtyRefresh(reason, nextDelayMs, cooldownMs);
        return;
      }
      runTick(reason);
    }, delayMs);
  }

  async function performTick(reason, tickOptions = {}) {
    tickOptions = tickOptionsWithDateBoundary(tickOptions);
    const requestedPeriods = requestedPeriodsForTick(tickOptions);
    const startedDirtyVersions = new Map(requestedPeriods.map((periodName) => [
      periodName,
      periodDirtyVersions.get(periodName) || 0
    ]));
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
        periods: requestedPeriods,
        previousPeriods: lastPeriods,
        loadedPeriods,
        dirtyPeriods,
        onlyIfDirty: Boolean(tickOptions.onlyIfDirty)
      });
      if (stopped) return;
      lastPeriods = { today: summary.today, month: summary.month, allTime: summary.allTime };
      for (const periodName of requestedPeriods) {
        loadedPeriods.add(periodName);
        // If another watch event arrived mid-refresh, keep the dirty bit for the next tick.
        if ((periodDirtyVersions.get(periodName) || 0) === (startedDirtyVersions.get(periodName) || 0)) {
          dirtyPeriods.delete(periodName);
        }
      }
      await onUpdate?.(summary, reason);
    } catch (error) {
      if (stopped) return;
      if (onError) onError(error, reason); else log(`collector tick failed (${reason}): ${error.message}`);
    } finally {
      lastUsageTickFinishedAt = nowMs();
    }
  }

  async function runTick(reason, tickOptions = {}) {
    if (tickInFlight) {
      addPendingTick(tickOptions);
      return new Promise((resolve) => pendingWaiters.push(resolve));
    }
    tickInFlight = true;
    try {
      await performTick(reason, tickOptions);
      while (tickPending && !stopped) {
        await performTick('coalesced', takePendingTickOptions());
      }
    } finally {
      tickInFlight = false;
      if (stopped || !tickPending) resolvePendingWaiters();
    }
  }

  function scheduleTick(reason) {
    if (stopped) return;
    markAllPeriodsDirty();
    const cooldownMs = Number(watchCooldownMs || 0);
    const elapsedSinceFinished = nowMs() - lastUsageTickFinishedAt;
    const delayMs = Math.max(watchDebounceMs, Math.max(0, cooldownMs - elapsedSinceFinished));
    log(`Usage cache dirty: ${PERIODS.join(',')} (${reason}); next watch refresh in ${delayMs}ms`);
    scheduleDirtyRefresh(reason, delayMs, cooldownMs);
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

  let firstLoopTick = true;

  function loop() {
    if (stopped) return;
    const tickOptions = firstLoopTick && options.initialPeriods ? { periods: options.initialPeriods } : {};
    firstLoopTick = false;
    runTick('interval', tickOptions).finally(() => {
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
  collectUsageOnce,
  decideResolver,
  sessionTimestampMap,
  locateBundledBinary,
  readDownloadedPointer,
  resolvePlatformBinary,
  startCollector,
  tokscaleCommand,
  watchPathsForClients
};
