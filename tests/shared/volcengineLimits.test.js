'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  volcengineCredentials,
  parseVolcengineCodingPlanUsage,
  parseVolcengineAgentPlanUsage,
  signVolcengineRequest,
  fetchVolcengineLimits
} = require('../../src/shared/volcengineLimits');

test('volcengineCredentials accepts Volcengine Ark Coding Plan credentials', () => {
  assert.deepEqual(
    volcengineCredentials({
      VOLCENGINE_ACCESS_KEY_ID: '  "AKLT-env"  ',
      VOLCENGINE_SECRET_ACCESS_KEY: 'sk',
      VOLCENGINE_REGION: 'cn-shanghai'
    }),
    { mode: 'signed', accessKeyId: 'AKLT-env', secretAccessKey: 'sk', apiKey: '', region: 'cn-shanghai' }
  );
  assert.deepEqual(
    volcengineCredentials({}, {
      volcengineAccessKeyId: 'AKLT-settings',
      volcengineSecretAccessKey: 'settings-sk'
    }),
    { mode: 'signed', accessKeyId: 'AKLT-settings', secretAccessKey: 'settings-sk', apiKey: '', region: 'cn-beijing' }
  );
  assert.deepEqual(
    volcengineCredentials({ ARK_API_KEY: 'ark-env' }),
    { mode: 'ark', apiKey: 'ark-env', region: 'cn-beijing' }
  );
  assert.deepEqual(
    volcengineCredentials({ VOLCENGINE_ACCESS_KEY_ID: 'ark-env' }),
    { mode: 'ark', apiKey: 'ark-env', region: 'cn-beijing' }
  );
  assert.deepEqual(
    volcengineCredentials({ VOLCENGINE_SECRET_ACCESS_KEY: 'env-sk' }, { volcengineAccessKeyId: 'ark-settings' }),
    { mode: 'ark', apiKey: 'ark-settings', region: 'cn-beijing' }
  );
  assert.equal(volcengineCredentials({ VOLCENGINE_ACCESS_KEY_ID: 'AKLT-env' }), null);
});

test('parseVolcengineCodingPlanUsage maps Volcengine Coding Plan quota windows', () => {
  const usage = parseVolcengineCodingPlanUsage({
    Result: {
      Status: 'Active',
      UpdateTimestamp: 1_783_296_000,
      QuotaUsage: [
        { Level: 'session', Percent: 17, ResetTimestamp: 1_783_314_000 },
        { Level: 'weekly', Percent: 22, ResetTimestamp: 1_783_900_800 },
        { Level: 'monthly', Percent: 31, ResetTimestamp: 1_785_542_400 }
      ]
    }
  });

  assert.equal(usage.status, 'Active');
  assert.equal(usage.plan, '');
  assert.equal(usage.updatedAt, '2026-07-06T00:00:00.000Z');
  assert.equal(usage.windows.length, 3);
  assert.equal(usage.windows[0].kind, 'session');
  assert.equal(usage.windows[0].label, '5-hour');
  assert.equal(usage.windows[0].usedPercent, 17);
  assert.equal(usage.windows[0].windowMinutes, 5 * 60);
  assert.equal(usage.windows[1].kind, 'weekly');
  assert.equal(usage.windows[1].usedPercent, 22);
  assert.equal(usage.windows[2].kind, 'billing');
  assert.equal(usage.windows[2].label, 'Monthly');
  assert.equal(usage.windows[2].usedPercent, 31);
});

