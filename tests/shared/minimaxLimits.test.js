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
  minimaxAttemptOrder,
  minimaxRegion,
  minimaxRegionForUrl,
  isMinimaxTransportError,
  MINIMAX_REGION_MEMORY_STATE_KEY,
  MINIMAX_TOKEN_PLAN_REMAINS_URL_CN,
  MINIMAX_TOKEN_PLAN_REMAINS_URL_EN,
  MINIMAX_REMAINS_URL_CN,
  MINIMAX_REMAINS_URL_EN
} = require('../../src/shared/providers/minimax/limits');
const { parseLimitProviders } = require('../../src/shared/limits/collector');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');

const CN_REMAINS_URLS = new Set([MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, MINIMAX_REMAINS_URL_CN]);

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

test('fetchMinimaxLimits maps base_resp auth-shaped errors to unauthorized', async () => {
  // Live endpoint reports auth failures as 200 OK with status_code: 1004 +
  // a status_msg that mentions "log in" / "cookie" / "token" / "auth" / "key".
  // Without this mapping the UI would show generic 'Unavailable' for what is
  // actually a 're-enter the key' prompt.
  const r = await fetchMinimaxLimits({ minimaxApiHost: 'cn' }, {
    env: { MINIMAX_CODING_API_KEY: 'sk-cp-test' },
    now: () => 1_716_350_000_000,
    fetch: async () => okResponse({ base_resp: { status_code: 1004, status_msg: 'cookie is missing, log in again' } })
  });
  assert.equal(r.status, 'unauthorized');
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
    autoStart: false, autoRetry: false, env: {},
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
