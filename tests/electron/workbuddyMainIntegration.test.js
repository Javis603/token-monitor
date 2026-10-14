'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const oauth = require('../../src/shared/providers/workbuddy/oauth');
const { createWorkbuddyManagedAccounts } = require('../../src/electron/providers/workbuddy/managedAccounts');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const start = source.indexOf('let workbuddyManagedAccountService = null;');
const end = source.indexOf('function antigravityAccountsForRenderer()', start);

function harness() {
  const account = oauth.normalizeManagedAccounts([{ id: 'managed', realm: 'cn', userId: 'fixture', accountName: 'Fixture' }])[0];
  const settings = { workbuddyManagedAccounts: [{ ...account, accessToken: 'must-not-cross', authUrl: 'must-not-cross' }] };
  const secrets = new Map([['managed', { accessToken: 'private-access', refreshToken: 'private-refresh', domain: account.domain, expiresAt: Date.now() + 3600000 }]]);
  const invalidations = [];
  const pushes = [];
  const context = vm.createContext({ settings, workbuddyOAuth: oauth, createWorkbuddyManagedAccounts,
    saveSettings: () => {}, ensureCredentialStore: () => ({
      readWorkbuddyCredential: (id) => secrets.get(id),
      writeWorkbuddyCredential: (id, value) => { secrets.set(id, value); return true; },
      removeWorkbuddyCredential: (id) => { secrets.delete(id); return true; }
    }), electronLimitsFetch: () => { throw new Error('No fixture transport required'); },
    shell: { openExternal: () => { throw new Error('Must not open an invalid realm'); } },
    pushSettingsToRenderer: () => {}, mainWindow: { isDestroyed: () => false, webContents: { send: (channel, value) => pushes.push({ channel, value }) } },
    queueLimitInvalidation: async (scope, reason, options) => { invalidations.push({ scope, reason, options }); },
    Promise
  });
  // Supply a fetch function, never run any real network request.
  context.electronLimitsFetch = () => async () => { throw new Error('Network is unavailable'); };
  vm.runInContext(source.slice(start, end), context);
  return { context, account, invalidations, pushes, secrets };
}

test('main metadata excludes persisted credential fields and bad realms never open the browser', async () => {
  const h = harness();
  const metadata = vm.runInContext('workbuddyAccountsForRenderer()', h.context);
  assert.equal(JSON.stringify(metadata).includes('must-not-cross'), false);
  const result = await vm.runInContext("workbuddyAccountOperation(service => service.addAccount('untrusted'))", h.context);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'INVALID_REALM');
  assert.equal(h.invalidations.length, 0);
});

test('main removal clears the exact identity then rebuilds the local discovery union', async () => {
  const h = harness();
  const result = await vm.runInContext("workbuddyAccountOperation(service => service.removeAccount('managed'))", h.context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.ok, true);
  assert.equal(h.secrets.has('managed'), false);
  assert.equal(h.invalidations.length, 2);
  assert.equal(h.invalidations[0].scope.accountKey, h.account.accountKey);
  assert.equal(h.invalidations[0].options.clear, true);
  assert.equal(h.invalidations[0].options.refresh, false);
  assert.equal(h.invalidations[1].scope.provider, 'workbuddy');
  assert.equal(h.invalidations[1].scope.accountKey, undefined);
  assert.equal(h.invalidations[1].reason, 'account-state');
  assert.equal(h.invalidations[1].options.refresh, true);
  assert.equal(h.pushes[0].channel, 'workbuddy:accounts');
  assert.equal(h.pushes[0].value.length, 0);
});

test('main enabled account invalidation bypasses credential cooldown without refreshing siblings', async () => {
  const h = harness();
  await vm.runInContext("workbuddyAccountOperation(service => service.setAccountEnabled('managed', true))", h.context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.invalidations.length, 1);
  assert.equal(h.invalidations[0].scope.accountKey, h.account.accountKey);
  assert.equal(h.invalidations[0].reason, 'account-state');
  assert.equal(h.invalidations[0].options.refresh, true);
});