test('signVolcengineRequest signs the empty POST body with Volcengine V4 headers', () => {
  const signed = signVolcengineRequest({
    url: 'https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01',
    method: 'POST',
    body: '',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
    region: 'cn-beijing',
    date: new Date('2026-07-06T00:00:00Z')
  });

  assert.equal(signed.headers['X-Date'], '20260706T000000Z');
  assert.equal(signed.headers['X-Content-Sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.match(
    signed.headers.Authorization,
    /^HMAC-SHA256 Credential=ak\/20260706\/cn-beijing\/ark\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[a-f0-9]{64}$/
  );
});

// `host` is signed but must never be handed to a transport: Chromium refuses a
// manual Host header outright (net::ERR_INVALID_ARGUMENT), and undici replaces
// it with the URL's host, so it was already inert. The pinned signature is the
// point of this test — it proves dropping the wire header leaves the canonical
// request, and therefore the signature, untouched.
test('signVolcengineRequest signs host without sending it as a wire header', () => {
  const signed = signVolcengineRequest({
    url: 'https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01',
    method: 'POST',
    body: '',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
    region: 'cn-beijing',
    date: new Date('2026-07-06T00:00:00Z')
  });

  assert.deepEqual(Object.keys(signed.headers).filter((name) => name.toLowerCase() === 'host'), []);
  assert.match(signed.headers.Authorization, /SignedHeaders=content-type;host;x-content-sha256;x-date/);
  assert.equal(
    signed.headers.Authorization.split('Signature=')[1],
    '68ffeb3bf30b0dc6b2bf535890a9dea4390245346b12a8035b940b83043cf7c0'
  );
});

test('fetchVolcengineLimits returns notConfigured without AK/SK credentials', async () => {
  const [provider] = await fetchVolcengineLimits({}, { env: {}, now: () => Date.parse('2026-07-06T00:00:00Z') });
  assert.equal(provider.provider, 'volcengine');
  assert.equal(provider.source, 'api');
  assert.equal(provider.status, 'notConfigured');
});

test('fetchVolcengineLimits posts the signed Volcengine Coding Plan request', async () => {
  const requests = [];
  const [provider] = await fetchVolcengineLimits(
    { volcengineAccessKeyId: 'AKLT-test', volcengineSecretAccessKey: 'sk', volcengineRegion: 'cn-beijing' },
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
              Status: 'Active',
              PlanName: 'ark pro',
              UpdateTimestamp: 1_783_296_000,
              QuotaUsage: [
                { Level: 'session', Percent: 10, ResetTimestamp: 1_783_314_000 }
              ]
            }
          })
        };
      }
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'Ark Pro');
  assert.equal(provider.windows.length, 1);
  assert.equal(requests[0].url, 'https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01');
  assert.equal(requests[0].init.method, 'POST');
  assert.match(requests[0].init.headers.Authorization, /^HMAC-SHA256 Credential=AKLT-test\//);
});

test('fetchVolcengineLimits probes Ark API key request headers', async () => {
  const requests = [];
  const [provider] = await fetchVolcengineLimits(
    { volcengineAccessKeyId: 'ark-test' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return {
          ok: true,
          status: 200,
          headers: {
            get(name) {
              return {
                'x-ratelimit-remaining-requests': '7',
                'x-ratelimit-limit-requests': '10',
                'x-ratelimit-reset-requests': '2h'
              }[String(name).toLowerCase()] || null;
            }
          },
          json: async () => ({ usage: { total_tokens: 1 } })
        };
      }
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'Ark API');
  assert.equal(provider.windows.length, 1);
  assert.equal(provider.windows[0].label, 'Requests');
  assert.equal(provider.windows[0].used, 3);
  assert.equal(provider.windows[0].limit, 10);
  assert.equal(provider.windows[0].remaining, 7);
  assert.equal(provider.windows[0].usedPercent, 30);
  assert.equal(provider.windows[0].resetsAt, '2026-07-06T02:00:00.000Z');
  assert.equal(requests[0].url, 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions');
  assert.equal(JSON.parse(requests[0].init.body).model, 'doubao-seed-2.0-code');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer ark-test');
});

test('fetchVolcengineLimits omits ambiguous repeated Ark zero remaining windows', async () => {
  const requests = [];
  const [provider] = await fetchVolcengineLimits(
    { volcengineAccessKeyId: 'ark-test' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return {
          ok: true,
          status: 200,
          headers: {
            get(name) {
              return {
                'x-ratelimit-remaining-requests': '0',
                'x-ratelimit-limit-requests': '1000',
                'x-ratelimit-reset-requests': '2h'
              }[String(name).toLowerCase()] || null;
            }
          },
          json: async () => ({})
        };
      }
    }
  );

  assert.equal(provider.status, 'unavailable');
  assert.equal(provider.windows.length, 0);
  assert.equal(requests.length, 2);
});

