'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeOllamaCookieHeader,
  ollamaSessionCookie,
  rememberOllamaValidation,
  parseOllamaUsageHtml,
  fetchOllamaLimits,
  normalizeOllamaManagedAccounts,
  createOllamaManagedAccount,
  scopedOllamaManagedAccounts
} = require('../../src/shared/ollamaLimits');
const { hashKey } = require('../../src/shared/hashKey');

const SETTINGS_HTML = `
<span>Cloud Usage</span><span>Pro</span>
<span id="header-email">USER@example.com</span>
<section aria-label="Session usage 14.5% used">
  <div style="width: 14.5%"></div>
  <div data-time="2026-07-09T08:00:00Z">Resets soon</div>
</section>
<section><span>Weekly usage</span><span>10.3% used</span>
  <div data-time="2026-07-13T00:00:00Z"></div>
</section>`;

function response(status, { location, html = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'location' ? (location || null) : null },
    text: async () => html
  };
}

test('normalizes recognized named Ollama cookies and rejects bare values', () => {
  assert.equal(normalizeOllamaCookieHeader('wos-session=current'), 'wos-session=current');
  assert.equal(normalizeOllamaCookieHeader('Cookie: aid=1; wos-session=current; cf_clearance=ok'), 'aid=1; wos-session=current; cf_clearance=ok');
  assert.equal(normalizeOllamaCookieHeader('__Secure-session=legacy'), '__Secure-session=legacy');
  const rawToken = `${'a'.repeat(80)}==`;
  assert.equal(normalizeOllamaCookieHeader(rawToken), '');
  assert.equal(normalizeOllamaCookieHeader('raw-token-without-name'), '');
});

test('requires an exact recognized cookie-pair boundary', () => {
  assert.equal(normalizeOllamaCookieHeader('foo__Secure-session=wrong; aid=1'), '');
  assert.equal(
    normalizeOllamaCookieHeader('foo__Secure-session=wrong; __Secure-session=right'),
    'foo__Secure-session=wrong; __Secure-session=right'
  );
});

test('ollamaSessionCookie prefers settings and supports env aliases', () => {
  assert.equal(ollamaSessionCookie({ OLLAMA_COOKIE: 'wos-session=env' }, { ollamaCookie: 'wos-session=settings' }), 'wos-session=settings');
  assert.equal(ollamaSessionCookie({ TOKEN_MONITOR_OLLAMA_COOKIE: '__Secure-session=legacy' }), '__Secure-session=legacy');
  assert.equal(ollamaSessionCookie({}), '');
});

test('parses account identity, plan, reset timestamps, and window durations', () => {
  const parsed = parseOllamaUsageHtml(SETTINGS_HTML);
  assert.equal(parsed.planName, 'Pro');
  assert.equal(parsed.accountEmail, 'user@example.com');
  assert.equal(parsed.session.usedPercent, 14.5);
  assert.equal(parsed.session.resetsAt, '2026-07-09T08:00:00.000Z');
  assert.equal(parsed.session.windowMinutes, 300);
  assert.equal(parsed.weekly.usedPercent, 10.3);
  assert.equal(parsed.weekly.windowMinutes, 10080);
});

test('parses reversed blocks plus Hourly and CSS-width fallbacks', () => {
  const parsed = parseOllamaUsageHtml(`
    <section>Weekly usage<div style="width: 80%"></div></section>
    <section>Hourly usage<span>25% used</span></section>
  `);
  assert.deepEqual(parsed.windows.map((window) => [window.kind, window.usedPercent]), [
    ['session', 25],
    ['weekly', 80]
  ]);
  assert.equal(parsed.session.windowMinutes, 60);
});

test('reuses a successful validation once without polling settings again', async () => {
  const cookie = 'wos-session=one-shot-cache';
  const validated = await fetchOllamaLimits({ ollamaCookie: cookie }, {
    env: {},
    bypassValidationCache: true,
    fetch: async () => response(200, { html: SETTINGS_HTML })
  });
  rememberOllamaValidation(cookie, validated, 1_000);

  let requests = 0;
  const cached = await fetchOllamaLimits({ ollamaCookie: cookie }, {
    env: {},
    now: () => 1_001,
    fetch: async () => { requests += 1; return response(500); }
  });
  assert.equal(cached.status, 'ok');
  assert.equal(requests, 0);

  const consumed = await fetchOllamaLimits({ ollamaCookie: cookie }, {
    env: {},
    now: () => 1_002,
    fetch: async () => { requests += 1; return response(500); }
  });
  assert.equal(consumed.status, 'unavailable');
  assert.equal(requests, 1);
});

