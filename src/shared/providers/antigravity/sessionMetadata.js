'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { antigravityDataRoots } = require('./selfSync');
const { antigravityCliDataDir } = require('../../clientSources');

// Deferred like cursor: importing this resolver must not emit Node's
// experimental node:sqlite warning for collectors that never see an Antigravity row.
let defaultSqlite;
function resolveSqlite(deps = {}) {
  if (deps?.sqlite !== undefined) return deps.sqlite;
  if (defaultSqlite === undefined) {
    try { defaultSqlite = require('node:sqlite'); } catch (_) { defaultSqlite = null; }
  }
  return defaultSqlite;
}

const titleCache = new Map();

function fileStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (_) {
    return '';
  }
}

function databaseStamp(dbPath) {
  const main = fileStamp(dbPath);
  return main ? `${main}|${fileStamp(`${dbPath}-wal`)}` : '';
}

const TITLE_MAX_CODE_POINTS = 96;

function cleanTitle(value) {
  return typeof value === 'string'
    ? [...value.replace(/\s+/g, ' ').trim()].slice(0, TITLE_MAX_CODE_POINTS).join('')
    : '';
}

function antigravityConversationSummaryCandidates({ home = os.homedir(), env = process.env } = {}) {
  const candidates = [];
  const explicit = typeof env.ANTIGRAVITY_HOME === 'string' ? env.ANTIGRAVITY_HOME.trim() : '';
  if (explicit) {
    candidates.push(path.join(explicit, 'conversation_summaries.db'));
  }
  const explicitData = typeof env.ANTIGRAVITY_DATA_DIR === 'string' ? env.ANTIGRAVITY_DATA_DIR.trim() : '';
  if (explicitData) {
    candidates.push(path.join(explicitData, 'conversation_summaries.db'));
  }
  for (const root of antigravityDataRoots(home)) {
    candidates.push(path.join(root, 'conversation_summaries.db'));
  }
  candidates.push(path.join(path.dirname(antigravityCliDataDir({ homeDir: home, env })), 'conversation_summaries.db'));
  return [...new Set(candidates)];
}

function projectFromWorkspaceUris(workspaceUris, context) {
  if (!context?.resolveProjects || typeof context?.projectIdentity !== 'function') return null;
  if (!workspaceUris) return null;
  let uris;
  try {
    uris = typeof workspaceUris === 'string' ? JSON.parse(workspaceUris) : workspaceUris;
  } catch (_) {
    return null;
  }
  if (!Array.isArray(uris) || uris.length === 0) return null;
  const windows = !context.deps?.scopedHome && (context.deps?.platform || process.platform) === 'win32';
  for (const uriStr of uris) {
    if (typeof uriStr !== 'string' || !uriStr.trim()) continue;
    try {
      const parsedUrl = new URL(uriStr);
      let localPath = '';
      if (parsedUrl.protocol === 'file:') {
        localPath = fileURLToPath(parsedUrl, { windows });
      }
      if (localPath) {
        return context.projectIdentity(localPath);
      }
    } catch (_) {}
  }
  return null;
}

function readSummaries(dbPath, sqlite, wantedIds) {
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) { /* Read-only WAL reads benefit on newer builds. */ }
    const summaries = new Map();
    const misses = new Set();

    let hasTable;
    try {
      hasTable = Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries'").get()
      );
    } catch (_) {
      return null;
    }
    if (!hasTable) return null;

    let stmt = null;
    try {
      stmt = db.prepare(
        'SELECT title, preview, workspace_uris FROM conversation_summaries WHERE conversation_id = ?'
      );
    } catch (_) {
      return null;
    }

    for (const id of wantedIds) {
      try {
        const row = stmt.get(id);
        if (!row) {
          misses.add(id);
          continue;
        }
        // Cache source fields, not a projection tied to this tick's Projects
        // setting or path platform. Even an empty row is a definitive read.
        summaries.set(id, row);
      } catch (_) {
        // A transient failure is neither a hit nor a cached miss; retry next time.
      }
    }
    return { summaries, misses };
  } catch (_) {
    return null;
  } finally {
    try { db?.close(); } catch (_) { /* A failed read must not fail collection. */ }
  }
}