test('fetchVolcengineLimits preserves exhausted Ark quota when confirmation is rate limited', async () => {
  const requests = [];
  const [provider] = await fetchVolcengineLimits(
    { volcengineAccessKeyId: 'ark-test' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        const status = requests.length === 1 ? 200 : 429;
        return {
          ok: status === 200,
          status,
          headers: {
            get(name) {
              return {
                'x-ratelimit-remaining-requests': '0',
                'x-ratelimit-limit-requests': '1000',
                'x-ratelimit-reset-requests': '2h'
              }[String(name).toLowerCase()] || null;
            }
          },
          json: async () => ({})
        };
      }
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.windows.length, 1);
  assert.equal(provider.windows[0].usedPercent, 100);
  assert.equal(provider.windows[0].used, 1000);
  assert.equal(provider.windows[0].remaining, 0);
  assert.equal(requests.length, 2);
});

test('fetchVolcengineLimits falls back from signed Coding Plan to Ark API key', async () => {
  const requests = [];
  const [provider] = await fetchVolcengineLimits(
    { volcengineAccessKeyId: 'AKLT-test', volcengineSecretAccessKey: 'sk' },
    {
      env: { ARK_API_KEY: 'ark-env' },
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).startsWith('https://open.volcengineapi.com/')) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          headers: {
            get(name) {
              return {
                'x-ratelimit-remaining-requests': '8',
                'x-ratelimit-limit-requests': '10'
              }[String(name).toLowerCase()] || null;
            }
          },
          json: async () => ({})
        };
      }
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'Ark API');
  assert.equal(requests.length, 3);
  const urls = requests.map((request) => request.url);
  assert.ok(urls.includes('https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01'));
  assert.ok(urls.includes('https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01'));
  // The Ark probe only runs once both OpenAPI actions have failed.
  assert.equal(urls.at(-1), 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions');
});

test('fetchVolcengineLimits physically aborts a hung request within its configured bound', async () => {
  let signal;
  const [provider] = await fetchVolcengineLimits(
    { volcengineAccessKeyId: 'AKLT-hung', volcengineSecretAccessKey: 'sk' },
    {
      env: {},
      volcengineFetchTimeoutMs: 5,
      fetch: async (_url, init) => {
        signal = init.signal;
        return new Promise(() => {});
      }
    }
  );

  assert.equal(provider.status, 'unavailable');
  assert.equal(signal.aborted, true);
});

test('fetchVolcengineLimits keeps the response body read inside the deadline', async () => {
  let signal;
  const [provider] = await fetchVolcengineLimits(
    { volcengineAccessKeyId: 'AKLT-hung-body', volcengineSecretAccessKey: 'sk' },
    {
      env: {},
      volcengineFetchTimeoutMs: 5,
      fetch: async (_url, init) => {
        signal = init.signal;
        return {
          ok: true,
          status: 200,
          json: () => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          })
        };
      }
    }
  );

  assert.equal(provider.status, 'unavailable');
  assert.equal(signal.aborted, true);
});

// --- Agent Plan (GetAFPUsage) ------------------------------------------------
// Coding Plan and Agent Plan are two subscriptions on ONE Volcengine account and
// share the AK/SK, so fetchVolcengineLimits reports them as two rows of a single
// provider rather than as two providers.

