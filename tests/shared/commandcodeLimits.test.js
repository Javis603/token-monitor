'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  COMMANDCODE_CREDITS_URL,
  COMMANDCODE_SUBSCRIPTIONS_URL,
  commandcodeCookie,
  fetchCommandcodeLimits,
  normalizeCommandcodeCookieHeader,
  parseCommandcodeCredits,
  parseCommandcodeSubscription
} = require('../../src/shared/commandcodeLimits');

const SESSION_COOKIE = '__Secure-commandcode_prod_.session_token=tok';

// Captured from api.commandcode.ai for an active `individual-go` account.
const CREDITS_BODY = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 8.7784,
    purchasedCredits: 0,
    premiumMonthlyCredits: 0,
    opensourceMonthlyCredits: 8.7784
  }
};

const SUBSCRIPTION_BODY = {
  success: true,
  data: {
    id: 'sub_1TTzt3DSZgxV3MJKG4ClCWpn',
    status: 'active',
    currentPeriodStart: '2026-05-06T07:28:50.000Z',
    currentPeriodEnd: '2026-06-06T07:28:50.000Z',
    planId: 'individual-go'
  }
};

function stubFetch(routes, calls = []) {
  return async (url, init) => {
    const href = String(url);
    calls.push({ url: href, headers: init?.headers || {} });
    const route = routes[href];
    if (typeof route === 'function') return route();
    return { ok: true, status: 200, json: async () => route };
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function windowByKind(provider, kind) {
  return provider.windows.filter((entry) => entry.kind === kind);
}

test('commandcodeCookie prefers settings over env and requires a session cookie', () => {
  assert.equal(
    commandcodeCookie({ COMMANDCODE_COOKIE: `${SESSION_COOKIE}-env` }, { commandcodeCookie: `  "${SESSION_COOKIE}"  ` }),
    SESSION_COOKIE
  );
  assert.equal(commandcodeCookie({ COMMANDCODE_COOKIE: `Cookie: ${SESSION_COOKIE}` }), SESSION_COOKIE);
  assert.equal(commandcodeCookie({ TOKEN_MONITOR_COMMANDCODE_COOKIE: SESSION_COOKIE }), SESSION_COOKIE);
  // A header from some other site is not a Command Code session, however
  // well-formed it looks.
  assert.equal(commandcodeCookie({ COMMANDCODE_COOKIE: 'sidebar=open; stripe_mid=mid' }), '');
  assert.equal(commandcodeCookie({}), '');
});

test('normalizeCommandcodeCookieHeader keeps the whole header once a session cookie is present', () => {
  assert.equal(
    normalizeCommandcodeCookieHeader('__Secure-commandcode_prod_.session_token=tok; __Secure-commandcode_prod_.session_data=data; stripe=x'),
    '__Secure-commandcode_prod_.session_token=tok; __Secure-commandcode_prod_.session_data=data; stripe=x'
  );
  // better-auth's unprefixed and __Host- spellings are the same session.
  assert.equal(normalizeCommandcodeCookieHeader('better-auth.session_token=tok'), 'better-auth.session_token=tok');
  assert.equal(normalizeCommandcodeCookieHeader('__Host-better-auth.session_token=tok'), '__Host-better-auth.session_token=tok');
  // A bare token is not accepted: guessing a cookie name would send a header
  // the API cannot authenticate and report it as an expired session.
  assert.equal(normalizeCommandcodeCookieHeader('tok'), '');
  assert.equal(normalizeCommandcodeCookieHeader(''), '');
});

test('normalizeCommandcodeCookieHeader accepts a DevTools "Copy as cURL" paste', () => {
  const curl = "curl 'https://api.commandcode.ai/internal/billing/credits' "
    + "-H 'accept: application/json' "
    + `-H 'cookie: ${SESSION_COOKIE}; __Secure-commandcode_prod_.session_data=data'`;
  assert.equal(
    normalizeCommandcodeCookieHeader(curl),
    `${SESSION_COOKIE}; __Secure-commandcode_prod_.session_data=data`
  );
  // Chrome switches to ANSI-C quoting once a value needs escaping, and Windows
  // DevTools emits -b instead of a cookie header.
  assert.equal(normalizeCommandcodeCookieHeader(`curl 'https://x' -H $'cookie: ${SESSION_COOKIE}'`), SESSION_COOKIE);
  assert.equal(normalizeCommandcodeCookieHeader(`curl.exe 'https://x' -b '${SESSION_COOKIE}'`), SESSION_COOKIE);
  // A capture of the wrong request has no Cookie header. Falling back to the
  // raw text would parse the command line itself as cookie pairs.
  assert.equal(normalizeCommandcodeCookieHeader("curl 'https://x' -H 'user-agent: Mozilla'"), '');
});

test('parseCommandcodeCredits reads rolling limits at the root and nested in credits', () => {
  const root = parseCommandcodeCredits({
    credits: { monthlyCredits: 8.5, purchasedCredits: 0 },
    windowLimits: {
      fiveHour: { cap: 3, used: 0.75, resetAt: 1_780_000_000_000 },
      weekly: { cap: 15, used: 1.5, resetAt: 1_780_100_000_000 }
    }
  });
  assert.equal(root.monthlyRemaining, 8.5);
  assert.equal(root.fiveHour.usedPercent, 25);
  assert.equal(root.fiveHour.windowMinutes, 300);
  assert.equal(root.fiveHour.resetsAt, new Date(1_780_000_000_000).toISOString());
  assert.equal(root.weekly.usedPercent, 10);
  assert.equal(root.weekly.windowMinutes, 10_080);

  // Seconds-vs-milliseconds and stringified numbers both arrive in the wild.
  const nested = parseCommandcodeCredits({
    credits: {
      monthlyCredits: 7.25,
      purchasedCredits: 2,
      windowLimits: {
        fiveHour: { cap: '4', used: '1', resetAt: '1780200000' },
        weekly: { cap: 20, used: 4, resetAt: 1_780_300_000_000 }
      }
    }
  });
  assert.equal(nested.purchasedCredits, 2);
  assert.equal(nested.fiveHour.usedPercent, 25);
  assert.equal(nested.fiveHour.resetsAt, new Date(1_780_200_000_000).toISOString());
  assert.equal(nested.weekly.usedPercent, 20);
});

test('parseCommandcodeCredits accepts snake_case and rejects a missing grant', () => {
  const snake = parseCommandcodeCredits({
    credits: { monthly_credits: 4, purchased_credits: 1, window_limits: { five_hour: { cap: 10, used: 2 } } }
  });
  assert.equal(snake.monthlyRemaining, 4);
  assert.equal(snake.purchasedCredits, 1);
  assert.equal(snake.fiveHour.usedPercent, 20);
  assert.equal(snake.weekly, null);

  assert.throws(() => parseCommandcodeCredits({}), /missing credits object/);
  assert.throws(() => parseCommandcodeCredits({ credits: {} }), /missing monthlyCredits/);
});

test('parseCommandcodeSubscription separates the free tier from a failed envelope', () => {
  const parsed = parseCommandcodeSubscription(SUBSCRIPTION_BODY);
  assert.equal(parsed.planId, 'individual-go');
  assert.equal(parsed.status, 'active');
  assert.equal(parsed.currentPeriodEnd, '2026-06-06T07:28:50.000Z');

  // Only an explicit success+null says "no subscription".
  assert.equal(parseCommandcodeSubscription({ success: true, data: null }), null);
  assert.throws(() => parseCommandcodeSubscription({ success: true }), /missing subscriptions data/);
  assert.throws(() => parseCommandcodeSubscription({ success: false, error: 'down' }), /unsuccessful/);
});

test('fetchCommandcodeLimits reports notConfigured without a cookie and never calls the API', async () => {
  const calls = [];
  const provider = await fetchCommandcodeLimits({}, { env: {}, fetch: stubFetch({}, calls) });
  assert.equal(provider.provider, 'commandcode');
  assert.equal(provider.status, 'notConfigured');
  assert.equal(provider.source, 'web');
  assert.deepEqual(provider.windows, []);
  assert.equal(calls.length, 0);
});

test('fetchCommandcodeLimits maps the plan allowance onto the monthly credits window', async () => {
  const calls = [];
  const provider = await fetchCommandcodeLimits(
    { commandcodeCookie: SESSION_COOKIE },
    {
      env: {},
      now: () => Date.parse('2026-05-20T00:00:00.000Z'),
      fetch: stubFetch({
        [COMMANDCODE_CREDITS_URL]: CREDITS_BODY,
        [COMMANDCODE_SUBSCRIPTIONS_URL]: SUBSCRIPTION_BODY
      }, calls)
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'web');
  assert.equal(provider.accountLabel, 'Go');
  assert.ok(provider.accountKey.startsWith('sha256:'));
  assert.equal(provider.updatedAt, '2026-05-20T00:00:00.000Z');

  const billing = windowByKind(provider, 'billing');
  assert.equal(billing.length, 1);
  assert.equal(billing[0].metric, 'credits');
  assert.equal(billing[0].label, 'Monthly');
  assert.equal(billing[0].currency, 'USD');
  assert.equal(billing[0].limit, 10);
  assert.equal(billing[0].remaining, 8.7784);
  assert.equal(Number(billing[0].used.toFixed(4)), 1.2216);
  assert.equal(billing[0].resetsAt, '2026-06-06T07:28:50.000Z');
  assert.equal(billing[0].showMeter, true);

  assert.deepEqual(new Set(calls.map((call) => call.url)), new Set([
    COMMANDCODE_CREDITS_URL,
    COMMANDCODE_SUBSCRIPTIONS_URL
  ]));
  for (const call of calls) assert.equal(call.headers.Cookie, SESSION_COOKIE);
});

test('fetchCommandcodeLimits ships rolling limits and a rollover top-up as separate windows', async () => {
  const provider = await fetchCommandcodeLimits(
    { commandcodeCookie: SESSION_COOKIE },
    {
      env: {},
      fetch: stubFetch({
        [COMMANDCODE_CREDITS_URL]: {
          credits: {
            monthlyCredits: 35,
            purchasedCredits: 12.5,
            windowLimits: {
              fiveHour: { cap: 14, used: 7 },
              weekly: { cap: 35, used: 14 }
            }
          }
        },
        [COMMANDCODE_SUBSCRIPTIONS_URL]: {
          success: true,
          data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: '2026-06-06T07:28:50.000Z' }
        }
      })
    }
  );

  assert.equal(provider.accountLabel, 'GOAT');
  assert.equal(windowByKind(provider, 'session')[0].usedPercent, 50);
  assert.equal(windowByKind(provider, 'weekly')[0].usedPercent, 40);

  const billing = windowByKind(provider, 'billing');
  assert.deepEqual(billing.map((entry) => entry.label), ['Monthly', 'Top-up']);
  assert.equal(billing[0].usedPercent, 50);
  // The top-up has no allowance to measure against, so it carries money and no
  // meter rather than an empty bar that would read as exhausted.
  assert.equal(billing[1].remaining, 12.5);
  assert.equal(billing[1].limit, null);
  assert.equal(billing[1].showMeter, false);
});

test('fetchCommandcodeLimits keeps the grant as money when the plan is unknown', async () => {
  const provider = await fetchCommandcodeLimits(
    { commandcodeCookie: SESSION_COOKIE },
    {
      env: {},
      fetch: stubFetch({
        [COMMANDCODE_CREDITS_URL]: CREDITS_BODY,
        [COMMANDCODE_SUBSCRIPTIONS_URL]: { success: true, data: { planId: 'individual-brand-new', status: 'active' } }
      })
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, '');
  const billing = windowByKind(provider, 'billing');
  assert.equal(billing.length, 1);
  assert.equal(billing[0].remaining, 8.7784);
  assert.equal(billing[0].limit, null);
  assert.equal(billing[0].usedPercent, null);
  assert.equal(billing[0].showMeter, false);
});

test('a stale plan allowance is dropped rather than used as a bad denominator', async () => {
  // `individual-go` is catalogued at $10. A weekly cap above that, or a grant
  // with more left in it than the plan supposedly grants, both say the
  // catalogue entry has gone stale — the meter is dropped, the money stays.
  const cases = [
    { monthlyCredits: 10, windowLimits: { weekly: { cap: 25, used: 1 } } },
    { monthlyCredits: 42, windowLimits: { weekly: { cap: 6, used: 0 } } }
  ];
  for (const credits of cases) {
    const provider = await fetchCommandcodeLimits(
      { commandcodeCookie: SESSION_COOKIE },
      {
        env: {},
        fetch: stubFetch({
          [COMMANDCODE_CREDITS_URL]: { credits },
          [COMMANDCODE_SUBSCRIPTIONS_URL]: SUBSCRIPTION_BODY
        })
      }
    );
    const billing = windowByKind(provider, 'billing');
    // The plan id still names the plan correctly; only its price is suspect.
    assert.equal(provider.accountLabel, 'Go');
    assert.equal(billing[0].limit, null);
    assert.equal(billing[0].showMeter, false);
    assert.equal(billing[0].remaining, credits.monthlyCredits);
  }
});

test('a live Go account maps onto the windows the dashboard shows', async () => {
  // Captured verbatim from api.commandcode.ai on a fresh individual-go
  // subscription: no monthly allowance anywhere on the wire (hence the
  // catalogue), premium+opensource summing to the REMAINING grant, and
  // resetAt 0 on windows that have not been touched yet.
  const provider = await fetchCommandcodeLimits(
    { commandcodeCookie: SESSION_COOKIE },
    {
      env: {},
      fetch: stubFetch({
        [COMMANDCODE_CREDITS_URL]: {
          credits: {
            belowThreshold: false,
            creditThreshold: 0,
            monthlyCredits: 10,
            purchasedCredits: 0,
            premiumMonthlyCredits: 0,
            opensourceMonthlyCredits: 10
          },
          windowLimits: {
            limited: true,
            exceeded: null,
            fiveHour: { used: 0, cap: 3, exceeded: false, resetAt: 0 },
            weekly: { used: 0, cap: 6, exceeded: false, resetAt: 0 }
          }
        },
        [COMMANDCODE_SUBSCRIPTIONS_URL]: {
          success: true,
          data: {
            id: 'sub_redacted',
            status: 'active',
            planId: 'individual-go',
            currentPeriodStart: '2026-08-15T04:42:16.000Z',
            currentPeriodEnd: '2026-09-15T04:42:16.000Z',
            cancelAtPeriodEnd: false,
            pendingPhase: null
          }
        }
      })
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'Go');
  const [session] = windowByKind(provider, 'session');
  assert.deepEqual([session.used, session.limit, session.usedPercent], [0, 3, 0]);
  // An untouched window reports resetAt 0, which is an absent reset, not 1970.
  assert.equal(session.resetsAt, null);
  const [weekly] = windowByKind(provider, 'weekly');
  assert.deepEqual([weekly.used, weekly.limit, weekly.usedPercent], [0, 6, 0]);
  assert.equal(weekly.resetsAt, null);
  const billing = windowByKind(provider, 'billing');
  assert.equal(billing.length, 1);
  assert.deepEqual(
    [billing[0].remaining, billing[0].limit, billing[0].used, billing[0].usedPercent],
    [10, 10, 0, 0]
  );
  assert.equal(billing[0].resetsAt, '2026-09-15T04:42:16.000Z');
});

test('a failed subscription lookup still publishes the credits it did read', async () => {
  const provider = await fetchCommandcodeLimits(
    { commandcodeCookie: SESSION_COOKIE },
    {
      env: {},
      fetch: stubFetch({
        [COMMANDCODE_CREDITS_URL]: CREDITS_BODY,
        [COMMANDCODE_SUBSCRIPTIONS_URL]: () => jsonResponse(503, { error: 'unavailable' })
      })
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, '');
  assert.equal(windowByKind(provider, 'billing')[0].remaining, 8.7784);
});

test('fetchCommandcodeLimits maps credits transport failures onto provider statuses', async () => {
  const cases = [
    [() => jsonResponse(401, {}), 'unauthorized'],
    [() => jsonResponse(403, {}), 'unauthorized'],
    [() => jsonResponse(429, {}), 'sourceRateLimited'],
    [() => jsonResponse(500, {}), 'unavailable'],
    [() => jsonResponse(200, { unexpected: true }), 'unavailable'],
    [() => { throw new Error('socket hang up'); }, 'unavailable']
  ];
  for (const [route, expected] of cases) {
    const provider = await fetchCommandcodeLimits(
      { commandcodeCookie: SESSION_COOKIE },
      {
        env: {},
        fetch: stubFetch({
          [COMMANDCODE_CREDITS_URL]: route,
          [COMMANDCODE_SUBSCRIPTIONS_URL]: SUBSCRIPTION_BODY
        })
      }
    );
    assert.equal(provider.status, expected);
    assert.deepEqual(provider.windows, []);
  }
});

test('a stalled subscription lookup does not hold the probe past the credits deadline', async () => {
  const provider = await fetchCommandcodeLimits(
    { commandcodeCookie: SESSION_COOKIE },
    {
      env: {},
      commandcodeFetchTimeoutMs: 200,
      commandcodeSubscriptionTimeoutMs: 20,
      fetch: stubFetch({
        [COMMANDCODE_CREDITS_URL]: CREDITS_BODY,
        [COMMANDCODE_SUBSCRIPTIONS_URL]: () => new Promise(() => {})
      })
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, '');
  assert.equal(windowByKind(provider, 'billing')[0].remaining, 8.7784);
});

test('an exhausted credits probe reports unavailable rather than hanging', async () => {
  const provider = await fetchCommandcodeLimits(
    { commandcodeCookie: SESSION_COOKIE },
    {
      env: {},
      commandcodeFetchTimeoutMs: 20,
      fetch: stubFetch({
        [COMMANDCODE_CREDITS_URL]: () => new Promise(() => {}),
        [COMMANDCODE_SUBSCRIPTIONS_URL]: SUBSCRIPTION_BODY
      })
    }
  );

  assert.equal(provider.status, 'unavailable');
  assert.deepEqual(provider.windows, []);
});
