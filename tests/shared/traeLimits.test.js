'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fetchTraeLimits,
  parseTraeEntUsage,
  traeAccessToken,
  traeDeviceId,
  traeEntUsageUrl
} = require('../../src/shared/providers/trae/limits');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function pack(limit, used) {
  return {
    entitlement_base_info: { quota: { credits_limit: limit } },
    usage: { credits_amount: used }
  };
}

test('Trae credentials prefer settings, support env aliases, and normalize copied headers', () => {
  assert.equal(traeAccessToken(
    { TRAE_ACCESS_TOKEN: 'env-token' },
    { traeAccessToken: ' "Authorization: Cloud-IDE-JWT settings-token" ' }
  ), 'settings-token');
  assert.equal(traeAccessToken({ TOKEN_MONITOR_TRAE_ACCESS_TOKEN: "'tm-token'" }), 'tm-token');
  assert.equal(traeAccessToken({ TRAE_ACCESS_TOKEN: 'Cloud-IDE-JWT env-token' }), 'env-token');
  assert.equal(traeDeviceId({ TRAE_DEVICE_ID: 'env-device' }, { traeDeviceId: 'device-1' }), 'device-1');
  assert.equal(traeDeviceId({ TOKEN_MONITOR_TRAE_DEVICE_ID: 'tm-device' }), 'tm-device');
  assert.equal(traeAccessToken({}, { traeAccessToken: 'token\r\ninjected' }), '');
  assert.equal(traeDeviceId({}, { traeDeviceId: 'device\ninjected' }), '');
});

test('Trae endpoint remains scoped to the CN API', () => {
  assert.equal(traeEntUsageUrl(), 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage');
});

test('parseTraeEntUsage aggregates valid packs as a credits balance', () => {
  const parsed = parseTraeEntUsage({
    user_entitlement_pack_list: [pack(1000, 250), pack('500', '100'), pack(0, 0)]
  });
  assert.equal(parsed.packCount, 2);
  assert.deepEqual(parsed.window, {
    kind: 'billing',
    label: 'Credits',
    metric: 'credits',
    currency: 'CREDITS',
    used: 350,
    limit: 1500,
    remaining: 1150,
    usedPercent: 350 / 1500 * 100,
    remainingPercent: 100 - (350 / 1500 * 100),
    resetsAt: null,
    showMeter: true
  });
});

test('parseTraeEntUsage fails closed instead of publishing partial credit packs', () => {
  assert.throws(() => parseTraeEntUsage({ user_entitlement_pack_list: [pack(100, 10), {}] }), /unusable active/);
  assert.throws(() => parseTraeEntUsage({ user_entitlement_pack_list: [pack(100, -1)] }), /unusable active/);
  assert.throws(() => parseTraeEntUsage({ user_entitlement_pack_list: [pack(0, 10)] }), /unusable active/);
  assert.throws(() => parseTraeEntUsage({ user_entitlement_pack_list: [] }), /no usable/);
  assert.throws(() => parseTraeEntUsage({}), /no entitlement pack list/);
});

test('parseTraeEntUsage preserves overage while clamping the spendable balance', () => {
  const settledAcrossPacks = parseTraeEntUsage({
    user_entitlement_pack_list: [pack(100, 120), pack(100, 20)]
  });
  assert.equal(settledAcrossPacks.window.used, 140);
  assert.equal(settledAcrossPacks.window.limit, 200);
  assert.equal(settledAcrossPacks.window.remaining, 60);
  assert.equal(settledAcrossPacks.window.usedPercent, 70);
  assert.equal(settledAcrossPacks.window.remainingPercent, 30);

  const exhausted = parseTraeEntUsage({
    user_entitlement_pack_list: [pack(100, 125)]
  });
  assert.equal(exhausted.window.used, 125);
  assert.equal(exhausted.window.limit, 100);
  assert.equal(exhausted.window.remaining, 0);
  assert.equal(exhausted.window.usedPercent, 100);
  assert.equal(exhausted.window.remainingPercent, 0);
});

test('parseTraeEntUsage skips feature entitlements and treats untouched packs as unconsumed', () => {
  // Real-account shape: a free-tier entitlement toggles solo features without a
  // credits_limit, and a pack nobody has drawn from yet reports an empty usage.
  const parsed = parseTraeEntUsage({
    user_entitlement_pack_list: [
      { entitlement_base_info: { quota: { credits_limit: 2000 } }, usage: {} },
      { entitlement_base_info: { quota: { credits_limit: 500, enable_solo_lite: true } }, usage: { credits_amount: 500 } },
      { entitlement_base_info: { quota: { enable_solo_agent: true, enable_solo_lite: true } }, usage: {} }
    ]
  });
  assert.equal(parsed.packCount, 2);
  assert.equal(parsed.window.limit, 2500);
  assert.equal(parsed.window.used, 500);
  assert.equal(parsed.window.remaining, 2000);
});

test('parseTraeEntUsage fails closed when a feature entitlement reports spend', () => {
  assert.throws(() => parseTraeEntUsage({
    user_entitlement_pack_list: [
      pack(100, 10),
      { entitlement_base_info: { quota: { enable_solo_lite: true } }, usage: { credits_amount: 5 } }
    ]
  }), /unusable active/);
});

test('fetchTraeLimits returns notConfigured without a token', async () => {
  const provider = await fetchTraeLimits({}, { env: {}, now: () => 0 });
  assert.equal(provider.provider, 'trae');
  assert.equal(provider.status, 'notConfigured');
  assert.equal(provider.region, 'cn');
  assert.deepEqual(provider.windows, []);
});

test('fetchTraeLimits sends managed credentials and does not expose them', async () => {
  const calls = [];
  const provider = await fetchTraeLimits({
    traeAccessToken: 'token-1',
    traeDeviceId: 'device-1'
  }, {
    env: {},
    now: () => 0,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response({ user_entitlement_pack_list: [pack(2000, 500)] });
    }
  });
  assert.equal(provider.provider, 'trae');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.region, 'cn');
  assert.equal(provider.windows[0].metric, 'credits');
  assert.equal(provider.windows[0].currency, 'CREDITS');
  assert.equal(provider.balance.amount, 1500);
  assert.equal(provider.balance.currency, 'CREDITS');
  assert.equal(JSON.stringify(provider).includes('token-1'), false);
  assert.equal(JSON.stringify(provider).includes('device-1'), false);

  assert.equal(calls[0].url, traeEntUsageUrl());
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Cloud-IDE-JWT token-1');
  assert.equal(calls[0].init.headers['X-User-Region'], 'CN');
  assert.equal(calls[0].init.headers['X-Device-Id'], 'device-1');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.body, '{}');
});

