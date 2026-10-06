'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

// The console's spend ledger defaults to the app's own data directory, which a
// test must never write: the same isolation the archive tests make with this
// variable, applied for the whole file (node runs each test file in its own
// process). Tests that assert on the ledger still inject their own store.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-limits-tests-'));
process.env.TOKEN_MONITOR_SHARED_DIR = testDataDir;
test.after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

const {
  fetchMimoLimits,
  mimoAccountKey,
  mimoMembershipAccountKey,
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
const { probeLimitProvider } = require('../../src/shared/limits/collector');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { mimoExchangeRequestHeaders, mimoRequestHeaders } = require('../../src/shared/providers/mimo/browserHeaders');
const { mintMimoServiceSession } = require('../../src/shared/providers/mimo/session');

const CONSOLE_COOKIE = 'unrelated=drop; userId=42; api-platform_serviceToken=secret; api-platform_ph=optional';
const CONSOLE_BASE = 'https://platform.xiaomimimo.com/api/v1';
const CONSOLE_STS = 'https://platform.xiaomimimo.com/sts';
const MEMBERSHIP_BASE = 'https://mimo-server-cn.xiaomimimo.com/api';
const LOGIN_URL = 'https://account.xiaomi.com/pass/serviceLogin';
const CONSOLE_ACCOUNT_KEY_42 = 'sha256:9c59f5aa7d0dcd4428d62a0b03a13d9a345dbf2fc965e91bf8383f3206c0004d';
const MEMBERSHIP_ACCOUNT_KEY_42 = 'sha256:0cf3bae7981a1796fe99f80a20111408ff58f977b8a2c464939de0a404aced46';
const CONSOLE_ACCOUNT_KEY_7 = 'sha256:cd264e505d86d6fb49c1aeefd277324e93b4ddd34e31a7e743412daeb474670a';
const MEMBERSHIP_ACCOUNT_KEY_7 = 'sha256:b41179974aa7a240cd799f1548fea3a86d4dd618d77979b770f19cd958f1984d';

const absentDesktop = () => { throw Object.assign(new Error('no store'), { status: 'notConfigured' }); };
const signedInDesktop = (userId = '42') => () => ({ userId, cookieHeader: `passToken=p; userId=${userId}` });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

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

// Subscription fixture adapted from the app's E2E payload. Active values are
// not live account evidence; only the no-subscription branch was observed live.
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
    const userId = /(?:^|;\s*)userId=([^;]+)/.exec(cookie)?.[1] || parsed.searchParams.get('userId') || '42';
    calls.push({ href, cookie });

    if (parsed.hostname === 'account.xiaomi.com') {
      if (options.accountRefused || !cookie.includes('passToken=')) return reply(200, '<html>login page</html>');
      const sid = parsed.searchParams.get('sid');
      // The desktop session can end for one service while the other still mints:
      // same account cookie, two service ids.
      if (options.membershipRefused && sid === 'mimopc') return reply(200, '<html>login page</html>');
      if (options.consoleRefused && sid === 'api-platform') return reply(200, '<html>login page</html>');
      return reply(302, '', {
        location: sid === 'api-platform' ? `${CONSOLE_STS}?sign=1&userId=${userId}` : `${MEMBERSHIP_BASE}/sts?sign=1&userId=${userId}`
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
            balance: options.balances?.[userId] ?? options.balance ?? 9.96,
            currency: options.currency ?? 'CNY',
            cashBalance: 0,
            giftBalance: 9.96
          }
        });
    }
    if (href.startsWith(CONSOLE_STS)) {
      consoleMints += 1;
      return reply(307, '', {
        location: `${CONSOLE_BASE}/balance?userId=${userId}`,
        'set-cookie': ['api-platform_serviceToken=minted; Path=/', `userId=${userId}; Path=/`]
      });
    }
    if (href.startsWith(`${CONSOLE_BASE}/userProfile`)) {
      return reply(200, { code: 0, data: { email: userId === '42' ? 'user@example.com' : `user-${userId}@example.com`, userId } });
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

    // The measured identity callback carries userId; bare service-cookie replay redirects to SSO.
    if (`${parsed.origin}${parsed.pathname}` === `${MEMBERSHIP_BASE}/user/xiaomi/me`) {
      if (options.membershipStatus) return reply(options.membershipStatus, { code: options.membershipStatus });
      if (/serviceToken=[^;]+/.test(cookie) && parsed.searchParams.has('userId')) {
        return reply(200, { code: 0, data: { userId, region: options.region ?? 'CN' } });
      }
      return reply(302, '', {
        location: `${LOGIN_URL}?callback=1&followup=${encodeURIComponent(`${MEMBERSHIP_BASE}/user/xiaomi/me`)}&sid=mimopc`
      });
    }
    if (href.startsWith(`${MEMBERSHIP_BASE}/sts`)) {
      membershipMints += 1;
      return reply(307, '', {
        location: `${MEMBERSHIP_BASE}/user/xiaomi/me?userId=${userId}`,
        'set-cookie': ['serviceToken=minted; Path=/', `userId=${userId}; Path=/`]
      });
    }
    if (href === `${MEMBERSHIP_BASE}/user/xiaomi/subscription/self`) {
      if (options.subscriptionStatus) return reply(options.subscriptionStatus, { code: options.subscriptionStatus });
      if (options.subscriptionBody) return reply(200, options.subscriptionBody);
      return reply(200, options.subscription || PLAN_BODY);
    }
    throw new Error(`unexpected request ${href}`);
  };
  return {
    fetch, calls, mints: () => ({ console: consoleMints, membership: membershipMints }),
    deps: { fetch, readMimoDesktopAccount: signedInDesktop(), now: () => Date.UTC(2026, 8, 24) }
  };
}

// --- console lane ------------------------------------------------------------

