'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { extractUsageFromTokscale, mergePeriods } = require('../../src/shared/usage');
const {
  buildMiniMaxCodeHistoryGraph,
  buildMiniMaxCodePeriods,
  commitMiniMaxCodeAnchor,
  readMiniMaxCodeDatabase,
  reusableMiniMaxPeriods,
  rowsFromUsage
} = require('../../src/shared/providers/minimaxcode/usage');
const { replaceClientDailyHistory, graphFromDailyHistoryArchive } = require('../../src/shared/dailyHistoryArchive');
const { collectWslUsage } = require('../../src/shared/wslUsage');
const { deriveClientHealth } = require('../../src/shared/collector');

const PRICE_A = {
  'model-a': {
    inputCostPerToken: 0.01,
    outputCostPerToken: 0,
    cacheReadInputTokenCost: 0,
    cacheCreationInputTokenCost: 0
  }
};
const PRICE_B = {
  'model-b': {
    inputCostPerToken: 0.02,
    outputCostPerToken: 0,
    cacheReadInputTokenCost: 0,
    cacheCreationInputTokenCost: 0
  }
};

function periodsFor(rows, pricing, now) {
  const json = buildMiniMaxCodePeriods({ rows, pricingByModel: pricing, now, allTimeSince: '2020-01-01' });
  return {
    today: extractUsageFromTokscale(json.today),
    month: extractUsageFromTokscale(json.month),
    allTime: extractUsageFromTokscale(json.allTime)
  };
}

test('empty model uses the session effectiveModel, and a later model relabels the row', () => {
  const first = rowsFromUsage(
    [{ session_id: 's1', turn_id: 't1', model: '', ts: 1_700_000_000_000, input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 }],
    [{ session_id: 's1', workspace_dir: 'D:/work/app', extra_data_json: JSON.stringify({ effectiveModel: 'model-a' }) }]
  );
  assert.equal(first[0].model, 'model-a');
  assert.ok(first[0].projectId);

  const later = rowsFromUsage(
    [{ session_id: 's1', turn_id: 't1', model: '', ts: 1_700_000_000_000, input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 }],
    [{ session_id: 's1', workspace_dir: 'D:/work/app', extra_data_json: JSON.stringify({ effectiveModel: 'model-b' }) }]
  );
  assert.equal(later[0].model, 'model-b');
  assert.equal(later[0].input, 10);
});

test('missing session metadata keeps the tokens and leaves the model unknown', () => {
  const rows = rowsFromUsage(
    [{ session_id: 's1', turn_id: 't1', model: '', ts: 1_700_000_000_000, input_tokens: 4, output_tokens: 1, cache_read_tokens: 2, cache_write_tokens: 0, reasoning_tokens: 0 }],
    []
  );
  assert.equal(rows[0].model, 'unknown');
  assert.equal(rows[0].projectId, '');
  assert.equal(rows[0].input + rows[0].output + rows[0].cacheRead, 7);
});

