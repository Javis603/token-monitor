'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { UsageRpc } = require('../../src/shared/providers/codex/usageRpc');
const { syncUsage, normalizeThreadUsage, normalizeBindings, SOURCES } = require('../../src/shared/providers/codex/usageSync');
const { renderUsageHtml } = require('../../src/shared/providers/codex/usageView');
const { importCloudTaskUsage } = require('../../src/shared/cloudUsageImport');
const fixture = path.resolve(__dirname, '../fixtures/codexUsageRpc.cjs');
const baseGroup = { model: 'fixture', reasoningEffort: null, speed: null,
  inputTokens: 90, netNewInputTokens: 40, cachedInputTokens: 50, outputTokens: 10, totalTokens: 100 };
const response = (tid = 'root', groups = [baseGroup]) => ({ threadUsage: { threadId: tid, groups } });
const account = { summary: { lifetimeTokens: 10000, peakDailyTokens: 100 }, dailyUsageBuckets: [{ startDate: '2026-10-04', tokens: 100 }] };
function peer(mode = 'normal', env = {}) {
  return new UsageRpc({ binary: 'fixture', timeoutMs: 2000,
    spawnImpl: (_binary, args, opts) => {
      assert.deepEqual(args, ['app-server', '--listen', 'stdio://']); assert.equal(opts.shell, false);
      return spawn(process.execPath, [fixture], { ...opts, env: { ...process.env, ...env, TM_USAGE_FIXTURE_MODE: mode } });
    } });
}
function fake({ pages, usage, accountError = false, readError = false, accountChanged = false } = {}) {
  const calls = [];
  return { calls, accountChanged, async call(method, params) {
    calls.push({ method, params });
    if (method === 'account/usage/read' && !params.threadId) { if (accountError) throw new Error('PRIVATE_ERROR'); return account; }
    if (method === 'account/usage/read') return usage ? usage(params.threadId) : response(params.threadId);
    if (method === 'thread/read') { if (readError) throw new Error('PRIVATE_METADATA'); return { thread: { id: params.threadId } }; }
    if (method === 'thread/list') return pages ? pages(params) : { data: [], nextCursor: null };
    throw new Error('unexpected method');
  } };
}
test('real stdio handshake against synthetic peer; no account or model access', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-live-')); const trace = path.join(dir, 'trace');
  const rpc = peer('normal', { TM_USAGE_TRACE: trace });
  try {
    await rpc.initialize(); const r = await syncUsage(rpc, { threadIds: ['root', 'root'] });
    assert.equal(r.account.report.summary.lifetimeTokens, 12345);
    assert.equal(r.inventory.selectedThreads, 3); assert.equal(r.inventory.measuredThreads, 2); assert.equal(r.inventory.unavailableThreads, 1);
    assert.equal(r.threads.find((t) => t.threadId === 'child').parentThreadId, 'root');
    assert.equal(r.threads.find((t) => t.threadId === 'missing').usage, null);
    assert.equal(r.taskTotalTokens, null); assert.equal(r.canCombineWithLocal, false); assert.equal(r.accountCloudCoverage, 'unknown');
    assert.ok(!JSON.stringify(r).includes('SECRET_MARKER'));
    const traceRows = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(traceRows.every((m) => ['initialize', 'initialized', 'account/usage/read', 'thread/read', 'thread/list'].includes(m.method)));
  } finally { await rpc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('only documented read methods can be called', async () => {
  const rpc = peer();
  try { await rpc.initialize();
    for (const method of ['turn/start', 'thread/resume', 'account/login/start', 'config/value/write']) {
      await assert.rejects(rpc.call(method), { code: 'READ_ONLY_METHOD_DENIED' });
    }
  } finally { await rpc.close(); }
});
for (const [mode, code] of [['error', 'RPC_METHOD_UNAVAILABLE'], ['invalid-json', 'RPC_INVALID_JSON'], ['large', 'RPC_MESSAGE_TOO_LARGE'], ['timeout', 'RPC_TIMEOUT']]) {
  test(`transport ${mode} fails with sanitized code`, async () => {
    const rpc = peer(mode);
    try { await rpc.initialize(); rpc.timeoutMs = 50; await assert.rejects(rpc.call('account/usage/read'), (e) => e.code === code && !e.message.includes('SECRET_MARKER')); }
    finally { await rpc.close(); }
  });
}
test('server approval requests are rejected rather than granted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-approval-')); const trace = path.join(dir, 'trace'); const rpc = peer('approval', { TM_USAGE_TRACE: trace });
  try {
    await rpc.initialize(); await rpc.call('account/usage/read');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const rows = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    const denied = rows.find((r) => r.id === 'server-approval');
    assert.equal(denied.error.code, -32601); assert.equal(denied.result, undefined);
  } finally { await rpc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('input and cache subsets are not double counted', () => {
  const u = normalizeThreadUsage(response(), 'root');
  assert.equal(u.tokens.totalTokens, 100); assert.equal(u.tokens.inputTokens, 90);
  assert.equal(u.tokens.netNewInputTokens, 40); assert.equal(u.measurement, 'estimated');
});
test('missing and empty thread reports remain unknown', () => {
  assert.equal(normalizeThreadUsage({ threadUsage: null }, 'root'), null);
  assert.equal(normalizeThreadUsage(response('root', []), 'root').tokens.totalTokens, null);
  assert.equal(normalizeThreadUsage(response('root', [{ model: 'a' }]), 'root').status, 'partial');
});
test('explicit zero tokens remain zero', () => {
  const group = { ...baseGroup, inputTokens: 0, outputTokens: 0, totalTokens: 0, netNewInputTokens: 0, cachedInputTokens: 0 };
  assert.equal(normalizeThreadUsage(response('root', [group]), 'root').tokens.totalTokens, 0);
});
for (const invalid of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '90']) {
  test(`reject invalid token count ${invalid}`, () => {
    assert.throws(() => normalizeThreadUsage(response('root', [{ ...baseGroup, inputTokens: invalid }]), 'root'), { code: 'INVALID_TOKEN_COUNT' });
  });
}
test('group totals, subsets, identity and duplicate buckets must agree', () => {
  for (const change of [{ cachedInputTokens: 91 }, { totalTokens: 101 }, { netNewInputTokens: 41 }]) {
    assert.throws(() => normalizeThreadUsage(response('root', [{ ...baseGroup, ...change }]), 'root'), { code: 'INVALID_TOKEN_RELATION' });
  }
  assert.throws(() => normalizeThreadUsage(response('other'), 'root'), { code: 'THREAD_RESPONSE_MISMATCH' });
  assert.throws(() => normalizeThreadUsage(response('root', [baseGroup, baseGroup]), 'root'), { code: 'DUPLICATE_THREAD_GROUP' });
});
test('safe integer overflow cannot round a group total', () => {
  const group = { ...baseGroup, netNewInputTokens: null, cachedInputTokens: null, inputTokens: null, outputTokens: null, totalTokens: Number.MAX_SAFE_INTEGER };
  assert.throws(() => normalizeThreadUsage(response('root', [group, { ...group, model: 'other' }]), 'root'), { code: 'TOKEN_SUM_OVERFLOW' });
});
test('nullable breakdown is not filled by credits or input subtraction', () => {
  const raw = response('root', [{ model: 'a', inputTokens: 90, outputTokens: 10, totalTokens: null, estimatedUsageCreditsMicros: 999 }]);
  const u = normalizeThreadUsage(raw, 'root'); assert.equal(u.tokens.totalTokens, null); assert.equal(u.tokens.cachedInputTokens, null);
});
test('estimated response cannot enter existing reported-task importer', () => {
  assert.throws(() => importCloudTaskUsage({ version: 1, kind: 'cloud-task-usage', records: [], threadUsage: response().threadUsage }));
});
test('pagination includes archived and all sources, descendants, no unrelated query', async () => {
  const rpc = fake({ pages: ({ archived, cursor }) => archived ? { data: [{ id: 'grand', parentThreadId: 'child' }], nextCursor: null } :
    cursor ? { data: [{ id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'root' } } } }], nextCursor: null } :
      { data: [{ id: 'unrelated' }, { id: 'root' }], nextCursor: 'next' } });
  const r = await syncUsage(rpc, { threadIds: ['root'] });
  assert.deepEqual(r.threads.map((t) => t.threadId), ['child', 'grand', 'root']);
  for (const c of rpc.calls.filter((c) => c.method === 'thread/list')) assert.deepEqual(c.params.sourceKinds, SOURCES);
  assert.ok(!rpc.calls.some((c) => c.method === 'account/usage/read' && c.params.threadId === 'unrelated'));
  assert.equal(r.taskTotalTokens, null);
});
test('repeated cursor and thread budget return partial inventory', async () => {
  const rpc = fake({ pages: () => ({ data: [{ id: 'root' }], nextCursor: 'same' }) });
  const r = await syncUsage(rpc, { threadIds: ['root'] });
  assert.equal(r.inventory.status, 'partial'); assert.ok(r.diagnostics.some((d) => d.code === 'REPEATED_THREAD_CURSOR'));
  const small = await syncUsage(fake({ pages: () => ({ data: [{ id: 'root' }, { id: 'one' }, { id: 'two' }], nextCursor: null }) }), { discover: true, maxThreads: 2 });
  assert.equal(small.inventory.status, 'partial');
});
test('declared cloud and dot bindings do not attest to automatic discovery', async () => {
  const bindings = { version: 1, kind: 'codex-usage-bindings', threads: [
    { threadId: 'cloudroot', taskId: 'task-1', dotId: 'dot-1', execution: 'cloud', creationSource: 'dot' },
    { threadId: 'missing', parentThreadId: 'cloudroot', execution: 'cloud' }
  ] };
  const rpc = fake({ readError: true, usage: (tid) => tid === 'missing' ? { threadUsage: null } : response(tid) });
  const r = await syncUsage(rpc, { bindings });
  assert.equal(r.inventory.selectedThreads, 2); assert.equal(r.inventory.unavailableThreads, 1);
  assert.equal(r.threads[0].bindingEvidence, 'user-declared'); assert.equal(r.threads[0].creationSource, 'dot');
  assert.equal(r.threads[1].creationSource, 'unknown'); assert.equal(r.accountCloudCoverage, 'unknown');
});
test('metadata failure does not block direct usage lookup', async () => {
  const r = await syncUsage(fake({ readError: true }), { threadIds: ['cloud-thread'], includeDescendants: false });
  assert.equal(r.threads[0].usage.tokens.totalTokens, 100); assert.equal(r.threads[0].execution, 'unknown');
});
test('conflicting parents stay visible without recursive sums', async () => {
  const rpc = fake({ pages: ({ archived }) => ({ data: archived ? [{ id: 'a', parentThreadId: 'c' }] :
    [{ id: 'a', parentThreadId: 'b' }, { id: 'b', parentThreadId: 'a' }], nextCursor: null }) });
  const r = await syncUsage(rpc, { discover: true });
  assert.ok(r.diagnostics.some((d) => d.code === 'CONFLICTING_PARENT'));
  assert.equal(r.threads.find((t) => t.threadId === 'a').parentThreadId, null);
});
test('fresh poll replaces downward corrections instead of adding snapshots', async () => {
  const first = await syncUsage(fake(), { threadIds: ['root'], includeDescendants: false });
  const second = await syncUsage(fake({ usage: (tid) => response(tid, [{ ...baseGroup, inputTokens: 80, netNewInputTokens: 30, totalTokens: 90 }]) }), { threadIds: ['root'], includeDescendants: false });
  assert.equal(first.threads[0].usage.tokens.totalTokens, 100); assert.equal(second.threads[0].usage.tokens.totalTokens, 90);
});
test('account failures are distinct and never leak raw error', async () => {
  const r = await syncUsage(fake({ accountError: true }), { threadIds: ['root'], includeDescendants: false });
  assert.equal(r.account.report, null); assert.equal(r.threads[0].usage.tokens.totalTokens, 100); assert.ok(!JSON.stringify(r).includes('PRIVATE_ERROR'));
});
test('account changes and cancellation invalidate mixed snapshots', async () => {
  await assert.rejects(syncUsage(fake({ accountChanged: true })), { code: 'ACCOUNT_CHANGED_DURING_SYNC' });
  const c = new AbortController(); c.abort(); const rpc = fake();
  await assert.rejects(syncUsage(rpc, { signal: c.signal }), { code: 'SYNC_ABORTED' }); assert.equal(rpc.calls.length, 0);
});
test('bad binding schema is rejected before any query', async () => {
  assert.throws(() => normalizeBindings({ version: 1, kind: 'codex-usage-bindings', threads: [{ threadId: 'a', creationSource: 'guessed' }] }));
  const rpc = fake(); await assert.rejects(syncUsage(rpc, { threadIds: ['bad id'] })); assert.equal(rpc.calls.length, 0);
});
test('HTML escapes service strings and has no network scripts', async () => {
  const r = await syncUsage(fake(), { threadIds: ['root'], includeDescendants: false });
  r.threads[0].threadId = '<img src=x onerror=alert(1)>';
  const html = renderUsageHtml({ state: 'stale', errorCode: '<script>SECRET</script>', report: r }, 60);
  assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<script>')); assert.ok(html.includes('已断线'));
  assert.ok(html.includes("default-src 'none'")); assert.ok(html.includes('http-equiv="refresh" content="60"'));
  assert.ok(!renderUsageHtml({ state: 'unavailable', report: null }, 1).includes('http-equiv="refresh"'));
});
test('all-null account metrics remain unknown', async () => {
  const rpc = fake(); const orig = rpc.call.bind(rpc);
  rpc.call = (method, params) => method === 'account/usage/read' && !params.threadId
    ? Promise.resolve({ summary: { lifetimeTokens: null, peakDailyTokens: null }, dailyUsageBuckets: null }) : orig(method, params);
  const report = await syncUsage(rpc); assert.equal(report.account.status, 'unknown'); assert.equal(report.account.report.summary.lifetimeTokens, null);
});
test('true cycle terminates with a diagnostic', async () => {
  const rpc = fake({ pages: ({ archived }) => ({ data: archived ? [] : [{ id: 'a', parentThreadId: 'b' }, { id: 'b', parentThreadId: 'a' }], nextCursor: null }) });
  const report = await syncUsage(rpc, { discover: true });
  assert.equal(report.threads.length, 2); assert.ok(report.diagnostics.some((d) => d.code === 'PARENT_CYCLE'));
});
test('supplied root metadata retains source kind', async () => {
  const rpc = fake({ pages: () => ({ data: [{ id: 'root', source: 'vscode' }], nextCursor: null }) });
  const r = await syncUsage(rpc, { threadIds: ['root'] });
  assert.equal(r.threads[0].sourceKind, 'vscode'); assert.equal(r.threads[0].execution, 'unknown');
});


