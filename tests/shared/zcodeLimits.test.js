'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { discoverZcodeConnection } = require('../../src/shared/providers/zai/zcodeDiscovery');
const { parseZaiUsage, parseZcodeStartPlanBalances } = require('../../src/shared/providers/zai/limits');

// Fixtures mirror the live billing/balance payload shape: plan entitlements
// carry the grant period, balance buckets carry the usage numbers. The ZCode
// side mirrors a 3.12.3 install: the kind-based selection is authoritative and
// the legacy selected-key string is retained but frozen.
const SETTINGS = {
  providerFamilyDomain: 'zai',
  providerFamilyConnectionSelections: { zai: { kind: 'start-plan' } },
  modelProviderFamilySelectedKeys: { zai: 'coding-plan:builtin:zai-start-plan' }
};

const REGISTRY = {
  provider: {
    'builtin:zai-start-plan': {
      enabled: true,
      options: { apiKey: 'zcode-mirror-jwt', baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic' }
    },
    'builtin:zai': {
      enabled: false,
      systemDisabledReason: 'oauth_provider_inactive',
      options: { apiKey: 'sk-direct', baseURL: 'https://api.z.ai/api/anthropic' }
    }
  }
};

// The entitlement cache 3.11.x wrote; 3.12.3 leaves the file behind without
// updating it, so discovery must not read it. Kept in the fixtures to pin that
// a stale copy changes no outcome.
const PLAN_CACHE = {
  version: 1,
  entryStatus: {
    updatedAt: 1,
    items: {
      'builtin:zai-start-plan': { status: 'available' },
      'builtin:zai-coding-plan': { status: 'unavailable', reason: 'coding_plan_not_entitled' }
    }
  }
};

const HAPPY_FILES = {
  'setting.json': JSON.stringify(SETTINGS),
  'config.json': JSON.stringify(REGISTRY),
  'coding-plan-cache.json': JSON.stringify(PLAN_CACHE)
};

function fileSystem(files) {
  return (filePath) => {
    // path.join separators are platform-dependent; key on the bare file name
    // so the same fixture resolves on the windows-latest CI leg.
    const key = path.basename(String(filePath));
    if (Object.hasOwn(files, key)) return files[key];
    const error = new Error(`ENOENT: ${filePath}`);
    error.code = 'ENOENT';
    throw error;
  };
}

function discoveryDeps(files) {
  return { readFileSync: fileSystem(files), homeDir: '/home/test' };
}

test('discoverZcodeConnection resolves the selected plan, or none on a broken install', () => {
  const discovery = discoverZcodeConnection({}, discoveryDeps(HAPPY_FILES));
  assert.equal(discovery.kind, 'start-billing');
  assert.equal(discovery.family, 'zai');
  assert.equal(discovery.providerId, 'builtin:zai-start-plan');
  assert.equal(discovery.entitled, true);
  assert.equal(discovery.credential.token, 'zcode-mirror-jwt');
  assert.equal(discovery.credential.source, 'zcode-auto');

  // The stale entitlement cache 3.11.x wrote (and 3.12.3 stopped updating)
  // changes nothing: presence of the mirror key is the local signal since the
  // cache went away, and a plan the cache calls unavailable still answers.
  const staleCache = discoverZcodeConnection({}, discoveryDeps({
    ...HAPPY_FILES,
    'coding-plan-cache.json': JSON.stringify({
      entryStatus: { items: { 'builtin:zai-start-plan': { status: 'unavailable', reason: 'coding_plan_not_entitled' } } }
    })
  }));
  assert.equal(staleCache.kind, 'start-billing');
  assert.equal(staleCache.credential.token, 'zcode-mirror-jwt');

  assert.equal(discoverZcodeConnection({}, discoveryDeps({})).kind, 'none');
  assert.equal(discoverZcodeConnection({}, discoveryDeps({
    ...HAPPY_FILES,
    'setting.json': '{not json'
  })).kind, 'none');
});

test('discoverZcodeConnection maps the 3.12.3 kind selection and falls back to the legacy key', () => {
  const kind = (value, family = 'zai') => ({ ...HAPPY_FILES, 'setting.json': JSON.stringify({
    providerFamilyDomain: family,
    providerFamilyConnectionSelections: { [family]: { kind: value } },
    modelProviderFamilySelectedKeys: { [family]: 'coding-plan:builtin:zai-start-plan' }
  }) });
  const codingRegistry = JSON.stringify({ provider: {
    'builtin:zai-coding-plan': { enabled: false, systemDisabledReason: 'coding_plan_not_entitled', options: { apiKey: 'coding-mirror' } },
    'builtin:zai-start-plan': { enabled: true, options: { apiKey: 'start-mirror' } }
  } });

  const individual = discoverZcodeConnection({}, discoveryDeps({ ...kind('individual-coding-plan'), 'config.json': codingRegistry }));
  assert.equal(individual.kind, 'coding-quota');
  assert.equal(individual.providerId, 'builtin:zai-coding-plan');
  assert.equal(individual.credential.token, 'coding-mirror');

  const team = discoverZcodeConnection({}, discoveryDeps({ ...kind('team-coding-plan'), 'config.json': codingRegistry }));
  assert.equal(team.kind, 'coding-quota');

  // A kind the map does not know yields no lane and must not fall back to the
  // frozen legacy string (which still points at the start plan here). off-peak
  // stands in for that kind: the app carries it as an access mode rather than a
  // selection, so this pins the defensive path, not a shape that can be written.
  const offPeak = discoverZcodeConnection({}, discoveryDeps({ ...kind('off-peak'), 'config.json': codingRegistry }));
  assert.equal(offPeak.kind, 'none');

  // 3.11.x installs only have the legacy string.
  const legacy = discoverZcodeConnection({}, discoveryDeps({
    ...HAPPY_FILES,
    'setting.json': JSON.stringify({ providerFamilyDomain: 'zai', modelProviderFamilySelectedKeys: { zai: 'coding-plan:builtin:zai-coding-plan' } }),
    'config.json': codingRegistry
  }));
  assert.equal(legacy.kind, 'coding-quota');
  assert.equal(legacy.credential.token, 'coding-mirror');
});

test('a disabled entry only blocks discovery when the account context is gone', () => {
  // The entry is composed here instead of through positional reason strings:
  // a string argument carrying ZCode's reason codes makes CodeQL classify the
  // fixture call itself as password data, and the taint then follows the
  // returned deps into the store read's key derivation.
  const startEntry = (entry) => discoveryDeps({
    ...HAPPY_FILES,
    'config.json': JSON.stringify({ provider: {
      'builtin:zai-start-plan': { options: { apiKey: 'zcode-mirror-jwt' }, ...entry }
    } })
  });
  // A persistent not-entitled state (the shape a subscription-less 3.12.3
  // install carries) is queryable — the lane's own error classification
  // answers it, so discovery must not swallow it as "not settled".
  assert.equal(discoverZcodeConnection({}, startEntry({ enabled: false, systemDisabledReason: 'coding_plan_not_entitled' })).credential.token, 'zcode-mirror-jwt');
  assert.equal(discoverZcodeConnection({}, startEntry({ enabled: false, systemDisabledReason: 'coding_plan_auth_failed' })).credential.token, 'zcode-mirror-jwt');
  // The inactive account context and the reason-less torn switch 3.11.x wrote
  // are the only disabled shapes that keep the lane off.
  assert.equal(discoverZcodeConnection({}, startEntry({ enabled: false, systemDisabledReason: 'oauth_provider_inactive' })).kind, 'none');
  assert.equal(discoverZcodeConnection({}, startEntry({ enabled: false })).kind, 'none');
  assert.equal(discoverZcodeConnection({}, startEntry({ enabled: true })).kind, 'start-billing');
});

test('discoverZcodeConnection follows a redirected data base dir', () => {
  // ZCode resolves its base as ZCODE_DATA_BASE_DIR, then HOME, then
  // os.homedir(). The fixture keys on the full joined path, so a regression
  // that drops the env redirect (reads $HOME/.zcode/v2 instead) misses the
  // fixture and this test fails — a basename-only fixture cannot tell them
  // apart.
  const env = { ZCODE_DATA_BASE_DIR: '/opt/zcode-data' };
  const reads = [];
  const track = (readFileSync) => (filePath) => {
    reads.push(String(filePath));
    return readFileSync(filePath);
  };
  const deps = { readFileSync: track(fileSystem(HAPPY_FILES)), homeDir: '/home/test', env };
  assert.equal(discoverZcodeConnection({}, deps).kind, 'start-billing');
  assert.ok(
    reads.some((p) => p === path.join('/opt/zcode-data', '.zcode', 'v2', 'setting.json')),
    `expected a read under /opt/zcode-data, got ${reads.join(', ')}`
  );

  // ZCODE_WINDOWS_APP_INSTALL_DIR is not part of that chain: the app declares
  // the constant and nothing reads it, so an install that sets it must still
  // resolve the data base from the home dir rather than from the install dir.
  reads.length = 0;
  const windowsDeps = { readFileSync: track(fileSystem(HAPPY_FILES)), homeDir: 'C:\\Users\\test', env: { ZCODE_WINDOWS_APP_INSTALL_DIR: 'D:\\zcode' } };
  assert.equal(discoverZcodeConnection({}, windowsDeps).kind, 'start-billing');
  assert.ok(
    reads.some((p) => p === path.join('C:\\Users\\test', '.zcode', 'v2', 'setting.json')),
    `expected a read under the home dir, got ${reads.join(', ')}`
  );
  assert.ok(
    !reads.some((p) => String(p).startsWith('D:\\zcode')),
    `expected no read under the install dir, got ${reads.join(', ')}`
  );
});

test('discoverZcodeConnection reports a direct API selection as unsupported', () => {
  // An api-key provider selection contributes no auto quota; the family is
  // still derived from the entry's baseURL the way ZCode itself does.
  const apiFiles = {
    'setting.json': JSON.stringify({
      providerFamilyDomain: 'zai',
      modelProviderFamilySelectedKeys: { zai: 'preset:builtin:zai' }
    }),
    'config.json': JSON.stringify({
      provider: {
        'builtin:zai': {
          enabled: true,
          options: { apiKey: 'sk-direct', baseURL: 'https://api.z.ai/api/anthropic' }
        }
      }
    })
  };
  const discovery = discoverZcodeConnection({}, discoveryDeps(apiFiles));
  assert.equal(discovery.kind, 'api-unsupported');
  assert.equal(discovery.entitled, false);
  assert.equal(discovery.reason, 'api_balance_not_supported');
  assert.equal(discovery.credential, undefined);
  // A BigModel-hosted baseURL derives the bigmodel family.
  const cn = discoverZcodeConnection({}, discoveryDeps({
    ...apiFiles,
    'config.json': JSON.stringify({
      provider: {
        'builtin:zai': {
          enabled: true,
          options: { apiKey: 'sk-direct', baseURL: 'https://open.bigmodel.cn/api/anthropic' }
        }
      }
    })
  }));
  assert.equal(cn.family, 'bigmodel');
});

test('discoverZcodeConnection returns a coding-quota credential from the mirror key', () => {
  const discovery = discoverZcodeConnection({}, discoveryDeps({
    'setting.json': JSON.stringify({
      ...SETTINGS,
      providerFamilyConnectionSelections: { zai: { kind: 'individual-coding-plan' } },
      modelProviderFamilySelectedKeys: { zai: 'coding-plan:builtin:zai-coding-plan' }
    }),
    'config.json': JSON.stringify({
      provider: {
        'builtin:zai-coding-plan': {
          enabled: true,
          options: { apiKey: 'coding-mirror-key', baseURL: 'https://api.z.ai/api/anthropic' }
        }
      }
    })
  }));
  assert.equal(discovery.kind, 'coding-quota');
  assert.equal(discovery.entitled, true);
  assert.equal(discovery.credential.token, 'coding-mirror-key');
  assert.equal(discovery.family, 'zai');

  // A selected plan entry with no readable credential cannot be queried, so
  // discovery reports it unentitled with its own reason instead of dropping
  // the selection (the settings pill still shows the detected login).
  const keyless = discoverZcodeConnection({}, discoveryDeps({
    'setting.json': JSON.stringify({
      ...SETTINGS,
      providerFamilyConnectionSelections: { zai: { kind: 'individual-coding-plan' } }
    }),
    'config.json': JSON.stringify({ provider: {
      'builtin:zai-coding-plan': { enabled: true, options: { apiKey: '' } }
    } })
  }));
  assert.equal(keyless.kind, 'coding-quota');
  assert.equal(keyless.entitled, false);
  assert.equal(keyless.reason, 'coding_plan_not_authenticated');
});

const BILLING_PAYLOAD = {
  code: 0,
  data: {
    server_time: 1788618955,
    plans: [
      {
        plan_id: 'zcode-v3-start-plan-wk-0904',
        name: 'ZCode Weekend Build',
        status: 'active',
        priority: 100,
        entitlements: [
          { entitlement_id: 'ent-weekend-flash', show_name: 'GLM-5.3-Flash', period: 'one_time', grant_units: 300000000 }
        ]
      },
      {
        plan_id: 'zcode-v3-start-plan-0817',
        name: 'ZCode Start Plan',
        status: 'active',
        priority: 90,
        entitlements: [
          { entitlement_id: 'ent-glm-5p3', show_name: 'GLM-5.3', period: 'daily', grant_units: 3000000 },
          { entitlement_id: 'ent-glm-5p3f', show_name: 'GLM-5.3-Flash', period: 'daily', grant_units: 5000000 }
        ]
      }
    ],
    balances: [
      {
        entitlement_id: 'ent-weekend-flash',
        plan_id: 'zcode-v3-start-plan-wk-0904',
        show_name: 'GLM-5.3-Flash',
        total_units: 300000000,
        used_units: 104149447,
        remaining_units: 195850553,
        period_start: 1788526384,
        period_end: 1788706800,
        expires_at: 1788706800
      },
      {
        entitlement_id: 'ent-glm-5p3',
        plan_id: 'zcode-v3-start-plan-0817',
        show_name: 'GLM-5.3',
        total_units: 3000000,
        used_units: 421628,
        remaining_units: 2578372,
        period_start: 1788537600,
        period_end: 1788623999,
        expires_at: 1788623999
      },
      {
        entitlement_id: 'ent-glm-5p3f',
        plan_id: 'zcode-v3-start-plan-0817',
        show_name: 'GLM-5.3-Flash',
        total_units: 5000000,
        used_units: 5000000,
        remaining_units: 0,
        period_start: 1788537600,
        period_end: 1788623999,
        expires_at: 1788623999
      },
      {
        entitlement_id: 'ent-unknown-model',
        plan_id: 'zcode-v3-future-plan',
        show_name: 'Model-unseen',
        total_units: 1000000,
        used_units: 0,
        remaining_units: 1000000,
        period_start: 1788537600,
        period_end: 1788623999,
        expires_at: 1788623999
      },
      {
        // Some buckets omit remaining_units; used/total must still yield a
        // meter instead of falling through to an absent percentage field.
        entitlement_id: 'ent-no-remaining',
        plan_id: 'zcode-v3-start-plan-0817',
        show_name: 'GLM-5.3-Air',
        total_units: 2000000,
        used_units: 500000,
        period_start: 1788537600,
        period_end: 1788623999,
        expires_at: 1788623999
      }
    ]
  }
};

test('parseZcodeStartPlanBalances aggregates model capacity across plans with weighted usage', () => {
  const { plan, windows } = parseZcodeStartPlanBalances(BILLING_PAYLOAD);
  assert.equal(plan, 'ZCode Start Plan');
  assert.equal(windows.length, 4);
  const byLabel = new Map(windows.map(window => [window.label, window]));
  const flash = byLabel.get('GLM-5.3-Flash');
  assert.equal(flash.limit, 305000000);
  assert.equal(flash.used, 109149447);
  assert.equal(flash.remaining, 195850553);
  assert.ok(Math.abs(flash.usedPercent - 109149447 / 305000000 * 100) < 1e-10);
  assert.equal(flash.kind, 'billing');
  assert.equal(flash.windowMinutes, undefined);
  // The earliest component boundary stays as resetsAt for compatibility and
  // scheduling, while boundaryKind tells presentation what happens there.
  assert.equal(flash.resetsAt, '2026-09-05T15:59:59.000Z');
  assert.equal(flash.boundaryKind, 'reset');
  const daily = byLabel.get('GLM-5.3');
  assert.equal(daily.kind, 'daily');
  assert.equal(daily.windowMinutes, 1440);
  assert.equal(daily.remaining, 2578372);
  assert.equal(daily.boundaryKind, 'reset');
  assert.equal(byLabel.get('Model-unseen').usedPercent, 0);
  assert.equal('boundaryKind' in byLabel.get('Model-unseen'), false);
  assert.equal(byLabel.get('GLM-5.3-Air').remaining, 1500000);
  const reversed = structuredClone(BILLING_PAYLOAD);
  reversed.data.plans.reverse();
  reversed.data.balances.reverse();
  assert.deepEqual(parseZcodeStartPlanBalances(reversed), { plan, windows });
});

test('model aggregation types its earliest lifecycle boundary, including simultaneous changes', () => {
  const payload = (dailyEnd, expiryEnd) => ({ data: {
    plans: [
      { plan_id: 'daily', status: 'active', entitlements: [{ entitlement_id: 'daily-model', period: 'daily' }] },
      { plan_id: 'promo', status: 'active', entitlements: [{ entitlement_id: 'promo-model', period: 'one_time' }] }
    ],
    balances: [
      { plan_id: 'daily', entitlement_id: 'daily-model', show_name: 'GLM-5.3-Flash', total_units: 5, remaining_units: 5, expires_at: dailyEnd },
      { plan_id: 'promo', entitlement_id: 'promo-model', show_name: 'GLM-5.3-Flash', total_units: 300, remaining_units: 300, expires_at: expiryEnd }
    ]
  } });
  const boundary = (dailyEnd, expiryEnd) => parseZcodeStartPlanBalances(payload(dailyEnd, expiryEnd)).windows[0];

  assert.equal(boundary(200, 100).boundaryKind, 'expiry');
  assert.equal(boundary(100, 200).boundaryKind, 'reset');
  assert.equal(boundary(100, 100).boundaryKind, 'mixed');
});

test('missing or unknown periods keep the legacy reset presentation', () => {
  const { windows } = parseZcodeStartPlanBalances({ data: { balances: [
    { show_name: 'Missing period', total_units: 10, remaining_units: 10, expires_at: 100 },
    { show_name: 'Unknown period', period: 'weekly', total_units: 20, remaining_units: 20, expires_at: 200 }
  ] } });

  assert.equal(windows.length, 2);
  for (const window of windows) {
    assert.ok(window.resetsAt);
    assert.equal('boundaryKind' in window, false);
  }
});

test('model aggregation follows returned names regardless of capability ids, optional metadata, or model versions', () => {
  const names = ['model-alpha', 'model-beta'];
  const bucket = (show_name, total, remaining, extra = {}) => ({
    show_name, total_units: total, remaining_units: remaining,
    period: 'daily', ...extra
  });
  for (const name of names) {
    const { windows } = parseZcodeStartPlanBalances({ data: { balances: [
      bucket(name, 100, 20, { plan_id: 'start', capabilities: ['model:old-internal-id'] }),
      bucket(name, 900, 900, {
        plan_id: 'weekend',
        capabilities: ['model:new-internal-id'],
        meter: 'tokens',
        unit_type: 'token',
        period: 'one_time'
      }),
      bucket(`${name}-other`, 200, 100)
    ] } });
    assert.equal(windows.length, 2);
    const model = windows.find(w => w.label === name && w.limit === 1000);
    assert.equal(model.remaining, 920);
    assert.equal(model.used, 80);
    assert.equal(model.usedPercent, 8);
    assert.equal(windows.find(w => w.label === `${name}-other`).limit, 200);
    assert.equal(windows.reduce((sum, w) => sum + w.limit, 0), 1200);
    assert.ok(windows.every(w => w.limitId), 'missing plan ids still carry bucket identity');
  }
});

test('incomplete quantities and anonymous buckets stay separate instead of diluting the aggregate', () => {
  const { windows } = parseZcodeStartPlanBalances({ data: { balances: [
    { show_name: 'Model-unseen', total_units: 100, remaining_units: 90 },
    { show_name: 'Model-unseen', remaining_units: 20 },
    { total_units: 30, remaining_units: 10 },
    { total_units: 40, remaining_units: 20 }
  ] } });
  assert.equal(windows.length, 4);
  assert.ok(windows.every(w => w.limitId));
});

test('discoverZcodeConnection re-reads disk on every call — an account switch lands next round', () => {
  // No caching is the contract: the refresh cycle is the only switch
  // detector, so a second call with changed files must see the new state.
  let files = { ...HAPPY_FILES };
  const deps = { readFileSync: (filePath) => fileSystem(files)(filePath), homeDir: '/home/test' };
  assert.equal(discoverZcodeConnection({}, deps).kind, 'start-billing');

  files = {
    'setting.json': JSON.stringify({
      providerFamilyDomain: 'bigmodel',
      providerFamilyConnectionSelections: { bigmodel: { kind: 'individual-coding-plan' } },
      modelProviderFamilySelectedKeys: { bigmodel: 'coding-plan:builtin:bigmodel-coding-plan' }
    }),
    'config.json': JSON.stringify({
      provider: { 'builtin:bigmodel-coding-plan': { enabled: true, options: { apiKey: 'bm-mirror-key' } } }
    })
  };
  const switched = discoverZcodeConnection({}, deps);
  assert.equal(switched.kind, 'coding-quota');
  assert.equal(switched.family, 'bigmodel');
  assert.equal(switched.credential.token, 'bm-mirror-key');
});

test('a coding-quota selection also surfaces the start-plan billing credential', () => {
  // ZCode queries billing with the start-plan entry even while coding-plan is
  // selected (validateFamilyAccountProviders validates every plan provider the
  // family has, and its start-plan leg is the billing call); the unselected
  // entry keeps enabled:false and still carries its mirror key.
  const files = {
    'setting.json': JSON.stringify({
      providerFamilyDomain: 'zai',
      providerFamilyConnectionSelections: { zai: { kind: 'individual-coding-plan' } },
      modelProviderFamilySelectedKeys: { zai: 'coding-plan:builtin:zai-coding-plan' }
    }),
    'config.json': JSON.stringify({ provider: {
      'builtin:zai-coding-plan': { enabled: true, options: { apiKey: 'coding-mirror' } },
      'builtin:zai-start-plan': { enabled: false, systemDisabledReason: 'coding_plan_not_entitled', options: { apiKey: 'start-jwt' } }
    } })
  };
  const deps = { readFileSync: (filePath) => {
    const name = path.basename(String(filePath));
    if (Object.hasOwn(files, name)) return files[name];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }, homeDir: '/home/test' };
  const discovery = discoverZcodeConnection({}, deps);
  assert.equal(discovery.kind, 'coding-quota');
  assert.equal(discovery.credential.token, 'coding-mirror');
  // The start entry's persistent disabled state no longer suppresses billing:
  // the endpoint is account-level and answers for itself.
  assert.equal(discovery.billing.credential.token, 'start-jwt');

  // Without a start entry (or without its mirror key) there is nothing to ride.
  const noStart = discoverZcodeConnection({}, { ...deps, readFileSync: (filePath) => {
    const name = path.basename(String(filePath));
    if (name === 'config.json') return JSON.stringify({ provider: {
      'builtin:zai-coding-plan': { enabled: true, options: { apiKey: 'coding-mirror' } }
    } });
    if (Object.hasOwn(files, name)) return files[name];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  } });
  assert.equal(noStart.billing, undefined);
});

// ZCode 3.12.3's own normalizers define the tolerance this parser has to
// match: normalizeZaiStartPlanBalanceLimits reads timestamps through
// parseUnixSeconds (numeric strings included, non-positive values absent) and
// matches a bucket to its plan by user_plan_id first, falling back to
// plan_id; pickCurrentSubscriptionFromList prefers the in-current-period VALID
// row over whatever the server lists first.
test('the billing parser accepts ZCode\'s numeric-string timestamps and rejects a zero epoch', () => {
  const { windows } = parseZcodeStartPlanBalances({ data: {
    plans: [{ plan_id: 'p1', status: 'active', entitlements: [{ entitlement_id: 'e1', period: 'daily' }] }],
    balances: [
      { plan_id: 'p1', entitlement_id: 'e1', show_name: 'String expiry', total_units: 10, remaining_units: 5, expires_at: '1788706800' },
      { plan_id: 'p1', entitlement_id: 'e1', show_name: 'Zero expiry', total_units: 10, remaining_units: 5, expires_at: 0 },
      { plan_id: 'p1', entitlement_id: 'e1', show_name: 'ISO expiry', total_units: 10, remaining_units: 5, expires_at: '2026-09-06T15:00:00.000Z' }
    ]
  } });
  const byLabel = new Map(windows.map((window) => [window.label, window]));
  assert.equal(byLabel.get('String expiry').resetsAt, '2026-09-06T15:00:00.000Z');
  assert.equal(byLabel.get('Zero expiry').resetsAt, undefined, 'a non-positive epoch is absent, not 1970');
  assert.equal(byLabel.get('ISO expiry').resetsAt, '2026-09-06T15:00:00.000Z');
});

test('a bucket matches its plan through user_plan_id when the two identities differ', () => {
  const payload = (balance) => ({ data: {
    plans: [{ plan_id: 'plan-a', user_plan_id: 'user-plan-7', status: 'active',
      entitlements: [{ entitlement_id: 'e1', period: 'daily' }] }],
    balances: [balance]
  } });
  const base = { entitlement_id: 'e1', show_name: 'GLM-5.3', total_units: 100, remaining_units: 40, expires_at: 1788706800 };

  // The bucket carries only the subscription-scoped identity; matching on
  // plan_id alone would leave it without a period, losing its daily shape.
  const matched = parseZcodeStartPlanBalances(payload({ ...base, user_plan_id: 'user-plan-7' }));
  assert.equal(matched.windows.length, 1);
  assert.equal(matched.windows[0].kind, 'daily');
  assert.equal(matched.windows[0].windowMinutes, 1440);
  assert.equal(matched.windows[0].boundaryKind, 'reset');

  // A bucket whose identities match nothing keeps the billing shape — the
  // fallback must not invent a daily window for an unknown plan.
  const unmatched = parseZcodeStartPlanBalances(payload({ ...base, plan_id: 'plan-unrelated' }));
  assert.equal(unmatched.windows[0].kind, 'billing');
  assert.equal(unmatched.windows[0].windowMinutes, undefined);
});

test('the subscription picker prefers the current-period VALID row over a listed-first expired one', () => {
  const usage = parseZaiUsage(
    { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 }] } },
    { data: [
      { productName: 'Expired Plan', status: 'EXPIRED', inCurrentPeriod: false },
      { productName: 'GLM Coding Pro', status: 'VALID', inCurrentPeriod: true, nextRenewTime: '2026-10-13T00:00:00Z' }
    ] }
  );
  assert.equal(usage.plan, 'GLM Coding Pro');

  // Without any usable marker the first row still names the account, which is
  // the pre-existing fallback; the picker only reorders when it has a signal.
  const fallback = parseZaiUsage(
    { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 }] } },
    { data: [{ productName: 'Only Plan' }] }
  );
  assert.equal(fallback.plan, 'Only Plan');
});

