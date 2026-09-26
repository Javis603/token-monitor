'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MIMO_EXCHANGE_STATUSES,
  createMimoCookieJar,
  exchangeMimoConsoleSession,
  exchangeMimoServiceSession,
  readMimoAccountStatus
} = require('../../src/shared/providers/mimo/ssoExchange');

const BASE = 'https://mimo-server-cn.xiaomimimo.com/api';
const ACCOUNT_COOKIE = 'passToken=account-pass-token; userId=1234567890';

function reply(status, { location = '', setCookie = [], body = '' } = {}) {
  return {
    status,
    headers: {
      get: (name) => (name.toLowerCase() === 'location' ? location : null),
      getSetCookie: () => setCookie
    },
    text: async () => body
  };
}

// The chain observed live: the account call 302s to the account host, the
// account host 302s back to the service's own /sts, that hop mints the service
// cookies and 307s to the same account call, which then answers. The me path is
// therefore visited twice with different answers, which is what the walk exists
// to handle.
const SSO_URL = 'https://account.xiaomi.com/pass/serviceLogin?callback=%2Fsts&followup=%2Fapi%2Fuser%2Fxiaomi%2Fme&sid=mimopc';
const ACCOUNT_BODY = JSON.stringify({ code: 0, data: { userId: 1234567890 } });

function liveChain(overrides = {}) {
  let meVisits = 0;
  return async (url) => {
    const href = String(url);
    if (href.startsWith(`${BASE}/user/xiaomi/me`)) {
      meVisits += 1;
      if (meVisits === 1) {
        return overrides.first ? overrides.first(href) : reply(302, { location: SSO_URL });
      }
      return overrides.me ? overrides.me(href) : reply(200, { body: ACCOUNT_BODY });
    }
    if (href.startsWith('https://account.xiaomi.com/pass/serviceLogin')) {
      return overrides.serviceLogin
        ? overrides.serviceLogin(href)
        : reply(302, { location: `${BASE}/sts?sign=abc` });
    }
    if (href.startsWith(`${BASE}/sts`)) {
      return overrides.sts
        ? overrides.sts(href)
        : reply(307, {
          location: `${BASE}/user/xiaomi/me`,
          setCookie: ['serviceToken=svc-token; Domain=xiaomimimo.com; Path=/; Secure', 'mimopc_ph=ph-value; Path=/']
        });
    }
    return reply(404, {});
  };
}

// The exchange owns its transport, so the seam is a single-hop request rather
// than a fetch: it is the one thing that hands back both the Location and the
// hop's own Set-Cookie lines, which is what the walk is made of.
function recordingRequest(handler, calls = []) {
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), cookie: (init.headers || {}).Cookie || '' });
    return handler(url, init);
  };
  return fn;
}

test('the chain is walked to the account answer and the minted cookies are carried', async () => {
  const calls = [];
  const result = await exchangeForTest(recordingRequest(liveChain(), calls));

  assert.equal(result.ok, true);
  assert.equal(result.userId, '1234567890');
  // Four hops, not one: a single hop would have returned the first 302.
  assert.equal(calls.length, 4);
  assert.ok(calls[0].url.startsWith(`${BASE}/user/xiaomi/me`));
  assert.ok(calls[1].url.startsWith('https://account.xiaomi.com/pass/serviceLogin'));
  assert.ok(calls[2].url.startsWith(`${BASE}/sts`));
  assert.ok(calls[3].url.startsWith(`${BASE}/user/xiaomi/me`));

  // The account cookie is presented to the account host, which is the hop that
  // needs it, and the first call leaves without it.
  assert.equal(calls[0].cookie, '');
  assert.equal(calls[1].cookie, ACCOUNT_COOKIE);

  // The service cookies the chain minted are what the caller's request carries.
  assert.equal(result.cookieHeader, 'serviceToken=svc-token; mimopc_ph=ph-value');
});

