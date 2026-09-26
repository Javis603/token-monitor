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
  for (const values of [{ deepseekApiKey: '   ' }, {}]) {
    assert.deepEqual(await api.saveCredential('deepseek', values), {
      saved: false, verdict: 'invalid', status: 'required', errorCode: ''
    });
  }
  assert.equal((await api.saveCredential('deepseek', null)).saved, false);
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

test('a stale probe that was rejected still reports superseded, not invalid', async () => {
  let release;
  const { api, patches } = commands({
    answer: () => new Promise((resolve) => { release = () => resolve(response(401)); })
  });
  const first = api.saveCredential('deepseek', { deepseekApiKey: 'sk-bad' });
  await new Promise((resolve) => setImmediate(resolve));
  api.noteSettingsPatch({ deepseekApiKey: '' });
  release();
  // A later write already settled this form's fate; the old probe's rejection
  // must not land over it and must not keep a stale rejection message alive.
  assert.deepEqual(await first, { saved: false, verdict: 'superseded', status: 'superseded', errorCode: '' });
  assert.deepEqual(patches, []);
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

// The real Claude fetcher: a session key the probe rotated is what gets stored,
// so the next poll does not present the one Claude just retired.
test('a session key renewed during the probe is the one stored', async () => {
  const patches = [];
  const api = createCredentialCommands({
    getSettings: () => ({}),
    applySettingsPatch: (patch) => { patches.push(patch); return {}; },
    probeDeps: (renewed) => ({
      probe: true,
      providerRuntimeState: new Map(),
      bypassValidationCache: true,
      onClaudeWebCookieRenewed: ({ cookie }) => { renewed.claudeWebCookie = cookie; return true; },
      stat: async () => { throw new Error('OAuth credentials must not be read when Web is configured'); },
      fetch: async (url) => {
        if (url.endsWith('/api/organizations')) {
          return {
            ok: true,
            headers: { getSetCookie: () => ['sessionKey=sk-ant-sid01-rotated; Path=/; Secure; HttpOnly'] },
            json: async () => [{ uuid: 'organization-web', name: 'Workspace' }]
          };
        }
        if (url.endsWith('/prepaid/credits')) return { ok: true, json: async () => ({ amount: 0, currency: 'USD' }) };
        if (url.endsWith('/api/account')) return { ok: true, json: async () => ({ uuid: 'account-web', email_address: 'owner@example.com' }) };
        return { ok: true, json: async () => ({ five_hour: { utilization: 10 } }) };
      }
    }),
    env: {}
  });
  assert.deepEqual(await api.saveCredential('claude', { claudeWebCookie: 'sessionKey=abc' }), {
    saved: false, verdict: 'invalid', status: 'invalidFormat', errorCode: 'INVALID_CLAUDE_WEB_SESSION_KEY'
  });
  const result = await api.saveCredential('claude', { claudeWebCookie: 'sk-ant-sid01-first' });
  assert.equal(result.verdict, 'valid');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].claudeWebCookie, 'sessionKey=sk-ant-sid01-rotated');
});

test('a lane saved on its own is probed without the stored sibling vouching for it', async () => {
  const seen = [];
  const { api, patches } = commands({
    settings: { kimiWebAccessToken: 'stored-web-token' },
    answer: (url, init) => {
      seen.push(init?.headers || {});
      return response(401);
    }
  });
  const result = await api.saveCredential('kimi', { kimiApiKey: 'sk-kimi-bad' });
  assert.equal(result.verdict, 'invalid');
  assert.ok(seen.length > 0);
  assert.ok(seen.every((headers) => !JSON.stringify(headers).includes('stored-web-token')), 'the stored web token must not be sent');
  assert.deepEqual(patches, []);
});