// The fixture is encrypted exactly the way ZCode's own
// createCredentialCipherProvider writes it (AES-256-GCM, sha256-derived key,
// base64url(iv).base64url(tag).base64url(cipher) under an enc:v1: prefix), so
// the tests prove interop with the real store rather than a hand-rolled shape.
const TEST_CREDENTIAL_SECRET = 'test-credential-secret';

function encryptCredential(value, secret) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

test('the billing credential prefers the live credential store over the mirror', () => {
  const files = {
    'setting.json': JSON.stringify({
      providerFamilyDomain: 'zai',
      providerFamilyConnectionSelections: { zai: { kind: 'start-plan' } }
    }),
    'config.json': JSON.stringify({ provider: {
      'builtin:zai-start-plan': { enabled: true, options: { apiKey: 'stale-mirror' } }
    } }),
    'credentials.json': JSON.stringify({ zcodejwttoken: encryptCredential('live-jwt', TEST_CREDENTIAL_SECRET) })
  };
  const deps = (overrides = {}) => ({
    readFileSync: fileSystem({ ...files, ...overrides }),
    homeDir: '/home/test',
    env: { ZCODE_CREDENTIAL_SECRET: TEST_CREDENTIAL_SECRET }
  });

  const discovery = discoverZcodeConnection({}, deps());
  assert.equal(discovery.kind, 'start-billing');
  assert.equal(discovery.credential.token, 'live-jwt');

  // Every failure shape degrades to the mirror silently: a malformed
  // envelope, a missing store, and a store encrypted under another machine's
  // key (the wrong secret must not surface an error).
  assert.equal(discoverZcodeConnection({}, deps({ 'credentials.json': JSON.stringify({ zcodejwttoken: 'enc:v1:not-valid' }) })).credential.token, 'stale-mirror');
  assert.equal(discoverZcodeConnection({}, deps({ 'credentials.json': '{' })).credential.token, 'stale-mirror');
  assert.equal(discoverZcodeConnection({}, deps({
    'credentials.json': JSON.stringify({ zcodejwttoken: encryptCredential('live-jwt', 'another-machine-secret') })
  })).credential.token, 'stale-mirror');
  const noStore = { ...files };
  delete noStore['credentials.json'];
  assert.equal(discoverZcodeConnection({}, {
    readFileSync: fileSystem(noStore), homeDir: '/home/test', env: { ZCODE_CREDENTIAL_SECRET: TEST_CREDENTIAL_SECRET }
  }).credential.token, 'stale-mirror');
});

