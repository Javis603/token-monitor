#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const { AutoCloudConnection, AutoCloudMonitor, renderAutoHtml, safeCode } = require('../src/shared/providers/codex/cloudAutoWatch');
const { cachedReferences } = require('../src/shared/providers/codex/cloudTransport');

function failure(code) { return Object.assign(new Error(code), { code }); }
function options(argv) {
  const { values: v } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    'acknowledge-auto-attach': { type: 'boolean' }, 'data-dir': { type: 'string' }, interval: { type: 'string' },
    'max-listening': { type: 'string' }, pages: { type: 'string' }, seconds: { type: 'string' }, help: { type: 'boolean' }
  } });
  if (v.help) return v;
  if (!v['acknowledge-auto-attach']) throw failure('AUTO_ATTACH_CONSENT_REQUIRED');
  const bounded = (raw, fallback, min, max) => { const n = raw === undefined ? fallback : Number(raw); if (!Number.isSafeInteger(n) || n < min || n > max) throw failure('INVALID_AUTO_OPTION'); return n; };
  return { dataDir: path.resolve(v['data-dir'] || path.join(os.homedir(), 'Library/Application Support/Token Monitor Usage Test/auto-cloud')),
    intervalMs: bounded(v.interval, 5, 2, 120) * 1000, maxListening: bounded(v['max-listening'], 32, 1, 128),
    maxPages: bounded(v.pages, 3, 1, 20), runMs: v.seconds === undefined ? null : bounded(v.seconds, 60, 1, 86400) * 1000 };
}
function directory(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  const s = fs.lstatSync(p);
  if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(p) !== path.resolve(p) || (process.getuid && s.uid !== process.getuid())) throw failure('UNSAFE_AUTO_DIRECTORY');
  fs.chmodSync(p, 0o700); return p;
}
function atomicJson(file, value) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}
// Process-instance identity guards stale-lock reclaim: a live PID alone is not
// proof of ownership, because the OS can reuse a PID for an unrelated process.
function readSmall(file, maxBytes = 4096) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY);
    const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > maxBytes) return null;
    const buf = Buffer.alloc(maxBytes + 1); let n = 0;
    while (n < buf.length) { const size = fs.readSync(fd, buf, n, buf.length - n, null); if (!size) break; n += size; }
    return n > maxBytes ? null : buf.subarray(0, n).toString('utf8');
  } catch (_) { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function identityFromProcStat(stat, boot) {
  if (typeof stat !== 'string') return null;
  const close = stat.lastIndexOf(')');
  if (close < 1) return null;
  const starttime = stat.slice(close + 1).trim().split(/\s+/)[19];
  if (!/^\d{1,20}$/.test(starttime || '')) return null;
  if (typeof boot !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(boot.trim())) return null;
  const prefix = boot.trim().toLowerCase();
  return { method: 'linux-proc-starttime-v1', value: prefix + ':' + starttime };
}
function identityOf(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return null;
  try {
    if (process.platform === 'linux') {
      const stat = readSmall(`/proc/${pid}/stat`); if (stat === null) return null;
      return identityFromProcStat(stat, readSmall('/proc/sys/kernel/random/boot_id') || '');
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } });
      const value = out.trim().replace(/\s+/g, ' ');
      if (!/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value)) return null;
      return { method: 'darwin-ps-lstart-v1', value };
    }
  } catch (_) { return null; }
  return null;
}
function validIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) || typeof identity.value !== 'string') return false;
  if (identity.method === 'linux-proc-starttime-v1') return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:\d{1,20}$/.test(identity.value);
  if (identity.method === 'darwin-ps-lstart-v1') return /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(identity.value);
  return false;
}
function validLockRecord(record) {
  return !!record && typeof record === 'object' && !Array.isArray(record)
    && Number.isSafeInteger(record.pid) && record.pid > 0 && record.pid <= 0x7fffffff
    && typeof record.nonce === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(record.nonce)
    && (record.identity === null || validIdentity(record.identity));
}
function trustedDirectory(folder) {
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(folder) !== path.resolve(folder)
    || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022)) throw failure('UNSAFE_AUTO_LOCK');
  return stat;
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function readOwner(folder) {
  const dirStat = trustedDirectory(folder);
  if (fs.readdirSync(folder).some((f) => f !== 'owner.json')) throw failure('AUTO_LOCK_NEEDS_REVIEW');
  const file = path.join(folder, 'owner.json'); let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || stat.nlink !== 1 || (stat.mode & 0o022)
      || (process.getuid && stat.uid !== process.getuid()) || !sameFile(stat, fs.lstatSync(file))) throw failure('AUTO_LOCK_NEEDS_REVIEW');
    const buf = Buffer.alloc(4097); let n = 0;
    while (n < buf.length) { const count = fs.readSync(fd, buf, n, buf.length - n, null); if (!count) break; n += count; }
    if (n > 4096 || !sameFile(dirStat, trustedDirectory(folder))) throw failure('AUTO_LOCK_NEEDS_REVIEW');
    const raw = buf.subarray(0, n).toString('utf8'); const record = JSON.parse(raw);
    if (!validLockRecord(record)) throw failure('AUTO_LOCK_NEEDS_REVIEW');
    return { raw, record, stat, dirStat };
  } catch (_) { throw failure('AUTO_LOCK_NEEDS_REVIEW'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function inspectLock(folder, probeIdentity) {
  const owner = readOwner(folder); const record = owner.record;
  try { process.kill(record.pid, 0); }
  catch (e) { if (e.code === 'ESRCH') return owner; throw failure('AUTO_LOCK_NEEDS_REVIEW'); }
  if (record.identity === null) throw failure('AUTO_MONITOR_ALREADY_RUNNING');
  const current = probeIdentity(record.pid);
  if (!validIdentity(current) || current.method !== record.identity.method) throw failure('AUTO_LOCK_NEEDS_REVIEW');
  // Equal coarse macOS timestamps remain active: same-second reuse is ambiguous.
  if (current.value === record.identity.value) throw failure('AUTO_MONITOR_ALREADY_RUNNING');
  return owner;
}
// Serialize inspection, reclamation, publication and release. An abandoned
// operation guard is deliberately left for review rather than unsafely stolen.
function operationGuard(root) {
  trustedDirectory(root);
  const file = path.join(root, 'process.lock.guard'); let fd;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw failure('AUTO_LOCK_NEEDS_REVIEW'); throw e; }
  const stat = fs.fstatSync(fd);
  return () => { try { if (sameFile(stat, fs.lstatSync(file)) && !fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file); } finally { fs.closeSync(fd); } };
}
function removeOwner(folder, owner) {
  const now = readOwner(folder);
  if (now.raw !== owner.raw || !sameFile(now.stat, owner.stat) || !sameFile(now.dirStat, owner.dirStat)) throw failure('AUTO_LOCK_NEEDS_REVIEW');
  fs.unlinkSync(path.join(folder, 'owner.json')); fs.rmdirSync(folder);
}
function releaseLock(root, nonce) {
  let releaseGuard;
  try {
    releaseGuard = operationGuard(root);
    const folder = path.join(root, 'process.lock'), owner = readOwner(folder);
    if (owner.record.nonce !== nonce || owner.record.pid !== process.pid) return;
    removeOwner(folder, owner);
  } catch (_) { /* ownership uncertain: preserve the lock */ }
  finally { if (releaseGuard) releaseGuard(); }
}
function lock(directoryPath, probeIdentity = identityOf) {
  const releaseGuard = operationGuard(directoryPath);
  const folder = path.join(directoryPath, 'process.lock'), nonce = randomUUID();
  try {
    try { fs.lstatSync(folder); removeOwner(folder, inspectLock(folder, probeIdentity)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const identity = probeIdentity(process.pid);
    if (identity !== null && !validIdentity(identity)) throw failure('AUTO_LOCK_NEEDS_REVIEW');
    fs.mkdirSync(folder, { mode: 0o700 });
    // If publication fails, keep the incomplete lock for manual review.
    atomicJson(path.join(folder, 'owner.json'), { pid: process.pid, nonce, identity });
    return () => releaseLock(directoryPath, nonce);
  } finally { releaseGuard(); }
}
class ReportSink {
  constructor(root) {
    this.root = directory(root); this.unlock = lock(root); this.scope = null; this.report = null;
    this.runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    const runs = directory(path.join(root, 'runs')); this.runDir = directory(path.join(runs, this.runId));
    this.fd = fs.openSync(path.join(this.runDir, 'events.ndjson'), 'wx', 0o600); this.bytes = 0; this.closed = false;
  }
  event(record) {
    if (this.closed) throw failure('CAPTURE_STORE_CLOSED');
    if (!/^[a-f0-9]{64}$/.test(record.scopeFingerprint || '')) throw failure('CAPTURE_SCOPE_REQUIRED');
    if (this.scope && this.scope !== record.scopeFingerprint) throw failure('ACCOUNT_SCOPE_CHANGED');
    this.scope = record.scopeFingerprint;
    const text = JSON.stringify({ source: 'hosted-engine-token-notification', ...record }) + '\n';
    if (this.bytes + Buffer.byteLength(text) > 128 * 1024 * 1024) throw failure('CAPTURE_STORAGE_LIMIT');
    try { const bytes = Buffer.from(text); let written = 0; while (written < bytes.length) { const n = fs.writeSync(this.fd, bytes, written, bytes.length - written); if (!n) throw failure('CAPTURE_WRITE_FAILED'); written += n; } fs.fsyncSync(this.fd); this.bytes += bytes.length; }
    catch (_) { throw failure('CAPTURE_WRITE_FAILED'); }
  }
  publish(report) {
    if (this.closed) return;
    if (report.scopeFingerprint && this.scope && report.scopeFingerprint !== this.scope) throw failure('ACCOUNT_SCOPE_CHANGED');
    if (report.scopeFingerprint) this.scope = report.scopeFingerprint;
    this.report = report;
    const envelope = { ...report, runId: this.runId, pid: process.pid, journalBytes: this.bytes };
    try {
      atomicJson(path.join(this.root, 'report.json'), envelope);
      atomicJson(path.join(this.runDir, 'report.json'), envelope);
      const html = path.join(this.root, 'report.html'), tmp = html + '.' + randomUUID() + '.tmp';
      try { fs.writeFileSync(tmp, renderAutoHtml(envelope), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, html); }
      finally { try { fs.unlinkSync(tmp); } catch (_) {} }
    } catch (_) { throw failure('CAPTURE_WRITE_FAILED'); }
  }
  close() { if (this.closed) return; this.closed = true; try { fs.closeSync(this.fd); } finally { this.unlock(); } }
}
const fatalConnectionCode = (code) => typeof code === 'string' && (code === 'ACCOUNT_SCOPE_CHANGED' || code.startsWith('CAPTURE_')) ? code : null;
async function run(v, deps = {}) {
  const controller = deps.controller || new AbortController();
  const sink = deps.sink || new ReportSink(v.dataDir); const create = deps.createConnection || (() => new AutoCloudConnection({ timeoutMs: 10000 }));
  let deferredFatal = null, reportError = null, cleanupError = null;
  // A capture failure can be thrown from a socket event while the main loop
  // sleeps. The transport stores it on the connection; record it here too so
  // the loop can stop with the original code instead of reconnecting.
  const noteCaptureFailure = (e) => { const code = fatalConnectionCode(safeCode(e)); if (code && !deferredFatal) deferredFatal = code; };
  const monitor = new AutoCloudMonitor({ maxListening: v.maxListening, maxPages: v.maxPages,
    onSample: (record) => { try { sink.event(record); sink.publish(monitor.report()); } catch (e) { noteCaptureFailure(e); throw e; } },
    onState: (report) => { try { sink.publish(report); } catch (e) { noteCaptureFailure(e); throw e; } } });
  let connection = null, failures = 0, deadlineTimer = null, lastArchivedAt = 0, lastSeedsAt = 0, seeds = [], fatal = null;
  const stop = () => { controller.abort(); connection?.close().catch(() => {}); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (v.runMs) deadlineTimer = setTimeout(stop, v.runMs);
  const pause = async (ms) => { try { await sleep(ms, undefined, { signal: controller.signal }); } catch (_) {} };
  try {
    while (!controller.signal.aborted) {
      const stored = fatalConnectionCode(deferredFatal) || fatalConnectionCode(connection && connection.failure);
      if (stored) { fatal = stored; break; } // stored fatal failure: stop, never reconnect
      try {
        if (!connection || connection.closed) {
          connection = create(); await connection.initialize();
          if (controller.signal.aborted) break;
          monitor.connect(connection);
        }
        const now = Date.now();
        if (now - lastSeedsAt >= 30000) { seeds = deps.seedReferences ? deps.seedReferences(connection) : cachedReferences(connection.home, connection.credential); lastSeedsAt = now; }
        const archived = now - lastArchivedAt >= 300000;
        await monitor.cycle({ includeArchived: archived, seedReferences: seeds });
        if (archived) lastArchivedAt = now;
        failures = 0;
        if (monitor.recycle) { await connection.close(); monitor.disconnect('IDLE_VIEWER_RECYCLED'); connection = null; }
        await pause(v.intervalMs);
      } catch (e) {
        if (controller.signal.aborted) break;
        const stored = fatalConnectionCode(deferredFatal) || fatalConnectionCode(connection && connection.failure) || fatalConnectionCode(safeCode(e));
        const code = stored || safeCode(e);
        try { if (connection) await connection.close(); } catch (_) {} connection = null;
        if (stored) { fatal = stored; break; }
        monitor.disconnect(code); failures += 1;
        await pause(Math.min(60000, 2000 * (2 ** Math.min(failures - 1, 5))));
      }
    }
  } finally {
    clearTimeout(deadlineTimer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (!fatal) fatal = fatalConnectionCode(deferredFatal) || fatalConnectionCode(connection && connection.failure);
    try { if (connection) await connection.close(); } catch (e) { cleanupError = safeCode(e); }
    monitor.connection = null; monitor.listening.clear(); monitor.pending.clear();
    if (!fatal) fatal = fatalConnectionCode(deferredFatal);
    monitor.state = fatal ? 'paused-' + fatal.toLowerCase() : 'stopped';
    if (fatal) monitor.diagnose(fatal);
    // The run journal is already fsynced; a failed final snapshot must not hide the fatal code.
    try { sink.publish(monitor.report()); } catch (e) { reportError = safeCode(e); } finally { try { sink.close(); } catch (e) { cleanupError = cleanupError || safeCode(e); } }
    if (!fatal && fatalConnectionCode(reportError)) { fatal = reportError; monitor.state = 'paused-' + fatal.toLowerCase(); monitor.diagnose(fatal); }
  }
  const result = { state: monitor.state, scans: monitor.scans, measuredThreads: monitor.report().measuredThreads, fatal };
  if (reportError !== null) result.reportError = reportError;
  if (cleanupError !== null) result.cleanupError = cleanupError;
  return result;
}
async function main(argv = process.argv.slice(2)) {
  const v = options(argv);
  if (v.help) { process.stdout.write('Automatic Codex cloud observer\n--acknowledge-auto-attach [--interval 5] [--max-listening 32] [--pages 3] [--seconds N] [--data-dir DIR]\nDiscovers active and newly created warm threads. No manual thread IDs, model starts, billing requests or thread configuration changes.\n'); return; }
  process.stdout.write('自动云端监听已启动；按 Ctrl+C 停止。报告目录：' + v.dataDir + '\n');
  const result = await run(v); process.stdout.write(JSON.stringify(result) + '\n');
  if (result.fatal || result.reportError || result.cleanupError) process.exitCode = 1;
}
if (require.main === module) main().catch((e) => { process.stderr.write('Cloud auto observer: ' + safeCode(e) + '\n'); process.exitCode = 1; });
module.exports = { options, run, ReportSink, lock, identityOf, identityFromProcStat, main };