test('a cookie minted for the service host is never replayed at the account host', async () => {
  const calls = [];
  await exchangeForTest(recordingRequest(liveChain({
    // A second pass through the account host, after the minted cookies exist.
    serviceLogin: () => reply(302, { location: `${BASE}/user/xiaomi/me` })
  }), calls));
  // Hop 1 is the only account-host call here, and it carries the account cookie
  // and nothing else — `serviceToken` is scoped to the service host.
  const accountHop = calls.find((call) => call.url.startsWith('https://account.xiaomi.com'));
  assert.equal(accountHop.cookie, ACCOUNT_COOKIE);
  assert.equal(accountHop.cookie.includes('serviceToken'), false);
});

test('a refusal arrives as an ordinary 200 carrying the rejection code', async () => {
  const refusal = JSON.stringify({ code: 46109, message: 'not logged in' });
  const result = await exchangeForTest(recordingRequest(liveChain({
    me: () => reply(200, { body: refusal })
  })));
  // 46109 is not an HTTP status: the account was refused on an answer the status
  // alone would have called a success.
  assert.deepEqual(result, { ok: false, status: MIMO_EXCHANGE_STATUSES.rejected });

  assert.deepEqual(
    await exchangeForTest(recordingRequest(liveChain({
      me: () => reply(200, { body: JSON.stringify({ code: 403 }) })
    }))),
    { ok: false, status: MIMO_EXCHANGE_STATUSES.rejected }
  );
  assert.deepEqual(
    await exchangeForTest(recordingRequest(liveChain({
      me: () => reply(403, { body: JSON.stringify({ code: 0, data: { userId: 1 } }) })
    }))),
    { ok: false, status: MIMO_EXCHANGE_STATUSES.rejected }
  );
});

test('a chain that never comes back to the service host is the refusal signature', async () => {
  // This is what a refused account cookie actually looks like: the walk lands on
  // the account host's own login page and mints nothing. It is a refusal, not an
  // outage — retrying it would only delay the prompt the user needs.
  const loginPage = recordingRequest(liveChain({
    serviceLogin: () => reply(200, { body: '<html><form action="/fe/service/login"></form></html>' })
  }));
  assert.deepEqual(
    await exchangeForTest(loginPage),
    { ok: false, status: MIMO_EXCHANGE_STATUSES.rejected }
  );

  // The same body answered by the service host is a different thing: the chain
  // came back, so nothing says the credential was refused and the attempt reads
  // as one that failed.
  const notTheApiPayload = recordingRequest(liveChain({
    me: () => reply(200, { body: '<html>proxy</html>' })
  }));
  assert.deepEqual(
    await exchangeForTest(notTheApiPayload),
    { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable }
  );
});

test('a 200 that is not the account envelope is not a session', () => {
  // Success is `code === 0` *and* a non-empty `data.userId`, the app's rule.
  assert.equal(readMimoAccountStatus(200, JSON.stringify({ code: 0, data: {} })).ok, false);
  assert.equal(readMimoAccountStatus(200, JSON.stringify({ code: 0, data: { userId: '' } })).ok, false);
  assert.equal(readMimoAccountStatus(200, JSON.stringify({ code: 0, data: { userId: null } })).ok, false);
  assert.equal(readMimoAccountStatus(200, '<html>login</html>').ok, false);
  // The region is what selects the base URL, and it comes from the same payload.
  assert.deepEqual(
    readMimoAccountStatus(200, JSON.stringify({ code: 0, data: { userId: 7, region: 'CN' } })),
    { ok: true, userId: '7', region: 'CN' }
  );
});

test('a redirect loop and a location-less redirect are both stopped', async () => {
  const looping = recordingRequest(() => reply(302, { location: `${BASE}/user/xiaomi/me` }));
  assert.deepEqual(
    await exchangeForTest(looping),
    { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable }
  );

  const stuck = recordingRequest(() => reply(302, {}));
  assert.deepEqual(
    await exchangeForTest(stuck),
    { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable }
  );
});

test('a transport failure is not a refusal', async () => {
  const failing = recordingRequest(() => { throw new TypeError('fetch failed'); });
  assert.deepEqual(
    await exchangeForTest(failing),
    { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable }
  );
});

