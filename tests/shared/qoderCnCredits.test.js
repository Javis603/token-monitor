'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createQoderCnCreditsCollector, creditRecord } = require('../../src/shared/providers/qodercn/credits');
const { normalizeQoderCnCredits, summarizeQoderCnCredits } = require('../../src/shared/providers/qodercn/creditUsage');
const { aggregateDevices, normalizeDeviceRecord, mergeDeviceRecord } = require('../../src/shared/usage');
const { createDeviceState } = require('../../src/shared/usage/deviceState');
const { collectUsageOnce, startCollector } = require('../../src/shared/collector');

function entry(id, credits = 0.25, overrides = {}) {
  return {
    type: 'assistant', entrypoint: 'cli', uuid: `entry-${id}`,
    timestamp: new Date(2026, 9, 15, 12).toISOString(),
    message: { id: `message-${id}`, role: 'assistant', model: 'qfmodel', usage: {
      credits, original_credits: 999, billable: false, request_id: id,
      input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0
    } },
    ...overrides
  };
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-qoder-credits-'));
  const root = path.join(home, '.qoder-cn', 'projects');
  const databasePath = path.join(home, 'credits.sqlite');
  const instances = [];
  fs.mkdirSync(root, { recursive: true });
  t.after(() => {
    for (const instance of instances) instance.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    home, root, databasePath,
    create(options = {}) {
      const instance = createQoderCnCreditsCollector({ homeDir: home, env: {}, databasePath, ...options });
      instances.push(instance);
      return instance;
    },
    write(name, rows) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      return file;
    }
  };
}
const totals = (usage, range) => summarizeQoderCnCredits([{ qoderCnCredits: usage }], range);
const plain = (value) => JSON.parse(JSON.stringify(value));

test('credits-only CLI records are collected independently, including billable:false and explicit zero', (t) => {
  const f = fixture(t);
  f.write('workspace/session.jsonl', [entry('a'), entry('b', 0), entry('c', 0.5)]);
  const value = totals(f.create().scan());
  assert.equal(value.credits, 0.75);
  assert.equal(value.requests, 3);
  assert.deepEqual(value.models, [{ model: 'qfmodel', credits: 0.75, requests: 3 }]);
});

test('credits use only CLI assistant usage.credits, never original_credits, tokens or desktop rows', (t) => {
  const f = fixture(t);
  const byok = entry('byok');
  delete byok.message.usage.credits;
  byok.message.usage.input_tokens = 100;
  f.write('test.jsonl', [
    entry('cli'), entry('desktop', 9, { entrypoint: 'desktop' }),
    entry('user', 9, { type: 'user' }), byok, { type: 'runtime-config' }
  ]);
  assert.equal(totals(f.create().scan()).credits, 0.25);
});

test('same request copied across transcripts, branches and subagents counts once', (t) => {
  const f = fixture(t);
  f.write('main.jsonl', [entry('same'), entry('same')]);
  f.write('another-workspace/copied.jsonl', [entry('same')]);
  f.write('session/subagents/agent.jsonl', [entry('same'), entry('child', 0.5)]);
  assert.equal(totals(f.create().scan()).credits, 0.75);
  assert.equal(totals(f.create().scan()).requests, 2);
});

test('message id then envelope uuid are stable fallback identities', () => {
  const row = entry('test');
  delete row.message.usage.request_id;
  assert.equal(creditRecord(row).key, 'message:message-test');
  delete row.message.id;
  assert.equal(creditRecord(row).key, 'entry:entry-test');
  delete row.uuid;
  assert.throws(() => creditRecord(row), /identity/);
});