test('parseVolcengineAgentPlanUsage maps the Agent Plan windows the schema carries', () => {
  const usage = parseVolcengineAgentPlanUsage({
    Result: {
      PlanType: 'Medium',
      AFPFiveHour: { Quota: 200, Used: 50, ResetTime: 1_783_314_000 },
      AFPDaily: { Quota: 1000, Used: 250, ResetTime: 1_783_382_400 },
      AFPWeekly: { Quota: 5000, Used: 1000, ResetTime: 1_783_900_800 },
      AFPMonthly: { Quota: 20000, Used: 2000, ResetTime: 1_785_542_400 }
    }
  });

  assert.equal(usage.plan, 'Medium');
  // AFPDaily is intentionally absent: normalizeWindowKind only accepts
  // session/weekly/billing, so a daily row would be dropped downstream anyway.
  assert.deepEqual(usage.windows.map((w) => w.kind), ['session', 'weekly', 'billing']);
  assert.deepEqual(usage.windows.map((w) => w.label), ['5-hour', 'Weekly', 'Monthly']);
  const weekly = usage.windows[1];
  assert.equal(weekly.used, 1000);
  assert.equal(weekly.limit, 5000);
  assert.equal(weekly.remaining, 4000);
  assert.equal(weekly.usedPercent, 20);
  assert.equal(weekly.resetsAt, '2026-07-13T00:00:00.000Z');
});

test('parseVolcengineAgentPlanUsage drops windows the plan tier does not include', () => {
  const usage = parseVolcengineAgentPlanUsage({
    Result: {
      PlanType: 'Lite',
      AFPFiveHour: { Quota: 100, Used: 10, ResetTime: 1_783_314_000 },
      AFPDaily: { Quota: 0, Used: 0 },
      AFPWeekly: { Quota: -1, Used: 0 }
    }
  });

  assert.deepEqual(usage.windows.map((w) => w.kind), ['session']);
});

test('fetchVolcengineLimits reports Coding Plan and Agent Plan as separate rows', async () => {
  const requests = [];
  const providers = await fetchVolcengineLimits(
    { volcengineAccessKeyId: 'AKLT-test', volcengineSecretAccessKey: 'sk' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url) => {
        requests.push(String(url));
        const body = String(url).includes('GetAFPUsage')
          ? { Result: { PlanType: 'Medium', AFPFiveHour: { Quota: 200, Used: 50, ResetTime: 1_783_314_000 } } }
          : {
            Result: {
              Status: 'Active',
              UpdateTimestamp: 1_783_296_000,
              QuotaUsage: [{ Level: 'session', Percent: 10, ResetTimestamp: 1_783_314_000 }]
            }
          };
        return { ok: true, status: 200, json: async () => body };
      }
    }
  );

  assert.equal(providers.length, 2);
  assert.deepEqual(providers.map((p) => p.provider), ['volcengine', 'volcengine']);
  assert.equal(providers[0].accountLabel, 'Coding Plan');
  assert.equal(providers[1].accountLabel, 'Agent Plan Medium');
  // Both rows must survive dedupe, which keys on `provider:accountKey`.
  assert.notEqual(providers[0].accountKey, providers[1].accountKey);
  assert.ok(requests.some((url) => url.includes('GetCodingPlanUsage')));
  assert.ok(requests.some((url) => url.includes('GetAFPUsage')));
});

// An override that was actually typed in is a claim that a second account
// exists. Swallowing its failure leaves the user with no way to tell a wrong
// key from an account that simply has no Agent Plan.
test('fetchVolcengineLimits surfaces a failure of explicitly configured Agent credentials', async () => {
  const providers = await fetchVolcengineLimits(
    {
      volcengineAccessKeyId: 'AKLT-coding',
      volcengineSecretAccessKey: 'sk',
      volcengineAgentAccessKeyId: 'AKLT-agent',
      volcengineAgentSecretAccessKey: 'agent-sk'
    },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url) => {
        if (String(url).includes('GetAFPUsage')) {
          return { ok: false, status: 401, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            Result: {
              Status: 'Active',
              UpdateTimestamp: 1_783_296_000,
              QuotaUsage: [{ Level: 'session', Percent: 10, ResetTimestamp: 1_783_314_000 }]
            }
          })
        };
      }
    }
  );

  assert.equal(providers.length, 2);
  assert.equal(providers[0].status, 'ok');
  assert.equal(providers[1].status, 'unauthorized');
  // Its own identity, so the runtime cannot smear the Agent failure onto the
  // Coding Plan row that succeeded.
  assert.ok(providers[1].accountKey);
  assert.notEqual(providers[0].accountKey, providers[1].accountKey);
});

