'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const dotenv = require('dotenv');

const {
  minimaxToken,
  parseMinimaxTiers,
  fetchMinimaxLimits,
  minimaxRegion,
  MINIMAX_REGION_MEMORY_STATE_KEY,
  MINIMAX_TOKEN_PLAN_REMAINS_URL_CN,
  MINIMAX_TOKEN_PLAN_REMAINS_URL_EN,
  MINIMAX_REMAINS_URL_CN,
  MINIMAX_REMAINS_URL_EN
} = require('../../src/shared/providers/minimax/limits');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');

const CN_REMAINS_URLS = new Set([MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_REMAINS_URL_CN]);

const BALANCE_URL_CN = 'https://api.minimaxi.com/account/query_balance';
const BALANCE_URL_EN = 'https://api.minimax.io/account/query_balance';

async function requestTokenPlan(fetch, options = {}, deps = {}) {
  const calls = [];
  const result = await fetchMinimaxLimits({ minimaxApiKey: 'sk-cp-test', ...options }, {
    env: {}, now: () => 1_716_350_000_000, ...deps,
    fetch: async (url, init) => { calls.push(url); return fetch(url, init); }
  });
  return { result, calls };
}

const windowsBody = {
  data: {
    model_remains: [
      { model_name: 'general', current_interval_remaining_percent: 80, current_weekly_remaining_percent: 70 }
    ]
  }
};

function generalRemains(fields) {
  return { data: { model_remains: [{ model_name: 'general', ...fields }] } };
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function unauthorized() {
  return { ok: false, status: 401, json: async () => ({}) };
}

// Settings and credential boundaries.
test('the copied environment example leaves the legacy MiniMax host pin effective', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
  const env = dotenv.parse(`${example}\nMINIMAX_API_HOST=api.minimaxi.com\n`);
  assert.equal(minimaxRegion({}, env), 'cn');
});

test('minimaxToken reads the CodexBar-compatible Token Plan key and ignores unrelated keys', () => {
  assert.equal(minimaxToken({ MINIMAX_CODING_API_KEY: '  "sk-cp-codexbar"  ' }), 'sk-cp-codexbar');
  assert.equal(minimaxToken({ TOKEN_MONITOR_MINIMAX_KEY: 'sk-cp-unrelated' }), '');
  assert.equal(minimaxToken({ MINIMAX_API_KEY: 'sk-api-payg' }), '');
  assert.equal(minimaxToken({}), '');
  assert.equal(minimaxToken({}, '  "sk-cp-direct"  '), 'sk-cp-direct');
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

test('MiniMax accepts exact region aliases and hosts, never hostname substrings', () => {
  for (const host of ['minimaxi.com', 'api.minimaxi.com']) assert.equal(minimaxRegion({ minimaxApiRegion: host }), 'cn');
  for (const host of ['minimax.io', 'api.minimax.io']) assert.equal(minimaxRegion({ minimaxApiRegion: host }), 'intl');
  for (const raw of ['evil-minimax.io.example', 'api.minimaxi.com.evil.test', 'https://evil.test/minimax.io', 'api.minimax.io@evil.test']) {
    assert.equal(minimaxRegion({ minimaxApiRegion: raw }), 'auto', raw);
  }
});

// Quota parsing: response shapes, percentages and timestamps.
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
  const windows = parseMinimaxTiers(windowsBody.data);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].usedPercent, 20);
  assert.equal(windows[1].usedPercent, 30);
});

test('parseMinimaxTiers skips video / voice buckets and locates general anywhere in the array', () => {
  const windows = parseMinimaxTiers({ data: { model_remains: [
    { model_name: 'video', current_interval_remaining_percent: 20 },
    ...windowsBody.data.model_remains
  ] } });
  assert.equal(windows.length, 2);
  assert.equal(windows[0].usedPercent, 20); // General usage, not the video's 80%.
});

