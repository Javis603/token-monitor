'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hashKey } = require('../../src/shared/hashKey');
const { fetchOpendesignLimits, normalizeOpendesignCookieHeader, OPENDESIGN_API } = require('../../src/shared/providers/opendesign/limits');

const cookie = 'session=test-session';
const options = { opendesignCookie: cookie };
const workspace = { workspaceId: 'workspace-a', workspaceName: 'Design Studio', personalMembershipTier: 'pro' };
// Synthetic contract fixtures, not a captured or independently verified account.
const usage = () => ({ workspaceId: 'workspace-a', eligible: true, tier: 'pro', windows: [
  { durationSeconds: 604800, usedCredits: '25', limitCredits: '100', resetsAt: '2026-11-09T00:00:00Z' },
  { durationSeconds: 18000, usedCredits: 0, limitCredits: 20 }
] });
function deps(body = usage(), first = workspace) {
  const calls = [];
  return { env: {}, calls, now: () => Date.parse('2026-11-05T00:00:00Z'),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { status: 200, json: async () => structuredClone(url.endsWith('/current') ? first : body) };
    } };
}

test('OpenDesign discovers the workspace, selects windows by duration, and preserves measured zero', async () => {
  const d = deps();
  const result = await fetchOpendesignLimits(options, d);
  assert.equal(result.status, 'ok');
  assert.equal(result.accountKey, hashKey('opendesign', 'workspace-a'));
  assert.equal(result.accountName, 'Design Studio');
  assert.equal(result.planLabel, 'Pro');
  assert.deepEqual(result.windows.map((w) => [w.kind, w.used, w.limit, w.usedPercent]), [
    ['session', 0, 20, 0], ['weekly', 25, 100, 25]
  ]);
  assert.equal(result.windows[0].resetsAt, null);
  assert.equal(result.windows[1].resetsAt, '2026-11-09T00:00:00.000Z');
  assert.ok(result.windows.every((w) => w.metric !== 'credits'));
  assert.deepEqual(d.calls.map((c) => c.url), [OPENDESIGN_API + 'current', OPENDESIGN_API + 'workspace-a/billing/coding-plan-usage']);
  assert.equal(d.calls[1].init.headers['X-Vela-Workspace-Id'], 'workspace-a');
  for (const { init } of d.calls) {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Cookie, cookie);
    assert.equal(init.headers.Host, undefined);
    assert.ok(init.signal);
  }
});

test('OpenDesign cookie boundary accepts full opaque headers and rejects malformed input without network', async () => {
  assert.equal(normalizeOpendesignCookieHeader('Cookie: a=one; b=two=='), 'a=one; b=two==');
  for (const value of ['bare-token', 'a=x\r\nb=y', 'curl https://example.com', 'a=x; invalid', 123]) {
    assert.equal(normalizeOpendesignCookieHeader(value), '');
    const d = deps();
    assert.equal((await fetchOpendesignLimits({ opendesignCookie: value }, d)).status, 'unavailable');
    assert.equal(d.calls.length, 0);
  }
  const d = deps();
  assert.equal((await fetchOpendesignLimits({}, d)).status, 'notConfigured');
  assert.equal(d.calls.length, 0);
  d.env.OPENDESIGN_COOKIE = cookie;
  assert.equal((await fetchOpendesignLimits({}, d)).status, 'ok');
});

