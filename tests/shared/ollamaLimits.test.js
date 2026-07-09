'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeOllamaCookieHeader,
  ollamaSessionCookie,
  extractSessionCookie,
  parseOllamaUsageHtml,
  fetchOllamaLimits
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

test('normalizes current, legacy, raw, and complete Ollama cookie headers', () => {
  assert.equal(normalizeOllamaCookieHeader('wos-session=current'), 'wos-session=current');
  assert.equal(normalizeOllamaCookieHeader('Cookie: aid=1; wos-session=current; cf_clearance=ok'), 'aid=1; wos-session=current; cf_clearance=ok');
  assert.equal(normalizeOllamaCookieHeader('__Secure-session=legacy'), '__Secure-session=legacy');
  const rawToken = `${'a'.repeat(80)}==`;
  assert.equal(normalizeOllamaCookieHeader(rawToken), `__Secure-session=${rawToken}`);
  assert.equal(extractSessionCookie('wos-session=current'), 'current');
});

test('requires an exact recognized cookie-pair boundary', () => {
  assert.equal(normalizeOllamaCookieHeader('foo__Secure-session=wrong; aid=1'), '');
  assert.equal(
    normalizeOllamaCookieHeader('foo__Secure-session=wrong; __Secure-session=right'),
    'foo__Secure-session=wrong; __Secure-session=right'
  );
  assert.equal(extractSessionCookie('foo__Secure-session=wrong; __Secure-session=right'), 'right');
});

test('ollamaSessionCookie prefers settings and supports env aliases', () => {
  assert.equal(ollamaSessionCookie({ OLLAMA_COOKIE: 'wos-session=env' }, { ollamaCookie: 'wos-session=settings' }), 'wos-session=settings');
  assert.equal(ollamaSessionCookie({ TOKEN_MONITOR_OLLAMA_COOKIE: 'raw' }), '__Secure-session=raw');
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
