'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = path.resolve(__dirname, '../../src/electron/renderer');
const presentation = require('../../src/electron/renderer/limits/providerPresentation');
const policies = require('../../src/electron/renderer/limits/presentationPolicies');

for (const page of ['index.html', 'edgeDock/index.html']) {
  test(`${page} loads provider presentation owners before shared projection`, () => {
    const html = fs.readFileSync(path.join(renderer, page), 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    const context = vm.createContext({ window: { TokenMonitorWorkbuddyIdentity: { isWorkbuddyPlaceholder: () => false } } });
    let initialized = false;
    for (const script of scripts) {
      if (!/providers\/[^/]+\/presentation\.js$|limits\/providerPresentation\.js$/.test(script)) continue;
      if (script.endsWith('limits/providerPresentation.js')) {
        assert.deepEqual(Object.keys(context.window.TokenMonitorProviderPresentationPolicies).sort(), Object.keys(policies).sort());
        initialized = true;
      }
      vm.runInContext(fs.readFileSync(path.resolve(renderer, path.dirname(page), script), 'utf8'), context);
    }
    assert.equal(initialized, true);
    const browser = context.window.TokenMonitorLimitProviderPresentation;
    for (const row of [
      { provider: 'cline', source: 'api', status: 'unauthorized' },
      { provider: 'cline', source: 'oauth', status: 'unauthorized' },
      { provider: 'minimax', source: 'oauth', status: 'notConfigured' },
      { provider: 'workbuddy', actionRequired: 'appSessionEncrypted', status: 'unavailable' },
      { provider: 'antigravity', actionRequired: 'accountVerification', status: 'unauthorized' }
    ]) {
      assert.deepEqual(JSON.parse(JSON.stringify(browser.limitProviderStatusLabel(row))), presentation.limitProviderStatusLabel(row));
    }
    assert.equal(browser.limitProviderPlanDisplayLabel('zed', 'Zed Pro'), 'Pro');
    assert.equal(browser.limitProviderPlanDisplayLabel('zai', 'GLM Coding Max'), 'Max');
    assert.equal(browser.limitProviderSourceLabel({ provider: 'codex', source: 'rpc', sourceDetail: 'managed' }), 'Managed');
  });
}
