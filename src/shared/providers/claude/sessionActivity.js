'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { resolveClaudeConfigDir } = require('./paths');
const { isArchivedSession } = require('../../sessionLive');

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

function processStarts(pids, platform) {
  if (!pids.length) return Promise.resolve(new Map());
  let command;
  let args;
  if (platform === 'darwin' || platform === 'linux') {
    command = 'ps';
    args = ['-p', pids.join(','), '-o', 'pid=', '-o', 'lstart='];
  } else if (platform === 'win32') {
    command = 'powershell.exe';
    // All interpolated values have already been validated as positive integers.
    const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
    args = ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { Write-Output ($_.ProcessId.ToString() + ' ' + $_.CreationDate.ToUniversalTime().ToString('o')) }`];
  } else return Promise.resolve(new Map());
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: 2000, maxBuffer: 128 * 1024, windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
    }, (_error, stdout) => {
      const result = new Map();
      for (const line of String(stdout || '').split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) continue;
        const time = Date.parse(platform === 'win32' ? match[2] : `${match[2]} UTC`);
        if (Number.isFinite(time)) result.set(Number(match[1]), time);
      }
      resolve(result);
    });
  });
}

// Only the three states and our observation time leave this provider. Registry
// names, prompts, working directories, sockets and peer keys are never copied.
async function readSessionActivity(sessionIds, options = {}) {
  const result = new Map();
  if (!sessionIds.size || options.scopedHome) return result;
  const platform = options.platform || process.platform;
  const root = path.join(resolveClaudeConfigDir({ ...options, homeDir: options.homeDir || os.homedir() }), 'sessions');
  let names;
  try { names = fs.readdirSync(root); } catch (_) { return result; }
  const candidates = [];
  for (const name of names) {
    if (!/^[1-9]\d*\.json$/.test(name)) continue;
    try {
      const file = path.join(root, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) continue;
      const record = readRegistryRecord(file);
      if (!record) continue;
      const pid = record.pid;
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647
        || `${pid}.json` !== name || !sessionIds.has(record.sessionId)
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
  if (previous?.state === state && (!renew || state === 'unknown'
    || now - Date.parse(previous.observedAt) < RENEW_INTERVAL_MS)) return null;
  return { state, observedAt: new Date(now).toISOString() };
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

function projectSessionActivity(summary, readings, now = Date.now()) {
  let next = null;
  for (const name of ['today', 'month', 'allTime']) {
    let sessions = null;
    for (const [key, session] of Object.entries(summary[name]?.sessions || {})) {
      const observation = nextObservation(session, readings, now, true);
      if (!observation) continue;
      sessions ||= { ...summary[name].sessions };
      sessions[key] = { ...session, liveActivity: observation };
    }
    if (!sessions) continue;
    next ||= { ...summary, updatedAt: new Date(now).toISOString() };
    next[name] = { ...summary[name], sessions };
  }
  return next;
}

module.exports = { POLL_INTERVAL_MS, applySessionActivity, projectSessionActivity, readSessionActivity, sessionIdsForPeriods };
