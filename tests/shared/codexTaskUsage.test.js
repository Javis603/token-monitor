'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskUsageLedger, normalizeUsage, sumUsage } = require('../../src/shared/providers/codex/taskUsage');
const { collectTaskUsage, readEvents, safeRollout, MAX_LINE_BYTES } = require('../../src/shared/providers/codex/taskUsageReader');
const { DatabaseSync } = require('node:sqlite');

function usage(total, extra = {}) {
  return { input_tokens: total - 10, cached_input_tokens: 5, cache_write_input_tokens: 0,
    output_tokens: 10, reasoning_output_tokens: 3, total_tokens: total, ...extra };
}
function snapshot(id, total) {
  return { method: 'thread/tokenUsage/updated', params: { threadId: id, tokenUsage: { total: usage(total), last: usage(total) } } };
}
function request(id, response, total) {
  return { type: 'token_usage_record', payload: { thread_id: id, response_id: response, usage: usage(total),
    turn_token_usage: usage(999), thread_token_usage: usage(999) } };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-task-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function writeEvents(dir, events, file = 'events.jsonl') {
  const p = path.join(dir, file); fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n'); return p;
}

test('snapshots replace rather than accumulate, including repeated export replay', () => {
  const l = new TaskUsageLedger();
  for (const n of [100, 150, 200, 100, 150, 200]) l.ingest(snapshot('root', n));
  const r = l.report('root');
  assert.equal(r.knownUsage.totalTokens, 200);
  assert.equal(r.threads[0].status, 'snapshot-only');
  assert.equal(r.diagnostics.length, 0);
});

test('request IDs deduplicate across exports and snapshots are never added again', () => {
  const l = new TaskUsageLedger();
  for (const e of [request('root', 'r1', 100), request('root', 'r1', 100), request('root', 'r2', 100),
    { method: 'thread/tokenUsage/updated', params: { threadId: 'root', tokenUsage: { total: {
      inputTokens: 180, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 6, totalTokens: 200
    } } } }]) l.ingest(e);
  const r = l.report('root');
  assert.equal(r.knownUsage.totalTokens, 200);
  assert.equal(r.threads[0].uniqueRequests, 2);
  assert.equal(r.threads[0].status, 'reconciled');
});

test('parent, child, grandchild and missing child remain separate', () => {
  const l = new TaskUsageLedger();
  l.metadata({ id: 'child', parentThreadId: 'root' });
  l.metadata({ id: 'grandchild', parentThreadId: 'child' });
  l.metadata({ id: 'missing', parentThreadId: 'root' });
  l.ingest(request('root', 'r1', 200)); l.ingest(request('child', 'r2', 80)); l.ingest(request('grandchild', 'r3', 20));
  l.ingest(request('unrelated', 'r4', 1000));
  const r = l.report('root');
  assert.equal(r.knownUsage.totalTokens, 300);
  assert.equal(r.coverage.knownThreads, 4); assert.equal(r.coverage.missingUsageThreads, 1);
  assert.equal(r.threads.find((x) => x.threadId === 'missing').ownUsage, null);
  assert.equal(r.accountCloudCoverage, 'unknown');
});

test('cached and reasoning are subsets; absent breakdown stays unknown', () => {
  assert.equal(normalizeUsage(usage(100)).totalTokens, 100);
  const u = normalizeUsage({ input_tokens: 90, output_tokens: 10 });
  assert.equal(u.cachedInputTokens, null); assert.equal(u.totalTokens, 100);
  assert.equal(sumUsage([u, normalizeUsage(usage(100))]).cachedInputTokens, null);
});

for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '90']) {
  test(`reject unsafe input count ${String(bad)}`, () => assert.equal(normalizeUsage(usage(100, { input_tokens: bad })), null));
}
for (const extra of [{ cached_input_tokens: 91 }, { reasoning_output_tokens: 11 }, { total_tokens: 101 }, { output_tokens: -1 }]) {
  test(`reject invalid usage relation ${JSON.stringify(extra)}`, () => assert.equal(normalizeUsage(usage(100, extra)), null));
}

test('conflicting copies of a request are excluded rather than double counted', () => {
  const l = new TaskUsageLedger(); l.ingest(request('a', 'r', 100)); l.ingest(request('b', 'r', 100));
  assert.equal(l.report().knownUsage, null);
  assert.equal(l.report().coverage.missingUsageThreads, 2);
});

