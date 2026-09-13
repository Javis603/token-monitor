'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Current Factory Droid releases cache session discovery under `.factory/cache`;
// older releases kept a smaller index beside the sessions tree. Both paths stay
// home-relative even when a custom tokscale root is configured.
function sessionDiscoveryIndexPath(home = os.homedir()) {
  return path.join(home, '.factory', 'cache', 'session-discovery-index.json');
}

function legacySessionsIndexPath(home = os.homedir()) {
  return path.join(home, '.factory', 'sessions-index.json');
}

function sessionIndexPaths(home = os.homedir()) {
  return [sessionDiscoveryIndexPath(home), legacySessionsIndexPath(home)];
}

function readDroidSessionIndex(indexPath, readFileSync = fs.readFileSync) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (_) {
    return [];
  }
  if (Array.isArray(parsed?.entries)) return parsed.entries;
  if (parsed?.entries && typeof parsed.entries === 'object') return Object.values(parsed.entries);
  return [];
}

function isoFromEpoch(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function droidSessionMetadataFromEntry(entry, { projectIdentity, resolveProjects }) {
  const stringValue = (value) => typeof value === 'string' ? value.trim() : '';
  const startedAt = isoFromEpoch(entry.createdTimeMs);
  const lastUsedAt = isoFromEpoch(entry.modifiedTimeMs ?? entry.mtime) || startedAt;
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
  const wanted = new Set(sessionIds);
  const result = new Map();
  for (const indexPath of sessionIndexPaths(home)) {
    const entries = readDroidSessionIndex(indexPath, deps.readFileSync);
    for (const entry of entries) {
      const currentId = typeof entry?.id === 'string' ? entry.id.trim() : '';
      const legacyId = typeof entry?.sessionId === 'string' ? entry.sessionId.trim() : '';
      const sessionId = currentId || legacyId;
      if (!sessionId || !wanted.has(sessionId)) continue;
      const meta = droidSessionMetadataFromEntry(entry, { projectIdentity, resolveProjects });
      const existing = result.get(sessionId) || {};
      const merged = { ...meta, ...existing };
      if (merged.title || merged.projectId || merged.startedAt || merged.lastUsedAt) result.set(sessionId, merged);
    }
  }
  return result;
}

module.exports = {
  droidSessionMetadataFromEntry,
  legacySessionsIndexPath,
  readDroidSessionIndex,
  resolveSessionMetadata,
  sessionDiscoveryIndexPath,
  sessionIndexPaths
};
