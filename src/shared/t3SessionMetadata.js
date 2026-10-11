'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveSqlite, openDb } = require('./sqliteReadOnly');
const { nativeAccountingId, readT3IdentityBindings, t3AccountingClient } = require('./t3SessionIdentity');

const QUERY_CHUNK_SIZE = 400;
const T3_DEFAULT_TITLES = new Set(['new thread', 'start a new conversation']);

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanT3Title(value) {
  const chars = Array.from(cleanText(value));
  return chars.length <= 96 ? chars.join('') : `${chars.slice(0, 95).join('')}…`;
}

// T3 Code keeps its own display titles for each provider. Its state lives under a
// base directory of its own, with the server database one level below in
// `userdata` (a dev-server run writes to `dev` instead).
//
// Only the installed layouts are covered: the default home and an explicit
// `T3CODE_HOME`. A T3 dev run inside a linked git worktree keeps its state in
// that worktree's own `.t3`, which is not reachable from the home directory;
// those sessions keep their native fallback title.
//
// T3 expands a leading `~` against the user's home before resolving the base
// directory, so `T3CODE_HOME=~/t3-alt` means the home directory rather than a
// literal `~` directory under the working directory. Mirror its rule exactly:
// a lone `~` is home, `~/...` and `~\...` drop that first separator and join the
// rest onto home, and anything else is left untouched.
function expandHomePath(value, homeDir) {
  const raw = String(value || '');
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(homeDir, raw.slice(2));
  return raw;
}

function t3HomeDir(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  if (options.useEnvRoot !== false) {
    // T3 only trims this value, so collapse nothing: a path containing a
    // doubled space is a different directory, not a cosmetic difference.
    const configured = String(env.T3CODE_HOME || '').trim();
    if (configured) return path.resolve(expandHomePath(configured, homeDir));
  }
  return path.join(homeDir, '.t3');
}

function discoverT3DbPaths(options = {}) {
  if (Array.isArray(options.t3DbPaths)) {
    return [...new Set(options.t3DbPaths.map(String).filter(Boolean))];
  }
  const root = t3HomeDir(options);
  const stateDirs = [
    path.join(root, 'userdata'),
    // A dev server keeps its state beside the base directory rather than in it.
    // T3 picks that state directory from two rules that can disagree on which
    // subdirectory applies: the desktop app uses `dev` when the run is a dev one
    // and no `T3CODE_HOME` is configured, while the server uses `dev` only when no
    // explicit base directory was given. A `T3CODE_HOME` therefore counts as
    // explicit and lands under `dev/userdata`. Check both dev layouts; the
    // leading `userdata` path stays first because an installed app is the common
    // case and is the authoritative store when it exists.
    path.join(root, 'dev', 'userdata'),
    path.join(root, 'dev')
  ];
  // V2 leaves the legacy database behind; its titles can be stale after migration.
  return [...new Set(stateDirs.flatMap((dir) => [
    path.join(dir, 'statev2.sqlite'), path.join(dir, 'state.sqlite')
  ]))];
}

// Provider native ids survive switches. T3 app thread ids and shared provider
// session ids are not native conversation identities.
function t3TitleQueries(db, tables, providerDriver) {
  const queries = [];
  const columnsFor = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name)));
  const v2Threads = 'orchestration_v2_projection_threads';
  const v2Providers = 'orchestration_v2_projection_provider_threads';
  if (tables.has(v2Threads) && tables.has(v2Providers)) {
    const columns = columnsFor(v2Threads);
    const providerColumns = columnsFor(v2Providers);
    if (columns.has('title') && providerColumns.has('payload_json')
      && (providerColumns.has('driver') || providerColumns.has('provider'))) {
      const driver = providerColumns.has('driver')
        ? (providerColumns.has('provider') ? 'COALESCE(r.driver, r.provider)' : 'r.driver')
        : 'r.provider';
      queries.push({
        authoritative: true,
        // One malformed payload must not hide every other title in the batch.
        threadId: "(CASE WHEN json_valid(r.payload_json) THEN json_extract(r.payload_json, '$.nativeThreadRef.nativeId') END)",
        from: `FROM ${v2Threads} t JOIN ${v2Providers} r ON r.thread_id = t.thread_id`,
        // Tombstones still own the native id and suppress retained V1 titles.
        deleted: columns.has('deleted_at') ? '(t.deleted_at IS NOT NULL)' : '0',
        where: `${driver} = ? AND `,
        params: [providerDriver],
        order: columns.has('updated_at') ? ' ORDER BY t.updated_at DESC, t.thread_id' : ''
      });
    }
  }
  if (tables.has('projection_threads') && tables.has('provider_session_runtime')) {
    const columns = columnsFor('projection_threads');
    const runtimeColumns = columnsFor('provider_session_runtime');
    if (columns.has('title') && runtimeColumns.has('resume_cursor_json')
      && (providerDriver === 'codex' || runtimeColumns.has('provider_name'))) {
      queries.push({
        threadId: providerDriver === 'claudeAgent'
          ? "(CASE WHEN json_valid(r.resume_cursor_json) THEN json_extract(r.resume_cursor_json, '$.resume') END)"
          : "(json_extract(r.resume_cursor_json, '$.threadId'))",
        from: 'FROM projection_threads t JOIN provider_session_runtime r ON r.thread_id = t.thread_id',
        where: `${columns.has('deleted_at') ? 't.deleted_at IS NULL AND ' : ''}${runtimeColumns.has('provider_name') ? 'r.provider_name = ? AND ' : ''}`,
        params: runtimeColumns.has('provider_name') ? [providerDriver] : [],
        order: ''
      });
    }
  }
  return queries;
}

