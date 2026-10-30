'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessDataService } = require('../../src/electron/plugins/businessData');

test('formal limits data uses canonical tool names while retaining provider/account identity', async t => {
  const service = createBusinessDataService(); t.after(() => service.dispose());
  const providers = ['codex', 'claude', 'opencode', 'copilot', 'unlisted-provider'].map(provider => ({
    provider, providerLabel: 'WRONG_NAME', accountKey: 'PRIVATE_ACCOUNT_KEY', token: 'NEVER_EXPOSE',
    status: 'ok', updatedAt: new Date().toISOString(), windows: []
  }));
  service.publish({ updatedAt: new Date().toISOString(), limits: { providers } });
  const auth = () => ({ pluginId: 'labels-fixture', active: true, revision: 1 });
  const result = await service.query({ version: 1, resource: 'limits' }, auth);
  assert.equal(result.availability, 'available');
  const names = Object.fromEntries(result.rows.map(row => [row.provider, row.providerLabel]));
  assert.deepEqual(names, { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', copilot: 'GitHub Copilot', 'unlisted-provider': 'unlisted-provider' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ACCOUNT_KEY|NEVER_EXPOSE|WRONG_NAME/);
  const firstIds = Object.fromEntries(result.rows.map(row => [row.provider, row.accountId]));
  service.publish({ updatedAt: new Date().toISOString(), limits: { providers: providers.map(provider => ({ ...provider, providerLabel: 'RENAMED_SOURCE_TEXT' })) } });
  const after = await service.query({ version: 1, resource: 'limits' }, auth);
  assert.deepEqual(Object.fromEntries(after.rows.map(row => [row.provider, row.accountId])), firstIds);
});

test('formal window display labels match the App without changing nullable raw labels', async t => {
  const service = createBusinessDataService(); t.after(() => service.dispose());
  const windows = [{ kind: 'session' }, { kind: 'weekly' }, { kind: 'billing' }, { kind: 'weekly', label: 'Named pool', displayLabel: 'WRONG' }];
  service.publish({ updatedAt: new Date().toISOString(), limits: { providers: [
    { provider: 'codex', accountKey: 'A', status: 'ok', windows },
    { provider: 'antigravity', accountKey: 'B', status: 'ok', windows: [{ kind: 'session' }] }
  ] } });
  const result = await service.query({ version: 1, resource: 'limits' }, () => ({ pluginId: 'labels-fixture', active: true, revision: 1 }));
  const codex = result.rows.find(row => row.provider === 'codex');
  assert.deepEqual(codex.windows.map(window => window.displayLabel), ['Session', 'Weekly', 'Monthly', 'Named pool']);
  assert.deepEqual(codex.windows.map(window => window.label), [null, null, null, 'Named pool']);
  assert.equal(result.rows.find(row => row.provider === 'antigravity').windows[0].displayLabel, '5-hour');
  assert.equal(Object.hasOwn(windows[0], 'label'), false);
});
