'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchTypesafeLimits, typesafeCookie, parseUsage, resetBillingCache } = require('../../src/shared/providers/typesafe/limits');

const actionId = 'a'.repeat(40);
const now = Date.parse('2026-09-23T12:00:00Z');

function mockFetch({ billing = { balance: 5, spent: 0, plan: 'free_plan', resetsInDays: 7 }, chunk = `"${actionId}","getBillingOverviewResult"`, usage = {
  buckets: [{ day: '2026-09-21T05:00:00+00:00', inputTokens: 1888, outputTokens: 249, requests: 6 }]
}, usageStatus = 200, staleOnce = false } = {}) {
  const calls = [];
  let stale = staleOnce;
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.ok(url.startsWith('https://console.typesafe.ai/'));
    assert.equal(options.headers.Cookie, 'session=secret');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    if (url.includes('/api/usage')) return new Response(JSON.stringify(usage), { status: usageStatus });
    if (url.endsWith('/chunk.js')) return new Response(chunk);
    if (options.method === 'POST') {
      assert.equal(options.headers['Next-Action'], actionId);
      assert.equal(options.body, '[]');
      if (stale) {
        stale = false;
        return new Response('', { status: 404, headers: { 'x-nextjs-action-not-found': '1' } });
      }
      return new Response(`0:${JSON.stringify({ ok: true, data: { billing } })}\n`, { headers: { 'Content-Type': 'text/x-component' } });
    }
    return new Response('<html><script src="/_next/chunk.js"></script></html>');
  };
  return { fetch, calls };
}

test('TypeSafe cookie accepts a full header and rejects malformed values', () => {
  assert.equal(typesafeCookie({}, { typesafeCookie: 'Cookie: session=secret; second=ok' }), 'session=secret; second=ok');
  // An empty value is a legal cookie pair (`name=`); it must not void the header.
  assert.equal(typesafeCookie({}, { typesafeCookie: 'session=secret; preference=' }), 'session=secret; preference=');
  assert.equal(typesafeCookie({}, { typesafeCookie: 'session=secret; ' }), 'session=secret');
  assert.equal(typesafeCookie({}, { typesafeCookie: 'session=secret; invalid' }), '');
  assert.equal(typesafeCookie({}, { typesafeCookie: 'session=secret\nHost: evil' }), '');
  assert.equal(typesafeCookie({}, { typesafeCookie: 'Bearer secret' }), '');
});

test('TypeSafe balance and usage remain distinct while token spend stays precise', async () => {
  const transport = mockFetch({ usage: { buckets: [
    { day: '2026-09-21T05:00:00+00:00', inputTokens: 1888, outputTokens: 249, requests: 6 },
    { day: '2026-09-05T05:00:00+00:00', inputTokens: 1000, outputTokens: 10, requests: 2 },
    { day: '2026-08-30T05:00:00+00:00', inputTokens: 5000, outputTokens: 50, requests: 9 }
  ] } });
  const provider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...transport, now: () => now });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'Free');
  assert.equal(provider.windows[0].metric, 'credits');
  assert.equal(provider.windows[0].remaining, 5);
  assert.equal(provider.windows[0].showMeter, true);
  // Billing resetsInDays does not identify when the visible credit grant expires.
  assert.equal(provider.windows[0].resetsAt, null);
  assert.equal(provider.balance.weekSpend, null);
  assert.equal(provider.usageSummary.period, 'month');
  assert.equal(provider.usageSummary.todayTokens, 0);
  assert.equal(provider.usageSummary.weekTokens, 2137);
  assert.equal(provider.usageSummary.totalTokens, 3147);
  assert.equal(provider.usageSummary.inputTokens, 2888);
  assert.equal(provider.usageSummary.outputTokens, 259);
  assert.equal(provider.usageSummary.requests, 8);
  assert.equal(provider.usageSummary.standardCost, (1888 + 1000) * 0.042 / 1_000_000);
  // The credits meter derives from balance vs this month's estimated spend:
  // both September buckets count, August's does not.
  assert.equal(provider.balance.monthSpend, (1888 + 1000) * 0.042 / 1_000_000);
  assert.equal(provider.balance.allTimeSpend, null);
  assert.ok(transport.calls.some(({ options }) => options.method === 'POST'));
});

