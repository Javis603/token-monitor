'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createCredentialCommands } = require('../../src/electron/limits/credentialCommands');
const { accountFieldProjection, limitAccountFormsForRenderer } = require('../../src/electron/limits/accountSettings');
const { classifySettingsChange } = require('../../src/electron/runtimeConfig');
const { dedupeAccounts, sameAccount, localDeviceLimitsProviders } = require('../../src/electron/renderer/accountIdentity');
const { fixtureFetch } = require('../fixtures/museWeb');

test('Muse uses the generic exact-draft save, main-only credential and account form', async () => {
  const patches = [];
  const api = createCredentialCommands({
    getSettings: () => ({ limitProviders: 'muse' }),
    applySettingsPatch: (patch) => { patches.push(patch); return accountFieldProjection(patch, {}); },
    probeDeps: () => ({ probe: true, museWebFetch: fixtureFetch() }), env: {}
  });
  const saved = await api.saveCredential('muse', { museWebCookie: 'Cookie: hatch_sess=fixture' });
  assert.equal(saved.verdict, 'valid');
  assert.equal(patches[0].museWebCookie, 'hatch_sess=fixture');
  assert.equal(patches[0].limitProviders, 'muse');
  assert.equal(saved.settings.museWebCookie, 'set');
  assert.equal(JSON.stringify(saved).includes('hatch_sess'), false);
  const form = limitAccountFormsForRenderer().find((entry) => entry.id === 'muse');
  assert.ok(form);
  assert.equal(JSON.stringify(form).includes('storePath'), false);
  const change = classifySettingsChange({}, { museWebCookie: 'hatch_sess=fixture' });
  assert.equal(change.usageStructural, false);
  assert.deepEqual(change.limitScopes, [{ provider: 'muse' }]);
});

test('rejected Muse sessions do not persist and malformed headers never reach the network', async () => {
  let requests = 0;
  const api = createCredentialCommands({
    getSettings: () => ({}), applySettingsPatch: () => assert.fail('must not persist'),
    probeDeps: () => ({ probe: true, museWebFetch: async () => { requests++; return new Response('', { status: 401 }); } }), env: {}
  });
  assert.equal((await api.saveCredential('muse', { museWebCookie: 'not-a-cookie' })).saved, false);
  assert.equal(requests, 0);
  assert.equal((await api.saveCredential('muse', { museWebCookie: 'hatch_sess=fixture' })).saved, false);
  assert.equal(requests, 1);
});

test('renderer selection keeps anonymous Muse devices apart and stamps local rows without mutation', () => {
  const a = { provider: 'muse', status: 'ok', sourceDeviceId: 'a' };
  const b = { ...a, sourceDeviceId: 'b' };
  assert.equal(dedupeAccounts([a, b]).length, 2);
  assert.equal(sameAccount(a, b), false);
  const local = { provider: 'muse', status: 'ok' };
  const rows = localDeviceLimitsProviders({ devices: [{ deviceId: 'a', limits: { providers: [local] } }] }, 'a');
  assert.equal(local.sourceDeviceId, undefined);
  assert.equal(rows[0].sourceDeviceId, 'a');
  assert.equal(dedupeAccounts([...rows, a, b]).length, 2);
});