test('OpenDesign rejects wrong-type, partial and malformed quota responses', async () => {
  const cases = [null, [], {}, { ...usage(), eligible: false }, { ...usage(), eligible: 'true' },
    { ...usage(), workspaceId: 'workspace-b' }, { ...usage(), windows: [] },
    { ...usage(), windows: [{ durationSeconds: 42, usedCredits: 0, limitCredits: 100 }] }];
  for (const field of ['usedCredits', 'limitCredits']) {
    for (const value of [null, undefined, true, [], {}, '', 'NaN', -1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const body = usage(); body.windows[0][field] = value; cases.push(body);
    }
  }
  const duplicate = usage(); duplicate.windows.push(duplicate.windows[0]); cases.push(duplicate);
  const zeroLimit = usage(); zeroLimit.windows[0].limitCredits = 0; cases.push(zeroLimit);
  for (const body of cases) {
    const result = await fetchOpendesignLimits(options, deps(body));
    assert.equal(result.status, 'unavailable', JSON.stringify(body));
    assert.deepEqual(result.windows, []);
  }
});

test('OpenDesign does not invent reset dates or reinterpret unknown durations', async () => {
  const body = usage(); body.windows[0].resetsAt = 'not-a-date';
  body.windows.push({ durationSeconds: 42, usedCredits: 'invalid' });
  assert.equal((await fetchOpendesignLimits(options, deps(body))).windows[1].resetsAt, null);
  body.windows = [body.windows[0]];
  assert.equal((await fetchOpendesignLimits(options, deps(body))).windows[0].kind, 'weekly');
});

test('OpenDesign validates workspace IDs before requesting quota and isolates workspace identities', async () => {
  for (const id of [null, '', '../outside', 'x?query', 42]) {
    const d = deps(usage(), { workspaceId: id });
    assert.equal((await fetchOpendesignLimits(options, d)).status, 'unavailable');
    assert.equal(d.calls.length, 1);
  }
  const body = usage(); body.workspaceId = 'workspace-b';
  const a = await fetchOpendesignLimits(options, deps());
  const b = await fetchOpendesignLimits(options, deps(body, { ...workspace, workspaceId: 'workspace-b' }));
  assert.notEqual(a.accountKey, b.accountKey);
});

test('OpenDesign classifies HTTP failures at either endpoint without exposing secrets', async () => {
  for (const at of [1, 2]) {
    for (const [code, status] of [[401, 'unauthorized'], [403, 'unavailable'], [429, 'sourceRateLimited'], [500, 'unavailable'], [302, 'unavailable']]) {
      const d = deps(); const request = d.fetch;
      d.fetch = async (...args) => { const response = await request(...args); return d.calls.length === at ? { status: code } : response; };
      const result = await fetchOpendesignLimits(options, d);
      assert.equal(result.status, status);
      assert.equal(d.calls.length, at);
      assert.ok(!JSON.stringify(result).includes(cookie));
    }
  }
});

test('OpenDesign handles invalid JSON, transport failure, timeout and cancellation', async () => {
  for (const fetch of [async () => { throw new Error(cookie); }, async () => ({ status: 200, json: async () => { throw new SyntaxError('truncated'); } })]) {
    const result = await fetchOpendesignLimits(options, { env: {}, fetch });
    assert.equal(result.status, 'unavailable');
    assert.ok(!JSON.stringify(result).includes(cookie));
  }
  const controller = new AbortController(); controller.abort();
  const d = deps(); d.signal = controller.signal;
  assert.equal((await fetchOpendesignLimits(options, d)).status, 'unavailable');
  assert.equal(d.calls.length, 0);
  const result = await fetchOpendesignLimits(options, { env: {}, opendesignFetchTimeoutMs: 5,
    fetch: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  assert.equal(result.status, 'unavailable');
});

test('OpenDesign passes repeated cookie names through unchanged', async () => {
  const repeated = 'session=workspace-path; session=parent-path; other=value';
  assert.equal(normalizeOpendesignCookieHeader(repeated), repeated);
  const d = deps();
  const result = await fetchOpendesignLimits({ opendesignCookie: repeated }, d);
  assert.equal(result.status, 'ok');
  assert.ok(d.calls.every(({ init }) => init.headers.Cookie === repeated));
});

test('OpenDesign aggregation keeps distinct workspaces and deduplicates the same workspace across devices', async () => {
  for (const core of [require('../../src/shared/limits/core'), require('../../worker/src/shared/limits/core')]) {
    const first = await fetchOpendesignLimits(options, deps());
    const body = usage(); body.workspaceId = 'workspace-b';
    const second = await fetchOpendesignLimits(options, deps(body, { ...workspace, workspaceId: 'workspace-b' }));
    const result = core.aggregateLimits([
      { deviceId: 'one', limits: { providers: [first] } },
      { deviceId: 'two', limits: { providers: [second] } },
      { deviceId: 'same-workspace', limits: { providers: [first] } }
    ], 0, Date.parse(first.updatedAt));
    assert.equal(result.providers.length, 2);
    assert.deepEqual(new Set(result.providers.map((p) => p.accountKey)), new Set([first.accountKey, second.accountKey]));
  }
});

test('OpenDesign freshness is scoped to its workspace across Node and Worker', async () => {
  for (const core of [require('../../src/shared/limits/core'), require('../../worker/src/shared/limits/core')]) {
    const first = await fetchOpendesignLimits(options, deps());
    const body = usage(); body.workspaceId = 'workspace-b';
    const second = await fetchOpendesignLimits(options, deps(body, { ...workspace, workspaceId: 'workspace-b' }));
    const result = core.aggregateLimits([
      { deviceId: 'stale-a', stale: true, limits: { providers: [first] } },
      { deviceId: 'fresh-b', limits: { providers: [second] } }
    ], 0, Date.parse(first.updatedAt));
    assert.equal(result.providers.length, 2);
    assert.equal(result.providers.find(p => p.accountKey === first.accountKey).stale, true);
    const refreshed = core.aggregateLimits([
      { deviceId: 'stale-a', stale: true, limits: { providers: [first] } },
      { deviceId: 'fresh-a', limits: { providers: [first] } },
      { deviceId: 'fresh-b', limits: { providers: [second] } }
    ], 0, Date.parse(first.updatedAt));
    assert.equal(refreshed.providers.length, 2);
    assert.equal(refreshed.providers.find(p => p.accountKey === first.accountKey).stale, false);
  }
});

test('OpenDesign keeps an unidentified authorization failure alongside a known workspace', async () => {
  const healthy = await fetchOpendesignLimits(options, deps());
  const failed = await fetchOpendesignLimits(options, { env: {}, fetch: async () => ({ status: 401 }) });
  for (const core of [require('../../src/shared/limits/core'), require('../../worker/src/shared/limits/core')]) {
    const result = core.aggregateLimits([
      { deviceId: 'healthy', limits: { providers: [healthy] } },
      { deviceId: 'failed', limits: { providers: [failed] } }
    ], 0, Date.parse(healthy.updatedAt));
    assert.equal(result.providers.length, 2);
    const unauthorized = result.providers.find(p => p.status === 'unauthorized');
    assert.ok(unauthorized);
    assert.equal(unauthorized.accountKey, '');
    assert.equal(unauthorized.sourceDeviceId, 'failed');
  }
});

test('OpenDesign hides setup placeholders only when a known workspace exists', async () => {
  const healthy = await fetchOpendesignLimits(options, deps());
  for (const core of [require('../../src/shared/limits/core'), require('../../worker/src/shared/limits/core')]) {
    for (const status of ['notConfigured', 'disabled']) {
      const placeholder = { provider: 'opendesign', status, windows: [], updatedAt: healthy.updatedAt };
      const devices = [
        { deviceId: 'workspace', limits: { providers: [healthy] } },
        { deviceId: 'no-cookie', limits: { providers: [placeholder] } }
      ];
      const result = core.aggregateLimits(devices, 0, Date.parse(healthy.updatedAt));
      assert.equal(result.providers.length, 1, status);
      assert.equal(result.providers[0].accountKey, healthy.accountKey);
      const alone = core.aggregateLimits([devices[1]], 0, Date.parse(healthy.updatedAt));
      assert.equal(alone.providers.length, 1);
      assert.equal(alone.providers[0].status, status);
    }
  }
});
