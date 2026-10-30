'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeOllamaCookieHeader,
  ollamaSessionCookie,
  ollamaApiKey,
  rememberOllamaValidation,
  parseOllamaUsageHtml,
  parseOllamaBalance,
  fetchOllamaLimits
} = require('../../src/shared/providers/ollama/limits');
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


function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: Number(status),
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

const LEGACY_BALANCE = {
  included: {
    session: { remaining_percent: 85.61, resets_at: '2026-10-23T14:00:00Z' },
    weekly: { remaining_percent: 33.37, resets_at: '2026-10-26T00:00:00Z' }
  }
};

const CREDITS_BALANCE = {
  included: {
    balance_usd: 45,
    allowance_usd: 60,
    period: { from: '2026-10-08T08:00:00Z', until: '2026-11-08T08:00:00Z' }
  },
  purchased: { balance_usd: 12.5 }
};

test('ollamaApiKey prefers settings and supports env aliases', () => {
  assert.equal(ollamaApiKey({ OLLAMA_API_KEY: 'env-key' }, { ollamaApiKey: 'settings-key' }), 'settings-key');
  assert.equal(ollamaApiKey({ TOKEN_MONITOR_OLLAMA_API_KEY: 'tm-key' }), 'tm-key');
  assert.equal(ollamaApiKey({ OLLAMA_API_KEY: 'legacy-key' }), 'legacy-key');
  assert.equal(ollamaApiKey({}), '');
});

test('parses the legacy balance into used session and weekly windows', () => {
  const parsed = parseOllamaBalance(LEGACY_BALANCE);
  assert.deepEqual(parsed.windows.map((window) => [window.kind, window.usedPercent, window.windowMinutes]), [
    ['session', 14.39, 300],
    ['weekly', 66.63, 10080]
  ]);
  assert.equal(parsed.windows[0].resetsAt, '2026-10-23T14:00:00.000Z');
  assert.equal(parsed.windows[1].resetsAt, '2026-10-26T00:00:00.000Z');
});

test('parses new-plan included credits as one money window', () => {
  const parsed = parseOllamaBalance(CREDITS_BALANCE);
  assert.equal(parsed.windows.length, 3);
  assert.deepEqual({
    kind: parsed.windows[0].kind,
    metric: parsed.windows[0].metric,
    used: parsed.windows[0].used,
    limit: parsed.windows[0].limit,
    remaining: parsed.windows[0].remaining,
    currency: parsed.windows[0].currency,
    resetsAt: parsed.windows[0].resetsAt
  }, {
    kind: 'billing',
    metric: 'credits',
    used: 15,
    limit: 60,
    remaining: 45,
    currency: 'USD',
    resetsAt: '2026-11-08T08:00:00.000Z'
  });
  assert.equal(parseOllamaBalance({}), null);
  assert.equal(parseOllamaBalance({ included: { balance_usd: 1 } }), null);
  assert.equal(parseOllamaBalance({ included: { session: { remaining_percent: 'n/a' } } }), null);
  // Number(null) is 0, which must not read as an exhausted allowance.
  assert.equal(parseOllamaBalance({ included: { balance_usd: null, allowance_usd: 60 } }), null);
  assert.equal(parseOllamaBalance({ included: { balance_usd: '', allowance_usd: 60 } }), null);
  assert.equal(parseOllamaBalance({ included: { balance_usd: 45, allowance_usd: null } }), null);
});

test('fetches the API lane with a Bearer key and uses the account email for identity', async () => {
  const requests = [];
  const provider = await fetchOllamaLimits({ ollamaApiKey: 'ollama-key-identity' }, {
    env: {},
    now: () => Date.parse('2026-10-23T12:00:00Z'),
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith('/api/balance')) return jsonResponse(200, LEGACY_BALANCE);
      if (String(url).endsWith('/api/me')) return jsonResponse(200, { Email: 'User@Example.com', Plan: 'pro' });
      throw new Error(`unexpected url ${url}`);
    }
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'api');
  assert.equal(provider.accountEmail, 'user@example.com');
  assert.equal(provider.accountLabel, 'pro');
  assert.equal(provider.accountKey, hashKey('ollama', 'user@example.com'));
  assert.deepEqual(provider.windows.map((window) => [window.kind, window.usedPercent]), [['session', 14.39], ['weekly', 66.63]]);
  assert.equal(requests[0].url, 'https://ollama.com/api/balance');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer ollama-key-identity');
  assert.equal(requests[1].url, 'https://ollama.com/api/me');
  assert.equal(requests[1].init.method, 'POST');
  assert.equal(requests[1].init.headers.Authorization, 'Bearer ollama-key-identity');
});

