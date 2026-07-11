'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  minimaxToken,
  parseMinimaxTiers,
  fetchMinimaxLimits,
  minimaxAttemptOrder,
  minimaxRegionForUrl,
  MINIMAX_TOKEN_PLAN_REMAINS_URL_CN,
  MINIMAX_TOKEN_PLAN_REMAINS_URL_EN,
  MINIMAX_REMAINS_URL_CN,
  MINIMAX_REMAINS_URL_EN
} = require('../../src/shared/minimaxLimits');
const { parseLimitProviders } = require('../../src/shared/limitCollector');

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
  assert.deepEqual(
    parseLimitProviders(),
    ['claude', 'codex', 'cursor', 'antigravity', 'opencode', 'deepseek', 'minimax', 'mimo', 'grok', 'copilot', 'kiro', 'zai', 'volcengine', 'qoder', 'zaiteam', 'kimi']
  );
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

test('minimaxRegionForUrl maps endpoints to en/cn labels for the renderer', () => {
  assert.equal(minimaxRegionForUrl(MINIMAX_REMAINS_URL_EN), 'en');
  assert.equal(minimaxRegionForUrl(MINIMAX_REMAINS_URL_CN), 'cn');
  assert.equal(minimaxRegionForUrl(MINIMAX_TOKEN_PLAN_REMAINS_URL_EN), 'en');
  assert.equal(minimaxRegionForUrl(MINIMAX_TOKEN_PLAN_REMAINS_URL_CN), 'cn');
  assert.equal(minimaxRegionForUrl('https://example.com'), '');
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

test('fetchMinimaxLimits does NOT retry on non-auth failures (5xx, network, etc.)', async () => {
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
