'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveSqlite, openDb } = require('../../sqliteReadOnly');
const { readT3Activity } = require('../../t3SessionActivity');
const { clientSourceRoots } = require('../../clientSources');
const { codexSessionFile } = require('../../sessionFiles');
const { RUNNING_WINDOW_MS, isArchivedSession, sessionActivityState } = require('../../sessionLive');
const { readCodexSessionState } = require('./sessionContext');
const { codexHomeDir, discoverDbPaths, readSessionMeta, readT3SessionMeta } = require('./sessionMetadata');

const { hasKnownSession, nativeSessionsForPeriod, activityEntries, codexActivityCandidates, rememberProjection } = require('../../sessionActivityProjection');

const MAX_SESSIONS = 256;
const MAX_HEADER_BYTES = 8 * 1024 * 1024;
const RENEW_INTERVAL_MS = 10_000;
const discoveryCache = new WeakMap();

function fileSignature(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (_) { return ''; }
}

function isPathInside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const identityCache = new Map();
function nativeIdForFile(file) {
  let fd;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return '';
    const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = identityCache.get(file);
    if (cached?.fingerprint === fingerprint) return cached.id;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    // Instructions/tool definitions can make session_meta larger than a chunk.
    // Read only that complete first line, with a hard bound and no retained text.
    const chunks = [];
    let position = 0;
    let complete = false;
    while (position < MAX_HEADER_BYTES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_HEADER_BYTES - position));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!bytes) { complete = true; break; }
      const newline = buffer.subarray(0, bytes).indexOf(10);
      chunks.push(buffer.subarray(0, newline >= 0 ? newline : bytes));
      position += bytes;
      if (newline >= 0 || position >= stat.size) { complete = true; break; }
    }
    const first = complete ? JSON.parse((chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)).toString('utf8')) : null;
    const id = first?.type === 'session_meta' && typeof first.payload?.id === 'string' ? first.payload.id : '';
    identityCache.delete(file);
    identityCache.set(file, { fingerprint, id });
    if (identityCache.size > 512) identityCache.delete(identityCache.keys().next().value);
    return id;
  } catch (_) { return ''; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}


function sessionRoots(options) {
  const custom = (clientSourceRoots('codex', options).codex || []).filter((root) => root.custom).map((root) => root.dir);
  return [...new Set([path.join(codexHomeDir(options), 'sessions'), ...custom].map((root) => path.resolve(root)))];
}

