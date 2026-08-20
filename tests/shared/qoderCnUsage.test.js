'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const {
  QODER_CN_MODEL_DISPLAY_NAMES,
  buildQoderCnHistoryGraph,
  buildQoderCnPeriods,
  collectQoderCnRows,
  normalizeQoderCnDbRow,
  qoderCnDataPaths,
  readQoderCnDbRows,
  resolveQoderCnPricing,
  resetQoderCnChatSessionProbe,
  resetQoderCnPricingCache
} = require('../../src/shared/qoderCnUsage');

const QODER_CN_DB_FIXTURE = path.join(__dirname, '..', 'fixtures', 'qoder-cn-local.db');

test('QODER_CN_MODEL_DISPLAY_NAMES covers every official model code and the retired preview', () => {
  // Official codes from Qoder CN.app i18n `modelSelector.item.*` plus the
  // retired qmodel_preview found in real databases; custom codes pass through.
  for (const code of ['qmodel', 'qmodel_latest', 'qmodel_preview', 'gm51model', 'kmodel', 'dmodel', 'mmodel']) {
    assert.ok(QODER_CN_MODEL_DISPLAY_NAMES[code], `${code} must be mapped`);
  }
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.qmodel_latest, 'Qwen3.7-Max');
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.gm51model, 'GLM-5.2');
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.qmodel_preview, 'Qwen3.8-Max-Preview');
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.q35model_preview, 'Qwen3.8-Max-Preview');
  assert.equal(QODER_CN_MODEL_DISPLAY_NAMES.custom_model, undefined, 'custom models stay unmapped');
});

test('normalizeQoderCnDbRow separates cached input without double-counting', () => {
  assert.deepEqual(normalizeQoderCnDbRow({
    row_id: 7,
    id: 'message-1',
    session_id: 'session-1',
    token_info: JSON.stringify({ prompt_tokens: 58_299, cached_tokens: 57_853, completion_tokens: 2_812 }),
    model_info: JSON.stringify({ model_key: 'qmodel_latest' }),
    gmt_create: 1_784_681_696_263
  }, 'cn'), {
    sessionId: 'qodercn:cn:session-1',
    messageId: 'qodercn:cn:session-1:message-1',
    model: 'Qwen3.7-Max', // qmodel_latest
    input: 446,
    output: 2_812,
    cacheRead: 57_853,
    cacheWrite: 0,
    createdAt: 1_784_681_696_263,
    projectLabel: '',
    messages: 1
  });
});

test('Qoder CN normalizers reject malformed and zero-only usage', () => {
  assert.equal(normalizeQoderCnDbRow({ token_info: '{}' }, 'cn'), null);
  assert.equal(normalizeQoderCnDbRow({
    token_info: JSON.stringify({ prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 })
  }, 'cn'), null);
});

test('normalizeQoderCnDbRow does not resolve inherited model names', () => {
  for (const modelKey of ['constructor', 'toString']) {
    const row = normalizeQoderCnDbRow({
      token_info: JSON.stringify({ prompt_tokens: 1, completion_tokens: 1 }),
      model_info: JSON.stringify({ model_key: modelKey })
    }, 'cn');
    assert.equal(row.model, modelKey);
  }
});

test('buildQoderCnPeriods keeps day boundaries and tokscale-compatible totals', () => {
  const now = Date.parse('2026-07-29T18:00:00Z');
  const rows = [
    { sessionId: 's1', messageId: 'm1', model: 'qmodel', input: 10, output: 2, cacheRead: 3, cacheWrite: 0, createdAt: now - 24 * 60 * 60 * 1000, messages: 1 },
    { sessionId: 's1', messageId: 'm2', model: 'qmodel', input: 20, output: 4, cacheRead: 5, cacheWrite: 0, createdAt: now - 2 * 60 * 60 * 1000, messages: 1 }
  ];
  const periods = buildQoderCnPeriods({ now: new Date(now).toISOString(), allTimeSince: '2026-01-01', rows });
  assert.equal(periods.today.totalInput, 20);
  assert.equal(periods.today.totalCacheRead, 5);
  assert.equal(periods.month.totalInput, 30);
  assert.equal(periods.allTime.entries[0].client, 'qodercn');
  assert.equal(periods.allTime.entries[0].messageCount, 2);
});

