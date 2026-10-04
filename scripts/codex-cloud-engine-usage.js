#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { CloudEngineUsage } = require('../src/shared/providers/codex/cloudEngineUsage');
const { renderCloudLiveHtml } = require('../src/shared/providers/codex/cloudLiveMeter');
const { identifier, error } = require('../src/shared/providers/codex/cloudUsage');
const HELP = `Usage: codex-cloud-engine-usage.js --thread UUID --attach-existing-thread [options]
  --wait-seconds N    Listen for 1–120 seconds (default 30)
  --events FILE       Save validated numeric events immediately as private NDJSON
  --output FILE       Save the final private JSON report; refuses overwrite
  --html FILE         Save a static local HTML view; refuses overwrite
  --json              Print the final JSON instead of a summary
  --help              Help without accessing a login
Attaches to an existing hosted thread. No model turn or billing query is sent.
Attachment may load a cloud environment. Idle historical tasks may yield no event.
`;
function argumentsFor(argv) {
  const { values: v } = parseArgs({ args: argv, allowPositionals: false, strict: true, options: {
    thread: { type: 'string' }, 'attach-existing-thread': { type: 'boolean' }, output: { type: 'string' },
    events: { type: 'string' }, html: { type: 'string' }, 'wait-seconds': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' }
  } });
  if (v.help) return v;
  if (!v.thread || !v['attach-existing-thread']) throw error('EXPLICIT_ATTACH_REQUIRED');
  identifier(v.thread);
  v.waitSeconds = Number(v['wait-seconds'] ?? 30);
  if (!Number.isInteger(v.waitSeconds) || v.waitSeconds < 1 || v.waitSeconds > 120) throw error('INVALID_WAIT');
  const destinations = [v.output, v.events, v.html].filter(Boolean).map((f) => {
    const resolved = path.resolve(f);
    const parent = fs.realpathSync(path.dirname(resolved));
    const canonical = path.join(parent, path.basename(resolved));
    try { fs.lstatSync(canonical); throw error('OUTPUT_EXISTS'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    return canonical;
  });
  if (new Set(destinations).size !== destinations.length) throw error('OUTPUT_EXISTS');
  return v;
}
async function main(argv = process.argv.slice(2)) {
  const v = argumentsFor(argv);
  if (v.help) { process.stdout.write(HELP); return; }
  let eventFd; let observer;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (v.events) eventFd = fs.openSync(v.events, 'wx', 0o600);
    observer = new CloudEngineUsage({ budgetMs: Math.min(180000, v.waitSeconds * 1000 + 45000), timeoutMs: 20000 });
    const r = await observer.capture(v.thread, { acknowledgeAttach: true, waitMs: v.waitSeconds * 1000, signal: controller.signal,
      onSample: eventFd === undefined ? undefined : (sample) => {
        fs.writeSync(eventFd, JSON.stringify({ source: 'hosted-engine-token-notification', scopeFingerprint: observer.scopeFingerprint, sample }) + '\n'); fs.fsyncSync(eventFd);
      } });
    if (v.output) fs.writeFileSync(v.output, JSON.stringify(r, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (v.html) fs.writeFileSync(v.html, renderCloudLiveHtml(r), { flag: 'wx', mode: 0o600 });
    process.stdout.write(v.json ? JSON.stringify(r) + '\n' : JSON.stringify({ status: r.status, threadId: r.threadId,
      total: r.total, lastRequest: r.lastRequest, coverage: r.coverage, lifecycle: r.lifecycle, audit: r.transportAudit }, null, 2) + '\n');
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (observer) await observer.close(); if (eventFd !== undefined) fs.closeSync(eventFd);
  }
}
if (require.main === module) main().catch((e) => { process.stderr.write(`Cloud engine observation: ${/^[A-Z_]{1,60}$/.test(e.code || '') ? e.code : 'FAILED'}\n`); process.exitCode = 1; });
module.exports = { main, argumentsFor };
