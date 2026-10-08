'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  loginStepFun,
  normalizeOasisToken,
  readSetCookies,
  cookieValue,
  tokenFromPayload
} = require('../../src/shared/providers/stepfun/login');
const {
  fetchStepfunLimits,
  stepfunCredentials
} = require('../../src/shared/providers/stepfun/limits');

function headersWithCookies(...cookies) {
  return {
    getSetCookie: () => cookies,
    get: (name) => (name.toLowerCase() === 'set-cookie' ? cookies.join(', ') : null)
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

test('readSetCookies prefers getSetCookie and falls back to a folded header', () => {
  const list = ['a=1', 'INGRESSCOOKIE=ing-1'];
  assert.deepEqual(readSetCookies({ getSetCookie: () => list }), list);
  assert.deepEqual(readSetCookies({ get: () => 'b=2, INGRESSCOOKIE=ing-2' }), ['b=2, INGRESSCOOKIE=ing-2']);
  assert.deepEqual(readSetCookies({}), []);
  assert.equal(cookieValue(list, 'INGRESSCOOKIE'), 'ing-1');
  assert.equal(cookieValue(['a=1; Path=/; HttpOnly'], 'INGRESSCOOKIE'), '');
});

test('tokenFromPayload reads the token out of each shape the passport service uses', () => {
  assert.equal(tokenFromPayload({ token: 'plain' }), 'plain');
  assert.equal(tokenFromPayload({ access_token: 'access' }), 'access');
  assert.equal(tokenFromPayload({ data: { oasis_token: 'oasis' } }), 'oasis');
  assert.equal(tokenFromPayload({ data: { token: 'Oasis-Token: nested' } }), 'nested');
  assert.equal(tokenFromPayload({ status: 1 }), '');
  assert.equal(tokenFromPayload(null), '');
});

test('loginStepFun runs the three-step flow and returns the authenticated token', async () => {
  const calls = [];
  const token = await loginStepFun({ username: 'me@example.com', password: 'hunter2' }, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/')) {
        return { ok: true, status: 302, headers: headersWithCookies('x=1', 'INGRESSCOOKIE=ing-9') };
      }
      if (url.endsWith('RegisterDevice')) {
        return { ok: true, headers: headersWithCookies(), json: async () => ({ code: 0, data: { access_token: 'anon-1' } }) };
      }
      return { ok: true, headers: headersWithCookies(), json: async () => ({ code: 0, data: { token: 'authed-token' } }) };
    }
  });

  assert.equal(token, 'authed-token');
  assert.equal(calls.length, 3, 'landing, register, sign-in');
  assert.ok(calls[0].url.endsWith('/'), 'step 1 is the landing page');
  assert.ok(calls[1].url.endsWith('RegisterDevice'), 'step 2 registers the device');
  assert.ok(calls[2].url.endsWith('SignInByPassword'), 'step 3 signs in');

  // Step 2 carries the ingress cookie from step 1.
  assert.equal(calls[1].init.headers.Cookie, 'INGRESSCOOKIE=ing-9');
  assert.equal(calls[1].init.headers['oasis-appid'], '10300');
  // Step 3 carries the ingress cookie AND the anonymous token from step 2,
  // and puts the credentials in the body rather than a header.
  assert.equal(calls[2].init.headers['Oasis-Token'], 'anon-1');
  assert.equal(calls[2].init.headers.Cookie, 'INGRESSCOOKIE=ing-9');
  assert.deepEqual(JSON.parse(calls[2].init.body), { username: 'me@example.com', password: 'hunter2' });
  assert.equal(calls[2].init.credentials, 'omit');
});

test('loginStepFun reports a missing ingress cookie as unavailable, not unauthorized', async () => {
  await assert.rejects(
    loginStepFun({ username: 'u', password: 'p' }, {
      fetch: async () => ({ ok: true, status: 200, headers: headersWithCookies('nope=1') })
    }),
    (error) => error.status === 'unavailable'
  );
});