test('warm scans read no unchanged content, append only new bytes, and finish torn UTF-8/JSON writes', (t) => {
  const f = fixture(t);
  let bytes = 0;
  const fsApi = { ...fs, readSync(...args) { const n = fs.readSync(...args); bytes += n; return n; } };
  const file = f.write('session.jsonl', [entry('first'), { type: 'runtime-config', payload: 'x'.repeat(10000) }]);
  const c = f.create({ fs: fsApi });
  assert.equal(totals(c.scan()).requests, 1);
  bytes = 0;
  c.scan();
  assert.equal(bytes, 0);
  const next = JSON.stringify(entry('next', 0.5, { message: { ...entry('next').message, content: [{ text: '中' }], usage: { credits: 0.5, request_id: 'next' } } }));
  const buffer = Buffer.from(next);
  const split = buffer.indexOf(Buffer.from('中')) + 1;
  fs.appendFileSync(file, buffer.subarray(0, split));
  assert.equal(totals(c.scan()).requests, 1);
  fs.appendFileSync(file, Buffer.concat([buffer.subarray(split), Buffer.from('\n')]));
  assert.equal(totals(c.scan()).requests, 2);
  assert.equal(totals(c.scan()).credits, 0.75);
  assert.ok(bytes < fs.statSync(file).size + 256);
});

test('complete final JSON without a newline counts once when the newline arrives', (t) => {
  const f = fixture(t);
  const file = path.join(f.root, 'session.jsonl');
  fs.writeFileSync(file, JSON.stringify(entry('a')));
  const c = f.create();
  assert.equal(totals(c.scan()).requests, 1);
  fs.appendFileSync(file, '\n');
  assert.equal(totals(c.scan()).requests, 1);
});

test('SQLite ledger survives restarts, deleted logs, truncation and a growing replacement', (t) => {
  const f = fixture(t);
  const file = f.write('session.jsonl', [entry('a'), entry('b')]);
  const c = f.create();
  assert.equal(totals(c.scan()).requests, 2);
  c.close();
  const restarted = f.create();
  assert.equal(totals(restarted.scan()).requests, 2);
  f.write('session.jsonl', [entry('c')]);
  assert.equal(totals(restarted.scan()).requests, 3);
  f.write('session.jsonl', [entry('d'), entry('e'), entry('f')]);
  assert.equal(totals(restarted.scan()).requests, 6);
  fs.unlinkSync(file);
  assert.equal(totals(f.create().scan()).requests, 6);
});

test('ledger retains only request metadata, not prompt, response or project contents', (t) => {
  const f = fixture(t);
  f.write('session.jsonl', [entry('a', 0.25, { cwd: '/private/project', message: {
    ...entry('a').message, content: [{ text: 'PRIVATE_RESPONSE' }]
  } })]);
  f.create().scan();
  const db = new DatabaseSync(f.databasePath, { readOnly: true });
  t.after(() => db.close());
  const row = db.prepare('SELECT * FROM requests').get();
  assert.deepEqual(Object.keys(row), ['source_root', 'request_key', 'timestamp', 'model', 'credits']);
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE_RESPONSE|private\/project/);
});

test('failed reads and conflicting records roll back the entire scan and retry without losing offsets', (t) => {
  const f = fixture(t);
  const file = f.write('a.jsonl', [entry('a')]);
  let fail = false;
  const c = f.create({ fs: { ...fs, openSync(...args) {
    if (fail) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.openSync(...args);
  } } });
  c.scan();
  fs.appendFileSync(file, JSON.stringify(entry('b')) + '\n');
  fail = true;
  assert.throws(() => c.scan(), /denied/);
  fail = false;
  f.write('z.jsonl', [entry('a', 9)]);
  assert.throws(() => c.scan(), /Conflicting/);
  fs.unlinkSync(path.join(f.root, 'z.jsonl'));
  assert.equal(totals(c.scan()).requests, 2);
});

test('separate collector connections deduplicate safely and observe committed external ledger changes', (t) => {
  const f = fixture(t);
  const first = f.create();
  const second = f.create();
  f.write('a.jsonl', [entry('a')]);
  first.scan();
  second.scan();
  f.write('b.jsonl', [entry('b')]);
  second.scan();
  fs.unlinkSync(path.join(f.root, 'b.jsonl'));
  assert.equal(totals(first.scan()).requests, 2);
});

