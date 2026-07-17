'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CLIENT_ID,
  normalizeUsageRow,
  dedupeUsageRows,
  collectMinimaxRows,
  buildTokscaleJson,
  buildMinimaxPeriods,
  buildMinimaxHistoryGraph,
  resolveMinimaxHome,
  legacyDbPath,
  runtimeDbPath
} = require('../../src/shared/minimaxUsage');
const { extractUsageFromTokscale, mergePeriods } = require('../../src/shared/usage');
const { LOCALLY_PARSED_CLIENTS } = require('../../src/shared/collector');

// Local wall-clock helpers so period windows are timezone-stable across CI hosts.
function localMs(year, monthIndex, day, hour = 12, minute = 0) {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).getTime();
}

function row({
  sessionId = 'mvs_test',
  turnId = '',
  model = 'minimax/MiniMax-M3',
  ts = localMs(2026, 6, 9, 12, 0),
  input = 0,
  output = 0,
  reasoning = 0,
  cacheRead = 0,
  cacheWrite = 0,
  cost = 0,
  source = 'legacy'
} = {}) {
  return normalizeUsageRow({
    session_id: sessionId,
    turn_id: turnId,
    model,
    ts,
    input_tokens: input,
    output_tokens: output,
    reasoning_tokens: reasoning,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cost_usd: cost,
    _source: source
  });
}

test('normalizeUsageRow maps MiniMax token_usage columns and ignores reasoning in total', () => {
  const normalized = normalizeUsageRow({
    id: 42,
    session_id: 'mvs_1',
    turn_id: 'turn-a',
    model: 'minimax/MiniMax-M3',
    ts: 1784033553109,
    input_tokens: 100,
    output_tokens: 20,
    reasoning_tokens: 5,
    cache_read_tokens: 50,
    cache_write_tokens: 10,
    cost_usd: 0.01,
    _source: 'runtime'
  });
  assert.equal(normalized.sessionId, 'mvs_1');
  assert.equal(normalized.turnId, 'turn-a');
  assert.equal(normalized.input, 100);
  assert.equal(normalized.output, 20);
  assert.equal(normalized.reasoning, 5);
  assert.equal(normalized.cacheRead, 50);
  assert.equal(normalized.cacheWrite, 10);
  assert.equal(normalized.total, 180); // 100+20+50+10 — reasoning not added
  // row identity is per-step (id), never turn_id alone
  assert.equal(normalized.rowKey, 'runtime:id:42');
  assert.equal(normalized.dedupeKey, normalized.rowKey);
  // Least privilege: agent/framework never retained on the row object
  assert.equal(normalized.agentName, undefined);
  assert.equal(normalized.frameworkType, undefined);
});

test('dedupeUsageRows drops runtime turn_id already present in legacy (legacy wins)', () => {
  const legacy = row({ turnId: 'shared-turn', input: 100, output: 10, source: 'legacy' });
  const runtime = row({ turnId: 'shared-turn', input: 100, output: 10, source: 'runtime', ts: localMs(2026, 6, 9, 12, 1) });
  const onlyRuntime = row({ turnId: 'runtime-only', input: 40, output: 2, source: 'runtime' });
  const deduped = dedupeUsageRows([legacy, runtime, onlyRuntime]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].source, 'legacy');
  assert.equal(deduped[1].turnId, 'runtime-only');
  const total = deduped.reduce((sum, r) => sum + r.total, 0);
  assert.equal(total, 110 + 42);
});

test('same-store multi-step same turn_id must SUM (live runtime shape)', () => {
  // Live local_runtime_token_usage: one turn_id owns many model-call rows with
  // different id/ts/token totals. Collapsing to first-wins undercounts ~10M tokens.
  const turnId = 'turn_task_bg_example';
  const steps = [
    row({ turnId, input: 18401, output: 398, cacheRead: 242, source: 'runtime', ts: localMs(2026, 6, 9, 12, 0) }),
    row({ turnId, input: 198, output: 42, cacheRead: 19027, source: 'runtime', ts: localMs(2026, 6, 9, 12, 1) }),
    row({ turnId, input: 123, output: 37, cacheRead: 19253, source: 'runtime', ts: localMs(2026, 6, 9, 12, 2) })
  ];
  // Distinct step totals: 19041 + 19267 + 19413 = 57721
  const expected = steps.reduce((sum, r) => sum + r.total, 0);
  assert.equal(expected, 57721);
  const deduped = dedupeUsageRows(steps);
  assert.equal(deduped.length, 3, 'all multi-step rows must survive');
  assert.equal(deduped.reduce((sum, r) => sum + r.total, 0), expected);

  const usage = extractUsageFromTokscale(buildTokscaleJson({}, { rows: steps }));
  assert.equal(usage.clients.minimax, expected);
  assert.equal(usage.totalTokens, expected);
});

