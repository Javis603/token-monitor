'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyCodexUsageSources } = require('../../src/shared/providers/codex/usageSources');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

const MODEL = 'gpt-6-astra';
const SESSION = 'rollout-2026-10-09T12-00-00-test';
const NATIVE = 'thread-test';
const NOW = new Date(2026, 9, 9, 14);
const stamp = (day = 9, second = 0) => new Date(2026, 9, day, 12, 0, second).toISOString();
const usage = (input = 100, output = 40, cached = 20, reasoning = 10) => ({ input_tokens: input, output_tokens: output,
  cached_input_tokens: cached, reasoning_output_tokens: reasoning, total_tokens: input + output });
function fixture(t, { provider = 'openai', counts = [usage()], requests = [], plans = [], events: extra = [] } = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-sources-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(homeDir)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(homeDir), /^codex-usage-sources-/);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  const sessionsRoot = path.join(homeDir, '.codex', 'sessions');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const file = path.join(sessionsRoot, `${SESSION}.jsonl`), ledgerPath = path.join(homeDir, 'ledger.jsonl');
  let total = usage(0, 0, 0, 0);
  const events = [{ type: 'session_meta', timestamp: stamp(), payload: { id: NATIVE, model_provider: provider } },
    { type: 'turn_context', timestamp: stamp(), payload: { model: MODEL, turn_id: 'turn-test' } }];
  for (const [i, last] of counts.entries()) {
    total = Object.fromEntries(Object.entries(last).map(([key, value]) => [key, total[key] + value]));
    if (requests[i]) events.push({ type: 'token_usage_record', timestamp: stamp(9, i + 1), payload: {
      thread_id: NATIVE, turn_id: 'turn-test', response_id: requests[i], usage: structuredClone(last), thread_token_usage: structuredClone(total) } });
    events.push({ type: 'event_msg', timestamp: stamp(9, i + 1), payload: { type: 'token_count',
      info: { last_token_usage: structuredClone(last), total_token_usage: structuredClone(total) }, rate_limits: plans[i] ? { plan_type: plans[i] } : {} } });
  }
  events.push(...extra);
  const writeEvents = value => fs.writeFileSync(file, value.map(event => JSON.stringify(event)).join('\n') + '\n');
  const writeLedger = value => fs.writeFileSync(ledgerPath, value.map(event => JSON.stringify(event)).join('\n') + '\n');
  writeEvents(events); writeLedger([]);
  const row = { client: 'codex', sessionId: SESSION, provider, model: MODEL,
    input: total.input_tokens - total.cached_input_tokens, cacheRead: total.cached_input_tokens,
    output: total.output_tokens - total.reasoning_output_tokens, reasoning: total.reasoning_output_tokens,
    messageCount: counts.length, performance: { totalDurationMs: counts.length * 1000 } };
  const json = { entries: [row] };
  return { homeDir, sessionsRoot, ledgerPath, file, events, row, json, writeEvents, writeLedger,
    apply: options => applyCodexUsageSources(json, { homeDir, ledgerPath, now: NOW, ...options }) };
}
function ledger(response, extra = {}) {
  return { response_id: response, provider: 'codex', providerAccount: 'answering-account-A', in: 80, out: 40,
    native_session: NATIVE, model: MODEL, duration: 987654, ...extra };
}

test('direct historical OpenAI Pro marks subscription with unknown account and preserves native speed', async t => {
  const f = fixture(t, { plans: ['pro'] }), before = structuredClone(f.row.performance);
  await f.apply();
  assert.deepEqual(f.row.usageSource, { platform: 'openai', accountId: '', accountLabel: '', accessType: 'subscription' });
  assert.equal(f.row.usageSourceReferences[0].outputTokens, 40);
  assert.equal(f.row.usageSourceReferences[0].lastUsedAt, stamp(9, 1));
  assert.deepEqual(f.row.performance, before);
  const period = extractUsageFromTokscale(f.json);
  assert.equal(period.outputTokens, 40);
  assert.equal(period.timedDurationMs, 1000);
  assert.equal(period.timedOutputTokens, 40);
});

