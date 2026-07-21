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

test('fetchZaiLimits returns notConfigured without an API key', async () => {
  const provider = await fetchZaiLimits({}, { env: {}, now: () => Date.parse('2026-07-06T00:00:00Z') });
  assert.equal(provider.provider, 'zai');
  assert.equal(provider.source, 'api');
  assert.equal(provider.status, 'notConfigured');
});

test('fetchZaiLimits requests quota and subscription with bearer auth', async () => {
  const urls = [];
  const auth = [];
  const provider = await fetchZaiLimits(
    { zaiApiKey: 'zai-token' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
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
  assert.equal(provider.windows.length, 1);
  assert.deepEqual(urls, [
    'https://api.z.ai/api/monitor/usage/quota/limit',
    'https://api.z.ai/api/biz/subscription/list'
  ]);
  assert.deepEqual(auth, ['Bearer zai-token', 'Bearer zai-token']);
});

test('fetchZaiLimits requests the selected BigModel CN region', async () => {
  const urls = [];
  const provider = await fetchZaiLimits(
    { zaiApiKey: 'zai-token', zaiApiRegion: 'bigmodel-cn' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
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
    'https://open.bigmodel.cn/api/biz/subscription/list'
  ]);
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
