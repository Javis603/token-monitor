'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  zaiToken,
  zaiRegion,
  zaiQuotaUrl,
  zaiSubscriptionUrl,
  parseZaiUsage,
  fetchZaiLimits
} = require('../../src/shared/providers/zai/limits');

test('zaiToken accepts Z.ai and GLM compatible API key env names', () => {
  assert.equal(zaiToken({ ZAI_API_KEY: '  "zai-key"  ' }), 'zai-key');
  assert.equal(zaiToken({ Z_AI_API_KEY: 'z-ai-key' }), 'z-ai-key');
  assert.equal(zaiToken({ GLM_API_KEY: 'glm-key' }), 'glm-key');
  assert.equal(zaiToken({ ZHIPU_API_KEY: 'zhipu-key' }), 'zhipu-key');
  assert.equal(zaiToken({}, 'settings-key'), 'settings-key');
  assert.equal(zaiToken({ OPENAI_API_KEY: 'unrelated' }), '');
});

test('zaiRegion maps global and BigModel CN hosts', () => {
  assert.equal(zaiRegion({ zaiApiRegion: 'bigmodel-cn' }), 'bigmodel-cn');
  assert.equal(zaiRegion({ zaiApiRegion: 'cn' }), 'bigmodel-cn');
  assert.equal(zaiRegion({}, { Z_AI_API_HOST: 'open.bigmodel.cn' }), 'bigmodel-cn');
  assert.equal(zaiRegion({}, { TOKEN_MONITOR_ZAI_API_REGION: 'global' }), 'global');
  assert.equal(zaiQuotaUrl('bigmodel-cn'), 'https://open.bigmodel.cn/api/monitor/usage/quota/limit');
  assert.equal(zaiSubscriptionUrl('bigmodel-cn'), 'https://open.bigmodel.cn/api/biz/subscription/list');
});

test('parseZaiUsage maps quota windows to CodexBar labels and order', () => {
  const usage = parseZaiUsage({
    data: {
      level: 'pro',
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 1000, currentValue: 120, remaining: 850, percentage: 12.5 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 2000, currentValue: 250, remaining: 1500, percentage: 25 },
        { type: 'TIME_LIMIT', remaining: 9, percentage: 40 }
      ]
    }
  }, {
    data: [
      { product_name: 'GLM Coding Pro', next_renew_time: '2026-07-13T00:00:00Z' }
    ]
  });

  assert.equal(usage.plan, 'GLM Coding Pro');
  assert.equal(usage.windows.length, 3);
  assert.equal(usage.windows[0].kind, 'session');
  assert.equal(usage.windows[0].label, '5-hour');
  assert.equal(usage.windows[0].usedPercent, 15);
  assert.equal(usage.windows[0].windowMinutes, 5 * 60);
  assert.equal(usage.windows[1].kind, 'weekly');
  assert.equal(usage.windows[1].label, 'Weekly');
  assert.equal(usage.windows[1].usedPercent, 25);
  assert.equal(usage.windows[1].windowMinutes, 7 * 24 * 60);
  assert.equal(usage.windows[2].kind, 'billing');
  assert.equal(usage.windows[2].label, 'MCP');
  assert.equal(usage.windows[2].remaining, 9);
  assert.equal(usage.windows[2].usedPercent, 40);
  assert.equal(usage.windows[2].resetsAt, '2026-07-13T00:00:00.000Z');
});

test('parseZaiUsage treats a single 5-hour token limit as the old-plan session window', () => {
  const usage = parseZaiUsage({
    data: {
      limits: [
        { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 100, currentValue: 13, remaining: 87, percentage: 13 },
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 12, nextResetTime: '2026-07-07T18:00:00Z' }
      ]
    }
  });

  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0].kind, 'session');
  assert.equal(usage.windows[0].label, '5-hour');
  assert.equal(usage.windows[0].usedPercent, 12);
  assert.equal(usage.windows[0].windowMinutes, 5 * 60);
  assert.equal(usage.windows[1].kind, 'billing');
  assert.equal(usage.windows[1].label, 'MCP');
  // MCP is a monthly bucket; z.ai encodes it as a misleading unit=5/number=1
  // (1-minute) marker, so drop windowMinutes and label the cadence Monthly.
  assert.equal(usage.windows[1].windowMinutes, undefined);
  assert.equal(usage.windows[1].resetDescription, 'Monthly');
  assert.equal(usage.windows.find((window) => window.kind === 'weekly'), undefined);
});