test('Muse keeps CLI and web quotas in one provider throughout runtime, sync and rendering', async (t) => {
  const { fetchMuseLimits } = require('../../src/shared/providers/muse/limits');
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  const { aggregateLimits } = require('../../src/shared/limits/core');
  const cliUsage = JSON.stringify({ schemaVersion: 1, allowance: { tier: 'Muse Code High Usage', weekly: { usedPercent: 80 } } });
  let options = { limitProviders: ['muse'], museWebCookie: 'hatch_sess=fixture' };
  const deps = {
    autoStart: false, autoRetry: false, env: { PATH: '/bin' }, platform: 'linux',
    existsSync: (file) => file === '/bin/muse',
    execFile: (_command, _args, _opts, callback) => { queueMicrotask(() => callback(null, cliUsage, '')); return { stdin: { end() {} } }; },
    museWebFetch: fixtureFetch()
  };
  const runtime = createLimitsRuntime(options, {
    ...deps, probeProvider: async () => fetchMuseLimits(options, deps)
  });
  t.after(() => runtime.stop());
  await runtime.refresh({ provider: 'muse' }, 'credential-save');
  const rows = runtime.getSnapshot().providers;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.provider), ['muse', 'muse']);
  assert.deepEqual(rows.map((row) => [row.source, row.windows[0].usedPercent]).sort(), [['cli', 80], ['web', 28]]);
  const devices = ['a', 'b'].map((deviceId) => ({ deviceId, limits: { providers: rows } }));
  const synced = aggregateLimits(devices).providers;
  assert.equal(synced.length, 4);
  assert.equal(dedupeAccounts(synced).length, 4);
  const local = localDeviceLimitsProviders({ devices }, 'a');
  assert.equal(dedupeAccounts([...local, ...synced]).length, 4);
  assert.equal(sameAccount(local[0], local[1]), false);
  deps.museWebFetch = async () => new Response('', { status: 500 });
  await runtime.refresh({ provider: 'muse' }, 'credential-save');
  assert.deepEqual(runtime.getSnapshot().providers.map((row) => [row.source, row.status]).sort(), [['cli', 'ok'], ['web', 'unavailable']]);
  assert.equal(runtime.getSnapshot().providers.find((row) => row.source === 'web').windows[0].usedPercent, 28);
  deps.museWebFetch = fixtureFetch();
  deps.existsSync = () => false;
  await runtime.refresh({ provider: 'muse' }, 'credential-save');
  assert.deepEqual(runtime.getSnapshot().providers.map((row) => row.source), ['web']);
  deps.existsSync = (file) => file === '/bin/muse';
  options = { limitProviders: ['muse'] };
  await runtime.refresh({ provider: 'muse' }, 'credential-save');
  assert.deepEqual(runtime.getSnapshot().providers.map((row) => row.source), ['cli']);
});

test('Muse web-only installs omit an absent CLI lane and a valid CLI cannot validate a rejected web cookie', async () => {
  const { fetchMuseLimits } = require('../../src/shared/providers/muse/limits');
  const { collectLimitsOnce } = require('../../src/shared/limits/collector');
  const options = { limitProviders: 'muse', museWebCookie: 'hatch_sess=fixture' };
  const deps = { env: {}, existsSync: () => false, museWebFetch: fixtureFetch() };
  const snapshot = await collectLimitsOnce(options, deps);
  assert.deepEqual(snapshot.providers.map((row) => [row.provider, row.source, row.status]), [['muse', 'web', 'ok']]);
  const rejected = await fetchMuseLimits(options, {
    ...deps, probe: true, existsSync: () => true,
    execFile: () => assert.fail('credential probes must not run the CLI'),
    museWebFetch: async () => new Response('', { status: 401 })
  });
  assert.equal(rejected.status, 'unauthorized');
});

test('Muse web credential status and pending settlement never use the CLI row', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../src/electron/renderer/app.js'), 'utf8');
  const functions = source.slice(source.indexOf('function externalProviderForAccount('), source.indexOf('function setAccountPanelMessage('));
  const form = limitAccountFormsForRenderer().find((entry) => entry.id === 'muse');
  const now = Date.parse('2026-11-01T00:00:00Z');
  const rows = [
    { provider: 'muse', source: 'cli', status: 'ok', updatedAt: new Date(now + 1000).toISOString() },
    { provider: 'muse', source: 'web', status: 'unauthorized', updatedAt: new Date(now - 1000).toISOString() }
  ];
  const state = { settings: { museWebCookieConfigured: true }, museWebPendingCheckSince: 0 };
  let cancelled = 0;
  const context = {
    state, externalLimitAccountConfig: {}, limitAccountForm: () => form,
    localProviderStatus: () => rows[0], localProviderStatuses: () => rows,
    cancelExternalProviderCheckSettle: () => { cancelled++; }, externalProviderCheckSettled: new Set()
  };
  vm.createContext(context);
  vm.runInContext(functions, context);
  assert.equal(vm.runInContext("externalProviderAccountLinked('muse')", context), false);
  rows[0].status = 'unauthorized';
  rows[1].status = 'ok';
  assert.equal(vm.runInContext("externalProviderAccountLinked('muse')", context), true);
  state.museWebPendingCheckSince = now;
  assert.equal(vm.runInContext("externalProviderForAccount('muse')", context), null);
  assert.equal(state.museWebPendingCheckSince, now, 'a fresh CLI reading cannot settle the web check');
  rows[1].updatedAt = new Date(now + 1000).toISOString();
  assert.equal(vm.runInContext("externalProviderForAccount('muse')", context), rows[1]);
  assert.equal(state.museWebPendingCheckSince, 0);
  assert.equal(cancelled, 1);
});

