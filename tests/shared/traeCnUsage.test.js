'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  TRAE_CN_CLIENT_ID,
  TRAE_CN_ERROR_CODES,
  buildTraeCnHistoryGraph,
  buildTraeCnPeriods,
  collectTraeCnRows,
  fetchTraeCnSnapshot,
  normalizeTraeCnSession,
  resolveTraeCnPricing,
  resetTraeCnPricingCache,
  resetTraeCnSnapshotCache,
  traeCnAccessToken,
  traeCnDataPaths,
  traeCnUsageUrl
} = require('../../src/shared/traeCnUsage');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

const { localMs } = require('../helpers/localTime');

const TOKEN = 'test-trae-token';

// A minimal fetch double for the usage endpoint. `pages` is a list of page
// bodies in call order; every call is recorded so tests can assert on the
// request (page_num, page_size, headers) as well as the result.
function usageFetch(pages, calls = []) {
  return async (url, init) => {
    calls.push({ url, init: JSON.parse(init.body) });
    const body = pages[Math.min(calls.length - 1, pages.length - 1)];
    const status = typeof body === 'number' ? body : 200;
    const payload = typeof body === 'number' ? null : body;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => payload
    };
  };
}

function usageBody(sessions, total) {
  return { total, user_usage_group_by_sessions: sessions };
}

// One API session row: usage_time in epoch seconds, tokens in extra_info.
function apiSession(sessionId, model, input, output, usageTimeSec, extra = {}) {
  return {
    session_id: sessionId,
    model_name: model,
    usage_time: usageTimeSec,
    extra_info: {
      input_token: input,
      output_token: output,
      cache_read_token: extra.cacheRead ?? 0,
      cache_write_token: extra.cacheWrite ?? 0
    }
  };
}

// A fully normalized row, the shape buildTraeCnPeriods and the history graph
// consume — identical to the qodercn row shape.
function row(sessionId, model, input, output, createdAt, extra = {}) {
  return {
    sessionId: `trae-cn:api:${sessionId}`,
    messageId: `trae-cn:api:${sessionId}:${createdAt}:${model}`,
    model,
    projectLabel: '',
    input,
    output,
    cacheRead: extra.cacheRead ?? 0,
    cacheWrite: extra.cacheWrite ?? 0,
    createdAt,
    messages: 1
  };
}

// Every test that collects with a token resets the snapshot cache first: the
// cache is keyed by the token prefix and shared across the whole process.
function freshCollect(options) {
  resetTraeCnSnapshotCache();
  return collectTraeCnRows({ ...options, accessToken: TOKEN });
}

test('traeCnAccessToken accepts raw tokens, pasted headers, and quoted values', () => {
  assert.equal(traeCnAccessToken({ traeAccessToken: 'dt-abc' }), 'dt-abc');
  assert.equal(traeCnAccessToken({ traeAccessToken: 'Cloud-IDE-JWT dt-abc' }), 'dt-abc');
  assert.equal(traeCnAccessToken({ traeAccessToken: 'authorization: Cloud-IDE-JWT dt-abc' }), 'dt-abc');
  assert.equal(traeCnAccessToken({ traeAccessToken: '"dt-abc"' }), 'dt-abc');
  // A newline is how a secret leaks into a settings file; it must not pass through.
  assert.equal(traeCnAccessToken({ traeAccessToken: 'dt-abc\ndt-evil' }), '');
});

test('traeCnAccessToken falls back to the documented env variables', () => {
  const env = { TOKEN_MONITOR_TRAE_ACCESS_TOKEN: 'env-token' };
  assert.equal(traeCnAccessToken({}, env), 'env-token');
  assert.equal(traeCnAccessToken({ traeAccessToken: 'explicit' }, env), 'explicit');
  assert.equal(traeCnAccessToken({}, { TRAE_ACCESS_TOKEN: 'other-env' }), 'other-env');
});