test('parseZaiUsage recognizes CREDIT_LIMIT entries as token windows', () => {
  const usage = parseZaiUsage({
    data: {
      level: 'lite',
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 620, remaining: 1379, percentage: 31, nextResetTime: 1786115117702 },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 1248, remaining: 8751, percentage: 12, nextResetTime: 1786668792998 }
      ]
    }
  }, null);

  assert.equal(usage.plan, 'Lite');
  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0].kind, 'session');
  assert.equal(usage.windows[0].label, '5-hour');
  assert.equal(usage.windows[0].windowMinutes, 5 * 60);
  assert.equal(Math.round(usage.windows[0].usedPercent), 31);
  assert.equal(usage.windows[1].kind, 'weekly');
  assert.equal(usage.windows[1].label, 'Weekly');
  assert.equal(usage.windows[1].windowMinutes, 7 * 24 * 60);
  assert.equal(Math.round(usage.windows[1].usedPercent), 12);
});

test('parseZaiUsage retains a legacy 1-minute TOKENS_LIMIT entry as a token window', () => {
  // Pins the existing routing: a 1-minute TOKENS_LIMIT stays a token window.
  // Recognizing CREDIT_LIMIT must not reroute or drop it. (The MCP marker is
  // TIME_LIMIT with unit=5/number=1 — a different branch.)
  const usage = parseZaiUsage({
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 5, number: 1, percentage: 12, nextResetTime: '2026-07-07T18:00:00Z' }
      ]
    }
  }, null);

  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].kind, 'session');
  assert.equal(usage.windows[0].label, '5-hour');
  assert.equal(usage.windows[0].usedPercent, 12);
  assert.equal(usage.windows[0].windowMinutes, 1);
});

test('parseZaiUsage reads official plan labels from subscription or quota payloads', () => {
  assert.equal(
    parseZaiUsage({ data: { level: 'lite', limits: [] } }, { data: [{ planName: 'Lite' }] }).plan,
    'Lite'
  );
  assert.equal(
    parseZaiUsage({ data: { packageName: 'max', limits: [] } }, null).plan,
    'Max'
  );
  assert.equal(
    parseZaiUsage({ data: { plan_type: 'coding_pro', limits: [] } }, null).plan,
    'Coding Pro'
  );
  assert.equal(
    parseZaiUsage({ data: { planName: 'z.ai max', limits: [] } }, null).plan,
    'Z.ai Max'
  );
});

const noZcode = {
  readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
};

// Console-key lane responder: quota, finance report, subscription list.
function keyLaneResponses({ balance, subscription }) {
  return async (url) => {
    if (String(url).includes('/quota/limit')) {
      return { ok: true, status: 200, json: async () => ({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 }] } }) };
    }
    if (String(url).includes('query-customer-account-report')) {
      return { ok: true, status: 200, json: async () => ({ code: 200, data: { availableBalance: balance } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [{ product_name: subscription }] }) };
  };
}

