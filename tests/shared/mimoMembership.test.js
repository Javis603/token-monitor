'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { hashKey } = require('../../src/shared/hashKey');
const {
  MIMO_MEMBERSHIP_BASE_URL,
  MIMO_MEMBERSHIP_WINDOW_MINUTES,
  fetchMimoMembershipLimits,
  mimoMembershipAccountKey,
  mimoMembershipBaseUrl,
  readMimoMembershipPlan
} = require('../../src/shared/providers/mimo/membership');

const SUBSCRIPTION_URL = `${MIMO_MEMBERSHIP_BASE_URL}/user/xiaomi/subscription/self`;
const ME_URL = `${MIMO_MEMBERSHIP_BASE_URL}/user/xiaomi/me`;
const SSO_URL = 'https://account.xiaomi.com/pass/serviceLogin?sid=mimopc';
const ACCOUNT_COOKIE = 'passToken=account-pass-token; userId=1234567890';

// The live fixture's shape: the plan fields the app reads, and its `percent` is
// a *remaining* share on a 0-100 scale.
function plan(overrides = {}) {
  return {
    planCode: 'mimo-cn-pro',
    planTier: 3,
    renewalMode: 'YEARLY',
    endTime: '2026-10-01T00:00:00',
    percent: 78.5,
    nextResetTime: '2026-09-15T00:00:00',
    source: 'ORDER_SUB',
    ...overrides
  };
}

function jsonReply(status, body) {
  return {
    status,
    headers: { get: () => null, getSetCookie: () => [] },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function redirectReply(location, setCookie = []) {
  return {
    status: 302,
    headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null), getSetCookie: () => setCookie },
    text: async () => ''
  };
}

// Routes the SSO chain and the one call this lane makes, so a fixture cannot
// answer both with one payload and hide which request carried what. The chain
// visits the me path twice with different answers, as the live one does.
function routedFetch({ subscription = jsonReply(200, { code: 0, data: { current: plan() } }), calls = [] } = {}) {
  let meVisits = 0;
  return async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, cookie: (init.headers || {}).Cookie || '' });
    if (href.startsWith(ME_URL)) {
      meVisits += 1;
      if (meVisits === 1) return redirectReply(SSO_URL);
      return jsonReply(200, { code: 0, data: { userId: 1234567890 } });
    }
    if (href.startsWith('https://account.xiaomi.com')) return redirectReply(`${MIMO_MEMBERSHIP_BASE_URL}/sts?sign=x`);
    if (href.startsWith(`${MIMO_MEMBERSHIP_BASE_URL}/sts`)) {
      return redirectReply(ME_URL, ['serviceToken=svc-token; Domain=xiaomimimo.com; Path=/; Secure']);
    }
    if (href.startsWith(SUBSCRIPTION_URL)) return subscription;
    return jsonReply(404, {});
  };
}

function desktopSession(cookieHeader) {
  return () => (cookieHeader ? { ok: true, cookieHeader, userId: '1234567890' } : { ok: false, reason: 'absent' });
}

test('the plan renders as the weekly window with its remaining share inverted', async () => {
  const calls = [];
  const rows = await fetchMimoMembershipLimits({}, {
    fetch: routedFetch({ calls }),
    readMimoDesktopAccount: desktopSession(ACCOUNT_COOKIE),
    now: () => Date.UTC(2026, 8, 23)
  });

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.provider, 'mimo');
  assert.equal(row.status, 'ok');
  // A discovered session, not a pasted credential: the split `providers/cline`
  // makes between a configured key and a sign-in found on this machine.
  assert.equal(row.source, 'oauth');
  assert.equal(row.sourceDetail, 'app');
  assert.equal(row.accountKey, mimoMembershipAccountKey('1234567890'));
  assert.equal(row.accountLabel, 'mimo-cn-pro');
  assert.equal(row.windows.length, 1);
  const window = row.windows[0];
  // The app's card is the weekly usage limit, and its percent is what is LEFT.
  assert.equal(window.kind, 'weekly');
  assert.equal(window.windowMinutes, MIMO_MEMBERSHIP_WINDOW_MINUTES);
  assert.equal(window.usedPercent, 21.5);
  assert.equal(window.resetsAt, '2026-09-15T00:00:00.000Z');

  // The subscription call is the last one, and it carries the minted session
  // rather than the account cookie that was spent to get it.
  assert.equal(calls.at(-1).url, SUBSCRIPTION_URL);
  assert.equal(calls.at(-1).cookie, 'serviceToken=svc-token');
});

test('the membership row is its own identity, never the console lane', async () => {
  const consoleKey = hashKey('mimo:1234567890');
  const membershipKey = mimoMembershipAccountKey('1234567890');
  assert.notEqual(membershipKey, consoleKey);

  // Two products of one account are two rows, and a re-minted session is the
  // same row: the key follows the server-issued user id, not the rotating
  // credential that carried it.
  const first = await fetchMimoMembershipLimits({}, {
    fetch: routedFetch(), readMimoDesktopAccount: desktopSession(ACCOUNT_COOKIE)
  });
  const second = await fetchMimoMembershipLimits({}, {
    fetch: routedFetch(), readMimoDesktopAccount: desktopSession('passToken=other; userId=1234567890')
  });
  assert.equal(first[0].accountKey, second[0].accountKey);
});

