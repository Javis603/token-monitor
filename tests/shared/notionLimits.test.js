'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hashKey } = require('../../src/shared/hashKey');
const { aggregateLimits, publicLimits, syncLimits } = require('../../src/shared/limits/core');
const account = require('../../src/shared/providers/notion/account');
const {
  fetchNotionLimits,
  normalizeNotionCookieHeader,
  normalizeNotionWorkspaceId,
  notionCookie,
  notionWorkspaceId,
  parseNotionAllowance,
  parseNotionSpaces,
  NOTION_SPACES_URL,
  NOTION_ALLOWANCE_URL
} = require('../../src/shared/providers/notion/limits');

const spacesFixture = require('../fixtures/notionSpaces.json');
const allowanceFixture = require('../fixtures/notionAllowance.json');
const USER = '8f24ac06-1807-4d51-9317-87d2f1a5f394';
const USER_B = 'ad5e1e56-1a69-42a5-aede-c8fde578f1a5';
const SPACE = 'f190126b-0445-43ec-94dd-f069ad1aa064';
const SPACE_B = '06f78985-cf72-419c-ae99-c380405a093a';
const FREE_SPACE = '02a340f6-7dda-40a7-8b37-9c8417f8ed03';
const UNKNOWN_SPACE = '97db9e20-9b7b-4712-9474-a476fc965c82';
const NOW = Date.parse('2026-10-14T04:00:00Z');
const COOKIE = 'token_v2=fixture-secret-notion-session';
const options = { notionCookie: COOKIE, notionWorkspaceId: SPACE };
const clone = (value) => structuredClone(value);
const response = (body, status = 200) => ({ status, ok: status === 200, json: async () => clone(body) });

function mockDeps({ spaces = spacesFixture, allowance = allowanceFixture, status = 200, failAt = 'allowance' } = {}) {
  const calls = [];
  return {
    calls,
    env: {},
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push({ url, init });
      assert.ok([NOTION_SPACES_URL, NOTION_ALLOWANCE_URL].includes(url), 'fixed endpoints only');
      const discovery = url === NOTION_SPACES_URL;
      return response(discovery ? spaces : allowance, (discovery === (failAt === 'spaces')) ? status : 200);
    }
  };
}

test('Notion declaration is manual-only with required cookie and workspace fields', () => {
  assert.equal(account.fetch, 'fetchNotionLimits');
  assert.equal(account.discover, undefined);
  assert.equal(account.form.discover, undefined);
  assert.deepEqual(account.fields[0].storePath, ['providers', 'notion', 'cookie']);
  assert.equal(account.fields[1].kind, 'setting');
  assert.equal(account.fields[1].storePath, undefined);
  assert.deepEqual(account.form.fields.map((field) => [field.key, field.input, field.required]), [
    ['notionCookie', 'password', true], ['notionWorkspaceId', 'text', true]
  ]);
  assert.equal(account.form.fields[1].secret, false);
  assert.equal(account.form.fields[1].prefill, true);
  assert.ok(account.form.messages.required);
  assert.ok(account.form.messages.invalidFormat);
  assert.ok(account.form.messages.rejected);
});

test('Notion cookie normalization accepts bare tokens and forwards only token_v2', () => {
  for (const input of [
    'fixture-secret-notion-session',
    COOKIE,
    `Cookie: other=private; ${COOKIE}; locale=en-US`,
    `  cookie: ${COOKIE}  `,
    `other=private; ${COOKIE}`
  ]) assert.equal(normalizeNotionCookieHeader(input), COOKIE, input);
  assert.equal(normalizeNotionCookieHeader('opaque-token=='), 'token_v2=opaque-token==');
  for (const input of [
    '', null, 42, 'curl https://app.notion.com', `curl -H 'Cookie: ${COOKIE}'`,
    'Cookie: other=missing-token', 'other=missing-token', 'token_v2=',
    `${COOKIE}; token_v2=second`, `${COOKIE}; malformed`, `${COOKIE}; other="quoted"`,
    `${COOKIE}\r\nHost: attacker.invalid`, ` ${COOKIE}\n`, `token_v2=bad\tvalue`,
    'token_v2=bad value', 'token_v2=bad,value', 'token_v2="quoted"', `Cookie: ${COOKIE};`,
    `token_v2=bad\u007f`, `token_v2=bad\u0000`, `token_v2=non-ascii-\u2603`
  ]) assert.equal(normalizeNotionCookieHeader(input), '', String(input));
});

