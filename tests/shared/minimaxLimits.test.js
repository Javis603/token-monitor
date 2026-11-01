'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const dotenv = require('dotenv');

const {
  minimaxToken,
  parseMinimaxTiers,
  fetchMinimaxLimits: fetchMinimaxLimitsWithDeps,
  minimaxRegion,
  MINIMAX_REGION_MEMORY_STATE_KEY,
  MINIMAX_TOKEN_PLAN_REMAINS_URL_CN,
  MINIMAX_TOKEN_PLAN_REMAINS_URL_EN,
  MINIMAX_REMAINS_URL_CN,
  MINIMAX_REMAINS_URL_EN,
  MINIMAX_CODE_MEMBERSHIP_URL_CN,
  MINIMAX_CODE_PLAN_REMAINS_URL_CN
} = require('../../src/shared/providers/minimax/limits');

const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-empty-home-'));
test.after(() => fs.rmSync(emptyHome, { recursive: true, force: true }));
const fetchMinimaxLimits = (options, deps) => fetchMinimaxLimitsWithDeps(options, { env: {}, homeDir: emptyHome, ...(deps || {}) });
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
      assert.deepEqual(calls.filter(target => target === url), [url]);
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
  assert.deepEqual(calls.filter(url => url === BALANCE_URL_EN || url === BALANCE_URL_CN), [BALANCE_URL_EN, BALANCE_URL_CN]);
  assert.equal(providerRuntimeState.get(MINIMAX_REGION_MEMORY_STATE_KEY), 'cn');
  calls.length = 0;
  assert.equal((await fetchMinimaxLimits(options, deps)).status, 'ok');
  assert.deepEqual(calls.filter(url => url === BALANCE_URL_EN || url === BALANCE_URL_CN), [BALANCE_URL_CN]);
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
  assertFields(row.balance, { amount: 14.97, currency: 'CNY', todaySpend: 0,
    weekSpend: null, monthSpend: 0, allTimeSpend: 12.34, trackingSince: null });
  assert.equal(requests.length, 4, 'identical Today and Month filters share one request');
  assert.equal(new Set(requests).size, requests.length);
});

const CODE_NOW = 1790000000000;
const ACCESS_ONFILE = 'test-access-onfile';
const REFRESH_ONFILE = 'test-refresh-onfile';
const ACCESS_ROTATED = 'test-access-rotated';
const REFRESH_ROTATED = 'test-refresh-rotated';
const CODE_CLI_PATH = process.platform === 'win32' ? path.win32 : path.posix;
const CODE_CLI_DIR = CODE_CLI_PATH.join(os.tmpdir(), 'minimax-test-bin');
const CODE_CLI_COMMAND = CODE_CLI_PATH.join(CODE_CLI_DIR, process.platform === 'win32' ? 'mcode.exe' : 'mcode');

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

function writeCodeAuthFixture({ record, siblings = {}, state, region = 'cn', prefix = 'minimax-code-auth-' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const account = createHash('sha256').update(`${path.join(base, 'auth')}\0mcode-public`).digest('base64url');
  const recordKey = `com.minimax.mcode.oauth.prod.${region}\0${account}`;
  const selected = codeDesktopRecord(record);
  const records = { ...siblings, [recordKey]: selected };
  const dir = path.join(base, 'auth', 'prod', region, 'mcode-public');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const authPath = path.join(dir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ schemaVersion: 1, records }, null, 2), { mode: 0o600 });
  const statePath = path.join(dir, 'auth-state.json');
  if (state !== false) { fs.writeFileSync(statePath, JSON.stringify(codeDesktopState(selected, { region, ...state }), null, 2)); }
  return { base, dir, authPath, statePath, recordKey, region };
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

test('MiniMax Code distinguishes missing login from a malformed store', async () => {
  for (const [contents, status] of [[null, 'notConfigured'], ['{invalid-json', 'unavailable']]) {
    const fixture = writeCodeAuthFixture();
    if (contents === null) fs.unlinkSync(fixture.authPath);
    else fs.writeFileSync(fixture.authPath, contents);
    const deps = codeDeps(fixture, async () => assert.fail('invalid stores must not request quota'));
    assert.equal((await readCode(deps)).status, status);
    assert.deepEqual(deps.requests, []);
  }
});