test('exact response and accounting snapshots identify answering account after routing', async t => {
  const f = fixture(t, { provider: 'magpie', requests: ['response-one'] });
  f.writeLedger([ledger('response-one', { session_account: 'creator-account', creator_account_id: 'creator', session_official_login: 'creator' })]);
  await f.apply();
  assert.equal(f.row.usageSource.platform, 'codex');
  assert.equal(f.row.usageSource.accessType, 'subscription');
  assert.match(f.row.usageSource.accountId, /^sha256:[a-f0-9]{64}$/);
  assert.match(f.row.usageSource.accountLabel, /^账号 [a-f0-9]{8}$/);
  assert.ok(!JSON.stringify(f.json).includes('answering-account'));
  assert.deepEqual(f.row.performance, { totalDurationMs: 1000 });
});

test('mixed historical answering accounts remain separate references and do not inherit grouped duration', async t => {
  const f = fixture(t, { provider: 'magpie', counts: [usage(), usage()], requests: ['one', 'two'] });
  f.writeLedger([ledger('one'), ledger('two', { providerAccount: 'answering-account-B' })]);
  await f.apply();
  assert.equal(f.row.usageSource, undefined);
  assert.equal(f.row.usageSourceReferences.length, 2);
  assert.notEqual(f.row.usageSourceReferences[0].usageSource.accountId, f.row.usageSourceReferences[1].usageSource.accountId);
  assert.equal(f.row.usageSourceReferences.reduce((sum, part) => sum + part.outputTokens, 0), 80);
  for (const part of f.row.usageSourceReferences) assert.ok(part.lastUsedAt);
  assert.deepEqual(f.row.performance, { totalDurationMs: 2000 });
});

test('different platforms and API credentials stay separate from subscription accounts', async t => {
  const f = fixture(t, { provider: 'magpie', counts: [usage(), usage()], requests: ['one', 'two'] });
  f.writeLedger([ledger('one'), ledger('two', { provider: 'deepseek', providerAccount: '', providerKeyId: 'historical-key-B', host: 'api.deepseek.com' })]);
  await f.apply();
  assert.deepEqual(f.row.usageSourceReferences.map(part => [part.usageSource.platform, part.usageSource.accessType]),
    [['codex', 'subscription'], ['deepseek', 'api']]);
  assert.equal(f.row.usageSource, undefined);
  assert.ok(!JSON.stringify(f.json).includes('historical-key'));
});

test('plan evidence applies only to that token_count and is never sticky', async t => {
  const f = fixture(t, { counts: [usage(), usage()], plans: ['pro'] });
  await f.apply();
  assert.equal(f.row.usageSource, undefined);
  assert.deepEqual(f.row.usageSourceReferences.map(part => [part.usageSource.accessType, part.outputTokens]),
    [['subscription', 40], ['unknown', 40]]);
});

test('same native session, model, creator account and timestamps cannot replace exact response proof', async t => {
  const f = fixture(t);
  f.writeLedger([ledger('unrelated', { providerAccount: '', session_account: 'creator-account', session_official_login: 'creator-account' })]);
  await f.apply();
  assert.equal(f.row.usageSource.accountId, '');
  assert.equal(f.row.usageSource.accessType, 'unknown');
  assert.equal(f.row.usageSource.platform, 'openai');
});

test('missing, conflicting and mismatched response joins remain account unknown', async t => {
  for (const rows of [[], [ledger('one'), ledger('one', { providerAccount: 'conflict' })], [ledger('one', { out: 41 })], [ledger('one', { in: 81 })], [ledger('one', { in: 100 })]]) {
    const f = fixture(t, { requests: ['one'], plans: ['pro'] });
    f.writeLedger(rows);
    await f.apply();
    assert.equal(f.row.usageSource.accountId, '');
    assert.equal(f.row.usageSource.platform, 'openai');
    assert.equal(f.row.usageSource.accessType, 'subscription');
  }
});

test('request total or thread mismatches do not assign a gateway account', async t => {
  for (const mutate of [request => { request.thread_token_usage = usage(999, 40); }, request => { request.thread_id = 'other-thread'; }]) {
    const f = fixture(t, { requests: ['one'] });
    const request = f.events.find(event => event.type === 'token_usage_record');
    mutate(request.payload); f.writeEvents(f.events); f.writeLedger([ledger('one')]);
    await f.apply();
    assert.equal(f.row.usageSource.accountId, '');
    assert.equal(f.row.usageSource.platform, 'openai');
  }
});