test('MiMo account keys pin the account namespace and the independent membership lane', () => {
  assert.equal(mimoAccountKey('', { userId: '42' }), CONSOLE_ACCOUNT_KEY_42);
  assert.equal(mimoMembershipAccountKey('42'), MEMBERSHIP_ACCOUNT_KEY_42);
  assert.notEqual(CONSOLE_ACCOUNT_KEY_42, MEMBERSHIP_ACCOUNT_KEY_42);
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

test('a membership lane that needs a re-login says so on its own row, beside the wallet', async () => {
  const world = mimoWorld({ membershipRefused: true });
  const rows = await fetchMimoLimits({}, world.deps);

  assert.equal(rows.length, 2, 'the lane that answered and the lane that did not are two rows');
  const [console, membership] = rows;
  assert.equal(console.status, 'ok');
  const credits = console.windows.find((window) => window.metric === 'credits');
  assert.equal(credits.remaining, 9.96, 'the wallet is still on the row');
  assert.equal(console.accountEmail, 'user@example.com', 'and so is what names the account');
  assert.equal(
    console.windows.some((window) => window.kind === 'weekly' && window.usedPercent === 21.5),
    false,
    'the membership is not merged into it'
  );
  assert.equal(membership.status, 'unauthorized', 'the refusal is the membership row’s own status');
  assert.equal(membership.sourceDetail, 'app', 'a machine-backed credential sends the user back to the app');
  assert.equal(membership.accountKey, MEMBERSHIP_ACCOUNT_KEY_42);
});

test('a membership lane that is merely throttled is not the user’s to fix', async () => {
  const world = mimoWorld({ membershipStatus: 429 });
  const rows = await fetchMimoLimits({}, world.deps);
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
  }, mimoWorld().deps);
  assert.deepEqual(rows.map((row) => row.accountKey), [
    accountKey,
    mimoMembershipAccountKey('42')
  ]);
  assert.equal(rows[0].status, 'notConfigured');
  assert.equal(rows[1].status, 'ok');
});

test('a stored account is spent only with an allowlisted cookie, and scope narrows to one account', () => {
  const rows = scopedMimoManagedAccounts([{ accountKey: 'sha256:a', cookieHeader: CONSOLE_COOKIE }]);
  assert.deepEqual(rows.map(({ accountKey, cookieHeader }) => ({ accountKey, cookieHeader })), [{
    accountKey: 'sha256:a',
    cookieHeader: 'api-platform_ph=optional; api-platform_serviceToken=secret; userId=42'
  }]);
  assert.deepEqual(scopedMimoManagedAccounts(
    [{ accountKey: 'sha256:a', cookieHeader: CONSOLE_COOKIE }, { accountKey: 'sha256:b', cookieHeader: CONSOLE_COOKIE }],
    { provider: 'mimo', accountKey: 'sha256:b' }
  ).map((account) => account.accountKey), ['sha256:b']);
  assert.throws(
    () => scopedMimoManagedAccounts(
      [{ accountKey: 'sha256:a', cookieHeader: CONSOLE_COOKIE }, { accountKey: 'sha256:b', cookieHeader: CONSOLE_COOKIE }],
      { provider: 'mimo' }
    ),
    TypeError
  );
});

test('the detected session is listed beside stored accounts and dedupes an enabled matching account', () => {
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
  const rows = await fetchMimoLimits({}, world.deps);

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
  assert.equal(require('../../src/shared/limits/windowLabels').limitWindowLabel('mimo', membership.windows[0]), 'Weekly');
  assert.equal(membership.windows[0].resetsAt, '2026-09-15T00:00:00.000Z', 'the reset comes from nextResetTime, not monthly renewal');
  assert.equal(membership.windows[0].windowMinutes, null, 'the response carries no duration');
  assert.equal(membership.windows[0].usedPercent, 21.5, 'the app reports what is left, so the meter is inverted once');
  assert.deepEqual(world.mints(), { console: 1, membership: 1 }, 'each lane mints its own service session once');
});

test('a long profile name keeps its stable account suffix after normalization', async () => {
  for (const letter of ['A', '𠮷']) {
    const world = mimoWorld();
    const rows = await fetchMimoLimits({}, {
      ...world.deps,
      fetch: (url, init) => String(url).includes('/userProfile')
        ? reply(200, { code: 0, data: { userId: '42', nickName: letter.repeat(55) } })
        : world.fetch(url, init)
    });
    const names = normalizeLimitsSummary({ providers: rows }).providers.map((row) => row.accountName);
    assert.deepEqual(names, [letter.repeat(49) + ' MiMo 9c59f5a', letter.repeat(49) + ' MiMo 9c59f5a']);
  }
});

test('a pasted console cookie and the machine’s session share the account, not the row', async () => {
  const world = mimoWorld();
  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{ id: 'mimo-1', accountKey: mimoAccountKey('', { userId: '42' }), cookieHeader: CONSOLE_COOKIE }]
  }, world.deps);

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
    ...world.deps,
    providerRuntimeState
  };
  const rows = await fetchMimoLimits(options, deps);
  assert.deepEqual(rows.map((row) => row.accountLabel), ['Desktop Membership']);
  assert.equal(rows[0].accountKey, MEMBERSHIP_ACCOUNT_KEY_42);
  const listed = withDetectedMimoAccount(
    [{ id: 'mimo-1', accountKey: CONSOLE_ACCOUNT_KEY_42, enabled: false }],
    { id: 'mimo-local-session', accountKey: CONSOLE_ACCOUNT_KEY_42, enabled: true }
  );
  assert.deepEqual(listed.map(({ id, enabled, removable }) => ({ id, enabled, removable })), [
    { id: 'mimo-1', enabled: false, removable: true },
    { id: 'mimo-local-session', enabled: true, removable: false }
  ]);
  assert.equal(listed.filter((account) => account.enabled !== false).length, 1,
    'settings must count the Desktop membership that the provider still reports');
  assert.deepEqual(world.mints(), { console: 0, membership: 1 });
  const nextRows = await fetchMimoLimits(options, deps);
  assert.equal(nextRows.some((row) => row.removed), false, 'a disabled product is not tracked as an automatic row to remove every tick');
});

