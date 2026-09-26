'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  createMimoManagedAccount,
  fetchMimoLimits,
  mimoAccountKey,
  mimoMembershipAccountKey,
  normalizeMimoCookieHeader,
  parseMimoBalance,
  parseMimoPlanDetail,
  parseMimoPlanUsage,
  parseMimoProfile,
  parseMimoSpend,
  scopedMimoManagedAccounts,
  withDetectedMimoAccount
} = require('../../src/shared/providers/mimo/limits');
const {
  mimoMembershipPlanLabel,
  readMimoMembershipPlan
} = require('../../src/shared/providers/mimo/membership');
const { mimoDesktopCookieCandidates, readMimoDesktopAccount } = require('../../src/shared/providers/mimo/desktop');
const { aggregateLimits, normalizeLimitsSummary } = require('../../src/shared/limits/core');
const { mimoExchangeRequestHeaders, mimoRequestHeaders } = require('../../src/shared/providers/mimo/browserHeaders');

const CONSOLE_COOKIE = 'unrelated=drop; userId=42; api-platform_serviceToken=secret; api-platform_ph=optional';
const CONSOLE_BASE = 'https://platform.xiaomimimo.com/api/v1';
const MEMBERSHIP_BASE = 'https://mimo-server-cn.xiaomimimo.com/api';
const LOGIN_URL = 'https://account.xiaomi.com/pass/serviceLogin';
const CONSOLE_ACCOUNT_KEY_42 = 'sha256:9c59f5aa7d0dcd4428d62a0b03a13d9a345dbf2fc965e91bf8383f3206c0004d';
const MEMBERSHIP_ACCOUNT_KEY_42 = 'sha256:0cf3bae7981a1796fe99f80a20111408ff58f977b8a2c464939de0a404aced46';
const CONSOLE_ACCOUNT_KEY_7 = 'sha256:cd264e505d86d6fb49c1aeefd277324e93b4ddd34e31a7e743412daeb474670a';
const MEMBERSHIP_ACCOUNT_KEY_7 = 'sha256:b41179974aa7a240cd799f1548fea3a86d4dd618d77979b770f19cd958f1984d';

const absentDesktop = () => { throw Object.assign(new Error('no store'), { status: 'notConfigured' }); };
const signedInDesktop = (userId = '42') => () => ({ userId, cookieHeader: `passToken=p; userId=${userId}` });

function reply(status, body, headers = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => map.get(String(name).toLowerCase()) ?? null,
      getSetCookie: () => (Array.isArray(map.get('set-cookie')) ? map.get('set-cookie') : [])
    },
    text: async () => text,
    json: async () => JSON.parse(text)
  };
}

// The vendor's own E2E fixture, verbatim from the app bundle — planCode, tier,
// renewal mode, wall-clock times and source included. Live responses were only
// ever observed for the no-subscription branch, so this sample is the contract.
const PLAN_BODY = {
  code: 0,
  data: {
    current: {
      planCode: 'mimo-cn-pro',
      planTier: 3,
      renewalMode: 'MONTHLY',
      endTime: '2026-10-01T00:00:00',
      percent: 78.5,
      nextResetTime: '2026-09-15T00:00:00',
      source: 'ORDER_SUB'
    }
  }
};

// A world with both lanes, walking the chains the live endpoints walk: the
// console answers 401 naming a login URL, the membership endpoint redirects on
// its own, and each mints its own service cookie on its own host.
function mimoWorld(options = {}) {
  const calls = [];
  let consoleMints = 0;
  let membershipMints = 0;
  const fetch = async (url, init = {}) => {
    const href = String(url);
    const cookie = init.headers?.Cookie || '';
    const parsed = new URL(href);
    calls.push({ href, cookie });

    if (parsed.hostname === 'account.xiaomi.com') {
      if (options.accountRefused || !cookie.includes('passToken=')) return reply(200, '<html>login page</html>');
      const sid = parsed.searchParams.get('sid');
      // The desktop session can end for one service while the other still mints:
      // same account cookie, two service ids.
      if (options.membershipRefused && sid === 'mimopc') return reply(200, '<html>login page</html>');
      if (options.consoleRefused && sid === 'api-platform') return reply(200, '<html>login page</html>');
      return reply(302, '', {
        location: sid === 'api-platform' ? `${CONSOLE_BASE}/sts?sign=1` : `${MEMBERSHIP_BASE}/sts?sign=1`
      });
    }

    if (href.startsWith(`${CONSOLE_BASE}/balance`)) {
      if (!/api-platform_serviceToken=[^;]+/.test(cookie)) {
        return reply(401, {
          code: 401,
          loginUrl: `${LOGIN_URL}?callback=1&followup=${encodeURIComponent(`${CONSOLE_BASE}/balance`)}&sid=api-platform`
        });
      }
      if (options.consoleStatus) return reply(options.consoleStatus, { code: options.consoleStatus });
      return options.balance === null
        ? reply(200, { code: 0, data: {} })
        : reply(200, {
          code: 0,
          data: {
            balance: options.balance ?? 9.96,
            currency: 'CNY',
            cashBalance: 0,
            giftBalance: 9.96
          }
        });
    }
    if (href.startsWith(`${CONSOLE_BASE}/sts`)) {
      consoleMints += 1;
      return reply(307, '', {
        location: `${CONSOLE_BASE}/balance`,
        'set-cookie': ['api-platform_serviceToken=minted; Path=/', 'userId=42; Path=/']
      });
    }
    if (href.startsWith(`${CONSOLE_BASE}/userProfile`)) {
      return reply(200, { code: 0, data: { email: 'user@example.com', userId: '42' } });
    }
    if (href === `${CONSOLE_BASE}/usage`) {
      if (options.spendStatus) return reply(options.spendStatus, { code: options.spendStatus });
      return reply(200, {
        code: 0,
        data: {
          costUsage: { totalCost: options.totalCost ?? '0.05', currentMonthCost: options.monthCost ?? '0.05' }
        }
      });
    }
    if (href === `${CONSOLE_BASE}/tokenPlan/detail`) {
      if (options.tokenPlanDetailStatus) return reply(options.tokenPlanDetailStatus, { code: options.tokenPlanDetailStatus });
      return reply(200, { code: 0, data: options.tokenPlanDetail || {} });
    }
    if (href === `${CONSOLE_BASE}/tokenPlan/usage`) {
      if (options.tokenPlanUsageStatus) return reply(options.tokenPlanUsageStatus, { code: options.tokenPlanUsageStatus });
      return reply(200, { code: 0, data: options.tokenPlanUsage || {} });
    }

    if (href === `${MEMBERSHIP_BASE}/user/xiaomi/me`) {
      if (options.membershipStatus) return reply(options.membershipStatus, { code: options.membershipStatus });
      if (/serviceToken=[^;]+/.test(cookie)) {
        return reply(200, { code: 0, data: { userId: '42', region: options.region || 'CN' } });
      }
      return reply(302, '', {
        location: `${LOGIN_URL}?callback=1&followup=${encodeURIComponent(`${MEMBERSHIP_BASE}/user/xiaomi/me`)}&sid=mimopc`
      });
    }
    if (href.startsWith(`${MEMBERSHIP_BASE}/sts`)) {
      membershipMints += 1;
      return reply(307, '', {
        location: `${MEMBERSHIP_BASE}/user/xiaomi/me`,
        'set-cookie': ['serviceToken=minted; Path=/', 'userId=42; Path=/']
      });
    }
    if (href === `${MEMBERSHIP_BASE}/user/xiaomi/subscription/self`) {
      if (options.subscriptionStatus) return reply(options.subscriptionStatus, { code: options.subscriptionStatus });
      if (options.subscriptionBody) return reply(200, options.subscriptionBody);
      return reply(200, options.subscription || PLAN_BODY);
    }
    throw new Error(`unexpected request ${href}`);
  };
  return { fetch, calls, mints: () => ({ console: consoleMints, membership: membershipMints }) };
}

