'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { limitProviderEntry, LIMIT_PROVIDER_FETCHERS } = require('../../src/shared/limits/registry');
const { accountStatusProjection } = require('../../src/electron/limits/accountSettings');
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
const { copilotAccountKey, fetchCopilotLimits } = require('../../src/shared/providers/copilot/limits');
const { hashKey } = require('../../src/shared/hashKey');
const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb+/=';
const encoded = encodeURIComponent(token);
const response = (body) => ({ ok: true, status: 200, json: async () => body });

test('OpenCode local source describes its usage database and Kimi web complements API', () => {
  assert.equal(limitProviderEntry('opencode').sources.find(s => s.id === 'local').descriptionKey,
    'settings.limits.sources.opencodeLocalDescription');
  assert.equal(limitProviderEntry('kimi').sources.find(s => s.id === 'web').relation, 'complement');
});

test('Manus status includes desktop discovery and keeps settings/environment precedence', t => {
  const entry = limitProviderEntry('manus');
  t.mock.method(entry.limits, 'readManusDesktopSession', () => ({ token: 'desktop-session' }));
  t.mock.method(limitProviderEntry('hark').limits, 'readHarkDesktopSession', () => null);
  t.mock.method(limitProviderEntry('zai').limits, 'discoverZcodeConnection', () => ({}));
  assert.equal(accountStatusProjection({}, {}).manusSessionTokenConfigured, true);
  assert.equal(accountStatusProjection({}, {}).manusSessionTokenSource, 'manus-desktop');
  assert.equal(accountStatusProjection({}, { MANUS_SESSION_TOKEN: 'env.token.sig' }).manusSessionTokenSource, 'env');
  assert.equal(accountStatusProjection({ manusSessionToken: 'saved.token.sig' }, { MANUS_SESSION_TOKEN: 'env.token.sig' }).manusSessionTokenSource, 'settings');
  assert.equal(accountStatusProjection({}, { MANUS_SESSION_TOKEN: 'aaa.bbb.ccc' }).manusSessionTokenSource, 'env');
  assert.equal(accountStatusProjection({ manusSessionToken: 'ddd.eee.fff' }, { MANUS_SESSION_TOKEN: 'aaa.bbb.ccc' }).manusSessionTokenSource, 'settings');
  assert.equal(entry.accountStatus({ settings: { manusSessionToken: 'saved' }, env: {}, discovered: true }).manusSessionTokenSource, 'settings');
  assert.equal(entry.accountStatus({ settings: {}, env: { MANUS_SESSION_TOKEN: 'aaa.bbb.ccc' }, discovered: true }).manusSessionTokenSource, 'env');
  entry.limits.readManusDesktopSession = () => { throw Object.assign(new Error('locked'), { status: 'unavailable' }); };
  assert.equal(accountStatusProjection({}, {}).manusSessionTokenConfigured, true);
  entry.limits.readManusDesktopSession = () => { throw Object.assign(new Error('signed out'), { status: 'notConfigured' }); };
  assert.equal(accountStatusProjection({}, {}).manusSessionTokenConfigured, false);
});

test('limits runtime discovers local credentials only for enabled providers', () => {
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  const calls = [];
  const runtime = createLimitsRuntime({ limitProviders: ['codex'] }, {
    autoStart: false, env: {},
    readHarkDesktopSession: () => { calls.push('hark'); return null; },
    readManusDesktopSession: () => { calls.push('manus'); return null; },
    discoverZcodeConnection: () => { calls.push('zai'); return {}; }
  });
  try {
    assert.deepEqual(calls, []);
    runtime.reconfigure({ limitProviders: ['codex'] });
    assert.deepEqual(calls, []);
    runtime.reconfigure({ limitProviders: ['codex', 'hark'] });
    assert.deepEqual(calls, ['hark']);
  } finally { runtime.stop(); }
});

test('Hark equivalent saved cookie spellings update one slot and preserve its controls', async () => {
  let settings = {};
  let requests = 0;
  const service = createAccountSlotService({ getSettings: () => settings, env: {},
    write: patch => { settings = { ...settings, ...patch }; },
    probeDeps: () => ({ fetch: async () => { requests++; return response({ plan: { id: 'free' }, meters: { harkTokens: { dailyUsed: 1, dailyLimit: 10, poolUsed: 1, poolLimit: 100 } } }); }, readHarkDesktopSession: () => '' }) });
  assert.equal((await service.add('hark', { harkCookie: token }, 'Personal')).saved, true);
  const before = settings.harkAccountSlots[0];
  await service.setEnabled('hark', before.id, false);
  assert.equal((await service.add('hark', { harkCookie: encoded }, 'Other')).saved, true);
  assert.equal(settings.harkAccountSlots.length, 1);
  const after = settings.harkAccountSlots[0];
  assert.deepEqual([after.id, after.label, after.enabled, after.accountKey, after.createdAt],
    [before.id, 'Personal', false, before.accountKey, before.createdAt]);
  assert.equal(requests, 2);
});

test('Hark equivalent environment and desktop cookie spellings have one visible account', () => {
  for (const desktop of [token, encoded]) for (const environment of [token, encoded, `Cookie: __Secure-hark.session_token=${encoded}`]) {
    const service = createAccountSlotService({ getSettings: () => ({}), env: { HARK_COOKIE: environment },
      write: () => {}, probeDeps: () => ({ readHarkDesktopSession: () => desktop }) });
    const rows = service.list('hark').accounts;
    assert.equal(rows.length, 1, `${desktop} / ${environment}`);
    assert.equal(rows[0].accountKey, hashKey('hark', token));
  }
});

test('Copilot exact scoped profile wins credential deduplication during identity and usage outage', async () => {
  const key = copilotAccountKey('alice');
  let requests = 0;
  const rows = await fetchCopilotLimits({ copilotProfiles: {
    unbound: { token: 'shared' }, bound: { token: 'shared', accountKey: key, accountName: 'alice' }
  }, limitRefreshScope: { provider: 'copilot', accountKey: key } }, {
    env: {}, fetch: async () => { requests++; return { ok: false, status: 401 }; }
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountKey, key);
  assert.equal(rows[0].accountName, 'alice');
  assert.equal(rows[0].status, 'unauthorized');
  assert.equal(requests, 2);
});

test('Copilot unbound legacy scoped failure answers its fallback key without probing siblings', async () => {
  const key = copilotAccountKey('first');
  const requests = [];
  const rows = await LIMIT_PROVIDER_FETCHERS.copilot({ copilotAccountSlots: [{ id: 'paused', enabled: false, values: { copilotApiToken: 'paused' } }], copilotProfiles: {
    first: { token: 'first' }, second: { token: 'second' }
  }, limitRefreshScope: { provider: 'copilot', accountKey: key } }, {
    env: {}, fetch: async (_url, init) => { requests.push(init.headers.Authorization); return { ok: false, status: 401 }; }
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountKey, key);
  assert.equal(rows[0].status, 'unauthorized');
  assert.deepEqual(requests, ['token first', 'token first']);
});