test('Qoder CN routing modes do not inherit unrelated catalog prices', () => {
  const now = Date.parse('2026-08-01T08:00:00Z');
  const tiers = ['Auto', 'Ultimate', 'Performance', 'Efficient', 'Lite'];
  const rows = tiers.map((model, index) => ({
    sessionId: `s${index}`,
    messageId: `m${index}`,
    model,
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    createdAt: now,
    messages: 1
  }));
  const pricingByModel = Object.fromEntries(tiers.map((tier) => [tier.toLowerCase(), {
    inputCostPerToken: 1,
    outputCostPerToken: 1
  }]));
  const periods = buildQoderCnPeriods({
    now: new Date(now).toISOString(),
    allTimeSince: '2026-01-01',
    rows,
    // Routing tiers name model pools, not the selected underlying model. A
    // same-named catalog or custom-pricing entry must never price these rows.
    pricingByModel
  });

  assert.equal(periods.today.totalInput + periods.today.totalOutput, 12 * tiers.length);
  assert.equal(periods.today.totalCost, 0);
  const clients = buildQoderCnHistoryGraph({ rows, pricingByModel }).contributions[0].clients;
  assert.deepEqual(clients.map((client) => client.cost), tiers.map(() => 0));
});

test('Qoder CN pricing is resolved and cached independently', async () => {
  resetQoderCnPricingCache();
  let lookups = 0;
  const lookupModelPricing = async (modelId) => {
    lookups += 1;
    assert.equal(modelId, 'qwen3.7-max');
    return {
      pricing: {
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002,
        cacheReadInputTokenCost: 0.0000001,
        cacheCreationInputTokenCost: 0.000003
      }
    };
  };
  const rows = [
    { model: 'Qwen3.7-Max' },
    ...['Auto', 'Ultimate', 'Performance', 'Efficient', 'Lite'].map((model) => ({ model }))
  ];
  const first = await resolveQoderCnPricing(rows, { lookupModelPricing, pricingRevision: 1, nowMs: 1000 });
  const second = await resolveQoderCnPricing(rows, { lookupModelPricing, pricingRevision: 1, nowMs: 2000 });

  assert.deepEqual(first, {
    'qwen3.7-max': {
      inputCostPerToken: 0.000001,
      outputCostPerToken: 0.000002,
      cacheReadInputTokenCost: 0.0000001,
      cacheCreationInputTokenCost: 0.000003
    }
  });
  assert.deepEqual(second, first);
  assert.equal(lookups, 1, 'routing tiers have no selected underlying model and must not trigger catalog lookups');
  resetQoderCnPricingCache();
});

test('Qoder CN cost uses input, output, cache-read, and cache-write rates', () => {
  const now = Date.parse('2026-08-01T08:00:00Z');
  const rows = [{
    sessionId: 's1', messageId: 'm1', model: 'Qwen3.7-Max', input: 10, output: 2,
    cacheRead: 5, cacheWrite: 1, createdAt: now, messages: 1
  }];
  const pricingByModel = {
    'qwen3.7-max': {
      inputCostPerToken: 2,
      outputCostPerToken: 3,
      cacheReadInputTokenCost: 4,
      cacheCreationInputTokenCost: 5
    }
  };
  const periods = buildQoderCnPeriods({ now: new Date(now).toISOString(), allTimeSince: '2026-01-01', rows, pricingByModel });
  const graph = buildQoderCnHistoryGraph({ rows, pricingByModel });
  assert.equal(periods.today.totalCost, 51);
  assert.equal(graph.contributions[0].clients[0].cost, 51);
});

