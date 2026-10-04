#!/usr/bin/env node
'use strict';
// Standalone local test launcher. Does not load Electron or alter its data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { escapeHtml } = require('../src/shared/providers/codex/usageView');

function readSettings(root) {
  const p = path.join(root, 'settings.json');
  if (!fs.existsSync(p)) return { threadIds: [] };
  const stat = fs.lstatSync(p);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('INVALID_SETTINGS');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(data.threadIds) || data.threadIds.length > 10 || data.threadIds.some((t) => typeof t !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(t))) throw new Error('INVALID_SETTINGS');
  return { threadIds: [...new Set(data.threadIds)] };
}
function atomicJson(filename, value) {
  const tmp = `${filename}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, filename);
}
function localHtml(report) {
  const num = (u) => u?.totalTokens === null || u?.totalTokens === undefined ? '未知' : escapeHtml(u.totalTokens.toLocaleString('en-US'));
  const rows = report.threads.map((t) => `<tr><td><code>${escapeHtml(t.threadId)}</code></td><td><code>${escapeHtml(t.parentThreadId || '—')}</code></td><td>${num(t.ownUsage)}</td><td>${escapeHtml(t.status)}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Codex 本地任务统计</title><style>body{font:16px/1.6 system-ui;margin:40px auto;padding:0 24px;max-width:1200px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #ddd}code{font-size:12px;overflow-wrap:anywhere}.note{padding:18px;background:#fff4db}h1{font-size:28px}</style><h1>Codex 本地任务／子线程统计</h1><p>主线程：<strong>${num(report.rootOwnUsage)}</strong> &ensp; 已知后代：<strong>${num(report.descendantsKnownUsage)}</strong> &ensp; 已知总量：<strong>${num(report.knownUsage)}</strong> token</p><p class="note">仅为所选本地日志的累计用量，不代表完整云端或 dot 统计；未知不等于零。不要与服务端估算或 Token Monitor 原有总数相加。</p><p>已知线程 ${report.coverage.knownThreads}；有用量 ${report.coverage.measuredThreads}；缺失 ${report.coverage.missingUsageThreads}。</p><table><thead><tr><th>线程</th><th>父线程</th><th>自身 Token</th><th>证据状态</th></tr></thead><tbody>${rows}</tbody></table><p>${report.warnings.map(escapeHtml).join(' · ')}</p></html>`;
}
async function launch(argv = process.argv.slice(2), deps = {}) {
  const { values } = parseArgs({ args: argv, options: { cloud: { type: 'boolean' }, local: { type: 'boolean' }, headless: { type: 'boolean' }, thread: { type: 'string', multiple: true }, help: { type: 'boolean' } }, allowPositionals: false });
  if (values.help) { process.stdout.write('Usage: codex-usage-desktop.js [--local|--cloud] [--thread ID] [--headless]\n'); return; }
  if (values.cloud && (values.local || !values.thread?.length)) throw new Error('CLOUD_REQUIRES_EXPLICIT_THREAD');
  const dataRoot = deps.dataRoot || path.join(os.homedir(), 'Library', 'Application Support', 'Token Monitor Usage Test');
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dataRoot).isSymbolicLink()) throw new Error('UNSAFE_DATA_ROOT');
  const settings = readSettings(dataRoot);
  const threadIds = values.thread || settings.threadIds;
  if (threadIds.length > 10 || threadIds.some((t) => !/^[A-Za-z0-9_.:-]{1,200}$/.test(t))) throw new Error('INVALID_THREAD');
  if (values.local && threadIds.length !== 1) throw new Error('LOCAL_REQUIRES_ONE_ROOT');
  const reportsRoot = path.join(dataRoot, 'reports');
  fs.mkdirSync(reportsRoot, { recursive: true, mode: 0o700 });
  const run = fs.mkdtempSync(path.join(reportsRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
  fs.chmodSync(run, 0o700);
  const output = path.join(run, values.local ? 'local.json' : values.cloud ? 'cloud' : 'live');
  const cli = path.join(__dirname, values.local ? 'codex-task-usage.js' : values.cloud ? 'codex-cloud-usage.js' : 'codex-live-usage.js');
  const args = values.local ? [cli, '--thread', threadIds[0], '--json', '--output', output] :
    [cli, '--json', '--output-dir', output, ...threadIds.flatMap((t) => ['--thread', t]), ...(values.cloud ? ['--quotas', '--max-turns', '100', '--pages', '2', '--budget', '60'] : [])];
  const log = fs.openSync(path.join(run, 'run.log'), 'wx', 0o600);
  const child = (deps.spawn || spawn)(process.execPath, args, { stdio: ['ignore', log, log], shell: false, env: process.env });
  const pid = child.pid;
  fs.closeSync(log);
  const lastPath = path.join(dataRoot, 'last-run.json');
  atomicJson(lastPath, { state: 'running', mode: values.local ? 'local' : values.cloud ? 'cloud' : 'service', pid, runDirectory: run, startedAt: new Date().toISOString() });
  const code = await new Promise((resolve) => {
    let settled = false;
    const done = (code) => { if (!settled) { settled = true; resolve(code ?? 1); } };
    child.once('error', () => done(1)); child.once('close', done);
  });
  let html = path.join(output, 'report.html');
  if (values.local && code === 0) {
    html = path.join(run, 'local.html');
    fs.writeFileSync(html, localHtml(JSON.parse(fs.readFileSync(output, 'utf8'))), { flag: 'wx', mode: 0o600 });
  }
  const view = fs.existsSync(html) ? html : null;
  atomicJson(lastPath, { state: code === 0 ? 'finished' : 'failed', exitCode: code, mode: values.local ? 'local' : values.cloud ? 'cloud' : 'service', runDirectory: run, reportPath: view, completedAt: new Date().toISOString() });
  if (!values.headless && view) {
    await new Promise((resolve) => {
      const opener = (deps.spawn || spawn)('/usr/bin/open', [view], { stdio: 'ignore', shell: false });
      opener.once('error', resolve); opener.once('close', resolve);
    });
  }
  if (code) process.exitCode = code;
  return { exitCode: code, reportPath: view, runDirectory: run };
}
if (require.main === module) launch().catch((e) => {
  const code = /^[A-Z_]{1,60}$/.test(e.message || '') ? e.message : 'LAUNCH_FAILED';
  process.stderr.write(`${code}\n`); process.exitCode = 1;
});
module.exports = { launch, readSettings, localHtml };