test('parseMinimaxTiers suppresses only placeholder percentages for status 3', () => {
  for (const [name, sessionStatus, sessionRemaining, weeklyRemaining, expected] of [
    ['100% placeholder', 1, 99, 100, [['session', 1]]],
    ['missing percentage', 1, 80, undefined, [['session', 20]]],
    ['real percentages', 3, 50, 60, [['session', 50], ['weekly', 40]]]
  ]) {
    const windows = parseMinimaxTiers(generalRemains({
      current_interval_status: sessionStatus,
      current_interval_remaining_percent: sessionRemaining,
      current_weekly_status: 3,
      current_weekly_remaining_percent: weeklyRemaining
    }));
    assert.deepEqual(windows.map(window => [window.kind, window.usedPercent]), expected, name);
  }
});

test('parseMinimaxTiers returns [] when model_remains is missing or has no general entry', () => {
  assert.deepEqual(parseMinimaxTiers({ data: { model_remains: [] } }), []);
  assert.deepEqual(parseMinimaxTiers({ data: { model_remains: [{ model_name: 'video' }] } }), []);
  assert.deepEqual(parseMinimaxTiers({}), []);
  assert.deepEqual(parseMinimaxTiers(null), []);
});

test('parseMinimaxTiers clamps percentages to [0, 100] and handles negative remainders', () => {
  const body = generalRemains({
    current_interval_remaining_percent: -5,
    current_weekly_remaining_percent: 150
  });
  const windows = parseMinimaxTiers(body);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].usedPercent, 100); // 100 - (-5) clamped
  assert.equal(windows[0].remainingPercent, 0);
  assert.equal(windows[1].usedPercent, 0); // 100 - 150 clamped
  assert.equal(windows[1].remainingPercent, 100);
});

test('parseMinimaxTiers treats second-precision timestamps as seconds, not milliseconds', () => {
  const body = generalRemains({
    current_interval_remaining_percent: 50,
    end_time: 1_716_350_400 // 10 digits → seconds, < 1e12
  });
  const windows = parseMinimaxTiers(body);
  assert.match(windows[0].resetsAt, /^20\d\d-/);
});

