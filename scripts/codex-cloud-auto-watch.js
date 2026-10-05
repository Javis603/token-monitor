#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
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
function lock(directoryPath) {
  const folder = path.join(directoryPath, 'process.lock'); const nonce = randomUUID();
  try { fs.mkdirSync(folder, { mode: 0o700 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const stat = fs.lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw failure('UNSAFE_AUTO_LOCK');
    let old;
    try { const file = path.join(folder, 'owner.json'); if (fs.statSync(file).size > 4096) throw failure('LOCK_RECORD_TOO_LARGE'); old = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { throw failure('AUTO_LOCK_NEEDS_REVIEW'); }
    if (!Number.isInteger(old.pid) || old.pid < 1) throw failure('AUTO_LOCK_NEEDS_REVIEW');
    try { process.kill(old.pid, 0); throw failure('AUTO_MONITOR_ALREADY_RUNNING'); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    if (fs.readdirSync(folder).some((f) => f !== 'owner.json')) throw failure('AUTO_LOCK_NEEDS_REVIEW');
    fs.unlinkSync(path.join(folder, 'owner.json')); fs.rmdirSync(folder); fs.mkdirSync(folder, { mode: 0o700 });
  }
  atomicJson(path.join(folder, 'owner.json'), { pid: process.pid, nonce });
  return () => {
    try { const v = JSON.parse(fs.readFileSync(path.join(folder, 'owner.json'), 'utf8')); if (v.nonce !== nonce) return; fs.unlinkSync(path.join(folder, 'owner.json')); fs.rmdirSync(folder); } catch (_) {}
  };
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
  close() { if (this.closed) return; this.closed = true; fs.closeSync(this.fd); this.unlock(); }
}
async function run(v, deps = {}) {
  const controller = deps.controller || new AbortController();
  const sink = deps.sink || new ReportSink(v.dataDir); const create = deps.createConnection || (() => new AutoCloudConnection({ timeoutMs: 10000 }));
  const monitor = new AutoCloudMonitor({ maxListening: v.maxListening, maxPages: v.maxPages,
    onSample: (record) => { sink.event(record); sink.publish(monitor.report()); }, onState: (report) => sink.publish(report) });
  let connection = null, failures = 0, deadlineTimer = null, lastArchivedAt = 0, lastSeedsAt = 0, seeds = [], fatal = null;
  const stop = () => { controller.abort(); connection?.close().catch(() => {}); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (v.runMs) deadlineTimer = setTimeout(stop, v.runMs);
  const pause = async (ms) => { try { await sleep(ms, undefined, { signal: controller.signal }); } catch (_) {} };
  try {
    while (!controller.signal.aborted) {
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
        const code = safeCode(e);
        try { if (connection) await connection.close(); } catch (_) {} connection = null;
        if (code === 'ACCOUNT_SCOPE_CHANGED' || code.startsWith('CAPTURE_')) { fatal = code; break; }
        monitor.disconnect(code); failures += 1;
        await pause(Math.min(60000, 2000 * (2 ** Math.min(failures - 1, 5))));
      }
    }
  } finally {
    clearTimeout(deadlineTimer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (connection) await connection.close();
    monitor.connection = null; monitor.listening.clear(); monitor.pending.clear();
    monitor.state = fatal ? 'paused-' + fatal.toLowerCase() : 'stopped';
    if (fatal) monitor.diagnose(fatal);
    try { sink.publish(monitor.report()); } finally { sink.close(); }
  }
  return { state: monitor.state, scans: monitor.scans, measuredThreads: monitor.report().measuredThreads, fatal };
}
async function main(argv = process.argv.slice(2)) {
  const v = options(argv);
  if (v.help) { process.stdout.write('Automatic Codex cloud observer\n--acknowledge-auto-attach [--interval 5] [--max-listening 32] [--pages 3] [--seconds N] [--data-dir DIR]\nDiscovers active and newly created warm threads. No manual thread IDs, model starts, billing requests or thread configuration changes.\n'); return; }
  process.stdout.write('自动云端监听已启动；按 Ctrl+C 停止。报告目录：' + v.dataDir + '\n');
  const result = await run(v); process.stdout.write(JSON.stringify(result) + '\n');
}
if (require.main === module) main().catch((e) => { process.stderr.write('Cloud auto observer: ' + safeCode(e) + '\n'); process.exitCode = 1; });
module.exports = { options, run, ReportSink, lock, main };
