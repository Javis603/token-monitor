'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const https = require('node:https');
const test = require('node:test');
const { fetchCursorLimits } = require('../../src/shared/providers/cursor/limits');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { normalizeLimitProvider } = require('../../src/shared/limits/core');

const {
  parseGrokBotUsage,
  parsePlanInfo,
  parseCurrentPeriodUsage,
  parsePrepaidBilling,
  parseUsageSummary,
  parseUserInfo,
  probe
} = require('../../src/shared/providers/cursor/probe');

test('parseUsageSummary maps cents to USD and reads billing cycle end', () => {
  const input = {
    billingCycleStart: '2026-05-01T00:00:00Z',
    billingCycleEnd: '2026-06-01T00:00:00Z',
    membershipType: 'pro',
    individualUsage: {
      plan: { used: 1234, limit: 2000, autoPercentUsed: 30, apiPercentUsed: 70, totalPercentUsed: 50 },
      onDemand: { used: 500, limit: 5000 }
    }
  };
  const result = parseUsageSummary(input);
  assert.equal(result.planUsedUsd, 12.34);
  assert.equal(result.planLimitUsd, 20.0);
  assert.equal(result.onDemandUsedUsd, 5.0);
  assert.equal(result.onDemandLimitUsd, 50.0);
  assert.equal(result.planPercent, 50);
  assert.equal(result.autoPercent, 30);
  assert.equal(result.apiPercent, 70);
  assert.equal(result.billingCycleEnd, '2026-06-01T00:00:00Z');
  assert.equal(result.membershipType, 'pro');
});

test('parseUsageSummary falls back to (used / limit) when totalPercentUsed missing', () => {
  const input = {
    billingCycleEnd: '2026-06-01T00:00:00Z',
    individualUsage: { plan: { used: 500, limit: 2000 } }
  };
  const result = parseUsageSummary(input);
  assert.equal(result.planPercent, 25);
});

test('parseUsageSummary keeps missing total usage unknown instead of synthesizing zero', () => {
  for (const input of [
    {},
    { individualUsage: { plan: {} } },
    { individualUsage: { plan: { autoPercentUsed: 10, apiPercentUsed: 50 } } },
    { individualUsage: { plan: { limit: 2000 } } },
    { individualUsage: { plan: { used: null, limit: 2000 } } },
    { individualUsage: { plan: { used: 500 } } },
    { individualUsage: { overall: { limit: 2000 } } },
    { teamUsage: { pooled: { limit: 2000 } } }
  ]) {
    assert.equal(parseUsageSummary(input).planPercent, null, JSON.stringify(input));
  }
  for (const plan of [{ totalPercentUsed: 0 }, { used: 0, limit: 2000 }]) {
    assert.equal(parseUsageSummary({ individualUsage: { plan } }).planPercent, 0);
  }
});

test('parseUsageSummary never synthesizes a total from the separate model pools', () => {
  const input = {
    billingCycleEnd: '2026-06-01T00:00:00Z',
    individualUsage: { plan: { used: 500, limit: 2000, autoPercentUsed: 10, apiPercentUsed: 50 } }
  };
  const result = parseUsageSummary(input);
  assert.equal(result.planPercent, 25);
});

test('parseUsageSummary limits unified percentages to individual plan data', () => {
  for (const individual of [{}, { overall: { used: 1000, limit: 2000 } }]) {
    for (const [plan, expected] of [
      [{}, null],
      [{ autoPercentUsed: 10, apiPercentUsed: 50 }, null],
      [{ totalPercentUsed: 0 }, 0],
      [{ used: 0, limit: 2000 }, 0],
      [{ used: 500, limit: 2000 }, 25]
    ]) {
      const summary = {
        individualUsage: { ...individual, plan },
        teamUsage: { pooled: { used: 7500, limit: 10000 } }
      };
      assert.equal(parseUsageSummary(summary, { unifiedPlan: true }).planPercent, expected);
      assert.equal(parseUsageSummary(summary).planPercent, expected ?? (individual.overall ? 50 : 75));
    }
  }
});

test('parseGrokBotUsage keeps an exhausted included allowance visible', () => {
  const result = parseGrokBotUsage({
    usagePercent: 100,
    currentPeriodStart: '2026-05-25T00:00:00Z',
    nextResetTimestampUtc: '2026-06-01T00:00:00Z',
    hasAvailableUsage: false,
    hasNonZeroIncludedLimit: true
  });
  assert.deepEqual(result, {
    usedPercent: 100,
    periodStart: '2026-05-25T00:00:00.000Z',
    resetsAt: '2026-06-01T00:00:00.000Z',
    windowMinutes: 7 * 24 * 60,
    hasAvailableUsage: false,
    hasNonZeroIncludedLimit: true,
    isUnified: false
  });
});

test('parseUsageSummary reads legacy request-based usage', () => {
  const input = {
    billingCycleEnd: '2026-06-01T00:00:00Z',
    individualUsage: { plan: { totalPercentUsed: 12 } }
  };
  const requestUsage = { 'gpt-4': { numRequestsTotal: 7, maxRequestUsage: 10 } };
  const result = parseUsageSummary(input, { requestUsage });
  assert.equal(result.requestsUsed, 7);
  assert.equal(result.requestsLimit, 10);
});

test('parseUsageSummary uses enterprise overall when plan is absent', () => {
  const result = parseUsageSummary({
    membershipType: 'enterprise',
    limitType: 'team',
    individualUsage: {
      overall: { enabled: true, used: 7384, limit: 10000, remaining: 2616 }
    },
    teamUsage: {
      pooled: { enabled: true, used: 12725135, limit: 28122000, remaining: 15396865 }
    }
  });
  assert.equal(Math.round(result.planPercent * 100) / 100, 73.84);
  assert.equal(result.planUsedUsd, 73.84);
  assert.equal(result.planLimitUsd, 100);
  assert.equal(result.planRemainingUsd, 26.16);
  assert.equal(result.teamPooledUsedUsd, 127251.35);
  assert.equal(result.teamPooledLimitUsd, 281220);
});

test('parseUsageSummary falls back to enterprise pooled usage when individual data is absent', () => {
  const result = parseUsageSummary({
    membershipType: 'enterprise',
    limitType: 'team',
    teamUsage: {
      pooled: { enabled: true, used: 12725135, limit: 28122000, remaining: 15396865 }
    }
  });
  assert.equal(Math.round(result.planPercent * 100) / 100, 45.25);
  assert.equal(result.planUsedUsd, 127251.35);
  assert.equal(result.planLimitUsd, 281220);
});

