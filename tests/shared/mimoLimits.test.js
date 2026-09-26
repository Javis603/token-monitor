'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  createMimoManagedAccount,
  fetchMimoLimits,
  mimoAccountKey,
  normalizeMimoCookieHeader,
  parseMimoBalance,
  parseMimoPlanDetail,
  parseMimoPlanUsage,
  parseMimoProfile,
  scopedMimoManagedAccounts,
  withDetectedMimoAccount
} = require('../../src/shared/providers/mimo/limits');
const {
  mimoMembershipCredential,
  mimoMembershipPlanLabel,
  readMimoMembershipPlan
} = require('../../src/shared/providers/mimo/membership');
const { mimoDesktopCookieCandidates, readMimoDesktopAccount } = require('../../src/shared/providers/mimo/desktop');

const CONSOLE_COOKIE = 'unrelated=drop; userId=42; api-platform_serviceToken=secret; api-platform_ph=optional';
const CONSOLE_BASE = 'https://platform.xiaomimimo.com/api/v1';
const MEMBERSHIP_BASE = 'https://mimo-server-cn.xiaomimimo.com/api';
const LOGIN_URL = 'https://account.xiaomi.com/pass/serviceLogin';

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

const PLAN_BODY = {
  code: 0,
  data: {
    current: {
      planCode: 'mimo-cn-pro',
      planTier: 3,
      renewalMode: 'MONTHLY',
      endTime: '2026-10-01T00:00:00',
      percent: 78.5,
      nextResetTime: '2026-09-15T00:00:00'
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
    if (href.startsWith(`${CONSOLE_BASE}/tokenPlan/`)) {
      return reply(200, { code: 0, data: options.tokenPlan || {} });
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
      return reply(200, options.subscription || PLAN_BODY);
    }
    throw new Error(`unexpected request ${href}`);
  };
  return { fetch, calls, mints: () => ({ console: consoleMints, membership: membershipMints }) };
}

// --- the console lane the owner's code owns ----------------------------------

test('normalizeMimoCookieHeader keeps only the allowlisted session cookies', () => {
  assert.equal(
    normalizeMimoCookieHeader(CONSOLE_COOKIE),
    'api-platform_ph=optional; api-platform_serviceToken=secret; userId=42'
  );
  assert.equal(normalizeMimoCookieHeader('api-platform_serviceToken=secret'), '', 'a missing userId is not a session');
  assert.equal(normalizeMimoCookieHeader('userId=42'), '', 'a missing service token is not a session');
});

test('createMimoManagedAccount rejects an incomplete paste and preserves identity on reimport', () => {
  const rejected = createMimoManagedAccount('userId=42');
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.missingCookies, ['api-platform_serviceToken']);

  const first = createMimoManagedAccount(CONSOLE_COOKIE);
  assert.equal(first.ok, true);
  assert.equal(first.account.accountKey, mimoAccountKey('', { userId: '42' }));

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
    { email: 'user@example.com', userId: '' }
  );
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

test('a discovered session mints both lanes into one row', async () => {
  const world = mimoWorld();
  const rows = await fetchMimoLimits({}, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });

  assert.equal(rows.length, 1, 'one account is one row');
  assert.equal(rows[0].accountKey, mimoAccountKey('', { userId: '42' }));
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].accountEmail, 'user@example.com', 'the console lane names the account');
  assert.equal(rows[0].sourceDetail, 'app', 'the row is backed by the machine’s own login');
  assert.equal(rows[0].accountLabel, 'Pro', 'the membership plan names the row where the console has none');

  assert.deepEqual(rows[0].windows.map((window) => window.kind), ['billing', 'weekly']);
  const credits = rows[0].windows.find((window) => window.metric === 'credits');
  assert.equal(credits.remaining, 9.96, 'the wallet rides the credits window');
  const weekly = rows[0].windows.find((window) => window.kind === 'weekly');
  assert.equal(weekly.usedPercent, 21.5, 'the app reports what is left, so the meter is inverted once');
  assert.deepEqual(world.mints(), { console: 1, membership: 1 });
});

