'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const dotenv = require('dotenv');
const { createHash } = require('node:crypto');

const {
  minimaxToken,
  parseMinimaxTiers,
  fetchMinimaxLimits: fetchMinimaxLimitsWithDeps,
  minimaxAttemptOrder,
  minimaxRegion,
  minimaxRegionForUrl,
  isMinimaxTransportError,
  MINIMAX_REGION_MEMORY_STATE_KEY,
  MINIMAX_CODE_MEMBERSHIP_URL_CN,
  MINIMAX_CODE_PLAN_REMAINS_URL_CN,
  MINIMAX_TOKEN_PLAN_REMAINS_URL_CN,
  MINIMAX_TOKEN_PLAN_REMAINS_URL_EN,
  MINIMAX_REMAINS_URL_CN,
  MINIMAX_REMAINS_URL_EN
} = require('../../src/shared/providers/minimax/limits');
const { parseLimitProviders } = require('../../src/shared/limits/collector');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { syncLimits } = require('../../src/shared/limits/core');
const { syncLimits: syncWorkerLimits } = require('../../worker/src/shared/limits/core');

const CN_REMAINS_URLS = new Set([MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_REMAINS_URL_CN]);

// Automatic discovery must never read the developer's real login in unit tests.
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-empty-home-'));
test.after(() => fs.rmSync(emptyHome, { recursive: true, force: true }));
const fetchMinimaxLimits = (options, deps) => fetchMinimaxLimitsWithDeps(options, { env: {}, homeDir: emptyHome, ...deps });

const BALANCE_URL_CN = 'https://api.minimaxi.com/account/query_balance';
const BALANCE_URL_EN = 'https://api.minimax.io/account/query_balance';

test('MiniMax API balance probes use one endpoint in the selected region', async () => {
  const fixture = writeCodeAuthFixture({ record: { expiresAtMs: CODE_NOW } });
  const before = [fixture.authPath, fixture.statePath].map(file => fs.readFileSync(file, 'utf8'));
  for (const [region, url, currency] of [['cn', BALANCE_URL_CN, 'CNY'], ['intl', BALANCE_URL_EN, 'USD']]) {
    // Voucher balances may update before daily cash bills are posted.
    for (const body of [
      { available_amount: '98.25', cash_balance: '100.00' },
      { available_amount: '14.97', cash_balance: '0.00', voucher_balance: '14.97',
        credit_balance: '0.00', owed_amount: '0.00', balance_alert_switch: false, balance_alert_threshold: '' },
      { available_amount: '0.00' },
      { available_amount: '-1.50' }
    ]) {
      const calls = [];
      const result = await fetchMinimaxLimits({ minimaxApiKey: 'sk-api-test', minimaxBillingMode: 'api', minimaxApiRegion: region }, {
        env: { MINIMAX_DATA_DIR: fixture.base }, probe: true,
        fetch: async (target, { headers }) => {
          calls.push(target);
          assert.equal(headers.Authorization, 'Bearer sk-api-test');
          return okResponse({ ...body, base_resp: { status_code: 0, status_msg: 'success' } });
        }
      });
      assert.deepEqual(calls, [url]);
      assert.equal(result.status, 'ok');
      assert.equal(result.accountLabel, 'Pay-as-you-go');
      assert.equal(result.windows.length, 1);
      assert.equal(result.windows[0].metric, 'credits');
      assert.equal(result.windows[0].currency, currency);
      assert.equal(result.windows[0].remaining, Number(body.available_amount));
      assert.equal(result.windows[0].usedPercent, null);
      assert.equal(result.windows[0].resetsAt, null);
      assert.equal(JSON.stringify(result).includes('sk-api-test'), false);
      assertSyncPreservesReading(result);
    }
  }
  assert.deepEqual([fixture.authPath, fixture.statePath].map(file => fs.readFileSync(file, 'utf8')), before);
});

test('MiniMax API billing retries business auth errors and remembers a valid zero balance', async () => {
  // Foreign-region keys can be rejected by HTTP 400 plus business 1004.
  for (const httpStatus of [200, 400]) {
    const calls = [];
    const providerRuntimeState = new Map();
    const deps = {
      env: {}, probe: true, providerRuntimeState,
      fetch: async (url) => {
        calls.push(url);
        return url === BALANCE_URL_EN
          ? { ok: httpStatus === 200, status: httpStatus, json: async () => ({ base_resp: { status_code: 1004, status_msg: 'not authorized' } }) }
          : okResponse({ available_amount: '0.00', cash_balance: '0.00', voucher_balance: '0.00', base_resp: { status_code: 0 } });
      }
    };
    const options = { minimaxApiKey: 'sk-api-test', minimaxBillingMode: 'api' };
    const result = await fetchMinimaxLimits(options, deps);
    assert.equal(result.status, 'ok', `HTTP ${httpStatus} business auth rejection must try CN`);
    assert.equal(result.windows[0].remaining, 0);
    assert.deepEqual(calls, [BALANCE_URL_EN, BALANCE_URL_CN]);
    assert.equal(providerRuntimeState.get(MINIMAX_REGION_MEMORY_STATE_KEY), 'cn');
    calls.length = 0;
    assert.equal((await fetchMinimaxLimits(options, deps)).status, 'ok');
    assert.deepEqual(calls, [BALANCE_URL_CN]);
  }
});

test('MiniMax API billing rejects missing or malformed balances without inventing a quota', async () => {
  for (const available_amount of [undefined, null, '', ' ', 'invalid', false, Infinity]) {
    const calls = [];
    const result = await fetchMinimaxLimits({ minimaxApiKey: 'sk-api-test', minimaxBillingMode: 'api' }, {
      env: {},
      fetchJson: async (url) => {
        calls.push(url);
        return { available_amount, base_resp: { status_code: 0 } };
      }
    });
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.windows, []);
    assert.deepEqual(calls, [BALANCE_URL_EN]);
  }
});

test('MiniMax API billing preserves auth, rate-limit and transport verdicts', async () => {
  for (const [httpStatus, statusCode, expected, urls] of [
    [401, undefined, 'unauthorized', [BALANCE_URL_EN, BALANCE_URL_CN]],
    [400, 1004, 'unauthorized', [BALANCE_URL_EN, BALANCE_URL_CN]],
    [400, 2013, 'unavailable', [BALANCE_URL_EN]],
    [429, undefined, 'sourceRateLimited', [BALANCE_URL_EN]],
    [500, undefined, 'unavailable', [BALANCE_URL_EN]],
    [null, undefined, 'unavailable', [BALANCE_URL_EN, BALANCE_URL_CN]]
  ]) {
    const calls = [];
    const result = await fetchMinimaxLimits({ minimaxApiKey: 'sk-api-test', minimaxBillingMode: 'api' }, {
      env: {},
      fetch: async (url) => {
        calls.push(url);
        if (httpStatus === null) throw new Error('network down');
        return { ok: false, status: httpStatus, json: async () => ({ base_resp: { status_code: statusCode } }) };
      }
    });
    assert.equal(result.status, expected, `HTTP ${httpStatus}, business code ${statusCode}`);
    assert.deepEqual(calls, urls);
  }
  const calls = [];
  const result = await fetchMinimaxLimits({ minimaxApiKey: 'sk-api-test', minimaxBillingMode: 'api' }, {
    env: {},
    fetchJson: async (url) => {
      calls.push(url);
      if (url === BALANCE_URL_EN) throw new Error('network down');
      return { base_resp: { status_code: 1004, status_msg: 'invalid api key' } };
    }
  });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(calls, [BALANCE_URL_EN, BALANCE_URL_CN]);
});

test('MiniMax cash Spend is a server snapshot and a failed period leaves the balance', async () => {
  const now = new Date(2026, 2, 1, 12).getTime();
  const requests = [];
  const row = await fetchMinimaxLimits({ minimaxBillingMode: 'api', minimaxApiRegion: 'cn', minimaxApiKey: 'mock-key' }, {
    env: {}, now: () => now,
    fetch: async (url, { headers }) => {
      requests.push(url);
      const target = new URL(url);
      assert.equal(target.host, 'api.minimaxi.com');
      assert.equal(headers.Authorization, 'Bearer mock-key');
      if (target.pathname === '/account/query_balance') return okResponse({ available_amount: '14.97', base_resp: { status_code: 0 } });
      if (target.pathname === '/account/query_recharge') return okResponse({ cash_total_usage: '12.34', base_resp: { status_code: 0 } });
      assert.equal(target.pathname, '/account/amount');
      assert.equal(target.searchParams.get('aggregate'), 'true');
      if (target.searchParams.get('start_date') === '2026-02-23') return okResponse({ base_resp: { status_code: 1032 } });
      return okResponse({ consume_cash_after_voucher_sum: '0.0000', base_resp: { status_code: 0 } });
    }
  });
  assert.equal(row.status, 'ok');
  assert.equal(row.balance.amount, 14.97);
  assert.equal(row.balance.currency, 'CNY');
  assert.equal(row.balance.todaySpend, 0);
  assert.equal(row.balance.weekSpend, null);
  assert.equal(row.balance.monthSpend, 0);
  assert.equal(row.balance.allTimeSpend, 12.34);
  assert.equal(row.balance.trackingSince, null);
  assert.equal(requests.length, 4, 'identical Today and Month filters share one request');
  assert.equal(new Set(requests).size, requests.length);
  assertSyncPreservesReading(row);

  const malformed = await fetchMinimaxLimits({ minimaxBillingMode: 'api', minimaxApiRegion: 'cn', minimaxApiKey: 'mock-key' }, {
    env: {}, fetch: async url => new URL(url).pathname === '/account/query_balance'
      ? okResponse({ available_amount: '14.97', base_resp: { status_code: 0 } })
      : okResponse({ consume_cash_after_voucher_sum: 'invalid', base_resp: { status_code: 0 } })
  });
  assert.equal(malformed.status, 'ok');
  assert.equal(malformed.windows[0].remaining, 14.97);
  assert.equal(malformed.balance, null);

  const controller = new AbortController();
  const cancelled = await fetchMinimaxLimits({ minimaxBillingMode: 'api', minimaxApiRegion: 'cn', minimaxApiKey: 'mock-key' }, {
    env: {}, signal: controller.signal,
    fetch: async (url) => {
      if (new URL(url).pathname === '/account/query_balance') return okResponse({ available_amount: '14.97', base_resp: { status_code: 0 } });
      controller.abort();
      throw controller.signal.reason;
    }
  });
  assert.equal(controller.signal.aborted, true);
  assert.equal(cancelled.status, 'ok');
  assert.equal(cancelled.windows[0].remaining, 14.97);
  assert.equal(cancelled.balance, null);
});

test('the copied environment example leaves the legacy MiniMax host pin effective', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
  const env = dotenv.parse(`${example}\nMINIMAX_API_HOST=api.minimaxi.com\n`);
  assert.equal(minimaxRegion({}, env), 'cn');
});

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function unauthorized() {
  return { ok: false, status: 401, json: async () => ({}) };
}

function assertSyncPreservesReading(row) {
  const wire = JSON.parse(JSON.stringify(syncLimits({ updatedAt: row.updatedAt, providers: [row] })));
  for (const [hub, normalize] of [['Node', syncLimits], ['Worker', syncWorkerLimits]]) {
    assert.deepEqual(normalize(wire).providers, [row], `${hub} must preserve the collected reading`);
  }
}

test('minimaxToken reads the CodexBar-compatible Token Plan key and ignores unrelated keys', () => {
  assert.equal(minimaxToken({ MINIMAX_CODING_API_KEY: '  "sk-cp-codexbar"  ' }), 'sk-cp-codexbar');
  assert.equal(minimaxToken({ TOKEN_MONITOR_MINIMAX_KEY: 'sk-cp-unrelated' }), '');
  assert.equal(minimaxToken({ MINIMAX_API_KEY: 'sk-api-payg' }), '');
  assert.equal(minimaxToken({}), '');
  assert.equal(minimaxToken({}, '  "sk-cp-direct"  '), 'sk-cp-direct');
});

test('parseLimitProviders includes minimax and grok in the default provider set', () => {
  const providers = parseLimitProviders();
  assert.ok(providers.includes('minimax'));
  assert.ok(providers.includes('grok'));
});

test('minimaxAttemptOrder prefers token-plan endpoint before legacy coding-plan endpoint per region', () => {
  assert.deepEqual(minimaxAttemptOrder(), [
    MINIMAX_TOKEN_PLAN_REMAINS_URL_EN,
    MINIMAX_REMAINS_URL_EN,
    MINIMAX_TOKEN_PLAN_REMAINS_URL_CN,
    MINIMAX_REMAINS_URL_CN
  ]);
  assert.deepEqual(minimaxAttemptOrder({ minimaxApiHost: 'cn' }), [
    MINIMAX_TOKEN_PLAN_REMAINS_URL_CN,
    MINIMAX_REMAINS_URL_CN
  ]);
  assert.deepEqual(minimaxAttemptOrder({ minimaxApiHost: 'en' }), [
    MINIMAX_TOKEN_PLAN_REMAINS_URL_EN,
    MINIMAX_REMAINS_URL_EN
  ]);
  assert.deepEqual(minimaxAttemptOrder({ minimaxApiHost: 'minimax.io' }), [
    MINIMAX_TOKEN_PLAN_REMAINS_URL_EN,
    MINIMAX_REMAINS_URL_EN
  ]);
});

