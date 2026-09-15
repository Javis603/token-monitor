'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { sharedDataDir } = require('./config');
const {
  normalizeSessionUsageArchive,
  readSessionUsageArchive,
  sessionUsageArchivePath,
  updateSessionUsageArchive
} = require('./sessionUsageArchive');

const SESSION_ARCHIVE_DATABASE_VERSION = 1;

function sessionUsageArchiveDatabasePath(options = {}) {
  return options.databasePath || path.join(sharedDataDir(options), 'session-usage-archive.sqlite');
}

function removeIfPresent(filePath, unlinkSync = fs.unlinkSync) {
  try {
    unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function parseArchiveRow(row) {
  try {
    const normalized = normalizeSessionUsageArchive({ sessions: { [row.session_key]: JSON.parse(row.entry_json) } });
    return normalized.sessions[row.session_key] || Object.values(normalized.sessions)[0] || null;
  } catch (_) {
    return null;
  }
}

function readMigratedArchiveSnapshot(options = {}) {
  const databasePath = sessionUsageArchiveDatabasePath(options);
  const Database = options.DatabaseSync || DatabaseSync;
  const existsSync = options.existsSync || fs.existsSync;
  if (!existsSync(databasePath)) return null;

  let database = null;
  try {
    database = new Database(databasePath, { readOnly: true });
    const rows = database.prepare(`
      SELECT key, value
      FROM metadata
      WHERE key IN ('schema-version', 'legacy-migrated', 'pruned-day', 'pruned-month')
    `).all();
    const metadata = new Map(rows.map((row) => [row.key, row.value]));
    if (Number(metadata.get('schema-version')) !== SESSION_ARCHIVE_DATABASE_VERSION
      || metadata.get('legacy-migrated') !== '1') return null;

    const archive = normalizeSessionUsageArchive({});
    if (metadata.get('pruned-day')) archive.prunedDay = metadata.get('pruned-day');
    if (metadata.get('pruned-month')) archive.prunedMonth = metadata.get('pruned-month');
    for (const row of database.prepare('SELECT session_key, entry_json FROM sessions').all()) {
      const entry = parseArchiveRow(row);
      if (entry) archive.sessions[row.session_key] = entry;
    }
    return archive;
  } catch (_) {
    return null;
  } finally {
    try { database?.close(); } catch (_) {}
  }
}

function readSessionUsageArchiveSnapshot(options = {}) {
  const migrated = readMigratedArchiveSnapshot(options);
  if (migrated) return migrated;

  const legacyPath = sessionUsageArchivePath(options);
  const existsSync = options.existsSync || fs.existsSync;
  if (!existsSync(legacyPath)) {
    return readMigratedArchiveSnapshot(options) || normalizeSessionUsageArchive({});
  }

  const legacy = readSessionUsageArchive({ ...options, path: legacyPath });
  return readMigratedArchiveSnapshot(options) || legacy;
}

function createSessionUsageArchiveStore(options = {}) {
  const databasePath = sessionUsageArchiveDatabasePath(options);
  const legacyPath = sessionUsageArchivePath(options);
  const Database = options.DatabaseSync || DatabaseSync;
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const unlinkSync = options.unlinkSync || fs.unlinkSync;
  let database = null;
  let archive = null;
  let archiveSource = null;
  let revision = 0;
  let reloadRequired = false;

  function metadataValue(key) {
    return database.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value;
  }

  function setMetadataValue(key, value) {
    database.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  function loadRevisedRows(sinceRevision) {
    for (const row of database.prepare(`
      SELECT session_key, entry_json
      FROM sessions
      WHERE revision > ?
      ORDER BY revision, session_key
    `).all(sinceRevision)) {
      const entry = parseRow(row);
      if (entry) archive.sessions[row.session_key] = entry;
      else delete archive.sessions[row.session_key];
    }
  }

  function upsertEntries(keys, nextRevision) {
    const upsert = database.prepare(`
      INSERT INTO sessions (session_key, entry_json, revision)
      VALUES (?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        entry_json = excluded.entry_json,
        revision = excluded.revision
    `);
    for (const key of keys) {
      upsert.run(key, JSON.stringify(archive.sessions[key]), nextRevision);
    }
  }

  function migrateLegacyArchive() {
    if (metadataValue('legacy-migrated') === '1') return;
    database.exec('BEGIN IMMEDIATE');
    try {
      if (metadataValue('legacy-migrated') === '1') {
        database.exec('COMMIT');
        return;
      }
      const legacy = existsSync(legacyPath)
        ? normalizeSessionUsageArchive(JSON.parse(readFileSync(legacyPath, 'utf8')))
        : normalizeSessionUsageArchive({});
      archive = legacy;
      const keys = Object.keys(legacy.sessions);
      const upsert = database.prepare(`
        INSERT INTO sessions (session_key, entry_json, revision)
        VALUES (?, ?, 1)
        ON CONFLICT(session_key) DO UPDATE SET entry_json = excluded.entry_json, revision = 1
      `);
      for (const key of keys) upsert.run(key, JSON.stringify(legacy.sessions[key]));
      setMetadataValue('revision', keys.length > 0 ? 1 : 0);
      setMetadataValue('legacy-migrated', 1);
      const count = Number(database.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count || 0);
      if (count !== keys.length) throw new Error(`session archive migration count mismatch (${count}/${keys.length})`);
      database.exec('COMMIT');
      revision = keys.length > 0 ? 1 : 0;
      archiveSource = 'database';
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch (_) {}
      archive = null;
      archiveSource = null;
      throw error;
    }
    if (existsSync(legacyPath)) {
      try {
        removeIfPresent(legacyPath, unlinkSync);
      } catch (error) {
        // SQLite is already committed and marked migrated. Leaving the legacy
        // file behind costs disk space but cannot be allowed to disable usage.
        options.onError?.(error, 'legacy-cleanup');
      }
    }
  }

  function ensureDatabase() {
    if (database) return database;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    database = new Database(databasePath);
    try {
      database.exec('PRAGMA journal_mode = WAL');
      // The one-time migration deletes the legacy JSON after its transaction
      // commits. FULL makes that handoff durable across an OS crash or power
      // loss; steady-state row updates return to NORMAL below.
      database.exec('PRAGMA synchronous = FULL');
      database.exec('PRAGMA busy_timeout = 5000');
      database.exec(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          session_key TEXT PRIMARY KEY,
          entry_json TEXT NOT NULL,
          revision INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_revision_idx
          ON sessions(revision, session_key);
      `);
      const storedVersion = metadataValue('schema-version');
      if (storedVersion && Number(storedVersion) !== SESSION_ARCHIVE_DATABASE_VERSION) {
        throw new Error(`unsupported session archive database version: ${storedVersion}`);
      }
      if (!storedVersion) setMetadataValue('schema-version', SESSION_ARCHIVE_DATABASE_VERSION);
      migrateLegacyArchive();
      database.exec('PRAGMA synchronous = NORMAL');
      return database;
    } catch (error) {
      try { database.close(); } catch (_) {}
      database = null;
      throw error;
    }
  }

  function parseRow(row) {
    return parseArchiveRow(row);
  }

  function loadRows() {
    ensureDatabase();
    if (archiveSource !== 'database' || reloadRequired) {
      // Record the metadata boundary before scanning rows. A concurrent commit
      // can then make this revision temporarily stale, but never make it skip a
      // row that the scan did not load; refresh will safely replay newer rows.
      const loadedRevision = Number(metadataValue('revision') || 0);
      const prunedDay = metadataValue('pruned-day');
      const prunedMonth = metadataValue('pruned-month');
      archive = normalizeSessionUsageArchive({});
      for (const row of database.prepare('SELECT session_key, entry_json FROM sessions').all()) {
        const entry = parseRow(row);
        if (entry) archive.sessions[row.session_key] = entry;
      }
      if (prunedDay) archive.prunedDay = prunedDay;
      if (prunedMonth) archive.prunedMonth = prunedMonth;
      revision = loadedRevision;
      archiveSource = 'database';
      reloadRequired = false;
    }
    return archive;
  }

  function loadAll(now = new Date()) {
    loadRows();
    return mutateArchive((current) => updateSessionUsageArchive(current, null, now)).archive;
  }

  function databaseIsMigrated() {
    let candidate = null;
    try {
      candidate = new Database(databasePath, { readOnly: true });
      const rows = candidate.prepare(`
        SELECT key, value
        FROM metadata
        WHERE key IN ('schema-version', 'legacy-migrated')
      `).all();
      const metadata = new Map(rows.map((row) => [row.key, row.value]));
      return Number(metadata.get('schema-version')) === SESSION_ARCHIVE_DATABASE_VERSION
        && metadata.get('legacy-migrated') === '1';
    } catch (_) {
      return false;
    } finally {
      try { candidate?.close(); } catch (_) {}
    }
  }

  function refresh() {
    // A widget that yielded ownership to the headless agent must not race that
    // agent's one-time migration. Until the writer commits the migration marker,
    // the legacy JSON remains an atomic, read-only fallback.
    if (!database && (!existsSync(databasePath) || !databaseIsMigrated())) {
      const snapshot = readSessionUsageArchiveSnapshot({ ...options, databasePath, path: legacyPath });
      if (!existsSync(databasePath) || !databaseIsMigrated()) {
        archive = snapshot;
        archiveSource = 'legacy';
        return archive;
      }
    }
    ensureDatabase();
    loadRows();
    const storedRevision = Number(metadataValue('revision') || 0);
    if (storedRevision > revision) {
      for (const row of database.prepare(`
        SELECT session_key, entry_json, revision
        FROM sessions
        WHERE revision > ?
        ORDER BY revision, session_key
      `).all(revision)) {
        const entry = parseRow(row);
        if (entry) archive.sessions[row.session_key] = entry;
        else delete archive.sessions[row.session_key];
      }
      revision = storedRevision;
    }
    return archive;
  }

  function mutateArchive(mutate) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const storedRevision = Number(metadataValue('revision') || 0);
      if (storedRevision > revision) loadRevisedRows(revision);
      const storedPrunedDay = metadataValue('pruned-day');
      const storedPrunedMonth = metadataValue('pruned-month');
      if (storedPrunedDay && (!archive.prunedDay || archive.prunedDay < storedPrunedDay)) {
        archive.prunedDay = storedPrunedDay;
      }
      if (storedPrunedMonth && (!archive.prunedMonth || archive.prunedMonth < storedPrunedMonth)) {
        archive.prunedMonth = storedPrunedMonth;
      }
      const result = mutate(archive);
      const keys = [...result.changedKeys].filter((key) => archive?.sessions?.[key]);
      let nextRevision = storedRevision;
      if (keys.length > 0) {
        nextRevision = storedRevision + 1;
        upsertEntries(keys, nextRevision);
        setMetadataValue('revision', nextRevision);
      }
      if (archive.prunedDay && archive.prunedDay !== storedPrunedDay) {
        setMetadataValue('pruned-day', archive.prunedDay);
      }
      if (archive.prunedMonth && archive.prunedMonth !== storedPrunedMonth) {
        setMetadataValue('pruned-month', archive.prunedMonth);
      }
      database.exec('COMMIT');
      revision = nextRevision;
      return result;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch (_) {}
      // The in-memory entries may already contain a mutation that SQLite did
      // not commit. Keep that snapshot available to the current caller, but
      // reload the database before another mutation instead of retrying a
      // materialized row that can no longer be safely rebased.
      reloadRequired = true;
      throw error;
    }
  }

  function capture(deviceRecord, capturedAt = new Date()) {
    let current;
    try {
      current = loadRows();
    } catch (error) {
      return {
        archive: archive || normalizeSessionUsageArchive({}),
        changedKeys: new Set(),
        error
      };
    }
    let pruned = { archive: current, changedKeys: new Set() };
    let result = { archive: current, changedKeys: new Set() };
    let error = null;
    try {
      mutateArchive((latest) => {
        pruned = updateSessionUsageArchive(latest, null, capturedAt);
        result = updateSessionUsageArchive(latest, deviceRecord, capturedAt, { canonicalSummary: true });
        return {
          archive: result.archive,
          changedKeys: new Set([...pruned.changedKeys, ...result.changedKeys])
        };
      });
    } catch (cause) {
      error = cause;
    }
    return {
      archive: result.archive,
      changedKeys: new Set([...pruned.changedKeys, ...result.changedKeys]),
      error
    };
  }

  function clear() {
    close();
    archive = normalizeSessionUsageArchive({});
    archiveSource = null;
    revision = 0;
    reloadRequired = false;
    let removed = false;
    for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, legacyPath]) {
      removed = removeIfPresent(filePath, unlinkSync) || removed;
    }
    return removed;
  }

  function close() {
    if (!database) return;
    database.close();
    database = null;
  }

  return {
    capture,
    clear,
    close,
    read: loadAll,
    refresh,
    databasePath,
    legacyPath
  };
}

module.exports = {
  SESSION_ARCHIVE_DATABASE_VERSION,
  createSessionUsageArchiveStore,
  readSessionUsageArchiveSnapshot,
  sessionUsageArchiveDatabasePath
};