test('the API lane wins when both credentials are configured', async () => {
  const requests = [];
  const provider = await fetchOllamaLimits({
    ollamaApiKey: 'ollama-key-precedence',
    ollamaCookie: 'wos-session=cookie-lane'
  }, {
    env: {},
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith('/api/balance')) return jsonResponse(200, LEGACY_BALANCE);
      return jsonResponse(200, { Email: 'both@example.com', Plan: 'max' });
    }
  });
  assert.equal(provider.source, 'api');
  assert.ok(requests.every((request) => !request.url.includes('/settings')), 'cookie lane must not be polled');
  assert.equal(requests.some((request) => request.init.headers && request.init.headers.Cookie), false);
});

test('maps API failures to provider statuses without falling back to the cookie lane', async () => {
  const cases = [
    [jsonResponse(401, { error: 'invalid credentials' }), 'unauthorized'],
    [jsonResponse(403, { error: 'forbidden' }), 'unauthorized'],
    [jsonResponse(429, { error: 'too many requests' }), 'sourceRateLimited'],
    [jsonResponse(404, { error: 'not found' }), 'unavailable'],
    [jsonResponse(500, { error: 'boom' }), 'unavailable']
  ];
  for (const [result, expected] of cases) {
    const provider = await fetchOllamaLimits({ ollamaApiKey: `fail-${expected}`, ollamaCookie: 'wos-session=x' }, {
      env: {},
      fetch: async () => result
    });
    assert.equal(provider.status, expected);
    assert.equal(provider.source, 'api');
    assert.equal(provider.provider, 'ollama');
  }
  const malformed = await fetchOllamaLimits({ ollamaApiKey: 'fail-json' }, {
    env: {},
    fetch: async (url) => String(url).endsWith('/api/me')
      ? jsonResponse(200, {})
      : { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('bad'); } }
  });
  assert.equal(malformed.status, 'unavailable');
  const network = await fetchOllamaLimits({ ollamaApiKey: 'fail-network' }, {
    env: {},
    fetch: async () => { throw new TypeError('network down'); }
  });
  assert.equal(network.status, 'unavailable');
  assert.equal(network.source, 'api');
});

test('caches the account identity instead of asking /api/me on every poll', async () => {
  const requests = [];
  const fetchFn = async (url) => {
    requests.push(String(url));
    return String(url).endsWith('/api/balance')
      ? jsonResponse(200, LEGACY_BALANCE)
      : jsonResponse(200, { Email: 'cached@example.com', Plan: 'pro' });
  };
  const first = await fetchOllamaLimits({ ollamaApiKey: 'ollama-key-cache' }, { env: {}, now: () => 1_000, fetch: fetchFn });
  assert.equal(first.accountKey, hashKey('ollama', 'cached@example.com'));
  assert.deepEqual(requests, ['https://ollama.com/api/balance', 'https://ollama.com/api/me']);
  requests.length = 0;
  const second = await fetchOllamaLimits({ ollamaApiKey: 'ollama-key-cache' }, { env: {}, now: () => 2_000, fetch: fetchFn });
  assert.equal(second.accountKey, first.accountKey);
  assert.deepEqual(requests, ['https://ollama.com/api/balance']);
});

