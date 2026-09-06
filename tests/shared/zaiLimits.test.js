'use strict';

const assert = require('node:assert/strict');
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

test('fetchZaiLimits returns notConfigured without an API key or local ZCode login', async () => {
  const provider = await fetchZaiLimits({}, {
    env: {},
    now: () => Date.parse('2026-07-06T00:00:00Z'),
    // No ZCode install on disk: discovery resolves to kind 'none', so the
    // billing lane has no credential and the provider stays notConfigured.
    readFileSync: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
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
      readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      fetch: async (url, init) => {
        urls.push(String(url));
        auth.push(init.headers.Authorization);
        if (String(url).includes('/quota/limit')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                limits: [
                  { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 }
                ]
              }
            })
          };
        }
        if (String(url).includes('query-customer-account-report')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ code: 200, data: { availableBalance: '0E-9', balance: '0E-9' } })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ product_name: 'GLM Coding' }] })
        };
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
      readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      fetch: async (url) => {
        urls.push(String(url));
        if (String(url).includes('/quota/limit')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                limits: [
                  { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 20 }
                ]
              }
            })
          };
        }
        if (String(url).includes('query-customer-account-report')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ code: 200, data: { availableBalance: '12.5' } })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ product_name: 'GLM Coding CN' }] })
        };
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
  const settings = {
    providerFamilyDomain: 'zai',
    modelProviderFamilySelectedKeys: { zai: 'coding-plan:builtin:zai-start-plan' }
  };
  const registry = {
    provider: { 'builtin:zai-start-plan': { enabled: true, options: { apiKey: 'mirror-jwt' } } }
  };
  const cache = { entryStatus: { items: { 'builtin:zai-start-plan': { status: 'available' } } } };
  const provider = await fetchZaiLimits(
    { zaiApiKey: 'zai-token' },
    {
      env: {},
      now: () => Date.parse('2026-09-05T12:00:00Z'),
      readFileSync: (filePath) => {
        const key = String(filePath).split('/').pop();
        const files = {
          'setting.json': JSON.stringify(settings),
          'config.json': JSON.stringify(registry),
          'coding-plan-cache.json': JSON.stringify(cache),
          'telemetry-state.json': JSON.stringify({ deviceMid: 'dm' })
        };
        if (Object.hasOwn(files, key)) return files[key];
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      fetch: async (url) => {
        const target = String(url);
        if (target.includes('/quota/limit')) {
          return { ok: true, status: 200, json: async () => ({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 }] } }) };
        }
        if (target.includes('query-customer-account-report')) {
          return { ok: true, status: 200, json: async () => ({ code: 200, data: { availableBalance: '2.50' } }) };
        }
        if (target.includes('zcode-plan/billing/balance')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: 0,
              data: {
                plans: [{ plan_id: 'zcode-v3-x', name: 'ZCode Start Plan', status: 'active', entitlements: [{ entitlement_id: 'e1', period: 'daily' }] }],
                balances: [{ entitlement_id: 'e1', plan_id: 'zcode-v3-x', show_name: 'GLM-5.3', total_units: 100, used_units: 10, remaining_units: 90, expires_at: 1788706800 }]
              }
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
    }
  );
  assert.equal(provider.status, 'ok');
  const kinds = provider.windows.map((window) => window.metric === 'credits' ? 'credits' : (window.limitId ? 'plan-bucket' : window.kind));
  assert.ok(kinds.includes('credits'), 'balance window present');
  assert.ok(kinds.includes('plan-bucket'), 'ZCode plan buckets present');
  assert.ok(kinds.includes('session') || kinds.includes('weekly'), 'subscription quota present');
});

test('fetchZaiLimits serves Coding Plan quota from the ZCode mirror key', async () => {
  const settings = {
    providerFamilyDomain: 'zai',
    modelProviderFamilySelectedKeys: { zai: 'coding-plan:builtin:zai-coding-plan' }
  };
  const registry = {
    provider: { 'builtin:zai-coding-plan': { enabled: true, options: { apiKey: 'coding-mirror-key', baseURL: 'https://api.z.ai/api/anthropic' } } }
  };
  const cache = { entryStatus: { items: { 'builtin:zai-coding-plan': { status: 'available' } } } };
  const provider = await fetchZaiLimits({}, {
    env: {},
    now: () => Date.parse('2026-09-05T12:00:00Z'),
    readFileSync: (filePath) => {
      const key = String(filePath).split('/').pop();
      const files = {
        'setting.json': JSON.stringify(settings),
        'config.json': JSON.stringify(registry),
        'coding-plan-cache.json': JSON.stringify(cache)
      };
      if (Object.hasOwn(files, key)) return files[key];
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    fetch: async (url) => {
      if (!String(url).includes('/quota/limit')) throw new Error('unexpected url ' + url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 }], planName: 'GLM Coding Pro' } })
      };
    }
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'GLM Coding Pro');
  assert.equal(provider.windows[0].kind, 'session');
  assert.equal(provider.windows[0].source, 'local');
});

test('fetchZaiLimits physically aborts a hung request within its configured bound', async () => {
  let signal;
  const provider = await fetchZaiLimits(
    { zaiApiKey: 'hung-key' },
    {
      env: {},
      zaiFetchTimeoutMs: 5,
      fetch: async (_url, init) => {
        signal = init.signal;
        return new Promise(() => {});
      }
    }
  );

  assert.equal(provider.status, 'unavailable');
  assert.equal(signal.aborted, true);
});