function readT3SessionMeta(sessionIds, deps = {}) {
  const providerDriver = deps.driver;
  if (!['codex', 'claudeAgent'].includes(providerDriver)) return new Map();
  const cleanTitle = deps.cleanTitle || cleanT3Title;
  const candidatesForId = deps.candidatesForId || ((id) => [id]);
  const ids = [...new Set(Array.from(sessionIds || []).map(String).filter(Boolean))];
  const out = new Map();
  if (ids.length === 0) return out;
  const sqliteMod = resolveSqlite(deps);
  if (!sqliteMod) return out;
  // Most machines do not run T3 at all, and a full tick can carry thousands of
  // sessions. Confirming the store exists before expanding every id into its
  // candidates keeps that case at one stat per known path; a missing store is
  // the same fail-closed answer the open below would give.
  const dbPaths = discoverT3DbPaths(deps).filter((dbPath) => {
    try { return fs.statSync(dbPath).isFile(); } catch (_) { return false; }
  });
  if (dbPaths.length === 0) return out;
  // Codex supplies rollout-id expansion; Claude matches its native session id
  // exactly. Neither provider may match a T3 app id or shared runtime session.
  const candidatesBySession = new Map(ids.map((id) => [id, candidatesForId(id)]));
  const candidateIds = [...new Set([...candidatesBySession.values()].flat())];
  const titleByThreadId = new Map();
  const v2SeenThreadIds = new Set();
  const v2UnavailableTitleIds = new Set();
  const legacyTitles = new Map();

  for (const dbPath of dbPaths) {
    let db;
    try {
      db = openDb(dbPath, sqliteMod);
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)));
      for (const query of t3TitleQueries(db, tables, providerDriver)) {
        for (let offset = 0; offset < candidateIds.length; offset += QUERY_CHUNK_SIZE) {
          const chunk = candidateIds.slice(offset, offset + QUERY_CHUNK_SIZE).filter(
            (id) => !v2SeenThreadIds.has(id) && (query.authoritative || !legacyTitles.has(id))
          );
          if (chunk.length === 0) continue;
          const placeholders = chunk.map(() => '?').join(',');
          const sql = `SELECT ${query.threadId} AS cursorThreadId, t.title AS title, ${query.deleted || '0'} AS deleted
                       ${query.from}
                       WHERE ${query.where}${query.threadId} IN (${placeholders})${query.order}`;
          for (const row of db.prepare(sql).all(...query.params, ...chunk)) {
            const threadId = cleanText(row.cursorThreadId);
            if (!threadId || v2SeenThreadIds.has(threadId)) continue;
            if (query.authoritative) {
              v2SeenThreadIds.add(threadId);
              if (row.deleted) {
                v2UnavailableTitleIds.add(threadId);
                continue;
              }
            } else if (legacyTitles.has(threadId)) continue;
            const title = cleanTitle(row.title);
            if (!title || T3_DEFAULT_TITLES.has(title.toLowerCase())) {
              if (query.authoritative) v2UnavailableTitleIds.add(threadId);
              continue;
            }
            (query.authoritative ? titleByThreadId : legacyTitles).set(threadId, title);
          }
        }
      }
    } catch (_) { /* skip missing, locked, or incompatible databases */ } finally {
      if (db) { try { db.close(); } catch (_) {} }
    }
  }
  // A later V2 database also shadows an earlier legacy match. Delay fallback
  // until every store has been checked, without keeping their connections open.
  for (const [threadId, title] of legacyTitles) {
    if (!v2SeenThreadIds.has(threadId)) titleByThreadId.set(threadId, title);
  }
  for (const [sessionId, candidates] of candidatesBySession) {
    const title = candidates.map((id) => titleByThreadId.get(id)).find(Boolean);
    if (title) out.set(sessionId, { title });
    // Authoritative absence of a usable title invalidates an override; read
    // failures and absent stores do not prove the title was removed.
    else if (deps.invalidatedSessionIds instanceof Set && candidates.some((id) => v2UnavailableTitleIds.has(id))) {
      deps.invalidatedSessionIds.add(sessionId);
    }
  }
  return out;
}

