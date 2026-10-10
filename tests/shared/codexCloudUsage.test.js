'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { collectCloudUsage, reference, turnPage, estimates, quotas, summary, page, error } = require('../../src/shared/providers/codex/cloudUsage');
const { CloudTransport, cachedReferences, ROUTES, WS_URL } = require('../../src/shared/providers/codex/cloudTransport');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.UTC(2026, 9, 5); const seconds = NOW / 1000;
const thread = (n, extra = {}) => ({ id: id(n), updatedAt: seconds - 10, source: null, ...extra });
const turn = (n, extra = {}) => ({ id: id(n), startedAt: seconds - 5, completedAt: seconds - 2, status: 'completed', ...extra });
const usage = (n, extra = {}) => ({ turn_id: id(n), model: 'fixture-model', input_tokens: 90, cached_input_tokens: 50,
  net_new_input_tokens: 40, output_tokens: 10, total_tokens: 100, settled_response_ids: [`response-${n}`], estimated_usage_usd_micros: 123, ...extra });
function fake(options = {}) {
  const calls = [];
  return { calls, scopeFingerprint: 'test-only', assertIdentity() {},
    async request(method, params) { calls.push([method, params]);
      if (method === 'thread/list') return options.list ? options.list(params) : { data: [thread(1)], nextCursor: null };
      if (method === 'thread/read') return { thread: thread(Number(params.threadId.slice(-12))) };
      if (method === 'thread/turns/list') return options.history ? options.history(params) : { data: [turn(11)], nextCursor: null };
      throw error('UNEXPECTED_METHOD');
    }, async estimates(body) { calls.push(['estimates', body]); if (options.estimates) return options.estimates(body);
      return { threads: body.threads.map((t) => ({ thread_id: t.thread_id, turns: t.turn_ids.map((i) => usage(Number(i.slice(-12)))) })) };
    }, async quotas(body) { calls.push(['quotas', body]); return options.quotas ? options.quotas(body) : { threads: [] }; }
  };
}
test('exact thread and turn query joins real-format IDs, not names', async () => {
  const rpc = fake(); const r = await collectCloudUsage(rpc, { threadIds: [id(1)], now: NOW });
  assert.equal(r.turns[0].tokens.totalTokens, 100); assert.equal(r.totals.observedSettledTokens, 100);
  assert.equal(r.canCombineWithLocal, false); assert.equal(r.accountCloudCoverage, 'unknown');
  assert.deepEqual(rpc.calls.find(([m]) => m === 'estimates')[1], { threads: [{ thread_id: id(1), turn_ids: [id(11)] }], include_settled_response_ids: true });
  assert.equal(rpc.calls.find(([m]) => m === 'thread/turns/list')[1].itemsView, 'notLoaded');
});
test('default null-source catalog and source-filtered archive queries are unioned', async () => {
  const rpc = fake({ list: (p) => ({ data: p.archived ? [thread(3)] : p.sourceKinds ? [thread(2, { source: { subAgent: {} } })] : [thread(1)], nextCursor: null }),
    history: (p) => ({ data: [turn(Number(p.threadId.slice(-12)) + 10)], nextCursor: null }) });
  const r = await collectCloudUsage(rpc, { discover: true, now: NOW }); assert.equal(r.threads.length, 3); assert.equal(r.turns.length, 3);
  assert.equal(rpc.calls.filter(([m]) => m === 'thread/list').length, 4); assert.equal(r.totals.observedSettledTokens, 300);
});
test('same thread/turn repeated on later pages is counted once', async () => {
  const rpc = fake({ history: (p) => ({ data: [turn(11)], nextCursor: p.cursor ? null : 'next' }) });
  const r = await collectCloudUsage(rpc, { threadIds: [id(1)], now: NOW }); assert.equal(r.turns.length, 1); assert.equal(r.totals.observedSettledTokens, 100);
});
test('permission-denied per-turn ledger preserves history and never invents token zero', async () => {
  const rpc = fake({ estimates: () => { throw error('FORBIDDEN'); } });
  const r = await collectCloudUsage(rpc, { threadIds: [id(1)], now: NOW });
  assert.equal(r.status, 'partial'); assert.equal(r.usageAccess, 'FORBIDDEN'); assert.equal(r.turns.length, 1);
  assert.equal(r.turns[0].tokens, null); assert.equal(r.totals.observedSettledTokens, null);
  assert.equal(rpc.calls.filter(([m]) => m === 'estimates').length, 1);
});
test('empty ledger response is not a measured zero', async () => {
  const r = await collectCloudUsage(fake({ estimates: () => ({ threads: [] }) }), { threadIds: [id(1)], now: NOW });
  assert.equal(r.totals.tokenTurns, 0); assert.equal(r.totals.fullTaskTokens, null);
});
test('all unavailable history is unavailable even when thread metadata exists', async () => {
  const r = await collectCloudUsage(fake({ history: () => { throw error('FORBIDDEN'); } }), { threadIds: [id(1)], now: NOW });
  assert.equal(r.status, 'unavailable'); assert.equal(r.turns.length, 0); assert.equal(r.totals.observedSettledTokens, null);
});
test('repeated cursor and pagination bounds stay partial', async () => {
  const r = await collectCloudUsage(fake({ history: () => ({ data: [turn(11)], nextCursor: 'same' }) }), { threadIds: [id(1)], now: NOW });
  assert.equal(r.status, 'partial'); assert.equal(r.historyComplete, false); assert.ok(r.diagnostics.some((d) => d.code === 'REPEATED_CURSOR'));
  const q = await collectCloudUsage(fake({ list: () => ({ data: [thread(1)], nextCursor: 'more' }) }), { discover: true, now: NOW, maxPages: 1 });
  assert.equal(q.inventoryComplete, false); assert.equal(q.totals.fullTaskTokens, null);
});
test('default discovery does not conflate engine and dot attachment parents', async () => {
  const seed = { ...reference(thread(1), NOW), engineParentId: id(9), delegationParentId: id(8), dotId: 'orbit-test', metadataSource: 'desktop-cache', bindingEvidence: 'cache-account-and-user-matched' };
  const r = await collectCloudUsage(fake(), { threadIds: [id(1)], seedReferences: [seed], now: NOW });
  assert.equal(r.threads[0].engineParentId, id(9)); assert.equal(r.threads[0].delegationParentId, id(8)); assert.equal(r.threads[0].dotId, 'orbit-test');
});
test('known cached descendants remain partial rather than claiming a full cloud tree', async () => {
  const seed = { ...reference(thread(2), NOW), delegationParentId: id(1) };
  const r = await collectCloudUsage(fake({ history: (p) => ({ data: [turn(Number(p.threadId.slice(-12)) + 10)], nextCursor: null }) }), { threadIds: [id(1)], seedReferences: [seed], includeDescendants: true, now: NOW });
  assert.equal(r.threads.length, 2); assert.equal(r.inventoryComplete, false); assert.equal(r.totals.fullTaskTokens, null);
});
test('a zero counter is preserved while missing breakdown stays null', () => {
  const ts = turnPage({ data: [turn(11)] }, reference(thread(1), NOW), NOW).turns;
  const out = estimates({ threads: [{ thread_id: id(1), turns: [usage(11, { input_tokens: 0, cached_input_tokens: null, net_new_input_tokens: null, output_tokens: 0, total_tokens: 0, settled_response_ids: [] })] }] }, ts);
  assert.equal(out[0].tokens.totalTokens, 0); assert.equal(out[0].tokens.cachedInputTokens, null); assert.equal(summary(out).observedSettledTokens, 0);
});
for (const invalid of [-1, 1.5, Infinity, NaN, true, '100', Number.MAX_SAFE_INTEGER + 1]) test(`invalid counter ${invalid} fails`, () => {
  const ts = turnPage({ data: [turn(11)] }, reference(thread(1), NOW), NOW).turns;
  assert.throws(() => estimates({ threads: [{ thread_id: id(1), turns: [usage(11, { total_tokens: invalid })] }] }, ts));
});
for (const extra of [{ cached_input_tokens: 91 }, { net_new_input_tokens: 41 }, { total_tokens: 101 }, { settled_response_ids: ['a', 'a'] }]) test('impossible subsets and duplicate settlement IDs fail atomically', () => {
  const ts = turnPage({ data: [turn(11)] }, reference(thread(1), NOW), NOW).turns;
  assert.throws(() => estimates({ threads: [{ thread_id: id(1), turns: [usage(11, extra)] }] }, ts)); assert.equal(ts[0].tokens, null);
});
test('unexpected response thread or turn never joins another task', () => {
  const ts = turnPage({ data: [turn(11)] }, reference(thread(1), NOW), NOW).turns;
  assert.throws(() => estimates({ threads: [{ thread_id: id(2), turns: [usage(11)] }] }, ts));
  assert.throws(() => estimates({ threads: [{ thread_id: id(1), turns: [usage(12)] }] }, ts));
});
test('shared settled responses across inherited turns prevent aggregate double counting', () => {
  const ts = turnPage({ data: [turn(11), turn(12)] }, reference(thread(1), NOW), NOW).turns;
  const out = estimates({ threads: [{ thread_id: id(1), turns: [usage(11), usage(12, { settled_response_ids: ['response-11'] })] }] }, ts);
  assert.equal(summary(out).observedSettledTokens, null); assert.equal(summary(out).settlementUnverifiedTurns, 2);
});
test('missing settlement IDs preserves counter display without a verified aggregate', () => {
  const ts = turnPage({ data: [turn(11)] }, reference(thread(1), NOW), NOW).turns;
  const out = estimates({ threads: [{ thread_id: id(1), turns: [usage(11, { settled_response_ids: null })] }] }, ts);
  assert.equal(out[0].tokens.totalTokens, 100); assert.equal(summary(out).observedSettledTokens, null);
});
test('missing dates stay unknown and impossible ranges fail', () => {
  const ref = reference(thread(1), NOW);
  const t = turnPage({ data: [turn(11, { startedAt: null, completedAt: null })] }, ref, NOW).turns[0]; assert.equal(t.observedDate, null);
  assert.throws(() => turnPage({ data: [turn(11, { completedAt: seconds - 20 })] }, ref, NOW));
  assert.throws(() => turnPage({ data: [turn(11, { startedAt: true })] }, ref, NOW));
  assert.throws(() => page({ data: [], nextCursor: '' }));
});
test('quota percentages and purchased credits never become token counts', () => {
  const result = quotas({ threads: [{ thread_id: id(1), weekly_limit_percent: '1.5', five_hour_limit_percent: 0, balance_usage_credits: '-0.001' }] }, [reference(thread(1), NOW)]);
  assert.equal(result[0].weeklyLimitPercent, 1.5); assert.equal(result[0].purchasedCredits, '-0.001'); assert.equal(result[0].totalTokens, undefined);
  assert.throws(() => quotas({ threads: [{ thread_id: id(1), weekly_limit_percent: true }] }, [reference(thread(1), NOW)]));
});
test('transcript content is not copied into reports', async () => {
  const r = await collectCloudUsage(fake({ list: () => ({ data: [thread(1, { preview: 'SECRET' })] }), history: () => ({ data: [turn(11, { items: [{ text: 'SECRET' }], error: 'SECRET' })] }) }), { discover: true, now: NOW });
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('account mismatch cannot seed cached dot associations', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cloud-cache-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cache = { accountId: 'a', userId: 'u', hostId: 'durable', threads: [thread(1, { updatedAt: 1 })], attachments: [{ thread_id: id(1), parent_thread_id: id(2) }], profilesByThreadId: { [id(1)]: { id: 'dot-fixture' } } };
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'electron-persisted-atom-state': { 'cloud-aeon-sidebar-cache-v1': cache } }));
  assert.equal(cachedReferences(home, { accountId: 'wrong', userId: 'u' }).length, 0); assert.equal(cachedReferences(home, { accountId: 'a', userId: null }).length, 0);
  assert.equal(cachedReferences(home, { accountId: 'a', userId: 'u' })[0].delegationParentId, id(2));
});
function fixtureDeps(behavior = {}) {
  const trace = []; let cred = { accountId: id(90), accessToken: 'fixture-not-a-real-token', userId: 'fixture-user', fileHash: 'fixture-hash', scopeFingerprint: 'fixture-scope' };
  class Agent { async destroy() {} }
  class Socket extends EventEmitter {
    constructor(url, options) { super(); trace.push({ kind: 'connect', url, options }); setImmediate(() => this.emit('open', {})); }
    addEventListener(n, f, o) { if (o?.once) this.once(n, f); else this.on(n, f); }
    removeEventListener(n, f) { this.off(n, f); }
    close() { this.emit('close', {}); }
    send(text) { const msg = JSON.parse(text); trace.push({ kind: 'rpc', msg }); if (!msg.id || msg.error) return;
      setImmediate(() => this.emit('message', { data: JSON.stringify({ id: msg.id, result: behavior.result || {} }) })); }
  }
  const undici = { Agent, WebSocket: Socket, async request(url, options) {
    trace.push({ kind: 'http', url, options });
    const body = new EventEmitter();
    body.destroy = () => { if (behavior.abortBody) body.emit('error', Object.assign(new Error('SENSITIVE_BODY_ERROR'), { code: 'UND_ERR_ABORTED' })); };
    body[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(behavior.httpResult || { threads: [] })); };
    return { statusCode: behavior.status || 200, body };
  } };
  return { trace, change: () => { cred = { ...cred, fileHash: 'changed' }; }, deps: { undici, loadCredential: () => cred } };
}
test('cloud transport authenticates only fixed origins and rejects writes/content', async () => {
  const f = fixtureDeps(), rpc = new CloudTransport({ budgetMs: 1000, timeoutMs: 500 }, f.deps);
  try { await rpc.initialize();
    for (const method of ['turn/start', 'thread/resume', 'thread/subscribe', 'account/login/start']) await assert.rejects(rpc.request(method, {}), { code: 'READ_ONLY_METHOD_DENIED' });
    await assert.rejects(rpc.request('thread/turns/list', { threadId: id(1), itemsView: 'full' }), { code: 'MESSAGE_CONTENT_DENIED' });
    await rpc.request('thread/turns/list', { threadId: id(1), itemsView: 'notLoaded' });
    await rpc.estimates({ threads: [{ thread_id: id(1), turn_ids: [id(11)] }], include_settled_response_ids: true });
    assert.equal(f.trace[0].url, WS_URL); const http = f.trace.find((r) => r.kind === 'http');
    assert.equal(http.url, 'https://chatgpt.com' + ROUTES.estimates); assert.equal(http.options.maxRedirections, 0); assert.equal(rpc.audit.startedModelTurns, 0);
    await assert.rejects(rpc.query('tbo', { threads: [] }), { code: 'READ_ONLY_METHOD_DENIED' });
  } finally { await rpc.close(); }
});
for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED'], [302, 'REDIRECT_REFUSED']]) test(`HTTP ${status} has an explicit sanitized failure`, async () => {
  const f = fixtureDeps({ status }), rpc = new CloudTransport({ budgetMs: 1000, timeoutMs: 500 }, f.deps);
  try { await rpc.initialize(); await assert.rejects(rpc.quotas({ threads: [] }), { code }); assert.equal(f.trace.filter((r) => r.kind === 'http').length, 1); }
  finally { await rpc.close(); }
});
test('credential changes invalidate the entire connection without exposing contents', async () => {
  const f = fixtureDeps(), rpc = new CloudTransport({ budgetMs: 1000, timeoutMs: 500 }, f.deps);
  try { await rpc.initialize(); f.change(); assert.throws(() => rpc.assertIdentity(), { code: 'LOGIN_CHANGED' }); }
  finally { await rpc.close(); }
});
test('server-side approval request is rejected and not executed', async () => {
  const f = fixtureDeps(), rpc = new CloudTransport({ budgetMs: 1000, timeoutMs: 500 }, f.deps);
  try { await rpc.initialize(); rpc.onMessage(JSON.stringify({ id: 'server-request', method: 'item/permissions/requestApproval', params: { text: 'SECRET' } }));
    const last = f.trace.at(-1).msg; assert.equal(last.error.code, -32601); assert.ok(!JSON.stringify(last).includes('SECRET')); }
  finally { await rpc.close(); }
});
test('cancelled collector performs no service calls', async () => {
  const rpc = fake(), c = new AbortController(); c.abort(); await assert.rejects(collectCloudUsage(rpc, { threadIds: [id(1)], signal: c.signal }), { code: 'ABORTED' }); assert.equal(rpc.calls.length, 0);
});


