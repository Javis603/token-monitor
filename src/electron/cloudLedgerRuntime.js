'use strict';

// Durable, account-scoped home for the cloud accounting ledger. This module is
// the only writer of `cloud-ledger.json`: reads the observer's validated
// report, folds it through the pure accounting state machine and persists with
// an fsync'd atomic replace. It runs in the Electron main process only; the
// renderer never sees the ledger file, the account scope fingerprint or any
// credential material. A corrupt ledger is preserved and recording
// freezes until repaired; known values remain explicitly incomplete.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  LEDGER_KIND,
  LEDGER_VERSION,
  ingestObservation,
  normalizeLedger,
  summarize
} = require('../shared/providers/codex/cloudAccounting');

const DEFAULT_INTERVAL_MS = 5000;
const MIN_INTERVAL_MS = 2000;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const SCOPE = /^[a-f0-9]{64}$/;
const DAY_WINDOW = 62;
const { localDayKey } = require('../shared/history');

function fault(code) { return Object.assign(new Error(code), { code }); }
function safeCode(error) { return /^[A-Z_]{1,60}$/.test(error?.code || '') ? error.code : 'CLOUD_LEDGER_UNAVAILABLE'; }

function readFileLimited(file, maxBytes, fsImpl) {
  const named = fsImpl.lstatSync(file);
  if (!named.isFile() || named.isSymbolicLink()) throw fault('UNSAFE_CLOUD_LEDGER_FILE');
  const fd = fsImpl.openSync(file, fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0));
  try {
    const before = fsImpl.fstatSync(fd);
    if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino
      || before.size > maxBytes || (process.getuid && before.uid !== process.getuid())) throw fault('UNSAFE_CLOUD_LEDGER_FILE');
    const buffer = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    let read = 0;
    while (read < buffer.length) {
      const size = fsImpl.readSync(fd, buffer, read, buffer.length - read, null);
      if (!size) break;
      read += size;
    }
    const after = fsImpl.fstatSync(fd);
    const stillNamed = fsImpl.lstatSync(file);
    if (!stillNamed.isFile() || stillNamed.isSymbolicLink() || stillNamed.dev !== before.dev || stillNamed.ino !== before.ino
      || read !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw fault('CLOUD_LEDGER_FILE_CHANGED');
    return JSON.parse(buffer.subarray(0, read).toString('utf8'));
  } finally {
    fsImpl.closeSync(fd);
  }
}

function writeJsonAtomic(file, value, fsImpl) {
  const directory = path.dirname(file);
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    const fd = fsImpl.openSync(tmp, 'wx', 0o600);
    try {
      let written = 0;
      while (written < bytes.length) {
        const size = fsImpl.writeSync(fd, bytes, written, bytes.length - written);
        if (!size) throw fault('CLOUD_LEDGER_WRITE_FAILED');
        written += size;
      }
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
    fsImpl.renameSync(tmp, file);
  } finally {
    try { fsImpl.unlinkSync(tmp); } catch (_) { /* renamed or never created */ }
  }
  // fsync the directory so the rename itself is durable, not just the bytes.
  let dirFd = null;
  try { dirFd = fsImpl.openSync(directory, 'r'); fsImpl.fsyncSync(dirFd); }
  catch (_) { /* directory fsync is unavailable on some platforms */ }
  finally { if (dirFd !== null) fsImpl.closeSync(dirFd); }
}

function defaultDataDir(home) {
  return path.join(home, 'Library/Application Support/Token Monitor Usage Test/auto-cloud');
}

function defaultScope(home) {
  const { loadCredential } = require('../shared/providers/codex/cloudTransport');
  return loadCredential(path.resolve(process.env.CODEX_HOME || path.join(home, '.codex'))).scopeFingerprint;
}

function pruneForWrite(ledger, activeFingerprint) {
  const cutoff = localDayKey(new Date(Date.now() - DAY_WINDOW * 86400000));
  for (const [fingerprint, scope] of Object.entries(ledger.scopes)) {
    if (fingerprint !== activeFingerprint) continue;
    for (const thread of Object.values(scope.threads)) {
      for (const key of Object.keys(thread.days)) if (key < cutoff) delete thread.days[key];
    }
  }
  return ledger;
}