test('undated Qoder CN rows count for allTime only, mirroring the proma includeUndated rule', () => {
  const now = Date.parse('2026-07-29T18:00:00Z');
  const rows = [
    { sessionId: 's1', messageId: 'm1', model: 'qmodel', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 },
    { sessionId: 's1', messageId: 'm2', model: 'qmodel', input: 20, output: 4, cacheRead: 0, cacheWrite: 0, createdAt: now - 2 * 60 * 60 * 1000, messages: 1 }
  ];
  const periods = buildQoderCnPeriods({ now: new Date(now).toISOString(), allTimeSince: '2026-01-01', rows });
  assert.equal(periods.today.totalInput, 20, 'undated row must not leak into today');
  assert.equal(periods.month.totalInput, 20, 'undated row must not leak into month');
  assert.equal(periods.allTime.totalInput, 30, 'undated row must count in allTime');

  const graph = buildQoderCnHistoryGraph({ rows });
  assert.equal(graph.contributions.length, 1, 'undated rows must not create a history day');
  assert.equal(graph.contributions[0].clients[0].tokens.input, 20);
});

test('qoderCnDataPaths resolves QoderCN DB path per platform', () => {
  const suffix = path.join('QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db');

  const darwin = qoderCnDataPaths({ homeDir: '/Users/test', platform: 'darwin', env: {} });
  assert.deepEqual(darwin.dbPaths, [path.join('/Users/test', 'Library', 'Application Support', suffix)]);

  const win = qoderCnDataPaths({ homeDir: '/home/test', platform: 'win32', env: { APPDATA: '/home/test/AppData/Roaming' } });
  assert.deepEqual(win.dbPaths, [path.join('/home/test/AppData/Roaming', suffix)]);

  const linux = qoderCnDataPaths({ homeDir: '/home/test', platform: 'linux', env: {} });
  assert.deepEqual(linux.dbPaths, [path.join('/home/test/.config', suffix)]);
});

test('collectQoderCnRows reads DB rows and deduplicates by messageId', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-usage-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const rows = await collectQoderCnRows({
    homeDir,
    platform: 'darwin',
    env: {},
    readDbRows: async () => [{
      row_id: 1,
      id: 'm1',
      session_id: 's1',
      token_info: JSON.stringify({ prompt_tokens: 12, cached_tokens: 10, completion_tokens: 3 }),
      model_info: JSON.stringify({ model_key: 'qmodel_latest' }),
      gmt_create: Date.parse('2026-07-29T08:00:00.000Z')
    }, {
      row_id: 2,
      id: 'm1',
      session_id: 's1',
      token_info: JSON.stringify({ prompt_tokens: 12, cached_tokens: 10, completion_tokens: 3 }),
      model_info: JSON.stringify({ model_key: 'qmodel_latest' }),
      gmt_create: Date.parse('2026-07-29T08:00:00.000Z')
    }],
    dbPaths: ['/virtual/qoder.db']
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 2);
  assert.equal(rows[0].cacheRead, 10);
  assert.equal(rows[0].output, 3);
});

test('readQoderCnDbRows fails loudly when both sqlite backends are unavailable', async () => {
  const logged = [];
  await assert.rejects(
    readQoderCnDbRows('/virtual/qoder.db', {
      execFile: async () => { throw new Error('sqlite3: ENOENT'); },
      requireFn: () => { throw new Error('node:sqlite not available'); },
      logger: (message) => logged.push(message)
    }),
    /qodercn sqlite read failed: sqlite3 CLI: sqlite3: ENOENT; node:sqlite: node:sqlite not available/
  );
  assert.equal(logged.length, 1);
  assert.match(logged[0], /sqlite3 CLI: sqlite3: ENOENT/);
  assert.match(logged[0], /node:sqlite: node:sqlite not available/);
});