test('Notion UUID and env resolvers canonicalize identities and never replace invalid explicit values', () => {
  const compact = SPACE.replaceAll('-', '').toUpperCase();
  assert.equal(normalizeNotionWorkspaceId(` ${compact} `), SPACE);
  assert.equal(normalizeNotionWorkspaceId(SPACE.toUpperCase()), SPACE);
  assert.equal(normalizeNotionWorkspaceId(''), '');
  for (const value of ['unknown', `${SPACE}\n`, `-${compact}`, SPACE.replace('-', '--')]) {
    assert.throws(() => normalizeNotionWorkspaceId(value), { code: 'NOTION_WORKSPACE_ID_INVALID' });
  }
  for (const prefix of ['', 'TOKEN_MONITOR_']) {
    const env = { [`${prefix}NOTION_COOKIE`]: COOKIE, [`${prefix}NOTION_WORKSPACE_ID`]: compact };
    assert.equal(notionCookie(env), COOKIE);
    assert.equal(notionWorkspaceId(env), SPACE);
    assert.equal(notionCookie(env, { notionCookie: 'token_v2=' }), '');
    assert.equal(notionWorkspaceId(env, { notionWorkspaceId: 'invalid' }), '');
  }
  const env = { NOTION_COOKIE: 'fallback', TOKEN_MONITOR_NOTION_COOKIE: 'preferred', NOTION_WORKSPACE_ID: SPACE, TOKEN_MONITOR_NOTION_WORKSPACE_ID: SPACE_B };
  assert.equal(notionCookie(env), 'token_v2=preferred');
  assert.equal(notionWorkspaceId(env), SPACE_B);
  assert.equal(notionCookie(env, options), COOKIE);
  assert.equal(notionWorkspaceId(env, options), SPACE);
});

test('Notion requests are serial exact-workspace POSTs with an isolated transport', async () => {
  const deps = mockDeps();
  const controller = new AbortController();
  const provider = await fetchNotionLimits({ ...options, notionWorkspaceId: SPACE.replaceAll('-', '').toUpperCase() }, { ...deps, signal: controller.signal });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountKey, hashKey('notion', USER + SPACE));
  assert.equal(provider.planLabel, 'Business');
  assert.equal(provider.accountEmail, '');
  assert.equal(provider.accountName, '');
  assert.equal(provider.accountLabel, '');
  assert.deepEqual(deps.calls.map(({ url }) => url), [NOTION_SPACES_URL, NOTION_ALLOWANCE_URL]);
  assert.deepEqual(deps.calls.map(({ init }) => JSON.parse(init.body)), [{}, { spaceId: SPACE }]);
  for (const { init } of deps.calls) {
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Cookie, COOKIE);
    assert.equal(init.headers.Host, undefined);
    assert.equal(init.headers.Referer, undefined);
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(deps.calls[0].init.signal, deps.calls[1].init.signal);
  const [rolling, monthly] = provider.windows;
  assert.deepEqual([rolling.kind, rolling.label, rolling.used, rolling.limit, rolling.usedPercent], ['session', 'Rolling', 12.5, 50, 25]);
  assert.equal(rolling.windowMinutes, 360);
  assert.equal(rolling.resetsAt, new Date(NOW + 900000).toISOString());
  assert.deepEqual([monthly.kind, monthly.label, monthly.used, monthly.limit, monthly.usedPercent], ['billing', 'Monthly', 90, 200, 45]);
  assert.equal(monthly.windowMinutes, null);
  assert.equal(monthly.resetDescription, 'Monthly');
  assert.equal(monthly.resetsAt, new Date(allowanceFixture.billingPeriodWindow.periodEndMs).toISOString());
  assert.equal(monthly.metric, undefined, 'AI allowance is not a prepaid money balance');
});

