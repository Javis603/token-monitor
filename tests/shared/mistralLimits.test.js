'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mistralCookie, fetchMistralLimits, parseMistralSubscription, parseMistralCredits, parseMistralVibe } = require('../../src/shared/providers/mistral/limits');

const budget = (pct = 25, amount = 20) => ({ usage_percentage: pct, initial_budget: amount, currency: 'eur', reset_at: '2026-12-01T00:00:00Z' });
const row = (value) => `a:${JSON.stringify(value)}\n`;
const flight = (...chunks) => chunks.map((chunk) => `<script>self.__next_f.push(${JSON.stringify([1, chunk])})</script>`).join('');
const page = (api = budget(), vibe = budget(50, 10)) => flight(row(['$', 'component', null, { budget: { api_budget: api, vibe_budget: vibe } }]));
const credits = { wallet_amount: 12, credit_notes_amount: 3, ongoing_usage_balance: 2, currency: 'EUR' };
const response = (body, status = 200, headers = {}) => ({ ok: status === 200, status, headers: new Headers(headers), text: async () => body, json: async () => body });
const options = { mistralCookie: 'ory_session_test=session; csrftoken=csrf; admin_only=private' };

test('cookie normalization requires a session and rejects header injection', () => {
  assert.equal(mistralCookie({}, { mistralCookie: 'Cookie: ory_session_x=a=b; csrftoken=c' }), 'ory_session_x=a=b; csrftoken=c');
  assert.equal(mistralCookie({ TOKEN_MONITOR_MISTRAL_COOKIE: 'ory_session_x=env' }), 'ory_session_x=env');
  assert.equal(mistralCookie({ MISTRAL_COOKIE: 'ory_session_x=alias' }), 'ory_session_x=alias');
  for (const mistralCookieValue of ['key', 'csrftoken=c', 'ory_session_x=', 'ory_session_x=a\r\nInjected: yes', 'ory_session_x=a; malformed']) {
    assert.equal(mistralCookie({}, { mistralCookie: mistralCookieValue }), '');
  }
});

test('subscription parses split Flight chunks with separate API and Vibe allowances', () => {
  const stream = row({ budget: { api_budget: budget(), vibe_budget: budget(75, 40) } });
  const windows = parseMistralSubscription(flight(stream.slice(0, 55), stream.slice(55)));
  assert.deepEqual(windows.map(({ label, used, limit, remaining, currency, resetsAt }) => ({ label, used, limit, remaining, currency, resetsAt })), [
    { label: 'Included API', used: 5, limit: 20, remaining: 15, currency: 'EUR', resetsAt: '2026-12-01T00:00:00.000Z' },
    { label: 'Included Vibe Code', used: 30, limit: 40, remaining: 10, currency: 'EUR', resetsAt: '2026-12-01T00:00:00.000Z' }
  ]);
});

test('subscription omits invalid sibling budgets and preserves overage', () => {
  const windows = parseMistralSubscription(page(budget(10, 0), budget(125)));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].usedPercent, 125);
  assert.equal(windows[0].remaining, 0);
  for (const invalid of [null, budget(-1), budget(10, -1), { ...budget(), initial_budget: null }, { ...budget(), usage_percentage: '10' }]) {
    assert.throws(() => parseMistralSubscription(page(invalid, null)));
  }
});

test('subscription rejects missing/conflicting budgets but deduplicates identical records', () => {
  assert.throws(() => parseMistralSubscription('<html>Sign in</html>'));
  const first = row({ budget: { api_budget: budget() } });
  assert.equal(parseMistralSubscription(flight(first + first)).length, 1);
  assert.throws(() => parseMistralSubscription(flight(first + row({ budget: { api_budget: budget(40) } }))));
});

test('Flight byte payloads cannot introduce fake budget rows', () => {
  const fake = `中文\n${row({ budget: { api_budget: budget(99) } })}`;
  const stream = `1:T${Buffer.byteLength(fake).toString(16)},${fake}` + row({ budget: { api_budget: budget(12) } });
  assert.equal(parseMistralSubscription(flight(stream))[0].usedPercent, 12);
  assert.throws(() => parseMistralSubscription(flight('1:Tffff,short')));
  assert.throws(() => parseMistralSubscription(flight('a:{broken}\n')));
});

test('credits retain zero, adjustments and reported currency; malformed money is unknown', () => {
  assert.equal(parseMistralCredits(credits).remaining, 13);
  assert.equal(parseMistralCredits({ wallet_amount: 0, currency: 'USD' }).remaining, 0);
  assert.equal(parseMistralCredits({ ...credits, ongoing_usage_balance: 30 }).remaining, -15);
  for (const data of [{}, { ...credits, wallet_amount: null }, { ...credits, wallet_amount: '12' }, { ...credits, wallet_amount: Infinity }, { ...credits, currency: '' }]) {
    assert.throws(() => parseMistralCredits(data));
  }
});

test('Vibe fallback uses upstream snake_case fields and does not invent a reset', () => {
  const usage = [{ result: { data: { json: { usage_percentage: 42, reset_at: '2026-12-01T00:00:00Z' } } } }];
  assert.equal(parseMistralVibe(usage).usedPercent, 42);
  assert.equal(parseMistralVibe(usage).resetsAt, '2026-12-01T00:00:00.000Z');
  usage[0].result.data.json.reset_at = 'invalid';
  assert.equal(parseMistralVibe(usage).resetsAt, null);
  usage[0].result.data.json.usage_percentage = null;
  assert.throws(() => parseMistralVibe(usage));
});