test('minimaxAttemptOrder puts a remembered region first and keeps the other as fallback', () => {
  assert.deepEqual(minimaxAttemptOrder({ minimaxRememberedRegion: 'cn' }), [
    MINIMAX_TOKEN_PLAN_REMAINS_URL_CN,
    MINIMAX_REMAINS_URL_CN,
    MINIMAX_TOKEN_PLAN_REMAINS_URL_EN,
    MINIMAX_REMAINS_URL_EN
  ]);
  assert.deepEqual(minimaxAttemptOrder({ minimaxRememberedRegion: 'en' }), [
    MINIMAX_TOKEN_PLAN_REMAINS_URL_EN,
    MINIMAX_REMAINS_URL_EN,
    MINIMAX_TOKEN_PLAN_REMAINS_URL_CN,
    MINIMAX_REMAINS_URL_CN
  ]);
  // An unknown value falls back to the default order rather than breaking.
  assert.deepEqual(minimaxAttemptOrder({ minimaxRememberedRegion: 'jp' }), minimaxAttemptOrder());
  // An explicit host pin outranks the memory: the pin is a single-region order.
  assert.deepEqual(minimaxAttemptOrder({ minimaxApiHost: 'cn', minimaxRememberedRegion: 'en' }), [
    MINIMAX_TOKEN_PLAN_REMAINS_URL_CN,
    MINIMAX_REMAINS_URL_CN
  ]);
});

test('minimaxRegion normalizes the explicit region setting and keeps auto as the default', () => {
  assert.equal(minimaxRegion({ minimaxApiRegion: 'auto' }), 'auto');
  assert.equal(minimaxRegion({ minimaxApiRegion: 'cn' }), 'cn');
  assert.equal(minimaxRegion({ minimaxApiRegion: 'intl' }), 'intl');
  assert.equal(minimaxRegion({ minimaxApiRegion: ' INTL ' }), 'intl');
  assert.equal(minimaxRegion({ minimaxApiRegion: 'en' }), 'intl');
  assert.equal(minimaxRegion({ minimaxApiRegion: 'global' }), 'intl');
  assert.equal(minimaxRegion({ minimaxApiRegion: 'api.minimaxi.com' }), 'cn');
  assert.equal(minimaxRegion({ minimaxApiRegion: 'api.minimax.io' }), 'intl');
  // Anything unrecognized degrades to the historical probe order rather than
  // pinning a region the user never asked for.
  assert.equal(minimaxRegion({ minimaxApiRegion: 'nonsense' }), 'auto');
  assert.equal(minimaxRegion({}), 'auto');
  assert.equal(minimaxRegion(), 'auto');
});

test('minimaxRegion prefers the new option, then the legacy host pin, then the env lane', () => {
  assert.equal(minimaxRegion({ minimaxApiRegion: 'cn', minimaxApiHost: 'en' }), 'cn');
  assert.equal(minimaxRegion({}, { TOKEN_MONITOR_MINIMAX_API_REGION: 'cn' }), 'cn');
  assert.equal(minimaxRegion({}, { MINIMAX_API_REGION: 'intl' }), 'intl');
  assert.equal(minimaxRegion({}, { MINIMAX_API_HOST: 'api.minimaxi.com' }), 'cn');
  assert.equal(
    minimaxRegion({ minimaxApiRegion: 'intl' }, { TOKEN_MONITOR_MINIMAX_API_REGION: 'cn' }),
    'intl'
  );
});

test('minimaxRegionForUrl maps endpoints to en/cn labels for the renderer', () => {
  assert.equal(minimaxRegionForUrl(MINIMAX_REMAINS_URL_EN), 'en');
  assert.equal(minimaxRegionForUrl(MINIMAX_REMAINS_URL_CN), 'cn');
  assert.equal(minimaxRegionForUrl(MINIMAX_TOKEN_PLAN_REMAINS_URL_EN), 'en');
  assert.equal(minimaxRegionForUrl(MINIMAX_TOKEN_PLAN_REMAINS_URL_CN), 'cn');
  assert.equal(minimaxRegionForUrl('https://example.com'), '');
});

// Only a failure with no HTTP-layer answer at all justifies jumping regions:
// the transport shapes (Node undici's `fetch failed` with or without a cause
// code, and Chromium's plain `net::ERR_*` rejection) carry neither a status nor
// a statusCode.
test('isMinimaxTransportError accepts the shapes a failing host actually rejects with', () => {
  assert.equal(isMinimaxTransportError(null), false);
  assert.equal(isMinimaxTransportError(new Error('fetch failed')), true);
  assert.equal(
    isMinimaxTransportError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })),
    true
  );
  assert.equal(isMinimaxTransportError(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
  assert.equal(isMinimaxTransportError(Object.assign(new Error('net::ERR_CONNECTION_TIMED_OUT'))), true);
});

// An HTTP answer never counts as transport: the status-carrying rejection the
// fetcher throws, the JSON parse failure of a body that did arrive (a
// truncated or interception page), and the internal throws that carry a status
// without a statusCode.
test('isMinimaxTransportError refuses every shape that got an HTTP answer', () => {
  assert.equal(isMinimaxTransportError(Object.assign(new Error('unreachable host'), { status: 'unavailable', statusCode: 503 })), false);
  assert.equal(isMinimaxTransportError(Object.assign(new Error('bad token'), { status: 'unauthorized', statusCode: 401 })), false);
  const parseError = new SyntaxError('Unexpected token < in JSON at position 0');
  assert.equal(isMinimaxTransportError(parseError), false);
  assert.equal(isMinimaxTransportError(Object.assign(new Error('no quota windows'), { status: 'unavailable' })), false);
  assert.equal(isMinimaxTransportError(Object.assign(new Error('nope'), { status: 'timeout' })), false);
});

test('parseMinimaxTiers reads the nested data.model_remains shape used by the live endpoint', () => {
  // Verified shape from a real Token Plan response (PR #32 review).
  const body = {
    base_resp: { status_code: 0, status_msg: 'success' },
    data: {
      current_subscribe_title: 'Token Plan Plus',
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: '96',
          start_time: 1_780_279_200_000,
          end_time: 1_780_297_200_000,
          current_weekly_remaining_percent: '99',
          weekly_start_time: 1_780_243_200_000,
          weekly_end_time: 1_780_848_000_000
        }
      ]
    }
  };
  const windows = parseMinimaxTiers(body);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].kind, 'session');
  assert.equal(windows[0].usedPercent, 4); // 100 - 96 (string → number)
  assert.equal(windows[0].remainingPercent, 96);
  assert.equal(windows[0].windowMinutes, 5 * 60);
  assert.match(windows[0].resetsAt, /^20\d\d-/);
  assert.equal(windows[1].kind, 'weekly');
  assert.equal(windows[1].usedPercent, 1);
  assert.equal(windows[1].remainingPercent, 99);
});

test('parseMinimaxTiers accepts the legacy top-level model_remains shape', () => {
  const body = {
    model_remains: [
      {
        model_name: 'general',
        current_interval_remaining_percent: 80,
        current_weekly_remaining_percent: 70
      }
    ]
  };
  const windows = parseMinimaxTiers(body);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].usedPercent, 20);
  assert.equal(windows[1].usedPercent, 30);
});

test('parseMinimaxTiers skips video / voice buckets and locates general anywhere in the array', () => {
  const body = {
    data: {
      model_remains: [
        { model_name: 'video', current_interval_remaining_percent: 20 },
        {
          model_name: 'general',
          current_interval_remaining_percent: 80,
          current_weekly_remaining_percent: 70
        }
      ]
    }
  };
  const windows = parseMinimaxTiers(body);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].usedPercent, 20); // 100 - 80, NOT the video 80%
});

test('parseMinimaxTiers suppresses the status==3 placeholder lane', () => {
  // Plan that has no weekly bucket: server returns the placeholder row with
  // current_weekly_status:3 and current_weekly_remaining_percent:100. The
  // session row is real, so we keep it.
  const body = {
    data: {
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 99,
          current_interval_status: 1,
          current_weekly_remaining_percent: 100,
          current_weekly_status: 3
        }
      ]
    }
  };
  const windows = parseMinimaxTiers(body);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, 'session');
});

test('parseMinimaxTiers suppresses a status==3 lane that has no usable percent', () => {
  const body = {
    data: {
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 80,
          current_interval_status: 1,
          current_weekly_status: 3
          // current_weekly_remaining_percent intentionally absent
        }
      ]
    }
  };
  const windows = parseMinimaxTiers(body);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, 'session');
});

test('parseMinimaxTiers emits a non-placeholder weekly lane even when status is missing', () => {
  // The live response doesn't always carry current_weekly_status. As long as
  // the percent is present and not the 100% placeholder, render it.
  const body = {
    data: {
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 80,
          current_weekly_remaining_percent: 70
        }
      ]
    }
  };
  const windows = parseMinimaxTiers(body);
  assert.equal(windows.length, 2);
});

test('parseMinimaxTiers renders a status==3 lane with a real (non-100, non-null) percent', () => {
  // Documents the current behavior: the placeholder guard only suppresses
  // status==3 with a 100% / null percent. If the server returns status==3
  // with a real percent (e.g. 50), we trust the number and render the window
  // — same as CodexBar. If the live endpoint ever starts returning this
  // shape, the percent may be a stale placeholder, and this test will need
  // to flip to assert the lane is suppressed instead.
  const body = {
    data: {
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 50,
          current_interval_status: 3,
          current_weekly_remaining_percent: 60,
          current_weekly_status: 3
        }
      ]
    }
  };
  const windows = parseMinimaxTiers(body);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].usedPercent, 50); // 100 - 50
  assert.equal(windows[1].usedPercent, 40); // 100 - 60
});

test('parseMinimaxTiers returns [] when model_remains is missing or has no general entry', () => {
  assert.deepEqual(parseMinimaxTiers({ data: { model_remains: [] } }), []);
  assert.deepEqual(parseMinimaxTiers({ data: { model_remains: [{ model_name: 'video' }] } }), []);
  assert.deepEqual(parseMinimaxTiers({}), []);
  assert.deepEqual(parseMinimaxTiers(null), []);
});

test('parseMinimaxTiers clamps percentages to [0, 100] and handles negative remainders', () => {
  const body = {
    data: {
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: -5,
          current_weekly_remaining_percent: 150
        }
      ]
    }
  };
  const windows = parseMinimaxTiers(body);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].usedPercent, 100); // 100 - (-5) clamped
  assert.equal(windows[0].remainingPercent, 0);
  assert.equal(windows[1].usedPercent, 0); // 100 - 150 clamped
  assert.equal(windows[1].remainingPercent, 100);
});

test('parseMinimaxTiers treats second-precision timestamps as seconds, not milliseconds', () => {
  const body = {
    data: {
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 50,
          end_time: 1_716_350_400 // 10 digits → seconds, < 1e12
        }
      ]
    }
  };
  const windows = parseMinimaxTiers(body);
  assert.match(windows[0].resetsAt, /^20\d\d-/);
});

test('fetchMinimaxLimits returns notConfigured when no key is provided', async () => {
  const r = await fetchMinimaxLimits({}, { env: {} });
  assert.equal(r.provider, 'minimax');
  assert.equal(r.status, 'notConfigured');
  assert.equal(r.source, 'api');
  assert.deepEqual(r.windows, []);
  assert.equal(r.region, '');
});

test('fetchMinimaxLimits returns ok with both windows from the nested shape and never leaks the key', async () => {
  const env = { MINIMAX_CODING_API_KEY: 'sk-cp-secret' };
  const body = {
    base_resp: { status_code: 0 },
    data: {
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 92,
          current_interval_status: 1,
          current_weekly_remaining_percent: 88,
          current_weekly_status: 1,
          end_time: 1_716_350_400_000,
          weekly_end_time: 1_716_780_000_000
        }
      ]
    }
  };
  let capturedUrl = '';
  let capturedAuth = '';
  const r = await fetchMinimaxLimits({}, {
    env,
    now: () => 1_716_350_000_000,
    fetch: async (url, init) => {
      capturedUrl = url;
      capturedAuth = init.headers.Authorization;
      return okResponse(body);
    }
  });

  assert.equal(r.provider, 'minimax');
  assert.equal(r.status, 'ok');
  assert.equal(r.source, 'api');
  assert.equal(r.accountLabel, 'Token Plan');
  assert.match(r.accountKey, /^sha256:/);
  assert.equal(r.region, 'en'); // global endpoint hit first
  assert.equal(capturedUrl, MINIMAX_TOKEN_PLAN_REMAINS_URL_EN);
  assert.equal(r.windows.length, 2);
  assert.equal(r.windows[0].kind, 'session');
  assert.equal(r.windows[0].usedPercent, 8);
  assert.equal(r.windows[1].kind, 'weekly');
  assert.equal(r.windows[1].usedPercent, 12);
  assert.equal(capturedAuth, 'Bearer sk-cp-secret');
  assert.ok(!JSON.stringify(r).includes('sk-cp-secret'));
});