test('a failed validation invalidates only the matching cached cookie', async () => {
  const firstCookie = 'wos-session=first-cache';
  const secondCookie = 'wos-session=second-cache';
  const validated = await fetchOllamaLimits({ ollamaCookie: firstCookie }, {
    env: {},
    bypassValidationCache: true,
    fetch: async () => response(200, { html: SETTINGS_HTML })
  });
  rememberOllamaValidation(firstCookie, validated, 1_000);

  let requests = 0;
  const otherCookie = await fetchOllamaLimits({ ollamaCookie: secondCookie }, {
    env: {},
    now: () => 1_001,
    fetch: async () => { requests += 1; return response(401); }
  });
  assert.equal(otherCookie.status, 'unauthorized');
  assert.equal(requests, 1);

  const preserved = await fetchOllamaLimits({ ollamaCookie: firstCookie }, {
    env: {},
    now: () => 1_002,
    fetch: async () => { requests += 1; return response(500); }
  });
  assert.equal(preserved.status, 'ok');
  assert.equal(requests, 1);

  rememberOllamaValidation(firstCookie, validated, 2_000);
  rememberOllamaValidation(firstCookie, { status: 'unauthorized' }, 2_001);
  const invalidated = await fetchOllamaLimits({ ollamaCookie: firstCookie }, {
    env: {},
    now: () => 2_002,
    fetch: async () => { requests += 1; return response(401); }
  });
  assert.equal(invalidated.status, 'unauthorized');
  assert.equal(requests, 2);
});

test('parses formatted closing tags and ignores repeated aria usage labels', () => {
  const parsed = parseOllamaUsageHtml(`
    <h2><span>Cloud usage</span><span class="badge">free</span
    ></h2>
    <h2 id="header-email">user@example.com</h2>
    <div>
      <span>Session usage</span><span>0% used</span>
      <div aria-label="Session usage 0% used"></div>
      <div class="local-time" data-time="2026-07-12T06:00:00Z">Resets in 2 hours.</div>
    </div>
    <div>
      <span>Weekly usage</span><span>0% used</span>
      <div aria-label="Weekly usage 0% used"></div>
      <div class="local-time" data-time="2026-07-13T00:00:00Z">Resets in 20 hours.</div>
    </div>
  `);

  assert.equal(parsed.planName, 'free');
  assert.equal(parsed.session.resetsAt, '2026-07-12T06:00:00.000Z');
  assert.equal(parsed.weekly.resetsAt, '2026-07-13T00:00:00.000Z');
});

test('fetches with current WorkOS cookies and uses email for stable identity', async () => {
  const requests = [];
  const provider = await fetchOllamaLimits({ ollamaCookie: 'wos-session=current; aid=1' }, {
    env: {},
    now: () => Date.parse('2026-07-09T00:00:00Z'),
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return response(200, { html: SETTINGS_HTML });
    }
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountEmail, 'user@example.com');
  assert.equal(provider.accountLabel, 'Pro');
  assert.equal(provider.accountKey, hashKey('ollama', 'user@example.com'));
  assert.equal(requests[0].init.headers.Cookie, 'wos-session=current; aid=1');
  assert.equal(requests[0].init.redirect, 'manual');
});

test('follows same-origin redirects while keeping cookies on HTTPS Ollama only', async () => {
  const requests = [];
  const provider = await fetchOllamaLimits({ ollamaCookie: 'wos-session=current' }, {
    env: {},
    fetch: async (url, init) => {
      requests.push({ url: String(url), cookie: init.headers.Cookie });
      return requests.length === 1
        ? response(307, { location: '/settings/' })
        : response(200, { html: SETTINGS_HTML });
    }
  });
  assert.equal(provider.status, 'ok');
  assert.deepEqual(requests.map((item) => item.cookie), ['wos-session=current', 'wos-session=current']);
});

test('classifies only real sign-in redirects as unauthorized', async () => {
  const signIn = await fetchOllamaLimits({ ollamaCookie: 'wos-session=expired' }, {
    env: {}, fetch: async () => response(302, { location: 'https://signin.ollama.com/start' })
  });
  const unrelated = await fetchOllamaLimits({ ollamaCookie: 'wos-session=current' }, {
    env: {}, fetch: async () => response(302, { location: 'https://example.com/' })
  });
  assert.equal(signIn.status, 'unauthorized');
  assert.equal(unrelated.status, 'unavailable');
});