test('loginStepFun classifies a credential rejection as unauthorized', async () => {
  const flow = async (signInBody) => loginStepFun({ username: 'u', password: 'wrong' }, {
    fetch: async (url) => {
      if (url.endsWith('/')) return { ok: true, headers: headersWithCookies('INGRESSCOOKIE=i') };
      if (url.endsWith('RegisterDevice')) return { ok: true, json: async () => ({ code: 0, data: { token: 'anon' } }) };
      return { ok: true, json: async () => signInBody };
    }
  });

  await assert.rejects(
    flow({ code: 4001, msg: '密码错误' }),
    (error) => error.status === 'unauthorized'
  );
  await assert.rejects(
    flow({ code: 5000, msg: '内部错误' }),
    (error) => error.status === 'unavailable'
  );
  // An HTTP 401 is unauthorized regardless of the body.
  await assert.rejects(
    loginStepFun({ username: 'u', password: 'p' }, {
      fetch: async (url) => {
        if (url.endsWith('/')) return { ok: true, headers: headersWithCookies('INGRESSCOOKIE=i') };
        if (url.endsWith('RegisterDevice')) return { ok: true, json: async () => ({ code: 0, data: { token: 'anon' } }) };
        return { ok: false, status: 401, json: async () => ({}) };
      }
    }),
    (error) => error.status === 'unauthorized'
  );
});

test('loginStepFun requires both a username and a password before any request', async () => {
  let called = 0;
  const fetchSpy = async () => { called += 1; return { ok: true }; };
  await assert.rejects(loginStepFun({ username: 'u' }, { fetch: fetchSpy }), (error) => error.status === 'unauthorized');
  await assert.rejects(loginStepFun({ password: 'p' }, { fetch: fetchSpy }), (error) => error.status === 'unauthorized');
  assert.equal(called, 0, 'an incomplete credential pair must not hit the network');
});

test('loginStepFun skips the landing request when a caller supplies the ingress cookie', async () => {
  const urls = [];
  await loginStepFun({ username: 'u', password: 'p' }, {
    ingressCookie: 'cached-ing',
    fetch: async (url) => {
      urls.push(url);
      if (url.endsWith('RegisterDevice')) return { ok: true, json: async () => ({ code: 0, data: { token: 'anon' } }) };
      return { ok: true, json: async () => ({ code: 0, data: { token: 'authed' } }) };
    }
  });
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => !url.endsWith('/')), 'no landing GET when the cookie is already known');
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