test('fetchMinimaxLimits prefers the widget settings key over env fallback', async () => {
  let capturedAuth = '';
  const r = await fetchMinimaxLimits(
    { minimaxApiKey: " 'sk-cp-settings' " },
    {
      env: { MINIMAX_CODING_API_KEY: 'sk-cp-env' },
      now: () => 1_716_350_000_000,
      fetch: async (_url, init) => {
        capturedAuth = init.headers.Authorization;
        return okResponse({ data: { model_remains: [] } });
      }
    }
  );
  assert.equal(capturedAuth, 'Bearer sk-cp-settings');
  assert.equal(r.status, 'unavailable'); // empty model_remains → no windows → unavailable
  assert.ok(!JSON.stringify(r).includes('sk-cp-settings'));
});

test('fetchMinimaxLimits maps HTTP 401 to unauthorized', async () => {
  // Pinned to the CN host, single attempt, no retry → straightforward error.
  const r = await fetchMinimaxLimits({ minimaxApiHost: 'cn' }, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-test' },
    now: () => 1_716_350_000_000,
    fetch: async () => unauthorized()
  });
  assert.equal(r.status, 'unauthorized');
  assert.equal(r.region, '');
  assert.deepEqual(r.windows, []);
});

test('fetchMinimaxLimits maps HTTP 403 to unauthorized and retries the other region', async () => {
  // 403 is a token rejection, not a server fault — same handling as 401, so the
  // global→CN retry still gets a chance to find a working region.
  const calls = [];
  const body = {
    data: {
      model_remains: [
        { model_name: 'general', current_interval_remaining_percent: 80, current_weekly_remaining_percent: 70 }
      ]
    }
  };
  const r = await fetchMinimaxLimits({}, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-test' },
    now: () => 1_716_350_000_000,
    fetch: async (url) => {
      calls.push(url);
      if (url === MINIMAX_TOKEN_PLAN_REMAINS_URL_EN) return { ok: false, status: 403, json: async () => ({}) };
      if (url === MINIMAX_REMAINS_URL_EN) return { ok: false, status: 403, json: async () => ({}) };
      return okResponse(body);
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_REMAINS_URL_EN, MINIMAX_TOKEN_PLAN_REMAINS_URL_CN]);
  assert.equal(r.status, 'ok');
  assert.equal(r.region, 'cn');
});

test('fetchMinimaxLimits falls back from token-plan remains to legacy coding-plan remains within a region', async () => {
  const calls = [];
  const body = {
    data: {
      model_remains: [
        { model_name: 'general', current_interval_remaining_percent: 90, current_weekly_remaining_percent: 80 }
      ]
    }
  };
  const r = await fetchMinimaxLimits({ minimaxApiHost: 'en' }, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-codexbar' },
    now: () => 1_716_350_000_000,
    fetch: async (url) => {
      calls.push(url);
      if (url === MINIMAX_TOKEN_PLAN_REMAINS_URL_EN) return { ok: false, status: 404, json: async () => ({}) };
      return okResponse(body);
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_REMAINS_URL_EN]);
  assert.equal(r.status, 'ok');
  assert.equal(r.region, 'en');
});

test('fetchMinimaxLimits falls back to legacy coding-plan when token-plan returns no parseable windows', async () => {
  const calls = [];
  const legacyBody = {
    data: {
      model_remains: [
        { model_name: 'general', current_interval_remaining_percent: 91, current_weekly_remaining_percent: 82 }
      ]
    }
  };
  const r = await fetchMinimaxLimits({ minimaxApiHost: 'en' }, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-codexbar' },
    now: () => 1_716_350_000_000,
    fetch: async (url) => {
      calls.push(url);
      if (url === MINIMAX_TOKEN_PLAN_REMAINS_URL_EN) return okResponse({});
      return okResponse(legacyBody);
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_REMAINS_URL_EN]);
  assert.equal(r.status, 'ok');
  assert.equal(r.region, 'en');
  assert.equal(r.windows[0].usedPercent, 9);
});

test('fetchMinimaxLimits aborts and returns unavailable when the fetch exceeds the timeout', async () => {
  let receivedSignal = null;
  const r = await fetchMinimaxLimits({ minimaxApiHost: 'cn' }, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-test' },
    now: () => 1_716_350_000_000,
    fetchTimeoutMs: 10,
    fetch: async (_url, init) => {
      receivedSignal = init.signal;
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
  });
  assert.ok(receivedSignal, 'fetch should receive an AbortSignal');
  assert.equal(r.status, 'unavailable');
  assert.deepEqual(r.windows, []);
});

test('fetchMinimaxLimits retries the CN host when the global host rejects the token', async () => {
  const calls = [];
  const body = {
    data: {
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 80,
          current_weekly_remaining_percent: 70
        }
      ]
    }
  };
  const r = await fetchMinimaxLimits({}, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-cn-only' },
    now: () => 1_716_350_000_000,
    fetch: async (url) => {
      calls.push(url);
      if (url === MINIMAX_TOKEN_PLAN_REMAINS_URL_EN) return unauthorized();
      if (url === MINIMAX_REMAINS_URL_EN) return unauthorized();
      return okResponse(body);
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_REMAINS_URL_EN, MINIMAX_TOKEN_PLAN_REMAINS_URL_CN]);
  assert.equal(r.status, 'ok');
  assert.equal(r.region, 'cn');
});

test('fetchMinimaxLimits retries the CN host when the global host responds 200 + status_code 1004', async () => {
  // The Token Plan endpoint reports a wrong-region token as a 200 OK with
  // base_resp.status_code: 1004 ("cookie is missing, log in again"). Without
  // the retry trigger, a CN-only account would land on the global host and
  // silently fail with 'unavailable' even though the CN host works fine.
  const calls = [];
  const cnBody = {
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [
      {
        model_name: 'general',
        current_interval_remaining_percent: 77,
        current_interval_status: 1,
        current_weekly_remaining_percent: 78,
        current_weekly_status: 1
      }
    ]
  };
  const r = await fetchMinimaxLimits({}, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-cn-only' },
    now: () => 1_716_350_000_000,
    fetch: async (url) => {
      calls.push(url);
      if (url === MINIMAX_TOKEN_PLAN_REMAINS_URL_EN || url === MINIMAX_REMAINS_URL_EN) {
        return okResponse({ base_resp: { status_code: 1004, status_msg: 'cookie is missing, log in again' } });
      }
      return okResponse(cnBody);
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_REMAINS_URL_EN, MINIMAX_TOKEN_PLAN_REMAINS_URL_CN]);
  assert.equal(r.status, 'ok');
  assert.equal(r.region, 'cn');
  assert.equal(r.windows.length, 2);
  assert.equal(r.windows[0].usedPercent, 23); // 100 - 77
});

test('fetchMinimaxLimits does not retry another region on HTTP server errors', async () => {
  const calls = [];
  const r = await fetchMinimaxLimits({}, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-test' },
    now: () => 1_716_350_000_000,
    fetch: async (url) => {
      calls.push(url);
      return { ok: false, status: 503, json: async () => ({}) };
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN]); // only the first attempt
  assert.equal(r.status, 'unavailable');
});

test('fetchMinimaxLimits maps base_resp.status_code != 0 to unavailable', async () => {
  const r = await fetchMinimaxLimits({ minimaxApiHost: 'cn' }, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-test' },
    now: () => 1_716_350_000_000,
    fetch: async () => okResponse({ base_resp: { status_code: 1001, status_msg: 'quota api disabled' } })
  });
  assert.equal(r.status, 'unavailable');
});

test('fetchMinimaxLimits recognizes SDK unauthorized code without depending on message language', async () => {
  for (const httpStatus of [200, 400]) {
    for (const status_msg of [undefined, '未授权', 'cookie is missing, log in again']) {
      const calls = [];
      const result = await fetchMinimaxLimits({ minimaxApiHost: 'cn' }, {
        env: { MINIMAX_CODING_API_KEY: 'sk-cp-test' },
        fetch: async (url) => {
          calls.push(url);
          return { ok: httpStatus === 200, status: httpStatus, json: async () => ({ base_resp: { status_code: 1004, status_msg } }) };
        }
      });
      assert.equal(result.status, 'unauthorized', `HTTP ${httpStatus}, message ${status_msg}`);
      assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_REMAINS_URL_CN]);
    }
  }
});

test('fetchMinimaxLimits maps an unexpected body shape to unavailable', async () => {
  const r = await fetchMinimaxLimits({ minimaxApiHost: 'cn' }, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-test' },
    now: () => 1_716_350_000_000,
    fetch: async () => okResponse({ nope: true })
  });
  assert.equal(r.status, 'unavailable');
});

test('fetchMinimaxLimits reports cn region when pinned to the CN endpoint', async () => {
  const r = await fetchMinimaxLimits({ minimaxApiHost: 'cn', minimaxApiKey: 'sk-cp-test' }, {
    env: {},
    now: () => 1_716_350_000_000,
    fetch: async (url) => {
      assert.equal(url, MINIMAX_TOKEN_PLAN_REMAINS_URL_CN);
      return okResponse({ data: { model_remains: [{ model_name: 'general', current_interval_remaining_percent: 50 }] } });
    }
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.region, 'cn');
});

test('fetchMinimaxLimits probes only the pinned region and reports the resolved wire region', async () => {
  const body = {
    data: {
      model_remains: [
        { model_name: 'general', current_interval_remaining_percent: 60, current_weekly_remaining_percent: 55 }
      ]
    }
  };
  const intlCalls = [];
  const intl = await fetchMinimaxLimits({ minimaxApiRegion: 'intl', minimaxApiKey: 'sk-cp-test' }, {
    env: {},
    now: () => 1_716_350_000_000,
    fetch: async (url) => {
      intlCalls.push(url);
      return okResponse(body);
    }
  });
  assert.deepEqual(intlCalls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN]);
  assert.equal(intl.status, 'ok');
  // The wire region keeps its historical en/cn vocabulary; the setting's 'auto'
  // and 'intl' never leak into it.
  assert.equal(intl.region, 'en');
});

test('fetchMinimaxLimits does not cross regions when the region is pinned', async () => {
  // The cross-region hop is the whole point of pinning: a CN key on a network
  // that cannot reach api.minimax.io would otherwise burn every probe on a
  // doomed global request. A 401 here is final, not a signal to try CN.
  const calls = [];
  const r = await fetchMinimaxLimits({ minimaxApiRegion: 'cn', minimaxApiKey: 'sk-cp-test' }, {
    env: {},
    now: () => 1_716_350_000_000,
    fetch: async (url) => {
      calls.push(url);
      return unauthorized();
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_REMAINS_URL_CN]);
  assert.equal(r.status, 'unauthorized');
  assert.deepEqual(r.windows, []);
});

test('fetchMinimaxLimits pins the region from the env lane for headless use', async () => {
  const calls = [];
  const r = await fetchMinimaxLimits({}, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-test', MINIMAX_API_REGION: 'cn' },
    now: () => 1_716_350_000_000,
    fetch: async (url) => {
      calls.push(url);
      return okResponse({ data: { model_remains: [{ model_name: 'general', current_interval_remaining_percent: 40 }] } });
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN]);
  assert.equal(r.status, 'ok');
  assert.equal(r.region, 'cn');
});

// The abort timer must outlive the body read, not just the headers. Undici resolves the
// fetch as soon as the head arrives, so a body that never arrives is only bounded if the
// timer is still armed while `.json()` is pending.
test('fetchMinimaxLimits aborts when the body stalls after the headers', { timeout: 5000 }, async () => {
  const r = await fetchMinimaxLimits({ minimaxApiHost: 'cn' }, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-test' },
    now: () => 1_716_350_000_000,
    fetchTimeoutMs: 10,
    fetch: async (_url, init) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      })
    })
  });
  assert.equal(r.status, 'unavailable');
  assert.deepEqual(r.windows, []);
});

const windowsBody = {
  data: {
    model_remains: [
      { model_name: 'general', current_interval_remaining_percent: 80, current_weekly_remaining_percent: 70 }
    ]
  }
};

// Connect timeout / DNS / reset never reach an HTTP server, so the legacy
// endpoint on the same host would only repeat the wait. The rescue is the
// OTHER region's token-plan endpoint.
test('fetchMinimaxLimits skips the rest of a region whose host is unreachable and tries the next region', async () => {
  const calls = [];
  const r = await fetchMinimaxLimits({}, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-cn-only' },
    now: () => 1_716_350_000_000,
    fetch: async (url) => {
      calls.push(url);
      if (url === MINIMAX_TOKEN_PLAN_REMAINS_URL_EN) throw new Error('fetch failed');
      return okResponse(windowsBody);
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_TOKEN_PLAN_REMAINS_URL_CN]);
  assert.equal(r.status, 'ok');
  assert.equal(r.region, 'cn');
});

// A body that arrived but did not parse is an HTTP answer, so it does not earn
// the region jump: it is reported like any other unreadable response, and the
// other region's endpoint is not committed to. (Before the transport rule
// read "no HTTP answer" this SyntaxError counted as an unreachable host and
// the CN token-plan endpoint was probed for it.)
test('fetchMinimaxLimits does not jump regions when a 200 body fails to parse', async () => {
  const calls = [];
  const r = await fetchMinimaxLimits({}, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-test' },
    now: () => 1_716_350_000_000,
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } };
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN]);
  assert.equal(r.status, 'unavailable');
});