test('Notion preserves zero usage and raw overage while shared percentages clamp for display', async () => {
  for (const used of [0, 75]) {
    const allowance = clone(allowanceFixture);
    allowance.window.used = used;
    allowance.resetsInSeconds = 0;
    const parsed = parseNotionAllowance(allowance, NOW).windows[0];
    assert.equal(parsed.usedPercent, used / 50 * 100);
    const provider = await fetchNotionLimits(options, mockDeps({ allowance }));
    assert.equal(provider.status, 'ok');
    assert.equal(provider.windows[0].used, used);
    assert.equal(provider.windows[0].limit, 50);
    assert.equal(provider.windows[0].usedPercent, Math.min(100, used / 50 * 100));
    assert.equal(provider.windows[0].remainingPercent, used === 0 ? 100 : 0);
    assert.equal(provider.windows[0].resetsAt, new Date(NOW).toISOString());
  }
});

test('Notion missing resets and single-window responses never invent zero usage or monthly durations', async () => {
  const noResets = clone(allowanceFixture);
  delete noResets.resetsInSeconds;
  delete noResets.billingPeriodWindow.periodEndMs;
  const provider = await fetchNotionLimits(options, mockDeps({ allowance: noResets }));
  assert.equal(provider.status, 'ok');
  assert.deepEqual(provider.windows.map((window) => window.resetsAt), [null, null]);
  assert.equal(provider.windows[1].windowMinutes, null);
  for (const absent of ['window', 'billingPeriodWindow']) {
    const allowance = clone(allowanceFixture);
    delete allowance[absent];
    const row = await fetchNotionLimits(options, mockDeps({ allowance }));
    assert.equal(row.status, 'ok');
    assert.equal(row.windows.length, 1);
    assert.equal(row.windows[0].kind, absent === 'window' ? 'billing' : 'session');
    assert.ok(row.windows[0].used > 0);
  }
});

test('Notion rejects unsupported scopes, credits, cadence, status and invalid present windows', async () => {
  const changes = [
    (body) => { body.status = 'rate_limited'; },
    (body) => { body.status = 'future_status'; },
    (body) => { delete body.status; },
    (body) => { body.status = 42; },
    (body) => { body.enforcement = {}; },
    (body) => { body.window.scope = 'per_workspace'; },
    (body) => { delete body.window.scope; },
    (body) => { body.billingPeriodWindow.scope = false; },
    (body) => { body.window.creditType = 'notion_credits'; },
    (body) => { delete body.billingPeriodWindow.creditType; },
    (body) => { body.billingPeriodWindow.cadence = 'monthly'; },
    (body) => { delete body.billingPeriodWindow.cadence; },
    (body) => { body.window.window = '7h'; },
    (body) => { delete body.window.window; },
    (body) => { body.window.cadence = 'billing_period'; },
    (body) => { body.billingPeriodWindow.window = '6h'; },
    (body) => { body.window.used = -1; },
    (body) => { body.window.used = '25'; },
    (body) => { body.window.used = Infinity; },
    (body) => { body.window.limit = 0; },
    (body) => { body.window.limit = -1; },
    (body) => { body.window.limit = null; },
    (body) => { body.window.limit = Number.MIN_VALUE; },
    (body) => { delete body.billingPeriodWindow.used; },
    (body) => { body.billingPeriodWindow.limit = NaN; },
    (body) => { body.window = []; },
    (body) => { body.window = null; },
    (body) => { body.window = {}; },
    (body) => { body.billingPeriodWindow = 'invalid'; },
    (body) => { body.resetsInSeconds = -1; },
    (body) => { body.resetsInSeconds = null; },
    (body) => { body.resetsInSeconds = '900'; },
    (body) => { body.resetsInSeconds = Infinity; },
    (body) => { body.resetsInSeconds = Number.MAX_VALUE; },
    (body) => { body.billingPeriodWindow.periodEndMs = 0; },
    (body) => { body.billingPeriodWindow.periodEndMs = -1; },
    (body) => { body.billingPeriodWindow.periodEndMs = null; },
    (body) => { body.billingPeriodWindow.periodEndMs = '1793491200000'; },
    (body) => { body.billingPeriodWindow.periodEndMs = Number.MAX_VALUE; }
  ];
  for (const change of changes) {
    const allowance = clone(allowanceFixture);
    change(allowance);
    assert.throws(() => parseNotionAllowance(allowance, NOW), { status: 'unavailable' }, String(change));
    const provider = await fetchNotionLimits(options, mockDeps({ allowance }));
    assert.equal(provider.status, 'unavailable', String(change));
    assert.deepEqual(provider.windows, [], 'one valid sibling cannot hide an invalid present window');
  }
  for (const allowance of [{}, [], null, { status: 'within_limit' }]) {
    assert.throws(() => parseNotionAllowance(allowance, NOW), { status: 'unavailable' });
  }
});