// Only app-owned delegation is a parent link. In particular, a human fork is
// not a subagent, and the parent's currently active provider may have changed
// since it dispatched the task. The execution root records the launch identity.

// App identity survives provider switches and accepted historical attempts.
// Require strong driver-matching refs and provider/thread/root ownership.
// Delegation requires explicit subagent lineage plus forkedFrom.nodeId pointing
// to a subagent node under its launching root. Running app-owned tasks may lack
// provider_thread_id: projection_subagents must then prove origin, parent and
// child_thread_id. Completed nodes may instead name their child provider.
// Never use the parent's current default provider, human forks or prompt text.
function readT3SessionRelationResult(nativeIds, deps = {}) {
  const ids = [...new Set(Array.from(nativeIds || []).map(String).filter(Boolean))];
  const requested = new Set(ids);
  const uuidIds = [...new Set(ids.filter(id => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)).map(id => id.toLowerCase()))];
  const requestedUuids = new Set(uuidIds);
  const out = new Map();
  const ambiguous = new Set();
  const ambiguousParents = new Set();
  const sqlite = resolveSqlite(deps);
  if (!ids.length) return { facts: out, status: 'complete' };
  if (!sqlite) return { facts: out, status: 'unavailable' };
  let status = 'complete';
  const names = {
    t: 'orchestration_v2_projection_threads',
    p: 'orchestration_v2_projection_provider_threads',
    n: 'orchestration_v2_projection_nodes',
    a: 'orchestration_v2_projection_run_attempts',
    s: 'orchestration_v2_projection_subagents'
  };
  const json = alias => `CASE WHEN json_valid(${alias}.payload_json) THEN ${alias}.payload_json ELSE '{}' END`;
  const native = (alias, field) => `json_extract(${json(alias)}, '$.nativeThreadRef.${field}')`;
  for (const file of discoverT3DbPaths(deps)) {
    let db;
    let complete = false;
    const facts = new Map();
    const conflicts = new Set();
    const parentConflicts = new Set();
    try {
      if (!fs.statSync(file).isFile()) continue;
      db = openDb(file, sqlite);
      // Stage each store: later query failures must not publish partial facts.
      const columns = Object.fromEntries(Object.entries(names).map(([key, name]) =>
        [key, new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name))]));
      const has = (key, fields) => fields.every(field => columns[key].has(field));
      if (!has('t', ['thread_id', 'deleted_at', 'payload_json'])
        || !has('p', ['provider_thread_id', 'thread_id', 'driver', 'payload_json'])) {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
        if (tables.length && status === 'complete') status = 'unavailable';
        continue;
      }
      const bindings = readT3IdentityBindings(file);
      const instance = alias => {
        const payloadId = `json_extract(${json(alias)}, '$.providerInstanceId')`;
        return columns.p.has('provider_instance_id')
          ? `(CASE WHEN ${payloadId} IS NULL OR ${payloadId} = ${alias}.provider_instance_id THEN ${alias}.provider_instance_id END)`
          : payloadId;
      };
      const strong = `${native('p', 'driver')} = p.driver AND ${native('p', 'strength')} = 'strong'`;
      const add = row => {
        const client = t3AccountingClient(row.driver, row.instanceId, bindings);
        const id = nativeAccountingId(client, row.nativeId, row.historical);
        const threadId = cleanText(row.threadId);
        if (!client || !id || !threadId || (!requested.has(id)
          && !(['codex', 'claude'].includes(client) && requestedUuids.has(id)))) return;
        const key = `${client}:${id}`;
        if (conflicts.has(key)) return;
        if (facts.has(key) && facts.get(key).threadId !== threadId) {
          facts.delete(key); conflicts.add(key);
        } else if (!facts.has(key)) facts.set(key, { threadId });
      };
      // IDs live in unindexed JSON in current T3 schemas. One candidate pass
      // per table avoids rescanning all providers for every 400-ID batch. The
      // target filters precede the indexed ownership joins.
      const idJson = JSON.stringify(ids);
      const uuidJson = JSON.stringify(uuidIds);
      const sql = `SELECT p.driver, ${instance('p')} AS instanceId, ${native('p', 'nativeId')} AS nativeId, p.thread_id AS threadId
        FROM ${names.p} p CROSS JOIN ${names.t} t ON t.thread_id = p.thread_id
        WHERE (${native('p', 'nativeId')} IN (SELECT value FROM json_each(?))
          OR lower(${native('p', 'nativeId')}) IN (SELECT value FROM json_each(?)))
          AND t.deleted_at IS NULL AND ${strong}`;
      for (const row of db.prepare(sql).all(idJson, uuidJson)) add(row);
      // T3 stamps nativeThreadId after a provider turn starts. It is retained
      // when steering supersedes a started turn or a restart replaces the native
      // reference. Superseded attempts can already have accounted usage.
      // Validate the attempt's provider and root ownership before using it.
      // Pin join order: SQLite otherwise scans every message/tool node first.
      if (has('a', ['thread_id', 'provider_thread_id', 'root_node_id', 'status', 'payload_json'])
          && has('n', ['node_id', 'thread_id', 'provider_thread_id', 'kind'])) {
        const history = `SELECT p.driver, 1 AS historical, ${instance('p')} AS instanceId,
            json_extract(${json('a')}, '$.nativeThreadId') AS nativeId, p.thread_id AS threadId
          FROM ${names.a} a
          CROSS JOIN ${names.p} p ON p.provider_thread_id = a.provider_thread_id AND p.thread_id = a.thread_id
          CROSS JOIN ${names.t} t ON t.thread_id = p.thread_id
          CROSS JOIN ${names.n} root ON root.node_id = a.root_node_id
            AND root.thread_id = a.thread_id AND root.provider_thread_id = a.provider_thread_id
            AND root.kind = 'root_turn'
          WHERE a.status IN ('running', 'completed', 'failed', 'interrupted', 'cancelled', 'superseded')
            AND (json_extract(${json('a')}, '$.nativeThreadId') IN (SELECT value FROM json_each(?))
              OR lower(json_extract(${json('a')}, '$.nativeThreadId')) IN (SELECT value FROM json_each(?)))
            AND t.deleted_at IS NULL AND ${strong}`;
        for (const row of db.prepare(history).all(idJson, uuidJson)) add(row);
      }
      if (!has('n', ['node_id', 'thread_id', 'root_node_id', 'kind', 'provider_thread_id'])) {
        complete = true;
        continue;
      }
      const threads = [...new Set([...facts.values()].map(fact => fact.threadId))];
      const links = new Map();
      const conflictingThreads = new Set();
      const hasTasks = has('s', ['subagent_id', 'thread_id', 'child_thread_id', 'origin']);
      for (let offset = 0; offset < threads.length; offset += QUERY_CHUNK_SIZE) {
        const chunk = threads.slice(offset, offset + QUERY_CHUNK_SIZE);
        // The referenced delegation node is a primary-key lookup, not a scan
        // of tool/messages. Its launching root proves the parent. A child's
        // later provider threads still belong to that same child app thread.
        // App-owned nodes start with provider_thread_id=NULL and receive the
        // child provider only on completion. The subagent record's explicit
        // child_thread_id binds running work without guessing from a title.
        const sql = `SELECT cp.thread_id AS childThreadId, pp.thread_id AS parentThreadId,
          pp.driver AS parentDriver, ${instance('pp')} AS parentInstanceId, ${native('pp', 'nativeId')} AS parentId
          FROM ${names.p} cp CROSS JOIN ${names.t} t ON cp.thread_id = t.thread_id
          CROSS JOIN ${names.n} n ON n.node_id = json_extract(${json('t')}, '$.forkedFrom.nodeId')
            AND n.kind = 'subagent'
            AND n.thread_id = json_extract(${json('t')}, '$.lineage.parentThreadId')
          LEFT JOIN ${names.p} initial ON initial.provider_thread_id = n.provider_thread_id
            AND initial.thread_id = cp.thread_id
          ${hasTasks ? `LEFT JOIN ${names.s} task ON task.subagent_id = n.node_id` : ''}
          JOIN ${names.n} root ON root.node_id = n.root_node_id
            AND root.kind = 'root_turn' AND root.thread_id = n.thread_id
          JOIN ${names.p} pp ON pp.provider_thread_id = root.provider_thread_id AND pp.thread_id = n.thread_id
          JOIN ${names.t} parent ON parent.thread_id = pp.thread_id
          WHERE t.deleted_at IS NULL AND parent.deleted_at IS NULL
            ${hasTasks ? `AND (task.subagent_id IS NULL OR (task.thread_id = n.thread_id AND task.child_thread_id = cp.thread_id))
            AND (initial.provider_thread_id IS NOT NULL OR (n.provider_thread_id IS NULL
              AND task.origin = 'app_owned' AND task.child_thread_id = cp.thread_id))`
    : 'AND initial.provider_thread_id IS NOT NULL'}
            AND json_extract(${json('t')}, '$.lineage.relationshipToParent') = 'subagent'
            AND json_extract(${json('t')}, '$.forkedFrom.type') = 'node'
            AND ${native('cp', 'driver')} = cp.driver AND ${native('cp', 'strength')} = 'strong'
            AND ${native('pp', 'driver')} = pp.driver AND ${native('pp', 'strength')} = 'strong'
            AND cp.thread_id IN (${chunk.map(() => '?').join(',')})`;
        for (const row of db.prepare(sql).all(...chunk)) {
          const parentClient = t3AccountingClient(row.parentDriver, row.parentInstanceId, bindings);
          const parentNativeId = nativeAccountingId(parentClient, row.parentId);
          if (!parentClient || !parentNativeId || row.childThreadId === row.parentThreadId) continue;
          const link = { parentThreadId: row.parentThreadId, parentClient, parentNativeId };
          const previous = links.get(row.childThreadId);
          if (previous && JSON.stringify(previous) !== JSON.stringify(link)) conflictingThreads.add(row.childThreadId);
          else links.set(row.childThreadId, link);
        }
      }
      for (const [key, fact] of facts) {
        const link = links.get(fact.threadId);
        if (conflictingThreads.has(fact.threadId) || (link && fact.parentThreadId
          && fact.parentThreadId !== link.parentThreadId)) {
          for (const field of ['parentThreadId', 'parentClient', 'parentNativeId']) delete fact[field];
          parentConflicts.add(key);
        } else if (link) Object.assign(fact, link);
      }
      complete = true;
    } catch (error) {
      // Extended SQLite error codes retain the base code in the low byte.
      // Empty/missing stores are valid; corruption and unsupported schemas wait
      // for the next full scan, while transient contention/resource failures defer migration.
      const code = Number(error.errcode) & 0xff;
      if ([5, 6].includes(code) || ['EBUSY', 'EAGAIN', 'EINTR', 'EMFILE', 'ENFILE'].includes(error.code)) status = 'retryable';
      else if (error.code !== 'ENOENT' && status === 'complete') status = 'unavailable';
    } finally {
      if (db) { try { db.close(); } catch (_) {} }
      if (complete) {
        for (const key of conflicts) { out.delete(key); ambiguous.add(key); }
        for (const key of parentConflicts) ambiguousParents.add(key);
        for (const [key, fact] of facts) {
          if (ambiguous.has(key)) continue;
          const previous = out.get(key);
          if (previous && previous.threadId !== fact.threadId) {
            out.delete(key); ambiguous.add(key);
            continue;
          }
          if (previous?.parentThreadId && fact.parentThreadId && (previous.parentThreadId !== fact.parentThreadId
            || previous.parentClient !== fact.parentClient || previous.parentNativeId !== fact.parentNativeId)) ambiguousParents.add(key);
          const merged = { ...previous, ...fact };
          if (ambiguousParents.has(key)) for (const field of ['parentThreadId', 'parentClient', 'parentNativeId']) delete merged[field];
          out.set(key, merged);
        }
      }
    }
  }
  return { facts: status === 'retryable' ? new Map() : out, status };
}

function readT3SessionRelations(nativeIds, deps = {}) {
  return readT3SessionRelationResult(nativeIds, deps).facts;
}

function readT3SessionParents(nativeIds, deps = {}) {
  return new Map([...readT3SessionRelations(nativeIds, deps)]
    .filter(([, fact]) => fact.parentClient && fact.parentNativeId)
    .map(([key, fact]) => [key, { parentClient: fact.parentClient, parentNativeId: fact.parentNativeId }]));
}

module.exports = { expandHomePath, t3HomeDir, discoverT3DbPaths, readT3SessionMeta, readT3SessionParents, readT3SessionRelations, readT3SessionRelationResult };