test('falls back to a key identity and removes it once the identity resolves', async () => {
  const key = 'ollama-key-fallback';
  const fallbackKey = hashKey('ollama', `api-key:${key}`);
  let meBroken = true;
  const fetchFn = async (url) => {
    if (String(url).endsWith('/api/balance')) return jsonResponse(200, LEGACY_BALANCE);
    if (meBroken) return jsonResponse(500, { error: 'boom' });
    return jsonResponse(200, { Email: 'late@example.com', Plan: 'pro' });
  };
  const first = await fetchOllamaLimits({ ollamaApiKey: key }, { env: {}, now: () => 10_000, fetch: fetchFn });
  assert.equal(first.accountKey, fallbackKey);
  assert.equal(first.accountEmail, '');
  meBroken = false;
  const second = await fetchOllamaLimits({ ollamaApiKey: key, previousLimits: { providers: [first] } }, { env: {}, now: () => 10_000 + 5 * 60 * 1000 + 1, fetch: fetchFn });
  assert.ok(Array.isArray(second));
  assert.equal(second[0].accountKey, hashKey('ollama', 'late@example.com'));
  assert.deepEqual(second[1], { provider: 'ollama', accountKey: fallbackKey, removed: true });
  const retried = await fetchOllamaLimits({ ollamaApiKey: key, previousLimits: { providers: [first] } }, { env: {}, now: () => 10_000 + 5 * 60 * 1000 + 1, fetch: fetchFn });
  assert.deepEqual(retried, second, 'a discarded replacement must not consume the accepted identity removal');
  const accepted = await fetchOllamaLimits({ ollamaApiKey: key, previousLimits: { providers: [second[0]] } }, { env: {}, now: () => 10_000 + 5 * 60 * 1000 + 1, fetch: fetchFn });
  assert.equal(Array.isArray(accepted), false, 'an accepted replacement needs no further removal');
});

test('reads lowercase identity fields from the identity endpoint', async () => {
  const provider = await fetchOllamaLimits({ ollamaApiKey: 'ollama-key-lowercase' }, {
    env: {},
    fetch: async (url) => String(url).endsWith('/api/balance')
      ? jsonResponse(200, LEGACY_BALANCE)
      : jsonResponse(200, { email: 'lower@example.com', plan: 'max' })
  });
  assert.equal(provider.accountKey, hashKey('ollama', 'lower@example.com'));
  assert.equal(provider.accountEmail, 'lower@example.com');
  assert.equal(provider.accountLabel, 'max');
});

test('a failed identity lookup is not retried on every poll', async () => {
  const key = 'ollama-key-negative-cache';
  let identityRequests = 0;
  const requests = [];
  const fetchFn = async (url) => {
    requests.push(String(url));
    if (String(url).endsWith('/api/balance')) return jsonResponse(200, LEGACY_BALANCE);
    identityRequests += 1;
    return jsonResponse(500, { error: 'boom' });
  };
  const first = await fetchOllamaLimits({ ollamaApiKey: key }, { env: {}, now: () => 1_000, fetch: fetchFn });
  assert.equal(first.accountKey, hashKey('ollama', `api-key:${key}`));
  assert.equal(identityRequests, 1);

  requests.length = 0;
  const second = await fetchOllamaLimits({ ollamaApiKey: key }, { env: {}, now: () => 2_000, fetch: fetchFn });
  assert.equal(identityRequests, 1, 'the failure cache must suppress the repeat lookup');
  assert.deepEqual(requests, ['https://ollama.com/api/balance']);
  assert.equal(second.accountKey, first.accountKey);

  const retried = await fetchOllamaLimits({ ollamaApiKey: key }, {
    env: {},
    now: () => 2_000 + 5 * 60 * 1000,
    fetch: fetchFn
  });
  assert.equal(identityRequests, 2, 'the lookup is retried once the failure window lapses');
  assert.equal(retried.accountKey, first.accountKey);
});

test('a save probe checks only the key and leaves identity to the next poll', async () => {
  const key = 'ollama-key-probe-isolation';
  const probeRequests = [];
  const probeFetch = async (url) => {
    probeRequests.push(String(url));
    return jsonResponse(200, LEGACY_BALANCE);
  };
  const probe = await fetchOllamaLimits({ ollamaApiKey: key }, { env: {}, probe: true, fetch: probeFetch });
  assert.equal(probe.status, 'ok');
  assert.deepEqual(probeRequests, ['https://ollama.com/api/balance']);
  assert.equal(probe.accountKey, hashKey('ollama', `api-key:${key}`));

  const failingFetch = async (url) => String(url).endsWith('/api/balance')
    ? jsonResponse(200, LEGACY_BALANCE)
    : jsonResponse(500, { error: 'boom' });
  const fallback = await fetchOllamaLimits({ ollamaApiKey: key }, { env: {}, now: () => 10_000, fetch: failingFetch });
  assert.equal(fallback.accountKey, hashKey('ollama', `api-key:${key}`), 'probe result must not be cached');

  const resolvingFetch = async (url) => String(url).endsWith('/api/balance')
    ? jsonResponse(200, LEGACY_BALANCE)
    : jsonResponse(200, { Email: 'probe@example.com', Plan: 'pro' });
  const resolved = await fetchOllamaLimits({ ollamaApiKey: key, previousLimits: { providers: [fallback] } }, {
    env: {},
    now: () => 10_000 + 5 * 60 * 1000 + 1,
    fetch: resolvingFetch
  });
  assert.ok(Array.isArray(resolved));
  assert.equal(resolved[0].accountKey, hashKey('ollama', 'probe@example.com'));
  assert.deepEqual(resolved[1], { provider: 'ollama', accountKey: hashKey('ollama', `api-key:${key}`), removed: true });
});