test('normalizeTraeCnSession maps epoch seconds and defaults like the API shape', () => {
  const usageTimeSec = 1_785_286_800;
  assert.deepEqual(
    normalizeTraeCnSession(apiSession('s1', 'doubao-seed', 100, 20, usageTimeSec, { cacheRead: 5, cacheWrite: 2 })),
    {
      sessionId: 'trae-cn:api:s1',
      messageId: `trae-cn:api:s1:${usageTimeSec * 1000}:doubao-seed`,
      model: 'doubao-seed',
      projectLabel: '',
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 2,
      createdAt: usageTimeSec * 1000,
      messages: 1
    }
  );
  // Millisecond timestamps pass through unscaled; missing ids get safe defaults.
  const ms = normalizeTraeCnSession({ usage_time: 1_785_286_800_000, extra_info: { input_token: 1, output_token: 1 } });
  assert.equal(ms.createdAt, 1_785_286_800_000);
  assert.equal(ms.sessionId, 'trae-cn:api:unknown');
  assert.equal(ms.model, 'trae-agent');
  assert.equal(ms.cacheRead, 0, 'absent cache fields default to zero');
});

test('normalizeTraeCnSession rejects rows without usable token counts', () => {
  assert.equal(normalizeTraeCnSession(null), null);
  assert.equal(normalizeTraeCnSession({ extra_info: {} }), null);
  assert.equal(normalizeTraeCnSession(apiSession('s', 'm', 0, 0, 1)), null);
  assert.equal(normalizeTraeCnSession(apiSession('s', 'm', -1, 5, 1)), null);
  // Token fields arrive as strings from some account backends.
  assert.equal(normalizeTraeCnSession({ extra_info: { input_token: '10', output_token: '2' } }).input, 10);
});