// A body that parses but names no quota is an answer, not a rescue: it must
// not be remembered as the region that works, or the next probe would start
// down the same blind alley. (Remember-before-check is the regression this
// pins: the write would land on an 'unavailable' result.)
test('fetchMinimaxLimits does not remember a region whose response parsed to no windows', async () => {
  const state = new Map();
  const calls = [];
  const r = await fetchMinimaxLimits({ minimaxApiHost: 'cn' }, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-test' },
    now: () => 1_716_350_000_000,
    providerRuntimeState: state,
    fetch: async (url) => {
      calls.push(url);
      return okResponse({ base_resp: { status_code: 0 } });
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_REMAINS_URL_CN]);
  assert.equal(r.status, 'unavailable');
  assert.equal(state.has(MINIMAX_REGION_MEMORY_STATE_KEY), false);
});

test('fetchMinimaxLimits remembers the region that answered and asks it first on the next probe', async () => {
  const state = new Map();
  const firstCalls = [];
  const secondCalls = [];
  await fetchMinimaxLimits({}, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-cn-only' },
    now: () => 1_716_350_000_000,
    providerRuntimeState: state,
    fetch: async (url) => {
      firstCalls.push(url);
      if (url === MINIMAX_TOKEN_PLAN_REMAINS_URL_EN) throw new Error('fetch failed');
      return okResponse(windowsBody);
    }
  });
  assert.equal(state.get(MINIMAX_REGION_MEMORY_STATE_KEY), 'cn');
  assert.deepEqual(firstCalls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_TOKEN_PLAN_REMAINS_URL_CN]);

  const r = await fetchMinimaxLimits({}, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-cn-only' },
    now: () => 1_716_350_000_000,
    providerRuntimeState: state,
    fetch: async (url) => {
      secondCalls.push(url);
      return okResponse(windowsBody);
    }
  });
  assert.deepEqual(secondCalls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN]);
  assert.equal(r.status, 'ok');
  assert.equal(r.region, 'cn');
});

test('fetchMinimaxLimits does not publish the fallback region auth rejection over a transport failure', async () => {
  // The remembered region (cn) is unreachable; the global endpoints answer
  // with their by-design foreign-key rejection. Publishing that as
  // 'unauthorized' would wipe the retained quota, so the transport failure
  // wins and the state stays untouched.
  const state = new Map([[MINIMAX_REGION_MEMORY_STATE_KEY, 'cn']]);
  const calls = [];
  const r = await fetchMinimaxLimits({}, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-cn-only' },
    now: () => 1_716_350_000_000,
    providerRuntimeState: state,
    fetch: async (url) => {
      calls.push(url);
      if (url === MINIMAX_TOKEN_PLAN_REMAINS_URL_CN) throw new Error('fetch failed');
      return unauthorized();
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_REMAINS_URL_EN]);
  assert.equal(r.status, 'unavailable');
  assert.equal(state.get(MINIMAX_REGION_MEMORY_STATE_KEY), 'cn');
});

test('fetchMinimaxLimits still reports unauthorized when every region rejects the key', async () => {
  const state = new Map([[MINIMAX_REGION_MEMORY_STATE_KEY, 'cn']]);
  const r = await fetchMinimaxLimits({}, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-revoked' },
    now: () => 1_716_350_000_000,
    providerRuntimeState: state,
    fetch: async (url) => {
      if (CN_REMAINS_URLS.has(url)) {
        return okResponse({ base_resp: { status_code: 1004, status_msg: 'cookie is missing, log in again' } });
      }
      return unauthorized();
    }
  });
  assert.equal(r.status, 'unauthorized');
});

test('fetchMinimaxLimits follows a key swapped to the other region and updates the memory', async () => {
  const state = new Map([[MINIMAX_REGION_MEMORY_STATE_KEY, 'cn']]);
  const calls = [];
  const r = await fetchMinimaxLimits({}, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-global-now' },
    now: () => 1_716_350_000_000,
    providerRuntimeState: state,
    fetch: async (url) => {
      calls.push(url);
      if (CN_REMAINS_URLS.has(url)) {
        return okResponse({ base_resp: { status_code: 2049, status_msg: 'invalid api key' } });
      }
      return okResponse(windowsBody);
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_REMAINS_URL_CN, MINIMAX_TOKEN_PLAN_REMAINS_URL_EN]);
  assert.equal(r.status, 'ok');
  assert.equal(r.region, 'en');
  assert.equal(state.get(MINIMAX_REGION_MEMORY_STATE_KEY), 'en');
});

test('MiniMax accepts exact region aliases and hosts, never hostname substrings', () => {
  for (const host of ['minimaxi.com', 'api.minimaxi.com']) assert.equal(minimaxRegion({ minimaxApiRegion: host }), 'cn');
  for (const host of ['minimax.io', 'api.minimax.io']) assert.equal(minimaxRegion({ minimaxApiRegion: host }), 'intl');
  for (const raw of ['evil-minimax.io.example', 'api.minimaxi.com.evil.test', 'https://evil.test/minimax.io', 'api.minimax.io@evil.test']) {
    assert.equal(minimaxRegion({ minimaxApiRegion: raw }), 'auto', raw);
  }
});

test('MiniMax pinned regions retain the legacy endpoint fallback', async () => {
  for (const [region, urls] of [
    ['cn', [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_REMAINS_URL_CN]],
    ['intl', [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_REMAINS_URL_EN]]
  ]) {
    const calls = [];
    const result = await fetchMinimaxLimits({ minimaxApiRegion: region, minimaxApiKey: 'sk-cp-test' }, {
      env: {}, fetch: async (url) => {
        calls.push(url);
        return calls.length === 1 ? { ok: false, status: 404 } : okResponse({ data: { model_remains: [{ model_name: 'general', current_interval_remaining_percent: 60 }] } });
      }
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(calls, urls);
  }
});

test('settings, legacy options, and env pins override opposite region memory on failures', async () => {
  for (const [setting, region, url, opposite] of [
    ['cn', 'cn', MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, 'en'],
    ['intl', 'en', MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, 'cn']
  ]) {
    const pins = [
      [{ minimaxApiRegion: setting }, {}],
      [{ minimaxApiHost: region }, {}],
      [{}, { TOKEN_MONITOR_MINIMAX_API_REGION: setting }],
      [{}, { MINIMAX_API_REGION: setting }],
      [{}, { MINIMAX_API_HOST: new URL(url).hostname }]
    ];
    for (const [options, env] of pins) {
      const state = new Map([[MINIMAX_REGION_MEMORY_STATE_KEY, opposite]]);
      const calls = [];
      const result = await fetchMinimaxLimits({ ...options, minimaxApiKey: 'sk-cp-test' }, {
        env, providerRuntimeState: state,
        fetch: async (requestUrl) => {
          calls.push(requestUrl);
          throw new Error('net::ERR_NAME_NOT_RESOLVED');
        }
      });
      assert.deepEqual(calls, [url]);
      assert.equal(result.status, 'unavailable');
      assert.equal(state.get(MINIMAX_REGION_MEMORY_STATE_KEY), opposite);
    }
  }
});

test('explicit Auto overrides an env pin and probes the remembered region first', async () => {
  const state = new Map([[MINIMAX_REGION_MEMORY_STATE_KEY, 'en']]);
  const calls = [];
  const result = await fetchMinimaxLimits({ minimaxApiRegion: 'auto', minimaxApiKey: 'sk-cp-test' }, {
    env: { MINIMAX_API_REGION: 'cn' }, providerRuntimeState: state,
    fetch: async (url) => {
      calls.push(url);
      return okResponse(windowsBody);
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN]);
  assert.equal(result.status, 'ok');
  assert.equal(result.region, 'en');
});

test('a pinned legacy endpoint success updates memory for a later Auto probe', async () => {
  const state = new Map([[MINIMAX_REGION_MEMORY_STATE_KEY, 'en']]);
  const calls = [];
  const deps = {
    env: {}, providerRuntimeState: state,
    fetch: async (url) => {
      calls.push(url);
      return url === MINIMAX_TOKEN_PLAN_REMAINS_URL_CN
        ? { ok: false, status: 404 }
        : okResponse(windowsBody);
    }
  };
  const options = { minimaxApiKey: 'sk-cp-test' };
  const pinned = await fetchMinimaxLimits({ ...options, minimaxApiRegion: 'cn' }, deps);
  assert.equal(pinned.status, 'ok');
  assert.equal(state.get(MINIMAX_REGION_MEMORY_STATE_KEY), 'cn');
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_REMAINS_URL_CN]);
  calls.length = 0;
  const auto = await fetchMinimaxLimits({ ...options, minimaxApiRegion: 'auto' }, deps);
  assert.equal(auto.status, 'ok');
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_REMAINS_URL_CN]);
});

test('Auto advances to the other region after the per-request timeout aborts', { timeout: 5000 }, async () => {
  const calls = [];
  const state = new Map();
  const result = await fetchMinimaxLimits({ minimaxApiKey: 'sk-cp-test' }, {
    env: {}, providerRuntimeState: state, fetchTimeoutMs: 10,
    fetch: async (url, init) => {
      calls.push(url);
      if (url === MINIMAX_TOKEN_PLAN_REMAINS_URL_CN) return okResponse(windowsBody);
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_TOKEN_PLAN_REMAINS_URL_CN]);
  assert.equal(result.status, 'ok');
  assert.equal(state.get(MINIMAX_REGION_MEMORY_STATE_KEY), 'cn');
});

test('MiniMax stops the superseded probe before retrying another region with the old key', { timeout: 5000 }, async () => {
  const calls = [];
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const runtime = createLimitsRuntime({
    limitProviders: ['minimax'], minimaxApiKey: 'sk-cp-old', minimaxApiRegion: 'auto'
  }, {
    autoStart: false, autoRetry: false, env: {}, homeDir: emptyHome,
    fetch: async (url, init) => {
      calls.push({ url, authorization: init.headers.Authorization });
      if (init.signal.aborted) throw init.signal.reason;
      if (init.headers.Authorization === 'Bearer sk-cp-old') {
        firstStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      }
      return okResponse(windowsBody);
    }
  });
  try {
    const first = runtime.refresh({ provider: 'minimax' }, 'manual');
    await started;
    runtime.reconfigure({ minimaxApiKey: 'sk-cp-new', minimaxApiRegion: 'cn' });
    runtime.clear({ provider: 'minimax' }, 'settings-change');
    await runtime.refresh({ provider: 'minimax' }, 'settings-change');
    await first;
    assert.deepEqual(calls, [
      { url: MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, authorization: 'Bearer sk-cp-old' },
      { url: MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, authorization: 'Bearer sk-cp-new' }
    ]);
    const row = runtime.getSnapshot().providers[0];
    assert.equal(row.status, 'ok');
    assert.equal(row.region, 'cn');
  } finally {
    runtime.stop();
  }
});

test('Auto retries the other region when a response body disconnects during reading', async () => {
  const calls = [];
  const result = await fetchMinimaxLimits({ minimaxApiKey: 'sk-cp-test' }, {
    env: {},
    fetch: async (url) => {
      calls.push(url);
      return url === MINIMAX_TOKEN_PLAN_REMAINS_URL_EN
        ? { ok: true, status: 200, json: async () => { throw new TypeError('terminated'); } }
        : okResponse(windowsBody);
    }
  });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_TOKEN_PLAN_REMAINS_URL_CN]);
  assert.equal(result.status, 'ok');
});

test('fallback HTTP and body auth rejections after transport failure stay unavailable', async () => {
  const rejections = [
    { ok: false, status: 401 },
    { ok: false, status: 403 },
    okResponse({ base_resp: { status_code: 1004, status_msg: 'cookie is missing, log in again' } }),
    okResponse({ base_resp: { status_code: 2049, status_msg: 'invalid api key' } })
  ];
  for (const rejection of rejections) {
    const state = new Map([[MINIMAX_REGION_MEMORY_STATE_KEY, 'cn']]);
    const calls = [];
    const result = await fetchMinimaxLimits({ minimaxApiKey: 'sk-cp-test' }, {
      env: {}, providerRuntimeState: state,
      fetch: async (url) => {
        calls.push(url);
        if (url === MINIMAX_TOKEN_PLAN_REMAINS_URL_CN) throw new Error('fetch failed');
        return rejection;
      }
    });
    assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_REMAINS_URL_EN]);
    assert.equal(result.status, 'unavailable');
    assert.equal(state.get(MINIMAX_REGION_MEMORY_STATE_KEY), 'cn');
  }
});

