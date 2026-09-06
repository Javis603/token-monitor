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
} = require('../../src/shared/zaiLimits');

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
function zcodeLaneDeps(fetchMock, selection = 'start-plan') {
  const providerId = `builtin:zai-${selection}`;
  const files = {
    'setting.json': JSON.stringify({
      providerFamilyDomain: 'zai',
      modelProviderFamilySelectedKeys: { zai: `coding-plan:${providerId}` }
    }),
    'config.json': JSON.stringify({
      provider: { [providerId]: { enabled: true, options: { apiKey: 'mirror-jwt' } } }
    }),
    'coding-plan-cache.json': JSON.stringify({
      entryStatus: { items: { [providerId]: { status: 'available' } } }
    }),
    'telemetry-state.json': JSON.stringify({ deviceMid: 'dm' })
  };
  return {
    readFileSync: (filePath) => {
      const name = String(filePath).split('/').pop();
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

test('fetchZaiLimits queries quota, subscription and balance in parallel', async () => {
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
  assert.equal(provider.windows[0].source, 'local');
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
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const dayKeys = Object.keys(Object.values(stored.accounts)[0].dailySpend);
    assert.ok(!dayKeys.includes('2026-09-05'), 'old day bucket pruned');
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
