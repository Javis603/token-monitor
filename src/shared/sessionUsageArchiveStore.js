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
  const pendingKeys = new Set();

  function metadataValue(key) {
    return database.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value;
  }

  function setMetadataValue(key, value) {
    database.prepare(`
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  function writeEntries(keys) {
    const uniqueKeys = [...new Set(keys)].filter((key) => archive?.sessions?.[key]);
    if (uniqueKeys.length === 0) return revision;
    const upsert = database.prepare(`
      INSERT INTO sessions (session_key, entry_json, revision)
      VALUES (?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        entry_json = excluded.entry_json,
        revision = excluded.revision
    `);
    database.exec('BEGIN IMMEDIATE');
    try {
      const storedRevision = Number(metadataValue('revision') || 0);
      if (storedRevision > revision) {
        const pending = new Set(uniqueKeys);
        for (const row of database.prepare(`
          SELECT session_key, entry_json
          FROM sessions
          WHERE revision > ?
          ORDER BY revision, session_key
        `).all(revision)) {
          if (pending.has(row.session_key)) continue;
          const entry = parseRow(row);
          if (entry) archive.sessions[row.session_key] = entry;
        }
      }
      const nextRevision = storedRevision + 1;
      for (const key of uniqueKeys) {
        upsert.run(key, JSON.stringify(archive.sessions[key]), nextRevision);
      }
      setMetadataValue('revision', nextRevision);
      database.exec('COMMIT');
      revision = nextRevision;
      return revision;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  function migrateLegacyArchive() {
    if (metadataValue('legacy-migrated') === '1') return;
    const legacy = existsSync(legacyPath)
      ? normalizeSessionUsageArchive(JSON.parse(readFileSync(legacyPath, 'utf8')))
      : normalizeSessionUsageArchive({});
    archive = legacy;
    const keys = Object.keys(legacy.sessions);
    database.exec('BEGIN IMMEDIATE');
    try {
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
      database.exec('PRAGMA synchronous = NORMAL');
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
      `);
      const storedVersion = metadataValue('schema-version');
      if (storedVersion && Number(storedVersion) !== SESSION_ARCHIVE_DATABASE_VERSION) {
        throw new Error(`unsupported session archive database version: ${storedVersion}`);
      }
      if (!storedVersion) setMetadataValue('schema-version', SESSION_ARCHIVE_DATABASE_VERSION);
      migrateLegacyArchive();
      return database;
    } catch (error) {
      try { database.close(); } catch (_) {}
      database = null;
      throw error;
    }
  }

  function parseRow(row) {
    try {
      const normalized = normalizeSessionUsageArchive({ sessions: { [row.session_key]: JSON.parse(row.entry_json) } });
      return normalized.sessions[row.session_key] || Object.values(normalized.sessions)[0] || null;
    } catch (_) {
      return null;
    }
  }

  function loadRows() {
    ensureDatabase();
    if (archiveSource !== 'database') {
      archive = normalizeSessionUsageArchive({});
      for (const row of database.prepare('SELECT session_key, entry_json FROM sessions').all()) {
        const entry = parseRow(row);
        if (entry) archive.sessions[row.session_key] = entry;
      }
      revision = Number(metadataValue('revision') || 0);
      archiveSource = 'database';
    }
    return archive;
  }

  function loadAll(now = new Date()) {
    loadRows();
    const result = updateSessionUsageArchive(archive, null, now);
    for (const key of result.changedKeys) pendingKeys.add(key);
    flushPending();
    return archive;
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
      archive = existsSync(legacyPath)
        ? readSessionUsageArchive({ ...options, path: legacyPath })
        : normalizeSessionUsageArchive({});
      archiveSource = 'legacy';
      return archive;
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
      }
      revision = storedRevision;
    }
    return archive;
  }

  function flushPending() {
    if (pendingKeys.size === 0) return false;
    const keys = [...pendingKeys];
    writeEntries(keys);
    for (const key of keys) pendingKeys.delete(key);
    return true;
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
    const pruned = updateSessionUsageArchive(current, null, capturedAt);
    for (const key of pruned.changedKeys) pendingKeys.add(key);
    const result = updateSessionUsageArchive(current, deviceRecord, capturedAt, { canonicalSummary: true });
    for (const key of result.changedKeys) pendingKeys.add(key);
    let error = null;
    try {
      flushPending();
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
    pendingKeys.clear();
    let removed = false;
    for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, legacyPath]) {
      removed = removeIfPresent(filePath, unlinkSync) || removed;
    }
    return removed;
  }

  function close() {
    if (!database) return;
    try { flushPending(); } finally {
      database.close();
      database = null;
    }
  }

  return {
    capture,
    clear,
    close,
    flush: flushPending,
    read: loadAll,
    refresh,
    databasePath,
    legacyPath
  };
}

module.exports = {
  SESSION_ARCHIVE_DATABASE_VERSION,
  createSessionUsageArchiveStore,
  sessionUsageArchiveDatabasePath
};