test('a saved account and a different Desktop account land beside each other', async () => {
  const world = mimoWorld({ balances: { '42': 9.96, '7': 7.51 } });
  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{ id: 'mimo-1', accountKey: mimoAccountKey('', { userId: '7' }), cookieHeader: 'api-platform_serviceToken=own; userId=7' }]
  }, world.deps);
  assert.deepEqual(
    rows.map((row) => row.accountKey).sort(),
    [
      CONSOLE_ACCOUNT_KEY_7,
      CONSOLE_ACCOUNT_KEY_42,
      MEMBERSHIP_ACCOUNT_KEY_42
    ].sort(),
    'the saved account, the Desktop account and that account’s membership'
  );
  assert.deepEqual(rows.map((row) => [row.accountKey, row.accountEmail, row.balance?.amount]), [
    [CONSOLE_ACCOUNT_KEY_7, 'user-7@example.com', 7.51],
    [CONSOLE_ACCOUNT_KEY_42, 'user@example.com', 9.96],
    [MEMBERSHIP_ACCOUNT_KEY_42, 'user@example.com', undefined]
  ]);
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
    ...mimoWorld().deps,
    readMimoDesktopAccount: () => {
      throw Object.assign(new Error('half'), { status: 'unauthorized', userId: '42' });
    }
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
  const previous = await fetchMimoLimits({}, mimoWorld().deps);

  const rows = await fetchMimoLimits({
    previousLimits: { providers: previous },
    mimoManagedAccounts: [{
      id: 'mimo-1',
      accountKey: mimoAccountKey('', { userId: '42' }),
      cookieHeader: CONSOLE_COOKIE
    }]
  }, {
    ...mimoWorld().deps,
    readMimoDesktopAccount: absentDesktop
  });

  assert.equal(rows.find((row) => row.accountLabel === 'Console')?.status, 'ok');
  assert.deepEqual(
    rows.filter((row) => row.removed).map((row) => row.accountKey),
    [mimoMembershipAccountKey('42')],
    'the runtime clears only the vanished automatic product'
  );
});

test('unavailable Desktop discovery retains accepted quotas without consuming logout or account switches', async (t) => {
  for (const capability of ['encrypted', 'no-sqlite']) {
    for (const saved of [false, true]) {
      await t.test(`${capability}, ${saved ? 'with' : 'without'} a saved Console`, async () => {
        let readDesktop = signedInDesktop();
        let rawRows;
        let now = Date.UTC(2026, 8, 24);
        const runtime = createLimitsRuntime({
          limitProviders: ['mimo'],
          mimoManagedAccounts: saved ? [{ id: 'saved', accountKey: CONSOLE_ACCOUNT_KEY_42, cookieHeader: CONSOLE_COOKIE }] : []
        }, {
          autoStart: false, autoRetry: false, cleanupGraceMs: 0,
          fetch: mimoWorld().fetch, now: () => now,
          readMimoDesktopAccount: () => readDesktop(),
          probeProvider: async (provider, options, context, deps) => {
            rawRows = await probeLimitProvider(provider, options, context, deps);
            return rawRows;
          }
        });
        try {
          await runtime.refresh({ provider: 'mimo' }, 'startup');
          const good = runtime.getSnapshot().providers.find(row => row.accountKey === MEMBERSHIP_ACCOUNT_KEY_42);
          assert.equal(good.status, 'ok');
          assert.equal(good.windows.length, 1);
          readDesktop = () => readMimoDesktopAccount({
            candidates: ['/x/Cookies'], fs: presentFile,
            sqlite: capability === 'no-sqlite' ? null : sqliteReturning([
              { name: 'userId', value: '42', encrypted_value: null },
              { name: 'passToken', value: '', encrypted_value: new Uint8Array([1]) }
            ])
          });
          await runtime.refresh({ provider: 'mimo' }, 'manual');
          assert.equal(rawRows.some(row => row.removed), false);
          const retained = runtime.getSnapshot().providers.find(row => row.accountKey === MEMBERSHIP_ACCOUNT_KEY_42);
          assert.ok(retained, 'a reader capability failure must not delete a healthy identity');
          assert.deepEqual(retained.windows, good.windows);
          assert.equal(retained.status, 'unavailable');
          if (saved) assert.equal(runtime.getSnapshot().providers.find(row => row.accountKey === CONSOLE_ACCOUNT_KEY_42).status, 'ok');

          readDesktop = signedInDesktop();
          // The shared runtime keeps transient failures behind its retry cooldown.
          now += 60_000;
          await runtime.refresh({ provider: 'mimo' }, 'manual');
          assert.equal(runtime.getSnapshot().providers.find(row => row.accountKey === MEMBERSHIP_ACCOUNT_KEY_42).status, 'ok');
          readDesktop = absentDesktop;
          await runtime.refresh({ provider: 'mimo' }, 'manual');
          assert.equal(runtime.getSnapshot().providers.some(row => row.accountKey === MEMBERSHIP_ACCOUNT_KEY_42), false);
          readDesktop = signedInDesktop('7');
          await runtime.refresh({ provider: 'mimo' }, 'manual');
          assert.equal(runtime.getSnapshot().providers.find(row => row.accountKey === MEMBERSHIP_ACCOUNT_KEY_7).status, 'ok');
          assert.equal(runtime.getSnapshot().providers.some(row => row.accountKey === MEMBERSHIP_ACCOUNT_KEY_42), false);
        } finally {
          runtime.stop();
        }
      });
    }
  }
});