test('source overrides isolate ledgers and use explicit projects path before QODERCN_CONFIG_DIR', (t) => {
  const f = fixture(t);
  f.write('a.jsonl', [entry('a')]);
  const alternate = path.join(f.home, 'alternate');
  fs.mkdirSync(alternate);
  fs.writeFileSync(path.join(alternate, 'b.jsonl'), JSON.stringify(entry('b', 0.5)) + '\n');
  const c = f.create();
  assert.equal(totals(c.scan()).credits, 0.25);
  const env = { TOKEN_MONITOR_QODER_CN_PROJECTS_PATH: alternate, QODERCN_CONFIG_DIR: '/does-not-exist' };
  assert.equal(totals(c.scan({ env })).credits, 0.5);
  assert.equal(totals(c.scan()).credits, 0.25);
});

test('a later timestamp revises reported credits while an older replay cannot replace it', (t) => {
  const f = fixture(t);
  f.write('a.jsonl', [entry('a', 1)]);
  const c = f.create();
  c.scan();
  fs.appendFileSync(path.join(f.root, 'a.jsonl'), JSON.stringify(entry('a', 0.5, {
    timestamp: new Date(2026, 9, 15, 13).toISOString()
  })) + '\n');
  assert.equal(totals(c.scan()).credits, 0.5);
  f.write('copy.jsonl', [entry('a', 1)]);
  assert.equal(totals(c.scan()).credits, 0.5);
  assert.equal(totals(c.scan()).requests, 1);
});

test('corrupt/unsupported ledger state fails visibly and can be repaired without rebuilding the collector', (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(f.databasePath);
  db.exec('PRAGMA user_version = 99');
  db.close();
  const c = f.create();
  assert.throws(() => c.scan(), /Unsupported/);
  const repaired = new DatabaseSync(f.databasePath);
  repaired.exec('PRAGMA user_version = 0');
  repaired.close();
  f.write('a.jsonl', [entry('a')]);
  assert.equal(totals(c.scan()).requests, 1);
});

test('local calendar days, range boundaries and allTimeSince preserve credits without rescaling', (t) => {
  const f = fixture(t);
  f.write('a.jsonl', [
    entry('a', 0.25, { timestamp: new Date(2026, 8, 30, 23, 59).toISOString() }),
    entry('b', 0.5, { timestamp: new Date(2026, 9, 1, 0, 1).toISOString() })
  ]);
  const c = f.create();
  assert.equal(totals(c.scan(), { start: '2026-10-01', end: '2026-10-01' }).credits, 0.5);
  assert.equal(totals(c.scan({ allTimeSince: '2026-10-01' })).requests, 1);
  assert.equal(totals(c.scan()).requests, 2);
});

test('invalid financial values and complete corrupt records surface errors, never become zero', (t) => {
  const f = fixture(t);
  for (const value of [-1, null, '0.5', Infinity]) {
    assert.throws(() => creditRecord(entry('bad', value)), /Invalid/);
  }
  f.write('a.jsonl', [entry('a')]);
  fs.appendFileSync(path.join(f.root, 'a.jsonl'), '{invalid}\n');
  assert.throws(() => f.create().scan(), /Invalid complete JSONL/);
});

test('portable normalization is bounded, private-field-free, idempotent and rejects unsafe map keys', () => {
  const value = { days: { '2026-10-15': { qfmodel: { credits: 0.5, requests: 2, prompt: 'private' } } }, secret: 'private' };
  const normalized = normalizeQoderCnCredits(value);
  assert.deepEqual(plain(normalized), { days: { '2026-10-15': { qfmodel: { credits: 0.5, requests: 2 } } } });
  assert.deepEqual(normalizeQoderCnCredits(normalized), normalized);
  assert.equal(normalizeQoderCnCredits({ days: { '2026-99-99': {} } }), null);
  assert.equal(normalizeQoderCnCredits(JSON.parse('{"days":{"2026-10-15":{"__proto__":{"credits":1,"requests":1}}}}')), null);
  assert.equal(normalizeQoderCnCredits({ days: { '2026-10-15': { bad: { credits: NaN, requests: 1 } } } }), null);
  assert.equal(normalizeQoderCnCredits({ days: { '2026-10-15': Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`m${i}`, { credits: 1, requests: 1 }])) } }), null);
});

