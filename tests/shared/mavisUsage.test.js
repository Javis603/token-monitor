'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAVIS_AGENT_NAMES,
  MAVIS_CLIENT_ID,
  MAVIS_PRICING,
  MAVIS_CONTEXT_TIER_THRESHOLD,
  MAVIS_DEFAULT_CNY_TO_USD_RATE,
  buildMavisHistoryGraph,
  buildMavisPeriods,
  buildTokscaleJson,
  buildHistoryGraphFromRows,
  normalizedModelId,
  normalizeDbRow,
  applyPriceFallback
} = require('../../src/shared/providers/mavis/usage');

const { localDate, localMs } = require('../helpers/localTime');

// Mirror mavis-usage.js' localDateKey: build the YYYY-MM-DD string from
// the *local* calendar parts, not from `toISOString()` (which would
// report the UTC date and be off by one in negative-offset zones).
function localDayKey(year, month, day) {
  const d = localDate(year, month, day);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function row(overrides) {
  return Object.assign({
    sessionId: 'mvs_test',
    agentName: 'mavis',
    model: 'minimax/MiniMax-M3',
    input: 100,
    output: 50,
    reasoning: 10,
    cacheRead: 1000,
    cacheWrite: 0,
    cost: 0.001,
    messages: 1,
    createdAt: localMs(2026, 9, 13, 10, 0, 0)
  }, overrides);
}

test('MAVIS_AGENT_NAMES covers every mavis runtime agent role', () => {
  for (const agent of ['mavis', 'coder', 'explore', 'general', 'verifier', 'worker']) {
    assert.ok(MAVIS_AGENT_NAMES.includes(agent), `${agent} must be tracked`);
  }
});

test('normalizedModelId passes non-empty model strings through unchanged', () => {
  assert.equal(normalizedModelId('minimax/MiniMax-M3'), 'minimax/MiniMax-M3');
  assert.equal(normalizedModelId('  spaced  '), 'spaced');
});

test('normalizedModelId falls back to `${agent} (model unknown)` when the column is null', () => {
  assert.equal(normalizedModelId(null, 'mavis'), 'mavis (model unknown)');
  assert.equal(normalizedModelId('', 'coder'), 'coder (model unknown)');
  assert.equal(normalizedModelId(undefined, 'explore'), 'explore (model unknown)');
});

test('normalizedModelId only falls back to `unknown` when both columns are empty', () => {
  assert.equal(normalizedModelId(null, null), 'unknown');
  assert.equal(normalizedModelId('', ''), 'unknown');
});

test('normalizeDbRow coerces a SQLite row to the internal row shape', () => {
  const out = normalizeDbRow({
    ts: 1_789_231_485_236,
    session_id: 'mvs_abc',
    agent_name: 'mavis',
    model: 'minimax/MiniMax-M3',
    input_tokens: 90,
    output_tokens: 518,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0
  });
  assert.equal(out.sessionId, 'mvs_abc');
  assert.equal(out.model, 'minimax/MiniMax-M3');
  assert.equal(out.input, 90);
  assert.equal(out.output, 518);
  assert.equal(out.createdAt, 1_789_231_485_236);
  assert.equal(out.cost, 0);
});

test('normalizeDbRow fills in the model fallback when the runtime leaves it NULL', () => {
  const out = normalizeDbRow({
    ts: localMs(2026, 9, 13, 9, 0, 0),
    session_id: 'mvs_no_model',
    agent_name: 'coder',
    model: null,
    input_tokens: 5,
    output_tokens: 1,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0
  });
  assert.equal(out.model, 'coder (model unknown)');
});

test('normalizeDbRow rejects rows without a session id', () => {
  assert.equal(normalizeDbRow({ ts: 1, agent_name: 'mavis', input_tokens: 1, output_tokens: 1 }), null);
  assert.equal(normalizeDbRow({ ts: 1, session_id: '   ', agent_name: 'mavis', input_tokens: 1, output_tokens: 1 }), null);
});

test('buildHistoryGraphFromRows splits a cross-midnight session into two daily buckets', () => {
  // Session runs 23:50:00 -> 00:10:00 local time. Each turn carries its own
  // createdAt so the day boundary lands the two halves in the right buckets
  // instead of merging everything into the day the last turn landed on.
  const rows = [
    row({ sessionId: 'mvs_x', createdAt: localMs(2026, 9, 12, 23, 50, 0), input: 100, output: 10 }),
    row({ sessionId: 'mvs_x', createdAt: localMs(2026, 9, 13, 0, 10, 0), input: 200, output: 20 })
  ];
  const graph = buildHistoryGraphFromRows(rows);
  assert.equal(graph.contributions.length, 2, 'cross-midnight session must produce 2 daily buckets');
  const day12 = graph.contributions.find((d) => d.date === localDayKey(2026, 9, 12));
  const day13 = graph.contributions.find((d) => d.date === localDayKey(2026, 9, 13));
  assert.ok(day12 && day13, 'both days must be present');
  assert.equal(day12.clients[0].tokens.input, 100);
  assert.equal(day13.clients[0].tokens.input, 200);
});

test('buildHistoryGraphFromRows treats each model on the same day as its own bucket', () => {
  const rows = [
    row({ model: 'minimax/MiniMax-M3', input: 10, createdAt: localMs(2026, 9, 13, 8, 0, 0) }),
    row({ model: 'coder (model unknown)', agentName: 'coder', input: 5, createdAt: localMs(2026, 9, 13, 8, 5, 0) })
  ];
  const graph = buildHistoryGraphFromRows(rows);
  assert.equal(graph.contributions.length, 1);
  assert.equal(graph.contributions[0].clients.length, 2);
  const models = graph.contributions[0].clients.map((c) => c.modelId).sort();
  assert.deepEqual(models, ['coder (model unknown)', 'minimax/MiniMax-M3']);
});

test('buildHistoryGraphFromRows drops rows without a usable timestamp', () => {
  const rows = [
    row({ createdAt: 0 }),
    row({ createdAt: localMs(2026, 9, 13, 8, 0, 0) })
  ];
  const graph = buildHistoryGraphFromRows(rows);
  assert.equal(graph.contributions.length, 1);
  assert.equal(graph.contributions[0].tokens && graph.contributions[0].tokens.input, undefined, 'graph is keyed by clients, not top-level');
  assert.equal(graph.contributions[0].clients[0].tokens.input, 100);
});

test('buildMavisHistoryGraph sorts contributions by date ascending', async () => {
  const rows = [
    row({ createdAt: localMs(2026, 9, 12, 23, 0, 0) }),
    row({ createdAt: localMs(2026, 9, 13, 0, 30, 0) }),
    row({ createdAt: localMs(2026, 9, 10, 12, 0, 0) })
  ];
  const graph = await buildMavisHistoryGraph({ rows });
  const dates = graph.contributions.map((d) => d.date);
  for (let i = 1; i < dates.length; i += 1) {
    assert.ok(dates[i] >= dates[i - 1], `contributions must be sorted: ${dates.join(', ')}`);
  }
});

test('buildTokscaleJson respects the windowStartMs and merges same-session same-model rows', async () => {
  const todayStart = localMs(2026, 9, 13);
  const rows = [
    row({ createdAt: localMs(2026, 9, 13, 8, 0, 0), input: 100, output: 10 }),
    row({ createdAt: localMs(2026, 9, 13, 8, 5, 0), input: 50, output: 5 }),
    row({ createdAt: localMs(2026, 9, 12, 23, 59, 0), input: 9999, output: 9999 })
  ];
  const json = await buildTokscaleJson(todayStart, { rows });
  assert.equal(json.totalInput, 150, 'only today rows count');
  assert.equal(json.totalOutput, 15);
  assert.equal(json.entries.length, 1, 'same session + same model collapses into one entry');
  assert.equal(json.entries[0].client, MAVIS_CLIENT_ID);
  assert.equal(json.entries[0].input, 150);
  assert.equal(json.entries[0].messageCount, 2);
});

test('buildTokscaleJson keeps undated rows when includeUndated is true (allTime path)', async () => {
  const rows = [
    row({ createdAt: 0, input: 7, output: 3 })
  ];
  const json = await buildTokscaleJson(Date.now() + 60_000, { rows, includeUndated: true });
  assert.equal(json.totalInput, 7);
  assert.equal(json.entries.length, 1);
});

test('buildMavisPeriods keeps local midnight for today and the 1st of the month for month', async () => {
  const now = new Date(2026, 8, 15, 10, 30, 0); // 2026-09-15 10:30 local
  const rows = [
    row({ createdAt: localMs(2026, 9, 14, 23, 59, 59), input: 1, output: 1 }),
    row({ createdAt: localMs(2026, 9, 15, 0, 0, 1), input: 2, output: 2 }),
    row({ createdAt: localMs(2026, 8, 31, 23, 59, 59), input: 4, output: 4 }), // August 31, NOT in month
    row({ createdAt: localMs(2026, 7, 1, 0, 0, 0), input: 8, output: 8 })        // July, NOT in month/allTime(allTimeSince=2026-08-01)
  ];
  const periods = await buildMavisPeriods({
    now: now.toISOString(),
    allTimeSince: '2026-08-01',
    rows
  });
  assert.equal(periods.today.totalInput, 2, 'only 2026-09-15 00:00:01 onward');
  assert.equal(periods.month.totalInput, 1 + 2, 'both today rows + Aug are excluded; 9-14 23:59 is before month start');
  assert.equal(periods.allTime.totalInput, 1 + 2 + 4, 'allTime respects allTimeSince=2026-08-01; 7-1 is excluded');
  assert.equal(periods.allTime.entries.length, 1, 'cross-day turns merge under one session+model entry');
});

test('MAVIS_PRICING carries the public mavis MiniMax-M3 rates', () => {
  // Public mavis listing for MiniMax-M3, standard tier, "永久五折"
  // (permanent 50% off). The tier split is 512k input tokens; rates are
  // in CNY per 1M tokens. The exported shape is the contract the tests
  // pin against so any future price change has to land here too.
  assert.deepEqual(MAVIS_PRICING['minimax/MiniMax-M3'], {
    input: { upTo512k: 2.10, over512k: 4.20 },
    output: { upTo512k: 8.40, over512k: 16.80 },
    cacheRead: { upTo512k: 0.42, over512k: 0.84 }
  });
  assert.equal(MAVIS_CONTEXT_TIER_THRESHOLD, 512 * 1024);
  assert.equal(typeof MAVIS_DEFAULT_CNY_TO_USD_RATE, 'number');
});

test('applyPriceFallback leaves runtime-supplied cost alone', () => {
  const out = applyPriceFallback({
    model: 'minimax/MiniMax-M3',
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 0,
    reasoning: 0,
    cost: 0.5 // runtime wrote a real cost
  });
  assert.equal(out.cost, 0.5, 'cost > 0 must pass through untouched');
});

test('applyPriceFallback recovers cost for zero-cost rows using the public MiniMax-M3 rates', () => {
  // 100k input + 50k output + 0 cacheRead, ≤ 512k tier: 0.1*2.10 + 0.05*8.40 = 0.63 CNY,
  // divided by the default 7 CNY/USD rate ≈ 0.09 USD.
  const out = applyPriceFallback({
    model: 'minimax/MiniMax-M3',
    input: 100_000,
    output: 50_000,
    cacheRead: 0,
    reasoning: 0,
    cost: 0
  });
  const expectedCny = 0.1 * 2.10 + 0.05 * 8.40;
  const expectedUsd = expectedCny / 7;
  assert.ok(Math.abs(out.cost - expectedUsd) < 1e-9, `expected ≈ ${expectedUsd} got ${out.cost}`);
});

test('applyPriceFallback picks the over-512k tier when input crosses the threshold', () => {
  // input=600k + cacheRead=0: > 512k → input rate 4.20, output rate 16.80
  const out = applyPriceFallback({
    model: 'minimax/MiniMax-M3',
    input: 600_000,
    output: 200_000,
    cacheRead: 0,
    reasoning: 0,
    cost: 0
  });
  const expectedCny = 0.6 * 4.20 + 0.2 * 16.80;
  const expectedUsd = expectedCny / 7;
  assert.ok(Math.abs(out.cost - expectedUsd) < 1e-9, `expected ≈ ${expectedUsd} got ${out.cost}`);
});

test('applyPriceFallback bills reasoning tokens at the output rate', () => {
  // reasoning_tokens ride on output pricing per mavis's public listing.
  // 100k input (≤ 512k) + 1M output + 1M reasoning →
  // 0.1*2.10 + (1+1)*8.40 = 17.01 CNY / 7 ≈ 2.43 USD.
  const out = applyPriceFallback({
    model: 'minimax/MiniMax-M3',
    input: 100_000,
    output: 1_000_000,
    cacheRead: 0,
    reasoning: 1_000_000,
    cost: 0
  });
  const expectedCny = 0.1 * 2.10 + 2 * 8.40;
  const expectedUsd = expectedCny / 7;
  assert.ok(Math.abs(out.cost - expectedUsd) < 1e-9, `expected ≈ ${expectedUsd} got ${out.cost}`);
});

test('applyPriceFallback bills "X (model unknown)" rows at the M3 rate card', () => {
  // Mavis runtime currently leaves the model column NULL on ~90% of
  // rows. Token-monitor's `normalizedModelId` then fabricates a
  // placeholder like "mavis (model unknown)" so the breakdown view
  // still has something to render. The runtime only ships M3 today,
  // so the right answer is to bill these placeholder rows at the M3
  // rate card even though the display label is a placeholder — the
  // cost column is recovered, the model column stays honest.
  // 100k input (≤ 512k) + 50k output: 0.1*2.10 + 0.05*8.40 = 0.63 CNY / 7 ≈ 0.09 USD.
  const out = applyPriceFallback({
    model: 'mavis (model unknown)',
    input: 100_000,
    output: 50_000,
    cacheRead: 0,
    reasoning: 0,
    cost: 0
  });
  const expectedCny = 0.1 * 2.10 + 0.05 * 8.40;
  const expectedUsd = expectedCny / 7;
  assert.ok(Math.abs(out.cost - expectedUsd) < 1e-9, `expected ≈ ${expectedUsd} got ${out.cost}`);
});

test('applyPriceFallback returns the row unchanged when neither model nor M3 placeholder matches', () => {
  // A truly unknown model — e.g. a future mavis that ships a second
  // model whose placeholder doesn't end in "(model unknown)" — must
  // not be silently billed at M3.
  const out = applyPriceFallback({
    model: 'some-future-model',
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 0,
    reasoning: 0,
    cost: 0
  });
  assert.equal(out.cost, 0, 'non-placeholder, non-M3 models must stay at zero cost');
});

test('applyPriceFallback honours an injected rate table and CNY→USD rate', () => {
  // Tests + downstream hosts that want a different FX can pass both
  // through options; nothing in the row itself has to change.
  // 100k input at custom 100 CNY/1M → 10 CNY, cnyToUsdRate=1 → 10 USD.
  const customTable = {
    'minimax/MiniMax-M3': {
      input: { upTo512k: 100, over512k: 200 },
      output: { upTo512k: 400, over512k: 800 },
      cacheRead: { upTo512k: 0, over512k: 0 }
    }
  };
  const out = applyPriceFallback(
    { model: 'minimax/MiniMax-M3', input: 100_000, output: 0, cacheRead: 0, reasoning: 0, cost: 0 },
    { priceTable: customTable, cnyToUsdRate: 1 }
  );
  assert.equal(out.cost, 10);
});