test('a coding-quota selection takes the live billing credential for its billing lane', () => {
  const discovery = discoverZcodeConnection({}, {
    readFileSync: fileSystem({
      'setting.json': JSON.stringify({
        providerFamilyDomain: 'zai',
        providerFamilyConnectionSelections: { zai: { kind: 'individual-coding-plan' } }
      }),
      'config.json': JSON.stringify({ provider: {
        'builtin:zai-coding-plan': { enabled: true, options: { apiKey: 'coding-mirror' } },
        'builtin:zai-start-plan': { enabled: false, systemDisabledReason: 'coding_plan_not_entitled', options: { apiKey: 'stale-start-mirror' } }
      } }),
      'credentials.json': JSON.stringify({ zcodejwttoken: encryptCredential('live-jwt', TEST_CREDENTIAL_SECRET) })
    }),
    homeDir: '/home/test',
    env: { ZCODE_CREDENTIAL_SECRET: TEST_CREDENTIAL_SECRET }
  });
  assert.equal(discovery.kind, 'coding-quota');
  // Quota keeps the mirror key (the console-shaped credential the quota
  // endpoint accepts); the billing lane takes the live JWT.
  assert.equal(discovery.credential.token, 'coding-mirror');
  assert.equal(discovery.billing.credential.token, 'live-jwt');
});