test('same token total with a new model and price replaces the MiniMax slice and leaves another client alone', () => {
  const now = new Date('2026-09-27T12:00:00');
  const baseRow = { sessionId: 's1', createdAt: now.getTime(), input: 100, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const first = periodsFor([{ ...baseRow, model: 'model-a' }], PRICE_A, now);
  const second = periodsFor([{ ...baseRow, model: 'model-b' }], PRICE_B, now);
  assert.equal(first.month.totalTokens, second.month.totalTokens);
  assert.equal(first.month.models['model-a'], 100);
  assert.equal(first.month.costUsd, 1);
  assert.equal(second.month.models['model-b'], 100);
  assert.equal(second.month.models['model-a'], undefined);
  assert.equal(second.month.costUsd, 2);

  const other = extractUsageFromTokscale({
    entries: [{ client: 'claude', model: 'model-a', input: 100, output: 0, totalTokens: 100, cost: 1 }]
  });
  const merged = mergePeriods(other, second.month);
  assert.equal(merged.models['model-a'], 100);
  assert.equal(merged.clientModels.claude['model-a'], 100);
  assert.equal(merged.clientModels.minimaxcode['model-b'], 100);
  assert.equal(merged.costUsd, 3);
});

test('a failed read reuses only the same database and the same window', () => {
  const stored = {
    sourcePath: 'C:/data/runtime-state.sqlite',
    todayKey: '2026-09-27',
    monthKey: '2026-09',
    allTimeSince: '2020-01-01',
    today: { totalTokens: 5 },
    month: { totalTokens: 9 },
    allTime: { totalTokens: 20 }
  };
  const sameDay = reusableMiniMaxPeriods(stored, {
    sourcePath: stored.sourcePath,
    todayKey: '2026-09-27',
    monthKey: '2026-09',
    allTimeSince: '2020-01-01'
  });
  assert.equal(sameDay.today.totalTokens, 5);
  assert.equal(sameDay.month.totalTokens, 9);

  const nextDay = reusableMiniMaxPeriods(stored, {
    sourcePath: stored.sourcePath,
    todayKey: '2026-09-28',
    monthKey: '2026-09',
    allTimeSince: '2020-01-01'
  });
  assert.equal(nextDay.today, null);
  assert.equal(nextDay.month.totalTokens, 9);

  const nextMonth = reusableMiniMaxPeriods(stored, {
    sourcePath: stored.sourcePath,
    todayKey: '2026-10-01',
    monthKey: '2026-10',
    allTimeSince: '2020-01-01'
  });
  assert.equal(nextMonth.today, null);
  assert.equal(nextMonth.month, null);
  assert.equal(nextMonth.allTime.totalTokens, 20);

  const otherDb = reusableMiniMaxPeriods(stored, {
    sourcePath: 'C:/other/runtime-state.sqlite',
    todayKey: '2026-09-27',
    monthKey: '2026-09',
    allTimeSince: '2020-01-01'
  });
  assert.equal(otherDb.today, null);
  assert.equal(otherDb.allTime, null);
});

test('a capture that is not ok does not replace the stored periods', () => {
  const anchor = { minimaxCodePeriods: { sourcePath: 'db', todayKey: '2026-09-27', today: { totalTokens: 5 } } };
  const kept = commitMiniMaxCodeAnchor(anchor, { ok: false, sourcePath: 'db', periods: { today: { totalTokens: 0 } } });
  assert.equal(kept.minimaxCodePeriods.today.totalTokens, 5);
  const replaced = commitMiniMaxCodeAnchor(anchor, {
    ok: true,
    sourcePath: 'db',
    todayKey: '2026-09-27',
    monthKey: '2026-09',
    allTimeSince: '2020-01-01',
    periods: { today: { totalTokens: 8 }, month: { totalTokens: 8 }, allTime: { totalTokens: 8 } }
  });
  assert.equal(replaced.minimaxCodePeriods.today.totalTokens, 8);
  assert.equal(anchor.minimaxCodePeriods.today.totalTokens, 5);
});

test('history replacement overwrites every date, including liveDays, and survives a reread', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimaxcode-history-'));
  const archivePath = path.join(dir, 'daily-history-archive.json');
  const observation = (tokens) => ({
    client: 'minimaxcode',
    modelId: 'model-a',
    tokens,
    cost: 1,
    messages: 1,
    tokenComponentsAvailable: true,
    outputTokens: tokens
  });
  fs.writeFileSync(archivePath, JSON.stringify({
    version: 1,
    days: {
      '2026-09-01': { date: '2026-09-01', activeTimeMs: 0, observations: { old: observation(100) } },
      '2026-09-02': {
        date: '2026-09-02',
        activeTimeMs: 0,
        observations: {
          mini: observation(100),
          claude: { client: 'claude', modelId: 'opus', tokens: 10, cost: 1, messages: 1, tokenComponentsAvailable: true, outputTokens: 10 }
        }
      }
    },
    liveDays: {
      '2026-09-01': { date: '2026-09-01', activeTimeMs: 0, observations: { old: observation(100) } },
      '2026-09-02': { date: '2026-09-02', activeTimeMs: 0, observations: { mini: observation(100) } }
    }
  }));
  const graph = buildMiniMaxCodeHistoryGraph({
    rows: [{
      sessionId: 's',
      model: 'model-a',
      createdAt: new Date('2026-09-02T08:00:00').getTime(),
      input: 0,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0
    }]
  });
  const replaced = replaceClientDailyHistory('minimaxcode', graph, { path: archivePath });
  assert.equal(replaced.days['2026-09-02'].observations[
    Object.keys(replaced.days['2026-09-02'].observations).find((key) => key.includes('minimaxcode'))
  ].tokens, 40);
  assert.ok(Object.values(replaced.days['2026-09-02'].observations).some((entry) => entry.client === 'claude' && entry.tokens === 10));
  assert.equal(replaced.days['2026-09-01'], undefined);
  assert.equal(replaced.liveDays['2026-09-01'], undefined);
  const reread = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  const rendered = graphFromDailyHistoryArchive([], reread, { todayKey: '2026-09-02' });
  const day = rendered.contributions.find((entry) => entry.date === '2026-09-02');
  const mini = day.clients.find((entry) => entry.client === 'minimaxcode');
  assert.equal(mini.tokens.output, 40);
  assert.equal(rendered.contributions.some((entry) => entry.date === '2026-09-01'), false);
});