test('Notion not_applicable stays unavailable during regular and credential probes', async () => {
  const deps = mockDeps({ allowance: { status: 'not_applicable', workspaceName: 'private name' } });
  const provider = await fetchNotionLimits(options, deps);
  assert.equal(provider.status, 'unavailable');
  assert.deepEqual(provider.windows, []);
  const probe = await fetchNotionLimits(options, { ...deps, probe: true });
  assert.equal(probe.status, 'unavailable');
  assert.deepEqual(probe.windows, []);
  assert.equal(JSON.stringify(probe).includes('private name'), false);
});

test('Notion status classification applies to both endpoints without reading failure bodies', async () => {
  for (const failAt of ['spaces', 'allowance']) {
    for (const [httpStatus, expected] of [[401, 'unauthorized'], [403, 'unauthorized'], [429, 'sourceRateLimited'], [500, 'unavailable'], [503, 'unavailable'], [302, 'unavailable']]) {
      const deps = mockDeps({ status: httpStatus, failAt });
      const original = deps.fetch;
      deps.fetch = async (...args) => {
        const result = await original(...args);
        if (result.status !== 200) result.json = async () => { throw new Error('failure body must not be read'); };
        return result;
      };
      const provider = await fetchNotionLimits(options, deps);
      assert.equal(provider.status, expected);
      assert.deepEqual(provider.windows, []);
      assert.equal(deps.calls.length, failAt === 'spaces' ? 1 : 2);
      assert.equal(provider.accountKey, failAt === 'spaces' ? '' : hashKey('notion', USER + SPACE));
    }
  }
});

test('Notion explicit anti-bot challenges at either endpoint are unavailable without inspecting bodies', async () => {
  for (const failAt of ['spaces', 'allowance']) {
    const deps = mockDeps({ status: 403, failAt });
    const original = deps.fetch;
    deps.fetch = async (...args) => {
      const result = await original(...args);
      if (result.status === 403) {
        result.headers = new Headers({ 'cf-mitigated': 'challenge' });
        result.json = async () => { throw new Error('challenge body must not be read'); };
      }
      return result;
    };
    const provider = await fetchNotionLimits(options, deps);
    assert.equal(provider.status, 'unavailable');
    assert.deepEqual(provider.windows, []);
    assert.equal(deps.calls.length, failAt === 'spaces' ? 1 : 2);
  }
});

test('Notion malformed JSON, network failures and aborts produce sanitized unavailable records', async () => {
  const secretError = `Cookie: ${COOKIE}; do-not-publish@example.invalid Private paid workspace`;
  for (const endpoint of [NOTION_SPACES_URL, NOTION_ALLOWANCE_URL]) {
    for (const kind of ['malformed', 'network']) {
      const deps = mockDeps();
      const original = deps.fetch;
      deps.fetch = async (...args) => {
        if (args[0] !== endpoint) return original(...args);
        if (kind === 'network') throw new Error(secretError);
        return { status: 200, json: async () => { throw new SyntaxError(secretError); } };
      };
      const provider = await fetchNotionLimits(options, deps);
      assert.equal(provider.status, 'unavailable');
      assert.deepEqual(provider.windows, []);
      assert.equal(JSON.stringify(provider).includes(secretError), false);
      for (const secret of [COOKIE, 'do-not-publish@example.invalid', 'Private paid workspace']) {
        assert.equal(JSON.stringify(provider).includes(secret), false);
      }
    }
  }
  const controller = new AbortController();
  controller.abort(new Error(secretError));
  const deps = mockDeps();
  const aborted = await fetchNotionLimits(options, { ...deps, signal: controller.signal });
  assert.equal(aborted.status, 'unavailable');
  assert.equal(aborted.accountKey, '');
  assert.equal(deps.calls.length, 0);
});