test('the selected account\'s own store key outranks a mirror left by another account', () => {
  // A machine that switched accounts under 3.12.3: config.json keeps the
  // previous account's mirror (never rewritten), while the store names the
  // logged-in account's key by provider id + profile user id. Reading the
  // mirror first would attribute a different account's quota to this login.
  const identity = 'b1a2c3d4-0000-1111-2222-333344445555';
  const files = {
    'setting.json': JSON.stringify({
      providerFamilyDomain: 'zai',
      providerFamilyConnectionSelections: { zai: { kind: 'individual-coding-plan' } }
    }),
    'config.json': JSON.stringify({ provider: {
      'builtin:zai-coding-plan': { enabled: false, systemDisabledReason: 'coding_plan_not_entitled', options: { apiKey: 'other-account-mirror' } }
    } }),
    'credentials.json': JSON.stringify({
      zcodejwttoken: encryptCredential('live-billing-jwt', TEST_CREDENTIAL_SECRET),
      'oauth:zai:user_info': encryptCredential(JSON.stringify({ user_id: identity, name: 'x' }), TEST_CREDENTIAL_SECRET),
      [`account-provider:coding-plan:account:zai-individual-coding-plan:account:${identity}:api-key`]:
        encryptCredential('current-account-key', TEST_CREDENTIAL_SECRET)
    })
  };
  const deps = {
    readFileSync: fileSystem(files),
    homeDir: '/home/test',
    env: { ZCODE_CREDENTIAL_SECRET: TEST_CREDENTIAL_SECRET }
  };
  const discovery = discoverZcodeConnection({}, deps);
  assert.equal(discovery.kind, 'coding-quota');
  assert.equal(discovery.credential.token, 'current-account-key');
  // The billing lane still takes the store's account-level JWT.
  assert.equal(discovery.billing.credential.token, 'live-billing-jwt');

  // A profile whose identity names no store entry resolves to no credential at
  // all: the mirror cannot be shown to belong to the account the profile just
  // named, so the lane reports that state instead of querying with it
  // (docs/providers/zai.md — the store entry is filled lazily, so its absence
  // beside a readable profile is a not-yet-filled or never-issued state).
  const mismatched = { ...files, 'credentials.json': JSON.stringify({
    zcodejwttoken: encryptCredential('live-billing-jwt', TEST_CREDENTIAL_SECRET),
    'oauth:zai:user_info': encryptCredential(JSON.stringify({ user_id: 'nobody' }), TEST_CREDENTIAL_SECRET),
    [`account-provider:coding-plan:account:zai-individual-coding-plan:account:${identity}:api-key`]:
      encryptCredential('current-account-key', TEST_CREDENTIAL_SECRET)
  }) };
  const fallback = discoverZcodeConnection({}, { ...deps, readFileSync: fileSystem(mismatched) });
  assert.equal(fallback.entitled, false);
  assert.equal(fallback.reason, 'coding_plan_key_missing');
  assert.equal(fallback.credential, undefined);
  // The billing leg is a different credential — the account-level JWT ZCode
  // maintains on login — so refusing the quota half leaves Start/Weekend
  // queryable rather than taking it down with the mirror.
  assert.equal(fallback.billing.credential.token, 'live-billing-jwt');

  // A team entry is named the same way (the real store carries
  // `…:zai-team-coding-plan:account:<id>:api-key`), so a team selection
  // resolves its own key — and only falls back when that entry is absent.
  const teamFiles = (withTeamEntry) => ({
    ...files,
    'setting.json': JSON.stringify({
      providerFamilyDomain: 'zai',
      providerFamilyConnectionSelections: { zai: { kind: 'team-coding-plan' } }
    }),
    'credentials.json': JSON.stringify({
      zcodejwttoken: encryptCredential('live-billing-jwt', TEST_CREDENTIAL_SECRET),
      'oauth:zai:user_info': encryptCredential(JSON.stringify({ user_id: identity }), TEST_CREDENTIAL_SECRET),
      ...(withTeamEntry ? {
        [`account-provider:coding-plan:account:zai-team-coding-plan:account:${identity}:api-key`]:
          encryptCredential('team-account-key', TEST_CREDENTIAL_SECRET)
      } : {})
    })
  });
  const team = discoverZcodeConnection({}, { ...deps, readFileSync: fileSystem(teamFiles(true)) });
  assert.equal(team.credential.token, 'team-account-key');
  const teamMissing = discoverZcodeConnection({}, { ...deps, readFileSync: fileSystem(teamFiles(false)) });
  assert.equal(teamMissing.entitled, false);
  assert.equal(teamMissing.reason, 'coding_plan_key_missing');
  assert.equal(teamMissing.credential, undefined);
  assert.equal(teamMissing.billing.credential.token, 'live-billing-jwt');

  // With the live JWT gone as well there is nothing for the billing leg either,
  // and the refused quota half is the whole answer.
  const noBilling = discoverZcodeConnection({}, { ...deps, readFileSync: fileSystem({
    ...mismatched,
    'credentials.json': JSON.stringify({
      'oauth:zai:user_info': encryptCredential(JSON.stringify({ user_id: 'nobody' }), TEST_CREDENTIAL_SECRET)
    })
  }) });
  assert.equal(noBilling.reason, 'coding_plan_key_missing');
  assert.equal(noBilling.billing, undefined);
});