// ZCode on-disk fixture for the plan-lane tests: an entitled provider
// selection ('start-plan' or 'coding-plan') with a mirror key and a
// telemetry device id.
function zcodeLaneDeps(fetchMock, selection = 'start-plan', { includeStartPlan = false } = {}) {
  const providerId = `builtin:zai-${selection}`;
  const files = {
    'setting.json': JSON.stringify({
      providerFamilyDomain: 'zai',
      modelProviderFamilySelectedKeys: { zai: `coding-plan:${providerId}` }
    }),
    'config.json': JSON.stringify({
      provider: {
        [providerId]: { enabled: true, options: { apiKey: 'mirror-jwt' } },
        ...(includeStartPlan ? { 'builtin:zai-start-plan': { enabled: false, options: { apiKey: 'start-jwt' } } } : {})
      }
    }),
    'coding-plan-cache.json': JSON.stringify({
      entryStatus: { items: {
        [providerId]: { status: 'available' },
        ...(includeStartPlan ? { 'builtin:zai-start-plan': { status: 'available' } } : {})
      } }
    }),
    'telemetry-state.json': JSON.stringify({ deviceMid: 'dm' })
  };
  return {
    readFileSync: (filePath) => {
      // path.join separators are platform-dependent; key on the bare file
      // name so the same fixture resolves on the windows-latest CI leg.
      const name = path.basename(String(filePath));
      if (Object.hasOwn(files, name)) return files[name];
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    ...(fetchMock ? { fetch: fetchMock } : {})
  };
}

const BILLING_OK = {
  ok: true,
  status: 200,
  json: async () => ({
    code: 0,
    data: {
      plans: [{ plan_id: 'zcode-v3-x', name: 'ZCode Start Plan', status: 'active', entitlements: [{ entitlement_id: 'e1', period: 'daily' }] }],
      balances: [{ entitlement_id: 'e1', plan_id: 'zcode-v3-x', show_name: 'GLM-5.3', total_units: 100, used_units: 10, remaining_units: 90 }]
    }
  })
};

test('fetchZaiLimits returns notConfigured without an API key or local ZCode login', async () => {
  // No ZCode install on disk: discovery resolves to kind 'none', so the
  // billing lane has no credential and the provider stays notConfigured.
  const provider = await fetchZaiLimits({}, {
    env: {},
    now: () => Date.parse('2026-07-06T00:00:00Z'),
    ...noZcode
  });
  assert.equal(provider.provider, 'zai');
  assert.equal(provider.source, '');
  assert.equal(provider.status, 'notConfigured');
});

test('fetchZaiLimits queries quota and balance, then enriches usable quota', async () => {
  const urls = [];
  const auth = [];
  const provider = await fetchZaiLimits(
    { zaiApiKey: 'zai-token' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      ...noZcode,
      fetch: async (url, init) => {
        urls.push(String(url));
        auth.push(init.headers.Authorization);
        return keyLaneResponses({ balance: '0E-9', subscription: 'GLM Coding' })(url, init);
      }
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'GLM Coding');
  assert.equal(provider.windows.length, 2);
  const balance = provider.windows.find((window) => window.metric === 'credits');
  assert.equal(balance.remaining, 0);
  assert.equal(balance.currency, 'USD');
  assert.deepEqual(urls, [
    'https://api.z.ai/api/monitor/usage/quota/limit',
    'https://api.z.ai/api/biz/account/query-customer-account-report',
    'https://api.z.ai/api/biz/subscription/list'
  ]);
  assert.deepEqual(auth, ['Bearer zai-token', 'Bearer zai-token', 'Bearer zai-token']);
});

test('fetchZaiLimits requests the selected BigModel CN region', async () => {
  const urls = [];
  const provider = await fetchZaiLimits(
    { zaiApiKey: 'zai-token', zaiApiRegion: 'bigmodel-cn' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      ...noZcode,
      fetch: async (url) => {
        urls.push(String(url));
        return keyLaneResponses({ balance: '12.5', subscription: 'GLM Coding CN' })(url);
      }
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.region, 'bigmodel-cn');
  assert.deepEqual(urls, [
    'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    'https://open.bigmodel.cn/api/biz/account/query-customer-account-report',
    'https://open.bigmodel.cn/api/biz/subscription/list'
  ]);
  const balance = provider.windows.find((window) => window.metric === 'credits');
  assert.equal(balance.remaining, 12.5);
  assert.equal(balance.currency, 'CNY');
});

test('fetchZaiLimits merges the key and ZCode plan lanes when both exist', async () => {
  let billingHeaders = null;
  const keyLane = keyLaneResponses({ balance: '2.50', subscription: 'GLM Coding' });
  const provider = await fetchZaiLimits(
    { zaiApiKey: 'zai-token' },
    {
      env: {},
      now: () => Date.parse('2026-09-05T12:00:00Z'),
      ...zcodeLaneDeps(async (url, init) => {
        if (String(url).includes('zcode-plan/billing/balance')) {
          billingHeaders = init.headers;
          return BILLING_OK;
        }
        return keyLane(url, init);
      })
    }
  );
  assert.equal(provider.status, 'ok');
  const kinds = provider.windows.map((window) => window.metric === 'credits' ? 'credits' : (window.limitId ? 'plan-bucket' : window.kind));
  assert.ok(kinds.includes('credits'), 'balance window present');
  assert.ok(kinds.includes('plan-bucket'), 'ZCode plan buckets present');
  assert.ok(kinds.includes('session') || kinds.includes('weekly'), 'subscription quota present');
  // The billing lane authenticates with the mirror key and the device id the
  // gateway hard-requires (code 3001 without it).
  assert.equal(billingHeaders.Authorization, 'Bearer mirror-jwt');
  assert.equal(billingHeaders['X-Device-Mid'], 'dm');
});

test('fetchZaiLimits serves Coding Plan quota from the ZCode mirror key', async () => {
  const provider = await fetchZaiLimits({}, {
    env: {},
    now: () => Date.parse('2026-09-05T12:00:00Z'),
    ...zcodeLaneDeps(async (url) => {
      if (!String(url).includes('/quota/limit')) throw new Error('unexpected url ' + url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 }], planName: 'GLM Coding Pro' } })
      };
    }, 'coding-plan')
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'GLM Coding Pro');
  assert.equal(provider.windows[0].kind, 'session');
  assert.equal(provider.windows[0].source, undefined);
});