test('parseUsageSummary tolerates missing fields', () => {
  const result = parseUsageSummary({});
  assert.equal(result.planPercent, null);
  assert.equal(result.planUsedUsd, 0);
  assert.equal(result.billingCycleEnd, null);
  assert.equal(result.membershipType, null);
});

test('parseUserInfo picks email/name/sub', () => {
  const info = parseUserInfo({ email: 'a@b.com', name: 'Alice', sub: 'user_1', extra: 'ignored' });
  assert.deepEqual(info, { email: 'a@b.com', name: 'Alice', sub: 'user_1' });
});

test('probe returns unauthorized error for 401', async () => {
  const fakeHttps = {
    request(opts, cb) {
      const res = { statusCode: 401, on() {}, headers: {} };
      // emulate the response stream: end immediately
      setImmediate(() => { cb(res); res.on && res.on('data', () => {}); });
      return { on() {}, end() {}, write() {} };
    }
  };
  const result = await probe('tok', { httpsLib: fakeHttps });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'unauthorized');
});

test('probe includes legacy request usage when auth returns a user id', async () => {
  const calls = [];
  const fakeHttps = {
    request(opts, cb) {
      const call = { path: opts.path, method: opts.method, headers: opts.headers, body: '', timeoutMs: null };
      calls.push(call);
      let payload;
      if (opts.path === '/api/usage-summary') {
        payload = {
          billingCycleEnd: '2026-06-01T00:00:00Z',
          individualUsage: { plan: { totalPercentUsed: 11, autoPercentUsed: 5, apiPercentUsed: 20 } }
        };
      } else if (opts.path === '/api/auth/me') {
        payload = { email: 'a@b.com', name: 'Alice', sub: 'user_1' };
      } else if (opts.path === '/api/usage?user=user_1') {
        payload = { 'gpt-4': { numRequestsTotal: 4, maxRequestUsage: 8 } };
      } else if (opts.path === '/api/dashboard/get-sand-usage-status') {
        payload = {
          usagePercent: 100,
          currentPeriodStart: '2026-05-25T00:00:00Z',
          nextResetTimestampUtc: '2026-06-01T00:00:00Z',
          hasAvailableUsage: false,
          hasNonZeroIncludedLimit: true
        };
      } else {
        payload = {};
      }
      const res = new EventEmitter();
      res.statusCode = 200;
      setImmediate(() => {
        cb(res);
        setImmediate(() => {
          res.emit('data', Buffer.from(JSON.stringify(payload)));
          res.emit('end');
        });
      });
      return {
        on() {},
        end() {},
        write(chunk) { call.body += String(chunk); },
        setTimeout(timeoutMs) { call.timeoutMs = timeoutMs; }
      };
    }
  };

  const result = await probe('tok', { httpsLib: fakeHttps });
  assert.equal(result.ok, true);
  assert.equal(result.usage.requestsUsed, 4);
  assert.equal(result.usage.requestsLimit, 8);
  assert.equal(result.usage.grokBot.usedPercent, 100);
  assert.equal(result.usage.grokBot.hasAvailableUsage, false);
  assert.deepEqual(
    calls.map((call) => call.path).sort(),
    ['/api/auth/me', '/api/dashboard/get-plan-info', '/api/dashboard/get-sand-usage-status', '/api/usage-summary', '/api/usage?user=user_1'].sort()
  );
  assert.deepEqual(new Set(calls.map((call) => call.headers.Referer)), new Set(['https://cursor.com/dashboard']));
  const sand = calls.find((call) => call.path === '/api/dashboard/get-sand-usage-status');
  assert.equal(sand.method, 'POST');
  assert.equal(sand.headers.Origin, 'https://cursor.com');
  assert.equal(sand.headers['Content-Type'], 'application/json');
  assert.equal(sand.body, '{}');
  assert.equal(sand.timeoutMs, 5000);
});

test('probe treats Grok Bot as a best-effort optional request', async () => {
  const fakeHttps = {
    request(opts, cb) {
      const res = new EventEmitter();
      res.statusCode = opts.path === '/api/dashboard/get-sand-usage-status' ? 500 : 200;
      const payload = opts.path === '/api/usage-summary'
        ? { individualUsage: { plan: { autoPercentUsed: 20, apiPercentUsed: 40 } } }
        : {};
      setImmediate(() => {
        cb(res);
        if (res.statusCode === 200) setImmediate(() => {
          res.emit('data', Buffer.from(JSON.stringify(payload)));
          res.emit('end');
        });
      });
      return { on() {}, end() {}, write() {}, setTimeout() {} };
    }
  };

  const result = await probe('tok', { httpsLib: fakeHttps });
  assert.equal(result.ok, true);
  assert.equal(result.usage.autoPercent, 20);
  assert.equal(result.usage.apiPercent, 40);
  assert.equal(result.usage.grokBot, null);
});

test('probe destroys in-flight HTTPS requests when the parent signal aborts', async () => {
  const controller = new AbortController();
  const requests = [];
  const fakeHttps = {
    request() {
      const req = new EventEmitter();
      req.end = () => {};
      req.write = () => {};
      req.setTimeout = () => {};
      req.destroy = () => { req.destroyed = true; };
      requests.push(req);
      return req;
    }
  };

  const pending = probe('tok', { httpsLib: fakeHttps, signal: controller.signal });
  controller.abort(new Error('stop cursor probe'));

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'network');
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.destroyed));
});

// Shapes below follow the proto3 JSON the dashboard returned to a live legacy
// account: int64 as strings, full enum names, zero values omitted.
test('parsePlanInfo reads a unified weekly plan from proto3 JSON', () => {
  assert.deepEqual(parsePlanInfo({
    isMerged: true,
    planInfo: {
      planName: 'Premium',
      includedAmountCents: 6000,
      billingCycleEnd: '1793179761487',
      includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY',
      includedUsageResetsAt: '1792800000000'
    }
  }), {
    isMerged: true,
    planName: 'Premium',
    includedUsagePeriod: 'weekly',
    includedUsageResetsAt: new Date(1792800000000).toISOString(),
    billingCycleEnd: new Date(1793179761487).toISOString()
  });
});

test('parsePlanInfo treats omitted proto3 fields as a legacy plan', () => {
  assert.deepEqual(parsePlanInfo({ planInfo: { planName: 'Free', price: 'Free', billingCycleEnd: '1793179761487' } }), {
    isMerged: false,
    planName: 'Free',
    includedUsagePeriod: null,
    includedUsageResetsAt: null,
    billingCycleEnd: new Date(1793179761487).toISOString()
  });
  assert.equal(parsePlanInfo(null).isMerged, false);
});

