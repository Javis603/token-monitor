'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createCopilotAccounts } = require('../../src/electron/providers/copilot/accounts');

test('Copilot IPC preserves an explicit public host and uses defaults only when absent', async () => {
  const source = fs.readFileSync(require.resolve('../../src/electron/main'), 'utf8');
  for (const [request, expected] of [
    [{ values: { copilotEnterpriseHost: '' } }, ''],
    [{ enterpriseHost: '' }, ''],
    [{ values: { copilotEnterpriseHost: 'chosen.ghe.com' } }, 'chosen.ghe.com'],
    [{}, 'saved.ghe.com']
  ]) {
    const handlers = new Map(), hosts = [];
    const context = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, AbortController,
      copilotLoginController: null, copilotLoginFlowId: '', settings: { copilotEnterpriseHost: 'saved.ghe.com' }, process: { env: {} },
      runCopilotDeviceFlowLogin: async options => { hosts.push(options.enterpriseHost); return { accessToken: 'fixture' }; },
      copilotAccounts: { addAccount: async (_token, current, _signal, host) => { assert.ok(current()); hosts.push(host); return { ok: true }; } },
      copilotLoginErrorMessage: () => 'Sign-in failed', shell: { openExternal() {} }, clipboard: { writeText() {} }, fetch() {} };
    vm.runInNewContext(source.slice(source.indexOf("  ipcMain.handle('copilot:signIn'"), source.indexOf("  ipcMain.on('window:minimize'")), context);
    const result = await handlers.get('copilot:signIn')({ sender: { isDestroyed: () => false, send() {} } }, request);
    assert.equal(result.ok, true);
    assert.deepEqual(hosts, [expected, expected]);
  }
});

test('Copilot authorized per-account host may differ from the global default', async () => {
  const hosts = [];
  let draft;
  const api = createCopilotAccounts({ getSettings: () => ({ copilotEnterpriseHost: 'default.ghe.com' }), env: {},
    service: { loginAction: async (_provider, produce) => { draft = await produce(); return { saved: true }; } },
    probeDeps: () => ({ fetch: async url => { hosts.push(new URL(url).hostname); return { ok: true, status: 200,
      json: async () => url.endsWith('/user') ? { login: 'alice', id: 1 } : { copilot_plan: 'pro', quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 75 } } } }; } }) });
  assert.equal((await api.addAccount('fixture', () => true, undefined, 'chosen.ghe.com')).ok, true);
  assert.equal(draft.values.copilotEnterpriseHost, 'chosen.ghe.com');
  assert.ok(hosts.length >= 2);
  assert.ok(hosts.every(host => host === 'api.chosen.ghe.com'));
});