// --- console lane ------------------------------------------------------------

test('normalizeMimoCookieHeader keeps only the allowlisted session cookies', () => {
  assert.equal(
    normalizeMimoCookieHeader(CONSOLE_COOKIE),
    'api-platform_ph=optional; api-platform_serviceToken=secret; userId=42'
  );
  assert.equal(normalizeMimoCookieHeader('api-platform_serviceToken=secret'), '', 'a missing userId is not a session');
  assert.equal(normalizeMimoCookieHeader('userId=42'), '', 'a missing service token is not a session');
});

test('MiMo account keys pin the account namespace and the independent membership lane', () => {
  assert.equal(mimoAccountKey('', { userId: '42' }), CONSOLE_ACCOUNT_KEY_42);
  assert.equal(mimoMembershipAccountKey('42'), MEMBERSHIP_ACCOUNT_KEY_42);
  assert.notEqual(CONSOLE_ACCOUNT_KEY_42, MEMBERSHIP_ACCOUNT_KEY_42);
});

test('createMimoManagedAccount rejects an incomplete paste and preserves identity on reimport', () => {
  const rejected = createMimoManagedAccount('userId=42');
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.missingCookies, ['api-platform_serviceToken']);

  const first = createMimoManagedAccount(CONSOLE_COOKIE);
  assert.equal(first.ok, true);
  assert.equal(first.account.accountKey, CONSOLE_ACCOUNT_KEY_42);

  const again = createMimoManagedAccount(CONSOLE_COOKIE, [first.account]);
  assert.equal(again.account.id, first.account.id, 'the same account keeps its id');
  assert.equal(again.account.addedAt, first.account.addedAt);
});

test('the balance and profile parsers read the official shapes', () => {
  assert.deepEqual(
    parseMimoBalance({ code: 0, data: { balance: 9.96, currency: 'cny', cashBalance: 0, giftBalance: 9.96 } }),
    { amount: 9.96, currency: 'CNY', cashBalance: 0, giftBalance: 9.96 }
  );
  assert.deepEqual(
    parseMimoProfile({ code: 0, data: { platformEmail: 'user@example.com' } }),
    { email: 'user@example.com', name: '' }
  );
});

test('the console spend is provider-reported money, and never a derived figure', () => {
  assert.deepEqual(
    parseMimoSpend({ code: 0, data: { costUsage: { totalCost: '0.05', currentMonthCost: '0.05' } } }),
    { allTimeSpend: 0.05, monthSpend: 0.05 }
  );
  // Only what the summary states: a field the console does not report is left
  // absent, so the row cannot print a number nobody measured.
  assert.deepEqual(parseMimoSpend({ code: 0, data: { costUsage: { totalCost: '1.5' } } }), { allTimeSpend: 1.5 });
  assert.deepEqual(parseMimoSpend({ code: 0, data: {} }), {});
  assert.deepEqual(parseMimoSpend(null), {});
});

test('the usage parser prefers used/limit and reads an over-consumed plan as fully used', () => {
  const month = { monthUsage: { items: [{ name: 'month_total_token', used: 120, limit: 100, percent: 1.005 }] } };
  assert.deepEqual(parseMimoPlanUsage(month), { used: 120, limit: 100, usedPercent: 100 });
  const direct = { monthUsage: { used: 5, limit: 10, percent: 0.2 } };
  assert.deepEqual(parseMimoPlanUsage(direct), { used: 5, limit: 10, usedPercent: 50 });
  assert.deepEqual(parseMimoPlanUsage({ monthUsage: { items: [] } }), { used: null, limit: null, usedPercent: null });
});

test('plan detail needs explicit activation evidence and never activates a no-plan code', () => {
  const now = Date.UTC(2026, 8, 24);
  const future = '2026-10-01T00:00:00';
  const active = parseMimoPlanDetail({ code: 0, data: { planCode: 'mimo-cn-pro', planStatus: 'active', currentPeriodEnd: future } }, now);
  assert.equal(active.active, true);
  assert.equal(active.resetsAt, '2026-10-01T00:00:00.000Z', 'a zoneless wall clock is read as UTC');

  const bare = parseMimoPlanDetail({ code: 0, data: { planCode: 'mimo-cn-pro', currentPeriodEnd: future } }, now);
  assert.equal(bare.active, true, 'a plan identity with a running period is activation when no status is stated');
  const expiredBare = parseMimoPlanDetail({ code: 0, data: { planCode: 'mimo-cn-pro', currentPeriodEnd: '2026-01-01T00:00:00' } }, now);
  assert.equal(expiredBare.active, false);
  assert.equal(expiredBare.expired, true);

  const none = parseMimoPlanDetail({ code: 0, data: { planCode: 'none', planStatus: 'active', currentPeriodEnd: future } }, now);
  assert.equal(none.active, false);
  assert.equal(none.expired, false);
});