test('retires the resolved identity when a later lookup falls back to the key', async () => {
  const key = 'ollama-key-identity-fallback';
  let lookupWorks = true;
  const fetchFn = async (url) => {
    if (String(url).endsWith('/api/balance')) return jsonResponse(200, LEGACY_BALANCE);
    return lookupWorks
      ? jsonResponse(200, { Email: 'flip@example.com', Plan: 'pro' })
      : jsonResponse(500, { error: 'boom' });
  };
  const first = await fetchOllamaLimits({ ollamaApiKey: key }, { env: {}, now: () => 1_000, fetch: fetchFn });
  assert.equal(first.accountKey, hashKey('ollama', 'flip@example.com'));

  lookupWorks = false;
  const second = await fetchOllamaLimits({ ollamaApiKey: key, previousLimits: { providers: [first] } }, {
    env: {},
    now: () => 1_000 + 6 * 60 * 60 * 1000 + 1,
    fetch: fetchFn
  });
  assert.ok(Array.isArray(second), 'the identity change must carry a removal row');
  assert.equal(second[0].accountKey, hashKey('ollama', `api-key:${key}`));
  assert.deepEqual(second[1], {
    provider: 'ollama',
    accountKey: hashKey('ollama', 'flip@example.com'),
    removed: true
  });
});

test('keeps the historical cookie-pair identity when the page has no email', async () => {
  const html = '<section aria-label="Session usage 10% used"><div style="width: 10%"></div></section>';
  const provider = await fetchOllamaLimits({ ollamaCookie: 'wos-session=a; __Secure-session=b' }, {
    env: {},
    fetch: async () => response(200, { html })
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountKey, hashKey('ollama', 'wos-session=a;__Secure-session=b'));
});

test('an API-lane probe never seeds the cookie validation cache', async () => {
  const provider = await fetchOllamaLimits({ ollamaApiKey: 'ollama-key-probe' }, {
    env: {},
    bypassValidationCache: true,
    fetch: async (url) => String(url).endsWith('/api/balance')
      ? jsonResponse(200, LEGACY_BALANCE)
      : jsonResponse(200, { Email: 'probe@example.com', Plan: 'pro' })
  });
  assert.equal(provider.status, 'ok');
  rememberOllamaValidation('wos-session=must-not-cache', provider, 1_000);
  let requests = 0;
  const after = await fetchOllamaLimits({ ollamaCookie: 'wos-session=must-not-cache' }, {
    env: {},
    now: () => 1_001,
    fetch: async () => { requests += 1; return response(500); }
  });
  assert.equal(after.status, 'unavailable');
  assert.equal(requests, 1);
});

test('maps the new-plan balance to a credits window on the wire', async () => {
  const provider = await fetchOllamaLimits({ ollamaApiKey: 'ollama-key-credits' }, {
    env: {},
    fetch: async (url) => String(url).endsWith('/api/balance')
      ? jsonResponse(200, CREDITS_BALANCE)
      : jsonResponse(200, { Email: 'credits@example.com', Plan: 'pro' })
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.windows.length, 3);
  assert.equal(provider.windows[0].kind, 'billing');
  assert.equal(provider.windows[0].metric, 'credits');
  assert.equal(provider.windows[0].remaining, 45);
  assert.equal(provider.windows[0].limit, 60);
  assert.equal(provider.windows[0].usedPercent, 25);
  assert.equal(provider.windows[0].resetsAt, '2026-11-08T08:00:00.000Z');
});
