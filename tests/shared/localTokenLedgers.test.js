'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createLocalTokenLedgerReader, applyLocalTokenLedgers } = require('../../src/shared/usage/localTokenLedgers');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const { normalizePeriod } = require('../../src/shared/usage');

function fixture(t, platform = process.platform) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-token-ledgers-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const appData = platform === 'win32' ? path.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config');
  const errors = [];
  const options = { homeDir: home, platform, env: { APPDATA: appData }, onError: (error) => errors.push(error) };
  const open = (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return new DatabaseSync(file);
  };
  return { home, errors, options, read: createLocalTokenLedgerReader(options),
    cherry: () => open(path.join(appData, 'CherryStudio', 'Data', 'cherrystudio.sqlite')),
    cc: () => open(path.join(home, '.cc-switch', 'cc-switch.db')) };
}

function snapshot() {
  const period = () => normalizePeriod({
    totalTokens: 100, costUsd: 1.25, clients: { cherrystudio: 100 },
    clientCosts: { cherrystudio: 1.25 }, models: { model: 100 }, modelCosts: { model: 1.25 },
    clientModels: { cherrystudio: { model: 100 } }, clientModelCosts: { cherrystudio: { model: 1.25 } },
    cacheReadTokens: 70, outputTokens: 10,
    sessions: { 'cherrystudio:s1': { client: 'cherrystudio', sessionId: 's1', totalTokens: 100, costUsd: 1.25 } }
  });
  return { updatedAt: new Date(2026, 9, 17, 12).toISOString(), today: period(), month: period(), allTime: period() };
}

test('Cherry reads total-only, agent, embedding and non-overlapping legacy tokens without any price columns', (t) => {
  const f = fixture(t);
  const db = f.cherry();
  db.exec(`CREATE TABLE ai_usage_record (
    model_id TEXT, created_at INTEGER, record_kind TEXT, message_kind TEXT, message_id TEXT,
    input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER);
    INSERT INTO ai_usage_record VALUES
      ('model', 1792173600000, 'invocation', 'chat', 'total-only', NULL, NULL, 500, NULL, NULL, NULL),
      ('model', 1792173600000, 'invocation', 'agent-session', 'agent', 1200, 340, 1540, 500, 80, 60),
      ('embed', 1792173600000, 'invocation', NULL, 'embedding', 20, NULL, 20, NULL, NULL, NULL),
      ('model', 1792173600000, 'legacy-aggregate', 'chat', 'old', 25, 5, 30, NULL, NULL, NULL),
      ('model', 1792173600000, 'legacy-aggregate', 'chat', 'total-only', 500, 0, 500, NULL, NULL, NULL),
      ('model', 1792173600000, 'invocation', 'chat', 'fallback', 100, 10, NULL, 90, 5, 8),
      ('model', -1, 'invocation', 'chat', 'invalid', 99999, 0, NULL, NULL, NULL, NULL);`);
  db.close();
  const rows = f.read('cherrystudio');
  assert.equal(rows.reduce((sum, row) => sum + row.tokens, 0), 2200);
  assert.ok(rows.every((row) => row.client === 'cherrystudio'));
  assert.deepEqual(f.errors, []);
});