test('a membership lane that needs a re-login says so on its own row, beside the wallet', async () => {
  const world = mimoWorld({ membershipRefused: true });
  const rows = await fetchMimoLimits({}, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });

  assert.equal(rows.length, 2, 'the lane that answered and the lane that did not are two rows');
  const [console, membership] = rows;
  assert.equal(console.status, 'ok');
  const credits = console.windows.find((window) => window.metric === 'credits');
  assert.equal(credits.remaining, 9.96, 'the wallet is still on the row');
  assert.equal(console.accountEmail, 'user@example.com', 'and so is what names the account');
  assert.equal(console.windows.some((window) => window.kind === 'weekly'), false, 'the membership is not merged into it');
  assert.equal(membership.status, 'unauthorized', 'the refusal is the membership row’s own status');
  assert.equal(membership.sourceDetail, 'app', 'a machine-backed credential sends the user back to the app');
  assert.equal(membership.accountKey, MEMBERSHIP_ACCOUNT_KEY_42);
});

test('a membership lane that is merely throttled is not the user’s to fix', async () => {
  const world = mimoWorld({ membershipStatus: 429 });
  const rows = await fetchMimoLimits({}, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[1].status, 'sourceRateLimited', 'a 429 is traffic, and it is reported as traffic');
});

test('an account whose credential cannot be read answers for itself, not for the provider', async () => {
  const key = mimoAccountKey('', { userId: '7' });
  const rows = await fetchMimoLimits({ mimoManagedAccounts: [{ id: 'mimo-1', accountKey: key, cookieHeader: '' }] }, {
    fetch: async () => { throw new Error('no request may be spent without a credential'); },
    readMimoDesktopAccount: absentDesktop,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'notConfigured');
  assert.equal(rows[0].accountKey, key, 'the failure stays on the account it belongs to');
});

test('Desktop completes the membership identity of a saved account whose credential is unreadable', async () => {
  const accountKey = mimoAccountKey('', { userId: '42' });
  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{ id: 'mimo-1', accountKey, cookieHeader: '' }]
  }, {
    fetch: mimoWorld().fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.deepEqual(rows.map((row) => row.accountKey), [
    accountKey,
    mimoMembershipAccountKey('42')
  ]);
  assert.equal(rows[0].status, 'notConfigured');
  assert.equal(rows[1].status, 'ok');
});

test('a stored account is spent only with an allowlisted cookie, and scope narrows to one account', () => {
  const rows = scopedMimoManagedAccounts([{ accountKey: 'sha256:a', cookieHeader: CONSOLE_COOKIE }]);
  assert.equal(rows.length, 1);
  assert.equal(scopedMimoManagedAccounts(
    [{ accountKey: 'sha256:a', cookieHeader: CONSOLE_COOKIE }, { accountKey: 'sha256:b', cookieHeader: CONSOLE_COOKIE }],
    { provider: 'mimo', accountKey: 'sha256:b' }
  ).length, 1);
  assert.throws(
    () => scopedMimoManagedAccounts(
      [{ accountKey: 'sha256:a', cookieHeader: CONSOLE_COOKIE }, { accountKey: 'sha256:b', cookieHeader: CONSOLE_COOKIE }],
      { provider: 'mimo' }
    ),
    TypeError
  );
});

test('the detected session is listed beside stored accounts and never as a duplicate', () => {
  const key = mimoAccountKey('', { userId: '42' });
  assert.deepEqual(withDetectedMimoAccount([{ id: 'mimo-1', accountKey: key }], null), [{ id: 'mimo-1', accountKey: key, removable: true }]);
  const other = { id: 'mimo-desktop', accountKey: mimoAccountKey('', { userId: '99' }) };
  const listed = withDetectedMimoAccount([{ id: 'mimo-1', accountKey: key }], other);
  assert.equal(listed.length, 2);
  assert.equal(listed[1].removable, false, 'a discovered account has nothing stored to remove');
  assert.equal(withDetectedMimoAccount([{ id: 'mimo-1', accountKey: key }], { accountKey: key }).length, 1);
});

// --- the two lanes, one account ----------------------------------------------

test('a discovered session mints two rows: the console product and the membership', async () => {
  const world = mimoWorld();
  const rows = await fetchMimoLimits({}, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });

  assert.equal(rows.length, 2, 'one account, one row per product');
  const [console, membership] = rows;

  assert.equal(console.accountKey, CONSOLE_ACCOUNT_KEY_42);
  assert.equal(console.status, 'ok');
  assert.equal(console.source, 'local', 'a session read off this machine is a local source');
  assert.equal(console.sourceDetail, 'app', 'backed by the machine’s own login');
  assert.equal(console.accountLabel, 'Console');
  assert.equal(console.planLabel, 'Pay-as-you-go', 'the wallet plan is named the way this repository names one');
  assert.match(console.accountName, /^MiMo [a-f0-9]{7}$/u, 'an account without a public profile name gets an opaque label');
  assert.equal(console.accountEmail, 'user@example.com', 'the console lane names the account');
  const credits = console.windows.find((window) => window.metric === 'credits');
  assert.equal(credits.remaining, 9.96, 'the wallet rides the credits window');

  assert.equal(membership.accountKey, MEMBERSHIP_ACCOUNT_KEY_42, 'the lane, not the account, is the identity');
  assert.notEqual(membership.accountKey, console.accountKey, 'sharing one key would collapse the two rows in the hub');
  assert.equal(membership.status, 'ok');
  assert.equal(membership.source, 'local');
  assert.equal(membership.sourceDetail, 'app');
  assert.equal(membership.accountLabel, 'Desktop Membership');
  assert.equal(membership.planLabel, 'Pro', 'the vendor’s name for the tier is the plan');
  assert.equal(membership.accountName, console.accountName, 'both products retain the same account identity');
  assert.deepEqual(membership.windows.map((window) => window.kind), ['weekly']);
  assert.equal(membership.windows[0].usedPercent, 21.5, 'the app reports what is left, so the meter is inverted once');
  assert.deepEqual(world.mints(), { console: 1, membership: 1 }, 'each lane mints its own service session once');
});

test('a pasted console cookie and the machine’s session share the account, not the row', async () => {
  const world = mimoWorld();
  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{ id: 'mimo-1', accountKey: mimoAccountKey('', { userId: '42' }), cookieHeader: CONSOLE_COOKIE }]
  }, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });

  assert.equal(rows.length, 2);
  const [console, membership] = rows;
  assert.equal(console.accountKey, CONSOLE_ACCOUNT_KEY_42, 'a saved credential answers for the account identity');
  assert.equal(console.source, 'web', 'a console credential the user pasted is a web source');
  assert.equal(console.sourceDetail, 'managed', 'and it is the user’s own credential');
  assert.equal(membership.accountKey, MEMBERSHIP_ACCOUNT_KEY_42);
  assert.equal(membership.sourceDetail, 'app', 'the membership is still the machine’s session');
  assert.equal(world.mints().console, 0, 'a saved credential is never exchanged away');
});