test('classifies signed-out HTML, auth failures, throttling, and network errors', async () => {
  const cases = [
    [response(200, { html: '<form action="/signin"><input type="email"></form>' }), 'unauthorized'],
    [response(401), 'unauthorized'],
    [response(429), 'sourceRateLimited']
  ];
  for (const [result, expected] of cases) {
    const provider = await fetchOllamaLimits({ ollamaCookie: 'wos-session=value' }, { env: {}, fetch: async () => result });
    assert.equal(provider.status, expected);
  }
  const failed = await fetchOllamaLimits({ ollamaCookie: 'wos-session=value' }, {
    env: {}, fetch: async () => { throw new TypeError('network down'); }
  });
  assert.equal(failed.status, 'unavailable');
});

// ---------------------------------------------------------------------------
// normalizeOllamaManagedAccounts
// ---------------------------------------------------------------------------

test('normalizeOllamaManagedAccounts drops entries without id or accountKey', () => {
  const result = normalizeOllamaManagedAccounts([
    { id: 'a', accountKey: 'k1', enabled: true },
    { id: 'b' },
    { accountKey: 'k2' },
    null,
    42
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'a');
  assert.equal(result[0].accountKey, 'k1');
});

test('normalizeOllamaManagedAccounts deduplicates by accountKey, keeping first', () => {
  const result = normalizeOllamaManagedAccounts([
    { id: 'first', accountKey: 'same-key', accountEmail: 'a@example.com', enabled: true },
    { id: 'second', accountKey: 'same-key', accountEmail: 'b@example.com', enabled: true }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'first');
  assert.equal(result[0].accountEmail, 'a@example.com');
});

test('normalizeOllamaManagedAccounts defaults enabled to true and trims email', () => {
  const result = normalizeOllamaManagedAccounts([
    { id: 'x', accountKey: 'kx', accountEmail: '  user@example.com  ' }
  ]);
  assert.equal(result[0].enabled, true);
  assert.equal(result[0].accountEmail, 'user@example.com');
});

test('normalizeOllamaManagedAccounts treats non-array as empty', () => {
  assert.deepEqual(normalizeOllamaManagedAccounts(null), []);
  assert.deepEqual(normalizeOllamaManagedAccounts({}), []);
  assert.deepEqual(normalizeOllamaManagedAccounts(undefined), []);
});

// ---------------------------------------------------------------------------
// createOllamaManagedAccount
// ---------------------------------------------------------------------------

test('createOllamaManagedAccount returns ok:false for unrecognized cookie', () => {
  const result = createOllamaManagedAccount('bare-token-without-name');
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'missingRequiredCookies');
});

test('createOllamaManagedAccount returns ok:true with stable accountKey for valid cookie', () => {
  const cookie = 'wos-session=abc123';
  const result = createOllamaManagedAccount(cookie, []);
  assert.equal(result.ok, true);
  assert.ok(result.account.id);
  assert.ok(result.account.accountKey);
  assert.equal(result.account.enabled, true);
  // same cookie → same accountKey
  const result2 = createOllamaManagedAccount(cookie, []);
  assert.equal(result.account.accountKey, result2.account.accountKey);
});

test('createOllamaManagedAccount reuses id of existing account with same cookie', () => {
  const cookie = 'wos-session=reuse-me';
  const first = createOllamaManagedAccount(cookie, []);
  assert.equal(first.ok, true);
  const existing = [{ ...first.account }];
  const second = createOllamaManagedAccount(cookie, existing);
  assert.equal(second.ok, true);
  assert.equal(second.account.id, first.account.id);
});

// ---------------------------------------------------------------------------
// scopedOllamaManagedAccounts
// ---------------------------------------------------------------------------

test('scopedOllamaManagedAccounts returns all accounts when scope is empty', () => {
  const accounts = [
    { id: 'a', accountKey: 'k1', accountEmail: 'a@x.com', accountLabel: 'Pro', enabled: true, addedAt: '', updatedAt: '' },
    { id: 'b', accountKey: 'k2', accountEmail: 'b@x.com', accountLabel: 'Free', enabled: true, addedAt: '', updatedAt: '' }
  ];
  assert.equal(scopedOllamaManagedAccounts(accounts, {}).length, 2);
});

test('scopedOllamaManagedAccounts filters by accountKey', () => {
  const accounts = [
    { id: 'a', accountKey: 'k1', accountEmail: 'a@x.com', accountLabel: 'Pro', enabled: true, addedAt: '', updatedAt: '' },
    { id: 'b', accountKey: 'k2', accountEmail: 'b@x.com', accountLabel: 'Free', enabled: true, addedAt: '', updatedAt: '' }
  ];
  const result = scopedOllamaManagedAccounts(accounts, { accountKey: 'k2' });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'b');
});