test('a superseded Desktop removal is emitted again on the next committed refresh', { timeout: 7000 }, async () => {
  let readDesktop = signedInDesktop();
  let removalProbes = 0;
  // The gate hangs on the probe itself rather than on the removal it produces:
  // a regression that stops the removal from being emitted must fail the
  // assertions below, not stall this test until its timeout.
  let holdStaleProbe = false;
  const staleProbeStarted = deferred();
  const releaseStaleProbe = deferred();
  const runtime = createLimitsRuntime({
    limitProviders: ['mimo'],
    mimoManagedAccounts: [{ id: 'mimo-1', accountKey: CONSOLE_ACCOUNT_KEY_42, cookieHeader: CONSOLE_COOKIE }]
  }, {
    ...mimoWorld().deps,
    autoStart: false,
    cleanupGraceMs: 0,
    providerPhysicalBoundMs: () => 5_000,
    readMimoDesktopAccount: () => readDesktop(),
    probeProvider: async (provider, options, context, deps) => {
      const rows = await probeLimitProvider(provider, options, context, deps);
      if (rows.some((row) => row.removed)) removalProbes += 1;
      if (holdStaleProbe) {
        holdStaleProbe = false;
        staleProbeStarted.resolve();
        await releaseStaleProbe.promise;
      }
      return rows;
    }
  });

  try {
    await runtime.refresh({ provider: 'mimo' }, 'startup');
    assert.equal(runtime.getSnapshot().providers.some((row) => row.accountKey === MEMBERSHIP_ACCOUNT_KEY_42), true);

    readDesktop = absentDesktop;
    holdStaleProbe = true;
    const stale = runtime.refresh({ provider: 'mimo' }, 'manual');
    await staleProbeStarted.promise;
    const current = runtime.refresh({ provider: 'mimo' }, 'manual');
    releaseStaleProbe.resolve();
    assert.equal((await stale).superseded, true);
    await current;

    assert.equal(removalProbes, 2, 'the superseded probe must not consume the removal');
    assert.deepEqual(runtime.getSnapshot().providers.map((row) => row.accountKey), [CONSOLE_ACCOUNT_KEY_42]);
  } finally {
    releaseStaleProbe.resolve();
    runtime.stop();
  }
});

test('switching the Desktop account removes both automatic rows from the previous account', async () => {
  const previous = await fetchMimoLimits({}, mimoWorld({ balances: { '42': 9.96, '7': 7.51 } }).deps);

  const rows = await fetchMimoLimits({ previousLimits: { providers: previous } }, {
    ...mimoWorld({ balances: { '42': 9.96, '7': 7.51 } }).deps,
    readMimoDesktopAccount: signedInDesktop('7')
  });
  assert.deepEqual(rows.filter((row) => !row.removed).map((row) => row.accountKey), [
    CONSOLE_ACCOUNT_KEY_7,
    MEMBERSHIP_ACCOUNT_KEY_7
  ]);
  assert.deepEqual(new Set(rows.filter((row) => row.removed).map((row) => row.accountKey)), new Set([
    CONSOLE_ACCOUNT_KEY_42,
    MEMBERSHIP_ACCOUNT_KEY_42
  ]));
  const active = rows.filter((row) => !row.removed);
  assert.deepEqual(active.map((row) => row.accountEmail), ['user-7@example.com', 'user-7@example.com']);
  assert.equal(active[0].balance.amount, 7.51);
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
    ...mimoWorld().deps,
    readMimoDesktopAccount: absentDesktop,
    providerRuntimeState: new Map()
  });

  assert.equal(rows.some((row) => row.accountKey === consoleKey && !row.removed), true);
  assert.deepEqual(rows.filter((row) => row.removed).map((row) => row.accountKey), [membershipKey]);
});

test('an unattributed half sign-in prompts alone but never invents an account beside a pasted one', async () => {
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
    previousLimits: { providers: half },
    mimoManagedAccounts: [{
      id: 'mimo-1',
      accountKey: CONSOLE_ACCOUNT_KEY_42,
      cookieHeader: CONSOLE_COOKIE
    }]
  }, {
    ...mimoWorld().deps,
    readMimoDesktopAccount: () => { throw Object.assign(new Error('half'), { status: 'unauthorized' }); },
    providerRuntimeState
  });
  assert.deepEqual(alongsideManual.filter((row) => !row.removed).map((row) => [row.accountLabel, row.status]), [
    ['Console', 'ok']
  ], 'a Desktop session without userId cannot be counted as another account');
  assert.deepEqual(alongsideManual.filter((row) => row.removed).map((row) => row.accountKey), [half[0].accountKey],
    'the earlier unattributed status is removed on the next accepted refresh');

  const recovered = await fetchMimoLimits({
    previousLimits: { providers: alongsideManual.filter((row) => !row.removed) },
    mimoManagedAccounts: [{
      id: 'mimo-1',
      accountKey: CONSOLE_ACCOUNT_KEY_42,
      cookieHeader: CONSOLE_COOKIE
    }]
  }, {
    ...mimoWorld().deps,
    providerRuntimeState
  });
  assert.equal(recovered.filter((row) => row.removed).length, 0);
  assert.equal(recovered.some((row) => row.accountLabel === 'Desktop Membership'), true);

  const unreadable = await fetchMimoLimits({}, {
    fetch: async () => { throw new Error('no request should be spent'); },
    readMimoDesktopAccount: () => { throw Object.assign(new Error('locked'), { status: 'unavailable' }); },
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(unreadable.length, 1);
  assert.equal(unreadable[0].status, 'unavailable', 'the runtime can retain the previous good rows');
  assert.equal(unreadable[0].sourceDetail, 'app');
});

test('a refused account exchange rejects both product rows', async () => {
  const refused = await fetchMimoLimits({}, mimoWorld({ accountRefused: true }).deps);
  assert.equal(refused[0].status, 'unauthorized', 'the account cookie the service no longer takes ends on the login page');
  assert.equal(refused[0].accountKey, CONSOLE_ACCOUNT_KEY_42);

  assert.equal(refused.length, 2, 'each product retains its own failure row');
  assert.equal(refused[1].status, 'unauthorized');
  assert.equal(refused[1].accountKey, MEMBERSHIP_ACCOUNT_KEY_42);
});

test('the console spend rides the wallet, and losing it never costs the wallet', async () => {
  const world = mimoWorld({ totalCost: '32.85', monthCost: '9.30' });
  const rows = await fetchMimoLimits({}, world.deps);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].balance.monthSpend, 9.3);
  assert.equal(rows[0].balance.allTimeSpend, 32.85);
  assert.equal(rows[0].balance.amount, 9.96, 'the wallet itself is untouched');

  const degraded = await fetchMimoLimits({}, mimoWorld({ spendStatus: 500 }).deps);
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
    ...mimoWorld({
      tokenPlanDetail: {
        planCode: 'mimo-cn-pro',
        planStatus: 'active',
        currentPeriodEnd: '2026-10-01T00:00:00Z'
      },
      tokenPlanUsageStatus: 500
    }).deps,
    readMimoDesktopAccount: absentDesktop
  });

  assert.equal(rows[0].status, 'ok', 'the wallet and plan identity still answered');
  assert.equal(rows[0].planLabel, 'mimo-cn-pro');
  assert.equal(rows[0].windows.some((window) => window.label === 'Token Plan'), false, 'no quota meter is invented');
  assert.equal(rows[0].windows.some((window) => window.metric === 'credits'), true);
});

