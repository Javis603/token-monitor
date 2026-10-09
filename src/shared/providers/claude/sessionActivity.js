'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { processStarts } = require('../../processStarts');
const { resolveClaudeConfigDir, claudeSessionRoots } = require('./paths');
const { isSafeSessionId } = require('../../sessionFiles');
const { readT3Activity } = require('../../t3SessionActivity');
const { readT3SessionMeta } = require('../../t3SessionMetadata');
const { readSessionTitle } = require('./sessionMetadata');
const { isArchivedSession } = require('../../sessionLive');

const { hasKnownSession, nativeSessionsForPeriod, activityEntries, rememberProjection, compactActivity } = require('../../sessionActivityProjection');

const POLL_INTERVAL_MS = 3000;
const RENEW_INTERVAL_MS = 10_000;
const MAX_RECORD_BYTES = 64 * 1024;

function readRegistryRecord(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return bytes <= MAX_RECORD_BYTES ? JSON.parse(buffer.toString('utf8', 0, bytes)) : null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function registryState(record) {
  // Desktop-hosted registries do not reliably report their terminal UI state.
  if (['claude-desktop', 'claude-desktop-3p'].includes(record.entrypoint)) return null;
  if (record.tempo === 'blocked' || record.status === 'waiting') return 'waiting';
  if (record.tempo === 'active' || record.status === 'busy') return 'running';
  if (record.tempo === 'idle' || record.status === 'idle') return 'idle';
  return null;
}

// Only the three states and our observation time leave this provider. Registry
// names, prompts, working directories, sockets and peer keys are never copied.
async function readSessionActivity(sessionIds, options = {}) {
  const result = new Map();
  if (sessionIds?.size === 0 || options.scopedHome) return result;
  const platform = options.platform || process.platform;
  const root = path.join(resolveClaudeConfigDir({ ...options, homeDir: options.homeDir || os.homedir() }), 'sessions');
  let names;
  try { names = fs.readdirSync(root); } catch (_) { return result; }
  const candidates = [];
  for (const name of names.filter((name) => /^[1-9]\d*\.json$/.test(name)).sort().slice(0, 256)) {
    if (!/^[1-9]\d*\.json$/.test(name)) continue;
    try {
      const file = path.join(root, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) continue;
      const record = readRegistryRecord(file);
      if (!record) continue;
      const pid = record.pid;
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647
        || `${pid}.json` !== name || !isSafeSessionId(record.sessionId)
        || (sessionIds && !sessionIds.has(record.sessionId))
        || record.pidDomain !== platform) continue;
      const state = registryState(record);
      if (!state) continue;
      // procStart names the process, unlike startedAt (session registration).
      // Without a start time we cannot rule out a recycled PID.
      const startedAt = typeof record.procStart === 'string'
        ? Date.parse(`${record.procStart} UTC`) : NaN;
      if (!Number.isFinite(startedAt)) continue;
      candidates.push({ pid, sessionId: record.sessionId, state, startedAt });
    } catch (_) { /* Missing files and partial writes fall back to the transcript. */ }
  }
  let starts;
  try {
    starts = await (options.readProcessStarts || processStarts)([...new Set(candidates.map((row) => row.pid))], platform);
  } catch (_) { return result; }
  const observedAt = new Date(options.now ?? Date.now()).toISOString();
  const newest = new Map();
  for (const record of candidates) {
    const actualStart = starts.get(record.pid);
    if (!Number.isFinite(actualStart) || Math.abs(actualStart - record.startedAt) > 1000) continue;
    if ((newest.get(record.sessionId) ?? -Infinity) >= actualStart) continue;
    newest.set(record.sessionId, actualStart);
    result.set(record.sessionId, { state: record.state, observedAt });
  }
  return result;
}

function sessionIdsForPeriods(periods) {
  const ids = new Set();
  for (const period of periods) {
    for (const session of Object.values(period?.sessions || {})) {
      if (session.client === 'claude' && !isArchivedSession(session)) ids.add(session.sessionId);
    }
  }
  return ids;
}

// A missing record explicitly clears a previous reading, including across Hub
// merges where an omitted field means an older producer supplied no evidence.
function nextObservation(session, readings, now, renew) {
  if (session.client !== 'claude' || isArchivedSession(session)) return null;
  const previous = session.liveActivity;
  const reading = readings.get(session.sessionId);
  if (!reading && (!previous || previous.state === 'unknown')) return null;
  const state = reading?.state || 'unknown';
  const observedAt = state === 'idle' && reading ? reading.observedAt : new Date(now).toISOString();
  if (previous?.state === state && previous.observedAt === observedAt) return null;
  if (previous?.state === state && (!renew || state === 'unknown'
    || now - Date.parse(previous.observedAt) < RENEW_INTERVAL_MS)) return null;
  return { state, observedAt };
}

function applySessionActivity(periods, readings, now = Date.now(), renew = false) {
  let changed = false;
  for (const period of periods) {
    for (const session of Object.values(period?.sessions || {})) {
      const observation = nextObservation(session, readings, now, renew);
      if (!observation) continue;
      session.liveActivity = observation;
      changed = true;
    }
  }
  return changed;
}