test('CC Switch normalizes fresh, inclusive and legacy cache semantics across detailed and archived rows', (t) => {
  const f = fixture(t);
  const db = f.cc();
  db.exec(`CREATE TABLE proxy_request_logs (
    app_type TEXT, model TEXT, created_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_creation_tokens INTEGER, input_token_semantics INTEGER);
    CREATE TABLE usage_daily_rollups (
    app_type TEXT, model TEXT, date TEXT, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_creation_tokens INTEGER, input_token_semantics INTEGER);
    INSERT INTO proxy_request_logs VALUES
      ('codex', 'total', 1792173600, 100, 10, 80, 5, 1),
      ('codex', 'legacy', 1792173600, 100, 10, 80, 5, 0),
      ('claude', 'legacy', 1792173600, 20, 10, 80, 5, 0),
      ('codex', 'future-semantics', 1792173600, 9999, 10, 80, 5, 99);
    INSERT INTO usage_daily_rollups VALUES
      ('claude', 'fresh', '2026-08-20', 20, 10, 80, 5, 2);`);
  db.close();
  const rows = f.read('claude,codex');
  assert.deepEqual(rows.map((row) => row.tokens), [110, 115, 115, 115]);
  assert.equal(rows.at(-1).date, '2026-08-20');
  assert.ok(f.read('codex').every((row) => row.client === 'codex'));
  assert.deepEqual(f.errors, []);
});

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`Cherry source discovery respects the supplied ${platform} profile`, (t) => {
    const f = fixture(t, platform);
    const db = f.cherry();
    db.exec('CREATE TABLE ai_usage_record(model_id TEXT, created_at INTEGER, total_tokens INTEGER); INSERT INTO ai_usage_record VALUES (\'m\',1792173600000,17)');
    db.close();
    assert.equal(f.read('cherrystudio')[0].tokens, 17);
    assert.deepEqual(f.read('copilot'), []);
  });
}