test('TypeSafe usage failures do not invent a measured zero', async () => {
  const transport = mockFetch({ usageStatus: 401 });
  const provider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...transport, now: () => now });
  assert.equal(provider.status, 'unauthorized');
  assert.deepEqual(provider.windows, []);
  assert.equal(provider.balance, null);
});

test('TypeSafe rejects malformed usage buckets', () => {
  assert.throws(() => parseUsage({ buckets: [{ day: '2026-09-21T05:00:00+00:00', inputTokens: '1888', outputTokens: 249, requests: 6 }] }, now));
});

test('TypeSafe keeps only active credit grants with real expiry dates', async () => {
  const transport = mockFetch({ billing: { balance: 7, plan: 'free_plan', resetsInDays: 7, credits: [
    { amount: 5, remaining: 2, expiresAt: '2026-10-21T00:00:00Z' },
    { amount: 5, remaining: 0, expiresAt: '2026-10-01T00:00:00Z' },
    { amount: 3, remaining: 1, expiresAt: '2026-10-01T00:00:00Z' },
    { amount: 5, remaining: 3, expiresAt: '2026-09-22T00:00:00Z' },
    { amount: 1, remaining: 1, expiresAt: 'invalid' }
  ] } });
  const provider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...transport, now: () => now });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.windows[0].resetsAt, '2026-10-01T00:00:00.000Z');
  assert.equal(provider.windows[0].boundaryKind, 'expiry');
  assert.deepEqual(provider.balance.tranches, [
    { amount: 1, currency: 'USD', expiresAt: '2026-10-01T00:00:00.000Z' },
    { amount: 2, currency: 'USD', expiresAt: '2026-10-21T00:00:00.000Z' }
  ]);
});

test('TypeSafe rediscovers a stale billing action once', async () => {
  const transport = mockFetch({ staleOnce: true });
  const provider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...transport, now: () => now });
  assert.equal(provider.status, 'ok');
  assert.equal(transport.calls.filter(({ options }) => options.method === 'POST').length, 2);
  assert.ok(transport.calls.some(({ url }) => url.endsWith('/chunk.js')));
});