test('fetchZaiLimits keeps ZCode plan windows when the console key quota fails', async () => {
  // The lane merge used to throw a TDZ ReferenceError on this path.
  const provider = await fetchZaiLimits(
    { zaiApiKey: 'zai-token' },
    {
      env: {},
      now: () => Date.parse('2026-09-05T12:00:00Z'),
      ...zcodeLaneDeps(async (url) => {
        const target = String(url);
        if (target.includes('/quota/limit')) return { ok: false, status: 500, json: async () => ({}) };
        if (target.includes('zcode-plan/billing/balance')) return BILLING_OK;
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      })
    }
  );
  assert.equal(provider.status, 'unavailable');
  assert.equal(provider.source, 'api');
  assert.ok(provider.accountKey, 'accountKey survives from the plan lane');
  assert.equal(provider.accountLabel, 'ZCode Start Plan');
  assert.ok(provider.windows.some((window) => window.limitId === 'zcode-v3-x'), 'plan bucket survives');
});

test('fetchZaiLimits reports a revoked console key the same way whichever lane it ran with', async () => {
  // 401 must read as unauthorized in both shapes: with the plan lane healthy
  // (single rejection) and when both lanes fail. The double-failure path used
  // to collapse 401 into notConfigured, contradicting the Configured pill.
  const base = { env: {}, now: () => Date.parse('2026-09-05T12:00:00Z') };
  const revokedKey = { ok: false, status: 401, json: async () => ({}) };
  const withPlan = await fetchZaiLimits(
    { zaiApiKey: 'zai-token' },
    {
      ...base,
      ...zcodeLaneDeps(async (url) => {
        if (String(url).includes('/quota/limit')) return revokedKey;
        if (String(url).includes('zcode-plan/billing/balance')) return BILLING_OK;
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      })
    }
  );
  assert.equal(withPlan.status, 'unauthorized');

  const bothFailed = await fetchZaiLimits(
    { zaiApiKey: 'zai-token' },
    {
      ...base,
      ...zcodeLaneDeps(async () => revokedKey)
    }
  );
  assert.equal(bothFailed.status, 'unauthorized');
});

test('fetchZaiLimits reports the ZCode lane own error when only it ran', async () => {
  const base = { env: {}, now: () => Date.parse('2026-09-05T12:00:00Z') };
  const unavailable = await fetchZaiLimits({}, {
    ...base,
    ...zcodeLaneDeps(async () => ({ ok: false, status: 500, json: async () => ({}) }))
  });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.source, 'oauth');

  // Billing 401/403 maps to unavailable, mirroring ZCode's own
  // classifyAvailabilityError: the mirror token is ZCode-managed and rotates
  // there — "not configured" would contradict the detected-login pill.
  const staleToken = await fetchZaiLimits({}, {
    ...base,
    ...zcodeLaneDeps(async () => ({ ok: false, status: 401, json: async () => ({}) }))
  });
  assert.equal(staleToken.status, 'unavailable');
  assert.equal(staleToken.source, 'oauth');
});

test('fetchZaiLimits treats an entitled plan with empty buckets as unavailable', async () => {
  // ZCode reports the plan as available while grants are not yet effective
  // (empty balances is a legal mid-state); the row must not claim
  // notConfigured while the login is detected.
  const provider = await fetchZaiLimits({}, {
    env: {},
    now: () => Date.parse('2026-09-05T12:00:00Z'),
    ...zcodeLaneDeps(async (url) => {
      if (String(url).includes('zcode-plan/billing/balance')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 0, data: { plans: [{ plan_id: 'zcode-v3-x', name: 'ZCode Start Plan', status: 'active', entitlements: [] }], balances: [] } })
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    })
  });
  assert.equal(provider.status, 'unavailable');
  assert.equal(provider.source, 'oauth');
  assert.deepEqual(provider.windows, []);
});