test('Notion propagates cancellation and bounds uncooperative fetch and JSON parsing', async () => {
  for (const phase of ['fetch', 'json']) {
    const controller = new AbortController();
    let observedSignal;
    const deps = {
      env: {}, signal: controller.signal, notionFetchTimeoutMs: 20,
      fetch: async (_url, init) => {
        observedSignal = init.signal;
        if (phase === 'fetch') return new Promise(() => {});
        return { status: 200, json: async () => new Promise(() => {}) };
      }
    };
    const provider = await fetchNotionLimits(options, deps);
    assert.equal(provider.status, 'unavailable');
    assert.deepEqual(provider.windows, []);
    assert.equal(observedSignal.aborted, true);
  }
  const controller = new AbortController();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let signal;
  const pending = fetchNotionLimits(options, {
    env: {}, signal: controller.signal,
    fetch: async (_url, init) => { signal = init.signal; started(); return new Promise(() => {}); }
  });
  await ready;
  controller.abort(new Error('private abort reason'));
  const provider = await pending;
  assert.equal(provider.status, 'unavailable');
  assert.equal(signal.aborted, true);
  assert.equal(JSON.stringify(provider).includes('private abort reason'), false);
});

test('Notion late discovery after cancellation cannot start an allowance request', async () => {
  const controller = new AbortController();
  let releaseJson;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const delayed = new Promise((resolve) => { releaseJson = resolve; });
  const urls = [];
  const pending = fetchNotionLimits(options, {
    env: {}, signal: controller.signal,
    fetch: async (url) => {
      urls.push(url);
      return { status: 200, json: async () => { started(); return delayed; } };
    }
  });
  await ready;
  controller.abort();
  const provider = await pending;
  assert.equal(provider.status, 'unavailable');
  assert.equal(provider.accountKey, '');
  releaseJson(clone(spacesFixture));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(urls, [NOTION_SPACES_URL]);
});

test('Notion exact workspace pin never falls through to another paid workspace', async () => {
  for (const workspace of [SPACE, SPACE_B, FREE_SPACE]) {
    const deps = mockDeps();
    const provider = await fetchNotionLimits({ ...options, notionWorkspaceId: workspace }, deps);
    assert.equal(provider.status, 'ok');
    assert.equal(provider.accountKey, hashKey('notion', USER + workspace));
    assert.deepEqual(JSON.parse(deps.calls[1].init.body), { spaceId: workspace });
    assert.equal(provider.planLabel, workspace === SPACE ? 'Business' : workspace === SPACE_B ? 'Enterprise' : '');
  }
  const deps = mockDeps();
  const unavailable = await fetchNotionLimits({ ...options, notionWorkspaceId: UNKNOWN_SPACE }, deps);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.accountKey, '');
  assert.equal(deps.calls.length, 1);
});

test('Notion identity rejects ambiguous users, missing evidence and workspace id conflicts', async () => {
  const changes = [
    (body) => { body[USER_B] = clone(body[USER]); },
    (body) => { body.invalid = clone(body[USER]); delete body[USER]; },
    (body) => { delete body[USER].notion_user; },
    (body) => { body[USER].notion_user = {}; },
    (body) => { body[USER].notion_user[USER].value.value.id = USER_B; },
    (body) => { delete body[USER].notion_user[USER].value.value.id; },
    (body) => { body[USER].notion_user[USER_B] = body[USER].notion_user[USER]; delete body[USER].notion_user[USER]; },
    (body) => { delete body[USER].space; },
    (body) => { body[USER].space[SPACE].value.value.id = SPACE_B; },
    (body) => { delete body[USER].space[SPACE].value.value.id; },
    (body) => { body[USER].space[SPACE.replaceAll('-', '')] = clone(body[USER].space[SPACE]); },
    (body) => { body[USER].notion_user[USER.replaceAll('-', '')] = clone(body[USER].notion_user[USER]); }
  ];
  for (const change of changes) {
    const spaces = clone(spacesFixture);
    change(spaces);
    assert.throws(() => parseNotionSpaces(spaces, SPACE), { status: 'unavailable' });
    const deps = mockDeps({ spaces });
    const row = await fetchNotionLimits(options, deps);
    assert.equal(row.status, 'unavailable');
    assert.equal(row.accountKey, '', 'never hash session credentials after unverified identity');
    assert.equal(deps.calls.length, 1);
  }
  for (const spaces of [{}, [], null, { [USER]: [] }]) assert.throws(() => parseNotionSpaces(spaces, SPACE), { status: 'unavailable' });
});

