'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  QODER_MODEL_DISPLAY_NAMES,
  buildQoderHistoryGraph,
  buildQoderPeriods,
  collectQoderRows,
  normalizeQoderDbRow,
  qoderDataPaths,
  readQoderDbRows
} = require('../../src/shared/qoderCnUsage');

const QODER_DB_FIXTURE = path.join(__dirname, '..', 'fixtures', 'qoder-cn-local.db');

test('QODER_MODEL_DISPLAY_NAMES covers every official model code and the retired preview', () => {
  // Official codes from Qoder CN.app i18n `modelSelector.item.*` plus the
  // retired qmodel_preview found in real databases; custom codes pass through.
  for (const code of ['qmodel', 'qmodel_latest', 'qmodel_preview', 'gm51model', 'kmodel', 'dmodel', 'mmodel']) {
    assert.ok(QODER_MODEL_DISPLAY_NAMES[code], `${code} must be mapped`);
  }
  assert.equal(QODER_MODEL_DISPLAY_NAMES.qmodel_latest, 'Qwen3.7-Max');
  assert.equal(QODER_MODEL_DISPLAY_NAMES.gm51model, 'GLM-5.2');
  assert.equal(QODER_MODEL_DISPLAY_NAMES.custom_model, undefined, 'custom models stay unmapped');
});

test('normalizeQoderDbRow separates cached input without double-counting', () => {
  assert.deepEqual(normalizeQoderDbRow({
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
    messages: 1
  });
});

test('Qoder normalizers reject malformed and zero-only usage', () => {
  assert.equal(normalizeQoderDbRow({ token_info: '{}' }, 'cn'), null);
  assert.equal(normalizeQoderDbRow({
    token_info: JSON.stringify({ prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 })
  }, 'cn'), null);
});

test('normalizeQoderDbRow does not resolve inherited model names', () => {
  for (const modelKey of ['constructor', 'toString']) {
    const row = normalizeQoderDbRow({
      token_info: JSON.stringify({ prompt_tokens: 1, completion_tokens: 1 }),
      model_info: JSON.stringify({ model_key: modelKey })
    }, 'cn');
    assert.equal(row.model, modelKey);
  }
});

test('buildQoderPeriods keeps day boundaries and tokscale-compatible totals', () => {
  const now = Date.parse('2026-07-29T18:00:00Z');
  const rows = [
    { sessionId: 's1', messageId: 'm1', model: 'qmodel', input: 10, output: 2, cacheRead: 3, cacheWrite: 0, createdAt: now - 24 * 60 * 60 * 1000, messages: 1 },
    { sessionId: 's1', messageId: 'm2', model: 'qmodel', input: 20, output: 4, cacheRead: 5, cacheWrite: 0, createdAt: now - 2 * 60 * 60 * 1000, messages: 1 }
  ];
  const periods = buildQoderPeriods({ now: new Date(now).toISOString(), allTimeSince: '2026-01-01', rows });
  assert.equal(periods.today.totalInput, 20);
  assert.equal(periods.today.totalCacheRead, 5);
  assert.equal(periods.month.totalInput, 30);
  assert.equal(periods.allTime.entries[0].client, 'qodercn');
  assert.equal(periods.allTime.entries[0].messageCount, 2);
});

test('Qoder routing modes do not inherit unrelated catalog prices', () => {
  const now = Date.parse('2026-08-01T08:00:00Z');
  const row = {
    sessionId: 's1',
    messageId: 'm1',
    model: 'Auto',
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    createdAt: now,
    messages: 1
  };
  const pricingByModel = {
    auto: {
      inputCostPerToken: 1,
      outputCostPerToken: 1
    }
  };
  const periods = buildQoderPeriods({
    now: new Date(now).toISOString(),
    allTimeSince: '2026-01-01',
    rows: [row],
    // `tokscale pricing auto` currently resolves to morph/auto. Qoder Auto is
    // a routing mode, not that model, so applying this price is incorrect.
    pricingByModel
  });

  assert.equal(periods.today.totalInput + periods.today.totalOutput, 12);
  assert.equal(periods.today.totalCost, 0);
  assert.equal(buildQoderHistoryGraph({
    rows: [row],
    pricingByModel
  }).contributions[0].clients[0].cost, 0);
});

test('undated qoder rows count for allTime only, mirroring the proma includeUndated rule', () => {
  const now = Date.parse('2026-07-29T18:00:00Z');
  const rows = [
    { sessionId: 's1', messageId: 'm1', model: 'qmodel', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 },
    { sessionId: 's1', messageId: 'm2', model: 'qmodel', input: 20, output: 4, cacheRead: 0, cacheWrite: 0, createdAt: now - 2 * 60 * 60 * 1000, messages: 1 }
  ];
  const periods = buildQoderPeriods({ now: new Date(now).toISOString(), allTimeSince: '2026-01-01', rows });
  assert.equal(periods.today.totalInput, 20, 'undated row must not leak into today');
  assert.equal(periods.month.totalInput, 20, 'undated row must not leak into month');
  assert.equal(periods.allTime.totalInput, 30, 'undated row must count in allTime');
});

test('qoderDataPaths resolves QoderCN DB path per platform', () => {
  const suffix = path.join('QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db');

  const darwin = qoderDataPaths({ homeDir: '/Users/test', platform: 'darwin', env: {} });
  assert.deepEqual(darwin.dbPaths, [path.join('/Users/test', 'Library', 'Application Support', suffix)]);

  const win = qoderDataPaths({ homeDir: '/home/test', platform: 'win32', env: { APPDATA: '/home/test/AppData/Roaming' } });
  assert.deepEqual(win.dbPaths, [path.join('/home/test/AppData/Roaming', suffix)]);

  const linux = qoderDataPaths({ homeDir: '/home/test', platform: 'linux', env: {} });
  assert.deepEqual(linux.dbPaths, [path.join('/home/test/.config', suffix)]);
});

test('collectQoderRows reads DB rows and deduplicates by messageId', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-usage-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const rows = await collectQoderRows({
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

test('readQoderDbRows fails loudly when both sqlite backends are unavailable', async () => {
  const logged = [];
  await assert.rejects(
    readQoderDbRows('/virtual/qoder.db', {
      execFile: async () => { throw new Error('sqlite3: ENOENT'); },
      requireFn: () => { throw new Error('node:sqlite not available'); },
      logger: (message) => logged.push(message)
    }),
    /qoder sqlite read failed: sqlite3 CLI: sqlite3: ENOENT; node:sqlite: node:sqlite not available/
  );
  assert.equal(logged.length, 1);
  assert.match(logged[0], /sqlite3 CLI: sqlite3: ENOENT/);
  assert.match(logged[0], /node:sqlite: node:sqlite not available/);
});

test('Qoder SQLite fixture is queried and normalized end to end', async (t) => {
  let rows;
  try {
    rows = await collectQoderRows({ dbPaths: [QODER_DB_FIXTURE] });
  } catch (error) {
    t.skip(`no sqlite backend available: ${error.message}`);
    return;
  }

  assert.equal(rows.length, 4);
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
});