test('fetchZaiLimits treats a mirror key without a subscription as unavailable', async () => {
  // The quota endpoint answers 200 + code 500 "当前用户不存在coding plan"
  // for a key with no subscription — a state under that key, not a missing
  // configuration.
  const provider = await fetchZaiLimits({}, {
    env: {},
    now: () => Date.parse('2026-09-05T12:00:00Z'),
    ...zcodeLaneDeps(
      async () => ({ ok: true, status: 200, json: async () => ({ code: 500, msg: '当前用户不存在coding plan' }) }),
      'coding-plan'
    )
  });
  assert.equal(provider.status, 'unavailable');
  assert.equal(provider.source, 'oauth');
});

test('fetchZaiLimits preserves a classified Coding Plan error instead of flattening it', async () => {
  // A 429 against the quota endpoint surfaces as sourceRateLimited — the
  // same retention the start-billing lane applies; the old catch-all
  // reported plain unavailable.
  const provider = await fetchZaiLimits({}, {
    env: {},
    now: () => Date.parse('2026-09-05T12:00:00Z'),
    ...zcodeLaneDeps(
      async () => ({ ok: false, status: 429, json: async () => ({}) }),
      'coding-plan'
    )
  });
  assert.equal(provider.status, 'sourceRateLimited');
  assert.equal(provider.source, 'oauth');
});

