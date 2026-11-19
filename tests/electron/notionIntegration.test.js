'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCredentialCommands } = require('../../src/electron/limits/credentialCommands');
const { accountFieldProjection, limitAccountFormsForRenderer } = require('../../src/electron/limits/accountSettings');
const { classifySettingsChange, limitsConfigFromSettings } = require('../../src/electron/runtimeConfig');
const { settingsLimitInvalidationPlan } = require('../../src/electron/deviceRuntimeCoordinator');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { fetchNotionLimits } = require('../../src/shared/providers/notion/limits');

const USER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SPACE = '11111111-2222-3333-4444-555555555555';
const SPACE_B = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const COOKIE = 'token_v2=synthetic-notion-session';
const spaces = {
  [USER]: {
    notion_user: { [USER]: { value: { value: { id: USER } } } },
    space: { [SPACE]: { value: { id: SPACE, subscription_tier: 'business' } } }
  }
};
const usage = {
  status: 'within_limit',
  window: { creditType: 'basic_ai_credits', scope: 'per_user', window: '6h', used: 21, limit: 50 },
  resetsInSeconds: 3600,
  billingPeriodWindow: { creditType: 'basic_ai_credits', scope: 'per_user', cadence: 'billing_period', used: 18, limit: 100, periodEndMs: 1793491200000 }
};
const response = (status, body) => ({ status, ok: status === 200, json: async () => structuredClone(body) });

test('Notion generic credential save probes the exact draft and keeps secrets in main', async () => {
  const patches = [];
  const calls = [];
  const api = createCredentialCommands({
    getSettings: () => ({ limitProviders: 'codex', notionCookie: 'old-private-session' }),
    applySettingsPatch: (patch) => { patches.push(patch); return accountFieldProjection(patch, {}); },
    probeDeps: () => ({ fetch: async (url, init) => {
      calls.push({ url, init });
      return response(200, url.endsWith('/getSpaces') ? spaces : usage);
    } }),
    env: { NOTION_COOKIE: 'unsubmitted-env-secret', NOTION_WORKSPACE_ID: SPACE_B }
  });
  const result = await api.saveCredential('notion', { notionCookie: COOKIE, notionWorkspaceId: SPACE });
  assert.equal(result.verdict, 'valid');
  assert.equal(result.saved, true);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].notionCookie, COOKIE);
  assert.equal(patches[0].notionWorkspaceId, SPACE);
  assert.equal(patches[0].limitProviders, 'codex,notion');
  assert.equal(result.settings.notionCookie, 'set');
  assert.equal(JSON.stringify(result).includes('synthetic-notion-session'), false);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].init.body), { spaceId: SPACE });
  assert.equal(JSON.stringify(calls).includes('unsubmitted-env-secret'), false);
  const form = limitAccountFormsForRenderer().find((entry) => entry.id === 'notion');
  assert.ok(form);
  assert.equal(form.fields.find((field) => field.key === 'notionCookie').input, 'password');
  assert.equal(JSON.stringify(form).includes('storePath'), false);
});

test('Notion incomplete drafts and rejected sessions never persist a credential', async () => {
  let requests = 0;
  const patches = [];
  const api = createCredentialCommands({
    getSettings: () => ({ notionCookie: COOKIE, notionWorkspaceId: SPACE }),
    applySettingsPatch: (patch) => patches.push(patch),
    probeDeps: () => ({ fetch: async () => { requests += 1; return response(401, {}); } }),
    env: { NOTION_COOKIE: COOKIE, NOTION_WORKSPACE_ID: SPACE }
  });
  assert.equal((await api.saveCredential('notion', { notionWorkspaceId: SPACE })).saved, false);
  assert.equal((await api.saveCredential('notion', { notionCookie: COOKIE })).saved, false);
  assert.equal(requests, 0);
  const result = await api.saveCredential('notion', { notionCookie: COOKIE, notionWorkspaceId: SPACE });
  assert.equal(result.saved, false);
  assert.equal(result.status, 'unauthorized');
  assert.deepEqual(patches, []);
});

