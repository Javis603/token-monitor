#!/usr/bin/env node
'use strict';

// Desktop wrapper for the existing, explicitly selected cloud event observer.
// No discovery, credential reader, billing request or model execution is added here.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { parseArgs } = require('node:util');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { identifier } = require('../src/shared/providers/codex/cloudUsage');

function failure(code) { return Object.assign(new Error(code), { code }); }
function parse(argv) {
  const { values: v } = parseArgs({ args: argv, allowPositionals: false, strict: true, options: {
    thread: { type: 'string' }, seconds: { type: 'string' }, headless: { type: 'boolean' }, help: { type: 'boolean' }
  } });
  if (v.help) return v;
  v.seconds = Number(v.seconds ?? 60);
  if (!Number.isInteger(v.seconds) || v.seconds < 1 || v.seconds > 120) throw failure('INVALID_DURATION');
  if (v.thread !== undefined) v.thread = identifier(v.thread.trim());
  if (v.headless && !v.thread) throw failure('HEADLESS_REQUIRES_THREAD');
  return v;
}
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) throw failure('UNSAFE_REPORT_DIRECTORY');
  if (process.getuid && stat.uid !== process.getuid()) throw failure('REPORT_DIRECTORY_OWNER');
  fs.chmodSync(directory, 0o700);
  return directory;
}
function writeReceipt(run, receipt) {
  const temporary = path.join(run, `.receipt-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(run, 'capture.json'));
  } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
}
async function askThread(seconds, execute = promisify(execFile)) {
  const script = `set answer to display dialog "请输入真实云端引擎线程 UUID。接下来监听 ${seconds} 秒。\n\n请在任务执行前或执行期间开始；已结束的旧任务可能没有新计数。接入可能加载线程运行环境，但不会提交模型请求。" default answer "" buttons {"取消", "开始监听"} default button "开始监听" cancel button "取消" with title "Codex 云端实时 Token"\nreturn text returned of answer`;
  try {
    const r = await execute('/usr/bin/osascript', ['-e', script], { timeout: 120000, maxBuffer: 16384 });
    return identifier(r.stdout.trim());
  } catch (e) {
    if (e.code === 'INVALID_ID') throw e;
    if (String(e.stderr || '').includes('(-128)')) return null;
    throw failure(e.killed ? 'THREAD_DIALOG_TIMEOUT' : 'THREAD_DIALOG_UNAVAILABLE');
  }
}
function readResult(file, expectedThread) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4_000_000) throw failure('INVALID_CAPTURE_REPORT');
    const buffer = Buffer.alloc(4_000_001); let bytes = 0;
    while (bytes < buffer.length) { const n = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null); if (!n) break; bytes += n; }
    if (bytes > 4_000_000) throw failure('INVALID_CAPTURE_REPORT');
    const r = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
    if (r.kind !== 'codex-cloud-live-token-count' || r.threadId !== expectedThread || !['observed', 'ambiguous', 'no-usage-notification'].includes(r.status)) throw failure('CAPTURE_IDENTITY_MISMATCH');
    return r;
  } finally { fs.closeSync(fd); }
}
async function launch(argv = process.argv.slice(2), deps = {}) {
  const v = parse(argv);
  if (v.help) {
    process.stdout.write('Codex cloud capture desktop: [--thread UUID] [--seconds 1..120] [--headless]\nWithout a thread, a macOS dialog asks for explicit selection. No automatic model task or account-wide scan.\n');
    return { status: 'help' };
  }
  const thread = v.thread || await (deps.askThread || askThread)(v.seconds);
  if (!thread) return { status: 'cancelled' };
  identifier(thread);
  const root = privateDirectory(deps.dataRoot || path.join(os.homedir(), 'Library/Application Support/Token Monitor Usage Test'));
  const reports = privateDirectory(path.join(root, 'reports'));
  const run = fs.mkdtempSync(path.join(reports, 'engine-capture-')); fs.chmodSync(run, 0o700);
  const json = path.join(run, 'report.json'), html = path.join(run, 'report.html'), events = path.join(run, 'events.jsonl');
  const startedAt = new Date().toISOString();
  const args = [path.join(__dirname, 'codex-cloud-engine-usage.js'), '--thread', thread, '--attach-existing-thread',
    '--wait-seconds', String(v.seconds), '--events', events, '--output', json, '--html', html, '--json'];
  const log = fs.openSync(path.join(run, 'capture.log'), 'wx', 0o600);
  let child, timer, exitCode, endSignal = null, expired = false, stopRequested = false;
  const stop = () => { stopRequested = true; child?.kill('SIGINT'); };
  try {
    child = (deps.spawn || spawn)(process.execPath, args, { shell: false, detached: process.platform !== 'win32', stdio: ['ignore', log, log], env: process.env });
    // Install listeners before any post-spawn filesystem operation can fail.
    const exited = new Promise((resolve) => {
      child.once('error', () => resolve([1, null]));
      child.once('close', (code, signal) => resolve([code ?? 1, signal]));
    });
    writeReceipt(run, { version: 1, state: 'listening', threadId: thread, startedAt, durationSeconds: v.seconds, pid: child.pid ?? null });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, (v.seconds + 65) * 1000);
    const killTimer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, (v.seconds + 75) * 1000);
    try {
      [exitCode, endSignal] = await exited;
    } finally { clearTimeout(killTimer); }
  } catch (_) { child?.kill('SIGTERM'); exitCode = 1; }
  finally { clearTimeout(timer); fs.closeSync(log); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  let report = null, reportError = null;
  if (exitCode === 0) { try { report = readResult(json, thread); } catch (_) { reportError = 'CAPTURE_REPORT_INVALID'; exitCode = 1; } }
  const result = { version: 1, state: expired ? 'timeout' : exitCode ? 'failed' : report?.status || 'unavailable',
    threadId: thread, startedAt, finishedAt: new Date().toISOString(), durationSeconds: v.seconds,
    stopRequested, exitCode, exitSignal: endSignal, errorCode: reportError,
    totalTokens: report?.total?.totalTokens ?? null, runDirectory: run, reportPath: report ? html : null, eventPath: events };
  writeReceipt(run, result);
  if (report && !v.headless && fs.existsSync(html)) {
    try { await (deps.execute || promisify(execFile))('/usr/bin/open', [html], { timeout: 15000, maxBuffer: 16384 }); }
    catch (_) { result.openStatus = 'browser-open-failed'; writeReceipt(run, result); }
  }
  if (exitCode) process.exitCode = 1;
  return result;
}
if (require.main === module) launch().then((result) => { if (result.status !== 'help') process.stdout.write(JSON.stringify(result, null, 2) + '\n'); }).catch((e) => {
  process.stderr.write(`Codex capture: ${/^[A-Z_]{1,60}$/.test(e.code || '') ? e.code : 'LAUNCH_FAILED'}\n`); process.exitCode = 1;
});
module.exports = { launch, parse, askThread, readResult, privateDirectory };