test('MiniMax runtime retains quota after an outage and honors pinned-to-Auto changes', async () => {
  const calls = [];
  let outage = false;
  const runtime = createLimitsRuntime({
    limitProviders: ['minimax'], minimaxApiKey: 'sk-cp-test', minimaxApiRegion: 'auto'
  }, {
    autoStart: false, autoRetry: false, env: {}, homeDir: emptyHome,
    fetch: async (url, init) => {
      calls.push(url);
      assert.equal(init.headers.Authorization, 'Bearer sk-cp-test');
      if (url === MINIMAX_TOKEN_PLAN_REMAINS_URL_CN) {
        if (outage) throw new Error('fetch failed');
        return okResponse(windowsBody);
      }
      return outage ? unauthorized() : okResponse(windowsBody);
    },
    providerRuntimeState: new Map([[MINIMAX_REGION_MEMORY_STATE_KEY, 'cn']])
  });
  try {
    await runtime.refresh({ provider: 'minimax' }, 'manual');
    const good = runtime.getSnapshot().providers[0];
    assert.equal(good.status, 'ok');
    assert.equal(good.region, 'cn');
    assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN]);

    outage = true;
    calls.length = 0;
    await runtime.refresh({ provider: 'minimax' }, 'manual');
    const retained = runtime.getSnapshot().providers[0];
    assert.equal(retained.status, 'unavailable');
    assert.equal(retained.accountKey, good.accountKey);
    assert.equal(retained.region, 'cn');
    assert.deepEqual(retained.windows, good.windows);
    assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_REMAINS_URL_EN]);

    outage = false;
    calls.length = 0;
    runtime.reconfigure({ minimaxApiRegion: 'intl' });
    runtime.clear({ provider: 'minimax' }, 'settings-change');
    await runtime.refresh({ provider: 'minimax' }, 'settings-change');
    assert.equal(runtime.getSnapshot().providers[0].region, 'en');
    assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN]);

    calls.length = 0;
    runtime.reconfigure({ minimaxApiRegion: 'auto' });
    runtime.clear({ provider: 'minimax' }, 'settings-change');
    await runtime.refresh({ provider: 'minimax' }, 'settings-change');
    assert.equal(runtime.getSnapshot().providers[0].status, 'ok');
    assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN]);
  } finally {
    runtime.stop();
  }
});

const CODE_NOW = 1790000000000;
const CODE_RECORD_KEY = 'com.minimax.mcode.oauth.prod.cn\0deadbeef';
const OTHER_RECORD_KEY = 'com.someother.identity prod';
const ACCESS_ONFILE = 'test-access-onfile';
const REFRESH_ONFILE = 'test-refresh-onfile';
const ACCESS_ROTATED = 'test-access-rotated';
const REFRESH_ROTATED = 'test-refresh-rotated';
const ACCESS_RENEWED = 'test-access-renewed';
const ACCESS_OTHER = 'test-access-other-record';
const REFRESH_OTHER = 'test-refresh-other-record';

function codeDesktopRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    accessToken: ACCESS_ONFILE,
    refreshToken: REFRESH_ONFILE,
    tokenType: 'Bearer',
    clientId: 'mcode-public',
    scopes: ['agent.default'],
    audience: 'agent-backend',
    expiresAtMs: CODE_NOW + 55 * 60 * 1000,
    generation: 7,
    loginEpoch: 'epoch-1',
    ...overrides
  };
}

function codeDesktopState(record = codeDesktopRecord(), overrides = {}) {
  return {
    schemaVersion: 2, status: 'authenticated', storeKind: 'file', clientId: 'mcode-public',
    scopes: record.scopes, audience: 'agent-backend', buildEnv: 'prod', region: 'cn',
    generation: record.generation, expiresAtMs: Number(record.expiresAtMs), ...overrides
  };
}

function writeCodeAuthStore(base, { record, records = { [CODE_RECORD_KEY]: codeDesktopRecord(record) }, state, region = 'cn' } = {}) {
  const account = createHash('sha256').update(`${path.join(base, 'auth')}\0mcode-public`).digest('base64url');
  const recordKey = `com.minimax.mcode.oauth.prod.${region}\0${account}`;
  const selected = records[CODE_RECORD_KEY];
  records = Object.fromEntries(Object.entries(records).map(([key, value]) => [key === CODE_RECORD_KEY ? recordKey : key, value]));
  const dir = path.join(base, 'auth', 'prod', region, 'mcode-public');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const authPath = path.join(dir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ schemaVersion: 1, records }, null, 2), { mode: 0o600 });
  const statePath = path.join(dir, 'auth-state.json');
  if (state !== false) { fs.writeFileSync(statePath, JSON.stringify(codeDesktopState(selected, { region, ...state }), null, 2)); }
  return { base, dir, authPath, statePath, recordKey, region };
}

function writeCodeAuthFixture(options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? 'minimax-code-auth-'));
  test.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return writeCodeAuthStore(base, options);
}

function membershipBody(overrides = {}) {
  return {
    op_credit_summary: { total_remaining_amount: '4624' },
    op_group_id: 'grp-123',
    has_token_plan: true,
    ...overrides
  };
}

function planRemainsBody(overrides = {}) {
  return {
    base_resp: { status_code: 0 },
    model_remains: [{
      model_name: 'general',
      current_interval_total_percent: '100',
      current_interval_used_percent: '30',
      current_interval_status: 1,
      current_weekly_total_percent: '100',
      current_weekly_used_percent: '10',
      current_weekly_status: 1
    }],
    ...overrides
  };
}

const readCode = deps => fetchMinimaxLimits({ minimaxBillingMode: 'api' }, deps);

function assertFields(actual, expected, message) {
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, actual[key]])), expected, message);
}

function storedLease(fixture) {
  return JSON.parse(fs.readFileSync(fixture.authPath, 'utf8')).records[fixture.recordKey];
}

function storedState(fixture) {
  return JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
}

function writeCodeLease(fixture, record, state = {}) {
  fs.writeFileSync(fixture.authPath, JSON.stringify({ schemaVersion: 1, records: { [fixture.recordKey]: record } }));
  fs.writeFileSync(fixture.statePath, JSON.stringify(codeDesktopState(record, { region: fixture.region, ...state })));
}

function codeDeps(fixture, fetchImpl, extra = {}) {
  const requests = [];
  const transport = extra.fetch || (async (url, init) => {
    if (url.endsWith('/matrix/api/v1/user/get_user_extra_info')) return okResponse({ workspaces: [{ workspace_type: 0, workspace_id: 'personal-test' }] });
    if (new URL(url).pathname === '/minimax-cloud/api/v1/credit/details') return okResponse({ details: [], total_count: 0 });
    return fetchImpl(url, init);
  });
  return {
    env: { MINIMAX_DATA_DIR: fixture.base },
    now: () => CODE_NOW,
    existsSync: () => false,
    providerRuntimeState: new Map(),
    ...extra,
    requests,
    fetch: async (...args) => { requests.push(args[0]); return transport(...args); }
  };
}

test('MiniMax Code distinguishes an unreadable store from a missing or empty login', async () => {
  for (const [contents, status] of [[null, 'notConfigured'], ['{invalid-json', 'unavailable'],
    ['not-a-directory', 'unavailable'],
    [JSON.stringify({ schemaVersion: 1, records: [] }), 'unavailable'],
    [JSON.stringify({ schemaVersion: 2, records: {} }), 'unavailable'],
    [JSON.stringify({ schemaVersion: 1, records: {} }), 'notConfigured']]) {
    const fixture = writeCodeAuthFixture();
    if (contents === 'not-a-directory') {
      fs.rmSync(path.join(fixture.base, 'auth'), { recursive: true });
      fs.writeFileSync(path.join(fixture.base, 'auth'), 'damaged store');
    } else if (contents === null) fs.unlinkSync(fixture.authPath);
    else fs.writeFileSync(fixture.authPath, contents);
    const deps = codeDeps(fixture, async () => okResponse(membershipBody()));
    const result = await readCode(deps);
    const label = contents ?? 'missing';
    assert.equal(result.status, status, label);
    assert.equal(result.accountLabel, status === 'notConfigured' ? '' : 'MiniMax Code', label);
    assert.deepEqual(result.windows, [], label);
    assert.deepEqual(deps.requests, [], label);
  }
});

test('MiniMax Code reads the exact live record despite stale siblings without launching the CLI', async () => {
  const fixture = writeCodeAuthFixture({ records: {
    [OTHER_RECORD_KEY]: codeDesktopRecord({ accessToken: ACCESS_OTHER, refreshToken: REFRESH_OTHER, generation: 2, scopes: ['openid'] }),
    ['com.minimax.mcode.oauth.prod.cn\0previous-store']: codeDesktopRecord({ accessToken: ACCESS_OTHER }),
    [CODE_RECORD_KEY]: codeDesktopRecord({ expiresAtMs: CODE_NOW + 5 * 60 * 1000 })
  } });
  const calls = [];
  const result = await readCode(codeDeps(fixture, async (url, init) => {
    calls.push([url, init]);
    if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { workspace_id: 'personal-test' });
      assert.equal(init.headers.authorization, `Bearer ${ACCESS_ONFILE}`);
      return okResponse(membershipBody());
    }
    if (url.startsWith(MINIMAX_CODE_PLAN_REMAINS_URL_CN)) {
      assert.equal(init.method, 'GET');
      assert.equal(url, 'https://www.minimaxi.com/backend/account/token_plan/remains_percent');
      assert.equal(init.headers['X-Group-Id'], 'grp-123');
      assert.equal(init.headers.authorization, `Bearer ${ACCESS_ONFILE}`);
      return okResponse(planRemainsBody());
    }
    throw new Error(`unexpected url ${url}`);
  }, { existsSync: () => true, execFile: () => assert.fail('a live token must not launch the CLI') }));
  assert.equal(result.status, 'ok');
  assert.equal(result.accountLabel, 'MiniMax Code');
  assert.equal(result.source, 'oauth');
  assert.equal(calls.length, 2);
  assertFields(result.windows.find((window) => window.metric === 'credits'),
    { label: 'Credits', remaining: 4624, currency: 'CREDITS', showMeter: false, usedPercent: null, limit: null },
    'membership reports no allowance or percentage, so the summary has no quota meter');
  assert.equal(result.windows.length, 3, 'credits + 5h + weekly');
  assert.equal(result.windows.find(window => window.kind === 'session').usedPercent, 30);
  assert.equal(result.windows.find(window => window.kind === 'weekly').usedPercent, 10);
  assert.ok(result.accountKey && result.accountKey.length > 0);
  assert.equal(JSON.stringify(result).includes(ACCESS_ONFILE), false);
  assertSyncPreservesReading(result);
});

test('MiniMax Code rejects missing, logged-out or inconsistent official auth state before requesting quota', async () => {
  for (const [state, status, record] of [
    [false, 'notConfigured'],
    [{ status: 'anonymous' }, 'unauthorized'],
    [{ status: 'authorizing' }, 'unavailable'],
    [{ generation: 8 }, 'unavailable'],
    [{ status: 'anonymous', schemaVersion: 999 }, 'unavailable'],
    [{}, 'unavailable', { audience: 'other-service' }]
  ]) {
    const fixture = writeCodeAuthFixture({ record, state });
    const deps = codeDeps(fixture, async () => okResponse(membershipBody()));
    const result = await readCode(deps);
    const label = JSON.stringify({ state, record });
    assert.equal(result.status, status, label);
    assert.deepEqual(deps.requests, [], label);
  }
});

test('MiniMax Code selects one personal workspace without changing a selected team', async () => {
  const fixture = writeCodeAuthFixture();
  for (const [workspaces, personalId] of [
    [[{ workspace_type: 1, workspace_id: 9, selected: true }, { workspace_type: 0, workspace_id: 42 }], 42],
    [[{ workspace_type: 1, workspace_id: 9, selected: true }, { workspace_type: 0, workspace_id: 0 }], 0],
    [[{ workspace_type: 1, workspace_id: 9, selected: true }], null],
    [[{ workspace_type: 0, workspace_id: 42 }, { workspace_type: 0, workspace_id: 43 }], null]
  ]) {
    const deps = codeDeps(fixture, null, { fetch: async (url, init) => {
      if (url.endsWith('/user/get_user_extra_info')) return okResponse({ workspaces });
      assert.equal(url, MINIMAX_CODE_MEMBERSHIP_URL_CN);
      assert.deepEqual(JSON.parse(init.body), { workspace_id: personalId });
      return okResponse(membershipBody({ op_group_id: '' }));
    } });
    const result = await readCode(deps);
    assert.equal(result.status, personalId !== null ? 'ok' : 'unavailable');
    assert.equal(deps.requests.length, personalId !== null ? 2 : 1);
    assert.equal(deps.requests.some(url => url.includes('update_default')), false);
  }
});

