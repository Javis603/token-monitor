'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCredentialCommands,
  credentialVerdict,
  providerSelectionIncluding
} = require('../../src/electron/limits/credentialCommands');
const { LIMIT_PROVIDER_REGISTRY } = require('../../src/shared/limits/registry');

const BALANCE = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '4.61', topped_up_balance: '4.61' }] };

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => '' }, json: async () => body };
}

// The real DeepSeek fetcher behind a fake transport, so each verdict is taken
// from the provider's own classification of an HTTP answer.
function commands({ answer = () => response(200, BALANCE), settings = {} } = {}) {
  const patches = [];
  const writes = [];
  let current = { ...settings };
  const api = createCredentialCommands({
    getSettings: () => current,
    applySettingsPatch: (patch) => {
      patches.push(patch);
      current = { ...current, ...patch };
      return { projected: true };
    },
    probeDeps: () => ({
      probe: true,
      providerRuntimeState: new Map(),
      fetch: async (url, init) => answer(url, init),
      readJson: () => ({}),
      writeJsonAtomic: (file) => writes.push(file)
    }),
    env: {}
  });
  return { api, patches, writes };
}

test('the verdict only rejects what the provider itself calls a bad credential', () => {
  assert.equal(credentialVerdict('ok'), 'valid');
  assert.equal(credentialVerdict('unauthorized'), 'invalid');
  assert.equal(credentialVerdict('notConfigured'), 'invalid');
  for (const status of ['rateLimited', 'sourceRateLimited', 'unavailable', 'error', undefined]) {
    assert.equal(credentialVerdict(status), 'indeterminate', String(status));
  }
});

test('a confirmed credential is stored and selects its provider in the same write', async () => {
  const { api, patches, writes } = commands({ settings: { limitProviders: 'claude,codex' } });
  const result = await api.saveCredential('deepseek', { deepseekApiKey: '  sk-live  ' });
  assert.deepEqual(result, { saved: true, verdict: 'valid', status: 'ok', errorCode: '', settings: { projected: true } });
  assert.deepEqual(patches, [{ deepseekApiKey: 'sk-live', limitProviders: 'claude,codex,deepseek', limitsEnabled: true }]);
  assert.deepEqual(writes, [], 'a probe must not add to the DeepSeek balance history');
});

test('a credential the provider rejects is never stored', async () => {
  for (const status of [401]) {
    const { api, patches } = commands({ answer: () => response(status) });
    const result = await api.saveCredential('deepseek', { deepseekApiKey: 'sk-bad' });
    assert.equal(result.saved, false, String(status));
    assert.equal(result.verdict, 'invalid', String(status));
    assert.equal(result.status, 'unauthorized', String(status));
    assert.deepEqual(patches, [], String(status));
  }
});

test('a probe that says nothing about the credential still stores it', async () => {
  for (const [answer, status] of [
    [() => response(429), 'sourceRateLimited'],
    [() => response(500), 'unavailable'],
    [() => response(404), 'unavailable'],
    // Which answers mean a bad credential is the fetcher's call: DeepSeek's
    // maps only 401 to unauthorized (MiniMax's also maps 403), so here a 403
    // is saved and left for the pill to report.
    [() => response(403), 'unavailable'],
    [() => { throw new Error('socket hang up'); }, 'unavailable'],
    [() => response(200, { unexpected: true }), 'unavailable']
  ]) {
    const { api, patches } = commands({ answer });
    const result = await api.saveCredential('deepseek', { deepseekApiKey: 'sk-maybe' });
    assert.equal(result.saved, true, status);
    assert.equal(result.verdict, 'indeterminate', status);
    assert.equal(result.status, status);
    assert.equal(patches.length, 1, status);
    assert.equal(patches[0].deepseekApiKey, 'sk-maybe', status);
    assert.equal(patches[0].limitsEnabled, true, status);
  }
});

test('an empty draft or an unknown provider never reaches a probe', async () => {
  let probes = 0;
  const { api, patches } = commands({ answer: () => { probes += 1; return response(200, BALANCE); } });
  assert.deepEqual(await api.saveCredential('deepseek', { deepseekApiKey: '   ' }), {
    saved: false, verdict: 'invalid', status: 'invalidFormat', errorCode: ''
  });
  // Codex has no account form: its account flow is not a pasted credential.
  for (const id of ['codex', 'not-a-provider', '__proto__', undefined]) {
    assert.equal((await api.saveCredential(id, { deepseekApiKey: 'sk-live' })).saved, false, String(id));
  }
  assert.equal(probes, 0);
  assert.deepEqual(patches, []);
});

test('a probe overtaken by a later write for the same provider does not land', async () => {
  let release;
  const { api, patches } = commands({
    answer: () => new Promise((resolve) => { release = () => resolve(response(200, BALANCE)); })
  });
  const first = api.saveCredential('deepseek', { deepseekApiKey: 'sk-first' });
  await new Promise((resolve) => setImmediate(resolve));
  api.noteSettingsPatch({ deepseekApiKey: '' });
  release();
  assert.deepEqual(await first, { saved: false, verdict: 'superseded', status: 'superseded', errorCode: '' });
  assert.deepEqual(patches, []);

  // A write that does not touch this form leaves the probe current.
  const second = api.saveCredential('deepseek', { deepseekApiKey: 'sk-second' });
  await new Promise((resolve) => setImmediate(resolve));
  api.noteSettingsPatch({ zedCookie: 'other' });
  release();
  assert.equal((await second).saved, true);
});

test('clearing removes the form credential through the same settings write', () => {
  const { api, patches } = commands();
  assert.deepEqual(api.clearCredential('minimax'), { cleared: true, settings: { projected: true } });
  assert.deepEqual(patches, [{ minimaxApiKey: '' }]);
  assert.deepEqual(api.clearCredential('codex'), { cleared: false });
});

test('saving selects the provider without reordering or widening the selection', () => {
  const ids = LIMIT_PROVIDER_REGISTRY.map(({ id }) => id);
  assert.equal(providerSelectionIncluding(undefined, 'zed'), ids.join(','), 'unset keeps the historical every-provider default');
  assert.equal(providerSelectionIncluding('', 'zed'), 'zed', 'an explicitly empty selection gains only the saved provider');
  assert.equal(providerSelectionIncluding('deepseek,claude', 'deepseek'), 'claude,deepseek');
});
