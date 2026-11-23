'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hashKey } = require('../../src/shared/hashKey');
const { limitWindowText } = require('../../src/shared/limits/windowText');
const { limitWindowLabel } = require('../../src/shared/limits/windowLabels');
const {
  CODINGPASS_ORIGIN,
  fetchCodingpassLimits,
  isCodingpassServerAccountKey,
  normalizeCodingpassCookieHeader
} = require('../../src/shared/providers/codingpass/limits');

const cookie = 'session=test-session';
const options = { codingpassCookie: cookie };
// Synthetic contract fixtures shaped like the console's oRPC answers, not a
// captured account. Amounts are USD micro-units.
const usage = () => ({ json: {
  quota: {
    used5hMicro: '1000000', limit5hMicro: '5000000',
    usedWeekMicro: 4_000_000, limitWeekMicro: 20_000_000,
    usedMicro: 10_000_000, limitMicro: 50_000_000,
    monthStart: '2026-11-01T00:00:00Z', monthEnd: '2026-12-01T00:00:00Z'
  },
  live: {
    window5hStartAt: '2026-11-23T01:00:00Z',
    global: [
      { layer: 'global_5h', usedMicro: '2500000', limitMicro: '5000000', resetAt: '2026-11-23T06:00:00Z' },
      { layer: 'global_week', usedMicro: 6_000_000, limitMicro: 20_000_000, resetAt: '2026-11-30T00:00:00Z' },
      { layer: 'global_month', usedMicro: 12_000_000, limitMicro: 50_000_000, resetAt: null }
    ]
  },
  subscription: { status: 'active', planName: 'Plus', planCode: 'plus', periodEnd: '2026-12-01T00:00:00Z' }
}, meta: [] });
const wallet = () => ({ json: { balanceMicro: '3500000', monthSpentMicro: 1_250_000, rateBps: null, paygEnabled: true } });

function deps(answers = {}) {
  const calls = [];
  const bodies = { state: { userId: 'user-a' }, usage: usage(), wallet: wallet(), ...answers };
  return { env: {}, calls, now: () => Date.parse('2026-11-23T02:00:00Z'),
    fetch: async (url, init) => {
      calls.push({ url, init });
      const name = url.endsWith('/auth/state') ? 'state' : url.endsWith('/usage') ? 'usage' : 'wallet';
      const answer = bodies[name];
      if (typeof answer === 'number') return { status: answer, json: async () => ({}) };
      if (answer instanceof Error) throw answer;
      return { status: 200, json: async () => structuredClone(answer) };
    } };
}

test('CodingPass reads live counters, caps and resets for all three windows plus the plan and wallet', async () => {
  const d = deps();
  const result = await fetchCodingpassLimits(options, d);
  assert.equal(result.status, 'ok');
  assert.equal(result.provider, 'codingpass');
  assert.equal(result.source, 'web');
  assert.equal(result.accountKey, hashKey('codingpass', 'user-a'));
  assert.equal(result.planLabel, 'Plus');
  const quotas = result.windows.filter((w) => !w.metric);
  assert.deepEqual(quotas.map((w) => [w.kind, w.used, w.limit, w.remaining, w.usedPercent, w.currency]), [
    ['session', 2.5, 5, 2.5, 50, 'USD'],
    ['weekly', 6, 20, 14, 30, 'USD'],
    ['billing', 12, 50, 38, 24, 'USD']
  ]);
  assert.deepEqual(quotas.map((w) => w.resetsAt), [
    '2026-11-23T06:00:00.000Z', '2026-11-30T00:00:00.000Z', '2026-12-01T00:00:00.000Z'
  ]);
  assert.deepEqual(quotas.map((w) => w.windowMinutes), [300, 10080, null]);
  const credits = result.windows.find((w) => w.metric === 'credits');
  assert.equal(credits.remaining, 3.5);
  assert.equal(credits.showMeter, false);
  assert.equal(result.balance.amount, 3.5);
  assert.equal(result.balance.monthSpend, 1.25);
  assert.deepEqual(d.calls.map((c) => [c.init.method, c.url]), [
    ['GET', `${CODINGPASS_ORIGIN}/api/auth/state`],
    ['POST', `${CODINGPASS_ORIGIN}/api/app/usage`],
    ['POST', `${CODINGPASS_ORIGIN}/api/app/wallet`]
  ]);
  assert.equal(d.calls[1].init.body, '{"json":{}}');
  assert.equal(d.calls[2].init.body, '{}');
  for (const { init } of d.calls) {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Cookie, cookie);
    assert.equal(init.headers.Host, undefined);
    assert.equal(init.headers.Referer, undefined);
    assert.ok(init.signal);
  }
});