test('a read-only open does not rewrite the database file', () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimaxcode-db-'));
  const databasePath = path.join(dir, 'runtime-state.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE local_runtime_token_usage (
    session_id TEXT, turn_id TEXT, model TEXT, ts INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER
  )`);
  database.exec(`CREATE TABLE local_runtime_sessions (
    session_id TEXT, workspace_dir TEXT, extra_data_json TEXT
  )`);
  database.prepare('INSERT INTO local_runtime_sessions (session_id, workspace_dir, extra_data_json) VALUES (?, ?, ?)').run(
    's1', 'D:/work/app', JSON.stringify({ effectiveModel: 'MiniMax-M3' })
  );
  const insert = database.prepare(`INSERT INTO local_runtime_token_usage
    (session_id, turn_id, model, ts, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('s1', 't1', null, Date.now(), 3, 1, 0, 2, 0);
  insert.run('s1', 't2', 'named', Date.now(), 4, 1, 0, 0, 0);
  database.close();
  const before = fs.statSync(databasePath).mtimeMs;
  const read = readMiniMaxCodeDatabase(databasePath);
  const after = fs.statSync(databasePath).mtimeMs;
  assert.equal(read.ok, true);
  assert.equal(read.metadata, 'joined');
  assert.equal(read.rows.find((row) => row.turnId === 't1').model, 'MiniMax-M3');
  assert.equal(after, before);

  const limited = readMiniMaxCodeDatabase(databasePath, { maxRows: 1 });
  assert.equal(limited.ok, false);
  assert.equal(limited.reason, 'row-limit');
});