test('collection normalizes all windows and keeps raw credentials out of the snapshot', async () => {
  const requests = [];
  const result = await fetchMistralLimits(options, { env: {}, fetch: async (url, init) => {
    requests.push(url);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Host, undefined);
    assert.equal(init.headers['X-CSRFTOKEN'], 'csrf');
    return response(url.endsWith('/subscription') ? page() : credits);
  } });
  assert.equal(result.status, 'ok');
  assert.equal(result.windows.length, 3);
  assert.ok(result.windows.every(({ kind }) => kind === 'billing'));
  assert.equal(result.windows.find(({ metric }) => metric === 'credits').remaining, 13);
  assert.equal(requests.length, 2, 'no fallback when subscription has Vibe');
  assert.equal(result.accountKey, '', 'rotating cookies are not account identity');
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('optional credits failures preserve allowances and subscription failures preserve balance', async () => {
  for (const failedSource of ['subscription', 'credits']) {
    const result = await fetchMistralLimits({ mistralCookie: 'ory_session_x=a' }, { env: {}, fetch: async (url) => {
      if (url.endsWith(`/${failedSource}`)) return response({}, 503);
      return response(url.endsWith('/subscription') ? page() : credits);
    } });
    assert.equal(result.status, 'ok');
    assert.equal(result.windows.length, failedSource === 'subscription' ? 1 : 2);
  }
});

test('Vibe fallback forwards only session/CSRF cookies and preserves API allowance', async () => {
  let fallback = 0;
  const result = await fetchMistralLimits(options, { env: {}, fetch: async (url, init) => {
    if (url.startsWith('https://console.mistral.ai/')) {
      fallback += 1;
      assert.equal(init.headers.Cookie, 'ory_session_test=session; csrftoken=csrf');
      return response([{ result: { data: { json: { usage_percentage: 80 } } } }]);
    }
    return url.endsWith('/subscription') ? response(page(budget(), null)) : response({}, 503);
  } });
  assert.equal(fallback, 1);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.windows.map(({ usedPercent }) => usedPercent), [25, 80]);
});

test('no CSRF means no console request; missing data is unavailable, not zero', async () => {
  const result = await fetchMistralLimits({ mistralCookie: 'ory_session_x=a' }, { env: {}, fetch: async (url) => {
    assert.ok(!url.includes('console.mistral.ai'));
    return response(url.endsWith('/subscription') ? '<html></html>' : {});
  } });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.windows, []);
});

test('credential rejection, throttling, redirects and challenges classify correctly', async () => {
  for (const [code, headers, expected] of [[401, {}, 'unauthorized'], [403, {}, 'unauthorized'], [302, { location: '/login' }, 'unauthorized'], [429, {}, 'sourceRateLimited'], [403, { 'cf-mitigated': 'challenge' }, 'unavailable']]) {
    const result = await fetchMistralLimits({ mistralCookie: 'ory_session_x=a' }, { env: {}, fetch: async () => response({}, code, headers) });
    assert.equal(result.status, expected, String(code));
  }
});

test('unconfigured provider never requests data', async () => {
  assert.equal((await fetchMistralLimits({}, { env: {}, fetch: () => assert.fail('unexpected fetch') })).status, 'notConfigured');
});

test('a timed-out optional source preserves a successful allowance', async () => {
  const result = await fetchMistralLimits({ mistralCookie: 'ory_session_x=a' }, { env: {}, mistralRequestTimeoutMs: 10, fetch: async (url) => {
    if (url.endsWith('/subscription')) return response(page());
    return new Promise(() => {});
  } });
  assert.equal(result.status, 'ok');
  assert.equal(result.windows.length, 2);
});

test('cancellation aborts the injected transport and does not publish success', async () => {
  const controller = new AbortController();
  let requestSignal;
  const promise = fetchMistralLimits(options, { env: {}, signal: controller.signal, fetch: async (_url, init) => {
    requestSignal = init.signal;
    await new Promise(() => {});
  } });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(promise);
  assert.equal(requestSignal.aborted, true);
});

test('Mistral cookie save validates the submitted credential before selecting the provider', async () => {
  const { createCredentialCommands } = require('../../src/electron/limits/credentialCommands');
  const { accountFieldProjection, accountStatusProjection } = require('../../src/electron/limits/accountSettings');
  let settings = { limitProviders: 'codex', mistralCookie: 'ory_session_existing=stored' };
  let status = 401;
  const commands = createCredentialCommands({
    getSettings: () => settings,
    env: { MISTRAL_COOKIE: 'ory_session_env=existing' },
    applySettingsPatch: async (patch) => { settings = { ...settings, ...patch }; return settings; },
    probeDeps: () => ({ fetch: async (_url, init) => {
      assert.equal(init.headers.Cookie, 'ory_session_draft=submitted');
      return response(credits, status);
    } })
  });
  const rejected = await commands.saveCredential('mistral', { mistralCookie: 'ory_session_draft=submitted' });
  assert.equal(rejected.saved, false);
  assert.equal(rejected.verdict, 'invalid');
  assert.equal(settings.mistralCookie, 'ory_session_existing=stored');
  status = 200;
  const accepted = await commands.saveCredential('mistral', { mistralCookie: 'ory_session_draft=submitted' });
  assert.equal(accepted.saved, true);
  assert.ok(settings.limitProviders.split(',').includes('mistral'));
  assert.equal(settings.mistralCookie, 'ory_session_draft=submitted');
  const projected = accountFieldProjection(settings, {});
  assert.notEqual(projected.mistralCookie, settings.mistralCookie);
  const account = accountStatusProjection(settings, {}, {});
  assert.equal(account.mistralCookieConfigured, true);
});