test('a console lane that fails leaves the membership standing', async () => {
  const world = mimoWorld({ consoleRefused: true });
  const rows = await fetchMimoLimits({}, world.deps);

  assert.equal(rows.length, 2, 'the product that answered is still a row of its own');
  assert.equal(rows[0].status, 'unauthorized', 'the console credential is the one the SSO refused');
  assert.equal(rows[0].accountKey, CONSOLE_ACCOUNT_KEY_42);
  assert.equal(rows[0].sourceDetail, 'app', 'and the row names the sign-in that fixes it');
  assert.equal(rows[1].status, 'ok', 'the membership is not the lane that failed');
  assert.equal(rows[1].accountKey, MEMBERSHIP_ACCOUNT_KEY_42);
  assert.equal(rows[1].windows.some((window) => window.kind === 'weekly'), true);
});

test('a membership payload the reader cannot use is an outage, not a refusal', async () => {
  const active = await fetchMimoLimits({}, mimoWorld().deps);
  for (const body of [{ code: 5 }, { code: 0 }, ...[null, [], 'bad'].map((data) => ({ code: 0, data }))]) {
    const rows = await fetchMimoLimits({ previousLimits: { providers: active } }, mimoWorld({ subscriptionBody: body }).deps);
    assert.equal(rows[0].status, 'ok', 'the wallet answers for itself');
    assert.equal(rows[1].status, 'unavailable', 'a malformed response is not a missing subscription');
    assert.equal(rows[1].windows.length, 0);
    assert.equal(rows.some((row) => row.removed), false, 'the last good membership remains eligible for retention');
  }
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

test('a stalled Desktop console exchange times out without discarding other rows', { timeout: 1000 }, async () => {
  const world = mimoWorld();
  let exchangeAborted = false;
  const fetch = (url, init) => {
    if (String(url) === `${CONSOLE_BASE}/userProfile` && init.headers?.Cookie?.includes('userId=7')) {
      return Promise.resolve(reply(200, { code: 0, data: { userId: '7' } }));
    }
    if (String(url) === `${CONSOLE_BASE}/balance` && !init.headers?.Cookie?.includes('api-platform_serviceToken=')) {
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          exchangeAborted = true;
          reject(init.signal.reason || new Error('aborted'));
        }, { once: true });
      });
    }
    return world.fetch(url, init);
  };
  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{
      id: 'mimo-7',
      accountKey: CONSOLE_ACCOUNT_KEY_7,
      cookieHeader: CONSOLE_COOKIE.replace('userId=42', 'userId=7')
    }]
  }, {
    fetch,
    readMimoDesktopAccount: signedInDesktop(),
    accountTimeoutMs: 5,
    now: () => Date.UTC(2026, 8, 24)
  });
  assert.equal(exchangeAborted, true, 'the stalled exchange receives the account timeout');
  assert.deepEqual(rows.map((row) => [row.accountKey, row.status]), [
    [CONSOLE_ACCOUNT_KEY_7, 'ok'],
    [CONSOLE_ACCOUNT_KEY_42, 'unavailable'],
    [MEMBERSHIP_ACCOUNT_KEY_42, 'ok']
  ]);
});

test('a membership the account does not have is not a row, and the wallet is untouched', async () => {
  const world = mimoWorld({ subscription: { code: 0, data: { current: null } } });
  const rows = await fetchMimoLimits({}, world.deps);
  // The console lane states the wallet and its plan; a membership with no
  // subscription is what the Token Plan with no plan is — nothing to show, so
  // nothing is drawn rather than an empty row carrying a product name.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].accountLabel, 'Console');
  assert.equal(rows[0].planLabel, 'Pay-as-you-go');
  assert.deepEqual(rows.filter((row) => row.accountLabel === 'Desktop Membership'), []);
});

test('a membership that ends clears the row it used to publish', async () => {
  const active = await fetchMimoLimits({}, mimoWorld().deps);
  const membership = active.find((row) => row.accountLabel === 'Desktop Membership');
  // `mimoWorld()` answers the membership with the vendor's full payload, which is
  // what makes this row an active plan rather than a refusal: `readMimoMembershipPlan`
  // rejects a `current` without `planCode` and `endTime`, and an `unavailable` row
  // would let this test pass while ending no membership at all.
  assert.equal(membership.status, 'ok', 'the row this test ends is an active membership');
  assert.deepEqual(membership.windows.map((window) => window.kind), ['weekly']);
  assert.equal(membership.windows[0].usedPercent, 21.5);

  const ended = await fetchMimoLimits({ previousLimits: { providers: active } }, mimoWorld({ subscription: { code: 0, data: { current: null } } }).deps);
  assert.deepEqual(ended.filter((row) => row.removed).map((row) => row.accountKey), [MEMBERSHIP_ACCOUNT_KEY_42],
    'the identity the ended subscription published is removed, not retained as a transient miss');
});

test('a console lane that answers alone still publishes the account', async () => {
  const world = mimoWorld({ region: 'EU' });
  const rows = await fetchMimoLimits({}, world.deps);
  assert.equal(rows.length, 1, 'a region the app does not carry silences the membership row, not the provider');
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].windows.some((window) => window.metric === 'credits'), true);
  assert.equal(
    rows[0].windows.some((window) => window.kind === 'weekly' && window.usedPercent === 21.5),
    false,
    'the membership quota is not merged into the console row'
  );
});

test('an absent region is not evidence of a foreign account', async () => {
  const world = mimoWorld({ region: '' });
  const rows = await fetchMimoLimits({}, world.deps);
  assert.equal(rows[1].status, 'ok', 'the endpoint is asked and answers for itself');
  assert.equal(rows[1].windows.some((window) => window.kind === 'weekly'), true);
});

test('a 200 without a balance is an outage, never a credential problem', async () => {
  const rows = await fetchMimoLimits({}, mimoWorld({ balance: null }).deps);
  assert.equal(rows[0].status, 'unavailable');
  assert.equal(rows[0].windows.some((window) => window.metric === 'credits'), false);
});