function localDayParts(clock, offset = 0) {
  const date = new Date(clock);
  date.setDate(date.getDate() - offset);
  return [String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')];
}

function discoverFilesUncached(options, activity, summary) {
  const files = new Map();
  const roots = sessionRoots(options);
  const realRoots = roots.flatMap((root) => {
    try { return [fs.realpathSync(root)]; } catch (_) { return []; }
  });
  const accepted = new Set();
  const now = Number(new Date(options.now ?? Date.now()));
  const accept = (file, catalogActive = false) => {
    if (files.size >= MAX_SESSIONS || !/^rollout-.+\.jsonl$/.test(path.basename(file))) return;
    const id = path.basename(file, '.jsonl');
    // Today's usage rows get native metadata through the normal collector.
    // A historical session resumed without new tokens still needs a Today row.
    if (!activity.size && hasKnownSession(summary, 'codex', id, 'today')) return;
    try {
      const real = fs.realpathSync(file);
      if (!realRoots.some((root) => isPathInside(root, real))) return;
      if (accepted.has(real)) return;
      accepted.add(real);
      const stat = fs.statSync(real);
      if (!stat.isFile() || stat.mtimeMs > now + 1000) return;
      if (now - stat.mtimeMs > RUNNING_WINDOW_MS && !catalogActive
        && ![...activity.keys()].some((nativeId) => id.includes(nativeId))) return;
      const nativeId = nativeIdForFile(real);
      const reading = activity.get(nativeId);
      if (now - stat.mtimeMs > RUNNING_WINDOW_MS && !['running', 'waiting'].includes(reading?.state)) return;
      files.set(id, { file: real, sourcePath: file,
        sourceSignature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
        nativeId, lastUsedAt: new Date(stat.mtimeMs).toISOString() });
    } catch (_) { /* Removed, unreadable and out-of-scope files are ignored. */ }
  };
  const sqlite = resolveSqlite(options);
  if (sqlite) for (const file of discoverDbPaths(options)) {
    let db;
    try {
      db = openDb(file, sqlite);
      const ids = [...activity.keys()];
      const rows = db.prepare(`SELECT id, rollout_path FROM threads
        WHERE updated_at >= ? ${ids.length ? `OR id IN (${ids.map(() => '?').join(',')})` : ''}
        ORDER BY updated_at DESC LIMIT ?`).all(Math.floor((now - RUNNING_WINDOW_MS) / 1000), ...ids, MAX_SESSIONS);
      for (const row of rows) if (typeof row.rollout_path === 'string') accept(row.rollout_path, activity.has(row.id));
    } catch (_) { /* Date-folder discovery also works without a native catalog. */ }
    finally { if (db) { try { db.close(); } catch (_) {} } }
  }
  // New sessions need not be registered with usage or the thread catalog yet.
  // Scan just the current/previous date folders, not the whole transcript tree.
  for (const root of roots) for (const offset of [0, 1]) {
    const dir = path.join(root, ...localDayParts(now, offset));
    try {
      const names = fs.readdirSync(dir).filter((name) => /^rollout-.+\.jsonl$/.test(name)).sort().reverse().slice(0, MAX_SESSIONS);
      for (const name of names) accept(path.join(dir, name));
    } catch (_) { /* No session on this date. */ }
  }
  return files;
}

function discoverFiles(options, activity, summary) {
  const clock = Number(new Date(options.now ?? Date.now()));
  const roots = sessionRoots(options);
  const catalogs = discoverDbPaths(options);
  const maps = ['today', 'month', 'allTime'].map((name) => summary[name]?.sessions);
  const key = maps[2] || maps[1] || maps[0] || summary;
  const config = JSON.stringify([roots, catalogs, localDayParts(clock),
    [...activity].map(([id, reading]) => [id, reading.state]).sort(([a], [b]) => a.localeCompare(b))]);
  const previous = discoveryCache.get(key);
  const sqlite = resolveSqlite(options);
  if (previous && previous.config === config && previous.sqlite === sqlite
    && maps.every((map, index) => map === previous.maps[index])
    && clock >= previous.clock && clock - previous.clock < RENEW_INTERVAL_MS
    && previous.signatures.every(([file, signature]) => fileSignature(file) === signature)) return previous.files;

  const paths = new Set([...roots, ...catalogs.flatMap((file) => [file, `${file}-wal`])]);
  for (const root of roots) for (const offset of [0, 1]) {
    paths.add(path.join(root, ...localDayParts(clock, offset)));
  }
  const signatures = new Map([...paths].map((file) => [file, fileSignature(file)]));
  const files = discoverFilesUncached(options, activity, summary);
  // This cache holds at most the bounded discovery set, never historical usage
  // identities. Native DB/WAL, date folders and accepted source paths invalidate
  // it; T3 WAL alone does not. Requests/PID validation remain fresh every read.
  // A file/catalog that changes during discovery must not seed a fresh cache
  // fingerprint with identities read from its older contents.
  for (const file of files.values()) signatures.set(file.sourcePath, file.sourceSignature);
  if (signatures.size <= 1024 && [...signatures].every(([file, signature]) => fileSignature(file) === signature)) {
    discoveryCache.set(key, { config, sqlite, maps, clock, files, signatures: [...signatures] });
  }
  else discoveryCache.delete(key);
  return files;
}

async function readSessionActivity(summary, options = {}) {
  const activity = await readT3Activity(options);
  const files = discoverFiles(options, activity, summary);
  const readings = new Map();
  const candidates = codexActivityCandidates(summary, activity.keys(), files);
  for (const id of candidates) {
    const session = { sessionId: id };
    // Indexed filename hints and bounded catalog candidates narrow the lookup;
    // only a verified session_meta header establishes the native identity.
    const file = files.get(session.sessionId)?.file || codexSessionFile(options.homeDir, session.sessionId, {
      codexHome: codexHomeDir(options)
    });
    const nativeId = files.get(session.sessionId)?.nativeId || (file && nativeIdForFile(file));
    const reading = activity.get(nativeId);
    if (reading) readings.set(session.sessionId, reading);
  }
  const ids = new Set([...files.keys()].filter((id) => !hasKnownSession(summary, 'codex', id, 'today')));
  const generatedTitleIds = new Map();
  const metadata = readSessionMeta(ids, { ...options, titleSourceById: generatedTitleIds });
  const t3Metadata = readT3SessionMeta(ids, options);
  const sessions = {};
  for (const id of ids) {
    const { file, nativeId, lastUsedAt } = files.get(id);
    const state = readCodexSessionState(file, options.codexDeps);
    const reading = activity.get(nativeId);
    if (state.turnEnded !== false && !reading) continue;
    const session = {
      client: 'codex', sessionId: id, totalTokens: 0, costUsd: 0, models: {},
      native: true, tokenDataUnavailable: true, sessionDetailAvailable: true,
      lastUsedAt, lastMessageAt: lastUsedAt,
      ...metadata.get(id),
      ...(!generatedTitleIds.get(id) ? t3Metadata.get(id) : {}),
      turnEnded: state.turnEnded, waitingForInput: state.waitingForInput,
      ...(reading ? { liveActivity: reading } : {})
    };
    if (!['running', 'waiting'].includes(sessionActivityState(session, options.now))) continue;
    sessions[`codex:${id}`] = session;
  }
  return { readings, sessions };
}

function projectSessionActivity(summary, activity, now = Date.now()) {
  let next = null;
  const observations = [];
  const entries = activityEntries(summary, 'codex', activity.readings.keys());
  for (const name of ['today', 'month', 'allTime']) {
    let sessions = null;
    for (const { key, session } of entries.filter((row) => row.name === name)) {
      if (session.client !== 'codex' || isArchivedSession(session)) continue;
      const reading = activity.readings.get(session.sessionId);
      const previous = session.liveActivity;
      const state = reading?.state || 'unknown';
      if ((!reading && (!previous || previous.state === 'unknown'))
        || (previous?.state === state && (state === 'unknown' || now - Date.parse(previous.observedAt) < RENEW_INTERVAL_MS))) continue;
      sessions ||= require('../../sessionActivityProjection').compactActivity(summary[name], now);
      const liveActivity = { state, observedAt: new Date(now).toISOString() };
      sessions[key] = liveActivity;
      observations.push({ client: 'codex', sessionId: session.sessionId, liveActivity });
    }
    if (!sessions) continue;
    next ||= { ...summary };
    next[name] = { ...summary[name], sessionActivity: sessions };
  }
  // Suppress unchanged observations between renewals, just like usage rows.
  const withoutClock = (views) => JSON.stringify(views, (key, value) =>
    ['observedAt', 'lastUsedAt', 'lastMessageAt'].includes(key) ? undefined : value);
  const oldNative = summary.nativeSessions || { today: {}, month: {}, allTime: {} };
  const codexOnly = (view) => Object.fromEntries(Object.entries(view || {}).filter(([, session]) => session.client === 'codex'));
  const byPeriod = Object.fromEntries(['today', 'month', 'allTime'].map((name) =>
    [name, nativeSessionsForPeriod(summary, 'codex', activity.sessions, name)]));
  const changed = ['today', 'month', 'allTime'].some((name) => withoutClock(codexOnly(oldNative[name])) !== withoutClock(byPeriod[name]));
  const oldCodex = Object.values(codexOnly(oldNative.today));
  const renew = oldCodex.some((session) => session.liveActivity
    ? now - Date.parse(session.liveActivity.observedAt) >= RENEW_INTERVAL_MS
    : Date.parse(activity.sessions[`codex:${session.sessionId}`]?.lastUsedAt) - Date.parse(session.lastUsedAt) >= RENEW_INTERVAL_MS);
  if (changed || renew) {
    next ||= { ...summary };
    next.nativeSessions = { ...summary.nativeSessions };
    for (const name of ['today', 'month', 'allTime']) {
      const existing = Object.fromEntries(Object.entries(oldNative[name] || {}).filter(([, session]) => session.client !== 'codex'));
      next.nativeSessions[name] = { ...existing, ...byPeriod[name] };
    }
  }
  if (next) next.updatedAt = new Date(now).toISOString();
  rememberProjection(summary, next, observations);
  return next;
}

module.exports = { readT3Activity, readSessionActivity, projectSessionActivity,
  readActivity: readSessionActivity, projectActivity: projectSessionActivity };