function resolveSessionMetadata(sessionIds, context = {}) {
  const result = new Map();
  const sqlite = resolveSqlite(context.deps);

  const home = context.home || os.homedir();
  const env = context.deps?.scopedHome ? {} : (context.deps?.env || process.env);
  const candidates = antigravityConversationSummaryCandidates({ home, env });
  const cache = context.deps?.antigravityTitleCache || titleCache;
  const unresolved = new Set();

  for (const dbPath of candidates) {
    const stamp = databaseStamp(dbPath);
    let cached = cache.get(dbPath);
    if (!stamp && !cached) continue;
    if (stamp && cached?.stamp !== stamp) {
      // Keep the last successful rows while revalidating this fingerprint.
      // A failed row is retried; it never becomes a definitive hit or miss.
      cached = { stamp, summaries: cached?.summaries || new Map(), validatedIds: new Set(), misses: new Set() };
    }

    const wanted = new Set([...sessionIds].filter((id) => !cached.validatedIds.has(id) && !cached.misses.has(id)));
    if (stamp && wanted.size > 0 && typeof sqlite?.DatabaseSync === 'function') {
      const read = readSummaries(dbPath, sqlite, wanted);
      if (read) {
        for (const [id, row] of read.summaries) {
          cached.summaries.set(id, row);
          cached.validatedIds.add(id);
        }
        for (const id of read.misses) {
          // Retain a confirmed removal in this same cache, so later read
          // failures cannot resurrect a title from the full-scan anchor.
          if (cached.summaries.has(id)) cached.summaries.set(id, null);
          cached.misses.add(id);
        }
      }
    }
    cache.set(dbPath, cached);

    for (const id of wanted) {
      if (stamp && !cached.validatedIds.has(id) && !cached.misses.has(id)) unresolved.add(id);
    }

    for (const sessionId of sessionIds) {
      if (result.has(sessionId)) continue;
      const row = cached.summaries.get(sessionId);
      if (cached.misses.has(sessionId)) continue;
      if (!cached.summaries.has(sessionId)) continue;
      const title = cleanTitle(row?.title) || cleanTitle(row?.preview);
      const identity = projectFromWorkspaceUris(row?.workspace_uris, context);
      result.set(sessionId, {
        catalogOnly: true,
        catalogTitle: title || null,
        ...(title ? { title } : {}),
        ...(identity || {})
      });
    }
  }

  for (const sessionId of sessionIds) {
    const key = `antigravity:${sessionId}`;
    const previous = context.metadata?.get(key);
    const anchored = context.deps?.t3Titles?.[key];
    if (!result.has(sessionId)) {
      const retained = previous && Object.prototype.hasOwnProperty.call(previous, 'catalogTitle')
        ? previous.catalogTitle : anchored;
      // A successful missing-row query can revoke a persisted override even
      // on a cold cache. Check all candidate stores before deciding absence.
      const confirmedMissing = !unresolved.has(sessionId) && candidates.some((dbPath) => cache.get(dbPath)?.misses.has(sessionId));
      if (confirmedMissing && retained !== undefined) {
        for (const dbPath of candidates) {
          const cached = cache.get(dbPath);
          if (cached?.misses.has(sessionId)) cached.summaries.set(sessionId, null);
        }
        result.set(sessionId, { catalogOnly: true, catalogTitle: null });
      } else if (typeof retained === 'string' && retained) {
        result.set(sessionId, { catalogOnly: true, catalogTitle: retained, title: retained });
      } else if (retained === null) result.set(sessionId, { catalogOnly: true, catalogTitle: null });
    }
    const meta = result.get(sessionId);
    if (meta && previous && Object.prototype.hasOwnProperty.call(previous, 'titleFallback')) meta.titleFallback = previous.titleFallback;
    if (meta?.catalogTitle !== null) continue;
    context.deps?.invalidatedTitleKeys?.add(key);
    const oldTitle = previous?.catalogTitle || anchored;
    if (oldTitle) meta.invalidatedTitle = oldTitle;
  }

  return result;
}

module.exports = {
  cleanTitle,
  antigravityConversationSummaryCandidates,
  readSummaries,
  resolveSessionMetadata
};