test('a scoped refresh spends only the account it names', async () => {
  const world = mimoWorld();
  const rows = await fetchMimoLimits({
    mimoManagedAccounts: [{ id: 'mimo-1', accountKey: mimoAccountKey('', { userId: '42' }), cookieHeader: CONSOLE_COOKIE }],
    limitRefreshScope: { provider: 'mimo', accountKey: mimoAccountKey('', { userId: '42' }) }
  }, {
    ...world.deps,
    readMimoDesktopAccount: absentDesktop
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
  }, consoleWorld.deps);
  // The runtime writes every row a scoped dispatch returns under the scope's own
  // identity, so answering with both would overwrite one row with the other.
  assert.deepEqual(rows.map((row) => row.accountKey), [accountKey]);
  assert.deepEqual(consoleWorld.mints(), { console: 0, membership: 0 }, 'the unselected membership lane does no work');

  const membershipWorld = mimoWorld();
  const membershipRows = await fetchMimoLimits({
    limitRefreshScope: { provider: 'mimo', accountKey: mimoMembershipAccountKey('42') }
  }, membershipWorld.deps);
  assert.deepEqual(membershipRows.map((row) => row.accountKey), [MEMBERSHIP_ACCOUNT_KEY_42]);
  assert.deepEqual(membershipWorld.mints(), { console: 0, membership: 1 }, 'the unselected console lane does no work');
});