test('partial records do not masquerade as complete lifetime usage', () => {
  const l = new TaskUsageLedger(); l.ingest(request('a', 'r', 100)); l.ingest(snapshot('a', 500));
  const r = l.report(); assert.equal(r.knownUsage.totalTokens, 100);
  assert.equal(r.threads[0].reportedLifetimeUsage.totalTokens, 500); assert.equal(r.threads[0].status, 'partial');
});

test('counter reset and forked snapshots cannot become new billable usage', () => {
  const l = new TaskUsageLedger(); l.ingest(snapshot('reset', 200)); l.ingest(snapshot('reset', 30));
  l.metadata({ id: 'fork', forked_from_id: 'old' }); l.ingest(snapshot('fork', 200));
  assert.equal(l.report().knownUsage, null); assert.equal(l.report().coverage.missingUsageThreads, 2);
});

test('inherited request keeps its original owner', () => {
  const l = new TaskUsageLedger(); l.metadata({ id: 'child', parentThreadId: 'root' });
  l.ingest(request('root', 'r1', 100), { threadId: 'child' }); l.ingest(request('root', 'r1', 100));
  assert.equal(l.report('child').knownUsage, null); assert.equal(l.report('root').knownUsage.totalTokens, 100);
});

test('cycles terminate with explicit diagnostic', () => {
  const l = new TaskUsageLedger(); l.metadata({ id: 'a', parentThreadId: 'b' }); l.metadata({ id: 'b', parentThreadId: 'a' });
  l.ingest(request('a', 'r1', 100)); const r = l.report('a');
  assert.equal(r.knownUsage.totalTokens, 100); assert.equal(r.coverage.knownThreads, 2);
  assert.ok(r.diagnostics.some((d) => d.code === 'parent-cycle'));
});

test('source JSON links child but does not infer cloud or dot', () => {
  const l = new TaskUsageLedger(); l.metadata({ id: 'c', source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'p' } } }),
    originator: 'codex_work_desktop', cwd: '/root/cloud', thread_source: 'agent_created_thread' });
  const row = l.report('p').threads.find((x) => x.threadId === 'c');
  assert.equal(row.parentThreadId, 'p'); assert.equal(row.executionEnvironment, 'unknown'); assert.equal(row.dotId, null);
});

test('manifest only declares known cloud tasks and expected missing children', async (t) => {
  const dir = fixture(t);
  const file = writeEvents(dir, [{ type: 'token-monitor.task-manifest', version: 1, threads: [
    { id: 'root', executionEnvironment: 'cloud', taskId: 'task-1', dotId: 'dot-1', prompt: 'SECRET_TEXT' },
    { id: 'child', parentThreadId: 'root', executionEnvironment: 'cloud' }
  ] }, request('root', 'r1', 100), { type: 'message', content: 'SECRET_TEXT', auth: 'SECRET_CREDENTIAL' }]);
  const r = await collectTaskUsage({ noLocal: true, events: [file, file], thread: 'root', sqlite: { get DatabaseSync() { throw new Error('must not open'); } } });
  assert.equal(r.knownUsage.totalTokens, 100); assert.equal(r.coverage.missingUsageThreads, 1);
  assert.equal(r.threads.find((x) => x.threadId === 'root').dotId, 'dot-1');
  assert.equal(r.accountCloudCoverage, 'unknown'); assert.doesNotMatch(JSON.stringify(r), /SECRET_TEXT|SECRET_CREDENTIAL/);
});

test('malformed and oversized lines are bounded, diagnostic, and never exported', async (t) => {
  const dir = fixture(t); const file = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(request('a', 'r1', 100))}\n${'x'.repeat(MAX_LINE_BYTES + 20)}\n{"secret":"PRIVATE_PARTIAL`);
  const l = new TaskUsageLedger(); await readEvents(file, l); const r = l.report();
  assert.equal(r.knownUsage.totalTokens, 100);
  assert.ok(r.diagnostics.some((d) => d.code === 'malformed-json-line'));
  assert.ok(r.diagnostics.some((d) => d.code === 'oversized-line-skipped'));
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_PARTIAL/);
});