test('a cancellation rejects rather than becoming a status', async () => {
  // The caller owns a cancellation: it must never be reported as an outage that
  // never happened, nor as a refused credential the user would be asked to fix.
  let called = 0;
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    () => exchangeMimoServiceSession({
      baseUrl: BASE,
      accountCookie: ACCOUNT_COOKIE,
      signal: before.signal,
      request: async () => { called += 1; return reply(200, {}); }
    }),
    (error) => error.name === 'AbortError'
  );
  assert.equal(called, 0, 'a cancelled exchange never reaches the network');

  // Cancelled between hops.
  const betweenHops = new AbortController();
  await assert.rejects(
    () => exchangeMimoServiceSession({
      baseUrl: BASE,
      accountCookie: ACCOUNT_COOKIE,
      signal: betweenHops.signal,
      request: async () => {
        betweenHops.abort();
        return reply(302, { location: 'https://account.xiaomi.com/pass/serviceLogin' });
      }
    }),
    (error) => error.name === 'AbortError'
  );

  // Cancelled while the body is being read. Nothing else can notice this one: the
  // transport hands an aborted read back as an ordinary failure, so the signal
  // has to be asked again after it.
  const whileReading = new AbortController();
  await assert.rejects(
    () => exchangeMimoServiceSession({
      baseUrl: BASE,
      accountCookie: ACCOUNT_COOKIE,
      signal: whileReading.signal,
      request: async () => ({
        status: 200,
        headers: { get: () => null, getSetCookie: () => [] },
        text: async () => {
          whileReading.abort();
          return ACCOUNT_BODY;
        }
      })
    }),
    (error) => error.name === 'AbortError'
  );
});

test('the jar scopes by domain and nothing reaches the other host', () => {
  const jar = createMimoCookieJar();
  const serviceUrl = new URL(`${BASE}/user/xiaomi/me`);
  const accountUrl = new URL('https://account.xiaomi.com/pass/serviceLogin');
  jar.absorb([
    // A domain cookie, as the chain's own service cookies are set.
    'serviceToken=svc; Domain=xiaomimimo.com; Path=/',
    // A host-only one, which is what the account cookie is when the caller holds
    // it rather than the wire having set it.
    'hostOnly=exact; Path=/'
  ], serviceUrl);

  assert.equal(jar.headerFor(serviceUrl), 'serviceToken=svc; hostOnly=exact');
  // This is the property the chains depend on: nothing minted for the service is
  // presented at the account host, and nothing held for the account host leaks
  // the other way.
  assert.equal(jar.headerFor(accountUrl), '');
  const subdomain = new URL('https://other.xiaomimimo.com/');
  assert.equal(jar.headerFor(subdomain), 'serviceToken=svc');

  // A later set replaces the value rather than leaving two of them behind.
  jar.absorb(['hostOnly=rotated; Path=/'], serviceUrl);
  assert.equal(jar.headerFor(serviceUrl), 'serviceToken=svc; hostOnly=rotated');
});

// Keeps the calls above readable: one entry point, the live base URL, and the
// cookie the partition reader hands over.
function exchangeForTest(fetchFn, options = {}) {
  return exchangeMimoServiceSession({
    baseUrl: BASE,
    accountCookie: ACCOUNT_COOKIE,
    request: fetchFn,
    ...options
  });
}

// ---- the console chain -------------------------------------------------------
// It does not redirect: the endpoint answers 401 and names the login URL it
// wants visited, which is the shape observed live on the open-platform console.

const CONSOLE_BASE = 'https://platform.xiaomimimo.com/api/v1';
const CONSOLE_LOGIN_URL = 'https://account.xiaomi.com/pass/serviceLogin?callback=%2Fsts&followup=%2Fapi%2Fv1%2Fbalance&sid=api-platform&_group=DEFAULT';
const CONSOLE_MINTED = [
  'api-platform_serviceToken=console-svc; Domain=xiaomimimo.com; Path=/',
  'api-platform_ph=console-ph; Path=/'
];

