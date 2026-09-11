'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { discoverZcodeConnection } = require('../../src/shared/providers/zai/zcodeDiscovery');
const { parseZcodeStartPlanBalances } = require('../../src/shared/providers/zai/limits');

// Fixtures mirror the live billing/balance payload shape: plan entitlements
// carry the grant period, balance buckets carry the usage numbers.
const SETTINGS = {
  providerFamilyDomain: 'zai',
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

  // Failure paths all collapse the same way: an unentitled plan keeps its
  // cache reason, and missing or malformed files degrade to kind 'none'
  // rather than surfacing as errors.
  const unentitled = discoverZcodeConnection({}, discoveryDeps({
    ...HAPPY_FILES,
    'coding-plan-cache.json': JSON.stringify({
      entryStatus: { items: { 'builtin:zai-start-plan': { status: 'unavailable', reason: 'coding_plan_not_entitled' } } }
    })
  }));
  assert.equal(unentitled.entitled, false);
  assert.equal(unentitled.reason, 'coding_plan_not_entitled');
  assert.equal(discoverZcodeConnection({}, discoveryDeps({})).kind, 'none');
  assert.equal(discoverZcodeConnection({}, discoveryDeps({
    ...HAPPY_FILES,
    'setting.json': '{not json'
  })).kind, 'none');
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
  assert.equal(discovery.entitled, false);
  assert.equal(discovery.reason, 'api_balance_not_supported');
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
      modelProviderFamilySelectedKeys: { zai: 'coding-plan:builtin:zai-coding-plan' }
    }),
    'config.json': JSON.stringify({
      provider: {
        'builtin:zai-coding-plan': {
          enabled: true,
          options: { apiKey: 'coding-mirror-key', baseURL: 'https://api.z.ai/api/anthropic' }
        }
      }
    }),
    'coding-plan-cache.json': JSON.stringify({
      entryStatus: { items: { 'builtin:zai-coding-plan': { status: 'available' } } }
    })
  }));
  assert.equal(discovery.kind, 'coding-quota');
  assert.equal(discovery.entitled, true);
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
      modelProviderFamilySelectedKeys: { bigmodel: 'coding-plan:builtin:bigmodel-coding-plan' }
    }),
    'config.json': JSON.stringify({
      provider: { 'builtin:bigmodel-coding-plan': { enabled: true, options: { apiKey: 'bm-mirror-key' } } }
    }),
    'coding-plan-cache.json': JSON.stringify({
      entryStatus: { items: { 'builtin:bigmodel-coding-plan': { status: 'available' } } }
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
    'setting.json': JSON.stringify({ providerFamilyDomain: 'zai', modelProviderFamilySelectedKeys: { zai: 'coding-plan:builtin:zai-coding-plan' } }),
    'config.json': JSON.stringify({ provider: {
      'builtin:zai-coding-plan': { enabled: true, options: { apiKey: 'coding-mirror' } },
      'builtin:zai-start-plan': { enabled: false, options: { apiKey: 'start-jwt' } }
    } }),
    'coding-plan-cache.json': JSON.stringify({ entryStatus: { items: {
      'builtin:zai-coding-plan': { status: 'available' },
      'builtin:zai-start-plan': { status: 'available' }
    } } })
  };
  const deps = { readFileSync: (filePath) => {
    const name = path.basename(String(filePath));
    if (Object.hasOwn(files, name)) return files[name];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }, homeDir: '/home/test' };
  const discovery = discoverZcodeConnection({}, deps);
  assert.equal(discovery.kind, 'coding-quota');
  assert.equal(discovery.credential.token, 'coding-mirror');
  assert.equal(discovery.billing.credential.token, 'start-jwt');

  // No billing when the start-plan entry is not entitled.
  const unentitled = JSON.parse(files['coding-plan-cache.json']);
  unentitled.entryStatus.items['builtin:zai-start-plan'] = { status: 'unavailable', reason: 'coding_plan_not_entitled' };
  const noBilling = discoverZcodeConnection({}, { ...deps, readFileSync: (filePath) => {
    const name = path.basename(String(filePath));
    if (name === 'coding-plan-cache.json') return JSON.stringify(unentitled);
    if (Object.hasOwn(files, name)) return files[name];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  } });
  assert.equal(noBilling.billing, undefined);
});