test('no plan is an answer, and only a real payload is read', () => {
  assert.deepEqual(readMimoMembershipPlan({ code: 0, data: { current: null } }), { ok: true, plan: null });
  assert.equal(readMimoMembershipPlan({ data: { current: [] } }).ok, false);
  assert.equal(readMimoMembershipPlan({ data: { current: { planCode: 'x' } } }).ok, false);
  assert.equal(readMimoMembershipPlan({ data: { current: plan({ percent: 'lots' }) } }).ok, false);
  assert.equal(readMimoMembershipPlan({ data: { current: plan({ nextResetTime: 'soon' }) } }).ok, false);
});

test('a configured cookie wins and is never exchanged away', async () => {
  const calls = [];
  const rows = await fetchMimoMembershipLimits({ mimoMembershipCookie: 'serviceToken=configured' }, {
    fetch: routedFetch({ calls }),
    readMimoDesktopAccount: desktopSession(ACCOUNT_COOKIE)
  });
  assert.equal(rows[0].status, 'ok');
  // The user's credential is their instruction: the local store is not consulted
  // and the chain is not walked.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SUBSCRIPTION_URL);
  assert.equal(calls[0].cookie, 'serviceToken=configured');
});

test('a refused exchange is a credential problem and a failed one is not', async () => {
  const refused = async (url) => {
    const href = String(url);
    if (href.startsWith(ME_URL)) return redirectReply(SSO_URL);
    // The refusal signature: the chain lands on the account host and stays there.
    if (href.startsWith('https://account.xiaomi.com')) {
      return { status: 200, headers: { get: () => null, getSetCookie: () => [] }, text: async () => '<html>login</html>', json: async () => ({}) };
    }
    return jsonReply(404, {});
  };
  const refusedRows = await fetchMimoMembershipLimits({}, {
    fetch: refused, readMimoDesktopAccount: desktopSession(ACCOUNT_COOKIE)
  });
  // Terminal: the remedy is a sign-in, and retrying it would only delay the
  // prompt the user needs to see.
  assert.equal(refusedRows[0].status, 'unauthorized');

  const offline = await fetchMimoMembershipLimits({}, {
    fetch: async () => { throw new TypeError('fetch failed'); },
    readMimoDesktopAccount: desktopSession(ACCOUNT_COOKIE)
  });
  assert.equal(offline[0].status, 'unavailable');
});

test('a machine with no MiMo Desktop gets no row, and a foreign region goes quiet', async () => {
  const absent = await fetchMimoMembershipLimits({}, {
    fetch: routedFetch(), readMimoDesktopAccount: desktopSession('')
  });
  assert.deepEqual(absent, []);

  // The app's region table carries CN only, so an account that names another
  // region has no endpoint to reach and the lane degrades silently.
  assert.equal(mimoMembershipBaseUrl('US'), '');
  assert.equal(mimoMembershipBaseUrl('CN'), MIMO_MEMBERSHIP_BASE_URL);
  // An absent region is not evidence of a foreign account: the call proceeds.
  assert.equal(mimoMembershipBaseUrl(''), MIMO_MEMBERSHIP_BASE_URL);

  // The chain visits the me path twice, so a fixture that answered it once would
  // never reach the account answer it is here to carry.
  let meVisits = 0;
  const foreign = await fetchMimoMembershipLimits({}, {
    fetch: async (url) => {
      const href = String(url);
      if (href.startsWith(ME_URL)) {
        meVisits += 1;
        if (meVisits === 1) return redirectReply(SSO_URL);
        return jsonReply(200, { code: 0, data: { userId: 5, region: 'SGP' } });
      }
      if (href.startsWith('https://account.xiaomi.com')) return redirectReply(`${MIMO_MEMBERSHIP_BASE_URL}/sts?sign=x`);
      if (href.startsWith(`${MIMO_MEMBERSHIP_BASE_URL}/sts`)) {
        return redirectReply(ME_URL, ['serviceToken=svc; Domain=xiaomimimo.com; Path=/']);
      }
      return jsonReply(404, {});
    },
    readMimoDesktopAccount: desktopSession(ACCOUNT_COOKIE)
  });
  assert.deepEqual(foreign, []);
});

test('a half-written sign-in is a signed-out app, not an unconfigured one', async () => {
  const rows = await fetchMimoMembershipLimits({}, {
    fetch: routedFetch(),
    readMimoDesktopAccount: () => ({ ok: false, reason: 'incomplete' })
  });
  assert.equal(rows[0].status, 'unauthorized');

  const unreadable = await fetchMimoMembershipLimits({}, {
    fetch: routedFetch(),
    readMimoDesktopAccount: () => ({ ok: false, reason: 'encrypted' })
  });
  assert.deepEqual(unreadable, []);
});

test('an answer with no usable data is an outage, never a credential problem', async () => {
  for (const subscription of [
    jsonReply(200, { code: 500, message: 'no plan' }),
    jsonReply(200, { data: { current: [] } }),
    jsonReply(500, {})
  ]) {
    const rows = await fetchMimoMembershipLimits({ mimoMembershipCookie: 'serviceToken=configured' }, {
      fetch: routedFetch({ subscription })
    });
    assert.equal(rows[0].status, 'unavailable');
    assert.deepEqual(rows[0].windows, []);
  }

  const throttled = await fetchMimoMembershipLimits({ mimoMembershipCookie: 'serviceToken=configured' }, {
    fetch: routedFetch({ subscription: jsonReply(429, {}) })
  });
  assert.equal(throttled[0].status, 'sourceRateLimited');
});

test('a cancellation rejects instead of becoming a status', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => fetchMimoMembershipLimits({ mimoMembershipCookie: 'serviceToken=configured' }, {
      signal: controller.signal,
      fetch: async () => { throw new Error('must not reach the network'); }
    }),
    (error) => error.name === 'AbortError'
  );
});