test('a pasted console cookie and the machine’s session for one account stay one row', async () => {
  const world = mimoWorld();
  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{ id: 'mimo-1', accountKey: mimoAccountKey('', { userId: '42' }), cookieHeader: CONSOLE_COOKIE }]
  }, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceDetail, 'managed', 'the credential the user entered owns the row');
  assert.equal(world.mints().console, 0, 'a saved credential is never exchanged away');
});

test('a saved account and a different Desktop account are two rows', async () => {
  const world = mimoWorld();
  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{ id: 'mimo-1', accountKey: mimoAccountKey('', { userId: '7' }), cookieHeader: 'api-platform_serviceToken=own; userId=7' }]
  }, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop('42'),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows.length, 2, 'a different Desktop account lands beside the saved one');
  assert.deepEqual(
    rows.map((row) => row.accountKey).sort(),
    [mimoAccountKey('', { userId: '42' }), mimoAccountKey('', { userId: '7' })].sort()
  );
});

test('a half sign-in is one attributed unauthorized row, and no store at all is silent', async () => {
  const signedOut = await fetchMimoLimits({}, {
    fetch: async () => { throw new Error('no request should be spent'); },
    readMimoDesktopAccount: () => { throw Object.assign(new Error('half'), { status: 'unauthorized', userId: '42' }); },
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(signedOut.length, 1);
  assert.equal(signedOut[0].status, 'unauthorized');
  assert.equal(signedOut[0].accountKey, mimoAccountKey('', { userId: '42' }), 'reported against the account the store names');
  assert.equal(signedOut[0].sourceDetail, 'app');

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

test('a refused exchange is a credential problem and a throttled one is not', async () => {
  const refused = await fetchMimoLimits({}, {
    fetch: mimoWorld({ accountRefused: true }).fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(refused[0].status, 'unauthorized', 'the account cookie the service no longer takes ends on the login page');
  assert.equal(refused[0].accountKey, mimoAccountKey('', { userId: '42' }));

  // The throttled lane is the only one here: with a console lane answering as
  // well the row stays `ok`, which is the composition rule the next test pins.
  const throttled = await fetchMimoLimits({ mimoMembershipCookie: 'serviceToken=pasted; userId=42' }, {
    fetch: mimoWorld({ membershipStatus: 429 }).fetch,
    readMimoDesktopAccount: absentDesktop,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(throttled[0].status, 'sourceRateLimited', 'a 429 is traffic, not a credential');
});

test('no membership plan is an answer, and it neither hides the wallet nor invents a window', async () => {
  const world = mimoWorld({ subscription: { code: 0, data: { current: null } } });
  const rows = await fetchMimoLimits({}, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].windows.some((window) => window.kind === 'weekly'), false, 'no plan means no weekly window');
  assert.equal(rows[0].accountLabel, 'Pay-as-you-go', 'the wallet is named the way this repository names one');
});

test('a console lane that answers alone still publishes the account', async () => {
  const world = mimoWorld({ region: 'EU' });
  const rows = await fetchMimoLimits({}, {
    fetch: world.fetch,
    readMimoDesktopAccount: signedInDesktop(),
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows[0].status, 'ok', 'a region the app does not carry silences the membership lane, not the provider');
  assert.equal(rows[0].windows.some((window) => window.metric === 'credits'), true);
  assert.equal(rows[0].windows.some((window) => window.kind === 'weekly'), false);
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

// --- the exchange ------------------------------------------------------------

test('the membership plan is read the way the app reads it', () => {
  assert.deepEqual(readMimoMembershipPlan(PLAN_BODY), {
    ok: true,
    plan: { tier: 3, source: '', percent: 78.5, resetsAt: '2026-09-15T00:00:00.000Z' }
  });
  assert.deepEqual(readMimoMembershipPlan({ code: 0, data: { current: null } }), { ok: true, plan: null });
  assert.equal(readMimoMembershipPlan({ code: 0, data: { current: { planTier: 3 } } }).ok, false, 'a current missing its fields is not a plan');
  assert.equal(readMimoMembershipPlan({ code: 0, data: {} }).ok, true, 'an absent current is no plan, not a failure');
});

test('the plan label is the vendor’s name for the tier', () => {
  assert.equal(mimoMembershipPlanLabel({ tier: 1 }), 'Starter');
  assert.equal(mimoMembershipPlanLabel({ tier: 3 }), 'Pro');
  assert.equal(mimoMembershipPlanLabel({ tier: 4 }), 'Ultra');
  assert.equal(mimoMembershipPlanLabel({ tier: 9 }), '', 'a tier outside the map has no name to give');
  assert.equal(mimoMembershipPlanLabel({ tier: 3, source: 'INVITE' }), 'INVITE', 'the app names an invited plan by its source');
  assert.equal(mimoMembershipPlanLabel(null), '');
});

test('a membership credential is one of the two shapes the exchange accepts', () => {
  assert.deepEqual(mimoMembershipCredential('passToken=p; userId=42; cUserId=x'), {
    kind: 'account', userId: '42', cookieHeader: 'passToken=p; userId=42'
  });
  assert.deepEqual(mimoMembershipCredential('serviceToken=s; userId=42; mimopc_ph=h'), {
    kind: 'service', userId: '42', cookieHeader: 'serviceToken=s; mimopc_ph=h; userId=42'
  });
  assert.equal(mimoMembershipCredential('api-platform_serviceToken=x; userId=42'), null, 'the console’s service token belongs to another service');
  assert.equal(mimoMembershipCredential('passToken=p'), null, 'a credential with no account id cannot be attributed');
});

test('a refusal may arrive as an ordinary 200 carrying the vendor’s code', async () => {
  const world = mimoWorld();
  const refusing = async (url, init) => {
    const href = String(url);
    if (href.includes('/user/xiaomi/me') && /serviceToken=[^;]+/.test(String(init?.headers?.Cookie || ''))) {
      return reply(200, { code: 46109, message: 'denied' });
    }
    return world.fetch(url, init);
  };
  const rows = await fetchMimoLimits({ mimoMembershipCookie: 'passToken=own; userId=42' }, {
    fetch: refusing,
    readMimoDesktopAccount: absentDesktop,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows[0].status, 'unauthorized', 'a body-level rejection is a credential problem');
});

test('a membership credential the user pasted is spent, and a signed-out machine does not shadow it', async () => {
  const world = mimoWorld();
  const rows = await fetchMimoLimits({ mimoMembershipCookie: 'statusless=1; serviceToken=pasted; userId=42' }, {
    fetch: world.fetch,
    readMimoDesktopAccount: absentDesktop,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].sourceDetail, 'managed', 'a pasted credential is the user’s, not the machine’s');
  assert.equal(rows[0].windows.some((window) => window.kind === 'weekly'), true);
  assert.equal(rows[0].windows.some((window) => window.metric === 'credits'), false, 'no console credential, no wallet');
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

test('the partition resolves on macOS and Windows and nowhere else', () => {
  const home = path.join(path.sep, 'Users', 'u');
  assert.deepEqual(mimoDesktopCookieCandidates({ platform: 'darwin', home }), [
    path.join(home, 'Library', 'Application Support', 'Xiaomi MiMo', 'Partitions', 'xiaomi-account', 'Cookies')
  ]);
  assert.equal(mimoDesktopCookieCandidates({ platform: 'win32', home, env: {} }).length, 1);
  assert.deepEqual(mimoDesktopCookieCandidates({ platform: 'linux', home }), []);
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
