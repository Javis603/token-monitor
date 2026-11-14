'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { sameCycle, hourStart, dayKey, trendBounds, observationPoints, distribution } = require('../renderer/limits/historyModel');

// Independent flags: an ordinary interruption must still break the visible
// curve even when the same interval also lost its allowance.
const BREAK_INTERRUPTED = 1;
const BREAK_ALLOWANCE_MISSING = 2;
// Providers round used percentages; observers can disagree by under a point.
const JITTER_PP = 1;

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
        CREATE TABLE IF NOT EXISTS history_adoptions (
          legacy TEXT PRIMARY KEY, canonical TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS history_pending_interruptions (
          stream TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE, source TEXT NOT NULL,
          reason INTEGER NOT NULL, at INTEGER NOT NULL, day TEXT NOT NULL,
          PRIMARY KEY(stream, source, reason)
        ) WITHOUT ROWID;
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
  const headFor = sql('SELECT source, failed FROM streams WHERE id = ?');
  // streams.guarded is a retired column: observers are merged by observation time.
  const setHead = sql('UPDATE streams SET source = ?, guarded = 0, failed = 0 WHERE id = ?');
  const originFor = sql('SELECT at FROM history_origins WHERE stream = ? AND source = ?');
  const noteOrigin = sql(`INSERT INTO history_origins VALUES (?, ?, ?)
    ON CONFLICT(stream, source) DO UPDATE SET at = excluded.at`);
  const noteSource = sql(`INSERT INTO history_run_sources VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(run, source) DO UPDATE SET last_at = excluded.last_at, samples = samples + 1`);
  const breakRun = sql(`UPDATE runs SET break_after = break_after | ${BREAK_INTERRUPTED} WHERE id = ?`);
  const markInterruption = sql('UPDATE runs SET break_after = break_after | ?, uncertain_until = MAX(COALESCE(uncertain_until, until), ?) WHERE id = ?');
  const markFailed = sql('UPDATE streams SET failed = 1 WHERE id = ?');
  const ambiguousStart = sql('UPDATE runs SET uncertain_before = 1 WHERE id = ?');
  const basisInsert = sql('INSERT INTO run_basis VALUES (?, ?)');
  const failAccount = sql(`SELECT r.id, r.until, s.id AS stream FROM streams s
    JOIN runs r ON r.id = (SELECT id FROM runs WHERE stream = s.id ORDER BY until DESC LIMIT 1)
    WHERE s.account = ? AND s.source = ?`);
  function pointOf(run) {
    return run && { at: run.until, value: run.value, unit: run.unit, balance: !!run.balance, ...(run.basis ? { basis: run.basis } : {}),
      reset: run.reset, interval: run.interval,
      // A compressed owner interval may continue past a competing conflict.
      // Its latest successful endpoint is a recovered accounting baseline.
      uncertainUntil: run.uncertain_until < run.until ? null : run.uncertain_until };
  }
  function markUnknownDays(stream, from, until, now) {
    const [first, last] = [from, until].sort();
    const start = first < dayKey(retentionStart(now, 730)) ? dayKey(retentionStart(now, 730)) : first;
    for (const date = new Date(`${start}T12:00:00`); dayKey(date.getTime()) <= last; date.setDate(date.getDate() + 1)) {
      dailyUnknown.run(stream, dayKey(date.getTime()));
    }
  }
  function noteDaily(stream, previous, point, interruption, now, ambiguous = false) {
    const day = point.collectedDay || dayKey(point.at);
    const previousDay = previous && (point.collectedDay
      ? sql('SELECT day FROM daily WHERE stream = ? AND last_at = ?').get(stream, previous.at)?.day : null)
      || (previous ? dayKey(previous.at) : null);
    dailyObserve.run(stream, day, point.at, point.at, point.value, point.value);
    if (!previous) return;
    const reset = !ambiguous && !sameCycle(previous, point);
    const allowanceRecovered = interruption === BREAK_ALLOWANCE_MISSING && sameCycle(previous, point);
    const comparable = sameCycle(previous, point) && (previous.uncertainUntil == null || allowanceRecovered);
    const gap = ambiguous || interruption || (point.coveredFrom === previous.at ? point.maxGap : point.at - previous.at) > Math.max(previous.interval, point.interval) * 2.5;
    const delta = reset || ambiguous && !sameCycle(previous, point) ? 0 : Math.max(0, point.balance ? previous.value - point.value : point.value - previous.value);
    const crossDay = previousDay !== day;
    if (!reset && (!gap || comparable || point.coveredFrom === previous.at && delta === 0 && sameCycle(previous, point)) && !crossDay) dailyValue.run(delta, stream, day);
    if (reset || gap || crossDay && delta > 0) {
      markUnknownDays(stream, previousDay, day, now);
    }
    dailyExtra.run(!reset && (crossDay || gap && !comparable) ? delta : 0, reset ? 1 : 0, stream, day);
  }

  function interrupt(stream, tail, point, now, reason = BREAK_INTERRUPTED) {
    markInterruption.run(reason, point.at, tail.id);
    const previousDay = point.collectedDay
      ? sql('SELECT day FROM daily WHERE stream = ? AND last_at = ?').get(stream, tail.until)?.day : null;
    markUnknownDays(stream, previousDay || dayKey(tail.until), point.collectedDay || dayKey(point.at), now);
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
    database.prepare('DELETE FROM history_pending_interruptions WHERE at < ?').run(retentionStart(now, 730));
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
  function recordActions(actions, now) {
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
              // As for readings, the owner stays current through ignored rounding readings.
              const ownerSeen = Math.max(tail.until, originFor.get(id, head.source)?.at || 0);
              const healthy = !head.failed && point.at - ownerSeen <= Math.max(tail.interval, point.interval) * 2.5;
              if (head.source !== source && healthy) continue;
              noteOrigin.run(id, source, point.at);
              interrupt(id, tail, point, now, BREAK_ALLOWANCE_MISSING);
              // The accepted replacement owns subsequent missing/failure reports.
              setHead.run(source, id);
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
          // Every observer reads the same upstream quota. Merge them by
          // observation time: an older or same-time reading adds nothing.
          if (tail && point.at <= tail.until) {
            if (point.at === tail.until && tail.value === point.value && sameCycle(previous, point)) noteSource.run(tail.id, source, point.at, point.at);
            continue;
          }
          const switched = !!tail && head.source !== source;
          const consistent = !tail || sameCycle(previous, point);
          // The observer that wrote the timeline is current while it keeps
          // reporting without a failed refresh, even when its readings add
          // nothing (such as rounding). Other observers' rejected readings never
          // keep it current.
          const ownerSeen = tail && head.source !== source ? originFor.get(id, head.source)?.at : null;
          const current = ownerSeen != null && !head.failed && point.at - ownerSeen <= Math.max(tail.interval, point.interval) * 2.5;
          // Another observer's reading without the allowance adds nothing while
          // the merged series is current. Missing metadata, or its return, is
          // never a disagreement.
          if (switched && current && missingBasisOnly) continue;
          const basisReturned = !!tail && !previous.basis && !!point.basis
            && sameCycle({ ...previous, basis: point.basis }, point);
          let baseline = false;
          if (tail && !consistent && !missingBasisOnly && !basisReturned) {
            // A lagging observer may still report a cycle whose deadline has
            // already passed: that is a late report, not a new cycle.
            if (previous.reset !== null && point.reset !== null
              && previous.reset - point.reset > 1000 && point.reset <= point.at) continue;
            // Within one advertised deadline, a used percentage dipping by less
            // than a point is rounding jitter or a stale observer, not a reset.
            if (point.reset !== null && point.unit === 'pp' && previous.value - point.value < JITTER_PP
              && sameCycle(previous, { ...point, value: previous.value })) {
              // The owner's own rounding reading still proves it is reporting.
              if (!switched) setHead.run(source, id);
              continue;
            }
            // Deadlines only move forward, so a later one is a new or rolling
            // window from any observer. Anything else another observer
            // contradicts (a drop, a refill or an earlier deadline) is stale while
            // the merged series is still current; once that goes silent, it
            // starts an uncertain baseline.
            const laterDeadline = previous.reset !== null && point.reset !== null && point.reset - previous.reset > 1000;
            if (switched && !laterDeadline) {
              if (current) continue;
              baseline = true;
            }
          }
          const basisChanged = !!tail && (tail.basis || '') !== (point.basis || '');
          const ambiguous = point.uncertainBefore || basisChanged || baseline;
          noteDaily(id, previous, point, tail?.break_after || 0, now, ambiguous);
          let run;
          // Adoption can prove the owner's flat interval remained observed
          // while a competing source disagreed inside it. Retain that coverage.
          if (tail && !ambiguous && (!tail.break_after || point.coveredFrom === previous.at) && tail.value === point.value && tail.reset === point.reset && tail.interval === point.interval
            && consistent && (point.coveredFrom === previous.at ? point.maxGap : point.at - previous.at) <= point.interval * 2.5) {
            run = tail.id;
            runExtend.run(point.at, run);
          } else {
            run = Number(runInsert.run(id, point.at, point.at, point.value, point.unit, +point.balance, point.reset, point.interval).lastInsertRowid);
            if (point.basis) basisInsert.run(run, point.basis);
            if (ambiguous) ambiguousStart.run(run);
          }
          noteSource.run(run, source, point.at, point.at);
          setHead.run(source, id);
          if (point.at >= retentionStart(now, 180)) {
            cover.run(run, hourStart(point.at), point.at, point.at, point.coveredFrom !== undefined ? point.maxGap : previous ? point.at - previous.at : 0);
            if (point.samples > 1 || point.maxGap) sql('UPDATE coverage SET samples = samples + ?, max_gap = MAX(max_gap, ?) WHERE run = ? AND hour = ?')
              .run(Math.max(0, (point.samples || 1) - 1), point.maxGap || 0, run, hourStart(point.at));
          }
          if (point.samples > 1) {
            sql('UPDATE daily SET observations = observations + ? WHERE stream = ? AND day = ?')
              .run(point.samples - 1, id, point.collectedDay || dayKey(point.at));
            sql('UPDATE history_run_sources SET samples = samples + ? WHERE run = ? AND source = ?')
              .run(point.samples - 1, run, source);
          }
          if (point.breakAfter) {
            if (point.uncertainUntil == null) sql('UPDATE runs SET break_after = break_after | ? WHERE id = ?').run(point.breakAfter, run);
            else sql(`UPDATE runs SET break_after = break_after | ?,
              uncertain_until = MAX(COALESCE(uncertain_until, ?), ?) WHERE id = ?`)
              .run(point.breakAfter, point.uncertainUntil, point.uncertainUntil, run);
            markFailed.run(id);
          }
        }
      }
  }
  // Window IDs cannot be recovered from an account hash alone. Keep only the
  // first interruption of each kind for unadopted streams until a quota returns.
  // Replay it with the readings, so a later shared owner can supersede it.
  function rememberInterruptions(actions, mappings, now) {
    for (const action of actions) {
      if (!action.legacy) continue;
      const at = action.failed ? now : action.snapshotAt;
      if (at < retentionStart(now, 730) || at > now + 60_000) continue;
      for (const tail of failAccount.all(action.legacy.account, action.legacy.source)) {
        if (sql('SELECT 1 FROM history_adoptions WHERE legacy = ?').get(tail.stream)) continue;
        const mapping = mappings.find(entry => entry.legacy.includes(tail.stream));
        const window = mapping && action.windows?.find(entry => entry.id === mapping.id);
        if (window && !window.point.missing) continue;
        const origin = originFor.get(tail.stream, action.legacy.source);
        if (!action.failed && (at <= tail.until || origin && at <= origin.at)) continue;
        const reason = action.failed ? 0 : window ? BREAK_ALLOWANCE_MISSING : BREAK_INTERRUPTED;
        sql(`INSERT INTO history_pending_interruptions VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(stream, source, reason) DO NOTHING`)
          .run(tail.stream, action.legacy.source, reason, at, dayKey(at));
      }
    }
  }
  function record(actions, now, mappings = []) {
    let adoptionFailed = false;
    try { adopt(mappings, now); }
    catch { adoptionFailed = true; } // The adoption transaction reports and rolls back the error.
    transaction(() => {
      recordActions(actions, now);
      rememberInterruptions(actions, mappings, now);
    }, now);
    saveFailed = adoptionFailed;
    return { persistent: persistent && !saveFailed };
  }
  // Old IDs were one-way hashes of backend + account + quota. The caller
  // supplies only aliases derivable from a currently verified identity. Keep
  // original rows as a recovery archive; adoption and its marker commit together.
  function adopt(mappings, now) {
    const groups = new Map();
    for (const mapping of mappings) {
      if (!groups.has(mapping.id)) groups.set(mapping.id, { ...mapping, legacy: new Set(), sources: [] });
      for (const id of mapping.legacy) groups.get(mapping.id).legacy.add(id);
      groups.get(mapping.id).sources.push(...(mapping.sources || []));
    }
    const pending = [...groups.values()].map(mapping => ({ ...mapping, legacy: [...mapping.legacy].filter(id => id !== mapping.id
      && !sql('SELECT 1 FROM history_adoptions WHERE legacy = ?').get(id)
      && headFor.get(id)) })).filter(mapping => mapping.legacy.length);
    if (!pending.length) return;
    transaction(() => {
      for (const mapping of pending) {
        const ids = [mapping.id, ...mapping.legacy];
        const events = [];
        const spans = [];
        const origins = new Map();
        const olderDays = new Map();
        const uncertainDays = new Set();
        function sourceFor(id, source) {
          const alias = mapping.sources.find(entry => entry.id === id && (entry.scope || entry.before === source));
          // Compose backend provenance with the saved source hash, so every
          // legacy owner maps to the same identity as its later live reading.
          if (alias?.scope) return createHash('sha256').update(JSON.stringify([alias.scope, source])).digest('hex');
          return alias?.after || (id === mapping.id ? source : `${id}:${source}`);
        }
        for (const id of ids) {
          const head = headFor.get(id);
          const tailId = latest.get(id)?.id;
          const dailyRows = sql('SELECT * FROM daily WHERE stream = ? ORDER BY day').all(id);
          // Daily summaries retain the original collection calendar even when
          // the desktop now uses another timezone. Do not rebucket replayed points.
          const collectedDay = at => dailyRows.find(row => row.last_at != null && at <= row.last_at && (row.first_at == null || row.first_at <= at))?.day;
          for (const origin of sql('SELECT source, at FROM history_origins WHERE stream = ?').all(id)) {
            const source = sourceFor(id, origin.source);
            origins.set(source, Math.max(origins.get(source) || 0, origin.at));
          }
          for (const row of sql(`SELECT r.*, b.basis, c.at AS part_at, c.until AS part_until, c.samples, c.max_gap
            FROM runs r LEFT JOIN coverage c ON c.run = r.id LEFT JOIN run_basis b ON b.run = r.id
            WHERE r.stream = ? ORDER BY r.at, c.at`).all(id)) {
            const start = row.part_at ?? row.until;
            const end = row.part_until ?? row.until;
            const originalSource = row.id === tailId ? head.source
              : sql('SELECT source FROM history_run_sources WHERE run = ? ORDER BY last_at DESC LIMIT 1').get(row.id)?.source || head.source;
            const firstSource = sql('SELECT source FROM history_run_sources WHERE run = ? ORDER BY first_at LIMIT 1').get(row.id)?.source || originalSource;
            const source = sourceFor(id, start === row.at && start !== end ? firstSource : originalSource);
            const point = { ...pointOf(row), at: start, collectedDay: collectedDay(start), samples: start === end ? row.samples || 1 : 1,
              maxGap: row.max_gap || 0, uncertainBefore: start === row.at && !!row.uncertain_before };
            events.push({ stream: id, source, point });
            if (end > start) spans.push({ stream: id, point, until: end });
            if (end > start) events.push({ stream: id, source: sourceFor(id, originalSource), point: { ...point, at: end, collectedDay: collectedDay(end), uncertainBefore: false, coveredFrom: start, samples: Math.max(1, row.samples - 1) } });
            if (end === row.until) Object.assign(events.at(-1).point, { breakAfter: row.break_after,
              uncertainUntil: row.uncertain_until });
            if (end === row.until && row.id === tailId) {
              events.at(-1).failed = !!head.failed;
            }
          }
          for (const interruption of sql('SELECT * FROM history_pending_interruptions WHERE stream = ?').all(id)) {
            events.push({ stream: id, source: sourceFor(id, interruption.source), interruption: interruption.reason,
              point: { at: interruption.at, collectedDay: interruption.day } });
          }
          // Detail retention cannot reconstruct older daily accounting. Keep
          // disjoint summaries; overlapping legacy summaries remain unknown.
          for (const row of dailyRows) {
            if (row.uncertain) uncertainDays.add(row.day);
            if (row.day >= dayKey(retentionStart(now, 180))) continue;
            if (olderDays.has(row.day)) {
              const previous = olderDays.get(row.day);
              previous.value = null; previous.uncertain = 1;
              previous.observations += row.observations;
              previous.unallocated = 0; previous.resets = 0;
            } else olderDays.set(row.day, { ...row });
          }
        }
        sql('DELETE FROM streams WHERE id = ?').run(mapping.id);
        events.sort((a, b) => a.point.at - b.point.at);
        spans.sort((a, b) => a.point.at - b.point.at);
        let spanIndex = 0;
        let active = [];
        let ownerStream = null;
        for (const event of events) {
          active = active.filter(span => span.until >= event.point.at);
          while (spanIndex < spans.length && spans[spanIndex].point.at <= event.point.at) {
            const span = spans[spanIndex++];
            if (span.until >= event.point.at) active.push(span);
          }
          const head = headFor.get(mapping.id);
          if (event.interruption !== undefined) {
            const tail = latest.get(mapping.id);
            if (head?.source !== event.source || !tail) continue;
            if (event.interruption === 0) breakRun.run(tail.id);
            else {
              if (event.point.at <= tail.until) continue;
              noteOrigin.run(mapping.id, event.source, event.point.at);
              interrupt(mapping.id, tail, event.point, now, event.interruption);
            }
            markFailed.run(mapping.id);
            continue;
          }
          // Compressed coverage proves the accepted stream's unchanged reading
          // across this time, without its intermediate observation times. Like
          // any same-time reading, another stream's reading inside it adds
          // nothing, and cannot take the interval over.
          if (ownerStream !== null && ownerStream !== event.stream && active.some(span => span.stream === ownerStream)) continue;
          // Readings already accepted by one saved stream keep its source, so
          // equal-time confirmations replayed from it are not another observer.
          if (head && ownerStream === event.stream && head.source !== event.source) {
            sql('UPDATE streams SET source = ? WHERE id = ?').run(event.source, mapping.id);
          }
          recordActions([{ account: mapping.account, source: event.source,
            windows: [{ id: mapping.id, point: event.point }] }], now);
          if (headFor.get(mapping.id)?.source === event.source && latest.get(mapping.id)?.until === event.point.at) {
            ownerStream = event.stream;
            if (event.failed !== undefined) sql('UPDATE streams SET failed = ? WHERE id = ?').run(+event.failed, mapping.id);
          }
        }
        streamInsert.run(mapping.id, mapping.account);
        for (const [source, at] of origins) {
          if (at > (originFor.get(mapping.id, source)?.at || 0)) noteOrigin.run(mapping.id, source, at);
        }
        for (const row of olderDays.values()) sql(`INSERT OR REPLACE INTO daily
          (stream, day, value, observations, uncertain, unallocated, resets, first_at, last_at, first_value, last_value)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(mapping.id, row.day, row.value, row.observations,
          row.uncertain, row.unallocated, row.resets, row.first_at, row.last_at, row.first_value, row.last_value);
        for (const day of uncertainDays) dailyUnknown.run(mapping.id, day);
        for (const id of mapping.legacy) {
          sql('INSERT INTO history_adoptions VALUES (?, ?)').run(id, mapping.id);
          sql('DELETE FROM history_pending_interruptions WHERE stream = ?').run(id);
        }
      }
    }, now);
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
  function query(windows, range, now, mappings = []) {
    try { adopt(mappings, now); }
    catch { /* The adoption transaction reports the error; retain readable shared history. */ }
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
  return { record, query, adopt, close() { database.close(); } };
}
module.exports = { createHistoryDatabase, retentionStart };