test('fetchTraeLimits normalizes authentication and rate-limit failures', async () => {
  const unauthorized = await fetchTraeLimits({ traeAccessToken: 'token' }, {
    env: {}, fetch: async () => response(null, 403)
  });
  assert.equal(unauthorized.status, 'unauthorized');

  const limited = await fetchTraeLimits({ traeAccessToken: 'token' }, {
    env: {}, fetch: async () => response(null, 429)
  });
  assert.equal(limited.status, 'sourceRateLimited');
});

test('fetchTraeLimits aborts a hung request and keeps body reads within the deadline', async () => {
  const request = await fetchTraeLimits({ traeAccessToken: 'token' }, {
    env: {},
    traeFetchTimeoutMs: 5,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    })
  });
  assert.equal(request.status, 'unavailable');

  const body = await fetchTraeLimits({ traeAccessToken: 'token' }, {
    env: {},
    traeFetchTimeoutMs: 5,
    fetch: async () => ({ ok: true, status: 200, json: async () => new Promise(() => {}) })
  });
  assert.equal(body.status, 'unavailable');
});

test('Trae Cookie resolves independently from legacy JWT and rejects header injection', () => {
  const { traeCookie } = require('../../src/shared/providers/trae/limits');
  assert.equal(traeCookie({ TRAE_COOKIE: 'sessionid=env' }, { traeCookie: 'Cookie: sessionid=saved' }), 'sessionid=saved');
  assert.equal(traeCookie({ TOKEN_MONITOR_TRAE_COOKIE: 'sessionid=alias' }), 'sessionid=alias');
  assert.equal(traeCookie({}, { traeCookie: 'sessionid=x\r\nHost: other.example' }), '');
});

test('Trae CN web session exchanges JWT then reads authoritative credit summary instead of the 401 IDE route', async () => {
  const calls = [];
  const provider = await fetchTraeLimits({ traeCookie: 'sessionid=web-account', traeAccessToken: 'legacy', traeDeviceId: 'telemetry' }, {
    env: {},
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/GetUserToken')) return response({ Result: { Token: 'web-jwt' } });
      if (url.endsWith('/user_current_entitlement_list')) return response({
        is_credits_billing: true, usage_summary: { total_amount: 15800, consumed_amount: 2455.51 },
        // Pack sums need not describe the currently spendable summary.
        user_entitlement_pack_list: [pack(99999, 0)]
      });
      return response({ code: 1001 }, 401);
    }
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.windows[0].limit, 15800);
  assert.equal(provider.windows[0].used, 2455.51);
  assert.equal(provider.windows[0].resetsAt, null);
  assert.equal(provider.balance.amount, 13344.49);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.body, '{}');
  assert.equal(calls[1].init.headers.Authorization, ['Cloud', 'IDE', 'JWT'].join('-') + ' web-jwt');
  assert.deepEqual(JSON.parse(calls[1].init.body), { require_usage: true, full_data: true });
  for (const { url, init } of calls) {
    assert.equal(new URL(url).origin, 'https://api.trae.cn');
    assert.equal(init.headers.Cookie, 'sessionid=web-account');
    assert.equal(init.headers.Origin, 'https://www.trae.cn');
    assert.equal(init.headers.Referer, 'https://www.trae.cn/');
    assert.equal(init.headers['X-Device-Id'], undefined);
    assert.equal(init.headers.Host, undefined);
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
  }
  assert.doesNotMatch(JSON.stringify(provider), /web-account|web-jwt|legacy|telemetry/);
});