test('a scoped membership refresh keeps the account identity learned by the full refresh', async () => {
  const providerRuntimeState = new Map();
  const fullRows = await fetchMimoLimits({}, {
    ...mimoWorld().deps,
    providerRuntimeState
  });
  assert.equal(fullRows[1].accountEmail, 'user@example.com');

  const scopedRows = await fetchMimoLimits({
    limitRefreshScope: { provider: 'mimo', accountKey: mimoMembershipAccountKey('42') }
  }, {
    ...mimoWorld().deps,
    providerRuntimeState
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
    // Preserve the measured User-Agent and the caller's cookie header.
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

test('exchange cookies obey path scope and expire before the callback and credential return', async (t) => {
  for (const sample of [
    { name: 'unrelated paths and partial directory prefixes are excluded', cookies: [
      'outside=drop; Path=/unrelated', 'partial=drop; Path=/api/user/xiaom',
      'exact=keep; Path=/api/user/xiaomi/me', 'directory=keep; Path=/api/user/', 'root=keep; Path=/'
    ], expected: 'exact=keep; directory=keep; root=keep' },
    { name: 'missing, empty and invalid paths use the issuing URL directory', issuePath: '/api/session/issue', callback: '/api/session/next', cookies: [
      'missing=keep', 'empty=keep; Path=', 'invalid=keep; Path=other', 'root=keep; Path=/'
    ], expected: 'missing=keep; empty=keep; invalid=keep; root=keep', returned: 'root=keep' },
    { name: 'the default path does not match a partial directory prefix', callback: '/apiary/next', cookies: [
      'missing=drop', 'invalid=drop; Path=other', 'root=keep; Path=/'
    ], expected: 'root=keep', returned: 'missing=drop; invalid=drop; root=keep' },
    { name: 'same-name paths coexist and deletion affects only its matching path', cookies: [
      'same=root; Path=/', 'same=nested; Path=/api/user', 'same=deleted; Path=/api/user; Max-Age=0'
    ], expected: 'same=root' },
    { name: 'longer cookie paths are sent before shorter paths', cookies: [
      'same=root; Path=/', 'same=nested; Path=/api/user'
    ], expected: 'same=nested; same=root' },
    { name: 'Max-Age zero and negative delete even with future Expires', cookies: [
      'zero=old; Path=/', 'negative=old; Path=/',
      'zero=drop; Path=/; Max-Age=0; Expires=Wed, 01 Jan 2031 00:00:00 GMT',
      'negative=drop; Path=/; Max-Age=-1; Expires=Wed, 01 Jan 2031 00:00:00 GMT'
    ], expected: '' },
    { name: 'Expires deletes an existing matching cookie', cookies: [
      'expired=old; Path=/', 'expired=drop; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    ], expected: '' },
    { name: 'positive Max-Age overrides past Expires', cookies: [
      'fresh=keep; Path=/; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    ], expected: 'fresh=keep' },
    { name: 'invalid expiry attributes leave a session cookie', cookies: [
      'session=keep; Path=/; Max-Age=invalid; Expires=invalid'
    ], expected: 'session=keep' },
    { name: 'Max-Age expires between receiving the cookie and sending the next hop', advance: 1000, cookies: [
      'expired=drop; Path=/; Max-Age=1'
    ], expected: '' },
    { name: 'expiry is checked again when credentials are returned', afterCallback: 1000, cookies: [
      'expired=sent; Path=/; Max-Age=1'
    ], expected: 'expired=sent', returned: '' }
  ]) {
    await t.test(sample.name, async () => {
      let now = Date.UTC(2026, 9, 3);
      let sent;
      let hop = 0;
      const callback = `https://mimo-server-cn.xiaomimimo.com${sample.callback || '/api/user/xiaomi/me'}`;
      const minted = await mintMimoServiceSession({
        baseUrl: MEMBERSHIP_BASE, entry: '/user/xiaomi/me', accountCookie: 'passToken=p; userId=42',
        deps: { now: () => now, fetch: async (url, init) => {
          hop += 1;
          if (hop === 1) return reply(302, '', { location: `${LOGIN_URL}?sid=mimopc` });
          if (hop === 2) return reply(302, '', { location: `https://mimo-server-cn.xiaomimimo.com${sample.issuePath || '/api/sts'}` });
          if (hop === 3) {
            const response = reply(307, '', { location: callback, 'set-cookie': sample.cookies });
            const get = response.headers.get;
            response.headers.get = (name) => {
              if (name === 'location') now += sample.advance || 0;
              return get(name);
            };
            return response;
          }
          assert.equal(String(url), callback);
          sent = String(init.headers.Cookie || '');
          now += sample.afterCallback || 0;
          return reply(200, { code: 0, data: { userId: '42' } });
        } }
      });
      assert.equal(minted.ok, true);
      assert.equal(sent, sample.expected);
      assert.equal(minted.cookieHeader, sample.returned ?? sample.expected);
    });
  }
});

test('vendor HTTP callbacks are upgraded before Cookie selection and never fall back to HTTP', async (t) => {
  for (const [product, index, sts, entry, token] of [
    ['Console', 0, CONSOLE_STS, `${CONSOLE_BASE}/balance`, 'api-platform_serviceToken'],
    ['Membership', 1, `${MEMBERSHIP_BASE}/sts`, `${MEMBERSHIP_BASE}/user/xiaomi/me`, 'serviceToken']
  ]) {
    for (const failHttps of [false, true]) {
      await t.test(`${product}: ${failHttps ? 'HTTPS failure retains the reading' : 'HTTPS success'}`, async () => {
        const world = mimoWorld();
        const callback = `${entry}?userId=42&sign=a%2Fb%2Bc`;
        const requested = [];
        let exerciseCallback = false;
        let callbackCookie;
        const runtime = createLimitsRuntime({ limitProviders: ['mimo'] }, {
          ...world.deps, autoStart: false, autoRetry: false, probe: true,
          fetch: async (url, init) => {
            const href = String(url);
            if (exerciseCallback) requested.push(href);
            if (exerciseCallback && href.startsWith(sts)) {
              return reply(307, '', {
                location: callback.replace('https:', 'http:'),
                'set-cookie': [
                  `${token}=sealed; Domain=.XIAOMIMIMO.COM; Path=/; Secure`, 'userId=42; Path=/; Secure',
                  'outside=drop; Domain=.example.com; Path=/'
                ]
              });
            }
            if (exerciseCallback && href === callback) {
              callbackCookie = String(init.headers.Cookie || '');
              if (failHttps) throw new Error('HTTPS connection failed');
            }
            return world.fetch(url, init);
          }
        });
        try {
          await runtime.refresh({ provider: 'mimo' }, 'startup');
          const good = runtime.getSnapshot().providers[index];
          assert.equal(good.status, 'ok');
          assert.ok(good.windows.length);
          exerciseCallback = true;
          await runtime.refresh({ provider: 'mimo' }, 'manual');
          assert.equal(requested.includes(callback), true, 'host, path and encoded query survive the upgrade');
          assert.equal(requested.every(url => new URL(url).protocol === 'https:'), true, 'no HTTP request is dispatched');
          assert.equal(callbackCookie, `${token}=sealed; userId=42`, 'Secure service Cookies are selected after upgrading; account and off-domain Cookies stay out');
          const rows = runtime.getSnapshot().providers;
          const refreshed = rows.find(row => row.accountKey === good.accountKey);
          assert.equal(refreshed.status, failHttps ? 'unavailable' : 'ok');
          assert.deepEqual(refreshed.windows, good.windows, 'a failed HTTPS exchange retains the accepted quota');
          assert.equal(rows.find(row => row.accountKey !== good.accountKey).status, 'ok', 'the other product keeps answering');
        } finally {
          runtime.stop();
        }
      });
    }
  }
});

test('an HTTP redirect to a login domain is still rejected without requesting it', async () => {
  const world = mimoWorld();
  let escaped = false;
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'account.xiaomi.com' && parsed.searchParams.get('sid') === 'mimopc') {
      return reply(302, '', { location: 'http://account.xiaomi.com/pass/serviceLogin?sid=mimopc' });
    }
    if (parsed.protocol === 'http:') escaped = true;
    return world.fetch(url, init);
  };
  const rows = await fetchMimoLimits({}, { ...world.deps, fetch, probe: true });
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

test('membership tier labels follow the app and INVITE keeps its quota without a plan name', async () => {
  assert.equal(mimoMembershipPlanLabel({ tier: 1 }), 'Starter');
  assert.equal(mimoMembershipPlanLabel({ tier: 2 }), 'Plus');
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
  assert.equal(mimoMembershipPlanLabel(null), '');

  const [, invited] = await fetchMimoLimits({}, mimoWorld({
    subscription: { code: 0, data: { current: { ...PLAN_BODY.data.current, source: 'INVITE' } } }
  }).deps);
  assert.equal(invited?.planLabel, '', 'an invited subscription hides its plan name');
  assert.deepEqual(invited.windows.map((window) => [window.kind, window.usedPercent]), [['weekly', 21.5]],
    'the quota remains published even without a plan name');
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
  const rows = await fetchMimoLimits({}, mimoWorld({ subscriptionStatus: 401 }).deps);
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
    if (href.split('?')[0] === `${MEMBERSHIP_BASE}/user/xiaomi/me` && /serviceToken=[^;]+/.test(String(init?.headers?.Cookie || ''))) {
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
    ...world.deps,
    readMimoDesktopAccount: absentDesktop
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

(sqlite ? test : test.skip)('the reader opens read-only and filters cookie names and domains', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-cookie-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'Cookies');
  const database = new sqlite.DatabaseSync(file);
  database.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)');
  const insert = database.prepare('INSERT INTO cookies VALUES (?, ?, ?, NULL)');
  insert.run('.account.xiaomi.com', 'passToken', 'p');
  insert.run('.account.xiaomi.com', 'userId', '42');
  insert.run('.account.xiaomi.com', 'cUserId', 'ignored');
  insert.run('.xiaomi.com', 'passToken', 'other');
  insert.run('.xiaomi.com', 'userId', '7');
  database.close();
  let readOnly = false;
  const read = readMimoDesktopAccount({
    candidates: [file],
    sqlite: { DatabaseSync: class {
      constructor(dbPath, options) {
        readOnly = options.readOnly;
        return new sqlite.DatabaseSync(dbPath, options);
      }
    } }
  });
  assert.equal(readOnly, true);
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

test('missing cookies are not configured, while unavailable reader capabilities are transient', () => {
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
    (error) => error.status === 'unavailable',
    'at-rest encryption is a property of the store, never a signed-out app'
  );
  assert.throws(
    () => readMimoDesktopAccount({
      candidates: ['/nonexistent/Cookies'],
      fs: { statSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } },
      sqlite: null
    }),
    (error) => error.status === 'notConfigured'
  );
  assert.throws(
    () => readMimoDesktopAccount({ platform: 'linux', home: '/home/u', sqlite: sqliteReturning([]) }),
    (error) => error.status === 'notConfigured'
  );
  assert.throws(
    () => readMimoDesktopAccount({ candidates: ['/x/Cookies'], fs: presentFile, sqlite: null }),
    (error) => error.status === 'unavailable',
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

test('today and week are the console total’s own deltas, and a drop only rebases', () => {
  const { recordMimoCumulativeSpend } = require('../../src/shared/providers/mimo/spendHistory');
  let store = null;
  const io = { readJson: () => store, writeJsonAtomic: (_path, next) => { store = next; } };
  // Days are local to the ledger, so these stamps are built in local time: a
  // UTC literal would land on a different local day at another offset (the
  // suite runs at several), splitting one day's bucket in two.
  const at = (dayOfMonth, hour) => new Date(2026, 8, dayOfMonth, hour).getTime();
  const call = (totalCost, at) => recordMimoCumulativeSpend({ accountKey: 'sha256:a', currency: 'CNY', totalCost, now: at, storePath: '/x/mimo-spend.json', ...io });

  const first = call(1.5, at(27, 6));
  assert.equal(first.todaySpend, 0, 'a first observation is a baseline, not a day of spending');
  assert.equal(first.weekSpend, 0);
  assert.equal(first.trackingSince, at(27, 6));

  const second = call(1.8, at(27, 7));
  assert.equal(second.todaySpend, 0.3);
  assert.equal(second.weekSpend, 0.3);
  assert.equal('monthSinceTracking' in second, false, 'the month is the console’s, so no tracking caveat belongs on it');

  const dropped = call(0.2, at(27, 8));
  assert.equal(dropped.todaySpend, 0.3, 'a refund moves the baseline without recording negative spend');
  const after = call(0.5, at(27, 9));
  assert.equal(after.todaySpend, 0.6);

  // The rolling seven days the other two providers keep: a bucket older than
  // that stays out of `weekSpend` while today's own bucket is counted. The
  // deltas here are +0.5 into the 17th and +0.5 into the 27th, on top of the
  // 0.6 the 27th already holds.
  const oldDay = call(1.0, at(17, 9));
  assert.equal(oldDay.todaySpend, 0.5, 'a delta lands on the day it was observed');
  const back = call(1.5, at(27, 10));
  assert.equal(back.todaySpend, 1.1, 'today counts only its own bucket');
  assert.equal(back.weekSpend, 1.1, 'the week is the last seven days, not everything the store keeps');
  assert.equal(back.trackingSince, first.trackingSince, 'the ledger states when observation began once, and that does not move');

  const beforeUnknown = JSON.stringify(store);
  for (const currency of ['', '  ', undefined]) {
    assert.equal(recordMimoCumulativeSpend({
      accountKey: 'sha256:a', currency, totalCost: 99, now: at(27, 11), storePath: '/x/mimo-spend.json', ...io
    }), null, 'an observation without a currency cannot change a money ledger');
    assert.equal(JSON.stringify(store), beforeUnknown);
  }

  // A ledger only compares like with like: switching the console's currency
  // rebases it rather than subtracting one currency's total from another's.
  const otherCurrency = recordMimoCumulativeSpend({
    accountKey: 'sha256:a', currency: 'USD', totalCost: 5, now: at(27, 11), storePath: '/x/mimo-spend.json', ...io
  });
  assert.equal(otherCurrency.todaySpend, 0, 'a currency change starts a new baseline');
  assert.equal(otherCurrency.trackingSince, at(27, 11));

  assert.equal(call(null, at(27, 10)), null, 'an omitted total is not a zero');
  assert.equal(call(undefined, at(27, 10)), null);
});

test('the console row states the console’s own month and all time beside a locally tracked day', async () => {
  let store = null;
  const io = { readJson: () => store, writeJsonAtomic: (_path, next) => { store = next; } };
  const options = {
    mimoManagedAccounts: [{
      id: 'mimo-1',
      accountKey: mimoAccountKey('', { userId: '42' }),
      cookieHeader: CONSOLE_COOKIE
    }]
  };
  const probeAt = (totalCost, hour) => ({
    fetch: mimoWorld({ totalCost }).fetch,
    readMimoDesktopAccount: absentDesktop,
    now: () => new Date(2026, 8, 27, hour).getTime(),
    mimoStorePath: '/x/mimo-spend.json',
    ...io
  });

  const first = await fetchMimoLimits(options, probeAt('1.50', 6));
  assert.equal(first[0].balance.allTimeSpend, 1.5, 'all time stays the console’s own figure');
  assert.equal(first[0].balance.monthSpend, 0.05, 'and so does the month');
  assert.equal(first[0].balance.todaySpend, 0);

  const second = await fetchMimoLimits(options, probeAt('1.80', 7));
  assert.equal(second[0].balance.todaySpend, 0.3, 'the day is what the total moved by');
  assert.equal(second[0].balance.weekSpend, 0.3);
  assert.equal(second[0].balance.monthSpend, 0.05, 'the local ledger never replaces the console’s month');
  assert.equal(second[0].balance.monthSinceTracking, false);
  assert.equal(typeof second[0].balance.trackingSince, 'string', 'the ledger states when it began observing');

  const probed = await fetchMimoLimits(options, { ...probeAt('9.00', 8), probe: true });
  assert.equal(probed[0].balance.todaySpend, null, 'a credential probe does not write history');
  const afterProbe = await fetchMimoLimits(options, probeAt('1.90', 9));
  assert.equal(afterProbe[0].balance.todaySpend, 0.4, 'and the baseline is the one the collector left');

  // The ledger is fed the currency the console states, not one of its own: a
  // change of currency rebases it instead of subtracting across currencies.
  const switched = await fetchMimoLimits(options, {
    ...probeAt('1.95', 10),
    fetch: mimoWorld({ totalCost: '1.95', currency: 'USD' }).fetch
  });
  assert.equal(switched[0].balance.currency, 'USD');
  assert.equal(switched[0].balance.todaySpend, 0, 'a currency change starts a new baseline');

});
