'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseVolcagentAfpUsage,
  volcagentCredentials,
  fetchVolcagentLimits
} = require('../../src/shared/volcagentLimits');

test('volcagentCredentials prefers explicit Agent Plan credentials', () => {
  assert.deepEqual(
    volcagentCredentials({}, {
      volcagentAccessKeyId: 'AKLT-agent',
      volcagentSecretAccessKey: 'agent-sk',
      volcagentRegion: 'cn-shanghai'
    }),
    { mode: 'signed', accessKeyId: 'AKLT-agent', secretAccessKey: 'agent-sk', apiKey: '', region: 'cn-shanghai' }
  );
});

test('volcagentCredentials falls back to Coding Plan credentials from settings', () => {
  assert.deepEqual(
    volcagentCredentials({}, {
      volcengineAccessKeyId: 'AKLT-coding',
      volcengineSecretAccessKey: 'coding-sk'
    }),
    { mode: 'signed', accessKeyId: 'AKLT-coding', secretAccessKey: 'coding-sk', apiKey: '', region: 'cn-beijing' }
  );
});

test('volcagentCredentials falls back to Coding Plan credentials from env', () => {
  assert.deepEqual(
    volcagentCredentials({ VOLCENGINE_ACCESS_KEY_ID: 'AKLT-env', VOLCENGINE_SECRET_ACCESS_KEY: 'env-sk' }),
    { mode: 'signed', accessKeyId: 'AKLT-env', secretAccessKey: 'env-sk', apiKey: '', region: 'cn-beijing' }
  );
});

test('volcagentCredentials rejects plain Ark API keys (OpenAPI needs AK/SK)', () => {
  assert.equal(volcagentCredentials({ ARK_API_KEY: 'ark-env' }), null);
  assert.equal(volcagentCredentials({}, { volcagentAccessKeyId: 'ark-settings' }), null);
});

test('parseVolcagentAfpUsage maps AFP windows to quota percentages', () => {
  const usage = parseVolcagentAfpUsage({
    Result: {
      PlanType: 'agent plan medium',
      AFPFiveHour: { Quota: 1000, Used: 170, ResetTime: 1_783_314_000 },
      AFPWeekly: { Quota: 5000, Used: 1100, ResetTime: 1_783_900_800 },
      AFPMonthly: { Quota: 20000, Used: 6200, ResetTime: 1_785_542_400 }
    }
  });

  assert.equal(usage.plan, 'Agent Plan Medium');
  assert.equal(usage.windows.length, 3);
  assert.equal(usage.windows[0].kind, 'session');
  assert.equal(usage.windows[0].label, '5-hour');
  assert.equal(usage.windows[0].used, 170);
  assert.equal(usage.windows[0].limit, 1000);
  assert.equal(usage.windows[0].remaining, 830);
  assert.equal(usage.windows[0].usedPercent, 17);
  assert.equal(usage.windows[0].resetsAt, '2026-07-06T05:00:00.000Z');
  assert.equal(usage.windows[0].windowMinutes, 5 * 60);
  assert.equal(usage.windows[1].kind, 'weekly');
  assert.equal(usage.windows[1].usedPercent, 22);
  assert.equal(usage.windows[2].kind, 'billing');
  assert.equal(usage.windows[2].label, 'Monthly');
  assert.equal(usage.windows[2].usedPercent, 31);
});

test('parseVolcagentAfpUsage skips windows with zero quota (not subscribed)', () => {
  const usage = parseVolcagentAfpUsage({
    Result: {
      PlanType: 'small',
      AFPFiveHour: { Quota: 100, Used: 5, ResetTime: 1_783_314_000 },
      AFPWeekly: { Quota: 0, Used: 0, ResetTime: -1 },
      AFPMonthly: { Quota: -1, Used: 0, ResetTime: -1 }
    }
  });

  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].kind, 'session');
});

test('parseVolcagentAfpUsage returns empty windows for an empty body', () => {
  const usage = parseVolcagentAfpUsage({});
  assert.equal(usage.plan, '');
  assert.equal(usage.windows.length, 0);
});

test('fetchVolcagentLimits returns notConfigured without AK/SK credentials', async () => {
  const provider = await fetchVolcagentLimits({}, { env: {}, now: () => Date.parse('2026-07-06T00:00:00Z') });
  assert.equal(provider.provider, 'volcagent');
  assert.equal(provider.source, 'api');
  assert.equal(provider.status, 'notConfigured');
});

test('fetchVolcagentLimits posts the signed GetAFPUsage request', async () => {
  const requests = [];
  const provider = await fetchVolcagentLimits(
    { volcagentAccessKeyId: 'AKLT-test', volcagentSecretAccessKey: 'sk', volcagentRegion: 'cn-beijing' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            Result: {
              PlanType: 'agent medium',
              AFPFiveHour: { Quota: 1000, Used: 100, ResetTime: 1_783_314_000 }
            }
          })
        };
      }
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'Agent Medium');
  assert.equal(provider.windows.length, 1);
  assert.equal(provider.windows[0].usedPercent, 10);
  assert.equal(requests[0].url, 'https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01');
  assert.equal(requests[0].init.method, 'POST');
  assert.match(requests[0].init.headers.Authorization, /^HMAC-SHA256 Credential=AKLT-test\//);
});

test('fetchVolcagentLimits reuses Coding Plan credentials when Agent Plan fields are empty', async () => {
  const requests = [];
  const provider = await fetchVolcagentLimits(
    { volcengineAccessKeyId: 'AKLT-coding', volcengineSecretAccessKey: 'coding-sk' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            Result: {
              PlanType: 'agent small',
              AFPWeekly: { Quota: 4000, Used: 800, ResetTime: 1_783_900_800 }
            }
          })
        };
      }
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'Agent Small');
  assert.equal(provider.windows[0].usedPercent, 20);
  assert.match(requests[0].init.headers.Authorization, /Credential=AKLT-coding\//);
});

test('fetchVolcagentLimits maps no active windows to unavailable', async () => {
  const provider = await fetchVolcagentLimits(
    { volcengineAccessKeyId: 'AKLT-test', volcengineSecretAccessKey: 'sk' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ Result: { PlanType: '' } })
      })
    }
  );

  assert.equal(provider.status, 'unavailable');
  assert.equal(provider.windows.length, 0);
});

test('fetchVolcagentLimits maps HTTP 403 to unauthorized', async () => {
  const provider = await fetchVolcagentLimits(
    { volcengineAccessKeyId: 'AKLT-test', volcengineSecretAccessKey: 'sk' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async () => ({ ok: false, status: 403, json: async () => ({}) })
    }
  );

  assert.equal(provider.status, 'unauthorized');
});

test('fetchVolcagentLimits physically aborts a hung request within its configured bound', async () => {
  let signal;
  const provider = await fetchVolcagentLimits(
    { volcengineAccessKeyId: 'AKLT-hung', volcengineSecretAccessKey: 'sk' },
    {
      env: {},
      volcagentFetchTimeoutMs: 5,
      fetch: async (_url, init) => {
        signal = init.signal;
        return new Promise(() => {});
      }
    }
  );

  assert.equal(provider.status, 'unavailable');
  assert.equal(signal.aborted, true);
});
