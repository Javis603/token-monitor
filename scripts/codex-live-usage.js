#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { UsageRpc, rpcError } = require('../src/shared/providers/codex/usageRpc');
const { syncUsage } = require('../src/shared/providers/codex/usageSync');
const { renderUsageHtml } = require('../src/shared/providers/codex/usageView');
const HELP = `Codex live usage reader / 自动读取服务端用量（不启动模型任务）
Usage: node scripts/codex-live-usage.js [options]
  --codex-binary PATH  Existing signed-in Codex executable (no download/login)
  --codex-home DIR     Pass CODEX_HOME; never copy credentials
  --thread ID          Query this thread; repeatable; descendants included
  --bindings FILE      Optional task/dot/expected-child declarations
  --discover           Query threads in the connected app-server catalog
  --no-descendants     Query only explicitly supplied IDs
  --output-dir DIR     Create a NEW private report directory (JSON + HTML)
  --watch              Refresh every 60 seconds (requires --output-dir)
  --interval SECONDS   60–86400 (default 60)
  --timeout SECONDS    Per-RPC timeout, 1–120 (default 20)
  --json               JSON stdout (default human-readable)
  --help               Show help without starting Codex
The account view and thread estimates are separate from Tokscale totals.
This does not enumerate every hosted cloud/dot task or infer missing usage.
`;
function options(argv) {
  const { values } = parseArgs({ args: argv, allowPositionals: false, strict: true, options: {
    'codex-binary': { type: 'string' }, 'codex-home': { type: 'string' }, thread: { type: 'string', multiple: true },
    bindings: { type: 'string' }, discover: { type: 'boolean' }, 'no-descendants': { type: 'boolean' },
    'output-dir': { type: 'string' }, watch: { type: 'boolean' }, interval: { type: 'string' },
    timeout: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' }
  } });
  if (values.help) return values;
  const number = (v, fallback, min, max) => {
    const n = v === undefined ? fallback : Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw rpcError('INVALID_INTERVAL_OR_TIMEOUT');
    return n;
  };
  values.intervalSeconds = number(values.interval, 60, 60, 86400);
  values.timeoutMs = number(values.timeout, 20, 1, 120) * 1000;
  if (values.watch && !values['output-dir']) throw rpcError('WATCH_REQUIRES_OUTPUT_DIR');
  return values;
}
function findBinary(explicit) {
  if (explicit) return explicit;
  const candidates = process.platform === 'darwin' ? [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex'
  ] : [];
  for (const p of candidates) { try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) {} }
  return 'codex';
}
function readBindings(filename) {
  if (!filename) return null;
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw rpcError('INVALID_BINDINGS_FILE');
    const buf = Buffer.alloc(1024 * 1024 + 1); let n = 0;
    while (n < buf.length) { const size = fs.readSync(fd, buf, n, buf.length - n, null); if (!size) break; n += size; }
    if (n > 1024 * 1024) throw rpcError('INVALID_BINDINGS_FILE');
    try { return JSON.parse(buf.subarray(0, n).toString('utf8')); }
    catch (_) { throw rpcError('INVALID_BINDINGS_FILE'); }
  } finally { fs.closeSync(fd); }
}
function outputDirectory(requested) {
  if (!requested) return null;
  const parent = fs.realpathSync(path.dirname(path.resolve(requested)));
  const directory = path.join(parent, path.basename(path.resolve(requested)));
  fs.mkdirSync(directory, { mode: 0o700 }); return directory;
}
function saveSnapshot(directory, snapshot, refreshSeconds) {
  const files = [['report.json', JSON.stringify(snapshot, null, 2) + '\n'], ['report.html', renderUsageHtml(snapshot, refreshSeconds)]];
  for (const [name, content] of files) {
    const tmp = path.join(directory, `.${name}.${randomUUID()}.tmp`);
    try { fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, path.join(directory, name)); }
    finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  }
}
function textReport(report) {
  const amount = (n) => n === null || n === undefined ? 'unknown' : n.toLocaleString('en-US');
  const lines = [`Codex 服务端用量 · ${report.observedAt}`,
    `账户累计 Token: ${amount(report.account.report?.summary?.lifetimeTokens)}（账户口径，非云端专属）`,
    `已查询线程: ${report.inventory.selectedThreads}; 有 Token 数: ${report.inventory.measuredThreads}; 缺失: ${report.inventory.unavailableThreads}`,
    '线程ID\t父线程\tToken（估算）\t状态'];
  for (const t of report.threads) lines.push(`${t.threadId}\t${t.parentThreadId || '-'}\t${amount(t.usage?.tokens.totalTokens)}\t${t.status}`);
  return lines.concat('', ...report.warnings).join('\n') + '\n';
}
// Each poll opens a new signed-in connection. Without verified account
// continuity, an old account's body must not survive a failed reconnection.
function unavailableSnapshot(previous, code, attemptedAt) {
  return { version: 1, state: 'unavailable', attemptedAt,
    lastSuccessAt: code === 'ACCOUNT_CHANGED_DURING_SYNC' ? null : previous?.observedAt || null,
    errorCode: code, report: null };
}
async function main(argv = process.argv.slice(2), deps = {}) {
  const v = options(argv);
  if (v.help) { process.stdout.write(HELP); return; }
  const bindings = readBindings(v.bindings);
  const { normalizeBindings } = require('../src/shared/providers/codex/usageSync');
  normalizeBindings(bindings);
  if ((v.thread || []).some((t) => !/^[A-Za-z0-9_.:-]{1,200}$/.test(t))) throw rpcError('INVALID_THREAD_ID');
  const binary = findBinary(v['codex-binary']);
  const directory = outputDirectory(v['output-dir']);
  const env = { ...process.env };
  if (v['codex-home']) env.CODEX_HOME = path.resolve(v['codex-home']);
  const aborter = new AbortController();
  let active; let consecutiveFailures = 0; let lastReport = null;
  const stop = () => { aborter.abort(); active?.close().catch(() => {}); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    do {
      const attemptAt = new Date().toISOString();
      try {
        active = deps.createRpc ? deps.createRpc({ binary, env, timeoutMs: v.timeoutMs }) : new UsageRpc({ binary, env, timeoutMs: v.timeoutMs });
        await active.initialize();
        const collect = () => syncUsage(active, { threadIds: v.thread || [], bindings, discover: !!v.discover,
          includeDescendants: !v['no-descendants'], signal: aborter.signal, normalizeAccount: deps.normalizeAccount });
        let report;
        try { report = await collect(); }
        catch (error) {
          if (error.code !== 'ACCOUNT_CHANGED_DURING_SYNC' || aborter.signal.aborted) throw error;
          // Startup/auth refresh notifications can arrive after initialize.
          // Discard EVERY value, then recollect once on the same connection.
          // A second update still fails; no old sample or identity is reused.
          report = await collect();
        }
        if (report.account.status !== 'reported' && report.inventory.measuredThreads === 0) throw rpcError('ALL_USAGE_UNAVAILABLE');
        lastReport = report; consecutiveFailures = 0;
        const snapshot = { version: 1, state: 'fresh', attemptedAt: attemptAt, lastSuccessAt: report.observedAt, report };
        if (directory) saveSnapshot(directory, snapshot, v.watch ? v.intervalSeconds : 0);
        process.stdout.write(v.json ? JSON.stringify(snapshot) + '\n' : textReport(report));
      } catch (e) {
        if (aborter.signal.aborted) break;
        consecutiveFailures += 1;
        const code = /^[A-Z_]{1,60}$/.test(e.code || '') ? e.code : 'SYNC_FAILED';
        const snapshot = unavailableSnapshot(lastReport, code, attemptAt);
        lastReport = null;
        if (directory) saveSnapshot(directory, snapshot, v.watch ? v.intervalSeconds : 0);
        process.stderr.write(`Codex usage sync: ${code}.\n`);
        if (v.json) process.stdout.write(JSON.stringify(snapshot) + '\n');
        if (!v.watch) { process.exitCode = 1; return; }
      } finally { if (active) { await active.close(); active = null; } }
      if (!v.watch || aborter.signal.aborted) break;
      const seconds = Math.min(v.intervalSeconds * (2 ** Math.min(consecutiveFailures, 6)), 86400);
      try { await delay(seconds * 1000, undefined, { signal: aborter.signal }); } catch (_) { break; }
    } while (!aborter.signal.aborted);
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (directory && v.watch && aborter.signal.aborted) saveSnapshot(directory, { version: 1, state: 'stopped',
      attemptedAt: new Date().toISOString(), lastSuccessAt: lastReport?.observedAt || null, report: lastReport }, 0);
  }
}
if (require.main === module) main().catch((e) => {
  const code = /^[A-Z_]{1,60}$/.test(e.code || '') ? e.code : 'INVALID_REQUEST';
  process.stderr.write(`Codex live usage: ${code}. Run with --help.\n`); process.exitCode = 1;
});
module.exports = { main, options, readBindings, outputDirectory, saveSnapshot, findBinary, textReport, unavailableSnapshot };