test('partial output/input/message/duration coverage cannot assign whole native row', async t => {
  for (const mutate of [row => { row.output += 10; }, row => { row.input += 10; },
    row => { row.messageCount += 1; }, row => { row.performance.totalDurationMs += 1; }]) {
    const f = fixture(t, { requests: ['one'] });
    f.writeLedger([ledger('one')]); mutate(f.row);
    await f.apply();
    assert.equal(f.row.usageSource, undefined);
    assert.equal(f.row.usageSourceReferences[0].outputTokens, 40);
  }
});

test('duplicate cumulative snapshots do not duplicate output or source references', async t => {
  const f = fixture(t, { plans: ['pro'] });
  f.events.push(structuredClone(f.events.at(-1))); f.writeEvents(f.events);
  await f.apply();
  assert.equal(f.row.usageSourceReferences[0].outputTokens, 40);
  assert.equal(f.row.usageSource.accessType, 'subscription');
});

test('periods filter by native start anchor and retain completion time as lastUsedAt', async t => {
  const f = fixture(t, { plans: ['pro'] });
  f.events[1].timestamp = new Date(2026, 9, 8, 23, 59, 59).toISOString();
  f.events.at(-1).timestamp = new Date(2026, 9, 9, 0, 0, 1).toISOString();
  f.row.performance.totalDurationMs = 2000; f.writeEvents(f.events);
  await f.apply({ flags: ['--today'] });
  assert.equal(f.row.usageSource, undefined);
  assert.equal(f.row.usageSourceReferences, undefined);
  await f.apply({ flags: ['--month'] });
  assert.equal(f.row.usageSourceReferences[0].lastUsedAt, new Date(2026, 9, 9, 0, 0, 1).toISOString());
  assert.equal(f.row.usageSource.accessType, 'subscription');
});

test('explicit home isolates ambient CODEX_HOME and custom scan roots still work', async t => {
  const f = fixture(t, { plans: ['pro'] });
  await f.apply({ env: { CODEX_HOME: '/unrelated/codex' } });
  assert.equal(f.row.usageSource.accessType, 'subscription');
  const anotherRow = { ...f.row }; delete anotherRow.usageSource; delete anotherRow.usageSourceReferences;
  const json = { entries: [anotherRow] };
  await applyCodexUsageSources(json, { homeDir: f.homeDir, sessionsRoot: path.join(f.homeDir, 'absent'),
    customScanPaths: { codex: [f.sessionsRoot] }, ledgerPath: f.ledgerPath, now: NOW });
  assert.equal(anotherRow.usageSource.accessType, 'subscription');
});

test('fork replay remains unknown instead of assigning inherited account or subscription', async t => {
  const f = fixture(t, { requests: ['one'], plans: ['pro'] });
  f.events[0].payload.forked_from_id = 'parent-thread'; f.writeEvents(f.events); f.writeLedger([ledger('one')]);
  await f.apply();
  assert.equal(f.row.usageSource, undefined);
  assert.equal(f.row.usageSourceReferences, undefined);
});

test('response, thread and turn identifiers require byte-exact evidence', async t => {
  for (const [key, value] of [['response_id', ' one'], ['response_id', 'one '], ['response_id', 'one\u0001'],
    ['thread_id', ` ${NATIVE}`], ['turn_id', 'turn-test '], ['turn_id', '']]) {
    const f = fixture(t, { requests: ['one'], plans: ['pro'] });
    f.events.find(event => event.type === 'token_usage_record').payload[key] = value;
    f.writeEvents(f.events); f.writeLedger([ledger('one')]);
    await f.apply();
    assert.equal(f.row.usageSource.accountId, '');
    assert.equal(f.row.usageSource.accessType, 'subscription');
  }
});