test('fetchStepfunLimits logs in with the stored password when no token is cached', async () => {
  const seen = [];
  const result = await fetchStepfunLimits({ stepfunUsername: 'me', stepfunPassword: 'pw' }, {
    env: {}, now: () => 1770000000000,
    fetch: async (url, init) => {
      seen.push(url);
      if (url.endsWith('/')) return { ok: true, headers: headersWithCookies('INGRESSCOOKIE=ing') };
      if (url.endsWith('RegisterDevice')) return { ok: true, json: async () => ({ code: 0, data: { token: 'anon' } }) };
      if (url.endsWith('SignInByPassword')) return { ok: true, json: async () => ({ code: 0, data: { token: 'fresh-token' } }) };
      return { ok: true, json: async () => url.includes('QueryStepPlanRateLimit')
        ? { status: 1, five_hour_usage_left_rate: 0.5, weekly_usage_left_rate: 0.25,
          five_hour_usage_reset_time: '1780000000', weekly_usage_reset_time: '1780500000' }
        : { status: 1, subscription: { name: 'Plus' } } };
    },
    onTokenRefreshed: (token) => seen.push(`refreshed:${token}`)
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.accountLabel, 'Plus');
  assert.deepEqual(result.windows.map(({ kind, usedPercent }) => [kind, usedPercent]), [['session', 50], ['weekly', 75]]);
  assert.ok(seen.includes('refreshed:fresh-token'), 'the minted token is handed back so it can be cached');
});

test('fetchStepFunLimits re-logs in once when a cached token comes back unauthorized', async () => {
  const seen = [];
  let rateCalls = 0;
  const refreshed = [];
  const result = await fetchStepfunLimits({ stepfunUsername: 'me', stepfunPassword: 'pw' }, {
    env: {}, now: () => 1770000000000,
    cachedToken: 'stale-token',
    fetch: async (url) => {
      seen.push(url);
      if (url.endsWith('/')) return { ok: true, headers: headersWithCookies('INGRESSCOOKIE=ing') };
      if (url.endsWith('RegisterDevice')) return { ok: true, json: async () => ({ code: 0, data: { token: 'anon' } }) };
      if (url.endsWith('SignInByPassword')) return { ok: true, json: async () => ({ code: 0, data: { token: 'fresh-token' } }) };
      if (url.includes('QueryStepPlanRateLimit')) {
        rateCalls += 1;
        // The cached token fails once, the re-login fixes it.
        return rateCalls === 1
          ? { ok: false, status: 401, json: async () => ({}) }
          : { ok: true, json: async () => ({ status: 1, five_hour_usage_left_rate: 0.9, weekly_usage_left_rate: 0.9,
            five_hour_usage_reset_time: '1780000000', weekly_usage_reset_time: '1780500000' }) };
      }
      return { ok: true, json: async () => ({ status: 1 }) };
    },
    onTokenRefreshed: (token) => refreshed.push(token)
  });

  assert.equal(result.status, 'ok', 'a stale cache self-heals instead of surfacing unauthorized');
  assert.equal(rateCalls, 2, 'the probe retries once after re-login');
  assert.deepEqual(refreshed, ['fresh-token']);
});

test('fetchStepFunLimits stays unauthorized when re-login cannot fix a bad password', async () => {
  const result = await fetchStepfunLimits({ stepfunUsername: 'me', stepfunPassword: 'wrong' }, {
    env: {}, now: () => 1770000000000,
    cachedToken: 'stale-token',
    fetch: async (url) => {
      if (url.endsWith('/')) return { ok: true, headers: headersWithCookies('INGRESSCOOKIE=ing') };
      if (url.endsWith('RegisterDevice')) return { ok: true, json: async () => ({ code: 0, data: { token: 'anon' } }) };
      if (url.endsWith('SignInByPassword')) return { ok: true, json: async () => ({ code: 4001, msg: '密码错误' }) };
      return { ok: false, status: 401, json: async () => ({}) };
    }
  });
  assert.equal(result.status, 'unauthorized', 'wrong credentials must still read as unauthorized, not as a transport failure');
  assert.deepEqual(result.windows, []);
});

test('fetchStepFunLimits keys a password login on the account, so a rotated token is the same row', async () => {
  const quotaBody = { status: 1, five_hour_usage_left_rate: 0.8, weekly_usage_left_rate: 0.8,
    five_hour_usage_reset_time: '1780000000', weekly_usage_reset_time: '1780500000' };
  const run = (cachedToken) => fetchStepfunLimits({ stepfunUsername: 'me@example.com', stepfunPassword: 'pw' }, {
    env: {}, now: () => 1770000000000, cachedToken,
    fetch: async (url) => {
      if (url.endsWith('/')) return { ok: true, headers: headersWithCookies('INGRESSCOOKIE=ing') };
      if (url.endsWith('RegisterDevice')) return { ok: true, json: async () => ({ code: 0, data: { token: 'anon' } }) };
      if (url.endsWith('SignInByPassword')) return { ok: true, json: async () => ({ code: 0, data: { token: cachedToken === 'old' ? 'rotated' : cachedToken } }) };
      return { ok: true, json: async () => url.includes('QueryStepPlanRateLimit') ? quotaBody : { status: 1 } };
    }
  });

  const before = await run('old');
  const after = await run('rotated');
  assert.equal(before.status, 'ok');
  assert.equal(after.status, 'ok');
  assert.equal(before.accountKey, after.accountKey, 'a token rotation must not fork one login into several accounts');
});

test('fetchStepFunLimits reports notConfigured when neither a token nor a password exists', async () => {
  const result = await fetchStepfunLimits({}, { env: {}, fetch: async () => { throw new Error('must not be called'); } });
  assert.equal(result.status, 'notConfigured');
  assert.deepEqual(result.windows, []);
});