test('scopedOllamaManagedAccounts filters by accountEmail case-insensitively', () => {
  const accounts = [
    { id: 'a', accountKey: 'k1', accountEmail: 'Alice@X.COM', accountLabel: '', enabled: true, addedAt: '', updatedAt: '' }
  ];
  const result = scopedOllamaManagedAccounts(accounts, { email: 'alice@x.com' });
  assert.equal(result.length, 1);
});

// ---------------------------------------------------------------------------
// fetchOllamaLimits — multi-account fan-out
// ---------------------------------------------------------------------------

test('fetchOllamaLimits fans out to all enabled managed accounts', async () => {
  const requests = [];
  const accounts = [
    { id: 'a1', accountKey: 'k1', accountEmail: '', accountLabel: '', cookieHeader: 'wos-session=s1', enabled: true, addedAt: '', updatedAt: '' },
    { id: 'a2', accountKey: 'k2', accountEmail: '', accountLabel: '', cookieHeader: 'wos-session=s2', enabled: true, addedAt: '', updatedAt: '' }
  ];
  const results = await fetchOllamaLimits({ ollamaManagedAccounts: accounts }, {
    fetch: async (url, init) => {
      requests.push(init.headers.Cookie);
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => SETTINGS_HTML };
    }
  });
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 2);
  assert.ok(requests.includes('wos-session=s1'));
  assert.ok(requests.includes('wos-session=s2'));
  assert.ok(results.every((r) => r.status === 'ok'));
});

test('fetchOllamaLimits skips disabled managed accounts', async () => {
  const accounts = [
    { id: 'a1', accountKey: 'k1', cookieHeader: 'wos-session=s1', enabled: true, accountEmail: '', accountLabel: '', addedAt: '', updatedAt: '' },
    { id: 'a2', accountKey: 'k2', cookieHeader: 'wos-session=s2', enabled: false, accountEmail: '', accountLabel: '', addedAt: '', updatedAt: '' }
  ];
  const results = await fetchOllamaLimits({ ollamaManagedAccounts: accounts }, {
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => SETTINGS_HTML })
  });
  assert.equal(results.length, 1);
  assert.ok(results[0].status === 'ok');
});

test('fetchOllamaLimits falls back to legacy single-cookie path when no managed accounts', async () => {
  const result = await fetchOllamaLimits({ ollamaCookie: 'wos-session=legacy' }, {
    env: {},
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => SETTINGS_HTML })
  });
  // legacy path returns a single provider object, not an array
  assert.ok(!Array.isArray(result));
  assert.equal(result.status, 'ok');
});

test('fetchOllamaLimits tags exactly one account as activeAccount when usage delta detected', async () => {
  // First call: establish baseline
  const baseline = [20, 10];
  const updated = [25, 10]; // first account usage went up
  let callCount = 0;
  function makeHtml(sessionPct) {
    return `<span>Cloud Usage</span><span>Pro</span>
<span id="header-email">user${callCount}@example.com</span>
<section aria-label="Session usage ${sessionPct}% used">
  <div style="width: ${sessionPct}%"></div>
  <div data-time="2026-07-09T08:00:00Z">Resets soon</div>
</section>`;
  }
  const cookiePcts = [baseline, updated];
  const accounts = [
    { id: 'a1', accountKey: 'ak1', cookieHeader: 'wos-session=s1', enabled: true, accountEmail: '', accountLabel: '', addedAt: '', updatedAt: '' },
    { id: 'a2', accountKey: 'ak2', cookieHeader: 'wos-session=s2', enabled: true, accountEmail: '', accountLabel: '', addedAt: '', updatedAt: '' }
  ];
  // First tick: establish baseline, bypassValidationCache not relevant here
  await fetchOllamaLimits({ ollamaManagedAccounts: accounts }, {
    fetch: async (_url, init) => {
      const idx = init.headers.Cookie === 'wos-session=s1' ? 0 : 1;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => makeHtml(cookiePcts[0][idx]) };
    }
  });
  // Second tick: first account usage went up
  const results = await fetchOllamaLimits({ ollamaManagedAccounts: accounts }, {
    fetch: async (_url, init) => {
      const idx = init.headers.Cookie === 'wos-session=s1' ? 0 : 1;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => makeHtml(cookiePcts[1][idx]) };
    }
  });
  const active = results.filter((r) => r.activeAccount);
  assert.equal(active.length, 1);
  assert.equal(results.find((r) => r.accountKey === 'ak1')?.activeAccount, true);
  assert.equal(results.find((r) => r.accountKey === 'ak2')?.activeAccount, false);
});