test('legacy multi-step same turn_id also sums; runtime clones of that turn are dropped', () => {
  const turnId = 'turn-migrated';
  const legacySteps = [
    row({ turnId, input: 50, output: 5, source: 'legacy', ts: localMs(2026, 6, 9, 10, 0) }),
    row({ turnId, input: 20, output: 3, source: 'legacy', ts: localMs(2026, 6, 9, 10, 1) })
  ];
  const runtimeCloneSteps = [
    row({ turnId, input: 50, output: 5, source: 'runtime', ts: localMs(2026, 6, 9, 10, 0) }),
    row({ turnId, input: 20, output: 3, source: 'runtime', ts: localMs(2026, 6, 9, 10, 1) }),
    row({ turnId, input: 999, output: 1, source: 'runtime', ts: localMs(2026, 6, 9, 10, 2) })
  ];
  const usage = extractUsageFromTokscale(buildTokscaleJson({}, {
    rows: [...legacySteps, ...runtimeCloneSteps]
  }));
  // Only legacy steps: 55 + 23 = 78 — not runtime's extra 1000
  assert.equal(usage.clients.minimax, 78);
});

test('dedupeUsageRows collapses only exact row clones when turn_id is empty', () => {
  const a = row({ turnId: '', sessionId: 's1', ts: 1000, input: 10, output: 1, source: 'runtime' });
  const b = row({ turnId: '', sessionId: 's1', ts: 1000, input: 10, output: 1, source: 'runtime' });
  const c = row({ turnId: '', sessionId: 's1', ts: 1000, input: 11, output: 1, source: 'runtime' });
  assert.equal(dedupeUsageRows([a, b, c]).length, 2);
});

test('empty / missing home yields empty usage without throw', () => {
  const missing = path.join(os.tmpdir(), `minimax-missing-${Date.now()}`);
  const rows = collectMinimaxRows({ homeDir: missing });
  assert.deepEqual(rows, []);
  const periods = buildMinimaxPeriods({ homeDir: missing, now: '2026-07-09T12:00:00.000Z' });
  const usage = extractUsageFromTokscale(periods.allTime);
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.clients.minimax, undefined);
});

test('single-store multi-model rows aggregate under client minimax', () => {
  const rows = [
    row({ sessionId: 's1', turnId: 't1', model: 'minimax/MiniMax-M3', input: 100, output: 20, cacheRead: 30, ts: localMs(2026, 6, 9, 10, 0) }),
    row({ sessionId: 's1', turnId: 't2', model: 'minimax/MiniMax-M2.7', input: 40, output: 5, ts: localMs(2026, 6, 9, 11, 0) }),
    row({ sessionId: 's2', turnId: 't3', model: 'minimax/MiniMax-M3', input: 10, output: 1, ts: localMs(2026, 6, 8, 10, 0) })
  ];
  const periods = buildMinimaxPeriods({
    now: new Date(2026, 6, 9, 13, 0, 0, 0),
    allTimeSince: '2026-01-01',
    rows
  });
  const today = extractUsageFromTokscale(periods.today);
  const allTime = extractUsageFromTokscale(periods.allTime);

  // today: 100+20+30 + 40+5 = 195
  assert.equal(today.clients.minimax, 195);
  assert.equal(today.totalTokens, 195);
  assert.ok(Object.keys(today.models).some((k) => k.toLowerCase().includes('m3')));
  // allTime includes yesterday's 11
  assert.equal(allTime.clients.minimax, 206);
  assert.equal(CLIENT_ID, 'minimax');
  for (const entry of periods.today.entries) {
    assert.equal(entry.client, 'minimax');
  }
});