test('collectTraeCnRows paginates until the reported total is reached', async () => {
  const calls = [];
  const pageOne = usageBody(
    Array.from({ length: 50 }, (_, i) => apiSession(`s${i}`, 'doubao-seed', 10, 2, 1_785_286_800 + i)),
    60
  );
  const pageTwo = usageBody(
    Array.from({ length: 10 }, (_, i) => apiSession(`s5${i}`, 'doubao-seed', 10, 2, 1_785_286_800 + 50 + i)),
    60
  );
  const rows = await freshCollect({ fetch: usageFetch([pageOne, pageTwo], calls) });

  assert.equal(rows.length, 60);
  assert.equal(calls.length, 2, 'the second page is requested, a third is not');
  // The request shape the account API contract depends on.
  assert.equal(calls[0].url, traeCnUsageUrl('https://api.trae.cn'));
  assert.equal(calls[1].init.page_num, 2);
  assert.equal(calls[0].init.page_size, 50);
  assert.deepEqual(calls[0].init.usage_type, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('collectTraeCnRows stops on a short page even without a total', async () => {
  const calls = [];
  const pageOne = usageBody(Array.from({ length: 50 }, (_, i) => apiSession(`s${i}`, 'm', 1, 1, 1_785_286_800 + i)), null);
  const pageTwo = usageBody([apiSession('last', 'm', 1, 1, 1_785_286_900)], null);
  const rows = await freshCollect({ fetch: usageFetch([pageOne, pageTwo], calls) });

  assert.equal(rows.length, 51);
  assert.equal(calls.length, 2, 'a short page ends the walk without a total to compare against');
});

test('collectTraeCnRows returns one page when fewer than page_size rows exist', async () => {
  const calls = [];
  const body = usageBody([apiSession('a', 'm', 1, 1, 1_785_286_800)], 999);
  const rows = await freshCollect({ fetch: usageFetch([body], calls) });
  assert.equal(rows.length, 1);
  assert.equal(calls.length, 1, 'a single short page must not trigger pagination');
});

test('collectTraeCnRows deduplicates sessions repeated across pages', async () => {
  const shared = apiSession('dup', 'm', 5, 1, 1_785_286_800);
  const pageOne = usageBody([shared, ...Array.from({ length: 49 }, (_, i) => apiSession(`s${i}`, 'm', 1, 1, 1_785_286_800 + i))], 51);
  const pageTwo = usageBody([shared, apiSession('tail', 'm', 1, 1, 1_785_286_900)], 51);
  const rows = await freshCollect({ fetch: usageFetch([pageOne, pageTwo]) });
  assert.equal(rows.length, 51, 'the repeated session counts once');
  assert.equal(rows.filter((r) => r.sessionId === 'trae-cn:api:dup').length, 1);
});

test('collectTraeCnRows surfaces 401/403 as an unauthorized error code', async () => {
  resetTraeCnSnapshotCache();
  await assert.rejects(
    collectTraeCnRows({ accessToken: TOKEN, fetch: usageFetch([401]) }),
    (error) => error.code === TRAE_CN_ERROR_CODES.UNAUTHORIZED && /401/.test(error.message)
  );
  resetTraeCnSnapshotCache();
  await assert.rejects(
    collectTraeCnRows({ accessToken: TOKEN, fetch: usageFetch([403]) }),
    (error) => error.code === TRAE_CN_ERROR_CODES.UNAUTHORIZED
  );
});

test('collectTraeCnRows fails closed on non-JSON bodies and missing arrays', async () => {
  const nonJson = {
    status: 200,
    ok: true,
    json: async () => { throw new Error('Unexpected token < in JSON'); }
  };
  resetTraeCnSnapshotCache();
  await assert.rejects(
    collectTraeCnRows({ accessToken: TOKEN, fetch: () => nonJson }),
    (error) => error.code === TRAE_CN_ERROR_CODES.BAD_RESPONSE && /non-JSON/.test(error.message)
  );

  resetTraeCnSnapshotCache();
  await assert.rejects(
    collectTraeCnRows({ accessToken: TOKEN, fetch: usageFetch([{ total: 3 }]) }),
    (error) => error.code === TRAE_CN_ERROR_CODES.BAD_RESPONSE && /user_usage_group_by_sessions/.test(error.message)
  );
});

test('collectTraeCnRows without a token reports the missing-credential code', async () => {
  resetTraeCnSnapshotCache();
  await assert.rejects(
    collectTraeCnRows({ fetch: usageFetch([usageBody([], 0)]) }),
    (error) => error.code === TRAE_CN_ERROR_CODES.MISSING_TOKEN
  );
});

test('fetchTraeCnSnapshot sends the Cloud-IDE-JWT credential on the wire', async () => {
  const calls = [];
  const body = usageBody([apiSession('s1', 'm', 1, 1, 1_785_286_800)], 1);
  await fetchTraeCnSnapshot({
    accessToken: TOKEN,
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { status: 200, ok: true, json: async () => body };
    }
  });
  assert.equal(calls[0].headers.authorization, `Cloud-IDE-JWT ${TOKEN}`);
  assert.equal(calls[0].body.page_num, 1);
});

test('the snapshot cache serves repeated ticks and sinceMs filters client-side', async () => {
  const calls = [];
  const midnight = localMs(2026, 7, 29);
  const sessions = [
    apiSession('old', 'm', 10, 1, Math.floor((midnight - 60_000) / 1000)),
    apiSession('new', 'm', 20, 2, Math.floor((midnight + 60_000) / 1000))
  ];
  const fetch = usageFetch([usageBody(sessions, 2)], calls);

  const all = await freshCollect({ fetch });
  assert.equal(all.length, 2);
  const cached = await collectTraeCnRows({ accessToken: TOKEN, fetch });
  assert.equal(cached.length, 2);
  assert.equal(calls.length, 1, 'a second tick within the TTL must not hit the API again');

  const forced = await collectTraeCnRows({ accessToken: TOKEN, fetch, forceRefresh: true });
  assert.equal(calls.length, 2, 'forceRefresh bypasses the cache');
  assert.equal(forced.length, 2);

  const since = await collectTraeCnRows({ accessToken: TOKEN, fetch, sinceMs: midnight });
  assert.deepEqual(since.map((r) => r.sessionId), ['trae-cn:api:new'], 'anchored ticks only keep rows that can still land today');
});

test('buildTraeCnPeriods keeps local day and month boundaries', () => {
  const now = localMs(2026, 7, 29, 12);
  const dayStart = localMs(2026, 7, 29);
  const rows = [
    row('s1', 'doubao-seed', 10, 2, dayStart - 60_000, { cacheRead: 3 }),
    row('s1', 'doubao-seed', 20, 4, dayStart + 60_000, { cacheRead: 5 })
  ];
  const periods = buildTraeCnPeriods({ now, allTimeSince: '2026-01-01', rows });

  // Both rows are July rows; only the second is today's, whatever the offset.
  assert.equal(periods.today.totalInput, 20);
  assert.equal(periods.today.totalCacheRead, 5);
  assert.equal(periods.month.totalInput, 30);
  assert.equal(periods.allTime.entries[0].client, TRAE_CN_CLIENT_ID);
  assert.equal(periods.allTime.entries[0].messageCount, 2);
  assert.ok(periods.month.entries[0].lastUsedAt, 'entries carry tokscale timestamp fields');
});

test('buildTraeCnPeriods cuts the month at local midnight of the first', () => {
  const now = localMs(2026, 7, 29, 12);
  const rows = [
    row('june', 'm', 10, 0, localMs(2026, 6, 30, 23, 59)),
    row('august', 'm', 5, 0, localMs(2026, 7, 1, 0, 1))
  ];
  const periods = buildTraeCnPeriods({ now, allTimeSince: '2026-01-01', rows });
  assert.equal(periods.today.totalInput, 0);
  assert.equal(periods.month.totalInput, 5, 'a row 1 minute into the local month counts; June does not');
  assert.equal(periods.allTime.totalInput, 15);
});

test('buildTraeCnPeriods groups rows per session and model with summed usage', () => {
  const now = localMs(2026, 7, 29, 12);
  const t1 = localMs(2026, 7, 29, 10);
  const t2 = localMs(2026, 7, 29, 11);
  const rows = [
    row('s1', 'doubao-seed', 10, 2, t1, { cacheRead: 3, cacheWrite: 1 }),
    row('s1', 'doubao-seed', 20, 4, t2, { cacheRead: 5 }),
    row('s1', 'kimi-k2', 7, 1, t1)
  ];
  const periods = buildTraeCnPeriods({ now, allTimeSince: '2026-01-01', rows });
  assert.equal(periods.today.entries.length, 2, 'one entry per session+model pair');
  const main = periods.today.entries.find((entry) => entry.model === 'doubao-seed');
  assert.equal(main.input, 30);
  assert.equal(main.output, 6);
  assert.equal(main.cacheRead, 8);
  assert.equal(main.cacheWrite, 1);
  assert.equal(main.messageCount, 2);
  assert.equal(main.startedAt, new Date(t1).toISOString());
  assert.equal(main.lastUsedAt, new Date(t2).toISOString());
  assert.equal(periods.today.totalMessages, 3);
});

test('undated Trae CN rows count for allTime only, mirroring the proma rule', () => {
  const now = localMs(2026, 7, 29, 12);
  const rows = [
    row('s1', 'm', 10, 2, 0),
    row('s1', 'm', 20, 4, localMs(2026, 7, 29) + 60_000)
  ];
  const periods = buildTraeCnPeriods({ now, allTimeSince: '2026-01-01', rows });
  assert.equal(periods.today.totalInput, 20, 'an undated row must not leak into today');
  assert.equal(periods.month.totalInput, 20, 'an undated row must not leak into month');
  assert.equal(periods.allTime.totalInput, 30, 'an undated row still counts for allTime');
});

test('buildTraeCnPeriods respects allTimeSince', () => {
  const now = localMs(2026, 7, 29, 12);
  const rows = [
    row('old', 'm', 10, 0, localMs(2025, 11, 31, 12)),
    row('new', 'm', 20, 0, localMs(2026, 2, 1, 12))
  ];
  const periods = buildTraeCnPeriods({ now, allTimeSince: '2026-01-01', rows });
  assert.equal(periods.allTime.totalInput, 20);
});

test('buildTraeCnHistoryGraph buckets by local day and aggregates per model', () => {
  const graph = buildTraeCnHistoryGraph({
    rows: [
      row('a', 'doubao-seed', 10, 2, localMs(2026, 7, 28, 9)),
      row('b', 'kimi-k2', 5, 1, localMs(2026, 7, 28, 18)),
      row('c', 'doubao-seed', 7, 3, localMs(2026, 7, 29, 8))
    ],
    pricingByModel: {
      'doubao-seed': { inputCostPerToken: 2, outputCostPerToken: 3 },
      'kimi-k2': { inputCostPerToken: 1, outputCostPerToken: 1 }
    }
  });

  assert.deepEqual(graph.contributions.map((day) => day.date), ['2026-07-28', '2026-07-29']);
  const first = graph.contributions[0];
  assert.deepEqual(first.clients.map((client) => client.modelId).sort(), ['doubao-seed', 'kimi-k2']);
  const seed = first.clients.find((client) => client.modelId === 'doubao-seed');
  assert.equal(seed.tokens.input, 10);
  assert.equal(seed.tokens.output, 2);
  assert.equal(seed.cost, 10 * 2 + 2 * 3);
  assert.equal(seed.messages, 1);
  assert.equal(graph.contributions[1].clients[0].tokens.input, 7);
});

test('buildTraeCnHistoryGraph skips undated rows instead of inventing a 1970 day', () => {
  const graph = buildTraeCnHistoryGraph({ rows: [row('a', 'm', 10, 2, 0)] });
  assert.deepEqual(graph.contributions, []);
});

test('Trae CN cost uses input, output, cache-read, and cache-write rates', () => {
  const createdAt = localMs(2026, 7, 29, 10);
  const rows = [row('s1', 'doubao-seed', 10, 2, createdAt, { cacheRead: 5, cacheWrite: 1 })];
  const pricingByModel = {
    'doubao-seed': {
      inputCostPerToken: 2,
      outputCostPerToken: 3,
      cacheReadInputTokenCost: 4,
      cacheCreationInputTokenCost: 5
    }
  };
  const periods = buildTraeCnPeriods({ now: localMs(2026, 7, 29, 12), allTimeSince: '2026-01-01', rows, pricingByModel });
  const graph = buildTraeCnHistoryGraph({ rows, pricingByModel });
  assert.equal(periods.today.totalCost, 51);
  assert.equal(graph.contributions[0].clients[0].cost, 51);
});

test('Trae CN pricing resolves once per model and invalidates on revision', async () => {
  resetTraeCnPricingCache();
  let lookups = 0;
  const lookupModelPricing = async (modelId) => {
    lookups += 1;
    assert.equal(modelId, 'doubao-seed');
    return {
      pricing: {
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002,
        cacheReadInputTokenCost: 0.0000001,
        cacheCreationInputTokenCost: 0.000003
      }
    };
  };
  const rows = [{ model: 'Doubao-Seed' }, { model: 'doubao-seed' }];
  const first = await resolveTraeCnPricing(rows, { lookupModelPricing, pricingRevision: 1, nowMs: 1000 });
  const cached = await resolveTraeCnPricing(rows, { lookupModelPricing, pricingRevision: 1, nowMs: 2000 });
  assert.equal(lookups, 1, 'case-insensitive model ids resolve through one catalog lookup');
  assert.deepEqual(cached, first);

  const revalidated = await resolveTraeCnPricing(rows, { lookupModelPricing, pricingRevision: 2, nowMs: 3000 });
  assert.equal(lookups, 2, 'a new pricing revision busts the cache');
  assert.deepEqual(revalidated, first);
  resetTraeCnPricingCache();
});

test('a failing or empty pricing lookup stays cost-unavailable, never zero-priced', async () => {
  resetTraeCnPricingCache();
  const lookupModelPricing = async (modelId) => {
    if (modelId === 'offline-model') throw new Error('catalog offline');
    if (modelId === 'empty-model') return { pricing: {} };
    return { pricing: { inputCostPerToken: 1 } };
  };
  const rows = [{ model: 'offline-model' }, { model: 'empty-model' }, { model: 'priced-model' }];
  const pricing = await resolveTraeCnPricing(rows, { lookupModelPricing, pricingRevision: 1, nowMs: 1000 });

  assert.deepEqual(Object.keys(pricing), ['priced-model'], 'offline and empty lookups must not invent prices');
  // A row with no catalog entry contributes zero cost rather than inheriting
  // an unrelated model's price.
  const periods = buildTraeCnPeriods({
    now: localMs(2026, 7, 29, 12),
    allTimeSince: '2026-01-01',
    rows: [row('s1', 'offline-model', 100, 50, localMs(2026, 7, 29, 10))],
    pricingByModel: pricing
  });
  assert.equal(periods.today.totalCost, 0);
  resetTraeCnPricingCache();
});

test('traeCnDataPaths resolves the install dirs per platform', () => {
  const darwin = traeCnDataPaths({ homeDir: '/Users/test', platform: 'darwin', env: {} });
  assert.deepEqual(darwin.storagePaths, [
    path.join('/Users/test', 'Library', 'Application Support', 'TRAE SOLO CN'),
    path.join('/Users/test', 'Library', 'Application Support', 'Trae CN')
  ]);

  const win = traeCnDataPaths({ homeDir: '/home/test', platform: 'win32', env: { APPDATA: '/home/test/AppData/Roaming' } });
  assert.deepEqual(win.storagePaths, [
    path.join('/home/test/AppData/Roaming', 'TRAE SOLO CN'),
    path.join('/home/test/AppData/Roaming', 'Trae CN')
  ]);

  const linux = traeCnDataPaths({ homeDir: '/home/test', platform: 'linux', env: {} });
  assert.deepEqual(linux.storagePaths, [
    path.join('/home/test/.config', 'TRAE SOLO CN'),
    path.join('/home/test/.config', 'Trae CN')
  ]);
});

test('the whole Trae CN chain produces tokscale-shaped periods from an API page', async () => {
  const midnight = localMs(2026, 7, 29);
  const sessions = [
    apiSession('s1', 'doubao-seed', 100, 20, Math.floor((midnight - 3_600_000) / 1000), { cacheRead: 40 }),
    apiSession('s1', 'doubao-seed', 200, 30, Math.floor((midnight + 3_600_000) / 1000), { cacheRead: 60 }),
    apiSession('s2', 'kimi-k2', 50, 10, Math.floor((midnight + 7_200_000) / 1000))
  ];
  const rows = await freshCollect({ fetch: usageFetch([usageBody(sessions, 3)]), nowMs: localMs(2026, 7, 29, 12) });

  const pricing = await resolveTraeCnPricing(rows, {
    lookupModelPricing: async (modelId) => ({
      pricing: modelId === 'doubao-seed'
        ? { inputCostPerToken: 0.5, outputCostPerToken: 1, cacheReadInputTokenCost: 0.1, cacheCreationInputTokenCost: 0.2 }
        : { inputCostPerToken: 0.25, outputCostPerToken: 0.5, cacheReadInputTokenCost: 0.05, cacheCreationInputTokenCost: 0.1 }
    }),
    pricingRevision: 7,
    nowMs: localMs(2026, 7, 29, 12)
  });
  const periods = buildTraeCnPeriods({ now: localMs(2026, 7, 29, 12), allTimeSince: '2026-01-01', rows, pricingByModel: pricing });
  const today = extractUsageFromTokscale(periods.today);
  const month = extractUsageFromTokscale(periods.month);
  const allTime = extractUsageFromTokscale(periods.allTime);
  const graph = buildTraeCnHistoryGraph({ rows, pricingByModel: pricing });

  // totalTokens folds cache reads/writes in, like every tokscale client.
  assert.equal(today.totalTokens, 350, 'only rows after local midnight count');
  assert.equal(today.clients[TRAE_CN_CLIENT_ID], 350);
  assert.equal(today.cacheReadTokens, 60);
  assert.equal(month.totalTokens, 510);
  assert.equal(allTime.totalTokens, 510);
  assert.equal(today.costUsd, 200 * 0.5 + 30 * 1 + 60 * 0.1 + 50 * 0.25 + 10 * 0.5);
  assert.equal(graph.contributions.length, 2, 'the pre-midnight row lands on the previous day');
  assert.deepEqual(
    graph.contributions[1].clients.map((client) => [client.modelId, client.tokens.input]),
    [['doubao-seed', 200], ['kimi-k2', 50]]
  );
  resetTraeCnPricingCache();
});