test('MiniMax Code reads the live record and quota without launching the CLI', async () => {
  const fixture = writeCodeAuthFixture({ siblings: {
    ['com.minimax.mcode.oauth.prod.cn\0previous-store']: codeDesktopRecord({ accessToken: 'stale-token' })
  } });
  const result = await readCode(codeDeps(fixture, async (url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${ACCESS_ONFILE}`);
    if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) return okResponse(membershipBody());
    assert.equal(url, MINIMAX_CODE_PLAN_REMAINS_URL_CN);
    assert.equal(init.headers['X-Group-Id'], 'grp-123');
    return okResponse(planRemainsBody());
  }, { existsSync: () => true, execFile: () => assert.fail('a live token must not launch the CLI') }));
  assertFields(result, { status: 'ok', source: 'oauth', accountLabel: 'MiniMax Code' }, 'live Code reading');
  assertFields(result.windows.find(window => window.label === 'Credits'),
    { remaining: 4624, currency: 'CREDITS', showMeter: false }, 'Code points');
  assert.deepEqual(result.windows.map(window => [window.label, window.usedPercent]).sort(),
    [['5h', 30], ['Credits', null], ['Weekly', 10]]);
  assert.ok(result.accountKey);
  assert.equal(JSON.stringify(result).includes(ACCESS_ONFILE), false);
});

test('MiniMax Code rejects missing, logged-out or inconsistent official auth state before requesting quota', async () => {
  for (const [state, status, record] of [
    [false, 'unavailable'],
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
    ['linux', '/home/test', { MCODE_INSTALL_DIR: '/custom/install' }, '/custom/install/bin/mcode', 'en'],
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
    ['unchanged', { expiresAtMs: CODE_NOW }, {}, null, 'unauthorized'],
    ['updated despite command failure', { accessToken: ACCESS_ROTATED, generation: 8 }, {}, new Error('metadata failed'), 'ok'],
    ['new login', { accessToken: ACCESS_ROTATED, loginEpoch: 'new-login' }, {}, null, 'unavailable'],
    ['mismatched generation', { accessToken: ACCESS_ROTATED, generation: 8 }, { generation: 9 }, null, 'unavailable']
  ]) {
    const fixture = writeCodeAuthFixture({ record: { expiresAtMs: CODE_NOW } });
    let calls = 0;
    const deps = codeDeps(fixture, async () => okResponse(membershipBody({ has_token_plan: false })), {
      env: { MINIMAX_DATA_DIR: fixture.base, PATH: CODE_CLI_DIR }, existsSync: candidate => candidate === CODE_CLI_COMMAND,
      execFile: (_command, _args, _options, done) => {
        calls++;
        writeCodeLease(fixture, codeDesktopRecord(record), state);
        done(commandError, '{"success":true}');
        return {};
      }
    });
    assert.equal((await readCode(deps)).status, status, name);
    assert.equal(calls, 1, name);
    assert.equal(deps.requests.length > 0, status === 'ok', name);
  }
});

test('MiniMax Code leaves expired credentials untouched when recovery cannot start', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  for (const [record, extra] of [
    [{}, {}],
    [{ loginEpoch: undefined }, { existsSync: () => true }],
    [{}, { signal: cancelled.signal, existsSync: () => true }]
  ]) {
    const fixture = writeCodeAuthFixture({ record: { expiresAtMs: CODE_NOW, ...record } });
    const files = [fixture.authPath, fixture.statePath];
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    const deps = codeDeps(fixture, async () => assert.fail('expired credentials must not request quota'), {
      ...extra, execFile: () => assert.fail('recovery must not start')
    });
    assert.equal((await readCode(deps)).status, 'unavailable');
    assert.deepEqual(deps.requests, []);
    assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), before);
  }
});

test('MiniMax Code lets a started official refresh finish after quota collection is cancelled', async () => {
  const fixture = writeCodeAuthFixture({ record: { expiresAtMs: CODE_NOW } });
  const controller = new AbortController();
  let kills = 0;
  const deps = codeDeps(fixture, async () => assert.fail('cancelled quota must not be requested'), {
    signal: controller.signal, existsSync: () => true,
    execFile: (_command, _args, _options, done) => {
      controller.abort();
      queueMicrotask(() => {
        writeCodeLease(fixture, codeDesktopRecord({ accessToken: ACCESS_ROTATED, generation: 8 }));
        done(null, '{}');
      });
      return { kill: () => { kills++; return true; } };
    }
  });
  assert.equal((await readCode(deps)).status, 'unavailable');
  assert.equal(kills, 0, 'quota cancellation must not stop official rotation');
  assert.deepEqual(deps.requests, []);
  assert.equal(JSON.parse(fs.readFileSync(fixture.authPath)).records[fixture.recordKey].accessToken, ACCESS_ROTATED);
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
  assert.equal(JSON.parse(fs.readFileSync(fixture.authPath)).records[fixture.recordKey].accessToken, ACCESS_ROTATED);
});

test('MiniMax API and Code failures do not invalidate the other lane', async () => {
  const fixture = writeCodeAuthFixture();
  for (const failed of ['api', 'oauth']) {
    const rows = await fetchMinimaxLimits({ minimaxApiKey: 'key-A', minimaxApiRegion: 'cn', minimaxBillingMode: 'api' },
      codeDeps(fixture, async url => {
        if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) return failed === 'oauth' ? { ok: false, status: 503 }
          : okResponse(membershipBody({ has_token_plan: false }));
        if (new URL(url).pathname === '/account/query_balance') return failed === 'api' ? { ok: false, status: 503 }
          : okResponse({ available_amount: '14.97', base_resp: { status_code: 0 } });
        return okResponse({});
      }));
    assert.equal(rows.find(row => row.source === failed).status, 'unavailable');
    const healthy = rows.find(row => row.source !== failed);
    assert.equal(healthy.status, 'ok');
    assert.equal(healthy.windows[0].remaining, failed === 'api' ? 4624 : 14.97);
  }
});

test('MiniMax links confirmed groups without carrying affiliation to a new key or login', async () => {
  const fixture = writeCodeAuthFixture();
  let group = 'group-A';
  const deps = codeDeps(fixture, async (url, init) => {
    if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) return okResponse(membershipBody({ has_token_plan: false, op_group_id: group }));
    const target = new URL(url);
    if (target.pathname === '/account/query_balance') return okResponse({ available_amount: '14.97' });
    if (target.pathname === '/v1/token_plan/remains') {
      assert.equal(target.searchParams.get('GroupId'), group);
      const confirmed = group === 'group-A' && init.headers.Authorization === 'Bearer key-A';
      return okResponse({ base_resp: { status_code: confirmed ? 2062 : 1004 } });
    }
    return okResponse({});
  });
  const options = { minimaxApiRegion: 'cn', minimaxBillingMode: 'api', minimaxApiKey: 'key-A' };
  const first = await fetchMinimaxLimits(options, deps);
  const api = first.find(row => row.source === 'api');
  const code = first.find(row => row.source === 'oauth');
  assert.equal(api.relatedAccountKey, code.accountKey);
  assert.equal(code.relatedAccountKey, api.accountKey);
  const previousLimits = { providers: first };
  const newKey = await fetchMinimaxLimits({ ...options, minimaxApiKey: 'key-B', previousLimits }, deps);
  assert.ok(newKey.filter(row => !row.removed).every(row => !row.relatedAccountKey));
  group = 'group-B';
  const newLogin = await fetchMinimaxLimits({ ...options, previousLimits }, deps);
  assert.ok(newLogin.filter(row => !row.removed).every(row => !row.relatedAccountKey));
});

test('MiniMax Code uses only a matched subscription name and tolerates metadata failure', async () => {
  const fixture = writeCodeAuthFixture();
  for (const [metadata, label] of [
    [{ current_subscribe: { curr_subscribe_combo_id: '12345' }, current_combo_card: { combo_id: 12345, title: 'Build' } }, 'Build'],
    [{ current_combo_card: { combo_id: 12345, title: 'Unowned plan' } }, 'Subscription'],
    [null, 'Subscription']
  ]) {
    const row = await readCode(codeDeps(fixture, async url => {
      if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) return okResponse(membershipBody({ token_plan_tier: '12345' }));
      if (url.includes('/cycle_audio_resource_package')) return metadata ? okResponse(metadata) : unauthorized();
      assert.equal(url, MINIMAX_CODE_PLAN_REMAINS_URL_CN);
      return okResponse(planRemainsBody());
    }, { existsSync: () => true, execFile: () => assert.fail('optional names must not rotate credentials') }));
    assert.equal(row.status, 'ok');
    assert.equal(row.planLabel, label);
    assert.equal(row.windows.length, 3);
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

    return result.windows.find(window => window.label === 'Credits');
  };
  assertFields(await read([
    { details: Array.from({ length: 100 }, () => grant(1, 0.5)), total_count: 101 },
    { details: [grant(100, 25)], total_count: 101 }
  ], 75), { remaining: 75, limit: 200, showMeter: true }, 'complete paginated grant list');
  assertFields(await read([{ details: [grant(100, 50)], total_count: 2 }, { details: [], total_count: 2 }], 50),
    { remaining: 50, limit: null, showMeter: false }, 'incomplete grant list');
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
  }
});

test('MiniMax Code retains quota through plan and auth-state outages', async (t) => {
  const fixture = writeCodeAuthFixture();
  let outage = false;
  let timestamp = CODE_NOW;
  let nameRequests = 0;
  const runtime = createLimitsRuntime({ limitProviders: ['minimax'], minimaxBillingMode: 'api' }, {
    ...codeDeps(fixture, async url => {
      if (url === MINIMAX_CODE_MEMBERSHIP_URL_CN) return okResponse(membershipBody({ token_plan_tier: '12345', op_credit_summary: { total_remaining_amount: outage ? '4000' : '4624' } }));
      if (new URL(url).pathname.endsWith('/charge/combo/cycle_audio_resource_package')) {
        nameRequests++;
        return okResponse({ current_subscribe: { curr_subscribe_combo_id: '12345', current_subscribe_title: 'Build' } });
      }
      return outage ? { ok: false, status: 503 } : okResponse(planRemainsBody());
    }),
    now: () => timestamp, autoStart: false, autoRetry: false
  });
  t.after(() => runtime.stop());
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
  assert.equal(nameRequests, 1, 'quota failures do not require rereading a fresh plan name');
  assert.equal(partial.updatedAt, first.updatedAt);
  assert.equal(partial.windows.find(window => window.metric === 'credits').remaining, 4000);
  assert.deepEqual(partial.windows.filter(window => window.metric !== 'credits'), first.windows.filter(window => window.metric !== 'credits'));
  assert.equal('invalidateCachedWindowLabels' in partial, false);
  fs.unlinkSync(fixture.statePath);
  timestamp += 60000;
  await runtime.refresh({ provider: 'minimax' }, 'manual');
  const missingState = runtime.getSnapshot().providers[0];
  assert.equal(missingState.status, 'unavailable');
  assert.equal(missingState.accountKey, partial.accountKey);
  assert.deepEqual(missingState.windows, partial.windows);
  writeCodeLease(fixture, codeDesktopRecord(), { status: 'anonymous' });
  timestamp += 60000;
  await runtime.refresh({ provider: 'minimax' }, 'manual');
  const loggedOut = runtime.getSnapshot().providers[0];
  assert.equal(loggedOut.status, 'unauthorized');
  assert.deepEqual(loggedOut.windows, []);
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

test('API region settings never select or hide the local Code login', async () => {
  for (const region of ['cn', 'en']) {
    const fixture = writeCodeAuthFixture({ region });
    for (const apiRegion of ['cn', 'intl', 'auto']) {
      const deps = codeDeps(fixture, async (url, init) => {
        assert.equal(init.headers.authorization, `Bearer ${ACCESS_ONFILE}`);
        const target = new URL(url);
        if (target.pathname.endsWith('/get_membership_info')) {
          assert.equal(target.origin, region === 'cn' ? 'https://agent.minimax.cn' : 'https://agent.minimax.io');
          return okResponse(membershipBody({ token_plan_tier: '12345' }));
        }
        assert.equal(target.origin, region === 'cn' ? 'https://www.minimaxi.com' : 'https://platform.minimax.io');
        assert.equal(init.headers['X-Group-Id'], 'grp-123');
        return okResponse(target.pathname.endsWith('/remains_percent') ? planRemainsBody()
          : { current_subscribe: { curr_subscribe_combo_id: '12345', current_subscribe_title: 'Build' } });
      }, { env: { MINIMAX_DATA_DIR: fixture.base, MINIMAX_API_REGION: apiRegion } });
      const row = await fetchMinimaxLimits({ minimaxApiRegion: apiRegion }, deps);
      assertFields(row, { status: 'ok', source: 'oauth', region, planLabel: 'Build' }, `${region} Code with ${apiRegion} API setting`);
      assert.equal(row.windows.find(window => window.label === 'Credits').remaining, 4624);
    }
  }
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

test('MiniMax Code renews after membership HTTP rejection or plan business auth rejection', async () => {
  for (const [target, rejection] of [
    [MINIMAX_CODE_MEMBERSHIP_URL_CN, unauthorized()],
    [MINIMAX_CODE_PLAN_REMAINS_URL_CN, okResponse({ base_resp: { status_code: 1004 } })]
  ]) {
    const fixture = writeCodeAuthFixture();
    let rotations = 0;
    const deps = codeDeps(fixture, async (url, init) => {
      assert.equal(init.headers.authorization, `Bearer ${rotations ? ACCESS_ROTATED : ACCESS_ONFILE}`);
      if (url === target && rotations === 0) return rejection;
      return okResponse(url === MINIMAX_CODE_MEMBERSHIP_URL_CN ? membershipBody() : planRemainsBody());
    }, {
      existsSync: command => command === CODE_CLI_COMMAND, env: { MINIMAX_DATA_DIR: fixture.base, PATH: CODE_CLI_DIR },
      execFile: (_command, _args, _options, done) => {
        rotations++;
        writeCodeLease(fixture, codeDesktopRecord({ accessToken: ACCESS_ROTATED, generation: 8 }));
        done(null, '{}');
        return {};
      }
    });
    assert.equal((await readCode(deps)).status, 'ok', target);
    assert.equal(rotations, 1, target);
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

test('MiniMax Code keeps a known account until a different group id is confirmed', async (t) => {
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
  t.after(() => runtime.stop());
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
});