test('Notion workspace changes clear only its limits lane and do not restart usage', () => {
  const previous = { notionCookie: COOKIE, notionWorkspaceId: SPACE };
  const next = { ...previous, notionWorkspaceId: SPACE_B };
  const change = classifySettingsChange(previous, next);
  assert.equal(change.usageStructural, false);
  assert.deepEqual(change.limitScopes, [{ provider: 'notion' }]);
  assert.deepEqual(settingsLimitInvalidationPlan(change), [
    { scope: { provider: 'notion' }, reason: 'settings-change', options: { clear: true } }
  ]);
  const config = limitsConfigFromSettings({}, { env: { NOTION_COOKIE: COOKIE, NOTION_WORKSPACE_ID: SPACE } });
  assert.equal(config.notionCookie, COOKIE);
  assert.equal(config.notionWorkspaceId, SPACE);
});

test('Notion runtime retains truthful last-good readings for an outage and clears them after rejection', async (t) => {
  let status = 'ok';
  let now = Date.parse('2026-10-14T10:00:00Z');
  const runtime = createLimitsRuntime({ limitProviders: ['notion'] }, {
    autoStart: false,
    now: () => now,
    probeProvider: async () => [{
      provider: 'notion', accountKey: 'sha256:fixture-user-workspace', source: 'web', status,
      updatedAt: new Date(now).toISOString(),
      windows: status === 'ok' ? [{ kind: 'session', label: 'Rolling', usedPercent: 42, resetsAt: '2026-10-14T11:00:00Z' }] : []
    }]
  });
  t.after(() => runtime.stop());
  await runtime.refresh({ provider: 'notion' }, 'credential-save');
  const initial = runtime.getSnapshot().providers[0];
  assert.equal(initial.status, 'ok');
  status = 'unavailable';
  now += 1000;
  await runtime.refresh({ provider: 'notion' }, 'credential-save');
  const retained = runtime.getSnapshot().providers[0];
  assert.equal(retained.status, 'unavailable');
  assert.equal(retained.updatedAt, initial.updatedAt);
  assert.deepEqual(retained.windows, initial.windows);
  status = 'unauthorized';
  now += 1000;
  await runtime.refresh({ provider: 'notion' }, 'credential-save');
  assert.equal(runtime.getSnapshot().providers[0].status, 'unauthorized');
  assert.deepEqual(runtime.getSnapshot().providers[0].windows, []);
});

test('Notion challenges preserve last-good windows and keep exact-draft saves indeterminate', async (t) => {
  for (const failAt of ['getSpaces', 'getCreditRateLimitStatus']) {
    let challenge = false;
    let now = Date.parse('2026-10-14T10:00:00Z');
    const fetch = async (url) => {
      if (challenge && url.endsWith(`/${failAt}`)) {
        return {
          status: 403,
          headers: new Headers({ 'cf-mitigated': 'challenge' }),
          json: async () => { throw new Error('must not inspect challenge body'); }
        };
      }
      return response(200, url.endsWith('/getSpaces') ? spaces : usage);
    };
    const runtime = createLimitsRuntime({ limitProviders: ['notion'] }, {
      autoStart: false,
      now: () => now,
      probeProvider: async () => [await fetchNotionLimits(
        { notionCookie: COOKIE, notionWorkspaceId: SPACE }, { fetch, now: () => now, env: {} }
      )]
    });
    t.after(() => runtime.stop());
    await runtime.refresh({ provider: 'notion' }, 'credential-save');
    const initial = runtime.getSnapshot().providers[0];
    assert.equal(initial.status, 'ok');
    assert.equal(initial.windows.length, 2);
    challenge = true;
    now += 1000;
    await runtime.refresh({ provider: 'notion' }, 'credential-save');
    const retained = runtime.getSnapshot().providers[0];
    assert.equal(retained.status, 'unavailable');
    assert.equal(retained.updatedAt, initial.updatedAt);
    assert.deepEqual(retained.windows, initial.windows);

    const patches = [];
    const api = createCredentialCommands({
      getSettings: () => ({}),
      applySettingsPatch: (patch) => { patches.push(patch); return accountFieldProjection(patch, {}); },
      probeDeps: () => ({ fetch }),
      env: {}
    });
    const result = await api.saveCredential('notion', { notionCookie: COOKIE, notionWorkspaceId: SPACE });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.verdict, 'indeterminate');
    assert.equal(result.saved, true);
    assert.equal(patches.length, 1);
    assert.equal(result.settings.notionCookie, 'set');
    assert.equal(JSON.stringify(result).includes('synthetic-notion-session'), false);
  }
});