test('an unreadable profile or store still degrades the quota lane to the mirror', () => {
  // The other half of the boundary above, and the behavior approved in #718:
  // the mirror stays the fallback wherever no identity can be established,
  // because there is no account for it to contradict. Every shape below must
  // keep reading the mirror — turning one into "no credential" would dark the
  // lane on a 3.11.x install or on a store this machine cannot read.
  const files = {
    'setting.json': JSON.stringify({
      providerFamilyDomain: 'zai',
      providerFamilyConnectionSelections: { zai: { kind: 'individual-coding-plan' } }
    }),
    'config.json': JSON.stringify({ provider: {
      'builtin:zai-coding-plan': { enabled: true, options: { apiKey: 'mirror-fallback' } }
    } })
  };
  const token = (credentials) => discoverZcodeConnection({}, {
    readFileSync: fileSystem(credentials ? { ...files, 'credentials.json': credentials } : files),
    homeDir: '/home/test',
    env: { ZCODE_CREDENTIAL_SECRET: TEST_CREDENTIAL_SECRET }
  }).credential.token;
  const store = (entries) => JSON.stringify(entries);

  // No store at all (3.11.x), or a store file that does not parse.
  assert.equal(token(null), 'mirror-fallback');
  assert.equal(token('{'), 'mirror-fallback');
  // The profile entry is encrypted under another machine's key, does not parse
  // after decrypting, or carries no identity field at all.
  assert.equal(token(store({
    'oauth:zai:user_info': encryptCredential(JSON.stringify({ user_id: 'x' }), 'another-machine-secret')
  })), 'mirror-fallback');
  assert.equal(token(store({
    'oauth:zai:user_info': encryptCredential('{not json', TEST_CREDENTIAL_SECRET)
  })), 'mirror-fallback');
  assert.equal(token(store({
    'oauth:zai:user_info': encryptCredential(JSON.stringify({ name: 'x' }), TEST_CREDENTIAL_SECRET)
  })), 'mirror-fallback');
  // An entry that exists beside a readable identity but cannot be decrypted is
  // the same read failure, not the identity-known-no-entry state above.
  assert.equal(token(store({
    'oauth:zai:user_info': encryptCredential(JSON.stringify({ user_id: 'known' }), TEST_CREDENTIAL_SECRET),
    'account-provider:coding-plan:account:zai-individual-coding-plan:account:known:api-key':
      encryptCredential('unreadable-key', 'another-machine-secret')
  })), 'mirror-fallback');
});