// Requests: billing mode, authentication, region routing and freshness.
test('MiniMax API billing uses one balance endpoint in the selected region', async () => {
  for (const [region, url, currency] of [['cn', BALANCE_URL_CN, 'CNY'], ['intl', BALANCE_URL_EN, 'USD']]) {
    for (const amount of ['98.25', '0.00', '-1.50']) {
      const calls = [];
      const result = await fetchMinimaxLimits({ minimaxApiKey: 'sk-api-test', minimaxBillingMode: 'api', minimaxApiRegion: region }, {
        env: {},
        fetchJson: async (target, headers) => {
          calls.push(target);
          assert.equal(headers.Authorization, 'Bearer sk-api-test');
          return { available_amount: amount, cash_balance: '100.00', base_resp: { status_code: 0 } };
        }
      });
      assert.deepEqual(calls, [url]);
      assert.equal(result.status, 'ok');
      assert.equal(result.accountLabel, 'Pay-as-you-go');
      assert.equal(result.windows.length, 1);
      assert.equal(result.windows[0].metric, 'credits');
      assert.equal(result.windows[0].currency, currency);
      assert.equal(result.windows[0].remaining, Number(amount));
      assert.equal(result.windows[0].usedPercent, null);
      assert.equal(result.windows[0].resetsAt, null);
      assert.equal(JSON.stringify(result).includes('sk-api-test'), false);
    }
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

test('MiniMax API billing reuses Auto region fallback and remembers a valid zero balance', async () => {
  const calls = [];
  const providerRuntimeState = new Map();
  const deps = {
    env: {}, providerRuntimeState,
    fetchJson: async (url) => {
      calls.push(url);
      if (url === BALANCE_URL_EN) throw Object.assign(new Error('wrong region'), { status: 'unauthorized', statusCode: 401 });
      return { available_amount: '0.00', base_resp: { status_code: 0 } };
    }
  };
  const options = { minimaxApiKey: 'sk-api-test', minimaxBillingMode: 'api' };
  assert.equal((await fetchMinimaxLimits(options, deps)).status, 'ok');
  assert.deepEqual(calls, [BALANCE_URL_EN, BALANCE_URL_CN]);
  calls.length = 0;
  assert.equal((await fetchMinimaxLimits(options, deps)).status, 'ok');
  assert.deepEqual(calls, [BALANCE_URL_CN]);
});

test('MiniMax API billing preserves auth, rate-limit and transport verdicts', async () => {
  for (const [error, expected, urls] of [
    [{ status: 'unauthorized', statusCode: 401 }, 'unauthorized', [BALANCE_URL_EN, BALANCE_URL_CN]],
    [{ status: 'sourceRateLimited', statusCode: 429 }, 'sourceRateLimited', [BALANCE_URL_EN]],
    [{ status: 'unavailable', statusCode: 500 }, 'unavailable', [BALANCE_URL_EN]],
    [{}, 'unavailable', [BALANCE_URL_EN, BALANCE_URL_CN]]
  ]) {
    const calls = [];
    const result = await fetchMinimaxLimits({ minimaxApiKey: 'sk-api-test', minimaxBillingMode: 'api' }, {
      env: {},
      fetchJson: async (url) => {
        calls.push(url);
        throw Object.assign(new Error('probe failed'), error);
      }
    });
    assert.equal(result.status, expected);
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

test('network rejections skip the failed host and recover through the other region', async () => {
  for (const error of [
    new Error('fetch failed'),
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }),
    Object.assign(new Error('aborted'), { name: 'AbortError' }),
    new Error('net::ERR_CONNECTION_TIMED_OUT')
  ]) {
    const { result, calls } = await requestTokenPlan(async url => {
      if (url === MINIMAX_TOKEN_PLAN_REMAINS_URL_EN) throw error;
      return okResponse(windowsBody);
    });
    assert.equal(result.status, 'ok', error.message);
    assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_TOKEN_PLAN_REMAINS_URL_CN], error.message);
  }
});

test('invalid transport rejection values stay unavailable without retrying regions', async () => {
  for (const error of [null, Object.assign(new Error('nope'), { status: 'timeout' })]) {
    const { result, calls } = await requestTokenPlan(async () => { throw error; });
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN]);
  }
});

test('fetchMinimaxLimits returns notConfigured when no key is provided', async () => {
  const r = await fetchMinimaxLimits({}, { env: {} });
  assert.equal(r.provider, 'minimax');
  assert.equal(r.status, 'notConfigured');
  assert.equal(r.source, 'api');
  assert.deepEqual(r.windows, []);
  assert.equal(r.region, '');
});

test('fetchMinimaxLimits reads quota with the env or preferred settings key without leaking it', async () => {
  const body = generalRemains({
    current_interval_remaining_percent: 92, current_interval_status: 1,
    current_weekly_remaining_percent: 88, current_weekly_status: 1,
    end_time: 1_716_350_400_000, weekly_end_time: 1_716_780_000_000
  });
  body.base_resp = { status_code: 0 };
  for (const [options, key] of [[{}, 'sk-cp-env'], [{ minimaxApiKey: " 'sk-cp-settings' " }, 'sk-cp-settings']]) {
    const calls = [];
    const result = await fetchMinimaxLimits(options, {
      env: { MINIMAX_CODING_API_KEY: 'sk-cp-env' }, now: () => 1_716_350_000_000,
      fetch: async (url, init) => { calls.push([url, init.headers.Authorization]); return okResponse(body); }
    });
    assert.deepEqual(calls, [[MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, `Bearer ${key}`]]);
    assert.equal(result.provider, 'minimax');
    assert.equal(result.status, 'ok');
    assert.equal(result.source, 'api');
    assert.equal(result.accountLabel, 'Token Plan');
    assert.match(result.accountKey, /^sha256:/);
    assert.equal(result.region, 'en');
    assert.deepEqual(result.windows.map(window => window.kind), ['session', 'weekly']);
    assert.ok(!JSON.stringify(result).includes(key));
  }
});

