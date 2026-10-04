#!/usr/bin/env node
'use strict';
// Synthetic protocol peer for tests. Never connects to an account or model.
const readline = require('node:readline');
const fs = require('node:fs');
let initialized = false;
let accountRequests = 0;
const mode = process.env.TM_USAGE_FIXTURE_MODE || 'normal';
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
const group = { model: 'fixture-model', reasoningEffort: 'max', speed: null,
  inputTokens: 90, netNewInputTokens: 40, cachedInputTokens: 50, outputTokens: 10, totalTokens: 100 };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch (_) { process.exit(4); }
  if (process.env.TM_USAGE_TRACE) fs.appendFileSync(process.env.TM_USAGE_TRACE, JSON.stringify(m) + '\n');
  if (m.method === 'initialize') { initialized = true; reply(m.id, { userAgent: 'synthetic-test' }); return; }
  if (m.method === 'initialized') return;
  if (m.id === 'server-approval') return;
  if (!initialized) { process.exit(5); }
  if (mode === 'timeout') return;
  if (mode === 'invalid-json') { process.stdout.write('not json\n'); return; }
  if (mode === 'large') { process.stdout.write('x'.repeat(2200000) + '\n'); return; }
  if (mode === 'error') { process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'SECRET_MARKER' } }) + '\n'); return; }
  if (mode === 'approval') process.stdout.write(JSON.stringify({ id: 'server-approval', method: 'item/permissions/requestApproval', params: { secret: 'SECRET_MARKER' } }) + '\n');
  if (m.method === 'account/usage/read') {
    if (!m.params?.threadId) {
      accountRequests += 1;
      if (mode === 'account-update-always' || (mode === 'account-update-once' && accountRequests === 1)) {
        process.stdout.write(JSON.stringify({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'pro' } }) + '\n');
      }
    }
    if (m.params?.threadId) {
      const tid = m.params.threadId;
      reply(m.id, { summary: {}, dailyUsageBuckets: null, threadUsage: tid === 'missing' ? null : {
        threadId: tid, groups: [group], estimatedUsageCreditsMicros: 100, estimatedUsageUsdMicros: null
      } });
    } else reply(m.id, { summary: { lifetimeTokens: mode === 'account-update-once' && accountRequests > 1 ? 22345 : 12345, peakDailyTokens: 400 },
      dailyUsageBuckets: [{ startDate: '2026-10-04', tokens: 400 }], privateData: 'SECRET_MARKER' });
  } else if (m.method === 'thread/list') reply(m.id, { data: m.params.archived ? [] : [
    { id: 'root', source: 'vscode', preview: 'SECRET_MARKER' },
    { id: 'child', source: { subAgent: { threadSpawn: { parentThreadId: 'root' } } } },
    { id: 'missing', parentThreadId: 'root', source: 'subAgentThreadSpawn' }
  ], nextCursor: null });
  else if (m.method === 'thread/read') reply(m.id, { thread: { id: m.params.threadId, source: 'vscode', title: 'SECRET_MARKER' } });
  else { process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32601 } }) + '\n'); }
});