test('explicit root queries scope ancestry instead of exhausting budget on unrelated threads', async () => {
  const rpc = fake({ pages: (params) => ({ data: params.archived ? [] : params.ancestorThreadId === 'root'
    ? [{ id: 'child', parentThreadId: 'root' }]
    : Array.from({ length: 5 }, (_, n) => ({ id: `unrelated-${n}` })), nextCursor: null }) });
  const r = await syncUsage(rpc, { threadIds: ['root'], maxThreads: 3 });
  assert.deepEqual(r.threads.map((t) => t.threadId), ['child', 'root']);
  assert.equal(r.inventory.status, 'complete-for-requested-ancestry');
  assert.ok(rpc.calls.filter((c) => c.method === 'thread/list').every((c) => c.params.ancestorThreadId === 'root'));
});

test('referenced missing parent stays visible with unknown usage', async () => {
  const bindings = { version: 1, kind: 'codex-usage-bindings', threads: [{ threadId: 'child', parentThreadId: 'parent' }] };
  const rpc = fake({ usage: (tid) => tid === 'parent' ? { threadUsage: null } : response(tid) });
  const r = await syncUsage(rpc, { bindings });
  assert.equal(r.inventory.selectedThreads, 2); assert.equal(r.inventory.unavailableThreads, 1);
  assert.equal(r.threads.find((t) => t.threadId === 'parent').usage, null);
});