test('a disabled manual console is not revived by discovery, while membership stays independent', async () => {
  const world = mimoWorld();
  const providerRuntimeState = new Map();
  const options = {
    mimoManagedAccounts: [{
      id: 'mimo-1',
      accountKey: mimoAccountKey('', { userId: '42' }),
      cookieHeader: CONSOLE_COOKIE,
      enabled: false
    }]
  };
  const deps = {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    providerRuntimeState,
    now: () => Date.UTC(2026, 8, 24)
  };
  const rows = await fetchMimoLimits(options, deps);
  assert.deepEqual(rows.map((row) => row.accountLabel), ['Desktop Membership']);
  assert.equal(rows[0].accountKey, MEMBERSHIP_ACCOUNT_KEY_42);
  assert.deepEqual(world.mints(), { console: 0, membership: 1 });
  const nextRows = await fetchMimoLimits(options, deps);
  assert.equal(nextRows.some((row) => row.removed), false, 'a disabled product is not tracked as an automatic row to remove every tick');
});

test('a saved account and a different Desktop account land beside each other', async () => {
  const world = mimoWorld();
  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{ id: 'mimo-1', accountKey: mimoAccountKey('', { userId: '7' }), cookieHeader: 'api-platform_serviceToken=own; userId=7' }]
  }, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop('42'),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.deepEqual(
    rows.map((row) => row.accountKey).sort(),
    [
      CONSOLE_ACCOUNT_KEY_7,
      CONSOLE_ACCOUNT_KEY_42,
      MEMBERSHIP_ACCOUNT_KEY_42
    ].sort(),
    'the saved account, the Desktop account and that account’s membership'
  );
});

test('a half sign-in reports both automatic products, and no store at all is silent', async () => {
  const signedOut = await fetchMimoLimits({}, {
    fetch: async () => { throw new Error('no request should be spent'); },
    readMimoDesktopAccount: () => { throw Object.assign(new Error('half'), { status: 'unauthorized', userId: '42' }); },
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(signedOut.length, 2);
  assert.deepEqual(signedOut.map((row) => [row.accountLabel, row.status, row.sourceDetail]), [
    ['Console', 'unauthorized', 'app'],
    ['Desktop Membership', 'unauthorized', 'app']
  ]);
  assert.deepEqual(signedOut.map((row) => row.accountKey), [
    mimoAccountKey('', { userId: '42' }),
    mimoMembershipAccountKey('42')
  ], 'each product reports against its own stable row');

  let spent = 0;
  const absent = await fetchMimoLimits({}, {
    fetch: async () => { spent += 1; throw new Error('unreachable'); },
    readMimoDesktopAccount: absentDesktop,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(absent.length, 1);
  assert.equal(absent[0].status, 'notConfigured', 'a machine with no MiMo Desktop has nothing to report');
  assert.equal(spent, 0);
});

test('a half Desktop sign-in does not hide membership behind a healthy manual console', async () => {
  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{
      id: 'mimo-1',
      accountKey: mimoAccountKey('', { userId: '42' }),
      cookieHeader: CONSOLE_COOKIE
    }]
  }, {
    fetch: mimoWorld().fetch,
    readMimoDesktopAccount: () => {
      throw Object.assign(new Error('half'), { status: 'unauthorized', userId: '42' });
    },
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].accountLabel, 'Console');
  assert.equal(rows[0].sourceDetail, 'managed');
  assert.equal(rows[1].status, 'unauthorized');
  assert.equal(rows[1].accountLabel, 'Desktop Membership');
  assert.equal(rows[1].sourceDetail, 'app');
  assert.equal(rows[1].accountName, rows[0].accountName);
});

test('a Desktop logout removes the old membership while a manual console keeps answering', async () => {
  const providerRuntimeState = new Map();
  await fetchMimoLimits({}, {
    fetch: mimoWorld().fetch,
    readMimoDesktopAccount: signedInDesktop(),
    providerRuntimeState,
    now: () => Date.UTC(2026, 8, 24)
  });

  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{
      id: 'mimo-1',
      accountKey: mimoAccountKey('', { userId: '42' }),
      cookieHeader: CONSOLE_COOKIE
    }]
  }, {
    fetch: mimoWorld().fetch,
    readMimoDesktopAccount: absentDesktop,
    providerRuntimeState,
    now: () => Date.UTC(2026, 8, 24)
  });

  assert.equal(rows.find((row) => row.accountLabel === 'Console')?.status, 'ok');
  assert.deepEqual(
    rows.filter((row) => row.removed).map((row) => row.accountKey),
    [mimoMembershipAccountKey('42')],
    'the runtime clears only the vanished automatic product'
  );
});