test('dual-store fixture with shared turn does not double-count through shipped aggregation', () => {
  const sharedTurn = 'turn-shared-1';
  const rows = [
    row({ turnId: sharedTurn, input: 80, output: 20, cacheRead: 100, source: 'legacy', ts: localMs(2026, 6, 9, 12, 0) }),
    // runtime multi-step for the same turn_id must be fully dropped (legacy wins)
    row({ turnId: sharedTurn, input: 80, output: 20, cacheRead: 100, source: 'runtime', ts: localMs(2026, 6, 9, 12, 0) }),
    row({ turnId: sharedTurn, input: 1, output: 1, source: 'runtime', ts: localMs(2026, 6, 9, 12, 1) }),
    row({ turnId: 'turn-runtime-only', input: 15, output: 5, source: 'runtime', ts: localMs(2026, 6, 9, 12, 30) })
  ];
  const periods = buildMinimaxPeriods({ now: new Date(2026, 6, 9, 18, 0, 0, 0), allTimeSince: '2026-01-01', rows });
  const usage = extractUsageFromTokscale(periods.today);
  // shared legacy once (200) + runtime-only (20) = 220 — not 422
  assert.equal(usage.clients.minimax, 220);
  assert.equal(usage.totalTokens, 220);
});

test('period windows filter by local day boundaries using injected now', () => {
  const rows = [
    row({ turnId: 'old', ts: localMs(2026, 6, 8, 23, 0), input: 100 }),
    row({ turnId: 'new', ts: localMs(2026, 6, 9, 1, 0), input: 40, output: 2 })
  ];
  const periods = buildMinimaxPeriods({ now: new Date(2026, 6, 9, 12, 0, 0, 0), allTimeSince: '2026-01-01', rows });
  const today = extractUsageFromTokscale(periods.today);
  const month = extractUsageFromTokscale(periods.month);
  assert.equal(today.clients.minimax, 42);
  assert.equal(month.clients.minimax, 142);
});

test('history graph attributes days to minimax client id', () => {
  const graph = buildMinimaxHistoryGraph({
    rows: [
      row({ turnId: 'a', ts: localMs(2026, 6, 9, 10, 0), input: 10, output: 1 }),
      row({ turnId: 'b', ts: localMs(2026, 6, 9, 11, 0), input: 5, output: 2 })
    ]
  });
  assert.ok(graph.contributions.length >= 1);
  for (const day of graph.contributions) {
    for (const c of day.clients) {
      assert.equal(c.client, 'minimax');
    }
  }
});

test('resolveMinimaxHome respects MINIMAX_HOME then MAVIS_HOME then default', () => {
  const custom = path.join(os.tmpdir(), 'custom-minimax-home');
  assert.equal(resolveMinimaxHome({ env: { MINIMAX_HOME: custom } }), path.resolve(custom));
  assert.equal(resolveMinimaxHome({ env: { MAVIS_HOME: custom, HOME: '/tmp/x' } }), path.resolve(custom));
  const def = resolveMinimaxHome({ env: { HOME: '/tmp/userhome', USERPROFILE: '' } });
  assert.equal(def, path.join('/tmp/userhome', '.minimax'));
  assert.equal(legacyDbPath(custom), path.join(custom, 'sqlite.db'));
  assert.equal(runtimeDbPath(custom), path.join(custom, 'v2', 'sqlite', 'runtime-state.sqlite'));
});

test('minimax is a locally-parsed client (excluded from tokscale CSV path)', () => {
  assert.ok(LOCALLY_PARSED_CLIENTS.has('minimax'));
  assert.ok(LOCALLY_PARSED_CLIENTS.has('proma'));
});

test('minimax client id is never confused with opencode in shipped extraction', () => {
  const minimaxJson = buildTokscaleJson({}, { rows: [row({ turnId: 'm1', input: 10 })] });
  assert.equal(minimaxJson.entries[0].client, 'minimax');
  const usage = extractUsageFromTokscale(minimaxJson);
  assert.equal(usage.clients.minimax, 10);
  assert.equal(usage.clients.opencode, undefined);
});