test('TypeSafe resolves the bundle rate constants and falls back when absent', async () => {
  resetBillingCache();
  const rated = mockFetch({
    chunk: `let gt=.05/1e6;t.s(["INPUT_TOKEN_COST_USD",0,gt,"OUTPUT_TOKEN_COST_USD",0,0]);"${actionId}","getBillingOverviewResult"`
  });
  const provider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...rated, now: () => now });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.usageSummary.standardCost, 1888 * 0.05 / 1_000_000);

  // Literal rates ship as plain decimals or exponents; a narrow capture used to
  // truncate them at the first "." or "e" and silently zero the estimate.
  resetBillingCache();
  const literal = mockFetch({
    chunk: `t.s(["INPUT_TOKEN_COST_USD",0,0.000000042]);"${actionId}","getBillingOverviewResult"`
  });
  const literalProvider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...literal, now: () => now });
  assert.equal(literalProvider.usageSummary.standardCost, 1888 * 0.000000042);

  resetBillingCache();
  const exponent = mockFetch({
    chunk: `t.s(["INPUT_TOKEN_COST_USD",0,4.2e-8]);"${actionId}","getBillingOverviewResult"`
  });
  const exponentProvider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...exponent, now: () => now });
  assert.equal(exponentProvider.usageSummary.standardCost, 1888 * 4.2e-8);

  resetBillingCache();
  const reusedVariable = mockFetch({
    chunk: `gt=1;gt=.042/1e6;t.s(["INPUT_TOKEN_COST_USD",0,gt]);gt=2;"${actionId}","getBillingOverviewResult"`
  });
  const reusedProvider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...reusedVariable, now: () => now });
  assert.equal(reusedProvider.usageSummary.standardCost, 1888 * 0.042 / 1_000_000);

  resetBillingCache();
  const invalidDivisor = mockFetch({
    chunk: `gt=.05/1e6;gt=1/0;t.s(["INPUT_TOKEN_COST_USD",0,gt]);"${actionId}","getBillingOverviewResult"`
  });
  const invalidProvider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...invalidDivisor, now: () => now });
  assert.equal(invalidProvider.usageSummary.standardCost, 1888 * 0.042 / 1_000_000);

  // The nearest textual assignment can belong to a nested scope. Reject its
  // implausible rate rather than caching it in place of the outer variable.
  resetBillingCache();
  const nestedScope = mockFetch({
    chunk: `let gt=.05/1e6;(()=>{let gt=1})();t.s(["INPUT_TOKEN_COST_USD",0,gt]);"${actionId}","getBillingOverviewResult"`
  });
  const nestedProvider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...nestedScope, now: () => now });
  assert.equal(nestedProvider.usageSummary.standardCost, 1888 * 0.042 / 1_000_000);

  resetBillingCache();
  const negativeRate = mockFetch({
    chunk: `gt=-1/1e6;t.s(["INPUT_TOKEN_COST_USD",0,gt]);"${actionId}","getBillingOverviewResult"`
  });
  const negativeProvider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...negativeRate, now: () => now });
  assert.equal(negativeProvider.usageSummary.standardCost, 1888 * 0.042 / 1_000_000);

  resetBillingCache();
  const implausibleLiteral = mockFetch({
    chunk: `t.s(["INPUT_TOKEN_COST_USD",0,1]);"${actionId}","getBillingOverviewResult"`
  });
  const literalFallbackProvider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...implausibleLiteral, now: () => now });
  assert.equal(literalFallbackProvider.usageSummary.standardCost, 1888 * 0.042 / 1_000_000);

  resetBillingCache();
  const fallback = mockFetch();
  const fallbackProvider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...fallback, now: () => now });
  assert.equal(fallbackProvider.usageSummary.standardCost, 1888 * 0.042 / 1_000_000);
});

test('TypeSafe prettifies the plan label', async () => {
  const transport = mockFetch({ billing: { balance: 25, spent: 3, plan: 'pro_plan' } });
 const provider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...transport, now: () => now });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'Pro');
  assert.equal(provider.windows[0].resetsAt, null);
});

test('TypeSafe requests carry the browser client hints Cloudflare requires', async () => {
  resetBillingCache();
  const transport = mockFetch();
  const provider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { ...transport, now: () => now });
  assert.equal(provider.status, 'ok');
  for (const { options } of transport.calls) {
    assert.ok(options.headers['sec-ch-ua'], 'client hints missing');
    assert.equal(options.headers['sec-ch-ua-mobile'], '?0');
    assert.ok(options.headers['sec-ch-ua-platform']);
    assert.ok(options.headers['Accept-Language']);
  }
});

test('TypeSafe reports a Cloudflare challenge as unavailable, not expired', async () => {
  resetBillingCache();
  const challenge = (headers = {}) => async () => new Response(
    '<html><title>Just a moment...</title>challenge-platform</html>',
    { status: 403, headers: { server: 'cloudflare', ...headers } }
  );
  let provider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, { fetch: challenge(), now: () => now });
  assert.equal(provider.status, 'unavailable');

  provider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, {
    fetch: challenge({ 'cf-mitigated': 'challenge' }),
    now: () => now
  });
  assert.equal(provider.status, 'unavailable');

  // A plain non-Cloudflare 403 is still a dead session.
  provider = await fetchTypesafeLimits({ typesafeCookie: 'session=secret' }, {
    fetch: async () => new Response('Forbidden', { status: 403 }),
    now: () => now
  });
  assert.equal(provider.status, 'unauthorized');
});
