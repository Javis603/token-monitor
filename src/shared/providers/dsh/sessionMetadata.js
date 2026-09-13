'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  indexDshSessionHeaders,
  preferredDshSessionFileInDirectory,
  readDshSessionHeader,
  readDshSessionTitle,
  resolveDshSessionsRoot
} = require('./sessionFiles');

// This cache intentionally outlives one collection tick. The resolved sessions
// root is part of the key because one process decorates the native home and
// multiple WSL homes; the same id may exist in more than one after a clone or
// migration.
const sessionFileCache = new Map();

function directoryStatFingerprint(dir) {
  try {
    const stat = fs.statSync(dir, { bigint: true });
    return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (_) {
    return '';
  }
}

function resolveSessionMetadata(sessionIds, context) {
  const { deps, home, isoFromDate } = context;
  const result = new Map();
  const fileCache = deps.dshSessionFileCache || sessionFileCache;
  // Windows directory timestamps can remain unchanged across a create observed
  // in the same collection window. Verify the preferred generation in
  // this one already-known session directory instead of trusting that stat as
  // an invalidation signal. This is still bounded per session and never walks
  // the whole DSH sessions tree.
  const directoryFingerprintsReliable = deps.dshDirectoryFingerprintsReliable
    ?? (process.platform !== 'win32');
  // A scoped home is a WSL distro. Host DSH_HOME must never redirect this
  // lookup away from that distro, matching tokscale's use_env_roots: false.
  const env = deps.scopedHome ? {} : (deps.env || process.env);
  const root = resolveDshSessionsRoot({ homeDir: home, env, platform: deps.platform });
  const cacheKey = (id) => `${root}\u0000${id}`;
  const unresolvedIds = [...sessionIds].filter((id) => !fileCache.has(cacheKey(id)));
  if (unresolvedIds.length > 0) {
    const buildIndex = deps.indexDshSessionHeaders || indexDshSessionHeaders;
    const index = buildIndex({ homeDir: home, env, platform: deps.platform });
    for (const [sessionId, indexedEntry] of index) {
      const key = cacheKey(sessionId);
      if (fileCache.has(key)) continue;
      const directory = path.dirname(indexedEntry.filePath);
      // Capture this before the final per-directory selection. A generation
      // created during the whole-tree index is selected now; one landing after
      // this point changes the fingerprint and is promoted on the next tick.
      const directoryFingerprint = directoryStatFingerprint(directory);
      let entry = indexedEntry;
      const preferredPath = preferredDshSessionFileInDirectory(directory);
      if (preferredPath && preferredPath !== indexedEntry.filePath) {
        const preferredHeader = readDshSessionHeader(preferredPath);
        if (preferredHeader?.id === sessionId) {
          entry = { filePath: preferredPath, createdAt: preferredHeader.createdAt };
        }
      }
      let statFingerprint = '';
      try {
        const stat = fs.statSync(entry.filePath);
        statFingerprint = `${stat.size}:${stat.mtimeMs}`;
      } catch (_) { /* file vanished mid-scan */ }
      fileCache.set(key, { ...entry, statFingerprint, directoryFingerprint });
    }
  }

  for (const sessionId of sessionIds) {
    const key = cacheKey(sessionId);
    let entry = fileCache.get(key);
    if (!entry) continue;
    const directoryFingerprint = directoryStatFingerprint(path.dirname(entry.filePath));
    const directoryFingerprintChanged = directoryFingerprint
      && entry.directoryFingerprint
      && directoryFingerprint !== entry.directoryFingerprint;
    if (directoryFingerprintChanged || !directoryFingerprintsReliable) {
      const preferredPath = preferredDshSessionFileInDirectory(path.dirname(entry.filePath));
      if (preferredPath && preferredPath !== entry.filePath) {
        const preferredHeader = readDshSessionHeader(preferredPath);
        if (preferredHeader?.id === sessionId) {
          entry = {
            filePath: preferredPath,
            createdAt: preferredHeader.createdAt,
            statFingerprint: '',
            directoryFingerprint,
            titleState: undefined
          };
          fileCache.set(key, entry);
        }
      }
    }
    if (directoryFingerprint && entry.directoryFingerprint !== directoryFingerprint) {
      entry.directoryFingerprint = directoryFingerprint;
      fileCache.set(key, entry);
    }

    let lastUsedAt = '';
    let statFingerprint = '';
    try {
      const stat = fs.statSync(entry.filePath);
      lastUsedAt = isoFromDate(stat.mtime);
      statFingerprint = `${stat.size}:${stat.mtimeMs}`;
    } catch (_) { /* file vanished mid-scan */ }
    // A torn initial header may become readable after the file changes. Known
    // createdAt values are immutable in DSH's append-only log and need no retry.
    if (entry.createdAt === undefined && statFingerprint && statFingerprint !== entry.statFingerprint) {
      const refreshed = readDshSessionHeader(entry.filePath);
      if (refreshed) {
        entry = { ...entry, createdAt: refreshed.createdAt, statFingerprint };
      } else {
        entry.statFingerprint = statFingerprint;
      }
      fileCache.set(key, entry);
    }
    const readTitle = deps.readDshSessionTitle || readDshSessionTitle;
    const titleState = readTitle(entry.filePath, entry.titleState);
    if (titleState !== entry.titleState) {
      entry = { ...entry, titleState };
      fileCache.set(key, entry);
    }
    const startedAt = isoFromDate(Number(entry.createdAt));
    if (!startedAt && !lastUsedAt) continue;
    result.set(sessionId, {
      startedAt: startedAt || lastUsedAt,
      lastUsedAt: lastUsedAt || startedAt,
      ...(titleState?.title ? { title: titleState.title } : {})
    });
  }
  return result;
}

module.exports = { resolveSessionMetadata };
