'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fetchStepfunLimits,
  stepfunCredentials,
  stepfunToken,
  deviceId,
  normalizeOasisToken
} = require('../../src/shared/providers/stepfun/limits');

// The password flow runs in a BrowserWindow (src/electron/providers/stepfun/
// login.js) because the site's password endpoint is behind a WAF that only
// clears inside page JavaScript. These tests cover the shared side of that
// split: how limits.js asks for a token, and what it does with the answer.

function jwtWith(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part(payload)}.sig`;
}

function quotaBody(overrides = {}) {
  return {
    status: 1,
    five_hour_usage_left_rate: 0.5,
    weekly_usage_left_rate: 0.25,
    five_hour_usage_reset_time: '1780000000',
    weekly_usage_reset_time: '1780500000',
    ...overrides
  };
}

function ok(body) {
  return { ok: true, status: 200, json: async () => body };
}

// A quota transport that answers the rate-limit and plan endpoints and
// records the headers each call carried.
function quotaFetch(rateBody = quotaBody(), seen = []) {
  return async (url, init = {}) => {
    seen.push({ url, headers: init.headers });
    if (String(url).includes('QueryStepPlanRateLimit')) return ok(rateBody);
    return ok({ status: 1, subscription: { name: 'Plus' } });
  };
}

test('normalizeOasisToken accepts a bare token, a cookie header, and an Oasis-Token prefix', () => {
  assert.equal(normalizeOasisToken('  abc.def.ghi  '), 'abc.def.ghi');
  assert.equal(normalizeOasisToken('Oasis-Token: abc.def.ghi'), 'abc.def.ghi');
  assert.equal(normalizeOasisToken('foo=1; Oasis-Token=abc.def.ghi; bar=2'), 'abc.def.ghi');
  // A semicolon or control byte would break the Cookie header it is spliced
  // into; ordinary spaces are fine (base64url JWTs do not carry them).
  assert.equal(normalizeOasisToken('has;semicolon'), '');
  assert.equal(normalizeOasisToken('has\nnewline'), '');
  assert.equal(normalizeOasisToken(''), '');
});

test('deviceId reads the device id off the token and never invents one', () => {
  assert.equal(deviceId(jwtWith({ device_id: 'dev-1' })), 'dev-1');
  assert.equal(deviceId(jwtWith({ device_id: 'bad id with spaces' })), '');
  assert.equal(deviceId(jwtWith({ other: 1 })), '');
  assert.equal(deviceId('not-a-jwt'), '');
  assert.equal(deviceId(''), '');
  // The site issues a device id per registration and rejects a foreign one, so
  // an unparseable token has to yield '' — the caller then omits the header —
  // rather than the hardcoded constant this replaced, which only ever worked
  // for the account it was captured from.
  assert.equal(deviceId('header.notbase64!.sig'), '');
});

test('stepfunToken reads the pasted token and the env fallbacks', () => {
  assert.equal(stepfunToken({}, { stepfunToken: ' pasted ' }), 'pasted');
  assert.equal(stepfunToken({ STEPFUN_TOKEN: 'env-token' }), 'env-token');
  assert.equal(stepfunToken({ TOKEN_MONITOR_STEPFUN_TOKEN: 'primary' }), 'primary');
  assert.equal(stepfunToken({ STEPFUN_TOKEN: 'env-token' }, { stepfunToken: 'settings' }), 'settings');
  assert.equal(stepfunToken({}, {}), '');
});

test('stepfunCredentials reads the settings pair and the env pair, and needs both halves', () => {
  assert.deepEqual(stepfunCredentials({}, { stepfunUsername: 'me', stepfunPassword: 'pw' }),
    { username: 'me', password: 'pw' });
  assert.deepEqual(stepfunCredentials({ STEPFUN_USERNAME: 'envuser', STEPFUN_PASSWORD: 'envpw' }),
    { username: 'envuser', password: 'envpw' });
  assert.equal(stepfunCredentials({ STEPFUN_USERNAME: 'envuser' }), null, 'a username alone configures nothing');
  assert.equal(stepfunCredentials({}, { stepfunUsername: 'me' }), null, 'neither half is enough');
  // Settings win over env so a local override beats a deployment default.
  assert.deepEqual(stepfunCredentials({ STEPFUN_USERNAME: 'envuser', STEPFUN_PASSWORD: 'envpw' },
    { stepfunUsername: 'me', stepfunPassword: 'pw' }), { username: 'me', password: 'pw' });
});

test('fetchStepfunLimits signs in through deps.signIn and uses the webid it returns', async () => {
  const seen = [];
  const refreshed = [];
  const signInCalls = [];
  const result = await fetchStepfunLimits({ stepfunUsername: 'me@example.com', stepfunPassword: 'pw' }, {
    env: {}, now: () => 1770000000000,
    signIn: async (options) => {
      signInCalls.push(options);
      return { token: 'fresh-token', webid: 'web-9' };
    },
    fetch: quotaFetch(quotaBody(), seen),
    onTokenRefreshed: (token) => refreshed.push(token)
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.accountLabel, 'Plus');
  assert.deepEqual(result.windows.map(({ kind, usedPercent }) => [kind, usedPercent]),
    [['session', 50], ['weekly', 75]]);

  assert.equal(signInCalls.length, 1);
  assert.equal(signInCalls[0].username, 'me@example.com');
  assert.equal(signInCalls[0].password, 'pw');
  assert.ok(signInCalls[0].timeoutMs > 0, 'the window needs a budget of its own');

  // The device id the sign-in was issued with has to reach the quota request;
  // a token and a webid from different sessions are rejected.
  const rate = seen.find((c) => c.url.includes('QueryStepPlanRateLimit'));
  assert.equal(rate.headers['oasis-webid'], 'web-9');
  assert.equal(rate.headers.Cookie, 'Oasis-Token=fresh-token; Oasis-Webid=web-9');
  assert.deepEqual(refreshed, ['fresh-token'], 'the minted token is handed back so it can be cached');
});

test('fetchStepfunLimits falls back to the token payload for the webid', async () => {
  const seen = [];
  const result = await fetchStepfunLimits({ stepfunUsername: 'me', stepfunPassword: 'pw' }, {
    env: {}, now: () => 1770000000000,
    signIn: async () => ({ token: jwtWith({ device_id: 'dev-from-jwt' }) }),
    fetch: quotaFetch(quotaBody(), seen)
  });

  assert.equal(result.status, 'ok');
  const rate = seen.find((c) => c.url.includes('QueryStepPlanRateLimit'));
  assert.equal(rate.headers['oasis-webid'], 'dev-from-jwt');
});

test('fetchStepfunLimits omits the webid entirely when it has no real value', async () => {
  const seen = [];
  const result = await fetchStepfunLimits({ stepfunUsername: 'me', stepfunPassword: 'pw' }, {
    env: {}, now: () => 1770000000000,
    signIn: async () => ({ token: 'opaque-token' }),
    fetch: quotaFetch(quotaBody(), seen)
  });

  assert.equal(result.status, 'ok');
  const rate = seen.find((c) => c.url.includes('QueryStepPlanRateLimit'));
  assert.ok(!('oasis-webid' in rate.headers), 'a guessed device id is worse than none');
  assert.equal(rate.headers.Cookie, 'Oasis-Token=opaque-token');
});

test('fetchStepfunLimits reports unavailable without a browser to sign in through', async () => {
  let called = 0;
  const result = await fetchStepfunLimits({ stepfunUsername: 'me', stepfunPassword: 'pw' }, {
    env: {}, now: () => 1770000000000,
    fetch: async () => { called += 1; return ok(quotaBody()); }
  });

  // The headless agent has no BrowserWindow, so there is no way to renew a
  // token — a manual paste stays the only lane, and the probe has to say so
  // rather than fail with a confusing auth error.
  assert.equal(result.status, 'unavailable');
  assert.equal(called, 0, 'nothing is probed without a token');
  assert.deepEqual(result.windows, []);
});

test('fetchStepfunLimits re-signs-in once when a cached token comes back unauthorized', async () => {
  let rateCalls = 0;
  let signIns = 0;
  const refreshed = [];
  const result = await fetchStepfunLimits({ stepfunUsername: 'me', stepfunPassword: 'pw' }, {
    env: {}, now: () => 1770000000000, cachedToken: 'stale-token',
    signIn: async () => { signIns += 1; return { token: 'fresh-token', webid: 'web-2' }; },
    fetch: async (url, init = {}) => {
      if (String(url).includes('QueryStepPlanRateLimit')) {
        rateCalls += 1;
        assert.equal(init.headers.Cookie, rateCalls === 1
          ? 'Oasis-Token=stale-token'
          : 'Oasis-Token=fresh-token; Oasis-Webid=web-2');
        return rateCalls === 1
          ? { ok: false, status: 401, json: async () => ({}) }
          : ok(quotaBody({ five_hour_usage_left_rate: 0.9, weekly_usage_left_rate: 0.9 }));
      }
      return ok({ status: 1 });
    },
    onTokenRefreshed: (token) => refreshed.push(token)
  });

  assert.equal(result.status, 'ok', 'a stale cache self-heals instead of surfacing unauthorized');
  assert.equal(rateCalls, 2, 'the probe retries once after re-login');
  assert.equal(signIns, 1, 'a second failure is not retried forever');
  assert.deepEqual(refreshed, ['fresh-token']);
});

test('fetchStepfunLimits picks up the new webid on the re-login retry', async () => {
  let rateCalls = 0;
  await fetchStepfunLimits({ stepfunUsername: 'me', stepfunPassword: 'pw' }, {
    env: {}, now: () => 1770000000000, cachedToken: jwtWith({ device_id: 'dev-old' }),
    signIn: async () => ({ token: jwtWith({ device_id: 'dev-new' }), webid: 'web-new' }),
    fetch: async (url, init = {}) => {
      if (String(url).includes('QueryStepPlanRateLimit')) {
        rateCalls += 1;
        // Reusing the aged-out session's device id would fail the retry for a
        // second, unrelated reason and mask the real outcome.
        assert.equal(init.headers['oasis-webid'], rateCalls === 1 ? 'dev-old' : 'web-new');
        return rateCalls === 1 ? { ok: false, status: 401, json: async () => ({}) } : ok(quotaBody());
      }
      return ok({ status: 1 });
    }
  });
  assert.equal(rateCalls, 2);
});

test('fetchStepfunLimits stays unauthorized when re-login cannot fix a bad password', async () => {
  const result = await fetchStepfunLimits({ stepfunUsername: 'me', stepfunPassword: 'wrong' }, {
    env: {}, now: () => 1770000000000, cachedToken: 'stale-token',
    signIn: async () => {
      const error = new Error('StepFun rejected the credentials');
      error.status = 'unauthorized';
      throw error;
    },
    fetch: async () => ({ ok: false, status: 401, json: async () => ({}) })
  });

  assert.equal(result.status, 'unauthorized',
    'wrong credentials must still read as unauthorized, not as a transport failure');
  assert.deepEqual(result.windows, []);
});

test('fetchStepfunLimits prefers an explicit token over signing in', async () => {
  let signIns = 0;
  const seen = [];
  const result = await fetchStepfunLimits(
    { stepfunUsername: 'me', stepfunPassword: 'pw', stepfunToken: 'pasted-token' },
    {
      env: {}, now: () => 1770000000000,
      signIn: async () => { signIns += 1; return { token: 'fresh' }; },
      fetch: quotaFetch(quotaBody(), seen)
    });

  assert.equal(result.status, 'ok');
  assert.equal(signIns, 0, 'a pasted token is a deliberate override');
  const rate = seen.find((c) => c.url.includes('QueryStepPlanRateLimit'));
  assert.match(rate.headers.Cookie, /^Oasis-Token=pasted-token/);
});

test('fetchStepfunLimits uses a cached token without signing in', async () => {
  let signIns = 0;
  const seen = [];
  const result = await fetchStepfunLimits({ stepfunUsername: 'me', stepfunPassword: 'pw' }, {
    env: {}, now: () => 1770000000000, cachedToken: 'cached-token',
    signIn: async () => { signIns += 1; return { token: 'fresh' }; },
    fetch: quotaFetch(quotaBody(), seen)
  });

  assert.equal(result.status, 'ok');
  assert.equal(signIns, 0, 'a live cache is the cheap path');
  const rate = seen.find((c) => c.url.includes('QueryStepPlanRateLimit'));
  assert.match(rate.headers.Cookie, /^Oasis-Token=cached-token/);
});

test('fetchStepfunLimits keys a password login on the account, so a rotated token is the same row', async () => {
  const run = (cachedToken) => fetchStepfunLimits({ stepfunUsername: 'me@example.com', stepfunPassword: 'pw' }, {
    env: {}, now: () => 1770000000000, cachedToken,
    fetch: quotaFetch()
  });

  const before = await run('old');
  const after = await run('rotated');
  assert.equal(before.status, 'ok');
  assert.equal(after.status, 'ok');
  assert.equal(before.accountKey, after.accountKey,
    'a token rotation must not fork one login into several accounts');
});

test('fetchStepfunLimits keys a token-only setup on the token itself', async () => {
  const a = await fetchStepfunLimits({ stepfunToken: 'token-a' }, { env: {}, now: () => 1770000000000, fetch: quotaFetch() });
  const b = await fetchStepfunLimits({ stepfunToken: 'token-b' }, { env: {}, now: () => 1770000000000, fetch: quotaFetch() });
  assert.equal(a.status, 'ok');
  assert.notEqual(a.accountKey, b.accountKey);
});

test('fetchStepfunLimits reports notConfigured when neither a token nor a password exists', async () => {
  const result = await fetchStepfunLimits({}, {
    env: {},
    fetch: async () => { throw new Error('must not be called'); }
  });
  assert.equal(result.status, 'notConfigured');
  assert.deepEqual(result.windows, []);
});

test('fetchStepfunLimits reports unavailable when the quota body is unusable', async () => {
  const result = await fetchStepfunLimits({ stepfunUsername: 'me', stepfunPassword: 'pw' }, {
    env: {}, now: () => 1770000000000,
    signIn: async () => ({ token: 'fresh' }),
    fetch: quotaFetch({ status: 1 })
  });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.windows, []);
});