test('deadline after history preserves metadata but never invents usage', async () => {
  let expired = false;
  const rpc = fake({ history: () => { expired = true; return { data: [turn(11)], nextCursor: 'older' }; } });
  rpc.assertIdentity = () => { if (expired) throw error('DEADLINE'); };
  rpc.verifyIdentity = () => {};
  const result = await collectCloudUsage(rpc, { threadIds: [id(1)], now: NOW });
  assert.equal(result.turns.length, 1); assert.equal(result.status, 'partial');
  assert.equal(result.totals.observedSettledTokens, null); assert.equal(result.usageAccess, 'DEADLINE');
});


test('aborting a forbidden HTTP response body does not crash or leak raw error', async () => {
  const f = fixtureDeps({ status: 403, abortBody: true });
  const rpc = new CloudTransport({ home: '/unused' }, f.deps);
  try { await rpc.initialize(); await assert.rejects(rpc.quotas({ threads: [] }), { code: 'FORBIDDEN' }); }
  finally { await rpc.close(); }
});


test('service scientific-notation credit string is preserved without token conversion', () => {
  const r = quotas({ threads: [{ thread_id: id(1), balance_usage_credits: '0E-10', weekly_limit_percent: 0.5847608653468434, five_hour_limit_percent: null, data_status: 'partial', usage_source: 'included_plan' }] }, [reference(thread(1), NOW)]);
  assert.equal(r[0].purchasedCredits, '0E-10'); assert.equal(r[0].weeklyLimitPercent, 0.5847608653468434);
  assert.equal(r[0].fiveHourLimitPercent, null); assert.equal(r[0].measurement, 'quota-not-tokens');
  assert.throws(() => quotas({ threads: [{ thread_id: id(1), balance_usage_credits: '1e9999' }] }, [reference(thread(1), NOW)]));
});

test('unauthorized or rate-limited usage stops further optional endpoint requests', async () => {
  for (const kind of ['UNAUTHORIZED', 'RATE_LIMITED']) {
    const rpc = fake({ estimates: () => { throw error(kind); } });
    const r = await collectCloudUsage(rpc, { threadIds: [id(1)], now: NOW, quotas: true });
    assert.equal(r.usageAccess, kind); assert.ok(!rpc.calls.some(([m]) => m === 'quotas'));
  }
});
