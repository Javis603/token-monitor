'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMinimaxApiKeys } = require('../../src/electron/providers/minimax/apiKeys');
const { hashKey } = require('../../src/shared/hashKey');

function fixture(initial = {}, response = () => ({ ok: true, status: 200,
  json: async () => ({ available_amount: 8, base_resp: { status_code: 0 } }) }), env = { MINIMAX_CODING_API_KEY: 'env-secret' }) {
  let settings = structuredClone(initial);
  const changes = [];
  const requests = [];
  const api = createMinimaxApiKeys({
    getSettings: () => settings,
    saveSettings: () => {},
    env,
    changed: (key, refresh) => changes.push({ key, refresh }),
    probeDeps: () => ({ fetch: async (url, init) => { requests.push({ url, init }); return response(url, init); } })
  });
  return { api, changes, requests, settings: () => settings, patch: patch => {
    api.noteSettingsPatch(patch); settings = { ...settings, ...patch };
  } };
}

test('MiniMax key additions preserve legacy credentials and deduplicate without user account names', async () => {
  const f = fixture({ minimaxApiKey: 'legacy-secret', minimaxBillingMode: 'api', minimaxApiRegion: 'cn',
    limitsEnabled: false, limitProviders: '' });
  assert.equal(f.api.getKeys().length, 1);
  assert.equal(f.settings().minimaxApiKey, 'legacy-secret');
  assert.equal((await f.api.addKey({ apiKey: 'work-secret', billingMode: 'api' })).ok, true);
  assert.equal(f.requests.length, 1, 'save probes neither Code nor optional Spend');
  assert.equal(f.requests[0].url, 'https://api.minimax.io/account/query_balance');
  assert.equal(f.settings().minimaxApiKey, 'legacy-secret', 'legacy key stays for downgrades');
  assert.equal(f.settings().minimaxApiProfiles.default.apiKey, 'legacy-secret');
  assert.equal(f.api.getKeys().find(key => key.accountKey === hashKey('minimax', 'work-secret')).apiRegion, 'auto');
  assert.equal(f.settings().limitsEnabled, true);
  assert.equal(f.settings().limitProviders, 'minimax');
  assert.equal(f.changes.some(change => change.key === hashKey('minimax', 'env-secret')), false);
  assert.equal(JSON.stringify(f.api.getKeys()).includes('-secret'), false);
  await f.api.addKey({ apiKey: 'work-secret', billingMode: 'api' });
  assert.equal(f.api.getKeys().length, 2, 'duplicate key is not a second credential');
  f.patch({ limitsEnabled: false, limitProviders: '' });
  const id = f.api.getKeys().find(key => key.accountKey === hashKey('minimax', 'work-secret')).id;
  assert.equal(f.api.removeKey(id).ok, true);
  assert.equal(f.settings().limitsEnabled, false);
  assert.equal(f.settings().limitProviders, '');
  await f.api.addKey({ apiKey: 'env-secret', billingMode: 'api' });
  assert.equal(f.api.getKeys().filter(key => key.accountKey === hashKey('minimax', 'env-secret')).length, 1);
  f.api.removeKey(f.api.getKeys().find(key => key.accountKey === hashKey('minimax', 'env-secret')).id);
  assert.equal(f.api.getKeys().some(key => key.id === 'environment'), false);
  assert.deepEqual(f.changes.at(-1), { key: hashKey('minimax', 'env-secret'), refresh: false });
  f.api.removeKey('default');
  assert.equal(f.settings().minimaxApiKey, '');
  assert.deepEqual(f.changes.at(-1), { key: hashKey('minimax', 'env-secret'), refresh: true });
});

test('MiniMax rejected probes and real removals cannot save stale credentials', async () => {
  for (const [id, removed, saved] of [['work', true, false], ['missing-id', false, true]]) {
    const started = Promise.withResolvers();
    const response = Promise.withResolvers();
    const f = fixture({ minimaxApiProfiles: { work: { apiKey: 'saved-secret', billingMode: 'api' } } },
      () => { started.resolve(); return response.promise; });
    const saving = f.api.addKey({ apiKey: 'new-secret', billingMode: 'api' });
    await started.promise;
    assert.equal(f.api.removeKey(id).ok, removed, id);
    response.resolve({ ok: true, json: async () => ({ available_amount: 8 }) });
    assert.equal((await saving).ok, saved, id);
    assert.deepEqual(Object.values(f.settings().minimaxApiProfiles).map(profile => profile.apiKey).sort(),
      saved ? ['new-secret', 'saved-secret'] : [], id);
  }
  const rejected = fixture({ minimaxApiKey: 'saved-secret' }, () => ({ ok: false, status: 401, json: async () => ({}) }));
  assert.equal((await rejected.api.addKey({ apiKey: 'bad' })).ok, false);
  assert.equal(rejected.settings().minimaxApiKey, 'saved-secret');
});