test('switching the Desktop account removes both automatic rows from the previous account', async () => {
  const providerRuntimeState = new Map();
  await fetchMimoLimits({}, {
    fetch: mimoWorld().fetch,
    readMimoDesktopAccount: signedInDesktop('42'),
    providerRuntimeState,
    now: () => Date.UTC(2026, 8, 24)
  });

  const rows = await fetchMimoLimits({}, {
    fetch: mimoWorld().fetch,
    readMimoDesktopAccount: signedInDesktop('7'),
    providerRuntimeState,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.deepEqual(rows.filter((row) => !row.removed).map((row) => row.accountKey), [
    CONSOLE_ACCOUNT_KEY_7,
    MEMBERSHIP_ACCOUNT_KEY_7
  ]);
  assert.deepEqual(new Set(rows.filter((row) => row.removed).map((row) => row.accountKey)), new Set([
    CONSOLE_ACCOUNT_KEY_42,
    MEMBERSHIP_ACCOUNT_KEY_42
  ]));
});

test('a restart seeds automatic identity removal from the previous limits snapshot', async () => {
  const consoleKey = mimoAccountKey('', { userId: '42' });
  const membershipKey = mimoMembershipAccountKey('42');
  const rows = await fetchMimoLimits({
    previousLimits: {
      providers: [
        { provider: 'mimo', sourceDetail: 'app', accountKey: consoleKey },
        { provider: 'mimo', sourceDetail: 'app', accountKey: membershipKey }
      ]
    },
    mimoManagedAccounts: [{ id: 'mimo-1', accountKey: consoleKey, cookieHeader: CONSOLE_COOKIE }]
  }, {
    fetch: mimoWorld().fetch,
    readMimoDesktopAccount: absentDesktop,
    providerRuntimeState: new Map(),
    now: () => Date.UTC(2026, 8, 24)
  });

  assert.equal(rows.some((row) => row.accountKey === consoleKey && !row.removed), true);
  assert.deepEqual(rows.filter((row) => row.removed).map((row) => row.accountKey), [membershipKey]);
});

test('an unattributed half sign-in still asks for a Desktop login, while an unreadable store is transient', async () => {
  const providerRuntimeState = new Map();
  const half = await fetchMimoLimits({}, {
    fetch: async () => { throw new Error('no request should be spent'); },
    readMimoDesktopAccount: () => { throw Object.assign(new Error('half'), { status: 'unauthorized' }); },
    providerRuntimeState,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(half.length, 1);
  assert.equal(half[0].status, 'unauthorized');
  assert.equal(half[0].source, 'local');
  assert.equal(half[0].sourceDetail, 'app');
  assert.equal(half[0].accountLabel, 'Desktop Membership');

  const alongsideManual = await fetchMimoLimits({
    mimoManagedAccounts: [{
      id: 'mimo-1',
      accountKey: CONSOLE_ACCOUNT_KEY_42,
      cookieHeader: CONSOLE_COOKIE
    }]
  }, {
    fetch: mimoWorld().fetch,
    readMimoDesktopAccount: () => { throw Object.assign(new Error('half'), { status: 'unauthorized' }); },
    providerRuntimeState,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.deepEqual(alongsideManual.map((row) => [row.accountLabel, row.status]), [
    ['Console', 'ok'],
    ['Desktop Membership', 'unauthorized']
  ], 'a healthy pasted wallet must not hide an unattributed Desktop login failure');

  const recovered = await fetchMimoLimits({
    mimoManagedAccounts: [{
      id: 'mimo-1',
      accountKey: CONSOLE_ACCOUNT_KEY_42,
      cookieHeader: CONSOLE_COOKIE
    }]
  }, {
    fetch: mimoWorld().fetch,
    readMimoDesktopAccount: signedInDesktop(),
    providerRuntimeState,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(recovered.filter((row) => row.removed).length, 1, 'the unattributed status is explicitly removed after login recovers');

  const unreadable = await fetchMimoLimits({}, {
    fetch: async () => { throw new Error('no request should be spent'); },
    readMimoDesktopAccount: () => { throw Object.assign(new Error('locked'), { status: 'unavailable' }); },
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(unreadable.length, 1);
  assert.equal(unreadable[0].status, 'unavailable', 'the runtime can retain the previous good rows');
  assert.equal(unreadable[0].sourceDetail, 'app');
});

test('a refused exchange is a credential problem and a throttled one is not', async () => {
  const refused = await fetchMimoLimits({}, {
    fetch: mimoWorld({ accountRefused: true }).fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(refused[0].status, 'unauthorized', 'the account cookie the service no longer takes ends on the login page');
  assert.equal(refused[0].accountKey, CONSOLE_ACCOUNT_KEY_42);

  assert.equal(refused.length, 2, 'the console lane still mints, so its row survives the refusal');
  assert.equal(refused[1].status, 'unauthorized');
  assert.equal(refused[1].accountKey, MEMBERSHIP_ACCOUNT_KEY_42);

  const throttled = await fetchMimoLimits({}, {
    fetch: mimoWorld({ membershipStatus: 429 }).fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(throttled.length, 2);
  assert.equal(throttled[1].status, 'sourceRateLimited', 'a 429 is traffic, not a credential');
});

test('the console spend rides the wallet, and losing it never costs the wallet', async () => {
  const world = mimoWorld({ totalCost: '32.85', monthCost: '9.30' });
  const rows = await fetchMimoLimits({}, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].balance.monthSpend, 9.3);
  assert.equal(rows[0].balance.allTimeSpend, 32.85);
  assert.equal(rows[0].balance.amount, 9.96, 'the wallet itself is untouched');

  const degraded = await fetchMimoLimits({}, {
    fetch: mimoWorld({ spendStatus: 500 }).fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(degraded[0].status, 'ok', 'a console that will not report spend still has a wallet');
  assert.equal(degraded[0].balance.monthSpend, null, 'and the row says nothing it was not told');
  assert.equal(degraded[0].balance.amount, 9.96);
});

test('an active Token Plan keeps its name when the optional usage meter is unavailable', async () => {
  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{
      id: 'mimo-1',
      accountKey: mimoAccountKey('', { userId: '42' }),
      cookieHeader: CONSOLE_COOKIE
    }]
  }, {
    fetch: mimoWorld({
      tokenPlanDetail: {
        planCode: 'mimo-cn-pro',
        planStatus: 'active',
        currentPeriodEnd: '2026-10-01T00:00:00Z'
      },
      tokenPlanUsageStatus: 500
    }).fetch,
    readMimoDesktopAccount: absentDesktop,
    now: () => Date.UTC(2026, 8, 24)
  });

  assert.equal(rows[0].status, 'ok', 'the wallet and plan identity still answered');
  assert.equal(rows[0].planLabel, 'mimo-cn-pro');
  assert.equal(rows[0].windows.some((window) => window.label === 'Token Plan'), false, 'no quota meter is invented');
  assert.equal(rows[0].windows.some((window) => window.metric === 'credits'), true);
});

test('a console lane that fails leaves the membership standing', async () => {
  const world = mimoWorld({ consoleRefused: true });
  const rows = await fetchMimoLimits({}, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });

  assert.equal(rows.length, 2, 'the product that answered is still a row of its own');
  assert.equal(rows[0].status, 'unauthorized', 'the console credential is the one the SSO refused');
  assert.equal(rows[0].accountKey, CONSOLE_ACCOUNT_KEY_42);
  assert.equal(rows[0].sourceDetail, 'app', 'and the row names the sign-in that fixes it');
  assert.equal(rows[1].status, 'ok', 'the membership is not the lane that failed');
  assert.equal(rows[1].accountKey, MEMBERSHIP_ACCOUNT_KEY_42);
  assert.equal(rows[1].windows.some((window) => window.kind === 'weekly'), true);
});

test('a membership payload the reader cannot use is an outage, not a refusal', async () => {
  const world = mimoWorld({ subscriptionBody: { code: 5, message: 'try later' } });
  const rows = await fetchMimoLimits({}, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows[0].status, 'ok', 'the wallet answers for itself');
  assert.equal(rows[1].status, 'unavailable', 'a body this lane cannot read is not evidence the sign-in ended');
  assert.equal(rows[1].windows.length, 0);
});

test('a stalled membership read times out without discarding the Console result', async () => {
  const world = mimoWorld();
  const fetch = (url, init) => {
    if (String(url).endsWith('/user/xiaomi/subscription/self')) {
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted')), { once: true });
      });
    }
    return world.fetch(url, init);
  };
  const rows = await fetchMimoLimits({}, {
    fetch,
    readMimoDesktopAccount: signedInDesktop(),
    accountTimeoutMs: 5,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.deepEqual(rows.map((row) => [row.accountLabel, row.status]), [
    ['Console', 'ok'],
    ['Desktop Membership', 'unavailable']
  ]);
});

test('no membership plan is an answer, and it neither hides the wallet nor invents a window', async () => {
  const world = mimoWorld({ subscription: { code: 0, data: { current: null } } });
  const rows = await fetchMimoLimits({}, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].accountLabel, 'Console');
  assert.equal(rows[0].planLabel, 'Pay-as-you-go');
  assert.equal(rows[1].status, 'ok', 'a machine with no plan is still a membership the user can be told about');
  assert.equal(rows[1].accountLabel, 'Desktop Membership', 'the product names the row where no plan does');
  assert.deepEqual(rows[1].windows, [], 'no plan means no weekly window');
});

test('a console lane that answers alone still publishes the account', async () => {
  const world = mimoWorld({ region: 'EU' });
  const rows = await fetchMimoLimits({}, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows.length, 1, 'a region the app does not carry silences the membership row, not the provider');
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].windows.some((window) => window.metric === 'credits'), true);
  assert.equal(rows[0].windows.some((window) => window.kind === 'weekly'), false);
});

test('an absent region is not evidence of a foreign account', async () => {
  const world = mimoWorld({ region: '' });
  const rows = await fetchMimoLimits({}, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows[1].status, 'ok', 'the endpoint is asked and answers for itself');
  assert.equal(rows[1].windows.some((window) => window.kind === 'weekly'), true);
});

test('a 200 without a balance is an outage, never a credential problem', async () => {
  const rows = await fetchMimoLimits({}, {
    fetch: mimoWorld({ balance: null }).fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows[0].status, 'unavailable');
  assert.equal(rows[0].windows.some((window) => window.metric === 'credits'), false);
});

test('a scoped refresh spends only the account it names', async () => {
  const world = mimoWorld();
  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{ id: 'mimo-1', accountKey: mimoAccountKey('', { userId: '42' }), cookieHeader: CONSOLE_COOKIE }],
    limitRefreshScope: { provider: 'mimo', accountKey: mimoAccountKey('', { userId: '42' }) }
  }, {
    fetch: world.fetch,
    readMimoDesktopAccount: absentDesktop,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(world.mints(), { console: 0, membership: 0 }, 'nothing is discovered for a scoped refresh');
});

test('a scoped refresh of one product does not answer for the other', async () => {
  const consoleWorld = mimoWorld();
  const accountKey = mimoAccountKey('', { userId: '42' });
  const scoped = { provider: 'mimo', accountKey };
  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{ id: 'mimo-1', accountKey, cookieHeader: CONSOLE_COOKIE }],
    limitRefreshScope: scoped
  }, {
    fetch: consoleWorld.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  // The runtime writes every row a scoped dispatch returns under the scope's own
  // identity, so answering with both would overwrite one row with the other.
  assert.deepEqual(rows.map((row) => row.accountKey), [accountKey]);
  assert.deepEqual(consoleWorld.mints(), { console: 0, membership: 0 }, 'the unselected membership lane does no work');

  const membershipWorld = mimoWorld();
  const membershipRows = await fetchMimoLimits({
    limitRefreshScope: { provider: 'mimo', accountKey: mimoMembershipAccountKey('42') }
  }, {
    fetch: membershipWorld.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.deepEqual(membershipRows.map((row) => row.accountKey), [MEMBERSHIP_ACCOUNT_KEY_42]);
  assert.deepEqual(membershipWorld.mints(), { console: 0, membership: 1 }, 'the unselected console lane does no work');
});

test('a scoped membership refresh keeps the account identity learned by the full refresh', async () => {
  const providerRuntimeState = new Map();
  const fullRows = await fetchMimoLimits({}, {
    fetch: mimoWorld().fetch,
    readMimoDesktopAccount: signedInDesktop(),
    providerRuntimeState,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(fullRows[1].accountEmail, 'user@example.com');

  const scopedRows = await fetchMimoLimits({
    limitRefreshScope: { provider: 'mimo', accountKey: mimoMembershipAccountKey('42') }
  }, {
    fetch: mimoWorld().fetch,
    readMimoDesktopAccount: signedInDesktop(),
    providerRuntimeState,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(scopedRows[0].accountEmail, 'user@example.com');
});

test('a cancelled refresh rejects instead of publishing an outage', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(fetchMimoLimits({}, {
    fetch: async () => { throw new Error('unreachable'); },
    readMimoDesktopAccount: signedInDesktop(),
    signal: controller.signal,
    now: () => Date.UTC(2026, 8, 24)
  }));
});

test('cancellation during the subscription read is not turned into an unavailable row', async () => {
  const world = mimoWorld();
  const controller = new AbortController();
  const fetch = async (url, init) => {
    if (String(url) === `${MEMBERSHIP_BASE}/user/xiaomi/subscription/self`) {
      controller.abort(new Error('cancelled during subscription'));
      throw controller.signal.reason;
    }
    return world.fetch(url, init);
  };
  await assert.rejects(fetchMimoLimits({}, {
    fetch,
    readMimoDesktopAccount: signedInDesktop(),
    signal: controller.signal,
    now: () => Date.UTC(2026, 8, 24)
  }), /cancelled during subscription/u);
});

// --- the exchange ------------------------------------------------------------

test('the walk sends the console’s origin headers only to the console', () => {
  const consoleHop = mimoExchangeRequestHeaders('a=b', 'https://platform.xiaomimimo.com/api/v1/balance');
  const accountHop = mimoExchangeRequestHeaders('a=b', 'https://account.xiaomi.com/pass/serviceLogin?sign=x');
  const membershipHop = mimoExchangeRequestHeaders('a=b', 'https://mimo-server-cn.xiaomimimo.com/api/user/xiaomi/me');

  assert.equal(consoleHop.Origin, 'https://platform.xiaomimimo.com');
  assert.equal(consoleHop.Referer, 'https://platform.xiaomimimo.com/#/console/balance');
  for (const hop of [accountHop, membershipHop]) {
    assert.equal(hop.Origin, undefined, 'the app sends no Origin to these hosts');
    assert.equal(hop.Referer, undefined, 'and no Referer either');
    // The rest of the MiMo client shape is what keeps the session alive.
    assert.ok(hop['User-Agent']);
    assert.equal(hop.Cookie, 'a=b');
  }
  // The console lane keeps the page-shaped set it has always sent.
  assert.equal(mimoRequestHeaders('a=b').Origin, 'https://platform.xiaomimimo.com');
});

test('the exchange refuses an off-list redirect without requesting it', async () => {
  const world = mimoWorld();
  let escaped = false;
  const fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith(`${MEMBERSHIP_BASE}/user/xiaomi/me`) && !String(init?.headers?.Cookie || '').includes('serviceToken=')) {
      return reply(302, '', { location: 'https://example.com/collect' });
    }
    if (href.startsWith('https://example.com/')) escaped = true;
    return world.fetch(url, init);
  };
  const rows = await fetchMimoLimits({}, {
    fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(escaped, false);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[1].status, 'unavailable');
});

test('the service host may use its observed HTTP callback without receiving Secure cookies', async () => {
  const world = mimoWorld();
  let callbackCookie = null;
  const fetch = async (url, init) => {
    const href = String(url);
    const parsed = new URL(href);
    if (parsed.hostname === 'account.xiaomi.com' && parsed.searchParams.get('sid') === 'mimopc') {
      return reply(302, '', { location: `http://mimo-server-cn.xiaomimimo.com/api/sts?sign=1` });
    }
    if (href.startsWith('http://mimo-server-cn.xiaomimimo.com/api/sts')) {
      callbackCookie = String(init?.headers?.Cookie || '');
      return reply(307, '', {
        location: `${MEMBERSHIP_BASE}/user/xiaomi/me`,
        'set-cookie': ['serviceToken=minted; Path=/', 'userId=42; Path=/']
      });
    }
    return world.fetch(url, init);
  };
  const rows = await fetchMimoLimits({}, {
    fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(callbackCookie, '', 'the account cookie is Secure and stays off HTTP');
  assert.equal(rows[1].status, 'ok');
});

test('the HTTP callback exception does not allow arbitrary service-host paths', async () => {
  const world = mimoWorld();
  let escaped = false;
  const fetch = async (url, init) => {
    const href = String(url);
    const parsed = new URL(href);
    if (parsed.hostname === 'account.xiaomi.com' && parsed.searchParams.get('sid') === 'mimopc') {
      return reply(302, '', { location: 'http://mimo-server-cn.xiaomimimo.com/api/collect' });
    }
    if (href === 'http://mimo-server-cn.xiaomimimo.com/api/collect') escaped = true;
    return world.fetch(url, init);
  };
  const rows = await fetchMimoLimits({}, {
    fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(escaped, false);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[1].status, 'unavailable');
});

test('the membership plan is read the way the app reads it', () => {
  assert.deepEqual(readMimoMembershipPlan(PLAN_BODY), {
    ok: true,
    plan: { tier: 3, code: 'mimo-cn-pro', source: 'ORDER_SUB', percent: 78.5, resetsAt: '2026-09-15T00:00:00.000Z' }
  });
  assert.deepEqual(readMimoMembershipPlan({ code: 0, data: { current: null } }), { ok: true, plan: null });
  assert.equal(readMimoMembershipPlan({ code: 0, data: { current: { planTier: 3 } } }).ok, false, 'a current missing its fields is not a plan');
  assert.equal(readMimoMembershipPlan({ code: 0, data: {} }).ok, true, 'an absent current is no plan, not a failure');
  assert.equal(readMimoMembershipPlan({
    code: 0,
    data: { current: { ...PLAN_BODY.data.current, percent: 101 } }
  }).plan.percent, 100, 'the app caps the displayed remaining percentage at 100');
});

test('the plan label is the vendor’s name for the tier, or its own code', () => {
  assert.equal(mimoMembershipPlanLabel({ tier: 1 }), 'Starter');
  assert.equal(mimoMembershipPlanLabel({ tier: 3 }), 'Pro');
  assert.equal(mimoMembershipPlanLabel({ tier: 4 }), 'Ultra');
  // A tier outside the vendor's table has no name to take, so the vendor's own
  // code stands in rather than nothing — the rule planLabelFromParts applies to
  // every plan this repository cannot name.
  assert.equal(
    mimoMembershipPlanLabel({ tier: 9, code: 'mimo-cn-enterprise' }),
    'Mimo Cn Enterprise',
    'an unnamed tier prints what the vendor called it'
  );
  assert.equal(mimoMembershipPlanLabel({ tier: 9, code: 'enterprise' }), 'Enterprise', 'and still goes through the alias table');
  assert.equal(mimoMembershipPlanLabel({ tier: 9 }), '', 'a plan with neither a known tier nor a code has nothing to print');
  assert.equal(mimoMembershipPlanLabel({ tier: 3, source: 'INVITE' }), '', 'the app excludes an invited subscription from its current-plan card');
  assert.equal(mimoMembershipPlanLabel(null), '');
});

test('the hub keeps both products of one account, from one device or two', async () => {
  const consoleRow = {
    provider: 'mimo', status: 'ok', accountKey: mimoAccountKey('', { userId: '42' }),
    accountLabel: 'Console', planLabel: 'Pay-as-you-go', accountName: 'MiMo account',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 9.96, currency: 'CNY' }]
  };
  const membershipRow = {
    provider: 'mimo', status: 'ok', accountKey: mimoMembershipAccountKey('42'),
    accountLabel: 'Desktop Membership', planLabel: 'Pro', accountName: 'MiMo account',
    windows: [{ kind: 'weekly', usedPercent: 21.5, resetsAt: '2026-09-28T00:00:00.000Z' }]
  };
  const summary = normalizeLimitsSummary({ providers: [consoleRow, membershipRow], refreshMs: 300000 });
  const aggregated = aggregateLimits([{ deviceId: 'dev-1', limits: summary }], 0, Date.UTC(2026, 8, 24));

  // One key for both products would leave the aggregate's per-key winner alone on
  // the account — the reason the membership carries its lane in its key.
  assert.deepEqual(
    aggregated.providers.map((row) => row.accountKey).sort(),
    [mimoAccountKey('', { userId: '42' }), mimoMembershipAccountKey('42')].sort()
  );

  // The same account seen from a second device is still two rows, not four: the
  // lane key is stable, so the two observations of each product collapse.
  const twoDevices = aggregateLimits([
    { deviceId: 'dev-1', limits: summary },
    { deviceId: 'dev-2', limits: summary }
  ], 0, Date.UTC(2026, 8, 24));
  assert.equal(twoDevices.providers.length, 2);
});

test('a membership session that ends is a credential problem, not an outage', async () => {
  const rows = await fetchMimoLimits({}, {
    fetch: mimoWorld({ subscriptionStatus: 401 }).fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows.length, 2, 'the console lane is untouched by the membership’s expiry');
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[1].status, 'unauthorized');
  assert.equal(rows[1].accountKey, MEMBERSHIP_ACCOUNT_KEY_42);
});

test('a refusal may arrive as an ordinary 200 carrying the vendor’s code', async () => {
  // The app's own classifier: `403` and `46109` are rejections even when the
  // transport answers 200, and the identity hop is where they land.
  const world = mimoWorld();
  const refusing = async (url, init) => {
    const href = String(url);
    if (href === `${MEMBERSHIP_BASE}/user/xiaomi/me` && /serviceToken=[^;]+/.test(String(init?.headers?.Cookie || ''))) {
      return reply(200, { code: 46109, message: 'denied' });
    }
    return world.fetch(url, init);
  };
  const rows = await fetchMimoLimits({}, {
    fetch: refusing,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows.length, 2, 'the console product answers for itself while the membership is refused');
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[1].status, 'unauthorized', 'a body-level rejection is a credential problem');
});

test('a machine with no Desktop session has no membership row at all', async () => {
  const world = mimoWorld();
  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{ id: 'mimo-1', accountKey: mimoAccountKey('', { userId: '42' }), cookieHeader: CONSOLE_COOKIE }]
  }, {
    fetch: world.fetch,
    readMimoDesktopAccount: absentDesktop,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows.length, 1, 'the console product answers for the account on its own');
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].windows.some((window) => window.metric === 'credits'), true);
  assert.deepEqual(world.mints(), { console: 0, membership: 0 }, 'nothing is discovered for an account with no local session');
});

// --- the local session reader ------------------------------------------------

function sqliteReturning(rows) {
  return {
    DatabaseSync: class {
      prepare() { return { all: () => rows }; }
      close() {}
    }
  };
}
const presentFile = { statSync: () => ({ isFile: () => true }) };

test('the reader carries the two allowlisted cookies and nothing else in the store', () => {
  const read = readMimoDesktopAccount({
    candidates: ['/x/Cookies'],
    fs: presentFile,
    sqlite: sqliteReturning([
      { name: 'passToken', value: 'p', encrypted_value: null },
      { name: 'userId', value: '42', encrypted_value: null },
      { name: 'cUserId', value: 'ignored', encrypted_value: null }
    ])
  });
  assert.deepEqual(read, { userId: '42', cookieHeader: 'passToken=p; userId=42' });
});

test('a half sign-in is a signed-out app, and it names the account it was read from', () => {
  assert.throws(
    () => readMimoDesktopAccount({
      candidates: ['/x/Cookies'],
      fs: presentFile,
      sqlite: sqliteReturning([{ name: 'userId', value: '42', encrypted_value: null }])
    }),
    (error) => error.status === 'unauthorized' && error.userId === '42'
  );
});

test('the partition resolves on verified or documented platforms only', () => {
  const home = path.join(path.sep, 'Users', 'u');
  assert.deepEqual(mimoDesktopCookieCandidates({ platform: 'darwin', home }), [
    path.join(home, 'Library', 'Application Support', 'Xiaomi MiMo', 'Partitions', 'xiaomi-account', 'Cookies')
  ]);
  assert.equal(mimoDesktopCookieCandidates({ platform: 'win32', home, env: {} }).length, 1);
  assert.deepEqual(mimoDesktopCookieCandidates({ platform: 'linux', home, env: {} }), []);
  assert.deepEqual(mimoDesktopCookieCandidates({ platform: 'freebsd', home, env: {} }), []);
});

test('a store that is there but cannot be read keeps the previous reading', () => {
  const unreadable = {
    DatabaseSync: class {
      constructor() { throw new Error('database is locked'); }
      close() {}
    }
  };
  assert.throws(
    () => readMimoDesktopAccount({ candidates: ['/x/Cookies'], fs: presentFile, sqlite: unreadable }),
    (error) => error.status === 'unavailable',
    'a lock, a permission or a corrupt file is an outage, not an app that is not installed'
  );
  const deniedStat = { statSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
  assert.throws(
    () => readMimoDesktopAccount({ candidates: ['/x/Cookies'], fs: deniedStat, sqlite: sqliteReturning([]) }),
    (error) => error.status === 'unavailable',
    'a store we cannot even stat may exist'
  );
});

test('a store that never held a cookie, a sealed store and no store are all nothing to discover', () => {
  assert.throws(
    () => readMimoDesktopAccount({ candidates: ['/x/Cookies'], fs: presentFile, sqlite: sqliteReturning([]) }),
    (error) => error.status === 'notConfigured'
  );
  assert.throws(
    () => readMimoDesktopAccount({
      candidates: ['/x/Cookies'],
      fs: presentFile,
      sqlite: sqliteReturning([
        { name: 'userId', value: '42', encrypted_value: null },
        { name: 'passToken', value: '', encrypted_value: new Uint8Array([1]) }
      ])
    }),
    (error) => error.status === 'notConfigured',
    'at-rest encryption is a property of the store, never a signed-out app'
  );
  assert.throws(
    () => readMimoDesktopAccount({ candidates: ['/nonexistent/Cookies'], fs: presentFile, sqlite: sqliteReturning([]) }),
    (error) => error.status === 'notConfigured'
  );
  assert.throws(
    () => readMimoDesktopAccount({ platform: 'linux', home: '/home/u', sqlite: sqliteReturning([]) }),
    (error) => error.status === 'notConfigured'
  );
  assert.throws(
    () => readMimoDesktopAccount({ candidates: ['/x/Cookies'], fs: presentFile, sqlite: null }),
    (error) => error.status === 'notConfigured',
    'a runtime without node:sqlite has nothing to read with'
  );
});

test('a usable plaintext cookie wins over a sealed duplicate row', () => {
  const read = readMimoDesktopAccount({
    candidates: ['/x/Cookies'],
    fs: presentFile,
    sqlite: sqliteReturning([
      { name: 'passToken', value: '', encrypted_value: Buffer.from('sealed-stale-copy') },
      { name: 'passToken', value: 'p', encrypted_value: null },
      { name: 'userId', value: '42', encrypted_value: null }
    ])
  });
  assert.deepEqual(read, { userId: '42', cookieHeader: 'passToken=p; userId=42' });
});
