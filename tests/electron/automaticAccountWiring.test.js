
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const identity = require('../../src/electron/renderer/accountIdentity');
const app = fs.readFileSync(path.resolve(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
function rows(state) {
  const source = app.slice(app.indexOf('function strictLocalProviderStatuses('), app.indexOf('function localProviderStatuses('));
  return vm.runInNewContext(source + "\nstrictLocalProviderStatuses('grok')", {
    state, settingsLocalDeviceLimitsProviders: () => identity.localDeviceLimitsProviders(state.stats, state.settings?.deviceId || '')
  });
}
test('automatic account wiring uses local device observations and excludes Hub aggregate-only identities', () => {
  const local = { provider: 'grok', accountKey: 'local-key', status: 'ok' };
  const remote = { provider: 'grok', accountKey: 'remote-key', sourceDeviceId: 'remote', status: 'ok' };
  const state = { mode: 'sync', settings: { deviceId: 'here', hubMode: 'client' },
    stats: { limits: { providers: [remote] }, devices: [{ deviceId: 'here', limits: { providers: [local] } }, { deviceId: 'remote', limits: { providers: [remote] } }] } };
  assert.deepEqual([...rows(state)], [local]);
  delete state.stats.devices;
  assert.equal(rows(state).length, 0);
  state.settings.hubMode = 'local';
  assert.equal(rows(state).length, 0, 'a pending mode switch cannot promote the previous Hub aggregate');
  state.mode = 'local';
  assert.equal(rows(state).length, 0, 'explicit remote provenance remains remote');
  state.stats.limits.providers = [local];
  assert.deepEqual([...rows(state)], [local], 'standalone snapshots without devices retain local observations');
});
test('unknown local device identity cannot adopt the only remote device', () => {
  const remote = { provider: 'grok', accountKey: 'remote-key', status: 'ok' };
  assert.equal(rows({ settings: {}, stats: { devices: [{ deviceId: 'remote', limits: { providers: [remote] } }] } }).length, 0);
});