test('MiniMax key saves reject empty input, default to Auto and use the shared indeterminate verdict', async () => {
  const f = fixture({ minimaxApiProfiles: { work: { apiKey: 'saved-secret', billingMode: 'api', apiRegion: '' } } },
    () => ({ ok: false, status: 503, json: async () => ({}) }), { MINIMAX_API_REGION: 'cn' });
  const before = structuredClone(f.settings());
  assert.equal((await f.api.addKey({ apiKey: '', billingMode: 'api' })).ok, false);
  assert.deepEqual(f.settings(), before);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.api.addKey({ apiKey: 'saved-secret', billingMode: 'api' })).ok, true);
  assert.equal(f.settings().minimaxApiProfiles.work.apiKey, 'saved-secret');
  assert.equal(f.settings().minimaxApiProfiles.work.apiRegion, 'auto');
  assert.equal(f.api.getKeys()[0].apiRegion, 'auto');
  assert.equal((await f.api.addKey({ apiKey: 'saved-secret', billingMode: 'api',
    apiRegion: 'not-a-region' })).ok, true);
  assert.equal(f.settings().minimaxApiProfiles.work.apiRegion, 'auto',
    'the stored region must use the same canonical value as the shared probe');
});

test('MiniMax key saves persist private keys and notify the runtime with the committed configuration', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { CredentialStore, persistSettingsAndCredentials } = require('../../src/shared/credentialStore');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'minimax-profiles-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new CredentialStore(directory);
  const settings = { minimaxApiKey: 'legacy-secret', minimaxBillingMode: 'api', limitsEnabled: false, limitProviders: '' };
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  const { fetchMinimaxLimits } = require('../../src/shared/providers/minimax/limits');
  const { runLimitInvalidation } = require('../../src/electron/deviceRuntimeCoordinator');
  const fetch = async () => ({ ok: true, json: async () => ({ available_amount: 5 }) });
  const runtime = createLimitsRuntime(settings, { autoStart: false, autoRetry: false,
    probeProvider: (_id, options) => fetchMinimaxLimits(options, { env: {}, homeDir: directory, fetch }) });
  t.after(() => runtime.stop());
  const refreshes = [];
  const profiles = createMinimaxApiKeys({
    getSettings: () => settings, env: {},
    saveSettings: () => persistSettingsAndCredentials({ store, settingsPath: path.join(directory, 'settings.json'),
      settings, previousSettings: {} }),
    probeDeps: () => ({ fetch }),
    changed: (accountKey, refresh, reason) => {
      runtime.reconfigure(settings);
      refreshes.push(runLimitInvalidation({ clearLimits: runtime.clear, refreshLimits: runtime.refresh },
        { provider: 'minimax', source: 'api', accountKey }, reason, { clear: true, refresh }));
    }
  });
  assert.equal((await profiles.addKey({ apiKey: 'work-secret', billingMode: 'api' })).ok, true);
  await Promise.all(refreshes);
  assert.equal(runtime.getSnapshot().providers.find(row => row.accountKey === hashKey('minimax', 'work-secret'))?.status, 'ok');
  assert.equal(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8').includes('-secret'), false);
  const saved = store.readDocument().credentials.providers.minimax;
  assert.equal(saved.profiles.default.apiKey, 'legacy-secret');
  assert.equal(saved.profiles[profiles.getKeys().find(key => key.accountKey === hashKey('minimax', 'work-secret')).id].apiKey, 'work-secret');
  assert.equal(saved.apiKey, 'legacy-secret');
});

test('MiniMax billing links use only the selected key region and default Auto to International', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../../src/electron/renderer/app.js'), 'utf8');
  const match = source.match(/function minimaxBillingUrl\(key\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'exercise the renderer implementation rather than a duplicated link policy');
  const rows = [
    { source: 'api', accountKey: 'cn-key', region: 'cn' },
    { source: 'api', accountKey: 'en-key', region: 'en' }
  ];
  const billingUrl = Function('localProviderStatuses', 'state', `return (${match[0]})`)(
    () => rows, { settings: { minimaxApiRegion: 'auto' } });
  assert.equal(billingUrl({ billingMode: 'api', apiRegion: 'auto' }),
    'https://platform.minimax.io/user-center/payment/balance');
  assert.equal(billingUrl({ accountKey: 'en-key', billingMode: 'api', apiRegion: 'auto' }),
    'https://platform.minimax.io/user-center/payment/balance');
  assert.equal(billingUrl({ accountKey: 'cn-key', billingMode: 'api', apiRegion: 'auto' }),
    'https://platform.minimaxi.com/user-center/payment/balance');
  assert.equal(billingUrl({ accountKey: 'missing', billingMode: 'token-plan', apiRegion: 'cn' }),
    'https://platform.minimaxi.com/user-center/payment/token-plan');
});