// The stored sibling is not the only credential that can vouch: each lane also
// falls back to a process variable, so the probe runs with an empty env.
test('a credential lane outside the draft cannot vouch through the process env either', async () => {
  const KIMI_CODE_URL = 'https://api.kimi.com/coding/v1/usages';
  const webUsage = {
    usages: [{ scope: 'FEATURE_CODING', detail: { used: 20, limit: 100 } }]
  };
  const codeUsage = {
    limits: [{ detail: { used: 10, limit: 100, remaining: 90 }, window: { duration: 5, timeUnit: 'HOUR' } }]
  };
  const kimiCommands = ({ env, answer }) => {
    const requested = [];
    const patches = [];
    const api = createCredentialCommands({
      getSettings: () => ({}),
      applySettingsPatch: (patch) => { patches.push(patch); return {}; },
      probeDeps: () => ({
        probe: true,
        providerRuntimeState: new Map(),
        env,
        fetch: async (url, init) => {
          requested.push({ url: String(url), headers: init?.headers || {} });
          const [status, body] = answer(String(url));
          return response(status, body);
        }
      }),
      env
    });
    return { api, patches, requested };
  };

  // A valid web token in the env must not rescue a rejected Code key.
  {
    const { api, patches, requested } = kimiCommands({
      env: { KIMI_AUTH_TOKEN: 'env-web-token' },
      answer: (url) => (url.includes('kimi.com/apiv2') ? [200, webUsage] : [401, {}])
    });
    const result = await api.saveCredential('kimi', { kimiApiKey: 'sk-kimi-bad' });
    assert.equal(result.verdict, 'invalid');
    assert.equal(result.status, 'unauthorized');
    assert.deepEqual(patches, []);
    assert.equal(requested.every(({ url }) => url === KIMI_CODE_URL), true, 'the env web lane must not be probed');
    assert.equal(requested.every(({ headers }) => !JSON.stringify(headers).includes('env-web-token')), true);
  }

  // And a valid Code key in the env must not rescue a rejected web token.
  {
    const { api, patches, requested } = kimiCommands({
      env: { KIMI_CODE_API_KEY: 'env-code-key' },
      answer: (url) => (url.includes('kimi.com/apiv2') ? [401, {}] : [200, codeUsage])
    });
    const result = await api.saveCredential('kimi', { kimiWebAccessToken: 'bad-web-token' });
    assert.equal(result.verdict, 'invalid');
    assert.equal(result.status, 'unauthorized');
    assert.deepEqual(patches, []);
    assert.equal(requested.every(({ url }) => url !== KIMI_CODE_URL), true, 'the env code lane must not be probed');
    assert.equal(requested.every(({ headers }) => !JSON.stringify(headers).includes('env-code-key')), true);
  }
});

test('a partial draft stores only the lane that was sent', async () => {
  const { api, patches } = commands({ settings: { kimiWebAccessToken: 'stored-web-token' }, answer: () => response(500) });
  const result = await api.saveCredential('kimi', { kimiApiKey: 'sk-kimi-maybe' });
  assert.equal(result.saved, true);
  assert.equal(patches[0].kimiApiKey, 'sk-kimi-maybe');
  assert.equal(Object.hasOwn(patches[0], 'kimiWebAccessToken'), false);
});

// Ollama rate-limits its settings page, so a confirmed probe stands in for the
// first poll after the save instead of asking a second time.
test('a confirmed Ollama cookie answers the next poll from the probe', async () => {
  const { fetchOllamaLimits } = require('../../src/shared/providers/ollama/limits');
  const html = `<span>Cloud Usage</span><span>Pro</span>
<section aria-label="Session usage 14.5% used"><div style="width: 14.5%"></div></section>`;
  const page = (status) => ({ ok: status === 200, status, headers: { get: () => '' }, text: async () => html });
  const { api, patches } = commands({ answer: () => page(200) });
  assert.equal((await api.saveCredential('ollama', { ollamaCookie: '__Secure-session=abc' })).verdict, 'valid');
  let requests = 0;
  const next = await fetchOllamaLimits({ ollamaCookie: patches[0].ollamaCookie }, {
    env: {},
    fetch: async () => { requests += 1; return page(500); }
  });
  assert.equal(next.status, 'ok');
  assert.equal(requests, 0);

  // An unconfirmed save leaves nothing behind for the poll to reuse.
  const unconfirmed = commands({ answer: () => page(500) });
  assert.equal((await unconfirmed.api.saveCredential('ollama', { ollamaCookie: '__Secure-session=def' })).verdict, 'indeterminate');
  const polled = await fetchOllamaLimits({ ollamaCookie: unconfirmed.patches[0].ollamaCookie }, {
    env: {},
    fetch: async () => { requests += 1; return page(500); }
  });
  assert.equal(polled.status, 'unavailable');
  assert.equal(requests, 1);
});