test('device normalization, limits-only/partial updates and multi-device aggregation keep credits outside tokens', () => {
  const qoderCnCredits = { days: { '2026-10-15': { qfmodel: { credits: 0.5, requests: 2 } } } };
  const record = { deviceId: 'one', today: { totalTokens: 100, costUsd: 1 }, month: {}, allTime: {}, qoderCnCredits };
  const normalized = normalizeDeviceRecord(record);
  assert.deepEqual(plain(normalized.qoderCnCredits), qoderCnCredits);
  const state = createDeviceState();
  state.updateUsage(record);
  state.updateUsage({ today: { totalTokens: 101 } });
  state.updateLimits({ providers: [] });
  assert.deepEqual(state.getSnapshot().qoderCnCredits, qoderCnCredits);
  const limited = mergeDeviceRecord(record, { deviceId: 'one', limitsOnly: true, limits: { providers: [] } });
  assert.deepEqual(plain(limited.qoderCnCredits), qoderCnCredits);
  const stats = aggregateDevices([record, { ...record, deviceId: 'two' }], 0);
  assert.equal(stats.periods.today.totalTokens, 200);
  assert.equal(stats.periods.today.costUsd, 2);
  assert.equal(totals(stats.devices[0].qoderCnCredits).credits, 0.5);
  assert.equal(summarizeQoderCnCredits(stats.devices).credits, 1);
  assert.equal(Object.hasOwn(stats, 'qoderCnCredits'), false);
  assert.equal(normalizeDeviceRecord({ ...record, qoderCnCredits: null }).qoderCnCredits, null);
  assert.equal(Object.hasOwn(normalizeDeviceRecord({ deviceId: 'old' }), 'qoderCnCredits'), false);
});

test('collectUsageOnce publishes actual credits-only CLI usage and leaves BYOK token/cost output intact', async (t) => {
  const f = fixture(t);
  f.write('a.jsonl', [entry('cli')]);
  const options = {
    homeDir: f.home, env: {}, clients: 'qodercn', deviceId: 'test',
    allTimeSince: '2024-01-01', historyEnabled: false, projectsEnabled: false,
    qoderCnCreditsCollector: f.create(),
    runTokscale: async () => ({ entries: [{ client: 'qodercn', model: 'byok', input: 100, output: 20, cost: 0.01 }] })
  };
  const result = await collectUsageOnce(options);
  assert.equal(totals(result.qoderCnCredits).credits, 0.25);
  assert.equal(result.today.totalTokens, 120);
  assert.equal(result.today.costUsd, 0.01);
  assert.equal(result.clientHealth.clients.qodercn.data.creditRequests, 1);
  assert.equal(result.clientHealth.clients.qodercn.overall, 'healthy');
  const creditsOnly = await collectUsageOnce({ ...options, runTokscale: async () => ({ entries: [] }) });
  assert.equal(creditsOnly.clientStatus.qodercn, 'active');
  assert.equal(creditsOnly.clientHealth.clients.qodercn.overall, 'healthy');
  assert.equal(creditsOnly.clientHealth.clients.qodercn.diagnostics, undefined);
  assert.equal(normalizeDeviceRecord(creditsOnly).clientHealth.clients.qodercn.overall, 'healthy');
  const disabled = await collectUsageOnce({ ...options, clients: '' });
  assert.equal(disabled.qoderCnCredits, null);
});

