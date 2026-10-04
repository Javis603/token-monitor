#!/usr/bin/env node
'use strict';
const { parseArgs } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { collectCloudUsage, error, identifier } = require('../src/shared/providers/codex/cloudUsage');
const { CloudTransport, cachedReferences } = require('../src/shared/providers/codex/cloudTransport');
const { renderCloudHtml } = require('../src/shared/providers/codex/cloudView');
const HELP = `Codex hosted cloud usage (read-only; internal protocol; may be unavailable)
Usage: npm run codex:usage -- --cloud --thread ENGINE_THREAD_ID [options]
  --thread ID         Exact cloud engine thread; repeatable (not a task-card id)
  --discover          Union default/subagent and active/archived cloud catalogs
  --descendants       Include known account-matched cached descendants (partial)
  --quotas            Also read separate allowance percentages/purchased credits
  --max-threads N     1–100, default 40
  --max-turns N       1–3000, default 1000
  --pages N           1–20 pages per list, default 3
  --budget N          Whole-session seconds, 5–180, default 90
  --codex-home PATH   Existing signed-in home (no login/credential copying)
  --output-dir PATH   New private output directory with JSON and HTML
  --json              JSON stdout
  --help              No network or authentication reads
No model turns, thread resumes, subscriptions, permission grants, or /tbo calls.
Token fields, service estimates and quotas remain separate from local totals.\n`;
function args(argv) {
  const { values: v } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    thread: { type: 'string', multiple: true }, discover: { type: 'boolean' }, descendants: { type: 'boolean' }, quotas: { type: 'boolean' },
    'max-threads': { type: 'string' }, 'max-turns': { type: 'string' }, pages: { type: 'string' }, budget: { type: 'string' },
    'codex-home': { type: 'string' }, 'output-dir': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (v.help) return v;
  const number = (key, def, max, min = 1) => { const n = v[key] === undefined ? def : Number(v[key]); if (!Number.isInteger(n) || n < min || n > max) throw error('INVALID_LIMIT'); return n; };
  v.maxThreads = number('max-threads', 40, 100); v.maxTurns = number('max-turns', 1000, 3000); v.maxPages = number('pages', 3, 20); v.budgetMs = number('budget', 90, 180, 5) * 1000;
  v.threadIds = [...new Set((v.thread || []).map(identifier))];
  if (!v.discover && !v.threadIds.length) throw error('SELECT_THREAD_OR_DISCOVER');
  if (v.threadIds.length > v.maxThreads) throw error('THREAD_LIMIT');
  return v;
}
async function main(argv = process.argv.slice(2), deps = {}) {
  const v = args(argv); if (v.help) { process.stdout.write(HELP); return; }
  let dir;
  if (v['output-dir']) { const requested = path.resolve(v['output-dir']); dir = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested)); fs.mkdirSync(dir, { mode: 0o700 }); }
  const abort = new AbortController(); let transport; const stop = () => { abort.abort(); transport?.close().catch(() => {}); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let report;
  try {
    transport = deps.createTransport ? deps.createTransport(v) : new CloudTransport({ home: v['codex-home'], budgetMs: v.budgetMs });
    await transport.initialize();
    const seeds = deps.seedReferences || cachedReferences(transport.home, transport.credential);
    report = await collectCloudUsage(transport, { ...v, seedReferences: seeds, includeDescendants: !!v.descendants, signal: abort.signal });
    report.transportAudit = { ...transport.audit };
  } catch (e) {
    const code = /^[A-Z_]{1,80}$/.test(e.code || '') ? e.code : 'CLOUD_READ_FAILED';
    report = { version: 1, kind: 'codex-cloud-turn-usage', observedAt: new Date().toISOString(), status: 'unavailable', measurement: 'service-estimate-not-bill',
      canCombineWithLocal: false, accountCloudCoverage: 'unknown', diagnostics: [{ stage: 'connection', code }], threads: [], turns: [], quotas: [], totals: null };
    process.exitCode = 1;
  } finally { await transport?.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  if (dir) {
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'report.html'), renderCloudHtml(report), { flag: 'wx', mode: 0o600 });
  }
  if (report.status === 'unavailable') process.exitCode = 1;
  if (v.json) process.stdout.write(JSON.stringify(report) + '\n');
  else {
    const tokens = report.totals?.observedSettledTokens;
    process.stdout.write(`Codex 云端读取：${report.status}\n线程 ${report.threads.length}；轮次 ${report.turns.length}；有 token 的轮次 ${report.totals?.tokenTurns ?? 0}\n可去重的已观测 Token：${tokens == null ? '未知' : tokens}\n逐轮用量接口：${report.usageAccess || '不可用'}；额度接口：${report.quotaAccess || '未查询'}\n${report.diagnostics.map((d) => `${d.stage}: ${d.code}`).join('\n')}\n`);
  }
  return report;
}
if (require.main === module) main().catch((e) => { process.stderr.write(`Codex cloud usage: ${/^[A-Z_]{1,80}$/.test(e.code || '') ? e.code : 'INVALID_REQUEST'}. See --help.\n`); process.exitCode = 1; });
module.exports = { main, args };
