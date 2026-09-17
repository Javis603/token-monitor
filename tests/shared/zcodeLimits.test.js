'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { discoverZcodeConnection } = require('../../src/shared/providers/zai/zcodeDiscovery');
const { parseZcodeStartPlanBalances } = require('../../src/shared/providers/zai/limits');

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

  // An off-peak selection has no GLM plan lane; it must not fall back to the
  // frozen legacy string (which still points at the start plan here).
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
  const disabled = (enabled, systemDisabledReason) => discoveryDeps({
    ...HAPPY_FILES,
    'config.json': JSON.stringify({ provider: {
      'builtin:zai-start-plan': { enabled, systemDisabledReason, options: { apiKey: 'zcode-mirror-jwt' } }
    } })
  });
  // A persistent not-entitled state (the shape a subscription-less 3.12.3
  // install carries) is queryable — the lane's own error classification
  // answers it, so discovery must not swallow it as "not settled".
  assert.equal(discoverZcodeConnection({}, disabled(false, 'coding_plan_not_entitled')).credential.token, 'zcode-mirror-jwt');
  assert.equal(discoverZcodeConnection({}, disabled(false, 'coding_plan_auth_failed')).credential.token, 'zcode-mirror-jwt');
  // The inactive account context and the reason-less torn switch 3.11.x wrote
  // are the only disabled shapes that keep the lane off.
  assert.equal(discoverZcodeConnection({}, disabled(false, 'oauth_provider_inactive')).kind, 'none');
  assert.equal(discoverZcodeConnection({}, disabled(false, undefined)).kind, 'none');
  assert.equal(discoverZcodeConnection({}, disabled(true, undefined)).kind, 'start-billing');
});

test('discoverZcodeConnection follows a redirected data base dir', () => {
  // ZCode resolves its base as ZCODE_DATA_BASE_DIR (Windows installs may
  // also set ZCODE_WINDOWS_APP_INSTALL_DIR), then HOME, then os.homedir().
  // The fixture keys on the full joined path, so a regression that drops
  // the env redirect (reads $HOME/.zcode/v2 instead) misses the fixture
  // and this test fails — a basename-only fixture cannot tell them apart.
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

  reads.length = 0;
  const windowsDeps = { readFileSync: track(fileSystem(HAPPY_FILES)), homeDir: 'C:\\Users\\test', env: { ZCODE_WINDOWS_APP_INSTALL_DIR: 'D:\\zcode' } };
  assert.equal(discoverZcodeConnection({}, windowsDeps).kind, 'start-billing');
  assert.ok(
    reads.some((p) => p === path.join('D:\\zcode', '.zcode', 'v2', 'setting.json')),
    `expected a read under D:\\zcode, got ${reads.join(', ')}`
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
  assert.equal(discovery.credential.token, 'coding-mirror-key');
  assert.equal(discovery.family, 'zai');
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
  // selected (validateZaiCodingPlanPairAvailability); the unselected entry
  // keeps enabled:false and still carries its mirror key.
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