test('MiniMax Code delegates expiry to the installed CLI using the selected data directory and region', async () => {
  for (const [platform, homeDir, environment, command, region] of [
    ['darwin', '/Users/test', { PATH: '/test/bin' }, '/test/bin/mcode', 'cn'],
    ['linux', '/home/test', {}, '/home/test/.minimax-code/bin/mcode', 'cn'],
    ['linux', '/home/test', { MCODE_INSTALL_DIR: '/custom/install' }, '/custom/install/bin/mcode', 'en'],
    ['win32', 'C:\\Users\\Test User', {}, 'C:\\Users\\Test User\\.minimax-code\\mcode.cmd', 'cn'],
    ['win32', 'C:\\Users\\Test', { AppData: 'D:\\Roaming' }, 'D:\\Roaming\\npm\\mcode.cmd', 'cn'],
    ['win32', 'C:\\Users\\Test', { Path: 'D:\\First;D:\\Tools' }, 'D:\\Tools\\mcode.exe', 'cn'],
    ['win32', 'C:\\Users\\Test', { MCODE_INSTALL_DIR: 'D:\\100% & 测试!^' }, 'D:\\100% & 测试!^\\mcode.cmd', 'cn']
  ]) {
    const fixture = writeCodeAuthFixture({ region, record: { expiresAtMs: CODE_NOW } });
    const calls = [];
    const deps = codeDeps(fixture, async (_url, init) => {
      assert.equal(init.headers.authorization, `Bearer ${ACCESS_ROTATED}`);
      return okResponse(membershipBody({ has_token_plan: false }));
    }, { platform, homeDir, env: { MINIMAX_DATA_DIR: fixture.base, ...environment },
      existsSync: candidate => candidate === command,
      execFile: (executable, args, options, done) => {
        calls.push({ executable, args, options, privateCwd: process.platform === 'win32' || (fs.statSync(options.cwd).mode & 0o077) === 0 });
        writeCodeLease(fixture, codeDesktopRecord({ accessToken: ACCESS_ROTATED, refreshToken: REFRESH_ROTATED, generation: 8 }));
        done(null, '{}');
        return {};
      }
    });
    const row = await readCode(deps);
    assert.equal(row.status, 'ok', command);
    assert.equal(calls.length, 1, command);
    const { executable, args, options, privateCwd } = calls[0];
    const shim = command.endsWith('.cmd');
    assert.equal(executable, shim ? 'cmd.exe' : command);
    assert.deepEqual(args, shim ? ['/d', '/s', '/v:off', '/c', '""%TOKEN_MONITOR_MCODE_COMMAND_PATH%" provider list --json"'] : ['provider', 'list', '--json']);
    if (shim) assert.equal(options.env.TOKEN_MONITOR_MCODE_COMMAND_PATH, command);
    assert.equal(options.env.MINIMAX_DATA_DIR, fixture.base);
    assert.equal(options.env.MAVIS_DATA_DIR, fixture.base);
    assert.equal(options.env.MAVIS_REGION, region);
    assert.equal(options.timeout, 12000);
    assert.equal(privateCwd, true);
    assert.equal(fs.existsSync(options.cwd), false);
    assert.equal(deps.requests.some(url => url.includes('/oauth2/')), false);
  }
});

test('MiniMax Code trusts reread credentials rather than CLI exit status or output', async () => {
  for (const [name, record, state, commandError, status] of [
    ['unchanged', {}, {}, null, 'unauthorized'],
    ['failed command', {}, {}, new Error('offline'), 'unauthorized'],
    ['updated despite command failure', { accessToken: ACCESS_ROTATED, generation: 8 }, {}, new Error('metadata failed'), 'ok'],
    ['expired successor', { accessToken: ACCESS_ROTATED, expiresAtMs: CODE_NOW }, {}, null, 'unavailable'],
    ['new login', { accessToken: ACCESS_ROTATED, loginEpoch: 'new-login' }, {}, null, 'unavailable'],
    ['malformed successor', { accessToken: ACCESS_ROTATED, tokenType: 'Other' }, {}, null, 'unavailable'],
    ['logged out', {}, { status: 'anonymous' }, null, 'unauthorized'],
    ['unfinished commit', { accessToken: ACCESS_ROTATED, generation: 8 }, { status: 'refreshing' }, null, 'unavailable'],
    ['mismatched generation', { accessToken: ACCESS_ROTATED, generation: 8 }, { generation: 9 }, null, 'unavailable']
  ]) {
    const fixture = writeCodeAuthFixture({ record: { expiresAtMs: CODE_NOW } });
    const before = [fixture.authPath, fixture.statePath].map(file => fs.readFileSync(file, 'utf8'));
    let calls = 0;
    const deps = codeDeps(fixture, async () => okResponse(membershipBody({ has_token_plan: false })), {
      env: { MINIMAX_DATA_DIR: fixture.base, PATH: '/test/bin' }, existsSync: candidate => candidate === '/test/bin/mcode',
      execFile: (_command, _args, _options, done) => {
        calls++;
        if (Object.keys(record).length || Object.keys(state).length) writeCodeLease(fixture, codeDesktopRecord(record), state);
        done(commandError, '{"success":true}');
        return {};
      }
    });
    assert.equal((await readCode(deps)).status, status, name);
    assert.equal(calls, 1, name);
    assert.equal(deps.requests.length > 0, status === 'ok', name);
    if (!Object.keys(record).length && !Object.keys(state).length) {
      assert.deepEqual([fixture.authPath, fixture.statePath].map(file => fs.readFileSync(file, 'utf8')), before, name);
    }
  }
});

test('MiniMax Code stays read-only without a CLI, for a different namespace, and before cancellation', async () => {
  for (const name of ['missing CLI', 'missing epoch', 'different namespace', 'workspace-relative PATH', 'cancelled', 'cancelled during lookup']) {
    const fixture = writeCodeAuthFixture({ record: { expiresAtMs: CODE_NOW, ...(name === 'missing epoch' ? { loginEpoch: undefined } : {}) } });
    if (name === 'different namespace') {
      const auth = JSON.parse(fs.readFileSync(fixture.authPath));
      auth.records[CODE_RECORD_KEY] = auth.records[fixture.recordKey];
      delete auth.records[fixture.recordKey];
      fs.writeFileSync(fixture.authPath, JSON.stringify(auth));
    }
    const before = [fixture.authPath, fixture.statePath].map(file => fs.readFileSync(file, 'utf8'));
    const controller = new AbortController();
    if (name === 'cancelled') controller.abort();
    let commands = 0;
    const deps = codeDeps(fixture, async () => assert.fail('expired credentials must not request quota'), {
      signal: controller.signal,
      ...(name === 'workspace-relative PATH' ? { env: { MINIMAX_DATA_DIR: fixture.base, PATH: '.', MCODE_INSTALL_DIR: '.' } } : {}),
      existsSync: command => {
        if (name === 'cancelled during lookup') controller.abort();
        return name === 'workspace-relative PATH' ? command === path.join(process.cwd(), 'mcode') : name !== 'missing CLI';
      },
      execFile: () => { commands++; throw new Error('must not execute'); }
    });
    assert.equal((await readCode(deps)).status, name === 'different namespace' ? 'notConfigured' : 'unavailable', name);
    assert.equal(commands, 0, name);
    assert.deepEqual([fixture.authPath, fixture.statePath].map(file => fs.readFileSync(file, 'utf8')), before, name);
  }
});

test('MiniMax Code lets a started official refresh finish after quota collection is cancelled', async () => {
  const fixture = writeCodeAuthFixture({ record: { expiresAtMs: CODE_NOW } });
  const controller = new AbortController();
  const deps = codeDeps(fixture, async () => assert.fail('cancelled quota must not be requested'), {
    signal: controller.signal, existsSync: () => true,
    execFile: (_command, _args, _options, done) => {
      controller.abort();
      queueMicrotask(() => {
        writeCodeLease(fixture, codeDesktopRecord({ accessToken: ACCESS_ROTATED, generation: 8 }));
        done(null, '{}');
      });
      return { kill: () => assert.fail('quota cancellation must not stop official rotation') };
    }
  });
  assert.equal((await readCode(deps)).status, 'unavailable');
  assert.equal(storedLease(fixture).accessToken, ACCESS_ROTATED);
  assert.equal(storedState(fixture).status, 'authenticated');
});