test('fetchZaiLimits tracks cumulative spend and ignores a missing total', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-spend-'));
  const storePath = path.join(dir, 'zai-balance.json');
  try {
    const call = (data) => fetchZaiLimits(
      { zaiApiKey: 'zai-token' },
      {
        env: {},
        now: () => Date.parse('2026-09-05T12:00:00Z'),
        zaiBalanceStorePath: storePath,
        ...noZcode,
        fetch: async (url) => {
          if (String(url).includes('query-customer-account-report')) {
            return { ok: true, status: 200, json: async () => ({ code: 200, data }) };
          }
          if (String(url).includes('/quota/limit')) {
            return { ok: true, status: 200, json: async () => ({ data: { limits: [] } }) };
          }
          return { ok: true, status: 200, json: async () => ({ data: [] }) };
        }
      }
    );

    const first = await call({ availableBalance: '5.00', totalSpendAmount: '100' });
    assert.equal(first.balance.todaySpend, 0);
    assert.equal(first.balance.allTimeSpend, 0);
    // Tracking began within the same local month, so the not-yet-a-month
    // flag is true; the old month-key comparison never matched a day key.
    assert.equal(first.balance.monthSinceTracking, true);

    // A report without the cumulative total must not rebase the baseline:
    // Number(null) is 0, so a null check — not isFinite alone — gates it.
    // Normalization fills absent spend fields with null.
    const missing = await call({ availableBalance: '5.00' });
    assert.equal(missing.balance.todaySpend, null);

    const second = await call({ availableBalance: '5.00', totalSpendAmount: '150' });
    assert.equal(second.balance.todaySpend, 50);
    assert.equal(second.balance.allTimeSpend, 50);

    // A drop (refund, plan reset) moves the baseline only — no negative
    // spend, and the later rise records only its own delta.
    const refunded = await call({ availableBalance: '5.00', totalSpendAmount: '120' });
    assert.equal(refunded.balance.todaySpend, 50);
    assert.equal(refunded.balance.allTimeSpend, 50);
    const afterRefund = await call({ availableBalance: '5.00', totalSpendAmount: '130' });
    assert.equal(afterRefund.balance.todaySpend, 60);
    assert.equal(afterRefund.balance.allTimeSpend, 60);

    // Day buckets past the 40-day retention window are pruned while
    // allTimeSpend keeps accumulating, as on DeepSeek's balance history.
    const later = await fetchZaiLimits(
      { zaiApiKey: 'zai-token' },
      {
        env: {},
        now: () => Date.parse('2026-10-20T12:00:00Z'),
        zaiBalanceStorePath: storePath,
        ...noZcode,
        fetch: async (url) => {
          if (String(url).includes('query-customer-account-report')) {
            return { ok: true, status: 200, json: async () => ({ code: 200, data: { availableBalance: '5.00', totalSpendAmount: '160' } }) };
          }
          if (String(url).includes('/quota/limit')) {
            return { ok: true, status: 200, json: async () => ({ data: { limits: [] } }) };
          }
          return { ok: true, status: 200, json: async () => ({ data: [] }) };
        }
      }
    );
    assert.equal(later.balance.todaySpend, 30);
    assert.equal(later.balance.allTimeSpend, 90);
    // October reading against a September baseline: a full month boundary
    // has passed, so the flag flips off.
    assert.equal(later.balance.monthSinceTracking, false);
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const dayKeys = Object.keys(Object.values(stored.accounts)[0].dailySpend);
    assert.ok(!dayKeys.includes('2026-09-05'), 'old day bucket pruned');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchZaiLimits survives a malformed spend store and a failing write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-spend-'));
  const storePath = path.join(dir, 'zai-balance.json');
  const respond = async (url) => {
    if (String(url).includes('query-customer-account-report')) {
      return { ok: true, status: 200, json: async () => ({ code: 200, data: { availableBalance: '5.00', totalSpendAmount: '100' } }) };
    }
    if (String(url).includes('/quota/limit')) {
      return { ok: true, status: 200, json: async () => ({ data: { limits: [] } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };
  try {
    // Valid JSON without an accounts map: the store reinitializes instead of
    // throwing and discarding an otherwise successful quota response.
    fs.writeFileSync(storePath, '{"version": 1, "unexpected": true}', 'utf8');
    const malformed = await fetchZaiLimits(
      { zaiApiKey: 'zai-token' },
      { env: {}, now: () => Date.parse('2026-09-05T12:00:00Z'), zaiBalanceStorePath: storePath, ...noZcode, fetch: respond }
    );
    // Quota answered (no subscription windows) but the balance window makes
    // the row ok; the spend baseline restarts from this report.
    assert.equal(malformed.status, 'ok');
    assert.equal(malformed.balance.allTimeSpend, 0);

    // A read-only dir / full disk fails the write only; the row and its
    // balance still report, and the baseline is simply not persisted.
    fs.rmSync(storePath, { force: true });
    const failingWrite = await fetchZaiLimits(
      { zaiApiKey: 'zai-token' },
      {
        env: {},
        now: () => Date.parse('2026-09-05T12:00:00Z'),
        zaiBalanceStorePath: storePath,
        ...noZcode,
        readJson: () => null,
        writeJsonAtomic: () => { throw new Error('EACCES: read-only'); },
        fetch: respond
      }
    );
    assert.equal(failingWrite.status, 'ok');
    assert.equal(failingWrite.balance.allTimeSpend, 0);
    assert.equal(fs.existsSync(storePath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchZaiLimits physically aborts a hung request within its configured bound', async () => {
  let signal;
  const provider = await fetchZaiLimits(
    { zaiApiKey: 'hung-key' },
    {
      env: {},
      zaiFetchTimeoutMs: 5,
      ...noZcode,
      fetch: async (_url, init) => {
        signal = init.signal;
        return new Promise(() => {});
      }
    }
  );

  assert.equal(provider.status, 'unavailable');
  assert.equal(signal.aborted, true);
});

for (const badDailySpend of [undefined, null, [], 'broken']) {
  test(`fetchZaiLimits repairs dailySpend ${JSON.stringify(badDailySpend)} and persists subsequent deltas`, async () => {
    let stored = null;
    let total = 100;
    const call = () => fetchZaiLimits({ zaiApiKey: 'repair-key' }, {
      env: {}, ...noZcode, now: () => Date.parse('2026-09-05T12:00:00Z'),
      readJson: () => structuredClone(stored),
      writeJsonAtomic: (_path, value) => { stored = JSON.parse(JSON.stringify(value)); },
      fetch: async (url) => ({ ok: true, json: async () => String(url).includes('query-customer-account-report')
        ? { data: { availableBalance: 5, totalSpendAmount: total } }
        : { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 }] } } })
    });
    await call();
    Object.values(stored.accounts)[0].dailySpend = badDailySpend;
    const repaired = await call();
    assert.equal(repaired.status, 'ok');
    assert.deepEqual(Object.values(stored.accounts)[0].dailySpend, {});
    total = 110;
    const advanced = await call();
    assert.equal(advanced.balance.todaySpend, 10);
    assert.equal((await call()).balance.todaySpend, 10);
    assert.equal(advanced.windows.length, 2);
  });
}

for (const status of [401, 429, 500]) {
  test(`fetchZaiLimits preserves balance on quota ${status} without subscription enrichment`, async () => {
    const urls = [];
    const provider = await fetchZaiLimits({ zaiApiKey: 'quota-failure' }, {
      env: {}, ...noZcode,
      fetch: async (url) => {
        urls.push(String(url));
        return String(url).includes('/quota/limit')
          ? { ok: false, status }
          : { ok: true, json: async () => ({ data: { availableBalance: 7 } }) };
      }
    });
    assert.equal(provider.status, status === 401 ? 'unauthorized' : status === 429 ? 'sourceRateLimited' : 'unavailable');
    assert.equal(provider.balance?.amount, 7);
    assert.equal(provider.windows.find(w => w.metric === 'credits')?.remaining, 7);
    assert.equal(urls.length, 2);
  });
}

test('a failed ZCode billing request preserves console data and surfaces the managed-token failure', async () => {
  const provider = await fetchZaiLimits({ zaiApiKey: 'console' }, {
    env: {}, ...zcodeLaneDeps(async url => {
      if (String(url).includes('zcode-plan/billing/balance')) return { ok: false, status: 401 };
      return keyLaneResponses({ balance: 7, subscription: 'Pro' })(url);
    })
  });
  assert.equal(provider.status, 'unavailable');
  assert.equal(provider.balance.amount, 7);
  assert.equal(provider.accountLabel, 'Pro');
  assert.ok(provider.windows.some(w => w.kind === 'session'));
});

test('the same console and ZCode coding key queries and renders quota once', async () => {
  let quotaCalls = 0;
  const provider = await fetchZaiLimits({ zaiApiKey: 'mirror-jwt' }, {
    env: {}, ...zcodeLaneDeps(async url => {
      if (String(url).includes('/quota/limit')) quotaCalls++;
      return keyLaneResponses({ balance: 7, subscription: 'Pro' })(url);
    }, 'coding-plan')
  });
  assert.equal(provider.status, 'ok');
  assert.equal(quotaCalls, 1);
  assert.equal(provider.windows.filter(w => w.kind === 'session').length, 1);
});

test('fetchZaiLimits shows Start/Weekend buckets alongside Coding Plan quota', async () => {
  // Billing is account-level: a coding-plan selection still surfaces the
  // account's Start/Weekend grants in the same row, fetched in parallel —
  // a failed billing query never blocks the quota answer.
  const files = {
    'setting.json': JSON.stringify({ providerFamilyDomain: 'zai', modelProviderFamilySelectedKeys: { zai: 'coding-plan:builtin:zai-coding-plan' } }),
    'config.json': JSON.stringify({ provider: {
      'builtin:zai-coding-plan': { enabled: true, options: { apiKey: 'coding-mirror' } },
      'builtin:zai-start-plan': { enabled: false, options: { apiKey: 'start-jwt' } }
    } }),
    'coding-plan-cache.json': JSON.stringify({ entryStatus: { items: {
      'builtin:zai-coding-plan': { status: 'available' },
      'builtin:zai-start-plan': { status: 'available' }
    } } }),
    'telemetry-state.json': JSON.stringify({ deviceMid: 'dm' })
  };
  let subscriptionCalls = 0;
  const deps = {
    env: {}, now: () => Date.parse('2026-09-05T12:00:00Z'),
    readFileSync: (filePath) => {
      const name = path.basename(String(filePath));
      if (Object.hasOwn(files, name)) return files[name];
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    fetch: async (url) => {
      const target = String(url);
      if (target.includes('/quota/limit')) {
        return { ok: true, status: 200, json: async () => ({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 40 }], planName: 'GLM Coding Pro' } }) };
      }
      if (target.includes('zcode-plan/billing/balance')) {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: {
          plans: [{ plan_id: 'zcode-v3-start-plan-wk-0904', name: 'ZCode Weekend Build', status: 'active', entitlements: [{ entitlement_id: 'e1', period: 'one_time' }] }],
          balances: [{ entitlement_id: 'e1', plan_id: 'zcode-v3-start-plan-wk-0904', show_name: 'GLM-5.3-Flash', total_units: 305000000, used_units: 109149447, remaining_units: 195850553 }]
        } }) };
      }
      if (target.includes('subscription/list')) {
        subscriptionCalls += 1;
        return { ok: true, status: 200, json: async () => ({ data: [{ product_name: 'GLM Coding Pro' }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
  };
  const provider = await fetchZaiLimits({}, deps);
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'oauth');
  // Header carries the consumed mode; the Weekend bucket rides the same row.
  assert.equal(provider.accountLabel, 'GLM Coding Pro');
  assert.equal(subscriptionCalls, 1, 'subscription enriches usable quota once');
  assert.ok(provider.windows.some((window) => window.kind === 'session'), 'subscription quota present');
  const weekend = provider.windows.find((window) => window.limitId);
  assert.ok(weekend, 'Weekend bucket present');
  assert.equal(weekend.limit, 305000000);
  // A console key equal to the mirror key still gets its billing buckets:
  // the duplicate-quota guard skips only the quota fetch, not the lane.
  let quotaCalls = 0;
  const sameKey = await fetchZaiLimits(
    { zaiApiKey: 'coding-mirror' },
    { ...deps, fetch: async (url) => { if (String(url).includes('/quota/limit')) quotaCalls++; return deps.fetch(url); } }
  );
  assert.equal(quotaCalls, 1, 'quota queried once');
  assert.ok(sameKey.windows.some((window) => window.limitId), 'Weekend bucket survives the dedupe guard');

  // The MCP month bucket falls back to the subscription renewal time when the
  // TIME_LIMIT entry omits nextResetTime — the same fallback the console-key
  // lane applies, aligned with the Kimi/Kiro/Grok month-bucket precedent.
  const noMcpReset = { ...deps, fetch: async (url) => {
    const target = String(url);
    if (target.includes('/quota/limit')) {
      return { ok: true, status: 200, json: async () => ({ data: { planName: 'GLM Coding Pro', limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 40, nextResetTime: 1788600000 },
        { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 67 }
      ] } }) };
    }
    if (target.includes('subscription/list')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ product_name: 'GLM Coding Pro', next_renew_time: 1789000000 }] }) };
    }
    return deps.fetch(url);
  } };
  const mcpFallback = await fetchZaiLimits({}, noMcpReset);
  const mcp = mcpFallback.windows.find((window) => window.label === 'MCP');
  assert.equal(mcp.resetsAt, '2026-09-10T00:26:40.000Z');
  assert.equal(mcpFallback.accountLabel, 'GLM Coding Pro');

  // Billing failure must not block the quota answer.
  const billingFails = { ...deps, fetch: async (url) => String(url).includes('zcode-plan') ? { ok: false, status: 500, json: async () => ({}) } : deps.fetch(url) };
  const degraded = await fetchZaiLimits({}, billingFails);
  assert.equal(degraded.status, 'ok');
  assert.ok(degraded.windows.some((window) => window.kind === 'session'), 'quota survives billing failure');
  assert.ok(!degraded.windows.some((window) => window.limitId), 'no bucket when billing failed');
});

for (const scenario of [
  {
    name: 'fails',
    quotaResponse: { ok: false, status: 429, json: async () => ({}) },
    status: 'sourceRateLimited'
  },
  {
    name: 'is empty',
    quotaResponse: { ok: true, status: 200, json: async () => ({ data: { limits: [] } }) },
    status: 'ok'
  }
]) {
  test(`fetchZaiLimits preserves billing when combined Coding Plan quota ${scenario.name}`, async () => {
    let subscriptionCalls = 0;
    const provider = await fetchZaiLimits({}, {
      env: {},
      now: () => Date.parse('2026-09-05T12:00:00Z'),
      ...zcodeLaneDeps(async (url) => {
        const target = String(url);
        if (target.includes('/quota/limit')) return scenario.quotaResponse;
        if (target.includes('zcode-plan/billing/balance')) return BILLING_OK;
        if (target.includes('subscription/list')) subscriptionCalls += 1;
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }, 'coding-plan', { includeStartPlan: true })
    });

    assert.equal(provider.status, scenario.status);
    assert.ok(provider.windows.some((window) => window.limitId), 'billing survives quota result');
    assert.equal(subscriptionCalls, 0, 'subscription is skipped without usable quota');
  });
}
