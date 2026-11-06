'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { sameCycle, hourStart, dayKey, trendBounds, observationPoints, distribution } = require('../renderer/limits/historyModel');

// Independent flags: an ordinary interruption must still break the visible
// curve even when the same interval also lost its allowance.
const BREAK_INTERRUPTED = 1;
const BREAK_ALLOWANCE_MISSING = 2;

function retentionStart(now, days) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days + 1);
  return date.getTime();
}

// This module runs in historyWorker, never on Electron's main thread. Daily
// totals and detailed observations commit together; retention cannot erase a
// detail that has not already contributed to its daily summary.
function createHistoryDatabase(filePath, { onError = () => {} } = {}) {
  let persistent = true;
  let saveFailed = false;
  let database;
  let maintainedDay = '';
  function open(location) {
    const db = new DatabaseSync(location);
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) throw new Error('Unsupported quota history database');
      db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;
        PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA auto_vacuum = INCREMENTAL;
        CREATE TABLE IF NOT EXISTS streams (
          id TEXT PRIMARY KEY, account TEXT NOT NULL, source TEXT NOT NULL DEFAULT '',
          guarded INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS streams_account ON streams(account);
        CREATE TABLE IF NOT EXISTS runs (
          id INTEGER PRIMARY KEY, stream TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
          at INTEGER NOT NULL, until INTEGER NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL,
          balance INTEGER NOT NULL, reset INTEGER, interval INTEGER NOT NULL, break_after INTEGER NOT NULL DEFAULT 0,
          uncertain_before INTEGER NOT NULL DEFAULT 0, uncertain_until INTEGER
        );
        CREATE INDEX IF NOT EXISTS runs_stream_until ON runs(stream, until);
        CREATE TABLE IF NOT EXISTS coverage (
          run INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE, hour INTEGER NOT NULL,
          at INTEGER NOT NULL, until INTEGER NOT NULL, samples INTEGER NOT NULL, max_gap INTEGER NOT NULL,
          PRIMARY KEY(run, hour)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS coverage_until ON coverage(until);
        CREATE TABLE IF NOT EXISTS daily (
          stream TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE, day TEXT NOT NULL,
          value REAL, observations INTEGER NOT NULL DEFAULT 0, uncertain INTEGER NOT NULL DEFAULT 0,
          unallocated REAL NOT NULL DEFAULT 0, resets INTEGER NOT NULL DEFAULT 0,
          first_at INTEGER, last_at INTEGER, first_value REAL, last_value REAL,
          PRIMARY KEY(stream, day)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS history_origins (
          stream TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE, source TEXT NOT NULL,
          at INTEGER NOT NULL, PRIMARY KEY(stream, source)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS history_run_sources (
          run INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE, source TEXT NOT NULL,
          first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, samples INTEGER NOT NULL,
          PRIMARY KEY(run, source)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS run_basis (
          run INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, basis TEXT NOT NULL
        );
        PRAGMA user_version = 1;`);
      return db;
    } catch (error) { db.close(); throw error; }
  }
  try {
    if (filePath !== ':memory:') {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
      try {
        if (!fs.fstatSync(descriptor).isFile()) throw new Error('Quota history must be a regular file');
        if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
      } finally { fs.closeSync(descriptor); }
    }
    database = open(filePath);
  } catch (error) {
    persistent = false;
    onError(error);
    database = open(':memory:');
  }
  const sql = text => database.prepare(text);
  const latest = sql('SELECT r.*, b.basis FROM runs r LEFT JOIN run_basis b ON b.run = r.id WHERE r.stream = ? ORDER BY r.until DESC LIMIT 1');
  const streamInsert = sql('INSERT OR IGNORE INTO streams(id, account) VALUES (?, ?)');
  const runInsert = sql('INSERT INTO runs(stream, at, until, value, unit, balance, reset, interval) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const runExtend = sql('UPDATE runs SET until = ? WHERE id = ?');
  const cover = sql(`INSERT INTO coverage VALUES (?, ?, ?, ?, 1, 0) ON CONFLICT(run, hour) DO UPDATE SET
    until = excluded.until, samples = samples + 1, max_gap = MAX(max_gap, ?)`);
  const dailyObserve = sql(`INSERT INTO daily(stream, day, observations, first_at, last_at, first_value, last_value)
    VALUES (?, ?, 1, ?, ?, ?, ?) ON CONFLICT(stream, day) DO UPDATE SET observations = observations + 1,
    last_at = excluded.last_at, last_value = excluded.last_value`);
  const dailyValue = sql('UPDATE daily SET value = COALESCE(value, 0) + ? WHERE stream = ? AND day = ?');
  const dailyUnknown = sql(`INSERT INTO daily(stream, day, uncertain) VALUES (?, ?, 1)
    ON CONFLICT(stream, day) DO UPDATE SET uncertain = 1`);
  const dailyExtra = sql('UPDATE daily SET unallocated = unallocated + ?, resets = resets + ? WHERE stream = ? AND day = ?');
  const headFor = sql('SELECT source, guarded, failed FROM streams WHERE id = ?');
  const setHead = sql('UPDATE streams SET source = ?, guarded = ?, failed = 0 WHERE id = ?');
  const originFor = sql('SELECT at FROM history_origins WHERE stream = ? AND source = ?');
  const noteOrigin = sql(`INSERT INTO history_origins VALUES (?, ?, ?)
    ON CONFLICT(stream, source) DO UPDATE SET at = excluded.at`);
  const noteSource = sql(`INSERT INTO history_run_sources VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(run, source) DO UPDATE SET last_at = excluded.last_at, samples = samples + 1`);
  const breakRun = sql(`UPDATE runs SET break_after = break_after | ${BREAK_INTERRUPTED} WHERE id = ?`);
  const markInterruption = sql('UPDATE runs SET break_after = break_after | ?, uncertain_until = MAX(COALESCE(uncertain_until, until), ?) WHERE id = ?');
  const markFailed = sql('UPDATE streams SET failed = 1 WHERE id = ?');
  const guardHead = sql('UPDATE streams SET guarded = 1 WHERE id = ?');
  const ambiguousStart = sql('UPDATE runs SET uncertain_before = 1 WHERE id = ?');
  const basisInsert = sql('INSERT INTO run_basis VALUES (?, ?)');
  const failAccount = sql(`SELECT r.id, r.until, s.id AS stream FROM streams s
    JOIN runs r ON r.id = (SELECT id FROM runs WHERE stream = s.id ORDER BY until DESC LIMIT 1)
    WHERE s.account = ? AND s.source = ?`);
  function pointOf(run) {
    return run && { at: run.until, value: run.value, unit: run.unit, balance: !!run.balance, ...(run.basis ? { basis: run.basis } : {}),
      reset: run.reset, interval: run.interval, uncertainUntil: run.uncertain_until };
  }
  function noteDaily(stream, previous, point, interruption, now, ambiguous = false) {
    const day = dayKey(point.at);
    dailyObserve.run(stream, day, point.at, point.at, point.value, point.value);
    if (!previous) return;
    const reset = !ambiguous && !sameCycle(previous, point);
    const allowanceRecovered = interruption === BREAK_ALLOWANCE_MISSING && sameCycle(previous, point);
    const comparable = sameCycle(previous, point) && (previous.uncertainUntil == null || allowanceRecovered);
    const gap = ambiguous || interruption || point.at - previous.at > Math.max(previous.interval, point.interval) * 2.5;
    const delta = reset || ambiguous && !sameCycle(previous, point) ? 0 : Math.max(0, point.balance ? previous.value - point.value : point.value - previous.value);
    const crossDay = dayKey(previous.at) !== day;
    if (!reset && (!gap || comparable) && !crossDay) dailyValue.run(delta, stream, day);
    if (reset || gap || crossDay && delta > 0) {
      const date = new Date(Math.max(previous.at, retentionStart(now, 730)));
      date.setHours(0, 0, 0, 0);
      for (; date.getTime() <= point.at; date.setDate(date.getDate() + 1)) dailyUnknown.run(stream, dayKey(date.getTime()));
    }
    dailyExtra.run(!reset && (crossDay || gap && !comparable) ? delta : 0, reset ? 1 : 0, stream, day);
  }

  function interrupt(stream, tail, point, now, reason = BREAK_INTERRUPTED) {
    markInterruption.run(reason, point.at, tail.id);
    const date = new Date(Math.max(tail.until, retentionStart(now, 730)));
    date.setHours(0, 0, 0, 0);
    for (; date.getTime() <= point.at; date.setDate(date.getDate() + 1)) dailyUnknown.run(stream, dayKey(date.getTime()));
  }

  function conflict(stream, tail, point, now) {
    guardHead.run(stream);
    interrupt(stream, tail, point, now);
  }

  function prune(now) {
    if (maintainedDay === dayKey(now)) return;
    const detailStart = retentionStart(now, 180);
    database.prepare('DELETE FROM daily WHERE day < ?').run(dayKey(retentionStart(now, 730)));
    database.prepare('DELETE FROM coverage WHERE until < ?').run(detailStart);
    // Keep one last actual reading for gap/reset detection when an idle account
    // returns. It is a baseline, not queryable detail outside the 180-day range.
    database.exec(`DELETE FROM runs WHERE NOT EXISTS (SELECT 1 FROM coverage WHERE run = runs.id)
      AND EXISTS (SELECT 1 FROM runs newer WHERE newer.stream = runs.stream AND newer.until > runs.until);
      UPDATE runs SET uncertain_before = 0, at = (SELECT MIN(at) FROM coverage WHERE run = runs.id)
      WHERE at < ${detailStart} AND EXISTS (SELECT 1 FROM coverage WHERE run = runs.id);
      DELETE FROM streams WHERE NOT EXISTS (SELECT 1 FROM daily WHERE stream = streams.id)
      AND NOT EXISTS (SELECT 1 FROM runs WHERE stream = streams.id);`);
    database.prepare('DELETE FROM history_origins WHERE at < ?').run(retentionStart(now, 730));
    database.prepare('DELETE FROM history_run_sources WHERE last_at < ?').run(detailStart);
    database.prepare(`DELETE FROM streams WHERE NOT EXISTS (SELECT 1 FROM daily WHERE stream = streams.id)
      AND NOT EXISTS (SELECT 1 FROM runs WHERE stream = streams.id AND until >= ?)`).run(retentionStart(now, 730));
  }
  function transaction(action, now) {
    let began = false;
    try {
      database.exec('BEGIN IMMEDIATE');
      began = true;
      action();
      prune(now);
      database.exec('COMMIT');
      maintainedDay = dayKey(now);
    } catch (error) {
      if (began) database.exec('ROLLBACK');
      saveFailed = true;
      onError(error);
      throw error;
    }
  }
  function record(actions, now) {
    transaction(() => {
      for (const action of actions) {
        const source = action.source || '';
        if (action.failed) {
          for (const row of failAccount.all(action.account, source)) {
            breakRun.run(row.id);
            markFailed.run(row.stream);
          }
          continue;
        }
        if (action.snapshotAt !== undefined) {
          if (action.snapshotAt < retentionStart(now, 730) || action.snapshotAt > now + 60_000) continue;
          const present = new Set(action.windows.map(window => window.id));
          for (const tail of failAccount.all(action.account, source)) {
            const origin = originFor.get(tail.stream, source);
            if (present.has(tail.stream) || action.snapshotAt <= tail.until || origin && action.snapshotAt <= origin.at) continue;
            noteOrigin.run(tail.stream, source, action.snapshotAt);
            interrupt(tail.stream, tail, { at: action.snapshotAt }, now);
            markFailed.run(tail.stream);
          }
        }
        for (const { id, point } of action.windows) {
          if (point.at < retentionStart(now, 730) || point.at > now + 60_000) continue;
          const origin = originFor.get(id, source);
          if (origin && point.at <= origin.at) continue;
          if (point.missing) {
            const tail = latest.get(id);
            if (tail && point.at > tail.until) {
              const head = headFor.get(id);
              const healthy = !head.failed && point.at - tail.until <= Math.max(tail.interval, point.interval) * 2.5;
              if (head.source !== source && healthy) continue;
              noteOrigin.run(id, source, point.at);
              interrupt(id, tail, point, now, BREAK_ALLOWANCE_MISSING);
              // The accepted replacement owns subsequent missing/failure reports.
              setHead.run(source, head.guarded, id);
              markFailed.run(id);
            }
            continue;
          }
          streamInsert.run(id, action.account);
          noteOrigin.run(id, source, point.at);
          const tail = latest.get(id);
          const head = headFor.get(id);
          const previous = pointOf(tail);
          const missingBasisOnly = !!previous?.basis && !point.basis
            && sameCycle(previous, { ...point, basis: previous.basis });
          if (tail && point.at <= tail.until) {
            if (point.at === tail.until) {
              if (head.source !== source && missingBasisOnly && tail.value === point.value) continue;
              if (tail.value !== point.value || !sameCycle(previous, point)) conflict(id, tail, point, now);
              else noteSource.run(tail.id, source, point.at, point.at);
            }
            continue;
          }
          const switched = !!tail && head.source !== source;
          const consistent = !tail || sameCycle(previous, point);
          const healthy = tail && !head?.failed && point.at - tail.until <= Math.max(tail.interval, point.interval) * 2.5;
          // Prefer continuity once sources disagree. A healthy observer is not
          // replaced by a contradictory or out-of-date observer. After it fails
          // or expires, the replacement starts an uncertain baseline, not a
          // fabricated reset or a jump in measured consumption.
          if (switched && healthy && (head.guarded || !consistent)) {
            // Omitted allowance metadata cannot establish a conflicting quota pool.
            if (!consistent && !missingBasisOnly) conflict(id, tail, point, now);
            continue;
          }
          const basisChanged = !!tail && (tail.basis || '') !== (point.basis || '');
          const ambiguous = basisChanged || switched && (!!head.guarded || !consistent || !healthy);
          const guarded = !!head?.guarded || ambiguous;
          if (switched && head.guarded) {
            // An established disagreement still blocks a compatible-looking
            // replacement from turning the source difference into consumption.
            interrupt(id, tail, point, now);
            tail.break_after |= BREAK_INTERRUPTED;
            previous.uncertainUntil = point.at;
          }
          noteDaily(id, previous, point, tail?.break_after || 0, now, ambiguous);
          let run;
          if (tail && !ambiguous && !tail.break_after && tail.value === point.value && tail.reset === point.reset && tail.interval === point.interval
            && consistent && point.at - previous.at <= point.interval * 2.5) {
            run = tail.id;
            runExtend.run(point.at, run);
          } else {
            run = Number(runInsert.run(id, point.at, point.at, point.value, point.unit, +point.balance, point.reset, point.interval).lastInsertRowid);
            if (point.basis) basisInsert.run(run, point.basis);
            if (ambiguous) ambiguousStart.run(run);
          }
          noteSource.run(run, source, point.at, point.at);
          setHead.run(source, +guarded, id);
          if (point.at >= retentionStart(now, 180)) cover.run(run, hourStart(point.at), point.at, point.at, previous ? point.at - previous.at : 0);
        }
      }
    }, now);
    saveFailed = false;
    return { persistent: persistent && !saveFailed };
  }
  function points(stream, from, to, baseline = false) {
    const rows = sql(`SELECT r.*, b.basis, c.at AS part_at, c.until AS part_until, c.hour, c.samples, c.max_gap
      FROM runs r JOIN coverage c ON c.run = r.id LEFT JOIN run_basis b ON b.run = r.id WHERE r.stream = ? AND r.until >= ? AND c.until >= ? AND c.at <= ?
      ORDER BY c.at`).all(stream, from, from, to);
    if (baseline) {
      const before = sql(`SELECT r.*, b.basis, c.at AS part_at, c.until AS part_until, c.hour, c.samples, c.max_gap
        FROM runs r JOIN coverage c ON c.run = r.id LEFT JOIN run_basis b ON b.run = r.id WHERE r.stream = ? AND c.until < ? ORDER BY c.until DESC LIMIT 1`).get(stream, from);
      if (before) rows.unshift(before);
    }
    const runs = [];
    for (const row of rows) {
      let run = runs.at(-1);
      if (!run || run.id !== row.id) {
        run = { id: row.id, ...pointOf(row), breakAfter: !!row.break_after, allowanceMissingAfter: row.break_after === BREAK_ALLOWANCE_MISSING,
          uncertainBefore: !!row.uncertain_before && row.part_at === row.at,
          uncertainUntil: row.uncertain_until, coverage: [] };
        runs.push(run);
      }
      run.coverage.push({ at: row.part_at, until: row.part_until, hour: row.hour, samples: row.samples, maxGap: row.max_gap });
    }
    return observationPoints(runs);
  }
  function query(windows, range, now) {
    if (maintainedDay !== dayKey(now)) transaction(() => {}, now);
    const anchor = new Date(`${range.day}T23:59:59.999`).getTime();
    const viewNow = Math.min(now, anchor);
    const detailSince = retentionStart(now, 180);
    return { persistent: persistent && !saveFailed, range, detailSince, since: retentionStart(now, 730), windows: windows.map(entry => {
      const options = { grain: range.grain, day: range.day, now: viewNow };
      let result;
      if (range.grain === 'hour') {
        const start = new Date(`${range.day}T00:00:00`).getTime();
        result = distribution(start < detailSince ? [] : points(entry.id, start, viewNow, true), options);
      } else {
        result = distribution([], options);
        const summaries = sql('SELECT * FROM daily WHERE stream = ? AND day >= ? AND day <= ?')
          .all(entry.id, result.buckets[0]?.key || range.day, range.day);
        const byDay = new Map(summaries.map(row => [row.day, row]));
        for (const bucket of result.buckets) {
          const row = byDay.get(bucket.key);
          if (!row) continue;
          Object.assign(bucket, { value: row.value, observations: row.observations, uncertain: !!row.uncertain });
          result.unallocated += row.unallocated;
          result.resets += row.resets;
        }
      }
      const { start: trendStart } = trendBounds(entry.window, now, entry.provider);
      return { key: entry.key, window: entry.window, ...(entry.unit ? { unit: entry.unit, balance: entry.balance } : {}), points: points(entry.id, Math.max(detailSince, trendStart), now),
        distribution: result, summaryOnly: new Date(`${range.day}T00:00:00`).getTime() < detailSince };
    }) };
  }
  return { record, query, close() { database.close(); } };
}
module.exports = { createHistoryDatabase, retentionStart };
