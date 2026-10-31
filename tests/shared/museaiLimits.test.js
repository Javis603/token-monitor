'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchMuseaiLimits, normalizeMuseaiCookieHeader, parseMuseaiSubscription } = require('../../src/shared/providers/museai/limits');
const { LIMIT_PROVIDER_FETCHERS } = require('../../src/shared/limits/registry');
const { aggregateLimits } = require('../../src/shared/limits/core');
const { actionID, free, paid, fixtureFetch } = require('../fixtures/museai');
const options = { museaiCookie: 'hatch_sess=fixture' };

test('Muse (Meta) is a separate limits provider and accepts full Cookie headers only', async () => {
  assert.equal((await LIMIT_PROVIDER_FETCHERS.museai(options, { fetch: fixtureFetch() })).status, 'ok');
  assert.notEqual(LIMIT_PROVIDER_FETCHERS.muse, fetchMuseaiLimits);
  assert.equal(normalizeMuseaiCookieHeader('Cookie: hatch_sess=fixture; other=value'), 'hatch_sess=fixture; other=value');
  for (const value of ['bare-token', 'curl https://muse.ai', 'a=b\r\nx=y', '=value', 'a=b; broken']) assert.equal(normalizeMuseaiCookieHeader(value), '');
  const row = await fetchMuseaiLimits({}, { env: {}, fetch: () => assert.fail('no credential') });
  assert.equal(row.status, 'notConfigured');
});

test('Free, Power and Maximum expose only known weekly usage, reset and additional money balance', async () => {
  for (const action of [free, paid, paid.replace('Maximum', 'Power')]) {
    const row = await fetchMuseaiLimits(options, { env: {}, fetch: fixtureFetch({ action }) });
    assert.equal(row.status, 'ok');
    assert.equal(row.accountKey, '');
    assert.equal(row.windows[0].kind, 'weekly');
    assert.equal(row.windows[0].windowMinutes, 10080);
    assert.equal(row.windows[0].resetsAt, new Date(1790634838000).toISOString());
    assert.equal(row.windows[0].used, null);
    assert.equal(row.windows[0].limit, null);
    assert.equal(row.windows[0].remaining, null);
    assert.equal(row.windows[0].usedPercent, action === free ? 28 : 3);
    if (action === free) assert.equal(row.windows.length, 1);
    else {
      assert.equal(row.planLabel, action.includes('Power') ? 'Power' : 'Maximum');
      assert.equal(row.windows[0].resetDescription, '2.8B tokens left');
      assert.equal(row.windows[1].remaining, 60);
      assert.equal(row.windows[1].currency, 'USD');
      assert.equal(row.windows[1].metric, 'credits');
      assert.equal(row.windows[1].usedPercent, null);
      assert.equal(row.windows[1].showMeter, false);
    }
  }
  for (const text of ['1:{"success":false}', free.replace('"percentUsed":28', '"percentUsed":null'), free.replace('1790634838', '"invalid"')]) assert.throws(() => parseMuseaiSubscription(text));
});

test('discovery keeps cookies off chunks, caches success and rediscovers a stale action once', async () => {
  for (const stored of [null, '40aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    const state = new Map(stored ? [['museai:actionID', stored]] : []);
    const calls = [];
    const deps = { env: {}, providerRuntimeState: state, fetch: fixtureFetch({ onRequest: (path, init) => {
      calls.push([path, init.method]);
      if (path.startsWith('/_next/')) assert.equal(init.headers.Cookie, undefined);
      else assert.equal(init.headers.Cookie, options.museaiCookie);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      if (init.method === 'POST') {
        assert.equal(init.headers['Sec-Fetch-Site'], 'same-origin');
        assert.deepEqual(JSON.parse(init.body), [{ includeAgreement: true }]);
      }
    } }) };
    assert.equal((await fetchMuseaiLimits(options, deps)).status, 'ok');
    assert.equal(state.get('museai:actionID'), actionID);
    assert.equal(calls.filter(([, method]) => method === 'POST').length, stored ? 2 : 1);
    calls.length = 0;
    assert.equal((await fetchMuseaiLimits(options, deps)).status, 'ok');
    assert.deepEqual(calls, [['/', 'POST']]);
  }
});

test('HTTP errors, auth redirects, malformed responses and timeouts cannot become healthy zero usage', async () => {
  for (const [status, expected] of [[401, 'unauthorized'], [403, 'unauthorized'], [429, 'sourceRateLimited'], [500, 'unavailable']]) {
    const row = await fetchMuseaiLimits(options, { fetch: async () => new Response('', { status }) });
    assert.equal(row.status, expected);
    assert.deepEqual(row.windows, []);
  }
  for (const [status, headers] of [[307, { Location: 'https://auth.muse.ai/login' }], [403, { 'cf-mitigated': 'challenge' }]]) {
    const row = await fetchMuseaiLimits(options, { fetch: async () => new Response('', { status, headers }) });
    assert.equal(row.status, status === 307 ? 'unauthorized' : 'unavailable');
  }
  const state = new Map();
  assert.equal((await fetchMuseaiLimits(options, { providerRuntimeState: state, fetch: fixtureFetch({ action: '1:{"success":false}' }) })).status, 'unavailable');
  assert.equal(state.size, 0);
  const timed = await fetchMuseaiLimits(options, { museaiFetchTimeoutMs: 10, fetch: () => new Promise(() => {}) });
  assert.equal(timed.status, 'unavailable');
});

test('the native Node transport is injected and cancellation stops discovery before more requests', async () => {
  const controller = new AbortController();
  let requests = 0;
  const row = await fetchMuseaiLimits(options, {
    signal: controller.signal,
    fetch: () => assert.fail('must use the injected Node transport'),
    museaiFetch: fixtureFetch({ onRequest: () => { requests++; controller.abort(); } })
  });
  assert.equal(row.status, 'unavailable');
  assert.equal(requests, 1);
});

test('action discovery is bounded and a second stale action is not cached', async () => {
  let requests = 0;
  const result = await fetchMuseaiLimits(options, { fetch: async (_url) => {
    requests++;
    return new Response(new URL(_url).pathname === '/'
      ? Array.from({ length: 120 }, (_, i) => `<script src="/_next/static/chunks/${i}.js"></script>`).join('') : '');
  } });
  assert.equal(result.status, 'unavailable');
  assert.equal(requests, 97);
  const state = new Map([['museai:actionID', 'old']]);
  const row = await fetchMuseaiLimits(options, { providerRuntimeState: state, fetch: fixtureFetch({ action: 'Server action not found.', actionStatus: 404 }) });
  assert.equal(row.status, 'unavailable');
  assert.equal(state.size, 0);
});

test('anonymous Meta Muse rows stay separate on synced devices', async () => {
  const row = await fetchMuseaiLimits(options, { fetch: fixtureFetch() });
  const summary = aggregateLimits([
    { deviceId: 'a', limits: { providers: [row] } },
    { deviceId: 'b', limits: { providers: [row] } }
  ]);
  assert.equal(summary.providers.length, 2);
  assert.deepEqual(summary.providers.map((entry) => entry.sourceDeviceId).sort(), ['a', 'b']);
});
