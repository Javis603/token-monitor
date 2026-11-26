'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { antigravityDataRoots } = require('./selfSync');
const { discoverAntigravityAcpPaths } = require('./acpPaths');
const { antigravityCliDataDir } = require('../../clientSources');
const { readT3SessionRelationResult } = require('../../t3/sessionMetadata');
const { RUNNING_WINDOW_MS } = require('../../sessionLive');
const { normalizeSessionContext } = require('../../sessionContext');
const { cliContextPath, readCliContext } = require('./cliContext');

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
const recentTurnCache = new Map();

function fileStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    return error.code === 'ENOENT' ? '' : null;
  }
}

function databaseStamp(dbPath) {
  const main = fileStamp(dbPath);
  return main ? `${main}|${fileStamp(`${dbPath}-wal`)}` : main;
}

const TITLE_MAX_CODE_POINTS = 96;

function cleanTitle(value) {
  return typeof value === 'string'
    ? [...value.replace(/\s+/g, ' ').trim()].slice(0, TITLE_MAX_CODE_POINTS).join('')
    : '';
}

function antigravityConversationSummaryCandidates({ home = os.homedir(), env = process.env, useEnvRoot = true, antigravityAcpPaths } = {}) {
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
  const acpDirs = Array.isArray(antigravityAcpPaths)
    ? antigravityAcpPaths
    : discoverAntigravityAcpPaths({ homeDir: home, env, useEnvRoot });
  for (const dir of acpDirs) {
    candidates.push(path.join(path.dirname(dir), 'conversation_summaries.db'));
  }
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

function catalogTime(value) {
  // Use ISO parsing for SQLite's space-separated timestamps. V8 otherwise
  // interprets the year-0001 sentinel as 2001.
  return typeof value === 'string' ? Date.parse(value.replace(' ', 'T')) : NaN;
}

function readTurn(row) {
  const inputAt = catalogTime(row.last_user_input_time);
  if (row.status === 'CASCADE_RUN_STATUS_RUNNING') {
    return { turnEnded: false, inputAt: inputAt > 0 ? inputAt : 0 };
  }
  // The catalog also contains idle conversations that have never had a local
  // turn. Antigravity stores a year-1 timestamp when it has no user input.
  if (row.status === 'CASCADE_RUN_STATUS_IDLE' && row.not_fully_idle === 0 && inputAt > 0) {
    return { turnEnded: true, inputAt };
  }
  return null;
}

function rememberTurn(turns, id, turn) {
  if (turn && turn.inputAt > (turns.get(id)?.inputAt ?? -1)) turns.set(id, turn);
}

function canReadTurns(dbPath) {
  return path.basename(path.dirname(dbPath)) !== 'antigravity-backup';
}

// Anchored scans only reload today's usage. A resumed conversation can still
// have all its tokens in earlier days, so query running rows and recent idle updates
// instead of looking up every historical session on each watch tick.
function readRecentTurns(home, deps, now) {
  const turns = new Map();
  const sqlite = resolveSqlite(deps);
  if (typeof sqlite?.DatabaseSync !== 'function') return turns;
  const since = now - RUNNING_WINDOW_MS;
  for (const dbPath of antigravityConversationSummaryCandidates({ home, env: deps.env, antigravityAcpPaths: deps.antigravityAcpPaths })) {
    if (!canReadTurns(dbPath)) continue;
    const stamp = databaseStamp(dbPath);
    if (!stamp) continue;
    let cached = recentTurnCache.get(dbPath);
    if (cached?.stamp !== stamp || cached.since > since) {
      let db;
      try {
        db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
        const rows = db.prepare(`
          SELECT conversation_id, status, not_fully_idle, last_user_input_time, last_modified_time
          FROM conversation_summaries
          WHERE status = 'CASCADE_RUN_STATUS_RUNNING'
            OR julianday(last_user_input_time) >= julianday(?1)
            OR (status = 'CASCADE_RUN_STATUS_IDLE' AND not_fully_idle = 0
              AND julianday(last_modified_time) >= julianday(?1))
        `).all({ '?1': new Date(since).toISOString() });
        cached = { stamp, since, rows };
        recentTurnCache.set(dbPath, cached);
      } catch (_) {
        // Older schemas and temporarily unreadable catalogs have no reading.
        continue;
      } finally {
        try { db?.close(); } catch (_) { /* A failed read must not fail collection. */ }
      }
    }
    for (const row of cached.rows) {
      const turn = readTurn(row);
      // RUNNING can reach the catalog before either timestamp updates. The
      // displayed state still expires based on the session's activity time.
      if (turn && (!turn.turnEnded || turn.inputAt >= since || catalogTime(row.last_modified_time) >= since)) {
        rememberTurn(turns, row.conversation_id, turn);
      }
    }
  }
  return turns;
}

function readSummaries(dbPath, sqlite, wantedIds) {
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) { /* Read-only WAL reads benefit on newer builds. */ }
    const summaries = new Map();
    const misses = new Set();

    let hasTable;
    let columns;
    try {
      hasTable = Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries'").get()
      );
      columns = hasTable
        ? new Set(db.prepare('PRAGMA table_info(conversation_summaries)').all().map((column) => String(column.name)))
        : null;
    } catch (_) {
      return null;
    }
    if (!hasTable) return null;

    // Older schemas may lack subagent or turn data. Detect the columns up
    // front so a transient prepare failure is never read as an older schema.
    const optional = [
      'parent_conversation_id', 'agent_name', 'status', 'not_fully_idle', 'last_user_input_time'
    ].filter((name) => columns.has(name));
    let stmt = null;
    try {
      stmt = db.prepare(
        `SELECT ${['title', 'preview', 'workspace_uris', ...optional].join(', ')} FROM conversation_summaries WHERE conversation_id = ?`
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
  const candidates = antigravityConversationSummaryCandidates({
    home,
    env,
    useEnvRoot: !context.deps?.scopedHome,
    antigravityAcpPaths: context.deps?.antigravityAcpPaths
  });
  const cache = context.deps?.antigravityTitleCache || titleCache;
  const unresolved = new Set();
  const unresolvedNativeSources = new Set();
  const priorities = new Map();
  const turns = new Map();
  const sourceFor = key => context.metadata?.get(key)?.catalogTitleSource || context.deps?.catalogTitleSources?.[key];
  const nativeSourceFor = key => {
    const source = sourceFor(key);
    return typeof source === 'string' ? source : source?.native;
  };

  for (const dbPath of candidates) {
    const canReadTurn = canReadTurns(dbPath);
    const stamp = databaseStamp(dbPath);
    let cached = cache.get(dbPath);
    if (!stamp) {
      for (const id of sessionIds) {
        const previouslySelected = nativeSourceFor(`antigravity:${id}`) === dbPath;
        if (previouslySelected) unresolvedNativeSources.add(id);
        if (cached || stamp === null || previouslySelected) unresolved.add(id);
      }
      if (!cached) continue;
    }
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
          // This store's old row is no longer evidence, even if the file
          // disappears or a new fingerprint cannot be read on the next tick.
          if (cached.summaries.has(id)) cached.summaries.set(id, null);
          cached.misses.add(id);
        }
      }
    }
    cache.set(dbPath, cached);

    for (const id of wanted) {
      if (stamp && !cached.validatedIds.has(id) && !cached.misses.has(id)) {
        unresolved.add(id);
        if (nativeSourceFor(`antigravity:${id}`) === dbPath) unresolvedNativeSources.add(id);
      }
    }

    for (const sessionId of sessionIds) {
      const row = cached.summaries.get(sessionId);
      if (cached.misses.has(sessionId)) continue;
      if (!row) continue;
      const validated = stamp && cached.validatedIds.has(sessionId);
      // Pick activity independently of the title. A richer title, backup, or
      // last-known row from an unreadable database never vouches for a turn.
      if (validated && canReadTurn) {
        rememberTurn(turns, sessionId, readTurn(row));
      }
      const title = cleanTitle(row?.title) || cleanTitle(row?.preview) || cleanTitle(row?.agent_name);
      const key = `antigravity:${sessionId}`;
      const selectedSource = nativeSourceFor(key);
      // Candidate order regains priority only with a validated row. If both
      // reads are stale, keep the source that last supplied the chosen value.
      const priority = (validated ? 2 : 0) + (title ? 4 : 0)
        + (!validated && selectedSource === dbPath ? 1 : 0);
      if (priorities.has(sessionId) && priorities.get(sessionId) >= priority) continue;
      priorities.set(sessionId, priority);
      const identity = projectFromWorkspaceUris(row?.workspace_uris, context);
      const parentSessionId = typeof row?.parent_conversation_id === 'string'
        ? row.parent_conversation_id.trim()
        : '';
      result.set(sessionId, {
        catalogOnly: true,
        catalogTitle: title || null,
        catalogProjectResolved: true,
        catalogTitleSource: dbPath,
        ...(title ? { title } : {}),
        ...(parentSessionId && parentSessionId !== sessionId ? { parentSessionId } : {}),
        ...(identity || {})
      });
    }
  }

  const { facts: t3Relations, status: t3Status, completedStores, ambiguous, ownershipComplete } = readT3SessionRelationResult(sessionIds, {
    ...context.deps,
    includeAntigravityTitles: true,
    includeAntigravityContext: !context.deps?.scopedHome,
    includeOwnershipStatus: true,
    homeDir: home,
    useEnvRoot: !context.deps?.scopedHome
  });
  const cliReadings = readCliContext(sqlite, cliContextPath({ homeDir: home, env }), sessionIds, context.now ?? Date.now());
  for (const sessionId of sessionIds) {
    const key = `antigravity:${sessionId}`;
    const previous = context.metadata?.get(key);
    const anchored = context.deps?.t3Titles?.[key];
    const retained = previous && Object.prototype.hasOwnProperty.call(previous, 'catalogTitle')
      ? previous.catalogTitle : anchored;
    const previousT3Store = sourceFor(key)?.t3;
    const hasAnchoredProject = Boolean(context.deps?.catalogProjects?.today?.[key]);
    if (result.get(sessionId)?.catalogTitle === null && unresolved.has(sessionId) && retained
      && !previousT3Store) {
      const meta = result.get(sessionId);
      meta.catalogTitle = retained;
      meta.title = retained;
      delete meta.catalogProjectResolved;
      delete meta.catalogTitleSource;
      delete meta.projectId;
      delete meta.projectLabel;
    }
    if (!result.has(sessionId)) {
      // A successful missing-row query can revoke a persisted override even
      // on a cold cache. Check all candidate stores before deciding absence.
      const confirmedMissing = !unresolved.has(sessionId) && candidates.some((dbPath) => cache.get(dbPath)?.misses.has(sessionId));
      const knownSummary = candidates.some((dbPath) => cache.get(dbPath)?.summaries.has(sessionId));
      if (confirmedMissing && (retained !== undefined || hasAnchoredProject || knownSummary)) {
        for (const dbPath of candidates) {
          const cached = cache.get(dbPath);
          if (cached?.misses.has(sessionId)) cached.summaries.set(sessionId, null);
        }
        result.set(sessionId, { catalogOnly: true, catalogTitle: null, catalogProjectResolved: true });
      } else if (typeof retained === 'string' && retained && !previousT3Store) {
        result.set(sessionId, { catalogOnly: true, catalogTitle: retained, title: retained });
      } else if (retained === null) result.set(sessionId, { catalogOnly: true, catalogTitle: null });
      else if (hasAnchoredProject) result.set(sessionId, { catalogOnly: true });
    }
    const nativeMeta = result.get(sessionId);
    const previousNativeSource = nativeSourceFor(key);
    if (nativeMeta && previousNativeSource && unresolvedNativeSources.has(sessionId) && !nativeMeta.projectId
      && nativeMeta.catalogTitleSource !== previousNativeSource) {
      delete nativeMeta.catalogProjectResolved;
      nativeMeta.catalogTitleSource = previousNativeSource;
    }
    const previousT3Title = previousT3Store ? retained : null;
    const match = t3Relations.get(key);
    const retainT3Title = previousT3Title && !ambiguous?.has(key)
      && (t3Status === 'retryable' || (match?.titleStore !== previousT3Store && !completedStores?.has(previousT3Store)));
    const t3Title = match?.title || (retainT3Title ? previousT3Title : null);
    if (t3Title) {
      result.set(sessionId, {
        ...nativeMeta,
        catalogOnly: true,
        catalogTitle: t3Title,
        catalogTitleSource: { native: nativeMeta?.catalogTitleSource || nativeSourceFor(key), t3: match?.title ? match.titleStore : previousT3Store },
        title: t3Title
      });
    } else if (previousT3Title && !nativeMeta?.title) {
      result.set(sessionId, { ...nativeMeta, catalogOnly: true, catalogTitle: null });
    }
    if (ambiguous?.has(key) || (ownershipComplete && !match && (!previousT3Store || completedStores?.has(previousT3Store)))) {
      result.set(sessionId, { catalogOnly: true, ...result.get(sessionId), t3ThreadRevoked: true });
    }
    let contextReading = !match && !ambiguous?.has(key) ? cliReadings.get(sessionId) : undefined;
    if (match && Object.hasOwn(match, 'contextUsage')) {
      const { contextTokens, contextWindow } = match.contextUsage;
      contextReading = Number.isSafeInteger(contextTokens) && Number.isSafeInteger(contextWindow)
        ? normalizeSessionContext(match.contextUsage) : null;
    }
    if (contextReading !== undefined || Object.hasOwn(previous || {}, 'contextWindow')) {
      result.set(sessionId, {
        catalogOnly: true, ...result.get(sessionId),
        ...(contextReading || { contextTokens: 0, contextWindow: 0 })
      });
    }
    const meta = result.get(sessionId);
    const turn = turns.get(sessionId);
    if (meta && turn) {
      meta.turnEnded = turn.turnEnded;
      if (turn.inputAt) meta.lastUsedAt = new Date(turn.inputAt).toISOString();
    }
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
  readRecentTurns,
  resolveSessionMetadata
};