test('missing, malformed and negative request counters cannot synthesize equality', async t => {
  for (const mutate of [u => { delete u.input_tokens; }, u => { delete u.output_tokens; },
    u => { delete u.cached_input_tokens; }, u => { delete u.reasoning_output_tokens; },
    u => { u.cached_input_tokens = -1; }, u => { u.reasoning_output_tokens = '10'; }, u => { u.total_tokens = -1; }]) {
    const f = fixture(t, { requests: ['one'], plans: ['pro'] });
    mutate(f.events.find(event => event.type === 'token_usage_record').payload.usage);
    f.writeEvents(f.events); f.writeLedger([ledger('one')]);
    await f.apply();
    assert.equal(f.row.usageSource.accountId, '');
    assert.equal(f.row.usageSource.platform, 'openai');
  }
});

test('invalid native accounting declines attribution without changing grouped usage', async t => {
  for (const mutate of [u => { delete u.input_tokens; }, u => { u.output_tokens = '40'; },
    u => { u.cached_input_tokens = -1; }, u => { u.reasoning_output_tokens = null; }]) {
    const f = fixture(t, { requests: ['one'], plans: ['pro'] }), before = structuredClone(f.row);
    mutate(f.events.at(-1).payload.info.last_token_usage); f.writeEvents(f.events); f.writeLedger([ledger('one')]);
    await f.apply();
    assert.deepEqual(f.row, before);
  }
});

test('conflicting responses for the same accounting snapshots leave account unknown', async t => {
  const f = fixture(t, { requests: ['one'] });
  const duplicate = structuredClone(f.events.find(event => event.type === 'token_usage_record'));
  duplicate.payload.response_id = 'two'; f.events.push(duplicate); f.writeEvents(f.events);
  f.writeLedger([ledger('one'), ledger('two', { providerAccount: 'answering-account-B' })]);
  await f.apply();
  assert.equal(f.row.usageSource.accountId, '');
  assert.equal(f.row.usageSource.accessType, 'unknown');
});

test('zero-output native events still prevent a grouped mixed-source duration assignment', async t => {
  const f = fixture(t, { counts: [usage(), usage(10, 0, 0, 0)], plans: ['pro'] });
  await f.apply();
  assert.equal(f.row.usageSourceReferences[0].outputTokens, 40);
  assert.equal(f.row.usageSource, undefined);
  assert.deepEqual(f.row.performance, { totalDurationMs: 2000 });
});

test('stale cumulative regression is skipped without advancing the native clock', async t => {
  const f = fixture(t, { counts: [usage(), usage(), usage()], plans: ['pro', 'pro', 'pro'] });
  const stale = structuredClone(f.events[3]);
  stale.timestamp = stamp(9, 3); stale.payload.info.total_token_usage = usage();
  f.events.splice(4, 0, stale); f.writeEvents(f.events);
  await f.apply();
  assert.equal(f.row.usageSourceReferences[0].outputTokens, 120);
  assert.equal(f.row.usageSource.accessType, 'subscription');
  assert.deepEqual(f.row.performance, { totalDurationMs: 3000 });
});

test('severe native reset uses the last snapshot rather than cumulative deltas', async t => {
  const f = fixture(t, { counts: [usage(1000, 400, 200, 100), usage(10, 4, 2, 1)], plans: ['pro', 'pro'] });
  f.events.at(-1).payload.info.total_token_usage = usage(10, 4, 2, 1); f.writeEvents(f.events);
  await f.apply();
  assert.equal(f.row.usageSourceReferences[0].outputTokens, 404);
  assert.equal(f.row.usageSource.accessType, 'subscription');
});

test('a file append during the snapshot read cannot establish provenance', async t => {
  const f = fixture(t, { requests: ['one'], plans: ['pro'] }), before = structuredClone(f.row);
  f.writeLedger([ledger('one')]);
  const createReadStream = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', function (file, options) {
    const stream = createReadStream.call(fs, file, options);
    if (file === f.file) stream.once('data', () => { fs.appendFileSync(file, '\n'); });
    return stream;
  });
  await f.apply();
  assert.deepEqual(f.row, before);
});

test('aborted attribution honors cancellation', async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort(new Error('cancel-attribution'));
  await assert.rejects(f.apply({ signal: controller.signal }), /cancel-attribution/);
  assert.equal(f.row.usageSource, undefined);
});