test('CodingPass falls back to settled quota counters and leaves an unopened 5-hour window without a reset', async () => {
  const body = usage();
  body.json.live = { window5hStartAt: null, global: [] };
  const result = await fetchCodingpassLimits(options, deps({ usage: body }));
  assert.deepEqual(result.windows.filter((w) => !w.metric).map((w) => [w.kind, w.used, w.resetsAt]), [
    ['session', 1, null],
    ['weekly', 4, null],
    ['billing', 10, '2026-12-01T00:00:00.000Z']
  ]);
});

test('CodingPass leaves uncapped windows out and keeps an empty wallet off the card', async () => {
  const body = usage();
  body.json.quota.limitWeekMicro = null;
  body.json.live.global = body.json.live.global.filter((layer) => layer.layer !== 'global_week');
  body.json.quota.limitMicro = 0;
  body.json.live.global = body.json.live.global.filter((layer) => layer.layer !== 'global_month');
  const result = await fetchCodingpassLimits(options, deps({ usage: body,
    wallet: { json: { balanceMicro: 0, paygEnabled: false } } }));
  assert.deepEqual(result.windows.map((w) => w.kind), ['session']);
  assert.equal(result.balance, null);
});

test('CodingPass converts the wallet by the console rate and survives a failed wallet call', async () => {
  const converted = await fetchCodingpassLimits(options, deps({ wallet: { json: { balanceMicro: 7_000_000, rateBps: 70_000 } } }));
  // 1e6 / 70000 = 14.29 → factor 0.14 (the console rounds the same way)
  assert.equal(converted.balance.amount, 0.98);
  for (const answer of [500, new Error('offline'), { json: { balanceMicro: 'not-a-number' } }]) {
    const result = await fetchCodingpassLimits(options, deps({ wallet: answer }));
    assert.equal(result.status, 'ok');
    assert.equal(result.balance, null);
    assert.equal(result.windows.length, 3);
  }
});

test('CodingPass maps a logged-out session, auth failures and throttling without a false expiry', async () => {
  assert.equal((await fetchCodingpassLimits(options, deps({ state: { userId: null } }))).status, 'unauthorized');
  assert.equal((await fetchCodingpassLimits(options, deps({ state: 401 }))).status, 'unauthorized');
  assert.equal((await fetchCodingpassLimits(options, deps({ usage: 401 }))).status, 'unauthorized');
  assert.equal((await fetchCodingpassLimits(options, deps({ usage: 429 }))).status, 'sourceRateLimited');
  // A 403 or 5xx says nothing about the cookie.
  assert.equal((await fetchCodingpassLimits(options, deps({ state: 403 }))).status, 'unavailable');
  assert.equal((await fetchCodingpassLimits(options, deps({ usage: 502 }))).status, 'unavailable');
  assert.equal((await fetchCodingpassLimits(options, deps({ usage: { json: { quota: { limit5hMicro: 'abc' } } } }))).status, 'unavailable');
  const failed = await fetchCodingpassLimits(options, deps({ usage: 502 }));
  assert.equal(failed.accountKey, hashKey('codingpass', 'user-a'), 'a known account keeps its identity while unavailable');
});