test('fetchVolcengineLimits stays silent when the inherited key has no Agent Plan', async () => {
  const providers = await fetchVolcengineLimits(
    { volcengineAccessKeyId: 'AKLT-test', volcengineSecretAccessKey: 'sk' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url) => {
        if (String(url).includes('GetAFPUsage')) {
          return { ok: false, status: 401, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            Result: {
              Status: 'Active',
              UpdateTimestamp: 1_783_296_000,
              QuotaUsage: [{ Level: 'session', Percent: 10, ResetTimestamp: 1_783_314_000 }]
            }
          })
        };
      }
    }
  );

  assert.equal(providers.length, 1);
  assert.equal(providers[0].accountLabel, 'Coding Plan');
});

test('fetchVolcengineLimits omits the Agent Plan row when the account has no Agent subscription', async () => {
  const providers = await fetchVolcengineLimits(
    { volcengineAccessKeyId: 'AKLT-test', volcengineSecretAccessKey: 'sk' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url) => {
        if (String(url).includes('GetAFPUsage')) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            Result: {
              Status: 'Active',
              UpdateTimestamp: 1_783_296_000,
              QuotaUsage: [{ Level: 'session', Percent: 10, ResetTimestamp: 1_783_314_000 }]
            }
          })
        };
      }
    }
  );

  // A missing Agent Plan is not an error: existing Coding Plan users must not
  // grow a permanently failing second row.
  assert.equal(providers.length, 1);
  assert.equal(providers[0].accountLabel, 'Coding Plan');
});

test('fetchVolcengineLimits queries the Agent Plan with its own credentials when they are set', async () => {
  const authorizations = [];
  await fetchVolcengineLimits(
    {
      volcengineAccessKeyId: 'AKLT-coding',
      volcengineSecretAccessKey: 'coding-sk',
      volcengineAgentAccessKeyId: 'AKLT-agent',
      volcengineAgentSecretAccessKey: 'agent-sk'
    },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url, init) => {
        authorizations.push({ url: String(url), auth: init.headers.Authorization });
        return { ok: true, status: 200, json: async () => ({ Result: {} }) };
      }
    }
  );

  const coding = authorizations.find((r) => r.url.includes('GetCodingPlanUsage'));
  const agent = authorizations.find((r) => r.url.includes('GetAFPUsage'));
  assert.match(coding.auth, /Credential=AKLT-coding\//);
  assert.match(agent.auth, /Credential=AKLT-agent\//);
});

test('fetchVolcengineLimits signs the Agent Plan with the Coding Plan key when no override is set', async () => {
  const authorizations = [];
  await fetchVolcengineLimits(
    { volcengineAccessKeyId: 'AKLT-shared', volcengineSecretAccessKey: 'shared-sk' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url, init) => {
        authorizations.push({ url: String(url), auth: init.headers.Authorization });
        return { ok: true, status: 200, json: async () => ({ Result: {} }) };
      }
    }
  );

  const agent = authorizations.find((r) => r.url.includes('GetAFPUsage'));
  assert.match(agent.auth, /Credential=AKLT-shared\//);
});

test('fetchVolcengineLimits never queries the Agent Plan with an Ark API key', async () => {
  const requests = [];
  await fetchVolcengineLimits(
    { volcengineAccessKeyId: 'ark-test' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url) => {
        requests.push(String(url));
        return { ok: true, status: 200, json: async () => ({ choices: [] }), headers: { get: () => null } };
      }
    }
  );

  // GetAFPUsage is OpenAPI-only; an Ark key cannot sign it.
  assert.ok(!requests.some((url) => url.includes('GetAFPUsage')));
});