function createCloudAccountingRuntime(options = {}) {
  const home = options.home || os.homedir();
  const directory = options.dataDir || defaultDataDir(home);
  const ledgerPath = options.ledgerPath || path.join(directory, 'cloud-ledger.json');
  const intervalMs = Math.max(MIN_INTERVAL_MS, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  const now = options.now || (() => Date.now());
  const fsImpl = options.fs || fs;
  const logger = options.logger || (() => {});
  const onUpdate = options.onUpdate || (() => {});
  const getScope = options.getScope || (() => defaultScope(home));
  const readReport = options.readReport || (() => readFileLimited(path.join(directory, 'report.json'), MAX_REPORT_BYTES, fsImpl));
  const readPreviousReport = options.readPreviousReport || (() => {
    try { return readFileLimited(path.join(directory, 'native-previous-report.json'), MAX_REPORT_BYTES, fsImpl); } catch (_) { return null; }
  });
  const setTimer = options.setInterval || ((fn, ms) => setInterval(fn, ms));
  const clearTimer = options.clearInterval || ((handle) => clearInterval(handle));

  let ledger = null;
  let scope = null;
  let status = { state: 'starting', reason: null };
  let revision = 0;
  let dirty = false;
  let lastReportAt = null;
  let timer = null;
  let stopped = false;
  let persistentFault = null;
  let publishedRevision = -1;
  let currentDay = null;

  function load() {
    try {
      const raw = readFileLimited(ledgerPath, MAX_LEDGER_BYTES, fsImpl);
      const normalized = normalizeLedger(raw);
      ledger = normalized.ledger;
      if (!normalized.valid) {
        persistentFault = 'CORRUPT_LEDGER';
        logger('cloud-ledger: invalid entries; original preserved');
      }
    } catch (error) {
      ledger = { version: LEDGER_VERSION, kind: LEDGER_KIND, updatedAt: null, scopes: {} };
      if (error.code !== 'ENOENT') {
        persistentFault = 'CORRUPT_LEDGER';
        logger(`cloud-ledger: original preserved (${safeCode(error)})`);
      }
    }
    return ledger;
  }

  function setStatus(state, reason) {
    if (status.state !== state || status.reason !== reason) revision += 1;
    status = { state, reason };
  }

  function setScope(next) {
    if (scope !== next) { scope = next; revision += 1; }
  }

  function checkedScope() {
    try { const value = getScope(); return SCOPE.test(value || '') ? value : null; }
    catch (_) { return null; }
  }

  function publish(persisted = !dirty) {
    if (revision !== publishedRevision) {
      publishedRevision = revision;
      onUpdate({ revision, status: { ...status }, persisted });
    }
  }

  function persist() {
    if (!dirty) return true;
    try {
      pruneForWrite(ledger, scope);
      // Capacity cannot authorize deleting another account's totals or
      // current-period day buckets. Keep the last durable file intact.
      if (Buffer.byteLength(JSON.stringify(ledger)) > MAX_LEDGER_BYTES) throw fault('CLOUD_LEDGER_TOO_LARGE');
      writeJsonAtomic(ledgerPath, ledger, fsImpl);
      dirty = false;
      return true;
    } catch (error) {
      logger(`cloud-ledger: persistence failed (${safeCode(error)})`);
      return false;
    }
  }

  function refresh() {
    if (!ledger) load();
    const day = localDayKey(new Date(now()));
    if (currentDay !== day) { currentDay = day; revision += 1; }
    const fingerprint = checkedScope();
    setScope(fingerprint);
    if (!fingerprint) {
      setStatus('inactive', 'NO_ACCOUNT');
      publish();
      return { changed: false, status };
    }
    if (persistentFault) {
      setStatus('inactive', persistentFault);
      publish(false);
      return { changed: false, status, persisted: false };
    }
    let report;
    try { report = readReport(); }
    catch (error) {
      setStatus('inactive', error.code === 'ENOENT' ? 'REPORT_NOT_READY' : 'INVALID_REPORT');
      publish();
      return { changed: false, status };
    }
    let previous = null;
    try { previous = readPreviousReport(); } catch (_) { /* optional migration */ }
    if (checkedScope() !== fingerprint) {
      setScope(checkedScope());
      setStatus('inactive', 'ACCOUNT_CHANGED');
      publish();
      return { changed: false, status };
    }
    const result = ingestObservation(ledger, { scopeFingerprint: fingerprint, report, previousReport: previous, now: now() });
    if (checkedScope() !== fingerprint) {
      setScope(checkedScope());
      setStatus('inactive', 'ACCOUNT_CHANGED');
      publish();
      return { changed: false, status };
    }
    if (result.status === 'OK') {
      lastReportAt = typeof report?.observedAt === 'string' ? report.observedAt : lastReportAt;
    } else {
      setStatus('inactive', result.status === 'ACCOUNT_MISMATCH' ? 'ACCOUNT_MISMATCH'
        : ['SCOPE_CAPACITY', 'STORAGE_LIMIT'].includes(result.status) ? result.status : 'INVALID_REPORT');
    }
    if (result.changed) {
      ledger = result.ledger;
      dirty = true;
      revision += 1;
    }
    const persisted = persist();
    if (result.status === 'OK') {
      const stale = Number.isFinite(Date.parse(report.observedAt)) && now() - Date.parse(report.observedAt) > 30000;
      const stoppedObserver = typeof report.state === 'string' && report.state !== 'listening';
      const reason = !persisted ? 'PERSISTENCE_FAILED' : stoppedObserver ? 'OBSERVER_STOPPED' : stale ? 'STALE_REPORT' : null;
      setStatus(reason ? 'inactive' : 'active', reason);
    }
    publish(persisted);
    return { changed: result.changed, status, persisted };
  }

  function summary({ localThreadIds = [], localThreadUsage = {}, at = null } = {}) {
    if (!ledger) load();
    const current = checkedScope();
    if (current !== scope) {
      setScope(current);
      setStatus('inactive', current ? 'ACCOUNT_CHANGED' : 'NO_ACCOUNT');
      lastReportAt = null;
    }
    const base = summarize(ledger, { scopeFingerprint: scope, localThreadIds, localThreadUsage, now: at ?? now(), status });
    base.reportAt = lastReportAt;
    base.revision = revision;
    return base;
  }

  function start() {
    if (timer || stopped) return;
    refresh();
    timer = setTimer(() => refresh(), intervalMs);
    timer?.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { start, stop, refresh, summary, revision: () => revision, ledgerPath, directory };
}

module.exports = {
  createCloudAccountingRuntime,
  readFileLimited,
  writeJsonAtomic,
  defaultDataDir,
  defaultScope,
  MAX_LEDGER_BYTES
};