function projectSessionActivity(summary, readings, now = Date.now(), nativeSessions) {
  let next = null;
  const observations = [];
  const entries = activityEntries(summary, 'claude', readings.keys());
  for (const name of ['today', 'month', 'allTime']) {
    let sessions = null;
    for (const { key, session } of entries.filter((row) => row.name === name)) {
      const observation = nextObservation(session, readings, now, true);
      if (!observation) continue;
      sessions ||= compactActivity(summary[name], now);
      sessions[key] = observation;
      observations.push({ client: 'claude', sessionId: session.sessionId, liveActivity: observation });
    }
    if (!sessions) continue;
    next ||= { ...summary, updatedAt: new Date(now).toISOString() };
    next[name] = { ...summary[name], sessionActivity: sessions };
  }
  if (nativeSessions) {
    const oldNative = summary.nativeSessions || {};
    const claudeOnly = (view) => Object.fromEntries(Object.entries(view || {}).filter(([, session]) => session.client === 'claude'));
    const withoutClock = (view) => JSON.stringify(view, (key, value) => key === 'observedAt' ? undefined : value);
    const byPeriod = Object.fromEntries(['today', 'month', 'allTime'].map((name) =>
      [name, nativeSessionsForPeriod(summary, 'claude', nativeSessions, name)]));
    const changed = ['today', 'month', 'allTime'].some((name) => withoutClock(claudeOnly(oldNative[name])) !== withoutClock(byPeriod[name]));
    const renew = Object.values(claudeOnly(oldNative.today)).some((session) => now - Date.parse(session.liveActivity?.observedAt) >= RENEW_INTERVAL_MS);
    if (changed || renew) {
      next ||= { ...summary, updatedAt: new Date(now).toISOString() };
      next.nativeSessions = { ...oldNative };
      for (const name of ['today', 'month', 'allTime']) {
        const existing = Object.fromEntries(Object.entries(oldNative[name] || {}).filter(([, session]) => session.client !== 'claude'));
        next.nativeSessions[name] = { ...existing, ...byPeriod[name] };
      }
    }
  }
  rememberProjection(summary, next, observations);
  return next;
}

// Native metadata is optional. Probe only main transcripts in the configured
// root and immediate project folders, never the recursive historical tree.
function activityFiles(roots, ids) {
  const found = new Map();
  if (!ids.size) return found;
  for (const root of [roots.projects, roots.transcripts]) {
    let dirs;
    try {
      dirs = [root, ...fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).slice(0, 256).map((entry) => path.join(root, entry.name))];
    } catch (_) { continue; }
    for (const dir of dirs) for (const id of ids) {
      if (found.has(id)) continue;
      const file = path.join(dir, `${id}.jsonl`);
      try { if (fs.lstatSync(file).isFile()) found.set(id, file); } catch (_) { /* Not yet written. */ }
    }
  }
  return found;
}

// Registry discovery includes sessions before the first usage response. These
// rows are local presentation only; usage/archive identities win per period.
async function readSummaryActivity(summary, options = {}) {
  const readings = await readSessionActivity(null, options);
  const t3 = await readT3Activity(options, 'claudeAgent');
  for (const [id, reading] of t3) {
    if (!isSafeSessionId(id) || (reading.state === 'idle' && readings.has(id))) continue;
    readings.set(id, reading);
  }
  const ids = new Set([...readings].filter(([id, reading]) => !hasKnownSession(summary, 'claude', id, 'today')
    && ['running', 'waiting'].includes(reading.state)).map(([id]) => id));
  const roots = claudeSessionRoots({ ...options, homeDir: options.homeDir || os.homedir(), useEnvRoots: !options.scopedHome });
  const files = activityFiles(roots, ids);
  const titles = readT3SessionMeta(ids, { ...options, driver: 'claudeAgent' });
  const sessions = {};
  for (const id of ids) {
    const file = files.get(id);
    const title = titles.get(id)?.title || (file && readSessionTitle(file, options.claudeMetadataDeps));
    sessions[`claude:${id}`] = {
      client: 'claude', sessionId: id, native: true,
      totalTokens: 0, costUsd: 0, models: {}, tokenDataUnavailable: true,
      sessionDetailAvailable: Boolean(file), ...(title ? { title } : {}),
      lastUsedAt: summary.nativeSessions?.today?.[`claude:${id}`]?.lastUsedAt || readings.get(id).observedAt,
      liveActivity: readings.get(id)
    };
  }
  return { readings, sessions };
}

function projectActivity(summary, activity, now) {
  return projectSessionActivity(summary, activity.readings, now, activity.sessions);
}

function activityWatchTargets(options) {
  const config = path.resolve(resolveClaudeConfigDir({ ...options, homeDir: options.homeDir || os.homedir() }));
  return [{ target: path.join(config, 'sessions'), floor: config, kind: 'pid-registry' }];
}

module.exports = { POLL_INTERVAL_MS, applySessionActivity, projectSessionActivity, readSessionActivity, readSummaryActivity,
  sessionIdsForPeriods, readActivity: readSummaryActivity, projectActivity, activityWatchTargets };