test('MiniMax Code delegates through a real POSIX launcher with spaces and special characters', { skip: process.platform === 'win32' }, async () => {
  const fixture = writeCodeAuthFixture({ prefix: 'minimax 用户 data % &-', record: { expiresAtMs: CODE_NOW } });
  const install = path.join(fixture.base, 'CLI 安装 % &');
  const directory = path.join(install, 'bin');
  fs.mkdirSync(directory, { recursive: true });
  const launcher = path.join(directory, 'mcode');
  fs.writeFileSync(launcher, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
assert.deepEqual(process.argv.slice(2), ['provider', 'list', '--json']);
const directory = path.join(process.env.MINIMAX_DATA_DIR, 'auth', 'prod', process.env.MAVIS_REGION, 'mcode-public');
const authPath = path.join(directory, 'auth.json'), statePath = path.join(directory, 'auth-state.json');
const auth = JSON.parse(fs.readFileSync(authPath)), state = JSON.parse(fs.readFileSync(statePath));
const record = Object.values(auth.records)[0];
record.accessToken = '${ACCESS_ROTATED}'; record.expiresAtMs = ${CODE_NOW + 3600000}; record.generation++;
state.generation = record.generation; state.expiresAtMs = record.expiresAtMs;
fs.writeFileSync(authPath, JSON.stringify(auth)); fs.writeFileSync(statePath, JSON.stringify(state));
process.stdout.write('{}');
`, { mode: 0o700 });
  const deps = codeDeps(fixture, async () => okResponse(membershipBody({ has_token_plan: false })), {
    execFile: undefined, existsSync: candidate => candidate === launcher,
    env: { MINIMAX_DATA_DIR: fixture.base, MCODE_INSTALL_DIR: install, PATH: path.dirname(process.execPath) }
  });
  assert.equal((await readCode(deps)).status, 'ok');
  assert.equal(storedLease(fixture).accessToken, ACCESS_ROTATED);
});

test('MiniMax Code failure retains its points without invalidating the API wallet', async () => {
  const fixture = writeCodeAuthFixture();
  let codeDown = false;
  const deps = codeDeps(fixture, async url => {
    if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) return codeDown ? { ok: false, status: 503 }
      : okResponse(membershipBody({ has_token_plan: false }));
    const route = new URL(url).pathname;
    if (route === '/account/query_balance') return okResponse({ available_amount: '14.97', base_resp: { status_code: 0 } });
    if (route === '/v1/token_plan/remains') return okResponse({ model_remains: null, base_resp: { status_code: 2062 } });
    if (route === '/account/query_recharge') return okResponse({ cash_total_usage: '44', base_resp: { status_code: 0 } });
    assert.equal(route, '/account/amount');
    return okResponse({ consume_cash_after_voucher_sum: '0', base_resp: { status_code: 0 } });
  });
  const runtime = createLimitsRuntime({ limitProviders: ['minimax'], minimaxApiRegion: 'cn',
    minimaxBillingMode: 'api', minimaxApiKey: 'key-A' }, { ...deps, autoStart: false, autoRetry: false });
  try {
    await runtime.refresh({ provider: 'minimax' }, 'manual');
    const code = runtime.getSnapshot().providers.find(row => row.source === 'oauth');
    assert.equal(code.status, 'ok');
    assert.equal(code.balance, null);
    codeDown = true;
    await runtime.refresh({ provider: 'minimax' }, 'manual');
    const rows = runtime.getSnapshot().providers;
    assert.equal(rows.find(row => row.source === 'api').status, 'ok');
    assert.equal(rows.find(row => row.source === 'api').balance.amount, 14.97);
    const stale = rows.find(row => row.source === 'oauth');
    assert.equal(stale.status, 'unavailable');
    assert.equal(stale.accountKey, code.accountKey);
    assert.deepEqual(stale.windows, code.windows);
  } finally { runtime.stop(); }
});

test('MiniMax display affiliation recognizes group responses without affecting either lane', async (t) => {
  const fixture = writeCodeAuthFixture();
  const options = { minimaxApiRegion: 'cn', minimaxBillingMode: 'api', minimaxApiKey: 'key-A' };
  const cases = [
    ['no subscription', { base_resp: { status_code: 2062 }, model_remains: null }, true],
    ['quota success', { base_resp: { status_code: 0 }, model_remains: [] }, true],
    ['foreign group', { base_resp: { status_code: 1004 } }, false],
    ['unknown code', { base_resp: { status_code: 1001 }, model_remains: [] }, false],
    ['missing code', { model_remains: [] }, false],
    ['missing rows', { base_resp: { status_code: 0 } }, false],
    ['transport failure', null, false],
    ['cancelled confirmation', { base_resp: { status_code: 2062 }, model_remains: [] }, false]
  ];
  for (const [name, response, linked] of cases) await t.test(name, async () => {
    let confirmations = 0;
    const controller = new AbortController();
    const deps = codeDeps(fixture, async (url, init) => {
      if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) return okResponse(membershipBody({ has_token_plan: false }));
      const target = new URL(url);
      assert.equal(target.host, 'api.minimaxi.com');
      assert.equal(init.headers.Authorization, 'Bearer key-A');
      if (target.pathname === '/v1/token_plan/remains') {
        assert.equal(target.searchParams.get('GroupId'), 'grp-123');
        confirmations++;
        if (name === 'transport failure') throw new TypeError('connection reset');
        if (name === 'cancelled confirmation') controller.abort();
        return okResponse(response);
      }
      if (target.pathname === '/account/query_balance') return okResponse({ available_amount: '14.97', base_resp: { status_code: 0 } });
      assert.ok(['/account/query_recharge', '/account/amount'].includes(target.pathname));
      return okResponse({ base_resp: { status_code: 0 } });
    });
    const rows = await fetchMinimaxLimits(options, {
      ...deps, signal: controller.signal,
      ...(name === 'quota success' ? { providerRuntimeState: undefined } : {})
    });
    const api = rows.find(row => row.source === 'api');
    const code = rows.find(row => row.source === 'oauth');
    assert.equal(api.status, 'ok');
    assert.equal(code.status, 'ok');
    assert.equal(api.relatedAccountKey, linked ? code.accountKey : undefined);
    assert.equal(code.relatedAccountKey, linked ? api.accountKey : undefined);
    assert.equal(confirmations, 1);
  });
});

test('MiniMax display links survive refreshes and follow the current key and Code group', async () => {
  const fixture = writeCodeAuthFixture();
  let group = 'group-A';
  let confirmations = 0;
  let apiDenied = false;
  const deps = codeDeps(fixture, async (url, init) => {
    if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) return okResponse(membershipBody({ has_token_plan: false, op_group_id: group }));
    const target = new URL(url);
    if (target.pathname === '/v1/token_plan/remains' && target.searchParams.has('GroupId')) {
      confirmations++;
      const ownGroup = init.headers.Authorization === 'Bearer key-A' ? 'group-A' : 'group-B';
      return okResponse(target.searchParams.get('GroupId') === ownGroup
        ? { base_resp: { status_code: 2062 }, model_remains: null }
        : { base_resp: { status_code: 1004 } });
    }
    if (target.pathname === '/v1/token_plan/remains') return okResponse(windowsBody);
    if (target.pathname === '/account/query_balance') return apiDenied ? unauthorized()
      : okResponse({ available_amount: '14.97', base_resp: { status_code: 0 } });
    if (target.pathname === '/account/query_recharge') return okResponse({ cash_total_usage: '0', base_resp: { status_code: 0 } });
    assert.equal(target.pathname, '/account/amount');
    return okResponse({ consume_cash_after_voucher_sum: '0', base_resp: { status_code: 0 } });
  });
  const runtime = createLimitsRuntime({ limitProviders: ['minimax'], minimaxApiRegion: 'cn',
    minimaxBillingMode: 'api', minimaxApiKey: 'key-A' }, { ...deps, autoStart: false, autoRetry: false });
  const rows = () => runtime.getSnapshot().providers;
  try {
    await runtime.refresh({ provider: 'minimax' }, 'manual');
    const first = rows();
    const codeA = first.find(row => row.source === 'oauth');
    const apiA = first.find(row => row.source === 'api');
    assert.equal(apiA.relatedAccountKey, codeA.accountKey);
    assert.equal(confirmations, 1);
    writeCodeLease(fixture, codeDesktopRecord({ accessToken: ACCESS_RENEWED, generation: 8 }));
    await runtime.refresh({ provider: 'minimax', accountKey: codeA.accountKey }, 'manual');
    await runtime.refresh({ provider: 'minimax', accountKey: apiA.accountKey }, 'manual');
    assert.equal(confirmations, 1, 'normal rotation and account refresh reuse confirmation');
    assert.ok(rows().every(row => row.relatedAccountKey));

    apiDenied = true;
    await runtime.refresh({ provider: 'minimax' }, 'manual');
    assert.equal(rows().find(row => row.source === 'api').status, 'unauthorized');
    assert.ok(rows().every(row => row.region === 'cn' && row.relatedAccountKey), 'resource rejection does not change a confirmed regional identity');
    apiDenied = false;
    await runtime.refresh({ provider: 'minimax' }, 'manual');
    assert.equal(confirmations, 1);

    runtime.reconfigure({ minimaxApiKey: 'key-B' });
    runtime.clear({ provider: 'minimax', source: 'api' }, 'settings-change');
    await runtime.refresh({ provider: 'minimax' }, 'settings-change');
    assert.equal(confirmations, 2);
    assert.ok(rows().every(row => !row.relatedAccountKey), 'new key cannot inherit the old peer link');
    group = 'group-B';
    await runtime.refresh({ provider: 'minimax', accountKey: codeA.accountKey }, 'manual');
    assert.equal(rows().length, 1, 'a retired account refresh cannot adopt the new Code login');
    await runtime.refresh({ provider: 'minimax' }, 'manual');
    const second = rows();
    assert.equal(confirmations, 3);
    assert.equal(second.find(row => row.source === 'api').relatedAccountKey, second.find(row => row.source === 'oauth').accountKey);
    assert.ok(second.every(row => row.accountKey !== codeA.accountKey));

    runtime.reconfigure({ minimaxBillingMode: 'token-plan' });
    runtime.clear({ provider: 'minimax', source: 'api' }, 'settings-change');
    await runtime.refresh({ provider: 'minimax' }, 'settings-change');
    assert.equal(confirmations, 3, 'subscription-key mode has not been live-verified for this protocol');
    assert.ok(rows().every(row => row.relatedAccountKey), 'billing type does not change an already verified key/group relationship');
    runtime.reconfigure({ minimaxApiKey: 'key-C' });
    runtime.clear({ provider: 'minimax', source: 'api' }, 'settings-change');
    await runtime.refresh({ provider: 'minimax' }, 'settings-change');
    assert.equal(confirmations, 3, 'a new subscription key must remain unverified');
    assert.ok(rows().every(row => !row.relatedAccountKey));
    runtime.reconfigure({ minimaxBillingMode: 'api', minimaxApiRegion: 'intl' });
    runtime.clear({ provider: 'minimax' }, 'settings-change');
    await runtime.refresh({ provider: 'minimax' }, 'settings-change');
    assert.equal(confirmations, 3);
    assert.ok(rows().every(row => row.region === 'en' && !row.relatedAccountKey));
  } finally { runtime.stop(); }
});

test('MiniMax Code follows workspace, membership and matched current-subscription name precedence', async () => {
  const fixture = writeCodeAuthFixture();
  const subscription = {
    current_subscribe: { curr_subscribe_combo_id: '12345', current_subscribe_title: 'Current subscription' },
    current_combo_card: { combo_id: 12345, title: 'Build' }
  };
  const names = [
    [okResponse(subscription), 'Build'],
    [okResponse({ ...subscription, current_combo_card: { combo_id: 'other', title: 'Wrong card' } }), 'Current subscription'],
    [okResponse({ ...subscription, current_combo_card: { combo_id: 12345, title: '12345' } }), 'Current subscription'],
    [okResponse({ ...subscription, current_subscribe: { curr_subscribe_combo_id: 'other' } }), 'Subscription'],
    [okResponse({ current_combo_card: subscription.current_combo_card }), 'Subscription'],
    [okResponse({ current_subscribe: { curr_subscribe_combo_id: 12345, current_subscribe_title: '12345' } }), 'Subscription'],
    [{ ok: false, status: 403 }, 'Subscription'],
    [okResponse({ base_resp: { status_code: 1004 } }), 'Subscription']
  ];
  for (const [workspace, membership, expected, group, hasPlan, planLabel, metadata] of [
    ...names.map(([response, label]) => [{ token_plan_tier: '12345' }, membershipBody(), 4624, 'grp-123', true, label, response]),
    [{ token_plan_tier: '12345' }, membershipBody({ op_credit_summary: { total_remaining_amount: '0' } }), 0, 'grp-123', true, 'Build', okResponse(subscription)],
    [{ opcredit_balance: '1,234', op_group_id: 'workspace-group', token_plan_tier: 'starter' }, membershipBody({
      token_plan_tier: 'other', has_token_plan: false,
      op_credit_summary: { total_remaining_amount: '4624', purchased_remaining_amount: '1000', free_remaining_amount: '500' }
    }), 4624, 'workspace-group', true, 'starter'],
    [{ opcredit_balance: '1,234', has_token_plan: true }, membershipBody({ has_token_plan: false, op_credit_summary: null }), 1234, 'grp-123', true, 'Subscription'],
    [{}, membershipBody({ has_token_plan: false, token_plan_tier: 'starter', op_credit_summary: { total_remaining_amount: 'invalid' }, opcredit_balance: '321' }), 321, 'grp-123', true, 'starter'],
    [{ opcredit_balance: 'invalid' }, membershipBody({ op_credit_summary: null, opcredit_balance: 321 }), null, 'grp-123', false, 'Subscription'],
    [{ token_plan_tier: '12345' }, membershipBody(), 4624, 'grp-123', true, 'Subscription'],
    [{}, membershipBody({ has_token_plan: false, plan_name: 'Free' }), 4624, 'grp-123', false, 'Free']
  ]) {
    const groups = [];
    let commands = 0;
    const deps = codeDeps(fixture, null, {
      existsSync: () => true,
      execFile: () => { commands++; throw new Error('unexpected CLI'); },
      fetch: async (url, init) => {
        if (url.endsWith('/user/get_user_extra_info')) return okResponse({ workspaces: [{ workspace_type: 0, workspace_id: 0, ...workspace }] });
        if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) return okResponse(membership);
        if (new URL(url).pathname === '/minimax-cloud/api/v1/credit/details') return okResponse({ details: [], total_count: 0 });
        groups.push(init.headers['X-Group-Id']);
        if (new URL(url).pathname.endsWith('/charge/combo/cycle_audio_resource_package')) {
          assert.equal(init.headers.authorization, `Bearer ${ACCESS_ONFILE}`);
          assert.deepEqual(Object.fromEntries(new URL(url).searchParams), { biz_line: '2', cycle_type: '3', resource_package_type: '7', business: 'Agent', device_platform: 'desktop' });
          return metadata || okResponse({});
        }
        return url === MINIMAX_CODE_PLAN_REMAINS_URL_CN ? okResponse(planRemainsBody()) : okResponse({});
      }
    });
    const result = await readCode(deps);
    assert.equal(result.status, expected === null ? 'unavailable' : 'ok');
    assert.equal(result.planLabel, planLabel);
    assert.equal(result.windows.find(window => window.label === 'Credits')?.remaining ?? null, expected);
    assert.equal(deps.requests.includes(MINIMAX_CODE_PLAN_REMAINS_URL_CN), hasPlan);
    assert.deepEqual(groups, hasPlan ? Array(metadata || workspace.token_plan_tier === '12345' ? 2 : 1).fill(group) : []);
    assert.equal(commands, 0, 'optional metadata must not trigger delegated renewal');
    assert.equal(result.windows.filter(window => window.metric !== 'credits').length, hasPlan ? 2 : 0);
  }
});

test('MiniMax Code meters a complete grant list and keeps the amount when the list is incomplete', async () => {
  const fixture = writeCodeAuthFixture();
  const grant = (amount, remaining) => ({ credit_type: 2, granted_amount: String(amount),
    remaining_amount: String(remaining), consumed_amount: String(amount - remaining),
    granted_at_ms: CODE_NOW - 1000, expire_at_ms: CODE_NOW + 86400000 });
  const read = async (pages, credits) => {
    let detailPages = 0;
    const result = await readCode(codeDeps(fixture, null, { fetch: async (url) => {
      const parsed = new URL(url);
      if (url.endsWith('/user/get_user_extra_info')) return okResponse({ workspaces: [{ workspace_type: 0, workspace_id: 0 }] });
      if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) return okResponse(membershipBody({ has_token_plan: false,
        op_credit_summary: { total_remaining_amount: String(credits) } }));
      if (parsed.pathname === '/minimax-cloud/api/v1/credit/details') {
        detailPages++;
        assert.deepEqual(Object.fromEntries(parsed.searchParams), {
          page_number: String(detailPages), page_size: '100', include_expired: 'false'
        });
        return okResponse(pages[detailPages - 1]);
      }
      assert.fail(`unexpected Code request: ${url}`);
    } }));
    assert.equal(result.status, 'ok');
    assert.equal(detailPages, pages.length, 'only the pages needed to establish a denominator are requested');
    assertSyncPreservesReading(result);
    return result.windows.find(window => window.label === 'Credits');
  };
  assertFields(await read([{ details: [grant(100, 50)], total_count: 1 }], 50),
    { remaining: 50, currency: 'CREDITS', limit: 100, showMeter: true }, 'complete grant list');
  assertFields(await read([{ details: [grant(100, 50)], total_count: 2 }, { details: [], total_count: 2 }], 50),
    { remaining: 50, limit: null, showMeter: false }, 'incomplete grant list');
  assertFields(await read([{ details: Array.from({ length: 100 }, () => grant(1, 0.5)), total_count: 1001 }], 50),
    { remaining: 50, limit: null, showMeter: false }, 'history beyond the collection bound');
});

test('MiniMax Code parses modern plan percentages, unlimited quota and video counts', async () => {
  const fixture = writeCodeAuthFixture();
  for (const [reportedTotal, expectedPercent] of [[undefined, 15], ['50%', 30]]) {
    const result = await readCode(codeDeps(fixture, async url => {
      if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) return okResponse(membershipBody());
      return okResponse({ base_resp: { status_code: 0 }, model_remains: [
        { model_name: 'general', current_interval_status: 3, current_weekly_total_percent: reportedTotal, current_weekly_used_percent: '15% ', weekly_end_time: 1790003600000 },
        { model_name: 'video', current_interval_total_count: '20', current_interval_used_count: '3', end_time: 1790007200000 }
      ] });
    }));
    const session = result.windows.find(window => window.label === '5h');
    assert.equal(session.detail, 'unlimited');
    assert.equal(session.showMeter, false);
    assert.equal(session.usedPercent, null);
    assert.equal(result.windows.find(window => window.label === 'Weekly').usedPercent, expectedPercent);
    assertFields(result.windows.find(window => window.label === 'Video'),
      { used: 3, limit: 20, remaining: 17, usedPercent: 15, remainingPercent: 85, resetsAt: new Date(1790007200000).toISOString() });
    assertSyncPreservesReading(result);
  }
});

test('MiniMax Code partial refresh updates credits and retains visibly stale plan windows', async () => {
  const fixture = writeCodeAuthFixture();
  let outage = false;
  let timestamp = CODE_NOW;
  const runtime = createLimitsRuntime({ limitProviders: ['minimax'], minimaxBillingMode: 'api' }, {
    ...codeDeps(fixture, async url => {
      if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) return okResponse(membershipBody({ token_plan_tier: '12345', op_credit_summary: { total_remaining_amount: outage ? '4000' : '4624' } }));
      if (new URL(url).pathname.endsWith('/charge/combo/cycle_audio_resource_package')) {
        return okResponse({ current_subscribe: { curr_subscribe_combo_id: '12345', current_subscribe_title: 'Build' } });
      }
      return outage ? { ok: false, status: 503 } : okResponse(planRemainsBody());
    }),
    now: () => timestamp, autoStart: false, autoRetry: false
  });
  try {
    await runtime.refresh({ provider: 'minimax' }, 'manual');
    const first = runtime.getSnapshot().providers[0];
    assert.equal(first.status, 'ok');
    assert.equal(first.planLabel, 'Build');
    assert.equal(first.windows.filter(window => window.metric !== 'credits').length, 2);
    outage = true;
    timestamp += 60000;
    await runtime.refresh({ provider: 'minimax' }, 'manual');
    const partial = runtime.getSnapshot().providers[0];
    assert.equal(partial.status, 'unavailable');
    assert.equal(partial.planLabel, 'Build', 'quota failure must not suppress an available subscription name');
    assert.equal(partial.updatedAt, first.updatedAt);
    assert.equal(partial.windows.find(window => window.metric === 'credits').remaining, 4000);
    assert.deepEqual(partial.windows.filter(window => window.metric !== 'credits'), first.windows.filter(window => window.metric !== 'credits'));
    assert.equal('invalidateCachedWindowLabels' in partial, false);
  } finally {
    runtime.stop();
  }
});

test('MiniMax Code does not turn a cancelled plan or name request into a successful credits reading', async () => {
  for (const lane of ['plan', 'name']) {
    const fixture = writeCodeAuthFixture();
    const controller = new AbortController();
    const cancelledPath = lane === 'plan' ? new URL(MINIMAX_CODE_PLAN_REMAINS_URL_CN).pathname
      : '/v1/api/openplatform/charge/combo/cycle_audio_resource_package';
    const deps = codeDeps(fixture, async url => {
      if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) return okResponse(membershipBody({ token_plan_tier: lane === 'name' ? '12345' : undefined }));
      if (lane === 'name' && url === MINIMAX_CODE_PLAN_REMAINS_URL_CN) return okResponse(planRemainsBody());
      assert.equal(new URL(url).pathname, cancelledPath);
      controller.abort();
      throw controller.signal.reason;
    }, { signal: controller.signal });
    const result = await readCode(deps);
    assert.equal(new URL(deps.requests.at(-1)).pathname, cancelledPath);
    assert.equal(controller.signal.aborted, true);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.windows, []);
  }
});

test('MiniMax Code lane treats 2062 as no subscription, not an error', async () => {
  const fixture = writeCodeAuthFixture();
  const deps = codeDeps(fixture, async (url) => {
    if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) return okResponse(membershipBody());
    if (url.startsWith(MINIMAX_CODE_PLAN_REMAINS_URL_CN)) {
      return okResponse(planRemainsBody({ base_resp: { status_code: 2062, status_msg: 'no active token plan subscription' } }));
    }
    throw new Error(`unexpected url ${url}`);
  });
  const result = await readCode(deps);
  assert.equal(deps.requests.filter(url => url === MINIMAX_CODE_PLAN_REMAINS_URL_CN).length, 1);
  assert.equal(result.status, 'ok');
  assert.equal(result.windows.length, 1, 'the credits window stands alone without a subscription');
  assert.equal(result.windows[0].label, 'Credits');
});

test('MiniMax Code key probes and custom OAuth endpoints never touch the lease', async () => {
  const fixture = writeCodeAuthFixture({ record: { expiresAtMs: CODE_NOW - 1000 } });
  const before = [fixture.authPath, fixture.statePath].map(file => fs.readFileSync(file, 'utf8'));
  for (const [name, extra, status, why] of [
    ['key probe', { probe: true }, 'notConfigured', 'a missing key is not vouched for by a local login'],
    ...['MCODE_OAUTH_DEVICE_AUTHORIZATION_ENDPOINT', 'MCODE_OAUTH_TOKEN_ENDPOINT', 'MCODE_OAUTH_REVOCATION_ENDPOINT']
      .map(key => [key, { env: { MINIMAX_DATA_DIR: fixture.base, [key]: 'https://custom.example.test/oauth' } }, 'unavailable',
        'custom domains must not send credentials to the public defaults'])
  ]) {
    const deps = codeDeps(fixture, async () => okResponse(membershipBody()), extra);
    assert.equal((await readCode(deps)).status, status, `${name}: ${why}`);
    assert.deepEqual(deps.requests, [], `${name}: ${why}`);
    assert.deepEqual([fixture.authPath, fixture.statePath].map(file => fs.readFileSync(file, 'utf8')), before, name);
  }
});

test('MiniMax Code lane pins discovery to the selected region', async () => {
  const { base } = writeCodeAuthFixture();
  writeCodeAuthStore(base, { region: 'en', record: { accessToken: ACCESS_OTHER } });
  const seen = [];
  const run = (region) => fetchMinimaxLimits({ minimaxBillingMode: 'api', minimaxApiRegion: region }, {
    env: { MINIMAX_DATA_DIR: base },
    now: () => CODE_NOW,
    fetch: async (url, init) => {
      if (url.endsWith('/matrix/api/v1/user/get_user_extra_info')) return okResponse({ workspaces: [{ workspace_type: 0, workspace_id: 'personal-test' }] });
      if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN || url === 'https://agent.minimax.io/matrix/api/v1/commerce/get_membership_info') {
        seen.push(init.headers.authorization);
        return okResponse(membershipBody({ token_plan_tier: '12345' }));
      }
      const target = new URL(url);
      if (target.pathname === '/minimax-cloud/api/v1/credit/details') return okResponse({ details: [], total_count: 0 });
      if (target.pathname.endsWith('/remains_percent') || target.pathname.endsWith('/cycle_audio_resource_package')) {
        assert.equal(target.origin, region === 'cn' ? 'https://www.minimaxi.com' : 'https://platform.minimax.io');
        assert.equal(init.headers.authorization, region === 'cn' ? `Bearer ${ACCESS_ONFILE}` : `Bearer ${ACCESS_OTHER}`);
        assert.equal(init.headers['X-Group-Id'], 'grp-123');
        return okResponse(target.pathname.endsWith('/remains_percent') ? planRemainsBody()
          : { current_subscribe: { curr_subscribe_combo_id: '12345', current_subscribe_title: 'Build' } });
      }
      throw new Error(`unexpected url ${url}`);
    },
    providerRuntimeState: new Map()
  });
  assert.equal((await run('cn')).planLabel, 'Build');
  assert.deepEqual(seen, [`Bearer ${ACCESS_ONFILE}`], 'cn pin reads the cn store');
  seen.length = 0;
  assert.equal((await run('intl')).planLabel, 'Build');
  assert.deepEqual(seen, [`Bearer ${ACCESS_OTHER}`], 'intl pin skips the cn store');
});

test('MiniMax Code rejects nonprivate credential stores as the official FileStore does', { skip: process.platform === 'win32' }, async () => {
  for (const entry of ['dir', 'authPath']) {
    const fixture = writeCodeAuthFixture();
    const before = fs.readFileSync(fixture.authPath, 'utf8');
    fs.chmodSync(fixture[entry], entry === 'dir' ? 0o755 : 0o644);
    const deps = codeDeps(fixture, async () => okResponse(membershipBody()));
    const result = await readCode(deps);
    assert.equal(result.status, 'unavailable', entry);
    assert.deepEqual(deps.requests, [], entry);
    assert.equal(fs.readFileSync(fixture.authPath, 'utf8'), before, entry);
  }
});

test('MiniMax Code retries HTTP and body auth failures in membership and plan requests', async () => {
  for (const lane of ['membership', 'plan']) {
    for (const [name, response] of [
      ['HTTP 401', unauthorized()], ['HTTP 403', { ok: false, status: 403 }],
      ['body 1004', okResponse({ base_resp: { status_code: 1004 } })]
    ]) {
      const fixture = writeCodeAuthFixture();
      let rotations = 0;
      let failures = 0;
      const deps = codeDeps(fixture, async (url, init) => {
        assert.equal(init.headers.authorization, `Bearer ${rotations ? ACCESS_ROTATED : ACCESS_ONFILE}`);
        const target = lane === 'membership' ? url === MINIMAX_CODE_MEMBERSHIP_URL_CN : url.startsWith(MINIMAX_CODE_PLAN_REMAINS_URL_CN);
        if (target && failures++ === 0) return response;
        return okResponse(url === MINIMAX_CODE_MEMBERSHIP_URL_CN ? membershipBody() : planRemainsBody());
      }, {
        existsSync: command => command === '/test/bin/mcode', env: { MINIMAX_DATA_DIR: fixture.base, PATH: '/test/bin' },
        execFile: (_command, _args, _options, done) => {
          rotations++;
          writeCodeLease(fixture, codeDesktopRecord({ accessToken: ACCESS_ROTATED, generation: 8 }));
          done(null, '{}');
          return {};
        }
      });
      const result = await readCode(deps);
      const label = `${lane} ${name}`;
      assert.equal(result.status, 'ok', label);
      assert.equal(rotations, 1, label);
      assert.equal(result.windows.length, 3, label);
      assert.equal(result.region, 'cn', label);
    }
  }
});

test('MiniMax Code attempts recovery once when an unexpired resource token is rejected', async () => {
  for (const renewed of [false, true]) {
    const fixture = writeCodeAuthFixture();
    let commands = 0;
    let resources = 0;
    const deps = codeDeps(fixture, async () => { resources++; return unauthorized(); }, {
      existsSync: () => true,
      execFile: (_command, _args, _options, done) => {
        commands++;
        if (renewed) writeCodeLease(fixture, codeDesktopRecord({ accessToken: ACCESS_ROTATED, generation: 8 }));
        done(null, '{}');
        return {};
      }
    });
    assert.equal((await readCode(deps)).status, renewed ? 'unauthorized' : 'unavailable');
    assert.equal(commands, 1);
    assert.equal(resources, renewed ? 2 : 1);
  }
});

test('MiniMax Code keeps a known account until a different group id is confirmed', async () => {
  const fixture = writeCodeAuthFixture();
  let group = 'known-account';
  let amount = '10';
  let now = CODE_NOW;
  const runtime = createLimitsRuntime({ limitProviders: ['minimax'], minimaxBillingMode: 'api' }, {
    ...codeDeps(fixture, async url => url === MINIMAX_CODE_MEMBERSHIP_URL_CN
      ? okResponse(membershipBody({ has_token_plan: false, op_group_id: group,
        op_credit_summary: { total_remaining_amount: amount } }))
      : { ok: false, status: 503 }),
    now: () => now, autoStart: false, autoRetry: false
  });
  try {
    await runtime.refresh({ provider: 'minimax' }, 'manual');
    const known = runtime.getSnapshot().providers[0];
    assert.ok(known.accountKey);
    assert.equal(known.windows[0].remaining, 10);
    group = '';
    amount = '20';
    await runtime.refresh({ provider: 'minimax' }, 'manual');
    const unidentified = runtime.getSnapshot().providers[0];
    assert.equal(unidentified.accountKey, known.accountKey);
    assert.equal(unidentified.status, 'unavailable');
    assert.deepEqual(unidentified.windows, known.windows);
    now += 60_000;
    group = 'second-account';
    amount = 'not-a-number';
    await runtime.refresh({ provider: 'minimax' }, 'manual');
    const failed = runtime.getSnapshot().providers;
    assert.equal(failed.length, 1, 'a failed replacement must not create another Code identity');
    assert.equal(failed[0].accountKey, known.accountKey);
    assert.deepEqual(failed[0].windows, known.windows);
    amount = '20';
    now += 60_000;
    await runtime.refresh({ provider: 'minimax' }, 'manual');
    const rows = runtime.getSnapshot().providers;
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].accountKey, known.accountKey);
    assert.equal(rows[0].status, 'ok');
    assert.equal(rows[0].windows[0].remaining, 20);
    assert.equal('removed' in rows[0], false);
  } finally { runtime.stop(); }
});

test('MiniMax Code identity follows the server account across devices and re-login', async () => {
  const identities = [];
  const storeKeys = new Set();
  for (const group of ['same-account', 'same-account', 'different-account']) {
    const fixture = writeCodeAuthFixture();
    storeKeys.add(fixture.recordKey);
    const row = await readCode(codeDeps(fixture, async url => okResponse(
      url === MINIMAX_CODE_MEMBERSHIP_URL_CN ? membershipBody({ op_group_id: group }) : planRemainsBody()
    )));
    assert.equal(row.status, 'ok');
    identities.push(row.accountKey);
  }
  assert.equal(storeKeys.size, 3);
  assert.ok(identities[0]);
  assert.equal(identities[0], identities[1], 'local store namespace is not an account identity');
  assert.notEqual(identities[0], identities[2], 'changing accounts changes the identity even at the same auth path');
});