test('a fresh 3.12.3 install with no mirror recovers its key from the store', () => {
  // The machine never ran 3.11.x, so the provider entry's mirror was never
  // written — the state that made a subscribed account render nothing at all.
  const identity = 'c2b3d4e5-1111-2222-3333-444455556666';
  const discovery = discoverZcodeConnection({}, {
    readFileSync: fileSystem({
      'setting.json': JSON.stringify({
        providerFamilyDomain: 'zai',
        providerFamilyConnectionSelections: { zai: { kind: 'individual-coding-plan' } }
      }),
      'config.json': JSON.stringify({ provider: {
        'builtin:zai-coding-plan': { enabled: true, options: { apiKey: '' } }
      } }),
      'credentials.json': JSON.stringify({
        zcodejwttoken: encryptCredential('fresh-billing-jwt', TEST_CREDENTIAL_SECRET),
        'oauth:zai:user_info': encryptCredential(JSON.stringify({ user_id: identity }), TEST_CREDENTIAL_SECRET),
        [`account-provider:coding-plan:account:zai-individual-coding-plan:account:${identity}:api-key`]:
          encryptCredential('fresh-account-key', TEST_CREDENTIAL_SECRET)
      })
    }),
    homeDir: '/home/test',
    env: { ZCODE_CREDENTIAL_SECRET: TEST_CREDENTIAL_SECRET }
  });
  assert.equal(discovery.kind, 'coding-quota');
  assert.equal(discovery.entitled, true);
  assert.equal(discovery.credential.token, 'fresh-account-key');
  assert.equal(discovery.billing.credential.token, 'fresh-billing-jwt');
});