test('fetchMinimaxLimits maps pinned-region errors without crossing regions', async () => {
  for (const [name, options, response, status] of [
    ['legacy host HTTP 401', { minimaxApiHost: 'cn' }, unauthorized(), 'unauthorized'],
    ['region HTTP 401', { minimaxApiRegion: 'cn' }, unauthorized(), 'unauthorized'],
    ['business 1004', { minimaxApiHost: 'cn' }, okResponse({ base_resp: { status_code: 1004, status_msg: 'cookie is missing, log in again' } }), 'unauthorized'],
    ['business 1001', { minimaxApiHost: 'cn' }, okResponse({ base_resp: { status_code: 1001, status_msg: 'quota api disabled' } }), 'unavailable']
  ]) {
    const { result, calls } = await requestTokenPlan(async () => response, options);
    assert.equal(result.status, status, name);
    assert.equal(result.region, '', name);
    assert.deepEqual(result.windows, [], name);
    assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_REMAINS_URL_CN], name);
  }
});

test('fetchMinimaxLimits retries CN after HTTP or business auth rejection in the global region', async () => {
  for (const [name, rejection] of [
    ['HTTP 401', unauthorized()],
    ['HTTP 403', { ok: false, status: 403 }],
    ['business 1004', okResponse({ base_resp: { status_code: 1004, status_msg: 'cookie is missing, log in again' } })]
  ]) {
    const { result, calls } = await requestTokenPlan(async url =>
      url === MINIMAX_TOKEN_PLAN_REMAINS_URL_CN ? okResponse(windowsBody) : rejection);
    assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_REMAINS_URL_EN, MINIMAX_TOKEN_PLAN_REMAINS_URL_CN], name);
    assert.equal(result.status, 'ok', name);
    assert.equal(result.region, 'cn', name);
  }
});

test('fetchMinimaxLimits falls back to legacy coding-plan when token-plan returns no parseable windows', async () => {
  const { result, calls } = await requestTokenPlan(async url =>
    okResponse(url === MINIMAX_TOKEN_PLAN_REMAINS_URL_EN ? {} : windowsBody), { minimaxApiHost: 'en' });
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_REMAINS_URL_EN]);
  assert.equal(result.status, 'ok');
  assert.equal(result.region, 'en');
});

test('fetchMinimaxLimits bounds both the header wait and body read', { timeout: 5000 }, async () => {
  for (const phase of ['headers', 'body']) {
    const { result, calls } = await requestTokenPlan(async (_url, { signal }) => {
      const pending = new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return phase === 'headers' ? pending : { ok: true, status: 200, json: () => pending };
    }, { minimaxApiHost: 'cn' }, { fetchTimeoutMs: 10 });
    assert.equal(result.status, 'unavailable', phase);
    assert.deepEqual(result.windows, [], phase);
    assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN], phase);
  }
});

test('fetchMinimaxLimits does not retry another region after server or JSON errors', async () => {
  for (const [name, response] of [
    ['HTTP 503', { ok: false, status: 503, json: async () => ({}) }],
    ['malformed JSON', { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }]
  ]) {
    const { result, calls } = await requestTokenPlan(async () => response);
    assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN], name);
    assert.equal(result.status, 'unavailable', name);
  }
});

test('fetchMinimaxLimits honors option and env pins and reports the wire region', async () => {
  for (const [options, env, url, region] of [
    [{ minimaxApiHost: 'cn' }, {}, MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, 'cn'],
    [{ minimaxApiRegion: 'intl' }, {}, MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, 'en'],
    [{}, { MINIMAX_API_REGION: 'cn' }, MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, 'cn']
  ]) {
    const { result, calls } = await requestTokenPlan(async () => okResponse(windowsBody), options, { env });
    assert.deepEqual(calls, [url]);
    assert.equal(result.status, 'ok');
    assert.equal(result.region, region);
  }
});

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
  const calls = [];
  const deps = {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-cn-only' },
    providerRuntimeState: state,
    fetch: async url => {
      calls.push(url);
      if (url === MINIMAX_TOKEN_PLAN_REMAINS_URL_EN) throw new Error('fetch failed');
      return okResponse(windowsBody);
    }
  };
  assert.equal((await fetchMinimaxLimits({}, deps)).status, 'ok');
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_TOKEN_PLAN_REMAINS_URL_CN]);
  calls.length = 0;
  const result = await fetchMinimaxLimits({}, deps);
  assert.deepEqual(calls, [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN]);
  assert.equal(result.status, 'ok');
  assert.equal(result.region, 'cn');
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

