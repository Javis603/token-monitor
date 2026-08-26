'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const {
  ZCODE_FETCH_TIMEOUT_MS,
  DEFAULT_ZCODE_APP_VERSION,
  resolveZcodeHome,
  resolveZcodeAppVersion,
  zcodeBillingUrl,
  zcodeQuotaUrl,
  decryptZcodeCredentialValue,
  loadZcodeAuthCandidates,
  loadZcodeSelectedPlanProviderKeys,
  zcodePlanLabel,
  parseZcodeBalance,
  parseZcodeCodingPlanQuota,
  fetchZcodeLimits
} = require('../../src/shared/zcodeLimits');
const { hashKey } = require('../../src/shared/hashKey');

const HOME = path.join(path.sep, 'fake-home');
const FIXED_NOW = Date.parse('2026-08-26T00:00:00Z');
const CREDENTIAL_SECRET = 'test-credential-secret';

function fakeFs(files) {
  const has = (filePath) => Object.prototype.hasOwnProperty.call(files, filePath);
  return {
    existsSync: has,
    readFileSync: (filePath) => {
      if (!has(filePath)) {
        const error = new Error(`ENOENT: ${filePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      return files[filePath];
    }
  };
}

function zcodeFile(name, value) {
  return { [path.join(HOME, '.zcode', 'v2', name)]: JSON.stringify(value) };
}

function encryptCredential(plain, secret) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

test('resolveZcodeHome honors env overrides and falls back to ~/.zcode', () => {
  assert.equal(resolveZcodeHome({ home: '/users/a', env: { TOKEN_MONITOR_ZCODE_HOME: ' /custom ' } }), path.resolve('/custom'));
  assert.equal(resolveZcodeHome({ home: '/users/a', env: { ZCODE_HOME: '/zcode-home' } }), path.resolve('/zcode-home'));
  assert.equal(resolveZcodeHome({ home: '/users/a', env: {} }), path.join('/users/a', '.zcode'));
});

test('resolveZcodeAppVersion defaults and reads the env override', () => {
  assert.equal(resolveZcodeAppVersion({}), DEFAULT_ZCODE_APP_VERSION);
  assert.equal(resolveZcodeAppVersion({ TOKEN_MONITOR_ZCODE_APP_VERSION: ' 9.9.9 ' }), '9.9.9');
});

test('zcodeBillingUrl carries the app_version query parameter', () => {
  const url = new URL(zcodeBillingUrl({}));
  assert.equal(url.origin + url.pathname, 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance');
  assert.equal(url.searchParams.get('app_version'), DEFAULT_ZCODE_APP_VERSION);
  assert.equal(
    url.searchParams.get('app_version'),
    '3.2.5',
    'the fallback app version must stay conservative: the billing endpoint rejects missing values'
  );
});

test('zcodeQuotaUrl routes bigmodel coding plans to bigmodel.cn and the rest to z.ai', () => {
  assert.equal(zcodeQuotaUrl('builtin:bigmodel-coding-plan'), 'https://bigmodel.cn/api/monitor/usage/quota/limit');
  assert.equal(zcodeQuotaUrl('builtin:zai-coding-plan'), 'https://api.z.ai/api/monitor/usage/quota/limit');
});

test('zcodePlanLabel extracts the human tier from plan ids', () => {
  assert.equal(zcodePlanLabel('zcode-v3-start-plan-0615'), 'Start');
  assert.equal(zcodePlanLabel('lite'), 'Lite');
  assert.equal(zcodePlanLabel('MAX'), 'Max');
  assert.equal(zcodePlanLabel('team-plan'), 'Team');
  assert.equal(zcodePlanLabel('zcode-unknown-42'), '');
});

test('decryptZcodeCredentialValue decrypts sealed values and passes plaintext through', () => {
  const sealed = encryptCredential('stored-jwt', CREDENTIAL_SECRET);
  assert.equal(
    decryptZcodeCredentialValue(sealed, { home: HOME, env: { ZCODE_CREDENTIAL_SECRET: CREDENTIAL_SECRET } }),
    'stored-jwt'
  );
  assert.equal(decryptZcodeCredentialValue('plain-jwt', { home: HOME, env: {} }), 'plain-jwt');
  // Tampered or malformed sealed values must fail closed, never yield partial output.
  assert.equal(decryptZcodeCredentialValue('enc:v1:bad', { home: HOME, env: {} }), null);
  assert.equal(
    decryptZcodeCredentialValue(`${sealed}x`, { home: HOME, env: { ZCODE_CREDENTIAL_SECRET: CREDENTIAL_SECRET } }),
    null
  );
  assert.equal(
    decryptZcodeCredentialValue(sealed, { home: HOME, env: { ZCODE_CREDENTIAL_SECRET: 'wrong-secret' } }),
    null
  );
});

test('loadZcodeSelectedPlanProviderKeys extracts builtin plan keys across domains', () => {
  const files = {
    ...zcodeFile('setting.json', {
      providerFamilyDomain: 'zai',
      modelProviderFamilySelectedKeys: {
        zai: 'coding-plan:builtin:zai-start-plan',
        bigmodel: 'coding-plan:builtin:bigmodel-coding-plan'
      }
    })
  };
  assert.deepEqual(
    loadZcodeSelectedPlanProviderKeys({ home: HOME, env: {}, ...fakeFs(files) }),
    ['builtin:zai-start-plan', 'builtin:bigmodel-coding-plan']
  );
  assert.deepEqual(
    loadZcodeSelectedPlanProviderKeys({ home: HOME, env: {}, ...fakeFs({}) }),
    []
  );
});

test('loadZcodeAuthCandidates returns nothing when no ZCode login exists', () => {
  assert.deepEqual(loadZcodeAuthCandidates({ home: HOME, env: {}, ...fakeFs({}) }), []);
});

test('loadZcodeAuthCandidates puts the selected provider first and cleans quoted keys', () => {
  const files = {
    ...zcodeFile('config.json', {
      provider: {
        'builtin:zai-start-plan': { options: { apiKey: '  "jwt-token"  ' } },
        'builtin:zai-coding-plan': { options: { apiKey: 'coding-key' } }
      }
    }),
    ...zcodeFile('setting.json', {
      providerFamilyDomain: 'zai',
      modelProviderFamilySelectedKeys: { zai: 'coding-plan:builtin:zai-start-plan' }
    })
  };
  const candidates = loadZcodeAuthCandidates({ home: HOME, env: {}, ...fakeFs(files) });
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates[0], {
    apiKey: 'jwt-token',
    authSource: 'provider:config',
    providerKey: 'builtin:zai-start-plan',
    planKind: 'start-plan'
  });
  assert.deepEqual(candidates[1], {
    apiKey: 'coding-key',
    authSource: 'provider:config',
    providerKey: 'builtin:zai-coding-plan',
    planKind: 'coding-plan'
  });
});

test('loadZcodeAuthCandidates keeps only providers the availability cache reports usable', () => {
  const files = {
    ...zcodeFile('config.json', {
      provider: {
        'builtin:zai-start-plan': { options: { apiKey: 'jwt-token' } },
        'builtin:zai-coding-plan': { options: { apiKey: 'coding-key' }, enabled: false }
      }
    }),
    ...zcodeFile('coding-plan-cache.json', {
      entryStatus: {
        items: {
          'builtin:zai-start-plan': { status: 'available' },
          'builtin:zai-coding-plan': { status: 'unavailable' }
        }
      }
    })
  };
  const candidates = loadZcodeAuthCandidates({ home: HOME, env: {}, ...fakeFs(files) });
  assert.deepEqual(candidates.map((candidate) => candidate.providerKey), ['builtin:zai-start-plan']);
});

test('loadZcodeAuthCandidates falls back to the sealed credentials.json start-plan token', () => {
  const files = {
    ...zcodeFile('config.json', {
      provider: { 'builtin:zai-start-plan': { options: {} } }
    }),
    ...zcodeFile('credentials.json', {
      'oauth:active_provider': encryptCredential('zai', CREDENTIAL_SECRET),
      zcodejwttoken: encryptCredential('sealed-jwt', CREDENTIAL_SECRET)
    })
  };
  const candidates = loadZcodeAuthCandidates({
    home: HOME,
    env: { ZCODE_CREDENTIAL_SECRET: CREDENTIAL_SECRET },
    ...fakeFs(files)
  });
  assert.deepEqual(candidates, [{
    apiKey: 'sealed-jwt',
    authSource: 'credential:zcodejwttoken',
    providerKey: 'builtin:zai-start-plan',
    planKind: 'start-plan'
  }]);
});

test('loadZcodeAuthCandidates uses the env token as a headless fallback', () => {
  const candidates = loadZcodeAuthCandidates({
    home: HOME,
    env: { ZCODE_ACCESS_TOKEN: ' env-jwt ' },
    ...fakeFs({})
  });
  assert.deepEqual(candidates, [{
    apiKey: 'env-jwt',
    authSource: 'env',
    providerKey: 'builtin:zai-start-plan',
    planKind: 'start-plan'
  }]);
});

test('parseZcodeBalance maps per-model daily grants to billing windows', () => {
  const parsed = parseZcodeBalance({
    code: 0,
    data: {
      balances: [
        {
          show_name: 'GLM-4.6 daily units',
          total_units: 60,
          used_units: 15,
          remaining_units: 45,
          period_end: 1789000000,
          plan_id: 'zcode-v3-start-plan-0615'
        },
        {
          show_name: 'Air daily units',
          total_units: 300,
          used_units: 300,
          remaining_units: 0,
          period_end: 1789000000
        }
      ]
    }
  });
  assert.equal(parsed.accountLabel, 'Start');
  assert.equal(parsed.planId, 'zcode-v3-start-plan-0615');
  assert.equal(parsed.windows.length, 2);
  // Largest grant first so the primary meter leads.
  assert.equal(parsed.windows[0].label, 'Air daily units');
  assert.equal(parsed.windows[0].used, 300);
  assert.equal(parsed.windows[0].limit, 300);
  assert.equal(parsed.windows[0].remaining, 0);
  assert.equal(parsed.windows[0].usedPercent, 100);
  assert.equal(parsed.windows[0].resetsAt, new Date(1789000000 * 1000).toISOString());
  assert.equal(parsed.windows[1].label, 'GLM-4.6 daily units');
  assert.equal(parsed.windows[1].usedPercent, 25);
  assert.equal(parsed.windows[1].kind, 'billing');
  assert.equal(parsed.windows[1].showMeter, true);
});

test('parseZcodeBalance derives used percent from remaining when used is absent', () => {
  const parsed = parseZcodeBalance({
    data: {
      balances: [{ show_name: 'Daily units', total_units: 200, remaining_units: 50, expires_at: 1789000000 }]
    }
  });
  assert.equal(parsed.windows[0].usedPercent, 75);
  assert.equal(parsed.windows[0].resetsAt, new Date(1789000000 * 1000).toISOString());
});

test('parseZcodeBalance rejects malformed payloads', () => {
  assert.throws(() => parseZcodeBalance({}), /missing data/);
  assert.throws(() => parseZcodeBalance({ code: 400, msg: 'expired token', data: {} }), /code=400/);
});

test('parseZcodeCodingPlanQuota maps the ZCode sidebar windows', () => {
  const parsed = parseZcodeCodingPlanQuota({
    code: 200,
    success: true,
    data: {
      level: 'max',
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 26 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 5, nextResetTime: 1789000000000 },
        { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, currentValue: 2, remaining: 3998, percentage: 1 }
      ]
    }
  });
  assert.equal(parsed.accountLabel, 'Max');
  const byLabel = new Map(parsed.windows.map((window) => [window.label, window]));
  assert.equal(parsed.windows.length, 3);
  assert.equal(byLabel.get('5-hour').kind, 'session');
  assert.equal(byLabel.get('5-hour').usedPercent, 26);
  assert.equal(byLabel.get('5-hour').windowMinutes, 300);
  assert.equal(byLabel.get('Weekly').kind, 'weekly');
  assert.equal(byLabel.get('Weekly').usedPercent, 5);
  assert.equal(byLabel.get('Weekly').windowMinutes, 10080);
  assert.equal(byLabel.get('Weekly').resetsAt, new Date(1789000000000).toISOString());
  assert.equal(byLabel.get('Tools').kind, 'billing');
  assert.equal(byLabel.get('Tools').usedPercent, 1);
  // percentage wins over usage/number: no raw counts so the meter stays honest.
  assert.equal(byLabel.get('Tools').used, undefined);
  assert.equal(byLabel.get('Tools').limit, undefined);
});

test('parseZcodeCodingPlanQuota falls back to usage counts when percentage is absent', () => {
  const parsed = parseZcodeCodingPlanQuota({
    data: {
      limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 100, nextResetTime: 1789000000000 }]
    }
  });
  assert.equal(parsed.windows.length, 1);
  assert.equal(parsed.windows[0].used, 100);
  assert.equal(parsed.windows[0].limit, 5);
  assert.equal(parsed.windows[0].usedPercent, 100);
});

test('parseZcodeCodingPlanQuota renders unknown window encodings', () => {
  const parsed = parseZcodeCodingPlanQuota({
    data: {
      level: 'lite',
      limits: [
        { type: 'TOKENS_LIMIT', unit: 1, number: 2, usage: 1, percentage: 40, usageDetails: [{ displayName: 'Daily tokens' }] },
        { type: 'TIME_LIMIT', unit: 5, number: 30, usage: 10, percentage: 20 }
      ]
    }
  });
  assert.equal(parsed.accountLabel, 'Lite');
  assert.equal(parsed.windows.length, 2);
  const daily = parsed.windows.find((window) => window.label === 'Daily tokens');
  assert.equal(daily.kind, 'weekly');
  assert.equal(daily.windowMinutes, 2880);
  assert.equal(daily.usedPercent, 40);
  const timeWindow = parsed.windows.find((window) => window.label === 'TIME_LIMIT');
  assert.equal(timeWindow.kind, 'billing');
  assert.equal(timeWindow.usedPercent, 20);
});

test('parseZcodeCodingPlanQuota rejects malformed payloads', () => {
  assert.throws(() => parseZcodeCodingPlanQuota({}), /missing data/);
  assert.throws(() => parseZcodeCodingPlanQuota({ code: 403, msg: 'denied', data: {} }), /code=403/);
  assert.throws(() => parseZcodeCodingPlanQuota({ success: false, msg: 'bad key', data: {} }), /bad key/);
});

test('fetchZcodeLimits reports notConfigured without a local ZCode login', async () => {
  const provider = await fetchZcodeLimits({}, {
    env: {},
    now: () => FIXED_NOW,
    home: HOME,
    ...fakeFs({})
  });
  assert.equal(provider.provider, 'zcode');
  assert.equal(provider.status, 'notConfigured');
  assert.equal(provider.source, 'api');
  assert.equal(provider.updatedAt, new Date(FIXED_NOW).toISOString());
  assert.deepEqual(provider.windows, []);
});

test('fetchZcodeLimits reads the Start Plan balance with ZCode client headers', async () => {
  const files = {
    ...zcodeFile('config.json', {
      provider: { 'builtin:zai-start-plan': { options: { apiKey: 'jwt-token' } } }
    })
  };
  const urls = [];
  const headersList = [];
  const provider = await fetchZcodeLimits({}, {
    env: {},
    now: () => FIXED_NOW,
    home: HOME,
    ...fakeFs(files),
    fetch: async (url, init) => {
      urls.push(String(url));
      headersList.push(init.headers);
      return jsonResponse({
        code: 0,
        data: {
          balances: [{
            show_name: 'Daily units',
            total_units: 60,
            used_units: 15,
            remaining_units: 45,
            period_end: 1789000000,
            plan_id: 'zcode-v3-start-plan-0615'
          }]
        }
      });
    }
  });
  assert.equal(provider.provider, 'zcode');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountKey, hashKey('zcode', 'jwt-token'));
  assert.equal(provider.accountLabel, 'Start');
  assert.deepEqual(urls, [zcodeBillingUrl({})]);
  const headers = headersList[0];
  assert.equal(headers.Authorization, 'Bearer jwt-token');
  assert.equal(headers['User-Agent'], `ZCode/${DEFAULT_ZCODE_APP_VERSION}`);
  assert.equal(headers['X-ZCode-App-Version'], DEFAULT_ZCODE_APP_VERSION);
  assert.equal(headers['HTTP-Referer'], 'https://zcode.z.ai/');
  assert.equal(headers['X-Release-Channel'], 'stable');
  assert.equal(headers.Accept, 'application/json');
  assert.equal(provider.windows.length, 1);
  assert.equal(provider.windows[0].kind, 'billing');
  assert.equal(provider.windows[0].usedPercent, 25);
  assert.equal(provider.windows[0].remainingPercent, 75);
});

test('fetchZcodeLimits reads the Coding Plan quota with the raw API key header', async () => {
  const files = {
    ...zcodeFile('config.json', {
      provider: { 'builtin:zai-coding-plan': { options: { apiKey: 'coding-key' } } }
    }),
    ...zcodeFile('setting.json', {
      providerFamilyDomain: 'zai',
      modelProviderFamilySelectedKeys: { zai: 'coding-plan:builtin:zai-coding-plan' }
    })
  };
  const urls = [];
  const headersList = [];
  const provider = await fetchZcodeLimits({}, {
    env: {},
    now: () => FIXED_NOW,
    home: HOME,
    ...fakeFs(files),
    fetch: async (url, init) => {
      urls.push(String(url));
      headersList.push(init.headers);
      return jsonResponse({
        code: 200,
        success: true,
        data: {
          level: 'max',
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 26 },
            { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 5 }
          ]
        }
      });
    }
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountKey, hashKey('zcode', 'coding-key'));
  assert.deepEqual(urls, ['https://api.z.ai/api/monitor/usage/quota/limit']);
  assert.equal(headersList[0].authorization, 'coding-key');
  assert.equal(headersList[0].Accept, 'application/json');
  assert.equal(provider.windows.length, 2);
  assert.equal(provider.windows[0].kind, 'session');
  assert.equal(provider.windows[1].kind, 'weekly');
});

test('fetchZcodeLimits targets bigmodel.cn for the BigModel coding plan', async () => {
  const files = {
    ...zcodeFile('config.json', {
      provider: { 'builtin:bigmodel-coding-plan': { options: { apiKey: 'bm-coding-key' } } }
    })
  };
  const urls = [];
  const provider = await fetchZcodeLimits({}, {
    env: {},
    now: () => FIXED_NOW,
    home: HOME,
    ...fakeFs(files),
    fetch: async (url) => {
      urls.push(String(url));
      return jsonResponse({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 5 }] } });
    }
  });
  assert.equal(provider.status, 'ok');
  assert.deepEqual(urls, ['https://bigmodel.cn/api/monitor/usage/quota/limit']);
});

test('fetchZcodeLimits surfaces an expired login as unauthorized', async () => {
  const files = {
    ...zcodeFile('config.json', {
      provider: { 'builtin:zai-start-plan': { options: { apiKey: 'stale-jwt' } } }
    })
  };
  const provider = await fetchZcodeLimits({}, {
    env: {},
    now: () => FIXED_NOW,
    home: HOME,
    ...fakeFs(files),
    fetch: async () => ({ ok: false, status: 401, json: async () => ({}) })
  });
  assert.equal(provider.provider, 'zcode');
  assert.equal(provider.status, 'unauthorized');
  assert.deepEqual(provider.windows, []);
});

test('fetchZcodeLimits marks server errors and empty balances unavailable', async () => {
  const files = {
    ...zcodeFile('config.json', {
      provider: { 'builtin:zai-start-plan': { options: { apiKey: 'jwt-token' } } }
    })
  };
  const serverError = await fetchZcodeLimits({}, {
    env: {},
    now: () => FIXED_NOW,
    home: HOME,
    ...fakeFs(files),
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) })
  });
  assert.equal(serverError.status, 'unavailable');

  const emptyBalances = await fetchZcodeLimits({}, {
    env: {},
    now: () => FIXED_NOW,
    home: HOME,
    ...fakeFs(files),
    fetch: async () => jsonResponse({ code: 0, data: { balances: [] } })
  });
  assert.equal(emptyBalances.status, 'unavailable');
  assert.deepEqual(emptyBalances.windows, []);
});

test('fetchZcodeLimits tries the next plan provider when the selected one fails', async () => {
  const files = {
    ...zcodeFile('config.json', {
      provider: {
        'builtin:zai-start-plan': { options: { apiKey: 'stale-jwt' } },
        'builtin:zai-coding-plan': { options: { apiKey: 'coding-key' } }
      }
    })
  };
  const urls = [];
  const provider = await fetchZcodeLimits({}, {
    env: {},
    now: () => FIXED_NOW,
    home: HOME,
    ...fakeFs(files),
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).includes('billing/balance')) {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return jsonResponse({
        data: { level: 'max', limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 5 }] }
      });
    }
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountKey, hashKey('zcode', 'coding-key'));
  assert.deepEqual(urls, [
    zcodeBillingUrl({}),
    'https://api.z.ai/api/monitor/usage/quota/limit'
  ]);
});

test('fetchZcodeLimits physically aborts a hung request within its configured bound', async () => {
  const files = {
    ...zcodeFile('config.json', {
      provider: { 'builtin:zai-start-plan': { options: { apiKey: 'hung-jwt' } } }
    })
  };
  let signal;
  const provider = await fetchZcodeLimits({}, {
    env: {},
    home: HOME,
    zcodeFetchTimeoutMs: 5,
    ...fakeFs(files),
    fetch: async (_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    }
  });
  assert.equal(provider.provider, 'zcode');
  assert.equal(provider.status, 'unavailable');
  assert.equal(signal.aborted, true);
});

test('ZCODE_FETCH_TIMEOUT_MS stays a sane bounded probe budget', () => {
  assert.equal(ZCODE_FETCH_TIMEOUT_MS, 12_000);
});