test('parsePlanInfo keeps out-of-range dates unknown without losing valid fields', () => {
  for (const invalid of [8640000000000001, '8640000000000001', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
    for (const field of ['includedUsageResetsAt', 'billingCycleEnd']) {
      const info = parsePlanInfo({ isMerged: true, planInfo: {
        planName: 'Premium',
        includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY',
        includedUsageResetsAt: '1792800000000',
        billingCycleEnd: '1793179761487',
        [field]: invalid
      } });
      assert.equal(info[field], null);
      assert.equal(info.isMerged, true);
      assert.equal(info.planName, 'Premium');
      const other = field === 'billingCycleEnd' ? 'includedUsageResetsAt' : 'billingCycleEnd';
      assert.notEqual(info[other], null);
    }
  }
  for (const boundary of [8640000000000000, '8640000000000000']) {
    assert.equal(parsePlanInfo({ planInfo: { includedUsageResetsAt: boundary } }).includedUsageResetsAt,
      '+275760-09-13T00:00:00.000Z');
  }
});

test('parsePrepaidBilling reads int64 cents and an omitted balance as zero', () => {
  assert.deepEqual(parsePrepaidBilling({ billingMode: 'PREPAID_BILLING_MODE_PREPAID', availableCents: '1446' }), { availableUsd: 14.46 });
  assert.deepEqual(parsePrepaidBilling({}), { availableUsd: 0 });
  assert.deepEqual(parsePrepaidBilling({ availableCents: 'abc' }), { availableUsd: null });
});

function dashboardFakeHttps(payloads, calls = []) {
  return {
    request(opts, cb) {
      calls.push(opts.path);
      const res = new EventEmitter();
      // A null payload stands for an unavailable endpoint.
      res.statusCode = payloads[opts.path] === null ? 500 : 200;
      setImmediate(() => {
        cb(res);
        if (res.statusCode === 200) setImmediate(() => {
          res.emit('data', Buffer.from(JSON.stringify(payloads[opts.path] || {})));
          res.emit('end');
        });
      });
      return { on() {}, end() {}, write() {}, setTimeout() {} };
    }
  };
}

test('unknown Cursor plans do not turn legacy summary zeros into full model pools', async () => {
  const result = await fetchCursorLimits({}, {
    readActiveAccount: () => ({ id: 'acct-1', sessionToken: 'tok' }),
    httpsLib: dashboardFakeHttps({
      '/api/usage-summary': { individualUsage: { plan: { autoPercentUsed: 0, apiPercentUsed: 0 } } },
      '/api/dashboard/get-plan-info': null,
      '/api/dashboard/get-sand-usage-status': null
    })
  });
  assert.deepEqual(result.windows, []);
  assert.equal(result.status, 'unavailable');
});

test('unknown Cursor plans preserve independent team and spend data without legacy seat quotas', async () => {
  const result = await fetchCursorLimits({}, {
    readActiveAccount: () => ({ id: 'acct-1', sessionToken: 'tok' }),
    httpsLib: dashboardFakeHttps({
      '/api/usage-summary': {
        individualUsage: {
          plan: { autoPercentUsed: 0, apiPercentUsed: 0 },
          overall: { used: 1000, limit: 2000 },
          onDemand: { used: 300, limit: 1000 }
        },
        teamUsage: { pooled: { used: 7500, limit: 10000 } }
      },
      '/api/dashboard/get-plan-info': null,
      '/api/dashboard/get-sand-usage-status': null
    })
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.windows.map((window) => window.label), ['Team pool', 'On-demand spend']);
  assert.equal(result.windows[0].usedPercent, 75);
  assert.equal(result.windows[1].used, 3);
});

test('unknown Cursor plans do not expose legacy Requests or Overall fallback rows', async () => {
  for (const requestUsage of [{ 'gpt-4': { numRequests: 0, maxRequestUsage: 500 } }, {}]) {
    const result = await fetchCursorLimits({}, {
      readActiveAccount: () => ({ id: 'acct-1', sessionToken: 'tok' }),
      httpsLib: dashboardFakeHttps({
        '/api/auth/me': { sub: 'fixture-user' },
        '/api/usage?user=fixture-user': requestUsage,
        '/api/usage-summary': { individualUsage: { overall: { used: 1000, limit: 2000 } } },
        '/api/dashboard/get-plan-info': null,
        '/api/dashboard/get-sand-usage-status': null
      })
    });
    assert.deepEqual(result.windows, []);
    assert.equal(result.status, 'unavailable');
  }
});

test('successful proto3 legacy identification keeps genuine zero model pools', async () => {
  for (const [planInfo, sand] of [[{}, null], [null, {}], [{}, { isUnified: true, usagePercent: 40 }]]) {
    const result = await fetchCursorLimits({}, {
      readActiveAccount: () => ({ id: 'acct-1', sessionToken: 'tok' }),
      httpsLib: dashboardFakeHttps({
        '/api/usage-summary': { individualUsage: { plan: { autoPercentUsed: 0, apiPercentUsed: 0 } } },
        '/api/dashboard/get-plan-info': planInfo,
        '/api/dashboard/get-sand-usage-status': sand
      })
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.windows.map((window) => [window.label, window.usedPercent]), [
      ['Cursor Models', 0], ['Other Models', 0]
    ]);
  }
});

test('Cursor unknown-plan results invalidate only cached legacy seat quotas through the runtime', async (t) => {
  const summary = { individualUsage: { plan: { autoPercentUsed: 0, apiPercentUsed: 0 } } };
  const account = { id: 'fixture-account', sessionToken: 'tok' };
  const seed = await fetchCursorLimits({}, {
    readActiveAccount: () => account,
    httpsLib: dashboardFakeHttps({ '/api/usage-summary': summary })
  });
  const other = { ...seed, accountKey: 'other-account' };
  const team = { kind: 'billing', label: 'Team pool', usedPercent: 75 };
  const spend = { kind: 'billing', label: 'On-demand spend', metric: 'spend', used: 3, limit: 10, currency: 'USD' };
  const included = { kind: 'weekly', label: 'Included usage', usedPercent: 40 };
  for (const scenario of [
    { name: 'persisted full model pools', windows: seed.windows, expected: [] },
    { name: 'persisted unavailable model pools', windows: seed.windows, seedStatus: 'unavailable', expected: [] },
    {
      name: 'request quota with independent data',
      windows: [{ kind: 'billing', label: 'Requests', usedPercent: 0 }, team, spend],
      expected: ['Team pool', 'On-demand spend']
    },
    {
      name: 'overall quota with independent data',
      windows: [{ kind: 'billing', label: 'Overall', usedPercent: 0 }, team],
      expected: ['Team pool']
    },
    { name: 'previously confirmed unified quota', windows: [included], expected: ['Included usage'] },
    { name: 'ordinary summary failure keeps last-good model pools', windows: seed.windows, summaryFails: true, expected: ['Cursor Models', 'Other Models'] }
  ]) {
    await t.test(scenario.name, async (t) => {
      const payloads = {
        '/api/usage-summary': scenario.summaryFails ? null : summary,
        '/api/dashboard/get-plan-info': null,
        '/api/dashboard/get-sand-usage-status': null
      };
      const runtime = createLimitsRuntime({
        limitProviders: ['cursor'],
        previousLimits: { providers: [{ ...seed, status: scenario.seedStatus || 'ok', windows: scenario.windows }, other] }
      }, {
        autoStart: false,
        autoRetry: false,
        probeProvider: async () => [await fetchCursorLimits({}, {
          readActiveAccount: () => account,
          httpsLib: dashboardFakeHttps(payloads)
        })]
      });
      t.after(() => runtime.stop());
      const scope = { provider: 'cursor', accountKey: seed.accountKey };
      const before = runtime.getSnapshot();
      assert.deepEqual(before.providers[0].windows.map((window) => window.label),
        scenario.windows.map((window) => window.label));
      await runtime.refresh(scope, 'credential-change');
      const snapshot = runtime.getSnapshot();
      const row = snapshot.providers.find((provider) => provider.accountKey === seed.accountKey);
      assert.equal(row.status, 'unavailable');
      assert.deepEqual(row.windows.map((window) => window.label), scenario.expected);
      assert.deepEqual(snapshot.providers.find((provider) => provider.accountKey === other.accountKey),
        before.providers.find((provider) => provider.accountKey === other.accountKey));
      assert.equal(JSON.stringify(snapshot).includes('invalidateCachedWindowLabels'), false);

      // Another transient failure must not bring the invalidated quotas back.
      payloads['/api/usage-summary'] = null;
      await runtime.refresh(scope, 'credential-change');
      assert.deepEqual(runtime.getSnapshot().providers.find((provider) => provider.accountKey === seed.accountKey)
        .windows.map((window) => window.label), scenario.expected);

      if (scenario.name === 'persisted full model pools') {
        const restarted = createLimitsRuntime({
          limitProviders: ['cursor'], previousLimits: runtime.getSnapshot()
        }, { autoStart: false, autoRetry: false });
        t.after(() => restarted.stop());
        assert.deepEqual(restarted.getSnapshot().providers.find((provider) => provider.accountKey === seed.accountKey).windows, []);

        // A later successful legacy lookup can report genuine zero usage again.
        payloads['/api/usage-summary'] = summary;
        payloads['/api/dashboard/get-plan-info'] = {};
        await runtime.refresh(scope, 'credential-change');
        const recovered = runtime.getSnapshot().providers.find((provider) => provider.accountKey === seed.accountKey);
        assert.equal(recovered.status, 'ok');
        assert.deepEqual(recovered.windows.map((window) => [window.label, window.usedPercent]), [
          ['Cursor Models', 0], ['Other Models', 0]
        ]);
      }
    });
  }
});

test('unknown plans retain cached unified usage as stale while refreshing independent windows', async (t) => {
  for (const scenario of [
    { name: 'team', team: true },
    { name: 'spend', spend: true },
    { name: 'team and spend', team: true, spend: true },
    { name: 'independent data without a cached unified window', team: true, spend: true, noIncluded: true }
  ]) {
    await t.test(scenario.name, async (t) => {
      const account = { id: 'partial-fixture', sessionToken: 'tok' };
      const payloads = {
        '/api/usage-summary': {
          individualUsage: {
            plan: { autoPercentUsed: 0, apiPercentUsed: 0 },
            ...(scenario.spend ? { onDemand: { used: 300, limit: 1000 } } : {})
          },
          ...(scenario.team ? { teamUsage: { pooled: { used: 7500, limit: 10000 } } } : {})
        },
        '/api/dashboard/get-plan-info': null,
        '/api/dashboard/get-sand-usage-status': null
      };
      const fetchCurrent = () => fetchCursorLimits({}, {
        readActiveAccount: () => account,
        now: () => new Date('2026-10-20T00:00:00.000Z'),
        httpsLib: dashboardFakeHttps(payloads)
      });
      const current = await fetchCurrent();
      const previousAt = '2026-10-19T00:00:00.000Z';
      const included = { kind: 'weekly', label: 'Included usage', usedPercent: 40 };
      const previous = {
        ...current, status: 'ok', updatedAt: previousAt,
        windows: [
          ...(scenario.noIncluded ? [] : [included]),
          ...['Requests', 'Cursor Models', 'Other Models', 'Overall'].map((label) => ({ kind: 'billing', label, usedPercent: 0 })),
          ...current.windows.map((window) => ({ ...window, usedPercent: 10, used: 1 }))
        ]
      };
      const other = { ...previous, accountKey: 'unaffected-account' };
      const events = [];
      const runtime = createLimitsRuntime({
        limitProviders: ['cursor'], previousLimits: { providers: [previous, other] }
      }, {
        autoStart: false, autoRetry: false,
        probeProvider: async () => [await fetchCurrent()],
        onEvent: (event) => events.push(event)
      });
      t.after(() => runtime.stop());
      const scope = { provider: 'cursor', accountKey: current.accountKey };
      const rowFor = (snapshot) => snapshot.providers.find((row) => row.accountKey === current.accountKey);
      const before = runtime.getSnapshot();
      await runtime.refresh(scope, 'credential-change');
      const snapshot = runtime.getSnapshot();
      const row = rowFor(snapshot);
      const expectedLabels = [...(scenario.noIncluded ? [] : ['Included usage']), ...current.windows.map((window) => window.label)];
      assert.deepEqual(row.windows.map((window) => window.label), expectedLabels);
      assert.deepEqual(row.windows.slice(scenario.noIncluded ? 0 : 1), normalizeLimitProvider(current).windows);
      if (scenario.team) assert.equal(row.windows.find((window) => window.label === 'Team pool').usedPercent, 75);
      if (scenario.spend) assert.equal(row.windows.find((window) => window.label === 'On-demand spend').used, 3);
      assert.equal(row.status, scenario.noIncluded ? 'ok' : 'unavailable');
      assert.equal(row.updatedAt, scenario.noIncluded ? current.updatedAt : previousAt);
      assert.equal(events.some((event) => event.type === 'retry-scheduled' && event.reason === 'unavailable'), !scenario.noIncluded);
      assert.deepEqual(snapshot.providers.find((provider) => provider.accountKey === other.accountKey),
        before.providers.find((provider) => provider.accountKey === other.accountKey));
      assert.equal(JSON.stringify(snapshot).includes('invalidateCachedWindowLabels'), false);
      if (scenario.noIncluded) return;

      // Repeated partial reads replace independent values without duplicates or
      // promoting the retained included pool to a fresh successful reading.
      if (scenario.team) payloads['/api/usage-summary'].teamUsage.pooled.used = 8000;
      if (scenario.spend) payloads['/api/usage-summary'].individualUsage.onDemand.used = 400;
      await runtime.refresh(scope, 'credential-change');
      const repeated = rowFor(runtime.getSnapshot());
      assert.equal(repeated.status, 'unavailable');
      assert.equal(repeated.updatedAt, previousAt);
      assert.deepEqual(repeated.windows.map((window) => window.label), expectedLabels);
      assert.equal(repeated.windows[0].usedPercent, 40);
      if (scenario.team) assert.equal(repeated.windows.find((window) => window.label === 'Team pool').usedPercent, 80);
      if (scenario.spend) assert.equal(repeated.windows.find((window) => window.label === 'On-demand spend').used, 4);

      payloads['/api/usage-summary'] = null;
      await runtime.refresh(scope, 'credential-change');
      assert.deepEqual(rowFor(runtime.getSnapshot()), repeated);
      const restarted = createLimitsRuntime({
        limitProviders: ['cursor'], previousLimits: runtime.getSnapshot()
      }, { autoStart: false, autoRetry: false });
      t.after(() => restarted.stop());
      assert.deepEqual(rowFor(restarted.getSnapshot()), repeated);

      // A confirmed current unified reading replaces the cache normally.
      payloads['/api/usage-summary'] = {};
      payloads['/api/dashboard/get-plan-info'] = { isMerged: true };
      payloads['/api/dashboard/get-sand-usage-status'] = { isUnified: true, usagePercent: 55 };
      await runtime.refresh(scope, 'credential-change');
      const recovered = rowFor(runtime.getSnapshot());
      assert.equal(recovered.status, 'ok');
      assert.notEqual(recovered.updatedAt, previousAt);
      assert.deepEqual(recovered.windows.map((window) => [window.label, window.usedPercent]), [['Included usage', 55]]);

      // A confirmed legacy plan also replaces the cache, restoring real zeros.
      payloads['/api/usage-summary'] = { individualUsage: { plan: { autoPercentUsed: 0, apiPercentUsed: 0 } } };
      payloads['/api/dashboard/get-plan-info'] = {};
      payloads['/api/dashboard/get-sand-usage-status'] = null;
      await runtime.refresh(scope, 'credential-change');
      const legacy = rowFor(runtime.getSnapshot());
      assert.equal(legacy.status, 'ok');
      assert.deepEqual(legacy.windows.map((window) => [window.label, window.usedPercent]), [['Cursor Models', 0], ['Other Models', 0]]);
    });
  }
});

test('unified limits use summary fallback only for an explicitly monthly period', async () => {
  for (const [summary, expected] of [
    [{}, null],
    [{ individualUsage: { plan: {} } }, null],
    [{ individualUsage: { plan: { autoPercentUsed: 10, apiPercentUsed: 50 } } }, null],
    [{ individualUsage: { plan: { limit: 2000 } } }, null],
    [{ individualUsage: { plan: { totalPercentUsed: 0 } } }, 0],
    [{ individualUsage: { plan: { totalPercentUsed: 30 } } }, 30],
    [{ individualUsage: { plan: { used: 0, limit: 2000 } } }, 0],
    [{ individualUsage: { plan: { used: 500, limit: 2000 } } }, 25]
  ]) {
    for (const planInfo of [
      { isMerged: true, planInfo: { includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY' } },
      { isMerged: true, planInfo: { includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_MONTHLY' } },
      { isMerged: true },
      { isMerged: true, planInfo: { includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_UNSPECIFIED' } },
      null
    ]) {
      const monthly = planInfo?.planInfo?.includedUsagePeriod === 'INCLUDED_USAGE_PERIOD_MONTHLY';
      const result = await fetchCursorLimits({}, {
        readActiveAccount: () => ({ id: 'acct-1', sessionToken: 'user_fixture%3A%3Aaa.bb.cc' }),
        httpsLib: dashboardFakeHttps({
          '/api/usage-summary': {
            ...summary,
            billingCycleEnd: '2026-11-01T00:00:00Z',
            teamUsage: { pooled: { used: 7500, limit: 10000 } }
          },
          '/api/dashboard/get-plan-info': planInfo,
          '/api/dashboard/get-sand-usage-status': { isUnified: true },
          '/api/dashboard/get-user-prepaid-billing': { availableCents: '1446' },
          '/aiserver.v1.DashboardService/GetCurrentPeriodUsage': null
        })
      });
      const included = result.windows.find((window) => window.label === 'Included usage');
      assert.equal(result.status, 'ok');
      if (!monthly || expected === null) assert.equal(included, undefined, JSON.stringify({ summary, planInfo }));
      else {
        assert.equal(included?.usedPercent, expected);
        assert.equal(included.kind, 'billing');
        assert.equal(included.resetsAt, '2026-11-01T00:00:00.000Z');
        assert.equal(included.windowMinutes, null);
      }
      const team = result.windows.find((window) => window.label === 'Team pool');
      assert.equal(team?.usedPercent, 75);
      assert.equal(team.kind, 'billing');
      assert.equal(team.resetsAt, '2026-11-01T00:00:00.000Z');
      assert.equal(result.windows.find((window) => window.label === 'Prepaid balance')?.remaining, 14.46);
      assert.ok(!result.windows.some((window) => ['Cursor Models', 'Other Models'].includes(window.label)));
    }
  }
});

test('unified limits never reuse legacy overall or team usage as the included pool', async () => {
  for (const planInfo of [
    { isMerged: true, planInfo: { includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY' } },
    { isMerged: true, planInfo: { includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_MONTHLY' } },
    null,
    { isMerged: false }
  ]) {
    const unified = planInfo?.isMerged !== false;
    const monthly = planInfo?.planInfo?.includedUsagePeriod === 'INCLUDED_USAGE_PERIOD_MONTHLY';
    for (const overall of [undefined, { used: 1000, limit: 2000 }]) {
      for (const [plan, expected] of [[{}, null], [{ totalPercentUsed: 0 }, 0], [{ used: 500, limit: 2000 }, 25]]) {
        const result = await fetchCursorLimits({}, {
          readActiveAccount: () => ({ id: 'acct-1', sessionToken: 't' }),
          httpsLib: dashboardFakeHttps({
            '/api/usage-summary': {
              individualUsage: { plan, overall },
              teamUsage: { pooled: { used: 7500, limit: 10000 } },
              billingCycleEnd: '2026-11-01T00:00:00Z'
            },
            '/api/dashboard/get-plan-info': planInfo,
            '/api/dashboard/get-sand-usage-status': { isUnified: true },
            '/api/dashboard/get-user-prepaid-billing': { availableCents: '1446' }
          })
        });
        assert.equal(result.status, 'ok');
        const included = result.windows.find((window) => window.label === 'Included usage');
        if (!unified || !monthly || expected === null) assert.equal(included, undefined);
        else assert.equal(included?.usedPercent, expected);
        const team = result.windows.find((window) => window.label === 'Team pool');
        assert.equal(team?.usedPercent, 75);
        assert.equal(team?.kind, 'billing');
        assert.equal(team?.used, 75);
        assert.equal(team?.limit, 100);
        const prepaid = result.windows.find((window) => window.label === 'Prepaid balance');
        if (unified) assert.equal(prepaid?.remaining, 14.46);
        else assert.equal(prepaid, undefined);
        if (!unified && overall) {
          assert.equal(result.windows.find((window) => window.label === 'Overall')?.usedPercent, expected ?? 50);
        }
      }
    }
  }
});

test('probe keeps a unified account available when plan timestamps exceed the Date range', async () => {
  const result = await probe('tok', { httpsLib: dashboardFakeHttps({
    '/api/usage-summary': { individualUsage: { plan: { totalPercentUsed: 30 } } },
    '/api/dashboard/get-sand-usage-status': { isUnified: true, usagePercent: 30 },
    '/api/dashboard/get-plan-info': {
      isMerged: true,
      planInfo: {
        includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY',
        includedUsageResetsAt: '8640000000000001',
        billingCycleEnd: '8640000000000001'
      }
    },
    '/api/dashboard/get-user-prepaid-billing': { availableCents: '1446' }
  }) });
  assert.equal(result.ok, true);
  assert.equal(result.usage.planPercent, 30);
  assert.equal(result.usage.planInfo.isMerged, true);
  assert.equal(result.usage.planInfo.includedUsageResetsAt, null);
  assert.equal(result.usage.planInfo.billingCycleEnd, null);
  assert.equal(result.usage.prepaid.availableUsd, 14.46);
});

test('probe fetches the prepaid balance only for unified plans', async () => {
  const legacyCalls = [];
  const legacy = await probe('tok', { httpsLib: dashboardFakeHttps({
    '/api/usage-summary': { individualUsage: { plan: { autoPercentUsed: 1, apiPercentUsed: 2 } } },
    '/api/dashboard/get-plan-info': { planInfo: { planName: 'Pro' } }
  }, legacyCalls) });
  assert.equal(legacy.usage.planInfo.isMerged, false);
  assert.equal(legacy.usage.prepaid, null);
  assert.ok(!legacyCalls.includes('/api/dashboard/get-user-prepaid-billing'));

  const unified = await probe('tok', { httpsLib: dashboardFakeHttps({
    '/api/usage-summary': { individualUsage: { plan: { totalPercentUsed: 30 } } },
    '/api/dashboard/get-sand-usage-status': { isUnified: true, usagePercent: 30 },
    '/api/dashboard/get-plan-info': {
      isMerged: true,
      planInfo: { planName: 'Plus', includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY', includedUsageResetsAt: '1792800000000' }
    },
    '/api/dashboard/get-user-prepaid-billing': { availableCents: '2500' }
  }) });
  assert.equal(unified.usage.planPercent, 30);
  assert.equal(unified.usage.planInfo.includedUsagePeriod, 'weekly');
  assert.deepEqual(unified.usage.prepaid, { availableUsd: 25 });
});

test('probe treats the sand unified flag as a unified plan when plan info is unavailable', async () => {
  const calls = [];
  const result = await probe('tok', { httpsLib: dashboardFakeHttps({
    '/api/usage-summary': { individualUsage: { plan: { totalPercentUsed: 5 } } },
    '/api/dashboard/get-sand-usage-status': { usagePercent: 5, isUnified: true },
    '/api/dashboard/get-plan-info': null
  }, calls) });
  assert.equal(result.usage.grokBot.isUnified, true);
  assert.ok(calls.includes('/api/dashboard/get-user-prepaid-billing'));
  assert.deepEqual(result.usage.prepaid, { availableUsd: 0 });
});

const UNIFIED_SESSION = 'user_live%3A%3Aaa.bb.cc';
const PERIOD_USAGE_PATH = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';

test('parseCurrentPeriodUsage reads the settings percent and ignores a missing plan', () => {
  assert.equal(parseCurrentPeriodUsage({
    planUsage: { totalPercentUsed: 13.087757313109426 },
    displayMessage: "You've used 13% of your included usage"
  }).totalPercentUsed, 13.087757313109426);
  assert.equal(parseCurrentPeriodUsage({ planUsage: { totalPercentUsed: '13.5' } }).totalPercentUsed, 13.5);
  assert.equal(parseCurrentPeriodUsage({ planUsage: { totalPercentUsed: 0 } }).totalPercentUsed, 0);
  assert.equal(parseCurrentPeriodUsage({}).totalPercentUsed, null);
  assert.equal(parseCurrentPeriodUsage({ planUsage: { totalPercentUsed: 'nope' } }).totalPercentUsed, null);
});

test('fetchCursorLimits prefers current-period usage over a zero usage-summary on unified plans', async () => {
  const seen = [];
  const result = await fetchCursorLimits({}, {
    readActiveAccount: () => ({ id: 'acct-1', sessionToken: UNIFIED_SESSION }),
    httpsLib: {
      request(opts, cb) {
        seen.push(opts);
        return dashboardFakeHttps({
          '/api/usage-summary': {
            membershipType: 'premium',
            individualUsage: { plan: { totalPercentUsed: 0, used: 0, limit: 4615 } }
          },
          '/api/dashboard/get-plan-info': {
            isMerged: true,
            planInfo: { planName: 'Premium', includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY' }
          },
          '/api/dashboard/get-sand-usage-status': { usagePercent: 4, isUnified: true },
          '/api/dashboard/get-user-prepaid-billing': {},
          [PERIOD_USAGE_PATH]: { planUsage: { totalPercentUsed: 13.087757313109426 } }
        }).request(opts, cb);
      }
    }
  });
  const period = seen.find((opts) => opts.path === PERIOD_USAGE_PATH);
  assert.equal(period.method, 'POST');
  assert.equal(period.headers.Authorization, 'Bearer aa.bb.cc');
  assert.equal(period.headers.Cookie, undefined);
  assert.equal(period.headers['Connect-Protocol-Version'], '1');
  const included = result.windows.find((window) => window.label === 'Included usage');
  assert.equal(included.usedPercent, 13.087757313109426);
  assert.equal(included.kind, 'weekly');
  assert.deepEqual(result.windows.map((window) => window.label), ['Included usage']);
});

test('unified included usage falls back to the sand percent when current-period usage fails', async () => {
  const result = await fetchCursorLimits({}, {
    readActiveAccount: () => ({ id: 'acct-1', sessionToken: UNIFIED_SESSION }),
    httpsLib: dashboardFakeHttps({
      '/api/usage-summary': { individualUsage: { plan: { totalPercentUsed: 0 } } },
      '/api/dashboard/get-plan-info': { isMerged: true },
      '/api/dashboard/get-sand-usage-status': { usagePercent: 13.087757313109426, isUnified: true },
      '/api/dashboard/get-user-prepaid-billing': {},
      [PERIOD_USAGE_PATH]: null
    })
  });
  assert.equal(result.windows.find((window) => window.label === 'Included usage').usedPercent, 13.087757313109426);
});

test('current-period timeout is capped and preserves fallback limits', async (t) => {
  for (const scenario of [
    { name: 'default timeout with sand usage', timeoutMs: undefined, expectedTimeout: 5000, sandPercent: 13, period: 'WEEKLY', expectedPercent: 13 },
    { name: 'shorter timeout with sand zero', timeoutMs: 2000, expectedTimeout: 2000, sandPercent: 0, period: 'WEEKLY', expectedPercent: 0 },
    { name: 'longer timeout with unknown weekly usage', timeoutMs: 20000, expectedTimeout: 5000, period: 'WEEKLY', expectedPercent: null },
    { name: 'default timeout with monthly summary', timeoutMs: undefined, expectedTimeout: 5000, period: 'MONTHLY', expectedPercent: 30 }
  ]) {
    await t.test(scenario.name, async () => {
      let timeoutMs;
      let onTimeout;
      let destroyed = false;
      const payloads = {
        '/api/usage-summary': {
          billingCycleEnd: '2026-11-01T00:00:00Z',
          individualUsage: { plan: { totalPercentUsed: 30 } },
          teamUsage: { pooled: { used: 7500, limit: 10000 } }
        },
        '/api/dashboard/get-plan-info': { isMerged: true, planInfo: {
          includedUsagePeriod: `INCLUDED_USAGE_PERIOD_${scenario.period}`
        } },
        '/api/dashboard/get-sand-usage-status': { isUnified: true, usagePercent: scenario.sandPercent },
        '/api/dashboard/get-user-prepaid-billing': { availableCents: '1446' }
      };
      const result = await fetchCursorLimits({}, {
        readActiveAccount: () => ({ id: 'acct-1', sessionToken: UNIFIED_SESSION }),
        timeoutMs: scenario.timeoutMs,
        httpsLib: {
          request(opts, cb) {
            if (opts.path !== PERIOD_USAGE_PATH) return dashboardFakeHttps(payloads).request(opts, cb);
            const req = new EventEmitter();
            req.write = () => {};
            req.setTimeout = (ms, callback) => { timeoutMs = ms; onTimeout = callback; };
            req.destroy = (error) => { destroyed = true; req.emit('error', error); };
            // Trigger the registered socket timeout without waiting in real time.
            req.end = () => setImmediate(() => onTimeout());
            return req;
          }
        }
      });
      assert.equal(destroyed, true);
      assert.equal(result.status, 'ok');
      const included = result.windows.find((window) => window.label === 'Included usage');
      if (scenario.expectedPercent === null) assert.equal(included, undefined);
      else {
        assert.equal(included?.usedPercent, scenario.expectedPercent);
        assert.equal(included.kind, scenario.period === 'MONTHLY' ? 'billing' : 'weekly');
      }
      assert.equal(result.windows.find((window) => window.label === 'Prepaid balance')?.remaining, 14.46);
      assert.equal(result.windows.find((window) => window.label === 'Team pool')?.usedPercent, 75);
      assert.equal(timeoutMs, scenario.expectedTimeout);
    });
  }
});

test('current-period deadline aborts a stalled DNS lookup and preserves fallback', async (t) => {
  for (const scenario of [
    { name: 'default deadline with sand usage', timeoutMs: undefined, deadlineMs: 5000, sandPercent: 13, period: 'WEEKLY', expectedPercent: 13 },
    { name: 'shorter deadline with sand zero', timeoutMs: 2000, deadlineMs: 2000, sandPercent: 0, period: 'WEEKLY', expectedPercent: 0 },
    { name: 'capped deadline with unknown weekly usage', timeoutMs: 20000, deadlineMs: 5000, period: 'WEEKLY', expectedPercent: null },
    { name: 'default deadline with monthly summary', timeoutMs: undefined, deadlineMs: 5000, period: 'MONTHLY', expectedPercent: 30 }
  ]) {
    await t.test(scenario.name, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const controller = new AbortController();
      let request;
      let lookupStarted;
      const started = new Promise((resolve) => { lookupStarted = resolve; });
      const pending = fetchCursorLimits({}, {
        readActiveAccount: () => ({ id: 'acct-1', sessionToken: UNIFIED_SESSION }),
        timeoutMs: scenario.timeoutMs,
        signal: controller.signal,
        httpsLib: {
          request(opts, cb) {
            if (opts.path === PERIOD_USAGE_PATH) {
              // Real ClientRequest, with DNS deliberately never completing.
              request = https.request({ ...opts, lookup() { lookupStarted(); } }, cb);
              return request;
            }
            return dashboardFakeHttps({
              '/api/usage-summary': { individualUsage: { plan: { totalPercentUsed: 30 } } },
              '/api/dashboard/get-plan-info': { isMerged: true, planInfo: {
                includedUsagePeriod: `INCLUDED_USAGE_PERIOD_${scenario.period}`
              } },
              '/api/dashboard/get-sand-usage-status': { isUnified: true, usagePercent: scenario.sandPercent },
              '/api/dashboard/get-user-prepaid-billing': { availableCents: '1446' }
            }).request(opts, cb);
          }
        }
      });
      try {
        await started;
        t.mock.timers.tick(scenario.deadlineMs - 1);
        await new Promise(setImmediate);
        assert.equal(request.destroyed, false);
        t.mock.timers.tick(1);
        await new Promise(setImmediate);
        assert.equal(request.destroyed, true);
        const result = await pending;
        assert.equal(result.status, 'ok');
        const included = result.windows.find((window) => window.label === 'Included usage');
        if (scenario.expectedPercent === null) assert.equal(included, undefined);
        else assert.equal(included?.usedPercent, scenario.expectedPercent);
        assert.equal(result.windows.find((window) => window.label === 'Prepaid balance')?.remaining, 14.46);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      } finally {
        controller.abort(new Error('test cleanup'));
        await pending;
      }
    });
  }
});

test('current-period deadline cleans up after success and parent cancellation', async (t) => {
  for (const cancel of [false, true]) {
    await t.test(cancel ? 'parent cancellation' : 'successful response', async (t) => {
      const setTimer = global.setTimeout;
      const clearTimer = global.clearTimeout;
      const timers = [];
      const cleared = [];
      t.mock.method(global, 'setTimeout', (callback, ms) => {
        const timer = setTimer(callback, ms);
        timers.push({ timer, ms });
        return timer;
      });
      t.mock.method(global, 'clearTimeout', (timer) => { cleared.push(timer); clearTimer(timer); });
      const controller = new AbortController();
      const reason = new Error('parent stopped');
      let destroyedWith = null;
      const result = await probe(UNIFIED_SESSION, {
        signal: controller.signal,
        httpsLib: {
          request(opts, cb) {
            if (cancel && opts.path === PERIOD_USAGE_PATH) {
              const req = new EventEmitter();
              req.write = () => {};
              req.setTimeout = () => {};
              req.destroy = (error) => { destroyedWith = error; req.emit('error', error); };
              req.end = () => setImmediate(() => controller.abort(reason));
              return req;
            }
            return dashboardFakeHttps({
              '/api/dashboard/get-plan-info': { isMerged: true },
              '/api/dashboard/get-sand-usage-status': { isUnified: true, usagePercent: 13 },
              [PERIOD_USAGE_PATH]: { planUsage: { totalPercentUsed: 0 } }
            }).request(opts, cb);
          }
        }
      });
      assert.equal(result.ok, true);
      assert.equal(result.usage.planPercent, cancel ? 13 : 0);
      assert.equal(destroyedWith, cancel ? reason : null);
      assert.equal(timers.length, 1);
      assert.equal(timers[0].ms, 5000);
      assert.deepEqual(cleared, [timers[0].timer]);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
  }
});

test('an explicit current-period zero beats a nonzero sand percent', async () => {
  const result = await probe(UNIFIED_SESSION, { httpsLib: dashboardFakeHttps({
    '/api/usage-summary': { individualUsage: { plan: { totalPercentUsed: 40 } } },
    '/api/dashboard/get-plan-info': { isMerged: true },
    '/api/dashboard/get-sand-usage-status': { usagePercent: 13, isUnified: true },
    [PERIOD_USAGE_PATH]: { planUsage: { totalPercentUsed: 0 } }
  }) });
  assert.equal(result.ok, true);
  assert.equal(result.usage.planPercent, 0);
});

test('weekly unified usage stays unknown without a period value or a valid unified sand value', async () => {
  const withoutAccessToken = await probe('tok', { httpsLib: dashboardFakeHttps({
    '/api/usage-summary': { individualUsage: { plan: { totalPercentUsed: 0, used: 0, limit: 4615 } } },
    '/api/dashboard/get-plan-info': { isMerged: true },
    '/api/dashboard/get-sand-usage-status': { isUnified: true }
  }) });
  assert.equal(withoutAccessToken.usage.planPercent, null);

  const sandNotUnified = await probe(UNIFIED_SESSION, { httpsLib: dashboardFakeHttps({
    '/api/usage-summary': { individualUsage: { plan: { totalPercentUsed: 30 } } },
    '/api/dashboard/get-plan-info': { isMerged: true },
    '/api/dashboard/get-sand-usage-status': { usagePercent: 80, isUnified: false },
    [PERIOD_USAGE_PATH]: null
  }) });
  assert.equal(sandNotUnified.usage.planPercent, null);
});

test('weekly unified limits retain an explicit zero from current-period or unified sand', async () => {
  for (const [period, sandPercent] of [
    [{ planUsage: { totalPercentUsed: 0 } }, 13],
    [{}, 0]
  ]) {
    const result = await fetchCursorLimits({}, {
      readActiveAccount: () => ({ id: 'acct-1', sessionToken: UNIFIED_SESSION }),
      httpsLib: dashboardFakeHttps({
        '/api/usage-summary': { individualUsage: { plan: { totalPercentUsed: 30 } } },
        '/api/dashboard/get-plan-info': { isMerged: true, planInfo: {
          includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY',
          includedUsageResetsAt: '1792800000000'
        } },
        '/api/dashboard/get-sand-usage-status': { isUnified: true, usagePercent: sandPercent },
        [PERIOD_USAGE_PATH]: period
      })
    });
    assert.equal(result.status, 'ok');
    const included = result.windows.find((window) => window.label === 'Included usage');
    assert.equal(included?.usedPercent, 0);
    assert.equal(included.kind, 'weekly');
    assert.equal(included.resetsAt, new Date(1792800000000).toISOString());
  }
});

test('legacy plans do not call current-period usage', async () => {
  const calls = [];
  const result = await probe(UNIFIED_SESSION, { httpsLib: dashboardFakeHttps({
    '/api/usage-summary': { individualUsage: { plan: { autoPercentUsed: 1, apiPercentUsed: 2 } } },
    '/api/dashboard/get-plan-info': { planInfo: { planName: 'Pro' } },
    '/api/dashboard/get-sand-usage-status': { usagePercent: 80, isUnified: false }
  }, calls) });
  assert.equal(result.usage.planInfo.isMerged, false);
  assert.equal(result.usage.autoPercent, 1);
  assert.ok(!calls.includes(PERIOD_USAGE_PATH));
});

test('probe skips the prepaid request when plan info denies a sand unified flag', async () => {
  const calls = [];
  const result = await probe('tok', { httpsLib: dashboardFakeHttps({
    '/api/usage-summary': { individualUsage: { plan: { autoPercentUsed: 1, apiPercentUsed: 2 } } },
    '/api/dashboard/get-sand-usage-status': { usagePercent: 5, isUnified: true },
    '/api/dashboard/get-plan-info': { planInfo: { planName: 'Pro' } }
  }, calls) });
  assert.equal(result.usage.prepaid, null);
  assert.ok(!calls.includes('/api/dashboard/get-user-prepaid-billing'));
});