test('MiniMax pinned regions retain the legacy endpoint fallback', async () => {
  for (const [options, region, urls] of [
    [{ minimaxApiRegion: 'cn' }, 'cn', [MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_REMAINS_URL_CN]],
    [{ minimaxApiRegion: 'intl' }, 'en', [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_REMAINS_URL_EN]],
    [{ minimaxApiHost: 'en' }, 'en', [MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, MINIMAX_REMAINS_URL_EN]]
  ]) {
    const { result, calls } = await requestTokenPlan(async url =>
      url === urls[0] ? { ok: false, status: 404 } : okResponse(windowsBody), options);
    assert.equal(result.status, 'ok');
    assert.deepEqual(calls, urls);
    assert.equal(result.region, region);
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
  const { result, calls } = await requestTokenPlan(async () => okResponse(windowsBody), { minimaxApiRegion: 'auto' }, {
    env: { MINIMAX_API_REGION: 'cn' }, providerRuntimeState: new Map([[MINIMAX_REGION_MEMORY_STATE_KEY, 'en']])
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

test('Auto retries the other region when a response body disconnects during reading', async () => {
  const { result, calls } = await requestTokenPlan(async url => url === MINIMAX_TOKEN_PLAN_REMAINS_URL_EN
    ? { ok: true, status: 200, json: async () => { throw new TypeError('terminated'); } }
    : okResponse(windowsBody));
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

// Runtime: cancellation, retained readings and settings refresh.
test('MiniMax stops the superseded probe before retrying another region with the old key', { timeout: 5000 }, async (t) => {
  const calls = [];
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const runtime = createLimitsRuntime({
    limitProviders: ['minimax'], minimaxApiKey: 'sk-cp-old', minimaxApiRegion: 'auto'
  }, {
    autoStart: false, autoRetry: false, env: {},
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
  t.after(() => runtime.stop());
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

});

test('MiniMax runtime retains quota on outages and applies region changes on refresh', async (t) => {
  let outage = false;
  const runtime = createLimitsRuntime({
    limitProviders: ['minimax'], minimaxApiKey: 'sk-cp-test', minimaxApiRegion: 'cn'
  }, {
    autoStart: false, autoRetry: false, env: {},
    fetch: async () => {
      if (outage) throw new Error('fetch failed');
      return okResponse(windowsBody);
    }
  });
  t.after(() => runtime.stop());
  await runtime.refresh({ provider: 'minimax' }, 'manual');
  const good = runtime.getSnapshot().providers[0];
  assert.equal(good.status, 'ok');
  assert.equal(good.region, 'cn');
  outage = true;
  await runtime.refresh({ provider: 'minimax' }, 'manual');
  const retained = runtime.getSnapshot().providers[0];
  assert.equal(retained.status, 'unavailable');
  assert.equal(retained.accountKey, good.accountKey);
  assert.equal(retained.region, 'cn');
  assert.deepEqual(retained.windows, good.windows);
  outage = false;
  for (const minimaxApiRegion of ['intl', 'auto']) {
    runtime.reconfigure({ minimaxApiRegion });
    runtime.clear({ provider: 'minimax' }, 'settings-change');
    await runtime.refresh({ provider: 'minimax' }, 'settings-change');
    const row = runtime.getSnapshot().providers[0];
    assert.equal(row.status, 'ok', minimaxApiRegion);
    assert.equal(row.region, 'en', minimaxApiRegion);
  }
});
