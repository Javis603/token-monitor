'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Droid (Factory) keeps one central index of every session — id, title, cwd and
// epoch-millisecond timestamps — at `~/.factory/sessions-index.json`, next to
// the `sessions/` tree tokscale scans. The path stays home-relative on purpose:
// it must diverge together with clientSourceRoots()'s scan root, not on its own.
function sessionsIndexPath(home = os.homedir()) {
  return path.join(home, '.factory', 'sessions-index.json');
}

function readDroidSessionIndex(indexPath, readFileSync = fs.readFileSync) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (_) {
    return [];
  }
  return Array.isArray(parsed?.entries) ? parsed.entries : [];
}

function isoFromEpoch(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
}

function droidSessionMetadataFromEntry(entry, { projectIdentity, resolveProjects }) {
  const stringValue = (value) => typeof value === 'string' ? value.trim() : '';
  const startedAt = isoFromEpoch(entry.createdAt);
  const lastUsedAt = isoFromEpoch(entry.mtime) || startedAt;
  const projectPath = stringValue(entry.cwd);
  const identity = resolveProjects && projectPath ? projectIdentity(projectPath) : {};
  const title = stringValue(entry.title);
  return {
    ...(title ? { title } : {}),
    ...(identity.projectId ? identity : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {})
  };
}

function resolveSessionMetadata(sessionIds, context) {
  const { deps = {}, home = os.homedir(), projectIdentity, resolveProjects } = context;
  const wanted = sessionIds instanceof Set ? sessionIds : new Set(sessionIds);
  const entries = readDroidSessionIndex(sessionsIndexPath(home), deps.readFileSync);
  const result = new Map();
  for (const entry of entries) {
    const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId : '';
    if (!sessionId || !wanted.has(sessionId) || result.has(sessionId)) continue;
    const meta = droidSessionMetadataFromEntry(entry, { projectIdentity, resolveProjects });
    if (meta.title || meta.projectId || meta.startedAt || meta.lastUsedAt) result.set(sessionId, meta);
  }
  return result;
}

module.exports = {
  droidSessionMetadataFromEntry,
  readDroidSessionIndex,
  resolveSessionMetadata,
  sessionsIndexPath
};
