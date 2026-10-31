'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createCredentialCommands } = require('../../src/electron/limits/credentialCommands');
const { accountFieldProjection, limitAccountFormsForRenderer } = require('../../src/electron/limits/accountSettings');
const { classifySettingsChange } = require('../../src/electron/runtimeConfig');
const { dedupeAccounts, sameAccount, localDeviceLimitsProviders } = require('../../src/electron/renderer/accountIdentity');
const { fixtureFetch } = require('../fixtures/museai');

test('Muse uses the generic exact-draft save, main-only credential and account form', async () => {
  const patches = [];
  const api = createCredentialCommands({
    getSettings: () => ({ limitProviders: 'muse' }),
    applySettingsPatch: (patch) => { patches.push(patch); return accountFieldProjection(patch, {}); },
    probeDeps: () => ({ museaiFetch: fixtureFetch() }), env: {}
  });
  const saved = await api.saveCredential('museai', { museaiCookie: 'Cookie: hatch_sess=fixture' });
  assert.equal(saved.verdict, 'valid');
  assert.equal(patches[0].museaiCookie, 'hatch_sess=fixture');
  assert.equal(patches[0].limitProviders, 'muse,museai');
  assert.equal(saved.settings.museaiCookie, 'set');
  assert.equal(JSON.stringify(saved).includes('hatch_sess'), false);
  const form = limitAccountFormsForRenderer().find((entry) => entry.id === 'museai');
  assert.ok(form);
  assert.equal(JSON.stringify(form).includes('storePath'), false);
  const change = classifySettingsChange({}, { museaiCookie: 'hatch_sess=fixture' });
  assert.equal(change.usageStructural, false);
  assert.deepEqual(change.limitScopes, [{ provider: 'museai' }]);
});

test('rejected Muse sessions do not persist and malformed headers never reach the network', async () => {
  let requests = 0;
  const api = createCredentialCommands({
    getSettings: () => ({}), applySettingsPatch: () => assert.fail('must not persist'),
    probeDeps: () => ({ museaiFetch: async () => { requests++; return new Response('', { status: 401 }); } }), env: {}
  });
  assert.equal((await api.saveCredential('museai', { museaiCookie: 'not-a-cookie' })).saved, false);
  assert.equal(requests, 0);
  assert.equal((await api.saveCredential('museai', { museaiCookie: 'hatch_sess=fixture' })).saved, false);
  assert.equal(requests, 1);
});

test('renderer selection keeps anonymous Muse devices apart and stamps local rows without mutation', () => {
  const a = { provider: 'museai', status: 'ok', sourceDeviceId: 'a' };
  const b = { ...a, sourceDeviceId: 'b' };
  assert.equal(dedupeAccounts([a, b]).length, 2);
  assert.equal(sameAccount(a, b), false);
  const local = { provider: 'museai', status: 'ok' };
  const rows = localDeviceLimitsProviders({ devices: [{ deviceId: 'a', limits: { providers: [local] } }] }, 'a');
  assert.equal(local.sourceDeviceId, undefined);
  assert.equal(rows[0].sourceDeviceId, 'a');
  assert.equal(dedupeAccounts([...rows, a, b]).length, 2);
});
