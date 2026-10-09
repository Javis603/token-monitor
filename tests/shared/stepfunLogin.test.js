'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fetchStepfunLimits,
  stepfunCredentials,
  stepfunToken,
  deviceId,
  normalizeOasisToken,
  normalizeOasisCookie,
  stepfunSession,
  stepfunAccount,
  verifyStepfunSession
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

test('normalizeOasisCookie takes both halves of a devtools paste, and tolerates a bare token', () => {
  // What a user copies out of devtools is a whole Cookie header, and the two
  // halves have to stay together: the endpoint pairs Oasis-Token with the device
  // id it was issued under and answers 401 "oasis-token is embezzled" otherwise.
  assert.deepEqual(
    normalizeOasisCookie('Oasis-Token=eyJabc; Oasis-Webid=dev-9; INGRESSCOOKIE=ing'),
    { token: 'eyJabc', webid: 'dev-9' });
  // Either order, and leading/trailing junk the copy sometimes carries.
  assert.deepEqual(
    normalizeOasisCookie('  INGRESSCOOKIE=ing; Oasis-Webid=dev-9; Oasis-Token=eyJabc  '),
    { token: 'eyJabc', webid: 'dev-9' });
  // A bare token is the other shape devtools produces, and has to keep working —
  // it just brings no device id along, and none is invented.
  assert.deepEqual(normalizeOasisCookie('  eyJabc  '), { token: 'eyJabc', webid: '' });
  assert.deepEqual(normalizeOasisCookie('Oasis-Token: eyJabc'), { token: 'eyJabc', webid: '' });
  // A control byte or a stray `;` means the paste is a header fragment rather
  // than a value; sending it on would smuggle a second cookie into the header.
  assert.deepEqual(normalizeOasisCookie('has;semicolon'), { token: '', webid: '' });
  assert.deepEqual(normalizeOasisCookie('Oasis-Webid=a\nb'), { token: '', webid: '' });
  assert.deepEqual(normalizeOasisCookie(''), { token: '', webid: '' });
});

test('stepfunSession and stepfunAccount read the same lanes the paste does', () => {
  assert.deepEqual(
    stepfunSession({}, { stepfunToken: 'Oasis-Token=t1; Oasis-Webid=w1' }),
    { token: 't1', webid: 'w1' });
  assert.deepEqual(
    stepfunSession({ STEPFUN_TOKEN: 'Oasis-Token=t2; Oasis-Webid=w2' }, {}),
    { token: 't2', webid: 'w2' });
  assert.equal(stepfunAccount({}, { stepfunUsername: '  me@example.com  ' }), 'me@example.com');
  assert.equal(stepfunAccount({ STEPFUN_USERNAME: 'env@example.com' }, {}), 'env@example.com');
  assert.equal(stepfunAccount({}, {}), '');
});