test('Trae web rejects expired sessions and malformed token/summary without falling back to IDE credentials', async () => {
  for (const [tokenResponse, usageResponse, status] of [
    [response(null, 401), null, 'unauthorized'],
    [response({ code: 1001 }), null, 'unauthorized'],
    [response(null, 429), null, 'sourceRateLimited'],
    [response({ Result: {} }), null, 'unavailable'],
    [response({ Result: { Token: 'bad\r\ntoken' } }), null, 'unavailable'],
    [response({ Result: { Token: 'jwt' } }), response({ code: 1001 }), 'unauthorized'],
    [response({ Result: { Token: 'jwt' } }), response(null, 403), 'unauthorized'],
    [response({ Result: { Token: 'jwt' } }), response(null, 429), 'sourceRateLimited'],
    [response({ Result: { Token: 'jwt' } }), response({ user_entitlement_pack_list: [pack(100, 0)] }), 'unavailable'],
    [response({ Result: { Token: 'jwt' } }), response({ is_credits_billing: true, usage_summary: { total_amount: 100, consumed_amount: '20' } }), 'unavailable']
  ]) {
    const calls = [];
    const result = await fetchTraeLimits({ traeCookie: 'sessionid=x', traeAccessToken: 'legacy' }, {
      env: {}, fetch: async (url) => { calls.push(url); return calls.length === 1 ? tokenResponse : usageResponse; }
    });
    assert.equal(result.status, status);
    assert.deepEqual(result.windows, []);
    assert.equal(calls.some((url) => url.endsWith('/ide_user_ent_usage')), false);
  }
});

test('Trae web handles zero and overdrawn credits without inventing a reset', async () => {
  for (const [total, used] of [[0, 0], [0, 5], [100, 125]]) {
    const result = await fetchTraeLimits({ traeCookie: 'sessionid=x' }, {
      env: {}, fetch: async (url) => url.endsWith('/GetUserToken')
        ? response({ Result: { Token: 'jwt' } })
        : response({ is_credits_billing: true, usage_summary: { total_amount: total, consumed_amount: used } })
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.balance.amount, 0);
    assert.equal(result.windows[0].used, used);
    assert.equal(result.windows[0].resetsAt, null);
    assert.equal(result.windows[0].showMeter, total > 0);
  }
});

test('Trae web refresh and account swaps always exchange the current Cookie and never share JWTs', async () => {
  const seen = [];
  const deps = { env: {}, fetch: async (url, init) => {
    seen.push({ url, cookie: init.headers.Cookie, auth: init.headers.Authorization });
    return url.endsWith('/GetUserToken')
      ? response({ Result: { Token: `jwt-${init.headers.Cookie}` } })
      : response({ is_credits_billing: true, usage_summary: { total_amount: 100, consumed_amount: 10 } });
  } };
  const a = await fetchTraeLimits({ traeCookie: 'sessionid=a' }, deps);
  const b = await fetchTraeLimits({ traeCookie: 'sessionid=b' }, deps);
  await fetchTraeLimits({ traeCookie: 'sessionid=b' }, deps);
  assert.notEqual(a.accountKey, b.accountKey);
  assert.equal(seen.length, 6);
  for (let i = 0; i < seen.length; i += 2) {
    assert.equal(seen[i].auth, undefined);
    assert.equal(seen[i + 1].auth, ['Cloud', 'IDE', 'JWT'].join('-') + ' jwt-' + seen[i].cookie);
  }
});

test('Trae web exchange and entitlement body reads honor the injected deadline', async () => {
  for (const hungStage of ['token', 'usage']) {
    const result = await fetchTraeLimits({ traeCookie: 'sessionid=x' }, {
      env: {}, traeFetchTimeoutMs: 5,
      fetch: async (url) => url.endsWith('/GetUserToken') && hungStage === 'usage'
        ? response({ Result: { Token: 'jwt' } })
        : { ok: true, status: 200, json: async () => new Promise(() => {}) }
    });
    assert.equal(result.status, 'unavailable');
  }
});