function consoleChain(overrides = {}) {
  let visitedLogin = false;
  return async (url) => {
    const href = String(url);
    if (href.startsWith('https://account.xiaomi.com')) {
      visitedLogin = true;
      return overrides.login ? overrides.login(href) : reply(302, { location: 'https://platform.xiaomimimo.com/sts' });
    }
    if (href.startsWith('https://platform.xiaomimimo.com/sts')) {
      return redirectReplyTo(`${CONSOLE_BASE}/balance`, CONSOLE_MINTED);
    }
    if (href.startsWith(`${CONSOLE_BASE}/balance`)) {
      if (!visitedLogin) {
        return {
          status: 401,
          headers: { get: () => null, getSetCookie: () => [] },
          text: async () => JSON.stringify({ code: 401, loginUrl: CONSOLE_LOGIN_URL })
        };
      }
      return overrides.balance ? overrides.balance(href) : reply(200, { body: JSON.stringify({ code: 0, data: { balance: '9.95' } }) });
    }
    return reply(404, {});
  };
}

function redirectReplyTo(location, setCookie) {
  return {
    status: 307,
    headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null), getSetCookie: () => setCookie },
    text: async () => ''
  };
}

test('the console chain follows the login URL the endpoint names', async () => {
  const calls = [];
  const result = await exchangeMimoConsoleSession({
    baseUrl: CONSOLE_BASE,
    accountCookie: ACCOUNT_COOKIE,
    request: recordingRequest(consoleChain(), calls)
  });

  assert.equal(result.ok, true);
  // The console session, not the account cookie that was spent to mint it.
  assert.equal(result.cookieHeader, 'api-platform_serviceToken=console-svc; api-platform_ph=console-ph');
  assert.equal(calls[0].url, `${CONSOLE_BASE}/balance`);
  assert.equal(calls[1].url, CONSOLE_LOGIN_URL);
  // The account cookie is presented at the account host, and the first call —
  // the one that only discovers it must log in — leaves without it.
  assert.equal(calls[0].cookie, '');
  assert.equal(calls[1].cookie, ACCOUNT_COOKIE);
});

test('a console walk that never comes back is a refusal, and a bad envelope is not', async () => {
  const abandoned = recordingRequest(consoleChain({
    login: () => reply(200, { body: '<html><form action="/fe/service/login"></form></html>' })
  }));
  assert.deepEqual(
    await exchangeMimoConsoleSession({ baseUrl: CONSOLE_BASE, accountCookie: ACCOUNT_COOKIE, request: abandoned }),
    { ok: false, status: MIMO_EXCHANGE_STATUSES.rejected }
  );

  const rejectedCode = recordingRequest(consoleChain({
    balance: () => reply(200, { body: JSON.stringify({ code: 46109 }) })
  }));
  assert.deepEqual(
    await exchangeMimoConsoleSession({ baseUrl: CONSOLE_BASE, accountCookie: ACCOUNT_COOKIE, request: rejectedCode }),
    { ok: false, status: MIMO_EXCHANGE_STATUSES.rejected }
  );

  // Back on the console host, but not the envelope: an attempt that failed, not a
  // credential the user has to replace.
  const notThePayload = recordingRequest(consoleChain({
    balance: () => reply(200, { body: '<html>proxy</html>' })
  }));
  assert.deepEqual(
    await exchangeMimoConsoleSession({ baseUrl: CONSOLE_BASE, accountCookie: ACCOUNT_COOKIE, request: notThePayload }),
    { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable }
  );
});

test('a 401 is a refusal wherever it lands', () => {
  // An expired service session answers 401 from the service host itself — the
  // signature the live probe recorded — so the status decides it rather than the
  // host the walk stopped on. Without this the chain would read it as an outage
  // and retry a session the user has to replace.
  const calls = [];
  return exchangeMimoServiceSession({
    baseUrl: BASE,
    accountCookie: '',
    serviceCookie: 'serviceToken=expired',
    request: recordingRequest(async () => reply(401, { body: '' }), calls)
  }).then((result) => {
    assert.deepEqual(result, { ok: false, status: MIMO_EXCHANGE_STATUSES.rejected });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cookie, 'serviceToken=expired');
  });
});