test('read-only local SQLite plus realistic rollout integration, archived children included', async (t) => {
  const dir = fixture(t); fs.mkdirSync(path.join(dir, 'sessions')); fs.mkdirSync(path.join(dir, 'archived_sessions'));
  const root = writeEvents(path.join(dir, 'sessions'), [{ type: 'session_meta', payload: { id: 'root', base_instructions: 'PRIVATE' } },
    request('root', 'r1', 100), { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(100) } } }]);
  const child = writeEvents(path.join(dir, 'archived_sessions'), [{ type: 'session_meta', payload: { id: 'child', parent_thread_id: 'root' } }, request('child', 'r2', 80)]);
  const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT, source TEXT, rollout_path TEXT, first_user_message TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT)');
  const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?)');
  insert.run('root', 'vscode', root, 'PRIVATE'); insert.run('child', 'exec', child, 'PRIVATE');
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run('root', 'child');
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run('root', 'missing'); db.close();
  const before = fs.readFileSync(path.join(dir, 'state_5.sqlite'));
  const r = await collectTaskUsage({ codexHome: dir, thread: 'root' });
  assert.equal(r.knownUsage.totalTokens, 180); assert.equal(r.coverage.knownThreads, 3);
  assert.equal(r.coverage.missingUsageThreads, 1); assert.equal(r.coverage.reconciledThreads, 1);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|first_user_message/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state_5.sqlite')), before);
});

test('missing and unsupported catalog preserve unknown', async (t) => {
  const dir = fixture(t); let r = await collectTaskUsage({ codexHome: dir });
  assert.equal(r.knownUsage, null); assert.ok(r.diagnostics.some((d) => d.code === 'local-catalog-missing'));
  const db = new DatabaseSync(path.join(dir, 'state_2.sqlite')); db.exec('CREATE TABLE unrelated(id TEXT)'); db.close();
  r = await collectTaskUsage({ codexHome: dir }); assert.ok(r.diagnostics.some((d) => d.code === 'unsupported-catalog-schema'));
});

test('unreadable SQLite does not invent zero usage', async (t) => {
  const dir = fixture(t); fs.writeFileSync(path.join(dir, 'state_5.sqlite'), 'not a database');
  const r = await collectTaskUsage({ codexHome: dir }); assert.equal(r.knownUsage, null);
  assert.ok(r.diagnostics.some((d) => d.code === 'catalog-unreadable'));
});

test('local path escape and symlinks cannot read arbitrary files', (t) => {
  const dir = fixture(t); fs.mkdirSync(path.join(dir, 'sessions'));
  const outside = writeEvents(dir, [request('a', 'r1', 100)]);
  const link = path.join(dir, 'sessions', 'link.jsonl'); fs.symlinkSync(outside, link);
  assert.equal(safeRollout(outside, dir), false); assert.equal(safeRollout(link, dir), false);
});

test('rollout identity mismatch refuses records in wrong file', async (t) => {
  const dir = fixture(t); const file = writeEvents(dir, [{ type: 'session_meta', payload: { id: 'other' } }, request('other', 'r1', 100)]);
  const l = new TaskUsageLedger(); l.thread('expected'); await readEvents(file, l, { threadId: 'expected' });
  assert.equal(l.report().knownUsage, null); assert.ok(l.report().diagnostics.some((d) => d.code === 'rollout-identity-mismatch'));
});

test('unknown requested root is visible rather than an empty zero report', () => {
  const r = new TaskUsageLedger().report('missing'); assert.equal(r.coverage.knownThreads, 1);
  assert.equal(r.knownUsage, null); assert.equal(r.threads[0].ownUsage, null);
});


test('timestamp distinguishes a real reset from byte-identical export replay', () => {
  const l = new TaskUsageLedger();
  for (const [total, time] of [[100, '01'], [200, '02'], [100, '03']]) {
    l.ingest({ ...snapshot('a', total), timestamp: `2026-10-04T00:00:${time}Z` });
  }
  assert.equal(l.report().knownUsage, null);
  assert.ok(l.report().diagnostics.some((d) => d.code === 'nonmonotonic-snapshot'));
});

test('inconsistent snake/camel counters are not silently preferred', () => {
  assert.equal(normalizeUsage({ ...usage(100), inputTokens: 91 }), null);
});

test('selected task exposes main and descendants separately', () => {
  const l = new TaskUsageLedger(); l.metadata({ id: 'child', parentThreadId: 'root' });
  l.ingest(request('root', 'r1', 200)); l.ingest(request('child', 'r2', 80));
  const r = l.report('root');
  assert.equal(r.rootOwnUsage.totalTokens, 200); assert.equal(r.descendantsKnownUsage.totalTokens, 80);
  assert.equal(r.knownUsage.totalTokens, 280);
});