test('mergePeriods keeps minimax separate from opencode', () => {
  const minimaxPeriod = extractUsageFromTokscale(buildTokscaleJson({}, {
    rows: [row({ turnId: 'm1', input: 50, output: 5 })]
  }));
  const opencodePeriod = {
    totalTokens: 30,
    costUsd: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    clients: { opencode: 30 },
    clientCosts: {},
    clientCacheReads: {},
    clientCacheWrites: {},
    clientOutputs: {},
    models: {},
    modelCosts: {},
    modelCacheReads: {},
    modelCacheWrites: {},
    modelOutputs: {},
    clientModels: {},
    clientModelCosts: {},
    projects: Object.create(null),
    sessions: {}
  };
  const merged = mergePeriods(opencodePeriod, minimaxPeriod);
  assert.equal(merged.clients.opencode, 30);
  assert.equal(merged.clients.minimax, 55);
  assert.equal(merged.totalTokens, 85);
});

test('real-shaped sqlite fixture path is readable by collectMinimaxRows when present', () => {
  // Build a tiny on-disk dual-store fixture and drive the real SQLite path.
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_) {
    return; // skip if node:sqlite unavailable
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-fixture-'));
  const legacyPath = legacyDbPath(root);
  const runtimePath = runtimeDbPath(root);
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });

  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`CREATE TABLE token_usage (
    id INTEGER PRIMARY KEY, session_id TEXT, agent_name TEXT, framework_type TEXT,
    turn_id TEXT, model TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL, raw TEXT
  )`);
  legacy.prepare(`INSERT INTO token_usage
    (session_id, agent_name, framework_type, turn_id, model, ts, input_tokens, output_tokens,
     reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'mvs_a', 'mavis', 'opencode', 'turn-shared', 'minimax/MiniMax-M3',
    localMs(2026, 6, 9, 12, 0), 100, 10, 0, 20, 0, 0.01
  );
  legacy.close();

  const runtime = new DatabaseSync(runtimePath);
  runtime.exec(`CREATE TABLE local_runtime_token_usage (
    id INTEGER PRIMARY KEY, session_id TEXT, agent_name TEXT, framework_type TEXT,
    turn_id TEXT, model TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL, raw TEXT
  )`);
  // Same turn_id as legacy — entire runtime turn must drop (even multi-step).
  runtime.prepare(`INSERT INTO local_runtime_token_usage
    (session_id, agent_name, framework_type, turn_id, model, ts, input_tokens, output_tokens,
     reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'mvs_a', 'mavis', 'pi-agent', 'turn-shared', 'minimax/MiniMax-M3',
    localMs(2026, 6, 9, 12, 0), 100, 10, 0, 20, 0, 0.01
  );
  runtime.prepare(`INSERT INTO local_runtime_token_usage
    (session_id, agent_name, framework_type, turn_id, model, ts, input_tokens, output_tokens,
     reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'mvs_a', 'mavis', 'pi-agent', 'turn-shared', 'minimax/MiniMax-M3',
    localMs(2026, 6, 9, 12, 1), 50, 5, 0, 0, 0, 0
  );
  // Runtime-only turn with TWO steps that must both count.
  runtime.prepare(`INSERT INTO local_runtime_token_usage
    (session_id, agent_name, framework_type, turn_id, model, ts, input_tokens, output_tokens,
     reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'mvs_b', 'coder', 'pi-agent', 'turn-only-runtime', 'minimax/MiniMax-M3',
    localMs(2026, 6, 9, 13, 0), 30, 5, 0, 0, 0, 0
  );
  runtime.prepare(`INSERT INTO local_runtime_token_usage
    (session_id, agent_name, framework_type, turn_id, model, ts, input_tokens, output_tokens,
     reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'mvs_b', 'coder', 'pi-agent', 'turn-only-runtime', 'minimax/MiniMax-M3',
    localMs(2026, 6, 9, 13, 1), 10, 2, 0, 0, 0, 0
  );
  runtime.close();

  const periods = buildMinimaxPeriods({
    homeDir: root,
    now: new Date(2026, 6, 9, 18, 0, 0, 0),
    allTimeSince: '2026-01-01'
  });
  const usage = extractUsageFromTokscale(periods.today);
  // legacy shared 130 + runtime-only steps 35+12 = 177
  assert.equal(usage.clients.minimax, 177);
  assert.equal(usage.totalTokens, 177);

  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
});