test('a non-zai profile resolves its store key from the normalized shape', () => {
  // ZCode stores a zai profile as the raw user-info document and every other
  // family as the normalized profile, so a bigmodel profile carries the identity
  // on `id` and has no `user_id` at all. Reading `user_id` alone would return
  // null for every bigmodel account and leave it on the plaintext mirror — the
  // behavior this store read replaces — so the reachable shape is pinned here.
  const identity = 'e4d5f6a7-3333-4444-5555-666677778888';
  const discovery = discoverZcodeConnection({}, {
    readFileSync: fileSystem({
      'setting.json': JSON.stringify({
        providerFamilyDomain: 'bigmodel',
        providerFamilyConnectionSelections: { bigmodel: { kind: 'individual-coding-plan' } }
      }),
      'config.json': JSON.stringify({ provider: {
        'builtin:bigmodel-coding-plan': { enabled: true, options: { apiKey: 'bigmodel-mirror' } }
      } }),
      'credentials.json': JSON.stringify({
        'oauth:bigmodel:user_info': encryptCredential(
          JSON.stringify({ id: identity, username: 'x', displayName: 'x' }),
          TEST_CREDENTIAL_SECRET
        ),
        [`account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:${identity}:api-key`]:
          encryptCredential('bigmodel-account-key', TEST_CREDENTIAL_SECRET)
      })
    }),
    homeDir: '/home/test',
    env: { ZCODE_CREDENTIAL_SECRET: TEST_CREDENTIAL_SECRET }
  });
  assert.equal(discovery.kind, 'coding-quota');
  assert.equal(discovery.family, 'bigmodel');
  assert.equal(discovery.providerId, 'builtin:bigmodel-coding-plan');
  assert.equal(discovery.credential.token, 'bigmodel-account-key');
});