test('sqlite3 maxBuffer failures do not fall through to an unbounded Node read', async () => {
  resetQoderCnChatSessionProbe();
  let nodeFallbackCalled = false;
  const execFile = async (_command, args) => {
    if (String(args.at(-1)).includes('sqlite_master')) return { stdout: '[{"1":1}]' };
    const error = new Error('stdout maxBuffer length exceeded');
    error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    throw error;
  };

  await assert.rejects(
    readQoderCnDbRows('/virtual/qoder-budget.db', {
      execFile,
      requireFn: () => {
        nodeFallbackCalled = true;
        throw new Error('Node fallback must not run');
      }
    }),
    (error) => error.code === 'QODER_CN_READ_BUDGET_EXCEEDED'
      && /bytes limit/.test(error.message)
  );
  assert.equal(nodeFallbackCalled, false);
  resetQoderCnChatSessionProbe();
});

(sqlite ? test : test.skip)('node:sqlite reads fail closed when the row budget is exceeded', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-row-budget-'));
  const dbPath = path.join(tmp, 'local.db');
  t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); resetQoderCnChatSessionProbe(); });
  const database = new sqlite.DatabaseSync(dbPath);
  database.exec(`CREATE TABLE chat_message (
    id TEXT, session_id TEXT, request_id TEXT, token_info TEXT, model_info TEXT, gmt_create INTEGER, role TEXT
  )`);
  const insert = database.prepare(`INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, 'assistant')`);
  for (const id of ['m1', 'm2']) {
    insert.run(id, 's1', `r-${id}`, '{"prompt_tokens":5,"completion_tokens":2}', '{"model_key":"qmodel"}', Date.now());
  }
  database.close();
  resetQoderCnChatSessionProbe();

  await assert.rejects(
    readQoderCnDbRows(dbPath, {
      execFile: async () => { throw new Error('sqlite3 unavailable'); },
      maxReadRows: 1
    }),
    (error) => error.code === 'QODER_CN_READ_BUDGET_EXCEEDED'
      && /rows limit 1/.test(error.message)
  );

  await assert.rejects(
    readQoderCnDbRows(dbPath, {
      execFile: async () => { throw new Error('sqlite3 unavailable'); },
      maxReadBytes: 32
    }),
    (error) => error.code === 'QODER_CN_READ_BUDGET_EXCEEDED'
      && /bytes limit 32/.test(error.message)
  );
});

(sqlite ? test : test.skip)('a cached absent chat_session capability expires after the negative TTL', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-schema-cache-'));
  const dbPath = path.join(tmp, 'local.db');
  t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); resetQoderCnChatSessionProbe(); });
  let database = new sqlite.DatabaseSync(dbPath);
  database.exec(`CREATE TABLE chat_message (
    id TEXT, session_id TEXT, request_id TEXT, token_info TEXT, model_info TEXT, gmt_create INTEGER, role TEXT
  )`);
  database.prepare(`INSERT INTO chat_message VALUES ('m1','s1','r1','{"prompt_tokens":5,"completion_tokens":2}','{"model_key":"qmodel"}',?,'assistant')`).run(Date.now());
  database.close();
  const options = {
    execFile: async () => { throw new Error('sqlite3 unavailable'); },
    negativeSchemaCacheTtlMs: 1_000
  };
  resetQoderCnChatSessionProbe();

  const beforeMigration = await readQoderCnDbRows(dbPath, { ...options, nowMs: 100 });
  assert.equal(beforeMigration[0].project_name, undefined);

  database = new sqlite.DatabaseSync(dbPath);
  database.exec('CREATE TABLE chat_session (session_id TEXT PRIMARY KEY, project_name TEXT)');
  database.prepare('INSERT INTO chat_session VALUES (?, ?)').run('s1', 'migrated-project');
  database.close();

  const cached = await readQoderCnDbRows(dbPath, { ...options, nowMs: 500 });
  assert.equal(cached[0].project_name, undefined, 'negative cache avoids probing every tick');
  const refreshed = await readQoderCnDbRows(dbPath, { ...options, nowMs: 1_101 });
  assert.equal(refreshed[0].project_name, 'migrated-project');
});