test('CodingPass cookie boundary accepts DevTools copies and rejects malformed input without network', async () => {
  assert.equal(normalizeCodingpassCookieHeader('Cookie: a=one; b=two=='), 'a=one; b=two==');
  assert.equal(normalizeCodingpassCookieHeader('a=one\r\nb=two\n'), 'a=one; b=two');
  for (const value of ['bare-token', 'a=x; invalid', 'curl https://codingpass.ai', 'a=x\u0000', 123]) {
    assert.equal(normalizeCodingpassCookieHeader(value), '');
    const d = deps();
    assert.equal((await fetchCodingpassLimits({ codingpassCookie: value }, d)).status, 'unavailable');
    assert.equal(d.calls.length, 0);
  }
  const d = deps();
  assert.equal((await fetchCodingpassLimits({}, d)).status, 'notConfigured');
  assert.equal(d.calls.length, 0);
  d.env.CODINGPASS_COOKIE = cookie;
  assert.equal((await fetchCodingpassLimits({}, d)).status, 'ok');
  d.env.TOKEN_MONITOR_CODINGPASS_COOKIE = 'session=preferred';
  await fetchCodingpassLimits({}, d);
  assert.equal(d.calls.at(-1).init.headers.Cookie, 'session=preferred');
});

test('CodingPass server identity is distinct from the credential-hash fallback', () => {
  assert.equal(isCodingpassServerAccountKey(hashKey('codingpass', 'user-a'), options), true);
  assert.equal(isCodingpassServerAccountKey(hashKey('codingpass', cookie), options), false);
  assert.equal(isCodingpassServerAccountKey('', options), false);
});

test('CodingPass windows read as 5-hour/Weekly/Monthly with the USD pair under the bar', async () => {
  const result = await fetchCodingpassLimits(options, deps());
  const [session, weekly, monthly] = result.windows;
  assert.deepEqual([session, weekly, monthly].map((w) => limitWindowLabel(result.provider, w)), ['5-hour', 'Weekly', 'Monthly']);
  assert.equal(limitWindowText(result, session).detail, '$2.50 / $5.00');
  assert.equal(limitWindowText(result, session, { showLimitUsed: true }).detail, '$2.50 / $5.00');
  assert.equal(limitWindowText(result, monthly).detail, '$38.00 / $50.00');
  assert.equal(limitWindowText(result, monthly, { showLimitUsed: true }).detail, '$12.00 / $50.00');
  assert.equal(limitWindowText(result, result.windows.find((w) => w.metric === 'credits')).detail, '');
});

test('CodingPass shows a per-model cap only while that model would run out before the plan window', async () => {
  // Shape observed on a live Plus account: most models repeat the plan caps,
  // some groups carry smaller ones. The plan 5-hour window has $2.50 left.
  const layers = (used5h, limit5h) => [
    { layer: 'model_5h', usedMicro: used5h, limitMicro: limit5h, resetAt: '2026-11-23T06:00:00Z' },
    { layer: 'model_month', usedMicro: 1_000_000, limitMicro: 50_000_000, resetAt: '2026-12-01T00:00:00Z' }
  ];
  const body = usage();
  body.json.live.models = [
    { modelKey: 'model-a', label: 'Model A', layers: layers(2_000_000, 5_000_000), estRequestsRemaining5h: 10 },
    { modelKey: 'model-b', label: 'Model B', layers: layers(1_500_000, 2_000_000), estRequestsRemaining5h: 3 },
    // A smaller cap with more left than the plan cannot bind first.
    { modelKey: 'model-c', label: 'Model C', layers: layers(0, 4_000_000), estRequestsRemaining5h: 30 }
  ];
  const result = await fetchCodingpassLimits(options, deps({ usage: body }));
  const extra = result.windows.filter((w) => w.additional);
  assert.deepEqual(extra.map((w) => [w.kind, w.label, w.limitId, w.used, w.limit, w.resetsAt]), [
    ['session', 'Model B', 'codingpass.model.model-b', 1.5, 2, '2026-11-23T06:00:00.000Z']
  ]);
  assert.equal(result.windows.filter((w) => !w.additional && !w.metric).length, 3);
  assert.equal(limitWindowText(result, extra[0]).detail, '$0.50 / $2.00');
});