test('Notion account keys are stable across sessions while users and workspaces remain isolated', async () => {
  assert.equal(parseNotionSpaces(spacesFixture, SPACE.replaceAll('-', '').toUpperCase()).accountKey, hashKey('notion', USER + SPACE));
  const first = await fetchNotionLimits(options, mockDeps());
  const second = await fetchNotionLimits({ ...options, notionCookie: 'different-session-secret' }, mockDeps());
  assert.equal(first.accountKey, second.accountKey);
  const workspace = await fetchNotionLimits({ ...options, notionWorkspaceId: SPACE_B }, mockDeps());
  const spaces = clone(spacesFixture);
  spaces[USER_B] = spaces[USER];
  delete spaces[USER];
  spaces[USER_B].notion_user = { [USER_B]: { value: { id: USER_B, email: 'do-not-publish@example.invalid' } } };
  const user = await fetchNotionLimits(options, mockDeps({ spaces }));
  const aggregate = aggregateLimits([
    { deviceId: 'mac', limits: { providers: [first] } },
    { deviceId: 'windows', limits: { providers: [second] } },
    { deviceId: 'linux', limits: { providers: [workspace] } },
    { deviceId: 'other-user', limits: { providers: [user] } }
  ], 0, NOW);
  assert.equal(aggregate.providers.length, 3);
  assert.deepEqual(new Set(aggregate.providers.map((provider) => provider.accountKey)), new Set([
    hashKey('notion', USER + SPACE), hashKey('notion', USER + SPACE_B), hashKey('notion', USER_B + SPACE)
  ]));
  assert.ok(aggregate.providers.every((provider) => provider.accountEmail === ''));
});

test('Notion public and sync records contain no cookie, email, names, workspace UUID or error text', async () => {
  const provider = await fetchNotionLimits(options, mockDeps());
  const summary = { providers: [provider], updatedAt: provider.updatedAt };
  const synced = syncLimits(summary);
  const publicSummary = publicLimits(summary);
  assert.equal(synced.providers[0].accountKey, hashKey('notion', USER + SPACE));
  assert.equal(publicSummary.providers[0].accountKey, undefined);
  assert.equal(publicSummary.providers[0].planLabel, undefined);
  for (const payload of [provider, synced, publicSummary]) {
    const serialized = JSON.stringify(payload);
    for (const secret of [COOKIE, 'fixture-secret-notion-session', USER, SPACE, 'do-not-publish@example.invalid', 'Private fixture user', 'Private paid workspace']) {
      assert.equal(serialized.includes(secret), false, secret);
    }
  }
  const spaces = clone(spacesFixture);
  spaces[USER].space[SPACE].value.value.subscription_tier = 'Private arbitrary plan';
  const row = await fetchNotionLimits(options, mockDeps({ spaces }));
  assert.equal(row.status, 'ok');
  assert.equal(row.planLabel, '');
});

test('Notion empty injected env and incomplete manual options perform no discovery or requests', async (t) => {
  const oldCookie = process.env.NOTION_COOKIE;
  const oldWorkspace = process.env.NOTION_WORKSPACE_ID;
  process.env.NOTION_COOKIE = COOKIE;
  process.env.NOTION_WORKSPACE_ID = SPACE;
  t.after(() => {
    if (oldCookie === undefined) delete process.env.NOTION_COOKIE;
    else process.env.NOTION_COOKIE = oldCookie;
    if (oldWorkspace === undefined) delete process.env.NOTION_WORKSPACE_ID;
    else process.env.NOTION_WORKSPACE_ID = oldWorkspace;
  });
  for (const input of [{}, { notionWorkspaceId: SPACE }, { notionCookie: COOKIE }, { ...options, notionWorkspaceId: 'invalid' }, { ...options, notionCookie: 'token_v2=' }]) {
    const deps = mockDeps();
    deps.readFileSync = () => assert.fail('no local credential discovery');
    const provider = await fetchNotionLimits(input, deps);
    assert.equal(provider.status, !input.notionCookie ? 'notConfigured' : 'unavailable');
    assert.equal(provider.accountKey, '');
    assert.equal(deps.calls.length, 0);
  }
  for (const prefix of ['', 'TOKEN_MONITOR_']) {
    const deps = mockDeps();
    deps.env = { [`${prefix}NOTION_COOKIE`]: COOKIE, [`${prefix}NOTION_WORKSPACE_ID`]: SPACE };
    const provider = await fetchNotionLimits({}, deps);
    assert.equal(provider.status, 'ok');
    assert.equal(deps.calls.length, 2);
  }
});