test('the running collector owns the persistent ledger and targeted refresh publishes appended credits', async (t) => {
  const f = fixture(t);
  const file = f.write('a.jsonl', [entry('a')]);
  let latest;
  let failure;
  const collector = startCollector({
    clients: 'qodercn', deviceId: 'test', homeDir: f.home, env: {}, allTimeSince: '2024-01-01',
    historyEnabled: false, projectsEnabled: false, watchEnabled: false, sessionActivityPolling: false,
    anchorPersistenceEnabled: false, intervalMs: 60000, qoderCnCreditsDatabasePath: f.databasePath,
    runTokscale: async () => ({ entries: [] }),
    onUpdate(summary) { latest = summary; }, onError(error) { failure = error; }
  });
  try {
    await collector.whenIdle();
    assert.equal(failure, undefined);
    assert.equal(totals(latest.qoderCnCredits).requests, 1);
    fs.appendFileSync(file, JSON.stringify(entry('b', 0.5)) + '\n');
    await collector.refreshClient('qodercn');
    assert.equal(failure, undefined);
    assert.equal(totals(latest.qoderCnCredits).credits, 0.75);
    assert.equal(latest.today.totalTokens, 0);
    assert.equal(latest.clientHealth.clients.qodercn.overall, 'healthy');
  } finally {
    collector.stop();
    await collector.whenIdle();
  }
});

test('credit source failure retains its own last-good view while original token accounting continues, then recovers', async (t) => {
  const f = fixture(t);
  const file = f.write('a.jsonl', [entry('a')]);
  let fail = false;
  const c = f.create({ fs: { ...fs, openSync(...args) {
    if (fail) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.openSync(...args);
  } } });
  const options = {
    homeDir: f.home, env: {}, clients: 'qodercn', deviceId: 'test', historyEnabled: false, projectsEnabled: false,
    qoderCnCreditsCollector: c,
    runTokscale: async () => ({ entries: [{ client: 'qodercn', model: 'byok', input: 100, cost: 0.1 }] })
  };
  await collectUsageOnce(options);
  fs.appendFileSync(file, JSON.stringify(entry('b', 0.5)) + '\n');
  fail = true;
  const failed = await collectUsageOnce(options);
  assert.equal(failed.today.totalTokens, 100);
  assert.equal(failed.today.costUsd, 0.1);
  assert.equal(failed.qoderCnCredits.error, 'collection-failed');
  assert.equal(totals(failed.qoderCnCredits).credits, 0.25);
  assert.equal(failed.clientHealth.clients.qodercn.overall, 'attention');
  assert.equal(failed.clientHealth.clients.qodercn.collection.state, 'read-failed');
  assert.equal(normalizeDeviceRecord(failed).clientHealth.clients.qodercn.overall, 'attention');
  fail = false;
  const recovered = await collectUsageOnce(options);
  assert.equal(recovered.qoderCnCredits.error, undefined);
  assert.equal(totals(recovered.qoderCnCredits).credits, 0.75);
  assert.equal(recovered.clientHealth.clients.qodercn.overall, 'healthy');
});

test('a new credits ledger I/O requirement never blocks existing token callers or invents a zero baseline', async (t) => {
  const f = fixture(t);
  f.write('a.jsonl', [entry('a')]);
  const blocked = path.join(f.home, 'not-a-directory');
  fs.writeFileSync(blocked, 'x');
  const events = [];
  const result = await collectUsageOnce({
    homeDir: f.home, env: {}, clients: 'qodercn', deviceId: 'test', historyEnabled: false, projectsEnabled: false,
    qoderCnCreditsDatabasePath: path.join(blocked, 'ledger.sqlite'),
    onDiagnosticEvent: (event) => events.push(event),
    runTokscale: async () => ({ entries: [{ client: 'qodercn', model: 'byok', input: 100 }] })
  });
  assert.equal(result.today.totalTokens, 100);
  assert.deepEqual(result.qoderCnCredits, { error: 'collection-failed' });
  assert.equal(result.clientHealth.clients.qodercn.collection.state, 'read-failed');
  assert.ok(events.some((event) => event.code === 'qodercn-credits-read-failed'));
});