test('Muse generic web account statuses are translated in every locale', () => {
  const { MESSAGES, translate } = require('../../src/electron/renderer/i18n');
  for (const locale of Object.keys(MESSAGES)) {
    for (const suffix of ['statusSet', 'statusEnv', 'statusInvalid']) {
      const key = `settings.muse.${suffix}`;
      assert.ok(Object.hasOwn(MESSAGES[locale], key), `${locale}: ${key}`);
      assert.notEqual(translate(locale, key), key);
    }
  }
});

test('Muse Cookie save and clear retire only local Web rows when the following stats refresh fails', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../src/electron/renderer/app.js'), 'utf8');
  const bodies = [
    ['async function saveAccountCredential(', '\n// The busy guard'],
    ['async function clearAccountCredential(', '\nasync function commitAccountCredential('],
    ['function markExternalProviderCheckPending(', '\nfunction clearExternalProviderCheckPending('],
    ['function clearExternalProviderCheckPending(', '\nfunction clearExternalProviderPendingStatus('],
    ['function clearExternalProviderPendingStatus(', '\nfunction nextCopilotSignInFlowId(']
  ].map(([start, end]) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))).join('\n');
  for (const action of ['save', 'clear']) {
    const cli = { provider: 'muse', source: 'cli', sourceDeviceId: 'local', status: 'ok', windows: [{ kind: 'weekly', usedPercent: 35 }] };
    const remoteCli = { ...cli, sourceDeviceId: 'remote' };
    const web = { provider: 'muse', source: 'web', sourceDeviceId: 'local', status: 'ok' };
    const remoteWeb = { ...web, sourceDeviceId: 'remote' };
    const unknownWeb = { ...web, sourceDeviceId: '' };
    const other = { provider: 'manus', status: 'ok' };
    const localDevice = { deviceId: 'local', limits: { providers: [cli, web] } };
    const remoteDevice = { deviceId: 'remote', limits: { providers: [remoteCli, remoteWeb] } };
    const state = { settings: { deviceId: 'local' }, stats: {
      devices: [localDevice, remoteDevice], limits: { providers: [cli, web, remoteCli, remoteWeb, unknownWeb, other] }
    } };
    const context = {
      state, LIMIT_PROVIDERS: [{ id: 'muse', label: 'Muse' }], externalLimitAccountConfig: {},
      limitAccountForm: () => ({ status: { pendingKey: 'museWebPendingCheckSince' } }),
      externalProviderCheckSettled: new Set(), cancelExternalProviderCheckSettle() {}, scheduleExternalProviderCheckSettle() {},
      setAccountPanelMessage() {}, renderExternalProviderStatus() {},
      commitAccountCredential: (request) => request(),
      refreshStats: async () => { throw new Error('stats unavailable'); },
      window: { tokenMonitor: { limits: {
        saveCredential: async () => ({ saved: true, verdict: 'valid', checkedSince: 123 }),
        clearCredential: async () => ({})
      } } }
    };
    vm.createContext(context);
    vm.runInContext(bodies, context);
    await assert.rejects(action === 'save'
      ? context.saveAccountCredential('muse', {})
      : context.clearAccountCredential('muse'), /stats unavailable/);
    assert.deepEqual(state.stats.limits.providers, [cli, remoteCli, remoteWeb, unknownWeb, other], action);
    assert.deepEqual(localDevice.limits.providers, [cli], 'subscription choices cannot reuse the retired local Web reading');
    assert.deepEqual(remoteDevice.limits.providers, [remoteCli, remoteWeb], 'remote device quotas stay intact');
    assert.equal(state.stats.limits.providers[0], cli, 'the existing CLI quota observation survives');
    context.clearExternalProviderPendingStatus('manus');
    assert.deepEqual(state.stats.limits.providers, [cli, remoteCli, remoteWeb, unknownWeb], 'other providers retain their existing cleanup');
    delete state.stats.devices;
    const legacyWeb = { provider: 'muse', source: 'web', status: 'ok' };
    state.stats.limits.providers = [cli, legacyWeb, remoteWeb];
    context.clearExternalProviderPendingStatus('muse');
    assert.deepEqual(state.stats.limits.providers, [cli, remoteWeb], 'legacy local snapshots without device rows still retire Web');
  }
});
