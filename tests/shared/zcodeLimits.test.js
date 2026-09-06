'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { discoverZcodeConnection } = require('../../src/shared/zcodeDiscovery');
const { parseZcodeStartPlanBalances } = require('../../src/shared/zaiLimits');

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
    const key = String(filePath).split('/').pop();
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
  const env = { ZCODE_DATA_BASE_DIR: '/opt/zcode-data' };
  const deps = { readFileSync: fileSystem(HAPPY_FILES), homeDir: '/home/test', env };
  assert.equal(discoverZcodeConnection({}, deps).kind, 'start-billing');
  const windowsDeps = { readFileSync: fileSystem(HAPPY_FILES), homeDir: 'C:\\Users\\test', env: { ZCODE_WINDOWS_APP_INSTALL_DIR: 'D:\\zcode' } };
  assert.equal(discoverZcodeConnection({}, windowsDeps).kind, 'start-billing');
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
        show_name: 'GLM-5.5',
        total_units: 1000000,
        used_units: 0,
        remaining_units: 1000000,
        period_start: 1788537600,
        period_end: 1788623999,
        expires_at: 1788623999
      }
    ]
  }
};

test('parseZcodeStartPlanBalances maps buckets to daily and billing windows', () => {
  const { plan, windows } = parseZcodeStartPlanBalances(BILLING_PAYLOAD);
  assert.equal(plan, 'ZCode Weekend Build');
  assert.equal(windows.length, 4);
  const byLabel = new Map(windows.map((window) => [`${window.limitId}:${window.label}`, window]));
  const weekend = byLabel.get('zcode-v3-start-plan-wk-0904:GLM-5.3-Flash');
  assert.equal(weekend.kind, 'billing');
  assert.equal(weekend.windowMinutes, undefined);
  assert.equal(weekend.resetDescription, 'One-time');
  assert.equal(weekend.resetsAt, '2026-09-06T15:00:00.000Z');
  const daily = byLabel.get('zcode-v3-start-plan-0817:GLM-5.3');
  assert.equal(daily.kind, 'daily');
  assert.equal(daily.windowMinutes, 1440);
  assert.equal(daily.used, 421628);
  assert.equal(daily.limit, 3000000);
  assert.equal(daily.remaining, 2578372);
  // Unknown models surface as their own windows instead of being filtered.
  assert.equal(byLabel.get('zcode-v3-future-plan:GLM-5.5').usedPercent, 0);
});