test('WAL commits invalidate cached totals and deleted or unreadable sources never replay stale data', (t) => {
  const f = fixture(t);
  const db = f.cherry();
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE ai_usage_record(model_id TEXT, created_at INTEGER, total_tokens INTEGER);
    INSERT INTO ai_usage_record VALUES ('m',1792173600000,17)`);
  assert.equal(f.read('cherrystudio')[0].tokens, 17);
  db.exec("INSERT INTO ai_usage_record VALUES ('m',1792173600000,18)");
  assert.equal(f.read('cherrystudio').reduce((s, r) => s + r.tokens, 0), 35);
  db.close();
  const cherryPath = path.join(f.options.env.APPDATA, 'CherryStudio', 'Data', 'cherrystudio.sqlite');
  fs.writeFileSync(cherryPath, 'damaged SQLite database');
  assert.deepEqual(f.read('cherrystudio'), []);
  assert.ok(f.errors.length > 0);
  fs.unlinkSync(cherryPath);
  assert.deepEqual(f.read('cherrystudio'), []);
});

test('overlapping ledger tokens raise a floor once and leave every price, native session and timing untouched', () => {
  const input = snapshot();
  const before = structuredClone(input);
  const rows = [{ date: '2026-10-17', client: 'cherrystudio', model: 'model', tokens: 250 }];
  applyLocalTokenLedgers(input, rows);
  applyLocalTokenLedgers(input, rows);
  for (const name of ['today', 'month', 'allTime']) {
    const period = input[name];
    assert.equal(period.totalTokens, 250);
    assert.equal(period.clients.cherrystudio, 250);
    assert.equal(period.clientModels.cherrystudio.model, 250);
    assert.equal(period.models.model, 250);
    assert.equal(period.unclassifiedTokens, 150);
    assert.equal(period.cacheReadTokens, before[name].cacheReadTokens);
    assert.equal(period.outputTokens, before[name].outputTokens);
    assert.equal(period.costUsd, before[name].costUsd);
    for (const key of ['clientCosts', 'modelCosts', 'clientModelCosts', 'sessions', 'modelThroughput']) {
      assert.deepEqual(period[key], before[name][key]);
    }
  }
});

test('native totals above the ledger and unattributed native totals are never counted twice', () => {
  const input = snapshot();
  const before = JSON.stringify(input);
  applyLocalTokenLedgers(input, [{ date: '2026-10-17', client: 'cherrystudio', model: 'model', tokens: 50 }]);
  assert.equal(JSON.stringify(input), before);
  delete input.allTime.clientModels.cherrystudio;
  const unknown = JSON.stringify(input.allTime);
  applyLocalTokenLedgers(input, [{ date: '2026-10-17', client: 'cherrystudio', model: 'model', tokens: 500 }]);
  assert.equal(JSON.stringify(input.allTime), unknown);
});

test('period windows use local days, honor the configured start, and preserve partial previews', () => {
  const input = snapshot();
  const rows = [
    ['2026-09-30', 1000], ['2026-10-16', 400], ['2026-10-17', 200], ['2026-10-18', 9999]
  ].map(([date, tokens]) => ({ date, tokens, client: 'cherrystudio', model: 'model' }));
  applyLocalTokenLedgers(input, rows, { allTimeSince: '2026-10-01' });
  assert.equal(input.today.totalTokens, 200);
  assert.equal(input.month.totalTokens, 600);
  assert.equal(input.allTime.totalTokens, 600);
  const laterStart = snapshot();
  applyLocalTokenLedgers(laterStart, rows, { allTimeSince: '2026-10-17' });
  assert.equal(laterStart.month.totalTokens, 600);
  assert.equal(laterStart.allTime.totalTokens, 200);
  const partial = { updatedAt: input.updatedAt, today: snapshot().today };
  applyLocalTokenLedgers(partial, rows);
  assert.ok(!Object.hasOwn(partial, 'month'));
  assert.ok(!Object.hasOwn(partial, 'allTime'));
});

test('provider-prefixed model names match the same ledger tokens without renaming cost keys', () => {
  const input = snapshot();
  const label = '11111111-2222-4333-8444-555555555555:model';
  input.allTime.clientModels.cherrystudio = { [label]: 100 };
  input.allTime.models = { [label]: 100 };
  const beforeCost = structuredClone(input.allTime.modelCosts);
  applyLocalTokenLedgers(input, [{ date: '2026-10-17', tokens: 200, client: 'cherrystudio', model: 'model' }]);
  assert.equal(input.allTime.models[label], 100);
  assert.equal(input.allTime.models.model, 100);
  assert.deepEqual(input.allTime.modelCosts, beforeCost);
});

test('transform reconciles after retention and never captures recovered tokens into native archives', () => {
  const input = snapshot();
  let captures = 0;
  const transform = createUsageTransform({
    store: { capture(value) {
      captures++;
      assert.equal(value.allTime.totalTokens, 100);
      return { archive: { version: 1, sessions: {} } };
    } },
    getSettings: () => ({ clients: 'cherrystudio', allTimeSince: '2024-01-01', projectsEnabled: false }),
    readTokenLedgers: () => [{ date: '2026-10-17', tokens: 250, client: 'cherrystudio', model: 'model' }]
  });
  assert.equal(transform.transform(input).allTime.totalTokens, 250);
  assert.equal(transform.transform(input).allTime.totalTokens, 250);
  assert.equal(input.allTime.totalTokens, 100);
  assert.equal(captures, 2);
});

test('a fresh native scan that catches up removes the recovery instead of retaining an extra observation', () => {
  const captured = [];
  const transform = createUsageTransform({
    store: { capture(value) {
      captured.push(value.allTime.totalTokens);
      return { archive: { version: 1, sessions: {} } };
    } },
    getSettings: () => ({ clients: 'cherrystudio', projectsEnabled: false }),
    readTokenLedgers: () => [{ date: '2026-10-17', tokens: 250, client: 'cherrystudio', model: 'model' }]
  });
  assert.equal(transform.transform(snapshot()).allTime.totalTokens, 250);
  const native = snapshot();
  for (const name of ['today', 'month', 'allTime']) {
    native[name].totalTokens = 250;
    native[name].clients.cherrystudio = 250;
    native[name].models.model = 250;
    native[name].clientModels.cherrystudio.model = 250;
  }
  const result = transform.transform(native);
  assert.equal(result.allTime.totalTokens, 250);
  assert.equal(result.allTime.unclassifiedTokens, 0);
  assert.deepEqual(captured, [100, 250]);
});
