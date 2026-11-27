'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskUsageLedger } = require('../../src/shared/providers/codex/taskUsage');

const ID = '00000000-0000-4000-8000-000000000001';
const snapshot = (cached) => ({
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: cached, output_tokens: 20, total_tokens: 120 } } }
});

test('a reset in an optional counter is a reset, not a smaller measurement', () => {
  const ledger = new TaskUsageLedger();
  ledger.ingest(snapshot(60), { threadId: ID });
  ledger.ingest(snapshot(10), { threadId: ID });
  const report = ledger.report(ID);
  assert.ok(report.diagnostics.some((d) => d.code === 'nonmonotonic-snapshot'));
  // A reset must never be published as a lifetime snapshot-only breakdown.
  assert.notEqual(report.threads[0].status, 'snapshot-only');
  assert.ok(report.threads[0].issues.includes('nonmonotonic-snapshot'));
});

test('growing counters keep the snapshot-only status', () => {
  const ledger = new TaskUsageLedger();
  ledger.ingest(snapshot(60), { threadId: ID });
  ledger.ingest(snapshot(70), { threadId: ID });
  const report = ledger.report(ID);
  assert.equal(report.threads[0].status, 'snapshot-only');
  assert.ok(!report.diagnostics.some((d) => d.code === 'nonmonotonic-snapshot'));
});