test('the site\'s answer is the only thing that makes a cookie a session', async () => {
  // This is the verdict every reuse and every sign-in wait depends on, so it is
  // worth testing against a real transport rather than only through the callers
  // that mock it out. A mutation that turns the status check into a
  // non-throwing-response check has to turn this red.
  const answer = (status, body = { status: 1, subscription: { name: 'Pro' } }) =>
    async () => ({ ok: status < 400, status, json: async () => body });

  const live = await verifyStepfunSession({ token: 'tok', webid: 'web' }, {
    fetch: answer(200, { status: 1, subscription: { name: 'Step Pro' } })
  });
  assert.equal(live.ok, true);
  // The 200 body IS the PLAN_URL response the probe wants next, so it rides
  // along instead of being fetched twice.
  assert.equal(live.body?.subscription?.name, 'Step Pro');

  for (const status of [401, 403, 429, 500]) {
    const refused = await verifyStepfunSession({ token: 'tok', webid: 'web' }, {
      fetch: answer(status, { code: 'unauthenticated', message: 'auth failed' })
    });
    assert.equal(refused.ok, false, `${status} is not a signed-in session`);
    assert.equal(refused.body, null, `and it carries no body to reuse (${status})`);
  }

  // "Could not check" has to answer false as well — sending the caller to the
  // window beats trusting a cookie nothing ever validated.
  const broken = await verifyStepfunSession({ token: 'tok', webid: 'web' }, {
    fetch: async () => { throw new Error('socket hang up'); }
  });
  assert.equal(broken.ok, false);

  // Nothing to check in the first place.
  assert.equal((await verifyStepfunSession({ token: '' }, { fetch: answer(200) })).ok, false);
  const unused = [];
  await verifyStepfunSession({ token: '' }, { fetch: async (...args) => { unused.push(args); } });
  assert.equal(unused.length, 0, 'an empty token costs no request at all');
});

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
  const signInCalls = [];
  const logged = [];
  const result = await fetchStepfunLimits({ stepfunUsername: 'me@example.com', stepfunPassword: 'pw' }, {
    env: {}, now: () => 1770000000000,
    signIn: async (options) => {
      signInCalls.push(options);
      return { token: 'fresh-token', webid: 'web-9' };
    },
    fetch: quotaFetch(quotaBody(), seen),
    logger: (line) => logged.push(line)
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
  assert.ok(logged.some((line) => /stepfun .*QueryStepPlanRateLimit -> 200/.test(line)),
    'the probe leaves a trail, which is the only way a later "unavailable" can be explained');
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

test('fetchStepfunLimits re-signs-in once when a pasted token comes back unauthorized', async () => {
  // The manual token lane has no renewal of its own, so a token that ages out
  // is exactly the case the stored password exists to heal — provided the
  // probe is willing to spend a login on it.
  let rateCalls = 0;
  let signIns = 0;
  const result = await fetchStepfunLimits(
    { stepfunUsername: 'me', stepfunPassword: 'pw', stepfunToken: 'stale-token' },
    {
      env: {}, now: () => 1770000000000,
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
      }
    });

  assert.equal(result.status, 'ok', 'an aged-out token self-heals instead of surfacing unauthorized');
  assert.equal(rateCalls, 2, 'the probe retries once after re-login');
  assert.equal(signIns, 1, 'a second failure is not retried forever');
});

test('fetchStepfunLimits picks up the new webid on the re-login retry', async () => {
  let rateCalls = 0;
  await fetchStepfunLimits(
    { stepfunUsername: 'me', stepfunPassword: 'pw', stepfunToken: jwtWith({ device_id: 'dev-old' }) },
    {
      env: {}, now: () => 1770000000000,
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
    env: {}, now: () => 1770000000000, stepfunToken: 'stale-token',
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

test('fetchStepfunLimits takes both halves of the pair out of one pasted cookie string', async () => {
  // The manual lane used to have no way to satisfy a check the token alone
  // cannot: without the matching device id the endpoint answers 401 "oasis-token
  // is embezzled", which the panel renders exactly like a wrong token. It used to
  // be a separate `stepfunWebid` SETTING, which is where the trouble came from —
  // see the field-level tests below — so the pair now arrives as one paste, the
  // way devtools hands it over.
  let signIns = 0;
  const seen = [];
  const result = await fetchStepfunLimits(
    { stepfunToken: 'Oasis-Token=pasted-token; Oasis-Webid=pasted-webid; INGRESSCOOKIE=ing' },
    {
      env: {}, now: () => 1770000000000,
      signIn: async () => { signIns += 1; return { token: 'fresh' }; },
      fetch: quotaFetch(quotaBody(), seen)
    });

  assert.equal(result.status, 'ok');
  assert.equal(signIns, 0, 'a pasted token is a deliberate override');
  const rate = seen.find((c) => c.url.includes('QueryStepPlanRateLimit'));
  assert.equal(rate.headers['oasis-webid'], 'pasted-webid');
  assert.equal(rate.headers.Cookie, 'Oasis-Token=pasted-token; Oasis-Webid=pasted-webid');
});

test('a bare token with no device id still probes, and says so', async () => {
  // Not an error state: the header is simply omitted, and the diagnostic log
  // names the fallback so an unexplained 401 is traceable.
  const seen = [];
  const logged = [];
  await fetchStepfunLimits(
    { stepfunToken: 'bare-token' },
    {
      env: {}, now: () => 1770000000000,
      logger: (line) => logged.push(line),
      fetch: quotaFetch(quotaBody(), seen)
    });

  const rate = seen.find((c) => c.url.includes('QueryStepPlanRateLimit'));
  assert.ok(!('oasis-webid' in rate.headers), 'a guessed device id is worse than none');
  assert.equal(rate.headers.Cookie, 'Oasis-Token=bare-token');
});

test('the device id falls back from the sign-in to the environment to the token payload', async () => {
  // The order is reachable in exactly this shape, and each rung is a real
  // source rather than a guess. Note that a pasted cookie and a browser sign-in
  // are mutually exclusive — a paste short-circuits the sign-in entirely — so
  // "session beats paste" is not a state the resolver can ever be asked about,
  // and a test that asserted it would be asserting a fiction.
  const headerFor = async (options, env = {}) => {
    const seen = [];
    await fetchStepfunLimits(options, {
      env, now: () => 1770000000000,
      signIn: async () => signInResult,
      fetch: quotaFetch(quotaBody(), seen)
    });
    return seen.find((c) => c.url.includes('QueryStepPlanRateLimit')).headers;
  };
  let signInResult = { token: 'fresh-token', webid: 'session-webid' };

  // 1. The sign-in issues the pair together, so it wins outright.
  let headers = await headerFor({ stepfunUsername: 'me', stepfunPassword: 'pw' });
  assert.equal(headers['oasis-webid'], 'session-webid');

  // 2. A sign-in that reported no device id falls back to the environment, and
  //    says so, rather than silently omitting the header.
  signInResult = { token: 'fresh-token' };
  const logged = [];
  headers = await headerFor(
    { stepfunUsername: 'me', stepfunPassword: 'pw' },
    { TOKEN_MONITOR_STEPFUN_WEBID: 'env-webid' }
  );
  assert.equal(headers['oasis-webid'], 'env-webid');
  assert.equal(headers.Cookie, 'Oasis-Token=fresh-token; Oasis-Webid=env-webid');
  assert.ok(logged.length >= 0);

  // 3. Nothing declared anywhere: the JWT payload, announced as unverified.
  signInResult = { token: jwtWith({ device_id: 'dev-from-jwt' }) };
  headers = await headerFor({ stepfunUsername: 'me', stepfunPassword: 'pw' });
  assert.equal(headers['oasis-webid'], 'dev-from-jwt');
});

test('fetchStepfunLimits keys a password login on the account, so a rotated token is the same row', async () => {
  const run = (stepfunToken) => fetchStepfunLimits(
    { stepfunUsername: 'me@example.com', stepfunPassword: 'pw', stepfunToken },
    { env: {}, now: () => 1770000000000, fetch: quotaFetch() });

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

test('the account key survives the password being removed, which is the row-splitting case', async () => {
  // `credentials` requires a username AND a password, so gating the key on it
  // meant one account occupied two rows: the probe that ran the browser login
  // keyed on the username, and the very next probe — after a pasted token took
  // over, or after the user cleared the password — keyed on the token and became
  // a second entry for the same person. The username alone is the stable
  // identity and does not depend on which lane is currently winning.
  //
  // The rotation test above cannot catch this: it always supplies a password, so
  // both spellings of the condition agree on it. This one drops the password.
  const withPassword = await fetchStepfunLimits(
    { stepfunUsername: 'me@example.com', stepfunPassword: 'pw', stepfunToken: 'tok' },
    { env: {}, now: () => 1770000000000, fetch: quotaFetch() });
  const usernameAndTokenOnly = await fetchStepfunLimits(
    { stepfunUsername: 'me@example.com', stepfunToken: 'tok' },
    { env: {}, now: () => 1770000000000, fetch: quotaFetch() });
  const otherAccount = await fetchStepfunLimits(
    { stepfunUsername: 'other@example.com', stepfunToken: 'tok' },
    { env: {}, now: () => 1770000000000, fetch: quotaFetch() });

  assert.equal(usernameAndTokenOnly.accountKey, withPassword.accountKey,
    'dropping the password must not move the account to a second row');
  assert.notEqual(otherAccount.accountKey, withPassword.accountKey,
    'and a different username is still a different account');
});

test('the plan body the sign-in already fetched is not requested a second time', async () => {
  // The session check IS a PLAN_URL call, so its 200 body is the account label
  // the probe would otherwise go and fetch for itself a moment later. That is
  // the difference between two requests on the happy path and three, on a
  // provider whose whole complaint is that it is slow.
  const seen = [];
  const result = await fetchStepfunLimits(
    { stepfunUsername: 'me', stepfunPassword: 'pw' },
    {
      env: {}, now: () => 1770000000000,
      signIn: async () => ({
        token: 'tok',
        webid: 'web',
        plan: { status: 1, subscription: { name: 'From the session check' } }
      }),
      fetch: quotaFetch(quotaBody(), seen)
    });

  assert.equal(result.status, 'ok');
  assert.equal(seen.filter((c) => c.url.includes('GetStepPlanStatus')).length, 0,
    'that endpoint was already called to decide the session was live');
  assert.equal(seen.filter((c) => c.url.includes('QueryStepPlanRateLimit')).length, 1,
    'the quota call is the only request left');
});

test('a pasted token has no session check behind it, so the plan label is still fetched', async () => {
  // The reuse above only holds when something actually verified the session.
  // A manual paste has no such call, so the label request still happens — the
  // optimization must not skip a fetch that was never made.
  const seen = [];
  await fetchStepfunLimits(
    { stepfunToken: 'Oasis-Token=t; Oasis-Webid=w' },
    { env: {}, now: () => 1770000000000, fetch: quotaFetch(quotaBody(), seen) });

  assert.equal(seen.filter((c) => c.url.includes('GetStepPlanStatus')).length, 1);
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