test('the store entry is chosen by the profile identity, not by entry order', () => {
  // One machine can hold entries for several accounts; only the one the
  // profile names may be used, whatever order the store lists them in.
  const current = 'd3c4e5f6-2222-3333-4444-555566667777';
  const previous = 'e4d5f6a7-3333-4444-5555-666677778888';
  const entry = (id, token) => [`account-provider:coding-plan:account:zai-individual-coding-plan:account:${id}:api-key`,
    encryptCredential(token, TEST_CREDENTIAL_SECRET)];
  const discovery = discoverZcodeConnection({}, {
    readFileSync: fileSystem({
      'setting.json': JSON.stringify({
        providerFamilyDomain: 'zai',
        providerFamilyConnectionSelections: { zai: { kind: 'individual-coding-plan' } }
      }),
      'config.json': JSON.stringify({ provider: {
        'builtin:zai-coding-plan': { enabled: true, options: { apiKey: 'unused-mirror' } }
      } }),
      'credentials.json': JSON.stringify(Object.fromEntries([
        // The previous account's entry is listed first on purpose.
        entry(previous, 'previous-account-key'),
        entry(current, 'current-account-key'),
        ['oauth:zai:user_info', encryptCredential(JSON.stringify({ user_id: current }), TEST_CREDENTIAL_SECRET)]
      ]))
    }),
    homeDir: '/home/test',
    env: { ZCODE_CREDENTIAL_SECRET: TEST_CREDENTIAL_SECRET }
  });
  assert.equal(discovery.credential.token, 'current-account-key');
});

test('a transient userInfo failure does not pin the machine-derived secret', () => {
  // The only fixture that exercises the machine fallback — every other store
  // test passes an explicit secret — so it is encrypted with the string this
  // process would derive. A directory-service hiccup must not cache the
  // "unknown" variant: that would fail every later decrypt for the rest of the
  // process, and a machine with no mirror would stay dark until a restart.
  // The successful call below fills that process-level cache for the rest of
  // this file, which is harmless: the explicit-secret tests never consult it.
  const machineSecret = `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`;
  const identity = 'machine-identity';
  const files = {
    'setting.json': JSON.stringify({
      providerFamilyDomain: 'zai',
      providerFamilyConnectionSelections: { zai: { kind: 'individual-coding-plan' } }
    }),
    'config.json': JSON.stringify({ provider: {
      'builtin:zai-coding-plan': { enabled: true, options: { apiKey: 'mirror-fallback' } }
    } }),
    'credentials.json': JSON.stringify({
      'oauth:zai:user_info': encryptCredential(JSON.stringify({ user_id: identity }), machineSecret),
      [`account-provider:coding-plan:account:zai-individual-coding-plan:account:${identity}:api-key`]:
        encryptCredential('machine-account-key', machineSecret)
    })
  };
  const deps = { readFileSync: fileSystem(files), homeDir: '/home/test', env: {} };
  const realUserInfo = os.userInfo;
  try {
    os.userInfo = () => { throw new Error('directory service unavailable'); };
    assert.equal(discoverZcodeConnection({}, deps).credential.token, 'mirror-fallback');
  } finally {
    os.userInfo = realUserInfo;
  }
  assert.equal(discoverZcodeConnection({}, deps).credential.token, 'machine-account-key');
});