(sqlite ? test : test.skip)('readQoderCnDbRows handles second and millisecond Qoder timestamps in anchored reads', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-since-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dbPath = path.join(tmp, 'local.db');
  const database = new sqlite.DatabaseSync(dbPath);
  database.exec(`CREATE TABLE chat_message (
    id TEXT,
    session_id TEXT,
    request_id TEXT,
    token_info TEXT,
    model_info TEXT,
    gmt_create INTEGER,
    role TEXT
  )`);
  database.exec(`CREATE TABLE chat_session (
    session_id varchar(64) primary key,
    user_id varchar(64) not null,
    user_name varchar(64),
    session_title varchar(256) not null,
    project_id varchar(64) not null,
    project_uri varchar(512),
    project_name varchar(64),
    gmt_create INTEGER,
    gmt_modified INTEGER
  )`);
  const insert = database.prepare(`
    INSERT INTO chat_message (id, session_id, request_id, token_info, model_info, gmt_create, role)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const sinceMs = Date.parse('2026-07-29T00:00:00Z');
  const add = (id, gmtCreate) => insert.run(
    id, `session-${id}`, `request-${id}`,
    JSON.stringify({ prompt_tokens: 2, completion_tokens: 1 }),
    JSON.stringify({ model_key: 'qmodel' }), gmtCreate, 'assistant'
  );
  add('old-ms', sinceMs - 1);
  add('new-ms', sinceMs + 1_000);
  add('new-seconds', Math.floor((sinceMs + 2_000) / 1_000));
  add('new-iso', '2026-07-29T00:00:03.000Z');
  database.close();

  const rows = await readQoderCnDbRows(dbPath, {
    sinceMs,
    execFile: async () => { throw new Error('sqlite3 unavailable'); }
  });

  assert.deepEqual(rows.map((row) => row.id).sort(), ['new-iso', 'new-ms', 'new-seconds']);
});

test('Qoder SQLite fixture is queried and normalized end to end', async (t) => {
  let rows;
  try {
    rows = await collectQoderCnRows({ dbPaths: [QODER_CN_DB_FIXTURE] });
  } catch (error) {
    t.skip(`no sqlite backend available: ${error.message}`);
    return;
  }

  assert.equal(rows.length, 10);
  const byId = new Map(rows.map((row) => [row.messageId.split(':').pop(), row]));
  assert.deepEqual(
    {
      model: byId.get('msg-1').model,
      input: byId.get('msg-1').input,
      cacheRead: byId.get('msg-1').cacheRead,
      output: byId.get('msg-1').output
    },
    { model: 'Qwen3.7-Max', input: 446, cacheRead: 57_853, output: 2_812 }
  );
  assert.equal(byId.get('msg-8').model, 'qoder-agent');
  // ISO text timestamps (Z-suffixed so SQL and JS agree on UTC everywhere)
  // parse to milliseconds; unparseable text becomes 0 (undated), never a fake
  // 1970 timestamp. Numeric text scales like numeric columns: seconds ×1000,
  // milliseconds ≥1e12 pass through unchanged.
  assert.equal(byId.get('msg-9').createdAt, Date.parse('2026-07-29T09:00:00Z'));
  assert.equal(byId.get('msg-10').createdAt, 0);
  assert.equal(byId.get('msg-11').createdAt, 1_750_000_000 * 1000);
  assert.equal(byId.get('msg-12').createdAt, 1_785_286_800_000);
  // project_name from chat_session flows through as the session project label.
  assert.equal(byId.get('msg-1').projectLabel, 'token-monitor-main');
  assert.equal(byId.get('msg-3').projectLabel, 'ZCodeProject');
  assert.equal(byId.get('msg-10').projectLabel, '', 'the "." sentinel is filtered out');
  assert.equal(byId.get('msg-13').projectLabel, 'qoder-demo');
});

test('anchored read applies a lenient window to text timestamps and filters in SQL', async (t) => {
  let rows;
  try {
    rows = await readQoderCnDbRows(QODER_CN_DB_FIXTURE, { sinceMs: 1_785_286_800_000 });
  } catch (error) {
    t.skip(`no sqlite backend available: ${error.message}`);
    return;
  }
  const ids = rows.map((row) => row.id);
  // msg-9 (Z-suffixed ISO, 15 h below sinceMs) and msg-12 (text milliseconds)
  // survive the anchored read via the lenient 24 h text window; msg-10
  // (unparseable text → 0) must still be filtered out by SQL, and msg-2
  // (numeric ms below sinceMs) must be filtered by the exact numeric branch.
  assert.ok(ids.includes('msg-9'), 'Z-suffixed ISO at sinceMs must be kept');
  assert.ok(ids.includes('msg-12'), 'text milliseconds within the window must be kept');
  // Discriminating case: msg-13 is a text ISO 8h below sinceMs — it survives
  // ONLY because of the lenient one-day window; msg-14 is a numeric row at the
  // same instant, which the exact numeric branch must still filter out.
  assert.ok(ids.includes('msg-13'), 'text row inside the lenient window must be kept');
  assert.ok(!ids.includes('msg-14'), 'numeric row at the same instant must be filtered exactly');
  assert.ok(!ids.includes('msg-10'), 'unparseable text must not survive the filter');
  assert.ok(!ids.includes('msg-2'), 'numeric row below sinceMs must be filtered exactly');
});

test('sessions reach the projects rollup with project labels end to end', async (t) => {
  const { collectQoderCnRows, buildQoderCnPeriods } = require('../../src/shared/qoderCnUsage');
  const { extractUsageFromTokscale } = require('../../src/shared/usage');
  resetQoderCnChatSessionProbe();
  let rows;
  try {
    rows = await collectQoderCnRows({ dbPaths: [QODER_CN_DB_FIXTURE] });
  } catch (error) {
    t.skip(`no sqlite backend available: ${error.message}`);
    return;
  }
  const periods = buildQoderCnPeriods({ now: new Date(), allTimeSince: '2024-01-01', rows });
  const period = extractUsageFromTokscale(periods.allTime);
  const sessions = Object.values(period.sessions);
  const withProject = sessions.filter((s) => s.projectLabel);
  assert.ok(withProject.length >= 2, 'sessions must carry project labels');
  assert.ok(withProject.some((s) => s.projectLabel === 'token-monitor-main'));
  assert.ok(withProject.some((s) => s.projectLabel === 'ZCodeProject'));
  assert.ok(!withProject.some((s) => s.projectLabel === '.'), 'the "." sentinel must stay unattributed');
});

test('reads survive a database without the chat_session table (fallback SQL)', async (t) => {
  const { readQoderCnDbRows, resetQoderCnChatSessionProbe } = require('../../src/shared/qoderCnUsage');
  const fs = require('node:fs');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-no-session-'));
  t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); resetQoderCnChatSessionProbe(); });
  const dbPath = path.join(tmp, 'local.db');
  let sql;
  try {
    const { DatabaseSync } = require('node:sqlite');
    sql = new DatabaseSync(dbPath);
  } catch (error) {
    t.skip(`node:sqlite unavailable: ${error.message}`);
    return;
  }
  try {
    sql.exec(`CREATE TABLE chat_message (
      id TEXT, session_id TEXT, request_id TEXT, token_info TEXT, model_info TEXT, gmt_create INTEGER, role TEXT
    )`);
    sql.prepare(`INSERT INTO chat_message VALUES ('m1','s1','r1','{"prompt_tokens":5,"completion_tokens":2}','{"model_key":"qmodel"}',${Date.now()},'assistant')`).run();
    sql.close();
  } catch (error) {
    sql.close();
    throw error;
  }
  resetQoderCnChatSessionProbe();
  let rows;
  try {
    rows = await readQoderCnDbRows(dbPath);
  } catch (error) {
    t.fail(`read must not fail without chat_session: ${error.message}`);
    return;
  }
  assert.equal(rows.length, 1, 'fallback query still returns rows');
  assert.equal(rows[0].project_name, undefined, 'no project column in fallback');
});