test('a usage table without the session table still returns tokens', () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimaxcode-usage-only-'));
  const databasePath = path.join(dir, 'runtime-state.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE local_runtime_token_usage (
    session_id TEXT, turn_id TEXT, model TEXT, ts INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER
  )`);
  database.prepare(`INSERT INTO local_runtime_token_usage
    (session_id, turn_id, model, ts, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens)
    VALUES ('s', 't', '', ?, 8, 0, 0, 0, 0)`).run(Date.now());
  database.close();
  const read = readMiniMaxCodeDatabase(databasePath);
  assert.equal(read.ok, true);
  assert.equal(read.metadata, 'usage-only');
  assert.equal(read.rows[0].model, 'unknown');
  assert.equal(read.rows[0].input, 8);
});

test('WSL keeps a failed home and does not double-count a linked path', async () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\alice';
  const db = `${home}\\.minimax\\v2\\sqlite\\runtime-state.sqlite`;
  const deps = {
    platform: 'win32',
    exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
    readdirSync: () => ['alice'],
    existsSync: (target) => target === db
  };
  let calls = 0;
  const { bundle, minimaxCodeByHome } = await collectWslUsage({
    clients: '',
    trackedClients: 'minimaxcode',
    allTimeSince: '2020-01-01',
    now: new Date('2026-09-27T12:00:00'),
    readMiniMaxCodeDatabase: () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          code: 'read-failed',
          sourcePath: 'same-db'
        };
      }
      return { ok: true, sourcePath: 'same-db', rows: [] };
    },
    minimaxCodeByHome: {
      'same-db': {
        sourcePath: 'same-db',
        todayKey: '2026-09-27',
        monthKey: '2026-09',
        allTimeSince: '2020-01-01',
        today: extractUsageFromTokscale({ entries: [{ client: 'minimaxcode', model: 'm', input: 6, totalTokens: 6 }] }),
        month: extractUsageFromTokscale({ entries: [{ client: 'minimaxcode', model: 'm', input: 6, totalTokens: 6 }] }),
        allTime: extractUsageFromTokscale({ entries: [{ client: 'minimaxcode', model: 'm', input: 6, totalTokens: 6 }] })
      }
    }
  }, deps);
  assert.equal(calls, 1);
  assert.equal(bundle.allTime.clients.minimaxcode, 6);
  assert.ok(minimaxCodeByHome['same-db']);
});

test('collectUsageOnce merges MiniMax beside the delta base and does not ask tokscale', async () => {
  const usage = require('../../src/shared/providers/minimaxcode/usage');
  const original = usage.readMiniMaxCodeSnapshot;
  usage.readMiniMaxCodeSnapshot = () => ({
    ok: true,
    sourcePath: 'db-a',
    rows: [{
      sessionId: 's',
      model: 'model-a',
      createdAt: Date.now(),
      input: 5,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0
    }]
  });
  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];
  try {
    const { collectUsageOnce } = require(collectorPath);
    let captured;
    const summary = await collectUsageOnce({
      clients: 'minimaxcode',
      allTimeSince: '2020-01-01',
      deviceId: 'd',
      agentVersion: 't',
      wslScanEnabled: false,
      historyEnabled: false,
      dailyHistoryArchiveEnabled: false,
      lookupModelPricing: async () => ({
        pricing: {
          inputCostPerToken: 1,
          outputCostPerToken: 0,
          cacheReadInputTokenCost: 0,
          cacheCreationInputTokenCost: 0
        }
      }),
      runTokscale: async () => { throw new Error('tokscale should not run'); },
      onAnchorComputed: (value) => { captured = value; }
    });
    assert.equal(summary.allTime.clients.minimaxcode, 5);
    assert.equal(summary.allTime.costUsd, 5);
    assert.equal(captured.windowsPeriods.allTime.clients?.minimaxcode, undefined);
    assert.equal(Object.hasOwn(captured.todayPartitions || {}, 'minimaxcode'), false);
    assert.equal(captured.minimaxCode.ok, true);
    assert.equal(summary.clientHealth.clients.minimaxcode.collection.state, 'direct');
  } finally {
    usage.readMiniMaxCodeSnapshot = original;
    delete require.cache[collectorPath];
  }
});

test('a failed read keeps same-day totals and reports attention', async () => {
  const usage = require('../../src/shared/providers/minimaxcode/usage');
  const original = usage.readMiniMaxCodeSnapshot;
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const monthKey = todayKey.slice(0, 7);
  usage.readMiniMaxCodeSnapshot = () => ({ ok: false, code: 'read-failed', sourcePath: 'db-a' });
  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];
  try {
    const { collectUsageOnce } = require(collectorPath);
    const storedPeriod = extractUsageFromTokscale({
      entries: [{ client: 'minimaxcode', model: 'model-a', input: 9, totalTokens: 9 }]
    });
    const summary = await collectUsageOnce({
      clients: 'minimaxcode',
      allTimeSince: '2020-01-01',
      now,
      deviceId: 'd',
      agentVersion: 't',
      wslScanEnabled: false,
      historyEnabled: false,
      dailyHistoryArchiveEnabled: false,
      minimaxCodePeriods: {
        sourcePath: 'db-a',
        todayKey,
        monthKey,
        allTimeSince: '2020-01-01',
        today: storedPeriod,
        month: storedPeriod,
        allTime: storedPeriod
      },
      runTokscale: async () => { throw new Error('tokscale should not run'); }
    });
    assert.equal(summary.today.clients.minimaxcode, 9);
    assert.equal(summary.clientHealth.clients.minimaxcode.overall, 'attention');
    assert.equal(summary.clientHealth.clients.minimaxcode.diagnostics.some((item) => item.code === 'local-read-failed'), true);
  } finally {
    usage.readMiniMaxCodeSnapshot = original;
    delete require.cache[collectorPath];
  }
});

test('a failed local read is attention, not waiting', () => {
  const health = deriveClientHealth('minimaxcode', { clients: { minimaxcode: 12 } }, {
    sourceChecks: { minimaxcode: [{ id: 'minimaxcode-db', exists: true }] },
    localReadFailures: new Set(['minimaxcode'])
  });
  assert.equal(health.clients.minimaxcode.collection.state, 'failed');
  assert.equal(health.clients.minimaxcode.overall, 'attention');
  assert.equal(health.clients.minimaxcode.diagnostics[0].code, 'local-read-failed');
});
